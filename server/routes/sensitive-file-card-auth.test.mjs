import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createRelayAuth } from '../services/relay-auth.mjs';
import { createOwnerSecretStore } from '../services/owner-secret-store.mjs';
import { createBrowserSessionService, createSignInCodes } from '../services/browser-session-service.mjs';
import { createLocalRequestCheck } from '../services/request-boundary.mjs';
import { sanitizeRelayQuestionContext } from '../services/relay-question-context.mjs';
import { questionExpiresAt } from '../../shared/question-timeout.mjs';
import { createAskUserBridge } from '../../shared/ask-user-bridge.mjs';
import { PEER_KEY_PREFIX } from '../../shared/relay-credentials.mjs';
import { REMOTE_RELAY_ERROR_CODES } from '../../shared/remote-relay-contract.mjs';
import { createRemoteRelayRegistry } from '../services/remote-relay-registry-service.mjs';
import { createPeerKeyService, hashPeerKey, mintPeerKey } from '../services/remote-relay-peer-keys.mjs';
import { createCanUseTool } from '../claude-worker/claude-sdk-adapter.mjs';
import { registerAskUserRoutes } from './ask-user-routes.mjs';

// A sensitive-file Safety check card, end to end in one process (agent auth
// §10 items 6 and 29): the adapter raises the card through the question
// bridge with the session's own agent token, as a worker does; only the
// person's browser session (its cookie with its proof key) answers it. The
// session's agent token, another session's, the cli agent token, a paired
// relay (on its own key, or an older one on the owner token) and the cookie
// without its proof key all get 403, and the card stays open. Every
// credential is made at run time and never printed.

const COOKIE = 'copilot_auth';
const OWNER_TOKEN = crypto.randomUUID();
const CONV = 'conv-fixture-profile';
const OTHER_CONV = 'conv-fixture-other';
const QUEUE_ID = 'q-fixture-turn';
// A paired relay that signs in here with its own confirmed key.
const KEYED_RELAY_ID = 'relay-bench-peer';
const NOW = '2026-03-02T10:00:00.000Z';
const SENSITIVE_PATH = '/srv/sample-app/work/.bashrc';
const SENSITIVE_OPTIONS = {
  suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
  blockedPath: SENSITIVE_PATH,
  decisionReason: `Claude requested permissions to edit ${SENSITIVE_PATH} which is a sensitive file.`,
  decisionReasonType: 'safetyCheck',
  toolUseID: 'toolu_sample_3',
  requestId: 'req-sample-3',
};

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

function formatQuestionRow(row) {
  if (!row) return null;
  const envelope = JSON.parse(row.request || '{}') || {};
  return {
    id: row.id,
    queueId: row.queue_id,
    conversationId: row.conversation_id,
    sdkSessionId: row.sdk_session_id || null,
    messageId: row.message_id,
    prompt: row.prompt,
    choices: JSON.parse(row.choices || '[]'),
    context: envelope.context || null,
    allowFreeform: envelope.allowFreeform ?? true,
    status: row.status,
    answer: row.answer || null,
  };
}

async function bootRelay() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-sensitive-card-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ authToken: OWNER_TOKEN, port: 3333 }));
  const store = createOwnerSecretStore({ dataDir: path.join(dir, 'data'), logger: { log() {}, warn() {} } });
  store.bootstrap({ config: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath });

  const db = new Database(':memory:');
  applySchema(db);
  for (const id of [CONV, OTHER_CONV]) {
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, id, NOW, NOW);
  }
  db.prepare(`INSERT INTO queue (id, conversation_id, text, status, timestamp) VALUES (?, ?, 'add an alias', 'processing', ?)`).run(QUEUE_ID, CONV, NOW);
  const stmts = { ...createQuestionRepository(db), findQById: db.prepare(`SELECT * FROM queue WHERE id = ?`) };

  // The paired-relay registry and its key service, as the runtime wires them
  // into auth: one entry holding a confirmed key (`oarp1_…`).
  const quiet = { log() {}, warn() {}, error() {} };
  const settings = new Map();
  const registry = createRemoteRelayRegistry({
    readSetting: (key) => settings.get(key) ?? null,
    writeSetting: (key, value) => settings.set(key, value),
    client: { tokenFor: () => '', probe: async () => ({}) },
    logger: quiet,
  });
  const peerKeys = createPeerKeyService({ registry, client: { tokenFor: () => '' }, logger: quiet });
  registry.setPeerKeys(peerKeys);
  const entry = registry.add({ url: 'https://relay-bench.example.test', relayId: KEYED_RELAY_ID, name: 'bench-peer', protocol: 2 });
  const peerKey = mintPeerKey();
  const stamp = new Date().toISOString();
  registry.patchPeerFields(entry.id, {
    everKeyed: true,
    keyRelayId: KEYED_RELAY_ID,
    keyUrl: entry.url,
    peerKeySeq: 1,
    peerKeys: [{ hash: hashPeerKey(peerKey), seq: 1, issuedAt: stamp, checkedAt: stamp, confirmedAt: stamp }],
  });

  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const relayAuth = createRelayAuth({
    app,
    verifyOwnerToken: (value) => store.verifyOwnerToken(value),
    verifyAgentToken: (value) => store.verifyAgentToken(value),
    browserSessions: createBrowserSessionService({ db, logger: { log() {}, warn() {} } }),
    signInCodes: createSignInCodes(),
    cookieName: COOKIE,
    parseCookies,
    appendSetCookie,
    localRequestCheck: createLocalRequestCheck(),
    resolvePeerKey: (value) => peerKeys.resolvePeerKey(value),
    afterPrincipal: (req, res, principal) => peerKeys.gate(req, res, principal),
    logger: { log() {}, warn() {} },
  });
  app.post('/api/auth/session', relayAuth.signIn);
  let questionCounter = 0;
  registerAskUserRoutes(app, {
    auth: relayAuth.auth,
    io: { emit() {} },
    db,
    stmts,
    runtimeState: { featureFlags: {} },
    uuidv4: () => `card-${(questionCounter += 1)}`,
    ts: () => NOW,
    questionExpiresAt,
    sanitizeRelayQuestionPrompt: ({ prompt }) => String(prompt || ''),
    sanitizeRelayQuestionRequest: (value) => JSON.stringify(value),
    sanitizeRelayQuestionContext: (raw) => sanitizeRelayQuestionContext(raw, { normalizeRelayMode: (mode) => mode || null, defaultRelayMode: 'agent' }),
    parseQuestionRequest: (value) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? null; } catch { return null; } },
    normalizeQuestionChoices: (choices) => (Array.isArray(choices) ? choices.map(String) : []),
    formatQuestionRow,
    normalizeRelayMode: (mode) => String(mode || '').trim() || null,
    DEFAULT_RELAY_MODE: 'agent',
    remoteRelayInbound: {
      listRelays: () => registry.list().map(({ id, relayId, name, url, protocol, epoch, identityHold }) => ({ id, relayId, name, url, protocol, epoch, identityHold: !!identityHold })),
      selfNames: () => ['bench-relay'],
      inboundEnabled: () => true,
    },
  });

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, { method = 'GET', headers = {}, body } = {}) => fetch(`${base}${route}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const card = (id) => db.prepare(`SELECT status, answer FROM relay_questions WHERE id = ?`).get(id);
  const pendingCards = () => db.prepare(`SELECT id FROM relay_questions WHERE status = 'pending'`).all().map((row) => row.id);
  return {
    base,
    call,
    card,
    pendingCards,
    store,
    peerKey,
    peerKeyIsConfirmed: () => !!peerKeys.resolvePeerKey(peerKey) && !peerKeys.resolvePeerKey(peerKey).unconfirmed,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// The person's browser: the sign-in exchange gives a session cookie and,
// once, the session's proof key, which the relay's own page sends with every
// cookie request in X-OAR-Session-Proof.
async function signInBrowser(relay) {
  const signedIn = await relay.call('/api/auth/session', { method: 'POST', headers: { ...bearer(OWNER_TOKEN), 'Sec-Fetch-Site': 'same-origin' }, body: { deviceId: 'dev-test' } });
  assert.equal(signedIn.status, 200);
  const cookie = String(signedIn.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(/^copilot_auth=oars1_/.test(cookie), 'a browser session cookie, not the owner token');
  const { proof } = await signedIn.json();
  assert.ok(/^oark1_/.test(proof), 'a proof key');
  return { cookie, headers: { Cookie: cookie, 'X-OAR-Session-Proof': proof, Origin: relay.base } };
}
// An answer as the web UI sends it: the card's session id with it.
const answer = (text) => ({ answer: text, sdk_session_id: CONV });

// The worker's api helper, on the session's own agent token: JSON or a thrown error.
function workerApi(relay, token) {
  return async (method, route, body) => {
    const response = await relay.call(route, { method, headers: bearer(token), body });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(`${method} ${route} ${response.status}`), { status: response.status });
    return payload;
  };
}

async function waitForCard(relay) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [id] = relay.pendingCards();
    if (id) return id;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The card never appeared');
}

test('a sensitive-file Safety check card: only the person\'s browser session answers it; agent tokens and a paired relay (its key included) get 403', async () => {
  const relay = await bootRelay();
  // The turn: aborted at the end, so a failed assertion leaves no poll behind.
  const turn = new AbortController();
  try {
    const sessionToken = relay.store.mintAgentToken({ kind: 's', subject: CONV });
    const otherSessionToken = relay.store.mintAgentToken({ kind: 's', subject: OTHER_CONV });
    const cliToken = relay.store.mintAgentToken({ kind: 'c' });

    const bridge = createAskUserBridge({
      api: workerApi(relay, sessionToken),
      getActiveMessage: () => ({ id: QUEUE_ID, conversationId: CONV, relayMode: 'autopilot' }),
      sdkSessionId: CONV,
      questionPollMs: 10,
    });
    const input = { file_path: SENSITIVE_PATH, content: 'alias ll="ls -l"' };
    const decision = createCanUseTool({ askUserBridge: bridge })('Write', input, { ...SENSITIVE_OPTIONS, signal: turn.signal });
    const id = await waitForCard(relay);

    // The card as the person reads it: person-only, the sensitive-file kind.
    const asOwner = await relay.call(`/api/relay-question/${id}`, { headers: bearer(OWNER_TOKEN) });
    const { question } = await asOwner.json();
    assert.deepEqual(question.choices, ['Allow once', 'Deny']);
    assert.equal(question.context.source, 'ClaudeSafetyCheck');
    assert.equal(question.context.kind, 'sensitive-file');
    assert.equal(question.context.personOnly, true);
    assert.equal(question.allowFreeform, false);

    // Hidden from agents' lists, its own session's included.
    const listed = await relay.call(`/api/relay-questions?conversationId=${CONV}&status=pending`, { headers: bearer(sessionToken) });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).questions.map((row) => row.id), []);

    // No agent token answers or dismisses it: not the session's own, not
    // another session's, not the cli token's.
    for (const [label, token] of [['own session', sessionToken], ['other session', otherSessionToken], ['cli', cliToken]]) {
      for (const action of ['answer', 'dismiss']) {
        const refused = await relay.call(`/api/relay-question/${id}/${action}`, { method: 'POST', headers: bearer(token), body: answer('Allow once') });
        assert.equal(refused.status, 403, `${label} ${action}`);
        assert.equal((await refused.json()).code, 'AUTH_PERSON_REQUIRED', `${label} ${action}`);
      }
    }
    // Another session's agent may not time it out (a timeout denies, and
    // only the card's own worker reports one).
    const foreignTimeout = await relay.call(`/api/relay-question/${id}/timeout`, { method: 'POST', headers: bearer(otherSessionToken), body: {} });
    assert.equal(foreignTimeout.status, 403);

    // A paired relay on its own confirmed key, naming itself as the client
    // does or not: the key opens only the relay-to-relay routes, and
    // answering or dismissing a card is not one of them.
    assert.equal(relay.peerKeyIsConfirmed(), true);
    for (const headers of [bearer(relay.peerKey), { ...bearer(relay.peerKey), 'x-oar-remote-origin': KEYED_RELAY_ID, 'x-oar-remote-hops': '1' }]) {
      for (const action of ['answer', 'dismiss']) {
        const refused = await relay.call(`/api/relay-question/${id}/${action}`, { method: 'POST', headers, body: answer('Allow once') });
        assert.equal(refused.status, 403, `peer key ${action}`);
        assert.equal((await refused.json()).code, REMOTE_RELAY_ERROR_CODES.peerScope, `peer key ${action}`);
      }
    }
    // The owner token claiming the keyed relay: that relay would have used its key.
    const keyless = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: { ...bearer(OWNER_TOKEN), 'x-oar-remote-origin': KEYED_RELAY_ID, 'x-oar-remote-hops': '1' }, body: answer('Allow once') });
    assert.equal(keyless.status, 403);
    assert.equal((await keyless.json()).code, REMOTE_RELAY_ERROR_CODES.peerKeyRequired);
    // An older paired relay (no key): it calls with the owner token and names itself.
    const fromPaired = { ...bearer(OWNER_TOKEN), 'x-oar-remote-origin': 'instance-lab', 'x-oar-remote-hops': '1' };
    const pairedAnswer = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: fromPaired, body: answer('Allow once') });
    assert.equal(pairedAnswer.status, 403);
    assert.equal((await pairedAnswer.json()).code, 'AUTH_PERSON_REQUIRED');
    const bodyOrigin = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: bearer(OWNER_TOKEN), body: { ...answer('Allow once'), origin: { relayId: 'instance-lab', hops: 1 } } });
    assert.equal(bodyOrigin.status, 403, 'a body origin marks another relay too');
    // A key this relay never issued is no credential at all.
    const unknownKey = `${PEER_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
    assert.equal((await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: bearer(unknownKey), body: answer('Allow once') })).status, 401);

    assert.deepEqual(relay.card(id), { status: 'pending', answer: null }, 'every refused call left the card open');

    // The person's browser: the session cookie and its proof key.
    const { cookie, headers: browser } = await signInBrowser(relay);

    // The cookie alone (a page that never got the proof key): refused.
    const cookieOnly = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: { Cookie: cookie, Origin: relay.base, 'Sec-Fetch-Site': 'same-origin' }, body: answer('Allow once') });
    assert.equal(cookieOnly.status, 403);
    assert.equal((await cookieOnly.json()).code, 'AUTH_SESSION_PROOF');
    assert.deepEqual(relay.card(id), { status: 'pending', answer: null }, 'the cookie without its proof left the card open');

    // A page on another port of this host carries the cookie too: refused.
    const preview = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: { ...browser, 'Sec-Fetch-Site': 'same-site', Origin: 'http://127.0.0.1:5173' }, body: answer('Allow once') });
    assert.equal(preview.status, 403);
    assert.equal((await preview.json()).code, 'AUTH_CROSS_SITE');
    // Typed text is no answer, even from the person.
    const typed = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: { ...browser, 'Sec-Fetch-Site': 'same-origin' }, body: answer('yes, go ahead') });
    assert.equal(typed.status, 400);
    assert.deepEqual(relay.card(id), { status: 'pending', answer: null });

    const answered = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: { ...browser, 'Sec-Fetch-Site': 'same-origin' }, body: answer('Allow once') });
    assert.equal(answered.status, 200);
    assert.deepEqual(relay.card(id), { status: 'answered', answer: 'Allow once' });
    const allowed = await decision;
    assert.deepEqual(allowed, { behavior: 'allow', updatedInput: input });
    assert.equal('updatedPermissions' in allowed, false, 'once, never "always allow"');
  } finally {
    turn.abort();
    await relay.close();
  }
});

test('a sensitive-file card an agent tried to answer still denies on Deny from the person', async () => {
  const relay = await bootRelay();
  // The turn: aborted at the end, so a failed assertion leaves no poll behind.
  const turn = new AbortController();
  try {
    const sessionToken = relay.store.mintAgentToken({ kind: 's', subject: CONV });
    const bridge = createAskUserBridge({
      api: workerApi(relay, sessionToken),
      getActiveMessage: () => ({ id: QUEUE_ID, conversationId: CONV, relayMode: 'agent' }),
      sdkSessionId: CONV,
      questionPollMs: 10,
    });
    const input = { file_path: '/srv/sample-app/work/.git/hooks/pre-commit', old_string: 'exit 0', new_string: 'exit 1' };
    const decision = createCanUseTool({ askUserBridge: bridge })('Edit', input, {
      ...SENSITIVE_OPTIONS,
      blockedPath: input.file_path,
      decisionReason: `Claude requested permissions to edit ${input.file_path} which is a sensitive file.`,
      signal: turn.signal,
    });
    const id = await waitForCard(relay);
    const refused = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: bearer(sessionToken), body: answer('Allow once') });
    assert.equal(refused.status, 403);

    const { headers: browser } = await signInBrowser(relay);
    const denied = await relay.call(`/api/relay-question/${id}/answer`, { method: 'POST', headers: { ...browser, 'Sec-Fetch-Site': 'same-origin' }, body: answer('Deny') });
    assert.equal(denied.status, 200);
    const outcome = await decision;
    assert.equal(outcome.behavior, 'deny');
    assert.match(outcome.message, /^Not changed: Claude Code marks \/srv\/sample-app\/work\/\.git\/hooks\/pre-commit as a sensitive file/);
  } finally {
    turn.abort();
    await relay.close();
  }
});
