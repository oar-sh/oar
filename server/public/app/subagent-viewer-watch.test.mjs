import test from 'node:test';
import assert from 'node:assert/strict';

import { createSubagentViewerWatch } from './subagent-viewer-watch.mjs';

// The viewer's side of the record rooms: what it sends, and what it does with
// a refused or unanswered watch.

function fakeSocket({ answer = () => ({ ok: true }), connected = true } = {}) {
  const sent = [];
  const socket = {
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
  return socket;
}

test('a watch names the conversation and the run, and waits for the answer', async () => {
  const socket = fakeSocket();
  const watch = createSubagentViewerWatch({ getSocket: () => socket, timeoutMs: 500 });
  const result = await watch.watch('conv-fixture-1', 'toolu_fixture_alpha');
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(socket.sent, [{ event: 'subagent_viewer_watch', payload: { conversationId: 'conv-fixture-1', subagentRunId: 'toolu_fixture_alpha' }, timeoutMs: 500 }]);
  assert.deepEqual(watch.current(), { conversationId: 'conv-fixture-1', runId: 'toolu_fixture_alpha' });
  assert.equal(watch.refused(), false);
});

test('unwatch tells the relay once and forgets the run', async () => {
  const socket = fakeSocket();
  const watch = createSubagentViewerWatch({ getSocket: () => socket });
  await watch.watch('conv-fixture-1', 'toolu_fixture_alpha');
  watch.unwatch();
  watch.unwatch();
  assert.deepEqual(socket.sent.map((entry) => entry.event), ['subagent_viewer_watch', 'subagent_viewer_unwatch']);
  assert.equal(watch.current(), null);
});

test('a run the relay does not know yet is marked for another try', async () => {
  let known = false;
  const socket = fakeSocket({ answer: () => (known ? { ok: true } : { ok: false, code: 'not-found' }) });
  const watch = createSubagentViewerWatch({ getSocket: () => socket });
  assert.equal((await watch.watch('conv-fixture-1', 'toolu_fixture_alpha')).code, 'not-found');
  assert.equal(watch.refused(), true);
  known = true;
  assert.equal((await watch.watch('conv-fixture-1', 'toolu_fixture_alpha')).ok, true);
  assert.equal(watch.refused(), false);
  // Another refusal (a run of another conversation) is final.
  const mismatch = createSubagentViewerWatch({ getSocket: () => fakeSocket({ answer: () => ({ ok: false, code: 'conversation-mismatch' }) }) });
  await mismatch.watch('conv-fixture-2', 'toolu_fixture_alpha');
  assert.equal(mismatch.refused(), false);
});

test('offline or unanswered, the watch gives up quietly and keeps the run for the reconnect', async () => {
  const offline = fakeSocket({ connected: false });
  const watch = createSubagentViewerWatch({ getSocket: () => offline });
  assert.deepEqual(await watch.watch('conv-fixture-1', 'toolu_fixture_alpha'), { ok: false, code: 'offline' });
  assert.equal(offline.sent.length, 0);
  assert.deepEqual(watch.current(), { conversationId: 'conv-fixture-1', runId: 'toolu_fixture_alpha' });
  watch.unwatch();
  assert.equal(offline.sent.length, 0, 'nothing to undo on a socket that is not connected');

  const silent = createSubagentViewerWatch({ getSocket: () => fakeSocket({ answer: () => new Error('operation has timed out') }) });
  assert.deepEqual(await silent.watch('conv-fixture-1', 'toolu_fixture_alpha'), { ok: false, code: 'timeout' });
  const none = createSubagentViewerWatch({ getSocket: () => null });
  assert.equal((await none.watch('conv-fixture-1', 'toolu_fixture_alpha')).ok, false);
});
