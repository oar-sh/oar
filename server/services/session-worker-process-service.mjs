'use strict';

import { execFile, execFileSync } from 'child_process';
import { readFile } from 'fs/promises';

import { collectProcessDescendants, isChildProcessOf } from '../../shared/worker-runtime/process-tree.mjs';
import { windowsSystemToolPath } from '../../shared/windows-system-tools.mjs';

function normalizeSessionId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSessionIdFromCommandLine(commandLine) {
  const text = String(commandLine || '');
  if (!text) return null;
  const match = text.match(/["']?--(?:session-id|resume)["']?(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"'=]+))/i);
  const value = match?.[1] || match?.[2] || match?.[3] || '';
  return normalizeSessionId(value);
}

function buildSessionArgPattern(targetSessionId, { includeResume = true } = {}) {
  const target = normalizeSessionId(targetSessionId);
  if (!target) return null;
  const argName = includeResume ? 'session-id|resume' : 'session-id';
  return new RegExp(
    `["']?--(?:${argName})["']?(?:=|\\s+)(?:"${escapeRegExp(target)}"|'${escapeRegExp(target)}'|${escapeRegExp(target)})(?:\\s|$)`,
    'i',
  );
}

function scoreWindowsWorkerCandidate(proc) {
  const name = String(proc?.name || '').trim().toLowerCase();
  const cmd = String(proc?.commandLine || '').trim().toLowerCase();
  if (name === 'copilot.exe') return 400;
  if (name === 'gh.exe' && cmd.includes('copilot')) return 300;
  if (cmd.includes('gh copilot')) return 250;
  if (cmd.includes('copilot.cmd') || cmd.includes('copilot-win32')) return 225;
  if (name === 'cmd.exe' || name === 'powershell.exe' || name === 'conhost.exe') return 50;
  return 100;
}

function isWindowsWrapperProcess(proc) {
  const name = String(proc?.name || '').trim().toLowerCase();
  return name === 'cmd.exe' || name === 'powershell.exe' || name === 'conhost.exe';
}

function normalizeWindowsProcess(proc) {
  return {
    processId: Number.isInteger(Number(proc?.processId)) ? Number(proc.processId) : null,
    parentProcessId: Number.isInteger(Number(proc?.parentProcessId)) ? Number(proc.parentProcessId) : null,
    name: String(proc?.name || ''),
    commandLine: String(proc?.commandLine || ''),
    createdAt: Number(proc?.createdAt) > 0 ? Number(proc.createdAt) : 0,
  };
}

// The relay's own session workers: `node <kind>-session-worker.mjs --session-id <id>`.
function isRelaySessionWorker(proc) {
  return String(proc?.commandLine || '').toLowerCase().includes('-session-worker');
}

// Every process with its parent and the time it was created.
//
// The JSON is written to stdout as UTF-8 bytes, not through PowerShell's
// console encoding. Under the OEM code page the relay's console has (437 or
// 850), .NET's best-fit encoder turns characters such as → • ↑ ▲ § into the
// control bytes whose glyphs they are in that code page (0x1A, 0x07, 0x18,
// 0x1E, 0x15), and an agent's command line that carries one of them — a
// `bash -c "echo → next"` — breaks the JSON of the whole list: no worker
// could start on a relay for an hour (2026-10-01).
const WINDOWS_PROCESS_SNAPSHOT_SCRIPT = [
  '$list = Get-CimInstance Win32_Process | ForEach-Object {',
  '  [pscustomobject]@{',
  '    processId = [int]$_.ProcessId;',
  '    parentProcessId = [int]$_.ParentProcessId;',
  '    name = [string]$_.Name;',
  '    commandLine = [string]$_.CommandLine;',
  '    createdAt = $(if ($_.CreationDate) { [int64](($_.CreationDate.ToUniversalTime() - [datetime]"1970-01-01").TotalMilliseconds) } else { [int64]0 });',
  '  }',
  '};',
  '$json = [string]($list | ConvertTo-Json -Depth 3 -Compress);',
  '$bytes = [System.Text.Encoding]::UTF8.GetBytes($json);',
  '$stdout = [Console]::OpenStandardOutput();',
  '$stdout.Write($bytes, 0, $bytes.Length);',
  '$stdout.Flush()',
].join(' ');

/** How long the process list may take when a worker waits for it. */
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;

// The list of every process with its full command line; 150 KB on a busy
// desktop. Node's default of 1 MiB would end the read with ENOBUFS.
const WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER = 64 * 1024 * 1024;

export const WINDOWS_PROCESS_SNAPSHOT_UNREADABLE = 'windows-process-snapshot-unreadable';

// Callers that arrive within this window after a read share its result; the
// launch pid poll asks for a fresh one (it waits for a process that did not
// exist a moment ago). Reading the list costs a PowerShell start (0.5-1.5 s
// idle, seconds under load); a burst of launches or kills must not pay it
// once per caller.
const SNAPSHOT_CACHE_MS = 1_500;
// A read slower than this is logged: the box is loaded, and every launch and
// kill waits for it.
const SLOW_READ_MS = 2_000;
// Stop-Process over a whole tree; generous, so a loaded box is not told
// "not stopped" while PowerShell still works.
const WINDOWS_STOP_TIMEOUT_MS = 30_000;
// How long a POSIX `ps` (the process list, one process's identity) may run.
const PS_TIMEOUT_MS = 5_000;

function parsePosixProcessSnapshot(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => {
      const match = String(line || '').match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        processId: Number.parseInt(match[1], 10),
        parentProcessId: Number.parseInt(match[2], 10),
        name: String(match[3] || ''),
        commandLine: String(match[4] || ''),
      };
    })
    .filter(Boolean);
}

function sortWindowsCandidates(list) {
  return list.sort((left, right) => {
    const scoreDelta = scoreWindowsWorkerCandidate(right) - scoreWindowsWorkerCandidate(left);
    if (scoreDelta !== 0) return scoreDelta;
    return Number(right.processId || 0) - Number(left.processId || 0);
  });
}

function isWindowsSessionMatch(proc, target, targetPattern) {
  if (!proc?.processId) return false;
  if (!looksLikeCopilotWorkerProcess(proc)) return false;
  const parsedSessionId = parseSessionIdFromCommandLine(proc.commandLine);
  if (parsedSessionId) return parsedSessionId === target;
  return Boolean(targetPattern?.test(proc.commandLine));
}

// ─── Matchers over a snapshot that is already read ───────────────────────────
// Shared by the synchronous finders (the legacy extension launcher) and the
// asynchronous ones (everything else), so both see the same processes.

/** The session's worker candidates on win32, best first (wrappers last). */
export function selectWindowsProcessesForSession(snapshot, targetSessionId) {
  const target = normalizeSessionId(targetSessionId);
  if (!target) return [];
  const targetPattern = buildSessionArgPattern(target, { includeResume: false });
  return sortWindowsCandidates(
    (Array.isArray(snapshot) ? snapshot : [])
      .map(normalizeWindowsProcess)
      .filter((proc) => proc.processId)
      .filter((proc) => isWindowsSessionMatch(proc, target, targetPattern)),
  );
}

/** The session's processes on win32 with their descendants and wrapper ancestors: what a kill must stop. */
export function selectWindowsProcessTreeForSession(snapshot, targetSessionId) {
  const target = normalizeSessionId(targetSessionId);
  if (!target) return [];
  const targetPattern = buildSessionArgPattern(target, { includeResume: false });
  const processes = (Array.isArray(snapshot) ? snapshot : [])
    .map(normalizeWindowsProcess)
    .filter((proc) => proc.processId);
  const byPid = new Map(processes.map((proc) => [proc.processId, proc]));

  const related = new Map();
  const addProcess = (proc) => {
    if (proc?.processId) related.set(proc.processId, proc);
  };
  const addDescendants = (proc) => {
    const found = collectProcessDescendants(processes, proc, {
      accept: (child) => {
        if (related.has(child.processId)) return false;
        // The worker of another session is never part of this one's tree.
        return !(isRelaySessionWorker(child) && !isWindowsSessionMatch(child, target, targetPattern));
      },
    });
    for (const child of found) addProcess(child);
  };
  const addWrapperAncestors = (proc) => {
    let current = proc;
    const seen = new Set();
    while (current?.parentProcessId && !seen.has(current.parentProcessId)) {
      seen.add(current.parentProcessId);
      const parent = byPid.get(current.parentProcessId);
      if (!parent || !isWindowsWrapperProcess(parent)) return;
      // Windows hands a pid out again: see `isChildProcessOf`.
      if (!isChildProcessOf(current, parent)) return;
      addProcess(parent);
      current = parent;
    }
  };

  for (const proc of processes.filter((candidate) => isWindowsSessionMatch(candidate, target, targetPattern))) {
    addProcess(proc);
    addDescendants(proc);
    addWrapperAncestors(proc);
  }

  return sortWindowsCandidates(Array.from(related.values()));
}

/** The session's processes on POSIX (the tmux pane's children carry the id too). */
export function selectPosixProcessesForSession(snapshot, targetSessionId) {
  const target = normalizeSessionId(targetSessionId);
  if (!target) return [];
  const targetPattern = buildSessionArgPattern(target, { includeResume: true });
  return (Array.isArray(snapshot) ? snapshot : [])
    .map((proc) => ({
      processId: Number.isInteger(Number(proc?.processId)) ? Number(proc.processId) : null,
      parentProcessId: Number.isInteger(Number(proc?.parentProcessId)) ? Number(proc.parentProcessId) : null,
      name: String(proc?.name || ''),
      commandLine: String(proc?.commandLine || ''),
    }))
    .filter((proc) => proc.processId)
    .filter((proc) => looksLikeCopilotWorkerProcess(proc))
    .filter((proc) => {
      const parsedSessionId = parseSessionIdFromCommandLine(proc.commandLine);
      if (parsedSessionId) return parsedSessionId === target;
      return targetPattern?.test(proc.commandLine);
    });
}

function firstNonWrapper(candidates) {
  return candidates.find((proc) => !isWindowsWrapperProcess(proc)) || null;
}


export function parseWindowsProcessSnapshot(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // A raw control character inside a string (an encoding that is not the
    // UTF-8 the script writes, or a PowerShell that is not 5.1) is blanked
    // and the list read once more: a command line matters here only for the
    // session id and the worker markers it carries.
    try {
      parsed = JSON.parse(text.replace(/[\x00-\x1f]/g, ' '));
    } catch {
      throw new SyntaxError(`${WINDOWS_PROCESS_SNAPSHOT_UNREADABLE}: ${String(error?.message || error)}`);
    }
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function looksLikeCopilotWorkerProcess(proc) {
  const name = String(proc?.name || '').trim().toLowerCase();
  const cmd = String(proc?.commandLine || '').trim().toLowerCase();
  if (!name && !cmd) return false;
  if (cmd.includes('\\server\\server.js') || cmd.includes('/server/server.js')) return false;
  // A tmux process is never a worker. The shared tmux server keeps the argv of
  // whichever `tmux new-session -d -s <session-id> ...` first started it, so a
  // session-id scan would otherwise match the server itself — and killing it
  // tears down every tmux-hosted worker on the socket, not just the target
  // session. (The server's comm is "tmux: server", which the ps parser splits
  // into name "tmux:" with the command line shifted to start with "server".)
  if (name === 'tmux' || name.startsWith('tmux:')) return false;
  if (/^(?:server\s+)?tmux(?:\s|$)/.test(cmd)) return false;
  if (name === 'copilot.exe') return true;
  if (name === 'gh.exe' && cmd.includes('gh') && cmd.includes('copilot')) return true;
  if (cmd.includes('gh copilot')) return true;
  // Every node worker's entry script is named `<kind>-session-worker.mjs` and
  // is invoked as `node <script> --session-id <id>` — none of the CLI markers
  // below (no `--allow-all`, no `@github/copilot` path) appear on their command
  // lines, so a worker missing from this check is invisible to discovery: the
  // kill route no-ops and process reuse spawns a duplicate every turn. That is
  // exactly what happened to `grok-session-worker`, which the per-worker list
  // this replaces never named.
  //
  // Matching the naming convention instead of four literals means a new node
  // worker is discoverable the moment it exists. The tmux exclusions above
  // still run first, so the shared tmux server cannot be adopted through this
  // arm by carrying a worker's argv.
  if (cmd.includes('-session-worker')) return true;
  return cmd.includes('copilot.cmd')
    || cmd.includes('copilot-win32')
    || cmd.includes('@github\\copilot')
    || cmd.includes('@aykahshi/copilot-mcp-server')
    || cmd.includes('--allow-all')
    || cmd.includes('--resume');
}

// ─── Process identity ────────────────────────────────────────────────────────
// A pid alone does not name a process: once one ends, its pid is handed out
// again (on Windows within seconds). A process is its pid and the time it
// started, so a worker a stop ended is never taken for the process that got
// its pid next, and a process that only has a worker's old pid is never
// stopped or blamed as that worker.

/** Field 22 of /proc/<pid>/stat (starttime, clock ticks since boot), or null. */
export function parseProcStatStartTime(text) {
  const value = String(text || '');
  // The command name (field 2) is in parentheses and may hold spaces and
  // parentheses itself: the fields after it start after the last ')'.
  const end = value.lastIndexOf(')');
  if (end < 0) return null;
  const rest = value.slice(end + 1).trim().split(/\s+/);
  const startTime = rest[22 - 3];
  return /^\d+$/.test(String(startTime || '')) ? startTime : null;
}

/** `ps -o lstart= -o args=` of one process: { startTime, commandLine }, or null. */
export function parsePsStartAndArgs(output) {
  const line = String(output || '').split(/\r?\n/).find((entry) => entry.trim());
  if (!line) return null;
  // lstart is five fields under LC_ALL=C: `Thu Nov 12 10:00:00 2026`.
  const match = line.match(/^\s*(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)(?:\s+(.*))?$/);
  if (!match) return { startTime: null, commandLine: null };
  return { startTime: match[1].replace(/\s+/g, ' '), commandLine: String(match[2] || '').trim() };
}

function isMissingProcessError(error) {
  const code = String(error?.code || '').toUpperCase();
  return code === 'ENOENT' || code === 'ESRCH';
}

/**
 * Reads what a process is: `identityOf(pid, { fresh })` resolves to
 * `{ pid, startTime, commandLine }`, or null when no process has the pid.
 * Never rejects; what could not be read is null (`startTime` and
 * `commandLine` both null: nothing is known about the process).
 *
 * `startTime` is compared for equality only, never across platforms:
 * - Linux and Android (Termux): field 22 of /proc/<pid>/stat, clock ticks
 *   since boot; the command line from /proc/<pid>/cmdline.
 * - Windows: the process list's `createdAt` (ms since 1970), read through
 *   `readProcessSnapshot({ fresh })` (the inspector's shared, cached read).
 * - macOS and the other POSIX systems: `ps -o lstart= -o args= -p <pid>`.
 */
export function createProcessIdentityReader({
  platform = process.platform,
  readFileImpl = (file) => readFile(file, 'utf8'),
  execFileImpl = execFile,
  readProcessSnapshot = null,
} = {}) {
  const unknown = (pid) => ({ pid, startTime: null, commandLine: null });

  async function fromProc(pid) {
    let stat;
    try {
      stat = String(await readFileImpl(`/proc/${pid}/stat`));
    } catch (error) {
      return isMissingProcessError(error) ? null : unknown(pid);
    }
    let commandLine = null;
    try {
      commandLine = String(await readFileImpl(`/proc/${pid}/cmdline`)).split('\0').filter(Boolean).join(' ');
    } catch (error) {
      if (isMissingProcessError(error)) return null;
    }
    return { pid, startTime: parseProcStatStartTime(stat), commandLine };
  }

  function fromPs(pid) {
    return new Promise((resolve) => {
      try {
        execFileImpl(
          'ps',
          ['-ww', '-o', 'lstart=', '-o', 'args=', '-p', String(pid)],
          // A ps that hangs (a stuck process table read) must not hold the
          // recycle or the stop: an answer that never comes is unknown.
          { env: { ...process.env, LC_ALL: 'C' }, timeout: PS_TIMEOUT_MS },
          (error, stdout) => {
            const parsed = parsePsStartAndArgs(stdout);
            // ps exits with 1 and prints nothing for a pid no process has.
            if (!parsed) resolve(error && Number(error.code) === 1 ? null : unknown(pid));
            else resolve({ pid, ...parsed });
          },
        );
      } catch {
        resolve(unknown(pid));
      }
    });
  }

  async function fromSnapshot(pid, fresh) {
    if (typeof readProcessSnapshot !== 'function') return unknown(pid);
    let snapshot;
    try {
      snapshot = await readProcessSnapshot({ fresh });
    } catch {
      return unknown(pid);
    }
    const found = (Array.isArray(snapshot) ? snapshot : [])
      .map(normalizeWindowsProcess)
      .find((proc) => proc.processId === pid);
    if (!found) return null;
    return { pid, startTime: found.createdAt > 0 ? String(found.createdAt) : null, commandLine: found.commandLine };
  }

  return async function identityOf(value, { fresh = false } = {}) {
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      if (platform === 'win32') return await fromSnapshot(pid, fresh);
      if (platform === 'linux' || platform === 'android') return await fromProc(pid);
      return await fromPs(pid);
    } catch {
      return unknown(pid);
    }
  };
}

/** Whether two identities are known to be one process: same pid, same start time. */
export function isSameProcess(left, right) {
  return Boolean(left && right && left.pid === right.pid && left.startTime && left.startTime === right.startTime);
}

/**
 * What the process now at a session worker's pid is, from its identity
 * (`current`, createProcessIdentityReader) and the one read before
 * (`before`, optional):
 * - 'gone': no process has the pid;
 * - 'other': another process (another start time, or a command line that
 *   does not name the session: a pid handed out again, a zombie);
 * - 'ours': a process of the session, whose command line names it;
 * - 'unverified': nothing could be read about it.
 */
export function judgeSessionWorkerProcess(current, { sdkSessionId, before = null } = {}) {
  if (!current) return 'gone';
  if (before?.startTime && current.startTime && before.startTime !== current.startTime) return 'other';
  if (typeof current.commandLine === 'string') {
    const target = normalizeSessionId(sdkSessionId);
    return target && parseSessionIdFromCommandLine(current.commandLine) === target ? 'ours' : 'other';
  }
  return 'unverified';
}

/**
 * Whether a launch may reuse the process a process-list row names for a
 * session (`row`, from a fresh read), by what is at its pid now (`current`,
 * identityOfListedWorker: read after the row, or on Windows the row itself):
 * a listed process can end and its pid go to another process in between.
 * Reused only when the process there is the session's ('ours': its command
 * line names the session and, where the row has one (Windows' createdAt),
 * its start time is the row's).
 * When nothing can be read about it ('unverified'), a process that runs
 * (`isAlive(pid)`) is reused: a second launch beside it could give the
 * session two workers.
 */
export function mayReuseSessionWorkerRow({ row, current, sdkSessionId, isAlive = () => false } = {}) {
  const pid = Number(row?.processId);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (current && current.pid !== pid) return false;
  const createdAt = Number(row?.createdAt);
  const before = createdAt > 0 ? { pid, startTime: String(createdAt) } : null;
  const verdict = judgeSessionWorkerProcess(current, { sdkSessionId, before });
  if (verdict === 'ours') return true;
  if (verdict !== 'unverified') return false;
  try {
    return isAlive(pid) === true;
  } catch {
    return false;
  }
}

/**
 * What the process a fresh process-list row names is, for
 * mayReuseSessionWorkerRow (`current`). On Windows the row is the identity:
 * it comes from a read of the whole list that began after the caller, with
 * the process's start time (`createdAt`) and command line, and a second read
 * would tell no more, only later. Elsewhere the row has no start time, and
 * `identityOf(pid, { fresh: true })` (createProcessIdentityReader) is asked;
 * what it cannot read is unknown.
 */
export async function identityOfListedWorker(row, { platform = process.platform, identityOf = null } = {}) {
  const pid = Number(row?.processId);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const unknown = { pid, startTime: null, commandLine: null };
  if (platform === 'win32') {
    const createdAt = Number(row?.createdAt);
    return {
      pid,
      startTime: createdAt > 0 ? String(createdAt) : null,
      commandLine: typeof row?.commandLine === 'string' ? row.commandLine : null,
    };
  }
  if (typeof identityOf !== 'function') return unknown;
  try {
    return await identityOf(pid, { fresh: true });
  } catch {
    return unknown;
  }
}

export function createSessionWorkerProcessInspector({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  execFileImpl = execFile,
  // Where Windows keeps PowerShell (the bare name when it is not there).
  systemToolPath = windowsSystemToolPath,
  now = () => Date.now(),
  snapshotCacheMs = SNAPSHOT_CACHE_MS,
  slowReadMs = SLOW_READ_MS,
  logger = null,
} = {}) {
  const cacheMs = Math.max(0, Number(snapshotCacheMs) || 0);
  const slowMs = Math.max(0, Number(slowReadMs) || 0);

  // ─── Synchronous readers ──────────────────────────────────────────────────
  // They hold the relay's thread for the whole PowerShell run (0.5-1.5 s idle,
  // seconds under load) and stay only for the legacy extension launcher
  // (relay-cli-launcher-service.mjs), which goes with the extension. Every
  // other caller uses the asynchronous finders below.

  function getPosixProcessSnapshot() {
    if (platform === 'win32') return [];
    const output = execFileSyncImpl('ps', ['-eo', 'pid=,ppid=,comm=,args=', '-ww'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parsePosixProcessSnapshot(output);
  }

  function getWindowsProcessSnapshot() {
    if (platform !== 'win32') return [];
    const output = execFileSyncImpl(systemToolPath('powershell.exe'), ['-NoProfile', '-Command', WINDOWS_PROCESS_SNAPSHOT_SCRIPT], {
      // stderr is kept (not shown): a failed read reports it.
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER,
    });
    return parseWindowsProcessSnapshot(output);
  }

  function findWindowsProcessesForSession(targetSessionId) {
    if (platform !== 'win32' || !normalizeSessionId(targetSessionId)) return [];
    return selectWindowsProcessesForSession(getWindowsProcessSnapshot(), targetSessionId);
  }

  function findWindowsProcessForSession(targetSessionId) {
    return firstNonWrapper(findWindowsProcessesForSession(targetSessionId));
  }

  function findWindowsProcessTreeForSession(targetSessionId) {
    if (platform !== 'win32' || !normalizeSessionId(targetSessionId)) return [];
    return selectWindowsProcessTreeForSession(getWindowsProcessSnapshot(), targetSessionId);
  }

  function findPosixProcessesForSession(targetSessionId) {
    if (platform === 'win32' || !normalizeSessionId(targetSessionId)) return [];
    return selectPosixProcessesForSession(getPosixProcessSnapshot(), targetSessionId);
  }

  function findPosixProcessForSession(targetSessionId) {
    return findPosixProcessesForSession(targetSessionId)[0] || null;
  }

  function findProcessesForSession(targetSessionId) {
    return platform === 'win32'
      ? findWindowsProcessesForSession(targetSessionId)
      : findPosixProcessesForSession(targetSessionId);
  }

  function findProcessForSession(targetSessionId) {
    return platform === 'win32'
      ? findWindowsProcessForSession(targetSessionId)
      : findPosixProcessForSession(targetSessionId);
  }

  // ─── Asynchronous readers ─────────────────────────────────────────────────

  /**
   * The win32 list without holding the caller's thread for it: a session
   * worker reads it while it serves a conversation, and PowerShell takes about
   * a second to start. Rejects when the list could not be read. Raw: no
   * dedupe, no cache (see readProcessSnapshot for those).
   */
  function readWindowsProcessSnapshot() {
    if (platform !== 'win32') return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      execFileImpl(
        systemToolPath('powershell.exe'),
        ['-NoProfile', '-Command', WINDOWS_PROCESS_SNAPSHOT_SCRIPT],
        { windowsHide: true, timeout: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS, maxBuffer: WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error) {
            // A failed read reports what PowerShell said.
            if (stderr && error.stderr === undefined) error.stderr = stderr;
            reject(error);
            return;
          }
          try {
            resolve(parseWindowsProcessSnapshot(stdout).map(normalizeWindowsProcess).filter((proc) => proc.processId));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    });
  }

  function readPosixProcessSnapshot() {
    if (platform === 'win32') return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      execFileImpl(
        'ps',
        ['-eo', 'pid=,ppid=,comm=,args=', '-ww'],
        { maxBuffer: WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER, timeout: PS_TIMEOUT_MS },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            resolve(parsePosixProcessSnapshot(stdout));
          } catch (parseError) {
            reject(parseError);
          }
        },
      );
    });
  }

  // Callers that arrive while a read runs share it, and callers within the
  // cache window after it share its result, unless they ask for a read that
  // began after them (`fresh`, `notBefore`). Those wait for the next read,
  // which begins once the running one ends and is shared by everyone who
  // asks before it begins: one read at a time (on Windows a CIM query of
  // seconds), however many fresh callers come. What the last read did is
  // kept for /api/status and the log.
  // The read started last: `{ promise, startedAtMs }`.
  let inFlightRead = null;
  // The read that begins once inFlightRead ends: `{ promise }`, or null.
  let nextRead = null;
  // `{ atMs, startedAtMs, processes }` of the read that started last among
  // those that finished.
  let cachedSnapshot = null;
  let lastRead = { at: null, durationMs: null, processes: null, error: null };

  function recordRead({ startedAtMs, processes = null, error = null }) {
    const durationMs = Math.max(0, now() - startedAtMs);
    lastRead = {
      at: new Date(now()).toISOString(),
      durationMs,
      processes: Array.isArray(processes) ? processes.length : null,
      error: error ? String(error?.message || error) : null,
    };
    if (slowMs > 0 && durationMs >= slowMs) {
      try { logger?.warn?.(`process list: the read took ${durationMs} ms${Array.isArray(processes) ? ` for ${processes.length} processes` : ''}${error ? ` and failed: ${lastRead.error}` : ''}`); } catch {}
    }
  }

  function startRead() {
    const startedAtMs = now();
    const read = platform === 'win32' ? readWindowsProcessSnapshot() : readPosixProcessSnapshot();
    const entry = { startedAtMs, promise: null };
    entry.promise = read.then(
      (processes) => {
        if (!cachedSnapshot || cachedSnapshot.startedAtMs <= startedAtMs) {
          cachedSnapshot = { atMs: now(), startedAtMs, processes };
        }
        recordRead({ startedAtMs, processes });
        return processes;
      },
      (error) => {
        recordRead({ startedAtMs, error });
        throw error;
      },
    ).finally(() => {
      if (inFlightRead === entry) inFlightRead = null;
    });
    inFlightRead = entry;
    return entry.promise;
  }

  /**
   * The process list, read off the thread. Rejects when the list could not be
   * read.
   *
   * - `fresh: true`: a read that begins after the caller (`notBefore` is the
   *   time of the call). A read already running began before the caller,
   *   possibly before a stop or a spawn the caller has just seen through, and
   *   can name a process that is gone (or miss one that is new).
   * - `notBefore` (epoch ms, a time already past): the cache or a running
   *   read is used only when that read began after this time; else the
   *   caller waits for the next read.
   * - neither: the cache within its window, else a running read, else a new
   *   one.
   *
   * A read that began in the same millisecond as `notBefore` may have begun
   * before it, and is not used. The next read is: it begins after the call.
   */
  function readProcessSnapshot({ fresh = false, notBefore = null } = {}) {
    const calledAtMs = now();
    const since = fresh
      ? calledAtMs
      : (notBefore === null || notBefore === undefined ? NaN : Number(notBefore));
    const startedLateEnough = (startedAtMs) => !Number.isFinite(since) || startedAtMs > since;
    if (cachedSnapshot && cacheMs > 0 && calledAtMs - cachedSnapshot.atMs <= cacheMs && startedLateEnough(cachedSnapshot.startedAtMs)) {
      return Promise.resolve(cachedSnapshot.processes);
    }
    if (inFlightRead && startedLateEnough(inFlightRead.startedAtMs)) return inFlightRead.promise;
    if (nextRead) return nextRead.promise;
    if (!inFlightRead) return startRead();
    // A read runs that began too early for this caller: the next one, after it.
    const running = inFlightRead.promise.then(() => {}, () => {});
    const entry = { promise: null };
    entry.promise = running.then(() => {
      if (nextRead === entry) nextRead = null;
      return startRead();
    });
    nextRead = entry;
    return entry.promise;
  }

  function getLastRead() {
    return { ...lastRead };
  }

  async function findProcessesForSessionAsync(targetSessionId, options = {}) {
    if (!normalizeSessionId(targetSessionId)) return [];
    const snapshot = await readProcessSnapshot(options);
    return platform === 'win32'
      ? selectWindowsProcessesForSession(snapshot, targetSessionId)
      : selectPosixProcessesForSession(snapshot, targetSessionId);
  }

  async function findProcessForSessionAsync(targetSessionId, options = {}) {
    const candidates = await findProcessesForSessionAsync(targetSessionId, options);
    return platform === 'win32' ? firstNonWrapper(candidates) : (candidates[0] || null);
  }

  async function findWindowsProcessTreeForSessionAsync(targetSessionId, options = {}) {
    if (platform !== 'win32' || !normalizeSessionId(targetSessionId)) return [];
    return selectWindowsProcessTreeForSession(await readProcessSnapshot(options), targetSessionId);
  }

  function parsePositiveInt(value) {
    const num = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(num) && num > 0 ? num : null;
  }

  function buildStopWindowsPidsScript(ids) {
    return [
      '$ErrorActionPreference = "Continue"',
      '$ids = @(' + ids.join(',') + ')',
      'try {',
      // A child is a process started after its parent: the pid of an ended
      // process is handed out again, and the worker of another session must
      // not be taken for a child because of it.
      '  $snapshot = @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ processId = [int]$_.ProcessId; parentProcessId = [int]$_.ParentProcessId; createdAt = $(if ($_.CreationDate) { [int64](($_.CreationDate.ToUniversalTime() - [datetime]"1970-01-01").TotalMilliseconds) } else { [int64]0 }); worker = ([string]$_.CommandLine -like "*-session-worker*") } })',
      '} catch {',
      '  Write-Error $_',
      '  exit 2',
      '}',
      '$targets = [System.Collections.Generic.HashSet[int]]::new()',
      'foreach ($id in $ids) { [void]$targets.Add([int]$id) }',
      '$createdAt = @{}',
      'foreach ($proc in $snapshot) { $createdAt[[int]$proc.processId] = [int64]$proc.createdAt }',
      '$changed = $true',
      'while ($changed) {',
      '  $changed = $false',
      '  foreach ($proc in $snapshot) {',
      '    if ($targets.Contains([int]$proc.parentProcessId) -and -not $targets.Contains([int]$proc.processId)) {',
      '      if ($proc.worker) { continue }',
      '      $parentCreatedAt = [int64]$createdAt[[int]$proc.parentProcessId]',
      '      if ($parentCreatedAt -gt 0 -and [int64]$proc.createdAt -gt 0 -and [int64]$proc.createdAt -lt $parentCreatedAt) { continue }',
      '      [void]$targets.Add([int]$proc.processId)',
      '      $changed = $true',
      '    }',
      '  }',
      '}',
      '$ordered = @($snapshot | Where-Object { $targets.Contains([int]$_.processId) } | Sort-Object parentProcessId -Descending | ForEach-Object { [int]$_.processId })',
      '$seen = [System.Collections.Generic.HashSet[int]]::new()',
      '$ids = @($ordered + $ids | Where-Object { $seen.Add([int]$_) })',
      'foreach ($id in $ids) {',
      '  try { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } catch {}',
      '}',
      'exit 0',
    ].join('; ');
  }

  function uniquePids(pids) {
    return Array.from(new Set(
      (Array.isArray(pids) ? pids : [pids])
        .map((value) => parsePositiveInt(value))
        .filter(Boolean),
    ));
  }

  function stopWindowsPids(pids) {
    const ids = uniquePids(pids);
    if (!ids.length) return [];
    execFileSyncImpl(systemToolPath('powershell.exe'), ['-NoProfile', '-Command', buildStopWindowsPidsScript(ids)], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return ids;
  }

  /** stopWindowsPids off the thread. Resolves to the pids asked for; rejects when PowerShell failed or timed out. */
  function stopWindowsPidsAsync(pids) {
    const ids = uniquePids(pids);
    if (!ids.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      execFileImpl(
        systemToolPath('powershell.exe'),
        ['-NoProfile', '-Command', buildStopWindowsPidsScript(ids)],
        { windowsHide: true, timeout: WINDOWS_STOP_TIMEOUT_MS, maxBuffer: WINDOWS_PROCESS_SNAPSHOT_MAX_BUFFER },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(ids);
        },
      );
    });
  }

  return {
    normalizeSessionId,
    parseSessionIdFromCommandLine,
    findProcessForSession,
    findProcessesForSession,
    findPosixProcessForSession,
    findPosixProcessesForSession,
    getPosixProcessSnapshot,
    findWindowsProcessesForSession,
    findWindowsProcessForSession,
    findWindowsProcessTreeForSession,
    getWindowsProcessSnapshot,
    readWindowsProcessSnapshot,
    readProcessSnapshot,
    getLastRead,
    findProcessForSessionAsync,
    findProcessesForSessionAsync,
    findWindowsProcessTreeForSessionAsync,
    stopWindowsPids,
    stopWindowsPidsAsync,
  };
}
