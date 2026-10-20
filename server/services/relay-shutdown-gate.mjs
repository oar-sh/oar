'use strict';

// A queued relay shutdown or restart waits for the turns that are processing,
// and only for those. While it waits, no pending row is handed to a worker:
// a new turn would postpone the restart again, and on a busy relay forever
// (live: a turn started after the restart was queued, each time). Pending and
// parked rows stay in the database and run after the restart.

export const RELAY_SHUTDOWN_QUEUED_REASON = 'relay_shutdown_queued';

/** Whether the runtime holds a shutdown or restart request that has not started yet. */
export function isRelayShutdownQueued(runtimeState) {
  if (!runtimeState) return false;
  // The runtime answers this from memory; only a state without the flag
  // (older wiring, tests) reads the whole shutdown state, which counts the
  // queue in the database.
  if (typeof runtimeState.relayShutdownQueued === 'boolean') return runtimeState.relayShutdownQueued;
  return String(runtimeState.relayShutdown?.status || '') === 'queued';
}

/** The queued shutdown may go ahead: nothing is processing (pending and parked rows wait it out). */
export function queuedShutdownCanProceed(counts) {
  return Number(counts?.processingCount || 0) <= 0;
}

/** What a worker asking for work gets while a shutdown is queued: nothing, and why. */
export function relayShutdownGateReply(runtimeState) {
  return {
    message: null,
    paused: true,
    reason: RELAY_SHUTDOWN_QUEUED_REASON,
    relayShutdown: runtimeState?.relayShutdown || null,
  };
}
