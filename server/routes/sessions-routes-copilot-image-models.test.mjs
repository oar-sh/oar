import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { registerSessionsRoutes, withoutCopilotImageModels } from './sessions-routes.mjs';
import { asOwner } from '../services/relay-principal-test-harness.mjs';

// Copilot lists image ids (gpt-image-*, dall-e-*) its runtime cannot serve:
// they are not offered for Copilot, and a Copilot chat on one is refused at
// creation and on a model switch. The OpenAI provider keeps them.

const COPILOT_CATALOG = Object.freeze({
  models: ['auto', 'gpt-5.4-mini', 'gpt-image-1', 'dall-e-3'],
  currentModel: 'gpt-5.4-mini',
  defaultModel: 'gpt-5.4-mini',
  reasoningByModel: { 'gpt-5.4-mini': ['none', 'low'], 'gpt-image-1': ['none'], 'dall-e-3': ['none'] },
  contextLimitsByModel: { 'gpt-5.4-mini': 128000, 'gpt-image-1': 8000 },
  modelMetadataByModel: { 'gpt-5.4-mini': { provider: 'github-copilot' }, 'gpt-image-1': { provider: 'github-copilot' } },
  unavailableModels: ['dall-e-3'],
});
const OPENAI_ON = Object.freeze({ configured: true, enabled: true, model: 'gpt-4o', models: ['gpt-4o', 'gpt-image-1'] });
const OPENAI_OFF = Object.freeze({ configured: false, enabled: false, model: 'gpt-4o', models: [] });
const NEEDS_OPENAI = 'IMAGE_MODEL_NEEDS_OPENAI';

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

function setup({ modelState = COPILOT_CATALOG, openAISettings = OPENAI_ON } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const app = createMockApp();
  const deps = {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
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
    queueCounts: () => ({ pendingCount: 0, processingCount: 0, parkedCount: 0 }),
    getModelCatalogState: () => modelState,
    updateModelCatalog: () => modelState,
    listModelVariantRows: () => [],
    refreshModelVariantCatalogFromCli: async () => modelState,
    setEnabledModelVariants: () => modelState,
    getOpenAIProviderSettings: () => openAISettings,
    SUPPORTED_REASONING_EFFORTS: ['none', 'low', 'medium', 'high'],
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => ({ recentWorkspaceRoots: [] }),
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
    workspaceRootAllowList: [],
    processingTimeoutMs: 0,
    localhostOnly: false,
    listenHost: '127.0.0.1',
    ensureSessionId: () => 'client-1',
    touchCli: () => {},
    markCliOffline: () => {},
    fetchUsageSummary: () => {},
    ensureRuntimeSessionBinding: () => ({ id: 'runtime-session-1' }),
    bootstrapRuntimeSessionBindings: () => ({ ok: true }),
    configuredConversationSessionMode: 'conversation-bound',
    SUPPORTED_RELAY_MODES: ['agent', 'ask', 'plan'],
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
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
  };
  registerSessionsRoutes(app, deps);

  const call = async (key, { body = {}, params = {}, query = {} } = {}) => {
    const handler = app.routes.get(key);
    assert.ok(handler, `${key} should be registered`);
    const captured = { status: 200, body: null };
    const res = {
      setHeader() {},
      set() {},
      status(code) { captured.status = code; return res; },
      json(payload) { captured.body = payload; return res; },
    };
    await handler(asOwner({ body, headers: {}, query, params, socket: {} }), res);
    return captured;
  };
  const bootstrap = (body) => call('POST /api/conversation/bootstrap', { body: { title: 'Poster draft', relayMode: 'agent', ...body } });
  // A conversation whose runtime row names `provider`, as a launched one has.
  const conversationOn = async (provider, model) => {
    const created = await bootstrap({});
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.conversationId;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO runtime_sessions (id, conversation_id, runtime_key, model, provider_type, provider_model, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(`rt-${id}`, id, `key-${id}`, model, provider, model, now, now);
    return id;
  };
  const row = (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  return { call, bootstrap, conversationOn, row };
}

// ─── The catalog ─────────────────────────────────────────────────────────────

test('the Copilot catalog drops its image ids, and every map keyed by them', () => {
  const filtered = withoutCopilotImageModels({ ...COPILOT_CATALOG, providersByModel: { 'gpt-image-1': ['github-copilot'], 'gpt-5.4-mini': ['github-copilot'] } });
  assert.deepEqual(filtered.models, ['auto', 'gpt-5.4-mini']);
  assert.deepEqual(Object.keys(filtered.reasoningByModel), ['gpt-5.4-mini']);
  assert.deepEqual(Object.keys(filtered.contextLimitsByModel), ['gpt-5.4-mini']);
  assert.deepEqual(Object.keys(filtered.modelMetadataByModel), ['gpt-5.4-mini']);
  assert.deepEqual(Object.keys(filtered.providersByModel), ['gpt-5.4-mini']);
  assert.deepEqual(filtered.unavailableModels, []);
  assert.equal(filtered.currentModel, 'gpt-5.4-mini');
  // A current model that makes images falls back to the list's first.
  assert.equal(withoutCopilotImageModels({ models: ['auto', 'gpt-image-1'], currentModel: 'gpt-image-1' }).currentModel, 'auto');
  // Nothing to drop: the same object.
  const plain = { models: ['auto', 'gpt-5.4-mini'] };
  assert.equal(withoutCopilotImageModels(plain), plain);
});

test('GET /api/models: no image id for Copilot; the OpenAI provider keeps the ones it lists', async () => {
  const off = setup({ openAISettings: OPENAI_OFF });
  const copilotOnly = await off.call('GET /api/models');
  assert.deepEqual(copilotOnly.body.models, ['auto', 'gpt-5.4-mini']);
  assert.equal(copilotOnly.body.reasoningByModel['gpt-image-1'], undefined);
  assert.equal(copilotOnly.body.modelMetadataByModel['gpt-image-1'], undefined);

  const on = setup({ openAISettings: OPENAI_ON });
  const merged = await on.call('GET /api/models');
  assert.ok(merged.body.models.includes('gpt-image-1'));
  assert.equal(merged.body.models.includes('dall-e-3'), false, 'listed by Copilot only');
  assert.deepEqual(merged.body.providersByModel['gpt-image-1'], ['openai-byok']);
  assert.equal(merged.body.modelMetadataByModel['gpt-image-1'].provider, 'openai-byok');
  assert.equal(merged.body.reasoningByProvider.github['gpt-image-1'], undefined);

  const status = await on.call('GET /api/status');
  assert.deepEqual(status.body.supportedModels, ['auto', 'gpt-5.4-mini']);
});

// ─── Creation ────────────────────────────────────────────────────────────────

test('bootstrap refuses a Copilot chat on an image model, whether OpenAI lists it or not', async () => {
  for (const openAISettings of [OPENAI_ON, OPENAI_OFF]) {
    const fx = setup({ openAISettings });
    for (const model of ['gpt-image-1', 'dall-e-3']) {
      const refused = await fx.bootstrap({ providerType: 'github', model });
      assert.equal(refused.status, 400, `${model}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, NEEDS_OPENAI);
      assert.equal(refused.body.error, `"${model}" makes images: start an OpenAI Image chat (provider openai) for it.`);
    }
  }
});

test('a Copilot chat on a text model and an OpenAI chat on an image model start as before', async () => {
  const fx = setup();
  const copilot = await fx.bootstrap({ providerType: 'github', model: 'gpt-5.4-mini' });
  assert.equal(copilot.status, 200, JSON.stringify(copilot.body));
  assert.equal(copilot.body.selectedModel, 'gpt-5.4-mini');
  const image = await fx.bootstrap({ providerType: 'openai', model: 'gpt-image-1' });
  assert.equal(image.status, 200, JSON.stringify(image.body));
  assert.equal(image.body.selectedModel, 'gpt-image-1');
  assert.equal(image.body.selectedProviderType, 'openai');
  // No provider named: the model picks OpenAI, which lists it.
  const inferred = await fx.bootstrap({ model: 'gpt-image-1' });
  assert.equal(inferred.status, 200, JSON.stringify(inferred.body));
  assert.equal(inferred.body.selectedProviderType, 'openai');
});

// ─── Model switch ────────────────────────────────────────────────────────────

test('update_session cannot move a Copilot chat to an image model; an OpenAI chat may', async () => {
  const fx = setup();
  const copilot = await fx.conversationOn('github', 'gpt-5.4-mini');
  const refused = await fx.call('PATCH /api/conversation/:id/settings', { params: { id: copilot }, body: { settings: { model: 'gpt-image-1' } } });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, NEEDS_OPENAI);
  assert.equal(refused.body.error, '"gpt-image-1" makes images: start an OpenAI Image chat (provider openai) for it. Nothing was changed.');
  assert.notEqual(fx.row(copilot).preferred_model, 'gpt-image-1');

  const image = await fx.conversationOn('openai', 'gpt-image-1');
  const switched = await fx.call('PATCH /api/conversation/:id/settings', { params: { id: image }, body: { settings: { model: 'dall-e-3' } } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.deepEqual(switched.body.changed, ['model']);
  assert.equal(fx.row(image).preferred_model, 'dall-e-3');
});

test('the composer\'s preferences cannot move a Copilot chat to an image model; other writes pass', async () => {
  const fx = setup();
  const copilot = await fx.conversationOn('github', 'gpt-5.4-mini');
  const refused = await fx.call('PATCH /api/conversation/:id/preferences', { params: { id: copilot }, body: { preferredModel: 'dall-e-3' } });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.code, NEEDS_OPENAI);
  const text = await fx.call('PATCH /api/conversation/:id/preferences', { params: { id: copilot }, body: { preferredModel: 'gpt-5.4-mini', preferredRelayMode: 'plan' } });
  assert.equal(text.status, 200, JSON.stringify(text.body));
  assert.equal(fx.row(copilot).preferred_model, 'gpt-5.4-mini');

  const image = await fx.conversationOn('openai', 'gpt-image-1');
  const switched = await fx.call('PATCH /api/conversation/:id/preferences', { params: { id: image }, body: { preferredModel: 'dall-e-3' } });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(fx.row(image).preferred_model, 'dall-e-3');
});
