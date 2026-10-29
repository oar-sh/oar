/**
 * Session workers of a relay that a systemd user service runs start in a
 * scope of their own (`systemd-run --user --scope`), so a stop or restart of
 * the service, which ends every process in its cgroup (KillMode=mixed), does
 * not take them along. A tmux server the call starts lands in that scope; a
 * running one is only talked to. With `--scope` systemd-run executes the
 * command in place: its process id, environment and exit stay the worker's.
 *
 * Whether it can is asked once per runtime, at the first worker start (or
 * the first restart picture, which says whether the workers survive):
 * the runtime's parent must be the unit's main process (a relay started inside
 * a worker that still sits in the service's cgroup looks like the service,
 * but is not it), and systemd-run must work (it needs the user bus). Anything
 * else starts workers as before, with one log line.
 */

import { spawnSync } from 'node:child_process';

export const WORKER_SCOPE_PREFIX = Object.freeze(['--user', '--scope', '--collect', '--quiet', '--']);

function failure(result) {
  if (result?.error) return result.error.code || result.error.message || String(result.error);
  const said = String(result?.stderr || '').trim().split('\n')[0];
  return `status ${result?.status ?? 'none'}${said ? `: ${said}` : ''}`;
}

/**
 * `wrap(command, args)` → `{ command, args }`: the call through systemd-run
 * where workers get scopes of their own, else the call as it is. `hosting`
 * is detectRelayHosting()'s answer for this runtime.
 */
export function createWorkerScope({
  hosting = null,
  spawnSyncImpl = spawnSync,
  parentPid = process.ppid,
  log = null,
} = {}) {
  let scoped = null;

  const decide = () => {
    if (!hosting?.systemd || !hosting.userManager || !hosting.unit) return false;
    const run = (command, args) => {
      try {
        return spawnSyncImpl(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 }) || { status: null };
      } catch (error) {
        return { status: null, error };
      }
    };
    const main = run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', hosting.unit]);
    const mainPid = Number(String(main.stdout ?? '').trim());
    if (main.status !== 0 || mainPid !== parentPid) {
      log?.(`session workers start without a scope of their own: ${hosting.unit} is not this relay's service (main process ${main.status === 0 ? mainPid || 'none' : `unknown, ${failure(main)}`}, relay supervisor ${parentPid}).`);
      return false;
    }
    const probe = run('systemd-run', [...WORKER_SCOPE_PREFIX, 'true']);
    if (probe.status !== 0) {
      log?.(`session workers start without a scope of their own (systemd-run: ${failure(probe)}); a stop or restart of ${hosting.unit} ends them.`);
      return false;
    }
    log?.(`session workers start in scopes of their own (systemd-run --user --scope): they keep running through a stop or restart of ${hosting.unit}.`);
    return true;
  };

  const inUse = () => {
    if (scoped === null) scoped = decide();
    return scoped;
  };

  return {
    // Whether workers start in scopes of their own; asked once, by whichever
    // comes first (a worker start, or a restart picture).
    inUse,
    wrap(command, args = []) {
      return inUse() ? { command: 'systemd-run', args: [...WORKER_SCOPE_PREFIX, command, ...args] } : { command, args };
    },
  };
}
