import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { normalizePwaAppName } from '../../shared/pwa-app-name.mjs';

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

/** A settings double backed by the real shared normalization. */
function createPwaAppNameStore(initial = '') {
  let appName = initial;
  return {
    getPwaAppName: () => appName,
    setPwaAppName: (rawValue) => {
      const normalized = normalizePwaAppName(rawValue);
      if (!normalized.ok) return normalized;
      appName = normalized.value;
      return { ok: true, appName };
    },
  };
}

function registerPwaAppNameRoutes(store) {
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
    getPwaAppName: store.getPwaAppName,
    setPwaAppName: store.setPwaAppName,
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

test('PWA app name routes are authenticated and report the default state', async () => {
  const { app, auth } = registerPwaAppNameRoutes(createPwaAppNameStore());
  const getHandlers = app.routes.get('GET /api/settings/pwa-app-name');
  const postHandlers = app.routes.get('POST /api/settings/pwa-app-name');
  assert.equal(getHandlers[0], auth);
  assert.equal(postHandlers[0], auth);

  const response = await callRoute(getHandlers);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    appName: '',
    defaultName: 'OAR',
    shortName: 'OAR',
    maxLength: 60,
  });
});

test('POST normalizes the name and echoes the derived short name', async () => {
  const store = createPwaAppNameStore();
  const { app } = registerPwaAppNameRoutes(store);
  const response = await callRoute(app.routes.get('POST /api/settings/pwa-app-name'), {
    body: { appName: '  My   Dev Relay ' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.appName, 'My Dev Relay');
  assert.equal(response.body.shortName, 'My');
  assert.equal(store.getPwaAppName(), 'My Dev Relay');
});

test('an over-long name is rejected with 400 and nothing is stored', async () => {
  const store = createPwaAppNameStore('Kept');
  const { app } = registerPwaAppNameRoutes(store);
  const response = await callRoute(app.routes.get('POST /api/settings/pwa-app-name'), {
    body: { appName: 'x'.repeat(61) },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /60 characters or fewer/);
  assert.equal(store.getPwaAppName(), 'Kept');
});

test('an empty POST reverts to the default name', async () => {
  const store = createPwaAppNameStore('Custom');
  const { app } = registerPwaAppNameRoutes(store);
  const response = await callRoute(app.routes.get('POST /api/settings/pwa-app-name'), {
    body: { appName: '' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.appName, '');
  assert.equal(response.body.shortName, 'OAR', 'the derived short name falls back to the default');
  assert.equal(store.getPwaAppName(), '');
});

test('a storage failure surfaces as 500', async () => {
  const { app } = registerPwaAppNameRoutes({
    getPwaAppName: () => '',
    setPwaAppName: () => ({ ok: false, status: 500, error: 'App name settings are unavailable' }),
  });
  const response = await callRoute(app.routes.get('POST /api/settings/pwa-app-name'), {
    body: { appName: 'Anything' },
  });
  assert.equal(response.statusCode, 500);
});
