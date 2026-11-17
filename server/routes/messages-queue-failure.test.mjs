import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createFailQueueMessageFromDeps } from './messages-queue-failure.mjs';

// failQueueMessage against the real schema: the push it sends, and the owner
// session's worker bookkeeping, by default and with the options that skip
// them. Ids are fictional.

const NOW = '2026-11-16T09:00:00.000Z';

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  const calls = [];
  const emitted = [];
  const workers = new Map([['sdk-worker', { sdkSessionId: 'sdk-worker', status: 'processing', pid: 4242, workerId: 'worker-1' }]]);
  const deps = {
    db,
    stmts,
    io: { emit: (event, payload) => emitted.push([event, payload]) },
    uuidv4: randomUUID,
    ts: () => NOW,
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    pushDispatchService: { notifyTurnFailed: (payload) => { calls.push(['push', payload.sourceMessageId]); return Promise.resolve(); } },
    relayEventService: { noteError: (payload) => calls.push(['relay-error', payload.queueMessageId]) },
    sessionWorkerRegistry: {
      getWorker: (sid) => workers.get(sid) || null,
      upsertWorker: (worker) => { calls.push(['registry-upsert', worker.sdkSessionId, worker.status]); workers.set(worker.sdkSessionId, worker); },
    },
    sessionWorkerSupervisor: {
      markError: (sid, reason) => calls.push(['mark-error', sid, reason]),
      markIdle: (sid) => calls.push(['mark-idle', sid]),
    },
  };
  db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('conv-1', 'Parser work', ?, ?)`).run(NOW, NOW);
  const claim = (id) => {
    db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, 'conv-1', 'user', 'refactor the parser', ?)`).run(id, NOW);
    db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, owner_sdk_session_id) VALUES (?, 'conv-1', 'refactor the parser', 'processing', ?, 'sdk-worker')`).run(id, NOW);
    return db.prepare(`SELECT * FROM queue WHERE id = ?`).get(id);
  };
  const log = [];
  const quiet = (fn) => {
    const original = console.log;
    console.log = (line) => log.push(String(line));
    try { return fn(); } finally { console.log = original; }
  };
  return { db, stmts, calls, emitted, claim, quiet, failQueueMessage: createFailQueueMessageFromDeps(deps) };
}

const fail = (fx, row, code, extra = {}) => fx.quiet(() => fx.failQueueMessage({
  queueRow: row,
  messageId: row.id,
  conversationId: 'conv-1',
  relayMode: 'agent',
  model: null,
  responseText: `failed: ${code}`,
  failureRecord: { kind: 'terminal', error: code, code },
  ...extra,
}));

test('by default a failed turn is pushed and its worker marked in error', () => {
  const fx = setup();
  const row = fx.claim('msg-1');
  assert.ok(fail(fx, row, 'worker-crashed'));
  assert.deepEqual(fx.calls, [
    ['push', 'msg-1'],
    ['relay-error', 'msg-1'],
    ['mark-error', 'sdk-worker', 'queue-failed:worker-crashed'],
  ]);
  assert.equal(fx.db.prepare(`SELECT status FROM queue WHERE id = 'msg-1'`).get().status, 'failed');
});

test('a turn the archive ended is not pushed; its relay event and failure reply stay', () => {
  const fx = setup();
  const row = fx.claim('msg-1');
  assert.ok(fail(fx, row, 'conversation-archived'));
  assert.deepEqual(fx.calls.filter(([kind]) => kind !== 'mark-error'), [['relay-error', 'msg-1']]);
  assert.deepEqual(fx.emitted.filter(([event]) => event === 'assistant_message').map(([, payload]) => payload.message.text), ['failed: conversation-archived']);
});

test('settleWorker: false leaves the owner session\'s worker alone', () => {
  const fx = setup();
  for (const markWorkerError of [true, false]) {
    const row = fx.claim(`msg-${markWorkerError}`);
    assert.ok(fail(fx, row, 'conversation-archived', { settleWorker: false, markWorkerError }));
  }
  assert.deepEqual(fx.calls.filter(([kind]) => ['mark-error', 'mark-idle', 'registry-upsert'].includes(kind)), []);
});

// The card clean-up runs after the failure has committed: a throw there would
// reach a caller that takes the turn for not failed and fails it again.
test('a row read that throws in the card clean-up leaves one committed failure and one status', () => {
  const fx = setup();
  const row = fx.claim('msg-1');
  fx.stmts.findQById = { get: () => { throw new Error('database is locked'); } };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  let result;
  try {
    result = fail(fx, row, 'worker-crashed');
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(result?.responseId);
  assert.deepEqual(fx.emitted.filter(([event]) => event === 'message_status').map(([, payload]) => payload.status), ['failed']);
  assert.equal(fx.db.prepare(`SELECT status FROM queue WHERE id = 'msg-1'`).get().status, 'failed');
  assert.match(warnings.join('\n'), /The cards of msg-1 were not cancelled: database is locked/);
});
