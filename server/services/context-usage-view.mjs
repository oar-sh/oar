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

/**
 * Split the unused window into the part a conversation may actually occupy and
 * the reserve above the auto-compact threshold.
 *
 * Every snapshot writer derives free space as `max - used`, which still
 * *contains* the region the buffer describes. Anything rendering the two side
 * by side (the usage grid, the modal's free row) needs disjoint slices, or the
 * pair overshoots the window — latent until Claude began reporting a real
 * buffer instead of a always-zero one.
 */
export function splitFreeAndBufferTokens(snapshot) {
  const freeTokens = toNullableInt(snapshot?.free_tokens);
  const bufferTokens = toNullableInt(snapshot?.buffer_tokens);
  if (freeTokens === null || bufferTokens === null) return { freeTokens, bufferTokens };
  // Only a writer that derived free space from `max - used` folded the buffer
  // into it. A provider-reported remainder (Copilot's remainingTokens /
  // availableTokens, which sit alongside its own safeBufferTokens) is already
  // net of that reserve, and subtracting twice would understate it — so an
  // unflagged snapshot is left alone.
  if (snapshot?.free_tokens_includes_buffer !== true) return { freeTokens, bufferTokens };
  // Past the threshold the reserve is bigger than what is left, so the buffer
  // takes the remainder and free space reads as spent.
  const reserved = Math.max(0, Math.min(bufferTokens, freeTokens));
  return { freeTokens: freeTokens - reserved, bufferTokens: reserved };
}

function buildCopilotCategories(snapshot) {
  // The auto-compact reserve is deliberately absent: it is not occupied
  // context, and it now rides the view as its own field so Claude sessions
  // (whose categories come from the SDK) account for it too.
  const raw = [
    ['System/Tools', toNullableInt(snapshot?.system_tools_tokens)],
    ['Messages', toNullableInt(snapshot?.messages_tokens)],
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

  // Free space and buffer are two slices of the same unused window, so they are
  // resolved together before either is rendered.
  const storedFreeTokens = toNullableInt(snapshot?.free_tokens);
  const { freeTokens, bufferTokens } = splitFreeAndBufferTokens({
    free_tokens: storedFreeTokens
      ?? ((totalTokens !== null && maxTokens !== null) ? Math.max(0, maxTokens - totalTokens) : null),
    buffer_tokens: snapshot?.buffer_tokens,
    // Deriving the value here means it necessarily contains the buffer.
    free_tokens_includes_buffer: storedFreeTokens === null
      ? true
      : snapshot?.free_tokens_includes_buffer === true,
  });

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
    // Unused, but unusable: the window above the auto-compact threshold. Split
    // out of free space, so the two are rendered as separate rows and the
    // table still accounts for the whole window.
    bufferTokens,
    bufferPercent: percentOf(bufferTokens, maxTokens),
    // A token count, not a percent — the CLI compacts once the conversation
    // crosses it. `rawMaxTokens` is the model's own window, which the modal
    // uses to mark slider stops the model cannot honor.
    autoCompactThreshold: toNullableInt(contextUsage?.autoCompactThreshold),
    rawMaxTokens: toNullableInt(contextUsage?.rawMaxTokens),
    autocompactSource: normalizeText(contextUsage?.autocompactSource) || null,
    isAutoCompactEnabled: contextUsage?.isAutoCompactEnabled === true,
    // Copilot's degraded path reports a lower bound only; the UI labels it
    // rather than presenting it as measured.
    isEstimate: !!normalizeText(snapshot?.estimate_kind),
    estimateKind: normalizeText(snapshot?.estimate_kind) || null,
    capturedAt: normalizeText(snapshot?.captured_at) || null,
  };
}
