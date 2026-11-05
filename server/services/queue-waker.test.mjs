import test from 'node:test';
import assert from 'node:assert/strict';

import { createPendingWorkerPrimer, createQueueWaker } from './queue-waker.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the primer launches a worker for every session with a pending row', async () => {
  const ensured = [];
  const warnings = [];
  let waiting = 0;
  const prime = createPendingWorkerPrimer({
    listPendingOwnerSessionIds: () => [
      { sdk_session_id: 'sdk-a' },
      { sdk_session_id: 'sdk-killed' },
      { sdk_session_id: 'sdk-api-refused' },
      { sdk_session_id: 'sdk-delayed' },
      { sdk_session_id: '' },
    ],
    isKillBlocked: (sid) => sid === 'sdk-killed',
    failRowsWithoutLaunch: (sid) => sid === 'sdk-api-refused',
    ensureWorker: async (sid) => {
      ensured.push(sid);
      return sid === 'sdk-delayed' ? { ok: false, error: 'restart-delayed' } : { ok: true };
    },
    onRowsWaiting: () => { waiting += 1; },
    warn: (line) => warnings.push(line),
  });
  assert.equal(await prime('test'), 2);
  assert.deepEqual(ensured, ['sdk-a', 'sdk-delayed']);
  assert.equal(waiting, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WORKER PRIME blocked session=sdk-dela reason=restart-delayed/);
});

test('the primer does nothing when switched off, and arms nothing without rows', async () => {
  let listed = 0;
  let waiting = 0;
  const off = createPendingWorkerPrimer({
    isEnabled: () => false,
    listPendingOwnerSessionIds: () => { listed += 1; return []; },
    ensureWorker: async () => ({ ok: true }),
  });
  assert.equal(await off('x'), 0);
  assert.equal(listed, 0);
  const empty = createPendingWorkerPrimer({
    listPendingOwnerSessionIds: () => [],
    ensureWorker: async () => ({ ok: true }),
    onRowsWaiting: () => { waiting += 1; },
  });
  assert.equal(await empty('x'), 0);
  assert.equal(waiting, 0);
});

test('a throw in one session costs only that session its launch', async () => {
  const ensured = [];
  const prime = createPendingWorkerPrimer({
    listPendingOwnerSessionIds: () => [{ sdk_session_id: 'sdk-bad' }, { sdk_session_id: 'sdk-good' }, { sdk_session_id: 'sdk-throws' }],
    failRowsWithoutLaunch: (sid) => { if (sid === 'sdk-bad') throw new Error('lookup failed'); return false; },
    ensureWorker: async (sid) => { ensured.push(sid); if (sid === 'sdk-throws') throw new Error('spawn'); return { ok: true }; },
  });
  assert.equal(await prime('x'), 2);
  assert.deepEqual(ensured, ['sdk-good', 'sdk-throws']);
});

function makeWaker(overrides = {}) {
  const calls = { notify: [], prime: [], arm: 0 };
  let ready = true;
  let clock = 0;
  let releasePrime = null;
  const waker = createQueueWaker({
    prime: async (reason) => {
      calls.prime.push(reason);
      if (overrides.slowPrime) await new Promise((resolve) => { releasePrime = resolve; });
    },
    notify: (reason) => calls.notify.push(reason),
    armPrime: () => { calls.arm += 1; },
    isReady: () => ready,
    now: () => clock,
    ...overrides.options,
  });
  return {
    waker,
    calls,
    setReady: (value) => { ready = value; },
    advance: (ms) => { clock += ms; },
    releasePrime: () => releasePrime?.(),
  };
}

test('a wake hands out, primes and arms the maintenance pass', async () => {
  const { waker, calls } = makeWaker();
  assert.equal(waker.wake('retry-due'), true);
  await tick();
  assert.deepEqual(calls.notify, ['retry-due']);
  assert.deepEqual(calls.prime, ['retry-due']);
  assert.equal(calls.arm, 1);
});

test('a write wake hands out and arms, and leaves the prime to the pass', async () => {
  const { waker, calls } = makeWaker();
  waker.wake('insert', { prime: false });
  await tick();
  assert.deepEqual(calls.notify, ['insert']);
  assert.deepEqual(calls.prime, []);
  assert.equal(calls.arm, 1);
});

test('before the start, or during shutdown, a wake does nothing', async () => {
  const { waker, calls, setReady } = makeWaker();
  setReady(false);
  assert.equal(waker.wake('insert'), false);
  assert.equal(waker.primeFromBackstop(), false);
  await tick();
  assert.deepEqual(calls, { notify: [], prime: [], arm: 0 });
});

test('primes never overlap: wakes during a prime run one more prime after it', async () => {
  const { waker, calls, releasePrime } = makeWaker({ slowPrime: true });
  waker.wake('a');
  waker.wake('b');
  waker.wake('c');
  await tick();
  assert.deepEqual(calls.prime, ['a']);
  assert.deepEqual(calls.notify, ['a', 'b', 'c'], 'handing out never waits for a prime');
  releasePrime();
  await tick();
  await tick();
  assert.deepEqual(calls.prime, ['a', 'c']);
  releasePrime();
  await tick();
  assert.deepEqual(calls.prime, ['a', 'c']);
  assert.deepEqual(waker.status(), { primeRunning: false, primeQueued: false });
});

test('the backstop arms every time but primes at most every 5 s', async () => {
  const { waker, calls, advance } = makeWaker();
  assert.equal(waker.primeFromBackstop(), true);
  advance(500);
  assert.equal(waker.primeFromBackstop(), false);
  advance(4_499);
  assert.equal(waker.primeFromBackstop(), false);
  advance(1);
  assert.equal(waker.primeFromBackstop(), true);
  await tick();
  assert.equal(calls.prime.length, 2);
  assert.equal(calls.arm, 4);
  assert.deepEqual(calls.notify, [], 'the poll hands out by itself');
});

test('a notify that throws is logged and the prime still runs', async () => {
  const warnings = [];
  const primed = [];
  const waker = createQueueWaker({
    prime: async (reason) => { primed.push(reason); },
    notify: () => { throw new Error('socket service gone'); },
    warn: (line) => warnings.push(line),
  });
  waker.wake('x');
  await tick();
  assert.deepEqual(primed, ['x']);
  assert.match(warnings[0], /queue notify failed reason=x err=socket service gone/);
});
