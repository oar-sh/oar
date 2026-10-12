import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_EVENT_LIMITS } from '../../shared/relay-events.mjs';
import {
  RELAY_EVENT_DELIVERED_KEEP_MS,
  RELAY_EVENT_ENDED_SUBSCRIPTION_KEEP_MS,
  RELAY_EVENT_PRUNE_SQL,
  RELAY_EVENT_SERVED_RETENTION_SQL,
  createRelayEventService,
  servedWatcherKey,
} from './relay-event-service.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const WATCHER = 'conv-fixture-watcher';
const BUILDER = 'conv-fixture-builder';

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const at = new Date(T0 - DAY_MS).toISOString();
  for (const [id, title] of [[WATCHER, 'relay assistant'], [BUILDER, 'Orbit camera']]) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  }
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const lines = [];
  const service = createRelayEventService({
    db,
    stmts,
    now: () => T0,
    setTimer: () => ({}),
    clearTimer: () => {},
    logger: { log: (line) => lines.push(line), warn() {} },
  });
  return { db, service, lines };
}

function plan(db, sql, params) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => String(row.detail));
}

test('the served-event retention statements use the undelivered index instead of scanning the table', () => {
  const { db } = setup();
  const cases = [
    [RELAY_EVENT_SERVED_RETENTION_SQL.listServedOverfull, [RELAY_EVENT_LIMITS.remoteKeepEvents]],
    [RELAY_EVENT_SERVED_RETENTION_SQL.deleteServedOldest, ['sub_fixture', 5]],
    [RELAY_EVENT_SERVED_RETENTION_SQL.countServedExpired, ['2026-01-01T00:00:00.000Z']],
    [RELAY_EVENT_SERVED_RETENTION_SQL.deleteServedExpired, ['2026-01-01T00:00:00.000Z']],
  ];
  for (const [sql, params] of cases) {
    const details = plan(db, sql, params);
    // The delete by id of the oldest rows looks them up by rowid; the rows
    // themselves come from the index.
    assert.ok(details.some((detail) => /SEARCH relay_events USING (COVERING )?INDEX idx_relay_events_undelivered/.test(detail)), `${sql}\n${details.join('\n')}`);
    assert.ok(!details.some((detail) => /SCAN relay_events/.test(detail)), details.join('\n'));
  }
  // The statements as they were, without the index's condition, scan.
  const before = `SELECT subscription_id, COUNT(*) AS n FROM relay_events WHERE watcher_conversation_id >= 'remote:' AND watcher_conversation_id < 'remote;' GROUP BY subscription_id HAVING n > ?`;
  assert.ok(plan(db, before, [1]).some((detail) => /SCAN relay_events/.test(detail)));
});

test('pruning delivered events uses its own index', () => {
  const { db } = setup();
  const details = plan(db, RELAY_EVENT_PRUNE_SQL.deleteDeliveredBefore, ['2026-01-01T00:00:00.000Z']);
  assert.ok(details.some((detail) => /SEARCH relay_events USING INDEX idx_relay_events_delivered/.test(detail)), details.join('\n'));
});

test('the keep for delivered events covers what wake counting and the digest read', () => {
  assert.ok(RELAY_EVENT_DELIVERED_KEEP_MS >= HOUR_MS + RELAY_EVENT_LIMITS.digestIntervalMs);
  assert.equal(RELAY_EVENT_DELIVERED_KEEP_MS, 2 * HOUR_MS);
  assert.equal(RELAY_EVENT_ENDED_SUBSCRIPTION_KEEP_MS, RELAY_EVENT_LIMITS.remoteKeepDays * DAY_MS);
});

function insertEvent(db, { id, watcher = WATCHER, createdAgoMs, deliveredAgoMs = null, messageId = null }) {
  db.prepare(`
    INSERT INTO relay_events (id, subscription_id, watcher_conversation_id, relay_id, session_id, type, urgent, payload_json, created_at, delivered_at, message_id)
    VALUES (?, 'sub_fixture', ?, 'self', ?, 'turn_end', 0, '{}', ?, ?, ?)
  `).run(id, watcher, BUILDER, new Date(T0 - createdAgoMs).toISOString(), deliveredAgoMs === null ? null : new Date(T0 - deliveredAgoMs).toISOString(), messageId);
}

function insertSubscription(db, { id, endedAgoMs = null, remoteSync = null }) {
  db.prepare(`
    INSERT INTO relay_event_subscriptions (id, watcher_conversation_id, relay_id, scope, events_json, created_at, ended_at, end_reason, remote_sync)
    VALUES (?, ?, 'self', 'all', '["turn_end"]', ?, ?, ?, ?)
  `).run(id, WATCHER, new Date(T0 - 30 * DAY_MS).toISOString(), endedAgoMs === null ? null : new Date(T0 - endedAgoMs).toISOString(), endedAgoMs === null ? null : 'unsubscribed', remoteSync);
}

test('delivered events past two hours go, unless their event row is still pending; undelivered and served ones stay', () => {
  const { db, service, lines } = setup();
  const pendingId = 'msg-fixture-pending';
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', 'events', ?)`).run(pendingId, WATCHER, new Date(T0 - 3 * HOUR_MS).toISOString());
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, ?, 'events', 'pending', ?)`).run(pendingId, WATCHER, new Date(T0 - 3 * HOUR_MS).toISOString());
  insertEvent(db, { id: 1, createdAgoMs: 3 * HOUR_MS, deliveredAgoMs: 3 * HOUR_MS, messageId: 'msg-fixture-done' });
  insertEvent(db, { id: 2, createdAgoMs: 90 * 60_000, deliveredAgoMs: 90 * 60_000, messageId: 'msg-fixture-recent' });
  insertEvent(db, { id: 3, createdAgoMs: 3 * HOUR_MS, deliveredAgoMs: 3 * HOUR_MS, messageId: pendingId });
  insertEvent(db, { id: 4, createdAgoMs: 3 * HOUR_MS });
  insertEvent(db, { id: 5, watcher: servedWatcherKey('relay-fixture-b'), createdAgoMs: 3 * HOUR_MS });
  insertEvent(db, { id: 6, createdAgoMs: 3 * DAY_MS, deliveredAgoMs: 3 * DAY_MS, messageId: 'msg-fixture-ancient' });

  const result = service.pruneDelivered();

  assert.equal(result.events, 2);
  assert.deepEqual(db.prepare(`SELECT id FROM relay_events ORDER BY id`).all().map((row) => row.id), [2, 3, 4, 5]);
  assert.match(lines.at(-1), /pruned 2 delivered events and 0 ended subscriptions/);
  assert.deepEqual(service.pruneDelivered(), { events: 0, subscriptions: 0 });
});

test('subscriptions ended more than remoteKeepDays ago go, unless their end still waits for the paired relay', () => {
  const { db, service } = setup();
  insertSubscription(db, { id: 'sub_fixture_active' });
  insertSubscription(db, { id: 'sub_fixture_recent', endedAgoMs: DAY_MS });
  insertSubscription(db, { id: 'sub_fixture_old', endedAgoMs: 8 * DAY_MS });
  insertSubscription(db, { id: 'sub_fixture_old_unsynced', endedAgoMs: 8 * DAY_MS, remoteSync: 'unsubscribe' });

  const result = service.pruneDelivered();

  assert.equal(result.subscriptions, 1);
  assert.deepEqual(
    db.prepare(`SELECT id FROM relay_event_subscriptions ORDER BY id`).all().map((row) => row.id),
    ['sub_fixture_active', 'sub_fixture_old_unsynced', 'sub_fixture_recent'],
  );
});

test('the sweep prunes at most every ten minutes', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const at = new Date(T0 - DAY_MS).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(WATCHER, 'w', at, at);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  let clock = T0;
  const service = createRelayEventService({ db, stmts, now: () => clock, setTimer: () => ({}), clearTimer: () => {}, logger: { log() {}, warn() {} } });
  insertEvent(db, { id: 1, createdAgoMs: 3 * HOUR_MS, deliveredAgoMs: 3 * HOUR_MS, messageId: 'msg-fixture-a' });
  service.sweep();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_events`).get().n, 0, 'the first sweep prunes');
  clock += 60_000;
  insertEvent(db, { id: 2, createdAgoMs: 3 * HOUR_MS, deliveredAgoMs: 3 * HOUR_MS, messageId: 'msg-fixture-b' });
  service.sweep();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_events`).get().n, 1, 'a sweep a minute later does not');
  clock += 10 * 60_000;
  service.sweep();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_events`).get().n, 0, 'ten minutes later it does');
});
