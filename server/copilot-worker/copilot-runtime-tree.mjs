// The commands of this worker's Copilot runtime, and when they are stopped.
//
// The runtime ends its own commands when it ends in good order. When it is
// killed, or dies, they run on with nobody left to read their result (the
// measurements are in shared/worker-runtime/process-tree.mjs). The worker
// therefore keeps the runtime's process tree while the runtime lives and
// stops what is left of it after a runtime that failed is gone.
import { createProcessTreeWatch } from '../../shared/worker-runtime/process-tree.mjs';
import { createProcessLister } from '../services/process-list-service.mjs';
import { readRuntimePid } from './copilot-sdk-adapter.mjs';

/**
 * The reasons of `stopRuntime` after which the tree is stopped: the runtime
 * exited, it no longer answers, or it is torn down because its turn failed.
 * An idle runtime and a worker that shuts down stop in good order, and the
 * runtime ends its commands itself.
 */
const TREE_STOP_REASONS = new Set(['runtime-exit', 'runtime-gone', 'turn-failure']);

export function runtimeStopLeavesCommands(reason) {
  return TREE_STOP_REASONS.has(String(reason || ''));
}

/**
 * The wrapper the runtime puts around a command that was started with
 * `detach: true`. Such a command is meant to outlive the session ("only set
 * this when the user explicitly requires the process to survive"), and the
 * runtime leaves it running when it stops in good order. So does the worker.
 *
 * On Linux and macOS (runtime 1.0.89) the wrapper is a shell that keeps the
 * pid and exit paths in variables. On Windows (1.0.88, seen live) it is a
 * PowerShell that starts the command with Start-Process; the command itself
 * is a child of the wrapper and is kept with it. The wrapper's text is the
 * mark: the names of its files (`copilot-detached-…`) would also match a
 * command that merely mentions one.
 */
const DETACHED_COMMAND_MARKERS = Object.freeze([
  '__copilot_pid_path=',
  '$__copilotProcess = Start-Process',
]);

export function isDetachedRuntimeCommand(proc) {
  const commandLine = String(proc?.commandLine || '');
  return DETACHED_COMMAND_MARKERS.some((marker) => commandLine.includes(marker));
}

/**
 * The sentence of the failure note. "is being stopped", not "was": the note
 * is published before the runtime is torn down, and the commands are stopped
 * after it.
 */
export function describeCommandsBeingStopped(count) {
  const commands = Number(count) || 0;
  if (commands <= 0) return '';
  if (commands === 1) return 'A command that was still running is being stopped.';
  return `${commands} commands that were still running are being stopped.`;
}

/**
 * Watch the process tree of `client`'s runtime. Returns null where the pid of
 * the runtime is not known: nothing is signalled on a guess.
 */
export function watchCopilotRuntimeTree({
  client,
  isBusy = () => true,
  dbg = () => {},
  platform = process.platform,
  lister = null,
  signal = (pid, name) => process.kill(pid, name),
  // Never signalled, whatever the process list says.
  selfPid = process.pid,
  parentPid = process.ppid,
  ...timing
} = {}) {
  const rootPid = readRuntimePid(client);
  if (!rootPid) {
    dbg('the pid of the copilot runtime is not known; its commands are not watched');
    return null;
  }
  return createProcessTreeWatch({
    rootPid,
    lister: lister || createProcessLister({ platform }),
    signal,
    protectedPids: [selfPid, parentPid],
    keepSubtree: isDetachedRuntimeCommand,
    isBusy,
    label: 'copilot runtime',
    dbg,
    ...timing,
  });
}
