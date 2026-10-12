'use strict';

// One STALE ATTEMPT warning per superseded attempt, not one per write. A
// worker whose turn was requeued under it keeps streaming for the old
// attempt until it learns of the refusal, several writes a second (live:
// 696 lines in four minutes after one recovery). The first refusal of an
// attempt is logged in full; the rest are counted and summarized in one
// line once the attempt has been quiet for `quietMs`.

export const STALE_ATTEMPT_SUMMARY_QUIET_MS = 60_000;
const MAX_TRACKED_ATTEMPTS = 500;

function short(value) {
  return String(value || '').trim().slice(0, 8) || 'none';
}

/**
 * `warn(line)` writes one line (without timestamp). `now`, `setTimer` and
 * `clearTimer` are injectable for tests.
 */
export function createStaleAttemptLogLimiter({
  warn = (line) => console.warn(line),
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  quietMs = STALE_ATTEMPT_SUMMARY_QUIET_MS,
  maxTracked = MAX_TRACKED_ATTEMPTS,
} = {}) {
  // `${messageId}:${attemptId}` → { messageId, attemptId, count, firstAt, lastAt, routes, current, status, timer }
  const entries = new Map();

  function summarize(key) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    if (entry.timer) clearTimer(entry.timer);
    const more = entry.count - 1;
    if (more <= 0) return;
    const seconds = Math.max(1, Math.round((entry.lastAt - entry.firstAt) / 1000));
    warn(`STALE ATTEMPT ${short(entry.messageId)} attempt=${short(entry.attemptId)}: ${more} more write${more === 1 ? '' : 's'} refused over ${seconds}s (routes ${[...entry.routes].join(',')}; current=${short(entry.current)} status=${entry.status || 'unknown'})`);
  }

  function arm(key, entry) {
    if (entry.timer) clearTimer(entry.timer);
    entry.timer = setTimer(() => {
      entry.timer = null;
      summarize(key);
    }, quietMs);
  }

  /**
   * A write of `attemptId` for `messageId` was refused because the row's
   * attempt is `currentAttemptId`. Returns `{ logged, count }`.
   */
  function note({ messageId, attemptId, currentAttemptId = '', route = 'unknown', status = '' } = {}) {
    const key = `${String(messageId || '')}:${String(attemptId || '')}`;
    const at = now();
    const existing = entries.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = at;
      existing.routes.add(String(route || 'unknown'));
      existing.current = currentAttemptId;
      existing.status = String(status || existing.status || '');
      arm(key, existing);
      return { logged: false, count: existing.count };
    }
    if (entries.size >= maxTracked) summarize(entries.keys().next().value);
    const entry = {
      messageId,
      attemptId,
      count: 1,
      firstAt: at,
      lastAt: at,
      routes: new Set([String(route || 'unknown')]),
      current: currentAttemptId,
      status: String(status || ''),
      timer: null,
    };
    entries.set(key, entry);
    arm(key, entry);
    warn(`STALE ATTEMPT ${short(messageId)} route=${route} claimed=${short(attemptId)} current=${short(currentAttemptId)} status=${status || 'unknown'} (further writes of this attempt are counted and summarized once it goes quiet)`);
    return { logged: true, count: 1 };
  }

  /** Writes every pending summary now (shutdown, tests). */
  function flush() {
    for (const key of [...entries.keys()]) summarize(key);
  }

  return { note, flush, size: () => entries.size };
}
