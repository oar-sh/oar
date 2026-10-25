import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  DEEPSEEK_USAGE_CHECKPOINT_COLUMNS,
  DEEPSEEK_USAGE_TOTALS_COLUMNS,
  deepseekUsageTotalsTableProblem,
  migrateDeepSeekUsageTotals,
} from './0024-deepseek-usage-totals.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table = 'deepseek_usage_totals') => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('creates the two tables once', () => {
  const db = new Database(':memory:');
  assert.equal(deepseekUsageTotalsTableProblem(db), 'no deepseek_usage_totals table');
  assert.deepEqual(migrateDeepSeekUsageTotals(db), { applied: true, tablesAdded: 2 });
  assert.deepEqual(columns(db), [...DEEPSEEK_USAGE_TOTALS_COLUMNS]);
  assert.deepEqual(columns(db, 'deepseek_usage_checkpoints'), [...DEEPSEEK_USAGE_CHECKPOINT_COLUMNS]);
  assert.equal(deepseekUsageTotalsTableProblem(db), '');
  assert.deepEqual(migrateDeepSeekUsageTotals(db), { applied: false, tablesAdded: 0 });
});

test('one row per model; the costs may be unknown, the times may not', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageTotals(db);
  const insert = db.prepare(`
    INSERT INTO deepseek_usage_totals (model, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  const at = '2026-10-21T12:00:00.000Z';
  insert.run('deepseek-flash', at, at, at);
  assert.throws(() => insert.run('deepseek-flash', at, at, at), /UNIQUE|PRIMARY/);
  assert.throws(() => insert.run('deepseek-v4-pro', null, at, at), /NOT NULL/);
  const checkpoint = db.prepare(`
    INSERT INTO deepseek_usage_checkpoints (conversation_id, native_session_id, model, updated_at) VALUES (?, ?, ?, ?)
  `);
  checkpoint.run('conv-a', 'native-1', 'deepseek-flash', at);
  checkpoint.run('conv-a', 'native-2', 'deepseek-flash', at);
  assert.throws(() => checkpoint.run('conv-a', 'native-1', 'deepseek-flash', at), /UNIQUE|PRIMARY/);
  const row = db.prepare(`SELECT * FROM deepseek_usage_totals`).get();
  assert.deepEqual(
    { hit: row.hit_tokens, miss: row.miss_tokens, output: row.output_tokens, turns: row.turn_count, usd: row.cost_usd, cny: row.cost_cny },
    { hit: 0, miss: 0, output: 0, turns: 0, usd: null, cny: null },
  );
});

test('a table of that name with other columns is reported, and the schema boot applies the migration', () => {
  const odd = new Database(':memory:');
  odd.exec(`CREATE TABLE deepseek_usage_totals (model TEXT PRIMARY KEY)`);
  assert.match(deepseekUsageTotalsTableProblem(odd), /deepseek_usage_totals lacks hit_tokens/);
  // The checkpoints still come next to a totals table of the first form.
  assert.deepEqual(migrateDeepSeekUsageTotals(odd), { applied: true, tablesAdded: 1 });
  assert.equal(columns(odd, 'deepseek_usage_checkpoints').length, 7);
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(deepseekUsageTotalsTableProblem(db), '');
});
