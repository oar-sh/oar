import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createTokenUsageService } from '../services/token-usage-service.mjs';
import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';

const ROUTE = '/api/turn-token-usage';

function setup({ conversations = {}, workers = {} } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const tokenUsageService = createTokenUsageService({ db, now: () => Date.parse('2026-11-02T10:00:00.000Z'), timeZone: 'UTC', logger: { warn() {} } });
  const chats = {
    'conv-cursor': 'cursor',
    'conv-grok': 'grok',
    'conv-copilot': 'github',
    'conv-byok': 'openai',
    'conv-claude': 'claude',
    'conv-cloud': 'claude-cloud',
    'conv-ds': 'deepseek',
    'conv-image': 'openai-image',
    ...conversations,
  };
  const deleted = new Set();
  // Chats whose runtime binding is gone for a moment (a cache rebuild).
  const unbound = new Set();
  const deps = makeRouteDeps({
    tokenUsageService,
    ts: () => 'T',
    stmts: {
      getConv: { get: (id) => (chats[id] && !deleted.has(id) ? { id, status: 'active' } : null) },
      getRuntimeSessionByConversation: { get: (id) => (chats[id] && !unbound.has(id) ? { id: `rs-${id}`, provider_type: chats[id] } : null) },
    },
    relayBridgeOwnerService: { normalizeIdentity: ({ sessionId }) => (sessionId ? { sessionId } : null) },
    sessionWorkerRegistry: { getWorker: (sid) => (workers[sid] ? { kind: workers[sid] } : null) },
  });
  const routes = captureRoutes(deps);
  const post = (body, headers = {}) => invokeRoute(routes, 'POST', ROUTE, { body, headers });
  const days = () => db.prepare(`SELECT * FROM token_usage_days ORDER BY provider, billing, model`).all().map((row) => ({ ...row }));
  const turns = () => db.prepare(`SELECT * FROM turn_token_usage ORDER BY turn_id, run_id, model`).all().map((row) => ({ ...row }));
  return { db, post, days, turns, deleted, unbound, tokenUsageService };
}

const models = [{ model: 'composer-2', inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 }];

test('books a turn once, however often it is posted', async () => {
  const { post, days } = setup();
  const body = { conversationId: 'conv-cursor', turnId: 'q-1', runId: 'r-1', models };
  const first = await post(body);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { ok: true, provider: 'cursor', billing: '', models: ['composer-2'] });
  await post(body);
  const [row] = days();
  assert.equal(row.input_tokens, 100);
  assert.equal(row.cache_write_tokens, null);
  assert.equal(row.turn_count, 1);
});

test('refuses a malformed report', async () => {
  const { post } = setup();
  assert.equal((await post({ turnId: 'q-1', models })).status, 400);
  assert.equal((await post({ conversationId: 'conv-cursor', models })).body.error, 'Missing turnId');
  assert.equal((await post({ conversationId: 'conv-cursor', turnId: 'q', models: [] })).body.error, 'Missing models');
  assert.equal((await post({ conversationId: 'conv-cursor', turnId: 'q', provider: 'openai', models })).body.error, 'Unknown provider');
});

test('a deleted or unknown chat takes no report', async () => {
  const { post, deleted, turns } = setup();
  assert.equal((await post({ conversationId: 'conv-nope', turnId: 'q-1', models })).status, 404);
  deleted.add('conv-cursor');
  const late = await post({ conversationId: 'conv-cursor', turnId: 'q-1', models });
  assert.equal(late.status, 404);
  assert.equal(turns().length, 0);
});

test('a chat without its runtime binding still books, as the stated provider', async () => {
  const { post, unbound, days } = setup();
  unbound.add('conv-cursor');
  const stated = await post({ conversationId: 'conv-cursor', turnId: 'q-1', provider: 'cursor', models });
  assert.equal(stated.status, 200);
  assert.equal(days()[0].provider, 'cursor');
  const unstated = await post({ conversationId: 'conv-cursor', turnId: 'q-2', models });
  assert.equal(unstated.status, 409);
});

test('a chat without token usage is refused', async () => {
  const { post } = setup();
  assert.equal((await post({ conversationId: 'conv-image', turnId: 'q-1', models })).status, 409);
});

test('the provider is the chat\'s, whatever the body says', async () => {
  const { post, days } = setup();
  const { body } = await post({ conversationId: 'conv-grok', turnId: 'q-1', provider: 'cursor', models: [{ model: 'grok-5', inputTokens: 1 }] });
  assert.equal(body.provider, 'grok');
  assert.equal(days()[0].provider, 'grok');
});

test('a Claude chat books as the posting worker\'s registered kind', async () => {
  const { post, days } = setup({ workers: { 'sid-api': 'claude-api' } });
  const api = await post(
    { conversationId: 'conv-claude', turnId: 'q-1', runId: 'r', provider: 'claude', models: [{ model: 'claude-opus-5-5', inputTokens: 5 }] },
    { 'x-relay-session-id': 'sid-api' },
  );
  assert.equal(api.body.provider, 'claude-api');
  // Without a registered worker the chat's billing wins over the report's.
  const stated = await post({ conversationId: 'conv-claude', turnId: 'q-2', runId: 'r', provider: 'claude-api', models: [{ model: 'claude-opus-5-5', inputTokens: 1 }] });
  assert.equal(stated.body.provider, 'claude');
  assert.deepEqual(days().map((row) => [row.provider, row.input_tokens]), [['claude', 1], ['claude-api', 5]]);
});

test('a binding exists and the report claims another provider: booked under the binding\'s', async () => {
  const { post, days, turns } = setup();
  for (const [conversationId, claimed, model] of [
    ['conv-cursor', 'grok', 'composer-2'],
    ['conv-ds', 'claude-api', 'deepseek-flash'],
    ['conv-copilot', 'claude-cloud', 'gpt-5.5'],
  ]) {
    const { status, body } = await post({ conversationId, turnId: `q-${conversationId}`, provider: claimed, models: [{ model, inputTokens: 1 }] });
    assert.equal(status, 200);
    assert.notEqual(body.provider, claimed);
  }
  assert.deepEqual(days().map((row) => row.provider), ['cursor', 'deepseek', 'github']);
  assert.deepEqual(turns().map((row) => row.provider).sort(), ['cursor', 'deepseek', 'github']);
});

test('Copilot: own-key reports are their own group; an OpenAI chat always is', async () => {
  const { post, days } = setup();
  await post({ conversationId: 'conv-copilot', turnId: 'q-1', models: [{ model: 'gpt-5.5', inputTokens: 3 }] });
  await post({ conversationId: 'conv-copilot', turnId: 'q-2', billing: 'byok-anthropic', models: [{ model: 'claude-sonnet-5-5', inputTokens: 4 }] });
  const byok = await post({ conversationId: 'conv-byok', turnId: 'q-3', models: [{ model: 'gpt-5.5', inputTokens: 9 }] });
  assert.deepEqual(byok.body, { ok: true, provider: 'github', billing: 'byok-openai', models: ['gpt-5.5'] });
  assert.deepEqual(days().map((row) => [row.provider, row.billing, row.model]), [
    ['github', '', 'gpt-5.5'],
    ['github', 'byok-anthropic', 'claude-sonnet-5-5'],
    ['github', 'byok-openai', 'gpt-5.5'],
  ]);
  assert.equal((await post({ conversationId: 'conv-copilot', turnId: 'q-4', billing: 'free', models })).status, 400);
});

test('Claude cloud posts session totals; others may not', async () => {
  const { post, turns } = setup();
  const totals = (turnId, inputTokens) => ({ conversationId: 'conv-cloud', turnId, nativeSessionId: 'cse-1', sessionTotals: [{ model: 'claude-opus-5-5', inputTokens }] });
  await post(totals('q-1', 100));
  await post(totals('q-2', 130));
  await post(totals('q-2', 130));
  assert.deepEqual(turns().map((row) => [row.turn_id, row.input_tokens]), [['q-1', 100], ['q-2', 30]]);
  const wrong = await post({ conversationId: 'conv-cursor', turnId: 'q-1', nativeSessionId: 'x', sessionTotals: models });
  assert.equal(wrong.status, 400);
});

test('without the service the route says so', async () => {
  const routes = captureRoutes(makeRouteDeps({ tokenUsageService: null }));
  const { status } = await invokeRoute(routes, 'POST', ROUTE, { body: { conversationId: 'c', turnId: 't', models } });
  assert.equal(status, 501);
});
