import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { installWorkerCrashGuard } from './worker-crash-guard.mjs';

function makeHarness({ activeIds = [], apiImpl = null } = {}) {
  const processImpl = new EventEmitter();
  const calls = [];
  const exits = [];
  const errors = [];
  installWorkerCrashGuard({
    api: apiImpl || (async (method, routePath, body) => { calls.push({ method, routePath, body }); return { ok: true }; }),
    workerName: 'test-worker',
    getActiveQueueMessageIds: () => activeIds,
    exit: (code) => exits.push(code),
    processImpl,
    logError: (...args) => errors.push(args.join(' ')),
  });
  return { processImpl, calls, exits, errors };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('an uncaught exception requeues every owed row and exits non-zero', async () => {
  const { processImpl, calls, exits, errors } = makeHarness({ activeIds: ['q-1', 'q-2', 'q-1'] });
  processImpl.emit('uncaughtException', new Error('boom'));
  await settle();
  assert.deepEqual(calls.map((call) => call.body.messageId), ['q-1', 'q-2'], 'deduplicated requeues');
  assert.deepEqual(exits, [1]);
  assert.match(errors[0], /test-worker uncaughtException/);
});

test('an unhandled rejection takes the same path', async () => {
  const { processImpl, calls, exits } = makeHarness({ activeIds: ['q-9'] });
  processImpl.emit('unhandledRejection', new Error('async boom'));
  await settle();
  assert.equal(calls[0].body.messageId, 'q-9');
  assert.deepEqual(exits, [1]);
});

test('a hanging requeue cannot block the exit', async () => {
  const { processImpl, exits } = (() => {
    const processImpl = new EventEmitter();
    const exits = [];
    installWorkerCrashGuard({
      api: () => new Promise(() => {}),
      getActiveQueueMessageIds: () => ['q-1'],
      requeueTimeoutMs: 30,
      exit: (code) => exits.push(code),
      processImpl,
      logError: () => {},
    });
    return { processImpl, exits };
  })();
  processImpl.emit('uncaughtException', new Error('boom'));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(exits, [1], 'exit must happen despite the hung requeue');
});

test('a second crash while crashing is ignored', async () => {
  const { processImpl, exits } = makeHarness({ activeIds: [] });
  processImpl.emit('uncaughtException', new Error('first'));
  processImpl.emit('uncaughtException', new Error('second'));
  await settle();
  assert.deepEqual(exits, [1], 'only one exit path runs');
});
