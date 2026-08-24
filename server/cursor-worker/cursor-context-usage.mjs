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

// Percentages above this are impossible occupancy readings; the worker clamps
// them so the stored blob never claims more than a full window.
const MAX_PERCENT = 100;

function tokenCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function buildCursorContextUsage({
  usage,
  model = '',
  contextWindow = null,
  modelCallCount = 1,
} = {}) {
  if (!usage || typeof usage !== 'object') return null;

  const inputTokens = tokenCount(usage.inputTokens);
  const outputTokens = tokenCount(usage.outputTokens);
  const cacheReadTokens = tokenCount(usage.cacheReadTokens);
  const cacheWriteTokens = tokenCount(usage.cacheWriteTokens);
  if (inputTokens === null && outputTokens === null
    && cacheReadTokens === null && cacheWriteTokens === null) {
    return null;
  }

  // The SDK's turn usage aggregates EVERY model call in the turn, and each
  // call re-sends the whole context — so input + cache reads + cache writes is
  // roughly `calls ×` the real occupancy (observed 10× the window on long
  // agentic turns; the SDK's cumulative `totalTokens` is even further off and
  // must not be used). Divide the prompt-side aggregate by the model-call
  // count for a per-call average: an estimate that slightly undershoots the
  // final call's context instead of pinning the gauge at 100%.
  const calls = Math.max(1, Math.round(Number(modelCallCount) || 1));
  const promptAggregate = (inputTokens || 0) + (cacheReadTokens || 0) + (cacheWriteTokens || 0);
  const totalTokens = Math.round(promptAggregate / calls) + (outputTokens || 0);
  const estimateKind = calls > 1 ? 'cursor-per-call-average' : null;
  const maxTokens = (typeof contextWindow === 'number' && Number.isFinite(contextWindow)
    && contextWindow > 0)
    ? Math.round(contextWindow)
    : null;

  const contextUsage = {
    model,
    totalTokens,
    ...(maxTokens !== null
      ? {
        maxTokens,
        percentage: Math.min(MAX_PERCENT, Math.round((totalTokens / maxTokens) * 10000) / 100),
      }
      : {}),
    ...(estimateKind ? { estimateKind } : {}),
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
