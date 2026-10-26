import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModelCatalogWithClaudeApiProvider, registerSessionsRoutes } from './sessions-routes.mjs';
import { createClaudeApiSettingsService } from '../services/claude-api-settings-service.mjs';

// Invented placeholders, short enough not to look like real keys.
const TEST_KEY = 'sk-ant-api03-test-3333';
const OTHER_KEY = 'sk-ant-api03-test-4444';

const CLAUDE_SETTINGS = Object.freeze({
  configured: true,
  enabled: true,
  model: 'claude-sonnet-5',
  models: ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5[1m]'],
  availableModels: ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-5[1m]'],
  effortsByModel: {},
});

const DISCOVERED = [
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000 },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', max_input_tokens: 200000, max_tokens: 64000 },
];

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) { routes.set(`GET ${path}`, handlers); },
    post(path, ...handlers) { routes.set(`POST ${path}`, handlers); },
    patch(path, ...handlers) { routes.set(`PATCH ${path}`, handlers); },
    delete(path, ...handlers) { routes.set(`DELETE ${path}`, handlers); },
  };
}

function createMockDb(queries = [], runtimeRows = []) {
  return {
    prepare(sql) {
      const text = String(sql || '').replace(/\s+/g, ' ').trim();
      return {
        run(...args) { queries.push({ sql: text, args, kind: 'run' }); },
        get() { return null; },
        all(...args) {
          queries.push({ sql: text, args, kind: 'all' });
          return text.includes('FROM runtime_sessions') ? runtimeRows : [];
        },
      };
    },
    transaction(fn) {
      return (...args) => {
        const result = fn(...args);
        if (result && typeof result.then === 'function') {
          throw new TypeError('Transaction function cannot return a promise');
        }
        return result;
      };
    },
  };
}

function createHarness({
  claudeApiSettingsService = null,
  getClaudeApiCapState = undefined,
  checkClaudeApiCap = undefined,
  claudeApiStopLedger = undefined,
  claudeSettings = CLAUDE_SETTINGS,
  runtimeRows = [],
  sessionWorkerRegistry = null,
  sessionWorkerSupervisor = { getWorkerState: () => null },
  modelState = {
    models: ['auto', 'gpt-5.4-mini', 'claude-sonnet-5'],
    currentModel: 'gpt-5.4-mini',
    defaultModel: 'gpt-5.4-mini',
    reasoningByModel: { 'gpt-5.4-mini': ['none'] },
    providersByModel: { 'gpt-5.4-mini': ['github-copilot'], 'claude-sonnet-5': ['github-copilot'] },
    modelMetadataByModel: {},
  },
} = {}) {
  const app = createMockApp();
  const queries = [];
  const emitted = [];
  const bindingCalls = [];
  const reconcileCalls = [];
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push({ event, payload }); } },
    db: createMockDb(queries, runtimeRows),
    stmts: {
      getConvAnyStatus: { get: () => null },
      insertConv: { run: () => {} },
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
    getOpenAIProviderSettings: () => ({ configured: false, enabled: false, model: 'gpt-4o', models: [] }),
    setOpenAIProviderSettings: () => ({ ok: true }),
    refreshOpenAIProviderModels: async () => ({ ok: true, models: [], error: null }),
    getClaudeProviderSettings: () => claudeSettings,
    setClaudeProviderSettings: () => ({ ok: true, ...claudeSettings }),
    refreshClaudeProviderModels: async () => ({ ok: true, models: [], error: null }),
    getCursorProviderSettings: () => ({ configured: false, enabled: false, model: 'composer-2.5', models: [] }),
    setCursorProviderSettings: () => ({ ok: true }),
    refreshCursorProviderModels: async () => ({ ok: true, models: [], error: null }),
    getGrokProviderSettings: () => ({ configured: false, enabled: false, model: 'grok-4.5', models: [] }),
    setGrokProviderSettings: () => ({ ok: true }),
    refreshGrokProviderModels: async () => ({ ok: true, models: [], error: null }),
    claudeApiSettingsService,
    ...(getClaudeApiCapState ? { getClaudeApiCapState } : {}),
    ...(checkClaudeApiCap ? { checkClaudeApiCap } : {}),
    ...(claudeApiStopLedger ? { claudeApiStopLedger } : {}),
    reconcileUnstartedConversationProviders: async (args) => {
      reconcileCalls.push(args);
      return { updatedUnstartedConversations: 2, skippedStartedConversations: 1, skippedActiveQueueConversations: 0, failedConversations: [] };
    },
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
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
    resolveSessionStateRoot: () => null,
  };
  registerSessionsRoutes(app, deps);
  return { app, queries, emitted, bindingCalls, reconcileCalls };
}

function createClaudeApiService({ initial = {}, candidates = [], respond = null, claudeSettings = CLAUDE_SETTINGS } = {}) {
  const values = new Map(Object.entries(initial));
  const fetchCalls = [];
  const service = createClaudeApiSettingsService({
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value) => { values.set(key, String(value)); },
    deleteSetting: (key) => { values.delete(key); },
    listProviderCandidates: () => candidates,
    getClaudeProviderSettings: () => claudeSettings,
    env: {},
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      if (respond) return respond(url, options);
      return { ok: true, status: 200, json: async () => ({ data: DISCOVERED, has_more: false }), text: async () => '' };
    },
  });
  return { service, values, fetchCalls };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler({ headers: {}, query: {}, params: {}, ...req }, response, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return response;
}

function route(app, method, path) {
  const handlers = app.routes.get(`${method} ${path}`);
  assert.ok(handlers, `${method} ${path} should be registered`);
  return handlers;
}

const post = (app, body) => callRoute(route(app, 'POST', '/api/settings/claude-api'), { body });
const bootstrap = (app, body) => callRoute(route(app, 'POST', '/api/conversation/bootstrap'), { body });

test('the settings routes answer 501 without the service', async () => {
  const { app } = createHarness();
  assert.equal((await callRoute(route(app, 'GET', '/api/settings/claude-api'))).statusCode, 501);
  assert.equal((await post(app, { apiKey: TEST_KEY })).statusCode, 501);
});

test('saving a key discovers the models, announces the change and never answers the key', async () => {
  const claudeApi = createClaudeApiService();
  const { app, emitted } = createHarness({ claudeApiSettingsService: claudeApi.service });
  const saved = await post(app, { apiKey: TEST_KEY });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.configured, true);
  assert.equal(saved.body.enabled, true);
  assert.equal(saved.body.warning, null);
  assert.equal(saved.body.discoveryError, null);
  assert.equal(saved.body.discovered, true);
  assert.deepEqual(saved.body.availableModels, ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]']);
  assert.equal(claudeApi.fetchCalls.length, 1);
  assert.equal(claudeApi.fetchCalls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(JSON.stringify(saved.body).includes(TEST_KEY), false);
  assert.ok(emitted.some((entry) => entry.event === 'claude_api_settings_updated'));
  assert.equal(JSON.stringify(emitted).includes(TEST_KEY), false);
  const catalog = emitted.find((entry) => entry.event === 'models_updated').payload;
  assert.deepEqual(catalog.providersByModel['claude-opus-5-5'], ['claude-api']);
  assert.deepEqual(catalog.claudeApiContextTiersByModel['claude-opus-5-5'], [{ value: 'default' }, { value: 'long_context' }]);

  const read = await callRoute(route(app, 'GET', '/api/settings/claude-api'));
  assert.equal(read.body.configured, true);
  assert.equal('apiKey' in read.body, false);
  assert.equal(JSON.stringify(read.body).includes(TEST_KEY), false);
});

test('OAuth tokens and admin keys are refused by prefix, named, and not stored', async () => {
  const claudeApi = createClaudeApiService();
  const { app } = createHarness({ claudeApiSettingsService: claudeApi.service });
  const cases = [
    ['sk-ant-oat01-fake-xx', 'claude-api-key-oauth-access-token', /OAuth access token/],
    ['sk-ant-ort01-fake-xx', 'claude-api-key-oauth-refresh-token', /OAuth refresh token/],
    ['sk-ant-admin01-fake-x', 'claude-api-key-admin-key', /Admin API key/],
  ];
  for (const [value, code, text] of cases) {
    const response = await post(app, { apiKey: value });
    assert.equal(response.statusCode, 400, value);
    assert.equal(response.body.code, code);
    assert.match(response.body.error, text);
    assert.match(response.body.error, /Claude Console/);
    assert.equal(JSON.stringify(response.body).includes(value), false);
  }
  assert.equal(claudeApi.values.size, 0);
  assert.equal(claudeApi.fetchCalls.length, 0);
});

test('the monthly cap is validated and stored; a bad one stores nothing', async () => {
  const claudeApi = createClaudeApiService({ initial: { claude_api_key: TEST_KEY, claude_api_models: JSON.stringify([{ id: 'claude-sonnet-5-5' }]) } });
  const { app } = createHarness({ claudeApiSettingsService: claudeApi.service });
  for (const monthlyCapUsd of [0, -3, '12.345', 'lots', 2000000, true]) {
    const refused = await post(app, { monthlyCapUsd });
    assert.equal(refused.statusCode, 400, String(monthlyCapUsd));
  }
  assert.equal(claudeApi.values.has('claude_api_monthly_cap_usd'), false);
  const saved = await post(app, { monthlyCapUsd: '75.50' });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.monthlyCapUsd, 75.5);
  const cleared = await post(app, { monthlyCapUsd: null });
  assert.equal(cleared.body.monthlyCapUsd, null);
  for (const body of [{ model: 'gpt-5.5' }, { enabled: 'on' }, {}]) {
    assert.equal((await post(app, body)).statusCode, 400, JSON.stringify(body));
  }
});

test('a failed discovery keeps the Claude tab\'s list, warns without the key and changes nothing else', async () => {
  const claudeApi = createClaudeApiService({
    respond: async () => ({ ok: false, status: 401, text: async () => `{"error":{"type":"authentication_error","message":"bad ${TEST_KEY}"}}`, json: async () => ({}) }),
  });
  const { app } = createHarness({ claudeApiSettingsService: claudeApi.service });
  const saved = await post(app, { apiKey: TEST_KEY });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.discovered, false);
  assert.deepEqual(saved.body.availableModels, CLAUDE_SETTINGS.availableModels);
  assert.equal(saved.body.model, 'claude-sonnet-5');
  assert.match(saved.body.warning, /401/);
  assert.equal(saved.body.warning.includes(TEST_KEY), false);
  assert.equal(claudeApi.values.has('claude_api_models'), false);
  // The key is saved and on; the refusal is the tab's status.
  assert.equal(saved.body.configured, true);
  assert.equal(saved.body.enabled, true);
  assert.equal(claudeApi.values.get('claude_api_key'), TEST_KEY);
  assert.equal(saved.body.discoveryError.code, 'unauthorized');
  assert.match(saved.body.discoveryError.error, /401/);
  assert.equal(saved.body.discoveryError.error.includes(TEST_KEY), false);
  // The first key: the default stays the Claude tab's, so nothing moved.
  assert.equal(saved.body.discoveryError.defaultModelChanged, null);
});

test('a Console key that does not start with sk-ant-api is saved and discovered', async () => {
  const claudeApi = createClaudeApiService();
  const { app } = createHarness({ claudeApiSettingsService: claudeApi.service });
  const saved = await post(app, { apiKey: 'sk-ant-usr01-fake-key' });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.configured, true);
  assert.equal(saved.body.discovered, true);
  assert.equal(claudeApi.fetchCalls[0].options.headers['x-api-key'], 'sk-ant-usr01-fake-key');
  assert.equal(JSON.stringify(saved.body).includes('sk-ant-usr01-fake-key'), false);
});

test('a rotated key looks for the live Claude API workers to stop them', async () => {
  const claudeApi = createClaudeApiService({ initial: { claude_api_key: TEST_KEY } });
  const { app, queries } = createHarness({ claudeApiSettingsService: claudeApi.service });
  const saved = await post(app, { apiKey: OTHER_KEY });
  assert.equal(saved.statusCode, 200);
  const lookup = queries.find((entry) => entry.kind === 'all' && entry.sql.includes('FROM runtime_sessions'));
  assert.ok(lookup, 'the live workers of the provider are looked up');
  assert.deepEqual(lookup.args, ['claude-api']);
  assert.equal(claudeApi.values.get('claude_api_key'), OTHER_KEY);
});

test('a rotated key stops the workers that run on the key, by their kind, not by their chat\'s billing', async () => {
  const claudeApi = createClaudeApiService({ initial: { claude_api_key: TEST_KEY } });
  const workers = [
    // Switched to the key; its subscription worker is still finishing a turn.
    { sdkSessionId: 'sid-moved-to-key', kind: 'claude' },
    // Switched back to the subscription; its API worker is still finishing.
    { sdkSessionId: 'sid-moved-back', kind: 'claude-api' },
    { sdkSessionId: 'sid-on-key', kind: 'claude-api' },
  ];
  const stopping = [];
  const { app } = createHarness({
    claudeApiSettingsService: claudeApi.service,
    runtimeRows: [
      { sdk_session_id: 'sid-moved-to-key' },
      { sdk_session_id: 'sid-on-key' },
      // A worker that never said its kind is taken at its chat's billing.
      { sdk_session_id: 'sid-quiet' },
    ],
    sessionWorkerRegistry: {
      listWorkers: () => workers,
      getWorker: (sid) => workers.find((worker) => worker.sdkSessionId === sid) || null,
    },
    sessionWorkerSupervisor: {
      getWorkerState: () => ({ status: 'ready' }),
      // The stop itself is not this test's: it ends here.
      markKilled: (sid) => { stopping.push(sid); throw new Error('stop not under test'); },
    },
  });
  const saved = await post(app, { apiKey: OTHER_KEY });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(stopping.sort(), ['sid-moved-back', 'sid-on-key', 'sid-quiet']);
});

test('removing the key is refused while a switched-back chat still has a row or a worker on it', async () => {
  const stamped = createClaudeApiService({
    initial: { claude_api_key: TEST_KEY },
    candidates: [{ provider_type: 'claude', message_count: 4, active_queue_count: 1, claude_api_queue_count: 1 }],
  });
  const first = await post(createHarness({ claudeApiSettingsService: stamped.service }).app, { remove: true });
  assert.equal(first.statusCode, 409);
  assert.equal(first.body.code, 'claude-api-key-removal-blocked');
  assert.equal(stamped.values.get('claude_api_key'), TEST_KEY);

  const values = new Map([['claude_api_key', TEST_KEY]]);
  const working = createClaudeApiSettingsService({
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value) => { values.set(key, String(value)); },
    deleteSetting: (key) => { values.delete(key); },
    listProviderCandidates: () => [{ provider_type: 'claude', message_count: 4, active_queue_count: 0, claude_api_queue_count: 0 }],
    countLiveKeyWorkers: () => 1,
    getClaudeProviderSettings: () => CLAUDE_SETTINGS,
    env: {},
  });
  const second = await post(createHarness({ claudeApiSettingsService: working }).app, { remove: true });
  assert.equal(second.statusCode, 409);
  assert.match(second.body.error, /1 worker\(s\) still run on it/);
  assert.equal(values.get('claude_api_key'), TEST_KEY);
});

test('removing the key is refused with 409 while a Claude API conversation has a message', async () => {
  const claudeApi = createClaudeApiService({
    initial: { claude_api_key: TEST_KEY },
    candidates: [{ provider_type: 'claude-api', message_count: 3, active_queue_count: 0 }],
  });
  const { app, reconcileCalls } = createHarness({ claudeApiSettingsService: claudeApi.service });
  const response = await post(app, { remove: true });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'claude-api-key-removal-blocked');
  assert.equal(response.body.activeConversationCount, 1);
  assert.equal(claudeApi.values.get('claude_api_key'), TEST_KEY);
  assert.equal(reconcileCalls.length, 0);
});

test('removing the key or switching off moves unstarted Claude API conversations back', async () => {
  const removable = createClaudeApiService({ initial: { claude_api_key: TEST_KEY } });
  const removeHarness = createHarness({ claudeApiSettingsService: removable.service });
  const removed = await post(removeHarness.app, { remove: true });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.body.configured, false);
  assert.deepEqual(removeHarness.reconcileCalls, [{ enabled: false, model: '', provider: 'claude-api' }]);
  assert.equal(removed.body.reconciliation.updatedUnstartedConversations, 2);

  const switchable = createClaudeApiService({ initial: { claude_api_key: TEST_KEY } });
  const offHarness = createHarness({ claudeApiSettingsService: switchable.service });
  const off = await post(offHarness.app, { enabled: false });
  assert.equal(off.statusCode, 200);
  assert.equal(off.body.enabled, false);
  assert.equal(offHarness.reconcileCalls.length, 1);
  assert.equal(offHarness.reconcileCalls[0].provider, 'claude-api');
  // Changing the cap alone moves nothing.
  const capHarness = createHarness({ claudeApiSettingsService: createClaudeApiService({ initial: { claude_api_key: TEST_KEY } }).service });
  await post(capHarness.app, { monthlyCapUsd: 10 });
  assert.equal(capHarness.reconcileCalls.length, 0);
});

test('bootstrap refuses Claude API without a key or while it is switched off', async () => {
  const { app, bindingCalls } = createHarness({ claudeApiSettingsService: createClaudeApiService().service });
  const response = await bootstrap(app, { providerType: 'claude-api' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'CLAUDE_API_NOT_CONFIGURED');
  assert.equal(response.body.error, 'Claude API key is not configured.');

  const off = createClaudeApiService({ initial: { claude_api_key: TEST_KEY, claude_api_enabled: 'false' } });
  const offHarness = createHarness({ claudeApiSettingsService: off.service });
  const offResponse = await bootstrap(offHarness.app, { providerType: 'claude-api' });
  assert.equal(offResponse.body.code, 'CLAUDE_API_NOT_CONFIGURED');
  // New Chat shows it as a sentence.
  assert.equal(offResponse.body.error, 'Claude API is switched off for new conversations.');

  const noService = createHarness();
  assert.equal((await bootstrap(noService.app, { providerType: 'claude-api' })).body.code, 'CLAUDE_API_NOT_CONFIGURED');
  assert.equal(bindingCalls.length + offHarness.bindingCalls.length + noService.bindingCalls.length, 0);
});

test('bootstrap creates a claude-api conversation on the default model with the Claude efforts', async () => {
  const claudeApi = createClaudeApiService({
    initial: { claude_api_key: TEST_KEY, claude_api_models: JSON.stringify([{ id: 'claude-opus-5-5', contextWindow: 1000000 }, { id: 'claude-sonnet-5-5' }]) },
  });
  const { app, bindingCalls } = createHarness({ claudeApiSettingsService: claudeApi.service });
  const response = await bootstrap(app, { providerType: 'claude-api', reasoningEffort: 'ultracode' });
  assert.equal(response.statusCode, 200);
  assert.equal(bindingCalls.length, 1);
  assert.equal(bindingCalls[0].model, 'claude-sonnet-5-5');
  assert.equal(bindingCalls[0].options.providerType, 'claude-api');
  assert.equal(bindingCalls[0].options.providerModel, 'claude-sonnet-5-5');
  assert.equal(response.body.preferredReasoningEffort, 'ultracode');

  const long = createHarness({ claudeApiSettingsService: claudeApi.service });
  const longResponse = await bootstrap(long.app, { providerType: 'claude-api', model: 'claude-opus-5-5[1m]' });
  assert.equal(longResponse.statusCode, 200);
  assert.equal(long.bindingCalls[0].options.providerModel, 'claude-opus-5-5[1m]');

  const unknown = createHarness({ claudeApiSettingsService: claudeApi.service });
  const refused = await bootstrap(unknown.app, { providerType: 'claude-api', model: 'claude-ghost-9' });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.body.code, 'CLAUDE_API_MODEL_UNAVAILABLE');
  assert.equal(refused.body.error, 'Claude API model "claude-ghost-9" is not available');
  assert.equal(unknown.bindingCalls.length, 0);
});

test('a model id alone never picks Claude API; one only it lists names the provider', async () => {
  const claudeApi = createClaudeApiService({
    initial: { claude_api_key: TEST_KEY, claude_api_models: JSON.stringify([{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-5-5' }]) },
  });
  // A model the Claude tab offers too stays Claude's.
  const shared = createHarness({ claudeApiSettingsService: claudeApi.service });
  const sharedResponse = await bootstrap(shared.app, { model: 'claude-sonnet-5' });
  assert.equal(sharedResponse.statusCode, 200);
  assert.equal(shared.bindingCalls[0].options.providerType, 'claude');

  const only = createHarness({ claudeApiSettingsService: claudeApi.service, claudeSettings: { ...CLAUDE_SETTINGS, enabled: false } });
  const onlyResponse = await bootstrap(only.app, { model: 'claude-haiku-5-5' });
  assert.equal(onlyResponse.statusCode, 400);
  assert.equal(onlyResponse.body.code, 'CLAUDE_API_PROVIDER_REQUIRED');
  assert.equal(only.bindingCalls.length, 0);
});

test('the catalog layer tags Claude API beside the other providers and folds [1m] into a tier', () => {
  const base = {
    models: ['claude-opus-5', 'auto'],
    reasoningByModel: { 'claude-opus-5': ['none', 'high'] },
    reasoningByProvider: {},
    modelMetadataByModel: { 'claude-opus-5': { provider: 'github-copilot' } },
    providersByModel: { 'claude-opus-5': ['github-copilot', 'claude'] },
  };
  assert.deepEqual(buildModelCatalogWithClaudeApiProvider(base, { enabled: false, model: 'claude-opus-5', models: ['claude-opus-5'] }), base);
  const result = buildModelCatalogWithClaudeApiProvider(base, {
    enabled: true,
    model: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-opus-5[1m]', 'claude-haiku-5-5'],
    effortsByModel: { 'claude-haiku-5-5': ['none'] },
  });
  assert.deepEqual(result.models, ['claude-opus-5', 'auto', 'claude-haiku-5-5']);
  assert.deepEqual(result.providersByModel['claude-opus-5'], ['github-copilot', 'claude', 'claude-api']);
  assert.deepEqual(result.providersByModel['claude-haiku-5-5'], ['claude-api']);
  assert.equal(result.modelMetadataByModel['claude-opus-5'].provider, 'github-copilot');
  assert.equal(result.modelMetadataByModel['claude-haiku-5-5'].provider, 'claude-api');
  assert.deepEqual(result.claudeApiContextTiersByModel['claude-opus-5'], [{ value: 'default' }, { value: 'long_context' }]);
  assert.deepEqual(result.reasoningByProvider['claude-api']['claude-haiku-5-5'], ['none']);
  assert.deepEqual(result.reasoningByProvider['claude-api']['claude-opus-5'], ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  // Another provider's efforts for a shared id are left alone.
  assert.deepEqual(result.reasoningByModel['claude-opus-5'], ['none', 'high']);
});

test('model variants list the Claude API models while the provider is on', async () => {
  const claudeApi = createClaudeApiService({ initial: { claude_api_key: TEST_KEY, claude_api_models: JSON.stringify([{ id: 'claude-sonnet-5-5' }]) } });
  const { app } = createHarness({ claudeApiSettingsService: claudeApi.service });
  const response = await callRoute(route(app, 'GET', '/api/model-variants'));
  assert.deepEqual(response.body.claudeApiModels, {
    defaultModel: 'claude-sonnet-5-5',
    availableModels: ['claude-sonnet-5-5'],
    enabledModels: ['claude-sonnet-5-5'],
    discovered: true,
  });
  const off = createHarness({ claudeApiSettingsService: createClaudeApiService().service });
  assert.equal((await callRoute(route(off.app, 'GET', '/api/model-variants'))).body.claudeApiModels, null);
});

test('bootstrap refuses a new Claude API chat while this month\'s cap is reached, or cannot be read', async () => {
  const claudeApi = createClaudeApiService({ initial: { claude_api_key: TEST_KEY, claude_api_monthly_cap_usd: '5' } });
  const error = 'This month\'s estimated Claude API spend, $5.10, has reached the monthly cap of $5.00 set in Settings → Providers → Claude API.';
  const reason = 'This month\'s estimated Claude API spend, $5.10, has reached the monthly cap of $5.00.';
  const reached = createHarness({ claudeApiSettingsService: claudeApi.service, getClaudeApiCapState: () => ({ reached: true, error, reason }) });
  const response = await bootstrap(reached.app, { providerType: 'claude-api' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'CLAUDE_API_CAP_REACHED');
  // The place is named once, in the remedy.
  assert.equal(response.body.error, `${reason} No Claude API chat was started; start it on the Claude subscription, or raise the cap in Settings → Providers → Claude API.`);
  assert.equal(response.body.error.split('Settings → Providers → Claude API').length - 1, 1);
  assert.equal(reached.bindingCalls.length, 0);

  const unreadable = createHarness({ claudeApiSettingsService: claudeApi.service, getClaudeApiCapState: () => { throw new Error('totals unreadable'); } });
  const unreadableResponse = await bootstrap(unreadable.app, { providerType: 'claude-api' });
  assert.equal(unreadableResponse.body.code, 'CLAUDE_API_CAP_REACHED');
  assert.equal(unreadable.bindingCalls.length, 0);

  // Below the cap, and for any other provider at the cap, nothing changes.
  const below = createHarness({ claudeApiSettingsService: claudeApi.service, getClaudeApiCapState: () => ({ reached: false }) });
  assert.equal((await bootstrap(below.app, { providerType: 'claude-api' })).statusCode, 200);
  assert.equal(below.bindingCalls.length, 1);
  const subscription = createHarness({ claudeApiSettingsService: claudeApi.service, getClaudeApiCapState: () => ({ reached: true, error }) });
  const onClaude = await bootstrap(subscription.app, { providerType: 'claude', model: 'claude-sonnet-5' });
  assert.notEqual(onClaude.body.code, 'CLAUDE_API_CAP_REACHED');
});

test('a saved cap (or any saved Claude API setting) asks whether the cap flipped; a refused one does not', async () => {
  const claudeApi = createClaudeApiService({ initial: { claude_api_key: TEST_KEY, claude_api_models: JSON.stringify([{ id: 'claude-sonnet-5-5' }]) } });
  const checks = [];
  const cleared = [];
  const { app } = createHarness({
    claudeApiSettingsService: claudeApi.service,
    checkClaudeApiCap: (reason) => checks.push(reason),
    claudeApiStopLedger: { clearAll: () => cleared.push('all') },
  });
  assert.equal((await post(app, { monthlyCapUsd: 'lots' })).statusCode, 400);
  assert.deepEqual(checks, []);
  assert.equal((await post(app, { monthlyCapUsd: '5' })).statusCode, 200);
  assert.deepEqual(checks, ['settings']);
  // A saved setting ends every chat's stop-note episode.
  assert.deepEqual(cleared, ['all']);
});
