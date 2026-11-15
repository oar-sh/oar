'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function dedupePaths(paths, pathImpl = path) {
  const seen = new Set();
  return paths.filter((value) => {
    const candidate = String(value || '').trim();
    if (!candidate) return false;
    const normalized = pathImpl.normalize(candidate);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * The folders that may hold the Copilot CLI's version folders
 * (`<folder>/<platform>-<arch>/<version>`), in search order:
 *
 * 1. `COPILOT_PKG_DIR`, the relay's own override.
 * 2. `pkg` under the CLI's cache folder, found the way the CLI finds it:
 *    `COPILOT_PKG_CACHE_HOME`, then `COPILOT_CACHE_HOME`, then the platform's
 *    cache folder (`$XDG_CACHE_HOME` or `~/.cache` on Linux,
 *    `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows, each with
 *    `copilot`).
 * 3. `~/.copilot/pkg`.
 * 4. Where earlier versions of this lookup searched and the list above does
 *    not: `$XDG_DATA_HOME` or `~/.local/share` with `copilot/pkg` on Linux,
 *    `~/Library/Application Support/copilot/pkg` on macOS.
 */
export function getCopilotBaseDirs({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  const text = (value) => String(value || '').trim();
  const earlier = [];
  let platformCacheHome;
  if (platform === 'win32') {
    platformCacheHome = pathImpl.join(text(env.LOCALAPPDATA) || pathImpl.join(homeDir, 'AppData', 'Local'), 'copilot');
  } else if (platform === 'darwin') {
    platformCacheHome = pathImpl.join(homeDir, 'Library', 'Caches', 'copilot');
    earlier.push(pathImpl.join(homeDir, 'Library', 'Application Support', 'copilot', 'pkg'));
  } else {
    platformCacheHome = pathImpl.join(text(env.XDG_CACHE_HOME) || pathImpl.join(homeDir, '.cache'), 'copilot');
    earlier.push(pathImpl.join(text(env.XDG_DATA_HOME) || pathImpl.join(homeDir, '.local', 'share'), 'copilot', 'pkg'));
  }
  const cacheHomes = [text(env.COPILOT_PKG_CACHE_HOME), text(env.COPILOT_CACHE_HOME), platformCacheHome].filter(Boolean);
  return dedupePaths([
    text(env.COPILOT_PKG_DIR),
    ...cacheHomes.map((cacheHome) => pathImpl.join(cacheHome, 'pkg')),
    pathImpl.join(homeDir, '.copilot', 'pkg'),
    ...earlier,
  ], pathImpl);
}

const VERSION_DIR_RE = /^\d+\.\d+\.\d+$/;

/**
 * The runtime entry point inside a Copilot CLI version directory.
 *
 * It is `app.js` and never the sibling `index.js`: `index.js` is a
 * self-updating launcher that resolves the newest version in the cache and
 * `exec`s THAT version's `app.js`. Spawning it silently defeats pinning the
 * runtime to the SDK bundle's own version, which matters because the event
 * shapes the workers normalize are per-version. Exported so every caller pins
 * the same file.
 */
export function copilotRuntimeEntry(versionDir) {
  return path.join(versionDir, 'app.js');
}

// A version folder counts only with the SDK and the runtime it drives. The
// CLI's older "universal" folders hold no `copilot-sdk` and are passed over.
function installedPathsOfVersionDir(versionDir) {
  const sdkPath = path.join(versionDir, 'copilot-sdk', 'index.js');
  const cliPath = copilotRuntimeEntry(versionDir);
  return fs.existsSync(sdkPath) && fs.existsSync(cliPath) ? { sdkPath, cliPath } : null;
}

export const COPILOT_SDK_NOT_FOUND = 'copilot-sdk-not-found';

/**
 * The SDK and the runtime of one installed Copilot CLI version:
 * `{ sdkPath, cliPath, version }`, the SDK's `index.js` and the `app.js`
 * beside its folder. The one lookup of the relay: its own Copilot clients
 * (model discovery, session import) and every worker launch
 * (resolveCopilotSdkLaunchPath) go through it, and it reads the folders on
 * every call.
 *
 * - `config.sdkPath` with `config.cliPath`: the two as given, unchecked.
 * - `config.sdkPath` alone: the version folder it lies in, when that folder
 *   counts; else the search below.
 * - The newest version among the folders of getCopilotBaseDirs
 *   (`config.sdkVersion` asks for one version); between two folders with the
 *   same version the earlier one in the list.
 *
 * Throws an error with the code COPILOT_SDK_NOT_FOUND, whose message names
 * the folders searched, when there is none.
 */
export function resolveInstalledCopilotPaths({
  config = {},
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homeDir = os.homedir(),
} = {}) {
  if (config.sdkPath && config.cliPath) {
    return { sdkPath: path.resolve(config.sdkPath), cliPath: path.resolve(config.cliPath), version: 'configured' };
  }
  if (config.sdkPath) {
    const versionDir = path.resolve(path.dirname(String(config.sdkPath)), '..');
    const configured = installedPathsOfVersionDir(versionDir);
    if (configured) {
      const name = path.basename(versionDir);
      return { ...configured, version: VERSION_DIR_RE.test(name) ? name : 'configured' };
    }
  }
  const requestedVersion = String(config.sdkVersion || '').trim();
  const subdirs = platform === 'universal' ? ['universal'] : [`${platform}-${arch}`, 'universal'];
  const baseDirs = getCopilotBaseDirs({ env, platform, homeDir });
  const candidates = [];
  for (const [baseDirIdx, baseDir] of baseDirs.entries()) {
    for (const [subdirIdx, subdir] of subdirs.entries()) {
      let entries = [];
      try { entries = fs.readdirSync(path.join(baseDir, subdir)); } catch { continue; }
      for (const version of entries) {
        if (!VERSION_DIR_RE.test(version) || (requestedVersion && version !== requestedVersion)) continue;
        const found = installedPathsOfVersionDir(path.join(baseDir, subdir, version));
        if (found) candidates.push({ version, baseDirIdx, subdirIdx, ...found });
      }
    }
  }
  candidates.sort((a, b) => {
    const aVersion = a.version.split('.').map(Number);
    const bVersion = b.version.split('.').map(Number);
    return bVersion[0] - aVersion[0] || bVersion[1] - aVersion[1] || bVersion[2] - aVersion[2]
      || a.baseDirIdx - b.baseDirIdx || a.subdirIdx - b.subdirIdx;
  });
  if (candidates.length) return candidates[0];
  const wanted = requestedVersion ? ` version ${requestedVersion}` : '';
  const error = new Error(
    `Copilot SDK${wanted} not found. Install the GitHub Copilot CLI and run it once (copilot --version); `
    + `no relay restart is needed. Looked in: ${baseDirs.join(', ')} `
    + `(for ${subdirs[0]}/<version>/copilot-sdk/index.js with app.js beside the folder)`,
  );
  error.code = COPILOT_SDK_NOT_FOUND;
  error.searched = baseDirs;
  throw error;
}

/**
 * The `copilot-sdk` folder a Copilot SDK worker is launched with (its
 * `COPILOT_SDK_PATH`), asked on every launch: a CLI installed or updated
 * since the relay started is found, and a version folder that is gone is not
 * used.
 *
 * A `COPILOT_SDK_PATH` in the environment wins, as given. Else the lookup
 * above, by `config.sdkPath` or the search. `config.cliPath` plays no part:
 * the worker starts the `app.js` beside the SDK's folder, so the two are
 * always of one version. Throws as the lookup does when there is no SDK.
 */
export function resolveCopilotSdkLaunchPath({
  config = {},
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homeDir = os.homedir(),
} = {}) {
  const explicit = String(env?.COPILOT_SDK_PATH || '').trim();
  if (explicit) return explicit;
  const { sdkPath } = resolveInstalledCopilotPaths({
    config: { sdkPath: config?.sdkPath, sdkVersion: config?.sdkVersion },
    env,
    platform,
    arch,
    homeDir,
  });
  return path.dirname(sdkPath);
}

export function buildInstalledCopilotClientOptions({
  cliPath,
  cwd,
  baseDirectory,
  logLevel = 'debug',
} = {}) {
  return {
    connection: {
      kind: 'stdio',
      path: cliPath,
    },
    mode: 'empty',
    // Runtime 1.0.83 made 'empty' mode refuse to construct without an explicit
    // per-session persistence location. ~/.copilot is exactly what the runtime
    // defaulted to before (baseDirectory sets COPILOT_HOME), so the import
    // sweep keeps seeing the CLI's real session state.
    baseDirectory: String(baseDirectory || '').trim() || path.join(os.homedir(), '.copilot'),
    useLoggedInUser: true,
    logLevel,
    workingDirectory: cwd,
  };
}

export async function createInstalledCopilotClient({
  config = {},
  cwd,
  baseDirectory,
  logLevel = 'debug',
} = {}) {
  const paths = resolveInstalledCopilotPaths({ config });
  const sdk = await import(pathToFileURL(paths.sdkPath).href);
  if (typeof sdk.CopilotClient !== 'function') throw new Error('CopilotClient not found in installed Copilot SDK exports');
  const client = new sdk.CopilotClient(buildInstalledCopilotClientOptions({
    cliPath: paths.cliPath,
    cwd,
    baseDirectory,
    logLevel,
  }));
  await client.start();
  return {
    client,
    approveAll: sdk.approveAll,
    paths,
    async dispose() {
      // stop() can reject (e.g. the CLI already died); dispose() must still
      // run or the transport resources leak with it.
      try {
        await client.stop?.();
      } finally {
        await client.dispose?.();
      }
    },
  };
}
