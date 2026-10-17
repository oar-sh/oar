'use strict';

/**
 * Migration: persisted previews.
 *
 * `previews` holds every published preview (a public link to a dev-server port
 * or to a folder the relay serves), so a restarted runtime can restore them and
 * a link handed out before the restart keeps working. One row per token:
 *
 * - `mode` is 'port' or 'static'. A port row has `target_host` and
 *   `target_port`, a static row `root_dir` (the folder's realpath).
 * - `conversation_id` is NULL for a preview registered without one.
 * - `created_at` and `last_hit_at` are epoch milliseconds.
 * - `host_boot_id` names the host boot the preview was registered in. A port
 *   preview is restored only in the same boot (a dev server does not survive a
 *   reboot, and the port may later belong to something else).
 *
 * No foreign key on `conversation_id`: deleting a conversation closes its
 * previews through the registry, and a restore drops rows whose conversation
 * is gone.
 *
 * Additive and idempotent. Safe to run on every boot, and from the command line
 * against a database a running relay has open (one CREATE TABLE in WAL mode).
 * An older build never reads the table.
 *
 * A `previews` table this migration did not create (other columns) is left
 * alone and reported as not compatible; the relay then keeps previews in
 * memory only, it never refuses to start over it.
 *
 * Usage: node server/migrations/0013-previews.mjs [path/to/copilot.db]
 * The file must exist: a wrong path is refused rather than creating an empty
 * database.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

export const PREVIEWS_COLUMNS = Object.freeze([
  'token', 'mode', 'conversation_id', 'label', 'target_host', 'target_port', 'root_dir',
  'created_at', 'last_hit_at', 'host_boot_id',
]);

/**
 * Why the `previews` table cannot be used, or '' when it can: every column
 * this build reads and writes is there, and any other column takes a NULL or
 * has a default (an insert would fail otherwise). '' too when the table is
 * missing; the caller checks that separately.
 */
export function previewsTableProblem(db) {
  const info = db.prepare(`PRAGMA table_info(previews)`).all();
  if (info.length === 0) return '';
  const names = new Set(info.map((column) => column.name));
  const missing = PREVIEWS_COLUMNS.filter((name) => !names.has(name));
  if (missing.length) return `the previews table lacks column(s) ${missing.join(', ')}`;
  const blocking = info.filter((column) => !PREVIEWS_COLUMNS.includes(column.name)
    && column.notnull && column.dflt_value === null && !column.pk);
  if (blocking.length) {
    return `the previews table has required column(s) this build does not write: ${blocking.map((column) => column.name).join(', ')}`;
  }
  return '';
}

export function migratePreviews(db) {
  let tablesAdded = 0;
  if (!tableExists(db, 'previews')) {
    db.exec(`
      CREATE TABLE previews (
        token           TEXT PRIMARY KEY,
        mode            TEXT NOT NULL,
        conversation_id TEXT,
        label           TEXT NOT NULL,
        target_host     TEXT,
        target_port     INTEGER,
        root_dir        TEXT,
        created_at      INTEGER NOT NULL,
        last_hit_at     INTEGER,
        host_boot_id    TEXT
      )
    `);
    tablesAdded += 1;
  }
  const problem = previewsTableProblem(db);
  if (problem) return { applied: false, tablesAdded, compatible: false, problem };
  db.exec(`CREATE INDEX IF NOT EXISTS idx_previews_conversation ON previews(conversation_id)`);
  return { applied: tablesAdded > 0, tablesAdded, compatible: true };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const db = new Database(dbPath, { fileMustExist: true, ...options });
  try {
    return migratePreviews(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0013 on ${dbPath}`);
    if (!result.compatible) {
      console.error(`  not compatible: ${result.problem}; the relay will keep previews in memory only`);
      process.exit(1);
    }
    console.log(result.applied
      ? `  previews: tables added ${result.tablesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0013 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
