import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { RELAY_RESTART_EXIT_CODE, RELAY_STOP_EXIT_CODE } from './relay-exit-codes.mjs';
import { relayRuntimeNodeFlags, relayRuntimeNodeFlagsOrNone } from './relay-heap-guard.mjs';
import { detectRelayHosting } from './services/relay-restart-picture.mjs';

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
  // The heap limit and heap snapshot flags (relay-heap-guard.mjs).
  nodeFlags = relayRuntimeNodeFlags,
} = {}) {
  const { flags } = relayRuntimeNodeFlagsOrNone(nodeFlags, { env, execArgv, serverDir: path.dirname(String(scriptPath || '')), logger });
  const child = spawnImpl(process.execPath, [...flags, ...execArgv, scriptPath, RELAY_RUNTIME_FLAG, ...args], {
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

// A systemctl --user call of the handover: its result, never a throw.
function runSystemctl(spawnSyncImpl, args) {
  try {
    return spawnSyncImpl('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }) || { status: null };
  } catch (error) {
    return { status: null, error };
  }
}

function systemctlFailure(result) {
  if (result.error) return result.error.message || String(result.error);
  const said = String(result.stderr || '').trim().split('\n')[0];
  return `status ${result.status ?? 'none'}${said ? `: ${said}` : ''}`;
}

/**
 * The runtime asked for a restart (exit 75). Under a user service whose main
 * process this supervisor is, systemd restarts the whole service, so the new
 * supervisor and runtime run the code on disk with fresh Node flags: true
 * once systemd's stop (SIGTERM) has come. False, with one log line, wherever
 * that cannot be done (not the unit's main process: a relay started inside a
 * worker of the service), systemctl fails, or no stop comes within
 * `handoverWaitMs`; the caller relaunches the runtime itself then.
 */
async function handRestartToSystemd({ hosting, spawnSyncImpl, pid, handoverWaitMs, shutdownRequested, isShuttingDown, delay, logger }) {
  if (!hosting?.systemd || !hosting.userManager || !hosting.unit) return false;
  const { unit } = hosting;
  const main = runSystemctl(spawnSyncImpl, ['show', '-p', 'MainPID', '--value', unit]);
  const mainPid = Number(String(main.stdout ?? '').trim());
  if (main.status !== 0 || mainPid !== pid) {
    const whose = main.status === 0 ? `its main process is ${mainPid || 'none'}` : `its main process could not be read (${systemctlFailure(main)})`;
    logger?.log?.(`[relay] restart: not handed to systemd, ${unit} is not this supervisor's (pid ${pid}; ${whose}).`);
    return false;
  }
  // Clears a failed state and the restart backoff; restart's answer alone decides.
  runSystemctl(spawnSyncImpl, ['reset-failed', unit]);
  // A stop that came in meanwhile wins: a queued restart could replace its job.
  // The calls above block; a signal that arrived during them waits on the
  // signal pipe, which only the loop's poll phase reads. This runs from the
  // runtime's 'exit' callback, itself in a poll phase, so one setImmediate
  // would run in the check phase right after it, before the pipe is read;
  // the second runs after the next poll phase has delivered the signal.
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
  if (isShuttingDown()) {
    logger?.log?.(`[relay] restart: a stop came in; not restarting ${unit}.`);
    return true;
  }
  const restart = runSystemctl(spawnSyncImpl, ['restart', '--no-block', unit]);
  if (restart.status !== 0) {
    logger?.log?.(`[relay] restart: systemctl --user restart --no-block ${unit} failed (${systemctlFailure(restart)}).`);
    return false;
  }
  logger?.log?.(`[relay] restart handed to systemd: ${unit} restarts with the code on disk.`);
  const stopped = await Promise.race([shutdownRequested.then(() => true), Promise.resolve(delay(handoverWaitMs)).then(isShuttingDown)]);
  if (!stopped) logger?.log?.(`[relay] restart: systemd did not stop ${unit} within ${Math.round(handoverWaitMs / 1000)} s.`);
  return stopped;
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
  signals = process,
  nodeFlags = relayRuntimeNodeFlags,
  restartDelayMs = 500,
  maxCrashRestarts = 3,
  // A runtime that ran this long before it crashed starts the count afresh:
  // crashes days apart are not a crash loop.
  crashCountResetMs = 10 * 60 * 1000,
  now = Date.now,
  // How this process is run (detectRelayHosting); read at the first restart
  // request when not given.
  hosting = null,
  spawnSyncImpl = spawnSync,
  pid = process.pid,
  // How long a restart handed to systemd waits for its SIGTERM.
  handoverWaitMs = 30_000,
} = {}) {
  let runtimeProc = null;
  let shuttingDown = false;
  let shutdownExitCode = 0;
  let shutdownArrived;
  const shutdownRequested = new Promise((resolve) => { shutdownArrived = resolve; });

  const requestShutdown = (signal = 'SIGTERM', exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownExitCode = exitCode;
    stopChildProcess(runtimeProc, { signal });
    shutdownArrived();
  };

  const handleSigInt = () => requestShutdown('SIGINT', 0);
  const handleSigTerm = () => requestShutdown('SIGTERM', 0);

  if (installSignalHandlers) {
    signals.on('SIGINT', handleSigInt);
    signals.on('SIGTERM', handleSigTerm);
  }

  try {
    let crashCount = 0;
    while (true) {
      // A Ctrl-C reaches the runtime (same process group) before this
      // supervisor's handler can run: the runtime's signal exit looks like a
      // crash, and the shutdown arrives during the delay. Never relaunch then.
      if (shuttingDown) {
        return await exitImpl(shutdownExitCode);
      }
      const startedAt = now();
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
        nodeFlags,
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

      // A runtime killed by a signal (an out-of-memory abort is SIGABRT, the
      // kernel's OOM killer SIGKILL) exits with code null: a crash. Number(null)
      // is 0, which once ended the supervisor as if the runtime stopped cleanly.
      const exitCode = result.code !== null && result.code !== undefined && Number.isInteger(Number(result.code))
        ? Number(result.code)
        : null;
      const signal = exitCode === null ? (result.signal || null) : null;
      if (exitCode === RELAY_RESTART_EXIT_CODE) {
        crashCount = 0;
        const handedOver = await handRestartToSystemd({
          hosting: hosting || detectRelayHosting({ env }),
          spawnSyncImpl,
          pid,
          handoverWaitMs,
          shutdownRequested,
          isShuttingDown: () => shuttingDown,
          delay,
          logger,
        });
        // systemd's stop: this supervisor ends, systemd starts the next one.
        if (handedOver || shuttingDown) return await exitImpl(shutdownExitCode);
        logger?.log?.(`[relay] runtime requested restart; relaunching ${path.basename(String(scriptPath || ''))}...`);
        await delay(restartDelayMs);
        continue;
      }

      if (exitCode === 0) {
        return await exitImpl(0);
      }

      // Stopped on purpose, with its reason already said: not a crash.
      if (exitCode === RELAY_STOP_EXIT_CODE) {
        return await exitImpl(RELAY_STOP_EXIT_CODE);
      }

      if (now() - startedAt >= crashCountResetMs) crashCount = 0;
      const attempt = crashCount + 1;
      const how = signal ? `signal ${signal}` : `exit code ${exitCode ?? 'null'}`;
      logger?.error?.(`[relay] runtime crashed with ${how} (crash ${attempt}/${maxCrashRestarts}).`);
      if (attempt >= maxCrashRestarts) {
        logger?.error?.('[relay] crash limit reached; supervisor stopping.');
        return await exitImpl(1);
      }
      crashCount = attempt;
      await delay(restartDelayMs);
    }

  } finally {
    if (installSignalHandlers) {
      signals.off('SIGINT', handleSigInt);
      signals.off('SIGTERM', handleSigTerm);
    }
  }
}
