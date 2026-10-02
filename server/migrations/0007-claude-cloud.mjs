'use strict';

/**
 * Migration: storage for Claude Cloud conversations (provider `claude-cloud`).
 *
 * 1. `runtime_sessions.claude_cloud_session_id` — the cloud session a
 *    conversation runs in, reported by its worker after the first message
 *    (the per-provider native id, next to `claude_native_session_id`,
 *    `cursor_agent_id` and `grok_native_session_id`).
 * 2. `runtime_sessions.claude_cloud_last_sequence` — the last event sequence
 *    the worker has handled: where it resumes the event stream after a restart.
 * 3. `runtime_sessions.claude_cloud_cost_usd` — what the session has cost so
 *    far, as the cloud reports it.
 * 4. `conversations.cloud_source_json` — what the session clones and where it
 *    is shown: `{ repoUrl, branch, environmentId, sessionUrl,
 *    pushedBranches: [{ branch, at }] }`.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0007-claude-cloud.mjs [path/to/copilot.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';

const COLUMNS = Object.freeze([
  Object.freeze({ table: 'runtime_sessions', name: 'claude_cloud_session_id', type: 'TEXT' }),
  Object.freeze({ table: 'runtime_sessions', name: 'claude_cloud_last_sequence', type: 'TEXT' }),
  Object.freeze({ table: 'runtime_sessions', name: 'claude_cloud_cost_usd', type: 'REAL' }),
  Object.freeze({ table: 'conversations', name: 'cloud_source_json', type: 'TEXT' }),
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => String(column.name)));
}

export function migrateClaudeCloud(db) {
  let columnsAdded = 0;
  for (const column of COLUMNS) {
    if (!tableExists(db, column.table)) continue;
    if (columnNames(db, column.table).has(column.name)) continue;
    db.exec(`ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.type}`);
    columnsAdded += 1;
  }
  return { applied: columnsAdded > 0, columnsAdded };
}

function defaultDbPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', 'data', 'copilot.db');
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateClaudeCloud(db);
  } finally {
    db.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dbPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultDbPath();
  try {
    const result = migrate(dbPath);
    console.log(`Migration 0007 on ${dbPath}`);
    console.log(result.applied ? `  claude cloud columns added: ${result.columnsAdded}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0007 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
