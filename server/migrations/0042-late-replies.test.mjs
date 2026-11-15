import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { LATE_REPLY_COLUMNS, migrateLateReplies } from './0042-late-replies.mjs';
import { migrateRelayEventSubscriptionOptions } from './0019-relay-event-subscription-options.mjs';
import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { createRelayEventService } from '../services/relay-event-service.mjs';

const NOW = Date.parse('2026-11-15T01:00:00.000Z');
const MINUTE = 60_000;

const columns = (db) => db.prepare(`PRAGMA table_info(relay_event_own_prompts)`).all().map((column) => column.name);
const indexes = (db) => db.prepare(`PRAGMA index_list(relay_event_own_prompts)`).all().map((index) => index.name);

/** A database as 0041 left it: the own-prompts table in its 0019 shape. */
function before0042() {
  const db = new Database(':memory:');
  applySchema(db);
  db.exec('DROP INDEX IF EXISTS idx_relay_event_own_prompts_late');
  db.exec('DROP TABLE relay_event_own_prompts');
  migrateRelayEventSubscriptionOptions(db);
  return db;
}

function addPrompt(db, id, createdAt, receivedAt = null) {
  db.prepare(`INSERT INTO relay_event_own_prompts (message_id, watcher_conversation_id, relay_id, session_id, created_at, received_at) VALUES (?, 'conv-a', 'self', 'conv-b', ?, ?)`)
    .run(id, new Date(createdAt).toISOString(), receivedAt ? new Date(receivedAt).toISOString() : null);
}

const stateOf = (db, id) => db.prepare(`SELECT late_state, late_next_at FROM relay_event_own_prompts WHERE message_id = ?`).get(id);

test('0042 adds the three columns and the index; a second run changes nothing', () => {
  const db = before0042();
  assert.deepEqual(columns(db), ['message_id', 'watcher_conversation_id', 'relay_id', 'session_id', 'created_at', 'received_at']);
  assert.deepEqual(migrateLateReplies(db, { now: NOW }), { applied: true, columnsAdded: 3, marked: 0 });
  assert.deepEqual(columns(db).slice(-3), LATE_REPLY_COLUMNS.map(([name]) => name));
  assert.ok(indexes(db).includes('idx_relay_event_own_prompts_late'));
  addPrompt(db, 'msg-later', NOW - 3 * 60 * MINUTE);
  assert.deepEqual(migrateLateReplies(db, { now: NOW }), { applied: false, columnsAdded: 0, marked: 0 });
  assert.equal(stateOf(db, 'msg-later').late_state, null, 'a row added after the upgrade is the service\'s, never marked');
});

test('earlier rows: received ones are returned, older open ones before_upgrade, the last hour\'s stay open and due', () => {
  const db = before0042();
  addPrompt(db, 'msg-received', NOW - 3 * 60 * MINUTE, NOW - 3 * 60 * MINUTE + MINUTE);
  addPrompt(db, 'msg-received-fresh', NOW - 5 * MINUTE, NOW - 4 * MINUTE);
  addPrompt(db, 'msg-old-open', NOW - 2 * 60 * MINUTE);
  addPrompt(db, 'msg-fresh-open', NOW - 10 * MINUTE);
  assert.equal(migrateLateReplies(db, { now: NOW }).marked, 3);
  assert.equal(stateOf(db, 'msg-received').late_state, 'returned');
  assert.equal(stateOf(db, 'msg-received-fresh').late_state, 'returned');
  assert.equal(stateOf(db, 'msg-old-open').late_state, 'before_upgrade');
  assert.deepEqual(stateOf(db, 'msg-fresh-open'), { late_state: null, late_next_at: new Date(NOW).toISOString() });
});

test('without 0019\'s table it fails, and the boot goes on (applySchema logs it)', () => {
  const db = new Database(':memory:');
  assert.throws(() => migrateLateReplies(db), /migration 0019/);
});

test('in the event service a before_upgrade prompt gets no late reply and keeps its turn_end', async () => {
  const db = before0042();
  const at = (ms) => new Date(ms).toISOString();
  for (const [id, title] of [['conv-a', 'lead'], ['conv-b', 'lane']]) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at(NOW - 3 * 60 * MINUTE), at(NOW - 3 * 60 * MINUTE));
  }
  addPrompt(db, 'msg-before', NOW - 2 * 60 * MINUTE);
  migrateLateReplies(db, { now: NOW });
  let clock = NOW;
  const service = createRelayEventService({
    db,
    stmts: { ...createSessionRepository(db), ...createMessageRepository(db) },
    now: () => clock,
    setTimer: () => null,
    clearTimer: () => {},
    logger: { log() {}, warn() {} },
  });
  const reads = [];
  service.setLateReplyReader(async (group) => {
    reads.push(group);
    return { outcomes: {} };
  });
  service.subscribe({ watcherConversationId: 'conv-a', sessionIds: ['conv-b'] });
  service.noteTurnEnd({ conversationId: 'conv-b', queueMessageId: 'msg-before', replyText: 'the old way' });
  await service.passLateReplies();
  assert.equal(reads.length, 0, 'never looked for');
  clock += 31_000;
  service.flush('conv-a');
  const [message] = db.prepare(`SELECT m.text FROM messages m WHERE m.conversation_id = 'conv-a' AND m.kind = ?`).all(RELAY_EVENT_MESSAGE_KIND);
  assert.match(message.text, /turn_end \(done\) "the old way"/);
});
