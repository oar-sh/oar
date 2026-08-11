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
  sessionWorkerSupervisor = null,
  featureFlags = {},
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
    SUPPORTED_RELAY_MODES: supportedRelayModes,
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags,
    sessionWorkerSupervisor,
    sessionWorkerRegistry: null,
    resolveSessionStateRoot: () => null,
  };
  registerSessionsRoutes(app, deps);
  return { app, bindingCalls, insertedConversations, preparedRuns };
}

function preferenceWrite(preparedRuns) {
  return preparedRuns.find((entry) => entry.sql.includes('SET preferred_relay_mode')) || null;
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
  assert.equal(response.body.error, 'Cursor model "ghost-model" is not available');
  // The rejection names the alternatives so a stale client can recover.
  assert.deepEqual(response.body.supportedModels, ['composer-2.5', 'cheetah']);
  assert.equal(bindingCalls.length, 0);
});

// One rejection block serves all four managed providers, so a swapped label or
// code would otherwise only be noticed for whichever one has a test.
test('the model rejection names the provider it came from', async () => {
  const cases = [
    ['openai', { configured: true, enabled: true, model: 'gpt-4o', models: ['gpt-4o'] }, 'OpenAI', 'OPENAI_MODEL_UNAVAILABLE'],
    ['claude', { configured: true, enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'] }, 'Claude', 'CLAUDE_MODEL_UNAVAILABLE'],
    ['cursor', { configured: true, enabled: true, model: 'composer-2.5', models: ['composer-2.5'] }, 'Cursor', 'CURSOR_MODEL_UNAVAILABLE'],
    ['grok', { configured: true, enabled: true, model: 'grok-4.5', models: ['grok-4.5'] }, 'Grok', 'GROK_MODEL_UNAVAILABLE'],
  ];
  for (const [providerType, settings, label, code] of cases) {
    const { app, bindingCalls } = createBootstrapHarness({
      [`${providerType}Settings`]: settings,
    });
    const response = await callBootstrap(app, { providerType, model: 'ghost-model' });
    assert.equal(response.statusCode, 400, providerType);
    assert.equal(response.body.code, code, providerType);
    assert.equal(response.body.error, `${label} model "ghost-model" is not available`, providerType);
    assert.equal(bindingCalls.length, 0, providerType);
  }
});

test('bootstrap stores the relay mode the caller is in', async () => {
  const { app, preparedRuns } = createBootstrapHarness({
    supportedRelayModes: ['agent', 'plan', 'ask'],
  });
  const response = await callBootstrap(app, { relayMode: 'plan' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.preferredRelayMode, 'plan');
  // Bootstrap writes the preferences row, so defaulting here would reset the
  // composer's mode on every new chat.
  assert.equal(preferenceWrite(preparedRuns)?.args?.[0], 'plan');
});

test('bootstrap falls back to the default relay mode for an unknown or missing one', async () => {
  for (const relayMode of [undefined, '', 'nonsense']) {
    const { app, preparedRuns } = createBootstrapHarness({
      supportedRelayModes: ['agent', 'plan'],
    });
    const response = await callBootstrap(app, { relayMode });
    assert.equal(response.body.preferredRelayMode, 'agent', String(relayMode));
    assert.equal(preferenceWrite(preparedRuns)?.args?.[0], 'agent', String(relayMode));
  }
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

test('bootstrap keeps the requested cursor model instead of the catalog current model', async () => {
  // The reported regression: New Chat -> Cursor -> grok -> high came back as the
  // Copilot catalog's current model (claude-opus-5) with the effort dropped.
  const { app, bindingCalls, preparedRuns } = createBootstrapHarness({
    modelState: {
      models: ['auto', 'claude-opus-5'],
      currentModel: 'claude-opus-5',
      defaultModel: 'claude-opus-5',
      reasoningByModel: {},
      providersByModel: { 'claude-opus-5': ['github-copilot'] },
      modelMetadataByModel: {},
    },
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'grok-4.5'],
      effortsByModel: { 'grok-4.5': ['none', 'low', 'medium', 'high'] },
    },
  });
  const response = await callBootstrap(app, {
    providerType: 'cursor',
    model: 'grok-4.5',
    reasoningEffort: 'high',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.selectedModel, 'grok-4.5');
  assert.equal(response.body.selectedProviderType, 'cursor');
  assert.equal(response.body.preferredModel, 'grok-4.5');
  assert.equal(response.body.preferredReasoningEffort, 'high');
  assert.equal(bindingCalls[0].options.providerModel, 'grok-4.5');
  const write = preferenceWrite(preparedRuns);
  assert.ok(write, 'bootstrap should persist conversation preferences');
  assert.equal(write.args[1], 'grok-4.5');
  assert.equal(write.args[2], 'high');
});

test('bootstrap canonicalizes a case-variant cursor model id', async () => {
  const { app, bindingCalls } = createBootstrapHarness({
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'Grok-4.5'],
    },
  });
  const response = await callBootstrap(app, { providerType: 'cursor', model: 'grok-4.5' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.selectedModel, 'Grok-4.5');
  assert.equal(bindingCalls[0].options.providerModel, 'Grok-4.5');
});

test('bootstrap clamps an unsupported effort to the model tiers', async () => {
  const { app } = createBootstrapHarness({
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5'],
      effortsByModel: { 'composer-2.5': ['none'] },
    },
  });
  const response = await callBootstrap(app, {
    providerType: 'cursor',
    model: 'composer-2.5',
    reasoningEffort: 'high',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.preferredReasoningEffort, 'none');
});

test('bootstrap reports the grok provider it actually bound', async () => {
  const { app, bindingCalls } = createBootstrapHarness({
    grokSettings: {
      configured: true,
      enabled: true,
      model: 'grok-4.5',
      models: ['grok-4.5'],
      effortsByModel: { 'grok-4.5': ['none', 'low', 'high'] },
    },
  });
  const response = await callBootstrap(app, {
    providerType: 'grok',
    model: 'grok-4.5',
    reasoningEffort: 'high',
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.selectedProviderType, 'grok');
  assert.equal(response.body.preferredReasoningEffort, 'high');
  assert.equal(bindingCalls[0].options.providerType, 'grok');
});

test('a failed worker prestart still reports the committed conversation', async () => {
  const { app, preparedRuns } = createBootstrapHarness({
    cursorSettings: {
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5', 'grok-4.5'],
      effortsByModel: { 'grok-4.5': ['none', 'high'] },
    },
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    sessionWorkerSupervisor: {
      clearRestartSchedule() {},
      async ensureWorker() {
        return { ok: false, error: 'worker-bootstrap-failed' };
      },
    },
  });
  const response = await callBootstrap(app, {
    providerType: 'cursor',
    model: 'grok-4.5',
    reasoningEffort: 'high',
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.conversationCreated, true);
  assert.equal(response.body.selectedModel, 'grok-4.5');
  assert.equal(response.body.preferredReasoningEffort, 'high');
  assert.ok(preferenceWrite(preparedRuns), 'preferences are committed before the worker starts');
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
