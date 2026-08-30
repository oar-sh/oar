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
 * claude-auth-service.test.mjs, so these tests only pin the route contract.
 */
function createFakeClaudeAuthService({ statusValue, loginState, cachedStatus } = {}) {
  const listeners = [];
  const successHooks = [];
  const calls = [];
  let login = loginState || { state: 'idle', authUrl: null, error: null, startedAt: null, active: false };
  const status = statusValue || {
    ok: true,
    loggedIn: true,
    authMethod: 'claudeai',
    apiProvider: null,
    email: 'stub@example.com',
    orgId: 'org_stub',
    orgName: 'Stub Org',
    subscriptionType: 'max',
    error: null,
    checkedAt: '2026-08-30T00:00:00.000Z',
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
    // Never spawns: this is what the broadcast path is allowed to read.
    getCachedStatus() {
      calls.push(['getCachedStatus']);
      return cachedStatus === undefined ? status : cachedStatus;
    },
    getLoginState: () => login,
    startLogin() {
      calls.push(['startLogin']);
      login = { state: 'starting', authUrl: null, error: null, startedAt: '2026-08-30T00:00:00.000Z', active: true };
      return { ok: true, reused: false, login };
    },
    submitCode(code) {
      calls.push(['submitCode', code]);
      if (login.state !== 'awaiting_code') {
        return { ok: false, statusCode: 409, error: 'not awaiting', login };
      }
      login = { ...login, state: 'exchanging' };
      return { ok: true, login };
    },
    cancel() {
      calls.push(['cancel']);
      login = { state: 'idle', authUrl: null, error: null, startedAt: null, active: false };
      return { ok: true, login };
    },
    async logout() {
      calls.push(['logout']);
      if (login.active) return { ok: false, statusCode: 409, error: 'A Claude login is in progress; cancel it first' };
      // The real service force-refreshes the status and broadcasts the idle
      // transition itself; the route must not repeat either.
      login = { state: 'idle', authUrl: null, error: null, startedAt: null, active: false };
      for (const listener of listeners) listener(login);
      return { ok: true, status };
    },
    subscribe(listener) { listeners.push(listener); return () => {}; },
    onLoginSuccess(hook) { successHooks.push(hook); return () => {}; },
    dispose() {},
  };
}

function createHarness({ workers = [], runtimeSessionsBySdkId = {}, claudeAuthService = null } = {}) {
  const app = createMockApp();
  const emittedEvents = [];
  const refreshCalls = [];
  const fakeAuth = claudeAuthService || createFakeClaudeAuthService();
  const modelState = {
    models: ['claude-sonnet-5'],
    currentModel: 'claude-sonnet-5',
    defaultModel: 'claude-sonnet-5',
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
    getClaudeProviderSettings: () => ({
      configured: true, enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'], availableModels: ['claude-sonnet-5'],
    }),
    setClaudeProviderSettings: () => ({ ok: true }),
    refreshClaudeProviderModels: async () => {
      refreshCalls.push('refresh');
      return { ok: true, models: ['claude-sonnet-5'], error: null };
    },
    claudeAuthService: fakeAuth,
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

test('GET /api/claude/auth/status returns status, login state and the live Claude worker count', async () => {
  const harness = createHarness({
    workers: [
      { sdkSessionId: 'claude-live', status: 'processing', pid: process.pid },
      { sdkSessionId: 'claude-stopped', status: 'stopped', pid: process.pid },
      { sdkSessionId: 'claude-dead-pid', status: 'ready', pid: 2147483646 },
      { sdkSessionId: 'copilot-live', status: 'ready', pid: process.pid },
      { sdkSessionId: 'claude-no-pid', status: 'starting', pid: null },
    ],
    runtimeSessionsBySdkId: {
      'claude-live': { provider_type: 'claude' },
      'claude-stopped': { provider_type: 'claude' },
      'claude-dead-pid': { provider_type: 'claude' },
      'copilot-live': { provider_type: 'github' },
      'claude-no-pid': { provider_type: 'Claude' },
    },
  });
  const response = await callRoute(harness.app, 'GET /api/claude/auth/status');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status.email, 'stub@example.com');
  assert.equal(response.body.login.state, 'idle');
  // Only workers with a live pid: stopped, dead-pid, pid-less and non-Claude
  // entries are all excluded.
  assert.equal(response.body.runningClaudeWorkers, 1);
});

test('login start / code / cancel routes return the payload shape and surface service errors', async () => {
  const harness = createHarness();
  const started = await callRoute(harness.app, 'POST /api/claude/auth/login/start');
  assert.equal(started.statusCode, 200);
  assert.equal(started.body.ok, true);
  assert.equal(started.body.reused, false);
  assert.equal(started.body.login.state, 'starting');
  assert.equal(started.body.runningClaudeWorkers, 0);
  assert.ok(started.body.status);

  const tooEarly = await callRoute(harness.app, 'POST /api/claude/auth/login/code', { body: { code: 'abc' } });
  assert.equal(tooEarly.statusCode, 409);
  assert.match(tooEarly.body.error, /not awaiting/);

  harness.fakeAuth.setLogin({
    state: 'awaiting_code', authUrl: 'https://claude.com/oauth/authorize?code=true', error: null, startedAt: 'now', active: true,
  });
  const submitted = await callRoute(harness.app, 'POST /api/claude/auth/login/code', { body: { code: 'goodcode' } });
  assert.equal(submitted.statusCode, 200);
  assert.equal(submitted.body.login.state, 'exchanging');
  // The code never appears in a response body.
  assert.ok(!JSON.stringify(submitted.body).includes('goodcode'));

  const cancelled = await callRoute(harness.app, 'POST /api/claude/auth/login/cancel');
  assert.equal(cancelled.body.login.state, 'idle');
});

test('login-state transitions are broadcast as claude_auth_state with the full payload', async () => {
  const harness = createHarness();
  harness.fakeAuth.setLogin({
    state: 'awaiting_code', authUrl: 'https://claude.com/oauth/authorize?code=true', error: null, startedAt: 'now', active: true,
  });
  // The emit is synchronous: the authorize URL must not wait on a status read.
  const authEvents = harness.emittedEvents.filter((entry) => entry.event === 'claude_auth_state');
  assert.equal(authEvents.length, 1);
  assert.equal(authEvents[0].payload.login.state, 'awaiting_code');
  assert.equal(authEvents[0].payload.login.authUrl, 'https://claude.com/oauth/authorize?code=true');
  assert.equal(authEvents[0].payload.runningClaudeWorkers, 0);
  assert.equal(authEvents[0].payload.status.loggedIn, true);
  assert.ok(
    !harness.fakeAuth.calls.some((entry) => entry[0] === 'getStatus'),
    'the broadcast reads the cache instead of spawning `claude auth status`',
  );
});

test('a broadcast before the first status read still carries the frozen payload shape', async () => {
  const harness = createHarness({
    claudeAuthService: createFakeClaudeAuthService({ cachedStatus: null }),
  });
  harness.fakeAuth.setLogin({ state: 'starting', authUrl: null, error: null, startedAt: 'now', active: true });
  const [event] = harness.emittedEvents.filter((entry) => entry.event === 'claude_auth_state');
  assert.deepEqual(Object.keys(event.payload).sort(), ['login', 'runningClaudeWorkers', 'status']);
  assert.equal(event.payload.status.ok, false);
  assert.equal(event.payload.status.loggedIn, false);
  assert.equal(event.payload.status.checkedAt, null);
  assert.equal(event.payload.status.error, null);
});

test('a successful login refreshes model discovery and re-emits Claude settings', async () => {
  const harness = createHarness();
  await harness.fakeAuth.runSuccessHooks();
  assert.deepEqual(harness.refreshCalls, ['refresh']);
  const settingsEvents = harness.emittedEvents.filter((entry) => entry.event === 'claude_settings_updated');
  assert.equal(settingsEvents.length, 1);
  assert.equal(settingsEvents[0].payload.enabled, true);
  assert.deepEqual(settingsEvents[0].payload.models, ['claude-sonnet-5']);
  assert.ok(harness.emittedEvents.some((entry) => entry.event === 'models_updated'));
});

test('POST /api/claude/auth/logout is refused with 409 while a login is active', async () => {
  const harness = createHarness();
  harness.fakeAuth.setLogin({ state: 'awaiting_code', authUrl: 'https://claude.com/x', error: null, startedAt: 'now', active: true });
  const refused = await callRoute(harness.app, 'POST /api/claude/auth/logout');
  assert.equal(refused.statusCode, 409);
  assert.match(refused.body.error, /login is in progress/i);

  harness.fakeAuth.setLogin({ state: 'idle', authUrl: null, error: null, startedAt: null, active: false });
  harness.emittedEvents.length = 0;
  harness.fakeAuth.calls.length = 0;
  const done = await callRoute(harness.app, 'POST /api/claude/auth/logout');
  assert.equal(done.statusCode, 200);
  assert.equal(done.body.ok, true);
  assert.equal(done.body.status.email, 'stub@example.com');
  assert.equal(done.body.login.state, 'idle');
  assert.equal(done.body.runningClaudeWorkers, 0);

  // The status logout() already refreshed is reused, and its own idle
  // transition is the only broadcast: no second `claude auth status` spawn and
  // no duplicate event.
  assert.deepEqual(harness.fakeAuth.calls.filter((entry) => entry[0] === 'getStatus'), []);
  assert.equal(harness.emittedEvents.filter((entry) => entry.event === 'claude_auth_state').length, 1);
});
