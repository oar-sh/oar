import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { dequeuePendingMessage } from '../routes/messages-routes.mjs';
import { createSessionRepository } from './session-repository.mjs';
import { createMessageRepository, QUEUE_ROW_SESSION_SQL } from './message-repository.mjs';
import { createQuestionRepository } from './question-repository.mjs';
import { applySchema } from '../db-schema.mjs';

// A queue row with no owner anywhere: no owner_sdk_session_id, no session id
// on its runtime session, none on its conversation. Such a row belongs to the
// session named like its conversation, the id a worker of a chat that was
// never bound runs under. It is found by the waker under that id and claimed
// by that worker only, never by another conversation's.

const NOW = '2026-03-01T00:00:00.000Z';
const LATER = '2026-03-01T01:00:00.000Z';
const ORPHAN = 'conv-ownerless-5e2a';
const OTHER = 'conv-bound-9c41';
const OTHER_SESSION = 'sess-bound-9c41';

function boot({ orphanProvider = null } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const conversation = db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at) VALUES (?, 'Ownerless', ?, 'active', ?, ?)`);
  conversation.run(ORPHAN, null, NOW, NOW);
  conversation.run(OTHER, OTHER_SESSION, NOW, NOW);
  const runtime = db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, provider_type, created_at, last_used_at) VALUES (?, ?, ?, 'rk', ?, ?, ?)`);
  if (orphanProvider) runtime.run('rs-ownerless', ORPHAN, null, orphanProvider, NOW, NOW);
  // The other conversation is a Claude chat: its worker states kind "claude".
  runtime.run('rs-bound', OTHER, OTHER_SESSION, 'claude', NOW, NOW);
  db.prepare(`INSERT INTO queue (id, conversation_id, runtime_session_id, text, status, timestamp) VALUES ('q-ownerless', ?, ?, 'follow-up', 'pending', ?)`)
    .run(ORPHAN, orphanProvider ? 'rs-ownerless' : null, NOW);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const claimAs = (sessionId, workerKind = null) => dequeuePendingMessage({
    db, stmts, nowIso: LATER, requesterSessionId: sessionId, workerKind,
  })?.id || null;
  const row = () => stmts.findQById.get('q-ownerless');
  const waiting = () => stmts.listPendingWorkerOwnerSessionIds.all(25).map((entry) => entry.sdk_session_id);
  return { db, stmts, claimAs, row, waiting };
}

for (const orphanProvider of [null, 'github', 'openai']) {
  const label = orphanProvider ? `a ${orphanProvider} runtime session` : 'no runtime session';
  test(`(a) an ownerless row with ${label} is not claimed by another conversation's worker`, () => {
    const fx = boot({ orphanProvider });
    assert.equal(fx.claimAs(OTHER_SESSION, 'claude'), null, 'not by a Claude worker of another chat');
    assert.equal(fx.claimAs(OTHER_SESSION), null, 'nor by one that states no kind');
    assert.equal(fx.row().status, 'pending');
    assert.equal(fx.row().owner_sdk_session_id, null);
  });

  test(`(a) an ownerless row with ${label} goes to its own conversation's worker`, () => {
    const fx = boot({ orphanProvider });
    assert.deepEqual(fx.waiting(), [ORPHAN], 'the waker finds it under the conversation id');
    assert.equal(fx.claimAs(ORPHAN), 'q-ownerless');
    assert.equal(fx.row().status, 'processing');
    assert.equal(fx.row().owner_sdk_session_id, ORPHAN);
  });
}

for (const orphanProvider of ['claude', 'cursor', 'grok', 'deepseek', 'claude-api']) {
  test(`(b) an ownerless ${orphanProvider} row is found by the waker and claimed by its own conversation's worker`, () => {
    const fx = boot({ orphanProvider });
    assert.deepEqual(fx.waiting(), [ORPHAN]);
    assert.equal(fx.claimAs(OTHER_SESSION, 'claude'), null, 'never by another chat\'s worker');
    const kind = orphanProvider === 'claude' || orphanProvider === 'claude-api' ? orphanProvider : null;
    assert.equal(fx.claimAs(ORPHAN, kind), 'q-ownerless');
    assert.equal(fx.row().owner_sdk_session_id, ORPHAN);
  });
}

test('the claim, the waker and the Claude API listing read one owner expression', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const repository = createMessageRepository(db);
  for (const name of ['findPendingForWorker', 'listPendingWorkerOwnerSessionIds', 'listPendingClaudeApiRowsForSession']) {
    assert.ok(repository[name].source.includes(QUEUE_ROW_SESSION_SQL), name);
  }
  assert.ok(QUEUE_ROW_SESSION_SQL.endsWith(', q.conversation_id)'), 'the conversation id is the last fallback');
});

test('an owner, a runtime session or a conversation session still wins over the conversation id', () => {
  const fx = boot({ orphanProvider: 'github' });
  fx.db.prepare(`UPDATE queue SET owner_sdk_session_id = 'sess-owner-1f3d' WHERE id = 'q-ownerless'`).run();
  assert.deepEqual(fx.waiting(), ['sess-owner-1f3d']);
  assert.equal(fx.claimAs(ORPHAN), null);
  assert.equal(fx.claimAs('sess-owner-1f3d'), 'q-ownerless');
});

test('a chat bound after its row was queued: the row goes to the bound session, not to a worker under the conversation id', () => {
  for (const bind of [
    (db) => db.prepare(`UPDATE conversations SET sdk_session_id = 'sess-late-7b20' WHERE id = ?`).run(ORPHAN),
    (db) => db.prepare(`UPDATE runtime_sessions SET sdk_session_id = 'sess-late-7b20' WHERE id = 'rs-ownerless'`).run(),
  ]) {
    const fx = boot({ orphanProvider: 'claude' });
    assert.deepEqual(fx.waiting(), [ORPHAN], 'before the binding');
    bind(fx.db);
    assert.deepEqual(fx.waiting(), ['sess-late-7b20']);
    assert.equal(fx.claimAs(ORPHAN, 'claude'), null);
    assert.equal(fx.claimAs('sess-late-7b20', 'claude'), 'q-ownerless');
  }
});

test('a conversation that is gone launches no worker for its rows', () => {
  const deleted = boot({ orphanProvider: 'github' });
  // Delete marks the conversation, stops its worker, then removes it with
  // its queue rows (sessions-routes, hardDeleteConversationRows).
  deleted.db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id = ?`).run(ORPHAN);
  assert.deepEqual(deleted.waiting(), []);

  const removed = boot({ orphanProvider: 'github' });
  // The queue has no foreign key to conversations: a row can outlive its chat.
  removed.db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`).run(ORPHAN);
  removed.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(ORPHAN);
  assert.equal(removed.row().status, 'pending');
  assert.deepEqual(removed.waiting(), []);
  assert.equal(removed.claimAs(OTHER_SESSION, 'claude'), null, 'and no other worker takes it');
});

test('an ownerless row held at the usage limit waits, then goes to its own worker', () => {
  const fx = boot({ orphanProvider: 'claude' });
  const resetAt = '2999-01-01T00:00:00.000Z';
  fx.db.prepare(`UPDATE queue SET usage_limit_pause = '{}', next_attempt_at = ? WHERE id = 'q-ownerless'`).run(resetAt);
  assert.deepEqual(fx.waiting(), [], 'a held row keeps no worker warm');
  assert.equal(fx.claimAs(ORPHAN, 'claude'), null);
  fx.db.prepare(`UPDATE queue SET usage_limit_pause = NULL, next_attempt_at = NULL WHERE id = 'q-ownerless'`).run();
  assert.equal(fx.claimAs(ORPHAN, 'claude'), 'q-ownerless');
});

test('an ownerless row keeps the plan-boundary hold of its conversation', () => {
  const fx = boot({ orphanProvider: 'claude' });
  fx.db.prepare(`INSERT INTO queue (id, conversation_id, runtime_session_id, text, relay_mode, status, timestamp, processing_at, owner_sdk_session_id) VALUES ('q-plan-live', ?, 'rs-ownerless', 'plan', 'plan', 'processing', ?, ?, ?)`)
    .run(ORPHAN, '2026-02-28T23:00:00.000Z', '2026-02-28T23:00:00.000Z', ORPHAN);
  assert.equal(fx.claimAs(ORPHAN, 'claude'), null, 'an agent row waits for the live plan turn');
  fx.stmts.setDone.run('{}', 'q-plan-live');
  assert.equal(fx.claimAs(ORPHAN, 'claude'), 'q-ownerless');
});

test('an ownerless Claude API row passes the billing fence only for its own conversation\'s worker of its billing', () => {
  const fx = boot({ orphanProvider: 'claude-api' });
  const fenced = [];
  const claim = (sessionId, workerKind, claudeApiClaimCheck = null) => dequeuePendingMessage({
    db: fx.db, stmts: fx.stmts, nowIso: LATER, requesterSessionId: sessionId, workerKind, claudeApiClaimCheck,
    onBillingFence: (fence) => fenced.push(fence),
  })?.id || null;
  assert.equal(claim(OTHER_SESSION, 'claude-api'), null, 'not another chat\'s Claude API worker');
  assert.deepEqual(fenced, [], 'which never reaches the fence: the row is not its');
  assert.equal(claim(ORPHAN, 'claude'), null, 'not its own chat\'s subscription worker');
  assert.equal(fenced.at(-1)?.reason, 'kind-mismatch');
  const refusal = { code: 'CLAUDE_API_CAP_REACHED', error: 'The monthly cap is reached.' };
  assert.equal(claim(ORPHAN, 'claude-api', () => refusal), null, 'nor while Claude API cannot run a turn');
  assert.equal(fenced.at(-1)?.reason, 'claude-api-unavailable');
  assert.deepEqual(fx.stmts.listPendingClaudeApiRowsForSession.all(ORPHAN, 'claude-api').map((row) => row.id), ['q-ownerless'],
    'the launch-free fail-closed path finds it under the conversation id');
  assert.deepEqual(fx.stmts.listPendingClaudeApiRowsForSession.all(OTHER_SESSION, 'claude-api'), []);
  assert.equal(claim(ORPHAN, 'claude-api'), 'q-ownerless');
});

test('rows already in the database at upgrade: owned rows keep their owner, ownerless ones go to their conversation', () => {
  const fx = boot({ orphanProvider: 'github' });
  // An older row owned by the other chat's session, as earlier versions wrote it.
  fx.db.prepare(`INSERT INTO queue (id, conversation_id, runtime_session_id, text, status, timestamp, owner_sdk_session_id) VALUES ('q-owned-old', ?, 'rs-bound', 'old', 'pending', ?, ?)`)
    .run(OTHER, '2026-02-01T00:00:00.000Z', OTHER_SESSION);
  assert.deepEqual(fx.waiting().sort(), [ORPHAN, OTHER_SESSION].sort());
  assert.equal(fx.claimAs(OTHER_SESSION, 'claude'), 'q-owned-old');
  assert.equal(fx.claimAs(OTHER_SESSION, 'claude'), null, 'and nothing of the ownerless chat after it');
  assert.equal(fx.claimAs(ORPHAN), 'q-ownerless');
});
