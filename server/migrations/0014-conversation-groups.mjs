'use strict';

/**
 * Migration: session groups in the sidebar.
 *
 * A group is the set of conversations that share a `group_id`. The table
 * `conversation_groups` holds what the set itself needs: a name given by hand
 * (NULL means "shown under the head's title") and the head, the session that
 * created the others with the remote_relay tool (NULL for a group made by
 * hand, or once the head is deleted). A conversation an agent creates on this
 * relay joins its creator's group at bootstrap; everything else is done by
 * hand in the sidebar. Nothing is backfilled.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0014-conversation-groups.mjs [path/to/oar.db]
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

export function migrateConversationGroups(db) {
  if (!tableExists(db, 'conversations')) {
    throw new Error('conversations is missing (the base schema has not run)');
  }
  let tablesAdded = 0;
  if (!tableExists(db, 'conversation_groups')) {
    db.exec(`
      CREATE TABLE conversation_groups (
        id                     TEXT PRIMARY KEY,
        name                   TEXT,
        parent_conversation_id TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      )
    `);
    tablesAdded += 1;
  }
  const present = new Set(db.prepare(`PRAGMA table_info(conversations)`).all().map((column) => column.name));
  let columnsAdded = 0;
  if (!present.has('group_id')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN group_id TEXT`);
    columnsAdded += 1;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversations_group
    ON conversations(group_id)
    WHERE group_id IS NOT NULL
  `);
  return { applied: columnsAdded > 0 || tablesAdded > 0, columnsAdded, tablesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateConversationGroups(db);
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
    console.log(`Migration 0014 on ${dbPath}`);
    console.log(result.applied
      ? `  conversation groups: columns added ${result.columnsAdded}, tables added ${result.tablesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0014 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
