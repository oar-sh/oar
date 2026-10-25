import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  DEEPSEEK_BALANCE_REFERENCE_COLUMNS,
  DEEPSEEK_USAGE_DAYS_COLUMNS,
  DEEPSEEK_USAGE_REQUEST_COLUMNS,
  deepseekUsageRequestsDailyProblem,
  migrateDeepSeekUsageRequestsDaily,
} from './0025-deepseek-usage-requests-daily.mjs';
import { DEEPSEEK_USAGE_TOTALS_COLUMNS, migrateDeepSeekUsageTotals } from './0024-deepseek-usage-totals.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the four columns and the two tables once, on top of 0024', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageTotals(db);
  assert.equal(deepseekUsageRequestsDailyProblem(db), 'deepseek_usage_totals lacks search_requests, fetch_requests, tools_cost_usd, tools_cost_cny');
  assert.deepEqual(migrateDeepSeekUsageRequestsDaily(db), { applied: true, columnsAdded: 4, tablesAdded: 2 });
  assert.deepEqual(columns(db, 'deepseek_usage_totals'), [...DEEPSEEK_USAGE_TOTALS_COLUMNS, ...DEEPSEEK_USAGE_REQUEST_COLUMNS.map(([name]) => name)]);
  assert.deepEqual(columns(db, 'deepseek_usage_days'), [...DEEPSEEK_USAGE_DAYS_COLUMNS]);
  assert.deepEqual(columns(db, 'deepseek_balance_reference'), [...DEEPSEEK_BALANCE_REFERENCE_COLUMNS]);
  assert.equal(deepseekUsageRequestsDailyProblem(db), '');
  assert.deepEqual(migrateDeepSeekUsageRequestsDaily(db), { applied: false, columnsAdded: 0, tablesAdded: 0 });
});

test('a database without 0024 gets both; an existing row has zero requests and no tools cost', () => {
  const db = new Database(':memory:');
  assert.equal(deepseekUsageRequestsDailyProblem(db), 'no deepseek_usage_totals table');
  assert.deepEqual(migrateDeepSeekUsageRequestsDaily(db), { applied: true, columnsAdded: 4, tablesAdded: 2 });
  const at = '2026-10-24T12:00:00.000Z';
  db.prepare(`INSERT INTO deepseek_usage_totals (model, first_seen_at, last_seen_at, updated_at) VALUES (?, ?, ?, ?)`).run('deepseek-flash', at, at, at);
  const row = db.prepare(`SELECT * FROM deepseek_usage_totals`).get();
  assert.deepEqual(
    { search: row.search_requests, fetch: row.fetch_requests, usd: row.tools_cost_usd, cny: row.tools_cost_cny },
    { search: 0, fetch: 0, usd: 0, cny: 0 },
  );
});

test('one row per day and model; one reference per currency', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageRequestsDaily(db);
  const at = '2026-10-24T12:00:00.000Z';
  const day = db.prepare(`INSERT INTO deepseek_usage_days (day, model, updated_at) VALUES (?, ?, ?)`);
  day.run('2026-10-24', 'deepseek-flash', at);
  day.run('2026-10-24', 'deepseek-v4-pro', at);
  day.run('2026-10-25', 'deepseek-flash', at);
  assert.throws(() => day.run('2026-10-24', 'deepseek-flash', at), /UNIQUE|PRIMARY/);
  const row = db.prepare(`SELECT * FROM deepseek_usage_days WHERE day = '2026-10-24' AND model = 'deepseek-flash'`).get();
  assert.deepEqual(
    { turns: row.turn_count, search: row.search_requests, usd: row.cost_usd, toolsUsd: row.tools_cost_usd },
    { turns: 0, search: 0, usd: null, toolsUsd: 0 },
  );
  const reference = db.prepare(`INSERT INTO deepseek_balance_reference (currency, reference_total, last_total, reference_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
  reference.run('CNY', 110, 95.5, at, at);
  assert.throws(() => reference.run('CNY', 1, 1, at, at), /UNIQUE|PRIMARY/);
  assert.throws(() => reference.run('USD', null, 1, at, at), /NOT NULL/);
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(deepseekUsageRequestsDailyProblem(db), '');
});
