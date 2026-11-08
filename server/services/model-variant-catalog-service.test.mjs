// The Copilot model catalog against an in-memory database: the live raw
// catalog (shared/fixtures) ingested the way a worker or the discovery service
// publishes it, then read back the way GET /api/models does. Spawn-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import {
  AUTHORITATIVE_SNAPSHOT_SOURCE_RE,
  FALLBACK_REASONING_EFFORTS,
  MODEL_METADATA_FIELDS,
  SUPPORTED_REASONING_EFFORTS,
  buildModelVariantEntries,
  createModelVariantCatalogService,
  effortsForModelVariants,
  mergeModelMetadata,
  normalizeModelMetadataByModel,
  normalizeReasoningEffort,
} from './model-variant-catalog-service.mjs';
import { buildModelSnapshotFields, extractModelDescriptors } from '../../shared/model-descriptors.mjs';
import { sortCopilotModels } from '../../shared/copilot-model-order.mjs';
import { createProviderModelStateStore } from './provider-model-state.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('../../shared/fixtures/copilot-catalog-raw-2026-09-07.json', import.meta.url), 'utf8'));
const CURATED = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'claude-sonnet-4.6', 'claude-haiku-4.5'];

function fixtureSnapshot(source = 'copilot-sdk-worker:session-start', overrides = {}) {
  return {
    ...buildModelSnapshotFields(extractModelDescriptors(FIXTURE)),
    currentModel: 'gpt-5.4-mini',
    defaultModel: 'gpt-5.4-mini',
    source,
    error: null,
    ...overrides,
  };
}

/** A service booted the way server-runtime boots it: bootstrap publish, then the DB. */
function bootService({ db = null, curatedModelIds = CURATED, runCopilotCliCommand } = {}) {
  const database = db || (() => { const d = new Database(':memory:'); applySchema(d); return d; })();
  const service = createModelVariantCatalogService({
    defaultModel: 'gpt-5.4-mini',
    curatedModelIds,
    runCopilotCliCommand,
  });
  service.updateModelCatalog({ models: ['gpt-5.4-mini'], currentModel: 'gpt-5.4-mini', defaultModel: 'gpt-5.4-mini', source: 'bootstrap' });
  service.bindDatabase(database);
  return { service, db: database };
}

const rowSummary = (service) => service.listModelVariantRows()
  .map((row) => [row.variantId, row.sortOrder, row.enabled, row.releaseStatus]);

test('the vocabulary carries minimal; the fallback ladder for undescribed models does not', () => {
  assert.deepEqual(SUPPORTED_REASONING_EFFORTS, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(normalizeReasoningEffort('MINIMAL'), 'minimal');
  assert.equal(normalizeReasoningEffort('ultra'), null);
  assert.deepEqual([...FALLBACK_REASONING_EFFORTS], ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('an empty catalog is seeded from the curated ids with the fallback ladder', () => {
  const { service } = bootService();
  const state = service.getModelCatalogState();
  assert.deepEqual(state.models, ['auto', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'claude-sonnet-4.6', 'claude-haiku-4.5']);
  assert.deepEqual(state.reasoningByModel['gpt-5.4-mini'], [...FALLBACK_REASONING_EFFORTS]);
  assert.equal(service.listModelVariantRows().length, CURATED.length * FALLBACK_REASONING_EFFORTS.length);
  // Seeds are numbered canonically too (OpenAI 5.4 > 5.4 mini > 5.3 codex, then Anthropic).
  assert.deepEqual(
    [...new Set(service.listModelVariantRows().map((row) => `${row.baseModelId}:${row.sortOrder}`))],
    ['gpt-5.4:0', 'gpt-5.4-mini:1', 'gpt-5.3-codex:2', 'claude-sonnet-4.6:3', 'claude-haiku-4.5:4'],
  );
  assert.deepEqual(state.unavailableModels, []);
});

test('ingesting the raw fixture yields per-model efforts, not a fabricated ladder', () => {
  const { service } = bootService();
  const state = service.updateModelCatalog(fixtureSnapshot());
  // Exactly the runtime's lists: no 'max' on 5.4 mini, 'minimal' on Gemini 3.6,
  // no 'none' on Claude.
  assert.deepEqual(state.reasoningByModel['gpt-5.4-mini'], ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(state.reasoningByModel['gemini-3.6-flash'], ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(state.reasoningByModel['claude-sonnet-5'], ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(state.reasoningByModel['kimi-k3'], ['low', 'high', 'max']);
  // Effort-less models keep the UI's "no effort control" convention.
  assert.deepEqual(state.reasoningByModel['claude-haiku-4.5'], ['none']);
  assert.deepEqual(state.reasoningByModel['kimi-k2.7-code'], ['none']);
  // The variant rows match: one per runtime level, a bare row for effort-less.
  const rows = service.listModelVariantRows();
  const variantsOf = (base) => rows.filter((row) => row.baseModelId === base).map((row) => row.variantId);
  assert.deepEqual(variantsOf('gpt-5.4-mini'), ['gpt-5.4-mini-none', 'gpt-5.4-mini-low', 'gpt-5.4-mini-medium', 'gpt-5.4-mini-high', 'gpt-5.4-mini-xhigh']);
  assert.deepEqual(variantsOf('claude-haiku-4.5'), ['claude-haiku-4.5']);
  assert.deepEqual(variantsOf('gemini-3.6-flash'), ['gemini-3.6-flash-minimal', 'gemini-3.6-flash-low', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-high']);
  // 'auto' unions everything.
  assert.deepEqual(state.reasoningByModel.auto, ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'minimal']);
  assert.equal(state.reasoningMetadataValid, true);
});

test('metadata round-trips through the rows, including the real context window', () => {
  const { service } = bootService();
  const state = service.updateModelCatalog(fixtureSnapshot());
  const mini = state.modelMetadataByModel['gpt-5.4-mini'];
  assert.deepEqual(Object.keys(mini), [...MODEL_METADATA_FIELDS]);
  assert.equal(mini.displayName, 'GPT-5.4 mini');
  assert.equal(mini.vendor, 'OpenAI');
  assert.equal(mini.pickerCategory, 'lightweight');
  assert.equal(mini.preview, false);
  assert.equal(mini.contextWindowTokens, 400_000);
  assert.equal(mini.maxPromptTokens, 272_000);
  assert.equal(mini.defaultContextLimitTokens, 400_000);
  assert.equal(mini.longContextLimitTokens, null);
  assert.equal(mini.pricing.default.input, 75);
  assert.equal(state.contextLimitsByModel['claude-haiku-4.5'], 144_000);
  const haiku = state.modelMetadataByModel['claude-haiku-4.5'];
  assert.equal(haiku.contextWindowTokens, 144_000);
  assert.equal(haiku.supportedEfforts, null);
  assert.equal(state.modelMetadataByModel['claude-opus-4.8-fast'].preview, true);
  assert.equal(state.modelMetadataByModel['gpt-5-mini'].vendor, 'Azure OpenAI');
  const terra = state.modelMetadataByModel['gpt-5.6-terra'];
  assert.equal(terra.contextWindowTokens, 1_050_000);
  assert.equal(terra.longContextLimitTokens, 1_050_000);
  assert.equal(terra.pricing.longContext.input, 400);
});

test('models[] and catalogIndex follow the canonical Copilot order', () => {
  const { service } = bootService({ curatedModelIds: [] });
  const state = service.updateModelCatalog(fixtureSnapshot());
  // Nothing is enabled on a fresh authoritative catalog, so enable everything
  // to read the full picker order back.
  service.setEnabledModelVariants(service.listModelVariantRows().map((row) => row.variantId));
  const enabledState = service.getModelCatalogState();
  const expected = sortCopilotModels(extractModelDescriptors(FIXTURE)).map((entry) => entry.modelId);
  assert.deepEqual(enabledState.models, ['auto', ...expected]);
  expected.forEach((modelId, index) => {
    assert.equal(enabledState.modelMetadataByModel[modelId].catalogIndex, index, modelId);
  });
  assert.equal(state.modelMetadataByModel['gpt-6-astra'].catalogIndex, 0);
  // Every variant row of a model shares its canonical index.
  const sortOrders = new Map();
  for (const row of service.listModelVariantRows()) {
    const seen = sortOrders.get(row.baseModelId);
    if (seen !== undefined) assert.equal(row.sortOrder, seen, row.variantId);
    sortOrders.set(row.baseModelId, row.sortOrder);
  }
  assert.equal(sortOrders.get('kimi-k2.7-code'), 26);
});

test('ingesting twice keeps sort_order stable and does not churn rows', () => {
  const { service } = bootService();
  service.updateModelCatalog(fixtureSnapshot('copilot-sdk-worker:session-start'));
  const first = rowSummary(service);
  service.updateModelCatalog(fixtureSnapshot('server-discovery:manual-refresh'));
  assert.deepEqual(rowSummary(service), first);
  // A later snapshot that lists the models in reverse order changes nothing.
  const reversed = fixtureSnapshot('copilot-sdk-worker:model-change');
  reversed.models = [...reversed.models].reverse();
  service.updateModelCatalog(reversed);
  assert.deepEqual(rowSummary(service), first);
  // And the numbering is dense over the whole table, never restarted per batch.
  const indices = [...new Set(service.listModelVariantRows().map((row) => row.sortOrder))].sort((a, b) => a - b);
  assert.deepEqual(indices, indices.map((_, i) => i));
});

test('a model introduced by a later snapshot slots into the canonical order', () => {
  const { service } = bootService({ curatedModelIds: [] });
  const partial = fixtureSnapshot();
  const withoutAstra = partial.models.filter((id) => id !== 'gpt-6-astra');
  service.updateModelCatalog({ ...partial, models: withoutAstra });
  const astraFree = service.listModelVariantRows().find((row) => row.baseModelId === 'gpt-6-astra');
  assert.equal(astraFree, undefined);
  assert.equal(service.listModelVariantRows().find((row) => row.baseModelId === 'gpt-5.6-sol').sortOrder, 0);

  service.updateModelCatalog(fixtureSnapshot('server-discovery:manual-refresh'));
  // gpt-6-astra is newest OpenAI: index 0, everything else shifts by one.
  assert.equal(service.listModelVariantRows().find((row) => row.baseModelId === 'gpt-6-astra').sortOrder, 0);
  assert.equal(service.listModelVariantRows().find((row) => row.baseModelId === 'gpt-5.6-sol').sortOrder, 1);
});

test('an authoritative snapshot marks absent curated models unavailable and keeps enabled ones listed', () => {
  const { service } = bootService();
  const state = service.updateModelCatalog(fixtureSnapshot());
  // claude-sonnet-4.6 is a curated seed the runtime no longer serves.
  assert.deepEqual(state.unavailableModels, ['claude-sonnet-4.6']);
  assert.ok(state.models.includes('claude-sonnet-4.6'), 'an enabled selection must not vanish');
  const sonnetRows = service.listModelVariantRows().filter((row) => row.baseModelId === 'claude-sonnet-4.6');
  assert.ok(sonnetRows.length > 0);
  assert.ok(sonnetRows.every((row) => row.releaseStatus === 'unavailable' && row.enabled));
  // Models the snapshot does list have their status cleared.
  assert.ok(service.listModelVariantRows()
    .filter((row) => row.baseModelId === 'gpt-5.4-mini')
    .every((row) => row.releaseStatus === null));
  // Once it comes back, the flag clears.
  const restored = fixtureSnapshot('copilot-sdk-worker:session-resume');
  restored.models = [...restored.models, 'claude-sonnet-4.6'];
  const next = service.updateModelCatalog(restored);
  assert.deepEqual(next.unavailableModels, []);
});

test('absent models that were disabled are pruned; a non-authoritative snapshot touches nothing', () => {
  const { service } = bootService();
  service.setEnabledModelVariants(['gpt-5.4-mini-none']);
  service.updateModelCatalog({ models: ['gpt-5.4-mini', 'gpt-4o'], source: 'bootstrap' });
  // bootstrap is not authoritative: gpt-4o was merely added, nothing marked.
  assert.equal(service.getModelCatalogState().unavailableModels.length, 0);
  assert.ok(service.listModelVariantRows().some((row) => row.baseModelId === 'gpt-4o'));

  service.updateModelCatalog(fixtureSnapshot());
  const bases = new Set(service.listModelVariantRows().map((row) => row.baseModelId));
  assert.equal(bases.has('gpt-4o'), false, 'disabled + absent is pruned');
  assert.equal(bases.has('claude-sonnet-4.6'), false, 'disabled curated seed is pruned too');
  assert.equal(bases.has('gpt-5.4-mini'), true);
});

test('a selected effort level the runtime dropped hands its selection to the model', () => {
  const { service } = bootService();
  // The seed gave gpt-5.4-mini a 'max' row and haiku six effort rows; the user
  // picked exactly those.
  service.setEnabledModelVariants(['gpt-5.4-mini-max', 'claude-haiku-4.5-high']);
  const state = service.updateModelCatalog(fixtureSnapshot());
  const rows = service.listModelVariantRows();
  assert.equal(rows.find((row) => row.variantId === 'gpt-5.4-mini-max'), undefined);
  assert.equal(rows.find((row) => row.variantId === 'claude-haiku-4.5-high'), undefined);
  // The models stay selectable through their first remaining row.
  assert.equal(rows.find((row) => row.variantId === 'gpt-5.4-mini-none').enabled, true);
  assert.equal(rows.find((row) => row.variantId === 'claude-haiku-4.5').enabled, true);
  assert.deepEqual(state.models, ['auto', 'gpt-5.4-mini', 'claude-haiku-4.5']);
});

test('persisted metadata survives a restart', () => {
  const { service, db } = bootService();
  service.updateModelCatalog(fixtureSnapshot());
  service.setEnabledModelVariants(['gpt-5.6-terra-medium', 'claude-haiku-4.5']);
  const before = service.getModelCatalogState();

  const restarted = createModelVariantCatalogService({ defaultModel: 'gpt-5.4-mini', curatedModelIds: CURATED });
  restarted.updateModelCatalog({ models: ['gpt-5.4-mini'], source: 'bootstrap' });
  restarted.bindDatabase(db);
  const after = restarted.getModelCatalogState();
  assert.deepEqual(after.models, before.models);
  assert.deepEqual(after.reasoningByModel, before.reasoningByModel);
  assert.deepEqual(after.modelMetadataByModel['gpt-5.6-terra'], before.modelMetadataByModel['gpt-5.6-terra']);
  assert.deepEqual(after.modelMetadataByModel['claude-haiku-4.5'], before.modelMetadataByModel['claude-haiku-4.5']);
  assert.deepEqual(rowSummary(restarted), rowSummary(service));
});

test('a poorer snapshot does not erase richer stored metadata', () => {
  const { service } = bootService();
  service.updateModelCatalog(fixtureSnapshot());
  // An extension-era snapshot: models + context limits only.
  const state = service.updateModelCatalog({
    models: ['gpt-5.4-mini'],
    contextLimitsByModel: { 'gpt-5.4-mini': 400_000 },
    modelMetadataByModel: { 'gpt-5.4-mini': { defaultContextLimitTokens: 400_000, longContextLimitTokens: null, pricing: null } },
    source: 'web-relay-extension:poll',
    error: null,
  });
  const mini = state.modelMetadataByModel['gpt-5.4-mini'];
  assert.equal(mini.vendor, 'OpenAI');
  assert.equal(mini.contextWindowTokens, 400_000);
  assert.deepEqual(mini.supportedEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(mini.pricing.default.input, 75);
});

test('the manual CLI refresh keeps runtime-reported efforts and only falls back for undescribed models', async () => {
  const { service } = bootService();
  service.updateModelCatalog(fixtureSnapshot());
  service.setEnabledModelVariants(['gpt-5.4-mini-none']);
  const helpText = 'Reasoning effort: "low", "medium", "high"';
  const refreshed = await service.refreshModelVariantCatalogFromCli();
  assert.equal(refreshed.source, 'rpc-snapshot');
  const state = service.getModelCatalogState();
  assert.deepEqual(state.reasoningByModel['gpt-5.4-mini'], ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(state.reasoningByModel['claude-haiku-4.5'], ['none']);
  assert.deepEqual(state.reasoningByModel['gemini-3.6-flash'], ['minimal', 'low', 'medium', 'high']);

  // A relay with no authoritative snapshot yet: only its bootstrap default is
  // known and nobody has described it, so the `copilot help` ladder applies.
  // (The in-memory catalog always carries a current/default model, so the
  // refresh selects them as 'rpc-snapshot' rather than reading help config.)
  const fresh = createModelVariantCatalogService({
    defaultModel: 'gpt-5.4-mini',
    curatedModelIds: [],
    runCopilotCliCommand: async () => helpText,
  });
  const db = new Database(':memory:');
  applySchema(db);
  fresh.bindDatabase(db);
  const helpState = await fresh.refreshModelVariantCatalogFromCli();
  assert.equal(helpState.source, 'rpc-snapshot');
  assert.deepEqual(fresh.getModelCatalogState().reasoningByModel['gpt-5.4-mini'], ['low', 'medium', 'high']);
});

test('listVariants orders by canonical index first, then effort ladder within a model', () => {
  const { service } = bootService({ curatedModelIds: [] });
  service.updateModelCatalog(fixtureSnapshot());
  const rows = service.listModelVariantRows();
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(rows[index - 1].sortOrder <= rows[index].sortOrder, `${rows[index - 1].variantId} before ${rows[index].variantId}`);
  }
  const sol = rows.filter((row) => row.baseModelId === 'gpt-5.6-sol').map((row) => row.reasoningEffort);
  assert.deepEqual(sol, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test('normalizeModelMetadataByModel validates the contract fields and keeps metadata-only entries', () => {
  const normalized = normalizeModelMetadataByModel({
    'GPT-5.4-mini': {
      displayName: '  GPT-5.4 mini  ',
      vendor: 'OpenAI',
      pickerCategory: 'Lightweight',
      preview: 'yes',
      contextWindowTokens: '400000',
      maxPromptTokens: -1,
      supportedEfforts: ['none', 'LOW', 'ultra', 'low'],
      catalogIndex: 3,
    },
    'claude-haiku-4.5': { supportedEfforts: null },
    'claude-opus-5': { defaultContextLimitTokens: null, longContextLimitTokens: null, pricing: null },
    'not a model': { vendor: 'x' },
  });
  assert.deepEqual(Object.keys(normalized), ['gpt-5.4-mini', 'claude-haiku-4.5']);
  const mini = normalized['gpt-5.4-mini'];
  assert.equal(mini.displayName, 'GPT-5.4 mini');
  assert.equal(mini.pickerCategory, 'lightweight');
  assert.equal(mini.preview, false);
  assert.equal(mini.contextWindowTokens, 400_000);
  assert.equal(mini.maxPromptTokens, null);
  assert.deepEqual(mini.supportedEfforts, ['none', 'low']);
  assert.equal(mini.catalogIndex, 3);
  // Effort-less is a statement (null), distinct from "nothing said" (absent).
  assert.equal(normalized['claude-haiku-4.5'].supportedEfforts, null);
  assert.equal(Object.prototype.hasOwnProperty.call(normalized['claude-haiku-4.5'], 'supportedEfforts'), true);
});

test('effortsForModelVariants: known list, effort-less, or the fallback for gpt-/claude- only', () => {
  assert.deepEqual(effortsForModelVariants('gpt-5.4-mini', { supportedEfforts: ['none', 'low'] }), ['none', 'low']);
  assert.equal(effortsForModelVariants('claude-haiku-4.5', { supportedEfforts: null }), null);
  assert.deepEqual(effortsForModelVariants('gpt-5.4', {}), [...FALLBACK_REASONING_EFFORTS]);
  assert.deepEqual(effortsForModelVariants('claude-opus-5', undefined, ['low', 'high']), ['low', 'high']);
  assert.equal(effortsForModelVariants('gemini-3.6-flash', {}), null);
  assert.equal(effortsForModelVariants('kimi-k3', null), null);
});

test('buildModelVariantEntries emits one row per known effort and a bare row for effort-less models', () => {
  const entries = buildModelVariantEntries(['gemini-3.6-flash', 'claude-haiku-4.5', 'gpt-5.4'], {
    defaultEnabled: false,
    modelMetadataByModel: {
      'gemini-3.6-flash': { supportedEfforts: ['minimal', 'low'], vendor: 'Google' },
      'claude-haiku-4.5': { supportedEfforts: null, contextWindowTokens: 144_000 },
    },
  });
  assert.deepEqual(entries.map((entry) => entry.variantId), [
    'gemini-3.6-flash-minimal', 'gemini-3.6-flash-low',
    'claude-haiku-4.5',
    ...FALLBACK_REASONING_EFFORTS.map((effort) => `gpt-5.4-${effort}`),
  ]);
  assert.deepEqual(entries.map((entry) => entry.sortOrder), [0, 0, 1, 2, 2, 2, 2, 2, 2]);
  assert.equal(entries[0].metadata.vendor, 'Google');
  assert.equal(entries[2].label, 'Haiku 4.5', 'the composer\'s humanized id, not the runtime display name');
});

test('mergeModelMetadata keeps richer stored fields but lets the runtime restate efforts', () => {
  const stored = { vendor: 'OpenAI', contextWindowTokens: 400_000, supportedEfforts: ['none', 'low', 'max'], preview: false };
  const merged = mergeModelMetadata(stored, { vendor: null, displayName: 'GPT-5.4 mini', supportedEfforts: ['none', 'low'], catalogIndex: 9 });
  assert.equal(merged.vendor, 'OpenAI');
  assert.equal(merged.displayName, 'GPT-5.4 mini');
  assert.deepEqual(merged.supportedEfforts, ['none', 'low']);
  assert.equal('catalogIndex' in merged, false);
  // Saying nothing about efforts leaves them alone; saying "none" (null) resets.
  assert.deepEqual(mergeModelMetadata(stored, { vendor: 'x' }).supportedEfforts, ['none', 'low', 'max']);
  assert.equal(mergeModelMetadata(stored, { supportedEfforts: null }).supportedEfforts, null);
});

test('authoritative sources are the runtime-backed publishers only', () => {
  for (const source of ['copilot-sdk-worker:session-start', 'server-discovery:boot', 'standalone-relay:startup', 'web-relay-extension:poll']) {
    assert.equal(AUTHORITATIVE_SNAPSHOT_SOURCE_RE.test(source), true, source);
  }
  for (const source of ['bootstrap', 'rpc-snapshot', 'help-fallback', 'manual-refresh', '']) {
    assert.equal(AUTHORITATIVE_SNAPSHOT_SOURCE_RE.test(source), false, source);
  }
});

// ─── The Copilot model map ──────────────────────────────────────────────────

function bootServiceWithModelState({ settings = new Map(), newModels = [], snapshots = [] } = {}) {
  const store = createProviderModelStateStore({
    readSetting: (key) => settings.get(key) ?? '',
    writeSetting: (key, value) => { settings.set(key, String(value)); },
  });
  const database = new Database(':memory:');
  applySchema(database);
  const service = createModelVariantCatalogService({
    defaultModel: 'gpt-5.4-mini',
    curatedModelIds: CURATED,
    modelStateStore: store,
    onNewModels: (ids, on) => newModels.push({ ids, on }),
    onAuthoritativeSnapshot: ({ source }) => snapshots.push(source),
  });
  service.updateModelCatalog({ models: ['gpt-5.4-mini'], currentModel: 'gpt-5.4-mini', defaultModel: 'gpt-5.4-mini', source: 'bootstrap' });
  service.bindDatabase(database);
  return { service, store, settings, newModels, snapshots };
}

const enabledOf = (service, variantId) => service.listModelVariantRows().find((row) => row.variantId === variantId)?.enabled;

test('model map: the upgrade knows the table and keeps what is visible', () => {
  const { service, store } = bootServiceWithModelState();
  const state = store.readCopilot();
  assert.deepEqual(state.knownModels, [...new Set(service.listModelVariantRows().map((row) => row.baseModelId))]);
  assert.deepEqual(state.disabledVariants, []);
  assert.equal(state.autoEnableNew, true);
  assert.deepEqual(service.getCopilotModelState(), { autoEnableNew: true, unseen: [] });
});

test('model map: a whole new model follows the switch, is flagged new and reported', () => {
  const { service, newModels, snapshots } = bootServiceWithModelState();
  service.updateModelCatalog({ models: ['gpt-5.4-mini', 'gpt-test-new'], source: 'copilot-sdk-worker:session-start' });
  assert.equal(enabledOf(service, 'gpt-test-new-none'), true);
  assert.deepEqual(service.getCopilotModelState().unseen, ['gpt-test-new']);
  assert.deepEqual(newModels, [{ ids: ['gpt-test-new'], on: true }]);
  assert.deepEqual(snapshots, ['copilot-sdk-worker:session-start']);
  assert.equal(service.markCopilotModelsSeen(), true);
  assert.deepEqual(service.getCopilotModelState().unseen, []);
  assert.equal(service.markCopilotModelsSeen(), false);

  service.setCopilotAutoEnableNew(false);
  service.updateModelCatalog({ models: ['gpt-5.4-mini', 'gpt-test-new', 'gpt-test-other'], source: 'copilot-sdk-worker:session-start' });
  assert.equal(enabledOf(service, 'gpt-test-other-none'), false);
  assert.deepEqual(newModels.at(-1), { ids: ['gpt-test-other'], on: false });
});

test('model map: a new effort row follows the model\'s other rows', () => {
  const { service } = bootServiceWithModelState();
  service.setEnabledModelVariants(['gpt-5.4-mini-low']);
  const metadata = (efforts) => ({ 'gpt-5.4-mini': { supportedEfforts: efforts }, 'gpt-5.4': { supportedEfforts: efforts } });
  service.updateModelCatalog({ models: ['gpt-5.4-mini', 'gpt-5.4'], modelMetadataByModel: metadata(['low']), source: 'copilot-sdk-worker:session-start' });
  service.updateModelCatalog({ models: ['gpt-5.4-mini', 'gpt-5.4'], modelMetadataByModel: metadata(['low', 'minimal']), source: 'copilot-sdk-worker:session-start' });
  // gpt-5.4-mini has its low row on: the new minimal row starts on.
  assert.equal(enabledOf(service, 'gpt-5.4-mini-minimal'), true);
  // gpt-5.4 has every row off: its new minimal row starts off.
  assert.equal(enabledOf(service, 'gpt-5.4-minimal'), false);
});

test('model map: a row turned off and pruned comes back off; turned on, it is forgotten', () => {
  const { service, store } = bootServiceWithModelState();
  service.setEnabledModelVariants(['gpt-5.4-mini-none', 'gpt-5.4-none']);
  assert.ok(store.readCopilot().disabledVariants.includes('gpt-5.3-codex-none'));
  // The runtime stops listing gpt-5.3-codex: its disabled rows are pruned.
  service.updateModelCatalog({ models: ['gpt-5.4-mini', 'gpt-5.4'], source: 'copilot-sdk-worker:session-start' });
  assert.equal(service.listModelVariantRows().some((row) => row.baseModelId === 'gpt-5.3-codex'), false);
  // It comes back: still off, and not new.
  service.updateModelCatalog({ models: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.3-codex'], source: 'copilot-sdk-worker:session-start' });
  assert.equal(enabledOf(service, 'gpt-5.3-codex-none'), false);
  assert.deepEqual(service.getCopilotModelState().unseen, []);
  service.setEnabledModelVariants(['gpt-5.4-mini-none', 'gpt-5.3-codex-none']);
  assert.equal(store.readCopilot().disabledVariants.includes('gpt-5.3-codex-none'), false);
  assert.ok(store.readCopilot().disabledVariants.includes('gpt-5.4-none'));
});

test('model map: an empty selection is refused and changes nothing', () => {
  const { service } = bootServiceWithModelState();
  const before = rowSummary(service);
  service.setEnabledModelVariants([]);
  assert.deepEqual(rowSummary(service), before);
});

test('without a model map new rows start off as before', () => {
  const { service } = bootService();
  service.updateModelCatalog({ models: ['gpt-5.4-mini', 'gpt-test-new'], source: 'copilot-sdk-worker:session-start' });
  assert.equal(enabledOf(service, 'gpt-test-new-none'), false);
  assert.deepEqual(service.getCopilotModelState(), { autoEnableNew: false, unseen: [] });
});

test('model map: a save changes only the rows it showed; a row a refresh added meanwhile stays on', () => {
  const { service } = bootServiceWithModelState();
  // The modal draws the seed rows of gpt-5.4-mini and gpt-5.4 …
  const shown = service.listModelVariantRows()
    .filter((row) => row.baseModelId === 'gpt-5.4-mini' || row.baseModelId === 'gpt-5.4')
    .map((row) => row.variantId);
  // … then a snapshot adds a model (switch on) before the user saves.
  service.updateModelCatalog({ models: [...CURATED, 'gpt-test-new'], source: 'copilot-sdk-worker:session-start' });
  assert.equal(enabledOf(service, 'gpt-test-new-none'), true);
  // The save the modal sends: what it drew, gpt-5.4 unticked; the full list it knew.
  const known = service.listModelVariantRows().filter((row) => row.baseModelId !== 'gpt-test-new' && row.baseModelId !== 'gpt-5.4').map((row) => row.variantId);
  service.setEnabledModelVariants(known, { shownVariantIds: shown });
  assert.equal(enabledOf(service, 'gpt-test-new-none'), true, 'not shown: kept on');
  assert.equal(enabledOf(service, 'gpt-5.4-none'), false, 'shown and unticked: off');
  assert.equal(enabledOf(service, 'gpt-5.4-mini-none'), true);
});

test('model map: a save right after a snapshot, before the re-render, leaves the new rows alone', () => {
  const { service, store } = bootServiceWithModelState();
  service.setCopilotAutoEnableNew(false);
  service.updateModelCatalog({ models: [...CURATED, 'gpt-test-new'], source: 'copilot-sdk-worker:session-start' });
  // Turned on elsewhere meanwhile.
  service.setEnabledModelVariants([...service.listEnabledModelVariantRows().map((row) => row.variantId), 'gpt-test-new-high'],
    { shownVariantIds: ['gpt-test-new-high'] });
  // This page saves only the Copilot rows it drew, which never included gpt-test-new.
  const drawn = service.listModelVariantRows().filter((row) => row.baseModelId === 'gpt-5.4-mini').map((row) => row.variantId);
  service.setEnabledModelVariants(drawn, { shownVariantIds: drawn });
  assert.equal(enabledOf(service, 'gpt-test-new-high'), true);
  assert.equal(enabledOf(service, 'gpt-test-new-low'), false);
  assert.equal(store.readCopilot().disabledVariants.includes('gpt-test-new-high'), false);
  // Without a shown list (an older page) the list is the whole set, as before.
  service.setEnabledModelVariants(['gpt-5.4-mini-none']);
  assert.equal(enabledOf(service, 'gpt-test-new-high'), false);
});
