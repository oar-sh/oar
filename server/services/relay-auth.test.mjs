import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  AUTH_FAILURE_LIMIT,
  createAuthFailureLockout,
  createRelayAuth,
  tokensMatch,
} from './relay-auth.mjs';
import { createLocalRequestCheck } from './request-boundary.mjs';
import { registerMessagesRoutes } from '../routes/messages-routes.mjs';
import { makeRouteDeps } from '../routes/messages-routes-test-harness.mjs';

const TOKEN = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const COOKIE = 'copilot_auth';

// A browser over the built-in tunnel: cloudflared on loopback adds cf-ray and
// X-Forwarded-For, so req.ip is the client and the request is not local.
function tunnel(clientIp) {
  return { 'cf-ray': '8a1b2c3d4e5f6789-AMS', 'x-forwarded-for': clientIp };
}

function wrongToken(index) {
  return `${TOKEN.slice(0, -4)}${String(index).padStart(4, '0')}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
}

async function startApp({ clock = null, routes = null } = {}) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const lockout = createAuthFailureLockout(clock ? { nowMs: () => clock.now } : {});
  const relayAuth = createRelayAuth({
    app,
    getAuthToken: () => TOKEN,
    cookieName: COOKIE,
    parseCookies,
    appendSetCookie,
    localRequestCheck: createLocalRequestCheck(),
    lockout,
    logger: { warn() {} },
  });
  app.get('/api/status', relayAuth.auth, (_req, res) => res.json({ ok: true }));
  app.get('/api/files/*', relayAuth.auth, (_req, res) => res.type('text').send('file'));
  if (routes) routes(app, relayAuth);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { method = 'GET', headers = {}, body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { app, relayAuth, call, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('tokensMatch: exact match only, empty never matches', () => {
  assert.equal(tokensMatch(TOKEN, TOKEN), true);
  assert.equal(tokensMatch(wrongToken(1), TOKEN), false);
  assert.equal(tokensMatch('', ''), false);
  assert.equal(tokensMatch(undefined, TOKEN), false);
  assert.equal(tokensMatch(`${TOKEN}x`, TOKEN), false);
});

test('Bearer and cookie sign in; a ?token= on an API or file URL does not', async () => {
  const relay = await startApp();
  try {
    const bearer = await relay.call('/api/status', { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(bearer.status, 200);
    assert.match(String(bearer.headers.get('set-cookie')), /copilot_auth=.*HttpOnly/);
    const cookie = await relay.call('/api/status', { headers: { Cookie: `${COOKIE}=${TOKEN}` } });
    assert.equal(cookie.status, 200);
    const query = await relay.call(`/api/status?token=${TOKEN}`);
    assert.equal(query.status, 401);
    const file = await relay.call(`/api/files/notes.md?token=${TOKEN}`, { headers: tunnel('203.0.113.9') });
    assert.equal(file.status, 401);
  } finally {
    await relay.close();
  }
});

test('ten wrong tokens lock the client out with 429 and Retry-After, the right token included', async () => {
  const clock = { now: 1_000_000 };
  const relay = await startApp({ clock });
  try {
    for (let index = 0; index < AUTH_FAILURE_LIMIT; index += 1) {
      const headers = { ...tunnel('203.0.113.9') };
      // Every way of presenting a token counts.
      if (index % 2) headers.Authorization = `Bearer ${wrongToken(index)}`;
      else headers.Cookie = `${COOKIE}=${wrongToken(index)}`;
      const response = await relay.call('/api/status', { headers });
      assert.equal(response.status, 401, `attempt ${index + 1}`);
    }
    const locked = await relay.call('/api/status', { headers: { ...tunnel('203.0.113.9'), Authorization: `Bearer ${TOKEN}` } });
    assert.equal(locked.status, 429);
    assert.equal(locked.headers.get('retry-after'), '60');
    const body = await locked.json();
    assert.equal(body.retryAfterSeconds, 60);
    assert.match(body.error, /Too many failed sign-in attempts/);

    // Another client is not affected.
    const other = await relay.call('/api/status', { headers: { ...tunnel('203.0.113.10'), Authorization: `Bearer ${TOKEN}` } });
    assert.equal(other.status, 200);

    clock.now += 30_000;
    const stillLocked = await relay.call('/api/status', { headers: { ...tunnel('203.0.113.9'), Authorization: `Bearer ${TOKEN}` } });
    assert.equal(stillLocked.status, 429);
    assert.equal(stillLocked.headers.get('retry-after'), '30');

    clock.now += 30_000;
    const after = await relay.call('/api/status', { headers: { ...tunnel('203.0.113.9'), Authorization: `Bearer ${TOKEN}` } });
    assert.equal(after.status, 200);
  } finally {
    await relay.close();
  }
});

test('the same stale value repeated, no token at all, and successful requests do not lock anyone out', async () => {
  const relay = await startApp();
  try {
    for (let index = 0; index < AUTH_FAILURE_LIMIT * 2; index += 1) {
      assert.equal((await relay.call('/api/status', { headers: { ...tunnel('203.0.113.9'), Cookie: `${COOKIE}=${wrongToken(1)}` } })).status, 401);
      assert.equal((await relay.call('/api/status', { headers: tunnel('203.0.113.9') })).status, 401);
      assert.equal((await relay.call('/api/status', { headers: { ...tunnel('203.0.113.9'), Authorization: `Bearer ${TOKEN}` } })).status, 200);
    }
  } finally {
    await relay.close();
  }
});

test('truly local requests are never locked out', async () => {
  const relay = await startApp();
  try {
    for (let index = 0; index < AUTH_FAILURE_LIMIT * 2; index += 1) {
      const response = await relay.call('/api/status', { headers: { Authorization: `Bearer ${wrongToken(index)}` } });
      assert.equal(response.status, 401);
    }
    assert.equal((await relay.call('/api/status', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    assert.equal(relay.relayAuth.lockout.size(), 0);
  } finally {
    await relay.close();
  }
});

test('the lockout keeps a bounded number of clients', () => {
  const lockout = createAuthFailureLockout({ maxClients: 8 });
  for (let index = 0; index < 100; index += 1) lockout.recordFailure(`198.51.100.${index}`, wrongToken(index));
  assert.ok(lockout.size() <= 8);
});

function fakeSocket({ peer = '127.0.0.1', headers = {}, auth = {}, query = {} } = {}) {
  return {
    request: { headers, socket: { remoteAddress: peer } },
    handshake: { auth, query },
  };
}

function runSocketMiddleware(relayAuth, socket) {
  let outcome = null;
  relayAuth.socketMiddleware(socket, (error) => { outcome = error || 'ok'; });
  return outcome;
}

test('socket handshake: auth.token or cookie, never query.token; wrong tokens count toward the lockout', async () => {
  const relay = await startApp();
  try {
    const { relayAuth } = relay;
    assert.equal(runSocketMiddleware(relayAuth, fakeSocket({ auth: { token: TOKEN } })), 'ok');
    assert.equal(runSocketMiddleware(relayAuth, fakeSocket({ headers: { cookie: `${COOKIE}=${TOKEN}` } })), 'ok');
    assert.equal(runSocketMiddleware(relayAuth, fakeSocket({ query: { token: TOKEN } })).message, 'Unauthorized');

    for (let index = 0; index < AUTH_FAILURE_LIMIT; index += 1) {
      const error = runSocketMiddleware(relayAuth, fakeSocket({ headers: tunnel('203.0.113.9'), auth: { token: wrongToken(index) } }));
      assert.equal(error.message, 'Unauthorized');
    }
    const locked = runSocketMiddleware(relayAuth, fakeSocket({ headers: tunnel('203.0.113.9'), auth: { token: TOKEN } }));
    assert.match(locked.message, /Too many failed sign-in attempts/);
    assert.equal(locked.data.retryAfterSeconds, 60);
    // The HTTP side shares the same count.
    assert.equal((await relay.call('/api/status', { headers: { ...tunnel('203.0.113.9'), Authorization: `Bearer ${TOKEN}` } })).status, 429);

    for (let index = 0; index < AUTH_FAILURE_LIMIT * 2; index += 1) {
      runSocketMiddleware(relayAuth, fakeSocket({ auth: { token: wrongToken(index) } }));
    }
    assert.equal(runSocketMiddleware(relayAuth, fakeSocket({ auth: { token: TOKEN } })), 'ok');
  } finally {
    await relay.close();
  }
});

function registerRoutes(calls) {
  return (app, relayAuth) => registerMessagesRoutes(app, makeRouteDeps({
    auth: relayAuth.auth,
    io: { emit() {} },
    stmts: { listQueueForPauseDrop: { all: () => [] } },
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    requestRelayShutdown: (args) => { calls.push(['shutdown', args]); return { accepted: true, status: 'queued' }; },
    cancelRelayShutdown: (args) => { calls.push(['cancel', args]); return { cancelled: true }; },
    featureFlags: { IMAGE_CONVERSATION_CONTINUITY_ENABLED: false },
  }));
}

test('restart, cancel restart and empty queue need the token and nothing else', async () => {
  const calls = [];
  const relay = await startApp({ routes: registerRoutes(calls) });
  try {
    const routes = ['/api/relay/shutdown', '/api/relay/shutdown/cancel', '/api/queue/empty'];
    for (const route of routes) {
      const refused = await relay.call(route, { method: 'POST', headers: tunnel('203.0.113.9'), body: {} });
      assert.equal(refused.status, 401, `${route} without a token`);
      const remote = await relay.call(route, {
        method: 'POST',
        headers: { ...tunnel('203.0.113.9'), Authorization: `Bearer ${TOKEN}` },
        body: { restart: true, requestedBy: 'phone' },
      });
      assert.equal(remote.status, 200, `${route} over the tunnel with the token`);
      assert.equal((await remote.json()).ok, true);
    }
    assert.deepEqual(calls.map(([kind]) => kind), ['shutdown', 'cancel']);
    assert.equal(calls[0][1].restart, true);
  } finally {
    await relay.close();
  }
});

test('image-operation execute is refused through a proxy or the tunnel, local calls pass the boundary', async () => {
  const relay = await startApp({ routes: registerRoutes([]) });
  try {
    const route = '/api/image-operations/img_op_demo/execute';
    const auth = { Authorization: `Bearer ${TOKEN}` };
    for (const headers of [tunnel('203.0.113.9'), { 'cf-ray': 'ray' }, { 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { 'x-real-ip': '203.0.113.9' }]) {
      const response = await relay.call(route, { method: 'POST', headers: { ...auth, ...headers }, body: {} });
      assert.equal(response.status, 403, JSON.stringify(headers));
    }
    // Past the boundary: the feature flag answers.
    const local = await relay.call(route, { method: 'POST', headers: auth, body: {} });
    assert.equal(local.status, 404);
    assert.match((await local.json()).error, /not enabled/);
  } finally {
    await relay.close();
  }
});
