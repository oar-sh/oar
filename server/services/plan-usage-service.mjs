'use strict';

/**
 * Persistence + aggregation for plan usage.
 *
 * Storage is deliberately "latest snapshot only" for the provider payloads:
 * plan limits are account-wide and only the newest reading is meaningful, so
 * there is no per-turn history table here (per-turn Copilot deltas already
 * live in `message_usage_snapshots` and serve a different purpose).
 *
 * Cursor is the exception, and only as far as correctness demands: its spend
 * has to be *derived*, so two small bookkeeping tables are kept — a cumulative
 * per-agent checkpoint (to diff against) and per-cycle pool totals (the
 * accumulated result). Neither grows with conversation history.
 *
 * DeepSeek's estimated spend is summed per model (migration 0024): one row
 * per model. Its workers report the CLI's running totals, so a checkpoint per
 * (conversation, CLI session, model) is kept to diff against, as for Cursor.
 * The same sums go into a row per UTC day and model (migration 0025), for
 * the card's daily chart and its monthly budget; that table grows by at most
 * one row per model per day.
 */

import {
  PLAN_USAGE_VERSION,
  toFiniteNumber,
  toIsoTimestamp,
  toTrimmedString,
} from './plan-usage-contract.mjs';
import { buildCopilotPlanCard } from './plan-usage-copilot.mjs';
import { buildClaudePlanCard } from './plan-usage-claude.mjs';
import { CLAUDE_CLOUD_PROVIDER_ID, buildClaudeCloudPlanCard } from './plan-usage-claude-cloud.mjs';
import {
  CURSOR_POOLS,
  applyCursorUsageDelta,
  buildCursorPlanCard,
  emptyCursorPoolTotals,
  normalizeCursorAllowanceSettings,
  resolveCursorBillingCycle,
} from './plan-usage-cursor.mjs';
import {
  buildGrokPlanCard,
  normalizeGrokAllowanceSettings,
  normalizeGrokTurnUsage,
  resolveGrokBillingCycle,
} from './plan-usage-grok.mjs';
import { buildDeepSeekPlanCard } from './plan-usage-deepseek.mjs';
import {
  DEEPSEEK_USAGE_CHECKPOINTS_TABLE,
  DEEPSEEK_USAGE_TOTALS_TABLE,
  migrateDeepSeekUsageTotals,
} from '../migrations/0024-deepseek-usage-totals.mjs';
import {
  DEEPSEEK_BALANCE_REFERENCE_TABLE,
  DEEPSEEK_USAGE_DAYS_TABLE,
  migrateDeepSeekUsageRequestsDaily,
} from '../migrations/0025-deepseek-usage-requests-daily.mjs';
import { migrateDeepSeekUsageServedModels } from '../migrations/0026-deepseek-usage-served-models.mjs';
import { migrateDeepSeekUsageCheckpointRuns } from '../migrations/0027-deepseek-usage-checkpoint-runs.mjs';
import { migrateDeepSeekUsageCheckpointRequestRuns } from '../migrations/0028-deepseek-usage-checkpoint-request-runs.mjs';
import { migrateDeepSeekBalanceRises } from '../migrations/0029-deepseek-balance-rises.mjs';
import { deepseekServedModel } from '../../shared/deepseek-models.mjs';
import { estimateCost, estimateSearchCost } from '../../shared/deepseek-pricing.mjs';

// A DeepSeek report's token fields and their checkpoint columns.
const DEEPSEEK_TOKEN_FIELDS = Object.freeze([
  ['hitTokens', 'hit_tokens'],
  ['missTokens', 'miss_tokens'],
  ['outputTokens', 'output_tokens'],
]);
// Its request fields (web searches and fetches) and their checkpoint columns.
const DEEPSEEK_REQUEST_FIELDS = Object.freeze([
  ['searchRequests', 'search_requests'],
  ['fetchRequests', 'fetch_requests'],
]);

export const PROVIDER_USAGE_SNAPSHOT_TABLE = 'provider_usage_snapshots';
export const CURSOR_USAGE_CHECKPOINT_TABLE = 'cursor_usage_checkpoints';
export const CURSOR_USAGE_CYCLE_TABLE = 'cursor_usage_cycle_totals';
export const GROK_USAGE_CYCLE_TABLE = 'grok_usage_cycle_totals';

export const PLAN_USAGE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${PROVIDER_USAGE_SNAPSHOT_TABLE} (
    provider     TEXT PRIMARY KEY,
    payload_json TEXT,
    source       TEXT,
    captured_at  TEXT NOT NULL,
    error        TEXT
  );

  CREATE TABLE IF NOT EXISTS ${CURSOR_USAGE_CHECKPOINT_TABLE} (
    agent_id           TEXT PRIMARY KEY,
    raw_cost_cents     REAL,
    charged_cents      REAL,
    input_tokens       REAL,
    output_tokens      REAL,
    cache_read_tokens  REAL,
    cache_write_tokens REAL,
    total_tokens       REAL,
    run_count          REAL,
    updated_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ${CURSOR_USAGE_CYCLE_TABLE} (
    cycle_key          TEXT NOT NULL,
    pool               TEXT NOT NULL,
    raw_cost_cents     REAL NOT NULL DEFAULT 0,
    charged_cents      REAL NOT NULL DEFAULT 0,
    input_tokens       REAL NOT NULL DEFAULT 0,
    output_tokens      REAL NOT NULL DEFAULT 0,
    cache_read_tokens  REAL NOT NULL DEFAULT 0,
    cache_write_tokens REAL NOT NULL DEFAULT 0,
    total_tokens       REAL NOT NULL DEFAULT 0,
    run_count          REAL NOT NULL DEFAULT 0,
    updated_at         TEXT NOT NULL,
    PRIMARY KEY (cycle_key, pool)
  );

  CREATE TABLE IF NOT EXISTS ${GROK_USAGE_CYCLE_TABLE} (
    cycle_key      TEXT PRIMARY KEY,
    cost_usd       REAL NOT NULL DEFAULT 0,
    input_tokens   REAL NOT NULL DEFAULT 0,
    output_tokens  REAL NOT NULL DEFAULT 0,
    total_tokens   REAL NOT NULL DEFAULT 0,
    turn_count     REAL NOT NULL DEFAULT 0,
    updated_at     TEXT NOT NULL
  );
`;

const CHECKPOINT_COLUMNS = [
  ['rawCostCents', 'raw_cost_cents'],
  ['chargedCents', 'charged_cents'],
  ['inputTokens', 'input_tokens'],
  ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cache_read_tokens'],
  ['cacheWriteTokens', 'cache_write_tokens'],
  ['totalTokens', 'total_tokens'],
  ['runCount', 'run_count'],
];

export function ensurePlanUsageSchema(db) {
  if (typeof db?.exec !== 'function') return false;
  db.exec(PLAN_USAGE_SCHEMA_SQL);
  // The boot runs the same migration (db-schema.mjs); a database the service
  // is handed on its own (tests, tools) gets the table here.
  migrateDeepSeekUsageTotals(db);
  migrateDeepSeekUsageRequestsDaily(db);
  migrateDeepSeekUsageServedModels(db);
  migrateDeepSeekUsageCheckpointRuns(db);
  migrateDeepSeekUsageCheckpointRequestRuns(db);
  migrateDeepSeekBalanceRises(db);
  return true;
}

/**
 * The model a DeepSeek report's entry is booked under: the DeepSeek model
 * that served it. An older worker names a sub-agent's model as Claude Code
 * requested it (`claude-opus-5-5`, which DeepSeek serves with V4 Pro); the
 * table and the prices know DeepSeek's ids only. A name DeepSeek is not known
 * to serve is booked as it is, without a price.
 */
function deepseekBookedModel(value) {
  const model = toTrimmedString(value);
  return deepseekServedModel(model) || model;
}

function rowToCheckpoint(row) {
  if (!row) return null;
  const checkpoint = { agentId: row.agent_id, capturedAt: row.updated_at };
  for (const [field, column] of CHECKPOINT_COLUMNS) {
    const value = Number(row[column]);
    checkpoint[field] = Number.isFinite(value) ? value : null;
  }
  return checkpoint;
}

function rowsToPoolTotals(rows) {
  const totals = emptyCursorPoolTotals();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const pool = toTrimmedString(row?.pool);
    if (!pool || !totals[pool]) continue;
    for (const [field, column] of CHECKPOINT_COLUMNS) {
      const value = Number(row[column]);
      totals[pool][field] = Number.isFinite(value) ? value : 0;
    }
  }
  return totals;
}

/**
 * @param {object} deps
 * @param {object} deps.db          better-sqlite3 handle
 * @param {() => Date} [deps.now]   injectable clock for deterministic tests
 */
export function createPlanUsageService({ db, now = () => new Date(), dbg = () => {} } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createPlanUsageService requires a database handle');
  }
  ensurePlanUsageSchema(db);

  const stmts = {
    upsertSnapshot: db.prepare(`
      INSERT INTO ${PROVIDER_USAGE_SNAPSHOT_TABLE} (provider, payload_json, source, captured_at, error)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        payload_json = excluded.payload_json,
        source = excluded.source,
        captured_at = excluded.captured_at,
        error = excluded.error
    `),
    getSnapshot: db.prepare(`SELECT * FROM ${PROVIDER_USAGE_SNAPSHOT_TABLE} WHERE provider = ?`),
    getCheckpoint: db.prepare(`SELECT * FROM ${CURSOR_USAGE_CHECKPOINT_TABLE} WHERE agent_id = ?`),
    upsertCheckpoint: db.prepare(`
      INSERT INTO ${CURSOR_USAGE_CHECKPOINT_TABLE} (
        agent_id, raw_cost_cents, charged_cents, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, run_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        raw_cost_cents = excluded.raw_cost_cents,
        charged_cents = excluded.charged_cents,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        total_tokens = excluded.total_tokens,
        run_count = excluded.run_count,
        updated_at = excluded.updated_at
    `),
    listCycleTotals: db.prepare(`SELECT * FROM ${CURSOR_USAGE_CYCLE_TABLE} WHERE cycle_key = ?`),
    addCycleTotals: db.prepare(`
      INSERT INTO ${CURSOR_USAGE_CYCLE_TABLE} (
        cycle_key, pool, raw_cost_cents, charged_cents, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, run_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cycle_key, pool) DO UPDATE SET
        raw_cost_cents = ${CURSOR_USAGE_CYCLE_TABLE}.raw_cost_cents + excluded.raw_cost_cents,
        charged_cents = ${CURSOR_USAGE_CYCLE_TABLE}.charged_cents + excluded.charged_cents,
        input_tokens = ${CURSOR_USAGE_CYCLE_TABLE}.input_tokens + excluded.input_tokens,
        output_tokens = ${CURSOR_USAGE_CYCLE_TABLE}.output_tokens + excluded.output_tokens,
        cache_read_tokens = ${CURSOR_USAGE_CYCLE_TABLE}.cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = ${CURSOR_USAGE_CYCLE_TABLE}.cache_write_tokens + excluded.cache_write_tokens,
        total_tokens = ${CURSOR_USAGE_CYCLE_TABLE}.total_tokens + excluded.total_tokens,
        run_count = ${CURSOR_USAGE_CYCLE_TABLE}.run_count + excluded.run_count,
        updated_at = excluded.updated_at
    `),
    clearCheckpoints: db.prepare(`DELETE FROM ${CURSOR_USAGE_CHECKPOINT_TABLE}`),
    clearCycle: db.prepare(`DELETE FROM ${CURSOR_USAGE_CYCLE_TABLE} WHERE cycle_key = ?`),
    getGrokCycle: db.prepare(`SELECT * FROM ${GROK_USAGE_CYCLE_TABLE} WHERE cycle_key = ?`),
    addGrokCycle: db.prepare(`
      INSERT INTO ${GROK_USAGE_CYCLE_TABLE} (
        cycle_key, cost_usd, input_tokens, output_tokens, total_tokens, turn_count, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cycle_key) DO UPDATE SET
        cost_usd = ${GROK_USAGE_CYCLE_TABLE}.cost_usd + excluded.cost_usd,
        input_tokens = ${GROK_USAGE_CYCLE_TABLE}.input_tokens + excluded.input_tokens,
        output_tokens = ${GROK_USAGE_CYCLE_TABLE}.output_tokens + excluded.output_tokens,
        total_tokens = ${GROK_USAGE_CYCLE_TABLE}.total_tokens + excluded.total_tokens,
        turn_count = ${GROK_USAGE_CYCLE_TABLE}.turn_count + excluded.turn_count,
        updated_at = excluded.updated_at
    `),
    clearGrokCycle: db.prepare(`DELETE FROM ${GROK_USAGE_CYCLE_TABLE} WHERE cycle_key = ?`),
    // A cost of NULL is "no estimate": it stays NULL until a turn of the
    // model can be priced, and never turns a known sum into NULL. The tools
    // cost (searches and fetches) is always known.
    addDeepSeekTotals: db.prepare(`
      INSERT INTO ${DEEPSEEK_USAGE_TOTALS_TABLE} (
        model, hit_tokens, miss_tokens, output_tokens, search_requests, fetch_requests, turn_count,
        cost_usd, cost_cny, tools_cost_usd, tools_cost_cny, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        hit_tokens = ${DEEPSEEK_USAGE_TOTALS_TABLE}.hit_tokens + excluded.hit_tokens,
        miss_tokens = ${DEEPSEEK_USAGE_TOTALS_TABLE}.miss_tokens + excluded.miss_tokens,
        output_tokens = ${DEEPSEEK_USAGE_TOTALS_TABLE}.output_tokens + excluded.output_tokens,
        search_requests = ${DEEPSEEK_USAGE_TOTALS_TABLE}.search_requests + excluded.search_requests,
        fetch_requests = ${DEEPSEEK_USAGE_TOTALS_TABLE}.fetch_requests + excluded.fetch_requests,
        turn_count = ${DEEPSEEK_USAGE_TOTALS_TABLE}.turn_count + 1,
        cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN ${DEEPSEEK_USAGE_TOTALS_TABLE}.cost_usd
          ELSE COALESCE(${DEEPSEEK_USAGE_TOTALS_TABLE}.cost_usd, 0) + excluded.cost_usd END,
        cost_cny = CASE WHEN excluded.cost_cny IS NULL THEN ${DEEPSEEK_USAGE_TOTALS_TABLE}.cost_cny
          ELSE COALESCE(${DEEPSEEK_USAGE_TOTALS_TABLE}.cost_cny, 0) + excluded.cost_cny END,
        tools_cost_usd = ${DEEPSEEK_USAGE_TOTALS_TABLE}.tools_cost_usd + excluded.tools_cost_usd,
        tools_cost_cny = ${DEEPSEEK_USAGE_TOTALS_TABLE}.tools_cost_cny + excluded.tools_cost_cny,
        first_seen_at = MIN(${DEEPSEEK_USAGE_TOTALS_TABLE}.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(${DEEPSEEK_USAGE_TOTALS_TABLE}.last_seen_at, excluded.last_seen_at),
        updated_at = excluded.updated_at
    `),
    // The same sums per UTC day, for the daily chart and the month's spend.
    addDeepSeekDay: db.prepare(`
      INSERT INTO ${DEEPSEEK_USAGE_DAYS_TABLE} (
        day, model, hit_tokens, miss_tokens, output_tokens, search_requests, fetch_requests, turn_count,
        cost_usd, cost_cny, tools_cost_usd, tools_cost_cny, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(day, model) DO UPDATE SET
        hit_tokens = ${DEEPSEEK_USAGE_DAYS_TABLE}.hit_tokens + excluded.hit_tokens,
        miss_tokens = ${DEEPSEEK_USAGE_DAYS_TABLE}.miss_tokens + excluded.miss_tokens,
        output_tokens = ${DEEPSEEK_USAGE_DAYS_TABLE}.output_tokens + excluded.output_tokens,
        search_requests = ${DEEPSEEK_USAGE_DAYS_TABLE}.search_requests + excluded.search_requests,
        fetch_requests = ${DEEPSEEK_USAGE_DAYS_TABLE}.fetch_requests + excluded.fetch_requests,
        turn_count = ${DEEPSEEK_USAGE_DAYS_TABLE}.turn_count + 1,
        cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN ${DEEPSEEK_USAGE_DAYS_TABLE}.cost_usd
          ELSE COALESCE(${DEEPSEEK_USAGE_DAYS_TABLE}.cost_usd, 0) + excluded.cost_usd END,
        cost_cny = CASE WHEN excluded.cost_cny IS NULL THEN ${DEEPSEEK_USAGE_DAYS_TABLE}.cost_cny
          ELSE COALESCE(${DEEPSEEK_USAGE_DAYS_TABLE}.cost_cny, 0) + excluded.cost_cny END,
        tools_cost_usd = ${DEEPSEEK_USAGE_DAYS_TABLE}.tools_cost_usd + excluded.tools_cost_usd,
        tools_cost_cny = ${DEEPSEEK_USAGE_DAYS_TABLE}.tools_cost_cny + excluded.tools_cost_cny,
        updated_at = excluded.updated_at
    `),
    listDeepSeekTotals: db.prepare(`SELECT * FROM ${DEEPSEEK_USAGE_TOTALS_TABLE} ORDER BY last_seen_at DESC, model`),
    listDeepSeekDays: db.prepare(`SELECT * FROM ${DEEPSEEK_USAGE_DAYS_TABLE} WHERE day >= ? ORDER BY day, model`),
    firstDeepSeekDay: db.prepare(`SELECT MIN(day) AS day FROM ${DEEPSEEK_USAGE_DAYS_TABLE}`),
    listDeepSeekBalanceReferences: db.prepare(`SELECT * FROM ${DEEPSEEK_BALANCE_REFERENCE_TABLE} ORDER BY currency`),
    getDeepSeekBalanceReference: db.prepare(`SELECT * FROM ${DEEPSEEK_BALANCE_REFERENCE_TABLE} WHERE currency = ?`),
    upsertDeepSeekBalanceReference: db.prepare(`
      INSERT INTO ${DEEPSEEK_BALANCE_REFERENCE_TABLE} (currency, reference_total, last_total, reference_at, updated_at, rose_at, last_read_at, rose_from_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(currency) DO UPDATE SET
        reference_total = excluded.reference_total,
        last_total = excluded.last_total,
        reference_at = excluded.reference_at,
        updated_at = excluded.updated_at,
        rose_at = excluded.rose_at,
        last_read_at = excluded.last_read_at,
        rose_from_at = excluded.rose_from_at
    `),
    getDeepSeekCheckpoint: db.prepare(`
      SELECT * FROM ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE}
      WHERE conversation_id = ? AND native_session_id = ? AND model = ?
    `),
    upsertDeepSeekCheckpoint: db.prepare(`
      INSERT INTO ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} (
        conversation_id, native_session_id, model, run_id, request_run_id,
        hit_tokens, miss_tokens, output_tokens, search_requests, fetch_requests, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, native_session_id, model) DO UPDATE SET
        run_id = excluded.run_id,
        request_run_id = excluded.request_run_id,
        hit_tokens = excluded.hit_tokens,
        miss_tokens = excluded.miss_tokens,
        output_tokens = excluded.output_tokens,
        search_requests = excluded.search_requests,
        fetch_requests = excluded.fetch_requests,
        updated_at = excluded.updated_at
    `),
  };

  function nowIso() {
    const value = now();
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString()
      : new Date().toISOString();
  }

  function saveSnapshot(provider, payload, { source = 'worker', error = null, capturedAt = null } = {}) {
    const key = toTrimmedString(provider);
    if (!key) return false;
    stmts.upsertSnapshot.run(
      key,
      payload ? JSON.stringify(payload) : null,
      toTrimmedString(source),
      toTrimmedString(capturedAt) || nowIso(),
      toTrimmedString(error),
    );
    return true;
  }

  function readSnapshot(provider) {
    const row = stmts.getSnapshot.get(toTrimmedString(provider) || '');
    if (!row) return null;
    let payload = null;
    if (row.payload_json) {
      try {
        payload = JSON.parse(row.payload_json);
      } catch (parseError) {
        dbg('plan usage snapshot parse failed', provider, parseError?.message || String(parseError));
        payload = null;
      }
    }
    return {
      provider: row.provider,
      payload,
      source: row.source || null,
      capturedAt: row.captured_at || null,
      error: row.error || null,
    };
  }

  /**
   * Fold one cumulative Cursor agent report into the current cycle. Returns the
   * applied delta so callers can log/trace it; a report that adds nothing (a
   * repeated snapshot, or a backend restatement) still refreshes the checkpoint.
   */
  function recordCursorUsageReport(report, { resetDay } = {}) {
    const previousRow = stmts.getCheckpoint.get(toTrimmedString(report?.agentId) || '');
    const applied = applyCursorUsageDelta({ checkpoint: rowToCheckpoint(previousRow), report });
    if (!applied) return null;

    const cycle = resolveCursorBillingCycle({ resetDay, now: now() });
    const timestamp = applied.capturedAt || nowIso();

    const persist = db.transaction(() => {
      stmts.upsertCheckpoint.run(
        applied.agentId,
        applied.checkpoint.rawCostCents,
        applied.checkpoint.chargedCents,
        applied.checkpoint.inputTokens,
        applied.checkpoint.outputTokens,
        applied.checkpoint.cacheReadTokens,
        applied.checkpoint.cacheWriteTokens,
        applied.checkpoint.totalTokens,
        applied.checkpoint.runCount,
        timestamp,
      );
      if (applied.changed) {
        stmts.addCycleTotals.run(
          cycle.key,
          applied.pool,
          applied.delta.rawCostCents,
          applied.delta.chargedCents,
          applied.delta.inputTokens,
          applied.delta.outputTokens,
          applied.delta.cacheReadTokens,
          applied.delta.cacheWriteTokens,
          applied.delta.totalTokens,
          applied.delta.runCount,
          timestamp,
        );
      }
    });
    persist();

    return { ...applied, cycle };
  }

  function readCursorCycleTotals({ resetDay } = {}) {
    const cycle = resolveCursorBillingCycle({ resetDay, now: now() });
    const rows = stmts.listCycleTotals.all(cycle.key);
    const totals = rowsToPoolTotals(rows);
    const capturedAt = (rows || [])
      .map((row) => toTrimmedString(row?.updated_at))
      .filter(Boolean)
      .sort()
      .pop() || null;
    return { cycle, totals, capturedAt };
  }

  /**
   * Drop the derived Cursor bookkeeping. Used when the user changes plan or
   * account and the accumulated cycle no longer reflects reality — the next
   * report re-baselines from the agent's current cumulative totals, so no
   * historical spend is retroactively counted.
   */
  function resetCursorAccounting({ resetDay } = {}) {
    const cycle = resolveCursorBillingCycle({ resetDay, now: now() });
    const reset = db.transaction(() => {
      stmts.clearCheckpoints.run();
      stmts.clearCycle.run(cycle.key);
    });
    reset();
    return { cycle };
  }

  /**
   * Book one completed Grok turn into the current billing cycle and refresh the
   * last-turn snapshot. Grok reports per-prompt totals (not cumulative agent
   * counters), so each report is added whole — no checkpoint/diff.
   */
  function recordGrokUsageReport(rawReport, { resetDay } = {}) {
    const usage = normalizeGrokTurnUsage(rawReport);
    if (!usage) return null;
    const cycle = resolveGrokBillingCycle({ resetDay, now: now() });
    // Server clock for the ledger/snapshot timestamp: the cycle is chosen by
    // server time too, and a client-supplied capturedAt would otherwise drive
    // the card's "Updated …" freshness label. The worker's capturedAt stays
    // inside the snapshot payload itself.
    const timestamp = nowIso();
    const persist = db.transaction(() => {
      stmts.addGrokCycle.run(
        cycle.key,
        usage.costUsd || 0,
        usage.inputTokens || 0,
        usage.outputTokens || 0,
        usage.totalTokens || 0,
        1,
        timestamp,
      );
      stmts.upsertSnapshot.run(
        'grok',
        JSON.stringify(usage),
        'worker',
        timestamp,
        null,
      );
    });
    persist();
    return { usage, cycle };
  }

  function readGrokCycleTotals({ resetDay } = {}) {
    const cycle = resolveGrokBillingCycle({ resetDay, now: now() });
    const row = stmts.getGrokCycle.get(cycle.key);
    if (!row) {
      return {
        cycle,
        totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, turnCount: 0 },
        capturedAt: null,
      };
    }
    return {
      cycle,
      totals: {
        costUsd: Number(row.cost_usd) || 0,
        inputTokens: Number(row.input_tokens) || 0,
        outputTokens: Number(row.output_tokens) || 0,
        totalTokens: Number(row.total_tokens) || 0,
        turnCount: Number(row.turn_count) || 0,
      },
      capturedAt: row.updated_at || null,
    };
  }

  function resetGrokAccounting({ resetDay } = {}) {
    const cycle = resolveGrokBillingCycle({ resetDay, now: now() });
    stmts.clearGrokCycle.run(cycle.key);
    return { cycle };
  }

  /**
   * Book one DeepSeek report (normalizeDeepSeekUsageReport): a worker's
   * running token totals per model for one CLI session, with its estimate
   * at the price of the report's time in both currencies. The checkpoint
   * per (conversation, session, model) holds the totals last booked and the
   * `runId` they came from, the id the worker gives each CLI process.
   *
   * With a run id the totals are that process's own, counted from zero when
   * it started (the worker takes the CLI's session totals apart, so what a
   * resumed CLI restored from its transcript is never in them). Under the
   * run the checkpoint came from only the increase is booked, field by
   * field, and a total below the checkpoint is a stale report (a post
   * retried or delivered out of order): it books nothing and leaves the
   * checkpoint at its high-water mark. Under another run the report is a
   * new process, booked in full, from which the checkpoint starts over; a
   * late report of the earlier process after that is booked in full too,
   * since the relay cannot tell it from a process counting from zero.
   *
   * Without a run id (an older worker) the totals are the CLI's own, which
   * a resumed CLI continues from its session's earlier ones: what they add
   * is booked, and a drop is a CLI counting from zero again, booked in full.
   *
   * Web searches and fetches: a report with a run id carries the process's
   * running counts per model, booked like the tokens under a run id of their
   * own (`request_run_id`: an entry with counts only, as a sub-agent's model
   * that searched without tokens of its own, leaves the token run alone).
   * Without a run id they are the turn's counts, booked as they come.
   * Returns what was booked: models with nothing new are left out.
   */
  function recordDeepSeekUsageReport(report) {
    const at = toTrimmedString(report?.at);
    const conversationId = toTrimmedString(report?.conversationId);
    const nativeSessionId = toTrimmedString(report?.nativeSessionId);
    const runId = toTrimmedString(report?.runId) || '';
    const totals = Array.isArray(report?.totals) ? report.totals : [];
    const requests = Array.isArray(report?.requests) ? report.requests : [];
    if (!at || !conversationId || !nativeSessionId || (!totals.length && !requests.length)) return null;
    const timestamp = nowIso();
    const day = at.slice(0, 10);
    // Entries that name one DeepSeek model in two ways (its own id and a
    // Claude id it served) are summed, like the worker sums the CLI's names.
    const totalsByModel = new Map();
    for (const entry of totals) {
      const model = deepseekBookedModel(entry?.model);
      if (!model) continue;
      const current = totalsByModel.get(model) || { hitTokens: 0, missTokens: 0, outputTokens: 0 };
      for (const [field] of DEEPSEEK_TOKEN_FIELDS) current[field] += Math.max(0, Number(entry?.[field]) || 0);
      totalsByModel.set(model, current);
    }
    const requestsByModel = new Map();
    for (const entry of requests) {
      const model = deepseekBookedModel(entry?.model);
      if (!model) continue;
      const current = requestsByModel.get(model) || { searchRequests: 0, fetchRequests: 0 };
      current.searchRequests += Math.max(0, Number(entry.searchRequests) || 0);
      current.fetchRequests += Math.max(0, Number(entry.fetchRequests) || 0);
      requestsByModel.set(model, current);
    }
    const models = [...new Set([...totalsByModel.keys(), ...requestsByModel.keys()])];
    const booked = [];
    const persist = db.transaction(() => {
      for (const model of models) {
        const entry = totalsByModel.get(model);
        const modelRequests = requestsByModel.get(model);
        const delta = { model, hitTokens: 0, missTokens: 0, outputTokens: 0, searchRequests: 0, fetchRequests: 0 };
        const previous = stmts.getDeepSeekCheckpoint.get(conversationId, nativeSessionId, model) || null;
        // The checkpoint's totals (counts) came from this very process: they
        // can only have grown since.
        const sameRun = Boolean(runId) && Boolean(previous) && String(previous.run_id || '') === runId;
        const sameRequestRun = Boolean(runId) && Boolean(previous) && String(previous.request_run_id || '') === runId;
        // What the checkpoint will hold: the report's totals, or the
        // high-water mark when the report is stale.
        const checkpoint = { runId: String(previous?.run_id || ''), requestRunId: String(previous?.request_run_id || '') };
        for (const [field, column] of DEEPSEEK_TOKEN_FIELDS) checkpoint[field] = Number(previous?.[column]) || 0;
        for (const [field, column] of DEEPSEEK_REQUEST_FIELDS) checkpoint[field] = Number(previous?.[column]) || 0;
        if (entry) {
          const reported = {};
          for (const [field] of DEEPSEEK_TOKEN_FIELDS) reported[field] = Number(entry[field]) || 0;
          const drop = DEEPSEEK_TOKEN_FIELDS.some(([field]) => reported[field] < checkpoint[field]);
          if (drop && sameRun) {
            // Stale: a retried post, or one that arrived after a later one.
          } else {
            // A process's own totals under a new run are all new spend; an
            // older worker's session totals add their increase, or are a CLI
            // counting from zero again when they dropped.
            const full = runId ? !sameRun : drop;
            for (const [field] of DEEPSEEK_TOKEN_FIELDS) {
              delta[field] = full ? reported[field] : reported[field] - checkpoint[field];
              checkpoint[field] = reported[field];
            }
            checkpoint.runId = runId;
          }
        }
        if (modelRequests && runId) {
          // Running counts for this process: in full under a new run (the
          // checkpoint's counts are another process's), the increase under
          // the same one, nothing when they are at or below the checkpoint.
          const drop = DEEPSEEK_REQUEST_FIELDS.some(([field]) => modelRequests[field] < checkpoint[field]);
          if (!(drop && sameRequestRun)) {
            for (const [field] of DEEPSEEK_REQUEST_FIELDS) {
              delta[field] = sameRequestRun ? modelRequests[field] - checkpoint[field] : modelRequests[field];
              checkpoint[field] = modelRequests[field];
            }
            checkpoint.requestRunId = runId;
          }
        } else if (modelRequests) {
          // An older worker: the turn's counts, booked as they come.
          delta.searchRequests = modelRequests.searchRequests;
          delta.fetchRequests = modelRequests.fetchRequests;
        }
        if (entry || (modelRequests && runId)) {
          stmts.upsertDeepSeekCheckpoint.run(
            conversationId,
            nativeSessionId,
            model,
            checkpoint.runId,
            checkpoint.requestRunId,
            checkpoint.hitTokens,
            checkpoint.missTokens,
            checkpoint.outputTokens,
            checkpoint.searchRequests,
            checkpoint.fetchRequests,
            timestamp,
          );
        }
        const tokenCount = delta.hitTokens + delta.missTokens + delta.outputTokens;
        if (tokenCount <= 0 && delta.searchRequests + delta.fetchRequests <= 0) continue;
        const tokens = { hitTokens: delta.hitTokens, missTokens: delta.missTokens, outputTokens: delta.outputTokens };
        // No tokens booked (a request-only report) is no token estimate.
        delta.costUsd = tokenCount > 0 ? estimateCost({ model, at, currency: 'USD', ...tokens }) : null;
        delta.costCny = tokenCount > 0 ? estimateCost({ model, at, currency: 'CNY', ...tokens }) : null;
        const requested = { at, searchRequests: delta.searchRequests, fetchRequests: delta.fetchRequests };
        delta.toolsCostUsd = estimateSearchCost({ ...requested, currency: 'USD' }) || 0;
        delta.toolsCostCny = estimateSearchCost({ ...requested, currency: 'CNY' }) || 0;
        const values = [
          delta.hitTokens,
          delta.missTokens,
          delta.outputTokens,
          delta.searchRequests,
          delta.fetchRequests,
          delta.costUsd,
          delta.costCny,
          delta.toolsCostUsd,
          delta.toolsCostCny,
        ];
        stmts.addDeepSeekTotals.run(model, ...values, at, at, timestamp);
        stmts.addDeepSeekDay.run(day, model, ...values, timestamp);
        booked.push(delta);
      }
    });
    persist();
    return { at, models: booked };
  }

  // Ten decimals, as each estimate is kept: the sum's binary-float tail goes.
  const tenDecimals = (value) => Math.round(Number(value) * 1e10) / 1e10;
  const nullableMoney = (value) => (value === null || value === undefined ? null : tenDecimals(value));

  function deepseekSumsOf(row) {
    return {
      model: row.model,
      hitTokens: Number(row.hit_tokens) || 0,
      missTokens: Number(row.miss_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      searchRequests: Number(row.search_requests) || 0,
      fetchRequests: Number(row.fetch_requests) || 0,
      turnCount: Number(row.turn_count) || 0,
      costUsd: nullableMoney(row.cost_usd),
      costCny: nullableMoney(row.cost_cny),
      toolsCostUsd: tenDecimals(row.tools_cost_usd || 0),
      toolsCostCny: tenDecimals(row.tools_cost_cny || 0),
    };
  }

  function readDeepSeekUsageTotals() {
    const models = stmts.listDeepSeekTotals.all().map((row) => ({
      ...deepseekSumsOf(row),
      firstSeenAt: row.first_seen_at || null,
      lastSeenAt: row.last_seen_at || null,
    }));
    return { models };
  }

  /**
   * The daily sums per model from `since` (a `YYYY-MM-DD` UTC day) on:
   * `{ days: [{ day, model, ...sums }] }`, oldest first.
   */
  function readDeepSeekUsageDays({ since } = {}) {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(since ?? '')) ? String(since) : '0000-00-00';
    const days = stmts.listDeepSeekDays.all(from).map((row) => ({ day: row.day, ...deepseekSumsOf(row) }));
    // The first day the daily table holds: the history starts with the
    // relay that brought it, not with the first DeepSeek turn.
    const first = stmts.firstDeepSeekDay.get()?.day || null;
    return { days, firstDay: first };
  }

  function deepseekBalanceReferenceOf(row) {
    return {
      currency: String(row.currency),
      referenceTotal: Number(row.reference_total) || 0,
      lastTotal: Number(row.last_total) || 0,
      referenceAt: row.reference_at || null,
      // When the balance last rose after the first read, and when the
      // balance before that rise was read (migration 0029).
      roseAt: row.rose_at || null,
      roseFromAt: row.rose_from_at || null,
    };
  }

  /** The balance references per currency (`recordDeepSeekBalance`). */
  function readDeepSeekBalanceReferences() {
    return stmts.listDeepSeekBalanceReferences.all().map(deepseekBalanceReferenceOf);
  }

  /**
   * Notes a balance read (deepseek-balance-service.mjs's `{ ok: true,
   * balances: [{ currency, total }] }`) for the balance meter, which shows
   * what is left of the balance since the last top-up. Per currency the
   * reference is the balance right after its latest rise (a top-up or a
   * grant); before any rise was seen it is the highest balance seen, so the
   * meter is full on the first read and fills with the spend. A failed read,
   * or one repeated from the cache, changes nothing. Returns the references.
   */
  function recordDeepSeekBalance(balance) {
    if (balance?.ok !== true || !Array.isArray(balance.balances)) return readDeepSeekBalanceReferences();
    const readAt = toIsoTimestamp(balance.fetchedAt) || nowIso();
    const timestamp = nowIso();
    db.transaction(() => {
      for (const entry of balance.balances) {
        const currency = toTrimmedString(entry?.currency)?.toUpperCase();
        const total = toFiniteNumber(entry?.total);
        if (!currency || total === null || total < 0) continue;
        const row = stmts.getDeepSeekBalanceReference.get(currency);
        const rose = row ? total > Number(row.last_total) : false;
        const reference = row && !rose ? Math.max(Number(row.reference_total) || 0, total) : total;
        const referenceAt = !row || rose || reference !== Number(row.reference_total) ? readAt : (row.reference_at || readAt);
        const roseAt = rose ? readAt : (row?.rose_at || null);
        // The read before the rise: a row from before last_read_at was
        // recorded at about the time it was read.
        const roseFromAt = rose ? (row.last_read_at || row.updated_at || null) : (row?.rose_from_at || null);
        stmts.upsertDeepSeekBalanceReference.run(currency, reference, total, referenceAt, timestamp, roseAt, readAt, roseFromAt);
      }
    })();
    return readDeepSeekBalanceReferences();
  }

  // Claude Cloud conversations keep their reported cost on the runtime
  // session row (migration 0007). That table is the relay's, not this
  // service's, so the statements are prepared on first use, and only once
  // the table and the column are there (an older database has neither).
  let claudeCloudSpendStmts = null;
  function claudeCloudSpendStatements() {
    if (claudeCloudSpendStmts) return claudeCloudSpendStmts;
    const columns = new Set(db.prepare(`PRAGMA table_info(runtime_sessions)`).all().map((column) => String(column.name)));
    if (!columns.has('claude_cloud_cost_usd') || !columns.has('provider_type')) return null;
    claudeCloudSpendStmts = {
      totals: db.prepare(`
        SELECT COUNT(*) AS conversation_count, COALESCE(SUM(claude_cloud_cost_usd), 0) AS total_usd
        FROM runtime_sessions
        WHERE LOWER(TRIM(provider_type)) = '${CLAUDE_CLOUD_PROVIDER_ID}'
      `),
      byConversation: db.prepare(`
        SELECT claude_cloud_cost_usd AS cost_usd
        FROM runtime_sessions
        WHERE conversation_id = ? AND LOWER(TRIM(provider_type)) = '${CLAUDE_CLOUD_PROVIDER_ID}'
      `),
    };
    return claudeCloudSpendStmts;
  }

  /**
   * What the relay's cloud conversations have cost: the sum of the latest
   * cost each one reported and how many there are, plus the cost of
   * `conversationId` when that is a cloud conversation (`conversation` is
   * null for any other). Only conversations that still exist count: a deleted
   * one takes its row with it. There are no dates on these figures, so no
   * per-day or per-week sum is offered. Null when the storage is not there.
   */
  function readClaudeCloudSpend({ conversationId = '' } = {}) {
    try {
      const statements = claudeCloudSpendStatements();
      if (!statements) return null;
      const totals = statements.totals.get();
      const id = toTrimmedString(conversationId);
      const row = id ? statements.byConversation.get(id) : null;
      const cost = row ? Number(row.cost_usd) : null;
      return {
        totalUsd: Number(totals?.total_usd) || 0,
        conversationCount: Number(totals?.conversation_count) || 0,
        conversation: row
          ? { costUsd: row.cost_usd !== null && Number.isFinite(cost) ? cost : null }
          : null,
      };
    } catch (error) {
      dbg('claude cloud spend read failed', error?.message || String(error));
      return null;
    }
  }

  /**
   * Assemble the full multi-provider report. Every provider is independent:
   * one failing source produces an unavailable card instead of failing the
   * whole response.
   */
  function buildReport({
    copilotSummary = null,
    copilotError = null,
    copilotStale = false,
    // When the quota answer is an earlier one served again (the modal asked
    // for another provider live), the time it was really read.
    copilotCapturedAt = null,
    copilotBilling = null,
    claudeConfigured = true,
    // Live account usage (claude-account-usage-service.mjs), or null: it is
    // only ever read while Claude Cloud is switched on.
    claudeAccount = null,
    claudeCloudConfigured = false,
    // The conversation the modal was opened from, for its own cloud cost.
    conversationId = '',
    cursorConfigured = true,
    cursorAllowances = null,
    cursorBilling = null,
    cursorDashboardAuth = null,
    grokConfigured = false,
    grokAllowances = null,
    grokBilling = null,
    deepseekConfigured = false,
    // The balance service's answer (deepseek-balance-service.mjs), or null.
    deepseekBalance = null,
    // The DeepSeek tab's monthly budget and its currency ('USD' or 'CNY'; null
    // for a budget saved without one, read in the balance's currency), or null.
    deepseekMonthlyBudget = null,
    deepseekMonthlyBudgetCurrency = null,
    deepseekStartingBalance = null,
    // The imported DeepSeek export's figures of the saved key
    // (deepseek-usage-import.mjs readActuals()), or null: read only, laid
    // over the estimate by the card.
    deepseekActuals = null,
    // The Claude API card, built by its own module (plan-usage-claude-api.mjs)
    // from the Claude API booking; null while Claude API has no key and is off.
    claudeApiCard = null,
  } = {}) {
    const generatedAt = nowIso();
    const claudeSnapshot = readSnapshot('claude');
    // What the cloud workers post to /api/claude-plan-usage is kept under its
    // own key, so the Claude card stays what the Claude workers wrote.
    const claudeCloudSnapshot = claudeCloudConfigured === true ? readSnapshot(CLAUDE_CLOUD_PROVIDER_ID) : null;
    const allowances = normalizeCursorAllowanceSettings(cursorAllowances || {});
    const cursorCycle = readCursorCycleTotals({ resetDay: allowances.resetDay });
    const grokSettings = normalizeGrokAllowanceSettings(grokAllowances || {});
    const grokCycle = readGrokCycleTotals({ resetDay: grokSettings.resetDay });
    const grokSnapshot = readSnapshot('grok');
    // The SDK engine's per-turn detail. Stored under its own key rather than
    // 'github' so it stays clearly additive: the Copilot card's meters come
    // from the account-level quota API and are correct for both engines, and
    // an install still on the extension engine simply has no row here.
    const copilotWorkerSnapshot = readSnapshot('copilot-sdk');

    const providers = [
      buildCopilotPlanCard({
        summary: copilotSummary,
        billing: copilotBilling,
        workerUsage: copilotWorkerSnapshot?.payload || null,
        error: copilotError,
        capturedAt: copilotCapturedAt || generatedAt,
        stale: copilotStale === true,
      }),
      buildClaudePlanCard({
        usage: claudeSnapshot?.payload || null,
        capturedAt: claudeSnapshot?.capturedAt || null,
        configured: claudeConfigured !== false,
        message: claudeSnapshot?.error || null,
        // A stored snapshot is by definition from an earlier turn; the SDK's
        // usage control call only works while a session transport is open, and
        // the relay never opens a billable turn just to refresh this. Live
        // account usage, where there is any, takes the meters over.
        stale: !!claudeSnapshot?.payload,
        account: claudeAccount,
      }),
      // Opt-in like Grok (no card while the provider is off), and placed next
      // to the Claude card because both are the same account.
      claudeCloudConfigured === true
        ? buildClaudeCloudPlanCard({
          account: claudeAccount,
          spend: readClaudeCloudSpend({ conversationId }),
          usage: claudeCloudSnapshot?.payload || null,
          capturedAt: claudeCloudSnapshot?.capturedAt || null,
          configured: true,
        })
        : null,
      // Opt-in too, and next to the Claude cards: the same models on a key.
      claudeApiCard || null,
      buildCursorPlanCard({
        totals: cursorCycle.totals,
        allowances,
        cycle: cursorCycle.cycle,
        capturedAt: cursorCycle.capturedAt,
        configured: cursorConfigured !== false,
        dashboard: cursorBilling,
        dashboardAuth: cursorDashboardAuth,
      }),
    ];

    // Grok is opt-in: hide the card entirely when the provider is disabled
    // (unlike Claude/Cursor which show a not-configured placeholder).
    if (grokConfigured === true) {
      providers.push(buildGrokPlanCard({
        usage: grokSnapshot?.payload || null,
        cycleTotals: grokCycle.totals,
        allowances: grokSettings,
        cycle: grokCycle.cycle,
        billing: grokBilling,
        capturedAt: grokSnapshot?.capturedAt || grokCycle.capturedAt || null,
        configured: true,
        message: grokSnapshot?.error || null,
        // Same semantics as the Claude card: a stored snapshot is by
        // definition from an earlier turn (the relay never opens a billable
        // turn just to refresh it), so the two identical data shapes carry
        // the same staleness flag.
        stale: !!grokSnapshot?.payload,
      }));
    }

    // Opt-in like Grok: no card while DeepSeek is off.
    if (deepseekConfigured === true) {
      // The daily chart's 30 days and this calendar month, whichever reaches
      // further back (UTC days, like the booking).
      const today = generatedAt.slice(0, 10);
      const monthStart = `${today.slice(0, 7)}-01`;
      const thirtyDaysAgo = new Date(Date.parse(`${today}T00:00:00.000Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      // The daily rows reach back to the export's first day too, so the card
      // can take the estimate of every day the export covers out of the totals.
      const firstActualDay = [
        ...(Array.isArray(deepseekActuals?.rows) ? deepseekActuals.rows : []),
        ...(Array.isArray(deepseekActuals?.coveredDays) ? deepseekActuals.coveredDays : []),
      ].map((row) => String(row?.day || '')).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()[0] || null;
      const since = [thirtyDaysAgo, monthStart, firstActualDay].filter(Boolean).sort()[0];
      providers.push(buildDeepSeekPlanCard({
        balance: deepseekBalance,
        balanceReferences: recordDeepSeekBalance(deepseekBalance),
        totals: readDeepSeekUsageTotals(),
        days: readDeepSeekUsageDays({ since }),
        monthlyBudget: deepseekMonthlyBudget,
        monthlyBudgetCurrency: deepseekMonthlyBudgetCurrency,
        startingBalance: deepseekStartingBalance,
        now: generatedAt,
        configured: true,
        actuals: deepseekActuals,
      }));
    }

    return {
      version: PLAN_USAGE_VERSION,
      generatedAt,
      providers: providers.filter(Boolean),
    };
  }

  return {
    saveSnapshot,
    readSnapshot,
    recordCursorUsageReport,
    readCursorCycleTotals,
    resetCursorAccounting,
    recordGrokUsageReport,
    readGrokCycleTotals,
    resetGrokAccounting,
    recordDeepSeekUsageReport,
    readDeepSeekUsageTotals,
    readDeepSeekUsageDays,
    recordDeepSeekBalance,
    readDeepSeekBalanceReferences,
    readClaudeCloudSpend,
    buildReport,
    pools: CURSOR_POOLS,
  };
}
