import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
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
    put(path, ...handlers) {
      routes.set(`PUT ${path}`, handlers);
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

// The share routes read the share through the share repository; the mock
// database has no tables, so the test hands in the one share it serves.
function stubShareRepository(token, conversationId) {
  const share = { token, conversationId, lineageId: token, createdAt: null, revokedAt: null };
  return {
    findLiveShare: (value) => (value === token ? share : null),
    findActiveShare: () => share,
    readStoreViewerIp: () => true,
    readViewerKeySecret: () => 'fixture-secret',
    lastOpenAt: () => null,
    recordOpen: () => true,
    forgetConversation: () => 0,
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
    shareRepository: stubShareRepository(shareToken, 'conv-1'),
    stmts: {
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
    shareRepository: stubShareRepository(shareToken, 'conv-1'),
    stmts: {
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

// GET /api/conversation/:id gives each generated image its file on this relay
// (worked out at read time) and its size; the shared view never gets the path.
test('the conversation payload names a generated image\'s file and size; a missing file has no path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-generated-images-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'sdk-1', 'generated-images', 'conv-a', 'reply-1');
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1536, 16);
  png.writeUInt32BE(1024, 20);
  fs.writeFileSync(path.join(dir, 'img-01.png'), png);

  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES ('conv-a', 'Lighthouse', 'sdk-1', ?, ?)`).run('2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
  const image = (imageId) => ({
    name: `${imageId}.png`,
    type: 'image/png',
    size: 33,
    generatedImage: { imageId, messageId: 'reply-1', conversationId: 'conv-a', sessionId: 'sdk-1', relativePath: `conv-a/reply-1/${imageId}.png` },
  });
  db.prepare(`INSERT INTO messages (id, conversation_id, role, text, mode, timestamp, attachments) VALUES ('reply-1', 'conv-a', 'assistant', '', 'agent', ?, ?)`)
    .run('2026-03-01T00:00:05.000Z', JSON.stringify([image('img-01'), image('img-02')]));

  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  registerSessionsRoutes({ get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} }, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: (raw) => {
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    hydrateAttachment: (value) => value,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    inFlightStateForConversation: () => null,
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    featureFlags: {},
    resolveSessionStateRoot: () => root,
  });
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  await routes.get('GET /api/conversation/:id')({ body: {}, headers: {}, query: {}, params: { id: 'conv-a' }, socket: {}, protocol: 'http', get: () => 'relay.example.test' }, res);
  assert.equal(captured.status, 200);
  const [found, missing] = captured.body.messages[0].attachments;
  assert.equal(found.generatedImage.path, path.join(dir, 'img-01.png'));
  assert.equal(found.width, 1536);
  assert.equal(found.height, 1024);
  assert.equal(missing.generatedImage.path, undefined, 'no file, no path');
  assert.equal(missing.width, undefined);
  const stored = JSON.parse(db.prepare(`SELECT attachments FROM messages WHERE id = 'reply-1'`).get().attachments);
  assert.equal(stored[0].generatedImage.path, undefined, 'the path is never stored');
});
