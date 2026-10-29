'use strict';

/**
 * Migration: the owner's "agents in this conversation may start sessions".
 *
 * `may_create_sessions` is 1 when the owner allowed the agents of a session
 * that an agent started to start sessions on this relay themselves (the
 * remote_relay tool's one-level rule is lifted for it); NULL or 0 otherwise.
 * Only the owner sets it, in the conversation's settings or through the
 * preferences route; no agent can.
 *
 * Additive and idempotent. Safe to run on every boot. Rolling back needs no
 * data change: older code ignores the column and keeps the one-level rule.
 *
 * Usage: node server/migrations/0020-conversation-may-create-sessions.mjs [path/to/oar.db]
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

export function migrateConversationMayCreateSessions(db) {
  if (!tableExists(db, 'conversations')) {
    throw new Error('conversations is missing (the base schema has not run)');
  }
  const present = new Set(db.prepare(`PRAGMA table_info(conversations)`).all().map((column) => column.name));
  if (present.has('may_create_sessions')) return { applied: false, columnsAdded: 0 };
  db.exec(`ALTER TABLE conversations ADD COLUMN may_create_sessions INTEGER`);
  return { applied: true, columnsAdded: 1 };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateConversationMayCreateSessions(db);
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
    console.log(`Migration 0020 on ${dbPath}`);
    console.log(result.applied
      ? `  may create sessions: columns added ${result.columnsAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0020 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
