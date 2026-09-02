// Static context-window fallbacks shared by the Copilot snapshot service, the
// Cursor worker and the Copilot SDK worker's BYOK provider config, so the
// tables cannot drift. Used only when the provider does not advertise a window
// itself (Copilot events without limits, Cursor models without a `context`
// parameter, an OpenAI-compatible endpoint the Copilot runtime does not
// recognise).

import { canonicalizeModelId } from './model-id.mjs';

// Context window of a model id carrying the `[1m]` capability suffix, whatever
// the base model's default window is.
export const LONG_CONTEXT_TOKENS = 1000000;

export const MODEL_FALLBACK_LIMITS = Object.freeze({
  // Anthropic Claude Sonnet
  'claude-sonnet-5': 200000,
  'claude-sonnet-4.6': 200000,
  'claude-sonnet-4.5': 200000,
  // Anthropic Claude Haiku
  'claude-haiku-4.5': 200000,
  // Anthropic Claude Fable
  'claude-fable-5': 200000,
  // Anthropic Claude Opus
  'claude-opus-5': 200000,
  'claude-opus-4.8': 200000,
  'claude-opus-4.7': 200000,
  'claude-opus-4.6': 200000,
  'claude-opus-4.6-fast': 200000,
  'claude-opus-4.5': 200000,
  // OpenAI GPT-5 series
  'gpt-5.6-terra': 272000,
  'gpt-5.6-luna': 272000,
  'gpt-5.6-sol': 272000,
  'gpt-5.5': 256000,
  'gpt-5.4': 256000,
  'gpt-5.3-codex': 256000,
  'gpt-5.2-codex': 256000,
  'gpt-5.2': 256000,
  'gpt-5.4-mini': 256000,
  'gpt-5-mini': 256000,
  // Google Gemini
  'gemini-3.1-pro-preview': 1000000,
  'gemini-3.5-flash': 1000000,
  // Cursor-served models without a `context` parameter in `models.list()`.
  // Conservative published defaults; a provider-advertised window always wins.
  'grok-4.5': 256000,
  'composer-2.5': 200000,
  // xAI models the Grok CLI serves when ACP discovery reports no window
  // (public xAI docs values); also reachable through the Cursor catalog.
  'grok-4': 256000,
  'grok-code-fast-1': 256000,
});

/**
 * Resolve a fallback context window for a model id.
 *
 * Model ids may carry a bracketed capability suffix (see `isSafeClaudeModelId`),
 * e.g. `claude-opus-5[1m]`. Those are a different context window than the base
 * model, so they are resolved first — falling through to the base entry would
 * report a 1M session as 200k.
 */
export function resolveFallbackContextLimitTokens(modelId) {
  const model = String(modelId || '').trim().toLowerCase();
  if (!model) return null;
  if (MODEL_FALLBACK_LIMITS[model]) return MODEL_FALLBACK_LIMITS[model];
  const suffixMatch = model.match(/\[([^\]]+)\]\s*$/);
  if (!suffixMatch) return null;
  if (suffixMatch[1].trim() === '1m') return LONG_CONTEXT_TOKENS;
  return MODEL_FALLBACK_LIMITS[model.slice(0, suffixMatch.index).trim()] || null;
}

/**
 * Max OUTPUT tokens per model family, matched by longest prefix.
 *
 * Separate from the windows above because the two are not interchangeable: the
 * window is how much a request may total, this is how much of it the completion
 * may claim. Only the OpenAI-compatible families a BYOK endpoint can serve are
 * listed — an unlisted family resolves to no ceilings at all, which is the
 * point (see `resolveModelTokenCeilings`).
 */
const MODEL_OUTPUT_TOKEN_LIMITS = Object.freeze([
  Object.freeze({ prefix: 'gpt-4o', maxOutputTokens: 16_384 }),
  Object.freeze({ prefix: 'gpt-4.1', maxOutputTokens: 32_768 }),
  Object.freeze({ prefix: 'gpt-5', maxOutputTokens: 128_000 }),
  Object.freeze({ prefix: 'codex-', maxOutputTokens: 128_000 }),
  Object.freeze({ prefix: 'o3', maxOutputTokens: 100_000 }),
  Object.freeze({ prefix: 'o4-', maxOutputTokens: 100_000 }),
]);

/**
 * Family-level context windows, matched by longest prefix, for ids
 * `MODEL_FALLBACK_LIMITS` does not name individually.
 *
 * Deliberately NOT merged into that table: it is consulted by the Copilot
 * snapshot service and the Cursor worker as an exact-id lookup for models those
 * providers actually serve, and widening it to whole families would start
 * answering questions those callers currently (correctly) answer with "no
 * fallback". This table is only read through `resolveModelTokenCeilings`, whose
 * one consumer is the BYOK provider config, and the exact-id table always wins.
 */
const MODEL_FAMILY_CONTEXT_WINDOWS = Object.freeze([
  Object.freeze({ prefix: 'gpt-4o', contextWindow: 128_000 }),
  Object.freeze({ prefix: 'gpt-4.1', contextWindow: 1_047_576 }),
  // The gpt-5 family spans 256k (gpt-5.2/5.4/5.5 and the minis) and 272k (the
  // 5.6 series); the exact-id table separates them. An id this module has never
  // heard of gets the SMALLER of the two, because a window guessed too large is
  // the harmful direction: it converts what would have been early compaction
  // into a hard API rejection with the whole history intact.
  Object.freeze({ prefix: 'gpt-5', contextWindow: 256_000 }),
  Object.freeze({ prefix: 'codex-', contextWindow: 256_000 }),
  Object.freeze({ prefix: 'o3', contextWindow: 200_000 }),
  Object.freeze({ prefix: 'o4-', contextWindow: 200_000 }),
]);

function longestPrefixEntry(table, model) {
  let best = null;
  for (const entry of table) {
    if (!model.startsWith(entry.prefix)) continue;
    if (!best || entry.prefix.length > best.prefix.length) best = entry;
  }
  return best;
}

/**
 * Resolve `{ contextWindow, maxPromptTokens, maxOutputTokens }` for a model id,
 * or `{}` when this module cannot answer confidently.
 *
 * The prompt ceiling is DERIVED (`window − output`) rather than tabulated, so
 * the two numbers can never contradict each other: a consumer compares the
 * whole outbound prompt against `maxPromptTokens` before deciding to compact,
 * and the completion still has to fit alongside it inside the same window.
 *
 * Returning `{}` for an unknown model is the deliberate answer, not a gap. A
 * guessed ceiling that is too HIGH turns early compaction into hard API errors,
 * whereas the consumer's own default is merely conservative.
 */
export function resolveModelTokenCeilings(modelId) {
  const model = canonicalizeModelId(modelId);
  if (!model) return {};
  const maxOutputTokens = longestPrefixEntry(MODEL_OUTPUT_TOKEN_LIMITS, model)?.maxOutputTokens ?? null;
  const contextWindow = resolveFallbackContextLimitTokens(model)
    ?? longestPrefixEntry(MODEL_FAMILY_CONTEXT_WINDOWS, model)?.contextWindow
    ?? null;
  if (!contextWindow || !maxOutputTokens) return {};
  const maxPromptTokens = contextWindow - maxOutputTokens;
  if (!(maxPromptTokens > 0)) return {};
  return { contextWindow, maxPromptTokens, maxOutputTokens };
}
