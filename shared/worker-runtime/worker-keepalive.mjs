// The worker's one keepalive timer. Each beat posts the heartbeat
// (heartbeat.mjs) and refreshes the websocket readiness
// (worker-websocket-link.mjs, built with readyRefreshMs: 0); before, each ran
// its own 10 s timer.
//
// Cadence: every 10 s while the worker has work (a row it owns, a delivery in
// flight, a hold, a background task, a running turn), and every 30 s while it
// is idle, but only on a relay that advertised `idle-keepalive` in its
// server.hello. An older relay expects a beat every 10 s (its liveness, CLI
// and stranded-session windows), and a worker whose socket is down knows no
// relay at all, so both get 10 s. Every server.hello and every delivery
// (nudge) keeps the busy cadence for the next 30 s and cuts an idle wait
// down to 10 s: the first beat naming a new turn's row is never an idle wait
// away, and a delivery lost on the wire or a relay that just came up is
// noticed as fast as before.

export const IDLE_KEEPALIVE_MS = 30_000;
export const BUSY_KEEPALIVE_MS = 10_000;
export const IDLE_KEEPALIVE_CAPABILITY = "idle-keepalive";
export const BUSY_HOLD_MS = 30_000;

export function createWorkerKeepalive({
  heartbeat,
  link,
  idleMs = IDLE_KEEPALIVE_MS,
  busyMs = BUSY_KEEPALIVE_MS,
  busyHoldMs = BUSY_HOLD_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
} = {}) {
  let timer = null;
  let dueAtMs = 0;
  let running = false;
  let busyUntilMs = 0;

  function busy() {
    if (now() < busyUntilMs) return true;
    try {
      if (heartbeat?.hasWork?.() === true) return true;
      if (link?.isBusy?.() === true) return true;
      return false;
    } catch {
      return true;
    }
  }

  function relayAllowsIdleCadence() {
    try {
      return link?.serverSupports?.(IDLE_KEEPALIVE_CAPABILITY) === true;
    } catch {
      return false;
    }
  }

  /** The wait before the next beat, decided after each beat. */
  function nextDelayMs() {
    if (busy() || !relayAllowsIdleCadence()) return busyMs;
    return idleMs;
  }

  function schedule(delayMs) {
    if (timer) clearTimeoutImpl(timer);
    dueAtMs = now() + delayMs;
    timer = setTimeoutImpl(beat, delayMs);
    timer?.unref?.();
  }

  function beat() {
    timer = null;
    if (!running) return;
    void heartbeat?.pulseHeartbeat?.();
    try { link?.refreshReadiness?.("readiness-refresh"); } catch {}
    schedule(nextDelayMs());
  }

  function start() {
    if (running) return;
    running = true;
    // The first heartbeat goes out at once, as the heartbeat's own start did;
    // the socket is not open yet, so its refresh waits for the next beat.
    void heartbeat?.pulseHeartbeat?.();
    schedule(nextDelayMs());
  }

  /**
   * The relay said hello or handed over work: the busy cadence holds for a
   * while, and a beat further away than it comes sooner.
   */
  function nudge() {
    if (!running) return;
    busyUntilMs = Math.max(busyUntilMs, now() + busyHoldMs);
    if (timer && dueAtMs - now() > busyMs) schedule(busyMs);
  }

  function stop() {
    running = false;
    if (timer) clearTimeoutImpl(timer);
    timer = null;
  }

  return {
    start,
    stop,
    nudge,
    status: () => ({ running, dueAtMs: timer ? dueAtMs : null }),
  };
}
