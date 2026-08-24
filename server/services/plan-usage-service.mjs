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
 */

import {
  PLAN_USAGE_VERSION,
  toTrimmedString,
} from './plan-usage-contract.mjs';
import { buildCopilotPlanCard } from './plan-usage-copilot.mjs';
import { buildClaudePlanCard } from './plan-usage-claude.mjs';
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
  return true;
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
   * Assemble the full multi-provider report. Every provider is independent:
   * one failing source produces an unavailable card instead of failing the
   * whole response.
   */
  function buildReport({
    copilotSummary = null,
    copilotError = null,
    copilotStale = false,
    copilotBilling = null,
    claudeConfigured = true,
    cursorConfigured = true,
    cursorAllowances = null,
    cursorBilling = null,
    cursorDashboardAuth = null,
    grokConfigured = false,
    grokAllowances = null,
    grokBilling = null,
  } = {}) {
    const generatedAt = nowIso();
    const claudeSnapshot = readSnapshot('claude');
    const allowances = normalizeCursorAllowanceSettings(cursorAllowances || {});
    const cursorCycle = readCursorCycleTotals({ resetDay: allowances.resetDay });
    const grokSettings = normalizeGrokAllowanceSettings(grokAllowances || {});
    const grokCycle = readGrokCycleTotals({ resetDay: grokSettings.resetDay });
    const grokSnapshot = readSnapshot('grok');

    const providers = [
      buildCopilotPlanCard({
        summary: copilotSummary,
        billing: copilotBilling,
        error: copilotError,
        capturedAt: generatedAt,
        stale: copilotStale === true,
      }),
      buildClaudePlanCard({
        usage: claudeSnapshot?.payload || null,
        capturedAt: claudeSnapshot?.capturedAt || null,
        configured: claudeConfigured !== false,
        message: claudeSnapshot?.error || null,
        // A stored snapshot is by definition from an earlier turn; the SDK's
        // usage control call only works while a session transport is open, and
        // the relay never opens a billable turn just to refresh this.
        stale: !!claudeSnapshot?.payload,
      }),
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
    buildReport,
    pools: CURSOR_POOLS,
  };
}
