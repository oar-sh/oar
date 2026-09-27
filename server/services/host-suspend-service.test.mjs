import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHostSuspendService,
  blockersFromActivity,
  HOST_SUSPEND_IDLE_WINDOW_MS,
  HOST_SUSPEND_IDLE_COUNTDOWN_MS,
} from './host-suspend-service.mjs';

// Fake clock + interval: the service only ever installs one poll timer, and
// `advance` drives it deterministically.
function makeClock() {
  let nowMs = 1_000_000;
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

function makeService({ activity = [], runSuspend = () => ({ ok: true }) } = {}) {
  const clock = makeClock();
  const states = [];
  const suspended = [];
  const dropped = [];
  const box = { activity };
  const service = createHostSuspendService({
    collectActivity: () => ({ blockers: typeof box.activity === 'function' ? box.activity() : box.activity }),
    runSuspend: (...args) => { suspended.push(args); return runSuspend(...args); },
    onStateChange: (s) => states.push(s),
    onSuspended: () => suspended.push('notified'),
    onDropped: (state, reason) => dropped.push({ state, reason }),
    logger: { log() {}, warn() {} },
    now: clock.now,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
  });
  return { service, clock, states, suspended, dropped, box };
}

const TURN = { kind: 'turn', conversationId: 'c1', title: 'sidebar polish', count: 1, detail: 'turn running' };

test('blockersFromActivity normalises and drops junk', () => {
  const out = blockersFromActivity({ blockers: [TURN, null, { kind: '' }, { kind: 'ci', count: '3', detail: 'x' }] });
  assert.equal(out.length, 2);
  assert.equal(out[1].count, 3);
  assert.equal(out[0].conversationId, 'c1');
});

test('idle at request time: 30 s countdown, then the suspend command runs once', () => {
  const { service, clock, states, suspended } = makeService({ activity: [] });
  const result = service.request({ reason: 'manual-suspend', requestedBy: 'phone' });
  assert.equal(result.accepted, true);
  assert.equal(result.state.status, 'countdown');
  assert.equal(Date.parse(result.state.fireAt) - clock.now(), HOST_SUSPEND_IDLE_COUNTDOWN_MS);
  assert.equal(result.state.idleWindowMs, HOST_SUSPEND_IDLE_COUNTDOWN_MS);

  clock.advance(HOST_SUSPEND_IDLE_COUNTDOWN_MS - 1000);
  assert.equal(suspended.length, 0);
  clock.advance(2000);
  assert.equal(suspended.filter((s) => s !== 'notified').length, 1, 'runSuspend called once');
  assert.ok(suspended.includes('notified'));
  assert.equal(service.getState().status, 'idle');
  assert.equal(clock.timerCount, 0, 'poll timer stopped');
  assert.deepEqual(states.map((s) => s.status), ['countdown', 'suspending', 'idle']);
});

test('busy at request time: queued until blockers clear, then a 2 minute window', () => {
  const { service, clock, suspended, box } = makeService({ activity: [TURN] });
  const result = service.request({});
  assert.equal(result.state.status, 'queued');
  assert.equal(result.state.fireAt, null);
  assert.equal(result.state.blockers[0].title, 'sidebar polish');

  clock.advance(10 * 60 * 1000);
  assert.equal(service.getState().status, 'queued');
  assert.equal(suspended.length, 0);

  box.activity = [];
  clock.advance(1000);
  const state = service.getState();
  assert.equal(state.status, 'countdown');
  assert.equal(state.idleWindowMs, HOST_SUSPEND_IDLE_WINDOW_MS);
  assert.equal(Date.parse(state.fireAt) - Date.parse(state.idleSince), HOST_SUSPEND_IDLE_WINDOW_MS);

  clock.advance(HOST_SUSPEND_IDLE_WINDOW_MS - 2000);
  assert.equal(suspended.length, 0);
  clock.advance(3000);
  assert.equal(suspended.filter((s) => s !== 'notified').length, 1);
});

test('a blocker reappearing during the idle window resets it', () => {
  const { service, clock, suspended, box } = makeService({ activity: [TURN] });
  service.request({});
  box.activity = [];
  clock.advance(1000);
  assert.equal(service.getState().status, 'countdown');
  clock.advance(60 * 1000);
  box.activity = [{ kind: 'background', conversationId: 'c1', title: 'report builder', count: 1, detail: '1 background agent' }];
  clock.advance(1000);
  assert.equal(service.getState().status, 'queued');
  assert.equal(service.getState().fireAt, null);
  box.activity = [];
  clock.advance(1000);
  const restarted = service.getState();
  assert.equal(restarted.status, 'countdown');
  clock.advance(HOST_SUSPEND_IDLE_WINDOW_MS - 5000);
  assert.equal(suspended.length, 0, 'window restarted from scratch');
  clock.advance(6000);
  assert.equal(suspended.filter((s) => s !== 'notified').length, 1);
});

test('cancel clears the request and stops polling; a second request is rejected while pending', () => {
  const { service, clock, states } = makeService({ activity: [TURN] });
  service.request({});
  const again = service.request({});
  assert.equal(again.accepted, false);
  assert.equal(again.alreadyPending, true);
  const cancelled = service.cancel({ requestedBy: 'phone' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(service.getState().status, 'idle');
  assert.equal(clock.timerCount, 0);
  assert.equal(states.at(-1).status, 'idle');
  assert.equal(service.cancel().cancelled, false);
});

test('state changes are only emitted on transitions, not every poll', () => {
  const { service, clock, states } = makeService({ activity: [TURN] });
  service.request({});
  clock.advance(30 * 1000);
  assert.equal(states.length, 1, 'stable queued state emitted once');
});

test('dispose drops a pending request and reports it; idle dispose stays quiet', () => {
  const { service, dropped } = makeService({ activity: [TURN] });
  service.dispose({ reason: 'restart' });
  assert.equal(dropped.length, 0);
  service.request({});
  service.dispose({ reason: 'restart' });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].reason, 'restart');
  assert.equal(dropped[0].state.status, 'queued');
  assert.equal(service.getState().status, 'idle');
});

test('a failing activity collector counts as busy rather than idle', () => {
  const clock = makeClock();
  const service = createHostSuspendService({
    collectActivity: () => { throw new Error('db locked'); },
    runSuspend: () => { throw new Error('must not run'); },
    logger: { log() {}, warn() {} },
    now: clock.now,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
  });
  const result = service.request({});
  assert.equal(result.state.status, 'queued');
  assert.equal(result.state.blockers[0].kind, 'error');
  assert.match(result.state.lastError, /db locked/);
});

test('a failed suspend command surfaces lastError and does not notify', () => {
  const { service, clock, suspended, states } = makeService({ activity: [], runSuspend: () => ({ ok: false, error: 'not windows' }) });
  service.request({});
  clock.advance(HOST_SUSPEND_IDLE_COUNTDOWN_MS + 1000);
  assert.ok(!suspended.includes('notified'));
  assert.equal(service.getState().status, 'idle');
  assert.equal(states.at(-1).lastError, 'not windows');
});
