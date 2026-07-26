import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers);
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers);
    },
    patch(path, ...handlers) {
      routes.set(`PATCH ${path}`, handlers);
    },
    delete(path, ...handlers) {
      routes.set(`DELETE ${path}`, handlers);
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

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
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

test('shared conversation payload rewrites generated image attachment URLs', async () => {
  const shareToken = 'a'.repeat(32);
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: createMockDb(),
    stmts: {
      getConversationShareByToken: { get: () => ({ token: shareToken, conversation_id: 'conv-1', revoked_at: null }) },
      touchConversationShare: { run() {} },
      getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', title: 'Demo', sdk_session_id: 'sdk-1', created_at: '2026-01-01', updated_at: '2026-01-01' }) },
      getConvBySdkSessionId: { get: () => null },
      getRuntimeSessionByConversation: { get: () => null },
      getMessages: {
        all: () => [
          {
            id: 'msg-1',
            role: 'assistant',
            text: '',
            attachments: JSON.stringify([
              {
                name: 'generated.png',
                type: 'image/png',
                contentUrl: '/api/generated-image/conv-1/msg-1/img-01/content',
                generatedImage: {
                  imageId: 'img-01',
                  messageId: 'msg-1',
                  sessionId: 'sdk-1',
                  relativePath: 'conv-1/msg-1/img-01.png',
                },
              },
            ]),
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      listMessageUsageSnapshotsByConversation: { all: () => [] },
    },
    runtimeState: {},
    config: {},
    parseAttachments: (raw) => {
      try { return JSON.parse(raw || '[]'); } catch { return []; }
    },
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => null,
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'session-id',
    touchCli() {},
    markCliOffline() {},
    fetchUsageSummary() {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'isolated',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['isolated'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'isolated',
    DEFAULT_MODEL: 'gpt-5',
    remotePath: '',
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
    sessionWorkerProcessInspector: null,
    resolveSessionStateRoot: () => null,
    markSharedViewerPresence: () => ({ ok: true, watcherCount: 0 }),
    getSharedWatcherCount: () => 0,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    windowsAutostartService: null,
    isSha256: () => false,
    uploadPathForSha: () => '',
  });

  const handlers = app.routes.get('GET /api/shared/:token');
  const response = await callRoute(handlers, {
    params: { token: shareToken },
    headers: {},
    query: {},
  });
  assert.equal(response.statusCode, 200);
  const firstAttachment = response.body?.messages?.[0]?.attachments?.[0];
  assert.equal(firstAttachment?.contentUrl, `/api/shared/${shareToken}/generated-image/msg-1/img-01/content`);
});

test('shared generated image route blocks traversal-style relative paths', async () => {
  const shareToken = 'b'.repeat(32);
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: createMockDb(),
    stmts: {
      getConversationShareByToken: { get: () => ({ token: shareToken, conversation_id: 'conv-1', revoked_at: null }) },
      touchConversationShare: { run() {} },
      getConvAnyStatus: { get: () => ({ id: 'conv-1', status: 'active', title: 'Demo', sdk_session_id: 'sdk-1', created_at: '2026-01-01', updated_at: '2026-01-01' }) },
      getConvBySdkSessionId: { get: () => null },
      getRuntimeSessionByConversation: { get: () => null },
      getMessages: {
        all: () => [
          {
            id: 'msg-1',
            role: 'assistant',
            text: '',
            attachments: JSON.stringify([
              {
                name: 'generated.png',
                type: 'image/png',
                generatedImage: {
                  imageId: 'img-01',
                  messageId: 'msg-1',
                  sessionId: 'sdk-1',
                  relativePath: '../outside.png',
                },
              },
            ]),
            timestamp: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      listMessageUsageSnapshotsByConversation: { all: () => [] },
    },
    runtimeState: {},
    config: {},
    parseAttachments: (raw) => {
      try { return JSON.parse(raw || '[]'); } catch { return []; }
    },
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    buildContextResponseText: () => '',
    readContextFromSessionEvents: () => [],
    inFlightStateForConversation: () => null,
    createCompactedConversation: () => null,
    collectOrphanedUploadsFromConversation: () => [],
    deleteOrphanedUploads: () => ({ deletedCount: 0 }),
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => ({}),
    updateModelCatalog: () => ({}),
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => ({}),
    setEnabledModelVariants: () => ({}),
    SUPPORTED_REASONING_EFFORTS: ['none'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => null,
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'session-id',
    touchCli() {},
    markCliOffline() {},
    fetchUsageSummary() {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'isolated',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['isolated'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'isolated',
    DEFAULT_MODEL: 'gpt-5',
    remotePath: '',
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
    sessionWorkerProcessInspector: null,
    resolveSessionStateRoot: () => process.cwd(),
    markSharedViewerPresence: () => ({ ok: true, watcherCount: 0 }),
    getSharedWatcherCount: () => 0,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    windowsAutostartService: null,
    isSha256: () => false,
    uploadPathForSha: () => '',
  });
  const handlers = app.routes.get('GET /api/shared/:token/generated-image/:messageId/:imageId/content');
  const response = await callRoute(handlers, {
    params: { token: shareToken, messageId: 'msg-1', imageId: 'img-01' },
    headers: {},
    query: {},
  });
  assert.equal(response.statusCode, 404);
});
