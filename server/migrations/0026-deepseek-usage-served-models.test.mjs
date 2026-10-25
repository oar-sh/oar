import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  deepseekFoldedModel,
  deepseekUsageServedModelsProblem,
  migrateDeepSeekUsageServedModels,
} from './0026-deepseek-usage-served-models.mjs';
import { migrateDeepSeekUsageRequestsDaily } from './0025-deepseek-usage-requests-daily.mjs';
import { applySchema } from '../db-schema.mjs';

// Off-peak (a Saturday): flash $0.003/$0.15/$0.60 and ¥0.02/¥1/¥4, pro
// $0.022/$0.66/$1.98 and ¥0.15/¥4.5/¥13.5 per 1M tokens.
const SATURDAY = '2026-10-24T23:23:00.000Z';
// Peak (a Wednesday, 02:00 UTC): double.
const PEAK = '2026-10-21T02:00:00.000Z';

function totalsRow(db, model, { hit, miss, out, turns = 1, search = 0, usd = null, cny = null, first = SATURDAY, last = SATURDAY }) {
  db.prepare(`
    INSERT INTO deepseek_usage_totals (model, hit_tokens, miss_tokens, output_tokens, search_requests, fetch_requests, turn_count,
      cost_usd, cost_cny, tools_cost_usd, tools_cost_cny, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0, 0, ?, ?, ?)
  `).run(model, hit, miss, out, search, turns, usd, cny, first, last, last);
}

function dayRow(db, day, model, { hit, miss, out, turns = 1, usd = null, cny = null, at = SATURDAY }) {
  db.prepare(`
    INSERT INTO deepseek_usage_days (day, model, hit_tokens, miss_tokens, output_tokens, search_requests, fetch_requests, turn_count,
      cost_usd, cost_cny, tools_cost_usd, tools_cost_cny, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0, 0, ?)
  `).run(day, model, hit, miss, out, turns, usd, cny, at);
}

function checkpointRow(db, conversation, session, model, hit, miss, out, at = SATURDAY) {
  db.prepare(`
    INSERT INTO deepseek_usage_checkpoints (conversation_id, native_session_id, model, hit_tokens, miss_tokens, output_tokens, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(conversation, session, model, hit, miss, out, at);
}

const round = (value) => (value === null ? null : Number(value.toFixed(10)));

test('a Claude name maps to the DeepSeek model that served it; DeepSeek\'s own ids and unknown names stay', () => {
  assert.equal(deepseekFoldedModel('claude-opus-5-5'), 'deepseek-v4-pro');
  assert.equal(deepseekFoldedModel('claude-sonnet-5-5'), 'deepseek-flash');
  assert.equal(deepseekFoldedModel('claude-haiku-4-5-20251001'), 'deepseek-flash');
  assert.equal(deepseekFoldedModel('deepseek-flash'), '');
  assert.equal(deepseekFoldedModel('deepseek-v4-flash'), '');
  assert.equal(deepseekFoldedModel('deepseek-v5'), '');
  assert.equal(deepseekFoldedModel('gpt-5'), '');
});

test('totals under a Claude name are added to the served model, priced at its price for the row\'s last turn time', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageRequestsDaily(db);
  // A Flash session: its own turns, and a sub-agent DeepSeek ran on V4 Pro
  // (asked for as "opus") plus one it ran on Flash (asked for as "sonnet").
  totalsRow(db, 'deepseek-flash', { hit: 50_000, miss: 10_000, out: 1_000, turns: 3, usd: 0.0021, cny: 0.015, first: '2026-10-24T20:00:00.000Z' });
  totalsRow(db, 'claude-opus-5-5', { hit: 0, miss: 1_000_000, out: 100_000, search: 2 });
  totalsRow(db, 'claude-sonnet-5-5', { hit: 1_000_000, miss: 0, out: 0, turns: 2, last: PEAK, first: PEAK });
  // An unknown name stays as it is.
  totalsRow(db, 'deepseek-v5', { hit: 1, miss: 1, out: 1 });
  assert.match(deepseekUsageServedModelsProblem(db), /deepseek_usage_totals holds 2 row/);

  assert.deepEqual(migrateDeepSeekUsageServedModels(db), { applied: true, totalsFolded: 2, daysFolded: 0, checkpointsFolded: 0 });
  const rows = db.prepare(`SELECT * FROM deepseek_usage_totals ORDER BY model`).all();
  assert.deepEqual(rows.map((row) => [row.model, row.hit_tokens, row.miss_tokens, row.output_tokens, row.turn_count, row.search_requests]), [
    ['deepseek-flash', 1_050_000, 10_000, 1_000, 5, 0],
    ['deepseek-v4-pro', 0, 1_000_000, 100_000, 1, 2],
    ['deepseek-v5', 1, 1, 1, 1, 0],
  ]);
  const [flash, pro, unknown] = rows;
  // The pro row is new: 1M misses at $0.66 and 100K output at $1.98 off-peak;
  // the two searches date from before DeepSeek charged for them.
  assert.equal(round(pro.cost_usd), 0.858);
  assert.equal(round(pro.cost_cny), 5.85);
  assert.equal(pro.tools_cost_usd, 0);
  assert.equal(pro.first_seen_at, SATURDAY);
  assert.equal(pro.last_seen_at, SATURDAY);
  // The flash row keeps its price and gains 1M hits at the peak price ($0.006, ¥0.04).
  assert.equal(round(flash.cost_usd), 0.0081);
  assert.equal(round(flash.cost_cny), 0.055);
  assert.equal(flash.first_seen_at, '2026-10-21T02:00:00.000Z');
  assert.equal(flash.last_seen_at, SATURDAY);
  assert.equal(unknown.cost_usd, null);
  assert.equal(deepseekUsageServedModelsProblem(db), '');
  assert.deepEqual(migrateDeepSeekUsageServedModels(db), { applied: false, totalsFolded: 0, daysFolded: 0, checkpointsFolded: 0 });
});

test('daily rows fold per day; a session\'s checkpoints add up under the served model', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageRequestsDaily(db);
  dayRow(db, '2026-10-24', 'deepseek-flash', { hit: 100, miss: 200, out: 30, usd: 0.0001, cny: 0.0007 });
  dayRow(db, '2026-10-24', 'claude-sonnet-5-5', { hit: 0, miss: 1_000_000, out: 0 });
  dayRow(db, '2026-10-25', 'claude-opus-5-5', { hit: 0, miss: 0, out: 1_000_000, at: '2026-10-25T10:00:00.000Z' });
  checkpointRow(db, 'conv-1', 'native-1', 'deepseek-flash', 5_000, 1_000, 500);
  checkpointRow(db, 'conv-1', 'native-1', 'claude-sonnet-5-5', 300, 0, 20);
  checkpointRow(db, 'conv-1', 'native-1', 'claude-opus-5-5', 4_000, 0, 100);
  checkpointRow(db, 'conv-2', 'native-2', 'claude-opus-5-5', 1, 2, 3);

  assert.deepEqual(migrateDeepSeekUsageServedModels(db), { applied: true, totalsFolded: 0, daysFolded: 2, checkpointsFolded: 3 });
  const days = db.prepare(`SELECT * FROM deepseek_usage_days ORDER BY day, model`).all();
  assert.deepEqual(days.map((row) => [row.day, row.model, row.hit_tokens, row.miss_tokens, row.output_tokens, row.turn_count, round(row.cost_usd), round(row.cost_cny)]), [
    // 1M misses at flash's off-peak $0.15 / ¥1 join the day's flash row.
    ['2026-10-24', 'deepseek-flash', 100, 1_000_200, 30, 2, 0.1501, 1.0007],
    // Sunday 10:00 UTC is off-peak: 1M output at pro's $1.98 / ¥13.5.
    ['2026-10-25', 'deepseek-v4-pro', 0, 0, 1_000_000, 1, 1.98, 13.5],
  ]);
  // What the session's worker reports once it names the DeepSeek models:
  // flash = its own turns plus the Sonnet-named sub-agent, pro = the Opus one.
  const checkpoints = db.prepare(`SELECT * FROM deepseek_usage_checkpoints ORDER BY conversation_id, model`).all();
  assert.deepEqual(checkpoints.map((row) => [row.conversation_id, row.native_session_id, row.model, row.hit_tokens, row.miss_tokens, row.output_tokens]), [
    ['conv-1', 'native-1', 'deepseek-flash', 5_300, 1_000, 520],
    ['conv-1', 'native-1', 'deepseek-v4-pro', 4_000, 0, 100],
    ['conv-2', 'native-2', 'deepseek-v4-pro', 1, 2, 3],
  ]);
});

test('a database without the tables gets them and has nothing to fold; the schema boot applies the migration', () => {
  const fresh = new Database(':memory:');
  assert.deepEqual(migrateDeepSeekUsageServedModels(fresh), { applied: false, totalsFolded: 0, daysFolded: 0, checkpointsFolded: 0 });
  assert.equal(deepseekUsageServedModelsProblem(fresh), '');
  const db = new Database(':memory:');
  applySchema(db);
  totalsRow(db, 'claude-opus-5-5', { hit: 0, miss: 10, out: 10 });
  applySchema(db);
  assert.deepEqual(db.prepare(`SELECT model FROM deepseek_usage_totals`).all(), [{ model: 'deepseek-v4-pro' }]);
});
