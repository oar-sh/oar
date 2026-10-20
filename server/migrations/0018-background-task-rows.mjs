'use strict';

/**
 * Migration: the task console's rows outlive a relay restart.
 *
 * `background_task_rows` holds what the relay keeps of a background task
 * that has a console (a shell or Monitor task naming its output file), per
 * store key (the id the worker posts under, its SDK session id) and task:
 *
 * - `state` 'live': a task of the worker's last set. After a restart it is
 *   held back until the worker reports again: the worker's set decides which
 *   are still running, and those of a worker that does not report are marked
 *   ended, never shown as running again.
 * - `state` 'ended': the dimmed row the panel keeps for an hour after the end,
 *   with its status and exit code. `ended_at` (epoch ms) is what the hour
 *   counts from.
 * - `row_json` the task row as the store holds it, without the health
 *   reading (the poller reads the file again).
 *
 * Rows go when the hour is up, when the conversation is deleted, and live
 * rows when the worker's set no longer names them.
 *
 * Additive and idempotent. Safe to run on every boot. An older build never
 * reads the table; its consoles start empty after a restart as before.
 *
 * Usage: node server/migrations/0018-background-task-rows.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

export const BACKGROUND_TASK_ROWS_COLUMNS = Object.freeze(['store_key', 'task_id', 'state', 'row_json', 'ended_at', 'updated_at']);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

/** Why the table cannot be used (a table of that name with other columns), or ''. */
export function backgroundTaskRowsTableProblem(db) {
  if (!tableExists(db, 'background_task_rows')) return 'no background_task_rows table';
  const present = new Set(db.prepare(`PRAGMA table_info(background_task_rows)`).all().map((column) => column.name));
  const missing = BACKGROUND_TASK_ROWS_COLUMNS.filter((name) => !present.has(name));
  return missing.length ? `background_task_rows lacks ${missing.join(', ')}` : '';
}

export function migrateBackgroundTaskRows(db) {
  let tablesAdded = 0;
  if (!tableExists(db, 'background_task_rows')) {
    db.exec(`
      CREATE TABLE background_task_rows (
        store_key  TEXT NOT NULL,
        task_id    TEXT NOT NULL,
        state      TEXT NOT NULL CHECK (state IN ('live', 'ended')),
        row_json   TEXT NOT NULL,
        ended_at   INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (store_key, task_id)
      )
    `);
    tablesAdded += 1;
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_background_task_rows_ended
    ON background_task_rows(state, ended_at)
  `);
  return { applied: tablesAdded > 0, tablesAdded };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateBackgroundTaskRows(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0018 on ${dbPath}`);
    console.log(result.applied
      ? `  background task rows: tables added ${result.tablesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0018 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
