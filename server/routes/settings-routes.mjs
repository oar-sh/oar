'use strict';

// The settings routes (/api/settings/*) and the OpenAI image presets,
// registered by registerSessionsRoutes.
import { describeWindowsAutostart, handMadeLines, switchBlockers } from '../services/windows-boot-autostart-service.mjs';
import {
  claudeBackgroundCommandLimitSettingsFields,
  parseClaudeBackgroundCommandLimitUpdate,
} from '../../shared/claude-background-command-limit.mjs';
import { CLAUDE_ATTRIBUTION_MODES, DEFAULT_CLAUDE_ATTRIBUTION_MODE, claudeAttributionModelLabel, claudeAttributionTrailer, normalizeClaudeAttributionMode } from '../../shared/claude-attribution.mjs';
import { parseDeepSeekSettingsUpdateRequest } from '../services/deepseek-settings-service.mjs';
import {
  copilotSettingsPayload,
  parseCopilotSettingsUpdateRequest,
  writeCopilotEnabled,
} from '../services/copilot-settings-service.mjs';
import {
  CLAUDE_API_PROVIDER_TYPE,
  parseClaudeApiSettingsUpdateRequest,
} from '../services/claude-api-settings-service.mjs';
import {
  DEEPSEEK_PROVIDER_TYPE,
} from '../../shared/deepseek-models.mjs';
import { readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { notPerson } from '../services/relay-principal.mjs';
import {
  isSafeClaudeModelId,
  isSafeCursorModelId,
  isSafeGrokModelId,
  isSafeProviderModelId,
} from '../../shared/model-id.mjs';
import {
  pickOpenAIImageDefaultModel,
} from '../../shared/openai-image-options.mjs';
import {
  OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD,
  OPENAI_IMAGE_PRESETS_PATH,
  OPENAI_IMAGE_SETTINGS_FIELDS,
  OPENAI_IMAGE_SPEND_SETTING_KEYS,
} from '../../shared/openai-image-spend.mjs';
import {
  OPENAI_IMAGE_PRESET_REFUSED_CODE,
  OPENAI_IMAGE_PRESETS_SETTING_KEY,
  applyOwnOpenAIImagePresetChange,
  listOpenAIImagePresets,
  parseOwnOpenAIImagePresets,
} from '../../shared/openai-image-presets.mjs';
import {
  DEFAULT_TURN_CEILING_MINUTES,
  TURN_CEILING_MAX_MINUTES,
  TURN_CEILING_MIN_MINUTES,
  TURN_CEILING_STEP_MINUTES,
  parseTurnCeilingUpdate,
} from '../../shared/turn-ceiling.mjs';
import {
  DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS,
  SUBAGENT_RECORD_RETENTION_CHOICES,
  parseSubagentRecordRetentionUpdate,
} from '../../shared/subagent-record-retention.mjs';
import {
  DEFAULT_SHARE_PATH_PRIVACY_MODE,
  SHARE_PATH_PRIVACY_LABELS,
  SHARE_PATH_PRIVACY_MODES,
  parseSharePathPrivacyUpdate,
} from '../../shared/share-path-privacy.mjs';
import {
  DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES,
  BACKGROUND_TASK_TIMEOUT_MAX_MINUTES,
  BACKGROUND_TASK_TIMEOUT_MIN_MINUTES,
  BACKGROUND_TASK_TIMEOUT_STEP_MINUTES,
  parseBackgroundTaskTimeoutUpdate,
} from '../../shared/background-task-timeout.mjs';
import {
  DEFAULT_TASK_STALL_MINUTES,
  TASK_STALL_MINUTES_MAX,
  TASK_STALL_MINUTES_MIN,
  parseTaskStallMinutesUpdate,
} from '../../shared/task-output-text.mjs';
import {
  PWA_APP_NAME_DEFAULT,
  PWA_APP_NAME_MAX_LENGTH,
  derivePwaShortName,
} from '../../shared/pwa-app-name.mjs';
import { parseRestartResumeUpdate } from '../services/restart-resume-service.mjs';
import { deepseekStartingBalanceNote } from '../services/plan-usage-deepseek.mjs';
import { stopIdleWorkspaceRootSession } from './sessions-helpers.mjs';

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
  const hasEnabledModels = Array.isArray(payload.enabledModels);
  const hasAutoEnableNew = typeof payload.autoEnableNew === 'boolean';
  if (!remove && !hasModel && !apiKey && !hasEnabled && !hasBaseUrl && !hasEnabledModels && !hasAutoEnableNew) {
    // `empty`: the body may still carry the image cap fields alone.
    return { ok: false, empty: true, error: 'No OpenAI settings update provided' };
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
    ...(hasEnabledModels ? { enabledModels: payload.enabledModels } : {}),
    ...(hasAutoEnableNew ? { autoEnableNew: payload.autoEnableNew } : {}),
    ...(Array.isArray(payload.shownModels) ? { shownModels: payload.shownModels } : {}),
    enabled: hasEnabled ? payload.enabled : (apiKey ? true : undefined),
  };
}

// The highest daily cap of OpenAI image spend the settings take, in USD.
export const OPENAI_IMAGE_DAILY_CAP_MAX_USD = 10_000;

/**
 * The image cap fields of POST /api/settings/openai: `imageDailyCapUsd` (USD,
 * 0 to OPENAI_IMAGE_DAILY_CAP_MAX_USD, to the cent; 0 or null: no cap) and
 * `allowImagesToday` (true sets the owner's override for the relay's day,
 * false clears it). `{ ok, present, dailyCapUsd?, allowToday? }`, or
 * `{ ok:false, present:true, error }`.
 */
export function parseOpenAIImageSpendSettingsRequest(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const capField = OPENAI_IMAGE_SETTINGS_FIELDS.dailyCapUsd;
  const allowField = OPENAI_IMAGE_SETTINGS_FIELDS.allowToday;
  const hasCap = payload[capField] !== undefined;
  const hasAllow = payload[allowField] !== undefined;
  if (!hasCap && !hasAllow) return { ok: true, present: false };
  const result = { ok: true, present: true };
  if (hasCap) {
    const raw = payload[capField];
    const number = raw === null ? 0 : (typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : raw);
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > OPENAI_IMAGE_DAILY_CAP_MAX_USD) {
      return { ok: false, present: true, error: `${capField} must be a number of USD from 0 (no cap) to ${OPENAI_IMAGE_DAILY_CAP_MAX_USD}` };
    }
    result.dailyCapUsd = Math.round(number * 100) / 100;
  }
  if (hasAllow) {
    if (typeof payload[allowField] !== 'boolean') return { ok: false, present: true, error: `${allowField} must be true or false` };
    result.allowToday = payload[allowField];
  }
  return result;
}

export function parseClaudeSettingsUpdateRequest(body = {}) {
  const payload = body && typeof body === 'object' ? body : {};
  const hasEnabled = typeof payload.enabled === 'boolean';
  const hasModel = Object.prototype.hasOwnProperty.call(payload, 'model');
  const model = hasModel ? (String(payload.model || '').trim() || 'claude-sonnet-5') : undefined;
  const hasModels = Array.isArray(payload.models);
  const hasEnabledModels = Array.isArray(payload.enabledModels);
  const hasAutoEnableNew = typeof payload.autoEnableNew === 'boolean';
  const hasAttributionMode = Object.prototype.hasOwnProperty.call(payload, 'attributionMode');
  const attributionMode = hasAttributionMode ? normalizeClaudeAttributionMode(payload.attributionMode) : undefined;
  const hasBackgroundCommandLimit = Object.prototype.hasOwnProperty.call(payload, 'backgroundCommandLimitMinutes');
  const backgroundCommandLimit = hasBackgroundCommandLimit
    ? parseClaudeBackgroundCommandLimitUpdate(payload.backgroundCommandLimitMinutes)
    : null;
  if (!hasEnabled && !hasModel && !hasModels && !hasEnabledModels && !hasAutoEnableNew && !hasAttributionMode && !hasBackgroundCommandLimit) {
    return { ok: false, error: 'No Claude settings update provided' };
  }
  if (backgroundCommandLimit && !backgroundCommandLimit.ok) {
    return { ok: false, error: backgroundCommandLimit.error };
  }
  if (hasModel && !isSafeClaudeModelId(model)) {
    return { ok: false, error: 'Invalid Claude model ID' };
  }
  if (hasAttributionMode && !attributionMode) {
    return { ok: false, error: `Invalid Claude attribution mode (one of ${CLAUDE_ATTRIBUTION_MODES.join(', ')})` };
  }
  return {
    ok: true,
    ...(hasEnabled ? { enabled: payload.enabled } : {}),
    ...(hasModel ? { model } : {}),
    ...(hasModels ? { models: payload.models } : {}),
    ...(hasEnabledModels ? { enabledModels: payload.enabledModels } : {}),
    ...(hasAutoEnableNew ? { autoEnableNew: payload.autoEnableNew } : {}),
    ...(Array.isArray(payload.shownModels) ? { shownModels: payload.shownModels } : {}),
    ...(hasAttributionMode ? { attributionMode } : {}),
    // Clamped to 30 min … 8 h and snapped to 30-minute steps.
    ...(backgroundCommandLimit ? { backgroundCommandLimitMinutes: backgroundCommandLimit.minutes } : {}),
  };
}

/** The attribution fields every Claude settings payload carries, with the trailer the default model would get. */
export function claudeAttributionSettingsFields(settings = {}) {
  const attributionMode = normalizeClaudeAttributionMode(settings?.attributionMode) || DEFAULT_CLAUDE_ATTRIBUTION_MODE;
  const model = String(settings?.model || 'claude-sonnet-5').trim() || 'claude-sonnet-5';
  return {
    attributionMode,
    attributionModes: [...CLAUDE_ATTRIBUTION_MODES],
    attributionExample: claudeAttributionTrailer(claudeAttributionModelLabel(model)),
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
  const hasAutoEnableNew = typeof payload.autoEnableNew === 'boolean';
  if (!remove && !hasModel && !apiKey && !hasEnabled && !hasEnabledModels && !hasAutoEnableNew) {
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
    ...(hasAutoEnableNew ? { autoEnableNew: payload.autoEnableNew } : {}),
    ...(Array.isArray(payload.shownModels) ? { shownModels: payload.shownModels } : {}),
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
  const hasAutoEnableNew = typeof payload.autoEnableNew === 'boolean';
  if (!hasEnabled && !hasModel && !hasModels && !hasEnabledModels && !hasAutoEnableNew) {
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
    ...(hasAutoEnableNew ? { autoEnableNew: payload.autoEnableNew } : {}),
    ...(Array.isArray(payload.shownModels) ? { shownModels: payload.shownModels } : {}),
  };
}

// `deps` is the object registerSessionsRoutes gets; `shared` carries what it
// resolved itself (its closures and the dependencies with a default it uses too).
export function registerSettingsRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    workspaceRootPayload,
    setDefaultSessionWorkspaceRootPath,
    setOpenAIProviderSettings = () => ({ ok: false, error: 'OpenAI settings are unavailable' }),
    getCopilotProviderSettings = () => ({ engine: 'sdk', engines: ['sdk'] }),
    copilotModelDiscoveryService = null,
    detectCopilotCli = null,
    setClaudeProviderSettings = () => ({ ok: false, error: 'Claude settings are unavailable' }),
    setCursorProviderSettings = () => ({ ok: false, error: 'Cursor settings are unavailable' }),
    setGrokProviderSettings = () => ({ ok: false, error: 'Grok settings are unavailable' }),
    // Asks whether the cap flipped after the Claude API settings changed.
    checkClaudeApiCap = () => {},
    // The once-per-episode notes for stopped self-started turns on the key
    // (plan-usage-claude-api.mjs): a saved setting starts every chat afresh.
    claudeApiStopLedger = null,
    notifyOpenAIImageSpendChanged = () => {},
    setCursorDashboardTokenSettings = () => ({ ok: false, error: 'Cursor dashboard token settings are unavailable' }),
    setCursorPlanAllowanceSettings = () => ({ ok: false, error: 'Cursor allowance settings are unavailable' }),
    setGrokPlanAllowanceSettings = () => ({ ok: false, error: 'Grok allowance settings are unavailable' }),
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
    sessionWorkerProcessInspector,
    getTurnCeilingMinutes = () => DEFAULT_TURN_CEILING_MINUTES,
    setTurnCeilingMinutes = () => ({ ok: false, error: 'Turn ceiling settings are unavailable' }),
    getSubagentRecordRetentionDays = () => DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS,
    setSubagentRecordRetentionDays = () => ({ ok: false, error: 'Sub-agent record settings are unavailable' }),
    setSharePathPrivacyMode = () => ({ ok: false, error: 'Path privacy settings are unavailable' }),
    getPwaAppName = () => '',
    setPwaAppName = () => ({ ok: false, status: 500, error: 'App name settings are unavailable' }),
    getBackgroundTaskTimeoutMinutes = () => DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES,
    setBackgroundTaskTimeoutMinutes = () => ({ ok: false, error: 'Background task timeout settings are unavailable' }),
    setTaskStallMinutes = () => ({ ok: false, error: 'Task stall settings are unavailable' }),
    getRestartResumeEnabled = () => false,
    setRestartResumeEnabled = () => ({ ok: false, error: 'Restart settings are unavailable' }),
    windowsAutostartService,
    windowsBootAutostartService,
  } = deps;
  const {
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
    isCopilotEnabled = () => true,
  } = shared;

  app.get('/api/settings/shares', auth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ storeViewerIp: shares().readStoreViewerIp() });
  });

  // "Store viewer IP addresses": off keeps the address out of new access log
  // rows and out of the status events of shared reads. Rows logged before
  // keep theirs.
  app.post('/api/settings/shares', auth, (req, res) => {
    if (typeof req.body?.storeViewerIp !== 'boolean') {
      return res.status(400).json({ error: 'storeViewerIp must be true or false' });
    }
    const storeViewerIp = shares().writeStoreViewerIp(req.body.storeViewerIp);
    io.emit('share_settings_changed', { storeViewerIp });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ storeViewerIp });
  });

  // The viewer addresses stored before IP storage was switched off: how many,
  // and removing them (Settings → Sharing offers it when the switch goes off).
  app.get('/api/settings/shares/stored-viewer-ips', auth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ count: shares().countStoredViewerIps() });
  });

  app.delete('/api/settings/shares/stored-viewer-ips', auth, (_req, res) => {
    const cleared = shares().forgetStoredViewerIps();
    io.emit('share_viewer_ips_forgotten', cleared);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, cleared, count: shares().countStoredViewerIps() });
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

  // ─── OpenAI image spend: the daily cap and the owner's override ─────────────
  // app_settings values here are JSON; a bare string reads as itself.
  const readJsonAppSetting = (key) => {
    let row = null;
    try {
      row = stmts.getAppSetting?.get?.(key) || null;
    } catch {
      row = null;
    }
    if (!row || row.value === null || row.value === undefined) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  };
  // The relay's local day, the one image spend is booked and capped by.
  const relayLocalDay = () => {
    try {
      const day = String(tokenUsageService?.localDay?.() || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
    } catch {}
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  };
  /**
   * The cap fields every OpenAI settings answer carries: `imageDailyCapUsd`
   * (USD; 0 = no cap; never saved = the default), `imagesAllowedToday` (the
   * owner allowed image turns past the cap for the relay's current day) and
   * `imagesAllowedAt` (when, while it holds).
   */
  const openAIImageSpendSettingsPayload = () => {
    const stored = readJsonAppSetting(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd);
    const cap = stored === undefined ? OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD : Number(stored);
    const allowed = readJsonAppSetting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay) === relayLocalDay();
    const allowedAt = allowed ? readJsonAppSetting(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideAt) : null;
    return {
      // An unreadable value is the default, never "no cap".
      imageDailyCapUsd: Number.isFinite(cap) && cap >= 0 ? cap : OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD,
      imagesAllowedToday: allowed,
      imagesAllowedAt: allowed && typeof allowedAt === 'string' ? allowedAt : null,
    };
  };
  /** Writes the parsed cap fields together; throws when the settings cannot be written. */
  const writeOpenAIImageSpendSettings = (change) => {
    if (typeof stmts?.upsertAppSetting?.run !== 'function' || typeof stmts?.deleteAppSetting?.run !== 'function') {
      throw new Error('OpenAI image settings are unavailable');
    }
    const nowIso = new Date().toISOString();
    db.transaction(() => {
      if (change.dailyCapUsd !== undefined) {
        stmts.upsertAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.dailyCapUsd, JSON.stringify(change.dailyCapUsd), nowIso);
      }
      // Changing the cap keeps the override; only the switch sets or ends it.
      if (change.allowToday === true) {
        stmts.upsertAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay, JSON.stringify(relayLocalDay()), nowIso);
        stmts.upsertAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideAt, JSON.stringify(nowIso), nowIso);
      } else if (change.allowToday === false) {
        stmts.deleteAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideDay);
        stmts.deleteAppSetting.run(OPENAI_IMAGE_SPEND_SETTING_KEYS.overrideAt);
      }
    })();
    try {
      notifyOpenAIImageSpendChanged();
    } catch {}
  };

  app.get('/api/settings/openai', auth, (_req, res) => {
    const settings = getOpenAIProviderSettings();
    return res.json({
      configured: settings?.configured === true,
      enabled: settings?.enabled === true,
      model: String(settings?.model || 'gpt-4o').trim() || 'gpt-4o',
      baseUrl: String(settings?.baseUrl || 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
      // What New Chat preselects for an OpenAI Image chat (null: no image model on).
      imageDefaultModel: settings?.enabled === true
        ? (pickOpenAIImageDefaultModel([settings.model, ...(Array.isArray(settings.models) ? settings.models : [])]) || null)
        : null,
      ...openAIImageSpendSettingsPayload(),
    });
  });

  app.post('/api/settings/openai', auth, async (req, res) => {
    // The image cap and "Allow for today" are the owner's alone: an agent of
    // this relay or a paired one could lift the cap on itself. Nothing of the
    // request is applied then.
    const imageSpend = parseOpenAIImageSpendSettingsRequest(req.body);
    if (imageSpend.present && notPerson(req, readRemoteRelayRequest(req, remoteRelayInbound))) {
      return res.status(403).json({ error: 'The OpenAI image cap and "Allow for today" are this relay\'s owner\'s settings alone.' });
    }
    if (!imageSpend.ok) return res.status(400).json({ error: imageSpend.error });
    const parsed = parseOpenAISettingsUpdateRequest(req.body);
    if (!parsed.ok && !(parsed.empty && imageSpend.present)) return res.status(400).json({ error: parsed.error });
    if (!parsed.ok) {
      // The cap fields alone: the provider settings stay as they are.
      try {
        writeOpenAIImageSpendSettings(imageSpend);
      } catch (error) {
        return res.status(500).json({ error: String(error?.message || error) });
      }
      const current = getOpenAIProviderSettings();
      const payload = {
        configured: current?.configured === true,
        enabled: current?.enabled === true,
        model: String(current?.model || 'gpt-4o').trim() || 'gpt-4o',
        baseUrl: String(current?.baseUrl || 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
        ...openAIImageSpendSettingsPayload(),
      };
      io.emit('openai_settings_updated', payload);
      return res.json({ ok: true, ...payload, models: [], warning: null });
    }
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
    let imageSpendError = null;
    if (imageSpend.present) {
      try {
        writeOpenAIImageSpendSettings(imageSpend);
      } catch (error) {
        imageSpendError = `The image cap was not saved: ${String(error?.message || error)}`;
      }
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
    // A removed key moves no chat: an empty OpenAI chat keeps its provider.
    const currentSettings = getOpenAIProviderSettings();
    const settingsPayload = {
      configured: currentSettings?.configured === true,
      enabled: currentSettings?.enabled === true,
      model: String(currentSettings?.model || result.model || 'gpt-4o').trim() || 'gpt-4o',
      baseUrl: String(currentSettings?.baseUrl || 'https://api.openai.com/v1').trim() || 'https://api.openai.com/v1',
      ...openAIImageSpendSettingsPayload(),
    };
    io.emit('models_updated', modelsUpdatedPayload(
      getModelCatalogState(),
      currentSettings,
    ));
    io.emit('openai_settings_updated', settingsPayload);
    return res.json({
      ok: true,
      ...settingsPayload,
      models: Array.isArray(discovery?.models) ? discovery.models : [],
      warning: imageSpendError || (discovery?.ok ? null : (discovery?.error || 'OpenAI model discovery failed')),
    });
  });

  // ─── OpenAI image presets ─────────────────────────────────────────────────
  // The built-ins and the owner's own (app_settings openai_image_presets).
  // Every change is one preset, read and written in one transaction, so two
  // pages saving at once cannot drop each other's preset. A paired relay's
  // agent may read them (relay_info lists them) but never change them.
  const readOwnOpenAIImagePresets = () => parseOwnOpenAIImagePresets(readJsonAppSetting(OPENAI_IMAGE_PRESETS_SETTING_KEY) ?? []);
  const openAIImagePresetsPayload = (own = readOwnOpenAIImagePresets()) => ({ presets: listOpenAIImagePresets(own) });
  const changeOwnOpenAIImagePresets = (req, res, change) => {
    if (notPerson(req, readRemoteRelayRequest(req, remoteRelayInbound))) {
      return res.status(403).json({ error: 'Image presets are changed by this relay\'s owner only.' });
    }
    if (typeof stmts?.upsertAppSetting?.run !== 'function') {
      return res.status(500).json({ error: 'Image preset settings are unavailable' });
    }
    let outcome;
    try {
      outcome = db.transaction(() => {
        const applied = applyOwnOpenAIImagePresetChange(readOwnOpenAIImagePresets(), change);
        if (applied.ok) {
          stmts.upsertAppSetting.run(OPENAI_IMAGE_PRESETS_SETTING_KEY, JSON.stringify(applied.presets), new Date().toISOString());
        }
        return applied;
      })();
    } catch (error) {
      return res.status(500).json({ error: String(error?.message || error) });
    }
    if (!outcome.ok) {
      return res.status(400).json({ error: outcome.error, code: OPENAI_IMAGE_PRESET_REFUSED_CODE });
    }
    const payload = openAIImagePresetsPayload(outcome.presets);
    io.emit('openai_image_presets_updated', payload);
    return res.json({ ok: true, ...payload });
  };

  app.get(OPENAI_IMAGE_PRESETS_PATH, auth, (_req, res) => res.json(openAIImagePresetsPayload()));

  // body { preset: { name, size?, quality?, count?, output_format?, background? }, replace? }
  app.put(OPENAI_IMAGE_PRESETS_PATH, auth, (req, res) => changeOwnOpenAIImagePresets(req, res, {
    op: 'put',
    preset: req.body?.preset ?? null,
    replace: req.body?.replace === true,
  }));

  app.delete(`${OPENAI_IMAGE_PRESETS_PATH}/:name`, auth, (req, res) => changeOwnOpenAIImagePresets(req, res, {
    op: 'delete',
    name: String(req.params?.name ?? ''),
  }));

  // Copilot has one engine, the SDK worker, and its switch. Paired relays
  // read this GET (an older one only the engine fields; a newer caller treats
  // a missing `enabled` as on).
  function copilotCliFound() {
    try {
      if (typeof detectCopilotCli === 'function') return Boolean(detectCopilotCli());
    } catch {
      return false;
    }
    return getCopilotProviderSettings()?.cliFound === true;
  }
  function currentCopilotSettings() {
    return copilotSettingsPayload({
      ...getCopilotProviderSettings(),
      enabled: isCopilotEnabled(),
      cliFound: copilotCliFound(),
    });
  }

  app.get('/api/settings/copilot', auth, (_req, res) => {
    return res.json(currentCopilotSettings());
  });

  // Switching Copilot on runs a model discovery, so its models are there for
  // New Chat; off, they leave the catalogue (sessions-routes.mjs).
  app.post('/api/settings/copilot', auth, async (req, res) => {
    const parsed = parseCopilotSettingsUpdateRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    if (typeof stmts?.upsertAppSetting?.run !== 'function') {
      return res.status(500).json({ error: 'Copilot settings are unavailable' });
    }
    const wasEnabled = isCopilotEnabled();
    writeCopilotEnabled({
      writeSetting: (key, value, stamp) => stmts.upsertAppSetting.run(key, value, stamp),
      enabled: parsed.enabled,
    });
    const discovery = parsed.enabled && !wasEnabled && typeof copilotModelDiscoveryService?.refresh === 'function'
      ? await copilotModelDiscoveryService.refresh('copilot-enabled').catch((error) => ({ ok: false, error: error?.message || String(error) }))
      : { ok: true };
    const settingsPayload = currentCopilotSettings();
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
    io.emit('copilot_settings_updated', settingsPayload);
    return res.json({
      ok: true,
      ...settingsPayload,
      warning: discovery?.ok ? null : (discovery?.error || 'Copilot model discovery failed'),
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
      ...claudeAttributionSettingsFields(settings),
      ...claudeBackgroundCommandLimitSettingsFields(settings),
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
    // Switching Claude off moves no chat: an empty Claude chat keeps its
    // provider.
    const currentSettings = getClaudeProviderSettings();
    const settingsPayload = {
      configured: currentSettings?.configured === true,
      enabled: currentSettings?.enabled === true,
      model: String(currentSettings?.model || result.model || 'claude-sonnet-5').trim() || 'claude-sonnet-5',
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      availableModels: Array.isArray(currentSettings?.availableModels) ? currentSettings.availableModels : [],
      ...claudeAttributionSettingsFields(currentSettings),
      ...claudeBackgroundCommandLimitSettingsFields(currentSettings),
    };
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
    io.emit('claude_settings_updated', settingsPayload);
    return res.json({
      ok: true,
      ...settingsPayload,
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      warning: discovery?.ok ? null : (discovery?.error || 'Claude model discovery failed'),
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
    // Switching Grok on or off moves no chat, in either direction.
    const currentSettings = getGrokProviderSettings();
    const settingsPayload = {
      configured: currentSettings?.configured === true,
      enabled: currentSettings?.enabled === true,
      model: String(currentSettings?.model || result.model || 'grok-4.5').trim() || 'grok-4.5',
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      availableModels: Array.isArray(currentSettings?.availableModels) ? currentSettings.availableModels : [],
    };
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
    io.emit('grok_settings_updated', settingsPayload);
    return res.json({
      ok: true,
      ...settingsPayload,
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      warning: discovery?.ok ? null : (discovery?.error || 'Grok model discovery failed'),
    });
  });

  // A rotated API key only reaches a worker's environment at spawn: live
  // workers of the provider keep the old key and fail each turn after the
  // rotation. Stops them; the primer or the next delivery respawns them with
  // the fresh key from settings.
  //
  // The workers are picked by what they run: a worker that states its kind
  // is taken at its word (a Claude chat switched to the API key may still
  // have its subscription worker finishing a turn, and one switched back
  // its API worker); one that does not is taken at its chat's provider.
  async function stopLiveProviderWorkersForKeyRotation(providerType) {
    const rows = db.prepare(`
      SELECT DISTINCT NULLIF(sdk_session_id, '') AS sdk_session_id
      FROM runtime_sessions
      WHERE LOWER(COALESCE(provider_type, '')) = ?
        AND NULLIF(sdk_session_id, '') IS NOT NULL
    `).all(providerType);
    const sids = new Set();
    for (const worker of sessionWorkerRegistry?.listWorkers?.() || []) {
      if (worker?.kind === providerType && worker.sdkSessionId) sids.add(worker.sdkSessionId);
    }
    for (const row of rows) {
      const sid = String(row.sdk_session_id || '').trim();
      const kind = sid ? (sessionWorkerRegistry?.getWorker?.(sid)?.kind || null) : null;
      if (sid && (!kind || kind === providerType)) sids.add(sid);
    }
    for (const sid of sids) {
      if (!sid) continue;
      const workerState = sessionWorkerSupervisor?.getWorkerState?.(sid) || null;
      if (!workerState) continue;
      try {
        const stopped = await stopIdleWorkspaceRootSession({
          sdkSessionId: sid,
          worker: sessionWorkerRegistry?.getWorker?.(sid) || null,
          sessionWorkerSupervisor,
          sessionWorkerRegistry,
          sessionWorkerProcessInspector,
        });
        if (stopped.ok) {
          sessionWorkerSupervisor?.clearRestartSchedule?.(sid, { resetKilledMarker: true });
          console.log(`[sessions] ${providerType} worker ${sid.slice(0, 8)} stopped for API key rotation`);
        }
      } catch (error) {
        console.warn(`[sessions] ${providerType} worker ${sid.slice(0, 8)} stop failed on key rotation: ${error?.message || error}`);
      }
    }
  }

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
    // A rotated API key only reaches a worker's environment at spawn: live
    // Cursor workers keep the old key (every handle rebuild reuses it) and
    // fail each turn after the rotation. Stop them now; the primer or the
    // next delivery respawns them with the fresh key from settings.
    if (parsed.apiKey && previous?.configured === true) {
      await stopLiveProviderWorkersForKeyRotation('cursor');
    }
    const shouldDiscover = result.enabled === true && (
      !!parsed.apiKey
      || previous?.enabled !== true
      || previous?.model !== result.model
      || previous?.effortsDiscovered !== true
      || previous?.reasoningOffDiscovered !== true
    );
    const discovery = !shouldDiscover
      ? { ok: true, models: [], error: null }
      : await refreshCursorProviderModels();
    // A removed key moves no chat: an empty Cursor chat keeps its provider.
    const currentSettings = getCursorProviderSettings();
    const settingsPayload = {
      configured: currentSettings?.configured === true,
      enabled: currentSettings?.enabled === true,
      model: String(currentSettings?.model || result.model || 'composer-2.5').trim() || 'composer-2.5',
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      availableModels: Array.isArray(currentSettings?.availableModels) ? currentSettings.availableModels : [],
    };
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
    io.emit('cursor_settings_updated', settingsPayload);
    return res.json({
      ok: true,
      ...settingsPayload,
      models: Array.isArray(currentSettings?.models) ? currentSettings.models : [],
      warning: discovery?.ok ? null : (discovery?.error || 'Cursor model discovery failed'),
    });
  });

  // --- DeepSeek ----------------------------------------------------------
  // The key is written here and never read back: GET and every answer carry
  // `configured` only. A rotated key reaches a worker only at spawn, so the
  // live DeepSeek workers are stopped; the next message starts them again.
  // What the tab shows: the stored settings, and whether the starting
  // balance still applies (a top-up since it was set replaces it), judged
  // on the currency the card's bar uses: the last balance read's main one.
  function describeDeepSeekSettings() {
    const described = deepseekSettingsService.describe();
    let references = [];
    try {
      references = planUsageService?.readDeepSeekBalanceReferences?.() || [];
    } catch {}
    let balances = null;
    try {
      balances = deepseekBalanceService?.peekBalance?.()?.balances || null;
    } catch {}
    const startingBalanceNote = deepseekStartingBalanceNote(
      described.startingBalance ? { amount: described.startingBalance, setAt: described.startingBalanceSetAt } : null,
      references,
      { balances },
    );
    return { ...described, startingBalanceNote };
  }

  app.get('/api/settings/deepseek', auth, (_req, res) => {
    if (!deepseekSettingsService) return res.status(501).json({ error: 'DeepSeek settings are unavailable' });
    return res.json(describeDeepSeekSettings());
  });

  app.post('/api/settings/deepseek', auth, async (req, res) => {
    if (!deepseekSettingsService) return res.status(501).json({ error: 'DeepSeek settings are unavailable' });
    const parsed = parseDeepSeekSettingsUpdateRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    // A starting balance a top-up has replaced is set anew when it is saved
    // again, the same amount too.
    const before = describeDeepSeekSettings();
    const startingBalanceReplaced = !!before.startingBalanceNote;
    const result = deepseekSettingsService.update(parsed, { startingBalanceReplaced });
    if (!result?.ok) {
      return res.status(result?.code === 'deepseek-key-removal-blocked' ? 409 : 400).json({
        error: result?.error || 'Failed to update DeepSeek settings',
        code: result?.code || null,
        activeConversationCount: Number(result?.activeConversationCount || 0),
        startedConversationCount: Number(result?.startedConversationCount || 0),
        activeQueueConversationCount: Number(result?.activeQueueConversationCount || 0),
      });
    }
    if (result.keyChanged) await stopLiveProviderWorkersForKeyRotation(DEEPSEEK_PROVIDER_TYPE);
    const discovery = result.discover
      ? await deepseekSettingsService.refreshModels()
      : { ok: true, models: [], error: null };
    // A starting balance set anew: the balance is read right then and noted
    // as the latest read, so a later top-up is a rise from a balance read
    // after the setting, and one made before it is already in this read
    // (deepseekStartingBalanceState). A failed read changes nothing: the
    // setting then stays until a rise seen after a read that followed it.
    const setAt = result.settings?.startingBalanceSetAt || null;
    if (setAt && setAt !== before.startingBalanceSetAt) {
      try {
        const balance = await deepseekBalanceService?.getBalance?.({ force: true });
        planUsageService?.recordDeepSeekBalance?.(balance);
      } catch {}
    }
    // A removed key moves no chat: an empty DeepSeek chat keeps its provider.
    const settingsPayload = describeDeepSeekSettings();
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
    io.emit('deepseek_settings_updated', settingsPayload);
    return res.json({
      ok: true,
      ...settingsPayload,
      warning: discovery?.ok ? null : (discovery?.error || 'DeepSeek model discovery failed'),
    });
  });

  // --- Claude API ----------------------------------------------------------
  // The key is written here and never read back: GET and every answer carry
  // `configured` only. A pasted Claude login token or Admin key is refused by
  // its prefix. A rotated key reaches a worker only at spawn, so the live
  // Claude API workers are stopped; the next message starts them again.
  app.get('/api/settings/claude-api', auth, (_req, res) => {
    if (!claudeApiSettingsService) return res.status(501).json({ error: 'Claude API settings are unavailable' });
    return res.json(claudeApiSettingsService.describe());
  });

  app.post('/api/settings/claude-api', auth, async (req, res) => {
    if (!claudeApiSettingsService) return res.status(501).json({ error: 'Claude API settings are unavailable' });
    const parsed = parseClaudeApiSettingsUpdateRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: parsed.code || null });
    const result = claudeApiSettingsService.update(parsed);
    if (!result?.ok) {
      return res.status(result?.code === 'claude-api-key-removal-blocked' ? 409 : 400).json({
        error: result?.error || 'Failed to update Claude API settings',
        code: result?.code || null,
        activeConversationCount: Number(result?.activeConversationCount || 0),
        startedConversationCount: Number(result?.startedConversationCount || 0),
        activeQueueConversationCount: Number(result?.activeQueueConversationCount || 0),
      });
    }
    if (result.keyChanged) await stopLiveProviderWorkersForKeyRotation(CLAUDE_API_PROVIDER_TYPE);
    const discovery = result.discover
      ? await claudeApiSettingsService.refreshModels()
      : { ok: true, models: [], error: null };
    // Removing the key or switching the provider off moves no chat: an empty
    // Claude API chat keeps its provider, and its first send refuses.
    const settingsPayload = claudeApiSettingsService.describe();
    io.emit('models_updated', modelsUpdatedPayload(getModelCatalogState()));
    io.emit('claude_api_settings_updated', settingsPayload);
    try { claudeApiStopLedger?.clearAll?.(); } catch {}
    try { checkClaudeApiCap('settings'); } catch {}
    // The key is saved whatever discovery said; Anthropic's refusal (a 401,
    // a key that needs a workspace) is the tab's status until a discovery
    // succeeds. A list dropped because the key changed meanwhile is no verdict.
    // A default the fallback list could not keep is named with the refusal.
    const previousModel = String(result.previousModel || '').trim();
    const defaultModelChanged = previousModel && settingsPayload.model && previousModel !== settingsPayload.model
      ? { from: previousModel, to: settingsPayload.model }
      : null;
    const discoveryError = result.discover && discovery?.ok === false && discovery?.stale !== true
      ? { error: discovery.error || 'Claude API model discovery failed', code: discovery.code || null, defaultModelChanged }
      : null;
    return res.json({
      ok: true,
      ...settingsPayload,
      discoveryError,
      warning: discovery?.ok ? null : (discovery?.error || 'Claude API model discovery failed'),
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

  // How long sub-agent records keep their tool inputs and output (0 = always).
  const subagentRecordRetentionPayload = (retentionDays) => ({
    retentionDays,
    choices: [...SUBAGENT_RECORD_RETENTION_CHOICES],
    defaultDays: DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS,
  });

  app.get('/api/settings/subagent-record-retention', auth, (_req, res) => {
    res.json(subagentRecordRetentionPayload(getSubagentRecordRetentionDays()));
  });

  app.post('/api/settings/subagent-record-retention', auth, (req, res) => {
    const parsed = parseSubagentRecordRetentionUpdate(req.body?.retentionDays);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = setSubagentRecordRetentionDays(parsed.days);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json(subagentRecordRetentionPayload(result.retentionDays));
  });

  // What a shared conversation shows of the host's paths and file names.
  const sharePathPrivacyPayload = (mode) => ({
    mode,
    choices: SHARE_PATH_PRIVACY_MODES.map((value) => ({ value, label: SHARE_PATH_PRIVACY_LABELS[value] })),
    defaultMode: DEFAULT_SHARE_PATH_PRIVACY_MODE,
  });

  app.get('/api/settings/share-path-privacy', auth, (_req, res) => {
    res.json(sharePathPrivacyPayload(getSharePathPrivacyMode()));
  });

  app.post('/api/settings/share-path-privacy', auth, (req, res) => {
    const parsed = parseSharePathPrivacyUpdate(req.body?.mode);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = setSharePathPrivacyMode(parsed.mode);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json(sharePathPrivacyPayload(result.mode));
  });

  app.get('/api/settings/background-task-timeout', auth, (_req, res) => {
    res.json({
      timeoutMinutes: getBackgroundTaskTimeoutMinutes(),
      minMinutes: BACKGROUND_TASK_TIMEOUT_MIN_MINUTES,
      maxMinutes: BACKGROUND_TASK_TIMEOUT_MAX_MINUTES,
      stepMinutes: BACKGROUND_TASK_TIMEOUT_STEP_MINUTES,
      defaultMinutes: DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES,
    });
  });

  app.post('/api/settings/background-task-timeout', auth, (req, res) => {
    const parsed = parseBackgroundTaskTimeoutUpdate(req.body?.timeoutMinutes);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = setBackgroundTaskTimeoutMinutes(parsed.minutes);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json({
      timeoutMinutes: result.timeoutMinutes,
      minMinutes: BACKGROUND_TASK_TIMEOUT_MIN_MINUTES,
      maxMinutes: BACKGROUND_TASK_TIMEOUT_MAX_MINUTES,
      stepMinutes: BACKGROUND_TASK_TIMEOUT_STEP_MINUTES,
      defaultMinutes: DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES,
    });
  });

  // "Mark a background task as quiet after N minutes" (task_stall_minutes).
  const taskStallMinutesPayload = (minutes) => ({
    minutes,
    min: TASK_STALL_MINUTES_MIN,
    max: TASK_STALL_MINUTES_MAX,
    default: DEFAULT_TASK_STALL_MINUTES,
  });

  app.get('/api/settings/task-stall-minutes', auth, (_req, res) => {
    res.json(taskStallMinutesPayload(getTaskStallMinutes()));
  });

  app.post('/api/settings/task-stall-minutes', auth, (req, res) => {
    const parsed = parseTaskStallMinutesUpdate(req.body?.minutes);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = setTaskStallMinutes(parsed.minutes);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json(taskStallMinutesPayload(result.minutes));
  });

  // "After a relay restart, tell interrupted sessions to carry on"
  // (restart_resume_notes, off by default; services/restart-resume-service.mjs).
  app.get('/api/settings/restart-resume', auth, (_req, res) => {
    res.json({ enabled: getRestartResumeEnabled() === true, default: false });
  });

  app.post('/api/settings/restart-resume', auth, (req, res) => {
    const parsed = parseRestartResumeUpdate(req.body?.enabled);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const result = setRestartResumeEnabled(parsed.enabled);
    if (!result.ok) return res.status(500).json({ error: result.error });
    return res.json({ enabled: result.enabled, default: false });
  });

  const pwaAppNamePayload = (appName) => ({
    appName,
    defaultName: PWA_APP_NAME_DEFAULT,
    shortName: derivePwaShortName(appName || PWA_APP_NAME_DEFAULT),
    maxLength: PWA_APP_NAME_MAX_LENGTH,
  });

  app.get('/api/settings/pwa-app-name', auth, (_req, res) => {
    res.json(pwaAppNamePayload(getPwaAppName()));
  });

  app.post('/api/settings/pwa-app-name', auth, (req, res) => {
    const result = setPwaAppName(req.body?.appName);
    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error });
    }
    return res.json(pwaAppNamePayload(result.appName));
  });

  /**
   * Merge the two Windows autostart services into one mode-shaped state.
   * A ready boot task wins the mode call even when a Startup .cmd also
   * exists (that mixed state is real on upgraded hosts): the boot task is
   * what owns the running relay there, and the leftover .cmd is reported so
   * the UI can offer cleanup instead of hiding the race.
   */
  async function windowsAutostartMergedState() {
    const signin = windowsAutostartService.getState();
    // A boot task that cannot be read is reported (and logged), not allowed
    // to fail the whole setting; the sign-in half above still does, since
    // "off" would be a guess there.
    let boot = { supported: false };
    if (windowsBootAutostartService) {
      try {
        boot = await windowsBootAutostartService.getState();
      } catch (error) {
        console.warn(`[autostart] could not read the boot task: ${error?.message || error}`);
        boot = { supported: true, taskStatus: 'unknown', taskName: null, legacyTaskPresent: false, readError: 'The boot task could not be read; the relay log has the details.' };
      }
    }
    const bootReady = boot.supported && boot.taskStatus === 'ready';
    const mode = bootReady ? 'boot' : (signin.enabled ? 'signin' : 'off');
    return {
      supported: signin.supported,
      platform: signin.platform,
      mode,
      // Back-compat for pre-mode clients: their toggle keeps meaning
      // "starts automatically somehow".
      enabled: mode !== 'off',
      boot: boot.supported ? {
        taskStatus: boot.taskStatus,
        taskName: boot.taskName,
        legacyTaskPresent: boot.legacyTaskPresent,
        customised: boot.customised === true,
        customisations: Array.isArray(boot.customisations) ? boot.customisations : [],
        handMade: Array.isArray(boot.handMade) ? boot.handMade : [],
        launcherBackupPath: boot.launcherBackupPath || null,
        readError: boot.readError || null,
        pendingElevation: boot.pendingElevation || null,
        lastError: boot.lastError || null,
        manualCommand: boot.manualCommand || null,
      } : null,
      signinEnabled: signin.enabled,
      // The Startup entries OAR did not make, which it leaves as they are.
      signinHandMade: (windowsAutostartService.listEntries?.() || []).filter((entry) => !entry.generated)
        .map(({ path: entryPath, otherInstall }) => ({ path: entryPath, otherInstall: otherInstall || null })),
    };
  }

  app.get('/api/settings/windows-autostart', auth, async (_req, res) => {
    if (!windowsAutostartService) {
      return res.status(500).json({ error: 'Windows autostart settings are unavailable' });
    }
    try {
      return res.json(await windowsAutostartMergedState());
    } catch (error) {
      // The details stay in the log: they name folders on the host.
      console.warn(`[autostart] could not read the Windows autostart setting: ${error?.message || error}`);
      return res.status(500).json({
        error: 'Unable to read Windows autostart. Check access to your user Startup folder.',
      });
    }
  });

  app.post('/api/settings/windows-autostart', auth, async (req, res) => {
    const rawMode = req.body?.mode;
    const hasBoolean = typeof req.body?.enabled === 'boolean';
    // Pre-mode clients send {enabled}; it maps onto the sign-in mode exactly
    // as before this endpoint learned about boot mode.
    const mode = rawMode !== undefined
      ? String(rawMode)
      : (hasBoolean ? (req.body.enabled ? 'signin' : 'off') : null);
    if (!['off', 'signin', 'boot'].includes(mode)) {
      return res.status(400).json({ error: "mode must be 'off', 'signin' or 'boot' (or enabled a boolean)" });
    }
    if (!windowsAutostartService) {
      return res.status(500).json({ error: 'Windows autostart settings are unavailable' });
    }
    try {
      if (!windowsAutostartService.getState().supported) {
        return res.status(400).json({ error: 'Windows autostart is only available on Windows' });
      }
      if (mode === 'boot' && !windowsBootAutostartService) {
        return res.status(500).json({ error: 'Windows boot autostart is unavailable' });
      }
      // The rules of `oar autostart`: only entries OAR generated are deleted
      // or written over. A hand-made one (a Startup entry, our task or its
      // launcher changed by hand, a task someone else made) that would stay
      // beside the new mode, or be replaced by it, stops the switch with the
      // same message; replacing it is `oar autostart <mode> --replace`.
      const boot = windowsBootAutostartService ? await windowsBootAutostartService.getState() : null;
      const now = describeWindowsAutostart({
        signinEntries: windowsAutostartService.listEntries?.() || [],
        boot: boot?.supported ? boot : {},
      });
      if (now.mode === 'unknown') {
        return res.status(409).json({ error: 'The boot task could not be read, so nothing was changed; the relay log has the details.' });
      }
      const blocking = switchBlockers(now, mode);
      if (blocking.length) return res.status(409).json({ error: handMadeLines(blocking, mode).join(' ') });
      if (mode === 'boot') {
        // A generated launcher that is missing or of an earlier version is
        // regenerated by enabling again; a hand-made one stays.
        const regenerate = boot.customised && !boot.handMade?.length;
        if (now.mode === 'boot' && !regenerate) {
          windowsAutostartService.setEnabled(false);
          return res.json({ ...(await windowsAutostartMergedState()), accepted: true });
        }
        // The sweep's completion also removes the Startup .cmd entries; the
        // sign-in service is not touched here so a declined UAC leaves the
        // previous mode fully intact.
        const result = await windowsBootAutostartService.requestEnable();
        return res.json({ ...(await windowsAutostartMergedState()), accepted: result.accepted });
      }
      // Leaving boot mode needs its own elevated sweep; the sign-in half
      // applies once the prompt was confirmed and the task is gone, so a
      // declined or failed one leaves the earlier mode as it was.
      if (now.mode === 'boot') {
        const result = await windowsBootAutostartService.requestDisable({
          onSettled: (ok) => {
            if (!ok) return;
            try {
              windowsAutostartService.setEnabled(mode === 'signin');
            } catch (error) {
              console.warn(`[autostart] the boot task is gone, but the sign-in entry could not be changed: ${error?.message || error}`);
            }
          },
        });
        return res.json({ ...(await windowsAutostartMergedState()), accepted: result.accepted });
      }
      const accepted = true;
      windowsAutostartService.setEnabled(mode === 'signin');
      return res.json({ ...(await windowsAutostartMergedState()), accepted });
    } catch (error) {
      console.warn(`[autostart] could not change the Windows autostart setting to ${mode}: ${error?.message || error}`);
      return res.status(500).json({
        error: 'Unable to update Windows autostart. Check access to your user Startup folder.',
      });
    }
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

  // The Cursor dashboard session token unlocks the live plan-quota bars on
  // the Check Usage card. GET only reports whether one is configured — the
  // token itself is never echoed back.
  app.get('/api/settings/cursor-dashboard-token', auth, (_req, res) => {
    res.json({ ok: true, ...getCursorDashboardTokenSettings() });
  });

  app.post('/api/settings/cursor-dashboard-token', auth, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = setCursorDashboardTokenSettings({
      sessionToken: body.sessionToken,
      remove: body.remove === true,
    });
    if (!result?.ok) {
      return res.status(400).json({ error: result?.error || 'Failed to update the Cursor dashboard token' });
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
