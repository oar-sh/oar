import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateConversationMayCreateSessions } from './0020-conversation-may-create-sessions.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the may_create_sessions column once, NULL (not allowed) on existing conversations', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-fixture', 'Sample chat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  assert.deepEqual(migrateConversationMayCreateSessions(db), { applied: true, columnsAdded: 1 });
  assert.ok(columns(db, 'conversations').includes('may_create_sessions'));
  assert.deepEqual(migrateConversationMayCreateSessions(db), { applied: false, columnsAdded: 0 });
  assert.equal(db.prepare(`SELECT may_create_sessions FROM conversations WHERE id = 'conv-fixture'`).get().may_create_sessions, null);
});

test('refuses to run without the base schema, and the schema boot applies it', () => {
  assert.throws(() => migrateConversationMayCreateSessions(new Database(':memory:')), /conversations is missing/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.ok(columns(db, 'conversations').includes('may_create_sessions'));
});
