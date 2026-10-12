'use strict';

/**
 * Migration: sub-agent timeline.
 *
 * 1. `subagent_timeline` — one row per entry of a sub-agent's record (a
 *    thought, a tool call, a tool result, reply text, a child agent, a note),
 *    in the order the relay first saw it (`seq`, per run). A writer names each
 *    entry with its own `entry_key`; a second write under the same key updates
 *    the entry in place (live text, a thought that is still streaming) and
 *    keeps its place in the order.
 * 2. Header columns on `subagent_runs`: what the task panel shows (model,
 *    type, tokens) and what the viewer needs to know about the run (task id,
 *    background, whether the record was cut, who writes the timeline). The
 *    panel's own copy lives in memory only and is gone when the task settles.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0009-subagent-timeline.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

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

export const SUBAGENT_RUN_HEADER_COLUMNS = Object.freeze([
  ['model', 'TEXT'],
  ['model_inherited', 'INTEGER'],
  ['subagent_type', 'TEXT'],
  ['task_id', 'TEXT'],
  ['total_tokens', 'INTEGER'],
  ['background', 'INTEGER NOT NULL DEFAULT 0'],
  ['truncated', 'INTEGER NOT NULL DEFAULT 0'],
  ['timeline_owner', 'TEXT'],
]);

export function migrateSubagentTimeline(db) {
  if (!tableExists(db, 'subagent_runs')) return { applied: false, tablesAdded: 0, columnsAdded: 0, indexesAdded: 0 };
  let tablesAdded = 0;
  let columnsAdded = 0;
  let indexesAdded = 0;

  const runColumns = columnNames(db, 'subagent_runs');
  for (const [name, type] of SUBAGENT_RUN_HEADER_COLUMNS) {
    if (runColumns.has(name)) continue;
    db.exec(`ALTER TABLE subagent_runs ADD COLUMN ${name} ${type}`);
    columnsAdded += 1;
  }
  if (!indexExists(db, 'idx_subagent_runs_parent')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_subagent_id)`);
    indexesAdded += 1;
  }

  if (!tableExists(db, 'subagent_timeline')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS subagent_timeline (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id           TEXT NOT NULL,
        conversation_id  TEXT NOT NULL,
        queue_message_id TEXT,
        entry_key        TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        kind             TEXT NOT NULL,
        text             TEXT,
        tool_name        TEXT,
        tool_use_id      TEXT,
        metadata_json    TEXT,
        done             INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE (run_id, entry_key),
        UNIQUE (run_id, seq),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      )
    `);
    tablesAdded += 1;
  }
  if (!indexExists(db, 'idx_subagent_timeline_conversation')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_subagent_timeline_conversation ON subagent_timeline(conversation_id)`);
    indexesAdded += 1;
  }
  return {
    applied: tablesAdded + columnsAdded + indexesAdded > 0,
    tablesAdded,
    columnsAdded,
    indexesAdded,
  };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateSubagentTimeline(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0009 on ${dbPath}`);
    console.log(result.applied
      ? `  sub-agent timeline: tables added ${result.tablesAdded}, columns added ${result.columnsAdded}, indexes added ${result.indexesAdded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0009 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
