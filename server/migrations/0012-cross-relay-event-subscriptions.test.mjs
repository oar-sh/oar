import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateRelayEventSubscriptions } from './0011-relay-event-subscriptions.mjs';
import { migrateCrossRelayEventSubscriptions } from './0012-cross-relay-event-subscriptions.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the columns and the link table once, keeping existing subscriptions', () => {
  const db = new Database(':memory:');
  migrateRelayEventSubscriptions(db);
  db.prepare(`INSERT INTO relay_event_subscriptions (id, watcher_conversation_id, scope, events_json, created_at) VALUES ('sub_fixture', 'conv-watcher', 'all', '[]', '2026-01-01T00:00:00.000Z')`).run();
  assert.deepEqual(migrateCrossRelayEventSubscriptions(db), { applied: true, columnsAdded: 9, tablesAdded: 1 });
  for (const name of ['remote_subscription_id', 'remote_sync', 'subscriber_relay_id', 'last_pull_at', 'dropped_count']) {
    assert.ok(columns(db, 'relay_event_subscriptions').includes(name), name);
  }
  assert.deepEqual(columns(db, 'relay_event_links'), ['relay_id', 'cursor', 'last_ok_at', 'first_fail_at', 'lost_at', 'last_error']);
  assert.deepEqual(migrateCrossRelayEventSubscriptions(db), { applied: false, columnsAdded: 0, tablesAdded: 0 });
  assert.equal(db.prepare(`SELECT dropped_count FROM relay_event_subscriptions WHERE id = 'sub_fixture'`).get().dropped_count, 0);
});

test('refuses to run before 0011, and the schema boot applies it', () => {
  assert.throws(() => migrateCrossRelayEventSubscriptions(new Database(':memory:')), /0011/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'relay_event_subscriptions').includes('subscriber_relay_id'));
  assert.ok(columns(db, 'relay_event_links').length > 0);
});
