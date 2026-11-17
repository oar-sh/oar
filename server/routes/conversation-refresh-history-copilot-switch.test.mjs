import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createQuestionRepository } from '../repositories/question-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { createSdkSessionImportService } from '../services/sdk-session-import-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';
import { COPILOT_OFF_REFRESH_TEXT } from './conversation-read-routes.mjs';

// POST /api/conversation/:id/refresh-history re-imports a chat's history
// from Copilot's own runtime (the SDK session importer). While Copilot is
// switched off that runtime is never started for a Copilot chat: the route
// answers COPILOT_SWITCHED_OFF and nothing is imported. Other chats, and
// Copilot chats while it is on, refresh as before.

// A chat whose CLI session has the chat's own id, as the SDK workers run it.
const CONV = 'conv-refresh-fixture';
const SDK_SESSION = CONV;
const at = (n) => new Date(Date.UTC(2026, 2, 1) + n * 1000).toISOString();

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

function setup({ copilotEnabled, providerType }) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createQuestionRepository(db) };
  db.prepare(`INSERT INTO conversations (id, title, sdk_session_id, created_at, updated_at) VALUES (?, 'Widget notes', ?, ?, ?)`).run(CONV, SDK_SESSION, at(0), at(0));
  if (providerType !== null) {
    db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, provider_type, created_at, last_used_at) VALUES ('runtime-refresh-fixture', ?, ?, 'runtime-key-fixture', ?, ?, ?)`)
      .run(CONV, SDK_SESSION, providerType, at(0), at(0));
  }
  if (copilotEnabled !== undefined) {
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('copilot_enabled', ?, ?)`).run(String(copilotEnabled), at(0));
  }
  // The real importer; its runtime is a stand-in that counts its starts and
  // lists the session with no events.
  let runtimeStarts = 0;
  const importer = createSdkSessionImportService({
    db,
    stmts,
    createClient: async () => {
      runtimeStarts += 1;
      return {
        client: {
          async resumeSession() { return { async getEvents() { return []; }, async disconnect() {} }; },
          async listSessions() { return []; },
        },
        async dispose() {},
      };
    },
    parseSessionEventsToMessages: () => [],
    replaceRetrievableHistory: () => {},
    ensureRuntimeSessionBinding: () => ({ ok: true }),
    logger: { info() {}, warn() {} },
  });
  db.prepare(`INSERT INTO sdk_session_imports (sdk_session_id, conversation_id, status, updated_at, origin) VALUES (?, ?, 'completed', ?, 'imported')`)
    .run(SDK_SESSION, CONV, at(0));
  const app = createMockApp();
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: (raw) => {
      try { return raw ? JSON.parse(raw) : []; } catch { return []; }
    },
    hydrateAttachment: (v) => v,
    relayActivityForResponse: () => [],
    relayThoughtsForResponse: () => [],
    subagentRunsForResponse: () => [],
    workflowRunsForResponse: () => [],
    previewCardsForResponse: () => [],
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
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium', 'high'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: true }),
    learnConversationWorkspaceRoot: () => ({ ok: true }),
    consumePendingSessionCwd: () => null,
    getPendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    readSessionTranscriptMessages: () => [],
    ensureRuntimeSessionBinding: () => ({ ok: true }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent', 'plan'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: '',
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry: createSessionWorkerRegistry(),
    sessionHistoryRefreshService: {
      evaluateRefreshIdleState: () => ({ idle: true }),
      replaceRetrievableHistory: () => {},
    },
    sdkSessionImportService: importer,
    statusEventService: { recordSharedAccess: () => ({ event: null }) },
  });
  const refresh = async () => {
    const handler = app.routes.get('POST /api/conversation/:id/refresh-history');
    assert.ok(handler);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body: {}, headers: {}, query: {}, params: { id: CONV }, socket: {}, protocol: 'http', get: () => 'relay.example.test' }, res);
    return captured;
  };
  const importStatus = () => db.prepare(`SELECT status FROM sdk_session_imports WHERE sdk_session_id = ?`).get(SDK_SESSION)?.status;
  return { refresh, runtimeStarts: () => runtimeStarts, importStatus };
}

for (const providerType of ['github', '', null]) {
  const label = providerType === null ? 'no runtime row' : `provider '${providerType}'`;
  test(`Copilot switched off: refresh-history of a Copilot chat (${label}) is refused and starts no Copilot runtime`, async () => {
    const { refresh, runtimeStarts, importStatus } = setup({ copilotEnabled: false, providerType });
    const answer = await refresh();
    assert.equal(answer.status, 409, JSON.stringify(answer.body));
    assert.deepEqual(answer.body, { error: COPILOT_OFF_REFRESH_TEXT, code: 'COPILOT_SWITCHED_OFF' });
    assert.equal(runtimeStarts(), 0);
    assert.equal(importStatus(), 'completed', 'the import ledger is untouched');
  });
}

test('Copilot switched off: an OpenAI chat still refreshes through the runtime', async () => {
  const { refresh, runtimeStarts } = setup({ copilotEnabled: false, providerType: 'openai' });
  const answer = await refresh();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(runtimeStarts(), 1);
});

test('Copilot on: a Copilot chat refreshes through the runtime', async () => {
  const { refresh, runtimeStarts } = setup({ copilotEnabled: true, providerType: 'github' });
  const answer = await refresh();
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(runtimeStarts(), 1);
});
