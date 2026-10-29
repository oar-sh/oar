'use strict';

/**
 * Migration: pruning old sub-agent records.
 *
 * After the retention period the relay strips a finished run's tool inputs
 * and tool results (services/subagent-record-retention.mjs). `pruned_at`
 * marks an entry it already stripped, and a partial index over the tool
 * entries not stripped yet, by age, lets the daily sweep go straight to its
 * candidates instead of reading the whole table every day.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0010-subagent-timeline-pruning.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const PRUNABLE_INDEX_NAME = 'idx_subagent_timeline_prunable';

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function indexExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
}

export function migrateSubagentTimelinePruning(db) {
  if (!tableExists(db, 'subagent_timeline')) return { applied: false, columnsAdded: 0, indexesAdded: 0 };
  let columnsAdded = 0;
  let indexesAdded = 0;
  if (!columnNames(db, 'subagent_timeline').has('pruned_at')) {
    db.exec(`ALTER TABLE subagent_timeline ADD COLUMN pruned_at TEXT`);
    columnsAdded += 1;
  }
  if (!indexExists(db, PRUNABLE_INDEX_NAME)) {
    // The sweep's WHERE repeats this condition word for word, so SQLite can
    // use the partial index.
    db.exec(`
      CREATE INDEX IF NOT EXISTS ${PRUNABLE_INDEX_NAME}
      ON subagent_timeline(updated_at)
      WHERE pruned_at IS NULL AND kind IN ('tool_call', 'tool_result')
    `);
    indexesAdded += 1;
  }
  return { applied: columnsAdded + indexesAdded > 0, columnsAdded, indexesAdded };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateSubagentTimelinePruning(db);
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
    console.log(`Migration 0010 on ${dbPath}`);
    console.log(result.applied
      ? `  sub-agent timeline pruning: columns added ${result.columnsAdded}, indexes added ${result.indexesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0010 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
