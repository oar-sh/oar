import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyedMutex } from './keyed-mutex-service.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('two runExclusive calls on the same key never overlap', async () => {
  const mutex = createKeyedMutex();
  let inside = 0;
  let maxInside = 0;
  const body = async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await tick();
    await tick();
    inside -= 1;
  };
  await Promise.all([
    mutex.runExclusive('a', body),
    mutex.runExclusive('a', body),
    mutex.runExclusive('a', body),
  ]);
  assert.equal(maxInside, 1);
  assert.equal(mutex.size(), 0);
});

test('different keys run concurrently', async () => {
  const mutex = createKeyedMutex();
  let inside = 0;
  let maxInside = 0;
  const body = async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await tick();
    inside -= 1;
  };
  await Promise.all([mutex.runExclusive('a', body), mutex.runExclusive('b', body)]);
  assert.equal(maxInside, 2);
});

test('tryRunExclusive reports busy while held and succeeds after release', async () => {
  const mutex = createKeyedMutex();
  let releaseFirst;
  const first = mutex.runExclusive('a', () => new Promise((resolve) => { releaseFirst = resolve; }));
  await tick();

  const busy = await mutex.tryRunExclusive('a', () => 'should not run');
  assert.deepEqual(busy, { ok: false, busy: true, result: undefined });

  releaseFirst();
  await first;

  const free = await mutex.tryRunExclusive('a', () => 'ran');
  assert.deepEqual(free, { ok: true, busy: false, result: 'ran' });
  assert.equal(mutex.size(), 0);
});

test('the lock is released when the body throws', async () => {
  const mutex = createKeyedMutex();
  await assert.rejects(
    mutex.runExclusive('a', async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(mutex.isLocked('a'), false);
  assert.equal(await mutex.runExclusive('a', () => 'ok'), 'ok');
  assert.equal(mutex.size(), 0);
});

test('a queued caller still runs after the holder throws', async () => {
  const mutex = createKeyedMutex();
  const order = [];
  const failing = mutex.runExclusive('a', async () => {
    order.push('first');
    await tick();
    throw new Error('boom');
  });
  const queued = mutex.runExclusive('a', async () => { order.push('second'); });
  await assert.rejects(failing, /boom/);
  await queued;
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(mutex.size(), 0);
});

test('stats reports held and waiting counts', async () => {
  const mutex = createKeyedMutex();
  let release;
  const held = mutex.runExclusive('a', () => new Promise((resolve) => { release = resolve; }));
  const waiting = mutex.runExclusive('a', () => {});
  await tick();
  assert.deepEqual(mutex.stats(), { held: 1, waiting: 1 });
  release();
  await Promise.all([held, waiting]);
  assert.deepEqual(mutex.stats(), { held: 0, waiting: 0 });
});

test('warns when a lock is held past staleAfterMs', async () => {
  const warnings = [];
  let now = 0;
  const mutex = createKeyedMutex({ nowMs: () => now, staleAfterMs: 100, warn: (m) => warnings.push(m) });
  let release;
  const held = mutex.runExclusive('a', () => new Promise((resolve) => { release = resolve; }));
  await tick();
  now = 5_000;
  await mutex.tryRunExclusive('a', () => {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /held for 5000ms/);
  release();
  await held;
});
