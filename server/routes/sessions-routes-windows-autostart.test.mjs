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

function registerAutostartRoutes(windowsAutostartService, windowsBootAutostartService) {
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
    windowsBootAutostartService,
  });
  return { app, auth };
}

/** A boot service double whose task state the test scripts directly. */
function createBootServiceDouble({ taskStatus = 'missing', legacyTaskPresent = false } = {}) {
  const calls = [];
  const state = {
    supported: true,
    platform: 'win32',
    taskStatus,
    taskName: 'oar-relay',
    legacyTaskPresent,
    launcherPath: null,
    pendingElevation: null,
    lastError: null,
    manualCommand: 'schtasks /create /tn "oar-relay" /xml "C:\\Users\\dev\\task.xml" /f',
  };
  return {
    calls,
    state,
    getState: async () => ({ ...state }),
    requestEnable: async () => {
      calls.push('enable');
      state.pendingElevation = 'enable';
      return { ...state, accepted: true };
    },
    requestDisable: async () => {
      calls.push('disable');
      state.taskStatus = 'missing';
      state.legacyTaskPresent = false;
      return { ...state, accepted: true };
    },
  };
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

function createSigninServiceDouble({ enabled = false, supported = true } = {}) {
  const platform = supported ? 'win32' : 'linux';
  const calls = [];
  let isEnabled = enabled;
  return {
    calls,
    getState: () => ({ supported, enabled: isEnabled, platform }),
    setEnabled: (next) => {
      calls.push(next);
      isEnabled = next;
      return { supported, enabled: isEnabled, platform, changed: true };
    },
  };
}

test('Windows autostart settings routes are authenticated and merge both services into a mode', async () => {
  const signin = createSigninServiceDouble();
  const boot = createBootServiceDouble();
  const { app, auth } = registerAutostartRoutes(signin, boot);
  const getHandlers = app.routes.get('GET /api/settings/windows-autostart');
  const postHandlers = app.routes.get('POST /api/settings/windows-autostart');
  assert.equal(getHandlers[0], auth);
  assert.equal(postHandlers[0], auth);

  const getResponse = await callRoute(getHandlers);
  assert.equal(getResponse.statusCode, 200);
  assert.equal(getResponse.body.mode, 'off');
  assert.equal(getResponse.body.enabled, false);
  assert.equal(getResponse.body.boot.taskStatus, 'missing');

  // Back-compat: the pre-mode boolean POST still lands on sign-in mode.
  const postResponse = await callRoute(postHandlers, { body: { enabled: true } });
  assert.equal(postResponse.statusCode, 200);
  assert.equal(postResponse.body.mode, 'signin');
  assert.equal(postResponse.body.enabled, true);
  assert.deepEqual(signin.calls, [true]);
  assert.deepEqual(boot.calls, [], 'no elevation for a sign-in toggle with no boot task');
});

test('a ready boot task defines the mode even with a leftover Startup entry present', async () => {
  const signin = createSigninServiceDouble({ enabled: true });
  const boot = createBootServiceDouble({ taskStatus: 'ready' });
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  assert.equal(response.body.mode, 'boot');
  assert.equal(response.body.signinEnabled, true, 'the leftover .cmd is reported, not hidden');
});

test('selecting boot mode requests the elevated enable and reports pending', async () => {
  const signin = createSigninServiceDouble({ enabled: true });
  const boot = createBootServiceDouble();
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'boot' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(boot.calls, ['enable']);
  assert.equal(response.body.accepted, true);
  assert.equal(response.body.boot.pendingElevation, 'enable');
  assert.deepEqual(signin.calls, [], 'the .cmd survives until the UAC is actually confirmed');
});

test('leaving boot mode sweeps the task first, then applies the sign-in half', async () => {
  const signin = createSigninServiceDouble();
  const boot = createBootServiceDouble({ taskStatus: 'ready' });
  const { app } = registerAutostartRoutes(signin, boot);
  const response = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'signin' } });
  assert.deepEqual(boot.calls, ['disable']);
  assert.deepEqual(signin.calls, [true]);
  assert.equal(response.body.accepted, true);
});

test('a foreign task under our name is never deleted by picking sign-in mode', async () => {
  const signin = createSigninServiceDouble();
  const boot = createBootServiceDouble({ taskStatus: 'foreign' });
  const { app } = registerAutostartRoutes(signin, boot);
  await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'signin' } });
  assert.deepEqual(boot.calls, [], 'foreign tasks are replaced only through an explicit boot enable');
  assert.deepEqual(signin.calls, [true]);
});

test('a lingering legacy task is swept even when switching to off', async () => {
  const signin = createSigninServiceDouble({ enabled: true });
  const boot = createBootServiceDouble({ taskStatus: 'missing', legacyTaskPresent: true });
  const { app } = registerAutostartRoutes(signin, boot);
  await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'off' } });
  assert.deepEqual(boot.calls, ['disable']);
  assert.deepEqual(signin.calls, [false]);
});

test('Windows autostart update rejects malformed and unsupported requests', async () => {
  const unsupported = createSigninServiceDouble({ supported: false });
  const { app } = registerAutostartRoutes(unsupported, createBootServiceDouble());
  const handlers = app.routes.get('POST /api/settings/windows-autostart');

  const malformedResponse = await callRoute(handlers, { body: { enabled: 'true' } });
  assert.equal(malformedResponse.statusCode, 400);
  assert.match(malformedResponse.body.error, /mode must be/);

  const badModeResponse = await callRoute(handlers, { body: { mode: 'reboot' } });
  assert.equal(badModeResponse.statusCode, 400);

  const unsupportedResponse = await callRoute(handlers, { body: { enabled: true } });
  assert.equal(unsupportedResponse.statusCode, 400);
  assert.deepEqual(unsupportedResponse.body, {
    error: 'Windows autostart is only available on Windows',
  });
  assert.deepEqual(unsupported.calls, []);
});

test('the routes work without a boot service (boot reported as null)', async () => {
  const signin = createSigninServiceDouble({ enabled: true });
  const { app } = registerAutostartRoutes(signin, undefined);
  const getResponse = await callRoute(app.routes.get('GET /api/settings/windows-autostart'));
  assert.equal(getResponse.body.mode, 'signin');
  assert.equal(getResponse.body.boot, null);
  const postResponse = await callRoute(app.routes.get('POST /api/settings/windows-autostart'), { body: { mode: 'off' } });
  assert.equal(postResponse.statusCode, 200);
  assert.equal(postResponse.body.mode, 'off');
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
