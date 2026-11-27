import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertSupportedCopilotSdk,
  buildCopilotClientOptions,
  buildInstalledCopilotClientOptions,
  buildRuntimeConnection,
  COPILOT_SDK_NEWEST_VERIFIED,
  COPILOT_SDK_NOT_FOUND,
  COPILOT_SDK_TOO_OLD,
  COPILOT_SESSION_OPTION_GROUPS,
  copilotSessionOptions,
  createInstalledCopilotClient,
  describeUnverifiedSdk,
  getCopilotBaseDirs,
  resolveCopilotSdkLaunchPath,
  resolveInstalledCopilotPaths,
} from './copilot-sdk-runtime.mjs';

// Factory shapes copied from the bundles: 1.0.92-1.0.112 export `forStdio`,
// 1.0.113 replaced it with `forSpawnedStdio` (and a `spawned-stdio` kind).
const LEGACY_SDK = Object.freeze({
  RuntimeConnection: {
    forStdio: (opts = {}) => ({ kind: 'stdio', path: opts.path, args: opts.args, env: opts.env }),
  },
});
const SPAWNED_SDK = Object.freeze({
  RuntimeConnection: {
    forSpawnedStdio: (opts = {}) => ({
      kind: 'spawned-stdio',
      path: opts.path,
      args: opts.args,
      env: opts.env,
      workingDirectory: opts.workingDirectory,
      baseDirectory: opts.baseDirectory,
      sessionIdleTimeoutSeconds: opts.sessionIdleTimeoutSeconds,
    }),
  },
});

test('buildInstalledCopilotClientOptions uses the grouped client options', () => {
  // The directories go on the spawned connection (a client-level
  // workingDirectory throws, and empty mode reads baseDirectory off the
  // connection), useLoggedInUser under github, logLevel under observability.
  assert.deepEqual(
    buildInstalledCopilotClientOptions(SPAWNED_SDK, {
      cliPath: '/opt/copilot/app.js',
      cwd: '/workspace/project',
      baseDirectory: '/home/tester/.copilot',
      logLevel: 'error',
    }),
    {
      mode: 'empty',
      runtime: {
        kind: 'spawned-stdio',
        path: '/opt/copilot/app.js',
        args: undefined,
        env: undefined,
        workingDirectory: '/workspace/project',
        baseDirectory: '/home/tester/.copilot',
        sessionIdleTimeoutSeconds: undefined,
      },
      observability: { logLevel: 'error' },
      github: { useLoggedInUser: true },
    },
  );
});

test('an omitted baseDirectory defaults to ~/.copilot (empty mode refuses to start without one)', () => {
  // The import sweep and model discovery must keep seeing the CLI's real
  // session state.
  const spawned = buildInstalledCopilotClientOptions(SPAWNED_SDK, { cliPath: '/opt/copilot/app.js' });
  assert.equal(spawned.runtime.baseDirectory, path.join(os.homedir(), '.copilot'));
});

test('buildCopilotClientOptions is grouped only and defaults the mode to coding-agent', () => {
  const options = buildCopilotClientOptions(SPAWNED_SDK, { runtimeEntry: '/opt/copilot/app.js', cwd: '/workspace/project' });
  assert.equal(options.mode, 'coding-agent');
  assert.deepEqual(Object.keys(options).sort(), ['mode', 'runtime']);
  for (const key of ['connection', 'workingDirectory', 'env', 'logLevel', 'baseDirectory', 'useLoggedInUser', 'clientName']) {
    assert.equal(key in options, false, `${key} must not be on the client options`);
  }
  assert.equal(options.runtime.workingDirectory, '/workspace/project');
});

test('the client options of an SDK older than 1.0.113 are refused with the update hint', () => {
  for (const build of [
    () => buildCopilotClientOptions(LEGACY_SDK, { runtimeEntry: '/opt/copilot/app.js', version: '1.0.112' }),
    () => buildInstalledCopilotClientOptions(LEGACY_SDK, { cliPath: '/opt/copilot/app.js', version: '1.0.112' }),
  ]) {
    assert.throws(build, { code: COPILOT_SDK_TOO_OLD, message: /Copilot SDK 1\.0\.112 is older than 1\.0\.113/ });
  }
});

test('buildRuntimeConnection names the SDK version when neither factory exists', () => {
  assert.throws(
    () => buildRuntimeConnection({ RuntimeConnection: { forTcp() {} } }, '/opt/copilot/app.js', { version: '1.0.999' }),
    /Copilot SDK 1\.0\.999 has neither RuntimeConnection\.forSpawnedStdio nor RuntimeConnection\.forStdio \(it exports: forTcp\)/,
  );
});

test('assertSupportedCopilotSdk: 1.0.113 and later pass, older ones get the update hint, others their exports', () => {
  assert.equal(assertSupportedCopilotSdk(SPAWNED_SDK, '1.0.114'), undefined);
  // Both factories: still the new one that counts.
  assert.equal(assertSupportedCopilotSdk({ RuntimeConnection: { forStdio() {}, forSpawnedStdio() {} } }), undefined);
  assert.throws(() => assertSupportedCopilotSdk(LEGACY_SDK, '1.0.112'), (error) => {
    assert.equal(error.code, COPILOT_SDK_TOO_OLD);
    assert.equal(
      error.message,
      'The installed Copilot SDK 1.0.112 is older than 1.0.113, which this OAR needs. '
      + 'Update the Copilot CLI (run `copilot` once, or install it from the relay\'s Copilot settings).',
    );
    return true;
  });
  assert.throws(() => assertSupportedCopilotSdk(LEGACY_SDK), /^Error: The installed Copilot SDK is older than 1\.0\.113/);
  assert.throws(
    () => assertSupportedCopilotSdk({ RuntimeConnection: { forTcp() {}, forInProcess() {} } }, '1.0.999'),
    (error) => error.code === undefined && /SDK 1\.0\.999 has neither .*\(it exports: forTcp, forInProcess\)/.test(error.message),
  );
  assert.throws(() => assertSupportedCopilotSdk({}), /no RuntimeConnection export/);
  assert.throws(() => assertSupportedCopilotSdk(null, '1.0.50'), /SDK 1\.0\.50 has neither/);
});

test('describeUnverifiedSdk notes only a bundle newer than the newest verified one', () => {
  assert.equal(COPILOT_SDK_NEWEST_VERIFIED, '1.0.114');
  for (const version of ['1.0.113', '1.0.114', 'configured', '', undefined, '1.0.115-beta']) {
    assert.equal(describeUnverifiedSdk(version), null, String(version));
  }
  for (const version of ['1.0.115', '1.1.0', '2.0.0', '1.0.1000']) {
    const note = describeUnverifiedSdk(version);
    assert.match(note, new RegExp(`^Copilot SDK ${version.replace(/\./g, '\\.')} is newer than 1\\.0\\.114`));
    assert.equal(note.includes('\n'), false);
  }
});

// OAR's flat session config, as `buildSessionConfig` builds it, with a stand-in per value.
const handler = (name) => Object.defineProperty(() => {}, 'name', { value: name });
const FLAT_ROWS = [
  ['sessionId', 'conv-1', ['sessionId']],
  ['model', 'gpt-x', ['model']],
  ['workingDirectory', '/workspace/project', ['workingDirectory']],
  ['clientName', 'relay-client', ['clientName']],
  ['suppressResumeEvent', true, ['suppressResumeEvent']],
  ['streaming', true, ['events', 'streaming']],
  ['onEvent', handler('onEvent'), ['events', 'onEvent']],
  ['tools', [{ name: 'ask_user' }, { name: 'relay_tool' }], ['tools', 'definitions']],
  ['availableTools', [], ['tools', 'availableTools']],
  ['onPermissionRequest', handler('onPermissionRequest'), ['permissions', 'onRequest']],
  ['onUserInputRequest', handler('onUserInputRequest'), ['interaction', 'onUserInputRequest']],
  ['onExitPlanModeRequest', handler('onExitPlanModeRequest'), ['interaction', 'onExitPlanModeRequest']],
  ['onElicitationRequest', handler('onElicitationRequest'), ['interaction', 'onElicitationRequest']],
  ['infiniteSessions', { enabled: true }, ['state', 'infiniteSessions']],
];

test('copilotSessionOptions moves each flat option to its grouped name, row by row', () => {
  assert.deepEqual(FLAT_ROWS.map(([key]) => key).sort(), Object.keys(COPILOT_SESSION_OPTION_GROUPS).sort());
  assert.equal(Object.isFrozen(COPILOT_SESSION_OPTION_GROUPS), true);
  for (const [key, value, leafPath] of FLAT_ROWS) {
    const grouped = copilotSessionOptions({ [key]: value });
    const expected = leafPath.length === 1 ? { [key]: value } : { [leafPath[0]]: { [leafPath[1]]: value } };
    assert.deepEqual(grouped, expected, key);
    // The very value, not a copy: handlers and tool definitions stay callable.
    assert.equal(leafPath.reduce((node, name) => node[name], grouped), value, key);
  }
});

test('copilotSessionOptions translates a whole config in one go and leaves no flat key', () => {
  const flat = Object.fromEntries(FLAT_ROWS.map(([key, value]) => [key, value]));
  const grouped = copilotSessionOptions(flat);
  assert.deepEqual(Object.keys(grouped).sort(), [
    'clientName', 'events', 'interaction', 'model', 'permissions', 'sessionId', 'state', 'suppressResumeEvent', 'tools',
    'workingDirectory',
  ]);
  assert.deepEqual(Object.keys(grouped.interaction).sort(), ['onElicitationRequest', 'onExitPlanModeRequest', 'onUserInputRequest']);
  assert.deepEqual(Object.keys(grouped.tools).sort(), ['availableTools', 'definitions']);
  // The input is left as it was.
  assert.equal(flat.onEvent, FLAT_ROWS[6][1]);
});

test('copilotSessionOptions merges the BYOK group objects beside the mapped options', () => {
  const grouped = copilotSessionOptions({
    sessionId: 'conv-1',
    inference: { providers: [{ name: 'openai' }], defaultProvider: 'openai', reasoningEffort: 'high' },
    github: { capi: { enabled: false } },
    streaming: true,
  });
  assert.deepEqual(grouped, {
    sessionId: 'conv-1',
    inference: { providers: [{ name: 'openai' }], defaultProvider: 'openai', reasoningEffort: 'high' },
    github: { capi: { enabled: false } },
    events: { streaming: true },
  });
  // `tools` as an object is the group, merged with the definitions of an array.
  assert.deepEqual(
    copilotSessionOptions({ tools: { availableTools: ['view'] }, onEvent: undefined }),
    { tools: { availableTools: ['view'] } },
  );
  assert.deepEqual(
    copilotSessionOptions({ availableTools: [], tools: { definitions: [{ name: 'relay_tool' }] } }),
    { tools: { availableTools: [], definitions: [{ name: 'relay_tool' }] } },
  );
});

test('copilotSessionOptions leaves out undefined values, at the top and in groups', () => {
  const grouped = copilotSessionOptions({
    sessionId: 'conv-1',
    model: undefined,
    onEvent: undefined,
    infiniteSessions: undefined,
    inference: { reasoningEffort: undefined, defaultProvider: 'openai' },
  });
  assert.deepEqual(grouped, { sessionId: 'conv-1', inference: { defaultProvider: 'openai' } });
  const leaves = [];
  const walk = (node) => {
    for (const value of Object.values(node)) {
      leaves.push(value);
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value);
    }
  };
  walk(copilotSessionOptions(Object.fromEntries(FLAT_ROWS.map(([key, value]) => [key, value]))));
  assert.equal(leaves.includes(undefined), false);
  assert.deepEqual(copilotSessionOptions({}), {});
  assert.deepEqual(copilotSessionOptions(), {});
});

test('copilotSessionOptions throws on a key it has no grouped name for, and on a field set twice', () => {
  assert.throws(() => copilotSessionOptions({ sessionId: 'conv-1', provider: { type: 'openai' } }), (error) => {
    assert.equal(error instanceof TypeError, true);
    assert.match(error.message, /"provider" has no grouped name/);
    return true;
  });
  assert.throws(() => copilotSessionOptions({ reasoningEffort: 'high' }), TypeError);
  assert.throws(() => copilotSessionOptions({ someFutureOption: 1 }), /"someFutureOption" has no grouped name/);
  // A group name with a non-object value is no group.
  assert.throws(() => copilotSessionOptions({ inference: 'openai' }), TypeError);
  assert.throws(
    () => copilotSessionOptions({ streaming: true, events: { streaming: false } }),
    /events\.streaming is set twice/,
  );
  assert.throws(
    () => copilotSessionOptions({ availableTools: [], tools: { availableTools: ['view'] } }),
    /tools\.availableTools is set twice/,
  );
});

// A home folder with Copilot CLI version folders in it, as the CLI lays them
// out. `sdk: false` makes a folder without `copilot-sdk`, like the CLI's
// older "universal" ones.
function fakeHome(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sdk-lookup-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const install = (pkgDir, version, { subdir = 'linux-x64', sdk = true, app = true } = {}) => {
    const versionDir = path.join(pkgDir, subdir, version);
    fs.mkdirSync(versionDir, { recursive: true });
    if (app) fs.writeFileSync(path.join(versionDir, 'app.js'), '');
    if (sdk) {
      fs.mkdirSync(path.join(versionDir, 'copilot-sdk'));
      fs.writeFileSync(path.join(versionDir, 'copilot-sdk', 'index.js'), '');
      fs.writeFileSync(path.join(versionDir, 'copilot-sdk', 'extension.js'), '');
    } else {
      fs.writeFileSync(path.join(versionDir, 'index.js'), '');
    }
    return versionDir;
  };
  const lookup = (options = {}) => resolveInstalledCopilotPaths({ env: {}, platform: 'linux', arch: 'x64', homeDir, ...options });
  return { homeDir, install, lookup };
}

const pathsOf = (versionDir) => ({
  sdkPath: path.join(versionDir, 'copilot-sdk', 'index.js'),
  cliPath: path.join(versionDir, 'app.js'),
});

test('macOS: the cache folder the Copilot CLI writes comes first, the folder searched before stays a later candidate', (t) => {
  assert.deepEqual(getCopilotBaseDirs({ env: {}, platform: 'darwin', homeDir: '/Users/dev' }), [
    '/Users/dev/Library/Caches/copilot/pkg',
    '/Users/dev/.copilot/pkg',
    '/Users/dev/Library/Application Support/copilot/pkg',
  ]);
  assert.deepEqual(getCopilotBaseDirs({
    env: { COPILOT_PKG_DIR: '/opt/copilot-pkg', COPILOT_CACHE_HOME: '/opt/cache', XDG_CACHE_HOME: '/var/cache/dev' },
    platform: 'darwin',
    homeDir: '/Users/dev',
  }), [
    '/opt/copilot-pkg',
    '/opt/cache/pkg',
    '/Users/dev/Library/Caches/copilot/pkg',
    '/Users/dev/.copilot/pkg',
    '/Users/dev/Library/Application Support/copilot/pkg',
  ]);
  // An install in either folder is found; with one in each the newer wins,
  // and at the same version the cache folder.
  const home = fakeHome(t);
  const lookup = (options = {}) => home.lookup({ platform: 'darwin', arch: 'arm64', ...options });
  const subdir = 'darwin-arm64';
  const before = home.install(path.join(home.homeDir, 'Library', 'Application Support', 'copilot', 'pkg'), '1.0.90', { subdir });
  assert.equal(lookup().sdkPath, pathsOf(before).sdkPath);
  const cache = home.install(path.join(home.homeDir, 'Library', 'Caches', 'copilot', 'pkg'), '1.0.90', { subdir });
  assert.equal(lookup().sdkPath, pathsOf(cache).sdkPath);
  const newer = home.install(path.join(home.homeDir, 'Library', 'Application Support', 'copilot', 'pkg'), '1.0.91', { subdir });
  assert.equal(lookup().sdkPath, pathsOf(newer).sdkPath);
});

test('the folders searched on Linux and Windows, in order', () => {
  assert.deepEqual(getCopilotBaseDirs({ env: {}, platform: 'linux', homeDir: '/home/dev' }), [
    '/home/dev/.cache/copilot/pkg',
    '/home/dev/.copilot/pkg',
    '/home/dev/.local/share/copilot/pkg',
  ]);
  assert.deepEqual(getCopilotBaseDirs({
    env: { XDG_CACHE_HOME: '/var/cache/dev', XDG_DATA_HOME: '/var/data/dev' },
    platform: 'linux',
    homeDir: '/home/dev',
  }), [
    '/var/cache/dev/copilot/pkg',
    '/home/dev/.copilot/pkg',
    '/var/data/dev/copilot/pkg',
  ]);
  assert.deepEqual(getCopilotBaseDirs({ env: {}, platform: 'win32', homeDir: 'C:\\Users\\dev' }), [
    'C:\\Users\\dev\\AppData\\Local\\copilot\\pkg',
    'C:\\Users\\dev\\.copilot\\pkg',
  ]);
  assert.deepEqual(getCopilotBaseDirs({
    env: { LOCALAPPDATA: 'D:\\Local' },
    platform: 'win32',
    homeDir: 'C:\\Users\\dev',
  }), [
    'D:\\Local\\copilot\\pkg',
    'C:\\Users\\dev\\.copilot\\pkg',
  ]);
});

test('the overrides come first: COPILOT_PKG_DIR, COPILOT_PKG_CACHE_HOME, COPILOT_CACHE_HOME, and a folder named twice is searched once', () => {
  assert.deepEqual(getCopilotBaseDirs({
    env: {
      COPILOT_PKG_DIR: '/opt/copilot-pkg',
      COPILOT_PKG_CACHE_HOME: '/opt/pkg-cache',
      COPILOT_CACHE_HOME: '/opt/cache',
    },
    platform: 'linux',
    homeDir: '/home/dev',
  }), [
    '/opt/copilot-pkg',
    '/opt/pkg-cache/pkg',
    '/opt/cache/pkg',
    '/home/dev/.cache/copilot/pkg',
    '/home/dev/.copilot/pkg',
    '/home/dev/.local/share/copilot/pkg',
  ]);
  assert.deepEqual(getCopilotBaseDirs({
    env: { COPILOT_PKG_DIR: '/home/dev/.copilot/pkg', COPILOT_CACHE_HOME: '/home/dev/.cache/copilot' },
    platform: 'linux',
    homeDir: '/home/dev',
  }), [
    '/home/dev/.copilot/pkg',
    '/home/dev/.cache/copilot/pkg',
    '/home/dev/.local/share/copilot/pkg',
  ]);
});

test('an install is found in each folder of the search', (t) => {
  const places = [
    ['the cache folder', (homeDir) => path.join(homeDir, '.cache', 'copilot', 'pkg'), {}],
    ['~/.copilot/pkg', (homeDir) => path.join(homeDir, '.copilot', 'pkg'), {}],
    ['the data folder of earlier versions', (homeDir) => path.join(homeDir, '.local', 'share', 'copilot', 'pkg'), {}],
    ['COPILOT_PKG_DIR', (homeDir) => path.join(homeDir, 'own-pkg'), (homeDir) => ({ COPILOT_PKG_DIR: path.join(homeDir, 'own-pkg') })],
    ['COPILOT_PKG_CACHE_HOME', (homeDir) => path.join(homeDir, 'pkg-cache', 'pkg'), (homeDir) => ({ COPILOT_PKG_CACHE_HOME: path.join(homeDir, 'pkg-cache') })],
    ['COPILOT_CACHE_HOME', (homeDir) => path.join(homeDir, 'cache', 'pkg'), (homeDir) => ({ COPILOT_CACHE_HOME: path.join(homeDir, 'cache') })],
    ['XDG_CACHE_HOME', (homeDir) => path.join(homeDir, 'xdg', 'copilot', 'pkg'), (homeDir) => ({ XDG_CACHE_HOME: path.join(homeDir, 'xdg') })],
  ];
  for (const [name, pkgDirOf, envOf] of places) {
    const home = fakeHome(t);
    const versionDir = home.install(pkgDirOf(home.homeDir), '1.0.90');
    const env = typeof envOf === 'function' ? envOf(home.homeDir) : envOf;
    const found = home.lookup({ env });
    assert.deepEqual({ version: found.version, sdkPath: found.sdkPath, cliPath: found.cliPath }, { version: '1.0.90', ...pathsOf(versionDir) }, name);
  }
});

test('the newest version wins wherever it lies; between two folders with the same version the earlier one in the search', (t) => {
  const home = fakeHome(t);
  const cache = path.join(home.homeDir, '.cache', 'copilot', 'pkg');
  const dotCopilot = path.join(home.homeDir, '.copilot', 'pkg');
  home.install(cache, '1.0.9');
  const sameInCache = home.install(cache, '1.0.10');
  home.install(dotCopilot, '1.0.10');
  // 1.0.10 is newer than 1.0.9: by number, not by text.
  assert.deepEqual(pathsOf(sameInCache), { sdkPath: home.lookup().sdkPath, cliPath: home.lookup().cliPath });
  const newer = home.install(dotCopilot, '1.1.0');
  assert.equal(home.lookup().sdkPath, pathsOf(newer).sdkPath);
  assert.equal(home.lookup().version, '1.1.0');
  // An override names a folder to search first, not a version to prefer.
  const own = home.install(path.join(home.homeDir, 'own-pkg'), '1.0.2');
  const env = { COPILOT_PKG_DIR: path.join(home.homeDir, 'own-pkg') };
  assert.equal(home.lookup({ env }).version, '1.1.0');
  assert.equal(home.lookup({ env, config: { sdkVersion: '1.0.2' } }).sdkPath, pathsOf(own).sdkPath);
});

test('a version folder without copilot-sdk, without app.js, or with a name that is no version is passed over', (t) => {
  const home = fakeHome(t);
  const cache = path.join(home.homeDir, '.cache', 'copilot', 'pkg');
  home.install(cache, '1.0.36', { subdir: 'universal', sdk: false });
  home.install(cache, '1.2.0', { sdk: false });
  home.install(cache, '1.3.0', { app: false });
  home.install(cache, '2.0.0-beta');
  home.install(cache, 'latest');
  assert.throws(() => home.lookup(), { code: COPILOT_SDK_NOT_FOUND });
  const whole = home.install(cache, '1.0.90');
  assert.equal(home.lookup().sdkPath, pathsOf(whole).sdkPath);
});

test('a configured sdkPath: with cliPath the two as given, alone the version folder it lies in, else the search', (t) => {
  const home = fakeHome(t);
  const cache = path.join(home.homeDir, '.cache', 'copilot', 'pkg');
  const newest = home.install(cache, '1.0.90');
  const pinned = home.install(path.join(home.homeDir, 'pinned'), '1.0.50');
  // Both given: unchecked, nothing is read.
  assert.deepEqual(home.lookup({ config: { sdkPath: '/opt/sdk/index.js', cliPath: '/opt/cli/app.js' } }), {
    sdkPath: path.resolve('/opt/sdk/index.js'),
    cliPath: path.resolve('/opt/cli/app.js'),
    version: 'configured',
  });
  // Alone: the app.js beside the SDK's folder, so the two are of one version.
  assert.deepEqual(home.lookup({ config: { sdkPath: pathsOf(pinned).sdkPath } }), { ...pathsOf(pinned), version: '1.0.50' });
  // Alone and not an install: the search.
  assert.equal(home.lookup({ config: { sdkPath: path.join(home.homeDir, 'nowhere', 'copilot-sdk', 'index.js') } }).sdkPath, pathsOf(newest).sdkPath);
});

test('with no install the lookup fails with a code and a message that names what to do and every folder searched', (t) => {
  const home = fakeHome(t);
  const env = { COPILOT_PKG_DIR: path.join(home.homeDir, 'own-pkg') };
  const searched = [
    path.join(home.homeDir, 'own-pkg'),
    // The lookup is asked as on Linux, and joins as Linux does on any host.
    path.posix.join(home.homeDir, '.cache', 'copilot', 'pkg'),
    path.posix.join(home.homeDir, '.copilot', 'pkg'),
    path.posix.join(home.homeDir, '.local', 'share', 'copilot', 'pkg'),
  ];
  assert.throws(() => home.lookup({ env }), (error) => {
    assert.equal(error.code, COPILOT_SDK_NOT_FOUND);
    assert.deepEqual(error.searched, searched);
    assert.equal(
      error.message,
      'Copilot SDK not found. Install the GitHub Copilot CLI and run it once (copilot --version); '
      + `no relay restart is needed. Looked in: ${searched.join(', ')} `
      + '(for linux-x64/<version>/copilot-sdk/index.js with app.js beside the folder)',
    );
    return true;
  });
  home.install(searched[1], '1.0.90');
  assert.throws(() => home.lookup({ config: { sdkVersion: '1.0.91' } }), /^Error: Copilot SDK version 1\.0\.91 not found\. /);
});

test('a launch asks again each time: an update is found, a folder that is gone is not used, and none left is the failure', (t) => {
  const home = fakeHome(t);
  const cache = path.join(home.homeDir, '.cache', 'copilot', 'pkg');
  const launchPath = (options = {}) => resolveCopilotSdkLaunchPath({ env: {}, platform: 'linux', arch: 'x64', homeDir: home.homeDir, ...options });
  assert.throws(() => launchPath(), { code: COPILOT_SDK_NOT_FOUND });
  const first = home.install(cache, '1.0.89');
  assert.equal(launchPath(), path.join(first, 'copilot-sdk'));
  // An update adds a folder and leaves the old one.
  const second = home.install(cache, '1.0.90');
  assert.equal(launchPath(), path.join(second, 'copilot-sdk'));
  fs.rmSync(second, { recursive: true });
  assert.equal(launchPath(), path.join(first, 'copilot-sdk'));
  fs.rmSync(first, { recursive: true });
  assert.throws(() => launchPath(), { code: COPILOT_SDK_NOT_FOUND });
});

test('a launch takes COPILOT_SDK_PATH from the environment as given, a configured sdkPath by its version folder, and never the configured cliPath', (t) => {
  const home = fakeHome(t);
  const newest = home.install(path.join(home.homeDir, '.cache', 'copilot', 'pkg'), '1.0.90');
  const pinned = home.install(path.join(home.homeDir, 'pinned'), '1.0.50');
  const launchPath = (options = {}) => resolveCopilotSdkLaunchPath({ env: {}, platform: 'linux', arch: 'x64', homeDir: home.homeDir, ...options });
  assert.equal(launchPath({ env: { COPILOT_SDK_PATH: ' /opt/own/copilot-sdk ' } }), '/opt/own/copilot-sdk');
  assert.equal(launchPath({ config: { sdkPath: pathsOf(pinned).sdkPath } }), path.join(pinned, 'copilot-sdk'));
  // With a cliPath the relay's own clients take the pair unchecked; a worker
  // starts the app.js beside its SDK, so the launch looks the SDK up.
  assert.equal(launchPath({ config: { sdkPath: '/opt/sdk/index.js', cliPath: '/opt/cli/app.js' } }), path.join(newest, 'copilot-sdk'));
  assert.equal(launchPath({ config: { sdkPath: pathsOf(pinned).sdkPath, cliPath: '/opt/cli/app.js' } }), path.join(pinned, 'copilot-sdk'));
});

test('the relay\'s own client refuses an SDK older than 1.0.113 before it builds a CopilotClient', async (t) => {
  const home = fakeHome(t);
  const versionDir = home.install(path.join(home.homeDir, 'pinned'), '1.0.112');
  const { sdkPath } = pathsOf(versionDir);
  // A stand-in SDK of the older shape: only `forStdio`, and a client that
  // records being built.
  fs.writeFileSync(sdkPath, [
    'export const constructed = [];',
    'export class CopilotClient { constructor(options) { constructed.push(options); } async start() {} }',
    'export const RuntimeConnection = { forStdio: (opts) => ({ kind: \'stdio\', path: opts.path }) };',
  ].join('\n'));
  await assert.rejects(
    createInstalledCopilotClient({ config: { sdkPath } }),
    { code: COPILOT_SDK_TOO_OLD, message: /Copilot SDK 1\.0\.112 is older than 1\.0\.113.*Update the Copilot CLI/ },
  );
  const { constructed } = await import(pathToFileURL(sdkPath).href);
  assert.deepEqual(constructed, []);
});
