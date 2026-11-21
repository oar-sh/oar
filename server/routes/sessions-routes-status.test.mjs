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
    put(routePath, ...handlers) {
      routes.set(`PUT ${routePath}`, handlers);
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

function registerStatusRoutes({ overrides = {} } = {}) {
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
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: true,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
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
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
    resolveSessionStateRoot: () => null,
    ...overrides,
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

const RELAY_BUILD = '0.9.21+0123456789ab';
const OLD_BUILD = '0.9.20+fedcba987654';

function statusWorker(sdkSessionId, fields = {}) {
  return { sdkSessionId, status: 'ready', pid: 4100, kind: 'claude', ...fields };
}

test('the session-worker status payload names each worker\'s build, its start and whether it runs other code than the relay', () => {
  const recycle = { relayBuildId: RELAY_BUILD, staleCount: 2, inFlight: 1, recycled: 3, waiting: [{ sdkSessionId: 'old', hold: 'turn' }] };
  const payload = buildSessionWorkerStatusPayload({
    supervisorSnapshot: {
      workers: [
        statusWorker('same', { buildId: RELAY_BUILD, startedAt: '2026-10-30T21:00:00.000Z' }),
        statusWorker('old', { buildId: OLD_BUILD, startedAt: '2026-10-29T08:00:00.000Z' }),
        // Never states a build id, heartbeats, past the grace: older code.
        statusWorker('silent', { startedAt: '2026-10-30T20:00:00.000Z', lastHeartbeatAt: '2026-10-30T21:59:00.000Z' }),
        // Started seconds ago and has not stated its id yet: not known stale.
        statusWorker('fresh', { startedAt: '2026-10-30T21:59:55.000Z', lastHeartbeatAt: '2026-10-30T21:59:58.000Z' }),
        // Past the grace but no heartbeat seen: not known stale.
        statusWorker('mute', { startedAt: '2026-10-30T20:00:00.000Z' }),
        // A stopped entry without an id is never stale.
        statusWorker('stopped', { status: 'stopped', startedAt: '2026-10-30T20:00:00.000Z', lastHeartbeatAt: '2026-10-30T21:00:00.000Z' }),
      ],
    },
    relayBuildId: RELAY_BUILD,
    recycleStatus: recycle,
    now: Date.parse('2026-10-30T22:00:00.000Z'),
  });
  assert.equal(payload.buildId, RELAY_BUILD);
  assert.deepEqual(payload.recycle, recycle);
  assert.deepEqual(
    payload.workers.map(({ sdkSessionId, buildId, startedAt, stale }) => ({ sdkSessionId, buildId, startedAt, stale })),
    [
      { sdkSessionId: 'same', buildId: RELAY_BUILD, startedAt: '2026-10-30T21:00:00.000Z', stale: false },
      { sdkSessionId: 'old', buildId: OLD_BUILD, startedAt: '2026-10-29T08:00:00.000Z', stale: true },
      { sdkSessionId: 'silent', buildId: null, startedAt: '2026-10-30T20:00:00.000Z', stale: true },
      { sdkSessionId: 'fresh', buildId: null, startedAt: '2026-10-30T21:59:55.000Z', stale: false },
      { sdkSessionId: 'mute', buildId: null, startedAt: '2026-10-30T20:00:00.000Z', stale: false },
      { sdkSessionId: 'stopped', buildId: null, startedAt: '2026-10-30T20:00:00.000Z', stale: false },
    ],
  );
  assert.equal(payload.workers[0].kind, 'claude', 'the registry fields still pass through');
});

test('a relay that does not know its own build calls no worker stale, and no recycle reads as null', () => {
  const payload = buildSessionWorkerStatusPayload({
    supervisorSnapshot: { workers: [statusWorker('old', { buildId: OLD_BUILD }), statusWorker('silent')] },
  });
  assert.equal(payload.buildId, null);
  assert.equal(payload.recycle, null);
  assert.deepEqual(payload.workers.map((worker) => worker.stale), [false, false]);
});

test('/api/status carries the relay build id, the recycle status and the per-worker build fields', async () => {
  const runtimeState = {
    cliOnline: true,
    buildId: RELAY_BUILD,
    workerRecycle: () => ({ relayBuildId: RELAY_BUILD, staleCount: 1, inFlight: 0, recycled: 0, waiting: [] }),
  };
  const { app } = registerStatusRoutes({
    overrides: {
      runtimeState,
      stmts: { countRuntimeSessions: { get: () => ({ cnt: 0 }) } },
      sessionWorkerSupervisor: {
        snapshot: () => ({ workers: [statusWorker('old', { buildId: OLD_BUILD }), statusWorker('same', { buildId: RELAY_BUILD })] }),
      },
    },
  });
  const response = await callRoute(app.routes.get('GET /api/status'));
  assert.equal(response.statusCode, 200);
  const { sessionWorker } = response.body;
  assert.equal(sessionWorker.buildId, RELAY_BUILD);
  assert.equal(sessionWorker.recycle.staleCount, 1);
  assert.deepEqual(sessionWorker.workers.map((worker) => [worker.sdkSessionId, worker.buildId, worker.stale]), [
    ['old', OLD_BUILD, true],
    ['same', RELAY_BUILD, false],
  ]);

  // A recycle status that throws leaves the rest of the status standing.
  runtimeState.workerRecycle = () => { throw new Error('not yet'); };
  const degraded = await callRoute(app.routes.get('GET /api/status'));
  assert.equal(degraded.statusCode, 200);
  assert.equal(degraded.body.sessionWorker.recycle, null);
});

test('/api/status reports no feature flags, and the worker payload no routing switches', async () => {
  const { app } = registerStatusRoutes({
    overrides: {
      stmts: { countRuntimeSessions: { get: () => ({ cnt: 3 }) } },
      sessionWorkerSupervisor: { snapshot: () => ({ workers: [] }) },
    },
  });
  const response = await callRoute(app.routes.get('GET /api/status'));
  assert.equal(response.statusCode, 200);
  assert.equal('features' in response.body, false);
  for (const key of ['enabled', 'continuationRoutingEnabled']) {
    assert.equal(key in response.body.sessionWorker, false, key);
  }
  // Active sessions are the bound worker processes; the binding rows are counted apart.
  assert.equal(response.body.activeRuntimeSessionCount, 0);
  assert.equal(response.body.runtimeSessionBindingCount, 3);
});
