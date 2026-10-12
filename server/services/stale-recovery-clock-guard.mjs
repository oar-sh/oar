'use strict';

// Stale recovery after a wall-clock jump. The stale window is measured from
// the worker's last heartbeat: after the host slept for hours, every
// heartbeat is hours old the moment the relay's timer fires again, and the
// recovery requeued live turns (live: three messages recovered after a 6 h
// sleep, delivered a second time, and the live worker's replies refused as
// stale attempts, 696 warnings in 4 minutes).
//
// The guard notices the jump itself: the gap between two ticks of the
// recovery timer far larger than its interval (a sleep, a stopped VM, a
// blocked event loop, which stalls heartbeats just the same). After one, no
// recovery runs for a grace period, long enough for a live worker to
// heartbeat again; a dead worker's rows are recovered after it.

export const CLOCK_JUMP_FACTOR = 4;

/**
 * `intervalMs` is the recovery timer's interval; a gap above
 * `jumpThresholdMs` (default: four intervals) is a jump; `graceMs` is how
 * long recovery then waits. `now()` is injectable for tests.
 */
export function createStaleRecoveryClockGuard({
  now = () => Date.now(),
  intervalMs,
  jumpThresholdMs = null,
  graceMs,
  log = () => {},
} = {}) {
  const interval = Math.max(1, Number(intervalMs) || 1);
  const threshold = Number(jumpThresholdMs) > 0 ? Number(jumpThresholdMs) : interval * CLOCK_JUMP_FACTOR;
  const grace = Math.max(0, Number(graceMs) || 0);
  let lastTickMs = null;
  let graceUntilMs = 0;
  let inGrace = false;

  /**
   * One tick of the recovery timer. `{ skip, jumped, gapMs,
   * graceRemainingMs }`: `skip` says recovery must not run now.
   */
  function tick() {
    const at = now();
    const gapMs = lastTickMs === null ? 0 : Math.max(0, at - lastTickMs);
    lastTickMs = at;
    const jumped = gapMs > threshold;
    if (jumped) {
      graceUntilMs = Math.max(graceUntilMs, at + grace);
      log(`Clock jump: ${Math.round(gapMs / 1000)}s passed between stale-recovery ticks (interval ${Math.round(interval / 1000)}s); stale recovery paused for ${Math.round(grace / 1000)}s so live workers can report`);
    }
    const skip = at < graceUntilMs;
    if (inGrace && !skip) log('Stale recovery resumed after the clock jump');
    inGrace = skip;
    return { skip, jumped, gapMs, graceRemainingMs: Math.max(0, graceUntilMs - at) };
  }

  return { tick, thresholdMs: threshold, graceMs: grace };
}
