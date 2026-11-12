/**
 * Replacing a session's worker: the stop and the launch that the Claude
 * billing swap (claude-billing-swap-service.mjs) and the worker recycle
 * (worker-recycle-service.mjs) share, and the predicate both use to tell
 * whether a worker may be replaced now.
 *
 * The stop is the kill route's: nothing may start the session while it is
 * stopped, every process of the session must be gone before it counts as
 * stopped, and only then is the registry entry dropped. The launch never
 * reuses a live process, so two CLIs never share a session's transcript.
 * The fence keeps the deliveries away from the process being replaced for the
 * whole of it (createWorkerReplacementFence).
 */

import {
  isProcessAlive as defaultIsProcessAlive,
  stopSessionWorkerProcesses as defaultStopSessionWorkerProcesses,
} from './session-worker-stop-service.mjs';
import { createProcessIdentityReader, judgeSessionWorkerProcess } from './session-worker-process-service.mjs';

/**
 * What keeps a worker from being replaced now: null when nothing does, else
 * 'turn', 'question', 'compaction' or 'background'. From the steering
 * snapshot its heartbeat sends; a worker too old to say `releasable` is read
 * from the rest of it.
 */
export function workerReleaseHold(worker) {
  if (!worker) return null;
  const steering = worker.steering || null;
  if (steering && typeof steering.releasable === 'boolean') {
    return steering.releasable ? null : (steering.releaseHold || 'turn');
  }
  if (steering) {
    if (steering.holdReason === 'question') return 'question';
    if (steering.holdReason === 'compaction') return 'compaction';
    if (steering.turnActive) return 'turn';
    if (steering.autoCompactWindow?.backgroundWork) return 'background';
    return null;
  }
  return String(worker.status || '') === 'processing' ? 'turn' : null;
}

function toFencePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * The replacement fence: while a worker process is being replaced, no work
 * is handed to it.
 *
 * The killed marker the stop sets does not do this. It lapses after the
 * supervisor's short kill grace (a stop that verifies every process gone can
 * take longer), and any path that relaunches a session lifts it at once
 * (`clearRestartSchedule({ resetKilledMarker: true })`, the delivery's own
 * fallback restart among them), after which a delivery would start a turn on
 * the very process being killed. The fence is its own structure, so nothing
 * that resets the supervisor's lifecycle state touches it.
 *
 * Keyed by session and the pid being replaced: the new worker has another
 * pid and is never fenced, so it takes the work that waited meanwhile. A
 * request that names no pid cannot be told from the old process and is
 * refused while the session's fence is up.
 *
 * - `hold(sid, pid)`: raise the fence for that process of the session.
 * - `isHeld(sid, pid)`: true while the fence is up for that pid (or for any
 *   pid of the session, when `pid` is unknown).
 * - `release(sid, pid?)`: lower it; with a pid, only if that is the fenced
 *   one, so a late release from an older replacement never lifts a newer one.
 */
export function createWorkerReplacementFence() {
  const held = new Map();

  function key(sid) {
    return String(sid || '').trim();
  }

  function hold(sid, pid) {
    const sessionId = key(sid);
    if (!sessionId) return false;
    held.set(sessionId, toFencePid(pid));
    return true;
  }

  function isHeld(sid, pid = null) {
    const sessionId = key(sid);
    if (!sessionId || !held.has(sessionId)) return false;
    const fencedPid = held.get(sessionId);
    const askingPid = toFencePid(pid);
    // An unknown pid on either side: the old process cannot be ruled out.
    if (fencedPid === null || askingPid === null) return true;
    return fencedPid === askingPid;
  }

  function release(sid, pid = undefined) {
    const sessionId = key(sid);
    if (!sessionId || !held.has(sessionId)) return false;
    if (pid !== undefined && toFencePid(pid) !== held.get(sessionId)) return false;
    held.delete(sessionId);
    return true;
  }

  function list() {
    return Array.from(held, ([sdkSessionId, pid]) => ({ sdkSessionId, pid }));
  }

  return { hold, isHeld, release, list };
}

export function createWorkerReplacement({
  // The session worker registry: getWorker(sid), removeWorker(sid).
  registry,
  // The session worker supervisor: markKilled, cancelPendingStart,
  // clearRestartSchedule, resetHealth, ensureWorker.
  supervisor,
  // Handed to stopSessionWorkerProcesses to find every process of a session.
  processInspector = null,
  // session-worker-stop-service.mjs by default; tests inject a fake so they
  // need no processes: async ({ sdkSessionId, worker, processInspector,
  // isPidAliveImpl, killTmuxSessionImpl }) → { ok, error?, remainingPids? }.
  stopSessionWorkerProcesses = defaultStopSessionWorkerProcesses,
  isProcessAlive = undefined,
  // (pid, { fresh }) → { pid, startTime, commandLine } | null: what the
  // process at a pid is (session-worker-process-service.mjs). By default
  // read from /proc, ps, or the inspector's process list on Windows.
  readProcessIdentity = undefined,
  killTmuxSession = undefined,
  logger = console,
  // The caller's tag for its warnings ('BILLING SWAP', 'WORKER RECYCLE'), and
  // a function for the runtime's own log prefix, or a fixed string.
  logPrefix = '',
  // The replacement fence the caller raises before the stop and lowers once
  // the launch is done (createWorkerReplacementFence). Passed in so the
  // runtime's replacements and its delivery paths share one; this module
  // only hands it back.
  fence = createWorkerReplacementFence(),
} = {}) {
  if (typeof stopSessionWorkerProcesses !== 'function') {
    throw new Error('createWorkerReplacement requires stopSessionWorkerProcesses');
  }
  const identityReader = typeof readProcessIdentity === 'function'
    ? readProcessIdentity
    : createProcessIdentityReader({
      readProcessSnapshot: typeof processInspector?.readProcessSnapshot === 'function'
        ? (options) => processInspector.readProcessSnapshot(options)
        : null,
    });
  // Never rejects: a reader that failed knows nothing about the process.
  const identityOf = async (pid, options = {}) => {
    try {
      return await identityReader(pid, options);
    } catch {
      return { pid, startTime: null, commandLine: null };
    }
  };
  const isWorkerPidAlive = (pid) => {
    try {
      return (typeof isProcessAlive === 'function' ? isProcessAlive : defaultIsProcessAlive)(pid) === true;
    } catch {
      return false;
    }
  };

  function prefix() {
    try {
      return typeof logPrefix === 'function' ? String(logPrefix() || '') : String(logPrefix || '');
    } catch {
      return '';
    }
  }

  /**
   * Stop every process of the session. `{ ok: true }` once they are all gone
   * and the registry and the supervisor's health state are cleared, with
   * `identity`, the stopped worker's pid and start time as read before the
   * stop, when it could be read (the recycle tells by it whether a launch
   * named the stopped process or a new one that got its pid); else
   * `{ ok: false, error, remainingPids }`, and the caller retries with a
   * backoff.
   *
   * `keepKilled: true` is for a session that must stay stopped (an archived
   * conversation): the killed marker set here is left in place on either
   * outcome, as the archive route leaves it, so nothing relaunches the
   * session meanwhile.
   */
  async function stopWorker(sid, { keepKilled = false } = {}) {
    const worker = registry?.getWorker?.(sid) || null;
    // Nothing may start the session while it is being stopped: a launch then
    // would adopt the old process, kind and build and all.
    supervisor?.markKilled?.(sid);
    // A stop that fails backs off (the caller retries it). Unless the session
    // is to stay stopped, the killed marker goes with it, so the session's
    // worker, alive or relaunched, keeps asking for work meanwhile.
    const backOff = (error, remainingPids = []) => {
      if (!keepKilled) supervisor?.clearRestartSchedule?.(sid, { resetKilledMarker: true });
      const remaining = remainingPids.length ? ` remaining=${remainingPids.join(',')}` : '';
      const marker = keepKilled ? 'kill marker kept' : 'kill marker cleared';
      try {
        logger.warn?.(`${prefix()}STOP FAILED session=${String(sid).slice(0, 8)} ${error}${remaining} — ${marker}, retrying with a backoff`);
      } catch {}
      return { ok: false, error, remainingPids };
    };
    const workerPid = toFencePid(worker?.pid);
    let stopped = null;
    let before = null;
    try {
      await supervisor?.cancelPendingStart?.(sid, { wait: true });
      // What the worker's process is before the stop ends it.
      if (workerPid) before = (await identityOf(workerPid)) || null;
      stopped = await stopSessionWorkerProcesses({
        sdkSessionId: sid,
        worker,
        processInspector,
        isPidAliveImpl: isProcessAlive,
        readProcessIdentityImpl: identityReader,
        workerIdentity: before,
        killTmuxSessionImpl: killTmuxSession,
      });
    } catch (error) {
      return backOff(String(error?.message || error || 'worker-stop-failed'));
    }
    if (!stopped?.ok) return backOff(stopped?.error || 'worker-survived-stop', stopped?.remainingPids || []);
    // The registry's pid, alive though the process list never showed it. If
    // it is still the session's worker (its command line names the session,
    // its start time is the one read before the stop), the stop never
    // reached it (a command line the list does not know as a worker's), and
    // it goes on asking for the session's work: not a stop, since a
    // replacement launched now would leave it serving beside the new one, or
    // alone while that launch waits. A process that only has its pid now (a
    // pid handed out again, a zombie) means the worker is gone. One nothing
    // could be read about is no stop either, but its pid is not named.
    const listed = Array.isArray(stopped.pids) && stopped.pids.map(Number).includes(workerPid);
    if (workerPid && !listed && isWorkerPidAlive(workerPid)) {
      const verdict = judgeSessionWorkerProcess(await identityOf(workerPid, { fresh: true }), { sdkSessionId: sid, before });
      if (verdict === 'ours') return backOff('worker-not-in-process-list', [workerPid]);
      if (verdict === 'unverified') return backOff('worker-not-in-process-list');
    }
    registry?.removeWorker?.(sid);
    supervisor?.resetHealth?.(sid, { clearFailureCount: false });
    return before?.startTime ? { ok: true, identity: { pid: before.pid, startTime: before.startTime } } : { ok: true };
  }

  /** Launch the session's worker, never reusing a live process: `{ ok, error }`. */
  async function launchWorker(sid) {
    supervisor?.clearRestartSchedule?.(sid, { resetKilledMarker: true });
    const launched = await supervisor?.ensureWorker?.(sid, { allowProcessReuse: false });
    return { ok: launched?.ok === true, error: launched?.error || null };
  }

  return { stopWorker, launchWorker, fence };
}
