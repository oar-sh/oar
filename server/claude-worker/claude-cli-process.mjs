// The Claude Code CLI as a child process of this worker, for the one thing the
// SDK does not do on Windows: ending what the CLI started when the worker
// stops the CLI.
//
// The SDK's abort ends claude.exe alone there. A command the CLI was running
// (a build, a dev server, a `ping`) goes on without it, and once the CLI is
// gone its children can no longer be found through it. So the worker ends the
// CLI's whole process tree first (`taskkill /T`), and aborts after.
//
// The SDK starts the CLI itself and does not say which process it is. Node
// announces every child process it creates on the `child_process` diagnostics
// channel; the CLI is recognised by how the SDK starts it (stream-json on
// stdin and stdout). Nothing here runs on another platform: there the SDK's
// own abort is all that happens, as before.

import { spawn } from 'node:child_process';
import diagnosticsChannel from 'node:diagnostics_channel';

import { windowsSystemToolPath } from '../../shared/windows-system-tools.mjs';

// How long taskkill may take before the abort goes ahead without it.
export const TREE_KILL_TIMEOUT_MS = 5_000;
// The SDK starts the CLI as it creates the query; a query whose CLI has not
// appeared after this long will not get one, and must not take the next.
const CLI_SPAWN_WAIT_MS = 60_000;

/** Whether a spawned child is a CLI the SDK started. */
export function isSdkCliChild(child) {
  const args = Array.isArray(child?.spawnargs) ? child.spawnargs.map((arg) => String(arg)) : [];
  return args.some((arg) => arg === '--input-format' || arg.startsWith('--input-format='))
    && args.some((arg) => arg.includes('stream-json'));
}

/**
 * Pairs each started query with the CLI child Node announces for it, oldest
 * waiting query first. `channel` is `node:diagnostics_channel`.
 */
export function createCliChildWatch({ channel = diagnosticsChannel, now = Date.now } = {}) {
  const waiting = [];
  let subscribed = false;

  function onChildProcess(message) {
    const child = message?.process;
    if (!child || typeof child.once !== 'function') return;
    // Announced when the ChildProcess object is made: what it runs, and its
    // pid, are known once it has spawned.
    child.once('spawn', () => {
      if (!isSdkCliChild(child)) return;
      while (waiting.length && now() - waiting[0].at > CLI_SPAWN_WAIT_MS) waiting.shift();
      const slot = waiting.shift();
      if (slot) slot.child = child;
    });
  }

  /**
   * Call right before the SDK query is created. `pid()` is the CLI's pid
   * while that process runs, else null.
   */
  function watch() {
    const slot = { child: null, at: now() };
    try {
      if (!subscribed) {
        channel.subscribe('child_process', onChildProcess);
        subscribed = true;
      }
      waiting.push(slot);
    } catch {
      // No channel: no pid, and the abort stays the SDK's alone.
    }
    return {
      pid() {
        const child = slot.child;
        if (!child || child.exitCode !== null || child.signalCode) return null;
        const pid = Math.trunc(Number(child.pid));
        return pid > 0 ? pid : null;
      },
    };
  }

  return { watch };
}

const defaultWatch = createCliChildWatch();

/** The process-wide watch (one diagnostics subscription per worker). */
export function watchCliChild() {
  return defaultWatch.watch();
}

/**
 * End a Windows process and everything it started: `taskkill /PID <pid> /T
 * /F`, System32's own, without a shell. Resolves true when taskkill reported
 * success, false otherwise (it failed, could not start, or took too long);
 * never rejects.
 */
export function killWindowsProcessTree(pid, {
  spawnImpl = spawn,
  env = process.env,
  timeoutMs = TREE_KILL_TIMEOUT_MS,
  dbg = () => {},
} = {}) {
  const treePid = Math.trunc(Number(pid));
  if (!(treePid > 0)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    timer = setTimeout(() => {
      dbg('taskkill did not finish in time', String(treePid));
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    try {
      const killer = spawnImpl(
        windowsSystemToolPath('taskkill', { env }),
        ['/PID', String(treePid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
      killer.once('error', (error) => {
        dbg('taskkill could not start', error?.message || String(error));
        finish(false);
      });
      killer.once('exit', (code) => finish(code === 0));
    } catch (error) {
      dbg('taskkill could not start', error?.message || String(error));
      finish(false);
    }
  });
}

/**
 * Stop the CLI of a session process record (`{ turn, abortController }`): the
 * SDK's abort, and on Windows the CLI's process tree before it. `turn.cliPid`
 * is what the SDK adapter put there (watchCliChild); without a pid the abort
 * is all there is.
 */
export function abortCliProcess(processRef, {
  platform = process.platform,
  killTreeImpl = killWindowsProcessTree,
  dbg = () => {},
} = {}) {
  const cliPid = platform === 'win32' ? Number(processRef.turn?.cliPid?.()) : 0;
  if (!(cliPid > 0)) {
    // Said, so that a CLI whose children ran on can be told from the log.
    if (platform === 'win32') dbg('no pid known for the CLI; stopping it without its process tree');
    processRef.abortController.abort();
    return;
  }
  Promise.resolve()
    .then(() => killTreeImpl(cliPid, { dbg }))
    .catch((error) => dbg('ending the CLI process tree failed', error?.message || String(error)))
    .finally(() => processRef.abortController.abort());
}
