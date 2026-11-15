import { isValidModelId, normalizeModelIdCandidate } from './model-id.mjs';

// Keys that hold lists of sibling models in provider responses. The per-model
// fallback search must not descend into them, or a model with no context limit
// of its own would inherit a sibling's.
const MODEL_CONTAINER_KEYS = ['data', 'models', 'list', 'available', 'items', 'entries', 'result', 'response'];

/**
 * Every reasoning-effort level any Copilot catalog entry has been observed to
 * advertise, in ladder order. `none` is the GPT family's explicit "no
 * reasoning" level (and the relay's "model default" convention for
 * effort-less models); `minimal` is Gemini's floor. Consumers validate against
 * THIS list, not a per-family guess.
 */
export const KNOWN_REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const MODEL_PICKER_CATEGORIES = Object.freeze(['powerful', 'versatile', 'lightweight']);

export function normalizeContextLimitTokens(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

/**
 * The effort levels a catalog entry advertises, tolerant of both shapes the
 * runtime speaks: the client-level `ModelInfo` (`supportedReasoningEfforts`)
 * and the session-level `rpc.model.list()` entry, which is the RAW CAPI
 * record carrying the list at `capabilities.supports.reasoning_effort`
 * (live-verified on runtime 1.0.83 — the typed field never appears there;
 * validating against it failed every effort-carrying turn, burn-in session
 * ed5febdd). `null` = the entry carries no list: for an authoritative catalog
 * entry that means the model has no effort control at all; callers that
 * validate must stay PERMISSIVE on null, the runtime is the authority.
 */
export function supportedEffortsOf(entry) {
  const typed = entry?.supportedReasoningEfforts;
  if (Array.isArray(typed)) return typed.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  const wire = entry?.capabilities?.supports?.reasoning_effort;
  if (Array.isArray(wire)) return wire.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
  return null;
}

function findContextLimitTokens(value) {
  if (!value || typeof value !== 'object') return null;
  const candidates = [
    value.contextLimitTokens,
    value.maxContextTokens,
    value.contextWindow,
    value.max_context_tokens,
    value.tokenBudget,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeContextLimitTokens(candidate);
    if (normalized !== null) return normalized;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!nested || typeof nested !== 'object') continue;
    if (MODEL_CONTAINER_KEYS.includes(key)) continue;
    const normalized = findContextLimitTokens(nested);
    if (normalized !== null) return normalized;
  }
  return null;
}

function findPromptBudgetTokens(value) {
  if (!value || typeof value !== 'object') return null;
  const candidates = [
    value.maxPromptTokens,
    value.max_prompt_tokens,
    value.contextMax,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeContextLimitTokens(candidate);
    if (normalized !== null) return normalized;
  }
  return null;
}

function normalizePrice(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

// Both spellings the runtime uses: the typed client `ModelInfo` is camelCase
// (`tokenPrices.longContext.inputPrice`), the raw CAPI record on the session
// list is snake_case (`token_prices.long_context.input_price`).
function normalizePricing(value, fallbackBatchSize = null) {
  if (!value || typeof value !== 'object') return null;
  const batchSize = normalizeContextLimitTokens(value.batchSize ?? value.batch_size)
    ?? normalizeContextLimitTokens(fallbackBatchSize);
  const rates = {
    input: normalizePrice(value.inputPrice ?? value.input_price),
    output: normalizePrice(value.outputPrice ?? value.output_price),
    cacheRead: normalizePrice(value.cacheReadPrice ?? value.cache_read_price ?? value.cachePrice ?? value.cache_price),
    cacheWrite: normalizePrice(value.cacheWritePrice ?? value.cache_write_price),
  };
  // batchSize alone is a denominator, not evidence of real pricing.
  if (!Object.values(rates).some((entry) => entry !== null)) return null;
  return { ...rates, batchSize };
}

function tokenPricesOf(value) {
  return value?.billing?.tokenPrices
    || value?.billing?.token_prices
    || value?.tokenPrices
    || value?.token_prices
    || null;
}

function longContextPricesOf(tokenPrices, value) {
  return tokenPrices?.longContext || tokenPrices?.long_context || value?.longContext || value?.long_context || null;
}

function defaultPricesOf(tokenPrices) {
  // The raw record nests the default tier under `default`; the typed shape
  // puts the default rates directly on tokenPrices.
  return tokenPrices?.default && typeof tokenPrices.default === 'object' ? tokenPrices.default : tokenPrices;
}

function limitsOf(value) {
  return value?.capabilities?.limits || value?.limits || {};
}

/** `capabilities.limits.max_context_window_tokens` — the REAL window. */
function contextWindowTokensOf(value) {
  const limits = limitsOf(value);
  return normalizeContextLimitTokens(
    limits.max_context_window_tokens ?? limits.maxContextWindowTokens ?? value?.maxContextWindowTokens,
  );
}

function maxPromptTokensOf(value) {
  const limits = limitsOf(value);
  return normalizeContextLimitTokens(limits.max_prompt_tokens ?? limits.maxPromptTokens ?? value?.maxPromptTokens);
}

function maxOutputTokensOf(value) {
  const limits = limitsOf(value);
  return normalizeContextLimitTokens(limits.max_output_tokens ?? limits.maxOutputTokens ?? value?.maxOutputTokens) || 0;
}

/**
 * The context budget of a pricing tier: prompt budget + output budget. The
 * real window (`max_context_window_tokens`) caps it — a runtime's advertised
 * prompt+output pair can exceed the window (haiku: 128000+32000 vs a 144000
 * window) and the cap is what stops the auto-compact thresholds from being
 * computed against tokens the model cannot actually hold. When no tier budget
 * is advertised the window itself is the limit.
 */
function contextLimitForTier(value, tier = 'default') {
  const outputTokens = maxOutputTokensOf(value);
  const window = contextWindowTokensOf(value);
  const capToWindow = (tokens) => (tokens !== null && window !== null ? Math.min(tokens, window) : tokens);
  const tokenPrices = tokenPricesOf(value);
  if (tier === 'long_context') {
    const promptTokens = findPromptBudgetTokens(longContextPricesOf(tokenPrices, value));
    return promptTokens === null ? null : capToWindow(promptTokens + outputTokens);
  }
  const defaultPromptTokens = findPromptBudgetTokens(defaultPricesOf(tokenPrices))
    ?? maxPromptTokensOf(value);
  if (defaultPromptTokens !== null) return capToWindow(defaultPromptTokens + outputTokens);
  return window ?? findContextLimitTokens(value);
}

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizePickerCategory(value) {
  const text = String(value || '').trim().toLowerCase();
  return MODEL_PICKER_CATEGORIES.includes(text) ? text : null;
}

/**
 * One descriptor per catalog entry, from EITHER wire shape (raw CAPI record
 * or typed `ModelInfo`). Every field the API contract carries is decided
 * here and nowhere else, so the worker's session list and the discovery
 * service's client list yield identical metadata for the same model.
 */
function describeEntry(modelId, value) {
  const tokenPrices = tokenPricesOf(value);
  const defaultPrices = defaultPricesOf(tokenPrices);
  const batchSize = tokenPrices?.batchSize ?? tokenPrices?.batch_size ?? null;
  return {
    modelId,
    contextLimitTokens: contextLimitForTier(value),
    longContextLimitTokens: contextLimitForTier(value, 'long_context'),
    pricing: {
      default: normalizePricing(defaultPrices, batchSize),
      longContext: normalizePricing(longContextPricesOf(tokenPrices, value), batchSize),
    },
    displayName: normalizeText(value.name ?? value.displayName),
    vendor: normalizeText(value.vendor),
    pickerCategory: normalizePickerCategory(value.model_picker_category ?? value.modelPickerCategory),
    preview: value.preview === true,
    contextWindowTokens: contextWindowTokensOf(value),
    maxPromptTokens: maxPromptTokensOf(value),
    supportedEfforts: supportedEffortsOf(value),
  };
}

export function extractModelDescriptors(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    const modelId = normalizeModelIdCandidate(value);
    if (isValidModelId(modelId)) out.push({ modelId, contextLimitTokens: null });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractModelDescriptors(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;

  const modelId = normalizeModelIdCandidate(value.modelId || value.id || value.model || null);
  if (isValidModelId(modelId)) out.push(describeEntry(modelId, value));
  for (const key of MODEL_CONTAINER_KEYS) {
    const nested = value[key];
    if (nested !== undefined && nested !== null) extractModelDescriptors(nested, out);
  }
  return out;
}

/**
 * The per-model metadata object of the catalog API contract
 * (`modelMetadataByModel[modelId]` on GET /api/models, GET /api/model-variants
 * and the models_updated socket payload), built from one descriptor. All three
 * snapshot producers publish exactly this; `catalogIndex` is assigned by the
 * relay from the canonical order, never by a producer.
 */
export function modelMetadataFromDescriptor(descriptor = {}) {
  return {
    defaultContextLimitTokens: normalizeContextLimitTokens(descriptor.contextLimitTokens),
    longContextLimitTokens: normalizeContextLimitTokens(descriptor.longContextLimitTokens),
    pricing: descriptor.pricing && typeof descriptor.pricing === 'object' ? descriptor.pricing : null,
    displayName: normalizeText(descriptor.displayName),
    vendor: normalizeText(descriptor.vendor),
    pickerCategory: normalizePickerCategory(descriptor.pickerCategory),
    preview: descriptor.preview === true,
    contextWindowTokens: normalizeContextLimitTokens(descriptor.contextWindowTokens),
    maxPromptTokens: normalizeContextLimitTokens(descriptor.maxPromptTokens),
    supportedEfforts: Array.isArray(descriptor.supportedEfforts)
      ? descriptor.supportedEfforts.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
      : null,
    catalogIndex: null,
  };
}

/**
 * The `{ models, contextLimitsByModel, modelMetadataByModel }` triple every
 * `/api/models/snapshot` publisher sends, so the worker and the server-side
 * discovery cannot drift in what they publish.
 */
export function buildModelSnapshotFields(descriptors = []) {
  const list = Array.isArray(descriptors) ? descriptors.filter((entry) => entry?.modelId) : [];
  return {
    models: list.map((entry) => entry.modelId),
    contextLimitsByModel: Object.fromEntries(
      list
        .filter((entry) => normalizeContextLimitTokens(entry.contextLimitTokens) !== null)
        .map((entry) => [entry.modelId, normalizeContextLimitTokens(entry.contextLimitTokens)]),
    ),
    modelMetadataByModel: Object.fromEntries(
      list.map((entry) => [entry.modelId, modelMetadataFromDescriptor(entry)]),
    ),
  };
}
