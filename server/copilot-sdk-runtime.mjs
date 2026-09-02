'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

function dedupePaths(paths) {
  const seen = new Set();
  return paths.filter((value) => {
    const candidate = String(value || '').trim();
    if (!candidate) return false;
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function getCopilotBaseDirs({ env = process.env, platform = process.platform, homeDir = os.homedir() } = {}) {
  const configured = String(env.COPILOT_PKG_DIR || '').trim();
  if (platform === 'win32') {
    return dedupePaths([configured, path.join(env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'copilot', 'pkg')]);
  }
  if (platform === 'darwin') {
    return dedupePaths([configured, path.join(homeDir, 'Library', 'Application Support', 'copilot', 'pkg')]);
  }
  return dedupePaths([
    configured,
    path.join(env.XDG_CACHE_HOME || path.join(homeDir, '.cache'), 'copilot', 'pkg'),
    path.join(env.XDG_DATA_HOME || path.join(homeDir, '.local', 'share'), 'copilot', 'pkg'),
  ]);
}

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

export function resolveInstalledCopilotPaths({ config = {}, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  if (config.sdkPath && config.cliPath) {
    return { sdkPath: path.resolve(config.sdkPath), cliPath: path.resolve(config.cliPath), version: 'configured' };
  }
  const requestedVersion = String(config.sdkVersion || '').trim();
  const subdirs = platform === 'universal' ? ['universal'] : [`${platform}-${arch}`, 'universal'];
  const candidates = [];
  for (const [baseDirIdx, baseDir] of getCopilotBaseDirs({ env, platform }).entries()) {
    for (const [subdirIdx, subdir] of subdirs.entries()) {
      let entries = [];
      try { entries = fs.readdirSync(path.join(baseDir, subdir)); } catch { continue; }
      for (const version of entries) {
        if (!/^\d+\.\d+\.\d+$/.test(version) || (requestedVersion && version !== requestedVersion)) continue;
        const versionDir = path.join(baseDir, subdir, version);
        const sdkPath = path.join(versionDir, 'copilot-sdk', 'index.js');
        const cliPath = copilotRuntimeEntry(versionDir);
        if (fs.existsSync(sdkPath) && fs.existsSync(cliPath)) {
          candidates.push({ version, baseDirIdx, subdirIdx, sdkPath, cliPath });
        }
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
  const scope = requestedVersion ? `version ${requestedVersion}` : 'a compatible version';
  throw new Error(`Copilot SDK runtime not found (${scope}). Install Copilot CLI or configure sdkPath and cliPath.`);
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
    baseDirectory,
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
      await client.stop?.();
      await client.dispose?.();
    },
  };
}
