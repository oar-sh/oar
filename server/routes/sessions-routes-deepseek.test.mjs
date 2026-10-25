import test from 'node:test';
import assert from 'node:assert/strict';

import { buildModelCatalogWithDeepSeekProvider, registerSessionsRoutes } from './sessions-routes.mjs';
import { createDeepSeekSettingsService } from '../services/deepseek-settings-service.mjs';
import { createPlanUsageService } from '../services/plan-usage-service.mjs';
import Database from 'better-sqlite3';

const TEST_KEY = 'sk-test-3333333333333333';

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
  deepseekSettingsService = null,
  planUsageService = null,
  deepseekBalanceService = null,
  emitted = [],
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
    io: { emit(event, payload) { emitted.push({ event, payload }); } },
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
    deepseekSettingsService,
    planUsageService,
    deepseekBalanceService,
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


function createDeepSeekService({ initial = {}, ids = ['deepseek-flash', 'deepseek-v4-pro'], candidates = [], now = () => new Date() } = {}) {
  const values = new Map(Object.entries(initial));
  const fetchCalls = [];
  const service = createDeepSeekSettingsService({
    readSetting: (key) => values.get(key) ?? '',
    writeSetting: (key, value) => { values.set(key, String(value)); },
    deleteSetting: (key) => { values.delete(key); },
    listProviderCandidates: () => candidates,
    now,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }), text: async () => '' };
    },
  });
  return { service, values, fetchCalls };
}

function route(app, method, path) {
  const handlers = app.routes.get(`${method} ${path}`);
  assert.ok(handlers, `${method} ${path} should be registered`);
  return handlers;
}

const base = {
  models: ['gpt-5.4-mini', 'auto'],
  reasoningByModel: {},
  reasoningByProvider: {},
  modelMetadataByModel: {},
  providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
};

test('the DeepSeek catalog layer is a no-op while the provider is off', () => {
  const result = buildModelCatalogWithDeepSeekProvider(base, { enabled: false, model: 'deepseek-flash', models: ['deepseek-flash'] });
  assert.deepEqual(result.models, base.models);
  assert.equal(result.reasoningByProvider?.deepseek, undefined);
});

test('the DeepSeek catalog layer adds its models, its tag and its three efforts', () => {
  const result = buildModelCatalogWithDeepSeekProvider(base, {
    enabled: true,
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-flash'],
  });
  assert.deepEqual(result.models, ['gpt-5.4-mini', 'auto', 'deepseek-flash', 'deepseek-v4-pro']);
  assert.deepEqual(result.providersByModel['deepseek-flash'], ['deepseek']);
  assert.equal(result.modelMetadataByModel['deepseek-v4-pro'].provider, 'deepseek');
  assert.deepEqual(result.reasoningByProvider.deepseek['deepseek-v4-pro'], ['low', 'high', 'max']);
  // Copilot's own entries are left alone.
  assert.deepEqual(result.providersByModel['gpt-5.4-mini'], ['github-copilot']);
});

test('the settings routes answer 501 without the service', async () => {
  const { app } = createBootstrapHarness();
  assert.equal((await callRoute(route(app, 'GET', '/api/settings/deepseek'), {})).statusCode, 501);
  assert.equal((await callRoute(route(app, 'POST', '/api/settings/deepseek'), { body: { apiKey: TEST_KEY } })).statusCode, 501);
});

test('saving a key discovers the models, announces the change and never answers the key', async () => {
  const deepseek = createDeepSeekService();
  const emitted = [];
  const { app } = createBootstrapHarness({ deepseekSettingsService: deepseek.service, emitted });
  const saved = await callRoute(route(app, 'POST', '/api/settings/deepseek'), { body: { apiKey: TEST_KEY } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.configured, true);
  assert.equal(saved.body.enabled, true);
  assert.equal(saved.body.warning, null);
  assert.deepEqual(saved.body.availableModels, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(deepseek.fetchCalls.length, 1);
  assert.equal(deepseek.fetchCalls[0].url, 'https://api.deepseek.com/models');
  assert.equal(JSON.stringify(saved.body).includes(TEST_KEY), false);
  const events = emitted.map((entry) => entry.event);
  assert.ok(events.includes('deepseek_settings_updated'));
  assert.ok(events.includes('models_updated'));
  assert.equal(JSON.stringify(emitted).includes(TEST_KEY), false);
  const catalog = emitted.find((entry) => entry.event === 'models_updated').payload;
  assert.deepEqual(catalog.providersByModel['deepseek-flash'], ['deepseek']);

  const read = await callRoute(route(app, 'GET', '/api/settings/deepseek'), {});
  assert.equal(read.body.configured, true);
  assert.equal(JSON.stringify(read.body).includes(TEST_KEY), false);
});

test('a refused base URL or model is a 400 and stores nothing', async () => {
  const deepseek = createDeepSeekService();
  const { app } = createBootstrapHarness({ deepseekSettingsService: deepseek.service });
  for (const body of [{ baseUrl: 'http://api.example.com' }, { model: 'gpt-5.5' }, { attribution: 'vanilla' }, {}]) {
    const response = await callRoute(route(app, 'POST', '/api/settings/deepseek'), { body });
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(deepseek.values.size, 0);
});

test('removing the key is refused with 409 while DeepSeek conversations exist', async () => {
  const deepseek = createDeepSeekService({
    initial: { deepseek_api_key: TEST_KEY },
    candidates: [{ provider_type: 'deepseek', message_count: 3, active_queue_count: 0 }],
  });
  const { app } = createBootstrapHarness({ deepseekSettingsService: deepseek.service });
  const response = await callRoute(route(app, 'POST', '/api/settings/deepseek'), { body: { remove: true } });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'deepseek-key-removal-blocked');
  assert.equal(response.body.activeConversationCount, 1);
  assert.equal(deepseek.values.get('deepseek_api_key'), TEST_KEY);
});

test('bootstrap refuses DeepSeek without a key or while it is switched off', async () => {
  const none = createDeepSeekService();
  const { app, bindingCalls } = createBootstrapHarness({ deepseekSettingsService: none.service });
  const response = await callBootstrap(app, { providerType: 'deepseek' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'DEEPSEEK_NOT_CONFIGURED');
  assert.equal(response.body.error, 'DeepSeek API key is not configured');

  const off = createDeepSeekService({ initial: { deepseek_api_key: TEST_KEY, deepseek_enabled: 'false' } });
  const offHarness = createBootstrapHarness({ deepseekSettingsService: off.service });
  const offResponse = await callBootstrap(offHarness.app, { providerType: 'deepseek' });
  assert.equal(offResponse.statusCode, 400);
  assert.equal(offResponse.body.code, 'DEEPSEEK_NOT_CONFIGURED');
  assert.match(offResponse.body.error, /switched off/);
  assert.equal(bindingCalls.length + offHarness.bindingCalls.length, 0);
});

test('bootstrap binds a DeepSeek conversation on the default model at high effort', async () => {
  const deepseek = createDeepSeekService({ initial: { deepseek_api_key: TEST_KEY } });
  const { app, bindingCalls } = createBootstrapHarness({ deepseekSettingsService: deepseek.service });
  const response = await callBootstrap(app, { providerType: 'deepseek' });
  assert.equal(response.statusCode, 200);
  assert.equal(bindingCalls.length, 1);
  assert.equal(bindingCalls[0].model, 'deepseek-flash');
  assert.equal(bindingCalls[0].options.providerType, 'deepseek');
  assert.equal(bindingCalls[0].options.providerModel, 'deepseek-flash');
  assert.equal(response.body.preferredReasoningEffort, 'high');
});

test('bootstrap takes a DeepSeek model by its id, maps the effort and refuses an unknown one', async () => {
  const deepseek = createDeepSeekService({ initial: { deepseek_api_key: TEST_KEY } });
  const byId = createBootstrapHarness({ deepseekSettingsService: deepseek.service });
  const response = await callBootstrap(byId.app, { model: 'deepseek-v4-pro', reasoningEffort: 'medium' });
  assert.equal(response.statusCode, 200);
  assert.equal(byId.bindingCalls[0].options.providerType, 'deepseek');
  assert.equal(byId.bindingCalls[0].model, 'deepseek-v4-pro');
  // DeepSeek runs "medium" as high.
  assert.equal(response.body.preferredReasoningEffort, 'high');

  const unknown = createBootstrapHarness({ deepseekSettingsService: deepseek.service });
  const refused = await callBootstrap(unknown.app, { providerType: 'deepseek', model: 'deepseek-ghost' });
  assert.equal(refused.statusCode, 400);
  assert.equal(refused.body.code, 'DEEPSEEK_MODEL_UNAVAILABLE');
  assert.equal(refused.body.error, 'DeepSeek model "deepseek-ghost" is not available');
  assert.deepEqual(refused.body.supportedModels, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(unknown.bindingCalls.length, 0);
});

test('model variants list the DeepSeek models while the provider is on', async () => {
  const deepseek = createDeepSeekService({ initial: { deepseek_api_key: TEST_KEY } });
  const { app } = createBootstrapHarness({ deepseekSettingsService: deepseek.service });
  const response = await callRoute(route(app, 'GET', '/api/model-variants'), { headers: {} });
  assert.deepEqual(response.body.deepseekModels, {
    defaultModel: 'deepseek-flash',
    availableModels: ['deepseek-flash', 'deepseek-v4-pro'],
    enabledModels: ['deepseek-flash', 'deepseek-v4-pro'],
  });
});

test('the tab judges the starting balance on the balance\'s main currency, as the card\'s bar does', async () => {
  const deepseek = createDeepSeekService({
    initial: { deepseek_api_key: TEST_KEY, deepseek_starting_balance: '50', deepseek_starting_balance_set_at: '2026-10-25T08:00:00.000Z' },
  });
  // USD rose after it was set; CNY, the main balance, did not.
  const references = [
    { currency: 'CNY', referenceTotal: 45.91, lastTotal: 45.91, referenceAt: '2026-10-25T09:00:00.000Z', roseAt: null, roseFromAt: null },
    { currency: 'USD', referenceTotal: 20, lastTotal: 20, referenceAt: '2026-11-02T09:00:00.000Z', roseAt: '2026-11-02T09:00:00.000Z', roseFromAt: '2026-11-01T09:00:00.000Z' },
  ];
  let balances = [{ currency: 'CNY', total: 45.91 }, { currency: 'USD', total: 20 }];
  const { app } = createBootstrapHarness({
    deepseekSettingsService: deepseek.service,
    planUsageService: { readDeepSeekBalanceReferences: () => references },
    deepseekBalanceService: { peekBalance: () => ({ ok: true, balances }) },
  });
  assert.equal((await callRoute(route(app, 'GET', '/api/settings/deepseek'), {})).body.startingBalanceNote, null);
  // With nothing on CNY, USD is the main balance, and its rise counts.
  balances = [{ currency: 'CNY', total: 0 }, { currency: 'USD', total: 20 }];
  assert.match((await callRoute(route(app, 'GET', '/api/settings/deepseek'), {})).body.startingBalanceNote, /^No longer used: the balance rose on 2026-11-02/);
});

test('the tab hears when a top-up since the starting balance was set has replaced it; the same amount saved again applies again only when typed in', async () => {
  let clock = new Date('2026-11-03T08:00:00.000Z');
  const deepseek = createDeepSeekService({
    initial: { deepseek_api_key: TEST_KEY, deepseek_starting_balance: '50', deepseek_starting_balance_set_at: '2026-10-25T08:00:00.000Z' },
    now: () => clock,
  });
  let references = [{ currency: 'CNY', referenceTotal: 45.91, lastTotal: 45.91, referenceAt: '2026-10-25T09:00:00.000Z', roseAt: null }];
  const { app } = createBootstrapHarness({
    deepseekSettingsService: deepseek.service,
    planUsageService: { readDeepSeekBalanceReferences: () => references },
  });
  const before = await callRoute(route(app, 'GET', '/api/settings/deepseek'), {});
  assert.deepEqual([before.body.startingBalance, before.body.startingBalanceNote], [50, null]);
  references = [{ currency: 'CNY', referenceTotal: 140, lastTotal: 140, referenceAt: '2026-11-02T09:00:00.000Z', roseAt: '2026-11-02T09:00:00.000Z', roseFromAt: '2026-11-01T09:00:00.000Z' }];
  const after = await callRoute(route(app, 'GET', '/api/settings/deepseek'), {});
  assert.equal(after.body.startingBalance, 50);
  assert.match(after.body.startingBalanceNote, /^No longer used: the balance rose on 2026-11-02 \(a top-up\)/);
  // A Save of the budget from a tab that still shows ¥50 (opened before the
  // top-up was seen, or not typed in): it stays replaced.
  const stale = await callRoute(route(app, 'POST', '/api/settings/deepseek'), { body: { startingBalance: 50, startingBalanceEdited: false, monthlyBudget: 25 } });
  assert.deepEqual([stale.statusCode, stale.body.startingBalanceSetAt, stale.body.monthlyBudget], [200, '2026-10-25T08:00:00.000Z', 25]);
  assert.match(stale.body.startingBalanceNote, /^No longer used/);
  // ¥50 typed in again: set anew, it applies.
  const armed = await callRoute(route(app, 'POST', '/api/settings/deepseek'), { body: { startingBalance: 50, startingBalanceEdited: true } });
  assert.deepEqual(
    [armed.statusCode, armed.body.startingBalance, armed.body.startingBalanceSetAt, armed.body.startingBalanceNote],
    [200, 50, '2026-11-03T08:00:00.000Z', null],
  );
  // Saved again while it applies, it keeps that time.
  clock = new Date('2026-11-04T08:00:00.000Z');
  const again = await callRoute(route(app, 'POST', '/api/settings/deepseek'), { body: { startingBalance: 50, startingBalanceEdited: true } });
  assert.deepEqual([again.body.startingBalanceSetAt, again.body.startingBalanceNote], ['2026-11-03T08:00:00.000Z', null]);
});

test('saving a starting balance reads the balance right then: a top-up made just before it stays in it, the next one replaces it', async () => {
  let clock = new Date('2026-11-01T10:00:00.000Z');
  const deepseek = createDeepSeekService({ initial: { deepseek_api_key: TEST_KEY }, now: () => clock });
  const planUsage = createPlanUsageService({ db: new Database(':memory:'), now: () => clock });
  const read = (total, fetchedAt) => ({ ok: true, isAvailable: true, balances: [{ currency: 'CNY', total }], fetchedAt });
  let next = read(55, '2026-11-01T10:00:01.000Z');
  let last = null;
  const reads = [];
  const { app } = createBootstrapHarness({
    deepseekSettingsService: deepseek.service,
    planUsageService: planUsage,
    deepseekBalanceService: {
      getBalance: async (options) => {
        reads.push(options);
        if (next.ok) last = next;
        return next;
      },
      peekBalance: () => last,
    },
  });
  const save = async (body) => callRoute(route(app, 'POST', '/api/settings/deepseek'), { body });
  const note = async () => (await callRoute(route(app, 'GET', '/api/settings/deepseek'), {})).body.startingBalanceNote;
  // ¥5 left at the last read; the owner tops up ¥50 and enters ¥50.
  planUsage.recordDeepSeekBalance(read(5, '2026-11-01T09:00:00.000Z'));
  const saved = await save({ startingBalance: 50 });
  assert.deepEqual([saved.statusCode, saved.body.startingBalanceSetAt, saved.body.startingBalanceNote], [200, '2026-11-01T10:00:00.000Z', null]);
  assert.deepEqual(reads, [{ force: true }]);
  const [reference] = planUsage.readDeepSeekBalanceReferences();
  assert.deepEqual([reference.lastTotal, reference.roseAt, reference.roseFromAt], [55, '2026-11-01T10:00:01.000Z', '2026-11-01T09:00:00.000Z']);
  // The next poll: still ¥55 (above ¥50), still the starting balance.
  planUsage.recordDeepSeekBalance(read(55, '2026-11-01T11:00:00.000Z'));
  assert.equal(await note(), null);
  // Saved again unchanged, or with another field: no read.
  await save({ startingBalance: 50, attribution: 'off' });
  assert.equal(reads.length, 1);
  // The next top-up replaces it.
  planUsage.recordDeepSeekBalance(read(52, '2026-11-02T09:00:00.000Z'));
  planUsage.recordDeepSeekBalance(read(102, '2026-11-03T09:00:00.000Z'));
  assert.match(await note(), /^No longer used: the balance rose on 2026-11-03/);
});

test('a failed balance read at the save keeps the starting balance saved; the setting waits for a read after it', async () => {
  const clock = new Date('2026-11-01T10:00:00.000Z');
  const deepseek = createDeepSeekService({ initial: { deepseek_api_key: TEST_KEY }, now: () => clock });
  const planUsage = createPlanUsageService({ db: new Database(':memory:'), now: () => clock });
  const read = (total, fetchedAt) => ({ ok: true, isAvailable: true, balances: [{ currency: 'CNY', total }], fetchedAt });
  const { app } = createBootstrapHarness({
    deepseekSettingsService: deepseek.service,
    planUsageService: planUsage,
    deepseekBalanceService: {
      getBalance: async () => ({ ok: false, code: 'error', error: 'DeepSeek balance check failed (500)', fetchedAt: '2026-11-01T10:00:01.000Z' }),
      peekBalance: () => null,
    },
  });
  planUsage.recordDeepSeekBalance(read(5, '2026-11-01T09:00:00.000Z'));
  const saved = await callRoute(route(app, 'POST', '/api/settings/deepseek'), { body: { startingBalance: 50 } });
  assert.deepEqual([saved.statusCode, saved.body.startingBalance, saved.body.startingBalanceNote], [200, 50, null]);
  assert.equal(planUsage.readDeepSeekBalanceReferences()[0].lastTotal, 5);
  // The top-up made before the save, first seen by the next poll: it stays.
  planUsage.recordDeepSeekBalance(read(55, '2026-11-01T11:00:00.000Z'));
  const after = await callRoute(route(app, 'GET', '/api/settings/deepseek'), {});
  assert.equal(after.body.startingBalanceNote, null);
  // A throwing balance service does not fail the save either.
  const { app: throwing } = createBootstrapHarness({
    deepseekSettingsService: deepseek.service,
    planUsageService: planUsage,
    deepseekBalanceService: { getBalance: async () => { throw new Error('boom'); } },
  });
  assert.equal((await callRoute(route(throwing, 'POST', '/api/settings/deepseek'), { body: { startingBalance: 60 } })).statusCode, 200);
});
