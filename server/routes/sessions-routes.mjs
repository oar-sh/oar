'use strict';
import { buildPinList } from '../services/message-pin-list.mjs';
import { buildHiddenMessageList } from '../services/hidden-message-list.mjs';
import {
  DEFAULT_CLAUDE_REASONING_EFFORTS,
  withClaudeUltracodeTier,
} from '../services/provider-reasoning-effort.mjs';
import { mapUsageSnapshotRow } from '../services/usage-snapshot-helpers.mjs';
import { cleanupGeneratedImagesForConversation as cleanupGeneratedImagesForConversationDefault } from '../services/generated-image-cleanup-service.mjs';
import { isWorkerOnOtherBuild } from '../services/worker-recycle-service.mjs';
import {
  CLAUDE_API_PROVIDER_TYPE,
} from '../services/claude-api-settings-service.mjs';
import {
  DEEPSEEK_PROVIDER_TYPE,
  DEEPSEEK_REASONING_EFFORTS,
  DEFAULT_DEEPSEEK_MODEL,
} from '../../shared/deepseek-models.mjs';
import { createFixedWindowRateLimiter } from '../services/rate-limit-service.mjs';
import { createShareRepository } from '../repositories/share-repository.mjs';
import { copilotEnabledFromStmts } from '../services/copilot-settings-service.mjs';
import {
  CLAUDE_DEFAULT_CONTEXT_LIMIT_TOKENS,
  CLAUDE_LONG_CONTEXT_LIMIT_TOKENS,
  CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN,
} from '../../shared/model-id.mjs';
import { openAIReasoningEffortsForModel } from '../../shared/openai-reasoning.mjs';
import { isOpenAIImageModelId } from '../../shared/openai-image-options.mjs';
import {
  DEFAULT_SHARE_PATH_PRIVACY_MODE,
} from '../../shared/share-path-privacy.mjs';
import {
  DEFAULT_TASK_STALL_MINUTES,
} from '../../shared/task-output-text.mjs';
import { buildProviderRefreshTable } from '../services/provider-model-refresh.mjs';
import {
  SESSION_WORKER_ACTIVE_STATUSES,
  createConversationGroupHelpers,
  isPidAlive,
  resolveConversationTitle,
  stopIdleWorkspaceRootSession,
} from './sessions-helpers.mjs';
import { registerShareRoutes } from './share-routes.mjs';
import { registerProviderAuthRoutes } from './provider-auth-routes.mjs';
import { registerSettingsRoutes } from './settings-routes.mjs';
import { registerConversationSettingsRoutes } from './conversation-settings-routes.mjs';
import { registerConversationLifecycleRoutes } from './conversation-lifecycle-routes.mjs';
import { createFailQueueMessageFromDeps } from './messages-queue-failure.mjs';
import { registerConversationBootstrapRoutes } from './conversation-bootstrap-routes.mjs';
import { registerModelRoutes } from './model-routes.mjs';
import { registerHostRoutes } from './host-routes.mjs';
import { registerConversationReadRoutes } from './conversation-read-routes.mjs';

const SESSION_WORKER_STATUS_QUEUE_STATES = Object.freeze(['pending', 'processing', 'parked']);
function normalizeWorkerStatusText(value, fallback = null) {
  const text = String(value || '').trim();
  return text || fallback;
}

function toSafeNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

/**
 * The lower-cased ids Copilot itself lists in `modelState`: those an earlier
 * provider layer did not add. A layer tags every id it adds, so an id with
 * tags but none of them Copilot's is another provider's ("claude-opus-5-5"
 * from the Claude layer), not one Copilot serves too.
 */
function copilotListedModelIds(modelState = {}) {
  const providersByModel = modelState?.providersByModel && typeof modelState.providersByModel === 'object'
    ? modelState.providersByModel
    : {};
  return new Set(
    (Array.isArray(modelState?.models) ? modelState.models : [])
      .filter((value) => {
        const id = String(value || '').trim();
        const providers = providersByModel[id] || providersByModel[id.toLowerCase()];
        return !Array.isArray(providers) || providers.length === 0
          || providers.some((provider) => String(provider || '').trim().toLowerCase() === 'github-copilot');
      })
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value && value.toLowerCase() !== 'auto'),
  );
}

/**
 * A Copilot catalog without its image ids (gpt-image-*, dall-e-*): the
 * Copilot runtime cannot serve them, so neither New Chat, the composer nor
 * relay_info offers them for Copilot. The OpenAI layer adds back the ones
 * the OpenAI provider lists, as that provider's alone.
 */
export function withoutCopilotImageModels(modelState = {}) {
  const models = Array.isArray(modelState?.models) ? modelState.models : [];
  if (!models.some((modelId) => isOpenAIImageModelId(modelId))) return modelState;
  const kept = models.filter((modelId) => !isOpenAIImageModelId(modelId));
  const withoutImageKeys = (map) => (map && typeof map === 'object' && !Array.isArray(map)
    ? Object.fromEntries(Object.entries(map).filter(([modelId]) => !isOpenAIImageModelId(modelId)))
    : map);
  const listedOr = (modelId) => (isOpenAIImageModelId(modelId) ? (kept[0] || '') : modelId);
  return {
    ...modelState,
    models: kept,
    ...(modelState.currentModel !== undefined ? { currentModel: listedOr(modelState.currentModel) } : {}),
    ...(modelState.defaultModel !== undefined ? { defaultModel: listedOr(modelState.defaultModel) } : {}),
    ...(modelState.reasoningByModel ? { reasoningByModel: withoutImageKeys(modelState.reasoningByModel) } : {}),
    ...(modelState.contextLimitsByModel ? { contextLimitsByModel: withoutImageKeys(modelState.contextLimitsByModel) } : {}),
    ...(modelState.modelMetadataByModel ? { modelMetadataByModel: withoutImageKeys(modelState.modelMetadataByModel) } : {}),
    ...(modelState.providersByModel ? { providersByModel: withoutImageKeys(modelState.providersByModel) } : {}),
    ...(Array.isArray(modelState.unavailableModels)
      ? { unavailableModels: modelState.unavailableModels.filter((modelId) => !isOpenAIImageModelId(modelId)) }
      : {}),
  };
}

/**
 * The base catalog while Copilot is switched off: its fields kept, Copilot's
 * models gone, so only the other providers' models are layered on.
 */
export function withoutCopilotModels(modelState = {}) {
  return {
    ...modelState,
    models: [],
    ...(modelState.currentModel !== undefined ? { currentModel: '' } : {}),
    ...(modelState.defaultModel !== undefined ? { defaultModel: '' } : {}),
    reasoningByModel: {},
    ...(modelState.contextLimitsByModel ? { contextLimitsByModel: {} } : {}),
    modelMetadataByModel: {},
    providersByModel: {},
    ...(Array.isArray(modelState.unavailableModels) ? { unavailableModels: [] } : {}),
  };
}

export function buildModelCatalogWithClaudeProvider(modelState = {}, claudeSettings = {}) {
  const configured = claudeSettings?.enabled === true;
  const model = String(claudeSettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const baseModels = copilotListedModelIds(modelState);
  const claudeModels = Array.isArray(claudeSettings?.models)
    ? claudeSettings.models.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  // "[1m]" long-context variants are not separate composer entries: fold each
  // one into its base model as a long_context tier that the context-size
  // dropdown offers, mirroring how the Copilot catalog models long context.
  const longContextBases = new Set();
  const defaultContextBases = new Set();
  const claudeBaseModels = [];
  const seenClaudeBases = new Set();
  for (const claudeModelId of [model, ...claudeModels]) {
    const isLongContextVariant = CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN.test(claudeModelId);
    const baseId = claudeModelId.replace(CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN, '');
    if (!baseId) continue;
    if (isLongContextVariant) longContextBases.add(baseId.toLowerCase());
    else defaultContextBases.add(baseId.toLowerCase());
    if (seenClaudeBases.has(baseId.toLowerCase())) continue;
    seenClaudeBases.add(baseId.toLowerCase());
    claudeBaseModels.push(baseId);
  }
  const models = Array.from(new Set([...(Array.isArray(modelState?.models) ? modelState.models : []), ...claudeBaseModels]));
  const reasoningByModel = { ...(modelState?.reasoningByModel || {}) };
  const claudeReasoningByModel = {};
  const effortsByModel = claudeSettings?.effortsByModel && typeof claudeSettings.effortsByModel === 'object'
    ? claudeSettings.effortsByModel
    : {};
  const defaultClaudeEfforts = [...DEFAULT_CLAUDE_REASONING_EFFORTS];
  const modelMetadataByModel = { ...(modelState?.modelMetadataByModel || {}) };
  const providersByModel = { ...(modelState?.providersByModel || {}) };
  // modelMetadataByModel is keyed by model id alone, so a model served by both
  // Copilot and the Claude SDK cannot describe two different sets of context
  // windows there. The tiers the SDK actually offers are exactly the enabled
  // catalog ids, so they get their own provider-scoped map.
  const claudeContextTiersByModel = {};
  for (const claudeModel of claudeBaseModels) {
    const providersKey = String(claudeModel || '').trim();
    if (!providersKey) continue;
    const lowerKey = providersKey.toLowerCase();
    claudeContextTiersByModel[lowerKey] = [
      ...(defaultContextBases.has(lowerKey) ? [{ value: 'default' }] : []),
      ...(longContextBases.has(lowerKey) ? [{ value: 'long_context' }] : []),
    ];
    const effortsForModel = Array.isArray(effortsByModel[lowerKey]) && effortsByModel[lowerKey].length
      ? effortsByModel[lowerKey]
      : effortsByModel[`${lowerKey}[1m]`];
    // Idempotent augmentation: getClaudeProviderSettings already derives the
    // ultracode tier, but this function is also fed raw effort maps.
    const claudeEfforts = Array.isArray(effortsForModel) && effortsForModel.length
      ? withClaudeUltracodeTier(effortsForModel)
      : defaultClaudeEfforts;
    claudeReasoningByModel[lowerKey] = [...claudeEfforts];
    if (!Array.isArray(reasoningByModel[lowerKey]) || reasoningByModel[lowerKey].length === 0) {
      reasoningByModel[lowerKey] = [...claudeEfforts];
    }
    const existingProviders = Array.isArray(providersByModel[providersKey])
      ? providersByModel[providersKey]
      : (Array.isArray(providersByModel[lowerKey])
          ? providersByModel[lowerKey]
          : (modelMetadataByModel[providersKey]?.provider ? [modelMetadataByModel[providersKey].provider] : []));
    providersByModel[providersKey] = Array.from(new Set([
      ...existingProviders,
      ...(baseModels.has(lowerKey) ? ['github-copilot'] : []),
      'claude',
    ]));
    modelMetadataByModel[providersKey] = {
      ...(modelMetadataByModel[providersKey] || {}),
      provider: modelMetadataByModel[providersKey]?.provider || (baseModels.has(lowerKey) ? 'github-copilot' : 'claude'),
    };
    if (longContextBases.has(lowerKey)) {
      modelMetadataByModel[providersKey] = {
        ...modelMetadataByModel[providersKey],
        defaultContextLimitTokens: modelMetadataByModel[providersKey]?.defaultContextLimitTokens
          || CLAUDE_DEFAULT_CONTEXT_LIMIT_TOKENS,
        longContextLimitTokens: CLAUDE_LONG_CONTEXT_LIMIT_TOKENS,
      };
    }
  }
  return {
    ...modelState,
    models,
    reasoningByModel,
    reasoningByProvider: {
      ...(modelState?.reasoningByProvider || {}),
      claude: claudeReasoningByModel,
    },
    modelMetadataByModel,
    providersByModel,
    claudeContextTiersByModel,
  };
}

export function buildModelCatalogWithOpenAIProvider(modelState = {}, openAISettings = {}) {
  const configured = openAISettings?.enabled === true;
  const model = String(openAISettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const baseModels = copilotListedModelIds(modelState);
  const openAIModels = Array.isArray(openAISettings?.models)
    ? openAISettings.models.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const models = Array.from(new Set([model, ...openAIModels, ...(Array.isArray(modelState?.models) ? modelState.models : [])]));
  const reasoningByModel = { ...(modelState?.reasoningByModel || {}) };
  const openAIReasoningByModel = {};
  const modelMetadataByModel = { ...(modelState?.modelMetadataByModel || {}) };
  const providersByModel = { ...(modelState?.providersByModel || {}) };
  for (const openAIModel of [model, ...openAIModels]) {
    const providersKey = String(openAIModel || '').trim();
    const lowerKey = providersKey.toLowerCase();
    const reasoningKey = openAIModel.toLowerCase();
    openAIReasoningByModel[reasoningKey] = openAIReasoningEffortsForModel(openAIModel);
    if (!Array.isArray(reasoningByModel[reasoningKey]) || reasoningByModel[reasoningKey].length === 0) {
      reasoningByModel[reasoningKey] = ['none'];
    }
    const existingProviders = Array.isArray(providersByModel[providersKey])
      ? providersByModel[providersKey]
      : (Array.isArray(providersByModel[lowerKey])
          ? providersByModel[lowerKey]
          : (modelMetadataByModel[providersKey]?.provider ? [modelMetadataByModel[providersKey].provider] : []));
    providersByModel[providersKey] = Array.from(new Set([
      ...existingProviders,
      ...(baseModels.has(lowerKey) ? ['github-copilot'] : []),
      'openai-byok',
    ]));
    modelMetadataByModel[providersKey] = {
      ...(modelMetadataByModel[providersKey] || {}),
      provider: modelMetadataByModel[providersKey]?.provider || (baseModels.has(lowerKey) ? 'github-copilot' : 'openai-byok'),
    };
  }
  return {
    ...modelState,
    models,
    reasoningByModel,
    reasoningByProvider: {
      ...(modelState?.reasoningByProvider || {}),
      github: { ...(modelState?.reasoningByModel || {}) },
      openai: openAIReasoningByModel,
    },
    modelMetadataByModel,
    providersByModel,
  };
}

export function buildModelCatalogWithCursorProvider(modelState = {}, cursorSettings = {}) {
  const configured = cursorSettings?.enabled === true;
  const model = String(cursorSettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const baseModels = copilotListedModelIds(modelState);
  const cursorModelList = Array.isArray(cursorSettings?.models)
    ? cursorSettings.models.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const cursorModels = [];
  const seenCursorModels = new Set();
  for (const cursorModelId of [model, ...cursorModelList]) {
    const lowerId = cursorModelId.toLowerCase();
    if (seenCursorModels.has(lowerId)) continue;
    seenCursorModels.add(lowerId);
    cursorModels.push(cursorModelId);
  }
  const models = Array.from(new Set([...(Array.isArray(modelState?.models) ? modelState.models : []), ...cursorModels]));
  const reasoningByModel = { ...(modelState?.reasoningByModel || {}) };
  const cursorReasoningByModel = {};
  const modelMetadataByModel = { ...(modelState?.modelMetadataByModel || {}) };
  const providersByModel = { ...(modelState?.providersByModel || {}) };
  const cursorEffortsByModel = cursorSettings?.effortsByModel && typeof cursorSettings.effortsByModel === 'object'
    ? cursorSettings.effortsByModel
    : {};
  const cursorReasoningOffByModel = cursorSettings?.reasoningOffByModel && typeof cursorSettings.reasoningOffByModel === 'object'
    ? cursorSettings.reasoningOffByModel
    : {};
  // Models that cannot be told to stop reasoning still expose 'none'; it means
  // "model default" there, and the composer labels it that way.
  const cursorReasoningDefaultOnly = {};
  for (const cursorModel of cursorModels) {
    const providersKey = String(cursorModel || '').trim();
    if (!providersKey) continue;
    const lowerKey = providersKey.toLowerCase();
    // Discovered effort tiers ('none' = model default) drive the composer;
    // models with no effort parameter stay at 'none' only.
    const cursorEfforts = Array.isArray(cursorEffortsByModel[lowerKey]) && cursorEffortsByModel[lowerKey].length
      ? cursorEffortsByModel[lowerKey]
      : ['none'];
    cursorReasoningByModel[lowerKey] = [...cursorEfforts];
    // Only claim a model cannot turn reasoning off where discovery actually said
    // so. Before the first refresh on an upgraded install there is no map at
    // all, and a configured model discovery never saw has no entry in it —
    // asserting "unsupported" in either case would relabel a working off switch.
    if (
      cursorSettings?.reasoningOffDiscovered === true
      && Object.prototype.hasOwnProperty.call(cursorReasoningOffByModel, lowerKey)
    ) {
      cursorReasoningDefaultOnly[lowerKey] = cursorReasoningOffByModel[lowerKey] !== true;
    }
    if (!Array.isArray(reasoningByModel[lowerKey]) || reasoningByModel[lowerKey].length === 0) {
      reasoningByModel[lowerKey] = [...cursorEfforts];
    }
    const existingProviders = Array.isArray(providersByModel[providersKey])
      ? providersByModel[providersKey]
      : (Array.isArray(providersByModel[lowerKey])
          ? providersByModel[lowerKey]
          : (modelMetadataByModel[providersKey]?.provider ? [modelMetadataByModel[providersKey].provider] : []));
    providersByModel[providersKey] = Array.from(new Set([
      ...existingProviders,
      ...(baseModels.has(lowerKey) ? ['github-copilot'] : []),
      'cursor',
    ]));
    modelMetadataByModel[providersKey] = {
      ...(modelMetadataByModel[providersKey] || {}),
      provider: modelMetadataByModel[providersKey]?.provider || (baseModels.has(lowerKey) ? 'github-copilot' : 'cursor'),
    };
  }
  return {
    ...modelState,
    models,
    reasoningByModel,
    reasoningByProvider: {
      ...(modelState?.reasoningByProvider || {}),
      cursor: cursorReasoningByModel,
    },
    reasoningOffUnsupportedByProvider: {
      ...(modelState?.reasoningOffUnsupportedByProvider || {}),
      cursor: cursorReasoningDefaultOnly,
    },
    modelMetadataByModel,
    providersByModel,
  };
}

export function buildModelCatalogWithGrokProvider(modelState = {}, grokSettings = {}) {
  const configured = grokSettings?.enabled === true;
  const model = String(grokSettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const baseModels = copilotListedModelIds(modelState);
  const grokModelList = Array.isArray(grokSettings?.models)
    ? grokSettings.models.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const grokModels = [];
  const seenGrokModels = new Set();
  for (const grokModelId of [model, ...grokModelList]) {
    const lowerId = grokModelId.toLowerCase();
    if (seenGrokModels.has(lowerId)) continue;
    seenGrokModels.add(lowerId);
    grokModels.push(grokModelId);
  }
  const models = Array.from(new Set([...(Array.isArray(modelState?.models) ? modelState.models : []), ...grokModels]));
  const reasoningByModel = { ...(modelState?.reasoningByModel || {}) };
  const grokReasoningByModel = {};
  const modelMetadataByModel = { ...(modelState?.modelMetadataByModel || {}) };
  const providersByModel = { ...(modelState?.providersByModel || {}) };
  const grokEffortsByModel = grokSettings?.effortsByModel && typeof grokSettings.effortsByModel === 'object'
    ? grokSettings.effortsByModel
    : {};
  for (const grokModel of grokModels) {
    const providersKey = String(grokModel || '').trim();
    if (!providersKey) continue;
    const lowerKey = providersKey.toLowerCase();
    const grokEfforts = Array.isArray(grokEffortsByModel[lowerKey]) && grokEffortsByModel[lowerKey].length
      ? grokEffortsByModel[lowerKey]
      : ['none', 'low', 'medium', 'high'];
    grokReasoningByModel[lowerKey] = [...grokEfforts];
    if (!Array.isArray(reasoningByModel[lowerKey]) || reasoningByModel[lowerKey].length === 0) {
      reasoningByModel[lowerKey] = [...grokEfforts];
    }
    const existingProviders = Array.isArray(providersByModel[providersKey])
      ? providersByModel[providersKey]
      : (Array.isArray(providersByModel[lowerKey])
          ? providersByModel[lowerKey]
          : (modelMetadataByModel[providersKey]?.provider ? [modelMetadataByModel[providersKey].provider] : []));
    providersByModel[providersKey] = Array.from(new Set([
      ...existingProviders,
      ...(baseModels.has(lowerKey) ? ['github-copilot'] : []),
      'grok',
    ]));
    modelMetadataByModel[providersKey] = {
      ...(modelMetadataByModel[providersKey] || {}),
      provider: modelMetadataByModel[providersKey]?.provider || (baseModels.has(lowerKey) ? 'github-copilot' : 'grok'),
    };
  }
  return {
    ...modelState,
    models,
    reasoningByModel,
    reasoningByProvider: {
      ...(modelState?.reasoningByProvider || {}),
      grok: grokReasoningByModel,
    },
    modelMetadataByModel,
    providersByModel,
  };
}

export function buildModelCatalogWithDeepSeekProvider(modelState = {}, deepseekSettings = {}) {
  const configured = deepseekSettings?.enabled === true;
  const model = String(deepseekSettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const deepseekModels = [];
  const seenDeepSeekModels = new Set();
  const listed = Array.isArray(deepseekSettings?.models) ? deepseekSettings.models : [];
  for (const candidate of [model, ...listed]) {
    const modelId = String(candidate || '').trim();
    const lowerId = modelId.toLowerCase();
    if (!modelId || seenDeepSeekModels.has(lowerId)) continue;
    seenDeepSeekModels.add(lowerId);
    deepseekModels.push(modelId);
  }
  const models = Array.from(new Set([...(Array.isArray(modelState?.models) ? modelState.models : []), ...deepseekModels]));
  const reasoningByModel = { ...(modelState?.reasoningByModel || {}) };
  const deepseekReasoningByModel = {};
  const modelMetadataByModel = { ...(modelState?.modelMetadataByModel || {}) };
  const providersByModel = { ...(modelState?.providersByModel || {}) };
  // DeepSeek's ids are its own ("deepseek-*"): no other provider lists them,
  // so the provider tag is never shared with Copilot.
  for (const deepseekModel of deepseekModels) {
    const lowerKey = deepseekModel.toLowerCase();
    deepseekReasoningByModel[lowerKey] = [...DEEPSEEK_REASONING_EFFORTS];
    if (!Array.isArray(reasoningByModel[lowerKey]) || reasoningByModel[lowerKey].length === 0) {
      reasoningByModel[lowerKey] = [...DEEPSEEK_REASONING_EFFORTS];
    }
    const existingProviders = Array.isArray(providersByModel[deepseekModel])
      ? providersByModel[deepseekModel]
      : (Array.isArray(providersByModel[lowerKey]) ? providersByModel[lowerKey] : []);
    providersByModel[deepseekModel] = Array.from(new Set([...existingProviders, DEEPSEEK_PROVIDER_TYPE]));
    modelMetadataByModel[deepseekModel] = {
      ...(modelMetadataByModel[deepseekModel] || {}),
      provider: modelMetadataByModel[deepseekModel]?.provider || DEEPSEEK_PROVIDER_TYPE,
    };
  }
  return {
    ...modelState,
    models,
    reasoningByModel,
    reasoningByProvider: {
      ...(modelState?.reasoningByProvider || {}),
      [DEEPSEEK_PROVIDER_TYPE]: deepseekReasoningByModel,
    },
    modelMetadataByModel,
    providersByModel,
  };
}

/**
 * Claude API (provider `claude-api`) serves the Claude provider's model ids
 * on an API key. Its layer tags them `claude-api` beside whatever else serves
 * them and keeps its own efforts and context tiers: `[1m]` variants fold into
 * their base model as a long_context tier, as on the Claude layer. An id is
 * never enough to pick this provider; only an explicit `claude-api` does.
 */
export function buildModelCatalogWithClaudeApiProvider(modelState = {}, claudeApiSettings = {}) {
  const configured = claudeApiSettings?.enabled === true;
  const model = String(claudeApiSettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const listed = Array.isArray(claudeApiSettings?.models) ? claudeApiSettings.models : [];
  const longContextBases = new Set();
  const defaultContextBases = new Set();
  const baseModels = [];
  const seenBases = new Set();
  for (const candidate of [model, ...listed]) {
    const modelId = String(candidate || '').trim();
    if (!modelId) continue;
    const isLongContextVariant = CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN.test(modelId);
    const baseId = modelId.replace(CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN, '');
    if (!baseId) continue;
    if (isLongContextVariant) longContextBases.add(baseId.toLowerCase());
    else defaultContextBases.add(baseId.toLowerCase());
    if (seenBases.has(baseId.toLowerCase())) continue;
    seenBases.add(baseId.toLowerCase());
    baseModels.push(baseId);
  }
  const models = Array.from(new Set([...(Array.isArray(modelState?.models) ? modelState.models : []), ...baseModels]));
  const reasoningByModel = { ...(modelState?.reasoningByModel || {}) };
  const claudeApiReasoningByModel = {};
  const modelMetadataByModel = { ...(modelState?.modelMetadataByModel || {}) };
  const providersByModel = { ...(modelState?.providersByModel || {}) };
  const claudeApiContextTiersByModel = {};
  const effortsByModel = claudeApiSettings?.effortsByModel && typeof claudeApiSettings.effortsByModel === 'object'
    ? claudeApiSettings.effortsByModel
    : {};
  for (const baseId of baseModels) {
    const lowerKey = baseId.toLowerCase();
    claudeApiContextTiersByModel[lowerKey] = [
      ...(defaultContextBases.has(lowerKey) ? [{ value: 'default' }] : []),
      ...(longContextBases.has(lowerKey) ? [{ value: 'long_context' }] : []),
    ];
    const efforts = Array.isArray(effortsByModel[lowerKey]) && effortsByModel[lowerKey].length
      ? effortsByModel[lowerKey]
      : effortsByModel[`${lowerKey}[1m]`];
    const claudeApiEfforts = Array.isArray(efforts) && efforts.length
      ? withClaudeUltracodeTier(efforts)
      : [...DEFAULT_CLAUDE_REASONING_EFFORTS];
    claudeApiReasoningByModel[lowerKey] = [...claudeApiEfforts];
    if (!Array.isArray(reasoningByModel[lowerKey]) || reasoningByModel[lowerKey].length === 0) {
      reasoningByModel[lowerKey] = [...claudeApiEfforts];
    }
    const existingProviders = Array.isArray(providersByModel[baseId])
      ? providersByModel[baseId]
      : (Array.isArray(providersByModel[lowerKey]) ? providersByModel[lowerKey] : []);
    providersByModel[baseId] = Array.from(new Set([...existingProviders, CLAUDE_API_PROVIDER_TYPE]));
    modelMetadataByModel[baseId] = {
      ...(modelMetadataByModel[baseId] || {}),
      provider: modelMetadataByModel[baseId]?.provider || CLAUDE_API_PROVIDER_TYPE,
    };
  }
  return {
    ...modelState,
    models,
    reasoningByModel,
    reasoningByProvider: {
      ...(modelState?.reasoningByProvider || {}),
      [CLAUDE_API_PROVIDER_TYPE]: claudeApiReasoningByModel,
    },
    modelMetadataByModel,
    providersByModel,
    claudeApiContextTiersByModel,
  };
}

export function buildSessionWorkerStatusPayload({
  supervisorSnapshot = null,
  queueRows = [],
  // What the last read of the process list did ({ at, durationMs, processes,
  // error }); a slow box shows here before it shows as 502s.
  processList = null,
  // The relay's own build id (runtimeState.buildId): each worker's is shown
  // next to it, so a worker still on the code before a deploy stands out.
  relayBuildId = null,
  // The worker recycle's status() (stale count, recycles in flight and done,
  // who waits on what), or null while the recycle is not wired.
  recycleStatus = null,
} = {}) {
  const snapshot = supervisorSnapshot && typeof supervisorSnapshot === 'object'
    ? supervisorSnapshot
    : {};
  const relayBuild = typeof relayBuildId === 'string' && relayBuildId.trim() ? relayBuildId.trim() : null;
  const workers = (Array.isArray(snapshot.workers) ? snapshot.workers : []).map((worker) => (
    worker && typeof worker === 'object'
      ? {
        ...worker,
        buildId: typeof worker.buildId === 'string' && worker.buildId ? worker.buildId : null,
        startedAt: worker.startedAt || null,
        stale: isWorkerOnOtherBuild(worker, relayBuild),
      }
      : worker
  ));
  const onlineWorkerStatuses = new Set(SESSION_WORKER_ACTIVE_STATUSES);
  const onlineCount = workers.reduce((count, worker) => {
    const status = normalizeWorkerStatusText(worker?.status, 'new');
    return count + (onlineWorkerStatuses.has(status) ? 1 : 0);
  }, 0);
  const onlineProcessCount = workers.reduce((count, worker) => {
    const status = normalizeWorkerStatusText(worker?.status, 'new');
    if (!onlineWorkerStatuses.has(status)) return count;
    return count + (isPidAlive(worker?.pid) ? 1 : 0);
  }, 0);
  const onlineBoundProcessCount = workers.reduce((count, worker) => {
    const status = normalizeWorkerStatusText(worker?.status, 'new');
    if (!onlineWorkerStatuses.has(status)) return count;
    if (!isPidAlive(worker?.pid)) return count;
    const conversationId = normalizeWorkerStatusText(worker?.conversationId);
    return count + (conversationId ? 1 : 0);
  }, 0);
  const onlineUnassignedProcessCount = Math.max(0, onlineProcessCount - onlineBoundProcessCount);
  const normalizedRows = Array.isArray(queueRows) ? queueRows : [];
  const workerBySession = new Map();
  for (const worker of workers) {
    const sid = normalizeWorkerStatusText(worker?.sdkSessionId);
    if (!sid) continue;
    workerBySession.set(sid, worker);
  }

  const integrity = {
    scannedQueueRowCount: normalizedRows.length,
    workerRegistryCount: workers.length,
    queueOwnerOrphanCount: 0,
    queueConversationMismatchCount: 0,
    queueRuntimeMismatchCount: 0,
    queueProcessingStateMismatchCount: 0,
    queueOwnerOrphanSamples: [],
    queueConversationMismatchSamples: [],
    queueRuntimeMismatchSamples: [],
    queueProcessingStateMismatchSamples: [],
  };

  for (const row of normalizedRows) {
    const messageId = normalizeWorkerStatusText(row?.id);
    const ownerSessionId = normalizeWorkerStatusText(row?.owner_sdk_session_id);
    const conversationId = normalizeWorkerStatusText(row?.conversation_id);
    const runtimeSessionId = normalizeWorkerStatusText(row?.runtime_session_id);
    const queueStatus = normalizeWorkerStatusText(row?.status, 'pending');
    if (!ownerSessionId) continue;

    const worker = workerBySession.get(ownerSessionId);
    if (!worker) {
      integrity.queueOwnerOrphanCount += 1;
      integrity.queueOwnerOrphanSamples.push({
        messageId,
        ownerSessionId,
        queueStatus,
      });
      continue;
    }

    if (conversationId && worker.conversationId && conversationId !== worker.conversationId) {
      integrity.queueConversationMismatchCount += 1;
      integrity.queueConversationMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueConversationId: conversationId,
        workerConversationId: worker.conversationId,
      });
    }

    if (runtimeSessionId && worker.runtimeSessionId && runtimeSessionId !== worker.runtimeSessionId) {
      integrity.queueRuntimeMismatchCount += 1;
      integrity.queueRuntimeMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueRuntimeSessionId: runtimeSessionId,
        workerRuntimeSessionId: worker.runtimeSessionId,
      });
    }

    if (queueStatus === 'processing' && normalizeWorkerStatusText(worker.status) !== 'processing') {
      integrity.queueProcessingStateMismatchCount += 1;
      integrity.queueProcessingStateMismatchSamples.push({
        messageId,
        ownerSessionId,
        queueStatus,
        workerStatus: normalizeWorkerStatusText(worker.status, 'unknown'),
      });
    }
  }

  return {
    uiState: normalizeWorkerStatusText(snapshot?.health?.uiState, 'white'),
    degradedReason: normalizeWorkerStatusText(snapshot?.health?.degradedReason, null),
    health: snapshot?.health && typeof snapshot.health === 'object' ? snapshot.health : null,
    workerCount: toSafeNonNegativeInt(snapshot.workerCount, workers.length),
    onlineCount,
    onlineProcessCount,
    processList: processList && typeof processList === 'object' ? { ...processList } : null,
    onlineBoundProcessCount,
    onlineUnassignedProcessCount,
    counts: snapshot.counts && typeof snapshot.counts === 'object' ? snapshot.counts : {},
    workers,
    buildId: relayBuild,
    recycle: recycleStatus && typeof recycleStatus === 'object' ? recycleStatus : null,
    pendingStarts: toSafeNonNegativeInt(snapshot.pendingStarts, 0),
    lifecycle: Array.isArray(snapshot.lifecycle) ? snapshot.lifecycle : [],
    integrity,
  };
}

export function registerSessionsRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    config,
    backgroundWorkView = null,
    cleanupGeneratedImagesForConversation = cleanupGeneratedImagesForConversationDefault,
    queueCounts,
    getModelCatalogState: readCopilotModelCatalogState,
    // Copilot's model map (model-variant-catalog-service.mjs) and the other
    // providers' (provider-model-state.mjs): the switch, the "New" flags.
    getCopilotModelState = () => ({ autoEnableNew: false, unseen: [] }),
    setCopilotAutoEnableNew = null,
    markCopilotModelsSeen = () => false,
    markProviderModelsSeen = () => false,
    // When each provider was last refreshed and the new models the next
    // models_updated carries (provider-model-refresh.mjs), the background
    // check's settings and the check itself. Absent in most tests.
    modelRefreshLedger = null,
    modelRefreshSettings = null,
    modelRefreshScheduler = null,
    // Whether Claude and Grok are set up for the background check (their CLI
    // or their login); absent, switched on is enough.
    isClaudeModelRefreshSetUp = () => true,
    isGrokModelRefreshSetUp = () => true,
    buildRelayReadyBannerData,
    workspaceRootPayload,
    getOpenAIProviderSettings = () => ({ configured: false, enabled: false, model: 'gpt-4o' }),
    refreshOpenAIProviderModels = async () => ({ ok: false, models: [], error: 'OpenAI model discovery is unavailable' }),
    // Server-side Copilot model discovery (Phase 5A) — optional so route tests
    // that don't exercise the catalog can omit it. When present it also gets
    // the models_updated broadcaster, since only this module knows how to
    // layer provider models onto the base catalog payload.
    copilotModelDiscoveryService = null,
    // () → whether the Copilot CLI is installed: decides the Copilot switch
    // once on a new database (copilot-settings-service.mjs). Absent, an
    // unset switch reads as on and nothing is written.
    detectCopilotCli = null,
    getClaudeProviderSettings = () => ({ configured: false, enabled: false, model: 'claude-sonnet-5', models: [] }),
    refreshClaudeProviderModels = async () => ({ ok: false, models: [], error: 'Claude model discovery is unavailable' }),
    // Owns the relay-wide single-flight Claude login state machine. When absent,
    // the provider sign-in routes (provider-auth-routes.mjs) create one per
    // registration rather than a module singleton, so each route registration
    // in tests gets its own instance; production registers these routes once.
    claudeAuthService = null,
    // Owns the relay-wide single-flight CLI install/update, the descriptor
    // table and the binary bindings, on the same terms as claudeAuthService.
    cliInstallService = null,
    updateCheckService = null,
    updateInstallService = null,
    buildUpdateStatePayload = null,
    runningVersion = null,
    getCursorProviderSettings = () => ({ configured: false, enabled: false, model: 'composer-2.5', models: [] }),
    refreshCursorProviderModels = async () => ({ ok: false, models: [], error: 'Cursor model discovery is unavailable' }),
    getGrokProviderSettings = () => ({ configured: false, enabled: false, model: 'grok-4.5', models: [] }),
    refreshGrokProviderModels = async () => ({ ok: false, models: [], error: 'Grok model discovery is unavailable' }),
    // Owns the relay-wide single-flight Grok device-code login, on the same
    // terms as claudeAuthService above.
    grokAuthService = null,
    // Claude Cloud (provider `claude-cloud`): its settings (the switch, the
    // default model, the environment) and what the relay keeps per cloud
    // conversation. Absent in older wiring and most tests, where the provider
    // is simply off.
    claudeCloudSettingsService = null,
    claudeCloudSessionService = null,
    // DeepSeek (provider `deepseek`): its key, models, base URL and
    // attribution (services/deepseek-settings-service.mjs). Absent in older
    // wiring and most tests, where the provider is simply off.
    deepseekSettingsService = null,
    // Claude API (provider `claude-api`): its key, models and monthly cap
    // (services/claude-api-settings-service.mjs). Absent in older wiring and
    // most tests, where the provider is simply off.
    claudeApiSettingsService = null,
    // The Claude API card and monthly cap (services/plan-usage-claude-api.mjs),
    // and the cap's one seam (`{ reached, error? }`; a throw counts as
    // reached). Absent in older wiring and most tests: no card, no cap.
    claudeApiPlanUsage = null,
    getClaudeApiCapState = () => ({ reached: false }),
    // Tokens per turn and per day (services/token-usage-service.mjs): a
    // deleted chat drops its turn rows. Absent in older wiring and most tests.
    tokenUsageService = null,
    // OpenAI image spend (shared/openai-image-spend.mjs): the state for the
    // Check Usage card (`({ conversationId? }) → state`), and the call that
    // re-announces it after the cap or the override changed. Absent in older
    // wiring and most tests: no card, nothing announced.
    getOpenAIImageSpendState = null,
    // Opt-in. An empty list disables the check entirely, which is the default
    // and preserves the historical "any existing directory" behaviour.
    workspaceRootAllowList = [],
    processingTimeoutMs,
    localhostOnly,
    listenHost,
    ensureSessionId,
    // Optional personal-scope billing detail; absent in tests and whenever the
    // token cannot read billing, in which case the Copilot card degrades to its
    // quota meters alone.
    fetchCopilotBillingUsage = null,
    // Optional live Grok subscription quota (weekly SuperGrok %); absent in
    // tests and when the host CLI is not logged in, in which case the Grok
    // card degrades to the local estimated view.
    fetchGrokBillingUsage = null,
    // Optional live Cursor plan quota (dashboard session token); same
    // degradation contract as the Grok fetcher.
    fetchCursorDashboardUsage = null,
    getCursorDashboardTokenSettings = () => ({ configured: false }),
    planUsageService = null,
    // Optional live Claude account usage for the Check Usage modal; it reads
    // nothing while Claude Cloud is off, and absent (tests, older wiring) the
    // Claude card stays the last turn's snapshot.
    claudeAccountUsageService = null,
    // Optional DeepSeek balance (deepseek-balance-service.mjs); it reads
    // nothing while DeepSeek is off, and absent (tests, older wiring) the
    // DeepSeek card shows the relay's estimated spend alone.
    deepseekBalanceService = null,
    // Optional DeepSeek usage export (deepseek-usage-import.mjs): its figures
    // replace the estimate on the days it covers; absent, the card is the estimate.
    deepseekUsageImportService = null,
    getCursorPlanAllowanceSettings = () => ({ cursorModelsUsd: null, otherModelsUsd: null, resetDay: 1 }),
    getGrokPlanAllowanceSettings = () => ({ monthlyUsd: null, resetDay: 1 }),
    // Session groups (migration 0014): null in older wiring and most tests,
    // where every conversation is ungrouped.
    conversationGroups = null,
    configuredConversationSessionMode,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    SUPPORTED_CONVERSATION_SESSION_MODES,
    remotePath,
    sessionWorkerSupervisor,
    sessionWorkerProcessInspector,
    // Seams for stopSessionWorkerProcesses (platform, killImpl, isPidAliveImpl,
    // killTmuxSessionImpl). Tests must inject these instead of relying on the
    // host OS, so the suite behaves identically on Windows and POSIX.
    sessionWorkerStopOverrides = null,
    resolveClaudeSessionRoot = null,
    resolveDeepSeekSessionRoot = null,
    // DeepSeek's Claude Code config directory, which the relay owns: a deleted
    // conversation's leftovers there go with it (claude-session-leftovers.mjs).
    deepseekClaudeConfigDir = '',
    resolveCursorSessionRoot = null,
    getSharePathPrivacyMode = () => DEFAULT_SHARE_PATH_PRIVACY_MODE,
    sharePathKnownRoots = () => ({ roots: [], userNames: [] }),
    getTaskStallMinutes = () => DEFAULT_TASK_STALL_MINUTES,
    statusEventService,
    hostSuspendService = null,
    collectHostActivity = null,
    usageLimitPauseService = null,
    claudeBillingSwitchService = null,
    hostSuspendPlatform = process.platform,
    // Remote relays (server/services/remote-relay-inbound.mjs): origin on
    // conversations another relay's agent created, and the inbound switch.
    // Absent in older wiring and most tests, where both are no-ops.
    remoteRelayInbound = null,
    // Relay events: what each session is doing (state, tasks) and the
    // subscriptions that end with an archived or deleted conversation.
    relayEventService = null,
    // Relay schedules: the ones that fire into or were set by an archived or
    // deleted conversation end with it.
    relayScheduleService = null,
    // Questions that don't block: the pending ones in an archived or deleted
    // conversation end with it.
    relayAskService = null,
    // The question payload of relay_question_updated; absent in most tests,
    // where a cancelled question is not announced.
    formatQuestionRow = null,
    sessionActivityTracker = null,
    // Public shares and their access log (migration 0016); built on `db` when
    // the wiring does not pass one.
    shareRepository = null,
  } = deps;
  // Copilot's catalog as every route here serves it: without the image ids
  // its runtime cannot serve (an OpenAI Image chat takes them from OpenAI).
  const getModelCatalogState = () => withoutCopilotImageModels(readCopilotModelCatalogState());
  // Built on first use: many route tests hand in a database without tables.
  let shareRepositoryInstance = shareRepository;
  const shares = () => (shareRepositoryInstance ||= createShareRepository(db));

  /**
   * `{ sessionState, sessionTasks, lastActivityAt }` of one conversation:
   * running_turn, background_only or idle, with its tasks. Only conversations
   * that may be doing something are asked (`candidates`); the rest are idle.
   */
  function describeSessionActivity(conversationId, candidates = null) {
    const id = String(conversationId || '').trim();
    if (!sessionActivityTracker || !id) return null;
    if (candidates && !candidates.has(id)) return { sessionState: 'idle' };
    try {
      const view = sessionActivityTracker.describe(id);
      return {
        sessionState: view.state,
        ...(view.tasks.length ? { sessionTasks: view.tasks } : {}),
        ...(view.state !== 'idle' && view.lastActivityAt ? { lastActivityAt: view.lastActivityAt } : {}),
      };
    } catch {
      return null;
    }
  }

  function listConversationPins(conversationId) {
    return buildPinList(stmts.listPinnedMessages?.all?.(conversationId) || []);
  }
  function listConversationHiddenMessages(conversationId) {
    return buildHiddenMessageList(stmts.listHiddenMessages?.all?.(conversationId) || []);
  }
  // Orders the per-conversation lists a browser receives (pins, hidden
  // messages). A conversation load that left before a change can arrive after
  // the change's own socket event; with the revision the browser can tell the
  // older list from the newer one. In memory only: a restart starts above
  // every revision handed out before.
  function createConversationListRevisions() {
    const floor = Date.now();
    const byConversation = new Map();
    const current = (conversationId) => byConversation.get(conversationId) || floor;
    return {
      current,
      bump(conversationId) {
        const next = Math.max(Date.now(), current(conversationId) + 1);
        byConversation.set(conversationId, next);
        return next;
      },
    };
  }
  const pinRevisions = createConversationListRevisions();
  const conversationPinRevision = pinRevisions.current;
  const bumpConversationPinRevision = pinRevisions.bump;
  const hiddenMessageRevisions = createConversationListRevisions();
  const conversationHiddenMessagesRevision = hiddenMessageRevisions.current;
  const listSessionWorkerQueueRows = db.prepare(`
    SELECT id, conversation_id, runtime_session_id, owner_sdk_session_id, status
    FROM queue
    WHERE status IN (${SESSION_WORKER_STATUS_QUEUE_STATES.map(() => '?').join(', ')})
    ORDER BY timestamp ASC
  `);
  const listPendingQuestionSessionRows = db.prepare(`
    SELECT DISTINCT TRIM(sdk_session_id) AS sdk_session_id
    FROM relay_questions
    WHERE status = 'pending'
      AND sdk_session_id IS NOT NULL
      AND TRIM(sdk_session_id) <> ''
  `);
  // Changing a CWD stops and respawns a process tree; on Windows that runs a
  // synchronous PowerShell round-trip, so this is an availability control as
  // well as abuse protection. The real duplicate-request fix is the launch mutex
  // (session-launch-mutex-service.mjs).
  const WORKSPACE_ROOT_RATE_LIMIT = 6;
  const workspaceRootRateLimiter = createFixedWindowRateLimiter({
    windowMs: 10_000,
    limit: WORKSPACE_ROOT_RATE_LIMIT,
    bucketTtlMs: 60_000,
    maxBuckets: 4_096,
  });

  function getDeepSeekProviderSettings() {
    return deepseekSettingsService?.getSettings?.()
      || { configured: false, enabled: false, model: DEFAULT_DEEPSEEK_MODEL, models: [], availableModels: [] };
  }

  function getClaudeApiProviderSettings() {
    return claudeApiSettingsService?.getSettings?.()
      || { configured: false, enabled: false, model: '', models: [], availableModels: [], effortsByModel: {} };
  }

  // The Copilot switch (Settings → Providers → Copilot), read at each use.
  function isCopilotEnabled() {
    return copilotEnabledFromStmts(stmts, { detectCli: detectCopilotCli });
  }

  // Layer every enabled provider's models onto the base Copilot catalog
  // (empty while Copilot is switched off).
  function buildModelCatalogWithProviders(catalogState, openAISettings = getOpenAIProviderSettings()) {
    const modelState = isCopilotEnabled() ? catalogState : withoutCopilotModels(catalogState);
    return buildModelCatalogWithClaudeApiProvider(
      buildModelCatalogWithDeepSeekProvider(
        buildModelCatalogWithGrokProvider(
          buildModelCatalogWithCursorProvider(
            buildModelCatalogWithClaudeProvider(
              buildModelCatalogWithOpenAIProvider(modelState, openAISettings),
              getClaudeProviderSettings(),
            ),
            getCursorProviderSettings(),
          ),
          getGrokProviderSettings(),
        ),
        getDeepSeekProviderSettings(),
      ),
      getClaudeApiProviderSettings(),
    );
  }

  // The providers the Refresh button and the background check ask, with
  // their enablement and refresh functions (provider-model-refresh.mjs).
  const providerRefreshTable = buildProviderRefreshTable({
    getOpenAIProviderSettings,
    refreshOpenAIProviderModels,
    getClaudeProviderSettings,
    refreshClaudeProviderModels,
    getCursorProviderSettings,
    refreshCursorProviderModels,
    getGrokProviderSettings,
    refreshGrokProviderModels,
    deepseekSettingsService,
    claudeApiSettingsService,
    copilotModelDiscoveryService,
    isCopilotEnabled,
    isClaudeSetUp: isClaudeModelRefreshSetUp,
    isGrokSetUp: isGrokModelRefreshSetUp,
  });

  /** Models flagged new on the enabled providers: the Select Models menu dot. */
  function countUnseenNewModels() {
    let count = 0;
    for (const settings of [
      getOpenAIProviderSettings(),
      getClaudeProviderSettings(),
      getCursorProviderSettings(),
      getGrokProviderSettings(),
      getDeepSeekProviderSettings(),
      getClaudeApiProviderSettings(),
    ]) {
      if (settings?.enabled === true && Array.isArray(settings.unseenModels)) count += settings.unseenModels.length;
    }
    const copilot = isCopilotEnabled() ? getCopilotModelState() : null;
    return count + (Array.isArray(copilot?.unseen) ? copilot.unseen.length : 0);
  }

  /**
   * What models_updated carries: the catalog, the menu dot's count and, once,
   * the models a refresh found for the first time (the toast).
   */
  function modelsUpdatedPayload(modelState, openAISettings = getOpenAIProviderSettings()) {
    const newModels = modelRefreshLedger?.takeNewModels?.() || [];
    return {
      ...buildModelCatalogWithProviders(modelState, openAISettings),
      unseenNewModelCount: countUnseenNewModels(),
      ...(newModels.length ? { newModels } : {}),
    };
  }

  // A discovery that lands outside any route (the deferred boot refresh) still
  // has to reach connected pickers the way a snapshot POST does.
  copilotModelDiscoveryService?.setOnCatalogUpdated?.(() => {
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
  });
  // So does a background check that changed a provider's models.
  modelRefreshScheduler?.setOnModelsChanged?.(() => {
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
  });

  // The client address as Express derives it through `trust proxy`: a
  // forwarded header counts only when a trusted proxy (by default one on
  // loopback) sent it, so a direct client cannot pick its own bucket.
  function extractClientIp(req) {
    const ip = String(req.ip || req.socket?.remoteAddress || '').trim();
    return ip.slice(0, 128) || 'unknown';
  }

  function consumeWorkspaceRootRateLimit(scopeKey, req, nowMs = Date.now()) {
    const scope = String(scopeKey || '').trim();
    if (!scope) return { ok: false, retryAfterSeconds: 1 };
    return workspaceRootRateLimiter.consume(`${scope}:${extractClientIp(req)}`, nowMs);
  }


  const { emitGroupChanged } = createConversationGroupHelpers({ io, conversationGroups });

  function resolveConversationByIdOrSdkSessionId(requestedId) {
    const lookupId = String(requestedId || '').trim();
    if (!lookupId) return null;
    const byConversationId = stmts.getConv.get(lookupId);
    if (byConversationId) return byConversationId;
    if (typeof stmts.getConvBySdkSessionId?.get === 'function') {
      const bySdkSessionId = stmts.getConvBySdkSessionId.get(lookupId);
      if (bySdkSessionId) return bySdkSessionId;
    }
    return null;
  }

  // One history page selected in SQL (conversation-history-page.mjs), so
  // only the page is hydrated; null when the statements are absent or the
  // conversation cannot be paged in SQL, and the caller loads every row.
  function selectConversationHistoryPageRows(conversationId, cursor = {}, { sharedOnly = false } = {}) {
    const pager = stmts.conversationHistoryPage;
    if (!pager || typeof pager.selectConversationHistoryPage !== 'function') return null;
    return pager.selectConversationHistoryPage(conversationId, { ...cursor, sharedOnly }) || null;
  }

  // The usage snapshots of a page's replies, keyed by reply id.
  function usageSnapshotsForPage(conversationId, pageRows = []) {
    const usage = new Map();
    if (!stmts.getMessageUsageSnapshotByResponse) return usage;
    for (const row of pageRows) {
      if (row?.role !== 'assistant') continue;
      const id = String(row?.id || '').trim();
      const snapshot = id ? mapUsageSnapshotRow(stmts.getMessageUsageSnapshotByResponse.get(id, conversationId)) : null;
      if (snapshot) usage.set(id, snapshot);
    }
    return usage;
  }

  // What liveResendsByOriginal needs beyond a page: only read when the page
  // holds a stopped marker, the one place its result is shown.
  function resendIndexForPage(conversationId, pageRows = [], { sharedOnly = false } = {}) {
    const hasStoppedMarker = pageRows.some((row) => row?.role === 'assistant' && row?.kind === 'stopped');
    if (!hasStoppedMarker) return [];
    return stmts.conversationHistoryPage?.listConversationResendIndex?.(conversationId, { sharedOnly }) || [];
  }

  registerConversationReadRoutes(app, deps, {
    describeSessionActivity,
    resolveConversationByIdOrSdkSessionId,
    selectConversationHistoryPageRows,
    usageSnapshotsForPage,
    resendIndexForPage,
    listConversationPins,
    listConversationHiddenMessages,
    conversationPinRevision,
    bumpConversationPinRevision,
    conversationHiddenMessagesRevision,
    getClaudeProviderSettings,
    conversationGroups,
    remoteRelayInbound,
    backgroundWorkView,
    sessionActivityTracker,
    resolveClaudeSessionRoot,
    resolveDeepSeekSessionRoot,
    resolveCursorSessionRoot,
    getTaskStallMinutes,
    usageLimitPauseService,
    claudeBillingSwitchService,
  });

  registerShareRoutes(app, deps, {
    getSharePathPrivacyMode,
    sharePathKnownRoots,
    workspaceRootAllowList,
    shares,
    extractClientIp,
    listConversationPins,
    listConversationHiddenMessages,
    conversationHiddenMessagesRevision,
    bumpConversationPinRevision,
    hiddenMessageRevisions,
    selectConversationHistoryPageRows,
    usageSnapshotsForPage,
    resendIndexForPage,
  });

  app.get('/api/status/events', auth, (req, res) => {
    const beforeTimestamp = Number(req.query.beforeTimestamp);
    const page = statusEventService.getEventsPage({
      beforeTimestamp: Number.isFinite(beforeTimestamp) ? beforeTimestamp : null,
      beforeId: String(req.query.beforeId || ''),
      limit: req.query.limit,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.json(page);
  });

  registerConversationSettingsRoutes(app, deps, {
    conversationGroups,
    remoteRelayInbound,
    sessionWorkerStopOverrides,
    workspaceRootAllowList,
    describeSessionActivity,
    resolveConversationByIdOrSdkSessionId,
    consumeWorkspaceRootRateLimit,
  });

  registerConversationLifecycleRoutes(app, deps, {
    // The archive ends a turn whose worker is gone as any failed turn ends.
    failQueueMessage: createFailQueueMessageFromDeps(deps),
    cleanupGeneratedImagesForConversation,
    claudeCloudSessionService,
    conversationGroups,
    remoteRelayInbound,
    sessionWorkerStopOverrides,
    usageLimitPauseService,
    relayEventService,
    relayScheduleService,
    relayAskService,
    formatQuestionRow,
    sessionActivityTracker,
    tokenUsageService,
    backgroundWorkView,
    resolveClaudeSessionRoot,
    resolveDeepSeekSessionRoot,
    deepseekClaudeConfigDir,
    shares,
    emitGroupChanged,
    isPidAlive,
    stopIdleWorkspaceRootSession,
    resolveConversationTitle,
  });

  registerConversationBootstrapRoutes(app, deps, {
    getOpenAIProviderSettings,
    getClaudeProviderSettings,
    getCursorProviderSettings,
    getGrokProviderSettings,
    getClaudeApiCapState,
    claudeCloudSettingsService,
    conversationGroups,
    remoteRelayInbound,
    workspaceRootAllowList,
    getModelCatalogState,
    getDeepSeekProviderSettings,
    getClaudeApiProviderSettings,
    buildModelCatalogWithProviders,
    consumeWorkspaceRootRateLimit,
    isCopilotEnabled,
  });

  // The worker recycle's status, read at request time: the recycle is set on
  // runtimeState after the routes are registered, and a status that throws
  // must not take /api/status down with it.
  function readWorkerRecycleStatus() {
    if (typeof runtimeState.workerRecycle !== 'function') return null;
    try {
      return runtimeState.workerRecycle() || null;
    } catch {
      return null;
    }
  }

  // GET /api/status — overall status
  app.get('/api/status', auth, (req, res) => {
    ensureSessionId(req, res);
    const { pendingCount, processingCount, parkedCount } = queueCounts();
    const modelState = getModelCatalogState();
    const runtimeSessionBindingCount = Number(stmts.countRuntimeSessions.get()?.cnt || 0);
    const configuredContextIndicatorMode = String(config?.contextIndicatorMode || '').trim().toLowerCase();
    const contextIndicatorMode = configuredContextIndicatorMode === 'bar' ? 'bar' : 'default';
    const readyBanner = buildRelayReadyBannerData();
    const pendingQuestionSessionIds = listPendingQuestionSessionRows.all()
      .map((row) => normalizeWorkerStatusText(row?.sdk_session_id))
      .filter(Boolean);
    const sessionWorkerStatus = buildSessionWorkerStatusPayload({
      supervisorSnapshot: sessionWorkerSupervisor?.snapshot?.({ pendingQuestionSessionIds }) || null,
      queueRows: listSessionWorkerQueueRows.all(...SESSION_WORKER_STATUS_QUEUE_STATES),
      processList: sessionWorkerProcessInspector?.getLastRead?.() || null,
      relayBuildId: runtimeState.buildId ?? null,
      recycleStatus: readWorkerRecycleStatus(),
    });
    const activeRuntimeSessionCount = Number(sessionWorkerStatus?.onlineBoundProcessCount || 0);
    res.json({
      cliOnline: runtimeState.cliOnline,
      relayPaused: runtimeState.relayPaused,
      pendingCount,
      processingCount,
      parkedCount,
      activeRuntimeSessionCount,
      runtimeSessionBindingCount,
      supportedModels: modelState.models,
      defaultModel: modelState.defaultModel,
      currentModel: modelState.currentModel,
      modelsStale: modelState.stale,
      modelsRefreshedAt: modelState.refreshedAt,
      modelWarning: modelState.warning,
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      defaultRelayMode: DEFAULT_RELAY_MODE,
      supportedConversationSessionModes: SUPPORTED_CONVERSATION_SESSION_MODES,
      conversationSessionMode: configuredConversationSessionMode,
      contextIndicatorMode,
      ...workspaceRootPayload(),
      processingTimeoutMs,
      localhostOnly,
      listenHost,
      readyBanner,
      remotePath,
      sshTunnel: {
        enabled: runtimeState.tunnelState?.enabled ?? false,
        mode: runtimeState.tunnelState?.mode ?? 'disabled',
        required: runtimeState.tunnelState?.required ?? false,
        blocking: runtimeState.tunnelState?.blocking ?? false,
        connected: runtimeState.tunnelState?.connected ?? false,
        host: runtimeState.tunnelState?.host ?? null,
        remotePort: runtimeState.tunnelState?.remotePort ?? null,
        remoteBindMode: runtimeState.tunnelState?.remoteBindMode ?? null,
        reconnectAttempts: runtimeState.tunnelState?.reconnectAttempts ?? 0,
        connectedSince: runtimeState.tunnelState?.connectedSince ?? null,
        lastError: runtimeState.tunnelState?.lastError ?? null,
        valid: runtimeState.tunnelState?.valid ?? true,
      },
      cloudflaredTunnel: {
        enabled: runtimeState.cloudflaredTunnelState?.enabled ?? false,
        mode: runtimeState.cloudflaredTunnelState?.mode ?? 'disabled',
        required: runtimeState.cloudflaredTunnelState?.required ?? false,
        blocking: runtimeState.cloudflaredTunnelState?.blocking ?? false,
        connected: runtimeState.cloudflaredTunnelState?.connected ?? false,
        reconnectAttempts: runtimeState.cloudflaredTunnelState?.reconnectAttempts ?? 0,
        connectedSince: runtimeState.cloudflaredTunnelState?.connectedSince ?? null,
        lastError: runtimeState.cloudflaredTunnelState?.lastError ?? null,
        binaryMissing: runtimeState.cloudflaredTunnelState?.binaryMissing ?? false,
        valid: runtimeState.cloudflaredTunnelState?.valid ?? true,
      },
      workerWebSocket: runtimeState.workerWebSocketStatus || null,
      relayShutdown: runtimeState.relayShutdown || null,
      hostSuspend: runtimeState.hostSuspend || null,
      usageLimit: runtimeState.usageLimit || null,
      platform: process.platform,
      sessionWorker: sessionWorkerStatus,
      version: runningVersion || null,
      update: typeof buildUpdateStatePayload === 'function' ? buildUpdateStatePayload() : null,
    });
  });

  registerSettingsRoutes(app, deps, {
    getModelCatalogState,
    modelsUpdatedPayload,
    shares,
    getOpenAIProviderSettings,
    refreshOpenAIProviderModels,
    getClaudeProviderSettings,
    refreshClaudeProviderModels,
    getCursorProviderSettings,
    refreshCursorProviderModels,
    getGrokProviderSettings,
    refreshGrokProviderModels,
    deepseekSettingsService,
    claudeApiSettingsService,
    tokenUsageService,
    getCursorDashboardTokenSettings,
    planUsageService,
    deepseekBalanceService,
    getCursorPlanAllowanceSettings,
    getGrokPlanAllowanceSettings,
    getSharePathPrivacyMode,
    getTaskStallMinutes,
    remoteRelayInbound,
    isCopilotEnabled,
  });

  registerProviderAuthRoutes(app, deps, {
    claudeAuthService,
    cliInstallService,
    grokAuthService,
    updateCheckService,
    updateInstallService,
    buildUpdateStatePayload,
    copilotModelDiscoveryService,
    getClaudeProviderSettings,
    refreshClaudeProviderModels,
    getGrokProviderSettings,
    refreshGrokProviderModels,
    getModelCatalogState,
    modelsUpdatedPayload,
    isCopilotEnabled,
  });

  registerHostRoutes(app, deps, {
    hostSuspendService,
    collectHostActivity,
    hostSuspendPlatform,
    usageLimitPauseService,
  });

  registerModelRoutes(app, deps, {
    isCopilotEnabled,
    getModelCatalogState,
    getOpenAIProviderSettings,
    getClaudeProviderSettings,
    getCursorProviderSettings,
    getGrokProviderSettings,
    getDeepSeekProviderSettings,
    getClaudeApiProviderSettings,
    buildModelCatalogWithProviders,
    modelsUpdatedPayload,
    countUnseenNewModels,
    providerRefreshTable,
    getCopilotModelState,
    setCopilotAutoEnableNew,
    markCopilotModelsSeen,
    markProviderModelsSeen,
    modelRefreshLedger,
    modelRefreshSettings,
    deepseekSettingsService,
    claudeApiSettingsService,
    claudeCloudSettingsService,
    planUsageService,
    claudeAccountUsageService,
    fetchCopilotBillingUsage,
    fetchGrokBillingUsage,
    fetchCursorDashboardUsage,
    getCursorDashboardTokenSettings,
    deepseekBalanceService,
    deepseekUsageImportService,
    getCursorPlanAllowanceSettings,
    getGrokPlanAllowanceSettings,
    claudeApiPlanUsage,
    getOpenAIImageSpendState,
    tokenUsageService,
  });
}
