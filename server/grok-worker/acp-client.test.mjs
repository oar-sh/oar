import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  ACP_MCP_INITIALIZED_METHOD,
  ACP_MCP_SERVER_STATUS_METHOD,
  AcpClient,
  GROK_MAX_MCP_OUTPUT_BYTES,
  buildGrokChildEnv,
  toAcpStdioMcpServer,
  withAcpMcpServers,
} from './acp-client.mjs';
import { createGrokAgentHandle, startGrokTurn } from './grok-sdk-adapter.mjs';
import { describeTurnStall, isTurnStalledError } from '../../shared/worker-runtime/turn-liveness.mjs';

function createFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = { write() {} };
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  proc.pid = 12345;
  return proc;
}

test('a spawn failure rejects pending requests instead of crashing the process', async () => {
  // Regression: `emit('error')` on a listener-less EventEmitter throws
  // ERR_UNHANDLED_ERROR synchronously out of the spawn callback — which used
  // to escape as an uncaught exception and take down the relay server when
  // the Grok CLI was not installed (ENOENT on the Linux host).
  let proc = null;
  const client = new AcpClient({
    spawnImpl: () => {
      proc = createFakeProc();
      return proc;
    },
  });

  const pending = client.initialize();
  const enoent = Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' });
  // Throws here (not in the promise) if the emit is unguarded.
  proc.emit('error', enoent);

  await assert.rejects(pending, /ENOENT/);
  assert.equal(client.dead, true);
});

test('an error listener still receives spawn failures after pending rejection', async () => {
  let proc = null;
  const client = new AcpClient({
    spawnImpl: () => {
      proc = createFakeProc();
      return proc;
    },
  });
  const seen = [];
  client.on('error', (err) => seen.push(err));

  const pending = client.initialize();
  proc.emit('error', new Error('spawn grok ENOENT'));

  await assert.rejects(pending, /ENOENT/);
  assert.equal(seen.length, 1);
});

async function waitFor(check, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function startClientWithCapturedWrites() {
  let proc = null;
  const client = new AcpClient({
    spawnImpl: () => {
      proc = createFakeProc();
      return proc;
    },
  });
  client.start();
  const writes = [];
  proc.stdin.write = (data) => {
    writes.push(String(data));
    return true;
  };
  const pushLine = (msg) => proc.stdout.write(`${JSON.stringify(msg)}\n`);
  return { client, proc, writes, pushLine };
}

test('an unhandled agent→client request gets method-not-found instead of silence', async () => {
  // Regression for the 0117fb12 stall: terminal/create was advertised but
  // never answered, so the agent waited forever and the turn never finished.
  const { writes, pushLine } = startClientWithCapturedWrites();
  pushLine({ jsonrpc: '2.0', id: 7, method: 'no-such/method', params: {} });
  await waitFor(() => writes.length >= 1);
  const reply = JSON.parse(writes[0]);
  assert.equal(reply.id, 7);
  assert.equal(reply.error.code, -32601);
  assert.match(reply.error.message, /no-such\/method/);
});

test('a registered request handler answers the agent request', async () => {
  const { client, writes, pushLine } = startClientWithCapturedWrites();
  client.setRequestHandler('terminal/create', async () => ({ terminalId: 'term-9' }));
  client.setRequestHandler('terminal/release', () => undefined);
  pushLine({ jsonrpc: '2.0', id: 1, method: 'terminal/create', params: { command: 'echo hi' } });
  pushLine({ jsonrpc: '2.0', id: 2, method: 'terminal/release', params: { terminalId: 'term-9' } });
  await waitFor(() => writes.length >= 2);
  const replies = writes.map((w) => JSON.parse(w));
  assert.deepEqual(replies.find((r) => r.id === 1).result, { terminalId: 'term-9' });
  // undefined handler results are normalized to a null JSON-RPC result.
  assert.equal(replies.find((r) => r.id === 2).result, null);
});

test('a throwing request handler responds with an internal error, not a hang', async () => {
  const { client, writes, pushLine } = startClientWithCapturedWrites();
  client.setRequestHandler('terminal/create', async () => {
    throw new Error('spawn exploded');
  });
  pushLine({ jsonrpc: '2.0', id: 4, method: 'terminal/create', params: {} });
  await waitFor(() => writes.length >= 1);
  const reply = JSON.parse(writes[0]);
  assert.equal(reply.error.code, -32603);
  assert.match(reply.error.message, /spawn exploded/);
});

test('session/request_permission still flows through the permission event', async () => {
  const { client, writes, pushLine } = startClientWithCapturedWrites();
  const seen = [];
  client.on('permission', (msg) => seen.push(msg));
  pushLine({ jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: { options: [] } });
  await waitFor(() => seen.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // No auto-reply: the turn runner owns the permission answer.
  assert.equal(writes.length, 0);
  assert.equal(seen[0].id, 3);
});

test('sessionPrompt fails a silent turn via the inactivity watchdog', async () => {
  const { client } = startClientWithCapturedWrites();
  await assert.rejects(
    client.sessionPrompt('sess', [{ type: 'text', text: 'hi' }], null, {}, {
      inactivityMs: 50,
      maxTurnMs: 60_000,
    }),
    /turn stalled/,
  );
});

test('a silent prompt stalls after the model window, and the failure says so', async () => {
  const { client } = startClientWithCapturedWrites();
  const startedAt = Date.now();
  const error = await client.sessionPrompt('sess', [{ type: 'text', text: 'hi' }], null, {}, {
    inactivityMs: 400,
    maxTurnMs: 60_000,
  }).then(() => null, (failure) => failure);

  // A prompt in flight is the model working: 2.5 inactivity windows.
  assert.ok(Date.now() - startedAt >= 1000, 'not failed at the inactivity window');
  assert.equal(isTurnStalledError(error), true);
  assert.equal(error.stall.phase, 'model');
  assert.match(describeTurnStall(error), /^System note: the Grok runtime sent nothing for 0s while a model request was running/);
});

test('a tool call of the agent that runs in silence does not stall the prompt', async () => {
  const { client, pushLine } = startClientWithCapturedWrites();
  const promptPromise = client.sessionPrompt('sess', [{ type: 'text', text: 'hi' }], null, {}, {
    inactivityMs: 40,
    maxTurnMs: 60_000,
  });
  pushLine({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'sess', update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'make', kind: 'execute', status: 'in_progress' } },
  });
  // Three model windows of silence, well inside the tool window.
  await new Promise((resolve) => setTimeout(resolve, 300));
  pushLine({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: 'sess', update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' } },
  });
  pushLine({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
  assert.equal((await promptPromise).stopReason, 'end_turn');
});

test('an environment that turns the shared watchdog off leaves this one on', async () => {
  // The window named here was dropped when the windows were rebuilt, and
  // the test waited out the default of five minutes in every run.
  const { client } = startClientWithCapturedWrites();
  const startedAt = Date.now();
  const error = await client.sessionPrompt('sess', [{ type: 'text', text: 'hi' }], null, {}, {
    env: { OAR_TURN_STALL_IDLE_MS: '0' },
    modelMs: 300,
    maxTurnMs: 0,
  }).then(() => null, (failure) => failure);
  assert.equal(isTurnStalledError(error), true);
  assert.equal(error.stall?.phase, 'model');
  assert.ok(Date.now() - startedAt < 30_000, 'the window the caller named decides, not the default');
});

test('sessionPrompt watchdog defers to pending client-side work until the ceiling', async () => {
  const { client } = startClientWithCapturedWrites();
  await assert.rejects(
    client.sessionPrompt('sess', [{ type: 'text', text: 'hi' }], null, {}, {
      inactivityMs: 50,
      maxTurnMs: 400,
      hasPendingWork: () => true,
    }),
    /turn ceiling/,
  );
});

test('sessionPrompt survives quiet gaps as long as ACP traffic keeps flowing', async () => {
  const { client, pushLine } = startClientWithCapturedWrites();
  const updates = [];
  const promptPromise = client.sessionPrompt(
    'sess',
    [{ type: 'text', text: 'hi' }],
    (update) => updates.push(update),
    {},
    { inactivityMs: 500, maxTurnMs: 60_000 },
  );
  setTimeout(() => {
    pushLine({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess', update: { kind: 'tick' } } });
  }, 200);
  setTimeout(() => {
    pushLine({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
  }, 400);
  const result = await promptPromise;
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(updates.length, 1);
});

test('createGrokAgentHandle attaches host services before the first prompt', async () => {
  const attached = [];
  const fakeServices = {
    disposed: false,
    attach: (client) => attached.push(client),
    hasPendingWork: () => false,
    disposeAll() { this.disposed = true; },
  };
  class FakeClient extends AcpClient {
    constructor(opts) {
      super({ ...opts, spawnImpl: () => createFakeProc() });
    }
    async request(method) {
      if (method === 'initialize') return {};
      if (method === 'session/new') return { sessionId: 'sess-live' };
      return {};
    }
  }
  const handle = await createGrokAgentHandle({
    cwd: process.cwd(),
    AcpClientImpl: FakeClient,
    createHostServicesImpl: () => fakeServices,
  });
  assert.equal(attached.length, 1);
  assert.equal(handle.hostServices, fakeServices);
  await handle.close();
  assert.equal(fakeServices.disposed, true);
});

test('createGrokAgentHandle surfaces a missing CLI as a rejection, not a crash', async () => {
  await assert.rejects(
    createGrokAgentHandle({
      cwd: process.cwd(),
      AcpClientImpl: class extends AcpClient {
        constructor(opts) {
          super({
            ...opts,
            spawnImpl: () => {
              const proc = createFakeProc();
              queueMicrotask(() => proc.emit('error', Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' })));
              return proc;
            },
          });
        }
      },
    }),
    /ENOENT/,
  );
});

// ─── MCP servers in session/new and session/load ─────────────────────────────

test('toAcpStdioMcpServer turns a launch into the ACP stdio shape', () => {
  assert.deepEqual(
    toAcpStdioMcpServer({
      command: '/usr/local/bin/node',
      args: ['/srv/oar/server/mcp/oar-mcp-server.mjs', '--conversation-id', 'conv-1'],
      env: { COPILOT_WEB_RELAY_CONFIG: '/srv/oar/server/config.json' },
    }, 'oar'),
    {
      name: 'oar',
      command: '/usr/local/bin/node',
      args: ['/srv/oar/server/mcp/oar-mcp-server.mjs', '--conversation-id', 'conv-1'],
      env: [{ name: 'COPILOT_WEB_RELAY_CONFIG', value: '/srv/oar/server/config.json' }],
    },
  );
  // args and env are required by the schema, even when empty.
  assert.deepEqual(toAcpStdioMcpServer({ command: 'node' }), { name: 'oar', command: 'node', args: [], env: [] });
});

const OAR_SERVER = {
  name: 'oar',
  command: '/usr/local/bin/node',
  args: ['/srv/oar/server/mcp/oar-mcp-server.mjs', '--conversation-id', 'conv-1'],
  env: [{ name: 'COPILOT_WEB_RELAY_CONFIG', value: '/srv/oar/server/config.json' }],
};

test('session/new and session/load carry the configured MCP servers', async () => {
  const sent = [];
  class RecordingClient extends AcpClient {
    async request(method, params) {
      sent.push({ method, params });
      return { sessionId: 'sess-1' };
    }
  }
  const plain = new RecordingClient({ spawnImpl: () => createFakeProc() });
  await plain.sessionNew('/home/dev/app');
  assert.deepEqual(sent[0].params.mcpServers, [], 'none unless configured');

  const Wired = withAcpMcpServers(RecordingClient, [OAR_SERVER]);
  const client = new Wired({ spawnImpl: () => createFakeProc() });
  await client.sessionNew('/home/dev/app', { _meta: { modelId: 'grok-4.5' } });
  await client.sessionLoad('sess-1', '/home/dev/app');
  assert.deepEqual(sent[1], {
    method: 'session/new',
    params: { cwd: '/home/dev/app', mcpServers: [OAR_SERVER], _meta: { modelId: 'grok-4.5' } },
  });
  assert.deepEqual(sent[2], {
    method: 'session/load',
    params: { sessionId: 'sess-1', cwd: '/home/dev/app', mcpServers: [OAR_SERVER] },
  });
  // An explicit list wins over the bound one.
  const explicit = new Wired({ spawnImpl: () => createFakeProc(), mcpServers: [] });
  assert.deepEqual(explicit.mcpServers, []);
});

test('createGrokAgentHandle opens the session with the MCP servers of the client class it is given', async () => {
  const sent = [];
  class FakeClient extends AcpClient {
    constructor(opts) {
      super({ ...opts, spawnImpl: () => createFakeProc() });
    }
    async request(method, params) {
      sent.push({ method, params });
      if (method === 'initialize') return { agentCapabilities: { loadSession: true } };
      return { sessionId: 'sess-live' };
    }
  }
  const services = { attach() {}, hasPendingWork: () => false, disposeAll() {} };
  const fresh = await createGrokAgentHandle({
    cwd: '/home/dev/app',
    AcpClientImpl: withAcpMcpServers(FakeClient, [OAR_SERVER]),
    createHostServicesImpl: () => services,
  });
  const resumed = await createGrokAgentHandle({
    cwd: '/home/dev/app',
    nativeSessionId: 'sess-old',
    AcpClientImpl: withAcpMcpServers(FakeClient, [OAR_SERVER]),
    createHostServicesImpl: () => services,
  });
  assert.deepEqual(sent.find((entry) => entry.method === 'session/new').params.mcpServers, [OAR_SERVER]);
  assert.deepEqual(sent.find((entry) => entry.method === 'session/load').params.mcpServers, [OAR_SERVER]);
  await fresh.close();
  await resumed.close();
});

// ─── waiting for the OAR MCP server before the first prompt ──────────────────

function mcpStatus(sessionId, name, status, reason = 'initialized') {
  return { jsonrpc: '2.0', method: ACP_MCP_SERVER_STATUS_METHOD, params: { sessionId, name, source: 'local', status, reason, tools: null } };
}

test('the client keeps the latest MCP server status per session and name', async () => {
  const { client, pushLine } = startClientWithCapturedWrites();
  const seen = [];
  client.on('notification', (msg) => seen.push(msg.method));
  pushLine(mcpStatus('sess-a', 'oar', 'unavailable', 'handshake_failed'));
  pushLine(mcpStatus('sess-a', 'oar', 'ready'));
  pushLine(mcpStatus('sess-b', 'tools-x', 'ready'));
  await waitFor(() => seen.length === 3);
  assert.equal(client.mcpServerState('sess-a', 'oar').status, 'ready');
  assert.equal(client.mcpServerState('sess-b', 'tools-x').status, 'ready');
  assert.equal(client.mcpServerState('sess-b', 'oar'), null);
});

test('waitForMcpServer ends on ready, on a failed start, on timeout and on exit, never by rejecting', async () => {
  const { client, proc, pushLine } = startClientWithCapturedWrites();
  const ready = client.waitForMcpServer('sess-a', 'oar', { timeoutMs: 5_000 });
  // Another server, or the same name in another session, does not count.
  pushLine(mcpStatus('sess-a', 'tools-x', 'ready'));
  pushLine(mcpStatus('sess-z', 'oar', 'ready'));
  pushLine(mcpStatus('sess-a', 'oar', 'starting'));
  pushLine(mcpStatus('sess-a', 'oar', 'ready'));
  assert.equal((await ready).status, 'ready');
  // Already known: at once.
  const known = await client.waitForMcpServer('sess-a', 'oar', { timeoutMs: 5_000 });
  assert.equal(known.status, 'ready');
  assert.ok(known.waitedMs < 50);

  const failed = client.waitForMcpServer('sess-b', 'oar', { timeoutMs: 5_000 });
  pushLine(mcpStatus('sess-b', 'oar', 'unavailable', 'handshake_failed'));
  assert.deepEqual({ ...(await failed), waitedMs: 0 }, { status: 'failed', reason: 'handshake_failed', waitedMs: 0 });

  const timedOut = await client.waitForMcpServer('sess-c', 'oar', { timeoutMs: 60 });
  assert.equal(timedOut.status, 'timeout');
  assert.ok(timedOut.waitedMs >= 50);

  const closed = client.waitForMcpServer('sess-d', 'oar', { timeoutMs: 5_000 });
  proc.emit('exit', 1, null);
  assert.equal((await closed).status, 'closed');
  assert.equal((await client.waitForMcpServer('sess-e', 'oar', { timeoutMs: 5_000 })).status, 'closed');
});

test('all servers initialized ends the wait for a server no status was reported for', async () => {
  const { client, pushLine } = startClientWithCapturedWrites();
  const initialized = (sessionId) => ({ jsonrpc: '2.0', method: ACP_MCP_INITIALIZED_METHOD, params: { sessionId, mcpToolCount: 3, elapsedMs: 120 } });

  const pending = client.waitForMcpServer('sess-a', 'oar', { timeoutMs: 5_000 });
  pushLine(initialized('sess-z'));
  pushLine(initialized('sess-a'));
  assert.deepEqual({ ...(await pending), waitedMs: 0 }, { status: 'ready', reason: 'all servers initialized', waitedMs: 0 });
  // Already initialized before the wait: at once.
  assert.equal((await client.waitForMcpServer('sess-a', 'oar', { timeoutMs: 5_000 })).status, 'ready');

  // A status that was reported for the server keeps deciding.
  const seen = [];
  client.on('mcpServerStatus', (state) => seen.push(state));
  pushLine(mcpStatus('sess-b', 'oar', 'starting'));
  await waitFor(() => seen.length === 1);
  const stillWaiting = client.waitForMcpServer('sess-b', 'oar', { timeoutMs: 80 });
  pushLine(initialized('sess-b'));
  assert.equal((await stillWaiting).status, 'timeout');
});

test('the Grok CLI child gets a larger MCP result cap unless the host set one', () => {
  const plain = buildGrokChildEnv({ PATH: '/usr/bin' });
  assert.equal(plain.GROK_MAX_MCP_OUTPUT_BYTES, String(GROK_MAX_MCP_OUTPUT_BYTES));
  assert.equal(plain.GROK_DISABLE_AUTOUPDATER, '1');
  assert.equal(plain.PATH, '/usr/bin');
  assert.equal('MAX_MCP_OUTPUT_BYTES' in plain, false);

  const nativeName = buildGrokChildEnv({ GROK_MAX_MCP_OUTPUT_BYTES: '30000' });
  assert.equal(nativeName.GROK_MAX_MCP_OUTPUT_BYTES, '30000');
  const genericName = buildGrokChildEnv({ MAX_MCP_OUTPUT_BYTES: '40000' });
  assert.equal(genericName.MAX_MCP_OUTPUT_BYTES, '40000');
  assert.equal('GROK_MAX_MCP_OUTPUT_BYTES' in genericName, false, 'the host\'s own choice wins');

  // The spawn uses it.
  let spawnedEnv = null;
  const client = new AcpClient({
    env: { PATH: '/usr/bin' },
    spawnImpl: (command, args, options) => { spawnedEnv = options.env; return createFakeProc(); },
  });
  client.start();
  assert.equal(spawnedEnv.GROK_MAX_MCP_OUTPUT_BYTES, String(GROK_MAX_MCP_OUTPUT_BYTES));
});

/**
 * A handle over a fake CLI: session/new answers `sess-live`, every
 * session/prompt is recorded with its time and ends the turn at once.
 * `pushLine` sends a line as the CLI would.
 */
async function createPromptRecordingHandle({ mcpServers = [OAR_SERVER], ...options } = {}) {
  let proc = null;
  const prompts = [];
  class FakeClient extends AcpClient {
    constructor(opts) {
      super({ ...opts, spawnImpl: () => { proc = createFakeProc(); return proc; } });
    }
    async request(method, params) {
      this.start();
      if (method === 'initialize') return {};
      if (method === 'session/new') return { sessionId: 'sess-live' };
      if (method === 'session/prompt') {
        prompts.push({ at: Date.now(), text: params.prompt?.[0]?.text });
        return { stopReason: 'end_turn' };
      }
      return {};
    }
  }
  const logs = [];
  const handle = await createGrokAgentHandle({
    cwd: '/home/dev/app',
    AcpClientImpl: withAcpMcpServers(FakeClient, mcpServers),
    createHostServicesImpl: () => ({ attach() {}, hasPendingWork: () => false, disposeAll() {} }),
    dbg: (...parts) => logs.push(parts.join(' ')),
    ...options,
  });
  const pushLine = (msg) => proc.stdout.write(`${JSON.stringify(msg)}\n`);
  return { handle, prompts, logs, pushLine };
}

async function runTurn(handle, text, options = {}) {
  const actions = [];
  for await (const action of startGrokTurn({ handle, text, ...options })) actions.push(action);
  return actions;
}

test('the first prompt waits until the OAR MCP server is ready', async () => {
  const { handle, prompts, logs, pushLine } = await createPromptRecordingHandle({ mcpReadyTimeoutMs: 5_000 });
  const turn = runTurn(handle, 'first');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(prompts.length, 0, 'no prompt while the server is connecting');
  // A server the host configured itself is never waited for.
  pushLine(mcpStatus('sess-live', 'tools-x', 'ready'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(prompts.length, 0);
  const readyAt = Date.now();
  pushLine(mcpStatus('sess-live', 'oar', 'ready'));
  await turn;
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].at >= readyAt);
  assert.ok(logs.some((line) => /grok mcp server wait oar ready \(initialized\) after \d+ms/.test(line)), logs.join('\n'));
  await handle.close();
});

test('the first prompt goes out at once when the server was ready before it', async () => {
  const { handle, prompts, pushLine } = await createPromptRecordingHandle({ mcpReadyTimeoutMs: 5_000 });
  pushLine(mcpStatus('sess-live', 'oar', 'ready'));
  await waitFor(() => handle.client.mcpServerState('sess-live', 'oar'));
  const startedAt = Date.now();
  await runTurn(handle, 'first');
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].at - startedAt < 100);
  await handle.close();
});

test('the first prompt goes out after the timeout without a ready report; the second does not wait', async () => {
  const { handle, prompts, logs } = await createPromptRecordingHandle({ mcpReadyTimeoutMs: 120 });
  const startedAt = Date.now();
  await runTurn(handle, 'first');
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].at - startedAt >= 100, 'waited for the timeout');
  assert.ok(logs.some((line) => /not ready in time; prompting anyway oar after \d+ms/.test(line)), logs.join('\n'));

  const secondAt = Date.now();
  await runTurn(handle, 'second');
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].at - secondAt < 60, 'a later prompt of the handle does not wait');
  await handle.close();
});

test('a session without the OAR MCP server does not wait', async () => {
  const { handle, prompts } = await createPromptRecordingHandle({
    mcpServers: [{ ...OAR_SERVER, name: 'tools-x' }],
    mcpReadyTimeoutMs: 5_000,
  });
  const startedAt = Date.now();
  await runTurn(handle, 'first');
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].at - startedAt < 100);
  await handle.close();

  const bare = await createPromptRecordingHandle({ mcpServers: [], mcpReadyTimeoutMs: 5_000 });
  const bareAt = Date.now();
  await runTurn(bare.handle, 'first');
  assert.ok(bare.prompts[0].at - bareAt < 100);
  await bare.handle.close();
});

test('a failed start of the OAR MCP server ends the wait early', async () => {
  const { handle, prompts, pushLine } = await createPromptRecordingHandle({ mcpReadyTimeoutMs: 5_000 });
  const startedAt = Date.now();
  const turn = runTurn(handle, 'first');
  pushLine(mcpStatus('sess-live', 'oar', 'unavailable', 'handshake_failed'));
  await turn;
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].at - startedAt < 1_000);
  await handle.close();
});

test('a turn cancelled while waiting for the server sends no prompt', async () => {
  const { handle, prompts } = await createPromptRecordingHandle({ mcpReadyTimeoutMs: 5_000 });
  const controller = new AbortController();
  const startedAt = Date.now();
  const turn = runTurn(handle, 'first', { abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  const actions = await turn;
  assert.equal(prompts.length, 0);
  assert.ok(Date.now() - startedAt < 1_000, 'the cancel ends the wait');
  assert.ok(actions.some((action) => JSON.stringify(action).includes('cancelled')), JSON.stringify(actions));
  await handle.close();
});

test('after a turn cancelled while waiting, the next prompt waits again', async () => {
  const { handle, prompts, logs, pushLine } = await createPromptRecordingHandle({ mcpReadyTimeoutMs: 5_000 });
  const controller = new AbortController();
  const cancelledTurn = runTurn(handle, 'first', { abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await cancelledTurn;
  assert.equal(prompts.length, 0, 'the cancelled turn sends no prompt');

  const turn = runTurn(handle, 'second');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(prompts.length, 0, 'the next prompt waits for the server too');
  const readyAt = Date.now();
  pushLine(mcpStatus('sess-live', 'oar', 'ready'));
  await turn;
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, 'second');
  assert.ok(prompts[0].at >= readyAt);
  assert.equal(logs.filter((line) => line.includes('grok mcp server wait')).length, 1, logs.join('\n'));

  const thirdAt = Date.now();
  await runTurn(handle, 'third');
  assert.ok(prompts[1].at - thirdAt < 60, 'a prompt after the ended wait does not wait');
  await handle.close();
});

// ─── the inactivity hold ─────────────────────────────────────────────────────

test('a granted hold re-arms the inactivity window; the prompt still completes', async () => {
  const { client, pushLine } = startClientWithCapturedWrites();
  let asked = 0;
  const promptPromise = client.sessionPrompt('sess', [{ type: 'text', text: 'hi' }], null, {}, {
    inactivityMs: 40,
    maxTurnMs: 60_000,
    holdStall: async () => { asked += 1; return true; },
  });
  // Well past several silent windows: the relay keeps saying a call is running.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.ok(asked >= 2, `the relay was asked each time the window ran out (${asked})`);
  pushLine({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } });
  const result = await promptPromise;
  assert.equal(result.stopReason, 'end_turn');
});

test('a refused, failing or slow hold question lets the stall fire', async () => {
  for (const holdStall of [
    async () => false,
    async () => { throw new Error('relay down'); },
    () => new Promise(() => {}),
  ]) {
    const { client } = startClientWithCapturedWrites();
    await assert.rejects(
      client.sessionPrompt('sess', [{ type: 'text', text: 'hi' }], null, {}, {
        inactivityMs: 40,
        maxTurnMs: 60_000,
        holdStall,
        holdCheckTimeoutMs: 50,
      }),
      /turn stalled/,
    );
  }
});

test('a hold never outlives the turn ceiling', async () => {
  const { client } = startClientWithCapturedWrites();
  await assert.rejects(
    client.sessionPrompt('sess', [{ type: 'text', text: 'hi' }], null, {}, {
      inactivityMs: 40,
      maxTurnMs: 700,
      holdStall: async () => true,
    }),
    /turn ceiling/,
  );
});
