import os from 'node:os';
import path from 'node:path';

// The OAR state root: ~/.oar, %APPDATA%\oar on Windows, OAR_STATE_ROOT when
// set. A module of its own, without imports of OAR's, so the relay's lock
// check can find the agent SDK folder beside it (agent-sdk-paths.mjs).
export function resolveOarRoot(env = process.env, platform = process.platform) {
  const override = String(env.OAR_STATE_ROOT || '').trim();
  if (override) return path.resolve(override);
  if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim();
    if (appData) return path.join(appData, 'oar');
    const profile = String(env.USERPROFILE || '').trim();
    return path.join(profile || os.homedir(), 'AppData', 'Roaming', 'oar');
  }
  return path.join(os.homedir(), '.oar');
}
