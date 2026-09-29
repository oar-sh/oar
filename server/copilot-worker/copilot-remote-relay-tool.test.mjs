// The relay's `remote_relay` for Copilot SDK sessions: the pure definition,
// and the runner wiring (registration, the ask_user fallback keeping it, the
// stall-watchdog hold while a call runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCopilotRemoteRelayTool } from './copilot-remote-relay-tool.mjs';
import {
  baseMessage,
  createFakeCopilotClient,
  loadFixture,
  makeApiStub,
  makeRunner,
  waitFor,
} from './copilot-sdk-test-harness.mjs';
import {
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_ENDPOINT,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
} from '../../shared/remote-relay-contract.mjs';
import { createRemoteRelayToolGate } from '../../shared/remote-relay-tool-core.mjs';

test('the definition is the contract tool, approved by the relay rather than the runtime', () => {
  const tool = buildCopilotRemoteRelayTool({ api: async () => ({}) });
  assert.equal(tool.name, 'remote_relay');
  assert.equal(tool.description, REMOTE_RELAY_TOOL_DESCRIPTION);
  assert.deepEqual(tool.parameters, REMOTE_RELAY_TOOL_INPUT_SCHEMA);
  assert.notEqual(tool.parameters, REMOTE_RELAY_TOOL_INPUT_SCHEMA, 'the SDK gets its own copy');
  assert.equal(tool.skipPermission, true);
  assert.equal('overridesBuiltInTool' in tool, false, 'it overrides nothing, so no fallback may strip it');
  assert.equal(typeof tool.handler, 'function');
});

test('the handler forwards through runCall and answers with pretty JSON text', async () => {
  const calls = [];
  const reply = { ok: true, status: 'queued', relay: 'linux-test', session: 's-1', message_id: 'm-1' };
  const wrapped = [];
  const tool = buildCopilotRemoteRelayTool({
    api: async (method, routePath, body) => { calls.push({ method, routePath, body }); return reply; },
    getConversationId: () => 'conv-4',
    runCall: async (fn) => { wrapped.push('in'); try { return await fn(); } finally { wrapped.push('out'); } },
  });
  const text = await tool.handler({ action: 'create_session', relay: 'linux-test', text: 'sidebar polish', wait_seconds: 0 });
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text), reply);
  assert.deepEqual(wrapped, ['in', 'out']);
  assert.deepEqual(calls, [{
    method: 'POST',
    routePath: REMOTE_RELAY_TOOL_ENDPOINT,
    body: {
      conversationId: 'conv-4',
      action: 'create_session',
      args: { relay: 'linux-test', text: 'sidebar polish', wait_seconds: 0 },
    },
  }]);
});

test('a throwing wrapper answers in-band instead of throwing into the runtime', async () => {
  const tool = buildCopilotRemoteRelayTool({
    api: async () => ({ ok: true }),
    runCall: async () => { throw new Error('worker shutting down'); },
  });
  assert.deepEqual(JSON.parse(await tool.handler({ action: 'list_relays' })), {
    ok: false,
    code: 'REMOTE_RELAY_CALL_FAILED',
    error: 'worker shutting down',
  });
});

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

test('the handler forwards the SDK invocation signal; an abort answers REMOTE_RELAY_CANCELLED', async () => {
  const seen = [];
  const tool = buildCopilotRemoteRelayTool({
    api: (method, routePath, body, options = {}) => new Promise((_, reject) => {
      seen.push(options);
      options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    }),
    getConversationId: () => 'conv-4',
  });
  const controller = new AbortController();
  const pending = tool.handler({ action: 'list_relays' }, { toolCallId: 'c-1', signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen[0].signal, controller.signal, 'invocation.signal by default');
  assert.equal(seen[0].longCall, true);
  // The runtime completed the request, or the session disconnected.
  controller.abort();
  assert.equal(JSON.parse(await pending).code, 'REMOTE_RELAY_CANCELLED');
});

// ------------------------------------------------------------ the runner --

function setup({ summary = { count: 1 }, toolReply = undefined, ...overrides } = {}) {
  const routeResponses = { '/api/remote-relays/summary': summary };
  if (toolReply !== undefined) routeResponses[REMOTE_RELAY_TOOL_ENDPOINT] = toolReply;
  const stub = makeApiStub({ routeResponses });
  const client = createFakeCopilotClient({ onSend: () => {} });
  const { runner } = makeRunner({ stub, client, ...overrides });
  return { stub, client, runner };
}

async function openTurn(client, runner, message = baseMessage) {
  const pending = runner.handlePendingPayload({ message });
  await waitFor(() => client.session?.sends.length >= 1 && runner.isTurnActive(), { label: 'prompt sent' });
  return { pending };
}

function remoteTool(config) {
  return (config.tools || []).find((tool) => tool.name === 'remote_relay') || null;
}

test('sessions carry remote_relay next to ask_user when the relay reported a paired remote', async () => {
  const { client, runner, stub } = setup({ summary: { count: 1 } });
  const { pending } = await openTurn(client, runner);
  const tools = client.createAttempts[0].tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['ask_user', 'remote_relay']);
  assert.equal(remoteTool(client.createAttempts[0]).skipPermission, true);
  assert.equal(stub.calls.some((call) => call.routePath === '/api/remote-relays/summary'), true);
  client.session.emit({ type: 'session.idle', data: {} });
  await pending;
});

test('no paired remote, a failing summary, or a pinned-off gate leave the tool out', async () => {
  for (const options of [
    { summary: { count: 0 } },
    { summary: () => { throw new Error('HTTP 404 /api/remote-relays/summary'); } },
    { summary: { count: 3 }, remoteRelayToolGate: createRemoteRelayToolGate({ fixed: false }) },
  ]) {
    const { client, runner } = setup(options);
    const { pending } = await openTurn(client, runner);
    assert.deepEqual(client.createAttempts[0].tools.map((tool) => tool.name), ['ask_user']);
    client.session.emit({ type: 'session.idle', data: {} });
    await pending;
  }
});

test('without the ask_user override the session still carries remote_relay alone', async () => {
  const { client, runner } = setup({ relayAskUserTool: false });
  const { pending } = await openTurn(client, runner);
  assert.deepEqual(client.createAttempts[0].tools.map((tool) => tool.name), ['remote_relay']);
  client.session.emit({ type: 'session.idle', data: {} });
  await pending;
});

test('a runtime that refuses the ask_user override keeps remote_relay in the fallback session', async () => {
  const { client, runner } = setup();
  const createSession = client.createSession.bind(client);
  let refusals = 0;
  client.createSession = async (config) => {
    if (config.tools?.some((tool) => tool.name === 'ask_user')) {
      refusals += 1;
      client.createAttempts.push(config);
      throw new Error('Tool "ask_user" clashes with a built-in tool');
    }
    return createSession(config);
  };
  const { pending } = await openTurn(client, runner);
  assert.equal(refusals, 1);
  const fallback = client.session.config;
  assert.deepEqual(fallback.tools.map((tool) => tool.name), ['remote_relay'], 'only the override is dropped');
  assert.equal(typeof fallback.onUserInputRequest, 'function', 'the built-in ask_user path answers instead');
  client.session.emit({ type: 'session.idle', data: {} });
  await pending;
});

test('a refusal that is not about the override is not retried', async () => {
  const { client, runner } = setup();
  let attempts = 0;
  client.createSession = async () => {
    attempts += 1;
    throw new Error('Pending response rejected since connection got disposed');
  };
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(attempts, 1);
});

test('a remote_relay call between turns keeps the runtime from idling out under it', async () => {
  let release = () => {};
  const remoteTurn = new Promise((resolve) => { release = resolve; });
  const { client, runner } = setup({
    idleShutdownMs: 1,
    lifecyclePollMs: 60_000,
    toolReply: async () => { await remoteTurn; return { ok: true, status: 'done' }; },
  });
  const { pending } = await openTurn(client, runner);
  client.session.emit({ type: 'session.idle', data: {} });
  await pending;
  // A background agent calls the tool after the turn settled.
  const call = remoteTool(client.createAttempts[0]).handler({ action: 'list_relays' }, { toolCallId: 'bg-1' });
  await waitFor(() => runner._getState().pendingRelayToolCalls === 1, { label: 'call counted' });
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  runner._evaluateLifecycle();
  assert.equal(client.stopped, 0, 'the runtime must stay up while the relay works for it');

  release();
  await call;
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  runner._evaluateLifecycle();
  await waitFor(() => client.stopped === 1, { label: 'idle shutdown after the call' });
});

test('a running remote_relay call holds the stall watchdog', async () => {
  let release = () => {};
  const remoteTurn = new Promise((resolve) => { release = resolve; });
  const { client, runner, stub } = setup({
    turnStallTimeoutMs: 25,
    toolReply: async () => { await remoteTurn; return { ok: true, status: 'done', reply: 'all green' }; },
  });
  const { pending } = await openTurn(client, runner);
  const call = remoteTool(client.createAttempts[0]).handler(
    { action: 'wait', relay: 'linux-test', session: 's-1', message_id: 'm-1', wait_seconds: 600 },
    { toolCallId: 'c1' },
  );
  await waitFor(() => runner._getState().pendingRelayToolCalls === 1, { label: 'call counted' });

  // Well past the 25ms ceiling while the relay waits on the remote turn.
  await new Promise((resolve) => { setTimeout(resolve, 90); });
  assert.equal(runner.isTurnActive(), true, 'the row must not be failed while the relay waits');
  assert.equal(stub.bodiesFor('/api/response').length, 0);
  // Not a question card: steering stays open.
  assert.equal(runner.steeringState().holdReason === 'question', false);

  release();
  assert.equal(JSON.parse(await call).reply, 'all green');
  assert.equal(runner._getState().pendingRelayToolCalls, 0);
  const toolCall = stub.calls.find((entry) => entry.routePath === REMOTE_RELAY_TOOL_ENDPOINT);
  assert.equal(toolCall.body.conversationId, baseMessage.conversationId);

  client.session.emit({ type: 'session.idle', data: {} });
  assert.equal(await pending, true);
});

/**
 * A runner whose relay holds every remote_relay call open until the call's
 * signal aborts (or the test answers it), recording each call's signal.
 */
function setupHeldCalls({ onAbort = null } = {}) {
  const stub = makeApiStub({ routeResponses: { '/api/remote-relays/summary': { count: 1 } } });
  const held = [];
  const api = (method, routePath, body, options = {}) => {
    if (routePath !== REMOTE_RELAY_TOOL_ENDPOINT) return stub(method, routePath, body);
    return new Promise((resolve, reject) => {
      held.push({ signal: options.signal || null, answer: resolve });
      options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  };
  api.calls = stub.calls;
  api.bodiesFor = stub.bodiesFor;
  const client = createFakeCopilotClient({ onSend: () => {}, onAbort });
  let abortTurn = null;
  const controlPoller = {
    start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return { id: 1 }; },
    stop: () => {},
  };
  const { runner } = makeRunner({ stub: api, client, controlPoller });
  return { client, runner, held, stop: (control) => abortTurn(control) };
}

test('a Stop cancels the pending remote_relay call and releases the hold', async () => {
  const events = loadFixture('abort-turn');
  const afterAbort = events.slice(events.findIndex((event) => event.type === 'abort'));
  const { client, runner, held, stop } = setupHeldCalls({ onAbort: (session) => session.replay(afterAbort) });
  const { pending } = await openTurn(client, runner);
  const call = remoteTool(client.createAttempts[0]).handler(
    { action: 'send', relay: 'linux-test', session: 's-1', text: 'run the report builder tests', wait_seconds: 600 },
    { toolCallId: 'c1' },
  );
  await waitFor(() => held.length === 1 && runner._getState().pendingRelayToolCalls === 1, { label: 'call held' });
  assert.equal(held[0].signal.aborted, false);

  await stop({ queueMessageId: baseMessage.id });
  assert.equal(held[0].signal.aborted, true, 'the Stop reached the relay request');
  assert.equal(JSON.parse(await call).code, 'REMOTE_RELAY_CANCELLED');
  assert.equal(runner._getState().pendingRelayToolCalls, 0, 'the hold is released');
  assert.equal(await pending, true);
});

test('a call still running when its turn settles normally is not cancelled', async () => {
  // A background agent's call: the main loop going idle must not end it.
  const { client, runner, held } = setupHeldCalls();
  const { pending } = await openTurn(client, runner);
  const call = remoteTool(client.createAttempts[0]).handler({ action: 'list_relays' }, { toolCallId: 'bg-1' });
  await waitFor(() => held.length === 1, { label: 'call held' });
  client.session.emit({ type: 'session.idle', data: {} });
  assert.equal(await pending, true);
  assert.equal(held[0].signal.aborted, false);
  held[0].answer({ ok: true, relays: [] });
  assert.equal(JSON.parse(await call).ok, true);
  assert.equal(runner._getState().pendingRelayToolCalls, 0);
});

test('a failed remote_relay call releases the hold, and the watchdog works again', async () => {
  const { client, runner, stub } = setup({
    turnStallTimeoutMs: 25,
    toolReply: () => { throw new TypeError('fetch failed'); },
  });
  const { pending } = await openTurn(client, runner);
  const text = await remoteTool(client.createAttempts[0]).handler({ action: 'list_relays' }, { toolCallId: 'c2' });
  assert.equal(JSON.parse(text).code, 'REMOTE_RELAY_CALL_FAILED');
  assert.equal(runner._getState().pendingRelayToolCalls, 0);
  // Nothing holds the silent runtime any more: the watchdog fails the row.
  assert.equal(await pending, true);
  assert.equal(stub.bodiesFor('/api/response')[0].terminalError.stableCode, 'copilot.turn-stalled');
});
