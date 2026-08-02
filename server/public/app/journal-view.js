import {
  conversations,
  currentConvId,
  fmtDate,
  parseTimestampMs,
  escHtml,
  repoBrowserState,
  getSessionWorkerState,
  resolveConversationUiState,
  setCurrentConv,
  showTransientRelayNotice,
  updateSessionPill,
  updateCompactButton,
  closeSidebar,
  applyContextUsageBar,
  isMobileComposerViewport,
  releaseComposerFocusAfterSend,
  loadConversationScrollTop,
  loadConversationLoadedMessageCount,
  saveConversationScrollTop,
  IS_SHARED_VIEW,
} from './store.js';
import {
  loadConversations as loadConversationsApi,
  loadConversation,
  deleteConversation as deleteConversationApi,
  bootstrapConversationSession,
  scheduleContextUsageRefresh,
  loadModelCatalog,
  loadClaudeSettings,
  loadCursorSettings,
  loadOpenAISettings,
} from './api-client.js';
import { renderMessages, restoreInFlightThinking, focusConversationMessageById, flushConversationDraft, hydrateConversationDraft } from './conversation-view.js';
import { loadRelayQuestions, getPendingQuestionCountsByConversation } from './ask-user-view.js';
import { loadRelayBoards } from './relay-board-view.js';
import { clearAttachments, setRepoBrowserSessionInfo, loadRepoBrowserTree } from './attachments-view.js';
import { shouldApplyConversationLoad } from './activity-replay-state.mjs';
import { createInfiniteLoader } from './infinite-loader.js';
import {
  buildNewConversationModelChoices,
  reasoningChoicesForProviderModel,
  resolvePreferredReasoningEffort,
} from './new-conversation-model-choice.mjs';
import {
  conversationProviderIndicatorKey,
  conversationProviderIndicatorLabel,
} from './conversation-provider-indicator.mjs';
import { leaveStatusView } from './status-view.mjs';

const PROCESSING_DOT_FRAMES = ['   ', '.  ', '.. ', '...'];
const PROCESSING_DOT_INTERVAL_MS = 1000;
const LOCAL_PROCESSING_STALE_MS = 5 * 60 * 1000;
const CONVERSATION_LIST_PAGE_SIZE = 40;
const REASONING_STORAGE_KEY = 'copilot_selected_reasoning_effort';
const OPENAI_IMAGE_SIZE_STORAGE_KEY = 'copilot_openai_image_size';
let processingDotFrame = 0;
let processingDotTimer = null;
let openConversationVersion = 0;
let newConversationInFlight = false;
let newConversationCatalogCache = null;
let newConversationOpenAISettingsCache = null;
let newConversationClaudeSettingsCache = null;
let newConversationCursorSettingsCache = null;
let conversationListBoundaryCheckFrame = 0;
let conversationListAutoLoadBlockedUntil = 0;
let conversationListPaginationState = {
  hasMore: false,
  nextCursor: null,
  hasPrefetchedPage: false,
  isLoading: false,
  isPrefetching: false,
  hasLoadedOlderPages: false,
};

function mergeConversationRecord(current, next) {
  const merged = {
    ...(current && typeof current === 'object' ? current : {}),
    ...(next && typeof next === 'object' ? next : {}),
  };
  // localTurnStatus is optimistic client state driven by one-shot message_status
  // socket events. If the socket drops between a turn finishing and the event
  // being delivered — a relay restart is the obvious case — the flag would stay
  // 'processing' until it aged out, leaving the list spinner running forever.
  // The server's activeTurn flag is authoritative, so let it clear the flag.
  if (next && typeof next === 'object' && next.activeTurn === false) {
    delete merged.localTurnStatus;
    delete merged.localTurnStatusUpdatedAt;
  }
  return merged;
}

function upsertConversationRecord(record) {
  const id = String(record?.id || '').trim();
  if (!id) return false;
  const hadExistingRecord = !!conversations[id];
  conversations[id] = mergeConversationRecord(conversations[id], record);
  return !hadExistingRecord;
}

function getConversationListElement() {
  return document.getElementById('conv-list');
}

function getConversationListBoundaryDistance() {
  const el = getConversationListElement();
  if (!el) return Number.POSITIVE_INFINITY;
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

function scheduleConversationListBoundaryCheck() {
  if (conversationListBoundaryCheckFrame) return;
  conversationListBoundaryCheckFrame = requestAnimationFrame(() => {
    conversationListBoundaryCheckFrame = 0;
    if (Date.now() < conversationListAutoLoadBlockedUntil) return;
    void conversationListLoader.handleBoundaryDistance(getConversationListBoundaryDistance());
  });
}

function applyConversationPage(items = []) {
  for (const conversation of Array.isArray(items) ? items : []) {
    upsertConversationRecord(conversation);
  }
  renderConvList();
  updateCompactButton();
  scheduleConversationListBoundaryCheck();
}

const conversationListLoader = createInfiniteLoader({
  fetchPage: async (cursor) => {
    const response = await loadConversationsApi({
      limit: CONVERSATION_LIST_PAGE_SIZE,
      beforeConversationId: String(cursor?.beforeConversationId || '').trim(),
      beforeUpdatedAt: String(cursor?.beforeUpdatedAt || '').trim(),
    });
    if (!response) throw new Error('Could not load conversations');
    return {
      items: response.conversations || [],
      hasMore: !!response.pageInfo?.hasMore,
      nextCursor: response.pageInfo?.nextCursor || null,
    };
  },
  applyPage: async (page) => {
    applyConversationPage(page.items);
    conversationListPaginationState.hasLoadedOlderPages = true;
  },
  onError: (error) => {
    conversationListAutoLoadBlockedUntil = Date.now() + 2000;
    console.error('Conversation list paging failed:', error);
  },
  onStateChange: (state) => {
    conversationListPaginationState = {
      ...conversationListPaginationState,
      ...state,
    };
    renderConvList();
  },
});

function resetConversationListPageState(pageInfo = null, { preserveProgress = false } = {}) {
  const currentState = conversationListLoader.getState();
  const nextState = preserveProgress && conversationListPaginationState.hasLoadedOlderPages
    ? currentState
    : {
        hasMore: !!pageInfo?.hasMore,
        nextCursor: pageInfo?.nextCursor || null,
      };
  if (!preserveProgress) {
    conversationListPaginationState.hasLoadedOlderPages = false;
  }
  conversationListAutoLoadBlockedUntil = 0;
  conversationListLoader.reset(nextState);
  scheduleConversationListBoundaryCheck();
}

function isConversationProcessing(conversation, workerState) {
  const workerStatus = String(workerState?.status || '').trim().toLowerCase();
  if (workerStatus === 'processing') return true;
  const localTurnStatus = String(conversation?.localTurnStatus || '').trim().toLowerCase();
  if (localTurnStatus === 'processing') {
    const updatedAtMs = Number(conversation?.localTurnStatusUpdatedAt || 0);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0 || (Date.now() - updatedAtMs) < LOCAL_PROCESSING_STALE_MS) {
      return true;
    }
  }
  const runtimeStatus = String(
    conversation?.runtimeSessionStatus
    || conversation?.runtime_session_status
    || conversation?.status
    || '',
  ).trim().toLowerCase();
  return runtimeStatus === 'processing';
}

function ensureProcessingDotTimer(enabled) {
  if (enabled) {
    if (processingDotTimer) return;
    processingDotTimer = setInterval(() => {
      processingDotFrame = (processingDotFrame + 1) % PROCESSING_DOT_FRAMES.length;
      renderConvList();
    }, PROCESSING_DOT_INTERVAL_MS);
    return;
  }
  if (processingDotTimer) {
    clearInterval(processingDotTimer);
    processingDotTimer = null;
  }
  processingDotFrame = 0;
}

export async function loadConversations() {
  await refreshConversations({ preservePagination: false });
  const lastId = localStorage.getItem('copilot_last_conv');
  if (lastId) await openConversation(lastId, { restoreScroll: true });
}

export async function refreshConversations(options = {}) {
  const preservePagination = options?.preservePagination !== false;
  const r = await loadConversationsApi({ limit: CONVERSATION_LIST_PAGE_SIZE });
  if (!r) return;
  if (Array.isArray(r.knownConversationIds)) {
    const knownConversationIds = new Set(
      r.knownConversationIds
        .map((id) => String(id || '').trim())
        .filter(Boolean),
    );
    for (const id of Object.keys(conversations)) {
      if (!knownConversationIds.has(id)) delete conversations[id];
    }
  }
  applyConversationPage(r.conversations || []);
  resetConversationListPageState(r.pageInfo || null, {
    preserveProgress: preservePagination,
  });
  renderConvList();
  updateCompactButton();
}

export function renderConvList() {
  const list = document.getElementById('conv-list');
  const sorted = Object.values(conversations).sort((a, b) => {
    const updatedAtDelta = parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt);
    if (updatedAtDelta !== 0) return updatedAtDelta;
    return String(b?.id || '').trim().localeCompare(String(a?.id || '').trim());
  });
  const pendingByConversation = getPendingQuestionCountsByConversation();
  let hasProcessingConversation = false;
  const footerHtml = (() => {
    if (conversationListPaginationState.isLoading) {
      return '<div class="conv-list-footer">Loading older conversations…</div>';
    }
    if (conversationListPaginationState.hasMore || conversationListPaginationState.isPrefetching) {
      return '<div class="conv-list-footer">Scroll for older conversations</div>';
    }
    return '';
  })();
  if (sorted.length === 0) {
    ensureProcessingDotTimer(false);
    list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:0.85rem;text-align:center">No conversations yet</div>';
    return;
  }
  const conversationView = (conversation) => {
    const pendingCount = Number(pendingByConversation[conversation?.id] || 0);
    const sdkSessionId = String(conversation?.sdkSessionId || '').trim();
    const workerState = sdkSessionId ? getSessionWorkerState(sdkSessionId) : null;
    const visualState = resolveConversationUiState({
      conversation,
      workerState,
      hasPendingQuestion: pendingCount > 0,
    });
    const processing = isConversationProcessing(conversation, workerState);
    if (processing) hasProcessingConversation = true;
    return { visualState, processing };
  };
  list.innerHTML = `${sorted.map((c) => {
    const view = conversationView(c);
    const processingDots = view.processing ? PROCESSING_DOT_FRAMES[processingDotFrame] : '';
    const providerIndicatorLabel = conversationProviderIndicatorLabel(c);
    const providerIndicatorKey = conversationProviderIndicatorKey(c);
    const providerIndicatorHtml = providerIndicatorLabel
      ? `<span class="conv-provider-indicator"${providerIndicatorKey ? ` data-provider="${providerIndicatorKey}"` : ''}>${providerIndicatorLabel}</span>`
      : '';
    return `
    <div class="conv-item worker-ui-${view.visualState}${c.id === currentConvId ? ' active' : ''}" onclick="openConversation('${c.id}')">
      <div class="conv-title">${escHtml(c.title)}${processingDots ? `<span class="conv-processing-dots">${escHtml(` ${processingDots}`)}</span>` : ''}${c.archived ? ' <span style="font-size:0.68rem;color:var(--muted)">(archived)</span>' : ''}${pendingByConversation[c.id] ? ` <span class="conv-open-questions">${pendingByConversation[c.id]} open</span>` : ''}</div>
      <div class="conv-meta"><span class="conv-meta-primary">${fmtDate(c.updatedAt)} · ${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}</span>${providerIndicatorHtml}</div>
      <button class="conv-delete" onclick="deleteConv(event,'${c.id}')" title="Delete">🗑</button>
    </div>`;
  }).join('')}${footerHtml}`;
  ensureProcessingDotTimer(hasProcessingConversation);
  window.syncChatTitleControls?.();
  scheduleConversationListBoundaryCheck();
}

export function applyLoadedConversationState(id, response, {
  restoreScroll = false,
  savedScrollTop = null,
  followLiveUpdates = !restoreScroll,
} = {}) {
  if (!response) {
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
    window.syncChatTitleControls?.();
    return;
  }
  const existingConversation = conversations[id] || {};
  upsertConversationRecord({
    ...existingConversation,
    id: id,
    sdkSessionId: response.sdkSessionId ?? existingConversation.sdkSessionId ?? null,
    title: response.title ?? existingConversation.title ?? id,
    archived: response.archived ?? existingConversation.archived ?? false,
    compactedInto: response.compactedInto ?? existingConversation.compactedInto ?? null,
    compactedFrom: response.compactedFrom ?? existingConversation.compactedFrom ?? null,
    updatedAt: response.updatedAt ?? existingConversation.updatedAt ?? new Date().toISOString(),
    preferredRelayMode: response.preferredRelayMode ?? existingConversation.preferredRelayMode,
    preferredModel: response.preferredModel ?? existingConversation.preferredModel,
    preferredReasoningEffort: response.preferredReasoningEffort ?? existingConversation.preferredReasoningEffort,
    configuredWorkspaceRootPath: response.configuredWorkspaceRootPath ?? existingConversation.configuredWorkspaceRootPath ?? null,
    configuredWorkspaceRootName: response.configuredWorkspaceRootName ?? existingConversation.configuredWorkspaceRootName ?? null,
    runtimeWorkspaceRootPath: response.runtimeWorkspaceRootPath ?? existingConversation.runtimeWorkspaceRootPath ?? null,
    runtimeWorkspaceRootName: response.runtimeWorkspaceRootName ?? existingConversation.runtimeWorkspaceRootName ?? null,
    currentWorkspaceRootPath: response.currentWorkspaceRootPath ?? existingConversation.currentWorkspaceRootPath ?? null,
    currentWorkspaceRootName: response.currentWorkspaceRootName ?? existingConversation.currentWorkspaceRootName ?? null,
    runtimeProviderType: response.runtimeSession?.providerType
      ?? existingConversation.runtimeProviderType
      ?? 'github',
    runtimeProviderModel: response.runtimeSession?.providerModel
      ?? existingConversation.runtimeProviderModel
      ?? null,
    runtimeModel: response.runtimeSession?.model
      ?? existingConversation.runtimeModel
      ?? null,
    sessionUsageSummary: response.sessionUsageSummary ?? existingConversation.sessionUsageSummary ?? null,
    messageCount: Array.isArray(response.messages)
      ? Math.max(existingConversation.messageCount || 0, response.messages.length)
      : (existingConversation.messageCount || 0),
  });
  renderConvList();
  window.applyConversationPreferences?.(id, {
    preferredRelayMode: response.preferredRelayMode,
    preferredModel: response.preferredModel,
    preferredReasoningEffort: response.preferredReasoningEffort,
  });
  setRepoBrowserSessionInfo(response.sessionRootPath || '', response.sessionRootName || response.title || '');
  if (repoBrowserState.open && repoBrowserState.activeRoot === 'workspace') {
    void loadRepoBrowserTree();
  }
  const didRenderMessages = renderMessages(response.messages, !restoreScroll, response);
  hydrateConversationDraft(id, {
    draftText: response.draftText,
    draftUpdatedAt: response.draftUpdatedAt,
    draftUpdatedByClientId: response.draftUpdatedByClientId,
  });
  restoreInFlightThinking(response.inFlight || null, followLiveUpdates);
  updateSessionPill(conversations[id], response.runtimeSession || null);
  window.syncChatTitleControls?.();
  if (!restoreScroll || !didRenderMessages) return;
  const el = document.getElementById('messages');
  if (!el) return;
  if (Number.isFinite(savedScrollTop)) {
    el.scrollTop = savedScrollTop;
    saveConversationScrollTop(id, el.scrollTop);
    return;
  }
  el.scrollTop = el.scrollHeight;
  saveConversationScrollTop(id, el.scrollTop);
}

export async function openConversation(id, options = {}) {
  const didLeaveStatusView = leaveStatusView();
  document.getElementById('input-area')?.removeAttribute('hidden');
  const previousConversationId = String(currentConvId || '').trim();
  const nextConversationId = String(id || '').trim();
  if (previousConversationId && nextConversationId && previousConversationId !== nextConversationId) {
    await flushConversationDraft(previousConversationId);
    window.clearImageEditTarget?.();
  }
  const capturedVersion = ++openConversationVersion;
  setCurrentConv(id);
  if (repoBrowserState.activeRoot === 'workspace') {
    repoBrowserState.tree = null;
    repoBrowserState.nodeMap = new Map();
    repoBrowserState.currentPath = '';
    repoBrowserState.truncated = false;
    repoBrowserState.nodeCount = 0;
    repoBrowserState.maxNodes = 0;
    repoBrowserState.loadingPath = '';
    repoBrowserState.error = '';
  }
  closeSidebar();
  clearAttachments();
  document.getElementById('chat-title').textContent = conversations[id]?.title || id;
  if (didLeaveStatusView) {
    restoreInFlightThinking(null);
    renderMessages([]);
  }
  window.syncChatTitleControls?.();
  updateSessionPill(conversations[id], null);
  updateCompactButton();
  renderConvList();
  if (repoBrowserState.open && repoBrowserState.activeRoot === 'workspace') {
    void loadRepoBrowserTree();
  }

  const focusMessageId = String(options.focusMessageId || '').trim();
  const aroundMessageId = String(options.aroundMessageId || focusMessageId || '').trim();
  const forceFreshWindow = !!aroundMessageId;
  const savedScrollTop = loadConversationScrollTop(id);
  const restoreScroll = !forceFreshWindow && Number.isFinite(savedScrollTop);
  const savedLoadedCount = loadConversationLoadedMessageCount(id);
  const requestLimit = forceFreshWindow
    ? 40
    : (Number.isFinite(savedLoadedCount)
      ? Math.max(20, savedLoadedCount)
      : 20);
  const r = await loadConversation(id, {
    limit: requestLimit,
    aroundMessageId: aroundMessageId || undefined,
  });
  if (!shouldApplyConversationLoad({
    requestedConversationId: id,
    activeConversationId: currentConvId,
    capturedVersion,
    currentVersion: openConversationVersion,
  })) {
    return;
  }
  if (r) {
    applyLoadedConversationState(id, r, { restoreScroll, savedScrollTop });
    if (focusMessageId) {
      requestAnimationFrame(() => {
        focusConversationMessageById(focusMessageId, { behavior: 'smooth', block: 'center' });
      });
    }
  } else {
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
  }
  await loadRelayQuestions(id);
  await loadRelayBoards();
  if (!shouldApplyConversationLoad({
    requestedConversationId: id,
    activeConversationId: currentConvId,
    capturedVersion,
    currentVersion: openConversationVersion,
  })) {
    return;
  }
  applyContextUsageBar(null);
  scheduleContextUsageRefresh(id, 0);
  const composer = document.getElementById('msg-input');
  if (isMobileComposerViewport()) {
    releaseComposerFocusAfterSend(composer);
  } else {
    composer.focus();
  }
}

function normalizeNewConversationProviderType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-byok') return 'openai';
  if (normalized === 'openai-image' || normalized === 'openai-image-byok') return 'openai-image';
  if (normalized === 'claude') return 'claude';
  if (normalized === 'cursor') return 'cursor';
  return 'github';
}

function bootstrapProviderType(providerType = 'github') {
  const normalized = normalizeNewConversationProviderType(providerType);
  return normalized === 'openai-image' ? 'openai' : normalized;
}

function isOpenAIImageModelId(modelId = '') {
  const value = String(modelId || '').trim().toLowerCase().replace(/^openai\//, '');
  return value.startsWith('gpt-image-') || value.startsWith('dall-e-');
}

function isLikelyOpenAIModelId(modelId = '') {
  const value = String(modelId || '').trim().toLowerCase().replace(/^openai\//, '');
  if (!value) return false;
  return /^gpt-/.test(value) || /^o[134](?:[.-]|$)/.test(value) || /^codex(?:[.-]|$)/.test(value);
}

function modelProvidersForCatalogModel(catalog = {}, modelId = '') {
  const key = String(modelId || '').trim().toLowerCase();
  if (!key) return [];
  const providers = catalog?.providersByModel?.[key];
  if (!Array.isArray(providers)) return [];
  return providers.map((provider) => String(provider || '').trim().toLowerCase()).filter(Boolean);
}

function modelMatchesNewConversationProvider(catalog = {}, modelId = '', providerType = 'github') {
  const normalizedModelId = String(modelId || '').trim();
  if (!normalizedModelId) return false;
  const providers = modelProvidersForCatalogModel(catalog, modelId);
  const normalizedProvider = normalizeNewConversationProviderType(providerType);
  const wantsOpenAI = normalizedProvider === 'openai' || normalizedProvider === 'openai-image';
  const hasOpenAIByok = providers.includes('openai-byok');
  const hasClaude = providers.includes('claude');
  const hasCursor = providers.includes('cursor');
  if (wantsOpenAI) {
    if (hasOpenAIByok) return true;
    const settingsModel = String(newConversationOpenAISettingsCache?.model || '').trim();
    const settingsModels = Array.isArray(newConversationOpenAISettingsCache?.models)
      ? newConversationOpenAISettingsCache.models.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    if (normalizedModelId === settingsModel || settingsModels.includes(normalizedModelId)) return true;
    // Fallback when provider metadata is temporarily stale/missing.
    if (providers.length === 0 && isLikelyOpenAIModelId(normalizedModelId)) return true;
    return false;
  }
  if (normalizedProvider === 'claude') {
    if (hasClaude) return true;
    const claudeModel = String(newConversationClaudeSettingsCache?.model || '').trim();
    const claudeModels = Array.isArray(newConversationClaudeSettingsCache?.models)
      ? newConversationClaudeSettingsCache.models.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    return normalizedModelId === claudeModel || claudeModels.includes(normalizedModelId);
  }
  if (normalizedProvider === 'cursor') {
    if (hasCursor) return true;
    const cursorModel = String(newConversationCursorSettingsCache?.model || '').trim();
    const cursorModels = Array.isArray(newConversationCursorSettingsCache?.models)
      ? newConversationCursorSettingsCache.models.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    return normalizedModelId === cursorModel || cursorModels.includes(normalizedModelId);
  }
  const claudeOnly = hasClaude && providers.every((provider) => provider === 'claude');
  if (claudeOnly) return false;
  const cursorOnly = hasCursor && providers.every((provider) => provider === 'cursor');
  if (cursorOnly) return false;
  return providers.some((provider) => provider !== 'openai-byok' && provider !== 'claude' && provider !== 'cursor') || !hasOpenAIByok;
}

function openAIImageSizesForModel(modelId = '') {
  const normalizedModel = String(modelId || '').trim().toLowerCase().replace(/^openai\//, '');
  if (normalizedModel.startsWith('dall-e-2')) return ['256x256', '512x512', '1024x1024'];
  if (normalizedModel.startsWith('dall-e-3')) return ['1024x1024', '1792x1024', '1024x1792'];
  return ['auto', '1024x1024', '1536x1024', '1024x1536'];
}

function syncNewConversationReasoningLabel(providerType = 'github') {
  const label = document.querySelector('label[for="new-conversation-reasoning-select"]');
  if (!label) return;
  label.textContent = normalizeNewConversationProviderType(providerType) === 'openai-image'
    ? 'Quality'
    : 'Reasoning effort';
}

function populateNewConversationSizeSelect(providerType = 'github', selectedModel = '') {
  const select = document.getElementById('new-conversation-size-select');
  const row = document.getElementById('new-conversation-size-row');
  const status = document.getElementById('new-conversation-size-status');
  if (!select || !row) return;
  const normalizedProvider = normalizeNewConversationProviderType(providerType);
  if (normalizedProvider !== 'openai-image') {
    row.style.display = 'none';
    select.innerHTML = '';
    return;
  }
  row.style.display = 'block';
  const sizes = openAIImageSizesForModel(selectedModel);
  const preferred = String(localStorage.getItem(OPENAI_IMAGE_SIZE_STORAGE_KEY) || '').trim().toLowerCase();
  select.innerHTML = '';
  for (const size of sizes) {
    const option = document.createElement('option');
    option.value = size;
    option.textContent = size;
    select.appendChild(option);
  }
  select.value = sizes.includes(preferred) ? preferred : sizes[0];
  if (status) status.textContent = 'Image size used for generated outputs in this chat.';
}

async function populateNewConversationReasoningSelect(selectedModel = '') {
  const select = document.getElementById('new-conversation-reasoning-select');
  const status = document.getElementById('new-conversation-reasoning-status');
  if (!select) return;
  const modelId = String(selectedModel || '').trim().toLowerCase();
  if (!modelId) {
    select.innerHTML = '';
    select.disabled = true;
    if (status) status.textContent = 'No model selected.';
    return;
  }
  const provider = normalizeNewConversationProviderType(
    String(document.getElementById('new-conversation-provider-select')?.value || '').trim().toLowerCase(),
  );
  syncNewConversationReasoningLabel(provider);
  const catalog = newConversationCatalogCache || await loadModelCatalog() || {};
  const efforts = reasoningChoicesForProviderModel(catalog || {}, {
    provider: provider === 'openai-image' ? 'openai' : provider,
    modelId,
  });
  select.innerHTML = '';
  if (!efforts.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Unavailable';
    select.appendChild(option);
    select.value = '';
    select.disabled = true;
    if (status) status.textContent = 'Reasoning metadata unavailable for this model.';
    return;
  }
  for (const effort of efforts) {
    const option = document.createElement('option');
    option.value = effort;
    option.textContent = effort;
    select.appendChild(option);
  }
  const preferred = resolvePreferredReasoningEffort(efforts, [
    localStorage.getItem(REASONING_STORAGE_KEY),
  ]);
  select.value = preferred || efforts[0];
  select.disabled = false;
  if (status) {
    status.textContent = provider === 'openai-image'
      ? 'Choose output quality for generated images.'
      : 'Choose the effort used when this conversation starts.';
  }
}

function updateNewConversationProviderHelp(provider = 'github') {
  const help = document.getElementById('new-conversation-provider-help');
  if (!help) return;
  const normalizedProvider = normalizeNewConversationProviderType(provider);
  if (normalizedProvider === 'openai-image') {
    help.textContent = 'OpenAI image chats call the Images API directly using your BYOK key.';
    return;
  }
  if (normalizedProvider === 'openai') {
    help.textContent = 'OpenAI models use your saved BYOK API key.';
    return;
  }
  if (normalizedProvider === 'claude') {
    help.textContent = "Claude chats run through the Claude Agent SDK with the relay host's Claude login.";
    return;
  }
  if (normalizedProvider === 'cursor') {
    help.textContent = 'Cursor chats run through the Cursor Agent SDK using your saved Cursor API key.';
    return;
  }
  help.textContent = 'Copilot models use your GitHub Copilot runtime.';
}

async function populateNewConversationModelSelect(providerType = 'github') {
  const target = document.getElementById('new-conversation-model-select');
  if (!target) return false;
  target.innerHTML = '';
  const source = document.getElementById('model-select');
  const sourceLabelByValue = new Map(
    Array.from(source?.options || []).map((option) => [
      String(option.value || '').trim(),
      String(option.textContent || option.value || '').trim(),
    ]),
  );
  const catalog = newConversationCatalogCache || await loadModelCatalog();
  if (!catalog || !Array.isArray(catalog.models)) return false;
  const normalizedProvider = normalizeNewConversationProviderType(providerType);
  const choices = buildNewConversationModelChoices(
    catalog.models
      .filter((modelId) => modelMatchesNewConversationProvider(catalog, modelId, normalizedProvider))
      .filter((modelId) => (
        normalizedProvider !== 'openai-image' || isOpenAIImageModelId(modelId)
      ))
      .map((modelId) => {
        const value = String(modelId || '').trim();
        return {
          value,
          label: sourceLabelByValue.get(value) || value,
        };
      }),
  );
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    target.appendChild(option);
  }
  if (!target.options.length) return false;
  const storedModel = String(localStorage.getItem('copilot_model') || '').trim();
  if (storedModel && Array.from(target.options).some((option) => option.value === storedModel)) {
    target.value = storedModel;
  } else if (normalizedProvider !== 'openai-image' && Array.from(target.options).some((option) => option.value === 'auto')) {
    target.value = 'auto';
  }
  updateNewConversationProviderHelp(normalizedProvider);
  syncNewConversationReasoningLabel(normalizedProvider);
  populateNewConversationSizeSelect(normalizedProvider, target.value);
  await populateNewConversationReasoningSelect(target.value);
  return true;
}

async function openNewConversationModelModal() {
  const [catalog, settings, claudeSettings, cursorSettings] = await Promise.all([
    loadModelCatalog(),
    loadOpenAISettings(),
    loadClaudeSettings(),
    loadCursorSettings(),
  ]);
  newConversationCatalogCache = catalog || null;
  newConversationOpenAISettingsCache = settings || null;
  newConversationClaudeSettingsCache = claudeSettings || null;
  newConversationCursorSettingsCache = cursorSettings || null;
  const providerSelect = document.getElementById('new-conversation-provider-select');
  if (providerSelect) {
    const options = [{ value: 'github', label: 'Copilot' }];
    if (settings?.enabled === true) {
      options.push({ value: 'openai', label: 'OpenAI (BYOK)' });
      options.push({ value: 'openai-image', label: 'OpenAI Image (BYOK)' });
    }
    if (claudeSettings?.enabled === true) {
      options.push({ value: 'claude', label: 'Claude (Agent SDK)' });
    }
    if (cursorSettings?.enabled === true) {
      options.push({ value: 'cursor', label: 'Cursor (Agent SDK)' });
    }
    providerSelect.innerHTML = '';
    for (const option of options) {
      const entry = document.createElement('option');
      entry.value = option.value;
      entry.textContent = option.label;
      providerSelect.appendChild(entry);
    }
    const preferredProvider = 'github';
    providerSelect.value = options.some((option) => option.value === preferredProvider)
      ? preferredProvider
      : options[0].value;
    if (providerSelect.dataset.modelsBound !== '1') {
      providerSelect.dataset.modelsBound = '1';
      providerSelect.addEventListener('change', () => {
        void populateNewConversationModelSelect(providerSelect.value);
      });
    }
  }

  if (!(await populateNewConversationModelSelect(providerSelect?.value || 'github'))) {
    showTransientRelayNotice('No model is currently available for a new conversation.', 5000);
    return;
  }
  const modelSelect = document.getElementById('new-conversation-model-select');
  if (modelSelect && modelSelect.dataset.reasoningBound !== '1') {
    modelSelect.dataset.reasoningBound = '1';
    modelSelect.addEventListener('change', () => {
      const provider = String(document.getElementById('new-conversation-provider-select')?.value || '').trim();
      populateNewConversationSizeSelect(provider, modelSelect.value);
      void populateNewConversationReasoningSelect(modelSelect.value);
    });
  }
  const modal = document.getElementById('new-conversation-model-modal');
  if (!modal) return;
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => document.getElementById('new-conversation-model-select')?.focus(), 0);
}

export function closeNewConversationModelModal() {
  if (newConversationInFlight) return;
  const modal = document.getElementById('new-conversation-model-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
}

function persistReasoningSelection(reasoningEffort = '') {
  const effort = String(reasoningEffort || '').trim().toLowerCase();
  if (!effort) return;
  localStorage.setItem(REASONING_STORAGE_KEY, effort);
  const composerReasoningSelect = document.getElementById('reasoning-effort-select');
  if (composerReasoningSelect && Array.from(composerReasoningSelect.options || []).some((option) => option.value === effort)) {
    composerReasoningSelect.value = effort;
  }
}

async function createNewConversation(selectedModel, selectedReasoningEffort = '') {
  if (newConversationInFlight) return;
  newConversationInFlight = true;
  const confirmButton = document.getElementById('new-conversation-model-confirm');
  if (confirmButton) confirmButton.disabled = true;
  persistReasoningSelection(selectedReasoningEffort);
  const selectedProvider = normalizeNewConversationProviderType(
    String(document.getElementById('new-conversation-provider-select')?.value || '').trim(),
  );
  const selectedSize = String(document.getElementById('new-conversation-size-select')?.value || '').trim().toLowerCase();
  if (selectedProvider === 'openai-image' && selectedSize) {
    localStorage.setItem(OPENAI_IMAGE_SIZE_STORAGE_KEY, selectedSize);
  }
  try {
    const result = await bootstrapConversationSession({
      model: selectedModel || undefined,
      providerType: bootstrapProviderType(selectedProvider),
      reasoningEffort: String(selectedReasoningEffort || '').trim().toLowerCase() || undefined,
      title: 'New Conversation',
    });
    const nextConversationId = String(result?.conversationId || '').trim();
    if (!nextConversationId) {
      showTransientRelayNotice('Could not start a new conversation session. Please try again.');
      return;
    }
    const bootstrappedModel = String(result?.selectedModel || '').trim();
    if (bootstrappedModel) {
      localStorage.setItem('copilot_model', bootstrappedModel);
      const modelSelect = document.getElementById('model-select');
      if (Array.from(modelSelect?.options || []).some((option) => option.value === bootstrappedModel)) {
        modelSelect.value = bootstrappedModel;
      }
    }
    await refreshConversations();
    await openConversation(nextConversationId);
    if (selectedProvider === 'openai-image') {
      const contextTierSelect = document.getElementById('context-tier-select');
      if (contextTierSelect && selectedSize && Array.from(contextTierSelect.options).some((option) => option.value === selectedSize)) {
        contextTierSelect.value = selectedSize;
      }
    }
    if (result?.warning) {
      showTransientRelayNotice(String(result.warning), 6000);
    }
    if (result?.defaultSessionWorkspaceRootWarning) {
      showTransientRelayNotice(String(result.defaultSessionWorkspaceRootWarning), 7000);
    }
  } catch (error) {
    showTransientRelayNotice(error?.message || 'Could not start a new conversation session.');
  } finally {
    newConversationInFlight = false;
    if (confirmButton) confirmButton.disabled = false;
  }
}

export async function confirmNewConversationModel() {
  if (newConversationInFlight) return;
  const selectedModel = String(document.getElementById('new-conversation-model-select')?.value || '').trim();
  const selectedReasoningEffort = String(document.getElementById('new-conversation-reasoning-select')?.value || '').trim().toLowerCase();
  if (!selectedModel) return;
  const modal = document.getElementById('new-conversation-model-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
  await createNewConversation(selectedModel, selectedReasoningEffort);
}

export async function newConversation() {
  if (IS_SHARED_VIEW) {
    showTransientRelayNotice('Shared conversations are read-only.');
    return;
  }
  if (newConversationInFlight) return;
  // The provider picker is only useful when a managed provider can actually be
  // selected; with Copilot alone the plain model-select path suffices.
  const [openAISettings, claudeSettings, cursorSettings] = await Promise.all([
    loadOpenAISettings(),
    loadClaudeSettings(),
    loadCursorSettings(),
  ]);
  const anyManagedProviderEnabled = openAISettings?.enabled === true
    || claudeSettings?.enabled === true
    || cursorSettings?.enabled === true;
  if (anyManagedProviderEnabled) {
    void openNewConversationModelModal();
    return;
  }
  const selectedModel = String(document.getElementById('model-select')?.value || '').trim();
  await createNewConversation(selectedModel);
}

export function initConversationListLazyLoading() {
  const el = getConversationListElement();
  if (!el || el.dataset.lazyLoadBound === '1') return;
  el.dataset.lazyLoadBound = '1';
  el.addEventListener('scroll', () => {
    conversationListAutoLoadBlockedUntil = 0;
    void conversationListLoader.handleBoundaryDistance(getConversationListBoundaryDistance());
  }, { passive: true });
  scheduleConversationListBoundaryCheck();
}

export async function deleteConv(e, id) {
  e.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  const result = await deleteConversationApi(id);
  if (!result) return;
  delete conversations[id];
  renderConvList();
  if (currentConvId === id) {
    setCurrentConv(null);
    clearAttachments();
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
    document.getElementById('chat-title').textContent = 'Select or start a conversation';
    window.syncChatTitleControls?.();
    updateSessionPill(null, null);
    updateCompactButton();
    scheduleContextUsageRefresh(null);
  }
}
