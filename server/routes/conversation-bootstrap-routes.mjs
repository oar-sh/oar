'use strict';

// POST /api/conversation/bootstrap: a new conversation with its provider,
// model, mode, workspace root and group, registered by registerSessionsRoutes.
import { randomUUID } from 'crypto';
import { persistConversationPreferences } from '../services/conversation-preferences-service.mjs';
import {
  checkRequestedProviderModel,
  isAutoModelId,
  isProviderModelAvailable,
  resolveProviderModelSelection,
  unknownProviderModelText,
} from '../services/provider-model-selection.mjs';
import {
  resolveProviderReasoningEffort,
  supportedReasoningEffortsForProviderModel,
} from '../services/provider-reasoning-effort.mjs';
import {
  CLAUDE_API_PROVIDER_LABEL,
  CLAUDE_API_PROVIDER_TYPE,
} from '../services/claude-api-settings-service.mjs';
import {
  DEEPSEEK_PROVIDER_TYPE,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
  deepseekReasoningEffortFor,
} from '../../shared/deepseek-models.mjs';
import {
  readWorkspaceRootPathFromBody,
  validateRequestedWorkspaceRoot } from '../services/workspace-root-path-policy.mjs';
import { parseRemoteRelayOriginJson } from '../repositories/remote-relay-repository.mjs';
import { admitRemoteRelayRequest, isDirectAgentRequest, remoteOriginAnswerFields } from '../services/remote-relay-inbound.mjs';
import { notPerson } from '../services/relay-principal.mjs';
import { AUTH_ERROR_CODES, AUTH_RELAY_TOOL_REQUIRED_MESSAGE } from '../../shared/relay-route-policy.mjs';
import {
  CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN,
} from '../../shared/model-id.mjs';
import {
  OPENAI_IMAGE_NO_MODEL_CODE,
  isOpenAIImageModelId,
  openAIImageNoModelText,
  pickOpenAIImageDefaultModel,
} from '../../shared/openai-image-options.mjs';
import { stripModelTierSuffix } from '../../shared/claude-cloud/repo-url.mjs';
import {
  resolveSessionGroupReference,
} from '../../shared/remote-relay-contract.mjs';
import {
  buildCloudSourceRecord,
  buildConversationCloudPayload,
  validateCloudSourceRequest,
} from '../services/claude-cloud-session-service.mjs';

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

function normalizeRequestedProviderType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-byok') return 'openai';
  if (normalized === 'openai-image' || normalized === 'openai-image-byok') return 'openai-image';
  if (normalized === 'claude' || normalized === 'claude-agent-sdk' || normalized === 'anthropic') return 'claude';
  // Its own provider, never read as `claude`: a cloud chat is asked for by name.
  if (normalized === 'claude-cloud') return 'claude-cloud';
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'grok' || normalized === 'xai' || normalized === 'xai-grok') return 'grok';
  if (normalized === 'deepseek') return 'deepseek';
  // Its own provider, never read as `claude`.
  if (normalized === 'claude-api') return 'claude-api';
  if (normalized === 'github' || normalized === 'github-copilot') return 'github';
  return '';
}

export function registerConversationBootstrapRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    queueCounts,
    workspaceRootPayload,
    updateConversationConfiguredWorkspaceRoot,
    ensureSessionId,
    ensureRuntimeSessionBinding,
    SUPPORTED_RELAY_MODES,
    DEFAULT_RELAY_MODE,
    DEFAULT_MODEL,
    sessionWorkerSupervisor,
    sessionWorkerRegistry,
  } = deps;
  const {
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
  } = shared;

  app.post('/api/conversation/bootstrap', auth, async (req, res) => {
    // An agent of this relay starts sessions through relay_tool only: the
    // dispatcher's rules (may this session start sessions, the cap, the
    // owner's Allow) run there, and its loopback request is let through.
    if (isDirectAgentRequest(req)) {
      return res.status(403).json({ ok: false, code: AUTH_ERROR_CODES.relayToolRequired, error: AUTH_RELAY_TOOL_REQUIRED_MESSAGE });
    }
    // Another relay's agent starting a session: refused while the inbound
    // switch is off, otherwise the conversation keeps its provenance.
    const remoteRequest = admitRemoteRelayRequest(req, res, remoteRelayInbound);
    if (!remoteRequest) return;
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
    // Claude Cloud is asked for by name only: its model ids are the Claude
    // provider's own, so a model never selects it. Refused before anything
    // else is looked at while the provider is off, so a relay that has not
    // switched it on answers every such request the same way.
    const useClaudeCloudProvider = requestedProviderType === 'claude-cloud';
    const claudeCloudSettings = useClaudeCloudProvider
      ? (claudeCloudSettingsService?.getSettings?.() || null)
      : null;
    let bootstrapCloudSource = null;
    if (useClaudeCloudProvider) {
      const refuseCloud = (code, error) => res.status(400).json({ ok: false, error, code });
      if (claudeCloudSettings?.enabled !== true) {
        return refuseCloud('claude_cloud_disabled', 'Claude Cloud is not enabled on this relay');
      }
      const validatedSource = validateCloudSourceRequest(req.body?.cloudSource);
      if (!validatedSource.ok) return refuseCloud(validatedSource.code, validatedSource.error);
      // The stored environment, else the account's first active one (which
      // is then stored). Nothing is created at Anthropic here.
      let cloudEnvironmentId = String(claudeCloudSettings.environmentId || '').trim();
      if (!cloudEnvironmentId) {
        try {
          cloudEnvironmentId = String(await claudeCloudSettingsService.resolveEnvironmentId?.() || '').trim();
        } catch {
          cloudEnvironmentId = '';
        }
      }
      if (!cloudEnvironmentId) {
        return refuseCloud(
          'claude_cloud_environment_missing',
          'No cloud environment is set. Pick one on Settings → Providers → Claude Cloud (opening claude.ai/code once creates the default one).',
        );
      }
      if (typeof stmts.updateConvCloudSource?.run !== 'function') {
        return res.status(500).json({ ok: false, error: 'Claude Cloud storage is unavailable' });
      }
      bootstrapCloudSource = buildCloudSourceRecord({
        repoUrl: validatedSource.repoUrl,
        branch: validatedSource.branch,
        environmentId: cloudEnvironmentId,
      });
    }
    // Claude API is asked for by name only, like Claude Cloud: its model ids
    // are the Claude provider's own, so a model never selects it. Refused
    // first while it has no key or is switched off.
    const useClaudeApiProvider = requestedProviderType === CLAUDE_API_PROVIDER_TYPE;
    const claudeApiSettings = useClaudeApiProvider ? getClaudeApiProviderSettings() : null;
    if (useClaudeApiProvider && claudeApiSettings?.enabled !== true) {
      return res.status(400).json({
        ok: false,
        error: claudeApiSettings?.configured === true
          ? 'Claude API is switched off for new conversations.'
          : 'Claude API key is not configured.',
        code: 'CLAUDE_API_NOT_CONFIGURED',
      });
    }
    // This month's cap (plan decision 12): no new Claude API chat while it is
    // reached, for New Chat and an agent's create_session alike. A cap that
    // cannot be read counts as reached.
    if (useClaudeApiProvider) {
      let cap = null;
      try { cap = getClaudeApiCapState() || null; } catch { cap = { reached: true }; }
      if (cap?.reached === true) {
        return res.status(409).json({
          ok: false,
          // The remedy names the place, so the reason does not.
          error: `${String(cap.reason || cap.error || '').trim() || 'This month\'s Claude API spend has reached its cap.'} No Claude API chat was started; start it on the Claude subscription, or raise the cap in Settings → Providers → Claude API.`,
          code: 'CLAUDE_API_CAP_REACHED',
        });
      }
    }
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
    const cursorSettings = getCursorProviderSettings();
    // Kept in the provider's own casing: the canonical id is what gets bound,
    // persisted and echoed back, so a "Grok-4.5" request cannot drift into a
    // different string than the one the worker later sends to the SDK.
    const cursorModelCatalog = [
      String(cursorSettings?.model || '').trim(),
      ...(Array.isArray(cursorSettings?.models) ? cursorSettings.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const availableCursorModels = new Set(cursorModelCatalog.map((value) => value.toLowerCase()));
    const grokSettings = getGrokProviderSettings();
    const grokModelCatalog = [
      String(grokSettings?.model || '').trim(),
      ...(Array.isArray(grokSettings?.models) ? grokSettings.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const availableGrokModels = new Set(grokModelCatalog.map((value) => value.toLowerCase()));
    const deepseekSettings = getDeepSeekProviderSettings();
    const deepseekModelCatalog = [
      String(deepseekSettings?.model || '').trim(),
      ...(Array.isArray(deepseekSettings?.models) ? deepseekSettings.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    const availableDeepSeekModels = new Set(deepseekModelCatalog.map((value) => value.toLowerCase()));
    // Base ids of "[1m]" variants count too, as for the Claude provider.
    const availableClaudeApiModels = new Set((useClaudeApiProvider ? [
      String(claudeApiSettings?.model || '').trim(),
      ...(Array.isArray(claudeApiSettings?.models) ? claudeApiSettings.models : []),
    ] : []).map((value) => String(value || '').trim()).filter(Boolean)
      .flatMap((value) => [value, value.replace(CLAUDE_LONG_CONTEXT_SUFFIX_PATTERN, '')])
      .filter(Boolean));
    const useOpenAIProvider = requestedProviderType === 'openai'
      || requestedProviderType === 'openai-image'
      || (
        requestedProviderType === ''
        && requestedBootstrapModel
        && requestedBootstrapModel.toLowerCase() !== 'auto'
        && isProviderModelAvailable(requestedBootstrapModel, availableOpenAIModels)
      );
    const useClaudeProvider = !useOpenAIProvider && (
      requestedProviderType === 'claude'
      || (
        requestedProviderType === ''
        && requestedBootstrapModel
        && requestedBootstrapModel.toLowerCase() !== 'auto'
        && isProviderModelAvailable(requestedBootstrapModel, availableClaudeModels)
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
    const useDeepSeekProvider = !useOpenAIProvider && !useClaudeProvider && !useCursorProvider && !useGrokProvider && (
      requestedProviderType === 'deepseek'
      || (
        requestedProviderType === ''
        && requestedBootstrapModel
        && requestedBootstrapModel.toLowerCase() !== 'auto'
        && availableDeepSeekModels.has(requestedBootstrapModel.toLowerCase())
      )
    );
    // Managed providers resolve the request against their own catalog only.
    // Routing it through the merged Copilot catalog first (resolveBootstrapModelSelection)
    // silently substituted that catalog's current model whenever the requested
    // id was missing from it, which is how a Cursor/Grok pick could come back
    // bound to Opus.
    // With no model in the request the shared catalog's current model is still
    // honoured when the provider offers it, which is what callers that omit
    // `model` relied on before.
    const providerRequestedModel = (availableModels) => (
      requestedBootstrapModel
      || (isProviderModelAvailable(catalogSelectedModel, availableModels) ? catalogSelectedModel : '')
    );
    // An OpenAI Image chat asked for without a model starts on the image
    // default the OpenAI list offers (else its first gpt-image), never on
    // the shared catalog's current model, which makes no images.
    const openAIImageDefaultModel = requestedProviderType === 'openai-image' && !requestedBootstrapModel
      ? pickOpenAIImageDefaultModel([...availableOpenAIModels])
      : '';
    const providerModelSelection = useClaudeCloudProvider
      // The cloud takes plain ids; with no model in the request the tab's
      // default applies (never the shared catalog's current model).
      ? resolveProviderModelSelection({
          requestedModel: stripModelTierSuffix(requestedBootstrapModel),
          configuredModel: claudeCloudSettings.defaultModel,
          availableModels: Array.isArray(claudeCloudSettings.models) ? claudeCloudSettings.models : [],
        })
      : useClaudeApiProvider
      ? resolveProviderModelSelection({
          requestedModel: providerRequestedModel(availableClaudeApiModels),
          configuredModel: claudeApiSettings.model,
          availableModels: availableClaudeApiModels,
        })
      : useOpenAIProvider
      ? resolveProviderModelSelection({
          requestedModel: openAIImageDefaultModel || providerRequestedModel(availableOpenAIModels),
          // The removed resolveOpenAISessionModel carried this last-resort id.
          configuredModel: openAISettings.model || 'gpt-4o',
          availableModels: availableOpenAIModels,
        })
      : (useClaudeProvider
        ? resolveProviderModelSelection({
            requestedModel: providerRequestedModel(availableClaudeModels),
            configuredModel: claudeSettings.model,
            availableModels: availableClaudeModels,
          })
        : (useCursorProvider
          ? resolveProviderModelSelection({
              requestedModel: providerRequestedModel(cursorModelCatalog),
              configuredModel: cursorSettings.model,
              availableModels: cursorModelCatalog,
            })
          : (useGrokProvider
            ? resolveProviderModelSelection({
                requestedModel: providerRequestedModel(grokModelCatalog),
                configuredModel: grokSettings.model,
                availableModels: grokModelCatalog,
              })
            : (useDeepSeekProvider
              ? resolveProviderModelSelection({
                  requestedModel: providerRequestedModel(deepseekModelCatalog),
                  configuredModel: deepseekSettings.model,
                  availableModels: deepseekModelCatalog,
                })
              : null))));
    // The single rejection for "this provider does not offer that model".
    // Per-provider pre-checks used to duplicate it and had drifted apart in
    // wording, casing rules and whether they listed the alternatives.
    if (providerModelSelection && !providerModelSelection.ok) {
      const providerLabel = useClaudeCloudProvider
        ? 'Claude Cloud'
        : useClaudeApiProvider
        ? CLAUDE_API_PROVIDER_LABEL
        : (useOpenAIProvider
          ? 'OpenAI'
          : (useClaudeProvider ? 'Claude' : (useCursorProvider ? 'Cursor' : (useGrokProvider ? 'Grok' : 'DeepSeek'))));
      const providerCode = useClaudeCloudProvider
        ? 'CLAUDE_CLOUD_MODEL_UNAVAILABLE'
        : useClaudeApiProvider
        ? 'CLAUDE_API_MODEL_UNAVAILABLE'
        : (useOpenAIProvider
          ? 'OPENAI_MODEL_UNAVAILABLE'
          : (useClaudeProvider
            ? 'CLAUDE_MODEL_UNAVAILABLE'
            : (useCursorProvider
              ? 'CURSOR_MODEL_UNAVAILABLE'
              : (useGrokProvider ? 'GROK_MODEL_UNAVAILABLE' : 'DEEPSEEK_MODEL_UNAVAILABLE'))));
      return res.status(400).json({
        ok: false,
        error: `${providerLabel} model "${providerModelSelection.requestedModel}" is not available`,
        code: providerCode,
        supportedModels: providerModelSelection.availableModels || [],
      });
    }
    const useCopilotProvider = !useClaudeCloudProvider && !useOpenAIProvider && !useClaudeProvider && !useCursorProvider
      && !useGrokProvider && !useDeepSeekProvider && !useClaudeApiProvider;
    // A Copilot chat on an image id would reach the Copilot runtime, which
    // cannot serve it: refused before anything is written.
    const copilotImageRefusal = useCopilotProvider ? copilotImageModelRefusal(requestedBootstrapModel || catalogSelectedModel) : null;
    if (copilotImageRefusal) return res.status(400).json(copilotImageRefusal);
    // Copilot falls back to the catalogue's current model for an id it does
    // not list, which New Chat (it only offers listed ids) never meets. An
    // agent naming a mistyped id ("gpt-5-4") would get a session on another
    // model than it asked for, or one its next send cannot reach: refused.
    // A listed id is bound in the list's casing, and one with its effort
    // ("gpt-5.4-high") as the listed id plus that effort: the catalogue
    // lookup below knows exact base ids only and would fall back too.
    let copilotBoundModel = '';
    let copilotVariantEffort = '';
    let copilotRefusal = null;
    if (
      remoteRequest.remote
      && !useClaudeCloudProvider && !useOpenAIProvider && !useClaudeProvider && !useCursorProvider && !useGrokProvider
      && !useDeepSeekProvider && !useClaudeApiProvider
    ) {
      const mergedModels = Array.isArray(modelState?.models) ? modelState.models : [];
      const providersByModel = modelState?.providersByModel && typeof modelState.providersByModel === 'object'
        ? modelState.providersByModel
        : {};
      // Copilot's own: listed for it, or for no provider in particular.
      const copilotModels = mergedModels.filter((modelId) => {
        const providers = providersByModel[String(modelId || '').trim().toLowerCase()];
        return !Array.isArray(providers) || providers.length === 0
          || providers.some((provider) => String(provider || '').trim().toLowerCase() === 'github-copilot');
      });
      const reasoningByModel = modelState?.reasoningByModel && typeof modelState.reasoningByModel === 'object'
        ? modelState.reasoningByModel
        : {};
      const copilotCheck = checkRequestedProviderModel({
        requestedModel: requestedBootstrapModel,
        provider: 'github',
        models: copilotModels,
        effortsFor: (base) => reasoningByModel[base] || reasoningByModel[String(base).toLowerCase()] || null,
      });
      // Another provider's model is answered by the checks below ("requires
      // the Claude provider"), not as an unknown one. One that several other
      // providers list ("claude-opus-5-5": Claude and Cursor) passes those
      // checks and is refused as unknown after them.
      const otherProviders = mergedModels.some((modelId) => String(modelId || '').trim().toLowerCase() === requestedBootstrapModel.toLowerCase());
      if (copilotCheck.status === 'known' && copilotCheck.model && !isAutoModelId(copilotCheck.model)) {
        copilotBoundModel = copilotCheck.base || copilotCheck.model;
        copilotVariantEffort = copilotCheck.effort || '';
      }
      if (copilotCheck.status === 'unknown') {
        copilotRefusal = {
          ok: false,
          error: unknownProviderModelText({ model: copilotCheck.model, provider: 'github', suggestions: copilotCheck.suggestions, models: copilotCheck.models }),
          code: 'COPILOT_MODEL_UNAVAILABLE',
          supportedModels: copilotCheck.models,
          ...(copilotCheck.suggestions.length ? { suggestedModels: copilotCheck.suggestions } : {}),
        };
        if (!otherProviders) return res.status(400).json(copilotRefusal);
      }
    }
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
    if (useDeepSeekProvider && deepseekSettings?.enabled !== true) {
      return res.status(400).json({
        ok: false,
        error: deepseekSettings?.configured === true
          ? 'DeepSeek is switched off for new conversations'
          : 'DeepSeek API key is not configured',
        code: 'DEEPSEEK_NOT_CONFIGURED',
      });
    }

    // The session group an agent's create_session names (an id or an exact
    // name): resolved before anything is written. It wins over the creator's
    // group. Only the row created here is ever placed; the group routes stay
    // the owner's. A name that is not a group here: an agent makes no group
    // (agent auth §0.2), so its session starts in no group and the answer
    // says so; the person's request is refused, nothing created.
    const rawGroup = req.body?.group;
    if (rawGroup !== undefined && rawGroup !== null && typeof rawGroup !== 'string') {
      return res.status(400).json({ ok: false, code: 'SESSION_GROUP_INVALID', error: 'group must be text: a group id or name' });
    }
    const requestedGroup = String(rawGroup || '').trim();
    let bootstrapGroupId = '';
    let bootstrapGroupNote = '';
    if (requestedGroup) {
      if (!conversationGroups?.enabled) {
        return res.status(503).json({
          ok: false,
          code: 'SESSION_GROUPS_UNAVAILABLE',
          error: 'Session groups are not available on this relay (its storage for them is missing). No conversation was created.',
        });
      }
      const groups = listGroupsForAgents();
      const found = resolveSessionGroupReference(groups, requestedGroup);
      if (found.status === 'found') {
        bootstrapGroupId = found.group.id;
      } else if (found.status === 'unknown' && notPerson(req, remoteRequest)) {
        const asked = requestedGroup.replace(/["\r\n]+/g, ' ').slice(0, 80);
        bootstrapGroupNote = `No session group "${asked}" here, and only the person makes groups: the session was started in no group.`;
      } else {
        return res.status(400).json(bootstrapGroupRefusal(found, requestedGroup, groups));
      }
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

    const selectedModel = providerModelSelection ? providerModelSelection.model : (copilotBoundModel || catalogSelectedModel);
    // Asked for without a model, an image chat needs a gpt-image model in the
    // OpenAI list; it never falls back to a chat model, which makes no images.
    if (requestedProviderType === 'openai-image' && !requestedBootstrapModel && !openAIImageDefaultModel) {
      return res.status(400).json({ ok: false, error: openAIImageNoModelText(), code: OPENAI_IMAGE_NO_MODEL_CODE });
    }
    if (requestedProviderType === 'openai-image' && !isOpenAIImageModelId(selectedModel)) {
      return res.status(400).json({
        ok: false,
        error: `OpenAI image provider requires an image model (received "${selectedModel}")`,
        code: 'OPENAI_IMAGE_MODEL_REQUIRED',
      });
    }
    if (
      !useClaudeCloudProvider && !useOpenAIProvider && !useClaudeProvider && !useCursorProvider && !useGrokProvider
      && !useDeepSeekProvider && !useClaudeApiProvider
    ) {
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
      // Claude API serves the Claude provider's ids: a model both list is
      // still Claude's, and one only Claude API lists names that provider.
      const selectedProviderIds = selectedProviders.map((provider) => String(provider || '').trim().toLowerCase());
      const claudeOnlySelection = selectedProviderIds.length > 0
        && selectedProviderIds.includes('claude')
        && selectedProviderIds.every((provider) => provider === 'claude' || provider === CLAUDE_API_PROVIDER_TYPE);
      if (claudeOnlySelection) {
        return res.status(400).json({
          ok: false,
          error: `Model "${selectedModel}" requires the Claude provider`,
          code: 'CLAUDE_PROVIDER_REQUIRED',
        });
      }
      const claudeApiOnlySelection = selectedProviderIds.length > 0
        && selectedProviderIds.every((provider) => provider === CLAUDE_API_PROVIDER_TYPE);
      if (claudeApiOnlySelection) {
        return res.status(400).json({
          ok: false,
          error: `Model "${selectedModel}" requires the Claude API provider`,
          code: 'CLAUDE_API_PROVIDER_REQUIRED',
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
      const deepseekOnlySelection = selectedProviders.length > 0
        && selectedProviders.every((provider) => String(provider || '').trim().toLowerCase() === DEEPSEEK_PROVIDER_TYPE);
      if (deepseekOnlySelection) {
        return res.status(400).json({
          ok: false,
          error: `Model "${selectedModel}" requires the DeepSeek provider`,
          code: 'DEEPSEEK_PROVIDER_REQUIRED',
        });
      }
    }
    // No single other provider claims it: a Copilot session with a model
    // Copilot does not list would be refused at its first send.
    if (copilotRefusal) return res.status(400).json(copilotRefusal);

    const bootstrapProviderType = useClaudeCloudProvider
      ? 'claude-cloud'
      : useClaudeApiProvider
      ? CLAUDE_API_PROVIDER_TYPE
      : (useOpenAIProvider
        ? 'openai'
        : (useClaudeProvider
          ? 'claude'
          : (useCursorProvider
            ? 'cursor'
            : (useGrokProvider ? 'grok' : (useDeepSeekProvider ? 'deepseek' : 'github')))));
    // Preferences are written in the same transaction as the conversation, so
    // the caller's current mode has to arrive with the request: without it every
    // new chat would be stored as the default one and reset the composer. An
    // omitted or unknown mode still falls back to the default rather than 400,
    // because a new chat is worth starting either way.
    // Plan-only: a session that starts locked in plan mode. With no
    // mode named it starts in plan; a mode that is not plan is refused.
    const bootstrapPlanOnly = Object.prototype.hasOwnProperty.call(req.body || {}, 'planOnly') ? req.body.planOnly : undefined;
    if (bootstrapPlanOnly !== undefined && typeof bootstrapPlanOnly !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'planOnly must be true or false', code: 'PLAN_ONLY_INVALID' });
    }
    const namedBootstrapMode = req.body?.relayMode ?? req.body?.preferredRelayMode;
    if (bootstrapPlanOnly === true) {
      if (!stmts.conversationsHavePlanOnly) {
        return res.status(503).json({ ok: false, error: 'planOnly is unavailable until the relay restarts (its storage is missing). No conversation was created.', code: 'PLAN_ONLY_UNAVAILABLE' });
      }
      if (String(namedBootstrapMode ?? '').trim() && String(namedBootstrapMode).trim().toLowerCase() !== 'plan') {
        return res.status(400).json({ ok: false, error: `planOnly keeps a session in plan mode; it cannot start in ${String(namedBootstrapMode).trim()} mode. No conversation was created.`, code: 'PLAN_ONLY_MODE' });
      }
    }
    const bootstrapRelayMode = bootstrapPlanOnly === true
      ? 'plan'
      : normalizeRelayModePreference(namedBootstrapMode, {
        supportedRelayModes: SUPPORTED_RELAY_MODES,
        fallbackMode: DEFAULT_RELAY_MODE,
      });
    // The New Chat modal's reasoning choice is validated with the same rules the
    // first send would apply, so the composer can restore it from the server
    // instead of guessing from localStorage.
    const bootstrapReasoning = resolveProviderReasoningEffort({
      requestedEffort: req.body?.reasoningEffort || copilotVariantEffort,
      strict: bootstrapProviderType === 'openai',
      ...(bootstrapProviderType === 'deepseek'
        ? { defaultEffort: DEFAULT_DEEPSEEK_REASONING_EFFORT, aliasFor: deepseekReasoningEffortFor }
        : {}),
      supportedEfforts: supportedReasoningEffortsForProviderModel({
        providerType: bootstrapProviderType,
        model: selectedModel,
        cursorSettings,
        claudeSettings,
        claudeApiSettings,
        grokSettings,
        reasoningByModel: modelState?.reasoningByModel || null,
      }),
    });
    if (!bootstrapReasoning.ok) {
      return res.status(400).json({
        ok: false,
        error: bootstrapReasoning.error || 'Unsupported reasoning effort',
        code: 'REASONING_EFFORT_UNSUPPORTED',
        supportedReasoningEfforts: bootstrapReasoning.supported,
      });
    }

    try {
      // One transaction so a conversation can never exist without its runtime
      // binding and preferences: every later reader treats these three as a
      // single canonical tuple.
      let attachedGroupId = null;
      let attachedGroupIds = [];
      const commitBootstrapState = db.transaction(() => {
        stmts.insertConv.run(conversationId, title, now, now);
        if (remoteRequest.origin) remoteRelayInbound?.repository?.setConversationOrigin?.(conversationId, remoteRequest.origin);
        if (bootstrapGroupId) {
          // The group named in the request. Dissolved since it was looked up:
          // the whole bootstrap rolls back, and the caller hears it as unknown.
          const placed = conversationGroups.setMembership(conversationId, bootstrapGroupId, now);
          if (!placed?.ok) throw Object.assign(new Error('session group gone'), { bootstrapGroupGone: true });
          attachedGroupId = bootstrapGroupId;
          attachedGroupIds = [conversationId];
        } else if (!bootstrapGroupNote && remoteRequest.origin?.local === true && remoteRequest.origin.conversationId) {
          // A session an agent of this relay created joins its creator's group
          // (or starts one with the creator as head). A creator on a paired
          // relay has no local flag and groups nothing.
          attachedGroupId = conversationGroups?.attachCreatedConversation?.(conversationId, remoteRequest.origin.conversationId, now) || null;
          attachedGroupIds = [conversationId, remoteRequest.origin.conversationId];
        }
        const boundRuntimeSession = ensureRuntimeSessionBinding(
          conversationId,
          selectedModel,
          now,
          conversationId,
          {
            assignConfiguredProvider: true,
            providerType: bootstrapProviderType,
            providerModel: (
              useClaudeCloudProvider || useOpenAIProvider || useClaudeProvider || useCursorProvider || useGrokProvider
              || useDeepSeekProvider || useClaudeApiProvider
            ) ? selectedModel : null,
          },
        );
        // What the cloud session will clone, stored with the conversation so
        // a cloud conversation never exists without its repository.
        if (bootstrapCloudSource) {
          stmts.updateConvCloudSource.run(JSON.stringify(bootstrapCloudSource), conversationId);
        }
        const preferences = persistConversationPreferences({
          db,
          stmts,
          conversationId,
          preferredRelayMode: bootstrapRelayMode,
          preferredModel: selectedModel,
          preferredReasoningEffort: bootstrapReasoning.effort,
          ...(bootstrapPlanOnly === true ? { planOnly: true } : {}),
          updatedAt: now,
        });
        return { boundRuntimeSession, preferences };
      });
      const { boundRuntimeSession, preferences } = commitBootstrapState();
      if (attachedGroupId) emitGroupChanged(attachedGroupId, attachedGroupIds);
      const runtimeSession = boundRuntimeSession;
      const preferredRelayMode = preferences?.preferredRelayMode || bootstrapRelayMode;
      const preferredModel = preferences?.preferredModel || selectedModel;
      const preferredReasoningEffort = preferences?.preferredReasoningEffort || bootstrapReasoning.effort || '';
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
      const ownerSessionId = conversationId;
      if (typeof sessionWorkerSupervisor?.ensureWorker === 'function') {
        sessionWorkerSupervisor?.clearRestartSchedule?.(ownerSessionId, { resetKilledMarker: true });
        const ensureResult = await sessionWorkerSupervisor.ensureWorker(ownerSessionId);
        if (!ensureResult?.ok) {
          // The conversation is already committed with its provider selection,
          // so the failure payload carries enough for the client to open and
          // retry it instead of leaving an unreachable row in the sidebar.
          return res.status(409).json({
            ok: false,
            error: ensureResult?.error || 'worker-bootstrap-failed',
            conversationId,
            runtimeSessionId: runtimeSession?.id || null,
            ownerSessionId,
            worker: ensureResult?.worker || null,
            lifecycle: ensureResult?.lifecycle || null,
            conversationCreated: true,
            selectedModel,
            selectedProviderType: bootstrapProviderType,
            preferredRelayMode,
            preferredModel,
            preferredReasoningEffort,
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
        // A deferred start (the agent SDK still installs) has no worker to
        // call idle: it launches when the install ends.
        if (!ensureResult.deferred) {
          const pendingDepth = Number(queueCounts?.().pendingCount || 0);
          sessionWorkerSupervisor?.markIdle?.(ownerSessionId, pendingDepth);
        }
      } else {
        // Same state as the 409 above: the conversation is committed, only the
        // worker is missing, so the client gets what it needs to open it.
        return res.status(500).json({
          ok: false,
          error: 'session-worker-launcher-unavailable',
          conversationId,
          runtimeSessionId: runtimeSession?.id || null,
          ownerSessionId,
          conversationCreated: true,
          selectedModel,
          selectedProviderType: bootstrapProviderType,
          preferredRelayMode,
          preferredModel,
          preferredReasoningEffort,
          ...workspaceRootPayload(),
        });
      }

      const conversation = stmts.getConvAnyStatus.get(conversationId) || null;
      const ownerWorker = sessionWorkerSupervisor?.getWorkerState?.(ownerSessionId) || sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
      return res.json({
        ok: true,
        ...remoteOriginAnswerFields(remoteRequest),
        conversationId,
        conversation,
        origin: parseRemoteRelayOriginJson(conversation?.origin_json),
        cloud: bootstrapCloudSource
          ? buildConversationCloudPayload({ cloudSourceJson: bootstrapCloudSource })
          : null,
        // Always present (null outside a group): a caller that asked for a
        // group tells this relay from one that predates it by the key.
        group: conversationGroupField(conversationId),
        ...(bootstrapGroupNote ? { groupNote: bootstrapGroupNote } : {}),
        runtimeSessionId: runtimeSession?.id || null,
        ownerSessionId,
        worker: ownerWorker,
        lifecycle: sessionWorkerSupervisor?.getLifecycleState?.(ownerSessionId) || null,
        selectedModel,
        selectedProviderType: bootstrapProviderType,
        preferredRelayMode,
        preferredModel,
        preferredReasoningEffort,
        // Echoed so the calling relay can tell this relay knows the flag.
        planOnly: preferences?.planOnly === true,
        configuredWorkspaceRootPath: workspaceRootState?.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: workspaceRootState?.configuredWorkspaceRootName || null,
        currentWorkspaceRootPath: workspaceRootState?.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: workspaceRootState?.currentWorkspaceRootName || null,
        workspaceRootWarning,
        ...workspaceRootPayload(),
      });
    } catch (error) {
      if (error?.bootstrapGroupGone) {
        const groups = listGroupsForAgents();
        return res.status(400).json(bootstrapGroupRefusal({ status: 'unknown' }, requestedGroup, groups));
      }
      console.warn(`[bootstrap] conversation bootstrap failed: ${error?.message || error}`);
      return res.status(500).json({
        ok: false,
        error: 'Failed to bootstrap conversation session',
      });
    }
  });
}
