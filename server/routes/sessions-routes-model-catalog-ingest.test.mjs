// The catalog routes over the REAL model-variant catalog service (in-memory
// database), fed the live raw Copilot catalog the way the SDK worker posts it:
// POST /api/models/snapshot → GET /api/models / GET /api/model-variants.
// The sibling sessions-routes-model-variants-refresh.test.mjs mocks the
// catalog; this one pins the truthfulness of what reaches the API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';

import { registerSessionsRoutes } from './sessions-routes.mjs';
import { applySchema } from '../db-schema.mjs';
import { createModelVariantCatalogService } from '../services/model-variant-catalog-service.mjs';
import { buildModelSnapshotFields, extractModelDescriptors } from '../../shared/model-descriptors.mjs';
import { sortCopilotModels } from '../../shared/copilot-model-order.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../shared/fixtures/copilot-catalog-raw-2026-09-07.json', import.meta.url), 'utf8'));
const CURATED = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'claude-sonnet-4.6', 'claude-haiku-4.5'];

function createMockApp() {
  const routes = new Map();
  const register = (method) => (path, ...handlers) => { routes.set(`${method} ${path}`, handlers); };
  return { routes, get: register('GET'), post: register('POST'), patch: register('PATCH'), put: register('PUT'), delete: register('DELETE') };
}

function createHarness() {
  const db = new Database(':memory:');
  applySchema(db);
  const catalog = createModelVariantCatalogService({ defaultModel: 'gpt-5.4-mini', curatedModelIds: CURATED });
  catalog.updateModelCatalog({ models: ['gpt-5.4-mini'], currentModel: 'gpt-5.4-mini', defaultModel: 'gpt-5.4-mini', source: 'bootstrap' });
  catalog.bindDatabase(db);

  const app = createMockApp();
  const ioEvents = [];
  const noopStmt = { run() {}, get() { return null; }, all() { return []; } };
  registerSessionsRoutes(app, {
    auth: (_req, _res, next) => next(),
    io: { emit(event, payload) { ioEvents.push({ event, payload }); } },
    db: { prepare: () => noopStmt, transaction: (fn) => (...args) => fn(...args) },
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
    getModelCatalogState: catalog.getModelCatalogState,
    updateModelCatalog: catalog.updateModelCatalog,
    listModelVariantRows: catalog.listModelVariantRows,
    refreshModelVariantCatalogFromCli: catalog.refreshModelVariantCatalogFromCli,
    setEnabledModelVariants: catalog.setEnabledModelVariants,
    SUPPORTED_REASONING_EFFORTS: catalog.SUPPORTED_REASONING_EFFORTS,
    buildRelayReadyBannerData: () => ({}),
    workspaceRootPayload: () => null,
    setWorkspaceRoot: () => ({ changed: false }),
    setDefaultSessionWorkspaceRootPath: () => ({ changed: false }),
    resolveConversationWorkspaceState: () => ({}),
    updateConversationConfiguredWorkspaceRoot: () => ({ changed: false }),
    learnConversationWorkspaceRoot: () => ({ learned: false }),
    setPendingSessionCwd: () => null,
    consumePendingSessionCwd: () => null,
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
    SUPPORTED_RELAY_MODES: ['agent'],
    DEFAULT_RELAY_MODE: 'agent',
    SUPPORTED_CONVERSATION_SESSION_MODES: ['conversation-bound'],
    DEFAULT_CONVERSATION_SESSION_MODE: 'conversation-bound',
    DEFAULT_MODEL: 'gpt-5.4-mini',
    remotePath: () => null,
    computeRetryDelayMs: () => 0,
    relayRestartOrchestrator: null,
    relayBridgeOwnerService: null,
    featureFlags: {},
    sessionWorkerSupervisor: null,
    sessionWorkerRegistry: null,
    resolveSessionStateRoot: () => null,
  });
  return { app, ioEvents, catalog };
}

async function callRoute(app, key, body = {}) {
  const handlers = app.routes.get(key);
  assert.ok(handlers, `${key} should be registered`);
  const response = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  for (const handler of handlers) {
    let nextCalled = false;
    await handler({ headers: {}, query: {}, params: {}, body }, response, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return response;
}

/** Exactly the seven keys the SDK worker posts, from the live raw list. */
function workerSnapshotBody(source = 'copilot-sdk-worker:session-start') {
  return {
    source,
    ...buildModelSnapshotFields(extractModelDescriptors(FIXTURE)),
    currentModel: 'gpt-5.4-mini',
    defaultModel: 'gpt-5.4-mini',
    error: null,
  };
}

test('POST /api/models/snapshot with the raw fixture makes GET /api/models report per-model efforts', async () => {
  const { app, ioEvents } = createHarness();
  const posted = await callRoute(app, 'POST /api/models/snapshot', workerSnapshotBody());
  assert.equal(posted.statusCode, 200);
  assert.equal(posted.body.ok, true);
  assert.equal(ioEvents.some((event) => event.event === 'models_updated'), true);

  const response = await callRoute(app, 'GET /api/models');
  assert.equal(response.statusCode, 200);
  const { reasoningByModel } = response.body;
  assert.deepEqual(reasoningByModel['gpt-5.4-mini'], ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(reasoningByModel['gemini-3.6-flash'], ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(reasoningByModel['claude-haiku-4.5'], ['none']);
  assert.deepEqual(reasoningByModel['claude-sonnet-5'], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(response.body.reasoningEfforts.includes('minimal'), true);
  assert.equal(response.body.metadataValid, true);
  assert.equal(response.body.source, 'copilot-sdk-worker:session-start');
  // The socket payload carries the same map.
  const broadcast = ioEvents.find((event) => event.event === 'models_updated').payload;
  assert.deepEqual(broadcast.reasoningByModel['gpt-5.4-mini'], reasoningByModel['gpt-5.4-mini']);
  assert.equal(broadcast.modelMetadataByModel['gpt-5.4-mini'].contextWindowTokens, 400_000);
});

test('GET /api/models lists models in canonical Copilot order and echoes the metadata contract', async () => {
  const { app, catalog } = createHarness();
  await callRoute(app, 'POST /api/models/snapshot', workerSnapshotBody());
  // Enable every variant so the whole catalog shows in models[].
  await callRoute(app, 'PATCH /api/model-variants', {
    enabledVariantIds: catalog.listModelVariantRows().map((row) => row.variantId),
  });
  const response = await callRoute(app, 'GET /api/models');
  const expected = sortCopilotModels(extractModelDescriptors(FIXTURE)).map((entry) => entry.modelId);
  // claude-sonnet-4.6 (a curated seed the runtime no longer lists) stays
  // listed as an enabled-but-unavailable model, in its canonical slot.
  assert.deepEqual(response.body.models.filter((id) => id !== 'claude-sonnet-4.6'), ['auto', ...expected]);
  assert.deepEqual(response.body.unavailableModels, ['claude-sonnet-4.6']);
  const metadata = response.body.modelMetadataByModel;
  assert.deepEqual(metadata['gpt-5.4-mini'], {
    defaultContextLimitTokens: 400_000,
    longContextLimitTokens: null,
    pricing: { default: { input: 75, output: 450, cacheRead: 7.5, cacheWrite: 0, batchSize: 1_000_000 }, longContext: null },
    displayName: 'GPT-5.4 mini',
    vendor: 'OpenAI',
    pickerCategory: 'lightweight',
    preview: false,
    contextWindowTokens: 400_000,
    maxPromptTokens: 272_000,
    supportedEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    catalogIndex: 6,
  });
  assert.equal(metadata['claude-haiku-4.5'].contextWindowTokens, 144_000);
  assert.equal(metadata['claude-haiku-4.5'].supportedEfforts, null);
  assert.equal(response.body.contextLimitsByModel['claude-haiku-4.5'], 144_000);
  assert.equal(metadata['claude-opus-4.8-fast'].preview, true);
  assert.equal(metadata['kimi-k3'].vendor, 'Moonshot AI');
  assert.equal(metadata['gpt-6-astra'].catalogIndex, 0);
  // Provider-enriched payload keys are still there, untouched.
  assert.equal(typeof response.body.providersByModel, 'object');
});

test('GET /api/model-variants exposes canonical sortOrder, per-model variants and the same metadata', async () => {
  const { app } = createHarness();
  await callRoute(app, 'POST /api/models/snapshot', workerSnapshotBody());
  const response = await callRoute(app, 'GET /api/model-variants');
  assert.equal(response.statusCode, 200);
  const { variants } = response.body;
  const variantIdsOf = (base) => variants.filter((row) => row.baseModelId === base).map((row) => row.variantId);
  assert.deepEqual(variantIdsOf('gpt-5.4-mini'), ['gpt-5.4-mini-none', 'gpt-5.4-mini-low', 'gpt-5.4-mini-medium', 'gpt-5.4-mini-high', 'gpt-5.4-mini-xhigh']);
  assert.deepEqual(variantIdsOf('claude-haiku-4.5'), ['claude-haiku-4.5']);
  assert.deepEqual(variantIdsOf('kimi-k3'), ['kimi-k3-low', 'kimi-k3-high', 'kimi-k3-max']);
  // sortOrder is the canonical index, shared by a model's variants, monotonic.
  const sortOrderOf = (base) => new Set(variants.filter((row) => row.baseModelId === base).map((row) => row.sortOrder));
  assert.deepEqual([...sortOrderOf('gpt-6-astra')], [0]);
  assert.deepEqual([...sortOrderOf('gpt-5.4-mini')], [6]);
  for (let index = 1; index < variants.length; index += 1) {
    assert.ok(variants[index - 1].sortOrder <= variants[index].sortOrder);
  }
  // Variant fields kept; the richer metadata rides modelMetadataByModel.
  const terra = variants.find((row) => row.variantId === 'gpt-5.6-terra-medium');
  assert.equal(terra.provider, 'openai');
  assert.equal(terra.label, 'GPT-5.6-terra');
  assert.equal(terra.contextLimitTokens, 400_000);
  assert.equal(terra.longContextLimitTokens, 1_050_000);
  assert.equal(terra.releaseStatus, null);
  assert.equal(response.body.modelMetadataByModel['gpt-5.6-terra'].contextWindowTokens, 1_050_000);
  assert.deepEqual(response.body.reasoningByModel['gpt-5.6-terra'], ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  // The enabled-but-unavailable curated seed is still a variant row, flagged.
  const sonnet = variants.filter((row) => row.baseModelId === 'claude-sonnet-4.6');
  assert.ok(sonnet.length > 0);
  assert.ok(sonnet.every((row) => row.enabled && row.releaseStatus === 'unavailable'));
  assert.equal(variants.some((row) => row.baseModelId === 'grok-4.6'), true, 'grok-* no longer vanishes');
});

test('posting the same snapshot twice leaves sortOrder and rows unchanged', async () => {
  const { app } = createHarness();
  await callRoute(app, 'POST /api/models/snapshot', workerSnapshotBody());
  const first = (await callRoute(app, 'GET /api/model-variants')).body.variants
    .map((row) => [row.variantId, row.sortOrder, row.enabled, row.releaseStatus]);
  await callRoute(app, 'POST /api/models/snapshot', workerSnapshotBody('server-discovery:manual-refresh'));
  const second = (await callRoute(app, 'GET /api/model-variants')).body.variants
    .map((row) => [row.variantId, row.sortOrder, row.enabled, row.releaseStatus]);
  assert.deepEqual(second, first);
});

test('the snapshot route still reads exactly its seven keys; extra body keys are ignored', async () => {
  const { app } = createHarness();
  const body = { ...workerSnapshotBody(), reasoningByModel: { 'gpt-5.4-mini': ['bogus'] }, sortOrder: 99 };
  const posted = await callRoute(app, 'POST /api/models/snapshot', body);
  assert.equal(posted.statusCode, 200);
  const response = await callRoute(app, 'GET /api/models');
  assert.deepEqual(response.body.reasoningByModel['gpt-5.4-mini'], ['none', 'low', 'medium', 'high', 'xhigh']);
});
