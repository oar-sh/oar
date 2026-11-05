'use strict';

// Timers a relay keeps only while there is something to time: the CLI
// presence deadline and the intervals armed by work and disarmed by their own
// tick. An idle relay runs neither.

// ─── CLI presence ──────────────────────────────────────────────────────────────

// Whether "the CLI" (the relay's workers) has been heard from recently, kept
// without a polling timer. Every touch moves the last-seen time; one one-shot
// deadline timer, armed only while something was seen, notices when the
// window ran out. A deadline that fires early (a touch moved last-seen) arms
// again for the remainder, so an online relay wakes about once per window and
// an offline one not at all.
//
// The window depends on the worker sockets: an idle worker beats only every
// 30 s (shared/worker-runtime/worker-keepalive.mjs), so while a worker socket
// is open the window is wide enough for one lost beat. With no socket left a
// relay whose workers are all gone still reads offline within the short
// window, as before.

export const CLI_ONLINE_WINDOW_MS = 10_000;
export const CLI_ONLINE_WINDOW_WITH_WORKER_SOCKETS_MS = 45_000;

export function createCliPresence({
  windowMs = CLI_ONLINE_WINDOW_MS,
  socketWindowMs = CLI_ONLINE_WINDOW_WITH_WORKER_SOCKETS_MS,
  // Called once when the window ran out after a touch (the deadline timer, or
  // the last worker socket closing). The presence is cleared before the call.
  onExpired = () => {},
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let lastSeenMs = null;
  let workerSocketCount = 0;
  let deadlineTimer = null;

  function currentWindowMs() {
    return workerSocketCount > 0 ? socketWindowMs : windowMs;
  }

  function remainingMs() {
    if (lastSeenMs === null) return 0;
    return lastSeenMs + currentWindowMs() - now();
  }

  function disarm() {
    if (!deadlineTimer) return;
    clearTimeoutImpl(deadlineTimer);
    deadlineTimer = null;
  }

  function arm(delayMs) {
    disarm();
    deadlineTimer = setTimeoutImpl(onDeadline, Math.max(1, delayMs));
    deadlineTimer?.unref?.();
  }

  function expire() {
    disarm();
    lastSeenMs = null;
    try { onExpired(); } catch {}
  }

  function onDeadline() {
    deadlineTimer = null;
    if (lastSeenMs === null) return;
    const left = remainingMs();
    if (left > 0) {
      arm(left);
      return;
    }
    expire();
  }

  function touch() {
    lastSeenMs = now();
    // An armed deadline is left alone: when it fires it finds the newer
    // touch and arms again for what is left.
    if (!deadlineTimer) arm(currentWindowMs());
  }

  /** The worker socket count changed: the window may have shrunk. */
  function noteWorkerSocketCount(count) {
    workerSocketCount = Math.max(0, Number(count) || 0);
    if (lastSeenMs === null) return;
    const left = remainingMs();
    if (left <= 0) {
      expire();
      return;
    }
    arm(left);
  }

  /** Forget the last touch without calling onExpired (an explicit offline). */
  function clear() {
    disarm();
    lastSeenMs = null;
  }

  function isFresh() {
    return remainingMs() > 0;
  }

  return {
    touch,
    clear,
    isFresh,
    noteWorkerSocketCount,
    status: () => ({
      lastSeenMs,
      workerSocketCount,
      windowMs: currentWindowMs(),
      armed: deadlineTimer !== null,
    }),
  };
}

// ─── Armable interval ──────────────────────────────────────────────────────────

// An interval that runs only while there is something for it to do: armed by
// whoever creates that work (a share viewer arriving, a pending row waiting
// for its worker), disarmed by its own tick once the work is gone. An idle
// relay then has no such timer at all. The timer is unref'd, and stop() (the
// runtime's shutdown) disarms it for good.

export function createArmableInterval({
  intervalMs,
  // One tick. Returns (or resolves to) `false` to disarm: nothing is left to
  // do. Anything else keeps the interval running. An arm that lands while a
  // tick is still running (the tick awaits) keeps the interval running even
  // if that tick returns false: the work it was armed for may be newer than
  // what the tick looked at.
  tick,
  onError = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  if (typeof tick !== 'function') throw new Error('createArmableInterval requires tick');
  const periodMs = Math.max(1, Number(intervalMs) || 1);
  let timer = null;
  let stopped = false;
  let generation = 0;

  function disarm() {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  async function runTick() {
    const armedAt = generation;
    let keep;
    try {
      keep = await tick();
    } catch (error) {
      try { onError(error); } catch {}
      return;
    }
    if (keep === false && generation === armedAt) disarm();
  }

  function arm() {
    if (stopped) return false;
    generation += 1;
    if (timer) return false;
    timer = setIntervalImpl(() => { void runTick(); }, periodMs);
    timer?.unref?.();
    return true;
  }

  function stop() {
    stopped = true;
    disarm();
  }

  return {
    arm,
    disarm,
    stop,
    isArmed: () => timer !== null,
  };
}
