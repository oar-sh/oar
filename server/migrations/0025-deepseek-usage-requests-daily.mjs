'use strict';

/**
 * Migration: DeepSeek web search and fetch counts, the daily spend, and the
 * balance reference (services/plan-usage-service.mjs, the DeepSeek card in
 * Check Usage). Builds on 0024.
 *
 * `deepseek_usage_totals` gains four columns:
 * - `search_requests`, `fetch_requests`: Claude Code's web searches and
 *   fetches on DeepSeek's Search API, counted from the first turn.
 * - `tools_cost_usd`, `tools_cost_cny`: what those cost, from
 *   shared/deepseek-pricing.mjs: 0 before DeepSeek started charging for
 *   them (2026-10-31 16:00 UTC), flat per request after. `cost_usd` and
 *   `cost_cny` stay the token estimate alone.
 *
 * `deepseek_usage_days`: the same sums per UTC day and model, booked in the
 * same transaction as the totals, for the card's daily spend chart and this
 * month's spend against the budget. History starts with this migration.
 * - `day`: `YYYY-MM-DD` in UTC, from the turn's time.
 * - the token, request, turn and cost columns as in the totals.
 *
 * `deepseek_balance_reference`: per currency, the balance after the latest
 * top-up as the card's meter reads it (balance left of the last top-up).
 * - `reference_total`: the balance after the latest rise; before the first
 *   rise is seen, the highest balance seen.
 * - `last_total`: the balance last read, to see the next rise.
 * - `reference_at`: when the reference was set.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0025-deepseek-usage-requests-daily.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

import { DEEPSEEK_USAGE_TOTALS_TABLE, migrateDeepSeekUsageTotals } from './0024-deepseek-usage-totals.mjs';
import { cliDbPath } from '../services/database-file.mjs';

export const DEEPSEEK_USAGE_DAYS_TABLE = 'deepseek_usage_days';
export const DEEPSEEK_BALANCE_REFERENCE_TABLE = 'deepseek_balance_reference';

// Added to deepseek_usage_totals, with their DDL.
export const DEEPSEEK_USAGE_REQUEST_COLUMNS = Object.freeze([
  ['search_requests', 'INTEGER NOT NULL DEFAULT 0'],
  ['fetch_requests', 'INTEGER NOT NULL DEFAULT 0'],
  ['tools_cost_usd', 'REAL NOT NULL DEFAULT 0'],
  ['tools_cost_cny', 'REAL NOT NULL DEFAULT 0'],
]);

export const DEEPSEEK_USAGE_DAYS_COLUMNS = Object.freeze([
  'day',
  'model',
  'hit_tokens',
  'miss_tokens',
  'output_tokens',
  'search_requests',
  'fetch_requests',
  'turn_count',
  'cost_usd',
  'cost_cny',
  'tools_cost_usd',
  'tools_cost_cny',
  'updated_at',
]);

export const DEEPSEEK_BALANCE_REFERENCE_COLUMNS = Object.freeze([
  'currency',
  'reference_total',
  'last_total',
  'reference_at',
  'updated_at',
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

/** What keeps the service from using the columns and tables: '' when nothing does. */
export function deepseekUsageRequestsDailyProblem(db) {
  if (!tableExists(db, DEEPSEEK_USAGE_TOTALS_TABLE)) return `no ${DEEPSEEK_USAGE_TOTALS_TABLE} table`;
  const totals = columnNames(db, DEEPSEEK_USAGE_TOTALS_TABLE);
  const missingColumns = DEEPSEEK_USAGE_REQUEST_COLUMNS.map(([name]) => name).filter((name) => !totals.has(name));
  if (missingColumns.length) return `${DEEPSEEK_USAGE_TOTALS_TABLE} lacks ${missingColumns.join(', ')}`;
  for (const [table, columns] of [
    [DEEPSEEK_USAGE_DAYS_TABLE, DEEPSEEK_USAGE_DAYS_COLUMNS],
    [DEEPSEEK_BALANCE_REFERENCE_TABLE, DEEPSEEK_BALANCE_REFERENCE_COLUMNS],
  ]) {
    if (!tableExists(db, table)) return `no ${table} table`;
    const present = columnNames(db, table);
    const missing = columns.filter((name) => !present.has(name));
    if (missing.length) return `${table} lacks ${missing.join(', ')}`;
  }
  return '';
}

export function migrateDeepSeekUsageRequestsDaily(db) {
  // The columns go on 0024's table: a database that skipped 0024 gets it first.
  migrateDeepSeekUsageTotals(db);
  let columnsAdded = 0;
  let tablesAdded = 0;
  const present = columnNames(db, DEEPSEEK_USAGE_TOTALS_TABLE);
  for (const [name, ddl] of DEEPSEEK_USAGE_REQUEST_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE ${DEEPSEEK_USAGE_TOTALS_TABLE} ADD COLUMN ${name} ${ddl}`);
    columnsAdded += 1;
  }
  if (!tableExists(db, DEEPSEEK_USAGE_DAYS_TABLE)) {
    db.exec(`
      CREATE TABLE ${DEEPSEEK_USAGE_DAYS_TABLE} (
        day              TEXT NOT NULL,
        model            TEXT NOT NULL,
        hit_tokens       INTEGER NOT NULL DEFAULT 0,
        miss_tokens      INTEGER NOT NULL DEFAULT 0,
        output_tokens    INTEGER NOT NULL DEFAULT 0,
        search_requests  INTEGER NOT NULL DEFAULT 0,
        fetch_requests   INTEGER NOT NULL DEFAULT 0,
        turn_count       INTEGER NOT NULL DEFAULT 0,
        cost_usd         REAL,
        cost_cny         REAL,
        tools_cost_usd   REAL NOT NULL DEFAULT 0,
        tools_cost_cny   REAL NOT NULL DEFAULT 0,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (day, model)
      )
    `);
    tablesAdded += 1;
  }
  if (!tableExists(db, DEEPSEEK_BALANCE_REFERENCE_TABLE)) {
    db.exec(`
      CREATE TABLE ${DEEPSEEK_BALANCE_REFERENCE_TABLE} (
        currency         TEXT PRIMARY KEY,
        reference_total  REAL NOT NULL,
        last_total       REAL NOT NULL,
        reference_at     TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      )
    `);
    tablesAdded += 1;
  }
  return { applied: columnsAdded + tablesAdded > 0, columnsAdded, tablesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateDeepSeekUsageRequestsDaily(db);
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
    console.log(`Migration 0025 on ${dbPath}`);
    console.log(result.applied
      ? `  deepseek usage requests and daily: columns added ${result.columnsAdded}, tables added ${result.tablesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0025 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
