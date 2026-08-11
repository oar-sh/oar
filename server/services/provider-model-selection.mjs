'use strict';

// Managed providers (OpenAI, Claude, Cursor, Grok) own their own model
// catalogs: the Copilot catalog does not know these ids, so an explicit
// selection must be resolved against the provider list alone. Resolving it
// through the shared catalog first is what let a Cursor request fall back to
// the global current model (e.g. "claude-opus-5") whenever the requested id
// was missing from that catalog.

export const AUTO_MODEL_SENTINEL = 'auto';

export function normalizeProviderModelId(value) {
  return String(value || '').trim();
}

export function isAutoModelId(value) {
  return normalizeProviderModelId(value).toLowerCase() === AUTO_MODEL_SENTINEL;
}

// Availability lists are assembled from settings and discovery, which preserve
// the provider's casing. Matching is case-insensitive, but the canonical entry
// is what gets bound and persisted so every later comparison lines up.
// Callers hold their catalogs as arrays or as Sets built for the older
// case-sensitive checks, so both are accepted.
function toModelList(availableModels) {
  if (Array.isArray(availableModels)) return availableModels;
  if (availableModels && typeof availableModels[Symbol.iterator] === 'function') return Array.from(availableModels);
  return [];
}

export function buildCanonicalModelIndex(availableModels = []) {
  const index = new Map();
  for (const value of toModelList(availableModels)) {
    const canonical = normalizeProviderModelId(value);
    if (!canonical) continue;
    const key = canonical.toLowerCase();
    if (!index.has(key)) index.set(key, canonical);
  }
  return index;
}

export function canonicalProviderModelId(requestedModel, availableModels = []) {
  const requested = normalizeProviderModelId(requestedModel);
  if (!requested) return '';
  return buildCanonicalModelIndex(availableModels).get(requested.toLowerCase()) || '';
}

export function isProviderModelAvailable(requestedModel, availableModels = []) {
  return canonicalProviderModelId(requestedModel, availableModels) !== '';
}

// Resolution outcomes:
//   matched  — the request named an available model (canonical casing returned)
//   default  — no model was requested (blank or "auto"), so the provider default applies
//   ok:false — the request named a model this provider does not offer; callers reject
export function resolveProviderModelSelection({
  requestedModel = '',
  availableModels = [],
  configuredModel = '',
} = {}) {
  const requested = normalizeProviderModelId(requestedModel);
  const configured = normalizeProviderModelId(configuredModel);
  const index = buildCanonicalModelIndex([configured, ...toModelList(availableModels)]);

  if (!requested || isAutoModelId(requested)) {
    return {
      ok: true,
      model: configured,
      requestedModel: requested,
      source: 'default',
    };
  }

  const canonical = index.get(requested.toLowerCase());
  if (canonical) {
    return {
      ok: true,
      model: canonical,
      requestedModel: requested,
      source: 'matched',
    };
  }

  return {
    ok: false,
    model: '',
    requestedModel: requested,
    source: 'unavailable',
    availableModels: Array.from(index.values()),
  };
}
