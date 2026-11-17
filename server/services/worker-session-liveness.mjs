'use strict';

// Whether a session's worker still runs: one probe for the dead-worker
// detection (server-runtime.mjs, isWorkerSessionProcessAlive) and the archive
// (conversation-lifecycle-routes.mjs, probeDeadSessions). Each caller keeps
// its own reading of 'unknown': the dead-worker detection counts it as not
// alive and recovers the turn, the archive as not dead and leaves the turn to
// the sweep.

/**
 * Every dependency is read at call time:
 * - `hasLiveWorkerSocket(sessionId)`: a worker socket heard from lately, or
 *   one whose pid probes alive (session-worker-websocket-service.mjs). A
 *   merely retained socket is not proof of life: a dead worker's socket
 *   lingers until its close event lands.
 * - `getWorkerPid(sessionId)`: the registry's pid, if any.
 * - `isPidAlive(pid)`.
 * - `findProcessForSession(sessionId)`: the process list's lookup (on win32
 *   a PowerShell run, shared and cached by the inspector), or null where
 *   there is none.
 */
export function createWorkerSessionLiveness({
  hasLiveWorkerSocket = () => false,
  getWorkerPid = () => null,
  isPidAlive = () => false,
  findProcessForSession = null,
} = {}) {
  /**
   * 'alive', 'dead', or 'unknown' when the process list cannot answer (no
   * list, or its lookup threw: `onLookupError(sessionId, error)` hears it).
   * The pids first, since they cost nothing; the process list last.
   */
  async function probe(sessionId, { hintPid = null, onLookupError = null } = {}) {
    if (hasLiveWorkerSocket(sessionId) === true) return 'alive';
    const registryPid = Number(getWorkerPid(sessionId) || 0);
    if (registryPid > 0 && isPidAlive(registryPid)) return 'alive';
    const pid = Number(hintPid || 0);
    if (pid > 0 && isPidAlive(pid)) return 'alive';
    if (typeof findProcessForSession !== 'function') return 'unknown';
    try {
      return (await findProcessForSession(sessionId)) ? 'alive' : 'dead';
    } catch (error) {
      onLookupError?.(sessionId, error);
      return 'unknown';
    }
  }

  /**
   * The sessions probed together, bounded by `timeoutMs`: `{ states, unanswered }`,
   * with `states` a Map of each session's answer ('unknown' for one that had
   * not answered in time) and `unanswered` the number of those.
   */
  async function probeAll(sessionIds, { timeoutMs, onLookupError = null } = {}) {
    const states = new Map(sessionIds.map((sessionId) => [sessionId, 'unknown']));
    let answered = 0;
    const lookups = Promise.all(sessionIds.map((sessionId) => probe(sessionId, { onLookupError }).then((state) => {
      states.set(sessionId, state);
      answered += 1;
    })));
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([lookups, timeout]);
    } finally {
      clearTimeout(timer);
    }
    // A copy: a lookup that answers after the limit changes nothing returned.
    return { states: new Map(states), unanswered: sessionIds.length - answered };
  }

  return { probe, probeAll };
}
