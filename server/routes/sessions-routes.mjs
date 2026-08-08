'use strict';
import { killTmuxSession } from '../services/session-worker-launch-service.mjs';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { createSdkSessionSyncService } from '../services/sdk-session-sync-service.mjs';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import { persistConversationPreferences } from '../services/conversation-preferences-service.mjs';
import { mapUsageSnapshotRow, fetchUsageSummaryPromise } from '../services/usage-snapshot-helpers.mjs';
import { readStoredClaudeContextUsage } from '../services/claude-context-usage.mjs';
import { buildContextUsageView } from '../services/context-usage-view.mjs';
import { cleanupGeneratedImagesForConversation as cleanupGeneratedImagesForConversationDefault } from '../services/generated-image-cleanup-service.mjs';
import { stopSessionWorkerProcesses } from '../services/session-worker-stop-service.mjs';
import {
  isWithinAllowedPrefix,
  readWorkspaceRootPathFromBody,
  validateRequestedWorkspaceRoot,
} from '../services/workspace-root-path-policy.mjs';
import { workspaceRootDisplayName } from '../workspace-root.mjs';
import { createKeyedMutex } from '../services/keyed-mutex-service.mjs';
import { createFixedWindowRateLimiter } from '../services/rate-limit-service.mjs';
import {
  RELAUNCH_COALESCE_WINDOW_MS,
  buildRelaunchRequestKey,
  createRelaunchCoalescer,
  evaluateReuseCwdMismatch,
  evaluateWorkspaceRootRelaunch,
} from '../services/workspace-root-relaunch-service.mjs';
import {
  CLAUDE_DEFAULT_CONTEXT_LIMIT_TOKENS,
  CLAUDE_LONG_CONTEXT_LIMIT_TOKENS,
  CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN,
  isSafeClaudeModelId,
  isSafeCursorModelId,
  isSafeGrokModelId,
  isSafeProviderModelId,
} from '../../shared/model-id.mjs';
import { openAIReasoningEffortsForModel } from '../../shared/openai-reasoning.mjs';
import {
  DEFAULT_TURN_CEILING_MINUTES,
  TURN_CEILING_MAX_MINUTES,
  TURN_CEILING_MIN_MINUTES,
  TURN_CEILING_STEP_MINUTES,
  parseTurnCeilingUpdate,
} from '../../shared/turn-ceiling.mjs';

export { mapUsageSnapshotRow };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_WORKER_STATUS_QUEUE_STATES = Object.freeze(['pending', 'processing', 'parked']);

function normalizeWorkerStatusText(value, fallback = null) {
  const text = String(value || '').trim();
  return text || fallback;
}

export function normalizeShareToken(value) {
  const token = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(token)) return '';
  return token;
}

export function buildConversationShareToken() {
  return `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
}

export function normalizeSharedViewerId(value) {
  const viewerId = String(value || '').trim().replace(/[^a-zA-Z0-9:_-]+/g, '');
  if (!viewerId) return '';
  return viewerId.slice(0, 128);
}

function toSafeNonNegativeInt(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.trunc(numeric));
}

export function resolveBootstrapModelSelection({
  requestedModel = '',
  modelState = null,
  defaultModel = 'gpt-5.4-mini',
} = {}) {
  const availableModels = Array.isArray(modelState?.models)
    ? modelState.models.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const requested = String(requestedModel || '').trim();
  if (requested && availableModels.includes(requested)) return requested;
  return String(modelState?.currentModel || modelState?.defaultModel || defaultModel).trim() || defaultModel;
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

export function parseDefaultSessionWorkspaceRootUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const hasBodyValue = (
    Object.prototype.hasOwnProperty.call(payload, 'rootPath')
    || Object.prototype.hasOwnProperty.call(payload, 'workspaceRootPath')
    || Object.prototype.hasOwnProperty.call(payload, 'defaultSessionWorkspaceRootPath')
    || Object.prototype.hasOwnProperty.call(payload, 'default_session_workspace_root_path')
  );
  const clearRequested = payload.clear === true;
  if (!hasBodyValue && !clearRequested) {
    return { ok: false, error: 'Missing rootPath' };
  }
  const rootPath = clearRequested
    ? ''
    : String(
      payload.rootPath
      ?? payload.workspaceRootPath
      ?? payload.defaultSessionWorkspaceRootPath
      ?? payload.default_session_workspace_root_path
      ?? '',
    ).trim();
  return {
    ok: true,
    clearRequested,
    rootPath,
  };
}

export function parseOpenAISettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const remove = payload.remove === true;
  const hasModel = Object.prototype.hasOwnProperty.call(payload, 'model');
  const model = hasModel ? (String(payload.model || '').trim() || 'gpt-4o') : undefined;
  const apiKey = String(payload.apiKey || '').trim();
  const hasEnabled = typeof payload.enabled === 'boolean';
  const hasBaseUrl = Object.prototype.hasOwnProperty.call(payload, 'baseUrl');
  const baseUrl = hasBaseUrl ? String(payload.baseUrl || '').trim() : undefined;
  if (!remove && !hasModel && !apiKey && !hasEnabled && !hasBaseUrl) {
    return { ok: false, error: 'No OpenAI settings update provided' };
  }
  if (hasModel && !isSafeProviderModelId(model)) {
    return { ok: false, error: 'Invalid OpenAI model ID' };
  }
  if (remove) {
    return {
      ok: true,
      remove: true,
      apiKey: '',
      ...(hasModel ? { model } : {}),
      enabled: false,
    };
  }
  return {
    ok: true,
    remove: false,
    apiKey,
    ...(hasModel ? { model } : {}),
    ...(hasBaseUrl ? { baseUrl } : {}),
    enabled: hasEnabled ? payload.enabled : (apiKey ? true : undefined),
  };
}

export function parseClaudeSettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const hasEnabled = typeof payload.enabled === 'boolean';
  const hasModel = Object.prototype.hasOwnProperty.call(payload, 'model');
  const model = hasModel ? (String(payload.model || '').trim() || 'claude-sonnet-5') : undefined;
  const hasModels = Array.isArray(payload.models);
  const hasEnabledModels = Array.isArray(payload.enabledModels);
  if (!hasEnabled && !hasModel && !hasModels && !hasEnabledModels) {
    return { ok: false, error: 'No Claude settings update provided' };
  }
  if (hasModel && !isSafeClaudeModelId(model)) {
    return { ok: false, error: 'Invalid Claude model ID' };
  }
  return {
    ok: true,
    ...(hasEnabled ? { enabled: payload.enabled } : {}),
    ...(hasModel ? { model } : {}),
    ...(hasModels ? { models: payload.models } : {}),
    ...(hasEnabledModels ? { enabledModels: payload.enabledModels } : {}),
  };
}

export function parseCursorSettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const remove = payload.remove === true;
  const hasModel = Object.prototype.hasOwnProperty.call(payload, 'model');
  const model = hasModel ? (String(payload.model || '').trim() || 'composer-2.5') : undefined;
  const apiKey = String(payload.apiKey || '').trim();
  const hasEnabled = typeof payload.enabled === 'boolean';
  const hasEnabledModels = Array.isArray(payload.enabledModels);
  if (!remove && !hasModel && !apiKey && !hasEnabled && !hasEnabledModels) {
    return { ok: false, error: 'No Cursor settings update provided' };
  }
  if (hasModel && !isSafeCursorModelId(model)) {
    return { ok: false, error: 'Invalid Cursor model ID' };
  }
  if (remove) {
    return {
      ok: true,
      remove: true,
      apiKey: '',
      ...(hasModel ? { model } : {}),
      enabled: false,
    };
  }
  return {
    ok: true,
    remove: false,
    apiKey,
    ...(hasModel ? { model } : {}),
    ...(hasEnabledModels ? { enabledModels: payload.enabledModels } : {}),
    enabled: hasEnabled ? payload.enabled : (apiKey ? true : undefined),
  };
}

export function parseGrokSettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const hasEnabled = typeof payload.enabled === 'boolean';
  const hasModel = Object.prototype.hasOwnProperty.call(payload, 'model');
  const model = hasModel ? (String(payload.model || '').trim() || 'grok-4.5') : undefined;
  const hasModels = Array.isArray(payload.models);
  const hasEnabledModels = Array.isArray(payload.enabledModels);
  if (!hasEnabled && !hasModel && !hasModels && !hasEnabledModels) {
    return { ok: false, error: 'No Grok settings update provided' };
  }
  if (hasModel && !isSafeGrokModelId(model)) {
    return { ok: false, error: 'Invalid Grok model ID' };
  }
  return {
    ok: true,
    ...(hasEnabled ? { enabled: payload.enabled } : {}),
    ...(hasModel ? { model } : {}),
    ...(hasModels ? { models: payload.models } : {}),
    ...(hasEnabledModels ? { enabledModels: payload.enabledModels } : {}),
  };
}

export function buildModelCatalogWithClaudeProvider(modelState = {}, claudeSettings = {}) {
  const configured = claudeSettings?.enabled === true;
  const model = String(claudeSettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const baseModels = new Set(
    (Array.isArray(modelState?.models) ? modelState.models : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value && value.toLowerCase() !== 'auto'),
  );
  const claudeModels = Array.isArray(claudeSettings?.models)
    ? claudeSettings.models.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  // "[1m]" long-context variants are not separate composer entries: fold each
  // one into its base model as a long_context tier that the context-size
  // dropdown offers, mirroring how the Copilot catalog models long context.
  const longContextBases = new Set();
  const claudeBaseModels = [];
  const seenClaudeBases = new Set();
  for (const claudeModelId of [model, ...claudeModels]) {
    const isLongContextVariant = CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN.test(claudeModelId);
    const baseId = claudeModelId.replace(CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN, '');
    if (!baseId) continue;
    if (isLongContextVariant) longContextBases.add(baseId.toLowerCase());
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
  const defaultClaudeEfforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const modelMetadataByModel = { ...(modelState?.modelMetadataByModel || {}) };
  const providersByModel = { ...(modelState?.providersByModel || {}) };
  for (const claudeModel of claudeBaseModels) {
    const providersKey = String(claudeModel || '').trim();
    if (!providersKey) continue;
    const lowerKey = providersKey.toLowerCase();
    const effortsForModel = Array.isArray(effortsByModel[lowerKey]) && effortsByModel[lowerKey].length
      ? effortsByModel[lowerKey]
      : effortsByModel[`${lowerKey}[1m]`];
    const claudeEfforts = Array.isArray(effortsForModel) && effortsForModel.length
      ? effortsForModel
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
  };
}

export function buildModelCatalogWithOpenAIProvider(modelState = {}, openAISettings = {}) {
  const configured = openAISettings?.enabled === true;
  const model = String(openAISettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const baseModels = new Set(
    (Array.isArray(modelState?.models) ? modelState.models : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value && value.toLowerCase() !== 'auto'),
  );
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
  const baseModels = new Set(
    (Array.isArray(modelState?.models) ? modelState.models : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value && value.toLowerCase() !== 'auto'),
  );
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
    modelMetadataByModel,
    providersByModel,
  };
}

export function buildModelCatalogWithGrokProvider(modelState = {}, grokSettings = {}) {
  const configured = grokSettings?.enabled === true;
  const model = String(grokSettings?.model || '').trim();
  if (!configured || !model) return { ...modelState };
  const baseModels = new Set(
    (Array.isArray(modelState?.models) ? modelState.models : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value && value.toLowerCase() !== 'auto'),
  );
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

function normalizeRequestedProviderType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-byok') return 'openai';
  if (normalized === 'openai-image' || normalized === 'openai-image-byok') return 'openai-image';
  if (normalized === 'claude' || normalized === 'claude-agent-sdk' || normalized === 'anthropic') return 'claude';
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'grok' || normalized === 'xai' || normalized === 'xai-grok') return 'grok';
  if (normalized === 'github' || normalized === 'github-copilot') return 'github';
  return '';
}

function isOpenAIImageModelId(model = '') {
  const normalized = String(model || '').trim().toLowerCase().replace(/^openai\//, '');
  return normalized.startsWith('gpt-image-') || normalized.startsWith('dall-e-');
}

export function resolveOpenAISessionModel({
  requestedModel = '',
  configuredModel = 'gpt-4o',
  availableModels = [],
} = {}) {
  const requested = String(requestedModel || '').trim();
  const fallback = String(configuredModel || '').trim() || 'gpt-4o';
  const available = new Set(
    (Array.isArray(availableModels) ? availableModels : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  );
  if (requested === fallback || available.has(requested)) return requested;
  return fallback;
}

function runHostSuspendToRam() {
  if (process.platform !== 'win32') {
    return { ok: false, statusCode: 501, error: 'Host suspend is only supported on Windows' };
  }
  try {
    const child = spawn('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,0,0'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref?.();
    return {
      ok: true,
      command: 'rundll32.exe powrprof.dll,SetSuspendState 0,0,0',
    };
  } catch (error) {
    return { ok: false, statusCode: 500, error: error?.message || 'Failed to launch host suspend command' };
  }
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
  const activeStatuses = ['starting', 'ready', 'processing'];
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

export function learnWorkspaceRootFromSessionSync({
  learnConversationWorkspaceRoot = null,
  setWorkspaceRoot = null,
  sdkSessionId = '',
  conversationId = '',
  workspaceRootPath = '',
} = {}) {
  const nextRootPath = String(workspaceRootPath || '').trim();
  if (!nextRootPath) {
    return { ok: false, learned: false, changed: false, error: 'Missing workspace root path' };
  }
  if (typeof learnConversationWorkspaceRoot !== 'function' && typeof setWorkspaceRoot !== 'function') {
    return { ok: false, learned: false, changed: false, error: 'Workspace root updates are unavailable' };
  }

  if (typeof learnConversationWorkspaceRoot !== 'function') {
    const legacyResult = setWorkspaceRoot(nextRootPath, { reason: 'session-sync-cwd' });
    if (!legacyResult?.changed && legacyResult?.error) {
      return {
        ok: false,
        learned: false,
        changed: false,
        error: legacyResult.error,
      };
    }
    return {
      ok: true,
      learned: true,
      changed: !!legacyResult?.changed,
      rootPath: legacyResult?.rootPath || nextRootPath,
      rootName: legacyResult?.rootName || null,
      state: null,
    };
  }

  const convId = String(conversationId || '').trim();
  if (!convId) {
    // No conversation id — try to update an existing conversation already bound to this
    // sdk session (e.g. a rebind or a session that is reconnecting).
    const sid = String(sdkSessionId || '').trim();
    if (sid && typeof learnConversationWorkspaceRoot === 'function') {
      const sdkResult = learnConversationWorkspaceRoot({
        sdkSessionId: sid,
        conversationId: '',
        rootPath: nextRootPath,
        seedConfigured: true,
      });
      if (sdkResult?.ok && sdkResult.state?.conversationId) {
        const state = sdkResult.state;
        return {
          ok: true,
          learned: true,
          changed: String(state?.runtimeWorkspaceRootPath || '').trim().toLowerCase() === nextRootPath.toLowerCase(),
          rootPath: state?.runtimeWorkspaceRootPath || state?.currentWorkspaceRootPath || nextRootPath,
          rootName: state?.runtimeWorkspaceRootName || state?.currentWorkspaceRootName || null,
          state,
        };
      }
    }
    // No conversation found — caller should store as a pending session CWD.
    return {
      ok: true,
      learned: false,
      changed: false,
      rootPath: nextRootPath,
      rootName: null,
      state: null,
    };
  }

  const result = learnConversationWorkspaceRoot({
    sdkSessionId,
    conversationId: convId,
    rootPath: nextRootPath,
    seedConfigured: true,
  });
  if (!result?.ok) {
    return {
      ok: false,
      learned: false,
      changed: false,
      error: result?.error || 'Failed to learn workspace root',
    };
  }
  const state = result?.state || null;

  return {
    ok: true,
    learned: true,
    changed: String(state?.runtimeWorkspaceRootPath || '').trim().toLowerCase() === nextRootPath.toLowerCase(),
    rootPath: state?.runtimeWorkspaceRootPath || state?.currentWorkspaceRootPath || nextRootPath,
    rootName: state?.runtimeWorkspaceRootName || state?.currentWorkspaceRootName || null,
    state,
  };
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

const MAX_CONVERSATION_DRAFT_LENGTH = 20_000;

function normalizeConversationDraftText(value, { maxLength = MAX_CONVERSATION_DRAFT_LENGTH } = {}) {
  const text = String(value ?? '');
  if (!text.trim()) return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

export function normalizeOptionalIsoTimestamp(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export function hasConversationDraftVersionConflict({
  existingDraftUpdatedAt = null,
  baseDraftUpdatedAt = null,
  compareEnabled = false,
} = {}) {
  if (!compareEnabled) return false;
  return normalizeOptionalIsoTimestamp(existingDraftUpdatedAt) !== normalizeOptionalIsoTimestamp(baseDraftUpdatedAt);
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
  featureFlags = null,
  supervisorSnapshot = null,
  queueRows = [],
} = {}) {
  const snapshot = supervisorSnapshot && typeof supervisorSnapshot === 'object'
    ? supervisorSnapshot
    : {};
  const workers = Array.isArray(snapshot.workers) ? snapshot.workers : [];
  const onlineWorkerStatuses = new Set(['starting', 'ready', 'processing']);
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
    enabled: featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true,
    continuationRoutingEnabled: featureFlags?.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED === true,
    fallbackRestartEnabled: false,
    uiState: normalizeWorkerStatusText(snapshot?.health?.uiState, 'white'),
    degradedReason: normalizeWorkerStatusText(snapshot?.health?.degradedReason, null),
    health: snapshot?.health && typeof snapshot.health === 'object' ? snapshot.health : null,
    workerCount: toSafeNonNegativeInt(snapshot.workerCount, workers.length),
    onlineCount,
    onlineProcessCount,
    onlineBoundProcessCount,
    onlineUnassignedProcessCount,
    counts: snapshot.counts && typeof snapshot.counts === 'object' ? snapshot.counts : {},
    workers,
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
  resolveCursorSessionRoot = null,
} = {}) {
  const sid = String(sdkSessionId || '').trim() || String(conversationId || '').trim();
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
  // never fall through to the branch below.
  if (String(providerType || '').trim().toLowerCase() === 'claude') {
    const nativeSessionId = String(claudeNativeSessionId || '').trim();
    if (!nativeSessionId || typeof resolveClaudeSessionRoot !== 'function') return null;
    const claudeRoot = resolveClaudeSessionRoot({
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

function mergeUniqueActivityTexts(primary = [], secondary = []) {
  const merged = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    const text = value && typeof value === 'object'
      ? String(value.text || '').trim()
      : String(value || '').trim();
    const subagentRunId = value && typeof value === 'object' && value.subagentRunId
      ? String(value.subagentRunId).trim()
      : '';
    const key = `${subagentRunId}::${text}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    merged.push(value && typeof value === 'object' ? { ...value, text } : text);
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

function normalizeConversationTimestampMs(value) {
  const text = String(value || '').trim();
  if (!text) return 0;
  const sqliteUtcLike = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)$/;
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  let normalized = text;
  if (!hasExplicitTimezone && sqliteUtcLike.test(text)) {
    const [, day, time] = text.match(sqliteUtcLike) || [];
    normalized = `${day}T${time}Z`;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
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

export function normalizeConversationHistoryLimit(value, fallback = 20) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(100, Math.max(1, Math.trunc(numeric)));
}

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
  const oldestMessage = pageMessages[0] || null;
  return {
    messages: pageMessages,
    pageInfo: {
      hasMore: hasMoreOlder,
      hasMoreOlder,
      hasMoreNewer,
      nextCursor: oldestMessage ? {
        beforeMessageId: String(oldestMessage.id || '').trim(),
        beforeTimestamp: String(oldestMessage.timestamp || '').trim() || null,
      } : null,
      olderCursor: oldestMessage ? {
        beforeMessageId: String(oldestMessage.id || '').trim(),
        beforeTimestamp: String(oldestMessage.timestamp || '').trim() || null,
      } : null,
      newerCursor: lastMessage ? {
        afterMessageId: String(lastMessage.id || '').trim(),
        afterTimestamp: String(lastMessage.timestamp || '').trim() || null,
      } : null,
    },
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

function compareConversationListOrder(a, b) {
  const aUpdatedAtMs = normalizeConversationTimestampMs(a?.updated_at || a?.updatedAt);
  const bUpdatedAtMs = normalizeConversationTimestampMs(b?.updated_at || b?.updatedAt);
  if (aUpdatedAtMs !== bUpdatedAtMs) return bUpdatedAtMs - aUpdatedAtMs;
  return String(b?.id || '').trim().localeCompare(String(a?.id || '').trim());
}

function resolveConversationListCursor(rows = [], {
  beforeConversationId = '',
  beforeUpdatedAt = '',
} = {}) {
  const cursorConversationId = String(beforeConversationId || '').trim();
  const cursorUpdatedAt = String(beforeUpdatedAt || '').trim();
  const list = Array.isArray(rows) ? rows : [];

  if (cursorConversationId) {
    const cursorRow = list.find((row) => String(row?.id || '').trim() === cursorConversationId) || null;
    if (cursorRow) {
      return {
        beforeConversationId: cursorConversationId,
        beforeUpdatedAt: normalizeConversationTimestampIso(
          cursorRow.updated_at || cursorRow.updatedAt,
          String(cursorRow.updated_at || cursorRow.updatedAt || '').trim() || null,
        ),
        timestampMs: normalizeConversationTimestampMs(cursorRow.updated_at || cursorRow.updatedAt),
      };
    }
  }

  if (cursorUpdatedAt) {
    return {
      beforeConversationId: cursorConversationId || null,
      beforeUpdatedAt: cursorUpdatedAt,
      timestampMs: normalizeConversationTimestampMs(cursorUpdatedAt),
    };
  }

  return null;
}

export function selectConversationListPage(rows = [], {
  limit = DEFAULT_CONVERSATION_LIST_LIMIT,
  beforeConversationId = '',
  beforeUpdatedAt = '',
} = {}) {
  const pageLimit = normalizeConversationListLimit(limit);
  const ordered = Array.isArray(rows)
    ? rows.filter((row) => !!row).slice().sort(compareConversationListOrder)
    : [];
  const cursor = resolveConversationListCursor(ordered, { beforeConversationId, beforeUpdatedAt });
  const olderRows = cursor
    ? ordered.filter((row) => {
        const rowUpdatedAtMs = normalizeConversationTimestampMs(row?.updated_at || row?.updatedAt);
        if (rowUpdatedAtMs < cursor.timestampMs) return true;
        if (rowUpdatedAtMs > cursor.timestampMs) return false;
        if (!cursor.beforeConversationId) return false;
        return String(row?.id || '').trim().localeCompare(cursor.beforeConversationId) < 0;
      })
    : ordered;
  const pageRows = olderRows.slice(0, pageLimit);
  const oldestRow = pageRows[pageRows.length - 1] || null;
  return {
    rows: pageRows,
    pageInfo: {
      hasMore: olderRows.length > pageRows.length,
      nextCursor: oldestRow ? {
        beforeConversationId: String(oldestRow.id || '').trim(),
        beforeUpdatedAt: normalizeConversationTimestampIso(
          oldestRow.updated_at || oldestRow.updatedAt,
          String(oldestRow.updated_at || oldestRow.updatedAt || '').trim() || null,
        ),
      } : null,
    },
  };
}

export function buildConversationMessages({
  dbMessages = [],
  transcriptMessages = [],
  relayActivitiesByMessageId = new Map(),
  relayThoughtsByMessageId = new Map(),
  subagentRunsByMessageId = new Map(),
  responseMessageToSourceId = new Map(),
  queueRows = [],
  usageByResponseMessageId = new Map(),
} = {}) {
  const queueRowsById = new Map(
    (Array.isArray(queueRows) ? queueRows : [])
      .map((row) => [String(row?.id || '').trim(), row])
      .filter(([id]) => !!id),
  );
  const normalizedDbMessages = Array.isArray(dbMessages)
    ? dbMessages.map((message) => {
        const id = String(message?.id || '').trim();
        const sourceMessageId = message?.role === 'assistant'
          ? (responseMessageToSourceId.get(id) || undefined)
          : undefined;
        const queueRow = sourceMessageId ? queueRowsById.get(sourceMessageId) : null;
        return {
          activities: message?.role === 'assistant' ? (relayActivitiesByMessageId.get(id) || []) : [],
          thoughts: message?.role === 'assistant' ? (relayThoughtsByMessageId.get(id) || []) : [],
          subagentRuns: message?.role === 'assistant' ? (subagentRunsByMessageId.get(id) || []) : [],
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
          timestamp: message?.timestamp,
          sourceMessageId,
        };
      })
    : [];
  const normalizedTranscriptMessages = (Array.isArray(transcriptMessages) ? transcriptMessages : []).map((message) => {
    const id = String(message?.id || '').trim();
    const sourceMessageId = message?.role === 'assistant'
      ? (responseMessageToSourceId.get(id) || message?.sourceMessageId || undefined)
      : message?.sourceMessageId;
    const queueRow = sourceMessageId ? queueRowsById.get(String(sourceMessageId || '').trim()) : null;
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

export function filterMessagesVisibleToSharedView(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => Number(message?.hidden_from_shares || 0) !== 1);
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
    buildContextResponseText,
    readContextFromSessionEvents,
    inFlightStateForConversation,
    createCompactedConversation,
    collectOrphanedUploadsFromConversation,
    deleteOrphanedUploads,
    cleanupGeneratedImagesForConversation = cleanupGeneratedImagesForConversationDefault,
    queueCounts,
    getModelCatalogState,
    updateModelCatalog,
    listModelVariantRows,
    refreshModelVariantCatalogFromCli,
    setEnabledModelVariants,
    SUPPORTED_REASONING_EFFORTS,
    buildRelayReadyBannerData,
    workspaceRootPayload,
    setWorkspaceRoot,
    setDefaultSessionWorkspaceRootPath,
    getOpenAIProviderSettings = () => ({ configured: false, enabled: false, model: 'gpt-4o' }),
    setOpenAIProviderSettings = () => ({ ok: false, error: 'OpenAI settings are unavailable' }),
    refreshOpenAIProviderModels = async () => ({ ok: false, models: [], error: 'OpenAI model discovery is unavailable' }),
    getClaudeProviderSettings = () => ({ configured: false, enabled: false, model: 'claude-sonnet-5', models: [] }),
    setClaudeProviderSettings = () => ({ ok: false, error: 'Claude settings are unavailable' }),
    refreshClaudeProviderModels = async () => ({ ok: false, models: [], error: 'Claude model discovery is unavailable' }),
    getCursorProviderSettings = () => ({ configured: false, enabled: false, model: 'composer-2.5', models: [] }),
    setCursorProviderSettings = () => ({ ok: false, error: 'Cursor settings are unavailable' }),
    refreshCursorProviderModels = async () => ({ ok: false, models: [], error: 'Cursor model discovery is unavailable' }),
    getGrokProviderSettings = () => ({ configured: false, enabled: false, model: 'grok-4.5', models: [] }),
    setGrokProviderSettings = () => ({ ok: false, error: 'Grok settings are unavailable' }),
    refreshGrokProviderModels = async () => ({ ok: false, models: [], error: 'Grok model discovery is unavailable' }),
    reconcileUnstartedConversationProviders = async () => ({
      updatedUnstartedConversations: 0,
      skippedStartedConversations: 0,
      skippedActiveQueueConversations: 0,
      failedConversations: [],
    }),
    resolveConversationWorkspaceState,
    updateConversationConfiguredWorkspaceRoot,
    learnConversationWorkspaceRoot,
    setPendingSessionCwd,
    consumePendingSessionCwd,
    getPendingSessionCwd = () => null,
    // Opt-in. An empty list disables the check entirely, which is the default
    // and preserves the historical "any existing directory" behaviour.
    workspaceRootAllowList = [],
    processingTimeoutMs,
    localhostOnly,
    listenHost,
    ensureSessionId,
    touchCli,
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
    planUsageService = null,
    getCursorPlanAllowanceSettings = () => ({ cursorModelsUsd: null, otherModelsUsd: null, resetDay: 1 }),
    setCursorPlanAllowanceSettings = () => ({ ok: false, error: 'Cursor allowance settings are unavailable' }),
    getGrokPlanAllowanceSettings = () => ({ monthlyUsd: null, resetDay: 1 }),
    setGrokPlanAllowanceSettings = () => ({ ok: false, error: 'Grok allowance settings are unavailable' }),
    sessionHistoryRefreshService,
    sdkSessionImportService,
    ensureRuntimeSessionBinding,
    bootstrapRuntimeSessionBindings,
    configuredConversationSessionMode,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    SUPPORTED_CONVERSATION_SESSION_MODES,
    DEFAULT_CONVERSATION_SESSION_MODE,
    DEFAULT_MODEL,
    remotePath,
    computeRetryDelayMs,
    relayRestartOrchestrator,
    relayBridgeOwnerService,
    featureFlags,
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
    sessionWorkerProcessInspector,
    // Seams for stopSessionWorkerProcesses (platform, killImpl, isPidAliveImpl,
    // killTmuxSessionImpl). Tests must inject these instead of relying on the
    // host OS, so the suite behaves identically on Windows and POSIX.
    sessionWorkerStopOverrides = null,
    resolveSessionStateRoot,
    resolveClaudeSessionRoot = null,
    resolveCursorSessionRoot = null,
    getTurnCeilingMinutes = () => DEFAULT_TURN_CEILING_MINUTES,
    setTurnCeilingMinutes = () => ({ ok: false, error: 'Turn ceiling settings are unavailable' }),
    markSharedViewerPresence,
    getSharedWatcherCount,
    statusEventService,
    windowsAutostartService,
    isSha256,
    uploadPathForSha,
  } = deps;
  const sdkSessionSyncService = createSdkSessionSyncService(db);
  const SDK_DELETE_WAIT_TIMEOUT_MS = 12_000;
  const SDK_DELETE_POLL_MS = 200;
  const SDK_DELETE_STALE_PROCESSING_MS = 60_000;
  const markConversationDeleted = db.prepare(`UPDATE conversations SET status = 'deleted', updated_at = ? WHERE id = ?`);
  const getActiveQueueForMessage = db.prepare(`
    SELECT id
    FROM queue
    WHERE conversation_id = ?
      AND status IN ('pending', 'processing', 'parked')
      AND (id = ? OR response_message_id = ?)
    LIMIT 1
  `);
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
  const countActiveConversationQueueRows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM queue
    WHERE conversation_id = ?
      AND status IN ('pending', 'processing', 'parked')
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
  const hardDeleteConversationRows = db.transaction((conversationId) => {
    if (typeof stmts.deleteConvQuestions?.run === 'function') {
      stmts.deleteConvQuestions.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvBoards?.run === 'function') {
      stmts.deleteConvBoards.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_boards WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvStreamEvents?.run === 'function') {
      stmts.deleteConvStreamEvents.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`).run(conversationId);
    }
    if (typeof stmts.deleteConvThoughts?.run === 'function') {
      stmts.deleteConvThoughts.run(conversationId);
    } else {
      db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`).run(conversationId);
    }
    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`).run(conversationId);
    db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
  });
  const sharedPresenceRateLimiter = createFixedWindowRateLimiter({
    windowMs: 10_000,
    limit: 24,
    bucketTtlMs: 60_000,
    maxBuckets: 4_096,
  });
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
  // Serializes everything that reaches the session-worker launch path, keyed by
  // sdkSessionId, plus a coalescer so a duplicated request replays one result.
  const sessionLaunchMutex = createKeyedMutex();
  const relaunchCoalescer = createRelaunchCoalescer({ windowMs: RELAUNCH_COALESCE_WINDOW_MS });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Layer every enabled provider's models onto the base Copilot catalog.
  function buildModelCatalogWithProviders(modelState, openAISettings = getOpenAIProviderSettings()) {
    return buildModelCatalogWithGrokProvider(
      buildModelCatalogWithCursorProvider(
        buildModelCatalogWithClaudeProvider(
          buildModelCatalogWithOpenAIProvider(modelState, openAISettings),
          getClaudeProviderSettings(),
        ),
        getCursorProviderSettings(),
      ),
      getGrokProviderSettings(),
    );
  }

  function extractClientIp(req) {
    const forwardedForHeader = String(req.headers?.['x-forwarded-for'] || '').trim();
    if (forwardedForHeader) {
      const firstHop = forwardedForHeader.split(',')[0].trim();
      const forwardedFor = firstHop.replace(/^for=/i, '').replace(/^"|"$/g, '').trim();
      if (forwardedFor) return forwardedFor.slice(0, 128);
    }
    const realIp = String(req.headers?.['x-real-ip'] || '').trim();
    if (realIp) return realIp.slice(0, 128);
    const reqIp = String(req.ip || req.socket?.remoteAddress || '').trim();
    return reqIp.slice(0, 128) || 'unknown';
  }

  function consumeSharedPresenceRateLimit(token, req, nowMs = Date.now()) {
    const shareToken = String(token || '').trim();
    if (!shareToken) return { ok: false, retryAfterSeconds: 1 };
    return sharedPresenceRateLimiter.consume(`${shareToken}:${extractClientIp(req)}`, nowMs);
  }

  function consumeWorkspaceRootRateLimit(scopeKey, req, nowMs = Date.now()) {
    const scope = String(scopeKey || '').trim();
    if (!scope) return { ok: false, retryAfterSeconds: 1 };
    return workspaceRootRateLimiter.consume(`${scope}:${extractClientIp(req)}`, nowMs);
  }

  function readBridgeIdentity(req) {
    return relayBridgeOwnerService?.normalizeIdentity?.({
      pid: req.headers['x-relay-process-pid'],
      parentPid: req.headers['x-relay-parent-pid'],
      sessionId: req.headers['x-relay-session-id'],
      conversationId: req.headers['x-relay-conversation-id'],
    }) || null;
  }

  function shortId(value) {
    const text = String(value || '').trim();
    if (!text) return 'none';
    return `${text.slice(0, 8)}…`;
  }

  function markWorkerSessionSeen({ sdkSessionId, conversationId, runtimeSessionId } = {}) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return null;
    const existing = sessionWorkerRegistry?.getWorker?.(sid) || null;
    return sessionWorkerRegistry?.upsertWorker?.({
      ...(existing || {}),
      sdkSessionId: sid,
      conversationId: String(conversationId || '').trim() || existing?.conversationId || null,
      runtimeSessionId: String(runtimeSessionId || '').trim() || existing?.runtimeSessionId || null,
      status: existing?.status || 'new',
    }) || null;
  }

  function enqueueSdkDeleteRequest(sdkSessionId, conversationId = null) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return false;
    const nowIso = new Date().toISOString();
    const convId = String(conversationId || '').trim() || null;
    stmts.upsertSdkDeleteRequest.run(sid, convId, nowIso, nowIso);
    return true;
  }

  async function waitForSdkDeleteCompletion(sdkSessionId, timeoutMs = SDK_DELETE_WAIT_TIMEOUT_MS) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return { completed: false };
    const startedAt = Date.now();
    while ((Date.now() - startedAt) < timeoutMs) {
      const row = stmts.getSdkDeleteRequestBySessionId.get(sid);
      if (!row) return { completed: true };
      await sleep(SDK_DELETE_POLL_MS);
    }
    return { completed: false };
  }

  function finalizeDeletedConversationsForSdkSession(sdkSessionId) {
    const sid = String(sdkSessionId || '').trim();
    if (!sid) return [];
    const rows = stmts.listDeletedConversationsBySdkSessionId.all(sid);
    const finalized = [];
    for (const row of rows) {
      const conversationId = String(row?.id || '').trim();
      if (!conversationId) continue;
      cleanupGeneratedImagesForConversation({
        conversationId,
        sdkSessionId: sid,
        messageRows: stmts.getMessages?.all?.(conversationId) || [],
        parseAttachments,
        hydrateAttachment,
        resolveSessionStateRoot,
      });
      const orphanedUploads = collectOrphanedUploadsFromConversation(conversationId);
      hardDeleteConversationRows(conversationId);
      deleteOrphanedUploads(orphanedUploads);
      io.emit('conversation_deleted', { conversationId });
      finalized.push(conversationId);
    }
    return finalized;
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

  function buildShareUrl(req, token) {
    const shareToken = String(token || '').trim();
    if (!shareToken) return '';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const protocol = forwardedProto || req.protocol || 'http';
    const basePath = String(remotePath || '').trim().replace(/\/+$/, '');
    const relative = `${basePath}/shared/${shareToken}`.replace(/\/{2,}/g, '/');
    if (!host) return relative;
    return `${protocol}://${host}${relative}`;
  }

  function buildSharedUploadContentUrl(token, sha256) {
    const shareToken = normalizeShareToken(token);
    const normalizedSha = String(sha256 || '').trim().toLowerCase();
    if (!shareToken || !isSha256(normalizedSha)) return '';
    return `${String(remotePath || '').replace(/\/+$/, '')}/api/shared/${shareToken}/upload/${normalizedSha}/content`.replace(/\/{2,}/g, '/');
  }

  function buildSharedGeneratedImageContentUrl(token, messageId, imageId) {
    const shareToken = normalizeShareToken(token);
    const normalizedMessageId = String(messageId || '').trim();
    const normalizedImageId = String(imageId || '').trim();
    if (!shareToken || !normalizedMessageId || !normalizedImageId) return '';
    return `${String(remotePath || '').replace(/\/+$/, '')}/api/shared/${shareToken}/generated-image/${encodeURIComponent(normalizedMessageId)}/${encodeURIComponent(normalizedImageId)}/content`.replace(/\/{2,}/g, '/');
  }

  function conversationReferencesUploadSha(conversationId, sha256) {
    const convId = String(conversationId || '').trim();
    const normalizedSha = String(sha256 || '').trim().toLowerCase();
    if (!convId || !isSha256(normalizedSha)) return false;
    const rows = filterMessagesVisibleToSharedView(
      (stmts.getSharedMessages || stmts.getMessages).all(convId),
    );
    for (const row of rows) {
      const attachments = parseAttachments(row?.attachments);
      for (const attachment of attachments) {
        if (String(attachment?.sha256 || '').trim().toLowerCase() === normalizedSha) {
          return true;
        }
      }
    }
    return false;
  }

  function rewriteSharedAttachmentContentUrl(attachment, shareToken) {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const normalizedSha = String(attachment.sha256 || '').trim().toLowerCase();
    if (!isSha256(normalizedSha)) return attachment;
    const contentUrl = buildSharedUploadContentUrl(shareToken, normalizedSha);
    if (!contentUrl) return attachment;
    return {
      ...attachment,
      contentUrl,
    };
  }

  function rewriteSharedGeneratedImageAttachmentContentUrl(attachment, shareToken) {
    if (!attachment || typeof attachment !== 'object') return attachment;
    const generatedImage = attachment.generatedImage && typeof attachment.generatedImage === 'object'
      ? attachment.generatedImage
      : null;
    const messageId = String(generatedImage?.messageId || generatedImage?.responseMessageId || generatedImage?.parentMessageId || '').trim();
    const imageId = String(generatedImage?.imageId || '').trim();
    if (!messageId || !imageId) return attachment;
    const contentUrl = buildSharedGeneratedImageContentUrl(shareToken, messageId, imageId);
    if (!contentUrl) return attachment;
    return {
      ...attachment,
      contentUrl,
    };
  }

  function buildConversationPayloadForShare({
    conv,
    shareToken = '',
    limit = 120,
    beforeMessageId = '',
    beforeTimestamp = '',
    afterMessageId = '',
    afterTimestamp = '',
    aroundMessageId = '',
  } = {}) {
    const resolvedConversationId = String(conv?.id || '').trim();
    if (!resolvedConversationId) return null;
    const resolvedTitle = resolveConversationTitle({
      title: conv.title,
      titleSource: conv.title_source,
    });
    const inFlight = inFlightStateForConversation(resolvedConversationId);
    const sdkSessionId = String(conv.sdk_session_id || resolvedConversationId || '').trim();
    const dbMessages = filterMessagesVisibleToSharedView(
      (stmts.getSharedMessages || stmts.getMessages).all(resolvedConversationId),
    );
    const queueRows = db.prepare(`
      SELECT id, response_message_id, text, timestamp, retry_count, reasoning_effort, model
      FROM queue
      WHERE conversation_id = ?
    `).all(resolvedConversationId);
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
    const usageByResponseMessageId = new Map(
      (stmts.listMessageUsageSnapshotsByConversation?.all(conv.id) || [])
        .map((row) => [String(row?.response_message_id || '').trim(), mapUsageSnapshotRow(row)])
        .filter(([messageId, usage]) => !!messageId && !!usage),
    );
    let messages = buildConversationMessages({
      dbMessages: dbMessages.map((message) => ({
        ...message,
        attachments: parseAttachments(message.attachments)
          .map(hydrateAttachment)
          .filter(Boolean)
          .map((attachment) => rewriteSharedGeneratedImageAttachmentContentUrl(rewriteSharedAttachmentContentUrl(attachment, shareToken), shareToken)),
      })),
      transcriptMessages: [],
      relayActivitiesByMessageId,
      relayThoughtsByMessageId,
      subagentRunsByMessageId,
      responseMessageToSourceId,
      queueRows,
      usageByResponseMessageId,
    });
    messages = messages.map((message) => {
      const sourceMessageId = responseMessageToSourceId.get(String(message.id || '').trim()) || message.sourceMessageId || undefined;
      const nextMessage = sourceMessageId ? { ...message, sourceMessageId } : message;
      const attachments = Array.isArray(nextMessage?.attachments)
        ? nextMessage.attachments.map((attachment) => rewriteSharedGeneratedImageAttachmentContentUrl(rewriteSharedAttachmentContentUrl(attachment, shareToken), shareToken))
        : nextMessage?.attachments;
      return attachments === nextMessage?.attachments
        ? nextMessage
        : { ...nextMessage, attachments };
    });
    const history = selectConversationHistoryPage(messages, {
      limit,
      beforeMessageId,
      beforeTimestamp,
      afterMessageId,
      afterTimestamp,
      aroundMessageId,
    });
    return {
      id: resolvedConversationId,
      sdkSessionId: conv.sdk_session_id || null,
      title: resolvedTitle,
      archived: Number(conv.archived || 0) === 1,
      compactedInto: conv.compacted_into || null,
      compactedFrom: conv.compacted_from || null,
      runtimeSession: null,
      sessionRootPath: null,
      sessionRootName: resolvedTitle || 'Session',
      configuredWorkspaceRootPath: null,
      configuredWorkspaceRootName: null,
      runtimeWorkspaceRootPath: null,
      runtimeWorkspaceRootName: null,
      currentWorkspaceRootPath: null,
      currentWorkspaceRootName: null,
      createdAt: conv.created_at,
      updatedAt: conv.updated_at,
      sessionUsageSummary: null,
      inFlight,
      preferredRelayMode: DEFAULT_RELAY_MODE,
      preferredModel: '',
      preferredReasoningEffort: '',
      draftText: '',
      draftUpdatedAt: null,
      draftUpdatedByClientId: null,
      messages: history.messages,
      pageInfo: history.pageInfo,
    };
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
    const includeArchived = String(req.query.archived || '').trim().toLowerCase() === 'true';
    const limit = normalizeConversationListLimit(req.query.limit, DEFAULT_CONVERSATION_LIST_LIMIT);
    const beforeConversationId = String(req.query.beforeConversationId || '').trim();
    const beforeUpdatedAt = String(req.query.beforeUpdatedAt || '').trim();
    const rows = stmts.listConvs.all(includeArchived ? 1 : 0);
    const page = selectConversationListPage(rows, {
      limit,
      beforeConversationId,
      beforeUpdatedAt,
    });
    const activeTurnConversationIds = new Set(
      (stmts.listConversationIdsWithActiveQueue?.all() || [])
        .map((row) => String(row?.conversation_id || '').trim())
        .filter(Boolean),
    );
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
        draftUpdatedAt: r.draft_updated_at || null,
        draftUpdatedByClientId: r.draft_updated_by_client_id || null,
      };
    });

    return res.json({
      conversations,
      pageInfo: page.pageInfo,
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

  // GET /api/sdk-session-delete/pending — relay extension fetches next pending SDK delete request
  app.get('/api/sdk-session-delete/pending', auth, (req, res) => {
    touchCli();
    const nowIso = new Date().toISOString();
    const staleCutoff = new Date(Date.now() - SDK_DELETE_STALE_PROCESSING_MS).toISOString();
    stmts.resetStaleSdkDeleteProcessing.run(nowIso, staleCutoff);
    const dequeue = db.transaction(() => {
      const next = stmts.dequeueSdkDeleteRequest.get(nowIso);
      if (!next?.sdk_session_id) return null;
      const claimed = stmts.setSdkDeleteRequestProcessing.run(nowIso, nowIso, next.sdk_session_id);
      if (claimed.changes === 0) return null;
      return {
        sdkSessionId: next.sdk_session_id,
        conversationId: next.conversation_id || null,
        retryCount: Number(next.retry_count || 0),
        requestedAt: next.requested_at || nowIso,
      };
    });
    const request = dequeue();
    return res.json({ request });
  });

  // POST /api/sdk-session-delete/result — relay extension reports SDK delete result
  app.post('/api/sdk-session-delete/result', auth, (req, res) => {
    touchCli();
    const sdkSessionId = String(req.body?.sdk_session_id || '').trim();
    const ok = req.body?.ok === true;
    const unsupported = req.body?.unsupported === true;
    const errorText = String(req.body?.error || '').trim() || 'Unknown SDK delete failure';
    if (!sdkSessionId) return res.status(400).json({ error: 'Missing sdk_session_id' });

    if (ok || unsupported) {
      stmts.deleteSdkDeleteRequest.run(sdkSessionId);
      const finalizedConversationIds = finalizeDeletedConversationsForSdkSession(sdkSessionId);
      sessionWorkerRegistry?.removeWorker?.(sdkSessionId);
      if (!finalizedConversationIds.length) {
        io.emit('conversation_deleted', { conversationId: sdkSessionId });
      }
      return res.json({ ok: true, unsupported, finalizedConversationIds });
    }

    const nowIso = new Date().toISOString();
    const current = stmts.getSdkDeleteRequestBySessionId.get(sdkSessionId);
    if (!current) return res.json({ ok: true, ignored: 'request_missing' });
    const nextRetryCount = Number(current.retry_count || 0) + 1;
    const nextAttemptAt = new Date(Date.now() + computeRetryDelayMs(nextRetryCount)).toISOString();
    stmts.setSdkDeleteRequestPendingWithError.run(nextAttemptAt, nowIso, errorText, sdkSessionId);
    io.emit('conversation_delete_pending', {
      sdkSessionId,
      conversationId: current.conversation_id || null,
      retryCount: nextRetryCount,
      nextAttemptAt,
      error: errorText,
    });
    return res.json({ ok: true, pending: true, retryCount: nextRetryCount, nextAttemptAt });
  });

  app.post('/api/session-sync', auth, (req, res) => {
    const body = req.body || {};
    relayBridgeOwnerService?.observe?.(readBridgeIdentity(req));
    const sdkSessionId = String(body.sdk_session_id || '').trim();
    const conversationId = String(body.conversation_id || '').trim();
    const workspaceRootPath = String(
      body.workspace_root_path
      || body.workspaceRootPath
      || body.cwd
      || body.current_working_directory
      || '',
    ).trim();
    const orchestratorCorrelationId = String(
      body.orchestrator_correlation_id
      || body.orchestrator_transaction_id
      || body.restart_transaction_id
      || body.transaction_id
      || body.correlation_id
      || '',
    ).trim();
    const orchestratorTargetSessionId = String(
      body.orchestrator_target_session_id
      || body.restart_target_session_id
      || body.target_session_id
      || body.targetSessionId
      || '',
    ).trim();
    const rebindCompleted = body.rebind_completed === true
      || body.rebind_complete === true
      || body.rebindConfirmed === true
      || String(body.rebind_state || body.rebind_signal || '').trim().toLowerCase() === 'completed';
    if (rebindCompleted) {
      console.log(
        `[session-sync] rebind signal sid=${shortId(sdkSessionId)} conv=${shortId(conversationId)} tx=${shortId(orchestratorCorrelationId)} target=${shortId(orchestratorTargetSessionId)}`,
      );
    }

    if (!sdkSessionId || !conversationId) {
      return res.status(400).json({ error: 'Missing sdk_session_id or conversation_id' });
    }

    try {
      const workspaceRootSync = learnWorkspaceRootFromSessionSync({
        learnConversationWorkspaceRoot,
        sdkSessionId,
        conversationId,
        workspaceRootPath,
      });
      const sync = sdkSessionSyncService.syncSession({
        sdk_session_id: sdkSessionId,
        conversation_id: conversationId,
      });
      const rebind = relayRestartOrchestrator?.applySessionSync?.({
        sdkSessionId,
        conversationId,
        correlationId: orchestratorCorrelationId || null,
        targetSessionId: orchestratorTargetSessionId || null,
        rebindCompleted,
        signalSource: 'api-session-sync',
      }) || null;
      if (rebindCompleted) {
        console.log(
          `[session-sync] rebind outcome sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} code=${String(rebind?.code || 'none')} completed=${rebind?.completed === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
        );
      }
      if (rebindCompleted && rebind?.ok === false && rebind?.conflict) {
        const statusCode = rebind.retryable ? 409 : 409;
        return res.status(statusCode).json({
          error: rebind.message || 'Rebind confirmation conflict',
          code: rebind.code || 'rebind-conflict',
          retryable: rebind.retryable === true,
          terminal: rebind.terminal === true,
          rebind,
          restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
        });
      }
      stmts.clearDeletedSdkSession.run(sdkSessionId);
      // If the session reported its CWD before the conversation was bound,
      // the pending entry is no longer needed — the workspace root has been
      // persisted to the conversation by workspaceRootSync above.
      if (workspaceRootSync.learned === true && typeof consumePendingSessionCwd === 'function') {
        consumePendingSessionCwd(sdkSessionId);
      }
      markWorkerSessionSeen({
        sdkSessionId: sync?.sdkSessionId || sdkSessionId,
        conversationId: sync?.conversationId || conversationId,
        runtimeSessionId: sync?.runtimeSessionId || null,
      });
      io.emit('conversation_session_bound', {
        conversationId: sync?.conversationId || conversationId,
        sdkSessionId: sync?.sdkSessionId || sdkSessionId,
        runtimeSessionId: sync?.runtimeSessionId || null,
      });
      if (workspaceRootSync.ok && workspaceRootSync.state?.conversationId) {
        const workspaceHints = workspaceRootPayload();
        io.emit('conversation_workspace_root_updated', {
          conversationId: workspaceRootSync.state.conversationId,
          sdkSessionId: workspaceRootSync.state.sdkSessionId || sync?.sdkSessionId || sdkSessionId,
          configuredWorkspaceRootPath: workspaceRootSync.state.configuredWorkspaceRootPath || null,
          configuredWorkspaceRootName: workspaceRootSync.state.configuredWorkspaceRootName || null,
          runtimeWorkspaceRootPath: workspaceRootSync.state.runtimeWorkspaceRootPath || null,
          runtimeWorkspaceRootName: workspaceRootSync.state.runtimeWorkspaceRootName || null,
          currentWorkspaceRootPath: workspaceRootSync.state.currentWorkspaceRootPath || null,
          currentWorkspaceRootName: workspaceRootSync.state.currentWorkspaceRootName || null,
          recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
        });
      }
      const workspaceHints = workspaceRootPayload();
      return res.json({
        ok: true,
        session: {
          conversationId: sync?.conversationId || conversationId,
          sdkSessionId: sync?.sdkSessionId || sdkSessionId,
          runtimeSessionId: sync?.runtimeSessionId || null,
          createdRuntimeSession: sync?.createdRuntimeSession === true,
        },
        workspaceRoot: workspaceRootSync.ok ? {
          learned: workspaceRootSync.learned === true,
          changed: workspaceRootSync.changed === true,
          rootPath: workspaceRootSync.rootPath || workspaceRootPath || null,
          rootName: workspaceRootSync.rootName || null,
          recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
        } : null,
        rebind: rebind ? {
          considered: rebind.considered === true,
          completed: rebind.completed === true,
          awaitingRebind: rebind.awaitingRebind === true,
          code: rebind.code || null,
          retryable: rebind.retryable === true,
          terminal: rebind.terminal === true,
          expected: rebind.expected || null,
        } : null,
        bindingState: 'bound',
        restartOrchestrator: rebind?.state || relayRestartOrchestrator?.getState?.() || null,
        activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
      });
    } catch (error) {
      const statusCode = Number(error?.statusCode || 500);
      const retryable = statusCode >= 500;
      const payload = {
        error: error?.message || 'Failed to sync session',
        code: statusCode === 409 ? 'binding-conflict' : 'session-sync-failed',
        retryable,
        terminal: !retryable,
      };
      return res.status(Number.isInteger(statusCode) ? statusCode : 500).json(payload);
    }
  });

  app.post('/api/session-workspace-root', auth, (req, res) => {
    const sdkSessionId = String(req.body?.sdk_session_id || req.body?.sdkSessionId || '').trim();
    const conversationId = String(req.body?.conversation_id || req.body?.conversationId || '').trim();
    const workspaceRootPath = String(
      req.body?.workspace_root_path
      || req.body?.workspaceRootPath
      || req.body?.cwd
      || req.body?.current_working_directory
      || '',
    ).trim();
    const result = learnWorkspaceRootFromSessionSync({
      learnConversationWorkspaceRoot,
      sdkSessionId,
      conversationId,
      workspaceRootPath,
    });
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error || 'Failed to learn workspace root',
      });
    }
    // When no conversation was found to update (new session before any message),
    // store the CWD in the per-session pending map so it can be used as a display
    // fallback and consumed when the session later binds to a conversation.
    if (!result.learned && sdkSessionId && workspaceRootPath) {
      setPendingSessionCwd(sdkSessionId, workspaceRootPath);
    }
    if (result.state?.conversationId) {
      const workspaceHints = workspaceRootPayload();
      io.emit('conversation_workspace_root_updated', {
        conversationId: result.state.conversationId,
        sdkSessionId: result.state.sdkSessionId || sdkSessionId || null,
        configuredWorkspaceRootPath: result.state.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: result.state.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: result.state.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: result.state.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: result.state.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: result.state.currentWorkspaceRootName || null,
        recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
      });
    }
    return res.json({
      ok: true,
      learned: true,
      changed: result.changed === true,
      workspaceRootPath: result.rootPath || workspaceRootPath || null,
      workspaceRootName: result.rootName || null,
      conversationId: result.state?.conversationId || conversationId || null,
      sdkSessionId: result.state?.sdkSessionId || sdkSessionId || null,
      configuredWorkspaceRootPath: result.state?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: result.state?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: result.state?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: result.state?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: result.state?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: result.state?.currentWorkspaceRootName || null,
      ...workspaceRootPayload(),
    });
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
    // The cursor and grok workers post the same Claude-shaped usage blob, so
    // all three providers share the stored reader.
    const usesStoredContextUsage = providerType === 'claude' || providerType === 'cursor'
      || providerType === 'grok';

    const parsed = usesStoredContextUsage
      ? (() => {
        const stored = readStoredClaudeContextUsage(runtimeSession);
        return {
          snapshot: stored.snapshot,
          contextUsage: stored.contextUsage,
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

    return {
      conversationId: lookupId,
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
        const error = new Error(
          result.reason === 'tombstoned'
            ? 'Conversation not found'
            : 'Conversation history refresh is already in progress',
        );
        error.statusCode = result.reason === 'tombstoned' ? 404 : 409;
        throw error;
      }
    } catch (error) {
      return res.status(error?.statusCode || 500).json({
        error: error?.message || 'Failed to refresh conversation history',
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
      resolveCursorSessionRoot,
    });
    const dbMessages = stmts.getMessages.all(conversationId);
    const queueRows = db.prepare(`
      SELECT id, response_message_id, text, timestamp, retry_count, reasoning_effort, model
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
      draftUpdatedAt: conv.draft_updated_at || null,
      draftUpdatedByClientId: conv.draft_updated_by_client_id || null,
      messages: history.messages,
      pageInfo: history.pageInfo,
      refreshed: true,
    });
  });

  app.post('/api/conversation/:id/share', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    const conv = stmts.getConvAnyStatus.get(conversationId) || null;
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    let share = stmts.getConversationShareByConversationId?.get(conversationId) || null;
    if (!share) {
      const now = new Date().toISOString();
      let attempts = 0;
      while (!share && attempts < 6) {
        const token = buildConversationShareToken();
        try {
          stmts.insertConversationShare.run(token, conversationId, now, now);
          share = stmts.getConversationShareByToken.get(token) || null;
        } catch (error) {
          if (String(error?.code || '') !== 'SQLITE_CONSTRAINT_PRIMARYKEY') throw error;
        }
        attempts += 1;
      }
    }
    if (!share?.token) return res.status(500).json({ error: 'Failed to create share token' });
    const now = new Date().toISOString();
    stmts.touchConversationShare?.run(now, share.token);
    const token = String(share.token || '').trim();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      conversationId,
      token,
      shareUrl: buildShareUrl(req, token),
      path: `${String(remotePath || '').replace(/\/+$/, '')}/shared/${token}`.replace(/\/{2,}/g, '/'),
    });
  });

  app.get('/api/shared/:token', (req, res) => {
    const token = normalizeShareToken(req.params.token);
    if (!token) return res.status(404).json({ error: 'Shared conversation not found' });
    const share = stmts.getConversationShareByToken?.get(token) || null;
    if (!share || String(share.revoked_at || '').trim()) {
      return res.status(404).json({ error: 'Shared conversation not found' });
    }
    const convId = String(share.conversation_id || '').trim();
    if (!convId) return res.status(404).json({ error: 'Shared conversation not found' });
    const conv = stmts.getConvAnyStatus.get(convId) || null;
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') {
      return res.status(404).json({ error: 'Shared conversation not found' });
    }
    const limit = normalizeConversationHistoryLimit(req.query.limit, 120);
    const beforeMessageId = String(req.query.beforeMessageId || '').trim();
    const beforeTimestamp = String(req.query.beforeTimestamp || '').trim();
    const afterMessageId = String(req.query.afterMessageId || '').trim();
    const afterTimestamp = String(req.query.afterTimestamp || '').trim();
    const aroundMessageId = String(req.query.aroundMessageId || '').trim();
    const payload = buildConversationPayloadForShare({
      conv,
      shareToken: token,
      limit,
      beforeMessageId,
      beforeTimestamp,
      afterMessageId,
      afterTimestamp,
      aroundMessageId,
    });
    if (!payload) return res.status(404).json({ error: 'Shared conversation not found' });
    const sharedAccess = statusEventService.recordSharedAccess({
      shareToken: token,
      viewerIp: extractClientIp(req),
      conversationId: convId,
    });
    if (sharedAccess.event) {
      const details = sharedAccess.event.details;
      console.log(`SHARED ACCESS shareId=${details.shareId} ip=${details.viewerIp || 'unknown'}`);
      io.emit('shared_access', sharedAccess.event);
    }
    const now = new Date().toISOString();
    stmts.touchConversationShare?.run(now, token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.json({
      ...payload,
      shared: {
        token,
        readOnly: true,
        watcherCount: Number(getSharedWatcherCount?.(convId) || 0),
      },
    });
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

  app.post('/api/shared/:token/presence', (req, res) => {
    const token = normalizeShareToken(req.params.token);
    if (!token) return res.status(404).json({ error: 'Shared conversation not found' });
    const share = stmts.getConversationShareByToken?.get(token) || null;
    if (!share || String(share.revoked_at || '').trim()) {
      return res.status(404).json({ error: 'Shared conversation not found' });
    }
    const conversationId = String(share.conversation_id || '').trim();
    if (!conversationId) return res.status(404).json({ error: 'Shared conversation not found' });
    const rateLimit = consumeSharedPresenceRateLimit(token, req);
    if (!rateLimit.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds || 1));
      return res.status(429).json({
        error: 'Too many presence updates; retry shortly.',
        retryAfterSeconds: Number(rateLimit.retryAfterSeconds || 1),
      });
    }
    const viewerId = normalizeSharedViewerId(req.body?.viewerId || req.query?.viewerId);
    if (!viewerId) return res.status(400).json({ error: 'Missing viewer id' });
    const presence = typeof markSharedViewerPresence === 'function'
      ? markSharedViewerPresence({ conversationId, token, viewerId })
      : { ok: false, watcherCount: 0 };
    const now = new Date().toISOString();
    stmts.touchConversationShare?.run(now, token);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.json({
      ok: presence?.ok !== false,
      conversationId,
      watcherCount: Number(presence?.watcherCount || 0),
      capped: presence?.capped === true,
    });
  });

  app.get('/api/shared/:token/upload/:sha256/content', (req, res) => {
    const token = normalizeShareToken(req.params.token);
    const sha256 = String(req.params.sha256 || '').trim().toLowerCase();
    if (!token || !isSha256(sha256)) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const share = stmts.getConversationShareByToken?.get(token) || null;
    if (!share || String(share.revoked_at || '').trim()) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const conversationId = String(share.conversation_id || '').trim();
    if (!conversationId || !conversationReferencesUploadSha(conversationId, sha256)) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const file = stmts.getUploadFile.get(sha256);
    if (!file) return res.status(404).json({ error: 'Shared attachment not found' });
    const filePath = uploadPathForSha(sha256);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Missing file on disk' });
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream shared attachment' });
        return;
      }
      res.destroy();
    });
    stream.pipe(res);
  });

  app.get('/api/shared/:token/generated-image/:messageId/:imageId/content', (req, res) => {
    const token = normalizeShareToken(req.params.token);
    const messageId = String(req.params.messageId || '').trim();
    const imageId = String(req.params.imageId || '').trim();
    if (!token || !messageId || !imageId) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const share = stmts.getConversationShareByToken?.get(token) || null;
    if (!share || String(share.revoked_at || '').trim()) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const conversationId = String(share.conversation_id || '').trim();
    if (!conversationId) return res.status(404).json({ error: 'Shared attachment not found' });
    const rows = filterMessagesVisibleToSharedView(
      (stmts.getSharedMessages || stmts.getMessages).all(conversationId),
    );
    const messageRow = rows.find((row) => String(row?.id || '').trim() === messageId);
    if (!messageRow) return res.status(404).json({ error: 'Shared attachment not found' });
    const attachments = parseAttachments(messageRow?.attachments).map(hydrateAttachment).filter(Boolean);
    const attachment = attachments.find((entry) => String(entry?.generatedImage?.imageId || '').trim() === imageId);
    if (!attachment) return res.status(404).json({ error: 'Shared attachment not found' });

    const sessionId = String(attachment?.generatedImage?.sessionId || '').trim();
    const relativePath = String(attachment?.generatedImage?.relativePath || '').replace(/\\/g, '/').trim();
    const root = typeof resolveSessionStateRoot === 'function'
      ? String(resolveSessionStateRoot() || '').trim()
      : '';
    if (!root || !sessionId || !relativePath) return res.status(404).json({ error: 'Shared attachment not found' });
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    const normalizedRelative = path.posix.normalize(relativePath).replace(/^\/+/, '');
    if (!safeSession || !normalizedRelative || normalizedRelative.startsWith('..') || normalizedRelative.includes('/../')) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    const baseDir = path.resolve(path.join(root, safeSession, 'generated-images'));
    const filePath = path.resolve(path.join(baseDir, normalizedRelative));
    if (!(filePath === baseDir || filePath.startsWith(`${baseDir}${path.sep}`))) {
      return res.status(404).json({ error: 'Shared attachment not found' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Shared attachment not found' });
    res.setHeader('Content-Type', attachment.type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream shared attachment' });
        return;
      }
      res.destroy();
    });
    stream.pipe(res);
  });

  // GET /api/conversation/:id — get paginated conversation history
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
    const inFlight = inFlightStateForConversation(resolvedConversationId);
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
      resolveCursorSessionRoot,
    });
    const dbMessages = stmts.getMessages.all(resolvedConversationId);
    const queueRows = db.prepare(`
      SELECT id, response_message_id, text, timestamp, retry_count, reasoning_effort, model
      FROM queue
      WHERE conversation_id = ?
    `).all(resolvedConversationId);
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
    const usageByResponseMessageId = new Map(
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
      preferredRelayMode: preferences.preferredRelayMode,
      preferredModel: preferences.preferredModel,
      preferredReasoningEffort: preferences.preferredReasoningEffort,
      draftText: String(conv.draft_text || ''),
      draftUpdatedAt: conv.draft_updated_at || null,
      draftUpdatedByClientId: conv.draft_updated_by_client_id || null,
      messages: history.messages,
      pageInfo: history.pageInfo,
    });
  });

  app.patch('/api/conversation/:id/message/:messageId/share-visibility', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const messageId = String(req.params.messageId || '').trim();
    if (!conversationId || !messageId) {
      return res.status(400).json({ error: 'Missing conversation or message id' });
    }
    if (typeof req.body?.hiddenFromShares !== 'boolean') {
      return res.status(400).json({ error: 'hiddenFromShares must be a boolean' });
    }

    const conv = stmts.getConvAnyStatus.get(conversationId);
    if (!conv || String(conv.status || '').trim().toLowerCase() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const message = stmts.getMessageByConversation?.get(messageId, conversationId) || null;
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (getActiveQueueForMessage.get(conversationId, messageId, messageId)) {
      return res.status(409).json({ error: 'Message visibility can only change after the turn finishes' });
    }

    const hiddenFromShares = req.body.hiddenFromShares === true;
    const currentlyHidden = Number(message.hidden_from_shares || 0) === 1;
    if (currentlyHidden !== hiddenFromShares) {
      if (!stmts.setMessageShareVisibility) {
        return res.status(503).json({ error: 'Message share visibility is unavailable until the relay restarts' });
      }
      const now = new Date().toISOString();
      stmts.setMessageShareVisibility.run(
        hiddenFromShares ? 1 : 0,
        hiddenFromShares ? now : null,
        messageId,
        conversationId,
      );
    }

    return res.json({
      ok: true,
      conversationId,
      messageId,
      hiddenFromShares,
    });
  });

  app.patch('/api/conversation/:id', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const result = persistConversationTitle({
      db,
      stmts,
      io,
      conversationId,
      title: req.body?.title,
      resolveSessionStateRoot,
    });
    if (!result.ok) {
      return res.status(result.statusCode || 500).json({ error: result.error || 'Failed to update conversation title' });
    }
    return res.json({
      ok: true,
      conversationId: result.conversationId,
      title: result.title,
      updatedAt: result.updatedAt,
      created: result.created === true,
    });
  });

  app.patch('/api/conversation/:id/preferences', auth, (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    const senderClientId = String(req.body?.clientId || '').trim() || null;

    const existing = stmts.getConvAnyStatus.get(conversationId);
    if (existing && String(existing.status || '').trim() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const now = new Date().toISOString();
    const preferredRelayMode = normalizeRelayModePreference(req.body?.preferredRelayMode, {
      supportedRelayModes: SUPPORTED_RELAY_MODES,
      fallbackMode: DEFAULT_RELAY_MODE,
    });
    const preferredModel = normalizePreferredModel(req.body?.preferredModel);
    const preferredReasoningEffort = normalizePreferredReasoningEffort(req.body?.preferredReasoningEffort);
    const persisted = persistConversationPreferences({
      db,
      stmts,
      conversationId,
      preferredRelayMode,
      preferredModel,
      preferredReasoningEffort,
      updatedAt: now,
      createIfMissing: !existing,
      createTitle: 'Session',
    });

    io.emit('conversation_preferences_updated', {
      conversationId,
      preferredRelayMode: persisted.preferredRelayMode,
      preferredModel: persisted.preferredModel,
      preferredReasoningEffort: persisted.preferredReasoningEffort,
      updatedAt: persisted.updatedAt,
      senderClientId,
    });

    return res.json({
      ok: true,
      conversationId,
      preferredRelayMode: persisted.preferredRelayMode,
      preferredModel: persisted.preferredModel,
      preferredReasoningEffort: persisted.preferredReasoningEffort,
      updatedAt: persisted.updatedAt,
      created: persisted.created,
      senderClientId,
    });
  });

  app.patch('/api/conversation/:id/draft', auth, (req, res) => {
    const requestedId = String(req.params.id || '').trim();
    if (!requestedId) return res.status(400).json({ error: 'Missing conversation id' });
    const resolvedConversation = resolveConversationByIdOrSdkSessionId(requestedId);
    if (!resolvedConversation) return res.status(404).json({ error: 'Conversation not found' });
    const conversationId = String(resolvedConversation.id).trim();
    const senderClientId = String(req.body?.clientId || '').trim() || null;
    const existing = stmts.getConvAnyStatus.get(conversationId);
    if (!existing || String(existing.status || '').trim() === 'deleted') {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const baseDraftUpdatedAtValue = req.body?.baseDraftUpdatedAt ?? req.body?.base_draft_updated_at;
    const comparesDraftVersion = baseDraftUpdatedAtValue !== undefined;
    const normalizedBaseDraftUpdatedAt = normalizeOptionalIsoTimestamp(baseDraftUpdatedAtValue);
    const suppliedBaseTimestamp = String(baseDraftUpdatedAtValue ?? '').trim();
    if (comparesDraftVersion && suppliedBaseTimestamp && !normalizedBaseDraftUpdatedAt) {
      return res.status(400).json({ error: 'Invalid baseDraftUpdatedAt timestamp' });
    }
    const existingDraftUpdatedAt = normalizeOptionalIsoTimestamp(existing.draft_updated_at);
    if (hasConversationDraftVersionConflict({
      existingDraftUpdatedAt,
      baseDraftUpdatedAt: normalizedBaseDraftUpdatedAt,
      compareEnabled: comparesDraftVersion,
    })) {
      return res.status(409).json({
        ok: false,
        error: 'Draft version conflict',
        code: 'draft-version-conflict',
        conflict: true,
        conversationId,
        draftText: String(existing.draft_text || ''),
        draftUpdatedAt: existingDraftUpdatedAt,
        draftUpdatedByClientId: existing.draft_updated_by_client_id || null,
      });
    }
    const now = new Date().toISOString();
    const draftText = normalizeConversationDraftText(req.body?.draftText ?? req.body?.text);
    const persistedDraftText = draftText || null;
    if (typeof stmts.updateConvDraft?.run === 'function') {
      stmts.updateConvDraft.run(persistedDraftText, now, senderClientId, conversationId);
    } else {
      db.prepare(`
        UPDATE conversations
        SET draft_text = ?, draft_updated_at = ?, draft_updated_by_client_id = ?
        WHERE id = ?
      `).run(persistedDraftText, now, senderClientId, conversationId);
    }
    const payload = {
      conversationId,
      draftText: persistedDraftText || '',
      draftUpdatedAt: now,
      draftUpdatedByClientId: senderClientId,
      senderClientId,
    };
    io.emit('conversation_draft_updated', payload);
    return res.json({
      ok: true,
      ...payload,
    });
  });

  app.post('/api/conversation/:id/workspace-root', auth, async (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    const nextRootPath = readWorkspaceRootPathFromBody(req.body);
    if (!nextRootPath) {
      return res.status(400).json({ error: 'Missing rootPath' });
    }
    if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
      return res.status(500).json({ error: 'Conversation workspace updates are unavailable' });
    }
    const validated = validateRequestedWorkspaceRoot(nextRootPath, {
      allowList: workspaceRootAllowList,
    });
    if (!validated.ok) {
      return res.status(validated.code === 'root-path-not-allowed' ? 403 : 400)
        .json({ ok: false, code: validated.code, error: validated.error });
    }
    const rateLimited = consumeWorkspaceRootRateLimit(conversationId, req);
    if (!rateLimited.ok) {
      res.set('Retry-After', String(rateLimited.retryAfterSeconds));
      return res.status(429).json({ ok: false, code: 'rate-limited', error: 'Too many CWD updates. Try again shortly.' });
    }

    // Queue behind any in-flight relaunch for this session: otherwise this write
    // can swap the configured root between that relaunch's stop and its spawn.
    const lockSessionId = String(
      resolveConversationWorkspaceState?.({ conversationId })?.sdkSessionId || '',
    ).trim();
    const result = await sessionLaunchMutex.runExclusive(
      lockSessionId || `conv:${conversationId}`,
      () => updateConversationConfiguredWorkspaceRoot({
        conversationId,
        rootPath: validated.realPath,
      }),
    );

    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || 'Failed to update conversation workspace root' });
    }
    const state = result.state || null;
    const workspaceHints = workspaceRootPayload();
    io.emit('conversation_workspace_root_updated', {
      conversationId,
      sdkSessionId: state?.sdkSessionId || null,
      configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: state?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: state?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: state?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: state?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: state?.currentWorkspaceRootName || null,
      recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
    });
    return res.json({
      ok: true,
      conversationId,
      sdkSessionId: state?.sdkSessionId || null,
      configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: state?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: state?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: state?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: state?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: state?.currentWorkspaceRootName || null,
      recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
    });
  });

  // Performs one relaunch. Always runs under sessionLaunchMutex, so it may assume
  // no other launch-path request is interleaving with it.
  async function runWorkspaceRootRelaunch({ conversationId, sdkSessionId, rootPath }) {
    const worker = sessionWorkerSupervisor?.getWorkerState?.(sdkSessionId)
      || sessionWorkerRegistry?.getWorker?.(sdkSessionId)
      || null;
    const activeQueueCount = Number(countActiveConversationQueueRows.get(conversationId)?.count || 0);
    // A session that is not 'ready' can still own a live process (status 'error',
    // or no registry entry at all). Detect that, or the stop is skipped and the
    // launch silently reuses the old process in the old directory.
    const liveProcessDetected = !!sessionWorkerProcessInspector?.findProcessForSession?.(sdkSessionId);
    const eligibility = evaluateWorkspaceRootRelaunch({
      workerStatus: worker?.status,
      activeQueueCount,
      workerPidAlive: isPidAlive(worker?.pid),
      liveProcessDetected,
    });
    if (!eligibility.ok) {
      return { statusCode: eligibility.statusCode, body: { ok: false, code: 'relaunch-not-eligible', error: eligibility.error } };
    }

    const updateResult = updateConversationConfiguredWorkspaceRoot({ conversationId, rootPath });
    if (!updateResult?.ok) {
      return { statusCode: 400, body: { ok: false, error: updateResult?.error || 'Failed to update conversation workspace root' } };
    }
    const state = updateResult.state || null;

    let stoppedPids = [];
    if (eligibility.stopWorker) {
      const stopped = await stopIdleWorkspaceRootSession({
        sdkSessionId,
        worker,
        sessionWorkerSupervisor,
        sessionWorkerRegistry,
        sessionWorkerProcessInspector,
        stopOverrides: sessionWorkerStopOverrides,
      });
      if (!stopped.ok) {
        // Do not launch on top of a process we could not kill. The CWD is saved,
        // so the next clean launch will pick it up.
        return {
          statusCode: stopped.timedOut ? 409 : 500,
          body: {
            ok: false,
            code: stopped.timedOut ? 'worker-stop-timeout' : 'worker-stop-failed',
            remainingPids: stopped.remainingPids || [],
            configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
            workspaceRootApplied: false,
            error: stopped.timedOut
              ? 'Could not stop the running CLI. The CWD is saved for the next launch.'
              : (stopped.error || 'Failed to stop the running CLI'),
          },
        };
      }
      stoppedPids = stopped.stoppedPids || [];
    }

    // Every process is verified dead, so lift the kill block exactly once, here,
    // rather than letting the launch helper clear it as a side effect.
    sessionWorkerSupervisor?.clearRestartSchedule?.(sdkSessionId, { resetKilledMarker: true });

    const launched = await launchWorkspaceRootSession(
      runtimeState,
      sessionWorkerSupervisor,
      sdkSessionId,
      sessionWorkerRegistry,
      { allowProcessReuse: false, resetKilledMarker: false, requireStoppedWorker: false },
    );
    if (!launched?.ok) {
      return {
        statusCode: launched?.statusCode || 409,
        body: {
          ok: false,
          code: 'relaunch-failed',
          configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || null,
          workspaceRootApplied: false,
          error: launched?.error || 'Failed to relaunch the CLI',
        },
      };
    }

    // Belt and braces: if a process was reused anyway, or the "new" pid is one we
    // just tried to kill, the requested directory did not take. Say so.
    const launchedPid = Number(launched.worker?.pid) || null;
    // `state` was resolved before the stop, so its runtime/pending values still
    // describe the CLI we just killed. They are only meaningful for the reuse
    // check — never as the directory we report back.
    const preLaunchRootPath = state?.runtimeWorkspaceRootPath
      || (typeof getPendingSessionCwd === 'function' ? getPendingSessionCwd(sdkSessionId) : '')
      || '';
    const reusedExistingProcess = launched.reused === true
      || (launchedPid !== null && stoppedPids.includes(launchedPid));
    const reuseCheck = reusedExistingProcess
      ? evaluateReuseCwdMismatch({ requestedRootPath: rootPath, observedRootPath: preLaunchRootPath })
      : { comparable: false, mismatch: false };
    const workspaceRootApplied = !reusedExistingProcess && !(reuseCheck.comparable && reuseCheck.mismatch);

    // A fresh process launched in the requested directory, so the stale runtime
    // root (and the pending CWD reported by the dead CLI) must be replaced now.
    // Waiting for the new CLI's session-sync leaves every client showing the old
    // CWD in the header and the file explorer until the next turn.
    let effectiveState = state;
    if (workspaceRootApplied) {
      if (typeof consumePendingSessionCwd === 'function') consumePendingSessionCwd(sdkSessionId);
      const learned = typeof learnConversationWorkspaceRoot === 'function'
        ? learnConversationWorkspaceRoot({
          conversationId,
          sdkSessionId,
          rootPath,
          seedConfigured: false,
        })
        : null;
      effectiveState = (learned?.ok && learned.state)
        ? learned.state
        // The persist call is the only thing that can fail here, and the root was
        // already validated as an existing directory. Report the applied CWD
        // anyway so clients never render the directory of the process we killed.
        : {
          ...(state || {}),
          runtimeWorkspaceRootPath: rootPath,
          runtimeWorkspaceRootName: workspaceRootDisplayName(rootPath),
          currentWorkspaceRootPath: rootPath,
          currentWorkspaceRootName: workspaceRootDisplayName(rootPath),
        };
    }

    const workspaceHints = workspaceRootPayload();
    io.emit('conversation_workspace_root_updated', {
      conversationId,
      sdkSessionId,
      configuredWorkspaceRootPath: effectiveState?.configuredWorkspaceRootPath || null,
      configuredWorkspaceRootName: effectiveState?.configuredWorkspaceRootName || null,
      runtimeWorkspaceRootPath: effectiveState?.runtimeWorkspaceRootPath || null,
      runtimeWorkspaceRootName: effectiveState?.runtimeWorkspaceRootName || null,
      currentWorkspaceRootPath: effectiveState?.currentWorkspaceRootPath || null,
      currentWorkspaceRootName: effectiveState?.currentWorkspaceRootName || null,
      workspaceRootApplied,
      recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        conversationId,
        sdkSessionId,
        ...effectiveState,
        relaunched: workspaceRootApplied,
        workspaceRootApplied,
        reusedExistingProcess,
        stoppedPids,
        launchedPid,
        ...(workspaceRootApplied ? {} : {
          warning: 'cwd-not-applied',
          activeWorkspaceRootPath: preLaunchRootPath || null,
          message: 'CWD saved for the next launch, but the running CLI kept its current directory.',
        }),
        worker: launched.worker || null,
        lifecycle: launched.lifecycle || null,
      },
    };
  }

  app.post('/api/conversation/:id/relaunch-with-workspace-root', auth, async (req, res) => {
    const conversationId = String(req.params.id || '').trim();
    const rootPath = readWorkspaceRootPathFromBody(req.body);
    if (!conversationId) return res.status(400).json({ error: 'Missing conversation id' });
    if (!rootPath) return res.status(400).json({ error: 'Missing rootPath' });
    if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
      return res.status(500).json({ error: 'Conversation workspace updates are unavailable' });
    }

    const validated = validateRequestedWorkspaceRoot(rootPath, { allowList: workspaceRootAllowList });
    if (!validated.ok) {
      return res.status(validated.code === 'root-path-not-allowed' ? 403 : 400)
        .json({ ok: false, code: validated.code, error: validated.error });
    }

    const workspaceState = resolveConversationWorkspaceState?.({ conversationId }) || null;
    const sdkSessionId = String(workspaceState?.sdkSessionId || '').trim();
    if (!sdkSessionId) {
      return res.status(409).json({ error: 'Open a conversation with a bound session before relaunching.' });
    }

    const rateLimited = consumeWorkspaceRootRateLimit(sdkSessionId, req);
    if (!rateLimited.ok) {
      res.set('Retry-After', String(rateLimited.retryAfterSeconds));
      return res.status(429).json({ ok: false, code: 'rate-limited', error: 'Too many relaunch requests. Try again shortly.' });
    }

    const requestKey = buildRelaunchRequestKey({
      conversationId,
      rootPath: validated.realPath,
      idempotencyKey: req.headers?.['idempotency-key'] || req.body?.idempotencyKey,
    });

    // A duplicated request (mobile ghost tap, a second tab, a retried fetch) must
    // replay one result rather than driving a second stop/spawn cycle.
    const pending = relaunchCoalescer.peek(sdkSessionId, requestKey);
    if (pending.state === 'in-flight') {
      const shared = await pending.promise;
      return res.status(shared.statusCode).json({ ...shared.body, coalesced: true });
    }
    if (pending.state === 'cached') {
      return res.status(pending.result.statusCode).json({ ...pending.result.body, coalesced: true, cached: true });
    }
    if (pending.state === 'busy') {
      return res.status(409).json({
        ok: false,
        code: 'relaunch_in_progress',
        sdkSessionId,
        retryAfterMs: RELAUNCH_COALESCE_WINDOW_MS,
        error: 'A different CWD change is already running for this session.',
      });
    }

    const { settle } = relaunchCoalescer.begin(sdkSessionId, requestKey);
    let outcome;
    try {
      const attempt = await sessionLaunchMutex.tryRunExclusive(sdkSessionId, () => runWorkspaceRootRelaunch({
        conversationId,
        sdkSessionId,
        rootPath: validated.realPath,
      }));
      outcome = attempt.busy
        ? {
          statusCode: 409,
          body: {
            ok: false,
            code: 'relaunch_in_progress',
            sdkSessionId,
            retryAfterMs: RELAUNCH_COALESCE_WINDOW_MS,
            error: 'A different CWD change is already running for this session.',
          },
        }
        : attempt.result;
    } catch (error) {
      outcome = { statusCode: 500, body: { ok: false, code: 'relaunch-error', error: error?.message || 'Failed to relaunch the CLI' } };
    }
    relaunchCoalescer.settle(sdkSessionId, requestKey, outcome);
    settle(outcome);
    return res.status(outcome.statusCode).json(outcome.body);
  });

  app.post('/api/conversation/:id/compact', auth, (req, res) => {
    const sourceConversationId = req.params.id;
    const compacted = createCompactedConversation(sourceConversationId);
    if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
    io.emit('conversation_compacted', compacted);
    res.json({
      ok: true,
      sourceConversationId: compacted.sourceConversationId,
      compactedConversationId: compacted.targetConversationId,
      conversationId: compacted.targetConversationId,
      runtimeSessionId: compacted.runtimeSessionId,
      summarySeedPreview: compacted.summarySeed.slice(0, 240),
    });
  });

  // DELETE /api/conversation/:id — delete conversation
  app.delete('/api/conversation/:id', auth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });

    const existing = stmts.getConvAnyStatus.get(id);
    if (!existing) {
      return res.json({ ok: true, alreadyDeleted: true });
    }

    try {
      const sdkSessionId = String(existing.sdk_session_id || '').trim() || null;
      if (!sdkSessionId) {
        stmts.markDeletedSdkSession.run(id, new Date().toISOString());
        cleanupGeneratedImagesForConversation({
          conversationId: id,
          sdkSessionId: null,
          messageRows: stmts.getMessages?.all?.(id) || [],
          parseAttachments,
          hydrateAttachment,
          resolveSessionStateRoot,
        });
        const orphanedUploads = collectOrphanedUploadsFromConversation(id);
        hardDeleteConversationRows(id);
        deleteOrphanedUploads(orphanedUploads);
        io.emit('conversation_deleted', { conversationId: id });
        return res.json({ ok: true });
      }

      markConversationDeleted.run(new Date().toISOString(), id);
      stmts.markDeletedSdkSession.run(sdkSessionId, new Date().toISOString());
      if (sdkSessionId !== id) {
        // Also tombstone the conversation id itself for legacy/synthetic sdk id fallback paths.
        stmts.markDeletedSdkSession.run(id, new Date().toISOString());
      }
      enqueueSdkDeleteRequest(sdkSessionId, id);
      const awaited = await waitForSdkDeleteCompletion(sdkSessionId);
      if (awaited.completed) return res.json({ ok: true });

      io.emit('conversation_delete_pending', { conversationId: id });
      return res.json({ ok: true, pending: true });
    } catch (error) {
      console.warn(`[archive] Delete failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to delete conversation' });
    }
  });

  // POST /api/conversation/:id/archive — archive conversation
  app.post('/api/conversation/:id/archive', auth, async (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing conversation id' });
    try {
      const existing = stmts.getConvAnyStatus.get(id);
      if (!existing || String(existing.status || '').trim() === 'deleted') {
        return res.json({ ok: true, alreadyDeleted: true });
      }
      db.prepare(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
      io.emit('conversation_archived', { conversationId: id });
      return res.json({ ok: true });
    } catch (error) {
      console.warn(`[archive] Archive failed for ${id}: ${error?.message || error}`);
      return res.status(500).json({ error: 'Failed to archive conversation' });
    }
  });

  app.post('/api/conversation/bootstrap', auth, async (req, res) => {
    const clientSessionId = String(ensureSessionId(req, res) || '').trim();
    const now = new Date().toISOString();
    let conversationId = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = randomUUID();
      if (!stmts.getConvAnyStatus.get(candidate)) {
        conversationId = candidate;
        break;
      }
    }
    if (!conversationId) {
      return res.status(500).json({ ok: false, error: 'Failed to allocate conversation id' });
    }

    const requestedTitle = String(req.body?.title || '').trim();
    const title = (requestedTitle || 'New Conversation').slice(0, 80);
    const openAISettings = getOpenAIProviderSettings();
    const requestedProviderType = normalizeRequestedProviderType(req.body?.providerType || req.body?.provider);
    const modelState = buildModelCatalogWithProviders(
      getModelCatalogState(),
      openAISettings,
    );
    const catalogSelectedModel = resolveBootstrapModelSelection({
      requestedModel: req.body?.model,
      modelState,
      defaultModel: DEFAULT_MODEL,
    });
    const requestedBootstrapModel = String(req.body?.model || '').trim();
    const availableOpenAIModels = new Set([
      String(openAISettings?.model || '').trim(),
      ...(Array.isArray(openAISettings?.models) ? openAISettings.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean));
    if (
      (requestedProviderType === 'openai' || requestedProviderType === 'openai-image')
      && requestedBootstrapModel
      && requestedBootstrapModel.toLowerCase() !== 'auto'
      && !availableOpenAIModels.has(requestedBootstrapModel)
    ) {
      return res.status(400).json({
        ok: false,
        error: `OpenAI model "${requestedBootstrapModel}" is not available`,
        code: 'OPENAI_MODEL_UNAVAILABLE',
      });
    }
    const claudeSettings = getClaudeProviderSettings();
    // Include base ids of "[1m]" long-context variants: the composer and the
    // new-conversation modal only ever offer base ids (the 1M tier is picked
    // via the context-size dropdown).
    const availableClaudeModels = new Set([
      String(claudeSettings?.model || '').trim(),
      ...(Array.isArray(claudeSettings?.models) ? claudeSettings.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean)
      .flatMap((value) => [value, value.replace(CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN, '')])
      .filter(Boolean));
    if (
      requestedProviderType === 'claude'
      && requestedBootstrapModel
      && requestedBootstrapModel.toLowerCase() !== 'auto'
      && !availableClaudeModels.has(requestedBootstrapModel)
    ) {
      return res.status(400).json({
        ok: false,
        error: `Claude model "${requestedBootstrapModel}" is not available`,
        code: 'CLAUDE_MODEL_UNAVAILABLE',
      });
    }
    const cursorSettings = getCursorProviderSettings();
    const availableCursorModels = new Set([
      String(cursorSettings?.model || '').trim(),
      ...(Array.isArray(cursorSettings?.models) ? cursorSettings.models : []),
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
    if (
      requestedProviderType === 'cursor'
      && requestedBootstrapModel
      && requestedBootstrapModel.toLowerCase() !== 'auto'
      && !availableCursorModels.has(requestedBootstrapModel.toLowerCase())
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Requested Cursor model is not available',
        code: 'CURSOR_MODEL_UNAVAILABLE',
      });
    }
    const grokSettings = getGrokProviderSettings();
    const availableGrokModels = new Set([
      String(grokSettings?.model || '').trim(),
      ...(Array.isArray(grokSettings?.models) ? grokSettings.models : []),
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));
    if (
      requestedProviderType === 'grok'
      && requestedBootstrapModel
      && requestedBootstrapModel.toLowerCase() !== 'auto'
      && !availableGrokModels.has(requestedBootstrapModel.toLowerCase())
    ) {
      return res.status(400).json({
        ok: false,
        error: 'Requested Grok model is not available',
        code: 'GROK_MODEL_UNAVAILABLE',
      });
    }
    const useOpenAIProvider = requestedProviderType === 'openai'
      || requestedProviderType === 'openai-image'
      || (
        requestedProviderType === ''
        && requestedBootstrapModel
        && requestedBootstrapModel.toLowerCase() !== 'auto'
        && availableOpenAIModels.has(requestedBootstrapModel)
      );
    const useClaudeProvider = !useOpenAIProvider && (
      requestedProviderType === 'claude'
      || (
        requestedProviderType === ''
        && requestedBootstrapModel
        && requestedBootstrapModel.toLowerCase() !== 'auto'
        && availableClaudeModels.has(requestedBootstrapModel)
      )
    );
    const useCursorProvider = !useOpenAIProvider && !useClaudeProvider && (
      requestedProviderType === 'cursor'
      || (
        requestedProviderType === ''
        && requestedBootstrapModel
        && requestedBootstrapModel.toLowerCase() !== 'auto'
        && availableCursorModels.has(requestedBootstrapModel.toLowerCase())
      )
    );
    const useGrokProvider = !useOpenAIProvider && !useClaudeProvider && !useCursorProvider && (
      requestedProviderType === 'grok'
      || (
        requestedProviderType === ''
        && requestedBootstrapModel
        && requestedBootstrapModel.toLowerCase() !== 'auto'
        && availableGrokModels.has(requestedBootstrapModel.toLowerCase())
      )
    );
    if (useOpenAIProvider && openAISettings?.configured !== true) {
      return res.status(400).json({
        ok: false,
        error: 'OpenAI API key is not configured',
        code: 'OPENAI_NOT_CONFIGURED',
      });
    }
    if (useClaudeProvider && claudeSettings?.enabled !== true) {
      return res.status(400).json({
        ok: false,
        error: 'Claude provider is not enabled',
        code: 'CLAUDE_NOT_CONFIGURED',
      });
    }
    if (useCursorProvider && cursorSettings?.configured !== true) {
      return res.status(400).json({
        ok: false,
        error: 'Cursor API key is not configured',
        code: 'CURSOR_NOT_CONFIGURED',
      });
    }
    if (useGrokProvider && grokSettings?.enabled !== true) {
      return res.status(400).json({
        ok: false,
        error: 'Grok provider is not enabled',
        code: 'GROK_NOT_CONFIGURED',
      });
    }

    // Optional launch CWD from the New Chat modal. Validated before insertConv
    // so a rejected path never leaves an orphaned conversation behind.
    const requestedWorkspaceRootPath = readWorkspaceRootPathFromBody(req.body);
    let bootstrapWorkspaceRootPath = '';
    if (requestedWorkspaceRootPath) {
      const validatedRoot = validateRequestedWorkspaceRoot(requestedWorkspaceRootPath, {
        allowList: workspaceRootAllowList,
      });
      if (!validatedRoot.ok) {
        return res.status(validatedRoot.code === 'root-path-not-allowed' ? 403 : 400)
          .json({ ok: false, code: validatedRoot.code, error: validatedRoot.error });
      }
      // Keyed on the browser session: there is no conversation id yet.
      const rateLimited = consumeWorkspaceRootRateLimit(clientSessionId || 'bootstrap', req);
      if (!rateLimited.ok) {
        res.set?.('Retry-After', String(rateLimited.retryAfterSeconds));
        return res.status(429).json({ ok: false, code: 'rate-limited', error: 'Too many CWD updates. Try again shortly.' });
      }
      bootstrapWorkspaceRootPath = validatedRoot.realPath;
    }

    const selectedModel = useOpenAIProvider
      ? resolveOpenAISessionModel({
          requestedModel: catalogSelectedModel,
          configuredModel: openAISettings.model,
          availableModels: openAISettings.models,
        })
      : (useClaudeProvider
        ? resolveOpenAISessionModel({
            requestedModel: catalogSelectedModel,
            configuredModel: claudeSettings.model,
            availableModels: Array.from(availableClaudeModels),
          })
        : (useCursorProvider
          ? resolveOpenAISessionModel({
              requestedModel: catalogSelectedModel,
              configuredModel: cursorSettings.model,
              availableModels: Array.from(availableCursorModels),
            })
          : (useGrokProvider
            ? resolveOpenAISessionModel({
                requestedModel: catalogSelectedModel,
                configuredModel: grokSettings.model,
                availableModels: Array.from(availableGrokModels),
              })
            : catalogSelectedModel)));
    if (requestedProviderType === 'openai-image' && !isOpenAIImageModelId(selectedModel)) {
      return res.status(400).json({
        ok: false,
        error: `OpenAI image provider requires an image model (received "${selectedModel}")`,
        code: 'OPENAI_IMAGE_MODEL_REQUIRED',
      });
    }
    if (!useOpenAIProvider && !useClaudeProvider && !useCursorProvider && !useGrokProvider) {
      const selectedProviders = Array.isArray(modelState?.providersByModel?.[String(selectedModel || '').trim().toLowerCase()])
        ? modelState.providersByModel[String(selectedModel || '').trim().toLowerCase()]
        : [];
      const openAIOnlySelection = selectedProviders.length > 0
        && selectedProviders.every((provider) => String(provider || '').trim().toLowerCase() === 'openai-byok');
      if (openAIOnlySelection) {
        return res.status(400).json({
          ok: false,
          error: `Model "${selectedModel}" requires the OpenAI provider`,
          code: 'OPENAI_PROVIDER_REQUIRED',
        });
      }
      const claudeOnlySelection = selectedProviders.length > 0
        && selectedProviders.every((provider) => String(provider || '').trim().toLowerCase() === 'claude');
      if (claudeOnlySelection) {
        return res.status(400).json({
          ok: false,
          error: `Model "${selectedModel}" requires the Claude provider`,
          code: 'CLAUDE_PROVIDER_REQUIRED',
        });
      }
      const cursorOnlySelection = selectedProviders.length > 0
        && selectedProviders.every((provider) => String(provider || '').trim().toLowerCase() === 'cursor');
      if (cursorOnlySelection) {
        return res.status(400).json({
          ok: false,
          error: `Model "${selectedModel}" requires the Cursor provider`,
          code: 'CURSOR_PROVIDER_REQUIRED',
        });
      }
      const grokOnlySelection = selectedProviders.length > 0
        && selectedProviders.every((provider) => String(provider || '').trim().toLowerCase() === 'grok');
      if (grokOnlySelection) {
        return res.status(400).json({
          ok: false,
          error: `Model "${selectedModel}" requires the Grok provider`,
          code: 'GROK_PROVIDER_REQUIRED',
        });
      }
    }

    try {
      stmts.insertConv.run(conversationId, title, now, now);
      const bootstrapProviderType = useOpenAIProvider
        ? 'openai'
        : (useClaudeProvider
          ? 'claude'
          : (useCursorProvider
            ? 'cursor'
            : (useGrokProvider ? 'grok' : 'github')));
      const runtimeSession = ensureRuntimeSessionBinding(
        conversationId,
        selectedModel,
        now,
        conversationId,
        {
          assignConfiguredProvider: true,
          providerType: bootstrapProviderType,
          providerModel: (useOpenAIProvider || useClaudeProvider || useCursorProvider || useGrokProvider) ? selectedModel : null,
        },
      );
      // Seed the configured root before ensureWorker so the very first launch
      // already happens in the requested directory (resolveLaunchWorkspaceRootForSession
      // prefers it over the relay default).
      let workspaceRootState = null;
      let workspaceRootWarning = null;
      if (bootstrapWorkspaceRootPath) {
        const workspaceRootResult = typeof updateConversationConfiguredWorkspaceRoot === 'function'
          ? updateConversationConfiguredWorkspaceRoot({ conversationId, rootPath: bootstrapWorkspaceRootPath })
          : null;
        if (workspaceRootResult?.ok) {
          workspaceRootState = workspaceRootResult.state || null;
          const workspaceHints = workspaceRootPayload();
          io.emit('conversation_workspace_root_updated', {
            conversationId,
            sdkSessionId: workspaceRootState?.sdkSessionId || null,
            configuredWorkspaceRootPath: workspaceRootState?.configuredWorkspaceRootPath || null,
            configuredWorkspaceRootName: workspaceRootState?.configuredWorkspaceRootName || null,
            runtimeWorkspaceRootPath: workspaceRootState?.runtimeWorkspaceRootPath || null,
            runtimeWorkspaceRootName: workspaceRootState?.runtimeWorkspaceRootName || null,
            currentWorkspaceRootPath: workspaceRootState?.currentWorkspaceRootPath || null,
            currentWorkspaceRootName: workspaceRootState?.currentWorkspaceRootName || null,
            recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
          });
        } else {
          // The directory passed validation moments ago, so a failure here is a
          // race (deleted or unmounted since). Start the chat anyway and say so.
          workspaceRootWarning = `The chat was created, but its working directory could not be set: ${workspaceRootResult?.error || 'unknown error'}. It starts in the default directory.`;
        }
      }
      const routingEnabled = featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true;
      const ownerSessionId = routingEnabled ? conversationId : null;
      if (ownerSessionId && typeof sessionWorkerSupervisor?.ensureWorker === 'function') {
        sessionWorkerSupervisor?.clearRestartSchedule?.(ownerSessionId, { resetKilledMarker: true });
        const ensureResult = await sessionWorkerSupervisor.ensureWorker(ownerSessionId);
        if (!ensureResult?.ok) {
          return res.status(409).json({
            ok: false,
            error: ensureResult?.error || 'worker-bootstrap-failed',
            conversationId,
            runtimeSessionId: runtimeSession?.id || null,
            ownerSessionId,
            worker: ensureResult?.worker || null,
            lifecycle: ensureResult?.lifecycle || null,
            ...workspaceRootPayload(),
          });
        }
        const workerState = ensureResult.worker || sessionWorkerSupervisor?.getWorkerState?.(ownerSessionId) || null;
        sessionWorkerRegistry?.upsertWorker?.({
          ...(workerState || {}),
          sdkSessionId: ownerSessionId,
          conversationId,
          runtimeSessionId: runtimeSession?.id || null,
          status: workerState?.status || 'ready',
        });
        const pendingDepth = Number(queueCounts?.().pendingCount || 0);
        sessionWorkerSupervisor?.markIdle?.(ownerSessionId, pendingDepth);
      } else if (ownerSessionId) {
        return res.status(500).json({
          ok: false,
          error: 'session-worker-launcher-unavailable',
          conversationId,
          runtimeSessionId: runtimeSession?.id || null,
          ownerSessionId,
          ...workspaceRootPayload(),
        });
      }

      const conversation = stmts.getConvAnyStatus.get(conversationId) || null;
      const ownerWorker = ownerSessionId
        ? (sessionWorkerSupervisor?.getWorkerState?.(ownerSessionId) || sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null)
        : null;
      return res.json({
        ok: true,
        conversationId,
        conversation,
        runtimeSessionId: runtimeSession?.id || null,
        ownerSessionId,
        worker: ownerWorker,
        lifecycle: ownerSessionId ? (sessionWorkerSupervisor?.getLifecycleState?.(ownerSessionId) || null) : null,
        selectedModel,
        selectedProviderType: useOpenAIProvider ? 'openai' : (useClaudeProvider ? 'claude' : (useCursorProvider ? 'cursor' : 'github')),
        configuredWorkspaceRootPath: workspaceRootState?.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: workspaceRootState?.configuredWorkspaceRootName || null,
        currentWorkspaceRootPath: workspaceRootState?.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: workspaceRootState?.currentWorkspaceRootName || null,
        workspaceRootWarning,
        warning: routingEnabled ? null : 'Session worker routing is disabled; worker prestart skipped.',
        ...workspaceRootPayload(),
      });
    } catch (error) {
      console.warn(`[bootstrap] conversation bootstrap failed: ${error?.message || error}`);
      return res.status(500).json({
        ok: false,
        error: 'Failed to bootstrap conversation session',
      });
    }
  });

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
      featureFlags,
      supervisorSnapshot: sessionWorkerSupervisor?.snapshot?.({ pendingQuestionSessionIds }) || null,
      queueRows: listSessionWorkerQueueRows.all(...SESSION_WORKER_STATUS_QUEUE_STATES),
    });
    const activeRuntimeSessionCount = featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true
      ? Number(sessionWorkerStatus?.onlineBoundProcessCount || 0)
      : runtimeSessionBindingCount;
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
      workerWebSocket: runtimeState.workerWebSocketStatus || null,
      tmuxInspector: runtimeState.tmuxInspectorStatus || null,
      activeBridgeOwner: runtimeState.activeBridgeOwner || null,
      restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      relayShutdown: runtimeState.relayShutdown || null,
      platform: process.platform,
      features: featureFlags || {},
      sessionWorker: sessionWorkerStatus,
    });
  });

  app.post('/api/settings/default-session-workspace-root', auth, (req, res) => {
    const parsedRequest = parseDefaultSessionWorkspaceRootUpdateRequest(req.body);
    if (!parsedRequest.ok) {
      return res.status(400).json({ error: parsedRequest.error || 'Missing rootPath' });
    }
    const nextRootPath = parsedRequest.rootPath;
    if (typeof setDefaultSessionWorkspaceRootPath !== 'function') {
      return res.status(500).json({ error: 'Default session workspace updates are unavailable' });
    }
    const result = setDefaultSessionWorkspaceRootPath(nextRootPath, { allowClear: true });
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || 'Failed to update default session workspace root' });
    }
    const payload = workspaceRootPayload();
    io.emit('workspace_root_changed', payload);
    return res.json({
      ok: true,
      changed: !!result?.changed,
      defaultSessionWorkspaceRootPath: payload.defaultSessionWorkspaceRootPath || null,
      defaultSessionWorkspaceRootWarning: payload.defaultSessionWorkspaceRootWarning || null,
      recentWorkspaceRoots: Array.isArray(payload.recentWorkspaceRoots) ? payload.recentWorkspaceRoots : [],
    });
  });

  app.get('/api/settings/openai', auth, (_req, res) => {
    const settings = getOpenAIProviderSettings();
    return res.json({
      configured: settings?.configured === true,
      enabled: settings?.enabled === true,
      model: String(settings?.model || 'gpt-4o').trim() || 'gpt-4o',
      baseUrl: String(settings?.baseUrl || 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
    });
  });

  app.post('/api/settings/openai', auth, async (req, res) => {
    const parsed = parseOpenAISettingsUpdateRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const previous = getOpenAIProviderSettings();
    const result = setOpenAIProviderSettings(parsed);
    if (!result?.ok) {
      const statusCode = result?.code === 'openai-key-removal-blocked' ? 409 : 400;
      return res.status(statusCode).json({
        error: result?.error || 'Failed to update OpenAI settings',
        code: result?.code || null,
        activeConversationCount: Number(result?.activeConversationCount || 0),
        startedConversationCount: Number(result?.startedConversationCount || 0),
        activeQueueConversationCount: Number(result?.activeQueueConversationCount || 0),
      });
    }
    const shouldDiscover = result.enabled === true && (
      !!parsed.apiKey
      || previous?.enabled !== true
      || previous?.model !== result.model
      || (
        Object.prototype.hasOwnProperty.call(parsed, 'baseUrl')
        && String(previous?.baseUrl || '').trim() !== String(result?.baseUrl || '').trim()
      )
    );
    const discovery = !shouldDiscover
      ? { ok: true, models: [], error: null }
      : await refreshOpenAIProviderModels();
    const reconciliationResult = parsed.remove === true
      ? await reconcileUnstartedConversationProviders({
          enabled: false,
          model: result.model,
        })
      : {
          updatedUnstartedConversations: 0,
          skippedStartedConversations: 0,
          skippedActiveQueueConversations: 0,
          failedConversations: [],
        };
    const reconciliation = {
      updatedUnstartedConversations: Number(reconciliationResult?.updatedUnstartedConversations || 0),
      skippedStartedConversations: Number(reconciliationResult?.skippedStartedConversations || 0),
      skippedActiveQueueConversations: Number(reconciliationResult?.skippedActiveQueueConversations || 0),
      failedConversations: Array.isArray(reconciliationResult?.failedConversations)
        ? reconciliationResult.failedConversations
        : [],
    };
    const currentSettings = getOpenAIProviderSettings();
    const settingsPayload = {
      configured: currentSettings?.configured === true,
      enabled: currentSettings?.enabled === true,
      model: String(currentSettings?.model || result.model || 'gpt-4o').trim() || 'gpt-4o',
      baseUrl: String(currentSettings?.baseUrl || 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
      reconciliation,
    };
    io.emit('models_updated', buildModelCatalogWithProviders(
      getModelCatalogState(),
      currentSettings,
    ));
    io.emit('openai_settings_updated', settingsPayload);
    const reconciliationFailures = Array.isArray(reconciliation?.failedConversations)
      ? reconciliation.failedConversations
      : [];
    return res.json({
      ok: true,
      ...settingsPayload,
      models: Array.isArray(discovery?.models) ? discovery.models : [],
      warning: reconciliationFailures.length
        ? `${reconciliationFailures.length} unstarted conversation(s) could not switch provider.`
        : (discovery?.ok ? null : (discovery?.error || 'OpenAI model discovery failed')),
    });
  });

  app.get('/api/settings/claude', auth, (_req, res) => {
    const settings = getClaudeProviderSettings();
    return res.json({
      configured: settings?.configured === true,
      enabled: settings?.enabled === true,
      model: String(settings?.model || 'claude-sonnet-5').trim() || 'claude-sonnet-5',
      models: Array.isArray(settings?.models) ? settings.models : [],
      availableModels: Array.isArray(settings?.availableModels) ? settings.availableModels : [],
    });
  });

  app.post('/api/settings/claude', auth, async (req, res) => {
    const parsed = parseClaudeSettingsUpdateRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const previous = getClaudeProviderSettings();
    const result = setClaudeProviderSettings(parsed);
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || 'Failed to update Claude settings' });
    }
    const shouldDiscover = result.enabled === true && (
      previous?.enabled !== true
      || previous?.model !== result.model
      || previous?.modelsDiscovered !== true
    );
    const discovery = !shouldDiscover
      ? { ok: true, models: [], error: null }
      : await refreshClaudeProviderModels();
    // Disabling Claude rebinds unstarted Claude conversations back to the
    // default provider (mirrors the OpenAI key-removal reconciliation).
    const reconciliationResult = parsed.enabled === false
      ? await reconcileUnstartedConversationProviders({
          enabled: false,
          model: result.model,
          provider: 'claude',
        })
      : {
          updatedUnstartedConversations: 0,
          skippedStartedConversations: 0,
          skippedActiveQueueConversations: 0,
          failedConversations: [],
        };
    const reconciliation = {
      updatedUnstartedConversations: Number(reconciliationResult?.updatedUnstartedConversations || 0),
      skippedStartedConversations: Number(reconciliationResult?.skippedStartedConversations || 0),
      skippedActiveQueueConversations: Number(reconciliationResult?.skippedActiveQueueConversations || 0),
      failedConversations: Array.isArray(reconciliationResult?.failedConversations)
        ? reconciliationResult.failedConversations
        : [],
    };
    const currentSettings = getClaudeProviderSettings();
    const settingsPayload = {
      configured: currentSettings?.configured === true,
      enabled: currentSettings?.enabled === true,
      model: String(currentSettings?.model || result.model || 'claude-sonnet-5').trim() || 'claude-sonnet-5',
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      availableModels: Array.isArray(currentSettings?.availableModels) ? currentSettings.availableModels : [],
      reconciliation,
    };
    io.emit('models_updated', buildModelCatalogWithProviders(getModelCatalogState()));
    io.emit('claude_settings_updated', settingsPayload);
    const reconciliationFailures = Array.isArray(reconciliation?.failedConversations)
      ? reconciliation.failedConversations
      : [];
    return res.json({
      ok: true,
      ...settingsPayload,
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      warning: reconciliationFailures.length
        ? `${reconciliationFailures.length} unstarted conversation(s) could not switch provider.`
        : (discovery?.ok ? null : (discovery?.error || 'Claude model discovery failed')),
    });
  });

  app.get('/api/settings/grok', auth, (_req, res) => {
    const settings = getGrokProviderSettings();
    return res.json({
      configured: settings?.configured === true,
      enabled: settings?.enabled === true,
      model: String(settings?.model || 'grok-4.5').trim() || 'grok-4.5',
      models: Array.isArray(settings?.models) ? settings.models : [],
      availableModels: Array.isArray(settings?.availableModels) ? settings.availableModels : [],
    });
  });

  app.post('/api/settings/grok', auth, async (req, res) => {
    const parsed = parseGrokSettingsUpdateRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const previous = getGrokProviderSettings();
    const result = setGrokProviderSettings(parsed);
    if (!result?.ok) {
      return res.status(400).json({
        error: result?.error || 'Failed to update Grok settings',
      });
    }
    const shouldDiscover = result.enabled === true && (
      previous?.enabled !== true
      || previous?.model !== result.model
      || previous?.modelsDiscovered !== true
    );
    const discovery = !shouldDiscover
      ? { ok: true, models: [], error: null }
      : await refreshGrokProviderModels();
    const reconciliationResult = await reconcileUnstartedConversationProviders({
      enabled: result.enabled === true,
      model: result.model,
      provider: 'grok',
    });
    const reconciliation = {
      updatedUnstartedConversations: Number(reconciliationResult?.updatedUnstartedConversations || 0),
      skippedStartedConversations: Number(reconciliationResult?.skippedStartedConversations || 0),
      skippedActiveQueueConversations: Number(reconciliationResult?.skippedActiveQueueConversations || 0),
      failedConversations: Array.isArray(reconciliationResult?.failedConversations)
        ? reconciliationResult.failedConversations
        : [],
    };
    const currentSettings = getGrokProviderSettings();
    const settingsPayload = {
      configured: currentSettings?.configured === true,
      enabled: currentSettings?.enabled === true,
      model: String(currentSettings?.model || result.model || 'grok-4.5').trim() || 'grok-4.5',
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      availableModels: Array.isArray(currentSettings?.availableModels) ? currentSettings.availableModels : [],
      reconciliation,
    };
    io.emit('models_updated', buildModelCatalogWithProviders(getModelCatalogState()));
    io.emit('grok_settings_updated', settingsPayload);
    const reconciliationFailures = Array.isArray(reconciliation?.failedConversations)
      ? reconciliation.failedConversations
      : [];
    return res.json({
      ok: true,
      ...settingsPayload,
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      warning: reconciliationFailures.length
        ? `${reconciliationFailures.length} unstarted conversation(s) could not switch provider.`
        : (discovery?.ok ? null : (discovery?.error || 'Grok model discovery failed')),
    });
  });

  app.get('/api/settings/cursor', auth, (_req, res) => {
    const settings = getCursorProviderSettings();
    return res.json({
      configured: settings?.configured === true,
      enabled: settings?.enabled === true,
      model: String(settings?.model || 'composer-2.5').trim() || 'composer-2.5',
      models: Array.isArray(settings?.models) ? settings.models : [],
      availableModels: Array.isArray(settings?.availableModels) ? settings.availableModels : [],
    });
  });

  app.post('/api/settings/cursor', auth, async (req, res) => {
    const parsed = parseCursorSettingsUpdateRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const previous = getCursorProviderSettings();
    const result = setCursorProviderSettings(parsed);
    if (!result?.ok) {
      const statusCode = result?.code === 'cursor-key-removal-blocked' ? 409 : 400;
      return res.status(statusCode).json({
        error: result?.error || 'Failed to update Cursor settings',
        code: result?.code || null,
        activeConversationCount: Number(result?.activeConversationCount || 0),
        startedConversationCount: Number(result?.startedConversationCount || 0),
        activeQueueConversationCount: Number(result?.activeQueueConversationCount || 0),
      });
    }
    const shouldDiscover = result.enabled === true && (
      !!parsed.apiKey
      || previous?.enabled !== true
      || previous?.model !== result.model
      || previous?.effortsDiscovered !== true
    );
    const discovery = !shouldDiscover
      ? { ok: true, models: [], error: null }
      : await refreshCursorProviderModels();
    // Removing the Cursor key rebinds unstarted Cursor conversations back to
    // the default provider (mirrors the OpenAI key-removal reconciliation).
    const reconciliationResult = parsed.remove === true
      ? await reconcileUnstartedConversationProviders({
          enabled: false,
          model: result.model,
          provider: 'cursor',
        })
      : {
          updatedUnstartedConversations: 0,
          skippedStartedConversations: 0,
          skippedActiveQueueConversations: 0,
          failedConversations: [],
        };
    const reconciliation = {
      updatedUnstartedConversations: Number(reconciliationResult?.updatedUnstartedConversations || 0),
      skippedStartedConversations: Number(reconciliationResult?.skippedStartedConversations || 0),
      skippedActiveQueueConversations: Number(reconciliationResult?.skippedActiveQueueConversations || 0),
      failedConversations: Array.isArray(reconciliationResult?.failedConversations)
        ? reconciliationResult.failedConversations
        : [],
    };
    const currentSettings = getCursorProviderSettings();
    const settingsPayload = {
      configured: currentSettings?.configured === true,
      enabled: currentSettings?.enabled === true,
      model: String(currentSettings?.model || result.model || 'composer-2.5').trim() || 'composer-2.5',
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      availableModels: Array.isArray(currentSettings?.availableModels) ? currentSettings.availableModels : [],
      reconciliation,
    };
    io.emit('models_updated', buildModelCatalogWithProviders(getModelCatalogState()));
    io.emit('cursor_settings_updated', settingsPayload);
    const reconciliationFailures = Array.isArray(reconciliation?.failedConversations)
      ? reconciliation.failedConversations
      : [];
    return res.json({
      ok: true,
      ...settingsPayload,
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      warning: reconciliationFailures.length
        ? `${reconciliationFailures.length} unstarted conversation(s) could not switch provider.`
        : (discovery?.ok ? null : (discovery?.error || 'Cursor model discovery failed')),
    });
  });

  app.get('/api/settings/turn-ceiling', auth, (_req, res) => {
    res.json({
      ceilingMinutes: getTurnCeilingMinutes(),
      minMinutes: TURN_CEILING_MIN_MINUTES,
      maxMinutes: TURN_CEILING_MAX_MINUTES,
      stepMinutes: TURN_CEILING_STEP_MINUTES,
      defaultMinutes: DEFAULT_TURN_CEILING_MINUTES,
    });
  });

  app.post('/api/settings/turn-ceiling', auth, (req, res) => {
    const parsed = parseTurnCeilingUpdate(req.body?.ceilingMinutes);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = setTurnCeilingMinutes(parsed.minutes);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json({
      ceilingMinutes: result.ceilingMinutes,
      minMinutes: TURN_CEILING_MIN_MINUTES,
      maxMinutes: TURN_CEILING_MAX_MINUTES,
      stepMinutes: TURN_CEILING_STEP_MINUTES,
      defaultMinutes: DEFAULT_TURN_CEILING_MINUTES,
    });
  });

  app.get('/api/settings/windows-autostart', auth, (_req, res) => {
    if (!windowsAutostartService) {
      return res.status(500).json({ error: 'Windows autostart settings are unavailable' });
    }
    try {
      return res.json(windowsAutostartService.getState());
    } catch {
      return res.status(500).json({
        error: 'Unable to read Windows autostart. Check access to your user Startup folder.',
      });
    }
  });

  app.post('/api/settings/windows-autostart', auth, (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    if (!windowsAutostartService) {
      return res.status(500).json({ error: 'Windows autostart settings are unavailable' });
    }
    try {
      const currentState = windowsAutostartService.getState();
      if (!currentState.supported) {
        return res.status(400).json({ error: 'Windows autostart is only available on Windows' });
      }
      return res.json(windowsAutostartService.setEnabled(req.body.enabled));
    } catch {
      return res.status(500).json({
        error: 'Unable to update Windows autostart. Check access to your user Startup folder.',
      });
    }
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

  app.post('/api/host/suspend', auth, (req, res) => {
    const result = runHostSuspendToRam();
    if (!result?.ok) {
      return res.status(result?.statusCode || 500).json({
        ok: false,
        error: result?.error || 'Failed to suspend host',
      });
    }
    return res.status(202).json({
      ok: true,
      queued: true,
      command: result.command,
    });
  });

  app.get('/api/restart-orchestrator', auth, (req, res) => {
    ensureSessionId(req, res);
    return res.json({ orchestrator: relayRestartOrchestrator?.getState?.() || null });
  });

  app.post('/api/restart-orchestrator/request', auth, (req, res) => {
    const targetSessionId = String(req.body?.targetSessionId || req.body?.target_session_id || '').trim();
    if (!targetSessionId) return res.status(400).json({ error: 'Missing targetSessionId' });
    const result = relayRestartOrchestrator?.requestRestart({
      targetSessionId,
      reason: String(req.body?.reason || 'manual-request').trim() || 'manual-request',
    });
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'request rejected', orchestrator: result?.state || null });
    return res.json({ ok: true, ...result });
  });

  app.post('/api/restart-orchestrator/rebind', auth, (req, res) => {
    touchCli();
    relayBridgeOwnerService?.observe?.(readBridgeIdentity(req));
    const body = req.body || {};
    const sdkSessionId = String(body.sdk_session_id || body.sdkSessionId || '').trim();
    const conversationId = String(body.conversation_id || body.conversationId || '').trim() || null;
    const orchestratorCorrelationId = String(
      body.orchestrator_correlation_id
      || body.orchestrator_transaction_id
      || body.restart_transaction_id
      || body.transaction_id
      || body.correlation_id
      || '',
    ).trim();
    const orchestratorTargetSessionId = String(
      body.orchestrator_target_session_id
      || body.restart_target_session_id
      || body.target_session_id
      || body.targetSessionId
      || '',
    ).trim();
    if (!sdkSessionId) {
      return res.status(400).json({ error: 'Missing sdk_session_id' });
    }
    console.log(
      `[relay-rebind] request sid=${shortId(sdkSessionId)} conv=${shortId(conversationId)} tx=${shortId(orchestratorCorrelationId)} target=${shortId(orchestratorTargetSessionId)}`,
    );
    const rebind = relayRestartOrchestrator?.applySessionSync?.({
      sdkSessionId,
      conversationId,
      correlationId: orchestratorCorrelationId || null,
      targetSessionId: orchestratorTargetSessionId || null,
      rebindCompleted: true,
      signalSource: 'api-restart-orchestrator-rebind',
    }) || null;
    if (!rebind) {
      return res.status(503).json({
        error: 'Restart orchestrator unavailable',
        code: 'restart-orchestrator-unavailable',
      });
    }
    if (rebind.ok === false && rebind.conflict) {
      console.warn(
        `[relay-rebind] conflict sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} code=${String(rebind.code || 'none')} retryable=${rebind.retryable === true ? 'yes' : 'no'} terminal=${rebind.terminal === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
      );
      return res.status(409).json({
        error: rebind.message || 'Rebind confirmation conflict',
        code: rebind.code || 'rebind-conflict',
        retryable: rebind.retryable === true,
        terminal: rebind.terminal === true,
        rebind,
        restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
      });
    }
    console.log(
      `[relay-rebind] outcome sid=${shortId(sdkSessionId)} tx=${shortId(orchestratorCorrelationId)} completed=${rebind.completed === true ? 'yes' : 'no'} state=${String(rebind?.state?.state || 'unknown')}`,
    );
    return res.json({
      ok: rebind.ok === true,
      rebind: {
        considered: rebind.considered === true,
        completed: rebind.completed === true,
        awaitingRebind: rebind.awaitingRebind === true,
        code: rebind.code || null,
        retryable: rebind.retryable === true,
        terminal: rebind.terminal === true,
        expected: rebind.expected || null,
      },
      restartOrchestrator: rebind.state || relayRestartOrchestrator?.getState?.() || null,
      activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
    });
  });

  app.post('/api/restart-orchestrator/bridge-exit', auth, (req, res) => {
    const requester = readBridgeIdentity(req);
    const activeOwner = relayBridgeOwnerService?.getOwner?.() || null;
    console.log(
      `[bridge-exit] request ownerSid=${shortId(requester?.sessionId)} ownerPid=${String(requester?.pid || 'none')} tx=${shortId(req.body?.transactionId)} target=${shortId(req.body?.targetSessionId)}`,
    );
    if (activeOwner && requester && !relayBridgeOwnerService?.isOwner?.(requester)) {
      return res.status(409).json({
        error: 'Bridge exit rejected for non-owner requester',
        code: 'bridge-owner-mismatch',
        activeBridgeOwner: activeOwner,
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      });
    }

    const orchestratorState = relayRestartOrchestrator?.getState?.() || null;
    console.log(
      `[bridge-exit] outcome tx=${shortId(orchestratorState?.transactionId)} target=${shortId(orchestratorState?.targetSessionId)} state=${String(orchestratorState?.state || 'unknown')} launcher=skipped`,
    );
    return res.json({
      ok: true,
      activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
      restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      launcher: null,
    });
  });

  function buildModelVariantCatalogPayloadForRoute() {
    const rows = typeof listModelVariantRows === 'function' ? listModelVariantRows() : [];
    const modelState = getModelCatalogState();
    const claudeSettings = getClaudeProviderSettings();
    const cursorSettings = getCursorProviderSettings();
    const grokSettings = getGrokProviderSettings();
    return {
      ...buildModelVariantCatalogPayload({
        rows,
        modelState,
        reasoningEfforts: modelState.reasoningEfforts || [],
        contextLimitsByModel: modelState.contextLimitsByModel || {},
        modelMetadataByModel: modelState.modelMetadataByModel || {},
      }),
      claudeModels: claudeSettings?.enabled === true
        ? {
            defaultModel: claudeSettings.model,
            availableModels: Array.isArray(claudeSettings.availableModels) ? claudeSettings.availableModels : [],
            enabledModels: Array.isArray(claudeSettings.models) ? claudeSettings.models : [],
          }
        : null,
      cursorModels: cursorSettings?.enabled === true
        ? {
            defaultModel: cursorSettings.model,
            availableModels: Array.isArray(cursorSettings.availableModels) ? cursorSettings.availableModels : [],
            enabledModels: Array.isArray(cursorSettings.models) ? cursorSettings.models : [],
          }
        : null,
      grokModels: grokSettings?.enabled === true
        ? {
            defaultModel: grokSettings.model,
            availableModels: Array.isArray(grokSettings.availableModels) ? grokSettings.availableModels : [],
            enabledModels: Array.isArray(grokSettings.models) ? grokSettings.models : [],
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
      const openAISettings = getOpenAIProviderSettings();
      const claudeSettings = getClaudeProviderSettings();
      const cursorSettings = getCursorProviderSettings();
      const grokSettings = getGrokProviderSettings();
      const refreshTasks = [
        refreshModelVariantCatalogFromCli(),
        openAISettings?.enabled === true
          ? refreshOpenAIProviderModels()
          : Promise.resolve({ ok: true, skipped: true, models: [], error: null }),
        claudeSettings?.enabled === true
          ? refreshClaudeProviderModels()
          : Promise.resolve({ ok: true, skipped: true, models: [], error: null }),
        cursorSettings?.enabled === true
          ? refreshCursorProviderModels()
          : Promise.resolve({ ok: true, skipped: true, models: [], error: null }),
        grokSettings?.enabled === true
          ? refreshGrokProviderModels()
          : Promise.resolve({ ok: true, skipped: true, models: [], error: null }),
      ];
      const [cliRefresh, openAIRefresh, claudeRefresh, cursorRefresh, grokRefresh] = await Promise.allSettled(refreshTasks);
      if (cliRefresh.status === 'rejected') throw cliRefresh.reason;
      const openAIModelDiscovery = openAIRefresh.status === 'fulfilled'
        ? openAIRefresh.value
        : {
            ok: false,
            models: Array.isArray(openAISettings?.models) ? openAISettings.models : [],
            error: openAIRefresh.reason?.message || 'OpenAI model discovery failed',
          };
      const claudeModelDiscovery = claudeRefresh.status === 'fulfilled'
        ? claudeRefresh.value
        : {
            ok: false,
            models: Array.isArray(claudeSettings?.models) ? claudeSettings.models : [],
            error: claudeRefresh.reason?.message || 'Claude model discovery failed',
          };
      const cursorModelDiscovery = cursorRefresh.status === 'fulfilled'
        ? cursorRefresh.value
        : {
            ok: false,
            models: Array.isArray(cursorSettings?.models) ? cursorSettings.models : [],
            error: cursorRefresh.reason?.message || 'Cursor model discovery failed',
          };
      const grokModelDiscovery = grokRefresh.status === 'fulfilled'
        ? grokRefresh.value
        : {
            ok: false,
            models: Array.isArray(grokSettings?.models) ? grokSettings.models : [],
            error: grokRefresh.reason?.message || 'Grok model discovery failed',
          };
      io.emit('models_updated', buildModelCatalogWithProviders(
        getModelCatalogState(),
      ));
      return res.json({
        ok: true,
        ...buildModelVariantCatalogPayloadForRoute(),
        openAIModelDiscovery,
        claudeModelDiscovery,
        cursorModelDiscovery,
        grokModelDiscovery,
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
    const enabledVariantIds = Array.isArray(req.body?.enabledVariantIds)
      ? req.body.enabledVariantIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    setEnabledModelVariants(enabledVariantIds);
    io.emit('models_updated', buildModelCatalogWithProviders(
      getModelCatalogState(),
    ));
    return res.json({
      ok: true,
      ...buildModelVariantCatalogPayloadForRoute(),
    });
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
      reasoningEfforts: modelState.reasoningEfforts || [],
      contextLimitsByModel: modelState.contextLimitsByModel || {},
      modelMetadataByModel: modelState.modelMetadataByModel || {},
      providersByModel: modelState.providersByModel || {},
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
    io.emit('models_updated', buildModelCatalogWithProviders(
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
  app.get('/api/usage', auth, async (req, res) => {
    const wantsLegacyOnly = String(req.query?.legacy || '').trim() === '1';

    let summary = null;
    let summaryError = null;
    try {
      summary = await fetchUsageSummaryPromise(fetchUsageSummary);
    } catch (error) {
      summaryError = String(error?.message || error || 'Failed to fetch usage data');
    }

    if (wantsLegacyOnly || !planUsageService) {
      if (!summary) return res.status(500).json({ error: summaryError || 'Usage is unavailable' });
      return res.json(summary);
    }

    // Billing detail is best-effort and must never delay or fail the card.
    let billing = null;
    if (typeof fetchCopilotBillingUsage === 'function') {
      try {
        billing = await fetchCopilotBillingUsage();
      } catch (error) {
        billing = { items: [], timePeriod: null, scope: null, error: String(error?.message || error) };
      }
    }

    const claudeSettings = getClaudeProviderSettings();
    const cursorSettings = getCursorProviderSettings();
    const grokSettings = getGrokProviderSettings();
    // Live Grok subscription quota is best-effort like Copilot billing.
    let grokBilling = null;
    if (grokSettings?.enabled === true && typeof fetchGrokBillingUsage === 'function') {
      try {
        grokBilling = await fetchGrokBillingUsage();
      } catch {
        grokBilling = null;
      }
    }
    const report = planUsageService.buildReport({
      copilotSummary: summary,
      copilotError: summaryError,
      copilotBilling: billing,
      claudeConfigured: claudeSettings?.enabled === true,
      cursorConfigured: cursorSettings?.enabled === true,
      cursorAllowances: getCursorPlanAllowanceSettings(),
      grokConfigured: grokSettings?.enabled === true,
      grokAllowances: getGrokPlanAllowanceSettings(),
      grokBilling,
    });

    // Legacy top-level fields stay alongside `providers` so an older cached
    // client shell keeps working through a PWA update.
    return res.json({ ...(summary || {}), ...report });
  });

  app.get('/api/settings/cursor-allowance', auth, (_req, res) => {
    res.json({ ok: true, ...getCursorPlanAllowanceSettings() });
  });

  app.post('/api/settings/cursor-allowance', auth, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = setCursorPlanAllowanceSettings({
      cursorModelsUsd: body.cursorModelsUsd,
      otherModelsUsd: body.otherModelsUsd,
      resetDay: body.resetDay,
      resetAccounting: body.resetAccounting === true,
    });
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || 'Failed to update Cursor allowances' });
    }
    return res.json(result);
  });

  app.get('/api/settings/grok-allowance', auth, (_req, res) => {
    res.json({ ok: true, ...getGrokPlanAllowanceSettings() });
  });

  app.post('/api/settings/grok-allowance', auth, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = setGrokPlanAllowanceSettings({
      monthlyUsd: body.monthlyUsd,
      resetDay: body.resetDay,
      resetAccounting: body.resetAccounting === true,
    });
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || 'Failed to update Grok allowances' });
    }
    return res.json(result);
  });
}
