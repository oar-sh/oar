import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

import { registerAuthRoutes, createSessionRevocationEffects, affectedRelaysOf, requestBaseUrl, signInLink, AUTH_NOTICE_IDS } from './auth-routes.mjs';
import { createRelayAuth } from '../services/relay-auth.mjs';
import { createOwnerSecretStore, OWNER_HASH_SETTING_KEY } from '../services/owner-secret-store.mjs';
import { createBrowserSessionService, createSignInCodes } from '../services/browser-session-service.mjs';
import { createLocalRequestCheck } from '../services/request-boundary.mjs';
import { migrateBrowserSessions } from '../migrations/0041-browser-sessions.mjs';
import { PUSH_SUBSCRIPTIONS_SCHEMA } from '../migrations/0003-push-subscriptions.mjs';
import { createPushDispatchService, NEW_SIGNIN_TAG } from '../services/push-dispatch-service.mjs';
import { createSignInNoticeService, signInNoticeRecipients, SIGNIN_NOTICE_SOCKET_EVENT } from '../services/signin-notice-service.mjs';
import { createOwnerTokenUseTracker } from '../services/owner-token-use.mjs';
import { qrMatrix, unpackQrBits } from '../services/qr-matrix.mjs';

// Yes/no on values that hold a credential: a failure never prints it.
const matchSecret = (value, pattern, message) => assert.ok(pattern.test(String(value)), message || `expected ${pattern}`);

// The session admin, sign-in code, rotation and notice routes (agent auth
// §4.6, §5; §10 tests 13, 15, 19, 20). Credentials are made at run time and
// never printed: assertions on them only say yes or no.
// platform-agnostic: every path here is an HTTP route, not a file path.

const COOKIE = 'copilot_auth';
const quiet = { log() {}, warn() {} };

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const key = part.slice(0, idx).trim();
      if (!(key in out)) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return out;
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, value) : value);
}

// Sockets as the runtime tags them; `disconnect` marks them.
function fakeSockets() {
  const sockets = [];
  return {
    sockets,
    add(data) {
      const socket = { data, disconnected: false, received: [], disconnect() { this.disconnected = true; }, emit(event, payload) { this.received.push({ event, payload }); } };
      sockets.push(socket);
      return socket;
    },
    disconnectSessions(ids) {
      const wanted = new Set(ids);
      let dropped = 0;
      for (const socket of sockets) {
        if (!socket.disconnected && wanted.has(socket.data.browserSessionId)) { socket.disconnect(); dropped += 1; }
      }
      return dropped;
    },
  };
}

// `dir` and `settings` carried over make a restart of the same relay;
// `argvToken` is a `--token` on its command line.
async function startRelay({ legacyToken = crypto.randomUUID(), paired = [], dir: reuseDir = null, settings: reuseSettings = null, argvToken = '' } = {}) {
  const dir = reuseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'oar-auth-routes-'));
  const configPath = path.join(dir, 'config.json');
  if (!reuseDir) fs.writeFileSync(configPath, JSON.stringify({ authToken: legacyToken }));
  const store = createOwnerSecretStore({ dataDir: path.join(dir, 'data'), logger: quiet });
  store.bootstrap({ config: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath, argvToken });
  const settings = reuseSettings || new Map();
  const readSetting = (key) => settings.get(key) ?? null;
  const writeSetting = (key, value) => settings.set(key, value);
  store.reconcileWithSettings({ readSetting, writeSetting });
  const db = new Database(':memory:');
  migrateBrowserSessions(db);
  const sessions = createBrowserSessionService({ db, logger: quiet });
  const codes = createSignInCodes();
  const sockets = fakeSockets();
  // Push rows by device id, as push_subscriptions keeps them.
  const push = new Map([['phone', 2], ['laptop', 1]]);
  const logs = [];
  const logger = { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) };
  // Web push as the runtime has it, with a push service that records what
  // was sent and when.
  const pushDb = new Database(':memory:');
  pushDb.exec(PUSH_SUBSCRIPTIONS_SCHEMA);
  pushDb.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT)');
  const pushSent = [];
  let pushSeq = 0;
  const pushService = createPushDispatchService({
    db: pushDb,
    webpush: { sendNotification: async (subscription, payload) => { pushSent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload) }); return { statusCode: 201 }; } },
    hasActiveDevice: () => true,
    uuid: () => `sub-${(pushSeq += 1)}`,
    logger: quiet,
  });
  const signInNotices = createSignInNoticeService({
    readSetting,
    writeSetting,
    // As the runtime: the person's sockets only (signInNoticeRecipients).
    emitToPersonSockets: (event, payload, { exceptSessionId }) => {
      let sent = 0;
      for (const socket of signInNoticeRecipients(sockets.sockets.filter((entry) => !entry.disconnected), { exceptSessionId })) {
        socket.emit(event, payload);
        sent += 1;
      }
      return sent;
    },
    notifyPush: (notice) => pushService.notifyNewSignIn({ ...notice, isLiveDevice: (deviceId) => sessions.hasLiveDevice(deviceId, { exceptId: notice.sessionId }) }),
    isSessionLive: (id) => !!sessions.get(id),
    logger,
  });
  const ownerTokenUse = createOwnerTokenUseTracker({
    readSetting,
    writeSetting,
    ownerHash: () => store.ownerTokenHash(),
    createdAt: () => store.status().createdAt,
    logger,
  });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const effects = createSessionRevocationEffects({
    browserSessions: sessions,
    disconnectBrowserSessions: (ids) => sockets.disconnectSessions(ids),
    deletePushDevicesForDevice: (deviceId) => { const n = push.get(deviceId) || 0; push.delete(deviceId); pushService.deleteDevicesForDevice(deviceId); return n; },
    logger,
  });
  sessions.setOnRemoved((rows) => effects(rows));
  const relayAuth = createRelayAuth({
    app,
    verifyOwnerToken: (value) => store.verifyOwnerToken(value),
    verifyAgentToken: (value) => store.verifyAgentToken(value),
    browserSessions: sessions,
    signInCodes: codes,
    onSessionsRevoked: (rows) => effects(rows),
    onSessionCreated: ({ row, via, address }) => signInNotices.record({ row, via, address }),
    onOwnerBearerUse: (use) => ownerTokenUse.record(use),
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
    // The public view carries `peerKeyConfirmed` (peer keys), never a token.
    remoteRelayRegistry: { list: () => paired, listPublic: () => paired.map(({ token: _token, ...rest }) => rest) },
    onSessionsRevoked: (rows) => effects(rows),
    readSetting,
    writeSetting,
    publicBaseUrl: () => 'https://relay.example.test/oar/',
    signInNotices,
    ownerTokenUse,
    qrMatrix,
    logger,
  });
  app.get('/api/status', relayAuth.auth, (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = 'GET', headers = {}, body } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  async function signIn(deviceId, { userAgent = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36' } = {}) {
    const answer = await call('/api/auth/session', { method: 'POST', headers: { Authorization: `Bearer ${legacyToken}`, 'User-Agent': userAgent }, body: { deviceId } });
    assert.equal(answer.status, 200);
    const cookie = String(answer.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(/^copilot_auth=oars1_/.test(cookie), 'a session cookie');
    const { session, proof } = await answer.json();
    assert.ok(/^oark1_/.test(proof), 'a proof key');
    // The relay's own page sends these: the cookie, the session's key, and
    // Sec-Fetch-Site on its writes.
    return { id: session.id, cookie, proof, headers: { Cookie: cookie, 'X-OAR-Session-Proof': proof, 'Sec-Fetch-Site': 'same-origin' } };
  }
  return {
    store, sessions, codes, sockets, push, logs, settings, legacyToken, relayAuth, call, signIn, readSetting, writeSetting, dir,
    pushService, pushSent, signInNotices, ownerTokenUse,
    close: async ({ keepDir = false } = {}) => {
      await new Promise((resolve) => server.close(resolve));
      if (!keepDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

test('13: list with "current", rename, revoke one (its requests, socket and push rows go), sign out all others (the current one stays)', async () => {
  const relay = await startRelay();
  try {
    const laptop = await relay.signIn('laptop');
    const phone = await relay.signIn('phone', { userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36' });
    const tablet = await relay.signIn('tablet');
    const phoneSocket = relay.sockets.add({ principal: { kind: 'browser' }, browserSessionId: phone.id });
    const laptopSocket = relay.sockets.add({ principal: { kind: 'browser' }, browserSessionId: laptop.id });

    const listed = await relay.call('/api/auth/sessions', { headers: laptop.headers });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    const { sessions, currentId } = await listed.json();
    assert.equal(currentId, laptop.id);
    assert.equal(sessions.length, 3);
    assert.deepEqual(sessions.filter((row) => row.current).map((row) => row.id), [laptop.id]);
    assert.equal(sessions.find((row) => row.id === phone.id).label, 'Chrome on Android');
    assert.ok(sessions.every((row) => row.authMethod === 'token' && row.lastIp && row.createdAt && row.lastSeenAt));
    assert.ok(!JSON.stringify(sessions).includes('oars1_'), 'no secret in the list');

    const renamed = await relay.call(`/api/auth/sessions/${phone.id}`, { method: 'PATCH', headers: laptop.headers, body: { label: 'Lost phone' } });
    assert.equal((await renamed.json()).session.label, 'Lost phone');
    assert.equal((await relay.call('/api/auth/sessions/bs_missing', { method: 'PATCH', headers: laptop.headers, body: { label: 'x' } })).status, 404);

    // Revoke the phone from the laptop.
    const revoked = await relay.call(`/api/auth/sessions/${phone.id}`, { method: 'DELETE', headers: laptop.headers });
    assert.equal(revoked.status, 200);
    const revokedBody = await revoked.json();
    assert.equal(revokedBody.current, false);
    assert.deepEqual(revokedBody.effects, { sockets: 1, pushDevices: 2 });
    const phoneAfter = await relay.call('/api/status', { headers: phone.headers });
    assert.equal(phoneAfter.status, 401);
    assert.equal((await phoneAfter.json()).code, 'AUTH_SIGNED_OUT');
    assert.equal(phoneSocket.disconnected, true, 'its socket is disconnected');
    assert.equal(laptopSocket.disconnected, false);
    assert.equal(relay.push.has('phone'), false, 'its push rows are gone');
    assert.ok(relay.logs.some((line) => line === `[auth] browser session ${phone.id} signed out by session ${laptop.id}.`));

    // "All others" keeps the current browser.
    const others = await relay.call('/api/auth/sessions', { method: 'DELETE', headers: laptop.headers });
    assert.deepEqual(await others.json(), { ok: true, revoked: 1, kept: laptop.id, effects: { sockets: 0, pushDevices: 0 } });
    assert.equal((await relay.call('/api/status', { headers: tablet.headers })).status, 401);
    assert.equal((await relay.call('/api/status', { headers: laptop.headers })).status, 200);
    assert.equal(relay.sessions.list().length, 1);
  } finally {
    await relay.close();
  }
});

test('push rows stay while another live session has the same device; sign out this browser clears its cookie', async () => {
  const relay = await startRelay();
  try {
    const first = await relay.signIn('laptop');
    const second = await relay.signIn('laptop', { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Firefox/132.0' });
    await relay.call(`/api/auth/sessions/${first.id}`, { method: 'DELETE', headers: second.headers });
    assert.equal(relay.push.get('laptop'), 1, 'the device is still signed in through the other session');

    const out = await relay.call('/api/auth/session', { method: 'DELETE', headers: second.headers });
    assert.equal(out.status, 200);
    assert.deepEqual(await out.json(), { ok: true, id: second.id });
    matchSecret(String(out.headers.get('set-cookie')), /^copilot_auth=; Path=\/; Max-Age=0/);
    assert.equal(relay.push.has('laptop'), false);
    assert.equal(relay.sessions.list().length, 0);
    assert.equal((await relay.call('/api/status', { headers: second.headers })).status, 401);
  } finally {
    await relay.close();
  }
});

test('session admin, sign-in codes, rotation and notices are refused to agents; cookie writes from another site are refused', async () => {
  const relay = await startRelay();
  try {
    const agent = bearer(relay.store.mintAgentToken({ kind: 's', subject: 'conv-a' }));
    const cli = bearer(relay.store.mintAgentToken({ kind: 'c' }));
    const routes = [
      ['GET', '/api/auth/sessions'], ['PATCH', '/api/auth/sessions/bs_x'], ['DELETE', '/api/auth/sessions/bs_x'],
      ['DELETE', '/api/auth/sessions'], ['DELETE', '/api/auth/session'], ['POST', '/api/auth/signin-codes'],
      ['GET', '/api/auth/owner-token'], ['POST', '/api/auth/owner-token/rotate'], ['GET', '/api/auth/notices'],
      ['POST', '/api/auth/notices/rotate-after-upgrade/dismiss'], ['POST', '/api/auth/notices/dismiss-signins'],
    ];
    for (const [method, route] of routes) {
      for (const headers of [agent, cli]) {
        const answer = await relay.call(route, { method, headers, body: method === 'GET' ? undefined : {} });
        assert.equal(answer.status, 403, `${method} ${route}`);
        assert.equal((await answer.json()).code, 'AUTH_PERSON_REQUIRED');
      }
    }
    assert.equal((await relay.call('/api/auth/session', { method: 'POST', headers: agent, body: {} })).status, 403, 'an agent cannot sign a browser in');
    assert.ok(relay.store.verifyOwnerToken(relay.legacyToken), 'nothing rotated');

    const browser = await relay.signIn('laptop');
    const sibling = await relay.call('/api/auth/owner-token/rotate', { method: 'POST', headers: { ...browser.headers, 'Sec-Fetch-Site': 'same-site', Origin: 'https://b.example.test' }, body: {} });
    assert.equal(sibling.status, 403);
    assert.equal((await sibling.json()).code, 'AUTH_CROSS_SITE');
    const crossCode = await relay.call('/api/auth/signin-codes', { method: 'POST', headers: { ...browser.headers, 'Sec-Fetch-Site': 'cross-site' }, body: {} });
    assert.equal(crossCode.status, 403);
    assert.ok(relay.store.verifyOwnerToken(relay.legacyToken), 'still nothing rotated');
  } finally {
    await relay.close();
  }
});

test('15: a sign-in code from the person signs one device in, once; the link carries ?signin=', async () => {
  const relay = await startRelay();
  try {
    const laptop = await relay.signIn('laptop');
    const made = await relay.call('/api/auth/signin-codes', { method: 'POST', headers: laptop.headers, body: {} });
    assert.equal(made.status, 200);
    assert.equal(made.headers.get('cache-control'), 'no-store');
    const { code, link, expiresAt } = await made.json();
    assert.ok(/^oarc1_[A-Za-z0-9_-]{43}$/.test(code), 'an oarc1_ code');
    assert.ok(link === `https://relay.example.test/oar/?signin=${code}`, 'the link carries the code');
    assert.ok(Math.abs(Date.parse(expiresAt) - Date.now() - 10 * 60_000) < 5000);
    assert.ok(relay.logs.some((line) => line.startsWith(`[auth] a sign-in code was made by session ${laptop.id}`)));
    assert.ok(relay.logs.every((line) => !line.includes(code)), 'the code is not logged');

    const phone = await relay.call('/api/auth/session', { method: 'POST', headers: bearer(code), body: { deviceId: 'phone' } });
    assert.equal(phone.status, 200);
    assert.equal(relay.sessions.list().find((row) => row.deviceId === 'phone').authMethod, 'code');
    assert.equal((await relay.call('/api/auth/session', { method: 'POST', headers: bearer(code), body: {} })).status, 401);
  } finally {
    await relay.close();
  }
});

test('19/20: rotation: the token once (no-store), the old one fails at once, sessions and agents keep working; every unkeyed paired relay is affected', async () => {
  const paired = [
    { id: 'relay-b', name: 'Linux box', url: 'https://b.example.test', tokenMode: 'custom', token: 'held-for-b' },
    { id: 'relay-c', name: '', url: 'https://c.example.test', tokenMode: 'custom', token: 'held-for-c' },
    // Signs in here with its own key: a rotation leaves it working.
    { id: 'relay-d', name: 'Keyed box', url: 'https://d.example.test', tokenMode: 'peer', peerKeyConfirmed: true },
  ];
  const relay = await startRelay({ paired });
  try {
    const browser = await relay.signIn('laptop');
    const other = await relay.signIn('phone');
    const agentToken = relay.store.mintAgentToken({ kind: 's', subject: 'conv-a' });
    const oldCookie = { Cookie: `${COOKIE}=${relay.legacyToken}` };
    const ownerSocket = relay.sockets.add({ principal: { kind: 'owner' }, browserSessionId: null });

    const rotated = await relay.call('/api/auth/owner-token/rotate', { method: 'POST', headers: browser.headers, body: {} });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.headers.get('cache-control'), 'no-store');
    const body = await rotated.json();
    assert.deepEqual(Object.keys(body).sort(), ['affectedRelays', 'lastNonBrowserUse', 'pairingLink', 'rotatedAt', 'token']);
    assert.ok(/^oaro1_[A-Za-z0-9_-]{43}$/.test(body.token), 'an oaro1_ token');
    assert.ok(body.pairingLink === `https://relay.example.test/oar/?token=${body.token}`, 'the pairing link carries the new token');
    assert.deepEqual(body.affectedRelays, [
      { id: 'relay-b', name: 'Linux box', url: 'https://b.example.test' },
      { id: 'relay-c', name: 'relay-c', url: 'https://c.example.test' },
    ]);

    // The old token fails at once, as Bearer and as an old cookie.
    assert.equal((await relay.call('/api/status', { headers: bearer(relay.legacyToken) })).status, 401);
    assert.equal((await relay.call('/api/status', { headers: oldCookie })).status, 401);
    // A protocol-1 peer still calling with it: a clear 401.
    assert.equal((await relay.call('/api/status', { headers: { ...bearer(relay.legacyToken), 'x-oar-remote-origin': 'relay-b' } })).status, 401);
    // The new one works; sessions (both browsers) and agents keep working.
    assert.equal((await relay.call('/api/status', { headers: bearer(body.token) })).status, 200);
    assert.equal((await relay.call('/api/status', { headers: browser.headers })).status, 200);
    assert.equal((await relay.call('/api/status', { headers: other.headers })).status, 200);
    assert.equal((await relay.call('/api/status', { headers: bearer(agentToken) })).status, 200);
    // The worker socket checks agent tokens against the agent key, which does not rotate.
    assert.deepEqual(relay.store.verifyAgentToken(agentToken), { kind: 's', subject: 'conv-a' });
    assert.equal(ownerSocket.disconnected, false, 'the runtime\'s rotate listener drops owner sockets (not part of this route)');

    // The log names the session, never a secret.
    assert.ok(relay.logs.includes(`[auth] owner token rotated by session ${browser.id}.`), relay.logs.join('\n'));
    assert.ok(relay.logs.every((line) => !line.includes(body.token) && !line.includes(relay.legacyToken)));
    // The hash in the secrets file and in memory changed; the plain token is kept nowhere.
    assert.equal(relay.store.verifyOwnerToken(body.token), true);
    assert.equal(relay.store.status().legacyPlaintext, false);
  } finally {
    await relay.close();
  }
});

test('rotation by the owner token itself is logged as such; a failed write leaves the old token working', async () => {
  const relay = await startRelay();
  try {
    const rotated = await relay.call('/api/auth/owner-token/rotate', { method: 'POST', headers: bearer(relay.legacyToken), body: {} });
    assert.equal(rotated.status, 200);
    assert.ok(relay.logs.includes('[auth] owner token rotated by the owner token.'));
    const { token } = await rotated.json();
    relay.store.rotateOwnerToken = () => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); };
    const failed = await relay.call('/api/auth/owner-token/rotate', { method: 'POST', headers: bearer(token), body: {} });
    assert.equal(failed.status, 500);
    assert.match((await failed.json()).error, /the current one still works/);
  } finally {
    await relay.close();
  }
});

test('affectedRelaysOf: an entry with a confirmed peer key is not affected (peer keys)', () => {
  assert.deepEqual(affectedRelaysOf([
    { id: 'a', name: 'A', url: 'https://a' },
    { id: 'b', name: 'B', url: 'https://b', peerKeyConfirmed: true },
  ]), [{ id: 'a', name: 'A', url: 'https://a' }]);
  assert.equal(signInLink('https://x.test/', 'token', 'v w'), 'https://x.test/?token=v%20w');
});

test('notices: the post-upgrade rotate notice shows once per relay (dismissed server side) and ends with a rotation; "changed outside OAR" until dismissed', async () => {
  const relay = await startRelay();
  try {
    const browser = await relay.signIn('laptop');
    const read = async (headers = browser.headers) => (await (await relay.call('/api/auth/notices', { headers })).json()).notices;
    let notices = await read();
    assert.deepEqual(notices.map((notice) => notice.id), [AUTH_NOTICE_IDS.rotateAfterUpgrade]);
    assert.match(notices[0].message, /readable by agents/);

    const dismissed = await relay.call(`/api/auth/notices/${AUTH_NOTICE_IDS.rotateAfterUpgrade}/dismiss`, { method: 'POST', headers: browser.headers, body: {} });
    assert.equal(dismissed.status, 200);
    assert.deepEqual((await dismissed.json()).notices, []);
    // Another browser of the same relay does not see it again.
    const phone = await relay.signIn('phone');
    assert.deepEqual(await read(phone.headers), []);
    assert.equal((await relay.call('/api/auth/notices/nope/dismiss', { method: 'POST', headers: browser.headers, body: {} })).status, 404);

    // "Changed outside OAR": the stored copy of the hash no longer matches the file.
    relay.settings.set(OWNER_HASH_SETTING_KEY, JSON.stringify({ hash: 'f'.repeat(64), at: new Date().toISOString() }));
    relay.store.reconcileWithSettings({ readSetting: relay.readSetting, writeSetting: relay.writeSetting });
    notices = await read();
    assert.deepEqual(notices.map((notice) => notice.id), [AUTH_NOTICE_IDS.changedOutside]);
    assert.equal(notices[0].reason, 'file');
    await relay.call(`/api/auth/notices/${AUTH_NOTICE_IDS.changedOutside}/dismiss`, { method: 'POST', headers: browser.headers, body: {} });
    assert.deepEqual(await read(), []);
    assert.equal(relay.store.ownerTokenAlert(), null);

    const status = await (await relay.call('/api/auth/owner-token', { headers: browser.headers })).json();
    assert.equal(status.ownerToken.set, true);
    assert.equal(status.ownerToken.hashed, true);
    assert.equal(status.pairedRelays, 0);
  } finally {
    await relay.close();
  }

  // A relay that never rotated shows it until a rotation does.
  const fresh = await startRelay();
  try {
    const browser = await fresh.signIn('laptop');
    assert.equal((await (await fresh.call('/api/auth/notices', { headers: browser.headers })).json()).notices.length, 1);
    await fresh.call('/api/auth/owner-token/rotate', { method: 'POST', headers: browser.headers, body: {} });
    assert.deepEqual((await (await fresh.call('/api/auth/notices', { headers: browser.headers })).json()).notices, []);
  } finally {
    await fresh.close();
  }
});

test('the cookie without its key (a page on another port of the host) cannot rotate, sign others out, mint a sign-in code or list the browsers', async () => {
  const relay = await startRelay();
  try {
    const laptop = await relay.signIn('laptop');
    const phone = await relay.signIn('phone');
    const replay = { Cookie: laptop.cookie };
    for (const [method, route] of [
      ['POST', '/api/auth/owner-token/rotate'], ['DELETE', '/api/auth/sessions'], ['POST', '/api/auth/signin-codes'],
      ['GET', '/api/auth/sessions'], [`DELETE`, `/api/auth/sessions/${phone.id}`], ['DELETE', '/api/auth/session'],
      ['GET', '/api/auth/owner-token'],
    ]) {
      const answer = await relay.call(route, { method, headers: replay, body: method === 'GET' ? undefined : {} });
      assert.equal(answer.status, 403, `${method} ${route}`);
      const body = await answer.json();
      assert.equal(body.code, 'AUTH_SESSION_PROOF', `${method} ${route}`);
      assert.equal(body.token, undefined);
      assert.equal(body.link, undefined);
    }
    assert.ok(relay.store.verifyOwnerToken(relay.legacyToken), 'nothing rotated');
    assert.equal(relay.sessions.list().length, 2, 'nobody signed out');
    assert.equal(relay.codes.size(), 0, 'no code made');
    assert.ok(relay.logs.every((line) => !/rotated|sign-in code was made|signed out by/.test(line)));
  } finally {
    await relay.close();
  }
});

test('S1: an upgraded browser (no device id at first) sends its device id once; revoking it then removes its push rows', async () => {
  const relay = await startRelay();
  try {
    const old = await relay.call('/api/auth/session', { method: 'POST', headers: { Cookie: `${COOKIE}=${relay.legacyToken}`, 'Sec-Fetch-Site': 'same-origin' }, body: {} });
    assert.equal(old.status, 200);
    const { session, proof } = await old.json();
    // The answer clears the old cookie first, then sets the session's.
    const sessionCookie = old.headers.getSetCookie().filter((line) => line.startsWith(`${COOKIE}=`)).at(-1).split(';')[0];
    const page = { Cookie: sessionCookie, 'X-OAR-Session-Proof': proof, 'Sec-Fetch-Site': 'same-origin' };
    assert.equal(relay.sessions.get(session.id).device_id, '');
    // The page after start: the renewal carries its device id.
    const renewed = await relay.call('/api/auth/session', { method: 'POST', headers: page, body: { deviceId: 'phone' } });
    assert.equal(renewed.status, 200);
    assert.equal(relay.sessions.get(session.id).device_id, 'phone');
    const laptop = await relay.signIn('laptop');
    const revoked = await relay.call(`/api/auth/sessions/${session.id}`, { method: 'DELETE', headers: laptop.headers });
    assert.deepEqual((await revoked.json()).effects, { sockets: 0, pushDevices: 2 });
    assert.equal(relay.push.has('phone'), false);
  } finally {
    await relay.close();
  }
});

test('a session pushed out by the 50 drops its sockets and push rows like a revoked one', async () => {
  const relay = await startRelay();
  try {
    const phone = await relay.signIn('phone');
    const socket = relay.sockets.add({ principal: { kind: 'browser' }, browserSessionId: phone.id });
    for (let index = 0; index < 50; index += 1) {
      const filler = relay.sessions.create({ authMethod: 'token', deviceId: `filler-${index}` });
      assert.ok(filler.row.id);
    }
    assert.equal(relay.sessions.get(phone.id), null, 'the least recently seen went');
    assert.equal(socket.disconnected, true);
    assert.equal(relay.push.has('phone'), false);
    assert.equal(relay.push.get('laptop'), 1);
  } finally {
    await relay.close();
  }
});

test('B1: a --token on the command line never brings the old token back after a rotation and a restart', async () => {
  const relay = await startRelay();
  const old = relay.legacyToken;
  let restarted = null;
  try {
    const rotated = await relay.call('/api/auth/owner-token/rotate', { method: 'POST', headers: bearer(old), body: {} });
    assert.equal(rotated.status, 200);
    const { token } = await rotated.json();
    await relay.close({ keepDir: true });
    // A supervisor of the earlier version relaunches with its own `--token <old>`.
    restarted = await startRelay({ dir: relay.dir, settings: relay.settings, argvToken: old });
    assert.equal((await restarted.call('/api/status', { headers: bearer(old) })).status, 401, 'the old token is refused');
    assert.equal((await restarted.call('/api/status', { headers: bearer(token) })).status, 200, 'the new token works');

    // The person is told to stop and start the relay once; the notice can
    // be dismissed for this run.
    const listed = await (await restarted.call('/api/auth/notices', { headers: bearer(token) })).json();
    assert.ok(listed.notices.some((notice) => notice.id === AUTH_NOTICE_IDS.argvToken && /Stop and start the relay once/.test(notice.message)));
    const dismissed = await restarted.call(`/api/auth/notices/${AUTH_NOTICE_IDS.argvToken}/dismiss`, { method: 'POST', headers: bearer(token), body: {} });
    assert.equal(dismissed.status, 200);
    assert.equal((await dismissed.json()).notices.some((notice) => notice.id === AUTH_NOTICE_IDS.argvToken), false);
  } finally {
    await (restarted || relay).close();
  }
});

test('the upgrade notice dismissal is tied to the hash in relay-secrets.json, not to a --token', async () => {
  const relay = await startRelay();
  let restarted = null;
  try {
    await relay.close({ keepDir: true });
    // Restarted with another value on the command line (ignored).
    restarted = await startRelay({ dir: relay.dir, settings: relay.settings, argvToken: crypto.randomUUID() });
    const token = relay.legacyToken;
    const before = await (await restarted.call('/api/auth/notices', { headers: bearer(token) })).json();
    assert.ok(before.notices.some((notice) => notice.id === AUTH_NOTICE_IDS.rotateAfterUpgrade));
    const dismissed = await restarted.call(`/api/auth/notices/${AUTH_NOTICE_IDS.rotateAfterUpgrade}/dismiss`, { method: 'POST', headers: bearer(token), body: {} });
    assert.equal(dismissed.status, 200);
    const stored = JSON.parse(restarted.settings.get('auth_upgrade_notice_dismissed'));
    assert.equal(stored.hash, restarted.store.storedOwnerHash());
    assert.equal(stored.hash, crypto.createHash('sha256').update(token).digest('hex'));
  } finally {
    await (restarted || relay).close();
  }
});

test('the link base follows the host a trusted proxy names, never one a direct client claims', () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  const request = (peer, headers, protocol = 'http') => ({ app, protocol, headers, socket: { remoteAddress: peer } });
  assert.equal(
    requestBaseUrl(request('127.0.0.1', { host: '127.0.0.1:3333', 'x-forwarded-host': 'relay.example.test' }, 'https'), '/oar'),
    'https://relay.example.test/oar',
  );
  assert.equal(
    requestBaseUrl(request('192.168.7.20', { host: '192.168.7.10:3333', 'x-forwarded-host': 'evil.example.test' })),
    'http://192.168.7.10:3333',
  );
});

// ─── Sign-in notices, terminal codes, QR, owner token use ───────────────────

const listNotices = async (relay, headers) => {
  const answer = await relay.call('/api/auth/notices', { headers });
  assert.equal(answer.status, 200);
  return answer.json();
};

test('new sign-in notices: shown to every other browser and sent to their sockets; dismissed per viewer; 400 without a session', async () => {
  const relay = await startRelay();
  try {
    const laptop = await relay.signIn('laptop');
    const laptopSocket = relay.sockets.add({ principal: { kind: 'browser', sessionId: laptop.id }, browserSessionId: laptop.id });
    const ownerSocket = relay.sockets.add({ principal: { kind: 'owner' }, browserSessionId: null });
    // A socket the handshake did not tag as the person (no key, an agent): never told.
    const untagged = relay.sockets.add({ browserSessionId: laptop.id });
    const agentSocket = relay.sockets.add({ principal: { kind: 'agent', agentKind: 'c' }, browserSessionId: null });
    const phone = await relay.signIn('phone', { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/130.0 Mobile Safari/537.36' });
    // The laptop and the owner socket were told; nobody else is there yet.
    const told = laptopSocket.received.filter((entry) => entry.event === SIGNIN_NOTICE_SOCKET_EVENT);
    assert.equal(told.length, 1);
    assert.equal(told[0].payload.notice.sessionId, phone.id);
    assert.equal(told[0].payload.notice.via, 'token');
    assert.equal(ownerSocket.received.length, 1);
    assert.deepEqual([untagged.received, agentSocket.received], [[], []]);

    const forLaptop = await listNotices(relay, laptop.headers);
    assert.deepEqual(forLaptop.signins.map((notice) => notice.sessionId), [phone.id]);
    const notice = forLaptop.signins[0];
    assert.equal(notice.label, 'Chrome on Android');
    assert.equal(notice.viaLabel, 'the relay token');
    assert.equal(notice.dismissible, true);
    assert.deepEqual(forLaptop.recommendations, []);
    // The phone sees the laptop's sign-in, not its own.
    assert.deepEqual((await listNotices(relay, phone.headers)).signins.map((item) => item.sessionId), [laptop.id]);

    // Dismissed by the laptop: gone for the laptop only.
    const dismissed = await relay.call(`/api/auth/notices/${notice.id}/dismiss`, { method: 'POST', headers: laptop.headers, body: {} });
    assert.equal(dismissed.status, 200);
    assert.deepEqual((await dismissed.json()).signins, [], 'the answer is the laptop\'s list after the dismiss');
    const tablet = await relay.signIn('tablet');
    assert.ok((await listNotices(relay, tablet.headers)).signins.some((item) => item.id === notice.id), 'another browser still sees it');
    // The owner token (no session): the relay-wide list; dismissing is per browser.
    const relayWide = await listNotices(relay, bearer(relay.legacyToken));
    assert.equal(relayWide.signins.length, 3);
    assert.ok(relayWide.signins.every((item) => item.dismissible === false));
    const noViewer = await relay.call(`/api/auth/notices/${notice.id}/dismiss`, { method: 'POST', headers: bearer(relay.legacyToken), body: {} });
    assert.equal(noViewer.status, 400);
    assert.equal((await relay.call('/api/auth/notices/signin-unknown/dismiss', { method: 'POST', headers: laptop.headers, body: {} })).status, 404);

    // "Got it": all the tablet was shown, for the tablet only, in one call.
    const tabletIds = (await listNotices(relay, tablet.headers)).signins.map((item) => item.id);
    assert.equal(tabletIds.length, 2, 'the laptop\'s and the phone\'s, never its own');
    const gotIt = await relay.call('/api/auth/notices/dismiss-signins', { method: 'POST', headers: tablet.headers, body: { ids: tabletIds } });
    assert.equal(gotIt.status, 200);
    const afterGotIt = await gotIt.json();
    assert.equal(afterGotIt.dismissed, 2);
    assert.deepEqual(afterGotIt.signins, []);
    assert.equal((await listNotices(relay, phone.headers)).signins.length, 2, 'the phone still sees the laptop\'s and the tablet\'s');
    assert.equal((await relay.call('/api/auth/notices/dismiss-signins', { method: 'POST', headers: tablet.headers, body: {} })).status, 400);
    assert.equal((await relay.call('/api/auth/notices/dismiss-signins', { method: 'POST', headers: tablet.headers, body: { ids: ['rotate-after-upgrade'] } })).status, 400);
    assert.equal((await relay.call('/api/auth/notices/dismiss-signins', { method: 'POST', headers: bearer(relay.legacyToken), body: { ids: tabletIds } })).status, 400);
    // No credential in the log.
    assert.ok(!relay.logs.some((line) => /oars1_|oarc1_/.test(line)));
  } finally {
    await relay.close();
  }
});

test('§13.9: a terminal session signs out all others; its push was already sent, and a browser signing in again sees the notice', async () => {
  const relay = await startRelay();
  try {
    const phone = await relay.signIn('phone');
    relay.pushService.upsertSubscription({ deviceId: 'phone', endpoint: 'https://push.example.test/phone', keys: { p256dh: 'k', auth: 'a' } });
    relay.pushService.upsertSubscription({ deviceId: 'intruder', endpoint: 'https://push.example.test/intruder', keys: { p256dh: 'k', auth: 'a' } });
    relay.pushSent.length = 0;

    // The cli token over loopback mints a terminal code; it signs a browser in.
    const cli = bearer(relay.store.mintAgentToken({ kind: 'c' }));
    const minted = await relay.call('/api/auth/signin-codes/terminal', { method: 'POST', headers: cli, body: {} });
    assert.equal(minted.status, 200);
    const { code } = await minted.json();
    const signIn = await relay.call('/api/auth/session', { method: 'POST', headers: bearer(code), body: { deviceId: 'intruder' } });
    assert.equal(signIn.status, 200);
    // The terminal code's answer carries the new session's proof key too.
    const signedIn = await signIn.json();
    matchSecret(signedIn.proof, /^oark1_/);
    const intruder = { id: signedIn.session.id, headers: { Cookie: String(signIn.headers.get('set-cookie')).split(';')[0], 'X-OAR-Session-Proof': signedIn.proof, 'Sec-Fetch-Site': 'same-origin' } };
    // By the time the sign-in answered, the push was on its way, to the phone
    // only (not the new device), past the active-device suppression.
    assert.deepEqual(relay.pushSent.map((entry) => entry.endpoint), ['https://push.example.test/phone']);
    const pushed = relay.pushSent[0].payload;
    assert.equal(pushed.tag, NEW_SIGNIN_TAG);
    assert.match(pushed.body, /via the terminal/);
    assert.equal(pushed.data.signOutSessionId, intruder.id);

    // "Sign out all other browsers" from the new session.
    const out = await relay.call('/api/auth/sessions', { method: 'DELETE', headers: intruder.headers });
    assert.equal(out.status, 200);
    assert.equal((await relay.call('/api/status', { headers: phone.headers })).status, 401);
    assert.equal(relay.pushService.listDevices().some((device) => device.deviceId === 'phone'), false, 'the phone\'s push rows went with its session');
    assert.equal(relay.pushSent.length, 1, 'the push already sent is not taken back');

    // The phone signs in again: the notice of the terminal sign-in is there.
    const again = await relay.signIn('phone');
    const { signins } = await listNotices(relay, again.headers);
    const notice = signins.find((item) => item.sessionId === intruder.id);
    assert.ok(notice, 'the earlier sign-in notice is shown to a browser signed in after it');
    assert.equal(notice.via, 'terminal');
    assert.equal(notice.signedOut, false);
    // Its own Dismiss cannot hide it from the phone.
    await relay.call(`/api/auth/notices/${notice.id}/dismiss`, { method: 'POST', headers: intruder.headers, body: {} });
    assert.ok((await listNotices(relay, again.headers)).signins.some((item) => item.id === notice.id));
    // "Sign it out" from the phone.
    assert.equal((await relay.call(`/api/auth/sessions/${intruder.id}`, { method: 'DELETE', headers: again.headers })).status, 200);
    assert.equal((await listNotices(relay, again.headers)).signins.find((item) => item.id === notice.id).signedOut, true);
  } finally {
    await relay.close();
  }
});

test('the terminal route: the session list says terminal; owner, browser and session agents are refused', async () => {
  const relay = await startRelay();
  try {
    const laptop = await relay.signIn('laptop');
    const owner = await relay.call('/api/auth/signin-codes/terminal', { method: 'POST', headers: bearer(relay.legacyToken), body: {} });
    assert.equal(owner.status, 403);
    assert.equal((await relay.call('/api/auth/signin-codes/terminal', { method: 'POST', headers: laptop.headers, body: {} })).status, 403);
    assert.equal((await relay.call('/api/auth/signin-codes/terminal', { method: 'POST', headers: bearer(relay.store.mintAgentToken({ kind: 's', subject: 'conv-a' })), body: {} })).status, 403);
    const { code } = await (await relay.call('/api/auth/signin-codes/terminal', { method: 'POST', headers: bearer(relay.store.mintAgentToken({ kind: 'c' })), body: {} })).json();
    await relay.call('/api/auth/session', { method: 'POST', headers: bearer(code), body: { deviceId: 'tablet' } });
    const { sessions } = await (await relay.call('/api/auth/sessions', { headers: laptop.headers })).json();
    assert.equal(sessions.find((row) => row.deviceId === 'tablet').authMethod, 'terminal');
  } finally {
    await relay.close();
  }
});

test('signin-codes: the answer carries the QR matrix of the link; a new code revokes this browser\'s previous one', async () => {
  const relay = await startRelay();
  try {
    const laptop = await relay.signIn('laptop');
    const desk = await relay.signIn('desk');
    const first = await (await relay.call('/api/auth/signin-codes', { method: 'POST', headers: laptop.headers, body: {} })).json();
    assert.ok(first.qr && Number.isInteger(first.qr.size) && typeof first.qr.bits === 'string');
    assert.deepEqual(unpackQrBits(first.qr), unpackQrBits(qrMatrix(first.link)), 'the matrix is the link\'s');
    const fromDesk = await (await relay.call('/api/auth/signin-codes', { method: 'POST', headers: desk.headers, body: {} })).json();
    const second = await (await relay.call('/api/auth/signin-codes', { method: 'POST', headers: laptop.headers, body: {} })).json();
    assert.equal((await relay.call('/api/auth/session', { method: 'POST', headers: bearer(first.code), body: { deviceId: 'a' } })).status, 401, 'the laptop\'s first code is revoked');
    assert.equal((await relay.call('/api/auth/session', { method: 'POST', headers: bearer(fromDesk.code), body: { deviceId: 'b' } })).status, 200, 'another browser\'s code stays');
    assert.equal((await relay.call('/api/auth/session', { method: 'POST', headers: bearer(second.code), body: { deviceId: 'c' } })).status, 200);
  } finally {
    await relay.close();
  }
});

test('owner token: the last non-browser use (when and from where, never the value), moved to previous by a rotation', async () => {
  const relay = await startRelay();
  try {
    const browser = await relay.signIn('laptop');
    let status = await (await relay.call('/api/auth/owner-token', { headers: browser.headers })).json();
    assert.equal(status.lastNonBrowserUse, null);
    assert.equal(status.previousLastNonBrowserUse, null);
    assert.ok(Date.parse(status.lastNonBrowserUseSince) > 0);

    // A script with the owner token (no Sec-Fetch-Site), through a proxy.
    await relay.call('/api/status', { headers: { ...bearer(relay.legacyToken), 'X-Forwarded-For': '203.0.113.50' } });
    // The relay's own page does not count.
    await relay.call('/api/status', { headers: { ...bearer(relay.legacyToken), 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-For': '203.0.113.51' } });
    status = await (await relay.call('/api/auth/owner-token', { headers: browser.headers })).json();
    assert.equal(status.lastNonBrowserUse.address, '203.0.113.50');
    assert.ok(Math.abs(Date.parse(status.lastNonBrowserUse.at) - Date.now()) < 5000);
    assert.ok(!JSON.stringify(status).includes(relay.legacyToken));
    // Written to app_settings on the first use (then at most every 10 minutes).
    const stored = relay.settings.get('auth_owner_token_last_use');
    assert.ok(stored && !stored.includes(relay.legacyToken));
    assert.equal(JSON.parse(stored).current.address, '203.0.113.50');

    const rotated = await (await relay.call('/api/auth/owner-token/rotate', { method: 'POST', headers: browser.headers, body: {} })).json();
    assert.equal(rotated.lastNonBrowserUse.address, '203.0.113.50', 'the old token\'s last use');
    status = await (await relay.call('/api/auth/owner-token', { headers: browser.headers })).json();
    assert.equal(status.lastNonBrowserUse, null);
    assert.equal(status.previousLastNonBrowserUse.address, '203.0.113.50');
  } finally {
    await relay.close();
  }
});

test('recommendations: rotate-owner-token while the plaintext token\'s banner is dismissed, or the "changed outside" one; gone after a rotation', async () => {
  const relay = await startRelay();
  try {
    const browser = await relay.signIn('laptop');
    // The banner shows: no dot yet.
    assert.deepEqual((await listNotices(relay, browser.headers)).recommendations, []);
    await relay.call(`/api/auth/notices/${AUTH_NOTICE_IDS.rotateAfterUpgrade}/dismiss`, { method: 'POST', headers: browser.headers, body: {} });
    assert.deepEqual((await listNotices(relay, browser.headers)).recommendations, [{ id: 'rotate-owner-token', tab: 'security' }]);
    // Agents never see it: the route is person-only.
    assert.equal((await relay.call('/api/auth/notices', { headers: bearer(relay.store.mintAgentToken({ kind: 's', subject: 'conv-a' })) })).status, 403);
    await relay.call('/api/auth/owner-token/rotate', { method: 'POST', headers: browser.headers, body: {} });
    assert.deepEqual((await listNotices(relay, browser.headers)).recommendations, []);

    // Changed outside OAR, banner dismissed: recommended until the next rotation.
    relay.settings.set(OWNER_HASH_SETTING_KEY, JSON.stringify({ hash: 'f'.repeat(64), at: new Date().toISOString() }));
    relay.store.reconcileWithSettings({ readSetting: relay.readSetting, writeSetting: relay.writeSetting });
    assert.deepEqual((await listNotices(relay, browser.headers)).recommendations, [], 'the banner shows first');
    await relay.call(`/api/auth/notices/${AUTH_NOTICE_IDS.changedOutside}/dismiss`, { method: 'POST', headers: browser.headers, body: {} });
    assert.deepEqual((await listNotices(relay, browser.headers)).recommendations, [{ id: 'rotate-owner-token', tab: 'security' }]);
    await relay.call('/api/auth/owner-token/rotate', { method: 'POST', headers: browser.headers, body: {} });
    assert.deepEqual((await listNotices(relay, browser.headers)).recommendations, []);
  } finally {
    await relay.close();
  }
});
