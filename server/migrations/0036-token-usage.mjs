'use strict';

/**
 * Migration: tokens per turn for every provider, and their daily sums
 * (services/token-usage-service.mjs, the Tokens sections in Check Usage and
 * the About panel).
 *
 * `turn_token_usage`: one row per turn, run and model, kept with the chat
 * and deleted with it.
 * - `conversation_id`; `turn_id`: the queue row id (the user message's id);
 *   no foreign key, as queue rows are pruned.
 * - `run_id`: the worker process or attempt ('' for none), so a re-run after
 *   a crash keeps the first attempt's row.
 * - `model`: lower case, without `[1m]`. `provider`: the relay's provider
 *   kind. `billing`: '' or `byok-<provider type>` (Copilot's own key).
 * - `native_session_id`, `response_message_id`: NULL when not known.
 * - `at`: the turn's first report (ISO); `day`: its relay local date
 *   (`YYYY-MM-DD`), fixed at the first report.
 * - `input_tokens` (fresh input, no cache), `output_tokens`,
 *   `cache_write_tokens`, `cache_read_tokens`, `reasoning_tokens` (part of
 *   output): NULL when the provider did not report the field; 0 when it
 *   reported zero.
 * - `cost_usd` (NULL when not known), `cost_source` (`claude-code`,
 *   `provider`, `oar-deepseek-table`), `cost_unknown`.
 *
 * `token_usage_days`: the sums per day, provider, billing, model and source
 * (`turns`, or `backfill` for the copy below). Its rows survive the chats.
 * A token field stays NULL until some turn reports it, then it is a sum.
 *
 * Backfill, in the transaction that creates the tables (a `token_usage_days`
 * table that exists means it ran): the Claude API totals (0034, local days)
 * and DeepSeek's days (0025, UTC days, kept as they are) are copied with
 * `source='backfill'`. Their `miss_tokens` become `input_tokens` (cache
 * writes included: the views say so), `hit_tokens` `cache_read_tokens`, and
 * `cache_write_tokens` stays NULL. Model ids are normalised as above, and
 * rows that meet on one key are summed. DeepSeek's `cost_usd` is the token
 * estimate alone (its tools cost stays on the DeepSeek card; a NULL stays
 * NULL), and its days keep no seen times, so the day's bounds stand in. A
 * source that 0034's or 0025's own check finds missing or partial (its
 * migration failed this boot) makes this one throw, so the schema boot logs
 * it and retries on the next boot once the source is there.
 *
 * Additive and idempotent. Safe to run on every boot.
 *
 * Usage: node server/migrations/0036-token-usage.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import { cliDbPath } from '../services/database-file.mjs';

import { CLAUDE_API_USAGE_TOTALS_TABLE, claudeApiUsageTotalsProblem } from './0034-claude-api-usage-totals.mjs';
import { DEEPSEEK_USAGE_DAYS_TABLE, deepseekUsageRequestsDailyProblem } from './0025-deepseek-usage-requests-daily.mjs';

export const TURN_TOKEN_USAGE_TABLE = 'turn_token_usage';
export const TOKEN_USAGE_DAYS_TABLE = 'token_usage_days';
export const TURN_TOKEN_USAGE_INDEXES = Object.freeze([
  'idx_turn_token_usage_conversation',
  'idx_turn_token_usage_native_session',
]);

export const TURN_TOKEN_USAGE_COLUMNS = Object.freeze([
  'conversation_id',
  'turn_id',
  'run_id',
  'model',
  'provider',
  'billing',
  'native_session_id',
  'response_message_id',
  'at',
  'day',
  'input_tokens',
  'output_tokens',
  'cache_write_tokens',
  'cache_read_tokens',
  'reasoning_tokens',
  'cost_usd',
  'cost_source',
  'cost_unknown',
  'updated_at',
]);

export const TOKEN_USAGE_DAYS_COLUMNS = Object.freeze([
  'day',
  'provider',
  'billing',
  'model',
  'source',
  'input_tokens',
  'output_tokens',
  'cache_write_tokens',
  'cache_read_tokens',
  'reasoning_tokens',
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

function missingColumns(db, table, expected) {
  const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  return expected.filter((name) => !present.has(name));
}

/** What keeps the service from using the tables: '' when nothing does. */
export function tokenUsageProblem(db) {
  for (const [table, expected] of [
    [TURN_TOKEN_USAGE_TABLE, TURN_TOKEN_USAGE_COLUMNS],
    [TOKEN_USAGE_DAYS_TABLE, TOKEN_USAGE_DAYS_COLUMNS],
  ]) {
    if (!tableExists(db, table)) return `no ${table} table`;
    const missing = missingColumns(db, table, expected);
    if (missing.length) return `${table} lacks ${missing.join(', ')}`;
  }
  return '';
}

// The tables' model id: lower case, without the `[1m]` suffix
// (shared/turn-token-usage.mjs), in SQL.
const BOOKED_MODEL_SQL = `CASE WHEN LOWER(TRIM(model)) LIKE '%[1m]' THEN SUBSTR(LOWER(TRIM(model)), 1, LENGTH(TRIM(model)) - 4) ELSE LOWER(TRIM(model)) END`;

// Two source rows can land on one key once their model ids are normalised:
// they are summed, null-aware.
const BACKFILL_UPSERT = `
  ON CONFLICT (day, provider, billing, model, source) DO UPDATE SET
    input_tokens = CASE WHEN excluded.input_tokens IS NULL THEN input_tokens ELSE COALESCE(input_tokens, 0) + excluded.input_tokens END,
    output_tokens = CASE WHEN excluded.output_tokens IS NULL THEN output_tokens ELSE COALESCE(output_tokens, 0) + excluded.output_tokens END,
    cache_read_tokens = CASE WHEN excluded.cache_read_tokens IS NULL THEN cache_read_tokens ELSE COALESCE(cache_read_tokens, 0) + excluded.cache_read_tokens END,
    cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + excluded.cost_usd END,
    unknown_cost_tokens = unknown_cost_tokens + excluded.unknown_cost_tokens,
    turn_count = turn_count + excluded.turn_count,
    first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
`;

export function migrateTokenUsage(db, { now = () => new Date().toISOString() } = {}) {
  return db.transaction(() => {
    let tablesAdded = 0;
    const backfilled = { claudeApi: 0, deepseek: 0 };
    // Done means both tables exist, checked inside the transaction.
    if (tableExists(db, TOKEN_USAGE_DAYS_TABLE) && tableExists(db, TURN_TOKEN_USAGE_TABLE)) {
      return { applied: false, tablesAdded, backfilled };
    }
    if (!tableExists(db, TURN_TOKEN_USAGE_TABLE)) {
      db.exec(`
        CREATE TABLE ${TURN_TOKEN_USAGE_TABLE} (
          conversation_id      TEXT NOT NULL,
          turn_id              TEXT NOT NULL,
          run_id               TEXT NOT NULL DEFAULT '',
          model                TEXT NOT NULL,
          provider             TEXT NOT NULL,
          billing              TEXT NOT NULL DEFAULT '',
          native_session_id    TEXT,
          response_message_id  TEXT,
          at                   TEXT NOT NULL,
          day                  TEXT NOT NULL,
          input_tokens         INTEGER,
          output_tokens        INTEGER,
          cache_write_tokens   INTEGER,
          cache_read_tokens    INTEGER,
          reasoning_tokens     INTEGER,
          cost_usd             REAL,
          cost_source          TEXT,
          cost_unknown         INTEGER NOT NULL DEFAULT 0,
          updated_at           TEXT NOT NULL,
          PRIMARY KEY (turn_id, run_id, model)
        );
        CREATE INDEX IF NOT EXISTS ${TURN_TOKEN_USAGE_INDEXES[0]} ON ${TURN_TOKEN_USAGE_TABLE} (conversation_id, at);
        CREATE INDEX IF NOT EXISTS ${TURN_TOKEN_USAGE_INDEXES[1]} ON ${TURN_TOKEN_USAGE_TABLE} (native_session_id);
      `);
      tablesAdded += 1;
    }
    if (!tableExists(db, TOKEN_USAGE_DAYS_TABLE)) {
      // The copy needs both sources as 0034 and 0025 leave them; a missing or
      // partial one (its migration failed this boot) waits for the next boot.
      for (const problem of [claudeApiUsageTotalsProblem(db), deepseekUsageRequestsDailyProblem(db)]) {
        if (problem) throw new Error(`cannot backfill yet: ${problem}`);
      }
      db.exec(`
        CREATE TABLE ${TOKEN_USAGE_DAYS_TABLE} (
          day                  TEXT NOT NULL,
          provider             TEXT NOT NULL,
          billing              TEXT NOT NULL DEFAULT '',
          model                TEXT NOT NULL,
          source               TEXT NOT NULL,
          input_tokens         INTEGER,
          output_tokens        INTEGER,
          cache_write_tokens   INTEGER,
          cache_read_tokens    INTEGER,
          reasoning_tokens     INTEGER,
          cost_usd             REAL,
          unknown_cost_tokens  INTEGER NOT NULL DEFAULT 0,
          turn_count           INTEGER NOT NULL DEFAULT 0,
          first_seen_at        TEXT NOT NULL,
          last_seen_at         TEXT NOT NULL,
          updated_at           TEXT NOT NULL,
          PRIMARY KEY (day, provider, billing, model, source)
        )
      `);
      tablesAdded += 1;
      const at = now();
      const columns = `
        day, provider, billing, model, source,
        input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, reasoning_tokens,
        cost_usd, unknown_cost_tokens, turn_count, first_seen_at, last_seen_at, updated_at
      `;
      // `WHERE true`: SQLite's parser needs it before an upsert on a SELECT.
      backfilled.claudeApi = db.prepare(`
        INSERT INTO ${TOKEN_USAGE_DAYS_TABLE} (${columns})
        SELECT day, 'claude-api', '', ${BOOKED_MODEL_SQL}, 'backfill',
          miss_tokens, output_tokens, NULL, hit_tokens, NULL,
          cost_usd, COALESCE(unknown_cost_tokens, 0), COALESCE(turn_count, 0), first_seen_at, last_seen_at, ?
        FROM ${CLAUDE_API_USAGE_TOTALS_TABLE} WHERE true
        ${BACKFILL_UPSERT}
      `).run(at).changes;
      // DeepSeek's days keep no seen times: the day's start and end stand in
      // (UTC days). Its token estimate only, in dollars; no unknown tokens.
      backfilled.deepseek = db.prepare(`
        INSERT INTO ${TOKEN_USAGE_DAYS_TABLE} (${columns})
        SELECT day, 'deepseek', '', ${BOOKED_MODEL_SQL}, 'backfill',
          miss_tokens, output_tokens, NULL, hit_tokens, NULL,
          cost_usd, 0, COALESCE(turn_count, 0), day || 'T00:00:00.000Z', day || 'T23:59:59.999Z', ?
        FROM ${DEEPSEEK_USAGE_DAYS_TABLE} WHERE true
        ${BACKFILL_UPSERT}
      `).run(at).changes;
    }
    return { applied: true, tablesAdded, backfilled };
  })();
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateTokenUsage(db);
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
    console.log(`Migration 0036 on ${dbPath}`);
    console.log(result.applied
      ? `  token usage: tables added ${result.tablesAdded}, backfilled days: claude api ${result.backfilled.claudeApi}, deepseek ${result.backfilled.deepseek}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0036 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
