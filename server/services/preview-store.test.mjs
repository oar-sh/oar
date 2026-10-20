import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  createMemoryPreviewStore,
  createSqlitePreviewStore,
  isSameHostBoot,
  previewRecordToRow,
  readHostBootId,
} from './preview-store.mjs';
import { createPreviewRegistry, normalizePreviewsConfig } from './preview-registry-service.mjs';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

function staticRecord(overrides = {}) {
  return {
    token: TOKEN_A,
    mode: 'static',
    conversationId: 'conv-1',
    label: 'site',
    rootDir: '/home/dev/site',
    createdAt: 1_000,
    lastHitAt: null,
    hostBootId: 'linux:boot-1',
    ...overrides,
  };
}

function portRecord(overrides = {}) {
  return {
    token: TOKEN_B,
    mode: 'port',
    conversationId: 'conv-2',
    label: 'web app',
    targetHost: '127.0.0.1',
    targetPort: 5173,
    createdAt: 2_000,
    hostBootId: 'linux:boot-1',
    ...overrides,
  };
}

for (const [name, makeStore] of [
  ['sqlite', () => {
    const db = new Database(':memory:');
    applySchema(db);
    return createSqlitePreviewStore(db);
  }],
  ['memory', () => createMemoryPreviewStore()],
]) {
  test(`${name} store: insert, list, touch, remove, removeForConversation`, () => {
    const store = makeStore();
    assert.equal(store.available, true);
    assert.equal(store.insert(staticRecord()), true);
    assert.equal(store.insert(portRecord()), true);
    assert.equal(store.insert({ token: 'not-a-token', mode: 'static' }), false);
    assert.deepEqual(store.list(), [
      {
        token: TOKEN_A, mode: 'static', conversationId: 'conv-1', label: 'site',
        targetHost: null, targetPort: null, rootDir: '/home/dev/site',
        createdAt: 1_000, lastHitAt: null, hostBootId: 'linux:boot-1',
      },
      {
        token: TOKEN_B, mode: 'port', conversationId: 'conv-2', label: 'web app',
        targetHost: '127.0.0.1', targetPort: 5173, rootDir: null,
        createdAt: 2_000, lastHitAt: null, hostBootId: 'linux:boot-1',
      },
    ]);
    assert.equal(store.touch(TOKEN_A, 5_000), true);
    assert.equal(store.list()[0].lastHitAt, 5_000);
    assert.equal(store.removeForConversation('conv-2'), 1);
    assert.equal(store.remove(TOKEN_A), true);
    assert.equal(store.remove(TOKEN_A), false);
    assert.deepEqual(store.list(), []);
  });

  test(`${name} store: a conversation delete can leave named rows`, () => {
    const store = makeStore();
    store.insert(staticRecord());
    store.insert(staticRecord({ token: TOKEN_B, rootDir: '/home/dev/other', createdAt: 2_000 }));
    store.insert(portRecord({ token: 'c'.repeat(32) }));
    assert.equal(store.removeForConversation('conv-1', { exceptTokens: [TOKEN_B] }), 1);
    assert.deepEqual(store.list().map((row) => row.token), [TOKEN_B, 'c'.repeat(32)]);
    assert.equal(store.removeForConversation('conv-1', { exceptTokens: [] }), 1);
    assert.deepEqual(store.list().map((row) => row.token), ['c'.repeat(32)]);
  });
}

test('a flush on a locked database returns within the shutdown\'s time, and the connection keeps its own wait', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-store-lock-'));
  const file = path.join(dir, 'relay.db');
  const db = new Database(file);
  let other = null;
  // Closed before the folder goes: Windows refuses to delete a database file
  // a connection still holds open.
  t.after(() => {
    other?.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  applySchema(db);
  const registry = createPreviewRegistry({
    config: normalizePreviewsConfig({ enabled: true, publicBaseUrl: 'https://preview.example.com' }, { env: {}, relayPort: 3333 }),
    store: createSqlitePreviewStore(db),
    logger: { log() {}, warn() {} },
  });
  const previews = ['a', 'b', 'c'].map((name) => registry.createStatic({ rootDir: `/home/dev/${name}` }).preview);
  for (const preview of previews) registry.recordHit(preview.token, 1_000);
  for (const preview of previews) registry.recordHit(preview.token, 2_000);
  const waitBefore = db.pragma('busy_timeout', { simple: true });
  assert.ok(waitBefore >= 2_000, 'the driver waits seconds by default');

  other = new Database(file);
  other.exec('BEGIN EXCLUSIVE');
  const startedAt = Date.now();
  registry.flushHits();
  const took = Date.now() - startedAt;
  assert.ok(took < 1_500, `the flush took ${took} ms`);
  assert.equal(db.pragma('busy_timeout', { simple: true }), waitBefore);

  other.exec('ROLLBACK');
  registry.flushHits();
  assert.deepEqual(createSqlitePreviewStore(db).list().map((row) => row.lastHitAt), [2_000, 2_000, 2_000]);
});

test('sqlite store without the table is a no-op instead of throwing', () => {
  const db = new Database(':memory:');
  const store = createSqlitePreviewStore(db);
  assert.equal(store.available, false);
  assert.equal(store.insert(staticRecord()), false);
  assert.deepEqual(store.list(), []);
});

test('a token not in canonical form is never written, and a stored one lists and deletes as stored', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const store = createSqlitePreviewStore(db);
  const upper = 'A'.repeat(32);
  assert.equal(store.insert(staticRecord({ token: upper })), false);
  assert.equal(store.insert(staticRecord({ token: ` ${TOKEN_A}` })), false);
  assert.deepEqual(store.list(), []);
  // A row the relay did not write itself (hand written, another tool).
  db.prepare(`INSERT INTO previews (token, mode, label, root_dir, created_at) VALUES (?, 'static', 'site', '/home/dev/site', 1)`).run(upper);
  assert.equal(store.list()[0].token, upper);
  assert.equal(store.remove(upper), true);
  assert.deepEqual(store.list(), []);
});

test('a row keeps only the columns of its mode', () => {
  const row = previewRecordToRow(staticRecord({ targetHost: '127.0.0.1', targetPort: 80, createdAt: '1970-01-01T00:00:01.000Z' }));
  assert.equal(row.target_host, null);
  assert.equal(row.target_port, null);
  assert.equal(row.created_at, 1_000);
  assert.equal(previewRecordToRow(portRecord({ rootDir: '/home/dev/x' })).root_dir, null);
});

test('readHostBootId uses the kernel boot id on Linux', () => {
  const id = readHostBootId({
    platform: 'linux',
    readFileSync: () => '3f1c0d2e-0000-4000-8000-000000000001\n',
  });
  assert.equal(id, 'linux:3f1c0d2e-0000-4000-8000-000000000001');
});

test('readHostBootId uses the boot session uuid on macOS', () => {
  const calls = [];
  const id = readHostBootId({
    platform: 'darwin',
    execFileSync: (cmd, args) => { calls.push([cmd, ...args]); return 'ABCDEF00-1111-2222-3333-444455556666\n'; },
  });
  assert.deepEqual(calls, [['sysctl', '-n', 'kern.bootsessionuuid']]);
  assert.equal(id, 'darwin:ABCDEF00-1111-2222-3333-444455556666');
});

test('readHostBootId falls back to the boot time elsewhere and on a failed read', () => {
  const win = readHostBootId({ platform: 'win32', uptime: () => 3_600, now: () => 10_000_000 });
  assert.equal(win, 'boot-time:6400');
  const linuxFailed = readHostBootId({
    platform: 'linux',
    readFileSync: () => { throw new Error('ENOENT'); },
    uptime: () => 100,
    now: () => 1_000_000,
  });
  assert.equal(linuxFailed, 'boot-time:900');
});

test('isSameHostBoot compares opaque ids exactly and boot times with a tolerance', () => {
  assert.equal(isSameHostBoot('linux:a', 'linux:a'), true);
  assert.equal(isSameHostBoot('linux:a', 'linux:b'), false);
  assert.equal(isSameHostBoot('boot-time:6400', 'boot-time:6460'), true);
  assert.equal(isSameHostBoot('boot-time:6400', 'boot-time:9000'), false);
  assert.equal(isSameHostBoot('', ''), false);
  assert.equal(isSameHostBoot(null, 'linux:a'), false);
});
