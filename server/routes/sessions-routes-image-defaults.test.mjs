import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createImageConversationRepository } from '../repositories/image-conversation-repository.mjs';
import { registerSessionsRoutes } from './sessions-routes.mjs';

// update_session `image`: an OpenAI image session's defaults, stored per
// conversation (image_sessions.defaults_json) through PATCH
// /api/conversation/:id/settings, checked against the session's model; any
// other session is refused, nothing changed.

const CATALOG = Object.freeze({
  models: ['auto', 'gpt-5.4-mini'],
  currentModel: 'gpt-5.4-mini',
  defaultModel: 'gpt-5.4-mini',
  reasoningByModel: { 'gpt-5.4-mini': ['none', 'low'] },
});
const OPENAI_ON = Object.freeze({ configured: true, enabled: true, model: 'gpt-image-2', models: ['gpt-image-2', 'dall-e-3', 'gpt-5'] });

function createMockApp() {
  const routes = new Map();
  const record = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers[handlers.length - 1]);
  return { routes, get: record('GET'), post: record('POST'), patch: record('PATCH'), put: record('PUT'), delete: record('DELETE'), use() {} };
}

function setup({ modelState = CATALOG, openAISettings = OPENAI_ON } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db), ...createImageConversationRepository(db) };
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
    await handler({ body, headers: {}, query, params, socket: {} }, res);
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
  return { db, stmts, call, bootstrap, conversationOn, row };
}


const settings = (fx, id, image, extra = {}) => fx.call('PATCH /api/conversation/:id/settings', { params: { id }, body: { settings: { image }, ...extra } });

test('image defaults are stored for an image session and listed in changed, on the dry run too', async () => {
  const fx = setup();
  const id = await fx.conversationOn('openai', 'gpt-image-2');
  const dry = await settings(fx, id, { size: '1536x1024', quality: 'low' }, { dry_run: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.deepEqual(dry.body.changed, ['image']);
  assert.deepEqual(fx.stmts.readConversationImageDefaults(id), {});

  const set = await settings(fx, id, { size: '1536x1024', quality: 'low' });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body.changed, ['image']);
  assert.deepEqual(set.body.settings.image, { size: '1536x1024', quality: 'low' });
  assert.deepEqual(fx.stmts.readConversationImageDefaults(id), { size: '1536x1024', quality: 'low' });

  // What is named replaces its value; the rest stays.
  const more = await settings(fx, id, { quality: 'high', count: 2 });
  assert.deepEqual(more.body.changed, ['image']);
  assert.deepEqual(fx.stmts.readConversationImageDefaults(id), { size: '1536x1024', quality: 'high', count: 2 });
  // The same values again change nothing.
  const same = await settings(fx, id, { quality: 'high' });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.changed, []);
  // Every image session of the conversation carries the copy.
  const rows = fx.db.prepare('SELECT defaults_json FROM image_sessions WHERE conversation_id = ?').all(id);
  assert.equal(rows.length, 1);
});

test('image defaults are refused for a session that makes no images, and checked against the model', async () => {
  const fx = setup();
  for (const [provider, model] of [['openai', 'gpt-5'], ['claude', 'claude-sonnet-5'], ['github', 'gpt-5.4-mini']]) {
    const id = await fx.conversationOn(provider, model);
    for (const dryRun of [true, false]) {
      const refused = await settings(fx, id, { size: '1024x1024' }, dryRun ? { dry_run: true } : {});
      assert.equal(refused.status, 400, `${provider} ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, 'IMAGE_INPUT_REFUSED');
      assert.equal(refused.body.error, `Image defaults go to an OpenAI image session; this session runs ${model}. Nothing was changed.`);
    }
    assert.deepEqual(fx.stmts.readConversationImageDefaults(id), {});
  }
  const dalle = await fx.conversationOn('openai', 'dall-e-3');
  const wrong = await settings(fx, dalle, { size: '1536x1024' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, 'IMAGE_INPUT_REFUSED');
  assert.match(wrong.body.error, /size must be one of: 1024x1024, 1792x1024, 1024x1792 for dall-e-3\. Nothing was changed\./);
  // A model the same call moves to counts.
  const both = await fx.call('PATCH /api/conversation/:id/settings', { params: { id: dalle }, body: { settings: { model: 'gpt-image-2', image: { size: '1536x1024' } } } });
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.deepEqual(both.body.changed, ['model', 'image']);
});
