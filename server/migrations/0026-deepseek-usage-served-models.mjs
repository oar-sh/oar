'use strict';

/**
 * Migration: DeepSeek usage rows booked under a Claude model name are folded
 * into the DeepSeek model that served them (services/plan-usage-service.mjs,
 * the DeepSeek card in Check Usage). Builds on 0024 and 0025.
 *
 * A DeepSeek chat runs Claude Code. Before the CLI's model aliases were pinned
 * to the chat's model, a sub-agent asked for as "opus" went to DeepSeek as
 * `claude-opus-5-5`, which DeepSeek's Anthropic-compatible endpoint serves
 * with V4 Pro (and `claude-sonnet*` / `claude-haiku*` with Flash). Such
 * turns were booked under the Claude name and, as shared/deepseek-pricing.mjs
 * prices only DeepSeek's ids, without a price.
 *
 * For each of `deepseek_usage_totals`, `deepseek_usage_days` and
 * `deepseek_usage_checkpoints`, every row whose model name
 * shared/deepseek-models.mjs maps to a DeepSeek model (`deepseekServedModel`)
 * is added to that model's row (created when there is none) and deleted:
 * tokens, requests and turns are summed; `first_seen_at` / `last_seen_at`
 * widen. The folded tokens are priced at the DeepSeek model's price for the
 * row's last turn time (`last_seen_at` of a totals row, `updated_at` of a
 * daily row: peak or off-peak by that time, as the rows keep no per-turn
 * times), the folded requests at the request price for that time, and the
 * amounts are added to the target's costs. A checkpoint is a CLI session's
 * running total per model, so the Claude-named and the DeepSeek-named
 * checkpoints of one session add up to what the session reports once its
 * worker names the DeepSeek model.
 *
 * Idempotent: a database without such rows is left as it is. Safe to run on
 * every boot.
 *
 * Usage: node server/migrations/0026-deepseek-usage-served-models.mjs [path/to/oar.db]
 */

import { fileURLToPath } from 'url';
import path from 'path';
import Database from 'better-sqlite3';

import { DEEPSEEK_USAGE_CHECKPOINTS_TABLE, DEEPSEEK_USAGE_TOTALS_TABLE } from './0024-deepseek-usage-totals.mjs';
import { DEEPSEEK_USAGE_DAYS_TABLE, migrateDeepSeekUsageRequestsDaily } from './0025-deepseek-usage-requests-daily.mjs';
import { deepseekServedModel } from '../../shared/deepseek-models.mjs';
import { estimateCost, estimateSearchCost } from '../../shared/deepseek-pricing.mjs';
import { cliDbPath } from '../services/database-file.mjs';

/** The DeepSeek model a stored model name is folded into, or '' when the row stays. */
export function deepseekFoldedModel(model) {
  const name = String(model ?? '').trim();
  const served = deepseekServedModel(name);
  return served && served !== name ? served : '';
}

function foldableRows(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all()
    .map((row) => ({ row, target: deepseekFoldedModel(row.model) }))
    .filter((entry) => entry.target);
}

/** The rows the service would still read under a Claude name: '' when none. */
export function deepseekUsageServedModelsProblem(db) {
  for (const table of [DEEPSEEK_USAGE_TOTALS_TABLE, DEEPSEEK_USAGE_DAYS_TABLE, DEEPSEEK_USAGE_CHECKPOINTS_TABLE]) {
    const count = foldableRows(db, table).length;
    if (count) return `${table} holds ${count} row(s) under a model name DeepSeek served with another model`;
  }
  return '';
}

const count = (value) => Math.max(0, Math.round(Number(value) || 0));
const money = (value) => (value === null || value === undefined ? null : Number(value));

/** The folded row's token and request costs at the target model's price for `at`. */
function repriced(target, row, at) {
  const tokens = { hitTokens: count(row.hit_tokens), missTokens: count(row.miss_tokens), outputTokens: count(row.output_tokens) };
  const tokenCount = tokens.hitTokens + tokens.missTokens + tokens.outputTokens;
  const requests = { searchRequests: count(row.search_requests), fetchRequests: count(row.fetch_requests) };
  return {
    costUsd: tokenCount > 0 ? estimateCost({ model: target, at, currency: 'USD', ...tokens }) : null,
    costCny: tokenCount > 0 ? estimateCost({ model: target, at, currency: 'CNY', ...tokens }) : null,
    toolsCostUsd: estimateSearchCost({ at, currency: 'USD', ...requests }) || 0,
    toolsCostCny: estimateSearchCost({ at, currency: 'CNY', ...requests }) || 0,
  };
}

const sumCost = (current, added) => (added === null ? money(current) : (Number(current) || 0) + added);

function foldTotals(db) {
  const entries = foldableRows(db, DEEPSEEK_USAGE_TOTALS_TABLE);
  const get = db.prepare(`SELECT * FROM ${DEEPSEEK_USAGE_TOTALS_TABLE} WHERE model = ?`);
  const put = db.prepare(`
    INSERT OR REPLACE INTO ${DEEPSEEK_USAGE_TOTALS_TABLE} (
      model, hit_tokens, miss_tokens, output_tokens, search_requests, fetch_requests, turn_count,
      cost_usd, cost_cny, tools_cost_usd, tools_cost_cny, first_seen_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const remove = db.prepare(`DELETE FROM ${DEEPSEEK_USAGE_TOTALS_TABLE} WHERE model = ?`);
  for (const { row, target } of entries) {
    const into = get.get(target) || {};
    const price = repriced(target, row, row.last_seen_at);
    const earliest = [into.first_seen_at, row.first_seen_at].filter(Boolean).sort()[0];
    const latest = [into.last_seen_at, row.last_seen_at].filter(Boolean).sort().at(-1);
    put.run(
      target,
      count(into.hit_tokens) + count(row.hit_tokens),
      count(into.miss_tokens) + count(row.miss_tokens),
      count(into.output_tokens) + count(row.output_tokens),
      count(into.search_requests) + count(row.search_requests),
      count(into.fetch_requests) + count(row.fetch_requests),
      count(into.turn_count) + count(row.turn_count),
      sumCost(into.cost_usd ?? null, price.costUsd),
      sumCost(into.cost_cny ?? null, price.costCny),
      (Number(into.tools_cost_usd) || 0) + price.toolsCostUsd,
      (Number(into.tools_cost_cny) || 0) + price.toolsCostCny,
      earliest,
      latest,
      [into.updated_at, row.updated_at].filter(Boolean).sort().at(-1),
    );
    remove.run(row.model);
  }
  return entries.length;
}

function foldDays(db) {
  const entries = foldableRows(db, DEEPSEEK_USAGE_DAYS_TABLE);
  const get = db.prepare(`SELECT * FROM ${DEEPSEEK_USAGE_DAYS_TABLE} WHERE day = ? AND model = ?`);
  const put = db.prepare(`
    INSERT OR REPLACE INTO ${DEEPSEEK_USAGE_DAYS_TABLE} (
      day, model, hit_tokens, miss_tokens, output_tokens, search_requests, fetch_requests, turn_count,
      cost_usd, cost_cny, tools_cost_usd, tools_cost_cny, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const remove = db.prepare(`DELETE FROM ${DEEPSEEK_USAGE_DAYS_TABLE} WHERE day = ? AND model = ?`);
  for (const { row, target } of entries) {
    const into = get.get(row.day, target) || {};
    const price = repriced(target, row, row.updated_at);
    put.run(
      row.day,
      target,
      count(into.hit_tokens) + count(row.hit_tokens),
      count(into.miss_tokens) + count(row.miss_tokens),
      count(into.output_tokens) + count(row.output_tokens),
      count(into.search_requests) + count(row.search_requests),
      count(into.fetch_requests) + count(row.fetch_requests),
      count(into.turn_count) + count(row.turn_count),
      sumCost(into.cost_usd ?? null, price.costUsd),
      sumCost(into.cost_cny ?? null, price.costCny),
      (Number(into.tools_cost_usd) || 0) + price.toolsCostUsd,
      (Number(into.tools_cost_cny) || 0) + price.toolsCostCny,
      [into.updated_at, row.updated_at].filter(Boolean).sort().at(-1),
    );
    remove.run(row.day, row.model);
  }
  return entries.length;
}

function foldCheckpoints(db) {
  const entries = foldableRows(db, DEEPSEEK_USAGE_CHECKPOINTS_TABLE);
  const get = db.prepare(`
    SELECT * FROM ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} WHERE conversation_id = ? AND native_session_id = ? AND model = ?
  `);
  const put = db.prepare(`
    INSERT OR REPLACE INTO ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} (
      conversation_id, native_session_id, model, hit_tokens, miss_tokens, output_tokens, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const remove = db.prepare(`
    DELETE FROM ${DEEPSEEK_USAGE_CHECKPOINTS_TABLE} WHERE conversation_id = ? AND native_session_id = ? AND model = ?
  `);
  for (const { row, target } of entries) {
    const into = get.get(row.conversation_id, row.native_session_id, target) || {};
    put.run(
      row.conversation_id,
      row.native_session_id,
      target,
      count(into.hit_tokens) + count(row.hit_tokens),
      count(into.miss_tokens) + count(row.miss_tokens),
      count(into.output_tokens) + count(row.output_tokens),
      [into.updated_at, row.updated_at].filter(Boolean).sort().at(-1),
    );
    remove.run(row.conversation_id, row.native_session_id, row.model);
  }
  return entries.length;
}

export function migrateDeepSeekUsageServedModels(db) {
  // The rows live in 0024's and 0025's tables: a database without them gets
  // them first (and then has nothing to fold).
  migrateDeepSeekUsageRequestsDaily(db);
  const result = db.transaction(() => ({
    totalsFolded: foldTotals(db),
    daysFolded: foldDays(db),
    checkpointsFolded: foldCheckpoints(db),
  }))();
  return { applied: result.totalsFolded + result.daysFolded + result.checkpointsFolded > 0, ...result };
}

export function migrate(dbPath, options = {}) {
  const db = new Database(dbPath, options);
  try {
    return migrateDeepSeekUsageServedModels(db);
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
    console.log(`Migration 0026 on ${dbPath}`);
    console.log(result.applied
      ? `  deepseek usage served models: totals folded ${result.totalsFolded}, days folded ${result.daysFolded}, checkpoints folded ${result.checkpointsFolded}`
      : '  skipped: nothing to change');
    process.exit(0);
  } catch (err) {
    console.error(`Migration 0026 failed: ${err?.message || err}`);
    process.exit(1);
  }
}
