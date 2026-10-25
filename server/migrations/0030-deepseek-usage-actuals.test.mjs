import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  DEEPSEEK_USAGE_ACTUALS_COLUMNS,
  deepseekUsageActualsProblem,
  migrateDeepSeekUsageActuals,
} from './0030-deepseek-usage-actuals.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('creates the table once', () => {
  const db = new Database(':memory:');
  assert.equal(deepseekUsageActualsProblem(db), 'no deepseek_usage_actuals table');
  assert.deepEqual(migrateDeepSeekUsageActuals(db), { applied: true, tableCreated: true });
  assert.deepEqual(columns(db, 'deepseek_usage_actuals'), [...DEEPSEEK_USAGE_ACTUALS_COLUMNS]);
  assert.equal(deepseekUsageActualsProblem(db), '');
  assert.deepEqual(migrateDeepSeekUsageActuals(db), { applied: false, tableCreated: false });
});

test('one row per day, model and key, whatever the offset of the period', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageActuals(db);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO deepseek_usage_actuals (period_start, period_end, day, model, key_fp, cost, currency, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, 'CNY', ?)
  `);
  insert.run('2026-10-24T00:00:00+01:00', '2026-10-25T00:00:00+01:00', '2026-10-24', 'deepseek-flash', 'sk-aaaaa…1111', 1, 'a');
  insert.run('2026-10-24T00:00:00+01:00', '2026-10-25T00:00:00+01:00', '2026-10-24', 'deepseek-flash', 'sk-aaaaa…1111', 2, 'b');
  insert.run('2026-10-24T00:00:00+02:00', '2026-10-25T00:00:00+02:00', '2026-10-24', 'deepseek-flash', 'sk-bbbbb…2222', 3, 'b');
  insert.run('2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z', '2026-10-24', 'deepseek-flash', 'sk-bbbbb…2222', 4, 'c');
  assert.deepEqual(db.prepare(`SELECT key_fp, cost FROM deepseek_usage_actuals ORDER BY key_fp`).all(), [
    { key_fp: 'sk-aaaaa…1111', cost: 2 },
    { key_fp: 'sk-bbbbb…2222', cost: 4 },
  ]);
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(deepseekUsageActualsProblem(db), '');
});
