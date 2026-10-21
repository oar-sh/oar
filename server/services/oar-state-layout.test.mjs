import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  getLauncherLogDir,
  resolveLayoutStateDirs,
  resolveRelayStateDirs,
  resolveStateLayout,
} from './oar-state-layout.mjs';

// Placeholder-host literals; platform, path semantics and the file system are
// injected, so nothing here reads the machine running the tests.
const APPDATA = 'C:\\Users\\dev\\AppData\\Roaming';
const LOCALAPPDATA = 'C:\\Users\\dev\\AppData\\Local';
const INSTALLED = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@oar-sh\\oar';
const CHECKOUT = 'C:\\Users\\dev\\oar';
const ENV = { APPDATA, LOCALAPPDATA };

const fsWith = (...existing) => ({ existsSync: (p) => existing.includes(String(p)) });
const win = { platform: 'win32', pathImpl: path.win32, fsImpl: fsWith(path.win32.join(CHECKOUT, '.git')) };

test('a global install keeps data and logs in the OAR state root', () => {
  const layout = resolveStateLayout({ packageRoot: INSTALLED, env: ENV, ...win });
  assert.equal(layout.checkout, false);
  assert.equal(layout.dataDir, 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data');
  assert.deepEqual(resolveRelayStateDirs({ packageRoot: INSTALLED, env: ENV, ...win }), {
    dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data',
    logDir: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\logs',
  });
});

test('folders the environment names win, in a global install and in a checkout', () => {
  const env = {
    ...ENV,
    COPILOT_WEB_RELAY_DATA_DIR: ' D:\\relay\\data ',
    COPILOT_WEB_RELAY_LOG_DIR: 'D:\\relay\\logs',
  };
  for (const packageRoot of [INSTALLED, CHECKOUT]) {
    assert.deepEqual(resolveRelayStateDirs({ packageRoot, env, ...win }), {
      dataDir: 'D:\\relay\\data',
      logDir: 'D:\\relay\\logs',
    });
  }
});

test('a checkout pins nothing of its own: the relay keeps its server-relative defaults', () => {
  assert.equal(resolveStateLayout({ packageRoot: CHECKOUT, env: ENV, ...win }).checkout, true);
  assert.deepEqual(resolveRelayStateDirs({ packageRoot: CHECKOUT, env: ENV, ...win }), { dataDir: '', logDir: '' });
  // The `oar copilot` launcher still needs somewhere for its own server.log.
  const layout = resolveStateLayout({ packageRoot: CHECKOUT, env: ENV, ...win });
  assert.equal(
    getLauncherLogDir(ENV, layout, { platform: 'win32', pathImpl: path.win32 }),
    'C:\\Users\\dev\\AppData\\Local\\copilot-remote\\logs',
  );
});

test('an automatic repair pins the layout\'s folders, and only on a relay that runs on them', () => {
  const layoutDirs = {
    dataDir: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\data',
    logDir: 'C:\\Users\\dev\\AppData\\Roaming\\oar\\logs',
  };
  assert.deepEqual(resolveLayoutStateDirs({ packageRoot: INSTALLED, env: ENV, ...win }), layoutDirs);
  // What `oar start` sets, in another case: still the same folders.
  assert.deepEqual(resolveLayoutStateDirs({
    packageRoot: INSTALLED,
    env: { ...ENV, COPILOT_WEB_RELAY_DATA_DIR: layoutDirs.dataDir.toUpperCase(), COPILOT_WEB_RELAY_LOG_DIR: layoutDirs.logDir },
    ...win,
  }), layoutDirs);
  assert.equal(resolveLayoutStateDirs({
    packageRoot: INSTALLED, env: { ...ENV, COPILOT_WEB_RELAY_DATA_DIR: 'D:\\scratch' }, ...win,
  }), null);
  assert.equal(resolveLayoutStateDirs({
    packageRoot: INSTALLED, env: { ...ENV, COPILOT_WEB_RELAY_LOG_DIR: 'D:\\scratch-logs' }, ...win,
  }), null);
  assert.equal(resolveLayoutStateDirs({ packageRoot: CHECKOUT, env: ENV, ...win }), null);
});
