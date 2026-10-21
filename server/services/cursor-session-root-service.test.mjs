import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCursorSessionRootResolver,
  resolveCursorAgentStoreDir,
  resolveCursorSessionStoreDir,
} from './cursor-session-root-service.mjs';

const SDK_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeStoreDir({ withSessionDir = true } = {}) {
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-root-'));
  const storeDir = path.join(serverDir, 'data', 'cursor-agents');
  if (withSessionDir) fs.mkdirSync(path.join(storeDir, SDK_SESSION_ID), { recursive: true });
  return { serverDir, storeDir };
}

test('the store dir prefers CURSOR_AGENT_STORE_DIR over the server-relative default', () => {
  assert.equal(
    resolveCursorAgentStoreDir({ env: { CURSOR_AGENT_STORE_DIR: '/custom/store' }, serverDir: '/srv/server' }),
    '/custom/store',
  );
  assert.equal(
    resolveCursorAgentStoreDir({ env: {}, serverDir: '/srv/server' }),
    path.join('/srv/server', 'data', 'cursor-agents'),
  );
  assert.equal(resolveCursorAgentStoreDir({ env: {}, serverDir: '' }), '');
});

test('an existing per-session store directory resolves as the session root', () => {
  const { serverDir, storeDir } = makeStoreDir();
  try {
    const { resolveCursorSessionRoot } = createCursorSessionRootResolver({ env: {}, serverDir });
    assert.deepEqual(resolveCursorSessionRoot({ sdkSessionId: SDK_SESSION_ID }), {
      sessionRootPath: path.join(storeDir, SDK_SESSION_ID),
      sessionRootName: 'Session',
    });
  } finally {
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
});

test('a session with no store directory yet resolves to null, not an error', () => {
  const { serverDir } = makeStoreDir({ withSessionDir: false });
  try {
    const { resolveCursorSessionRoot } = createCursorSessionRootResolver({ env: {}, serverDir });
    assert.equal(resolveCursorSessionRoot({ sdkSessionId: SDK_SESSION_ID }), null);
  } finally {
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
});

test('unsafe or empty session ids never reach the filesystem', () => {
  const statCalls = [];
  const { resolveCursorSessionRoot } = createCursorSessionRootResolver({
    env: {},
    serverDir: '/srv/server',
    fs: { statSync: (target) => { statCalls.push(target); throw new Error('should not be called'); } },
  });
  assert.equal(resolveCursorSessionRoot({ sdkSessionId: '' }), null);
  assert.equal(resolveCursorSessionRoot({ sdkSessionId: '../escape' }), null);
  assert.equal(resolveCursorSessionRoot({ sdkSessionId: 'a/b' }), null);
  assert.equal(resolveCursorSessionRoot({ sdkSessionId: '.hidden' }), null);
  assert.equal(statCalls.length, 0);
});

test('a file (not directory) at the session path resolves to null', () => {
  const { serverDir, storeDir } = makeStoreDir({ withSessionDir: false });
  try {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, SDK_SESSION_ID), 'not a directory');
    const { resolveCursorSessionRoot } = createCursorSessionRootResolver({ env: {}, serverDir });
    assert.equal(resolveCursorSessionRoot({ sdkSessionId: SDK_SESSION_ID }), null);
  } finally {
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
});

// ─── The store follows the relay's data dir ──────────────────────────────────

test('the store lives in the relay data dir: env var, then config dataDir, then <server>/data', () => {
  const serverDir = '/srv/oar/server';
  const configPath = '/home/dev/.oar/config.json';
  const configFs = { readFileSync: () => JSON.stringify({ dataDir: 'relay-data' }) };
  assert.equal(
    resolveCursorAgentStoreDir({ env: { COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/.oar/data' }, serverDir, configPath, fs: configFs }),
    // The data dir is resolved (on Windows onto the current drive).
    path.resolve('/home/dev/.oar/data', 'cursor-agents'),
  );
  assert.equal(
    resolveCursorAgentStoreDir({ env: {}, serverDir, configPath, fs: configFs }),
    path.resolve('/home/dev/.oar', 'relay-data', 'cursor-agents'),
  );
  assert.equal(
    resolveCursorAgentStoreDir({ env: {}, serverDir, configPath, fs: { readFileSync: () => '{}' } }),
    path.join(serverDir, 'data', 'cursor-agents'),
  );
  assert.equal(
    resolveCursorAgentStoreDir({
      env: { CURSOR_AGENT_STORE_DIR: '/custom/store', COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/.oar/data' },
      serverDir,
      configPath,
      fs: configFs,
    }),
    '/custom/store',
  );
});

test('the session root of a relay with its own data dir is found there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-root-'));
  try {
    const serverDir = path.join(root, 'package', 'server');
    const dataDir = path.join(root, 'state', 'data');
    fs.mkdirSync(path.join(dataDir, 'cursor-agents', SDK_SESSION_ID), { recursive: true });
    const { resolveCursorSessionRoot } = createCursorSessionRootResolver({
      env: { COPILOT_WEB_RELAY_DATA_DIR: dataDir },
      serverDir,
    });
    assert.deepEqual(resolveCursorSessionRoot({ sdkSessionId: SDK_SESSION_ID }), {
      sessionRootPath: path.join(dataDir, 'cursor-agents', SDK_SESSION_ID),
      sessionRootName: 'Session',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a session whose store is still at the old default is used in place, never moved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-root-'));
  try {
    const serverDir = path.join(root, 'checkout', 'server');
    const dataDir = path.join(root, 'state', 'data');
    const oldStore = path.join(serverDir, 'data', 'cursor-agents');
    const newStore = path.join(dataDir, 'cursor-agents');
    fs.mkdirSync(path.join(oldStore, SDK_SESSION_ID), { recursive: true });
    fs.writeFileSync(path.join(oldStore, SDK_SESSION_ID, 'agent.db'), 'agent');
    const env = { COPILOT_WEB_RELAY_DATA_DIR: dataDir };

    assert.equal(resolveCursorSessionStoreDir({ env, serverDir, sdkSessionId: SDK_SESSION_ID }), oldStore);
    assert.equal(
      createCursorSessionRootResolver({ env, serverDir }).resolveCursorSessionRoot({ sdkSessionId: SDK_SESSION_ID }).sessionRootPath,
      path.join(oldStore, SDK_SESSION_ID),
    );
    assert.ok(fs.existsSync(path.join(oldStore, SDK_SESSION_ID, 'agent.db')), 'nothing moved or deleted');
    // A new session uses the new place.
    assert.equal(resolveCursorSessionStoreDir({ env, serverDir, sdkSessionId: 'another-session' }), newStore);
    // In both places, the store whose agent.db changed last wins.
    fs.mkdirSync(path.join(newStore, SDK_SESSION_ID), { recursive: true });
    fs.writeFileSync(path.join(newStore, SDK_SESSION_ID, 'agent.db'), 'copy');
    fs.utimesSync(path.join(newStore, SDK_SESSION_ID, 'agent.db'), new Date(1_000_000), new Date(1_000_000));
    fs.utimesSync(path.join(oldStore, SDK_SESSION_ID, 'agent.db'), new Date(2_000_000), new Date(2_000_000));
    assert.equal(resolveCursorSessionStoreDir({ env, serverDir, sdkSessionId: SDK_SESSION_ID }), oldStore);
    fs.utimesSync(path.join(newStore, SDK_SESSION_ID, 'agent.db'), new Date(3_000_000), new Date(3_000_000));
    assert.equal(resolveCursorSessionStoreDir({ env, serverDir, sdkSessionId: SDK_SESSION_ID }), newStore);
    assert.ok(fs.existsSync(path.join(oldStore, SDK_SESSION_ID, 'agent.db')), 'still nothing deleted');
    // CURSOR_AGENT_STORE_DIR is taken as given.
    assert.equal(
      resolveCursorSessionStoreDir({ env: { ...env, CURSOR_AGENT_STORE_DIR: '/custom/store' }, serverDir, sdkSessionId: SDK_SESSION_ID }),
      '/custom/store',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the relay hands its resolved data dir in, so no lookup reads config.json', () => {
  const reads = [];
  const fakeFs = {
    readFileSync: (target) => { reads.push(target); return '{"dataDir":"elsewhere"}'; },
    statSync: () => ({ isDirectory: () => true }),
  };
  const { resolveCursorSessionRoot } = createCursorSessionRootResolver({
    env: {},
    serverDir: '/srv/oar/server',
    configPath: '/home/dev/.oar/config.json',
    dataDir: '/home/dev/.oar/data',
    fs: fakeFs,
  });
  assert.equal(
    resolveCursorSessionRoot({ sdkSessionId: SDK_SESSION_ID }).sessionRootPath,
    path.join('/home/dev/.oar/data', 'cursor-agents', SDK_SESSION_ID),
  );
  assert.deepEqual(reads, []);
});
