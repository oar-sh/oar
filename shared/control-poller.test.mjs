import test from 'node:test';
import assert from 'node:assert/strict';

import { createControlPoller } from './control-poller.mjs';

function makeApiStub({ control = null } = {}) {
  const calls = [];
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      if (method === 'GET' && routePath.startsWith('/api/control/active')) {
        return { ok: true, control };
      }
      return { ok: true };
    },
  };
}

test('abort_turn invokes onAbortTurn and acks with the configured note', async () => {
  const stub = makeApiStub({ control: { id: 'ctl-1', type: 'abort_turn' } });
  const poller = createControlPoller({
    api: stub.api,
    sdkSessionId: 'sess-1',
    abortAckNote: 'cursor run cancelled',
  });
  let abortCalls = 0;
  const aborted = await poller.checkOnce({
    queueMessageId: 'msg-1',
    onAbortTurn: async () => { abortCalls += 1; },
  });
  assert.equal(aborted, true);
  assert.equal(abortCalls, 1);
  const ack = stub.calls.find((call) => call.routePath === '/api/control/ctl-1/result');
  assert.deepEqual(ack.body, { ok: true, note: 'cursor run cancelled' });
});

test('abort ack note defaults to a provider-neutral message', async () => {
  const stub = makeApiStub({ control: { id: 'ctl-2', type: 'abort_turn' } });
  const poller = createControlPoller({ api: stub.api, sdkSessionId: 'sess-1' });
  await poller.checkOnce({ queueMessageId: 'msg-1', onAbortTurn: async () => {} });
  const ack = stub.calls.find((call) => call.routePath === '/api/control/ctl-2/result');
  assert.deepEqual(ack.body, { ok: true, note: 'query aborted' });
});

test('abort_subagent is answered not-supported and polling continues', async () => {
  const stub = makeApiStub({ control: { id: 'ctl-3', type: 'abort_subagent' } });
  const poller = createControlPoller({ api: stub.api, sdkSessionId: 'sess-1' });
  const aborted = await poller.checkOnce({ queueMessageId: 'msg-1', onAbortTurn: async () => { throw new Error('must not run'); } });
  assert.equal(aborted, false);
  const ack = stub.calls.find((call) => call.routePath === '/api/control/ctl-3/result');
  assert.equal(ack.body.ok, false);
  assert.match(ack.body.error, /not supported/);
});

test('onAbortTurn failure reports the error instead of acking', async () => {
  const stub = makeApiStub({ control: { id: 'ctl-4', type: 'abort_turn' } });
  const poller = createControlPoller({ api: stub.api, sdkSessionId: 'sess-1' });
  const aborted = await poller.checkOnce({
    queueMessageId: 'msg-1',
    onAbortTurn: async () => { throw new Error('cancel failed'); },
  });
  assert.equal(aborted, false);
  const ack = stub.calls.find((call) => call.routePath === '/api/control/ctl-4/result');
  assert.deepEqual(ack.body, { ok: false, error: 'cancel failed' });
});

test('missing session id or empty control is a no-op', async () => {
  const noSession = makeApiStub();
  const poller = createControlPoller({ api: noSession.api, sdkSessionId: '' });
  assert.equal(await poller.checkOnce({ queueMessageId: 'msg-1', onAbortTurn: async () => {} }), false);
  assert.equal(noSession.calls.length, 0);

  const noControl = makeApiStub({ control: null });
  const idlePoller = createControlPoller({ api: noControl.api, sdkSessionId: 'sess-1' });
  assert.equal(await idlePoller.checkOnce({ queueMessageId: 'msg-1', onAbortTurn: async () => {} }), false);
});

test('start polls until aborted and stop halts the loop', async () => {
  let served = 0;
  const stub = {
    api: async (method, routePath) => {
      if (method === 'GET' && routePath.startsWith('/api/control/active')) {
        served += 1;
        return served >= 3 ? { ok: true, control: { id: 'ctl-5', type: 'abort_turn' } } : { ok: true, control: null };
      }
      return { ok: true };
    },
  };
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const poller = createControlPoller({
    api: stub.api,
    sdkSessionId: 'sess-1',
    sleep: async () => {},
  });
  const state = poller.start({
    queueMessageId: 'msg-1',
    onAbortTurn: async () => { resolveDone(); },
  });
  await done;
  poller.stop(state);
  assert.equal(served >= 3, true);
});
