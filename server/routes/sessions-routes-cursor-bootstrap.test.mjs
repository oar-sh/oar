import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';

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
    delete(path, ...handlers) {
      routes.set(`DELETE ${path}`, handlers);
    },
  };
}

function createMockDb() {
  const noopStmt = {
    run() {},
    get() {
      return null;
    },
    all() {
      return [];
    },
  };
  return {
    prepare() {
      return noopStmt;
    },
    transaction(fn) {
      return (...args) => fn(...args);
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
} = {}) {
  const app = createMockApp();
  const db = createMockDb();
  const bindingCalls = [];
  const insertedConversations = [];
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db,
    stmts: {
      getConvAnyStatus: { get: () => null },
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
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: (_cb) => {},
    ensureRuntimeSessionBinding: (conversationId, model, now, sdkSessionId, options) => {
      bindingCalls.push({ conversationId, model, now, sdkSessionId, options });
      return { id: 'runtime-session-1' };
    },
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
    resolveSessionStateRoot: () => null,
  };
  registerSessionsRoutes(app, deps);
  return { app, bindingCalls, insertedConversations };
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

test('bootstrap rejects the cursor provider when no API key is configured', async () => {
  const { app, bindingCalls } = createBootstrapHarness({
    cursorSettings: { configured: false, enabled: false, model: 'composer-2.5', models: [] },
  });
  const response = await callBootstrap(app, { providerType: 'cursor' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'CURSOR_NOT_CONFIGURED');
  assert.equal(response.body.error, 'Cursor API key is not configured');
  assert.equal(bindingCalls.length, 0);
});

test('bootstrap rejects explicit cursor models that are not available', async () => {
  const { app, bindingCalls } = createBootstrapHarness({
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'cheetah'],
    },
  });
  const response = await callBootstrap(app, { providerType: 'cursor', model: 'ghost-model' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'CURSOR_MODEL_UNAVAILABLE');
  assert.equal(response.body.error, 'Requested Cursor model is not available');
  assert.equal(bindingCalls.length, 0);
});

test('bootstrap rejects cursor-only models when another provider is forced', async () => {
  const { app, bindingCalls } = createBootstrapHarness({
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5'],
    },
  });
  const response = await callBootstrap(app, { providerType: 'github', model: 'composer-2.5' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'CURSOR_PROVIDER_REQUIRED');
  assert.match(response.body.error, /requires the Cursor provider/);
  assert.equal(bindingCalls.length, 0);
});

test('bootstrap binds cursor conversations with the selected provider model', async () => {
  const { app, bindingCalls } = createBootstrapHarness({
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'cheetah'],
    },
  });
  const response = await callBootstrap(app, { providerType: 'cursor', model: 'cheetah' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.selectedModel, 'cheetah');
  assert.equal(response.body.selectedProviderType, 'cursor');
  assert.equal(bindingCalls.length, 1);
  assert.deepEqual(bindingCalls[0].options, {
    assignConfiguredProvider: true,
    providerType: 'cursor',
    providerModel: 'cheetah',
  });
});

test('implicit provider inference prefers openai over cursor for shared models', async () => {
  const { app, bindingCalls } = createBootstrapHarness({
    openAISettings: {
      configured: true,
      enabled: true,
      model: 'gpt-4o',
      models: ['gpt-4o'],
    },
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'gpt-4o'],
    },
  });
  const response = await callBootstrap(app, { model: 'gpt-4o' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.selectedProviderType, 'openai');
  assert.equal(bindingCalls[0].options.providerType, 'openai');
});

test('implicit provider inference prefers claude over cursor for shared models', async () => {
  const { app } = createBootstrapHarness({
    claudeSettings: {
      configured: true,
      enabled: true,
      model: 'claude-sonnet-5',
      models: ['claude-sonnet-5'],
    },
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'claude-sonnet-5'],
    },
  });
  const response = await callBootstrap(app, { model: 'claude-sonnet-5' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.selectedProviderType, 'claude');
});

test('implicit provider inference selects cursor for cursor-only models', async () => {
  const { app, bindingCalls } = createBootstrapHarness({
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'cheetah'],
    },
  });
  const response = await callBootstrap(app, { model: 'cheetah' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.selectedProviderType, 'cursor');
  assert.equal(response.body.selectedModel, 'cheetah');
  assert.deepEqual(bindingCalls[0].options, {
    assignConfiguredProvider: true,
    providerType: 'cursor',
    providerModel: 'cheetah',
  });
});
