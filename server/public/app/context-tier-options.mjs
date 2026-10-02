// Mirrors shared/model-id.mjs, which the browser cannot import (only
// server/public is served).
const CLAUDE_LONG_CONTEXT_LIMIT_TOKENS = 1000000;
export const UNKNOWN_WINDOW_LABEL = '—';

// Shared by the context chip and both model pickers so a window reads the same
// everywhere: "400K", "1M", "1.05M" (the chip is 84px wide; "1050K" overflows).
export function tokenLabel(tokens) {
  const limit = Number(tokens);
  if (!Number.isFinite(limit) || limit <= 0) return UNKNOWN_WINDOW_LABEL;
  if (limit >= 1000000) {
    return `${String((limit / 1000000).toFixed(2)).replace(/\.?0+$/, '')}M`;
  }
  return `${Math.round(limit / 1000)}K`;
}

// This chip is a context-TIER selector, so the default option must show the
// default tier's own limit: the relay now caps defaultContextLimitTokens at
// the runtime's real window (haiku 144K, gpt-5.4-mini 400K), while a model
// with a long-context tier keeps a smaller default (gpt-5.6-terra: 400K
// default, 1.05M long). Labelling the default with the full window would
// render both of terra's tiers as "1.05M". The real window is only the
// fallback for metadata that carries no derived default at all.
function defaultWindowTokens(meta = {}) {
  const derived = Number(meta.defaultContextLimitTokens);
  if (Number.isFinite(derived) && derived > 0) return derived;
  const real = Number(meta.contextWindowTokens);
  return Number.isFinite(real) && real > 0 ? real : null;
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
  const defaultLabel = tokenLabel(defaultWindowTokens(meta));
  const provider = String(providerType || '').trim().toLowerCase();
  // A cloud session has no tier to choose and its window is not in the merged
  // metadata either (that number is Copilot's): one blank default, as for a
  // Claude model whose window is unknown.
  if (provider === 'claude-cloud') return [{ value: 'default', label: UNKNOWN_WINDOW_LABEL }];
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
