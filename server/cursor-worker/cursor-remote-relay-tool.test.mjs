import test from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteRelayTool } from './cursor-remote-relay-tool.mjs';
import { createCursorTurnRunner } from './cursor-turn-runner.mjs';
import {
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_ENDPOINT,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
} from '../../shared/remote-relay-contract.mjs';
import { createRemoteRelayToolGate } from '../../shared/remote-relay-tool-core.mjs';

function recordingApi(reply = { ok: true }) {
  const calls = [];
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      return typeof reply === 'function' ? reply({ method, routePath, body }) : reply;
    },
  };
}

test('tool registers under the contract name, description and schema', () => {
  const tool = createRemoteRelayTool({ api: recordingApi().api });
  assert.equal(tool.name, 'remote_relay');
  assert.equal(tool.description, REMOTE_RELAY_TOOL_DESCRIPTION);
  assert.deepEqual(tool.inputSchema, REMOTE_RELAY_TOOL_INPUT_SCHEMA);
  assert.notEqual(tool.inputSchema, REMOTE_RELAY_TOOL_INPUT_SCHEMA, 'the SDK gets its own copy of the frozen contract schema');
  assert.equal(Object.isFrozen(tool.inputSchema), false);
  assert.equal(typeof tool.execute, 'function');
});

test('execute forwards the call with the live conversation id and returns the relay JSON', async () => {
  const reply = { ok: true, status: 'done', relay: 'linux-test', reply: 'all green' };
  const stub = recordingApi(reply);
  let conversationId = 'conv-1';
  const tool = createRemoteRelayTool({ api: stub.api, getConversationId: () => conversationId });

  const result = await tool.execute({ action: 'wait', relay: 'linux-test', session: 'sess-1', message_id: 'm-1' });
  conversationId = 'conv-2';
  await tool.execute({ action: 'list_relays' });

  assert.deepEqual(stub.calls[0], {
    method: 'POST',
    routePath: REMOTE_RELAY_TOOL_ENDPOINT,
    body: {
      conversationId: 'conv-1',
      action: 'wait',
      args: { relay: 'linux-test', session: 'sess-1', message_id: 'm-1', wait_seconds: 120 },
    },
  });
  assert.equal(stub.calls[1].body.conversationId, 'conv-2', 'the id is read per call, not captured');
  assert.deepEqual(result.structuredContent, reply);
  assert.equal(result.content[0].type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), reply);
});

test('the call brackets are balanced on success, refusal and exception', async () => {
  const events = [];
  const make = (overrides) => createRemoteRelayTool({
    onCallStart: () => events.push('start'),
    onCallEnd: () => events.push('end'),
    getConversationId: () => 'conv-1',
    ...overrides,
  });

  await make({ api: recordingApi().api }).execute({ action: 'list_relays' });
  const refusal = await make({
    api: async () => { throw Object.assign(new Error('HTTP 403'), { status: 403, body: { ok: false, code: 'REMOTE_RELAY_LOCKED', error: 'locked' } }); },
  }).execute({ action: 'relay_info', relay: 'linux-test' });
  const crashed = await make({
    api: recordingApi().api,
    getConversationId: () => { throw new Error('no active turn'); },
  }).execute({ action: 'list_relays' });

  assert.deepEqual(events, ['start', 'end', 'start', 'end', 'start', 'end']);
  assert.equal(refusal.structuredContent.code, 'REMOTE_RELAY_LOCKED');
  assert.deepEqual(crashed.structuredContent, { ok: false, code: 'REMOTE_RELAY_CALL_FAILED', error: 'no active turn' });
});

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

// Holds the tool call until its signal aborts, like the real client.
function hangUntilAborted(options = {}) {
  return new Promise((_, reject) => {
    options.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

test('the turn\'s signal reaches the relay call; an abort answers REMOTE_RELAY_CANCELLED and ends the bracket', async () => {
  const events = [];
  const seen = [];
  const controller = new AbortController();
  const tool = createRemoteRelayTool({
    api: (method, routePath, body, options) => { seen.push(options); return hangUntilAborted(options); },
    getConversationId: () => 'conv-1',
    getAbortSignal: () => controller.signal,
    onCallStart: () => events.push('start'),
    onCallEnd: () => events.push('end'),
  });
  const pending = tool.execute({ action: 'wait', relay: 'linux-test', session: 's', message_id: 'm' }, { toolCallId: 't-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen[0].signal, controller.signal);
  assert.equal(seen[0].longCall, true);
  assert.deepEqual(events, ['start']);
  controller.abort();
  const result = await pending;
  assert.equal(result.structuredContent.code, 'REMOTE_RELAY_CANCELLED');
  assert.deepEqual(events, ['start', 'end']);

  // No getAbortSignal: the call simply has none.
  const bare = recordingApi();
  await createRemoteRelayTool({ api: bare.api, getConversationId: () => 'conv-1' }).execute({ action: 'list_relays' });
  assert.equal(bare.calls.length, 1);
});

// ─── the turn runner ─────────────────────────────────────────────────────────

function runnerFixture({ summary = { count: 1 }, toolReply = null, gate = null } = {}) {
  const calls = [];
  const api = async (method, routePath, body) => {
    calls.push({ method, routePath, body });
    if (routePath === '/api/remote-relays/summary') {
      if (summary instanceof Error) throw summary;
      return summary;
    }
    if (routePath === REMOTE_RELAY_TOOL_ENDPOINT && toolReply) return toolReply();
    return { ok: true };
  };
  const createCalls = [];
  const started = [];
  const runner = createCursorTurnRunner({
    api,
    sdkSessionId: 'sess-1',
    cwd: '/home/dev',
    apiKey: 'cursor-test-key',
    storeDir: '/home/dev/.cursor-agents',
    defaultModel: 'default-cursor-model',
    readContextWindowImpl: async () => null,
    resolveModelParamsImpl: async () => null,
    ...(gate ? { remoteRelayToolGate: gate } : {}),
    createAgentHandleImpl: async (options) => {
      createCalls.push(options);
      return { agent: {}, agentId: 'agent-new', close: async () => {} };
    },
    startCursorRunImpl: (options) => {
      started.push(options);
      return {
        async* [Symbol.asyncIterator]() {
          yield { source: 'delta', update: { type: 'text-delta', text: 'ok.' } };
          yield { source: 'stream', message: { type: 'status', status: 'FINISHED' } };
        },
        async cancel() {},
      };
    },
  });
  return { runner, calls, createCalls, started };
}

const message = { id: 'q-1', conversationId: 'conv-1', relayMode: 'agent', text: 'hello', model: 'cheetah', attachments: [] };

test('the handle carries remote_relay only when the relay reported a paired remote', async () => {
  const withRemote = runnerFixture({ summary: { count: 2 } });
  await withRemote.runner.handlePendingPayload({ message: { ...message } });
  const tools = withRemote.createCalls[0].customTools;
  assert.deepEqual(Object.keys(tools).sort(), ['ask_user', 'preview', 'remote_relay']);
  assert.equal(tools.remote_relay.description, REMOTE_RELAY_TOOL_DESCRIPTION);
  assert.equal(
    withRemote.calls.filter((call) => call.routePath === '/api/remote-relays/summary').length >= 1,
    true,
  );

  for (const summary of [{ count: 0 }, new Error('HTTP 404 /api/remote-relays/summary')]) {
    const without = runnerFixture({ summary });
    await without.runner.handlePendingPayload({ message: { ...message } });
    assert.deepEqual(Object.keys(without.createCalls[0].customTools).sort(), ['ask_user', 'preview']);
  }

  const pinned = runnerFixture({ summary: { count: 0 }, gate: createRemoteRelayToolGate({ fixed: true }) });
  await pinned.runner.handlePendingPayload({ message: { ...message } });
  assert.ok(pinned.createCalls[0].customTools.remote_relay);
});

test('a running remote_relay call holds the stall watchdog like an open ask_user card', async () => {
  let release = () => {};
  const { runner, createCalls, started, calls } = runnerFixture({
    toolReply: () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 'done' }); }),
  });
  await runner.handlePendingPayload({ message: { ...message } });
  const hasPendingClientWork = started[0].hasPendingClientWork;
  assert.equal(typeof hasPendingClientWork, 'function');
  assert.equal(hasPendingClientWork(), false);

  const call = createCalls[0].customTools.remote_relay.execute({ action: 'wait', relay: 'linux-test', session: 's', message_id: 'm' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hasPendingClientWork(), true, 'held while the relay waits for the remote');
  const toolCall = calls.find((entry) => entry.routePath === REMOTE_RELAY_TOOL_ENDPOINT);
  assert.equal(toolCall.body.conversationId, 'sess-1', 'between turns the worker session names the conversation');
  release();
  const result = await call;
  assert.equal(result.structuredContent.status, 'done');
  assert.equal(hasPendingClientWork(), false, 'released when the call settles');
});

test('a Stop cancels the pending remote_relay call and releases the hold', async () => {
  let abortTurn = null;
  let handleOptions = null;
  let toolCall = null;
  let hasPendingClientWork = null;
  let toolSignal = null;
  const toolOptions = [];
  const api = async (method, routePath, body, options) => {
    if (routePath === '/api/remote-relays/summary') return { count: 1 };
    if (routePath === REMOTE_RELAY_TOOL_ENDPOINT) {
      toolOptions.push(options);
      if (toolOptions.length > 1) return { ok: true, status: 'done' };
      toolSignal = options?.signal || null;
      return hangUntilAborted(options);
    }
    return { ok: true };
  };
  const runner = createCursorTurnRunner({
    api,
    sdkSessionId: 'sess-1',
    cwd: '/home/dev',
    apiKey: 'cursor-test-key',
    storeDir: '/home/dev/.cursor-agents',
    readContextWindowImpl: async () => null,
    resolveModelParamsImpl: async () => null,
    controlPoller: {
      start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return { id: 1 }; },
      stop: () => {},
    },
    createAgentHandleImpl: async (options) => {
      handleOptions = options;
      return { agent: {}, agentId: 'agent-new', close: async () => {} };
    },
    startCursorRunImpl: (options) => {
      hasPendingClientWork = options.hasPendingClientWork;
      return {
        async* [Symbol.asyncIterator]() {
          yield { source: 'delta', update: { type: 'text-delta', text: 'Asking linux-test.' } };
          // The model calls the tool; the run is silent until it answers.
          toolCall = handleOptions.customTools.remote_relay.execute(
            { action: 'wait', relay: 'linux-test', session: 's', message_id: 'm', wait_seconds: 600 },
            { toolCallId: 'tool-1' },
          );
          await new Promise((resolve) => options.abortSignal.addEventListener('abort', resolve, { once: true }));
        },
        async cancel() {},
      };
    },
  });

  const turn = runner.handlePendingPayload({ message: { ...message } });
  const deadline = Date.now() + 3_000;
  while (!toolSignal) {
    assert.ok(Date.now() < deadline, 'the call reached the relay');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(hasPendingClientWork(), true);
  assert.equal(toolSignal.aborted, false);

  await abortTurn();
  const result = await toolCall;
  assert.equal(toolSignal.aborted, true, 'the Stop reached the relay request');
  assert.equal(result.structuredContent.code, 'REMOTE_RELAY_CANCELLED');
  assert.equal(hasPendingClientWork(), false, 'the hold is released');
  assert.equal(await turn, true);

  // Between turns a call carries no signal: the stopped turn's would cancel it
  // before it started.
  const later = await handleOptions.customTools.remote_relay.execute({ action: 'list_relays' }, { toolCallId: 'tool-2' });
  assert.equal(later.structuredContent.status, 'done');
  assert.equal(toolOptions[1].signal, undefined);
});

test('a failing remote_relay call releases the hold too', async () => {
  const { runner, createCalls, started } = runnerFixture({
    toolReply: () => { throw new TypeError('fetch failed'); },
  });
  await runner.handlePendingPayload({ message: { ...message } });
  const result = await createCalls[0].customTools.remote_relay.execute({ action: 'list_relays' });
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.code, 'REMOTE_RELAY_CALL_FAILED');
  assert.equal(started[0].hasPendingClientWork(), false);
});
