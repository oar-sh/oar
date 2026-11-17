import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from './session-repository.mjs';
import { createMessageRepository } from './message-repository.mjs';
import { queueIntoConversation, unarchivedConversationEvent } from './queue-insert.mjs';

// A row queued into an archived conversation brings it back in the same
// transaction; the caller learns whether it did.

const OLD = '2026-01-01T00:00:00.000Z';

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const conversation = (id, { archived = 0, status = 'active' } = {}) => {
    db.prepare(`INSERT INTO conversations (id, title, status, archived, created_at, updated_at) VALUES (?, 'Queue', ?, ?, ?, ?)`)
      .run(id, status, archived, OLD, OLD);
  };
  const conv = (id) => db.prepare(`SELECT archived, updated_at FROM conversations WHERE id = ?`).get(id);
  const queueArgs = (id, conversationId) => {
    const args = [id, conversationId, null, 0, 'model', 'model', null, null, 'agent', 'hello', null, new Date().toISOString(), null, null, null, null];
    if (stmts.queueHasImageOperationId) args.push(null);
    return args;
  };
  const row = (id) => stmts.findQById.get(id);
  return { db, stmts, conversation, conv, queueArgs, row };
}

test('a row queued into an archived conversation unarchives it in the same write', () => {
  const fx = boot();
  fx.conversation('conv-a', { archived: 1 });
  const result = queueIntoConversation(fx.db, fx.stmts, fx.queueArgs('q-a', 'conv-a'));
  assert.deepEqual(result, { unarchived: true });
  assert.equal(fx.conv('conv-a').archived, 0);
  assert.notEqual(fx.conv('conv-a').updated_at, OLD);
  assert.equal(fx.row('q-a').status, 'pending');
});

test('a live conversation is left as it is and the caller hears nothing to announce', () => {
  const fx = boot();
  fx.conversation('conv-b');
  const result = queueIntoConversation(fx.db, fx.stmts, fx.queueArgs('q-b', 'conv-b'));
  assert.deepEqual(result, { unarchived: false });
  assert.equal(fx.conv('conv-b').updated_at, OLD);
  assert.equal(fx.row('q-b').status, 'pending');
});

test('a deleted conversation is not brought back', () => {
  const fx = boot();
  fx.conversation('conv-d', { archived: 1, status: 'deleted' });
  const result = queueIntoConversation(fx.db, fx.stmts, fx.queueArgs('q-d', 'conv-d'));
  assert.deepEqual(result, { unarchived: false });
  assert.equal(fx.conv('conv-d').archived, 1);
});

test('an insert that fails leaves the conversation archived', () => {
  const fx = boot();
  fx.conversation('conv-c', { archived: 1 });
  fx.conversation('conv-other');
  queueIntoConversation(fx.db, fx.stmts, fx.queueArgs('q-dup', 'conv-other'));
  assert.throws(() => queueIntoConversation(fx.db, fx.stmts, fx.queueArgs('q-dup', 'conv-c')), /UNIQUE|constraint/i);
  assert.equal(fx.conv('conv-c').archived, 1);
  assert.equal(fx.conv('conv-c').updated_at, OLD);
});

test("inside the caller's transaction, a later failure undoes the unarchive and the row", () => {
  const fx = boot();
  fx.conversation('conv-e', { archived: 1 });
  const send = fx.db.transaction(() => {
    queueIntoConversation(fx.db, fx.stmts, fx.queueArgs('q-e', 'conv-e'));
    throw new Error('refused later in the send');
  });
  assert.throws(send, /refused later/);
  assert.equal(fx.conv('conv-e').archived, 1);
  assert.equal(fx.row('q-e'), undefined);
});

test('the unarchive event is the route\'s event name and payload', () => {
  assert.deepEqual(unarchivedConversationEvent('conv-f'), ['conversation_archived', { conversationId: 'conv-f', archived: false }]);
});
