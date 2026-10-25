'use strict';

// Settings of the DeepSeek provider (Settings → Providers → DeepSeek).
//
// One API key per relay, stored like the OpenAI and Cursor keys in the
// settings table and never sent to the browser. Next to it: the switch, the
// default model, the discovered models and the ones enabled for the
// composer, an optional base URL, and the commit attribution of DeepSeek
// chats. Discovery asks DeepSeek's `GET /models` (shared/deepseek-api.mjs);
// when it has not run or failed, the built-in list stands in.

import { createDeepSeekApiClient, normalizeDeepSeekBaseUrl } from '../../shared/deepseek-api.mjs';
import {
  DEEPSEEK_ATTRIBUTION_MODES,
  DEEPSEEK_PROVIDER_TYPE,
  DEEPSEEK_REASONING_EFFORTS,
  DEFAULT_DEEPSEEK_ATTRIBUTION,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_MODELS,
  isDeepSeekModelId,
} from '../../shared/deepseek-models.mjs';
import { DEEPSEEK_PRICE_CURRENCIES } from '../../shared/deepseek-pricing.mjs';
import { isSafeDeepSeekModelId } from '../../shared/model-id.mjs';

export const DEEPSEEK_API_KEY_SETTING_KEY = 'deepseek_api_key';
export const DEEPSEEK_ENABLED_SETTING_KEY = 'deepseek_enabled';
export const DEEPSEEK_MODEL_SETTING_KEY = 'deepseek_model';
export const DEEPSEEK_MODELS_SETTING_KEY = 'deepseek_models';
export const DEEPSEEK_ENABLED_MODELS_SETTING_KEY = 'deepseek_enabled_models';
export const DEEPSEEK_BASE_URL_SETTING_KEY = 'deepseek_base_url';
export const DEEPSEEK_ATTRIBUTION_SETTING_KEY = 'deepseek_attribution';
// The optional monthly budget for the usage card's budget bar, a positive
// amount; unset means no bar. Its currency (USD or CNY) is stored with it;
// a budget saved without one (before the currency was stored) is read in
// the balance's currency, which can change.
export const DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY = 'deepseek_monthly_budget';
export const DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY = 'deepseek_monthly_budget_currency';
const MAX_MONTHLY_BUDGET = 1_000_000_000;
// An optional starting balance for the usage card's balance bar, in the
// balance's currency: the bar measures what is left against it instead of
// the balance after the last top-up the relay has seen, or before one the
// highest balance it has read (plan-usage-deepseek.mjs). When it
// was saved is kept with it, to tell a later top-up from what came before.
export const DEEPSEEK_STARTING_BALANCE_SETTING_KEY = 'deepseek_starting_balance';
export const DEEPSEEK_STARTING_BALANCE_SET_AT_SETTING_KEY = 'deepseek_starting_balance_set_at';

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function toText(value) {
  return String(value ?? '').trim();
}

function isUsableModelId(value) {
  return isSafeDeepSeekModelId(value) && isDeepSeekModelId(value);
}

function uniqueModels(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const model = toText(value);
    const key = model.toLowerCase();
    if (!model || seen.has(key) || !isUsableModelId(model)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

/**
 * A monthly budget from a request or the store: a positive amount with at
 * most two decimals, or null for none. Undefined when unusable.
 */
function parseMonthlyBudget(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN);
  if (!Number.isFinite(number) || number < 0 || number > MAX_MONTHLY_BUDGET) return undefined;
  const rounded = Math.round(number * 100) / 100;
  return rounded > 0 ? rounded : null;
}

/**
 * The budget's currency from a request or the store: `USD` or `CNY`, or null
 * for none (the balance's currency). Undefined when unusable.
 */
function parseMonthlyBudgetCurrency(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const currency = value.trim().toUpperCase();
  if (!currency) return null;
  return DEEPSEEK_PRICE_CURRENCIES.includes(currency) ? currency : undefined;
}

/**
 * Reads `{ apiKey?, enabled?, model?, enabledModels?, baseUrl?, attribution?,
 * monthlyBudget?, monthlyBudgetCurrency?, startingBalance?,
 * startingBalanceEdited?, remove? }` from a
 * request body. The
 * key is never echoed in an error.
 */
export function parseDeepSeekSettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (payload.remove === true) return { ok: true, remove: true, enabled: false };
  const update = { remove: false };
  if (hasOwn(payload, 'apiKey')) {
    if (typeof payload.apiKey !== 'string') return { ok: false, error: 'apiKey must be a string' };
    const apiKey = payload.apiKey.trim();
    if (apiKey && !/^[\x21-\x7e]{8,512}$/.test(apiKey)) return { ok: false, error: 'The DeepSeek API key has an invalid format' };
    if (apiKey) update.apiKey = apiKey;
  }
  if (hasOwn(payload, 'enabled')) {
    if (typeof payload.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    update.enabled = payload.enabled;
  }
  if (hasOwn(payload, 'model')) {
    const model = toText(payload.model) || DEFAULT_DEEPSEEK_MODEL;
    if (!isUsableModelId(model)) return { ok: false, error: 'Invalid DeepSeek model ID' };
    update.model = model;
  }
  if (hasOwn(payload, 'enabledModels')) {
    if (!Array.isArray(payload.enabledModels)) return { ok: false, error: 'enabledModels must be a list' };
    update.enabledModels = uniqueModels(payload.enabledModels);
  }
  if (hasOwn(payload, 'baseUrl')) {
    const normalized = normalizeDeepSeekBaseUrl(payload.baseUrl === null ? '' : payload.baseUrl);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    update.baseUrl = normalized.baseUrl;
  }
  if (hasOwn(payload, 'attribution')) {
    const attribution = toText(payload.attribution).toLowerCase();
    if (!DEEPSEEK_ATTRIBUTION_MODES.includes(attribution)) return { ok: false, error: 'attribution must be "oar" or "off"' };
    update.attribution = attribution;
  }
  if (hasOwn(payload, 'monthlyBudget')) {
    const monthlyBudget = parseMonthlyBudget(payload.monthlyBudget);
    if (monthlyBudget === undefined) return { ok: false, error: 'monthlyBudget must be an amount of zero or more, or empty' };
    update.monthlyBudget = monthlyBudget;
  }
  if (hasOwn(payload, 'startingBalance')) {
    const startingBalance = parseMonthlyBudget(payload.startingBalance);
    if (startingBalance === undefined) return { ok: false, error: 'startingBalance must be an amount of zero or more, or empty' };
    update.startingBalance = startingBalance;
  }
  // The tab's field was typed in: lets a replaced starting balance be set anew.
  if (hasOwn(payload, 'startingBalanceEdited')) {
    if (typeof payload.startingBalanceEdited !== 'boolean') return { ok: false, error: 'startingBalanceEdited must be true or false' };
    if (hasOwn(update, 'startingBalance')) update.startingBalanceEdited = payload.startingBalanceEdited;
  }
  if (hasOwn(payload, 'monthlyBudgetCurrency')) {
    const monthlyBudgetCurrency = parseMonthlyBudgetCurrency(payload.monthlyBudgetCurrency);
    if (monthlyBudgetCurrency === undefined) return { ok: false, error: 'monthlyBudgetCurrency must be "USD", "CNY" or empty' };
    update.monthlyBudgetCurrency = monthlyBudgetCurrency;
  }
  if (Object.keys(update).length === 1) return { ok: false, error: 'No DeepSeek settings update provided' };
  if (update.apiKey && !hasOwn(update, 'enabled')) update.enabled = true;
  return { ok: true, ...update };
}

export function createDeepSeekSettingsService({
  readSetting = () => '',
  writeSetting = null,
  deleteSetting = null,
  // Runtime sessions with their message and queue counts
  // (stmts.listRuntimeSessionProviderCandidates); guards the key removal.
  listProviderCandidates = () => [],
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  function readList(settingKey) {
    try {
      const parsed = JSON.parse(readSetting(settingKey) || '[]');
      return Array.isArray(parsed) ? uniqueModels(parsed) : [];
    } catch {
      return [];
    }
  }

  function readModel() {
    const stored = toText(readSetting(DEEPSEEK_MODEL_SETTING_KEY));
    return stored && isUsableModelId(stored) ? stored : DEFAULT_DEEPSEEK_MODEL;
  }

  function readBaseUrl() {
    const normalized = normalizeDeepSeekBaseUrl(readSetting(DEEPSEEK_BASE_URL_SETTING_KEY));
    return normalized.ok ? normalized.baseUrl : DEFAULT_DEEPSEEK_BASE_URL;
  }

  function readAttribution() {
    const stored = toText(readSetting(DEEPSEEK_ATTRIBUTION_SETTING_KEY)).toLowerCase();
    return DEEPSEEK_ATTRIBUTION_MODES.includes(stored) ? stored : DEFAULT_DEEPSEEK_ATTRIBUTION;
  }

  function readMonthlyBudget() {
    return parseMonthlyBudget(toText(readSetting(DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY))) ?? null;
  }

  /** The budget's currency, or null: no budget, or one saved before it was stored. */
  function readMonthlyBudgetCurrency() {
    if (readMonthlyBudget() === null) return null;
    return parseMonthlyBudgetCurrency(toText(readSetting(DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY))) ?? null;
  }

  function readStartingBalance() {
    return parseMonthlyBudget(toText(readSetting(DEEPSEEK_STARTING_BALANCE_SETTING_KEY))) ?? null;
  }

  function readStartingBalanceSetAt() {
    if (readStartingBalance() === null) return null;
    const stored = toText(readSetting(DEEPSEEK_STARTING_BALANCE_SET_AT_SETTING_KEY));
    return stored && Number.isFinite(Date.parse(stored)) ? new Date(stored).toISOString() : null;
  }

  /** Everything stored, the key included: for the relay, never the browser. */
  function getSettings() {
    const apiKey = toText(readSetting(DEEPSEEK_API_KEY_SETTING_KEY));
    const enabledSetting = toText(readSetting(DEEPSEEK_ENABLED_SETTING_KEY));
    const model = readModel();
    const discovered = readList(DEEPSEEK_MODELS_SETTING_KEY);
    const availableModels = uniqueModels([model, ...(discovered.length ? discovered : DEFAULT_DEEPSEEK_MODELS)]);
    const storedEnabled = readList(DEEPSEEK_ENABLED_MODELS_SETTING_KEY)
      .filter((entry) => availableModels.some((candidate) => candidate.toLowerCase() === entry.toLowerCase()));
    // The default model always stays enabled; with no choice stored, all are.
    const models = storedEnabled.length ? uniqueModels([model, ...storedEnabled]) : availableModels;
    return {
      configured: !!apiKey,
      enabled: !!apiKey && (enabledSetting === '' || enabledSetting === 'true'),
      apiKey,
      model,
      models,
      availableModels,
      discovered: discovered.length > 0,
      baseUrl: readBaseUrl(),
      attribution: readAttribution(),
      monthlyBudget: readMonthlyBudget(),
      monthlyBudgetCurrency: readMonthlyBudgetCurrency(),
      startingBalance: readStartingBalance(),
      startingBalanceSetAt: readStartingBalanceSetAt(),
      efforts: [...DEEPSEEK_REASONING_EFFORTS],
      providerType: DEEPSEEK_PROVIDER_TYPE,
    };
  }

  /** What the settings tab and the socket get: the key only as "configured". */
  function describe() {
    const { apiKey: _apiKey, ...rest } = getSettings();
    return { ...rest, defaultBaseUrl: DEFAULT_DEEPSEEK_BASE_URL };
  }

  function countConversations() {
    const rows = (() => {
      try {
        const listed = listProviderCandidates();
        return Array.isArray(listed) ? listed : [];
      } catch {
        return [];
      }
    })().filter((row) => toText(row?.provider_type).toLowerCase() === DEEPSEEK_PROVIDER_TYPE);
    const started = rows.filter((row) => Number(row?.message_count || 0) > 0).length;
    const queued = rows.filter((row) => Number(row?.active_queue_count || 0) > 0).length;
    const active = rows.filter((row) => Number(row?.message_count || 0) > 0 || Number(row?.active_queue_count || 0) > 0).length;
    return { active, started, queued };
  }

  /**
   * Applies a parsed update. Returns `{ ok, keyChanged, discover, ... }`:
   * `keyChanged` tells the caller to stop the live workers (they hold the old
   * key), `discover` that model discovery should run. `startingBalanceReplaced`:
   * a top-up since the stored starting balance was set has replaced it (the
   * caller knows the balance): saved again with `startingBalanceEdited` (the
   * field was typed in), the same amount too, it is set anew; without the
   * flag the same amount leaves it replaced.
   */
  function update(parsed = {}, { startingBalanceReplaced = false } = {}) {
    if (typeof writeSetting !== 'function' || typeof deleteSetting !== 'function') {
      return { ok: false, error: 'DeepSeek settings are unavailable' };
    }
    const previous = getSettings();
    const stamp = now().toISOString();
    if (parsed.remove === true) {
      const counts = countConversations();
      if (counts.active > 0) {
        return {
          ok: false,
          code: 'deepseek-key-removal-blocked',
          error: `Cannot remove the DeepSeek API key while ${counts.active} DeepSeek conversation(s) still exist. Switch DeepSeek off for new conversations instead.`,
          activeConversationCount: counts.active,
          startedConversationCount: counts.started,
          activeQueueConversationCount: counts.queued,
        };
      }
      deleteSetting(DEEPSEEK_API_KEY_SETTING_KEY);
      deleteSetting(DEEPSEEK_MODELS_SETTING_KEY);
      deleteSetting(DEEPSEEK_ENABLED_MODELS_SETTING_KEY);
      writeSetting(DEEPSEEK_ENABLED_SETTING_KEY, 'false', stamp);
      return { ok: true, removed: true, keyChanged: previous.configured, discover: false, settings: describe() };
    }
    const apiKey = toText(parsed.apiKey);
    const keyChanged = !!apiKey && apiKey !== previous.apiKey;
    const hasKey = !!(apiKey || previous.apiKey);
    const nextEnabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : previous.enabled;
    if (nextEnabled && !hasKey) return { ok: false, error: 'DeepSeek API key is not configured' };
    const baseUrlChanged = hasOwn(parsed, 'baseUrl') && parsed.baseUrl !== previous.baseUrl;
    if (keyChanged) writeSetting(DEEPSEEK_API_KEY_SETTING_KEY, apiKey, stamp);
    // Another key or endpoint may serve other models: the old list goes.
    if (keyChanged || baseUrlChanged) deleteSetting(DEEPSEEK_MODELS_SETTING_KEY);
    if (hasOwn(parsed, 'baseUrl')) {
      if (parsed.baseUrl && parsed.baseUrl !== DEFAULT_DEEPSEEK_BASE_URL) {
        writeSetting(DEEPSEEK_BASE_URL_SETTING_KEY, parsed.baseUrl, stamp);
      } else {
        deleteSetting(DEEPSEEK_BASE_URL_SETTING_KEY);
      }
    }
    if (hasOwn(parsed, 'enabled') || keyChanged) writeSetting(DEEPSEEK_ENABLED_SETTING_KEY, nextEnabled ? 'true' : 'false', stamp);
    if (hasOwn(parsed, 'model')) writeSetting(DEEPSEEK_MODEL_SETTING_KEY, parsed.model, stamp);
    if (hasOwn(parsed, 'enabledModels')) {
      if (parsed.enabledModels.length) {
        writeSetting(DEEPSEEK_ENABLED_MODELS_SETTING_KEY, JSON.stringify(parsed.enabledModels), stamp);
      } else {
        deleteSetting(DEEPSEEK_ENABLED_MODELS_SETTING_KEY);
      }
    }
    if (hasOwn(parsed, 'attribution')) writeSetting(DEEPSEEK_ATTRIBUTION_SETTING_KEY, parsed.attribution, stamp);
    if (hasOwn(parsed, 'monthlyBudget')) {
      if (parsed.monthlyBudget === null) {
        // No budget, no currency to keep for it.
        deleteSetting(DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY);
        deleteSetting(DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY);
      } else {
        writeSetting(DEEPSEEK_MONTHLY_BUDGET_SETTING_KEY, String(parsed.monthlyBudget), stamp);
      }
    }
    if (hasOwn(parsed, 'monthlyBudgetCurrency') && parsed.monthlyBudget !== null) {
      if (parsed.monthlyBudgetCurrency === null) deleteSetting(DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY);
      else writeSetting(DEEPSEEK_MONTHLY_BUDGET_CURRENCY_SETTING_KEY, parsed.monthlyBudgetCurrency, stamp);
    }
    if (hasOwn(parsed, 'startingBalance')) {
      if (parsed.startingBalance === null) {
        deleteSetting(DEEPSEEK_STARTING_BALANCE_SETTING_KEY);
        deleteSetting(DEEPSEEK_STARTING_BALANCE_SET_AT_SETTING_KEY);
      } else if (
        parsed.startingBalance !== previous.startingBalance
        || !previous.startingBalanceSetAt
        || (startingBalanceReplaced && parsed.startingBalanceEdited === true)
      ) {
        // Saved again unchanged while it applies, or replaced but not typed
        // in again, it keeps its time.
        writeSetting(DEEPSEEK_STARTING_BALANCE_SETTING_KEY, String(parsed.startingBalance), stamp);
        writeSetting(DEEPSEEK_STARTING_BALANCE_SET_AT_SETTING_KEY, stamp, stamp);
      }
    }
    const current = getSettings();
    const discover = current.enabled && (keyChanged || baseUrlChanged || !previous.enabled || !current.discovered);
    return { ok: true, removed: false, keyChanged: keyChanged && previous.configured, discover, settings: describe() };
  }

  /**
   * Asks DeepSeek which models it serves and stores the DeepSeek ones. A
   * failure keeps what was stored, so the pickers never empty out.
   */
  async function refreshModels() {
    const settings = getSettings();
    if (!settings.configured) return { ok: false, models: settings.availableModels, error: 'DeepSeek API key is not configured' };
    try {
      const client = createDeepSeekApiClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, fetchImpl });
      const models = uniqueModels(await client.listModels());
      if (!models.length) {
        return { ok: false, models: settings.availableModels, error: 'DeepSeek listed no DeepSeek models' };
      }
      writeSetting?.(DEEPSEEK_MODELS_SETTING_KEY, JSON.stringify(models), now().toISOString());
      return { ok: true, models: getSettings().availableModels, error: null };
    } catch (error) {
      return { ok: false, models: settings.availableModels, error: error?.message || 'DeepSeek model discovery failed', code: error?.code || null };
    }
  }

  return { getSettings, describe, update, refreshModels };
}
