import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { createModelRefreshLedger, createModelRefreshSettings } from '../services/provider-model-refresh.mjs';

// "Check for new models" and the model map's routes: GET/POST
// /api/model-refresh-settings, POST /api/model-variants/seen, the switch and
// the "New" flags in GET /api/model-variants, the menu dot's count and the
// toast's newModels.

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(routePath, ...handlers) {
      routes.set(`GET ${routePath}`, handlers);
    },
    post(routePath, ...handlers) {
      routes.set(`POST ${routePath}`, handlers);
    },
    patch(routePath, ...handlers) {
      routes.set(`PATCH ${routePath}`, handlers);
    },
    delete(routePath, ...handlers) {
      routes.set(`DELETE ${routePath}`, handlers);
    },
  };
}

function createMockDb() {
  const statement = {
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
      return statement;
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
}

function createSettingsStore() {
  const values = new Map();
  return { values, readSetting: (key) => values.get(key) ?? '', writeSetting: (key, value) => { values.set(key, String(value)); } };
}

/** A relay with Cursor on (one model flagged new) and Copilot's map. */
function createRelay({ cursorRefresh = async () => ({ ok: true, models: ['composer-2.5'], newModels: [] }), extraDeps = {} } = {}) {
  const app = createMockApp();
  const emitted = [];
  const store = createSettingsStore();
  const ledger = createModelRefreshLedger({ ...store, now: () => new Date('2026-11-01T10:00:00Z') });
  const modelRefreshSettings = createModelRefreshSettings(store);
  const copilot = { autoEnableNew: true, unseen: ['gpt-test-new'] };
  const cursor = { unseen: ['composer-3'], autoEnableNew: false };
  const variantCalls = [];
  const cursorSaves = [];
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit: (event, payload) => emitted.push({ event, payload }) },
    db: createMockDb(),
    stmts: {},
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pending: 0, processing: 0 }),
    getModelCatalogState: () => ({ models: ['auto', 'gpt-5.4-mini'], reasoningByModel: {} }),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: (ids, options) => { variantCalls.push(options ? ['set', ids, options] : ['set', ids]); return {}; },
    getCopilotModelState: () => ({ autoEnableNew: copilot.autoEnableNew, unseen: [...copilot.unseen] }),
    setCopilotAutoEnableNew: (value) => { variantCalls.push(['auto', value]); copilot.autoEnableNew = value; },
    markCopilotModelsSeen: () => {
      const had = copilot.unseen.length > 0;
      copilot.unseen = [];
      return had;
    },
    markProviderModelsSeen: (provider) => {
      if (provider !== 'cursor' || !cursor.unseen.length) return false;
      cursor.unseen = [];
      return true;
    },
    getCursorProviderSettings: () => ({
      configured: true,
      enabled: true,
      model: 'composer-2.5',
      models: ['composer-2.5'],
      availableModels: ['composer-2.5', 'composer-3'],
      autoEnableNew: cursor.autoEnableNew,
      fallback: false,
      unseenModels: [...cursor.unseen],
    }),
    setCursorProviderSettings: (parsed) => { cursorSaves.push(parsed); return { ok: true, enabled: true, model: 'composer-2.5' }; },
    refreshCursorProviderModels: ledger.track('cursor', cursorRefresh),
    modelRefreshLedger: ledger,
    modelRefreshSettings,
    SUPPORTED_REASONING_EFFORTS: [],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({}),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: true,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
    touchCli() {},
    markCliOffline() {},
    fetchUsageSummary() {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ ok: true }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'isolated',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['isolated'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'isolated',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: '',
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
    resolveSessionStateRoot: () => null,
    ...extraDeps,
  });
  return { app, emitted, store, ledger, copilot, cursor, variantCalls, cursorSaves };
}

async function callRoute(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `route ${key} is registered`);
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
    await handler({ headers: {}, body: {}, query: {}, ...req }, response, () => {
      nextCalled = true;
    });
    if (!nextCalled) break;
  }
  return response;
}

test('the check settings report the defaults, the choices and each enabled provider', async () => {
  const { app } = createRelay();
  const response = await callRoute(app, 'GET /api/model-refresh-settings');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    auto: true,
    intervalHours: 24,
    intervalChoices: [6, 12, 24, 72, 168],
    default: { auto: true, intervalHours: 24 },
    excluded: [],
    providers: [{ id: 'cursor', label: 'Cursor', setUp: true, last: null }],
    last: {},
  });
});

test('a saved setting is echoed; a bad one is refused and nothing is stored', async () => {
  const { app, store } = createRelay();
  const saved = await callRoute(app, 'POST /api/model-refresh-settings', { body: { auto: false, intervalHours: 72, excluded: ['cursor'] } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.auto, false);
  assert.equal(saved.body.intervalHours, 72);
  assert.deepEqual(saved.body.excluded, ['cursor']);
  const refused = await callRoute(app, 'POST /api/model-refresh-settings', { body: { intervalHours: 5, auto: true } });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.body.error, /intervalHours must be one of/);
  assert.equal(store.values.get('model_refresh_auto'), 'false');
  assert.equal((await callRoute(app, 'POST /api/model-refresh-settings', { body: { excluded: ['nope'] } })).statusCode, 400);
});

test('a refresh by anything shows as the provider\'s last check', async () => {
  const { app } = createRelay();
  await callRoute(app, 'POST /api/model-variants/refresh');
  const response = await callRoute(app, 'GET /api/model-refresh-settings');
  assert.deepEqual(response.body.providers, [{ id: 'cursor', label: 'Cursor', setUp: true, last: { at: '2026-11-01T10:00:00.000Z', ok: true, error: null } }]);
  assert.deepEqual(response.body.last, { cursor: { at: '2026-11-01T10:00:00.000Z', ok: true } });
});

test('the refresh announces the models it found once, with the menu dot\'s count', async () => {
  const { app, emitted } = createRelay({
    cursorRefresh: async () => ({ ok: true, models: ['composer-2.5'], newModels: [{ id: 'composer-3', on: false }] }),
  });
  const response = await callRoute(app, 'POST /api/model-variants/refresh');
  assert.equal(response.body.cursorModelDiscovery.ok, true);
  const update = emitted.find((entry) => entry.event === 'models_updated');
  assert.deepEqual(update.payload.newModels, [{ provider: 'cursor', tab: 'cursor', label: 'Cursor', ids: ['composer-3'], on: false }]);
  assert.equal(update.payload.unseenNewModelCount, 2);
  // The next models_updated does not repeat them.
  await callRoute(app, 'PATCH /api/model-variants', { body: { autoEnableNew: false } });
  assert.equal(emitted.at(-1).payload.newModels, undefined);
});

test('GET /api/model-variants carries each tab\'s switch and New flags; GET /api/models the count', async () => {
  const { app } = createRelay();
  const variants = await callRoute(app, 'GET /api/model-variants');
  assert.deepEqual(variants.body.copilotModelState, { autoEnableNew: true, unseen: ['gpt-test-new'] });
  assert.deepEqual(variants.body.cursorModels, {
    defaultModel: 'composer-2.5',
    availableModels: ['composer-2.5', 'composer-3'],
    enabledModels: ['composer-2.5'],
    autoEnableNew: false,
    unseen: ['composer-3'],
    fallback: false,
  });
  assert.equal(variants.body.openaiModels, null);
  const models = await callRoute(app, 'GET /api/models');
  assert.equal(models.body.unseenNewModelCount, 2);
});

test('opening Select Models clears every New flag and tells the pickers once', async () => {
  const { app, emitted } = createRelay();
  const first = await callRoute(app, 'POST /api/model-variants/seen');
  assert.deepEqual(first.body, { ok: true, unseenNewModelCount: 0 });
  assert.equal(emitted.filter((entry) => entry.event === 'models_updated').length, 1);
  assert.equal(emitted.at(-1).payload.unseenNewModelCount, 0);
  await callRoute(app, 'POST /api/model-variants/seen');
  assert.equal(emitted.filter((entry) => entry.event === 'models_updated').length, 1);
});

test('the Copilot save takes the switch alone and refuses an empty selection', async () => {
  const { app, variantCalls } = createRelay();
  const switched = await callRoute(app, 'PATCH /api/model-variants', { body: { autoEnableNew: false } });
  assert.equal(switched.statusCode, 200);
  assert.deepEqual(variantCalls, [['auto', false]]);
  assert.equal(switched.body.copilotModelState.autoEnableNew, false);
  const empty = await callRoute(app, 'PATCH /api/model-variants', { body: { enabledVariantIds: [] } });
  assert.equal(empty.statusCode, 400);
  assert.equal((await callRoute(app, 'PATCH /api/model-variants', { body: {} })).statusCode, 400);
  assert.equal((await callRoute(app, 'PATCH /api/model-variants', { body: { autoEnableNew: 'no' } })).statusCode, 400);
  await callRoute(app, 'PATCH /api/model-variants', { body: { enabledVariantIds: ['gpt-5.4-mini-none'], autoEnableNew: true } });
  assert.deepEqual(variantCalls.slice(1), [['set', ['gpt-5.4-mini-none']], ['auto', true]]);
});

test('a provider save passes the switch on', async () => {
  const { app, cursorSaves } = createRelay();
  const response = await callRoute(app, 'POST /api/settings/cursor', { body: { autoEnableNew: true } });
  assert.equal(response.statusCode, 200);
  assert.equal(cursorSaves[0].autoEnableNew, true);
});

test('the Copilot save passes the rows the browser drew', async () => {
  const { app, variantCalls } = createRelay();
  await callRoute(app, 'PATCH /api/model-variants', { body: { enabledVariantIds: ['gpt-5.4-mini-none'], shownVariantIds: ['gpt-5.4-mini-none', 'gpt-5.4-none'] } });
  assert.deepEqual(variantCalls, [['set', ['gpt-5.4-mini-none'], { shownVariantIds: ['gpt-5.4-mini-none', 'gpt-5.4-none'] }]]);
});

test('a provider save passes the models the browser drew', async () => {
  const { app, cursorSaves } = createRelay();
  await callRoute(app, 'POST /api/settings/cursor', { body: { enabledModels: ['composer-2.5'], shownModels: ['composer-2.5', 'composer-3'] } });
  assert.deepEqual(cursorSaves[0].shownModels, ['composer-2.5', 'composer-3']);
});

test('a switched-on provider that is not set up is listed as not set up', async () => {
  const { app } = createRelay({ extraDeps: {
    getGrokProviderSettings: () => ({ enabled: true, model: 'grok-4.5', models: ['grok-4.5'], availableModels: ['grok-4.5'] }),
    isGrokModelRefreshSetUp: () => false,
  } });
  const response = await callRoute(app, 'GET /api/model-refresh-settings');
  assert.deepEqual(response.body.providers.map(({ id, setUp }) => [id, setUp]), [['cursor', true], ['grok', false]]);
});
