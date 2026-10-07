'use strict';

/**
 * Migration: pinned messages.
 *
 * 1. `messages.pinned_at` — when the user pinned the message (ISO time); NULL
 *    means not pinned. A pin is a property of the message row, like
 *    `hidden_from_shares`, so it goes away with the row.
 * 2. `idx_messages_pinned` — a partial index over the pinned rows only: the
 *    pin list travels with every conversation load.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0008-message-pins.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

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
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
}

export function migrateMessagePins(db) {
  if (!tableExists(db, 'messages')) return { applied: false, columnsAdded: 0, indexesAdded: 0 };
  let columnsAdded = 0;
  let indexesAdded = 0;
  if (!columnNames(db, 'messages').has('pinned_at')) {
    db.exec(`ALTER TABLE messages ADD COLUMN pinned_at TEXT`);
    columnsAdded += 1;
  }
  if (!indexExists(db, 'idx_messages_pinned')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_pinned
      ON messages(conversation_id, timestamp)
      WHERE pinned_at IS NOT NULL
    `);
    indexesAdded += 1;
  }
  return { applied: columnsAdded + indexesAdded > 0, columnsAdded, indexesAdded };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateMessagePins(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0008 on ${dbPath}`);
    console.log(result.applied
      ? `  message pins: columns added ${result.columnsAdded}, indexes added ${result.indexesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0008 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
