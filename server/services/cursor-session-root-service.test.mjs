import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCursorSessionRootResolver,
  resolveCursorAgentStoreDir,
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
