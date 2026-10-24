import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_SCHEDULE_LIMITS, RELAY_SCHEDULE_MESSAGE_KIND, RELAY_SCHEDULE_SOCKET_EVENT } from '../../shared/relay-schedules.mjs';
import { RELAY_SCHEDULE_HOLD_RECHECK_MS, RelayScheduleError, createRelayScheduleService } from './relay-schedule-service.mjs';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const MIN = 60_000;
const AGENT = 'conv-fixture-agent';
const WORKER = 'conv-fixture-worker';
const OTHER = 'conv-fixture-other';
// Far more than any test needs (a week of 5-minute firings is ~2000).
const MAX_TIMERS_PER_ADVANCE = 5000;

function seedConversation(db, id, title) {
  const at = new Date(T0 - MIN).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
    VALUES (?, ?, ?, ?, 'claude-sonnet-5', 'claude', 'claude-sonnet-5', ?, ?)
  `).run(`rs-${id}`, id, `sdk-${id}`, `key-${id}`, at, at);
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
    pending: () => timers.filter((timer) => !timer.done).length,
    advance(ms) {
      const until = clock + ms;
      // Bounded: a timer that keeps re-arming itself at the same instant (a
      // firing that never records itself) fails the test instead of hanging it.
      for (let fired = 0; ; fired += 1) {
        if (fired >= MAX_TIMERS_PER_ADVANCE) throw new Error(`more than ${MAX_TIMERS_PER_ADVANCE} timers fired in one advance: a timer re-arms without progress`);
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

function setup({ db = null, clock = createClock(), admitFiring = undefined } = {}) {
  const database = db || new Database(':memory:');
  if (!db) {
    applySchema(database);
    seedConversation(database, AGENT, 'Coordinator');
    seedConversation(database, WORKER, 'Night review');
    seedConversation(database, OTHER, 'Elsewhere');
  }
  const stmts = { ...createSessionRepository(database), ...createMessageRepository(database) };
  const emitted = [];
  const wakes = [];
  let ids = 0;
  const service = createRelayScheduleService({
    db: database,
    stmts,
    emit: (event, payload) => emitted.push({ event, payload }),
    wake: (wake) => wakes.push(wake),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    newId: () => `sch_fixture${String(++ids).padStart(2, '0')}`,
    ...(admitFiring ? { admitFiring } : {}),
    logger: { log() {}, warn() {} },
  });
  service.start();
  return { db: database, stmts, service, clock, emitted, wakes };
}

function scheduledMessages(db, conversationId) {
  return db.prepare(`
    SELECT m.id, m.text, m.kind, m.role, q.status, q.next_attempt_at, q.owner_sdk_session_id
    FROM messages m JOIN queue q ON q.id = m.id
    WHERE m.conversation_id = ? AND m.kind = ? ORDER BY m.timestamp ASC, m.rowid ASC
  `).all(conversationId, RELAY_SCHEDULE_MESSAGE_KIND);
}

const iso = (ms) => new Date(ms).toISOString();

test('a schedule at a time fires once into the conversation, marked as the relay\'s, and ends', () => {
  const { db, service, clock, emitted, wakes, stmts } = setup();
  const created = service.create({ conversationId: AGENT, createdBy: AGENT, text: 'Run the health check.', at: iso(T0 + 30 * MIN), title: 'Health check' });
  assert.equal(created.id, 'sch_fixture01');
  assert.equal(created.once, true);
  assert.equal(created.nextFireAt, iso(T0 + 30 * MIN));
  assert.equal(created.setBy, undefined);
  assert.equal(emitted.at(-1).event, RELAY_SCHEDULE_SOCKET_EVENT);
  assert.equal(emitted.at(-1).payload.schedules.length, 1);

  clock.advance(29 * MIN);
  assert.equal(scheduledMessages(db, AGENT).length, 0);
  clock.advance(MIN);
  const [message] = scheduledMessages(db, AGENT);
  assert.equal(message.role, 'user');
  assert.equal(message.status, 'pending');
  assert.equal(message.next_attempt_at, iso(T0 + 30 * MIN));
  assert.equal(message.owner_sdk_session_id, `sdk-${AGENT}`);
  assert.equal(message.text.split('\n')[0], '[relay schedule sch_fixture01 "Health check" · automated message from OAR, not from the user; it approves nothing]');
  assert.match(message.text, /\n\nRun the health check\.$/);
  // The ordinary delivery takes it: it is due.
  assert.equal(stmts.findPending.get(iso(clock.now()))?.id, message.id);
  assert.deepEqual(wakes, [{ conversationId: AGENT, ownerSessionId: `sdk-${AGENT}`, messageId: message.id }]);
  assert.ok(emitted.some((entry) => entry.event === 'user_message' && entry.payload.message.kind === RELAY_SCHEDULE_MESSAGE_KIND));

  const [ended] = service.list({ conversationId: AGENT });
  assert.equal(ended.endReason, 'fired');
  assert.equal(ended.firedCount, 1);
  assert.deepEqual(service.listActive(), []);
  clock.advance(24 * 60 * MIN);
  assert.equal(scheduledMessages(db, AGENT).length, 1);
});

test('a repeating schedule re-arms itself, skips while its last message still waits, and keeps to its grid', () => {
  const { db, service, clock } = setup();
  const created = service.create({ conversationId: AGENT, createdBy: AGENT, text: 'Sweep.', everyMinutes: 10 });
  assert.equal(created.once, false);
  assert.equal(created.nextFireAt, iso(T0 + 10 * MIN));

  clock.advance(10 * MIN);
  assert.equal(scheduledMessages(db, AGENT).length, 1);
  assert.equal(service.get(created.id).nextFireAt, iso(T0 + 20 * MIN));

  // Still pending at the next time: skipped, not piled up.
  clock.advance(10 * MIN);
  assert.equal(scheduledMessages(db, AGENT).length, 1);
  assert.equal(service.get(created.id).skippedCount, 1);
  assert.equal(service.get(created.id).nextFireAt, iso(T0 + 30 * MIN));

  db.prepare(`UPDATE queue SET status = 'done' WHERE id = ?`).run(scheduledMessages(db, AGENT)[0].id);
  clock.advance(10 * MIN);
  const messages = scheduledMessages(db, AGENT);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].next_attempt_at, iso(T0 + 30 * MIN));
  assert.equal(service.get(created.id).firedCount, 2);
  assert.equal(service.get(created.id).nextFireAt, iso(T0 + 40 * MIN));
});

test('at with every_minutes starts at that time, and once with every_minutes fires once', () => {
  const { db, service, clock } = setup();
  const nightly = service.create({ conversationId: AGENT, createdBy: AGENT, text: 'Nightly.', at: iso(T0 + 120 * MIN), everyMinutes: 1440 });
  const single = service.create({ conversationId: AGENT, createdBy: AGENT, text: 'Later.', everyMinutes: 30, once: true });
  assert.equal(nightly.nextFireAt, iso(T0 + 120 * MIN));
  assert.equal(nightly.once, false);
  assert.equal(single.once, true);
  clock.advance(30 * MIN);
  assert.equal(service.get(single.id).endReason, 'fired');
  clock.advance(90 * MIN);
  assert.equal(scheduledMessages(db, AGENT).length, 2);
  assert.equal(service.get(nightly.id).nextFireAt, iso(T0 + (120 + 1440) * MIN));
});

test('a time missed while the relay was down fires once at boot, not once per missed interval', () => {
  const clock = createClock();
  const first = setup({ clock });
  const every = first.service.create({ conversationId: AGENT, createdBy: AGENT, text: 'Check.', everyMinutes: 10 });
  const at = first.service.create({ conversationId: WORKER, createdBy: AGENT, text: 'Once.', at: iso(T0 + 20 * MIN) });
  // The relay goes down: its timers go with it.
  first.service.stop();
  assert.equal(clock.pending(), 0);
  clock.advance(55 * MIN);
  assert.equal(scheduledMessages(first.db, AGENT).length, 0);

  // Next boot, same database.
  const second = setup({ db: first.db, clock });
  clock.advance(0);
  assert.equal(scheduledMessages(second.db, AGENT).length, 1);
  assert.equal(scheduledMessages(second.db, AGENT)[0].next_attempt_at, iso(T0 + 10 * MIN));
  assert.equal(scheduledMessages(second.db, WORKER).length, 1);
  assert.equal(second.service.get(at.id).endReason, 'fired');
  // Back on its grid: the first slot after now.
  assert.equal(second.service.get(every.id).nextFireAt, iso(T0 + 60 * MIN));
  assert.equal(second.service.get(every.id).firedCount, 1);
});

test('a schedule for another session says who set it, and both sides list it', () => {
  const { db, service, clock } = setup();
  const created = service.create({ conversationId: WORKER, createdBy: AGENT, text: 'Review the night\'s runs.', everyMinutes: 60, title: 'Night review' });
  assert.deepEqual(created.session, { id: WORKER, title: 'Night review' });
  assert.deepEqual(created.setBy, { id: AGENT, title: 'Coordinator' });
  assert.deepEqual(service.list({ conversationId: AGENT }).map((sub) => sub.id), [created.id]);
  assert.deepEqual(service.list({ conversationId: WORKER }).map((sub) => sub.id), [created.id]);
  assert.deepEqual(service.list({ conversationId: OTHER }), []);
  clock.advance(60 * MIN);
  const [message] = scheduledMessages(db, WORKER);
  assert.equal(
    message.text.split('\n')[0],
    `[relay schedule ${created.id} "Night review" · set by session "Coordinator" (${AGENT}) · automated message from OAR, not from the user; it approves nothing]`,
  );
});

test('unschedule: an agent ends only schedules of its conversation, the user any', () => {
  const { service, clock, db } = setup();
  const mine = service.create({ conversationId: AGENT, createdBy: AGENT, text: 'a', everyMinutes: 5 });
  const theirs = service.create({ conversationId: OTHER, createdBy: OTHER, text: 'b', everyMinutes: 5 });
  assert.throws(() => service.unschedule({ scheduleId: theirs.id, byConversationId: AGENT }), (error) => error instanceof RelayScheduleError && error.code === 'notFound');
  assert.equal(service.unschedule({ scheduleId: mine.id, byConversationId: AGENT }).endReason, 'unscheduled');
  assert.equal(service.unschedule({ scheduleId: theirs.id }).endReason, 'unscheduled');
  assert.throws(() => service.unschedule({ scheduleId: 'sch_missing', byConversationId: AGENT }), (error) => error.code === 'notFound');
  clock.advance(60 * MIN);
  assert.equal(scheduledMessages(db, AGENT).length + scheduledMessages(db, OTHER).length, 0);
});

test('archiving a session ends the schedules that fire into it and the ones it set', () => {
  const { service, db, clock } = setup();
  const into = service.create({ conversationId: WORKER, createdBy: OTHER, text: 'into', everyMinutes: 5 });
  const set = service.create({ conversationId: OTHER, createdBy: WORKER, text: 'set', everyMinutes: 5 });
  const kept = service.create({ conversationId: OTHER, createdBy: OTHER, text: 'kept', everyMinutes: 5 });
  assert.equal(service.noteConversationGone(WORKER), 2);
  assert.equal(service.get(into.id).endReason, 'archived');
  assert.equal(service.get(set.id).endReason, 'archived');
  assert.equal(service.get(kept.id).endedAt, undefined);
  assert.equal(service.noteConversationGone(OTHER, { deleted: true }), 1);
  assert.equal(service.get(kept.id).endReason, 'deleted');
  clock.advance(10 * MIN);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE kind = ?`).get(RELAY_SCHEDULE_MESSAGE_KIND).n, 0);
});

test('a schedule whose session was archived without notice ends when it comes due', () => {
  const { service, db, clock } = setup();
  const created = service.create({ conversationId: WORKER, createdBy: AGENT, text: 'x', everyMinutes: 5 });
  db.prepare(`UPDATE conversations SET archived = 1 WHERE id = ?`).run(WORKER);
  clock.advance(5 * MIN);
  assert.equal(service.get(created.id).endReason, 'archived');
  assert.equal(scheduledMessages(db, WORKER).length, 0);
  assert.throws(() => service.create({ conversationId: WORKER, createdBy: AGENT, text: 'x', everyMinutes: 5 }), (error) => error.code === 'notFound');
});

test(`at most ${RELAY_SCHEDULE_LIMITS.perConversation} schedules fire into a conversation, and a conversation sets at most as many`, () => {
  const { service } = setup();
  const max = RELAY_SCHEDULE_LIMITS.perConversation;
  for (let i = 0; i < max; i += 1) service.create({ conversationId: AGENT, createdBy: AGENT, text: `t${i}`, everyMinutes: 5 });
  assert.throws(() => service.create({ conversationId: AGENT, createdBy: AGENT, text: 'one more', everyMinutes: 5 }), (error) => error.code === 'limit' && error.extra.limit === max);
  // The agent has set its 20 (all for itself): none for another session either.
  assert.throws(() => service.create({ conversationId: WORKER, createdBy: AGENT, text: 'other', everyMinutes: 5 }), (error) => error.code === 'limit' && /has set/.test(error.message));
  // An ended one frees its place.
  service.unschedule({ scheduleId: service.listActive()[0].id });
  assert.ok(service.create({ conversationId: AGENT, createdBy: AGENT, text: 'again', everyMinutes: 5 }).id);
});

test('bad input is refused, and without its table the service refuses and stays quiet', () => {
  const { service } = setup();
  assert.throws(() => service.create({ conversationId: AGENT, createdBy: AGENT, text: '', everyMinutes: 5 }), (error) => error.code === 'invalid');
  assert.throws(() => service.create({ conversationId: AGENT, createdBy: AGENT, text: 'x' }), (error) => error.code === 'invalid');
  assert.throws(() => service.create({ conversationId: AGENT, createdBy: AGENT, text: 'x', everyMinutes: 4 }), (error) => error.code === 'invalid');
  assert.throws(() => service.create({ conversationId: AGENT, createdBy: AGENT, text: 'x', at: iso(T0 + MIN), once: false }), (error) => error.code === 'invalid');

  const bare = new Database(':memory:');
  const off = createRelayScheduleService({ db: bare, stmts: {}, logger: { log() {}, warn() {} } });
  assert.equal(off.isAvailable(), false);
  off.start();
  assert.deepEqual(off.listActive(), []);
  assert.equal(off.noteConversationGone(AGENT), 0);
  assert.throws(() => off.create({ conversationId: AGENT, text: 'x', everyMinutes: 5 }), (error) => error.code === 'unavailable');
});

test('ended schedules are listed for an hour and pruned after a week', () => {
  const { service, clock } = setup();
  const created = service.create({ conversationId: AGENT, createdBy: AGENT, text: 'x', everyMinutes: 5 });
  service.unschedule({ scheduleId: created.id });
  assert.equal(service.list({ conversationId: AGENT }).length, 1);
  service.stop();
  clock.advance(61 * MIN);
  assert.equal(service.list({ conversationId: AGENT }).length, 0);
  assert.equal(service.pruneEnded(), 0);
  clock.advance(7 * 24 * 60 * MIN);
  assert.equal(service.pruneEnded(), 1);
  assert.equal(service.get(created.id), null);
});

test('a firing into another session asks the loop guard; held until it lets it go, then it fires once', () => {
  let open = true;
  const asked = [];
  const { db, service, clock } = setup({
    admitFiring: (entry) => {
      asked.push(entry);
      return open;
    },
  });
  const other = service.create({ conversationId: WORKER, createdBy: AGENT, text: 'Check.', everyMinutes: 5 });
  const own = service.create({ conversationId: AGENT, createdBy: AGENT, text: 'Mine.', everyMinutes: 5 });
  clock.advance(5 * MIN);
  assert.deepEqual(asked, [{ scheduleId: other.id, conversationId: WORKER, createdBy: AGENT }], 'an own schedule asks nobody');
  assert.equal(scheduledMessages(db, WORKER).length, 1);
  assert.equal(scheduledMessages(db, AGENT).length, 1);
  db.prepare(`UPDATE queue SET status = 'done'`).run();

  // The guard wants the user first: held, not fired, and looked at again every minute.
  open = false;
  clock.advance(5 * MIN);
  assert.equal(scheduledMessages(db, WORKER).length, 1);
  const held = service.get(other.id);
  assert.equal(held.heldForApproval, true);
  assert.equal(held.heldSince, iso(T0 + 10 * MIN));
  assert.equal(held.nextFireAt, iso(T0 + 10 * MIN), 'still due');
  assert.equal(service.get(own.id).heldForApproval, undefined);
  clock.advance(20 * MIN);
  assert.equal(scheduledMessages(db, WORKER).length, 1, 'nothing goes while held');
  assert.ok(asked.length >= 20, 'asked again each minute');
  assert.equal(service.get(other.id).heldSince, iso(T0 + 10 * MIN), 'held since the first time');

  // The user wrote: the next look lets it go, once, and it is back on its grid.
  open = true;
  clock.advance(RELAY_SCHEDULE_HOLD_RECHECK_MS);
  const messages = scheduledMessages(db, WORKER);
  assert.equal(messages.length, 2);
  const after = service.get(other.id);
  assert.equal(after.heldForApproval, undefined);
  assert.equal(after.firedCount, 2);
  assert.equal(after.nextFireAt, iso(T0 + 35 * MIN));
});

test('a firing the loop guard cannot be asked about is held, not sent', () => {
  const { db, service, clock } = setup({ admitFiring: () => { throw new Error('guard unreadable'); } });
  const other = service.create({ conversationId: WORKER, createdBy: AGENT, text: 'Check.', everyMinutes: 5 });
  clock.advance(5 * MIN);
  assert.equal(scheduledMessages(db, WORKER).length, 0);
  assert.equal(service.get(other.id).heldForApproval, true);
});

test('the messages carry the provenance the schedule was set with, hops included', () => {
  const { db, service, clock } = setup();
  const origin = { kind: 'agent', relayId: 'relay-fixture-b', relayName: 'reader-test', conversationId: 'conv-remote', hops: 2 };
  service.create({ conversationId: AGENT, createdBy: AGENT, text: 'Carry on.', everyMinutes: 5, origin });
  service.create({ conversationId: OTHER, createdBy: OTHER, text: 'Plain.', everyMinutes: 5 });
  clock.advance(5 * MIN);
  const carried = db.prepare(`SELECT origin_json FROM messages WHERE conversation_id = ? AND kind = ?`).get(AGENT, RELAY_SCHEDULE_MESSAGE_KIND);
  assert.deepEqual(JSON.parse(carried.origin_json), origin);
  const plain = db.prepare(`SELECT origin_json FROM messages WHERE conversation_id = ? AND kind = ?`).get(OTHER, RELAY_SCHEDULE_MESSAGE_KIND);
  assert.equal(plain.origin_json, null, 'set on the user\'s own words: no provenance');
});

test('a schedule whose setter was archived without notice ends when it comes due', () => {
  const { service, db, clock } = setup();
  const created = service.create({ conversationId: WORKER, createdBy: AGENT, text: 'x', everyMinutes: 5 });
  db.prepare(`UPDATE conversations SET archived = 1 WHERE id = ?`).run(AGENT);
  clock.advance(5 * MIN);
  assert.equal(service.get(created.id).endReason, 'archived');
  assert.equal(scheduledMessages(db, WORKER).length, 0);
});

test('a compaction carries the schedules over in both directions, and the own nightly one goes on', () => {
  const { service, db, clock } = setup();
  seedConversation(db, 'conv-fixture-agent-next', 'Coordinator (compacted)');
  const nightly = service.create({ conversationId: AGENT, createdBy: AGENT, text: 'Nightly.', everyMinutes: 1440 });
  const into = service.create({ conversationId: AGENT, createdBy: OTHER, text: 'Into.', everyMinutes: 60 });
  const set = service.create({ conversationId: WORKER, createdBy: AGENT, text: 'Set.', everyMinutes: 60 });
  const elsewhere = service.create({ conversationId: OTHER, createdBy: OTHER, text: 'Elsewhere.', everyMinutes: 60 });
  // The compaction archives the source and moves its schedules along.
  db.prepare(`UPDATE conversations SET archived = 1, compacted_into = ? WHERE id = ?`).run('conv-fixture-agent-next', AGENT);
  assert.equal(service.carryToCompacted(AGENT, 'conv-fixture-agent-next'), 4, 'the own one counts on both sides');
  assert.deepEqual([service.get(nightly.id).session.id, service.get(nightly.id).setBy], ['conv-fixture-agent-next', undefined]);
  assert.equal(service.get(into.id).session.id, 'conv-fixture-agent-next');
  assert.equal(service.get(set.id).setBy.id, 'conv-fixture-agent-next');
  assert.equal(service.get(elsewhere.id).session.id, OTHER);
  assert.equal(service.carryToCompacted(AGENT, AGENT), 0);
  clock.advance(1440 * MIN);
  assert.equal(scheduledMessages(db, 'conv-fixture-agent-next').length, 2, 'the nightly one and the one set into it');
  assert.equal(service.get(nightly.id).endedAt, undefined);
  assert.equal(scheduledMessages(db, AGENT).length, 0);
});

test('the fake clock refuses a timer that re-arms without progress instead of hanging', () => {
  const clock = createClock();
  const rearm = () => clock.setTimer(rearm, 0);
  rearm();
  assert.throws(() => clock.advance(MIN), /re-arms without progress/);
});
