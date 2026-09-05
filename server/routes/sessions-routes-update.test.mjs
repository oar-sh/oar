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

function baseDeps(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function registerUpdateRoutes(overrides = {}) {
  const app = createMockApp();
  const auth = (_req, _res, next) => next();
  registerSessionsRoutes(app, { auth, ...baseDeps(overrides) });
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

function checkServiceDouble() {
  const calls = [];
  return {
    calls,
    setAutoCheck: (enabled) => { calls.push(['auto', enabled]); return { ok: true }; },
    checkNow: async () => { calls.push(['check']); return {}; },
    dismissVersion: (version) => {
      calls.push(['dismiss', version]);
      return version === '0.9.9' ? { ok: true } : { ok: false, error: 'Version mismatch' };
    },
    getSnapshot: () => ({ available: true, version: '0.9.9' }),
  };
}

test('update routes are auth-guarded and ride one payload builder', async () => {
  const payload = { runningVersion: '0.9.1', check: { available: false }, install: { state: 'idle' } };
  const { app, auth } = registerUpdateRoutes({
    updateCheckService: checkServiceDouble(),
    updateInstallService: { startUpdate: async () => ({ ok: true, targetVersion: 'x' }), clearOutcome: () => ({ ok: true }) },
    buildUpdateStatePayload: () => payload,
    runningVersion: '0.9.1',
  });
  for (const key of ['GET /api/update/state', 'POST /api/update/auto-check', 'POST /api/update/check', 'POST /api/update/dismiss', 'POST /api/update/apply']) {
    assert.equal(app.routes.get(key)?.[0], auth, `${key} is authenticated`);
  }
  const state = await callRoute(app.routes.get('GET /api/update/state'));
  assert.deepEqual(state.body, { ok: true, update: payload });
});

test('auto-check toggles validate input and forward to the service', async () => {
  const service = checkServiceDouble();
  const { app } = registerUpdateRoutes({ updateCheckService: service, buildUpdateStatePayload: () => ({}) });
  const handlers = app.routes.get('POST /api/update/auto-check');

  const bad = await callRoute(handlers, { body: { enabled: 'yes' } });
  assert.equal(bad.statusCode, 400);

  const ok = await callRoute(handlers, { body: { enabled: true } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(service.calls, [['auto', true]]);
});

test('every check-service route is 503 when the kill switch removed the service', async () => {
  const { app } = registerUpdateRoutes({ updateCheckService: null, buildUpdateStatePayload: () => ({}) });
  for (const [key, req] of [
    ['POST /api/update/auto-check', { body: { enabled: true } }],
    ['POST /api/update/check', {}],
    ['POST /api/update/dismiss', { body: { version: 'x' } }],
  ]) {
    const response = await callRoute(app.routes.get(key), req);
    assert.equal(response.statusCode, 503, `${key} without a check service`);
    assert.match(response.body.error, /OAR_NO_UPDATE_CHECK/);
  }
});

test('dismiss handles versions, mismatches, and outcome clearing', async () => {
  const service = checkServiceDouble();
  const cleared = [];
  const { app } = registerUpdateRoutes({
    updateCheckService: service,
    updateInstallService: { clearOutcome: () => { cleared.push(1); return { ok: true }; } },
    buildUpdateStatePayload: () => ({}),
  });
  const handlers = app.routes.get('POST /api/update/dismiss');

  const ok = await callRoute(handlers, { body: { version: '0.9.9' } });
  assert.equal(ok.statusCode, 200);

  const mismatch = await callRoute(handlers, { body: { version: '0.1.0' } });
  assert.equal(mismatch.statusCode, 400);

  const outcome = await callRoute(handlers, { body: { outcome: true } });
  assert.equal(outcome.statusCode, 200);
  assert.equal(cleared.length, 1);
});

test('cancel reaches the install service and returns the refreshed payload', async () => {
  const cancels = [];
  const { app } = registerUpdateRoutes({
    updateInstallService: { cancel: () => { cancels.push(1); return { ok: true }; } },
    buildUpdateStatePayload: () => ({}),
  });
  const response = await callRoute(app.routes.get('POST /api/update/cancel'));
  assert.equal(response.statusCode, 200);
  assert.equal(cancels.length, 1);
});

test('apply forwards service errors with their status codes', async () => {
  const { app } = registerUpdateRoutes({
    updateInstallService: {
      startUpdate: async ({ version }) => (version === '0.9.9'
        ? { ok: true, targetVersion: version }
        : { ok: false, statusCode: 400, error: 'This relay runs from a git checkout — pull to update' }),
    },
    buildUpdateStatePayload: () => ({}),
  });
  const handlers = app.routes.get('POST /api/update/apply');

  const ok = await callRoute(handlers, { body: { version: '0.9.9' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.targetVersion, '0.9.9');

  const refused = await callRoute(handlers, { body: { version: 'bad' } });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.body.error, /git checkout/);
});
