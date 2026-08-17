import { isValidModelId, normalizeModelIdCandidate } from './model-id.mjs';

// Keys that hold lists of sibling models in provider responses. The per-model
// fallback search must not descend into them, or a model with no context limit
// of its own would inherit a sibling's.
const MODEL_CONTAINER_KEYS = ['data', 'models', 'list', 'available', 'items', 'entries', 'result', 'response'];

export function normalizeContextLimitTokens(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
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

function normalizePricing(value, fallbackBatchSize = null) {
  if (!value || typeof value !== 'object') return null;
  const batchSize = normalizeContextLimitTokens(value.batchSize) ?? normalizeContextLimitTokens(fallbackBatchSize);
  const rates = {
    input: normalizePrice(value.inputPrice),
    output: normalizePrice(value.outputPrice),
    cacheRead: normalizePrice(value.cacheReadPrice ?? value.cachePrice),
    cacheWrite: normalizePrice(value.cacheWritePrice),
  };
  // batchSize alone is a denominator, not evidence of real pricing.
  if (!Object.values(rates).some((entry) => entry !== null)) return null;
  return { ...rates, batchSize };
}

function contextLimitForTier(value, tier = 'default') {
  const limits = value?.capabilities?.limits || value?.limits || {};
  const outputTokens = normalizeContextLimitTokens(
    limits.max_output_tokens ?? limits.maxOutputTokens ?? value?.maxOutputTokens,
  ) || 0;
  const tokenPrices = value?.billing?.tokenPrices || value?.tokenPrices || null;
  if (tier === 'long_context') {
    const longContext = tokenPrices?.longContext
      || value?.longContext;
    const promptTokens = findPromptBudgetTokens(longContext);
    return promptTokens === null ? null : promptTokens + outputTokens;
  }
  const defaultPromptTokens = findPromptBudgetTokens(tokenPrices)
    ?? normalizeContextLimitTokens(limits.max_prompt_tokens ?? limits.maxPromptTokens);
  if (defaultPromptTokens !== null) return defaultPromptTokens + outputTokens;
  return findContextLimitTokens(value);
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
  if (isValidModelId(modelId)) {
    const tokenPrices = value?.billing?.tokenPrices || value?.tokenPrices || null;
    out.push({
      modelId,
      contextLimitTokens: contextLimitForTier(value),
      longContextLimitTokens: contextLimitForTier(value, 'long_context'),
      pricing: {
        default: normalizePricing(tokenPrices),
        longContext: normalizePricing(tokenPrices?.longContext, tokenPrices?.batchSize),
      },
    });
  }
  for (const key of MODEL_CONTAINER_KEYS) {
    const nested = value[key];
    if (nested !== undefined && nested !== null) extractModelDescriptors(nested, out);
  }
  return out;
}
