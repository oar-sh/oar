import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import {
  GONE_CONVERSATION_GRACE_MS,
  OWNERLESS_ROW_MAX_AGE_MS,
  failRowsOfGoneConversations,
  failStaleOwnerlessRowsAtBoot,
} from './ownerless-queue-rows.mjs';

// Two guards around queue rows that no worker will ever take:
// - a pending row whose conversation is gone (no row any more, or deleted
//   and not removed with its queue, as when the relay stopped between the two
//   steps of a delete) is failed by the waker's scan, so it does not stay a
//   pending turn in the status counts and a host-suspend blocker for good;
// - at boot, a pending row that had no owner anywhere before the conversation
//   id became the last owner fallback, and has waited for longer than a day,
//   is failed with a note instead of running that late.

const NOW_MS = Date.parse('2026-04-10T12:00:00.000Z');
const iso = (msAgo) => new Date(NOW_MS - msAgo).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function boot() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const conversation = (id, { sdkSessionId = null, status = 'active', updatedAt = iso(0) } = {}) => {
    db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, status, created_at, updated_at) VALUES (?, 'Guard', ?, ?, ?, ?)`)
      .run(id, sdkSessionId, status, iso(48 * HOUR), updatedAt);
  };
  const queue = (id, conversationId, { at = iso(0), owner = null, status = 'pending' } = {}) => {
    db.prepare(`INSERT INTO queue (id, conversation_id, text, relay_mode, status, timestamp, owner_sdk_session_id) VALUES (?, ?, 'run the report', 'agent', ?, ?, ?)`)
      .run(id, conversationId, status, at, owner);
  };
  const row = (id) => stmts.findQById.get(id);
  const events = [];
  const lines = [];
  const deps = {
    db,
    stmts,
    nowMs: NOW_MS,
    emit: (event, payload) => events.push({ event, payload }),
    log: (line) => lines.push(line),
    uuid: (() => { let n = 0; return () => `msg-guard-${++n}`; })(),
  };
  const pendingCount = () => stmts.countStatus.all().find((entry) => entry.status === 'pending')?.cnt || 0;
  return { db, stmts, conversation, queue, row, events, lines, deps, pendingCount };
}

test('the guard windows: a minute for a deleted conversation, a day for an ownerless row', () => {
  assert.equal(GONE_CONVERSATION_GRACE_MS, 60_000);
  assert.equal(OWNERLESS_ROW_MAX_AGE_MS, 24 * HOUR);
});

test('a pending row whose conversation is missing is failed, not listed for a launch', () => {
  const fx = boot();
  fx.queue('q-orphan-a1', 'conv-missing-a1');
  assert.deepEqual(fx.stmts.listPendingWorkerOwnerSessionIds.all(25), [], 'the waker never launches for it');
  assert.equal(fx.stmts.listActiveQueueCountsByConversation.all().length, 1, 'a suspend blocker until the sweep');
  assert.equal(fx.pendingCount(), 1);

  assert.equal(failRowsOfGoneConversations(fx.deps), 1);
  const failed = fx.row('q-orphan-a1');
  assert.equal(failed.status, 'failed');
  const record = JSON.parse(failed.response);
  assert.equal(record.kind, 'requeue-timeout');
  assert.equal(record.stableCode, 'relay.retry-timeout');
  assert.match(record.message, /conversation is gone, the turn did not run/);
  assert.deepEqual(fx.events.map((entry) => [entry.event, entry.payload.status]), [['message_status', 'failed']]);
  assert.equal(fx.lines.length, 1);
  assert.match(fx.lines[0], /^QUEUE +failed q-orphan conv=conv-mis reason=conversation-gone$/);
  assert.deepEqual(fx.stmts.listActiveQueueCountsByConversation.all(), [], 'no suspend blocker left');
  assert.equal(fx.pendingCount(), 0, 'nor a pending turn in the status counts');
  assert.equal(failRowsOfGoneConversations(fx.deps), 0, 'once');
});

test('a conversation deleted for under a minute is left to its hard delete; over a minute, its rows fail', () => {
  const fx = boot();
  fx.conversation('conv-deleting-b2', { status: 'deleted', updatedAt: iso(GONE_CONVERSATION_GRACE_MS - 5_000) });
  fx.queue('q-deleting-b2', 'conv-deleting-b2');
  assert.equal(failRowsOfGoneConversations(fx.deps), 0);
  assert.equal(fx.row('q-deleting-b2').status, 'pending');

  fx.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = 'conv-deleting-b2'`).run(iso(GONE_CONVERSATION_GRACE_MS + 5_000));
  assert.equal(failRowsOfGoneConversations(fx.deps), 1);
  assert.equal(fx.row('q-deleting-b2').status, 'failed');
  assert.equal(fx.pendingCount(), 0);
  assert.deepEqual(fx.stmts.listActiveQueueCountsByConversation.all(), []);
});

test('with no grace, as at relay start, the rows of a conversation deleted a moment ago fail at once', () => {
  const fx = boot();
  fx.conversation('conv-deleting-e5', { status: 'deleted', updatedAt: iso(1_000) });
  fx.conversation('conv-live-e5');
  fx.queue('q-deleting-e5', 'conv-deleting-e5');
  fx.queue('q-live-e5', 'conv-live-e5');
  assert.equal(failRowsOfGoneConversations({ ...fx.deps, graceMs: 0 }), 1);
  assert.equal(fx.row('q-deleting-e5').status, 'failed');
  assert.equal(fx.row('q-live-e5').status, 'pending');
  assert.deepEqual(fx.events.map((entry) => entry.payload.messageId), ['q-deleting-e5']);
});

test('with no grace, as at relay start, a live conversation keeps its pending rows', () => {
  const fx = boot();
  // Live, whatever its age or last change: just touched, idle for days, archived.
  fx.conversation('conv-live-f6', { updatedAt: iso(0) });
  fx.conversation('conv-idle-f6', { updatedAt: iso(48 * HOUR) });
  fx.conversation('conv-archived-f6', { updatedAt: iso(48 * HOUR) });
  fx.db.prepare(`UPDATE conversations SET archived = 1 WHERE id = 'conv-archived-f6'`).run();
  fx.queue('q-live-f6', 'conv-live-f6');
  fx.queue('q-idle-f6', 'conv-idle-f6', { at: iso(47 * HOUR) });
  fx.queue('q-archived-f6', 'conv-archived-f6', { at: iso(47 * HOUR) });
  assert.equal(failRowsOfGoneConversations({ ...fx.deps, graceMs: 0 }), 0);
  for (const id of ['q-live-f6', 'q-idle-f6', 'q-archived-f6']) assert.equal(fx.row(id).status, 'pending', id);
  assert.equal(fx.pendingCount(), 3);
  assert.deepEqual(fx.events, []);
  assert.deepEqual(fx.lines, []);
});

test('rows of live conversations, and rows that are not pending, are not touched by the sweep', () => {
  const fx = boot();
  fx.conversation('conv-live-c3');
  fx.conversation('conv-archived-c3');
  fx.db.prepare(`UPDATE conversations SET archived = 1 WHERE id = 'conv-archived-c3'`).run();
  fx.queue('q-live-c3', 'conv-live-c3');
  fx.queue('q-archived-c3', 'conv-archived-c3');
  fx.queue('q-gone-running-c3', 'conv-missing-c3', { status: 'processing' });
  assert.equal(failRowsOfGoneConversations(fx.deps), 0);
  for (const id of ['q-live-c3', 'q-archived-c3']) assert.equal(fx.row(id).status, 'pending', id);
  assert.equal(fx.row('q-gone-running-c3').status, 'processing');
});

test('at boot, an ownerless row older than a day fails with a note in its conversation; a young one is left to run', () => {
  const fx = boot();
  fx.conversation('conv-unbound-d4');
  fx.queue('q-old-d4', 'conv-unbound-d4', { at: iso(OWNERLESS_ROW_MAX_AGE_MS + HOUR) });
  fx.queue('q-young-d4', 'conv-unbound-d4', { at: iso(OWNERLESS_ROW_MAX_AGE_MS - HOUR) });

  const report = failStaleOwnerlessRowsAtBoot(fx.deps);
  assert.deepEqual(report, { count: 2, oldestAt: iso(OWNERLESS_ROW_MAX_AGE_MS + HOUR), failed: 1 });
  assert.equal(fx.lines.length, 1, 'one report line');
  assert.match(fx.lines[0], /^QUEUE +ownerless pending rows=2 oldest=2026-04-09T11:00:00\.000Z age=25h failed=1 \(waited longer than 24h\)$/);

  const old = fx.row('q-old-d4');
  assert.equal(old.status, 'failed');
  const record = JSON.parse(old.response);
  assert.equal(record.kind, 'requeue-timeout');
  assert.equal(record.stableCode, 'relay.retry-timeout');
  const note = fx.stmts.getMessages.all('conv-unbound-d4').find((message) => message.role === 'assistant');
  assert.equal(note.text, `This message waited since ${iso(OWNERLESS_ROW_MAX_AGE_MS + HOUR)} for a worker the relay never started. It was not run; resend it if it is still wanted.`);
  assert.equal(old.response_message_id, note.id);
  assert.ok(fx.events.some((entry) => entry.event === 'assistant_message' && entry.payload.sourceMessageId === 'q-old-d4'));
  assert.ok(fx.events.some((entry) => entry.event === 'message_status' && entry.payload.messageId === 'q-old-d4' && entry.payload.status === 'failed'));

  assert.equal(fx.row('q-young-d4').status, 'pending');
  assert.deepEqual(fx.stmts.listPendingWorkerOwnerSessionIds.all(25).map((entry) => entry.sdk_session_id), ['conv-unbound-d4'],
    'the young one goes to its conversation\'s worker');
});

test('at boot, owned or bound old rows are not ownerless and are not touched', () => {
  const fx = boot();
  fx.conversation('conv-bound-e5', { sdkSessionId: 'sess-bound-e5' });
  fx.conversation('conv-owned-e5');
  fx.queue('q-bound-e5', 'conv-bound-e5', { at: iso(3 * OWNERLESS_ROW_MAX_AGE_MS) });
  fx.queue('q-owned-e5', 'conv-owned-e5', { at: iso(3 * OWNERLESS_ROW_MAX_AGE_MS), owner: 'conv-owned-e5' });
  assert.deepEqual(failStaleOwnerlessRowsAtBoot(fx.deps), { count: 0, oldestAt: null, failed: 0 });
  assert.deepEqual(fx.lines, [], 'nothing to report');
  for (const id of ['q-bound-e5', 'q-owned-e5']) assert.equal(fx.row(id).status, 'pending', id);
});

test('a second boot has nothing more to fail', () => {
  const fx = boot();
  fx.conversation('conv-unbound-f6');
  fx.queue('q-old-f6', 'conv-unbound-f6', { at: iso(2 * OWNERLESS_ROW_MAX_AGE_MS) });
  assert.equal(failStaleOwnerlessRowsAtBoot(fx.deps).failed, 1);
  const before = fx.stmts.getMessages.all('conv-unbound-f6').length;
  fx.lines.length = 0;
  assert.deepEqual(failStaleOwnerlessRowsAtBoot(fx.deps), { count: 0, oldestAt: null, failed: 0 });
  assert.deepEqual(fx.lines, []);
  assert.equal(fx.stmts.getMessages.all('conv-unbound-f6').length, before, 'no second note');
});

test('at boot, rows of a conversation that is gone are left to the sweep, which has no transcript to write to', () => {
  const fx = boot();
  fx.queue('q-gone-g7', 'conv-missing-g7', { at: iso(2 * OWNERLESS_ROW_MAX_AGE_MS) });
  assert.deepEqual(failStaleOwnerlessRowsAtBoot(fx.deps), { count: 0, oldestAt: null, failed: 0 });
  assert.equal(failRowsOfGoneConversations(fx.deps), 1);
});
