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

// ---------------------------------------------------- overlapping turns --

const realSleep = () => new Promise((resolve) => setTimeout(resolve, 1));

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await realSleep();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// Each test below ends its poller in `t.after`: a loop left running by a
// failed assertion would keep the test process alive.

/** A relay that hands out the queued controls one per poll, per row filter. */
function makeControlRelay() {
  const relay = {
    polls: [],
    acks: [],
    pending: [],
    api: async (method, routePath, body) => {
      if (method === 'GET' && routePath.startsWith('/api/control/active')) {
        const filter = new URL(routePath, 'http://relay.invalid').searchParams.get('queueMessageId') || '';
        relay.polls.push(filter);
        const index = relay.pending.findIndex((control) => !filter || control.queueMessageId === filter);
        return { ok: true, control: index === -1 ? null : relay.pending.splice(index, 1)[0] };
      }
      relay.acks.push({ routePath, body });
      return { ok: true };
    },
  };
  return relay;
}

test('stopping the newer registration keeps polling for the older one', async (t) => {
  const relay = makeControlRelay();
  const poller = createControlPoller({ api: relay.api, sdkSessionId: 'sess-1', sleep: realSleep });
  t.after(() => poller.stop());
  const handled = [];
  const older = poller.start({ queueMessageId: '', onAbortTurn: async (control) => { handled.push(['older', control.id]); } });
  const newer = poller.start({ queueMessageId: '', onAbortTurn: async (control) => { handled.push(['newer', control.id]); } });
  await waitUntil(() => relay.polls.length >= 2, 'two polling rounds');

  // The newer turn finished; the older one still waits (a question card).
  poller.stop(newer);
  relay.pending.push({ id: 'ctl-1', type: 'abort_turn', queueMessageId: 'q-1' });
  await waitUntil(() => handled.length === 1, 'the Stop reached the older turn');
  assert.deepEqual(handled, [['older', 'ctl-1']]);
  assert.deepEqual(relay.acks.map((ack) => ack.body.ok), [true]);

  poller.stop(older);
  await realSleep();
  const pollsAfterStop = relay.polls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(relay.polls.length, pollsAfterStop, 'nothing is polled once no turn is left');
});

test('a Stop that arrives after a handled Stop is still delivered', async (t) => {
  const relay = makeControlRelay();
  const poller = createControlPoller({ api: relay.api, sdkSessionId: 'sess-1', sleep: realSleep });
  t.after(() => poller.stop());
  const handled = [];
  const handle = poller.start({ queueMessageId: '', onAbortTurn: async (control) => { handled.push(control.queueMessageId); } });

  relay.pending.push({ id: 'ctl-1', type: 'abort_turn', queueMessageId: 'q-1' });
  await waitUntil(() => handled.length === 1, 'first Stop');
  relay.pending.push({ id: 'ctl-2', type: 'abort_turn', queueMessageId: 'q-2' });
  await waitUntil(() => handled.length === 2, 'second Stop');
  poller.stop(handle);

  assert.deepEqual(handled, ['q-1', 'q-2']);
  assert.deepEqual(relay.acks.map((ack) => ack.routePath), ['/api/control/ctl-1/result', '/api/control/ctl-2/result']);
});

test('registrations that share a row filter cost one request, and the newest is offered the Stop first', async (t) => {
  const relay = makeControlRelay();
  let wake = () => {};
  const sleep = () => new Promise((resolve) => { wake = resolve; });
  const poller = createControlPoller({ api: relay.api, sdkSessionId: 'sess-1', sleep });
  t.after(() => poller.stop());
  const offered = [];
  poller.start({ queueMessageId: '', onAbortTurn: async () => { offered.push('older'); } });
  poller.start({
    queueMessageId: '',
    onAbortTurn: async () => {
      offered.push('newer');
      throw new Error('nothing to stop here');
    },
  });
  relay.pending.push({ id: 'ctl-1', type: 'abort_turn', queueMessageId: 'q-1' });

  wake();
  await waitUntil(() => relay.acks.length === 1, 'the Stop was answered');
  assert.deepEqual(relay.polls, [''], 'one request for the round');
  assert.deepEqual(offered, ['newer', 'older']);
  assert.deepEqual(relay.acks[0].body, { ok: true, note: 'query aborted' });
  poller.stop();
  wake();
});

test('registrations with row filters of their own are each polled, and a bare stop ends them all', async (t) => {
  const relay = makeControlRelay();
  const poller = createControlPoller({ api: relay.api, sdkSessionId: 'sess-1', sleep: realSleep });
  t.after(() => poller.stop());
  const handled = [];
  poller.start({ queueMessageId: 'q-1', onAbortTurn: async (control) => { handled.push(['q-1 turn', control.id]); } });
  poller.start({ queueMessageId: 'q-2', onAbortTurn: async (control) => { handled.push(['q-2 turn', control.id]); } });

  relay.pending.push({ id: 'ctl-1', type: 'abort_turn', queueMessageId: 'q-1' });
  await waitUntil(() => handled.length === 1, 'the Stop for q-1');
  assert.deepEqual(handled, [['q-1 turn', 'ctl-1']]);
  assert.ok(relay.polls.includes('q-2'), 'the other row is polled too');

  poller.stop();
  await realSleep();
  const pollsAfterStop = relay.polls.length;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(relay.polls.length, pollsAfterStop);
});
