import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { AcpClient } from './acp-client.mjs';
import { createGrokAgentHandle } from './grok-sdk-adapter.mjs';

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
