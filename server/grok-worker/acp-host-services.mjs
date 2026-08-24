/**
 * Client-side ACP host services for the Grok worker: the `terminal/*` and
 * `fs/*` request handlers backing the client capabilities advertised in
 * `AcpClient.initialize()`.
 *
 * Advertising a capability is a contract to answer the agent's requests for
 * it — an advertised-but-unanswered request deadlocks the agent's turn: it
 * waits forever on the reply, streaming nothing further, while the worker
 * process stays healthy and heartbeating (the 2026-08-12 stall, where a
 * `terminal/create` went unanswered for 9 minutes until the user hit Stop).
 * If a capability is dropped here, drop it from the initialize payload too.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';

const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const MAX_OUTPUT_BYTE_LIMIT = 8 * 1024 * 1024;
// How long a running terminal's silence still counts as "the agent is
// waiting on us" for the prompt watchdog. See hasPendingWork.
const TERMINAL_ACTIVITY_WINDOW_MS = 5 * 60_000;

function envArrayToObject(env) {
  const out = {};
  if (!Array.isArray(env)) return out;
  for (const entry of env) {
    const name = String(entry?.name || '').trim();
    if (name) out[name] = String(entry?.value ?? '');
  }
  return out;
}

export function createAcpHostServices({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  fsImpl = fs,
  dbg = () => {},
} = {}) {
  const terminals = new Map();
  let nextTerminalId = 1;
  let inflightRequests = 0;
  let cachedWindowsShell = '';
  let disposed = false;

  // Grok emits PowerShell-flavored command lines on Windows hosts
  // ("pwd; Get-Location"), so cmd.exe is not an option. Prefer pwsh (7+),
  // fall back to Windows PowerShell.
  function resolveWindowsShell() {
    if (cachedWindowsShell) return cachedWindowsShell;
    try {
      const probe = spawnSyncImpl('pwsh', ['-NoProfile', '-Command', '$null'], {
        windowsHide: true,
        timeout: 10_000,
        stdio: 'ignore',
      });
      cachedWindowsShell = probe && probe.status === 0 ? 'pwsh' : 'powershell';
    } catch {
      cachedWindowsShell = 'powershell';
    }
    return cachedWindowsShell;
  }

  function buildSpawnPlan(command, args) {
    if (Array.isArray(args) && args.length) {
      return { file: command, args: args.map((value) => String(value)) };
    }
    if (platform === 'win32') {
      return {
        file: resolveWindowsShell(),
        args: ['-NoProfile', '-NonInteractive', '-Command', command],
      };
    }
    const shell = String(env.SHELL || '').trim() || '/bin/sh';
    return { file: shell, args: ['-c', command] };
  }

  function appendOutput(entry, chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    entry.lastActivityAt = Date.now();
    entry.chunks.push(buf);
    entry.byteLength += buf.length;
    // ACP truncates from the start of the output: the most recent bytes win.
    while (entry.byteLength > entry.outputByteLimit && entry.chunks.length) {
      const head = entry.chunks[0];
      const excess = entry.byteLength - entry.outputByteLimit;
      if (head.length <= excess) {
        entry.chunks.shift();
        entry.byteLength -= head.length;
      } else {
        entry.chunks[0] = head.subarray(excess);
        entry.byteLength -= excess;
      }
      entry.truncated = true;
    }
  }

  function settleExit(entry, exitStatus) {
    if (entry.exitStatus) return;
    entry.exitStatus = exitStatus;
    for (const resolve of entry.exitWaiters.splice(0)) resolve(exitStatus);
  }

  function getTerminal(terminalId) {
    const entry = terminals.get(String(terminalId || ''));
    if (!entry) throw new Error(`unknown terminalId: ${terminalId}`);
    return entry;
  }

  async function terminalCreate(params = {}) {
    if (disposed) throw new Error('host services disposed');
    const command = String(params.command || '').trim();
    if (!command) throw new Error('terminal/create requires a command');
    const requestedLimit = Number(params.outputByteLimit);
    const outputByteLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.round(requestedLimit), MAX_OUTPUT_BYTE_LIMIT)
      : DEFAULT_OUTPUT_BYTE_LIMIT;
    const plan = buildSpawnPlan(command, params.args);
    const proc = spawnImpl(plan.file, plan.args, {
      cwd: String(params.cwd || '').trim() || cwd,
      env: { ...env, ...envArrayToObject(params.env) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    const terminalId = `term-${nextTerminalId++}`;
    const entry = {
      terminalId,
      proc,
      chunks: [],
      byteLength: 0,
      truncated: false,
      outputByteLimit,
      exitStatus: null,
      exitWaiters: [],
      lastActivityAt: Date.now(),
    };
    proc.stdout?.on('data', (chunk) => appendOutput(entry, chunk));
    proc.stderr?.on('data', (chunk) => appendOutput(entry, chunk));
    proc.on('error', (error) => {
      // Spawn failures (ENOENT etc.) surface as output + a synthetic exit so
      // the agent's wait_for_exit settles instead of hanging.
      appendOutput(entry, `[terminal spawn error] ${error?.message || String(error)}\n`);
      settleExit(entry, { exitCode: -1, signal: null });
    });
    proc.on('exit', (code, signal) => {
      settleExit(entry, {
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
      });
    });
    terminals.set(terminalId, entry);
    dbg('terminal/create', terminalId, command.slice(0, 160));
    return { terminalId };
  }

  function terminalOutput(params = {}) {
    const entry = getTerminal(params.terminalId);
    return {
      output: Buffer.concat(entry.chunks, entry.byteLength).toString('utf8'),
      truncated: entry.truncated,
      ...(entry.exitStatus ? { exitStatus: entry.exitStatus } : {}),
    };
  }

  function terminalWaitForExit(params = {}) {
    const entry = getTerminal(params.terminalId);
    if (entry.exitStatus) return Promise.resolve(entry.exitStatus);
    return new Promise((resolve) => entry.exitWaiters.push(resolve));
  }

  function killEntryProcess(entry) {
    if (!entry.proc || entry.exitStatus) return;
    try {
      entry.proc.kill();
    } catch { /* ignore */ }
    if (platform === 'win32' && entry.proc.pid) {
      // proc.kill() only reaches the shell; shells leave grandchildren behind.
      try {
        spawnImpl('taskkill', ['/pid', String(entry.proc.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch { /* ignore */ }
    }
  }

  function terminalKill(params = {}) {
    killEntryProcess(getTerminal(params.terminalId));
    return null;
  }

  function terminalRelease(params = {}) {
    const entry = terminals.get(String(params?.terminalId || ''));
    if (!entry) return null;
    killEntryProcess(entry);
    terminals.delete(entry.terminalId);
    return null;
  }

  async function fsReadTextFile(params = {}) {
    const filePath = String(params.path || '').trim();
    if (!filePath) throw new Error('fs/read_text_file requires a path');
    const content = await fsImpl.readFile(filePath, 'utf8');
    const line = Number(params.line);
    const limit = Number(params.limit);
    const hasLine = Number.isFinite(line) && line > 0;
    const hasLimit = Number.isFinite(limit) && limit > 0;
    if (!hasLine && !hasLimit) return { content };
    const lines = content.split('\n');
    const start = hasLine ? line - 1 : 0;
    const count = hasLimit ? limit : lines.length - start;
    return { content: lines.slice(start, start + count).join('\n') };
  }

  async function fsWriteTextFile(params = {}) {
    const filePath = String(params.path || '').trim();
    if (!filePath) throw new Error('fs/write_text_file requires a path');
    await fsImpl.writeFile(filePath, String(params.content ?? ''), 'utf8');
    return null;
  }

  const handlers = {
    'terminal/create': terminalCreate,
    'terminal/output': terminalOutput,
    'terminal/wait_for_exit': terminalWaitForExit,
    'terminal/kill': terminalKill,
    'terminal/release': terminalRelease,
    'fs/read_text_file': fsReadTextFile,
    'fs/write_text_file': fsWriteTextFile,
  };

  function attach(client) {
    // wait_for_exit is a passive park, not active servicing: counting it as
    // inflight would defer the stall watchdog forever for a process that
    // never exits. Its pending-ness is represented by the unfinished
    // terminal entry below instead.
    const passiveWaits = new Set(['terminal/wait_for_exit']);
    for (const [method, handler] of Object.entries(handlers)) {
      const passive = passiveWaits.has(method);
      client.setRequestHandler(method, async (params) => {
        if (!passive) inflightRequests += 1;
        try {
          return await handler(params);
        } finally {
          if (!passive) inflightRequests -= 1;
        }
      });
    }
  }

  /**
   * True while the agent is legitimately waiting on us: a handler request is
   * being serviced, or a terminal process is running AND recently active. A
   * long-quiet background command (a dev server, a hung build) stops
   * deferring the stall watchdog after the activity window — otherwise one
   * `npm run dev` made every turn immune to stall detection forever.
   */
  function hasPendingWork() {
    if (inflightRequests > 0) return true;
    const now = Date.now();
    for (const entry of terminals.values()) {
      if (entry.exitStatus) continue;
      if (now - entry.lastActivityAt <= TERMINAL_ACTIVITY_WINDOW_MS) return true;
    }
    return false;
  }

  function disposeAll() {
    disposed = true;
    for (const entry of terminals.values()) killEntryProcess(entry);
    terminals.clear();
  }

  return { attach, hasPendingWork, disposeAll, handlers };
}
