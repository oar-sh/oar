import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { fakeSessionWorkerSupervisor } from '../feature-flags-test-harness.mjs';

// The bootstrap route with the Copilot switch stored as `copilotEnabled`
// ('true', 'false', or null for unset); the harness of
// sessions-routes-cursor-bootstrap.test.mjs.

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers);
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers);
    },
    patch(path, ...handlers) {
      routes.set(`PATCH ${path}`, handlers);
    },
    put(path, ...handlers) {
      routes.set(`PUT ${path}`, handlers);
    },
    delete(path, ...handlers) {
      routes.set(`DELETE ${path}`, handlers);
    },
  };
}

function createMockDb(preparedRuns = []) {
  return {
    prepare(sql) {
      return {
        run(...args) {
          preparedRuns.push({ sql: String(sql || '').replace(/\s+/g, ' ').trim(), args });
        },
        get() {
          return null;
        },
        all() {
          return [];
        },
      };
    },
    transaction(fn) {
      return (...args) => {
        const result = fn(...args);
        // better-sqlite3 refuses a promise-returning transaction body; without
        // this the tests would keep passing after an await slipped in.
        if (result && typeof result.then === 'function') {
          throw new TypeError('Transaction function cannot return a promise');
        }
        return result;
      };
    },
  };
}

function createBootstrapHarness({
  modelState = {
    models: ['auto', 'gpt-5.4-mini'],
    currentModel: 'gpt-5.4-mini',
    defaultModel: 'gpt-5.4-mini',
    reasoningByModel: { 'gpt-5.4-mini': ['none'] },
    providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    modelMetadataByModel: {},
  },
  openAISettings = { configured: false, enabled: false, model: 'gpt-4o', models: [] },
  claudeSettings = { configured: false, enabled: false, model: 'claude-sonnet-5', models: [] },
  cursorSettings = { configured: false, enabled: false, model: 'composer-2.5', models: [] },
  grokSettings = { configured: false, enabled: false, model: 'grok-4.5', models: [] },
  copilotEnabled = null,
  // The Copilot catalogue's resolution of a requested id, as the runtime gives it.
  resolveRequestedModel = (model) => (/^gpt-5\.4-mini(-(low|medium|high))?$/i.test(String(model || '')) ? { ok: true } : { ok: false }),
  sessionWorkerSupervisor = fakeSessionWorkerSupervisor(),
  supportedRelayModes = ['agent'],
} = {}) {
  const app = createMockApp();
  const preparedRuns = [];
  const db = createMockDb(preparedRuns);
  const bindingCalls = [];
  const insertedConversations = [];
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db,
    stmts: {
      getConvAnyStatus: { get: () => null },
      getAppSetting: { get: (key) => (key === 'copilot_enabled' && copilotEnabled !== null ? { key, value: copilotEnabled } : undefined) },
      insertConv: {
        run: (...args) => {
          insertedConversations.push(args);
        },
      },
    },
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => ({}),
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => modelState,
    updateModelCatalog: () => modelState,
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => modelState,
    setEnabledModelVariants: () => modelState,
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({}),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    getOpenAIProviderSettings: () => openAISettings,
    setOpenAIProviderSettings: () => ({ ok: true, ...openAISettings }),
    refreshOpenAIProviderModels: async () => ({ ok: true, models: [], error: null }),
    getClaudeProviderSettings: () => claudeSettings,
    setClaudeProviderSettings: () => ({ ok: true, ...claudeSettings }),
    refreshClaudeProviderModels: async () => ({ ok: true, models: [], error: null }),
    getCursorProviderSettings: () => cursorSettings,
    setCursorProviderSettings: () => ({ ok: true, ...cursorSettings }),
    refreshCursorProviderModels: async () => ({ ok: true, models: [], error: null }),
    getGrokProviderSettings: () => grokSettings,
    setGrokProviderSettings: () => ({ ok: true, ...grokSettings }),
    refreshGrokProviderModels: async () => ({ ok: true, models: [], error: null }),
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
    markCliOffline: () => {},
    fetchUsageSummary: (_cb) => {},
    ensureRuntimeSessionBinding: (conversationId, model, now, sdkSessionId, options) => {
      bindingCalls.push({ conversationId, model, now, sdkSessionId, options });
      return { id: 'runtime-session-1' };
    },
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: supportedRelayModes,
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    sessionWorkerSupervisor,
    sessionWorkerRegistry: null,
    resolveSessionStateRoot: () => null,
    resolveRequestedModel,
  };
  registerSessionsRoutes(app, deps);
  return { app, bindingCalls, insertedConversations, preparedRuns };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(
      req,
      response,
      () => {
        nextCalled = true;
      },
    );
    if (!nextCalled) break;
  }
  return response;
}

async function callBootstrap(app, body) {
  const handlers = app.routes.get('POST /api/conversation/bootstrap');
  assert.ok(handlers, 'bootstrap route should be registered');
  return callRoute(handlers, { headers: {}, body, query: {}, params: {} });
}

const CLAUDE_ONLY = { configured: true, enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'] };

test('Copilot off: a create naming nothing is refused with PROVIDER_REQUIRED, nothing created', async () => {
  const { app, bindingCalls, insertedConversations } = createBootstrapHarness({ copilotEnabled: 'false' });
  const response = await callBootstrap(app, {});
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'PROVIDER_REQUIRED');
  assert.equal(response.body.error, 'Name a provider: Copilot is switched off on this relay.');
  assert.equal(bindingCalls.length, 0);
  assert.equal(insertedConversations.length, 0);
});

test('Copilot off: naming Copilot, or a model of its catalogue, is refused with COPILOT_NOT_ENABLED', async () => {
  for (const body of [{ providerType: 'github' }, { provider: 'github-copilot', model: 'gpt-5.4-mini' }, { model: 'GPT-5.4-mini' }]) {
    const { app, bindingCalls, insertedConversations } = createBootstrapHarness({ copilotEnabled: 'false' });
    const response = await callBootstrap(app, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.body.code, 'COPILOT_NOT_ENABLED');
    assert.match(response.body.error, /Copilot is switched off on this relay, so no Copilot chat was started/);
    assert.equal(bindingCalls.length, 0);
    assert.equal(insertedConversations.length, 0);
  }
});

test('Copilot off and only Claude on: a Claude create goes through, bound to Claude', async () => {
  const { app, bindingCalls } = createBootstrapHarness({ copilotEnabled: 'false', claudeSettings: CLAUDE_ONLY });
  const response = await callBootstrap(app, { providerType: 'claude', model: 'claude-sonnet-5' });
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.equal(bindingCalls.length, 1);
  assert.equal(bindingCalls[0].options.providerType, 'claude');
});

test('Copilot on or unset: a create naming nothing is still a Copilot chat', async () => {
  for (const copilotEnabled of ['true', null]) {
    const { app, bindingCalls } = createBootstrapHarness({ copilotEnabled });
    const response = await callBootstrap(app, {});
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(bindingCalls.length, 1);
    assert.equal(bindingCalls[0].options.providerType, 'github');
  }
});

test('Copilot off: a Copilot model with its effort, or provider "copilot", names Copilot as the first send does', async () => {
  for (const body of [{ model: 'gpt-5.4-mini-high' }, { provider: 'copilot' }, { providerType: 'Copilot', model: 'gpt-5.4-mini' }]) {
    const { app, bindingCalls } = createBootstrapHarness({ copilotEnabled: 'false' });
    const response = await callBootstrap(app, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(response.body.code, 'COPILOT_NOT_ENABLED', JSON.stringify(body));
    assert.equal(bindingCalls.length, 0);
  }
  // A model no provider lists names nothing: the caller is asked for a provider.
  const { app } = createBootstrapHarness({ copilotEnabled: 'false' });
  assert.equal((await callBootstrap(app, { model: 'no-such-model' })).body.code, 'PROVIDER_REQUIRED');
});
