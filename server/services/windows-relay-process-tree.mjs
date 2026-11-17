'use strict';

import { isChildProcessOf } from '../../shared/worker-runtime/process-tree.mjs';

/**
 * The processes of one relay install on Windows, and how `oar stop` and
 * `oar restart --now` end them all before anything starts again.
 *
 * Ending the boot task (or the console `oar start` left) ends none of them:
 * Task Scheduler ends the cmd.exe it started, and Windows ends no child with
 * its parent. Under that cmd.exe run the supervisor (`node server.js`) and
 * the runtime it started (`server.js --relay-runtime`); the session workers
 * are started through `cmd /c start`, whose cmd.exe ends at once, so no walk
 * down from the supervisor reaches them. On 2026-11-16 a deploy that ended
 * the task left the supervisor, the runtime and 24 workers running.
 *
 * What counts as this install's, from one process list (`processId`,
 * `parentProcessId`, `commandLine`, `createdAt`):
 *  - the runtime: the process the relay's lock names (`lockPid`), and only
 *    while it runs this install's `<serverDir>\server.js` as a runtime
 *    (`--relay-runtime`, or `--supervised` under an outer supervisor);
 *  - the supervisor: that runtime's parent, while it is a node process that
 *    runs a server.js by any path (`node server/server.js` and `npm start`
 *    run it by a relative one) without `--relay-runtime` and is not younger
 *    than the runtime (Windows hands the pid of an ended process out again).
 *    With no runtime of the folder at all (one crashed, and its supervisor
 *    waits to start the next), the one `<serverDir>\server.js` without a
 *    runtime child is the supervisor;
 *  - the session workers: a script under `<serverDir>\` whose name ends in
 *    `-session-worker.mjs`, with `--session-id`;
 *  - what those started (the agent CLIs, a tunnel), by parent pid, never
 *    older than its parent.
 * Paths compare whole and without case, so `D:\oar\b2\server` is not
 * `D:\oar\b\server`, and nothing is matched by a program's name alone.
 *
 * The gap: two relays run from one folder with two data folders share the
 * worker script path, and only the relay's own database tells their workers
 * apart (the CLI reads none). While a runtime of this folder that the lock
 * does not name runs, the workers are therefore left alone and listed
 * (`workersSkipped`); the supervisor and the runtime, which the lock ties
 * to this install, are still stopped. Such a runtime is another relay's
 * only when it was seen beside the one the lock names (`foreign`). With
 * none that the lock names, it may be this relay's own (a runtime starts
 * 1-2 s before it takes the lock, and a lock can be gone): then nothing can
 * be told apart (`unclear`), and nothing is stopped.
 *
 * A process created at or after `before` (when the sweep began) is no
 * leftover: Task Scheduler can start the relay again by itself while the
 * sweep runs (the task restarts on failure), and that one is never ended.
 */

const RUNTIME_FLAG = '--relay-runtime';
const SUPERVISED_FLAG = '--supervised';

/** The kinds in the order they are stopped: the supervisor first, so it starts no new runtime. */
export const RELAY_PROCESS_KINDS = Object.freeze(['supervisor', 'runtime', 'worker', 'descendant']);

function toPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function normalizeProcess(proc) {
  const processId = toPid(proc?.processId ?? proc?.pid);
  if (!processId) return null;
  return {
    processId,
    parentProcessId: toPid(proc?.parentProcessId),
    name: String(proc?.name || ''),
    commandLine: String(proc?.commandLine || ''),
    createdAt: Number(proc?.createdAt) > 0 ? Number(proc.createdAt) : 0,
  };
}

// Node by its image name, or by the program its command line starts with
// where the list gives no name.
function isNodeProcess(proc) {
  const name = proc.name.trim().toLowerCase();
  if (name) return name === 'node.exe' || name === 'node';
  return /^\s*"?(?:[^"]*[\\/])?node(?:\.exe)?"?(\s|$)/i.test(proc.commandLine);
}

// A server.js by any path, relative ones included.
const ANY_SERVER = /(^|[\s"=\\])server\.js([\s"]|$)/;

// Windows paths and command lines: no case, backslashes, no trailing separator.
function windowsKey(value) {
  return String(value || '').replaceAll('/', '\\').toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasFlag(commandLine, flag) {
  return new RegExp(`(^|[\\s"])${escapeRegExp(flag)}([\\s"]|$)`).test(commandLine);
}

/**
 * The matchers for one install's `serverDir`: `runsServer(commandLine)` for
 * its server.js, `runsWorker(commandLine)` for one of its session workers.
 */
function matchersFor(serverDir) {
  const dir = escapeRegExp(windowsKey(serverDir).replace(/\\+$/, ''));
  const start = '(^|[\\s"=])';
  const end = '([\\s"]|$)';
  const server = new RegExp(`${start}${dir}\\\\server\\.js${end}`);
  const worker = new RegExp(`${start}${dir}\\\\[^\\s"]*-session-worker\\.mjs${end}`);
  return {
    runsServer: (commandLine) => server.test(windowsKey(commandLine)),
    runsWorker: (commandLine) => worker.test(windowsKey(commandLine)) && hasFlag(commandLine, '--session-id'),
  };
}

/** Whether two list entries are one process: the same pid, started at the same time. */
export function isSameProcess(left, right) {
  if (!left || !right || left.processId !== right.processId) return false;
  if (left.createdAt > 0 || right.createdAt > 0) return left.createdAt === right.createdAt;
  return left.commandLine === right.commandLine;
}

/**
 * This install's relay processes in `processes` (see the top of the file).
 * `targets` are the ones to stop, in order (RELAY_PROCESS_KINDS), each with
 * its `kind`; none while `unclear`. `workers` are all workers of the folder,
 * stopped only when `workersSkipped` is false; `otherRuntimes` the runtimes
 * of the folder the lock does not name; `foreign` those known to be another
 * relay's. `ownServers` are this install's server.js processes, every one of
 * the folder but another relay's; `candidates` everything of the folder
 * that may be this relay's, each with its `kind`, for a report by hand.
 */
export function findRelayProcesses(processes, { serverDir, lockPid = 0, before = Infinity, foreign = [] } = {}) {
  const { runsServer, runsWorker } = matchersFor(serverDir);
  const list = (Array.isArray(processes) ? processes : [])
    .map(normalizeProcess)
    .filter((proc) => proc && !(proc.createdAt >= before));
  const isRuntime = (proc) => runsServer(proc.commandLine) && (hasFlag(proc.commandLine, RUNTIME_FLAG) || hasFlag(proc.commandLine, SUPERVISED_FLAG));
  const startedRuntime = (parent) => list.some((proc) => proc.parentProcessId === parent.processId && isRuntime(proc) && isChildProcessOf(proc, parent));
  const lockedPid = toPid(lockPid);
  const runtime = list.find((proc) => proc.processId === lockedPid && isRuntime(proc)) || null;
  const parentOfRuntime = runtime && hasFlag(runtime.commandLine, RUNTIME_FLAG)
    ? list.find((proc) => proc.processId === runtime.parentProcessId
      && isNodeProcess(proc)
      && ANY_SERVER.test(windowsKey(proc.commandLine))
      && !hasFlag(proc.commandLine, RUNTIME_FLAG)
      && isChildProcessOf(runtime, proc)) || null
    : null;
  const otherRuntimes = list.filter((proc) => isRuntime(proc) && proc !== runtime);
  const isForeign = (proc) => foreign.some((known) => isSameProcess(known, normalizeProcess(proc)));
  const foreignRuntimes = otherRuntimes.filter(isForeign);
  const unknownRuntimes = otherRuntimes.filter((proc) => !isForeign(proc));
  // Another relay's runtime, or the supervisor that started it.
  const ofForeignRelay = (proc) => foreignRuntimes.some((other) => other === proc
    || (other.parentProcessId === proc.processId && isChildProcessOf(other, proc)));
  const servers = list.filter((proc) => runsServer(proc.commandLine) && !ofForeignRelay(proc));
  const lone = !runtime && !unknownRuntimes.length
    ? servers.filter((proc) => !isRuntime(proc) && !startedRuntime(proc))
    : [];
  const unclear = (!runtime && unknownRuntimes.length > 0) || lone.length > 1;
  const supervisor = parentOfRuntime || (lone.length === 1 ? lone[0] : null);
  const workers = list.filter((proc) => proc !== runtime && proc !== supervisor && runsWorker(proc.commandLine));
  const workersSkipped = otherRuntimes.length > 0;
  const ownServers = [...new Set([supervisor, runtime, ...servers].filter(Boolean))];
  const kindOf = (proc) => (isRuntime(proc) ? 'runtime' : 'supervisor');
  const candidates = [
    ...ownServers.map((proc) => ({ ...proc, kind: kindOf(proc) })),
    ...workers.map((proc) => ({ ...proc, kind: 'worker' })),
  ];
  if (unclear) {
    return { runtime, supervisor: null, workers, otherRuntimes, foreign: foreignRuntimes, workersSkipped, unclear, ownServers, candidates, targets: [] };
  }

  const roots = [supervisor, runtime, ...(workersSkipped ? [] : workers)].filter(Boolean);
  const taken = new Set(roots);
  const descendants = [];
  for (let index = 0; index < roots.length + descendants.length; index += 1) {
    const parent = index < roots.length ? roots[index] : descendants[index - roots.length];
    for (const proc of list) {
      if (taken.has(proc) || proc.parentProcessId !== parent.processId || !isChildProcessOf(proc, parent)) continue;
      // A worker of another relay of this folder is never anyone's descendant here.
      if (workersSkipped && runsWorker(proc.commandLine)) continue;
      taken.add(proc);
      descendants.push(proc);
    }
  }
  const targets = [
    ...(supervisor ? [{ ...supervisor, kind: 'supervisor' }] : []),
    ...(runtime ? [{ ...runtime, kind: 'runtime' }] : []),
    ...(workersSkipped ? [] : workers.map((proc) => ({ ...proc, kind: 'worker' }))),
    ...descendants.map((proc) => ({ ...proc, kind: 'descendant' })),
  ];
  return { runtime, supervisor, workers, otherRuntimes, foreign: foreignRuntimes, workersSkipped, unclear, ownServers, candidates, targets };
}

/** The command that ends one process by hand. */
export function taskkillLine(pid) {
  return `taskkill /PID ${pid} /F`;
}

/**
 * Stops `targets` (from findRelayProcesses) kind by kind, in the order of
 * RELAY_PROCESS_KINDS. Before each kind the list is read again (`list`), and
 * a target is ended (`kill(pid)`) only while the process at its pid is still
 * the same one (isSameProcess): one that ended, and a pid handed to another
 * process meanwhile, are left alone. `{ killed, skipped, failed }`: pids,
 * and `failed` the targets whose kill did not go through (`kill` answered
 * false or `{ ok: false, reason }`), each with its `reason`.
 */
export async function stopRelayProcesses({ targets = [], list, kill } = {}) {
  const killed = [];
  const skipped = [];
  const failed = [];
  for (const kind of RELAY_PROCESS_KINDS) {
    const group = targets.filter((target) => target.kind === kind);
    if (!group.length) continue;
    const now = (await list()).map(normalizeProcess).filter(Boolean);
    for (const target of group) {
      const current = now.find((proc) => proc.processId === target.processId);
      if (!isSameProcess(current, target)) {
        skipped.push(target.processId);
        continue;
      }
      const result = await kill(target.processId);
      if (result === false || result?.ok === false) {
        failed.push({ ...target, reason: String(result?.reason || 'the kill failed') });
        continue;
      }
      killed.push(target.processId);
    }
  }
  return { killed, skipped, failed };
}

/** Which of `targets` still run in a list just read (the same processes, not their pids). */
export function relayProcessesLeft(targets, processes) {
  const now = (Array.isArray(processes) ? processes : []).map(normalizeProcess).filter(Boolean);
  return targets.filter((target) => now.some((proc) => isSameProcess(proc, target)));
}

/**
 * Waits until none of `targets` runs, reading the list every `pollMs`, at
 * most `waitMs`: `{ ok, left }`, `left` the targets still there when the
 * bound was hit.
 */
export async function waitRelayProcessesGone({
  targets = [],
  list,
  waitMs = 30_000,
  pollMs = 300,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    const left = relayProcessesLeft(targets, await list());
    if (!left.length) return { ok: true, left };
    if (now() >= deadline) return { ok: false, left };
    await sleep(pollMs);
  }
}
