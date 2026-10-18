import test from 'node:test';
import assert from 'node:assert/strict';

import { createTaskConsoleWatch } from './task-console-watch.mjs';

// The console's side of the task-output rooms: what it sends, and what it
// does with an unanswered watch.

function fakeSocket({ answer = () => ({ ok: true }), connected = true } = {}) {
  const sent = [];
  return {
    connected,
    sent,
    timeout: (ms) => ({
      emitWithAck: async (event, payload) => {
        sent.push({ event, payload, timeoutMs: ms });
        const result = answer(payload);
        if (result instanceof Error) throw result;
        return result;
      },
    }),
    emit: (event, payload) => sent.push({ event, payload }),
  };
}

test('a watch names the conversation and the task, and waits for the answer', async () => {
  const socket = fakeSocket();
  const watch = createTaskConsoleWatch({ getSocket: () => socket, timeoutMs: 500 });
  assert.deepEqual(await watch.watch('conv-fixture-1', 'task-fixture-shell'), { ok: true });
  assert.deepEqual(socket.sent, [{ event: 'task_output_watch', payload: { conversationId: 'conv-fixture-1', taskId: 'task-fixture-shell' }, timeoutMs: 500 }]);
  assert.deepEqual(watch.current(), { conversationId: 'conv-fixture-1', taskId: 'task-fixture-shell' });
});

test('a refusal comes back as the relay said it', async () => {
  const watch = createTaskConsoleWatch({ getSocket: () => fakeSocket({ answer: () => ({ ok: false, code: 'not-found' }) }) });
  assert.deepEqual(await watch.watch('conv-fixture-1', 'task-fixture-gone'), { ok: false, code: 'not-found' });
  const odd = createTaskConsoleWatch({ getSocket: () => fakeSocket({ answer: () => 'yes' }) });
  assert.deepEqual(await odd.watch('conv-fixture-1', 'task-fixture-shell'), { ok: false, code: 'bad-answer' });
});

test('unwatch tells the relay once and forgets the task', async () => {
  const socket = fakeSocket();
  const watch = createTaskConsoleWatch({ getSocket: () => socket });
  await watch.watch('conv-fixture-1', 'task-fixture-shell');
  watch.unwatch();
  watch.unwatch();
  assert.deepEqual(socket.sent.map((entry) => entry.event), ['task_output_watch', 'task_output_unwatch']);
  assert.equal(watch.current(), null);
});

test('offline or unanswered, the watch gives up quietly and keeps the task for the reconnect', async () => {
  const offline = fakeSocket({ connected: false });
  const watch = createTaskConsoleWatch({ getSocket: () => offline });
  assert.deepEqual(await watch.watch('conv-fixture-1', 'task-fixture-shell'), { ok: false, code: 'offline' });
  assert.equal(offline.sent.length, 0);
  assert.deepEqual(watch.current(), { conversationId: 'conv-fixture-1', taskId: 'task-fixture-shell' });
  watch.unwatch();
  assert.equal(offline.sent.length, 0, 'nothing to undo on a socket that is not connected');

  const silent = createTaskConsoleWatch({ getSocket: () => fakeSocket({ answer: () => new Error('operation has timed out') }) });
  assert.deepEqual(await silent.watch('conv-fixture-1', 'task-fixture-shell'), { ok: false, code: 'timeout' });
  const none = createTaskConsoleWatch({ getSocket: () => null });
  assert.equal((await none.watch('conv-fixture-1', 'task-fixture-shell')).ok, false);
});
