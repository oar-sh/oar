import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateMessagePins } from './0008-message-pins.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
const indexSql = (db, name) => db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(name)?.sql || '';

function createOldDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL, timestamp TEXT NOT NULL
    );
  `);
  return db;
}

test('adds the pin column and its partial index once and keeps the rows', () => {
  const db = createOldDb();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('msg-1', 'conv-1', 'user', 'hello', '2026-10-05T10:00:00.000Z')`).run();

  assert.deepEqual(migrateMessagePins(db), { applied: true, columnsAdded: 1, indexesAdded: 1 });
  assert.equal(columns(db, 'messages').includes('pinned_at'), true);
  assert.match(indexSql(db, 'idx_messages_pinned'), /WHERE pinned_at IS NOT NULL/);
  assert.equal(db.prepare(`SELECT pinned_at FROM messages WHERE id = 'msg-1'`).get().pinned_at, null);

  db.prepare(`UPDATE messages SET pinned_at = '2026-10-05T10:05:00.000Z' WHERE id = 'msg-1'`).run();
  assert.deepEqual(migrateMessagePins(db), { applied: false, columnsAdded: 0, indexesAdded: 0 });
  assert.equal(db.prepare(`SELECT pinned_at FROM messages WHERE id = 'msg-1'`).get().pinned_at, '2026-10-05T10:05:00.000Z');
});

test('a database without the messages table is left alone', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateMessagePins(db), { applied: false, columnsAdded: 0, indexesAdded: 0 });
});

test('a fresh schema carries the column and the index', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(columns(db, 'messages').includes('pinned_at'), true);
  assert.match(indexSql(db, 'idx_messages_pinned'), /WHERE pinned_at IS NOT NULL/);
});
