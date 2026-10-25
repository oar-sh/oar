import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  DEEPSEEK_USAGE_CHECKPOINT_RUN_COLUMNS,
  deepseekUsageCheckpointRunsProblem,
  migrateDeepSeekUsageCheckpointRuns,
} from './0027-deepseek-usage-checkpoint-runs.mjs';
import { DEEPSEEK_USAGE_CHECKPOINT_COLUMNS, migrateDeepSeekUsageTotals } from './0024-deepseek-usage-totals.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the three columns once, on top of 0024', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageTotals(db);
  assert.equal(deepseekUsageCheckpointRunsProblem(db), 'deepseek_usage_checkpoints lacks run_id, search_requests, fetch_requests');
  assert.deepEqual(migrateDeepSeekUsageCheckpointRuns(db), { applied: true, columnsAdded: 3 });
  assert.deepEqual(columns(db, 'deepseek_usage_checkpoints'), [
    ...DEEPSEEK_USAGE_CHECKPOINT_COLUMNS,
    ...DEEPSEEK_USAGE_CHECKPOINT_RUN_COLUMNS.map(([name]) => name),
  ]);
  assert.equal(deepseekUsageCheckpointRunsProblem(db), '');
  assert.deepEqual(migrateDeepSeekUsageCheckpointRuns(db), { applied: false, columnsAdded: 0 });
});

test('a database without 0024 gets both; an existing checkpoint has no run id and zero requests', () => {
  const db = new Database(':memory:');
  assert.equal(deepseekUsageCheckpointRunsProblem(db), 'no deepseek_usage_checkpoints table');
  migrateDeepSeekUsageTotals(db);
  const at = '2026-10-24T12:00:00.000Z';
  db.prepare(`
    INSERT INTO deepseek_usage_checkpoints (conversation_id, native_session_id, model, hit_tokens, miss_tokens, output_tokens, updated_at)
    VALUES ('conv-ds', 'native-1', 'deepseek-flash', 10, 20, 30, ?)
  `).run(at);
  assert.deepEqual(migrateDeepSeekUsageCheckpointRuns(db), { applied: true, columnsAdded: 3 });
  const row = db.prepare(`SELECT * FROM deepseek_usage_checkpoints`).get();
  assert.deepEqual(
    { runId: row.run_id, search: row.search_requests, fetch: row.fetch_requests, miss: row.miss_tokens },
    { runId: '', search: 0, fetch: 0, miss: 20 },
  );
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(deepseekUsageCheckpointRunsProblem(db), '');
});
