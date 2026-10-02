import test from 'node:test';
import assert from 'node:assert/strict';

import { registerRemoteRelayRoutes } from './remote-relay-routes.mjs';
import { createRemoteRelayRegistry } from '../services/remote-relay-registry-service.mjs';
import { createRemoteRelayPairing } from '../services/remote-relay-pairing.mjs';
import { RemoteRelayError } from '../services/remote-relay-client.mjs';
import { REMOTE_RELAY_ERROR_CODES, REMOTE_RELAY_SETTING_KEYS } from '../../shared/remote-relay-contract.mjs';

const OWN_TOKEN = 'o'.repeat(36);
const CUSTOM_TOKEN = 'c'.repeat(64);
const OWN_ID = 'relay-self-0001';

function createMockApp() {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers);
  };
  return {
    routes,
    get: register('GET'),
    post: register('POST'),
    patch: register('PATCH'),
    delete: register('DELETE'),
  };
}

async function callRoute(handlers, req = {}, { onResponse = null } = {}) {
  const listeners = {};
  const response = {
    statusCode: 200,
    body: null,
    writableFinished: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.writableFinished = true;
      return this;
    },
    on(event, listener) {
      (listeners[event] ||= []).push(listener);
      return this;
    },
    // What Express emits when the client hangs up (or after the answer).
    close() {
      for (const listener of listeners.close || []) listener();
    },
  };
  onResponse?.(response);
  const request = { body: {}, query: {}, params: {}, headers: {}, ...req };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(request, response, () => {
      nextCalled = true;
    });
    if (!nextCalled) break;
  }
  return response;
}

function identity(overrides = {}) {
  return {
    relayId: 'relay-b-0002',
    name: 'linux-test',
    version: '0.9.4',
    platform: 'linux',
    publicUrl: 'https://relay-b.example.test',
    protocol: 1,
    inbound: true,
    ...overrides,
  };
}

function setup({ dispatcher = null, probeAnswers = {} } = {}) {
  const values = new Map([
    [REMOTE_RELAY_SETTING_KEYS.instanceId, JSON.stringify(OWN_ID)],
  ]);
  const client = {
    tokenFor: (relay) => (relay?.tokenMode === 'custom' ? relay.token : OWN_TOKEN),
    async probe(url) {
      const answer = probeAnswers[url];
      if (answer instanceof Error) throw answer;
      if (!answer) throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.offline, `Relay "${new URL(url).hostname}" is not reachable (ECONNREFUSED)`);
      return answer;
    },
    async request() {
      return { ok: true };
    },
  };
  let ids = 0;
  const registry = createRemoteRelayRegistry({
    readSetting: (key) => values.get(key) ?? null,
    writeSetting: (key, value) => values.set(key, value),
    client,
    getSelfName: () => 'win-test',
    hostname: 'devbox',
    platform: 'win32',
    version: '0.9.4',
    logger: { warn() {} },
    randomUUID: () => `uuid-${++ids}`,
  });
  const pairing = createRemoteRelayPairing({ registry, client, getOwnToken: () => OWN_TOKEN });
  const app = createMockApp();
  const auth = (_req, _res, next) => next();
  registerRemoteRelayRoutes(app, { auth, registry, pairing, dispatcher });
  const route = (key) => {
    const handlers = app.routes.get(key);
    assert.ok(handlers, `${key} is registered`);
    return handlers;
  };
  return { app, auth, registry, route, values };
}

function assertNoToken(response) {
  const text = JSON.stringify(response.body);
  assert.equal(text.includes(CUSTOM_TOKEN), false, 'no custom token in the response');
  assert.equal(text.includes(OWN_TOKEN), false, 'no own token in the response');
}

test('every route is behind auth and static paths come before /:id', () => {
  const { app, auth } = setup();
  const keys = [...app.routes.keys()];
  assert.deepEqual(keys.sort(), [
    'DELETE /api/remote-relays/:id',
    'GET /api/relay/identity',
    'GET /api/remote-relays',
    'GET /api/remote-relays/inflight',
    'GET /api/remote-relays/summary',
    'GET /api/settings/agent-sessions',
    'GET /api/settings/remote-relays',
    'PATCH /api/remote-relays/:id',
    'POST /api/remote-relays',
    'POST /api/remote-relays/:id/check',
    'POST /api/remote-relays/pair',
    'POST /api/remote-relays/tool',
    'POST /api/settings/agent-sessions',
    'POST /api/settings/remote-relays',
  ]);
  for (const [key, handlers] of app.routes) assert.equal(handlers[0], auth, `${key} starts with auth`);
  const order = [...app.routes.keys()];
  const idRoute = order.indexOf('POST /api/remote-relays/:id/check');
  for (const staticRoute of ['POST /api/remote-relays/pair', 'POST /api/remote-relays/tool']) {
    assert.ok(order.indexOf(staticRoute) < idRoute, `${staticRoute} is registered before the /:id route`);
  }
});

test('GET /api/relay/identity describes this relay', async () => {
  const { route } = setup();
  const response = await callRoute(route('GET /api/relay/identity'));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    relayId: OWN_ID,
    name: 'win-test',
    version: '0.9.4',
    platform: 'win32',
    publicUrl: null,
    remoteRelays: { protocol: 1, inbound: true },
  });
});

test('GET /api/remote-relays lists public entries and the self block, never a token', async () => {
  const { route, registry } = setup();
  registry.add({ name: 'linux-test', url: 'https://relay-b.example.test', token: CUSTOM_TOKEN, lastStatus: 'online' });
  registry.add({ name: 'lan-test', url: 'http://192.168.10.20:3333' });
  const response = await callRoute(route('GET /api/remote-relays'));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.relays.map((relay) => [relay.name, relay.host, relay.tokenMode]), [
    ['linux-test', 'relay-b.example.test', 'custom'],
    ['lan-test', '192.168.10.20', 'own'],
  ]);
  assert.match(response.body.relays[1].httpWarning, /Plain http/);
  assert.equal(response.body.self.relayId, OWN_ID);
  assert.equal(response.body.self.name, 'win-test');
  assert.equal(response.body.self.inboundEnabled, true);
  assert.equal(response.body.self.publicUrl, '');
  assertNoToken(response);
});

test('GET /api/remote-relays/summary counts remotes and online ones', async () => {
  const { route, registry } = setup();
  assert.deepEqual((await callRoute(route('GET /api/remote-relays/summary'))).body, { count: 0, online: 0, localEnabled: false });
  registry.add({ name: 'linux-test', url: 'https://relay-b.example.test', lastStatus: 'online' });
  registry.add({ name: 'win-test-2', url: 'https://relay-a.example.test', lastStatus: 'offline' });
  assert.deepEqual((await callRoute(route('GET /api/remote-relays/summary'))).body, { count: 2, online: 1, localEnabled: false });
});

test('the summary says when this relay itself is open to its agents, with no relay paired', async () => {
  const { route } = setup();
  await callRoute(route('POST /api/settings/agent-sessions'), { body: { enabled: true } });
  assert.deepEqual((await callRoute(route('GET /api/remote-relays/summary'))).body, { count: 0, online: 0, localEnabled: true });
});

test('agent sessions settings: off and 600 s by default, with the slider\'s range', async () => {
  const { route } = setup();
  const read = await callRoute(route('GET /api/settings/agent-sessions'));
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.body, {
    enabled: false,
    maxWaitSeconds: 600,
    limits: { minWaitSeconds: 120, maxWaitSeconds: 3600, stepSeconds: 60 },
    maxActiveSessions: 4,
  });
});

test('agent sessions settings are saved one field at a time and answer the whole state', async () => {
  const { route, values } = setup();
  const post = route('POST /api/settings/agent-sessions');
  const shape = (enabled, maxWaitSeconds) => ({
    ok: true,
    enabled,
    maxWaitSeconds,
    limits: { minWaitSeconds: 120, maxWaitSeconds: 3600, stepSeconds: 60 },
    maxActiveSessions: 4,
  });

  const enabled = await callRoute(post, { body: { enabled: true } });
  assert.equal(enabled.statusCode, 200);
  assert.deepEqual(enabled.body, shape(true, 600));
  const longer = await callRoute(post, { body: { maxWaitSeconds: 3600 } });
  assert.deepEqual(longer.body, shape(true, 3600));
  assert.deepEqual((await callRoute(post, { body: { enabled: false, maxWaitSeconds: 120 } })).body, shape(false, 120));
  assert.deepEqual((await callRoute(post, { body: {} })).body, shape(false, 120), 'an empty body changes nothing');
  assert.equal(values.get(REMOTE_RELAY_SETTING_KEYS.agentSessionsEnabled), 'false');
  assert.equal(values.get(REMOTE_RELAY_SETTING_KEYS.maxWaitSeconds), '120');
  const { ok: _ok, ...state } = shape(false, 120);
  assert.deepEqual((await callRoute(route('GET /api/settings/agent-sessions'))).body, state);
});

test('agent sessions settings refuse what the slider and the toggle cannot produce', async () => {
  const { route, values } = setup();
  const post = route('POST /api/settings/agent-sessions');
  for (const body of [
    { enabled: 'yes' },
    { enabled: 1 },
    { maxWaitSeconds: 60 },
    { maxWaitSeconds: 3660 },
    { maxWaitSeconds: 610 },
    { maxWaitSeconds: 600.5 },
    { maxWaitSeconds: '600' },
    { maxWaitSeconds: null },
    // One bad field refuses the whole request: nothing is half-saved.
    { enabled: true, maxWaitSeconds: 5 },
  ]) {
    const refused = await callRoute(post, { body });
    assert.equal(refused.statusCode, 400, JSON.stringify(body));
    assert.equal(typeof refused.body.error, 'string');
    assert.ok(refused.body.error.length > 0);
  }
  assert.equal(values.has(REMOTE_RELAY_SETTING_KEYS.agentSessionsEnabled), false);
  assert.equal(values.has(REMOTE_RELAY_SETTING_KEYS.maxWaitSeconds), false);
});

test('POST /api/remote-relays maps the pairing outcomes to status codes', async () => {
  const { route } = setup({
    probeAnswers: {
      'https://relay-b.example.test': identity(),
      'https://relay-a.example.test': identity({ relayId: OWN_ID, name: 'win-test' }),
      'https://relay-c.example.test': new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unauthorized, 'rejected the token (401)', { status: 401 }),
    },
  });
  const add = route('POST /api/remote-relays');

  const added = await callRoute(add, { body: { url: 'https://relay-b.example.test', token: CUSTOM_TOKEN, pairBack: false } });
  assert.equal(added.statusCode, 200);
  assert.equal(added.body.ok, true);
  assert.equal(added.body.relay.name, 'linux-test');
  assert.equal('status' in added.body, false, 'the HTTP status is not echoed in the body');
  assertNoToken(added);

  const invalid = await callRoute(add, { body: { url: 'http://relay-b.example.test' } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.ok, false);

  const self = await callRoute(add, { body: { url: 'https://relay-a.example.test' } });
  assert.equal(self.statusCode, 400);
  assert.equal(self.body.code, 'SELF');

  const needsToken = await callRoute(add, { body: { url: 'https://relay-c.example.test' } });
  assert.equal(needsToken.statusCode, 200);
  assert.equal(needsToken.body.ok, false);
  assert.equal(needsToken.body.needsToken, true);

  const offline = await callRoute(add, { body: { url: 'https://relay-d.example.test' } });
  assert.equal(offline.statusCode, 502);
  assert.equal(offline.body.code, REMOTE_RELAY_ERROR_CODES.offline);
});

test('POST /api/remote-relays/pair answers with our identity and never echoes the token', async () => {
  const { route, registry } = setup({ probeAnswers: { 'https://relay-b.example.test': identity() } });
  const pair = route('POST /api/remote-relays/pair');
  const accepted = await callRoute(pair, {
    body: { relayId: 'relay-b-0002', name: 'linux-test', url: 'https://relay-b.example.test', protocol: 1, token: CUSTOM_TOKEN },
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.body, { ok: true, relayId: OWN_ID, name: 'win-test' });
  assert.equal(registry.list()[0].token, CUSTOM_TOKEN);
  assertNoToken(accepted);

  const missing = await callRoute(pair, { body: { url: 'https://relay-b.example.test' } });
  assert.equal(missing.statusCode, 400);
  const self = await callRoute(pair, { body: { relayId: OWN_ID, url: 'https://relay-b.example.test' } });
  assert.equal(self.statusCode, 400);
});

test('self settings read and validate', async () => {
  const { route } = setup();
  assert.deepEqual((await callRoute(route('GET /api/settings/remote-relays'))).body, { publicUrl: '', inboundEnabled: true });
  const saved = await callRoute(route('POST /api/settings/remote-relays'), { body: { publicUrl: 'https://relay-a.example.test/', inboundEnabled: false } });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.body, { ok: true, publicUrl: 'https://relay-a.example.test', inboundEnabled: false });
  const refused = await callRoute(route('POST /api/settings/remote-relays'), { body: { publicUrl: 'http://relay-a.example.test' } });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.body.ok, false);
  const identityAfter = await callRoute(route('GET /api/relay/identity'));
  assert.equal(identityAfter.body.publicUrl, 'https://relay-a.example.test');
  assert.equal(identityAfter.body.remoteRelays.inbound, false);
});

test('PATCH, DELETE and check address one relay by id', async () => {
  const { route, registry } = setup({ probeAnswers: { 'https://relay-b.example.test': identity() } });
  const entry = registry.add({ name: 'relay-b.example.test', url: 'https://relay-b.example.test' });

  const patched = await callRoute(route('PATCH /api/remote-relays/:id'), { params: { id: entry.id }, body: { permission: 'read', token: CUSTOM_TOKEN } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.body.relay.permission, 'read');
  assert.equal(patched.body.relay.tokenMode, 'custom');
  assertNoToken(patched);
  assert.equal((await callRoute(route('PATCH /api/remote-relays/:id'), { params: { id: entry.id }, body: { permission: 'root' } })).statusCode, 400);
  assert.equal((await callRoute(route('PATCH /api/remote-relays/:id'), { params: { id: 'missing' }, body: { permission: 'read' } })).statusCode, 404);

  const checked = await callRoute(route('POST /api/remote-relays/:id/check'), { params: { id: entry.id } });
  assert.equal(checked.statusCode, 200);
  assert.equal(checked.body.relay.lastStatus, 'online');
  assert.equal(checked.body.relay.name, 'linux-test');
  assertNoToken(checked);
  assert.equal((await callRoute(route('POST /api/remote-relays/:id/check'), { params: { id: 'missing' } })).statusCode, 404);

  const removed = await callRoute(route('DELETE /api/remote-relays/:id'), { params: { id: entry.id } });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(removed.body, { ok: true });
  assert.equal((await callRoute(route('DELETE /api/remote-relays/:id'), { params: { id: entry.id } })).statusCode, 404);
});

test('the tool endpoint is 503 until a dispatcher is wired', async () => {
  const { route } = setup();
  const response = await callRoute(route('POST /api/remote-relays/tool'), { body: { conversationId: 'c-1', action: 'list_relays' } });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.body, { error: 'Remote relay dispatcher unavailable' });
  assert.deepEqual((await callRoute(route('GET /api/remote-relays/inflight'), { query: { conversationId: 'c-1' } })).body, { inflight: 0 });
});

test('the tool endpoint forwards to the dispatcher and relays its answer', async () => {
  const calls = [];
  const dispatcher = {
    async dispatch(input) {
      calls.push(input);
      if (input.action === 'explode') throw new Error('dispatcher broke');
      return { status: 409, body: { ok: false, code: 'REMOTE_RELAY_LOCKED', error: 'Ask the user to mention @linux-test' } };
    },
    inflight: (conversationId) => (conversationId === 'c-1' ? 2 : 0),
  };
  const { route } = setup({ dispatcher });
  const req = { body: { conversationId: 'c-1', action: 'list_sessions' }, headers: { 'x-relay-session-id': 's-1' } };
  const response = await callRoute(route('POST /api/remote-relays/tool'), req);
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'REMOTE_RELAY_LOCKED');
  assert.equal(calls[0].conversationId, 'c-1');
  assert.equal(calls[0].action, 'list_sessions');
  assert.deepEqual(calls[0].args, {}, 'args default to an empty object');
  assert.equal(calls[0].req.headers['x-relay-session-id'], 's-1', 'the request is passed for the worker identity headers');

  const failed = await callRoute(route('POST /api/remote-relays/tool'), { body: { conversationId: 'c-1', action: 'explode' } });
  assert.equal(failed.statusCode, 500);

  assert.deepEqual((await callRoute(route('GET /api/remote-relays/inflight'), { query: { conversationId: 'c-1' } })).body, { inflight: 2 });
  assert.deepEqual((await callRoute(route('GET /api/remote-relays/inflight'), { query: {} })).body, { inflight: 0 });
});

test('a worker that hangs up aborts the dispatch, and nothing is written to the closed response', async () => {
  let seenSignal = null;
  let hangUp = null;
  const dispatcher = {
    async dispatch(input) {
      seenSignal = input.signal;
      hangUp();
      return { status: 200, body: { ok: true } };
    },
    inflight: () => 0,
  };
  const { route } = setup({ dispatcher });
  const response = await callRoute(
    route('POST /api/remote-relays/tool'),
    { body: { conversationId: 'c-1', action: 'wait' } },
    { onResponse: (res) => { hangUp = () => res.close(); } },
  );
  assert.equal(seenSignal.aborted, true);
  assert.equal(response.body, null, 'no answer after the hang-up');

  // A normal answer closes the response afterwards; that is not an abort.
  let normalSignal = null;
  const normal = {
    async dispatch(input) {
      normalSignal = input.signal;
      return { status: 200, body: { ok: true } };
    },
    inflight: () => 0,
  };
  const answered = await callRoute(setup({ dispatcher: normal }).route('POST /api/remote-relays/tool'), { body: { conversationId: 'c-1', action: 'wait' } });
  answered.close();
  assert.equal(normalSignal.aborted, false);
  assert.deepEqual(answered.body, { ok: true });
});
