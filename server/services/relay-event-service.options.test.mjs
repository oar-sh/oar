import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_EVENT_LIMITS, RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { createSessionActivityTracker } from './session-activity-tracker.mjs';
import { RelayEventError, createRelayEventService } from './relay-event-service.mjs';

// Subscription options: digest_minutes, quiet_hours, exclude, and the
// watcher's own prompts (no turn_end for a reply it waited for itself).

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const MINUTE = 60_000;
const WATCHER = 'conv-fixture-watcher';
const BUILDER = 'conv-fixture-builder';
const DOCS = 'conv-fixture-docs';
const RELAY_A_ID = 'relay-fixture-a';
const B_ON_A = 'rr_fixture_b';

function seedConversation(db, id, title, start) {
  const at = new Date(start - MINUTE).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES (?, ?, ?, ?, 'claude-sonnet-5', 'claude', 'claude-sonnet-5', ?, ?)
  `).run(`rs-${id}`, id, `sdk-${id}`, `key-${id}`, at, at);
}

function createClock(start = T0) {
  let clock = start;
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
    advanceTo(ms) {
      this.advance(Math.max(0, ms - clock));
    },
  };
}

function setup({ db = null, clock = createClock(), conversations = [[WATCHER, 'relay assistant'], [BUILDER, 'Orbit camera'], [DOCS, 'Docs pass']], name = 'bench-relay' } = {}) {
  const database = db || new Database(':memory:');
  if (!db) {
    applySchema(database);
    for (const [id, title] of conversations) seedConversation(database, id, title, clock.now());
  }
  const stmts = { ...createSessionRepository(database), ...createMessageRepository(database) };
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
    relayName: () => name,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { log() {}, warn() {} },
  });
  service.start();
  return { db: database, service, tracker, clock };
}

function eventMessages(db, conversationId = WATCHER) {
  return db.prepare(`SELECT m.id, m.text, q.status FROM messages m JOIN queue q ON q.id = m.id WHERE m.conversation_id = ? AND m.kind = ? ORDER BY m.timestamp ASC`)
    .all(conversationId, RELAY_EVENT_MESSAGE_KIND);
}

/** The watcher took its event row: the next event is a wake-up of its own. */
function takeAll(db) {
  db.prepare(`UPDATE queue SET status = 'processing' WHERE status = 'pending'`).run();
}

function startTurn(db, conversationId, id, at) {
  const iso = new Date(at).toISOString();
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, timestamp) VALUES (?, ?, 'user', 'go on', ?)`).run(id, conversationId, iso);
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp, processing_at) VALUES (?, ?, 'go on', 'processing', ?, ?)`)
    .run(id, conversationId, iso, iso);
}

const invalid = (pattern) => (error) => error instanceof RelayEventError && error.code === 'invalid' && pattern.test(error.message);

// ─── Checks ──────────────────────────────────────────────────────────────────

test('the options are checked, clamped like the other minutes, and listed', () => {
  const { service } = setup();
  const sub = service.subscribe({
    watcherConversationId: WATCHER,
    scope: 'all',
    digestMinutes: 5000,
    quietHours: { from: '23:00', to: '6:00', tz: 'Europe/Berlin' },
    exclude: [DOCS, DOCS, WATCHER],
  });
  assert.equal(sub.digestMinutes, RELAY_EVENT_LIMITS.digestMinutesMax);
  assert.deepEqual(sub.quietHours, { from: '23:00', to: '06:00', tz: 'Europe/Berlin' });
  assert.deepEqual(sub.exclude, [DOCS, WATCHER], 'the watcher may name itself: it is never watched anyway');
  assert.equal(service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], digestMinutes: 0 }).digestMinutes, 1);
  const plain = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [DOCS] });
  assert.equal('digestMinutes' in plain || 'quietHours' in plain || 'exclude' in plain, false, 'no options, nothing listed');
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], digestMinutes: 'soon' }), invalid(/digest_minutes/));
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], quietHours: { from: '23:00', to: '06:00', tz: 'Mars/Base' } }), invalid(/IANA/));
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], quietHours: { from: '23:00', to: '06:00' } }), invalid(/tz/));
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], exclude: [DOCS] }), invalid(/"all"/));
  const many = Array.from({ length: RELAY_EVENT_LIMITS.excludeMax + 1 }, (_, index) => `conv-fixture-${index}`);
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, scope: 'all', exclude: many }), invalid(/at most 50/));
  const listed = service.listSubscriptions({ watcherConversationId: WATCHER }).find((row) => row.id === sub.id);
  assert.equal(listed.heldCount, 0);
  assert.equal(listed.nextDeliveryAt, null);
});

test('without migration 0019 the options are refused, and plain subscriptions still work', () => {
  const db = new Database(':memory:');
  applySchema(db);
  db.exec(`ALTER TABLE relay_event_subscriptions DROP COLUMN quiet_hours_json`);
  const { service } = setup({ db });
  seedConversation(db, WATCHER, 'relay assistant', T0);
  seedConversation(db, BUILDER, 'Orbit camera', T0);
  assert.equal(service.areOptionsAvailable(), false);
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], digestMinutes: 10 }), (error) => error.code === 'unavailable');
  assert.ok(service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] }).id);
  assert.equal(service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-fixture' }), false);
});

// ─── Digest ──────────────────────────────────────────────────────────────────

test('a digest gathers non-urgent events and sends one row every N minutes', () => {
  const { db, service, clock } = setup();
  const sub = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER, DOCS], digestMinutes: 10 });
  clock.advance(MINUTE);
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'first' });
  clock.advance(2 * MINUTE);
  service.noteTurnEnd({ conversationId: DOCS, replyText: 'second' });
  clock.advance(MINUTE);
  assert.equal(eventMessages(db).length, 0, 'not after the 30 s coalescing');
  const listed = service.listSubscriptions({ watcherConversationId: WATCHER })[0];
  assert.equal(listed.heldCount, 2);
  assert.equal(listed.nextDeliveryAt, new Date(T0 + 10 * MINUTE).toISOString(), 'ten minutes after the subscription began');
  clock.advanceTo(T0 + 10 * MINUTE);
  const [digest] = eventMessages(db);
  assert.match(digest.text, new RegExp(`^Digest of 2 events \\(subscription ${sub.id} every 10 min; questions and errors come at once\\):$`, 'm'));
  assert.match(digest.text, /"first"[\s\S]*"second"/);
  takeAll(db);
  // The next row is due ten minutes after this one.
  clock.advance(MINUTE);
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'third' });
  clock.advanceTo(T0 + 20 * MINUTE - 1);
  assert.equal(eventMessages(db).length, 1);
  clock.advance(1);
  assert.equal(eventMessages(db).length, 2);
  assert.match(eventMessages(db)[1].text, /"third"/);
  takeAll(db);
  // A quiet spell longer than the interval: the next event only waits for the coalescing.
  clock.advanceTo(T0 + 45 * MINUTE);
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'fourth' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventMessages(db).length, 3);
  assert.match(eventMessages(db)[2].text, /"fourth"/);
  assert.doesNotMatch(eventMessages(db)[2].text, /Digest/, 'a digest of one event reads as that event');
});

test('questions and errors pass a digest at once, alone, and are not repeated in it', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], digestMinutes: 30 });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'quiet news' });
  clock.advance(MINUTE);
  service.noteError({ conversationId: BUILDER, kind: 'turn_failed', message: 'the build broke' });
  clock.advance(0);
  const [urgent] = eventMessages(db);
  assert.match(urgent.text, /error turn_failed: the build broke/);
  assert.doesNotMatch(urgent.text, /quiet news/, 'the held event stays held');
  takeAll(db);
  service.noteQuestion({ id: 'q-fixture-1', conversationId: BUILDER, prompt: 'Retry?', choices: ['Yes', 'No'] });
  clock.advance(0);
  assert.equal(eventMessages(db).length, 2);
  assert.match(eventMessages(db)[1].text, /question_asked "Retry\?"/);
  takeAll(db);
  clock.advanceTo(T0 + 30 * MINUTE);
  const digest = eventMessages(db)[2];
  assert.match(digest.text, /quiet news/);
  assert.doesNotMatch(digest.text, /error turn_failed|question_asked/);
});

test('a heartbeat is not held by a digest', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['all_idle'], heartbeatMinutes: 5, digestMinutes: 60 });
  startTurn(db, BUILDER, 'turn-long', clock.now());
  clock.advance(6 * MINUTE);
  const [beat] = eventMessages(db);
  assert.ok(beat, 'the heartbeat went within minutes');
  assert.match(beat.text, /heartbeat: still watching/);
  assert.doesNotMatch(beat.text, /Digest/);
});

test('the hourly cap stays the outer limit over a short digest', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], digestMinutes: 1 });
  for (let index = 0; index < RELAY_EVENT_LIMITS.wakesPerHour; index += 1) {
    const at = new Date(clock.now() - (RELAY_EVENT_LIMITS.wakesPerHour - index) * MINUTE).toISOString();
    db.prepare(`
      INSERT INTO relay_events (subscription_id, watcher_conversation_id, session_id, type, payload_json, created_at, delivered_at, message_id)
      VALUES ('sub_earlier', ?, ?, 'turn_end', '{}', ?, ?, ?)
    `).run(WATCHER, BUILDER, at, at, `earlier-${index}`);
  }
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'capped' });
  clock.advance(5 * MINUTE);
  assert.equal(eventMessages(db).length, 0, 'the digest of one minute is due, the cap is not');
  clock.advance(4 * MINUTE);
  const [message] = eventMessages(db);
  assert.match(message.text, /"capped"/);
  // The cap's digest and the subscription's are one line.
  assert.deepEqual(message.text.split('\n').filter((line) => line.startsWith('Digest of')).length, 1);
  assert.match(message.text, /^Digest of 1 event \(the limit of 20 wake-ups an hour is reached; .*; subscription sub_[0-9a-f]+ every 1 min; questions and errors come at once\):$/m);
});

// ─── Quiet hours ─────────────────────────────────────────────────────────────

test('quiet hours hold non-urgent events until the window ends, as one row that says so', () => {
  const { db, service, clock } = setup();
  const sub = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], quietHours: { from: '09:00', to: '12:00', tz: 'UTC' } });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'during the window' });
  clock.advance(30 * MINUTE);
  service.noteTaskEdge({ type: 'task_failed', conversationId: BUILDER, task: { kind: 'shell', description: 'npm test', status: 'failed', exitCode: 1 } });
  clock.advance(MINUTE);
  assert.equal(eventMessages(db).length, 0);
  const listed = service.listSubscriptions({ watcherConversationId: WATCHER })[0];
  assert.deepEqual([listed.heldCount, listed.nextDeliveryAt], [2, '2026-03-02T12:00:00.000Z']);
  // A question still goes at once.
  service.noteQuestion({ id: 'q-fixture-2', conversationId: BUILDER, prompt: 'Ship it?', choices: [] });
  clock.advance(0);
  assert.equal(eventMessages(db).length, 1);
  assert.doesNotMatch(eventMessages(db)[0].text, /during the window/);
  takeAll(db);
  clock.advanceTo(Date.parse('2026-03-02T12:00:00.000Z') - 1);
  assert.equal(eventMessages(db).length, 1);
  clock.advance(1);
  const held = eventMessages(db)[1];
  assert.match(held.text, /^Held during quiet hours \(09:00–12:00 UTC\): 2 events, delivered now that the window has ended/m);
  assert.match(held.text, /"during the window"[\s\S]*task_failed "npm test"/);
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER })[0].heldCount, 0);
  assert.equal(sub.quietHours.tz, 'UTC');
});

test('a window that crosses midnight on the night the clocks go back ends at 06:00 local winter time', () => {
  // 2026-10-24 21:30 UTC is 23:30 CEST; at 01:00 UTC Berlin goes back to CET.
  const clock = createClock(Date.parse('2026-10-24T21:30:00.000Z'));
  const { db, service } = setup({ clock });
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], quietHours: { from: '23:00', to: '06:00', tz: 'Europe/Berlin' } });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'late night' });
  clock.advanceTo(Date.parse('2026-10-25T04:00:00.000Z'));
  assert.equal(eventMessages(db).length, 0, '06:00 summer time would be 04:00 UTC: still quiet');
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER })[0].nextDeliveryAt, '2026-10-25T05:00:00.000Z');
  clock.advanceTo(Date.parse('2026-10-25T05:00:00.000Z'));
  assert.match(eventMessages(db)[0].text, /Held during quiet hours \(23:00–06:00 Europe\/Berlin\): 1 event[\s\S]*"late night"/);
});

test('an event before the window goes as usual, and no heartbeat is made inside it', () => {
  const clock = createClock(Date.parse('2026-03-02T20:58:00.000Z'));
  const { db, service } = setup({ clock });
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], heartbeatMinutes: 5, quietHours: { from: '21:00', to: '23:00', tz: 'UTC' } });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'before' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db)[0].text, /"before"/);
  takeAll(db);
  startTurn(db, BUILDER, 'turn-night', clock.now());
  clock.advanceTo(Date.parse('2026-03-02T22:59:00.000Z'));
  assert.equal(eventMessages(db).length, 1, 'two hours of work, no heartbeat');
  clock.advanceTo(Date.parse('2026-03-02T23:01:30.000Z'));
  assert.equal(eventMessages(db).length, 2);
  assert.match(eventMessages(db)[1].text, /heartbeat: still watching/);
});

test('digest and quiet hours together: a digest due in the window waits for its end', () => {
  const clock = createClock(Date.parse('2026-03-02T08:50:00.000Z'));
  const { db, service } = setup({ clock });
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], digestMinutes: 20, quietHours: { from: '09:00', to: '10:00', tz: 'UTC' } });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'gathered' });
  clock.advanceTo(Date.parse('2026-03-02T09:59:00.000Z'));
  assert.equal(eventMessages(db).length, 0);
  clock.advanceTo(Date.parse('2026-03-02T10:00:00.000Z'));
  assert.match(eventMessages(db)[0].text, /Held during quiet hours[\s\S]*"gathered"/);
});

test('of two subscriptions that take an event, the one without options lets it go', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], digestMinutes: 60 });
  service.subscribe({ watcherConversationId: WATCHER, scope: 'all' });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'both took it' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db)[0].text, /"both took it"/);
  assert.doesNotMatch(eventMessages(db)[0].text, /Digest/);
});

test('held events and their timers survive a restart', () => {
  const first = setup();
  first.service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], quietHours: { from: '09:00', to: '12:00', tz: 'UTC' } });
  first.service.subscribe({ watcherConversationId: WATCHER, sessionIds: [DOCS], digestMinutes: 45 });
  first.service.noteTurnEnd({ conversationId: BUILDER, replyText: 'held through quiet hours' });
  first.service.noteTurnEnd({ conversationId: DOCS, replyText: 'held for the digest' });
  first.clock.advance(5 * MINUTE);
  first.service.stop();
  const second = setup({ db: first.db, clock: first.clock });
  const listed = second.service.listSubscriptions({ watcherConversationId: WATCHER });
  assert.deepEqual(listed.map((sub) => sub.heldCount), [1, 1]);
  second.clock.advanceTo(T0 + 45 * MINUTE);
  assert.equal(eventMessages(first.db).length, 1);
  assert.match(eventMessages(first.db)[0].text, /held for the digest/);
  assert.doesNotMatch(eventMessages(first.db)[0].text, /held through quiet hours/);
  takeAll(first.db);
  second.clock.advanceTo(Date.parse('2026-03-02T12:00:00.000Z'));
  assert.match(eventMessages(first.db)[1].text, /Held during quiet hours[\s\S]*held through quiet hours/);
});

// ─── Exclude ─────────────────────────────────────────────────────────────────

test('an "all" subscription leaves out the excluded sessions, for all_idle too', () => {
  const { db, service, clock } = setup();
  startTurn(db, BUILDER, 'turn-builder', clock.now());
  startTurn(db, DOCS, 'turn-docs', clock.now());
  service.subscribe({ watcherConversationId: WATCHER, scope: 'all', events: ['turn_end', 'error', 'all_idle'], exclude: [DOCS] });
  service.noteTurnEnd({ conversationId: DOCS, replyText: 'not for you' });
  service.noteError({ conversationId: DOCS, message: 'nor this' });
  clock.advance(MINUTE);
  assert.equal(eventMessages(db).length, 0);
  db.prepare(`UPDATE queue SET status = 'done' WHERE id = 'turn-builder'`).run();
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'turn-builder', replyText: 'for you' });
  clock.advance(MINUTE);
  const [message] = eventMessages(db);
  assert.match(message.text, /"for you"/);
  assert.match(message.text, /all_idle/, 'the excluded session still runs; all_idle does not wait for it');
  assert.doesNotMatch(message.text, /not for you|nor this/);
});

// ─── The watcher's own prompts ───────────────────────────────────────────────

test('a reply the watcher waited for itself is not delivered again as turn_end', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  assert.equal(service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-own-1' }), true);
  const wait = service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-own-1', waitMs: 120_000 });
  assert.ok(wait);
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-own-1', replyText: 'here is your answer' });
  clock.advance(MINUTE);
  assert.equal(eventMessages(db).length, 0, 'held while the watcher waits');
  assert.equal(service.endOwnWait(wait, { received: true }), 1);
  clock.advance(5 * MINUTE);
  assert.equal(eventMessages(db).length, 0);
  // Recorded after the wait (a paired relay's fetch comes later): not recorded at all.
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-own-1', replyText: 'here is your answer' });
  clock.advance(MINUTE);
  assert.equal(eventMessages(db).length, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_events WHERE watcher_conversation_id = ?`).get(WATCHER).n, 0);
  // Another turn of the session is delivered as usual.
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-someone-else', replyText: 'other work' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db)[0].text, /"other work"/);
});

test('a prompt the watcher did not wait for gets its turn_end as today', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-own-2' });
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-own-2', replyText: 'nobody waited' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db)[0].text, /"nobody waited"/);
});

test('a wait that ends without the finished reply lets the held turn_end go', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-own-3' });
  const wait = service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-own-3', waitMs: 30_000 });
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-own-3', replyText: 'answered, still working' });
  clock.advance(20_000);
  assert.equal(eventMessages(db).length, 0);
  // The wait came back "running".
  assert.equal(service.endOwnWait(wait, { received: false }), 0);
  // The usual 30 s coalescing from the turn's end.
  clock.advance(10_000);
  assert.match(eventMessages(db)[0].text, /"answered, still working"/);
});

test('errors and questions of the watcher\'s own turn still go at once', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-own-4' });
  const wait = service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-own-4', waitMs: 120_000 });
  service.noteQuestion({ id: 'q-fixture-own', conversationId: BUILDER, prompt: 'Which branch?', choices: ['main', 'dev'] });
  clock.advance(0);
  assert.match(eventMessages(db)[0].text, /question_asked "Which branch\?"/);
  takeAll(db);
  service.noteError({ conversationId: BUILDER, kind: 'turn_failed', message: 'it crashed', queueMessageId: 'msg-own-4' });
  clock.advance(0);
  assert.match(eventMessages(db)[1].text, /error turn_failed: it crashed/);
  service.endOwnWait(wait, { received: true });
});

test('only the watcher\'s own prompt is held: another watcher\'s wait changes nothing, a lost wait expires', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  service.noteOwnPrompt({ watcherConversationId: DOCS, sessionId: BUILDER, messageId: 'msg-docs' });
  assert.equal(service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-docs', waitMs: 120_000 }), null);
  assert.equal(service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-never-sent', waitMs: 120_000 }), null);
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-docs', replyText: 'for the docs session' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db)[0].text, /"for the docs session"/);
  takeAll(db);
  // A wait that never reports back holds no longer than it could have lasted.
  service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-own-5' });
  service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-own-5', waitMs: 60_000 });
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-own-5', replyText: 'nobody came back' });
  clock.advance(MINUTE + 59_000);
  assert.equal(eventMessages(db).length, 1);
  clock.advance(1_000);
  assert.match(eventMessages(db)[1].text, /"nobody came back"/);
});

test('a one-shot turn_end of the watcher\'s own turn is still delivered: it ends the subscription', () => {
  const { db, service, clock } = setup();
  const sub = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['turn_end'], once: true });
  service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-own-6' });
  const wait = service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-own-6', waitMs: 120_000 });
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-own-6', replyText: 'the one' });
  service.endOwnWait(wait, { received: true });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db)[0].text, new RegExp(`one-shot subscription ${sub.id} ended`));
});

// ─── Across relays ───────────────────────────────────────────────────────────

test('on a paired relay\'s sessions the options apply on the watching relay', () => {
  const clock = createClock();
  const a = setup({ clock, conversations: [[WATCHER, 'relay assistant']], name: 'win-test' });
  const b = setup({ clock, conversations: [[BUILDER, 'Orbit camera'], [DOCS, 'Docs pass']], name: 'linux-test' });
  const remote = b.service.subscribeServed({ subscriberRelayId: RELAY_A_ID, watcherId: WATCHER, scope: 'all', exclude: [DOCS] });
  assert.deepEqual(remote.exclude, [DOCS], 'the watched relay knows what is left out');
  const mirror = a.service.addMirror({
    watcherConversationId: WATCHER,
    relayId: B_ON_A,
    relayName: 'linux-test',
    remote: { ...remote, exclude: undefined },
    digestMinutes: 15,
    exclude: [DOCS],
  });
  assert.deepEqual([mirror.digestMinutes, mirror.exclude], [15, [DOCS]]);
  const pull = () => {
    const body = a.service.buildRemotePull(B_ON_A);
    a.service.applyRemotePull(B_ON_A, { relayName: 'linux-test', response: b.service.pullServed({ subscriberRelayId: RELAY_A_ID, ...body }) });
  };
  b.service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-b-1', replyText: 'from the paired relay' });
  b.service.noteTurnEnd({ conversationId: DOCS, replyText: 'left out there' });
  assert.equal(b.db.prepare(`SELECT COUNT(*) AS n FROM relay_events`).get().n, 1, 'the excluded session records nothing there');
  // An older watched relay would send it anyway: the watching relay drops it.
  b.db.prepare(`UPDATE relay_event_subscriptions SET exclude_json = NULL`).run();
  b.service.noteTurnEnd({ conversationId: DOCS, replyText: 'sent by an older relay' });
  pull();
  clock.advance(MINUTE);
  assert.equal(eventMessages(a.db).length, 0, 'held for the digest');
  assert.equal(a.service.listSubscriptions({ watcherConversationId: WATCHER })[0].heldCount, 1);
  clock.advanceTo(T0 + 15 * MINUTE);
  const [digest] = eventMessages(a.db);
  assert.match(digest.text, /linux-test · session "Orbit camera"[\s\S]*"from the paired relay"/);
  assert.doesNotMatch(digest.text, /left out there|sent by an older relay/);
});

test('a paired relay\'s turn_end of the watcher\'s own prompt is dropped when the reply was received', () => {
  const clock = createClock();
  const a = setup({ clock, conversations: [[WATCHER, 'relay assistant']], name: 'win-test' });
  const b = setup({ clock, conversations: [[BUILDER, 'Orbit camera']], name: 'linux-test' });
  const remote = b.service.subscribeServed({ subscriberRelayId: RELAY_A_ID, watcherId: WATCHER, sessionIds: [BUILDER] });
  a.service.addMirror({ watcherConversationId: WATCHER, relayId: B_ON_A, relayName: 'linux-test', remote });
  a.service.noteOwnPrompt({ watcherConversationId: WATCHER, relayId: B_ON_A, sessionId: BUILDER, messageId: 'msg-across' });
  const wait = a.service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-across', waitMs: 120_000 });
  b.service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-across', replyText: 'answered across' });
  // The wait saw the reply before the next fetch.
  a.service.endOwnWait(wait, { received: true });
  const body = a.service.buildRemotePull(B_ON_A);
  a.service.applyRemotePull(B_ON_A, { relayName: 'linux-test', response: b.service.pullServed({ subscriberRelayId: RELAY_A_ID, ...body }) });
  clock.advance(5 * MINUTE);
  assert.equal(eventMessages(a.db).length, 0);
});

// ─── Fix round: one-shot, replay, clock change, steering ─────────────────────

test('a one-shot subscription ends with the watcher\'s own turn_end also when it comes after the wait', () => {
  const { db, service, clock } = setup();
  const sub = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['turn_end'], once: true });
  service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-own-late' });
  const wait = service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-own-late', waitMs: 120_000 });
  // The reply is committed and seen by the wait before the turn's end is reported.
  service.endOwnWait(wait, { received: true });
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-own-late', replyText: 'late end' });
  assert.equal(service.listActive().length, 0, 'the one-shot subscription ended');
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER })[0].endReason, 'fired');
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db)[0].text, new RegExp(`"late end"[\\s\\S]*one-shot subscription ${sub.id} ended`));
});

test('a paired relay\'s one-shot turn_end of the watcher\'s own prompt still ends the mirror after the wait', () => {
  const clock = createClock();
  const a = setup({ clock, conversations: [[WATCHER, 'relay assistant']], name: 'win-test' });
  const b = setup({ clock, conversations: [[BUILDER, 'Orbit camera']], name: 'linux-test' });
  const remote = b.service.subscribeServed({ subscriberRelayId: RELAY_A_ID, watcherId: WATCHER, sessionIds: [BUILDER], events: ['turn_end'], once: true });
  const mirror = a.service.addMirror({ watcherConversationId: WATCHER, relayId: B_ON_A, relayName: 'linux-test', remote });
  a.service.noteOwnPrompt({ watcherConversationId: WATCHER, relayId: B_ON_A, sessionId: BUILDER, messageId: 'msg-across-once' });
  a.service.endOwnWait(a.service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-across-once', waitMs: 60_000 }), { received: true });
  b.service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-across-once', replyText: 'done there' });
  const body = a.service.buildRemotePull(B_ON_A);
  a.service.applyRemotePull(B_ON_A, { relayName: 'linux-test', response: b.service.pullServed({ subscriberRelayId: RELAY_A_ID, ...body }) });
  assert.equal(a.service.listSubscriptions({ watcherConversationId: WATCHER }).find((sub) => sub.id === mirror.id).endReason, 'fired');
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(a.db)[0].text, new RegExp(`"done there"[\\s\\S]*one-shot subscription ${mirror.id} ended`));
});

test('a one-shot subscription keeps to its own quiet hours, even after the watcher\'s other subscription ends', () => {
  const { db, service, clock } = setup();
  const once = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], once: true, quietHours: { from: '09:00', to: '12:00', tz: 'UTC' } });
  const other = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [DOCS] });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'inside the window' });
  assert.deepEqual(service.listActive().map((sub) => sub.id), [other.id], 'fired');
  service.unsubscribe({ watcherConversationId: WATCHER, subscriptionId: other.id });
  clock.advance(30 * MINUTE);
  assert.equal(eventMessages(db).length, 0, 'held by the window');
  const listed = service.listSubscriptions({ watcherConversationId: WATCHER }).find((sub) => sub.id === once.id);
  assert.deepEqual([listed.endReason, listed.heldCount, listed.nextDeliveryAt], ['fired', 1, '2026-03-02T12:00:00.000Z']);
  clock.advanceTo(Date.parse('2026-03-02T12:00:00.000Z'));
  const [message] = eventMessages(db);
  assert.match(message.text, /Held during quiet hours \(09:00–12:00 UTC\)[\s\S]*"inside the window"/);
  assert.match(message.text, new RegExp(`one-shot subscription ${once.id} ended`));
});

test('a fired one-shot\'s event filed under another subscription survives that one\'s unsubscribe', () => {
  const { db, service, clock } = setup();
  const digest = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], digestMinutes: 60 });
  clock.advance(1);
  const once = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], once: true, quietHours: { from: '09:00', to: '12:00', tz: 'UTC' } });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'for both' });
  const [row] = db.prepare(`SELECT subscription_id FROM relay_events WHERE watcher_conversation_id = ?`).all(WATCHER);
  assert.equal(row.subscription_id, digest.id, 'recorded under the first subscription that took it');
  assert.deepEqual(service.listActive().map((sub) => sub.id), [digest.id], 'the one-shot fired');
  clock.advance(5 * MINUTE);
  // The watcher's last active subscription ends: the one-shot's event is still owed.
  service.unsubscribe({ watcherConversationId: WATCHER, subscriptionId: digest.id });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_events WHERE watcher_conversation_id = ? AND delivered_at IS NULL`).get(WATCHER).n, 1);
  // Held by the one-shot's quiet hours now, not by the digest that ended.
  clock.advanceTo(Date.parse('2026-03-02T11:59:00.000Z'));
  assert.equal(eventMessages(db).length, 0);
  clock.advanceTo(Date.parse('2026-03-02T12:00:00.000Z'));
  const [message] = eventMessages(db);
  assert.match(message.text, /Held during quiet hours \(09:00–12:00 UTC\)[\s\S]*"for both"/);
  assert.match(message.text, new RegExp(`one-shot subscription ${once.id} ended`));
});

test('a one-shot subscription keeps to its own digest', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], once: true, digestMinutes: 10 });
  clock.advance(MINUTE);
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'gathered once' });
  clock.advanceTo(T0 + 10 * MINUTE - 1);
  assert.equal(eventMessages(db).length, 0);
  clock.advance(1);
  assert.match(eventMessages(db)[0].text, /"gathered once"/);
});

test('events replayed after a link gap keep to the options; questions still come at once', () => {
  const clock = createClock();
  const a = setup({ clock, conversations: [[WATCHER, 'relay assistant']], name: 'win-test' });
  const b = setup({ clock, conversations: [[BUILDER, 'Orbit camera']], name: 'linux-test' });
  const remote = b.service.subscribeServed({ subscriberRelayId: RELAY_A_ID, watcherId: WATCHER, sessionIds: [BUILDER] });
  const mirror = a.service.addMirror({
    watcherConversationId: WATCHER, relayId: B_ON_A, relayName: 'linux-test', remote, quietHours: { from: '09:00', to: '12:00', tz: 'UTC' },
  });
  // While the link was down.
  b.service.noteTurnEnd({ conversationId: BUILDER, replyText: 'kept reply' });
  b.service.noteQuestion({ id: 'q-fixture-kept', conversationId: BUILDER, prompt: 'Go ahead?', choices: [] });
  const body = a.service.buildRemotePull(B_ON_A);
  const applied = a.service.applyRemotePull(B_ON_A, { relayName: 'linux-test', response: b.service.pullServed({ subscriberRelayId: RELAY_A_ID, ...body }), replay: true });
  assert.equal(applied.get(WATCHER).kept, 2);
  a.service.noteRemoteLinkRestored(B_ON_A, {
    relayName: 'linux-test',
    since: '2026-03-02T09:30:00.000Z',
    perWatcher: new Map([[WATCHER, { subscriptionId: mirror.id, kept: 2, dropped: 0, ended: [] }]]),
  });
  clock.advance(0);
  const [restored] = eventMessages(a.db);
  assert.match(restored.text, /link_lost[\s\S]*question_asked "Go ahead\?"[\s\S]*link_restored/);
  assert.match(restored.text, /1 of them is held by your subscription's digest or quiet hours and comes later/);
  assert.doesNotMatch(restored.text, /kept reply/);
  takeAll(a.db);
  clock.advanceTo(Date.parse('2026-03-02T12:00:00.000Z'));
  const held = eventMessages(a.db)[1];
  assert.match(held.text, /Held during quiet hours[\s\S]*"kept reply"/);
});

test('the night the clocks go forward, a window to 06:00 ends at 06:00 summer time', () => {
  // 2026-03-28 22:30 UTC is 23:30 CET; at 01:00 UTC Berlin moves to CEST.
  const clock = createClock(Date.parse('2026-03-28T22:30:00.000Z'));
  const { db, service } = setup({ clock });
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], quietHours: { from: '23:00', to: '06:00', tz: 'Europe/Berlin' } });
  service.noteTurnEnd({ conversationId: BUILDER, replyText: 'spring night' });
  assert.equal(service.listSubscriptions({ watcherConversationId: WATCHER })[0].nextDeliveryAt, '2026-03-29T04:00:00.000Z');
  clock.advanceTo(Date.parse('2026-03-29T04:00:00.000Z') - 1);
  assert.equal(eventMessages(db).length, 0);
  clock.advance(1);
  assert.match(eventMessages(db)[0].text, /"spring night"/);
});

test('a steered prompt whose turn_end carries another message\'s id is not deduped', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  service.noteOwnPrompt({ watcherConversationId: WATCHER, sessionId: BUILDER, messageId: 'msg-steered' });
  const wait = service.beginOwnWait({ watcherConversationId: WATCHER, messageId: 'msg-steered', waitMs: 120_000 });
  // The prompt was steered into the turn already running: its end names that turn's message.
  service.noteTurnEnd({ conversationId: BUILDER, queueMessageId: 'msg-running-turn', replyText: 'answered both' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db)[0].text, /"answered both"/, 'not held by the wait');
  assert.equal(service.endOwnWait(wait, { received: true }), 0);
});
