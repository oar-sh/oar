import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';

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

function registerAutostartRoutes(windowsAutostartService) {
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
    windowsAutostartService,
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

test('Windows autostart settings routes are authenticated and return current state', async () => {
  const service = {
    getState: () => ({ supported: true, enabled: false, platform: 'win32' }),
    setEnabled: (enabled) => ({
      supported: true,
      enabled,
      platform: 'win32',
      changed: true,
    }),
  };
  const { app, auth } = registerAutostartRoutes(service);
  const getHandlers = app.routes.get('GET /api/settings/windows-autostart');
  const postHandlers = app.routes.get('POST /api/settings/windows-autostart');
  assert.equal(getHandlers[0], auth);
  assert.equal(postHandlers[0], auth);

  const getResponse = await callRoute(getHandlers);
  assert.equal(getResponse.statusCode, 200);
  assert.deepEqual(getResponse.body, {
    supported: true,
    enabled: false,
    platform: 'win32',
  });

  const postResponse = await callRoute(postHandlers, { body: { enabled: true } });
  assert.equal(postResponse.statusCode, 200);
  assert.deepEqual(postResponse.body, {
    supported: true,
    enabled: true,
    platform: 'win32',
    changed: true,
  });
});

test('Windows autostart update rejects malformed and unsupported requests', async () => {
  let mutationCount = 0;
  const service = {
    getState: () => ({ supported: false, enabled: false, platform: 'linux' }),
    setEnabled() {
      mutationCount += 1;
      return {};
    },
  };
  const { app } = registerAutostartRoutes(service);
  const handlers = app.routes.get('POST /api/settings/windows-autostart');

  const malformedResponse = await callRoute(handlers, { body: { enabled: 'true' } });
  assert.equal(malformedResponse.statusCode, 400);
  assert.deepEqual(malformedResponse.body, { error: 'enabled must be a boolean' });

  const unsupportedResponse = await callRoute(handlers, { body: { enabled: true } });
  assert.equal(unsupportedResponse.statusCode, 400);
  assert.deepEqual(unsupportedResponse.body, {
    error: 'Windows autostart is only available on Windows',
  });
  assert.equal(mutationCount, 0);
});

test('Windows autostart routes do not expose filesystem error details', async () => {
  const service = {
    getState() {
      throw new Error('EACCES: C:\\Users\\secret\\Startup');
    },
    setEnabled() {
      throw new Error('unused');
    },
  };
  const { app } = registerAutostartRoutes(service);
  const response = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.includes('secret'), false);
  assert.match(response.body.error, /Startup folder/);
});
