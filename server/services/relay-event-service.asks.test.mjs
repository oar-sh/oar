import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createRemoteRelayRepository } from '../repositories/remote-relay-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_EVENT_LEAD, RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { createRelayEventService } from './relay-event-service.mjs';

// question_answered: the answer to a question that does not block reaches the
// conversations that asked without a subscription, at once, as the relay's
// own event message, which never counts as the user's (the loop guard).

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const LEAD = 'conv-fixture-lead';
const WORKER = 'conv-fixture-worker';
const WATCHER = 'conv-fixture-watcher';

function seedConversation(db, id, title) {
  const at = new Date(T0 - 60_000).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES (?, ?, ?, ?, 'claude-sonnet-5', 'claude', 'claude-sonnet-5', ?, ?)
  `).run(`rs-${id}`, id, `sdk-${id}`, `key-${id}`, at, at);
  // The user's own first message: the loop guard counts from it.
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', 'start', ?)`).run(`m-human-${id}`, id, at);
}

function createClock() {
  let clock = T0;
  const timers = [];
  return {
    now: () => clock,
    setTimer(fn, ms) {
      const timer = { fn, at: clock + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.done = true;
    },
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        const next = timers.filter((timer) => !timer.done && timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = Math.max(clock, next.at);
        next.done = true;
        next.fn();
      }
      clock = until;
    },
  };
}

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  seedConversation(db, LEAD, 'Lead');
  seedConversation(db, WORKER, 'Cache layer');
  seedConversation(db, WATCHER, 'Watcher');
  const clock = createClock();
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const wakes = [];
  const service = createRelayEventService({
    db,
    stmts,
    wakeWatcher: (wake) => wakes.push(wake),
    relayName: () => 'bench-relay',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { log() {}, warn() {} },
  });
  service.start();
  return { db, service, clock, wakes };
}

function eventMessages(db, conversationId) {
  return db.prepare(`SELECT m.id, m.text, m.kind, m.role, q.status FROM messages m JOIN queue q ON q.id = m.id WHERE m.conversation_id = ? AND m.kind = ? ORDER BY m.timestamp ASC`)
    .all(conversationId, RELAY_EVENT_MESSAGE_KIND);
}

const ANSWER = { questionId: 'ask_fixture01', prompt: 'Which database?', answer: 'SQLite', choice: 'SQLite' };

test('the session the ask is in and the conversation that asked are told at once, without a subscription', () => {
  const { db, service, clock, wakes } = setup();
  assert.equal(service.listActive().length, 0, 'nobody subscribed');
  const told = service.noteQuestionAnswered({ sessionId: WORKER, notify: [WORKER, LEAD, WORKER], detail: ANSWER });
  assert.equal(told, 2);
  clock.advance(0);
  for (const id of [WORKER, LEAD]) {
    const [message] = eventMessages(db, id);
    assert.ok(message, id);
    assert.equal(message.role, 'user');
    assert.equal(message.status, 'pending');
    assert.equal(message.text, `${RELAY_EVENT_LEAD}\n[relay event] session "Cache layer" (${WORKER}): question_answered (question_id ask_fixture01) "Which database?" → the user answered "SQLite" (via relay "bench-relay")`);
  }
  assert.deepEqual(wakes.map((wake) => wake.conversationId).sort(), [LEAD, WORKER].sort());
});

test('an answer told to a session does not reset its loop guard: the relay\'s message is not the user\'s', () => {
  const { db, service, clock } = setup();
  const repository = createRemoteRelayRepository(db);
  assert.equal(repository.latestHumanMessageId(LEAD), `m-human-${LEAD}`);
  service.noteQuestionAnswered({ sessionId: LEAD, notify: [LEAD], detail: ANSWER });
  clock.advance(0);
  assert.equal(eventMessages(db, LEAD).length, 1);
  assert.equal(repository.latestHumanMessageId(LEAD), `m-human-${LEAD}`, 'still the user\'s own message');
});

test('into a running session it is queued behind the turn (the worker steers it in); into a pending event row it is merged', () => {
  const { db, service, clock, wakes } = setup();
  const iso = new Date(T0).toISOString();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES ('m-run', ?, 'user', 'go on', ?)`).run(LEAD, iso);
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, processing_at) VALUES ('m-run', ?, 'go on', 'processing', ?, ?)`).run(LEAD, iso, iso);
  service.noteQuestionAnswered({ sessionId: LEAD, notify: [LEAD], detail: ANSWER });
  clock.advance(0);
  const [first] = eventMessages(db, LEAD);
  assert.equal(first.status, 'pending', 'a pending row the running worker takes as a steer');
  assert.equal(wakes.length, 1);
  service.noteQuestionAnswered({ sessionId: LEAD, notify: [LEAD], detail: { ...ANSWER, questionId: 'ask_fixture02', dismissed: true } });
  clock.advance(0);
  const messages = eventMessages(db, LEAD);
  assert.equal(messages.length, 1, 'one follow-up, not one per answer');
  assert.match(messages[0].text, /ask_fixture01.*\n.*ask_fixture02\) "Which database\?" → the user dismissed it/s);
  assert.equal(wakes.length, 1);
});

test('watchers that take question_asked get it too, once each; others do not', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [WORKER] });
  service.subscribe({ watcherConversationId: LEAD, sessionIds: [WORKER] });
  const turnsOnly = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [WORKER], events: ['turn_end'] });
  assert.ok(turnsOnly.id);
  service.noteQuestionAnswered({ sessionId: WORKER, notify: [WORKER, LEAD], detail: ANSWER });
  clock.advance(0);
  assert.equal(eventMessages(db, WATCHER).length, 1);
  const lead = eventMessages(db, LEAD);
  assert.equal(lead.length, 1);
  assert.equal(lead[0].text.split('\n').length, 2, 'told once, not as asker and again as watcher');

  const other = setup();
  other.service.subscribe({ watcherConversationId: WATCHER, sessionIds: [WORKER], events: ['turn_end', 'error'] });
  other.service.noteQuestionAnswered({ sessionId: WORKER, notify: [], detail: ANSWER });
  other.clock.advance(60_000);
  assert.equal(eventMessages(other.db, WATCHER).length, 0);
});

test('an answer owed to the asker is not dropped when the asker\'s last subscription ends', () => {
  const { db, service, clock } = setup();
  const sub = service.subscribe({ watcherConversationId: LEAD, sessionIds: [WATCHER] });
  service.noteQuestionAnswered({ sessionId: LEAD, notify: [LEAD], detail: ANSWER });
  service.unsubscribe({ watcherConversationId: LEAD, subscriptionId: sub.id });
  clock.advance(0);
  assert.equal(eventMessages(db, LEAD).length, 1);
});

test('the answer to an ask kept on a paired relay is told to the asker here under that relay\'s name', () => {
  const { db, service, clock } = setup();
  service.noteQuestionAnswered({
    sessionId: 'conv-there',
    sessionTitle: 'Remote worker',
    relay: { id: 'relay-lab', name: 'lab-relay' },
    notify: [LEAD],
    detail: { questionId: 'ask_there01', prompt: 'Deploy?', dismissed: true },
  });
  clock.advance(0);
  const [message] = eventMessages(db, LEAD);
  assert.equal(message.text.split('\n')[1], '[relay event] lab-relay · session "Remote worker" (conv-there): question_answered (question_id ask_there01) "Deploy?" → the user dismissed it without an answer; decide yourself or ask again later (via relay "lab-relay")');
});

test('the line says where the answer came from: this relay, or the paired relay whose Inbox it was', () => {
  const { db, service, clock } = setup();
  service.noteQuestionAnswered({ sessionId: LEAD, notify: [LEAD], detail: { ...ANSWER, via: 'lab-relay' } });
  service.noteQuestionAnswered({
    sessionId: 'conv-there',
    relay: { id: 'relay-lab', name: 'lab-relay' },
    notify: [WORKER],
    detail: { questionId: 'ask_there01', prompt: 'Deploy?', answer: 'Yes', via: 'bench-relay' },
  });
  clock.advance(0);
  assert.match(eventMessages(db, LEAD)[0].text, /→ the user answered "SQLite" \(via relay "lab-relay"\)$/);
  assert.match(eventMessages(db, WORKER)[0].text, /^\[relay event\] lab-relay · .*→ the user answered "Yes" \(via relay "bench-relay"\)$/m, 'answered from this relay\'s own Inbox');
});

test('a paired relay watching the session fetches the answer like any event', () => {
  const { service } = setup();
  const served = service.subscribeServed({ subscriberRelayId: 'relay-other', watcherId: 'conv-far', sessionIds: [WORKER] });
  service.noteQuestionAnswered({ sessionId: WORKER, notify: [WORKER], detail: ANSWER });
  const pulled = service.pullServed({ subscriberRelayId: 'relay-other', subscriptions: [{ id: served.id }] });
  assert.deepEqual(pulled.events.map((event) => event.type), ['question_answered']);
  assert.equal(pulled.events[0].urgent, true);
  assert.deepEqual(pulled.events[0].payload.detail, { questionId: 'ask_fixture01', prompt: 'Which database?', answer: 'SQLite', choice: 'SQLite', kind: 'ask', via: 'bench-relay' });
});

test('a question_asked of an ask says that it does not block', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [WORKER] });
  service.noteQuestion({ id: 'ask_fixture01', conversationId: WORKER, prompt: 'Which database?', choices: ['Postgres', 'SQLite'], kind: 'ask' });
  clock.advance(0);
  assert.match(eventMessages(db, WATCHER)[0].text, /question_asked "Which database\?" options: \[Postgres\] \[SQLite\] \(question_id ask_fixture01\) \(asked with ask: it does not block that session\)/);
});
