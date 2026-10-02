'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { registerClaudeCloudRoutes } from './claude-cloud-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createClaudeCloudSettingsService } from '../services/claude-cloud-settings-service.mjs';
import { buildCloudSourceRecord, createClaudeCloudSessionService } from '../services/claude-cloud-session-service.mjs';

const ENVIRONMENT_ID = 'env_01EXAMPLEaaaaaaaaaaaaaaaa';
const SESSION_ID = 'cse_01EXAMPLEaaaaaaaaaaaaaaaa';
const REPO_URL = 'https://github.com/example-org/sample-repo';
const SESSION_URL = 'https://claude.example.com/code/session-example';
const TOKEN = 'test-token-value';
const NOW = '2026-10-02T10:00:00.000Z';

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(routePath, ...handlers) { routes.set(`GET ${routePath}`, handlers); },
    post(routePath, ...handlers) { routes.set(`POST ${routePath}`, handlers); },
  };
}

async function callRoute(app, key, body = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `${key} should be registered`);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler({ body, query: {}, headers: {}, params: {} }, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

function createHarness({ hasToken = true, providerType = 'claude-cloud' } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  stmts.insertConv.run('conv-1', 'Fix the slug helper', NOW, NOW);
  stmts.insertRuntimeSession.run('rs-1', 'conv-1', 'isolated', 'rs-1', 'claude-sonnet-5-5', NOW, NOW, 'conv-1', providerType, 'claude-sonnet-5-5');
  stmts.updateConvCloudSource.run(
    JSON.stringify(buildCloudSourceRecord({ repoUrl: REPO_URL, branch: 'main', environmentId: ENVIRONMENT_ID })),
    'conv-1',
  );
  const events = [];
  const emit = (event, payload) => events.push({ event, payload });
  const touched = [];
  const authCalls = [];
  const app = createMockApp();
  registerClaudeCloudRoutes(app, {
    auth: (req, _res, next) => { authCalls.push(req); next(); },
    touchCli: () => touched.push(true),
    claudeCloudSettingsService: createClaudeCloudSettingsService({
      readSetting: (key) => String(stmts.getAppSetting.get(key)?.value || ''),
      writeSetting: (key, value) => stmts.upsertAppSetting.run(key, String(value), NOW),
      deleteSetting: (key) => stmts.deleteAppSetting.run(key),
      getClaudeProviderSettings: () => ({ model: 'claude-sonnet-5', models: ['claude-sonnet-5', 'claude-opus-5[1m]'] }),
      claudeAuthService: {
        getStatus: async () => ({ ok: true, loggedIn: true, email: 'dev@example.com', orgName: 'Example Org', subscriptionType: 'max' }),
      },
      credentials: {
        describe: () => (hasToken
          ? { source: 'file', hasToken: true, expiresAt: '2026-10-02T18:00:00.000Z', subscriptionType: 'max', accessToken: TOKEN }
          : { source: 'none', hasToken: false, expiresAt: null, subscriptionType: null }),
        redact: (text) => String(text).split(TOKEN).join('[redacted]'),
      },
      cloud: { listEnvironments: async () => [{ id: ENVIRONMENT_ID, name: 'Default', state: 'active' }] },
      emit,
      logger: { log() {}, warn() {} },
    }),
    claudeCloudSessionService: createClaudeCloudSessionService({
      stmts,
      emit,
      now: () => new Date('2026-10-02T11:00:00.000Z'),
      logger: { log() {}, warn() {} },
    }),
  });
  return { app, stmts, events, touched, authCalls };
}

const SETTINGS_KEYS = ['account', 'defaultModel', 'enabled', 'environmentId', 'environments', 'environmentsError', 'models', 'token'];

test('GET /api/settings/claude-cloud answers in the documented shape, off by default', async () => {
  const { app, authCalls } = createHarness();
  const res = await callRoute(app, 'GET /api/settings/claude-cloud');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), SETTINGS_KEYS);
  assert.deepEqual(res.body, {
    enabled: false,
    defaultModel: 'claude-sonnet-5-5',
    environmentId: null,
    environments: null,
    environmentsError: null,
    account: { loggedIn: true, email: 'dev@example.com', orgName: 'Example Org', subscriptionType: 'max' },
    token: { source: 'file', hasToken: true, expiresAt: '2026-10-02T18:00:00.000Z' },
    models: ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5'],
  });
  assert.equal(JSON.stringify(res.body).includes(TOKEN), false);
  assert.equal(authCalls.length, 1, 'behind the relay auth');
});

test('POST /api/settings/claude-cloud switches it on, answers the same shape and tells the clients', async () => {
  const { app, events } = createHarness();
  const res = await callRoute(app, 'POST /api/settings/claude-cloud', { enabled: true, defaultModel: 'claude-opus-5' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [...SETTINGS_KEYS, 'ok'].sort());
  assert.equal(res.body.ok, true);
  assert.equal(res.body.enabled, true);
  assert.equal(res.body.defaultModel, 'claude-opus-5');
  assert.equal(res.body.environmentId, ENVIRONMENT_ID);
  assert.deepEqual(res.body.environments, [{ id: ENVIRONMENT_ID, name: 'Default' }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'claude_cloud_settings_updated');
  assert.deepEqual(Object.keys(events[0].payload).sort(), SETTINGS_KEYS);
  assert.equal(JSON.stringify([res.body, events]).includes(TOKEN), false);

  const again = await callRoute(app, 'GET /api/settings/claude-cloud');
  assert.equal(again.body.enabled, true);
  assert.equal(again.body.environmentId, ENVIRONMENT_ID);
});

test('POST /api/settings/claude-cloud refuses enabling without a login, and bad bodies', async () => {
  const { app, events } = createHarness({ hasToken: false });
  const res = await callRoute(app, 'POST /api/settings/claude-cloud', { enabled: true });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'claude_cloud_login_missing');
  assert.equal(typeof res.body.error, 'string');
  assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error']);
  assert.deepEqual(events, []);

  const empty = await callRoute(app, 'POST /api/settings/claude-cloud', {});
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(Object.keys(empty.body), ['error']);
  const bad = await callRoute(app, 'POST /api/settings/claude-cloud', { environmentId: 'not an id' });
  assert.equal(bad.statusCode, 400);
});

test('POST /api/claude-cloud-session stores the report and emits claude_cloud_session', async () => {
  const { app, stmts, events, touched } = createHarness();
  const res = await callRoute(app, 'POST /api/claude-cloud-session', {
    conversationId: 'conv-1',
    cloudSessionId: SESSION_ID,
    sessionUrl: SESSION_URL,
    lastSequence: '21',
    pushedBranch: 'dev/fix-slugify',
    costUsd: 0.18,
    model: 'claude-sonnet-5-5',
  });
  assert.equal(res.statusCode, 200);
  const cloud = {
    repoUrl: REPO_URL,
    slug: 'example-org/sample-repo',
    branch: 'main',
    sessionUrl: SESSION_URL,
    pushedBranches: [{ branch: 'dev/fix-slugify', at: '2026-10-02T11:00:00.000Z' }],
    costUsd: 0.18,
  };
  assert.deepEqual(res.body, { ok: true, cloud });
  assert.deepEqual(events, [{ event: 'claude_cloud_session', payload: { conversationId: 'conv-1', cloud } }]);
  assert.equal(touched.length, 1, 'a worker report counts as a sign of life, like the native-session routes');

  const runtime = stmts.getRuntimeSessionByConversation.get('conv-1');
  assert.equal(runtime.claude_cloud_session_id, SESSION_ID);
  assert.equal(runtime.claude_cloud_last_sequence, '21');
  assert.equal(runtime.claude_cloud_cost_usd, 0.18);
});

test('POST /api/claude-cloud-session refuses what is not a cloud conversation', async () => {
  const missing = createHarness();
  assert.equal((await callRoute(missing.app, 'POST /api/claude-cloud-session', { conversationId: 'conv-1' })).statusCode, 400);
  assert.equal((await callRoute(missing.app, 'POST /api/claude-cloud-session', { conversationId: 'conv-none', cloudSessionId: SESSION_ID })).statusCode, 404);

  const claude = createHarness({ providerType: 'claude' });
  const res = await callRoute(claude.app, 'POST /api/claude-cloud-session', { conversationId: 'conv-1', cloudSessionId: SESSION_ID });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: 'Conversation is not bound to the Claude Cloud provider' });
  assert.equal(claude.stmts.getRuntimeSessionByConversation.get('conv-1').claude_cloud_session_id, null);
  assert.deepEqual(claude.events, []);
});

test('the routes are only there when their service is', () => {
  const app = createMockApp();
  registerClaudeCloudRoutes(app, { auth: (_req, _res, next) => next() });
  assert.deepEqual([...app.routes.keys()], []);
});
