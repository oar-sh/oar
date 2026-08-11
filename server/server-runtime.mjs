'use strict';

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { execFile, execFileSync, spawn } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import {
  resolveStartupWorkspaceRoot,
  workspaceRootDisplayName,
  parseCdCommandTarget,
  resolveCdCommandPath,
} from './workspace-root.mjs';
import {
  normalizeDriveLetterOnlyPath,
  normalizeWorkspaceRootAllowList,
  normalizeWorkspaceRootKey,
} from './services/workspace-root-path-policy.mjs';
import { stopSessionWorkerProcesses } from './services/session-worker-stop-service.mjs';
import { rebuildRecentWorkspaceRootsTable } from './migrations/0002-recent-workspace-roots-path-key.mjs';
import { ensurePushSubscriptionsTable } from './migrations/0003-push-subscriptions.mjs';
import { createSessionRepository } from './repositories/session-repository.mjs';
import { createMessageRepository } from './repositories/message-repository.mjs';
import { createQuestionRepository } from './repositories/question-repository.mjs';
import {
  createImageConversationRepository,
  migrateImageConversationSchema,
} from './repositories/image-conversation-repository.mjs';
import { registerSessionsRoutes } from './routes/sessions-routes.mjs';
import { buildDequeuedRelayMessage, dequeuePendingMessageForWorkerLoop, registerMessagesRoutes } from './routes/messages-routes.mjs';
import { registerAskUserRoutes } from './routes/ask-user-routes.mjs';
import { registerRelayBoardRoutes } from './routes/relay-board-routes.mjs';
import { registerCacheRoutes } from './routes/cache-routes.mjs';
import { registerGitRoutes } from './routes/git-routes.mjs';
import { createDeleteArchiveService } from './services/delete-archive-service.mjs';
import { createStatusEventService } from './services/status-event-service.mjs';
import { sweepUnreferencedUploads, UNREFERENCED_UPLOADS_QUERY } from './services/upload-sweep.mjs';
import webpush from 'web-push';
import { createPushDispatchService, ensurePushVapidKeys } from './services/push-dispatch-service.mjs';
import { createActiveDeviceTracker } from './services/push-active-device-service.mjs';
import { registerPushRoutes } from './routes/push-routes.mjs';
import { createImageOperationService } from './services/image-operation-service.mjs';
import {
  normalizeDriveAbsolutePath as _normalizeDriveAbsolutePath,
  driveRootFromAbsolutePath as _driveRootFromAbsolutePath,
  toDriveWebPath as _toDriveWebPath,
  normalizeLinuxAbsolutePath as _normalizeLinuxAbsolutePath,
} from './services/drives-path-helpers.mjs';
import { createPlanUsageService } from './services/plan-usage-service.mjs';
import { normalizeCursorAllowanceSettings } from './services/plan-usage-cursor.mjs';
import { normalizeGrokAllowanceSettings } from './services/plan-usage-grok.mjs';
import { createGrokBillingUsageFetcher } from './services/grok-billing-usage.mjs';
import { createCursorDashboardUsageFetcher, readCursorIdeSessionToken } from './services/cursor-dashboard-usage.mjs';
import { fetchPersonalBillingUsage } from './services/github-billing-usage.mjs';
import { createSessionTranscriptService } from './services/session-transcript-service.mjs';
import { createSdkSessionImportService } from './services/sdk-session-import-service.mjs';
import { createInstalledCopilotClient } from './copilot-sdk-runtime.mjs';
import { createSessionHistoryRefreshService } from './services/session-history-refresh-service.mjs';
import { createContextSnapshotService } from './services/context-snapshot-service.mjs';
import { createClaudeSessionRootResolver } from './services/claude-session-root-service.mjs';
import { createCursorSessionRootResolver } from './services/cursor-session-root-service.mjs';
import { createGitChangesService } from './services/git-changes-service.mjs';
import { createRelaySingletonGuard } from './services/relay-singleton-guard.mjs';
import { createRelayRestartOrchestrator } from './services/relay-restart-orchestrator-service.mjs';
import { createRelayBridgeOwnerService } from './services/relay-bridge-owner-service.mjs';
import { createRelayCliLauncherService } from './services/relay-cli-launcher-service.mjs';
import { createSessionWorkerRegistry } from './services/session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './services/session-worker-supervisor-service.mjs';
import { createSessionWorkerProcessInspector } from './services/session-worker-process-service.mjs';
import { latestModelCatalogRefresh } from '../shared/model-catalog-freshness.mjs';
import { applyClaudeProviderEnvironment, applyCursorProviderEnvironment, applyGrokProviderEnvironment, applyOpenAIProviderEnvironment, killTmuxSession, launchSessionCli } from './services/session-worker-launch-service.mjs';
import { createSshTunnelManager } from './services/ssh-tunnel-manager-service.mjs';
import { createCloudflaredTunnelManager } from './services/cloudflared-tunnel-service.mjs';
import { createTunnelWorkerPathGuard } from './services/tunnel-worker-path-guard.mjs';
import { createWindowsAutostartService } from './services/windows-autostart-service.mjs';
import { createSessionWorkerWebSocketService } from './services/session-worker-websocket-service.mjs';
import { createTmuxInspectorAccessPolicy } from './services/tmux-inspector-access-policy.mjs';
import { createTmuxInspectorStreamService } from './services/tmux-inspector-stream-service.mjs';
import { createTmuxInspectorSocketService } from './services/tmux-inspector-socket-service.mjs';
import {
  resolveDefaultSessionWorkspaceRootState as resolveDefaultSessionWorkspaceRootStateFromService,
  resolveLaunchWorkspaceRootPath,
} from './services/workspace-root-defaults-service.mjs';
import { maybeStartTtyConsole } from './tty-console-bootstrap.mjs';
import { FEATURES, normalizeFeatureFlags } from './features.mjs';
import { RELAY_RESTART_EXIT_CODE } from './relay-exit-codes.mjs';
import { DEFAULT_QUESTION_TIMEOUT_MS } from '../shared/question-timeout.mjs';
import {
  parseTurnCeilingUpdate,
  readTurnCeilingSetting,
  turnCeilingMinutesToMs,
} from '../shared/turn-ceiling.mjs';
import { normalizeRelayThoughtList } from './public/app/relay-thoughts.mjs';
import {
  canonicalizeModelId,
  filterValidModelIds,
  isOpenAIModelId,
  isSafeClaudeModelId,
  isSafeCursorModelId,
  isSafeGrokModelId,
  isSafeProviderModelId,
  isValidModelId,
} from '../shared/model-id.mjs';
import { selectModelIdsForVariantRefresh } from '../shared/model-refresh.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, 'index.html');
const PWA_MANIFEST_PATH = path.join(PUBLIC_DIR, 'manifest.webmanifest');
const PWA_SW_PATH = path.join(PUBLIC_DIR, 'sw.js');
const SOCKET_IO_CLIENT_JS_PATH = path.join(__dirname, '..', 'node_modules', 'socket.io', 'client-dist', 'socket.io.js');
const APP_CONFIG_PLACEHOLDER = /window\.__COPILOT_APP_CONFIG = \{ basePath: '[^']*' \};/;
const PWA_VERSION_PLACEHOLDER = /const __PWA_VERSION = '[^']*';/;
const ttyConsoleRuntime = await maybeStartTtyConsole({
  serverDir: __dirname,
  logsDir: path.join(__dirname, 'logs'),
  logger: console,
});

// ─── Config ────────────────────────────────────────────────────────────────────
const CONFIG_PATH    = process.env.COPILOT_WEB_RELAY_CONFIG
  ? path.resolve(String(process.env.COPILOT_WEB_RELAY_CONFIG))
  : path.join(__dirname, 'config.json');
const DATA_DIR       = process.env.COPILOT_WEB_RELAY_DATA_DIR
  ? path.resolve(String(process.env.COPILOT_WEB_RELAY_DATA_DIR))
  : path.join(__dirname, 'data');
const DB_PATH        = path.join(DATA_DIR, 'copilot.db');
const RELAY_LOCK_PATH = path.join(DATA_DIR, 'relay-server.lock');
const UPLOAD_DIR     = process.env.COPILOT_WEB_RELAY_DATA_DIR
  ? path.join(DATA_DIR, 'uploads')
  : path.join(__dirname, 'uploads');
const INITIAL_WORKSPACE_ROOT = resolveStartupWorkspaceRoot(__dirname);
const WORKSPACE_ROOT_LOCKED = true;
const SESSION_COOKIE = 'copilot_session';
const AUTH_COOKIE = 'copilot_auth';

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}
if (process.platform !== 'win32') {
  fs.chmodSync(DATA_DIR, 0o700);
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

async function refreshOpenAIProviderModels() {
  const settings = getOpenAIProviderSettings();
  if (!settings.enabled) return { ok: false, models: [], error: 'OpenAI API key is not configured' };
  let response;
  try {
    response = await fetch(`${settings.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, models: settings.models, error: error?.message || 'OpenAI model discovery failed' };
  }
  if (!response.ok) {
    const detail = String(await response.text().catch(() => '')).trim().slice(0, 240);
    return {
      ok: false,
      models: settings.models,
      error: `OpenAI model discovery failed (${response.status})${detail ? `: ${detail}` : ''}`,
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, models: settings.models, error: 'OpenAI model discovery returned invalid JSON' };
  }
  const models = Array.from(new Set([
    settings.model,
    ...(Array.isArray(payload?.data) ? payload.data : [])
      .map((entry) => String(entry?.id || '').trim())
      .filter((modelId) => isOpenAIModelId(modelId)),
  ])).filter(Boolean);
  stmts.upsertAppSetting.run(OPENAI_MODELS_SETTING_KEY, JSON.stringify(models), new Date().toISOString());
  return { ok: true, models, error: null };
}

function getOpenAIProviderSettings() {
  const apiKey = readAppSettingValue(OPENAI_API_KEY_SETTING_KEY);
  const enabledSetting = readAppSettingValue(OPENAI_ENABLED_SETTING_KEY);
  const enabled = !!apiKey && (enabledSetting === '' || enabledSetting === 'true');
  const model = readAppSettingValue(OPENAI_MODEL_SETTING_KEY) || DEFAULT_OPENAI_MODEL;
  let models = [];
  try {
    const parsed = JSON.parse(readAppSettingValue(OPENAI_MODELS_SETTING_KEY) || '[]');
    if (Array.isArray(parsed)) {
      models = parsed.map((value) => String(value || '').trim()).filter(Boolean);
    }
  } catch {
    models = [];
  }
  return {
    configured: !!apiKey,
    enabled,
    apiKey,
    model,
    models: Array.from(new Set([model, ...models])),
    baseUrl: readAppSettingValue(OPENAI_BASE_URL_SETTING_KEY) || DEFAULT_OPENAI_BASE_URL,
    providerType: 'openai',
  };
}

function setOpenAIProviderSettings(update = {}) {
  const payload = update && typeof update === 'object' ? update : {};
  const apiKey = payload.apiKey;
  const model = payload.model;
  const enabled = payload.enabled;
  const remove = payload.remove === true;
  const hasBaseUrl = Object.prototype.hasOwnProperty.call(payload, 'baseUrl');
  const baseUrl = hasBaseUrl ? payload.baseUrl : '';
  if (typeof stmts?.upsertAppSetting?.run !== 'function' || typeof stmts?.deleteAppSetting?.run !== 'function') {
    return { ok: false, error: 'OpenAI settings are unavailable' };
  }
  const existing = getOpenAIProviderSettings();
  const normalizedModel = String(model || existing.model || '').trim() || DEFAULT_OPENAI_MODEL;
  if (!isSafeProviderModelId(normalizedModel)) {
    return { ok: false, error: 'Invalid OpenAI model ID' };
  }
  const nowIso = new Date().toISOString();
  if (remove) {
    const providerCandidates = Array.isArray(stmts?.listRuntimeSessionProviderCandidates?.all?.())
      ? stmts.listRuntimeSessionProviderCandidates.all()
      : [];
    const startedConversationCount = providerCandidates.filter((row) => (
      String(row?.provider_type || 'github').trim().toLowerCase() === 'openai'
      && Number(row?.message_count || 0) > 0
    )).length;
    const activeQueueConversationCount = providerCandidates.filter((row) => (
      String(row?.provider_type || 'github').trim().toLowerCase() === 'openai'
      && Number(row?.active_queue_count || 0) > 0
    )).length;
    const activeConversationCount = providerCandidates.filter((row) => (
      String(row?.provider_type || 'github').trim().toLowerCase() === 'openai'
      && (Number(row?.message_count || 0) > 0 || Number(row?.active_queue_count || 0) > 0)
    )).length;
    if (activeConversationCount > 0) {
      return {
        ok: false,
        code: 'openai-key-removal-blocked',
        error: `Cannot remove OpenAI API key while ${activeConversationCount} active OpenAI conversation(s) still exist. Disable OpenAI for new conversations instead.`,
        activeConversationCount,
        startedConversationCount,
        activeQueueConversationCount,
      };
    }
    stmts.deleteAppSetting.run(OPENAI_API_KEY_SETTING_KEY);
    stmts.deleteAppSetting.run(OPENAI_MODELS_SETTING_KEY);
    stmts.upsertAppSetting.run(OPENAI_ENABLED_SETTING_KEY, 'false', nowIso);
    stmts.upsertAppSetting.run(OPENAI_MODEL_SETTING_KEY, normalizedModel, nowIso);
  } else {
    const normalizedApiKey = String(apiKey || '').trim();
    if (normalizedApiKey) {
      stmts.deleteAppSetting.run(OPENAI_MODELS_SETTING_KEY);
      stmts.upsertAppSetting.run(OPENAI_API_KEY_SETTING_KEY, normalizedApiKey, nowIso);
    }
    const hasApiKey = !!(normalizedApiKey || existing.apiKey);
    const nextEnabled = typeof enabled === 'boolean' ? enabled : (normalizedApiKey ? true : existing.enabled);
    if (nextEnabled && !hasApiKey) return { ok: false, error: 'OpenAI API key is not configured' };
    stmts.upsertAppSetting.run(OPENAI_ENABLED_SETTING_KEY, nextEnabled ? 'true' : 'false', nowIso);
    stmts.upsertAppSetting.run(OPENAI_MODEL_SETTING_KEY, normalizedModel, nowIso);
    if (hasBaseUrl) {
      const normalizedBaseUrl = String(baseUrl || '').trim();
      if (normalizedBaseUrl && normalizedBaseUrl !== DEFAULT_OPENAI_BASE_URL) {
        stmts.upsertAppSetting.run(OPENAI_BASE_URL_SETTING_KEY, normalizedBaseUrl, nowIso);
      } else {
        stmts.deleteAppSetting.run(OPENAI_BASE_URL_SETTING_KEY);
      }
    }
  }
  const current = getOpenAIProviderSettings();
  return {
    ok: true,
    configured: current.configured,
    enabled: current.enabled,
    model: current.model,
    baseUrl: current.baseUrl,
  };
}

function readClaudeModelListSetting(settingKey) {
  try {
    const parsed = JSON.parse(readAppSettingValue(settingKey) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => String(value || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function readClaudeModelEffortsSetting() {
  try {
    const parsed = JSON.parse(readAppSettingValue(CLAUDE_MODEL_EFFORTS_SETTING_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [modelId, efforts] of Object.entries(parsed)) {
      const key = String(modelId || '').trim().toLowerCase();
      if (!key) continue;
      const levels = (Array.isArray(efforts) ? efforts : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => CLAUDE_EFFORT_LEVELS.has(value));
      out[key] = levels;
    }
    return out;
  } catch {
    return {};
  }
}

function getClaudeProviderSettings() {
  const enabledSetting = readAppSettingValue(CLAUDE_ENABLED_SETTING_KEY);
  const enabled = enabledSetting === 'true';
  const model = readAppSettingValue(CLAUDE_MODEL_SETTING_KEY) || DEFAULT_CLAUDE_MODEL;
  const discovered = readClaudeModelListSetting(CLAUDE_MODELS_SETTING_KEY);
  const modelsDiscovered = discovered.length > 0;
  const availableModels = Array.from(new Set([
    model,
    ...(discovered.length ? discovered : DEFAULT_CLAUDE_MODELS),
  ])).filter(Boolean);
  const availableSet = new Set(availableModels);
  const enabledSelection = readClaudeModelListSetting(CLAUDE_ENABLED_MODELS_SETTING_KEY)
    .filter((modelId) => availableSet.has(modelId));
  // The enabled subset (chosen in the Select Models modal) drives the model
  // catalog and composers; an empty selection means "all available".
  const models = Array.from(new Set([
    model,
    ...(enabledSelection.length ? enabledSelection : availableModels),
  ])).filter(Boolean);
  const storedEfforts = readClaudeModelEffortsSetting();
  const effortsByModel = {};
  for (const availableModel of availableModels) {
    const key = String(availableModel || '').trim().toLowerCase();
    if (!key) continue;
    const discoveredEfforts = storedEfforts[key];
    // 'none' (SDK default) is always offered; discovered levels follow. When a
    // model was never discovered, offer the full ladder — the SDK silently
    // downgrades unsupported levels.
    effortsByModel[key] = Array.isArray(discoveredEfforts) && discoveredEfforts.length
      ? ['none', ...discoveredEfforts]
      : [...CLAUDE_REASONING_EFFORTS];
  }
  return {
    // The Claude runtime authenticates through the host's logged-in Claude
    // credentials (~/.claude); enablement is the only configuration step.
    configured: enabled,
    enabled,
    model,
    models,
    availableModels,
    enabledModels: models,
    effortsByModel,
    modelsDiscovered,
    providerType: 'claude',
  };
}

function setClaudeProviderSettings(update = {}) {
  const payload = update && typeof update === 'object' ? update : {};
  const enabled = payload.enabled;
  const model = payload.model;
  const models = payload.models;
  const enabledModels = payload.enabledModels;
  if (typeof stmts?.upsertAppSetting?.run !== 'function') {
    return { ok: false, error: 'Claude settings are unavailable' };
  }
  const existing = getClaudeProviderSettings();
  const normalizedModel = String(model || existing.model || '').trim() || DEFAULT_CLAUDE_MODEL;
  if (!isSafeClaudeModelId(normalizedModel)) {
    return { ok: false, error: 'Invalid Claude model ID' };
  }
  const nowIso = new Date().toISOString();
  const nextEnabled = typeof enabled === 'boolean' ? enabled : existing.enabled;
  stmts.upsertAppSetting.run(CLAUDE_ENABLED_SETTING_KEY, nextEnabled ? 'true' : 'false', nowIso);
  stmts.upsertAppSetting.run(CLAUDE_MODEL_SETTING_KEY, normalizedModel, nowIso);
  if (Array.isArray(models)) {
    const normalizedModels = models
      .map((value) => String(value || '').trim())
      .filter((value) => value && isSafeClaudeModelId(value));
    if (normalizedModels.length) {
      stmts.upsertAppSetting.run(CLAUDE_MODELS_SETTING_KEY, JSON.stringify(normalizedModels), nowIso);
    } else {
      stmts.deleteAppSetting.run(CLAUDE_MODELS_SETTING_KEY);
    }
  }
  if (Array.isArray(enabledModels)) {
    const normalizedEnabledModels = enabledModels
      .map((value) => String(value || '').trim())
      .filter((value) => value && isSafeClaudeModelId(value));
    if (normalizedEnabledModels.length) {
      stmts.upsertAppSetting.run(CLAUDE_ENABLED_MODELS_SETTING_KEY, JSON.stringify(normalizedEnabledModels), nowIso);
    } else {
      stmts.deleteAppSetting.run(CLAUDE_ENABLED_MODELS_SETTING_KEY);
    }
  }
  const current = getClaudeProviderSettings();
  return {
    ok: true,
    configured: current.configured,
    enabled: current.enabled,
    model: current.model,
    models: current.models,
    availableModels: current.availableModels,
  };
}

const CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

// Discover the models the Claude Agent SDK can serve by asking a short-lived
// idle query for `supportedModels()` (mirrors refreshOpenAIProviderModels).
async function refreshClaudeProviderModels() {
  const settings = getClaudeProviderSettings();
  if (typeof stmts?.upsertAppSetting?.run !== 'function') {
    return { ok: false, models: settings.models, error: 'Claude settings are unavailable' };
  }
  if (settings.enabled !== true) {
    return { ok: false, models: settings.models, error: 'Claude provider is disabled' };
  }
  let claudeQuery = null;
  let releaseInputGate = () => {};
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const inputGate = new Promise((resolve) => { releaseInputGate = resolve; });
    claudeQuery = query({
      // Streaming-input mode with a gated (never-yielding) prompt keeps the
      // CLI idle so the supportedModels control request can be served.
      prompt: (async function* neverPrompt() { await inputGate; })(),
      options: { cwd: os.tmpdir() },
    });
    const modelInfos = await Promise.race([
      claudeQuery.supportedModels(),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out after ${CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS}ms`)),
          CLAUDE_MODEL_DISCOVERY_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    const discovered = [];
    const effortsByModel = {};
    for (const entry of (Array.isArray(modelInfos) ? modelInfos : [])) {
      const effortLevels = entry?.supportsEffort !== false && Array.isArray(entry?.supportedEffortLevels)
        ? entry.supportedEffortLevels
            .map((value) => String(value || '').trim().toLowerCase())
            .filter((value) => CLAUDE_EFFORT_LEVELS.has(value))
        : [];
      for (const candidate of [entry?.value, entry?.resolvedModel]) {
        const modelId = String(candidate || '').trim();
        // Keep explicit claude-* ids (including "[1m]" capability variants) and
        // drop bare aliases like "default"/"sonnet" that duplicate them.
        if (!modelId.toLowerCase().startsWith('claude-') || !isSafeClaudeModelId(modelId)) continue;
        discovered.push(modelId);
        const key = modelId.toLowerCase();
        if (effortLevels.length && !(effortsByModel[key]?.length)) {
          effortsByModel[key] = effortLevels;
        }
      }
    }
    if (!discovered.length) {
      return { ok: false, models: settings.models, error: 'Claude model discovery returned no models' };
    }
    const nowIso = new Date().toISOString();
    const models = Array.from(new Set([settings.model, ...discovered])).filter(Boolean);
    stmts.upsertAppSetting.run(CLAUDE_MODELS_SETTING_KEY, JSON.stringify(models), nowIso);
    stmts.upsertAppSetting.run(CLAUDE_MODEL_EFFORTS_SETTING_KEY, JSON.stringify(effortsByModel), nowIso);
    return { ok: true, models, error: null };
  } catch (error) {
    return {
      ok: false,
      models: settings.models,
      error: `Claude model discovery failed: ${String(error?.message || error || 'unknown error')}`,
    };
  } finally {
    releaseInputGate();
    try { claudeQuery?.close?.(); } catch { /* subprocess cleanup is best-effort */ }
  }
}

function readCursorModelReasoningOffSetting() {
  try {
    const parsed = JSON.parse(readAppSettingValue(CURSOR_MODEL_REASONING_OFF_SETTING_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [modelId, supported] of Object.entries(parsed)) {
      const key = String(modelId || '').trim().toLowerCase();
      if (!key) continue;
      out[key] = supported === true;
    }
    return out;
  } catch {
    return {};
  }
}

function readCursorModelEffortsSetting() {
  try {
    const parsed = JSON.parse(readAppSettingValue(CURSOR_MODEL_EFFORTS_SETTING_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [modelId, efforts] of Object.entries(parsed)) {
      const key = String(modelId || '').trim().toLowerCase();
      if (!key) continue;
      const levels = (Array.isArray(efforts) ? efforts : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => CURSOR_EFFORT_LEVELS.has(value));
      out[key] = levels;
    }
    return out;
  } catch {
    return {};
  }
}

function getCursorProviderSettings() {
  const apiKey = readAppSettingValue(CURSOR_API_KEY_SETTING_KEY);
  const enabledSetting = readAppSettingValue(CURSOR_ENABLED_SETTING_KEY);
  const enabled = !!apiKey && (enabledSetting === '' || enabledSetting === 'true');
  const model = readAppSettingValue(CURSOR_MODEL_SETTING_KEY) || DEFAULT_CURSOR_MODEL;
  let models = [];
  try {
    const parsed = JSON.parse(readAppSettingValue(CURSOR_MODELS_SETTING_KEY) || '[]');
    if (Array.isArray(parsed)) {
      models = parsed
        .map((value) => String(value || '').trim())
        .filter((modelId) => isSafeCursorModelId(modelId));
    }
  } catch {
    models = [];
  }
  const availableModels = Array.from(new Set([model, ...(models.length ? models : DEFAULT_CURSOR_MODELS)]));
  const availableSet = new Set(availableModels);
  let enabledSelection = [];
  try {
    const parsed = JSON.parse(readAppSettingValue(CURSOR_ENABLED_MODELS_SETTING_KEY) || '[]');
    if (Array.isArray(parsed)) {
      enabledSelection = parsed
        .map((value) => String(value || '').trim())
        .filter((modelId) => isSafeCursorModelId(modelId) && availableSet.has(modelId));
    }
  } catch {
    enabledSelection = [];
  }
  // The enabled subset (chosen in the Select Models modal) drives the model
  // catalog and composers; an empty selection means "all available".
  const resolvedModels = Array.from(new Set([
    model,
    ...(enabledSelection.length ? enabledSelection : availableModels),
  ])).filter(Boolean);
  const storedEfforts = readCursorModelEffortsSetting();
  const storedReasoningOff = readCursorModelReasoningOffSetting();
  const effortsByModel = {};
  const reasoningOffByModel = {};
  for (const availableModel of availableModels) {
    const key = String(availableModel || '').trim().toLowerCase();
    if (!key) continue;
    reasoningOffByModel[key] = storedReasoningOff[key] === true;
    const discoveredEfforts = storedEfforts[key] || [];
    // 'none' is always offered; discovered tiers follow. The worker maps
    // 'none' to an explicit off-switch where the model can express it
    // (thinking=false / reasoning='none') and to the model default otherwise.
    // A model with no discovered effort parameter stays at 'none' only.
    effortsByModel[key] = ['none', ...discoveredEfforts.filter((value) => value !== 'none')];
  }
  return {
    configured: !!apiKey,
    enabled,
    apiKey,
    model,
    models: resolvedModels,
    availableModels,
    enabledModels: resolvedModels,
    effortsByModel,
    reasoningOffByModel,
    // Pre-effort installs have models but no efforts setting; the settings
    // route uses this to re-run discovery once and backfill the tiers. The
    // reasoning-off capability shipped later and needs the same one-shot
    // backfill, otherwise an install that already discovered efforts would
    // treat every Cursor model as unable to turn reasoning off.
    effortsDiscovered: readAppSettingValue(CURSOR_MODEL_EFFORTS_SETTING_KEY) !== '',
    reasoningOffDiscovered: readAppSettingValue(CURSOR_MODEL_REASONING_OFF_SETTING_KEY) !== '',
    providerType: 'cursor',
  };
}

/**
 * Manual Cursor plan allowances. Cursor's SDK reports authoritative spend but
 * no included-pool balance or billing reset date, so these are the only source
 * for the "how much is left" side of the Cursor usage card.
 */
// Session cookie for cursor.com's dashboard API (live plan-quota bars). The
// API key has no plan/usage surface; the token comes from the host's Cursor
// IDE login automatically, with a user-pasted cookie or CURSOR_SESSION_TOKEN
// as the override for headless hosts (the Linux relay has no IDE install).
function readCursorSessionTokenFromEnv() {
  return String(process.env.CURSOR_SESSION_TOKEN || '').trim();
}

function readCursorDashboardSessionToken() {
  return readAppSettingValue(CURSOR_SESSION_TOKEN_SETTING_KEY) || readCursorSessionTokenFromEnv();
}

function getCursorDashboardTokenSettings() {
  if (readAppSettingValue(CURSOR_SESSION_TOKEN_SETTING_KEY) !== '') {
    return { configured: true, source: 'manual' };
  }
  if (readCursorSessionTokenFromEnv() !== '') {
    return { configured: true, source: 'env' };
  }
  if (readCursorIdeSessionToken()) {
    return { configured: true, source: 'ide' };
  }
  return { configured: false, source: null };
}

function setCursorDashboardTokenSettings({ sessionToken, remove = false } = {}) {
  if (typeof stmts?.upsertAppSetting?.run !== 'function' || typeof stmts?.deleteAppSetting?.run !== 'function') {
    return { ok: false, error: 'Cursor dashboard token settings are unavailable' };
  }
  if (remove) {
    stmts.deleteAppSetting.run(CURSOR_SESSION_TOKEN_SETTING_KEY);
    return { ok: true, configured: false };
  }
  const normalized = String(sessionToken || '').trim();
  if (!normalized) return { ok: false, error: 'Missing sessionToken' };
  if (/\s/.test(normalized) || normalized.length > 8192) {
    return { ok: false, error: 'That does not look like a WorkosCursorSessionToken cookie value' };
  }
  stmts.upsertAppSetting.run(CURSOR_SESSION_TOKEN_SETTING_KEY, normalized, new Date().toISOString());
  return { ok: true, configured: true };
}

function getCursorPlanAllowanceSettings() {
  const readNumeric = (key) => {
    const raw = readAppSettingValue(key);
    if (raw === '' || raw === null || raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return normalizeCursorAllowanceSettings({
    cursorModelsUsd: readNumeric(CURSOR_ALLOWANCE_CURSOR_MODELS_SETTING_KEY),
    otherModelsUsd: readNumeric(CURSOR_ALLOWANCE_OTHER_MODELS_SETTING_KEY),
    resetDay: readNumeric(CURSOR_ALLOWANCE_RESET_DAY_SETTING_KEY),
  });
}

function setCursorPlanAllowanceSettings(update = {}) {
  if (typeof stmts?.upsertAppSetting?.run !== 'function' || typeof stmts?.deleteAppSetting?.run !== 'function') {
    return { ok: false, error: 'Cursor allowance settings are unavailable' };
  }
  const payload = update && typeof update === 'object' ? update : {};
  const current = getCursorPlanAllowanceSettings();
  const nowIso = new Date().toISOString();

  // Plan every write before performing any of them: the form posts all three
  // fields together, so a rejected second field must not leave the first one
  // already persisted.
  const writes = [];
  const planAllowance = (key, value, label) => {
    if (value === undefined) return null;
    // null / '' clears the allowance so the card falls back to "spend only".
    if (value === null || value === '') {
      writes.push(() => stmts.deleteAppSetting.run(key));
      return null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return { error: `Invalid ${label} allowance` };
    const normalized = Math.round(parsed * 100) / 100;
    writes.push(() => stmts.upsertAppSetting.run(key, String(normalized), nowIso));
    return null;
  };

  const cursorModelsError = planAllowance(
    CURSOR_ALLOWANCE_CURSOR_MODELS_SETTING_KEY,
    payload.cursorModelsUsd,
    'Cursor Models',
  );
  if (cursorModelsError) return { ok: false, ...cursorModelsError };
  const otherModelsError = planAllowance(
    CURSOR_ALLOWANCE_OTHER_MODELS_SETTING_KEY,
    payload.otherModelsUsd,
    'Other Models',
  );
  if (otherModelsError) return { ok: false, ...otherModelsError };

  let resetDay = current.resetDay;
  if (payload.resetDay !== undefined) {
    const parsedDay = Number(payload.resetDay);
    if (!Number.isFinite(parsedDay) || parsedDay < 1 || parsedDay > 31) {
      return { ok: false, error: 'Reset day must be between 1 and 31' };
    }
    resetDay = Math.round(parsedDay);
    writes.push(() => stmts.upsertAppSetting.run(CURSOR_ALLOWANCE_RESET_DAY_SETTING_KEY, String(resetDay), nowIso));
  }

  const applyWrites = db.transaction(() => {
    for (const write of writes) write();
  });
  applyWrites();

  if (payload.resetAccounting === true) {
    planUsageService.resetCursorAccounting({ resetDay });
  }

  return { ok: true, ...getCursorPlanAllowanceSettings() };
}

/**
 * Manual Grok plan allowance. ACP exposes per-turn cost/tokens but no remaining
 * plan credits, so this optional monthly USD budget is the only source for an
 * estimated "how much is left" meter on the Grok usage card.
 */
function getGrokPlanAllowanceSettings() {
  const readNumeric = (key) => {
    const raw = readAppSettingValue(key);
    if (raw === '' || raw === null || raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return normalizeGrokAllowanceSettings({
    monthlyUsd: readNumeric(GROK_ALLOWANCE_MONTHLY_USD_SETTING_KEY),
    resetDay: readNumeric(GROK_ALLOWANCE_RESET_DAY_SETTING_KEY),
  });
}

function setGrokPlanAllowanceSettings(update = {}) {
  if (typeof stmts?.upsertAppSetting?.run !== 'function' || typeof stmts?.deleteAppSetting?.run !== 'function') {
    return { ok: false, error: 'Grok allowance settings are unavailable' };
  }
  const payload = update && typeof update === 'object' ? update : {};
  const current = getGrokPlanAllowanceSettings();
  const nowIso = new Date().toISOString();
  const writes = [];

  if (payload.monthlyUsd !== undefined) {
    if (payload.monthlyUsd === null || payload.monthlyUsd === '') {
      writes.push(() => stmts.deleteAppSetting.run(GROK_ALLOWANCE_MONTHLY_USD_SETTING_KEY));
    } else {
      const parsed = Number(payload.monthlyUsd);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return { ok: false, error: 'Invalid monthly allowance' };
      }
      const normalized = Math.round(parsed * 100) / 100;
      writes.push(() => stmts.upsertAppSetting.run(GROK_ALLOWANCE_MONTHLY_USD_SETTING_KEY, String(normalized), nowIso));
    }
  }

  let resetDay = current.resetDay;
  if (payload.resetDay !== undefined) {
    const parsedDay = Number(payload.resetDay);
    if (!Number.isFinite(parsedDay) || parsedDay < 1 || parsedDay > 31) {
      return { ok: false, error: 'Reset day must be between 1 and 31' };
    }
    resetDay = Math.round(parsedDay);
    writes.push(() => stmts.upsertAppSetting.run(GROK_ALLOWANCE_RESET_DAY_SETTING_KEY, String(resetDay), nowIso));
  }

  if (writes.length) {
    const applyWrites = db.transaction(() => {
      for (const write of writes) write();
    });
    applyWrites();
  }

  if (payload.resetAccounting === true) {
    planUsageService.resetGrokAccounting({ resetDay });
  }

  return { ok: true, ...getGrokPlanAllowanceSettings() };
}

function setCursorProviderSettings(update = {}) {
  const payload = update && typeof update === 'object' ? update : {};
  const apiKey = payload.apiKey;
  const model = payload.model;
  const enabled = payload.enabled;
  const enabledModels = payload.enabledModels;
  const remove = payload.remove === true;
  if (typeof stmts?.upsertAppSetting?.run !== 'function' || typeof stmts?.deleteAppSetting?.run !== 'function') {
    return { ok: false, error: 'Cursor settings are unavailable' };
  }
  const existing = getCursorProviderSettings();
  const normalizedModel = String(model || existing.model || '').trim() || DEFAULT_CURSOR_MODEL;
  if (!isSafeCursorModelId(normalizedModel)) {
    return { ok: false, error: 'Invalid Cursor model ID' };
  }
  const nowIso = new Date().toISOString();
  if (remove) {
    const providerCandidates = Array.isArray(stmts?.listRuntimeSessionProviderCandidates?.all?.())
      ? stmts.listRuntimeSessionProviderCandidates.all()
      : [];
    const startedConversationCount = providerCandidates.filter((row) => (
      String(row?.provider_type || 'github').trim().toLowerCase() === 'cursor'
      && Number(row?.message_count || 0) > 0
    )).length;
    const activeQueueConversationCount = providerCandidates.filter((row) => (
      String(row?.provider_type || 'github').trim().toLowerCase() === 'cursor'
      && Number(row?.active_queue_count || 0) > 0
    )).length;
    const activeConversationCount = providerCandidates.filter((row) => (
      String(row?.provider_type || 'github').trim().toLowerCase() === 'cursor'
      && (Number(row?.message_count || 0) > 0 || Number(row?.active_queue_count || 0) > 0)
    )).length;
    if (activeConversationCount > 0) {
      return {
        ok: false,
        code: 'cursor-key-removal-blocked',
        error: `Cannot remove Cursor API key while ${activeConversationCount} active Cursor conversation(s) still exist. Disable Cursor for new conversations instead.`,
        activeConversationCount,
        startedConversationCount,
        activeQueueConversationCount,
      };
    }
    stmts.deleteAppSetting.run(CURSOR_API_KEY_SETTING_KEY);
    stmts.deleteAppSetting.run(CURSOR_MODELS_SETTING_KEY);
    stmts.deleteAppSetting.run(CURSOR_ENABLED_MODELS_SETTING_KEY);
    stmts.deleteAppSetting.run(CURSOR_MODEL_EFFORTS_SETTING_KEY);
    stmts.deleteAppSetting.run(CURSOR_MODEL_REASONING_OFF_SETTING_KEY);
    stmts.upsertAppSetting.run(CURSOR_ENABLED_SETTING_KEY, 'false', nowIso);
    stmts.upsertAppSetting.run(CURSOR_MODEL_SETTING_KEY, normalizedModel, nowIso);
  } else {
    const normalizedApiKey = String(apiKey || '').trim();
    if (normalizedApiKey) {
      stmts.deleteAppSetting.run(CURSOR_MODELS_SETTING_KEY);
      stmts.deleteAppSetting.run(CURSOR_MODEL_EFFORTS_SETTING_KEY);
      stmts.deleteAppSetting.run(CURSOR_MODEL_REASONING_OFF_SETTING_KEY);
      stmts.upsertAppSetting.run(CURSOR_API_KEY_SETTING_KEY, normalizedApiKey, nowIso);
    }
    const hasApiKey = !!(normalizedApiKey || existing.apiKey);
    const nextEnabled = typeof enabled === 'boolean' ? enabled : (normalizedApiKey ? true : existing.enabled);
    if (nextEnabled && !hasApiKey) return { ok: false, error: 'Cursor API key is not configured' };
    stmts.upsertAppSetting.run(CURSOR_ENABLED_SETTING_KEY, nextEnabled ? 'true' : 'false', nowIso);
    stmts.upsertAppSetting.run(CURSOR_MODEL_SETTING_KEY, normalizedModel, nowIso);
    if (Array.isArray(enabledModels)) {
      const normalizedEnabledModels = enabledModels
        .map((value) => String(value || '').trim())
        .filter((value) => value && isSafeCursorModelId(value));
      if (normalizedEnabledModels.length) {
        stmts.upsertAppSetting.run(CURSOR_ENABLED_MODELS_SETTING_KEY, JSON.stringify(normalizedEnabledModels), nowIso);
      } else {
        stmts.deleteAppSetting.run(CURSOR_ENABLED_MODELS_SETTING_KEY);
      }
    }
  }
  const current = getCursorProviderSettings();
  return {
    ok: true,
    configured: current.configured,
    enabled: current.enabled,
    model: current.model,
    models: current.models,
    availableModels: current.availableModels,
  };
}

const CURSOR_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

// Reasoning tiers for one discovered Cursor model, in composer vocabulary.
// Cursor exposes effort as a per-model parameter named 'effort' or 'reasoning'
// whose value list varies by model; 'extra-high' is Cursor's spelling of the
// composer's 'xhigh'. Values with no composer equivalent (e.g. 'minimal') are
// dropped rather than remapped onto a tier the model does not actually have.
// Mirrors resolveCursorReasoningParams exactly, including its parameter
// precedence: it consults 'effort' first and only falls back to 'reasoning',
// so scanning both would advertise an off switch the worker never sends.
function cursorEntrySupportsReasoningOff(entry) {
  const parameters = Array.isArray(entry?.parameters) ? entry.parameters : [];
  const byId = new Map(parameters.map((param) => [String(param?.id || '').trim().toLowerCase(), param]));
  if (byId.has('thinking')) return true;
  const effortParam = byId.get('effort') || byId.get('reasoning');
  const values = Array.isArray(effortParam?.values) ? effortParam.values : [];
  return values.some((value) => (
    String((value && typeof value === 'object' ? value.value : value) || '').trim().toLowerCase() === 'none'
  ));
}

function cursorEntryEffortLevels(entry) {
  const parameters = Array.isArray(entry?.parameters) ? entry.parameters : [];
  // Same precedence as cursorEntrySupportsReasoningOff and the adapter: a model
  // listing both parameters must not have its tiers read from one and its off
  // switch from the other.
  const byId = new Map(parameters.map((param) => [String(param?.id || '').trim().toLowerCase(), param]));
  const effortParam = byId.get('effort') || byId.get('reasoning');
  if (!effortParam) return [];
  const levels = [];
  for (const value of (Array.isArray(effortParam.values) ? effortParam.values : [])) {
    const raw = String((value && typeof value === 'object' ? value.value : value) || '').trim().toLowerCase();
    const level = raw === 'extra-high' ? 'xhigh' : raw;
    if (CURSOR_EFFORT_LEVELS.has(level) && !levels.includes(level)) levels.push(level);
  }
  return levels;
}

// Discover the models the Cursor Agent SDK can serve (mirrors
// refreshClaudeProviderModels). The SDK's model-listing entry point is
// normalized defensively (static list vs. client instance) pending spike
// confirmation of the exact call form.
async function refreshCursorProviderModels() {
  const settings = getCursorProviderSettings();
  if (typeof stmts?.upsertAppSetting?.run !== 'function') {
    return { ok: false, models: settings.models, error: 'Cursor settings are unavailable' };
  }
  if (settings.enabled !== true) {
    return { ok: false, models: settings.models, error: 'Cursor API key is not configured' };
  }
  try {
    const mod = await import('@cursor/sdk');
    const listModels = async () => {
      try {
        const listed = await mod.Cursor?.models?.list?.({ apiKey: settings.apiKey });
        if (listed !== undefined) return listed;
      } catch { /* fall through to the client-instance form */ }
      const CursorClient = mod.Cursor || mod.default;
      return new CursorClient({ apiKey: settings.apiKey }).models.list();
    };
    const payload = await Promise.race([
      listModels(),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out after ${CURSOR_MODEL_DISCOVERY_TIMEOUT_MS}ms`)),
          CURSOR_MODEL_DISCOVERY_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    const entries = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.models)
        ? payload.models
        : (Array.isArray(payload?.data) ? payload.data : []));
    const discovered = [];
    const effortsByModel = {};
    const reasoningOffByModel = {};
    for (const entry of entries) {
      const modelId = String(typeof entry === 'string' ? entry : (entry?.id || entry?.name || '')).trim();
      if (!modelId || !isSafeCursorModelId(modelId)) continue;
      discovered.push(modelId);
      const effortLevels = cursorEntryEffortLevels(entry);
      if (effortLevels.length) effortsByModel[modelId.toLowerCase()] = effortLevels;
      reasoningOffByModel[modelId.toLowerCase()] = cursorEntrySupportsReasoningOff(entry);
    }
    if (!discovered.length) {
      return { ok: false, models: settings.models, error: 'Cursor model discovery returned no models' };
    }
    const nowIso = new Date().toISOString();
    const models = Array.from(new Set([settings.model, ...discovered])).filter(Boolean);
    stmts.upsertAppSetting.run(CURSOR_MODELS_SETTING_KEY, JSON.stringify(models), nowIso);
    stmts.upsertAppSetting.run(CURSOR_MODEL_EFFORTS_SETTING_KEY, JSON.stringify(effortsByModel), nowIso);
    stmts.upsertAppSetting.run(CURSOR_MODEL_REASONING_OFF_SETTING_KEY, JSON.stringify(reasoningOffByModel), nowIso);
    return { ok: true, models, error: null };
  } catch (error) {
    return {
      ok: false,
      models: settings.models,
      error: `Cursor model discovery failed: ${String(error?.message || error || 'unknown error')}`,
    };
  }
}

function readGrokModelListSetting(settingKey) {
  try {
    const parsed = JSON.parse(readAppSettingValue(settingKey) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => String(value || '').trim())
      .filter((modelId) => modelId && isSafeGrokModelId(modelId));
  } catch {
    return [];
  }
}

function readGrokModelEffortsSetting() {
  try {
    const parsed = JSON.parse(readAppSettingValue(GROK_MODEL_EFFORTS_SETTING_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [modelId, efforts] of Object.entries(parsed)) {
      const key = String(modelId || '').trim().toLowerCase();
      if (!key) continue;
      const levels = (Array.isArray(efforts) ? efforts : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => GROK_EFFORT_LEVELS.has(value));
      out[key] = levels;
    }
    return out;
  } catch {
    return {};
  }
}

function getGrokProviderSettings() {
  const enabledSetting = readAppSettingValue(GROK_ENABLED_SETTING_KEY);
  const enabled = enabledSetting === 'true';
  const model = readAppSettingValue(GROK_MODEL_SETTING_KEY) || DEFAULT_GROK_MODEL;
  const discovered = readGrokModelListSetting(GROK_MODELS_SETTING_KEY);
  const modelsDiscovered = discovered.length > 0;
  const availableModels = Array.from(new Set([
    model,
    ...(discovered.length ? discovered : DEFAULT_GROK_MODELS),
  ])).filter(Boolean);
  const availableSet = new Set(availableModels);
  const enabledSelection = readGrokModelListSetting(GROK_ENABLED_MODELS_SETTING_KEY)
    .filter((modelId) => availableSet.has(modelId));
  const models = Array.from(new Set([
    model,
    ...(enabledSelection.length ? enabledSelection : availableModels),
  ])).filter(Boolean);
  const storedEfforts = readGrokModelEffortsSetting();
  const effortsByModel = {};
  for (const availableModel of availableModels) {
    const key = String(availableModel || '').trim().toLowerCase();
    if (!key) continue;
    const discoveredEfforts = storedEfforts[key];
    effortsByModel[key] = Array.isArray(discoveredEfforts) && discoveredEfforts.length
      ? ['none', ...discoveredEfforts.filter((value) => value !== 'none')]
      : [...GROK_REASONING_EFFORTS];
  }
  return {
    // Host's Grok CLI login / XAI_API_KEY; enablement is the only configuration step.
    configured: enabled,
    enabled,
    model,
    models,
    availableModels,
    enabledModels: models,
    effortsByModel,
    modelsDiscovered,
    providerType: 'grok',
  };
}

function setGrokProviderSettings(update = {}) {
  const payload = update && typeof update === 'object' ? update : {};
  const enabled = payload.enabled;
  const model = payload.model;
  const models = payload.models;
  const enabledModels = payload.enabledModels;
  if (typeof stmts?.upsertAppSetting?.run !== 'function') {
    return { ok: false, error: 'Grok settings are unavailable' };
  }
  const existing = getGrokProviderSettings();
  const normalizedModel = String(model || existing.model || '').trim() || DEFAULT_GROK_MODEL;
  if (!isSafeGrokModelId(normalizedModel)) {
    return { ok: false, error: 'Invalid Grok model ID' };
  }
  const nowIso = new Date().toISOString();
  const nextEnabled = typeof enabled === 'boolean' ? enabled : existing.enabled;
  stmts.upsertAppSetting.run(GROK_ENABLED_SETTING_KEY, nextEnabled ? 'true' : 'false', nowIso);
  stmts.upsertAppSetting.run(GROK_MODEL_SETTING_KEY, normalizedModel, nowIso);
  if (Array.isArray(models)) {
    const normalizedModels = models
      .map((value) => String(value || '').trim())
      .filter((value) => value && isSafeGrokModelId(value));
    if (normalizedModels.length) {
      stmts.upsertAppSetting.run(GROK_MODELS_SETTING_KEY, JSON.stringify(normalizedModels), nowIso);
    } else {
      stmts.deleteAppSetting?.run?.(GROK_MODELS_SETTING_KEY);
    }
  }
  if (Array.isArray(enabledModels)) {
    const normalizedEnabledModels = enabledModels
      .map((value) => String(value || '').trim())
      .filter((value) => value && isSafeGrokModelId(value));
    if (normalizedEnabledModels.length) {
      stmts.upsertAppSetting.run(GROK_ENABLED_MODELS_SETTING_KEY, JSON.stringify(normalizedEnabledModels), nowIso);
    } else {
      stmts.deleteAppSetting?.run?.(GROK_ENABLED_MODELS_SETTING_KEY);
    }
  }
  const current = getGrokProviderSettings();
  return {
    ok: true,
    configured: current.configured,
    enabled: current.enabled,
    model: current.model,
    models: current.models,
    availableModels: current.availableModels,
  };
}

const GROK_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

// Same override chain the grok session worker uses to locate the CLI.
function resolveGrokCliCommand() {
  return String(process.env.GROK_CLI_COMMAND || process.env.GROK_COMMAND || '').trim() || 'grok';
}

// Discover models via a short-lived Grok ACP initialize (no full prompt).
async function refreshGrokProviderModels() {
  const settings = getGrokProviderSettings();
  if (typeof stmts?.upsertAppSetting?.run !== 'function') {
    return { ok: false, models: settings.models, error: 'Grok settings are unavailable' };
  }
  if (settings.enabled !== true) {
    return { ok: false, models: settings.models, error: 'Grok provider is disabled' };
  }
  const grokCommand = resolveGrokCliCommand();
  let handle = null;
  let handlePromise = null;
  try {
    const { createGrokAgentHandle, extractGrokModelsFromInitialize } = await import('./grok-worker/grok-sdk-adapter.mjs');
    handlePromise = createGrokAgentHandle({
      command: grokCommand,
      cwd: os.tmpdir(),
      alwaysApprove: true,
      model: settings.model,
      dbg: () => {},
    });
    handle = await Promise.race([
      handlePromise,
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out after ${GROK_MODEL_DISCOVERY_TIMEOUT_MS}ms`)),
          GROK_MODEL_DISCOVERY_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    const discoveredInfo = handle?.discovered
      || extractGrokModelsFromInitialize(handle?.client?.initializeResult);
    let discovered = Array.isArray(discoveredInfo?.models) ? discoveredInfo.models : [];
    discovered = discovered.filter((modelId) => isSafeGrokModelId(modelId));
    // Fallback: parse `grok models` CLI if initialize meta is empty. Async so
    // a slow CLI cannot freeze the relay event loop.
    if (!discovered.length) {
      try {
        const output = await new Promise((resolve, reject) => {
          execFile(grokCommand, ['models'], {
            encoding: 'utf8',
            timeout: 15_000,
            windowsHide: true,
          }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          });
        });
        for (const line of String(output || '').split(/\r?\n/)) {
          const match = line.match(/\*\s+([a-z0-9][a-z0-9._/-]*)/i);
          if (match?.[1] && isSafeGrokModelId(match[1])) discovered.push(match[1]);
        }
      } catch {
        /* fall through */
      }
    }
    if (!discovered.length) {
      discovered = [...DEFAULT_GROK_MODELS];
    }
    const effortsByModel = {};
    for (const [key, efforts] of Object.entries(discoveredInfo?.effortsByModel || {})) {
      const levels = (Array.isArray(efforts) ? efforts : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value) => GROK_EFFORT_LEVELS.has(value) && value !== 'none');
      if (levels.length) effortsByModel[String(key).toLowerCase()] = levels;
    }
    const nowIso = new Date().toISOString();
    const models = Array.from(new Set([settings.model, ...discovered])).filter(Boolean);
    stmts.upsertAppSetting.run(GROK_MODELS_SETTING_KEY, JSON.stringify(models), nowIso);
    stmts.upsertAppSetting.run(GROK_MODEL_EFFORTS_SETTING_KEY, JSON.stringify(effortsByModel), nowIso);
    return { ok: true, models, error: null };
  } catch (error) {
    return {
      ok: false,
      models: settings.models,
      error: `Grok model discovery failed: ${String(error?.message || error || 'unknown error')}`,
    };
  } finally {
    if (handle) {
      try { await handle.close?.(); } catch { /* best-effort */ }
    } else if (handlePromise) {
      // The timeout won the race: the spawn may still resolve later with a
      // live `grok agent` child that nobody else owns — dispose it then.
      handlePromise.then((late) => late?.close?.()).catch(() => {});
    }
  }
}

const DEFAULT_CONFIG = { authToken: '', port: 3333, pollIntervalMs: 3000, conversationSessionMode: 'isolated', localhostOnly: true };
// How long a turn may go without any sign of life from its worker before the
// relay assumes the worker died. This is an inactivity window, not a cap on turn
// length — see recoverStaleMessages.
const DEFAULT_PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;
const TURN_CEILING_SETTING_KEY = 'turn_ceiling_minutes';
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const OPENAI_API_KEY_SETTING_KEY = 'openai_api_key';
const OPENAI_ENABLED_SETTING_KEY = 'openai_enabled';
const OPENAI_MODEL_SETTING_KEY = 'openai_model';
const OPENAI_MODELS_SETTING_KEY = 'openai_models';
const OPENAI_BASE_URL_SETTING_KEY = 'openai_base_url';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const CLAUDE_ENABLED_SETTING_KEY = 'claude_enabled';
const CLAUDE_MODEL_SETTING_KEY = 'claude_model';
const CLAUDE_MODELS_SETTING_KEY = 'claude_models';
const CLAUDE_ENABLED_MODELS_SETTING_KEY = 'claude_enabled_models';
const CLAUDE_MODEL_EFFORTS_SETTING_KEY = 'claude_model_efforts';
// 'none' = let the SDK use its default effort (high); the rest map straight
// onto the Agent SDK's EffortLevel values.
const CLAUDE_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
const DEFAULT_CLAUDE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];
const CURSOR_API_KEY_SETTING_KEY = 'cursor_api_key';
const CURSOR_SESSION_TOKEN_SETTING_KEY = 'cursor_session_token';
const CURSOR_ENABLED_SETTING_KEY = 'cursor_enabled';
const CURSOR_MODEL_SETTING_KEY = 'cursor_model';
const CURSOR_MODELS_SETTING_KEY = 'cursor_models';
const CURSOR_ENABLED_MODELS_SETTING_KEY = 'cursor_enabled_models';
const CURSOR_MODEL_EFFORTS_SETTING_KEY = 'cursor_model_efforts';
// Whether a Cursor model can actually be told to stop reasoning ('thinking'
// param, or an 'effort' value of 'none'). Without it, 'none' means "model
// default" and the composer must not promise reasoning-off.
const CURSOR_MODEL_REASONING_OFF_SETTING_KEY = 'cursor_model_reasoning_off';
// Cursor exposes no account API for the monthly included pools, so the
// allowances the plan-usage card measures spend against are user-supplied.
const CURSOR_ALLOWANCE_CURSOR_MODELS_SETTING_KEY = 'cursor_allowance_cursor_models_usd';
const CURSOR_ALLOWANCE_OTHER_MODELS_SETTING_KEY = 'cursor_allowance_other_models_usd';
const CURSOR_ALLOWANCE_RESET_DAY_SETTING_KEY = 'cursor_allowance_reset_day';
const GROK_ALLOWANCE_MONTHLY_USD_SETTING_KEY = 'grok_allowance_monthly_usd';
const GROK_ALLOWANCE_RESET_DAY_SETTING_KEY = 'grok_allowance_reset_day';
const CURSOR_EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_CURSOR_MODEL = 'composer-2.5';
const DEFAULT_CURSOR_MODELS = ['composer-2.5'];
const GROK_ENABLED_SETTING_KEY = 'grok_enabled';
const GROK_MODEL_SETTING_KEY = 'grok_model';
const GROK_MODELS_SETTING_KEY = 'grok_models';
const GROK_ENABLED_MODELS_SETTING_KEY = 'grok_enabled_models';
const GROK_MODEL_EFFORTS_SETTING_KEY = 'grok_model_efforts';
const GROK_EFFORT_LEVELS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const GROK_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];
const DEFAULT_GROK_MODEL = 'grok-4.5';
const DEFAULT_GROK_MODELS = ['grok-4.5'];
const SUPPORTED_RELAY_MODES = ['plan', 'ask', 'agent', 'autopilot'];
const DEFAULT_RELAY_MODE = 'agent';
const AUTO_MODEL_SENTINEL = 'auto';
const SUPPORTED_CONVERSATION_SESSION_MODES = ['isolated', 'shared'];
const DEFAULT_CONVERSATION_SESSION_MODE = 'isolated';
const MAX_UPLOAD_ATTACHMENTS = 6;
// Cloudflare passes bodies up to 100 MB on Free/Pro; 64 MiB leaves headroom.
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_LENGTH = 12 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES = 1 * 1024 * 1024;
const DEFAULT_SESSION_WORKSPACE_ROOT_KEY = 'default_session_workspace_root_path';
const REFERENCE_TOKEN_PATTERN_BACKTICK = /`@(file|folder):([^`]+)`/gi;
const REFERENCE_TOKEN_PATTERN_PLAIN = /(^|[\s(])@(file|folder):([^\s`]+)/gi;
const WORKSPACE_META_CACHE_TTL_MS = 2_000;
const MAX_WORKSPACE_PREVIEW_BYTES = 512 * 1024;
const WORKSPACE_PREVIEW_BINARY_SAMPLE_BYTES = 8 * 1024;
const MAX_RECENT_WORKSPACE_ROOTS = 12;
const WORKSPACE_RECURSIVE_WATCH_SUPPORTED = process.platform === 'win32' || process.platform === 'darwin';
const WORKSPACE_CONTENT_TYPES = Object.freeze({
  '.md': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.rst': 'text/plain; charset=utf-8',
  '.adoc': 'text/plain; charset=utf-8',
  '.asciidoc': 'text/plain; charset=utf-8',
  '.tex': 'text/plain; charset=utf-8',
  '.bib': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.ndjson': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.scss': 'text/plain; charset=utf-8',
  '.sass': 'text/plain; charset=utf-8',
  '.less': 'text/plain; charset=utf-8',
  '.vue': 'text/plain; charset=utf-8',
  '.svelte': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',
  '.properties': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.graphql': 'text/plain; charset=utf-8',
  '.gql': 'text/plain; charset=utf-8',
  '.proto': 'text/plain; charset=utf-8',
  '.thrift': 'text/plain; charset=utf-8',
  '.sol': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.psm1': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.bash': 'text/plain; charset=utf-8',
  '.zsh': 'text/plain; charset=utf-8',
  '.fish': 'text/plain; charset=utf-8',
  '.bat': 'text/plain; charset=utf-8',
  '.cmd': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8',
  '.php': 'text/plain; charset=utf-8',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.cpp': 'text/plain; charset=utf-8',
  '.hpp': 'text/plain; charset=utf-8',
  '.cc': 'text/plain; charset=utf-8',
  '.cxx': 'text/plain; charset=utf-8',
  '.hh': 'text/plain; charset=utf-8',
  '.hxx': 'text/plain; charset=utf-8',
  '.cs': 'text/plain; charset=utf-8',
  '.kt': 'text/plain; charset=utf-8',
  '.kts': 'text/plain; charset=utf-8',
  '.swift': 'text/plain; charset=utf-8',
  '.m': 'text/plain; charset=utf-8',
  '.mm': 'text/plain; charset=utf-8',
  '.scala': 'text/plain; charset=utf-8',
  '.groovy': 'text/plain; charset=utf-8',
  '.dart': 'text/plain; charset=utf-8',
  '.zig': 'text/plain; charset=utf-8',
  '.ex': 'text/plain; charset=utf-8',
  '.exs': 'text/plain; charset=utf-8',
  '.erl': 'text/plain; charset=utf-8',
  '.hrl': 'text/plain; charset=utf-8',
  '.fs': 'text/plain; charset=utf-8',
  '.fsx': 'text/plain; charset=utf-8',
  '.vb': 'text/plain; charset=utf-8',
  '.pl': 'text/plain; charset=utf-8',
  '.pm': 'text/plain; charset=utf-8',
  '.lua': 'text/plain; charset=utf-8',
  '.r': 'text/plain; charset=utf-8',
  '.clj': 'text/plain; charset=utf-8',
  '.cljs': 'text/plain; charset=utf-8',
  '.hs': 'text/plain; charset=utf-8',
  '.ml': 'text/plain; charset=utf-8',
  '.mli': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.lock': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.pdf': 'application/pdf',
});
const WORKSPACE_CONTENT_TYPES_BY_FILENAME = Object.freeze({
  '.dockerignore': 'text/plain; charset=utf-8',
  '.editorconfig': 'text/plain; charset=utf-8',
  '.env': 'text/plain; charset=utf-8',
  '.gitignore': 'text/plain; charset=utf-8',
  '.npmrc': 'text/plain; charset=utf-8',
  'authors': 'text/plain; charset=utf-8',
  'changelog': 'text/plain; charset=utf-8',
  'cmakelists.txt': 'text/plain; charset=utf-8',
  'containerfile': 'text/plain; charset=utf-8',
  'dockerfile': 'text/plain; charset=utf-8',
  'gnumakefile': 'text/plain; charset=utf-8',
  'license': 'text/plain; charset=utf-8',
  'makefile': 'text/plain; charset=utf-8',
  'readme': 'text/plain; charset=utf-8',
});
const WORKSPACE_MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);
const WORKSPACE_PREVIEW_LANGUAGE_BY_EXTENSION = Object.freeze({
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'plaintext',
  '.rst': 'plaintext',
  '.adoc': 'plaintext',
  '.asciidoc': 'plaintext',
  '.tex': 'plaintext',
  '.bib': 'plaintext',
  '.json': 'json',
  '.jsonl': 'plaintext',
  '.ndjson': 'plaintext',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.jsx': 'javascript',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'scss',
  '.less': 'less',
  '.vue': 'xml',
  '.svelte': 'xml',
  '.html': 'xml',
  '.xml': 'xml',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.conf': 'plaintext',
  '.cfg': 'plaintext',
  '.properties': 'plaintext',
  '.csv': 'plaintext',
  '.tsv': 'plaintext',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.proto': 'plaintext',
  '.thrift': 'plaintext',
  '.sol': 'plaintext',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.fish': 'bash',
  '.bat': 'dos',
  '.cmd': 'dos',
  '.go': 'go',
  '.py': 'python',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.cs': 'csharp',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.m': 'objectivec',
  '.mm': 'objectivec',
  '.scala': 'plaintext',
  '.groovy': 'plaintext',
  '.dart': 'plaintext',
  '.zig': 'plaintext',
  '.ex': 'plaintext',
  '.exs': 'plaintext',
  '.erl': 'plaintext',
  '.hrl': 'plaintext',
  '.fs': 'plaintext',
  '.fsx': 'plaintext',
  '.vb': 'plaintext',
  '.pl': 'plaintext',
  '.pm': 'plaintext',
  '.lua': 'lua',
  '.r': 'r',
  '.clj': 'plaintext',
  '.cljs': 'plaintext',
  '.hs': 'plaintext',
  '.ml': 'plaintext',
  '.mli': 'plaintext',
  '.rs': 'rust',
  '.lock': 'plaintext',
  '.log': 'plaintext',
});
const WORKSPACE_PREVIEW_LANGUAGE_BY_FILENAME = Object.freeze({
  '.dockerignore': 'plaintext',
  '.editorconfig': 'ini',
  '.env': 'plaintext',
  '.gitignore': 'plaintext',
  '.npmrc': 'ini',
  'authors': 'plaintext',
  'changelog': 'plaintext',
  'cmakelists.txt': 'plaintext',
  'containerfile': 'plaintext',
  'dockerfile': 'plaintext',
  'gnumakefile': 'plaintext',
  'license': 'plaintext',
  'makefile': 'plaintext',
  'readme': 'plaintext',
});
const WORKSPACE_CODE_EXTENSIONS = new Set(Object.keys(WORKSPACE_PREVIEW_LANGUAGE_BY_EXTENSION)
  .filter((ext) => !WORKSPACE_MARKDOWN_EXTENSIONS.has(ext)));
const WORKSPACE_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const WORKSPACE_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.ogv', '.wmv']);
const REPO_HEAVY_DIR_NAMES = new Set(['.git', 'node_modules']);
const MAX_REPO_TREE_NODES = 20_000;
const MAX_REPO_TREE_DEPTH = 64;
const DRIVE_ROOT_PATTERN = /\b([A-Z]):\\/g;
const CURATED_MODEL_IDS = [
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'claude-sonnet-4.6',
  'claude-haiku-4.5',
];
const SUPPORTED_REASONING_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const REASONING_VARIANT_SUPPORTED_PREFIXES = ['gpt-', 'claude-'];

let config = { ...DEFAULT_CONFIG };
if (fs.existsSync(CONFIG_PATH)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch (e) { console.error('Failed to read config.json, using defaults.'); }
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --token <value> on the command line overrides config.json (in-memory only, not persisted)
const tokenArgIdx = process.argv.indexOf('--token');
if (tokenArgIdx !== -1 && process.argv[tokenArgIdx + 1]) {
  config.authToken = process.argv[tokenArgIdx + 1];
  console.log(`[server] Auth token set via --token argument (not persisted to config.json)`);
}

// --port <number> on the command line overrides config.json (in-memory only, not persisted)
const portArgIdx = process.argv.indexOf('--port');
if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
  const parsedPort = Number.parseInt(String(process.argv[portArgIdx + 1]), 10);
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
    config.port = parsedPort;
    console.log(`[server] Port set via --port argument: ${parsedPort} (not persisted to config.json)`);
  } else {
    console.warn(`[server] Ignoring invalid --port value: ${process.argv[portArgIdx + 1]}`);
  }
}

// --owner-pid <number> allows managed mode to auto-exit when the owning CLI process is gone.
const ownerPidArgIdx = process.argv.indexOf('--owner-pid');
const ownerPidRaw = ownerPidArgIdx !== -1 ? process.argv[ownerPidArgIdx + 1] : null;
const ownerPid = Number.parseInt(String(ownerPidRaw || ''), 10);
const managedOwnerPid = Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid : null;
if (managedOwnerPid) {
  console.log(`[server] Managed owner PID watchdog enabled: ${managedOwnerPid}`);
}

// Generate a random token if none is provided and token not given on CLI
if (!config.authToken || config.authToken === DEFAULT_CONFIG.authToken) {
  config.authToken = uuidv4();
  console.log(`[server] Generated random auth token (in-memory only): ${config.authToken}`);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const relaySingletonGuard = createRelaySingletonGuard({
  lockPath: RELAY_LOCK_PATH,
  pid: process.pid,
  token: config.authToken,
  isProcessAlive,
  logger: console,
});
try {
  relaySingletonGuard.acquire();
} catch (error) {
  console.error(`[server] ${error?.message || String(error)}`);
  process.exit(1);
}

const MAX_REQUEUE_RETRIES = Number.isFinite(Number(config.maxRequeueRetries))
  ? Math.max(1, Number(config.maxRequeueRetries))
  : 5;

const processingTimeoutMs = Number(config.processingTimeoutMs) > 0
  ? Number(config.processingTimeoutMs)
  : DEFAULT_PROCESSING_TIMEOUT_MS;
const restartGracefulTimeoutMs = Number(config.restartGracefulTimeoutMs) > 0
  ? Number(config.restartGracefulTimeoutMs)
  : 8_000;
const restartReadyCooldownMs = Number(config.restartReadyCooldownMs) > 0
  ? Number(config.restartReadyCooldownMs)
  : 1_000;
const restartShutdownTimeoutMs = Number(config.restartShutdownTimeoutMs) > 0
  ? Number(config.restartShutdownTimeoutMs)
  : 45_000;
const restartSpawnTimeoutMs = Number(config.restartSpawnTimeoutMs) > 0
  ? Number(config.restartSpawnTimeoutMs)
  : 18_000;
const restartRebindTimeoutMs = Number(config.restartRebindTimeoutMs) > 0
  ? Number(config.restartRebindTimeoutMs)
  : 20_000;
const restartMaxAttempts = Number.isFinite(Number(config.restartMaxAttempts))
  ? Math.max(1, Number(config.restartMaxAttempts))
  : 3;
const restartRetryBackoffMs = Array.isArray(config.restartRetryBackoffMs)
  ? config.restartRetryBackoffMs
  : [1_000, 3_000, 7_000];
const localhostOnly = config.localhostOnly === true || String(config.localhostOnly || '').trim().toLowerCase() === 'true';
const listenHost = localhostOnly ? '127.0.0.1' : '0.0.0.0';
// Optional containment for client-chosen launch directories. Unset/empty/malformed
// disables the check entirely, so existing deployments are unaffected. Entries
// that do not resolve to a directory are warned about and dropped rather than
// failing closed — a typo must not brick the relay.
const workspaceRootAllowList = normalizeWorkspaceRootAllowList(
  process.env.COPILOT_WORKSPACE_ROOT_ALLOW_LIST || config.workspaceRootAllowList,
);
if (workspaceRootAllowList.length) {
  console.log(`[workspace-root] allow list active (${workspaceRootAllowList.length} prefix(es))`);
}
const OFFLINE_STALE_RECOVER_MS = 45_000;
// Grace period between deciding to shut down and disconnecting sockets, so a
// terminal message_status emitted just before an idle-deferred restart still
// reaches the browser.
const SHUTDOWN_SOCKET_FLUSH_MS = 300;
let runtimeShutdownStarted = false;
const runtimeTimers = {
  cliStatus: null,
  ownerWatchdog: null,
  staleRecovery: null,
  questionExpiry: null,
  pendingWorkerPrime: null,
  sharedViewerPrune: null,
  shutdownDrain: null,
};

function normalizeRemotePath(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

function stripRequestPathPrefix(req, pathPrefix) {
  if (!pathPrefix) return false;
  const originalUrl = String(req.url || '');
  if (!originalUrl) return false;
  const queryIndex = originalUrl.indexOf('?');
  const pathname = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
  const search = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
  if (pathname !== pathPrefix && !pathname.startsWith(`${pathPrefix}/`)) return false;
  req.url = `${pathname.slice(pathPrefix.length) || '/'}${search}`;
  return true;
}

function rewriteSocketIoRequestPath(req, pathPrefix) {
  if (!pathPrefix) return false;
  const originalUrl = String(req.url || '');
  if (!originalUrl) return false;
  const queryIndex = originalUrl.indexOf('?');
  const pathname = queryIndex >= 0 ? originalUrl.slice(0, queryIndex) : originalUrl;
  const search = queryIndex >= 0 ? originalUrl.slice(queryIndex) : '';
  const socketPrefix = `${pathPrefix}/socket.io`;
  if (pathname !== socketPrefix && !pathname.startsWith(`${socketPrefix}/`)) return false;
  req.url = `/socket.io${pathname.slice(socketPrefix.length)}${search}`;
  return true;
}

function socketIoPath() {
  return '/socket.io/';
}

// Remote path prefix when served behind a reverse proxy subpath.
// Trailing slashes are stripped. Empty string means root.
const remotePath = normalizeRemotePath(config.remotePath);
const COOKIE_PATH = remotePath || '/';

let modelCatalog = {
  models: [DEFAULT_MODEL],
  currentModel: DEFAULT_MODEL,
  defaultModel: DEFAULT_MODEL,
  source: 'bootstrap',
  refreshedAt: null,
  error: null,
};
let modelSelectorSql = null;

const workspaceFileMetaCache = new Map();
let workspaceFileWatcher = null;
let workspaceRootPath = INITIAL_WORKSPACE_ROOT;
let workspaceRootName = workspaceRootDisplayName(INITIAL_WORKSPACE_ROOT);

function currentWorkspaceRootPath() {
  return workspaceRootPath;
}

function currentWorkspaceRootName() {
  return workspaceRootName;
}

function workspaceRootPayload() {
  const defaultSessionWorkspaceRootState = resolveDefaultSessionWorkspaceRootState();
  return {
    workspaceRootName: currentWorkspaceRootName(),
    workspaceRootPath: currentWorkspaceRootPath(),
    workspaceRootEntries: listWorkspaceRootEntries(),
    recentWorkspaceRoots: listRecentWorkspaceRoots(),
    defaultSessionWorkspaceRootPath: defaultSessionWorkspaceRootState.path,
    defaultSessionWorkspaceRootWarning: defaultSessionWorkspaceRootState.warning,
  };
}

const ACTIVE_SESSION_CWD_STATUSES = new Set(['starting', 'ready', 'processing']);
const ACTIVE_TTY_CLI_WORKER_STATUSES = new Set(['starting', 'ready', 'processing']);

function normalizeConversationWorkspaceRootPath(candidatePath) {
  const normalized = normalizeWorkspaceRootPath(candidatePath);
  return normalized || null;
}

// Per-session pending CWD registry. Stores the CLI working directory reported on
// startup before the session has been bound to any conversation. Consumed when the
// session eventually binds (via /api/session-sync) and persisted to the DB.
const pendingSessionCwds = new Map();
const MAX_PENDING_SESSION_CWDS = 64;

function setPendingSessionCwd(sdkSessionId, cwdPath) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) return false;
  const normalized = normalizeConversationWorkspaceRootPath(cwdPath);
  if (!normalized) return false;
  if (pendingSessionCwds.size >= MAX_PENDING_SESSION_CWDS) {
    const oldest = pendingSessionCwds.keys().next().value;
    if (oldest) pendingSessionCwds.delete(oldest);
  }
  pendingSessionCwds.set(sid, normalized);
  // Persist to the DB so the path survives relay restarts and appears in the
  // "Known CWDs" picker even before the session is bound to a conversation.
  rememberRecentWorkspaceRoot(normalized);
  return true;
}

function getPendingSessionCwd(sdkSessionId) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) return null;
  return pendingSessionCwds.get(sid) || null;
}

function consumePendingSessionCwd(sdkSessionId) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) return null;
  const value = pendingSessionCwds.get(sid) || null;
  if (value) pendingSessionCwds.delete(sid);
  return value;
}

function listRecentWorkspaceRoots(limit = MAX_RECENT_WORKSPACE_ROOTS) {
  const maxItems = Math.max(1, Math.min(MAX_RECENT_WORKSPACE_ROOTS, Number(limit) || MAX_RECENT_WORKSPACE_ROOTS));
  if (!stmts?.listRecentWorkspaceRoots?.all) return [];
  return stmts.listRecentWorkspaceRoots.all(maxItems)
    .map((row) => String(row?.path || '').trim())
    .filter(Boolean);
}

function rememberRecentWorkspaceRoot(rootPath) {
  const normalized = normalizeConversationWorkspaceRootPath(rootPath);
  if (!normalized) return null;
  if (!stmts?.upsertRecentWorkspaceRoot?.run || !stmts?.pruneRecentWorkspaceRoots?.run) return normalized;
  const nowIso = new Date().toISOString();
  // The newest casing wins for display: it is what the user just typed or what
  // the CLI just reported.
  stmts.upsertRecentWorkspaceRoot.run(normalizeWorkspaceRootKey(normalized), normalized, nowIso);
  stmts.pruneRecentWorkspaceRoots.run(MAX_RECENT_WORKSPACE_ROOTS);
  return normalized;
}

function readAppSettingValue(key) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey || typeof stmts?.getAppSetting?.get !== 'function') return '';
  return String(stmts.getAppSetting.get(normalizedKey)?.value || '').trim();
}

function getTurnCeilingMinutes() {
  return readTurnCeilingSetting(readAppSettingValue(TURN_CEILING_SETTING_KEY));
}

function setTurnCeilingMinutes(value) {
  if (typeof stmts?.upsertAppSetting?.run !== 'function') {
    return { ok: false, error: 'Turn ceiling settings are unavailable' };
  }
  const parsed = parseTurnCeilingUpdate(value);
  if (!parsed.ok) return parsed;
  stmts.upsertAppSetting.run(TURN_CEILING_SETTING_KEY, String(parsed.minutes), new Date().toISOString());
  return { ok: true, ceilingMinutes: parsed.minutes };
}

function resolveDefaultSessionWorkspaceRootState() {
  return resolveDefaultSessionWorkspaceRootStateFromService({
    storedPath: readAppSettingValue(DEFAULT_SESSION_WORKSPACE_ROOT_KEY),
    normalizePath: (candidatePath) => normalizeConversationWorkspaceRootPath(candidatePath),
  });
}

function getDefaultSessionWorkspaceRootPath({ validate = true } = {}) {
  if (!validate) {
    const stored = readAppSettingValue(DEFAULT_SESSION_WORKSPACE_ROOT_KEY);
    return stored || null;
  }
  return resolveDefaultSessionWorkspaceRootState().path;
}

function setDefaultSessionWorkspaceRootPath(nextRootPath, { allowClear = true } = {}) {
  if (typeof stmts?.upsertAppSetting?.run !== 'function' || typeof stmts?.deleteAppSetting?.run !== 'function') {
    return { ok: false, changed: false, error: 'Default session workspace setting is unavailable' };
  }
  const rawValue = String(nextRootPath || '').trim();
  const existing = getDefaultSessionWorkspaceRootPath({ validate: false });
  if (!rawValue) {
    if (!allowClear) return { ok: false, changed: false, error: 'Missing rootPath' };
    stmts.deleteAppSetting.run(DEFAULT_SESSION_WORKSPACE_ROOT_KEY);
    return {
      ok: true,
      changed: !!existing,
      rootPath: null,
      rootName: null,
    };
  }
  const normalized = normalizeWorkspaceRootPath(rawValue);
  if (!normalized) {
    return {
      ok: false,
      changed: false,
      error: `Directory not found: ${rawValue || '(empty path)'}`,
    };
  }
  const nowIso = new Date().toISOString();
  stmts.upsertAppSetting.run(DEFAULT_SESSION_WORKSPACE_ROOT_KEY, normalized, nowIso);
  rememberRecentWorkspaceRoot(normalized);
  return {
    ok: true,
    changed: String(existing || '').trim().toLowerCase() !== normalized.toLowerCase(),
    rootPath: normalized,
    rootName: workspaceRootDisplayName(normalized),
  };
}

function resolveConversationRecord({ conversationId = '', sdkSessionId = '' } = {}) {
  const convId = String(conversationId || '').trim();
  if (convId) {
    const direct = stmts.getConvAnyStatus.get(convId) || null;
    if (direct && String(direct.status || '').trim().toLowerCase() !== 'deleted') {
      return direct;
    }
  }
  const sid = String(sdkSessionId || '').trim();
  if (!sid || typeof stmts.getConvBySdkSessionId?.get !== 'function') return null;
  return stmts.getConvBySdkSessionId.get(sid) || null;
}

function isConversationSessionRunning(sdkSessionId) {
  const sid = String(sdkSessionId || '').trim();
  if (!sid) return false;
  const workerState = sessionWorkerRegistry?.getWorker?.(sid) || sessionWorkerSupervisor?.getWorkerState?.(sid) || null;
  const status = String(workerState?.status || '').trim().toLowerCase();
  return ACTIVE_SESSION_CWD_STATUSES.has(status);
}

function buildConversationWorkspaceRootState(row = null, {
  conversationId: fallbackConversationId = '',
  sdkSessionId: fallbackSdkSessionId = '',
  discoveredWorkspaceRootPath = '',
} = {}) {
  const conversation = row && typeof row === 'object' ? row : null;
  const conversationId = String(conversation?.id || fallbackConversationId || '').trim() || null;
  const sdkSessionId = String(conversation?.sdk_session_id || fallbackSdkSessionId || conversationId || '').trim() || null;
  // pendingCwd: CWD reported by the CLI at startup before the session was bound to any
  // conversation. Used as a fallback so the correct directory is shown as soon as the
  // session starts, even before the first message is processed.
  const pendingCwd = sdkSessionId ? getPendingSessionCwd(sdkSessionId) : null;
  const configuredWorkspaceRootPath =
    normalizeConversationWorkspaceRootPath(conversation?.configured_workspace_root_path)
    || null;
  const runtimeWorkspaceRootPath =
    normalizeConversationWorkspaceRootPath(conversation?.runtime_workspace_root_path)
    || null;
  const discoveredCurrentWorkspaceRootPath =
    normalizeConversationWorkspaceRootPath(discoveredWorkspaceRootPath)
    || null;
  const running = sdkSessionId ? isConversationSessionRunning(sdkSessionId) : false;
  const effectiveWorkspaceRootPath = running
    ? (runtimeWorkspaceRootPath || pendingCwd || configuredWorkspaceRootPath || discoveredCurrentWorkspaceRootPath || currentWorkspaceRootPath())
    : (pendingCwd || configuredWorkspaceRootPath || runtimeWorkspaceRootPath || discoveredCurrentWorkspaceRootPath || currentWorkspaceRootPath());
  const currentWorkspaceRootPathValue = effectiveWorkspaceRootPath || currentWorkspaceRootPath();
  return {
    conversationId,
    sdkSessionId,
    configuredWorkspaceRootPath: configuredWorkspaceRootPath || null,
    configuredWorkspaceRootName: configuredWorkspaceRootPath ? workspaceRootDisplayName(configuredWorkspaceRootPath) : null,
    runtimeWorkspaceRootPath,
    runtimeWorkspaceRootName: runtimeWorkspaceRootPath ? workspaceRootDisplayName(runtimeWorkspaceRootPath) : null,
    currentWorkspaceRootPath: currentWorkspaceRootPathValue || null,
    currentWorkspaceRootName: currentWorkspaceRootPathValue ? workspaceRootDisplayName(currentWorkspaceRootPathValue) : null,
    effectiveWorkspaceRootPath: effectiveWorkspaceRootPath || null,
    effectiveWorkspaceRootName: effectiveWorkspaceRootPath ? workspaceRootDisplayName(effectiveWorkspaceRootPath) : null,
    running,
  };
}

function resolveConversationWorkspaceState({
  conversationId = '',
  sdkSessionId = '',
  discoveredWorkspaceRootPath = '',
} = {}) {
  return buildConversationWorkspaceRootState(
    resolveConversationRecord({ conversationId, sdkSessionId }),
    { conversationId, sdkSessionId, discoveredWorkspaceRootPath },
  );
}

function updateConversationConfiguredWorkspaceRoot({ conversationId = '', sdkSessionId = '', rootPath = '' } = {}) {
  const row = resolveConversationRecord({ conversationId, sdkSessionId });
  if (!row?.id) {
    return { ok: false, error: 'Conversation not found' };
  }
  const normalizedRootPath = normalizeConversationWorkspaceRootPath(rootPath);
  if (!normalizedRootPath) {
    return { ok: false, error: `Directory not found: ${String(rootPath || '').trim() || '(empty path)'}` };
  }
  rememberRecentWorkspaceRoot(normalizedRootPath);
  const nowIso = new Date().toISOString();
  stmts.updateConvConfiguredWorkspaceRoot.run(normalizedRootPath, nowIso, row.id);
  const updated = resolveConversationRecord({ conversationId: row.id }) || row;
  return { ok: true, state: buildConversationWorkspaceRootState(updated) };
}

function learnConversationWorkspaceRoot({ sdkSessionId = '', conversationId = '', rootPath = '', seedConfigured = true } = {}) {
  let row = resolveConversationRecord({ conversationId, sdkSessionId });
  const fallbackConversationId = String(conversationId || '').trim();
  if (!row?.id && fallbackConversationId) {
    const nowIso = new Date().toISOString();
    stmts.insertConv.run(fallbackConversationId, 'Session', nowIso, nowIso);
    if (String(sdkSessionId || '').trim()) {
      stmts.setConvSdkSessionIdIfMissing.run(String(sdkSessionId || '').trim(), nowIso, fallbackConversationId);
    }
    row = resolveConversationRecord({ conversationId: fallbackConversationId, sdkSessionId }) || stmts.getConvAnyStatus.get(fallbackConversationId) || null;
  }
  if (!row?.id) {
    return { ok: false, error: 'Conversation not found' };
  }
  const normalizedRootPath = normalizeConversationWorkspaceRootPath(rootPath);
  if (!normalizedRootPath) {
    return { ok: false, error: `Directory not found: ${String(rootPath || '').trim() || '(empty path)'}` };
  }
  rememberRecentWorkspaceRoot(normalizedRootPath);
  const nowIso = new Date().toISOString();
  stmts.updateConvRuntimeWorkspaceRoot.run(normalizedRootPath, nowIso, row.id);
  if (seedConfigured) {
    stmts.seedConvConfiguredWorkspaceRootIfMissing.run(normalizedRootPath, nowIso, row.id);
  }
  const updated = resolveConversationRecord({ conversationId: row.id }) || row;
  return { ok: true, state: buildConversationWorkspaceRootState(updated) };
}

function resolveLaunchWorkspaceRootForSession(sdkSessionId) {
  const state = resolveConversationWorkspaceState({ sdkSessionId });
  // Fall back to the pending session CWD (reported by the CLI at startup) before using
  // the server-wide workspace root, so manually-started sessions with no DB-bound
  // conversation still launch in the directory where the CLI was originally started.
  const sid = String(sdkSessionId || '').trim();
  const defaultSessionWorkspaceRootPath = getDefaultSessionWorkspaceRootPath();
  return resolveLaunchWorkspaceRootPath({
    configuredWorkspaceRootPath: state?.configuredWorkspaceRootPath || '',
    pendingSessionWorkspaceRootPath: sid ? (getPendingSessionCwd(sid) || '') : '',
    defaultSessionWorkspaceRootPath: defaultSessionWorkspaceRootPath || '',
    workspaceRootPath: currentWorkspaceRootPath(),
  });
}

function normalizeWorkspaceRootPath(candidatePath) {
  // Lenient on purpose: this also normalizes paths a CLI reports about itself.
  // Client-supplied launch directories go through validateRequestedWorkspaceRoot
  // in services/workspace-root-path-policy.mjs instead.
  const value = normalizeDriveLetterOnlyPath(candidatePath);
  if (!value) return null;
  const resolved = path.resolve(value);
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function stopWorkspaceFileWatcher() {
  if (!workspaceFileWatcher) return;
  try {
    workspaceFileWatcher.close();
  } catch {}
  workspaceFileWatcher = null;
}

function applyWorkspaceRoot(nextRootPath, options = {}) {
  const normalized = normalizeWorkspaceRootPath(nextRootPath);
  if (!normalized) {
    return {
      changed: false,
      error: `Directory not found: ${String(nextRootPath || '').trim() || '(empty path)'}`,
    };
  }

  const current = path.resolve(currentWorkspaceRootPath());
  if (path.resolve(normalized) === current) {
    rememberRecentWorkspaceRoot(current);
    return {
      changed: false,
      rootPath: current,
      rootName: currentWorkspaceRootName(),
    };
  }

  workspaceRootPath = normalized;
  workspaceRootName = workspaceRootDisplayName(normalized);
  process.env.COPILOT_WORKSPACE_ROOT = normalized;
  try {
    process.chdir(normalized);
  } catch (error) {
    console.warn(`[server] Failed to chdir to ${normalized}: ${error?.message || String(error)}`);
  }
  workspaceFileMetaCache.clear();
  stopWorkspaceFileWatcher();
  startWorkspaceFileWatcher();
  rememberRecentWorkspaceRoot(normalized);

  const reason = String(options.reason || 'runtime-update').trim() || 'runtime-update';
  console.log(`[server] Workspace root updated (${reason}): ${normalized}`);
  return { changed: true, rootPath: normalized, rootName: workspaceRootName };
}

function maybeApplyWorkspaceRootFromMessage(text, baseWorkspaceRoot = null) {
  const target = parseCdCommandTarget(text);
  if (!target) return { attempted: false, changed: false };
  const baseRoot = normalizeConversationWorkspaceRootPath(baseWorkspaceRoot) || currentWorkspaceRootPath();
  if (WORKSPACE_ROOT_LOCKED) {
    return {
      attempted: true,
      changed: false,
      target,
      error: `Workspace root is locked to startup directory: ${baseRoot}`,
    };
  }
  const resolvedPath = resolveCdCommandPath(target, baseRoot);
  if (!resolvedPath) {
    return {
      attempted: true,
      changed: false,
      target,
      error: 'Unable to resolve directory path',
    };
  }
  const changed = path.resolve(resolvedPath) !== path.resolve(baseRoot);
  return {
    attempted: true,
    changed,
    target,
    rootPath: resolvedPath,
    rootName: workspaceRootDisplayName(resolvedPath),
    resolvedPath,
    error: null,
  };
}

function uniqueStringList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function validatedModelIdList(values) {
  return filterValidModelIds(uniqueStringList(values));
}

function curatedModelList() {
  return uniqueStringList(CURATED_MODEL_IDS);
}

function normalizeReasoningEffort(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  return SUPPORTED_REASONING_EFFORTS.includes(text) ? text : null;
}

function isReasoningVariantEligibleModel(modelId) {
  const normalized = String(modelId || '').trim().toLowerCase();
  if (!normalized) return false;
  return REASONING_VARIANT_SUPPORTED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function modelProviderForId(modelId) {
  const text = String(modelId || '').trim().toLowerCase();
  if (!text) return 'other';
  if (
    text.startsWith('gpt-')
    || text.startsWith('o1-')
    || text.startsWith('o3-')
    || text.startsWith('codex-')
    || text.startsWith('openai/')
  ) return 'openai';
  if (text.startsWith('claude-')) return 'anthropic';
  if (text.startsWith('gemini-')) return 'google';
  if (text.startsWith('mai-')) return 'microsoft';
  return 'other';
}

function titleCaseWord(word) {
  const text = String(word || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function modelDisplayLabel(modelId) {
  const text = String(modelId || '').trim();
  if (!text) return '';
  if (/^gpt-/i.test(text)) {
    return text
      .replace(/^gpt-/i, 'GPT-')
      .replace(/-codex$/i, ' Codex')
      .replace(/-mini$/i, ' Mini')
      .replace(/\bmini\b/gi, 'Mini')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (/^claude-/i.test(text)) {
    return text
      .replace(/^claude-/i, 'Claude ')
      .split('-')
      .map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : titleCaseWord(part)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (/^gemini-/i.test(text)) {
    return text
      .replace(/^gemini-/i, 'Gemini ')
      .split('-')
      .map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : titleCaseWord(part)))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return text;
}

function buildModelVariantId(baseModelId, reasoningEffort = null) {
  const base = String(baseModelId || '').trim();
  if (!base) return '';
  const effort = normalizeReasoningEffort(reasoningEffort);
  if (!effort) return base;
  return `${base}-${effort}`;
}

function parseModelVariantId(variantId = '', {
  knownBaseModels = [],
} = {}) {
  const value = String(variantId || '').trim();
  if (!value) return null;
  const known = Array.isArray(knownBaseModels)
    ? knownBaseModels.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const orderedKnown = known.sort((a, b) => b.length - a.length);
  for (const candidate of orderedKnown) {
    if (!value.toLowerCase().startsWith(`${candidate.toLowerCase()}-`)) continue;
    const suffix = value.slice(candidate.length + 1);
    const effort = normalizeReasoningEffort(suffix);
    if (effort) {
      return {
        variantId: buildModelVariantId(candidate, effort),
        baseModelId: candidate,
        reasoningEffort: effort,
      };
    }
  }
  const trailingEffortMatch = value.match(/^(.*?)-([a-z]+)$/i);
  if (trailingEffortMatch) {
    const effort = normalizeReasoningEffort(trailingEffortMatch[2]);
    const maybeBase = String(trailingEffortMatch[1] || '').trim();
    if (effort && maybeBase) {
      return {
        variantId: buildModelVariantId(maybeBase, effort),
        baseModelId: maybeBase,
        reasoningEffort: effort,
      };
    }
  }
  return {
    variantId: value,
    baseModelId: value,
    reasoningEffort: null,
  };
}

function normalizeModelVariantRow(row = {}) {
  const rawBaseModelId = String(row?.base_model_id || row?.baseModelId || '').trim();
  const baseModelId = canonicalizeModelId(rawBaseModelId) || rawBaseModelId;
  const reasoningEffort = normalizeReasoningEffort(row?.reasoning_effort ?? row?.reasoningEffort);
  const rawVariantId = String(row?.variant_id || row?.variantId || buildModelVariantId(baseModelId, reasoningEffort)).trim();
  const parsed = parseModelVariantId(rawVariantId, { knownBaseModels: baseModelId ? [baseModelId] : [] });
  const normalizedBaseModelId = canonicalizeModelId(parsed?.baseModelId || baseModelId) || baseModelId;
  const normalizedReasoningEffort = normalizeReasoningEffort(parsed?.reasoningEffort || reasoningEffort);
  const variantId = buildModelVariantId(normalizedBaseModelId, normalizedReasoningEffort);
  const provider = String(row?.provider || row?.providerId || modelProviderForId(baseModelId)).trim() || 'other';
  const label = String(row?.label || row?.displayName || modelDisplayLabel(normalizedBaseModelId)).trim() || normalizedBaseModelId;
  const enabledValue = Number(row?.enabled);
  const enabled = Number.isFinite(enabledValue) ? enabledValue === 1 : !!row?.enabled;
  return {
    variantId,
    baseModelId: normalizedBaseModelId,
    provider,
    reasoningEffort: normalizedReasoningEffort,
    label,
    releaseStatus: String(row?.release_status || row?.releaseStatus || '').trim() || null,
    contextLimitTokens: Number.isFinite(Number(row?.context_limit_tokens ?? row?.contextLimitTokens))
      && Number(row?.context_limit_tokens ?? row?.contextLimitTokens) > 0
      ? Math.round(Number(row?.context_limit_tokens ?? row?.contextLimitTokens))
      : null,
    longContextLimitTokens: Number.isFinite(Number(row?.long_context_limit_tokens ?? row?.longContextLimitTokens))
      && Number(row?.long_context_limit_tokens ?? row?.longContextLimitTokens) > 0
      ? Math.round(Number(row?.long_context_limit_tokens ?? row?.longContextLimitTokens))
      : null,
    pricing: (() => {
      const value = row?.pricing_json ?? row?.pricing;
      if (!value || typeof value === 'object') return value || null;
      try { return JSON.parse(value); } catch { return null; }
    })(),
    enabled,
    sortOrder: Number.isFinite(Number(row?.sort_order ?? row?.sortOrder))
      ? Math.max(0, Math.trunc(Number(row?.sort_order ?? row?.sortOrder)))
      : 0,
    updatedAt: row?.updated_at || row?.updatedAt || null,
  };
}

function buildModelVariantEntries(baseModels = [], {
  defaultEnabled = true,
  contextLimitsByModel = {},
  modelMetadataByModel = {},
} = {}) {
  const models = uniqueStringList(baseModels);
  const entries = [];
  let sortOrder = 0;
  for (const baseModelId of models) {
    const provider = modelProviderForId(baseModelId);
    const label = modelDisplayLabel(baseModelId);
    const contextLimitTokens = Number(contextLimitsByModel?.[baseModelId]);
    const normalizedContextLimitTokens = Number.isFinite(contextLimitTokens) && contextLimitTokens > 0
      ? Math.round(contextLimitTokens)
      : null;
    const metadata = modelMetadataByModel?.[baseModelId] || {};
    if (isReasoningVariantEligibleModel(baseModelId)) {
      for (const effort of SUPPORTED_REASONING_EFFORTS) {
        entries.push({
          variantId: buildModelVariantId(baseModelId, effort),
          baseModelId,
          provider,
          label,
          reasoningEffort: effort,
          releaseStatus: null,
          contextLimitTokens: normalizedContextLimitTokens,
          longContextLimitTokens: toNullableInt(metadata.longContextLimitTokens),
          pricing: metadata.pricing || null,
          enabled: defaultEnabled ? 1 : 0,
          sortOrder: sortOrder++,
        });
      }
      continue;
    }
    entries.push({
      variantId: buildModelVariantId(baseModelId),
      baseModelId,
      provider,
      label,
      reasoningEffort: null,
      releaseStatus: null,
      contextLimitTokens: normalizedContextLimitTokens,
      longContextLimitTokens: toNullableInt(metadata.longContextLimitTokens),
      pricing: metadata.pricing || null,
      enabled: defaultEnabled ? 1 : 0,
      sortOrder: sortOrder++,
    });
  }

  return entries;
}

function normalizeModelMetadataByModel(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawModelId, rawMetadata] of Object.entries(value)) {
    const modelId = canonicalizeModelId(rawModelId);
    if (!isValidModelId(modelId) || !rawMetadata || typeof rawMetadata !== 'object') continue;
    const defaultContextLimitTokens = toNullableInt(rawMetadata.defaultContextLimitTokens);
    const longContextLimitTokens = toNullableInt(rawMetadata.longContextLimitTokens);
    const pricing = rawMetadata.pricing && typeof rawMetadata.pricing === 'object' ? rawMetadata.pricing : null;
    if (defaultContextLimitTokens === null && longContextLimitTokens === null && pricing === null) continue;
    normalized[modelId] = { defaultContextLimitTokens, longContextLimitTokens, pricing };
  }
  return normalized;
}

function normalizeContextLimitsByModel(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawModelId, rawLimit] of Object.entries(value)) {
    const modelId = canonicalizeModelId(rawModelId);
    const limit = Number(rawLimit);
    if (!isValidModelId(modelId) || !Number.isFinite(limit) || limit <= 0) continue;
    normalized[modelId] = Math.round(limit);
  }
  return normalized;
}

function hasValidReasoningByModel(reasoningByModel = {}) {
  if (!reasoningByModel || typeof reasoningByModel !== 'object') return false;
  const modelIds = Object.keys(reasoningByModel).filter((modelId) => modelId !== AUTO_MODEL_SENTINEL);
  if (!modelIds.length) return false;
  return modelIds.every((modelId) => {
    const efforts = reasoningByModel[modelId];
    return Array.isArray(efforts) && efforts.length > 0;
  });
}

function getModelCatalogState() {
  const selectorState = getModelVariantSelectorState();
  const enabledRows = listEnabledModelVariantRows();
  const modelRows = enabledRows.length ? enabledRows : listModelVariantRows().filter((row) => row.enabled);
  const allRows = listModelVariantRows();
  const reasoningByModel = {};
  const contextLimitsByModel = {};
  const modelMetadataByModel = {};
  const models = [];
  const seenModels = new Set();
  for (const row of modelRows) {
    const baseModelId = String(row?.baseModelId || '').trim();
    if (!baseModelId) continue;
    if (!seenModels.has(baseModelId)) {
      seenModels.add(baseModelId);
      models.push(baseModelId);
    }
    const effort = normalizeReasoningEffort(row?.reasoningEffort || 'none') || 'none';
    const current = reasoningByModel[baseModelId] || [];
    if (!current.includes(effort)) current.push(effort);
    reasoningByModel[baseModelId] = current;
    if (row.contextLimitTokens !== null && row.contextLimitTokens > 0) {
      contextLimitsByModel[baseModelId] = row.contextLimitTokens;
    }
    if (!modelMetadataByModel[baseModelId]) {
      modelMetadataByModel[baseModelId] = {
        defaultContextLimitTokens: row.contextLimitTokens,
        longContextLimitTokens: row.longContextLimitTokens,
        pricing: row.pricing,
      };
    }
  }
  const knownModelIds = new Set(Object.keys(reasoningByModel));
  for (const row of allRows) {
    const baseModelId = String(row?.baseModelId || '').trim();
    if (!baseModelId) continue;
    knownModelIds.add(baseModelId);
    const effort = normalizeReasoningEffort(row?.reasoningEffort || 'none') || 'none';
    const current = reasoningByModel[baseModelId] || [];
    if (!current.includes(effort)) current.push(effort);
    reasoningByModel[baseModelId] = current;
    if (row.contextLimitTokens !== null && row.contextLimitTokens > 0) {
      contextLimitsByModel[baseModelId] = row.contextLimitTokens;
    }
    if (!modelMetadataByModel[baseModelId]) {
      modelMetadataByModel[baseModelId] = {
        defaultContextLimitTokens: row.contextLimitTokens,
        longContextLimitTokens: row.longContextLimitTokens,
        pricing: row.pricing,
      };
    }
  }
  for (const modelId of knownModelIds) {
    const efforts = uniqueStringList(
      (reasoningByModel[modelId] || [])
        .map((value) => normalizeReasoningEffort(value))
        .filter(Boolean),
    );
    reasoningByModel[modelId] = efforts;
  }
  const autoEfforts = uniqueStringList(
    Object.entries(reasoningByModel)
      .filter(([modelId]) => modelId !== AUTO_MODEL_SENTINEL)
      .flatMap(([, list]) => Array.isArray(list) ? list : [])
      .map((value) => normalizeReasoningEffort(value))
      .filter(Boolean),
  );
  if (autoEfforts.length) {
    reasoningByModel[AUTO_MODEL_SENTINEL] = autoEfforts;
  } else {
    delete reasoningByModel[AUTO_MODEL_SENTINEL];
  }
  const catalogModels = [AUTO_MODEL_SENTINEL, ...models.filter((value) => value.toLowerCase() !== AUTO_MODEL_SENTINEL)];
  const currentResolved = parseModelVariantSelection(selectorState.currentModel);
  const defaultResolved = parseModelVariantSelection(selectorState.defaultModel);
  const currentModel = String(currentResolved?.baseModelId || selectorState.currentModel || '').trim() || catalogModels[0] || DEFAULT_MODEL;
  const defaultModel = String(defaultResolved?.baseModelId || selectorState.defaultModel || '').trim() || currentModel || catalogModels[0] || DEFAULT_MODEL;
  const reasoningMetadataValid = hasValidReasoningByModel(reasoningByModel);
  const inMemoryRefresh = modelCatalog.refreshedAt || null;
  const refreshedAt = latestModelCatalogRefresh(selectorState.refreshedAt, inMemoryRefresh);
  const metadataError = !reasoningMetadataValid || !!selectorState.error || modelRows.length === 0;
  const stale = metadataError;
  const metadataValid = !metadataError;
  const warning = selectorState.warning || null;
  const reasoningEfforts = uniqueStringList(
    Object.values(reasoningByModel)
      .flatMap((list) => Array.isArray(list) ? list : [])
      .map((value) => normalizeReasoningEffort(value))
      .filter(Boolean),
  );
  return {
    models: catalogModels,
    currentModel,
    defaultModel,
    source: selectorState.source,
    refreshedAt,
    stale,
    metadataValid,
    reasoningMetadataValid,
    warning,
    error: selectorState.error,
    reasoningByModel,
    reasoningEfforts,
    contextLimitsByModel,
    modelMetadataByModel,
  };
}

function touchModelSelectorState({
  source = 'snapshot',
  error = null,
  refreshedAt = new Date().toISOString(),
} = {}) {
  if (!modelSelectorSql?.upsertSelectorState?.run) return;
  const timestamp = latestModelCatalogRefresh(refreshedAt) || new Date().toISOString();
  modelSelectorSql.upsertSelectorState.run(
    String(source || 'snapshot').trim() || 'snapshot',
    timestamp,
    error ? String(error).trim().slice(0, 300) : null,
    timestamp,
  );
}

function updateModelCatalog(snapshot = {}) {
  const incomingModels = validatedModelIdList(Array.isArray(snapshot.models) ? snapshot.models : []);
  const incomingCurrentRaw = String(snapshot.currentModel || '').trim();
  const incomingDefaultRaw = String(snapshot.defaultModel || '').trim();
  const incomingCurrent = isValidModelId(incomingCurrentRaw) ? incomingCurrentRaw : '';
  const incomingDefault = isValidModelId(incomingDefaultRaw) ? incomingDefaultRaw : '';
  const contextLimitsByModel = normalizeContextLimitsByModel(snapshot.contextLimitsByModel);
  const modelMetadataByModel = normalizeModelMetadataByModel(snapshot.modelMetadataByModel);
  const receivedMetadata = incomingModels.length > 0 || Object.keys(contextLimitsByModel).length > 0 || Object.keys(modelMetadataByModel).length > 0;
  const merged = validatedModelIdList([
    ...curatedModelList(),
    ...incomingModels,
    incomingCurrent,
    incomingDefault,
    ...(Array.isArray(modelCatalog.models) ? modelCatalog.models : []),
    modelCatalog.currentModel,
    modelCatalog.defaultModel,
  ]);
  if (!merged.length) merged.push(DEFAULT_MODEL);
  const currentModel = incomingCurrent || modelCatalog.currentModel || incomingDefault || merged[0] || DEFAULT_MODEL;
  const defaultModel = incomingDefault || modelCatalog.defaultModel || currentModel || DEFAULT_MODEL;
  const models = uniqueStringList([currentModel, defaultModel, ...merged]);

  modelCatalog = {
    models,
    currentModel,
    defaultModel,
    source: String(snapshot.source || modelCatalog.source || 'unknown').trim() || 'unknown',
    refreshedAt: receivedMetadata ? new Date().toISOString() : modelCatalog.refreshedAt,
    error: snapshot.error ? String(snapshot.error).trim().slice(0, 300) : null,
  };
  if (modelSelectorSql?.upsertVariant?.run) {
    const existingBaseIds = new Set(listModelVariantRows().map((r) => r.baseModelId));
    const newBaseIds = models.filter((id) => !existingBaseIds.has(id));
    if (newBaseIds.length) {
      const newEntries = buildModelVariantEntries(newBaseIds, { defaultEnabled: false, contextLimitsByModel, modelMetadataByModel });
      upsertModelVariantCatalogEntries(newEntries, {
        source: String(modelCatalog.source || 'snapshot').trim() || 'snapshot',
        error: modelCatalog.error || null,
        preserveEnabled: true,
      });
    }
    const nowIso = new Date().toISOString();
    for (const [modelId, contextLimitTokens] of Object.entries(contextLimitsByModel)) {
      modelSelectorSql.updateContextLimitForBase.run(contextLimitTokens, nowIso, modelId);
    }
    for (const [modelId, metadata] of Object.entries(modelMetadataByModel)) {
      modelSelectorSql.updateModelMetadataForBase.run(
        metadata.defaultContextLimitTokens,
        metadata.longContextLimitTokens,
        metadata.pricing ? JSON.stringify(metadata.pricing) : null,
        nowIso,
        modelId,
      );
    }
  }
  if (receivedMetadata && modelSelectorSql?.upsertSelectorState?.run) {
    touchModelSelectorState({
      source: modelCatalog.source,
      error: modelCatalog.error,
      refreshedAt: modelCatalog.refreshedAt,
    });
  }
  return getModelCatalogState();
}

function getSupportedReasoningEffortsForModel(model = '') {
  const modelId = String(model || '').trim().toLowerCase();
  if (!modelId || modelId === AUTO_MODEL_SENTINEL) return [];
  const state = getModelCatalogState();
  return Array.isArray(state.reasoningByModel?.[modelId])
    ? state.reasoningByModel[modelId].map((value) => normalizeReasoningEffort(value)).filter(Boolean)
    : [];
}

function resolveRequestedReasoningEffort(model, requestedReasoningEffort = '') {
  const modelId = String(model || '').trim().toLowerCase();
  if (modelId === AUTO_MODEL_SENTINEL) {
    return { ok: true, effort: null, supported: getSupportedReasoningEffortsForModel(AUTO_MODEL_SENTINEL) };
  }
  const supported = getSupportedReasoningEffortsForModel(modelId);
  const requested = normalizeReasoningEffort(requestedReasoningEffort);
  if (!supported.length) {
    return { ok: false, error: 'Reasoning metadata unavailable for model', supported };
  }
  if (!requested) {
    return { ok: false, error: 'Reasoning effort is required', supported };
  }
  if (!supported.includes(requested)) {
    return { ok: false, error: 'Unsupported reasoning effort', supported };
  }
  return { ok: true, effort: requested, supported };
}

function resolveRequestedModel(model) {
  const requested = String(model || '').trim();
  const state = getModelCatalogState();
  const availableModels = Array.isArray(state.models) ? state.models : [];
  const fallbackModel = String(state.currentModel || state.defaultModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const fallbackVariant = fallbackModel.toLowerCase() === AUTO_MODEL_SENTINEL
    ? AUTO_MODEL_SENTINEL
    : fallbackModel;

  if (!requested) {
    return {
      ok: true,
      model: fallbackModel,
      modelVariantId: fallbackVariant,
      reasoningEffort: null,
      warning: null,
    };
  }

  if (requested.toLowerCase() === AUTO_MODEL_SENTINEL) {
    return {
      ok: true,
      model: AUTO_MODEL_SENTINEL,
      modelVariantId: AUTO_MODEL_SENTINEL,
      reasoningEffort: null,
      warning: null,
    };
  }

  const requestedModel = requested.toLowerCase();
  if (availableModels.includes(requestedModel)) {
    return {
      ok: true,
      model: requestedModel,
      modelVariantId: requestedModel,
      reasoningEffort: null,
      warning: null,
    };
  }

  const parsedVariant = parseModelVariantSelection(requested);
  if (!parsedVariant) {
    return { ok: false, error: 'Unsupported model', available: availableModels };
  }
  if (!availableModels.includes(parsedVariant.baseModelId)) {
    return { ok: false, error: 'Unsupported model', available: availableModels };
  }
  const parsedEffort = normalizeReasoningEffort(parsedVariant.reasoningEffort || '');
  return {
    ok: true,
    model: parsedVariant.baseModelId,
    modelVariantId: parsedEffort
      ? buildModelVariantId(parsedVariant.baseModelId, parsedEffort)
      : parsedVariant.variantId,
    reasoningEffort: parsedEffort || null,
    warning: null,
  };
}

function listModelVariantRows() {
  if (!modelSelectorSql?.listVariants?.all) return [];
  return modelSelectorSql.listVariants.all().map((row) => normalizeModelVariantRow(row));
}

function listEnabledModelVariantRows() {
  if (!modelSelectorSql?.listEnabledVariants?.all) return [];
  return modelSelectorSql.listEnabledVariants.all().map((row) => normalizeModelVariantRow(row));
}

function getModelContextLimitTokens(modelId = '') {
  const normalizedModelId = canonicalizeModelId(modelId);
  if (!normalizedModelId) return null;
  const row = listModelVariantRows().find((entry) => entry.baseModelId === normalizedModelId
    && entry.contextLimitTokens !== null
    && entry.contextLimitTokens > 0);
  return row?.contextLimitTokens || null;
}

function parseModelVariantSelection(value) {
  const variantId = String(value || '').trim();
  if (!variantId) return null;
  const knownBaseModels = listModelVariantRows().map((row) => row.baseModelId);
  const parsed = parseModelVariantId(variantId, { knownBaseModels });
  if (!parsed) return null;
  const match = listModelVariantRows().find((row) => row.variantId === parsed.variantId);
  if (match) {
    return {
      variantId: match.variantId,
      baseModelId: match.baseModelId,
      reasoningEffort: match.reasoningEffort,
      provider: match.provider,
      label: match.label,
    };
  }
  return parsed;
}

function getModelVariantSelectorState() {
  const fallbackVariant = buildModelVariantId(DEFAULT_MODEL, isReasoningVariantEligibleModel(DEFAULT_MODEL) ? 'none' : null);
  if (!modelSelectorSql?.listEnabledVariants?.all) {
    const fallbackModels = buildModelVariantEntries(curatedModelList(), { defaultEnabled: true }).map((entry) => entry.variantId);
    const models = fallbackModels.length ? fallbackModels : [fallbackVariant];
    return {
      models,
      currentModel: models[0] || fallbackVariant,
      defaultModel: models[0] || fallbackVariant,
      source: 'bootstrap',
      refreshedAt: null,
      warning: null,
      error: null,
    };
  }
  const enabledRows = listEnabledModelVariantRows();
  const selectorState = modelSelectorSql.getSelectorState.get() || null;
  const enabledVariants = enabledRows.map((row) => row.variantId);
  const models = enabledVariants.length ? enabledVariants : [fallbackVariant];
  const warning = enabledVariants.length
    ? null
    : 'No model variants are enabled. Using fallback.';
  return {
    models,
    currentModel: models[0] || fallbackVariant,
    defaultModel: models[0] || fallbackVariant,
    source: String(selectorState?.source || 'db').trim() || 'db',
    refreshedAt: selectorState?.refreshed_at || null,
    warning,
    error: selectorState?.error ? String(selectorState.error) : null,
  };
}

function upsertModelVariantCatalogEntries(entries = [], {
  source = 'manual-refresh',
  error = null,
  preserveEnabled = true,
} = {}) {
  if (!modelSelectorSql?.upsertVariant?.run || !modelSelectorSql?.upsertSelectorState?.run) {
    return getModelVariantSelectorState();
  }
  const normalizedEntries = Array.isArray(entries)
    ? entries.map((entry) => normalizeModelVariantRow(entry)).filter((entry) => entry.variantId && entry.baseModelId)
    : [];
  const existingEnabled = new Map(
    listModelVariantRows().map((row) => [row.variantId, row.enabled ? 1 : 0]),
  );
  const incomingIds = new Set(normalizedEntries.map((entry) => entry.variantId));
  const incomingBaseIds = new Set(normalizedEntries.map((entry) => entry.baseModelId));
  const nowIso = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const entry of normalizedEntries) {
      const enabled = preserveEnabled && existingEnabled.has(entry.variantId)
        ? existingEnabled.get(entry.variantId)
        : (entry.enabled ? 1 : 0);
      modelSelectorSql.upsertVariant.run(
        entry.variantId,
        entry.baseModelId,
        entry.provider || modelProviderForId(entry.baseModelId),
        entry.label || modelDisplayLabel(entry.baseModelId),
        entry.releaseStatus || null,
        entry.reasoningEffort || null,
        entry.contextLimitTokens || null,
        entry.longContextLimitTokens || null,
        entry.pricing ? JSON.stringify(entry.pricing) : null,
        enabled,
        entry.sortOrder,
        nowIso,
      );
    }
    for (const row of listModelVariantRows()) {
      if (incomingIds.has(row.variantId)) continue;
      const shouldMarkUnavailable = row.enabled || incomingBaseIds.has(row.baseModelId);
      if (shouldMarkUnavailable) {
        modelSelectorSql.upsertVariant.run(
          row.variantId,
          row.baseModelId,
          row.provider || modelProviderForId(row.baseModelId),
          row.label || modelDisplayLabel(row.baseModelId),
          'unavailable',
          row.reasoningEffort || null,
          row.contextLimitTokens || null,
          row.longContextLimitTokens || null,
          row.pricing ? JSON.stringify(row.pricing) : null,
          row.enabled ? 1 : 0,
          row.sortOrder,
          nowIso,
        );
        continue;
      }
      // Variants that are both disabled and fully absent from the incoming base set
      // are no longer relevant; prune them so they do not linger as selectable.
      modelSelectorSql.deleteVariant.run(row.variantId);
    }
    modelSelectorSql.upsertSelectorState.run(
      String(source || 'manual-refresh').trim() || 'manual-refresh',
      nowIso,
      error ? String(error).trim().slice(0, 300) : null,
      nowIso,
    );
  });
  tx();
  return getModelVariantSelectorState();
}

function setEnabledModelVariants(variantIds = []) {
  if (!modelSelectorSql?.disableAllVariants?.run || !modelSelectorSql?.enableVariant?.run) {
    return getModelVariantSelectorState();
  }
  const nextEnabled = new Set(
    Array.isArray(variantIds) ? variantIds.map((value) => String(value || '').trim()).filter(Boolean) : [],
  );
  const existingRows = listModelVariantRows();
  const nowIso = new Date().toISOString();
  const tx = db.transaction(() => {
    modelSelectorSql.disableAllVariants.run(nowIso);
    for (const row of existingRows) {
      if (!nextEnabled.has(row.variantId)) continue;
      modelSelectorSql.enableVariant.run(nowIso, row.variantId);
    }
  });
  tx();
  return getModelVariantSelectorState();
}

function parseModelsFromHelpConfigOutput(text) {
  const content = String(text || '');
  if (!content) return [];
  const sectionMatch = content.match(/`model`:[\s\S]*?(?=\n\s*`[a-zA-Z][^`]*`:\s|$)/);
  const section = sectionMatch ? sectionMatch[0] : content;
  const models = [];
  const regex = /"([^"]+)"/g;
  let match;
  while ((match = regex.exec(section))) {
    const candidate = String(match[1] || '').trim();
    if (!candidate || candidate === 'auto') continue;
    if (!isValidModelId(candidate)) continue;
    models.push(candidate);
  }
  return validatedModelIdList(models);
}

function parseReasoningEffortsFromHelpOutput(text) {
  const content = String(text || '');
  if (!content) return SUPPORTED_REASONING_EFFORTS.slice();
  const values = [];
  const regex = /"([a-z]+)"/g;
  let match;
  while ((match = regex.exec(content))) {
    const effort = normalizeReasoningEffort(match[1]);
    if (effort) values.push(effort);
  }
  const unique = uniqueStringList(values);
  return unique.length ? unique : SUPPORTED_REASONING_EFFORTS.slice();
}

function runCopilotCliCommand(args = [], timeoutMs = 30_000) {
  const commandArgs = Array.isArray(args) ? args.map((item) => String(item || '').trim()).filter(Boolean) : [];
  return new Promise((resolve, reject) => {
    const timeout = Math.max(5_000, Number(timeoutMs) || 30_000);
    if (process.platform === 'win32') {
      const escapedArgs = commandArgs.map((part) => `'${String(part).replace(/'/g, "''")}'`).join(' ');
      const script = escapedArgs ? `& 'copilot' ${escapedArgs}` : "& 'copilot'";
      execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message || '').trim();
          reject(new Error(detail || error.message || 'copilot command failed'));
          return;
        }
        resolve(String(stdout || ''));
      });
      return;
    }
    execFile('copilot', commandArgs, { windowsHide: true, timeout }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || '').trim();
        reject(new Error(detail || error.message || 'copilot command failed'));
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

async function refreshModelVariantCatalogFromCli() {
  let source = 'rpc-snapshot';
  let modelIds = [];
  let reasoningEfforts = SUPPORTED_REASONING_EFFORTS.slice();
  const hasAuthoritativeSnapshot = /^(web-relay-extension|standalone-relay):/.test(String(modelCatalog.source || ''));
  const refreshSelectionFromSnapshot = selectModelIdsForVariantRefresh({
    snapshotModels: hasAuthoritativeSnapshot && Array.isArray(modelCatalog.models) ? modelCatalog.models : [],
    currentModel: modelCatalog.currentModel,
    defaultModel: modelCatalog.defaultModel,
    helpModelIds: [],
  });
  source = refreshSelectionFromSnapshot.source;
  modelIds = refreshSelectionFromSnapshot.modelIds;
  const genericHelpText = await runCopilotCliCommand(['help']).catch(() => '');
  reasoningEfforts = parseReasoningEffortsFromHelpOutput(genericHelpText);
  if (!modelIds.length) {
    const configHelpText = await runCopilotCliCommand(['help', 'config']);
    const helpModelIds = parseModelsFromHelpConfigOutput(configHelpText);
    const refreshSelectionFromHelp = selectModelIdsForVariantRefresh({
      snapshotModels: [],
      currentModel: '',
      defaultModel: '',
      helpModelIds,
    });
    source = refreshSelectionFromHelp.source;
    modelIds = refreshSelectionFromHelp.modelIds;
  }
  const entries = [];
  let sortOrder = 0;
  for (const modelId of modelIds) {
    const provider = modelProviderForId(modelId);
    const label = modelDisplayLabel(modelId);
    if (isReasoningVariantEligibleModel(modelId)) {
      for (const effort of reasoningEfforts) {
        entries.push({
          variantId: buildModelVariantId(modelId, effort),
          baseModelId: modelId,
          provider,
          label,
          reasoningEffort: effort,
          enabled: 0,
          sortOrder: sortOrder++,
        });
      }
      continue;
    }
    entries.push({
      variantId: buildModelVariantId(modelId),
      baseModelId: modelId,
      provider,
      label,
      reasoningEffort: null,
      enabled: 0,
      sortOrder: sortOrder++,
    });
  }
  if (!entries.length) {
    throw new Error('No models found in snapshot/help model output');
  }
  return upsertModelVariantCatalogEntries(entries, {
    source,
    error: null,
    preserveEnabled: true,
  });
}

function normalizeRelayMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (!value) return DEFAULT_RELAY_MODE;
  return SUPPORTED_RELAY_MODES.includes(value) ? value : null;
}

function normalizeConversationSessionMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (!value) return DEFAULT_CONVERSATION_SESSION_MODE;
  return SUPPORTED_CONVERSATION_SESSION_MODES.includes(value) ? value : null;
}

const configuredConversationSessionMode =
  normalizeConversationSessionMode(config.conversationSessionMode) || DEFAULT_CONVERSATION_SESSION_MODE;

updateModelCatalog({ models: [DEFAULT_MODEL], currentModel: DEFAULT_MODEL, defaultModel: DEFAULT_MODEL, source: 'bootstrap' });

// ─── SQLite Setup ─────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
if (process.platform !== 'win32') {
  fs.chmodSync(DB_PATH, 0o600);
}
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
if (process.platform !== 'win32') {
  for (const sqlitePath of [`${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (fs.existsSync(sqlitePath)) fs.chmodSync(sqlitePath, 0o600);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'auto',
    sdk_session_id TEXT,
    preferred_relay_mode TEXT,
    preferred_model TEXT,
    preferred_reasoning_effort TEXT,
    configured_workspace_root_path TEXT,
    runtime_workspace_root_path TEXT,
    archived   INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'active',
    compacted_into TEXT,
    compacted_from TEXT,
    summary_seed TEXT,
    seed_pending INTEGER NOT NULL DEFAULT 0,
    draft_text TEXT,
    draft_updated_at TEXT,
    draft_updated_by_client_id TEXT,
    draft_attachments TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    text            TEXT NOT NULL,
    model           TEXT,
    mode            TEXT,
    attachments     TEXT,
    model_requested TEXT,
    model_actual    TEXT,
    model_origin    TEXT,
    hidden_from_shares INTEGER NOT NULL DEFAULT 0,
    share_hidden_at TEXT,
    timestamp       TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, timestamp);

  CREATE TABLE IF NOT EXISTS queue (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL,
    runtime_session_id  TEXT,
    is_new_conversation INTEGER NOT NULL DEFAULT 0,
    model               TEXT,
    model_variant_id    TEXT,
    reasoning_effort    TEXT,
    context_tier        TEXT,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    text                TEXT NOT NULL,
    attachments         TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',
    timestamp           TEXT NOT NULL,
    processing_at       TEXT,
    response_message_id TEXT,
    response            TEXT,
    retry_count         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at     TEXT,
    owner_sdk_session_id TEXT,
    owner_assigned_at   TEXT,
    owner_lease_expires_at TEXT,
    owner_last_claimed_at TEXT,
    parked_at           TEXT,
    parked_target_session_id TEXT,
    parked_transaction_id TEXT,
    parked_reason       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status, timestamp);

  CREATE TABLE IF NOT EXISTS message_usage_snapshots (
    response_message_id TEXT PRIMARY KEY,
    queue_message_id TEXT,
    conversation_id TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'live',
    stale INTEGER NOT NULL DEFAULT 0,
    premium_remaining REAL,
    premium_entitlement REAL,
    premium_used_percent REAL,
    premium_delta_used REAL,
    chat_remaining REAL,
    chat_entitlement REAL,
    chat_used_percent REAL,
    chat_delta_used REAL,
    plan_remaining REAL,
    plan_entitlement REAL,
    plan_used_percent REAL,
    plan_delta_used REAL,
    captured_at TEXT NOT NULL,
    FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_message_usage_conv_time ON message_usage_snapshots(conversation_id, captured_at DESC);
  CREATE INDEX IF NOT EXISTS idx_message_usage_queue_id ON message_usage_snapshots(queue_message_id);

  CREATE TABLE IF NOT EXISTS runtime_sessions (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL UNIQUE,
    sdk_session_id  TEXT,
    strategy        TEXT NOT NULL DEFAULT 'isolated',
    runtime_key     TEXT NOT NULL,
    model           TEXT,
    provider_type   TEXT NOT NULL DEFAULT 'github',
    provider_model  TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL,
    last_used_at    TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_runtime_sessions_last_used ON runtime_sessions(last_used_at DESC);

  CREATE TABLE IF NOT EXISTS deleted_sdk_sessions (
    sdk_session_id TEXT PRIMARY KEY,
    deleted_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sdk_delete_requests (
    sdk_session_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    processing_at TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sdk_delete_requests_status
    ON sdk_delete_requests(status, requested_at, next_attempt_at);

  CREATE TABLE IF NOT EXISTS sdk_session_imports (
    sdk_session_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    completed_at TEXT,
    source_started_at TEXT,
    source_modified_at TEXT,
    updated_at TEXT NOT NULL,
    last_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sdk_session_imports_status
    ON sdk_session_imports(status, updated_at);

  -- Copilot SDK sessions the relay created as execution vehicles for existing
  -- conversations. The startup import sweep must never surface these as new
  -- conversations: their history already lives in the conversation they ran
  -- for (that duplication is how "shadow" conversations like a stray
  -- "procees" appeared in the conversation list).
  CREATE TABLE IF NOT EXISTS relay_session_links (
    sdk_session_id  TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );

  -- path_key is the dedupe key: on Windows it is the whole path lower-cased, so
  -- "C:\Git\Repo" and "c:\git\repo" occupy one row instead of two. See
  -- migrations/0002-recent-workspace-roots-path-key.mjs for existing databases.
  CREATE TABLE IF NOT EXISTS recent_workspace_roots (
    path_key     TEXT PRIMARY KEY,
    path         TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recent_workspace_roots_last_seen
    ON recent_workspace_roots(last_seen_at DESC);

  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL
  );

  -- Web Push subscriptions, one row per subscribed browser installation. See
  -- migrations/0003-push-subscriptions.mjs for existing databases.
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id             TEXT PRIMARY KEY,
    device_id      TEXT NOT NULL,
    device_label   TEXT,
    endpoint       TEXT NOT NULL UNIQUE,
    keys_json      TEXT NOT NULL,
    preferences_json TEXT NOT NULL,
    user_agent     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_success_at TEXT,
    last_error     TEXT,
    failure_count  INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_device
    ON push_subscriptions(device_id);

  CREATE TABLE IF NOT EXISTS model_selector_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    source       TEXT,
    refreshed_at TEXT,
    error        TEXT,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS model_variants (
    variant_id       TEXT PRIMARY KEY,
    base_model_id    TEXT NOT NULL,
    provider         TEXT NOT NULL,
    label            TEXT NOT NULL,
    release_status   TEXT,
    reasoning_effort TEXT,
    context_limit_tokens INTEGER,
    long_context_limit_tokens INTEGER,
    pricing_json     TEXT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_model_variants_enabled
    ON model_variants(enabled, provider, sort_order, variant_id);

  CREATE TABLE IF NOT EXISTS relay_control_requests (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    conversation_id TEXT,
    queue_message_id TEXT,
    sdk_session_id  TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    request         TEXT,
    result          TEXT,
    error           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    completed_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_relay_control_requests_status
    ON relay_control_requests(status, sdk_session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_control_requests_queue
    ON relay_control_requests(queue_message_id, type, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_questions (
    id              TEXT PRIMARY KEY,
    queue_id        TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    relay_mode      TEXT NOT NULL DEFAULT 'agent',
    prompt          TEXT NOT NULL,
    choices         TEXT,
    request         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    answer          TEXT,
    structured_answer TEXT,
    request_schema  TEXT,
    sdk_session_id  TEXT,
    owner_worker_id TEXT,
    continuation_id TEXT,
    continuation_question_id TEXT,
    created_at      TEXT NOT NULL,
    answered_at     TEXT,
    expires_at      TEXT NOT NULL,
    FOREIGN KEY (queue_id) REFERENCES queue(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_relay_questions_status ON relay_questions(status, expires_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_questions_conversation ON relay_questions(conversation_id, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_boards (
    id                TEXT PRIMARY KEY,
    queue_id          TEXT NOT NULL,
    conversation_id   TEXT NOT NULL,
    message_id        TEXT NOT NULL,
    board_type        TEXT NOT NULL,
    relay_mode        TEXT NOT NULL DEFAULT 'agent',
    title             TEXT NOT NULL,
    body              TEXT NOT NULL,
    actions_json      TEXT,
    recommended_action TEXT,
    context_json      TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    selected_action   TEXT,
    acted_at          TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    FOREIGN KEY (queue_id) REFERENCES queue(id) ON DELETE CASCADE,
    UNIQUE(message_id, board_type)
  );

  CREATE INDEX IF NOT EXISTS idx_relay_boards_status ON relay_boards(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_relay_boards_conversation ON relay_boards(conversation_id, status, created_at);

  CREATE TABLE IF NOT EXISTS relay_activity (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_message_id    TEXT NOT NULL,
    response_message_id TEXT,
    conversation_id     TEXT NOT NULL,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    text                TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_relay_activity_queue ON relay_activity(queue_message_id, id);
  CREATE INDEX IF NOT EXISTS idx_relay_activity_response ON relay_activity(response_message_id, id);

  CREATE TABLE IF NOT EXISTS relay_stream_events (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_message_id    TEXT NOT NULL,
    response_message_id TEXT,
    conversation_id     TEXT NOT NULL,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    seq                 INTEGER NOT NULL,
    text                TEXT NOT NULL DEFAULT '',
    done                INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(queue_message_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_queue
    ON relay_stream_events(queue_message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_response
    ON relay_stream_events(response_message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_relay_stream_events_conversation
    ON relay_stream_events(conversation_id, queue_message_id, seq);

  CREATE TABLE IF NOT EXISTS relay_thought (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_message_id    TEXT NOT NULL,
    response_message_id TEXT,
    conversation_id     TEXT NOT NULL,
    relay_mode          TEXT NOT NULL DEFAULT 'agent',
    reasoning_id        TEXT,
    seq                 INTEGER NOT NULL,
    text                TEXT NOT NULL,
    done                INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    UNIQUE(queue_message_id, seq)
  );

  CREATE INDEX IF NOT EXISTS idx_relay_thought_queue
    ON relay_thought(queue_message_id, seq);
  CREATE INDEX IF NOT EXISTS idx_relay_thought_response
    ON relay_thought(response_message_id, seq);

  CREATE TABLE IF NOT EXISTS subagent_runs (
    id                  TEXT PRIMARY KEY,
    queue_message_id    TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    parent_subagent_id  TEXT,
    display_name        TEXT,
    status              TEXT NOT NULL DEFAULT 'running',
    started_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    completed_at        TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_subagent_runs_queue
    ON subagent_runs(queue_message_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_subagent_runs_conversation
    ON subagent_runs(conversation_id, status);

  CREATE TABLE IF NOT EXISTS uploaded_files (
    sha256        TEXT PRIMARY KEY,
    original_name TEXT,
    mime_type     TEXT,
    size_bytes    INTEGER NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS upload_refs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    file_sha256     TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    UNIQUE(file_sha256, message_id),
    FOREIGN KEY (file_sha256) REFERENCES uploaded_files(sha256) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_upload_refs_conv ON upload_refs(conversation_id, file_sha256);
  CREATE INDEX IF NOT EXISTS idx_upload_refs_sha ON upload_refs(file_sha256);

  CREATE TABLE IF NOT EXISTS conversation_shares (
    token            TEXT PRIMARY KEY,
    conversation_id  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_accessed_at TEXT,
    revoked_at       TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_shares_conversation
    ON conversation_shares(conversation_id, revoked_at, created_at DESC);

  CREATE TABLE IF NOT EXISTS status_events (
    id           TEXT PRIMARY KEY,
    timestamp    INTEGER NOT NULL,
    type         TEXT NOT NULL,
    source       TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_status_events_timeline
    ON status_events(timestamp DESC, id DESC);
`);

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS messages_fts_after_insert
  AFTER INSERT ON messages
  BEGIN
    INSERT INTO messages_fts(rowid, text)
    VALUES (new.rowid, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_after_delete
  AFTER DELETE ON messages
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_fts_after_update
  AFTER UPDATE OF text ON messages
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
    VALUES ('delete', old.rowid, old.text);
    INSERT INTO messages_fts(rowid, text)
    VALUES (new.rowid, new.text);
  END;
`);
// The extension-backed history queue is superseded by the local SDK importer.
db.exec(`DROP TABLE IF EXISTS sdk_history_fetch_requests`);
// Only rebuild the FTS index if the virtual table is empty (first migration or new DB).
// A full rebuild is O(N) in message count and blocks the sync event loop, so we skip it
// when existing trigger-maintained rows are already present.
{
  const ftsRowCount = db.prepare(`SELECT COUNT(*) AS cnt FROM messages_fts`).get()?.cnt || 0;
  if (ftsRowCount === 0) {
    db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
  }
}

// Backfill schema for pre-model databases.
const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name);
if (!messageColumns.includes('attachments')) {
  db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
}
if (!messageColumns.includes('mode')) {
  db.exec(`ALTER TABLE messages ADD COLUMN mode TEXT`);
}
if (!messageColumns.includes('model_requested')) {
  db.exec(`ALTER TABLE messages ADD COLUMN model_requested TEXT`);
}
if (!messageColumns.includes('model_actual')) {
  db.exec(`ALTER TABLE messages ADD COLUMN model_actual TEXT`);
}
if (!messageColumns.includes('model_origin')) {
  db.exec(`ALTER TABLE messages ADD COLUMN model_origin TEXT`);
}
if (!messageColumns.includes('hidden_from_shares')) {
  db.exec(`ALTER TABLE messages ADD COLUMN hidden_from_shares INTEGER NOT NULL DEFAULT 0`);
}
if (!messageColumns.includes('share_hidden_at')) {
  db.exec(`ALTER TABLE messages ADD COLUMN share_hidden_at TEXT`);
}
if (!messageColumns.includes('executed_provider')) {
  // Which provider actually ran the turn, derived from the authenticated
  // responder identity — never from the response payload. A value that
  // differs from the conversation's provider marks a cross-provider
  // execution (e.g. the Copilot relay answering a Cursor conversation).
  db.exec(`ALTER TABLE messages ADD COLUMN executed_provider TEXT`);
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_share_visibility
  ON messages(conversation_id, hidden_from_shares, timestamp)
`);

const sdkSessionImportColumns = db.prepare(`PRAGMA table_info(sdk_session_imports)`).all().map((c) => c.name);
if (!sdkSessionImportColumns.includes('source_started_at')) {
  db.exec(`ALTER TABLE sdk_session_imports ADD COLUMN source_started_at TEXT`);
}
if (!sdkSessionImportColumns.includes('source_modified_at')) {
  db.exec(`ALTER TABLE sdk_session_imports ADD COLUMN source_modified_at TEXT`);
}

const queueColumns = db.prepare(`PRAGMA table_info(queue)`).all().map((c) => c.name);
if (!queueColumns.includes('model')) {
  db.exec(`ALTER TABLE queue ADD COLUMN model TEXT`);
}
if (!queueColumns.includes('model_variant_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN model_variant_id TEXT`);
}
if (!queueColumns.includes('reasoning_effort')) {
  db.exec(`ALTER TABLE queue ADD COLUMN reasoning_effort TEXT`);
}
if (!queueColumns.includes('context_tier')) {
  db.exec(`ALTER TABLE queue ADD COLUMN context_tier TEXT`);
}
if (!queueColumns.includes('runtime_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN runtime_session_id TEXT`);
}
if (!queueColumns.includes('relay_mode')) {
  db.exec(`ALTER TABLE queue ADD COLUMN relay_mode TEXT NOT NULL DEFAULT 'agent'`);
}
if (!queueColumns.includes('attachments')) {
  db.exec(`ALTER TABLE queue ADD COLUMN attachments TEXT`);
}
if (!queueColumns.includes('retry_count')) {
  db.exec(`ALTER TABLE queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`);
}
if (!queueColumns.includes('next_attempt_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN next_attempt_at TEXT`);
}
if (!queueColumns.includes('owner_sdk_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_sdk_session_id TEXT`);
}
if (!queueColumns.includes('owner_assigned_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_assigned_at TEXT`);
}
if (!queueColumns.includes('owner_lease_expires_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_lease_expires_at TEXT`);
}
if (!queueColumns.includes('owner_last_claimed_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN owner_last_claimed_at TEXT`);
}
if (!queueColumns.includes('response_message_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN response_message_id TEXT`);
}
if (!queueColumns.includes('parked_at')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_at TEXT`);
}
if (!queueColumns.includes('parked_target_session_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_target_session_id TEXT`);
}

// recent_workspace_roots gained a case-normalized primary key (path_key). The
// CREATE TABLE IF NOT EXISTS above only covers fresh databases, so upgrade an
// existing one in place before any statement referencing path_key is prepared.
const recentWorkspaceRootsRebuild = rebuildRecentWorkspaceRootsTable(db);
if (recentWorkspaceRootsRebuild.applied) {
  console.log(`[workspace-root] rebuilt recent CWD history: ${recentWorkspaceRootsRebuild.rowsBefore} row(s) -> ${recentWorkspaceRootsRebuild.rowsAfter} distinct directory/ies`);
}
// The CREATE TABLE IF NOT EXISTS above covers fresh databases; this upgrades
// an existing one before the push dispatch service prepares its statements.
const pushSubscriptionsMigration = ensurePushSubscriptionsTable(db);
if (pushSubscriptionsMigration.applied) {
  console.log(`[push] created push_subscriptions table`);
}
if (!queueColumns.includes('parked_transaction_id')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_transaction_id TEXT`);
}
if (!queueColumns.includes('parked_reason')) {
  db.exec(`ALTER TABLE queue ADD COLUMN parked_reason TEXT`);
}
db.exec(`UPDATE queue SET relay_mode = 'agent' WHERE relay_mode IS NULL OR relay_mode = ''`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_next_attempt ON queue(status, next_attempt_at, timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_owner_pending ON queue(status, owner_sdk_session_id, next_attempt_at, timestamp)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_parked_release ON queue(status, parked_transaction_id, parked_target_session_id, parked_at, timestamp)`);
migrateImageConversationSchema(db);

const runtimeSessionColumns = db.prepare(`PRAGMA table_info(runtime_sessions)`).all().map((c) => c.name);
if (runtimeSessionColumns.length) {
  if (!runtimeSessionColumns.includes('strategy')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'isolated'`);
  }
  if (!runtimeSessionColumns.includes('sdk_session_id')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN sdk_session_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('runtime_key')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN runtime_key TEXT NOT NULL DEFAULT ''`);
    db.exec(`UPDATE runtime_sessions SET runtime_key = id WHERE runtime_key IS NULL OR runtime_key = ''`);
  }
  if (!runtimeSessionColumns.includes('model')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN model TEXT`);
  }
  if (!runtimeSessionColumns.includes('provider_type')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'github'`);
  }
  if (!runtimeSessionColumns.includes('provider_model')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN provider_model TEXT`);
  }
  if (!runtimeSessionColumns.includes('claude_native_session_id')) {
    // Native Claude Agent SDK session id captured from the worker's first
    // turn; passed back as `resume` so Claude conversations survive worker
    // restarts.
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN claude_native_session_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('cursor_agent_id')) {
    // Cursor Agent SDK durable agent id; replayed on queue messages so Cursor
    // conversations survive worker restarts.
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN cursor_agent_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('grok_native_session_id')) {
    // ACP session id from Grok agent session/new; replayed via session/load so
    // Grok conversations survive worker restarts.
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN grok_native_session_id TEXT`);
  }
  if (!runtimeSessionColumns.includes('context_usage_json')) {
    // Latest context-window breakdown reported by the Claude Agent SDK. Claude
    // sessions have no Copilot events.jsonl to tail, so this is the only source
    // of context data for them.
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN context_usage_json TEXT`);
  }
  if (!runtimeSessionColumns.includes('context_usage_captured_at')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN context_usage_captured_at TEXT`);
  }
  if (!runtimeSessionColumns.includes('status')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }
  if (!runtimeSessionColumns.includes('created_at')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  }
  if (!runtimeSessionColumns.includes('last_used_at')) {
    db.exec(`ALTER TABLE runtime_sessions ADD COLUMN last_used_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))`);
  }
}

const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all().map((c) => c.name);
if (!conversationColumns.includes('archived')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
}
if (!conversationColumns.includes('sdk_session_id')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN sdk_session_id TEXT`);
}
if (!conversationColumns.includes('preferred_relay_mode')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN preferred_relay_mode TEXT`);
}
if (!conversationColumns.includes('preferred_model')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN preferred_model TEXT`);
}
if (!conversationColumns.includes('preferred_reasoning_effort')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN preferred_reasoning_effort TEXT`);
  // One-time carry-over from the retired per-mode preference maps: seed the flat
  // preference from the entry stored for the conversation's preferred mode.
  if (conversationColumns.includes('preferred_models_by_mode')) {
    const legacyRows = db.prepare(`
      SELECT id, preferred_relay_mode, preferred_models_by_mode, preferred_reasoning_by_mode
      FROM conversations
      WHERE preferred_models_by_mode IS NOT NULL OR preferred_reasoning_by_mode IS NOT NULL
    `).all();
    const seedFlatPreference = db.prepare(`UPDATE conversations SET preferred_model = ?, preferred_reasoning_effort = ? WHERE id = ?`);
    for (const legacyRow of legacyRows) {
      let modelsByMode = {};
      let reasoningByMode = {};
      try { modelsByMode = JSON.parse(legacyRow.preferred_models_by_mode || '{}') || {}; } catch { modelsByMode = {}; }
      try { reasoningByMode = JSON.parse(legacyRow.preferred_reasoning_by_mode || '{}') || {}; } catch { reasoningByMode = {}; }
      const mode = String(legacyRow.preferred_relay_mode || '').trim() || DEFAULT_RELAY_MODE;
      const model = String(modelsByMode?.[mode] || '').trim() || null;
      const effort = String(reasoningByMode?.[mode] || '').trim().toLowerCase() || null;
      if (model || effort) seedFlatPreference.run(model, effort, legacyRow.id);
    }
  }
}
if (!conversationColumns.includes('configured_workspace_root_path')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN configured_workspace_root_path TEXT`);
}
if (!conversationColumns.includes('runtime_workspace_root_path')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN runtime_workspace_root_path TEXT`);
}
if (!conversationColumns.includes('compacted_into')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN compacted_into TEXT`);
}
if (!conversationColumns.includes('compacted_from')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN compacted_from TEXT`);
}
if (!conversationColumns.includes('summary_seed')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN summary_seed TEXT`);
}
if (!conversationColumns.includes('seed_pending')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN seed_pending INTEGER NOT NULL DEFAULT 0`);
}
if (!conversationColumns.includes('status')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
}
if (!conversationColumns.includes('title_source')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN title_source TEXT NOT NULL DEFAULT 'auto'`);
}
if (!conversationColumns.includes('draft_text')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN draft_text TEXT`);
}
if (!conversationColumns.includes('draft_updated_at')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN draft_updated_at TEXT`);
}
if (!conversationColumns.includes('draft_updated_by_client_id')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN draft_updated_by_client_id TEXT`);
}
if (!conversationColumns.includes('draft_attachments')) {
  db.exec(`ALTER TABLE conversations ADD COLUMN draft_attachments TEXT`);
}

db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_sessions_sdk_session_id ON runtime_sessions(sdk_session_id) WHERE sdk_session_id IS NOT NULL AND sdk_session_id != ''`);

const relayQuestionColumns = db.prepare(`PRAGMA table_info(relay_questions)`).all().map((c) => c.name);
if (relayQuestionColumns.length && !relayQuestionColumns.includes('sdk_session_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN sdk_session_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('owner_worker_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN owner_worker_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('continuation_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN continuation_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('continuation_question_id')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN continuation_question_id TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('structured_answer')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN structured_answer TEXT`);
}
if (relayQuestionColumns.length && !relayQuestionColumns.includes('request_schema')) {
  db.exec(`ALTER TABLE relay_questions ADD COLUMN request_schema TEXT`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_relay_questions_continuation ON relay_questions(continuation_id, continuation_question_id, status, created_at)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS subagent_runs (
    id                  TEXT PRIMARY KEY,
    queue_message_id    TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    parent_subagent_id  TEXT,
    display_name        TEXT,
    status              TEXT NOT NULL DEFAULT 'running',
    started_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    completed_at        TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_subagent_runs_queue
    ON subagent_runs(queue_message_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_subagent_runs_conversation
    ON subagent_runs(conversation_id, status);
`);

const relayActivityColumns = db.prepare(`PRAGMA table_info(relay_activity)`).all().map((c) => c.name);
if (relayActivityColumns.length && !relayActivityColumns.includes('subagent_run_id')) {
  db.exec(`ALTER TABLE relay_activity ADD COLUMN subagent_run_id TEXT`);
}
const relayThoughtColumns = db.prepare(`PRAGMA table_info(relay_thought)`).all().map((c) => c.name);
if (relayThoughtColumns.length && !relayThoughtColumns.includes('subagent_run_id')) {
  db.exec(`ALTER TABLE relay_thought ADD COLUMN subagent_run_id TEXT`);
}
db.exec(`
  DELETE FROM relay_thought
  WHERE id IN (
    SELECT older.id
    FROM relay_thought AS older
    JOIN relay_thought AS newer
      ON older.queue_message_id = newer.queue_message_id
     AND older.reasoning_id = newer.reasoning_id
     AND older.reasoning_id IS NOT NULL
     AND older.reasoning_id != ''
     AND (
       older.seq < newer.seq
       OR (older.seq = newer.seq AND older.id < newer.id)
     )
  )
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_relay_thought_queue_reasoning
    ON relay_thought(queue_message_id, reasoning_id)
    WHERE reasoning_id IS NOT NULL AND reasoning_id != ''
`);
const relayStreamEventColumns = db.prepare(`PRAGMA table_info(relay_stream_events)`).all().map((c) => c.name);
if (relayStreamEventColumns.length && !relayStreamEventColumns.includes('subagent_run_id')) {
  db.exec(`ALTER TABLE relay_stream_events ADD COLUMN subagent_run_id TEXT`);
}
const modelVariantColumns = db.prepare(`PRAGMA table_info(model_variants)`).all().map((c) => c.name);
if (modelVariantColumns.length && !modelVariantColumns.includes('context_limit_tokens')) {
  db.exec(`ALTER TABLE model_variants ADD COLUMN context_limit_tokens INTEGER`);
}
if (modelVariantColumns.length && !modelVariantColumns.includes('long_context_limit_tokens')) {
  db.exec(`ALTER TABLE model_variants ADD COLUMN long_context_limit_tokens INTEGER`);
}
if (modelVariantColumns.length && !modelVariantColumns.includes('pricing_json')) {
  db.exec(`ALTER TABLE model_variants ADD COLUMN pricing_json TEXT`);
}

// ─── Prepared Statements ──────────────────────────────────────────────────────
// Owns its own schema (plan-usage tables) and the derived Cursor spend
// bookkeeping; created before `stmts` because it prepares statements against
// tables it creates itself.
const planUsageService = createPlanUsageService({ db, dbg: (...args) => console.log('[plan-usage]', ...args) });

const stmts = {
  ...createSessionRepository(db),
  ...createMessageRepository(db),
  ...createQuestionRepository(db),
  ...createImageConversationRepository(db),
};
const statusEventService = createStatusEventService(db);

// ─── Web Push ─────────────────────────────────────────────────────────────────
// VAPID keys are generated once and persisted in app_settings; regenerating
// them would invalidate every stored subscription.
const pushVapidKeys = ensurePushVapidKeys(stmts, {
  generateVapidKeys: () => webpush.generateVAPIDKeys(),
});
if (pushVapidKeys.generated) {
  console.log('[push] generated VAPID key pair');
}
webpush.setVapidDetails(
  String(config.pushVapidSubject || '').trim() || 'mailto:copilot-remote@example.com',
  pushVapidKeys.publicKey,
  pushVapidKeys.privateKey,
);
// `io` is created later in this file; the closures only run after startup.
const activeDeviceTracker = createActiveDeviceTracker({
  getSockets: () => io.of('/').sockets.values(),
});
const pushDispatchService = createPushDispatchService({
  db,
  webpush,
  hasActiveDevice: () => activeDeviceTracker.hasActiveDevice(),
  recordStatusEvent: (type, details) => statusEventService.recordEvent(type, details),
  uuid: uuidv4,
});

const imageOperationService = createImageOperationService({
  db,
  repository: stmts,
  uuidv4,
});

modelSelectorSql = {
  listVariants: db.prepare(`
    SELECT variant_id, base_model_id, provider, label, release_status, reasoning_effort, context_limit_tokens, long_context_limit_tokens, pricing_json, enabled, sort_order, updated_at
    FROM model_variants
    ORDER BY provider ASC, sort_order ASC, variant_id ASC
  `),
  listEnabledVariants: db.prepare(`
    SELECT variant_id, base_model_id, provider, label, release_status, reasoning_effort, context_limit_tokens, long_context_limit_tokens, pricing_json, enabled, sort_order, updated_at
    FROM model_variants
    WHERE enabled = 1
    ORDER BY provider ASC, sort_order ASC, variant_id ASC
  `),
  upsertVariant: db.prepare(`
    INSERT INTO model_variants (
      variant_id, base_model_id, provider, label, release_status, reasoning_effort, context_limit_tokens, long_context_limit_tokens, pricing_json, enabled, sort_order, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(variant_id) DO UPDATE SET
      base_model_id = excluded.base_model_id,
      provider = excluded.provider,
      label = excluded.label,
      release_status = excluded.release_status,
      reasoning_effort = excluded.reasoning_effort,
      context_limit_tokens = COALESCE(excluded.context_limit_tokens, model_variants.context_limit_tokens),
      long_context_limit_tokens = COALESCE(excluded.long_context_limit_tokens, model_variants.long_context_limit_tokens),
      pricing_json = COALESCE(excluded.pricing_json, model_variants.pricing_json),
      enabled = excluded.enabled,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `),
  updateContextLimitForBase: db.prepare(`
    UPDATE model_variants
    SET context_limit_tokens = ?, updated_at = ?
    WHERE base_model_id = ?
  `),
  updateModelMetadataForBase: db.prepare(`
    UPDATE model_variants
    SET context_limit_tokens = COALESCE(?, context_limit_tokens),
        long_context_limit_tokens = COALESCE(?, long_context_limit_tokens),
        pricing_json = COALESCE(?, pricing_json),
        updated_at = ?
    WHERE base_model_id = ?
  `),
  disableAllVariants: db.prepare(`UPDATE model_variants SET enabled = 0, updated_at = ?`),
  enableVariant: db.prepare(`UPDATE model_variants SET enabled = 1, updated_at = ? WHERE variant_id = ?`),
  deleteVariant: db.prepare(`DELETE FROM model_variants WHERE variant_id = ?`),
  getSelectorState: db.prepare(`SELECT source, refreshed_at, error, updated_at FROM model_selector_state WHERE id = 1 LIMIT 1`),
  upsertSelectorState: db.prepare(`
    INSERT INTO model_selector_state (id, source, refreshed_at, error, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source = excluded.source,
      refreshed_at = excluded.refreshed_at,
      error = excluded.error,
      updated_at = excluded.updated_at
  `),
};

{
  const existingCount = Number(db.prepare(`SELECT COUNT(*) AS cnt FROM model_variants`).get()?.cnt || 0);
  const normalizeLegacyVariantIdsTx = db.transaction(() => {
    const rows = modelSelectorSql.listVariants.all();
    const canonicalRows = new Map();
    for (const rawRow of rows) {
      const row = normalizeModelVariantRow(rawRow);
      const canonicalBaseModelId = canonicalizeModelId(row.baseModelId);
      if (!canonicalBaseModelId) continue;
      const canonicalVariantId = buildModelVariantId(canonicalBaseModelId, row.reasoningEffort);
      const existing = canonicalRows.get(canonicalVariantId);
      if (!existing) {
        canonicalRows.set(canonicalVariantId, {
          variantId: canonicalVariantId,
          baseModelId: canonicalBaseModelId,
          provider: row.provider || modelProviderForId(canonicalBaseModelId),
          label: row.label || modelDisplayLabel(canonicalBaseModelId),
          releaseStatus: row.releaseStatus || null,
          reasoningEffort: row.reasoningEffort || null,
          enabled: row.enabled ? 1 : 0,
          sortOrder: row.sortOrder,
          updatedAt: row.updatedAt,
        });
        continue;
      }
      existing.enabled = existing.enabled || (row.enabled ? 1 : 0) ? 1 : 0;
      if (existing.releaseStatus !== null && row.releaseStatus === null) {
        existing.releaseStatus = null;
      }
      existing.sortOrder = Math.min(existing.sortOrder, row.sortOrder);
      if (!existing.label && row.label) existing.label = row.label;
    }

    const nowIso = new Date().toISOString();
    for (const entry of canonicalRows.values()) {
      modelSelectorSql.upsertVariant.run(
        entry.variantId,
        entry.baseModelId,
        entry.provider || modelProviderForId(entry.baseModelId),
        entry.label || modelDisplayLabel(entry.baseModelId),
        entry.releaseStatus || null,
        entry.reasoningEffort || null,
        entry.contextLimitTokens || null,
        entry.longContextLimitTokens || null,
        entry.pricing ? JSON.stringify(entry.pricing) : null,
        entry.enabled ? 1 : 0,
        entry.sortOrder,
        nowIso,
      );
    }
    for (const rawRow of rows) {
      const rawVariantId = String(rawRow?.variant_id || '').trim();
      const rawBaseModelId = String(rawRow?.base_model_id || '').trim();
      const canonicalBaseModelId = canonicalizeModelId(rawBaseModelId);
      if (!canonicalBaseModelId) continue;
      const canonicalReasoningEffort = normalizeReasoningEffort(rawRow?.reasoning_effort);
      const canonicalVariantId = buildModelVariantId(canonicalBaseModelId, canonicalReasoningEffort);
      if (rawVariantId !== canonicalVariantId) {
        modelSelectorSql.deleteVariant.run(rawVariantId);
      }
    }
  });
  if (existingCount === 0) {
    const nowIso = new Date().toISOString();
    const seedEntries = buildModelVariantEntries(curatedModelList(), { defaultEnabled: true });
    const tx = db.transaction(() => {
      for (const entry of seedEntries) {
        modelSelectorSql.upsertVariant.run(
          entry.variantId,
          entry.baseModelId,
          entry.provider,
          entry.label,
          entry.releaseStatus || null,
          entry.reasoningEffort || null,
          entry.contextLimitTokens || null,
          entry.longContextLimitTokens || null,
          entry.pricing ? JSON.stringify(entry.pricing) : null,
          entry.enabled ? 1 : 0,
          entry.sortOrder,
          nowIso,
        );
      }
      modelSelectorSql.upsertSelectorState.run('bootstrap-seed', nowIso, null, nowIso);
    });
    tx();
  } else if (!modelSelectorSql.getSelectorState.get()) {
    const nowIso = new Date().toISOString();
    modelSelectorSql.upsertSelectorState.run('legacy', nowIso, null, nowIso);
  }
  normalizeLegacyVariantIdsTx();
}

const deleteArchiveService = createDeleteArchiveService(db, null, { resolveSessionStateRoot });
void deleteArchiveService.retryPendingDeletesOnStartup()
  .then((result) => {
    if (result?.pendingCount > 0) {
      console.log(`Startup delete retry processed ${result.pendingCount} tombstoned conversation(s).`);
    }
  })
  .catch((error) => {
    console.warn(`Startup delete retry failed: ${error?.message || error}`);
  });
const relayRestartOrchestrator = createRelayRestartOrchestrator({
  db,
  gracefulTimeoutMs: restartGracefulTimeoutMs,
  readyCooldownMs: restartReadyCooldownMs,
  shutdownTimeoutMs: restartShutdownTimeoutMs,
  spawnTimeoutMs: restartSpawnTimeoutMs,
  rebindTimeoutMs: restartRebindTimeoutMs,
  maxAttempts: restartMaxAttempts,
  retryBackoffMs: restartRetryBackoffMs,
});
const sessionWorkerRegistry = createSessionWorkerRegistry();
const sessionWorkerProcessInspector = createSessionWorkerProcessInspector({
  platform: process.platform,
  execFileSyncImpl: execFileSync,
});
function buildSessionWorkerLaunchEnv() {
  const normalizePathValue = (value) => {
    const text = String(value || '').trim();
    return text || null;
  };
  const resolveBootstrapPath = () => {
    const explicit = normalizePathValue(process.env.COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH)
      || normalizePathValue(process.env.COPILOT_EXTENSION_BOOTSTRAP_PATH);
    if (explicit && fs.existsSync(explicit)) return explicit;

    const distDir = normalizePathValue(process.env.COPILOT_CLI_DIST_DIR);
    if (distDir) {
      const candidate = path.join(distDir, 'preloads', 'extension_bootstrap.mjs');
      if (fs.existsSync(candidate)) return candidate;
    }

    const configuredSdkPath = normalizePathValue(config.sdkPath);
    if (configuredSdkPath) {
      const versionDir = path.resolve(path.dirname(configuredSdkPath), '..');
      const candidate = path.join(versionDir, 'preloads', 'extension_bootstrap.mjs');
      if (fs.existsSync(candidate)) return candidate;
    }
    const platformName = process.platform === 'linux'
      ? (process.arch === 'x64' ? 'linux-x64' : `linux-${process.arch}`)
      : `${process.platform}-${process.arch}`;
    const cacheRoot = path.join(os.homedir(), '.cache', 'copilot', 'pkg', platformName);
    try {
      const versions = fs.readdirSync(cacheRoot)
        .filter((entry) => fs.existsSync(path.join(cacheRoot, entry, 'preloads', 'extension_bootstrap.mjs')))
        .sort()
        .reverse();
      if (versions.length) {
        return path.join(cacheRoot, versions[0], 'preloads', 'extension_bootstrap.mjs');
      }
    } catch {
      // The CLI cache is optional; retain the normal fallback when unavailable.
    }
    return null;
  };

  const next = { ...process.env };
  if (!String(next.COPILOT_WEB_RELAY_ROOT || '').trim()) {
    next.COPILOT_WEB_RELAY_ROOT = REPO_ROOT;
  }
  if (!String(next.COPILOT_WEB_RELAY_SERVER_DIR || '').trim()) {
    next.COPILOT_WEB_RELAY_SERVER_DIR = __dirname;
  }
  if (!String(next.COPILOT_WEB_RELAY_CONFIG || '').trim()) {
    next.COPILOT_WEB_RELAY_CONFIG = CONFIG_PATH;
  }
  if (!String(next.COPILOT_WEB_RELAY_TOOLS || '').trim()) {
    next.COPILOT_WEB_RELAY_TOOLS = path.join(__dirname, 'relay-tools.md');
  }
  if (!String(next.COPILOT_WEB_RELAY_LOG_DIR || '').trim()) {
    next.COPILOT_WEB_RELAY_LOG_DIR = path.join(__dirname, 'logs');
  }
  if (!String(next.EXTENSION_PATH || '').trim()) {
    const projectExtensionPath = path.join(REPO_ROOT, '.github', 'extensions', 'web-relay', 'extension.mjs');
    if (fs.existsSync(projectExtensionPath)) {
      next.EXTENSION_PATH = projectExtensionPath;
    }
  }
  const cliExecutable = normalizePathValue(config.cliPath);
  if (cliExecutable && !String(next.COPILOT_WEB_RELAY_CLI_EXECUTABLE || '').trim()) {
    next.COPILOT_WEB_RELAY_CLI_EXECUTABLE = cliExecutable;
  }
  if (!String(next.COPILOT_WEB_RELAY_CLI_EXECUTABLE || '').trim()) {
    try {
      const loaderPath = fs.realpathSync('/usr/bin/copilot');
      const packageRoot = path.dirname(loaderPath);
      const nativePath = path.join(
        packageRoot,
        'node_modules',
        `@github/copilot-${process.platform}-${process.arch}`,
        'copilot',
      );
      if (fs.existsSync(nativePath)) {
        next.COPILOT_WEB_RELAY_CLI_EXECUTABLE = nativePath;
      }
    } catch {
      // Fall back to the copilot executable resolved by PATH.
    }
  }
  const bootstrapPath = resolveBootstrapPath();
  if (bootstrapPath && !String(next.COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH || '').trim()) {
    next.COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH = bootstrapPath;
  }
  if (bootstrapPath && !String(next.COPILOT_SDK_PATH || '').trim()) {
    const bundledSdkPath = path.join(path.dirname(path.dirname(bootstrapPath)), 'copilot-sdk');
    if (fs.existsSync(path.join(bundledSdkPath, 'extension.js'))) {
      next.COPILOT_SDK_PATH = bundledSdkPath;
    }
  }
  return next;
}
const sessionWorkerLaunchEnv = buildSessionWorkerLaunchEnv();
function buildSessionWorkerLaunchEnvForSession(targetSessionId) {
  const normalizedTargetSessionId = String(targetSessionId || '').trim();
  const runtimeSession = stmts.getRuntimeSessionBySdkSessionId.get(normalizedTargetSessionId)
    || stmts.getRuntimeSessionByConversation.get(normalizedTargetSessionId)
    || null;
  const providerType = String(runtimeSession?.provider_type || 'github').trim().toLowerCase();
  // Clear every provider's variables first (the appliers' kind-guarded deletes
  // keep the chained clears order-independent), then apply only the bound one.
  const cleared = applyGrokProviderEnvironment(applyCursorProviderEnvironment(applyClaudeProviderEnvironment(applyOpenAIProviderEnvironment(sessionWorkerLaunchEnv))));
  if (providerType === 'claude') {
    const claudeSettings = getClaudeProviderSettings();
    const claudeModel = String(runtimeSession?.provider_model || runtimeSession?.model || claudeSettings.model).trim();
    return applyClaudeProviderEnvironment(cleared, {
      enabled: true,
      model: claudeModel,
    });
  }
  if (providerType === 'cursor') {
    const cursorSettings = getCursorProviderSettings();
    const cursorModel = String(runtimeSession?.provider_model || runtimeSession?.model || cursorSettings.model).trim();
    return applyCursorProviderEnvironment(cleared, {
      enabled: true,
      model: cursorModel,
      apiKey: cursorSettings.apiKey,
    });
  }
  if (providerType === 'grok') {
    const grokSettings = getGrokProviderSettings();
    const grokModel = String(runtimeSession?.provider_model || runtimeSession?.model || grokSettings.model).trim();
    return applyGrokProviderEnvironment(cleared, {
      enabled: true,
      model: grokModel,
      // Re-thread the host-level CLI override: the clear chain above deletes
      // GROK_CLI_COMMAND from the launch env, so without this the worker
      // could never see it.
      command: String(process.env.GROK_CLI_COMMAND || process.env.GROK_COMMAND || '').trim(),
    });
  }
  if (providerType !== 'openai') {
    return cleared;
  }
  const settings = getOpenAIProviderSettings();
  const model = String(runtimeSession?.provider_model || runtimeSession?.model || settings.model).trim();
  return applyOpenAIProviderEnvironment(cleared, {
    enabled: true,
    apiKey: settings.apiKey,
    model,
    baseUrl: settings.baseUrl,
  });
}
const relayCliLauncherService = createRelayCliLauncherService({
  cwd: (targetSessionId) => resolveLaunchWorkspaceRootForSession(targetSessionId),
  env: sessionWorkerLaunchEnv,
  log: (message) => console.log(`${runtimeLogPrefix()}${message}`),
});
async function spawnSessionWorkerCli(targetSessionId, { allowProcessReuse = true } = {}) {
  const normalizedTargetSessionId = String(targetSessionId || '').trim();
  if (!normalizedTargetSessionId) {
    throw new Error('missing-target-session-id');
  }
  if (allowProcessReuse) {
    const liveWorker = sessionWorkerProcessInspector.findProcessForSession(normalizedTargetSessionId);
    if (liveWorker?.processId) {
      const workerId = `worker-${normalizedTargetSessionId.slice(0, 8)}`;
      console.log(`${runtimeLogPrefix()}worker launcher: reused ${workerId} session=${normalizedTargetSessionId.slice(0, 8)} pid=${liveWorker.processId}`);
      return { workerId, pid: liveWorker.processId };
    }
  }
  const resolvedWorkspaceRoot = resolveLaunchWorkspaceRootForSession(normalizedTargetSessionId);
  const workerLaunchEnv = buildSessionWorkerLaunchEnvForSession(normalizedTargetSessionId);
  const launched = await launchSessionCli({
    targetSessionId: normalizedTargetSessionId,
    cwd: resolvedWorkspaceRoot,
    env: workerLaunchEnv,
    platform: process.platform,
    spawnImpl: spawn,
    execFileSyncImpl: execFileSync,
    processInspector: sessionWorkerProcessInspector,
    allowProcessReuse,
  });
  const workerPid = Number.isInteger(Number(launched?.pid)) ? Number(launched.pid) : null;
  const workerId = `worker-${normalizedTargetSessionId.slice(0, 8)}`;
  const launchMode = String(launched?.launchMode || 'detached').trim();
  const tmuxSessionName = String(launched?.tmuxSessionName || '').trim();
  // "spawned" used to be logged even when the launcher reused a live tmux pane,
  // which made spawn counts meaningless: a crash-looping session and a healthy
  // one produced the same line. Report what actually happened.
  const launchVerb = launched?.reused === true ? 'reused' : 'spawned';
  console.log(`${runtimeLogPrefix()}worker launcher: ${launchVerb} ${workerId} session=${normalizedTargetSessionId.slice(0, 8)} pid=${workerPid || 'none'} mode=${launchMode}${tmuxSessionName ? ` tmux=${tmuxSessionName}` : ''}`);
  return { workerId, pid: workerPid, reused: launched?.reused === true };
}
const sessionWorkerSupervisor = createSessionWorkerSupervisor({
  registry: sessionWorkerRegistry,
  spawnWorker: async (sdkSessionId, options = {}) => spawnSessionWorkerCli(sdkSessionId, options),
  diagnosticPlanReference: () => path.join(currentWorkspaceRootPath(), '.cursor', 'plans', 'worker-startup-monitoring-plan.md'),
  log: (message) => console.warn(`${runtimeLogPrefix()}${message}`),
});
const featureFlags = normalizeFeatureFlags(FEATURES);

async function stopSessionWorkerForProviderRebind(sdkSessionId) {
  const sessionId = String(sdkSessionId || '').trim();
  if (!sessionId) return false;
  const currentWorker = sessionWorkerRegistry?.getWorker?.(sessionId) || null;
  sessionWorkerSupervisor?.markKilled?.(sessionId);
  const cancelledStart = await sessionWorkerSupervisor?.cancelPendingStart?.(sessionId, { wait: true });
  const discoveredProcesses = process.platform === 'win32'
    ? (
        sessionWorkerProcessInspector?.findWindowsProcessTreeForSession?.(sessionId)
        || sessionWorkerProcessInspector?.findWindowsProcessesForSession?.(sessionId)
        || sessionWorkerProcessInspector?.findProcessesForSession?.(sessionId)
        || []
      )
    : (sessionWorkerProcessInspector?.findProcessesForSession?.(sessionId) || []);
  const currentWorkerPid = Number(currentWorker?.pid);
  const hadActiveWorker = discoveredProcesses.some((entry) => isProcessAlive(Number(entry?.processId)))
    || (Number.isInteger(currentWorkerPid) && currentWorkerPid > 0 && isProcessAlive(currentWorkerPid))
    || cancelledStart?.hadPending === true;
  if (!hadActiveWorker) {
    sessionWorkerRegistry?.removeWorker?.(sessionId);
    sessionWorkerSupervisor?.clearRestartSchedule?.(sessionId, { resetKilledMarker: true });
    sessionWorkerSupervisor?.resetHealth?.(sessionId, { clearFailureCount: false });
    return false;
  }

  const stopped = await stopSessionWorkerProcesses({
    sdkSessionId: sessionId,
    worker: currentWorker,
    processInspector: sessionWorkerProcessInspector,
    isPidAliveImpl: isProcessAlive,
    killTmuxSessionImpl: killTmuxSession,
  });
  // This caller treats a surviving process as fatal; the CWD relaunch route
  // instead reports it, so the shared service never throws on its own.
  if (!stopped.ok) {
    throw new Error(stopped.error || `worker-stop-timeout:${(stopped.remainingPids || []).join(',')}`);
  }

  sessionWorkerRegistry?.removeWorker?.(sessionId);
  sessionWorkerSupervisor?.clearRestartSchedule?.(sessionId);
  sessionWorkerSupervisor?.resetHealth?.(sessionId, { clearFailureCount: false });
  return true;
}

async function reconcileUnstartedConversationProviders({ enabled, model, provider = 'openai' } = {}) {
  const normalizedProvider = String(provider || 'openai').trim().toLowerCase();
  const managedProvider = ['claude', 'cursor', 'grok'].includes(normalizedProvider) ? normalizedProvider : 'openai';
  const managedDefaultModel = {
    openai: DEFAULT_OPENAI_MODEL,
    claude: DEFAULT_CLAUDE_MODEL,
    cursor: DEFAULT_CURSOR_MODEL,
    grok: DEFAULT_GROK_MODEL,
  }[managedProvider];
  const providerType = enabled === true ? managedProvider : 'github';
  const providerModel = enabled === true
    ? (String(model || '').trim() || managedDefaultModel)
    : null;
  const runtimeModel = providerModel || DEFAULT_MODEL;
  const candidates = stmts.listRuntimeSessionProviderCandidates.all();
  const result = {
    updatedUnstartedConversations: 0,
    skippedStartedConversations: 0,
    skippedActiveQueueConversations: 0,
    failedConversations: [],
  };
  if (!stmts.runtimeSessionsSupportProviders || !stmts.updateRuntimeSessionProvider) {
    return result;
  }

  for (const row of candidates) {
    const currentProvider = String(row?.provider_type || 'github').trim().toLowerCase() || 'github';
    const currentProviderModel = String(row?.provider_model || '').trim();
    // Only manage conversations belonging to the reconciled provider (or the
    // github default it swaps with); other providers' bindings stay untouched.
    if (currentProvider !== managedProvider && currentProvider !== 'github') {
      continue;
    }
    if (currentProvider === providerType && (providerType !== managedProvider || currentProviderModel === providerModel)) {
      continue;
    }
    if (Number(row?.message_count || 0) > 0) {
      result.skippedStartedConversations += 1;
      continue;
    }
    if (Number(row?.active_queue_count || 0) > 0) {
      result.skippedActiveQueueConversations += 1;
      continue;
    }

    const conversationId = String(row?.conversation_id || '').trim();
    const ownerSessionId = String(
      row?.sdk_session_id
      || row?.conversation_sdk_session_id
      || conversationId,
    ).trim();
    let workerWasStopped = false;
    let providerWasUpdated = false;
    try {
      if (featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true && ownerSessionId) {
        workerWasStopped = await stopSessionWorkerForProviderRebind(ownerSessionId);
      }
      stmts.updateRuntimeSessionProvider.run(
        providerType,
        providerModel,
        runtimeModel,
        new Date().toISOString(),
        row.id,
      );
      providerWasUpdated = true;
      if (workerWasStopped && ownerSessionId) {
        sessionWorkerSupervisor?.clearRestartSchedule?.(ownerSessionId, { resetKilledMarker: true });
        const ensured = await sessionWorkerSupervisor?.ensureWorker?.(ownerSessionId, {
          allowProcessReuse: false,
        });
        if (!ensured?.ok) throw new Error(ensured?.error || 'worker-relaunch-failed');
      }
      result.updatedUnstartedConversations += 1;
    } catch (error) {
      let rollbackError = null;
      const canRestorePreviousProvider = currentProvider === 'claude'
        ? getClaudeProviderSettings().enabled === true
        : (currentProvider === 'cursor'
          ? getCursorProviderSettings().configured === true
          : (currentProvider === 'grok'
            ? getGrokProviderSettings().enabled === true
            : (currentProvider !== 'openai' || getOpenAIProviderSettings().configured === true)));
      if (providerWasUpdated && canRestorePreviousProvider) {
        stmts.updateRuntimeSessionProvider.run(
          currentProvider,
          currentProviderModel || null,
          String(row?.model || '').trim() || DEFAULT_MODEL,
          new Date().toISOString(),
          row.id,
        );
      }
      if (workerWasStopped && ownerSessionId) {
        sessionWorkerSupervisor?.clearRestartSchedule?.(ownerSessionId, { resetKilledMarker: true });
        const restored = await sessionWorkerSupervisor?.ensureWorker?.(ownerSessionId, {
          allowProcessReuse: false,
        });
        if (!restored?.ok) rollbackError = String(restored?.error || 'worker-rollback-relaunch-failed');
      }
      result.failedConversations.push({
        conversationId,
        error: [
          String(error?.message || error || 'provider-rebind-failed'),
          rollbackError ? `rollback: ${rollbackError}` : '',
        ].filter(Boolean).join('; '),
      });
    }
  }
  return result;
}

async function rebindUnstartedOpenAIConversationModel({ conversationId, model } = {}) {
  const normalizedConversationId = String(conversationId || '').trim();
  const nextModel = String(model || '').trim();
  const runtimeSession = normalizedConversationId
    ? stmts.getRuntimeSessionByConversation.get(normalizedConversationId)
    : null;
  if (!runtimeSession || String(runtimeSession.provider_type || '').trim().toLowerCase() !== 'openai') {
    throw new Error('openai-runtime-session-not-found');
  }
  const previousModel = String(runtimeSession.provider_model || runtimeSession.model || '').trim();
  if (!nextModel || nextModel === previousModel) return runtimeSession;
  const messageCount = Number(stmts.getConversationMessageCount.get(normalizedConversationId)?.count || 0);
  const activeQueueCount = Number(stmts.getConversationActiveQueueCount.get(normalizedConversationId)?.count || 0);
  if (messageCount > 0 || activeQueueCount > 0) {
    throw new Error('openai-session-model-locked');
  }
  const ownerSessionId = String(
    runtimeSession.sdk_session_id
    || stmts.getConv.get(normalizedConversationId)?.sdk_session_id
    || normalizedConversationId,
  ).trim();
  let workerWasStopped = false;
  let providerWasUpdated = false;
  try {
    if (featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true && ownerSessionId) {
      workerWasStopped = await stopSessionWorkerForProviderRebind(ownerSessionId);
    }
    stmts.updateRuntimeSessionProvider.run(
      'openai',
      nextModel,
      nextModel,
      new Date().toISOString(),
      runtimeSession.id,
    );
    providerWasUpdated = true;
    if (workerWasStopped && ownerSessionId) {
      sessionWorkerSupervisor?.clearRestartSchedule?.(ownerSessionId, { resetKilledMarker: true });
      const ensured = await sessionWorkerSupervisor?.ensureWorker?.(ownerSessionId, {
        allowProcessReuse: false,
      });
      if (!ensured?.ok) throw new Error(ensured?.error || 'worker-relaunch-failed');
    }
    return stmts.getRuntimeSessionByConversation.get(normalizedConversationId);
  } catch (error) {
    if (providerWasUpdated) {
      stmts.updateRuntimeSessionProvider.run(
        'openai',
        previousModel,
        previousModel,
        new Date().toISOString(),
        runtimeSession.id,
      );
    }
    if (workerWasStopped && ownerSessionId) {
      sessionWorkerSupervisor?.clearRestartSchedule?.(ownerSessionId, { resetKilledMarker: true });
      await sessionWorkerSupervisor?.ensureWorker?.(ownerSessionId, {
        allowProcessReuse: false,
      });
    }
    throw error;
  }
}

function queueCounts() {
  const rows = stmts.countStatus.all();
  const map = Object.fromEntries(rows.map(r => [r.status, r.cnt]));
  return { pendingCount: map.pending || 0, processingCount: map.processing || 0, parkedCount: map.parked || 0 };
}

function countActiveCliWorkers() {
  const workers = sessionWorkerRegistry?.listWorkers?.() || [];
  return workers.reduce((acc, worker) => {
    const status = String(worker?.status || '').trim().toLowerCase();
    return ACTIVE_TTY_CLI_WORKER_STATUSES.has(status) ? acc + 1 : acc;
  }, 0);
}

function attachTtyConsoleRuntimeTitle(runtime) {
  const addConsoleTitle = runtime?.tty?.addConsoleTitle;
  if (typeof addConsoleTitle !== 'function') return;
  addConsoleTitle(() => {
    const counts = queueCounts();
    const connectedClients = Number(io?.sockets?.sockets?.size || 0);
    const activeCliWorkers = countActiveCliWorkers();
    const cliState = cliOnline ? 'online' : 'offline';
    return `Clients: ${connectedClients} :: Pen: ${counts.pendingCount} :: Proc: ${counts.processingCount} :: parked: ${counts.parkedCount} :: CLIs: ${activeCliWorkers} :: CLI: ${cliState}`;
  });
}
attachTtyConsoleRuntimeTitle(ttyConsoleRuntime);

let pendingRelayShutdownRequest = null;
function normalizeRestartRequestFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function getRelayShutdownState() {
  const pending = pendingRelayShutdownRequest;
  if (!pending) {
    return {
      status: runtimeShutdownStarted ? 'shutting_down' : 'idle',
      action: runtimeShutdownStarted ? 'shutdown' : null,
      restart: false,
      reason: null,
      requestedBy: null,
      requestedAt: null,
    };
  }
  return {
    status: runtimeShutdownStarted ? 'shutting_down' : 'queued',
    action: pending.action || 'shutdown',
    restart: pending.action === 'restart',
    reason: pending.reason || null,
    requestedBy: pending.requestedBy || null,
    requestedAt: pending.requestedAt || null,
  };
}

function requestRelayShutdown({ reason = 'manual-request', requestedBy = 'localhost-api', restart = false } = {}) {
  const safeReason = String(reason || 'manual-request').trim().slice(0, 140) || 'manual-request';
  const safeRequestedBy = String(requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
  const restartRequested = normalizeRestartRequestFlag(restart);
  const requestedAction = restartRequested ? 'restart' : 'shutdown';
  if (runtimeShutdownStarted) {
    return {
      accepted: false,
      status: 'shutting_down',
      action: requestedAction,
      restart: restartRequested,
      reason: safeReason,
    };
  }

  // Shutdown is intentionally deferred until the queue is idle; it will not interrupt an active turn.
  if (!pendingRelayShutdownRequest) {
    pendingRelayShutdownRequest = {
      action: requestedAction,
      reason: safeReason,
      requestedBy: safeRequestedBy,
      requestedAt: new Date().toISOString(),
    };
  } else if (restartRequested && pendingRelayShutdownRequest.action !== 'restart') {
    pendingRelayShutdownRequest = {
      ...pendingRelayShutdownRequest,
      action: 'restart',
      reason: safeReason,
      requestedBy: safeRequestedBy,
      requestedAt: new Date().toISOString(),
    };
  }

  const tryShutdownWhenIdle = () => {
    if (runtimeShutdownStarted) return;
    const counts = queueCounts();
    const queueFree = (counts.pendingCount + counts.processingCount + counts.parkedCount) === 0;
    if (!queueFree) return;
    const requestInfo = pendingRelayShutdownRequest;
    pendingRelayShutdownRequest = null;
    if (runtimeTimers.shutdownDrain) {
      try { clearInterval(runtimeTimers.shutdownDrain); } catch {}
      runtimeTimers.shutdownDrain = null;
    }
    const action = requestInfo?.action === 'restart' ? 'restart' : 'shutdown';
    const exitCode = action === 'restart' ? RELAY_RESTART_EXIT_CODE : 0;
    console.log(
      `${runtimeLogPrefix()}Relay ${action} request accepted by ${requestInfo?.requestedBy || 'unknown'}`
      + `; queue is idle, exiting now (reason=${requestInfo?.reason || 'manual-request'})`,
    );
    sessionWorkerWebSocketService.emitDraining(`api-${action}:${requestInfo?.reason || 'manual-request'}`);
    void shutdownRuntime(`api-${action}:${requestInfo?.reason || 'manual-request'}`, { exitCode });
  };

  if (!runtimeTimers.shutdownDrain) {
    runtimeTimers.shutdownDrain = setInterval(tryShutdownWhenIdle, 1000);
  }
  tryShutdownWhenIdle();
  const counts = queueCounts();
  return {
    accepted: true,
    status: 'queued',
    action: pendingRelayShutdownRequest?.action || requestedAction,
    restart: (pendingRelayShutdownRequest?.action || requestedAction) === 'restart',
    requestedAt: pendingRelayShutdownRequest?.requestedAt || new Date().toISOString(),
    reason: pendingRelayShutdownRequest?.reason || safeReason,
    requestedBy: pendingRelayShutdownRequest?.requestedBy || safeRequestedBy,
    queue: counts,
  };
}

function toNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n);
}

function toNullablePercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function formatCount(value) {
  const n = toNullableInt(value);
  return n === null ? 'unavailable' : String(n);
}

function formatPercent(value) {
  const n = toNullablePercent(value);
  return n === null ? 'unavailable' : `${n}%`;
}

function formatCompactTokens(value) {
  const n = toNullableInt(value);
  if (n === null) return 'unavailable';
  if (Math.abs(n) < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

function buildUsageGrid({ systemPct, messagesPct, freePct, bufferPct }) {
  const pctToCount = (pct) => {
    const n = Number(pct);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  let systemCount = pctToCount(systemPct);
  let messagesCount = pctToCount(messagesPct);
  let freeCount = pctToCount(freePct);
  let bufferCount = pctToCount(bufferPct);

  let total = systemCount + messagesCount + freeCount + bufferCount;
  if (total > 100) {
    const scale = 100 / total;
    systemCount = Math.round(systemCount * scale);
    messagesCount = Math.round(messagesCount * scale);
    freeCount = Math.round(freeCount * scale);
    bufferCount = Math.round(bufferCount * scale);
    total = systemCount + messagesCount + freeCount + bufferCount;
  }
  while (total < 100) {
    if (bufferCount >= freeCount) freeCount += 1;
    else bufferCount += 1;
    total += 1;
  }

  const cells = [
    ...Array(systemCount).fill('o'),
    ...Array(messagesCount).fill('O'),
    ...Array(freeCount).fill('.'),
    ...Array(bufferCount).fill('@'),
  ];
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push(cells.slice(i * 10, (i + 1) * 10).join(' '));
  }
  return rows;
}

function buildContextUsageBlock(snapshot, runtimeSession, extraEntries = []) {
  const model = contextField(snapshot?.model || runtimeSession?.model);
  const usedTotal = toNullableInt(snapshot?.used_total_tokens);
  const contextLimit = toNullableInt(snapshot?.max_context_tokens);
  const usedPct = toNullablePercent(snapshot?.used_percent);
  const systemTools = toNullableInt(snapshot?.system_tools_tokens);
  const messages = toNullableInt(snapshot?.messages_tokens);
  const freeTokens = toNullableInt(snapshot?.free_tokens);
  const bufferTokens = toNullableInt(snapshot?.buffer_tokens);
  const cacheRead = toNullableInt(snapshot?.cache_read_tokens);
  const cacheWrite = toNullableInt(snapshot?.cache_write_tokens);

  const safePct = (part, total) => {
    const a = Number(part);
    const b = Number(total);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
    return Math.round((a / b) * 10000) / 100;
  };

  const gridRows = buildUsageGrid({
    systemPct: safePct(systemTools, contextLimit),
    messagesPct: safePct(messages, contextLimit),
    freePct: safePct(freeTokens, contextLimit),
    bufferPct: safePct(bufferTokens, contextLimit),
  });

  const labelWidth = 13;
  const fmtLabel = (label) => `${String(label || '').trim()}:`.padEnd(labelWidth, ' ');
  const fmtMetric = (icon, label, value, pct = null) => {
    const base = `${icon} ${fmtLabel(label)} ${value}`;
    if (pct === null || pct === undefined || pct === '') return base;
    return `${base} (${pct})`;
  };

  const rightLines = [
    `${model}`,
    `${formatCompactTokens(usedTotal)}/${formatCompactTokens(contextLimit)} tokens (${formatPercent(usedPct)}),`,
    '',
    fmtMetric('o', 'System/Tools', formatCompactTokens(systemTools), formatPercent(safePct(systemTools, contextLimit))),
    fmtMetric('O', 'Messages', formatCompactTokens(messages), formatPercent(safePct(messages, contextLimit))),
    fmtMetric('.', 'Free Space', formatCompactTokens(freeTokens), formatPercent(safePct(freeTokens, contextLimit))),
    fmtMetric('@', 'Buffer', formatCompactTokens(bufferTokens), formatPercent(safePct(bufferTokens, contextLimit))),
    fmtMetric('R', 'Cache Read', formatCompactTokens(cacheRead)),
    fmtMetric('W', 'Cache Write', formatCompactTokens(cacheWrite)),
  ];

  const extras = Array.isArray(extraEntries) ? extraEntries : [];
  if (extras.length) {
    while (rightLines.length < gridRows.length) {
      rightLines.push('');
    }
    rightLines.push('');
    for (const entry of extras) {
      const label = String(entry?.label || '').trim();
      const value = String(entry?.value || '').trim();
      if (!label || !value) continue;
      if (entry?.multiline) {
        rightLines.push(`${fmtLabel(label)}`);
        rightLines.push(`  ${value}`);
      } else {
        rightLines.push(`${fmtLabel(label)} ${value}`);
      }
    }
  }

  const leftWidth = Math.max(0, ...gridRows.map((row) => String(row || '').length));
  const rowCount = Math.max(gridRows.length, rightLines.length);
  const merged = [];
  for (let i = 0; i < rowCount; i += 1) {
    const left = String(gridRows[i] || '').padEnd(leftWidth, ' ');
    const hasLeft = String(gridRows[i] || '').trim().length > 0;
    const right = String(rightLines[i] || '');
    if (right) merged.push(hasLeft ? `${left}   ${right}`.trimEnd() : right);
    else merged.push(left.trimEnd());
  }

  return merged.join('\n');
}

function contextField(value) {
  const text = String(value || '').trim();
  return text || 'unavailable';
}

function resolveSessionStateRoot() {
  const envOverride = String(process.env.COPILOT_SESSION_STATE_DIR || '').trim();
  const userProfile = String(process.env.USERPROFILE || '').trim();
  const home = String(process.env.HOME || '').trim();
  const homeDir = String(os.homedir() || '').trim();
  const candidates = [];
  if (envOverride) candidates.push(envOverride);
  if (userProfile) candidates.push(path.join(userProfile, '.copilot', 'session-state'));
  if (home) candidates.push(path.join(home, '.copilot', 'session-state'));
  if (homeDir) candidates.push(path.join(homeDir, '.copilot', 'session-state'));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return candidates.find(Boolean) || path.join('.copilot', 'session-state');
}

function buildContextResponseText({ snapshot, runtimeSession, conversationId, eventsPath, error }) {
  const hasText = (value) => {
    const text = String(value || '').trim();
    return !!text && text.toLowerCase() !== 'unavailable';
  };
  const detailEntries = [];
  const pushDetail = (label, value) => {
    if (!hasText(value)) return;
    detailEntries.push({ label, value: String(value).trim(), multiline: false });
  };
  const pushDetailCount = (label, value) => {
    const n = toNullableInt(value);
    if (n === null) return;
    detailEntries.push({ label, value: formatCompactTokens(n), multiline: false });
  };

  const canonicalCopilotSessionId = contextField(
    snapshot?.copilot_session_id
    || runtimeSession?.sdk_session_id,
  );

  if (!snapshot) {
    const fallbackSnapshot = {
      ...snapshot,
      model: String(runtimeSession?.model || '').trim() || null,
    };
    pushDetail('Copilot session ID', canonicalCopilotSessionId);
    if (hasText(eventsPath)) detailEntries.push({ label: 'Events source', value: contextField(eventsPath), multiline: true });
    if (hasText(error)) detailEntries.push({ label: 'Note', value: contextField(error), multiline: true });
    return buildContextUsageBlock(fallbackSnapshot, runtimeSession, detailEntries);
  }

  pushDetail('Copilot session ID', canonicalCopilotSessionId);
  if (snapshot?.estimate_kind === 'assistant-output-lower-bound') {
    pushDetail('Estimate', 'Lower bound from assistant completion tokens');
  }
  pushDetailCount('Prompt/Input', snapshot.used_prompt_tokens);
  pushDetailCount('Completion/Output', snapshot.used_completion_tokens);
  pushDetailCount('Reasoning', snapshot.reasoning_tokens);
  pushDetailCount('System', snapshot.system_tokens);
  pushDetailCount('Tools', snapshot.tools_tokens);
  pushDetail('Captured', contextField(snapshot.captured_at));
  if (hasText(eventsPath)) detailEntries.push({ label: 'Events source', value: contextField(eventsPath), multiline: true });
  if (hasText(error)) detailEntries.push({ label: 'Note', value: contextField(error), multiline: true });

  return buildContextUsageBlock(snapshot, runtimeSession, detailEntries);
}

// `transient` is for a turn that never started — the worker was still booting,
// the session was unavailable, the model was refused at session-create. The
// long ladder is punishing there: it freezes the row for 60s, and since the row
// is already 'pending' no queue-count change fires, so only the periodic
// ready-check sweep can rescue it. Measured, that is where nearly all of the
// "message sat pending for a minute" time went. Genuine provider/model failures
// keep the long ladder so a broken provider is not hammered.
function computeRetryDelayMs(retryCount, { transient = false } = {}) {
  const base = transient ? 5_000 : 30_000;
  const max = transient ? 2 * 60_000 : 10 * 60_000;
  const n = Math.max(0, Number(retryCount) || 0);
  return Math.min(max, base * Math.pow(2, Math.min(n, 4)));
}

function addMsIso(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function formatQuestionRow(row) {
  if (!row) return null;
  const parsedRequest = parseQuestionRequest(row.request);
  const envelope = normalizeQuestionEnvelope(parsedRequest);
  const choices = parseQuestionChoices(row.choices);
  const requestSchema = parseQuestionRequest(row.request_schema);
  const structuredAnswer = parseQuestionRequest(row.structured_answer);
  return {
    id: row.id,
    queueId: row.queue_id,
    conversationId: row.conversation_id,
    sdkSessionId: row.sdk_session_id || null,
    ownerWorkerId: row.owner_worker_id || null,
    continuationId: row.continuation_id || null,
    continuationQuestionId: row.continuation_question_id || null,
    messageId: row.message_id,
    mode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
    prompt: row.prompt,
    choices,
    request: envelope.request,
    requestSchema: requestSchema && typeof requestSchema === 'object' ? requestSchema : null,
    context: envelope.context,
    allowFreeform: envelope.allowFreeform ?? !choices.length,
    status: row.status,
    answer: row.answer || null,
    structuredAnswer: structuredAnswer && typeof structuredAnswer === 'object' ? structuredAnswer : null,
    createdAt: row.created_at,
    answeredAt: row.answered_at || null,
    expiresAt: row.expires_at,
  };
}

function parseBoardActions(rawActions) {
  if (!rawActions) return [];
  let input = rawActions;
  if (typeof rawActions === 'string') {
    try {
      input = JSON.parse(rawActions);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(input)) return [];
  return input
    .map((action) => {
      if (typeof action === 'string') {
        const id = action.trim().toLowerCase();
        return id ? { id, label: id } : null;
      }
      if (!action || typeof action !== 'object') return null;
      const id = String(action.id || action.actionId || action.value || '').trim().toLowerCase();
      if (!id) return null;
      const label = String(action.label || action.title || id).trim().slice(0, 120) || id;
      const mode = normalizeRelayMode(action.mode);
      const prompt = String(action.prompt || '').trim();
      return {
        id,
        label,
        mode: mode || null,
        prompt: prompt || null,
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function parseBoardContext(rawContext) {
  if (!rawContext) return null;
  if (typeof rawContext !== 'string') return rawContext;
  try {
    return JSON.parse(rawContext);
  } catch {
    return null;
  }
}

function formatRelayBoardRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    queueId: row.queue_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    boardType: String(row.board_type || '').trim().toLowerCase() || 'generic',
    mode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
    title: String(row.title || '').trim(),
    body: String(row.body || '').trim(),
    actions: parseBoardActions(row.actions_json),
    recommendedAction: String(row.recommended_action || '').trim() || null,
    context: parseBoardContext(row.context_json),
    status: String(row.status || 'pending').trim().toLowerCase() || 'pending',
    selectedAction: String(row.selected_action || '').trim() || null,
    actedAt: row.acted_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  };
}

function parseQuestionChoices(rawChoices) {
  if (!rawChoices) return [];
  if (Array.isArray(rawChoices)) return rawChoices;
  if (typeof rawChoices !== 'string') return [];
  try {
    const parsed = JSON.parse(rawChoices);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseQuestionRequest(rawRequest) {
  if (!rawRequest) return null;
  if (typeof rawRequest !== 'string') return rawRequest;
  try {
    return JSON.parse(rawRequest);
  } catch {
    return rawRequest;
  }
}

function normalizeQuestionEnvelope(parsedRequest) {
  if (!parsedRequest || typeof parsedRequest !== 'object' || Array.isArray(parsedRequest)) {
    return { request: parsedRequest, context: null, allowFreeform: null };
  }
  const hasEnvelopeFields =
    Object.prototype.hasOwnProperty.call(parsedRequest, 'request') ||
    Object.prototype.hasOwnProperty.call(parsedRequest, 'context') ||
    Object.prototype.hasOwnProperty.call(parsedRequest, 'allowFreeform');
  if (!hasEnvelopeFields) {
    return { request: parsedRequest, context: null, allowFreeform: null };
  }
  return {
    request: Object.prototype.hasOwnProperty.call(parsedRequest, 'request') ? parsedRequest.request : null,
    context: sanitizeRelayQuestionContext(parsedRequest.context),
    allowFreeform: typeof parsedRequest.allowFreeform === 'boolean' ? parsedRequest.allowFreeform : null,
  };
}

function normalizeQuestionChoices(rawChoices) {
  const input = Array.isArray(rawChoices) ? rawChoices : [];
  return input
    .map((choice) => {
      if (typeof choice === 'string') return choice.trim();
      if (choice && typeof choice === 'object') {
        return String(choice.label || choice.text || choice.value || choice.title || '').trim();
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 8);
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(/;\s*/)) {
    if (!part) continue;
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key || Object.prototype.hasOwnProperty.call(cookies, key)) continue;
    const value = part.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function appendSetCookie(res, cookieValue) {
  if (!res) return;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }
  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

function ensureSessionId(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) {
    sessionId = uuidv4();
    if (res) {
      appendSetCookie(res, `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=${COOKIE_PATH}; SameSite=Lax`);
    }
  }
  return sessionId;
}

function parseAttachments(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeReferenceTokenPath(rawPath, { trimTrailingPunctuation = false } = {}) {
  if (rawPath === null || rawPath === undefined) return '';
  let value = String(rawPath || '').replace(/\0/g, '').trim();
  if (!value) return '';
  if (trimTrailingPunctuation) {
    value = value.replace(/[),.;!?]+$/g, '').trim();
  }
  if (!value) return '';
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function extractReferenceTokensFromText(text) {
  const source = String(text || '');
  if (!source) return [];
  const tokens = [];
  const seen = new Set();

  let match = null;
  REFERENCE_TOKEN_PATTERN_BACKTICK.lastIndex = 0;
  while ((match = REFERENCE_TOKEN_PATTERN_BACKTICK.exec(source)) !== null) {
    const kind = String(match[1] || '').trim().toLowerCase();
    const tokenPath = normalizeReferenceTokenPath(match[2], { trimTrailingPunctuation: false });
    if (!tokenPath) continue;
    const key = `${kind}:${tokenPath.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ kind, path: tokenPath, wrapped: true });
  }

  REFERENCE_TOKEN_PATTERN_PLAIN.lastIndex = 0;
  while ((match = REFERENCE_TOKEN_PATTERN_PLAIN.exec(source)) !== null) {
    const kind = String(match[2] || '').trim().toLowerCase();
    const tokenPath = normalizeReferenceTokenPath(match[3], { trimTrailingPunctuation: true });
    if (!tokenPath) continue;
    const key = `${kind}:${tokenPath.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ kind, path: tokenPath, wrapped: false });
  }

  return tokens.filter((token) => token.kind === 'file' || token.kind === 'folder');
}

function resolveReferenceFolderToken(tokenPath) {
  const normalized = normalizeReferenceTokenPath(tokenPath);
  if (!normalized) return null;
  const looksDrivePath = /^[A-Za-z]:(?:\/|$)/.test(normalized);
  if (looksDrivePath) {
    const absolutePath = normalizeDriveAbsolutePath(normalized);
    if (!absolutePath) return null;
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
    return {
      source: 'drives',
      absolutePath,
      webPath: toDriveWebPath(absolutePath),
    };
  }

  const absolutePath = resolveWorkspaceFilePath(normalized);
  if (!absolutePath) return null;
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return {
    source: 'workspace',
    absolutePath,
    webPath: toRepoWebPath(path.relative(currentWorkspaceRootPath(), absolutePath)),
  };
}

function resolveReferenceFileToken(tokenPath) {
  const normalized = normalizeReferenceTokenPath(tokenPath);
  if (!normalized) return null;
  const looksDrivePath = /^[A-Za-z]:(?:\/|$)/.test(normalized);
  if (looksDrivePath) {
    const absolutePath = normalizeDriveAbsolutePath(normalized);
    if (!absolutePath) return null;
    const rootAbsolute = driveRootFromAbsolutePath(absolutePath);
    if (!rootAbsolute) return null;
    let meta = null;
    try {
      meta = readWorkspaceFileMeta(absolutePath);
    } catch {
      return null;
    }
    if (!meta || meta.kind !== 'file') return null;
    return {
      source: 'drives',
      absolutePath,
      webPath: toDriveWebPath(absolutePath),
      meta,
    };
  }

  const absolutePath = resolveWorkspaceFilePath(normalized);
  if (!absolutePath) return null;
  let meta = null;
  try {
    meta = readWorkspaceFileMeta(absolutePath);
  } catch {
    return null;
  }
  if (!meta || meta.kind !== 'file') return null;
  return {
    source: 'workspace',
    absolutePath,
    webPath: toRepoWebPath(path.relative(currentWorkspaceRootPath(), absolutePath)),
    meta,
  };
}

function buildReferenceAttachmentFromResolvedFile(resolvedFile) {
  if (!resolvedFile || typeof resolvedFile !== 'object') return null;
  const filePath = String(resolvedFile.absolutePath || '').trim();
  if (!filePath) return null;
  const contentType = String(resolvedFile?.meta?.contentType || workspaceContentType(filePath) || '').toLowerCase();
  if (!contentType.startsWith('image/')) return null;

  const size = Number(resolvedFile?.meta?.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES) {
    return null;
  }

  const webPath = String(resolvedFile.webPath || '').trim();
  if (!webPath) return null;
  const source = resolvedFile.source === 'drives' ? 'drives' : 'workspace';
  const rawUrl = source === 'drives'
    ? `${remotePath}/api/drives/file?path=${encodeURIComponent(webPath)}`
    : `${remotePath}/api/files/${webPath.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
  return {
    name: path.basename(filePath),
    type: contentType,
    size,
    path: filePath,
    source: 'reference',
    referenceToken: `@file:${webPath}`,
    contentUrl: rawUrl,
  };
}

function collectReferenceAttachmentsFromText(text) {
  const tokens = extractReferenceTokensFromText(text);
  const attachments = [];
  const skipped = [];
  const seenPaths = new Set();

  for (const token of tokens) {
    if (token.kind === 'folder') continue;
    const resolved = resolveReferenceFileToken(token.path);
    if (!resolved) continue;
    const imageAttachment = buildReferenceAttachmentFromResolvedFile(resolved);
    if (!imageAttachment) {
      const maybeSize = Number(resolved?.meta?.size || 0);
      const maybeType = String(resolved?.meta?.contentType || '').toLowerCase();
      if (maybeType.startsWith('image/') && maybeSize > MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES) {
        skipped.push({
          token: `@file:${resolved.webPath}`,
          reason: `image exceeds ${MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES} bytes`,
        });
      }
      continue;
    }
    const key = String(imageAttachment.path || '').toLowerCase();
    if (!key || seenPaths.has(key)) continue;
    seenPaths.add(key);
    attachments.push(imageAttachment);
  }

  return { attachments, skipped };
}

function mergeMessageAttachments(primary, secondary) {
  const merged = [];
  const seen = new Set();
  for (const candidate of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const key = String(candidate.sha256 || candidate.path || candidate.dataUrl || '').trim().toLowerCase();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    merged.push(candidate);
    if (merged.length >= MAX_UPLOAD_ATTACHMENTS) break;
  }
  return merged;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || '').trim().toLowerCase());
}

function uploadPathForSha(sha256) {
  return path.join(UPLOAD_DIR, sha256);
}

function uploadContentUrlForSha(sha256) {
  return `/api/upload/${sha256}/content`;
}

function workspaceContentType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const filename = path.basename(String(filePath || '')).toLowerCase();
  return WORKSPACE_CONTENT_TYPES[ext]
    || WORKSPACE_CONTENT_TYPES_BY_FILENAME[filename]
    || 'application/octet-stream';
}

function normalizeWorkspaceRelativePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return '';
  }
  const withoutNulls = decoded.replace(/\0/g, '');
  const normalized = withoutNulls
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .trim();
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return '';
  if (parts.some((part) => part === '.' || part === '..')) return '';
  return parts.join(path.sep);
}

function resolveWorkspaceFilePath(rawPath, rootPath = null) {
  const normalized = normalizeWorkspaceRelativePath(rawPath);
  if (!normalized) return null;
  const activeWorkspaceRoot = normalizeConversationWorkspaceRootPath(rootPath) || currentWorkspaceRootPath();
  const absolutePath = path.resolve(activeWorkspaceRoot, normalized);
  const relativeToRoot = path.relative(activeWorkspaceRoot, absolutePath);
  if (!relativeToRoot || relativeToRoot === '.') return null;
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return null;
  return absolutePath;
}

function cacheWorkspaceFileMeta(filePath, value) {
  workspaceFileMetaCache.set(filePath, { cachedAt: Date.now(), value });
  return value;
}

function readWorkspaceFileMeta(filePath) {
  const cached = workspaceFileMetaCache.get(filePath);
  if (cached && (Date.now() - cached.cachedAt) <= WORKSPACE_META_CACHE_TTL_MS) {
    return cached.value;
  }

  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return cacheWorkspaceFileMeta(filePath, { kind: 'missing' });
    }
    throw error;
  }

  if (!stat.isFile()) {
    return cacheWorkspaceFileMeta(filePath, { kind: 'not_file' });
  }

  return cacheWorkspaceFileMeta(filePath, {
    kind: 'file',
    size: Number(stat.size || 0),
    contentType: workspaceContentType(filePath),
  });
}

function previewLanguageForWorkspaceFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  const filename = path.basename(String(filePath || '')).toLowerCase();
  return WORKSPACE_PREVIEW_LANGUAGE_BY_EXTENSION[ext]
    || WORKSPACE_PREVIEW_LANGUAGE_BY_FILENAME[filename]
    || null;
}

function readWorkspaceFilePreviewBuffer(filePath, size) {
  const safeSize = Number.isFinite(Number(size)) ? Math.max(0, Number(size)) : 0;
  const targetBytes = Math.min(MAX_WORKSPACE_PREVIEW_BYTES + 1, Math.max(1, safeSize));
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(targetBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, targetBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function isLikelyBinaryPreviewBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  const sampleLength = Math.min(buffer.length, WORKSPACE_PREVIEW_BINARY_SAMPLE_BYTES);
  if (!sampleLength) return false;
  let suspicious = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    const byte = buffer[i];
    if (byte === 0) return true;
    if (byte < 9) suspicious += 1;
    else if (byte > 13 && byte < 32) suspicious += 1;
  }
  return (suspicious / sampleLength) > 0.3;
}

function isLikelyTextContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  if (!value) return false;
  if (value.startsWith('text/')) return true;
  return value.includes('json')
    || value.includes('javascript')
    || value.includes('xml')
    || value.includes('yaml')
    || value.includes('toml');
}

function parseBooleanQueryFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function workspacePreviewKindForMeta(filePath, contentType) {
  const normalizedPath = String(filePath || '');
  const normalizedExt = path.extname(normalizedPath).toLowerCase();
  const filename = path.basename(normalizedPath).toLowerCase();
  const normalizedType = String(contentType || '').toLowerCase();
  if (WORKSPACE_MARKDOWN_EXTENSIONS.has(normalizedExt)) return 'markdown';
  if (WORKSPACE_IMAGE_EXTENSIONS.has(normalizedExt) || normalizedType.startsWith('image/')) return 'image';
  if (WORKSPACE_VIDEO_EXTENSIONS.has(normalizedExt) || normalizedType.startsWith('video/')) return 'video';
  if (WORKSPACE_CODE_EXTENSIONS.has(normalizedExt) || WORKSPACE_PREVIEW_LANGUAGE_BY_FILENAME[filename]) return 'code';
  if (isLikelyTextContentType(normalizedType)) return 'text';
  return 'binary';
}

function shouldSkipRepoEntryName(entryName, { includeHidden = false, includeHeavy = false } = {}) {
  const name = String(entryName || '').trim();
  if (!name || name === '.' || name === '..') return true;
  const lower = name.toLowerCase();
  if (!includeHeavy && REPO_HEAVY_DIR_NAMES.has(lower)) return true;
  if (!includeHidden && name.startsWith('.')) return true;
  return false;
}

function compareRepoDirEntries(a, b) {
  const typeA = a.isDirectory() ? 0 : 1;
  const typeB = b.isDirectory() ? 0 : 1;
  if (typeA !== typeB) return typeA - typeB;
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
}

function toRepoWebPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

const normalizeDriveAbsolutePath = _normalizeDriveAbsolutePath;
const driveRootFromAbsolutePath = _driveRootFromAbsolutePath;
const toDriveWebPath = _toDriveWebPath;

function driveDisplayName(drive) {
  const id = String(drive?.drive || '').trim();
  const label = String(drive?.label || '').trim();
  if (!id) return 'Drive';
  return label ? `${id} (${label})` : id;
}

function mapDriveDirectoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const absolutePath = normalizeDriveAbsolutePath(entry.fullPath);
  if (!absolutePath) return null;
  const webPath = toDriveWebPath(absolutePath);
  if (!webPath) return null;
  const type = String(entry.type || '').toLowerCase() === 'dir' ? 'dir' : 'file';
  const node = {
    path: webPath,
    name: String(entry.name || path.win32.basename(absolutePath) || webPath),
    type,
    mtime: entry.mtime ? String(entry.mtime) : null,
  };
  if (type === 'dir') {
    node.children = [];
    node.lazy = true;
    node.childrenLoaded = false;
    return node;
  }
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = workspaceContentType(absolutePath);
  node.ext = ext || null;
  node.size = Number(entry.size || 0);
  node.contentType = contentType;
  node.previewKind = workspacePreviewKindForMeta(absolutePath, contentType);
  return node;
}

function fetchBrowsableDrives(cb) {
  execFile('fsutil.exe', ['fsinfo', 'drives'], { windowsHide: true }, (err, stdout, stderr) => {
    if (err) return cb(new Error(`drive enumeration failed: ${stderr || err.message}`));

    const text = String(stdout || '').trim().toUpperCase();
    if (!text) return cb(null, []);

    const drives = [];
    const seen = new Set();
    DRIVE_ROOT_PATTERN.lastIndex = 0;
    let match = null;
    while ((match = DRIVE_ROOT_PATTERN.exec(text)) !== null) {
      const driveId = String(match[1] || '').trim().toUpperCase();
      if (!/^[A-Z]$/.test(driveId) || seen.has(driveId)) continue;
      seen.add(driveId);
      const rootAbsolute = `${driveId}:\\`;
      drives.push({
        drive: `${driveId}:`,
        rootAbsolute,
        webPath: toDriveWebPath(rootAbsolute),
        label: '',
        driveType: null,
        sizeBytes: 0,
        freeBytes: 0,
      });
    }
    cb(null, drives);
  });
}

function fetchDriveDirectoryEntries(absoluteDirPath, { includeHidden = false } = {}, cb) {
  const normalizedDirPath = normalizeDriveAbsolutePath(absoluteDirPath);
  if (!normalizedDirPath) return cb(new Error('Invalid drive path'));
  const escapedPath = normalizedDirPath.replace(/'/g, "''");
  const forceFlag = includeHidden ? '-Force' : '';
  const psScript = [
    `$target = '${escapedPath}';`,
    `$rows = @(Get-ChildItem -LiteralPath $target ${forceFlag} -ErrorAction Stop`,
    '| Sort-Object @{Expression = { if ($_.PSIsContainer) { 0 } else { 1 } }}, Name',
    '| ForEach-Object {',
    '  $isDir = [bool]$_.PSIsContainer;',
    '  [pscustomobject]@{',
    '    name = [string]$_.Name;',
    '    fullPath = [string]$_.FullName;',
    '    type = if ($isDir) { "dir" } else { "file" };',
    '    ext = if ($isDir) { "" } else { [string]$_.Extension };',
    '    size = if ($isDir) { $null } else { [int64]$_.Length };',
    '    mtime = if ($_.LastWriteTimeUtc) { $_.LastWriteTimeUtc.ToString("o") } else { $null };',
    '  }',
    '});',
    '$rows | ConvertTo-Json -Depth 4 -Compress',
  ].join(' ');

  execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript], { windowsHide: true }, (err, stdout, stderr) => {
    if (err) return cb(new Error(`drive list failed: ${stderr || err.message}`));
    const text = String(stdout || '').trim();
    if (!text) return cb(null, []);
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
      cb(null, list);
    } catch (parseErr) {
      cb(new Error(`drive list parse failed: ${parseErr.message}`));
    }
  });
}

// ---------------------------------------------------------------------------
// Linux root browsing helpers
// ---------------------------------------------------------------------------

const normalizeLinuxAbsolutePath = _normalizeLinuxAbsolutePath;

function fetchLinuxDirectoryEntries(absoluteDirPath, { includeHidden = false } = {}, cb) {
  const normalized = normalizeLinuxAbsolutePath(absoluteDirPath);
  if (!normalized) return cb(new Error('Invalid Linux path'));
  fs.readdir(normalized, { withFileTypes: true }, (err, dirents) => {
    if (err) return cb(new Error(`Linux dir list failed: ${err.message}`));
    const entries = [];
    let pending = dirents.length;
    if (pending === 0) return cb(null, []);
    for (const dirent of dirents) {
      const name = dirent.name;
      if (!includeHidden && name.startsWith('.')) {
        pending -= 1;
        if (pending === 0) cb(null, entries.filter(Boolean).sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        }));
        continue;
      }
      const fullPath = path.posix.join(normalized, name);
      fs.stat(fullPath, (statErr, stat) => {
        if (!statErr && stat) {
          entries.push({
            name,
            fullPath,
            type: stat.isDirectory() ? 'dir' : 'file',
            ext: stat.isDirectory() ? '' : path.extname(name).toLowerCase(),
            size: stat.isDirectory() ? null : stat.size,
            mtime: stat.mtime ? stat.mtime.toISOString() : null,
          });
        }
        pending -= 1;
        if (pending === 0) {
          cb(null, entries.filter(Boolean).sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name);
          }));
        }
      });
    }
  });
}

function mapLinuxDirectoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const absolutePath = normalizeLinuxAbsolutePath(entry.fullPath);
  if (!absolutePath) return null;
  const type = String(entry.type || '').toLowerCase() === 'dir' ? 'dir' : 'file';
  const node = {
    path: absolutePath,
    name: String(entry.name || path.posix.basename(absolutePath) || absolutePath),
    type,
    mtime: entry.mtime ? String(entry.mtime) : null,
  };
  if (type === 'dir') {
    node.children = [];
    node.lazy = true;
    node.childrenLoaded = false;
    return node;
  }
  const ext = path.extname(absolutePath).toLowerCase();
  const contentType = workspaceContentType(absolutePath);
  node.ext = ext || null;
  node.size = Number(entry.size || 0);
  node.contentType = contentType;
  node.previewKind = workspacePreviewKindForMeta(absolutePath, contentType);
  return node;
}

// ---------------------------------------------------------------------------

function fetchWorkspaceDirectoryEntries(requestedPath, {
  includeHidden = false,
  includeHeavy = false,
  rootPath = null,
} = {}, cb) {
  const activeWorkspaceRoot = normalizeConversationWorkspaceRootPath(rootPath) || currentWorkspaceRootPath();
  if (!activeWorkspaceRoot) {
    const error = new Error('Workspace root unavailable');
    error.statusCode = 500;
    cb(error);
    return;
  }

  const rawPath = String(requestedPath || '').trim();
  const normalizedRelativePath = rawPath
    ? normalizeWorkspaceRelativePath(rawPath)
    : '';
  if (rawPath && !normalizedRelativePath) {
    const error = new Error('Invalid workspace path');
    error.statusCode = 400;
    cb(error);
    return;
  }

  const absolutePath = normalizedRelativePath
    ? resolveWorkspaceFilePath(normalizedRelativePath, activeWorkspaceRoot)
    : activeWorkspaceRoot;
  if (!absolutePath) {
    const error = new Error('Invalid workspace path');
    error.statusCode = 400;
    cb(error);
    return;
  }

  let stat = null;
  try {
    stat = fs.statSync(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      const notFound = new Error('Path not found');
      notFound.statusCode = 404;
      cb(notFound);
      return;
    }
    const failed = new Error(error?.message || 'Failed to read path metadata');
    failed.statusCode = 500;
    cb(failed);
    return;
  }
  if (!stat.isDirectory()) {
    const error = new Error('Path must reference a directory');
    error.statusCode = 400;
    cb(error);
    return;
  }

  let entries = [];
  try {
    entries = fs.readdirSync(absolutePath, { withFileTypes: true });
  } catch (error) {
    const failed = new Error(error?.message || 'Failed to list directory');
    failed.statusCode = 500;
    cb(failed);
    return;
  }

  const children = [];
  const visibleEntries = entries
    .filter((entry) => !shouldSkipRepoEntryName(entry?.name, { includeHidden, includeHeavy }))
    .sort(compareRepoDirEntries);
  for (const entry of visibleEntries) {
    const childName = String(entry?.name || '').trim();
    if (!childName) continue;
    const childAbsolutePath = path.join(absolutePath, childName);

    let childStat = null;
    try {
      childStat = fs.lstatSync(childAbsolutePath);
    } catch {
      continue;
    }
    if (!childStat || childStat.isSymbolicLink()) continue;

    const childRelativePath = normalizedRelativePath
      ? path.join(normalizedRelativePath, childName)
      : childName;
    const childWebPath = toRepoWebPath(childRelativePath);
    const childType = childStat.isDirectory() ? 'dir' : 'file';
    const childNode = {
      path: childWebPath,
      name: childName,
      type: childType,
      mtime: childStat.mtime ? childStat.mtime.toISOString() : null,
    };
    if (childType === 'dir') {
      childNode.children = [];
      childNode.lazy = true;
      childNode.childrenLoaded = false;
      children.push(childNode);
      continue;
    }

    const ext = path.extname(childAbsolutePath).toLowerCase();
    const contentType = workspaceContentType(childAbsolutePath);
    childNode.ext = ext || null;
    childNode.size = Number(childStat.size || 0);
    childNode.contentType = contentType;
    childNode.previewKind = workspacePreviewKindForMeta(childAbsolutePath, contentType);
    children.push(childNode);
  }

  const nodePath = toRepoWebPath(normalizedRelativePath);
  const nodeName = normalizedRelativePath
    ? (path.basename(absolutePath) || nodePath)
    : workspaceRootDisplayName(activeWorkspaceRoot);
  cb(null, {
    node: {
      path: nodePath,
      name: nodeName,
      type: 'dir',
      children,
      childrenLoaded: true,
      lazy: false,
    },
    rootPath: activeWorkspaceRoot,
    rootName: workspaceRootDisplayName(activeWorkspaceRoot),
    includeHidden,
    includeHeavy,
  });
}

function buildRepositoryTreeSnapshot({
  includeHidden = false,
  includeHeavy = false,
  maxNodes = MAX_REPO_TREE_NODES,
  rootPath = null,
  rootName = null,
} = {}) {
  const activeWorkspaceRoot = normalizeConversationWorkspaceRootPath(rootPath) || currentWorkspaceRootPath();
  const activeWorkspaceRootName = String(rootName || '').trim() || workspaceRootDisplayName(activeWorkspaceRoot);
  const safeMaxNodes = Number.isFinite(Number(maxNodes))
    ? Math.max(500, Math.min(Number(maxNodes), MAX_REPO_TREE_NODES))
    : MAX_REPO_TREE_NODES;

  let nodeCount = 0;
  let truncated = false;

  function walk(absolutePath, relativePath, depth = 0) {
    if (truncated || nodeCount >= safeMaxNodes) {
      truncated = true;
      return null;
    }

    let stat = null;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch {
      return null;
    }
    if (!stat) return null;
    if (stat.isSymbolicLink()) return null;

    const node = {
      path: toRepoWebPath(relativePath),
      name: relativePath ? path.basename(absolutePath) : activeWorkspaceRootName,
      type: stat.isDirectory() ? 'dir' : 'file',
      mtime: stat.mtime ? stat.mtime.toISOString() : null,
    };
    nodeCount += 1;

    if (node.type === 'file') {
      const ext = path.extname(absolutePath).toLowerCase();
      const contentType = workspaceContentType(absolutePath);
      node.ext = ext || null;
      node.size = Number(stat.size || 0);
      node.contentType = contentType;
      node.previewKind = workspacePreviewKindForMeta(absolutePath, contentType);
      return node;
    }

    if (depth >= MAX_REPO_TREE_DEPTH) {
      node.children = [];
      node.depthLimited = true;
      return node;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      node.children = [];
      node.readError = true;
      return node;
    }

    const visibleEntries = entries
      .filter((entry) => !shouldSkipRepoEntryName(entry?.name, { includeHidden, includeHeavy }))
      .sort(compareRepoDirEntries);

    node.children = [];
    for (const entry of visibleEntries) {
      if (nodeCount >= safeMaxNodes) {
        truncated = true;
        break;
      }
      const childName = String(entry?.name || '').trim();
      if (!childName) continue;
      const childAbsolutePath = path.join(absolutePath, childName);
      const childRelativePath = relativePath ? path.join(relativePath, childName) : childName;
      const childNode = walk(childAbsolutePath, childRelativePath, depth + 1);
      if (childNode) node.children.push(childNode);
    }

    return node;
  }

  const root = walk(activeWorkspaceRoot, '', 0) || {
    path: '',
    name: activeWorkspaceRootName,
    type: 'dir',
    children: [],
  };

  return {
    root,
    nodeCount,
    truncated,
    maxNodes: safeMaxNodes,
    includeHidden,
    includeHeavy,
    rootName: activeWorkspaceRootName,
    rootPath: activeWorkspaceRoot,
  };
}

function startWorkspaceFileWatcher() {
  if (workspaceFileWatcher) return;
  const rootForWatch = currentWorkspaceRootPath();
  const watchOptions = WORKSPACE_RECURSIVE_WATCH_SUPPORTED ? { recursive: true } : {};
  try {
    workspaceFileWatcher = fs.watch(rootForWatch, watchOptions, (eventType, changedPath) => {
      if (!changedPath) {
        workspaceFileMetaCache.clear();
        return;
      }
      const absoluteChangedPath = path.resolve(rootForWatch, String(changedPath));
      workspaceFileMetaCache.delete(absoluteChangedPath);
      if (eventType === 'rename') {
        workspaceFileMetaCache.delete(path.normalize(absoluteChangedPath));
      }
    });
    workspaceFileWatcher.on('error', (error) => {
      console.warn(`[server] Workspace watcher error: ${error?.message || String(error)}; clearing file cache`);
      workspaceFileMetaCache.clear();
    });
    console.log(`[server] Workspace file watcher enabled at: ${rootForWatch}`);
  } catch (error) {
    console.warn(`[server] Workspace file watcher unavailable: ${error?.message || String(error)}`);
  }
}

startWorkspaceFileWatcher();

function listWorkspaceRootEntries() {
  try {
    return fs.readdirSync(currentWorkspaceRootPath()).filter((name) => {
      const value = String(name || '').trim();
      return value && value !== '.' && value !== '..';
    });
  } catch {
    return [];
  }
}

function hydrateAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const att = { ...raw };
  const sha256 = String(att.sha256 || '').trim().toLowerCase();
  if (isSha256(sha256)) {
    att.sha256 = sha256;
    att.path = uploadPathForSha(sha256);
    att.reference = `@${att.path}`;
    att.contentUrl = uploadContentUrlForSha(sha256);
  }
  if (featureFlags.IMAGE_CONVERSATION_CONTINUITY_ENABLED === true && att.generatedImage) {
    const messageId = String(att.generatedImage.messageId || '').trim();
    const imageId = String(att.generatedImage.imageId || '').trim();
    const node = messageId && imageId ? stmts.getNodeByAttachment?.get(messageId, imageId) : null;
    if (node) {
      const parentEdge = stmts.getParentEdge?.get(node.id) || null;
      const parentNode = parentEdge ? stmts.getNode?.get(parentEdge.parent_node_id) : null;
      att.generatedImage = {
        ...att.generatedImage,
        continuity: {
          nodeId: node.id,
          imageSessionId: node.image_session_id,
          operationId: node.operation_id,
          parentNodeId: parentNode?.id || null,
          parentMessageId: parentNode?.assistant_message_id || null,
          parentImageId: parentNode?.attachment_image_id || null,
          canEdit: true,
        },
      };
    } else {
      att.generatedImage = {
        ...att.generatedImage,
        continuity: {
          nodeId: null,
          imageSessionId: null,
          operationId: null,
          parentNodeId: null,
          parentMessageId: null,
          parentImageId: null,
          canEdit: true,
        },
      };
    }
  }
  return att;
}

function persistUploadBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Empty upload');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('Uploaded file too large');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const filePath = uploadPathForSha(sha256);
  if (!fs.existsSync(filePath)) {
    const tmpPath = path.join(UPLOAD_DIR, `${sha256}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, buffer);
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (e) {
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      if (!fs.existsSync(filePath)) throw e;
    }
  }

  const now = new Date().toISOString();
  const originalName = typeof options.name === 'string' ? options.name.trim().slice(0, 255) : '';
  const mimeType = typeof options.type === 'string' ? options.type.trim().toLowerCase().slice(0, 127) : 'application/octet-stream';
  stmts.insertUploadFile.run(
    sha256,
    originalName || null,
    mimeType || 'application/octet-stream',
    buffer.length,
    now,
  );
  const row = stmts.getUploadFile.get(sha256);
  return buildStoredAttachment({
    sha256,
    name: row?.original_name || originalName || `upload-${sha256.slice(0, 12)}`,
    type: row?.mime_type || mimeType || 'application/octet-stream',
    size: Number(row?.size_bytes || buffer.length),
  });
}

function buildStoredAttachment({ sha256, name, type, size }) {
  const normalizedSha = String(sha256 || '').trim().toLowerCase();
  if (!isSha256(normalizedSha)) return null;
  const normalizedName = String(name || '').trim().slice(0, 255) || `upload-${normalizedSha.slice(0, 12)}`;
  const normalizedType = String(type || '').trim().toLowerCase().slice(0, 127) || 'application/octet-stream';
  return {
    name: normalizedName,
    type: normalizedType,
    size: Number(size || 0),
    sha256: normalizedSha,
    path: uploadPathForSha(normalizedSha),
    reference: `@${uploadPathForSha(normalizedSha)}`,
    contentUrl: uploadContentUrlForSha(normalizedSha),
  };
}

function normalizeAttachments(rawAttachments) {
  if (!rawAttachments) return [];
  const input = Array.isArray(rawAttachments) ? rawAttachments : [rawAttachments];
  const attachments = [];

  for (const raw of input.slice(0, MAX_UPLOAD_ATTACHMENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const referencedSha = String(raw.sha256 || '').trim().toLowerCase();
    if (isSha256(referencedSha)) {
      const row = stmts.getUploadFile.get(referencedSha);
      if (!row) continue;
      const stored = buildStoredAttachment({
        sha256: referencedSha,
        name: raw.name || row.original_name || `upload-${referencedSha.slice(0, 12)}`,
        type: raw.type || row.mime_type || 'application/octet-stream',
        size: Number(row.size_bytes || 0),
      });
      if (stored) attachments.push(stored);
      continue;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : 'image';
    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
    const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl.trim() : '';
    if (!type.startsWith('image/')) continue;
    if (!dataUrl.startsWith(`data:${type};base64,`) && !dataUrl.startsWith('data:image/')) continue;
    if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
      throw new Error('Image attachment too large');
    }
    attachments.push({ name: name || 'image', type, dataUrl, size: 0 });
  }

  return attachments;
}

function attachmentSummary(attachments) {
  if (!attachments.length) return '';
  return attachments.map((att) => att.name ? `${att.name} (${att.type})` : att.type).join(', ');
}

function linkUploadReferences(conversationId, messageId, attachments) {
  if (!conversationId || !messageId || !Array.isArray(attachments) || !attachments.length) return;
  const now = new Date().toISOString();
  for (const att of attachments) {
    const sha256 = String(att?.sha256 || '').trim().toLowerCase();
    if (!isSha256(sha256)) continue;
    stmts.insertUploadRef.run(sha256, conversationId, messageId, now);
  }
}

function collectOrphanedUploadsFromConversation(conversationId) {
  const hashes = stmts.listUploadHashesByConversation.all(conversationId).map((row) => String(row.file_sha256 || '').trim().toLowerCase()).filter(Boolean);
  if (!hashes.length) return [];
  stmts.deleteUploadRefsByConversation.run(conversationId);
  const orphaned = [];
  for (const sha256 of hashes) {
    const refs = Number(stmts.countUploadRefsBySha.get(sha256)?.cnt || 0);
    if (refs > 0) continue;
    orphaned.push(sha256);
  }
  return orphaned;
}

function deleteOrphanedUploads(hashes) {
  for (const sha256 of (hashes || [])) {
    if (!isSha256(sha256)) continue;
    const refs = Number(stmts.countUploadRefsBySha.get(sha256)?.cnt || 0);
    if (refs > 0) continue;
    stmts.deleteUploadFile.run(sha256);
    const filePath = uploadPathForSha(sha256);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  }
}

function sweepUnreferencedUploadBlobs() {
  return sweepUnreferencedUploads({
    listUnreferenced: () => db.prepare(UNREFERENCED_UPLOADS_QUERY).all(),
    deleteUploads: deleteOrphanedUploads,
  });
}

function normalizeMessageLine(text, maxLength = 240) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildCompactSummary(conversation, recentMessagesDesc) {
  const title = normalizeMessageLine(conversation?.title || 'Untitled', 80) || 'Untitled';
  const sourceLines = Array.isArray(recentMessagesDesc) ? [...recentMessagesDesc].reverse() : [];
  const lines = [
    `Conversation title: ${title}`,
    'Carry-over summary (latest turns first in source, normalized below):',
  ];

  for (const row of sourceLines.slice(0, 16)) {
    const role = row?.role === 'assistant' ? 'Assistant' : 'User';
    const line = normalizeMessageLine(row?.text || '', 260);
    if (!line) continue;
    lines.push(`- ${role}: ${line}`);
  }

  if (lines.length <= 2) {
    lines.push('- No prior text messages were available.');
  }

  return lines.join('\n').slice(0, 3500);
}

function createCompactedConversation(sourceConversationId) {
  // Compaction stays scoped to sourceConversationId; it never consults a
  // global/latest session file that could belong to another conversation.
  const source = stmts.getConv.get(sourceConversationId);
  if (!source) return null;

  const now = new Date().toISOString();
  const targetConversationId = uuidv4();
  const recent = stmts.getRecentMessagesDesc.all(sourceConversationId, 24);
  const summarySeed = buildCompactSummary(source, recent);
  const nextTitleBase = normalizeMessageLine(source.title || 'Conversation', 64) || 'Conversation';
  const nextTitle = `${nextTitleBase} (compacted)`.slice(0, 80);

  let targetRuntimeSession = null;
  const tx = db.transaction(() => {
    stmts.insertConv.run(targetConversationId, nextTitle, now, now);
    stmts.updateConvSeed.run(summarySeed, 1, sourceConversationId, now, targetConversationId);
    stmts.markConvCompacted.run(targetConversationId, now, sourceConversationId);
    targetRuntimeSession = ensureRuntimeSessionBinding(targetConversationId, null, now);
  });
  tx();

  return {
    sourceConversationId,
    targetConversationId,
    runtimeSessionId: targetRuntimeSession?.id || null,
    summarySeed,
    createdAt: now,
    targetTitle: nextTitle,
  };
}

function sanitizeActivityText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, 200);
}

function mapRelayActivityRow(row) {
  const text = sanitizeActivityText(row?.text);
  if (!text) return null;
  const subagentRunId = row?.subagent_run_id ? String(row.subagent_run_id).trim() : null;
  return {
    text,
    subagentRunId: subagentRunId || null,
  };
}

function relayActivityForResponse(responseMessageId) {
  return stmts.listActivityByResponse
    .all(responseMessageId)
    .map(mapRelayActivityRow)
    .filter(Boolean)
    .slice(0, 48);
}

function relayActivityForQueueMessage(queueMessageId) {
  return stmts.listActivityByQueueMessage
    .all(queueMessageId)
    .map(mapRelayActivityRow)
    .filter(Boolean)
    .slice(0, 48);
}

function relayStreamEventsForQueueMessage(queueMessageId) {
  const rows = stmts.listStreamEventsByQueueMessage?.all(queueMessageId) || [];
  return rows
    .map((row) => {
      const seq = Math.max(0, Math.trunc(Number(row?.seq || 0)));
      const subagentRunId = row?.subagent_run_id ? String(row.subagent_run_id).trim() : null;
      return {
        seq,
        text: String(row?.text || ''),
        done: Number(row?.done || 0) === 1,
        timestamp: row?.created_at || null,
        subagentRunId: subagentRunId || null,
      };
    })
    .filter((row) => Number.isFinite(row.seq))
    .slice(0, 5000);
}

function mapRelayThoughtRow(row) {
  const seq = Math.max(0, Math.trunc(Number(row?.seq || 0)));
  const subagentRunId = row?.subagent_run_id ? String(row.subagent_run_id).trim() : null;
  return {
    reasoningId: row?.reasoning_id ? String(row.reasoning_id) : null,
    seq,
    text: String(row?.text || ''),
    done: Number(row?.done || 0) === 1,
    timestamp: row?.created_at || null,
    subagentRunId: subagentRunId || null,
  };
}

function relayThoughtsForResponse(responseMessageId) {
  const rows = stmts.listThoughtsByResponse?.all(responseMessageId) || [];
  return normalizeRelayThoughtList(rows.map(mapRelayThoughtRow)).slice(0, 5000);
}

function relayThoughtsForQueueMessage(queueMessageId) {
  const rows = stmts.listThoughtsByQueueMessage?.all(queueMessageId) || [];
  return normalizeRelayThoughtList(rows.map(mapRelayThoughtRow)).slice(0, 5000);
}

function subagentRunsForResponse(responseMessageId) {
  const rows = stmts.listSubagentRunsByResponse?.all(responseMessageId, responseMessageId, responseMessageId) || [];
  return rows.map(mapSubagentRunRow).filter(Boolean).slice(0, 96);
}

function mapSubagentRunRow(row) {
  const subagentRunId = String(row?.id || '').trim();
  if (!subagentRunId) return null;
  return {
    subagentRunId,
    messageId: String(row?.queue_message_id || '').trim() || null,
    conversationId: String(row?.conversation_id || '').trim() || null,
    parentSubagentId: row?.parent_subagent_id ? String(row.parent_subagent_id).trim() : null,
    displayName: row?.display_name ? String(row.display_name).trim() : null,
    status: String(row?.status || 'running').trim().toLowerCase() || 'running',
    startedAt: row?.started_at || null,
    updatedAt: row?.updated_at || null,
  };
}

function inFlightStateForConversation(conversationId) {
  const row = stmts.getLatestProcessingQueueByConversation.get(conversationId);
  if (!row) return null;
  const streamEvents = relayStreamEventsForQueueMessage(row.id);
  const lastStreamEvent = streamEvents.length ? streamEvents[streamEvents.length - 1] : null;
  const subagentRunRows = stmts.listSubagentRunsByQueueMessage?.all(row.id) || [];
  return {
    messageId: row.id,
    status: 'processing',
    mode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
    timestamp: row.timestamp || null,
    processingAt: row.processing_at || null,
    activities: relayActivityForQueueMessage(row.id),
    thoughts: relayThoughtsForQueueMessage(row.id),
    streamEvents,
    streamDone: !!lastStreamEvent?.done,
    lastStreamSeq: lastStreamEvent?.seq || 0,
    subagentRuns: subagentRunRows.map(mapSubagentRunRow).filter(Boolean),
  };
}

function recoverProcessingOlderThan(cutoffIso, requeueAtIso, { ceilingBeforeIso = null } = {}) {
  const params = { inactiveBefore: cutoffIso, ceilingBefore: ceilingBeforeIso || null };
  const rows = stmts.listRecoverableProcessing.all(params);
  if (!rows.length) return [];

  const tx = db.transaction(() => {
    stmts.recoverProcessingBefore.run({ ...params, requeueAt: requeueAtIso });
    const settleRecoveredAbortControls = db.prepare(`
      UPDATE relay_control_requests
      SET status = 'failed',
          error = ?,
          updated_at = ?,
          completed_at = ?
      WHERE queue_message_id = ?
        AND type IN ('abort_turn', 'abort_subagent')
        AND status IN ('pending', 'processing')
    `);
    const now = new Date().toISOString();
    for (const row of rows) {
      settleRecoveredAbortControls.run('queue-recovered', now, now, row.id);
    }
  });
  tx();

  for (const row of rows) {
    io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'pending' });
  }
  io.emit('queue_updated', { recovered: rows.length });
  return rows;
}

// One `/api/usage` needs the same token for the quota read and the billing
// read, and `gh auth token` costs a process spawn. A short TTL collapses that
// to one spawn per modal open while still picking up a re-login promptly.
const GITHUB_TOKEN_CACHE_TTL_MS = 60_000;
let githubTokenCache = null;

/**
 * Resolve a GitHub token for quota/billing reads: an explicit environment
 * token wins, otherwise the CLI's own `gh auth token`.
 */
function resolveGitHubToken(cb) {
  const envToken = String(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (envToken) {
    cb(null, envToken);
    return;
  }
  if (githubTokenCache && githubTokenCache.expiresAt > Date.now()) {
    cb(null, githubTokenCache.token);
    return;
  }
  execFile('gh', ['auth', 'token'], (err, stdout, stderr) => {
    const ghToken = String(stdout || '').trim();
    if (!err && ghToken) {
      githubTokenCache = { token: ghToken, expiresAt: Date.now() + GITHUB_TOKEN_CACHE_TTL_MS };
      cb(null, ghToken);
      return;
    }
    githubTokenCache = null;
    const reason = String(stderr || stdout || '').trim();
    const reasonSuffix = reason ? ` (${reason})` : '';
    cb(new Error(`GitHub token unavailable: run gh auth login or set GH_TOKEN/GITHUB_TOKEN${reasonSuffix}`));
  });
}

// Most tokens (including every `gh auth token`) cannot read billing, and that
// answer does not change between two opens of the usage modal. Remembering the
// refusal keeps the modal from paying for the same three doomed requests each
// time; the TTL is what lets a newly-scoped PAT start working without a restart.
const COPILOT_BILLING_DENIAL_TTL_MS = 10 * 60_000;
let copilotBillingDenial = null;
let copilotBillingLogin = '';

/**
 * Optional, personal-scope billing detail for the plan-usage card. Never
 * rejects: a token without billing scope simply yields `{ error }` and the card
 * renders its quota meters without the cost breakdown.
 */
function fetchCopilotBillingUsage() {
  if (copilotBillingDenial && copilotBillingDenial.expiresAt > Date.now()) {
    return Promise.resolve({
      items: [],
      timePeriod: null,
      scope: copilotBillingDenial.scope,
      error: copilotBillingDenial.error,
    });
  }
  return new Promise((resolve) => {
    resolveGitHubToken((error, token) => {
      if (error || !token) {
        resolve({ items: [], timePeriod: null, scope: null, error: error?.message || 'no GitHub token available' });
        return;
      }
      // The cached login skips the `/user` lookup; it is cleared alongside a
      // denial so a token that now points at another account re-resolves.
      fetchPersonalBillingUsage({ token, login: copilotBillingLogin })
        .then((result) => {
          if (result?.denied) {
            copilotBillingDenial = {
              expiresAt: Date.now() + COPILOT_BILLING_DENIAL_TTL_MS,
              error: result.error || 'billing usage is unavailable',
              scope: result.scope || null,
            };
            copilotBillingLogin = '';
          } else {
            copilotBillingDenial = null;
            copilotBillingLogin = String(result?.scope || '').trim();
          }
          resolve(result);
        })
        .catch((billingError) => resolve({
          items: [],
          timePeriod: null,
          scope: null,
          error: String(billingError?.message || billingError || 'billing usage failed'),
        }));
    });
  });
}

function fetchUsageSummary(cb) {
  const useToken = (token) => {
    fetch('https://api.github.com/copilot_internal/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          const compactBody = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
          const suffix = compactBody ? `: ${compactBody}` : '';
          throw new Error(`GitHub usage API failed (${response.status})${suffix}`);
        }
        return response.json();
      })
      .then((data) => {
        const snap = data?.quota_snapshots || {};
        const premium = snap.premium_interactions || {};
        const chat = snap.chat || {};
        const planSnapshot = snap.plan || data?.plan || data?.copilot_plan_quota || {};
        cb(null, {
          plan: data?.copilot_plan,
          resetDate: data?.quota_reset_date,
          chat: {
            unlimited: chat.unlimited ?? true,
            remaining: chat.remaining ?? null,
            entitlement: chat.entitlement ?? null,
            percentRemaining: chat.percent_remaining ?? null,
          },
          premiumInteractions: {
            unlimited: premium.unlimited ?? false,
            remaining: Math.round(premium.quota_remaining ?? premium.remaining ?? 0),
            entitlement: premium.entitlement ?? 1500,
            percentRemaining: premium.percent_remaining ?? null,
            // Carried through so the plan-usage card can label the bucket as
            // AI credits or premium requests from the payload itself.
            unit: premium.unit ?? snap.unit ?? data?.quota_unit ?? null,
          },
          planQuota: {
            unlimited: planSnapshot.unlimited ?? false,
            remaining: planSnapshot.quota_remaining ?? planSnapshot.remaining ?? null,
            entitlement: planSnapshot.entitlement ?? null,
            percentRemaining: planSnapshot.percent_remaining ?? null,
          },
        });
      })
      .catch((e) => cb(new Error(e?.message || 'Failed to fetch usage data')));
  };

  resolveGitHubToken((error, token) => {
    if (error || !token) {
      cb(error || new Error('GitHub token unavailable'));
      return;
    }
    useToken(token);
  });
}

function shouldIncludeInPwaVersion(relativePath) {
  if (!relativePath) return false;
  const normalized = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('.')) return false;
  if (normalized === 'index.html' || normalized === 'sw.js' || normalized === 'manifest.webmanifest') return true;
  if (/^app-icon(?:-\d+)?\.png$/i.test(normalized)) return true;
  if (/^app-icon\.svg$/i.test(normalized)) return true;
  if (/^favicon\.ico$/i.test(normalized)) return true;
  if (normalized.startsWith('app/')) {
    const ext = path.extname(normalized).toLowerCase();
    return ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.html';
  }
  return false;
}

function formatPwaVersionTimestamp(valueMs) {
  const date = new Date(valueMs);
  if (!Number.isFinite(date.getTime())) return '0';
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}-${hh}-${min}-${ss}Z`;
}

function computePwaShellVersion() {
  let maxMtimeMs = 0;
  const stack = [PUBLIC_DIR];
  while (stack.length) {
    const dirPath = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(PUBLIC_DIR, absolutePath);
      if (!shouldIncludeInPwaVersion(relativePath)) continue;
      try {
        const stats = fs.statSync(absolutePath);
        if (Number.isFinite(stats.mtimeMs) && stats.mtimeMs > maxMtimeMs) {
          maxMtimeMs = stats.mtimeMs;
        }
      } catch {}
    }
  }
  const sourceMs = Number.isFinite(maxMtimeMs) && maxMtimeMs > 0 ? maxMtimeMs : Date.now();
  return formatPwaVersionTimestamp(sourceMs);
}

function renderIndexHtmlWithPwaVersion(appConfigOverrides = {}) {
  const appConfig = JSON.stringify({
    basePath: remotePath,
    ...(appConfigOverrides && typeof appConfigOverrides === 'object' ? appConfigOverrides : {}),
  });
  const version = computePwaShellVersion();
  const source = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  return source
    .replace(APP_CONFIG_PLACEHOLDER, `window.__COPILOT_APP_CONFIG = ${appConfig};`)
    .replace(PWA_VERSION_PLACEHOLDER, `const __PWA_VERSION = '${version}';`);
}

function loadPwaManifestTemplate() {
  const fallback = {
    name: 'Copilot Remote',
    short_name: 'Copilot',
    description: 'Installable Copilot Remote web app with standalone launcher support.',
    display_override: ['standalone'],
    display: 'standalone',
    background_color: '#161b22',
    theme_color: '#161b22',
    icons: [
      { src: 'app-icon.svg?v=25', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
  try {
    const raw = fs.readFileSync(PWA_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return fallback;
}

function buildScopedPwaManifest({ shared = false } = {}) {
  const manifest = loadPwaManifestTemplate();
  if (shared) {
    return {
      ...manifest,
      id: './__copilot_remote_shared__',
      start_url: './',
      scope: './',
      display_override: ['browser'],
      display: 'browser',
      prefer_related_applications: false,
    };
  }
  return {
    ...manifest,
    id: './__copilot_remote_pwa__',
    start_url: './',
    scope: './',
  };
}

const sessionTranscriptService = createSessionTranscriptService({
  fs,
  path,
  resolveSessionStateRoot,
});
const readSessionTranscriptMessages = sessionTranscriptService.readSessionTranscriptMessages;
const parseSessionEventsToMessages = sessionTranscriptService.parseSessionEventsToMessages;
const readSessionUsageSummary = sessionTranscriptService.readSessionUsageSummary;
const sessionHistoryRefreshService = createSessionHistoryRefreshService({
  db,
  stmts,
  parseSessionEventsToMessages,
  inFlightStateForConversation,
  isDeletedSdkSession: (sdkSessionId) => !!stmts.getDeletedSdkSession.get(String(sdkSessionId || '').trim()),
});
const sdkSessionImportService = createSdkSessionImportService({
  db,
  stmts,
  createClient: () => createInstalledCopilotClient({
    config,
    cwd: currentWorkspaceRootPath(),
    baseDirectory: path.dirname(resolveSessionStateRoot()),
    logLevel: 'error',
  }),
  parseSessionEventsToMessages,
  replaceRetrievableHistory: sessionHistoryRefreshService.replaceRetrievableHistory,
  ensureRuntimeSessionBinding,
  logger: console,
});
const contextSnapshotService = createContextSnapshotService({
  fs,
  path,
  resolveSessionStateRoot,
  getModelContextLimitTokens,
});
const readContextFromSessionEvents = contextSnapshotService.readContextFromSessionEvents;
// Claude-provider sessions live under the Agent SDK's project layout rather than
// ~/.copilot/session-state, so their browsable session folder resolves separately.
const claudeSessionRootResolver = createClaudeSessionRootResolver({ fs, path });
const cursorSessionRootResolver = createCursorSessionRootResolver({ fs, path, serverDir: __dirname });

// ─── Express + Socket.io Setup ────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);
httpServer.prependListener('request', (req, _res) => {
  rewriteSocketIoRequestPath(req, remotePath);
});
httpServer.prependListener('upgrade', (req, _socket, _head) => {
  rewriteSocketIoRequestPath(req, remotePath);
});
// Public tunnels (Cloudflare, or a VPS/Caddy front) forward every path on the
// bound hostname to this port, including the session-worker WebSocket plumbing.
// Reject those before auth; local workers connect over 127.0.0.1 with no edge
// marker header and are unaffected.
const tunnelWorkerPathGuard = createTunnelWorkerPathGuard({
  pathPrefix: remotePath,
  extraMarkerHeaders: config.tunnelMarkerHeaders
    || process.env.COPILOT_TUNNEL_MARKER_HEADERS
    || [],
  logger: console,
});
httpServer.prependListener('upgrade', (req, socket, _head) => {
  tunnelWorkerPathGuard.handleUpgrade(req, socket);
});
// Mobile clients disconnect whenever the PWA is backgrounded. Connection state
// recovery replays the discrete events they missed instead of forcing a full
// resync, so a phone that was away for a few minutes comes back in sync.
// High-volume stream chunks are emitted volatile and deliberately excluded from
// the replay buffer; see the io.volatile.emit('relay_stream') call site.
const SOCKET_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const io         = new Server(httpServer, {
  cors: { origin: '*' },
  path: socketIoPath(),
  connectionStateRecovery: {
    maxDisconnectionDuration: SOCKET_RECOVERY_WINDOW_MS,
    skipMiddlewares: true,
  },
});
const SHARED_VIEWER_STALE_MS = 45_000;
const SHARED_VIEWER_MAX_PER_CONVERSATION = Number.isFinite(Number(config.sharedPresenceMaxPerConversation))
  ? Math.max(1, Math.trunc(Number(config.sharedPresenceMaxPerConversation)))
  : 200;
const SHARED_VIEWER_MAX_GLOBAL = Number.isFinite(Number(config.sharedPresenceMaxGlobal))
  ? Math.max(SHARED_VIEWER_MAX_PER_CONVERSATION, Math.trunc(Number(config.sharedPresenceMaxGlobal)))
  : 5_000;
const sharedViewersByConversation = new Map();

function sanitizeSharedViewerId(value) {
  const id = String(value || '').trim().replace(/[^a-zA-Z0-9:_-]+/g, '');
  if (!id) return '';
  return id.slice(0, 128);
}

function getSharedWatcherCount(conversationId) {
  const convId = String(conversationId || '').trim();
  if (!convId) return 0;
  const viewers = sharedViewersByConversation.get(convId);
  return viewers instanceof Map ? viewers.size : 0;
}

function emitConversationWatcherCount(conversationId) {
  const convId = String(conversationId || '').trim();
  if (!convId) return 0;
  const watcherCount = getSharedWatcherCount(convId);
  io.emit('conversation_watchers', { conversationId: convId, watcherCount });
  return watcherCount;
}

function pruneSharedViewersMap(viewers, now = Date.now()) {
  if (!(viewers instanceof Map) || viewers.size === 0) return false;
  let changed = false;
  for (const [key, entry] of viewers.entries()) {
    const lastSeenAt = Number(entry?.lastSeenAt || 0);
    if (!Number.isFinite(lastSeenAt) || (now - lastSeenAt) > SHARED_VIEWER_STALE_MS) {
      viewers.delete(key);
      changed = true;
    }
  }
  return changed;
}

function evictOldestSharedViewerFromMap(viewers) {
  if (!(viewers instanceof Map) || viewers.size === 0) return false;
  let oldestKey = '';
  let oldestSeenAt = Number.POSITIVE_INFINITY;
  for (const [key, entry] of viewers.entries()) {
    const seenAt = Number(entry?.lastSeenAt || 0);
    const normalizedSeenAt = Number.isFinite(seenAt) ? seenAt : 0;
    if (normalizedSeenAt < oldestSeenAt) {
      oldestSeenAt = normalizedSeenAt;
      oldestKey = key;
    }
  }
  if (!oldestKey) return false;
  viewers.delete(oldestKey);
  return true;
}

function countSharedViewerEntries() {
  let total = 0;
  for (const viewers of sharedViewersByConversation.values()) {
    if (viewers instanceof Map) total += viewers.size;
  }
  return total;
}

function evictOldestSharedViewerGlobally() {
  let targetConversationId = '';
  let targetKey = '';
  let oldestSeenAt = Number.POSITIVE_INFINITY;
  for (const [conversationId, viewers] of sharedViewersByConversation.entries()) {
    if (!(viewers instanceof Map) || viewers.size === 0) continue;
    for (const [key, entry] of viewers.entries()) {
      const seenAt = Number(entry?.lastSeenAt || 0);
      const normalizedSeenAt = Number.isFinite(seenAt) ? seenAt : 0;
      if (normalizedSeenAt < oldestSeenAt) {
        oldestSeenAt = normalizedSeenAt;
        targetConversationId = String(conversationId || '').trim();
        targetKey = key;
      }
    }
  }
  if (!targetConversationId || !targetKey) return '';
  const viewers = sharedViewersByConversation.get(targetConversationId);
  if (!(viewers instanceof Map)) return '';
  viewers.delete(targetKey);
  if (viewers.size <= 0) sharedViewersByConversation.delete(targetConversationId);
  return targetConversationId;
}

function pruneSharedViewerPresence() {
  const now = Date.now();
  const changedConversations = [];
  for (const [conversationId, viewers] of sharedViewersByConversation.entries()) {
    if (!(viewers instanceof Map) || viewers.size === 0) {
      sharedViewersByConversation.delete(conversationId);
      continue;
    }
    const before = viewers.size;
    pruneSharedViewersMap(viewers, now);
    if (viewers.size === 0) {
      sharedViewersByConversation.delete(conversationId);
    }
    if (before !== viewers.size) {
      changedConversations.push(String(conversationId || '').trim());
    }
  }
  for (const conversationId of changedConversations) {
    emitConversationWatcherCount(conversationId);
  }
}

function markSharedViewerPresence({ conversationId, token, viewerId } = {}) {
  const convId = String(conversationId || '').trim();
  const shareToken = String(token || '').trim();
  const viewer = sanitizeSharedViewerId(viewerId);
  if (!convId || !shareToken || !viewer) return { ok: false, watcherCount: 0 };
  const key = `${shareToken}:${viewer}`;
  let viewers = sharedViewersByConversation.get(convId);
  if (!(viewers instanceof Map)) {
    viewers = new Map();
    sharedViewersByConversation.set(convId, viewers);
  }
  const now = Date.now();
  pruneSharedViewersMap(viewers, now);
  const isNewViewer = !viewers.has(key);
  if (isNewViewer) {
    while (viewers.size >= SHARED_VIEWER_MAX_PER_CONVERSATION) {
      if (!evictOldestSharedViewerFromMap(viewers)) break;
    }
    if (viewers.size >= SHARED_VIEWER_MAX_PER_CONVERSATION) {
      emitConversationWatcherCount(convId);
      return { ok: false, watcherCount: viewers.size, capped: true };
    }
    while (countSharedViewerEntries() >= SHARED_VIEWER_MAX_GLOBAL) {
      const evictedConversationId = evictOldestSharedViewerGlobally();
      if (!evictedConversationId) break;
      if (evictedConversationId !== convId) emitConversationWatcherCount(evictedConversationId);
    }
    if (countSharedViewerEntries() >= SHARED_VIEWER_MAX_GLOBAL) {
      emitConversationWatcherCount(convId);
      return { ok: false, watcherCount: viewers.size, capped: true };
    }
  }
  const before = viewers.size;
  viewers.set(key, { lastSeenAt: now });
  const watcherCount = viewers.size;
  if (before !== watcherCount) {
    emitConversationWatcherCount(convId);
  } else {
    io.emit('conversation_watchers', { conversationId: convId, watcherCount });
  }
  return { ok: true, watcherCount, capped: false };
}
async function requestSessionWorkerSocketDelivery({ sessionId, pid, reason = 'worker-ready' } = {}) {
  const requesterSessionId = String(sessionId || '').trim();
  if (!requesterSessionId) return { message: null, reason: 'missing-session-id' };
  touchCli();
  const sessionWorkerRoutingEnabled = featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true;
  if (!sessionWorkerRoutingEnabled) {
    return { message: null, paused: true, reason: 'session_worker_routing_disabled' };
  }
  if (sessionWorkerSupervisor?.isKillBlocked?.(requesterSessionId) === true) {
    return {
      message: null,
      routing: {
        enabled: true,
        requesterSessionId,
        blockedReason: 'session-killed',
        lifecycle: sessionWorkerSupervisor?.getLifecycleState?.(requesterSessionId) || null,
        fallbackRestart: null,
      },
      restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
    };
  }
  sessionWorkerSupervisor?.noteSessionHeartbeat?.(requesterSessionId);
  if (runtimeState.relayPaused) {
    return { message: null, paused: true, reason: 'relay_paused' };
  }
  if (runtimeState.tunnelState?.blocking) {
    return {
      message: null,
      paused: true,
      reason: 'ssh_tunnel_required',
      sshTunnel: {
        mode: runtimeState.tunnelState?.mode ?? null,
        required: runtimeState.tunnelState?.required ?? false,
        connected: runtimeState.tunnelState?.connected ?? false,
        lastError: runtimeState.tunnelState?.lastError ?? null,
      },
    };
  }

  if (runtimeState.cloudflaredTunnelState?.blocking) {
    return {
      message: null,
      paused: true,
      reason: 'cloudflared_tunnel_required',
      cloudflaredTunnel: {
        mode: runtimeState.cloudflaredTunnelState?.mode ?? null,
        required: runtimeState.cloudflaredTunnelState?.required ?? false,
        connected: runtimeState.cloudflaredTunnelState?.connected ?? false,
        lastError: runtimeState.cloudflaredTunnelState?.lastError ?? null,
      },
    };
  }

  const counts = queueCounts();
  const existingWorker = sessionWorkerRegistry?.getWorker?.(requesterSessionId) || null;
  if (!existingWorker) {
    sessionWorkerRegistry?.upsertWorker?.({
      sdkSessionId: requesterSessionId,
      workerId: `worker-${requesterSessionId.slice(0, 8)}`,
      status: 'ready',
      pid: pid || null,
      queueDepth: Math.max(0, Number(counts.pendingCount || 0)),
    });
  } else if (pid && existingWorker.pid !== pid) {
    sessionWorkerRegistry?.upsertWorker?.({
      ...existingWorker,
      sdkSessionId: requesterSessionId,
      pid,
      status: existingWorker.status || 'ready',
      queueDepth: Math.max(0, Number(counts.pendingCount || 0)),
    });
  }

  const dequeueResult = await dequeuePendingMessageForWorkerLoop({
    db,
    stmts,
    nowIso: new Date().toISOString(),
    routingEnabled: true,
    requesterSessionId,
    ownerLeaseMs: 60_000,
    affinityOnly: false,
    sessionWorkerSupervisor,
    relayRestartOrchestrator,
    inFlightProcessingCount: Number(counts.processingCount || 0),
  });
  if (!dequeueResult?.message) {
    return {
      message: null,
      routing: {
        enabled: true,
        requesterSessionId,
        blockedReason: String(dequeueResult?.blockedReason || '').trim() || null,
        lifecycle: dequeueResult?.lifecycle || null,
        fallbackRestart: dequeueResult?.fallbackRestart || null,
      },
      restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
    };
  }

  const out = buildDequeuedRelayMessage({
    msg: dequeueResult.message,
    stmts,
    parseAttachments,
    hydrateAttachment,
    ensureRuntimeSessionBinding,
    configuredConversationSessionMode,
    normalizeRelayMode,
    defaultRelayMode: DEFAULT_RELAY_MODE,
    defaultModel: DEFAULT_MODEL,
  });
  if (out?.ownerSessionId) {
    const worker = sessionWorkerRegistry?.getWorker?.(out.ownerSessionId) || null;
    sessionWorkerRegistry?.upsertWorker?.({
      ...(worker || {}),
      sdkSessionId: out.ownerSessionId,
      conversationId: out.conversationId,
      runtimeSessionId: out.runtimeSessionId,
      pid: pid || worker?.pid || null,
      status: 'processing',
      queueDepth: Math.max(0, Number(queueCounts?.().pendingCount || 0)),
    });
    sessionWorkerSupervisor?.markProcessing?.(out.ownerSessionId, Number(queueCounts?.().processingCount || 0));
  }
  console.log(`${runtimeLogPrefix()}WS DEQUEUE ${out.id.slice(0, 8)} session=${requesterSessionId.slice(0, 8)} reason=${String(reason || 'worker-ready')}`);
  io.emit('message_status', { messageId: out.id, conversationId: out.conversationId, status: 'processing' });
  return {
    message: out,
    routing: {
      enabled: true,
      requesterSessionId,
    },
    restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
  };
}

async function recoverUndeliveredSessionWorkerMessage({ pending = null, sessionId = null, reason = 'ws-send-failed' } = {}) {
  const messageId = String(pending?.message?.id || pending?.messageId || '').trim();
  const requesterSessionId = String(sessionId || pending?.message?.ownerSessionId || '').trim();
  if (!messageId) return false;
  const row = stmts.findQById.get(messageId);
  if (!row || String(row.status || '').trim().toLowerCase() !== 'processing') return false;

  const retryCount = Number(row.retry_count || 0) + 1;
  const nextAttemptAt = addMsIso(Math.min(5_000, computeRetryDelayMs(retryCount)));
  const result = db.prepare(`
    UPDATE queue
    SET status = 'pending',
        processing_at = NULL,
        retry_count = ?,
        next_attempt_at = ?,
        owner_lease_expires_at = NULL
    WHERE id = ?
      AND status = 'processing'
  `).run(retryCount, nextAttemptAt, messageId);
  if (result.changes <= 0) return false;

  if (requesterSessionId) {
    sessionWorkerSupervisor?.markIdle?.(requesterSessionId, Number(queueCounts?.().pendingCount || 0));
  }
  console.warn(`${runtimeLogPrefix()}WS REQUEUE ${messageId.slice(0, 8)} session=${requesterSessionId ? requesterSessionId.slice(0, 8) : 'unknown'} retry=${retryCount} reason=${String(reason || 'ws-send-failed')}`);
  io.emit('message_status', { messageId, conversationId: row.conversation_id, status: 'pending' });
  io.emit('queue_updated', { recovered: 1, reason: 'worker-ws-send-failed' });
  sessionWorkerWebSocketService?.emitQueueChanged?.('worker-ws-send-failed');
  return true;
}

const sessionWorkerWebSocketService = createSessionWorkerWebSocketService({
  WebSocketServerImpl: WebSocketServer,
  httpServer,
  authToken: config.authToken,
  queueCounts,
  touchCli,
  noteWorkerHeartbeat: (sessionId) => {
    sessionWorkerSupervisor?.noteSessionHeartbeat?.(sessionId);
  },
  onDeliverySendFailed: recoverUndeliveredSessionWorkerMessage,
  requestWork: requestSessionWorkerSocketDelivery,
  pathPrefix: remotePath,
  pollIntervalMs: 500,
  logger: console,
});
const tmuxInspectorAccessPolicy = createTmuxInspectorAccessPolicy({
  sessionWorkerRegistry,
  sessionWorkerSupervisor,
});
const tmuxInspectorStreamService = createTmuxInspectorStreamService({
  platform: process.platform,
  pollIntervalMs: 250,
  historyLines: 400,
  isSessionAllowed: (sdkSessionId) => tmuxInspectorAccessPolicy.evaluateSession(sdkSessionId),
});
const tmuxInspectorSocketService = createTmuxInspectorSocketService({
  streamService: tmuxInspectorStreamService,
  accessPolicy: tmuxInspectorAccessPolicy,
  logger: console,
});

async function primePendingSessionWorkers(reason = 'pending-worker-prime') {
  if (featureFlags?.SESSION_WORKER_ROUTING_ENABLED !== true) return 0;
  if (runtimeShutdownStarted) return 0;
  if (typeof sessionWorkerSupervisor?.ensureWorker !== 'function') return 0;
  if (typeof stmts.listPendingWorkerOwnerSessionIds?.all !== 'function') return 0;

  // No next_attempt_at filter here: rows sitting in retry backoff still need
  // their worker warm, otherwise the 2s relay poll wins the race the moment
  // the backoff matures and the turn executes on the wrong provider.
  const rows = stmts.listPendingWorkerOwnerSessionIds.all(25);
  let requested = 0;
  for (const row of rows) {
    const sdkSessionId = String(row?.sdk_session_id || '').trim();
    if (!sdkSessionId) continue;
    if (sessionWorkerSupervisor?.isKillBlocked?.(sdkSessionId) === true) continue;
    requested += 1;
    try {
      const result = await sessionWorkerSupervisor.ensureWorker(sdkSessionId);
      if (!result?.ok) {
        console.warn(`${runtimeLogPrefix()}WORKER PRIME blocked session=${sdkSessionId.slice(0, 8)} reason=${String(result?.error || reason || 'pending-worker-prime')}`);
      }
    } catch (error) {
      console.warn(`${runtimeLogPrefix()}WORKER PRIME failed session=${sdkSessionId.slice(0, 8)} reason=${String(reason || 'pending-worker-prime')} err=${error?.message || error}`);
    }
  }
  return requested;
}

// Guard first, so a tunnelled request to a worker path is rejected before any
// body is parsed and before auth runs.
app.use(tunnelWorkerPathGuard.requestMiddleware);
// Uploads travel as raw bodies on POST /api/upload (express.raw, capped by
// MAX_UPLOAD_BYTES), so the JSON limit only bounds inline image data URLs.
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => {
  stripRequestPathPrefix(req, remotePath);
  next();
});
app.get('/socket.io/socket.io.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(SOCKET_IO_CLIENT_JS_PATH, (error) => {
    if (error) next(error);
  });
});
app.get('/manifest.webmanifest', (req, res, next) => {
  try {
    const shared = String(req.query?.shared || '').trim() === '1';
    const manifest = buildScopedPwaManifest({ shared });
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/manifest+json').send(JSON.stringify(manifest, null, 2));
  } catch (error) {
    next(error);
  }
});
app.get('/sw.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(PWA_SW_PATH, (error) => {
    if (error) next(error);
  });
});
app.get(['/', '/index.html'], (req, res, next) => {
  try {
    const html = renderIndexHtmlWithPwaVersion();
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
  } catch (error) {
    next(error);
  }
});
app.get(['/shared/:token', '/shared/:token/'], (req, res, next) => {
  try {
    const rawToken = String(req.params?.token || '').trim().toLowerCase();
    const shareToken = /^[a-f0-9]{32,128}$/.test(rawToken) ? rawToken : '';
    const html = renderIndexHtmlWithPwaVersion({ sharedToken: shareToken });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.type('html').send(html);
  } catch (error) {
    next(error);
  }
});
app.use(express.static(PUBLIC_DIR, { etag: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));

// ─── CLI Status Tracking ──────────────────────────────────────────────────────
let cliLastSeen = null;
let cliOnline   = false;
let relayPaused = false;
const relayBridgeOwnerService = createRelayBridgeOwnerService();

const runtimeState = {
  get cliOnline() { return cliOnline; },
  set cliOnline(value) { cliOnline = value; },
  get relayPaused() { return relayPaused; },
  set relayPaused(value) { relayPaused = value; },
  get ttyConsoleActive() { return Boolean(ttyConsoleRuntime?.tty); },
  get relayShutdown() { return getRelayShutdownState(); },
  get activeBridgeOwner() { return relayBridgeOwnerService.getOwner(); },
  get workerWebSocketStatus() { return sessionWorkerWebSocketService.status(); },
  get tmuxInspectorStatus() { return tmuxInspectorSocketService.status(); },
  get featureFlags() { return featureFlags; },
  get sessionWorkerSupervisor() { return sessionWorkerSupervisor; },
};
const windowsAutostartService = createWindowsAutostartService({
  packageRoot: REPO_ROOT,
  configPath: CONFIG_PATH,
});

const gitChangesService = createGitChangesService();
const sharedRouteDeps = {
  auth,
  gitChangesService,
  currentWorkspaceRootPath,
  io,
  db,
  stmts,
  config,
  runtimeState,
  uuidv4,
  ts,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_ATTACHMENTS,
  MAX_REPO_TREE_NODES,
  MAX_REQUEUE_RETRIES,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_WORKSPACE_PREVIEW_BYTES,
  MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES,
  remotePath,
  parseBooleanQueryFlag,
  buildRepositoryTreeSnapshot,
  fetchBrowsableDrives,
  fetchWorkspaceDirectoryEntries,
  fetchDriveDirectoryEntries,
  mapDriveDirectoryEntry,
  driveDisplayName,
  normalizeDriveAbsolutePath,
  driveRootFromAbsolutePath,
  toDriveWebPath,
  normalizeLinuxAbsolutePath,
  fetchLinuxDirectoryEntries,
  mapLinuxDirectoryEntry,
  compareRepoDirEntries,
  shouldSkipRepoEntryName,
  readWorkspaceFileMeta,
  resolveWorkspaceFilePath,
  normalizeWorkspaceRelativePath,
  previewLanguageForWorkspaceFile,
  readWorkspaceFilePreviewBuffer,
  isLikelyBinaryPreviewBuffer,
  isLikelyTextContentType,
  workspacePreviewKindForMeta,
  workspaceContentType,
  persistUploadBuffer,
  isSha256,
  uploadPathForSha,
  uploadContentUrlForSha,
  maybeApplyWorkspaceRootFromMessage,
  updateConversationConfiguredWorkspaceRoot,
  setWorkspaceRoot: applyWorkspaceRoot,
  setDefaultSessionWorkspaceRootPath,
  getOpenAIProviderSettings,
  setOpenAIProviderSettings,
  refreshOpenAIProviderModels,
  getClaudeProviderSettings,
  setClaudeProviderSettings,
  refreshClaudeProviderModels,
  getCursorProviderSettings,
  setCursorProviderSettings,
  refreshCursorProviderModels,
  getGrokProviderSettings,
  setGrokProviderSettings,
  refreshGrokProviderModels,
  reconcileUnstartedConversationProviders,
  rebindUnstartedOpenAIConversationModel,
  getOrCreateConversation,
  ensureRuntimeSessionBinding,
  linkUploadReferences,
  normalizeAttachments,
  collectReferenceAttachmentsFromText,
  mergeMessageAttachments,
  attachmentSummary,
  createCompactedConversation,
  workspaceRootPayload,
  queueCounts,
  getModelCatalogState,
  updateModelCatalog,
  listModelVariantRows,
  refreshModelVariantCatalogFromCli,
  setEnabledModelVariants,
  parseModelVariantSelection,
  SUPPORTED_REASONING_EFFORTS,
  buildRelayReadyBannerData,
  processingTimeoutMs,
  localhostOnly,
  listenHost,
  ensureSessionId,
  touchCli,
  markCliOffline,
  recoverProcessingOlderThan,
  addMsIso,
  computeRetryDelayMs,
  resolveRequestedModel,
  resolveRequestedReasoningEffort,
  normalizeRelayMode,
  DEFAULT_RELAY_MODE,
  DEFAULT_MODEL,
  configuredConversationSessionMode,
  parseAttachments,
  hydrateAttachment,
  relayActivityForResponse,
  relayActivityForQueueMessage,
  relayThoughtsForResponse,
  relayThoughtsForQueueMessage,
  subagentRunsForResponse,
  sanitizeActivityText,
  inFlightStateForConversation,
  emitToClientsExceptSessionId,
  relayBridgeOwnerService,
  relayCliLauncherService,
  resolveConversationWorkspaceState,
  updateConversationConfiguredWorkspaceRoot,
  learnConversationWorkspaceRoot,
  setPendingSessionCwd,
  consumePendingSessionCwd,
  getPendingSessionCwd,
  workspaceRootAllowList,
  featureFlags,
  sessionWorkerSupervisor,
  sessionWorkerRegistry,
  sessionWorkerProcessInspector,
  buildContextResponseText,
  readContextFromSessionEvents,
  sessionHistoryRefreshService,
  sdkSessionImportService,
  readSessionTranscriptMessages,
  readSessionUsageSummary,
  collectOrphanedUploadsFromConversation,
  deleteOrphanedUploads,
  fs,
  path,
  uploadsDir: UPLOAD_DIR,
  fetchUsageSummary,
  fetchCopilotBillingUsage,
  fetchGrokBillingUsage: createGrokBillingUsageFetcher(),
  fetchCursorDashboardUsage: createCursorDashboardUsageFetcher({
    getSessionToken: readCursorDashboardSessionToken,
  }),
  getCursorDashboardTokenSettings,
  setCursorDashboardTokenSettings,
  planUsageService,
  getCursorPlanAllowanceSettings,
  setCursorPlanAllowanceSettings,
  getGrokPlanAllowanceSettings,
  setGrokPlanAllowanceSettings,
  bootstrapRuntimeSessionBindings,
  SUPPORTED_RELAY_MODES,
  SUPPORTED_CONVERSATION_SESSION_MODES,
  DEFAULT_CONVERSATION_SESSION_MODE,
  DEFAULT_QUESTION_TIMEOUT_MS,
  questionExpiresAt,
  sanitizeRelayQuestionPrompt,
  sanitizeRelayQuestionRequest,
  sanitizeRelayQuestionContext,
  parseQuestionRequest,
  normalizeQuestionChoices,
  formatQuestionRow,
  parseBoardActions,
  formatRelayBoardRow,
  relayRestartOrchestrator,
  resolveSessionStateRoot,
  resolveClaudeSessionRoot: claudeSessionRootResolver.resolveClaudeSessionRoot,
  resolveCursorSessionRoot: cursorSessionRootResolver.resolveCursorSessionRoot,
  getTurnCeilingMinutes,
  setTurnCeilingMinutes,
  requestRelayShutdown,
  markSharedViewerPresence,
  getSharedWatcherCount,
  statusEventService,
  imageOperationService,
  windowsAutostartService,
  pushDispatchService,
};
registerMessagesRoutes(app, sharedRouteDeps);
registerSessionsRoutes(app, sharedRouteDeps);
registerAskUserRoutes(app, sharedRouteDeps);
registerRelayBoardRoutes(app, sharedRouteDeps);
registerCacheRoutes(app, sharedRouteDeps);
registerGitRoutes(app, sharedRouteDeps);
registerPushRoutes(app, {
  auth,
  pushDispatchService,
  getPushVapidPublicKey: () => pushVapidKeys.publicKey,
});
function markCliOffline(reason = 'offline', { clearOwner = true } = {}) {
  cliLastSeen = null;
  const wasOnline = cliOnline;
  cliOnline = false;
  if (clearOwner) {
    relayBridgeOwnerService.clearOwner();
  }
  relayRestartOrchestrator.noteCliOffline();
  if (wasOnline) {
    console.log(`${runtimeLogPrefix()}CLI OFFLINE${reason ? ` (${reason})` : ''}`);
    io.emit('cli_status', { online: false });
    void pushDispatchService.notifyCliOffline();
  }
}

function checkCliStatus() {
  const wasOnline = cliOnline;
  cliOnline = cliLastSeen !== null && (Date.now() - cliLastSeen) < 10_000;
  if (wasOnline !== cliOnline) {
    if (!cliOnline) {
      markCliOffline('heartbeat-timeout');
      return;
    }
    console.log(`${runtimeLogPrefix()}CLI ONLINE`);
    io.emit('cli_status', { online: true });
  }
}
runtimeTimers.cliStatus = setInterval(checkCliStatus, 2000);

if (managedOwnerPid) {
  runtimeTimers.ownerWatchdog = setInterval(() => {
    if (isProcessAlive(managedOwnerPid)) return;
    console.log(`${runtimeLogPrefix()}Owner process ${managedOwnerPid} is gone; shutting down managed relay.`);
    void shutdownRuntime(`owner-pid-missing:${managedOwnerPid}`);
  }, 3000);
}

// Auto-recover messages whose worker has gone silent (e.g. after a CLI crash).
//
// The window is measured from the last heartbeat that named the message, not
// from when the turn began, so a turn stays alive for as long as its worker
// keeps reporting it — however many minutes of tool calls and subagents that
// takes. The separate, user-configurable ceiling is the only elapsed-time cap,
// and both exempt a turn that is waiting on an unanswered question.
function recoverStaleMessages() {
  const staleWindowMs = cliOnline
    ? processingTimeoutMs
    : Math.min(processingTimeoutMs, OFFLINE_STALE_RECOVER_MS);
  const cutoff = new Date(Date.now() - staleWindowMs).toISOString();
  const ceilingMs = turnCeilingMinutesToMs(getTurnCeilingMinutes());
  const ceilingBeforeIso = ceilingMs > 0 ? new Date(Date.now() - ceilingMs).toISOString() : null;
  const requeueAt = addMsIso(cliOnline ? 30_000 : 2_000);
  const recoveredRows = recoverProcessingOlderThan(cutoff, requeueAt, { ceilingBeforeIso });
  if (recoveredRows.length > 0) {
    const ceilingNote = ceilingBeforeIso ? `, ceiling ${Math.round(ceilingMs / 60_000)}min` : '';
    console.log(
      `${runtimeLogPrefix()}Recovered ${recoveredRows.length} stale message(s) after ${Math.round(staleWindowMs / 1000)}s without worker activity${ceilingNote} (cliOnline=${cliOnline})`
    );
  }
}
runtimeTimers.staleRecovery = setInterval(recoverStaleMessages, 15_000);
recoverStaleMessages(); // run immediately on startup

function expirePendingQuestions() {
  const now = new Date().toISOString();
  const result = stmts.expireQuestions.run(now);
  if (result.changes > 0) {
    console.log(`${runtimeLogPrefix()}Timed out ${result.changes} relay question(s)`);
    io.emit('relay_question_changed', { expired: result.changes });
  }
}
runtimeTimers.questionExpiry = setInterval(expirePendingQuestions, 10_000);
expirePendingQuestions();
runtimeTimers.sharedViewerPrune = setInterval(pruneSharedViewerPresence, 5_000);
if (typeof runtimeTimers.sharedViewerPrune.unref === 'function') runtimeTimers.sharedViewerPrune.unref();
const sweptUploads = sweepUnreferencedUploadBlobs();
if (sweptUploads > 0) {
  console.log(`${runtimeLogPrefix()}Reclaimed ${sweptUploads} unreferenced upload(s)`);
}
runtimeTimers.uploadSweep = setInterval(sweepUnreferencedUploadBlobs, 6 * 60 * 60 * 1000);
if (typeof runtimeTimers.uploadSweep.unref === 'function') runtimeTimers.uploadSweep.unref();
const runtimeBindingsBootstrapped = bootstrapRuntimeSessionBindings();
if (runtimeBindingsBootstrapped > 0) {
  console.log(`${runtimeLogPrefix()}Runtime sessions bootstrapped: ${runtimeBindingsBootstrapped}`);
}

function ts() { return new Date().toISOString().slice(11, 23); }
function runtimeLogPrefix() {
  return ttyConsoleRuntime?.tty ? '' : `[${ts()}] `;
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const secureAttr = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https'
    ? '; Secure'
    : '';
  const token =
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    req.body?.token ||
    cookies[AUTH_COOKIE];
  if (token === config.authToken) {
    if (res && cookies[AUTH_COOKIE] !== config.authToken) {
      appendSetCookie(res, `${AUTH_COOKIE}=${encodeURIComponent(config.authToken)}; Path=${COOKIE_PATH}; Max-Age=2592000; SameSite=Lax; HttpOnly${secureAttr}`);
    }
    return next();
  }
  if (res && cookies[AUTH_COOKIE]) {
    appendSetCookie(res, `${AUTH_COOKIE}=; Path=${COOKIE_PATH}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly${secureAttr}`);
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getOrCreateConversation(id, firstLine) {
  const now = new Date().toISOString();
  stmts.insertConv.run(id, (firstLine || 'Untitled').slice(0, 80), now, now);
  return stmts.getConv.get(id);
}

function ensureRuntimeSessionBinding(
  conversationId,
  model,
  nowIso = new Date().toISOString(),
  sdkSessionId = null,
  { assignConfiguredProvider = false, providerType = '', providerModel = null } = {},
) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) return null;
  const normalizedModel = String(model || '').trim() || null;
  const normalizedSdkSessionId = String(sdkSessionId || '').trim() || null;
  if (normalizedSdkSessionId) {
    stmts.setConvSdkSessionIdIfMissing.run(normalizedConversationId, nowIso, normalizedSdkSessionId);
  }
  const existing = stmts.getRuntimeSessionByConversation.get(normalizedConversationId);
  if (existing?.id) {
    stmts.touchRuntimeSession.run(normalizedModel, nowIso, existing.id);
    if (normalizedSdkSessionId) {
      stmts.setRuntimeSessionSdkSessionIdIfMissing.run(normalizedSdkSessionId, nowIso, existing.id);
    }
    return stmts.getRuntimeSessionById.get(existing.id);
  }

  if (normalizedSdkSessionId) {
    const existingBySdkSessionId = stmts.getRuntimeSessionBySdkSessionId.get(normalizedSdkSessionId);
    if (existingBySdkSessionId?.id) {
      stmts.touchRuntimeSession.run(normalizedModel, nowIso, existingBySdkSessionId.id);
      return stmts.getRuntimeSessionById.get(existingBySdkSessionId.id);
    }
  }

  const runtimeSessionId = uuidv4();
  const strategy = configuredConversationSessionMode;
  const runtimeKey = runtimeSessionId;
  const openAISettings = assignConfiguredProvider ? getOpenAIProviderSettings() : null;
  const normalizedRequestedProviderType = String(providerType || '').trim().toLowerCase();
  const resolvedProviderType = normalizedRequestedProviderType === 'openai'
    ? 'openai'
    : (normalizedRequestedProviderType === 'claude'
      ? 'claude'
      : (normalizedRequestedProviderType === 'cursor'
        ? 'cursor'
        : (normalizedRequestedProviderType === 'grok'
          ? 'grok'
          : (normalizedRequestedProviderType === 'github'
            ? 'github'
            : (openAISettings?.enabled ? 'openai' : 'github')))));
  const resolvedProviderModel = (resolvedProviderType === 'openai' || resolvedProviderType === 'claude' || resolvedProviderType === 'cursor' || resolvedProviderType === 'grok')
    ? (String(providerModel || normalizedModel || '').trim() || null)
    : null;
  try {
    const insertArgs = [
      runtimeSessionId,
      normalizedConversationId,
      strategy,
      runtimeKey,
      normalizedModel,
      nowIso,
      nowIso,
      normalizedSdkSessionId,
    ];
    if (stmts.runtimeSessionsSupportProviders) insertArgs.push(resolvedProviderType, resolvedProviderModel);
    stmts.insertRuntimeSession.run(...insertArgs);
  } catch (error) {
    if (String(error?.code || '') !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
    const byConversation = stmts.getRuntimeSessionByConversation.get(normalizedConversationId);
    if (byConversation?.id) {
      stmts.touchRuntimeSession.run(normalizedModel, nowIso, byConversation.id);
      if (normalizedSdkSessionId) {
        stmts.setRuntimeSessionSdkSessionIdIfMissing.run(normalizedSdkSessionId, nowIso, byConversation.id);
      }
      return stmts.getRuntimeSessionById.get(byConversation.id);
    }
    if (normalizedSdkSessionId) {
      const bySdkSessionId = stmts.getRuntimeSessionBySdkSessionId.get(normalizedSdkSessionId);
      if (bySdkSessionId?.id) {
        stmts.touchRuntimeSession.run(normalizedModel, nowIso, bySdkSessionId.id);
        return stmts.getRuntimeSessionById.get(bySdkSessionId.id);
      }
    }
    throw error;
  }
  return stmts.getRuntimeSessionById.get(runtimeSessionId);
}

function bootstrapRuntimeSessionBindings() {
  const missing = stmts.listConvIdsMissingRuntimeSession.all();
  const now = new Date().toISOString();
  let bootstrapped = 0;
  const tx = db.transaction(() => {
    for (const row of missing) {
      const conversationId = row?.id;
      if (!conversationId) continue;
      const latestModel = stmts.getLatestConversationModel.get(conversationId)?.model || null;
      ensureRuntimeSessionBinding(conversationId, latestModel, now);
      bootstrapped += 1;
    }
  });
  tx();
  return bootstrapped;
}

function emitToClientsExceptSessionId(event, payload, sessionId) {
  if (!sessionId) {
    io.emit(event, payload);
    return;
  }

  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.sessionId === sessionId) continue;
    socket.emit(event, payload);
  }
}

// ─── Web-Client Routes ────────────────────────────────────────────────────────




// ─── CLI Routes ───────────────────────────────────────────────────────────────

function touchCli() {
  cliLastSeen = Date.now();
  relayRestartOrchestrator.noteCliOnline();
  if (!cliOnline) {
    cliOnline = true;
    console.log(`${runtimeLogPrefix()}CLI ONLINE (heartbeat)`);
    io.emit('cli_status', { online: true });
  }
}
sessionWorkerWebSocketService.start();
void primePendingSessionWorkers('startup');
runtimeTimers.pendingWorkerPrime = setInterval(() => {
  void primePendingSessionWorkers('maintenance');
}, 5_000);
if (typeof runtimeTimers.pendingWorkerPrime.unref === 'function') runtimeTimers.pendingWorkerPrime.unref();

// POST /api/heartbeat — CLI sends a ping every poll interval

// ─── Relay Question Routes ────────────────────────────────────────────────────

function questionExpiresAt(createdAt, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS) {
  const normalizedTimeoutMs = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Math.trunc(Number(timeoutMs)))
    : DEFAULT_QUESTION_TIMEOUT_MS;
  return new Date(new Date(createdAt).getTime() + normalizedTimeoutMs).toISOString();
}

function sanitizeRelayQuestionPrompt(requestBody) {
  const prompt = String(
    requestBody?.prompt ||
    requestBody?.text ||
    requestBody?.message ||
    requestBody?.question ||
    requestBody?.content ||
    ''
  ).trim();
  if (prompt) return prompt;
  const keys = requestBody && typeof requestBody === 'object' ? Object.keys(requestBody).slice(0, 8) : [];
  return keys.length ? `Clarification needed (${keys.join(', ')})` : 'Clarification needed';
}

function sanitizeRelayQuestionRequest(requestBody) {
  if (!requestBody) return null;
  if (typeof requestBody === 'string') return requestBody;
  if (typeof requestBody !== 'object') return null;
  try {
    return JSON.stringify(requestBody);
  } catch {
    return null;
  }
}

function sanitizeRelayQuestionContext(rawContext) {
  if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) return null;
  const context = {};
  if (typeof rawContext.source === 'string' && rawContext.source.trim()) {
    context.source = rawContext.source.trim().slice(0, 64);
  }
  if (typeof rawContext.rationale === 'string' && rawContext.rationale.trim()) {
    context.rationale = rawContext.rationale.trim().slice(0, 240);
  }
  if (typeof rawContext.queueMessageId === 'string' && rawContext.queueMessageId.trim()) {
    context.queueMessageId = rawContext.queueMessageId.trim();
  }
  if (typeof rawContext.conversationId === 'string' && rawContext.conversationId.trim()) {
    context.conversationId = rawContext.conversationId.trim();
  }
  if (typeof rawContext.relayMode === 'string' && rawContext.relayMode.trim()) {
    context.relayMode = normalizeRelayMode(rawContext.relayMode) || DEFAULT_RELAY_MODE;
  }
  return Object.keys(context).length ? context : null;
}


// ─── Socket.io Auth ───────────────────────────────────────────────────────────
io.use((socket, next) => {
  const cookies = parseCookies(socket.request.headers.cookie);
  const token = socket.handshake.auth?.token || socket.handshake.query?.token || cookies[AUTH_COOKIE];
  if (token === config.authToken) return next();
  next(new Error('Unauthorized'));
});

io.engine.on('initial_headers', (headers, req) => {
  const sessionId = ensureSessionId(req);
  headers['Set-Cookie'] = `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=${COOKIE_PATH}; SameSite=Lax`;
});

io.on('connection', (socket) => {
  const cookies = parseCookies(socket.request.headers.cookie);
  socket.data.sessionId = socket.handshake.auth?.clientId || socket.handshake.query?.clientId || cookies[SESSION_COOKIE] || null;
  // Liveness probe ack for verifySocketLiveness() in public/app/socket-handlers.js:
  // a PWA resuming from an Android freeze pings before trusting a socket that
  // still claims to be connected.
  socket.on('client_ping', (ack) => {
    if (typeof ack === 'function') ack({ ok: true });
  });
  // Send current CLI status immediately on connect
  socket.emit('cli_status', { online: cliOnline });
  // Visibility heartbeats for push suppression; also clears a stale
  // deviceVisible flag restored by connectionStateRecovery.
  activeDeviceTracker.registerSocket(socket);
  tmuxInspectorSocketService.registerSocket(socket);
});

// ─── SSH Reverse Tunnel ────────────────────────────────────────────────────────
const sshTunnelManager = createSshTunnelManager({
  tunnelConfig: config.sshTunnel || {},
  localPort: config.port || 3333,
  runtimeLogPrefix,
  io,
  logger: console,
  runtimeShutdownRef: () => runtimeShutdownStarted,
  configBaseDir: __dirname,
});
const tunnelState = sshTunnelManager.state;
runtimeState.tunnelState = tunnelState;

// ─── Cloudflare Tunnel ────────────────────────────────────────────────────────
// Independent of the SSH tunnel above; both modes may run simultaneously.
const cloudflaredTunnelManager = createCloudflaredTunnelManager({
  tunnelConfig: config.cloudflaredTunnel || {},
  runtimeLogPrefix,
  io,
  logger: console,
  runtimeShutdownRef: () => runtimeShutdownStarted,
  configBaseDir: __dirname,
});
runtimeState.cloudflaredTunnelState = cloudflaredTunnelManager.state;

function clearRuntimeTimers() {
  for (const timer of Object.values(runtimeTimers)) {
    if (!timer) continue;
    try { clearInterval(timer); } catch {}
  }
  runtimeTimers.cliStatus = null;
  runtimeTimers.ownerWatchdog = null;
  runtimeTimers.staleRecovery = null;
  runtimeTimers.questionExpiry = null;
  runtimeTimers.pendingWorkerPrime = null;
  runtimeTimers.sharedViewerPrune = null;
  runtimeTimers.shutdownDrain = null;
}

let runtimeShutdownPromise = null;
let runtimeShutdownExitCode = 0;
function shutdownRuntime(reason = 'unknown', { exitCode = 0 } = {}) {
  if (runtimeShutdownPromise) return runtimeShutdownPromise;

  const numericExitCode = Number(exitCode);
  runtimeShutdownExitCode = Number.isInteger(numericExitCode) && numericExitCode >= 0
    ? numericExitCode
    : 0;
  runtimeShutdownStarted = true;
  console.log(`${runtimeLogPrefix()}Runtime shutdown started (${reason}, exitCode=${runtimeShutdownExitCode})`);
  clearRuntimeTimers();
  void sdkSessionImportService.dispose().catch((error) => {
    console.warn(`${runtimeLogPrefix()}SDK session importer shutdown failed: ${error?.message || error}`);
  });
  sessionWorkerWebSocketService.stop();
  tmuxInspectorSocketService.stop();
  stopWorkspaceFileWatcher();
  sshTunnelManager.stop();
  cloudflaredTunnelManager.stop();
  try { relaySingletonGuard.release(); } catch (error) {
    console.warn(`${runtimeLogPrefix()}Failed to release singleton lock: ${error?.message || error}`);
  }

  runtimeShutdownPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
      process.exit(runtimeShutdownExitCode);
    };

    const forceExitTimer = setTimeout(() => {
      console.warn(`${runtimeLogPrefix()}Runtime shutdown timeout reached; forcing exit.`);
      finish();
    }, 2000);
    if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

    const closeTransports = () => {
      try { io.close(); } catch {}

      try {
        httpServer.close(() => {
          try { clearTimeout(forceExitTimer); } catch {}
          finish();
        });
      } catch {
        try { clearTimeout(forceExitTimer); } catch {}
        finish();
      }
    };

    // io.close() disconnects clients immediately. A turn that finishes moments
    // before an idle-deferred restart emits its terminal message_status right as
    // we tear down, so give queued frames a beat to reach the browser. Well
    // inside the 2s force-exit budget above.
    // Deliberately not unref'd: this timer must fire for the process to exit
    // cleanly. The unref'd force-exit timer above is the backstop if it does not.
    setTimeout(closeTransports, SHUTDOWN_SOCKET_FLUSH_MS);
  });

  return runtimeShutdownPromise;
}

function detectLocalIpv4() {
  let localIp = '<your-pc-ip>';
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces || {})) {
      for (const iface of (ifaces[name] || [])) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIp = iface.address;
          return localIp;
        }
      }
    }
  } catch {}
  return localIp;
}

function buildRelayReadyBannerData() {
  const localIp = detectLocalIpv4();
  const localUrl = `http://localhost:${config.port}/`;
  const networkUrl = localhostOnly ? null : `http://${String(localIp).slice(0, 15)}:${config.port}/`;
  const networkText = localhostOnly ? 'disabled (localhost only)' : networkUrl;
  const tunnelActive = tunnelState.enabled === true && tunnelState.mode === 'managed';
  const remoteUrl = tunnelActive ? `https://${String(tunnelState.host || '').slice(0, 30)}/` : null;
  const pollingUrl = `http://localhost:${config.port}/api/pending`;
  const authText = 'token required';

  return {
    title: 'Copilot Web Proxy  -  Ready',
    localUrl,
    networkUrl,
    networkText,
    remoteUrl,
    remoteBindMode: tunnelState.remoteBindMode,
    authText,
    pollingUrl,
    localhostOnly,
    listenHost,
    lines: [
      '╔══════════════════════════════════════════════════════════════╗',
      '║         Copilot Web Proxy  -  Ready                          ║',
      '╠══════════════════════════════════════════════════════════════╣',
      `║  Local:      ${localUrl.padEnd(47)} ║`,
      `║  Network:    ${String(networkText || '').padEnd(47)} ║`,
      ...(remoteUrl ? [`║  Remote:     ${remoteUrl.padEnd(47)} ║`] : []),
      ...(remoteUrl ? [`║  Tunnel:     ${(`mode=${tunnelState.remoteBindMode}`).padEnd(47)} ║`] : []),
      `║  Auth:       ${authText.padEnd(47)} ║`,
      '╠══════════════════════════════════════════════════════════════╣',
      '║  CLI polling URL (for monitoring mode):                      ║',
      `║  GET:        ${pollingUrl.padEnd(47)} ║`,
      '╚══════════════════════════════════════════════════════════════╝',
    ],
  };
}

// Graceful shutdown: stop timers/tunnel and release listener deterministically.
process.on('SIGTERM', () => { void shutdownRuntime('SIGTERM'); });
process.on('SIGINT',  () => { void shutdownRuntime('SIGINT'); });
process.on('exit', () => {
  try { relaySingletonGuard.release(); } catch {}
});

// ─── Start ────────────────────────────────────────────────────────────────────
httpServer.on('error', (error) => {
  console.error(`[server] HTTP server failed: ${error?.message || error}`);
  try { relaySingletonGuard.release(); } catch {}
  process.exit(1);
});
httpServer.listen(config.port, listenHost, () => {
  const readyBanner = buildRelayReadyBannerData();
  console.log('');
  for (const line of (readyBanner.lines || [])) {
    console.log(line);
  }
  console.log('\nCLI status: waiting for first heartbeat...\n');

  // Start SSH tunnel after server is listening
  sshTunnelManager.start();
  cloudflaredTunnelManager.start();
  void sdkSessionImportService.runStartupImport().catch((error) => {
    console.warn(`${runtimeLogPrefix()}SDK session import startup failed: ${error?.message || error}`);
  });
});
