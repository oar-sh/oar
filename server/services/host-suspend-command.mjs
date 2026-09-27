'use strict';

import { spawn } from 'node:child_process';

/**
 * The actual suspend-to-RAM call. Windows only: `SetSuspendState 0,0,0` puts
 * the box into S3 (hibernation is not enabled on the host, so this never
 * hibernates). Detached so the relay does not wait on it.
 *
 * `OAR_HOST_SUSPEND_DRY_RUN=1` logs instead of sleeping the machine, which is
 * how the deferred-suspend flow gets exercised on a dev box.
 */
export function runHostSuspendToRam({
  platform = process.platform,
  spawnImpl = spawn,
  dryRun = /^(1|true|yes|on)$/i.test(String(process.env.OAR_HOST_SUSPEND_DRY_RUN || '')),
  logger = console,
} = {}) {
  if (platform !== 'win32') {
    return { ok: false, statusCode: 501, error: 'Host suspend is only supported on Windows' };
  }
  const command = 'rundll32.exe powrprof.dll,SetSuspendState 0,0,0';
  if (dryRun) {
    try { logger.log?.(`[host-suspend] DRY RUN — would run: ${command}`); } catch {}
    return { ok: true, command, dryRun: true };
  }
  try {
    const child = spawnImpl('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,0,0'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref?.();
    return { ok: true, command };
  } catch (error) {
    return { ok: false, statusCode: 500, error: error?.message || 'Failed to launch host suspend command' };
  }
}
