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

/** The oldest Copilot SDK OAR drives: the first with the grouped options. */
export const COPILOT_SDK_MIN_VERSION = '1.0.113';
/** The newest Copilot SDK the grouped options were checked against. */
export const COPILOT_SDK_NEWEST_VERIFIED = '1.0.114';
/** Error code of `assertSupportedCopilotSdk` for an SDK older than the minimum. */
export const COPILOT_SDK_TOO_OLD = 'copilot-sdk-too-old';

/**
 * Throw unless the imported SDK is one OAR can drive: 1.0.113 or later, read
 * off `RuntimeConnection.forSpawnedStdio`, the connection factory 1.0.113
 * introduced together with the grouped client and session options.
 *
 * - Only the older `forStdio`: the SDK is older than 1.0.113, and the error
 *   (code COPILOT_SDK_TOO_OLD) says to update the Copilot CLI.
 * - Neither: not an SDK OAR knows; the error names its exports.
 *
 * Both name the version of the bundle when it is known.
 */
export function assertSupportedCopilotSdk(sdk, version = '') {
  const factories = sdk?.RuntimeConnection;
  if (typeof factories?.forSpawnedStdio === 'function') return;
  const named = version ? ` ${version}` : '';
  if (typeof factories?.forStdio === 'function') {
    const error = new Error(
      `The installed Copilot SDK${named} is older than ${COPILOT_SDK_MIN_VERSION}, which this OAR needs. `
      + 'Update the Copilot CLI (run `copilot` once, or install it from the relay\'s Copilot settings).',
    );
    error.code = COPILOT_SDK_TOO_OLD;
    throw error;
  }
  const available = factories && typeof factories === 'object' ? Object.keys(factories).join(', ') : '';
  throw new Error(
    `The installed Copilot SDK${named} has neither RuntimeConnection.forSpawnedStdio `
    + `nor RuntimeConnection.forStdio${available ? ` (it exports: ${available})` : ' (no RuntimeConnection export)'}; `
    + 'this relay cannot start its runtime. Update OAR or reinstall a supported Copilot CLI.',
  );
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || '').trim());
  return match ? match.slice(1).map(Number) : null;
}

/**
 * A one-line note when the SDK bundle is newer than COPILOT_SDK_NEWEST_VERIFIED,
 * or null. Such a bundle is driven all the same; the note is what a log reader
 * looks for when its grouped option names have drifted.
 */
export function describeUnverifiedSdk(version) {
  const bundle = versionParts(version);
  const verified = versionParts(COPILOT_SDK_NEWEST_VERIFIED);
  if (!bundle) return null;
  const newer = bundle[0] - verified[0] || bundle[1] - verified[1] || bundle[2] - verified[2];
  if (newer <= 0) return null;
  return `Copilot SDK ${String(version).trim()} is newer than ${COPILOT_SDK_NEWEST_VERIFIED}, the newest this OAR `
    + 'was checked against; if Copilot turns lose events, permissions or tools, its session options may have moved.';
}

/**
 * Build the stdio connection descriptor for the runtime:
 * `RuntimeConnection.forSpawnedStdio({ path, workingDirectory, baseDirectory })`,
 * producing `{ kind: 'spawned-stdio', … }`. The working and base directories
 * belong on the connection, not on the client options.
 *
 * `forDefault` is deliberately not used: it picks in-process hosting unless
 * COPILOT_SDK_DEFAULT_CONNECTION says otherwise, which would load the runtime
 * library into this process instead of spawning the pinned `app.js`.
 *
 * Throws as `assertSupportedCopilotSdk` does for an SDK OAR cannot drive.
 */
export function buildRuntimeConnection(sdk, runtimeEntry, { cwd = '', baseDirectory = '', version = '' } = {}) {
  assertSupportedCopilotSdk(sdk, version);
  return sdk.RuntimeConnection.forSpawnedStdio({
    path: runtimeEntry,
    ...(cwd ? { workingDirectory: cwd } : {}),
    ...(baseDirectory ? { baseDirectory } : {}),
  });
}

/**
 * The `CopilotClient` constructor options, shared by the session worker and
 * the relay's own clients (model discovery, session import) so the two cannot
 * drift apart.
 *
 * The connection is `runtime`, `logLevel` sits under `observability`,
 * `useLoggedInUser` under `github`, and `mode` is required (`coding-agent`
 * unless asked otherwise). A client-level `workingDirectory` or `env` throws,
 * and the client takes no `clientName`: that goes on each session.
 *
 * Unset fields are left out rather than passed as `undefined`.
 */
export function buildCopilotClientOptions(sdk, {
  runtimeEntry,
  cwd = '',
  baseDirectory = '',
  logLevel = '',
  mode = '',
  useLoggedInUser,
  version = '',
} = {}) {
  return {
    mode: mode || 'coding-agent',
    runtime: buildRuntimeConnection(sdk, runtimeEntry, { cwd, baseDirectory, version }),
    ...(logLevel ? { observability: { logLevel } } : {}),
    ...(typeof useLoggedInUser === 'boolean' ? { github: { useLoggedInUser } } : {}),
  };
}

/**
 * Where each session option OAR builds goes in the SDK's grouped session
 * options: `null` for a key that stays at the top level, else its
 * `<group>.<name>`. OAR's own map, of exactly the options OAR passes; the
 * SDK's own compatibility table for flat names is not relied on.
 */
export const COPILOT_SESSION_OPTION_GROUPS = Object.freeze({
  sessionId: null,
  model: null,
  workingDirectory: null,
  clientName: null,
  suppressResumeEvent: null,
  streaming: 'events.streaming',
  onEvent: 'events.onEvent',
  tools: 'tools.definitions',
  availableTools: 'tools.availableTools',
  onPermissionRequest: 'permissions.onRequest',
  onUserInputRequest: 'interaction.onUserInputRequest',
  onExitPlanModeRequest: 'interaction.onExitPlanModeRequest',
  onElicitationRequest: 'interaction.onElicitationRequest',
  infiniteSessions: 'state.infiniteSessions',
});

// Keys OAR may already pass as a group object (BYOK's `inference` and
// `github`, or `tools` as an object); their fields are merged into the group.
const COPILOT_SESSION_OPTION_GROUP_NAMES = new Set([
  ...Object.values(COPILOT_SESSION_OPTION_GROUPS).filter(Boolean).map((leaf) => leaf.split('.')[0]),
  'inference',
  'github',
]);

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Translate OAR's flat session config into the SDK's grouped session options
 * (see COPILOT_SESSION_OPTION_GROUPS), right before `createSession` or
 * `resumeSession`.
 *
 * - Top-level keys are copied as they are; mapped keys move into their group.
 * - `tools` as an array is the tool definitions; as an object, the group.
 * - A group object (`inference`, `github`) is merged field by field.
 * - `undefined` values are left out.
 *
 * Throws on a field set twice, and a TypeError on a key with no grouped name,
 * so an option OAR adds later cannot be dropped silently.
 */
export function copilotSessionOptions(options = {}) {
  const grouped = {};
  const setLeaf = (group, name, value, from) => {
    const target = grouped[group] || (grouped[group] = {});
    if (Object.hasOwn(target, name)) throw new Error(`Copilot session option ${group}.${name} is set twice (by ${from})`);
    target[name] = value;
  };
  for (const [key, value] of Object.entries(options || {})) {
    if (value === undefined) continue;
    const isGroupObject = COPILOT_SESSION_OPTION_GROUP_NAMES.has(key) && isPlainObject(value);
    if (Object.hasOwn(COPILOT_SESSION_OPTION_GROUPS, key) && !isGroupObject) {
      const leaf = COPILOT_SESSION_OPTION_GROUPS[key];
      if (!leaf) {
        grouped[key] = value;
        continue;
      }
      const [group, name] = leaf.split('.');
      setLeaf(group, name, value, key);
      continue;
    }
    if (isGroupObject) {
      for (const [name, field] of Object.entries(value)) {
        if (field !== undefined) setLeaf(key, name, field, key);
      }
      continue;
    }
    throw new TypeError(`Copilot session option "${key}" has no grouped name in COPILOT_SESSION_OPTION_GROUPS`);
  }
  return grouped;
}

/**
 * Options for the relay's own restricted client (model discovery and the
 * session import sweep): `empty` mode, the logged-in user, and the CLI's
 * session state as its persistence location.
 */
export function buildInstalledCopilotClientOptions(sdk, {
  cliPath,
  cwd,
  baseDirectory,
  logLevel = 'debug',
  version = '',
} = {}) {
  return buildCopilotClientOptions(sdk, {
    runtimeEntry: cliPath,
    cwd,
    mode: 'empty',
    // 'empty' mode refuses to construct without an explicit per-session
    // persistence location, which it reads off the connection. ~/.copilot is exactly what the runtime defaulted to before
    // (baseDirectory sets COPILOT_HOME), so the import sweep keeps seeing the
    // CLI's real session state.
    baseDirectory: String(baseDirectory || '').trim() || path.join(os.homedir(), '.copilot'),
    useLoggedInUser: true,
    logLevel,
    version,
  });
}

export async function createInstalledCopilotClient({
  config = {},
  cwd,
  baseDirectory,
  logLevel = 'debug',
} = {}) {
  const paths = resolveInstalledCopilotPaths({ config });
  const sdk = await import(pathToFileURL(paths.sdkPath).href);
  assertSupportedCopilotSdk(sdk, paths.version);
  if (typeof sdk.CopilotClient !== 'function') throw new Error('CopilotClient not found in installed Copilot SDK exports');
  const client = new sdk.CopilotClient(buildInstalledCopilotClientOptions(sdk, {
    cliPath: paths.cliPath,
    cwd,
    baseDirectory,
    logLevel,
    version: paths.version,
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
