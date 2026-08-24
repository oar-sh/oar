import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const noopStmt = {
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
      return noopStmt;
    },
    transaction(fn) {
      return (...args) => fn(...args);
    },
  };
}

function createBootstrapHarness({ workspaceRootAllowList = [], workspaceRootUpdateResult = null } = {}) {
  const app = createMockApp();
  const db = createMockDb();
  const modelState = {
    models: ['auto', 'gpt-5.4-mini'],
    currentModel: 'gpt-5.4-mini',
    defaultModel: 'gpt-5.4-mini',
    reasoningByModel: { 'gpt-5.4-mini': ['none'] },
    providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
    modelMetadataByModel: {},
  };
  // Ordered trace of the calls the CWD seeding must interleave correctly.
  const calls = [];
  const insertedConversations = [];
  const emittedEvents = [];
  const workspaceRootUpdates = [];
  const deps = {
    auth: (_req, _res, next) => next(),
    io: {
      emit(event, payload) {
        emittedEvents.push({ event, payload });
      },
    },
    db,
    stmts: {
      getConvAnyStatus: { get: () => null },
      insertConv: {
        run: (...args) => {
          insertedConversations.push(args);
        },
      },
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
    workspaceRootPayload: () => ({ recentWorkspaceRoots: ['/known/recent'] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    getOpenAIProviderSettings: () => ({ configured: false, enabled: false, model: 'gpt-4o', models: [] }),
    setOpenAIProviderSettings: () => ({ ok: true }),
    refreshOpenAIProviderModels: async () => ({ ok: true, models: [], error: null }),
    getClaudeProviderSettings: () => ({ configured: false, enabled: false, model: 'claude-sonnet-5', models: [] }),
    setClaudeProviderSettings: () => ({ ok: true }),
    refreshClaudeProviderModels: async () => ({ ok: true, models: [], error: null }),
    getCursorProviderSettings: () => ({ configured: false, enabled: false, model: 'composer-2.5', models: [] }),
    setCursorProviderSettings: () => ({ ok: true }),
    refreshCursorProviderModels: async () => ({ ok: true, models: [], error: null }),
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: ({ conversationId, rootPath }) => {
      calls.push('update-workspace-root');
      workspaceRootUpdates.push({ conversationId, rootPath });
      if (workspaceRootUpdateResult) return workspaceRootUpdateResult;
      return {
        ok: true,
        state: {
          conversationId,
          sdkSessionId: conversationId,
          configuredWorkspaceRootPath: rootPath,
          configuredWorkspaceRootName: path.basename(rootPath),
          runtimeWorkspaceRootPath: null,
          runtimeWorkspaceRootName: null,
          currentWorkspaceRootPath: rootPath,
          currentWorkspaceRootName: path.basename(rootPath),
        },
      };
    },
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    workspaceRootAllowList,
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'browser-session-1',
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: (_cb) => {},
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-session-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: { SESSION_WORKER_ROUTING_ENABLED: true },
    sessionWorkerSupervisor: {
      clearRestartSchedule: () => {},
      ensureWorker: async (sessionId) => {
        calls.push('ensure-worker');
        return { ok: true, worker: { sdkSessionId: sessionId, status: 'ready' } };
      },
      getWorkerState: () => null,
      markIdle: () => {},
      getLifecycleState: () => null,
      snapshot: () => null,
    },
    sessionWorkerRegistry: {
      upsertWorker: () => null,
      getWorker: () => null,
    },
    resolveSessionStateRoot: () => null,
  };
  registerSessionsRoutes(app, deps);
  return { app, calls, insertedConversations, emittedEvents, workspaceRootUpdates };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(
      req,
      response,
      () => {
        nextCalled = true;
      },
    );
    if (!nextCalled) break;
  }
  return response;
}

async function callBootstrap(app, body) {
  const handlers = app.routes.get('POST /api/conversation/bootstrap');
  assert.ok(handlers, 'bootstrap route should be registered');
  return callRoute(handlers, { headers: {}, body, query: {}, params: {} });
}

function makeTempDir() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-cwd-')));
}

test('bootstrap seeds the configured workspace root before the worker launches', async (t) => {
  const tempDir = makeTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const { app, calls, emittedEvents, workspaceRootUpdates } = createBootstrapHarness();

  const response = await callBootstrap(app, { model: 'gpt-5.4-mini', workspaceRootPath: tempDir });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(workspaceRootUpdates.length, 1);
  assert.equal(workspaceRootUpdates[0].rootPath, tempDir);
  assert.equal(workspaceRootUpdates[0].conversationId, response.body.conversationId);
  assert.deepEqual(calls, ['update-workspace-root', 'ensure-worker']);
  assert.equal(response.body.configuredWorkspaceRootPath, tempDir);
  assert.equal(response.body.currentWorkspaceRootPath, tempDir);
  assert.equal(response.body.workspaceRootWarning, null);

  const rootEvent = emittedEvents.find((entry) => entry.event === 'conversation_workspace_root_updated');
  assert.ok(rootEvent, 'should broadcast the workspace root update');
  assert.equal(rootEvent.payload.conversationId, response.body.conversationId);
  assert.equal(rootEvent.payload.configuredWorkspaceRootPath, tempDir);
  assert.deepEqual(rootEvent.payload.recentWorkspaceRoots, ['/known/recent']);
});

test('bootstrap rejects a missing directory before creating the conversation', async () => {
  const { app, insertedConversations, workspaceRootUpdates } = createBootstrapHarness();
  const missingDir = path.join(os.tmpdir(), 'bootstrap-cwd-does-not-exist', 'nested');

  const response = await callBootstrap(app, { model: 'gpt-5.4-mini', workspaceRootPath: missingDir });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, 'root-path-not-found');
  assert.equal(insertedConversations.length, 0);
  assert.equal(workspaceRootUpdates.length, 0);
});

test('bootstrap rejects directories outside the allow list with 403', async (t) => {
  const tempDir = makeTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const allowedDir = makeTempDir();
  t.after(() => fs.rmSync(allowedDir, { recursive: true, force: true }));
  const { app, insertedConversations } = createBootstrapHarness({ workspaceRootAllowList: [allowedDir] });

  const response = await callBootstrap(app, { model: 'gpt-5.4-mini', workspaceRootPath: tempDir });
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.code, 'root-path-not-allowed');
  assert.equal(insertedConversations.length, 0);
});

test('bootstrap without a workspace root keeps the legacy behaviour', async () => {
  const { app, calls, workspaceRootUpdates, emittedEvents } = createBootstrapHarness();

  const response = await callBootstrap(app, { model: 'gpt-5.4-mini' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(workspaceRootUpdates.length, 0);
  assert.deepEqual(calls, ['ensure-worker']);
  assert.equal(response.body.configuredWorkspaceRootPath, null);
  assert.equal(response.body.workspaceRootWarning, null);
  assert.equal(emittedEvents.find((entry) => entry.event === 'conversation_workspace_root_updated'), undefined);
});

test('bootstrap still creates the chat when the root update loses a race', async (t) => {
  const tempDir = makeTempDir();
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const { app, calls } = createBootstrapHarness({
    workspaceRootUpdateResult: { ok: false, error: 'Directory not found: gone' },
  });

  const response = await callBootstrap(app, { model: 'gpt-5.4-mini', workspaceRootPath: tempDir });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.match(response.body.workspaceRootWarning, /could not be set/);
  assert.match(response.body.workspaceRootWarning, /Directory not found: gone/);
  assert.equal(response.body.configuredWorkspaceRootPath, null);
  assert.deepEqual(calls, ['update-workspace-root', 'ensure-worker']);
});
