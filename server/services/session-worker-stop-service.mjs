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
// read: the caller must not pretend it stopped what it could not see.
async function enumeratePids({ sdkSessionId, worker, processInspector, platform }) {
  const rows = platform === 'win32'
    ? await processInspector?.findWindowsProcessTreeForSessionAsync?.(sdkSessionId, { fresh: true })
    : await processInspector?.findProcessesForSessionAsync?.(sdkSessionId, { fresh: true });
  return toPidList(rows || [], worker?.pid);
}

async function stopWindowsPids(processInspector, pids) {
  await processInspector?.stopWindowsPidsAsync?.(pids);
}

export const PROCESS_LIST_UNREADABLE = 'process-list-unreadable';

export async function stopSessionWorkerProcesses({
  sdkSessionId,
  worker = null,
  processInspector = null,
  platform = process.platform,
  killImpl = (pid, signal) => process.kill(pid, signal),
  isPidAliveImpl = () => false,
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

  let pids;
  try {
    pids = await enumeratePids({ sdkSessionId: sid, worker, processInspector, platform });
  } catch (error) {
    // Nothing is stopped blind: the known pid alone would leave the tree
    // running, and the caller would relaunch next to it.
    return done({ ok: false, pids: [], remainingPids: [], error: `${PROCESS_LIST_UNREADABLE}: ${error?.message || error}` });
  }
  if (!pids.length) return done({ pids: [] });

  const survivors = (list) => list.filter((pid) => isPidAliveImpl(pid));

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
      for (const pid of pids) {
        try {
          killImpl(pid, 'SIGTERM');
        } catch (error) {
          if (String(error?.code || '') !== 'ESRCH') throw error;
        }
      }
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
      const rediscovered = await enumeratePids({ sdkSessionId: sid, worker, processInspector, platform });
      escalationTargets = [...new Set([...remainingPids, ...rediscovered.filter((pid) => isPidAliveImpl(pid))])];
      await stopWindowsPids(processInspector, escalationTargets);
    } else {
      for (const pid of escalationTargets) {
        try {
          killImpl(pid, 'SIGKILL');
        } catch (error) {
          if (String(error?.code || '') !== 'ESRCH') throw error;
        }
      }
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

  remainingPids = await waitFor(escalationTargets, escalationTimeoutMs);
  if (remainingPids.length) {
    return done({
      ok: false,
      pids,
      remainingPids,
      escalated: true,
      timedOut: true,
      error: `worker-stop-timeout:${remainingPids.join(',')}`,
    });
  }
  return done({ pids, escalated: true });
}
