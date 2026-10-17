// ---------------------------------------------------------------------------
// Detached-worker watch
//
// A worker whose process lives on but whose websocket to the relay is gone
// gets no deliveries, and the relay spawns no replacement while its process
// is alive: a message for its session would wait for ever. A worker on Node
// 22 ended up like that after a relay restart, its one reconnect having met a
// runtime that was not ready yet.
//
// The watch looks at the sessions that have a message waiting. One whose
// worker process is found alive with no socket, no turn running and no
// background work is replaced once it has been detached for the grace time:
// the old process is stopped and a new worker spawned, which takes the
// waiting message at its hello. The grace time counts from the latest of the
// watch's start (a relay start), the session's last socket end and its last
// spawn; a worker still booting gets twice as long.
// ---------------------------------------------------------------------------

export const DETACHED_WORKER_GRACE_MS = 60_000;
// A replacement that did not help (the new worker cannot connect either)
// is not repeated at once.
export const DETACHED_WORKER_REPLACE_COOLDOWN_MS = 5 * 60_000;

function normalizeSessionId(value) {
  return String(value || '').trim();
}

export function createDetachedWorkerWatch({
  graceMs = DETACHED_WORKER_GRACE_MS,
  replaceCooldownMs = DETACHED_WORKER_REPLACE_COOLDOWN_MS,
  now = () => Date.now(),
  // Whether the watch may act at all (routing on, no shutdown under way).
  isEnabled = () => true,
  // The session ids that have a message waiting for their worker.
  listWaitingSessionIds = () => [],
  hasWorkerSocket = () => true,
  hasRunningTurn = () => true,
  hasBackgroundWork = () => true,
  // A kill just asked for, or a launch in flight: not the watch's business.
  isLaunchBlocked = () => false,
  // ({ launchMode, launchAtMs, awaitingHeartbeat }) for the session, or null.
  getLaunchState = () => null,
  // Resolves to whether a process of the session's worker is running.
  isWorkerProcessAlive = async () => false,
  // Stops the session's worker processes and spawns a new worker; resolves
  // to { ok, error }.
  replaceWorker = async () => ({ ok: false, error: 'not-configured' }),
  log = () => {},
} = {}) {
  const startedAtMs = Number(now());
  const socketEndedAtMs = new Map();
  const replacedAtMs = new Map();
  const replacing = new Set();
  let sweepInFlight = false;

  function nowMs() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function noteSocketEnded(sessionId) {
    const sid = normalizeSessionId(sessionId);
    if (sid) socketEndedAtMs.set(sid, nowMs());
  }

  function forgetOld(atMs) {
    const horizon = Math.max(graceMs * 2, replaceCooldownMs);
    for (const [sid, at] of socketEndedAtMs) {
      if (atMs - at > horizon) socketEndedAtMs.delete(sid);
    }
    for (const [sid, at] of replacedAtMs) {
      if (atMs - at > horizon) replacedAtMs.delete(sid);
    }
  }

  // How long the session's worker has been detached for the watch's
  // purposes, and the grace it gets.
  function detachedFor(sid, atMs) {
    const launch = getLaunchState(sid) || null;
    const launchAtMs = Number(launch?.launchAtMs || 0);
    const spawnedAtMs = launch?.launchMode === 'spawned' ? launchAtMs : 0;
    const anchorMs = Math.max(startedAtMs, Number(socketEndedAtMs.get(sid) || 0), spawnedAtMs);
    const booting = launch?.launchMode === 'spawned' && launch?.awaitingHeartbeat === true;
    return { detachedMs: atMs - anchorMs, graceMs: booting ? graceMs * 2 : graceMs };
  }

  function stillDetached(sid) {
    return !hasWorkerSocket(sid) && !hasRunningTurn(sid) && !hasBackgroundWork(sid) && !isLaunchBlocked(sid);
  }

  async function considerSession(sid, atMs) {
    if (replacing.has(sid)) return false;
    if (!stillDetached(sid)) return false;
    const lastReplacedAtMs = replacedAtMs.get(sid);
    if (lastReplacedAtMs && atMs - lastReplacedAtMs < replaceCooldownMs) return false;
    const { detachedMs, graceMs: grace } = detachedFor(sid, atMs);
    if (detachedMs < grace) return false;
    if (!(await isWorkerProcessAlive(sid))) return false;
    // The process probe can take a moment (a process list): the worker may
    // have reconnected or taken a turn meanwhile.
    if (!isEnabled() || !stillDetached(sid)) return false;

    replacing.add(sid);
    replacedAtMs.set(sid, atMs);
    log(`WORKER DETACHED session=${sid.slice(0, 8)} detachedMs=${detachedMs} — no socket while a message waits; replacing the worker`);
    try {
      const result = await replaceWorker(sid, { detachedMs });
      if (result?.ok) {
        log(`WORKER DETACHED session=${sid.slice(0, 8)} replaced`);
        return true;
      }
      log(`WORKER DETACHED session=${sid.slice(0, 8)} replace failed: ${String(result?.error || 'unknown')}`);
      return false;
    } catch (error) {
      log(`WORKER DETACHED session=${sid.slice(0, 8)} replace failed: ${error?.message || error}`);
      return false;
    } finally {
      replacing.delete(sid);
    }
  }

  // One sweep at a time: a slow process list must not pile sweeps up.
  async function sweep() {
    if (sweepInFlight) return 0;
    if (!isEnabled()) return 0;
    sweepInFlight = true;
    try {
      const atMs = nowMs();
      forgetOld(atMs);
      const sessionIds = [...new Set((listWaitingSessionIds() || []).map(normalizeSessionId).filter(Boolean))];
      let replaced = 0;
      for (const sid of sessionIds) {
        if (!isEnabled()) break;
        try {
          if (await considerSession(sid, atMs)) replaced += 1;
        } catch (error) {
          log(`WORKER DETACHED check failed session=${sid.slice(0, 8)} err=${error?.message || error}`);
        }
      }
      return replaced;
    } finally {
      sweepInFlight = false;
    }
  }

  return {
    noteSocketEnded,
    sweep,
  };
}
