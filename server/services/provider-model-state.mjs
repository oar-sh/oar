'use strict';

// Which of a provider's models are on, remembered per model and forever.
//
// Before 0.9.24 the providers with a model list of their own (Claude, Cursor,
// Grok, DeepSeek, Claude API) kept an allowlist where an empty list meant
// "all on": the first save in Select Models froze the list, so a model found
// later stayed off without a word, and unticking everything, a list gone
// fully stale or a removed key turned every model back on. Now each provider
// keeps one map in `app_settings` (`<provider>_model_state`):
//
//   { v: 1, autoEnableNew, selectedAt, models: { "<id>": { on, firstSeen, lastSeen, unseen } } }
//
// A model is added the first time it is seen, on when the provider's
// "Turn new models on automatically" switch is (autoEnableNew), and flagged
// unseen for the "New" tag. Nothing is ever deleted, so a model the user
// turned off stays off when it vanishes from the list and comes back. A
// Select Models save stamps selectedAt and the lastSeen of every model it
// showed: only a model that was on and left the list after that save makes
// the "every model you turned on has left" warning. The
// default model is always on. Ids match case-insensitively; the casing of the
// first sighting is kept.
//
// Copilot keeps its rows in `model_variants`; its map (`copilot_model_state`)
// only remembers which base models are known, which variant rows were turned
// off and which models are unseen (model-variant-catalog-service.mjs).

import { buildCanonicalModelIndex, normalizeProviderModelId } from './provider-model-selection.mjs';

export const PROVIDER_MODEL_STATE_VERSION = 1;

// Setting key prefixes of the providers. Copilot is `github` everywhere else
// in the relay; its settings were always named after Copilot.
const SETTING_PREFIXES = Object.freeze({
  github: 'copilot',
  openai: 'openai',
  claude: 'claude',
  cursor: 'cursor',
  grok: 'grok',
  deepseek: 'deepseek',
  'claude-api': 'claude_api',
});

export function providerModelStateKey(provider) {
  const id = String(provider || '').trim().toLowerCase();
  const prefix = SETTING_PREFIXES[id] || id.replace(/[^a-z0-9]+/g, '_');
  return `${prefix}_model_state`;
}

function isoNow(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function uniqueIds(values) {
  return [...buildCanonicalModelIndex(Array.isArray(values) ? values : []).values()];
}

function textOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

/** A stored map, or null when there is none or it cannot be read. */
export function normalizeProviderModelState(raw) {
  const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const models = {};
  const seen = new Set();
  const source = parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models) ? parsed.models : {};
  for (const [rawId, entry] of Object.entries(source)) {
    const id = normalizeProviderModelId(rawId);
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const value = entry && typeof entry === 'object' ? entry : {};
    models[id] = {
      on: value.on === true,
      firstSeen: textOrNull(value.firstSeen),
      lastSeen: textOrNull(value.lastSeen),
      unseen: value.unseen === true,
    };
  }
  return {
    v: PROVIDER_MODEL_STATE_VERSION,
    autoEnableNew: parsed.autoEnableNew !== false,
    // Absent in maps written before it: every vanished model that was on and
    // had been seen counts then.
    selectedAt: textOrNull(parsed.selectedAt),
    models,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function cloneState(state) {
  const base = normalizeProviderModelState(state) || { v: PROVIDER_MODEL_STATE_VERSION, autoEnableNew: true, models: {} };
  return { ...base, models: Object.fromEntries(Object.entries(base.models).map(([id, entry]) => [id, { ...entry }])) };
}

/** lower-case id → the key the map holds it under. */
function keyIndex(state) {
  return new Map(Object.keys(state?.models || {}).map((id) => [id.toLowerCase(), id]));
}

function lookup(state, index, id) {
  const key = index.get(normalizeProviderModelId(id).toLowerCase());
  return key ? state.models[key] : null;
}

/**
 * The map an install had before it, built from the old allowlist so the
 * pickers show exactly what they showed: no allowlist, or one none of whose
 * ids is offered any more, means every offered model on (the old "fall back
 * to all"); otherwise the listed ones on and the rest off, and listed ids
 * that are not offered kept as on, for when they come back. New models start
 * on (autoEnableNew).
 */
export function migrateFromAllowlist({ allowlist = [], available = [], now = new Date() } = {}) {
  const stamp = isoNow(now);
  const offered = uniqueIds(available);
  const listed = uniqueIds(allowlist);
  const listedKeys = new Set(listed.map((id) => id.toLowerCase()));
  const offeredKeys = new Set(offered.map((id) => id.toLowerCase()));
  const narrowed = listed.some((id) => offeredKeys.has(id.toLowerCase()));
  const models = {};
  for (const id of offered) {
    models[id] = { on: narrowed ? listedKeys.has(id.toLowerCase()) : true, firstSeen: stamp, lastSeen: stamp, unseen: false };
  }
  // A fully stale list is dropped, as the old code ignored it; keeping its
  // ids on would read as "every model you turned on has left" (fallback).
  for (const id of narrowed ? listed : []) {
    if (offeredKeys.has(id.toLowerCase())) continue;
    models[id] = { on: true, firstSeen: stamp, lastSeen: null, unseen: false };
  }
  return { v: PROVIDER_MODEL_STATE_VERSION, autoEnableNew: true, models };
}

/**
 * A discovery's list against the map: an id never seen is added, on when
 * the switch is and flagged unseen; a known id has its lastSeen moved.
 * Nothing is deleted. `added` lists the new ids with their state; `changed`
 * is true when something the user can see changed (a model was added).
 */
export function reconcileDiscovered(state, ids = [], { now = new Date() } = {}) {
  const next = cloneState(state);
  const stamp = isoNow(now);
  const index = keyIndex(next);
  const added = [];
  for (const id of uniqueIds(ids)) {
    const known = lookup(next, index, id);
    if (known) {
      known.lastSeen = stamp;
      continue;
    }
    next.models[id] = { on: next.autoEnableNew, firstSeen: stamp, lastSeen: stamp, unseen: true };
    index.set(id.toLowerCase(), id);
    added.push({ id, on: next.autoEnableNew });
  }
  return { state: next, added, changed: added.length > 0 };
}

/**
 * The models a provider offers: the default model, then every available id
 * that is on, in the available order. An available id the map does not hold
 * yet follows the switch. Never "all": with everything off only the default
 * is left. `fallback` is set when every model the user had on has left the
 * list, so the default stands in for them (the Select Models warning).
 * `unseen` is the available ids still flagged new.
 */
export function resolveEnabled(state, availableIds = [], defaultModel = '') {
  const current = normalizeProviderModelState(state) || { autoEnableNew: true, models: {} };
  const index = keyIndex(current);
  const fallbackModel = normalizeProviderModelId(defaultModel);
  const fallbackKey = fallbackModel.toLowerCase();
  const available = uniqueIds(availableIds);
  const availableKeys = new Set(available.map((id) => id.toLowerCase()));
  const enabled = available.filter((id) => {
    if (id.toLowerCase() === fallbackKey) return false;
    const entry = lookup(current, index, id);
    return entry ? entry.on : current.autoEnableNew;
  });
  const models = uniqueIds([fallbackModel, ...enabled]);
  // A model that left before the last save (an old allowlist's stale id, one
  // gone when the user unticked everything) is no reason to warn.
  const selectedAt = current.selectedAt || '';
  const vanishedOn = Object.entries(current.models)
    .some(([id, entry]) => entry.on && id.toLowerCase() !== fallbackKey && !availableKeys.has(id.toLowerCase())
      && !!entry.lastSeen && entry.lastSeen >= selectedAt);
  const unseen = available.filter((id) => lookup(current, index, id)?.unseen === true);
  return {
    models,
    fallback: enabled.length === 0 && vanishedOn,
    unseen,
    autoEnableNew: current.autoEnableNew,
  };
}

/**
 * A save from Select Models: each shown id is on when it was ticked, else
 * off; ids that were not shown (a model that left the list, or one a refresh
 * added after the modal was drawn) keep their state. The default model is
 * always on. A save that showed models stamps selectedAt and their lastSeen
 * (they were on the list). `autoEnableNew`, when a boolean, sets the switch.
 */
export function applySelection(state, enabledIds = [], shownIds = [], { defaultModel = '', autoEnableNew, now = new Date() } = {}) {
  const next = cloneState(state);
  const stamp = isoNow(now);
  const index = keyIndex(next);
  const enabledKeys = new Set(uniqueIds(enabledIds).map((id) => id.toLowerCase()));
  const fallbackModel = normalizeProviderModelId(defaultModel);
  const shown = uniqueIds([...(fallbackModel ? [fallbackModel] : []), ...(Array.isArray(shownIds) ? shownIds : [])]);
  for (const id of shown) {
    const on = enabledKeys.has(id.toLowerCase()) || id.toLowerCase() === fallbackModel.toLowerCase();
    const known = lookup(next, index, id);
    if (known) {
      known.on = on;
      known.lastSeen = stamp;
      continue;
    }
    next.models[id] = { on, firstSeen: stamp, lastSeen: stamp, unseen: false };
    index.set(id.toLowerCase(), id);
  }
  if (shown.length) next.selectedAt = stamp;
  if (typeof autoEnableNew === 'boolean') next.autoEnableNew = autoEnableNew;
  return next;
}

/** Clears every "New" flag; `changed` tells whether one was set. */
export function markSeen(state) {
  const next = cloneState(state);
  let changed = false;
  for (const entry of Object.values(next.models)) {
    if (!entry.unseen) continue;
    entry.unseen = false;
    changed = true;
  }
  return { state: next, changed };
}

// ─── Copilot ────────────────────────────────────────────────────────────────

/** The stored Copilot map, or null. */
export function normalizeCopilotModelState(raw) {
  const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const list = (values) => [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  return {
    v: PROVIDER_MODEL_STATE_VERSION,
    autoEnableNew: parsed.autoEnableNew !== false,
    knownModels: list(parsed.knownModels),
    disabledVariants: list(parsed.disabledVariants),
    unseen: list(parsed.unseen),
  };
}

/**
 * The Copilot map an install had before it: every base model in the table is
 * known and every disabled row stays off; models first found later start on.
 */
export function migrateCopilotModelState(rows = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return normalizeCopilotModelState({
    autoEnableNew: true,
    knownModels: safeRows.map((row) => row?.baseModelId),
    disabledVariants: safeRows.filter((row) => !row?.enabled).map((row) => row?.variantId),
    unseen: [],
  });
}

/**
 * Whether a variant row seen for the first time starts on: a row the user
 * turned off before stays off; a new effort row of a known model follows the
 * model's other rows (on when one of them is on); a whole new model follows
 * the switch and is `newModel` (the caller adds it to knownModels and unseen).
 */
export function decideNewCopilotVariant(state, { variantId = '', baseModelId = '' } = {}, { siblingEnabled = false } = {}) {
  const current = normalizeCopilotModelState(state) || migrateCopilotModelState([]);
  if (current.disabledVariants.includes(String(variantId || '').trim())) return { enabled: false, newModel: false };
  if (current.knownModels.includes(String(baseModelId || '').trim())) return { enabled: siblingEnabled === true, newModel: false };
  return { enabled: current.autoEnableNew, newModel: true };
}

// ─── The store ──────────────────────────────────────────────────────────────

/**
 * The maps in a settings store (`readSetting(key)` / `writeSetting(key,
 * value, stamp)`). `legacyAllowlist` (an array or a function returning one)
 * is only read when a provider has no map yet, to build it. A store that
 * cannot write still answers from what it computed.
 */
export function createProviderModelStateStore({
  readSetting = () => '',
  writeSetting = null,
  now = () => new Date(),
} = {}) {
  function read(provider) {
    try {
      return normalizeProviderModelState(readSetting(providerModelStateKey(provider)));
    } catch {
      return null;
    }
  }

  function write(provider, state) {
    if (typeof writeSetting !== 'function') return false;
    try {
      writeSetting(providerModelStateKey(provider), JSON.stringify(state), isoNow(now));
      return true;
    } catch {
      return false;
    }
  }

  function legacyList(legacyAllowlist) {
    try {
      const value = typeof legacyAllowlist === 'function' ? legacyAllowlist() : legacyAllowlist;
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  /** The provider's map, built from its old allowlist (and saved) the first time. */
  function ensure(provider, { availableModels = [], legacyAllowlist = [] } = {}) {
    const stored = read(provider);
    if (stored) return stored;
    const migrated = migrateFromAllowlist({ allowlist: legacyList(legacyAllowlist), available: availableModels, now: now() });
    write(provider, migrated);
    return migrated;
  }

  function resolve(provider, { availableModels = [], defaultModel = '', legacyAllowlist = [] } = {}) {
    return resolveEnabled(ensure(provider, { availableModels, legacyAllowlist }), availableModels, defaultModel);
  }

  /**
   * A save: `enabledModels` (a list) sets the shown models; anything else
   * (a save of the switch alone) leaves every model as it is. Callers pass
   * the request's own shown list when it has one (the rows the browser drew)
   * and the offered list otherwise (an older page).
   */
  function select(provider, {
    enabledModels,
    shownModels = [],
    defaultModel = '',
    autoEnableNew,
    availableModels = shownModels,
    legacyAllowlist = [],
  } = {}) {
    const state = ensure(provider, { availableModels, legacyAllowlist });
    const next = Array.isArray(enabledModels)
      ? applySelection(state, enabledModels, shownModels, { defaultModel, autoEnableNew, now: now() })
      : applySelection(state, [], [], { autoEnableNew, now: now() });
    write(provider, next);
    return next;
  }

  function reconcile(provider, { availableModels = [], legacyAllowlist = [] } = {}) {
    const state = ensure(provider, { availableModels, legacyAllowlist });
    const result = reconcileDiscovered(state, availableModels, { now: now() });
    write(provider, result.state);
    return { added: result.added, changed: result.changed };
  }

  function markProviderSeen(provider) {
    const state = read(provider);
    if (!state) return false;
    const result = markSeen(state);
    if (result.changed) write(provider, result.state);
    return result.changed;
  }

  function readCopilot() {
    try {
      return normalizeCopilotModelState(readSetting(providerModelStateKey('github')));
    } catch {
      return null;
    }
  }

  function writeCopilot(state) {
    return write('github', normalizeCopilotModelState(state));
  }

  return { read, write, ensure, resolve, select, reconcile, markSeen: markProviderSeen, readCopilot, writeCopilot };
}
