'use strict';

// Settings of the Claude Cloud provider (Settings → Providers → Claude Cloud).
//
// Three stored values: the switch (off by default), the default model of a
// new cloud chat, and the cloud environment its sessions run in. Everything
// else the tab shows is read, never stored: the account from the Claude CLI's
// own status, the state of its login from the credentials module (source and
// expiry, never the token), the environments from the cloud.
//
// While the provider is switched off nothing here talks to Anthropic: the
// environments are only listed once it is on.

import { isSafeClaudeModelId } from '../../shared/model-id.mjs';
import { stripModelTierSuffix } from '../../shared/claude-cloud/repo-url.mjs';
import { CLAUDE_CLOUD_PROVIDER_TYPE, isSafeClaudeCloudId } from './claude-cloud-session-service.mjs';

export const CLAUDE_CLOUD_ENABLED_SETTING_KEY = 'claude_cloud_enabled';
export const CLAUDE_CLOUD_DEFAULT_MODEL_SETTING_KEY = 'claude_cloud_default_model';
export const CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY = 'claude_cloud_environment_id';
export const DEFAULT_CLAUDE_CLOUD_MODEL = 'claude-sonnet-5-5';

const ENVIRONMENTS_CACHE_MS = 60_000;

function toText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * The cloud's model ids for a Claude catalog: the tier suffix dropped
 * ("claude-opus-5[1m]" and "claude-opus-5" are one cloud model), no
 * duplicates, the default first.
 */
export function buildClaudeCloudModelList(defaultModel, catalogModels = []) {
  const out = [];
  const seen = new Set();
  for (const candidate of [defaultModel, ...(Array.isArray(catalogModels) ? catalogModels : [])]) {
    const model = stripModelTierSuffix(candidate);
    const key = model.toLowerCase();
    if (!model || seen.has(key) || !isSafeClaudeModelId(model)) continue;
    seen.add(key);
    out.push(model);
  }
  return out;
}

/** Reads `{ enabled?, defaultModel?, environmentId? }` from a request body. */
export function parseClaudeCloudSettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const update = {};
  if (hasOwn(payload, 'enabled')) {
    if (typeof payload.enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
    update.enabled = payload.enabled;
  }
  if (hasOwn(payload, 'defaultModel')) {
    const model = stripModelTierSuffix(payload.defaultModel);
    if (!model || !isSafeClaudeModelId(model)) return { ok: false, error: 'Invalid Claude Cloud model ID' };
    update.defaultModel = model;
  }
  if (hasOwn(payload, 'environmentId')) {
    const environmentId = payload.environmentId === null ? '' : payload.environmentId;
    if (typeof environmentId !== 'string') return { ok: false, error: 'Invalid environment id' };
    const trimmed = environmentId.trim();
    if (trimmed && !isSafeClaudeCloudId(trimmed)) return { ok: false, error: 'Invalid environment id' };
    update.environmentId = trimmed;
  }
  if (!Object.keys(update).length) return { ok: false, error: 'No Claude Cloud settings update provided' };
  return { ok: true, ...update };
}

export function createClaudeCloudSettingsService({
  readSetting = () => '',
  writeSetting = null,
  deleteSetting = null,
  // The Claude provider's settings: its model catalog is the cloud's too.
  getClaudeProviderSettings = () => null,
  // `claude auth status` of the host CLI (cached there); the account line.
  claudeAuthService = null,
  // shared/claude-cloud/credentials.mjs → describe(); never the token.
  credentials = null,
  // shared/claude-cloud/api-client.mjs → listEnvironments().
  cloud = null,
  emit = () => {},
  now = () => Date.now(),
  logger = console,
} = {}) {
  let environmentsCache = null;
  let environmentsInFlight = null;

  function readEnabled() {
    return toText(readSetting(CLAUDE_CLOUD_ENABLED_SETTING_KEY)) === 'true';
  }

  function readDefaultModel() {
    const stored = stripModelTierSuffix(readSetting(CLAUDE_CLOUD_DEFAULT_MODEL_SETTING_KEY));
    return stored && isSafeClaudeModelId(stored) ? stored : DEFAULT_CLAUDE_CLOUD_MODEL;
  }

  function readEnvironmentId() {
    const stored = toText(readSetting(CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY));
    return isSafeClaudeCloudId(stored) ? stored : '';
  }

  function listModels(defaultModel) {
    const claude = getClaudeProviderSettings() || {};
    const catalog = Array.isArray(claude.models) && claude.models.length
      ? claude.models
      : (Array.isArray(claude.availableModels) ? claude.availableModels : []);
    return buildClaudeCloudModelList(defaultModel, catalog);
  }

  /** What is stored, without any I/O beyond the settings table. */
  function getSettings() {
    const defaultModel = readDefaultModel();
    return {
      enabled: readEnabled(),
      defaultModel,
      environmentId: readEnvironmentId(),
      models: listModels(defaultModel),
      providerType: CLAUDE_CLOUD_PROVIDER_TYPE,
    };
  }

  function describeToken() {
    let described = null;
    try {
      described = credentials?.describe?.() || null;
    } catch {
      described = null;
    }
    const source = ['env', 'file'].includes(described?.source) ? described.source : 'none';
    return {
      source,
      hasToken: described?.hasToken === true,
      expiresAt: toText(described?.expiresAt) || null,
      subscriptionType: toText(described?.subscriptionType) || null,
    };
  }

  async function describeAccount(token) {
    if (typeof claudeAuthService?.getStatus !== 'function') return null;
    let status = null;
    try {
      status = await claudeAuthService.getStatus();
    } catch {
      status = claudeAuthService.getCachedStatus?.() || null;
    }
    if (!status || status.ok === false) return null;
    return {
      loggedIn: status.loggedIn === true,
      email: toText(status.email) || null,
      orgName: toText(status.orgName) || null,
      subscriptionType: toText(status.subscriptionType) || token.subscriptionType || null,
    };
  }

  function redact(text) {
    const value = String(text ?? '');
    try {
      return typeof credentials?.redact === 'function' ? credentials.redact(value) : value;
    } catch {
      return 'The cloud environments could not be read.';
    }
  }

  async function loadEnvironments({ force = false } = {}) {
    if (!force && environmentsCache && (now() - environmentsCache.at) < ENVIRONMENTS_CACHE_MS) {
      return environmentsCache.value;
    }
    if (environmentsInFlight) return environmentsInFlight;
    environmentsInFlight = (async () => {
      let value;
      try {
        if (typeof cloud?.listEnvironments !== 'function') throw new Error('The cloud client is unavailable.');
        const listed = await cloud.listEnvironments();
        const environments = (Array.isArray(listed) ? listed : [])
          .filter((entry) => isSafeClaudeCloudId(entry?.id) && (!toText(entry?.state) || toText(entry.state) === 'active'))
          .map((entry) => ({ id: entry.id, name: toText(entry?.name) || entry.id }));
        value = { environments, environmentsError: null };
      } catch (error) {
        value = {
          environments: null,
          environmentsError: redact(toText(error?.message) || 'The cloud environments could not be read.').slice(0, 300),
        };
      }
      environmentsCache = { at: now(), value };
      return value;
    })().finally(() => { environmentsInFlight = null; });
    return environmentsInFlight;
  }

  /**
   * The environment new sessions run in: the stored one, else the first
   * active environment of the account, which is then stored. Empty when
   * there is none (or the cloud cannot be asked).
   */
  async function resolveEnvironmentId({ force = false } = {}) {
    const stored = readEnvironmentId();
    if (stored) return stored;
    if (!describeToken().hasToken) return '';
    const { environments } = await loadEnvironments({ force });
    const first = Array.isArray(environments) && environments.length ? environments[0].id : '';
    if (first && typeof writeSetting === 'function') {
      writeSetting(CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY, first);
      logger?.log?.(`[claude-cloud] using cloud environment ${first}`);
    }
    return first;
  }

  /** The body of GET /api/settings/claude-cloud. */
  async function describe({ refreshEnvironments = false } = {}) {
    const token = describeToken();
    const enabled = readEnabled();
    // Nothing is asked of Anthropic while the provider is off.
    const listing = enabled && token.hasToken
      ? await loadEnvironments({ force: refreshEnvironments })
      : { environments: null, environmentsError: null };
    if (enabled && token.hasToken) await resolveEnvironmentId();
    const settings = getSettings();
    return {
      enabled: settings.enabled,
      defaultModel: settings.defaultModel,
      environmentId: settings.environmentId || null,
      environments: listing.environments,
      environmentsError: listing.environmentsError,
      account: await describeAccount(token),
      token: { source: token.source, hasToken: token.hasToken, expiresAt: token.expiresAt },
      models: settings.models,
    };
  }

  /**
   * POST /api/settings/claude-cloud. Returns `{ ok: true, settings }` (the GET
   * body) or `{ ok: false, statusCode, error, code? }`.
   */
  async function update(body = {}) {
    const parsed = parseClaudeCloudSettingsUpdateRequest(body);
    if (!parsed.ok) return { ok: false, statusCode: 400, error: parsed.error };
    if (typeof writeSetting !== 'function') {
      return { ok: false, statusCode: 500, error: 'Claude Cloud settings are unavailable' };
    }
    if (parsed.enabled === true && !readEnabled() && !describeToken().hasToken) {
      return {
        ok: false,
        statusCode: 400,
        code: 'claude_cloud_login_missing',
        error: 'Claude Cloud needs the Claude CLI login on this host. Log in on Settings → Providers → Claude, then switch it on.',
      };
    }
    if (hasOwn(parsed, 'enabled')) writeSetting(CLAUDE_CLOUD_ENABLED_SETTING_KEY, parsed.enabled ? 'true' : 'false');
    if (hasOwn(parsed, 'defaultModel')) writeSetting(CLAUDE_CLOUD_DEFAULT_MODEL_SETTING_KEY, parsed.defaultModel);
    if (hasOwn(parsed, 'environmentId')) {
      if (parsed.environmentId) writeSetting(CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY, parsed.environmentId);
      else if (typeof deleteSetting === 'function') deleteSetting(CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY);
      else writeSetting(CLAUDE_CLOUD_ENVIRONMENT_SETTING_KEY, '');
    }
    // Switching it on reads the environments afresh: the account may have
    // changed since they were last listed.
    const settings = await describe({ refreshEnvironments: parsed.enabled === true });
    emit('claude_cloud_settings_updated', settings);
    return { ok: true, settings };
  }

  return { getSettings, describe, update, resolveEnvironmentId };
}
