import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateConversationGroups } from './0014-conversation-groups.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the group table, the column and the index once, keeping existing conversations', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fixture', 'Sample chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  assert.deepEqual(migrateConversationGroups(db), { applied: true, columnsAdded: 1, tablesAdded: 1 });
  assert.deepEqual(columns(db, 'conversation_groups'), ['id', 'name', 'parent_conversation_id', 'created_at', 'updated_at']);
  assert.ok(columns(db, 'conversations').includes('group_id'));
  assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversations_group'`).get());
  assert.deepEqual(migrateConversationGroups(db), { applied: false, columnsAdded: 0, tablesAdded: 0 });
  assert.equal(db.prepare(`SELECT group_id FROM conversations WHERE id = 'conv-fixture'`).get().group_id, null);
});

test('refuses to run without the base schema, and the schema boot applies it', () => {
  assert.throws(() => migrateConversationGroups(new Database(':memory:')), /conversations is missing/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'conversations').includes('group_id'));
  assert.equal(columns(db, 'conversation_groups').length, 5);
});
