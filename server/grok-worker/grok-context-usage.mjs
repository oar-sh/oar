/**
 * Maps a normalized Grok turn usage blob (per-prompt `_meta` tokens from
 * `normalizeGrokTurnUsage`) onto the payload shape the relay already persists
 * for Claude/Cursor sessions, so the existing context view renders it
 * unchanged. Mirrors `buildCursorContextUsage`.
 *
 * ACP reports no per-category breakdown, so `categories` is always empty.
 */

// Best-effort fallbacks when ACP model discovery reports no window size.
// Values from the public xAI model docs; unknown models get no fill metric
// (token totals only, like Cursor's partial state).
const GROK_MODEL_CONTEXT_WINDOWS = {
  'grok-4.5': 256_000,
  'grok-4': 256_000,
  'grok-code-fast-1': 256_000,
};

export function resolveGrokContextWindow(model = '', contextWindowsByModel = {}) {
  const key = String(model || '').trim().toLowerCase();
  if (!key) return null;
  const discovered = Number(contextWindowsByModel?.[key]);
  if (Number.isFinite(discovered) && discovered > 0) return Math.round(discovered);
  const known = GROK_MODEL_CONTEXT_WINDOWS[key];
  return typeof known === 'number' ? known : null;
}

function tokenCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function buildGrokContextUsage({ usage, model = '', contextWindow = null } = {}) {
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const cacheReadTokens = tokenCount(usage.cachedReadTokens);
  const cacheWriteTokens = tokenCount(usage.cacheCreationTokens);
  if (inputTokens === null && outputTokens === null
    && cacheReadTokens === null && cacheWriteTokens === null) {
    return null;
  }

  // Context occupancy approximates what the next request re-sends: fresh
  // input + cache reads + cache writes + the reply. The blob's `totalTokens`
  // may be cumulative across the turn's model calls, so it is not used.
  const totalTokens = (inputTokens || 0) + (cacheReadTokens || 0)
    + (cacheWriteTokens || 0) + (outputTokens || 0);
  const maxTokens = (typeof contextWindow === 'number' && Number.isFinite(contextWindow)
    && contextWindow > 0)
    ? Math.round(contextWindow)
    : null;

  const contextUsage = {
    model,
    totalTokens,
    ...(maxTokens !== null
      ? { maxTokens, percentage: Math.round((totalTokens / maxTokens) * 10000) / 100 }
      : {}),
    categories: [],
    apiUsage: {
      input_tokens: inputTokens || 0,
      output_tokens: outputTokens || 0,
      cache_read_input_tokens: cacheReadTokens || 0,
      cache_creation_input_tokens: cacheWriteTokens || 0,
    },
  };

  const modelUsage = {
    [model]: {
      ...(maxTokens !== null ? { contextWindow: maxTokens } : {}),
      inputTokens: inputTokens || 0,
      outputTokens: outputTokens || 0,
      cacheReadInputTokens: cacheReadTokens || 0,
      cacheCreationInputTokens: cacheWriteTokens || 0,
    },
  };

  return { contextUsage, modelUsage };
}
