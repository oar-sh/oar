'use strict';

/**
 * Migration: two indexes for loading the history of long conversations.
 *
 * - `idx_queue_response_message` on `queue(response_message_id)`: the
 *   sub-agent records of a reply are found through the queue row that
 *   produced it, one lookup per assistant message on every history page.
 *   Without the index each lookup scanned the whole queue.
 * - `idx_messages_conv_order` on `messages(conversation_id, timestamp, id)`:
 *   a history page is selected in SQL in conversation order (timestamp, then
 *   id); the index serves that order and the check that a conversation's
 *   rows can be paged that way, without reading the message rows.
 *
 * Additive and idempotent. Safe to run on every boot. An older build ignores
 * both indexes.
 *
 * Usage: node server/migrations/0017-conversation-history-indexes.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function indexExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

export function migrateConversationHistoryIndexes(db) {
  if (!tableExists(db, 'messages') || !tableExists(db, 'queue')) {
    throw new Error('messages or queue is missing (the base schema has not run)');
  }
  if (!columnNames(db, 'queue').has('response_message_id')) {
    throw new Error('queue.response_message_id is missing (the base schema has not run)');
  }
  let indexesAdded = 0;
  if (!indexExists(db, 'idx_queue_response_message')) {
    db.exec(`CREATE INDEX idx_queue_response_message ON queue(response_message_id)`);
    indexesAdded += 1;
  }
  if (!indexExists(db, 'idx_messages_conv_order')) {
    db.exec(`CREATE INDEX idx_messages_conv_order ON messages(conversation_id, timestamp, id)`);
    indexesAdded += 1;
  }
  return { applied: indexesAdded > 0, indexesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateConversationHistoryIndexes(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    // The given path, else the database in server/data (oar.db, else the
    // name before 0.9.20); never a new one.
    const dbPath = cliDbPath(process.argv[2], new URL('..', import.meta.url));
    const result = migrate(dbPath);
    console.log(`Migration 0017 on ${dbPath}`);
    console.log(result.applied
      ? `  conversation history indexes: added ${result.indexesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0017 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
