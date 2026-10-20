'use strict';

/**
 * "After a relay restart, tell interrupted sessions to carry on" (opt-in,
 * per relay, off by default).
 *
 * Session workers outlive the relay's runtime, and a turn whose worker lived
 * through the restart simply goes on. A turn whose worker did not (it died
 * with the relay, or came back without the turn) is dealt with by the
 * recovery paths, and most of them requeue it: the row runs again by itself,
 * and nothing more is needed. A few cannot run again, because the prompt
 * already reached the agent and a second delivery would run it twice:
 *
 *  - a background continuation (a turn the agent opened itself), torn down;
 *  - a steer the CLI had already taken (`consumed_at`), failed;
 *  - a turn that had started (activity, a stream) when its live worker no
 *    longer claimed it, failed instead of replayed (`turn-replay-blocked`).
 *
 * The agent never hears that its turn stopped. With the setting on, such a
 * session gets ONE note of the relay's in the conversation once its rows are
 * settled: the relay restarted, the turn was interrupted, check what you
 * were doing and carry on. The user's message is never sent again.
 *
 * Which turns count: the rows that were `processing` when this runtime
 * started (`captureBoot`), followed through the recovery paths
 * (`noteOutcome`). A row its worker claims after the start (a heartbeat
 * that lists it: the worker lived through the restart and has the turn) is
 * the restart's no more: whatever ends it later is not put down to it.
 * A conversation gets a note when one of its rows was cut off and none was
 * requeued (that one runs again: a note would double the work), claimed by
 * a worker that lived through the restart, or failed for another reason.
 * Nothing for idle sessions, nothing when
 * the setting is off when the note would be sent, nothing for an archived or
 * deleted conversation, nothing while a usage-limit follow-up is held (it
 * carries the turn on itself), at most one note per conversation and
 * runtime. The note is an ordinary pending row, queued behind whatever the
 * user has queued already, so it never jumps ahead of a user message; its
 * delivery starts the session's worker as for any message.
 */

import { randomUUID } from 'node:crypto';

export const RESTART_RESUME_SETTING_KEY = 'restart_resume_notes';
export const RESTART_RESUME_KIND = 'relay-restart-resume';
export const RESTART_RESUME_LEAD = 'Automatic message from OAR, not from the user:';

// How long after the start a cut-off turn is still put down to the restart.
const DEFAULT_WINDOW_MS = 30 * 60_000;

/** The stored value as on or off; off unless it was switched on. */
export function readRestartResumeSetting(raw) {
  return ['1', 'true', 'on'].includes(String(raw ?? '').trim().toLowerCase());
}

export function parseRestartResumeUpdate(value) {
  if (typeof value !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  return { ok: true, enabled: value };
}

function defaultFormatTime(ms) {
  const at = new Date(Number(ms));
  if (!Number.isFinite(at.getTime())) return 'just now';
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The note's text. */
export function buildRestartResumeNoteText({ restartedAt, formatTime = defaultFormatTime } = {}) {
  return `${RESTART_RESUME_LEAD} the relay restarted at ${formatTime(restartedAt)}, and the turn you were working on was interrupted before it finished. `
    + 'Check where you were (the files you changed, the commands and background tasks you started) and carry on from there. '
    + 'Do not repeat steps that already completed; if the work was already done, say so briefly.';
}

const OUTCOMES = new Set(['cut', 'requeued', 'failed', 'claimed']);

function text(value) {
  return String(value ?? '').trim();
}

export function createRestartResumeService({
  db,
  stmts,
  isEnabled = () => false,
  emit = () => {},
  wake = () => {},
  now = () => Date.now(),
  bootAt = now(),
  windowMs = DEFAULT_WINDOW_MS,
  formatTime = defaultFormatTime,
  logger = console,
} = {}) {
  if (!db || !stmts) throw new Error('createRestartResumeService requires db and stmts');
  const listProcessing = db.prepare(`
    SELECT id, conversation_id, model, model_variant_id, reasoning_effort, context_tier, relay_mode,
           owner_sdk_session_id, runtime_session_id
    FROM queue WHERE status = 'processing'
  `);
  const statusOf = db.prepare(`SELECT status FROM queue WHERE id = ?`);
  let heldPause = null;
  try {
    // A held usage-limit follow-up (usage-limit-pause-service.mjs).
    heldPause = db.prepare(`
      SELECT 1 FROM queue
      WHERE conversation_id = ? AND status = 'pending' AND usage_limit_pause IS NOT NULL
      LIMIT 1
    `);
  } catch {}

  // queue id → conversation id, for the rows processing at the start.
  const watched = new Map();
  // conversation id → { rows: Map(queue id → { row, outcome }) }
  const conversations = new Map();
  // Conversations that had their note in this runtime.
  const noted = new Set();

  function log(line) {
    try { logger?.log?.(`[restart-resume] ${line}`); } catch {}
  }

  function expired() {
    return now() - bootAt > windowMs;
  }

  /** The rows processing when this runtime started; returns how many. */
  function captureBoot() {
    let rows = [];
    try { rows = listProcessing.all(); } catch {}
    for (const row of rows) {
      const conversationId = text(row.conversation_id);
      const id = text(row.id);
      if (!conversationId || !id) continue;
      watched.set(id, conversationId);
      let entry = conversations.get(conversationId);
      if (!entry) conversations.set(conversationId, entry = { rows: new Map() });
      entry.rows.set(id, { row, outcome: null });
    }
    if (rows.length) log(`${rows.length} turn(s) were running when the relay started; following them`);
    return rows.length;
  }

  /**
   * What a recovery path did with a row: `cut` (it cannot run again),
   * `requeued` (it runs again by itself) or `failed` (ended for another
   * reason); or `claimed`: its worker, alive after the restart, holds it.
   * Only the rows of the start count, and only their first outcome.
   */
  function noteOutcome(row, outcome) {
    const id = text(row?.id ?? row);
    const conversationId = watched.get(id);
    if (!conversationId || !OUTCOMES.has(outcome)) return false;
    watched.delete(id);
    const entry = conversations.get(conversationId)?.rows.get(id);
    if (entry && !entry.outcome) entry.outcome = outcome;
    settle(conversationId);
    return true;
  }

  // Decides a conversation once none of its rows of the start is processing.
  function settle(conversationId) {
    const entry = conversations.get(conversationId);
    if (!entry) return;
    for (const [id, item] of entry.rows) {
      if (item.outcome) continue;
      let status = '';
      try { status = text(statusOf.get(id)?.status).toLowerCase(); } catch {}
      if (status === 'processing') return;
      // Back in the queue by a path that did not say so: it runs again.
      item.outcome = status === 'pending' || status === 'parked' ? 'requeued' : 'settled';
      watched.delete(id);
    }
    conversations.delete(conversationId);
    const outcomes = [...entry.rows.values()].map((item) => item.outcome);
    if (!outcomes.includes('cut')) return;
    if (outcomes.includes('requeued')) {
      log(`conv=${conversationId.slice(0, 8)} no note: the interrupted turn runs again by itself`);
      return;
    }
    if (outcomes.includes('claimed')) {
      log(`conv=${conversationId.slice(0, 8)} no note: its worker lived through the restart and has its turn`);
      return;
    }
    if (outcomes.includes('failed')) {
      log(`conv=${conversationId.slice(0, 8)} no note: the turn failed, the failure says what to do`);
      return;
    }
    const cut = [...entry.rows.values()].find((item) => item.outcome === 'cut')?.row || null;
    sendNote(conversationId, cut);
  }

  function skip(conversationId, why) {
    log(`conv=${conversationId.slice(0, 8)} no note: ${why}`);
    return null;
  }

  function sendNote(conversationId, cutRow) {
    if (noted.has(conversationId)) return skip(conversationId, 'it had one after this restart');
    let enabled = false;
    try { enabled = isEnabled() === true; } catch {}
    if (!enabled) return skip(conversationId, 'the setting is off');
    const conversation = stmts.getConvAnyStatus?.get?.(conversationId) || null;
    if (!conversation || text(conversation.status) === 'deleted') return skip(conversationId, 'the conversation is gone');
    if (Number(conversation.archived) === 1) return skip(conversationId, 'the conversation is archived');
    try {
      if (heldPause?.get(conversationId)) return skip(conversationId, 'a usage-limit follow-up carries the turn on');
    } catch {}
    noted.add(conversationId);

    const at = new Date(now()).toISOString();
    const messageId = randomUUID();
    const noteText = buildRestartResumeNoteText({ restartedAt: bootAt, formatTime });
    const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
    const latestModel = stmts.getLatestConversationModel?.get?.(conversationId)?.model || null;
    // The model and mode the interrupted turn ran with.
    const model = text(cutRow?.model) || text(latestModel) || text(runtimeSession?.provider_model) || text(runtimeSession?.model) || null;
    const modelVariant = text(cutRow?.model_variant_id) || model;
    const relayMode = text(cutRow?.relay_mode) || 'agent';
    const owner = text(cutRow?.owner_sdk_session_id) || text(runtimeSession?.sdk_session_id) || null;
    const write = db.transaction(() => {
      stmts.insertMsg.run(
        messageId,
        conversationId,
        'user',
        noteText,
        modelVariant || null,
        relayMode,
        null,
        at,
        modelVariant || null,
        null,
        text(modelVariant).toLowerCase() === 'auto' ? 'auto' : 'manual',
      );
      stmts.setMessageKind?.run?.(RESTART_RESUME_KIND, messageId);
      stmts.updateConvTime?.run?.(at, conversationId);
      const queueArgs = [
        messageId,
        conversationId,
        text(cutRow?.runtime_session_id) || runtimeSession?.id || null,
        0,
        model,
        modelVariant || null,
        text(cutRow?.reasoning_effort) || null,
        text(cutRow?.context_tier) || null,
        relayMode,
        noteText,
        null,
        at,
        owner,
        owner ? at : null,
        null,
        null,
      ];
      if (stmts.queueHasImageOperationId || stmts.insertQ?.source?.includes?.('image_operation_id')) queueArgs.push(null);
      stmts.insertQ.run(...queueArgs);
    });
    try {
      write();
    } catch (error) {
      noted.delete(conversationId);
      try { logger?.warn?.(`[restart-resume] conv=${conversationId.slice(0, 8)} note not queued: ${error?.message || error}`); } catch {}
      return null;
    }
    try {
      emit('user_message', {
        conversationId,
        messageId,
        senderClientId: null,
        message: {
          role: 'user',
          text: noteText,
          model: modelVariant || null,
          mode: relayMode,
          attachments: [],
          timestamp: at,
          kind: RESTART_RESUME_KIND,
        },
      });
    } catch {}
    try { emit('message_status', { messageId, conversationId, status: 'pending' }); } catch {}
    try { wake({ conversationId, ownerSessionId: owner, messageId }); } catch {}
    log(`conv=${conversationId.slice(0, 8)} note queued: its turn was cut off by the restart`);
    return messageId;
  }

  /** Decides the conversations whose rows settled on their own; ends the watch after the window. */
  function tick() {
    if (!conversations.size) return;
    if (expired()) {
      watched.clear();
      conversations.clear();
      return;
    }
    for (const conversationId of [...conversations.keys()]) settle(conversationId);
  }

  return {
    captureBoot,
    noteOutcome,
    tick,
    /** What is still followed, for tests and diagnostics. */
    pending() {
      return [...conversations.keys()];
    },
  };
}
