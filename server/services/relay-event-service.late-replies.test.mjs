import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { RELAY_EVENT_LIMITS, RELAY_EVENT_MESSAGE_KIND } from '../../shared/relay-events.mjs';
import { RELAY_EVENT_OPEN_PROMPT_KEEP_MS, RELAY_EVENT_OWN_PROMPT_KEEP_MS, createRelayEventService } from './relay-event-service.mjs';
import { LATE_REPLY_NUDGED_AT } from './relay-late-reply-service.mjs';

// Late replies in the event service: recording, delivery, acks riding along,
// the turn_end of an open prompt, the undeliverable case, retention.

const T0 = Date.parse('2026-11-15T01:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LEAD = 'conv-fixture-lead';
const LANE = 'conv-fixture-lane';
const OTHER = 'conv-fixture-other';
const SUCCESSOR = 'conv-fixture-lead-2';
const RELAY_A_ID = 'relay-fixture-a';
const B_ON_A = 'rr_fixture_b';

function seedConversation(db, id, title, start) {
  const at = new Date(start - MINUTE).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, ?, 'agent', ?, ?)`).run(id, title, at, at);
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
  };
}

function setup({ clock = createClock(), conversations = [[LEAD, 'Lead'], [LANE, 'Lane "14"'], [OTHER, 'Other watcher']], name = 'bench-relay', logs = [] } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  for (const [id, title] of conversations) seedConversation(db, id, title, clock.now());
  const service = createRelayEventService({
    db,
    stmts: { ...createSessionRepository(db), ...createMessageRepository(db) },
    relayName: () => name,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) },
  });
  service.start();
  return { db, service, clock, logs };
}

function eventMessages(db, conversationId = LEAD) {
  return db.prepare(`SELECT m.id, m.text, q.status FROM messages m JOIN queue q ON q.id = m.id WHERE m.conversation_id = ? AND m.kind = ? ORDER BY m.timestamp ASC`)
    .all(conversationId, RELAY_EVENT_MESSAGE_KIND);
}

function takeAll(db) {
  db.prepare(`UPDATE queue SET status = 'processing' WHERE status = 'pending'`).run();
}

const ledger = (db, id) => db.prepare(`SELECT * FROM relay_event_own_prompts WHERE message_id = ?`).get(id);
const undelivered = (db) => db.prepare(`SELECT * FROM relay_events WHERE delivered_at IS NULL ORDER BY id`).all();

function sent(service, id, { watcher = LEAD, session = LANE, relayId } = {}) {
  service.noteOwnPrompt({ watcherConversationId: watcher, sessionId: session, messageId: id, ...(relayId ? { relayId } : {}) });
}

function record(service, id, outcome, extra = {}) {
  return service.recordLateReply({ watcher: LEAD, sessionId: LANE, messageId: id, outcome, sentAt: new Date(T0).toISOString(), ...extra });
}

const done = (text) => ({ status: 'done', reply: { text, messageId: 'msg-reply' } });

// ─── Recording and delivery ──────────────────────────────────────────────────

test('recordLateReply writes one urgent late_reply row (reply:<id>), sets delivered; a second call does nothing', () => {
  const { db, service } = setup();
  sent(service, 'msg-1');
  assert.equal(ledger(db, 'msg-1').late_state, null);
  assert.equal(record(service, 'msg-1', done('All four points are fixed.')), 'delivered');
  const rows = undelivered(db);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].subscription_id, rows[0].type, rows[0].urgent, rows[0].watcher_conversation_id], ['reply:msg-1', 'late_reply', 1, LEAD]);
  assert.equal(ledger(db, 'msg-1').late_state, 'delivered');
  assert.ok(ledger(db, 'msg-1').late_at);
  assert.equal(record(service, 'msg-1', done('again')), null);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM relay_events`).get().n, 1);
});

test('the flush writes a pending relay-event message with the whole reply, the "reaches nobody" line and the title', () => {
  const { db, service, clock } = setup();
  sent(service, 'msg-2');
  const reply = Array.from({ length: 60 }, (_, index) => `point ${index + 1}`).join('\n');
  record(service, 'msg-2', done(reply));
  clock.advance(0);
  const [message] = eventMessages(db);
  assert.equal(message.status, 'pending');
  assert.match(message.text, /late_reply: late reply from session "Lane '14'" \(conv-fixture-lane\) to your prompt msg-2 of 01:00Z: its reply follows; you were no longer waiting for it\. Your reply to this message reaches nobody: to answer, use relay_tool send\./);
  assert.match(message.text, /\[relay event\] > point 1\n/);
  assert.match(message.text, /\[relay event\] > point 60$/, 'whole: past the 40-line cap of events');
  assert.ok(message.text.split('\n').slice(1).every((line) => line.startsWith('[relay event]')), 'every line under the prefix');
});

test('two late replies while an event row is pending merge into it', () => {
  const { db, service, clock } = setup();
  sent(service, 'msg-3a');
  sent(service, 'msg-3b');
  record(service, 'msg-3a', done('first answer'));
  clock.advance(0);
  record(service, 'msg-3b', done('second answer'));
  clock.advance(0);
  const messages = eventMessages(db);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /first answer[\s\S]*second answer/);
});

test('a reply: row is spared when the watcher\'s last subscription ends', () => {
  const { db, service, clock } = setup();
  const sub = service.subscribe({ watcherConversationId: LEAD, sessionIds: [OTHER] });
  sent(service, 'msg-4');
  record(service, 'msg-4', done('still owed'));
  service.unsubscribe({ watcherConversationId: LEAD, subscriptionId: sub.id });
  clock.advance(0);
  assert.match(eventMessages(db)[0].text, /still owed/);
});

test('an archived sender with a compaction successor gets it there; without one it is undeliverable and the lane is told once', () => {
  const { db, service, clock } = setup({ conversations: [[LEAD, 'Lead'], [LANE, 'Lane'], [SUCCESSOR, 'Lead (continued)']] });
  sent(service, 'msg-5a');
  db.prepare(`UPDATE conversations SET archived = 1, compacted_into = ? WHERE id = ?`).run(SUCCESSOR, LEAD);
  assert.equal(record(service, 'msg-5a', done('to the successor')), 'delivered');
  clock.advance(0);
  assert.match(eventMessages(db, SUCCESSOR)[0].text, /to the successor/);
  sent(service, 'msg-5b');
  db.prepare(`UPDATE conversations SET compacted_into = NULL WHERE id = ?`).run(LEAD);
  assert.equal(record(service, 'msg-5b', done('nobody reads this')), 'undeliverable');
  assert.equal(ledger(db, 'msg-5b').late_state, 'undeliverable');
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  const told = eventMessages(db, LANE);
  assert.equal(told.length, 1);
  assert.match(told[0].text, /reply_undelivered: your reply to session "Lead" \(conv-fixture-lead\) of 01:00Z reached nobody: that session was archived\./);
  assert.equal(record(service, 'msg-5b', done('again')), null, 'told once');
});

test('a paired target of a gone sender is only logged', () => {
  const { db, service } = setup();
  sent(service, 'msg-5c', { relayId: B_ON_A, session: 'conv-on-b' });
  db.prepare(`UPDATE conversations SET archived = 1 WHERE id = ?`).run(LEAD);
  assert.equal(record(service, 'msg-5c', done('x'), { relayId: B_ON_A, sessionId: 'conv-on-b' }), 'undeliverable');
  assert.equal(undelivered(db).length, 0);
});

// ─── turn_end and the wait ───────────────────────────────────────────────────

test('an open own prompt\'s turn_end is not recorded for its watcher; a one-shot one is, another watcher still gets it', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: LEAD, sessionIds: [LANE] });
  service.subscribe({ watcherConversationId: OTHER, sessionIds: [LANE] });
  sent(service, 'msg-6');
  service.noteTurnEnd({ conversationId: LANE, queueMessageId: 'msg-6', replyText: 'answered' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventMessages(db, LEAD).length, 0);
  assert.match(eventMessages(db, OTHER)[0].text, /"answered"/);
  const once = service.subscribe({ watcherConversationId: LEAD, sessionIds: [LANE], events: ['turn_end'], once: true });
  sent(service, 'msg-6b');
  service.noteTurnEnd({ conversationId: LANE, queueMessageId: 'msg-6b', replyText: 'ends it' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.match(eventMessages(db, LEAD)[0].text, new RegExp(`"ends it"[\\s\\S]*one-shot subscription ${once.id} ended`));
});

test('an imported turn_end of an open prompt to a paired relay is not recorded, and nudges that relay\'s rows', async () => {
  const clock = createClock();
  const a = setup({ clock, conversations: [[LEAD, 'Lead']], name: 'win-test' });
  const b = setup({ clock, conversations: [[LANE, 'Lane']], name: 'linux-test' });
  const remote = b.service.subscribeServed({ subscriberRelayId: RELAY_A_ID, watcherId: LEAD, sessionIds: [LANE] });
  a.service.addMirror({ watcherConversationId: LEAD, relayId: B_ON_A, relayName: 'linux-test', remote });
  sent(a.service, 'msg-across', { relayId: B_ON_A });
  a.db.prepare(`UPDATE relay_event_own_prompts SET late_next_at = ?`).run(new Date(T0 + 5 * MINUTE).toISOString());
  b.service.noteTurnEnd({ conversationId: LANE, queueMessageId: 'msg-across', replyText: 'answered across' });
  const body = a.service.buildRemotePull(B_ON_A);
  a.service.applyRemotePull(B_ON_A, { relayName: 'linux-test', response: b.service.pullServed({ subscriberRelayId: RELAY_A_ID, ...body }) });
  assert.equal(ledger(a.db, 'msg-across').late_next_at, LATE_REPLY_NUDGED_AT, 'read in the next pass');
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventMessages(a.db).length, 0);
});

test('a paired relay cannot hand over a late reply of its own', () => {
  const clock = createClock();
  const a = setup({ clock, conversations: [[LEAD, 'Lead']] });
  const remote = { id: 'sub_remote', scope: 'sessions', sessions: [{ id: LANE, title: 'Lane' }], events: ['turn_end'] };
  const mirror = a.service.addMirror({ watcherConversationId: LEAD, relayId: B_ON_A, relayName: 'linux-test', remote });
  a.service.applyRemotePull(B_ON_A, {
    relayName: 'linux-test',
    response: { cursor: 1, events: [{ id: 1, payload: { type: 'late_reply', session: { id: LANE }, subscriptionIds: [mirror.remoteId], detail: { messageId: 'x' } } }] },
  });
  assert.equal(undelivered(a.db).length, 0);
});

test('endOwnWait(received) drops an undelivered late reply; one after delivery says when it went', () => {
  const { db, service, clock } = setup();
  sent(service, 'msg-7');
  record(service, 'msg-7', done('raced'));
  const wait = service.beginOwnWait({ watcherConversationId: LEAD, messageId: 'msg-7', waitMs: 60_000 });
  assert.deepEqual(service.endOwnWait(wait, { received: true, returned: true }), { dropped: 0, lateReplyAt: null });
  assert.equal(undelivered(db).length, 0);
  assert.equal(ledger(db, 'msg-7').late_state, 'returned');
  clock.advance(0);
  assert.equal(eventMessages(db).length, 0);
  sent(service, 'msg-7b');
  record(service, 'msg-7b', done('delivered first'));
  clock.advance(0);
  const later = service.beginOwnWait({ watcherConversationId: LEAD, messageId: 'msg-7b', waitMs: 60_000 });
  assert.equal(service.endOwnWait(later, { received: true, returned: true }).lateReplyAt, ledger(db, 'msg-7b').late_at);
  assert.equal(ledger(db, 'msg-7b').late_state, 'delivered', 'stays delivered');
});

test('a wait that returns a final outcome closes the prompt; one that is abandoned or runs out leaves it open', () => {
  const { db, service, clock } = setup();
  sent(service, 'msg-8a');
  sent(service, 'msg-8b');
  service.endOwnWait(service.beginOwnWait({ watcherConversationId: LEAD, messageId: 'msg-8a', waitMs: 1000 }), { returned: true });
  db.prepare(`UPDATE relay_event_own_prompts SET late_next_at = ? WHERE message_id = 'msg-8b'`).run(new Date(T0 + 5 * MINUTE).toISOString());
  const running = service.beginOwnWait({ watcherConversationId: LEAD, messageId: 'msg-8b', waitMs: 1000 });
  clock.advance(MINUTE);
  service.endOwnWait(running, { returned: false });
  assert.deepEqual([ledger(db, 'msg-8a').late_state, ledger(db, 'msg-8a').received_at], ['returned', null]);
  assert.equal(ledger(db, 'msg-8b').late_state, null);
  assert.equal(ledger(db, 'msg-8b').late_next_at, new Date(T0 + MINUTE).toISOString(), 'due at the next pass, not after its cadence step');
});

test('a prompt an older version wrote (no late_next_at) is due, nudged and delivered; one it received is not', async () => {
  const { db, service, clock } = setup();
  const reads = [];
  service.setLateReplyReader(async (group) => {
    reads.push(group.rows.map((row) => row.messageId));
    return { outcomes: Object.fromEntries(group.rows.map((row) => [row.messageId, done(`answer to ${row.messageId}`)])) };
  });
  const insert = db.prepare(`INSERT INTO relay_event_own_prompts (message_id, watcher_conversation_id, relay_id, session_id, created_at, received_at) VALUES (?, ?, 'self', ?, ?, ?)`);
  const at = new Date(T0 - 10 * MINUTE).toISOString();
  insert.run('msg-old-open', LEAD, LANE, at, null);
  insert.run('msg-old-received', LEAD, LANE, at, at);
  insert.run('msg-old-other', LEAD, OTHER, at, null);
  service.noteTurnEnd({ conversationId: OTHER, queueMessageId: 'msg-old-other', replyText: 'x' });
  assert.equal(ledger(db, 'msg-old-other').late_next_at, LATE_REPLY_NUDGED_AT, 'nudged');
  await service.passLateReplies();
  assert.deepEqual(reads.flat().sort(), ['msg-old-open', 'msg-old-other']);
  assert.equal(ledger(db, 'msg-old-open').late_state, 'delivered');
  assert.equal(ledger(db, 'msg-old-received').late_state, null, 'a wait received it there: never looked for');
  clock.advance(0);
  assert.match(eventMessages(db)[0].text, /answer to msg-old-open/);
});

// ─── Acks ────────────────────────────────────────────────────────────────────

test('an ack is held, then goes as one line with the next released row', () => {
  const { db, service, clock } = setup();
  sent(service, 'msg-9a');
  sent(service, 'msg-9b');
  assert.equal(record(service, 'msg-9a', done('[ack] got it')), 'ack');
  assert.equal(undelivered(db)[0].urgent, 0);
  clock.advance(HOUR);
  assert.equal(eventMessages(db).length, 0, 'wakes nobody');
  record(service, 'msg-9b', done('Here is the export fix.'));
  clock.advance(0);
  const [message] = eventMessages(db);
  assert.match(message.text, /late_reply: ack from session "Lane '14'" \(conv-fixture-lane\) to your prompt msg-9a of 01:00Z: "\[ack\] got it"/);
  assert.match(message.text, /late reply from session[\s\S]*Here is the export fix\./);
});

test('an ack nothing takes along goes after 24 h; cancelled and gone ride along too', () => {
  const { db, service, clock, logs } = setup();
  sent(service, 'msg-10a');
  sent(service, 'msg-10b');
  sent(service, 'msg-10c');
  record(service, 'msg-10a', done('Received.'));
  // A day of 30 s sweeps on the fake clock is slow: the test prunes by hand.
  service.stop();
  assert.equal(record(service, 'msg-10b', { status: 'cancelled', note: 'cancelled there' }), 'delivered');
  assert.equal(record(service, 'msg-10c', { status: 'gone' }), 'target_gone');
  clock.advance(RELAY_EVENT_LIMITS.lateReplyRideKeepMs - MINUTE);
  service.pruneDelivered();
  assert.equal(undelivered(db).length, 3);
  assert.equal(eventMessages(db).length, 0);
  clock.advance(2 * MINUTE);
  service.pruneDelivered();
  assert.equal(undelivered(db).length, 0);
  const dropped = logs.filter((line) => /riding late reply/.test(line));
  assert.equal(dropped.length, 3, 'one line per row');
  assert.match(dropped[0], /conv=conv-fix riding late reply \(ack\) to prompt msg-10a dropped after 24 h: nothing took it along/);
  assert.match(dropped[1], /\(cancelled\)/);
  assert.match(dropped[2], /\(gone\)/);
});

test('a longer [ack] reply is a late reply like any, with its whole text', () => {
  const { db, service, clock } = setup();
  sent(service, 'msg-10d');
  const text = `[ack] and one more thing: ${'the export needs a rerun. '.repeat(4)}`;
  assert.equal(record(service, 'msg-10d', done(text)), 'delivered');
  clock.advance(0);
  assert.ok(eventMessages(db)[0].text.includes(`[relay event] > ${text.trim()}`));
});

test('a failure is never held as an ack', () => {
  const { db, service, clock } = setup();
  sent(service, 'msg-11');
  assert.equal(record(service, 'msg-11', { status: 'failed', reply: { text: 'ok' } }), 'delivered');
  clock.advance(0);
  assert.match(eventMessages(db)[0].text, /its turn failed; the failure text follows/);
});

// ─── Loops, the sweeper, retention ───────────────────────────────────────────

test('the turn a late reply starts tells no watcher (a relay-event turn)', () => {
  const { db, service, clock } = setup();
  service.subscribe({ watcherConversationId: OTHER, sessionIds: [LEAD] });
  sent(service, 'msg-12');
  record(service, 'msg-12', done('answer'));
  clock.advance(0);
  const [message] = eventMessages(db);
  service.noteTurnEnd({ conversationId: LEAD, queueMessageId: message.id, replyText: 'thanks, carrying on' });
  clock.advance(RELAY_EVENT_LIMITS.coalesceMs);
  assert.equal(eventMessages(db, OTHER).length, 0);
});

test('the lane\'s turn end nudges its open prompts, and the sweeper delivers what the read finds', async () => {
  const { db, service, clock } = setup();
  const reads = [];
  service.setLateReplyReader(async (group) => {
    reads.push(group);
    return { outcomes: { 'msg-13': done('found by the sweeper') }, title: 'Lane "14"' };
  });
  sent(service, 'msg-13');
  db.prepare(`UPDATE relay_event_own_prompts SET late_next_at = ?`).run(new Date(T0 + 5 * MINUTE).toISOString());
  await service.passLateReplies();
  assert.equal(reads.length, 0, 'not due yet');
  service.noteTurnEnd({ conversationId: LANE, queueMessageId: 'msg-13', replyText: 'found by the sweeper' });
  await service.passLateReplies();
  assert.deepEqual(reads.map((group) => [group.watcherConversationId, group.relayId, group.sessionId]), [[LEAD, 'self', LANE]]);
  clock.advance(0);
  assert.match(eventMessages(db)[0].text, /found by the sweeper/);
  assert.equal(ledger(db, 'msg-13').late_state, 'delivered');
});

test('a paired relay past its reads: each other due row moves on by one pass from its own time', async () => {
  const { db, service } = setup();
  const reads = [];
  service.setLateReplyReader(async (group) => {
    reads.push(group.sessionId);
    return { outcomes: {} };
  });
  const at = (ms) => new Date(T0 + ms).toISOString();
  for (let index = 0; index < 12; index += 1) {
    sent(service, `msg-p${index}`, { relayId: B_ON_A, session: `conv-on-b${index}` });
    db.prepare(`UPDATE relay_event_own_prompts SET late_next_at = ? WHERE message_id = ?`).run(at(-(12 - index) * 1000), `msg-p${index}`);
  }
  db.prepare(`UPDATE relay_event_own_prompts SET late_next_at = NULL WHERE message_id = 'msg-p11'`).run();
  await service.passLateReplies();
  assert.equal(reads.length, RELAY_EVENT_LIMITS.lateReplyReadsPerRelay);
  assert.deepEqual(reads.slice(0, 2), ['conv-on-b11', 'conv-on-b0'], 'NULL first, then the oldest');
  const pass = RELAY_EVENT_LIMITS.lateReplyPassMs;
  assert.equal(ledger(db, 'msg-p9').late_next_at, at(-3000 + pass), 'not read: its own time plus one pass');
  assert.equal(ledger(db, 'msg-p10').late_next_at, at(-2000 + pass));
  assert.equal(ledger(db, 'msg-p0').late_next_at, at(pass), 'read: by its cadence, after the deferred ones');
});

test('retention keeps open prompts 7 days and the others 25 h', () => {
  const { db, service, clock } = setup();
  sent(service, 'msg-open');
  sent(service, 'msg-closed');
  service.endOwnWait(service.beginOwnWait({ watcherConversationId: LEAD, messageId: 'msg-closed', waitMs: 1000 }), { returned: true });
  service.stop();
  clock.advance(RELAY_EVENT_OWN_PROMPT_KEEP_MS + MINUTE);
  service.pruneDelivered();
  assert.ok(ledger(db, 'msg-open'));
  assert.equal(ledger(db, 'msg-closed'), undefined);
  clock.advance(RELAY_EVENT_OPEN_PROMPT_KEEP_MS - RELAY_EVENT_OWN_PROMPT_KEEP_MS);
  service.pruneDelivered();
  assert.equal(ledger(db, 'msg-open'), undefined);
});
