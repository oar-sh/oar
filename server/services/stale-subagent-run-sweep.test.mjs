import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { STALE_SUBAGENT_RUN_MIN_AGE_MS, createStaleSubagentRunSweep } from './stale-subagent-run-sweep.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const GONE = 'conv-fixture-gone';
const LIVE = 'conv-fixture-live';

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const at = new Date(T0 - 90 * DAY_MS).toISOString();
  for (const id of [GONE, LIVE]) {
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, id, at, at);
  }
  return db;
}

function seedRun(db, { id, conversationId, status = 'running', ageMs, background = 1, completedAt = null }) {
  const at = new Date(T0 - ageMs).toISOString();
  db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, completed_at, background)
    VALUES (?, 'q-fixture', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, id, status, at, at, completedAt, background);
}

function runRow(db, id) {
  return db.prepare(`SELECT status, updated_at, completed_at FROM subagent_runs WHERE id = ?`).get(id);
}

test('old running runs of a conversation without a live worker are closed; the rest are left alone', () => {
  const db = setup();
  seedRun(db, { id: 'run_fixture_old_gone', conversationId: GONE, ageMs: 60 * DAY_MS });
  seedRun(db, { id: 'run_fixture_old_live', conversationId: LIVE, ageMs: 60 * DAY_MS });
  seedRun(db, { id: 'run_fixture_fresh_gone', conversationId: GONE, ageMs: STALE_SUBAGENT_RUN_MIN_AGE_MS - 60_000 });
  seedRun(db, { id: 'run_fixture_done_gone', conversationId: GONE, status: 'completed', ageMs: 60 * DAY_MS, completedAt: new Date(T0 - 60 * DAY_MS).toISOString() });
  const asked = [];
  const lines = [];
  const sweep = createStaleSubagentRunSweep({
    db,
    now: () => T0,
    isConversationWorkerAlive: (conversationId) => { asked.push(conversationId); return conversationId === LIVE; },
    log: (line) => lines.push(line),
  });

  const result = sweep.sweep();

  assert.deepEqual({ checked: result.checked, closed: result.closed, conversations: result.conversations }, { checked: 2, closed: 1, conversations: 1 });
  const closed = runRow(db, 'run_fixture_old_gone');
  assert.equal(closed.status, 'cancelled');
  assert.equal(closed.updated_at, new Date(T0).toISOString());
  assert.equal(closed.completed_at, new Date(T0).toISOString());
  assert.equal(runRow(db, 'run_fixture_old_live').status, 'running', 'a live worker keeps its long run');
  assert.equal(runRow(db, 'run_fixture_fresh_gone').status, 'running', 'a run younger than the bound is not touched');
  assert.equal(runRow(db, 'run_fixture_done_gone').status, 'completed');
  assert.deepEqual([...new Set(asked)].sort(), [GONE, LIVE], 'liveness is asked once per conversation');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /closed 1 run still marked running in 1 conversation without a live worker/);
});

test('a sweep with nothing old is silent and does not ask about workers', () => {
  const db = setup();
  seedRun(db, { id: 'run_fixture_young', conversationId: GONE, ageMs: 1_000 });
  const asked = [];
  const lines = [];
  const sweep = createStaleSubagentRunSweep({
    db,
    now: () => T0,
    isConversationWorkerAlive: (conversationId) => { asked.push(conversationId); return false; },
    log: (line) => lines.push(line),
  });
  assert.deepEqual(sweep.sweep(), { checked: 0, closed: 0, conversations: 0 });
  assert.deepEqual(asked, []);
  assert.deepEqual(lines, []);
});

test('a liveness check that throws counts as no live worker, and a second sweep finds nothing left', () => {
  const db = setup();
  seedRun(db, { id: 'run_fixture_throw', conversationId: GONE, ageMs: 2 * DAY_MS });
  const sweep = createStaleSubagentRunSweep({
    db,
    now: () => T0,
    isConversationWorkerAlive: () => { throw new Error('registry gone'); },
    log: () => {},
  });
  assert.equal(sweep.sweep().closed, 1);
  assert.equal(runRow(db, 'run_fixture_throw').status, 'cancelled');
  assert.equal(sweep.sweep().closed, 0);
});
