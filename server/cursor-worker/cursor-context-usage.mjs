/**
 * Maps the Cursor SDK's TokenUsage onto the payload shape the relay already
 * persists for Claude sessions, so `normalizeClaudeContextUsage` and
 * `buildClaudeContextSnapshot` (server/services/claude-context-usage.mjs)
 * render it unchanged.
 *
 * The Cursor SDK reports no per-category breakdown and no auto-compact
 * settings, so `categories` is always empty and the skills/autoCompact keys
 * are omitted entirely.
 */

function tokenCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function buildCursorContextUsage({ usage, model = '', contextWindow = null } = {}) {
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const cacheReadTokens = tokenCount(usage.cacheReadTokens);
  const cacheWriteTokens = tokenCount(usage.cacheWriteTokens);
  if (inputTokens === null && outputTokens === null
    && cacheReadTokens === null && cacheWriteTokens === null) {
    return null;
  }

  // Context occupancy comes from the LAST usage event: input + cache reads +
  // cache writes + output approximates what the next request re-sends. The
  // SDK's `totalTokens` is cumulative across the run, so it must not be used.
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
