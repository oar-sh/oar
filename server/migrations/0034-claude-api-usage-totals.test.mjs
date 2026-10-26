import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  CLAUDE_API_USAGE_TOTALS_COLUMNS,
  claudeApiUsageTotalsProblem,
  migrateClaudeApiUsageTotals,
} from './0034-claude-api-usage-totals.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('creates the table once, with one row per day and model', () => {
  const db = new Database(':memory:');
  assert.equal(claudeApiUsageTotalsProblem(db), 'no claude_api_usage_totals table');
  assert.deepEqual(migrateClaudeApiUsageTotals(db), { applied: true, tablesAdded: 1 });
  assert.deepEqual(columns(db, 'claude_api_usage_totals'), [...CLAUDE_API_USAGE_TOTALS_COLUMNS]);
  assert.equal(claudeApiUsageTotalsProblem(db), '');
  const insert = db.prepare(`
    INSERT INTO claude_api_usage_totals (day, model, first_seen_at, last_seen_at, updated_at)
    VALUES (?, ?, 'a', 'a', 'a')
  `);
  insert.run('2026-10-31', 'claude-sonnet-5-5');
  insert.run('2026-11-01', 'claude-sonnet-5-5');
  assert.throws(() => insert.run('2026-11-01', 'claude-sonnet-5-5'), /UNIQUE/);
  const row = db.prepare(`SELECT cost_usd, unknown_cost_tokens, turn_count FROM claude_api_usage_totals LIMIT 1`).get();
  assert.deepEqual({ ...row }, { cost_usd: 0, unknown_cost_tokens: 0, turn_count: 0 });
  assert.deepEqual(migrateClaudeApiUsageTotals(db), { applied: false, tablesAdded: 0 });
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(claudeApiUsageTotalsProblem(db), '');
});
