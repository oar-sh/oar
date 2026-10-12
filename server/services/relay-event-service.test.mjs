import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_EVENT_LEAD, RELAY_EVENT_LIMITS, RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { createSessionActivityTracker } from './session-activity-tracker.mjs';
import { RelayEventError, createRelayEventService } from './relay-event-service.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const WATCHER = 'conv-fixture-watcher';
const BUILDER = 'conv-fixture-builder';
const DOCS = 'conv-fixture-docs';

function seedConversation(db, id, title, { provider = 'claude' } = {}) {
  const at = new Date(T0 - 60_000).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES (?, ?, ?, ?, 'claude-sonnet-5', ?, 'claude-sonnet-5', ?, ?)
  `).run(`rs-${id}`, id, `sdk-${id}`, `key-${id}`, provider, at, at);
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

function setup({ db = null, clock = createClock(), seed = true } = {}) {
  const database = db || new Database(':memory:');
  if (!db) applySchema(database);
  if (seed && !db) {
    seedConversation(database, WATCHER, 'relay assistant');
    seedConversation(database, BUILDER, 'Orbit camera');
    seedConversation(database, DOCS, 'Docs pass', { provider: 'cursor' });
  }
  const stmts = { ...createSessionRepository(database), ...createMessageRepository(database) };
  const emitted = [];
  const wakes = [];
  let service = null;
  const tracker = createSessionActivityTracker({
    db: database,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onEdge: (edge) => service?.noteTaskEdge(edge),
  });
  service = createRelayEventService({
    db: database,
    stmts,
    tracker,
    emit: (event, payload) => emitted.push({ event, payload }),
    wakeWatcher: (wake) => wakes.push(wake),
    relayName: () => 'bench-relay',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { log() {}, warn() {} },
  });
  service.start();
  return { db: database, stmts, service, tracker, clock, emitted, wakes };
}

function eventMessages(db, conversationId = WATCHER) {
  return db.prepare(`SELECT m.id, m.text, m.kind, m.role, q.status, q.text AS queue_text FROM messages m JOIN queue q ON q.id = m.id WHERE m.conversation_id = ? AND m.kind = ? ORDER BY m.timestamp ASC`)
    .all(conversationId, RELAY_EVENT_MESSAGE_KIND);
}

function startTurn(db, conversationId, id, { status = 'processing', at = T0 } = {}) {
  const iso = new Date(at).toISOString();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', 'go on', ?)`).run(id, conversationId, iso);
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, processing_at) VALUES (?, ?, 'go on', ?, ?, ?)`)
    .run(id, conversationId, status, iso, iso);
}

test('subscribe lists, refuses its own conversation and unknown sessions, and unsubscribe ends it', () => {
  const { service, emitted } = setup();
  const sub = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  assert.match(sub.id, /^sub_[0-9a-f]{10}$/);
  assert.deepEqual(sub.sessions, [{ id: BUILDER, title: 'Orbit camera' }]);
  assert.ok(sub.events.includes('turn_end'));
  assert.ok(!sub.events.includes('task_started'));
  assert.equal(sub.stalledMinutes, 15);
  assert.equal(emitted.at(-1).event, 'relay_event_subscriptions');
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, sessionIds: [WATCHER] }), (error) => error instanceof RelayEventError && error.code === 'ownSession');
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, sessionIds: ['conv-fixture-missing'] }), (error) => error.code === 'notFound');
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], match: '(' }), (error) => error.code === 'invalid');
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER }).length, 1);
  const ended = service.unsubscribe({ watcherConversationId: WATCHER, subscriptionId: sub.id });
  assert.equal(ended[0].endReason, 'unsubscribed');
  assert.equal(service.listActive().length, 0);
  assert.throws(() => service.unsubscribe({ watcherConversationId: WATCHER, subscriptionId: sub.id }), (error) => error.code === 'notFound');
});

test('a subscription and an undelivered event survive a restart', () => {
  const first = setup();
  const sub = first.service.subscribe({ watcherConversationId: WATCHER, scope: 'all' });
  first.service.noteTurnEnd({ conversationId: BUILDER, replyText: 'Rendered the orbit camera.' });
  first.service.stop();
  // A new relay process on the same database.
  const second = setup({ db: first.db, clock: first.clock });
  assert.deepEqual(second.service.listActive().map((row) => row.id), [sub.id]);
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const [message] = eventMessages(first.db);
  assert.match(message.text, /turn_end \(done\) "Rendered the orbit camera\."/);
  assert.equal(second.wakes.length, 1);
});

test('events within 30 s are one wake-up, tagged as automated and never as the user', () => {
  const { db, service, clock, wakes, emitted } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER, DOCS] });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'First part done.' });
  clock.advance(10_000);
  service.noteTurnEnd({ conversationId: DOCS, replyText: 'Docs rewritten.' });
  clock.advance(19_999);
  assert.equal(eventMessages(db).length, 0);
  clock.advance(1);
  const messages = eventMessages(db);
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.role, 'user');
  assert.equal(message.status, 'pending');
  assert.equal(message.text.split('\n')[0], RELAY_EVENT_LEAD);
  assert.equal(message.queue_text, message.text);
  assert.match(message.text, /session "Orbit camera" \(conv-fixture-builder\): turn_end/);
  assert.match(message.text, /session "Docs pass" \(conv-fixture-docs\): turn_end/);
  assert.deepEqual(wakes.map((wake) => wake.ownerSessionId), [`sdk-${WATCHER}`]);
  const live = emitted.find((entry) => entry.event === 'user_message');
  assert.equal(live.payload.message.kind, RELAY_EVENT_MESSAGE_KIND);
});

test('the watcher never hears of its own conversation, even watching all', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, scope: 'all' });
  service.noteTurnEnd({ conversationId: WATCHER, replyText: 'my own reply' });
  service.noteError({ conversationId: WATCHER, message: 'boom' });
  clock.advance(60_000);
  assert.equal(eventMessages(db).length, 0);
});

test('events for a watcher whose event row is still pending go into that row', () => {
  const { db, service, clock, wakes, emitted } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'one' });
  clock.advance(30_000);
  // The watcher is mid-turn on a provider that cannot steer: the row waits.
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'two' });
  clock.advance(30_000);
  const messages = eventMessages(db);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /"one"[\s\S]*"two"/);
  assert.equal(messages[0].queue_text, messages[0].text);
  assert.equal(wakes.length, 1);
  assert.ok(emitted.some((entry) => entry.event === 'message_updated' && entry.payload.messageId === messages[0].id));
  // Once delivered (processing), the next event is a wake-up of its own.
  db.prepare(`UPDATE queue SET status = 'processing' WHERE id = ?`).run(messages[0].id);
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'three' });
  clock.advance(30_000);
  assert.equal(eventMessages(db).length, 2);
});

function fillWakeHistory(db, count, clock) {
  for (let index = 0; index < count; index += 1) {
    const at = new Date(clock.now() - (count - index) * 60_000).toISOString();
    db.prepare(`
      INSERT INTO relay_events (subscription_id, watcher_conversation_id, session_id, type, payload_json, created_at, delivered_at, message_id)
      VALUES ('sub_earlier', ?, ?, 'turn_end', '{}', ?, ?, ?)
    `).run(WATCHER, BUILDER, at, at, `earlier-${index}`);
  }
}

test('past 20 wake-ups an hour events wait for a ten-minute digest', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  fillWakeHistory(db, RELAY_EVENT_LIMITS.wakesPerHour, clock);
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'held back' });
  clock.advance(5 * 60_000);
  assert.equal(eventMessages(db).filter((row) => row.status).length, 0);
  // The last wake-up was a minute before T0: the digest is due ten minutes after it.
  clock.advance(4 * 60_000);
  const [digest] = eventMessages(db);
  assert.ok(digest);
  assert.match(digest.text, /Digest of 1 event/);
});

test('question_asked and error go out at once past the cap, and count', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  fillWakeHistory(db, RELAY_EVENT_LIMITS.wakesPerHour, clock);
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'normal' });
  service.noteQuestion({ id: 'q-fixture-1', conversationId: BUILDER, prompt: 'Merge now?', choices: ['Yes', 'No'] });
  clock.advance(0);
  const [message] = eventMessages(db);
  assert.ok(message, 'the question is delivered without waiting');
  assert.doesNotMatch(message.text, /Digest/);
  assert.match(message.text, /question_asked "Merge now\?" options: \[Yes\] \[No\] \(question_id q-fixture-1\)/);
  // The held turn_end rides along with it.
  assert.match(message.text, /turn_end/);
  db.prepare(`UPDATE queue SET status = 'processing' WHERE id = ?`).run(message.id);
  service.noteError({ conversationId: BUILDER, kind: 'worker_died', message: 'the worker process exited' });
  clock.advance(0);
  assert.equal(eventMessages(db).length, 2);
  assert.match(eventMessages(db)[1].text, /error worker_died: the worker process exited/);
});

test('an approval card is named as one only the user can answer', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  service.noteQuestion({ id: 'q-card', conversationId: BUILDER, prompt: 'Allow?', choices: ['Allow', 'Deny'], context: { source: 'remote_relay' } });
  clock.advance(0);
  assert.match(eventMessages(db)[0].text, /only the user can answer it/);
});

test('a one-shot subscription with match fires on the matching reply only, then ends', () => {
  const { db, service, clock } = setup();
  const sub = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['turn_end'], once: true, match: 'tests? pass' });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'Two tests still fail.' });
  clock.advance(60_000);
  assert.equal(eventMessages(db).length, 0);
  assert.equal(service.listActive().length, 1);
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'All TESTS PASS now.' });
  assert.equal(service.listActive().length, 0);
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER })[0].endReason, 'fired');
  clock.advance(30_000);
  const [message] = eventMessages(db);
  assert.match(message.text, /All TESTS PASS now/);
  assert.match(message.text, new RegExp(`one-shot subscription ${sub.id} ended`));
});

test('a one-shot subscription without match ends with its first event', () => {
  const { service } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], once: true });
  service.noteTaskEdge({ type: 'task_finished', conversationId: BUILDER, task: { kind: 'shell', description: 'npm test', status: 'completed' } });
  assert.equal(service.listActive().length, 0);
});

test('task_started only when asked for; task ends with kind and exit', () => {
  const { db, service, tracker, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  tracker.noteTaskSet(BUILDER, [{ taskId: 'task-1', taskType: 'local_bash', description: 'npm test' }]);
  tracker.noteTaskSettled(BUILDER, { taskId: 'task-1', status: 'failed', summary: 'Exit code 3' });
  clock.advance(30_000);
  const [message] = eventMessages(db);
  assert.doesNotMatch(message.text, /task_started/);
  assert.match(message.text, /task_failed "npm test" \(shell, exit 3\)/);
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [DOCS], events: ['task_started'] });
  tracker.noteTaskSet(DOCS, [{ taskId: 'task-2', taskType: 'local_agent', description: 'Proofread' }]);
  db.prepare(`UPDATE queue SET status = 'processing'`).run();
  clock.advance(30_000);
  assert.match(eventMessages(db)[1].text, /task_started "Proofread" \(subagent\)/);
});

test('a turn that answered relay events tells no one', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: BUILDER, sessionIds: [WATCHER] });
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp, kind) VALUES ('evt-1', ?, 'user', 'events', ?, ?)`)
    .run(WATCHER, new Date(T0).toISOString(), RELAY_EVENT_MESSAGE_KIND);
  service.noteTurnEnd({ conversationId: WATCHER, queueMessageId: 'evt-1', replyText: 'Noted the events.' });
  clock.advance(60_000);
  assert.equal(eventMessages(db, BUILDER).length, 0);
});

test('stalled fires once per quiet spell, after the subscription\'s minutes', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['stalled'], stalledMinutes: 5 });
  startTurn(db, BUILDER, 'turn-quiet');
  clock.advance(4 * 60_000);
  assert.equal(eventMessages(db).length, 0);
  clock.advance(2 * 60_000);
  clock.advance(30_000);
  const messages = eventMessages(db);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /stalled: no activity for 5 min while a turn is still running/);
  db.prepare(`UPDATE queue SET status = 'processing' WHERE id = ?`).run(messages[0].id);
  clock.advance(5 * 60_000);
  assert.equal(eventMessages(db).length, 1, 'the same quiet spell is reported once');
});

test('a session waiting on a question is not stalled', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['stalled'], stalledMinutes: 5 });
  startTurn(db, BUILDER, 'turn-asking');
  db.prepare(`
    INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, status, created_at, expires_at)
    VALUES ('q-fixture-wait', 'turn-asking', ?, 'turn-asking', 'agent', 'Which one?', '[]', 'pending', ?, ?)
  `).run(BUILDER, new Date(T0).toISOString(), new Date(T0 + 3_600_000).toISOString());
  clock.advance(20 * 60_000);
  assert.equal(eventMessages(db).length, 0);
});

test('all_idle fires when the last watched turn or task ends', () => {
  const { db, service, tracker, clock } = setup();
  startTurn(db, BUILDER, 'turn-busy');
  tracker.noteTaskSet(DOCS, [{ taskId: 'task-docs', taskType: 'local_agent', description: 'Proofread' }]);
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER, DOCS], events: ['all_idle'] });
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'turn-busy'`).run();
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'done' });
  clock.advance(60_000);
  assert.equal(eventMessages(db).length, 0, 'a task is still running');
  tracker.noteTaskSettled(DOCS, { taskId: 'task-docs', status: 'completed' });
  clock.advance(60_000);
  const [message] = eventMessages(db);
  assert.match(message.text, /all_idle: no turn or task is running in the 2 watched sessions/);
});

test('archiving a watched session or the watcher ends the subscription', () => {
  const { db, service, emitted } = setup();
  const both = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER, DOCS] });
  const single = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [DOCS] });
  db.prepare(`UPDATE conversations SET archived = 1 WHERE id = ?`).run(DOCS);
  service.noteConversationGone(DOCS);
  const active = service.listActive();
  assert.deepEqual(active.map((row) => row.id), [both.id]);
  assert.deepEqual(active[0].sessions.map((session) => session.id), [BUILDER]);
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER }).find((row) => row.id === single.id).endReason, 'archived');
  service.noteConversationGone(WATCHER);
  assert.equal(service.listActive().length, 0);
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER }).find((row) => row.id === both.id).endReason, 'watcher-archived');
  assert.ok(emitted.filter((entry) => entry.event === 'relay_event_subscriptions').length >= 3);
});

const SPARE = 'conv-fixture-spare';

test('a heartbeat comes at its interval only while work runs, coalesced and never capped', () => {
  const { db, service, clock } = setup();
  seedConversation(db, SPARE, 'Spare');
  const sub = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['question_asked'], heartbeatMinutes: 10 });
  assert.equal(sub.heartbeatMinutes, 10);
  clock.advance(30 * 60_000);
  assert.equal(eventMessages(db).length, 0, 'silent while everything is idle');
  startTurn(db, BUILDER, 'turn-long', { at: clock.now() });
  fillWakeHistory(db, RELAY_EVENT_LIMITS.wakesPerHour, clock);
  clock.advance(10 * 60_000);
  // Found by the 30 s sweep, then held for the 30 s coalescing.
  clock.advance(60_000);
  const [beat] = eventMessages(db);
  assert.ok(beat, 'a heartbeat is not held by the cap');
  assert.match(beat.text, /heartbeat: still watching 1 session \(subscription sub_[0-9a-f]+\); working: "Orbit camera" \(turn\)/);
  assert.doesNotMatch(beat.text, /Digest/);
  const wakes = db.prepare(`SELECT COUNT(DISTINCT message_id) AS n FROM relay_events WHERE watcher_conversation_id = ? AND type <> 'heartbeat' AND message_id IS NOT NULL`).get(WATCHER).n;
  assert.equal(wakes, RELAY_EVENT_LIMITS.wakesPerHour, 'the heartbeat did not count');
  db.prepare(`UPDATE queue SET status = 'processing' WHERE id = ?`).run(beat.id);
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'turn-long'`).run();
  clock.advance(30 * 60_000);
  assert.equal(eventMessages(db).length, 1, 'no heartbeat once the watched set is idle');
  assert.equal(service.listActive()[0].firedCount, 0, 'a heartbeat does not fire the subscription');
});

test('a subscription with a heartbeat still gets all_idle, and a short gap is not idle', () => {
  const { db, service, clock } = setup();
  startTurn(db, BUILDER, 'turn-a');
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['all_idle'], heartbeatMinutes: 5 });
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'turn-a'`).run();
  service.afterStateChange(BUILDER);
  clock.advance(3_000);
  // The next turn starts within the settle time: no all_idle for that gap.
  startTurn(db, BUILDER, 'turn-b', { at: clock.now() });
  service.afterStateChange(BUILDER);
  clock.advance(60_000);
  assert.equal(eventMessages(db).length, 0);
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'turn-b'`).run();
  // Found by the sweep alone this time (no state change reported).
  clock.advance(90_000);
  const [message] = eventMessages(db);
  assert.match(message.text, /all_idle/);
});

test('transfer moves every subscription with its settings and its undelivered events', () => {
  const { db, service, clock } = setup();
  seedConversation(db, SPARE, 'Relay assistant, fresh');
  const listed = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER, SPARE], once: true, match: 'ready', events: ['turn_end'], stalledMinutes: 7 });
  const everything = service.subscribe({ watcherConversationId: WATCHER, scope: 'all', heartbeatMinutes: 60 });
  service.noteTurnEnd({ conversationId: DOCS, replyText: 'docs ready' });
  const preview = service.previewTransfer({ fromConversationId: WATCHER, toConversationId: SPARE });
  assert.deepEqual([preview.count, preview.includesAll, preview.from.title], [2, true, 'relay assistant']);
  const result = service.transferSubscriptions({ fromConversationId: WATCHER, toConversationId: SPARE });
  assert.deepEqual(result.moved.map((sub) => sub.id).sort(), [listed.id, everything.id].sort());
  const moved = Object.fromEntries(service.listSubscriptions({ watcherConversationId: SPARE }).map((sub) => [sub.id, sub]));
  assert.deepEqual(moved[listed.id].sessions.map((session) => session.id), [BUILDER], 'the new watcher is never watched');
  assert.equal(moved[listed.id].once, true);
  assert.equal(moved[listed.id].match, 'ready');
  assert.equal(moved[listed.id].stalledMinutes, 7);
  assert.equal(moved[everything.id].heartbeatMinutes, 60);
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER }).length, 0);
  clock.advance(30_000);
  assert.equal(eventMessages(db, WATCHER).length, 0, 'the old watcher gets nothing');
  assert.match(eventMessages(db, SPARE)[0].text, /docs ready/);
  service.noteTurnEnd({ conversationId: SPARE, replyText: 'mine' });
  service.noteTurnEnd({ conversationId: WATCHER, replyText: 'the old one now counts as a session' });
  db.prepare(`UPDATE queue SET status = 'processing'`).run();
  clock.advance(30_000);
  const second = eventMessages(db, SPARE)[1];
  assert.match(second.text, /the old one now counts as a session/);
  assert.doesNotMatch(second.text, /"mine"/);
  assert.throws(() => service.transferSubscriptions({ fromConversationId: WATCHER, toConversationId: SPARE }), (error) => error.code === 'notFound');
  assert.throws(() => service.transferSubscriptions({ fromConversationId: SPARE, toConversationId: SPARE }), (error) => error.code === 'invalid');
});

test('all_idle fires under a subscription to all sessions although an old run row is still marked running', () => {
  const { db, service, clock } = setup();
  // A run its worker never closed, months ago: not running work.
  const stale = new Date(T0 - 60 * 24 * 60 * 60_000).toISOString();
  db.prepare(`
    INSERT INTO subagent_runs (id, queue_message_id, conversation_id, display_name, status, started_at, updated_at, background)
    VALUES ('run_fixture_forgotten', 'q-fixture', ?, 'Forgotten', 'running', ?, ?, 1)
  `).run(DOCS, stale, stale);
  startTurn(db, BUILDER, 'turn-busy-all');
  service.subscribe({ watcherConversationId: WATCHER, scope: 'all', events: ['all_idle'] });
  clock.advance(60_000);
  assert.equal(eventMessages(db).length, 0, 'the turn is still running');
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'turn-busy-all'`).run();
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'done' });
  clock.advance(60_000);
  const [message] = eventMessages(db);
  assert.ok(message, 'all_idle fired');
  assert.match(message.text, /all_idle: no turn or task is running in any watched session/);
});
