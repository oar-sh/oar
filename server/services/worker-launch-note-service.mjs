'use strict';

/**
 * The note in the conversation when a session's worker cannot be started.
 *
 * Until 2026-10-01 a session whose launches were exhausted showed a yellow
 * dot and nothing else: the message stayed queued, nothing said why, and
 * nothing tried again. The supervisor now retries for a while and tells this
 * service about the episode; the service keeps ONE relay-authored note per
 * episode in the conversation and updates it in place — exhausted, each
 * failed retry, stopped (with a Retry button in the client), started.
 *
 * The note is an assistant message of kind `worker-launch-failed`,
 * `worker-launch-stopped` or `worker-launch-started`; the queued message is
 * left queued throughout, so a launch that works delivers it.
 */

import { randomUUID } from 'node:crypto';

export const WORKER_LAUNCH_NOTE_KINDS = Object.freeze({
  failed: 'worker-launch-failed',
  stopped: 'worker-launch-stopped',
  started: 'worker-launch-started',
});

const CAUSE_MAX_CHARS = 160;

function clipCause(text) {
  const cause = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cause) return 'unknown';
  return cause.length > CAUSE_MAX_CHARS ? `${cause.slice(0, CAUSE_MAX_CHARS - 1)}…` : cause;
}

function defaultFormatTime(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return 'now';
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

function minutesOf(ms) {
  const minutes = Math.max(1, Math.round(Number(ms || 0) / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** The text of the note for an episode state; exported for the tests and the client copy. */
export function buildWorkerLaunchNoteText({ type, lifecycle = {}, retryEveryMs = 60_000, retryWindowMs = 10 * 60_000, formatTime = defaultFormatTime } = {}) {
  const tries = Math.max(0, Number(lifecycle?.retryCount || 0));
  const triesText = `${tries} ${tries === 1 ? 'try' : 'tries'}`;
  const cause = clipCause(lifecycle?.lastError);
  if (type === 'launched') {
    return `✅ The worker for this conversation started at ${formatTime(lifecycle?.launchAt || new Date().toISOString())}. The queued message is being delivered.`;
  }
  if (type === 'stopped') {
    return `⛔ The worker for this conversation could not be started; the relay stopped trying after ${minutesOf(retryWindowMs)} (${triesText}). Cause: ${cause}. Your message stays queued — press Retry once the cause is fixed.`;
  }
  const until = lifecycle?.exhaustedSince && retryWindowMs > 0
    ? ` until ${formatTime(new Date(Date.parse(lifecycle.exhaustedSince) + retryWindowMs).toISOString())}`
    : '';
  const last = type === 'retry-failed' && lifecycle?.lastFailureAt ? `, last at ${formatTime(lifecycle.lastFailureAt)}` : '';
  return `⚠️ The worker for this conversation could not be started (${triesText}${last}). Cause: ${cause}. Your message stays queued; the relay tries again every ${minutesOf(retryEveryMs)}${until}.`;
}

export function createWorkerLaunchNoteService({
  db,
  stmts,
  emit,
  resolveConversationId,
  retryEveryMs = 60_000,
  retryWindowMs = 10 * 60_000,
  now = () => Date.now(),
  formatTime = defaultFormatTime,
  logger = console,
} = {}) {
  if (!db || !stmts) throw new Error('createWorkerLaunchNoteService requires db and stmts');
  const updateNote = db.prepare('UPDATE messages SET text = ?, kind = ? WHERE id = ?');
  // One open episode per session: the note's id and where it is.
  const episodes = new Map();

  function kindFor(type) {
    if (type === 'launched') return WORKER_LAUNCH_NOTE_KINDS.started;
    if (type === 'stopped') return WORKER_LAUNCH_NOTE_KINDS.stopped;
    return WORKER_LAUNCH_NOTE_KINDS.failed;
  }

  function conversationFor(sdkSessionId) {
    try {
      return String(resolveConversationId?.(sdkSessionId) || '').trim() || null;
    } catch {
      return null;
    }
  }

  function messagePayload({ messageId, text, kind, timestamp }) {
    return { id: messageId, role: 'assistant', text, kind, model: null, mode: null, attachments: [], timestamp };
  }

  function open({ sdkSessionId, conversationId, type, lifecycle }) {
    const at = new Date(now()).toISOString();
    const messageId = randomUUID();
    const kind = kindFor(type);
    const text = buildWorkerLaunchNoteText({ type, lifecycle, retryEveryMs, retryWindowMs, formatTime });
    const write = db.transaction(() => {
      stmts.insertMsg.run(messageId, conversationId, 'assistant', text, null, null, null, at, null, null, null);
      stmts.setMessageKind?.run?.(kind, messageId);
      stmts.updateConvTime?.run?.(at, conversationId);
    });
    write();
    episodes.set(sdkSessionId, { messageId, conversationId, timestamp: at });
    try { emit('assistant_message', { conversationId, messageId, message: messagePayload({ messageId, text, kind, timestamp: at }) }); } catch {}
    try { logger.log?.(`[worker-launch] conv=${conversationId.slice(0, 8)} note opened (${type}): ${clipCause(lifecycle?.lastError)}`); } catch {}
  }

  function update(episode, sdkSessionId, { type, lifecycle }) {
    const kind = kindFor(type);
    const text = buildWorkerLaunchNoteText({ type, lifecycle, retryEveryMs, retryWindowMs, formatTime });
    updateNote.run(text, kind, episode.messageId);
    try {
      emit('message_updated', {
        conversationId: episode.conversationId,
        messageId: episode.messageId,
        message: messagePayload({ messageId: episode.messageId, text, kind, timestamp: episode.timestamp }),
      });
    } catch {}
    if (type === 'launched') {
      episodes.delete(sdkSessionId);
      try { logger.log?.(`[worker-launch] conv=${episode.conversationId.slice(0, 8)} worker started, note closed`); } catch {}
    }
  }

  /** The supervisor's onLaunchState listener. */
  function handle({ type, sdkSessionId, lifecycle = null } = {}) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid || !['exhausted', 'retry-failed', 'stopped', 'launched'].includes(type)) return false;
    const episode = episodes.get(sid) || null;
    if (episode) {
      update(episode, sid, { type, lifecycle });
      return true;
    }
    // A launch that works without an open note is the ordinary case.
    if (type === 'launched') return false;
    const conversationId = conversationFor(sid);
    if (!conversationId) return false;
    open({ sdkSessionId: sid, conversationId, type, lifecycle });
    return true;
  }

  return {
    handle,
    openEpisode: (sdkSessionId) => episodes.get(String(sdkSessionId || '').trim()) || null,
  };
}
