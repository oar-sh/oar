// ---------------------------------------------------------------------------
// Deterministic session-worker stop
//
// Kills every process belonging to a session and then *verifies* it is gone,
// escalating once if the graceful pass did not take. Callers must be able to
// distinguish "the old CLI is definitely dead" from "we asked it to die" —
// relaunching into a still-live process is how a session ends up with two CLIs,
// or with one CLI silently still in the old working directory.
//
// Never throws: the caller decides what a timeout means.
// ---------------------------------------------------------------------------

import { createProcessIdentityReader, judgeSessionWorkerProcess } from './session-worker-process-service.mjs';

const DEFAULT_GRACEFUL_TIMEOUT_MS = 3_000;
const DEFAULT_ESCALATION_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

function toPidList(rows, extraPid) {
  const fromRows = (Array.isArray(rows) ? rows : []).map((row) => Number(row?.processId));
  return [...new Set([...fromRows, Number(extraPid)])]
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

// The process list is read off the relay's thread, fresh (a stop must see
// the children started a moment ago). Throws when the list could not be
// read: the caller must not pretend it stopped what it could not see. The
// registry's pid counts only while that process is alive: a worker that is
// gone is stopped already (on Windows its stop call alone could fail).
//
// On Windows the registry's pid that is alive but not in the session's tree
// is stopped only when what runs under it is still the session's worker: its
// command line names the session, and its start time is the one the caller
// read before the stop (`workerIdentity`), when it has one. Windows hands a
// pid out again within seconds; an unverified pid is never killed.
//
// On POSIX the list is every process with its command line, and the
// registry's pid is signalled only when the list shows it as the session's.
// A pid that is alive but not listed is never signalled here, since it is
// usually no worker of this session: the old worker's pid handed to another
// process (another user's, which no signal reaches, or one of the relay
// user's own, which the stop would kill), or a worker that ended and whose
// parent has not reaped it yet (a zombie answers signal 0 and has no command
// line left). It can also be the session's worker under a command line the
// list does not take for a worker's, or cut past the session id (procps-ng
// cuts `args` at 128 KiB even with -ww). The stop does not tell these apart;
// the worker replacement (worker-replacement.mjs) does, by the process's
// start time and command line, and counts only the last as a failed stop.
async function enumeratePids({ sdkSessionId, worker, processInspector, platform, isPidAliveImpl, readIdentity, workerIdentity }) {
  const rows = platform === 'win32'
    ? await processInspector?.findWindowsProcessTreeForSessionAsync?.(sdkSessionId, { fresh: true })
    : await processInspector?.findProcessesForSessionAsync?.(sdkSessionId, { fresh: true });
  const listed = toPidList(rows || []);
  const workerPid = Number(worker?.pid);
  if (!Number.isInteger(workerPid) || workerPid <= 0 || listed.includes(workerPid)) return listed;
  if (platform !== 'win32' || !isPidAliveImpl(workerPid)) return listed;
  let current;
  try {
    // The list the tree came from, a moment old at most.
    current = await readIdentity(workerPid);
  } catch {
    current = { pid: workerPid, startTime: null, commandLine: null };
  }
  const verdict = judgeSessionWorkerProcess(current, { sdkSessionId, before: workerIdentity });
  return verdict === 'ours' ? toPidList(rows || [], workerPid) : listed;
}

async function stopWindowsPids(processInspector, pids) {
  await processInspector?.stopWindowsPidsAsync?.(pids);
}

export const PROCESS_LIST_UNREADABLE = 'process-list-unreadable';

/**
 * Whether `pid` is a live process: signal 0 reaches it. EPERM means it
 * exists but belongs to someone else: alive. The default for every stop
 * that is given no check of its own.
 */
export function isProcessAlive(pid, { killImpl = (target, signal) => process.kill(target, signal) } = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    killImpl(value, 0);
    return true;
  } catch (error) {
    return String(error?.code || '').toUpperCase() === 'EPERM';
  }
}

export async function stopSessionWorkerProcesses({
  sdkSessionId,
  worker = null,
  processInspector = null,
  platform = process.platform,
  killImpl = (pid, signal) => process.kill(pid, signal),
  isPidAliveImpl = isProcessAlive,
  // (pid) → { pid, startTime, commandLine } | null; by default from the
  // inspector's process list (session-worker-process-service.mjs).
  readProcessIdentityImpl = null,
  // The worker's identity as the caller read it before the stop, or null.
  workerIdentity = null,
  killTmuxSessionImpl = null,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowMs = Date.now,
  gracefulTimeoutMs = DEFAULT_GRACEFUL_TIMEOUT_MS,
  escalationTimeoutMs = DEFAULT_ESCALATION_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const sid = String(sdkSessionId || '').trim();
  const startedAt = nowMs();
  const done = (extra) => ({
    ok: true,
    pids: [],
    remainingPids: [],
    escalated: false,
    timedOut: false,
    durationMs: nowMs() - startedAt,
    error: null,
    ...extra,
  });

  if (!sid) return done({ ok: false, error: 'Missing session id' });

  const readIdentity = typeof readProcessIdentityImpl === 'function'
    ? readProcessIdentityImpl
    : createProcessIdentityReader({
      platform,
      readProcessSnapshot: typeof processInspector?.readProcessSnapshot === 'function'
        ? (options) => processInspector.readProcessSnapshot(options)
        : null,
    });
  const enumerate = () => enumeratePids({ sdkSessionId: sid, worker, processInspector, platform, isPidAliveImpl, readIdentity, workerIdentity });

  let pids;
  try {
    pids = await enumerate();
  } catch (error) {
    // Nothing is stopped blind: the known pid alone would leave the tree
    // running, and the caller would relaunch next to it.
    return done({ ok: false, pids: [], remainingPids: [], error: `${PROCESS_LIST_UNREADABLE}: ${error?.message || error}` });
  }
  if (!pids.length) return done({ pids: [] });

  const survivors = (list) => list.filter((pid) => isPidAliveImpl(pid));

  // POSIX: a signal no process takes (ESRCH) is ignored; one it is not ours
  // to send (EPERM: another user's process) is remembered and the others
  // still get theirs; the re-check below decides about that pid.
  const refused = new Map();
  const signal = (pid, name) => {
    try {
      killImpl(pid, name);
    } catch (error) {
      const code = String(error?.code || '');
      if (code === 'EPERM') refused.set(pid, error);
      else if (code !== 'ESRCH') throw error;
    }
  };

  // POSIX: a pid that outlived the stop counts only while a fresh list still
  // shows it as the session's. The list matches command lines, so a match
  // can be a process that was ending anyway (a shell that carried the
  // session's arguments, another user's one included), and a process that
  // ended but is not reaped yet (a zombie) still answers signal 0 with no
  // command line left. A list that cannot be read changes nothing.
  const stillListed = async (list) => {
    if (platform === 'win32' || !list.length) return list;
    try {
      const fresh = await enumerate();
      return list.filter((pid) => fresh.includes(pid) && isPidAliveImpl(pid));
    } catch {
      return list;
    }
  };

  const waitFor = async (list, timeoutMs) => {
    const deadline = nowMs() + Math.max(0, Number(timeoutMs) || 0);
    let remaining = survivors(list);
    while (remaining.length && nowMs() < deadline) {
      await sleepImpl(pollIntervalMs);
      remaining = survivors(list);
    }
    return remaining;
  };

  try {
    if (platform === 'win32') {
      // stopWindowsPids already walks the descendant tree leaf-first and uses
      // Stop-Process -Force, so there is no gentler first pass to attempt.
      await stopWindowsPids(processInspector, pids);
    } else {
      for (const pid of pids) signal(pid, 'SIGTERM');
      // The tmux session can outlive its child after SIGTERM.
      killTmuxSessionImpl?.(sid);
    }
  } catch (error) {
    return done({ ok: false, pids, remainingPids: survivors(pids), error: error?.message || 'Failed to stop the CLI' });
  }

  let remainingPids = await waitFor(pids, gracefulTimeoutMs);
  if (!remainingPids.length) return done({ pids });

  // Escalate once.
  let escalationTargets = remainingPids;
  try {
    if (platform === 'win32') {
      // Re-enumerate: children spawned after the first snapshot are invisible to it.
      const rediscovered = await enumerate();
      escalationTargets = [...new Set([...remainingPids, ...rediscovered.filter((pid) => isPidAliveImpl(pid))])];
      await stopWindowsPids(processInspector, escalationTargets);
    } else {
      for (const pid of escalationTargets) signal(pid, 'SIGKILL');
    }
  } catch (error) {
    return done({
      ok: false,
      pids,
      remainingPids: survivors(escalationTargets),
      escalated: true,
      error: error?.message || 'Failed to force-stop the CLI',
    });
  }

  remainingPids = await stillListed(await waitFor(escalationTargets, escalationTimeoutMs));
  if (remainingPids.length) {
    // A refused signal is the reason only when every survivor refused one;
    // a survivor that took its signals and lives on is a timeout.
    const refusal = remainingPids.every((pid) => refused.has(pid)) ? refused.get(remainingPids[0]) : null;
    return done({
      ok: false,
      pids,
      remainingPids,
      escalated: true,
      timedOut: !refusal,
      error: refusal ? (refusal.message || 'Failed to stop the CLI') : `worker-stop-timeout:${remainingPids.join(',')}`,
    });
  }
  return done({ pids, escalated: true });
}
