import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { RELAY_EVENT_LIMITS, RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { RemoteRelayError } from './remote-relay-client.mjs';
import { RELAY_EVENT_REMOTE_PULL_PATH, createRelayEventLinkService } from './relay-event-link-service.mjs';
import { createRelayEventService } from './relay-event-service.mjs';

// The watching relay's link: fetching on a timer, a gap and its one replayed
// row, an older relay, the removal of the pairing. Relay B is its event
// service, reached through a fake client.

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const A_ID = 'relay-fixture-a';
const B_ON_A = 'rr_fixture_b';
const ENTRY = Object.freeze({ id: B_ON_A, name: 'linux-test', url: 'https://relay-b.example.test', tokenMode: 'own' });
const WATCHER = 'conv-fixture-watcher';
const BUILDER = 'conv-fixture-builder';

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
    pending: () => timers.filter((timer) => !timer.done).map((timer) => timer.at - clock),
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        const next = timers.filter((timer) => !timer.done && timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = Math.max(clock, next.at);
        next.done = true;
        next.fn();
        // Let the fetch the timer started finish.
        for (let spin = 0; spin < 20; spin += 1) await new Promise((resolve) => setImmediate(resolve));
      }
      clock = until;
    },
  };
}

function eventRelay(conversations, clock) {
  const db = new Database(':memory:');
  applySchema(db);
  const iso = new Date(T0 - 60_000).toISOString();
  for (const [id, title] of conversations) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, iso, iso);
  }
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const service = createRelayEventService({
    db, stmts, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, logger: { log() {}, warn() {} },
  });
  return { db, service };
}

function setup() {
  const clock = createClock();
  const a = eventRelay([[WATCHER, 'relay assistant']], clock);
  const b = eventRelay([[BUILDER, 'Orbit camera']], clock);
  const state = { offline: false, missing: false, calls: 0, entries: new Map([[B_ON_A, ENTRY]]) };
  const client = {
    async request(relay, method, path, { body } = {}) {
      state.calls += 1;
      if (state.offline) throw new RemoteRelayError(CODES.offline, `Relay "${relay.name}" is not reachable (ECONNREFUSED)`);
      if (state.missing) throw new RemoteRelayError(CODES.notFound, `Relay "${relay.name}": not found`, { status: 404 });
      assert.equal(path, RELAY_EVENT_REMOTE_PULL_PATH);
      return { ok: true, ...b.service.pullServed({ subscriberRelayId: A_ID, ...body }) };
    },
  };
  const link = createRelayEventLinkService({
    relayEvents: a.service,
    registry: { get: (id) => state.entries.get(id) || null },
    client,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { log() {}, warn() {} },
  });
  function subscribe() {
    const remote = b.service.subscribeServed({ subscriberRelayId: A_ID, watcherId: WATCHER, sessionIds: [BUILDER] });
    return a.service.addMirror({ watcherConversationId: WATCHER, relayId: B_ON_A, relayName: 'linux-test', remote });
  }
  return { a, b, clock, state, link, subscribe };
}

// A worker took the watcher's event rows: later events start a row of their own.
function settleEventRows(db) {
  db.prepare(`UPDATE queue SET status = 'done' WHERE id IN (SELECT id FROM messages WHERE kind = ?)`).run(RELAY_EVENT_MESSAGE_KIND);
}

function eventTexts(db) {
  return db.prepare(`SELECT text FROM messages WHERE conversation_id = ? AND kind = ? ORDER BY timestamp ASC`).all(WATCHER, RELAY_EVENT_MESSAGE_KIND).map((row) => row.text);
}

test('fetches every few seconds while subscriptions exist, and stops when none are left', async () => {
  const { a, b, clock, state, link, subscribe } = setup();
  link.start();
  assert.equal(state.calls, 0, 'nothing to fetch without subscriptions');
  const mirror = subscribe();
  await link.fetchNow(B_ON_A);
  assert.deepEqual(clock.pending(), [RELAY_EVENT_LIMITS.remotePollMs]);
  b.service.noteTurnEnd({ conversationId: BUILDER, replyText: 'rendered' });
  await clock.advance(RELAY_EVENT_LIMITS.remotePollMs);
  await clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventTexts(a.db)[0], /linux-test · session "Orbit camera" \(conv-fixture-builder\): turn_end \(done\) "rendered"/);
  a.service.unsubscribe({ watcherConversationId: WATCHER, subscriptionId: mirror.id });
  await link.fetchNow(B_ON_A);
  assert.equal(b.service.listActive().length, 0);
  assert.equal(link.isPolling(B_ON_A), false);
  link.stop();
});

test('a short outage only delays; a long one ends in one replayed row with link_lost and link_restored', async () => {
  const { a, b, clock, state, link, subscribe } = setup();
  link.start();
  subscribe();
  await link.fetchNow(B_ON_A);
  state.offline = true;
  await clock.advance(20_000);
  b.service.noteTurnEnd({ conversationId: BUILDER, replyText: 'during a blip' });
  state.offline = false;
  await clock.advance(RELAY_EVENT_LIMITS.remotePollMs);
  await clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventTexts(a.db).length, 1);
  assert.doesNotMatch(eventTexts(a.db)[0], /link_lost|Replayed/);
  settleEventRows(a.db);
  // Now B is gone for five minutes; a question and a reply wait there.
  state.offline = true;
  await clock.advance(5 * 60_000);
  assert.equal(a.service.getRemoteLink(B_ON_A).lost_at !== null, true);
  assert.ok(clock.pending().every((delay) => delay <= RELAY_EVENT_LIMITS.remotePollFailingMs), 'fetched less often while failing');
  b.service.noteTurnEnd({ conversationId: BUILDER, replyText: 'while away' });
  b.service.noteQuestion({ id: 'q-fixture-away', conversationId: BUILDER, prompt: 'Ship?', choices: ['Yes'] });
  state.offline = false;
  await clock.advance(RELAY_EVENT_LIMITS.remotePollFailingMs);
  const texts = eventTexts(a.db);
  assert.equal(texts.length, 2);
  const lines = texts[1].split('\n');
  assert.match(lines[1], /linux-test · link_lost: no answer from relay "linux-test" since/);
  assert.match(lines[2], /^Replayed: 2 events/);
  assert.match(lines[3], /question_asked "Ship\?"/);
  assert.match(lines[4], /turn_end \(done\) "while away"/);
  assert.match(lines[5], /link_restored: relay "linux-test" answers again after \d+ min; 2 events it kept meanwhile are listed above$/);
  assert.equal(a.service.getRemoteLink(B_ON_A).lost_at, null);
  link.stop();
});

test('a restart of A after a long stop replays too; the cursor keeps anything from coming twice', async () => {
  const { a, b, clock, link, subscribe } = setup();
  subscribe();
  b.service.noteTurnEnd({ conversationId: BUILDER, replyText: 'before the stop' });
  await link.fetchNow(B_ON_A);
  link.stop();
  await clock.advance(10 * 60_000);
  settleEventRows(a.db);
  b.service.noteTurnEnd({ conversationId: BUILDER, replyText: 'while A was down' });
  const again = createRelayEventLinkService({
    relayEvents: a.service,
    registry: { get: () => ENTRY },
    client: { request: async (relay, method, path, { body }) => ({ ok: true, ...b.service.pullServed({ subscriberRelayId: A_ID, ...body }) }) },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { log() {}, warn() {} },
  });
  again.start();
  await clock.advance(0);
  const texts = eventTexts(a.db);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /"before the stop"/);
  assert.match(texts[1], /link_lost[\s\S]*"while A was down"[\s\S]*link_restored/);
  assert.doesNotMatch(texts[1], /before the stop/);
  again.stop();
});

test('an older paired relay without the routes leaves the link failing with a clear error', async () => {
  const { a, state, link, subscribe } = setup();
  subscribe();
  state.missing = true;
  const result = await link.fetchNow(B_ON_A);
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.match(a.service.getRemoteLink(B_ON_A).last_error, /runs an OAR version without event subscriptions across relays/);
});

test('removing the pairing tells the relay its subscriptions ended, then ends them here', async () => {
  const { a, b, state, link, subscribe } = setup();
  subscribe();
  state.entries.delete(B_ON_A);
  await link.noteRelayRemoved(ENTRY);
  assert.equal(b.service.listActive().length, 0);
  assert.equal(a.service.listSubscriptions({ watcherConversationId: WATCHER })[0].endReason, 'pairing-removed');
  assert.deepEqual(a.service.remoteRelaysToPoll(), []);
});

test('a pairing removed without the hook ends the mirrors at the next fetch', async () => {
  const { a, state, link, subscribe } = setup();
  subscribe();
  state.entries.delete(B_ON_A);
  const result = await link.fetchNow(B_ON_A);
  assert.equal(result.removed, true);
  assert.equal(a.service.listSubscriptions({ watcherConversationId: WATCHER })[0].endReason, 'pairing-removed');
});
