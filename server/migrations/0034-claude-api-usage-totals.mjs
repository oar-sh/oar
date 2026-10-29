'use strict';

/**
 * Migration: Claude API usage totals (services/plan-usage-service.mjs, the
 * Claude API card in Check Usage and its monthly cap).
 *
 * `claude_api_usage_totals`: what this relay's turns on the saved Claude API
 * key ran, per day and model; a row only ever grows. Subscription turns are
 * never booked here. The card shows today and this month, and the cap is a
 * calendar month in relay local time, so the day is the relay's local date.
 *
 * - `day`: `YYYY-MM-DD`, the relay's local date of the turn's result.
 * - `model`: the model's id as the CLI reported it, without the `[1m]`
 *   suffix, lower case.
 * - `hit_tokens`, `miss_tokens`, `output_tokens`: input read from the
 *   prompt cache, other input (cache writes included), and output.
 * - `cost_usd`: Claude Code's own estimate (`modelUsage[*].costUSD`) of what
 *   the booked turns cost, for the turns it could price.
 * - `unknown_cost_tokens`: the tokens of turns it could not price
 *   (`costBasis: unknown`), which `cost_usd` leaves out.
 * - `turn_count`: the posts that booked something for the model.
 * - `first_seen_at`, `last_seen_at`, `updated_at`.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0034-claude-api-usage-totals.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const CLAUDE_API_USAGE_TOTALS_TABLE = 'claude_api_usage_totals';

export const CLAUDE_API_USAGE_TOTALS_COLUMNS = Object.freeze([
  'day',
  'model',
  'hit_tokens',
  'miss_tokens',
  'output_tokens',
  'cost_usd',
  'unknown_cost_tokens',
  'turn_count',
  'first_seen_at',
  'last_seen_at',
  'updated_at',
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

/** What keeps the service from using the table: '' when nothing does. */
export function claudeApiUsageTotalsProblem(db) {
  if (!tableExists(db, CLAUDE_API_USAGE_TOTALS_TABLE)) return `no ${CLAUDE_API_USAGE_TOTALS_TABLE} table`;
  const present = new Set(db.prepare(`PRAGMA table_info(${CLAUDE_API_USAGE_TOTALS_TABLE})`).all().map((column) => column.name));
  const missing = CLAUDE_API_USAGE_TOTALS_COLUMNS.filter((name) => !present.has(name));
  if (missing.length) return `${CLAUDE_API_USAGE_TOTALS_TABLE} lacks ${missing.join(', ')}`;
  return '';
}

export function migrateClaudeApiUsageTotals(db) {
  if (tableExists(db, CLAUDE_API_USAGE_TOTALS_TABLE)) return { applied: false, tablesAdded: 0 };
  db.exec(`
    CREATE TABLE ${CLAUDE_API_USAGE_TOTALS_TABLE} (
      day                  TEXT NOT NULL,
      model                TEXT NOT NULL,
      hit_tokens           INTEGER NOT NULL DEFAULT 0,
      miss_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens        INTEGER NOT NULL DEFAULT 0,
      cost_usd             REAL NOT NULL DEFAULT 0,
      unknown_cost_tokens  INTEGER NOT NULL DEFAULT 0,
      turn_count           INTEGER NOT NULL DEFAULT 0,
      first_seen_at        TEXT NOT NULL,
      last_seen_at         TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      PRIMARY KEY (day, model)
    )
  `);
  return { applied: true, tablesAdded: 1 };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateClaudeApiUsageTotals(db);
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
    console.log(`Migration 0034 on ${dbPath}`);
    console.log(result.applied ? `  claude api usage totals: tables added ${result.tablesAdded}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0034 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
