'use strict';

// The model catalog routes (variants, the background check's settings, the
// model list and the catalog snapshot) and the plan usage route, registered
// by registerSessionsRoutes.
import { fetchUsageSummaryPromise } from '../services/usage-snapshot-helpers.mjs';
import { claudeAttributionModelLabel } from '../../shared/claude-attribution.mjs';
import { deepseekModelLabel } from '../../shared/deepseek-models.mjs';
import { buildOpenAIImagePlanCard } from '../services/plan-usage-openai-image.mjs';
import { appendTokenSections } from '../services/plan-usage-tokens.mjs';
import { refreshProviderModels } from '../services/provider-model-refresh.mjs';
import { MODEL_REFRESH_INTERVAL_HOURS_CHOICES, MODEL_REFRESH_PROVIDERS, DEFAULT_MODEL_REFRESH_AUTO, DEFAULT_MODEL_REFRESH_INTERVAL_HOURS } from '../../shared/model-refresh-schedule.mjs';

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

export function registerModelRoutes(app, deps, shared) {
  const {
    auth,
    io,
    ensureSessionId,
    updateModelCatalog,
    listModelVariantRows,
    refreshModelVariantCatalogFromCli,
    setEnabledModelVariants,
    fetchUsageSummary,
  } = deps;
  const {
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
    // The Copilot switch (copilot-settings-service.mjs); absent, Copilot is on.
    isCopilotEnabled = () => true,
  } = shared;

  // Each provider tab's switch, "New" tags and fallback warning.
  function modelStateFields(settings) {
    return {
      autoEnableNew: settings?.autoEnableNew !== false,
      unseen: Array.isArray(settings?.unseenModels) ? settings.unseenModels : [],
      fallback: settings?.fallback === true,
    };
  }

  function buildModelVariantCatalogPayloadForRoute() {
    const rows = isCopilotEnabled() && typeof listModelVariantRows === 'function' ? listModelVariantRows() : []; // none of Copilot's while it is off
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
      // installed CLI). Only a failed CLI refresh fails the request. While
      // Copilot is switched off its CLI is not asked at all.
      const [cliRefresh, providerRefresh] = await Promise.allSettled([
        isCopilotEnabled() ? refreshModelVariantCatalogFromCli() : null,
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
    updateModelCatalog({
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
    // Copilot switched off: neither its quota nor its billing is read, and
    // it has no card.
    const copilotOn = isCopilotEnabled();

    // The Copilot quota: live, or the last live answer.
    const readCopilotSummary = async () => {
      if (!copilotOn) return { summary: null, error: null, at: nowIso() };
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
      if (!copilotOn) return res.status(409).json({ error: 'Copilot is switched off on this relay', code: 'COPILOT_NOT_ENABLED' });
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
        copilotOn && typeof fetchCopilotBillingUsage === 'function'
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
      copilotBilling: copilotOn ? billingEntry.value : null,
      copilotConfigured: copilotOn,
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
