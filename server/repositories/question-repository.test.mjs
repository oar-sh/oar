import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createQuestionRepository } from './question-repository.mjs';

function makeDb() {
  // Production schema, not a hand-rolled copy: the local DDL this replaced had
  // already drifted twice (subagent_run_id, then metadata_json).
  const db = new Database(':memory:');
  applySchema(db);
  // relay_* tables carry a foreign key to conversations in the real schema,
  // which the hand-rolled DDL did not, so the fixture parent row is required.
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Conversation conv-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run();
  const queueRow = db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, 'conv-1', 'seed', 'done', '2026-01-01T00:00:00Z')`);
  for (const id of ['queue-1', 'queue-2', 'queue-3', 'queue-4']) queueRow.run(id);
  return db;
}

test('cancelPendingQuestionsByMessage only closes pending rows for the target message', () => {
  const db = makeDb();
  const repo = createQuestionRepository(db);
  db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, status, created_at, expires_at)
    VALUES
      ('q-pending-1', 'queue-1', 'conv-1', 'msg-1', 'agent', 'First', 'pending', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z'),
      ('q-pending-2', 'queue-2', 'conv-1', 'msg-1', 'agent', 'Second', 'pending', '2026-01-01T00:01:00Z', '2026-01-01T01:01:00Z'),
      ('q-answered', 'queue-3', 'conv-1', 'msg-1', 'agent', 'Done', 'answered', '2026-01-01T00:02:00Z', '2026-01-01T01:02:00Z'),
      ('q-other', 'queue-4', 'conv-1', 'msg-2', 'agent', 'Other', 'pending', '2026-01-01T00:03:00Z', '2026-01-01T01:03:00Z')
  `).run();

  const result = repo.cancelPendingQuestionsByMessage.run('2026-01-01T02:00:00Z', 'msg-1');
  assert.equal(result.changes, 2);

  const rows = db.prepare(`
    SELECT id, status, answered_at
    FROM relay_questions
    ORDER BY id
  `).all();

  assert.deepEqual(rows, [
    { id: 'q-answered', status: 'answered', answered_at: null },
    { id: 'q-other', status: 'pending', answered_at: null },
    { id: 'q-pending-1', status: 'cancelled', answered_at: '2026-01-01T02:00:00Z' },
    { id: 'q-pending-2', status: 'cancelled', answered_at: '2026-01-01T02:00:00Z' },
  ]);
});

test('updateThoughtByQueueAndReasoning updates snapshot without changing seq', () => {
  const db = makeDb();
  const repo = createQuestionRepository(db);
  repo.insertThought.run(
    'msg-1',
    null,
    'conv-1',
    'agent',
    'reason-1',
    1,
    'first',
    0,
    '2026-01-01T00:00:00Z',
    'sub-1',
  );

  const thoughtBefore = repo.getThoughtByQueueAndReasoning.get('msg-1', 'reason-1');
  assert.equal(Number(thoughtBefore?.seq || 0), 1);

  repo.updateThoughtByQueueAndReasoning.run(
    'resp-1',
    'conv-1',
    'agent',
    'second',
    1,
    '2026-01-01T00:00:01Z',
    null,
    'msg-1',
    'reason-1',
  );

  const row = db.prepare(`
    SELECT response_message_id, seq, text, done, created_at, subagent_run_id
    FROM relay_thought
    WHERE queue_message_id = 'msg-1' AND reasoning_id = 'reason-1'
  `).get();
  assert.deepEqual(row, {
    response_message_id: 'resp-1',
    seq: 1,
    text: 'second',
    done: 1,
    created_at: '2026-01-01T00:00:01Z',
    subagent_run_id: 'sub-1',
  });
});

test('preview cards: insert with queue id, link at finalize, list by response', () => {
  const db = makeDb();
  const repo = createQuestionRepository(db);

  const snapshot = { token: 'a'.repeat(32), label: 'app', url: 'https://p/x/' };
  repo.insertPreviewCard.run('pvc-1', 'queue-1', 'conv-1', JSON.stringify(snapshot), '2026-01-01T00:00:00Z');

  // Mid-turn: not yet visible under any response.
  assert.deepEqual(repo.listPreviewCardsByResponse.all('resp-1'), []);

  repo.linkPreviewCardsToResponse.run('resp-1', 'queue-1');
  const rows = repo.listPreviewCardsByResponse.all('resp-1');
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].preview_json), snapshot);

  // Linking is one-shot: a second finalize for the same queue id (retry path)
  // must not re-point already-linked cards.
  repo.linkPreviewCardsToResponse.run('resp-2', 'queue-1');
  assert.equal(repo.listPreviewCardsByResponse.all('resp-1').length, 1);
  assert.deepEqual(repo.listPreviewCardsByResponse.all('resp-2'), []);

  repo.deleteConvPreviewCards.run('conv-1');
  assert.deepEqual(repo.listPreviewCardsByResponse.all('resp-1'), []);
});
