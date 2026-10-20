import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRelayRestartQueue,
  DEFAULT_RELAY_RESTART_MAX_WAIT_MINUTES,
  parseRelayRestartMaxWaitUpdate,
  readRelayRestartMaxWaitSetting,
  resolveRelayRestartMaxWaitOverrideMs,
} from './relay-restart-queue.mjs';

const MIN = 60_000;

// Fake clock + interval, as in host-suspend-service.test.mjs: `advance`
// drives the one poll timer deterministically.
function makeClock() {
  let nowMs = Date.parse('2026-10-19T08:00:00Z');
  const timers = new Map();
  let seq = 0;
  return {
    now: () => nowMs,
    setInterval(fn, ms) { const id = ++seq; timers.set(id, { fn, ms, next: nowMs + ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    advance(ms) {
      const target = nowMs + ms;
      while (true) {
        let soonest = null;
        for (const [id, t] of timers) if (t.next <= target && (!soonest || t.next < soonest.t.next)) soonest = { id, t };
        if (!soonest) break;
        nowMs = soonest.t.next;
        soonest.t.next += soonest.t.ms;
        soonest.t.fn();
      }
      nowMs = target;
    },
    get timerCount() { return timers.size; },
  };
}

const PICTURE = {
  waitingFor: [{ conversationId: 'c1', title: 'sidebar polish', turns: 1 }],
  held: { count: 2, conversations: [{ conversationId: 'c2', title: 'report builder', count: 2 }] },
  backgroundTasks: [{ conversationId: 'c3', title: 'nightly export', count: 1, detail: '1 background agent: export', survives: true, why: 'its worker keeps running' }],
  survival: { action: 'restart', workersSurvive: true, summary: 'workers keep running' },
};

function makeQueue({ processing = 1, maxWaitMs = 30 * MIN, picture = PICTURE } = {}) {
  const clock = makeClock();
  const box = { processing, maxWaitMs, shuttingDown: false };
  const states = [];
  const started = [];
  const asked = [];
  const queue = createRelayRestartQueue({
    getCounts: () => ({ pendingCount: 2, processingCount: box.processing, parkedCount: 0 }),
    collectPicture: ({ action }) => ({ ...picture, survival: { ...picture.survival, action } }),
    startShutdown: (info) => { started.push(info); box.shuttingDown = true; },
    getMaxWaitMs: () => box.maxWaitMs,
    isShuttingDown: () => box.shuttingDown,
    onStateChange: (state) => states.push(state),
    onMaxWaitReached: (state) => asked.push(state),
    logger: { log() {} },
    now: clock.now,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
  });
  return { queue, clock, box, states, started, asked };
}

test('the max-wait setting: choices only, unset reads as the default, 0 is no limit', () => {
  assert.equal(readRelayRestartMaxWaitSetting(undefined), DEFAULT_RELAY_RESTART_MAX_WAIT_MINUTES);
  assert.equal(readRelayRestartMaxWaitSetting(''), 30);
  assert.equal(readRelayRestartMaxWaitSetting('garbage'), 30);
  assert.equal(readRelayRestartMaxWaitSetting('0'), 0);
  assert.equal(readRelayRestartMaxWaitSetting('240'), 240);
  assert.deepEqual(parseRelayRestartMaxWaitUpdate(60), { ok: true, minutes: 60 });
  assert.deepEqual(parseRelayRestartMaxWaitUpdate(0), { ok: true, minutes: 0 });
  for (const bad of [3, 300, 7.5, '', null, 'x']) assert.equal(parseRelayRestartMaxWaitUpdate(bad).ok, false, String(bad));
});

test('the environment override is read in ms and ignored when unreadable', () => {
  assert.equal(resolveRelayRestartMaxWaitOverrideMs({}), null);
  assert.equal(resolveRelayRestartMaxWaitOverrideMs({ OAR_RELAY_RESTART_MAX_WAIT_MS: '4000' }), 4000);
  assert.equal(resolveRelayRestartMaxWaitOverrideMs({ OAR_RELAY_RESTART_MAX_WAIT_MS: '0' }), 0);
  assert.equal(resolveRelayRestartMaxWaitOverrideMs({ OAR_RELAY_RESTART_MAX_WAIT_MS: '-5' }), null);
  assert.equal(resolveRelayRestartMaxWaitOverrideMs({ OAR_RELAY_RESTART_MAX_WAIT_MS: 'soon' }), null);
});

test('nothing processing: the request starts the restart at once', () => {
  const { queue, started, clock } = makeQueue({ processing: 0 });
  const answer = queue.request({ reason: 'manual-restart', requestedBy: 'phone', restart: true });
  assert.equal(answer.accepted, true);
  assert.equal(answer.status, 'shutting_down');
  assert.equal(started.length, 1);
  assert.equal(started[0].action, 'restart');
  assert.equal(started[0].immediate, false);
  assert.equal(clock.timerCount, 0);
});

test('a queued restart waits for the processing turns, names them, and fires once they end', () => {
  const { queue, box, started, states, clock } = makeQueue();
  const answer = queue.request({ reason: 'manual-restart', requestedBy: 'phone', restart: true });
  assert.equal(answer.status, 'queued');
  // The caller (an agent, the UI) learns what it waits for and what survives.
  assert.deepEqual(answer.waitingFor, PICTURE.waitingFor);
  assert.equal(answer.held.count, 2);
  assert.equal(answer.backgroundTasks[0].survives, true);
  assert.equal(answer.maxWaitMs, 30 * MIN);
  assert.equal(answer.deadlineAt, '2026-10-19T08:30:00.000Z');
  assert.equal(queue.isQueued(), true);
  const state = queue.getState();
  assert.equal(state.status, 'queued');
  assert.equal(state.holdsNewTurns, true);
  assert.equal(state.question, null);
  assert.equal(state.waitingSince, '2026-10-19T08:00:00.000Z');
  assert.equal(states.at(-1).status, 'queued');

  clock.advance(10 * MIN);
  assert.equal(started.length, 0);
  box.processing = 0;
  clock.advance(1000);
  assert.equal(started.length, 1);
  assert.equal(started[0].action, 'restart');
  assert.equal(clock.timerCount, 0);
  assert.equal(queue.isQueued(), false);
});

test('past the maximum wait it asks once and never restarts by itself', () => {
  const { queue, started, asked, states, clock } = makeQueue({ maxWaitMs: 5 * MIN });
  queue.request({ restart: true });
  clock.advance(5 * MIN - 1000);
  assert.equal(asked.length, 0);
  assert.equal(queue.getState().question, null);
  clock.advance(1000);
  assert.equal(asked.length, 1, 'one push for the question');
  const state = queue.getState();
  assert.equal(state.status, 'queued');
  assert.equal(state.question.askedAt, '2026-10-19T08:05:00.000Z');
  assert.ok(states.some((s) => s.question), 'the question went out to the clients');
  // Hours later: still asking, still queued, still not restarted, asked once.
  clock.advance(2 * 60 * MIN);
  assert.equal(started.length, 0);
  assert.equal(asked.length, 1);
  assert.equal(queue.isQueued(), true);
});

test('keep waiting starts another full period from now', () => {
  const { queue, asked, clock } = makeQueue({ maxWaitMs: 5 * MIN });
  queue.request({ restart: true });
  clock.advance(7 * MIN);
  assert.equal(asked.length, 1);
  const answer = queue.keepWaiting({ requestedBy: 'phone' });
  assert.equal(answer.extended, true);
  assert.equal(answer.question, null);
  assert.equal(answer.keptWaiting, 1);
  assert.equal(answer.waitingSince, '2026-10-19T08:07:00.000Z');
  assert.equal(answer.deadlineAt, '2026-10-19T08:12:00.000Z');
  clock.advance(5 * MIN - 1000);
  assert.equal(asked.length, 1);
  clock.advance(1000);
  assert.equal(asked.length, 2, 'asks again after the next period');
});

test('no limit never asks', () => {
  const { queue, asked, clock } = makeQueue({ maxWaitMs: 0 });
  const answer = queue.request({ restart: true });
  assert.equal(answer.deadlineAt, null);
  clock.advance(5 * 60 * MIN);
  assert.equal(asked.length, 0);
  assert.equal(queue.getState().question, null);
});

test('a shorter maximum applies to the period already running', () => {
  const { queue, box, asked, clock } = makeQueue({ maxWaitMs: 60 * MIN });
  queue.request({ restart: true });
  clock.advance(20 * MIN);
  box.maxWaitMs = 15 * MIN;
  queue.refresh();
  assert.equal(asked.length, 1);
  assert.ok(queue.getState().question);
});

test('cancel drops the request, stops polling and releases the held turns', () => {
  const { queue, started, clock, states } = makeQueue();
  queue.request({ restart: true, requestedBy: 'phone' });
  const answer = queue.cancel({ requestedBy: 'laptop' });
  assert.equal(answer.cancelled, true);
  assert.equal(answer.dropped.action, 'restart');
  assert.equal(answer.status, 'idle');
  assert.equal(queue.isQueued(), false);
  assert.equal(clock.timerCount, 0);
  assert.equal(states.at(-1).status, 'idle');
  clock.advance(60 * MIN);
  assert.equal(started.length, 0);
  assert.equal(queue.cancel().cancelled, false);
  assert.equal(queue.keepWaiting().extended, false);
});

test('immediate starts now, running turns or not, and says what it did not wait for', () => {
  const { queue, started } = makeQueue();
  queue.request({ restart: true });
  const answer = queue.request({ restart: true, immediate: true, requestedBy: 'phone' });
  assert.equal(answer.status, 'shutting_down');
  assert.equal(answer.immediate, true);
  assert.deepEqual(answer.waitingFor, PICTURE.waitingFor);
  assert.equal(started.length, 1);
  assert.equal(started[0].immediate, true);
  assert.equal(started[0].counts.processingCount, 1);
  // Once shutting down every further request is refused.
  assert.equal(queue.request({ restart: true }).accepted, false);
  assert.equal(queue.cancel().cancelled, false);
});

test('a restart asked while a shutdown waits turns it into a restart', () => {
  const { queue } = makeQueue();
  queue.request({ restart: false, reason: 'manual-stop' });
  assert.equal(queue.getState().action, 'shutdown');
  const answer = queue.request({ restart: 'true', reason: 'manual-restart' });
  assert.equal(answer.action, 'restart');
  assert.equal(queue.getState().reason, 'manual-restart');
  // …and a shutdown asked while a restart waits does not downgrade it.
  queue.request({ restart: false });
  assert.equal(queue.getState().action, 'restart');
});

test('changes in what it waits for go out; an unchanged picture does not repeat', () => {
  let picture = PICTURE;
  const clock = makeClock();
  const states = [];
  const queue = createRelayRestartQueue({
    getCounts: () => ({ pendingCount: 0, processingCount: 1, parkedCount: 0 }),
    collectPicture: () => picture,
    startShutdown: () => {},
    getMaxWaitMs: () => 0,
    onStateChange: (state) => states.push(state),
    logger: { log() {} },
    now: clock.now,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
  });
  queue.request({ restart: true });
  const before = states.length;
  clock.advance(5000);
  assert.equal(states.length, before, 'nothing changed, nothing sent');
  picture = { ...PICTURE, waitingFor: [{ conversationId: 'c9', title: 'other', turns: 1 }] };
  clock.advance(1000);
  assert.equal(states.length, before + 1);
  assert.equal(states.at(-1).waitingFor[0].conversationId, 'c9');
});

test('a failing picture collector does not break the queue', () => {
  const clock = makeClock();
  const queue = createRelayRestartQueue({
    getCounts: () => ({ processingCount: 1 }),
    collectPicture: () => { throw new Error('db closed'); },
    startShutdown: () => {},
    logger: { log() {} },
    now: clock.now,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
  });
  const answer = queue.request({ restart: true });
  assert.equal(answer.status, 'queued');
  assert.deepEqual(answer.waitingFor, []);
});

test('with the question up it still restarts as soon as the turns end', () => {
  const { queue, box, started, asked, clock } = makeQueue({ maxWaitMs: 5 * MIN });
  queue.request({ restart: true });
  clock.advance(6 * MIN);
  assert.equal(asked.length, 1);
  assert.equal(started.length, 0, 'never while a turn runs');
  box.processing = 0;
  clock.advance(1000);
  assert.equal(started.length, 1);
  assert.equal(started[0].immediate, false);
});

test('a raised maximum withdraws the question; keep waiting without one does nothing', () => {
  const { queue, box, clock } = makeQueue({ maxWaitMs: 5 * MIN });
  queue.request({ restart: true });
  const early = queue.keepWaiting();
  assert.equal(early.extended, false, 'no question yet');
  assert.equal(early.keptWaiting, 0);
  clock.advance(6 * MIN);
  assert.ok(queue.getState().question);
  box.maxWaitMs = 60 * MIN;
  queue.refresh();
  assert.equal(queue.getState().question, null);
  box.maxWaitMs = 0;
  queue.refresh();
  assert.equal(queue.getState().question, null);
});

test('immediate keeps a queued shutdown a shutdown', () => {
  const { queue, started } = makeQueue();
  queue.request({ restart: false, reason: 'manual-stop' });
  queue.request({ restart: false, immediate: true });
  assert.equal(started[0].action, 'shutdown');
});

test('an immediate request for a queued request that is gone is refused', () => {
  const { queue, started } = makeQueue();
  // Nothing queued: a dialog shown for an earlier request.
  const stale = queue.request({ restart: true, immediate: true, expectRequestedAt: '2026-10-19T07:00:00.000Z' });
  assert.equal(stale.accepted, false);
  assert.equal(stale.stale, true);
  assert.equal(queue.isQueued(), false, 'nothing was queued by it');
  queue.request({ restart: true });
  const other = queue.request({ restart: true, immediate: true, expectRequestedAt: '2026-10-19T07:00:00.000Z' });
  assert.equal(other.stale, true);
  assert.equal(started.length, 0);
  const current = queue.getState().requestedAt;
  queue.request({ restart: true, immediate: true, expectRequestedAt: current });
  assert.equal(started.length, 1);
});

test('new held messages alone do not resend the state', () => {
  const clock = makeClock();
  const states = [];
  let pending = 0;
  const queue = createRelayRestartQueue({
    getCounts: () => ({ pendingCount: pending, processingCount: 1, parkedCount: 0 }),
    collectPicture: () => PICTURE,
    startShutdown: () => {},
    getMaxWaitMs: () => 0,
    onStateChange: (state) => states.push(state),
    logger: { log() {} },
    now: clock.now,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
  });
  queue.request({ restart: true });
  const before = states.length;
  pending = 5;
  clock.advance(3000);
  assert.equal(states.length, before);
});
