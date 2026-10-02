import test from 'node:test';
import assert from 'node:assert/strict';

import { REMOTE_RELAY_TOOL_ZOD_SHAPE, createRemoteRelayToolDefinition } from './claude-remote-relay-tool.mjs';
import {
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_ENDPOINT,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
} from '../../shared/remote-relay-contract.mjs';
import { createRemoteRelayToolGate } from '../../shared/remote-relay-tool-core.mjs';
import {
  baseMessage,
  fakeTurn,
  initMessage,
  makeApiStub,
  makeRunner,
  resultMessage,
  scriptedTurn,
  settled,
  waitFor,
} from './claude-session-test-harness.mjs';

function recordingApi(reply = { ok: true }) {
  const calls = [];
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      return reply;
    },
  };
}

// One value of the right JSON type per contract property, so the parity test
// can check the zod mirror accepts what the schema describes.
function sampleFor(property) {
  if (Array.isArray(property.enum)) return property.enum[0];
  if (property.type === 'string') return 'x';
  if (property.type === 'integer') return 5;
  if (property.type === 'boolean') return true;
  if (property.type === 'array') return ['a'];
  throw new Error(`no sample for ${property.type}`);
}

function wrongTypeFor(property) {
  return property.type === 'string' ? 7 : 'seven';
}

test('the definition carries the contract name/description and a zod shape', () => {
  const definition = createRemoteRelayToolDefinition({ api: recordingApi().api });
  assert.equal(definition.name, 'remote_relay');
  assert.equal(definition.description, REMOTE_RELAY_TOOL_DESCRIPTION);
  assert.equal(definition.inputSchema, REMOTE_RELAY_TOOL_ZOD_SHAPE);
  assert.equal(typeof definition.handler, 'function');
});

test('the zod mirror has parity with the contract schema', () => {
  const properties = REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties;
  assert.deepEqual(
    Object.keys(REMOTE_RELAY_TOOL_ZOD_SHAPE),
    Object.keys(properties),
    'the zod mirror must cover exactly the contract fields, in order',
  );
  for (const [field, schema] of Object.entries(REMOTE_RELAY_TOOL_ZOD_SHAPE)) {
    const property = properties[field];
    assert.equal(schema.description, property.description, `${field} description must come from the contract`);
    assert.equal(
      schema.safeParse(undefined).success,
      !REMOTE_RELAY_TOOL_INPUT_SCHEMA.required.includes(field),
      `${field} optionality must match the contract`,
    );
    assert.equal(schema.safeParse(sampleFor(property)).success, true, `${field} accepts a ${property.type}`);
    assert.equal(schema.safeParse(wrongTypeFor(property)).success, false, `${field} rejects the wrong type`);
    if (Array.isArray(property.enum)) {
      for (const value of property.enum) {
        assert.equal(schema.safeParse(value).success, true, `${field} accepts ${value}`);
      }
      assert.equal(schema.safeParse('not-a-member').success, false, `${field} is an enum`);
    }
  }
});

test('the zod mirror takes an effort as free text and the handler passes it on', async () => {
  const schema = REMOTE_RELAY_TOOL_ZOD_SHAPE.effort;
  assert.ok(schema, 'effort is part of the shape');
  for (const effort of ['none', 'medium', 'xhigh', 'ultracode']) {
    assert.equal(schema.safeParse(effort).success, true, `${effort}: the relay validates the value, not the SDK`);
  }
  assert.equal(schema.safeParse(undefined).success, true);
  assert.equal(schema.safeParse(3).success, false);

  const stub = recordingApi({ ok: true, status: 'queued' });
  const definition = createRemoteRelayToolDefinition({ api: stub.api, getConversationId: () => 'conv-1' });
  await definition.handler({ action: 'create_session', relay: 'linux-test', text: 'build it', model: 'claude-opus-5', effort: 'Medium' }, {});
  assert.equal(stub.calls[0].body.args.effort, 'medium');
  assert.equal(stub.calls[0].body.args.model, 'claude-opus-5');

  const refused = JSON.parse((await definition.handler(
    { action: 'send', relay: 'linux-test', session: 's-1', text: 'go on', effort: 'very high!' },
    {},
  )).content[0].text);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'REMOTE_RELAY_INVALID_INPUT');
  assert.equal(stub.calls.length, 1, 'a malformed effort never reaches the relay');
});

test('the zod mirror takes repo and branch, and the handler sends a cloud create to this relay with them', async () => {
  for (const field of ['repo', 'branch']) {
    assert.ok(REMOTE_RELAY_TOOL_ZOD_SHAPE[field], `${field} is part of the shape`);
    assert.equal(REMOTE_RELAY_TOOL_ZOD_SHAPE[field].safeParse(undefined).success, true);
  }
  assert.equal(REMOTE_RELAY_TOOL_ZOD_SHAPE.provider.safeParse('claude-cloud').success, true);

  const stub = recordingApi({ ok: true, status: 'queued' });
  const definition = createRemoteRelayToolDefinition({ api: stub.api, getConversationId: () => 'conv-1' });
  await definition.handler({
    action: 'create_session',
    relay: 'this',
    text: 'Fix the sample banner on feature/banner and push it.',
    provider: 'claude-cloud',
    repo: 'example-org/sample-repo',
    branch: 'feature/banner',
    wait_seconds: 3000,
  }, {});
  assert.deepEqual(stub.calls[0].body.args, {
    relay: 'this',
    text: 'Fix the sample banner on feature/banner and push it.',
    wait_seconds: 3000,
    provider: 'claude-cloud',
    repo: 'https://github.com/example-org/sample-repo',
    branch: 'feature/banner',
  });

  const refused = JSON.parse((await definition.handler(
    { action: 'create_session', relay: 'this', text: 'x', provider: 'claude', repo: 'example-org/sample-repo' },
    {},
  )).content[0].text);
  assert.equal(refused.code, 'REMOTE_RELAY_INVALID_INPUT');
  assert.equal(stub.calls.length, 1, 'repo with another provider never reaches the relay');
});

test('the handler forwards the call with the live conversation id and returns pretty JSON text', async () => {
  const reply = { ok: true, relays: [{ name: 'linux-test', unlocked: false }], summary: 'list_relays' };
  const stub = recordingApi(reply);
  let conversationId = 'conv-1';
  const definition = createRemoteRelayToolDefinition({ api: stub.api, getConversationId: () => conversationId });

  const first = await definition.handler({ action: 'list_relays' }, {});
  conversationId = 'conv-2';
  await definition.handler({ action: 'relay_info', relay: 'linux-test' }, {});

  assert.deepEqual(stub.calls[0], {
    method: 'POST',
    routePath: REMOTE_RELAY_TOOL_ENDPOINT,
    body: { conversationId: 'conv-1', action: 'list_relays', args: {} },
  });
  assert.equal(stub.calls[1].body.conversationId, 'conv-2', 'the id is read per call, not captured');
  assert.equal(first.content.length, 1);
  assert.equal(first.content[0].type, 'text');
  assert.deepEqual(JSON.parse(first.content[0].text), reply);
  assert.match(first.content[0].text, /\n {2}"ok": true/, 'pretty-printed');
  assert.equal(first.isError, undefined, 'a result is never flagged as a failed tool call');
});

test('a refusal and a throwing resolver both come back as quotable JSON, never a throw', async () => {
  const refused = createRemoteRelayToolDefinition({
    api: async () => {
      const error = new Error('HTTP 403 /api/remote-relays/tool: locked');
      error.status = 403;
      error.detail = 'locked';
      error.body = { ok: false, code: 'REMOTE_RELAY_LOCKED', error: 'locked' };
      throw error;
    },
    getConversationId: () => 'conv-1',
  });
  const payload = JSON.parse((await refused.handler({ action: 'list_sessions', relay: 'linux-test' }, {})).content[0].text);
  assert.deepEqual(payload, { ok: false, code: 'REMOTE_RELAY_LOCKED', error: 'locked' });

  const broken = createRemoteRelayToolDefinition({
    api: recordingApi().api,
    getConversationId: () => { throw new Error('no active turn'); },
  });
  const failure = JSON.parse((await broken.handler({ action: 'list_relays' }, {})).content[0].text);
  assert.deepEqual(failure, { ok: false, code: 'REMOTE_RELAY_CALL_FAILED', error: 'no active turn' });
});

test('the MCP request\'s signal reaches the relay call, and a cancel answers REMOTE_RELAY_CANCELLED', async () => {
  const seen = [];
  const definition = createRemoteRelayToolDefinition({
    api: (method, routePath, body, options = {}) => new Promise((resolve, reject) => {
      seen.push(options);
      options.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    }),
    getConversationId: () => 'conv-1',
  });
  const controller = new AbortController();
  const pending = definition.handler(
    { action: 'wait', relay: 'linux-test', session: 's-1', message_id: 'm-1', wait_seconds: 600 },
    { signal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen[0].signal, controller.signal, 'extra.signal is forwarded');
  assert.equal(seen[0].longCall, true);
  // The CLI cancels the MCP request (a Stop, a transport close).
  controller.abort();
  const payload = JSON.parse((await pending).content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'REMOTE_RELAY_CANCELLED');
});

// ─── the runner's registration decision ──────────────────────────────────────

function spawnRecordingRunner(stub, overrides = {}) {
  const spawns = [];
  const runner = makeRunner({
    stub,
    startImpl: (params) => {
      spawns.push(params);
      return fakeTurn([initMessage('native-1'), resultMessage('done', 'native-1')]);
    },
    // The harness pins a settled "no remotes" gate; these suites exercise the
    // runner's own gate, which asks the relay.
    remoteRelayToolGate: null,
    ...overrides,
  });
  return { runner, spawns };
}

test('a first delivery that beats the startup answer waits for it and spawns with the tool', async () => {
  let answer = null;
  const stub = makeApiStub({
    routeResponses: {
      '/api/remote-relays/summary': () => new Promise((resolve) => { answer = () => resolve({ count: 1 }); }),
    },
  });
  const { runner, spawns } = spawnRecordingRunner(stub);
  await waitFor(() => typeof answer === 'function', { label: 'summary asked' });
  const delivered = runner.handlePendingPayload({ message: { ...baseMessage } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawns.length, 0, 'the cold spawn waits for the pending decision');
  answer();
  await delivered;
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].remoteRelayTool, true);
  await settled(runner);
});

async function summaryAnswered(stub) {
  await waitFor(() => stub.calls.some((call) => call.routePath === '/api/remote-relays/summary'), { label: 'summary asked' });
  // Let the gate record the answer.
  await new Promise((resolve) => setImmediate(resolve));
}

test('the worker asks the relay once at start and registers the tool when a remote is paired', async () => {
  const stub = makeApiStub({ routeResponses: { '/api/remote-relays/summary': { count: 1 } } });
  const { runner, spawns } = spawnRecordingRunner(stub);
  await summaryAnswered(stub);
  assert.equal(
    stub.calls.filter((call) => call.routePath === '/api/remote-relays/summary').length,
    1,
    'asked at worker start, before any delivery',
  );
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].remoteRelayTool, true);
  await settled(runner);
});

test('no paired remote, or a summary that fails, spawns without the tool', async () => {
  for (const summary of [{ count: 0 }, () => { throw new Error('HTTP 404 /api/remote-relays/summary'); }]) {
    const stub = makeApiStub({ routeResponses: { '/api/remote-relays/summary': summary } });
    const { runner, spawns } = spawnRecordingRunner(stub);
    await summaryAnswered(stub);
    await runner.handlePendingPayload({ message: { ...baseMessage } });
    assert.equal(spawns[0].remoteRelayTool, false);
    await settled(runner);
  }
});

test('a CLI process that wound down refreshes the decision for the next spawn', async () => {
  let remotes = 0;
  const stub = makeApiStub({ routeResponses: { '/api/remote-relays/summary': () => ({ count: remotes }) } });
  const { runner, spawns } = spawnRecordingRunner(stub);
  await summaryAnswered(stub);
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(spawns[0].remoteRelayTool, false);
  // A remote is paired while the first process is still up.
  remotes = 1;
  await settled(runner);
  await waitFor(
    () => stub.calls.filter((call) => call.routePath === '/api/remote-relays/summary').length === 2,
    { label: 'refresh on teardown' },
  );
  await new Promise((resolve) => setImmediate(resolve));
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  assert.equal(spawns[1].remoteRelayTool, true);
  await settled(runner);
});

test('a delivery that joined another spawn re-checks the process after its adapt recycled it', async () => {
  // Two cold deliveries overlap only against an older relay, which cannot
  // take a held delivery back. Each gets its own decision wait, released by
  // the test, so the second resumes only after the first delivery's turn is
  // over. It then joins an idle process whose mode append differs, and
  // adaptProcess recycles that process under it: the push must go to a
  // fresh one.
  const releases = [];
  const gate = {
    isEnabled: () => false,
    isSettled: () => false,
    refresh: () => Promise.resolve(false),
    ready: () => new Promise((resolve) => { releases.push(() => resolve(false)); }),
  };
  const stub = makeApiStub();
  const spawns = [];
  const turns = [];
  const runner = makeRunner({
    stub,
    remoteRelayToolGate: gate,
    canHandBackHeldDelivery: () => false,
    startImpl: (params) => {
      spawns.push(params);
      const turn = scriptedTurn({ echoPushes: true });
      turns.push(turn);
      return turn;
    },
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  const second = runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-2', text: 'carry on in autopilot', relayMode: 'autopilot' },
  });
  await waitFor(() => releases.length === 2, { label: 'both cold deliveries wait for the decision' });

  releases[0]();
  await waitFor(() => turns[0]?.pushed.length === 1, { label: 'first spawn and push' });
  turns[0].emit(initMessage('native-1'));
  turns[0].emit(resultMessage('one', 'native-1'));
  assert.equal(await first, true);

  releases[1]();
  await waitFor(() => turns.length === 2, { label: 'a fresh process after the recycle' });
  assert.ok(turns[0].endInputCalls >= 1, 'the joined idle process was released for the mode change');
  assert.equal(spawns[1].relayMode, 'autopilot');
  await waitFor(() => turns[1].pushed.length === 1, { label: 'pushed into the fresh process' });
  turns[1].emit(initMessage('native-1'));
  turns[1].emit(resultMessage('two', 'native-1'));
  assert.equal(await second, true);

  const responses = stub.calls.filter((call) => call.routePath === '/api/response').map((call) => call.body);
  assert.deepEqual(responses.filter((body) => body.terminalError), [], 'no delivery failed');
  assert.deepEqual(responses.map((body) => body.messageId), ['q-1', 'q-2']);
  turns[1].endInput();
  await settled(runner);
});

test('an injected gate decides without asking the relay', async () => {
  const stub = makeApiStub();
  const { runner, spawns } = spawnRecordingRunner(stub, {
    remoteRelayToolGate: createRemoteRelayToolGate({ fixed: true }),
  });
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(spawns[0].remoteRelayTool, true);
  assert.equal(stub.calls.some((call) => call.routePath === '/api/remote-relays/summary'), false);
  await settled(runner);
});
