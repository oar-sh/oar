import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateConversationGroupPosition } from './0015-conversation-group-position.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the position column once, NULL on existing conversations', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fixture', 'Sample chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  assert.deepEqual(migrateConversationGroupPosition(db), { applied: true, columnsAdded: 1, placesCleared: 0 });
  assert.ok(columns(db, 'conversations').includes('group_position'));
  assert.deepEqual(migrateConversationGroupPosition(db), { applied: false, columnsAdded: 0, placesCleared: 0 });
  assert.equal(db.prepare(`SELECT group_position FROM conversations WHERE id = 'conv-fixture'`).get().group_position, null);
});

test('refuses to run without the base schema, and the schema boot applies it', () => {
  assert.throws(() => migrateConversationGroupPosition(new Database(':memory:')), /conversations is missing/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'conversations').includes('group_position'));
});

test('every run clears a place left on a row without a group (an older release moved it out)', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const insert = db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  insert.run('conv-loose', 'Loose sample');
  insert.run('conv-grouped', 'Grouped sample');
  db.prepare(`INSERT INTO conversation_groups (id, name, parent_conversation_id, created_at, updated_at) VALUES ('grp_fixture', 'Sample batch', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`UPDATE conversations SET group_position = 10 WHERE id = 'conv-loose'`).run();
  db.prepare(`UPDATE conversations SET group_id = 'grp_fixture', group_position = 20 WHERE id = 'conv-grouped'`).run();
  assert.deepEqual(migrateConversationGroupPosition(db), { applied: true, columnsAdded: 0, placesCleared: 1 });
  const place = (id) => db.prepare(`SELECT group_position FROM conversations WHERE id = ?`).get(id).group_position;
  assert.equal(place('conv-loose'), null);
  assert.equal(place('conv-grouped'), 20, 'a grouped row keeps its place');
  assert.deepEqual(migrateConversationGroupPosition(db), { applied: false, columnsAdded: 0, placesCleared: 0 });
});
