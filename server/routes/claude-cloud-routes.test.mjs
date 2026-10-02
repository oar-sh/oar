'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { registerClaudeCloudRoutes } from './claude-cloud-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createClaudeCloudSettingsService } from '../services/claude-cloud-settings-service.mjs';
import { buildCloudSourceRecord, createClaudeCloudSessionService } from '../services/claude-cloud-session-service.mjs';
import { createClaudeCloudRepoService, listRecentCloudSourcesFromStatements } from '../services/claude-cloud-repo-service.mjs';

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

async function callRoute(app, key, body = {}, query = {}) {
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
    await handler({ body, query, headers: {}, params: {} }, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return res;
}

function createHarness({
  hasToken = true,
  providerType = 'claude-cloud',
  cloudEnabled = false,
  listRepositories = async () => ({ repos: [], complete: true, raw: [{}] }),
  execFileImpl = () => { throw new Error('git must not run in this test'); },
  gitBranchLookup = true,
} = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  if (cloudEnabled) stmts.upsertAppSetting.run('claude_cloud_enabled', 'true', NOW);
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
    claudeCloudRepoService: createClaudeCloudRepoService({
      cloud: { listRepositories },
      isEnabled: () => String(stmts.getAppSetting.get('claude_cloud_enabled')?.value || '') === 'true',
      listRecentCloudSources: () => listRecentCloudSourcesFromStatements(stmts),
      gitBranchLookup,
      execFileImpl,
      now: () => Date.parse('2026-10-02T11:00:00.000Z'),
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

const REPOS_KEYS = ['complete', 'error', 'fetchedAt', 'ok', 'repos', 'source'];
const REPO_KEYS = ['accessible', 'archived', 'defaultBranch', 'description', 'name', 'owner', 'private', 'pushedAt', 'recentAt', 'repoUrl', 'slug'];

test('GET /api/claude-cloud/repos answers the united list; ?refresh=1 reads Anthropic again', async () => {
  let reads = 0;
  const { app, authCalls } = createHarness({
    cloudEnabled: true,
    listRepositories: async () => {
      reads += 1;
      return {
        repos: [
          { owner: 'example-org', name: 'docs-site', slug: 'example-org/docs-site', repoUrl: 'https://github.com/example-org/docs-site', defaultBranch: 'trunk', private: false, archived: false, pushedAt: '2031-01-15T09:30:00Z', description: 'Documentation' },
          { owner: 'example-org', name: 'sample-repo', slug: 'example-org/sample-repo', repoUrl: REPO_URL, defaultBranch: 'main', private: true, archived: false, pushedAt: '2031-02-01T10:00:00Z', description: 'Sample service' },
        ],
        complete: true,
        raw: [{}],
      };
    },
  });
  const res = await callRoute(app, 'GET /api/claude-cloud/repos');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), REPOS_KEYS);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.source, 'anthropic');
  assert.equal(res.body.error, null);
  assert.equal(res.body.complete, true);
  assert.equal(res.body.fetchedAt, '2026-10-02T11:00:00.000Z');
  for (const repo of res.body.repos) assert.deepEqual(Object.keys(repo).sort(), REPO_KEYS);
  // conv-1 (the harness's cloud conversation) clones sample-repo: it leads.
  assert.deepEqual(res.body.repos.map((repo) => [repo.slug, repo.recentAt, repo.accessible]), [
    ['example-org/sample-repo', NOW, true],
    ['example-org/docs-site', null, true],
  ]);
  assert.equal(authCalls.length, 1, 'behind the relay auth');

  await callRoute(app, 'GET /api/claude-cloud/repos');
  assert.equal(reads, 1, 'cached');
  await callRoute(app, 'GET /api/claude-cloud/repos', {}, { refresh: '1' });
  assert.equal(reads, 2, 'refreshed');
  await callRoute(app, 'GET /api/claude-cloud/repos', {}, { refresh: 'true' });
  assert.equal(reads, 3);
  await callRoute(app, 'GET /api/claude-cloud/repos', {}, { refresh: '0' });
  assert.equal(reads, 3);
});

test('GET /api/claude-cloud/repos is 200 with ok:false while the provider is off, and when the read fails', async () => {
  const off = createHarness({ listRepositories: async () => { throw new Error('must not be asked'); } });
  const res = await callRoute(off.app, 'GET /api/claude-cloud/repos');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error.code, 'claude_cloud_disabled');
  assert.deepEqual(res.body.repos, []);

  const failing = createHarness({
    cloudEnabled: true,
    listRepositories: async () => { throw Object.assign(new Error(`refused ${TOKEN}`), { code: 'transient' }); },
  });
  const failed = await callRoute(failing.app, 'GET /api/claude-cloud/repos');
  assert.equal(failed.statusCode, 200);
  assert.deepEqual(Object.keys(failed.body).sort(), REPOS_KEYS);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.source, 'recent');
  assert.equal(failed.body.error.code, 'error', 'not a cloud error: its text is not passed on');
  assert.equal(JSON.stringify(failed.body).includes(TOKEN), false);
  assert.deepEqual(failed.body.repos.map((repo) => [repo.slug, repo.accessible]), [['example-org/sample-repo', null]]);
});

test('GET /api/claude-cloud/repos is 500 only when the service itself throws', async () => {
  const app = createMockApp();
  registerClaudeCloudRoutes(app, {
    auth: (_req, _res, next) => next(),
    claudeCloudRepoService: { listRepositories: async () => { throw new Error('boom'); }, listBranches: async () => { throw new Error('boom'); } },
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const repos = await callRoute(app, 'GET /api/claude-cloud/repos');
    assert.equal(repos.statusCode, 500);
    assert.deepEqual(repos.body, { error: 'Failed to list Claude Cloud repositories' });
    const branches = await callRoute(app, 'GET /api/claude-cloud/branches', {}, { repo: REPO_URL });
    assert.equal(branches.statusCode, 500);
    assert.deepEqual(branches.body, { error: 'Failed to list the repository branches' });
  } finally {
    console.warn = originalWarn;
  }
});

test('GET /api/claude-cloud/branches answers the branches of the named repository, default first', async () => {
  const gitCalls = [];
  const { app } = createHarness({
    execFileImpl: (file, args, options, callback) => {
      gitCalls.push({ file, args, shell: options.shell, prompt: options.env.GIT_TERMINAL_PROMPT });
      setImmediate(() => callback(null, [
        'ref: refs/heads/main\tHEAD',
        '1111111111111111111111111111111111111111\tHEAD',
        '2222222222222222222222222222222222222222\trefs/heads/dev/fix-slugify',
        '3333333333333333333333333333333333333333\trefs/heads/main',
        '',
      ].join('\n'), ''));
    },
  });
  const res = await callRoute(app, 'GET /api/claude-cloud/branches', {}, { repo: 'example-org/sample-repo' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    slug: 'example-org/sample-repo',
    repoUrl: REPO_URL,
    branches: ['main', 'dev/fix-slugify'],
    defaultBranch: 'main',
  });
  assert.deepEqual(gitCalls, [{ file: 'git', args: ['ls-remote', '--symref', REPO_URL, 'HEAD', 'refs/heads/*'], shell: undefined, prompt: '0' }]);

  const byUrl = await callRoute(app, 'GET /api/claude-cloud/branches', {}, { repo: `${REPO_URL}.git` });
  assert.equal(byUrl.body.slug, 'example-org/sample-repo');
});

test('GET /api/claude-cloud/branches is 400 without a usable repository, 200 for every other refusal', async () => {
  const { app } = createHarness({
    execFileImpl: (_file, _args, _options, callback) => {
      setImmediate(() => callback(Object.assign(new Error('Command failed'), { code: 128 }), '', 'fatal: could not read Username: terminal prompts disabled\n'));
    },
  });
  for (const query of [{}, { repo: '' }, { repo: 'not a repository' }, { repo: ['https://gitlab.example.com/group/project'] }, { repo: 7 }]) {
    const res = await callRoute(app, 'GET /api/claude-cloud/branches', {}, query);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
    assert.equal(res.body.ok, false);
    assert.equal(res.body.slug, null);
    assert.equal(res.body.error.code, 'invalid_repo');
    assert.equal(typeof res.body.error.message, 'string');
  }
  const unreachable = await callRoute(app, 'GET /api/claude-cloud/branches', {}, { repo: 'example-org/private-thing' });
  assert.equal(unreachable.statusCode, 200);
  assert.deepEqual(unreachable.body, {
    ok: false,
    slug: 'example-org/private-thing',
    error: { code: 'unreachable', message: 'could not read Username: terminal prompts disabled' },
  });

  const off = createHarness({ gitBranchLookup: false });
  const disabled = await callRoute(off.app, 'GET /api/claude-cloud/branches', {}, { repo: REPO_URL });
  assert.equal(disabled.statusCode, 200);
  assert.deepEqual(disabled.body, { ok: false, slug: 'example-org/sample-repo', error: { code: 'disabled', message: 'Branch lookup is switched off on this relay.' } });
});

test('the routes are only there when their service is', () => {
  const app = createMockApp();
  registerClaudeCloudRoutes(app, { auth: (_req, _res, next) => next() });
  assert.deepEqual([...app.routes.keys()], []);
});
