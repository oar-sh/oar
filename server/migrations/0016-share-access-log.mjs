'use strict';

/**
 * Migration: share lineages and the share access log.
 *
 * A share link can be renewed: the conversation gets a new token and the old
 * one stops at once. What the link has been through (its opens) belongs to the
 * share, not to one token, so every row of `conversation_shares` gets a
 * `lineage_id`: the token the share started with, carried over to every
 * renewed token. Existing rows start their own lineage (`lineage_id = token`).
 *
 * `conversation_share_opens` holds one row per open of a shared page:
 *
 * - `lineage_id` names the share; the log survives a renew.
 * - `opened_at` is an ISO timestamp.
 * - `ip` is NULL when the relay does not store viewer addresses (a setting).
 * - `country` is the edge's two-letter country, NULL when unknown.
 * - `viewer_key` is a keyed hash of address and browser, so distinct viewers
 *   can be counted when the address itself is not stored.
 *
 * Stopping a share deletes its log; deleting the conversation does too (the
 * foreign key, and the delete route by hand). Nothing else prunes it.
 *
 * Additive and idempotent. Safe to run on every boot. An older build never
 * reads the new table, and a share it creates has no lineage, which this build
 * reads as the share's own token.
 *
 * Usage: node server/migrations/0016-share-access-log.mjs [path/to/copilot.db]
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

export function migrateShareAccessLog(db) {
  if (!tableExists(db, 'conversation_shares')) {
    throw new Error('conversation_shares is missing (the base schema has not run)');
  }
  let columnsAdded = 0;
  let tablesAdded = 0;
  const present = new Set(db.prepare(`PRAGMA table_info(conversation_shares)`).all().map((column) => column.name));
  if (!present.has('lineage_id')) {
    db.exec(`ALTER TABLE conversation_shares ADD COLUMN lineage_id TEXT`);
    columnsAdded += 1;
  }
  // Every run: a share an older build created after this migration has none.
  const lineagesSet = db.prepare(`UPDATE conversation_shares SET lineage_id = token WHERE lineage_id IS NULL OR lineage_id = ''`).run().changes;
  if (!tableExists(db, 'conversation_share_opens')) {
    db.exec(`
      CREATE TABLE conversation_share_opens (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        lineage_id      TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        opened_at       TEXT NOT NULL,
        ip              TEXT,
        user_agent      TEXT,
        country         TEXT,
        viewer_key      TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `);
    tablesAdded += 1;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_share_opens_lineage
    ON conversation_share_opens(lineage_id, opened_at DESC)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conversation_share_opens_conversation
    ON conversation_share_opens(conversation_id)
  `);
  return { applied: columnsAdded > 0 || tablesAdded > 0 || lineagesSet > 0, columnsAdded, tablesAdded, lineagesSet };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateShareAccessLog(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0016 on ${dbPath}`);
    console.log(result.applied
      ? `  share access log: columns added ${result.columnsAdded}, tables added ${result.tablesAdded}, lineages set ${result.lineagesSet}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0016 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
