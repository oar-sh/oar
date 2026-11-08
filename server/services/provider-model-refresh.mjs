'use strict';

// One place for "a provider's model list was refreshed".
//
// The ledger keeps when each provider was last refreshed (model_refresh_last)
// whatever asked for it: the Select Models Refresh button, a settings save, a
// login, a CLI install, the boot discovery, a Copilot snapshot or the
// background check (model-refresh-scheduler.mjs). Each refresh function is
// wrapped once with `track(provider, fn)`, so every caller resets the
// provider's clock without knowing about it. A `skipped` result (provider off,
// CLI missing) is neither a success nor a failure. The ledger also queues the
// models a refresh found for the first time, which the next `models_updated`
// carries as `newModels` (the toast).
//
// `refreshProviderModels` is the Promise.allSettled block of
// POST /api/model-variants/refresh, shared with the background check.

import {
  MODEL_REFRESH_AUTO_SETTING_KEY,
  MODEL_REFRESH_EXCLUDED_SETTING_KEY,
  MODEL_REFRESH_INTERVAL_HOURS_SETTING_KEY,
  MODEL_REFRESH_LAST_SETTING_KEY,
  MODEL_REFRESH_PROVIDERS,
  modelRefreshProvider,
  parseModelRefreshAutoUpdate,
  parseModelRefreshExcludedUpdate,
  parseModelRefreshIntervalHoursUpdate,
  readModelRefreshAutoSetting,
  readModelRefreshExcludedSetting,
  readModelRefreshIntervalHoursSetting,
  readModelRefreshLastSetting,
} from '../../shared/model-refresh-schedule.mjs';

const SKIPPED = Object.freeze({ ok: true, skipped: true, models: [], error: null });
// What a failed refresh keeps of its error text.
export const MODEL_REFRESH_ERROR_MAX_CHARS = 240;
const REDACTED = '[redacted]';

/**
 * A refresh error without the provider's secrets: each one given is cut out
 * wherever it appears, and so is whatever follows "Bearer" or an
 * Authorization header an answer echoed back. Then capped.
 */
export function redactModelRefreshError(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    const value = String(secret ?? '').trim();
    if (value.length >= 4) out = out.split(value).join(REDACTED);
  }
  out = out
    .replace(/\b(authorization\s*["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',;}]+/gi, `$1${REDACTED}`)
    .replace(/\bbearer\s+(?!\[redacted\])[^\s"',;}]+/gi, `Bearer ${REDACTED}`)
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > MODEL_REFRESH_ERROR_MAX_CHARS ? `${out.slice(0, MODEL_REFRESH_ERROR_MAX_CHARS - 1)}…` : out;
}

/**
 * A failed refresh in a log line: its HTTP status, a timeout, or the words
 * before the first colon, never the answer's body.
 */
export function modelRefreshErrorSummary(text) {
  const value = String(text ?? '');
  const status = value.match(/\((\d{3})\)/) || value.match(/\b(?:status|HTTP)\s*:?\s*(\d{3})\b/i);
  if (status) return `HTTP ${status[1]}`;
  if (/timed out|timeout/i.test(value)) return 'timed out';
  const head = value.split(':')[0].replace(/\s+/g, ' ').trim();
  return (head || 'unknown error').slice(0, 80);
}

function isoOf(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export function createModelRefreshLedger({
  readSetting = () => '',
  writeSetting = null,
  now = () => new Date(),
  // (provider) => the secrets its errors may carry (API keys, tokens): cut
  // out before an error is stored, answered by the settings route or logged.
  secretsFor = () => [],
} = {}) {
  let pendingNewModels = [];

  function readLast() {
    try {
      return readModelRefreshLastSetting(readSetting(MODEL_REFRESH_LAST_SETTING_KEY));
    } catch {
      return {};
    }
  }

  /** New models of one provider for the next models_updated; one entry per provider and state. */
  function noteNewModels(provider, added = []) {
    const meta = modelRefreshProvider(provider);
    if (!meta) return;
    for (const { id, on } of Array.isArray(added) ? added : []) {
      const modelId = String(id || '').trim();
      if (!modelId) continue;
      let entry = pendingNewModels.find((candidate) => candidate.provider === meta.id && candidate.on === (on === true));
      if (!entry) {
        entry = { provider: meta.id, tab: meta.tab, label: meta.label, ids: [], on: on === true };
        pendingNewModels.push(entry);
      }
      if (!entry.ids.includes(modelId)) entry.ids.push(modelId);
    }
  }

  /** The queued new models, emptied. */
  function takeNewModels() {
    const taken = pendingNewModels;
    pendingNewModels = [];
    return taken;
  }

  function secretsOf(provider) {
    try {
      const secrets = secretsFor(provider);
      return Array.isArray(secrets) ? secrets : [];
    } catch {
      return [];
    }
  }

  /** Notes one refresh result; returns the provider's entry, or null when skipped. */
  function record(provider, result) {
    const meta = modelRefreshProvider(provider);
    if (!meta || !result || typeof result !== 'object' || result.skipped === true) return null;
    const stamp = isoOf(now());
    const ok = result.ok === true;
    const last = readLast();
    const previous = last[meta.id] || {};
    last[meta.id] = {
      at: stamp,
      ok,
      error: ok ? null : (redactModelRefreshError(result.error || 'Model refresh failed', secretsOf(meta.id)) || 'Model refresh failed'),
      lastOkAt: ok ? stamp : (previous.lastOkAt || null),
      lastFailureAt: ok ? (previous.lastFailureAt || null) : stamp,
    };
    try {
      writeSetting?.(MODEL_REFRESH_LAST_SETTING_KEY, JSON.stringify(last), stamp);
    } catch {
      /* the clock is best-effort; the next refresh writes it again */
    }
    if (ok) noteNewModels(meta.id, result.newModels);
    return last[meta.id];
  }

  /** `fn` with every call noted against `provider`; a throw counts as a failure. */
  function track(provider, fn) {
    if (typeof fn !== 'function') return fn;
    return async (...args) => {
      let result;
      try {
        result = await fn(...args);
      } catch (error) {
        record(provider, { ok: false, error: error?.message || String(error || 'Model refresh failed') });
        throw error;
      }
      record(provider, result);
      return result;
    };
  }

  return { readLast, record, track, noteNewModels, takeNewModels };
}

/** The check's own settings: `{ auto, intervalHours, excluded }`. */
export function createModelRefreshSettings({
  readSetting = () => '',
  writeSetting = null,
  now = () => new Date(),
} = {}) {
  function get() {
    return {
      auto: readModelRefreshAutoSetting(readSetting(MODEL_REFRESH_AUTO_SETTING_KEY)),
      intervalHours: readModelRefreshIntervalHoursSetting(readSetting(MODEL_REFRESH_INTERVAL_HOURS_SETTING_KEY)),
      excluded: readModelRefreshExcludedSetting(readSetting(MODEL_REFRESH_EXCLUDED_SETTING_KEY)),
    };
  }

  /** Checks every field given before writing any; `{ ok, settings }` or `{ ok: false, error }`. */
  function update(body = {}) {
    const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);
    if (!has('auto') && !has('intervalHours') && !has('excluded')) return { ok: false, error: 'No model refresh settings update provided' };
    const auto = has('auto') ? parseModelRefreshAutoUpdate(payload.auto) : null;
    const interval = has('intervalHours') ? parseModelRefreshIntervalHoursUpdate(payload.intervalHours) : null;
    const excluded = has('excluded') ? parseModelRefreshExcludedUpdate(payload.excluded) : null;
    const refused = [auto, interval, excluded].find((parsed) => parsed && !parsed.ok);
    if (refused) return { ok: false, error: refused.error };
    if (typeof writeSetting !== 'function') return { ok: false, error: 'Model refresh settings are unavailable' };
    const stamp = isoOf(now());
    if (auto) writeSetting(MODEL_REFRESH_AUTO_SETTING_KEY, auto.auto ? 'true' : 'false', stamp);
    if (interval) writeSetting(MODEL_REFRESH_INTERVAL_HOURS_SETTING_KEY, String(interval.intervalHours), stamp);
    if (excluded) writeSetting(MODEL_REFRESH_EXCLUDED_SETTING_KEY, JSON.stringify(excluded.excluded), stamp);
    return { ok: true, settings: get() };
  }

  return { get, update };
}

/**
 * The providers the refresh can ask, from the route deps: `isEnabled` gates
 * the Refresh button (a provider that is off is skipped), `isSetUp` the
 * background check (Copilot: an installed CLI; Claude and Grok: their CLI
 * or their login; the others: switched on, which needs their key),
 * `currentModels` is what a failed refresh answers with.
 */
export function buildProviderRefreshTable({
  getOpenAIProviderSettings = () => null,
  refreshOpenAIProviderModels = null,
  getClaudeProviderSettings = () => null,
  refreshClaudeProviderModels = null,
  getCursorProviderSettings = () => null,
  refreshCursorProviderModels = null,
  getGrokProviderSettings = () => null,
  refreshGrokProviderModels = null,
  deepseekSettingsService = null,
  claudeApiSettingsService = null,
  copilotModelDiscoveryService = null,
  // Claude and Grok run on the host's CLI and its login: set up when the CLI
  // is installed or the login is there, as the relay knows it without
  // spawning anything. Absent (most tests): enabled is enough.
  isClaudeSetUp = () => true,
  isGrokSetUp = () => true,
} = {}) {
  const enabledOf = (getSettings) => () => {
    try {
      return getSettings?.()?.enabled === true;
    } catch {
      return false;
    }
  };
  const modelsOf = (getSettings) => () => {
    try {
      const models = getSettings?.()?.models;
      return Array.isArray(models) ? models : [];
    } catch {
      return [];
    }
  };
  const entry = (getSettings, refresh, setUp = () => true) => ({
    isEnabled: enabledOf(getSettings),
    isSetUp: () => {
      if (!enabledOf(getSettings)()) return false;
      try {
        return setUp() === true;
      } catch {
        return false;
      }
    },
    currentModels: modelsOf(getSettings),
    refresh: typeof refresh === 'function' ? () => refresh() : null,
  });
  const deepseekSettings = () => deepseekSettingsService?.getSettings?.() || null;
  const claudeApiSettings = () => claudeApiSettingsService?.getSettings?.() || null;
  const hasCopilotDiscovery = typeof copilotModelDiscoveryService?.refresh === 'function';
  return {
    // Copilot discovery gates itself on an installed CLI (skipped when there
    // is none), so the Refresh button always asks it.
    github: {
      isEnabled: () => hasCopilotDiscovery,
      isSetUp: () => {
        if (!hasCopilotDiscovery) return false;
        try {
          return typeof copilotModelDiscoveryService.isCliResolvable === 'function'
            ? copilotModelDiscoveryService.isCliResolvable() === true
            : true;
        } catch {
          return false;
        }
      },
      currentModels: () => [],
      refresh: hasCopilotDiscovery ? (reason) => copilotModelDiscoveryService.refresh(reason) : null,
    },
    openai: entry(getOpenAIProviderSettings, refreshOpenAIProviderModels),
    claude: entry(getClaudeProviderSettings, refreshClaudeProviderModels, isClaudeSetUp),
    'claude-api': entry(claudeApiSettings, claudeApiSettingsService?.refreshModels),
    cursor: entry(getCursorProviderSettings, refreshCursorProviderModels),
    grok: entry(getGrokProviderSettings, refreshGrokProviderModels, isGrokSetUp),
    deepseek: entry(deepseekSettings, deepseekSettingsService?.refreshModels),
  };
}

/**
 * Refreshes the given providers (all by default) side by side. Returns
 * `{ results: { <provider>: result }, changed }`: a provider that is off or
 * has no refresh is skipped; a refresh that throws answers ok:false with the
 * provider's current models. `changed` tells whether any provider's offered
 * models changed or a refresh found models it had not seen before.
 */
export async function refreshProviderModels({
  table = {},
  providers = MODEL_REFRESH_PROVIDERS.map((provider) => provider.id),
  reason = 'manual-refresh',
  gate = 'isEnabled',
} = {}) {
  const ids = providers.filter((id) => table[id]);
  const before = new Map(ids.map((id) => [id, JSON.stringify(table[id].currentModels?.() || [])]));
  const settled = await Promise.allSettled(ids.map((id) => {
    const entry = table[id];
    const open = typeof entry?.[gate] === 'function' ? entry[gate]() : false;
    if (!open || typeof entry.refresh !== 'function') return Promise.resolve({ ...SKIPPED });
    return Promise.resolve().then(() => entry.refresh(reason));
  }));
  const results = {};
  let changed = false;
  ids.forEach((id, index) => {
    const outcome = settled[index];
    const label = modelRefreshProvider(id)?.label || id;
    const result = outcome.status === 'fulfilled' && outcome.value && typeof outcome.value === 'object'
      ? outcome.value
      : {
          ok: false,
          models: table[id].currentModels?.() || [],
          error: outcome.reason?.message || `${label} model discovery failed`,
        };
    results[id] = result;
    if (result.skipped === true) return;
    if (Array.isArray(result.newModels) && result.newModels.length) changed = true;
    if (JSON.stringify(table[id].currentModels?.() || []) !== before.get(id)) changed = true;
  });
  return { results, changed };
}
