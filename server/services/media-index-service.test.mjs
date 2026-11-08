import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createFilePresenceCache, createMediaIndexService } from './media-index-service.mjs';

const NOW = '2026-11-01T10:00:00.000Z';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, runtime_workspace_root_path) VALUES ('c1', 'Fixture', ?, ?, '/srv/demo')`).run(NOW, NOW);
  return db;
}

function addMessage(db, id, text, role = 'assistant') {
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, 'c1', ?, ?, ?)`).run(id, role, text, NOW);
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, unref() {} };
      pending.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      const index = pending.indexOf(handle);
      if (index >= 0) pending.splice(index, 1);
    },
    runNext() {
      const handle = pending.shift();
      handle?.fn();
      return Boolean(handle);
    },
  };
}

const items = (db) => db.prepare(`SELECT message_id AS m, ordinal AS o, locator AS l, sender AS s FROM media_items ORDER BY message_id, ordinal`).all();

test('drain indexes queued messages in batches and empties the queue', () => {
  const db = setup();
  for (let i = 0; i < 7; i += 1) addMessage(db, `m${i}`, `![p](/srv/demo/p${i}.png) and ![rel](img/q${i}.jpg)`);
  addMessage(db, 'plain', 'no pictures');
  const service = createMediaIndexService({ db, platform: 'linux', batchSize: 3 });
  assert.deepEqual(service.drain({ maxMessages: 5 }), { indexed: 5, items: 10, pending: 3 });
  assert.deepEqual(service.drain({ maxMessages: 100 }), { indexed: 3, items: 4, pending: 0 });
  const rows = items(db);
  assert.equal(rows.length, 14);
  assert.deepEqual(rows.slice(0, 2), [
    { m: 'm0', o: 0, l: '/srv/demo/p0.png', s: 'agent' },
    { m: 'm0', o: 1, l: '/srv/demo/img/q0.jpg', s: 'agent' },
  ]);
});

test('a changed message is re-indexed: its rows are replaced, not added', () => {
  const db = setup();
  addMessage(db, 'm1', '![a](/srv/demo/a.png) ![b](/srv/demo/b.png)');
  const service = createMediaIndexService({ db, platform: 'linux' });
  service.drain({ maxMessages: 10 });
  db.prepare(`UPDATE messages SET text = '![c](/srv/demo/c.png)' WHERE id = 'm1'`).run();
  assert.equal(service.pendingCount(), 1);
  service.drain({ maxMessages: 10 });
  assert.deepEqual(items(db).map((row) => row.l), ['/srv/demo/c.png']);
});

test('a message that disappears from the queue meanwhile is simply not indexed', () => {
  const db = setup();
  addMessage(db, 'm1', '![a](/srv/demo/a.png)');
  addMessage(db, 'm2', '![b](/srv/demo/b.png)');
  db.prepare(`DELETE FROM messages WHERE id = 'm1'`).run();
  const service = createMediaIndexService({ db, platform: 'linux' });
  assert.deepEqual(service.drain({ maxMessages: 10 }), { indexed: 1, items: 1, pending: 0 });
});

test('an extractor error drops that message from the queue instead of blocking it', () => {
  const db = setup();
  addMessage(db, 'bad', 'x');
  addMessage(db, 'good', '![a](/srv/demo/a.png)');
  const warnings = [];
  const service = createMediaIndexService({
    db,
    platform: 'linux',
    logger: { warn: (line) => warnings.push(line) },
    extract: (message) => {
      if (message.messageId === 'bad') throw new Error('boom');
      return [{ ordinal: 0, origin: 'embedded', locatorKind: 'local_path', locator: '/srv/demo/a.png', identityKey: 'path:/srv/demo/a.png', category: 'media', mediaKind: 'image' }];
    },
  });
  assert.deepEqual(service.drain({ maxMessages: 10 }), { indexed: 2, items: 1, pending: 0 });
  assert.equal(warnings.length, 1);
});

test('the background loop runs only while the queue has rows', () => {
  const db = setup();
  for (let i = 0; i < 5; i += 1) addMessage(db, `m${i}`, `![p](/srv/demo/p${i}.png)`);
  const timers = fakeTimers();
  // Each clock read moves 15 ms: a 20 ms slice indexes two messages.
  let clock = 0;
  const service = createMediaIndexService({ db, platform: 'linux', ...timers, now: () => (clock += 15) });
  service.start();
  assert.equal(timers.pending.length, 1);
  timers.runNext(); // 2 indexed, 3 left
  timers.runNext(); // 2 indexed, 1 left
  timers.runNext(); // 1 indexed, empty: no new timer
  assert.equal(service.pendingCount(), 0);
  assert.equal(timers.pending.length, 0, 'an idle relay runs no gallery timer');

  addMessage(db, 'later', '![p](/srv/demo/later.png)');
  assert.equal(timers.pending.length, 0, 'triggers do not wake the loop');
  assert.deepEqual(service.drainForRequest(), { indexed: 1, items: 1, pending: 0 });
  assert.equal(timers.pending.length, 0);
  service.stop();
});

test('a request drains a bounded amount and leaves the rest to the loop; stop clears the timer', () => {
  const db = setup();
  db.transaction(() => {
    for (let i = 0; i < 620; i += 1) addMessage(db, `m${i}`, 'text');
  })();
  const timers = fakeTimers();
  const service = createMediaIndexService({ db, platform: 'linux', ...timers, now: () => 0 });
  service.start();
  assert.equal(timers.pending.length, 1);
  const result = service.drainForRequest();
  assert.equal(result.indexed, 200);
  assert.equal(result.pending, 420);
  assert.equal(timers.pending.length, 1, 'the loop already waiting is not doubled');
  service.stop();
  assert.equal(timers.pending.length, 0);
  assert.equal(service.drainForRequest().pending, 220, 'a stopped service still answers requests');
  assert.equal(timers.pending.length, 0, 'but starts no loop');
});

test('a drain stops at its time budget, after a whole message', () => {
  const db = setup();
  for (let i = 0; i < 10; i += 1) addMessage(db, `m${i}`, `![p](/srv/demo/p${i}.png)`);
  let clock = 0;
  const service = createMediaIndexService({ db, platform: 'linux', now: () => (clock += 10) });
  const result = service.drain({ maxMessages: 100, budgetMs: 35 });
  // Clock reads 10 (start), 20, 30, 40, 50: the fourth message crosses 35 ms.
  assert.deepEqual(result, { indexed: 4, items: 4, pending: 6 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_items').get().n, 4);
});

test('a schema without the migration: nothing to drain, no timer', () => {
  const timers = fakeTimers();
  const service = createMediaIndexService({ db: new Database(':memory:'), ...timers });
  service.start();
  assert.equal(service.available, false);
  assert.deepEqual(service.drainForRequest(), { indexed: 0, items: 0, pending: 0 });
  assert.equal(timers.pending.length, 0);
});

test('file presence: cached for the TTL, missing files and timeouts are false', async () => {
  let clock = 0;
  const calls = [];
  const cache = createFilePresenceCache({
    now: () => clock,
    ttlMs: 1000,
    timeoutMs: 20,
    stat: async (file) => {
      calls.push(file);
      if (file === '/slow') return new Promise(() => {});
      if (file === '/dir') return { isFile: () => false };
      if (file === '/gone') throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
  });
  assert.equal(await cache.isFile('/a.png'), true);
  assert.equal(await cache.isFile('/a.png'), true);
  assert.equal(calls.filter((file) => file === '/a.png').length, 1);
  assert.equal(await cache.isFile('/gone'), false);
  assert.equal(await cache.isFile('/dir'), false);
  assert.equal(await cache.isFile('/slow'), false);
  assert.equal(await cache.isFile(''), false);
  clock = 2000;
  await cache.isFile('/a.png');
  assert.equal(calls.filter((file) => file === '/a.png').length, 2, 'asked again after the TTL');
  await cache.isFile('/slow');
  assert.equal(calls.filter((file) => file === '/slow').length, 2, 'a timeout is not cached');
});

test('file presence: the cache is bounded', async () => {
  const cache = createFilePresenceCache({ maxEntries: 3, stat: async () => ({ isFile: () => true }) });
  for (const file of ['/1', '/2', '/3', '/4', '/5']) await cache.isFile(file);
  assert.equal(cache.size(), 3);
});

test('a message body over a megabyte is read only at the start of a slice', () => {
  const db = setup();
  addMessage(db, 'small-1', '![a](/srv/demo/a.png)');
  addMessage(db, 'huge', `![b](/srv/demo/b.png) ${'x'.repeat(1024 * 1024 + 10)}`);
  addMessage(db, 'small-2', '![c](/srv/demo/c.png)');
  const service = createMediaIndexService({ db, platform: 'linux', now: () => 0 });
  assert.deepEqual(service.drain({ maxMessages: 10 }), { indexed: 1, items: 1, pending: 2 }, 'the slice ends before the large body');
  assert.deepEqual(service.drain({ maxMessages: 10 }), { indexed: 2, items: 2, pending: 0 }, 'the next slice starts with it');
});