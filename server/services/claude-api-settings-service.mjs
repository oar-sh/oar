'use strict';

// Settings of the Claude API provider (Settings → Providers → Claude API):
// Claude chats that run on an API key from the Claude Console, billed to the
// Console organisation, beside the Claude provider that runs on the host's
// subscription login.
//
// One key per relay, stored like the DeepSeek and Cursor keys in the settings
// table and never sent to a browser. Next to it: the switch, the default
// model, the discovered models and the ones enabled for the composer, and an
// optional monthly spend cap. Commit attribution, the background command
// limit, the effort levels and the compaction window are the Claude tab's, so
// they are not stored here.
//
// Discovery asks Anthropic's `GET /v1/models` with the key
// (shared/anthropic-api.mjs). Until it has run, the Claude provider's model
// list stands in; a failed run keeps what was stored.

import { createAnthropicApiClient } from '../../shared/anthropic-api.mjs';
import { LONG_CONTEXT_TOKENS, resolveFallbackContextLimitTokens } from '../../shared/context-window-fallbacks.mjs';
import {
  CLAUDE_DEFAULT_CONTEXT_LIMIT_TOKENS,
  claudeBaseModelId,
  claudeLongContextModelId,
  isClaudeLongContextModelId,
  isSafeClaudeModelId,
} from '../../shared/model-id.mjs';
import { DEFAULT_CLAUDE_REASONING_EFFORTS, withClaudeUltracodeTier } from './provider-reasoning-effort.mjs';

export const CLAUDE_API_PROVIDER_TYPE = 'claude-api';
export const CLAUDE_API_PROVIDER_LABEL = 'Claude API';

export const CLAUDE_API_KEY_SETTING_KEY = 'claude_api_key';
export const CLAUDE_API_ENABLED_SETTING_KEY = 'claude_api_enabled';
export const CLAUDE_API_MODEL_SETTING_KEY = 'claude_api_model';
export const CLAUDE_API_MODELS_SETTING_KEY = 'claude_api_models';
export const CLAUDE_API_ENABLED_MODELS_SETTING_KEY = 'claude_api_enabled_models';
export const CLAUDE_API_MONTHLY_CAP_SETTING_KEY = 'claude_api_monthly_cap_usd';
// The derived default a new key replaced, kept until that key's models are
// listed: a refused key must not move the default to another model.
export const CLAUDE_API_CARRIED_MODEL_SETTING_KEY = 'claude_api_carried_model';

// The highest monthly cap the field takes: far above any sane spend, low
// enough that a typo of many digits is refused rather than stored.
export const CLAUDE_API_MONTHLY_CAP_MAX_USD = 1_000_000;

// Anthropic's credentials all start with `sk-ant-`. The field takes any
// `sk-ant-` value except the kinds below. It does not require `sk-ant-api`:
// keys from platform.claude.com can start otherwise (personal keys start with
// `sk-ant-usr-`). Whether a key works is for Anthropic to say, at the model
// discovery that runs right after the save.
const ANTHROPIC_KEY_PREFIX = 'sk-ant-';
const CONSOLE_KEY_HINT = 'Claude API needs an API key from the Claude Console (platform.claude.com → API keys); Claude login tokens and Admin keys are refused.';

// Credentials that look like keys but are not API keys. Storing claude.ai
// login or session tokens is not allowed (Anthropic's Agent SDK terms), and an
// Admin key manages an organisation instead of calling models. The prefixes
// are the ones the Claude Code 2.1.304 binary itself tells apart: its secret
// scanner (`sk-ant-(?:oat|ort)\d{2}-`, `sk-ant-admin01-`), its OAuth check
// (`startsWith("sk-ant-oat")`), its claude.ai session handling (`sk-ant-sid`,
// `sk-ant-si-`), its session-ingress tokens (`claude self-hosted-runner
// decode-token` strips "any sk-ant-cc- / sk-ant-si- prefix" from
// CLAUDE_CODE_SESSION_ACCESS_TOKEN) and its remote sessions' git credential
// (`sk-ant-ccsr-`, sent as the password of an https remote).
const REFUSED_KEY_KINDS = Object.freeze([
  Object.freeze({ prefix: 'sk-ant-oat', kind: 'oauth-access-token', what: 'a Claude OAuth access token (it signs in a Claude subscription)' }),
  Object.freeze({ prefix: 'sk-ant-ort', kind: 'oauth-refresh-token', what: 'a Claude OAuth refresh token (it signs in a Claude subscription)' }),
  Object.freeze({ prefix: 'sk-ant-admin', kind: 'admin-key', what: 'an Anthropic Admin API key (it manages an organisation and cannot run models)' }),
  Object.freeze({ prefix: 'sk-ant-sid', kind: 'session-token', what: 'a claude.ai session key' }),
  Object.freeze({ prefix: 'sk-ant-si-', kind: 'session-token', what: 'a Claude session token' }),
  Object.freeze({ prefix: 'sk-ant-cc-', kind: 'session-access-token', what: 'a Claude Code session access token' }),
  Object.freeze({ prefix: 'sk-ant-ccsr-', kind: 'remote-session-credential', what: 'a Claude Code remote session credential' }),
]);

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function toText(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return toText(value).toLowerCase();
}

/**
 * Which kind of credential a pasted value is, by its prefix alone:
 * `{ ok: true }` for a key the field takes, else `{ ok: false, kind, error }`.
 * The error names the kind and never quotes the value.
 */
export function classifyClaudeApiKey(value) {
  const key = lower(value);
  const refused = REFUSED_KEY_KINDS.find((entry) => key.startsWith(entry.prefix));
  if (refused) {
    return { ok: false, kind: refused.kind, error: `This is ${refused.what}, not an API key. ${CONSOLE_KEY_HINT}` };
  }
  // Another vendor's key (OpenAI's `sk-proj-`, DeepSeek's `sk-`) or a typo:
  // refused here rather than failing later at discovery or the first turn.
  if (!key.startsWith(ANTHROPIC_KEY_PREFIX)) {
    return { ok: false, kind: 'not-console-key', error: `This does not look like a Claude API key. ${CONSOLE_KEY_HINT}` };
  }
  return { ok: true, kind: 'api-key' };
}

/**
 * The monthly cap from a request: null (or '') means no cap, else a positive
 * number of US dollars with at most two decimals, up to
 * CLAUDE_API_MONTHLY_CAP_MAX_USD. A number or its text both work.
 */
export function parseClaudeApiMonthlyCap(value) {
  if (value === null || value === undefined) return { ok: true, capUsd: null };
  if (typeof value !== 'number' && typeof value !== 'string') {
    return { ok: false, error: 'monthlyCapUsd must be a number of US dollars, or empty for no cap' };
  }
  const text = toText(value);
  if (!text) return { ok: true, capUsd: null };
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    return { ok: false, error: 'monthlyCapUsd must be a positive amount of US dollars with at most two decimals' };
  }
  const capUsd = Number(text);
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    return { ok: false, error: 'monthlyCapUsd must be more than 0, or empty for no cap' };
  }
  if (capUsd > CLAUDE_API_MONTHLY_CAP_MAX_USD) {
    return { ok: false, error: `monthlyCapUsd must be at most ${CLAUDE_API_MONTHLY_CAP_MAX_USD} US dollars` };
  }
  return { ok: true, capUsd };
}

/** A Claude model id as the Claude provider takes it: safe, `claude-*`, `[1m]` allowed. */
function isUsableModelId(value) {
  const id = toText(value);
  return !!id && isSafeClaudeModelId(id) && /^claude-/i.test(id);
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

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

/**
 * A discovered model as stored (anthropic-api.mjs mapAnthropicModel), or a
 * bare id from an older list; null for anything unusable. `[1m]` ids are
 * never stored: they are derived on reading.
 */
function normalizeStoredModel(entry) {
  const raw = typeof entry === 'string' ? { id: entry } : (entry && typeof entry === 'object' ? entry : null);
  const id = toText(raw?.id);
  if (!isUsableModelId(id) || isClaudeLongContextModelId(id)) return null;
  return {
    id,
    displayName: toText(raw.displayName) || id,
    contextWindow: positiveIntegerOrNull(raw.contextWindow),
    maxOutput: positiveIntegerOrNull(raw.maxOutput),
    imageInput: booleanOrNull(raw.imageInput),
    effort: booleanOrNull(raw.effort),
    effortLevels: (Array.isArray(raw.effortLevels) ? raw.effortLevels : [])
      .map(lower)
      .filter((level) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(level)),
    thinking: booleanOrNull(raw.thinking),
  };
}

/**
 * Reads `{ apiKey?, enabled?, model?, enabledModels?, monthlyCapUsd?,
 * remove? }` from a request body. The key is never echoed in an error, and a
 * Claude login token or an Admin key is refused by its prefix.
 */
export function parseClaudeApiSettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (payload.remove === true) return { ok: true, remove: true, enabled: false };
  const update = { remove: false };
  if (hasOwn(payload, 'apiKey')) {
    if (typeof payload.apiKey !== 'string') return { ok: false, error: 'apiKey must be a string' };
    const apiKey = payload.apiKey.trim();
    if (apiKey && !/^[\x21-\x7e]{8,512}$/.test(apiKey)) return { ok: false, error: 'The Claude API key has an invalid format' };
    if (apiKey) {
      const kind = classifyClaudeApiKey(apiKey);
      if (!kind.ok) return { ok: false, code: `claude-api-key-${kind.kind}`, error: kind.error };
      update.apiKey = apiKey;
    }
  }
  if (hasOwn(payload, 'enabled')) {
    if (typeof payload.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    update.enabled = payload.enabled;
  }
  if (hasOwn(payload, 'model')) {
    // Empty: back to the derived default (the Claude tab's, else a Sonnet).
    const model = payload.model === null ? '' : toText(payload.model);
    if (model && !isUsableModelId(model)) return { ok: false, error: 'Invalid Claude API model ID' };
    update.model = model;
  }
  if (hasOwn(payload, 'enabledModels')) {
    if (!Array.isArray(payload.enabledModels)) return { ok: false, error: 'enabledModels must be a list' };
    update.enabledModels = uniqueModels(payload.enabledModels);
  }
  if (hasOwn(payload, 'monthlyCapUsd')) {
    const cap = parseClaudeApiMonthlyCap(payload.monthlyCapUsd);
    if (!cap.ok) return { ok: false, error: cap.error };
    update.monthlyCapUsd = cap.capUsd;
  }
  if (Object.keys(update).length === 1) return { ok: false, error: 'No Claude API settings update provided' };
  if (update.apiKey && !hasOwn(update, 'enabled')) update.enabled = true;
  return { ok: true, ...update };
}

export function createClaudeApiSettingsService({
  readSetting = () => '',
  writeSetting = null,
  deleteSetting = null,
  // Runtime sessions with their message and queue counts
  // (stmts.listRuntimeSessionProviderCandidates); guards the key removal.
  listProviderCandidates = () => [],
  // Live workers that run on the key (the worker registry's kind): a chat
  // switched back to the subscription may still have one finishing a turn.
  countLiveKeyWorkers = () => 0,
  // The Claude provider's settings (server-runtime getClaudeProviderSettings):
  // its model list stands in before the first discovery, its default model is
  // preferred, and its effort levels are this provider's.
  getClaudeProviderSettings = () => null,
  fetchImpl = globalThis.fetch,
  // Where OAR_ANTHROPIC_API_BASE_URL is read (a loopback fake API in tests).
  env = process.env,
  now = () => new Date(),
} = {}) {
  function readClaudeSettings() {
    try {
      const settings = getClaudeProviderSettings();
      return settings && typeof settings === 'object' ? settings : {};
    } catch {
      return {};
    }
  }

  function readJsonList(settingKey) {
    try {
      const parsed = JSON.parse(readSetting(settingKey) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function readDiscovered() {
    const out = [];
    const seen = new Set();
    for (const entry of readJsonList(CLAUDE_API_MODELS_SETTING_KEY)) {
      const model = normalizeStoredModel(entry);
      if (!model || seen.has(model.id.toLowerCase())) continue;
      seen.add(model.id.toLowerCase());
      out.push(model);
    }
    return out;
  }

  /**
   * The ids on offer: the discovered models, each followed by its `[1m]`
   * variant when it has a 1M window or the Claude tab lists that variant;
   * before any discovery, the Claude tab's list as it is.
   */
  function offeredModels(discovered, claudeSettings) {
    const claudeList = uniqueModels(Array.isArray(claudeSettings?.availableModels) ? claudeSettings.availableModels : []);
    if (!discovered.length) return claudeList;
    const claudeKeys = new Set(claudeList.map((id) => id.toLowerCase()));
    const ids = [];
    for (const model of discovered) {
      ids.push(model.id);
      const longId = claudeLongContextModelId(model.id);
      if ((model.contextWindow || 0) >= LONG_CONTEXT_TOKENS || claudeKeys.has(longId.toLowerCase())) ids.push(longId);
    }
    return uniqueModels(ids);
  }

  /**
   * The default carried over a key change when it is still offered, else the
   * Claude tab's default model when it is offered, else the first Sonnet,
   * else the first.
   */
  function defaultModelFor(offered, claudeSettings, carried = '') {
    const fromCarried = carried ? offered.find((id) => id.toLowerCase() === lower(carried)) : '';
    if (fromCarried) return fromCarried;
    const claudeDefault = lower(claudeSettings?.model);
    const fromClaude = claudeDefault ? offered.find((id) => id.toLowerCase() === claudeDefault) : '';
    if (fromClaude) return fromClaude;
    const bases = offered.filter((id) => !isClaudeLongContextModelId(id));
    return bases.find((id) => /sonnet/i.test(id)) || bases[0] || offered[0] || toText(claudeSettings?.model);
  }

  function readMonthlyCap() {
    const parsed = parseClaudeApiMonthlyCap(readSetting(CLAUDE_API_MONTHLY_CAP_SETTING_KEY));
    return parsed.ok ? parsed.capUsd : null;
  }

  /** Everything stored, the key included: for the relay, never the browser. */
  function getSettings() {
    const apiKey = toText(readSetting(CLAUDE_API_KEY_SETTING_KEY));
    const enabledSetting = toText(readSetting(CLAUDE_API_ENABLED_SETTING_KEY));
    const claudeSettings = readClaudeSettings();
    const discovered = readDiscovered();
    const offered = offeredModels(discovered, claudeSettings);
    const stored = toText(readSetting(CLAUDE_API_MODEL_SETTING_KEY));
    const carried = toText(readSetting(CLAUDE_API_CARRIED_MODEL_SETTING_KEY));
    const model = stored && isUsableModelId(stored) ? stored : defaultModelFor(offered, claudeSettings, carried);
    const availableModels = uniqueModels([model, ...offered]);
    const availableKeys = new Set(availableModels.map((id) => id.toLowerCase()));
    const storedEnabled = uniqueModels(readJsonList(CLAUDE_API_ENABLED_MODELS_SETTING_KEY))
      .filter((entry) => availableKeys.has(entry.toLowerCase()));
    // The default model always stays enabled; with no choice stored, all are.
    const models = storedEnabled.length ? uniqueModels([model, ...storedEnabled]) : availableModels;

    const detailsByBase = new Map(discovered.map((entry) => [entry.id.toLowerCase(), entry]));
    const claudeEfforts = claudeSettings?.effortsByModel && typeof claudeSettings.effortsByModel === 'object'
      ? claudeSettings.effortsByModel
      : {};
    const effortsByModel = {};
    const contextWindowsByModel = {};
    for (const id of availableModels) {
      const key = id.toLowerCase();
      const baseKey = claudeBaseModelId(id).toLowerCase();
      const detail = detailsByBase.get(baseKey) || null;
      // Anthropic's answer first (a model that takes no effort has only the
      // SDK default), then the Claude tab's levels for the same model, then
      // the full Claude ladder, as the Claude provider offers it.
      if (detail?.effort === false) {
        effortsByModel[key] = ['none'];
      } else if (detail?.effortLevels?.length) {
        effortsByModel[key] = withClaudeUltracodeTier(['none', ...detail.effortLevels]);
      } else {
        const fromClaude = claudeEfforts[key] || claudeEfforts[baseKey];
        effortsByModel[key] = Array.isArray(fromClaude) && fromClaude.length
          ? withClaudeUltracodeTier(fromClaude)
          : [...DEFAULT_CLAUDE_REASONING_EFFORTS];
      }
      // A `[1m]` id runs with the 1M window; its base runs with Claude Code's
      // default window, as on the Claude tab.
      if (isClaudeLongContextModelId(id)) {
        contextWindowsByModel[key] = LONG_CONTEXT_TOKENS;
      } else if (detail?.contextWindow) {
        contextWindowsByModel[key] = availableKeys.has(claudeLongContextModelId(id).toLowerCase())
          ? Math.min(detail.contextWindow, CLAUDE_DEFAULT_CONTEXT_LIMIT_TOKENS)
          : detail.contextWindow;
      } else {
        contextWindowsByModel[key] = resolveFallbackContextLimitTokens(id);
      }
    }
    const modelDetails = {};
    for (const entry of discovered) {
      modelDetails[entry.id.toLowerCase()] = {
        id: entry.id,
        displayName: entry.displayName,
        contextWindow: entry.contextWindow,
        maxOutput: entry.maxOutput,
        imageInput: entry.imageInput,
        effort: entry.effort,
        thinking: entry.thinking,
      };
    }
    return {
      configured: !!apiKey,
      enabled: !!apiKey && (enabledSetting === '' || enabledSetting === 'true'),
      apiKey,
      model,
      models,
      availableModels,
      enabledModels: models,
      discovered: discovered.length > 0,
      effortsByModel,
      contextWindowsByModel,
      modelDetails,
      monthlyCapUsd: readMonthlyCap(),
      providerType: CLAUDE_API_PROVIDER_TYPE,
      label: CLAUDE_API_PROVIDER_LABEL,
    };
  }

  /** What the settings tab and the socket get: the key only as "configured". */
  function describe() {
    const { apiKey: _apiKey, ...rest } = getSettings();
    return rest;
  }

  /** The context window of a model this provider offers, or null. */
  function contextWindowFor(model) {
    const key = lower(model);
    if (!key) return null;
    const known = getSettings().contextWindowsByModel[key];
    if (known) return known;
    return isClaudeLongContextModelId(key) ? LONG_CONTEXT_TOKENS : resolveFallbackContextLimitTokens(key);
  }

  function countConversations() {
    const rows = (() => {
      try {
        const listed = listProviderCandidates();
        return Array.isArray(listed) ? listed : [];
      } catch {
        return [];
      }
    })();
    // A chat on the key, and a chat whose unfinished rows still run on it (a
    // switch back to the subscription while one ran).
    const bound = rows.filter((row) => lower(row?.provider_type) === CLAUDE_API_PROVIDER_TYPE);
    const stamped = rows.filter((row) => lower(row?.provider_type) !== CLAUDE_API_PROVIDER_TYPE
      && Number(row?.claude_api_queue_count || 0) > 0);
    const started = bound.filter((row) => Number(row?.message_count || 0) > 0).length;
    const queued = bound.filter((row) => Number(row?.active_queue_count || 0) > 0).length + stamped.length;
    let liveWorkers = 0;
    try { liveWorkers = Math.max(0, Number(countLiveKeyWorkers()) || 0); } catch { liveWorkers = 0; }
    const active = bound.filter((row) => Number(row?.message_count || 0) > 0 || Number(row?.active_queue_count || 0) > 0).length
      + stamped.length;
    return { active, started, queued, liveWorkers };
  }

  /**
   * Applies a parsed update. Returns `{ ok, keyChanged, discover, disabled,
   * ... }`: `keyChanged` tells the caller to stop the live workers (they hold
   * the old key), `discover` that model discovery should run, `disabled`
   * that the provider went off (unstarted chats move back to the default).
   */
  function update(parsed = {}) {
    if (typeof writeSetting !== 'function' || typeof deleteSetting !== 'function') {
      return { ok: false, error: 'Claude API settings are unavailable' };
    }
    const previous = getSettings();
    const stamp = now().toISOString();
    if (parsed.remove === true) {
      const counts = countConversations();
      if (counts.active === 0 && counts.liveWorkers > 0) {
        return {
          ok: false,
          code: 'claude-api-key-removal-blocked',
          error: `Cannot remove the Claude API key while ${counts.liveWorkers} worker(s) still run on it. Try again once their turns have finished.`,
          activeConversationCount: 0,
          startedConversationCount: 0,
          activeQueueConversationCount: 0,
        };
      }
      if (counts.active > 0) {
        return {
          ok: false,
          code: 'claude-api-key-removal-blocked',
          error: `Cannot remove the Claude API key while ${counts.active} Claude API conversation(s) still exist. Switch Claude API off for new conversations instead.`,
          activeConversationCount: counts.active,
          startedConversationCount: counts.started,
          activeQueueConversationCount: counts.queued,
        };
      }
      deleteSetting(CLAUDE_API_KEY_SETTING_KEY);
      deleteSetting(CLAUDE_API_MODELS_SETTING_KEY);
      deleteSetting(CLAUDE_API_ENABLED_MODELS_SETTING_KEY);
      deleteSetting(CLAUDE_API_CARRIED_MODEL_SETTING_KEY);
      writeSetting(CLAUDE_API_ENABLED_SETTING_KEY, 'false', stamp);
      return {
        ok: true,
        removed: true,
        keyChanged: previous.configured,
        discover: false,
        disabled: previous.enabled,
        settings: describe(),
      };
    }
    const apiKey = toText(parsed.apiKey);
    const keyChanged = !!apiKey && apiKey !== previous.apiKey;
    const hasKey = !!(apiKey || previous.apiKey);
    const nextEnabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : previous.enabled;
    if (nextEnabled && !hasKey) return { ok: false, error: 'Claude API key is not configured' };
    if (keyChanged) {
      writeSetting(CLAUDE_API_KEY_SETTING_KEY, apiKey, stamp);
      // Another key may belong to another organisation with other models.
      deleteSetting(CLAUDE_API_MODELS_SETTING_KEY);
      // A default nobody picked was derived from the old key's list; until
      // the new key's list is read, the fallback list keeps it if it can.
      const stored = toText(readSetting(CLAUDE_API_MODEL_SETTING_KEY));
      if (previous.configured && !stored && !parsed.model && previous.model) {
        writeSetting(CLAUDE_API_CARRIED_MODEL_SETTING_KEY, previous.model, stamp);
      }
    }
    if (hasOwn(parsed, 'enabled') || keyChanged) writeSetting(CLAUDE_API_ENABLED_SETTING_KEY, nextEnabled ? 'true' : 'false', stamp);
    if (hasOwn(parsed, 'model')) {
      if (parsed.model) writeSetting(CLAUDE_API_MODEL_SETTING_KEY, parsed.model, stamp);
      else deleteSetting(CLAUDE_API_MODEL_SETTING_KEY);
    }
    if (hasOwn(parsed, 'enabledModels')) {
      if (parsed.enabledModels.length) {
        writeSetting(CLAUDE_API_ENABLED_MODELS_SETTING_KEY, JSON.stringify(parsed.enabledModels), stamp);
      } else {
        deleteSetting(CLAUDE_API_ENABLED_MODELS_SETTING_KEY);
      }
    }
    if (hasOwn(parsed, 'monthlyCapUsd')) {
      if (parsed.monthlyCapUsd === null) deleteSetting(CLAUDE_API_MONTHLY_CAP_SETTING_KEY);
      else writeSetting(CLAUDE_API_MONTHLY_CAP_SETTING_KEY, String(parsed.monthlyCapUsd), stamp);
    }
    const current = getSettings();
    const discover = current.enabled && (keyChanged || !previous.enabled || !current.discovered);
    return {
      ok: true,
      removed: false,
      previousModel: previous.model,
      keyChanged: keyChanged && previous.configured,
      discover,
      disabled: previous.enabled && !current.enabled,
      settings: describe(),
    };
  }

  /**
   * Asks Anthropic which models the key may use and stores the Claude ones
   * with what the answer says about them. A failure keeps what was stored, so
   * the pickers never empty out. An answer for a key that was changed or
   * removed while the request ran is dropped: that key's models are not the
   * new key's.
   */
  async function refreshModels() {
    const settings = getSettings();
    if (!settings.configured) return { ok: false, models: settings.availableModels, error: 'Claude API key is not configured' };
    const redact = (text) => String(text ?? '').split(settings.apiKey).join('[redacted]');
    try {
      const client = createAnthropicApiClient({ apiKey: settings.apiKey, env, fetchImpl });
      const listed = await client.listModels();
      const current = getSettings();
      if (current.apiKey !== settings.apiKey) {
        return {
          ok: false,
          stale: true,
          models: current.availableModels,
          error: 'The Claude API key changed while its models were being listed; that list was dropped',
          code: 'claude-api-key-changed',
        };
      }
      const models = [];
      const seen = new Set();
      for (const entry of Array.isArray(listed) ? listed : []) {
        const model = normalizeStoredModel(entry);
        if (!model || seen.has(model.id.toLowerCase())) continue;
        seen.add(model.id.toLowerCase());
        models.push(model);
      }
      if (!models.length) {
        return { ok: false, models: settings.availableModels, error: 'Anthropic listed no Claude models for this key' };
      }
      writeSetting?.(CLAUDE_API_MODELS_SETTING_KEY, JSON.stringify(models), now().toISOString());
      // The key's own list now decides the default.
      deleteSetting?.(CLAUDE_API_CARRIED_MODEL_SETTING_KEY);
      return { ok: true, models: getSettings().availableModels, error: null };
    } catch (error) {
      return {
        ok: false,
        models: settings.availableModels,
        error: redact(error?.message || 'Claude API model discovery failed'),
        code: error?.code || null,
      };
    }
  }

  return { getSettings, describe, update, refreshModels, contextWindowFor };
}
