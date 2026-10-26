import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  CLAUDE_API_USAGE_CHECKPOINT_COLUMNS,
  claudeApiUsageCheckpointsProblem,
  migrateClaudeApiUsageCheckpoints,
} from './0033-claude-api-usage-checkpoints.mjs';
import { applySchema } from '../db-schema.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('creates the table once, with one row per conversation, session, run and model', () => {
  const db = new Database(':memory:');
  assert.equal(claudeApiUsageCheckpointsProblem(db), 'no claude_api_usage_checkpoints table');
  assert.deepEqual(migrateClaudeApiUsageCheckpoints(db), { applied: true, tablesAdded: 1 });
  assert.deepEqual(columns(db, 'claude_api_usage_checkpoints'), [...CLAUDE_API_USAGE_CHECKPOINT_COLUMNS]);
  assert.equal(claudeApiUsageCheckpointsProblem(db), '');
  const insert = db.prepare(`
    INSERT INTO claude_api_usage_checkpoints (conversation_id, native_session_id, run_id, model, billing, updated_at)
    VALUES (?, ?, ?, ?, ?, '2026-10-25T12:00:00.000Z')
  `);
  insert.run('conv-1', 'native-1', 'run-a', 'claude-sonnet-5-5', 'claude');
  insert.run('conv-1', 'native-1', 'run-b', 'claude-sonnet-5-5', 'claude-api');
  assert.throws(() => insert.run('conv-1', 'native-1', 'run-b', 'claude-sonnet-5-5', 'claude-api'), /UNIQUE/);
  const indexes = db.prepare(`PRAGMA index_list(claude_api_usage_checkpoints)`).all().map((index) => index.name);
  assert.ok(indexes.includes('idx_claude_api_usage_checkpoints_mark'));
  assert.deepEqual(migrateClaudeApiUsageCheckpoints(db), { applied: false, tablesAdded: 0 });
});

test('the schema boot applies the migration', () => {
  const db = new Database(':memory:');
  applySchema(db);
  assert.equal(claudeApiUsageCheckpointsProblem(db), '');
});
