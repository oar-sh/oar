import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { mapRelayActivityRow, mapRelayThoughtRow, sanitizeActivityText } from '../repositories/relay-turn-rows.mjs';
import { normalizeRelayThoughtList } from '../public/app/relay-thoughts.mjs';
import { applySchema } from '../db-schema.mjs';
import { makeRouteDeps as baseRouteDeps, postHandler } from './messages-routes-test-harness.mjs';

// The order of a turn (migration 0038) through the worker routes: POST
// /api/activity and the insert of POST /api/thought give the next number,
// a thought update keeps its own, both socket events carry it, and the rows
// read back into the payload with it.

const NOW = '2026-01-01T00:00:00.000Z';

function makeDb() {
  const db = new Database(':memory:');
  applySchema(db);
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Widget cache plan', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO queue (id, conversation_id, text, timestamp) VALUES ('q-1', 'conv-1', 'prompt', ?)`).run(NOW);
  return db;
}

function makeDeps(db, emitted, stmtsOverride = {}) {
  return baseRouteDeps({
    db,
    stmts: {
      ...createQuestionRepository(db),
      findQById: db.prepare(`SELECT * FROM queue WHERE id = ?`),
      ...stmtsOverride,
    },
    io: {
      emit: (event, payload) => emitted.push({ event, payload }),
      volatile: { emit: (event, payload) => emitted.push({ event, payload, volatile: true }) },
    },
    DEFAULT_RELAY_MODE: 'agent',
    sanitizeActivityText,
  });
}

test('thoughts and tool lines share one order; an update keeps it; both events carry it', async () => {
  const db = makeDb();
  const emitted = [];
  const deps = makeDeps(db, emitted);
  const thought = postHandler('/api/thought', deps);
  const activity = postHandler('/api/activity', deps);
  const base = { messageId: 'q-1', conversationId: 'conv-1', mode: 'agent' };

  assert.equal((await thought({ ...base, reasoningId: 'r-1', text: 'The widget cache needs a cap' })).status, 200);
  assert.equal((await activity({ ...base, text: 'Tool (view): cache.js' })).status, 200);
  assert.equal((await thought({ ...base, reasoningId: 'r-1', text: 'The widget cache needs a cap first.', done: true })).status, 200);
  assert.equal((await thought({ ...base, reasoningId: 'r-2', text: 'Now the eviction' })).status, 200);
  assert.equal((await activity({ ...base, text: 'Tool (grep): evict', subagentRunId: 'toolu_fixture_sub' })).status, 200);
  assert.equal((await activity({ ...base, text: 'Tool (view): cache.js' })).status, 200);

  const events = emitted.filter((entry) => entry.event === 'relay_thought' || entry.event === 'relay_activity')
    .map(({ event, payload }) => [event, payload.reasoningId || payload.text, payload.turnSeq]);
  assert.deepEqual(events, [
    ['relay_thought', 'r-1', 1],
    ['relay_activity', 'Tool (view): cache.js', 2],
    ['relay_thought', 'r-1', 1],
    ['relay_thought', 'r-2', 3],
    ['relay_activity', 'Tool (grep): evict', 4],
    ['relay_activity', 'Tool (view): cache.js', 5],
  ]);

  // The payload (server-runtime maps the rows with these).
  const activities = createQuestionRepository(db).listActivityByQueueMessage.all('q-1').map(mapRelayActivityRow);
  assert.deepEqual(activities, [
    { text: 'Tool (view): cache.js', subagentRunId: null, turnSeq: 2 },
    { text: 'Tool (grep): evict', subagentRunId: 'toolu_fixture_sub', turnSeq: 4 },
    { text: 'Tool (view): cache.js', subagentRunId: null, turnSeq: 5 },
  ]);
  const thoughts = normalizeRelayThoughtList(createQuestionRepository(db).listThoughtsByQueueMessage.all('q-1').map(mapRelayThoughtRow));
  assert.deepEqual(thoughts.map((entry) => [entry.reasoningId, entry.turnSeq, entry.done]), [['r-1', 1, true], ['r-2', 3, false]]);
});

test('an unnumbered row (old, or a database without the column) reads as before: no turnSeq key', () => {
  assert.deepEqual(mapRelayActivityRow({ text: 'Tool (view): a.js', subagent_run_id: null, metadata_json: null, turn_seq: null }), { text: 'Tool (view): a.js', subagentRunId: null });
  assert.deepEqual(mapRelayActivityRow({ text: 'Tool (view): a.js', subagent_run_id: null, metadata_json: null }), { text: 'Tool (view): a.js', subagentRunId: null });
  assert.equal('turnSeq' in mapRelayThoughtRow({ reasoning_id: 'r', seq: 1, text: 'x', done: 0, created_at: NOW }), false);
});

test('a database without the column: the routes work, and no event carries a turnSeq', async () => {
  const db = makeDb();
  for (const table of ['relay_activity', 'relay_thought']) {
    db.exec(`DROP INDEX idx_${table}_queue_turn_seq`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN turn_seq`);
  }
  const emitted = [];
  const deps = makeDeps(db, emitted);
  const base = { messageId: 'q-1', conversationId: 'conv-1', mode: 'agent' };
  assert.equal((await postHandler('/api/thought', deps)({ ...base, reasoningId: 'r-1', text: 'Thinking' })).status, 200);
  assert.equal((await postHandler('/api/thought', deps)({ ...base, reasoningId: 'r-1', text: 'Thinking more' })).status, 200);
  assert.equal((await postHandler('/api/activity', deps)({ ...base, text: 'Tool (view): a.js' })).status, 200);
  for (const { payload } of emitted.filter((entry) => entry.event === 'relay_thought' || entry.event === 'relay_activity')) {
    assert.equal('turnSeq' in payload, false);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_activity`).get().n, 1);
});
