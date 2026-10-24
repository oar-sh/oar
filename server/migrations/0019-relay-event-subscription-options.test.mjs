import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateRelayEventSubscriptions } from './0011-relay-event-subscriptions.mjs';
import { migrateRelayEventSubscriptionOptions } from './0019-relay-event-subscription-options.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the option columns and the own-prompt table once, keeping existing subscriptions', () => {
  const db = new Database(':memory:');
  migrateRelayEventSubscriptions(db);
  db.prepare(`INSERT INTO relay_event_subscriptions (id, watcher_conversation_id, scope, events_json, created_at) VALUES ('sub_fixture', 'conv-watcher', 'all', '[]', '2026-01-01T00:00:00.000Z')`).run();
  assert.deepEqual(migrateRelayEventSubscriptionOptions(db), { applied: true, columnsAdded: 4, tablesAdded: 1 });
  for (const name of ['digest_minutes', 'digest_last_at', 'quiet_hours_json', 'exclude_json']) {
    assert.ok(columns(db, 'relay_event_subscriptions').includes(name), name);
  }
  assert.deepEqual(columns(db, 'relay_event_own_prompts'), ['message_id', 'watcher_conversation_id', 'relay_id', 'session_id', 'created_at', 'received_at']);
  assert.deepEqual(migrateRelayEventSubscriptionOptions(db), { applied: false, columnsAdded: 0, tablesAdded: 0 });
  const row = db.prepare(`SELECT digest_minutes, quiet_hours_json, exclude_json FROM relay_event_subscriptions WHERE id = 'sub_fixture'`).get();
  assert.deepEqual({ ...row }, { digest_minutes: null, quiet_hours_json: null, exclude_json: null });
});

test('refuses to run before 0011, and the schema boot applies it', () => {
  assert.throws(() => migrateRelayEventSubscriptionOptions(new Database(':memory:')), /0011/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'relay_event_subscriptions').includes('quiet_hours_json'));
  assert.ok(columns(db, 'relay_event_own_prompts').length > 0);
});
