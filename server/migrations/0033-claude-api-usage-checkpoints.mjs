'use strict';

/**
 * Migration: Claude API usage checkpoints (services/plan-usage-service.mjs,
 * recordClaudeApiUsageReport; the booking behind the Claude API card and its
 * monthly cap).
 *
 * Both Claude workers, the subscription one and the Claude API one, post
 * after every turn (POST /api/claude-api-usage). A chat can move between the
 * two billings and keeps its Claude Code session, so what one billing ran
 * shows up in the totals the other one reports after the switch. One row per
 * (conversation, Claude Code session, CLI process, model):
 *
 * - `conversation_id`, `native_session_id` (the CLI's session id), `run_id`
 *   (the id the worker gives each CLI process it spawns), `model`.
 * - `billing`: the kind of the worker that posted: `claude` or `claude-api`.
 * - `run_hit_tokens`, `run_miss_tokens`, `run_output_tokens`, `run_cost_usd`:
 *   what this process has run so far, counted from zero, as far as it was
 *   booked. A post books its rise over these; one at or below them is a
 *   retried or reordered post and books nothing. Only `claude-api` rows book
 *   spend.
 * - `session_hit_tokens`, `session_miss_tokens`, `session_output_tokens`,
 *   `session_cost_usd`: the CLI's own cumulative totals for the session at
 *   that post. The row of a session with the latest `last_turn_at` is the
 *   session's mark: a CLI resumed on the session, under either billing,
 *   re-reports the earlier turns in its first result, and the mark is what
 *   that first result is measured against.
 * - `cost_unknown`: 1 when the CLI had no price for the model.
 * - `last_turn_id` (the queue row of the turn), `last_turn_at` (when its
 *   result came): the turn the row covers. A mark is used only when no
 *   completed turn of the session is newer than it.
 * - `updated_at`.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0033-claude-api-usage-checkpoints.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

export const CLAUDE_API_USAGE_CHECKPOINTS_TABLE = 'claude_api_usage_checkpoints';

export const CLAUDE_API_USAGE_CHECKPOINT_COLUMNS = Object.freeze([
  'conversation_id',
  'native_session_id',
  'run_id',
  'model',
  'billing',
  'run_hit_tokens',
  'run_miss_tokens',
  'run_output_tokens',
  'run_cost_usd',
  'session_hit_tokens',
  'session_miss_tokens',
  'session_output_tokens',
  'session_cost_usd',
  'cost_unknown',
  'last_turn_id',
  'last_turn_at',
  'updated_at',
]);

function tableExists(db, name) {
  return !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

/** What keeps the service from using the table: '' when nothing does. */
export function claudeApiUsageCheckpointsProblem(db) {
  if (!tableExists(db, CLAUDE_API_USAGE_CHECKPOINTS_TABLE)) return `no ${CLAUDE_API_USAGE_CHECKPOINTS_TABLE} table`;
  const present = new Set(db.prepare(`PRAGMA table_info(${CLAUDE_API_USAGE_CHECKPOINTS_TABLE})`).all().map((column) => column.name));
  const missing = CLAUDE_API_USAGE_CHECKPOINT_COLUMNS.filter((name) => !present.has(name));
  if (missing.length) return `${CLAUDE_API_USAGE_CHECKPOINTS_TABLE} lacks ${missing.join(', ')}`;
  return '';
}

export function migrateClaudeApiUsageCheckpoints(db) {
  if (tableExists(db, CLAUDE_API_USAGE_CHECKPOINTS_TABLE)) return { applied: false, tablesAdded: 0 };
  db.exec(`
    CREATE TABLE ${CLAUDE_API_USAGE_CHECKPOINTS_TABLE} (
      conversation_id        TEXT NOT NULL,
      native_session_id      TEXT NOT NULL,
      run_id                 TEXT NOT NULL,
      model                  TEXT NOT NULL,
      billing                TEXT NOT NULL,
      run_hit_tokens         INTEGER NOT NULL DEFAULT 0,
      run_miss_tokens        INTEGER NOT NULL DEFAULT 0,
      run_output_tokens      INTEGER NOT NULL DEFAULT 0,
      run_cost_usd           REAL NOT NULL DEFAULT 0,
      session_hit_tokens     INTEGER NOT NULL DEFAULT 0,
      session_miss_tokens    INTEGER NOT NULL DEFAULT 0,
      session_output_tokens  INTEGER NOT NULL DEFAULT 0,
      session_cost_usd       REAL NOT NULL DEFAULT 0,
      cost_unknown           INTEGER NOT NULL DEFAULT 0,
      last_turn_id           TEXT,
      last_turn_at           TEXT,
      updated_at             TEXT NOT NULL,
      PRIMARY KEY (conversation_id, native_session_id, run_id, model)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_claude_api_usage_checkpoints_mark
      ON ${CLAUDE_API_USAGE_CHECKPOINTS_TABLE}(native_session_id, last_turn_at)
  `);
  return { applied: true, tablesAdded: 1 };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateClaudeApiUsageCheckpoints(db);
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
    console.log(`Migration 0033 on ${dbPath}`);
    console.log(result.applied ? `  claude api usage checkpoints: tables added ${result.tablesAdded}` : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0033 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
