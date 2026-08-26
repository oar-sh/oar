// Mirrors shared/model-id.mjs, which the browser cannot import (only
// server/public is served).
const CLAUDE_LONG_CONTEXT_LIMIT_TOKENS = 1000000;
const UNKNOWN_WINDOW_LABEL = '—';

function tokenLabel(tokens) {
  const limit = Number(tokens);
  return Number.isFinite(limit) && limit > 0 ? `${Math.round(limit / 1000)}K` : UNKNOWN_WINDOW_LABEL;
}

function claudeTiersForModel(modelId, claudeTiers) {
  const key = String(modelId || '').trim().toLowerCase();
  if (!key || !claudeTiers || typeof claudeTiers !== 'object') return null;
  const tiers = claudeTiers[key];
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  return tiers;
}

/**
 * The context-window options for one model *under one provider*.
 *
 * modelMetadataByModel is keyed by model id alone, so a model that both Copilot
 * and the Claude SDK serve (claude-opus-5) would otherwise advertise Copilot's
 * windows on a Claude conversation. For the Claude provider the offered tiers
 * are exactly the enabled catalog ids the server folded into
 * claudeContextTiersByModel: base id → default, "[1m]" id → long_context, and a
 * model may legitimately have only one of the two.
 */
export function buildContextTierOptions({
  modelId = '',
  providerType = '',
  metadata = null,
  claudeTiers = null,
} = {}) {
  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const defaultLabel = tokenLabel(meta.defaultContextLimitTokens);
  const provider = String(providerType || '').trim().toLowerCase();
  const claudeTierList = provider === 'claude' ? claudeTiersForModel(modelId, claudeTiers) : null;
  if (claudeTierList) {
    return claudeTierList
      .map((tier) => String(tier?.value || '').trim().toLowerCase())
      .filter((value) => value === 'default' || value === 'long_context')
      // The Claude catalog carries no per-model window, and the number in the
      // merged metadata is Copilot's (claude-opus-5 reads 264000 there). The
      // SDK's own defaults vary per model anyway — claude-sonnet-5 reports
      // 967000, claude-haiku-4-5 200000, claude-opus-5 1000000 — so any
      // borrowed figure would be wrong for most models. Blank beats wrong.
      .map((value) => (value === 'long_context'
        ? { value, label: tokenLabel(CLAUDE_LONG_CONTEXT_LIMIT_TOKENS) }
        : { value, label: UNKNOWN_WINDOW_LABEL }));
  }
  const longLimit = Number(meta.longContextLimitTokens);
  return [
    { value: 'default', label: defaultLabel },
    ...(Number.isFinite(longLimit) && longLimit > 0
      ? [{ value: 'long_context', label: tokenLabel(longLimit) }]
      : []),
  ];
}

// A Claude model can offer long_context only (claude-opus-5 ships as "[1m]"
// alone), so "fall back to default" is no longer a safe clamp.
export function resolveContextTierValue(options = [], currentValue = '') {
  const values = (Array.isArray(options) ? options : []).map((option) => option?.value).filter(Boolean);
  const current = String(currentValue || '').trim().toLowerCase();
  if (values.includes(current)) return current;
  return values[0] || '';
}
