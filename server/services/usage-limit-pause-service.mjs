'use strict';

/**
 * Pause and resume at the Claude subscription's usage limit.
 *
 * A Claude turn the CLI refused at the limit is not failed. Its row ends with
 * a note, and the relay queues a follow-up message of its own that is held
 * until the window resets: a pending queue row with `next_attempt_at` at the
 * reset and `usage_limit_pause` set. The ordinary delivery sends it once it
 * matures, so the pause survives a relay restart with no timer to restore.
 *
 * A reset too far away to wait for unattended (a weekly window) holds the
 * follow-up until the user resumes it.
 *
 * The service also keeps the latest report of the limit the workers sent
 * (memory only), for the heads-up before the limit is reached.
 */

import { randomUUID } from 'node:crypto';

import {
  USAGE_LIMIT_CODE,
  USAGE_LIMIT_KIND,
  USAGE_LIMIT_RESUME_MARGIN_MS,
  normalizeRateLimitInfo,
  usageLimitResumesByItself,
  usageLimitWindowLabel,
} from '../../shared/claude-usage-limit.mjs';

export const USAGE_LIMIT_SOCKET_EVENT = 'usage_limit_pause';
export const USAGE_LIMIT_ACCOUNT_SOCKET_EVENT = 'claude_usage_limit';

// What the held follow-up says. It is a message of the relay's, shown in the
// transcript like one of the user's. It quotes what was refused: the refused
// prompt is in the CLI's transcript, but a bare "continue" did not make the
// model take it up again (captured 2026-09-28, Haiku 4.5).
export const USAGE_LIMIT_RESUME_LEAD = 'Automatic message from OAR: the work was paused at the Claude usage limit.';
const RESUME_CLOSE = 'Continue where you left off, and pick up again what the limit cut off, subagents and background tasks included.';
const RESUME_CONTINUATION = 'A turn you had opened yourself after a background task finished was refused at the limit: report what that task brought.';
const QUOTE_MAX_CHARS = 4000;
const QUOTE_MAX_PROMPTS = 5;

function quotePrompt(text) {
  const value = String(text || '').trim();
  const cut = value.length > QUOTE_MAX_CHARS ? `${value.slice(0, QUOTE_MAX_CHARS - 1)}…` : value;
  return cut.split(/\r?\n/).map((line) => `> ${line}`.trimEnd()).join('\n');
}

/**
 * The follow-up's text: what was refused, then what to do about it.
 * `prompts` are the user's refused messages in the order they were sent;
 * `continuation` says a turn of the CLI's own was refused, which has no
 * prompt to quote.
 */
export function buildUsageLimitResumePrompt({ prompts = [], continuation = false } = {}) {
  const quoted = (Array.isArray(prompts) ? prompts : [])
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .slice(-QUOTE_MAX_PROMPTS);
  const parts = [USAGE_LIMIT_RESUME_LEAD];
  if (quoted.length === 1) {
    parts.push(`This request was refused at the limit:\n\n${quotePrompt(quoted[0])}`);
  } else if (quoted.length > 1) {
    parts.push(`These requests were refused at the limit, in this order:\n\n${quoted.map(quotePrompt).join('\n\n')}`);
  }
  if (continuation) parts.push(RESUME_CONTINUATION);
  parts.push(RESUME_CLOSE);
  return parts.join(quoted.length || continuation ? '\n\n' : ' ');
}

// `next_attempt_at` of a follow-up that waits for the user.
const HELD_UNTIL_RESUMED = '9999-12-31T00:00:00.000Z';
// A reset further away than this is not a usage window's.
const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const MIN_WAIT_MS = 60 * 1000;
// A refusal that names no reset still ahead (the CLI can name the one that
// has just passed) is tried again after this long, this many times in a row;
// after that the follow-up waits for the user.
const BLIND_RETRY_MS = 5 * 60 * 1000;
const MAX_BLIND_RETRIES = 6;

const TERMINAL_CODES = new Set([USAGE_LIMIT_CODE, `claude-${USAGE_LIMIT_CODE}`, `claude.${USAGE_LIMIT_CODE}`, `relay.claude-${USAGE_LIMIT_CODE}`]);

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function defaultFormatResetTime(iso, { now = Date.now() } = {}) {
  const at = new Date(iso);
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(at);
  if (sameDay) return clock;
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(at);
  return `${day}, ${clock}`;
}

/** Whether a response's terminal error is the worker's usage-limit refusal. */
export function isUsageLimitTerminalError(terminalError) {
  if (!terminalError || typeof terminalError !== 'object') return false;
  if (String(terminalError.kind || '') === USAGE_LIMIT_KIND) return true;
  return TERMINAL_CODES.has(String(terminalError.stableCode || '').trim().toLowerCase())
    || TERMINAL_CODES.has(String(terminalError.code || '').trim().toLowerCase());
}

export function createUsageLimitPauseService({
  db,
  stmts,
  emit = () => {},
  onQueueChanged = () => {},
  now = () => Date.now(),
  formatResetTime = defaultFormatResetTime,
  logger = console,
} = {}) {
  if (!db) throw new Error('db is required');
  if (!stmts) throw new Error('stmts is required');

  const findPausedRowForConversation = db.prepare(`
    SELECT * FROM queue
    WHERE conversation_id = ? AND status = 'pending' AND usage_limit_pause IS NOT NULL
    ORDER BY timestamp ASC, rowid ASC LIMIT 1
  `);
  const listPausedRows = db.prepare(`
    SELECT * FROM queue
    WHERE status = 'pending' AND usage_limit_pause IS NOT NULL
    ORDER BY timestamp ASC, rowid ASC
  `);
  const setPause = db.prepare(`
    UPDATE queue SET next_attempt_at = ?, usage_limit_pause = ?
    WHERE id = ? AND status = 'pending'
  `);
  const moveFollowUp = db.prepare(`
    UPDATE queue SET timestamp = ? WHERE id = ? AND status = 'pending' AND usage_limit_pause IS NOT NULL
  `);
  const moveFollowUpMessage = db.prepare(`UPDATE messages SET timestamp = ? WHERE id = ? AND role = 'user'`);
  const setFollowUpText = db.prepare(`
    UPDATE queue SET text = ? WHERE id = ? AND status = 'pending' AND usage_limit_pause IS NOT NULL
  `);
  const setFollowUpMessageText = db.prepare(`UPDATE messages SET text = ? WHERE id = ? AND role = 'user'`);
  const deletePausedRow = db.prepare(`
    DELETE FROM queue WHERE id = ? AND status = 'pending' AND usage_limit_pause IS NOT NULL
  `);
  // Only ever the relay's own message: the kind is set by schedulePause alone.
  const deleteFollowUpMessage = db.prepare(`DELETE FROM messages WHERE id = ? AND role = 'user' AND kind = ?`);

  let account = null;

  function stateFromRow(row) {
    const pause = parseJson(row?.usage_limit_pause);
    if (!row || !pause) return null;
    // Sent already, or due: the ordinary delivery has it from here.
    const heldUntil = Date.parse(String(row.next_attempt_at || ''));
    if (!Number.isFinite(heldUntil) || heldUntil <= now()) return null;
    return {
      conversationId: String(row.conversation_id),
      messageId: String(row.id),
      rateLimitType: pause.rateLimitType || null,
      label: usageLimitWindowLabel(pause.rateLimitType),
      resetsAt: pause.resetsAt || null,
      resumeAt: pause.auto ? String(row.next_attempt_at) : null,
      auto: pause.auto === true,
      pausedAt: pause.pausedAt || null,
    };
  }

  function emitPause(conversationId, state) {
    try { emit(USAGE_LIMIT_SOCKET_EVENT, { conversationId, pause: state || null }); } catch {}
  }

  /**
   * Decide whether a refused turn is paused. Returns the plan, or null when
   * the response is to be handled as the terminal failure it says it is.
   */
  function planPause({ terminalError, conversationId, providerType, queueRow = null, partialText = '' } = {}) {
    if (!isUsageLimitTerminalError(terminalError)) return null;
    if (String(providerType || '').trim().toLowerCase() !== 'claude') return null;
    if (!String(conversationId || '').trim()) return null;
    const at = now();
    const rateLimitType = String(terminalError.rateLimitType || '').trim() || null;
    const label = usageLimitWindowLabel(rateLimitType);
    // What the turn had written before the refusal stays above the note.
    const written = String(partialText || '').trim();
    const withWritten = (note) => (written ? `${written}\n\n${note}` : note);
    const resetsAtMs = Date.parse(String(terminalError.resetsAt || ''));
    if (!Number.isFinite(resetsAtMs) || resetsAtMs <= at) {
      // Counted along the follow-ups: the refused row is one itself when the
      // turn before it was paused the same way.
      const retries = Number(parseJson(queueRow?.usage_limit_pause)?.retries || 0) + 1;
      const auto = retries <= MAX_BLIND_RETRIES;
      const resumeAt = new Date(at + BLIND_RETRY_MS).toISOString();
      return {
        conversationId: String(conversationId),
        rateLimitType,
        resetsAt: null,
        resumeAt: auto ? resumeAt : null,
        auto,
        retries,
        noteText: withWritten(auto
          ? `⏸ Paused: the Claude ${label} is reached. The turn carries on by itself at ${formatResetTime(resumeAt, { now: at })}.`
          : `⏸ Paused: the Claude ${label} is still reached. Resume the turn once it has reset.`),
      };
    }
    if (resetsAtMs - at > MAX_RESET_AHEAD_MS) return null;
    const resetsAt = new Date(resetsAtMs).toISOString();
    const auto = usageLimitResumesByItself(resetsAt, { now: at });
    const resumeAtMs = Math.max(resetsAtMs + USAGE_LIMIT_RESUME_MARGIN_MS, at + MIN_WAIT_MS);
    const when = formatResetTime(auto ? new Date(resumeAtMs).toISOString() : resetsAt, { now: at });
    return {
      conversationId: String(conversationId),
      rateLimitType,
      resetsAt,
      resumeAt: auto ? new Date(resumeAtMs).toISOString() : null,
      auto,
      retries: 0,
      noteText: withWritten(auto
        ? `⏸ Paused: the Claude ${label} is reached. The turn carries on by itself at ${when}.`
        : `⏸ Paused: the Claude ${label} is reached and resets ${when}. Resume the turn once it has.`),
    };
  }

  /**
   * Queue the held follow-up for a paused turn, once the refused row's note
   * is saved. A conversation holds one: a second refusal before the reset
   * moves the one that is there.
   */
  function schedulePause(plan, { queueRow = null } = {}) {
    if (!plan?.conversationId) return null;
    const at = new Date(now()).toISOString();
    const heldUntil = plan.auto ? plan.resumeAt : HELD_UNTIL_RESUMED;
    // What this refusal cut off. A refused follow-up stands for what it
    // quoted; a turn of the CLI's own has no prompt.
    const refusedFollowUp = parseJson(queueRow?.usage_limit_pause);
    const cutOff = refusedFollowUp
      ? { prompts: Array.isArray(refusedFollowUp.prompts) ? refusedFollowUp.prompts : [], continuation: refusedFollowUp.continuation === true }
      : (String(queueRow?.kind || '') === 'continuation'
        ? { prompts: [], continuation: true }
        : { prompts: [String(queueRow?.text || '').trim()].filter(Boolean), continuation: false });
    const pauseFor = (held) => {
      const before = parseJson(held?.usage_limit_pause) || {};
      const prompts = [...(Array.isArray(before.prompts) ? before.prompts : []), ...cutOff.prompts]
        .map((text) => String(text || '').slice(0, QUOTE_MAX_CHARS))
        .slice(-QUOTE_MAX_PROMPTS);
      return {
        rateLimitType: plan.rateLimitType,
        resetsAt: plan.resetsAt,
        auto: plan.auto,
        retries: Number(plan.retries || 0),
        pausedAt: at,
        refusedMessageId: queueRow?.id ? String(queueRow.id) : null,
        prompts,
        continuation: before.continuation === true || cutOff.continuation,
      };
    };
    let created = null;
    const write = db.transaction(() => {
      const existing = findPausedRowForConversation.get(plan.conversationId);
      if (existing) {
        const pause = pauseFor(existing);
        const text = buildUsageLimitResumePrompt(pause);
        setPause.run(heldUntil, JSON.stringify(pause), existing.id);
        setFollowUpText.run(text, existing.id);
        setFollowUpMessageText.run(text, existing.id);
        // The follow-up comes after what was refused last, in the queue and
        // in the transcript. Left at the time of the first refusal it was
        // sent, and answered, above the messages the user wrote during the
        // pause, where nobody looks for the answer.
        moveFollowUp.run(at, existing.id);
        moveFollowUpMessage.run(at, existing.id);
        return String(existing.id);
      }
      const messageId = randomUUID();
      const pause = pauseFor(null);
      const pauseJson = JSON.stringify(pause);
      const resumePrompt = buildUsageLimitResumePrompt(pause);
      const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(plan.conversationId) || null;
      const latestModel = stmts.getLatestConversationModel?.get?.(plan.conversationId)?.model || null;
      const model = String(queueRow?.model || '').trim() || latestModel || null;
      const modelVariant = String(queueRow?.model_variant_id || '').trim() || latestModel || model;
      const relayMode = String(queueRow?.relay_mode || '').trim() || 'agent';
      const owner = String(queueRow?.owner_sdk_session_id || '').trim() || null;
      stmts.insertMsg.run(
        messageId,
        plan.conversationId,
        'user',
        resumePrompt,
        modelVariant,
        relayMode,
        null,
        at,
        modelVariant || null,
        null,
        String(modelVariant || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual',
      );
      stmts.setMessageKind?.run?.(USAGE_LIMIT_KIND, messageId);
      stmts.updateConvTime?.run?.(at, plan.conversationId);
      const queueArgs = [
        messageId,
        plan.conversationId,
        queueRow?.runtime_session_id || runtimeSession?.id || null,
        0,
        model,
        modelVariant,
        String(queueRow?.reasoning_effort || '').trim() || null,
        String(queueRow?.context_tier || '').trim() || null,
        relayMode,
        resumePrompt,
        null,
        at,
        owner,
        owner ? at : null,
        null,
        null,
      ];
      // The insert takes an image operation id where the queue has the column.
      if (stmts.insertQ.source?.includes('image_operation_id')) queueArgs.push(null);
      stmts.insertQ.run(...queueArgs);
      setPause.run(heldUntil, pauseJson, messageId);
      created = { messageId, model: modelVariant, relayMode, timestamp: at, text: resumePrompt };
      return messageId;
    });
    const messageId = write();
    if (created) {
      try {
        emit('user_message', {
          conversationId: plan.conversationId,
          messageId: created.messageId,
          senderClientId: null,
          message: {
            role: 'user',
            text: created.text,
            model: created.model,
            modelOrigin: String(created.model || '').trim().toLowerCase() === 'auto' ? 'auto' : 'manual',
            mode: created.relayMode,
            attachments: [],
            timestamp: created.timestamp,
            kind: USAGE_LIMIT_KIND,
          },
        });
      } catch {}
    }
    const state = getPause(plan.conversationId);
    try { logger.log?.(`[usage-limit] conv=${plan.conversationId.slice(0, 8)} paused at the ${usageLimitWindowLabel(plan.rateLimitType)}; ${plan.auto ? `resumes ${plan.resumeAt}` : `resets ${plan.resetsAt}, waits for the user`}`); } catch {}
    emitPause(plan.conversationId, state);
    return { messageId, created: Boolean(created), state };
  }

  function getPause(conversationId) {
    const id = String(conversationId || '').trim();
    if (!id) return null;
    return stateFromRow(findPausedRowForConversation.get(id));
  }

  function listPauses() {
    return listPausedRows.all().map(stateFromRow).filter(Boolean);
  }

  /** Send the held follow-up now, whatever the reset. */
  function resumeNow({ conversationId } = {}) {
    const id = String(conversationId || '').trim();
    const row = id ? findPausedRowForConversation.get(id) : null;
    if (!row || !stateFromRow(row)) return { resumed: false, state: null };
    const pause = parseJson(row.usage_limit_pause) || {};
    const at = new Date(now()).toISOString();
    setPause.run(null, JSON.stringify({ ...pause, resumedAt: at, resumedBy: 'user' }), row.id);
    try { logger.log?.(`[usage-limit] conv=${id.slice(0, 8)} resumed by the user`); } catch {}
    emitPause(id, null);
    try { emit('message_status', { messageId: String(row.id), conversationId: id, status: 'pending' }); } catch {}
    try { onQueueChanged('usage-limit-resume'); } catch {}
    return { resumed: true, messageId: String(row.id), state: null };
  }

  /** Drop the held follow-up: the paused turn is not carried on. */
  function cancel({ conversationId } = {}) {
    const id = String(conversationId || '').trim();
    const row = id ? findPausedRowForConversation.get(id) : null;
    if (!row) return { cancelled: false, state: null };
    // The message goes with the row. It is the relay's own and was never
    // sent: left in the transcript it would read as a request of the user's
    // that nobody answered.
    const drop = db.transaction(() => {
      const result = deletePausedRow.run(row.id);
      if (result.changes) deleteFollowUpMessage.run(row.id, USAGE_LIMIT_KIND);
      return result.changes;
    });
    if (!drop()) return { cancelled: false, state: getPause(id) };
    try { logger.log?.(`[usage-limit] conv=${id.slice(0, 8)} pause cancelled by the user`); } catch {}
    emitPause(id, null);
    try { emit('message_status', { messageId: String(row.id), conversationId: id, status: 'cancelled' }); } catch {}
    return { cancelled: true, messageId: String(row.id), state: null };
  }

  function accountState() {
    if (!account) return null;
    const resetsAtMs = Date.parse(account.resetsAt || '');
    // A report is about one window; past its reset it says nothing.
    if (Number.isFinite(resetsAtMs) && resetsAtMs <= now()) {
      account = null;
      return null;
    }
    return { ...account };
  }

  /** The latest report a worker sent; returns what the clients are told. */
  function recordReport({ report } = {}) {
    const raw = report && typeof report === 'object' ? report : null;
    // Workers send the normalized shape; a raw `rate_limit_info` is taken too.
    const status = String(raw?.status || '').trim();
    const info = raw && (raw.observedAt || Array.isArray(raw.windows))
      ? raw
      : normalizeRateLimitInfo(raw, { now: now() });
    if (!info || !['allowed', 'allowed_warning', 'rejected'].includes(status)) return accountState();
    const utilization = Number(info.utilization);
    account = {
      status,
      rateLimitType: String(info.rateLimitType || '').trim() || null,
      label: usageLimitWindowLabel(info.rateLimitType),
      utilization: Number.isFinite(utilization) ? Math.max(0, Math.min(1, utilization)) : null,
      resetsAt: Number.isFinite(Date.parse(info.resetsAt || '')) ? new Date(Date.parse(info.resetsAt)).toISOString() : null,
      isUsingOverage: info.isUsingOverage === true,
      observedAt: new Date(now()).toISOString(),
    };
    const state = accountState();
    try { emit(USAGE_LIMIT_ACCOUNT_SOCKET_EVENT, state); } catch {}
    return state;
  }

  return {
    planPause,
    schedulePause,
    getPause,
    listPauses,
    resumeNow,
    cancel,
    recordReport,
    getAccountState: accountState,
  };
}
