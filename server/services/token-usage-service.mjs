'use strict';

/**
 * Tokens per turn for every provider, and their daily sums: booked
 * from the workers' reports (POST /api/turn-token-usage), read by the Tokens
 * sections in Check Usage and the About panel.
 *
 * A turn's row (`turn_token_usage`, migration 0036) is keyed by turn, run
 * and model. Its counts only rise: a later report of the same key keeps,
 * field by field, the larger of the two (a field it leaves out keeps the
 * earlier value), and only the rise goes into the day's row
 * (`token_usage_days`, source `turns`). A retried or reordered report
 * therefore books nothing twice. The day is the relay's local date (its
 * time zone) of the turn's first report: the worker's `at`, or the relay's
 * clock when that is missing or more than a day off. A later report of the
 * same turn books into that day too.
 *
 * A Claude cloud report carries the session's running totals instead: the
 * turn is what they add to the other turns already booked for the session
 * and model (floored at 0), so a retry of the same turn stays the same.
 *
 * Day rows survive the chat: deleting it drops only its turn rows.
 */

import {
  TOKEN_USAGE_DAYS_TABLE,
  TURN_TOKEN_USAGE_TABLE,
  migrateTokenUsage,
  tokenUsageProblem,
} from '../migrations/0036-token-usage.mjs';
import { TURN_TOKEN_FIELDS, addNullable } from '../../shared/turn-token-usage.mjs';

const COLUMN = Object.freeze({
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  cacheWriteTokens: 'cache_write_tokens',
  cacheReadTokens: 'cache_read_tokens',
  reasoningTokens: 'reasoning_tokens',
});
// The fields the views show and total; reasoning is a part of output.
const PRICED_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'cacheWriteTokens', 'cacheReadTokens']);
// How far a worker's `at` may be off the relay's clock before the relay's
// own time is taken instead.
const AT_SKEW_MS = 24 * 60 * 60 * 1000;

function dayFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }
}

function maxNullable(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return Math.max(a, b);
}

// What `merged` adds over `old`: null when nothing (the field stays as it is).
function rise(merged, old) {
  if (merged == null) return null;
  const by = merged - (old ?? 0);
  return old == null || by > 0 ? by : null;
}

function emptyTotals() {
  return {
    ...Object.fromEntries(TURN_TOKEN_FIELDS.map((field) => [field, null])),
    costUsd: null,
    unknownCostTokens: 0,
    turnCount: 0,
    rows: 0,
    // Per field, how many rows reported it: fewer than `rows` (and more than
    // 0) means some turns left it out.
    reported: Object.fromEntries(TURN_TOKEN_FIELDS.map((field) => [field, 0])),
  };
}

function addDayRow(totals, row) {
  for (const field of TURN_TOKEN_FIELDS) {
    const value = row[COLUMN[field]];
    totals[field] = addNullable(totals[field], value);
    if (value != null) totals.reported[field] += 1;
  }
  totals.costUsd = addNullable(totals.costUsd, row.cost_usd);
  totals.unknownCostTokens += Number(row.unknown_cost_tokens || 0);
  totals.turnCount += Number(row.turn_count || 0);
  totals.rows += 1;
}

/** The fields some rows of `totals` reported and others did not. */
export function partlyReportedFields(totals) {
  return TURN_TOKEN_FIELDS.filter((field) => totals.reported[field] > 0 && totals.reported[field] < totals.rows);
}

function turnRowOut(row) {
  return {
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    runId: row.run_id,
    model: row.model,
    provider: row.provider,
    billing: row.billing,
    nativeSessionId: row.native_session_id,
    responseMessageId: row.response_message_id,
    at: row.at,
    day: row.day,
    ...Object.fromEntries(TURN_TOKEN_FIELDS.map((field) => [field, row[COLUMN[field]]])),
    costUsd: row.cost_usd,
    costSource: row.cost_source,
    costUnknown: row.cost_unknown === 1,
  };
}

function sumTurnRows(rows) {
  const totals = { ...Object.fromEntries(TURN_TOKEN_FIELDS.map((field) => [field, null])), costUsd: null };
  for (const row of rows) {
    for (const field of TURN_TOKEN_FIELDS) totals[field] = addNullable(totals[field], row[field]);
    totals.costUsd = addNullable(totals.costUsd, row.costUsd);
  }
  return totals;
}

/**
 * Drop the turn rows of chats removed for good, from the delete paths that
 * run outside the conversation routes (the startup delete retry, the cache
 * rebuild), inside their own transaction. The day rows stay. A database
 * without the table (0036 not run yet) has nothing to drop.
 */
export function forgetTurnTokenRows(db, conversationIds) {
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(TURN_TOKEN_USAGE_TABLE);
  if (!exists) return 0;
  const remove = db.prepare(`DELETE FROM ${TURN_TOKEN_USAGE_TABLE} WHERE conversation_id = ?`);
  let changes = 0;
  for (const id of conversationIds) changes += remove.run(String(id || '')).changes;
  return changes;
}

export function createTokenUsageService({
  db,
  now = () => Date.now(),
  // The relay's time zone (the month is a calendar month in relay local
  // time, as on the Claude API card); a test names one.
  timeZone = undefined,
  logger = console,
} = {}) {
  if (!db) throw new Error('createTokenUsageService requires db');
  const formatDay = dayFormatter(timeZone);
  const localDay = (ms) => formatDay.format(new Date(ms));

  // The schema boot runs 0036; one that failed (a source table was missing)
  // retries here, and until the tables are there every call is a no-op.
  let stmts = null;
  // Each distinct failure is logged once, not on every post and read.
  const warned = new Set();
  function ready() {
    if (stmts) return stmts;
    try {
      migrateTokenUsage(db);
    } catch (error) {
      const text = `[token-usage] migration 0036 failed; retrying later: ${error?.message || error}`;
      if (!warned.has(text)) {
        warned.add(text);
        logger?.warn?.(text);
      }
    }
    if (tokenUsageProblem(db)) return null;
    stmts = prepare();
    return stmts;
  }

  function prepare() {
    const fieldColumns = TURN_TOKEN_FIELDS.map((field) => COLUMN[field]);
    return {
      getTurnRow: db.prepare(`SELECT * FROM ${TURN_TOKEN_USAGE_TABLE} WHERE turn_id = ? AND run_id = ? AND model = ?`),
      upsertTurnRow: db.prepare(`
        INSERT INTO ${TURN_TOKEN_USAGE_TABLE} (
          conversation_id, turn_id, run_id, model, provider, billing, native_session_id, response_message_id,
          at, day, ${fieldColumns.join(', ')}, cost_usd, cost_source, cost_unknown, updated_at
        ) VALUES (
          @conversationId, @turnId, @runId, @model, @provider, @billing, @nativeSessionId, @responseMessageId,
          @at, @day, ${TURN_TOKEN_FIELDS.map((field) => `@${field}`).join(', ')}, @costUsd, @costSource, @costUnknown, @updatedAt
        )
        ON CONFLICT (turn_id, run_id, model) DO UPDATE SET
          native_session_id = COALESCE(excluded.native_session_id, native_session_id),
          response_message_id = COALESCE(excluded.response_message_id, response_message_id),
          ${fieldColumns.map((column) => `${column} = excluded.${column}`).join(',\n          ')},
          cost_usd = excluded.cost_usd,
          cost_source = excluded.cost_source,
          cost_unknown = excluded.cost_unknown,
          updated_at = excluded.updated_at
      `),
      // Null-aware: a field stays NULL until a turn reports it.
      addDayRow: db.prepare(`
        INSERT INTO ${TOKEN_USAGE_DAYS_TABLE} (
          day, provider, billing, model, source, ${fieldColumns.join(', ')},
          cost_usd, unknown_cost_tokens, turn_count, first_seen_at, last_seen_at, updated_at
        ) VALUES (
          @day, @provider, @billing, @model, 'turns', ${TURN_TOKEN_FIELDS.map((field) => `@${field}`).join(', ')},
          @costUsd, @unknownCostTokens, @turnCount, @at, @at, @updatedAt
        )
        ON CONFLICT (day, provider, billing, model, source) DO UPDATE SET
          ${fieldColumns.map((column) => `${column} = CASE WHEN excluded.${column} IS NULL THEN ${column} ELSE COALESCE(${column}, 0) + excluded.${column} END`).join(',\n          ')},
          cost_usd = CASE WHEN excluded.cost_usd IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + excluded.cost_usd END,
          unknown_cost_tokens = unknown_cost_tokens + excluded.unknown_cost_tokens,
          turn_count = turn_count + excluded.turn_count,
          first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
          updated_at = excluded.updated_at
      `),
      // The other turns booked for a cloud session and model.
      sumSessionRows: db.prepare(`
        SELECT ${fieldColumns.map((column) => `SUM(${column}) AS ${column}`).join(', ')}, SUM(cost_usd) AS cost_usd
        FROM ${TURN_TOKEN_USAGE_TABLE}
        WHERE conversation_id = ? AND native_session_id = ? AND model = ? AND NOT (turn_id = ? AND run_id = ?)
      `),
      listDayRows: db.prepare(`SELECT * FROM ${TOKEN_USAGE_DAYS_TABLE} WHERE provider = ?`),
      listAllDayRows: db.prepare(`SELECT * FROM ${TOKEN_USAGE_DAYS_TABLE}`),
      listTurnRows: db.prepare(`SELECT * FROM ${TURN_TOKEN_USAGE_TABLE} WHERE turn_id = ? ORDER BY at, run_id, model`),
      listConversationRows: db.prepare(`SELECT * FROM ${TURN_TOKEN_USAGE_TABLE} WHERE conversation_id = ? ORDER BY at, turn_id, run_id, model`),
      deleteConversationRows: db.prepare(`DELETE FROM ${TURN_TOKEN_USAGE_TABLE} WHERE conversation_id = ?`),
    };
  }

  function bookEntries(s, { conversationId, provider, billing, report, entries }) {
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    // The turn's time: the worker's, unless it is more than a day off the
    // relay's clock.
    const reportedMs = report.at ? Date.parse(report.at) : Number.NaN;
    const atMs = Number.isFinite(reportedMs) && Math.abs(reportedMs - nowMs) <= AT_SKEW_MS ? reportedMs : nowMs;
    const booked = [];
    for (const entry of entries) {
      const old = s.getTurnRow.get(report.turnId, report.runId, entry.model);
      const merged = {};
      const rises = {};
      for (const field of TURN_TOKEN_FIELDS) {
        const before = old ? old[COLUMN[field]] : null;
        merged[field] = maxNullable(before, entry[field]);
        rises[field] = rise(merged[field], before);
      }
      const costUsd = maxNullable(old ? old.cost_usd : null, entry.costUsd);
      const costRise = rise(costUsd, old ? old.cost_usd : null);
      const costUnknown = Boolean(old?.cost_unknown) || entry.costUnknown;
      const day = old ? old.day : localDay(atMs);
      const at = old ? old.at : new Date(atMs).toISOString();
      // The row keeps the provider and billing of its first report.
      const rowProvider = old ? old.provider : provider;
      const rowBilling = old ? old.billing : billing;
      s.upsertTurnRow.run({
        conversationId,
        turnId: report.turnId,
        runId: report.runId,
        model: entry.model,
        provider: rowProvider,
        billing: rowBilling,
        nativeSessionId: report.nativeSessionId,
        responseMessageId: report.responseMessageId,
        at,
        day,
        ...merged,
        costUsd,
        costSource: entry.costSource || old?.cost_source || null,
        costUnknown: costUnknown ? 1 : 0,
        updatedAt: nowIso,
      });
      const changed = TURN_TOKEN_FIELDS.some((field) => rises[field] != null) || costRise != null;
      if (!old || changed) {
        const risenTokens = PRICED_FIELDS.reduce((sum, field) => sum + (rises[field] ?? 0), 0);
        s.addDayRow.run({
          day,
          provider: rowProvider,
          billing: rowBilling,
          model: entry.model,
          ...rises,
          costUsd: costRise,
          unknownCostTokens: costUnknown ? risenTokens : 0,
          turnCount: old ? 0 : 1,
          at,
          updatedAt: nowIso,
        });
      }
      booked.push({ model: entry.model, day, ...merged, costUsd, added: old ? changed : true });
    }
    return booked;
  }

  /**
   * Book a turn's counts per model (`report.models`). `provider` and
   * `billing` are the relay's: what the reporting worker is. Returns the
   * booked rows, or null when the tables are not there.
   */
  function recordTurn({ conversationId, provider, billing = '', report }) {
    const s = ready();
    if (!s) return null;
    return db.transaction(() => bookEntries(s, { conversationId, provider, billing, report, entries: report.models || [] }))();
  }

  /**
   * Book a Claude cloud turn from the session's running totals per model
   * (`report.sessionTotals`): the turn is what they add to the session's
   * other booked turns, floored at 0.
   */
  function recordCloudSessionTotals({ conversationId, provider = 'claude-cloud', billing = '', report }) {
    const s = ready();
    if (!s) return null;
    return db.transaction(() => {
      const entries = (report.sessionTotals || []).map((entry) => {
        const earlier = s.sumSessionRows.get(conversationId, report.nativeSessionId, entry.model, report.turnId, report.runId);
        const turn = { ...entry };
        for (const field of TURN_TOKEN_FIELDS) {
          turn[field] = entry[field] == null ? null : Math.max(0, entry[field] - (earlier?.[COLUMN[field]] ?? 0));
        }
        turn.costUsd = entry.costUsd == null ? null : Math.max(0, entry.costUsd - (earlier?.cost_usd ?? 0));
        return turn;
      });
      return bookEntries(s, { conversationId, provider, billing, report, entries });
    })();
  }

  /**
   * Today, this month and all time for a provider, per billing ('' first,
   * then the own keys) and per model. `since` is the first day anything was
   * counted, copied days included; `backfilled` says which periods hold days
   * copied at the upgrade (whose input includes cache writes),
   * `backfillThrough` the last such day and `firstTurnsDay` the first day a
   * turn was booked.
   */
  function readPeriods({ provider, now: nowMs = now() } = {}) {
    const s = ready();
    if (!s) return null;
    const today = localDay(nowMs);
    const month = today.slice(0, 7);
    const groups = new Map();
    const rows = provider ? s.listDayRows.all(provider) : s.listAllDayRows.all();
    for (const row of rows) {
      const key = `${row.provider}\n${row.billing}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          provider: row.provider,
          billing: row.billing,
          periods: { today: emptyTotals(), month: emptyTotals(), allTime: emptyTotals() },
          models: new Map(),
          since: null,
          backfilled: { today: false, month: false, allTime: false },
          backfillThrough: null,
          firstTurnsDay: null,
        };
        groups.set(key, group);
      }
      let model = group.models.get(row.model);
      if (!model) {
        model = { model: row.model, today: emptyTotals(), month: emptyTotals(), allTime: emptyTotals() };
        group.models.set(row.model, model);
      }
      const inPeriods = ['allTime'];
      if (row.day.startsWith(`${month}-`)) inPeriods.push('month');
      if (row.day === today) inPeriods.push('today');
      for (const period of inPeriods) {
        addDayRow(group.periods[period], row);
        addDayRow(model[period], row);
        if (row.source === 'backfill') group.backfilled[period] = true;
      }
      if (!group.since || row.day < group.since) group.since = row.day;
      if (row.source === 'backfill' && (!group.backfillThrough || row.day > group.backfillThrough)) group.backfillThrough = row.day;
      if (row.source === 'turns' && (!group.firstTurnsDay || row.day < group.firstTurnsDay)) group.firstTurnsDay = row.day;
    }
    return {
      today,
      month,
      groups: [...groups.values()]
        .sort((a, b) => a.provider.localeCompare(b.provider) || (a.billing ? 1 : 0) - (b.billing ? 1 : 0) || a.billing.localeCompare(b.billing))
        .map((group) => ({
          ...group,
          models: [...group.models.values()].sort((a, b) => a.model.localeCompare(b.model)),
        })),
    };
  }

  /** A turn's rows (every run and model) and their sum; null when none. */
  function readTurn(turnId) {
    const s = ready();
    if (!s) return null;
    const rows = s.listTurnRows.all(String(turnId || '')).map(turnRowOut);
    if (!rows.length) return null;
    return { turnId: String(turnId), rows, totals: sumTurnRows(rows) };
  }

  /** A chat's rows and their sums, overall and per Claude Code session. */
  function readConversation(conversationId) {
    const s = ready();
    if (!s) return null;
    const rows = s.listConversationRows.all(String(conversationId || '')).map(turnRowOut);
    const bySession = new Map();
    for (const row of rows) {
      const key = row.nativeSessionId || '';
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(row);
    }
    return {
      conversationId: String(conversationId),
      rows,
      totals: sumTurnRows(rows),
      sessions: [...bySession.entries()].map(([nativeSessionId, sessionRows]) => ({
        nativeSessionId: nativeSessionId || null,
        totals: sumTurnRows(sessionRows),
      })),
    };
  }

  /** The chat is deleted: its turn rows go, the day rows stay. */
  function forgetConversation(conversationId) {
    const s = ready();
    if (!s) return 0;
    return s.deleteConversationRows.run(String(conversationId || '')).changes;
  }

  return {
    recordTurn,
    recordCloudSessionTotals,
    readPeriods,
    readTurn,
    readConversation,
    forgetConversation,
    localDay: (ms = now()) => localDay(ms),
    timeZone: formatDay.resolvedOptions().timeZone,
  };
}
