import { spawn } from 'child_process';
import path from 'path';
import { RELAY_RESTART_EXIT_CODE } from './relay-exit-codes.mjs';

// Role selection travels on argv, never in the environment. The runtime's env is
// inherited by tmux worker sessions and by the Copilot CLI it launches, and the
// CLI extension spawns the next server from that same env — so an env-based role
// flag silently decided the role of unrelated future servers.
export const RELAY_RUNTIME_FLAG = '--relay-runtime';
export const RELAY_SUPERVISED_FLAG = '--supervised';

function hasFlag(argv, flag) {
  return Array.isArray(argv) && argv.includes(flag);
}

/** True for the child this supervisor spawned: run the runtime in-process. */
export function isRelayRuntimeInvocation(argv = process.argv.slice(2)) {
  return hasFlag(argv, RELAY_RUNTIME_FLAG);
}

/** True when an outer supervisor owns restarts and wants the runtime here. */
export function isExternallySupervised(argv = process.argv.slice(2)) {
  return hasFlag(argv, RELAY_SUPERVISED_FLAG);
}

export function spawnRelayRuntime({
  env = process.env,
  cwd = process.cwd(),
  scriptPath,
  args = [],
  execArgv = process.execArgv,
  spawnImpl = spawn,
  stdio = ['ignore', 'pipe', 'pipe'],
  detached = false,
  windowsHide = true,
  logger = console,
} = {}) {
  const child = spawnImpl(process.execPath, [...execArgv, scriptPath, RELAY_RUNTIME_FLAG, ...args], {
    cwd,
    env,
    detached,
    stdio,
    windowsHide,
  });
  logger?.log?.(`[relay] launched runtime pid=${child.pid || 'none'} script=${path.basename(String(scriptPath || ''))}`);
  return child;
}

function stopChildProcess(child, { signal = 'SIGTERM', killAfterMs = 1200 } = {}) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    return;
  }
  setTimeout(() => {
    if (!child || child.exitCode !== null) return;
    try { child.kill('SIGKILL'); } catch {}
  }, killAfterMs);
}

function waitForChildExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once?.('error', (error) => finish({ code: null, signal: null, error }));
    child.once?.('exit', (code, signal) => finish({ code, signal, error: null }));
  });
}

export async function runDirectRelaySupervisor({
  scriptPath,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  execArgv = process.execArgv,
  spawnImpl = spawn,
  stdio = ['ignore', 'pipe', 'pipe'],
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exitImpl = (code) => process.exit(code),
  logger = console,
  installSignalHandlers = true,
  restartDelayMs = 500,
  maxCrashRestarts = 3,
} = {}) {
  let runtimeProc = null;
  let shuttingDown = false;
  let shutdownExitCode = 0;

  const requestShutdown = (signal = 'SIGTERM', exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownExitCode = exitCode;
    stopChildProcess(runtimeProc, { signal });
  };

  const handleSigInt = () => requestShutdown('SIGINT', 0);
  const handleSigTerm = () => requestShutdown('SIGTERM', 0);

  if (installSignalHandlers) {
    process.on('SIGINT', handleSigInt);
    process.on('SIGTERM', handleSigTerm);
  }

  try {
    let crashCount = 0;
    while (true) {
      runtimeProc = spawnRelayRuntime({
        env,
        cwd,
        scriptPath,
        args,
        execArgv,
        spawnImpl,
        stdio,
        detached: false,
        logger,
      });
      if (runtimeProc.stdout?.on) {
        runtimeProc.stdout.on('data', (chunk) => process.stdout.write(chunk));
      }
      if (runtimeProc.stderr?.on) {
        runtimeProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
      }

      const result = await waitForChildExit(runtimeProc);
      runtimeProc = null;

      if (shuttingDown) {
        return await exitImpl(shutdownExitCode);
      }

      if (result.error) {
        logger?.error?.(`[relay] runtime launch failed: ${result.error?.message || result.error}`);
        return await exitImpl(1);
      }

      const exitCode = Number.isInteger(Number(result.code)) ? Number(result.code) : null;
      if (exitCode === RELAY_RESTART_EXIT_CODE) {
        logger?.log?.(`[relay] runtime requested restart; relaunching ${path.basename(String(scriptPath || ''))}...`);
        crashCount = 0;
        await delay(restartDelayMs);
        continue;
      }

      if (exitCode === 0) {
        return await exitImpl(0);
      }

      const attempt = crashCount + 1;
      logger?.error?.(`[relay] runtime crashed with exit code ${exitCode ?? 'null'} (crash ${attempt}/${maxCrashRestarts}).`);
      if (attempt >= maxCrashRestarts) {
        logger?.error?.('[relay] crash limit reached; supervisor stopping.');
        return await exitImpl(1);
      }
      crashCount = attempt;
      await delay(restartDelayMs);
    }

  } finally {
    if (installSignalHandlers) {
      process.off('SIGINT', handleSigInt);
      process.off('SIGTERM', handleSigTerm);
    }
  }
}
