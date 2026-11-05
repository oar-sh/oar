'use strict';

/**
 * Migration: one order across a turn's thoughts and tool lines.
 *
 * `relay_activity.turn_seq` and `relay_thought.turn_seq`: a number per queue
 * message shared by both tables (repositories/question-repository.mjs
 * nextTurnSeq), given when a row is first written, so the stream view can
 * show a turn's thoughts and tool calls in the order they happened. NULL for
 * every row from before this migration and for rows a session-history
 * rebuild writes; a turn with such a row keeps the grouped layout.
 *
 * Indexes on (queue_message_id, turn_seq), partial (only numbered rows): the
 * next number is a max() over them. Not unique: one counter spans two tables.
 *
 * Not in SCHEMA_SQL (db-schema.mjs): that block runs before the migrations,
 * so an index on the column there would fail on every existing database.
 *
 * Additive and idempotent. Safe to run on every boot; a table that does not
 * exist yet is left alone. Rolling back needs no data change: older code
 * ignores the columns.
 *
 * Usage: node server/migrations/0038-turn-seq.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const TURN_SEQ_TABLES = Object.freeze(['relay_activity', 'relay_thought']);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

export function hasTurnSeqColumn(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'turn_seq');
  } catch {
    return false;
  }
}

export function migrateTurnSeq(db) {
  let columnsAdded = 0;
  let indexesAdded = 0;
  for (const table of TURN_SEQ_TABLES) {
    if (!tableExists(db, table)) continue;
    if (!hasTurnSeqColumn(db, table)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN turn_seq INTEGER`);
      columnsAdded += 1;
    }
    const index = `idx_${table}_queue_turn_seq`;
    const present = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index);
    if (!present) {
      db.exec(`CREATE INDEX ${index} ON ${table}(queue_message_id, turn_seq) WHERE turn_seq IS NOT NULL`);
      indexesAdded += 1;
    }
  }
  return { applied: columnsAdded + indexesAdded > 0, columnsAdded, indexesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateTurnSeq(db);
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
    console.log(`Migration 0038 on ${dbPath}`);
    console.log(result.applied
      ? `  turn order: columns added ${result.columnsAdded}, indexes added ${result.indexesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0038 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
