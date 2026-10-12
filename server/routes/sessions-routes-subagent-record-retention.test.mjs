import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import {
  DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS,
  parseSubagentRecordRetentionUpdate,
  readSubagentRecordRetentionSetting,
} from '../../shared/subagent-record-retention.mjs';

// The sub-agent record retention setting: off / 7 / 14 / 30 / 90 days.

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
function createRetentionStore(initial = DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS) {
  let days = initial;
  const writes = [];
  return {
    writes,
    getSubagentRecordRetentionDays: () => days,
    setSubagentRecordRetentionDays: (value) => {
      const parsed = parseSubagentRecordRetentionUpdate(value);
      if (!parsed.ok) return parsed;
      days = parsed.days;
      writes.push(days);
      return { ok: true, retentionDays: days };
    },
  };
}

function registerRetentionRoutes(store) {
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
    getSubagentRecordRetentionDays: store.getSubagentRecordRetentionDays,
    setSubagentRecordRetentionDays: store.setSubagentRecordRetentionDays,
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

test('the retention routes are authenticated and report the default with its choices', async () => {
  const { app, auth } = registerRetentionRoutes(createRetentionStore());
  const getHandlers = app.routes.get('GET /api/settings/subagent-record-retention');
  const postHandlers = app.routes.get('POST /api/settings/subagent-record-retention');
  assert.equal(getHandlers[0], auth);
  assert.equal(postHandlers[0], auth);
  const response = await callRoute(getHandlers);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { retentionDays: 90, choices: [0, 7, 14, 30, 90], defaultDays: 90 });
});

test('a choice is stored and echoed; 0 turns pruning off', async () => {
  const store = createRetentionStore();
  const { app } = registerRetentionRoutes(store);
  const post = app.routes.get('POST /api/settings/subagent-record-retention');
  const response = await callRoute(post, { body: { retentionDays: 14 } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.retentionDays, 14);
  assert.equal((await callRoute(post, { body: { retentionDays: '0' } })).body.retentionDays, 0);
  assert.deepEqual(store.writes, [14, 0]);
});

test('anything but a choice is refused and nothing is stored', async () => {
  const store = createRetentionStore();
  const { app } = registerRetentionRoutes(store);
  const post = app.routes.get('POST /api/settings/subagent-record-retention');
  for (const retentionDays of [45, -7, 7.5, '', null, 'ninety']) {
    const response = await callRoute(post, { body: { retentionDays } });
    assert.equal(response.statusCode, 400, String(retentionDays));
    assert.match(response.body.error, /one of 0, 7, 14, 30, 90/);
  }
  assert.deepEqual(store.writes, []);
});

test('an unset or unreadable stored value reads as the default, not off', () => {
  assert.equal(readSubagentRecordRetentionSetting(null), 90);
  assert.equal(readSubagentRecordRetentionSetting(''), 90);
  assert.equal(readSubagentRecordRetentionSetting('45'), 90);
  assert.equal(readSubagentRecordRetentionSetting('0'), 0);
  assert.equal(readSubagentRecordRetentionSetting('30'), 30);
});
