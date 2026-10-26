'use strict';

/**
 * What a relay's turns on the saved Claude API key cost, booked from the
 * workers' reports (POST /api/claude-api-usage): the figures behind the Claude
 * API card and its monthly cap (plan decisions 10–12).
 *
 * Both Claude workers report after every turn, the subscription one and the
 * Claude API one, because a chat moves between the two and keeps its Claude
 * Code session. A report carries, per model:
 * - `runCounts`: what this CLI process (`runId`) has run so far, counted from
 *   zero, with Claude Code's own cost estimate (`costUSD`);
 * - `sessionTotals`: the CLI's cumulative totals for the session, which a
 *   process resumed on the session (after a switch, a restart, an idle
 *   shutdown) re-reports in its first result, the earlier turns included.
 *
 * Booking (claude_api_usage_checkpoints, migration 0033):
 * - Spend is the rise of a run's counts over what was booked for that run; a
 *   report at or below it is a retried or reordered one and books nothing.
 *   Only `claude-api` reports book spend; a subscription report only keeps
 *   its checkpoint, the session's mark.
 * - A resumed run's first result is where the run's own counts fall short:
 *   they hold that turn's main agent loop only. That turn is booked as the
 *   rise of `sessionTotals` over the session's mark (the checkpoint with the
 *   latest turn), when the mark covers the session's last finished turn; the
 *   run's checkpoint then starts from the report's own counts, so its next
 *   result books only its own rise.
 * - A mark that is older than the last finished turn (a report was lost, or
 *   turns ran on a relay that did not report) is not used: the turn's own
 *   counts are booked, as tokens without a price, and that is logged.
 * - Totals that fall below the mark (a CLI that counts the session from
 *   zero after a resume) are booked from the run's own counts.
 *
 * Spend goes to claude_api_usage_totals (migration 0034) per local day and
 * model; a model Claude Code has no price for is booked as tokens only.
 */

import { claudeBaseModelId } from '../../shared/model-id.mjs';
import { migrateClaudeApiUsageCheckpoints } from '../migrations/0033-claude-api-usage-checkpoints.mjs';
import { migrateClaudeApiUsageTotals } from '../migrations/0034-claude-api-usage-totals.mjs';

export const CLAUDE_API_USAGE_BILLINGS = Object.freeze(['claude', 'claude-api']);
const TOKEN_FIELDS = Object.freeze(['hitTokens', 'missTokens', 'outputTokens']);
const CHECKPOINT_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

function count(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function cost(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function bookedModel(value) {
  return claudeBaseModelId(String(value ?? '').trim()).toLowerCase();
}

/** `[{ model, hitTokens, missTokens, outputTokens, costUsd, costUnknown }]`, summed per booked model id. */
export function normalizeClaudeApiUsageEntries(entries) {
  const byModel = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const model = bookedModel(entry?.model);
    if (!model) continue;
    const current = byModel.get(model) || { model, hitTokens: 0, missTokens: 0, outputTokens: 0, costUsd: 0, costUnknown: false };
    for (const field of TOKEN_FIELDS) current[field] += count(entry?.[field]);
    current.costUsd += cost(entry?.costUsd);
    current.costUnknown = current.costUnknown || entry?.costUnknown === true;
    byModel.set(model, current);
  }
  return [...byModel.values()];
}

/**
 * The report a worker posts, checked: `{ ok, report }` or `{ ok: false,
 * error }`. `billing` is the caller's to settle (the worker's registered
 * kind); the body's is only a fallback.
 */
export function normalizeClaudeApiUsageReport(body = {}) {
  const nativeSessionId = String(body?.claudeNativeSessionId || '').trim();
  const runId = String(body?.runId || '').trim();
  const at = String(body?.at || '').trim();
  if (!nativeSessionId) return { ok: false, error: 'Missing claudeNativeSessionId' };
  if (!runId) return { ok: false, error: 'Missing runId' };
  if (!Number.isFinite(Date.parse(at))) return { ok: false, error: 'Missing or invalid at' };
  const runCounts = normalizeClaudeApiUsageEntries(body?.runCounts);
  const sessionTotals = normalizeClaudeApiUsageEntries(body?.sessionTotals);
  if (!runCounts.length && !sessionTotals.length) return { ok: false, error: 'Missing runCounts and sessionTotals' };
  return {
    ok: true,
    report: {
      nativeSessionId,
      runId,
      at: new Date(Date.parse(at)).toISOString(),
      turnId: String(body?.turnId || '').trim() || null,
      firstResultOfRun: body?.firstResultOfRun === true,
      resumedSessionId: String(body?.resumedSessionId || '').trim() || null,
      billing: String(body?.billing || '').trim().toLowerCase(),
      runCounts,
      sessionTotals,
    },
  };
}

function dayFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }
}

export function createClaudeApiUsageService({
  db,
  now = () => Date.now(),
  // The relay's time zone (the cap's calendar month is the relay's); a test
  // names one.
  timeZone = undefined,
  logger = console,
} = {}) {
  if (!db) throw new Error('createClaudeApiUsageService requires db');
  // The schema boot runs these too; a boot where they failed retries here,
  // before the statements below are prepared.
  migrateClaudeApiUsageCheckpoints(db);
  migrateClaudeApiUsageTotals(db);
  const formatDay = dayFormatter(timeZone);
  const localDay = (iso) => formatDay.format(new Date(iso));

  const getRunCheckpoint = db.prepare(`
    SELECT * FROM claude_api_usage_checkpoints
    WHERE conversation_id = ? AND native_session_id = ? AND run_id = ? AND model = ?
  `);
  // The session's mark: the latest report's run, per model.
  const getMarkRun = db.prepare(`
    SELECT run_id, last_turn_id, last_turn_at FROM claude_api_usage_checkpoints
    WHERE native_session_id = ? AND run_id != ? AND last_turn_at IS NOT NULL
    ORDER BY last_turn_at DESC LIMIT 1
  `);
  const listMarkRows = db.prepare(`
    SELECT * FROM claude_api_usage_checkpoints WHERE native_session_id = ? AND run_id = ?
  `);
  const messageColumns = new Set(db.prepare(`PRAGMA table_info(messages)`).all().map((column) => column.name));
  // The session's last finished turn before this one: the latest reply of
  // the chat that answers a queue row (relay notes answer none).
  const getPreviousTurn = messageColumns.has('source_message_id')
    ? db.prepare(`
        SELECT source_message_id AS turn_id, timestamp FROM messages
        WHERE conversation_id = ? AND role = 'assistant'
          AND source_message_id IS NOT NULL AND source_message_id != ?
        ORDER BY timestamp DESC, rowid DESC LIMIT 1
      `)
    : null;
  const upsertCheckpoint = db.prepare(`
    INSERT INTO claude_api_usage_checkpoints (
      conversation_id, native_session_id, run_id, model, billing,
      run_hit_tokens, run_miss_tokens, run_output_tokens, run_cost_usd,
      session_hit_tokens, session_miss_tokens, session_output_tokens, session_cost_usd,
      cost_unknown, last_turn_id, last_turn_at, updated_at
    ) VALUES (
      @conversationId, @nativeSessionId, @runId, @model, @billing,
      @runHit, @runMiss, @runOutput, @runCost,
      @sessionHit, @sessionMiss, @sessionOutput, @sessionCost,
      @costUnknown, @lastTurnId, @lastTurnAt, @updatedAt
    )
    ON CONFLICT (conversation_id, native_session_id, run_id, model) DO UPDATE SET
      billing = excluded.billing,
      run_hit_tokens = excluded.run_hit_tokens,
      run_miss_tokens = excluded.run_miss_tokens,
      run_output_tokens = excluded.run_output_tokens,
      run_cost_usd = excluded.run_cost_usd,
      session_hit_tokens = excluded.session_hit_tokens,
      session_miss_tokens = excluded.session_miss_tokens,
      session_output_tokens = excluded.session_output_tokens,
      session_cost_usd = excluded.session_cost_usd,
      cost_unknown = excluded.cost_unknown,
      last_turn_id = excluded.last_turn_id,
      last_turn_at = excluded.last_turn_at,
      updated_at = excluded.updated_at
  `);
  const addTotals = db.prepare(`
    INSERT INTO claude_api_usage_totals (
      day, model, hit_tokens, miss_tokens, output_tokens, cost_usd, unknown_cost_tokens, turn_count,
      first_seen_at, last_seen_at, updated_at
    ) VALUES (@day, @model, @hit, @miss, @output, @cost, @unknownTokens, 1, @at, @at, @updatedAt)
    ON CONFLICT (day, model) DO UPDATE SET
      hit_tokens = hit_tokens + excluded.hit_tokens,
      miss_tokens = miss_tokens + excluded.miss_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cost_usd = cost_usd + excluded.cost_usd,
      unknown_cost_tokens = unknown_cost_tokens + excluded.unknown_cost_tokens,
      turn_count = turn_count + 1,
      first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
      last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
      updated_at = excluded.updated_at
  `);
  const pruneCheckpoints = db.prepare(`
    DELETE FROM claude_api_usage_checkpoints
    WHERE updated_at < ?
      AND run_id != (
        SELECT newest.run_id FROM claude_api_usage_checkpoints newest
        WHERE newest.native_session_id = claude_api_usage_checkpoints.native_session_id
        ORDER BY newest.last_turn_at DESC LIMIT 1
      )
  `);
  const readDays = db.prepare(`
    SELECT * FROM claude_api_usage_totals WHERE day >= ? AND day <= ? ORDER BY day ASC, model ASC
  `);
  let lastPruneAt = 0;

  const tokensOf = (entry) => TOKEN_FIELDS.reduce((sum, field) => sum + count(entry?.[field]), 0);
  const subtract = (from, base) => {
    const out = { model: from.model, costUnknown: from.costUnknown === true };
    for (const field of TOKEN_FIELDS) out[field] = count(from[field]) - count(base?.[field]);
    out.costUsd = cost(from.costUsd) - cost(base?.costUsd);
    return out;
  };
  const fromRow = (row, prefix) => (row
    ? {
        hitTokens: count(row[`${prefix}_hit_tokens`]),
        missTokens: count(row[`${prefix}_miss_tokens`]),
        outputTokens: count(row[`${prefix}_output_tokens`]),
        costUsd: cost(row[`${prefix}_cost_usd`]),
      }
    : null);

  /**
   * Book one report. `billing` is the kind of the worker that posted it.
   * Returns `{ billing, basis, booked: [{ model, ...delta }] }`; `basis` says
   * how a resumed run's first result was booked ('mark', 'run', 'stale-mark',
   * 'no-mark'), null otherwise.
   */
  function recordReport({ conversationId, billing, report }) {
    const convId = String(conversationId || '').trim();
    const kind = CLAUDE_API_USAGE_BILLINGS.includes(billing) ? billing : '';
    if (!convId || !kind || !report) return null;
    const updatedAt = new Date(now()).toISOString();
    const runByModel = new Map(report.runCounts.map((entry) => [entry.model, entry]));
    const sessionByModel = new Map(report.sessionTotals.map((entry) => [entry.model, entry]));
    const models = [...new Set([...runByModel.keys(), ...sessionByModel.keys()])];
    const booked = [];
    let basis = null;
    const write = db.transaction(() => {
      const seenRun = models.some((model) => getRunCheckpoint.get(convId, report.nativeSessionId, report.runId, model));
      const resumedFirst = !seenRun
        && report.firstResultOfRun
        && report.resumedSessionId === report.nativeSessionId;
      // A resumed run's first result, measured against the session's mark.
      let markRows = null;
      if (resumedFirst) {
        const markRun = getMarkRun.get(report.nativeSessionId, report.runId) || null;
        if (!markRun) {
          basis = 'no-mark';
        } else {
          // The mark covers the last finished turn when that turn's reply is
          // the mark's own, or no reply came after the mark (a turn that
          // left none, a stop, still has its report). A reply of another
          // turn after the mark means a report went missing.
          const previous = getPreviousTurn?.get(convId, report.turnId || '') || null;
          const fresh = !previous
            || String(previous.turn_id) === String(markRun.last_turn_id || '')
            || String(previous.timestamp || '') <= String(markRun.last_turn_at || '');
          if (!fresh) {
            basis = 'stale-mark';
          } else {
            markRows = new Map(listMarkRows.all(report.nativeSessionId, markRun.run_id).map((row) => [row.model, row]));
            const dropped = [...sessionByModel.values()].some((entry) => {
              const mark = fromRow(markRows.get(entry.model), 'session');
              return mark && TOKEN_FIELDS.some((field) => count(entry[field]) < mark[field]);
            });
            basis = dropped ? 'run' : 'mark';
            if (dropped) markRows = null;
          }
        }
      }
      for (const model of models) {
        const run = runByModel.get(model) || { model, hitTokens: 0, missTokens: 0, outputTokens: 0, costUsd: 0, costUnknown: false };
        const session = sessionByModel.get(model) || null;
        const costUnknown = run.costUnknown === true || session?.costUnknown === true;
        const previous = fromRow(getRunCheckpoint.get(convId, report.nativeSessionId, report.runId, model), 'run');
        let delta = null;
        let priceKnown = !costUnknown;
        if (previous) {
          // The same run again: its rise; a report below it is stale.
          const rise = subtract(run, previous);
          if (TOKEN_FIELDS.some((field) => rise[field] < 0)) continue;
          delta = rise;
        } else if (basis === 'mark') {
          const mark = fromRow(markRows?.get(model), 'session');
          delta = session ? subtract(session, mark) : { ...run };
        } else if (basis === 'stale-mark' || basis === 'no-mark' || basis === 'run') {
          // A resumed run's first result without a usable mark: the turn's
          // own counts, its main agent loop only, which carry no price.
          delta = { ...run, costUsd: 0 };
          priceKnown = false;
        } else {
          delta = { ...run };
        }
        for (const field of TOKEN_FIELDS) delta[field] = Math.max(0, count(delta[field]));
        delta.costUsd = priceKnown ? Math.max(0, Number(delta.costUsd) || 0) : 0;
        upsertCheckpoint.run({
          conversationId: convId,
          nativeSessionId: report.nativeSessionId,
          runId: report.runId,
          model,
          billing: kind,
          runHit: count(run.hitTokens),
          runMiss: count(run.missTokens),
          runOutput: count(run.outputTokens),
          runCost: cost(run.costUsd),
          sessionHit: count(session?.hitTokens),
          sessionMiss: count(session?.missTokens),
          sessionOutput: count(session?.outputTokens),
          sessionCost: cost(session?.costUsd),
          costUnknown: costUnknown ? 1 : 0,
          lastTurnId: report.turnId,
          lastTurnAt: report.at,
          updatedAt,
        });
        if (kind !== 'claude-api' || tokensOf(delta) + delta.costUsd <= 0) continue;
        addTotals.run({
          day: localDay(report.at),
          model,
          hit: delta.hitTokens,
          miss: delta.missTokens,
          output: delta.outputTokens,
          cost: delta.costUsd,
          unknownTokens: priceKnown ? 0 : tokensOf(delta),
          at: report.at,
          updatedAt,
        });
        booked.push({ model, ...delta, priceKnown });
      }
      if (now() - lastPruneAt > PRUNE_EVERY_MS) {
        lastPruneAt = now();
        pruneCheckpoints.run(new Date(now() - CHECKPOINT_RETENTION_MS).toISOString());
      }
    });
    write();
    if (basis === 'stale-mark' || basis === 'no-mark') {
      try {
        logger.warn?.(`[claude-api-usage] conv=${convId.slice(0, 8)} resumed run ${report.runId.slice(0, 8)}: ${basis === 'no-mark' ? 'no mark' : 'mark stale'}; its first turn is booked from its own counts, without a price`);
      } catch {}
    }
    return { billing: kind, basis, booked };
  }

  /** Booked rows per day and model, `fromDay`..`toDay` inclusive (local `YYYY-MM-DD`). */
  function readDaysBetween(fromDay, toDay) {
    return readDays.all(String(fromDay || ''), String(toDay || '')).map((row) => ({ ...row }));
  }

  return {
    recordReport,
    readDaysBetween,
    localDay,
    // The zone `localDay` keeps (the card names it).
    timeZone: formatDay.resolvedOptions().timeZone || '',
  };
}
