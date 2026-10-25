import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  DEEPSEEK_USAGE_CHECKPOINT_REQUEST_RUN_COLUMNS,
  deepseekUsageCheckpointRequestRunsProblem,
  migrateDeepSeekUsageCheckpointRequestRuns,
} from './0028-deepseek-usage-checkpoint-request-runs.mjs';
import { DEEPSEEK_USAGE_CHECKPOINT_RUN_COLUMNS, migrateDeepSeekUsageCheckpointRuns } from './0027-deepseek-usage-checkpoint-runs.mjs';
import { DEEPSEEK_USAGE_CHECKPOINT_COLUMNS, migrateDeepSeekUsageTotals } from './0024-deepseek-usage-totals.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('adds the column once, on top of 0027', () => {
  const db = new Database(':memory:');
  migrateDeepSeekUsageCheckpointRuns(db);
  assert.equal(deepseekUsageCheckpointRequestRunsProblem(db), 'deepseek_usage_checkpoints lacks request_run_id');
  assert.deepEqual(migrateDeepSeekUsageCheckpointRequestRuns(db), { applied: true, columnsAdded: 1 });
  assert.deepEqual(columns(db, 'deepseek_usage_checkpoints'), [
    ...DEEPSEEK_USAGE_CHECKPOINT_COLUMNS,
    ...DEEPSEEK_USAGE_CHECKPOINT_RUN_COLUMNS.map(([name]) => name),
    ...DEEPSEEK_USAGE_CHECKPOINT_REQUEST_RUN_COLUMNS.map(([name]) => name),
  ]);
  assert.equal(deepseekUsageCheckpointRequestRunsProblem(db), '');
  assert.deepEqual(migrateDeepSeekUsageCheckpointRequestRuns(db), { applied: false, columnsAdded: 0 });
});

test('a database without 0024 and 0027 gets all three; an existing checkpoint has no request run id', () => {
  const db = new Database(':memory:');
  assert.equal(deepseekUsageCheckpointRequestRunsProblem(db), 'no deepseek_usage_checkpoints table');
  migrateDeepSeekUsageTotals(db);
  const at = '2026-10-25T12:00:00.000Z';
  db.prepare(`
    INSERT INTO deepseek_usage_checkpoints (conversation_id, native_session_id, model, hit_tokens, miss_tokens, output_tokens, updated_at)
    VALUES ('conv-ds', 'native-1', 'deepseek-flash', 10, 20, 30, ?)
  `).run(at);
  assert.deepEqual(migrateDeepSeekUsageCheckpointRequestRuns(db), { applied: true, columnsAdded: 1 });
  const row = db.prepare(`SELECT * FROM deepseek_usage_checkpoints`).get();
  assert.deepEqual(
    { runId: row.run_id, requestRunId: row.request_run_id, search: row.search_requests, miss: row.miss_tokens },
    { runId: '', requestRunId: '', search: 0, miss: 20 },
  );
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(deepseekUsageCheckpointRequestRunsProblem(db), '');
});
