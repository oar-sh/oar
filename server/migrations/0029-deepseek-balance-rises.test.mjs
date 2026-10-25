import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { deepseekBalanceRisesProblem, migrateDeepSeekBalanceRises } from './0029-deepseek-balance-rises.mjs';
import { migrateDeepSeekUsageRequestsDaily } from './0025-deepseek-usage-requests-daily.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db) => db.prepare(`PRAGMA table_info(deepseek_balance_reference)`).all().map((column) => column.name);

test('adds rose_at, last_read_at and rose_from_at once, on top of 0025; an existing reference has seen no rise', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageRequestsDaily(db);
  db.prepare(`INSERT INTO deepseek_balance_reference (currency, reference_total, last_total, reference_at, updated_at) VALUES ('CNY', 50, 45, ?, ?)`)
    .run('2026-10-25T08:00:00.000Z', '2026-10-25T08:00:00.000Z');
  assert.equal(deepseekBalanceRisesProblem(db), 'deepseek_balance_reference lacks rose_at, last_read_at, rose_from_at');
  assert.deepEqual(migrateDeepSeekBalanceRises(db), { applied: true, columnsAdded: 3 });
  assert.deepEqual(columns(db), ['currency', 'reference_total', 'last_total', 'reference_at', 'updated_at', 'rose_at', 'last_read_at', 'rose_from_at']);
  assert.deepEqual(
    db.prepare(`SELECT rose_at, last_read_at, rose_from_at FROM deepseek_balance_reference`).get(),
    { rose_at: null, last_read_at: null, rose_from_at: null },
  );
  assert.equal(deepseekBalanceRisesProblem(db), '');
  assert.deepEqual(migrateDeepSeekBalanceRises(db), { applied: false, columnsAdded: 0 });
});

test('a table with only rose_at (an earlier 0029) gets the other two', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageRequestsDaily(db);
  db.exec(`ALTER TABLE deepseek_balance_reference ADD COLUMN rose_at TEXT`);
  assert.equal(deepseekBalanceRisesProblem(db), 'deepseek_balance_reference lacks last_read_at, rose_from_at');
  assert.deepEqual(migrateDeepSeekBalanceRises(db), { applied: true, columnsAdded: 2 });
  assert.equal(deepseekBalanceRisesProblem(db), '');
});

test('a database without 0025 gets the table first; the boot schema has the column', () => {
  const bare = new Database(':memory:');
  assert.equal(deepseekBalanceRisesProblem(bare), 'no deepseek_balance_reference table');
  assert.equal(migrateDeepSeekBalanceRises(bare).applied, true);
  assert.equal(deepseekBalanceRisesProblem(bare), '');
  const booted = new Database(':memory:');
  applySchema(booted);
  assert.equal(deepseekBalanceRisesProblem(booted), '');
});
