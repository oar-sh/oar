'use strict';

/**
 * Migration: the DeepSeek usage checkpoint keeps the run id of its web
 * search and fetch counts apart from the run id of its token totals
 * (services/plan-usage-service.mjs, the DeepSeek card in Check Usage).
 * Builds on 0027.
 *
 * `deepseek_usage_checkpoints` gains one column:
 * - `request_run_id`: the worker's id of the Claude Code process the
 *   `search_requests` and `fetch_requests` counts came from; '' before any
 *   report with a run id carried counts for the model. With 0027 one
 *   `run_id` served both the totals and the counts, so a report that
 *   carried only counts for a model (a sub-agent's model that searched
 *   without a token entry of its own) moved the run id of that model's token
 *   totals too: a later token report of the earlier process was then read
 *   as a new process and booked in full instead of as a stale one. Now a
 *   token entry moves `run_id` and a request entry moves `request_run_id`,
 *   and neither disturbs the other.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0028-deepseek-usage-checkpoint-request-runs.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

import { DEEPSEEK_USAGE_CHECKPOINTS_TABLE } from './0024-deepseek-usage-totals.mjs';
import { migrateDeepSeekUsageCheckpointRuns } from './0027-deepseek-usage-checkpoint-runs.mjs';
import { cliDbPath } from '../services/database-file.mjs';

// Added to deepseek_usage_checkpoints, with their DDL.
export const DEEPSEEK_USAGE_CHECKPOINT_REQUEST_RUN_COLUMNS = Object.freeze([
  ['request_run_id', "TEXT NOT NULL DEFAULT ''"],
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

/** What keeps the service from using the column: '' when nothing does. */
export function deepseekUsageCheckpointRequestRunsProblem(db) {
  if (!tableExists(db, DEEPSEEK_USAGE_CHECKPOINTS_TABLE)) return `no ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} table`;
  const present = columnNames(db, DEEPSEEK_USAGE_CHECKPOINTS_TABLE);
  const missing = DEEPSEEK_USAGE_CHECKPOINT_REQUEST_RUN_COLUMNS.map(([name]) => name).filter((name) => !present.has(name));
  if (missing.length) return `${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} lacks ${missing.join(', ')}`;
  return '';
}

export function migrateDeepSeekUsageCheckpointRequestRuns(db) {
  // The column goes next to 0027's: a database that skipped 0027 gets them first.
  migrateDeepSeekUsageCheckpointRuns(db);
  let columnsAdded = 0;
  const present = columnNames(db, DEEPSEEK_USAGE_CHECKPOINTS_TABLE);
  for (const [name, ddl] of DEEPSEEK_USAGE_CHECKPOINT_REQUEST_RUN_COLUMNS) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} ADD COLUMN ${name} ${ddl}`);
    columnsAdded += 1;
  }
  return { applied: columnsAdded > 0, columnsAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateDeepSeekUsageCheckpointRequestRuns(db);
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
    console.log(`Migration 0028 on ${dbPath}`);
    console.log(result.applied
      ? `  deepseek usage checkpoint request runs: columns added ${result.columnsAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0028 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
