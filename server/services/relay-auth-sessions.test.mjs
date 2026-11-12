import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

import { AUTH_FAILURE_LIMIT, UPGRADE_PENDING_MS, createAuthFailureLockout, createRelayAuth } from './relay-auth.mjs';
import { createOwnerSecretStore } from './owner-secret-store.mjs';
import { BROWSER_SESSION_IDLE_MS, BROWSER_SESSION_TOUCH_INTERVAL_MS, createBrowserSessionService, createSignInCodes } from './browser-session-service.mjs';
import { createLocalRequestCheck } from './request-boundary.mjs';
import { principalOf } from './relay-principal.mjs';
import { migrateBrowserSessions } from '../migrations/0041-browser-sessions.mjs';
import { createSignInNoticeService } from './signin-notice-service.mjs';

// Yes/no on values that hold a credential: a failure never prints it.
const matchSecret = (value, pattern, message) => assert.ok(pattern.test(String(value)), message || `expected ${pattern}`);

// Browser sessions through `auth` and the sign-in exchange (agent auth §4,
// §10 tests 11, 12, 14, 15 and the cookie attributes of §0.4). Every
// credential is made at run time and never printed.

const COOKIE = 'copilot_auth';
const LEGACY_TOKEN = crypto.randomUUID();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

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

function tunnel(clientIp) {
  return { 'cf-ray': '8a1b2c3d4e5f6789-AMS', 'x-forwarded-for': clientIp };
}

async function startRelay({ trustProxy = 'loopback' } = {}) {
  const revoked = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-sessions-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ authToken: LEGACY_TOKEN }));
  const store = createOwnerSecretStore({ dataDir: path.join(dir, 'data'), logger: { log() {}, warn() {} } });
  store.bootstrap({ config: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath });
  const clock = { now: Date.now() };
  const db = new Database(':memory:');
  migrateBrowserSessions(db);
  const sessions = createBrowserSessionService({ db, now: () => clock.now, logger: { log() {}, warn() {} } });
  sessions.setOnRemoved((rows, reason) => revoked.push({ ids: rows.map((row) => row.id), reason }));
  const codes = createSignInCodes({ now: () => clock.now });
  const logs = [];
  // What the hooks saw: new sessions (§13.2, 2d), owner token uses (3a).
  const created = [];
  const ownerUses = [];
  // The sign-in notices as the relay keeps them (settings in memory); what
  // went to the open pages, and to whom not.
  const noticeSettings = new Map();
  const noticesSent = [];
  const notices = createSignInNoticeService({
    readSetting: (key) => noticeSettings.get(key) ?? null,
    writeSetting: (key, value) => noticeSettings.set(key, value),
    emitToPersonSockets: (event, payload, options) => { noticesSent.push({ event, payload, options }); return 0; },
    isSessionLive: (id) => !!sessions.get(id),
    now: () => clock.now,
    logger: { log() {}, warn() {} },
  });
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(express.json());
  const relayAuth = createRelayAuth({
    app,
    verifyOwnerToken: (value) => store.verifyOwnerToken(value),
    verifyAgentToken: (value) => store.verifyAgentToken(value),
    browserSessions: sessions,
    signInCodes: codes,
    onSessionsRevoked: (rows) => revoked.push({ ids: rows.map((row) => row.id), reason: 'replaced' }),
    cookieName: COOKIE,
    parseCookies,
    appendSetCookie,
    localRequestCheck: createLocalRequestCheck(),
    lockout: createAuthFailureLockout(),
    logger: { log: (line) => logs.push(String(line)), warn: (line) => logs.push(String(line)) },
    onSessionCreated: ({ row, via, address }) => {
      created.push({ id: row.id, via, method: row.auth_method, address });
      notices.record({ row, via, address });
    },
    onOwnerBearerUse: (use) => ownerUses.push(use),
    nowMs: () => clock.now,
  });
  app.post('/api/auth/session', relayAuth.signIn);
  const whoami = (req, res) => res.json({ principal: principalOf(req) });
  app.get('/api/status', relayAuth.auth, whoami);
  app.post('/api/message', relayAuth.auth, whoami);
  // The person's routes the proof key guards (stand-ins: `auth` decides).
  app.get('/api/conversation/:id', relayAuth.auth, whoami);
  app.post('/api/relay-question/:id/answer', relayAuth.auth, whoami);
  app.post('/api/auth/owner-token/rotate', relayAuth.auth, whoami);
  app.delete('/api/auth/sessions', relayAuth.auth, whoami);
  // The signed-in browsers list, as Settings → Security reads it.
  app.get('/api/auth/sessions', relayAuth.auth, (req, res) => res.json({ sessions: sessions.list() }));
  app.post('/api/auth/signin-codes', relayAuth.auth, whoami);
  app.get('/api/pending', relayAuth.auth, whoami);
  // A content GET a browser loads by itself: the cookie alone opens it.
  app.get('/api/upload/:sha256/content', relayAuth.auth, whoami);
  // A file-by-path route: counts the requests it is reached by.
  const reached = { files: 0 };
  app.get('/api/drives/file', relayAuth.auth, (req, res) => { reached.files += 1; whoami(req, res); });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = 'GET', headers = {}, body } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    store, sessions, codes, clock, db, logs, relayAuth, call, revoked, reached, created, ownerUses, notices, noticesSent,
    rows: () => db.prepare('SELECT * FROM browser_sessions').all(),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
// The cookie the browser ends with: the last copilot_auth the answer sets
// (an old cookie's trade clears it first, then sets the session's).
const setCookiesOf = (response) => response.headers.getSetCookie();
const cookieOf = (response) => (setCookiesOf(response).filter((line) => line.startsWith(`${COOKIE}=`)).at(-1) || '').split(';')[0];
const PROOF = 'X-OAR-Session-Proof';

/** Signs in with `headers` (a Bearer, or an old cookie): `{ cookie, proof, id, response }`. */
async function signIn(relay, headers = bearer(LEGACY_TOKEN), body = {}) {
  const response = await relay.call('/api/auth/session', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', ...headers }, body });
  const answer = await response.json();
  return { status: response.status, answer, cookie: cookieOf(response), proof: answer.proof || '', id: answer.session?.id || '', response };
}

/** The page's headers: the cookie and the session's key. */
const pageHeaders = (session) => ({ Cookie: session.cookie, [PROOF]: session.proof, 'Sec-Fetch-Site': 'same-origin' });

async function codeOf(response) {
  return (await response.json()).code;
}

test('sign-in answers the proof key once, in the JSON body only (no cookie, no URL); the table keeps its hash', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-1' });
    assert.equal(session.status, 200);
    assert.equal(session.response.headers.get('cache-control'), 'no-store');
    matchSecret(session.proof, /^oark1_[A-Za-z0-9_-]{43}$/);
    assert.ok(!String(session.response.headers.get('set-cookie')).includes(session.proof), 'the key is in no cookie');
    assert.ok(!session.response.headers.get('location'));
    const row = relay.rows()[0];
    assert.equal(row.proof_hash, crypto.createHash('sha256').update(session.proof).digest('hex'));
    assert.ok(!JSON.stringify(relay.rows()).includes(session.proof));
    assert.ok(relay.logs.every((line) => !line.includes(session.proof) && !line.includes('oars1_')));
    // With the key the page works; renewing it gives no new key.
    assert.equal((await relay.call('/api/status', { headers: pageHeaders(session) })).status, 200);
    const renewed = await relay.call('/api/auth/session', { method: 'POST', headers: pageHeaders(session), body: { deviceId: 'dev-1' } });
    const renewal = await renewed.json();
    assert.equal(renewal.renewed, true);
    assert.equal(renewal.proof, undefined, 'a renewal makes no key');
  } finally {
    await relay.close();
  }
});

test('a cookie without its key (a page on another port of the host) is refused with 403 AUTH_SESSION_PROOF: answer, rotate, sign out all others, sign-in code, a transcript read', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay);
    const cookieOnly = { Cookie: session.cookie };
    const replays = [
      ['POST', '/api/relay-question/q-1/answer', { answer: 'yes' }],
      ['POST', '/api/auth/owner-token/rotate', {}],
      ['DELETE', '/api/auth/sessions', undefined],
      ['POST', '/api/auth/signin-codes', {}],
      ['GET', '/api/conversation/conv-1', undefined],
      ['GET', '/api/status', undefined],
    ];
    for (const [method, route, body] of replays) {
      // A dev server replaying the cookie sends neither Sec-Fetch-Site nor Origin.
      const replay = await relay.call(route, { method, headers: cookieOnly, body });
      assert.equal(replay.status, 403, `${method} ${route}`);
      assert.equal(await codeOf(replay), 'AUTH_SESSION_PROOF', `${method} ${route}`);
      assert.equal(replay.headers.get('set-cookie'), null, 'the cookie is not cleared: it is valid');
    }
    // A wrong key is no better.
    const wrongKey = `oark1_${crypto.randomBytes(32).toString('base64url')}`;
    for (const [method, route, body] of replays) {
      const wrong = await relay.call(route, { method, headers: { ...cookieOnly, [PROOF]: wrongKey }, body });
      assert.equal(wrong.status, 403, `${method} ${route}`);
      assert.equal(await codeOf(wrong), 'AUTH_SESSION_PROOF');
    }
    // The cookie secret as the key, or the key of another session: refused.
    const other = await signIn(relay);
    assert.equal((await relay.call('/api/conversation/conv-1', { headers: { ...cookieOnly, [PROOF]: other.proof } })).status, 403);
    assert.equal((await relay.call('/api/conversation/conv-1', { headers: { ...cookieOnly, [PROOF]: session.cookie.split('=')[1] } })).status, 403);
    // No replay was counted as a wrong guess, and the session still works.
    assert.equal(relay.relayAuth.lockout.size(), 0);
    for (const [method, route, body] of replays) {
      const own = await relay.call(route, { method, headers: pageHeaders(session), body });
      assert.equal(own.status, 200, `${method} ${route}`);
      assert.equal((await own.json()).principal.kind, 'browser');
    }
    assert.ok(relay.logs.some((line) => /cookie without its session key refused/.test(line)));
  } finally {
    await relay.close();
  }
});

test('the cookie-only list: a content GET goes on the cookie alone; a worker GET that writes does not', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay);
    const content = await relay.call(`/api/upload/${'a'.repeat(64)}/content`, { headers: { Cookie: session.cookie } });
    assert.equal(content.status, 200);
    assert.equal((await content.json()).principal.kind, 'browser');
    const pending = await relay.call('/api/pending', { headers: { Cookie: session.cookie } });
    assert.equal(pending.status, 403);
    assert.equal(await codeOf(pending), 'AUTH_SESSION_PROOF');
    // Bearer callers (owner token, agent tokens) never need a key.
    assert.equal((await relay.call('/api/pending', { headers: bearer(LEGACY_TOKEN) })).status, 200);
    assert.equal((await relay.call('/api/status', { headers: bearer(relay.store.mintAgentToken({ kind: 's', subject: 'conv-a' })) })).status, 200);
  } finally {
    await relay.close();
  }
});

test('a file capability that is malformed, expired, too far out or for a session the cookie does not hold is refused before the route (403 AUTH_FILE_CAPABILITY); a well-formed one goes on to it', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay);
    const other = await signIn(relay);
    const nowS = Math.floor(relay.clock.now / 1000);
    // Made-up capabilities of the right shape: only the route could check their MAC.
    const mac = 'A'.repeat(43);
    const at = (id, expS) => `/api/drives/file?path=${encodeURIComponent('/home/dev/x.png')}&k=${encodeURIComponent(`fc1.${id}.${expS.toString(36)}.${mac}`)}`;
    for (const [label, url] of [
      ['garbage', '/api/drives/file?path=%2Fhome%2Fdev%2Fx.png&k=junk'],
      ['expired', at(session.id, nowS - 1)],
      ['too far out', at(session.id, nowS + 3600)],
      ['another session', at(other.id, nowS + 60)],
      ['no such session', at('nosuchsession', nowS + 60)],
    ]) {
      const response = await relay.call(url, { headers: { Cookie: session.cookie } });
      assert.equal(response.status, 403, label);
      assert.equal(await codeOf(response), 'AUTH_FILE_CAPABILITY', label);
    }
    assert.equal(relay.reached.files, 0, 'the route never ran');
    // The cookie's own live session, in time: on to the route (which checks the MAC).
    assert.equal((await relay.call(at(session.id, nowS + 60), { headers: { Cookie: session.cookie } })).status, 200);
    assert.equal(relay.reached.files, 1);
    // No k at all: the cookie alone still needs its key.
    const bare = await relay.call('/api/drives/file?path=%2Fhome%2Fdev%2Fx.png', { headers: { Cookie: session.cookie } });
    assert.equal(bare.status, 403);
    assert.equal(await codeOf(bare), 'AUTH_SESSION_PROOF');
  } finally {
    await relay.close();
  }
});

test('a session row without a proof hash never passes, the cookie-only routes included', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay);
    // A row as one made before keys looks (the table and the loaded copy).
    relay.db.prepare('UPDATE browser_sessions SET proof_hash = ? WHERE id = ?').run('', session.id);
    relay.sessions.resolve(session.cookie.split('=').slice(1).join('=')).proof_hash = '';
    const content = await relay.call(`/api/upload/${'a'.repeat(64)}/content`, { headers: { Cookie: session.cookie } });
    assert.equal(content.status, 403);
    assert.equal(await codeOf(content), 'AUTH_SESSION_PROOF');
    const status = await relay.call('/api/status', { headers: pageHeaders(session) });
    assert.equal(status.status, 403);
    assert.equal(await codeOf(status), 'AUTH_SESSION_PROOF');
    assert.equal(relay.relayAuth.lockout.size(), 0, 'a real session is no wrong guess');
  } finally {
    await relay.close();
  }
});

test('11: a browser from before sessions: its owner-token cookie opens no API route (403 AUTH_COOKIE_UPGRADE, not signed out), its page trades it once at the sign-in route for a session and a key', async () => {
  const relay = await startRelay();
  try {
    const old = { Cookie: `${COOKIE}=${LEGACY_TOKEN}` };
    const before = await relay.call('/api/status', { headers: old });
    assert.equal(before.status, 403);
    assert.equal(await codeOf(before), 'AUTH_COOKIE_UPGRADE', 'its own code: the page trades, no sign-in gate');
    const write = await relay.call('/api/message', { method: 'POST', headers: { ...old, 'Sec-Fetch-Site': 'same-origin' }, body: {} });
    assert.equal(write.status, 403);
    assert.equal(await codeOf(write), 'AUTH_COOKIE_UPGRADE');
    assert.equal(before.headers.get('set-cookie'), null, 'no session made outside the sign-in route');
    assert.equal(relay.rows().length, 0);
    const upgraded = await signIn(relay, old, { deviceId: 'dev-old' });
    assert.equal(upgraded.status, 200);
    matchSecret(upgraded.cookie, /^copilot_auth=oars1_/);
    matchSecret(upgraded.proof, /^oark1_/);
    assert.equal(relay.rows().length, 1);
    assert.equal(relay.rows()[0].auth_method, 'upgrade');
    assert.equal(relay.rows()[0].device_id, 'dev-old');
    // The answer clears the old cookie, then sets the session's.
    const setCookies = setCookiesOf(upgraded.response);
    assert.equal(setCookies.length, 2);
    assert.match(setCookies[0], /^copilot_auth=; Path=\/; Max-Age=0;/);
    matchSecret(setCookies[1], /^copilot_auth=oars1_[^;]+; Path=\/; Max-Age=\d+; SameSite=Lax; HttpOnly/);
    const works = await relay.call('/api/status', { headers: pageHeaders(upgraded) });
    assert.equal(works.status, 200);
    assert.equal((await works.json()).principal.sessionId, upgraded.id);
    assert.ok(relay.logs.some((line) => /now has session bs_/.test(line)));
    assert.ok(relay.logs.every((line) => !line.includes(LEGACY_TOKEN) && !line.includes('oars1_') && !line.includes(upgraded.proof)));
  } finally {
    await relay.close();
  }
});

test('the old-cookie trade is a write like any other: from another site (Sec-Fetch-Site or a foreign Origin) it is 403 AUTH_CROSS_SITE and makes nothing; from the page (same-origin, or its own Origin) it passes', async () => {
  const relay = await startRelay();
  try {
    const old = { Cookie: `${COOKIE}=${LEGACY_TOKEN}` };
    for (const headers of [
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { Origin: 'http://127.0.0.1:1' },
      { Origin: 'https://elsewhere.example.test' },
      { Origin: 'null' },
    ]) {
      const response = await relay.call('/api/auth/session', { method: 'POST', headers: { ...old, ...headers }, body: { deviceId: 'dev-x' } });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(await codeOf(response), 'AUTH_CROSS_SITE');
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal(relay.rows().length, 0);
    const host = new URL((await relay.call('/api/status')).url).origin;
    // A matching Origin alone (no Sec-Fetch-Site), and Sec-Fetch-Site same-origin alone.
    const ownOrigin = await signIn(relay, { ...old, Origin: host, 'Sec-Fetch-Site': '' }, { deviceId: 'dev-y' });
    assert.equal(ownOrigin.status, 200);
    const sameOrigin = await signIn(relay, old, { deviceId: 'dev-z' });
    assert.equal(sameOrigin.status, 200);
    assert.equal(relay.rows().length, 2);
  } finally {
    await relay.close();
  }
});

test('no key for a cookie alone: a session cookie without its key gets no key at the sign-in route; the token or a code makes a new session in its place', async () => {
  const relay = await startRelay();
  try {
    const lost = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-1' });
    const again = await relay.call('/api/auth/session', { method: 'POST', headers: { Cookie: lost.cookie, 'Sec-Fetch-Site': 'same-origin' }, body: { deviceId: 'dev-1' } });
    assert.equal(again.status, 403);
    const refusal = await again.json();
    assert.equal(refusal.code, 'AUTH_SESSION_PROOF');
    assert.equal(refusal.proof, undefined);
    assert.equal(again.headers.get('set-cookie'), null);
    // The token over it: a new session and key; the old row goes (its effects run).
    const replaced = await signIn(relay, { ...bearer(LEGACY_TOKEN), Cookie: lost.cookie }, { deviceId: 'dev-1' });
    assert.equal(replaced.status, 200);
    assert.notEqual(replaced.id, lost.id);
    matchSecret(replaced.proof, /^oark1_/);
    assert.deepEqual(relay.rows().map((row) => row.id), [replaced.id]);
    assert.deepEqual(relay.revoked.at(-1), { ids: [lost.id], reason: 'replaced' });
    // With its key, the token sign-in renews instead.
    const kept = await relay.call('/api/auth/session', { method: 'POST', headers: { ...pageHeaders(replaced), ...bearer(LEGACY_TOKEN) }, body: {} });
    assert.equal((await kept.json()).session.id, replaced.id);
    assert.equal(relay.rows().length, 1);
  } finally {
    await relay.close();
  }
});

test('the token over a session cookie whose key the browser lost: one answer sets the new cookie and key and signs the old session out; one notice, for the new session, not shown to it', async () => {
  const relay = await startRelay();
  try {
    const a = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'laptop' });
    assert.equal(a.status, 200);
    relay.created.length = 0;
    relay.noticesSent.length = 0;
    const noticesBefore = relay.notices.listFor({}).length;
    // The page lost its key (storage cleared); the cookie A is still sent.
    const b = await signIn(relay, { ...bearer(LEGACY_TOKEN), Cookie: a.cookie }, { deviceId: 'laptop' });
    assert.equal(b.status, 200);
    assert.notEqual(b.id, a.id);
    matchSecret(b.cookie, /^copilot_auth=oars1_/);
    assert.notEqual(b.cookie, a.cookie);
    matchSecret(b.proof, /^oark1_/);
    // Exactly one row for this browser: B. A was revoked in the same answer, its effects ran once.
    assert.deepEqual(relay.rows().map((row) => [row.id, row.device_id, row.auth_method]), [[b.id, 'laptop', 'token']]);
    assert.equal(relay.revoked.filter((entry) => entry.ids.includes(a.id)).length, 1);
    assert.deepEqual(relay.revoked.at(-1), { ids: [a.id], reason: 'replaced' });
    assert.ok(relay.logs.some((line) => line.includes(`browser session ${a.id} replaced by ${b.id}`)));
    // A is signed out, with or without its old key; B works with its key.
    assert.equal((await relay.call('/api/status', { headers: pageHeaders(a) })).status, 401);
    assert.equal((await relay.call('/api/status', { headers: pageHeaders(b) })).status, 200);
    // The notice: once, for B, sent to every page but B's, and not in B's own list.
    assert.deepEqual(relay.created, [{ id: b.id, via: 'token', method: 'token', address: '127.0.0.1' }]);
    assert.equal(relay.noticesSent.length, 1);
    assert.equal(relay.noticesSent[0].payload.notice.sessionId, b.id);
    assert.deepEqual(relay.noticesSent[0].options, { exceptSessionId: b.id });
    assert.equal(relay.notices.listFor({}).length, noticesBefore + 1);
    assert.deepEqual(relay.notices.listFor({ viewerSessionId: b.id }).filter((item) => item.sessionId === b.id), []);
    assert.equal(relay.notices.listFor({ viewerSessionId: b.id }).length, noticesBefore);
    assert.ok(relay.logs.every((line) => !line.includes(b.proof) && !line.includes('oars1_')));
  } finally {
    await relay.close();
  }
});

test('a sign-in code over an existing session signs the old session out', async () => {
  const relay = await startRelay();
  try {
    const first = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'phone' });
    const { code } = relay.codes.mint();
    const viaCode = await signIn(relay, { ...pageHeaders(first), ...bearer(code) }, { deviceId: 'phone' });
    assert.equal(viaCode.status, 200);
    assert.notEqual(viaCode.id, first.id);
    assert.deepEqual(relay.rows().map((row) => [row.id, row.auth_method]), [[viaCode.id, 'code']]);
    assert.deepEqual(relay.revoked.at(-1), { ids: [first.id], reason: 'replaced' });
    assert.equal((await relay.call('/api/status', { headers: pageHeaders(first) })).status, 401);
    assert.equal((await relay.call('/api/status', { headers: pageHeaders(viaCode) })).status, 200);
  } finally {
    await relay.close();
  }
});

test('parallel trades of one old cookie make one row (the server decides, not only the page\'s lock): the first gets the session, the others 409 AUTH_UPGRADE_PENDING and nothing; no plain secret is kept', async () => {
  const source = fs.readFileSync(new URL('./relay-auth.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /recentSessions|secret: made\.secret/);
  const relay = await startRelay();
  try {
    const old = { Cookie: `${COOKIE}=${LEGACY_TOKEN}` };
    const trades = await Promise.all(Array.from({ length: 3 }, () => signIn(relay, old, { deviceId: 'dev-1' })));
    const won = trades.filter((trade) => trade.status === 200);
    const pending = trades.filter((trade) => trade.status === 409);
    assert.equal(won.length, 1);
    assert.equal(pending.length, 2);
    for (const trade of pending) {
      assert.equal(trade.answer.code, 'AUTH_UPGRADE_PENDING');
      assert.equal(trade.answer.proof, undefined);
      assert.ok(trade.answer.retryAfterSeconds >= 1 && trade.answer.retryAfterSeconds <= UPGRADE_PENDING_MS / 1000);
      assert.equal(trade.response.headers.get('set-cookie'), null, 'the old cookie stays until its own trade answers');
    }
    assert.equal(relay.rows().length, 1);
    assert.equal((await relay.call('/api/status', { headers: pageHeaders(won[0]) })).status, 200);
    // Another browser holding the same old token (another device id) gets its own.
    const otherBrowser = await signIn(relay, old, { deviceId: 'dev-2' });
    assert.equal(otherBrowser.status, 200);
    assert.equal(relay.rows().length, 2);
    // Later (an answer that never arrived): a new trade replaces the first, still one row for dev-1.
    relay.clock.now += UPGRADE_PENDING_MS + 1;
    const again = await signIn(relay, old, { deviceId: 'dev-1' });
    assert.equal(again.status, 200);
    assert.notEqual(again.id, won[0].id);
    assert.deepEqual(relay.rows().map((row) => row.device_id).sort(), ['dev-1', 'dev-2']);
    assert.deepEqual(relay.revoked.at(-1), { ids: [won[0].id], reason: 'replaced' });
    assert.equal(typeof relay.relayAuth.forgetUpgrades, 'undefined');
  } finally {
    await relay.close();
  }
});

test('12: a Bearer owner token makes no session on an API route, from the relay\'s page either (the sign-in route is the one place)', async () => {
  const relay = await startRelay();
  try {
    for (const site of [null, 'same-site', 'cross-site', 'none', 'same-origin']) {
      const answer = await relay.call('/api/status', { headers: { ...bearer(LEGACY_TOKEN), ...(site ? { 'Sec-Fetch-Site': site } : {}) } });
      assert.equal(answer.status, 200, String(site));
      assert.equal((await answer.json()).principal.kind, 'owner');
      assert.equal(answer.headers.get('set-cookie'), null, String(site));
    }
    assert.equal(relay.rows().length, 0, 'scripts, peers and old pages never fill the list');
  } finally {
    await relay.close();
  }
});

test('14: idle past 30 days is 401 (signed out) and the row goes; touch re-sends the cookie at most every 10 minutes', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-1' });
    const page = pageHeaders(session);
    relay.clock.now += 5 * 60_000;
    assert.equal((await relay.call('/api/status', { headers: page })).headers.get('set-cookie'), null, '5 minutes: no write');
    relay.clock.now += BROWSER_SESSION_TOUCH_INTERVAL_MS;
    const touched = await relay.call('/api/status', { headers: page });
    matchSecret(String(touched.headers.get('set-cookie')), /^copilot_auth=oars1_[^;]+; Path=\/; Max-Age=2592000; SameSite=Lax; HttpOnly$/);
    assert.equal(relay.rows()[0].last_seen_at, new Date(relay.clock.now).toISOString());
    // A cookie-only content request does not slide the session.
    relay.clock.now += BROWSER_SESSION_TOUCH_INTERVAL_MS + 1;
    const content = await relay.call(`/api/upload/${'b'.repeat(64)}/content`, { headers: { Cookie: session.cookie } });
    assert.equal(content.headers.get('set-cookie'), null);

    relay.clock.now += BROWSER_SESSION_IDLE_MS + 1;
    const idle = await relay.call('/api/status', { headers: page });
    assert.equal(idle.status, 401);
    const answer = await idle.json();
    assert.equal(answer.code, 'AUTH_SIGNED_OUT');
    assert.match(answer.error, /This browser was signed out/);
    matchSecret(String(idle.headers.get('set-cookie')), /copilot_auth=;.*Max-Age=0/);
    assert.equal(relay.rows().length, 0, 'the expired row went');
    assert.deepEqual(relay.revoked.at(-1), { ids: [session.id], reason: 'expired' });
  } finally {
    await relay.close();
  }
});

test('sign-in exchange: owner token or a code; a session renews; wrong values count toward the lockout; agents and peers refused, not counted', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-1', label: 'Work laptop' });
    assert.match(session.answer.session.id, /^bs_/);
    assert.equal(session.answer.session.label, 'Work laptop');
    assert.equal(relay.rows()[0].device_id, 'dev-1');

    // A browser that has a session (and its key) renews it: same row, the cookie again.
    const renew = await relay.call('/api/auth/session', { method: 'POST', headers: pageHeaders(session), body: { deviceId: 'dev-1' } });
    assert.equal(renew.status, 200);
    assert.equal((await renew.json()).renewed, true);
    matchSecret(String(renew.headers.get('set-cookie')), /^copilot_auth=oars1_/);
    assert.equal(relay.rows().length, 1);
    // The renewal is a cookie write: from a same-site page it is refused.
    const sibling = await relay.call('/api/auth/session', { method: 'POST', headers: { ...pageHeaders(session), 'Sec-Fetch-Site': 'same-site', Origin: 'https://b.example.com' }, body: {} });
    assert.equal(sibling.status, 403);
    assert.equal(await codeOf(sibling), 'AUTH_CROSS_SITE');

    // A sign-in code (15): once.
    const { code } = relay.codes.mint();
    const viaCode = await signIn(relay, bearer(code), { deviceId: 'phone' });
    assert.equal(viaCode.status, 200);
    matchSecret(viaCode.proof, /^oark1_/);
    assert.equal(relay.rows().find((row) => row.device_id === 'phone').auth_method, 'code');
    assert.equal((await signIn(relay, bearer(code))).status, 401, 'a code works once');
    assert.equal((await relay.call('/api/status', { headers: bearer(relay.codes.mint().code) })).status, 401, 'a code is no API credential');

    // Agents and peers are refused, and a genuine agent token is no wrong guess.
    const agent = await relay.call('/api/auth/session', { method: 'POST', headers: { ...tunnel('203.0.113.5'), ...bearer(relay.store.mintAgentToken({ kind: 's', subject: 'conv-a' })) }, body: {} });
    assert.equal(agent.status, 403);
    assert.equal(await codeOf(agent), 'AUTH_PERSON_REQUIRED');
    assert.equal(relay.relayAuth.lockout.size(), 0);
    assert.equal(relay.rows().length, 2);
  } finally {
    await relay.close();
  }

  const locked = await startRelay();
  try {
    for (let index = 0; index < AUTH_FAILURE_LIMIT; index += 1) {
      const value = index % 2 ? `oarc1_${crypto.randomBytes(32).toString('base64url')}` : crypto.randomUUID();
      const wrong = await locked.call('/api/auth/session', { method: 'POST', headers: { ...tunnel('203.0.113.9'), ...bearer(value) }, body: {} });
      assert.equal(wrong.status, 401);
    }
    const blocked = await locked.call('/api/auth/session', { method: 'POST', headers: { ...tunnel('203.0.113.9'), ...bearer(LEGACY_TOKEN) }, body: {} });
    assert.equal(blocked.status, 429, 'wrong owner tokens and codes count toward the existing lockout');
    assert.equal(locked.rows().length, 0);
  } finally {
    await locked.close();
  }
});

test('15: an expired sign-in code is refused', async () => {
  const relay = await startRelay();
  try {
    const { code } = relay.codes.mint();
    relay.clock.now += 10 * 60_000 + 1;
    assert.equal((await relay.call('/api/auth/session', { method: 'POST', headers: bearer(code), body: {} })).status, 401);
    assert.equal(relay.rows().length, 0);
  } finally {
    await relay.close();
  }
});

test('cookie attributes (§0.4): Secure behind a trusted https proxy, none on LAN http, host-only, Max-Age = min(idle, absolute)', async () => {
  const relay = await startRelay();
  try {
    const proxied = await relay.call('/api/auth/session', { method: 'POST', headers: { ...bearer(LEGACY_TOKEN), 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.7' }, body: {} });
    const proxiedCookie = String(proxied.headers.get('set-cookie'));
    matchSecret(proxiedCookie, /^copilot_auth=oars1_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; SameSite=Lax; HttpOnly; Secure$/);
    const upgraded = await relay.call('/api/auth/session', { method: 'POST', headers: { Cookie: `${COOKIE}=${LEGACY_TOKEN}`, 'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.8' }, body: {} });
    matchSecret(String(upgraded.headers.get('set-cookie')), /; Secure$/, 'the upgrade cookie too');
    const plain = await relay.call('/api/auth/session', { method: 'POST', headers: bearer(LEGACY_TOKEN), body: {} });
    const plainCookie = String(plain.headers.get('set-cookie'));
    matchSecret(plainCookie, /^copilot_auth=oars1_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; SameSite=Lax; HttpOnly$/);
    for (const value of [proxiedCookie, plainCookie]) assert.doesNotMatch(value, /Domain=/i);
  } finally {
    await relay.close();
  }

  // LAN http with a proxy that is not trusted: its X-Forwarded-Proto is ignored.
  const lan = await startRelay({ trustProxy: '10.255.255.1' });
  try {
    const spoofed = await lan.call('/api/auth/session', { method: 'POST', headers: { ...bearer(LEGACY_TOKEN), 'X-Forwarded-Proto': 'https' }, body: {} });
    assert.equal(spoofed.status, 200);
    assert.doesNotMatch(String(spoofed.headers.get('set-cookie')), /Secure/);
  } finally {
    await lan.close();
  }
});

test('a write with a session cookie from a sibling host (same-site) gets 403; from the relay\'s page it passes', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay);
    const sibling = await relay.call('/api/message', { method: 'POST', headers: { ...pageHeaders(session), Host: 'a.example.com', Origin: 'https://b.example.com', 'Sec-Fetch-Site': 'same-site' }, body: { text: 'x' } });
    assert.equal(sibling.status, 403);
    assert.equal(await codeOf(sibling), 'AUTH_CROSS_SITE');
    // An old owner-token cookie on a cross-site write is refused too.
    const oldCrossSite = await relay.call('/api/message', { method: 'POST', headers: { Cookie: `${COOKIE}=${LEGACY_TOKEN}`, 'Sec-Fetch-Site': 'cross-site' }, body: {} });
    assert.equal(oldCrossSite.status, 403);
    assert.equal(relay.rows().length, 1, 'no session for a refused request');
    const own = await relay.call('/api/message', { method: 'POST', headers: pageHeaders(session), body: { text: 'x' } });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).principal.kind, 'browser');
  } finally {
    await relay.close();
  }
});

test('several copilot_auth values (another relay on this host, a longer path): the first valid one counts; a shadow never clears a valid cookie', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay);
    const secret = session.cookie.split('=').slice(1).join('=');
    const stranger = `oars1_${crypto.randomBytes(32).toString('base64url')}`;
    for (const cookie of [`${COOKIE}=${stranger}; ${COOKIE}=${secret}`, `${COOKIE}=${secret}; ${COOKIE}=${stranger}`, `${COOKIE}=%E0%A4%A; ${COOKIE}=${secret}`]) {
      const answer = await relay.call('/api/status', { headers: { Cookie: cookie, [PROOF]: session.proof, 'Sec-Fetch-Site': 'same-origin' } });
      assert.equal(answer.status, 200);
      assert.equal((await answer.json()).principal.sessionId, session.id);
      assert.equal(answer.headers.get('set-cookie'), null, 'nothing cleared');
    }
    // Only unknown values: signed out, and the cookie is cleared.
    const unknown = await relay.call('/api/status', { headers: { Cookie: `${COOKIE}=${stranger}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(unknown.status, 401);
    matchSecret(String(unknown.headers.get('set-cookie')), /copilot_auth=;.*Max-Age=0/);
    // A wrong Bearer leaves a valid cookie alone.
    const wrongBearer = await relay.call('/api/status', { headers: { ...pageHeaders(session), ...bearer(crypto.randomUUID()) } });
    assert.equal(wrongBearer.status, 401);
    assert.equal(wrongBearer.headers.get('set-cookie'), null);
  } finally {
    await relay.close();
  }
});

test('several copilot_auth values are no way around the lockout: only the first two are read, and every one of those that matches nothing counts', async () => {
  // Guesses spread over multi-value cookies, two per request: wrong values
  // in first and second place, on the API, the sign-in route and the socket.
  const relay = await startRelay();
  try {
    const guess = () => `oars1_${crypto.randomBytes(32).toString('base64url')}`;
    const from = tunnel('203.0.113.40');
    const pair = () => `${COOKIE}=${guess()}; ${COOKIE}=${crypto.randomUUID()}`;
    assert.equal((await relay.call('/api/status', { headers: { ...from, Cookie: pair() } })).status, 401);
    assert.equal((await relay.call('/api/auth/session', { method: 'POST', headers: { ...from, 'Sec-Fetch-Site': 'same-origin', Cookie: pair() }, body: {} })).status, 401);
    const socket = { request: { headers: { cookie: pair(), 'cf-ray': from['cf-ray'], 'x-forwarded-for': from['x-forwarded-for'] }, socket: { remoteAddress: '127.0.0.1' } }, handshake: { auth: {}, query: {} } };
    let outcome = null;
    relay.relayAuth.socketMiddleware(socket, (error) => { outcome = error || 'ok'; });
    assert.equal(outcome.message, 'Unauthorized');
    // 6 counted; the 11th distinct wrong value (two more requests) locks.
    assert.equal((await relay.call('/api/status', { headers: { ...from, Cookie: pair() } })).status, 401);
    assert.equal((await relay.call('/api/status', { headers: { ...from, Cookie: `${COOKIE}=${guess()}; ${COOKIE}=${guess()}; ${COOKIE}=${guess()}` } })).status, 401);
    const locked = await relay.call('/api/status', { headers: { ...from, Cookie: pair() } });
    assert.equal(locked.status, 429, 'ten wrong values spread over multi-value cookies hit the lockout');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  } finally {
    await relay.close();
  }

  // A right value in third place is never read: no 403 that would tell a
  // guess was right (the old owner token, AUTH_COOKIE_UPGRADE), no session.
  const third = await startRelay();
  try {
    const session = await signIn(third);
    const secret = session.cookie.split('=').slice(1).join('=');
    const wrong = () => crypto.randomUUID();
    const from = tunnel('203.0.113.41');
    const legacyThird = await third.call('/api/status', { headers: { ...from, Cookie: `${COOKIE}=${wrong()}; ${COOKIE}=${wrong()}; ${COOKIE}=${LEGACY_TOKEN}` } });
    assert.equal(legacyThird.status, 401);
    assert.equal(await codeOf(legacyThird), 'AUTH_SIGNED_OUT');
    const sessionThird = await third.call('/api/status', { headers: { ...from, Cookie: `${COOKIE}=${wrong()}; ${COOKIE}=${wrong()}; ${COOKIE}=${secret}`, [PROOF]: session.proof, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(sessionThird.status, 401);
    // In second place it is read.
    const legacySecond = await third.call('/api/status', { headers: { ...from, Cookie: `${COOKIE}=${wrong()}; ${COOKIE}=${LEGACY_TOKEN}` } });
    assert.equal(legacySecond.status, 403);
    assert.equal(await codeOf(legacySecond), 'AUTH_COOKIE_UPGRADE');
    const sessionSecond = await third.call('/api/status', { headers: { ...from, Cookie: `${COOKIE}=${wrong()}; ${COOKIE}=${secret}`, [PROOF]: session.proof, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(sessionSecond.status, 200);
  } finally {
    await third.close();
  }
});

test('a rotation: the old cookie and Bearer fail at once, sessions stay', async () => {
  const relay = await startRelay();
  try {
    const old = { Cookie: `${COOKIE}=${LEGACY_TOKEN}` };
    const session = await signIn(relay, old);
    relay.store.rotateOwnerToken({ reason: 'test' });
    const after = await relay.call('/api/auth/session', { method: 'POST', headers: { ...old, 'Sec-Fetch-Site': 'same-origin' }, body: {} });
    assert.equal(after.status, 401);
    assert.equal(await codeOf(after), 'AUTH_SIGNED_OUT');
    assert.equal((await relay.call('/api/status', { headers: old })).status, 401);
    assert.equal((await relay.call('/api/status', { headers: bearer(LEGACY_TOKEN) })).status, 401);
    assert.equal((await relay.call('/api/status', { headers: pageHeaders(session) })).status, 200);
    assert.equal(relay.rows().length, 1);
  } finally {
    await relay.close();
  }
});

test('Socket.IO: a session cookie connects with its key (auth.proof) and tags the socket; without the key, or revoked, it is refused and not counted', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay);
    const handshake = (auth) => ({ request: { headers: { cookie: session.cookie }, socket: { remoteAddress: '198.51.100.20' } }, handshake: { auth, query: {} } });
    const run = (socket) => {
      let outcome = null;
      relay.relayAuth.socketMiddleware(socket, (error) => { outcome = error || 'ok'; });
      return outcome;
    };
    const withKey = handshake({ proof: session.proof });
    assert.equal(run(withKey), 'ok');
    assert.equal(withKey.data.browserSessionId, session.id);
    for (const auth of [{}, { proof: `oark1_${crypto.randomBytes(32).toString('base64url')}` }, { proof: '' }]) {
      const refused = run(handshake(auth));
      assert.equal(refused.message, 'Unauthorized');
      assert.equal(refused.data?.code, 'AUTH_SESSION_PROOF');
    }
    // An old owner-token cookie has no key: refused with its own code (the page trades it first).
    const legacy = { request: { headers: { cookie: `${COOKIE}=${LEGACY_TOKEN}` }, socket: { remoteAddress: '198.51.100.20' } }, handshake: { auth: {}, query: {} } };
    assert.equal(run(legacy).data?.code, 'AUTH_COOKIE_UPGRADE');
    assert.equal(relay.relayAuth.lockout.size(), 0, 'a real cookie without its key is no wrong guess');
    relay.sessions.revoke(session.id);
    assert.equal(run(handshake({ proof: session.proof })).message, 'Unauthorized');
  } finally {
    await relay.close();
  }
});

test('onSessionCreated: token, code and terminal sign-ins, each with its proof key; never the old-cookie trade or a renewal', async () => {
  const relay = await startRelay();
  try {
    // The old cookie: refused on a route, traded at the sign-in route; silent.
    const old = { Cookie: `${COOKIE}=${LEGACY_TOKEN}` };
    assert.equal((await relay.call('/api/status', { headers: old })).status, 403);
    const traded = await signIn(relay, { ...old, 'User-Agent': 'Other/1.0' }, { deviceId: 'old-two' });
    assert.equal(traded.status, 200);
    matchSecret(traded.proof, /^oark1_/);
    assert.deepEqual(relay.created, [], 'no notice for the old-cookie trade');

    // The relay token at the sign-in route.
    const session = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-1' });
    assert.equal(session.status, 200);
    matchSecret(session.proof, /^oark1_/);
    assert.deepEqual(relay.created.map((entry) => [entry.via, entry.method]), [['token', 'token']]);
    assert.equal(relay.created[0].id, session.id);
    // A renewal (cookie and key, or with the token too) is no new sign-in.
    await relay.call('/api/auth/session', { method: 'POST', headers: pageHeaders(session), body: { deviceId: 'dev-1' } });
    await relay.call('/api/auth/session', { method: 'POST', headers: { ...pageHeaders(session), ...bearer(LEGACY_TOKEN) }, body: { deviceId: 'dev-1' } });
    assert.equal(relay.created.length, 1);

    // A Bearer request from the relay's own page makes no session at all.
    const page = { ...bearer(LEGACY_TOKEN), 'Sec-Fetch-Site': 'same-origin', 'User-Agent': 'Cached/2.0' };
    const parallel = await Promise.all(Array.from({ length: 4 }, () => relay.call('/api/status', { headers: page })));
    assert.deepEqual(parallel.map((answer) => answer.status), [200, 200, 200, 200]);
    assert.equal(relay.created.length, 1);

    // The token over a cookie without its key: a new session in place of the
    // old one, and a new sign-in.
    const again = await signIn(relay, { Cookie: session.cookie, ...bearer(LEGACY_TOKEN) }, { deviceId: 'dev-1' });
    assert.equal(again.status, 200);
    assert.notEqual(again.id, session.id);
    assert.equal(relay.sessions.get(session.id), null, 'the old row is gone');
    assert.deepEqual(relay.created.map((entry) => entry.via), ['token', 'token']);

    // A sign-in link (Settings) and a terminal code: each answers its key.
    const link = relay.codes.mint({ via: 'code', minter: 'bs_x' }).code;
    const viaLink = await signIn(relay, bearer(link), { deviceId: 'phone' });
    assert.equal(viaLink.status, 200);
    matchSecret(viaLink.proof, /^oark1_/);
    const terminal = relay.codes.mint({ via: 'terminal', minter: 'terminal' }).code;
    const viaTerminal = await signIn(relay, bearer(terminal), { deviceId: 'tablet' });
    assert.equal(viaTerminal.status, 200);
    matchSecret(viaTerminal.proof, /^oark1_/);
    assert.equal((await relay.call('/api/status', { headers: pageHeaders(viaTerminal) })).status, 200, 'the terminal session works with its key');
    assert.deepEqual(relay.created.map((entry) => [entry.via, entry.method]), [['token', 'token'], ['token', 'token'], ['code', 'code'], ['terminal', 'terminal']]);
    assert.equal(relay.rows().find((row) => row.device_id === 'tablet').auth_method, 'terminal');
    assert.ok(relay.logs.some((line) => /a sign-in code from the oar command \(terminal\) signed in browser session bs_/.test(line)));
    assert.ok(relay.logs.every((line) => !/oark1_|oarc1_|oars1_/.test(line)), 'no credential in the log');
  } finally {
    await relay.close();
  }
});

test('the sign-in notice and the signed-in browsers list: a forwarded address from a loopback peer is shown as this host, never alone (a touch keeps it so)', async () => {
  const relay = await startRelay();
  try {
    // From this host with no forwarding header: the peer itself.
    await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-local' });
    assert.equal(relay.created.at(-1).address, '127.0.0.1');
    // From this host, claiming a LAN address.
    await signIn(relay, { ...bearer(LEGACY_TOKEN), 'X-Forwarded-For': '192.168.1.23' }, { deviceId: 'dev-spoof' });
    assert.equal(relay.created.at(-1).address, 'this host (forwarded for 192.168.1.23)');
    // Through the tunnel marker on this host.
    await signIn(relay, { ...bearer(LEGACY_TOKEN), ...tunnel('203.0.113.9') }, { deviceId: 'dev-tunnel' });
    assert.equal(relay.created.at(-1).address, 'this host (forwarded for 203.0.113.9)');
    // A forwarding header that names no address: this host alone.
    await signIn(relay, { ...bearer(LEGACY_TOKEN), Forwarded: 'proto=https' }, { deviceId: 'dev-bare' });
    assert.equal(relay.created.at(-1).address, 'this host');
    const shown = relay.notices.listFor().map((notice) => notice.address);
    assert.deepEqual(shown, ['this host', 'this host (forwarded for 203.0.113.9)', 'this host (forwarded for 192.168.1.23)', '127.0.0.1']);
    assert.ok(shown.every((address) => address === '127.0.0.1' || address.startsWith('this host')));
    // The signed-in browsers list says the same: never a forwarded address alone.
    const listed = async (headers) => {
      const response = await relay.call('/api/auth/sessions', { headers });
      assert.equal(response.status, 200);
      return Object.fromEntries((await response.json()).sessions.map((row) => [row.id, row.lastIp]));
    };
    const local = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-list' });
    const spoof = await signIn(relay, { ...bearer(LEGACY_TOKEN), 'X-Forwarded-For': '192.168.1.23' }, { deviceId: 'dev-list-spoof' });
    let addresses = await listed(pageHeaders(local));
    assert.equal(addresses[local.id], '127.0.0.1');
    assert.equal(addresses[spoof.id], 'this host (forwarded for 192.168.1.23)');
    assert.ok(Object.values(addresses).every((address) => address === '127.0.0.1' || address.startsWith('this host')));
    // A touch from the same page keeps it so; a touch with a forwarding header turns a plain row into it.
    relay.clock.now += BROWSER_SESSION_TOUCH_INTERVAL_MS + 1;
    assert.equal((await relay.call('/api/status', { headers: { ...pageHeaders(spoof), 'X-Forwarded-For': '192.168.1.23' } })).status, 200);
    assert.equal((await relay.call('/api/status', { headers: { ...pageHeaders(local), 'X-Forwarded-For': '10.0.0.7' } })).status, 200);
    addresses = await listed(pageHeaders(spoof));
    assert.equal(addresses[spoof.id], 'this host (forwarded for 192.168.1.23)');
    assert.equal(addresses[local.id], 'this host (forwarded for 10.0.0.7)');
    assert.equal(relay.rows().find((row) => row.id === spoof.id).last_seen_at, new Date(relay.clock.now).toISOString(), 'the touch was written');
    assert.ok(Object.values(addresses).every((address) => !/^(192\.168\.1\.23|10\.0\.0\.7|203\.0\.113\.9)$/.test(address)));
  } finally {
    await relay.close();
  }
});

test('onSessionCreated runs before the sign-in answers, and a hook that throws does not fail the sign-in', async () => {
  const relay = await startRelay();
  try {
    // The hook is called synchronously inside the handler: by the time the
    // answer arrives it has run (the notice and its push are under way).
    const answer = await relay.call('/api/auth/session', { method: 'POST', headers: bearer(LEGACY_TOKEN), body: { deviceId: 'dev-9' } });
    assert.equal(answer.status, 200);
    const body = await answer.json();
    assert.equal(relay.created.at(-1).id, body.session.id);
  } finally {
    await relay.close();
  }
});

test('the service worker path: a POST from the relay\'s own scope with the cookie and the key from IndexedDB is the browser; without the key or same-site it is refused', async () => {
  const relay = await startRelay();
  try {
    const session = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-sw' });
    const own = await relay.call('/api/message', { method: 'POST', headers: pageHeaders(session), body: { answer: 'yes' } });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).principal.kind, 'browser');
    const noKey = await relay.call('/api/message', { method: 'POST', headers: { Cookie: session.cookie, 'Sec-Fetch-Site': 'same-origin' }, body: { answer: 'yes' } });
    assert.equal(noKey.status, 403);
    assert.equal((await noKey.json()).code, 'AUTH_SESSION_PROOF');
    const sibling = await relay.call('/api/message', { method: 'POST', headers: { ...pageHeaders(session), 'Sec-Fetch-Site': 'same-site' }, body: { answer: 'yes' } });
    assert.equal(sibling.status, 403);
  } finally {
    await relay.close();
  }
});

test('lastNonBrowserUse: a Bearer owner token without same-origin is recorded by address, never a browser, never the value', async () => {
  const relay = await startRelay();
  try {
    await relay.call('/api/status', { headers: { ...bearer(LEGACY_TOKEN), ...tunnel('203.0.113.77') } });
    assert.deepEqual(relay.ownerUses, [{ address: '203.0.113.77' }]);
    // The relay's own page (same-origin), a session cookie, an agent token: none.
    await relay.call('/api/status', { headers: { ...bearer(LEGACY_TOKEN), 'Sec-Fetch-Site': 'same-origin' } });
    const session = await signIn(relay, bearer(LEGACY_TOKEN), { deviceId: 'dev-2' });
    await relay.call('/api/status', { headers: pageHeaders(session) });
    await relay.call('/api/status', { headers: bearer(relay.store.mintAgentToken({ kind: 'c' })) });
    assert.equal(relay.ownerUses.length, 1);
    assert.ok(JSON.stringify(relay.ownerUses).indexOf(LEGACY_TOKEN) === -1);
  } finally {
    await relay.close();
  }
});
