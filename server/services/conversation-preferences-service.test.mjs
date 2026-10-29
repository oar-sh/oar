import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { carryPlanOnlyToCompacted, persistConversationPreferences, readPlanOnly } from './conversation-preferences-service.mjs';

function createTestDb() {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

function seedConversation(db) {
  db.prepare(`
    INSERT INTO conversations (id, title, status, created_at, updated_at)
    VALUES ('conv-1', 'Demo', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
}

function readRow(db) {
  return db.prepare(`SELECT * FROM conversations WHERE id = 'conv-1'`).get();
}

test('the auto-compact window persists as a snapped token count', () => {
  const db = createTestDb();
  const stmts = createSessionRepository(db);
  seedConversation(db);

  const persisted = persistConversationPreferences({
    db,
    stmts,
    conversationId: 'conv-1',
    preferredRelayMode: 'agent',
    preferredModel: 'claude-opus-5',
    preferredReasoningEffort: 'high',
    autoCompactWindow: 148_000,
  });
  assert.equal(persisted.ok, true);
  assert.equal(persisted.autoCompactWindow, 150_000, 'off-stop values snap');
  assert.equal(readRow(db).auto_compact_window, 150_000);

  // null is a real value (Auto), not "leave it alone".
  const cleared = persistConversationPreferences({
    db,
    stmts,
    conversationId: 'conv-1',
    preferredRelayMode: 'agent',
    preferredModel: 'claude-opus-5',
    preferredReasoningEffort: 'high',
    autoCompactWindow: null,
  });
  assert.equal(cleared.autoCompactWindow, null);
  assert.equal(readRow(db).auto_compact_window, null);
});

test('a write that never mentions the window leaves it stored and echoes it', () => {
  const db = createTestDb();
  const stmts = createSessionRepository(db);
  seedConversation(db);

  persistConversationPreferences({
    db,
    stmts,
    conversationId: 'conv-1',
    preferredRelayMode: 'agent',
    preferredModel: 'claude-opus-5',
    preferredReasoningEffort: 'high',
    autoCompactWindow: 200_000,
  });

  // The composer's own preference write goes through this same function.
  const composerWrite = persistConversationPreferences({
    db,
    stmts,
    conversationId: 'conv-1',
    preferredRelayMode: 'plan',
    preferredModel: 'claude-sonnet-5',
    preferredReasoningEffort: 'medium',
  });
  assert.equal(composerWrite.autoCompactWindow, 200_000, 'echoed, not cleared');
  const row = readRow(db);
  assert.equal(row.auto_compact_window, 200_000);
  assert.equal(row.preferred_model, 'claude-sonnet-5');
  assert.equal(row.preferred_relay_mode, 'plan');
});

test('planOnly is written only when mentioned and echoed either way', () => {
  const db = createTestDb();
  seedConversation(db);
  const stmts = createSessionRepository(db);
  const base = { db, stmts, conversationId: 'conv-1', preferredRelayMode: 'plan', preferredModel: 'model-a' };
  assert.equal(persistConversationPreferences({ ...base }).planOnly, false);
  assert.equal(persistConversationPreferences({ ...base, planOnly: true }).planOnly, true);
  assert.equal(readPlanOnly(stmts.getConvAnyStatus.get('conv-1')), true);
  // A write that does not mention it (the composer) leaves it alone.
  assert.equal(persistConversationPreferences({ ...base, preferredRelayMode: 'agent' }).planOnly, true);
  assert.equal(persistConversationPreferences({ ...base, planOnly: false }).planOnly, false);
  assert.equal(stmts.getConvAnyStatus.get('conv-1').plan_only, 0);
});

test('a compaction keeps a plan-only source\'s lock and saved mode; nothing for another source', () => {
  const db = createTestDb();
  seedConversation(db);
  const stmts = createSessionRepository(db);
  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-2', 'Demo (compacted)', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`UPDATE conversations SET plan_only = 1, preferred_relay_mode = 'plan' WHERE id = 'conv-1'`).run();
  assert.equal(carryPlanOnlyToCompacted({ db, stmts, source: stmts.getConvAnyStatus.get('conv-1'), targetConversationId: 'conv-2' }), true);
  const target = stmts.getConvAnyStatus.get('conv-2');
  assert.equal(target.plan_only, 1);
  assert.equal(target.preferred_relay_mode, 'plan');

  db.prepare(`INSERT INTO conversations (id, title, status, created_at, updated_at) VALUES ('conv-3', 'Other', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  db.prepare(`UPDATE conversations SET plan_only = NULL, preferred_relay_mode = 'agent' WHERE id = 'conv-2'`).run();
  assert.equal(carryPlanOnlyToCompacted({ db, stmts, source: stmts.getConvAnyStatus.get('conv-2'), targetConversationId: 'conv-3' }), false);
  assert.equal(stmts.getConvAnyStatus.get('conv-3').plan_only, null);
});