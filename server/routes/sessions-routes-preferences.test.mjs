import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createSessionWorkerRegistry } from '../services/session-worker-registry-service.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// Route-level coverage for PATCH /api/conversation/:id/preferences.
//
// The unit tests below persistConversationPreferences already pin the storage
// rules, but nothing exercised the route's own decision: which keys count as
// "mentioned". The context modal's auto-compact slider sends ONLY
// {clientId, autoCompactWindow}, so a route that rebuilt all four columns from
// req.body would silently reset the composer's model/effort/mode on every
// slider drag. The composer, meanwhile, sends all three and relies on an
// explicit '' still clearing a preference.

const ROUTE = 'PATCH /api/conversation/:id/preferences';
const CONV = 'conv-1';

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => {
    routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  };
  return {
    routes,
    get: record('GET'),
    post: record('POST'),
    patch: record('PATCH'),
    put: record('PUT'),
    delete: record('DELETE'),
    use() {},
  };
}

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  const emitted = [];
  const app = createMockApp();
  const sessionWorkerRegistry = createSessionWorkerRegistry();

  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { emitted.push([event, payload]); } },
    db,
    stmts,
    runtimeState: {},
    config: {},
    parseAttachments: () => [],
    hydrateAttachment: (v) => v,
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
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium', 'high'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => null,
    updateConversationConfiguredWorkspaceRoot: () => ({ ok: true }),
    learnConversationWorkspaceRoot: () => ({ ok: true }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    getPendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => true,
    touchCli: () => {},
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
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    resolveSessionStateRoot: () => null,
    sessionWorkerRegistry,
  });

  const handler = app.routes.get(ROUTE);
  assert.ok(handler, `${ROUTE} should be registered`);

  const patch = async (body) => {
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler({ body, headers: {}, query: {}, params: { id: CONV }, socket: {} }, res);
    return captured;
  };

  const row = () => db.prepare('SELECT * FROM conversations WHERE id = ?').get(CONV);

  db.prepare(`
    INSERT INTO conversations (id, title, status, created_at, updated_at,
      preferred_relay_mode, preferred_model, preferred_reasoning_effort)
    VALUES (?, 'Demo', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      'plan', 'claude-opus-5', 'high')
  `).run(CONV);

  const getContext = async () => {
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await app.routes.get('GET /api/context/:conversationId')(
      { body: {}, headers: {}, query: {}, params: { conversationId: CONV }, socket: {} },
      res,
    );
    return captured;
  };

  return { db, stmts, patch, row, emitted, getContext, sessionWorkerRegistry };
}

test('a slider-only PATCH stores the window and leaves every other preference alone', async () => {
  const { patch, row } = setup();

  const response = await patch({ clientId: 'client-a', autoCompactWindow: 150000 });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.autoCompactWindow, 150000);
  // Echoed back unchanged, so the client that only knows about the window
  // still sees the truth about the rest.
  assert.equal(response.body.preferredModel, 'claude-opus-5');
  assert.equal(response.body.preferredReasoningEffort, 'high');
  assert.equal(response.body.preferredRelayMode, 'plan');

  const stored = row();
  assert.equal(stored.auto_compact_window, 150000);
  assert.equal(stored.preferred_model, 'claude-opus-5', 'the composer model survives a slider write');
  assert.equal(stored.preferred_reasoning_effort, 'high');
  assert.equal(stored.preferred_relay_mode, 'plan');
});

test('a slider-only PATCH back to Auto clears the window without touching the rest', async () => {
  const { patch, row } = setup();

  await patch({ clientId: 'client-a', autoCompactWindow: 150000 });
  const response = await patch({ clientId: 'client-a', autoCompactWindow: null });
  assert.equal(response.body.autoCompactWindow, null, 'null is Auto, not "leave it alone"');

  const stored = row();
  assert.equal(stored.auto_compact_window, null);
  assert.equal(stored.preferred_model, 'claude-opus-5');
  assert.equal(stored.preferred_reasoning_effort, 'high');
  assert.equal(stored.preferred_relay_mode, 'plan');
});

test('the composer\'s full body still clears a preference with an explicit \'\'', async () => {
  const { patch, row } = setup();

  await patch({ clientId: 'client-a', autoCompactWindow: 200000 });

  const response = await patch({
    clientId: 'client-b',
    preferredRelayMode: 'agent',
    preferredModel: '',
    preferredReasoningEffort: '',
  });
  assert.equal(response.body.preferredModel, '', 'an explicit blank clears, it does not fall back');
  assert.equal(response.body.preferredReasoningEffort, '');
  assert.equal(response.body.preferredRelayMode, 'agent');
  // The composer never mentions the window, so the slider's value stands.
  assert.equal(response.body.autoCompactWindow, 200000);

  const stored = row();
  assert.equal(stored.preferred_model, null);
  assert.equal(stored.preferred_reasoning_effort, null);
  assert.equal(stored.preferred_relay_mode, 'agent');
  assert.equal(stored.auto_compact_window, 200000, 'a composer write must not reset the window');
});

test('the broadcast carries the merged state, not just the mentioned keys', async () => {
  const { patch, emitted } = setup();

  await patch({ clientId: 'client-a', autoCompactWindow: 100000 });
  const update = emitted.find(([event]) => event === 'conversation_preferences_updated');
  assert.ok(update, 'other tabs need the update to re-render the control');
  assert.equal(update[1].autoCompactWindow, 100000);
  assert.equal(update[1].preferredModel, 'claude-opus-5');
  assert.equal(update[1].preferredReasoningEffort, 'high');
  assert.equal(update[1].senderClientId, 'client-a');
});

test('a thinking-only PATCH stores both axes and leaves every other preference alone', async () => {
  const { patch, row } = setup();

  const response = await patch({ clientId: 'client-a', thinkingEnabled: false, thinkingDisplay: 'omitted' });
  assert.equal(response.status, 200);
  assert.equal(response.body.thinkingEnabled, false);
  assert.equal(response.body.thinkingDisplay, 'omitted');
  assert.equal(response.body.preferredModel, 'claude-opus-5');
  assert.equal(response.body.preferredRelayMode, 'plan');

  const stored = row();
  assert.equal(stored.thinking_enabled, 0, 'off stores as 0, not NULL');
  assert.equal(stored.thinking_display, 'omitted');
  assert.equal(stored.preferred_model, 'claude-opus-5', 'the composer model survives a thinking write');
});

test('an unset conversation reads back as the relay default (thinking on, summarized)', async () => {
  const { patch, row } = setup();

  // Nothing written yet: both columns are NULL, and NULL means "never set".
  assert.equal(row().thinking_enabled, null);
  assert.equal(row().thinking_display, null);

  const response = await patch({ clientId: 'client-a', preferredRelayMode: 'agent' });
  assert.equal(response.body.thinkingEnabled, true, 'copilot-remote thinks by default');
  assert.equal(response.body.thinkingDisplay, 'summarized', 'thoughts are visible by default');
});

test('a null/junk thinkingEnabled resolves to the default rather than disabling thinking', async () => {
  const { patch, row } = setup();

  await patch({ clientId: 'client-a', thinkingEnabled: false });
  assert.equal(row().thinking_enabled, 0);

  // An older client (or a bad payload) must never silently leave thinking off
  // — the parser's fallback is the relay default.
  const response = await patch({ clientId: 'client-a', thinkingEnabled: null });
  assert.equal(response.body.thinkingEnabled, true);
  assert.equal(row().thinking_enabled, 1);
});

test('both axes store the resolved value, never NULL-as-default', async () => {
  // NULL means "never set". Canonicalizing a default choice back to NULL would
  // re-point those rows if the relay default ever changed, so an explicit
  // choice is always written out.
  const { patch, row } = setup();

  await patch({ clientId: 'client-a', thinkingDisplay: 'omitted' });
  assert.equal(row().thinking_display, 'omitted');

  const response = await patch({ clientId: 'client-a', thinkingDisplay: 'summarized' });
  assert.equal(response.body.thinkingDisplay, 'summarized');
  assert.equal(row().thinking_display, 'summarized', 'the default is stored explicitly');

  await patch({ clientId: 'client-a', thinkingEnabled: true });
  assert.equal(row().thinking_enabled, 1);
});

test('a composer write that mentions no thinking key must not reset either axis', async () => {
  const { patch, row } = setup();

  await patch({ clientId: 'client-a', thinkingEnabled: false, thinkingDisplay: 'omitted' });

  const response = await patch({
    clientId: 'client-b',
    preferredRelayMode: 'agent',
    preferredModel: '',
    preferredReasoningEffort: '',
  });
  assert.equal(response.body.thinkingEnabled, false, 'echoed from storage even when unmentioned');
  assert.equal(response.body.thinkingDisplay, 'omitted');

  const stored = row();
  assert.equal(stored.thinking_enabled, 0, 'a composer write must not re-enable thinking');
  assert.equal(stored.thinking_display, 'omitted');
});

test('the broadcast carries the merged thinking state', async () => {
  const { patch, emitted } = setup();

  await patch({ clientId: 'client-a', thinkingEnabled: false });
  const update = emitted.find(([event]) => event === 'conversation_preferences_updated');
  assert.ok(update);
  assert.equal(update[1].thinkingEnabled, false);
  assert.equal(update[1].thinkingDisplay, 'summarized');
  assert.equal(update[1].preferredModel, 'claude-opus-5');
});

// ---------------------------------------------------------------------------
// GET /api/context: the window the running CLI has against the stored one

test('the context payload reports the running CLI\'s window, why a change waits, and the model limit', async () => {
  const { db, stmts, patch, getContext, sessionWorkerRegistry } = setup();
  db.prepare(`
    INSERT INTO runtime_sessions (id, conversation_id, sdk_session_id, runtime_key, provider_type, provider_model, created_at, last_used_at)
    VALUES ('rs-1', ?, ?, 'rk-1', 'claude', 'claude-opus-5[1m]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run(CONV, CONV);

  // Nothing captured, no worker: every new field is null.
  const empty = await getContext();
  assert.equal(empty.body.activeAutoCompactWindow, null);
  assert.equal(empty.body.autoCompactWindowDeferred, null);
  assert.equal(empty.body.modelContextLimit, null);

  stmts.updateRuntimeSessionContextUsage.run(JSON.stringify({
    model: 'claude-opus-5[1m]',
    contextUsage: { totalTokens: 60900, maxTokens: 100000, rawMaxTokens: 100000, categories: [] },
    modelUsage: { 'claude-opus-5[1m]': { inputTokens: 1, outputTokens: 1, contextWindow: 1000000 } },
  }), '2026-01-01T00:00:00.000Z', CONV);
  await patch({ clientId: 'client-a', autoCompactWindow: 200000 });
  const steering = (overrides = {}) => ({
    turnActive: false, canSteer: false, holdReason: null, messageId: null, supported: true,
    autoCompactWindow: { active: 100000, backgroundWork: false },
    ...overrides,
  });
  sessionWorkerRegistry.upsertWorker({ sdkSessionId: CONV, status: 'ready', steering: steering() });

  const idle = await getContext();
  assert.equal(idle.body.autoCompactWindow, 200000);
  assert.equal(idle.body.activeAutoCompactWindow, 100000);
  assert.equal(idle.body.autoCompactWindowDeferred, 'next-message');
  assert.equal(idle.body.modelContextLimit, 1000000);
  assert.equal(idle.body.snapshot.max_context_tokens, 100000);

  sessionWorkerRegistry.upsertWorker({ ...sessionWorkerRegistry.getWorker(CONV), steering: steering({ turnActive: true }) });
  assert.equal((await getContext()).body.autoCompactWindowDeferred, 'turn');

  sessionWorkerRegistry.upsertWorker({
    ...sessionWorkerRegistry.getWorker(CONV),
    steering: steering({ autoCompactWindow: { active: 100000, backgroundWork: true } }),
  });
  assert.equal((await getContext()).body.autoCompactWindowDeferred, 'background');

  // An older worker reports no window: nothing to compare against.
  sessionWorkerRegistry.upsertWorker({
    ...sessionWorkerRegistry.getWorker(CONV),
    steering: steering({ autoCompactWindow: undefined }),
  });
  const legacy = await getContext();
  assert.equal(legacy.body.activeAutoCompactWindow, null);
  assert.equal(legacy.body.autoCompactWindowDeferred, null);
});
