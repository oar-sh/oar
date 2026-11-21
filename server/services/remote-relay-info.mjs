'use strict';

import {
  REMOTE_RELAY_CLOUD_PROVIDER,
  REMOTE_RELAY_EFFORT_PATTERN,
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_LIMITS,
  REMOTE_RELAY_PROVIDERS,
  remoteConversationUrl,
} from '../../shared/remote-relay-contract.mjs';
import { isOpenAIImageModelId } from '../../shared/openai-image-options.mjs';
import { OPENAI_IMAGE_PRESETS_PATH } from '../../shared/openai-image-spend.mjs';

// relay_info for remote-relay-dispatcher.mjs, and the reading of a target's
// catalogue it shares with create_session, send and the model checks: which
// providers the target has switched on, their models and the efforts those
// take. The small text helpers here are the dispatcher's too.

// The provider settings routes a relay serves; github (Copilot) has none with
// models — its catalogue is /api/models plus /api/status defaultModel.
const SETTINGS_PROVIDERS = Object.freeze(['claude', 'cursor', 'grok', 'openai', 'claude-cloud', 'deepseek', 'claude-api']);
const CLOUD_PROVIDER = REMOTE_RELAY_CLOUD_PROVIDER;
// What relay_info tells an agent about a Claude Cloud session.
const CLOUD_CREATE_NOTE = 'create_session needs repo (https://github.com/owner/repo or owner/repo) and takes branch instead of cwd. The session works on a fresh clone in a sandbox at Anthropic: write a self-contained prompt and name the branch to work on and to push.';
// How /api/models `providersByModel` names each provider.
const CATALOG_PROVIDER_LABELS = Object.freeze({
  github: 'github-copilot',
  openai: 'openai-byok',
  claude: 'claude',
  cursor: 'cursor',
  grok: 'grok',
  'claude-cloud': 'claude-cloud',
  deepseek: 'deepseek',
  'claude-api': 'claude-api',
});
const CLAUDE_LONG_CONTEXT_SUFFIX = /\[1m\]$/i;
// relay_info: efforts per provider, as groups of models that take the same ones.
const EFFORT_LEVELS_MAX = 12;
const EFFORT_GROUPS_MAX = 8;
const EFFORT_GROUP_MODELS_MAX = 40;
// relay_info's summary: what it lists of the groups and recent workspaces
// unless the call asks for everything (verbose).
const RELAY_INFO_SUMMARY_GROUPS = 15;
const RELAY_INFO_SUMMARY_WORKSPACES = 8;
const RELAY_INFO_HINT = 'Pass provider "<name>" for that provider\'s models and efforts, verbose true for the full lists.';

export function toText(value) {
  return String(value ?? '').trim();
}

export function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

export function clipLine(value, max) {
  const text = toText(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function uniqueTexts(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = toText(value);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

/** The providers /api/models lists for a model id (keys may keep their casing). */
function catalogProvidersFor(providersByModel, model) {
  if (!isPlainObject(providersByModel)) return [];
  const direct = providersByModel[model] || providersByModel[String(model).toLowerCase()];
  const list = Array.isArray(direct)
    ? direct
    : (Object.entries(providersByModel).find(([key]) => key.toLowerCase() === String(model).toLowerCase())?.[1] || []);
  return Array.isArray(list) ? list.map((entry) => toText(entry).toLowerCase()).filter(Boolean) : [];
}

/**
 * The remote's own id for `candidate` among `offered`: a case-insensitive
 * match, or the same Claude model without / with its "[1m]" long-context
 * suffix. '' when the remote does not offer it.
 */
export function matchOfferedModel(candidate, offered = []) {
  const wanted = toText(candidate).toLowerCase();
  if (!wanted) return '';
  const exact = offered.find((model) => model.toLowerCase() === wanted);
  if (exact) return exact;
  const wantedBase = wanted.replace(CLAUDE_LONG_CONTEXT_SUFFIX, '');
  return offered.find((model) => model.toLowerCase().replace(CLAUDE_LONG_CONTEXT_SUFFIX, '') === wantedBase) || '';
}

/** The models /api/models lists for a provider label ("openai-byok"). */
function catalogModelsLabelled(catalog, label) {
  const providersByModel = isPlainObject(catalog?.models?.providersByModel) ? catalog.models.providersByModel : {};
  return Object.entries(providersByModel)
    .filter(([, providers]) => Array.isArray(providers) && providers.some((entry) => toText(entry).toLowerCase() === label))
    .map(([model]) => model);
}

/**
 * Copilot's catalogue: every model of /api/models no other provider claims
 * alone, without image ids (a relay that predates their filter lists them;
 * the Copilot runtime cannot serve them).
 */
function catalogGithubModels(catalog) {
  const models = catalog?.models || {};
  const providersByModel = isPlainObject(models.providersByModel) ? models.providersByModel : {};
  const catalogModels = Array.isArray(models.models) ? models.models.map(toText).filter(Boolean) : [];
  return catalogModels.filter((model) => {
    if (isOpenAIImageModelId(model)) return false;
    const providers = catalogProvidersFor(providersByModel, model);
    return providers.length === 0 || providers.includes(CATALOG_PROVIDER_LABELS.github);
  });
}

/**
 * The models a provider's New Chat list offers on the target, which its
 * bootstrap and message routes accept, or null when the target has no list
 * for it yet (discovery has not run or failed, the route did not answer):
 * then a requested model cannot be checked here.
 */
export function offeredModelList(catalog, provider) {
  if (provider === 'github') {
    const listed = catalogGithubModels(catalog);
    return listed.length ? listed : null;
  }
  if (provider === 'openai') {
    const listed = catalogModelsLabelled(catalog, CATALOG_PROVIDER_LABELS.openai);
    return listed.length ? listed : null;
  }
  const settings = catalog?.settings?.[provider];
  const listed = Array.isArray(settings?.models) ? settings.models.map(toText).filter(Boolean) : [];
  return listed.length ? listed : null;
}

/** A reasoning effort as the relays write it, or '' when the value is not one. */
export function normalizeEffort(value) {
  const effort = toText(value).toLowerCase();
  return REMOTE_RELAY_EFFORT_PATTERN.test(effort) ? effort : '';
}

export function effortLevels(values) {
  return uniqueTexts((Array.isArray(values) ? values : []).map(normalizeEffort)).slice(0, EFFORT_LEVELS_MAX);
}

/**
 * The efforts /api/models lists for a provider's model, or null when the
 * remote does not say. `reasoningByProvider` is the provider's own view;
 * `reasoningByModel` is keyed by model id alone, which providers share, so it
 * only decides where the provider has no entry of its own.
 */
export function catalogEffortsFor(models, provider, model) {
  const key = toText(model).toLowerCase();
  if (!key || !isPlainObject(models)) return null;
  const keys = uniqueTexts([key, key.replace(CLAUDE_LONG_CONTEXT_SUFFIX, '')]);
  const maps = [
    isPlainObject(models.reasoningByProvider) ? models.reasoningByProvider[provider] : null,
    models.reasoningByModel,
  ];
  for (const map of maps) {
    if (!isPlainObject(map)) continue;
    for (const candidate of keys) {
      const levels = effortLevels(map[candidate]);
      if (levels.length) return levels;
    }
  }
  return null;
}

/** `[{ efforts, models }]`: the models of a provider grouped by the efforts they take. */
function groupEffortsByModel(models, provider, offered = []) {
  const groups = new Map();
  for (const model of offered) {
    const levels = catalogEffortsFor(models, provider, model);
    if (!levels) continue;
    const id = levels.join(' ');
    if (!groups.has(id)) groups.set(id, { efforts: levels, models: [] });
    groups.get(id).models.push(model);
  }
  return [...groups.values()]
    .sort((a, b) => b.models.length - a.models.length)
    .slice(0, EFFORT_GROUPS_MAX)
    .map((group) => (group.models.length > EFFORT_GROUP_MODELS_MAX
      ? { efforts: group.efforts, models: group.models.slice(0, EFFORT_GROUP_MODELS_MAX), more: group.models.length - EFFORT_GROUP_MODELS_MAX }
      : group));
}

/**
 * `[{ provider, configured, defaultModel, models }]` in contract order, with
 * `efforts` where the remote lists the reasoning efforts of those models.
 */
export function buildProviders(catalog) {
  return listProviders(catalog).map((entry) => {
    // A cloud session takes no effort; without this its models would be
    // listed with the Claude provider's efforts (the ids are the same).
    if (entry.provider === CLOUD_PROVIDER) return entry;
    const efforts = groupEffortsByModel(catalog.models, entry.provider, entry.models);
    return efforts.length ? { ...entry, efforts } : entry;
  });
}

export function listProviders(catalog) {
  const models = catalog.models || {};
  return REMOTE_RELAY_PROVIDERS.map((provider) => {
    if (provider === 'github') {
      const configured = catalog.copilot?.enabled !== false; // Copilot's switch; an older relay sends none: on
      const defaultModel = (configured && (toText(catalog.status.defaultModel) || toText(models.defaultModel) || toText(models.currentModel))) || null;
      return {
        provider,
        configured,
        defaultModel,
        models: configured ? uniqueTexts([...(defaultModel ? [defaultModel] : []), ...catalogGithubModels(catalog)]) : [],
        ...(toText(catalog.copilot?.engine) ? { engine: toText(catalog.copilot.engine) } : {}),
      };
    }
    const settings = catalog.settings[provider];
    if (!settings) return { provider, configured: false, defaultModel: null, models: [] };
    if (provider === CLOUD_PROVIDER) {
      // Its settings route has its own shape: a switch and a default model.
      // A relay that predates the provider answers 404 and lands above.
      const enabled = settings.enabled === true;
      const cloudDefault = toText(settings.defaultModel) || null;
      return {
        provider,
        configured: enabled,
        defaultModel: cloudDefault,
        models: enabled
          ? uniqueTexts([...(cloudDefault ? [cloudDefault] : []), ...(Array.isArray(settings.models) ? settings.models : [])])
          : [],
        ...(enabled ? { note: CLOUD_CREATE_NOTE } : {}),
      };
    }
    // What POST /api/conversation/bootstrap requires, plus "not switched off".
    const configured = settings.enabled === true
      && (provider === 'claude' || provider === 'grok' || settings.configured === true);
    const defaultModel = toText(settings.model) || null;
    const listed = provider === 'openai'
      ? catalogModelsLabelled(catalog, CATALOG_PROVIDER_LABELS.openai)
      : (Array.isArray(settings.models) ? settings.models : []);
    return {
      provider,
      configured,
      defaultModel,
      models: configured ? uniqueTexts([...(defaultModel ? [defaultModel] : []), ...listed]) : [],
    };
  });
}

/**
 * A provider entry as relay_info's summary lists it: the counts and the
 * default model's efforts instead of the lists, which `provider` or
 * `verbose` ask for.
 */
function summaryProviderEntry(catalog, entry) {
  // Only the small fields that are no lists stay (engine, note).
  const { provider, configured, defaultModel, models, efforts: _grouped, ...extra } = entry;
  const efforts = configured && provider !== CLOUD_PROVIDER && defaultModel
    ? catalogEffortsFor(catalog.models, provider, defaultModel)
    : null;
  return {
    provider,
    configured,
    defaultModel,
    modelCount: Array.isArray(models) ? models.length : 0,
    ...(efforts?.length ? { efforts } : {}),
    ...extra,
  };
}

/** relay_info's groups in the summary: the latest few and how many more there are. */
function summaryGroups(groups) {
  if (!Array.isArray(groups.groups)) return groups;
  const { groupsTotal, ...rest } = groups;
  const total = Math.max(Number(groupsTotal) || 0, groups.groups.length);
  return {
    ...rest,
    groups: groups.groups.slice(0, RELAY_INFO_SUMMARY_GROUPS),
    ...(total > RELAY_INFO_SUMMARY_GROUPS ? { moreGroups: total - RELAY_INFO_SUMMARY_GROUPS } : {}),
  };
}

/** A target's image presets as relay_info lists them: name, the values, builtIn. */
function relayImagePresets(list) {
  return list.slice(0, 40).filter(isPlainObject).map((preset) => {
    const name = toText(preset.name).slice(0, 40);
    if (!name) return null;
    const values = {};
    for (const key of ['size', 'quality', 'count', 'output_format', 'background']) {
      const value = preset[key];
      if (key === 'count' ? Number.isInteger(value) : (typeof value === 'string' && value.trim())) values[key] = key === 'count' ? value : value.trim().slice(0, 40);
    }
    return { name, ...values, builtIn: preset.builtIn === true };
  }).filter(Boolean);
}

/**
 * The parts that read the target: loadCatalog, which create_session, send and
 * the model checks use too, and relay_info itself. `relayGroups` is the
 * dispatcher's read of the target's session groups; `refuse` makes its
 * DispatchFailure.
 */
export function createRemoteRelayInfo({ call, relayGroups, refuse }) {
  async function loadCatalog(ctx) {
    const [status, models, copilot, ...settings] = await Promise.allSettled([
      call(ctx, 'GET', '/api/status'),
      call(ctx, 'GET', '/api/models'),
      call(ctx, 'GET', '/api/settings/copilot'),
      ...SETTINGS_PROVIDERS.map((provider) => call(ctx, 'GET', `/api/settings/${provider}`)),
    ]);
    if (status.status === 'rejected') throw status.reason;
    const value = (result) => (result.status === 'fulfilled' && isPlainObject(result.value) ? result.value : null);
    return {
      status: value(status) || {},
      models: value(models),
      copilot: value(copilot),
      settings: Object.fromEntries(SETTINGS_PROVIDERS.map((provider, index) => [provider, value(settings[index])])),
    };
  }

  /**
   * relay_info: a summary by default, small enough for a provider CLI that
   * cuts long tool results; `provider` lists that one provider in full and
   * `verbose` everything in full. All of it is shaped here from the
   * catalogue calls, so a paired relay of an older version answers it too.
   */
  async function relayInfo(ctx, args = {}) {
    const only = toText(args.provider).toLowerCase();
    if (only && !REMOTE_RELAY_PROVIDERS.includes(only)) {
      throw refuse(400, REMOTE_RELAY_ERROR_CODES.invalidInput,
        `provider "${clipLine(only, 40)}" is not a provider relay_info knows; pass one of: ${REMOTE_RELAY_PROVIDERS.join(', ')}, or leave it out for all of them.`,
        { providers: [...REMOTE_RELAY_PROVIDERS] });
    }
    const verbose = args.verbose === true;
    const [identity, catalog, groups, presets] = await Promise.all([
      call(ctx, 'GET', '/api/relay/identity').catch(() => null),
      loadCatalog(ctx),
      relayGroups(ctx),
      // The image presets a send or create_session may name; an OAR from
      // before them has no route, and then no list.
      call(ctx, 'GET', OPENAI_IMAGE_PRESETS_PATH).catch(() => null),
    ]);
    const imagePresets = Array.isArray(presets?.presets) ? relayImagePresets(presets.presets) : null;
    const status = catalog.status;
    const allProviders = buildProviders(catalog);
    const providers = only
      ? allProviders.filter((entry) => entry.provider === only)
      : (verbose ? allProviders : allProviders.map((entry) => summaryProviderEntry(catalog, entry)));
    const recent = Array.isArray(status.recentWorkspaceRoots) ? status.recentWorkspaceRoots.map(toText).filter(Boolean) : [];
    const remoteRelays = isPlainObject(identity?.remoteRelays) ? identity.remoteRelays : null;
    const configured = allProviders.filter((entry) => entry.configured).map((entry) => entry.provider);
    const version = toText(status.version) || toText(identity?.version) || null;
    return {
      summary: `relay_info → ${ctx.relay.name}: OAR ${version || '?'}, providers ${configured.join(', ') || 'none'}`,
      name: toText(identity?.name) || ctx.relay.name,
      ...(ctx.relay.local ? { self: true } : {}),
      url: ctx.relay.url,
      openUrl: remoteConversationUrl(ctx.relay.url, '') || null,
      version,
      platform: toText(status.platform) || toText(identity?.platform) || null,
      protocol: remoteRelays ? nonNegativeInt(remoteRelays.protocol) : 0,
      // The inbound switch is about other relays' agents; this relay's own are
      // let in by the agent-sessions setting, which is on or this would not run.
      acceptsAgentPrompts: ctx.relay.local ? true : (remoteRelays ? remoteRelays.inbound !== false : null),
      // Whether send and create_session may carry images and image there.
      imageInputs: ctx.relay.local ? true : remoteRelays?.imageInputs === true,
      ...(ctx.relay.local ? {
        sessionRules: `create_session: at most ${REMOTE_RELAY_LIMITS.localActiveSessions} sessions you started may work at the same time; a session an agent created cannot create sessions unless the owner allowed it for that session (mayCreateSessions); sessions run on this relay's accounts. update_session: sessions you started freely, any other (the owner's, another agent's, your creator's) after the owner's Allow (once per conversation).`,
      } : {}),
      providers,
      ...(verbose ? {} : { hint: RELAY_INFO_HINT }),
      workspaces: {
        default: toText(status.defaultSessionWorkspaceRootPath) || toText(status.workspaceRootPath) || null,
        current: toText(status.workspaceRootPath) || null,
        recent: verbose ? recent : recent.slice(0, RELAY_INFO_SUMMARY_WORKSPACES),
      },
      relayModes: Array.isArray(status.supportedRelayModes) ? status.supportedRelayModes : [],
      defaultRelayMode: toText(status.defaultRelayMode) || null,
      // The session groups a create_session there may name (`group`).
      ...(verbose ? groups : summaryGroups(groups)),
      ...(imagePresets ? { imagePresets } : {}),
    };
  }

  return { loadCatalog, relayInfo };
}
