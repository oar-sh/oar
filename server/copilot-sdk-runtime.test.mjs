import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildInstalledCopilotClientOptions,
  COPILOT_SDK_NOT_FOUND,
  getCopilotBaseDirs,
  resolveCopilotSdkLaunchPath,
  resolveInstalledCopilotPaths,
} from './copilot-sdk-runtime.mjs';

test('buildInstalledCopilotClientOptions configures a restricted importer client', () => {
  assert.deepEqual(
    buildInstalledCopilotClientOptions({
      cliPath: '/opt/copilot/app.js',
      cwd: '/workspace/project',
      baseDirectory: '/home/tester/.copilot',
      logLevel: 'error',
    }),
    {
      connection: {
        kind: 'stdio',
        path: '/opt/copilot/app.js',
      },
      mode: 'empty',
      baseDirectory: '/home/tester/.copilot',
      useLoggedInUser: true,
      logLevel: 'error',
      workingDirectory: '/workspace/project',
    },
  );
});

test('an omitted baseDirectory defaults to ~/.copilot (runtime 1.0.83 refuses empty mode without one)', () => {
  const options = buildInstalledCopilotClientOptions({ cliPath: '/opt/copilot/app.js' });
  // The runtime's own pre-1.0.83 default, made explicit: the import sweep and
  // model discovery must keep seeing the CLI's real session state.
  assert.equal(options.baseDirectory, path.join(os.homedir(), '.copilot'));
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
