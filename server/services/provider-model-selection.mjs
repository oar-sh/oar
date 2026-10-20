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

// ─── Checking a model an agent names (remote_relay create_session / send) ───

const PROVIDER_LABELS = Object.freeze({
  github: 'Copilot',
  openai: 'OpenAI',
  claude: 'Claude',
  cursor: 'Cursor',
  grok: 'Grok',
  'claude-cloud': 'Claude Cloud',
});
const CLAUDE_PROVIDERS = new Set(['claude', 'claude-cloud']);
const LONG_CONTEXT_SUFFIX = /\[1m\]$/i;
// A Copilot model with its effort, as the composer sends it ("gpt-5.4-high").
const EFFORT_VARIANT_SUFFIX = /-(none|minimal|low|medium|high|xhigh|max)$/i;
// A Claude alias ("opus", "sonnet[1m]"): one word, no version.
const CLAUDE_ALIAS = /^([a-z]+)(\[1m\])?$/i;
const SUGGESTIONS_MAX = 3;

/** How a relay calls a provider in its messages. */
export function providerModelLabel(provider) {
  return PROVIDER_LABELS[String(provider || '').trim().toLowerCase()] || String(provider || '').trim() || 'this provider';
}

/** Lower case, no tier suffix, letters and digits only: "GPT-5.4" and "gpt-5-4" meet as "gpt54". */
function looseModelKey(value) {
  return normalizeProviderModelId(value).toLowerCase().replace(LONG_CONTEXT_SUFFIX, '').replace(/[^a-z0-9]+/g, '');
}

function editDistance(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * The ids of `availableModels` closest to `requestedModel`, best first, at
 * most `max`: the same id written with other separators or casing, then ids
 * a few edits away, then ids that contain what was asked for.
 */
export function suggestProviderModelIds(requestedModel, availableModels = [], { max = SUGGESTIONS_MAX } = {}) {
  const requested = normalizeProviderModelId(requestedModel).toLowerCase().replace(LONG_CONTEXT_SUFFIX, '');
  const loose = looseModelKey(requestedModel);
  if (!requested || !loose) return [];
  const scored = [];
  for (const candidate of buildCanonicalModelIndex(availableModels).values()) {
    const plain = candidate.toLowerCase().replace(LONG_CONTEXT_SUFFIX, '');
    const candidateLoose = looseModelKey(candidate);
    let score = null;
    if (candidateLoose === loose) score = 0;
    else {
      // A few edits for a real id, none for a stub ("x" is no typo of "o3").
      const allowed = requested.length >= 4 ? Math.max(1, Math.floor(requested.length / 4)) : 0;
      const distance = allowed ? editDistance(requested, plain) : Infinity;
      if (distance <= allowed) score = 1 + distance;
      else if (loose.length >= 3 && candidateLoose.includes(loose)) score = 100 + candidateLoose.length - loose.length;
    }
    if (score !== null) scored.push({ candidate, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, Math.max(0, max))
    .map((entry) => entry.candidate);
}

const DATE_SUFFIX = /-\d{8}$/;

/** "claude-opus-4-1-20250805" → { version: [4, 1], dated: true }. */
function claudeVersionOf(model, prefix) {
  const rest = model.toLowerCase().slice(prefix.length);
  const dated = DATE_SUFFIX.test(rest);
  const version = rest.replace(DATE_SUFFIX, '').split(/[^0-9]+/).filter(Boolean).map(Number);
  return { version, dated };
}

function compareVersionsDescending(a, b) {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? -1) - (a[index] ?? -1);
    if (difference) return difference;
  }
  return 0;
}

/**
 * The newest listed Claude model of an alias's family ("opus" →
 * "claude-opus-5-5" over "claude-opus-5" and "claude-opus-4-1-20250805"):
 * by version number, a date suffix ignored, the undated id before a dated
 * one of the same version. "[1m]" ids are not the family's; with `longContext`
 * the chosen model's "[1m]" id is taken when it is listed. Returns
 * `{ model, tierDropped }`, or null for a family with no listed model.
 */
function resolveClaudeAlias(word, index, longContext) {
  const prefix = `claude-${word.toLowerCase()}-`;
  const members = (tiered) => [...index.values()]
    .filter((model) => LONG_CONTEXT_SUFFIX.test(model) === tiered && model.toLowerCase().startsWith(prefix))
    .map((model) => ({ model, ...claudeVersionOf(model.replace(LONG_CONTEXT_SUFFIX, ''), prefix) }))
    .filter((entry) => entry.version.length);
  let family = members(false);
  // A list that holds the family only as "[1m]" ids: those are its models.
  if (!family.length) {
    family = members(true);
    if (!family.length) return null;
    family.sort((a, b) => compareVersionsDescending(a.version, b.version) || Number(a.dated) - Number(b.dated) || a.model.localeCompare(b.model));
    return { model: family[0].model, tierDropped: false };
  }
  family.sort((a, b) => compareVersionsDescending(a.version, b.version) || Number(a.dated) - Number(b.dated) || a.model.localeCompare(b.model));
  const chosen = family[0].model;
  if (!longContext) return { model: chosen, tierDropped: false };
  const tiered = index.get(`${chosen}[1m]`.toLowerCase());
  return tiered ? { model: tiered, tierDropped: false } : { model: chosen, tierDropped: true };
}

/**
 * Whether a provider offers the model an agent asked for, by the list New
 * Chat offers for it. `models` is that list, or null when it is not known
 * (discovery has not run, the relay did not answer). Returns one of:
 *
 * - `{ status: 'known', model }`: offered; `model` is the provider's own
 *   casing, the same Claude model without its "[1m]" tier when only the
 *   base is listed (`tierDropped`), or "auto". A Copilot model with its
 *   effort ("gpt-5.4-high") also has `base` (the listed id) and `effort`:
 *   the bootstrap knows base ids only, so callers pass them apart. Taken so
 *   only when `effortsFor(base)` (the efforts the catalogue lists for it)
 *   holds that effort; else the id is unknown, with the base suggested.
 * - `{ status: 'alias', model, tierDropped }`: a Claude alias ("opus",
 *   "sonnet[1m]"), taken as the newest listed model of its family.
 * - `{ status: 'unchecked', model }`: no list to check against; the request
 *   goes on as asked.
 * - `{ status: 'unknown', model, suggestions, models }`: not offered.
 */
export function checkRequestedProviderModel({ requestedModel = '', provider = '', models = null, defaultModel = '', effortsFor = null } = {}) {
  const requested = normalizeProviderModelId(requestedModel);
  if (!requested || isAutoModelId(requested)) return { status: 'known', model: requested };
  if (!Array.isArray(models)) return { status: 'unchecked', model: requested };
  // "auto" is listed before discovery has run too: it makes no list.
  const list = [...buildCanonicalModelIndex([defaultModel, ...models]).values()].filter((model) => !isAutoModelId(model));
  if (!list.length) return { status: 'unchecked', model: requested };
  const index = buildCanonicalModelIndex(list);
  const exact = index.get(requested.toLowerCase());
  if (exact) return { status: 'known', model: exact };
  const claude = CLAUDE_PROVIDERS.has(String(provider || '').trim().toLowerCase());
  if (claude && LONG_CONTEXT_SUFFIX.test(requested)) {
    const base = index.get(requested.replace(LONG_CONTEXT_SUFFIX, '').toLowerCase());
    if (base) return { status: 'known', model: base, tierDropped: true };
  }
  if (claude) {
    const alias = CLAUDE_ALIAS.exec(requested);
    const resolved = alias ? resolveClaudeAlias(alias[1], index, !!alias[2]) : null;
    if (resolved) return { status: 'alias', ...resolved };
  }
  const variant = EFFORT_VARIANT_SUFFIX.exec(requested);
  const base = variant ? requested.slice(0, variant.index) : '';
  // Only Copilot takes a model with its effort in the id, and only an effort
  // the listed model is known to take: "gpt-5.1-codex-max" is a model of its
  // own, not gpt-5.1-codex at effort max.
  const listedBase = base && String(provider || '').trim().toLowerCase() === 'github' ? index.get(base.toLowerCase()) : '';
  const effort = variant ? variant[1].toLowerCase() : '';
  if (listedBase) {
    const efforts = typeof effortsFor === 'function' ? effortsFor(listedBase) : null;
    if (Array.isArray(efforts) && efforts.map((value) => String(value || '').trim().toLowerCase()).includes(effort)) {
      return { status: 'known', model: `${listedBase}-${effort}`, base: listedBase, effort };
    }
  }
  const suggestions = suggestProviderModelIds(requested, list);
  const baseFirst = listedBase ? [listedBase, ...suggestions.filter((model) => model !== listedBase)] : suggestions;
  return {
    status: 'unknown',
    model: requested,
    suggestions: (baseFirst.length || !base ? baseFirst : suggestProviderModelIds(base, list)).slice(0, SUGGESTIONS_MAX),
    models: list,
  };
}

const MODELS_LISTED_MAX = 20;

/** The refusal of an unknown model: "Unknown model 'gpt-5-4' for Copilot; did you mean 'gpt-5.4'? …". */
export function unknownProviderModelText({ model, provider, suggestions = [], models = [], where = '' } = {}) {
  const label = providerModelLabel(provider);
  const quoted = (value) => `'${value}'`;
  const parts = [`Unknown model ${quoted(model)} for ${label}${where ? ` ${where}` : ''}`];
  if (suggestions.length) parts.push(`; did you mean ${suggestions.map(quoted).join(' or ')}?`);
  else parts.push('.');
  const shown = models.slice(0, MODELS_LISTED_MAX);
  if (shown.length) {
    parts.push(` Valid ids: ${shown.join(', ')}${models.length > shown.length ? ` (and ${models.length - shown.length} more)` : ''}.`);
  }
  return parts.join('');
}
