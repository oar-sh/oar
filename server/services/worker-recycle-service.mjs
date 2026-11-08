/**
 * The worker recycle: session workers that run older code than the relay are
 * replaced, between turns, by workers on the relay's code.
 *
 * A session worker loads its code once at start. A deploy plus a relay
 * restart replaces the relay process, but the workers only reconnect and keep
 * running what they started with. Each worker states its build id (hello,
 * ready, heartbeat; shared/build-id.mjs); this service compares it with the
 * relay's and, on a periodic sweep:
 *
 * - waits while the session owns a turn the relay handed out (a `processing`
 *   row) or the worker is not releasable (a turn, a question, a compaction,
 *   background tasks: workerReleaseHold), and while its CLI child still runs
 *   (below);
 * - stops a stale worker of an archived conversation and leaves the session
 *   kill-blocked, as the archive route does: an archived session keeps no
 *   worker;
 * - else stops the worker and every process of the session and launches a
 *   new one (worker-replacement.mjs, the Change CWD mechanism).
 *
 * Releasable is not enough: a worker between two turns of a conversation in
 * use is releasable too, and recycling it would cost the user a cold CLI on
 * the next message. So a stale worker is recycled only once its CLI child is
 * gone as well. The Claude and Copilot runners stop the child after their
 * idle time and say so (`steering.cliAlive`); a worker that does not say (an
 * older build, a kind without a CLI child) is taken as idle only after
 * `quietMs` without a delivery or a turn end for the session, the runners'
 * own idle time.
 *
 * A stale worker on an agent SDK the store installs (`isAgentSdkWorker`: the
 * claude, claude-api, deepseek and cursor kinds, unless a git checkout runs
 * that SDK from its own node_modules) is the exception. An update moves the
 * SDKs out of the package, so the files such a worker would start its next
 * CLI child from may be gone, and a message it gets once its child has idled
 * out fails. So:
 *
 * - it skips the 'cli' and 'quiet' holds and is recycled as soon as its turn,
 *   question and compaction holds (and the processing row) allow;
 * - its background hold stays a hold, and is the one hold it is not fenced
 *   for: background tasks run in the CLI child, so while they do the child is
 *   up and a delivery goes to it, never to a new child from the gone files;
 * - from the first sweep that sees it stale until its recycle, the
 *   replacement fence (below) keeps every delivery away from it, so what is
 *   queued waits for the new worker's cold start rather than failing on the
 *   old one;
 * - a relay that has just started knows its holds only from its first
 *   heartbeat's steering snapshot: until that comes it waits ('steering'),
 *   fenced, for at most `steeringWaitMs`; one that still has sent none by
 *   then is judged as any other worker, unfenced.
 *
 * Besides the periodic sweep, a sweep runs at start and on every worker hello
 * (`sweepNow`), so a stale worker that reconnects to a new relay is fenced
 * before the hello's own request for work is answered.
 *
 * From the moment a recycle passes its holds until its launch is done, the
 * replacement fence (worker-replacement.mjs) keeps every delivery away from
 * the process being replaced, and the stop and the launch run under the
 * relay's per-session launch mutex (session-launch-mutex-service.mjs), as the
 * Change CWD relaunch does. Before the launch the session is asked again
 * whether it is archived, and whether a new worker came up by another way
 * meanwhile (a delivery's primer): that one is kept, never killed by a second
 * launch.
 *
 * The launches are paced, at most `maxInFlight` at a time and one per
 * `minStartGapMs` on the relay: a deploy leaves every worker stale at once,
 * and each Node worker boot is a memory spike. A stop or a launch that fails
 * is retried with a backoff, and a session that keeps failing is named once
 * in a warning; nothing reaches the chat, since nothing of the conversation
 * is lost and the next message relaunches the worker anyway.
 *
 * Storm guards: a worker whose build id equals the relay's is never touched,
 * a relay that does not know its own build id recycles nothing, a worker
 * process (pid) is recycled at most once, so a stale-looking entry the stop
 * left behind is never stopped again, and a session is recycled at most once
 * per relay build id: a new process that still states another id (or none)
 * runs from a tree other than the relay's, and recycling it again would loop.
 */

import { buildIdsDiffer, normalizeBuildId } from '../../shared/build-id.mjs';
import { createWorkerReplacementFence, workerReleaseHold } from './worker-replacement.mjs';

const LOG_TAG = '[worker-recycle]';

/**
 * What a stale worker can wait for, as `status().waiting[].hold` names it:
 * the worker's own release holds (workerReleaseHold; 'turn' also for a
 * processing row the session owns), 'cli' while its CLI child runs, and
 * 'quiet' while a worker that does not report its CLI child has had a
 * delivery or a turn end within `quietMs`, and 'steering' while a worker on
 * an agent SDK has not yet sent the snapshot that names its holds.
 */
export const RECYCLE_HOLDS = Object.freeze(['turn', 'question', 'compaction', 'background', 'cli', 'quiet', 'steering']);
const RECYCLABLE_STATUSES = new Set(['ready', 'processing']);

function sid8(sid) {
  return String(sid || '').slice(0, 8);
}

function toPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// A registry time (ISO string or epoch ms) in epoch ms, or null.
function toTimeMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function errorText(error, fallback) {
  return String(error?.message || error || fallback);
}

/**
 * Whether a worker runs other code than the relay, for display (/api/status,
 * /api/about, relay_tool rows): its build id differs from the relay's, or it
 * states none, which only a worker older than the build id does. Unlike
 * isStale it knows no grace, status or heartbeat: it answers "which build",
 * not "recycle now". A relay that does not know its own id compares nothing.
 */
export function isWorkerOnOtherBuild(worker, relayBuildId) {
  const relayId = normalizeBuildId(relayBuildId);
  if (!relayId || !worker) return false;
  const workerId = normalizeBuildId(worker.buildId);
  return workerId ? buildIdsDiffer(workerId, relayId) : true;
}

export function createWorkerRecycleService({
  // The relay's own build id, computed once at relay start.
  relayBuildId = null,
  // () → the registry's worker entries, in registry order.
  listWorkers = () => [],
  // sid → the registry's entry for the session's worker, or null.
  getWorker = () => null,
  // sid → whether the session owns a turn the relay handed out and has not
  // seen finish (a `processing` queue row). The relay's own record, asked
  // before the worker's snapshot, which can lag a claim by a pulse.
  hasRunningTurn = () => false,
  // sid → whether the worker process the registry names has heartbeated to
  // this relay. A worker that states no build id is stale only once it has
  // (and its entry is old enough, below): a process still booting has not
  // said anything yet.
  hasHeartbeated = () => false,
  // sid → whether the session's conversation is archived (or the session has
  // no runtime session row at all): its worker is stopped, never relaunched.
  isArchived = () => false,
  // sid → when the session last had a delivery or a turn end (epoch ms or an
  // ISO string), or null when the queue knows of none. Asked only for a
  // worker that does not report `steering.cliAlive`.
  quietSince = () => null,
  // async (sid, { keepKilled }) → { ok, error? } (createWorkerReplacement).
  stopWorker,
  // async sid → { ok, error? } (createWorkerReplacement).
  launchWorker,
  // The replacement fence the runtime's deliveries check
  // (createWorkerReplacement().fence): raised for the pid being replaced when
  // a recycle passes its holds, lowered once its launch is done.
  fence = createWorkerReplacementFence(),
  // (sid, fn) → fn's result, run under the relay's per-session launch mutex
  // (sessionLaunchMutex.runExclusive); the stop and the launch go through it.
  runExclusive = (sid, fn) => fn(),
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  sweepIntervalMs = 15_000,
  maxInFlight = 2,
  minStartGapMs = 3_000,
  retryBaseMs = 5_000,
  retryMaxMs = 60_000,
  stuckAfter = 3,
  waitLogEveryMs = 60_000,
  // A worker that states no build id is stale only once its registry entry's
  // `startedAt` is this old. The supervisor marks a fresh launch 'ready' with
  // a pid before it has said hello, and the session's heartbeat flag can still
  // stem from the previous pid; a worker on current code states its build id
  // in its first hello, within a second of starting, so an id still absent
  // after this long is old code.
  nullBuildIdGraceMs = 30_000,
  // How long a worker that does not report its CLI child must have been
  // without a delivery or a turn end: the Claude and Copilot runners'
  // idleShutdownMs, after which they stop the child themselves.
  quietMs = 10 * 60_000,
  // worker → whether its kind runs on an agent SDK (agentSdkForWorkerKind):
  // such a worker, once stale, skips the cli and quiet holds and is fenced
  // until its recycle (see the header).
  isAgentSdkWorker = () => false,
  // How long a stale worker on an agent SDK may go without a steering
  // snapshot (from when this service first saw its process) before it is
  // judged as any other worker. Its heartbeat sends one within a second of
  // a relay's hello.
  steeringWaitMs = 30_000,
  logger = console,
} = {}) {
  if (typeof stopWorker !== 'function' || typeof launchWorker !== 'function') {
    throw new Error('createWorkerRecycleService requires stopWorker and launchWorker');
  }
  const relayId = normalizeBuildId(relayBuildId);
  const bySession = new Map();
  // The sessions whose stale worker waits for a hold, as of the last sweep.
  let waiting = new Map();
  // sid → the relay build id a recycle of the session launched under. The
  // relay's id is fixed for the process, so in practice "recycled once".
  const recycledUnder = new Map();
  // The sessions left outdated after a recycle, as of the last sweep
  // (sid → the build id the new process states, or null), and those already
  // named in a warning.
  let skipped = new Map();
  const skipWarned = new Set();
  let inFlight = 0;
  let recycled = 0;
  // Relay-wide pacing: when the last recycle was admitted and when the last
  // launch went out. Admission is gated on both, and a launch waits for the
  // gap again, since stops take different times.
  let lastAdmitAt = -Infinity;
  let lastLaunchAt = -Infinity;
  let sweepTimer = null;
  let soonTimer = null;
  let soonAt = Infinity;
  let started = false;
  let unknownLogged = false;
  // A sweep put off a recycle for the cap or the gap: the next one comes as
  // soon as a slot frees instead of a whole interval later, so a deploy's
  // stale workers come back about one per gap.
  let deferred = false;

  function log(message) {
    try { logger.log?.(`${LOG_TAG} ${message}`); } catch {}
  }

  function warn(message) {
    try { logger.warn?.(`${LOG_TAG} ${message}`); } catch {}
  }

  function stateFor(sid) {
    let state = bySession.get(sid);
    if (!state) {
      state = {
        inFlight: false,
        failures: 0,
        nextAttemptAt: 0,
        stuckWarned: false,
        // The last pid this service stopped for the session: never stopped
        // again; a new pid is judged by its own build id.
        recycledPid: null,
        // A recycle whose stop went through and whose launch has not yet:
        // `{ oldPid }`. The registry entry is gone by then, so the sweep
        // retries it from here.
        pendingLaunch: null,
        lastWaitLogAt: -Infinity,
        // When this service first saw the session's current pid: the quiet
        // window's start for a worker with no start time and no queue rows,
        // and the steering wait's start.
        firstSeen: null,
        // The pid this service fenced as a stale worker on an agent SDK
        // waiting for its recycle (sdkFenceUp), or null. A recycle admitted
        // takes the fence over and clears this.
        sdkFence: null,
      };
      bySession.set(sid, state);
    }
    return state;
  }

  // Stale, and not already recycled once under this relay build.
  function isStale(worker) {
    if (!isOutdated(worker)) return false;
    return recycledUnder.get(String(worker.sdkSessionId || '').trim()) !== relayId;
  }

  // The worker runs other code than the relay and may be replaced for it.
  function isOutdated(worker) {
    if (!relayId || !worker) return false;
    const sid = String(worker.sdkSessionId || '').trim();
    if (!sid || !toPid(worker.pid)) return false;
    if (!RECYCLABLE_STATUSES.has(String(worker.status || ''))) return false;
    const workerId = normalizeBuildId(worker.buildId);
    if (workerId) return buildIdsDiffer(workerId, relayId);
    const startedAtMs = toTimeMs(worker.startedAt);
    // No start time, no age: unknown is not evidence.
    if (startedAtMs === null || now() - startedAtMs < nullBuildIdGraceMs) return false;
    try {
      return hasHeartbeated(sid) === true;
    } catch {
      // Unknown is not evidence: a process that may still be booting is
      // never stopped on a guess.
      return false;
    }
  }

  function backoffMs(failures) {
    return Math.min(retryMaxMs, retryBaseMs * (2 ** (failures - 1)));
  }

  function noteFailure(sid, state, step, error) {
    state.failures += 1;
    const delay = backoffMs(state.failures);
    state.nextAttemptAt = now() + delay;
    log(`${step} failed ${sid8(sid)} (${state.failures}): ${error}; retrying in ${Math.round(delay / 1000)}s`);
    if (state.failures >= stuckAfter && !state.stuckWarned) {
      state.stuckWarned = true;
      warn(`session ${sid} is stuck: ${state.failures} recycle attempts failed (last: ${step}: ${error}); retrying every ${Math.round(retryMaxMs / 1000)}s at most`);
    }
  }

  function noteSuccess(state) {
    state.failures = 0;
    state.nextAttemptAt = 0;
    state.stuckWarned = false;
  }

  function delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeoutImpl(resolve, Math.max(0, ms));
      timer?.unref?.();
    });
  }

  // Resolves once a launch may go out under the relay-wide gap. The caller
  // takes the slot (lastLaunchAt) itself, synchronously right before its
  // launch, so a launch it then decides against costs no slot.
  async function waitForLaunchSlot() {
    for (;;) {
      const remaining = lastLaunchAt + minStartGapMs - now();
      if (remaining <= 0) break;
      await delay(remaining);
    }
  }

  // A recycle's launch is done (its own, a worker another path brought up, or
  // none for a session archived meanwhile): the fence comes down.
  function endPendingLaunch(sid, state) {
    const oldPid = state.pendingLaunch?.oldPid ?? state.recycledPid;
    state.pendingLaunch = null;
    noteSuccess(state);
    fence.release(sid, oldPid);
  }

  /**
   * The launch half of a recycle; the stop went through already. Runs under
   * the launch mutex.
   *
   * The fence stays up through a failed launch and its backoff: the old pid is
   * gone by then, so the fence refuses only a process that no longer exists,
   * and lowering it would let nothing through that could run a turn. It comes
   * down once a launch is done: this one or a retry succeeds, a worker came up
   * by another way, or the session was archived.
   */
  async function launch(sid, state) {
    await waitForLaunchSlot();
    // Asked after the wait, which can be seconds long, and synchronously up to
    // the launch, so nothing changes between the answer and the launch.
    let archived = false;
    let current = null;
    try {
      archived = isArchived(sid) === true;
      current = getWorker(sid) || null;
    } catch (error) {
      noteFailure(sid, state, 'probe', errorText(error, 'unknown'));
      return;
    }
    const oldPid = state.pendingLaunch?.oldPid ?? 'none';
    if (archived) {
      // Archived since the stop: the session stays without a worker, and its
      // killed marker (set by the stop) is left as the archive route leaves it.
      endPendingLaunch(sid, state);
      log(`stopped ${sid8(sid)} (archived)`);
      return;
    }
    const livePid = toPid(current?.pid);
    if (livePid && livePid !== state.recycledPid) {
      // Another path (the primer, the next delivery) already brought a new
      // worker up, on the relay's code since it started after the deploy. A
      // launch now would stop it again (no process reuse), mid-boot or
      // mid-turn: the job is done.
      endPendingLaunch(sid, state);
      recycled += 1;
      recycledUnder.set(sid, relayId);
      log(`recycled ${sid8(sid)} pid ${oldPid}→${livePid} (started elsewhere)`);
      return;
    }
    lastLaunchAt = now();
    let launched = null;
    try {
      launched = await launchWorker(sid);
    } catch (error) {
      launched = { ok: false, error: errorText(error, 'worker-launch-failed') };
    }
    if (!launched?.ok) {
      noteFailure(sid, state, 'launch', launched?.error || 'unknown');
      return;
    }
    endPendingLaunch(sid, state);
    recycled += 1;
    recycledUnder.set(sid, relayId);
    let newPid = null;
    try { newPid = toPid(getWorker(sid)?.pid); } catch {}
    log(`recycled ${sid8(sid)} pid ${oldPid}→${newPid || 'pending'}`);
  }

  // Whether the registry still names the process the sweep judged. The launch
  // mutex can have made the recycle wait for a Change CWD relaunch, which
  // replaces the worker: the fresh one is not the stale one and is left alone.
  function stillSameProcess(sid, pid) {
    try {
      return toPid(getWorker(sid)?.pid) === pid;
    } catch {
      return false;
    }
  }

  // The fence for `pid` is up when this starts (the sweep raised it).
  async function recycle(sid, worker, state) {
    const pid = toPid(worker.pid);
    let stopped = false;
    try {
      await runExclusive(sid, async () => {
        if (!stillSameProcess(sid, pid)) return;
        log(`recycling ${sid8(sid)} kind=${worker.kind || 'unknown'} from=${normalizeBuildId(worker.buildId) || 'none'} to=${relayId}`);
        let result = null;
        try {
          result = await stopWorker(sid);
        } catch (error) {
          result = { ok: false, error: errorText(error, 'worker-stop-failed') };
        }
        if (!result?.ok) {
          noteFailure(sid, state, 'stop', result?.error || 'unknown');
          return;
        }
        stopped = true;
        state.recycledPid = pid;
        state.pendingLaunch = { oldPid: pid };
        await launch(sid, state);
      });
    } finally {
      // A stop that did not go through (or never ran) leaves the old worker
      // serving its session: it takes work again at once. Not one on an
      // agent SDK the update took away: its fence stays up through the
      // stop's backoff, until the worker goes or the tries reach stuckAfter
      // (the sweep keeps it, sdkFenced), so no queued row goes to it.
      if (!stopped) {
        if (isAgentSdkWorker(worker) === true && state.failures > 0 && state.failures < stuckAfter && stillSameProcess(sid, pid)) {
          state.sdkFence = pid;
          log(`fence kept ${sid8(sid)} pid ${pid}: its stop failed, deliveries wait for the retry`);
        } else {
          fence.release(sid, pid);
        }
      }
    }
  }

  async function stopArchived(sid, worker, state) {
    const pid = toPid(worker.pid);
    try {
      await runExclusive(sid, async () => {
        if (!stillSameProcess(sid, pid)) return;
        let stopped = null;
        try {
          stopped = await stopWorker(sid, { keepKilled: true });
        } catch (error) {
          stopped = { ok: false, error: errorText(error, 'worker-stop-failed') };
        }
        if (!stopped?.ok) {
          noteFailure(sid, state, 'stop', stopped?.error || 'unknown');
          return;
        }
        state.recycledPid = pid;
        noteSuccess(state);
        log(`stopped ${sid8(sid)} (archived)`);
      });
    } finally {
      // Nothing is launched for an archived session: the killed marker the
      // stop keeps is what holds it stopped, not the fence.
      fence.release(sid, pid);
    }
  }

  // Runs one recycle step for a session, keeping the in-flight count; never
  // rejects.
  function begin(state, work) {
    state.inFlight = true;
    inFlight += 1;
    return Promise.resolve()
      .then(work)
      .catch((error) => { warn(`recycle step failed unexpectedly: ${errorText(error, 'unknown')}`); })
      .finally(() => {
        state.inFlight = false;
        inFlight -= 1;
        if (deferred) scheduleSoon(Math.max(0, lastAdmitAt + minStartGapMs - now()));
      });
  }

  function canLaunchNow() {
    const at = now();
    return at - lastAdmitAt >= minStartGapMs && at - lastLaunchAt >= minStartGapMs;
  }

  /**
   * What the stale worker waits for, or null when it may be recycled now:
   * a turn the relay handed out, the worker's own release hold, then its CLI
   * child ('cli' while the worker says it runs) or, for a worker that does
   * not say, a delivery or a turn end within `quietMs` ('quiet'). The quiet
   * window starts at the session's last delivery or turn end, else at the
   * worker's start, else when this service first saw the process. Throws
   * when a probe does; the caller counts that as a probe failure.
   */
  function holdFor(sid, worker, state, sdkMode = null) {
    if (hasRunningTurn(sid) === true) return 'turn';
    if (sdkMode === 'steering') return 'steering';
    const releaseHold = workerReleaseHold(worker);
    if (releaseHold) return releaseHold;
    // A stale worker on an agent SDK goes as soon as its own holds allow: its
    // next CLI child may have no files left to start from.
    if (sdkMode === 'fast') return null;
    const cliAlive = worker?.steering?.cliAlive;
    if (cliAlive === true) return 'cli';
    if (cliAlive === false) return null;
    const since = toTimeMs(quietSince(sid)) ?? toTimeMs(worker.startedAt) ?? firstSeenAt(state, worker);
    return now() - since < quietMs ? 'quiet' : null;
  }

  // When this service first saw the worker's current process.
  function firstSeenAt(state, worker) {
    const pid = toPid(worker.pid);
    if (state.firstSeen?.pid !== pid) state.firstSeen = { pid, at: now() };
    return state.firstSeen.at;
  }

  /**
   * How a stale worker on an agent SDK is judged: 'fast' (its steering
   * snapshot names its holds: no cli or quiet hold, fenced until the
   * recycle), 'steering' (no snapshot yet, within `steeringWaitMs` of when
   * this service first saw the process: wait for it, fenced), or null (not on
   * an agent SDK, or a snapshot never came: as any other worker). Throws
   * when the predicate does; the caller counts that as a probe failure.
   */
  function sdkModeFor(worker, state) {
    if (isAgentSdkWorker(worker) !== true) return null;
    if (worker?.steering && typeof worker.steering === 'object') return 'fast';
    return now() - firstSeenAt(state, worker) < steeringWaitMs ? 'steering' : null;
  }

  // Raises the fence for a stale worker on an agent SDK until its recycle:
  // whatever is queued for the session waits for the new worker.
  function sdkFenceUp(sid, pid, state, confirmed) {
    confirmed.add(sid);
    if (state.sdkFence === pid && fence.isHeld(sid, pid)) return;
    fence.hold(sid, pid);
    if (state.sdkFence !== pid) log(`fenced ${sid8(sid)} pid ${pid}: stale on an agent SDK, deliveries wait for the recycle`);
    state.sdkFence = pid;
  }

  // A recycle (or an archived stop) admitted for the session owns the fence
  // from here: it lowers it when it is done.
  function sdkFenceHandOver(state) {
    state.sdkFence = null;
  }

  // Lowers the fences this service raised for workers no longer judged
  // fenced by this sweep: gone, recycled, in a background hold, a probe that
  // failed, a snapshot that never came.
  function sdkFencesDown(confirmed) {
    for (const [sid, state] of bySession) {
      if (state.sdkFence === null || confirmed.has(sid)) continue;
      const pid = state.sdkFence;
      state.sdkFence = null;
      if (fence.release(sid, pid)) log(`unfenced ${sid8(sid)} pid ${pid}`);
    }
  }

  function noteWaiting(sid, state, hold, nextWaiting) {
    nextWaiting.set(sid, hold);
    if (now() - state.lastWaitLogAt >= waitLogEveryMs) {
      state.lastWaitLogAt = now();
      log(`waiting ${sid8(sid)}: ${hold}`);
    }
  }

  // A session recycled under this build whose new process is outdated still:
  // its tree is not the relay's (another COPILOT_WEB_RELAY_ROOT, a package.json
  // one side cannot read). Named once; another recycle would start the same
  // code again.
  function noteSkipped(sid, worker, nextSkipped) {
    const buildId = normalizeBuildId(worker.buildId);
    nextSkipped.set(sid, buildId);
    if (skipWarned.has(sid)) return;
    skipWarned.add(sid);
    if (buildId) {
      warn(`${sid8(sid)} still on ${buildId} after a recycle under ${relayId}: the worker tree differs from the relay's; not recycled again under this build`);
    } else {
      warn(`${sid8(sid)} still states no build id after a recycle under ${relayId}: the worker tree differs from the relay's; not recycled again under this build`);
    }
  }

  /**
   * One pass over the registry. Starts the recycles it may and resolves once
   * they are done (the timer does not wait for that); never rejects.
   */
  async function sweep() {
    if (!relayId) return;
    const startedSteps = [];
    const nextWaiting = new Map();
    const nextSkipped = new Map();
    deferred = false;
    let workers = [];
    try {
      workers = Array.from(listWorkers() || []);
    } catch (error) {
      warn(`cannot list workers: ${errorText(error, 'unknown')}`);
      return;
    }
    const running = new Set();
    // The sessions whose agent-SDK fence this sweep keeps up (sdkFenceUp).
    const sdkFenced = new Set();
    for (const worker of workers) {
      const sid = String(worker?.sdkSessionId || '').trim();
      if (!sid) continue;
      const pid = toPid(worker.pid);
      const existing = bySession.get(sid);
      // A new process that came up by another way (a delivery primed it)
      // ends a launch this service still owed the session.
      if (pid && pid !== existing?.recycledPid) {
        running.add(sid);
        if (existing?.pendingLaunch && !existing.inFlight) endPendingLaunch(sid, existing);
      }
      if (!isOutdated(worker)) continue;
      if (recycledUnder.get(sid) === relayId) {
        // The process the recycle stopped, listed late, needs no word.
        if (pid && pid !== existing?.recycledPid) noteSkipped(sid, worker, nextSkipped);
        continue;
      }
      const state = stateFor(sid);
      if (state.inFlight) continue;
      if (now() < state.nextAttemptAt) {
        // A failed stop's agent-SDK fence stays up through the backoff, up to
        // stuckAfter tries; then the old worker serves again.
        if (state.sdkFence !== null && state.sdkFence === pid && state.failures < stuckAfter) sdkFenced.add(sid);
        continue;
      }
      if (state.recycledPid && state.recycledPid === toPid(worker.pid)) continue;
      let hold = null;
      let archived = false;
      let sdkMode = null;
      try {
        sdkMode = sdkModeFor(worker, state);
        hold = holdFor(sid, worker, state, sdkMode);
        if (!hold) archived = isArchived(sid) === true;
      } catch (error) {
        // The relay cannot tell whether the session is busy or archived: the
        // worker is not stopped on a guess, and the probe is retried later.
        // Nor is it fenced on a guess: an agent-SDK fence comes down.
        noteFailure(sid, state, 'probe', errorText(error, 'unknown'));
        continue;
      }
      if (hold) {
        // Background tasks keep the CLI child up, so a delivery goes to it:
        // the one hold such a worker waits out unfenced.
        if (sdkMode && hold !== 'background') sdkFenceUp(sid, pid, state, sdkFenced);
        noteWaiting(sid, state, hold, nextWaiting);
        continue;
      }
      if (inFlight >= maxInFlight) {
        deferred = true;
        if (sdkMode) sdkFenceUp(sid, pid, state, sdkFenced);
        continue;
      }
      if (archived) {
        // Fenced from here: the holds just passed, and a delivery to the
        // process being stopped would start a turn on it.
        fence.hold(sid, pid);
        sdkFenceHandOver(state);
        startedSteps.push(begin(state, () => stopArchived(sid, worker, state)));
        continue;
      }
      if (!canLaunchNow()) {
        deferred = true;
        if (sdkMode) sdkFenceUp(sid, pid, state, sdkFenced);
        continue;
      }
      lastAdmitAt = now();
      // Fenced from the moment the holds passed, synchronously, before any
      // await: no delivery can reach the old process between this check and
      // its stop, nor between the stop and the launch.
      fence.hold(sid, pid);
      sdkFenceHandOver(state);
      startedSteps.push(begin(state, () => recycle(sid, worker, state)));
    }
    sdkFencesDown(sdkFenced);
    // Launches owed after a stop went through: the registry lists no new
    // process for those sessions.
    for (const [sid, state] of bySession) {
      if (running.has(sid) || !state.pendingLaunch || state.inFlight || now() < state.nextAttemptAt) continue;
      let archived = false;
      try {
        archived = isArchived(sid) === true;
      } catch (error) {
        noteFailure(sid, state, 'probe', errorText(error, 'unknown'));
        continue;
      }
      if (archived) {
        // Archived since the stop: the session stays without a worker.
        endPendingLaunch(sid, state);
        log(`stopped ${sid8(sid)} (archived)`);
        continue;
      }
      if (inFlight >= maxInFlight || !canLaunchNow()) {
        deferred = true;
        continue;
      }
      lastAdmitAt = now();
      startedSteps.push(begin(state, () => runExclusive(sid, () => launch(sid, state))));
    }
    waiting = nextWaiting;
    skipped = nextSkipped;
    if (deferred && inFlight < maxInFlight) {
      scheduleSoon(Math.max(0, lastAdmitAt + minStartGapMs - now()));
    }
    await Promise.all(startedSteps);
  }

  function runSweep() {
    void sweep().catch(() => {});
  }

  // An extra sweep at `ms` from now, unless one is due sooner; only while
  // the service runs.
  function scheduleSoon(ms) {
    if (!started) return;
    const at = now() + ms;
    if (soonTimer && soonAt <= at) return;
    if (soonTimer) clearTimeoutImpl(soonTimer);
    soonAt = at;
    soonTimer = setTimeoutImpl(() => {
      soonTimer = null;
      soonAt = Infinity;
      runSweep();
    }, ms);
    soonTimer?.unref?.();
  }

  function scheduleNext() {
    sweepTimer = setTimeoutImpl(() => {
      sweepTimer = null;
      if (!started) return;
      runSweep();
      scheduleNext();
    }, sweepIntervalMs);
    sweepTimer?.unref?.();
  }

  function start() {
    if (started) return;
    if (!relayId) {
      if (!unknownLogged) {
        unknownLogged = true;
        warn('relay build id unknown; workers are not recycled');
      }
      return;
    }
    started = true;
    scheduleNext();
    // The start's own sweep: workers left from before the restart need not
    // wait a whole interval.
    runSweep();
  }

  /**
   * A sweep now, outside the interval, while the service runs (a worker's
   * hello). Its judging, the fence included, is done synchronously before
   * this returns; the promise resolves once the recycles it started are done.
   * Never rejects.
   */
  function sweepNow() {
    if (!started) return Promise.resolve();
    return sweep().catch(() => {});
  }

  function stop() {
    started = false;
    if (sweepTimer) clearTimeoutImpl(sweepTimer);
    if (soonTimer) clearTimeoutImpl(soonTimer);
    sweepTimer = null;
    soonTimer = null;
    soonAt = Infinity;
  }

  function status() {
    let staleCount = 0;
    try {
      for (const worker of listWorkers() || []) {
        if (isStale(worker)) staleCount += 1;
      }
    } catch {}
    return {
      relayBuildId: relayId,
      staleCount,
      inFlight,
      recycled,
      waiting: Array.from(waiting, ([sdkSessionId, hold]) => ({ sdkSessionId, hold })),
      skipped: Array.from(skipped, ([sdkSessionId, buildId]) => ({ sdkSessionId, buildId })),
    };
  }

  return { start, stop, sweep, sweepNow, isStale, status };
}

/**
 * The archived sweep at relay start: what still runs for an archived
 * conversation is stopped for good, whatever code it runs. The archive route
 * stops a worker when the conversation is archived, but a worker started
 * since (or before the route did so) would otherwise live on, unused, until
 * the host restarts. The recycle above stops only stale ones.
 *
 * One session at a time, so a long list never stops many processes at once;
 * the killed marker stays (`keepKilled`), as the archive route leaves it.
 * Each stop is guarded as the recycle's archived stop is: it runs under the
 * launch mutex, the session is asked again whether it is archived right
 * before it, and the replacement fence is up for the process being stopped
 * until the stop is over. A message for an archived session unarchives it
 * and lifts the killed marker, and without the fence the old worker would
 * claim the row and be killed mid-turn.
 *
 * Never rejects: every failure is logged, and the session is left to the next
 * relay start or to the recycle. Resolves to the session ids it stopped and
 * the ones it could not.
 */
export async function sweepArchivedWorkers({
  // () → the session ids of archived conversations (may be a promise).
  listArchivedSessionIds = () => [],
  // async sid → whether a process of the session is alive.
  hasLiveProcess = async () => false,
  // sid → whether the session is still archived, asked under the launch mutex
  // right before its stop: a conversation unarchived since the list was read
  // keeps its worker.
  isArchived = () => true,
  // sid → the pid of the session's worker process (may be a promise), or null
  // when unknown: the fence then refuses every process of the session.
  workerPid = () => null,
  // async (sid, { keepKilled }) → { ok, error? } (createWorkerReplacement).
  stopWorker,
  // The replacement fence the runtime's deliveries check, raised for the pid
  // being stopped and lowered once the stop is over, whatever its outcome:
  // a failed stop leaves the old worker serving its session.
  fence = createWorkerReplacementFence(),
  // (sid, fn) → fn's result, run under the relay's per-session launch mutex
  // (sessionLaunchMutex.runExclusive), as the recycle's stops are.
  runExclusive = (sid, fn) => fn(),
  logger = console,
} = {}) {
  const result = { stopped: [], failed: [] };
  // A session found unarchived under the mutex: neither stopped nor failed.
  const KEPT = Symbol('kept');
  const log = (message) => { try { logger.log?.(`${LOG_TAG} ${message}`); } catch {} };
  const warn = (message) => { try { logger.warn?.(`${LOG_TAG} ${message}`); } catch {} };
  if (typeof stopWorker !== 'function') {
    warn('archived sweep skipped: no stopWorker');
    return result;
  }
  let sids = [];
  try {
    const listed = await listArchivedSessionIds();
    sids = Array.from(new Set(Array.from(listed || [], (sid) => String(sid || '').trim()).filter(Boolean)));
  } catch (error) {
    warn(`archived sweep: cannot list archived sessions: ${errorText(error, 'unknown')}`);
    return result;
  }
  for (const sid of sids) {
    try {
      if (await hasLiveProcess(sid) !== true) continue;
      const stopped = await runExclusive(sid, async () => {
        const pid = toPid(await workerPid(sid));
        // Asked synchronously up to the fence: a message that unarchives the
        // session after this answer finds the process being stopped fenced.
        if (isArchived(sid) !== true) {
          log(`kept ${sid8(sid)}: no longer archived`);
          return KEPT;
        }
        // A fence another replacement raised for this process is its own to
        // lower; this stop only lowers one it raised.
        const raised = !fence.isHeld(sid, pid);
        if (raised) fence.hold(sid, pid);
        try {
          return await stopWorker(sid, { keepKilled: true });
        } catch (error) {
          return { ok: false, error: errorText(error, 'worker-stop-failed') };
        } finally {
          if (raised) fence.release(sid, pid);
        }
      });
      if (stopped === KEPT) continue;
      if (stopped?.ok) {
        result.stopped.push(sid);
        log(`stopped ${sid8(sid)} (archived at start)`);
      } else {
        result.failed.push(sid);
        warn(`could not stop ${sid8(sid)} (archived at start): ${stopped?.error || 'unknown'}`);
      }
    } catch (error) {
      // The relay cannot tell whether the session runs or is still archived:
      // nothing is stopped on a guess.
      result.failed.push(sid);
      warn(`archived sweep skipped ${sid8(sid)}: ${errorText(error, 'unknown')}`);
    }
  }
  return result;
}
