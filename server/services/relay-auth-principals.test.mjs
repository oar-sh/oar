import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

import { AUTH_FAILURE_LIMIT, createAuthFailureLockout, createRelayAuth } from './relay-auth.mjs';
import { createOwnerSecretStore } from './owner-secret-store.mjs';
import { createBrowserSessionService, createSignInCodes } from './browser-session-service.mjs';
import { migrateBrowserSessions } from '../migrations/0041-browser-sessions.mjs';
import { createLocalRequestCheck } from './request-boundary.mjs';
import { isPerson, principalOf } from './relay-principal.mjs';
import { registerMessagesRoutes } from '../routes/messages-routes.mjs';
import { registerConversationGroupRoutes } from '../routes/conversation-group-routes.mjs';
import { AUTH_TERMINAL_ONLY_CODE, registerAuthRoutes } from '../routes/auth-routes.mjs';
import { makeRouteDeps } from '../routes/messages-routes-test-harness.mjs';
import { RELAY_ROUTE_POLICY, ROUTE_ACCESS } from '../../shared/relay-route-policy.mjs';
import { BROWSER_SESSION_PREFIX, PEER_KEY_PREFIX } from '../../shared/relay-credentials.mjs';

// Yes/no on values that hold a credential: a failure never prints it.
const matchSecret = (value, pattern, message) => assert.ok(pattern.test(String(value)), message || `expected ${pattern}`);

// The principal resolver, the route policy, CSRF and the host-local script
// path (agent auth §10: 1-4, 6, 8, 10, 10a, 19 and the mixed-version owner
// token). Every credential here is made at run time and never printed. A
// browser holds a session cookie (oars1_), made by the sign-in exchange;
// the cookie is never the owner token (relay-auth-sessions.test.mjs covers
// browsers from before sessions).

const COOKIE = 'copilot_auth';
const LEGACY_TOKEN = crypto.randomUUID();
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

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

// A browser over the built-in tunnel: not local, so the lockout counts.
function tunnel(clientIp) {
  return { 'cf-ray': '8a1b2c3d4e5f6789-AMS', 'x-forwarded-for': clientIp };
}

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-relay-auth-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ authToken: LEGACY_TOKEN, port: 3333 }));
  const store = createOwnerSecretStore({ dataDir: path.join(dir, 'data'), logger: { log() {}, warn() {} } });
  store.bootstrap({ config: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath });
  return { store, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = 'GET', headers = {}, body } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { call, close: () => new Promise((resolve) => server.close(resolve)) };
}

function makeSessions() {
  const db = new Database(':memory:');
  migrateBrowserSessions(db);
  return createBrowserSessionService({ db, logger: { log() {}, warn() {} } });
}

function buildAuth(app, store, { lockout = createAuthFailureLockout(), logger = { warn() {}, log() {} }, browserSessions = makeSessions(), afterPrincipal } = {}) {
  return createRelayAuth({
    ...(afterPrincipal ? { afterPrincipal } : {}),
    app,
    verifyOwnerToken: (value) => store.verifyOwnerToken(value),
    verifyAgentToken: (value) => store.verifyAgentToken(value),
    browserSessions,
    signInCodes: createSignInCodes(),
    cookieName: COOKIE,
    parseCookies,
    appendSetCookie,
    localRequestCheck: createLocalRequestCheck(),
    lockout,
    logger,
  });
}

// Every route the policy lists, as a stub that says who called.
function samplePath(pattern) {
  return pattern
    .replace('{*splat}', 'some/file.txt')
    .replace(/:([A-Za-z]+)/g, (_match, name) => `sample-${name}`);
}

async function startPolicyApp(store, options = {}) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const relayAuth = buildAuth(app, store, options);
  app.post('/api/auth/session', relayAuth.signIn);
  for (const key of RELAY_ROUTE_POLICY.keys()) {
    const [method, pattern] = key.split(' ');
    app[method.toLowerCase()](pattern, relayAuth.auth, (req, res) => {
      // The billing switch re-dispatches with Object.create(req).
      const derived = Object.create(req);
      res.json({ ok: true, kind: principalOf(req)?.kind || null, derivedKind: principalOf(derived)?.kind || null, person: isPerson(derived) });
    });
  }
  return { relayAuth, ...(await listen(app)) };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// The browser's sign-in: the owner token for a session cookie and its proof
// key (§4.4); the page sends both.
async function sessionCookie(relay, token = LEGACY_TOKEN) {
  const answer = await relay.call('/api/auth/session', { method: 'POST', headers: { ...bearer(token), 'Sec-Fetch-Site': 'same-origin' }, body: { deviceId: 'dev-test' } });
  assert.equal(answer.status, 200);
  const cookie = String(answer.headers.get('set-cookie') || '').split(';')[0];
  matchSecret(cookie, /^copilot_auth=oars1_/);
  const { proof } = await answer.json();
  matchSecret(proof, /^oark1_/);
  return { Cookie: cookie, 'X-OAR-Session-Proof': proof };
}

test('prefix dispatch: owner (legacy and oaro1_), session and cli agent tokens; a wrong value of each kind counts once', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  try {
    const agentToken = store.mintAgentToken({ kind: 's', subject: 'conv-a' });
    const cliToken = store.mintAgentToken({ kind: 'c' });
    const owner = await relay.call('/api/status', { headers: bearer(LEGACY_TOKEN) });
    assert.equal(owner.status, 200);
    assert.deepEqual(await owner.json(), { ok: true, kind: 'owner', derivedKind: 'owner', person: true });
    const agent = await relay.call('/api/status', { headers: bearer(agentToken) });
    assert.equal((await agent.json()).kind, 'agent');
    assert.equal((await (await relay.call('/api/status', { headers: bearer(cliToken) })).json()).kind, 'agent');
    // Values of the reserved kinds are not accepted as Bearer (yet).
    const fakeSession = `${BROWSER_SESSION_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    const fakePeer = `${PEER_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    assert.equal((await relay.call('/api/status', { headers: bearer(fakeSession) })).status, 401);
    assert.equal((await relay.call('/api/status', { headers: bearer(fakePeer) })).status, 401);
    // A rotated token is an oaro1_ value, and is the owner too.
    const { token: rotated } = store.rotateOwnerToken({ reason: 'test' });
    assert.equal((await (await relay.call('/api/status', { headers: bearer(rotated) })).json()).kind, 'owner');
  } finally {
    await relay.close();
    cleanup();
  }

  // The lockout: distinct wrong values of every kind count; one value once.
  const second = makeStore();
  const clock = { now: 1_000_000 };
  const locked = await startPolicyApp(second.store, { lockout: createAuthFailureLockout({ nowMs: () => clock.now }) });
  try {
    const goodAgent = second.store.mintAgentToken({ kind: 's', subject: 'conv-a' });
    const wrongValues = [];
    for (let index = 0; wrongValues.length < AUTH_FAILURE_LIMIT; index += 1) {
      const kind = index % 4;
      if (kind === 0) wrongValues.push(crypto.randomUUID());
      if (kind === 1) wrongValues.push(`oaro1_${crypto.randomBytes(32).toString('base64url')}`);
      if (kind === 2) wrongValues.push(`${goodAgent.slice(0, -3)}${index.toString().padStart(3, '0')}`);
      if (kind === 3) wrongValues.push(`${BROWSER_SESSION_PREFIX}${crypto.randomBytes(32).toString('base64url')}`);
    }
    // The same wrong value repeated counts once.
    for (let repeat = 0; repeat < 5; repeat += 1) {
      assert.equal((await locked.call('/api/status', { headers: { ...tunnel('203.0.113.9'), ...bearer(wrongValues[0]) } })).status, 401);
    }
    for (const value of wrongValues.slice(1)) {
      assert.equal((await locked.call('/api/status', { headers: { ...tunnel('203.0.113.9'), ...bearer(value) } })).status, 401);
    }
    const blocked = await locked.call('/api/status', { headers: { ...tunnel('203.0.113.9'), ...bearer(LEGACY_TOKEN) } });
    assert.equal(blocked.status, 429, 'ten distinct wrong values of mixed kinds lock the address');
  } finally {
    await locked.close();
    second.cleanup();
  }
});

test('a check after sign-in that throws refuses the request with 500; it never lets it through', async () => {
  const { store, cleanup } = makeStore();
  const lines = [];
  let calls = 0;
  const relay = await startPolicyApp(store, {
    logger: { warn: (line) => lines.push(String(line)), log() {} },
    afterPrincipal: () => {
      calls += 1;
      throw new Error('the key index is broken (test)');
    },
  });
  try {
    const answer = await relay.call('/api/status', { headers: bearer(LEGACY_TOKEN) });
    assert.equal(answer.status, 500);
    const body = await answer.json();
    assert.equal(body.ok, undefined, 'the route never ran');
    assert.equal(calls, 1);
    assert.equal(lines.some((line) => /check after sign-in failed/.test(line)), true);
    assert.equal(lines.some((line) => line.includes(LEGACY_TOKEN)), false, 'no token in the log');
  } finally {
    await relay.close();
    cleanup();
  }
});

test('a tampered agent token gets 401', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  try {
    const token = store.mintAgentToken({ kind: 's', subject: 'conv-a' });
    const otherSubject = token.replace(/^(oara1_s\.)[^.]+/, (_match, prefix) => `${prefix}${Buffer.from('conv-b').toString('base64url')}`);
    // A character in the middle of the MAC: every one of its six bits counts.
    const middle = token.length - 20;
    const otherMac = `${token.slice(0, middle)}${token[middle] === 'A' ? 'B' : 'A'}${token.slice(middle + 1)}`;
    // The MAC's last character with one of its two unused bits set: the same
    // bytes, another spelling.
    const lastValue = BASE64URL.indexOf(token.at(-1));
    assert.equal(lastValue & 3, 0, 'a minted MAC is canonical');
    const nonCanonical = `${token.slice(0, -1)}${BASE64URL[lastValue | 1]}`;
    assert.deepEqual(Buffer.from(nonCanonical.split('.').at(-1), 'base64url'), Buffer.from(token.split('.').at(-1), 'base64url'));
    for (const tampered of [otherSubject, otherMac, nonCanonical, token.replace('oara1_s.', 'oara1_c.')]) {
      assert.equal((await relay.call('/api/status', { headers: bearer(tampered) })).status, 401, tampered === nonCanonical ? 'non-canonical MAC' : 'tampered');
    }
    assert.equal((await relay.call('/api/status', { headers: bearer(token) })).status, 200, 'the token itself still passes');
  } finally {
    await relay.close();
    cleanup();
  }
});

test('principalOf(Object.create(req)) keeps the principal (the billing re-dispatch)', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  try {
    const agent = await relay.call('/api/conversation/sample-id/billing', { method: 'POST', headers: bearer(store.mintAgentToken({ kind: 's', subject: 'c' })), body: {} });
    assert.deepEqual(await agent.json(), { ok: true, kind: 'agent', derivedKind: 'agent', person: false });
  } finally {
    await relay.close();
    cleanup();
  }
});

test('an agent token is refused on every person-only route, without x-oar-remote-origin; the owner passes all of them', async () => {
  const { store, cleanup } = makeStore();
  const logs = [];
  const relay = await startPolicyApp(store, { logger: { warn: (line) => logs.push(String(line)) } });
  try {
    const agentToken = store.mintAgentToken({ kind: 's', subject: 'conv-a' });
    let denied = 0;
    for (const [key, policy] of RELAY_ROUTE_POLICY) {
      const [method, pattern] = key.split(' ');
      const route = samplePath(pattern);
      const body = method === 'GET' ? undefined : {};
      const asAgent = await relay.call(route, { method, headers: bearer(agentToken), body });
      if (policy.agent === ROUTE_ACCESS.deny) {
        denied += 1;
        assert.equal(asAgent.status, 403, key);
        const answer = await asAgent.json();
        assert.equal(answer.code, 'AUTH_PERSON_REQUIRED', key);
      } else {
        assert.equal(asAgent.status, 200, key);
      }
      const asOwner = await relay.call(route, { method, headers: bearer(LEGACY_TOKEN), body });
      assert.equal(asOwner.status, 200, `${key} as the owner`);
    }
    assert.ok(denied > 100, `only ${denied} person-only routes`);
    // Refusals are logged, rate-limited per route, and never name the token.
    assert.ok(logs.some((line) => /\[auth\] agent refused: POST \/api\/relay-question\/:id\/answer/.test(line)));
    assert.ok(logs.every((line) => !line.includes(agentToken)));
  } finally {
    await relay.close();
    cleanup();
  }
});

test('CSRF: a cookie write from a same-site or cross-site page, or a foreign Origin, gets 403; same-origin and Bearer pass', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  try {
    const cookie = await sessionCookie(relay);
    const write =(headers) => relay.call('/api/message', { method: 'POST', headers: { ...cookie, ...headers }, body: {} });
    // A preview on another port of this host is same-site, and gets the cookie.
    const preview = await write({ 'Sec-Fetch-Site': 'same-site', Origin: 'http://127.0.0.1:5173' });
    assert.equal(preview.status, 403);
    assert.equal((await preview.json()).code, 'AUTH_CROSS_SITE');
    assert.equal((await write({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await write({ Origin: 'https://evil.example' })).status, 403, 'a foreign Origin without Sec-Fetch-Site');
    // The relay's own page.
    assert.equal((await write({ 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    // Neither header: not a browser, not CSRF.
    assert.equal((await write({})).status, 200);
    // Reads are not checked.
    assert.equal((await relay.call('/api/status', { headers: { ...cookie, 'Sec-Fetch-Site': 'same-site' } })).status, 200);
    // A Bearer is not sent by a foreign page: unaffected.
    assert.equal((await relay.call('/api/message', { method: 'POST', headers: { ...bearer(LEGACY_TOKEN), 'Sec-Fetch-Site': 'same-site' }, body: {} })).status, 200);
  } finally {
    await relay.close();
    cleanup();
  }
});

test('CSRF across relays on one domain: a write from a sibling host (same-site) is refused', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  try {
    const cookie = await sessionCookie(relay);
    const sibling = await relay.call('/api/relay-question/sample-id/answer', {
      method: 'POST',
      headers: {
        ...cookie,
        Host: 'a.example.com',
        Origin: 'https://b.example.com',
        'Sec-Fetch-Site': 'same-site',
      },
      body: { answer: 'yes' },
    });
    assert.equal(sibling.status, 403);
    assert.equal((await sibling.json()).code, 'AUTH_CROSS_SITE');
  } finally {
    await relay.close();
    cleanup();
  }
});

test('the cookie is host-only; Secure behind a trusted TLS proxy, not on LAN http', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  const signIn = (headers) => relay.call('/api/auth/session', { method: 'POST', headers: { ...bearer(LEGACY_TOKEN), ...headers }, body: { deviceId: 'd' } });
  try {
    // Through a trusted proxy on loopback that terminated TLS.
    const proxied = await signIn({ 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.7' });
    const proxiedCookie = String(proxied.headers.get('set-cookie'));
    matchSecret(proxiedCookie, /^copilot_auth=oars1_/);
    matchSecret(proxiedCookie, /HttpOnly/);
    matchSecret(proxiedCookie, /SameSite=Lax/);
    matchSecret(proxiedCookie, /; Secure/);
    assert.doesNotMatch(proxiedCookie, /Domain=/i);
    // Plain http straight to the relay.
    const plain = await signIn({});
    const plainCookie = String(plain.headers.get('set-cookie'));
    matchSecret(plainCookie, /^copilot_auth=oars1_/);
    assert.doesNotMatch(plainCookie, /Secure/);
    assert.doesNotMatch(plainCookie, /Domain=/i);
    // A script's Bearer request gets no cookie at all (no Sec-Fetch-Site).
    const script = await relay.call('/api/status', { headers: bearer(LEGACY_TOKEN) });
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('set-cookie'), null);
    // An agent token never gets a cookie.
    const agent = await relay.call('/api/status', { headers: { ...bearer(store.mintAgentToken({ kind: 's', subject: 'c' })), 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(agent.headers.get('set-cookie'), null);
  } finally {
    await relay.close();
    cleanup();
  }

  // LAN http: the client is not a trusted proxy, so its X-Forwarded-Proto is ignored.
  const lan = makeStore();
  const app = express();
  app.set('trust proxy', '10.255.255.1');
  app.use(express.json());
  const relayAuth = buildAuth(app, lan.store);
  app.post('/api/auth/session', relayAuth.signIn);
  const server = await listen(app);
  try {
    const spoofed = await server.call('/api/auth/session', { method: 'POST', headers: { ...bearer(LEGACY_TOKEN), 'X-Forwarded-Proto': 'https' }, body: { deviceId: 'd' } });
    assert.equal(spoofed.status, 200);
    matchSecret(String(spoofed.headers.get('set-cookie')), /^copilot_auth=oars1_/);
    assert.doesNotMatch(String(spoofed.headers.get('set-cookie')), /Secure/);
  } finally {
    await server.close();
    lan.cleanup();
  }
});

test('a script with no credential is told to use OAR_AGENT_TOKEN; a browser gets the plain answer', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  try {
    for (const headers of [{}, { Authorization: 'Bearer ' }, { Authorization: 'Bearer' }]) {
      const answer = await relay.call('/api/relay/shutdown', { method: 'POST', headers, body: { restart: true } });
      assert.equal(answer.status, 401, JSON.stringify(headers));
      const body = await answer.json();
      assert.equal(body.error, 'The relay token is no longer in the config; use OAR_AGENT_TOKEN');
    }
    const browser = await relay.call('/api/status', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(browser.status, 401);
    assert.equal((await browser.json()).error, 'Unauthorized');
  } finally {
    await relay.close();
    cleanup();
  }
});

test('Socket.IO: the owner token connects; an agent token is refused and not counted as a guess', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  try {
    const run = (socket) => {
      let outcome = null;
      relay.relayAuth.socketMiddleware(socket, (error) => { outcome = error || 'ok'; });
      return outcome;
    };
    const fakeSocket = (auth, headers = {}) => ({ request: { headers, socket: { remoteAddress: '127.0.0.1' } }, handshake: { auth, query: {} } });
    assert.equal(run(fakeSocket({ token: LEGACY_TOKEN })), 'ok');
    const session = await sessionCookie(relay);
    const browserSocket = fakeSocket({ proof: session['X-OAR-Session-Proof'] }, { cookie: session.Cookie });
    assert.equal(run(browserSocket), 'ok');
    assert.equal(browserSocket.data.principal.kind, 'browser');
    assert.match(browserSocket.data.browserSessionId, /^bs_/);
    const agentToken = store.mintAgentToken({ kind: 's', subject: 'conv-a' });
    const refused = run(fakeSocket({ token: agentToken }, tunnel('203.0.113.9')));
    assert.equal(refused.message, 'Unauthorized');
    assert.equal(refused.data.code, 'AUTH_PERSON_REQUIRED');
    assert.equal(relay.relayAuth.lockout.size(), 0, 'a genuine agent token is not a wrong guess');
  } finally {
    await relay.close();
    cleanup();
  }
});

test('rotation: the old token is 401 at once (Bearer and cookie), the new one works, agents keep working', async () => {
  const { store, cleanup } = makeStore();
  const relay = await startPolicyApp(store);
  try {
    const agentToken = store.mintAgentToken({ kind: 's', subject: 'conv-a' });
    const session = await sessionCookie(relay);
    // An old peer or script still calls with the owner token (and the remote header): owner, until rotation.
    const oldPeer = { ...bearer(LEGACY_TOKEN), 'x-oar-remote-origin': 'instance-old-peer' };
    assert.equal((await relay.call('/api/conversations', { headers: oldPeer })).status, 200);
    const { token } = store.rotateOwnerToken({ reason: 'test' });
    assert.equal((await relay.call('/api/status', { headers: bearer(LEGACY_TOKEN) })).status, 401);
    const cookieAfter = await relay.call('/api/status', { headers: { Cookie: `${COOKIE}=${LEGACY_TOKEN}` } });
    assert.equal(cookieAfter.status, 401);
    matchSecret(String(cookieAfter.headers.get('set-cookie')), /copilot_auth=;.*Max-Age=0/, 'the stale cookie is cleared');
    assert.equal((await relay.call('/api/conversations', { headers: oldPeer })).status, 401, 'a clear 401 for the old peer');
    assert.equal((await relay.call('/api/status', { headers: bearer(token) })).status, 200);
    assert.equal((await relay.call('/api/status', { headers: bearer(agentToken) })).status, 200, 'agent tokens survive a rotation');
    assert.equal((await relay.call('/api/status', { headers: session })).status, 200, 'browser sessions survive a rotation');
  } finally {
    await relay.close();
    cleanup();
  }
});

// ─── 10a: host-local scripts with OAR_AGENT_TOKEN ────────────────────────────

function fakeGroups() {
  const groups = new Map([['grp-existing', { id: 'grp-existing', name: 'Release', agent_made: 0 }]]);
  const membership = new Map();
  const calls = [];
  return {
    calls,
    enabled: true,
    getGroup: (id) => groups.get(id) || null,
    groupOfConversation: (id) => (membership.get(id) ? groups.get(membership.get(id)) : null),
    setMembership: (conversationId, groupId, _now, options = {}) => {
      calls.push({ conversationId, groupId, options });
      if (groupId && !groups.has(groupId)) return { ok: false, error: 'group-not-found' };
      const previousGroupId = membership.get(conversationId) || null;
      if (groupId) membership.set(conversationId, groupId);
      else membership.delete(conversationId);
      return { ok: true, changed: previousGroupId !== groupId, previousGroupId };
    },
    moveConversation: () => ({ ok: true, changed: true, order: [] }),
    describeGroup: (id) => ({ id }),
    orderOf: () => [],
    membershipsOf: () => ({}),
    positionsOf: () => ({}),
    membersOf: () => [],
    listGroups: () => [...groups.values()],
    createGroup: () => { throw new Error('agents never create groups here'); },
  };
}

test('host-local script path: group moves and the queued restart work with OAR_AGENT_TOKEN; restart now, shutdown and settings writes are 403', async () => {
  const { store, cleanup } = makeStore();
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const relayAuth = buildAuth(app, store);
  const shutdowns = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => { logs.push(parts.join(' ')); };
  const groups = fakeGroups();
  try {
    registerMessagesRoutes(app, makeRouteDeps({
      auth: relayAuth.auth,
      io: { emit() {} },
      stmts: { listQueueForPauseDrop: { all: () => [] } },
      queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
      requestRelayShutdown: (args) => { shutdowns.push(args); return { accepted: true, status: 'queued' }; },
      cancelRelayShutdown: () => ({ cancelled: true }),
      featureFlags: { IMAGE_CONVERSATION_CONTINUITY_ENABLED: false },
    }));
    registerConversationGroupRoutes(app, { auth: relayAuth.auth, io: { emit() {} }, conversationGroups: groups, remoteRelayInbound: null });
    app.post('/api/settings/openai', relayAuth.auth, (_req, res) => res.json({ ok: true }));
    const relay = await listen(app);
    try {
      const agentToken = store.mintAgentToken({ kind: 's', subject: 'conv-deploy' });
      const asScript = bearer(agentToken);

      const moved = await relay.call('/api/conversation/conv-1/group', { method: 'PUT', headers: asScript, body: { groupId: 'grp-existing' } });
      assert.equal(moved.status, 200, await moved.clone().text());
      assert.deepEqual(groups.calls.at(-1), { conversationId: 'conv-1', groupId: 'grp-existing', options: { keepOwnerGroups: true } });
      const unknown = await relay.call('/api/conversation/conv-1/group', { method: 'PUT', headers: asScript, body: { groupId: 'grp-new' } });
      assert.equal(unknown.status, 404, 'a group that does not exist is refused for agents');
      const out = await relay.call('/api/conversation/conv-1/group', { method: 'DELETE', headers: asScript });
      assert.equal(out.status, 200);
      const create = await relay.call('/api/conversation-groups', { method: 'POST', headers: asScript, body: { name: 'New', conversationIds: ['conv-1'] } });
      assert.equal(create.status, 403, 'creating a group is the person\'s');

      const queued = await relay.call('/api/relay/shutdown', { method: 'POST', headers: asScript, body: { restart: true, reason: 'approved deploy' } });
      assert.equal(queued.status, 200);
      assert.deepEqual(shutdowns.map((args) => [args.restart, args.immediate, args.reason]), [[true, false, 'approved deploy']]);
      assert.ok(logs.some((line) => line === '[auth] agent restart queued by conv-deploy: approved deploy'), logs.join('\n'));
      assert.ok(logs.every((line) => !line.includes(agentToken)));

      for (const body of [{ restart: true, immediate: true, reason: 'now' }, { reason: 'plain shutdown' }, { restart: true, expectRequestedAt: '2026-01-01T00:00:00.000Z', reason: 'x' }]) {
        const refused = await relay.call('/api/relay/shutdown', { method: 'POST', headers: asScript, body });
        assert.equal(refused.status, 403, JSON.stringify(body));
        assert.equal((await refused.json()).code, 'AUTH_PERSON_REQUIRED');
      }
      assert.equal(shutdowns.length, 1, 'nothing else reached the restart queue');
      // platform-agnostic: an HTTP route, not a file path.
      assert.equal((await relay.call('/api/relay/shutdown/cancel', { method: 'POST', headers: asScript, body: {} })).status, 200, '/cancel stays open');

      const settings = await relay.call('/api/settings/openai', { method: 'POST', headers: asScript, body: { model: 'x' } });
      assert.equal(settings.status, 403);

      const empty = await relay.call('/api/relay/shutdown', { method: 'POST', headers: { Authorization: 'Bearer ' }, body: { restart: true } });
      assert.equal(empty.status, 401);
      assert.match((await empty.json()).error, /use OAR_AGENT_TOKEN/);

      // The person may do all of it.
      const now = await relay.call('/api/relay/shutdown', { method: 'POST', headers: bearer(LEGACY_TOKEN), body: { restart: true, immediate: true } });
      assert.equal(now.status, 200);
      assert.equal(shutdowns.at(-1).immediate, true);
    } finally {
      await relay.close();
    }
  } finally {
    console.log = originalLog;
    cleanup();
  }
});

test('the oar CLI\'s own token may stop the relay and restart it now, over loopback only, and that is logged', async () => {
  const { store, cleanup } = makeStore();
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const relayAuth = buildAuth(app, store);
  const shutdowns = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...parts) => { logs.push(parts.join(' ')); };
  try {
    registerMessagesRoutes(app, makeRouteDeps({
      auth: relayAuth.auth,
      io: { emit() {} },
      stmts: { listQueueForPauseDrop: { all: () => [] } },
      queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
      requestRelayShutdown: (args) => { shutdowns.push(args); return { accepted: true, status: 'started' }; },
      cancelRelayShutdown: () => ({ cancelled: true }),
      // The real check: a proxy or tunnel header makes a request not local.
      isTrulyLocalRequest: createLocalRequestCheck().isTrulyLocal,
      featureFlags: { IMAGE_CONVERSATION_CONTINUITY_ENABLED: false },
    }));
    const relay = await listen(app);
    try {
      const cli = bearer(store.mintAgentToken({ kind: 'c' }));
      const bodies = [
        { body: { restart: false, reason: 'oar-cli' }, action: 'stop' },
        { body: { restart: false, immediate: true, reason: 'oar-cli' }, action: 'stop-now' },
        { body: { restart: true, immediate: true, reason: 'oar-cli' }, action: 'restart-now' },
      ];
      for (const { body, action } of bodies) {
        const answer = await relay.call('/api/relay/shutdown', { method: 'POST', headers: cli, body });
        assert.equal(answer.status, 200, action);
        assert.ok(logs.includes(`[auth] cli stop/restart-now: oar-cli (${action})`), logs.join('\n'));
      }
      assert.deepEqual(shutdowns.map((args) => [args.restart, args.immediate]), [[false, false], [false, true], [true, true]]);
      // Through the tunnel the same token is refused.
      const tunnelled = await relay.call('/api/relay/shutdown', { method: 'POST', headers: { ...cli, ...tunnel('203.0.113.9') }, body: { restart: true, immediate: true, reason: 'x' } });
      assert.equal(tunnelled.status, 403);
      // Loopback means really local: a same-host reverse proxy connects from
      // 127.0.0.1 too, so any one forwarding header makes the stop a 403.
      for (const [name, value] of [
        ['X-Forwarded-For', '203.0.113.9'],
        ['Forwarded', 'for=203.0.113.9;proto=https'],
        ['X-Real-IP', '203.0.113.9'],
        ['X-Forwarded-Proto', 'https'],
      ]) {
        for (const body of [{ restart: false, reason: 'x' }, { restart: true, immediate: true, reason: 'x' }]) {
          const proxied = await relay.call('/api/relay/shutdown', { method: 'POST', headers: { ...cli, [name]: value }, body });
          assert.equal(proxied.status, 403, `${name} ${JSON.stringify(body)}`);
          const answer = await proxied.json();
          assert.match(answer.error, /only straight over loopback/);
          assert.match(answer.error, /POST \/api\/relay\/shutdown with \{ "restart": true, "reason": "\.\.\." \}/);
        }
      }
      // A session's token keeps the queued restart only, even over loopback,
      // and the refusal names the call it may make.
      const session = bearer(store.mintAgentToken({ kind: 's', subject: 'conv-a' }));
      for (const body of [{ restart: false }, { restart: true, immediate: true }]) {
        const refused = await relay.call('/api/relay/shutdown', { method: 'POST', headers: session, body });
        assert.equal(refused.status, 403, JSON.stringify(body));
        const answer = await refused.json();
        assert.match(answer.error, /queued restart only/);
        assert.match(answer.error, /POST \/api\/relay\/shutdown with \{ "restart": true, "reason": "\.\.\." \}/);
      }
      assert.equal(shutdowns.length, 3);
    } finally {
      await relay.close();
    }
  } finally {
    console.log = originalLog;
    cleanup();
  }
});

test('the terminal sign-in code route: the cli token straight over loopback only (§13.1, 2c)', async () => {
  const { store, cleanup } = makeStore();
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const sessions = makeSessions();
  const codes = createSignInCodes();
  const peerKey = `${PEER_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const logs = [];
  const logger = { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) };
  const relayAuth = createRelayAuth({
    app,
    verifyOwnerToken: (value) => store.verifyOwnerToken(value),
    verifyAgentToken: (value) => store.verifyAgentToken(value),
    resolvePeerKey: (value) => (value === peerKey ? { entryId: 'peer-1', relayId: 'relay-peer', name: 'Peer' } : null),
    browserSessions: sessions,
    signInCodes: codes,
    cookieName: COOKIE,
    parseCookies,
    appendSetCookie,
    localRequestCheck: createLocalRequestCheck(),
    logger,
  });
  registerAuthRoutes(app, {
    auth: relayAuth.auth,
    relayAuth,
    browserSessions: sessions,
    signInCodes: codes,
    ownerSecretStore: store,
    isTrulyLocalRequest: createLocalRequestCheck().isTrulyLocal,
    logger,
  });
  const relay = await listen(app);
  const route = '/api/auth/signin-codes/terminal';
  const post = (headers) => relay.call(route, { method: 'POST', headers, body: {} });
  try {
    const cli = bearer(store.mintAgentToken({ kind: 'c' }));
    // ✓ the cli kind over loopback: a code and its expiry, nothing else.
    const made = await post(cli);
    assert.equal(made.status, 200);
    const answer = await made.json();
    matchSecret(answer.code, /^oarc1_/);
    assert.deepEqual(Object.keys(answer).sort(), ['code', 'expiresAt']);
    assert.equal(made.headers.get('cache-control'), 'no-store');
    assert.ok(logs.some((line) => /^\[auth\] a sign-in code was made by the oar command \(terminal, single use, until /.test(line)), logs.join('\n'));
    assert.ok(!logs.some((line) => line.includes(answer.code)), 'the log never holds the code');
    // ✗ any proxy header, an edge marker.
    for (const [name, value] of [
      ['X-Forwarded-For', '203.0.113.9'],
      ['Forwarded', 'for=203.0.113.9'],
      ['X-Real-IP', '203.0.113.9'],
      ['X-Forwarded-Proto', 'https'],
      ['cf-ray', '8a1b2c3d4e5f6789-AMS'],
    ]) {
      const proxied = await post({ ...cli, [name]: value });
      assert.equal(proxied.status, 403, name);
      assert.equal((await proxied.json()).code, 'AUTH_PERSON_REQUIRED', name);
    }
    // ✗ a session's agent token, over loopback too.
    const session = await post(bearer(store.mintAgentToken({ kind: 's', subject: 'conv-a' })));
    assert.equal(session.status, 403);
    assert.match((await session.json()).error, /Only the oar command/);
    // ✗ the owner token and a browser session: sent to Settings → Security.
    const owner = await post(bearer(LEGACY_TOKEN));
    assert.equal(owner.status, 403);
    const ownerAnswer = await owner.json();
    assert.equal(ownerAnswer.code, AUTH_TERMINAL_ONLY_CODE);
    assert.match(ownerAnswer.error, /Settings → Security/);
    const page = await sessionCookie(relay);
    const browser = await post({ ...page, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(browser.status, 403);
    assert.equal((await browser.json()).code, AUTH_TERMINAL_ONLY_CODE);
    // ✗ a paired relay's key: outside its routes.
    const peer = await post(bearer(peerKey));
    assert.equal(peer.status, 403);
    assert.equal((await peer.json()).code, 'REMOTE_RELAY_PEER_SCOPE');
    // No credential: 401.
    assert.equal((await post({})).status, 401);
    // The limit: 3 in 10 minutes (one made above).
    assert.equal((await post(cli)).status, 200);
    assert.equal((await post(cli)).status, 200);
    const limited = await post(cli);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally {
    await relay.close();
    cleanup();
  }
});
