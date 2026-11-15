import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { registerSessionsRoutes } from './sessions-routes.mjs';
const REPO_ROOT = process.cwd();

function createMockApp() {
  const routes = new Map();
  return {
    routes,
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers); },
    patch(route, ...handlers) { routes.set(`PATCH ${route}`, handlers); },
    put(route, ...handlers) { routes.set(`PUT ${route}`, handlers); },
    delete(route, ...handlers) { routes.set(`DELETE ${route}`, handlers); },
  };
}

function createMockDb() {
  const statement = {
    run() { return { changes: 1 }; },
    get() { return null; },
    all() { return []; },
  };
  return {
    prepare() { return statement; },
    transaction(fn) { return (...args) => fn(...args); },
  };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
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

function buildDeps({ root, stmts, sessionWorkerRegistry = null }) {
  return {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: createMockDb(),
    stmts,
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
    consumePendingSessionCwd: () => null,
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'session-id',
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
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry,
    sessionWorkerProcessInspector: null,
    resolveSessionStateRoot: () => root,
    markSharedViewerPresence: () => ({ ok: true, watcherCount: 0 }),
    getSharedWatcherCount: () => 0,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
    windowsAutostartService: null,
    isSha256: () => false,
    uploadPathForSha: () => '',
  };
}

test('DELETE /api/conversation/:id removes generated image files during hard delete', async () => {
  const root = path.join(REPO_ROOT, '.test-artifacts', `delete-generated-images-${process.pid}`);
  const imagePath = path.join(root, 'conv-1', 'generated-images', 'conv-1', 'msg-1', 'img-01.png');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, Buffer.from([1, 2, 3]));

  const app = createMockApp();
  registerSessionsRoutes(app, buildDeps({
    root,
    stmts: {
      getConvAnyStatus: { get: () => ({ id: 'conv-1', sdk_session_id: '', status: 'active' }) },
      markDeletedSdkSession: { run() {} },
      getMessages: {
        all: () => [
          {
            id: 'msg-1',
            attachments: JSON.stringify([{
              type: 'image/png',
              generatedImage: {
                imageId: 'img-01',
                messageId: 'msg-1',
                sessionId: 'conv-1',
                relativePath: 'conv-1/msg-1/img-01.png',
              },
            }]),
          },
        ],
      },
    },
  }));

  try {
    const handlers = app.routes.get('DELETE /api/conversation/:id');
    const response = await callRoute(handlers, { params: { id: 'conv-1' }, headers: {}, body: {} });
    assert.equal(response.statusCode, 200);
    assert.equal(fs.existsSync(imagePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
