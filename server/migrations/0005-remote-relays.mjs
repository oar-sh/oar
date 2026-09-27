'use strict';

/**
 * Migration: storage for remote relays (agents working across OAR relays).
 *
 * 1. `messages.origin_json` — on a user row that another relay's agent sent:
 *    who sent it (relay, source conversation, model, hop count). Drives the
 *    "from <relay>" badge, keeps such rows from unlocking relays, and skips
 *    the reply-ready push.
 * 2. `conversations.origin_json` — on a conversation another relay's agent
 *    created: the "via <relay>" marker in the conversation list.
 * 3. `conversation_remote_relay_unlocks` — which remote relays the user has
 *    mentioned (and so unlocked) in which conversation. Keyed by the remote's
 *    local registry id, so a renamed remote keeps its unlocks.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0005-remote-relays.mjs [path/to/copilot.db]
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

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
}

export function migrateRemoteRelays(db) {
  let columnsAdded = 0;
  for (const table of ['messages', 'conversations']) {
    if (!tableExists(db, table)) continue;
    if (!columnNames(db, table).has('origin_json')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN origin_json TEXT`);
      columnsAdded += 1;
    }
  }
  const unlocksExisted = tableExists(db, 'conversation_remote_relay_unlocks');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_remote_relay_unlocks (
      conversation_id TEXT NOT NULL,
      remote_relay_id TEXT NOT NULL,
      message_id      TEXT,
      created_at      TEXT NOT NULL,
      PRIMARY KEY (conversation_id, remote_relay_id)
    )
  `);
  return {
    applied: columnsAdded > 0 || !unlocksExisted,
    columnsAdded,
    unlocksTableCreated: !unlocksExisted,
  };
}

export function migrate(dbPath) {
  const db = new Database(dbPath);
  try {
    return migrateRemoteRelays(db);
  } finally {
    db.close();
  }
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0005 on ${dbPath}`);
    console.log(result.applied
      ? `  origin columns added: ${result.columnsAdded}; unlocks table created: ${result.unlocksTableCreated}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0005 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
