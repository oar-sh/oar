import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';

function createMockApp() {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers);
  };
  return {
    routes,
    get: register('GET'),
    post: register('POST'),
    patch: register('PATCH'),
    delete: register('DELETE'),
  };
}

function createMockDb() {
  const noopStmt = { run() {}, get() { return null; }, all() { return []; } };
  return {
    prepare() { return noopStmt; },
    transaction(fn) { return (...args) => fn(...args); },
  };
}

/**
 * Stand-in for the real service: the state machine itself is covered by
 * grok-auth-service.test.mjs, so these tests only pin the route contract.
 */
function createFakeGrokAuthService({ statusValue, loginState, cachedStatus } = {}) {
  const listeners = [];
  const successHooks = [];
  const calls = [];
  let login = loginState || {
    state: 'idle', authUrl: null, userCode: null, error: null, startedAt: null, active: false,
  };
  const status = statusValue || {
    ok: true,
    loggedIn: true,
    expiresAt: '2099-01-01T00:00:00.000Z',
    expired: false,
    plan: 'GrokBuild',
    usagePercent: 25,
    periodType: 'weekly',
    periodEnd: '2026-08-11T15:53:24.625Z',
    error: null,
    checkedAt: '2026-08-31T00:00:00.000Z',
  };
  return {
    calls,
    setLogin(next) {
      login = next;
      for (const listener of listeners) listener(login);
    },
    async runSuccessHooks() {
      for (const hook of successHooks) await hook();
    },
    async getStatus(options) {
      calls.push(['getStatus', options || null]);
      return status;
    },
    // Never re-reads the auth store: this is what the broadcast path may use.
    getCachedStatus() {
      calls.push(['getCachedStatus']);
      return cachedStatus === undefined ? status : cachedStatus;
    },
    getLoginState: () => login,
    startLogin() {
      calls.push(['startLogin']);
      login = {
        state: 'starting', authUrl: null, userCode: null, error: null, startedAt: '2026-08-31T00:00:00.000Z', active: true,
      };
      return { ok: true, reused: false, login };
    },
    cancel() {
      calls.push(['cancel']);
      login = { state: 'idle', authUrl: null, userCode: null, error: null, startedAt: null, active: false };
      return { ok: true, login };
    },
    async logout() {
      calls.push(['logout']);
      if (login.active) return { ok: false, statusCode: 409, error: 'A Grok login is in progress; cancel it first' };
      // The real service force-refreshes the status and broadcasts the idle
      // transition itself; the route must not repeat either.
      login = { state: 'idle', authUrl: null, userCode: null, error: null, startedAt: null, active: false };
      for (const listener of listeners) listener(login);
      return { ok: true, status };
    },
    subscribe(listener) { listeners.push(listener); return () => {}; },
    onLoginSuccess(hook) { successHooks.push(hook); return () => {}; },
    dispose() {},
  };
}

/**
 * Enough of the Claude service to keep `registerSessionsRoutes` from building a
 * real one: without it the cross-provider worker-count test would spawn the
 * host's actual `claude auth status`, which no unit test is allowed to do.
 */
function createInertClaudeAuthService() {
  const login = { state: 'idle', authUrl: null, error: null, startedAt: null, active: false };
  return {
    async getStatus() { return { ok: true, loggedIn: false, error: null, checkedAt: null }; },
    getCachedStatus: () => null,
    getLoginState: () => login,
    startLogin: () => ({ ok: true, reused: false, login }),
    submitCode: () => ({ ok: false, statusCode: 409, error: 'not awaiting', login }),
    cancel: () => ({ ok: true, login }),
    async logout() { return { ok: true, status: null }; },
    subscribe: () => () => {},
    onLoginSuccess: () => () => {},
    dispose() {},
  };
}

function createHarness({
  workers = [],
  runtimeSessionsBySdkId = {},
  grokAuthService = null,
  modelRefreshError = null,
} = {}) {
  const app = createMockApp();
  const emittedEvents = [];
  const refreshCalls = [];
  const fakeAuth = grokAuthService || createFakeGrokAuthService();
  const modelState = {
    models: ['grok-4.5'],
    currentModel: 'grok-4.5',
    defaultModel: 'grok-4.5',
    reasoningByModel: {},
    providersByModel: {},
    modelMetadataByModel: {},
  };
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emittedEvents.push({ event, payload }); } },
    db: createMockDb(),
    stmts: {
      getRuntimeSessionBySdkSessionId: { get: (sid) => runtimeSessionsBySdkId[sid] || null },
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
    getGrokProviderSettings: () => ({
      configured: true, enabled: true, model: 'grok-4.5', models: ['grok-4.5'], availableModels: ['grok-4.5'],
    }),
    setGrokProviderSettings: () => ({ ok: true }),
    refreshGrokProviderModels: async () => {
      refreshCalls.push('refresh');
      if (modelRefreshError) throw new Error(modelRefreshError);
      return { ok: true, models: ['grok-4.5'], error: null };
    },
    grokAuthService: fakeAuth,
    claudeAuthService: createInertClaudeAuthService(),
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: true }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'browser-session-1',
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-session-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'claude-sonnet-5',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    sessionWorkerSupervisor: { getWorkerState: () => null, snapshot: () => null },
    sessionWorkerRegistry: { listWorkers: () => workers, getWorker: () => null, upsertWorker: () => null },
    resolveSessionStateRoot: () => null,
  });
  return { app, emittedEvents, refreshCalls, fakeAuth };
}

async function callRoute(app, key, req = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `${key} should be registered`);
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, response, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return response;
}

test('GET /api/grok/auth/status returns status, login state and the live Grok worker count', async () => {
  const harness = createHarness({
    workers: [
      { sdkSessionId: 'grok-live', status: 'processing', pid: process.pid },
      { sdkSessionId: 'grok-stopped', status: 'stopped', pid: process.pid },
      { sdkSessionId: 'grok-dead-pid', status: 'ready', pid: 2147483646 },
      { sdkSessionId: 'claude-live', status: 'ready', pid: process.pid },
      { sdkSessionId: 'grok-no-pid', status: 'starting', pid: null },
    ],
    runtimeSessionsBySdkId: {
      'grok-live': { provider_type: 'grok' },
      'grok-stopped': { provider_type: 'grok' },
      'grok-dead-pid': { provider_type: 'grok' },
      'claude-live': { provider_type: 'claude' },
      'grok-no-pid': { provider_type: 'Grok' },
    },
  });
  const response = await callRoute(harness.app, 'GET /api/grok/auth/status');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status.loggedIn, true);
  assert.equal(response.body.status.plan, 'GrokBuild');
  assert.equal(response.body.login.state, 'idle');
  // The generalised counter must not spill Claude workers into the Grok count:
  // only live-pid Grok workers are counted.
  assert.equal(response.body.runningGrokWorkers, 1);
});

test('the generalised worker count still reports Claude workers to the Claude route', async () => {
  const harness = createHarness({
    workers: [
      { sdkSessionId: 'grok-live', status: 'processing', pid: process.pid },
      { sdkSessionId: 'claude-live', status: 'ready', pid: process.pid },
    ],
    runtimeSessionsBySdkId: {
      'grok-live': { provider_type: 'grok' },
      'claude-live': { provider_type: 'claude' },
    },
  });
  const claude = await callRoute(harness.app, 'GET /api/claude/auth/status');
  assert.equal(claude.body.runningClaudeWorkers, 1);
  const grok = await callRoute(harness.app, 'GET /api/grok/auth/status');
  assert.equal(grok.body.runningGrokWorkers, 1);
});

test('login start / cancel routes return the payload shape', async () => {
  const harness = createHarness();
  const started = await callRoute(harness.app, 'POST /api/grok/auth/login/start');
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.reused, false);
  assert.equal(started.body.login.state, 'starting');
  assert.equal(started.body.runningGrokWorkers, 0);
  assert.ok(started.body.status);

  const cancelled = await callRoute(harness.app, 'POST /api/grok/auth/login/cancel');
  assert.equal(cancelled.body.ok, true);
  assert.equal(cancelled.body.login.state, 'idle');
});

test('there is no code-submission route: the CLI polls and exits on its own', async () => {
  const harness = createHarness();
  assert.equal(harness.app.routes.has('POST /api/grok/auth/login/code'), false);
});

test('a refused login start surfaces the service error with the payload', async () => {
  const fake = createFakeGrokAuthService();
  fake.startLogin = () => ({
    ok: false,
    error: 'cli spawns disabled',
    login: { state: 'error', authUrl: null, userCode: null, error: 'cli spawns disabled', startedAt: null, active: false },
  });
  const harness = createHarness({ grokAuthService: fake });
  const started = await callRoute(harness.app, 'POST /api/grok/auth/login/start');
  assert.equal(started.statusCode, 500);
  assert.equal(started.body.error, 'cli spawns disabled');
  assert.ok(started.body.status, 'the account row still renders');
});

test('login-state transitions are broadcast as grok_auth_state with the full payload', async () => {
  const harness = createHarness();
  harness.fakeAuth.setLogin({
    state: 'awaiting_authorization',
    authUrl: 'https://accounts.x.ai/oauth2/device?user_code=D7SV-M4TR',
    userCode: 'D7SV-M4TR',
    error: null,
    startedAt: 'now',
    active: true,
  });
  // The emit is synchronous: the device URL must not wait on a status read.
  const authEvents = harness.emittedEvents.filter((entry) => entry.event === 'grok_auth_state');
  assert.equal(authEvents.length, 1);
  assert.equal(authEvents[0].payload.login.state, 'awaiting_authorization');
  assert.equal(authEvents[0].payload.login.authUrl, 'https://accounts.x.ai/oauth2/device?user_code=D7SV-M4TR');
  assert.equal(authEvents[0].payload.login.userCode, 'D7SV-M4TR');
  assert.equal(authEvents[0].payload.runningGrokWorkers, 0);
  assert.equal(authEvents[0].payload.status.loggedIn, true);
  assert.ok(
    !harness.fakeAuth.calls.some((entry) => entry[0] === 'getStatus'),
    'the broadcast reads the cache instead of re-reading the auth store',
  );
});

test('a broadcast before the first status read still carries the frozen payload shape', async () => {
  const harness = createHarness({
    grokAuthService: createFakeGrokAuthService({ cachedStatus: null }),
  });
  harness.fakeAuth.setLogin({
    state: 'starting', authUrl: null, userCode: null, error: null, startedAt: 'now', active: true,
  });
  const [event] = harness.emittedEvents.filter((entry) => entry.event === 'grok_auth_state');
  assert.deepEqual(Object.keys(event.payload).sort(), ['login', 'runningGrokWorkers', 'status']);
  assert.deepEqual(Object.keys(event.payload.status).sort(), [
    'checkedAt', 'error', 'expired', 'expiresAt', 'loggedIn', 'ok', 'periodEnd', 'periodType', 'plan', 'usagePercent',
  ]);
  assert.equal(event.payload.status.ok, false);
  assert.equal(event.payload.status.loggedIn, false);
  assert.equal(event.payload.status.checkedAt, null);
});

test('a successful login refreshes model discovery and re-emits Grok settings', async () => {
  const harness = createHarness();
  await harness.fakeAuth.runSuccessHooks();
  assert.deepEqual(harness.refreshCalls, ['refresh']);
  const settingsEvents = harness.emittedEvents.filter((entry) => entry.event === 'grok_settings_updated');
  assert.equal(settingsEvents.length, 1);
  assert.equal(settingsEvents[0].payload.enabled, true);
  assert.deepEqual(settingsEvents[0].payload.models, ['grok-4.5']);
  assert.ok(harness.emittedEvents.some((entry) => entry.event === 'models_updated'));
});

test('a model refresh that throws still lets the settings broadcast through', async () => {
  // Discovery spawns an ACP probe that can fail for reasons unrelated to auth;
  // the sign-in must not be left looking broken because of it.
  const harness = createHarness({ modelRefreshError: 'grok agent exited' });
  await harness.fakeAuth.runSuccessHooks();
  assert.deepEqual(harness.refreshCalls, ['refresh']);
  assert.ok(harness.emittedEvents.some((entry) => entry.event === 'grok_settings_updated'));
  assert.ok(harness.emittedEvents.some((entry) => entry.event === 'models_updated'));
});

test('POST /api/grok/auth/logout is refused with 409 while a login is active', async () => {
  const harness = createHarness();
  harness.fakeAuth.setLogin({
    state: 'awaiting_authorization',
    authUrl: 'https://accounts.x.ai/oauth2/device?user_code=D7SV-M4TR',
    userCode: 'D7SV-M4TR',
    error: null,
    startedAt: 'now',
    active: true,
  });
  const refused = await callRoute(harness.app, 'POST /api/grok/auth/logout');
  assert.equal(refused.statusCode, 409);
  assert.match(refused.body.error, /login is in progress/i);

  harness.fakeAuth.setLogin({
    state: 'idle', authUrl: null, userCode: null, error: null, startedAt: null, active: false,
  });
  harness.emittedEvents.length = 0;
  harness.fakeAuth.calls.length = 0;
  const done = await callRoute(harness.app, 'POST /api/grok/auth/logout');
  assert.equal(done.statusCode, 200);
  assert.equal(done.body.ok, true);
  assert.equal(done.body.status.loggedIn, true);
  assert.equal(done.body.login.state, 'idle');
  assert.equal(done.body.runningGrokWorkers, 0);

  // The status logout() already refreshed is reused, and its own idle transition
  // is the only broadcast: no second auth-store read and no duplicate event.
  assert.deepEqual(harness.fakeAuth.calls.filter((entry) => entry[0] === 'getStatus'), []);
  assert.equal(harness.emittedEvents.filter((entry) => entry.event === 'grok_auth_state').length, 1);
});
