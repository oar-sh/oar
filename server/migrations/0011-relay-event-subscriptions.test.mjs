import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateRelayEventSubscriptions } from './0011-relay-event-subscriptions.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('creates both tables once', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateRelayEventSubscriptions(db), { applied: true, tablesAdded: 2 });
  assert.ok(columns(db, 'relay_event_subscriptions').includes('heartbeat_minutes'));
  assert.ok(columns(db, 'relay_event_subscriptions').includes('watcher_conversation_id'));
  assert.ok(columns(db, 'relay_event_subscriptions').includes('relay_id'));
  assert.ok(columns(db, 'relay_events').includes('delivered_at'));
  db.prepare(`INSERT INTO relay_event_subscriptions (id, watcher_conversation_id, scope, events_json, created_at) VALUES ('sub_fixture', 'conv-watcher', 'all', '[]', '2026-01-01T00:00:00.000Z')`).run();
  assert.deepEqual(migrateRelayEventSubscriptions(db), { applied: false, tablesAdded: 0 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_event_subscriptions`).get().n, 1);
});

test('the schema boot applies it', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'relay_event_subscriptions').length > 0);
  assert.ok(columns(db, 'relay_events').length > 0);
});


test('both partial indexes exist, on a fresh and on an older database', () => {
  const indexes = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'relay_events'`).all().map((row) => row.name).sort();
  const fresh = new Database(':memory:');
  migrateRelayEventSubscriptions(fresh);
  assert.deepEqual(indexes(fresh), ['idx_relay_events_delivered', 'idx_relay_events_undelivered']);
  const older = new Database(':memory:');
  migrateRelayEventSubscriptions(older);
  older.exec(`DROP INDEX idx_relay_events_delivered`);
  assert.deepEqual(migrateRelayEventSubscriptions(older), { applied: false, tablesAdded: 0 });
  assert.deepEqual(indexes(older), ['idx_relay_events_delivered', 'idx_relay_events_undelivered']);
});
