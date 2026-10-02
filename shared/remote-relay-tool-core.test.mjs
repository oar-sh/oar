import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApiClient } from './worker-runtime/api-client.mjs';
import {
  REMOTE_RELAY_CALL_FAILED,
  REMOTE_RELAY_CANCELLED,
  REMOTE_RELAY_INFLIGHT_PATH,
  REMOTE_RELAY_SUMMARY_PATH,
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_ENDPOINT,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
  REMOTE_RELAY_TOOL_NAME,
  cloneRemoteRelayToolInputSchema,
  createRemoteRelayToolGate,
  executeRemoteRelayTool,
  fetchRemoteRelayInflight,
  formatRemoteRelayToolResult,
  isRemoteRelayToolName,
  remoteRelayActivitySummary,
  remoteRelayCancelledResult,
  remoteRelayErrorResult,
  shouldRegisterRemoteRelayTool,
  validateRemoteRelayTool,
} from './remote-relay-tool-core.mjs';
import * as contract from './remote-relay-contract.mjs';

function recordingApi(reply = { ok: true }) {
  const calls = [];
  return {
    calls,
    api: async (method, path, body, options) => {
      calls.push({ method, path, body, options });
      return typeof reply === 'function' ? reply({ method, path, body, options }) : reply;
    },
  };
}

// An api that holds the call until its signal aborts, like the real client.
function hangingApi() {
  const calls = [];
  return {
    calls,
    api: (method, path, body, options = {}) => new Promise((_, reject) => {
      calls.push({ method, path, body, options });
      options.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    }),
  };
}

// The shape shared/worker-runtime/api-client.mjs throws for a non-2xx answer,
// plus the parsed body when the client keeps it.
function httpError(status, payload, { keepBody = true } = {}) {
  const detail = String(payload?.error || payload?.message || '').trim();
  const error = new Error(`HTTP ${status} ${REMOTE_RELAY_TOOL_ENDPOINT}${detail ? `: ${detail}` : ''}`);
  error.status = status;
  error.detail = detail;
  if (keepBody) error.body = payload;
  return error;
}

test('the name, description and schema are the contract\'s, not copies', () => {
  assert.equal(REMOTE_RELAY_TOOL_NAME, contract.REMOTE_RELAY_TOOL_NAME);
  assert.equal(REMOTE_RELAY_TOOL_DESCRIPTION, contract.REMOTE_RELAY_TOOL_DESCRIPTION);
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA, contract.REMOTE_RELAY_TOOL_INPUT_SCHEMA);
  assert.equal(REMOTE_RELAY_TOOL_ENDPOINT, '/api/remote-relays/tool');
  assert.equal(validateRemoteRelayTool, contract.validateRemoteRelayToolInput);
});

test('SDKs get a private, mutable deep copy of the frozen contract schema', () => {
  const copy = cloneRemoteRelayToolInputSchema();
  assert.deepEqual(copy, REMOTE_RELAY_TOOL_INPUT_SCHEMA);
  assert.notEqual(copy, REMOTE_RELAY_TOOL_INPUT_SCHEMA);
  assert.notEqual(copy.properties, REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties);
  copy.additionalProperties = false;
  copy.properties.action.enum.push('x');
  assert.equal('additionalProperties' in REMOTE_RELAY_TOOL_INPUT_SCHEMA, false);
  assert.equal(REMOTE_RELAY_TOOL_INPUT_SCHEMA.properties.action.enum.includes('x'), false);
});

test('execute posts { conversationId, action, args } to the tool endpoint and returns the JSON body', async () => {
  const reply = { ok: true, status: 'done', relay: 'linux-test', summary: 'send → linux-test' };
  const stub = recordingApi(reply);
  const result = await executeRemoteRelayTool(
    { action: 'send', relay: 'linux-test', session: 'sess-1', text: 'run the report builder tests' },
    { api: stub.api, conversationId: 'conv-1' },
  );
  assert.deepEqual(result, reply);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].method, 'POST');
  assert.equal(stub.calls[0].path, REMOTE_RELAY_TOOL_ENDPOINT);
  assert.deepEqual(stub.calls[0].body, {
    conversationId: 'conv-1',
    action: 'send',
    // The validator's normalised args: defaults filled, unknown keys dropped.
    args: { relay: 'linux-test', session: 'sess-1', text: 'run the report builder tests', wait_seconds: 120, if_busy: 'queue' },
  });
});

test('the tool call goes out as a long call and carries the caller\'s signal', async () => {
  const stub = recordingApi({ ok: true });
  await executeRemoteRelayTool({ action: 'list_relays' }, { api: stub.api, conversationId: 'c' });
  assert.deepEqual(stub.calls[0].options, { longCall: true }, 'no clock on it: the relay bounds the wait');

  const controller = new AbortController();
  await executeRemoteRelayTool({ action: 'list_relays' }, { api: stub.api, conversationId: 'c', signal: controller.signal });
  assert.equal(stub.calls[1].options.longCall, true);
  assert.equal(stub.calls[1].options.signal, controller.signal);
});

test('a cancelled call answers REMOTE_RELAY_CANCELLED instead of a failure', async () => {
  const stub = hangingApi();
  const controller = new AbortController();
  const pending = executeRemoteRelayTool(
    { action: 'wait', relay: 'linux-test', session: 's-1', message_id: 'm-1', wait_seconds: 600 },
    { api: stub.api, conversationId: 'conv-1', signal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stub.calls.length, 1);
  controller.abort();
  const result = await pending;
  assert.deepEqual(result, remoteRelayCancelledResult());
  assert.equal(result.ok, false);
  assert.equal(result.code, REMOTE_RELAY_CANCELLED);
  assert.equal(REMOTE_RELAY_CANCELLED, 'REMOTE_RELAY_CANCELLED');
  assert.match(result.error, /cancelled/);

  // Aborted before it started: the relay is never asked.
  const early = await executeRemoteRelayTool({ action: 'list_relays' }, { api: stub.api, conversationId: 'c', signal: controller.signal });
  assert.equal(early.code, REMOTE_RELAY_CANCELLED);
  assert.equal(stub.calls.length, 1);

  // An abort the api reports without the caller's signal reads the same.
  const foreign = await executeRemoteRelayTool({ action: 'list_relays' }, {
    api: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
    conversationId: 'c',
  });
  assert.equal(foreign.code, REMOTE_RELAY_CANCELLED);
});

test('end to end: Stop drops the request the relay is holding open', async (t) => {
  let dropped = false;
  let received = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      received = JSON.parse(raw);
      // Holds the answer like a remote turn in progress, and notices the close.
      res.on('close', () => { if (!res.writableEnded) dropped = true; });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const api = createApiClient({ serverUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-token' });
  const controller = new AbortController();

  const pending = executeRemoteRelayTool(
    { action: 'send', relay: 'linux-test', session: 's-1', text: 'run the report builder tests' },
    { api, conversationId: 'conv-1', signal: controller.signal },
  );
  const deadline = Date.now() + 5_000;
  while (!received) {
    assert.ok(Date.now() < deadline, 'the call reached the relay');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(received.action, 'send');
  controller.abort();
  assert.equal((await pending).code, REMOTE_RELAY_CANCELLED);
  while (!dropped) {
    assert.ok(Date.now() < deadline, 'the relay saw the request close');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
});

test('execute sends list_relays with empty args', async () => {
  const stub = recordingApi({ ok: true, relays: [] });
  await executeRemoteRelayTool({ action: 'list_relays' }, { api: stub.api, conversationId: 'conv-2' });
  assert.deepEqual(stub.calls[0].body, { conversationId: 'conv-2', action: 'list_relays', args: {} });
});

test('invalid input never reaches the relay', async () => {
  const stub = recordingApi();
  const result = await executeRemoteRelayTool({ action: 'send', relay: 'linux-test' }, { api: stub.api, conversationId: 'c' });
  assert.equal(stub.calls.length, 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, contract.REMOTE_RELAY_ERROR_CODES.invalidInput);
  assert.match(result.error, /needs session/);
});

test('a missing api or conversation is an answer, not a throw', async () => {
  const noApi = await executeRemoteRelayTool({ action: 'list_relays' }, { conversationId: 'c' });
  assert.equal(noApi.ok, false);
  assert.equal(noApi.code, REMOTE_RELAY_CALL_FAILED);
  const stub = recordingApi();
  const noConversation = await executeRemoteRelayTool({ action: 'list_relays' }, { api: stub.api });
  assert.equal(noConversation.ok, false);
  assert.equal(stub.calls.length, 0);
});

test('a refusal body from the relay is passed through to the model unchanged', async () => {
  const refusal = {
    ok: false,
    code: contract.REMOTE_RELAY_ERROR_CODES.locked,
    error: 'Ask the user to mention @linux-test to allow work on that relay.',
    relay: 'linux-test',
  };
  const result = await executeRemoteRelayTool(
    { action: 'list_sessions', relay: 'linux-test' },
    { api: async () => { throw httpError(403, refusal); }, conversationId: 'conv-1' },
  );
  assert.deepEqual(result, refusal);
});

test('without a kept body the relay\'s error text still reaches the model', async () => {
  const result = await executeRemoteRelayTool(
    { action: 'list_relays' },
    {
      api: async () => { throw httpError(502, { ok: false, code: 'REMOTE_RELAY_OFFLINE', error: 'linux-test is offline' }, { keepBody: false }); },
      conversationId: 'conv-1',
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, REMOTE_RELAY_CALL_FAILED);
  assert.equal(result.status, 502);
  assert.equal(result.error, 'linux-test is offline');
});

test('error mapping: parsed detail objects, 404 and transport failures', () => {
  const parsedDetail = Object.assign(new Error('HTTP 429'), {
    status: 429,
    detail: { ok: false, code: 'REMOTE_RELAY_RATE_LIMITED', error: 'Slow down' },
  });
  assert.deepEqual(remoteRelayErrorResult(parsedDetail), { ok: false, code: 'REMOTE_RELAY_RATE_LIMITED', error: 'Slow down' });

  const missingRoute = remoteRelayErrorResult(Object.assign(new Error('HTTP 404 /api/remote-relays/tool'), { status: 404, detail: 'Not Found' }));
  assert.equal(missingRoute.code, contract.REMOTE_RELAY_ERROR_CODES.unsupported);

  const transport = remoteRelayErrorResult(new TypeError('fetch failed'));
  assert.deepEqual(transport, { ok: false, code: REMOTE_RELAY_CALL_FAILED, error: 'fetch failed' });
});

test('registration: a paired relay or the local target registers the tool, nothing else does', async () => {
  const seen = [];
  const decide = (reply) => shouldRegisterRemoteRelayTool({
    api: async (method, path) => {
      seen.push(`${method} ${path}`);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  assert.equal(await decide({ count: 2 }), true);
  assert.equal(await decide({ count: 0 }), false);
  assert.equal(await decide({}), false);
  assert.equal(await decide(null), false);
  assert.equal(await decide({ count: 'many' }), false);
  // No relay is paired, but this relay's own sessions are open to its agents.
  assert.equal(await decide({ count: 0, online: 0, localEnabled: true }), true);
  assert.equal(await decide({ count: 0, online: 0, localEnabled: false }), false);
  assert.equal(await decide({ count: 0, localEnabled: 'true' }), false, 'only the boolean counts');
  assert.equal(await decide(new Error('HTTP 404')), false, 'an older relay without the route fails closed');
  assert.deepEqual([...new Set(seen)], [`GET ${REMOTE_RELAY_SUMMARY_PATH}`]);
  assert.equal(await shouldRegisterRemoteRelayTool({}), false, 'no api, no tool');
});

test('registration fails closed when the relay does not answer in time', async () => {
  const started = Date.now();
  const result = await shouldRegisterRemoteRelayTool({
    api: () => new Promise(() => {}),
    timeoutMs: 30,
  });
  assert.equal(result, false);
  assert.ok(Date.now() - started < 2_000);
});

test('the gate asks once, is readable synchronously, and can be pinned', async () => {
  let asked = 0;
  const gate = createRemoteRelayToolGate({
    api: async () => { asked += 1; return { count: 1 }; },
  });
  assert.equal(gate.isEnabled(), false, 'closed until the relay answered');
  const first = gate.refresh();
  const again = gate.ready();
  assert.equal(await first, true);
  assert.equal(await again, true);
  assert.equal(asked, 1, 'a ready() while the probe runs joins it');
  assert.equal(gate.isEnabled(), true);
  assert.equal(await gate.ready(), true);
  assert.equal(asked, 1, 'a settled gate answers without asking again');

  const failing = createRemoteRelayToolGate({ decide: async () => { throw new Error('boom'); } });
  assert.equal(await failing.ready(), false);

  const pinned = createRemoteRelayToolGate({ fixed: true, api: async () => { throw new Error('never asked'); } });
  assert.equal(pinned.isEnabled(), true);
  assert.equal(await pinned.ready(), true);
});

test('inflight: the count of running calls, 0 on any failure', async () => {
  const stub = recordingApi({ inflight: 2 });
  assert.equal(await fetchRemoteRelayInflight({ api: stub.api, conversationId: 'conv 1' }), 2);
  assert.equal(stub.calls[0].method, 'GET');
  assert.equal(stub.calls[0].path, `${REMOTE_RELAY_INFLIGHT_PATH}?conversationId=conv%201`);
  assert.equal(await fetchRemoteRelayInflight({ api: async () => ({ inflight: 0 }), conversationId: 'c' }), 0);
  assert.equal(await fetchRemoteRelayInflight({ api: async () => { throw new Error('down'); }, conversationId: 'c' }), 0);
  assert.equal(await fetchRemoteRelayInflight({ api: () => new Promise(() => {}), conversationId: 'c', timeoutMs: 20 }), 0);
  assert.equal(await fetchRemoteRelayInflight({ api: stub.api }), 0, 'no conversation, no question');
});

test('results are pretty JSON for every adapter', () => {
  assert.equal(formatRemoteRelayToolResult({ ok: true, a: 1 }), '{\n  "ok": true,\n  "a": 1\n}');
  assert.equal(formatRemoteRelayToolResult(undefined), 'null');
  const circular = {};
  circular.self = circular;
  assert.equal(typeof formatRemoteRelayToolResult(circular), 'string');
});

test('tool names: bare and namespaced spellings, nothing else', () => {
  for (const name of ['remote_relay', 'mcp__relay__remote_relay', 'oar__remote_relay', 'oar/remote_relay', 'oar-remote_relay', 'OAR: remote_relay']) {
    assert.equal(isRemoteRelayToolName(name), true, name);
  }
  for (const name of ['', 'preview', 'not_remote_relay', 'remote_relay_x', 'myremote_relay']) {
    assert.equal(isRemoteRelayToolName(name), false, name);
  }
});

test('activity summaries come from the contract and tolerate string arguments', () => {
  const input = { action: 'send', relay: 'linux-test', session: '0123456789abcdef', text: 'run the tests' };
  assert.equal(remoteRelayActivitySummary(input), contract.summarizeRemoteRelayCall(input));
  assert.equal(remoteRelayActivitySummary(input), 'send → linux-test session 01234567: “run the tests”');
  assert.equal(remoteRelayActivitySummary(JSON.stringify(input)), 'send → linux-test session 01234567: “run the tests”');
  assert.equal(remoteRelayActivitySummary({}), '');
  assert.equal(remoteRelayActivitySummary('not json'), '');
});
