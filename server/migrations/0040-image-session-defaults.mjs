'use strict';

/**
 * Migration: an image session's own defaults, and a turn's options.
 *
 * `image_sessions.defaults_json`: the size, quality, count, output format and
 * background an image session's turns use unless a turn names its own
 * (relay_tool update_session `image`, the conversation settings route).
 * JSON as shared/openai-image-options.mjs validates it; NULL means none.
 *
 * `queue.image_options_json`: the options of one image turn as the send
 * settled them, for a turn without an image operation (the worker sends them
 * with its direct request). NULL for every other turn.
 *
 * The image tables are created by migrateImageConversationSchema
 * (repositories/image-conversation-repository.mjs), which this migration
 * calls first, additively, so a database whose tables are missing gets them
 * before the column. A database without the queue table (no relay's) is
 * left alone.
 *
 * Additive and idempotent. Safe to run on every boot. Rolling back needs no
 * data change: older code ignores the column.
 *
 * Usage: node server/migrations/0040-image-session-defaults.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';
import { migrateImageConversationSchema } from '../repositories/image-conversation-repository.mjs';

export function hasImageSessionDefaultsColumn(db) {
  try {
    return db.prepare(`PRAGMA table_info(image_sessions)`).all().some((column) => column.name === 'defaults_json');
  } catch {
    return false;
  }
}

function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

export function hasQueueImageOptionsColumn(db) {
  try {
    return db.prepare(`PRAGMA table_info(queue)`).all().some((column) => column.name === 'image_options_json');
  } catch {
    return false;
  }
}

export function migrateImageSessionDefaults(db) {
  // The image schema reads the queue; a database without one is no relay's.
  if (!tableExists(db, 'queue')) return { applied: false, columnsAdded: 0 };
  migrateImageConversationSchema(db);
  let columnsAdded = 0;
  if (!hasImageSessionDefaultsColumn(db)) {
    db.exec(`ALTER TABLE image_sessions ADD COLUMN defaults_json TEXT`);
    columnsAdded += 1;
  }
  if (!hasQueueImageOptionsColumn(db)) {
    db.exec(`ALTER TABLE queue ADD COLUMN image_options_json TEXT`);
    columnsAdded += 1;
  }
  return { applied: columnsAdded > 0, columnsAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateImageSessionDefaults(db);
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
    console.log(`Migration 0040 on ${dbPath}`);
    console.log(result.applied ? `  image session defaults, turn options: columns added ${result.columnsAdded}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0040 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
