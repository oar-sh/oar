import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from './session-repository.mjs';
import { QUEUE_ROW_NOT_ARCHIVED_SQL, createMessageRepository } from './message-repository.mjs';
import { installQueueWakeHook } from '../services/queue-wake-hook.mjs';

// A pending row of an archived conversation, written directly as a stranded
// one would be (every send unarchives, queue-insert.mjs), is neither woken
// nor claimed, and is both once the conversation is unarchived. The claim and
// the waker read the same condition.

const NOW = '2026-11-16T09:00:00.000Z';
const LATER = '2026-11-16T09:00:01.000Z';
const SESSION = 'sdk-shared';

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const conversation = (id, { archived = 0 } = {}) => {
    db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, status, archived, created_at, updated_at) VALUES (?, 'Queue', ?, 'active', ?, ?, ?)`)
      .run(id, SESSION, archived, NOW, NOW);
  };
  const queue = (id, conversationId, at = NOW) => {
    db.prepare(`INSERT INTO queue (id, conversation_id, text, relay_mode, status, timestamp) VALUES (?, ?, 'go on', 'agent', 'pending', ?)`)
      .run(id, conversationId, at);
  };
  // POST /api/conversation/:id/unarchive's update.
  const unarchive = (id) => db.prepare(`UPDATE conversations SET archived = 0, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
  const woken = () => stmts.listPendingWorkerOwnerSessionIds.all(25).map((row) => row.sdk_session_id);
  const claimable = () => stmts.findPendingForWorker.get(LATER, SESSION)?.id || null;
  return { db, stmts, conversation, queue, unarchive, woken, claimable };
}

test('the claim, the waker and the host-suspend count all read the archived condition', () => {
  const { stmts } = boot();
  assert.equal(QUEUE_ROW_NOT_ARCHIVED_SQL, 'COALESCE(c.archived, 0) = 0');
  assert.ok(stmts.findPendingForWorker.source.includes(QUEUE_ROW_NOT_ARCHIVED_SQL));
  assert.ok(stmts.listPendingWorkerOwnerSessionIds.source.includes(QUEUE_ROW_NOT_ARCHIVED_SQL));
  assert.ok(stmts.listActiveQueueCountsByConversation.source.includes(QUEUE_ROW_NOT_ARCHIVED_SQL));
});

// The host may suspend while a pending row waits in an archived chat: no
// worker will take it before the chat is unarchived. A turn a live worker
// still runs there holds the host, as it does anywhere.
test('a pending row of an archived chat does not hold off host suspend; it does after the unarchive', () => {
  const fx = boot();
  fx.conversation('conv-archived', { archived: 1 });
  fx.queue('q-stranded', 'conv-archived');
  const holding = () => fx.stmts.listActiveQueueCountsByConversation.all().map((row) => [row.conversation_id, row.cnt]);
  assert.deepEqual(holding(), []);
  fx.db.prepare(`INSERT INTO queue (id, conversation_id, text, relay_mode, status, timestamp) VALUES ('q-running', 'conv-archived', 'go on', 'agent', 'processing', ?)`).run(NOW);
  assert.deepEqual(holding(), [['conv-archived', 1]]);
  fx.unarchive('conv-archived');
  assert.deepEqual(holding(), [['conv-archived', 2]]);
});

test('a stranded row of an archived conversation is neither woken nor claimed, and is both after unarchive', () => {
  const fx = boot();
  fx.conversation('conv-archived', { archived: 1 });
  fx.queue('q-stranded', 'conv-archived');
  assert.deepEqual(fx.woken(), []);
  assert.equal(fx.claimable(), null);
  fx.unarchive('conv-archived');
  assert.deepEqual(fx.woken(), [SESSION]);
  assert.equal(fx.claimable(), 'q-stranded');
});

test("an archived conversation's older row does not hold back a live one of the same session", () => {
  const fx = boot();
  fx.conversation('conv-archived', { archived: 1 });
  fx.conversation('conv-live');
  fx.queue('q-stranded', 'conv-archived', NOW);
  fx.queue('q-live', 'conv-live', LATER);
  assert.deepEqual(fx.woken(), [SESSION]);
  assert.equal(fx.claimable(), 'q-live');
});

// A manual unarchive writes the conversations table, not the queue: the
// queue-wake triggers do not fire, and the waker finds the row on its next
// poll (the socket service's backstop, 10 s with the triggers installed).
test('an unarchive is no queue write: no wake fires, the next poll finds the row', () => {
  const fx = boot();
  fx.conversation('conv-archived', { archived: 1 });
  fx.queue('q-stranded', 'conv-archived');
  const wakes = [];
  const hook = installQueueWakeHook(fx.db, { onWake: (reason) => wakes.push(reason), schedule: (fn) => fn() });
  assert.equal(hook.installed, true);
  fx.unarchive('conv-archived');
  assert.deepEqual(wakes, []);
  // The poll's listing.
  assert.deepEqual(fx.woken(), [SESSION]);
  assert.equal(fx.claimable(), 'q-stranded');
});
