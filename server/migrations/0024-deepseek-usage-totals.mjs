'use strict';

/**
 * Migration: DeepSeek usage totals (services/plan-usage-service.mjs, the
 * DeepSeek card in Check Usage).
 *
 * `deepseek_usage_totals`: one row per DeepSeek model this relay's DeepSeek
 * turns used, summed over every turn the workers reported
 * (POST /api/deepseek-plan-usage). A row only ever grows.
 *
 * - `model`: the model's id as the CLI reported it, without Claude Code's
 *   `[1m]` suffix, lower case.
 * - `hit_tokens`, `miss_tokens`, `output_tokens`: input DeepSeek served from
 *   its cache, input it did not, and output.
 * - `turn_count`: the reports that named the model.
 * - `cost_usd`, `cost_cny`: the estimate from shared/deepseek-pricing.mjs at
 *   the price of each turn's own time (peak or off-peak); NULL while no turn
 *   of the model could be priced (a model the price table does not know).
 * - `first_seen_at`, `last_seen_at`: the earliest and latest turn time.
 *
 * `deepseek_usage_checkpoints`: what a worker last reported per
 * (conversation, Claude Code session, model). A worker reports the CLI's
 * running totals, and a CLI resumed on a session starts from that session's
 * earlier totals, so the relay books only what a report adds to the totals
 * last reported for the session: a restarted worker or a resumed CLI books
 * nothing twice, and a new session starts from zero. A total below the
 * checkpoint is a CLI counting from zero again: that report is booked in
 * full and the checkpoint starts over from it.
 *
 * - `conversation_id`, `native_session_id` (the CLI's session id), `model`.
 * - `hit_tokens`, `miss_tokens`, `output_tokens`: the totals last reported.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0024-deepseek-usage-totals.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

export const DEEPSEEK_USAGE_TOTALS_TABLE = 'deepseek_usage_totals';
export const DEEPSEEK_USAGE_CHECKPOINTS_TABLE = 'deepseek_usage_checkpoints';

export const DEEPSEEK_USAGE_TOTALS_COLUMNS = Object.freeze([
  'model',
  'hit_tokens',
  'miss_tokens',
  'output_tokens',
  'turn_count',
  'cost_usd',
  'cost_cny',
  'first_seen_at',
  'last_seen_at',
  'updated_at',
]);

export const DEEPSEEK_USAGE_CHECKPOINT_COLUMNS = Object.freeze([
  'conversation_id',
  'native_session_id',
  'model',
  'hit_tokens',
  'miss_tokens',
  'output_tokens',
  'updated_at',
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

/** What keeps the service from using the table: '' when nothing does. */
export function deepseekUsageTotalsTableProblem(db) {
  for (const [table, columns] of [
    [DEEPSEEK_USAGE_TOTALS_TABLE, DEEPSEEK_USAGE_TOTALS_COLUMNS],
    [DEEPSEEK_USAGE_CHECKPOINTS_TABLE, DEEPSEEK_USAGE_CHECKPOINT_COLUMNS],
  ]) {
    if (!tableExists(db, table)) return `no ${table} table`;
    const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    const missing = columns.filter((name) => !present.has(name));
    if (missing.length) return `${table} lacks ${missing.join(', ')}`;
  }
  return '';
}

export function migrateDeepSeekUsageTotals(db) {
  let tablesAdded = 0;
  if (!tableExists(db, DEEPSEEK_USAGE_CHECKPOINTS_TABLE)) {
    db.exec(`
      CREATE TABLE ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} (
        conversation_id    TEXT NOT NULL,
        native_session_id  TEXT NOT NULL,
        model              TEXT NOT NULL,
        hit_tokens         INTEGER NOT NULL DEFAULT 0,
        miss_tokens        INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        updated_at         TEXT NOT NULL,
        PRIMARY KEY (conversation_id, native_session_id, model)
      )
    `);
    tablesAdded += 1;
  }
  if (tableExists(db, DEEPSEEK_USAGE_TOTALS_TABLE)) return { applied: tablesAdded > 0, tablesAdded };
  db.exec(`
    CREATE TABLE ${DEEPSEEK_USAGE_TOTALS_TABLE} (
      model          TEXT PRIMARY KEY,
      hit_tokens     INTEGER NOT NULL DEFAULT 0,
      miss_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      turn_count     INTEGER NOT NULL DEFAULT 0,
      cost_usd       REAL,
      cost_cny       REAL,
      first_seen_at  TEXT NOT NULL,
      last_seen_at   TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    )
  `);
  tablesAdded += 1;
  return { applied: true, tablesAdded };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateDeepSeekUsageTotals(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0024 on ${dbPath}`);
    console.log(result.applied ? `  deepseek usage totals: tables added ${result.tablesAdded}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0024 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
