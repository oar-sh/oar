'use strict';

import { execFile, execFileSync } from 'child_process';

import { collectProcessDescendants, isChildProcessOf } from '../../shared/worker-runtime/process-tree.mjs';

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
  '$list | ConvertTo-Json -Depth 3 -Compress',
].join(' ');

/** How long the process list may take when a worker waits for it. */
const WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;

function parseWindowsProcessSnapshot(output) {
  const text = String(output || '').trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
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

export function createSessionWorkerProcessInspector({
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  execFileImpl = execFile,
} = {}) {
  function getPosixProcessSnapshot() {
    if (platform === 'win32') return [];
    const output = execFileSyncImpl('ps', ['-eo', 'pid=,ppid=,comm=,args=', '-ww'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
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

  function getWindowsProcessSnapshot() {
    if (platform !== 'win32') return [];
    const output = execFileSyncImpl('powershell.exe', ['-NoProfile', '-Command', WINDOWS_PROCESS_SNAPSHOT_SCRIPT], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseWindowsProcessSnapshot(output);
  }

  /**
   * The same list without holding the caller's thread for it: a session
   * worker reads it while it serves a conversation, and PowerShell takes about
   * a second to start. Rejects when the list could not be read.
   */
  function readWindowsProcessSnapshot() {
    if (platform !== 'win32') return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      execFileImpl(
        'powershell.exe',
        ['-NoProfile', '-Command', WINDOWS_PROCESS_SNAPSHOT_SCRIPT],
        { windowsHide: true, timeout: WINDOWS_PROCESS_SNAPSHOT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
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

  function isWindowsSessionMatch(proc, target, targetPattern) {
    if (!proc?.processId) return false;
    if (!looksLikeCopilotWorkerProcess(proc)) return false;
    const parsedSessionId = parseSessionIdFromCommandLine(proc.commandLine);
    if (parsedSessionId) return parsedSessionId === target;
    return Boolean(targetPattern?.test(proc.commandLine));
  }

  function findWindowsProcessesForSession(targetSessionId) {
    const target = normalizeSessionId(targetSessionId);
    if (platform !== 'win32' || !target) return [];
    const targetPattern = buildSessionArgPattern(target, { includeResume: false });
    return getWindowsProcessSnapshot()
      .map(normalizeWindowsProcess)
      .filter((proc) => proc.processId)
      .filter((proc) => isWindowsSessionMatch(proc, target, targetPattern))
      .sort((left, right) => {
        const scoreDelta = scoreWindowsWorkerCandidate(right) - scoreWindowsWorkerCandidate(left);
        if (scoreDelta !== 0) return scoreDelta;
        return Number(right.processId || 0) - Number(left.processId || 0);
      });
  }

  function findWindowsProcessForSession(targetSessionId) {
    const candidates = findWindowsProcessesForSession(targetSessionId);
    return candidates.find((proc) => !isWindowsWrapperProcess(proc)) || null;
  }

  function findWindowsProcessTreeForSession(targetSessionId) {
    const target = normalizeSessionId(targetSessionId);
    if (platform !== 'win32' || !target) return [];
    const targetPattern = buildSessionArgPattern(target, { includeResume: false });
    const snapshot = getWindowsProcessSnapshot()
      .map(normalizeWindowsProcess)
      .filter((proc) => proc.processId);
    const byPid = new Map(snapshot.map((proc) => [proc.processId, proc]));

    const related = new Map();
    const addProcess = (proc) => {
      if (proc?.processId) related.set(proc.processId, proc);
    };
    const addDescendants = (proc) => {
      const found = collectProcessDescendants(snapshot, proc, {
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

    for (const proc of snapshot.filter((candidate) => isWindowsSessionMatch(candidate, target, targetPattern))) {
      addProcess(proc);
      addDescendants(proc);
      addWrapperAncestors(proc);
    }

    return Array.from(related.values()).sort((left, right) => {
      const scoreDelta = scoreWindowsWorkerCandidate(right) - scoreWindowsWorkerCandidate(left);
      if (scoreDelta !== 0) return scoreDelta;
      return Number(right.processId || 0) - Number(left.processId || 0);
    });
  }

  function findPosixProcessesForSession(targetSessionId) {
    const target = normalizeSessionId(targetSessionId);
    if (platform === 'win32' || !target) return [];
    const targetPattern = buildSessionArgPattern(target, { includeResume: true });
    return getPosixProcessSnapshot()
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

  function findPosixProcessForSession(targetSessionId) {
    return findPosixProcessesForSession(targetSessionId)[0] || null;
  }

  function parsePositiveInt(value) {
    const num = Number.parseInt(String(value || ''), 10);
    return Number.isInteger(num) && num > 0 ? num : null;
  }

  function stopWindowsPids(pids) {
    const ids = Array.from(new Set(
      (Array.isArray(pids) ? pids : [pids])
        .map((value) => parsePositiveInt(value))
        .filter(Boolean),
    ));
    if (!ids.length) return [];
    const script = [
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
    execFileSyncImpl('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return ids;
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
    stopWindowsPids,
  };
}
