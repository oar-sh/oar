'use strict';

/**
 * Migration: a hand order inside a session group.
 *
 * `group_position` is a member's place in its group once the owner has
 * dragged a row there: the members with one come first, by position, the
 * others after them, newest first. The head keeps NULL (it always leads),
 * and so does every member of a group nobody reordered. A row that leaves
 * its group loses its position.
 *
 * Additive and idempotent. Safe to run on every boot. Rolling back needs no
 * data change: older code ignores the column; a row it moves out of a group
 * keeps a stale place, which the next run here clears.
 *
 * Usage: node server/migrations/0015-conversation-group-position.mjs [path/to/oar.db]
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

export function migrateConversationGroupPosition(db) {
  if (!tableExists(db, 'conversations')) {
    throw new Error('conversations is missing (the base schema has not run)');
  }
  const present = new Set(db.prepare(`PRAGMA table_info(conversations)`).all().map((column) => column.name));
  let columnsAdded = 0;
  if (!present.has('group_position')) {
    db.exec(`ALTER TABLE conversations ADD COLUMN group_position INTEGER`);
    columnsAdded += 1;
  }
  // A place without a group: an older release (which ignores the column)
  // moved the row out of its group after a roll back. Cleared on every run.
  const placesCleared = present.has('group_id')
    ? db.prepare(`UPDATE conversations SET group_position = NULL WHERE group_id IS NULL AND group_position IS NOT NULL`).run().changes
    : 0;
  return { applied: columnsAdded > 0 || placesCleared > 0, columnsAdded, placesCleared };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateConversationGroupPosition(db);
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
    console.log(`Migration 0015 on ${dbPath}`);
    console.log(result.applied
      ? `  group position: columns added ${result.columnsAdded}, stale places cleared ${result.placesCleared}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0015 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
