import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { DEFAULT_TASK_STALL_MINUTES, parseTaskStallMinutesUpdate } from '../../shared/task-output-text.mjs';

// "Mark a background task as quiet after N minutes": GET/POST
// /api/settings/task-stall-minutes (app_settings task_stall_minutes).

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

/** A settings double backed by the real shared parsing, as the relay's own is. */
function createStallStore(initial = DEFAULT_TASK_STALL_MINUTES) {
  let minutes = initial;
  const writes = [];
  return {
    writes,
    getTaskStallMinutes: () => minutes,
    setTaskStallMinutes: (value) => {
      const parsed = parseTaskStallMinutesUpdate(value);
      if (!parsed.ok) return parsed;
      minutes = parsed.minutes;
      writes.push(minutes);
      return { ok: true, minutes };
    },
  };
}

function registerStallRoutes(store) {
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
    getTaskStallMinutes: store.getTaskStallMinutes,
    setTaskStallMinutes: store.setTaskStallMinutes,
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

test('the stall setting routes are authenticated and report the value with its bounds', async () => {
  const { app, auth } = registerStallRoutes(createStallStore());
  const getHandlers = app.routes.get('GET /api/settings/task-stall-minutes');
  const postHandlers = app.routes.get('POST /api/settings/task-stall-minutes');
  assert.equal(getHandlers[0], auth);
  assert.equal(postHandlers[0], auth);
  const response = await callRoute(getHandlers);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { minutes: 10, min: 1, max: 120, default: 10 });
});

test('a value is stored, clamped to 1–120, and echoed', async () => {
  const store = createStallStore();
  const { app } = registerStallRoutes(store);
  const post = app.routes.get('POST /api/settings/task-stall-minutes');
  assert.deepEqual((await callRoute(post, { body: { minutes: 25 } })).body, { minutes: 25, min: 1, max: 120, default: 10 });
  assert.equal((await callRoute(post, { body: { minutes: '500' } })).body.minutes, 120);
  assert.equal((await callRoute(post, { body: { minutes: 0 } })).body.minutes, 1);
  assert.deepEqual(store.writes, [25, 120, 1]);
  assert.equal((await callRoute(app.routes.get('GET /api/settings/task-stall-minutes'))).body.minutes, 1);
});

test('anything but a number is refused and nothing is stored', async () => {
  const store = createStallStore();
  const { app } = registerStallRoutes(store);
  const post = app.routes.get('POST /api/settings/task-stall-minutes');
  for (const minutes of ['', null, 'soon', undefined]) {
    const response = await callRoute(post, { body: { minutes } });
    assert.equal(response.statusCode, 400, String(minutes));
  }
  assert.deepEqual(store.writes, []);
});
