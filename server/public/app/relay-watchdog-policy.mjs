// Escalation policy for the relay connection watchdog. ensureSocketConnected()
// only ever calls socket.connect(), which socket.io silently ignores while the
// manager believes a reconnect cycle is in flight (`_reconnecting`) or the
// socket still claims to be connected. Both states can outlive an Android
// freeze whose timers were dropped, leaving connect() a permanent no-op. The
// watchdog therefore counts consecutive ticks spent disconnected and, past a
// threshold, escalates to a hard reset that rebuilds the manager state machine.

// Four 5s ticks ≈ 20s. A healthy manager mid-backoff completes a full retry
// cycle inside that window (10s max delay + 10s connect timeout only overlaps
// when the network is genuinely down, where a reset is harmless churn), so a
// hard reset this late only fires on wedged or dead-network states.
export const RELAY_WATCHDOG_HARD_RESET_TICKS = 4;

/**
 * Decide what this watchdog tick should do.
 * @param {{ state: 'connected'|'retrying'|'forced'|'disabled', disconnectedTicks: number, hardResetTicks?: number }} input
 * @returns {{ disconnectedTicks: number, hardReset: boolean }}
 */
export function adviseWatchdogTick({ state, disconnectedTicks, hardResetTicks = RELAY_WATCHDOG_HARD_RESET_TICKS }) {
  if (state === 'connected' || state === 'disabled') {
    return { disconnectedTicks: 0, hardReset: false };
  }
  const next = (Number(disconnectedTicks) || 0) + 1;
  if (next >= hardResetTicks) {
    return { disconnectedTicks: 0, hardReset: true };
  }
  return { disconnectedTicks: next, hardReset: false };
}
