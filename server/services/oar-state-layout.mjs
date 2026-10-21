import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveOarRoot } from './oar-state-migration-service.mjs';

// Pre-OAR managed config location — kept only as a migration source and as the
// config home for git checkouts, where nothing may change underfoot.
export function getLegacyManagedConfigDir(env = process.env, { platform = process.platform, pathImpl = path } = {}) {
  if (platform === 'win32') {
    return pathImpl.join(
      env.LOCALAPPDATA || pathImpl.join(os.homedir(), 'AppData', 'Local'),
      'copilot-remote',
    );
  }
  return pathImpl.join(
    env.XDG_CONFIG_HOME || pathImpl.join(os.homedir(), '.config'),
    'copilot-remote',
  );
}

export function isGitCheckout(packageRoot, { fsImpl = fs, pathImpl = path } = {}) {
  try { return fsImpl.existsSync(pathImpl.join(packageRoot, '.git')); } catch { return false; }
}

/**
 * Where launcher-managed state lives. A git checkout keeps every pre-OAR
 * default (repo-local server/data, legacy managed config) so development and
 * the two existing machines change nothing. A global install gets the OAR
 * state root: config, data, logs all under ~/.oar (APPDATA\oar on Windows),
 * which survives `npm i -g` updates.
 */
export function resolveStateLayout({
  packageRoot,
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  if (isGitCheckout(packageRoot, { fsImpl, pathImpl })) {
    return { checkout: true, root: null, configDir: getLegacyManagedConfigDir(env, { platform, pathImpl }), dataDir: null };
  }
  const root = resolveOarRoot(env, platform);
  return { checkout: false, root, configDir: root, dataDir: pathImpl.join(root, 'data') };
}

/**
 * The data and log folders a relay of this install is started with, '' where
 * the relay is left to its own server-relative default. Every launcher pins
 * these — `oar start`, `oar copilot` and both Windows autostart launchers —
 * so the relay finds the same database however it was started. A folder the
 * environment names wins; a global install otherwise uses the OAR state root;
 * a checkout pins nothing of its own.
 */
export function resolveRelayStateDirs({
  packageRoot,
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  pathImpl = path,
  layout = resolveStateLayout({ packageRoot, env, platform, fsImpl, pathImpl }),
} = {}) {
  const envDataDir = String(env?.COPILOT_WEB_RELAY_DATA_DIR || '').trim();
  const envLogDir = String(env?.COPILOT_WEB_RELAY_LOG_DIR || '').trim();
  return {
    dataDir: envDataDir || layout?.dataDir || '',
    logDir: envLogDir || (layout && !layout.checkout ? pathImpl.join(layout.root, 'logs') : ''),
  };
}

/**
 * The data and log folders an automatic launcher repair may pin: those of the
 * install's layout alone, never ones only this relay's environment names (a
 * short-lived relay started with a scratch data folder must not repoint the
 * install's autostart). Null when the layout has none (a checkout), or when
 * this relay runs on other folders than the layout's.
 */
export function resolveLayoutStateDirs({
  packageRoot,
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const layout = resolveStateLayout({ packageRoot, env, platform, fsImpl, pathImpl });
  const dirs = resolveRelayStateDirs({ env: {}, layout, platform, pathImpl });
  if (!dirs.dataDir || !dirs.logDir) return null;
  const own = resolveRelayStateDirs({ env, layout, platform, pathImpl });
  const same = (a, b) => {
    const normalize = (value) => {
      const resolved = pathImpl.resolve(String(value));
      return platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(a) === normalize(b);
  };
  return same(dirs.dataDir, own.dataDir) && same(dirs.logDir, own.logDir) ? dirs : null;
}

/**
 * The log folder `oar copilot` and `oar start` give the relay (and write its
 * output to): the relay's log folder, else, in a checkout, `logs` in the
 * legacy managed config folder.
 */
export function getLauncherLogDir(env = process.env, layout = null, { platform = process.platform, pathImpl = path } = {}) {
  return resolveRelayStateDirs({ env, layout, platform, pathImpl }).logDir
    || pathImpl.join(getLegacyManagedConfigDir(env, { platform, pathImpl }), 'logs');
}
