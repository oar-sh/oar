import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerAgentSdkRoutes } from './agent-sdk-routes.mjs';
import { createAgentSdkStore } from '../services/agent-sdk-store.mjs';
import { CLI_SPAWN_DISABLED_ERROR } from '../services/cli-process-runner.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-sdk-routes-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function createMockApp() {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: register('GET'), post: register('POST') };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const request = { body: {}, query: {}, params: {}, headers: { authorization: 'Bearer fixture-token' }, ...req };
  for (const handler of handlers) {
    let next = false;
    await handler(request, response, () => { next = true; });
    if (!next) break;
  }
  return response;
}

const auth = (req, res, next) => (req.headers.authorization === 'Bearer fixture-token'
  ? next()
  : res.status(401).json({ error: 'Unauthorized' }));

function fakeIo() {
  const emitted = [];
  return { emitted, emit: (event, payload) => emitted.push({ event, payload }) };
}

function sdkStatus(id, overrides = {}) {
  return { id, label: `${id} fixture`, state: 'missing', pinned: '1.2.3', installed: null, logSeq: 0, ...overrides };
}

/** A store that records what reached it. */
function fakeStore({ installResult, cancelResult } = {}) {
  const calls = [];
  let listener = null;
  const sdks = { claude: sdkStatus('claude'), cursor: sdkStatus('cursor'), koffi: sdkStatus('koffi', { state: 'unsupported', support: 'no' }) };
  return {
    calls,
    publish: (snapshot) => listener?.(snapshot),
    snapshot: () => ({ root: '/srv/fixture/sdks', host: { platform: 'linux', arch: 'x64', libc: 'glibc' }, sdks }),
    status: (id) => {
      const key = String(id).trim().toLowerCase();
      return Object.prototype.hasOwnProperty.call(sdks, key) ? sdks[key] : null;
    },
    install: (id, options) => {
      calls.push(['install', id, options]);
      return installResult || { ok: true, reused: false, status: sdks[id] };
    },
    cancel: (id) => {
      calls.push(['cancel', id]);
      return cancelResult || { ok: true, status: sdks[id] };
    },
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
  };
}

function setup(storeOptions) {
  const app = createMockApp();
  const io = fakeIo();
  const store = fakeStore(storeOptions);
  registerAgentSdkRoutes(app, { auth, io, agentSdkStore: store });
  return { app, io, store, route: (key) => app.routes.get(key) };
}

test('the three routes are registered behind auth', async () => {
  const { route, store } = setup();
  for (const key of ['GET /api/agent-sdks/status', 'POST /api/agent-sdks/install', 'POST /api/agent-sdks/install/cancel']) {
    const handlers = route(key);
    assert.ok(handlers, key);
    assert.equal(handlers[0], auth, `${key}: auth runs first`);
    const refused = await callRoute(handlers, { headers: {}, body: { sdk: 'claude' } });
    assert.equal(refused.statusCode, 401, key);
  }
  assert.deepEqual(store.calls, [], 'nothing reached the store for a refused request');
});

test('GET /api/agent-sdks/status answers the store snapshot', async () => {
  const { route, store } = setup();
  const response = await callRoute(route('GET /api/agent-sdks/status'));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, store.snapshot());
});

test('install passes the id and reinstall (strictly true) to the store, and answers with the snapshot', async () => {
  const { route, store } = setup();
  const install = route('POST /api/agent-sdks/install');

  const plain = await callRoute(install, { body: { sdk: 'claude' } });
  assert.equal(plain.statusCode, 200);
  assert.equal(plain.body.ok, true);
  assert.equal(plain.body.reused, false);
  assert.deepEqual(plain.body.sdks, store.snapshot().sdks);
  assert.equal(plain.body.host.platform, 'linux');

  await callRoute(install, { body: { sdk: 'cursor', reinstall: true } });
  await callRoute(install, { body: { sdk: 'cursor', reinstall: 'true' } });
  assert.deepEqual(store.calls, [
    ['install', 'claude', { force: false }],
    ['install', 'cursor', { force: true }],
    ['install', 'cursor', { force: false }],
  ]);
});

test('an unknown or non-string id is a 400 before the store installs anything', async () => {
  const { route, store } = setup();
  for (const sdk of [undefined, '', 'claude; rm -rf /', '__proto__', 'toString', ['claude'], { id: 'claude' }, 7]) {
    const response = await callRoute(route('POST /api/agent-sdks/install'), { body: { sdk } });
    assert.equal(response.statusCode, 400, JSON.stringify(sdk));
    assert.equal(response.body.error, 'Unknown agent SDK');
    assert.ok(response.body.sdks, 'the rows ride along with a refusal');
    const cancel = await callRoute(route('POST /api/agent-sdks/install/cancel'), { body: { sdk } });
    assert.equal(cancel.statusCode, 400, JSON.stringify(sdk));
  }
  assert.deepEqual(store.calls, []);
});

test('a refusal keeps the store\'s status code and error', async () => {
  const { route } = setup({ installResult: { ok: false, statusCode: 409, error: 'fixture SDK is not available on this platform (linux-x64).' } });
  const response = await callRoute(route('POST /api/agent-sdks/install'), { body: { sdk: 'koffi' } });
  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /not available on this platform/);
  assert.ok(response.body.sdks.koffi);
});

test('a join and an already ready SDK say so', async () => {
  const joined = setup({ installResult: { ok: true, reused: true } });
  assert.equal((await callRoute(joined.route('POST /api/agent-sdks/install'), { body: { sdk: 'claude' } })).body.reused, true);
  const ready = setup({ installResult: { ok: true, ready: true } });
  const body = (await callRoute(ready.route('POST /api/agent-sdks/install'), { body: { sdk: 'claude' } })).body;
  assert.equal(body.ready, true);
  assert.equal(body.reused, false);
});

test('a store that throws is a 500, not a hung request', async () => {
  const { route, store } = setup();
  store.install = () => { throw new Error('disk gone'); };
  const response = await callRoute(route('POST /api/agent-sdks/install'), { body: { sdk: 'claude' } });
  assert.equal(response.statusCode, 500);
  assert.match(response.body.error, /disk gone/);
});

test('cancel reaches the store with the id and answers with the snapshot', async () => {
  const { route, store } = setup();
  const response = await callRoute(route('POST /api/agent-sdks/install/cancel'), { body: { sdk: 'cursor' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.ok(response.body.sdks.cursor);
  assert.deepEqual(store.calls, [['cancel', 'cursor']]);
});

test('every store change is broadcast as agent_sdk_state', () => {
  const { io, store } = setup();
  const snapshot = store.snapshot();
  store.publish(snapshot);
  assert.deepEqual(io.emitted, [{ event: 'agent_sdk_state', payload: snapshot }]);
});

test('without a store every route is a 503', async () => {
  const app = createMockApp();
  registerAgentSdkRoutes(app, { auth, io: fakeIo() });
  for (const key of ['GET /api/agent-sdks/status', 'POST /api/agent-sdks/install', 'POST /api/agent-sdks/install/cancel']) {
    assert.equal((await callRoute(app.routes.get(key), { body: { sdk: 'claude' } })).statusCode, 503, key);
  }
});

// The real store, with the package's own pins and a temp root: the spawn
// kill switch reaches the caller as the store's 503, and nothing is spawned.
test('the spawn kill switch comes back as the store\'s 503', async () => {
  const spawned = [];
  const store = createAgentSdkStore({
    env: { COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1' },
    platform: 'linux',
    host: { platform: 'linux', arch: 'x64', libc: 'glibc' },
    root: path.join(TMP, 'kill-switch'),
    spawnImpl: (...args) => { spawned.push(args); throw new Error('no spawn expected'); },
    logger: { log: () => {} },
  });
  const app = createMockApp();
  const io = fakeIo();
  registerAgentSdkRoutes(app, { auth, io, agentSdkStore: store });
  try {
    const response = await callRoute(app.routes.get('POST /api/agent-sdks/install'), { body: { sdk: 'claude' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.error, CLI_SPAWN_DISABLED_ERROR);
    assert.equal(response.body.sdks.claude.state, 'error');
    assert.equal(response.body.sdks.claude.canInstall, false);
    assert.deepEqual(spawned, []);
    // The failure was broadcast too, so every open Settings shows it.
    assert.ok(io.emitted.some(({ event, payload }) => event === 'agent_sdk_state' && payload.sdks.claude.state === 'error'));

    const unknown = await callRoute(app.routes.get('POST /api/agent-sdks/install'), { body: { sdk: 'grok' } });
    assert.equal(unknown.statusCode, 400);

    // Cancel dismisses the failure.
    const cancelled = await callRoute(app.routes.get('POST /api/agent-sdks/install/cancel'), { body: { sdk: 'claude' } });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.body.sdks.claude.state, 'missing');
  } finally {
    store.dispose();
  }
});
