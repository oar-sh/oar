import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { buildQueueWakeTriggerSql, installQueueWakeHook } from './queue-wake-hook.mjs';

const T = '2026-03-02T10:00:00.000Z';

function setup({ db = null, selfTest } = {}) {
  const database = db || (() => {
    const fresh = new Database(':memory:');
    applySchema(fresh);
    fresh.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'Demo', 'active', ?, ?)`).run(T, T);
    return fresh;
  })();
  const wakes = [];
  const logs = [];
  const queued = [];
  const hook = installQueueWakeHook(database, {
    onWake: (reason) => wakes.push(reason),
    log: (line) => logs.push(line),
    schedule: (fn) => queued.push(fn),
    ...(selfTest ? { selfTest } : {}),
  });
  function flush() {
    while (queued.length) queued.shift()();
  }
  function insert(id, status = 'pending', extra = {}) {
    database.prepare(`
      INSERT INTO queue (id, conversation_id, is_new_conversation, text, status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id)
      VALUES (@id, 'conv-1', 0, 'hello', @status, @ts, 0, @next, @owner)
    `).run({ id, status, ts: T, next: extra.next ?? null, owner: extra.owner ?? null });
  }
  // The reasons of one wake, sorted: SQLite fires the triggers of one write
  // in no set order.
  function settled() {
    flush();
    return wakes.splice(0).map((reason) => reason.split(',').sort().join(','));
  }
  return { db: database, hook, wakes, logs, flush, insert, settled, update: (sql, ...args) => database.prepare(sql).run(...args) };
}

test('installs on the full schema', () => {
  const { hook } = setup();
  assert.equal(hook.installed, true);
  assert.equal(hook.triggers.length, 5);
});

test('a new pending row wakes; a row born in another state does not', () => {
  const q = setup();
  q.insert('q-1');
  assert.deepEqual(q.settled(), ['insert']);
  q.insert('q-2', 'done');
  q.insert('q-3', 'processing');
  assert.deepEqual(q.settled(), []);
});

test('a claim and a lease refresh stay silent', () => {
  const q = setup();
  q.insert('q-1');
  q.settled();
  q.update(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = 'q-1'`, T);
  q.update(`UPDATE queue SET owner_last_claimed_at = ? WHERE id = 'q-1'`, T);
  assert.deepEqual(q.settled(), []);
});

test('a requeue, a retry time, an owner or a provider change on a pending row wakes', () => {
  const q = setup();
  q.insert('q-1', 'processing');
  q.settled();
  q.update(`UPDATE queue SET status = 'pending', next_attempt_at = ? WHERE id = 'q-1'`, T);
  assert.deepEqual(q.settled(), ['requeue,settle'], 'processing → pending: a requeue and a turn end, one wake');
  q.update(`UPDATE queue SET next_attempt_at = NULL WHERE id = 'q-1'`);
  assert.deepEqual(q.settled(), ['requeue'], 'a hold released');
  q.update(`UPDATE queue SET owner_sdk_session_id = 'sdk-2' WHERE id = 'q-1'`);
  assert.deepEqual(q.settled(), ['requeue'], 'owner moved');
  q.update(`UPDATE queue SET provider = 'claude-api' WHERE id = 'q-1'`);
  assert.deepEqual(q.settled(), ['requeue'], 'provider restamped');
  q.update(`UPDATE queue SET text = 'edited' WHERE id = 'q-1'`);
  assert.deepEqual(q.settled(), [], 'a text edit changes nothing deliverable');
});

test('the repository requeue paths wake', () => {
  const q = setup();
  const repo = createMessageRepository(q.db);
  q.insert('q-1', 'processing', { owner: 'sdk-1' });
  q.update(`UPDATE queue SET processing_at = ? WHERE id = 'q-1'`, T);
  q.settled();
  repo.recoverProcessingBefore.run({ id: 'q-1', requeueAt: T, inactiveBefore: '2999-01-01T00:00:00.000Z', ceilingBefore: null });
  assert.equal(q.db.prepare(`SELECT status FROM queue WHERE id = 'q-1'`).get().status, 'pending', 'the stale sweep requeued it');
  assert.deepEqual(q.settled(), ['requeue,settle']);
  q.update(`UPDATE queue SET status = 'processing' WHERE id = 'q-1'`);
  q.settled();
  repo.recoverProcessingRowKeepOwner.run(T, 'q-1');
  const kept = q.db.prepare(`SELECT status FROM queue WHERE id = 'q-1'`).get();
  assert.equal(kept.status, 'pending');
  assert.deepEqual(q.settled(), ['requeue,settle']);
});

test('a turn ending wakes, whatever it ends in', () => {
  const q = setup();
  for (const [id, end] of [['q-1', 'done'], ['q-2', 'failed'], ['q-3', 'parked']]) {
    q.insert(id, 'processing');
    q.update(`UPDATE queue SET status = ? WHERE id = ?`, end, id);
    assert.deepEqual(q.settled(), ['settle'], end);
  }
});

test('a pending row cancelled, failed or parked wakes (a plan-boundary hold behind it may lift)', () => {
  const q = setup();
  for (const [id, end] of [['q-1', 'cancelled'], ['q-2', 'failed'], ['q-3', 'parked']]) {
    q.insert(id);
    q.settled();
    q.update(`UPDATE queue SET status = ? WHERE id = ?`, end, id);
    assert.deepEqual(q.settled(), ['cancel'], end);
  }
});

test('deleting a pending or running row wakes; deleting a finished one does not', () => {
  const q = setup();
  q.insert('q-1');
  q.insert('q-2', 'processing');
  q.insert('q-3', 'done');
  q.settled();
  q.update(`DELETE FROM queue WHERE id = 'q-1'`);
  assert.deepEqual(q.settled(), ['delete']);
  q.update(`DELETE FROM queue WHERE id = 'q-2'`);
  assert.deepEqual(q.settled(), ['delete']);
  q.update(`DELETE FROM queue WHERE id = 'q-3'`);
  assert.deepEqual(q.settled(), []);
});

test('writes of one tick give one wake; a bulk statement keeps the reasons bounded', () => {
  const q = setup();
  for (let i = 0; i < 50; i += 1) q.insert(`q-${i}`, 'processing');
  q.update(`UPDATE queue SET status = 'pending'`);
  q.insert('q-new');
  q.update(`DELETE FROM queue WHERE id = 'q-new'`);
  assert.deepEqual(q.settled(), ['delete,insert,requeue,settle']);
});

test('a rolled-back write gives at most one spurious wake and leaves no row', () => {
  const q = setup();
  const tx = q.db.transaction(() => {
    q.insert('q-1');
    throw new Error('abort');
  });
  assert.throws(() => tx(), /abort/);
  assert.equal(q.db.prepare(`SELECT COUNT(*) AS n FROM queue`).get().n, 0);
  assert.ok(q.settled().length <= 1);
});

test('a throwing wake handler is logged and the next write still wakes', () => {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'Demo', 'active', ?, ?)`).run(T, T);
  const logs = [];
  const queued = [];
  let calls = 0;
  installQueueWakeHook(db, {
    onWake: () => { calls += 1; throw new Error('handler broke'); },
    log: (line) => logs.push(line),
    schedule: (fn) => queued.push(fn),
  });
  const insert = (id) => db.prepare(`INSERT INTO queue (id, conversation_id, is_new_conversation, text, status, timestamp, retry_count) VALUES (?, 'conv-1', 0, 'x', 'pending', ?, 0)`).run(id, T);
  insert('q-1');
  while (queued.length) queued.shift()();
  insert('q-2');
  while (queued.length) queued.shift()();
  assert.equal(calls, 2);
  assert.equal(logs.filter((line) => /handler broke/.test(line)).length, 2);
});

test('a queue without the provider column: the conditions leave it out and writes work', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE queue (id TEXT PRIMARY KEY, status TEXT, next_attempt_at TEXT, owner_sdk_session_id TEXT, text TEXT)`);
  const sql = buildQueueWakeTriggerSql(new Set(['id', 'status', 'next_attempt_at', 'owner_sdk_session_id', 'text']));
  assert.ok(sql.every((statement) => !/provider/.test(statement)));
  const q = setup({ db });
  assert.equal(q.hook.installed, true);
  db.prepare(`INSERT INTO queue (id, status) VALUES ('q-1', 'processing')`).run();
  db.prepare(`UPDATE queue SET status = 'pending' WHERE id = 'q-1'`).run();
  assert.deepEqual(q.settled(), ['requeue,settle']);
});

test('without the hook, SQLite would accept a trigger naming a missing column and fail every update', () => {
  // Why the conditions are built from the table: this is the failure mode.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE queue (id TEXT PRIMARY KEY, status TEXT)`);
  db.function('noop', () => null);
  db.exec(`CREATE TEMP TRIGGER bad AFTER UPDATE ON main.queue WHEN OLD.provider IS NOT NEW.provider BEGIN SELECT noop(); END`);
  db.prepare(`INSERT INTO queue (id, status) VALUES ('q-1', 'pending')`).run();
  assert.throws(() => db.prepare(`UPDATE queue SET status = 'done'`).run(), /no such column/);
});

test('a failing self-test drops the triggers and reports the fallback once', () => {
  const q = setup({ selfTest: () => { throw new Error('forced'); } });
  assert.equal(q.hook.installed, false);
  assert.equal(q.logs.length, 1);
  assert.match(q.logs[0], /polled instead: forced/);
  const triggers = q.db.prepare(`SELECT name FROM sqlite_temp_master WHERE type = 'trigger'`).all();
  assert.deepEqual(triggers, []);
  q.insert('q-1');
  q.update(`UPDATE queue SET status = 'processing' WHERE id = 'q-1'`);
  assert.deepEqual(q.settled(), [], 'no triggers, no wakes; writes still work');
});

test('the self-test wakes nobody, also on a queue with rows', () => {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-1', 'Demo', 'active', ?, ?)`).run(T, T);
  db.prepare(`INSERT INTO queue (id, conversation_id, is_new_conversation, text, status, timestamp, retry_count) VALUES ('q-1', 'conv-1', 0, 'x', 'pending', ?, 0)`).run(T);
  const q = setup({ db });
  assert.equal(q.hook.installed, true);
  assert.deepEqual(q.settled(), []);
  assert.equal(db.prepare(`SELECT status FROM queue WHERE id = 'q-1'`).get().status, 'pending');
});

test('a queue table without a status column is refused', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE queue (id TEXT PRIMARY KEY)`);
  const q = setup({ db });
  assert.equal(q.hook.installed, false);
});
