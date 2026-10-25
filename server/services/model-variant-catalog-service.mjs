// The Copilot model catalog: the in-memory snapshot state plus the persisted
// `model_variants` rows behind GET /api/models and GET /api/model-variants.
//
// Extracted verbatim-in-spirit from server-runtime.mjs so it can be exercised
// against an in-memory SQLite database (server-runtime boots a server on
// import). The factory is created BEFORE the database exists — the runtime
// publishes its bootstrap catalog first — and `bindDatabase(db)` attaches the
// prepared statements, seeds an empty table and normalizes legacy ids, in the
// same order the runtime always did.
//
// What the runtime's snapshot producers publish is the per-model metadata
// contract (`modelMetadataByModel[modelId]`, see shared/model-descriptors.mjs
// `modelMetadataFromDescriptor`). This module is the only place that decides
// how that metadata becomes rows:
//
//   * reasoning-effort variants come from the model's OWN `supportedEfforts`
//     when the runtime reported them (one row per level, exactly the runtime's
//     list — 'none' and 'minimal' included), a single null-effort row for a
//     model the runtime reports as effort-less, and the global ladder only for
//     models nobody has described yet (curated seeds, help-text ids);
//   * `sort_order` is the model's index in the canonical Copilot order
//     (shared/copilot-model-order.mjs), recomputed over the WHOLE table on
//     every ingest — never a per-batch counter, so a model's position cannot
//     depend on which snapshot introduced it;
//   * the metadata object itself is persisted per row (`metadata_json`) so a
//     restart serves vendor/category/window/efforts without waiting for the
//     next worker or discovery snapshot;
//   * curated ids only seed an EMPTY catalog; once an authoritative snapshot
//     (a running engine or the server-side discovery) has listed the models,
//     anything absent from it is marked `unavailable` (enabled rows stay
//     listed so a picker can show them greyed; disabled ones are pruned).
import { humanizeModelLabel } from '../public/app/model-selector-options.mjs';
import { latestModelCatalogRefresh } from '../../shared/model-catalog-freshness.mjs';
import {
  canonicalizeModelId,
  filterValidModelIds,
  isValidModelId,
} from '../../shared/model-id.mjs';
import { KNOWN_REASONING_EFFORTS, MODEL_PICKER_CATEGORIES } from '../../shared/model-descriptors.mjs';
import { copilotCatalogIndexByModel, inferCopilotVendor } from '../../shared/copilot-model-order.mjs';
import { selectModelIdsForVariantRefresh } from '../../shared/model-refresh.mjs';

export const SUPPORTED_REASONING_EFFORTS = [...KNOWN_REASONING_EFFORTS];
/**
 * The ladder assumed for a gpt-/claude- model NOBODY has described yet (a
 * curated seed, a help-text id). Deliberately the historical six: `minimal`
 * only ever appears when the runtime reports it for a specific model.
 */
export const FALLBACK_REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const REASONING_VARIANT_SUPPORTED_PREFIXES = ['gpt-', 'claude-'];
/**
 * Snapshot sources that read the runtime's real model list. Any of them
 * outranks the curated seed and the `copilot help` text fallback.
 */
export const AUTHORITATIVE_SNAPSHOT_SOURCE_RE = /^(web-relay-extension|standalone-relay|copilot-sdk-worker|server-discovery):/;

/** The per-model metadata fields of the API contract, in payload order. */
export const MODEL_METADATA_FIELDS = Object.freeze([
  'defaultContextLimitTokens',
  'longContextLimitTokens',
  'pricing',
  'displayName',
  'vendor',
  'pickerCategory',
  'preview',
  'contextWindowTokens',
  'maxPromptTokens',
  'supportedEfforts',
  'catalogIndex',
]);

function uniqueStringList(values) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function toPositiveInt(value) {
  const n = toNullableInt(value);
  return n !== null && n > 0 ? n : null;
}

function normalizeText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, maxLength) : null;
}

export function normalizeReasoningEffort(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  return SUPPORTED_REASONING_EFFORTS.includes(text) ? text : null;
}

function effortRank(effort) {
  const index = SUPPORTED_REASONING_EFFORTS.indexOf(String(effort || '').toLowerCase());
  return index === -1 ? SUPPORTED_REASONING_EFFORTS.length : index;
}

export function isReasoningVariantEligibleModel(modelId) {
  const normalized = String(modelId || '').trim().toLowerCase();
  if (!normalized) return false;
  return REASONING_VARIANT_SUPPORTED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function modelProviderForId(modelId) {
  const text = String(modelId || '').trim().toLowerCase();
  if (!text) return 'other';
  if (
    text.startsWith('gpt-')
    || text.startsWith('o1-')
    || text.startsWith('o3-')
    || text.startsWith('codex-')
    || text.startsWith('openai/')
  ) return 'openai';
  if (text.startsWith('claude-')) return 'anthropic';
  if (text.startsWith('gemini-')) return 'google';
  if (text.startsWith('mai-')) return 'microsoft';
  if (text.startsWith('grok-')) return 'xai';
  if (text.startsWith('kimi-')) return 'moonshot';
  if (text.startsWith('deepseek-')) return 'deepseek';
  return 'other';
}

// Single source of truth with the composer's labels: the server-built variant
// labels are preferred by the client, so a second formatter here would drift
// (it did — "Claude Sonnet 4.6" in the catalog modal vs "Sonnet 4.6" in the
// composer). The module is pure browser-neutral ESM.
function modelDisplayLabel(modelId) {
  return humanizeModelLabel(modelId);
}

export function buildModelVariantId(baseModelId, reasoningEffort = null) {
  const base = String(baseModelId || '').trim();
  if (!base) return '';
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (!effort) return base;
  return `${base}-${effort}`;
}

export function parseModelVariantId(variantId = '', {
  knownBaseModels = [],
} = {}) {
  const value = String(variantId || '').trim();
  if (!value) return null;
  const known = Array.isArray(knownBaseModels)
    ? knownBaseModels.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const orderedKnown = known.sort((a, b) => b.length - a.length);
  for (const candidate of orderedKnown) {
    if (!value.toLowerCase().startsWith(`${candidate.toLowerCase()}-`)) continue;
    const suffix = value.slice(candidate.length + 1);
    const effort = normalizeReasoningEffort(suffix);
    if (effort) {
      return {
        variantId: buildModelVariantId(candidate, effort),
        baseModelId: candidate,
        reasoningEffort: effort,
      };
    }
  }
  const trailingEffortMatch = value.match(/^(.*?)-([a-z]+)$/i);
  if (trailingEffortMatch) {
    const effort = normalizeReasoningEffort(trailingEffortMatch[2]);
    const maybeBase = String(trailingEffortMatch[1] || '').trim();
    if (effort && maybeBase) {
      return {
        variantId: buildModelVariantId(maybeBase, effort),
        baseModelId: maybeBase,
        reasoningEffort: effort,
      };
    }
  }
  return {
    variantId: value,
    baseModelId: value,
    reasoningEffort: null,
  };
}

/**
 * One contract metadata entry from an untrusted snapshot value. Returns null
 * when nothing usable is in it. `supportedEfforts` distinguishes three
 * states: `undefined` = the publisher said nothing about efforts (the global
 * ladder applies to gpt-/claude- ids), `null` = the runtime reported the
 * model as effort-less, an array = exactly the runtime's levels.
 */
export function normalizeModelMetadataEntry(rawMetadata) {
  if (!rawMetadata || typeof rawMetadata !== 'object' || Array.isArray(rawMetadata)) return null;
  const entry = {
    defaultContextLimitTokens: toPositiveInt(rawMetadata.defaultContextLimitTokens),
    longContextLimitTokens: toPositiveInt(rawMetadata.longContextLimitTokens),
    pricing: rawMetadata.pricing && typeof rawMetadata.pricing === 'object' ? rawMetadata.pricing : null,
    displayName: normalizeText(rawMetadata.displayName, 120),
    vendor: normalizeText(rawMetadata.vendor, 80),
    pickerCategory: MODEL_PICKER_CATEGORIES.includes(String(rawMetadata.pickerCategory || '').toLowerCase())
      ? String(rawMetadata.pickerCategory).toLowerCase()
      : null,
    preview: rawMetadata.preview === true,
    contextWindowTokens: toPositiveInt(rawMetadata.contextWindowTokens),
    maxPromptTokens: toPositiveInt(rawMetadata.maxPromptTokens),
    catalogIndex: (() => {
      const n = toNullableInt(rawMetadata.catalogIndex);
      return n !== null && n >= 0 ? n : null;
    })(),
  };
  if (Object.prototype.hasOwnProperty.call(rawMetadata, 'supportedEfforts')) {
    const list = Array.isArray(rawMetadata.supportedEfforts)
      ? uniqueStringList(rawMetadata.supportedEfforts.map((value) => normalizeReasoningEffort(value)).filter(Boolean))
      : [];
    entry.supportedEfforts = list.length ? list : null;
  }
  const informative = entry.defaultContextLimitTokens !== null
    || entry.longContextLimitTokens !== null
    || entry.pricing !== null
    || entry.displayName !== null
    || entry.vendor !== null
    || entry.pickerCategory !== null
    || entry.contextWindowTokens !== null
    || entry.maxPromptTokens !== null
    || entry.preview
    || Object.prototype.hasOwnProperty.call(entry, 'supportedEfforts');
  return informative ? entry : null;
}

export function normalizeModelMetadataByModel(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawModelId, rawMetadata] of Object.entries(value)) {
    const modelId = canonicalizeModelId(rawModelId);
    if (!isValidModelId(modelId)) continue;
    const entry = normalizeModelMetadataEntry(rawMetadata);
    if (entry) normalized[modelId] = entry;
  }
  return normalized;
}

export function normalizeContextLimitsByModel(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawModelId, rawLimit] of Object.entries(value)) {
    const modelId = canonicalizeModelId(rawModelId);
    const limit = Number(rawLimit);
    if (!isValidModelId(modelId) || !Number.isFinite(limit) || limit <= 0) continue;
    normalized[modelId] = Math.round(limit);
  }
  return normalized;
}

/**
 * Newer metadata over stored metadata, field by field: a null from a poorer
 * publisher (an extension-era snapshot carries no vendor) must not erase what
 * a richer one already stored. `supportedEfforts` is the exception — when the
 * newer entry SAYS anything about efforts (null = effort-less included) it is
 * the runtime's word and replaces the old value.
 */
export function mergeModelMetadata(stored, incoming) {
  const base = stored && typeof stored === 'object' ? { ...stored } : {};
  if (!incoming || typeof incoming !== 'object') return Object.keys(base).length ? base : null;
  for (const [key, value] of Object.entries(incoming)) {
    if (key === 'catalogIndex') continue;
    if (key === 'supportedEfforts') {
      base.supportedEfforts = value === undefined ? base.supportedEfforts : value;
      continue;
    }
    if (key === 'preview') {
      base.preview = value === true || (base.preview === true && value !== false);
      continue;
    }
    if (value !== null && value !== undefined) base[key] = value;
    else if (!(key in base)) base[key] = null;
  }
  return base;
}

/** The persisted form: contract fields only, `catalogIndex` never stored. */
function serializeModelMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const out = {};
  for (const field of MODEL_METADATA_FIELDS) {
    if (field === 'catalogIndex') continue;
    if (metadata[field] !== undefined) out[field] = metadata[field];
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function parseStoredMetadata(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A full contract object (every field present) for the API payloads. */
function toContractMetadata(metadata, { defaultContextLimitTokens, longContextLimitTokens, pricing, catalogIndex }) {
  const source = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    defaultContextLimitTokens: toPositiveInt(defaultContextLimitTokens ?? source.defaultContextLimitTokens),
    longContextLimitTokens: toPositiveInt(longContextLimitTokens ?? source.longContextLimitTokens),
    pricing: pricing ?? source.pricing ?? null,
    displayName: source.displayName ?? null,
    vendor: source.vendor ?? null,
    pickerCategory: source.pickerCategory ?? null,
    preview: source.preview === true,
    contextWindowTokens: toPositiveInt(source.contextWindowTokens),
    maxPromptTokens: toPositiveInt(source.maxPromptTokens),
    supportedEfforts: Array.isArray(source.supportedEfforts) && source.supportedEfforts.length
      ? [...source.supportedEfforts]
      : null,
    catalogIndex: Number.isFinite(Number(catalogIndex)) ? Math.max(0, Math.trunc(Number(catalogIndex))) : null,
  };
}

/**
 * The effort levels a model's variant rows should cover. Known (array) and
 * effort-less (null) come from the runtime; `undefined` falls back to the
 * global ladder for the families that historically had one.
 */
export function effortsForModelVariants(baseModelId, metadata, fallbackEfforts = FALLBACK_REASONING_EFFORTS) {
  const known = metadata && typeof metadata === 'object' ? metadata.supportedEfforts : undefined;
  if (known === undefined) {
    return isReasoningVariantEligibleModel(baseModelId) ? uniqueStringList(fallbackEfforts) : null;
  }
  if (!Array.isArray(known)) return null;
  const list = uniqueStringList(known.map((value) => normalizeReasoningEffort(value)).filter(Boolean));
  return list.length ? list : null;
}

export function normalizeModelVariantRow(row = {}) {
  const rawBaseModelId = String(row?.base_model_id || row?.baseModelId || '').trim();
  const baseModelId = canonicalizeModelId(rawBaseModelId) || rawBaseModelId;
  const reasoningEffort = normalizeReasoningEffort(row?.reasoning_effort ?? row?.reasoningEffort);
  const rawVariantId = String(row?.variant_id || row?.variantId || buildModelVariantId(baseModelId, reasoningEffort)).trim();
  const parsed = parseModelVariantId(rawVariantId, { knownBaseModels: baseModelId ? [baseModelId] : [] });
  const normalizedBaseModelId = canonicalizeModelId(parsed?.baseModelId || baseModelId) || baseModelId;
  const normalizedReasoningEffort = normalizeReasoningEffort(parsed?.reasoningEffort || reasoningEffort);
  const variantId = buildModelVariantId(normalizedBaseModelId, normalizedReasoningEffort);
  const provider = String(row?.provider || row?.providerId || modelProviderForId(baseModelId)).trim() || 'other';
  const label = String(row?.label || row?.displayName || modelDisplayLabel(normalizedBaseModelId)).trim() || normalizedBaseModelId;
  const enabledValue = Number(row?.enabled);
  const enabled = Number.isFinite(enabledValue) ? enabledValue === 1 : !!row?.enabled;
  return {
    variantId,
    baseModelId: normalizedBaseModelId,
    provider,
    reasoningEffort: normalizedReasoningEffort,
    label,
    releaseStatus: String(row?.release_status || row?.releaseStatus || '').trim() || null,
    contextLimitTokens: toPositiveInt(row?.context_limit_tokens ?? row?.contextLimitTokens),
    longContextLimitTokens: toPositiveInt(row?.long_context_limit_tokens ?? row?.longContextLimitTokens),
    pricing: (() => {
      const value = row?.pricing_json ?? row?.pricing;
      if (!value || typeof value === 'object') return value || null;
      try { return JSON.parse(value); } catch { return null; }
    })(),
    metadata: parseStoredMetadata(row?.metadata_json ?? row?.metadata),
    enabled,
    sortOrder: Number.isFinite(Number(row?.sort_order ?? row?.sortOrder))
      ? Math.max(0, Math.trunc(Number(row?.sort_order ?? row?.sortOrder)))
      : 0,
    updatedAt: row?.updated_at || row?.updatedAt || null,
  };
}

/**
 * Variant rows for a list of base models. `sortOrder` is the model's index
 * in `baseModels` (all of a model's effort rows share it) unless
 * `sortOrderByModel` supplies the canonical one; ingest recomputes it anyway.
 */
export function buildModelVariantEntries(baseModels = [], {
  defaultEnabled = true,
  contextLimitsByModel = {},
  modelMetadataByModel = {},
  fallbackEfforts = FALLBACK_REASONING_EFFORTS,
  sortOrderByModel = null,
} = {}) {
  const models = uniqueStringList(baseModels);
  const entries = [];
  models.forEach((baseModelId, index) => {
    const provider = modelProviderForId(baseModelId);
    const metadata = modelMetadataByModel?.[baseModelId] || {};
    // The runtime's display name travels in the metadata contract; the row
    // label stays the composer's humanized id so existing pickers do not drift.
    const label = modelDisplayLabel(baseModelId);
    const normalizedContextLimitTokens = toPositiveInt(contextLimitsByModel?.[baseModelId])
      ?? toPositiveInt(metadata.defaultContextLimitTokens);
    const sortOrder = sortOrderByModel?.get?.(baseModelId) ?? sortOrderByModel?.[baseModelId] ?? index;
    const efforts = effortsForModelVariants(baseModelId, metadata, fallbackEfforts);
    for (const effort of efforts || [null]) {
      entries.push({
        variantId: buildModelVariantId(baseModelId, effort),
        baseModelId,
        provider,
        label,
        reasoningEffort: effort,
        releaseStatus: null,
        contextLimitTokens: normalizedContextLimitTokens,
        longContextLimitTokens: toPositiveInt(metadata.longContextLimitTokens),
        pricing: metadata.pricing || null,
        metadata: Object.keys(metadata).length ? metadata : null,
        enabled: defaultEnabled ? 1 : 0,
        sortOrder,
      });
    }
  });
  return entries;
}

function hasValidReasoningByModel(reasoningByModel = {}, autoModelSentinel) {
  if (!reasoningByModel || typeof reasoningByModel !== 'object') return false;
  const modelIds = Object.keys(reasoningByModel).filter((modelId) => modelId !== autoModelSentinel);
  if (!modelIds.length) return false;
  return modelIds.every((modelId) => {
    const efforts = reasoningByModel[modelId];
    return Array.isArray(efforts) && efforts.length > 0;
  });
}

export function parseModelsFromHelpConfigOutput(text) {
  const content = String(text || '');
  if (!content) return [];
  const sectionMatch = content.match(/`model`:[\s\S]*?(?=\n\s*`[a-zA-Z][^`]*`:\s|$)/);
  const section = sectionMatch ? sectionMatch[0] : content;
  const models = [];
  const regex = /"([^"]+)"/g;
  let match;
  while ((match = regex.exec(section))) {
    const candidate = String(match[1] || '').trim();
    if (!candidate || candidate === 'auto') continue;
    if (!isValidModelId(candidate)) continue;
    models.push(candidate);
  }
  return filterValidModelIds(uniqueStringList(models));
}

export function parseReasoningEffortsFromHelpOutput(text) {
  const content = String(text || '');
  if (!content) return FALLBACK_REASONING_EFFORTS.slice();
  const values = [];
  const regex = /"([a-z]+)"/g;
  let match;
  while ((match = regex.exec(content))) {
    const effort = normalizeReasoningEffort(match[1]);
    if (effort) values.push(effort);
  }
  const unique = uniqueStringList(values);
  return unique.length ? unique : FALLBACK_REASONING_EFFORTS.slice();
}

const VARIANT_COLUMNS = 'variant_id, base_model_id, provider, label, release_status, reasoning_effort, context_limit_tokens, long_context_limit_tokens, pricing_json, metadata_json, enabled, sort_order, updated_at';

export function createModelVariantCatalogService({
  defaultModel = 'gpt-5.4-mini',
  curatedModelIds = [],
  autoModelSentinel = 'auto',
  // (args: string[]) => Promise<string>; the `copilot help` text fallback.
  runCopilotCliCommand = async () => '',
} = {}) {
  const DEFAULT_MODEL = String(defaultModel || 'gpt-5.4-mini').trim() || 'gpt-5.4-mini';
  const AUTO_MODEL_SENTINEL = String(autoModelSentinel || 'auto');

  let db = null;
  let modelSelectorSql = null;
  let modelCatalog = {
    models: [DEFAULT_MODEL],
    currentModel: DEFAULT_MODEL,
    defaultModel: DEFAULT_MODEL,
    source: 'bootstrap',
    refreshedAt: null,
    error: null,
  };

  function validatedModelIdList(values) {
    return filterValidModelIds(uniqueStringList(values));
  }

  function curatedModelList() {
    return uniqueStringList(curatedModelIds);
  }

  function compareVariantRows(a, b) {
    return (a.sortOrder - b.sortOrder)
      || a.baseModelId.localeCompare(b.baseModelId)
      || (effortRank(a.reasoningEffort) - effortRank(b.reasoningEffort))
      || a.variantId.localeCompare(b.variantId);
  }

  function listModelVariantRows() {
    if (!modelSelectorSql?.listVariants?.all) return [];
    return modelSelectorSql.listVariants.all().map((row) => normalizeModelVariantRow(row)).sort(compareVariantRows);
  }

  function listEnabledModelVariantRows() {
    if (!modelSelectorSql?.listEnabledVariants?.all) return [];
    return modelSelectorSql.listEnabledVariants.all().map((row) => normalizeModelVariantRow(row)).sort(compareVariantRows);
  }

  /** Stored metadata per base model (first row wins; all rows carry the same). */
  function storedMetadataByModel(rows = listModelVariantRows()) {
    const byModel = {};
    for (const row of rows) {
      if (!row.baseModelId || byModel[row.baseModelId]) continue;
      if (row.metadata) byModel[row.baseModelId] = row.metadata;
    }
    return byModel;
  }

  function getModelContextLimitTokens(modelId = '') {
    const normalizedModelId = canonicalizeModelId(modelId);
    if (!normalizedModelId) return null;
    const row = listModelVariantRows().find((entry) => entry.baseModelId === normalizedModelId
      && entry.contextLimitTokens !== null
      && entry.contextLimitTokens > 0);
    return row?.contextLimitTokens || null;
  }

  function parseModelVariantSelection(value) {
    const variantId = String(value || '').trim();
    if (!variantId) return null;
    const knownBaseModels = listModelVariantRows().map((row) => row.baseModelId);
    const parsed = parseModelVariantId(variantId, { knownBaseModels });
    if (!parsed) return null;
    const match = listModelVariantRows().find((row) => row.variantId === parsed.variantId);
    if (match) {
      return {
        variantId: match.variantId,
        baseModelId: match.baseModelId,
        reasoningEffort: match.reasoningEffort,
        provider: match.provider,
        label: match.label,
      };
    }
    return parsed;
  }

  function getModelVariantSelectorState() {
    const fallbackVariant = buildModelVariantId(DEFAULT_MODEL, isReasoningVariantEligibleModel(DEFAULT_MODEL) ? 'none' : null);
    if (!modelSelectorSql?.listEnabledVariants?.all) {
      const fallbackModels = buildModelVariantEntries(curatedModelList(), { defaultEnabled: true }).map((entry) => entry.variantId);
      const models = fallbackModels.length ? fallbackModels : [fallbackVariant];
      return {
        models,
        currentModel: models[0] || fallbackVariant,
        defaultModel: models[0] || fallbackVariant,
        source: 'bootstrap',
        refreshedAt: null,
        warning: null,
        error: null,
      };
    }
    const enabledRows = listEnabledModelVariantRows();
    const selectorState = modelSelectorSql.getSelectorState.get() || null;
    const enabledVariants = enabledRows.map((row) => row.variantId);
    const models = enabledVariants.length ? enabledVariants : [fallbackVariant];
    const warning = enabledVariants.length
      ? null
      : 'No model variants are enabled. Using fallback.';
    return {
      models,
      currentModel: models[0] || fallbackVariant,
      defaultModel: models[0] || fallbackVariant,
      source: String(selectorState?.source || 'db').trim() || 'db',
      refreshedAt: selectorState?.refreshed_at || null,
      warning,
      error: selectorState?.error ? String(selectorState.error) : null,
    };
  }

  function getModelCatalogState() {
    const selectorState = getModelVariantSelectorState();
    const enabledRows = listEnabledModelVariantRows();
    const modelRows = enabledRows.length ? enabledRows : listModelVariantRows().filter((row) => row.enabled);
    const allRows = listModelVariantRows();
    const reasoningByModel = {};
    const contextLimitsByModel = {};
    const modelMetadataByModel = {};
    const unavailable = new Set();
    const models = [];
    const seenModels = new Set();
    const collect = (row, { listed }) => {
      const baseModelId = String(row?.baseModelId || '').trim();
      if (!baseModelId) return;
      if (listed && !seenModels.has(baseModelId)) {
        seenModels.add(baseModelId);
        models.push(baseModelId);
      }
      const effort = normalizeReasoningEffort(row?.reasoningEffort || 'none') || 'none';
      const current = reasoningByModel[baseModelId] || [];
      if (!current.includes(effort)) current.push(effort);
      reasoningByModel[baseModelId] = current;
      if (row.contextLimitTokens !== null && row.contextLimitTokens > 0) {
        contextLimitsByModel[baseModelId] = row.contextLimitTokens;
      }
      if (!modelMetadataByModel[baseModelId]) {
        modelMetadataByModel[baseModelId] = toContractMetadata(row.metadata, {
          defaultContextLimitTokens: row.contextLimitTokens,
          longContextLimitTokens: row.longContextLimitTokens,
          pricing: row.pricing,
          catalogIndex: row.sortOrder,
        });
      }
      if (row.releaseStatus === 'unavailable') unavailable.add(baseModelId);
    };
    // Enabled rows (in canonical order) define the picker list; every row
    // contributes to the effort map so a disabled variant is still resolvable.
    for (const row of modelRows) collect(row, { listed: true });
    for (const row of allRows) collect(row, { listed: false });
    for (const modelId of Object.keys(reasoningByModel)) {
      // The runtime's own effort list wins over what the rows happen to hold.
      const known = modelMetadataByModel[modelId]?.supportedEfforts;
      const efforts = Array.isArray(known) && known.length
        ? known.map((value) => normalizeReasoningEffort(value)).filter(Boolean)
        : (reasoningByModel[modelId] || []).map((value) => normalizeReasoningEffort(value)).filter(Boolean);
      reasoningByModel[modelId] = uniqueStringList(efforts);
    }
    const autoEfforts = uniqueStringList(
      Object.entries(reasoningByModel)
        .filter(([modelId]) => modelId !== AUTO_MODEL_SENTINEL)
        .flatMap(([, list]) => Array.isArray(list) ? list : [])
        .map((value) => normalizeReasoningEffort(value))
        .filter(Boolean),
    );
    if (autoEfforts.length) {
      reasoningByModel[AUTO_MODEL_SENTINEL] = autoEfforts;
    } else {
      delete reasoningByModel[AUTO_MODEL_SENTINEL];
    }
    const catalogModels = [AUTO_MODEL_SENTINEL, ...models.filter((value) => value.toLowerCase() !== AUTO_MODEL_SENTINEL)];
    const currentResolved = parseModelVariantSelection(selectorState.currentModel);
    const defaultResolved = parseModelVariantSelection(selectorState.defaultModel);
    const currentModel = String(currentResolved?.baseModelId || selectorState.currentModel || '').trim() || catalogModels[0] || DEFAULT_MODEL;
    const defaultModelId = String(defaultResolved?.baseModelId || selectorState.defaultModel || '').trim() || currentModel || catalogModels[0] || DEFAULT_MODEL;
    const reasoningMetadataValid = hasValidReasoningByModel(reasoningByModel, AUTO_MODEL_SENTINEL);
    const inMemoryRefresh = modelCatalog.refreshedAt || null;
    const refreshedAt = latestModelCatalogRefresh(selectorState.refreshedAt, inMemoryRefresh);
    const metadataError = !reasoningMetadataValid || !!selectorState.error || modelRows.length === 0;
    const stale = metadataError;
    const metadataValid = !metadataError;
    const warning = selectorState.warning || null;
    const reasoningEfforts = uniqueStringList(
      Object.values(reasoningByModel)
        .flatMap((list) => Array.isArray(list) ? list : [])
        .map((value) => normalizeReasoningEffort(value))
        .filter(Boolean),
    );
    return {
      models: catalogModels,
      currentModel,
      defaultModel: defaultModelId,
      source: selectorState.source,
      refreshedAt,
      stale,
      metadataValid,
      reasoningMetadataValid,
      warning,
      error: selectorState.error,
      reasoningByModel,
      reasoningEfforts,
      contextLimitsByModel,
      modelMetadataByModel,
      // Models the last authoritative snapshot no longer listed but whose
      // enabled variants stay selectable; pickers use this to grey them out.
      unavailableModels: [...unavailable].filter((modelId) => seenModels.has(modelId)),
    };
  }

  function touchModelSelectorState({
    source = 'snapshot',
    error = null,
    refreshedAt = new Date().toISOString(),
  } = {}) {
    if (!modelSelectorSql?.upsertSelectorState?.run) return;
    const timestamp = latestModelCatalogRefresh(refreshedAt) || new Date().toISOString();
    modelSelectorSql.upsertSelectorState.run(
      String(source || 'snapshot').trim() || 'snapshot',
      timestamp,
      error ? String(error).trim().slice(0, 300) : null,
      timestamp,
    );
  }

  function runVariantUpsert(entry, enabled, nowIso) {
    modelSelectorSql.upsertVariant.run(
      entry.variantId,
      entry.baseModelId,
      entry.provider || modelProviderForId(entry.baseModelId),
      entry.label || modelDisplayLabel(entry.baseModelId),
      entry.releaseStatus || null,
      entry.reasoningEffort || null,
      entry.contextLimitTokens || null,
      entry.longContextLimitTokens || null,
      entry.pricing ? JSON.stringify(entry.pricing) : null,
      serializeModelMetadata(entry.metadata),
      enabled ? 1 : 0,
      entry.sortOrder,
      nowIso,
    );
  }

  /**
   * sort_order := the model's index in the canonical Copilot order, over
   * EVERY row in the table. Called at the end of each write path so the
   * number never depends on ingest batches.
   */
  function recomputeSortOrder() {
    if (!modelSelectorSql?.updateSortOrderForBase?.run) return;
    const rows = listModelVariantRows();
    const descriptors = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row.baseModelId || seen.has(row.baseModelId)) continue;
      seen.add(row.baseModelId);
      const metadata = row.metadata || {};
      descriptors.push({
        modelId: row.baseModelId,
        vendor: metadata.vendor || inferCopilotVendor(row.baseModelId),
        pickerCategory: metadata.pickerCategory || null,
        preview: metadata.preview === true,
        displayName: metadata.displayName || row.label || row.baseModelId,
      });
    }
    const indexByModel = copilotCatalogIndexByModel(descriptors);
    const apply = () => {
      for (const [baseModelId, index] of indexByModel) {
        modelSelectorSql.updateSortOrderForBase.run(index, baseModelId);
      }
    };
    if (db?.transaction) db.transaction(apply)();
    else apply();
  }

  /**
   * Write a set of variant rows and reconcile the rest of the table against
   * it. A base model present in `entries` owns exactly those rows when its
   * efforts are known (stale effort rows are dropped, an enabled one hands its
   * flag to the model's remaining rows); a base model absent from `entries`
   * follows `absentBasePolicy`: 'reconcile' (enabled rows → unavailable,
   * disabled rows pruned) or 'ignore' (left untouched).
   */
  function reconcileModelVariantRows(entries = [], {
    source = 'manual-refresh',
    error = null,
    preserveEnabled = true,
    absentBasePolicy = 'reconcile',
    knownEffortBases = new Set(),
    touchSelectorState = true,
  } = {}) {
    if (!modelSelectorSql?.upsertVariant?.run || !modelSelectorSql?.upsertSelectorState?.run) {
      return getModelVariantSelectorState();
    }
    const normalizedEntries = Array.isArray(entries)
      ? entries.map((entry) => ({ ...normalizeModelVariantRow(entry), metadata: entry?.metadata || null }))
        .filter((entry) => entry.variantId && entry.baseModelId)
      : [];
    const existingRows = listModelVariantRows();
    const existingEnabled = new Map(existingRows.map((row) => [row.variantId, row.enabled ? 1 : 0]));
    const incomingIds = new Set(normalizedEntries.map((entry) => entry.variantId));
    const incomingBaseIds = new Set(normalizedEntries.map((entry) => entry.baseModelId));
    const nowIso = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const entry of normalizedEntries) {
        const enabled = preserveEnabled && existingEnabled.has(entry.variantId)
          ? existingEnabled.get(entry.variantId)
          : (entry.enabled ? 1 : 0);
        runVariantUpsert(entry, enabled, nowIso);
      }
      const orphanedEnabledBases = new Set();
      for (const row of existingRows) {
        if (incomingIds.has(row.variantId)) continue;
        if (incomingBaseIds.has(row.baseModelId)) {
          if (knownEffortBases.has(row.baseModelId)) {
            // The runtime told us this model's exact levels; a row for a
            // level it does not offer is stale, not "unavailable".
            if (row.enabled) orphanedEnabledBases.add(row.baseModelId);
            modelSelectorSql.deleteVariant.run(row.variantId);
          } else {
            runVariantUpsert({ ...row, releaseStatus: 'unavailable' }, row.enabled, nowIso);
          }
          continue;
        }
        if (absentBasePolicy === 'ignore') continue;
        if (row.enabled) {
          runVariantUpsert({ ...row, releaseStatus: 'unavailable' }, 1, nowIso);
          continue;
        }
        // Variants that are both disabled and fully absent from the incoming
        // base set are no longer relevant; prune them so they do not linger.
        modelSelectorSql.deleteVariant.run(row.variantId);
      }
      // A selection must not silently vanish because its effort level did:
      // when the deletions left a model with no enabled row, its first
      // remaining row (the runtime's lowest level, or the effort-less row)
      // inherits the selection.
      for (const baseModelId of orphanedEnabledBases) {
        const remaining = listModelVariantRows().filter((row) => row.baseModelId === baseModelId);
        if (!remaining.length || remaining.some((row) => row.enabled)) continue;
        modelSelectorSql.enableVariant.run(nowIso, remaining[0].variantId);
      }
      if (touchSelectorState) {
        modelSelectorSql.upsertSelectorState.run(
          String(source || 'manual-refresh').trim() || 'manual-refresh',
          nowIso,
          error ? String(error).trim().slice(0, 300) : null,
          nowIso,
        );
      }
    });
    tx();
    recomputeSortOrder();
    return getModelVariantSelectorState();
  }

  function upsertModelVariantCatalogEntries(entries = [], {
    source = 'manual-refresh',
    error = null,
    preserveEnabled = true,
  } = {}) {
    const knownEffortBases = new Set(
      (Array.isArray(entries) ? entries : [])
        .filter((entry) => entry?.metadata && entry.metadata.supportedEfforts !== undefined)
        .map((entry) => canonicalizeModelId(entry.baseModelId) || String(entry.baseModelId || '').trim()),
    );
    return reconcileModelVariantRows(entries, { source, error, preserveEnabled, absentBasePolicy: 'reconcile', knownEffortBases });
  }

  function setEnabledModelVariants(variantIds = []) {
    if (!modelSelectorSql?.disableAllVariants?.run || !modelSelectorSql?.enableVariant?.run) {
      return getModelVariantSelectorState();
    }
    const nextEnabled = new Set(
      Array.isArray(variantIds) ? variantIds.map((value) => String(value || '').trim()).filter(Boolean) : [],
    );
    const existingRows = listModelVariantRows();
    const nowIso = new Date().toISOString();
    const tx = db.transaction(() => {
      modelSelectorSql.disableAllVariants.run(nowIso);
      for (const row of existingRows) {
        if (!nextEnabled.has(row.variantId)) continue;
        modelSelectorSql.enableVariant.run(nowIso, row.variantId);
      }
    });
    tx();
    return getModelVariantSelectorState();
  }

  function updateModelCatalog(snapshot = {}) {
    const incomingModels = validatedModelIdList(Array.isArray(snapshot.models) ? snapshot.models : []);
    const incomingCurrentRaw = String(snapshot.currentModel || '').trim();
    const incomingDefaultRaw = String(snapshot.defaultModel || '').trim();
    const incomingCurrent = isValidModelId(incomingCurrentRaw) ? incomingCurrentRaw : '';
    const incomingDefault = isValidModelId(incomingDefaultRaw) ? incomingDefaultRaw : '';
    const contextLimitsByModel = normalizeContextLimitsByModel(snapshot.contextLimitsByModel);
    const modelMetadataByModel = normalizeModelMetadataByModel(snapshot.modelMetadataByModel);
    const receivedMetadata = incomingModels.length > 0 || Object.keys(contextLimitsByModel).length > 0 || Object.keys(modelMetadataByModel).length > 0;
    const source = String(snapshot.source || modelCatalog.source || 'unknown').trim() || 'unknown';
    // A snapshot from something that read the runtime's real list is the
    // whole catalog: curated ids and earlier in-memory lists do not get to
    // resurrect models the runtime no longer serves.
    const authoritative = AUTHORITATIVE_SNAPSHOT_SOURCE_RE.test(source) && incomingModels.length > 0;
    const merged = validatedModelIdList(authoritative
      ? [...incomingModels, incomingCurrent, incomingDefault]
      : [
          ...curatedModelList(),
          ...incomingModels,
          incomingCurrent,
          incomingDefault,
          ...(Array.isArray(modelCatalog.models) ? modelCatalog.models : []),
          modelCatalog.currentModel,
          modelCatalog.defaultModel,
        ]);
    if (!merged.length) merged.push(DEFAULT_MODEL);
    const currentModel = incomingCurrent || modelCatalog.currentModel || incomingDefault || merged[0] || DEFAULT_MODEL;
    const defaultModelId = incomingDefault || modelCatalog.defaultModel || currentModel || DEFAULT_MODEL;
    const models = uniqueStringList([currentModel, defaultModelId, ...merged]);

    modelCatalog = {
      models,
      currentModel,
      defaultModel: defaultModelId,
      source,
      refreshedAt: receivedMetadata ? new Date().toISOString() : modelCatalog.refreshedAt,
      error: snapshot.error ? String(snapshot.error).trim().slice(0, 300) : null,
    };
    if (modelSelectorSql?.upsertVariant?.run) {
      const existingRows = listModelVariantRows();
      const stored = storedMetadataByModel(existingRows);
      const mergedMetadataByModel = { ...stored };
      for (const [modelId, metadata] of Object.entries(modelMetadataByModel)) {
        mergedMetadataByModel[modelId] = mergeModelMetadata(stored[modelId], metadata);
      }
      const nowIso = new Date().toISOString();
      if (authoritative) {
        const entries = buildModelVariantEntries(incomingModels, {
          defaultEnabled: false,
          contextLimitsByModel,
          modelMetadataByModel: mergedMetadataByModel,
        });
        reconcileModelVariantRows(entries, {
          source: modelCatalog.source,
          error: modelCatalog.error || null,
          preserveEnabled: true,
          absentBasePolicy: 'reconcile',
          knownEffortBases: new Set(
            incomingModels.filter((modelId) => mergedMetadataByModel[modelId]?.supportedEfforts !== undefined),
          ),
          // updateModelCatalog stamps the selector state itself below.
          touchSelectorState: false,
        });
      } else {
        const existingBaseIds = new Set(existingRows.map((r) => r.baseModelId));
        const newBaseIds = models.filter((id) => !existingBaseIds.has(id));
        if (newBaseIds.length) {
          const newEntries = buildModelVariantEntries(newBaseIds, {
            defaultEnabled: false,
            contextLimitsByModel,
            modelMetadataByModel: mergedMetadataByModel,
          });
          reconcileModelVariantRows(newEntries, {
            source: modelCatalog.source,
            error: modelCatalog.error || null,
            preserveEnabled: true,
            absentBasePolicy: 'ignore',
            touchSelectorState: false,
          });
        }
      }
      for (const [modelId, contextLimitTokens] of Object.entries(contextLimitsByModel)) {
        modelSelectorSql.updateContextLimitForBase.run(contextLimitTokens, nowIso, modelId);
      }
      for (const [modelId, metadata] of Object.entries(modelMetadataByModel)) {
        modelSelectorSql.updateModelMetadataForBase.run(
          metadata.defaultContextLimitTokens,
          metadata.longContextLimitTokens,
          metadata.pricing ? JSON.stringify(metadata.pricing) : null,
          serializeModelMetadata(mergedMetadataByModel[modelId]),
          nowIso,
          modelId,
        );
      }
      if (Object.keys(modelMetadataByModel).length) recomputeSortOrder();
    }
    if (receivedMetadata && modelSelectorSql?.upsertSelectorState?.run) {
      touchModelSelectorState({
        source: modelCatalog.source,
        error: modelCatalog.error,
        refreshedAt: modelCatalog.refreshedAt,
      });
    }
    return getModelCatalogState();
  }

  async function refreshModelVariantCatalogFromCli() {
    let source = 'rpc-snapshot';
    let modelIds = [];
    let reasoningEfforts = FALLBACK_REASONING_EFFORTS.slice();
    // All four publishers read the runtime's real model list, so any of their
    // snapshots outranks the CLI help-text fallback below.
    const hasAuthoritativeSnapshot = AUTHORITATIVE_SNAPSHOT_SOURCE_RE.test(String(modelCatalog.source || ''));
    const refreshSelectionFromSnapshot = selectModelIdsForVariantRefresh({
      snapshotModels: hasAuthoritativeSnapshot && Array.isArray(modelCatalog.models) ? modelCatalog.models : [],
      currentModel: modelCatalog.currentModel,
      defaultModel: modelCatalog.defaultModel,
      helpModelIds: [],
    });
    source = refreshSelectionFromSnapshot.source;
    modelIds = refreshSelectionFromSnapshot.modelIds;
    const genericHelpText = await runCopilotCliCommand(['help']).catch(() => '');
    reasoningEfforts = parseReasoningEffortsFromHelpOutput(genericHelpText);
    if (!modelIds.length) {
      const configHelpText = await runCopilotCliCommand(['help', 'config']);
      const helpModelIds = parseModelsFromHelpConfigOutput(configHelpText);
      const refreshSelectionFromHelp = selectModelIdsForVariantRefresh({
        snapshotModels: [],
        currentModel: '',
        defaultModel: '',
        helpModelIds,
      });
      source = refreshSelectionFromHelp.source;
      modelIds = refreshSelectionFromHelp.modelIds;
    }
    // A refresh re-derives rows from what the table already knows about each
    // model: the runtime-reported efforts, context limits and metadata. The
    // help-text ladder only covers models nothing has described.
    const rows = listModelVariantRows();
    const contextLimitsByModel = {};
    for (const row of rows) {
      if (row.contextLimitTokens && !contextLimitsByModel[row.baseModelId]) {
        contextLimitsByModel[row.baseModelId] = row.contextLimitTokens;
      }
    }
    const entries = buildModelVariantEntries(modelIds, {
      defaultEnabled: false,
      contextLimitsByModel,
      modelMetadataByModel: storedMetadataByModel(rows),
      fallbackEfforts: reasoningEfforts,
    });
    if (!entries.length) {
      throw new Error('No models found in snapshot/help model output');
    }
    return upsertModelVariantCatalogEntries(entries, {
      source,
      error: null,
      preserveEnabled: true,
    });
  }

  /**
   * Attach the database: prepare statements, seed an empty table with the
   * curated ids, normalize legacy variant ids, and number the rows
   * canonically. Mirrors the runtime's original post-schema block.
   */
  function bindDatabase(database) {
    db = database;
    modelSelectorSql = {
      listVariants: db.prepare(`
        SELECT ${VARIANT_COLUMNS}
        FROM model_variants
        ORDER BY sort_order ASC, base_model_id ASC, variant_id ASC
      `),
      listEnabledVariants: db.prepare(`
        SELECT ${VARIANT_COLUMNS}
        FROM model_variants
        WHERE enabled = 1
        ORDER BY sort_order ASC, base_model_id ASC, variant_id ASC
      `),
      upsertVariant: db.prepare(`
        INSERT INTO model_variants (
          ${VARIANT_COLUMNS}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(variant_id) DO UPDATE SET
          base_model_id = excluded.base_model_id,
          provider = excluded.provider,
          label = excluded.label,
          release_status = excluded.release_status,
          reasoning_effort = excluded.reasoning_effort,
          context_limit_tokens = COALESCE(excluded.context_limit_tokens, model_variants.context_limit_tokens),
          long_context_limit_tokens = COALESCE(excluded.long_context_limit_tokens, model_variants.long_context_limit_tokens),
          pricing_json = COALESCE(excluded.pricing_json, model_variants.pricing_json),
          metadata_json = COALESCE(excluded.metadata_json, model_variants.metadata_json),
          enabled = excluded.enabled,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `),
      updateContextLimitForBase: db.prepare(`
        UPDATE model_variants
        SET context_limit_tokens = ?, updated_at = ?
        WHERE base_model_id = ?
      `),
      updateModelMetadataForBase: db.prepare(`
        UPDATE model_variants
        SET context_limit_tokens = COALESCE(?, context_limit_tokens),
            long_context_limit_tokens = COALESCE(?, long_context_limit_tokens),
            pricing_json = COALESCE(?, pricing_json),
            metadata_json = COALESCE(?, metadata_json),
            updated_at = ?
        WHERE base_model_id = ?
      `),
      updateSortOrderForBase: db.prepare(`UPDATE model_variants SET sort_order = ? WHERE base_model_id = ?`),
      disableAllVariants: db.prepare(`UPDATE model_variants SET enabled = 0, updated_at = ?`),
      enableVariant: db.prepare(`UPDATE model_variants SET enabled = 1, updated_at = ? WHERE variant_id = ?`),
      deleteVariant: db.prepare(`DELETE FROM model_variants WHERE variant_id = ?`),
      getSelectorState: db.prepare(`SELECT source, refreshed_at, error, updated_at FROM model_selector_state WHERE id = 1 LIMIT 1`),
      upsertSelectorState: db.prepare(`
        INSERT INTO model_selector_state (id, source, refreshed_at, error, updated_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source = excluded.source,
          refreshed_at = excluded.refreshed_at,
          error = excluded.error,
          updated_at = excluded.updated_at
      `),
    };

    const existingCount = Number(db.prepare(`SELECT COUNT(*) AS cnt FROM model_variants`).get()?.cnt || 0);
    const normalizeLegacyVariantIdsTx = db.transaction(() => {
      const rows = modelSelectorSql.listVariants.all();
      const canonicalRows = new Map();
      for (const rawRow of rows) {
        const row = normalizeModelVariantRow(rawRow);
        const canonicalBaseModelId = canonicalizeModelId(row.baseModelId);
        if (!canonicalBaseModelId) continue;
        const canonicalVariantId = buildModelVariantId(canonicalBaseModelId, row.reasoningEffort);
        const existing = canonicalRows.get(canonicalVariantId);
        if (!existing) {
          canonicalRows.set(canonicalVariantId, {
            variantId: canonicalVariantId,
            baseModelId: canonicalBaseModelId,
            provider: row.provider || modelProviderForId(canonicalBaseModelId),
            label: row.label || modelDisplayLabel(canonicalBaseModelId),
            releaseStatus: row.releaseStatus || null,
            reasoningEffort: row.reasoningEffort || null,
            contextLimitTokens: row.contextLimitTokens,
            longContextLimitTokens: row.longContextLimitTokens,
            pricing: row.pricing,
            metadata: row.metadata,
            enabled: row.enabled ? 1 : 0,
            sortOrder: row.sortOrder,
            updatedAt: row.updatedAt,
          });
          continue;
        }
        existing.enabled = existing.enabled || (row.enabled ? 1 : 0) ? 1 : 0;
        if (existing.releaseStatus !== null && row.releaseStatus === null) {
          existing.releaseStatus = null;
        }
        existing.sortOrder = Math.min(existing.sortOrder, row.sortOrder);
        if (!existing.label && row.label) existing.label = row.label;
      }

      const nowIso = new Date().toISOString();
      for (const entry of canonicalRows.values()) {
        runVariantUpsert(entry, entry.enabled, nowIso);
      }
      for (const rawRow of rows) {
        const rawVariantId = String(rawRow?.variant_id || '').trim();
        const rawBaseModelId = String(rawRow?.base_model_id || '').trim();
        const canonicalBaseModelId = canonicalizeModelId(rawBaseModelId);
        if (!canonicalBaseModelId) continue;
        const canonicalReasoningEffort = normalizeReasoningEffort(rawRow?.reasoning_effort);
        const canonicalVariantId = buildModelVariantId(canonicalBaseModelId, canonicalReasoningEffort);
        if (rawVariantId !== canonicalVariantId) {
          modelSelectorSql.deleteVariant.run(rawVariantId);
        }
      }
    });
    if (existingCount === 0) {
      const nowIso = new Date().toISOString();
      const seedEntries = buildModelVariantEntries(curatedModelList(), { defaultEnabled: true });
      const tx = db.transaction(() => {
        for (const entry of seedEntries) runVariantUpsert(entry, entry.enabled, nowIso);
        modelSelectorSql.upsertSelectorState.run('bootstrap-seed', nowIso, null, nowIso);
      });
      tx();
    } else if (!modelSelectorSql.getSelectorState.get()) {
      const nowIso = new Date().toISOString();
      modelSelectorSql.upsertSelectorState.run('legacy', nowIso, null, nowIso);
    }
    normalizeLegacyVariantIdsTx();
    recomputeSortOrder();
  }

  return {
    SUPPORTED_REASONING_EFFORTS,
    FALLBACK_REASONING_EFFORTS,
    bindDatabase,
    normalizeReasoningEffort,
    buildModelVariantId,
    parseModelVariantId,
    normalizeModelVariantRow,
    buildModelVariantEntries,
    normalizeModelMetadataByModel,
    normalizeContextLimitsByModel,
    getModelCatalogState,
    updateModelCatalog,
    listModelVariantRows,
    listEnabledModelVariantRows,
    getModelContextLimitTokens,
    parseModelVariantSelection,
    getModelVariantSelectorState,
    upsertModelVariantCatalogEntries,
    setEnabledModelVariants,
    refreshModelVariantCatalogFromCli,
    parseModelsFromHelpConfigOutput,
    parseReasoningEffortsFromHelpOutput,
    /** The in-memory snapshot state (read-only view for the runtime). */
    get modelCatalog() { return modelCatalog; },
  };
}
