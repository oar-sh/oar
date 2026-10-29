'use strict';

/**
 * Migration: the figures of DeepSeek's own usage export, imported from the
 * platform's two CSV files (services/deepseek-usage-import.mjs). The usage
 * card in Check Usage shows them instead of the relay's estimate for the
 * days and models they cover.
 *
 * Adds one table of its own, `deepseek_usage_actuals`, one row per export
 * day, model and API key (the key is the day, so a re-export taken in
 * another time zone replaces the day instead of adding a second row):
 * - `day`: the local date of `period_start`, in the export's time zone;
 * - `period_start`, `period_end`: the first start and last end of the day's
 *   periods as the export gives them (ISO with the export's offset);
 * - `model`, `key_fp` (the key masked as `sk-XXXXX…YYYY`), `key_name`;
 * - `hit_tokens`, `miss_tokens`, `output_tokens`, `request_count`;
 * - `cost`, `currency`: the period's cost, amount × price summed;
 * - `imported_at`.
 *
 * The relay's own usage tables are not touched. Additive and idempotent.
 * Safe to run on every boot.
 *
 * Usage: node server/migrations/0030-deepseek-usage-actuals.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const DEEPSEEK_USAGE_ACTUALS_TABLE = 'deepseek_usage_actuals';

export const DEEPSEEK_USAGE_ACTUALS_COLUMNS = Object.freeze([
  'period_start',
  'period_end',
  'day',
  'model',
  'key_fp',
  'key_name',
  'hit_tokens',
  'miss_tokens',
  'output_tokens',
  'request_count',
  'cost',
  'currency',
  'imported_at',
]);

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS ${DEEPSEEK_USAGE_ACTUALS_TABLE} (
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    key_fp TEXT NOT NULL,
    key_name TEXT NOT NULL DEFAULT '',
    hit_tokens INTEGER NOT NULL DEFAULT 0,
    miss_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT '',
    imported_at TEXT NOT NULL,
    PRIMARY KEY (day, model, key_fp)
  );
  CREATE INDEX IF NOT EXISTS idx_${DEEPSEEK_USAGE_ACTUALS_TABLE}_key_day
    ON ${DEEPSEEK_USAGE_ACTUALS_TABLE} (key_fp, day);
`;

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

/** What keeps the import from using the table: '' when nothing does. */
export function deepseekUsageActualsProblem(db) {
  if (!tableExists(db, DEEPSEEK_USAGE_ACTUALS_TABLE)) return `no ${DEEPSEEK_USAGE_ACTUALS_TABLE} table`;
  const present = columnNames(db, DEEPSEEK_USAGE_ACTUALS_TABLE);
  const missing = DEEPSEEK_USAGE_ACTUALS_COLUMNS.filter((name) => !present.has(name));
  if (missing.length) return `${DEEPSEEK_USAGE_ACTUALS_TABLE} lacks ${missing.join(', ')}`;
  return '';
}

export function migrateDeepSeekUsageActuals(db) {
  const existed = tableExists(db, DEEPSEEK_USAGE_ACTUALS_TABLE);
  db.exec(CREATE_SQL);
  return { applied: !existed, tableCreated: !existed };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateDeepSeekUsageActuals(db);
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
    console.log(`Migration 0030 on ${dbPath}`);
    console.log(result.applied
      ? '  deepseek usage actuals: table created'
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0030 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
