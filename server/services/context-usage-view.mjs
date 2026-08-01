'use strict';

/**
 * Builds the provider-neutral payload the context-usage modal renders.
 *
 * Claude sessions supply real per-category token counts from the Agent SDK;
 * Copilot sessions only have the coarse system/tools/messages split recorded in
 * their session events, so those are synthesized into the same shape. One
 * renderer serves both.
 */

// Fallback ordering/colors for synthesized (Copilot) categories. Claude
// categories arrive with their own SDK-assigned colors.
const COPILOT_CATEGORY_COLORS = Object.freeze({
  'System/Tools': 'blue',
  Messages: 'orange',
  Buffer: 'gray',
});

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function toNullablePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function percentOf(tokens, maxTokens) {
  if (tokens === null || maxTokens === null || maxTokens <= 0) return null;
  return Math.round((tokens / maxTokens) * 10000) / 100;
}

function buildCopilotCategories(snapshot) {
  const raw = [
    ['System/Tools', toNullableInt(snapshot?.system_tools_tokens)],
    ['Messages', toNullableInt(snapshot?.messages_tokens)],
    ['Buffer', toNullableInt(snapshot?.buffer_tokens)],
  ];
  return raw
    .filter(([, tokens]) => tokens !== null && tokens > 0)
    .map(([name, tokens]) => ({
      name,
      tokens,
      color: COPILOT_CATEGORY_COLORS[name] || null,
      isDeferred: false,
    }));
}

/**
 * @param {object} args
 * @param {object|null} args.snapshot   the shared context snapshot contract
 * @param {object|null} args.contextUsage normalized Claude SDK usage, when available
 * @returns {object|null} null when there is nothing worth rendering
 */
export function buildContextUsageView({ snapshot = null, contextUsage = null } = {}) {
  const maxTokens = toNullableInt(contextUsage?.maxTokens)
    ?? toNullableInt(snapshot?.max_context_tokens);
  const totalTokens = toNullableInt(contextUsage?.totalTokens)
    ?? toNullableInt(snapshot?.used_total_tokens);
  if (totalTokens === null && maxTokens === null) return null;

  const percentage = toNullablePercent(contextUsage?.percentage)
    ?? toNullablePercent(snapshot?.used_percent)
    ?? percentOf(totalTokens, maxTokens);

  const sourceCategories = Array.isArray(contextUsage?.categories) && contextUsage.categories.length
    ? contextUsage.categories
    : buildCopilotCategories(snapshot);

  const categories = sourceCategories
    .map((entry) => ({
      name: normalizeText(entry?.name),
      tokens: toNullableInt(entry?.tokens),
      color: normalizeText(entry?.color) || null,
      isDeferred: entry?.isDeferred === true,
    }))
    .filter((entry) => entry.name && entry.tokens !== null && entry.tokens > 0)
    .map((entry) => ({ ...entry, percent: percentOf(entry.tokens, maxTokens) }));

  const freeTokens = toNullableInt(snapshot?.free_tokens)
    ?? ((totalTokens !== null && maxTokens !== null) ? Math.max(0, maxTokens - totalTokens) : null);

  return {
    model: normalizeText(contextUsage?.model) || normalizeText(snapshot?.model) || null,
    totalTokens,
    maxTokens,
    // Clamp: an estimated snapshot can report more than 100% (see the
    // cumulative-output estimator), and the bar must not overflow.
    percentage: percentage === null ? null : Math.max(0, Math.min(100, percentage)),
    categories,
    freeTokens,
    freePercent: percentOf(freeTokens, maxTokens),
    autoCompactThreshold: toNullablePercent(contextUsage?.autoCompactThreshold),
    isAutoCompactEnabled: contextUsage?.isAutoCompactEnabled === true,
    // Copilot's degraded path reports a lower bound only; the UI labels it
    // rather than presenting it as measured.
    isEstimate: !!normalizeText(snapshot?.estimate_kind),
    estimateKind: normalizeText(snapshot?.estimate_kind) || null,
    capturedAt: normalizeText(snapshot?.captured_at) || null,
  };
}
