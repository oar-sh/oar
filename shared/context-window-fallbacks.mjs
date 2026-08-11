// Static context-window fallbacks shared by the Copilot snapshot service and
// the Cursor worker, so the two tables cannot drift. Used only when the
// provider does not advertise a window itself (Copilot events without limits,
// Cursor models without a `context` parameter).

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
