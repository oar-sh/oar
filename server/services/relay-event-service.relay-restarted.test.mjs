import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_EVENT_LIMITS, RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { RELAY_LAST_EXIT_SETTING_KEY, createRelayEventService } from './relay-event-service.mjs';

// relay_restarted: a conversation that asked for it is woken once when the
// relay runs again, and a turn it woke that restarts the relay again is not.

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const WATCHER = 'conv-fixture-watcher';
const COORDINATOR = 'conv-fixture-coordinator';
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

function seed(db) {
  const at = new Date(T0 - 60_000).toISOString();
  for (const [id, title] of [[WATCHER, 'relay assistant'], [COORDINATOR, 'batch coordinator'], [BUILDER, 'Orbit camera']]) {
    db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
    db.prepare(`
      INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
      VALUES (?, ?, ?, ?, 'claude-sonnet-5', 'claude', 'claude-sonnet-5', ?, ?)
    `).run(`rs-${id}`, id, `sdk-${id}`, `key-${id}`, at, at);
  }
}

/** One runtime of the relay on `db` (a new one per start, as after a restart). */
function boot({ db = null, clock = createClock() } = {}) {
  const database = db || new Database(':memory:');
  if (!db) {
    applySchema(database);
    seed(database);
  }
  const stmts = { ...createSessionRepository(database), ...createMessageRepository(database) };
  const wakes = [];
  const lines = [];
  const service = createRelayEventService({
    db: database,
    stmts,
    emit: () => {},
    wakeWatcher: (wake) => wakes.push(wake),
    relayName: () => 'bench-relay',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { log: (line) => lines.push(line), warn: (line) => lines.push(line) },
  });
  service.start();
  // The runtime notes its start once it listens (noteRelayStarted).
  const started = service.noteRelayStarted();
  return { db: database, service, clock, wakes, lines, started };
}

/** The next runtime on the same database: the one before stops, this one starts and notes its start. */
function restart(previous) {
  previous.service.stop();
  return boot({ db: previous.db, clock: previous.clock });
}

function eventMessages(db, conversationId) {
  return db.prepare(`
    SELECT m.id, m.text, q.status FROM messages m JOIN queue q ON q.id = m.id
    WHERE m.conversation_id = ? AND m.kind = ? ORDER BY m.timestamp ASC
  `).all(conversationId, RELAY_EVENT_MESSAGE_KIND);
}

function lastExit(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(RELAY_LAST_EXIT_SETTING_KEY);
  return row ? JSON.parse(row.value) : null;
}

test('relay_restarted alone needs no sessions; other events still do, and a paired relay cannot ask for it', () => {
  const { service } = boot();
  const sub = service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'], once: true });
  assert.deepEqual(sub.sessions, []);
  assert.deepEqual(sub.events, ['relay_restarted']);
  assert.equal(sub.once, true);
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER, events: ['turn_end'] }), (error) => error.code === 'invalid' && /needs sessions/.test(error.message));
  assert.throws(() => service.subscribe({ watcherConversationId: WATCHER }), (error) => error.code === 'invalid');
  // Nothing runs in a set of no sessions: a heartbeat would never come.
  assert.throws(
    () => service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'], heartbeatMinutes: 30 }),
    (error) => error.code === 'invalid' && /heartbeat_minutes needs sessions/.test(error.message),
  );
  const both = service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER], events: ['turn_end', 'relay_restarted'] });
  assert.deepEqual(both.events, ['turn_end', 'relay_restarted']);
  assert.throws(
    () => service.subscribeServed({ subscriberRelayId: 'rr_fixture', watcherId: 'conv-far', events: ['relay_restarted'], dryRun: true }),
    (error) => error.code === 'invalid' && /cannot be watched on another relay/.test(error.message),
  );
});

test('off by default: subscriptions that do not name relay_restarted are not woken by a restart', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: WATCHER, sessionIds: [BUILDER] });
  first.service.subscribe({ watcherConversationId: COORDINATOR, scope: 'all' });
  first.service.noteRelayExit({ action: 'restart', reason: 'manual-restart', requestedBy: 'localhost-api', requestedAt: new Date(T0).toISOString() });
  const second = restart(first);
  assert.deepEqual(second.started, { recorded: 0, skipped: [] });
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventMessages(second.db, WATCHER).length, 0);
  assert.equal(eventMessages(second.db, COORDINATOR).length, 0);
  assert.equal(second.wakes.length, 0);
  assert.equal(lastExit(second.db), null, 'the record of the end is taken all the same');
});

test('the start after a requested restart wakes the conversation that asked, once, with who asked and why', () => {
  const first = boot();
  const sub = first.service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'], once: true });
  first.clock.advance(60_000);
  first.service.noteRelayExit({ action: 'restart', reason: 'merged the batch', requestedBy: 'localhost-api', requestedAt: new Date(T0 + 30_000).toISOString() });
  // A second note of the same end (the generic exit after the queued one) changes nothing.
  first.service.noteRelayExit({ action: 'shutdown', reason: 'SIGTERM' });
  assert.equal(lastExit(first.db).reason, 'merged the batch');
  first.clock.advance(20_000);

  const second = restart(first);
  assert.deepEqual(second.started, { recorded: 1, skipped: [] });
  assert.equal(lastExit(second.db), null, 'taken with the events: a start is told once');
  assert.equal(eventMessages(second.db, WATCHER).length, 0, 'coalesced: the workers report back first');
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const [message] = eventMessages(second.db, WATCHER);
  assert.equal(message.status, 'pending');
  assert.match(message.text, /^\[relay event · automated message from OAR/);
  assert.match(message.text, /\[relay event\] relay_restarted: the relay runs again since 2026-03-02 10:01 UTC, after a restart requested by "localhost-api" at 2026-03-02 10:00 UTC \(reason "merged the batch"\)\./);
  assert.match(message.text, /A restart requested while this turn runs does not wake you again\./);
  assert.match(message.text, /one-shot subscription sub_[0-9a-f]+ ended with this event/);
  assert.equal(second.wakes.length, 1);
  assert.equal(second.service.listSubscriptions({ watcherConversationId: WATCHER }).find((row) => row.id === sub.id).endReason, 'fired');

  // The same runtime notes its start once; the next start finds the once subscription ended.
  assert.deepEqual(second.service.noteRelayStarted(), { recorded: 0, skipped: [] });
  const third = restart(second);
  assert.deepEqual(third.started, { recorded: 0, skipped: [] });
  third.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventMessages(third.db, WATCHER).length, 1);
});

test('a start without a record of the end says so; a signal is named', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'] });
  // No noteRelayExit: the process was killed.
  const second = restart(first);
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(second.db, WATCHER)[0].text, /since [^;]*; the relay did not record how it stopped/);

  second.service.noteRelayExit({ action: 'shutdown', reason: 'SIGTERM' });
  // The event row of the first start is still pending: the second is written into it.
  const third = restart(second);
  third.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const messages = eventMessages(third.db, WATCHER);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /after it was stopped \(SIGTERM\) at 2026-03-02 10:00 UTC\./);
  assert.equal((messages[0].text.match(/relay_restarted:/g) || []).length, 2);
});

test('loop guard: a turn woken by relay_restarted that requests another restart is not woken by it', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: COORDINATOR, events: ['relay_restarted'] });
  first.service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'] });
  const second = restart(first);
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const [woken] = eventMessages(second.db, COORDINATOR);
  assert.ok(woken);
  // The coordinator's worker takes the event row; its turn queues a restart.
  second.db.prepare(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = ?`).run(new Date(second.clock.now()).toISOString(), woken.id);
  assert.deepEqual(second.service.noteRestartRequested(), [COORDINATOR]);
  // The turn ends; the queued restart goes ahead.
  second.db.prepare(`UPDATE queue SET status = 'done' WHERE id = ?`).run(woken.id);
  second.db.prepare(`UPDATE queue SET status = 'done' WHERE conversation_id = ?`).run(WATCHER);
  assert.ok(second.service.noteRelayExit({ action: 'restart', reason: 'next item', requestedBy: 'localhost-api', requestedAt: new Date(second.clock.now()).toISOString() }));
  assert.deepEqual(lastExit(second.db).noWake, [COORDINATOR]);

  const third = restart(second);
  assert.deepEqual(third.started, { recorded: 1, skipped: [COORDINATOR] });
  assert.ok(third.lines.some((line) => line.includes('not woken')), third.lines.join('\n'));
  third.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventMessages(third.db, COORDINATOR).length, 1, 'only the wake of the first restart');
  assert.equal(eventMessages(third.db, WATCHER).length, 2, 'the other watcher is woken as before');

  // The subscription stays: a later restart requested while no such turn runs wakes it again.
  const fourth = restart(third);
  assert.deepEqual(fourth.started, { recorded: 2, skipped: [] });
});

test('a held-back once subscription ends with the restart that held it back, not with a later one', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: COORDINATOR, events: ['relay_restarted'], once: true });
  const second = restart(first);
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const [woken] = eventMessages(second.db, COORDINATOR);
  second.db.prepare(`UPDATE queue SET status = 'processing' WHERE id = ?`).run(woken.id);
  // The woken turn does what the guidance says: subscribe once, then request the restart.
  const again = second.service.subscribe({ watcherConversationId: COORDINATOR, events: ['relay_restarted'], once: true });
  second.service.noteRestartRequested();
  second.db.prepare(`UPDATE queue SET status = 'done' WHERE id = ?`).run(woken.id);
  second.service.noteRelayExit({ action: 'restart', reason: 'next item', requestedBy: 'localhost-api', requestedAt: new Date(second.clock.now()).toISOString() });

  const third = restart(second);
  assert.deepEqual(third.started, { recorded: 0, skipped: [COORDINATOR] });
  const ended = third.service.listSubscriptions({ watcherConversationId: COORDINATOR }).find((row) => row.id === again.id);
  assert.equal(ended.endReason, 'held-back');
  assert.ok(third.lines.some((line) => line.includes(again.id) && line.includes('held-back')), third.lines.join('\n'));
  // Days later, an unrelated restart wakes nobody with a stale "carry on".
  third.clock.advance(3 * 24 * 60 * 60_000);
  assert.deepEqual(restart(third).started, { recorded: 0, skipped: [] });
});

test('a record of the end older than 30 days is not the run just before: it is ignored, its hold-backs too', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'] });
  // Written by a runtime that an older OAR (which neither writes nor takes it) followed.
  first.db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`).run(RELAY_LAST_EXIT_SETTING_KEY, JSON.stringify({
    v: 1, requested: true, action: 'restart', reason: 'long ago', requestedBy: 'localhost-api',
    requestedAt: new Date(T0 - 41 * 24 * 60 * 60_000).toISOString(), stoppedAt: new Date(T0 - 40 * 24 * 60 * 60_000).toISOString(), noWake: [WATCHER],
  }), new Date(T0).toISOString());
  const second = restart(first);
  assert.deepEqual(second.started, { recorded: 1, skipped: [] });
  assert.equal(lastExit(second.db), null);
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const [message] = eventMessages(second.db, WATCHER);
  assert.doesNotMatch(message.text, /long ago/);
  assert.match(message.text, /the relay did not record how it stopped \(for example a crash, a forced stop or a reboot\)/);
});

test('a long stop (a weekend) still says how the relay stopped', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'] });
  first.service.noteRelayExit({ action: 'shutdown', reason: 'oar-cli', requestedBy: 'oar-cli', requestedAt: new Date(T0).toISOString() });
  first.clock.advance(3 * 24 * 60 * 60_000);
  const second = restart(first);
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(second.db, WATCHER)[0].text, /after a shutdown requested by "oar-cli" at 2026-03-02 10:00 UTC/);
});

test('a start stopped before it listened keeps the record of the run before for the next start', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'] });
  first.service.noteRelayExit({ action: 'restart', reason: 'manual-restart', requestedBy: 'localhost-api', requestedAt: new Date(T0).toISOString() });
  first.service.stop();
  // A runtime that is stopped by a signal before it listens: it never noted its start.
  const stmts = { ...createSessionRepository(first.db), ...createMessageRepository(first.db) };
  const aborted = createRelayEventService({ db: first.db, stmts, now: first.clock.now, setTimer: first.clock.setTimer, clearTimer: first.clock.clearTimer, logger: { log() {}, warn() {} } });
  aborted.start();
  assert.equal(aborted.noteRelayExit({ action: 'shutdown', reason: 'SIGTERM' }), false);
  aborted.stop();
  assert.equal(lastExit(first.db).reason, 'manual-restart');
  const second = boot({ db: first.db, clock: first.clock });
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(second.db, WATCHER)[0].text, /after a restart requested by "localhost-api"/);
});

test('a stop because the owner process is gone names no process id', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'] });
  first.service.noteRelayExit({ action: 'shutdown', reason: 'owner-pid-missing:48213' });
  assert.equal(lastExit(first.db).reason, 'owner-pid-missing');
  const second = restart(first);
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const [message] = eventMessages(second.db, WATCHER);
  assert.match(message.text, /after it was stopped \(owner-pid-missing\)/);
  assert.doesNotMatch(message.text, /48213/);
});

test('a withdrawn request holds nobody back', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: COORDINATOR, events: ['relay_restarted'] });
  const second = restart(first);
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const [woken] = eventMessages(second.db, COORDINATOR);
  second.db.prepare(`UPDATE queue SET status = 'processing' WHERE id = ?`).run(woken.id);
  assert.deepEqual(second.service.noteRestartRequested(), [COORDINATOR]);
  second.service.noteRestartCancelled();
  second.service.noteRelayExit({ action: 'shutdown', reason: 'SIGINT' });
  assert.deepEqual(lastExit(second.db).noWake, []);
  assert.deepEqual(restart(second).started, { recorded: 1, skipped: [] });
});

test('an archived or deleted watcher is not woken', () => {
  const first = boot();
  first.service.subscribe({ watcherConversationId: WATCHER, events: ['relay_restarted'] });
  first.service.subscribe({ watcherConversationId: COORDINATOR, events: ['relay_restarted'] });
  // Archived through the route (its subscriptions end) and behind its back.
  first.db.prepare(`UPDATE conversations SET archived = 1 WHERE id = ?`).run(WATCHER);
  first.service.noteConversationGone(WATCHER);
  first.db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id = ?`).run(COORDINATOR);
  first.service.noteRelayExit({ action: 'restart', reason: 'manual-restart', requestedBy: 'localhost-api', requestedAt: new Date(T0).toISOString() });
  const second = restart(first);
  assert.deepEqual(second.started, { recorded: 0, skipped: [] });
  second.clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventMessages(second.db, WATCHER).length + eventMessages(second.db, COORDINATOR).length, 0);
});
