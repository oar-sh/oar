import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { parseRestartResumeUpdate } from '../services/restart-resume-service.mjs';

// "After a relay restart, tell interrupted sessions to carry on": GET/POST
// /api/settings/restart-resume (app_settings restart_resume_notes).

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

/** A settings double backed by the real parsing, as the relay's own is. */
function createSettingStore(initial = false) {
  let enabled = initial;
  const writes = [];
  return {
    writes,
    get: () => enabled,
    set: (value) => {
      const parsed = parseRestartResumeUpdate(value);
      if (!parsed.ok) return parsed;
      enabled = parsed.enabled;
      writes.push(enabled);
      return { ok: true, enabled };
    },
  };
}

function registerRestartRoutes(store) {
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
    getRestartResumeEnabled: store.get,
    setRestartResumeEnabled: store.set,
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

test('the routes are authenticated and the setting is off by default', async () => {
  const { app, auth } = registerRestartRoutes(createSettingStore());
  const getHandlers = app.routes.get('GET /api/settings/restart-resume');
  const postHandlers = app.routes.get('POST /api/settings/restart-resume');
  assert.equal(getHandlers[0], auth);
  assert.equal(postHandlers[0], auth);
  assert.deepEqual((await callRoute(getHandlers)).body, { enabled: false, default: false });
});

test('on and off are stored and echoed; anything else is refused', async () => {
  const store = createSettingStore();
  const { app } = registerRestartRoutes(store);
  const post = app.routes.get('POST /api/settings/restart-resume');
  assert.deepEqual((await callRoute(post, { body: { enabled: true } })).body, { enabled: true, default: false });
  assert.equal((await callRoute(app.routes.get('GET /api/settings/restart-resume'))).body.enabled, true);
  for (const enabled of ['true', 1, null, undefined]) {
    assert.equal((await callRoute(post, { body: { enabled } })).statusCode, 400, String(enabled));
  }
  assert.deepEqual((await callRoute(post, { body: { enabled: false } })).body, { enabled: false, default: false });
  assert.deepEqual(store.writes, [true, false]);
});
