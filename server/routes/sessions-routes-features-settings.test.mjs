import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionWorkerStatusPayload, registerSessionsRoutes } from './sessions-routes.mjs';

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

function sampleFlagState({ restartRequired = false } = {}) {
  return [{
    name: 'IMAGE_CONVERSATION_CONTINUITY_ENABLED',
    label: 'Generated-image continuity',
    description: 'Track the lineage of generated images.',
    default: true,
    noop: false,
    active: true,
    stored: restartRequired ? false : null,
    envOverride: null,
    effectiveNext: !restartRequired,
    restartRequired,
  }];
}

function registerFeaturesRoutes({ getFeatureFlagsSettingsState, setFeatureFlagSetting } = {}) {
  const app = createMockApp();
  const auth = (_req, _res, next) => next();
  registerSessionsRoutes(app, {
    auth,
    io: { emit() {} },
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
    getModelCatalogState: () => ({}),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
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
    getFeatureFlagsSettingsState,
    setFeatureFlagSetting,
  });
  return { app, auth };
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
    await handler(req, response, () => {
      nextCalled = true;
    });
    if (!nextCalled) break;
  }
  return response;
}

test('GET /api/settings/features is authenticated and reports flags plus restart state', async () => {
  const { app, auth } = registerFeaturesRoutes({
    getFeatureFlagsSettingsState: () => sampleFlagState({ restartRequired: true }),
  });
  const handlers = app.routes.get('GET /api/settings/features');
  assert.equal(handlers[0], auth);

  const response = await callRoute(handlers);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.flags.length, 1);
  assert.equal(response.body.flags[0].name, 'IMAGE_CONVERSATION_CONTINUITY_ENABLED');
  assert.equal(response.body.flags[0].description.length > 0, true);
  assert.equal(response.body.restartRequired, true);
});

test('restartRequired is false when every flag matches the running snapshot', async () => {
  const { app } = registerFeaturesRoutes({
    getFeatureFlagsSettingsState: () => sampleFlagState({ restartRequired: false }),
  });
  const response = await callRoute(app.routes.get('GET /api/settings/features'));
  assert.equal(response.body.restartRequired, false);
});

test('POST /api/settings/features persists the flag and returns the refreshed payload', async () => {
  const writes = [];
  const { app } = registerFeaturesRoutes({
    getFeatureFlagsSettingsState: () => sampleFlagState({ restartRequired: true }),
    setFeatureFlagSetting: (name, enabled) => {
      writes.push([name, enabled]);
      return { ok: true };
    },
  });
  const response = await callRoute(app.routes.get('POST /api/settings/features'), {
    body: { name: 'IMAGE_CONVERSATION_CONTINUITY_ENABLED', enabled: false },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(writes, [['IMAGE_CONVERSATION_CONTINUITY_ENABLED', false]]);
  assert.equal(response.body.restartRequired, true, 'the response repaints from the same payload as GET');
});

test('POST /api/settings/features rejects malformed and unknown requests', async () => {
  const writes = [];
  const { app } = registerFeaturesRoutes({
    getFeatureFlagsSettingsState: () => sampleFlagState(),
    setFeatureFlagSetting: (name, enabled) => {
      writes.push([name, enabled]);
      return { ok: false, error: 'Unknown feature flag' };
    },
  });
  const handlers = app.routes.get('POST /api/settings/features');

  const missingName = await callRoute(handlers, { body: { enabled: true } });
  assert.equal(missingName.statusCode, 400);
  assert.match(missingName.body.error, /name is required/);

  const stringEnabled = await callRoute(handlers, { body: { name: 'X', enabled: 'true' } });
  assert.equal(stringEnabled.statusCode, 400);
  assert.match(stringEnabled.body.error, /must be a boolean/);
  assert.deepEqual(writes, [], 'nothing is written before validation passes');

  const unknown = await callRoute(handlers, { body: { name: 'NOT_A_FLAG', enabled: true } });
  assert.equal(unknown.statusCode, 400);
  assert.match(unknown.body.error, /Unknown feature flag/);
});

test('a persist failure surfaces as a 500, not a silent success', async () => {
  const { app } = registerFeaturesRoutes({
    getFeatureFlagsSettingsState: () => sampleFlagState(),
    setFeatureFlagSetting: () => ({ ok: false, error: 'Feature settings are unavailable' }),
  });
  const response = await callRoute(app.routes.get('POST /api/settings/features'), {
    body: { name: 'IMAGE_CONVERSATION_CONTINUITY_ENABLED', enabled: true },
  });
  assert.equal(response.statusCode, 500);
});

test('the session-worker status payload reports the real fallback-restart flag', () => {
  assert.equal(buildSessionWorkerStatusPayload({
    featureFlags: { SESSION_WORKER_FALLBACK_RESTART_ENABLED: true },
  }).fallbackRestartEnabled, true);
  assert.equal(buildSessionWorkerStatusPayload({
    featureFlags: {},
  }).fallbackRestartEnabled, false);
});
