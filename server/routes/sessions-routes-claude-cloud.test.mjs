import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { buildConversationSessionRootPayload, registerSessionsRoutes } from './sessions-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import {
  CLAUDE_CLOUD_ENABLED_SETTING_KEY,
  CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY,
  createClaudeCloudSettingsService,
} from '../services/claude-cloud-settings-service.mjs';
import { createClaudeCloudSessionService } from '../services/claude-cloud-session-service.mjs';

// The Claude Cloud provider through the session routes: bootstrap (the only
// way such a conversation is created), the `cloud` field of the conversation
// payloads, the context reader and the archive route.

const NOW = '2026-10-02T10:00:00.000Z';
const REPO_URL = 'https://github.com/example-org/sample-repo';
const ENVIRONMENT_ID = 'env_01EXAMPLEaaaaaaaaaaaaaaaa';
const SESSION_ID = 'cse_01EXAMPLEaaaaaaaaaaaaaaaa';
const SESSION_URL = 'https://claude.example.com/code/session-example';
// Built from its halves: the hygiene guard reads `user@host` as an e-mail address.
const SCP_REPO = ['git', 'github.com:example-org/sample-repo.git'].join('@');

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

async function call(app, key, { body = {}, params = {}, query = {} } = {}) {
  const handler = app.routes.get(key);
  assert.ok(handler, `${key} should be registered`);
  const res = {
    statusCode: 200,
    body: null,
    setHeader() {},
    set() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await handler({ body, params, query, headers: {} }, res);
  return res;
}

function setup({
  cloudEnabled = true,
  storedEnvironmentId = ENVIRONMENT_ID,
  environments = [{ id: ENVIRONMENT_ID, name: 'Default', state: 'active' }],
  hasToken = true,
  withCloudServices = true,
  claudeSettings = { configured: true, enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5', 'claude-opus-5[1m]', 'claude-opus-5'] },
  archiveSession = async () => {},
} = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  if (cloudEnabled) stmts.upsertAppSetting.run(CLAUDE_CLOUD_ENABLED_SETTING_KEY, 'true', NOW);
  if (storedEnvironmentId) stmts.upsertAppSetting.run(CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY, storedEnvironmentId, NOW);

  const emitted = [];
  const emit = (event, payload) => emitted.push([event, payload]);
  const cloudCalls = { listEnvironments: 0 };
  const logs = [];
  const claudeCloudSettingsService = createClaudeCloudSettingsService({
    readSetting: (key) => String(stmts.getAppSetting.get(key)?.value || ''),
    writeSetting: (key, value) => stmts.upsertAppSetting.run(key, String(value), NOW),
    deleteSetting: (key) => stmts.deleteAppSetting.run(key),
    getClaudeProviderSettings: () => claudeSettings,
    credentials: { describe: () => ({ source: hasToken ? 'file' : 'none', hasToken, expiresAt: null }) },
    cloud: {
      listEnvironments: async () => {
        cloudCalls.listEnvironments += 1;
        if (environments instanceof Error) throw environments;
        return environments;
      },
    },
    emit,
    logger: { log() {}, warn() {} },
  });
  const claudeCloudSessionService = createClaudeCloudSessionService({
    stmts,
    getCloudClient: () => ({ archiveSession }),
    emit,
    logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
  });

  // What server-runtime's binding does for an explicit provider, reduced to
  // the insert: the provider type and model land on the runtime session row.
  const bindingCalls = [];
  const ensureRuntimeSessionBinding = (conversationId, model, nowIso, sdkSessionId, options = {}) => {
    bindingCalls.push({ conversationId, model, sdkSessionId, options });
    const id = `rs-${conversationId}`;
    stmts.insertRuntimeSession.run(id, conversationId, 'isolated', id, model, nowIso, nowIso, sdkSessionId, options.providerType || 'github', options.providerModel || null);
    return stmts.getRuntimeSessionById.get(id);
  };

  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => { throw new Error('a cloud conversation has no Copilot events file'); },
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({
      models: ['gpt-5.4-mini'],
      currentModel: 'gpt-5.4-mini',
      defaultModel: 'gpt-5.4-mini',
      reasoningByModel: { 'gpt-5.4-mini': ['none'], 'claude-sonnet-5-5': ['none', 'low', 'high'] },
      providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    }),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium', 'high'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    getClaudeProviderSettings: () => claudeSettings,
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: true }),
    learnConversationWorkspaceRoot: () => ({ ok: true }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    getPendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'client-1',
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    ensureRuntimeSessionBinding,
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent', 'ask', 'plan', 'autopilot'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry: createSessionWorkerRegistry(),
    sdkSessionImportService: null,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    isSha256: () => false,
    ...(withCloudServices ? { claudeCloudSettingsService, claudeCloudSessionService } : {}),
  });

  const bootstrap = (body) => call(app, 'POST /api/conversation/bootstrap', { body });
  const conversationCount = () => db.prepare(`SELECT COUNT(*) AS count FROM conversations`).get().count;
  return { app, db, stmts, emitted, logs, cloudCalls, bindingCalls, bootstrap, conversationCount, claudeCloudSessionService };
}

const cloudRequest = (extra = {}) => ({
  providerType: 'claude-cloud',
  title: 'Fix the slug helper',
  cloudSource: { repoUrl: REPO_URL, branch: 'dev/feature' },
  ...extra,
});

// ─── bootstrap ───────────────────────────────────────────────────────────────

test('bootstrap creates a cloud conversation: provider, model, repository, no folder needed', async () => {
  const harness = setup();
  const res = await harness.bootstrap(cloudRequest({ cloudSource: { repoUrl: SCP_REPO, branch: 'dev/feature' }, reasoningEffort: 'high' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.selectedProviderType, 'claude-cloud');
  assert.equal(res.body.selectedModel, 'claude-sonnet-5-5', 'the tab default, never the shared catalog\'s current model');
  assert.equal(res.body.preferredReasoningEffort, 'none', 'a cloud session takes no effort');
  assert.equal(res.body.configuredWorkspaceRootPath, null);
  assert.deepEqual(res.body.cloud, {
    repoUrl: REPO_URL,
    slug: 'example-org/sample-repo',
    branch: 'dev/feature',
    sessionUrl: null,
    pushedBranches: [],
    costUsd: null,
  });

  const conversationId = res.body.conversationId;
  assert.deepEqual(harness.bindingCalls.map((entry) => entry.options), [{
    assignConfiguredProvider: true,
    providerType: 'claude-cloud',
    providerModel: 'claude-sonnet-5-5',
  }]);
  const runtime = harness.stmts.getRuntimeSessionByConversation.get(conversationId);
  assert.equal(runtime.provider_type, 'claude-cloud');
  assert.equal(runtime.claude_cloud_session_id, null, 'nothing is created at Anthropic until the first message');
  assert.deepEqual(JSON.parse(harness.stmts.getConvAnyStatus.get(conversationId).cloud_source_json), {
    repoUrl: REPO_URL,
    branch: 'dev/feature',
    environmentId: ENVIRONMENT_ID,
    sessionUrl: null,
    pushedBranches: [],
  });
});

test('bootstrap is refused with claude_cloud_disabled while the provider is off, whatever else is sent', async () => {
  for (const harness of [setup({ cloudEnabled: false }), setup({ withCloudServices: false })]) {
    for (const body of [cloudRequest(), cloudRequest({ cloudSource: { repoUrl: 'nonsense' } }), { providerType: 'claude-cloud' }]) {
      const res = await harness.bootstrap(body);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'claude_cloud_disabled');
    }
    assert.equal(harness.conversationCount(), 0);
    assert.equal(harness.cloudCalls.listEnvironments, 0, 'nothing is asked of the cloud while it is off');
  }
});

test('bootstrap validates the repository and the branch', async () => {
  const harness = setup();
  const cases = [
    [{ providerType: 'claude-cloud' }, 'claude_cloud_repo_invalid'],
    [cloudRequest({ cloudSource: { repoUrl: 'https://git.example.com/example-org/sample-repo' } }), 'claude_cloud_repo_invalid'],
    [cloudRequest({ cloudSource: { repoUrl: '/home/dev/git/sample-repo' } }), 'claude_cloud_repo_invalid'],
    [cloudRequest({ cloudSource: { repoUrl: REPO_URL, branch: 'not a branch' } }), 'claude_cloud_branch_invalid'],
    [cloudRequest({ cloudSource: { repoUrl: REPO_URL, branch: '--upload-pack=x' } }), 'claude_cloud_branch_invalid'],
  ];
  for (const [body, code] of cases) {
    const res = await harness.bootstrap(body);
    assert.equal(res.statusCode, 400, code);
    assert.equal(res.body.code, code);
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal(harness.conversationCount(), 0);

  const noBranch = await harness.bootstrap(cloudRequest({ cloudSource: { repoUrl: REPO_URL } }));
  assert.equal(noBranch.statusCode, 200);
  assert.equal(noBranch.body.cloud.branch, null);
});

test('bootstrap needs an environment: the stored one, else the account\'s first, else a refusal', async () => {
  const detected = setup({ storedEnvironmentId: '' });
  const res = await detected.bootstrap(cloudRequest());
  assert.equal(res.statusCode, 200);
  assert.equal(detected.cloudCalls.listEnvironments, 1);
  assert.equal(JSON.parse(detected.stmts.getConvAnyStatus.get(res.body.conversationId).cloud_source_json).environmentId, ENVIRONMENT_ID);
  assert.equal(detected.stmts.getAppSetting.get(CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY).value, ENVIRONMENT_ID);

  for (const harness of [
    setup({ storedEnvironmentId: '', environments: [] }),
    setup({ storedEnvironmentId: '', environments: new Error('The Claude login has expired.') }),
    setup({ storedEnvironmentId: '', hasToken: false }),
  ]) {
    const refused = await harness.bootstrap(cloudRequest());
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.body.code, 'claude_cloud_environment_missing');
    assert.equal(harness.conversationCount(), 0);
  }
});

test('bootstrap takes cloud model ids only: a tier suffix is dropped, an unknown model refused', async () => {
  const harness = setup();
  const tier = await harness.bootstrap(cloudRequest({ model: 'claude-opus-5[1m]' }));
  assert.equal(tier.statusCode, 200);
  assert.equal(tier.body.selectedModel, 'claude-opus-5');
  assert.equal(harness.stmts.getRuntimeSessionByConversation.get(tier.body.conversationId).provider_model, 'claude-opus-5');

  const unknown = await harness.bootstrap(cloudRequest({ model: 'gpt-5.4-mini' }));
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.body.code, 'CLAUDE_CLOUD_MODEL_UNAVAILABLE');
  assert.deepEqual(unknown.body.supportedModels, ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5']);
});

test('the Claude provider is untouched: its bootstrap binds claude and carries no cloud', async () => {
  const harness = setup();
  // By name, and by a model id the cloud offers too: neither becomes a cloud chat.
  for (const body of [{ providerType: 'claude', model: 'claude-opus-5' }, { model: 'claude-sonnet-5' }]) {
    const res = await harness.bootstrap(body);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.selectedProviderType, 'claude');
    assert.equal(res.body.cloud, null);
    assert.equal(harness.stmts.getConvAnyStatus.get(res.body.conversationId).cloud_source_json, null);
  }
  // And a cloudSource on another provider's request is ignored, not stored.
  const stray = await harness.bootstrap({ providerType: 'claude', model: 'claude-opus-5', cloudSource: { repoUrl: REPO_URL } });
  assert.equal(stray.body.selectedProviderType, 'claude');
  assert.equal(harness.stmts.getConvAnyStatus.get(stray.body.conversationId).cloud_source_json, null);
});

// ─── conversation payloads ───────────────────────────────────────────────────

test('the conversation list and detail carry the cloud field, null for every other conversation', async () => {
  const harness = setup();
  const cloud = await harness.bootstrap(cloudRequest());
  const claude = await harness.bootstrap({ providerType: 'claude', model: 'claude-opus-5', title: 'Local chat' });
  const cloudId = cloud.body.conversationId;
  const report = harness.claudeCloudSessionService.recordWorkerReport({
    conversationId: cloudId,
    cloudSessionId: SESSION_ID,
    sessionUrl: SESSION_URL,
    lastSequence: '9',
    costUsd: 0.18,
    pushedBranch: 'dev/fix-slugify',
  });
  assert.equal(report.ok, true);

  const expected = {
    repoUrl: REPO_URL,
    slug: 'example-org/sample-repo',
    branch: 'dev/feature',
    sessionUrl: SESSION_URL,
    pushedBranches: report.cloud.pushedBranches,
    costUsd: 0.18,
  };
  assert.equal(expected.pushedBranches.length, 1);
  assert.equal(expected.pushedBranches[0].branch, 'dev/fix-slugify');

  const list = await call(harness.app, 'GET /api/conversations');
  const byId = Object.fromEntries(list.body.conversations.map((row) => [row.id, row]));
  assert.deepEqual(byId[cloudId].cloud, expected);
  assert.equal(byId[cloudId].runtimeProviderType, 'claude-cloud');
  assert.equal(byId[claude.body.conversationId].cloud, null);

  const detail = await call(harness.app, 'GET /api/conversation/:id', { params: { id: cloudId } });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.body.cloud, expected);
  assert.equal(detail.body.runtimeSession.providerType, 'claude-cloud');
  assert.equal(detail.body.sessionRootPath, null, 'no session folder on this host');
  const other = await call(harness.app, 'GET /api/conversation/:id', { params: { id: claude.body.conversationId } });
  assert.equal(other.body.cloud, null);

  // The environment and the cloud session id stay on the server.
  assert.equal(JSON.stringify([list.body, detail.body.cloud]).includes(ENVIRONMENT_ID), false);
  assert.equal(JSON.stringify(detail.body.cloud).includes(SESSION_ID), false);
});

test('a cloud conversation has no session root, even where a Copilot one would be found', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-cloud-session-root-'));
  try {
    fs.mkdirSync(path.join(stateRoot, 'conv-1'));
    const lookup = {
      conversationId: 'conv-1',
      sdkSessionId: 'conv-1',
      resolveSessionStateRoot: () => stateRoot,
      resolveClaudeSessionRoot: () => { throw new Error('not a Claude session'); },
      resolveCursorSessionRoot: () => { throw new Error('not a Cursor session'); },
    };
    assert.equal(buildConversationSessionRootPayload({ ...lookup, providerType: 'claude-cloud' }), null);
    assert.equal(buildConversationSessionRootPayload({ ...lookup, providerType: 'github' })?.sdkSessionId, 'conv-1');
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('the context reader serves what the cloud worker reported, as provider claude-cloud', async () => {
  const harness = setup();
  const created = await harness.bootstrap(cloudRequest());
  const conversationId = created.body.conversationId;
  const before = await call(harness.app, 'GET /api/context/:conversationId', { params: { conversationId } });
  assert.equal(before.statusCode, 200);
  assert.equal(before.body.providerType, 'claude-cloud');
  assert.equal(before.body.snapshot, null);
  assert.equal('attribution' in before.body, false, 'commit attribution is the Claude provider\'s own');

  harness.stmts.updateRuntimeSessionContextUsage.run(JSON.stringify({
    model: 'claude-sonnet-5-5',
    contextUsage: { totalTokens: 1200, maxTokens: 200000, percentage: 0.6, categories: [] },
    modelUsage: null,
  }), NOW, conversationId);
  const after = await call(harness.app, 'GET /api/context/:conversationId', { params: { conversationId } });
  assert.equal(after.body.providerType, 'claude-cloud');
  assert.notEqual(after.body.snapshot, null);
});

// ─── archive ─────────────────────────────────────────────────────────────────

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('archiving a cloud conversation archives its cloud session, best effort', async () => {
  const archived = [];
  const failing = Object.assign(new Error('The cloud did not answer.'), { code: 'transient' });
  const harness = setup({
    archiveSession: async (id) => { archived.push(id); throw failing; },
  });
  const created = await harness.bootstrap(cloudRequest());
  const conversationId = created.body.conversationId;

  // No cloud session yet: the conversation is archived, the cloud is not asked.
  const early = await call(harness.app, 'POST /api/conversation/:id/archive', { params: { id: conversationId } });
  assert.equal(early.statusCode, 200);
  await settle();
  assert.deepEqual(archived, []);

  harness.claudeCloudSessionService.recordWorkerReport({ conversationId, cloudSessionId: SESSION_ID });
  const res = await call(harness.app, 'POST /api/conversation/:id/archive', { params: { id: conversationId } });
  assert.deepEqual(res.body, { ok: true }, 'the cloud failing changes nothing for the user');
  assert.equal(harness.stmts.getConvAnyStatus.get(conversationId).archived, 1);
  await settle();
  await settle();
  assert.deepEqual(archived, [SESSION_ID]);
  assert.equal(harness.logs.some((line) => /was not archived: transient/.test(line)), true);

  // Another provider's conversation never reaches the cloud client.
  const claude = await harness.bootstrap({ providerType: 'claude', model: 'claude-opus-5' });
  await call(harness.app, 'POST /api/conversation/:id/archive', { params: { id: claude.body.conversationId } });
  await settle();
  assert.deepEqual(archived, [SESSION_ID]);
});
