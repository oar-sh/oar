import test from 'node:test';
import assert from 'node:assert/strict';

import { sessionLaunchMutex } from './session-launch-mutex-service.mjs';

test('one launch mutex per relay process: every importer gets the same one, and it serializes by session', async () => {
  const again = await import('./session-launch-mutex-service.mjs');
  assert.equal(again.sessionLaunchMutex, sessionLaunchMutex);
  const order = [];
  let release = null;
  const first = sessionLaunchMutex.runExclusive('sid-mutex-a', () => new Promise((resolve) => {
    order.push('first:start');
    release = () => { order.push('first:end'); resolve(); };
  }));
  const second = sessionLaunchMutex.runExclusive('sid-mutex-a', () => { order.push('second'); });
  const other = sessionLaunchMutex.runExclusive('sid-mutex-b', () => { order.push('other'); });
  await other;
  assert.deepEqual(order, ['first:start', 'other']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'other', 'first:end', 'second']);
});
