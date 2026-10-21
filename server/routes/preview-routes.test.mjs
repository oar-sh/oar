import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';

import {
  createPreviewRegistry,
  normalizePreviewsConfig,
} from '../services/preview-registry-service.mjs';
import { createMemoryPreviewStore } from '../services/preview-store.mjs';
import { createPreviewScopeResolver, registerPreviewRoutes } from './preview-routes.mjs';

const AUTH_TOKEN = 'test-relay-token';

function previewConfig(overrides = {}) {
  return normalizePreviewsConfig({
    enabled: true,
    publicBaseUrl: 'https://preview.example.com',
    ...overrides,
  }, { env: {}, relayPort: 3333, relayHostnames: ['relay.example.com'], reservedPorts: [4445] });
}

async function startApi({
  config = previewConfig(),
  probeCalls = [],
  workspaceRoot = '',
  cardCalls = [],
  registry = createPreviewRegistry({ config }),
  resolveConversationScope,
} = {}) {
  const app = express();
  app.use(express.json());
  // Stand-in for the runtime's auth middleware: same contract (bearer token or
  // 401), without pulling the whole server runtime into a route test.
  const auth = (req, res, next) => {
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (presented !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  registerPreviewRoutes(app, {
    auth,
    previewRegistry: registry,
    previewHealthProbe: { probeNow: (token) => { probeCalls.push(token); } },
    resolvePreviewWorkspaceRoot: () => workspaceRoot,
    recordPreviewCard: (conversationId, preview) => { cardCalls.push({ conversationId, preview }); },
    ...(resolveConversationScope ? { resolveConversationScope } : {}),
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;

  async function call(path, { method = 'GET', body, token = AUTH_TOKEN, headers = {} } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  return {
    registry,
    call,
    probeCalls,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    },
  };
}

test('every preview route requires the relay token', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  for (const [method, path] of [['GET', '/api/previews'], ['POST', '/api/previews'], ['DELETE', `/api/previews/${'a'.repeat(32)}`]]) {
    const response = await api.call(path, { method, token: '' });
    assert.equal(response.status, 401, `${method} ${path} must require auth`);
  }
});

test('POST publishes a port and returns the public URL', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const created = await api.call('/api/previews', {
    method: 'POST',
    body: { conversationId: 'conv-1', port: 5173, label: 'web app' },
  });

  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.match(created.body.url, /^https:\/\/preview\.example\.com\/test_[0-9a-f]{32}\/$/);
  assert.equal(created.body.basePath, `/test_${created.body.preview.token}/`);
  assert.equal(created.body.preview.label, 'web app');
  // The card should never sit badge-less waiting for the next sweep.
  assert.deepEqual(api.probeCalls, [created.body.preview.token]);
});

test('POST rejects a missing, malformed or relay-owned port', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  for (const body of [{}, { port: 'abc' }, { port: null }]) {
    const response = await api.call('/api/previews', { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /port/i);
  }

  const relayPort = await api.call('/api/previews', { method: 'POST', body: { port: 3333 } });
  assert.equal(relayPort.status, 400);
  assert.match(relayPort.body.error, /belongs to the relay/);
});

test('POST refuses a non-loopback target', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const response = await api.call('/api/previews', {
    method: 'POST',
    body: { port: 8080, host: '169.254.169.254' },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /not loopback/);
});

test('GET lists everything, or one conversation when filtered', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  await api.call('/api/previews', { method: 'POST', body: { conversationId: 'conv-1', port: 5001 } });
  await api.call('/api/previews', { method: 'POST', body: { conversationId: 'conv-2', port: 5002 } });

  const all = await api.call('/api/previews');
  assert.equal(all.status, 200);
  assert.equal(all.body.enabled, true);
  assert.equal(all.body.publicBaseUrl, 'https://preview.example.com');
  assert.deepEqual(all.body.previews.map((entry) => entry.targetPort), [5001, 5002]);

  const scoped = await api.call('/api/previews?conversationId=conv-2');
  assert.deepEqual(scoped.body.previews.map((entry) => entry.targetPort), [5002]);
});

test('DELETE closes a preview and is 404 the second time', async (t) => {
  const api = await startApi();
  t.after(() => api.close());

  const created = await api.call('/api/previews', { method: 'POST', body: { port: 5173 } });
  const { token } = created.body.preview;

  const closed = await api.call(`/api/previews/${token}`, { method: 'DELETE' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.preview.token, token);
  assert.equal(api.registry.size, 0);

  const again = await api.call(`/api/previews/${token}`, { method: 'DELETE' });
  assert.equal(again.status, 404);
});

test('POST with dir publishes a static preview jailed to the workspace root', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'route-static-'));
  t.after(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(pathMod.join(workspace, 'dist'));
  fs.writeFileSync(pathMod.join(workspace, 'dist', 'index.html'), '<h1>hi</h1>');

  const api = await startApi({ workspaceRoot: workspace });
  t.after(() => api.close());

  const created = await api.call('/api/previews', {
    method: 'POST',
    body: { conversationId: 'conv-1', dir: './dist', label: 'built site' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.preview.mode, 'static');
  assert.equal(created.body.preview.rootDir, fs.realpathSync(pathMod.join(workspace, 'dist')));
  // Static previews are online by definition — no badge-less wait, no probe.
  assert.equal(created.body.preview.online, true);

  const escape = await api.call('/api/previews', {
    method: 'POST',
    body: { conversationId: 'conv-1', dir: '../..' },
  });
  assert.equal(escape.status, 400);
  assert.match(escape.body.error, /workspace root/);

  const both = await api.call('/api/previews', {
    method: 'POST',
    body: { port: 5173, dir: './dist' },
  });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /not both/);
});

test('every successful create offers a transcript card, with the full snapshot', async (t) => {
  const cardCalls = [];
  const api = await startApi({ cardCalls });
  t.after(() => api.close());

  const created = await api.call('/api/previews', {
    method: 'POST',
    body: { conversationId: 'conv-1', port: 5173, label: 'app' },
  });
  assert.equal(cardCalls.length, 1);
  assert.equal(cardCalls[0].conversationId, 'conv-1');
  assert.equal(cardCalls[0].preview.token, created.body.preview.token);

  // A refused create must not offer a card.
  await api.call('/api/previews', { method: 'POST', body: { port: 3333 } });
  assert.equal(cardCalls.length, 1);
});

test('a throwing card recorder does not break the create', async (t) => {
  const registryHolder = await startApi({ cardCalls: { push() { throw new Error('db down'); } } });
  t.after(() => registryHolder.close());
  const created = await registryHolder.call('/api/previews', {
    method: 'POST',
    body: { conversationId: 'conv-1', port: 5173 },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
});

test('POST with dir and no known workspace root is refused', async (t) => {
  const api = await startApi({ workspaceRoot: '' });
  t.after(() => api.close());
  const created = await api.call('/api/previews', { method: 'POST', body: { dir: './dist' } });
  assert.equal(created.status, 400);
  assert.match(created.body.error, /workspace root/);
});

test('a disabled lane explains itself instead of failing opaquely', async (t) => {
  const api = await startApi({ config: normalizePreviewsConfig({}, { relayPort: 3333 }) });
  t.after(() => api.close());

  const created = await api.call('/api/previews', { method: 'POST', body: { port: 5173 } });
  assert.equal(created.status, 503);
  assert.match(created.body.error, /disabled/);

  // GET still answers, so the UI can render "previews are off" rather than an error.
  const listed = await api.call('/api/previews');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.enabled, false);
  assert.deepEqual(listed.body.previews, []);
});

test('a misconfigured lane hands back its interlock errors', async (t) => {
  // publicBaseUrl on the relay's own hostname: the exact mistake that would
  // silently remove the origin boundary, so the message has to be actionable.
  const api = await startApi({
    config: previewConfig({ publicBaseUrl: 'https://relay.example.com' }),
  });
  t.after(() => api.close());

  const created = await api.call('/api/previews', { method: 'POST', body: { port: 5173 } });
  assert.equal(created.status, 503);
  assert.match(created.body.error, /failed its startup checks/);
  assert.match(created.body.details.join(' '), /different hostname than the relay/);
});

test('POST for a target this conversation already publishes returns that preview', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const workspace = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'route-static-'));
  t.after(() => { try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(pathMod.join(workspace, 'dist'));

  const api = await startApi({ workspaceRoot: workspace });
  t.after(() => api.close());

  const first = await api.call('/api/previews', { method: 'POST', body: { conversationId: 'conv-1', dir: './dist' } });
  // Same folder spelled differently: it is the realpath that counts.
  const again = await api.call('/api/previews', { method: 'POST', body: { conversationId: 'conv-1', dir: `${workspace}/dist/` } });
  assert.equal(first.body.existing, false);
  assert.equal(again.status, 200);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.url, first.body.url);
  assert.equal(api.registry.size, 1);

  const port = await api.call('/api/previews', { method: 'POST', body: { conversationId: 'conv-1', port: 5173 } });
  const portAgain = await api.call('/api/previews', { method: 'POST', body: { conversationId: 'conv-1', port: '5173', host: 'localhost' } });
  assert.equal(portAgain.body.existing, true);
  assert.equal(portAgain.body.preview.token, port.body.preview.token);
});

// ─── conversation scope ───────────────────────────────────────────────────────
// A request that names a conversation (the `conversationId` query, else the
// worker identity header every agent-side caller sends) only reaches that
// conversation's previews. The owner's view (neither) still covers the relay.

async function seedTwoConversations(api) {
  const own = await api.call('/api/previews', { method: 'POST', body: { conversationId: 'conv-1', port: 5001 } });
  const other = await api.call('/api/previews', { method: 'POST', body: { conversationId: 'conv-2', port: 5002 } });
  return { own: own.body.preview.token, other: other.body.preview.token };
}

test('GET from a conversation-bound caller lists only its own conversation', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  await seedTwoConversations(api);

  const scoped = await api.call('/api/previews', { headers: { 'x-relay-conversation-id': 'conv-1' } });
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body.previews.map((entry) => entry.targetPort), [5001]);
  // The lane facts a worker reads for its instruction block stay.
  assert.equal(scoped.body.enabled, true);
  assert.equal(scoped.body.publicBaseUrl, 'https://preview.example.com');

  const owner = await api.call('/api/previews');
  assert.deepEqual(owner.body.previews.map((entry) => entry.targetPort), [5001, 5002]);
});

test('DELETE in a conversation scope refuses another conversation\'s preview', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const { other } = await seedTwoConversations(api);

  const byQuery = await api.call(`/api/previews/${other}?conversationId=conv-1`, { method: 'DELETE' });
  assert.equal(byQuery.status, 403);
  assert.match(byQuery.body.error, /belongs to another conversation/);

  const byHeader = await api.call(`/api/previews/${other}`, { method: 'DELETE', headers: { 'x-relay-conversation-id': 'conv-1' } });
  assert.equal(byHeader.status, 403);
  assert.deepEqual(api.registry.list().map((entry) => entry.targetPort), [5001, 5002]);

  // Unknown stays 404, not a refusal.
  const unknown = await api.call(`/api/previews/${'c'.repeat(32)}?conversationId=conv-1`, { method: 'DELETE' });
  assert.equal(unknown.status, 404);
});

test('DELETE in a conversation scope closes its own preview; the owner closes any', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const { own, other } = await seedTwoConversations(api);

  const closedOwn = await api.call(`/api/previews/${own}?conversationId=conv-1`, {
    method: 'DELETE',
    headers: { 'x-relay-conversation-id': 'conv-1' },
  });
  assert.equal(closedOwn.status, 200);
  assert.equal(closedOwn.body.preview.token, own);

  const closedByOwner = await api.call(`/api/previews/${other}`, { method: 'DELETE' });
  assert.equal(closedByOwner.status, 200);
  assert.equal(api.registry.size, 0);
});

test('the conversationId query names the scope over the identity header', async (t) => {
  // The header is the worker's own session; a worker handed a row of another
  // conversation names that conversation in the query.
  const api = await startApi();
  t.after(() => api.close());
  const { other } = await seedTwoConversations(api);

  const listed = await api.call('/api/previews?conversationId=conv-2', { headers: { 'x-relay-conversation-id': 'session-1' } });
  assert.deepEqual(listed.body.previews.map((entry) => entry.targetPort), [5002]);

  const closed = await api.call(`/api/previews/${other}?conversationId=conv-2`, {
    method: 'DELETE',
    headers: { 'x-relay-conversation-id': 'session-1' },
  });
  assert.equal(closed.status, 200);
});

test('DELETE in a conversation scope refuses a stored, not yet verified preview of another conversation', async (t) => {
  // A stored folder preview whose check could not answer at the restart:
  // listed as unverified, not served, and still another conversation's.
  const store = createMemoryPreviewStore();
  const registryOptions = {
    config: previewConfig(),
    store,
    hostBootId: 'linux:boot-1',
    checkConversation: () => true,
    logger: { log() {}, warn() {}, error() {} },
  };
  const first = createPreviewRegistry({ ...registryOptions, checkStaticRoot: (rootDir) => ({ ok: true, rootDir }) });
  const { token } = first.createStatic({ conversationId: 'conv-2', rootDir: '/srv/site', label: 'site' }).preview;
  const registry = createPreviewRegistry({
    ...registryOptions,
    checkStaticRoot: () => ({ ok: false, error: 'Directory not readable (EIO)', transient: true }),
  });
  assert.equal(registry.keptCount, 1);

  const api = await startApi({ registry });
  t.after(() => api.close());

  const refused = await api.call(`/api/previews/${token}?conversationId=conv-1`, { method: 'DELETE' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /belongs to another conversation/);
  assert.equal(registry.keptCount, 1);

  const own = await api.call(`/api/previews/${token}?conversationId=conv-2`, { method: 'DELETE' });
  assert.equal(own.status, 200);
  assert.equal(registry.keptCount, 0);
});

test('a scope named by the session id reaches the conversation it belongs to', async (t) => {
  // After a placeholder rekey the conversation is conv-1 but its session id
  // is sess-1: a tool server bound to the session, or a worker's between-turn
  // fallback, names sess-1 and must still reach conv-1's previews.
  const conversations = [{ id: 'conv-1', sdk_session_id: 'sess-1' }, { id: 'conv-2', sdk_session_id: 'sess-2' }];
  const api = await startApi({
    resolveConversationScope: createPreviewScopeResolver({
      getConversation: (id) => conversations.find((conv) => conv.id === id) || null,
      getConversationBySdkSessionId: (id) => conversations.find((conv) => conv.sdk_session_id === id) || null,
    }),
  });
  t.after(() => api.close());
  const { own, other } = await seedTwoConversations(api);
  // A preview stored under the session id is the same conversation's.
  const bySession = await api.call('/api/previews', { method: 'POST', body: { conversationId: 'sess-1', port: 5003 } });

  for (const scope of ['sess-1', 'conv-1']) {
    const listed = await api.call(`/api/previews?conversationId=${scope}`);
    assert.deepEqual(listed.body.previews.map((entry) => entry.targetPort), [5001, 5003], scope);
  }
  const header = await api.call('/api/previews', { headers: { 'x-relay-conversation-id': 'sess-1' } });
  assert.deepEqual(header.body.previews.map((entry) => entry.targetPort), [5001, 5003]);

  const refused = await api.call(`/api/previews/${other}?conversationId=sess-1`, { method: 'DELETE' });
  assert.equal(refused.status, 403);
  const closed = await api.call(`/api/previews/${own}?conversationId=sess-1`, { method: 'DELETE' });
  assert.equal(closed.status, 200);
  const closedBySession = await api.call(`/api/previews/${bySession.body.preview.token}?conversationId=conv-1`, { method: 'DELETE' });
  assert.equal(closedBySession.status, 200);
});

test('the scope resolver keeps the named id and survives a failing lookup', () => {
  const resolve = createPreviewScopeResolver({
    getConversation: () => { throw new Error('database is locked'); },
  });
  assert.deepEqual(resolve('conv-9'), ['conv-9']);
  assert.deepEqual(resolve(''), []);
  assert.deepEqual(createPreviewScopeResolver()('conv-9'), ['conv-9']);
});
