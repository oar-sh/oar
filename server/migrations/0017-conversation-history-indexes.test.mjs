import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateConversationHistoryIndexes } from './0017-conversation-history-indexes.mjs';
import { applySchema } from '../db-schema.mjs';

const indexColumns = (db, name) => db.prepare(`PRAGMA index_info(${name})`).all().map((column) => column.name);

function preIndexDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      text TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE queue (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, text TEXT NOT NULL,
      status TEXT NOT NULL, timestamp TEXT NOT NULL, response_message_id TEXT);
  `);
  return db;
}

test('adds both indexes once', () => {
  const db = preIndexDb();
  assert.deepEqual(migrateConversationHistoryIndexes(db), { applied: true, indexesAdded: 2 });
  assert.deepEqual(indexColumns(db, 'idx_queue_response_message'), ['response_message_id']);
  assert.deepEqual(indexColumns(db, 'idx_messages_conv_order'), ['conversation_id', 'timestamp', 'id']);
  assert.deepEqual(migrateConversationHistoryIndexes(db), { applied: false, indexesAdded: 0 });
});

test('the reply lookup by response id uses the queue index', () => {
  const db = preIndexDb();
  migrateConversationHistoryIndexes(db);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM queue WHERE response_message_id = ?`).all('reply-1')
    .map((row) => row.detail).join(' ');
  assert.match(plan, /idx_queue_response_message/);
});

test('refuses to run without the base schema, and the schema boot applies it', () => {
  assert.throws(() => migrateConversationHistoryIndexes(new Database(':memory:')), /base schema has not run/);
  const db = new Database(':memory:');
  applySchema(db);
  assert.deepEqual(indexColumns(db, 'idx_queue_response_message'), ['response_message_id']);
  assert.deepEqual(indexColumns(db, 'idx_messages_conv_order'), ['conversation_id', 'timestamp', 'id']);
});
