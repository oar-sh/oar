import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  OAR_MCP_DEFAULT_PROTOCOL_VERSION,
  OAR_MCP_RELAY_ENV_KEYS,
  OAR_MCP_SERVER_SCRIPT_PATH,
  buildOarMcpServerLaunch,
  createOarMcpServer,
  parseConversationIdArg,
} from './oar-mcp-server.mjs';
import {
  REMOTE_RELAY_TOOL_DESCRIPTION,
  REMOTE_RELAY_TOOL_INPUT_SCHEMA,
} from '../../shared/remote-relay-contract.mjs';
import { PREVIEW_TOOL_DESCRIPTION, PREVIEW_TOOL_INPUT_SCHEMA } from '../../shared/preview-tool-core.mjs';

const TOKEN = 'test-token-oar-mcp';
const LOCKED = {
  ok: false,
  code: 'REMOTE_RELAY_LOCKED',
  error: 'Ask the user to mention @linux-test to allow work on that relay.',
};

// ─── a fake relay ────────────────────────────────────────────────────────────

async function startFakeRelay({ remoteCount = 1, hangTool = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const entry = { method: req.method, url: req.url, headers: req.headers, body, dropped: false };
      requests.push(entry);
      // The caller hung up before the answer: what the real route reads as
      // "stop waiting, withdraw the card".
      res.on('close', () => { if (!res.writableEnded) entry.dropped = true; });
      const answer = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return answer(401, { error: 'unauthorized' });
      if (req.method === 'GET' && req.url === '/api/remote-relays/summary') return answer(200, { count: remoteCount });
      if (req.method === 'POST' && req.url === '/api/remote-relays/tool') {
        if (hangTool) return undefined; // a remote turn that never ends
        if (body?.action === 'list_sessions') return answer(403, LOCKED);
        return answer(200, { ok: true, summary: `${body.action} ok`, received: body });
      }
      if (req.method === 'GET' && req.url === '/api/previews') return answer(200, { enabled: true, previews: [] });
      return answer(404, { error: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
  };
}

function writeRelayConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-mcp-test-'));
  const configPath = path.join(dir, 'config.json');
  // The port is deliberately wrong: COPILOT_WEB_RELAY_SERVER_URL must win.
  fs.writeFileSync(configPath, JSON.stringify({ authToken: TOKEN, port: 9 }));
  return { configPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ─── a JSON-RPC client over the child's stdio ────────────────────────────────

function startMcp({ args, env }) {
  const child = spawn(process.execPath, [OAR_MCP_SERVER_SCRIPT_PATH, ...args], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const nonProtocolLines = [];
  let stderr = '';
  let waiters = [];
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {
      nonProtocolLines.push(line);
    }
    waiters = waiters.filter((waiter) => !waiter());
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  let nextId = 1;

  function waitForMessage(predicate, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}; stderr: ${stderr}`)), 10_000);
      const check = () => {
        const found = messages.find(predicate);
        if (!found) return false;
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      if (!check()) waiters.push(check);
    });
  }

  return {
    child,
    messages,
    nonProtocolLines,
    exited,
    stderr: () => stderr,
    send(message) {
      child.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
    },
    request(method, params) {
      const id = nextId++;
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      return waitForMessage((message) => message.id === id, `${method} #${id}`);
    },
    notify(method, params) {
      this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    waitForMessage,
    async close() {
      child.stdin.end();
      return exited;
    },
  };
}

async function withMcp({ remoteCount = 1, hangTool = false } = {}, run) {
  const relay = await startFakeRelay({ remoteCount, hangTool });
  const config = writeRelayConfig();
  const mcp = startMcp({
    args: ['--conversation-id', 'conv-mcp-1'],
    env: { COPILOT_WEB_RELAY_CONFIG: config.configPath, COPILOT_WEB_RELAY_SERVER_URL: relay.url },
  });
  try {
    await run({ mcp, relay });
  } finally {
    const code = await mcp.close();
    await relay.close();
    config.cleanup();
    assert.equal(code, 0, 'closing stdin ends the server cleanly');
    assert.deepEqual(mcp.nonProtocolLines, [], 'stdout carries protocol frames only');
  }
}

// ─── end to end over stdio ───────────────────────────────────────────────────

test('initialize echoes a supported protocol version and announces the tools capability', async () => {
  await withMcp({}, async ({ mcp }) => {
    const init = await mcp.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, 'oar');
    assert.equal(typeof init.result.serverInfo.version, 'string');

    const unknown = await mcp.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    assert.equal(unknown.result.protocolVersion, OAR_MCP_DEFAULT_PROTOCOL_VERSION);
    assert.equal(OAR_MCP_DEFAULT_PROTOCOL_VERSION, '2025-06-18');

    const countBefore = mcp.messages.length;
    mcp.notify('notifications/initialized');
    const ping = await mcp.request('ping');
    assert.deepEqual(ping.result, {});
    assert.equal(mcp.messages.length, countBefore + 1, 'a notification gets no answer');
  });
});

test('tools/list offers remote_relay and preview with the shared schemas', async () => {
  await withMcp({ remoteCount: 2 }, async ({ mcp, relay }) => {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const listed = await mcp.request('tools/list', {});
    const byName = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(Object.keys(byName).sort(), ['preview', 'remote_relay']);
    assert.equal(byName.remote_relay.description, REMOTE_RELAY_TOOL_DESCRIPTION);
    assert.deepEqual(byName.remote_relay.inputSchema, REMOTE_RELAY_TOOL_INPUT_SCHEMA);
    assert.equal(byName.preview.description, PREVIEW_TOOL_DESCRIPTION);
    assert.deepEqual(byName.preview.inputSchema, PREVIEW_TOOL_INPUT_SCHEMA);

    // Decided once, at startup.
    await mcp.request('tools/list', {});
    assert.equal(relay.requests.filter((request) => request.url === '/api/remote-relays/summary').length, 1);
  });
});

test('tools/call remote_relay forwards { conversationId, action, args } with the relay token', async () => {
  await withMcp({}, async ({ mcp, relay }) => {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const called = await mcp.request('tools/call', {
      name: 'remote_relay',
      arguments: { action: 'send', relay: 'linux-test', session: 'sess-7', text: 'run the report builder tests' },
    });
    assert.equal(called.result.isError, undefined);
    assert.equal(called.result.content.length, 1);
    assert.equal(called.result.content[0].type, 'text');
    const payload = JSON.parse(called.result.content[0].text);
    assert.equal(payload.ok, true);

    const forwarded = relay.requests.find((request) => request.url === '/api/remote-relays/tool');
    assert.equal(forwarded.method, 'POST');
    assert.equal(forwarded.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(forwarded.headers['x-relay-conversation-id'], 'conv-mcp-1');
    assert.equal(forwarded.headers['x-relay-process-pid'], undefined, 'never posing as a session worker');
    assert.deepEqual(forwarded.body, {
      conversationId: 'conv-mcp-1',
      action: 'send',
      args: {
        relay: 'linux-test',
        session: 'sess-7',
        text: 'run the report builder tests',
        wait_seconds: 120,
        if_busy: 'queue',
      },
    });
  });
});

test('a refusal from the relay reaches the model as a readable result', async () => {
  await withMcp({}, async ({ mcp }) => {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const refused = await mcp.request('tools/call', {
      name: 'remote_relay',
      arguments: { action: 'list_sessions', relay: 'linux-test' },
    });
    assert.equal(refused.error, undefined, 'a refusal is a result, not a protocol error');
    const payload = JSON.parse(refused.result.content[0].text);
    assert.equal(payload.ok, false);
    assert.equal(payload.error, LOCKED.error);
    // LOCKED once the api client keeps the error body; the generic code until then.
    assert.ok(['REMOTE_RELAY_LOCKED', 'REMOTE_RELAY_CALL_FAILED'].includes(payload.code), payload.code);

    const invalid = await mcp.request('tools/call', { name: 'remote_relay', arguments: { action: 'destroy' } });
    assert.equal(JSON.parse(invalid.result.content[0].text).code, 'REMOTE_RELAY_INVALID_INPUT');
  });
});

test('tools/call preview runs through the preview core for the bound conversation', async () => {
  await withMcp({}, async ({ mcp, relay }) => {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const listed = await mcp.request('tools/call', { name: 'preview', arguments: { action: 'list' } });
    assert.deepEqual(JSON.parse(listed.result.content[0].text), { ok: true, enabled: true, previews: [] });
    assert.ok(relay.requests.some((request) => request.method === 'GET' && request.url === '/api/previews'));
  });
});

test('protocol errors: unknown method, unknown tool, bad JSON, invalid request', async () => {
  await withMcp({}, async ({ mcp }) => {
    const unknownMethod = await mcp.request('resources/list', {});
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = await mcp.request('tools/call', { name: 'shell', arguments: {} });
    assert.equal(unknownTool.error.code, -32602);

    mcp.send('{not json');
    const parseError = await mcp.waitForMessage((message) => message.error?.code === -32700, 'parse error');
    assert.equal(parseError.id, null);

    mcp.send({ jsonrpc: '1.0', id: 99, method: 'ping' });
    const invalid = await mcp.waitForMessage((message) => message.id === 99, 'invalid request');
    assert.equal(invalid.error.code, -32600);
  });
});

test('without a paired remote only preview is offered and remote_relay is unknown', async () => {
  await withMcp({ remoteCount: 0 }, async ({ mcp }) => {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const listed = await mcp.request('tools/list', {});
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['preview']);
    const refused = await mcp.request('tools/call', { name: 'remote_relay', arguments: { action: 'list_relays' } });
    assert.equal(refused.error.code, -32602);
  });
});

test('a host that hangs up mid-call does not keep the server alive', async () => {
  await withMcp({ hangTool: true }, async ({ mcp, relay }) => {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    mcp.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'remote_relay', arguments: { action: 'wait', relay: 'linux-test', session: 's', message_id: 'm' } },
    });
    const deadline = Date.now() + 5_000;
    while (!relay.requests.some((request) => request.url === '/api/remote-relays/tool')) {
      assert.ok(Date.now() < deadline, 'the call reached the relay');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const started = Date.now();
    const code = await mcp.close();
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 8_000, 'cut off after the shutdown grace');
    // The call was cancelled, not merely outlived: the relay stops waiting.
    await waitUntil(
      () => /host hung up: cancelled 1 call\(s\) still waiting on the relay/.test(mcp.stderr()),
      `the call was cancelled on shutdown; stderr: ${mcp.stderr()}`,
    );
    const toolRequest = relay.requests.find((request) => request.url === '/api/remote-relays/tool');
    await waitUntil(() => toolRequest.dropped, 'the relay saw the call dropped');
  });
});

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('notifications/cancelled drops the call at the relay and leaves it unanswered', async () => {
  await withMcp({ hangTool: true }, async ({ mcp, relay }) => {
    await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    mcp.send({
      jsonrpc: '2.0',
      id: 'call-9',
      method: 'tools/call',
      params: { name: 'remote_relay', arguments: { action: 'wait', relay: 'linux-test', session: 's', message_id: 'm' } },
    });
    await waitUntil(() => relay.requests.some((request) => request.url === '/api/remote-relays/tool'), 'the call reached the relay');
    mcp.notify('notifications/cancelled', { requestId: 'call-9', reason: 'user stopped the turn' });
    const toolRequest = relay.requests.find((request) => request.url === '/api/remote-relays/tool');
    await waitUntil(() => toolRequest.dropped, 'the relay saw the call dropped');
    // Still serving, and the cancelled request never gets an answer.
    assert.deepEqual((await mcp.request('ping')).result, {});
    assert.equal(mcp.messages.some((message) => message.id === 'call-9'), false);
  });
});

test('the server refuses to start without a conversation id', async () => {
  const mcp = startMcp({ args: [], env: {} });
  const code = await mcp.exited;
  assert.equal(code, 2);
  assert.match(mcp.stderr(), /--conversation-id/);
  assert.deepEqual(mcp.messages, [], 'nothing on stdout');
});

// ─── pure helpers and the transport-free core ────────────────────────────────

test('conversation id argument, both spellings', () => {
  assert.equal(parseConversationIdArg(['--conversation-id', 'conv-1']), 'conv-1');
  assert.equal(parseConversationIdArg(['--conversation-id=conv-2']), 'conv-2');
  assert.equal(parseConversationIdArg(['--other', 'x']), '');
  assert.equal(parseConversationIdArg(['--conversation-id']), '');
});

test('buildOarMcpServerLaunch names node, this script, the conversation and only the relay env', () => {
  const launch = buildOarMcpServerLaunch({
    nodePath: '/usr/local/bin/node',
    conversationId: 'conv-9',
    scriptPath: '/srv/oar/server/mcp/oar-mcp-server.mjs',
    env: {
      COPILOT_WEB_RELAY_CONFIG: '/srv/oar/server/config.json',
      COPILOT_WEB_RELAY_SERVER_URL: 'http://127.0.0.1:3333',
      COPILOT_PROVIDER_API_KEY: 'sk-never-forwarded',
      PATH: '/usr/bin',
    },
  });
  assert.deepEqual(launch, {
    command: '/usr/local/bin/node',
    args: ['/srv/oar/server/mcp/oar-mcp-server.mjs', '--conversation-id', 'conv-9'],
    env: {
      COPILOT_WEB_RELAY_CONFIG: '/srv/oar/server/config.json',
      COPILOT_WEB_RELAY_SERVER_URL: 'http://127.0.0.1:3333',
    },
  });
  assert.deepEqual([...OAR_MCP_RELAY_ENV_KEYS].sort(), [
    'COPILOT_WEB_RELAY_CONFIG',
    'COPILOT_WEB_RELAY_ROOT',
    'COPILOT_WEB_RELAY_SERVER_DIR',
    'COPILOT_WEB_RELAY_SERVER_URL',
  ]);
  const defaults = buildOarMcpServerLaunch({ nodePath: '/usr/local/bin/node', conversationId: 'conv-9', env: {} });
  assert.equal(defaults.args[0], OAR_MCP_SERVER_SCRIPT_PATH);
  assert.deepEqual(defaults.env, {});
  assert.throws(() => buildOarMcpServerLaunch({ nodePath: '/usr/local/bin/node', env: {} }), /conversation id/);
});

test('a long call sends progress when asked for it, and stops when it settles', async () => {
  const sent = [];
  let release = () => {};
  const server = createOarMcpServer({
    api: async () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 'done' }); }),
    conversationId: 'conv-1',
    remoteRelay: true,
    send: (message) => sent.push(message),
    progressIntervalMs: 10,
  });
  const response = server.handleMessage({
    jsonrpc: '2.0',
    id: 'call-1',
    method: 'tools/call',
    params: { name: 'remote_relay', arguments: { action: 'list_relays' }, _meta: { progressToken: 'tok-1' } },
  });
  await new Promise((resolve) => setTimeout(resolve, 45));
  const progress = sent.filter((message) => message.method === 'notifications/progress');
  assert.ok(progress.length >= 2, `progress while waiting (${progress.length})`);
  assert.deepEqual(progress.map((message) => message.params.progress), progress.map((_, index) => index + 1));
  assert.equal(progress[0].params.progressToken, 'tok-1');
  release();
  const result = await response;
  assert.equal(result.id, 'call-1');
  const countAfter = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent.length, countAfter, 'no progress after the answer');
});

test('a cancelled call is not answered; batches answer their requests only', async () => {
  let release = () => {};
  const server = createOarMcpServer({
    api: async () => new Promise((resolve) => { release = () => resolve({ ok: true }); }),
    conversationId: 'conv-1',
    remoteRelay: true,
  });
  const pending = server.handleMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'remote_relay', arguments: { action: 'list_relays' } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }), null);
  release();
  assert.equal(await pending, null);

  const batch = await server.handleMessage([
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]);
  assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 1, result: {} }]);
  // A response from the client (to nothing we asked) is ignored.
  assert.equal(await server.handleMessage({ jsonrpc: '2.0', id: 3, result: {} }), null);
});

test('a cancel aborts the relay request; cancelAll aborts every running call', async () => {
  const signals = [];
  const server = createOarMcpServer({
    api: (method, routePath, body, options = {}) => new Promise((_, reject) => {
      signals.push(options.signal);
      options.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      }, { once: true });
    }),
    conversationId: 'conv-1',
    remoteRelay: true,
  });
  const call = (id) => server.handleMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'remote_relay', arguments: { action: 'list_relays' } },
  });

  const first = call(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  await server.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  assert.equal(signals[0].aborted, true, 'the relay request is aborted, not just its answer dropped');
  assert.equal(await first, null);

  // The host went away (stdin closed): nothing is left to read any answer.
  const second = call(2);
  const third = call('three');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.cancelAll(), 2);
  assert.deepEqual(signals.slice(1).map((signal) => signal.aborted), [true, true]);
  assert.deepEqual(await Promise.all([second, third]), [null, null]);
});

test('the tool list waits for the registration decision, which fails closed', async () => {
  const undecided = createOarMcpServer({ api: async () => ({}), remoteRelay: Promise.reject(new Error('down')) });
  assert.deepEqual((await undecided.listTools()).map((tool) => tool.name), ['preview']);
  const decided = createOarMcpServer({ api: async () => ({}), remoteRelay: Promise.resolve(true) });
  assert.deepEqual((await decided.listTools()).map((tool) => tool.name), ['remote_relay', 'preview']);
});
