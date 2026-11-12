import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';

import { createRelayAuth } from './relay-auth.mjs';
import { principalOf } from './relay-principal.mjs';
import { createRemoteRelayClient } from './remote-relay-client.mjs';
import { createRemoteRelayRegistry } from './remote-relay-registry-service.mjs';
import { createRemoteRelayPairing } from './remote-relay-pairing.mjs';
import {
  PEER_KEY_LIMITS,
  createPeerKeyService,
  describePeerKeyState,
  hashPeerKey,
  mintPeerKey,
  normalizePeerKeyFields,
  peerKeyRotationProof,
  pinnedUrlKey,
  usablePeerToken,
} from './remote-relay-peer-keys.mjs';
import {
  findOriginRemoteRelay,
  originCarriesWeight,
  originWeightedFor,
  readRemoteRelayRequest,
  remoteOriginAnswerFields,
} from './remote-relay-inbound.mjs';
import { registerRemoteRelayRoutes } from '../routes/remote-relay-routes.mjs';
import { affectedRelaysOf } from '../routes/auth-routes.mjs';
import {
  REMOTE_RELAY_ERROR_CODES as CODES,
  REMOTE_RELAY_INBOUND_KEY_PATH,
  REMOTE_RELAY_PEER_KEY_PATHS,
  REMOTE_RELAY_PEER_ROUTES,
} from '../../shared/remote-relay-contract.mjs';
import { RELAY_ROUTE_POLICY } from '../../shared/relay-route-policy.mjs';

// Peer keys and origin binding between two (and three) real relays in this
// process: the registry, client, pairing, key service, `auth` and the routes
// as the runtime wires them, over loopback HTTP. Every token and key is made
// at run time and never printed; names and ids are made up.

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function quietLogger() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

async function startRelay(name, { db = null, port = 0, settings: kept = null, ownerToken = '' } = {}) {
  // `port`, `settings` and `ownerToken` of a relay that stopped start it
  // again on its state, at its address (a restart).
  const settings = kept || new Map();
  // With `db` (a SQLite file in WAL mode, as the relay runs it), every
  // setting written is written there too.
  const upsert = db?.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const logger = quietLogger();
  // `offsetMs` moves this relay's clock (rate limits, rotation). `oldVersion`
  // makes it answer like a 0.9.26 relay: protocol 1 in its identity, and a
  // peer key is just an unknown token (401). `noInboundKeys`: a protocol-2
  // build without the inbound-only key route (404 there). `failKeyCheck`:
  // the key check route fails (500). `agentToken`: an agent token it takes.
  const state = {
    ownerToken: ownerToken || `oaro1_${crypto.randomBytes(32).toString('base64url')}`,
    agentToken: `oara1_${crypto.randomBytes(32).toString('base64url')}`,
    offsetMs: 0,
    oldVersion: false,
    noInboundKeys: false,
    failKeyCheck: false,
    // Every Authorization value that reached this relay (compared, never printed).
    seenAuth: [],
  };
  const now = () => new Date(Date.now() + state.offsetMs);
  const app = express();
  app.use((req, _res, next) => {
    state.seenAuth.push(String(req.headers.authorization || ''));
    next();
  });
  app.use(express.json());
  app.use((req, res, next) => {
    if (state.noInboundKeys && req.path === REMOTE_RELAY_INBOUND_KEY_PATH) return res.status(404).send('Cannot POST');
    if (state.failKeyCheck && req.path === REMOTE_RELAY_PEER_KEY_PATHS.check) return res.status(500).json({ error: 'the check failed (test)' });
    return next();
  });
  app.use((req, res, next) => {
    if (!state.oldVersion || req.method !== 'GET' || req.path !== '/api/relay/identity') return next();
    const json = res.json.bind(res);
    res.json = (body) => json({ ...body, version: '0.9.26', remoteRelays: { protocol: 1, inbound: true } });
    return next();
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(port, '127.0.0.1', () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let instanceCounter = 0;
  const client = createRemoteRelayClient({ getOwnRelayId: () => registry.instanceId() });
  const registry = createRemoteRelayRegistry({
    readSetting: (key) => settings.get(key) ?? null,
    writeSetting: (key, value) => {
      settings.set(key, value);
      upsert?.run(key, value);
    },
    client,
    getSelfName: () => name,
    version: '0.9.27',
    randomUUID: () => `${name}-${(instanceCounter += 1)}-${crypto.randomUUID()}`,
    logger,
  });
  registry.setSelfSettings({ publicUrl: baseUrl });
  const peerKeys = createPeerKeyService({ registry, client, logger, now });
  registry.setPeerKeys(peerKeys);
  client.setPeerKeyHooks({
    worked: (relay) => peerKeys.noteHeldKeyWorked(relay),
    refused: (relay) => peerKeys.onHeldKeyRefused(relay),
    required: (relay) => peerKeys.noteKeyRequired(relay),
  });
  const pairing = createRemoteRelayPairing({ registry, client, peerKeys, logger });
  const inbound = {
    listRelays: () => registry.list().map(({ id, relayId, name: entryName, url, protocol, epoch, identityHold }) => ({ id, relayId, name: entryName, url, protocol, epoch, identityHold: !!identityHold })),
    selfNames: () => [name],
    inboundEnabled: () => true,
  };
  const relayAuth = createRelayAuth({
    app,
    getAuthToken: () => state.ownerToken,
    verifyAgentToken: (value) => (value === state.agentToken ? { kind: 's', subject: 'conv-agent-1' } : null),
    resolvePeerKey: (value, req) => (state.oldVersion ? null : peerKeys.resolvePeerKey(value)
      || (req?.route?.path === '/api/remote-relays/peer-key/request' ? peerKeys.resolveRetiredKey(value) : null)),
    afterPrincipal: (req, res, principal) => peerKeys.gate(req, res, principal),
    cookieName: 'copilot_auth',
    parseCookies,
    appendSetCookie: () => {},
    logger,
  });
  const { auth } = relayAuth;
  registerRemoteRelayRoutes(app, { auth, registry, pairing, peerKeys, remoteRelayInbound: inbound });
  // What the prompt routes read of a request, as /api/message does.
  const seen = [];
  app.post('/api/message', auth, (req, res) => {
    const request = readRemoteRelayRequest(req, inbound);
    seen.push({ request, principal: principalOf(req) });
    res.json({ ok: true, ...remoteOriginAnswerFields(request) });
  });
  // A route that needs the caller's key, as the Inbox read, asks and watches do.
  app.get('/api/relay-asks/remote/inbox', auth, (req, res) => {
    const request = readRemoteRelayRequest(req, inbound);
    if (request.verified !== true) return res.status(403).json({ error: request.unverifiedNotice || 'needs a key', code: CODES.peerKeyRequired });
    return res.json({ items: [] });
  });
  app.post('/api/conversation/:id/billing', auth, (_req, res) => res.json({ ok: true }));
  app.post('/api/settings/features', auth, (_req, res) => res.json({ ok: true }));
  app.get('/api/status', auth, (_req, res) => res.json({ ok: true, version: '0.9.27' }));

  async function call(route, { method = 'GET', token = state.ownerToken, headers = {}, body } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await response.json(); } catch {}
    return { status: response.status, body: json };
  }

  return {
    name,
    baseUrl,
    state,
    settings,
    registry,
    client,
    peerKeys,
    pairing,
    inbound,
    logger,
    seen,
    call,
    entryFor: (other) => registry.list().find((entry) => entry.relayId === other.registry.instanceId()) || null,
    // The inbound-only entry `other` holds a key from (no address here).
    holderFor: (other) => registry.listAll().find((entry) => entry.inboundOnly && entry.relayId === other.registry.instanceId()) || null,
    close: () => new Promise((resolve) => server.close(resolve)),
    // Stops at once, kept-alive connections too (a restart follows).
    stop: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
    port: server.address().port,
  };
}

/** Lets setImmediate hooks (the confirming call, the token drop) run. */
async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 15));
}

/** Waits until `fn()` is truthy (a few seconds at most). */
async function until(fn, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The issuer's current key for an entry: confirmed, not retiring. */
function currentKeyHash(relay, entry) {
  return (relay.registry.get(entry.id)?.peerKeys || [])
    .filter((key) => key.confirmedAt && !key.retiresAt)
    .sort((x, y) => y.seq - x.seq)[0]?.hash || null;
}

async function pairedRelays() {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  const added = await a.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(b.state.ownerToken)}` });
  await settle();
  return { a, b, added };
}

function noSecrets(value, ...secrets) {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret) assert.equal(text.includes(secret), false, 'no token or key in a public view');
  }
}

test('pairing both ways with keys: each relay holds the other\'s key, drops the token, and nothing public carries one', async (t) => {
  const { a, b, added } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.pairedBack, true);
  assert.deepEqual(added.keys, { ours: { ok: true }, theirs: { ok: true } });
  const onA = a.entryFor(b);
  const onB = b.entryFor(a);
  assert.ok(onA && onB, 'each relay lists the other');
  // Holder side: a key from the other relay; A dropped B's owner token.
  assert.ok(onA.peerToken && onB.peerToken);
  assert.equal(onA.tokenMode, 'peer');
  assert.equal(onA.token, undefined);
  // Issuer side: a confirmed key each, the entries pinned.
  for (const [relay, entry] of [[a, onA], [b, onB]]) {
    const view = relay.registry.listPublic().find((item) => item.id === entry.id);
    assert.equal(view.peerKeyConfirmed, true, relay.name);
    assert.equal(view.peerKey.status, 'active');
    assert.equal(view.peerKey.theirKey, true);
    assert.equal(entry.everKeyed, true);
    noSecrets(view, onA.peerToken, onB.peerToken, b.state.ownerToken, a.state.ownerToken);
    assert.equal('peerKeys' in view, false);
  }
  assert.equal(onA.unconfirmed, false);
  assert.equal(onB.unconfirmed, false, 'the key check proved who answers at that address');
});

test('a two-way add never writes the other relay\'s token to the database or its write-ahead file', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-pairing-db-'));
  const file = path.join(dir, 'oar.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
  const a = await startRelay('relay-alpha', { db });
  const b = await startRelay('relay-beta');
  t.after(async () => {
    await a.close();
    await b.close();
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const added = await a.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(b.state.ownerToken)}` });
  assert.equal(added.ok, true);
  await settle();
  assert.equal(a.entryFor(b).tokenMode, 'peer', 'the key works');
  const bytes = () => Buffer.concat([file, `${file}-wal`].filter((name) => fs.existsSync(name)).map((name) => fs.readFileSync(name)));
  // The scan sees what was written: the key A holds from B is there.
  assert.equal(bytes().includes(Buffer.from(a.entryFor(b).peerToken)), true, 'the scan reads the written settings');
  assert.equal(bytes().includes(Buffer.from(b.state.ownerToken)), false, 'no copy of the other relay\'s token');
  // Nor after a checkpoint and a clean close.
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  assert.equal(bytes().includes(Buffer.from(b.state.ownerToken)), false, 'no copy after a checkpoint');
});

test('a two-way add with a relay that gives no key keeps its token (written once the add ends)', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  // B answers with keys but refuses to check them: A ends the add without a working key.
  b.state.failKeyCheck = true;
  a.state.failKeyCheck = true;
  const added = await a.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(b.state.ownerToken)}` });
  assert.equal(added.ok, true);
  await settle();
  const entry = a.entryFor(b);
  assert.equal(entry.tokenMode, 'custom');
  assert.equal(entry.token === b.state.ownerToken, true, 'the token is kept, so the pairing keeps working');
  assert.equal(a.settings.get('remote_relays').includes(b.state.ownerToken), true, 'and it is stored');
});

test('a prompt with the key is verified: the relay part comes from the registry, the session part is the sender\'s', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const onA = a.entryFor(b);
  b.registry.patchPeerFields(b.entryFor(a).id, { name: 'alpha as B calls it' });
  await a.client.request(onA, 'POST', '/api/message', {
    body: { text: 'hi', origin: { relayId: a.registry.instanceId(), relayName: 'claimed name', relayUrl: 'https://elsewhere.example.test', conversationId: 'conv-1', hops: 0 } },
  });
  const { request, principal } = b.seen.at(-1);
  assert.equal(principal.kind, 'peer');
  assert.equal(request.verified, true);
  assert.equal(request.origin.relayName, 'alpha as B calls it');
  assert.equal(request.origin.relayUrl, a.baseUrl);
  assert.equal(request.origin.conversationId, 'conv-1');
  assert.equal(request.origin.hops, 1);
  assert.equal(originCarriesWeight(request.origin, (id) => b.registry.get(id)), true);
  assert.equal(findOriginRemoteRelay(b.inbound, request.origin).relayId, b.entryFor(a).id);
});

test('a key claiming another relay: 403 ORIGIN_MISMATCH, counted, one log line, exactly one Inbox item', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const key = a.entryFor(b).peerToken;
  const before = b.seen.length;
  const first = await b.call('/api/message', { method: 'POST', token: key, body: { text: 'x', origin: { relayId: 'relay-gamma-id' } } });
  assert.equal(first.status, 403);
  assert.equal(first.body.code, CODES.originMismatch);
  const second = await b.call('/api/message', { method: 'POST', token: key, headers: { 'x-oar-remote-origin': 'relay-gamma-id' }, body: { text: 'y' } });
  assert.equal(second.body.code, CODES.originMismatch);
  assert.equal(b.seen.length, before, 'nothing reached the route');
  const entryId = b.entryFor(a).id;
  assert.equal(b.peerKeys.refusedCount(entryId), 2);
  assert.equal(b.registry.listPublic().find((item) => item.id === entryId).refusedClaims, 2);
  const items = b.peerKeys.refusalNoticeItems();
  assert.equal(items.length, 1, 'one Inbox item per relay, on its first refusal');
  assert.equal(items[0].kind, 'relay_notice');
  assert.match(items[0].question, /claiming to be another relay; it was refused/);
  const lines = b.logger.lines.filter((line) => line.startsWith('[remote-relays] origin refused: REMOTE_RELAY_ORIGIN_MISMATCH'));
  // One line per refusal, at most one per relay, code and route a minute:
  // the second is held back and summed into the next line.
  assert.equal(lines.length, 1);
  assert.match(lines[0], /peer=relay-alpha claimed=relay-ga route=POST \/api\/message/);
  for (const line of b.logger.lines) assert.equal(line.includes(key), false, 'the key is never logged');
  // Dismissed, it stays dismissed; a later refusal adds none.
  b.peerKeys.dismissRefusalNotice(entryId);
  await b.call('/api/message', { method: 'POST', token: key, body: { origin: { relayId: 'relay-gamma-id' } } });
  assert.equal(b.peerKeys.refusalNoticeItems().length, 0);
  assert.equal(b.peerKeys.refusedCount(entryId), 3);
});

test('the owner token claiming a keyed relay: 403 PEER_KEY_REQUIRED, counted on it, and no key is issued', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entry = b.entryFor(a);
  const seqBefore = entry.peerKeySeq;
  const refused = await b.call('/api/message', { method: 'POST', headers: { 'x-oar-remote-origin': a.registry.instanceId() }, body: { text: 'x' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, CODES.peerKeyRequired);
  assert.equal(b.peerKeys.refusedCount(entry.id), 1);
  assert.equal(b.entryFor(a).peerKeySeq, seqBefore, 'a refusal issues nothing');
  assert.match(b.peerKeys.refusalNoticeItems()[0].question, /without its key/);
  // A claim of a relay without a key: stored unverified, with the notice.
  const unkeyed = await b.call('/api/message', { method: 'POST', headers: { 'x-oar-remote-origin': 'relay-unknown-id' }, body: { text: 'y' } });
  assert.equal(unkeyed.status, 200);
  assert.equal(unkeyed.body.originVerified, false);
  assert.match(unkeyed.body.originNotice, /Arrived unverified/);
  assert.equal(b.seen.at(-1).request.origin.verified, false);
});

test('an agent token claiming a keyed relay: the claim is ignored, nothing is refused or counted', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entry = b.entryFor(a);
  const answer = await b.call('/api/message', {
    method: 'POST',
    token: b.state.agentToken,
    headers: { 'x-oar-remote-origin': a.registry.instanceId() },
    body: { text: 'x', origin: { relayId: a.registry.instanceId(), conversationId: 'conv-1' } },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const { request, principal } = b.seen.at(-1);
  assert.equal(principal.kind, 'agent');
  assert.deepEqual([request.remote, request.origin], [false, null]);
  assert.equal(b.peerKeys.refusedCount(entry.id), 0);
  assert.deepEqual(b.peerKeys.refusalNoticeItems(), []);
  // A's own key still speaks for A, verified.
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'hi', origin: { relayId: a.registry.instanceId(), conversationId: 'conv-1' } } });
  const keyed = b.seen.at(-1);
  assert.deepEqual([keyed.principal.kind, keyed.request.verified, keyed.request.origin.entryId], ['peer', true, entry.id]);
});

test('least privilege: a key outside the relay routes gets 403 REMOTE_RELAY_PEER_SCOPE, never an answer', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const key = a.entryFor(b).peerToken;
  for (const [method, route] of [
    ['POST', '/api/conversation/c-1/billing'],
    ['POST', '/api/settings/features'],
    ['POST', '/api/remote-relays/pair'],
    ['GET', '/api/remote-relays'],
    ['PATCH', `/api/remote-relays/${b.entryFor(a).id}`],
    ['POST', `/api/remote-relays/${b.entryFor(a).id}/repair`],
  ]) {
    const answer = await b.call(route, { method, token: key, body: method === 'GET' ? undefined : {} });
    assert.equal(answer.status, 403, `${method} ${route}`);
    assert.equal(answer.body.code, CODES.peerScope, `${method} ${route}`);
  }
  // In scope: identity and the prompt route.
  assert.equal((await b.call('/api/relay/identity', { token: key })).status, 200);
});

test('the peer column is REMOTE_RELAY_PEER_ROUTES, and answering, billing and pairing stay out of it', () => {
  const allowed = [...RELAY_ROUTE_POLICY].filter(([, policy]) => policy.peer !== 'deny').map(([key]) => key).sort();
  assert.deepEqual(allowed, [...REMOTE_RELAY_PEER_ROUTES].sort());
  for (const key of [
    'POST /api/conversation/:id/billing',
    'POST /api/relay-question/:id/answer',
    'POST /api/relay-question/:id/dismiss',
    'POST /api/relay-asks/remote/answer',
    'POST /api/relay-asks/remote/dismiss',
    'POST /api/relay-board/:id/action',
    'POST /api/remote-relays/pair',
  ]) {
    assert.equal(REMOTE_RELAY_PEER_ROUTES.includes(key), false, key);
  }
});

test('owner token rotation: keyed peers keep working, the old token is refused, affectedRelays lists only unkeyed ones', async (t) => {
  const { a, b } = await pairedRelays();
  const c = await startRelay('relay-gamma');
  t.after(async () => { await a.close(); await b.close(); await c.close(); });
  const d = await startRelay('relay-delta');
  t.after(() => d.close());
  // C adds B one way (no public URL on C's side): B gives it an inbound-only
  // key. D adds B one way while B has no such route (an older build): D
  // keeps B's token.
  c.registry.setSelfSettings({ publicUrl: '' });
  const oneWay = await c.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  assert.equal(oneWay.ok, true, JSON.stringify(oneWay));
  assert.equal(oneWay.oneWay, 'inbound-only');
  b.state.noInboundKeys = true;
  const fallback = await d.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  b.state.noInboundKeys = false;
  assert.equal(fallback.ok, true, JSON.stringify(fallback));
  assert.equal(d.entryFor(b).tokenMode, 'custom');
  const oldToken = b.state.ownerToken;
  b.state.ownerToken = `oaro1_${crypto.randomBytes(32).toString('base64url')}`;
  // A, keyed: works.
  const fromA = await a.client.request(a.entryFor(b), 'GET', '/api/relay/identity');
  assert.equal(fromA.relayId, b.registry.instanceId());
  // The old token: refused.
  assert.equal((await b.call('/api/status', { token: oldToken })).status, 401);
  // C's inbound-only key survives the rotation; its prompts stay verified.
  await c.client.request(c.entryFor(b), 'POST', '/api/message', { body: { text: 'after rotation', origin: { relayId: c.registry.instanceId() } } });
  assert.equal(b.seen.at(-1).request.verified, true);
  assert.equal(b.seen.at(-1).request.origin.entryId, b.holderFor(c).id);
  // D, on the old token: refused until re-paired.
  await assert.rejects(() => d.client.request(d.entryFor(b), 'GET', '/api/status'), (error) => error.code === CODES.unauthorized);
  const affected = affectedRelaysOf(b.registry.listPublic());
  assert.deepEqual(affected.map((relay) => relay.id), [], 'B issued keys to A only; C is inbound only there and D is not listed');
  const affectedOnA = affectedRelaysOf(a.registry.listPublic());
  assert.deepEqual(affectedOnA, [], 'A\'s entry for B holds a confirmed key');
});

test('a fake delivery (an owner token posting a key "from B") fails its check at B and is dropped', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const heldBefore = a.entryFor(b).peerToken;
  const forged = mintPeerKey();
  const answer = await a.call('/api/remote-relays/peer-key', {
    method: 'POST',
    body: { issuer: b.registry.instanceId(), seq: 99, key: forged, proof: peerKeyRotationProof(heldBefore, 99, forged) },
  });
  assert.equal(answer.status, 403);
  assert.equal(a.entryFor(b).peerToken, heldBefore, 'A keeps its key');
  // Without a proof it is refused before any check.
  const unproven = await a.call('/api/remote-relays/peer-key', { method: 'POST', body: { issuer: b.registry.instanceId(), seq: 100, key: mintPeerKey() } });
  assert.equal(unproven.status, 403);
  // A replay of an older seq is a no-op.
  const replay = await a.call('/api/remote-relays/peer-key', { method: 'POST', body: { issuer: b.registry.instanceId(), seq: 1, key: mintPeerKey() } });
  assert.equal(replay.body.unchanged, true);
  assert.equal(a.entryFor(b).peerToken, heldBefore);
});

test('a delivery comes from its issuer: another paired relay\'s key delivering "from B" gets 403 and nothing is checked at B', async (t) => {
  const { a, b } = await pairedRelays();
  const c = await startRelay('relay-gamma');
  t.after(async () => { await a.close(); await b.close(); await c.close(); });
  await a.pairing.addFromLink({ url: `${c.baseUrl}/?token=${encodeURIComponent(c.state.ownerToken)}` });
  await settle();
  const keyOfC = c.entryFor(a)?.peerToken;
  assert.ok(keyOfC, 'C holds a key from A');
  const heldBefore = a.entryFor(b).peerToken;
  // A's key from B is revoked: no rotation proof is asked for, only the check at B.
  a.registry.patchPeerFields(a.entryFor(b).id, { peerTokenState: 'revoked' });
  const checks = [];
  const realRequest = a.client.request;
  a.client.request = async (relay, method, route, options) => {
    if (route === REMOTE_RELAY_PEER_KEY_PATHS.check) checks.push(relay.url);
    return realRequest(relay, method, route, options);
  };
  t.after(() => { a.client.request = realRequest; });
  for (let seq = 50; seq < 53; seq += 1) {
    const answer = await a.call(REMOTE_RELAY_PEER_KEY_PATHS.deliver, { method: 'POST', token: keyOfC, body: { issuer: b.registry.instanceId(), seq, key: mintPeerKey() } });
    assert.equal(answer.status, 403);
    assert.equal(answer.body.code, CODES.originMismatch);
  }
  assert.deepEqual(checks, [], 'no call to B\'s address');
  assert.equal(a.entryFor(b).peerToken, heldBefore);
  // Not the person's or a relay's: refused by the service too.
  assert.equal((await a.peerKeys.handleDelivery({ kind: 'agent', conversationId: 'conv-agent-1' }, { issuer: b.registry.instanceId(), seq: 60, key: mintPeerKey() })).status, 403);
  assert.equal((await a.peerKeys.handleDelivery(null, { issuer: b.registry.instanceId(), seq: 60, key: mintPeerKey() })).status, 403);
  assert.deepEqual(checks, []);
});

test('a delivery refused at the issuer\'s address holds further deliveries for that relay for a minute', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entry = a.entryFor(b);
  a.registry.patchPeerFields(entry.id, { peerTokenState: 'revoked' });
  const checks = [];
  const realRequest = a.client.request;
  a.client.request = async (relay, method, route, options) => {
    if (route === REMOTE_RELAY_PEER_KEY_PATHS.check) checks.push(relay.url);
    return realRequest(relay, method, route, options);
  };
  t.after(() => { a.client.request = realRequest; });
  const deliver = (seq) => a.call(REMOTE_RELAY_PEER_KEY_PATHS.deliver, { method: 'POST', body: { issuer: b.registry.instanceId(), seq, key: mintPeerKey() } });
  assert.equal((await deliver(70)).status, 403, 'B does not know the key');
  const held = await deliver(71);
  assert.equal(held.status, 429);
  assert.equal(held.body.code, CODES.rateLimited);
  assert.equal(checks.length, 1, 'one wrong key reached B');
  a.state.offsetMs = PEER_KEY_LIMITS.requestIntervalMs + 1000;
  assert.equal((await deliver(72)).status, 403, 'a minute later it is checked again');
  assert.equal(checks.length, 2);
  // Once the minute is over, B's own delivery checks out.
  a.state.offsetMs = 2 * (PEER_KEY_LIMITS.requestIntervalMs + 1000);
  const issued = await b.peerKeys.issueTo(b.entryFor(a).id, { reason: 'renew' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
});

test('deliveries sent together: one check reaches the issuer, the others wait (429) until it is done', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entry = a.entryFor(b);
  const heldKey = entry.peerToken;
  const checks = [];
  const realRequest = a.client.request;
  a.client.request = async (relay, method, route, options) => {
    if (route === REMOTE_RELAY_PEER_KEY_PATHS.check) {
      checks.push(relay.url);
      // A slow issuer: every other delivery arrives while this check runs.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return realRequest(relay, method, route, options);
  };
  t.after(() => { a.client.request = realRequest; });
  // The owner token with valid rotation proofs, for keys B never made.
  const deliver = (seq) => {
    const key = mintPeerKey();
    return a.call(REMOTE_RELAY_PEER_KEY_PATHS.deliver, { method: 'POST', body: { issuer: b.registry.instanceId(), seq, key, proof: peerKeyRotationProof(heldKey, seq, key) } });
  };
  const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => deliver(80 + index)));
  assert.equal(checks.length, 1, 'one key reached B\'s check');
  assert.equal(answers.filter((answer) => answer.status === 403).length, 1, 'the checked one did not check out');
  const waiting = answers.filter((answer) => answer.status === 429);
  assert.equal(waiting.length, 11);
  assert.ok(waiting.every((answer) => answer.body.code === CODES.rateLimited));
  assert.equal(a.entryFor(b).peerToken, heldKey, 'A keeps its key');
  // The mark goes with the check: a minute later one is checked again.
  a.state.offsetMs = PEER_KEY_LIMITS.requestIntervalMs + 1000;
  assert.equal((await deliver(95)).status, 403);
  assert.equal(checks.length, 2);
});

test('asking for a key: it goes to the stored address, never into the answer; rotation keeps the previous key valid for a while', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const oldKey = a.entryFor(b).peerToken;
  // Pairing asked a minute ago at most; a minute later another request is taken.
  b.state.offsetMs = 61_000;
  const answer = await b.call('/api/remote-relays/peer-key/request', { method: 'POST', token: oldKey, body: {} });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  noSecrets(answer.body, a.entryFor(b).peerToken, oldKey);
  await settle();
  const newKey = a.entryFor(b).peerToken;
  assert.notEqual(newKey, oldKey, 'a rotated key arrived at A');
  // The new key confirmed on first use; the old one retires 10 minutes later.
  const issuer = b.entryFor(a);
  const oldRecord = issuer.peerKeys.find((key) => key.hash === hashPeerKey(oldKey));
  assert.ok(oldRecord?.retiresAt, 'the previous key retires later');
  assert.equal((await b.call('/api/relay/identity', { token: oldKey })).status, 200, 'a request in flight on the old key still works');
  // A second request within the minute is refused.
  const again = await b.call('/api/remote-relays/peer-key/request', { method: 'POST', token: newKey, body: {} });
  assert.equal(again.status, 429);
});

test('revoke: the key gets 401, the holder asks once and shows "revoked"; re-pairing from the link brings full weight back', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entryOnB = b.entryFor(a);
  const epochBefore = entryOnB.epoch;
  b.peerKeys.revoke(entryOnB.id);
  assert.equal(b.entryFor(a).epoch, epochBefore + 1);
  const key = a.entryFor(b).peerToken;
  assert.equal((await b.call('/api/relay/identity', { token: key })).status, 401);
  await assert.rejects(() => a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'x' } }));
  assert.equal(a.entryFor(b).peerTokenState, 'revoked');
  assert.equal(a.registry.listPublic()[0].peerKey.theirKeyState, 'revoked');
  // One click Re-pair: A holds nothing that works there any more.
  const repair = await a.pairing.repair(a.entryFor(b).id);
  assert.equal(repair.needsLink, true);
  // The pairing link (B's token) alone, within the minute since the
  // pairing asked for a key and with nothing done on B: B renews the key it
  // revoked, and the next prompt is verified.
  const relinked = await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken });
  await settle();
  assert.equal(relinked.ok, true);
  assert.deepEqual(relinked.keys, { ours: { ok: true }, theirs: { ok: true } });
  assert.equal(b.entryFor(a).keyRevoked, false);
  assert.ok(b.logger.lines.some((text) => text.includes('was added again from this relay\'s pairing link')));
  await assertFullWeight(a, b, 'conv-2');
  // A's held token went once B's key worked: nothing of B's token is stored.
  assert.equal(a.entryFor(b).tokenMode, 'peer');
  assert.equal(JSON.stringify([...a.settings.values()]).includes(b.state.ownerToken), false);
});

/** A's next prompt to B is verified there and carries full weight. */
async function assertFullWeight(a, b, conversationId) {
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'again', origin: { relayId: a.registry.instanceId(), conversationId } } });
  const { request, principal } = b.seen.at(-1);
  assert.equal(principal?.kind, 'peer', 'A signs in at B with B\'s key');
  assert.equal(request.verified, true);
  assert.equal(originCarriesWeight(request.origin, (id) => b.registry.get(id)), true, 'full weight after re-pairing');
}

/** Paired, then B revokes its key for A and A finds out (state `revoked`). */
async function revokedPair(t) {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entryOnB = b.entryFor(a);
  b.peerKeys.revoke(entryOnB.id);
  await assert.rejects(() => a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'x' } }));
  assert.equal(a.entryFor(b).peerTokenState, 'revoked');
  return { a, b, entryOnB };
}

test('re-add from the link while B renews the revoked key at the same time: one key at a time, both sides end with working keys', async (t) => {
  const { a, b, entryOnB } = await revokedPair(t);
  // B's renewal is held on its way out until A's key request (on B's
  // token) has reached B: the request finds it in flight and waits for it.
  const realRequest = b.client.request;
  const realHandleRequest = b.peerKeys.handleRequest;
  let requestArrived;
  const arrived = new Promise((resolve) => { requestArrived = resolve; });
  b.peerKeys.handleRequest = (...args) => {
    const answer = realHandleRequest(...args);
    requestArrived();
    return answer;
  };
  let deliveries = 0;
  b.client.request = async (relay, method, route, options) => {
    if (route === REMOTE_RELAY_PEER_KEY_PATHS.deliver) {
      deliveries += 1;
      await arrived;
    }
    return realRequest(relay, method, route, options);
  };
  t.after(() => { b.client.request = realRequest; b.peerKeys.handleRequest = realHandleRequest; });
  const [renewed, relinked] = await Promise.all([
    b.peerKeys.renew(entryOnB.id),
    a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken }),
  ]);
  await settle();
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  assert.equal(relinked.ok, true);
  assert.deepEqual(relinked.keys, { ours: { ok: true }, theirs: { ok: true } });
  assert.equal(deliveries, 1, 'the request waited for the renewal instead of minting another key');
  await assertFullWeight(a, b, 'conv-3');
});

test('re-add from the link right after B renewed: the key B delivered went with the re-add, so A asks once more and holds a working key', async (t) => {
  const { a, b, entryOnB } = await revokedPair(t);
  // B's renewal reaches A and is stored there, but B is slow to take the
  // answer: A's re-add drops the key it just got, and its request finds
  // the renewal still in flight on B.
  const realRequest = b.client.request;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let deliveries = 0;
  b.client.request = async (relay, method, route, options) => {
    const answer = await realRequest(relay, method, route, options);
    if (route === REMOTE_RELAY_PEER_KEY_PATHS.deliver && (deliveries += 1) === 1) await held;
    return answer;
  };
  t.after(() => { b.client.request = realRequest; });
  const renewing = b.peerKeys.renew(entryOnB.id);
  await until(() => a.entryFor(b).peerTokenState === null && a.entryFor(b).peerToken, 'the renewed key stored on A');
  const adding = a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken });
  await until(() => !a.entryFor(b).peerToken, 'the re-add dropping the key held from B');
  setTimeout(release, 100);
  const [renewed, relinked] = await Promise.all([renewing, adding]);
  await settle();
  assert.equal(renewed.ok, true, JSON.stringify(renewed));
  assert.deepEqual(relinked.keys, { ours: { ok: true }, theirs: { ok: true } });
  assert.equal(deliveries, 2, 'a second key, asked for once more');
  await assertFullWeight(a, b, 'conv-4');
});

test('re-add from the link: a key B revoked is renewed only by its person, and never while its identity change is held', async (t) => {
  const { a, b, entryOnB } = await revokedPair(t);
  // A request as the paired relay itself (a key B gave it) with relink
  // set: the flag is the person's only, the key stays revoked.
  b.state.offsetMs = 61_000;
  const asPeer = await b.peerKeys.handleRequest({ kind: 'peer', entryId: entryOnB.id, relayId: a.registry.instanceId() }, { relayId: a.registry.instanceId(), relink: true });
  assert.equal(asPeer.status, 409, JSON.stringify(asPeer.body));
  assert.equal(b.entryFor(a).keyRevoked, true);
  // On B's token without relink (the health loop): still revoked.
  b.state.offsetMs = 122_000;
  const plain = await b.call(REMOTE_RELAY_PEER_KEY_PATHS.request, { method: 'POST', body: { relayId: a.registry.instanceId() } });
  assert.equal(plain.status, 409);
  assert.equal(b.entryFor(a).keyRevoked, true);
  // A held identity change on B: relink does not lift it.
  b.registry.patchPeerFields(entryOnB.id, { identityHold: { reason: 'relayId', relayId: 'relay-other-1', url: a.baseUrl, at: new Date().toISOString() } });
  const whileHeld = await b.call(REMOTE_RELAY_PEER_KEY_PATHS.request, { method: 'POST', body: { relayId: a.registry.instanceId(), relink: true } });
  assert.equal(whileHeld.status, 409);
  assert.equal((b.registry.get(entryOnB.id).peerKeys || []).length, 0, 'no key minted while held');
  assert.equal(b.entryFor(a).keyRevoked, true, 'still revoked while held');
  noSecrets(whileHeld.body, b.state.ownerToken);
});

test('refused for want of a key: the row says to re-add the relay from its link, until a key arrives', async (t) => {
  const { a, b } = await pairedRelays();
  const c = await startRelay('relay-gamma');
  t.after(async () => { await a.close(); await b.close(); await c.close(); });
  const entryOnA = a.entryFor(b);
  // A lost B's key (a backup from before the switch): only B's token is left.
  a.registry.patchPeerFields(entryOnA.id, { peerToken: undefined, peerTokenSeq: 0, peerTokenConfirmedAt: null, tokenMode: 'custom', token: b.state.ownerToken });
  await assert.rejects(
    () => a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'x' } }),
    (error) => error.code === CODES.peerKeyRequired,
  );
  assert.equal(a.entryFor(b).peerTokenState, 'required');
  assert.equal(a.registry.listPublic()[0].peerKey.theirKeyState, 'required');
  const line = a.logger.lines.find((text) => text.includes('wants this relay\'s key'));
  assert.match(line, /re-add relay "relay-beta" from its link \(Settings → Relays → Add a relay/);
  // The health loop asks with the token it still holds: a key arrives and
  // the state goes.
  b.state.offsetMs = 61_000;
  await a.registry.check(entryOnA.id);
  await until(() => a.entryFor(b).peerToken && a.entryFor(b).peerTokenState === null, 'a key from B');
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'y', origin: { relayId: a.registry.instanceId() } } });
  assert.equal(b.seen.at(-1).request.verified, true);

  // C pairs with B; B then removes C. C's key gets 401 there and so does
  // its request for a new one (the key went with the entry): "revoked",
  // which the row shows as re-add from the link.
  const bc = await c.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(b.state.ownerToken)}` });
  await settle();
  assert.equal(bc.keys.theirs.ok, true, JSON.stringify(bc.keys));
  b.registry.remove(b.entryFor(c).id);
  await assert.rejects(() => c.client.request(c.entryFor(b), 'GET', '/api/status'), (error) => error.code === CODES.unauthorized);
  assert.equal(c.entryFor(b).peerTokenState, 'revoked');
  // A request on a credential B still takes (its token, from the link
  // again) finds no entry there: "gone", and the log says what fixes it.
  c.registry.patchPeerFields(c.entryFor(b).id, { tokenMode: 'custom', token: b.state.ownerToken, peerTokenState: null });
  c.state.offsetMs = 61_000;
  assert.equal(await c.peerKeys.onHeldKeyRefused(c.entryFor(b)), null);
  assert.equal(c.entryFor(b).peerTokenState, 'gone');
  assert.equal(c.registry.listPublic()[0].peerKey.theirKeyState, 'gone');
  assert.ok(c.logger.lines.some((text) => /refused this relay's key: re-add relay "relay-beta" from its link/.test(text)));
});

test('one way with a relay without inbound-only keys (404 on the route): no key either way, the row says One way (not Re-add from link), prompts arrive as claimed; Re-pair brings keys both ways', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  b.state.noInboundKeys = true;
  const added = await a.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(b.state.ownerToken)}`, pairBack: false });
  await settle();
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.pairedBack, false);
  // B lists no entry for A: a key goes only to an address its issuer has
  // stored, so none flows either way, and that is said, not taken as a fault.
  assert.equal(b.entryFor(a), null);
  assert.equal(b.holderFor(a), null);
  assert.equal(added.oneWay, undefined);
  assert.deepEqual(added.keys.theirs, { ok: false, unlisted: true });
  assert.equal(added.keys.ours.ok, false);
  const entry = a.entryFor(b);
  assert.equal(entry.peerTokenState, 'unlisted');
  assert.equal(entry.tokenMode, 'custom', 'A keeps the token from the link: it has nothing else to call with');
  assert.equal(a.registry.listPublic()[0].peerKey.theirKeyState, 'unlisted');
  noSecrets(a.registry.listPublic(), b.state.ownerToken);
  assert.ok(a.logger.lines.some((line) => /does not list this relay \(added one way\).*use Re-pair on relay "relay-beta"/.test(line)));
  // Prompts work, as claimed.
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'hi', origin: { relayId: a.registry.instanceId() } } });
  assert.equal(b.seen.at(-1).request.verified, false);
  // A route that needs a key refuses, and the row stays One way.
  await assert.rejects(
    () => a.client.request(a.entryFor(b), 'GET', '/api/relay-asks/remote/inbox'),
    (error) => error.code === CODES.peerKeyRequired,
  );
  assert.equal(a.entryFor(b).peerTokenState, 'unlisted');
  // The health loop sends no key that B would refuse every minute; it still
  // asks for one (B answers 404), so a later listing there is picked up.
  const linesBefore = a.logger.lines.length;
  a.state.offsetMs = 61_000;
  await a.registry.check(entry.id);
  await settle();
  assert.equal(a.logger.lines.slice(linesBefore).some((line) => /not delivered/.test(line)), false, a.logger.lines.slice(linesBefore).join('\n'));
  assert.equal(a.entryFor(b).peerTokenState, 'unlisted');

  // Re-pair with the token A still holds: A is added there, keys both ways.
  const repaired = await a.pairing.repair(entry.id);
  await settle();
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(repaired.pairedBack, true);
  assert.equal(repaired.keys.ours.ok, true, JSON.stringify(repaired.keys));
  assert.equal(repaired.keys.theirs.ok, true, JSON.stringify(repaired.keys));
  await a.client.request(a.entryFor(b), 'GET', '/api/relay-asks/remote/inbox');
  await settle();
  assert.equal(a.entryFor(b).peerTokenState, null);
  assert.equal(a.entryFor(b).tokenMode, 'peer', 'the token from the link went once the key worked');
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'again', origin: { relayId: a.registry.instanceId() } } });
  assert.equal(b.seen.at(-1).request.verified, true);
});

test('without inbound-only keys there, B adds A from its link later (one way too): its key reaches A and clears One way', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  b.state.noInboundKeys = true;
  await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  assert.equal(a.entryFor(b).peerTokenState, 'unlisted');
  const back = await b.pairing.addFromLink({ url: a.baseUrl, token: a.state.ownerToken, pairBack: false });
  await settle();
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.keys.ours.ok, true, JSON.stringify(back.keys));
  assert.equal(back.keys.theirs.ok, true, JSON.stringify(back.keys));
  assert.equal(a.entryFor(b).peerTokenState, null);
  await a.client.request(a.entryFor(b), 'GET', '/api/relay-asks/remote/inbox');
  await b.client.request(b.entryFor(a), 'GET', '/api/relay-asks/remote/inbox');
});

/** Every stored value of a relay (its app_settings), as one text. */
function storedText(relay) {
  return JSON.stringify([...relay.settings.values()]);
}

test('one way with an inbound-only key: B lists A as inbound only, A keeps the key and no token of B anywhere, prompts arrive verified', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  const token = b.state.ownerToken;
  const added = await a.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(token)}`, pairBack: false });
  await settle();
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.pairedBack, false);
  assert.equal(added.oneWay, 'inbound-only');
  assert.deepEqual(added.keys, { ours: { ok: false, inboundOnly: true }, theirs: { ok: true, inboundOnly: true } });
  noSecrets(added, token);

  // A: the key only. B's token is in no stored value, public view or log line.
  const entry = a.entryFor(b);
  assert.equal(entry.tokenMode, 'peer');
  assert.equal(entry.token, undefined);
  assert.equal(entry.peerInboundOnly, true);
  assert.ok(entry.peerToken?.startsWith('oarp1_'));
  assert.ok(entry.peerTokenConfirmedAt, 'the first call with it confirmed it');
  assert.equal(storedText(a).includes(token), false, 'B\'s token is stored nowhere on A');
  for (const line of a.logger.lines) assert.equal(line.includes(token) || line.includes(entry.peerToken), false, 'no token or key in A\'s log');
  noSecrets(a.registry.listPublic(), token, entry.peerToken);
  const row = a.registry.listPublic()[0];
  assert.equal(row.peerKey.listedInboundOnly, true);
  assert.equal(row.peerKey.theirKey, true);
  assert.equal(row.peerKey.leastPrivilege, true);
  assert.ok(a.logger.lines.some((line) => /"relay-beta" added one way: it gave this relay a key of its own and lists it as inbound only; its token was not kept\./.test(line)));

  // B: an inbound-only entry, never called (no address), with a confirmed key.
  assert.equal(b.entryFor(a), null, 'not among the relays B calls');
  assert.equal(b.registry.listPublic().length, 0);
  const holder = b.holderFor(a);
  assert.equal(holder.url, '');
  assert.equal(holder.name, 'relay-alpha');
  assert.equal(holder.peerKeys.length, 1);
  assert.ok(holder.peerKeys[0].confirmedAt);
  const inboundRows = b.registry.listInboundPublic();
  assert.deepEqual(inboundRows.map((item) => [item.id, item.inboundOnly, item.url, item.httpWarning, item.peerKey.inboundOnly, item.peerKey.status]), [[holder.id, true, '', null, true, 'active']]);
  noSecrets(inboundRows, entry.peerToken, token);
  assert.equal(storedText(b).includes(entry.peerToken), false, 'B keeps the key\'s hash only');
  assert.ok(b.logger.lines.some((line) => /"relay-alpha" added this relay one way: it holds an inbound-only key/.test(line)));
  for (const line of b.logger.lines) assert.equal(line.includes(entry.peerToken), false);
  const listed = await b.call('/api/remote-relays');
  assert.deepEqual([listed.body.relays.length, listed.body.inbound.map((item) => item.id)], [0, [holder.id]]);
  // B never calls it: a health pass probes nothing, a check is no probe.
  assert.equal(await b.registry.checkAll(), false);
  assert.equal((await b.registry.check(holder.id)).lastStatus, 'unknown');

  // Prompts arrive verified, bound to the inbound-only entry; key-only
  // routes (Inbox, asks, watches) take it like any paired relay's key.
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'hi', origin: { relayId: a.registry.instanceId(), relayName: 'claimed', conversationId: 'conv-1' } } });
  const { request, principal } = b.seen.at(-1);
  assert.equal(principal.kind, 'peer');
  assert.deepEqual([request.verified, request.origin.entryId, request.origin.relayName], [true, holder.id, 'relay-alpha']);
  await a.client.request(a.entryFor(b), 'GET', '/api/relay-asks/remote/inbox');
  // Same scope as a two-way key: settings and pairing stay out.
  for (const [method, route] of [['POST', '/api/settings/features'], ['POST', '/api/remote-relays/pair'], ['GET', '/api/remote-relays']]) {
    const answer = await b.call(route, { method, token: entry.peerToken, body: method === 'GET' ? undefined : {} });
    assert.deepEqual([answer.status, answer.body.code], [403, CODES.peerScope], `${method} ${route}`);
  }
  // The owner token claiming A now is a spoof: A signs in with its key.
  const spoof = await b.call('/api/message', { method: 'POST', headers: { 'x-oar-remote-origin': a.registry.instanceId() }, body: { text: 'x' } });
  assert.deepEqual([spoof.status, spoof.body.code], [403, CODES.peerKeyRequired]);

  // A's health loop delivers no key B would refuse and asks for none.
  const linesBefore = a.logger.lines.length;
  a.state.offsetMs = 61_000;
  await a.registry.check(entry.id);
  await settle();
  assert.equal(a.logger.lines.slice(linesBefore).some((line) => /not delivered/.test(line)), false, a.logger.lines.slice(linesBefore).join('\n'));
  assert.equal(a.entryFor(b).peerInboundOnly, true);
  // Re-pair cannot add A there with a key: it asks for the pairing link.
  const repair = await a.pairing.repair(entry.id);
  assert.deepEqual([repair.ok, repair.needsLink, repair.oneWay], [false, true, true]);
  assert.match(repair.error, /lists this relay as inbound only .*Add it again with "Also add this relay there" on/);
  // On B, the inbound-only entry has nothing to edit, check or re-pair.
  assert.equal(b.registry.update(holder.id, { url: a.baseUrl }).status, 409);
  assert.equal((await b.pairing.repair(holder.id)).status, 409);
  assert.equal((await b.peerKeys.renew(holder.id)).code, 'inbound-only');

  // Added again from the link with "Also add this relay there" on: B's
  // inbound-only entry becomes A's normal entry there, keys both ways.
  const twoWay = await a.pairing.addFromLink({ url: b.baseUrl, token, pairBack: true });
  await settle();
  assert.equal(twoWay.ok, true, JSON.stringify(twoWay));
  assert.equal(twoWay.pairedBack, true);
  assert.deepEqual([twoWay.keys.ours.ok, twoWay.keys.theirs.ok], [true, true], JSON.stringify(twoWay.keys));
  assert.equal(b.registry.listAll().length, 1, 'no second row on B');
  assert.equal(b.entryFor(a).id, holder.id, 'the same entry, now called too');
  assert.equal(b.entryFor(a).url, a.baseUrl);
  assert.equal(a.entryFor(b).peerInboundOnly, false);
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'two way', origin: { relayId: a.registry.instanceId() } } });
  assert.equal(b.seen.at(-1).request.verified, true);
  await b.client.request(b.entryFor(a), 'GET', '/api/relay-asks/remote/inbox');
  assert.equal(a.entryFor(b).tokenMode, 'peer', 'the token from the link went once the key worked');
});

test('Remove on B revokes the inbound-only key at once: A\'s next call gets 401, said as the key', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  const holder = b.holderFor(a);
  const removed = await b.call(`/api/remote-relays/${encodeURIComponent(holder.id)}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal(b.registry.listAll().length, 0);
  await assert.rejects(
    () => a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'x' } }),
    (error) => error.code === CODES.unauthorized && /rejected the key it gave this relay \(401\)/.test(error.message),
  );
  assert.equal(a.entryFor(b).peerTokenState, 'revoked');
  assert.equal(a.registry.listPublic()[0].peerKey.theirKeyState, 'revoked');
  assert.equal(b.holderFor(a), null, 'asking for a new key with the revoked one makes no entry');
});

test('a key refused there, and no token held: health checks and later calls keep saying the key was rejected (Re-add from link), never "no token configured"', async (t) => {
  const keyRejected = /^Relay "relay-beta" rejected the key it gave this relay \(401\)$/;
  for (const pairing of ['one way', 'two way']) {
    const a = await startRelay('relay-alpha');
    const b = await startRelay('relay-beta');
    t.after(async () => { await a.close(); await b.close(); });
    if (pairing === 'one way') {
      await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
      await b.call(`/api/remote-relays/${encodeURIComponent(b.holderFor(a).id)}`, { method: 'DELETE' });
    } else {
      await a.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(b.state.ownerToken)}` });
      await settle();
      await a.client.request(a.entryFor(b), 'GET', '/api/relay/identity');
      await settle();
      assert.equal(a.entryFor(b).tokenMode, 'peer', `${pairing}: the token from the link went once the key worked`);
      b.registry.remove(b.entryFor(a).id);
    }
    const entry = a.entryFor(b);
    assert.equal(entry.token, undefined, `${pairing}: no token held for B`);
    // A's next call: the key is refused, a new one cannot be had.
    await assert.rejects(
      () => a.client.request(entry, 'POST', '/api/message', { body: { text: 'x' } }),
      (error) => error.code === CODES.unauthorized && /rejected the key it gave this relay \(401\)/.test(error.message),
    );
    assert.equal(a.entryFor(b).peerTokenState, 'revoked', pairing);
    // The health loop (now, and a minute later) keeps the refusal.
    for (const offsetMs of [0, 61_000]) {
      a.state.offsetMs = offsetMs;
      const checked = await a.registry.check(entry.id);
      await settle();
      assert.deepEqual([checked.lastStatus, checked.lastError], ['unauthorized', 'Rejected the key it gave this relay (401)'], `${pairing}, +${offsetMs} ms`);
      assert.equal(checked.peerKey.theirKeyState, 'revoked', `${pairing}: the row says Re-add from link`);
    }
    a.state.offsetMs = 122_000;
    await a.registry.checkAll();
    assert.equal(a.registry.listPublic()[0].lastError, 'Rejected the key it gave this relay (401)', pairing);
    // A later call says the same, without sending anything.
    const seen = b.seen.length;
    await assert.rejects(
      () => a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'y' } }),
      (error) => error.code === CODES.unauthorized && keyRejected.test(error.message),
    );
    assert.equal(b.seen.length, seen, `${pairing}: nothing reached B`);
    noSecrets(a.registry.listPublic(), entry.peerToken);
  }
});

test('only the person mints an inbound-only key: an agent token and a paired relay\'s key get 403, a listed relay 409', async (t) => {
  const { a, b } = await pairedRelays();
  const c = await startRelay('relay-gamma');
  t.after(async () => { await a.close(); await b.close(); await c.close(); });
  const body = { relayId: c.registry.instanceId(), name: 'relay-gamma', protocol: 2 };
  const agent = await b.call(REMOTE_RELAY_INBOUND_KEY_PATH, { method: 'POST', token: b.state.agentToken, body });
  assert.deepEqual([agent.status, agent.body.code], [403, 'AUTH_PERSON_REQUIRED']);
  const peer = await b.call(REMOTE_RELAY_INBOUND_KEY_PATH, { method: 'POST', token: a.entryFor(b).peerToken, body });
  assert.deepEqual([peer.status, peer.body.code], [403, CODES.peerScope]);
  // An inbound-only key opens no minting either.
  await c.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  const inboundKey = c.entryFor(b).peerToken;
  const byHolder = await b.call(REMOTE_RELAY_INBOUND_KEY_PATH, { method: 'POST', token: inboundKey, body: { relayId: 'relay-made-up-id', name: 'made-up' } });
  assert.deepEqual([byHolder.status, byHolder.body.code], [403, CODES.peerScope]);
  for (const answer of [agent, peer, byHolder]) assert.equal(JSON.stringify(answer.body).includes('oarp1_'), false);
  assert.deepEqual(b.registry.listAll().map((entry) => entry.relayId).sort(), [a.registry.instanceId(), c.registry.instanceId()].sort(), 'no entry from a refused call');
  // The person: a relay listed both ways already is told so; this relay
  // itself is refused.
  const listed = await b.call(REMOTE_RELAY_INBOUND_KEY_PATH, { method: 'POST', body: { relayId: a.registry.instanceId(), name: 'relay-alpha' } });
  assert.deepEqual([listed.status, listed.body.code, 'key' in listed.body], [409, CODES.alreadyListed, false]);
  const self = await b.call(REMOTE_RELAY_INBOUND_KEY_PATH, { method: 'POST', body: { relayId: b.registry.instanceId() } });
  assert.equal(self.status, 400);
  // A relay listed both ways that adds this one one way: its keys come the
  // usual way, and no inbound-only entry is made.
  const again = await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  await settle();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.oneWay, undefined);
  assert.equal(b.holderFor(a), null);
  assert.equal(a.entryFor(b).peerInboundOnly, false);
});

test('adding one way again replaces the inbound-only key and revokes the old one: never two live keys', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  const oldKey = a.entryFor(b).peerToken;
  const before = b.holderFor(a);
  const again = await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  await settle();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.updated, true);
  const newKey = a.entryFor(b).peerToken;
  assert.notEqual(newKey, oldKey);
  const after = b.holderFor(a);
  assert.equal(after.id, before.id, 'the same row');
  assert.equal(b.registry.listAll().length, 1);
  assert.equal(after.peerKeys.length, 1, 'one key');
  assert.equal(after.epoch, before.epoch + 1, 'the old key\'s prompts lose their weight');
  assert.equal((await b.call('/api/relay/identity', { token: oldKey })).status, 401);
  assert.equal((await b.call('/api/relay/identity', { token: newKey })).status, 200);
  assert.equal(a.registry.list().length, 1);
});

test('one way with a 0.9.26 relay (no keys): falls back to keeping its token, and the answer says so', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  b.state.oldVersion = true;
  const added = await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  await settle();
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.equal(added.oneWay, 'older');
  assert.equal(added.keys, undefined);
  assert.deepEqual(b.registry.listAll(), [], 'nothing asked of B');
  const entry = a.entryFor(b);
  assert.deepEqual([entry.tokenMode, entry.peerInboundOnly, entry.protocol], ['custom', false, 1]);
  assert.equal(a.registry.listPublic()[0].peerKey.status, 'older');
  noSecrets(a.registry.listPublic(), b.state.ownerToken);
  await a.client.request(entry, 'POST', '/api/message', { body: { text: 'hi', origin: { relayId: a.registry.instanceId() } } });
  assert.equal(b.seen.at(-1).request.verified, false, 'claimed');
});

test('an inbound-only key that fails its check: nothing is stored here, a plain error, and the key opens nothing there', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  const token = b.state.ownerToken;
  b.state.failKeyCheck = true;
  const added = await a.pairing.addFromLink({ url: b.baseUrl, token, pairBack: false });
  assert.equal(added.ok, false);
  assert.equal(added.status, 502);
  assert.match(added.error, /^The key relay-beta gave could not be checked at its address: .*\. Nothing was saved here; try Add again\.$/);
  noSecrets(added, token);
  assert.deepEqual(a.registry.listAll(), []);
  assert.equal(storedText(a).includes(token), false);
  assert.equal(storedText(a).includes('oarp1_'), false);
  for (const line of a.logger.lines) assert.equal(line.includes(token), false);
  // The unchecked key on B is good for the check alone, and for 10 minutes.
  const holder = b.holderFor(a);
  assert.deepEqual(holder.peerKeys.map((key) => [key.checkedAt, key.confirmedAt]), [[null, null]]);
  // A later add that goes through replaces it.
  b.state.failKeyCheck = false;
  const retried = await a.pairing.addFromLink({ url: b.baseUrl, token, pairBack: false });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(b.registry.listAll().length, 1);
  assert.equal(b.holderFor(a).peerKeys.length, 1);
});

test('B adds A later (two way): the inbound-only entry becomes a normal one in place, keys both ways', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  await a.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  const holder = b.holderFor(a);
  const oldKey = a.entryFor(b).peerToken;
  const back = await b.pairing.addFromLink({ url: `${a.baseUrl}/?token=${encodeURIComponent(a.state.ownerToken)}` });
  await settle();
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.updated, true);
  assert.deepEqual([back.keys.ours.ok, back.keys.theirs.ok], [true, true], JSON.stringify(back.keys));
  assert.equal(b.registry.listAll().length, 1, 'no duplicate row');
  const entry = b.entryFor(a);
  assert.deepEqual([entry.id, entry.inboundOnly, entry.url], [holder.id, undefined, a.baseUrl]);
  assert.equal(b.registry.listInboundPublic().length, 0);
  assert.equal(a.registry.listAll().length, 1);
  assert.equal(a.entryFor(b).peerInboundOnly, false);
  assert.notEqual(a.entryFor(b).peerToken, oldKey, 'a key delivered the usual way replaced the inbound-only one');
  assert.equal((await b.call('/api/relay/identity', { token: oldKey })).status, 401);
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'a to b', origin: { relayId: a.registry.instanceId() } } });
  assert.equal(b.seen.at(-1).request.verified, true);
  await b.client.request(b.entryFor(a), 'POST', '/api/message', { body: { text: 'b to a', origin: { relayId: b.registry.instanceId() } } });
  assert.equal(a.seen.at(-1).request.verified, true);
  await settle();
  assert.equal(b.entryFor(a).tokenMode, 'peer', 'B dropped A\'s token once A\'s key worked');
});

test('a refused key says "key", a refused token says "token" (401)', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entryOnA = a.entryFor(b);
  b.registry.remove(b.entryFor(a).id);
  const checked = await a.registry.check(entryOnA.id);
  assert.equal(checked.lastStatus, 'unauthorized');
  assert.equal(checked.lastError, 'Rejected the key it gave this relay (401)');
  // A token B no longer takes reads as a token (C keeps one: B has no
  // inbound-only keys here).
  const c = await startRelay('relay-gamma');
  t.after(() => c.close());
  b.state.noInboundKeys = true;
  await c.pairing.addFromLink({ url: b.baseUrl, token: b.state.ownerToken, pairBack: false });
  b.state.ownerToken = `oaro1_${crypto.randomBytes(32).toString('base64url')}`;
  const onC = await c.registry.check(c.entryFor(b).id);
  assert.equal(onC.lastError, 'Rejected the token (401)');
});

test('Re-pair with a working key: probes, keys both ways, no token needed', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const result = await a.pairing.repair(a.entryFor(b).id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.keys.ours.ok, true);
});

test('pinning: re-pointing a keyed entry revokes and holds; the owner confirms before keys flow again', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entry = b.entryFor(a);
  const patched = b.registry.update(entry.id, { url: 'http://127.0.0.1:9' });
  assert.equal(patched.ok, true);
  const held = b.entryFor(a);
  assert.equal(held.identityHold.reason, 'url');
  assert.equal(held.peerKeys.length, 0);
  assert.equal(held.epoch, entry.epoch + 1);
  // Its claims still need the key (it was keyed), and nothing is issued.
  assert.equal((await b.call('/api/message', { method: 'POST', headers: { 'x-oar-remote-origin': a.registry.instanceId() }, body: {} })).body.code, CODES.peerKeyRequired);
  assert.equal((await b.peerKeys.issueTo(entry.id)).code, 'held');
  assert.equal(b.registry.listPublic().find((item) => item.id === entry.id).peerKey.status, 'held');
  b.registry.update(entry.id, { url: a.baseUrl });
  b.peerKeys.confirmIdentity(entry.id);
  assert.equal(b.entryFor(a).identityHold, null);
});

test('a changed address gets no key: check, Re-pair and the health probe send the held key nowhere but where it was keyed', async (t) => {
  const { a, b } = await pairedRelays();
  // Whoever answers at the new address: a relay A was never paired with.
  const stranger = await startRelay('relay-stranger');
  t.after(async () => { await a.close(); await b.close(); await stranger.close(); });
  const entry = a.entryFor(b);
  const heldKey = entry.peerToken;
  assert.ok(heldKey, 'A holds a key from B');
  assert.equal(a.registry.update(entry.id, { url: stranger.baseUrl }).ok, true);
  assert.equal(a.entryFor(b).identityHold?.reason, 'url');
  stranger.state.seenAuth.length = 0;
  await a.registry.check(entry.id);
  await a.pairing.repair(entry.id);
  await a.registry.checkAll?.();
  a.peerKeys.afterProbe(entry.id);
  await assert.rejects(a.client.request(a.registry.get(entry.id), 'GET', '/api/relay/identity'), (error) => /identity changed/.test(error.message));
  await settle();
  // The row says the identity changed, and the key is not counted as usable.
  const row = a.registry.listPublic().find((item) => item.id === entry.id);
  assert.equal(row.peerKey.status, 'held');
  // Re-pair confirming it: the held key is dropped before anything is sent.
  await a.pairing.repair(entry.id, { confirmIdentity: true });
  await settle();
  assert.equal(a.registry.get(entry.id).peerToken, undefined);
  assert.equal(stranger.state.seenAuth.some((value) => value.includes(heldKey)), false, 'the key from B never reaches the new address');
  assert.equal(stranger.state.seenAuth.some((value) => value.includes('oarp1_')), false, 'no key at all');
});

test('another relay at the same address gets no key once the probe saw it', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entry = a.entryFor(b);
  const heldKey = entry.peerToken;
  // The probe found another relay id at B's address (a domain that points elsewhere now).
  a.registry.recordIdentity(entry.id, { relayId: 'relay-elsewhere-id', protocol: 2, name: 'elsewhere' });
  const held = a.registry.get(entry.id);
  assert.equal(held.identityHold?.reason, 'relayId');
  assert.equal(held.relayId, b.registry.instanceId(), 'the pinned id is kept');
  b.state.seenAuth.length = 0;
  await a.registry.check(entry.id);
  await a.pairing.repair(entry.id);
  a.peerKeys.afterProbe(entry.id);
  await settle();
  assert.equal(b.state.seenAuth.some((value) => value.includes(heldKey)), false, 'the held key is not sent to that address');
  // Once the owner confirms, the held key is dropped (a new one follows from Re-pair with a link).
  a.peerKeys.confirmIdentity(entry.id);
  assert.equal(a.registry.get(entry.id).peerToken, undefined);
});

test('a one-way key is pinned too: re-pointing the entry holds it and the key is not sent to the new address', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  const stranger = await startRelay('relay-stranger');
  t.after(async () => { await a.close(); await b.close(); await stranger.close(); });
  const added = await a.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(b.state.ownerToken)}`, pairBack: false });
  assert.equal(added.ok, true, JSON.stringify(added));
  await settle();
  const entry = a.entryFor(b);
  assert.equal(entry.peerInboundOnly, true);
  assert.equal(entry.everKeyed, false, 'A never keyed B: only the holder side pins it');
  const heldKey = entry.peerToken;
  assert.equal(a.registry.update(entry.id, { url: stranger.baseUrl }).ok, true);
  assert.equal(a.entryFor(b).identityHold?.reason, 'url');
  stranger.state.seenAuth.length = 0;
  await a.registry.check(entry.id);
  await a.pairing.repair(entry.id);
  await settle();
  assert.equal(stranger.state.seenAuth.some((value) => value.includes(heldKey)), false);
});

test('a held entry that still holds the owner token sends no Authorization at all: check, Re-pair, probe, request', async (t) => {
  const { a, b } = await pairedRelays();
  const stranger = await startRelay('relay-stranger');
  t.after(async () => { await a.close(); await b.close(); await stranger.close(); });
  const entry = a.entryFor(b);
  // A token is held for B too (a key not used yet, an add that ended without
  // a working key, keys that work one way only).
  assert.equal(a.registry.update(entry.id, { tokenMode: 'custom', token: b.state.ownerToken }).ok, true);
  const tryEverything = async (target) => {
    target.state.seenAuth.length = 0;
    await a.registry.check(entry.id);
    await a.pairing.repair(entry.id);
    const current = a.registry.get(entry.id);
    await assert.rejects(a.client.probe(current.url, a.client.tokenFor(current), { relay: current }), (error) => /identity changed/.test(error.message));
    await assert.rejects(a.client.request(current, 'GET', '/api/relay/identity'), (error) => /identity changed/.test(error.message));
    a.peerKeys.afterProbe(entry.id);
    await settle();
    assert.deepEqual(target.state.seenAuth.filter(Boolean), [], 'no key, no token, nothing');
  };
  // Another relay id answered at B's address.
  a.registry.recordIdentity(entry.id, { relayId: 'relay-elsewhere-id', protocol: 2, name: 'elsewhere' });
  assert.equal(a.registry.get(entry.id).identityHold?.reason, 'relayId');
  await tryEverything(b);
  assert.equal(a.client.tokenFor(a.registry.get(entry.id)), '');
});

test('a held address change that still holds the owner token sends nothing to the new address', async (t) => {
  const { a, b } = await pairedRelays();
  const stranger = await startRelay('relay-stranger');
  t.after(async () => { await a.close(); await b.close(); await stranger.close(); });
  const entry = a.entryFor(b);
  assert.equal(a.registry.update(entry.id, { tokenMode: 'custom', token: b.state.ownerToken }).ok, true);
  assert.equal(a.registry.update(entry.id, { url: stranger.baseUrl }).ok, true);
  assert.equal(a.registry.get(entry.id).identityHold?.reason, 'url');
  stranger.state.seenAuth.length = 0;
  await a.registry.check(entry.id);
  await a.pairing.repair(entry.id);
  const current = a.registry.get(entry.id);
  await assert.rejects(a.client.probe(current.url, a.client.tokenFor(current), { relay: current }), (error) => /identity changed/.test(error.message));
  await assert.rejects(a.client.request(current, 'GET', '/api/relay/identity'), (error) => /identity changed/.test(error.message));
  a.peerKeys.afterProbe(entry.id);
  await settle();
  assert.deepEqual(stranger.state.seenAuth.filter(Boolean), [], 'no key, no token, nothing');
});

test('Re-pair during a hold asks for Confirm (not the pairing link) and writes nothing', async (t) => {
  const { a, b } = await pairedRelays();
  const stranger = await startRelay('relay-stranger');
  t.after(async () => { await a.close(); await b.close(); await stranger.close(); });
  const entry = a.entryFor(b);
  for (const [hold, target] of [
    [() => a.registry.recordIdentity(entry.id, { relayId: 'relay-elsewhere-id', protocol: 2, name: 'elsewhere' }), b],
    [() => a.registry.update(entry.id, { url: stranger.baseUrl }), stranger],
  ]) {
    hold();
    assert.ok(a.registry.get(entry.id).identityHold);
    await settle();
    const before = JSON.stringify([...a.settings]);
    target.state.seenAuth.length = 0;
    const answer = await a.pairing.repair(entry.id);
    assert.equal(answer.ok, false);
    assert.equal(answer.needsConfirm, true, JSON.stringify(answer));
    assert.equal(answer.needsLink, undefined);
    assert.match(answer.error, /Confirm/);
    await settle();
    assert.equal(JSON.stringify([...a.settings]), before, 'nothing written');
    assert.deepEqual(target.state.seenAuth, [], 'nothing sent');
  }
});

test('a relay that restarts at its pinned address (same relay id) gets its key again: the link comes back', async (t) => {
  const { a, b } = await pairedRelays();
  const relays = { b };
  t.after(async () => { await a.close(); await relays.b.close(); });
  const entry = a.entryFor(b);
  const heldKey = entry.peerToken;
  assert.ok(heldKey);
  await relays.b.stop();
  await assert.rejects(a.client.request(a.registry.get(entry.id), 'GET', '/api/relay/identity'));
  await a.registry.check(entry.id);
  relays.b = await startRelay('relay-beta', { port: b.port, settings: b.settings, ownerToken: b.state.ownerToken });
  assert.equal(relays.b.registry.instanceId(), b.registry.instanceId(), 'the same relay id');
  await a.registry.check(entry.id);
  const current = a.registry.get(entry.id);
  assert.equal(current.identityHold, null, 'nothing held');
  assert.equal(a.client.tokenFor(current), heldKey, 'its key is used');
  const identity = await a.client.request(current, 'GET', '/api/relay/identity');
  assert.equal(identity.relayId, b.registry.instanceId());
  assert.ok(relays.b.state.seenAuth.some((value) => value.includes(heldKey)), 'the key reached the restarted relay');
});

test('an address changed and set back to the pinned one: the hold is lifted and the key is used there again', async (t) => {
  const { a, b } = await pairedRelays();
  const stranger = await startRelay('relay-stranger');
  t.after(async () => { await a.close(); await b.close(); await stranger.close(); });
  const entry = a.entryFor(b);
  const heldKey = entry.peerToken;
  assert.equal(a.registry.update(entry.id, { url: stranger.baseUrl }).ok, true);
  assert.equal(a.registry.get(entry.id).identityHold?.reason, 'url');
  stranger.state.seenAuth.length = 0;
  await a.registry.check(entry.id);
  assert.equal(a.registry.update(entry.id, { url: b.baseUrl }).ok, true);
  const back = a.registry.get(entry.id);
  assert.equal(back.identityHold, null, 'the hold is lifted');
  assert.equal(a.client.tokenFor(back), heldKey);
  b.state.seenAuth.length = 0;
  await a.registry.check(entry.id);
  assert.equal((await a.client.request(a.registry.get(entry.id), 'GET', '/api/relay/identity')).relayId, b.registry.instanceId());
  assert.ok(b.state.seenAuth.some((value) => value.includes(heldKey)), 'the key goes to the pinned address');
  assert.deepEqual(stranger.state.seenAuth.filter(Boolean), [], 'nothing went to the other address');
  // Another relay id seen at the address is not lifted by going away and back.
  a.registry.recordIdentity(entry.id, { relayId: 'relay-elsewhere-id', protocol: 2, name: 'elsewhere' });
  assert.equal(a.registry.update(entry.id, { url: stranger.baseUrl }).ok, true);
  assert.equal(a.registry.update(entry.id, { url: b.baseUrl }).ok, true);
  assert.equal(a.registry.get(entry.id).identityHold?.reason, 'relayId', 'still held');
  assert.equal(a.client.tokenFor(a.registry.get(entry.id)), '');
});

test('a one-way key: re-pointed and set back, the hold is lifted too', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  const added = await a.pairing.addFromLink({ url: `${b.baseUrl}/?token=${encodeURIComponent(b.state.ownerToken)}`, pairBack: false });
  assert.equal(added.ok, true, JSON.stringify(added));
  await settle();
  const entry = a.entryFor(b);
  const heldKey = entry.peerToken;
  assert.equal(entry.everKeyed, false);
  assert.equal(a.registry.update(entry.id, { url: 'http://127.0.0.1:9' }).ok, true);
  assert.equal(a.registry.get(entry.id).identityHold?.reason, 'url');
  assert.equal(a.registry.update(entry.id, { url: 'http://127.0.0.1:10' }).ok, true);
  assert.ok(a.registry.get(entry.id).identityHold, 'another address is still held');
  assert.equal(a.registry.update(entry.id, { url: b.baseUrl }).ok, true);
  assert.equal(a.registry.get(entry.id).identityHold, null);
  assert.equal(a.client.tokenFor(a.registry.get(entry.id)), heldKey);
});

test('a key is withheld while the address differs from the pinned one, even without a hold', () => {
  const key = mintPeerKey();
  const entry = { url: 'https://relay-b.example.test/oar', keyUrl: 'https://relay-b.example.test/oar', peerToken: key, protocol: 2 };
  assert.equal(usablePeerToken(entry), key);
  assert.equal(usablePeerToken({ ...entry, url: 'HTTPS://Relay-B.Example.Test/oar/' }), key, 'the same address');
  assert.equal(usablePeerToken({ ...entry, url: 'https://relay-c.example.test/oar' }), '');
  assert.equal(usablePeerToken({ ...entry, identityHold: { reason: 'relayId', relayId: 'relay-other-id', url: entry.url, at: null } }), '');
});

test('a new /pair entry whose address answers with another id stays unconfirmed; a duplicate relay id at another address is refused', async (t) => {
  const b = await startRelay('relay-beta');
  t.after(() => b.close());
  const made = await b.pairing.acceptPairing({ relayId: 'relay-fake-id', name: 'fake', url: 'http://127.0.0.1:9', protocol: 2 });
  assert.equal(made.ok, true);
  const entry = b.registry.list().find((item) => item.relayId === 'relay-fake-id');
  assert.equal(entry.unconfirmed, true);
  assert.equal(b.registry.listPublic()[0].peerKey.unconfirmed, true);
  const clash = await b.pairing.acceptPairing({ relayId: 'relay-other-id', name: 'other', url: 'http://127.0.0.1:9', protocol: 2 });
  assert.equal(clash.ok, false);
  assert.equal(b.registry.list().length, 1);
});

test('downgrade: one probe at protocol 1 changes nothing; three in a row stop requiring the key, which is kept', () => {
  const settings = new Map();
  const registry = createRemoteRelayRegistry({
    readSetting: (key) => settings.get(key) ?? null,
    writeSetting: (key, value) => settings.set(key, value),
    client: { tokenFor: () => '', probe: async () => ({}) },
    logger: quietLogger(),
  });
  const peerKeys = createPeerKeyService({ registry, client: { tokenFor: () => '' }, logger: quietLogger() });
  registry.setPeerKeys(peerKeys);
  const entry = registry.add({ url: 'https://relay-old.example.test', relayId: 'relay-old-id', name: 'old', protocol: 2 });
  registry.patchPeerFields(entry.id, { everKeyed: true, keyRelayId: 'relay-old-id', keyUrl: entry.url, peerKeys: [{ hash: 'a'.repeat(64), seq: 1, issuedAt: new Date().toISOString(), confirmedAt: new Date().toISOString() }] });
  for (let probe = 1; probe <= 3; probe += 1) {
    registry.recordIdentity(entry.id, { relayId: 'relay-old-id', protocol: 1, name: 'old' });
    assert.equal(registry.get(entry.id).downgraded, probe === 3, `probe ${probe}`);
  }
  assert.equal(registry.get(entry.id).peerKeys.length, 1, 'the key is kept');
  registry.recordIdentity(entry.id, { relayId: 'relay-old-id', protocol: 2, name: 'old' });
  assert.equal(registry.get(entry.id).downgraded, false, 'back at protocol 2: the key counts again');
  // Another id at the address of a keyed entry is held, not adopted.
  registry.recordIdentity(entry.id, { relayId: 'relay-new-id', protocol: 2, name: 'old' });
  assert.equal(registry.get(entry.id).relayId, 'relay-old-id');
  assert.equal(registry.get(entry.id).identityHold.relayId, 'relay-new-id');
});

test('hop A → B → C: C binds the origin to B; C may answer B, and B may pass the reply to A', async (t) => {
  const { a, b } = await pairedRelays();
  const c = await startRelay('relay-gamma');
  t.after(async () => { await a.close(); await b.close(); await c.close(); });
  const bc = await b.pairing.addFromLink({ url: `${c.baseUrl}/?token=${encodeURIComponent(c.state.ownerToken)}` });
  await settle();
  assert.equal(bc.ok, true, JSON.stringify(bc));
  assert.deepEqual(bc.keys, { ours: { ok: true }, theirs: { ok: true } });
  const aId = a.registry.instanceId();
  const bId = b.registry.instanceId();

  // A's agent prompts B: verified on B, bound to B's entry for A.
  await a.client.request(a.entryFor(b), 'POST', '/api/message', {
    body: { text: 'look into it', origin: { relayId: aId, conversationId: 'conv-on-a', hops: 1 } },
  });
  const onB = b.seen.at(-1).request.origin;
  assert.equal(onB.verified, true);
  assert.equal(onB.entryId, b.entryFor(a).id);

  // B's agent, acting on that prompt, prompts C (hops 2, its own session).
  await b.client.request(b.entryFor(c), 'POST', '/api/message', {
    body: { text: 'A asks: look into it', origin: { relayId: bId, relayName: 'relay-alpha', conversationId: 'conv-on-b', hops: 2 } },
    hops: 2,
  });
  const onC = c.seen.at(-1).request.origin;
  assert.equal(onC.verified, true);
  assert.equal(onC.relayId, bId, 'the relay is B, the one that signed in');
  assert.equal(onC.entryId, c.entryFor(b).id);
  assert.equal(onC.relayUrl, b.baseUrl);
  assert.equal(onC.relayName, c.entryFor(b).name, 'the name C gave B, not a claimed one');
  assert.equal(onC.conversationId, 'conv-on-b', 'the session part is B\'s own statement');
  assert.equal(onC.hops, 2);
  // Nothing about A is an origin on C: C does not list A, and A's id is not in it.
  assert.equal(c.entryFor(a), null);
  assert.equal(JSON.stringify(onC).includes(aId), false);
  assert.equal(findOriginRemoteRelay(c.inbound, onC).relayId, c.entryFor(b).id);
  // C's agent may answer B.
  assert.equal(originWeightedFor(onC, c.registry.get(c.entryFor(b).id)), true);
  // B cannot pass a prompt on to C as A's.
  await assert.rejects(
    () => b.client.request(b.entryFor(c), 'POST', '/api/message', { body: { text: 'as A', origin: { relayId: aId, hops: 2 } } }),
    (error) => error.code === CODES.originMismatch,
  );

  // B's agent passes C's reply back to A: the prompt it acts on was A's,
  // verified on B, so B may answer A; A sees B, verified.
  assert.equal(originWeightedFor(onB, b.registry.get(b.entryFor(a).id)), true);
  await b.client.request(b.entryFor(a), 'POST', '/api/message', {
    body: { text: 'C says: done', origin: { relayId: bId, conversationId: 'conv-on-b', hops: 2 } },
    hops: 2,
  });
  const backOnA = a.seen.at(-1).request.origin;
  assert.equal(backOnA.verified, true);
  assert.equal(backOnA.entryId, a.entryFor(b).id);
  assert.equal(originWeightedFor(backOnA, a.registry.get(a.entryFor(b).id)), true);
});

test('rotation with a request in flight on the old key: it succeeds; a failed check or save on the holder leaves the old key current', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entryOnB = b.entryFor(a);
  const oldKey = a.entryFor(b).peerToken;
  assert.equal(currentKeyHash(b, entryOnB), hashPeerKey(oldKey));

  // The holder's check at the issuer fails: the delivery is refused, the
  // pending key goes, and the old one stays current on both sides.
  const realRequest = a.client.request;
  a.client.request = async (relay, method, route, options) => {
    if (route === REMOTE_RELAY_PEER_KEY_PATHS.check) throw new Error('the check did not get through (test)');
    return realRequest(relay, method, route, options);
  };
  const failedCheck = await b.peerKeys.issueTo(entryOnB.id, { reason: 'rotation' });
  a.client.request = realRequest;
  assert.equal(failedCheck.ok, false);
  assert.equal(a.entryFor(b).peerToken, oldKey);
  assert.equal(currentKeyHash(b, entryOnB), hashPeerKey(oldKey));
  assert.equal(b.entryFor(a).peerKeys.some((key) => !key.confirmedAt), false, 'no pending key is left');
  assert.equal((await b.call('/api/relay/identity', { token: oldKey })).status, 200);

  // The holder's save fails: the same.
  const realSet = a.settings.set;
  a.settings.set = () => { throw new Error('the disk is full (test)'); };
  const failedSave = await b.peerKeys.issueTo(entryOnB.id, { reason: 'rotation' });
  a.settings.set = realSet;
  assert.equal(failedSave.ok, false);
  assert.equal(a.entryFor(b).peerToken, oldKey);
  assert.equal(currentKeyHash(b, entryOnB), hashPeerKey(oldKey));
  assert.equal((await b.call('/api/relay/identity', { token: oldKey })).status, 200);

  // A rotation that goes through, with a request on the old key in flight.
  const [inFlight, rotated] = await Promise.all([
    b.call('/api/message', { method: 'POST', token: oldKey, body: { text: 'during', origin: { relayId: a.registry.instanceId() } } }),
    b.peerKeys.issueTo(entryOnB.id, { reason: 'rotation' }),
  ]);
  assert.equal(inFlight.status, 200, JSON.stringify(inFlight.body));
  assert.equal(inFlight.body.originVerified, undefined, 'verified: no unverified notice');
  assert.equal(rotated.ok, true, JSON.stringify(rotated));
  const newKey = await until(() => {
    const held = a.entryFor(b).peerToken;
    return held !== oldKey && currentKeyHash(b, entryOnB) === hashPeerKey(held) ? held : null;
  }, 'the new key confirmed on first use');
  // The old key keeps working for 10 minutes after the new one is confirmed.
  assert.equal((await b.call('/api/relay/identity', { token: oldKey })).status, 200);
  b.state.offsetMs = PEER_KEY_LIMITS.retireGraceMs + 1000;
  assert.equal((await b.call('/api/relay/identity', { token: oldKey })).status, 401);
  assert.equal((await b.call('/api/relay/identity', { token: newKey })).status, 200);
});

test('new ↔ new from an old pairing: keys both ways within one health interval, then token claims of each other are refused', async (t) => {
  const a = await startRelay('relay-alpha');
  const b = await startRelay('relay-beta');
  t.after(async () => { await a.close(); await b.close(); });
  // Paired before keys: each holds the other's token, protocol 1 recorded.
  a.registry.add({ url: b.baseUrl, token: b.state.ownerToken, relayId: b.registry.instanceId(), name: 'relay-beta', protocol: 1 });
  b.registry.add({ url: a.baseUrl, token: a.state.ownerToken, relayId: a.registry.instanceId(), name: 'relay-alpha', protocol: 1 });
  // Before: a claim on the token is taken, unverified.
  const before = await b.call('/api/message', { method: 'POST', headers: { 'x-oar-remote-origin': a.registry.instanceId() }, body: { text: 'x' } });
  assert.equal(before.status, 200);
  assert.equal(before.body.originVerified, false);

  // One health pass on each side (both upgraded), no step of the owner's.
  await Promise.all([a.registry.checkAll(), b.registry.checkAll()]);
  await until(() => [[a, b], [b, a]].every(([holder, issuer]) => {
    const held = holder.entryFor(issuer);
    return held?.peerToken && held.tokenMode === 'peer' && currentKeyHash(issuer, issuer.entryFor(holder)) === hashPeerKey(held.peerToken);
  }), 'keys both ways, each confirmed, the tokens dropped');
  for (const [holder, issuer] of [[a, b], [b, a]]) {
    const held = holder.entryFor(issuer);
    assert.equal(held.token, undefined, `${holder.name} dropped ${issuer.name}'s token`);
    assert.equal(held.protocol, 2);
    const view = issuer.registry.listPublic().find((item) => item.id === issuer.entryFor(holder).id);
    assert.equal(view.peerKey.status, 'active');
    noSecrets(view, held.peerToken, a.state.ownerToken, b.state.ownerToken);
  }
  // Prompts on the keys are verified.
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'keyed', origin: { relayId: a.registry.instanceId() } } });
  assert.equal(b.seen.at(-1).request.verified, true);
  // Each relay's token claiming the other: refused.
  for (const [receiver, claimed] of [[b, a], [a, b]]) {
    const refused = await receiver.call('/api/message', { method: 'POST', headers: { 'x-oar-remote-origin': claimed.registry.instanceId() }, body: { text: 'y' } });
    assert.equal(refused.status, 403, receiver.name);
    assert.equal(refused.body.code, CODES.peerKeyRequired, receiver.name);
  }
});

test('new A downgraded to old: after three probes B stops requiring A\'s key, and A\'s prompts arrive unverified; upgraded again, the kept key works', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const aId = a.registry.instanceId();
  const entryId = b.entryFor(a).id;
  const keyOfA = a.entryFor(b).peerToken;
  const claimOfA = () => b.call('/api/message', { method: 'POST', headers: { 'x-oar-remote-origin': aId }, body: { text: 'from the old build', origin: { relayId: aId, conversationId: 'conv-old' } } });

  // A runs 0.9.26 again. Neither side holds the other's token any more, so
  // the owner re-adds A on B from its link (and B on A, which the token
  // claims below stand for).
  a.state.oldVersion = true;
  const relinked = await b.pairing.addFromLink({ url: a.baseUrl, token: a.state.ownerToken, pairBack: false });
  assert.equal(relinked.ok, true, JSON.stringify(relinked));
  assert.equal(b.registry.get(entryId).protocol, 1);
  // One probe at protocol 1 (the re-add's): nothing changes yet.
  assert.equal(b.registry.get(entryId).downgraded, false);
  assert.equal((await claimOfA()).body.code, CODES.peerKeyRequired);
  // Two more health probes: three in a row.
  await b.registry.check(entryId);
  assert.equal(b.registry.get(entryId).downgraded, false);
  await b.registry.check(entryId);
  const downgraded = b.registry.get(entryId);
  assert.equal(downgraded.downgraded, true);
  assert.equal(downgraded.everKeyed, true, 'the latch stays (pinning)');
  assert.ok(downgraded.peerKeys.some((key) => key.hash === hashPeerKey(keyOfA)), 'A\'s key is kept');
  assert.equal(b.registry.listPublic().find((item) => item.id === entryId).peerKey.status, 'older');
  // A's prompts on B's token: taken, unverified, no weight.
  const accepted = await claimOfA();
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.originVerified, false);
  const unverified = b.seen.at(-1).request.origin;
  assert.equal(unverified.verified, false);
  assert.equal(originCarriesWeight(unverified, (id) => b.registry.get(id)), false);

  // A upgraded again: the next probe sees protocol 2, and A's kept key works.
  a.state.oldVersion = false;
  await b.registry.check(entryId);
  assert.equal(b.registry.get(entryId).downgraded, false);
  assert.equal(b.registry.get(entryId).protocol, 2);
  assert.equal(a.entryFor(b).peerToken, keyOfA, 'A kept B\'s key all along');
  await a.client.request(a.entryFor(b), 'POST', '/api/message', { body: { text: 'back', origin: { relayId: aId, conversationId: 'conv-new' } } });
  const resumed = b.seen.at(-1).request;
  assert.equal(resumed.verified, true);
  assert.equal(originCarriesWeight(resumed.origin, (id) => b.registry.get(id)), true);
  // And B requires it again.
  assert.equal((await claimOfA()).body.code, CODES.peerKeyRequired);
});

test('auth: a key not yet checked opens the check alone; a peer key on the socket is refused and not counted', async (t) => {
  const { a, b } = await pairedRelays();
  t.after(async () => { await a.close(); await b.close(); });
  const entry = b.entryFor(a);
  // A pending key, as an issuance leaves it before the holder's check.
  const pending = mintPeerKey();
  b.registry.patchPeerFields(entry.id, (stored) => ({ peerKeys: [...stored.peerKeys, { hash: hashPeerKey(pending), seq: stored.peerKeySeq + 1, issuedAt: new Date().toISOString() }] }));
  assert.equal((await b.call('/api/relay/identity', { token: pending })).status, 401);
  const check = await b.call('/api/remote-relays/peer-key/check', { token: pending });
  assert.equal(check.status, 200);
  assert.equal(check.body.issuer, b.registry.instanceId());
  assert.equal(check.body.holder, a.registry.instanceId());
});

test('pinning compares scheme and host without case, the path with it', () => {
  const peerKeys = createPeerKeyService({ registry: { list: () => [], listAll: () => [], get: () => null }, client: {}, logger: quietLogger() });
  const entry = { id: 'rr_pin', name: 'pin-test', everKeyed: true, epoch: 2, url: 'https://relay-b.example.test/oar', relayId: 'relay-b-0002' };
  assert.deepEqual(peerKeys.pinnedChangeFields(entry, { url: 'HTTPS://Relay-B.Example.Test/oar' }), {}, 'scheme and host case: the same address');
  assert.deepEqual(peerKeys.pinnedChangeFields(entry, { url: 'https://relay-b.example.test:443/oar/' }), {}, 'the default port and a trailing slash: the same');
  const pathCase = peerKeys.pinnedChangeFields(entry, { url: 'https://relay-b.example.test/OAR' });
  assert.equal(pathCase.identityHold?.reason, 'url', 'another base path, even by case only, is held');
  assert.equal(pathCase.epoch, 3);
  assert.equal(peerKeys.pinnedChangeFields(entry, { url: 'https://relay-b.example.test./oar' }).identityHold?.reason, 'url', 'a trailing-dot host counts as a change');
  assert.equal(pinnedUrlKey('not a url'), 'not a url');
});

test('normalised fields and the row state: older OAR, waiting, active', () => {
  const fields = normalizePeerKeyFields({ peerKeys: [{ hash: 'nothex' }, { hash: 'b'.repeat(64), seq: 2 }], peerToken: 'not-a-key', epoch: -1 });
  assert.equal(fields.peerKeys.length, 1);
  assert.equal(fields.peerToken, undefined);
  assert.equal(fields.epoch, 0);
  assert.equal(describePeerKeyState({ protocol: 1, peerKeys: [] }).status, 'older');
  assert.equal(describePeerKeyState({ protocol: 2, peerKeys: [] }).status, 'waiting');
  assert.equal(describePeerKeyState({ protocol: 2, peerKeys: [{ hash: 'c'.repeat(64), seq: 1, confirmedAt: new Date().toISOString() }] }).status, 'active');
  assert.ok(PEER_KEY_LIMITS.rotateAfterMs > PEER_KEY_LIMITS.retiredRequestMs);
});

// Every call the client makes to a paired relay, as the dispatcher, the ask,
// event and Inbox links and the health probe build them. Each must be in the
// peer routes, or the key would be refused there. Read from the sources, so a
// new call that is not listed fails here.
test('every path a relay calls on a paired relay is in REMOTE_RELAY_PEER_ROUTES (billing and answers excepted, on purpose)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sources = ['remote-relay-dispatcher.mjs', 'relay-ask-link-service.mjs', 'relay-event-link-service.mjs', 'remote-relay-client.mjs', 'remote-inbox-watch-service.mjs', 'remote-relay-peer-keys.mjs', 'remote-relay-pairing.mjs']
    .map((file) => fs.readFileSync(path.join(here, file), 'utf8')).join('\n');
  const patterns = REMOTE_RELAY_PEER_ROUTES.map((key) => {
    const [method, route] = key.split(' ');
    return { method, regex: new RegExp(`^${route.replace(/:[A-Za-z]+/g, '[^/]+')}$`) };
  });
  const allowed = (method, route) => patterns.some((pattern) => pattern.method === method && pattern.regex.test(route));
  // Literal paths in calls: call(ctx, 'GET', '/api/...') and request(relay, 'GET', '/api/...').
  const literal = [...sources.matchAll(/(?:call|request)\([^,]+, '(GET|POST|PATCH|DELETE)', '(\/api\/[^'?]+)'/g)].map((m) => [m[1], m[2]]);
  // Session paths: sessionPath(session, suffix).
  const session = [...sources.matchAll(/call\([^,]+, '(GET|POST|PATCH)', sessionPath\([^,)]+(?:, (?:'([^']*)'|`([^`]*)`|([A-Z_]+)))?\)/g)]
    .map((m) => [m[1], `/api/conversation/x${(m[2] ?? m[3] ?? (m[4] === 'SESSION_SETTINGS_SUFFIX' ? '/settings' : '')).replace(/\$\{[^}]+\}/g, 'x')}`]);
  const known = [
    ['GET', '/api/settings/claude'], ['GET', '/api/settings/claude-api'], ['GET', '/api/image-usage'], ['GET', '/api/openai-image-presets'],
    ['GET', '/api/conversation-groups'], ['POST', '/api/relay-events/remote/subscribe'], ['POST', '/api/relay-events/remote/pull'],
    ['POST', '/api/relay-asks/remote/ask'], ['POST', '/api/relay-asks/remote/status'], ['POST', '/api/relay-asks/remote/withdraw'], ['GET', '/api/relay-asks/remote/inbox'],
    ['POST', '/api/remote-relays/peer-key'], ['GET', '/api/remote-relays/peer-key/check'], ['POST', '/api/remote-relays/peer-key/request'],
  ];
  const excluded = new Set(['POST /api/conversation/x/billing', 'POST /api/remote-relays/pair', 'GET /api/settings/pwa-app-name']);
  const calls = [...literal, ...session, ...known];
  assert.ok(literal.length >= 10 && session.length >= 5, `found ${literal.length} literal and ${session.length} session calls`);
  for (const [method, route] of calls) {
    if (excluded.has(`${method} ${route}`)) continue;
    assert.ok(allowed(method, route), `${method} ${route} is in REMOTE_RELAY_PEER_ROUTES`);
  }
});
