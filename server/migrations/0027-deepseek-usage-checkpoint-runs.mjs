'use strict';

/**
 * Migration: the DeepSeek usage checkpoint learns which worker process its
 * totals came from, and keeps the process's web search and fetch counts
 * (services/plan-usage-service.mjs, the DeepSeek card in Check Usage).
 * Builds on 0024.
 *
 * `deepseek_usage_checkpoints` gains three columns:
 * - `run_id`: the id the worker gives each Claude Code process it spawns
 *   (`runId` of a `POST /api/deepseek-plan-usage` body); '' for a report
 *   from an older worker. Running totals only grow within one process, so
 *   a report below the checkpoint under the SAME run id is a stale one (a
 *   retried or reordered post) and books nothing, while one under a NEW run
 *   id is a process that started counting over, booked in full. Before, any
 *   drop was taken as a fresh run and booked in full: a reordered pair of
 *   reports booked the turns before them twice.
 * - `search_requests`, `fetch_requests`: the process's running counts of
 *   web searches and fetches, which a worker with a run id reports in place
 *   of the turn's counts, so a repeated post adds nothing.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0027-deepseek-usage-checkpoint-runs.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

import { DEEPSEEK_USAGE_CHECKPOINTS_TABLE, migrateDeepSeekUsageTotals } from './0024-deepseek-usage-totals.mjs';
import { cliDbPath } from '../services/database-file.mjs';

// Added to deepseek_usage_checkpoints, with their DDL.
export const DEEPSEEK_USAGE_CHECKPOINT_RUN_COLUMNS = Object.freeze([
  ['run_id', "TEXT NOT NULL DEFAULT ''"],
  ['search_requests', 'INTEGER NOT NULL DEFAULT 0'],
  ['fetch_requests', 'INTEGER NOT NULL DEFAULT 0'],
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

/** What keeps the service from using the columns: '' when nothing does. */
export function deepseekUsageCheckpointRunsProblem(db) {
  if (!tableExists(db, DEEPSEEK_USAGE_CHECKPOINTS_TABLE)) return `no ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} table`;
  const present = columnNames(db, DEEPSEEK_USAGE_CHECKPOINTS_TABLE);
  const missing = DEEPSEEK_USAGE_CHECKPOINT_RUN_COLUMNS.map(([name]) => name).filter((name) => !present.has(name));
  if (missing.length) return `${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} lacks ${missing.join(', ')}`;
  return '';
}

export function migrateDeepSeekUsageCheckpointRuns(db) {
  // The columns go on 0024's table: a database that skipped 0024 gets it first.
  migrateDeepSeekUsageTotals(db);
  let columnsAdded = 0;
  const present = columnNames(db, DEEPSEEK_USAGE_CHECKPOINTS_TABLE);
  for (const [name, ddl] of DEEPSEEK_USAGE_CHECKPOINT_RUN_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} ADD COLUMN ${name} ${ddl}`);
    columnsAdded += 1;
  }
  return { applied: columnsAdded > 0, columnsAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateDeepSeekUsageCheckpointRuns(db);
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
    console.log(`Migration 0027 on ${dbPath}`);
    console.log(result.applied
      ? `  deepseek usage checkpoint runs: columns added ${result.columnsAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0027 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
