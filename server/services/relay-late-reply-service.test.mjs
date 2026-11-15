import test from 'node:test';
import assert from 'node:assert/strict';

import { RELAY_EVENT_LIMITS } from '../../shared/relay-events.mjs';
import { LATE_REPLY_NUDGED_AT, createLateReplyService, lateReplyCheckDelay, lateReplyTestPassMs } from './relay-late-reply-service.mjs';

// The sweeper's timing over a fake ledger and a fake read: the cadence, the
// bounds of a pass, the outcomes and the `seen` state between passes.

const T0 = Date.parse('2026-11-15T01:00:00.000Z');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function createStore(clock) {
  const rows = new Map();
  const delivered = [];
  const closed = [];
  const live = new Set(['conv-a', 'conv-c']);
  const waits = new Set();
  return {
    rows,
    delivered,
    closed,
    live,
    waits,
    add(id, { relay = 'self', session = 'conv-b', watcher = 'conv-a', age = 0, nextIn = 0, createdIn = 0 } = {}) {
      rows.set(id, {
        message_id: id,
        watcher_conversation_id: watcher,
        relay_id: relay,
        session_id: session,
        created_at: new Date(clock.now() - age + createdIn).toISOString(),
        late_state: null,
        late_next_at: new Date(clock.now() + nextIn).toISOString(),
      });
    },
    nextIn(id) {
      return Date.parse(rows.get(id).late_next_at) - clock.now();
    },
    listDue(at, limit) {
      return [...rows.values()]
        .filter((row) => row.late_state === null && row.late_next_at <= at)
        .sort((a, b) => a.late_next_at.localeCompare(b.late_next_at) || a.created_at.localeCompare(b.created_at))
        .slice(0, limit)
        .map((row) => ({ ...row }));
    },
    setNextAt(id, at) {
      if (rows.get(id)?.late_state === null) rows.get(id).late_next_at = at;
    },
    deferRelay(relay, byMs, due) {
      for (const row of rows.values()) {
        if (row.late_state === null && row.relay_id === relay && row.late_next_at <= due) row.late_next_at = new Date(Date.parse(row.late_next_at) + byMs).toISOString();
      }
    },
    nudge(relay, session, at) {
      let changed = 0;
      for (const row of rows.values()) {
        if (row.late_state !== null || row.relay_id !== relay || row.session_id !== session) continue;
        row.late_next_at = at;
        changed += 1;
      }
      return changed;
    },
    watcherLive: (watcher) => live.has(watcher),
    ownWaitLive: (watcher, id) => waits.has(`${watcher}:${id}`),
    deliver(row, outcome) {
      rows.get(row.message_id).late_state = 'delivered';
      delivered.push({ id: row.message_id, outcome });
    },
    close(row, state) {
      rows.get(row.message_id).late_state = state;
      closed.push({ id: row.message_id, state });
    },
  };
}

function setup({ testPassMs = 0 } = {}) {
  let clock = T0;
  const timers = [];
  const clockApi = {
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
  };
  const store = createStore(clockApi);
  const reads = [];
  let answer = () => ({ outcomes: {} });
  const service = createLateReplyService({
    store,
    selfRelayId: 'self',
    testPassMs,
    now: clockApi.now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    logger: { warn() {}, log() {} },
  });
  service.setReader(async (group) => {
    reads.push(group);
    return answer(group);
  });
  return {
    service,
    store,
    reads,
    timers,
    clock: clockApi,
    answer(fn) {
      answer = fn;
    },
  };
}

const done = (text = 'here it is') => ({ status: 'done', reply: { text } });
const outcomesFor = (group, outcome) => ({ outcomes: Object.fromEntries(group.rows.map((row) => [row.messageId, typeof outcome === 'function' ? outcome(row) : outcome])) });

// ─── Cadence ─────────────────────────────────────────────────────────────────

test('the cadence by age: paired relays often while young, this relay as a fallback; gave_up after 7 days', () => {
  assert.equal(lateReplyCheckDelay(5 * MINUTE, { paired: true }), 15 * SECOND);
  assert.equal(lateReplyCheckDelay(5 * MINUTE), 5 * MINUTE);
  assert.equal(lateReplyCheckDelay(HOUR, { paired: true }), MINUTE);
  assert.equal(lateReplyCheckDelay(HOUR), 5 * MINUTE);
  assert.equal(lateReplyCheckDelay(12 * HOUR, { paired: true }), 5 * MINUTE);
  assert.equal(lateReplyCheckDelay(12 * HOUR), 5 * MINUTE);
  assert.equal(lateReplyCheckDelay(3 * DAY, { paired: true }), 30 * MINUTE);
  assert.equal(lateReplyCheckDelay(3 * DAY), 30 * MINUTE);
  assert.equal(lateReplyCheckDelay(7 * DAY), null);
});

test('the end-to-end tests\' pass interval: every open row is due at each pass; out of range it changes nothing', async () => {
  assert.equal(lateReplyTestPassMs({ OAR_LATE_REPLY_TEST_PASS_MS: '1000' }), 1000);
  for (const value of [undefined, '', '50', '60001', '1.5', 'soon']) assert.equal(lateReplyTestPassMs({ OAR_LATE_REPLY_TEST_PASS_MS: value }), 0, String(value));
  const { service, store, timers } = setup({ testPassMs: 1000 });
  store.add('local', { age: MINUTE });
  store.add('paired-old', { relay: 'rr_b', age: 3 * DAY });
  await service.pass();
  assert.equal(store.nextIn('local'), 1000);
  assert.equal(store.nextIn('paired-old'), 1000);
  service.start();
  assert.ok(timers.some((timer) => timer.ms === 1000), 'a pass every second');
  service.stop();
});

test('a row that is not settled is due again by its age and target; one past 7 days is given up unread', async () => {
  const { service, store, reads } = setup();
  store.add('young-paired', { relay: 'rr_b', age: MINUTE });
  store.add('older-paired', { relay: 'rr_c', age: 3 * HOUR });
  store.add('young-local', { session: 'conv-d', age: MINUTE });
  store.add('week-old', { session: 'conv-e', age: 7 * DAY + MINUTE });
  await service.pass();
  assert.equal(store.nextIn('young-paired'), 15 * SECOND);
  assert.equal(store.nextIn('older-paired'), 5 * MINUTE);
  assert.equal(store.nextIn('young-local'), 5 * MINUTE);
  assert.deepEqual(store.closed, [{ id: 'week-old', state: 'gave_up' }]);
  assert.equal(reads.length, 3, 'the week-old row was not read');
});

test('a row with a live own wait is skipped; a row that is not due is not taken', async () => {
  const { service, store, reads } = setup();
  store.add('waited', { relay: 'rr_b' });
  store.add('later', { relay: 'rr_b', session: 'conv-x', nextIn: MINUTE });
  store.waits.add('conv-a:waited');
  await service.pass();
  assert.equal(reads.length, 0);
  assert.equal(store.nextIn('waited'), 15 * SECOND);
  assert.equal(store.nextIn('later'), MINUTE);
});

test('nudge(session) makes only that session\'s rows due, and starts a pass at once', async () => {
  const { service, store, timers } = setup();
  store.add('b-1', { nextIn: 5 * MINUTE });
  store.add('b-2', { nextIn: 4 * MINUTE });
  store.add('d-1', { session: 'conv-d', nextIn: 5 * MINUTE });
  store.add('b-paired', { relay: 'rr_b', nextIn: 5 * MINUTE });
  service.start();
  // start's own pass.
  for (const timer of timers.splice(0)) if (timer.ms === 0) timer.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.nudge('self', 'conv-b'), 2);
  assert.equal(store.rows.get('b-1').late_next_at, LATE_REPLY_NUDGED_AT, 'ahead of any backlog');
  assert.equal(store.rows.get('b-2').late_next_at, LATE_REPLY_NUDGED_AT);
  assert.equal(store.nextIn('d-1'), 5 * MINUTE);
  assert.equal(store.nextIn('b-paired'), 5 * MINUTE, 'the paired relay\'s session of the same id is another session');
  assert.deepEqual(timers.map((timer) => timer.ms), [0], 'one pass, now');
  assert.equal(service.nudge('self', 'conv-none'), 0);
  assert.equal(timers.length, 1, 'nothing due, no pass');
  service.stop();
});

// ─── Bounds of a pass ────────────────────────────────────────────────────────

test('a pass reads at most 50 rows, the most overdue first; the rest is read in the next pass', async () => {
  const { service, store, reads } = setup();
  for (let index = 0; index < 120; index += 1) {
    store.add(`row-${String(index).padStart(3, '0')}`, { session: `conv-s${index}`, nextIn: -(index + 1) * SECOND });
  }
  await service.pass();
  assert.equal(reads.length, RELAY_EVENT_LIMITS.lateReplyRowsPerPass);
  assert.deepEqual(reads.map((group) => group.rows[0].messageId).sort().slice(0, 2), ['row-070', 'row-071']);
  assert.ok(reads.every((group) => Number(group.rows[0].messageId.slice(4)) >= 70), 'the 50 most overdue');
  reads.length = 0;
  await service.pass();
  assert.equal(reads.length, 50);
  assert.ok(reads.every((group) => Number(group.rows[0].messageId.slice(4)) >= 20 && Number(group.rows[0].messageId.slice(4)) < 70));
});

test('three open rows of one session cost one read, settled each from it', async () => {
  const { service, store, reads, answer } = setup();
  store.add('p-1', { relay: 'rr_b', age: 3 * MINUTE });
  store.add('p-2', { relay: 'rr_b', age: 2 * MINUTE });
  store.add('p-3', { relay: 'rr_b', age: MINUTE });
  answer((group) => outcomesFor(group, (row) => (row.messageId === 'p-3' ? { status: 'running' } : done(row.messageId))));
  await service.pass();
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].rows.map((row) => row.messageId), ['p-1', 'p-2', 'p-3'], 'oldest first');
  assert.deepEqual(store.delivered.map((entry) => entry.id), ['p-1', 'p-2']);
  assert.equal(store.rows.get('p-3').late_state, null);
});

test('at most 10 reads to one paired relay and at most 4 in flight, 2 to one paired relay', async () => {
  const { service, store, reads, answer } = setup();
  for (let index = 0; index < 14; index += 1) store.add(`b-${index}`, { relay: 'rr_b', session: `conv-b${index}` });
  for (let index = 0; index < 6; index += 1) store.add(`l-${index}`, { session: `conv-l${index}` });
  let inFlight = 0;
  let peak = 0;
  let peakB = 0;
  let inFlightB = 0;
  answer(async (group) => {
    inFlight += 1;
    if (group.relayId === 'rr_b') inFlightB += 1;
    peak = Math.max(peak, inFlight);
    peakB = Math.max(peakB, inFlightB);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    if (group.relayId === 'rr_b') inFlightB -= 1;
    return { outcomes: {} };
  });
  await service.pass();
  assert.equal(reads.filter((group) => group.relayId === 'rr_b').length, 10);
  assert.equal(reads.filter((group) => group.relayId === 'self').length, 6);
  assert.equal(peak, 4);
  assert.equal(peakB, 2);
  const left = [...store.rows.values()].filter((row) => row.relay_id === 'rr_b' && Date.parse(row.late_next_at) === T0 + RELAY_EVENT_LIMITS.lateReplyPassMs);
  assert.equal(left.length, 14, 'the four not read are due at the next pass, the ten read by their cadence (15 s while young)');
});

test('a paired relay past its reads is read in turn: every session within ceil(100/10) passes, a nudged one within 2', async () => {
  const { service, store, reads, answer, clock } = setup();
  // Sent one after the other: each due from its own time.
  for (let index = 0; index < 100; index += 1) {
    store.add(`b-${String(index).padStart(3, '0')}`, { relay: 'rr_b', session: `conv-b${index}`, createdIn: (index - 100) * 10, nextIn: (index - 100) * 10 });
  }
  answer(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return { outcomes: {} };
  });
  const firstRead = new Map();
  let nudgedAt = 0;
  for (let pass = 1; pass <= 10; pass += 1) {
    if (pass === 4) {
      service.nudge('rr_b', 'conv-b95');
      nudgedAt = pass;
    }
    reads.length = 0;
    await service.pass();
    assert.ok(reads.length <= RELAY_EVENT_LIMITS.lateReplyReadsPerRelay);
    for (const group of reads) if (!firstRead.has(group.sessionId)) firstRead.set(group.sessionId, pass);
    clock.advance(RELAY_EVENT_LIMITS.lateReplyPassMs);
  }
  assert.equal(firstRead.size, 100, `${100 - firstRead.size} sessions never read`);
  assert.ok(firstRead.get('conv-b95') - nudgedAt <= 1, `nudged before pass ${nudgedAt}, read in pass ${firstRead.get('conv-b95')}`);
  assert.deepEqual([firstRead.get('conv-b0'), firstRead.get('conv-b10'), firstRead.get('conv-b90')], [1, 2, 10], 'in the order they were sent');
});

test('a nudged session here is not starved by a slow paired relay\'s backlog', async () => {
  const { service, store, reads, answer, clock } = setup();
  for (let index = 0; index < 120; index += 1) store.add(`b-${String(index).padStart(3, '0')}`, { relay: 'rr_b', session: `conv-b${index}`, nextIn: -(index + 1) * SECOND });
  store.add('local', { session: 'conv-lane', nextIn: 5 * MINUTE });
  answer(async (group) => {
    if (group.relayId === 'rr_b') await new Promise((resolve) => setImmediate(resolve));
    return { outcomes: {} };
  });
  service.nudge('self', 'conv-lane');
  const passOf = new Map();
  for (let pass = 1; pass <= 2; pass += 1) {
    reads.length = 0;
    await service.pass();
    for (const group of reads) if (!passOf.has(group.sessionId)) passOf.set(group.sessionId, pass);
    assert.ok(reads.filter((group) => group.relayId === 'rr_b').length <= RELAY_EVENT_LIMITS.lateReplyReadsPerRelay);
    clock.advance(RELAY_EVENT_LIMITS.lateReplyPassMs);
  }
  assert.ok([1, 2].includes(passOf.get('conv-lane')), `read in pass ${passOf.get('conv-lane')}`);
});

test('a failing relay is skipped for the rest of the pass; the others go on', async () => {
  const { service, store, reads, answer } = setup();
  for (let index = 0; index < 4; index += 1) store.add(`b-${index}`, { relay: 'rr_b', session: `conv-b${index}` });
  store.add('c-0', { relay: 'rr_c', session: 'conv-c0' });
  answer((group) => {
    if (group.relayId === 'rr_b') throw new Error('offline');
    return outcomesFor(group, done());
  });
  await service.pass();
  const toB = reads.filter((group) => group.relayId === 'rr_b').length;
  assert.ok(toB <= 2, `at most the reads already in flight (${toB})`);
  assert.deepEqual(store.delivered.map((entry) => entry.id), ['c-0']);
  for (let index = 0; index < 4; index += 1) assert.equal(store.nextIn(`b-${index}`), 15 * SECOND, 'moved on by the cadence');
});

test('one pass at a time: a pass asked for while one runs waits for it', async () => {
  const { service, store, reads, answer } = setup();
  store.add('slow', { relay: 'rr_b' });
  let release;
  answer(() => new Promise((resolve) => {
    release = () => resolve({ outcomes: {} });
  }));
  const first = service.pass();
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.pass();
  assert.equal(second, first, 'the running pass');
  assert.equal(reads.length, 1);
  release();
  await first;
});

// ─── Rows that need no read; outcomes ────────────────────────────────────────

test('a gone watcher and a removed relay close their rows; target_gone closes at once', async () => {
  const { service, store, reads, answer } = setup();
  store.add('from-gone', { watcher: 'conv-gone' });
  store.add('to-removed', { relay: 'rr_removed', session: 'conv-r' });
  store.add('to-deleted', { relay: 'rr_b', session: 'conv-deleted' });
  store.add('to-archived', { relay: 'rr_b', session: 'conv-archived' });
  answer((group) => {
    if (group.relayId === 'rr_removed') return { gone: 'relay' };
    if (group.sessionId === 'conv-deleted') return { gone: 'session' };
    return { outcomes: { 'to-archived': { status: 'running' } }, archived: true, title: 'Archived lane' };
  });
  await service.pass();
  assert.deepEqual(store.closed, [{ id: 'from-gone', state: 'undeliverable' }, { id: 'to-removed', state: 'gave_up' }]);
  assert.ok(!reads.some((group) => group.rows.some((row) => row.messageId === 'from-gone')), 'no read for a gone watcher');
  assert.deepEqual(store.delivered.map((entry) => [entry.id, entry.outcome.status]), [['to-deleted', 'gone'], ['to-archived', 'gone']]);
  assert.equal(store.delivered[1].outcome.sessionTitle, 'Archived lane');
});

test('each outcome maps to its action', async () => {
  const { service, store, answer } = setup();
  const outcomes = {
    done: done(),
    'done-empty': { status: 'done', note: 'folded, no reply found' },
    failed: { status: 'failed', reply: { text: 'Error: it crashed' } },
    stopped: { status: 'stopped', note: 'stopped' },
    cancelled: { status: 'cancelled', note: 'cancelled' },
    queued: { status: 'queued' },
    running: { status: 'running' },
    waiting_behind_turn: { status: 'waiting_behind_turn' },
    waiting_for_answer: { status: 'waiting_for_answer' },
  };
  for (const id of Object.keys(outcomes)) store.add(id, { relay: 'rr_b' });
  answer(() => ({ outcomes, title: 'Lane', relayName: 'lab' }));
  await service.pass();
  assert.deepEqual(store.delivered.map((entry) => entry.id).sort(), ['cancelled', 'done', 'done-empty', 'failed', 'stopped']);
  assert.equal(store.delivered[0].outcome.relayName, 'lab');
  for (const id of ['queued', 'running', 'waiting_behind_turn', 'waiting_for_answer']) {
    assert.equal(store.rows.get(id).late_state, null);
    assert.equal(store.nextIn(id), 15 * SECOND);
  }
});

// ─── seen ────────────────────────────────────────────────────────────────────

test('seen carries over between passes: a background follow-up settles after the quiet time', async () => {
  const { service, store, reads, answer, clock } = setup();
  store.add('bg', { age: MINUTE });
  // The reader settles like a wait: running while the quiet time runs.
  answer((group) => {
    const { seen } = group.rows[0];
    seen.background = true;
    if (!seen.quietSince) seen.quietSince = clock.now();
    if (clock.now() - seen.quietSince < 10 * SECOND) return outcomesFor(group, { status: 'running' });
    return outcomesFor(group, done('the follow-up'));
  });
  await service.pass();
  assert.equal(service.seenCount(), 1);
  assert.equal(store.nextIn('bg'), RELAY_EVENT_LIMITS.lateReplyPassMs, 'a settling reply is due at the next pass, not in 5 min');
  clock.advance(RELAY_EVENT_LIMITS.lateReplyPassMs);
  await service.pass();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].rows[0].seen, reads[0].rows[0].seen, 'the same state');
  assert.deepEqual(store.delivered.map((entry) => entry.outcome.reply.text), ['the follow-up']);
  assert.equal(service.seenCount(), 0, 'gone with its row');
});

test('the seen map holds at most 200 entries, the oldest dropped first', async () => {
  const { service, store, answer } = setup();
  for (let index = 0; index < 210; index += 1) store.add(`s-${String(index).padStart(3, '0')}`, { session: `conv-s${index}`, nextIn: -(210 - index) * SECOND });
  answer((group) => {
    group.rows[0].seen.background = true;
    return outcomesFor(group, { status: 'running' });
  });
  for (let round = 0; round < 5; round += 1) await service.pass();
  assert.equal(service.seenCount(), RELAY_EVENT_LIMITS.lateReplySeenMax);
});
