/**
 * Posts that must not be lost to a relay that is away for a moment: a post
 * that fails is kept and sent again once the relay answers (the worker's
 * heartbeat calls `flush`). Bounded both ways, the newest `max` posts for
 * `ttlMs`, because what they report is only worth telling for a while and a
 * relay that stays away must not grow the worker.
 *
 * A post the relay refused (a 4xx answer) is not kept: sending it again
 * would be refused again.
 */
export const KEPT_POSTS_MAX = 20;
export const KEPT_POSTS_TTL_MS = 10 * 60_000;
// A post that gets no answer is given up after this long and kept: fetch
// alone waits five minutes, and the heartbeat's resync waits for the flush.
export const KEPT_POSTS_TIMEOUT_MS = 10_000;

export function createKeptPosts({
  api,
  max = KEPT_POSTS_MAX,
  ttlMs = KEPT_POSTS_TTL_MS,
  timeoutMs = KEPT_POSTS_TIMEOUT_MS,
  now = () => Date.now(),
  dbg = () => {},
} = {}) {
  let kept = [];
  let flushing = null;

  function worthKeeping(error) {
    const status = Number(error?.status);
    return !(status >= 400 && status < 500);
  }

  function send(routePath, body) {
    return api("POST", routePath, body, timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {});
  }

  function keep(entry) {
    kept.push(entry);
    if (kept.length > max) kept = kept.slice(-max);
  }

  /** Post now; on a failure keep it for `flush`. Never rejects. */
  async function post(routePath, body) {
    try {
      await send(routePath, body);
      return true;
    } catch (error) {
      dbg("post failed", routePath, error?.message || String(error));
      if (worthKeeping(error)) keep({ routePath, body, at: now() });
      return false;
    }
  }

  /** Send the kept posts again, oldest first; what fails again stays. */
  function flush() {
    if (flushing) return flushing;
    if (!kept.length) return Promise.resolve(0);
    flushing = (async () => {
      const pending = kept;
      kept = [];
      let sent = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const entry = pending[index];
        if (now() - entry.at > ttlMs) continue;
        try {
          await send(entry.routePath, entry.body);
          sent += 1;
        } catch (error) {
          dbg("kept post failed again", entry.routePath, error?.message || String(error));
          if (!worthKeeping(error)) continue;
          // The relay is still away: the rest waits too, in order, ahead of
          // whatever was kept meanwhile.
          kept = [...pending.slice(index).filter((later) => now() - later.at <= ttlMs), ...kept].slice(-max);
          break;
        }
      }
      return sent;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  return { post, flush, size: () => kept.length };
}
