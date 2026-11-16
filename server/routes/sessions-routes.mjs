'use strict';
import { liveResendsByOriginal } from '../services/steer-resend.mjs';
import { killTmuxSession } from '../services/session-worker-launch-service.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import {
  buildConversationHistoryPageInfo,
  normalizeConversationHistoryLimit,
  normalizeConversationTimestampMs,
} from '../services/conversation-history-page.mjs';
import { MESSAGE_PIN_LIMIT, buildPinList } from '../services/message-pin-list.mjs';
import { buildHiddenMessageList } from '../services/hidden-message-list.mjs';
import { readMayCreateSessions, readPlanOnly } from '../services/conversation-preferences-service.mjs';
import { parseAutoCompactWindow } from '../../shared/auto-compact-window.mjs';
import { CLAUDE_ATTRIBUTION_MODES, DEFAULT_CLAUDE_ATTRIBUTION_MODE, claudeAttributionModelLabel, claudeAttributionTrailer, normalizeClaudeAttributionMode, resolveClaudeAttributionMode } from '../../shared/claude-attribution.mjs';
import { parseThinkingDisplay, parseThinkingEnabled } from '../../shared/claude-thinking.mjs';
import {
  DEFAULT_CLAUDE_REASONING_EFFORTS,
  withClaudeUltracodeTier,
} from '../services/provider-reasoning-effort.mjs';
import { mapUsageSnapshotRow, fetchUsageSummaryPromise } from '../services/usage-snapshot-helpers.mjs';
import { readStoredClaudeContextUsage, resolveAutoCompactWindowStatus } from '../services/claude-context-usage.mjs';
import { buildContextUsageView } from '../services/context-usage-view.mjs';
import { cleanupGeneratedImagesForConversation as cleanupGeneratedImagesForConversationDefault } from '../services/generated-image-cleanup-service.mjs';
import { withGeneratedImageFiles } from '../services/generated-image-files.mjs';
import { stopSessionWorkerProcesses } from '../services/session-worker-stop-service.mjs';
import { isWorkerOnOtherBuild } from '../services/worker-recycle-service.mjs';
import {
  CLAUDE_API_PROVIDER_TYPE,
} from '../services/claude-api-settings-service.mjs';
import {
  DEEPSEEK_PROVIDER_TYPE,
  DEEPSEEK_REASONING_EFFORTS,
  DEFAULT_DEEPSEEK_MODEL,
  deepseekModelLabel,
} from '../../shared/deepseek-models.mjs';
import {
  isWithinAllowedPrefix,
  normalizeWorkspaceRootKey } from '../services/workspace-root-path-policy.mjs';
import { sessionLaunchMutex } from '../services/session-launch-mutex-service.mjs';
import { createFixedWindowRateLimiter } from '../services/rate-limit-service.mjs';
import { parseRemoteRelayOriginJson } from '../repositories/remote-relay-repository.mjs';
import { createShareRepository } from '../repositories/share-repository.mjs';
import { resolveGroupDisplayName } from '../repositories/conversation-group-repository.mjs';
import { conversationGroupPosition, conversationGroupRole, groupActivityTimes, pageConversationRows } from '../public/app/conversation-group-order.mjs';
import { detailsVersion, parseHeldDetailsParam, thoughtFingerprint } from '../public/app/held-details.mjs';
import { readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import {
  evaluateWorkspaceRootRelaunch,
} from '../services/workspace-root-relaunch-service.mjs';
import {
  CLAUDE_DEFAULT_CONTEXT_LIMIT_TOKENS,
  CLAUDE_LONG_CONTEXT_LIMIT_TOKENS,
  CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN,
} from '../../shared/model-id.mjs';
import { openAIReasoningEffortsForModel } from '../../shared/openai-reasoning.mjs';
import {
  OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE,
  isOpenAIImageModelId,
  openAIImageModelNeedsOpenAIText,
} from '../../shared/openai-image-options.mjs';
import { buildOpenAIImagePlanCard } from '../services/plan-usage-openai-image.mjs';
import {
  REMOTE_RELAY_GROUP_LIMITS,
  formatSessionGroupList,
} from '../../shared/remote-relay-contract.mjs';
import {
  buildConversationCloudPayload,
  isClaudeCloudProviderType,
} from '../services/claude-cloud-session-service.mjs';
import {
  DEFAULT_SHARE_PATH_PRIVACY_MODE,
} from '../../shared/share-path-privacy.mjs';
import {
  DEFAULT_TASK_STALL_MINUTES,
} from '../../shared/task-output-text.mjs';
import { appendTokenSections } from '../services/plan-usage-tokens.mjs';
import { buildProviderRefreshTable, refreshProviderModels } from '../services/provider-model-refresh.mjs';
import { registerShareRoutes } from './share-routes.mjs';
import { registerProviderAuthRoutes } from './provider-auth-routes.mjs';
import { registerSettingsRoutes } from './settings-routes.mjs';
import { registerConversationSettingsRoutes } from './conversation-settings-routes.mjs';
import { registerConversationLifecycleRoutes } from './conversation-lifecycle-routes.mjs';
import { registerConversationBootstrapRoutes } from './conversation-bootstrap-routes.mjs';
import { MODEL_REFRESH_INTERVAL_HOURS_CHOICES, MODEL_REFRESH_PROVIDERS, DEFAULT_MODEL_REFRESH_AUTO, DEFAULT_MODEL_REFRESH_INTERVAL_HOURS } from '../../shared/model-refresh-schedule.mjs';

export { mapUsageSnapshotRow };
export {
  OPENAI_IMAGE_DAILY_CAP_MAX_USD,
  claudeAttributionSettingsFields,
  parseClaudeSettingsUpdateRequest,
  parseCursorSettingsUpdateRequest,
  parseDefaultSessionWorkspaceRootUpdateRequest,
  parseGrokSettingsUpdateRequest,
  parseOpenAIImageSpendSettingsRequest,
  parseOpenAISettingsUpdateRequest,
} from './settings-routes.mjs';
export {
  DRAFT_UPLOAD_MESSAGE_ID,
  MAX_CONVERSATION_DRAFT_ATTACHMENTS,
  MAX_CONVERSATION_DRAFT_LENGTH,
  diffDraftAttachmentHashes,
  hasConversationDraftVersionConflict,
  normalizeDraftAttachmentsInput,
  normalizeOptionalIsoTimestamp,
} from './conversation-settings-routes.mjs';
export { resolveBootstrapModelSelection } from './conversation-bootstrap-routes.mjs';
export {
  buildConversationShareToken,
  filterMessagesVisibleToSharedView,
  normalizeShareToken,
  normalizeSharedViewerId,
} from './share-routes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_WORKER_STATUS_QUEUE_STATES = Object.freeze(['pending', 'processing', 'parked']);
// Registry statuses that mean "this worker is currently running" (same triple
// as ACTIVE_SESSION_CWD_STATUSES in server-runtime.mjs).
const SESSION_WORKER_ACTIVE_STATUSES = Object.freeze(['starting', 'ready', 'processing']);

function normalizeWorkerStatusText(value, fallback = null) {
  const text = String(value || '').trim();
  return text || fallback;
}

function toSafeNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

export function buildReasoningByModelFromVariantRows(rows = []) {
  const map = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const baseModelId = String(row?.baseModelId || '').trim().toLowerCase();
    if (!baseModelId) continue;
    const effort = String(row?.reasoningEffort || '').trim().toLowerCase();
    if (!effort) continue;
    const current = map[baseModelId] || [];
    if (!current.includes(effort)) current.push(effort);
    map[baseModelId] = current;
  }
  return map;
}

export function buildModelVariantCatalogPayload({
  rows = [],
  modelState = {},
  reasoningEfforts = [],
  contextLimitsByModel = null,
  modelMetadataByModel = null,
} = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const enabledVariantIds = safeRows
    .filter((row) => !!row?.enabled)
    .map((row) => row.variantId);
  const reasoningByModel = modelState?.reasoningByModel && typeof modelState.reasoningByModel === 'object'
    ? modelState.reasoningByModel
    : buildReasoningByModelFromVariantRows(safeRows);
  const effectiveContextLimitsByModel = contextLimitsByModel && typeof contextLimitsByModel === 'object'
    ? contextLimitsByModel
    : (modelState?.contextLimitsByModel && typeof modelState.contextLimitsByModel === 'object'
      ? modelState.contextLimitsByModel
      : {});
  return {
    variants: safeRows.map((row) => ({
      variantId: row.variantId,
      baseModelId: row.baseModelId,
      provider: row.provider,
      label: row.label,
      releaseStatus: row.releaseStatus || null,
      reasoningEffort: row.reasoningEffort || null,
      contextLimitTokens: row.contextLimitTokens || null,
      longContextLimitTokens: row.longContextLimitTokens || null,
      pricing: row.pricing || null,
      enabled: !!row.enabled,
      sortOrder: row.sortOrder,
    })),
    enabledVariantIds,
    reasoningByModel,
    source: modelState?.source || null,
    refreshedAt: modelState?.refreshedAt || null,
    warning: modelState?.warning || null,
    error: modelState?.error || null,
    reasoningEfforts: Array.isArray(reasoningEfforts) ? reasoningEfforts : [],
    contextLimitsByModel: effectiveContextLimitsByModel,
    modelMetadataByModel: modelMetadataByModel && typeof modelMetadataByModel === 'object'
      ? modelMetadataByModel
      : (modelState?.modelMetadataByModel || {}),
  };
}

/**
 * A folder's attribution override update: `{ path, attributionMode }` with
 * the mode one of the three, or null to inherit the provider setting again.
 */
export function parseWorkspaceRootAttributionUpdate(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const path = String(payload.path || '').trim();
  if (!path) return { ok: false, error: 'Missing path' };
  if (!Object.prototype.hasOwnProperty.call(payload, 'attributionMode')) {
    return { ok: false, error: 'Missing attributionMode (oar, vanilla, off, or null to inherit)' };
  }
  if (payload.attributionMode === null || payload.attributionMode === '') return { ok: true, path, attributionMode: null };
  const attributionMode = normalizeClaudeAttributionMode(payload.attributionMode);
  if (!attributionMode) {
    return { ok: false, error: `Invalid attribution mode (one of ${CLAUDE_ATTRIBUTION_MODES.join(', ')}, or null to inherit)` };
  }
  return { ok: true, path, attributionMode };
}

/** What a folder's Claude sessions will say, given the provider setting and the folder's own choice. */
export function buildWorkspaceRootAttributionPayload({ path = '', folderMode = null, providerMode = null, model = '' } = {}) {
  const effectiveMode = resolveClaudeAttributionMode({ providerMode, folderMode });
  return {
    path: String(path || '').trim(),
    attributionMode: normalizeClaudeAttributionMode(folderMode),
    providerMode: normalizeClaudeAttributionMode(providerMode) || DEFAULT_CLAUDE_ATTRIBUTION_MODE,
    effectiveMode,
    attributionModes: [...CLAUDE_ATTRIBUTION_MODES],
    attributionExample: effectiveMode === 'oar'
      ? claudeAttributionTrailer(claudeAttributionModelLabel(String(model || 'claude-sonnet-5')))
      : (effectiveMode === 'off' ? '' : null),
  };
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

/** The refusal of a Copilot chat on an image model (400), or null for any other model. */
function copilotImageModelRefusal(model = '') {
  const modelId = String(model || '').trim();
  if (!isOpenAIImageModelId(modelId)) return null;
  return { ok: false, error: openAIImageModelNeedsOpenAIText(modelId), code: OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE };
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

function isPidAlive(pidValue) {
  const pid = Number(pidValue);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = String(error?.code || '').trim().toUpperCase();
    if (code === 'EPERM') return true;
    return false;
  }
}

export function canUpdateWorkspaceRoot(runtimeState = {}) {
  return true;
}

export async function launchWorkspaceRootSession(
  runtimeState = {},
  sessionWorkerSupervisor = null,
  sdkSessionId = '',
  sessionWorkerRegistry = null,
  // Defaults preserve the behaviour of POST /api/session-worker/:id/launch.
  // The CWD relaunch route passes { allowProcessReuse: false } so the new
  // directory is actually applied, { resetKilledMarker: false } because it
  // clears the kill block itself once the old CLI is verifiably dead, and
  // { requireStoppedWorker: false } because it has already done that check —
  // re-running it here would reject on stale registry state.
  { allowProcessReuse = true, resetKilledMarker = true, requireStoppedWorker = true } = {},
) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) {
    return { ok: false, statusCode: 400, error: 'Missing session id' };
  }
  const activeStatuses = SESSION_WORKER_ACTIVE_STATUSES;
  const selectedWorkerState = typeof sessionWorkerSupervisor?.getWorkerState === 'function'
    ? sessionWorkerSupervisor.getWorkerState(sid)
    : null;
  const selectedWorkerPid = Number(selectedWorkerState?.pid);
  const selectedWorkerHasPid = Number.isInteger(selectedWorkerPid) && selectedWorkerPid > 0;
  const selectedWorkerPidAlive = isPidAlive(selectedWorkerPid);
  const selectedWorkerStatus = String(selectedWorkerState?.status || '').trim().toLowerCase();
  if (requireStoppedWorker && activeStatuses.includes(selectedWorkerStatus) && (!selectedWorkerHasPid || selectedWorkerPidAlive)) {
    return { ok: false, statusCode: 409, error: 'Selected CLI is already running' };
  }
  if (activeStatuses.includes(selectedWorkerStatus) && selectedWorkerHasPid && !selectedWorkerPidAlive) {
    sessionWorkerSupervisor?.clearRestartSchedule?.(sid, { resetKilledMarker });
    sessionWorkerRegistry?.removeWorker?.(sid);
  } else if (resetKilledMarker) {
    // Explicit user-triggered launch always clears the kill block so it is not
    // stuck behind the 30-second grace window from a prior kill.
    sessionWorkerSupervisor?.clearRestartSchedule?.(sid, { resetKilledMarker: true });
  }
  if (!sessionWorkerSupervisor || typeof sessionWorkerSupervisor.ensureWorker !== 'function') {
    return { ok: false, statusCode: 500, error: 'Session worker launcher is unavailable' };
  }

  const result = await sessionWorkerSupervisor.ensureWorker(sid, { allowProcessReuse });
  if (!result?.ok) {
    return {
      ok: false,
      statusCode: 409,
      error: result?.error || 'launch-failed',
      worker: result?.worker || null,
      lifecycle: result?.lifecycle || null,
    };
  }
  return { ok: true, statusCode: 200, ...result };
}

// Lives in services/workspace-root-relaunch-service.mjs; re-exported here so the
// existing import path keeps working.
export { evaluateWorkspaceRootRelaunch };

async function stopIdleWorkspaceRootSession({
  sdkSessionId,
  worker,
  sessionWorkerSupervisor,
  sessionWorkerRegistry,
  sessionWorkerProcessInspector,
  stopOverrides = null,
} = {}) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) return { ok: false, error: 'Missing session id' };
  sessionWorkerSupervisor?.markKilled?.(sid);
  await sessionWorkerSupervisor?.cancelPendingStart?.(sid, { wait: true });

  const stopped = await stopSessionWorkerProcesses({
    sdkSessionId: sid,
    worker,
    processInspector: sessionWorkerProcessInspector,
    isPidAliveImpl: isPidAlive,
    killTmuxSessionImpl: killTmuxSession,
    ...(stopOverrides || {}),
  });
  // Only tear down the bookkeeping once every process is verifiably gone.
  // Clearing it while a CLI is still alive is what lets the relaunch "succeed"
  // by silently reusing that CLI in the old working directory.
  if (!stopped.ok) {
    return {
      ok: false,
      timedOut: stopped.timedOut === true,
      remainingPids: stopped.remainingPids || [],
      stoppedPids: stopped.pids || [],
      error: stopped.error || 'Failed to stop the idle CLI',
    };
  }

  sessionWorkerRegistry?.removeWorker?.(sid);
  sessionWorkerSupervisor?.clearRestartSchedule?.(sid);
  sessionWorkerSupervisor?.resetHealth?.(sid, { clearFailureCount: false });
  return { ok: true, stoppedPids: stopped.pids || [] };
}

const MAX_CONVERSATION_TITLE_LENGTH = 120;
const FALLBACK_RELAY_MODE = 'agent';

export function normalizeConversationTitle(value) {
  const title = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!title) return '';
  return title.slice(0, MAX_CONVERSATION_TITLE_LENGTH);
}

export function normalizeRelayModePreference(value, {
  supportedRelayModes = [],
  fallbackMode = FALLBACK_RELAY_MODE,
} = {}) {
  const allowedModes = Array.isArray(supportedRelayModes)
    ? supportedRelayModes.map((mode) => String(mode || '').trim()).filter(Boolean)
    : [];
  const fallback = allowedModes.includes(fallbackMode)
    ? fallbackMode
    : (allowedModes[0] || FALLBACK_RELAY_MODE);
  const mode = String(value || '').trim();
  if (!mode) return fallback;
  return allowedModes.includes(mode) ? mode : fallback;
}

export function normalizePreferredModel(value) {
  return String(value || '').trim();
}

export function normalizePreferredReasoningEffort(value) {
  return String(value || '').trim().toLowerCase();
}

export function parseDraftAttachmentsColumn(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function resolveConversationPreferences(row, {
  supportedRelayModes = [],
  defaultRelayMode = FALLBACK_RELAY_MODE,
} = {}) {
  return {
    preferredRelayMode: normalizeRelayModePreference(row?.preferred_relay_mode, {
      supportedRelayModes,
      fallbackMode: defaultRelayMode,
    }),
    preferredModel: normalizePreferredModel(row?.preferred_model),
    preferredReasoningEffort: normalizePreferredReasoningEffort(row?.preferred_reasoning_effort),
  };
}

function replaceYamlScalarLine(content, key, value) {
  const nextKey = String(key || '').trim();
  if (!nextKey) return String(content || '');
  const replacement = `${nextKey}: ${value}`;
  const pattern = new RegExp(`^\\s*${nextKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*.*$`, 'im');
  const text = String(content || '');
  if (pattern.test(text)) {
    return text.replace(pattern, replacement);
  }
  const trimmed = text.trimEnd();
  if (!trimmed) return `${replacement}\n`;
  return `${trimmed}\n${replacement}\n`;
}

function buildWorkspaceYamlTitleContent(existingContent, { sessionId = '', title = '', updatedAt = '' } = {}) {
  const sid = String(sessionId || '').trim();
  const nextTitle = normalizeConversationTitle(title);
  const iso = String(updatedAt || '').trim() || new Date().toISOString();
  const existingText = String(existingContent || '');

  if (!existingText.trim()) {
    return [
      `id: ${sid}`,
      `summary: ${nextTitle}`,
      `name: ${nextTitle}`,
      `updated_at: ${iso}`,
      `modified: ${iso}`,
      '',
    ].join('\n');
  }

  return replaceYamlScalarLine(
    replaceYamlScalarLine(
      replaceYamlScalarLine(
        replaceYamlScalarLine(existingText, 'summary', nextTitle),
        'name',
        nextTitle,
      ),
      'updated_at',
      iso,
    ),
    'modified',
    iso,
  ).replace(/\s*$/, '\n');
}

function updateConversationWorkspaceTitle() {
  return { ok: true, updated: false, reason: 'workspace-yaml-title-sync-disabled' };
}

export function resolveConversationTitle({ title = '', titleSource = '', discoveredTitle = '' } = {}) {
  const storedTitle = String(title || '').trim();
  const source = String(titleSource || '').trim().toLowerCase();
  const discovered = String(discoveredTitle || '').trim();
  const normalizedDiscovered = discovered.toLowerCase();
  const poisonedDiscoveredTitle = normalizedDiscovered.startsWith('[relay mode:')
    || normalizedDiscovered.startsWith('implement relay tool guidance')
    || normalizedDiscovered.includes('relay tool guidance')
    || normalizedDiscovered.includes('for any user-facing question or clarification, use the ask_user tool')
    || normalizedDiscovered.includes('these instructions remain in effect until relay mode changes');
  const safeDiscovered = poisonedDiscoveredTitle ? '' : discovered;
  if (source === 'manual') return storedTitle || safeDiscovered;
  return safeDiscovered || storedTitle;
}

export function persistConversationTitle({
  db,
  stmts,
  io = null,
  conversationId = '',
  title = '',
  resolveSessionStateRoot = null,
} = {}) {
  const id = String(conversationId || '').trim();
  const nextTitle = normalizeConversationTitle(title);
  if (!id) {
    return { ok: false, statusCode: 400, error: 'Missing conversation id' };
  }
  if (!nextTitle) {
    return { ok: false, statusCode: 400, error: 'Missing title' };
  }

  const existing = stmts?.getConvAnyStatus?.get?.(id) || null;
  if (existing && String(existing.status || '').trim() === 'deleted') {
    return { ok: false, statusCode: 404, error: 'Conversation not found' };
  }

  const updatedAt = existing?.updated_at || new Date().toISOString();

  if (!existing) {
    if (typeof stmts?.insertConv?.run === 'function') {
      stmts.insertConv.run(id, nextTitle, updatedAt, updatedAt);
    } else if (db && typeof db.prepare === 'function') {
      db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(id, nextTitle, updatedAt, updatedAt);
    }
  }

  if (typeof stmts?.updateConvTitle?.run === 'function') {
    stmts.updateConvTitle.run(nextTitle, id);
  } else if (db && typeof db.prepare === 'function') {
    db.prepare(`UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?`).run(nextTitle, id);
  }

  if (typeof stmts?.setConvSdkSessionIdIfMissing?.run === 'function') {
    stmts.setConvSdkSessionIdIfMissing.run(id, updatedAt, id);
  } else if (db && typeof db.prepare === 'function') {
    db.prepare(`UPDATE conversations SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id = '')`).run(id, updatedAt, id);
  }

  const workspaceResult = updateConversationWorkspaceTitle({
    resolveSessionStateRoot,
    conversationId: id,
    sdkSessionId: existing?.sdk_session_id || id,
    title: nextTitle,
    updatedAt,
  });

  const payload = {
    conversationId: id,
    title: nextTitle,
    updatedAt,
    workspaceYamlPath: workspaceResult.updated ? workspaceResult.workspaceYamlPath : null,
  };
  io?.emit?.('conversation_title_updated', payload);
  return { ok: true, ...payload, created: !existing };
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

export function buildConversationSessionRootPayload({
  conversationId = '',
  sdkSessionId = '',
  title = '',
  resolveSessionStateRoot = null,
  providerType = '',
  claudeNativeSessionId = '',
  workspaceRootPath = '',
  resolveClaudeSessionRoot = null,
  // The same Claude Code layout, in the DeepSeek workers' own config dir.
  resolveDeepSeekSessionRoot = null,
  resolveCursorSessionRoot = null,
} = {}) {
  const sid = String(sdkSessionId || '').trim() || String(conversationId || '').trim();
  // A Claude Cloud session lives in Anthropic's cloud: there is no session
  // folder on this host, and it must not be looked up as a Copilot one.
  if (isClaudeCloudProviderType(providerType)) return null;
  // Cursor sessions have no ~/.copilot/session-state entry either — their
  // on-disk footprint is the worker's per-session agent store, created on the
  // first turn.
  if (String(providerType || '').trim().toLowerCase() === 'cursor') {
    if (!sid || typeof resolveCursorSessionRoot !== 'function') return null;
    const cursorRoot = resolveCursorSessionRoot({ sdkSessionId: sid });
    if (!cursorRoot?.sessionRootPath) return null;
    return {
      sdkSessionId: sid,
      sessionRootPath: cursorRoot.sessionRootPath,
      sessionRootName: cursorRoot.sessionRootName || 'Session',
    };
  }
  // Claude sessions have no ~/.copilot/session-state entry — only the Copilot
  // CLI creates those — so they resolve against the Agent SDK's own layout and
  // never fall through to the branch below. A Claude API session is a Claude
  // session on an API key, in the same place.
  const claudeCodeProvider = String(providerType || '').trim().toLowerCase();
  if (claudeCodeProvider === 'claude' || claudeCodeProvider === 'deepseek' || claudeCodeProvider === 'claude-api') {
    const nativeSessionId = String(claudeNativeSessionId || '').trim();
    const resolveRoot = claudeCodeProvider === 'deepseek' ? resolveDeepSeekSessionRoot : resolveClaudeSessionRoot;
    if (!nativeSessionId || typeof resolveRoot !== 'function') return null;
    const claudeRoot = resolveRoot({
      claudeNativeSessionId: nativeSessionId,
      workspaceRootPath: String(workspaceRootPath || '').trim(),
    });
    if (!claudeRoot?.sessionRootPath) return null;
    return {
      sdkSessionId: sid,
      sessionRootPath: claudeRoot.sessionRootPath,
      sessionRootName: claudeRoot.sessionRootName || 'Session',
    };
  }
  if (!sid || typeof resolveSessionStateRoot !== 'function') return null;
  const root = String(resolveSessionStateRoot() || '').trim();
  if (!root) return null;
  const rootPath = path.join(root, sid);
  if (!fs.existsSync(rootPath)) return null;
  let stat = null;
  try {
    stat = fs.statSync(rootPath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;
  return {
    sdkSessionId: sid,
    sessionRootPath: rootPath,
    sessionRootName: 'Session',
  };
}

function activityEntryMetadata(value) {
  const metadata = value && typeof value === 'object' ? value.metadata : null;
  return (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : null;
}

function mergeUniqueActivityTexts(primary = [], secondary = []) {
  const merged = [];
  const indexByKey = new Map();
  for (const value of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    const text = value && typeof value === 'object'
      ? String(value.text || '').trim()
      : String(value || '').trim();
    const subagentRunId = value && typeof value === 'object' && value.subagentRunId
      ? String(value.subagentRunId).trim()
      : '';
    const key = `${subagentRunId}::${text}`;
    if (!text) continue;
    const entry = value && typeof value === 'object' ? { ...value, text } : text;
    if (indexByKey.has(key)) {
      // Same prose from two sources: the structured copy wins. A compaction
      // boundary reaches the transcript branch as prose only, and dropping
      // the metadata-bearing duplicate would cost the client its break row.
      const existingIndex = indexByKey.get(key);
      if (activityEntryMetadata(entry) && !activityEntryMetadata(merged[existingIndex])) {
        merged[existingIndex] = entry;
      }
      continue;
    }
    indexByKey.set(key, merged.length);
    merged.push(entry);
  }
  return merged;
}

function normalizeConversationMessageIdentityText(value) {
  const raw = String(value || '');
  const withoutAttachmentMarkers = raw.replace(/\s*\[(?:Attached file|Attached files):[^\]]+\]\s*/gi, ' ');
  return withoutAttachmentMarkers.replace(/\s+/g, ' ').trim();
}

function conversationMessageIdentityKey(message) {
  const role = String(message?.role || '').trim().toLowerCase();
  const timestamp = String(message?.timestamp || '').trim();
  const text = normalizeConversationMessageIdentityText(message?.text);
  return `${role}::${timestamp}::${text}`;
}

function conversationMessageRoleTextKey(message) {
  const role = String(message?.role || '').trim().toLowerCase();
  const text = normalizeConversationMessageIdentityText(message?.text);
  return `${role}::${text}`;
}

function isLikelyCanonicalDuplicateMessage(a, b, timestampWindowMs = 30_000) {
  const aRoleText = conversationMessageRoleTextKey(a);
  const bRoleText = conversationMessageRoleTextKey(b);
  if (!aRoleText || !bRoleText || aRoleText !== bRoleText) return false;

  const aSource = String(a?.sourceMessageId || '').trim();
  const bSource = String(b?.sourceMessageId || '').trim();
  if (aSource && bSource) return aSource === bSource;

  const aTs = normalizeConversationTimestampMs(a?.timestamp);
  const bTs = normalizeConversationTimestampMs(b?.timestamp);
  if (!aTs || !bTs) return false;
  return Math.abs(aTs - bTs) <= Math.max(1_000, Number(timestampWindowMs) || 30_000);
}


function normalizeConversationTimestampIso(value, fallback = null) {
  const ms = normalizeConversationTimestampMs(value);
  if (!ms) return fallback;
  return new Date(ms).toISOString();
}

function isTranscriptUserEchoOfQueuedMessage({
  transcriptMessage = null,
  canonicalDbMessages = [],
  queueRowsById = new Map(),
  firstAssistantTimestampBySourceId = new Map(),
  responseGraceMs = 5_000,
} = {}) {
  if (String(transcriptMessage?.role || '').trim().toLowerCase() !== 'user') return false;
  const transcriptTimestampMs = normalizeConversationTimestampMs(transcriptMessage?.timestamp);
  if (!transcriptTimestampMs) return false;
  const graceMs = Math.max(0, Number(responseGraceMs) || 0);
  for (const dbMessage of Array.isArray(canonicalDbMessages) ? canonicalDbMessages : []) {
    const canonicalId = String(dbMessage?.id || '').trim();
    if (!canonicalId) continue;
    const canonicalTimestampMs = normalizeConversationTimestampMs(dbMessage?.timestamp);
    if (!canonicalTimestampMs || transcriptTimestampMs < canonicalTimestampMs) continue;
    const queueRow = queueRowsById.get(canonicalId) || null;
    if (!queueRow) continue;
    const queueStatus = String(queueRow?.status || '').trim().toLowerCase();
    if (queueStatus === 'pending' || queueStatus === 'processing' || queueStatus === 'parked') {
      return true;
    }
    const assistantTimestampMs = normalizeConversationTimestampMs(firstAssistantTimestampBySourceId.get(canonicalId));
    if (assistantTimestampMs && transcriptTimestampMs <= (assistantTimestampMs + graceMs)) {
      return true;
    }
  }
  return false;
}

function compareConversationMessageOrder(a, b) {
  const aTs = normalizeConversationTimestampMs(a?.timestamp);
  const bTs = normalizeConversationTimestampMs(b?.timestamp);
  if (aTs !== bTs) return aTs - bTs;
  const aId = String(a?.id || '').trim();
  const bId = String(b?.id || '').trim();
  return aId.localeCompare(bId);
}

export { normalizeConversationHistoryLimit };

function resolveConversationHistoryCursor(messages = [], {
  messageId = '',
  timestamp = '',
} = {}) {
  const cursorMessageId = String(messageId || '').trim();
  const cursorTimestampText = String(timestamp || '').trim();
  const list = Array.isArray(messages) ? messages : [];

  if (cursorMessageId) {
    const cursorMessage = list.find((message) => String(message?.id || '').trim() === cursorMessageId) || null;
    if (cursorMessage) {
      return {
        beforeMessageId: cursorMessageId,
        beforeTimestamp: String(cursorMessage.timestamp || '').trim() || null,
        timestampMs: normalizeConversationTimestampMs(cursorMessage.timestamp),
      };
    }
  }

  if (cursorTimestampText) {
    return {
      beforeMessageId: cursorMessageId || null,
      beforeTimestamp: cursorTimestampText,
      timestampMs: normalizeConversationTimestampMs(cursorTimestampText),
    };
  }

  return null;
}

export function selectConversationHistoryPage(messages = [], {
  limit = 20,
  beforeMessageId = '',
  beforeTimestamp = '',
  afterMessageId = '',
  afterTimestamp = '',
  aroundMessageId = '',
} = {}) {
  const pageLimit = normalizeConversationHistoryLimit(limit);
  const ordered = Array.isArray(messages)
    ? messages.filter((message) => !!message).slice().sort(compareConversationMessageOrder)
    : [];
  const aroundId = String(aroundMessageId || '').trim();
  const requestedAroundWindow = !!aroundId;
  const beforeCursor = resolveConversationHistoryCursor(ordered, { messageId: beforeMessageId, timestamp: beforeTimestamp });
  const afterCursor = resolveConversationHistoryCursor(ordered, { messageId: afterMessageId, timestamp: afterTimestamp });

  let pageMessages = [];
  if (aroundId) {
    const aroundIndex = ordered.findIndex((message) => String(message?.id || '').trim() === aroundId);
    if (aroundIndex >= 0) {
      const halfWindow = Math.floor((pageLimit - 1) / 2);
      let start = Math.max(0, aroundIndex - halfWindow);
      let end = Math.min(ordered.length, start + pageLimit);
      if ((end - start) < pageLimit) {
        start = Math.max(0, end - pageLimit);
      }
      pageMessages = ordered.slice(start, end);
    }
  }
  // Treat any non-empty afterMessageId as an intentional "after" request even when the
  // cursor message is not found in the current list (e.g. transcript-only session where
  // the ID is absent).  Without this guard the fallback branch would silently return a
  // stale tail page instead of an empty result.
  const requestedAfterWindow = !!String(afterMessageId || '').trim();
  if (!pageMessages.length && !requestedAroundWindow && afterCursor) {
    const newerMessages = ordered.filter((message) => {
      const messageTimestampMs = normalizeConversationTimestampMs(message?.timestamp);
      if (messageTimestampMs > afterCursor.timestampMs) return true;
      if (messageTimestampMs < afterCursor.timestampMs) return false;
      if (!afterCursor.beforeMessageId) return false;
      return String(message?.id || '').trim().localeCompare(afterCursor.beforeMessageId) > 0;
    });
    pageMessages = newerMessages.slice(0, pageLimit);
  }
  if (!pageMessages.length && !requestedAfterWindow && !requestedAroundWindow) {
    const olderMessages = beforeCursor
      ? ordered.filter((message) => {
          const messageTimestampMs = normalizeConversationTimestampMs(message?.timestamp);
          if (messageTimestampMs < beforeCursor.timestampMs) return true;
          if (messageTimestampMs > beforeCursor.timestampMs) return false;
          if (!beforeCursor.beforeMessageId) return false;
          return String(message?.id || '').trim().localeCompare(beforeCursor.beforeMessageId) < 0;
        })
      : ordered;
    pageMessages = olderMessages.slice(-pageLimit);
  }

  const firstMessage = pageMessages[0] || null;
  const lastMessage = pageMessages[pageMessages.length - 1] || null;
  let firstIdx = -1;
  let lastIdx = -1;
  if (firstMessage && lastMessage) {
    firstIdx = ordered.findIndex((message) => String(message?.id || '').trim() === String(firstMessage.id || '').trim());
    for (let idx = ordered.length - 1; idx >= 0; idx -= 1) {
      if (String(ordered[idx]?.id || '').trim() === String(lastMessage.id || '').trim()) {
        lastIdx = idx;
        break;
      }
    }
  }
  const hasMoreOlder = firstIdx > 0;
  const hasMoreNewer = lastIdx >= 0 && lastIdx < (ordered.length - 1);
  return {
    messages: pageMessages,
    pageInfo: buildConversationHistoryPageInfo(pageMessages, { hasMoreOlder, hasMoreNewer }),
  };
}

export function normalizeMessageSearchLimit(value, fallback = 30) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(100, Math.max(1, Math.trunc(Number(fallback) || 30)));
  return Math.min(100, Math.max(1, Math.trunc(numeric)));
}

export function normalizeMessageSearchOffset(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

export function buildMessageSearchMatchQuery(rawQuery = '') {
  const query = String(rawQuery || '').trim();
  if (!query) return '';
  const tokens = query
    .split(/\s+/)
    .map((part) => part.replace(/"/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!tokens.length) return '';
  return tokens.map((part) => `"${part}"*`).join(' AND ');
}

const DEFAULT_CONVERSATION_LIST_LIMIT = 40;
const MAX_CONVERSATION_LIST_LIMIT = 100;

export function normalizeConversationListLimit(value, fallback = DEFAULT_CONVERSATION_LIST_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(MAX_CONVERSATION_LIST_LIMIT, Math.max(1, Number(fallback) || DEFAULT_CONVERSATION_LIST_LIMIT));
  }
  return Math.min(MAX_CONVERSATION_LIST_LIMIT, Math.max(1, Math.trunc(parsed)));
}

/**
 * One page of the conversation list, newest first, with session groups kept
 * whole: the order and the cursor are those of conversation-group-order.mjs,
 * which the sidebar uses too. `groups` is the `Map<id, group>` of the rows'
 * groups (the head of each group is needed for the order inside it).
 */
export function selectConversationListPage(rows = [], {
  limit = DEFAULT_CONVERSATION_LIST_LIMIT,
  beforeConversationId = '',
  beforeUpdatedAt = '',
  beforeGroupId = '',
  groups = null,
} = {}) {
  return pageConversationRows(rows, groups, {
    limit: normalizeConversationListLimit(limit),
    beforeConversationId,
    beforeUpdatedAt,
    beforeGroupId,
  });
}

export function buildConversationMessages({
  dbMessages = [],
  transcriptMessages = [],
  relayActivitiesByMessageId = new Map(),
  relayThoughtsByMessageId = new Map(),
  subagentRunsByMessageId = new Map(),
  workflowRunsByMessageId = new Map(),
  previewCardsByMessageId = new Map(),
  responseMessageToSourceId = new Map(),
  queueRows = [],
  usageByResponseMessageId = new Map(),
  // When dbMessages is one page: the conversation's rows liveResendsByOriginal
  // reads (id, role, source_message_id, resend_of_message_id), since a stopped
  // marker on the page may have its Resend outside it.
  resendIndexMessages = null,
} = {}) {
  const queueRowsById = new Map(
    (Array.isArray(queueRows) ? queueRows : [])
      .map((row) => [String(row?.id || '').trim(), row])
      .filter(([id]) => !!id),
  );
  // A stopped steer's marker says "Resent" from the data, so it holds across
  // reloads and devices (the relay refuses a second Resend on the same basis).
  const liveResends = liveResendsByOriginal(Array.isArray(resendIndexMessages) ? resendIndexMessages : dbMessages, queueRows);
  const normalizedDbMessages = Array.isArray(dbMessages)
    ? dbMessages.map((message) => {
        const id = String(message?.id || '').trim();
        // The queue's link is pruned with old rows; the message's own column
        // keeps it, so a reload still anchors the reply under its prompt.
        const sourceMessageId = message?.role === 'assistant'
          ? (responseMessageToSourceId.get(id) || String(message?.source_message_id || '').trim() || undefined)
          : undefined;
        // A user row's queue entry shares its id; assistant rows reach the same
        // entry through the response mapping. Both need it for the effort tag.
        const queueRow = sourceMessageId
          ? queueRowsById.get(sourceMessageId)
          : (message?.role === 'user' ? queueRowsById.get(id) : null);
        // Provenance of a prompt another relay's agent sent: the bubble's badge.
        const origin = message?.role === 'user' ? parseRemoteRelayOriginJson(message?.origin_json) : null;
        return {
          activities: message?.role === 'assistant' ? (relayActivitiesByMessageId.get(id) || []) : [],
          thoughts: message?.role === 'assistant' ? (relayThoughtsByMessageId.get(id) || []) : [],
          subagentRuns: message?.role === 'assistant' ? (subagentRunsByMessageId.get(id) || []) : [],
          workflowRuns: message?.role === 'assistant' ? (workflowRunsByMessageId.get(id) || []) : [],
          previewCards: message?.role === 'assistant' ? (previewCardsByMessageId.get(id) || []) : [],
          id,
          role: message?.role,
          text: stripRelayPromptContext(message?.text, message?.mode),
          model: message?.model || undefined,
          modelOrigin: message?.model_origin
            || message?.modelOrigin
            || ((String(queueRow?.model || '').trim().toLowerCase() === 'auto') ? 'auto' : undefined),
          reasoningEffort: queueRow?.reasoning_effort || undefined,
          usage: message?.role === 'assistant' ? (usageByResponseMessageId.get(id) || undefined) : undefined,
          attachments: message?.attachments || [],
          mode: message?.mode || undefined,
          hiddenFromShares: Number(message?.hidden_from_shares || 0) === 1,
          pinned: !!message?.pinned_at,
          timestamp: message?.timestamp,
          sourceMessageId,
          executedProvider: message?.executed_provider || message?.executedProvider || undefined,
          // 'continuation' badges a self-started turn; 'absorbed' marks a
          // reply that continues through the next (steered) user message;
          // 'folded'/'stopped' are a steer's settle markers, and
          // 'answered-elsewhere' marks a message whose answer is on a
          // continuation row. Without this the live-appended
          // badge/merge/marker vanished on reload.
          kind: message?.kind || undefined,
          resendOfMessageId: message?.role === 'user' ? (message?.resend_of_message_id || undefined) : undefined,
          resentAs: (message?.role === 'assistant' && message?.kind === 'stopped' && sourceMessageId)
            ? (liveResends.get(sourceMessageId) || undefined)
            : undefined,
          ...(origin ? { origin } : {}),
        };
      })
    : [];
  const normalizedTranscriptMessages = (Array.isArray(transcriptMessages) ? transcriptMessages : []).map((message) => {
    const id = String(message?.id || '').trim();
    const sourceMessageId = message?.role === 'assistant'
      ? (responseMessageToSourceId.get(id) || message?.sourceMessageId || undefined)
      : message?.sourceMessageId;
    // As in the db branch: a user row's queue entry is keyed by its own id.
    const queueRow = sourceMessageId
      ? queueRowsById.get(String(sourceMessageId || '').trim())
      : (message?.role === 'user' ? queueRowsById.get(id) : null);
    return {
      ...message,
      id,
      activities: mergeUniqueActivityTexts(
        Array.isArray(message?.activities) ? message.activities : [],
        id ? (relayActivitiesByMessageId.get(id) || []) : [],
      ),
      thoughts: (Array.isArray(message?.thoughts) && message.thoughts.length)
        ? message.thoughts
        : (id ? (relayThoughtsByMessageId.get(id) || []) : []),
      subagentRuns: (Array.isArray(message?.subagentRuns) && message.subagentRuns.length)
        ? message.subagentRuns
        : (id ? (subagentRunsByMessageId.get(id) || []) : []),
      workflowRuns: (Array.isArray(message?.workflowRuns) && message.workflowRuns.length)
        ? message.workflowRuns
        : (id ? (workflowRunsByMessageId.get(id) || []) : []),
      previewCards: (Array.isArray(message?.previewCards) && message.previewCards.length)
        ? message.previewCards
        : (id ? (previewCardsByMessageId.get(id) || []) : []),
      text: stripRelayPromptContext(message?.text, message?.mode),
      sourceMessageId,
      modelOrigin: message?.modelOrigin
        || message?.model_origin
        || ((String(queueRow?.model || '').trim().toLowerCase() === 'auto') ? 'auto' : undefined),
      reasoningEffort: message?.reasoningEffort || queueRow?.reasoning_effort || undefined,
      usage: message?.role === 'assistant' ? (usageByResponseMessageId.get(id) || message?.usage || undefined) : message?.usage,
    };
  });

  const transcriptById = new Map(
    normalizedTranscriptMessages
      .map((message) => [String(message?.id || '').trim(), message])
      .filter(([id]) => !!id),
  );

  const messagesById = new Map();
  for (const message of normalizedDbMessages) {
    messagesById.set(String(message.id || '').trim(), message);
  }

  if (normalizedDbMessages.length === 0) {
    return normalizedTranscriptMessages.slice().sort(compareConversationMessageOrder);
  }

  const dbIdentityKeys = new Set(
    normalizedDbMessages.map((message) => conversationMessageIdentityKey(message)),
  );
  const dbMessagesByRoleText = new Map();
  for (const message of normalizedDbMessages) {
    const key = conversationMessageRoleTextKey(message);
    if (!key || key.endsWith('::')) continue;
    const bucket = dbMessagesByRoleText.get(key) || [];
    bucket.push(message);
    dbMessagesByRoleText.set(key, bucket);
  }
  const firstAssistantTimestampBySourceId = new Map();
  for (const message of normalizedDbMessages) {
    if (String(message?.role || '').trim().toLowerCase() !== 'assistant') continue;
    const sourceMessageId = String(message?.sourceMessageId || '').trim();
    if (!sourceMessageId) continue;
    const timestamp = String(message?.timestamp || '').trim();
    if (!timestamp) continue;
    const existing = String(firstAssistantTimestampBySourceId.get(sourceMessageId) || '').trim();
    if (!existing || normalizeConversationTimestampMs(timestamp) < normalizeConversationTimestampMs(existing)) {
      firstAssistantTimestampBySourceId.set(sourceMessageId, timestamp);
    }
  }
  const retriedQueueRowsByRoleText = new Map();
  for (const row of Array.isArray(queueRows) ? queueRows : []) {
    const retryCount = Math.max(0, Number(row?.retry_count || 0));
    if (retryCount < 1) continue;
    const key = conversationMessageRoleTextKey({
      role: 'user',
      text: row?.text,
    });
    if (!key || key.endsWith('::')) continue;
    const bucket = retriedQueueRowsByRoleText.get(key) || [];
    bucket.push({
      id: String(row?.id || '').trim(),
      timestamp: String(row?.timestamp || '').trim(),
      retryCount,
    });
    retriedQueueRowsByRoleText.set(key, bucket);
  }

  for (const message of transcriptById.values()) {
    const id = String(message?.id || '').trim();
    if (!id) continue;
    const existing = messagesById.get(id);
    if (!existing) continue;
    if (existing.role !== 'assistant') continue;
    const transcriptMessage = transcriptById.get(id) || null;
    if (!transcriptMessage) continue;
    messagesById.set(id, {
      ...existing,
      activities: mergeUniqueActivityTexts(
        Array.isArray(existing.activities) ? existing.activities : [],
        Array.isArray(transcriptMessage.activities) ? transcriptMessage.activities : [],
      ),
      text: stripRelayPromptContext(existing.text, existing.mode),
    });
  }

  for (const message of normalizedTranscriptMessages) {
    const id = String(message?.id || '').trim();
    if (id && messagesById.has(id)) continue;
    const identityKey = conversationMessageIdentityKey(message);
    if (dbIdentityKeys.has(identityKey)) continue;
    const roleTextKey = conversationMessageRoleTextKey(message);
    const maybeCanonicalRows = roleTextKey ? (dbMessagesByRoleText.get(roleTextKey) || []) : [];
    const retriedQueueRows = roleTextKey ? (retriedQueueRowsByRoleText.get(roleTextKey) || []) : [];
    if (
      message?.role === 'user'
      && maybeCanonicalRows.length > 0
      && retriedQueueRows.some((row) => maybeCanonicalRows.some((dbRow) => String(dbRow?.id || '').trim() === row.id))
    ) {
      const messageTimestampMs = normalizeConversationTimestampMs(message?.timestamp);
      const earliestCanonicalTimestampMs = maybeCanonicalRows.reduce((earliest, row) => {
        const next = normalizeConversationTimestampMs(row?.timestamp);
        if (!next) return earliest;
        if (!earliest) return next;
        return Math.min(earliest, next);
      }, 0);
      if (!earliestCanonicalTimestampMs || !messageTimestampMs || messageTimestampMs >= earliestCanonicalTimestampMs) {
        continue;
      }
    }
    if (maybeCanonicalRows.some((row) => isLikelyCanonicalDuplicateMessage(row, message))) continue;
    if (isTranscriptUserEchoOfQueuedMessage({
      transcriptMessage: message,
      canonicalDbMessages: maybeCanonicalRows,
      queueRowsById,
      firstAssistantTimestampBySourceId,
    })) {
      continue;
    }
    dbIdentityKeys.add(identityKey);
    if (!id) continue;
    messagesById.set(id, message);
  }

  return Array.from(messagesById.values()).sort(compareConversationMessageOrder);
}

export function registerSessionsRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    config,
    parseAttachments,
    hydrateAttachment,
    relayActivityForResponse,
    relayThoughtsForResponse,
    subagentRunsForResponse,
    workflowRunsForResponse,
    previewCardsForResponse,
    buildContextResponseText,
    readContextFromSessionEvents,
    inFlightStateForConversation,
    backgroundTaskStore,
    backgroundWorkView = null,
    listConversationPreviews,
    cleanupGeneratedImagesForConversation = cleanupGeneratedImagesForConversationDefault,
    queueCounts,
    getModelCatalogState: readCopilotModelCatalogState,
    updateModelCatalog,
    listModelVariantRows,
    refreshModelVariantCatalogFromCli,
    setEnabledModelVariants,
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
    SUPPORTED_REASONING_EFFORTS,
    buildRelayReadyBannerData,
    workspaceRootPayload,
    setWorkspaceRoot,
    getOpenAIProviderSettings = () => ({ configured: false, enabled: false, model: 'gpt-4o' }),
    refreshOpenAIProviderModels = async () => ({ ok: false, models: [], error: 'OpenAI model discovery is unavailable' }),
    // Server-side Copilot model discovery (Phase 5A) — optional so route tests
    // that don't exercise the catalog can omit it. When present it also gets
    // the models_updated broadcaster, since only this module knows how to
    // layer provider models onto the base catalog payload.
    copilotModelDiscoveryService = null,
    getClaudeProviderSettings = () => ({ configured: false, enabled: false, model: 'claude-sonnet-5', models: [] }),
    refreshClaudeProviderModels = async () => ({ ok: false, models: [], error: 'Claude model discovery is unavailable' }),
    // Owns the relay-wide single-flight Claude login state machine. Created here
    // (rather than as a module singleton) so each route registration in tests
    // gets its own instance; production registers these routes once.
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
    resolveConversationWorkspaceState,
    // Opt-in. An empty list disables the check entirely, which is the default
    // and preserves the historical "any existing directory" behaviour.
    workspaceRootAllowList = [],
    processingTimeoutMs,
    localhostOnly,
    listenHost,
    ensureSessionId,
    markCliOffline,
    fetchUsageSummary,
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
    sessionHistoryRefreshService,
    sdkSessionImportService,
    // Session groups (migration 0014): null in older wiring and most tests,
    // where every conversation is ungrouped.
    conversationGroups = null,
    bootstrapRuntimeSessionBindings,
    configuredConversationSessionMode,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    SUPPORTED_CONVERSATION_SESSION_MODES,
    DEFAULT_CONVERSATION_SESSION_MODE,
    remotePath,
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
    sessionWorkerProcessInspector,
    // Seams for stopSessionWorkerProcesses (platform, killImpl, isPidAliveImpl,
    // killTmuxSessionImpl). Tests must inject these instead of relying on the
    // host OS, so the suite behaves identically on Windows and POSIX.
    sessionWorkerStopOverrides = null,
    resolveSessionStateRoot,
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
  let listRunningRunConversations = null;
  try {
    listRunningRunConversations = db.prepare(`SELECT DISTINCT conversation_id FROM subagent_runs WHERE status = 'running'`);
  } catch {}

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

  /** The conversations that may be busy: a turn queued, a run or task known. */
  function activityCandidates(activeTurnConversationIds) {
    const ids = new Set(activeTurnConversationIds);
    for (const id of sessionActivityTracker?.knownConversationIds?.() || []) ids.add(String(id));
    try {
      for (const row of listRunningRunConversations?.all?.() || []) ids.add(String(row.conversation_id || ''));
    } catch {}
    return ids;
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
  const getConversationUsageSnapshotAggregate = db.prepare(`
    SELECT
      COUNT(*) AS snapshot_count,
      MAX(captured_at) AS captured_at,
      SUM(CASE WHEN plan_delta_used IS NOT NULL AND plan_delta_used > 0 THEN plan_delta_used ELSE 0 END) AS plan_credits_used,
      MAX(plan_entitlement) AS plan_entitlement,
      SUM(CASE WHEN premium_delta_used IS NOT NULL AND premium_delta_used > 0 THEN premium_delta_used ELSE 0 END) AS premium_credits_used,
      SUM(CASE WHEN premium_delta_used IS NOT NULL AND premium_delta_used > 0 THEN 1 ELSE 0 END) AS premium_request_count
    FROM message_usage_snapshots
    WHERE conversation_id = ?
  `);
  // Changing a CWD stops and respawns a process tree; on Windows that runs a
  // synchronous PowerShell round-trip, so this is an availability control as
  // well as abuse protection. The real duplicate-request fix is the mutex below.
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

  // Layer every enabled provider's models onto the base Copilot catalog.
  function buildModelCatalogWithProviders(modelState, openAISettings = getOpenAIProviderSettings()) {
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
    const copilot = getCopilotModelState();
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


  /**
   * A session group as the list payload carries it: name, display name (the
   * head's current title when none was given), head and member counts.
   */
  function groupSummaryPayload(group) {
    if (!group) return null;
    const members = conversationGroups?.membersOf?.(group.id) || [];
    const head = group.parentConversationId
      ? members.find((member) => member.id === group.parentConversationId) || null
      : null;
    return {
      id: group.id,
      name: group.name || null,
      displayName: resolveGroupDisplayName({
        name: group.name,
        headTitle: head ? resolveConversationTitle({ title: head.title, titleSource: 'auto' }) : null,
      }),
      parentConversationId: group.parentConversationId || null,
      memberCount: members.length,
      liveMemberCount: members.filter((member) => !member.archived).length,
      // An owner's group an agent emptied, which stays until the owner acts.
      keptEmptyAt: group.keptEmptyAt || null,
    };
  }

  /** The `group` field of a single conversation payload: the summary plus the members. */
  /**
   * The `group` field of a single conversation payload: the summary and the
   * conversation's role. The live members, with what each is doing, only
   * when asked for (`groupMembers=1`, the relay_tool's read_session)
   * and never for a paired relay's agent: the browser does not read them,
   * and archived members' titles stay on this relay.
   */
  function conversationGroupPayload(conversationId, req = null) {
    const group = conversationGroups?.groupOfConversation?.(conversationId) || null;
    if (!group) return null;
    const summary = groupSummaryPayload(group);
    const payload = {
      ...summary,
      role: conversationId === group.parentConversationId ? 'head' : 'member',
    };
    const wantsMembers = String(req?.query?.groupMembers || '').trim() === '1';
    const request = req ? readRemoteRelayRequest(req, remoteRelayInbound) : { remote: false };
    if (wantsMembers && (!request.remote || request.local === true)) {
      payload.members = (conversationGroups.membersOf(group.id) || [])
        .filter((member) => member.archived !== true)
        .slice(0, 50)
        .map((member) => ({
          id: member.id,
          title: resolveConversationTitle({ title: member.title, titleSource: 'auto' }),
          role: member.id === group.parentConversationId ? 'head' : 'member',
          state: describeSessionActivity(member.id)?.sessionState || 'idle',
        }));
    }
    return payload;
  }

  /** A conversation row's place in its group's hand order; null outside a group. */
  function conversationGroupPositionOf(conv) {
    if (!String(conv?.group_id || '').trim() || !conversationGroups?.getGroup?.(conv.group_id)) return null;
    return conversationGroupPosition(conv);
  }

  /**
   * Tells every page a group changed, with what the page can apply in place:
   * the group's summary (null once dissolved), the named conversations'
   * membership, the group's order (head first) and the positions of its
   * members and of the named conversations.
   */
  function emitGroupChanged(groupId, conversationIds = []) {
    const ids = [...new Set(conversationIds.map((id) => String(id || '').trim()).filter(Boolean))];
    const group = groupId ? groupSummaryPayload(conversationGroups?.getGroup?.(groupId) || null) : null;
    const order = group ? conversationGroups?.orderOf?.(groupId) || [] : [];
    io.emit('conversation_group_changed', {
      groupId: groupId || null,
      conversationIds: ids,
      group,
      memberships: conversationGroups?.membershipsOf?.(ids) || {},
      order,
      positions: conversationGroups?.positionsOf?.([...order, ...ids]) || {},
    });
  }

  // A session group named at bootstrap (an agent's create_session `group`):
  // what the lookup sees is what an agent may see (GET /api/conversation-groups).
  const autoTitle = (title) => resolveConversationTitle({ title, titleSource: 'auto' });
  const listGroupsForAgents = () => conversationGroups?.listGroups?.({ headTitle: autoTitle }) || [];

  /** The 400 body for a group this relay does not have, or has several of by that name. */
  function bootstrapGroupRefusal(found, requested, groups) {
    const ambiguous = found.status === 'ambiguous';
    const listed = ambiguous ? found.matches : groups;
    const asked = String(requested || '').replace(/["\r\n]+/g, ' ').slice(0, 80);
    let error;
    if (ambiguous) error = `"${asked}" names several session groups here: ${formatSessionGroupList(listed)}. Pass the id.`;
    else if (groups.length) error = `No session group "${asked}" here. Groups: ${formatSessionGroupList(groups)}.`;
    else error = `No session group "${asked}" here: this relay has no session groups.`;
    return {
      ok: false,
      code: ambiguous ? 'SESSION_GROUP_AMBIGUOUS' : 'SESSION_GROUP_NOT_FOUND',
      error: `${error} No conversation was created.`,
      groups: listed.slice(0, REMOTE_RELAY_GROUP_LIMITS.refusalMax).map((group) => ({ id: group.id, name: group.name })),
      // How many there are when `groups` is cut to the cap.
      ...(listed.length > REMOTE_RELAY_GROUP_LIMITS.refusalMax ? { groupsTotal: listed.length } : {}),
    };
  }

  /** `{ id, name, role }` of the group a conversation sits in (list_sessions' shape), or null. */
  function conversationGroupField(conversationId) {
    const membership = conversationGroups?.membershipsOf?.([conversationId])?.[conversationId];
    if (!membership?.groupId) return null;
    const described = conversationGroups.describeGroup?.(membership.groupId, { headTitle: autoTitle }) || null;
    return { id: membership.groupId, name: described?.displayName || null, role: membership.role === 'head' ? 'head' : 'member' };
  }

  /** The `cloud` field of a conversation payload; null unless it is a cloud one. */
  function conversationCloudPayload(conversation, runtimeSession) {
    return buildConversationCloudPayload({
      cloudSourceJson: conversation?.cloud_source_json,
      costUsd: runtimeSession?.claude_cloud_cost_usd,
    });
  }

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

  function resolveSessionUsageSummaryForSdkSession({ sdkSessionId, conversationId } = {}) {
    const sid = String(sdkSessionId || '').trim();
    const convId = String(conversationId || '').trim();
    if (!convId) return null;
    const aggregate = getConversationUsageSnapshotAggregate.get(convId) || null;
    const snapshotCount = Number(aggregate?.snapshot_count || 0);
    if (!Number.isFinite(snapshotCount) || snapshotCount <= 0) return null;
    const planCreditsUsed = Number(aggregate?.plan_credits_used);
    const planEntitlement = Number(aggregate?.plan_entitlement);
    const planMonthlyPercentUsed = Number.isFinite(planCreditsUsed) && Number.isFinite(planEntitlement) && planEntitlement > 0
      ? Math.max(0, (planCreditsUsed / planEntitlement) * 100)
      : null;
    const premiumCreditsUsed = Number(aggregate?.premium_credits_used);
    const premiumRequestCount = Number(aggregate?.premium_request_count);
    const normalizedPlanCreditsUsed = Number.isFinite(planCreditsUsed) ? Math.max(0, planCreditsUsed) : null;
    const normalizedPremiumCreditsUsed = Number.isFinite(premiumCreditsUsed) ? Math.max(0, premiumCreditsUsed) : null;
    const estimatedAicUsed = (
      normalizedPlanCreditsUsed != null && normalizedPlanCreditsUsed > 0
        ? normalizedPlanCreditsUsed
        : (normalizedPremiumCreditsUsed != null && normalizedPremiumCreditsUsed > 0
          ? normalizedPremiumCreditsUsed
          : null)
    );
    return {
      shutdownAt: null,
      aicUsed: estimatedAicUsed,
      totalPremiumRequests: null,
      totalNanoAiu: null,
      totalApiDurationMs: null,
      requestCount: null,
      source: 'usage-snapshots',
      estimated: true,
      capturedAt: aggregate?.captured_at || null,
      planCreditsUsed: normalizedPlanCreditsUsed,
      planEntitlement: Number.isFinite(planEntitlement) ? planEntitlement : null,
      planMonthlyPercentUsed,
      premiumCreditsUsed: normalizedPremiumCreditsUsed,
      premiumRequestEstimate: Number.isFinite(premiumRequestCount) ? Math.max(0, Math.trunc(premiumRequestCount)) : null,
    };
  }

  // GET /api/conversations — list all conversations
  app.get('/api/conversations', auth, (req, res) => {
    // `archived=true` lists both, `archived=only` the archived ones (the
    // sidebar's Archived view), nothing: the live ones.
    const archivedMode = String(req.query.archived || '').trim().toLowerCase();
    const limit = normalizeConversationListLimit(req.query.limit, DEFAULT_CONVERSATION_LIST_LIMIT);
    const beforeConversationId = String(req.query.beforeConversationId || '').trim();
    const beforeUpdatedAt = String(req.query.beforeUpdatedAt || '').trim();
    const beforeGroupId = String(req.query.beforeGroupId || '').trim();
    const rows = stmts.listConvs.all(archivedMode === 'true' ? 1 : 0, archivedMode === 'only' ? 1 : 0);
    // The groups of the listed rows: the order inside a group needs its head.
    const groups = conversationGroups?.listGroupsByIds?.(rows.map((row) => row?.group_id)) || new Map();
    // The time a row sorts by (its group's newest row): a caller that pages
    // by a row that is gone by then continues from this, not the row's own.
    const activityTimes = groupActivityTimes(rows);
    const page = selectConversationListPage(rows, {
      limit,
      beforeConversationId,
      beforeUpdatedAt,
      beforeGroupId,
      groups,
    });
    const activeTurnConversationIds = new Set(
      (stmts.listConversationIdsWithActiveQueue?.all() || [])
        .map((row) => String(row?.conversation_id || '').trim())
        .filter(Boolean),
    );
    const busyCandidates = sessionActivityTracker ? activityCandidates(activeTurnConversationIds) : null;
    const conversations = page.rows.map((r) => {
      const sid = String(r.sdk_session_id || '').trim();
      const workspaceState = typeof resolveConversationWorkspaceState === 'function'
        ? resolveConversationWorkspaceState({
          conversationId: r.id,
          sdkSessionId: sid,
          discoveredWorkspaceRootPath: '',
        })
        : null;
      const preferences = resolveConversationPreferences(r, {
        supportedRelayModes: SUPPORTED_RELAY_MODES,
        defaultRelayMode: DEFAULT_RELAY_MODE,
      });
      return {
        id:           r.id,
        sdkSessionId: sid || null,
        title:        resolveConversationTitle({ title: r.title, titleSource: r.title_source }),
        activeTurn:   activeTurnConversationIds.has(String(r.id || '').trim()),
        ...(describeSessionActivity(r.id, busyCandidates) || {}),
        archived:     Number(r.archived || 0) === 1,
        compactedInto: r.compacted_into || null,
        compactedFrom: r.compacted_from || null,
        runtimeSessionId: r.runtime_session_id || null,
        runtimeSessionStrategy: r.runtime_strategy || null,
        runtimeSessionStatus: r.runtime_status || null,
        runtimeSessionLastUsedAt: r.runtime_last_used_at || null,
        runtimeModel: r.runtime_model || null,
        runtimeProviderType: String(r.runtime_provider_type || 'github').trim().toLowerCase() || 'github',
        runtimeProviderModel: r.runtime_provider_model || null,
        configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
        createdAt:    normalizeConversationTimestampIso(r.created_at, r.created_at),
        updatedAt:    normalizeConversationTimestampIso(r.updated_at, r.updated_at),
        messageCount: Number(r.message_count || 0),
        preferredRelayMode: preferences.preferredRelayMode,
        preferredModel: preferences.preferredModel,
        preferredReasoningEffort: preferences.preferredReasoningEffort,
        draftText: String(r.draft_text || ''),
        draftAttachments: parseDraftAttachmentsColumn(r.draft_attachments),
        draftUpdatedAt: r.draft_updated_at || null,
        draftUpdatedByClientId: r.draft_updated_by_client_id || null,
        // Set on conversations another relay's agent created ("via <relay>").
        origin: parseRemoteRelayOriginJson(r.origin_json),
        // The owner let this agent-started session's agents start sessions.
        mayCreateSessions: readMayCreateSessions(r),
        planOnly: readPlanOnly(r),
        // Set on Claude Cloud conversations: repository, branch, session link.
        cloud: buildConversationCloudPayload({
          cloudSourceJson: r.cloud_source_json,
          costUsd: r.runtime_claude_cloud_cost_usd,
        }),
        // Session group: its id and whether this row is the group's head.
        groupId: groups.has(String(r.group_id || '')) ? String(r.group_id) : null,
        groupRole: groups.has(String(r.group_id || '')) ? conversationGroupRole({ id: r.id, groupId: r.group_id }, groups) : null,
        // Its place in the group's hand order; null for the head, for a
        // group nobody reordered, and outside a group.
        groupPosition: groups.has(String(r.group_id || '')) ? conversationGroupPosition(r) : null,
        activityAt: (() => {
          const own = normalizeConversationTimestampMs(r.updated_at);
          const ms = groups.has(String(r.group_id || '')) ? Math.max(activityTimes.get(String(r.group_id)) || 0, own) : own;
          return ms ? new Date(ms).toISOString() : normalizeConversationTimestampIso(r.updated_at, r.updated_at);
        })(),
      };
    });
    // The groups that have a row on this page, with what the sidebar's head
    // row shows without the members' rows.
    const groupsPayload = {};
    for (const groupId of new Set(page.rows.map((row) => String(row?.group_id || '')).filter((id) => groups.has(id)))) {
      groupsPayload[groupId] = groupSummaryPayload(groups.get(groupId));
    }
    // The owner's groups an agent emptied have no row to come with: the live
    // list's first page brings them, so the sidebar shows them as empty
    // groups the owner can rename or dissolve.
    if (archivedMode !== 'only' && !beforeConversationId) {
      for (const group of conversationGroups?.listKeptEmptyGroups?.() || []) {
        groupsPayload[group.id] = groupSummaryPayload(group);
      }
    }

    return res.json({
      conversations,
      pageInfo: page.pageInfo,
      groups: groupsPayload,
    });
  });

  app.get('/api/sessions', auth, (req, res) => {
    const sessions = stmts.listRuntimeSessions.all().map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      conversationTitle: row.conversation_title || row.conversation_id,
      strategy: row.strategy || null,
      runtimeKey: row.runtime_key || null,
      model: row.model || null,
      status: row.status || null,
      createdAt: row.created_at || null,
      lastUsedAt: row.last_used_at || null,
      conversationUpdatedAt: row.conversation_updated_at || null,
    }));
    res.json({ sessions });
  });

  /**
   * Resolve the context payload for a conversation id or sdk_session_id.
   *
   * Claude sessions are served from the breakdown their worker reported after
   * the last turn; tailing Copilot's events.jsonl can only ever fail for them.
   * Both providers get the same `contextUsage` view so one renderer serves both.
   */
  function resolveContextPayload(lookupId) {
    // Prefer canonical sdk_session_id routing when available; keep conversation-id lookup for compatibility.
    const runtimeSessionBySdkSessionId = stmts.getRuntimeSessionBySdkSessionId.get(lookupId) || null;
    const runtimeSession = runtimeSessionBySdkSessionId
      || stmts.getRuntimeSessionByConversation.get(lookupId)
      || null;
    const copilotSessionId = String(runtimeSessionBySdkSessionId?.sdk_session_id || runtimeSession?.sdk_session_id || '').trim() || null;
    const providerType = String(runtimeSession?.provider_type || 'github').trim().toLowerCase();
    // The cursor and grok workers post the same Claude-shaped usage blob, and
    // so does the Claude Cloud worker (the cloud session's context and token
    // usage), and so does the DeepSeek worker (the Claude one, pointed at
    // DeepSeek), and so does the Claude API one (the Claude worker on an API
    // key), so all six providers share the stored reader.
    const usesStoredContextUsage = providerType === 'claude' || providerType === 'cursor'
      || providerType === 'grok' || providerType === 'claude-cloud' || providerType === 'deepseek'
      || providerType === 'claude-api';

    const parsed = usesStoredContextUsage
      ? (() => {
        const stored = readStoredClaudeContextUsage(runtimeSession);
        return {
          snapshot: stored.snapshot,
          contextUsage: stored.contextUsage,
          modelContextLimit: stored.modelContextLimit,
          eventsPath: null,
          error: stored.snapshot
            ? null
            : 'No context data captured yet for this session; it is recorded when a turn completes.',
        };
      })()
      : {
        ...readContextFromSessionEvents(
          runtimeSession?.id || null,
          copilotSessionId || runtimeSession?.runtime_key || runtimeSession?.id || null,
        ),
        contextUsage: null,
      };

    // The modal renders the stored preference next to the measured threshold,
    // so both come from this one fetch. The lookup id may be an sdk_session_id.
    const conversationRow = resolveConversationByIdOrSdkSessionId(
      String(runtimeSession?.conversation_id || '').trim() || lookupId,
    );
    const autoCompactWindow = parseAutoCompactWindow(conversationRow?.auto_compact_window);
    // Only the local Claude worker (and the DeepSeek and Claude API ones, the
    // same runner) runs a CLI whose window the slider sets; it reports that
    // CLI on its heartbeat's steering snapshot.
    const windowStatus = resolveAutoCompactWindowStatus({
      storedWindow: autoCompactWindow,
      steering: (providerType === 'claude' || providerType === 'deepseek' || providerType === 'claude-api') && copilotSessionId
        ? sessionWorkerRegistry?.getWorker?.(copilotSessionId)?.steering || null
        : null,
    });

    return {
      conversationId: lookupId,
      // The lookup id above may be an sdk_session_id (that echo is load-bearing
      // for the modal's refresh handle), so the id a preferences PATCH needs is
      // reported separately.
      resolvedConversationId: conversationRow?.id || null,
      autoCompactWindow,
      activeAutoCompactWindow: windowStatus.activeAutoCompactWindow,
      autoCompactWindowDeferred: windowStatus.autoCompactWindowDeferred,
      modelContextLimit: parsed.modelContextLimit ?? null,
      thinkingEnabled: parseThinkingEnabled(conversationRow?.thinking_enabled),
      thinkingDisplay: parseThinkingDisplay(conversationRow?.thinking_display),
      // What this folder's Claude commits say (the 🧠 modal's override row).
      // A Claude Cloud chat has the row when it was started from a folder,
      // with its own model in the example.
      ...(providerType === 'claude' || providerType === 'claude-api'
        ? { attribution: workspaceRootAttributionFor(conversationRow) }
        : {}),
      ...(providerType === 'claude-cloud' && cloudConversationFolder(conversationRow)
        ? {
          attribution: workspaceRootAttributionFor(conversationRow, '', {
            model: runtimeSession?.provider_model || runtimeSession?.model || '',
          }),
        }
        : {}),
      runtimeSessionId: runtimeSession?.id || null,
      copilotSessionId,
      providerType: usesStoredContextUsage ? providerType : 'github',
      snapshot: parsed.snapshot || null,
      contextUsage: buildContextUsageView({
        snapshot: parsed.snapshot,
        contextUsage: parsed.contextUsage,
      }),
      eventsPath: parsed.eventsPath || null,
      error: parsed.error || null,
      text: buildContextResponseText({
        snapshot: parsed.snapshot,
        runtimeSession,
        conversationId: lookupId,
        eventsPath: parsed.eventsPath,
        error: parsed.error,
      }),
    };
  }

  // --- Per-folder commit attribution (shared/claude-attribution.mjs) -----
  function workspaceRootSettingsRow(rootPath) {
    const root = String(rootPath || '').trim();
    if (!root || typeof stmts?.getWorkspaceRootSettings?.get !== 'function') return null;
    try {
      return stmts.getWorkspaceRootSettings.get(normalizeWorkspaceRootKey(root)) || null;
    } catch {
      return null;
    }
  }

  /** The folder a Claude Cloud chat was started from, if it was started from one. */
  function cloudConversationFolder(conversationRow) {
    return String(conversationRow?.runtime_workspace_root_path || conversationRow?.configured_workspace_root_path || '').trim();
  }

  function workspaceRootAttributionFor(conversationRow, explicitPath = '', { model = '' } = {}) {
    const path = String(explicitPath
      || conversationRow?.runtime_workspace_root_path
      || conversationRow?.configured_workspace_root_path
      || '').trim();
    const provider = typeof getClaudeProviderSettings === 'function' ? getClaudeProviderSettings() : {};
    return buildWorkspaceRootAttributionPayload({
      path,
      folderMode: workspaceRootSettingsRow(path)?.attribution_mode || null,
      providerMode: provider?.attributionMode,
      model: String(model || '').trim() || provider?.model,
    });
  }

  app.get('/api/workspace-root/attribution', auth, (req, res) => {
    const path = String(req.query.path || '').trim();
    if (!path) return res.status(400).json({ error: 'Missing path' });
    res.json({ ok: true, ...workspaceRootAttributionFor(null, path) });
  });

  app.post('/api/workspace-root/attribution', auth, (req, res) => {
    const parsed = parseWorkspaceRootAttributionUpdate(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (typeof stmts?.upsertWorkspaceRootAttribution?.run !== 'function') {
      return res.status(503).json({ error: 'Folder settings are unavailable' });
    }
    const key = normalizeWorkspaceRootKey(parsed.path);
    const now = new Date().toISOString();
    if (parsed.attributionMode === null) {
      stmts.deleteWorkspaceRootSettings.run(key);
    } else {
      stmts.upsertWorkspaceRootAttribution.run(key, parsed.path, parsed.attributionMode, now);
    }
    const payload = workspaceRootAttributionFor(null, parsed.path);
    try { io.emit('workspace_root_attribution_updated', payload); } catch {}
    res.json({ ok: true, ...payload });
  });

  app.get('/api/context/:conversationId', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    res.json(resolveContextPayload(conversationId));
  });

  app.get('/api/context', auth, (req, res) => {
    const explicitConversationId = String(req.query.conversationId || '').trim();
    if (explicitConversationId) {
      return res.json(resolveContextPayload(explicitConversationId));
    }
    return res.json({
      conversationId: null,
      runtimeSessionId: null,
      snapshot: null,
      contextUsage: null,
      eventsPath: null,
      error: 'Missing conversationId query parameter',
      text: 'Context is unavailable until a conversation is selected.',
    });
  });

  // GET /api/search/messages — search text across all conversation messages
  app.get('/api/search/messages', auth, (req, res) => {
    const rawQuery = String(req.query.q || '').trim();
    const limit = normalizeMessageSearchLimit(req.query.limit, 30);
    const offset = normalizeMessageSearchOffset(req.query.offset);
    if (!rawQuery || rawQuery.length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }
    const matchQuery = buildMessageSearchMatchQuery(rawQuery);
    if (!matchQuery) {
      return res.status(400).json({ error: 'Search query is empty' });
    }
    const total = Number(stmts.searchMessagesCount.get(matchQuery)?.cnt || 0);
    const rows = stmts.searchMessagesPage.all(matchQuery, limit, offset);
    const results = rows.map((row) => ({
      conversationId: String(row?.conversation_id || '').trim(),
      conversationTitle: String(row?.conversation_title || '').trim() || 'Conversation',
      messageId: String(row?.message_id || '').trim(),
      role: String(row?.role || '').trim(),
      timestamp: String(row?.timestamp || '').trim() || null,
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : null,
      snippet: String(row?.snippet || '').trim() || String(row?.raw_text || '').trim().slice(0, 240),
    })).filter((item) => item.conversationId && item.messageId);
    const hasMore = (offset + results.length) < total;
    return res.json({
      query: rawQuery,
      results,
      pageInfo: {
        limit,
        offset,
        total,
        hasMore,
        nextOffset: hasMore ? (offset + results.length) : null,
      },
    });
  });

  // POST /api/conversation/:id/refresh-history — clear retrievable history and rebuild from SDK events
  app.post('/api/conversation/:id/refresh-history', auth, async (req, res) => {
    const requestedId = String(req.params.id || '').trim();
    const limit = normalizeConversationHistoryLimit(req.query.limit, 20);
    const beforeMessageId = String(req.query.beforeMessageId || '').trim();
    const beforeTimestamp = String(req.query.beforeTimestamp || '').trim();
    const afterMessageId = String(req.query.afterMessageId || '').trim();
    const afterTimestamp = String(req.query.afterTimestamp || '').trim();
    const aroundMessageId = String(req.query.aroundMessageId || '').trim();
    if (stmts.getDeletedSdkSession.get(requestedId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const existingConversation = resolveConversationByIdOrSdkSessionId(requestedId);
    if (!existingConversation) return res.status(404).json({ error: 'Conversation not found' });
    const conversationId = String(existingConversation.id).trim();
    const sdkSessionId = String(existingConversation.sdk_session_id || requestedId).trim();

    const idleState = sessionHistoryRefreshService.evaluateRefreshIdleState(conversationId);
    if (!idleState?.idle) {
      return res.status(409).json({
        error: 'Conversation is busy',
        code: String(idleState?.reason || 'conversation-busy'),
      });
    }

    try {
      const result = await sdkSessionImportService.refreshConversation(existingConversation);
      if (result.status === 'failed') throw new Error(result.error || 'Failed to refresh conversation history');
      if (result.status !== 'completed') {
        // Each skip gets its precise cause; the old blanket "already in
        // progress" told users a relay-owned conversation was merely busy and
        // to try again (audit #19).
        const skip = result.category === 'relay-owned'
          ? { statusCode: 409, code: 'relay-owned', message: 'Conversation history is owned by the relay and cannot be re-imported' }
          : result.category === 'bound-elsewhere'
            ? { statusCode: 409, code: 'bound-elsewhere', message: 'SDK session is bound to another conversation' }
            : result.reason === 'tombstoned'
              ? { statusCode: 404, code: 'not-found', message: 'Conversation not found' }
              : result.reason === 'importer-closing'
                ? { statusCode: 503, code: 'shutting-down', message: 'Relay is shutting down' }
                : { statusCode: 409, code: 'refresh-in-progress', message: 'Conversation history refresh is already in progress' };
        const error = new Error(skip.message);
        error.statusCode = skip.statusCode;
        error.code = skip.code;
        throw error;
      }
    } catch (error) {
      return res.status(error?.statusCode || 500).json({
        error: error?.message || 'Failed to refresh conversation history',
        ...(error?.code ? { code: error.code } : {}),
      });
    }

    const conv = stmts.getConv.get(conversationId);
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId) || null;
    const resolvedTitle = resolveConversationTitle({
      title: conv.title,
      titleSource: conv.title_source,
    });
    const preferences = resolveConversationPreferences(conv, {
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      defaultRelayMode: DEFAULT_RELAY_MODE,
    });
    const inFlight = inFlightStateForConversation(conversationId);
    const sessionUsageSummary = resolveSessionUsageSummaryForSdkSession({
      sdkSessionId,
      conversationId,
    });
    const workspaceState = typeof resolveConversationWorkspaceState === 'function'
      ? resolveConversationWorkspaceState({
        conversationId,
        sdkSessionId: conv.sdk_session_id || conversationId,
        discoveredWorkspaceRootPath: '',
      })
      : null;
    const sessionRoot = buildConversationSessionRootPayload({
      conversationId,
      sdkSessionId: conv.sdk_session_id || conversationId,
      title: resolvedTitle,
      resolveSessionStateRoot,
      providerType: runtimeSession?.provider_type || '',
      claudeNativeSessionId: runtimeSession?.claude_native_session_id || '',
      workspaceRootPath: workspaceState?.currentWorkspaceRootPath || '',
      resolveClaudeSessionRoot,
      resolveDeepSeekSessionRoot,
      resolveCursorSessionRoot,
    });
    const dbMessages = stmts.getMessages.all(conversationId);
    const queueRows = db.prepare(`
      SELECT id, response_message_id, text, timestamp, retry_count, reasoning_effort, model, status
      FROM queue
      WHERE conversation_id = ?
    `).all(conversationId);
    const responseMessageToSourceId = new Map(
      queueRows
        .map((row) => [String(row?.response_message_id || '').trim(), String(row?.id || '').trim()])
        .filter(([responseMessageId, sourceMessageId]) => !!responseMessageId && !!sourceMessageId),
    );
    const relayActivitiesByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, relayActivityForResponse(m.id)]),
    );
    const relayThoughtsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, relayThoughtsForResponse ? relayThoughtsForResponse(m.id) : []]),
    );
    const subagentRunsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, subagentRunsForResponse ? subagentRunsForResponse(m.id) : []]),
    );
    const workflowRunsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, workflowRunsForResponse ? workflowRunsForResponse(m.id) : []]),
    );
    const previewCardsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, previewCardsForResponse ? previewCardsForResponse(m.id) : []]),
    );
    const usageByResponseMessageId = new Map(
      (stmts.listMessageUsageSnapshotsByConversation?.all(conversationId) || [])
        .map((row) => [String(row?.response_message_id || '').trim(), mapUsageSnapshotRow(row)])
        .filter(([messageId, usage]) => !!messageId && !!usage),
    );
    let messages = buildConversationMessages({
      dbMessages: dbMessages.map((message) => ({
        ...message,
        attachments: parseAttachments(message.attachments).map(hydrateAttachment).filter(Boolean),
      })),
      transcriptMessages: [],
      relayActivitiesByMessageId,
      relayThoughtsByMessageId,
      subagentRunsByMessageId,
      workflowRunsByMessageId,
      previewCardsByMessageId,
      responseMessageToSourceId,
      queueRows,
      usageByResponseMessageId,
    });
    messages = messages.map((message) => {
      if (message.role !== 'assistant') return message;
      const sourceMessageId = responseMessageToSourceId.get(String(message.id || '').trim()) || message.sourceMessageId || undefined;
      return sourceMessageId ? { ...message, sourceMessageId } : message;
    });
    const history = selectConversationHistoryPage(messages, {
      limit,
      beforeMessageId,
      beforeTimestamp,
      afterMessageId,
      afterTimestamp,
      aroundMessageId,
    });
    return res.json({
      id: conv.id,
      sdkSessionId: conv.sdk_session_id || null,
      title: resolvedTitle,
      sessionRootPath: sessionRoot?.sessionRootPath || null,
      sessionRootName: sessionRoot?.sessionRootName || resolvedTitle || 'Session',
      configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: runtimeSession ? {
        id: runtimeSession.id,
        sdkSessionId: runtimeSession.sdk_session_id || conv.sdk_session_id || conv.id,
        strategy: runtimeSession.strategy || null,
        status: runtimeSession.status || null,
        model: runtimeSession.model || null,
        providerType: String(runtimeSession.provider_type || 'github').trim().toLowerCase() || 'github',
        providerModel: runtimeSession.provider_model || null,
        createdAt: runtimeSession.created_at || null,
        lastUsedAt: runtimeSession.last_used_at || null,
      } : null,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      sessionUsageSummary,
      inFlight,
      preferredRelayMode: preferences.preferredRelayMode,
      preferredModel: preferences.preferredModel,
      preferredReasoningEffort: preferences.preferredReasoningEffort,
      draftText: String(conv.draft_text || ''),
      draftAttachments: parseDraftAttachmentsColumn(conv.draft_attachments),
      draftUpdatedAt: conv.draft_updated_at || null,
      draftUpdatedByClientId: conv.draft_updated_by_client_id || null,
      origin: parseRemoteRelayOriginJson(conv.origin_json),
      mayCreateSessions: readMayCreateSessions(conv),
      planOnly: readPlanOnly(conv),
      cloud: conversationCloudPayload(conv, runtimeSession),
      group: conversationGroupPayload(conversationId),
      groupPosition: conversationGroupPositionOf(conv),
      messages: history.messages,
      pageInfo: history.pageInfo,
      // A re-import can move a pin onto a new message id.
      pins: listConversationPins(conversationId),
      pinsRevision: conversationPinRevision(conversationId),
      // And a hidden mark.
      hiddenMessages: listConversationHiddenMessages(conversationId),
      hiddenMessagesRevision: conversationHiddenMessagesRevision(conversationId),
      refreshed: true,
    });
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
    buildConversationMessages,
    selectConversationHistoryPage,
    resolveConversationTitle,
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

  // GET /api/conversation/:id — get paginated conversation history
  // The details version of each finished reply (held-details.mjs), one query
  // per table for the whole window (the ids go in as one JSON parameter).
  // Tool rows are only inserted: their count and highest row id. Thought rows
  // are updated in place as they stream and when done: their rows are read
  // (id, done, text) and fingerprinted, so any change shows.
  let detailsVersionStatements = null;
  function relayDetailsVersions(messageIds) {
    const ids = [...new Set(messageIds.filter(Boolean))];
    const versions = new Map();
    if (!ids.length || typeof db?.prepare !== 'function') return versions;
    try {
      detailsVersionStatements ||= {
        activity: db.prepare(`
          SELECT response_message_id AS id, COUNT(*) AS n, MAX(rowid) AS max_rowid
          FROM relay_activity
          WHERE response_message_id IN (SELECT value FROM json_each(?))
          GROUP BY response_message_id
        `),
        thought: db.prepare(`
          SELECT response_message_id AS response_id, rowid AS row_id, done, text
          FROM relay_thought
          WHERE response_message_id IN (SELECT value FROM json_each(?))
        `),
      };
      const idsJson = JSON.stringify(ids);
      const activity = new Map();
      for (const row of detailsVersionStatements.activity.all(idsJson) || []) {
        activity.set(String(row?.id || ''), { n: Number(row.n) || 0, max: Number(row.max_rowid) || 0 });
      }
      const thoughtRows = new Map();
      for (const row of detailsVersionStatements.thought.all(idsJson) || []) {
        const id = String(row?.response_id || '');
        if (!thoughtRows.has(id)) thoughtRows.set(id, []);
        thoughtRows.get(id).push({ rowid: row.row_id, done: row.done, text: row.text });
      }
      for (const id of ids) {
        const tools = activity.get(id) || { n: 0, max: 0 };
        const thoughts = thoughtRows.get(id) || [];
        versions.set(id, detailsVersion({
          activityCount: tools.n,
          activityMaxRowId: tools.max,
          thoughtCount: thoughts.length,
          thoughtMaxRowId: thoughts.reduce((max, row) => Math.max(max, Number(row.rowid) || 0), 0),
          thoughtHash: thoughtFingerprint(thoughts),
        }));
      }
    } catch {
      // No versions: nothing is held, everything goes out in full.
      return new Map();
    }
    return versions;
  }

  app.get('/api/conversation/:id', auth, (req, res) => {
    const requestedId = String(req.params.id || '').trim();
    const limit = normalizeConversationHistoryLimit(req.query.limit, 20);
    const beforeMessageId = String(req.query.beforeMessageId || '').trim();
    const beforeTimestamp = String(req.query.beforeTimestamp || '').trim();
    const afterMessageId = String(req.query.afterMessageId || '').trim();
    const afterTimestamp = String(req.query.afterTimestamp || '').trim();
    const aroundMessageId = String(req.query.aroundMessageId || '').trim();
    if (stmts.getDeletedSdkSession.get(requestedId)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const conv = resolveConversationByIdOrSdkSessionId(requestedId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const resolvedConversationId = String(conv.id || '').trim() || requestedId;
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(resolvedConversationId) || null;
    const resolvedTitle = resolveConversationTitle({
      title: conv.title,
      titleSource: conv.title_source,
    });
    const preferences = resolveConversationPreferences(conv, {
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      defaultRelayMode: DEFAULT_RELAY_MODE,
    });
    // The running turn's tool lines: as many per thread as this page shows
    // (its "Tool lines shown" setting); none given, the relay's default.
    const inFlight = inFlightStateForConversation(resolvedConversationId, { activityCap: req.query.activityCap });
    const sdkSessionId = String(conv.sdk_session_id || resolvedConversationId || '').trim();
    const sessionUsageSummary = resolveSessionUsageSummaryForSdkSession({
      sdkSessionId,
      conversationId: resolvedConversationId,
    });
    const workspaceState = typeof resolveConversationWorkspaceState === 'function'
      ? resolveConversationWorkspaceState({
        conversationId: resolvedConversationId,
        sdkSessionId: conv.sdk_session_id || resolvedConversationId,
        discoveredWorkspaceRootPath: '',
      })
      : null;
    const sessionRoot = buildConversationSessionRootPayload({
      conversationId: resolvedConversationId,
      sdkSessionId: conv.sdk_session_id || resolvedConversationId,
      title: resolvedTitle,
      resolveSessionStateRoot,
      providerType: runtimeSession?.provider_type || '',
      claudeNativeSessionId: runtimeSession?.claude_native_session_id || '',
      workspaceRootPath: workspaceState?.currentWorkspaceRootPath || '',
      resolveClaudeSessionRoot,
      resolveDeepSeekSessionRoot,
      resolveCursorSessionRoot,
    });
    const historyCursor = { limit, beforeMessageId, beforeTimestamp, afterMessageId, afterTimestamp, aroundMessageId };
    // The page's rows only: every later lookup is per page, not per conversation.
    const sqlPage = selectConversationHistoryPageRows(resolvedConversationId, historyCursor);
    const dbMessages = sqlPage ? sqlPage.rows : stmts.getMessages.all(resolvedConversationId);
    const queueRows = db.prepare(`
      SELECT id, response_message_id, text, timestamp, retry_count, reasoning_effort, model, status
      FROM queue
      WHERE conversation_id = ?
    `).all(resolvedConversationId);
    const responseMessageToSourceId = new Map(
      queueRows
        .map((row) => [String(row?.response_message_id || '').trim(), String(row?.id || '').trim()])
        .filter(([responseMessageId, sourceMessageId]) => !!responseMessageId && !!sourceMessageId),
    );
    // The live poll names the finished replies whose tool lines and thoughts
    // it holds (`heldDetails`, held-details.mjs); those whose details have
    // not changed since (the same `detailsVersion`) go out without them.
    const assistantIds = dbMessages.filter((m) => m.role === 'assistant').map((m) => String(m.id));
    const detailsVersions = relayDetailsVersions(assistantIds);
    const heldParam = parseHeldDetailsParam(req.query.heldDetails);
    const heldNow = new Set(heldParam
      ? assistantIds.filter((id) => heldParam.get(id) === detailsVersions.get(id))
      : []);
    const relayActivitiesByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant' && !heldNow.has(String(m.id)))
        .map((m) => [m.id, relayActivityForResponse(m.id)]),
    );
    const relayThoughtsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant' && !heldNow.has(String(m.id)))
        .map((m) => [m.id, relayThoughtsForResponse ? relayThoughtsForResponse(m.id) : []]),
    );
    const subagentRunsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, subagentRunsForResponse ? subagentRunsForResponse(m.id) : []]),
    );
    const workflowRunsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, workflowRunsForResponse ? workflowRunsForResponse(m.id) : []]),
    );
    const previewCardsByMessageId = new Map(
      dbMessages
        .filter((m) => m.role === 'assistant')
        .map((m) => [m.id, previewCardsForResponse ? previewCardsForResponse(m.id) : []]),
    );
    const usageByResponseMessageId = sqlPage ? usageSnapshotsForPage(conv.id, dbMessages) : new Map(
      (stmts.listMessageUsageSnapshotsByConversation?.all(conv.id) || [])
        .map((row) => [String(row?.response_message_id || '').trim(), mapUsageSnapshotRow(row)])
        .filter(([messageId, usage]) => !!messageId && !!usage),
    );
    let messages = buildConversationMessages({
      dbMessages: dbMessages.map((message) => ({
        ...message,
        attachments: parseAttachments(message.attachments).map(hydrateAttachment).filter(Boolean),
      })),
      transcriptMessages: [],
      relayActivitiesByMessageId,
      relayThoughtsByMessageId,
      subagentRunsByMessageId,
      workflowRunsByMessageId,
      previewCardsByMessageId,
      responseMessageToSourceId,
      queueRows,
      usageByResponseMessageId,
      resendIndexMessages: sqlPage ? resendIndexForPage(resolvedConversationId, dbMessages, { sharedOnly: false }) : null,
    });
    messages = messages.map((message) => {
      if (message.role !== 'assistant') return message;
      const id = String(message.id || '').trim();
      const sourceMessageId = responseMessageToSourceId.get(id) || message.sourceMessageId || undefined;
      // Held: the page fills these from what it has. Otherwise the version
      // the page keeps with them.
      const details = heldNow.has(id)
        ? { activities: [], thoughts: [], detailsHeld: true }
        : (detailsVersions.has(id) ? { detailsVersion: detailsVersions.get(id) } : {});
      return { ...message, ...(sourceMessageId ? { sourceMessageId } : {}), ...details };
    });
    const history = sqlPage
      ? { messages, pageInfo: sqlPage.pageInfo }
      : selectConversationHistoryPage(messages, historyCursor);
    res.json({
      id: conv.id,
      sdkSessionId: conv.sdk_session_id || null,
      title: resolvedTitle,
      sessionRootPath: sessionRoot?.sessionRootPath || null,
      sessionRootName: sessionRoot?.sessionRootName || resolvedTitle || 'Session',
      configuredWorkspaceRootPath: workspaceState?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: workspaceState?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: workspaceState?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: workspaceState?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: workspaceState?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: workspaceState?.currentWorkspaceRootName || null,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: runtimeSession ? {
        id: runtimeSession.id,
        sdkSessionId: runtimeSession.sdk_session_id || conv.sdk_session_id || null,
        strategy: runtimeSession.strategy || null,
        status: runtimeSession.status || null,
        model: runtimeSession.model || null,
        providerType: String(runtimeSession.provider_type || 'github').trim().toLowerCase() || 'github',
        providerModel: runtimeSession.provider_model || null,
        createdAt: runtimeSession.created_at || null,
        lastUsedAt: runtimeSession.last_used_at || null,
      } : null,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      sessionUsageSummary,
      inFlight,
      // A queued (pending/parked) row counts too: inFlight covers only the
      // processing one. Another relay's agent tells "still queued" from
      // "cancelled" with it.
      activeTurn: Number(stmts.getConversationActiveQueueCount?.get?.(resolvedConversationId)?.count || 0) > 0,
      ...(describeSessionActivity(resolvedConversationId) || {}),
      // The published set, else the placeholder for background work a live
      // worker reports without this runtime knowing its details.
      // Each with the health poller's last reading (`health`); the tasks
      // that ended within the hour with a console beside them.
      backgroundTasks: (() => {
        const taskKeys = [resolvedConversationId, runtimeSession?.sdk_session_id];
        const tasks = backgroundWorkView
          ? backgroundWorkView.panelTasks(...taskKeys)
          : (backgroundTaskStore?.get?.(resolvedConversationId) || []);
        return backgroundTaskStore?.withHealth ? backgroundTaskStore.withHealth(tasks, ...taskKeys) : tasks;
      })(),
      endedBackgroundTasks: backgroundTaskStore?.ended?.(resolvedConversationId, runtimeSession?.sdk_session_id) || [],
      // Minutes without output after which the panel calls a task quiet.
      taskStallMinutes: (() => {
        try { return getTaskStallMinutes(); } catch { return DEFAULT_TASK_STALL_MINUTES; }
      })(),
      usageLimitPause: usageLimitPauseService?.getPause?.(resolvedConversationId) || null,
      // A Claude chat's billing (subscription or API key) and whether the
      // composer's toggle may switch it now, with the reason when not.
      billing: claudeBillingSwitchService?.billingState?.(resolvedConversationId) || null,
      previews: listConversationPreviews?.(resolvedConversationId) || [],
      // Every pin of the conversation, also those outside this history page.
      pins: listConversationPins(resolvedConversationId),
      pinsRevision: conversationPinRevision(resolvedConversationId),
      // Every message hidden from shared viewers, also those outside the page.
      hiddenMessages: listConversationHiddenMessages(resolvedConversationId),
      hiddenMessagesRevision: conversationHiddenMessagesRevision(resolvedConversationId),
      preferredRelayMode: preferences.preferredRelayMode,
      preferredModel: preferences.preferredModel,
      preferredReasoningEffort: preferences.preferredReasoningEffort,
      draftText: String(conv.draft_text || ''),
      draftAttachments: parseDraftAttachmentsColumn(conv.draft_attachments),
      draftUpdatedAt: conv.draft_updated_at || null,
      draftUpdatedByClientId: conv.draft_updated_by_client_id || null,
      // Set on conversations another relay's agent created ("via <relay>").
      origin: parseRemoteRelayOriginJson(conv.origin_json),
      mayCreateSessions: readMayCreateSessions(conv),
      planOnly: readPlanOnly(conv),
      // Set on Claude Cloud conversations: repository, branch, session link.
      cloud: conversationCloudPayload(conv, runtimeSession),
      // The session group it is in, with the other members; null when none.
      group: conversationGroupPayload(resolvedConversationId, req),
      // Its place in the group's hand order, as on the list rows.
      groupPosition: conversationGroupPositionOf(conv),
      // Generated images with their file on this relay and their size, for
      // this page's rows only (agents on other relays name the files).
      messages: withGeneratedImageFiles(history.messages, { resolveSessionStateRoot }),
      pageInfo: history.pageInfo,
    });
  });

  // Pin or unpin one message. Unlike share visibility this may change while
  // the message's turn runs (nothing public depends on it), and every open
  // client learns of it through the socket instead of reloading.
  app.patch('/api/conversation/:id/message/:messageId/pin', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const messageId = String(req.params.messageId || '').trim();
    if (!conversationId || !messageId) {
      return res.status(400).json({ error: 'Missing conversation or message id' });
    }
    if (typeof req.body?.pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }

    const conv = stmts.getConvAnyStatus.get(conversationId);
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const message = stmts.getMessageByConversation?.get(messageId, conversationId) || null;
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (!stmts.setMessagePinnedAt || !stmts.countPinnedMessages) {
      return res.status(503).json({ error: 'Pinning messages is unavailable until the relay restarts' });
    }

    const pinned = req.body.pinned === true;
    const currentlyPinned = !!message.pinned_at;
    if (currentlyPinned !== pinned) {
      if (pinned && Number(stmts.countPinnedMessages.get(conversationId)?.cnt || 0) >= MESSAGE_PIN_LIMIT) {
        return res.status(409).json({
          error: `This conversation already has ${MESSAGE_PIN_LIMIT} pinned messages. Unpin one first.`,
          code: 'pin-limit',
          limit: MESSAGE_PIN_LIMIT,
        });
      }
      stmts.setMessagePinnedAt.run(pinned ? new Date().toISOString() : null, messageId, conversationId);
    }

    const pins = listConversationPins(conversationId);
    if (currentlyPinned !== pinned) {
      const revision = bumpConversationPinRevision(conversationId);
      io?.emit?.('conversation_pins_updated', { conversationId, pins, revision });
    }
    return res.json({
      ok: true,
      conversationId,
      messageId,
      pinned,
      pins,
      pinsRevision: conversationPinRevision(conversationId),
    });
  });

  registerConversationSettingsRoutes(app, deps, {
    conversationGroups,
    remoteRelayInbound,
    sessionWorkerStopOverrides,
    workspaceRootAllowList,
    describeSessionActivity,
    resolveConversationByIdOrSdkSessionId,
    consumeWorkspaceRootRateLimit,
    emitGroupChanged,
    listGroupsForAgents,
    bootstrapGroupRefusal,
    conversationGroupField,
    copilotImageModelRefusal,
    isPidAlive,
    launchWorkspaceRootSession,
    stopIdleWorkspaceRootSession,
    normalizeRelayModePreference,
    normalizePreferredModel,
    normalizePreferredReasoningEffort,
    parseDraftAttachmentsColumn,
    resolveConversationTitle,
    normalizeConversationTitle,
    persistConversationTitle,
  });

  registerConversationLifecycleRoutes(app, deps, {
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
    emitGroupChanged,
    listGroupsForAgents,
    bootstrapGroupRefusal,
    conversationGroupField,
    copilotImageModelRefusal,
    normalizeRelayModePreference,
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
    stopIdleWorkspaceRootSession,
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
    isPidAlive,
    SESSION_WORKER_ACTIVE_STATUSES,
  });

  app.post('/api/workspace-root', auth, (req, res) => {
    const nextRootPath = String(req.body?.rootPath || req.body?.workspaceRootPath || '').trim();
    if (!nextRootPath) {
      return res.status(400).json({ error: 'Missing rootPath' });
    }
    if (typeof setWorkspaceRoot !== 'function') {
      return res.status(500).json({ error: 'Workspace root updates are unavailable' });
    }

    const result = setWorkspaceRoot(nextRootPath, { reason: 'manual-ui-change' });
    if (!result?.changed && result?.error) {
      return res.status(400).json({ error: result.error });
    }

    const payload = workspaceRootPayload();
    io.emit('workspace_root_changed', payload);
    return res.json({
      ok: true,
      changed: !!result?.changed,
      ...payload,
    });
  });

  app.post('/api/session-worker/:sdkSessionId/launch', auth, async (req, res) => {
    const sdkSessionId = String(req.params.sdkSessionId || '').trim();
    // Shares the launch path with the CWD relaunch route, so it must share the
    // lock too — otherwise it can interleave between that route's stop and spawn.
    const attempt = await sessionLaunchMutex.tryRunExclusive(
      sdkSessionId,
      () => launchWorkspaceRootSession(runtimeState, sessionWorkerSupervisor, sdkSessionId, sessionWorkerRegistry),
    );
    if (attempt.busy) {
      return res.status(409).json({
        ok: false,
        code: 'relaunch_in_progress',
        error: 'Another launch is already running for this session.',
      });
    }
    const result = attempt.result;
    if (!result?.ok) {
      return res.status(result?.statusCode || 400).json({
        ok: false,
        error: result?.error || 'launch-failed',
        worker: result?.worker || null,
        lifecycle: result?.lifecycle || null,
      });
    }
    return res.json({
      ok: true,
      ...result,
    });
  });

  // Deferred host suspend: the request is queued and fulfilled by the
  // host-suspend service once nothing runs any more (see
  // docs/plans/2026-09-27-deferred-host-suspend.md).
  app.get('/api/host/suspend', auth, (req, res) => {
    if (!hostSuspendService) {
      return res.status(501).json({ ok: false, error: 'Host suspend is unavailable' });
    }
    const state = hostSuspendService.refresh();
    let activity = null;
    if (!state.pending && typeof collectHostActivity === 'function') {
      try {
        activity = collectHostActivity({ request: null });
      } catch (error) {
        activity = { blockers: [], error: String(error?.message || error) };
      }
    }
    return res.json({
      ok: true,
      supported: hostSuspendPlatform === 'win32',
      state,
      blockers: state.pending ? state.blockers : (activity?.blockers || []),
      activity,
    });
  });

  app.post('/api/host/suspend', auth, (req, res) => {
    if (!hostSuspendService) {
      return res.status(501).json({ ok: false, error: 'Host suspend is unavailable' });
    }
    if (hostSuspendPlatform !== 'win32') {
      return res.status(501).json({ ok: false, error: 'Host suspend is only supported on Windows' });
    }
    const reason = String(req.body?.reason || 'manual-suspend').trim().slice(0, 140) || 'manual-suspend';
    const requestedBy = String(req.body?.requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
    const result = hostSuspendService.request({ reason, requestedBy });
    return res.status(202).json({
      ok: true,
      queued: true,
      accepted: result.accepted !== false,
      alreadyPending: !!result.alreadyPending,
      state: result.state,
    });
  });

  app.post('/api/host/suspend/cancel', auth, (req, res) => {
    if (!hostSuspendService) {
      return res.status(501).json({ ok: false, error: 'Host suspend is unavailable' });
    }
    const requestedBy = String(req.body?.requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
    const result = hostSuspendService.cancel({ requestedBy });
    return res.json({ ok: true, cancelled: !!result.cancelled, state: result.state });
  });

  // Turns paused at the Claude usage limit (usage-limit-pause-service): the
  // held follow-up can be sent before the reset, or dropped.
  app.get('/api/usage-limit', auth, (req, res) => {
    if (!usageLimitPauseService) {
      return res.status(501).json({ ok: false, error: 'Usage limit handling is unavailable' });
    }
    return res.json({
      ok: true,
      account: usageLimitPauseService.getAccountState(),
      pauses: usageLimitPauseService.listPauses(),
    });
  });

  app.post('/api/usage-limit/resume', auth, (req, res) => {
    if (!usageLimitPauseService) {
      return res.status(501).json({ ok: false, error: 'Usage limit handling is unavailable' });
    }
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ ok: false, error: 'Missing conversationId' });
    const result = usageLimitPauseService.resumeNow({ conversationId });
    return res.json({ ok: true, resumed: !!result.resumed, messageId: result.messageId || null, pause: result.state });
  });

  app.post('/api/usage-limit/cancel', auth, (req, res) => {
    if (!usageLimitPauseService) {
      return res.status(501).json({ ok: false, error: 'Usage limit handling is unavailable' });
    }
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ ok: false, error: 'Missing conversationId' });
    const result = usageLimitPauseService.cancel({ conversationId });
    return res.json({ ok: true, cancelled: !!result.cancelled, messageId: result.messageId || null, pause: result.state });
  });

  // Each provider tab's switch, "New" tags and fallback warning.
  function modelStateFields(settings) {
    return {
      autoEnableNew: settings?.autoEnableNew !== false,
      unseen: Array.isArray(settings?.unseenModels) ? settings.unseenModels : [],
      fallback: settings?.fallback === true,
    };
  }

  function buildModelVariantCatalogPayloadForRoute() {
    const rows = typeof listModelVariantRows === 'function' ? listModelVariantRows() : [];
    const modelState = getModelCatalogState();
    const openAISettings = getOpenAIProviderSettings();
    const claudeSettings = getClaudeProviderSettings();
    const cursorSettings = getCursorProviderSettings();
    const grokSettings = getGrokProviderSettings();
    const deepseekSettings = getDeepSeekProviderSettings();
    const claudeApiSettings = getClaudeApiProviderSettings();
    return {
      ...buildModelVariantCatalogPayload({
        rows,
        modelState,
        reasoningEfforts: modelState.reasoningEfforts || [],
        contextLimitsByModel: modelState.contextLimitsByModel || {},
        modelMetadataByModel: modelState.modelMetadataByModel || {},
      }),
      copilotModelState: getCopilotModelState(),
      openaiModels: openAISettings?.enabled === true
        ? {
            defaultModel: openAISettings.model,
            availableModels: Array.isArray(openAISettings.availableModels) ? openAISettings.availableModels : [],
            enabledModels: Array.isArray(openAISettings.models) ? openAISettings.models : [],
            ...modelStateFields(openAISettings),
          }
        : null,
      claudeModels: claudeSettings?.enabled === true
        ? {
            defaultModel: claudeSettings.model,
            availableModels: Array.isArray(claudeSettings.availableModels) ? claudeSettings.availableModels : [],
            enabledModels: Array.isArray(claudeSettings.models) ? claudeSettings.models : [],
            ...modelStateFields(claudeSettings),
          }
        : null,
      cursorModels: cursorSettings?.enabled === true
        ? {
            defaultModel: cursorSettings.model,
            availableModels: Array.isArray(cursorSettings.availableModels) ? cursorSettings.availableModels : [],
            enabledModels: Array.isArray(cursorSettings.models) ? cursorSettings.models : [],
            ...modelStateFields(cursorSettings),
          }
        : null,
      grokModels: grokSettings?.enabled === true
        ? {
            defaultModel: grokSettings.model,
            availableModels: Array.isArray(grokSettings.availableModels) ? grokSettings.availableModels : [],
            enabledModels: Array.isArray(grokSettings.models) ? grokSettings.models : [],
            ...modelStateFields(grokSettings),
          }
        : null,
      deepseekModels: deepseekSettings?.enabled === true
        ? {
            defaultModel: deepseekSettings.model,
            availableModels: Array.isArray(deepseekSettings.availableModels) ? deepseekSettings.availableModels : [],
            enabledModels: Array.isArray(deepseekSettings.models) ? deepseekSettings.models : [],
            ...modelStateFields(deepseekSettings),
          }
        : null,
      // The Select Models → Claude API tab: its own list, "[1m]" ids included
      // (the tab shows them as on the Claude tab).
      claudeApiModels: claudeApiSettings?.enabled === true
        ? {
            defaultModel: claudeApiSettings.model,
            availableModels: Array.isArray(claudeApiSettings.availableModels) ? claudeApiSettings.availableModels : [],
            enabledModels: Array.isArray(claudeApiSettings.models) ? claudeApiSettings.models : [],
            discovered: claudeApiSettings.discovered === true,
            ...modelStateFields(claudeApiSettings),
          }
        : null,
    };
  }

  app.get('/api/model-variants', auth, (req, res) => {
    ensureSessionId(req, res);
    res.json(buildModelVariantCatalogPayloadForRoute());
  });

  app.post('/api/model-variants/refresh', auth, async (req, res) => {
    ensureSessionId(req, res);
    if (typeof refreshModelVariantCatalogFromCli !== 'function') {
      return res.status(501).json({ error: 'Model refresh is unavailable' });
    }
    try {
      // The help-text CLI refresh beside every enabled provider's discovery
      // (provider-model-refresh.mjs; Copilot discovery gates itself on an
      // installed CLI). Only a failed CLI refresh fails the request.
      const [cliRefresh, providerRefresh] = await Promise.allSettled([
        refreshModelVariantCatalogFromCli(),
        refreshProviderModels({ table: providerRefreshTable, reason: 'manual-refresh' }),
      ]);
      if (cliRefresh.status === 'rejected') throw cliRefresh.reason;
      const results = providerRefresh.status === 'fulfilled' ? providerRefresh.value.results : {};
      io.emit('models_updated', modelsUpdatedPayload(
        getModelCatalogState(),
      ));
      return res.json({
        ok: true,
        ...buildModelVariantCatalogPayloadForRoute(),
        openAIModelDiscovery: results.openai,
        claudeModelDiscovery: results.claude,
        cursorModelDiscovery: results.cursor,
        grokModelDiscovery: results.grok,
        deepseekModelDiscovery: results.deepseek,
        claudeApiModelDiscovery: results['claude-api'],
        copilotModelDiscovery: results.github,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: String(error?.message || error || 'Model refresh failed'),
      });
    }
  });

  app.patch('/api/model-variants', auth, (req, res) => {
    ensureSessionId(req, res);
    if (typeof setEnabledModelVariants !== 'function') {
      return res.status(501).json({ error: 'Model variant updates are unavailable' });
    }
    const hasVariantIds = Array.isArray(req.body?.enabledVariantIds);
    const autoEnableNew = req.body?.autoEnableNew;
    if (autoEnableNew !== undefined && typeof autoEnableNew !== 'boolean') {
      return res.status(400).json({ error: 'autoEnableNew must be true or false' });
    }
    if (!hasVariantIds && autoEnableNew === undefined) {
      return res.status(400).json({ error: 'No model variant update provided' });
    }
    const enabledVariantIds = hasVariantIds
      ? req.body.enabledVariantIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    // Every row off would leave the pickers with the fallback model only.
    if (hasVariantIds && !enabledVariantIds.length) {
      return res.status(400).json({ error: 'Select at least one model variant' });
    }
    // The rows the browser drew: only those change (an older page sends none).
    const shownVariantIds = Array.isArray(req.body?.shownVariantIds)
      ? req.body.shownVariantIds.map((value) => String(value || '').trim()).filter(Boolean)
      : null;
    if (hasVariantIds) setEnabledModelVariants(enabledVariantIds, shownVariantIds ? { shownVariantIds } : undefined);
    if (typeof autoEnableNew === 'boolean') setCopilotAutoEnableNew?.(autoEnableNew);
    io.emit('models_updated', modelsUpdatedPayload(
      getModelCatalogState(),
    ));
    return res.json({
      ok: true,
      ...buildModelVariantCatalogPayloadForRoute(),
    });
  });

  // Select Models was opened: every provider's "New" flags clear.
  app.post('/api/model-variants/seen', auth, (req, res) => {
    ensureSessionId(req, res);
    const markers = [
      () => markCopilotModelsSeen(),
      () => markProviderModelsSeen('openai'),
      () => markProviderModelsSeen('claude'),
      () => markProviderModelsSeen('cursor'),
      () => markProviderModelsSeen('grok'),
      () => deepseekSettingsService?.markModelsSeen?.() === true,
      () => claudeApiSettingsService?.markModelsSeen?.() === true,
    ];
    let changed = false;
    for (const mark of markers) {
      try {
        if (mark() === true) changed = true;
      } catch {
        /* one provider's map does not hold up the others */
      }
    }
    if (changed) {
      io.emit('models_updated', modelsUpdatedPayload(
        getModelCatalogState(),
      ));
    }
    return res.json({ ok: true, unseenNewModelCount: countUnseenNewModels() });
  });

  // "Check for new models" (Settings → General → Models): the switch, the
  // interval, the providers left out, and each enabled provider's last check.
  function modelRefreshSettingsPayload(settings) {
    const last = modelRefreshLedger?.readLast?.() || {};
    const lastOf = (id) => (last[id] ? { at: last[id].at, ok: last[id].ok, error: last[id].error } : null);
    const ask = (id, gate) => {
      try {
        return providerRefreshTable[id]?.[gate]?.() === true;
      } catch {
        return false;
      }
    };
    // Every switched-on provider; one that is not set up is not checked and
    // says so.
    const providers = MODEL_REFRESH_PROVIDERS
      .filter(({ id }) => ask(id, 'isEnabled'))
      .map(({ id, label }) => ({ id, label, setUp: ask(id, 'isSetUp'), last: lastOf(id) }));
    return {
      auto: settings.auto,
      intervalHours: settings.intervalHours,
      intervalChoices: [...MODEL_REFRESH_INTERVAL_HOURS_CHOICES],
      default: { auto: DEFAULT_MODEL_REFRESH_AUTO, intervalHours: DEFAULT_MODEL_REFRESH_INTERVAL_HOURS },
      excluded: settings.excluded,
      providers,
      last: Object.fromEntries(Object.keys(last).map((id) => [id, { at: last[id].at, ok: last[id].ok }])),
    };
  }

  app.get('/api/model-refresh-settings', auth, (_req, res) => {
    if (!modelRefreshSettings) return res.status(501).json({ error: 'Model refresh settings are unavailable' });
    return res.json(modelRefreshSettingsPayload(modelRefreshSettings.get()));
  });

  app.post('/api/model-refresh-settings', auth, (req, res) => {
    if (!modelRefreshSettings) return res.status(501).json({ error: 'Model refresh settings are unavailable' });
    const result = modelRefreshSettings.update(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(modelRefreshSettingsPayload(result.settings));
  });

  app.get('/api/models', auth, (req, res) => {
    ensureSessionId(req, res);
    const modelState = buildModelCatalogWithProviders(
      getModelCatalogState(),
    );
    res.json({
      models: modelState.models,
      currentModel: modelState.currentModel,
      defaultModel: modelState.defaultModel,
      reasoningByModel: modelState.reasoningByModel || {},
      reasoningByProvider: modelState.reasoningByProvider || {},
      reasoningOffUnsupportedByProvider: modelState.reasoningOffUnsupportedByProvider || {},
      reasoningEfforts: modelState.reasoningEfforts || [],
      contextLimitsByModel: modelState.contextLimitsByModel || {},
      modelMetadataByModel: modelState.modelMetadataByModel || {},
      // Enabled models the last authoritative snapshot no longer listed: they
      // stay in models[] (a selection must not vanish) but pickers grey them.
      unavailableModels: Array.isArray(modelState.unavailableModels) ? modelState.unavailableModels : [],
      claudeContextTiersByModel: modelState.claudeContextTiersByModel || {},
      claudeApiContextTiersByModel: modelState.claudeApiContextTiersByModel || {},
      providersByModel: modelState.providersByModel || {},
      // Models flagged new in Select Models: the menu item's dot.
      unseenNewModelCount: countUnseenNewModels(),
      stale: modelState.stale,
      metadataValid: modelState.metadataValid === true,
      reasoningMetadataValid: modelState.reasoningMetadataValid === true,
      refreshedAt: modelState.refreshedAt,
      source: modelState.source,
      warning: modelState.warning,
      error: modelState.error,
    });
  });

  app.post('/api/models/snapshot', auth, (req, res) => {
    const { models, currentModel, defaultModel, source, error, contextLimitsByModel, modelMetadataByModel } = req.body || {};
    const nextState = updateModelCatalog({
      models: Array.isArray(models) ? models : [],
      currentModel,
      defaultModel,
      contextLimitsByModel,
      modelMetadataByModel,
      source: source || 'relay-extension',
      error,
    });
    io.emit('models_updated', modelsUpdatedPayload(
      getModelCatalogState(),
    ));
    res.json({
      ok: true,
      ...getModelCatalogState(),
    });
  });

  // GET /api/usage — unified plan usage across every configured provider.
  //
  // Plan-first: subscription credits, rate-limit windows and reset times, with
  // token/cost diagnostics carried as collapsible detail sections. Each
  // provider is independent — a failing source yields an "unavailable" card
  // rather than a failed response — so the modal always renders something.
  // The live reads behind the usage modal (GitHub quota and billing, Grok,
  // Cursor, the Claude account) each take a second or more. The modal asks
  // for the provider on screen only (`?providers=github,claude`); the other
  // cards are built from the last live answer kept here, and the answer says
  // which cards are live (`live`) and when each was read (`fetchedAt`). No
  // parameter = everything live, as before.
  const usageLiveCache = {
    copilot: null, // { summary, error, at }
    copilotBilling: null, // { value, at }
    grokBilling: null,
    cursorBilling: null,
    deepseekBalance: null,
  };
  // `claude-api`'s card is read from the relay's own books on every answer.
  const USAGE_PROVIDER_IDS = ['github', 'claude', 'claude-cloud', 'cursor', 'grok', 'deepseek', 'claude-api'];

  function parseUsageProviders(raw) {
    const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
    if (!text.trim()) return null;
    const ids = text.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (ids.includes('all')) return null;
    return new Set(ids.filter((id) => USAGE_PROVIDER_IDS.includes(id)));
  }

  app.get('/api/usage', auth, async (req, res) => {
    const wantsLegacyOnly = String(req.query?.legacy || '').trim() === '1';
    const requested = parseUsageProviders(req.query?.providers);
    const live = (id) => requested === null || requested.has(id);
    const nowIso = () => new Date().toISOString();

    // The Copilot quota: live, or the last live answer.
    const readCopilotSummary = async () => {
      if (!live('github') && usageLiveCache.copilot) return usageLiveCache.copilot;
      let summary = null;
      let error = null;
      try {
        summary = await fetchUsageSummaryPromise(fetchUsageSummary);
      } catch (fetchError) {
        error = String(fetchError?.message || fetchError || 'Failed to fetch usage data');
      }
      const entry = { summary, error, at: nowIso() };
      // A failure is not kept over a good answer.
      if (summary || !usageLiveCache.copilot) usageLiveCache.copilot = entry;
      return entry;
    };

    if (wantsLegacyOnly || !planUsageService) {
      const { summary, error } = await readCopilotSummary();
      if (!summary) return res.status(500).json({ error: error || 'Usage is unavailable' });
      return res.json(summary);
    }

    // Each best-effort read: live when asked for, else the cached answer.
    const cachedOrLive = async (key, wanted, read) => {
      if (!wanted && usageLiveCache[key]) return usageLiveCache[key];
      let value = null;
      try {
        value = await read();
      } catch {
        value = null;
      }
      const entry = { value, at: nowIso() };
      if (value !== null || !usageLiveCache[key]) usageLiveCache[key] = entry;
      return entry;
    };

    const claudeSettings = getClaudeProviderSettings();
    const cursorSettings = getCursorProviderSettings();
    const grokSettings = getGrokProviderSettings();
    const deepseekSettings = getDeepSeekProviderSettings();
    const deepseekEnabled = deepseekSettings?.enabled === true;
    // An unreadable export is no reason to lose the card: the estimate stays.
    const readDeepSeekActuals = () => {
      try {
        return deepseekUsageImportService?.readActuals?.() ?? null;
      } catch {
        return null;
      }
    };
    let claudeCloudEnabled = false;
    try {
      claudeCloudEnabled = claudeCloudSettingsService?.getSettings?.()?.enabled === true;
    } catch {
      claudeCloudEnabled = false;
    }

    // Live Claude account usage, three seconds at most; without it the
    // Claude card shows the last turn's snapshot. The service keeps its own
    // minute of cache; when the modal did not ask for a Claude card live,
    // the last answer is used however old it is.
    const wantsClaudeLive = live('claude') || live('claude-cloud');
    const claudeAccountPromise = typeof claudeAccountUsageService?.getAccountUsage === 'function'
      ? (wantsClaudeLive
        ? Promise.resolve()
          .then(() => claudeAccountUsageService.getAccountUsage({ timeoutMs: 3000 }))
          .catch(() => null)
        : Promise.resolve(claudeAccountUsageService.peekAccountUsage?.() ?? null))
      : Promise.resolve(null);

    // All reads side by side: the modal waits for the slowest, not the sum.
    const [copilot, billingEntry, grokEntry, cursorEntry, deepseekEntry, claudeAccount] = await Promise.all([
      readCopilotSummary(),
      cachedOrLive('copilotBilling', live('github'), () => (
        typeof fetchCopilotBillingUsage === 'function'
          ? fetchCopilotBillingUsage().catch((error) => ({ items: [], timePeriod: null, scope: null, error: String(error?.message || error) }))
          : null
      )),
      cachedOrLive('grokBilling', live('grok'), () => (
        grokSettings?.enabled === true && typeof fetchGrokBillingUsage === 'function' ? fetchGrokBillingUsage() : null
      )),
      cachedOrLive('cursorBilling', live('cursor'), () => (
        cursorSettings?.enabled === true && typeof fetchCursorDashboardUsage === 'function' ? fetchCursorDashboardUsage() : null
      )),
      // The service keeps its own minute of cache and answers a failure as
      // `{ ok: false, … }`, so a failed read replaces the earlier answer here
      // (which it carries as `previous`).
      cachedOrLive('deepseekBalance', live('deepseek'), () => (
        deepseekEnabled && typeof deepseekBalanceService?.getBalance === 'function' ? deepseekBalanceService.getBalance() : null
      )),
      claudeAccountPromise,
    ]);

    // Whether a token exists at all decides which of the two very different
    // "no live bars" explanations the Cursor card shows.
    let cursorDashboardAuth = null;
    if (cursorSettings?.enabled === true) {
      try {
        cursorDashboardAuth = getCursorDashboardTokenSettings() || null;
      } catch {
        cursorDashboardAuth = null;
      }
    }

    // Built from the database on every answer, so it is always live.
    let claudeApiCard = null;
    try {
      claudeApiCard = claudeApiPlanUsage?.buildCard?.() || null;
    } catch {
      claudeApiCard = null;
    }

    const report = planUsageService.buildReport({
      copilotSummary: copilot.summary,
      copilotError: copilot.error,
      copilotCapturedAt: copilot.at,
      copilotBilling: billingEntry.value,
      claudeConfigured: claudeSettings?.enabled === true,
      claudeAccount,
      claudeCloudConfigured: claudeCloudEnabled,
      // The conversation the modal was opened from: a cloud conversation gets
      // its own cost on the Claude Cloud card.
      conversationId: String(req.query?.conversationId || '').trim(),
      cursorConfigured: cursorSettings?.enabled === true,
      cursorAllowances: getCursorPlanAllowanceSettings(),
      cursorBilling: cursorEntry.value,
      cursorDashboardAuth,
      grokConfigured: grokSettings?.enabled === true,
      grokAllowances: getGrokPlanAllowanceSettings(),
      grokBilling: grokEntry.value,
      deepseekConfigured: deepseekEnabled,
      deepseekBalance: deepseekEnabled ? deepseekEntry.value : null,
      deepseekMonthlyBudget: deepseekEnabled ? (deepseekSettings?.monthlyBudget ?? null) : null,
      deepseekMonthlyBudgetCurrency: deepseekEnabled ? (deepseekSettings?.monthlyBudgetCurrency ?? null) : null,
      deepseekStartingBalance: deepseekEnabled && deepseekSettings?.startingBalance
        ? { amount: deepseekSettings.startingBalance, setAt: deepseekSettings.startingBalanceSetAt }
        : null,
      deepseekActuals: deepseekEnabled ? readDeepSeekActuals() : null,
      claudeApiCard,
    });
    // OpenAI images: today's spend against the daily cap, from the booking.
    if (typeof getOpenAIImageSpendState === 'function') {
      const conversationId = String(req.query?.conversationId || '').trim();
      let imageSpendState = null;
      let imageSpendError = null;
      try {
        imageSpendState = await getOpenAIImageSpendState(conversationId ? { conversationId } : {});
      } catch (error) {
        imageSpendError = String(error?.message || error);
      }
      let openAIConfigured = false;
      try {
        openAIConfigured = getOpenAIProviderSettings()?.configured === true;
      } catch {}
      const imageCard = buildOpenAIImagePlanCard({ state: imageSpendState, error: imageSpendError, configured: openAIConfigured });
      if (imageCard && Array.isArray(report.providers)) report.providers.push(imageCard);
    }
    // Every tab's Tokens sections, from the token booking.
    if (tokenUsageService) {
      appendTokenSections(report.providers, (options) => tokenUsageService.readPeriods(options), {
        // A tab names its models as its other rows do: the Claude API tab as
        // its spend rows (the Console's names), DeepSeek with its own labels,
        // the Claude tab with Claude's; the raw id where there is none.
        modelLabelFor: (provider) => {
          if (provider === 'claude-api' && typeof claudeApiPlanUsage?.modelLabel === 'function') {
            return (model) => claudeApiPlanUsage.modelLabel(model);
          }
          if (provider === 'deepseek') return (model) => deepseekModelLabel(model);
          if (provider === 'claude') return (model) => claudeAttributionModelLabel(model);
          return null;
        },
      });
    }

    // Legacy top-level fields stay alongside `providers` so an older cached
    // client shell keeps working through a PWA update.
    return res.json({
      ...(copilot.summary || {}),
      ...report,
      live: USAGE_PROVIDER_IDS.filter(live),
      fetchedAt: {
        github: copilot.at,
        claude: claudeAccount?.fetchedAt || null,
        'claude-cloud': claudeAccount?.fetchedAt || null,
        cursor: cursorEntry.at,
        grok: grokEntry.at,
        deepseek: deepseekEntry.value?.fetchedAt || deepseekEntry.at,
        'claude-api': nowIso(),
      },
    });
  });
}
