// The worker log route behind the relay's real `auth`: the tail and paging,
// the scrubbing, and who may read it (the person, and an agent token for its
// own conversation only). Every credential is made at run time and never
// printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

import { createRelayAuth } from '../services/relay-auth.mjs';
import { createOwnerSecretStore } from '../services/owner-secret-store.mjs';
import { createBrowserSessionService, createSignInCodes } from '../services/browser-session-service.mjs';
import { migrateBrowserSessions } from '../migrations/0041-browser-sessions.mjs';
import { createLocalRequestCheck } from '../services/request-boundary.mjs';
import { PEER_KEY_PREFIX } from '../../shared/relay-credentials.mjs';
import { ROUTE_ACCESS, routePolicyFor } from '../../shared/relay-route-policy.mjs';
import { WORKER_LOG_MESSAGES, WORKER_LOG_ROUTE, registerWorkerLogRoutes } from './worker-log-routes.mjs';

const fake = (...parts) => parts.join('');
const OWNER = crypto.randomUUID();
const CONVERSATIONS = {
  'conv-1': { id: 'conv-1', sdk_session_id: 'sess-1' },
  'conv-2': { id: 'conv-2', sdk_session_id: 'sess-2' },
  'conv-new': { id: 'conv-new', sdk_session_id: null },
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(/;\s*/)) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-log-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logDir = path.join(dir, 'logs');
  fs.mkdirSync(logDir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ authToken: OWNER, port: 3333 }));
  const store = createOwnerSecretStore({ dataDir: path.join(dir, 'data'), logger: { log() {}, warn() {} } });
  store.bootstrap({ config: JSON.parse(fs.readFileSync(configPath, 'utf8')), configPath });
  const db = new Database(':memory:');
  migrateBrowserSessions(db);
  const peerKey = `${PEER_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const app = express();
  app.set('trust proxy', 'loopback');
  const relayAuth = createRelayAuth({
    app,
    verifyOwnerToken: (value) => store.verifyOwnerToken(value),
    verifyAgentToken: (value) => store.verifyAgentToken(value),
    resolvePeerKey: (value) => (value === peerKey ? { entryId: 'peer-1', relayId: 'relay-peer', name: 'Peer' } : null),
    browserSessions: createBrowserSessionService({ db, logger: { log() {}, warn() {} } }),
    signInCodes: createSignInCodes(),
    cookieName: 'copilot_auth',
    parseCookies,
    appendSetCookie: () => {},
    localRequestCheck: createLocalRequestCheck(),
    logger: { log() {}, warn() {} },
  });
  registerWorkerLogRoutes(app, {
    auth: relayAuth.auth,
    getConversation: (id) => CONVERSATIONS[id] || null,
    providerOf: (id) => (CONVERSATIONS[id] ? 'claude' : ''),
    getLaunchEnv: () => ({ COPILOT_WEB_RELAY_LOG_DIR: logDir }),
    remoteRelayInbound: { listRelays: () => [], inboundEnabled: () => true },
  });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (conversationId, { query = '', token = OWNER, headers = {} } = {}) => {
    const response = await fetch(`${base}/api/conversation/${encodeURIComponent(conversationId)}/worker-log${query}`, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return {
    logDir,
    get,
    peerKey,
    agentToken: (conversationId) => store.mintAgentToken({ kind: 's', subject: conversationId }),
    cliToken: () => store.mintAgentToken({ kind: 'c' }),
    write: (sdkSessionId, text) => fs.writeFileSync(path.join(logDir, `worker-${sdkSessionId}.log`), text),
  };
}

test('the route is a row for agents and closed to paired relays', () => {
  assert.equal(routePolicyFor('GET', WORKER_LOG_ROUTE).agent, ROUTE_ACCESS.row);
  assert.equal(routePolicyFor('GET', WORKER_LOG_ROUTE).peer, ROUTE_ACCESS.deny);
});

test('the person gets the tail with its path, provider and session; an unknown conversation is 404', async (t) => {
  const fx = await boot(t);
  fx.write('sess-1', Array.from({ length: 2600 }, (_, index) => `[claude 2026-11-15T09:00:00.000Z] line ${index + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(fx.logDir, 'worker-sess-1.log.1'), 'older run\n');
  const tail = await fx.get('conv-1');
  assert.equal(tail.status, 200);
  assert.equal(tail.headers.get('cache-control'), 'no-store');
  assert.equal(tail.body.kind, 'file');
  assert.equal(tail.body.path, path.join(fx.logDir, 'worker-sess-1.log'));
  assert.equal(tail.body.dir, fx.logDir);
  assert.deepEqual([tail.body.provider, tail.body.sdkSessionId], ['claude', 'sess-1']);
  assert.deepEqual(tail.body.previous, [{ name: 'worker-sess-1.log.1', size: 10 }]);
  assert.equal(tail.body.lines.length, 2000);
  assert.equal(tail.body.lines[0].text, '[claude 2026-11-15T09:00:00.000Z] line 601');
  assert.equal(tail.body.hasMoreBefore, true);
  assert.equal(tail.body.endOffset, tail.body.size);

  const earlier = await fx.get('conv-1', { query: `?before=${tail.body.startOffset}&lines=2000` });
  assert.equal(earlier.status, 200);
  assert.equal(earlier.body.lines.length, 600);
  assert.equal(earlier.body.lines[0].text, '[claude 2026-11-15T09:00:00.000Z] line 1');
  assert.equal(earlier.body.endOffset, tail.body.startOffset);
  assert.equal(earlier.body.hasMoreBefore, false);

  assert.equal((await fx.get('conv-unknown')).status, 404);
});

test('no log yet: the file is not there; the path and folder are named, a new conversation\'s under its own id', async (t) => {
  const fx = await boot(t);
  const missing = await fx.get('conv-2');
  assert.equal(missing.status, 200);
  assert.deepEqual([missing.body.kind, missing.body.path, missing.body.dir, missing.body.message], ['none', path.join(fx.logDir, 'worker-sess-2.log'), fx.logDir, WORKER_LOG_MESSAGES.missing]);
  // No SDK session reported yet: the worker is launched under the conversation's id.
  const fresh = await fx.get('conv-new');
  assert.deepEqual([fresh.body.kind, fresh.body.path, fresh.body.sdkSessionId], ['none', path.join(fx.logDir, 'worker-conv-new.log'), 'conv-new']);
  fx.write('conv-new', 'first launch\n');
  assert.equal((await fx.get('conv-new')).body.text, 'first launch\n');
});

test('what the route answers is scrubbed: an OAuth token, an agent token, a Bearer header and a cookie', async (t) => {
  const fx = await boot(t);
  const oauth = fake('sk-ant-', 'oat01-', 'AbCdEfGhIjKlMnOpQrStUv');
  const agent = fake('oar', 'a1_', 's.Y29udi0x.', 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFi');
  const bearerValue = fake('ya29', '.a0AfB', '_byC9xQ');
  fx.write('sess-1', [
    `[claude] provider error: invalid x-api-key ${oauth}`,
    `[relay] POST /api/stream 401 OAR_AGENT_TOKEN=${agent}`,
    `[grok] request headers: Authorization: Bearer ${bearerValue}`,
    '[grok] Cookie: sid=Qm9iQm9iQm9i; theme=dark',
    '',
  ].join('\n'));
  const answer = await fx.get('conv-1');
  const raw = JSON.stringify(answer.body);
  for (const secret of [oauth, agent, bearerValue, 'Qm9iQm9iQm9i']) assert.ok(!raw.includes(secret), `${secret.slice(0, 6)}… is not in the answer`);
  assert.match(answer.body.text, /sk-\[redacted\]/);
  assert.match(answer.body.text, /OAR_AGENT_TOKEN=\[redacted\]/);
  assert.match(answer.body.text, /Authorization: Bearer \[redacted\]/);
  assert.match(answer.body.text, /Cookie: \[redacted\]/);
});

test('the conversation\'s own agent token reads it; another conversation\'s token is refused', async (t) => {
  const fx = await boot(t);
  fx.write('sess-1', 'conv-1 line\n');
  fx.write('sess-2', 'conv-2 line\n');
  const own = await fx.get('conv-1', { token: fx.agentToken('conv-1') });
  assert.equal(own.status, 200);
  assert.equal(own.body.text, 'conv-1 line\n');
  const other = await fx.get('conv-1', { token: fx.agentToken('conv-2') });
  assert.equal(other.status, 403);
  assert.equal(other.body.code, 'AUTH_CONVERSATION_MISMATCH');
  assert.equal(other.body.text, undefined);
  // Its own conversation's log, never this one.
  assert.equal((await fx.get('conv-2', { token: fx.agentToken('conv-2') })).body.text, 'conv-2 line\n');
  // A refusal says nothing about whether the conversation exists.
  assert.equal((await fx.get('conv-unknown', { token: fx.agentToken('conv-2') })).status, 403);
});

test('the cli token, a request another relay sent, and a pair key are refused', async (t) => {
  const fx = await boot(t);
  fx.write('sess-1', 'conv-1 line\n');
  const cli = await fx.get('conv-1', { token: fx.cliToken() });
  assert.equal(cli.status, 403);
  assert.equal(cli.body.code, 'AUTH_PERSON_REQUIRED');
  // On the owner token, but marked as sent by another relay's agent.
  const relayed = await fx.get('conv-1', { headers: { 'X-OAR-Remote-Origin': 'relay-other', 'X-OAR-Remote-Hops': '1' } });
  assert.equal(relayed.status, 403);
  assert.equal(relayed.body.code, 'AUTH_PERSON_REQUIRED');
  // An agent token claiming another relay is still only its own conversation's.
  const claiming = await fx.get('conv-1', { token: fx.agentToken('conv-2'), headers: { 'X-OAR-Remote-Origin': 'relay-other' } });
  assert.equal(claiming.status, 403);
  const peer = await fx.get('conv-1', { token: fx.peerKey });
  assert.equal(peer.status, 403);
  assert.equal(peer.body.code, 'REMOTE_RELAY_PEER_SCOPE');
  for (const refused of [cli, relayed, claiming, peer]) assert.equal(refused.body.text, undefined);
});
