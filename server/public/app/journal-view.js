import {
  conversations,
  currentConvId,
  workspaceRootPath,
  defaultSessionWorkspaceRootPath,
  getConversationCurrentWorkspaceRootPath,
  getRecentWorkspaceRoots,
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
  archiveConversation as archiveConversationApi,
  unarchiveConversation as unarchiveConversationApi,
  bootstrapConversationSession,
  scheduleContextUsageRefresh,
  loadModelCatalog,
  loadClaudeSettings,
  loadClaudeCloudSettings,
  loadCursorSettings,
  loadGitRemote,
  loadClaudeCloudBranches,
  loadClaudeCloudRepos,
  loadGrokSettings,
  loadOpenAISettings,
} from './api-client.js';
import { renderMessages, restoreInFlightThinking, focusConversationMessageById, noteTranscriptJump, flushConversationDraft, hydrateConversationDraft, beginConversationDraftSwitch, openStopTurnConfirmationForConversation, conversationHasActiveTurn } from './conversation-view.js';
import { MENU_SEPARATOR, bindLongPress, closeContextMenu, openContextMenu } from './context-menu.mjs';
import { setBackgroundTasksConversation, setConversationBackgroundTasks } from './background-tasks-view.mjs';
import { setConversationPins, setPinsConversation } from './pinned-messages-view.mjs';
import { setUsageLimitConversation } from './usage-limit-ui.js';
import { mergeConversationPreviews } from './preview-cards.mjs';
import { loadRelayQuestions, getPendingQuestionCountsByConversation } from './ask-user-view.js';
import { loadRelayBoards } from './relay-board-view.js';
import { clearAttachments, setRepoBrowserSessionInfo, loadRepoBrowserTree, getRepoBrowserLaunchCwdPath, openRepoBrowserForCwdPick } from './attachments-view.js';
import { buildKnownCwdOptions, normalizeKnownCwdPath } from './known-cwd-options.mjs';
import { shouldApplyConversationLoad } from './activity-replay-state.mjs';
import { createInfiniteLoader } from './infinite-loader.js';
import {
  buildNewConversationModelChoices,
  newConversationContextTierState,
  reasoningChoicesForProviderModel,
  resolvePreferredReasoningEffort,
} from './new-conversation-model-choice.mjs';
import { buildCatalogModelOptions } from './model-selector-options.mjs';
import { isReasoningOffUnsupported, reasoningEffortOptionLabel, reasoningEffortOptionTitle } from './reasoning-effort-labels.mjs';
import {
  conversationProviderIndicatorKey,
  conversationProviderIndicatorLabel,
} from './conversation-provider-indicator.mjs';
import { leaveStatusView } from './status-view.mjs';
import {
  CLAUDE_CLOUD_PROVIDER,
  buildCloudSourceWarnings,
  claudeCloudDefaultModel,
  claudeCloudModelIds,
  cloudBootstrapErrorModel,
  cloudFolderStatusText,
  cloudRepoAccess,
  cloudRepoSuggestionMeta,
  filterCloudBranchSuggestions,
  filterCloudRepoSuggestions,
  isClaudeCloudConversation,
  newChatRowVisibility,
  normalizeCloudRepoInput,
  resolveCloudSourceAutoFill,
  validateCloudSourceInputs,
} from './claude-cloud-ui.mjs';
import { renderConversationOriginMarkerHtml } from './remote-relay-origin-view.mjs';
import {
  normalizeConversationFilter,
  filterConversations,
  drainRemainingPages,
  describeFilterMatchCount,
} from './conversation-list-filter.mjs';

const PROCESSING_DOT_FRAMES = ['   ', '.  ', '.. ', '...'];
const PROCESSING_DOT_INTERVAL_MS = 1000;
const LOCAL_PROCESSING_STALE_MS = 5 * 60 * 1000;
const CONVERSATION_LIST_PAGE_SIZE = 40;
const REASONING_STORAGE_KEY = 'copilot_selected_reasoning_effort';
// Shared with the composer (bootstrap.js). The modal used to read and write its
// own 'copilot_model' key, so a New Chat selection never reached the composer.
// (bootstrap.js migrates the old key on startup.)
const MODEL_STORAGE_KEY = 'copilot_selected_model';
const MODE_STORAGE_KEY = 'copilot_selected_mode';
// Claude 1M-context ids are stored as "model[1m]"; the modal only offers base ids.
const CLAUDE_LONG_CONTEXT_PATTERN = /\[1m\]$/i;
const OPENAI_IMAGE_SIZE_STORAGE_KEY = 'copilot_openai_image_size';
const NEW_CHAT_CWD_STORAGE_KEY = 'copilot_new_chat_cwd';
const NEW_CHAT_CUSTOM_CWD_VALUE = '__custom__';
const CONV_FILTER_DEBOUNCE_MS = 220;
let processingDotFrame = 0;
let processingDotTimer = null;
let lastConvListHtml = '';
let conversationListFilterText = '';
let conversationFilterDrainActive = false;
let conversationFilterGeneration = 0;
let openConversationVersion = 0;
let newConversationInFlight = false;

// New Chat stays in flight until the created conversation is open, which takes
// a sidebar refresh and a full message load. The button has to say so: it used
// to look enabled the whole time while silently ignoring clicks.
function setNewConversationInFlight(inFlight) {
  newConversationInFlight = inFlight;
  const button = document.getElementById('new-conv-btn');
  if (!button) return;
  button.disabled = inFlight;
  if (inFlight) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}
let newConversationCatalogCache = null;
let newConversationOpenAISettingsCache = null;
let newConversationClaudeSettingsCache = null;
let newConversationCursorSettingsCache = null;
let newConversationGrokSettingsCache = null;
let newConversationClaudeCloudSettingsCache = null;
// Claude Cloud fields of the New Chat modal: what the selected folder's git
// remote said, and what was written into Repository/Branch from it (so a later
// lookup can tell its own fill from something the user typed).
const NEW_CHAT_CLOUD_LOOKUP_DEBOUNCE_MS = 350;
let newConversationCloudRemote = null;
let newConversationCloudLookupFailed = false;
let newConversationCloudLookupFolder = null;
let newConversationCloudAutoFill = null;
let newConversationCloudLookupSeq = 0;
let newConversationCloudLookupTimer = null;
// Suggestions under the two fields: the repositories the Claude GitHub app
// can reach plus the ones used in earlier cloud chats here (one read per
// open), and the branches of the repository in the field (read when it
// changes). `branchAutoFill` is what a folder lookup or a pick wrote into
// Branch, so a later pick may replace it while a typed branch stays.
let newConversationCloudRepoList = null;
let newConversationCloudRepoListPromise = null;
let newConversationCloudBranchList = null;
let newConversationCloudBranchSeq = 0;
let newConversationCloudBranchTimer = null;
let newConversationCloudBranchAutoFill = '';
const newConversationCloudSuggestActive = { repo: -1, branch: -1 };
const NEW_CHAT_CLOUD_SUGGEST_BLUR_MS = 150;
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
      archived: conversationListArchivedView ? 'only' : '',
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
      // Touch only the dot spans: rewriting the whole list every second kills
      // sidebar selections and burns battery for a spinner frame.
      const frame = PROCESSING_DOT_FRAMES[processingDotFrame];
      document.querySelectorAll('#conv-list .conv-processing-dots').forEach((el) => {
        el.textContent = ` ${frame}`;
      });
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
  const r = await loadConversationsApi({
    limit: CONVERSATION_LIST_PAGE_SIZE,
    archived: conversationListArchivedView ? 'only' : '',
  });
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
  // A reset bumps the loader version, which aborts any in-flight filter drain;
  // restart it so an active filter keeps covering the unloaded pages.
  if (normalizeConversationFilter(conversationListFilterText)) {
    void drainConversationListForFilter();
  }
}

export function renderConvList() {
  const list = document.getElementById('conv-list');
  const sorted = Object.values(conversations).sort((a, b) => {
    const updatedAtDelta = parseTimestampMs(b.updatedAt) - parseTimestampMs(a.updatedAt);
    if (updatedAtDelta !== 0) return updatedAtDelta;
    return String(b?.id || '').trim().localeCompare(String(a?.id || '').trim());
  });
  const activeFilter = normalizeConversationFilter(conversationListFilterText);
  // The live list and the Archived view are two views of the same records.
  const inView = sorted.filter((conversation) => (conversation?.archived === true) === conversationListArchivedView);
  const visible = activeFilter ? filterConversations(inView, activeFilter) : inView;
  const pendingByConversation = getPendingQuestionCountsByConversation();
  let hasProcessingConversation = false;
  const footerHtml = (() => {
    if (activeFilter) {
      // While a filter is active the drain loads older pages by itself; a
      // "scroll for more" hint would point at a gesture that does nothing, and
      // "Searching…" must only show while something is actually loading.
      return (conversationFilterDrainActive || conversationListPaginationState.isLoading)
        ? '<div class="conv-list-footer">Searching older conversations…</div>'
        : '';
    }
    if (conversationListPaginationState.isLoading) {
      return '<div class="conv-list-footer">Loading older conversations…</div>';
    }
    if (conversationListPaginationState.hasMore || conversationListPaginationState.isPrefetching) {
      return '<div class="conv-list-footer">Scroll for older conversations</div>';
    }
    return '';
  })();
  if (visible.length === 0) {
    ensureProcessingDotTimer(false);
    const emptyText = activeFilter && inView.length > 0
      ? 'No conversations match your filter'
      : (conversationListArchivedView ? 'No archived conversations' : 'No conversations yet');
    list.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:0.85rem;text-align:center">${emptyText}</div>${footerHtml}`;
    lastConvListHtml = '';
    scheduleConversationListBoundaryCheck();
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
  const listHtml = `${visible.map((c) => {
    const view = conversationView(c);
    const processingDots = view.processing ? PROCESSING_DOT_FRAMES[processingDotFrame] : '';
    const providerIndicatorLabel = conversationProviderIndicatorLabel(c);
    const providerIndicatorKey = conversationProviderIndicatorKey(c);
    const providerIndicatorHtml = providerIndicatorLabel
      ? `<span class="conv-provider-indicator"${providerIndicatorKey ? ` data-provider="${providerIndicatorKey}"` : ''}>${providerIndicatorLabel}</span>`
      : '';
    // "↗ win-test": another relay's agent created this conversation.
    // "via agent · “title”": an agent in that conversation on this relay did.
    const originMarkerHtml = renderConversationOriginMarkerHtml(c, { conversations });
    return `
    <div class="conv-item worker-ui-${view.visualState}${c.id === currentConvId ? ' active' : ''}${c.archived ? ' archived' : ''}" data-conversation-id="${c.id}" onclick="openConversation('${c.id}')">
      <div class="conv-title">${escHtml(c.title)}${processingDots ? `<span class="conv-processing-dots">${escHtml(` ${processingDots}`)}</span>` : ''}${pendingByConversation[c.id] ? ` <span class="conv-open-questions">${pendingByConversation[c.id]} open</span>` : ''}</div>
      <div class="conv-meta"><span class="conv-meta-primary">${fmtDate(c.updatedAt)} · ${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}</span>${originMarkerHtml}${providerIndicatorHtml}</div>
      ${c.archived
        ? `<button class="conv-archive" onclick="unarchiveConv(event,'${c.id}')" title="Unarchive" aria-label="Unarchive">📂</button>`
        : `<button class="conv-archive" onclick="archiveConv(event,'${c.id}')" title="Archive" aria-label="Archive">🗄</button>`}
      <button class="conv-delete" onclick="deleteConv(event,'${c.id}')" title="Delete">🗑</button>
    </div>`;
  }).join('')}${footerHtml}`;
  if (listHtml !== lastConvListHtml) {
    list.innerHTML = listHtml;
    lastConvListHtml = listHtml;
  }
  bindConversationContextMenu(list);
  ensureProcessingDotTimer(hasProcessingConversation);
  window.syncChatTitleControls?.();
  scheduleConversationListBoundaryCheck();
}

// keepTranscript: the page shows a window this payload must not replace (the
// user jumped into the history; the payload is the end of the conversation).
// Everything but the messages still applies.
export function applyLoadedConversationState(id, response, {
  restoreScroll = false,
  savedScrollTop = null,
  followLiveUpdates = !restoreScroll,
  keepTranscript = false,
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
    // Claude Cloud only: repository, branch, session link, pushed branches.
    // An explicit null is a real answer ("not a cloud chat"); only a payload
    // without the field (an older relay) keeps what the list said.
    cloud: 'cloud' in response ? (response.cloud ?? null) : (existingConversation.cloud ?? null),
    // Who created the conversation, when an agent did (the "via agent" marker).
    origin: 'origin' in response ? (response.origin ?? null) : (existingConversation.origin ?? null),
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
  // The repo tree deliberately does NOT reload here: this runs on the 900ms
  // live poll, and the bare loadRepoBrowserTree path resets loaded folders and
  // deep selections. The end-of-turn message_status handler refreshes the tree
  // through the restoring path instead.
  // Before the messages: their bubbles take Pin / Unpin from this list.
  // Absent from an older relay's payload: keep what the socket said.
  if ('pins' in response) setConversationPins(id, response.pins, response.pinsRevision);
  setPinsConversation(id);
  const didRenderMessages = keepTranscript
    ? false
    : renderMessages(response.messages, !restoreScroll, response);
  hydrateConversationDraft(id, {
    draftText: response.draftText,
    draftAttachments: response.draftAttachments,
    draftUpdatedAt: response.draftUpdatedAt,
    draftUpdatedByClientId: response.draftUpdatedByClientId,
  });
  restoreInFlightThinking(response.inFlight || null, followLiveUpdates);
  setBackgroundTasksConversation(id);
  setConversationBackgroundTasks(id, response.backgroundTasks || []);
  setUsageLimitConversation(id, {
    // Absent from an older relay's payload: keep what the socket said.
    pause: 'usageLimitPause' in response ? response.usageLimitPause : undefined,
    providerType: response.runtimeSession?.providerType,
  });
  // Merge, not replace: this payload only carries one conversation's previews.
  mergeConversationPreviews(id, response.previews || []);
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

// The "via agent" marker (sidebar row, header, message badge): opens the
// conversation whose agent started this one. The marker sits inside a sidebar
// row that opens on click itself, so the click stops here.
export function openOriginConversation(event, element) {
  event?.stopPropagation?.();
  event?.preventDefault?.();
  const id = String(element?.dataset?.originConversationId || '').trim();
  if (!id) return null;
  if (!conversations[id]) {
    // Deleted since the marker was drawn; the next render makes it plain text.
    showTransientRelayNotice('That conversation is no longer in the list.');
    renderConvList();
    return null;
  }
  return openConversation(id);
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
  const switchingConversation = !!nextConversationId && previousConversationId !== nextConversationId;
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
  // Reopening the conversation on screen (session bind, clicking it again, a
  // push or search jump) must leave its composer alone: emptied attachments
  // would read as a user edit and be saved, dropping them from the draft.
  if (switchingConversation) {
    clearAttachments();
    beginConversationDraftSwitch(nextConversationId);
  }
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
    // Counted when the window is put on the page, not when it is asked for:
    // a reload of the end that is still on its way must see the change.
    if (forceFreshWindow) noteTranscriptJump();
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
  if (normalized === CLAUDE_CLOUD_PROVIDER) return CLAUDE_CLOUD_PROVIDER;
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'grok') return 'grok';
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
  const hasGrok = providers.includes('grok');
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
  if (normalizedProvider === 'grok') {
    if (hasGrok) return true;
    const grokModel = String(newConversationGrokSettingsCache?.model || '').trim();
    const grokModels = Array.isArray(newConversationGrokSettingsCache?.models)
      ? newConversationGrokSettingsCache.models.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    return normalizedModelId === grokModel || grokModels.includes(normalizedModelId);
  }
  const claudeOnly = hasClaude && providers.every((provider) => provider === 'claude');
  if (claudeOnly) return false;
  const cursorOnly = hasCursor && providers.every((provider) => provider === 'cursor');
  if (cursorOnly) return false;
  const grokOnly = hasGrok && providers.every((provider) => provider === 'grok');
  if (grokOnly) return false;
  // Should a relay ever tag catalog rows for Claude Cloud, they are no more
  // Copilot's than the other runtimes' rows are.
  const exclusiveOnly = providers.length > 0 && providers.every((provider) => (
    provider === 'claude' || provider === 'cursor' || provider === 'grok' || provider === CLAUDE_CLOUD_PROVIDER
  ));
  if (exclusiveOnly) return false;
  return providers.some((provider) => (
    provider !== 'openai-byok'
    && provider !== 'claude'
    && provider !== 'cursor'
    && provider !== 'grok'
    && provider !== CLAUDE_CLOUD_PROVIDER
  )) || !hasOpenAIByok;
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

// Read-only: the composer chip is the only place a tier is chosen (see
// newConversationContextTierState), so this just tells the user what the
// picked model gives them before the chat exists.
function populateNewConversationContextRow(providerType = 'github', selectedModel = '') {
  const select = document.getElementById('new-conversation-context-select');
  const row = document.getElementById('new-conversation-context-row');
  if (!select || !row) return;
  const { visible, options } = newConversationContextTierState(newConversationCatalogCache || {}, {
    provider: normalizeNewConversationProviderType(providerType),
    modelId: selectedModel,
  });
  select.innerHTML = '';
  if (!visible) {
    row.style.display = 'none';
    return;
  }
  for (const tier of options) {
    const option = document.createElement('option');
    option.value = tier.value;
    option.textContent = tier.label;
    select.appendChild(option);
  }
  select.value = options[0].value;
  row.style.display = 'block';
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
  // A cloud session has no effort choice; its row is hidden, and an empty
  // select is what the Start button reads as "send none".
  if (!newChatRowVisibility(provider).reasoning) {
    select.innerHTML = '';
    select.disabled = true;
    return;
  }
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
  const reasoningOffUnsupported = isReasoningOffUnsupported(catalog, provider, modelId);
  for (const effort of efforts) {
    const option = document.createElement('option');
    option.value = effort;
    option.textContent = reasoningEffortOptionLabel(effort, { reasoningOffUnsupported });
    const optionTitle = reasoningEffortOptionTitle(effort);
    if (optionTitle) option.title = optionTitle;
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

function storedComposerModel() {
  return String(localStorage.getItem(MODEL_STORAGE_KEY) || '').trim();
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
  if (normalizedProvider === CLAUDE_CLOUD_PROVIDER) {
    help.textContent = "Claude Cloud chats run in a sandbox at Anthropic on a clone of a GitHub repository, billed to the relay host's Claude account.";
    return;
  }
  if (normalizedProvider === 'cursor') {
    help.textContent = 'Cursor chats run through the Cursor Agent SDK using your saved Cursor API key.';
    return;
  }
  if (normalizedProvider === 'grok') {
    help.textContent = "Grok chats use the host machine's logged-in Grok credentials (grok login or XAI_API_KEY).";
    return;
  }
  help.textContent = 'Copilot models use your GitHub Copilot runtime.';
}

async function populateNewConversationModelSelect(providerType = 'github') {
  const target = document.getElementById('new-conversation-model-select');
  if (!target) return false;
  target.innerHTML = '';
  const catalog = newConversationCatalogCache || await loadModelCatalog();
  if (!catalog || !Array.isArray(catalog.models)) return false;
  const normalizedProvider = normalizeNewConversationProviderType(providerType);
  const isCloud = normalizedProvider === CLAUDE_CLOUD_PROVIDER;
  // Claude Cloud brings its own list (the tab's models), not catalog rows.
  const eligibleModels = isCloud
    ? claudeCloudModelIds(newConversationClaudeCloudSettingsCache)
    : catalog.models
      .map((modelId) => String(modelId || '').trim())
      .filter((modelId) => modelMatchesNewConversationProvider(catalog, modelId, normalizedProvider))
      .filter((modelId) => (
        normalizedProvider !== 'openai-image' || isOpenAIImageModelId(modelId)
      ));
  // The same builder the composer's #model-select uses, on the same catalog,
  // so the two pickers agree on order and wording by construction. The modal
  // used to borrow labels from the composer, which is scoped to the OPEN
  // conversation's provider and so knew nothing about the models of another.
  const hasAuto = eligibleModels.some((modelId) => modelId.toLowerCase() === 'auto');
  const choices = buildNewConversationModelChoices(
    buildCatalogModelOptions(eligibleModels, {
      metadataByModel: catalog.modelMetadataByModel || {},
      // The merged metadata knows Copilot's windows, not Claude's or the cloud's.
      annotateContextWindow: normalizedProvider !== 'claude' && !isCloud,
    }).filter((option) => hasAuto || option.value.toLowerCase() !== 'auto'),
  );
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    target.appendChild(option);
  }
  // The rows follow the provider even when it has no model to offer, so a
  // provider switch never leaves another provider's fields on screen.
  syncNewConversationProviderRows(normalizedProvider);
  if (!target.options.length) return false;
  const storedModel = storedComposerModel();
  if (isCloud) {
    // The tab's default, not the last model another provider's chat used.
    const cloudDefault = claudeCloudDefaultModel(newConversationClaudeCloudSettingsCache, eligibleModels);
    if (cloudDefault) target.value = cloudDefault;
  } else if (storedModel && Array.from(target.options).some((option) => option.value === storedModel)) {
    target.value = storedModel;
  } else if (normalizedProvider !== 'openai-image' && Array.from(target.options).some((option) => option.value === 'auto')) {
    target.value = 'auto';
  }
  updateNewConversationProviderHelp(normalizedProvider);
  syncNewConversationReasoningLabel(normalizedProvider);
  populateNewConversationSizeSelect(normalizedProvider, target.value);
  populateNewConversationContextRow(normalizedProvider, target.value);
  await populateNewConversationReasoningSelect(target.value);
  return true;
}

function selectedNewConversationProvider() {
  return normalizeNewConversationProviderType(
    String(document.getElementById('new-conversation-provider-select')?.value || '').trim(),
  );
}

function isNewConversationCloudSelected() {
  return selectedNewConversationProvider() === CLAUDE_CLOUD_PROVIDER;
}

function syncNewConversationProviderRows(providerType = 'github') {
  const rows = newChatRowVisibility(providerType);
  const cloudRow = document.getElementById('new-conversation-cloud-row');
  if (cloudRow) cloudRow.hidden = !rows.cloudSource;
  if (rows.cloudSource) void ensureNewConversationCloudRepoList();
  const reasoningRow = document.getElementById('new-conversation-reasoning-row');
  if (reasoningRow) reasoningRow.hidden = !rows.reasoning;
  // The folder line reads differently for a chat that does not run in the folder.
  syncNewConversationCwdControls();
}

function newConversationCloudInputs() {
  return {
    repo: document.getElementById('new-conversation-cloud-repo'),
    branch: document.getElementById('new-conversation-cloud-branch'),
  };
}

function renderNewConversationCloudWarnings() {
  const container = document.getElementById('new-conversation-cloud-warnings');
  if (!container) return;
  const { repo, branch } = newConversationCloudInputs();
  const warnings = isNewConversationCloudSelected()
    ? buildCloudSourceWarnings({
      remote: newConversationCloudRemote,
      lookupFailed: newConversationCloudLookupFailed,
      repo: repo?.value || '',
      branch: branch?.value || '',
      environmentId: newConversationClaudeCloudSettingsCache?.environmentId || '',
      repoAccess: cloudRepoAccess(newConversationCloudRepoList, repo?.value || ''),
    })
    : [];
  container.replaceChildren(...warnings.map((warning) => {
    const line = document.createElement('div');
    line.className = 'new-conversation-cloud-warning';
    line.dataset.kind = warning.kind;
    line.textContent = warning.text;
    return line;
  }));
}

// `fields` marks the inputs the message is about; none means a general error.
function showNewConversationCloudError(text = '', fields = []) {
  const errorEl = document.getElementById('new-conversation-cloud-error');
  if (errorEl) {
    errorEl.textContent = text;
    errorEl.hidden = !text;
  }
  const inputs = newConversationCloudInputs();
  for (const [name, input] of Object.entries(inputs)) {
    if (!input) continue;
    if (fields.includes(name)) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  const firstInvalid = fields.map((name) => inputs[name]).find(Boolean);
  if (text && firstInvalid) firstInvalid.focus?.();
}

function resetNewConversationCloudState() {
  if (newConversationCloudLookupTimer) clearTimeout(newConversationCloudLookupTimer);
  newConversationCloudLookupTimer = null;
  newConversationCloudLookupSeq += 1;
  newConversationCloudRemote = null;
  newConversationCloudLookupFailed = false;
  newConversationCloudLookupFolder = null;
  newConversationCloudAutoFill = null;
  if (newConversationCloudBranchTimer) clearTimeout(newConversationCloudBranchTimer);
  newConversationCloudBranchTimer = null;
  newConversationCloudBranchSeq += 1;
  newConversationCloudRepoList = null;
  newConversationCloudRepoListPromise = null;
  newConversationCloudBranchList = null;
  newConversationCloudBranchAutoFill = '';
  const { repo, branch } = newConversationCloudInputs();
  if (repo) repo.value = '';
  if (branch) branch.value = '';
  hideNewConversationCloudSuggestions('repo');
  hideNewConversationCloudSuggestions('branch');
  showNewConversationCloudError('');
  renderNewConversationCloudWarnings();
}

// ── Repository and branch suggestions ──

/** Read the repository list once per open; the warnings and an open list follow. */
function ensureNewConversationCloudRepoList() {
  if (newConversationCloudRepoList || newConversationCloudRepoListPromise) return newConversationCloudRepoListPromise;
  const seq = newConversationCloudLookupSeq;
  newConversationCloudRepoListPromise = loadClaudeCloudRepos().then((payload) => {
    // A reset in the meantime (the modal closed) owns the fields now.
    if (seq !== newConversationCloudLookupSeq) return;
    newConversationCloudRepoList = payload && typeof payload === 'object' ? payload : { ok: false, repos: [] };
    newConversationCloudRepoListPromise = null;
    renderNewConversationCloudWarnings();
    renderNewConversationCloudSuggestions('repo');
  }).catch(() => {
    newConversationCloudRepoListPromise = null;
  });
  return newConversationCloudRepoListPromise;
}

/** The ↻ next to Repository: read the list afresh from the relay (and Anthropic). */
export async function refreshNewConversationCloudRepoList() {
  const button = document.getElementById('new-conversation-cloud-repo-refresh');
  if (button?.getAttribute('aria-busy') === 'true') return;
  button?.setAttribute('aria-busy', 'true');
  const seq = newConversationCloudLookupSeq;
  try {
    const payload = await loadClaudeCloudRepos({ refresh: true });
    if (seq !== newConversationCloudLookupSeq) return;
    newConversationCloudRepoList = payload && typeof payload === 'object' ? payload : { ok: false, repos: [] };
    renderNewConversationCloudWarnings();
    const { repo } = newConversationCloudInputs();
    if (repo && document.activeElement !== repo) repo.focus?.();
    renderNewConversationCloudSuggestions('repo');
  } finally {
    button?.removeAttribute('aria-busy');
  }
}

function newConversationCloudSuggestList(field) {
  return document.getElementById(`new-conversation-cloud-${field}-list`);
}

/** The entries to offer for what the field holds: `{ value, label, meta }`. */
function newConversationCloudSuggestions(field) {
  const { repo, branch } = newConversationCloudInputs();
  if (field === 'repo') {
    const entries = Array.isArray(newConversationCloudRepoList?.repos) ? newConversationCloudRepoList.repos : [];
    return filterCloudRepoSuggestions(entries, repo?.value || '')
      .map((entry) => ({ value: entry.slug, label: entry.slug, meta: cloudRepoSuggestionMeta(entry) }));
  }
  const list = newConversationCloudBranchList;
  const slug = normalizeCloudRepoInput(repo?.value || '')?.slug || '';
  if (!list || !slug || list.slug !== slug) return [];
  // A default branch the pick wrote in is not a filter: the whole list shows.
  const typed = branch?.value || '';
  const query = typed && typed === newConversationCloudBranchAutoFill ? '' : typed;
  return filterCloudBranchSuggestions(list.branches, query, { defaultBranch: list.defaultBranch })
    .map((name) => ({ value: name, label: name, meta: name === list.defaultBranch ? 'default' : '' }));
}

function hideNewConversationCloudSuggestions(field) {
  const list = newConversationCloudSuggestList(field);
  if (list) {
    list.hidden = true;
    list.replaceChildren();
  }
  newConversationCloudInputs()[field]?.setAttribute('aria-expanded', 'false');
  newConversationCloudSuggestActive[field] = -1;
}

/**
 * Show the suggestions for a focused field. The list lives in the modal's
 * flow under the field (a popover would be clipped by the scrolling modal on
 * a phone). Nothing to offer, or the field not focused: no list.
 */
function renderNewConversationCloudSuggestions(field) {
  const input = newConversationCloudInputs()[field];
  const list = newConversationCloudSuggestList(field);
  if (!input || !list) return;
  if (!isNewConversationCloudSelected() || document.activeElement !== input) {
    hideNewConversationCloudSuggestions(field);
    return;
  }
  const suggestions = newConversationCloudSuggestions(field);
  // The list could not be read from Claude Cloud: the recent repositories
  // are still offered, with the reason under them.
  const listError = field === 'repo' && newConversationCloudRepoList && newConversationCloudRepoList.ok === false
    ? String(newConversationCloudRepoList.error?.message || 'The repositories could not be read from Claude Cloud.').trim()
    : '';
  if (!suggestions.length && !listError) {
    hideNewConversationCloudSuggestions(field);
    return;
  }
  const active = Math.min(newConversationCloudSuggestActive[field], suggestions.length - 1);
  newConversationCloudSuggestActive[field] = active;
  list.replaceChildren(...suggestions.map((suggestion, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'new-conversation-cloud-suggest-item';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', index === active ? 'true' : 'false');
    item.dataset.value = suggestion.value;
    const label = document.createElement('span');
    label.textContent = suggestion.label;
    item.append(label);
    if (suggestion.meta) {
      const meta = document.createElement('span');
      meta.className = 'new-conversation-cloud-suggest-meta';
      meta.textContent = suggestion.meta;
      item.append(meta);
    }
    return item;
  }));
  if (listError) {
    const note = document.createElement('div');
    note.className = 'new-conversation-cloud-suggest-note';
    note.textContent = listError;
    list.append(note);
  }
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

/** A suggestion taken: the field holds it, and a repository brings its default branch along. */
function pickNewConversationCloudSuggestion(field, value) {
  const { repo, branch } = newConversationCloudInputs();
  const input = field === 'repo' ? repo : branch;
  if (!input) return;
  input.value = value;
  hideNewConversationCloudSuggestions(field);
  if (field === 'repo') {
    const entries = Array.isArray(newConversationCloudRepoList?.repos) ? newConversationCloudRepoList.repos : [];
    const entry = entries.find((candidate) => candidate?.slug === value) || null;
    const defaultBranch = String(entry?.defaultBranch || '').trim();
    // The default branch is preselected; a branch the user typed is kept.
    if (branch && (!branch.value.trim() || branch.value === newConversationCloudBranchAutoFill)) {
      branch.value = defaultBranch;
      newConversationCloudBranchAutoFill = defaultBranch;
    }
    newConversationCloudBranchList = null;
    scheduleNewConversationCloudBranchLookup(0);
  }
  showNewConversationCloudError('');
  renderNewConversationCloudWarnings();
  input.focus?.();
}

/** Read the branches of the repository in the field, unless they are known. */
async function refreshNewConversationCloudBranches() {
  const { repo, branch } = newConversationCloudInputs();
  const slug = normalizeCloudRepoInput(repo?.value || '')?.slug || '';
  if (!slug) {
    newConversationCloudBranchList = null;
    renderNewConversationCloudSuggestions('branch');
    return;
  }
  if (newConversationCloudBranchList?.slug === slug) return;
  const seq = ++newConversationCloudBranchSeq;
  const payload = await loadClaudeCloudBranches(slug);
  if (seq !== newConversationCloudBranchSeq) return;
  // The host could not read them: the field stays a text field, and the
  // default branch from the repository list is still offered.
  const known = (Array.isArray(newConversationCloudRepoList?.repos) ? newConversationCloudRepoList.repos : [])
    .find((entry) => entry?.slug === slug);
  const branches = payload?.ok === true && Array.isArray(payload.branches) ? payload.branches : [];
  const defaultBranch = String((payload?.ok === true && payload.defaultBranch) || known?.defaultBranch || '').trim();
  newConversationCloudBranchList = { slug, branches, defaultBranch };
  // Only an empty field takes the default here: the folder's branch belongs
  // to the folder's repository and stays.
  if (branch && defaultBranch && !branch.value.trim()) {
    branch.value = defaultBranch;
    newConversationCloudBranchAutoFill = defaultBranch;
    renderNewConversationCloudWarnings();
  }
  renderNewConversationCloudSuggestions('branch');
}

function scheduleNewConversationCloudBranchLookup(delayMs = NEW_CHAT_CLOUD_LOOKUP_DEBOUNCE_MS) {
  if (newConversationCloudBranchTimer) clearTimeout(newConversationCloudBranchTimer);
  newConversationCloudBranchTimer = null;
  if (!isNewConversationCloudSelected()) return;
  newConversationCloudBranchTimer = setTimeout(() => {
    newConversationCloudBranchTimer = null;
    void refreshNewConversationCloudBranches();
  }, delayMs);
}

/** Arrow keys walk the open list, Enter takes the marked entry, Escape closes it. */
function handleNewConversationCloudSuggestKey(field, event) {
  const list = newConversationCloudSuggestList(field);
  const open = list && !list.hidden;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!open) {
      renderNewConversationCloudSuggestions(field);
      if (!list || list.hidden) return;
    }
    const items = [...list.querySelectorAll('.new-conversation-cloud-suggest-item')];
    if (!items.length) return;
    const current = newConversationCloudSuggestActive[field];
    const next = event.key === 'ArrowDown'
      ? (current + 1) % items.length
      : (current <= 0 ? items.length - 1 : current - 1);
    newConversationCloudSuggestActive[field] = next;
    items.forEach((item, index) => item.setAttribute('aria-selected', index === next ? 'true' : 'false'));
    items[next]?.scrollIntoView?.({ block: 'nearest' });
    event.preventDefault();
    return;
  }
  if (!open) return;
  if (event.key === 'Enter') {
    const active = list.querySelectorAll('.new-conversation-cloud-suggest-item')[newConversationCloudSuggestActive[field]];
    if (active) {
      event.preventDefault();
      pickNewConversationCloudSuggestion(field, active.dataset.value || '');
    }
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    hideNewConversationCloudSuggestions(field);
  }
}

function bindNewConversationCloudSuggestions() {
  const inputs = newConversationCloudInputs();
  for (const [field, input] of Object.entries(inputs)) {
    const list = newConversationCloudSuggestList(field);
    if (!input || !list || list.dataset.cloudBound === '1') continue;
    list.dataset.cloudBound = '1';
    input.addEventListener('focus', () => renderNewConversationCloudSuggestions(field));
    input.addEventListener('blur', () => {
      // After the click on an entry, which takes the focus for a moment.
      setTimeout(() => {
        if (document.activeElement !== input) hideNewConversationCloudSuggestions(field);
      }, NEW_CHAT_CLOUD_SUGGEST_BLUR_MS);
    });
    input.addEventListener('keydown', (event) => handleNewConversationCloudSuggestKey(field, event));
    // The entries are buttons: a mousedown would move the focus off the
    // field and close the list before the click lands.
    list.addEventListener('mousedown', (event) => event.preventDefault());
    list.addEventListener('click', (event) => {
      const item = event.target?.closest?.('.new-conversation-cloud-suggest-item');
      if (item) pickNewConversationCloudSuggestion(field, item.dataset.value || '');
    });
  }
}

// Reads origin + branch of the selected folder and fills the two fields.
async function refreshNewConversationCloudSource() {
  if (!isNewConversationCloudSelected()) return;
  const pickedFolder = getNewConversationSelectedCwd();
  const folder = pickedFolder || resolveNewConversationDefaultCwd();
  if (folder === newConversationCloudLookupFolder) {
    renderNewConversationCloudWarnings();
    return;
  }
  const seq = ++newConversationCloudLookupSeq;
  newConversationCloudLookupFolder = folder;
  let remote = folder ? await loadGitRemote(folder) : null;
  // A newer folder choice (or a closed modal) owns the fields by now.
  if (seq !== newConversationCloudLookupSeq) return;
  let lookupFailed = !!folder && !remote;
  // Nobody picked the relay's default folder: when it has no repository to
  // offer there is nothing to warn about, the fields are simply typed.
  if (!pickedFolder && !String(remote?.repoUrl || '').trim()) {
    remote = null;
    lookupFailed = false;
  }
  newConversationCloudRemote = remote;
  newConversationCloudLookupFailed = lookupFailed;
  const { repo, branch } = newConversationCloudInputs();
  const next = resolveCloudSourceAutoFill({
    current: { repo: repo?.value || '', branch: branch?.value || '' },
    lastAutoFill: newConversationCloudAutoFill,
    remote,
  });
  if (repo) repo.value = next.repo;
  if (branch) branch.value = next.branch;
  newConversationCloudAutoFill = next.autoFill;
  newConversationCloudBranchAutoFill = next.branch;
  showNewConversationCloudError('');
  renderNewConversationCloudWarnings();
  scheduleNewConversationCloudBranchLookup(0);
}

// Debounced: the manual path fires on every keystroke.
function scheduleNewConversationCloudLookup() {
  if (newConversationCloudLookupTimer) clearTimeout(newConversationCloudLookupTimer);
  newConversationCloudLookupTimer = null;
  if (!isNewConversationCloudSelected()) return;
  newConversationCloudLookupTimer = setTimeout(() => {
    newConversationCloudLookupTimer = null;
    void refreshNewConversationCloudSource();
  }, NEW_CHAT_CLOUD_LOOKUP_DEBOUNCE_MS);
}

function bindNewConversationCloudInputs() {
  for (const [field, input] of Object.entries(newConversationCloudInputs())) {
    if (!input || input.dataset.cloudBound === '1') continue;
    input.dataset.cloudBound = '1';
    input.addEventListener('input', () => {
      // The warnings depend on whether the fields still name the folder's
      // repository and branch; an edit also answers the last error.
      showNewConversationCloudError('');
      renderNewConversationCloudWarnings();
      newConversationCloudSuggestActive[field] = -1;
      renderNewConversationCloudSuggestions(field);
      // A typed branch is the user's own from here on.
      if (field === 'branch') newConversationCloudBranchAutoFill = '';
      else scheduleNewConversationCloudBranchLookup();
    });
  }
  bindNewConversationCloudSuggestions();
}

function resolveNewConversationDefaultCwd() {
  return normalizeKnownCwdPath(defaultSessionWorkspaceRootPath || workspaceRootPath || '');
}

function getNewConversationSelectedCwd() {
  const select = document.getElementById('new-conversation-cwd-select');
  if (!select) return '';
  if (select.value === NEW_CHAT_CUSTOM_CWD_VALUE) {
    return normalizeKnownCwdPath(document.getElementById('new-conversation-cwd-manual')?.value || '');
  }
  return normalizeKnownCwdPath(select.value || '');
}

function syncNewConversationCwdControls() {
  const select = document.getElementById('new-conversation-cwd-select');
  const manual = document.getElementById('new-conversation-cwd-manual');
  const status = document.getElementById('new-conversation-cwd-status');
  if (!select) return;
  const isCustom = select.value === NEW_CHAT_CUSTOM_CWD_VALUE;
  if (manual) manual.hidden = !isCustom;
  if (isNewConversationCloudSelected()) {
    // The folder only supplies the repository and branch for a cloud chat.
    scheduleNewConversationCloudLookup();
    if (status) status.textContent = cloudFolderStatusText(getNewConversationSelectedCwd());
    return;
  }
  if (!status) return;
  if (isCustom) {
    const manualPath = normalizeKnownCwdPath(manual?.value || '');
    status.textContent = manualPath
      ? `This chat starts in ${manualPath}.`
      : 'Enter the full path of the launch directory on the relay host.';
    return;
  }
  const selectedPath = normalizeKnownCwdPath(select.value || '');
  if (selectedPath) {
    status.textContent = `This chat starts in ${selectedPath}.`;
    return;
  }
  const defaultPath = resolveNewConversationDefaultCwd();
  status.textContent = defaultPath
    ? `This chat starts in ${defaultPath} (relay default).`
    : 'This chat starts in the relay default directory.';
}

function populateNewConversationCwdSelect() {
  const select = document.getElementById('new-conversation-cwd-select');
  if (!select) return;
  const options = buildKnownCwdOptions({
    currentSessionCwd: getConversationCurrentWorkspaceRootPath(currentConvId) || '',
    workspaceRootPath,
    browserCwd: getRepoBrowserLaunchCwdPath(),
    recentRoots: getRecentWorkspaceRoots(),
  });
  select.innerHTML = '';
  const defaultPath = resolveNewConversationDefaultCwd();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = defaultPath ? `Default (${defaultPath})` : 'Default';
  select.appendChild(defaultOption);
  for (const option of options) {
    const entry = document.createElement('option');
    entry.value = option.path;
    entry.textContent = option.path;
    entry.title = option.note ? `${option.label} (${option.note})` : option.label;
    select.appendChild(entry);
  }
  const customOption = document.createElement('option');
  customOption.value = NEW_CHAT_CUSTOM_CWD_VALUE;
  customOption.textContent = 'Custom path…';
  select.appendChild(customOption);
  const storedCwd = normalizeKnownCwdPath(localStorage.getItem(NEW_CHAT_CWD_STORAGE_KEY) || '');
  if (storedCwd) {
    const storedKey = storedCwd.toLowerCase();
    const match = Array.from(select.options).find((option) => (
      option.value !== NEW_CHAT_CUSTOM_CWD_VALUE
      && normalizeKnownCwdPath(option.value).toLowerCase() === storedKey
    ));
    if (match) select.value = match.value;
  }
  if (select.dataset.cwdBound !== '1') {
    select.dataset.cwdBound = '1';
    select.addEventListener('change', () => {
      syncNewConversationCwdControls();
      if (select.value === NEW_CHAT_CUSTOM_CWD_VALUE) {
        document.getElementById('new-conversation-cwd-manual')?.focus?.();
      }
    });
  }
  const manual = document.getElementById('new-conversation-cwd-manual');
  if (manual && manual.dataset.cwdBound !== '1') {
    manual.dataset.cwdBound = '1';
    manual.addEventListener('input', syncNewConversationCwdControls);
  }
  const browse = document.getElementById('new-conversation-cwd-browse');
  if (browse && browse.dataset.cwdBound !== '1') {
    browse.dataset.cwdBound = '1';
    browse.addEventListener('click', (event) => {
      event.preventDefault();
      // The picked path lands in the "Custom path…" manual input, so it goes
      // through the exact same submit/validation path as a typed one.
      openRepoBrowserForCwdPick((pickedPath) => {
        const cwdSelect = document.getElementById('new-conversation-cwd-select');
        const manualInput = document.getElementById('new-conversation-cwd-manual');
        if (cwdSelect) cwdSelect.value = NEW_CHAT_CUSTOM_CWD_VALUE;
        if (manualInput) manualInput.value = pickedPath;
        syncNewConversationCwdControls();
      });
    });
  }
  syncNewConversationCwdControls();
}

async function openNewConversationModelModal() {
  const [catalog, settings, claudeSettings, cursorSettings, grokSettings, claudeCloudSettings] = await Promise.all([
    loadModelCatalog(),
    loadOpenAISettings(),
    loadClaudeSettings(),
    loadCursorSettings(),
    loadGrokSettings(),
    // null on a relay without Claude Cloud: the option is simply not offered.
    loadClaudeCloudSettings(),
  ]);
  newConversationCatalogCache = catalog || null;
  newConversationOpenAISettingsCache = settings || null;
  newConversationClaudeSettingsCache = claudeSettings || null;
  newConversationCursorSettingsCache = cursorSettings || null;
  newConversationGrokSettingsCache = grokSettings || null;
  newConversationClaudeCloudSettingsCache = claudeCloudSettings || null;
  // Every open starts from empty cloud fields; the folder lookup refills them.
  resetNewConversationCloudState();
  bindNewConversationCloudInputs();
  const providerSelect = document.getElementById('new-conversation-provider-select');
  if (providerSelect) {
    const options = [{ value: 'github', label: 'Copilot' }];
    if (settings?.enabled === true) {
      options.push({ value: 'openai', label: 'OpenAI (BYOK)' });
      options.push({ value: 'openai-image', label: 'OpenAI Image (BYOK)' });
    }
    if (claudeSettings?.enabled === true) {
      options.push({ value: 'claude', label: 'Claude SDK' });
    }
    if (claudeCloudSettings?.enabled === true) {
      options.push({ value: CLAUDE_CLOUD_PROVIDER, label: 'Claude Cloud' });
    }
    if (cursorSettings?.enabled === true) {
      options.push({ value: 'cursor', label: 'Cursor SDK' });
    }
    if (grokSettings?.enabled === true) {
      options.push({ value: 'grok', label: 'Grok' });
    }
    providerSelect.innerHTML = '';
    for (const option of options) {
      const entry = document.createElement('option');
      entry.value = option.value;
      entry.textContent = option.label;
      providerSelect.appendChild(entry);
    }
    // With Copilot alone the provider row is a single dead option — hide it.
    const providerRow = document.getElementById('new-conversation-provider-row');
    if (providerRow) providerRow.hidden = options.length <= 1;
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
      populateNewConversationContextRow(provider, modelSelect.value);
      void populateNewConversationReasoningSelect(modelSelect.value);
    });
  }
  populateNewConversationCwdSelect();
  const modal = document.getElementById('new-conversation-model-modal');
  if (!modal) return;
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(() => document.getElementById('new-conversation-model-select')?.focus(), 0);
}

function hideNewConversationModelModal() {
  const modal = document.getElementById('new-conversation-model-modal');
  modal?.classList.remove('visible');
  modal?.setAttribute('aria-hidden', 'true');
}

export function closeNewConversationModelModal() {
  if (newConversationInFlight) return;
  hideNewConversationModelModal();
}

// The only writer of the shared "last used" keys on this path, and only once
// the bootstrap has succeeded: an abandoned or rejected New Chat must not
// change what the open conversation or the next one starts with.
function rememberBootstrappedSelection(result = null) {
  const bootstrappedModel = String(result?.preferredModel || result?.selectedModel || '')
    .trim()
    // The composer stores base ids and carries the 1M tier separately.
    .replace(CLAUDE_LONG_CONTEXT_PATTERN, '');
  if (bootstrappedModel) localStorage.setItem(MODEL_STORAGE_KEY, bootstrappedModel);
  const bootstrappedEffort = String(result?.preferredReasoningEffort || '').trim().toLowerCase();
  if (bootstrappedEffort) localStorage.setItem(REASONING_STORAGE_KEY, bootstrappedEffort);
}

// The conversation row exists in both the success and the worker-prestart
// failure case, so both take the same post-create steps.
async function openBootstrappedConversation({
  conversationId,
  payload,
  selectedCwd = '',
  selectedProvider = '',
  selectedSize = '',
}) {
  // Only a bootstrap that actually created the conversation makes the CWD
  // choice sticky, so a rejected path can never become the next chat's default.
  try {
    if (selectedCwd) localStorage.setItem(NEW_CHAT_CWD_STORAGE_KEY, selectedCwd);
    else localStorage.removeItem(NEW_CHAT_CWD_STORAGE_KEY);
  } catch {}
  hideNewConversationModelModal();
  // The server echoes what it actually bound and stored; the composer picks
  // those up from the conversation row when it opens, so only the shared
  // "last used" storage is updated here. A cloud chat starts from its tab's
  // default model and has no effort, so it must not become what the next
  // local chat starts with.
  if (selectedProvider !== CLAUDE_CLOUD_PROVIDER) rememberBootstrappedSelection(payload);
  await refreshConversations();
  await openConversation(conversationId);
  if (selectedProvider === 'openai-image') {
    const contextTierSelect = document.getElementById('context-tier-select');
    if (contextTierSelect && selectedSize && Array.from(contextTierSelect.options).some((option) => option.value === selectedSize)) {
      contextTierSelect.value = selectedSize;
    }
  }
}

async function createNewConversation(selectedModel, selectedReasoningEffort = '', selectedCwd = '') {
  if (newConversationInFlight) return;
  const selectedProvider = selectedNewConversationProvider();
  const isCloud = selectedProvider === CLAUDE_CLOUD_PROVIDER;
  let cloudSource;
  if (isCloud) {
    // Checked before anything is sent: both fields can be fixed in place.
    const { repo, branch } = newConversationCloudInputs();
    const validation = validateCloudSourceInputs({ repo: repo?.value || '', branch: branch?.value || '' });
    if (!validation.ok) {
      showNewConversationCloudError(
        [validation.errors.repo, validation.errors.branch].filter(Boolean).join(' '),
        Object.keys(validation.errors),
      );
      return;
    }
    showNewConversationCloudError('');
    cloudSource = validation.cloudSource;
  }
  setNewConversationInFlight(true);
  const confirmButton = document.getElementById('new-conversation-model-confirm');
  if (confirmButton) confirmButton.disabled = true;
  const selectedSize = String(document.getElementById('new-conversation-size-select')?.value || '').trim().toLowerCase();
  if (selectedProvider === 'openai-image' && selectedSize) {
    localStorage.setItem(OPENAI_IMAGE_SIZE_STORAGE_KEY, selectedSize);
  }
  try {
    const result = await bootstrapConversationSession({
      model: selectedModel || undefined,
      providerType: bootstrapProviderType(selectedProvider),
      reasoningEffort: isCloud
        ? undefined
        : (String(selectedReasoningEffort || '').trim().toLowerCase() || undefined),
      // Bootstrap writes the conversation's preferences, so the current mode has
      // to travel with it or every new chat would come back as the default one.
      // The composer's selector wins over storage: storage holds the last
      // explicit choice, which is not the mode of the conversation on screen.
      // A cloud session has no relay modes, so it never inherits Plan or Ask.
      relayMode: isCloud
        ? 'agent'
        : (String(
          // With a cloud chat on screen the selector is hidden and pinned to
          // "agent": that is not a choice, so the last explicit one applies.
          (isClaudeCloudConversation(conversations[currentConvId]) ? '' : document.getElementById('mode-select')?.value)
          || localStorage.getItem(MODE_STORAGE_KEY)
          || '',
        ).trim() || undefined),
      workspaceRootPath: selectedCwd || undefined,
      // Claude Cloud only: the repository (and branch) the session clones.
      cloudSource,
      title: 'New Conversation',
    });
    const nextConversationId = String(result?.conversationId || '').trim();
    if (!nextConversationId) {
      showTransientRelayNotice('Could not start a new conversation session. Please try again.');
      return;
    }
    await openBootstrappedConversation({
      conversationId: nextConversationId,
      payload: result,
      selectedCwd,
      selectedProvider,
      selectedSize,
    });
    if (result?.warning) {
      showTransientRelayNotice(String(result.warning), 6000);
    }
    if (result?.workspaceRootWarning) {
      showTransientRelayNotice(String(result.workspaceRootWarning), 7000);
    }
    if (result?.defaultSessionWorkspaceRootWarning) {
      showTransientRelayNotice(String(result.defaultSessionWorkspaceRootWarning), 7000);
    }
  } catch (error) {
    // A worker that fails to prestart still leaves a committed conversation
    // bound to the requested provider. Open it so the user can retry from the
    // chat instead of hunting for an orphaned row in the sidebar.
    const createdConversationId = error?.payload?.conversationCreated
      ? String(error.payload.conversationId || '').trim()
      : '';
    let recovered = false;
    if (createdConversationId) {
      try {
        await openBootstrappedConversation({
          conversationId: createdConversationId,
          payload: error.payload,
          selectedCwd,
          selectedProvider,
          selectedSize,
        });
        recovered = true;
      } catch {
        // Fall through to the failure notice below with the modal closed; the
        // conversation exists and the sidebar refresh will show it.
      }
    }
    // A Claude Cloud rejection (bad repository or branch, provider switched
    // off, no environment) belongs next to the fields it is about.
    const cloudError = isCloud && !recovered
      ? cloudBootstrapErrorModel({ code: error?.payload?.code, message: error?.payload?.error })
      : null;
    if (cloudError) {
      showNewConversationCloudError(cloudError.text, cloudError.field ? [cloudError.field] : []);
      return;
    }
    showTransientRelayNotice(recovered
      // The chat is usable, but its worker did not start, so say what broke.
      ? `The chat was created, but its session could not start: ${error?.message || 'unknown error'}.`
      // Otherwise the modal stays open so the user can fix the CWD/model and retry.
      : (error?.message || 'Could not start a new conversation session.'));
  } finally {
    setNewConversationInFlight(false);
    if (confirmButton) confirmButton.disabled = false;
  }
}

export async function confirmNewConversationModel() {
  if (newConversationInFlight) return;
  const selectedModel = String(document.getElementById('new-conversation-model-select')?.value || '').trim();
  const selectedReasoningEffort = String(document.getElementById('new-conversation-reasoning-select')?.value || '').trim().toLowerCase();
  if (!selectedModel) return;
  const selectedCwd = getNewConversationSelectedCwd();
  // The modal stays open until the bootstrap succeeds; createNewConversation
  // closes it, so a rejected CWD or model keeps the selection editable.
  await createNewConversation(selectedModel, selectedReasoningEffort, selectedCwd);
}

export async function newConversation() {
  if (IS_SHARED_VIEW) {
    showTransientRelayNotice('Shared conversations are read-only.');
    return;
  }
  if (newConversationInFlight) return;
  await openNewConversationModelModal();
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

// A title filter has to search conversations that only exist on unloaded pages,
// so an active filter drains the remaining pages in the background. Each page
// re-renders via applyPage, so matches appear as they load.
// A filter change aborts the running drain and starts a fresh one, so the new
// filter gets a full retry budget.
async function drainConversationListForFilter() {
  if (conversationFilterDrainActive) return;
  conversationFilterDrainActive = true;
  const generation = conversationFilterGeneration;
  renderConvList();
  try {
    await drainRemainingPages(
      conversationListLoader,
      () => generation === conversationFilterGeneration
        && !!normalizeConversationFilter(conversationListFilterText),
    );
  } finally {
    conversationFilterDrainActive = false;
    const filterActive = !!normalizeConversationFilter(conversationListFilterText);
    if (filterActive && generation !== conversationFilterGeneration) {
      void drainConversationListForFilter();
    } else {
      // The "Searching older conversations…" footer keys off the drain flag.
      renderConvList();
      if (filterActive) announceConversationFilterResults();
    }
  }
}

// Announced only when the (debounced) filter applies and when its drain ends,
// not on every page render, so screen readers are not flooded while typing.
// Unchanged text is not rewritten: refresh-triggered drains (session bind,
// reconnect) must not re-announce without a user action.
function announceConversationFilterResults() {
  const status = document.getElementById('conv-filter-status');
  if (!status) return;
  const activeFilter = normalizeConversationFilter(conversationListFilterText);
  let text = '';
  if (activeFilter) {
    const count = filterConversations(Object.values(conversations), activeFilter).length;
    if (!conversationListLoader.getState().hasMore) {
      text = describeFilterMatchCount(count);
    } else if (conversationFilterDrainActive) {
      text = `${describeFilterMatchCount(count)} so far, searching older conversations`;
    } else {
      // The drain gave up with pages left, so the search is not complete.
      text = describeFilterMatchCount(count, { loadedOnly: true });
    }
  }
  if (status.textContent !== text) status.textContent = text;
}

function setConversationListFilter(text) {
  const next = String(text ?? '');
  if (next === conversationListFilterText) return;
  conversationListFilterText = next;
  conversationFilterGeneration += 1;
  const list = getConversationListElement();
  if (list) list.scrollTop = 0;
  renderConvList();
  if (normalizeConversationFilter(next)) void drainConversationListForFilter();
  announceConversationFilterResults();
}

export function initConversationFilter() {
  const input = document.getElementById('conv-filter-input');
  const clearButton = document.getElementById('conv-filter-clear');
  if (!input || input.dataset.filterBound === '1') return;
  input.dataset.filterBound = '1';
  let debounceTimer = null;
  const syncClearButton = () => {
    if (clearButton) clearButton.hidden = input.value === '';
  };
  const applyFilterNow = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    syncClearButton();
    setConversationListFilter(input.value);
  };
  input.addEventListener('input', () => {
    syncClearButton();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyFilterNow, CONV_FILTER_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || input.value === '') return;
    event.stopPropagation();
    input.value = '';
    applyFilterNow();
  });
  clearButton?.addEventListener('click', () => {
    input.value = '';
    applyFilterNow();
    input.focus();
  });
  syncClearButton();
}

// ── Archive, and the row's context menu ──

// Which of the two views the sidebar shows: the live conversations, or the
// archived ones (the 🗄 toggle in the filter row).
let conversationListArchivedView = false;

export function isArchivedConversationsView() {
  return conversationListArchivedView;
}

export async function toggleArchivedConversations(next = !conversationListArchivedView) {
  conversationListArchivedView = next === true;
  const toggle = document.getElementById('conv-archived-toggle');
  if (toggle) {
    toggle.setAttribute('aria-pressed', conversationListArchivedView ? 'true' : 'false');
    toggle.title = conversationListArchivedView ? 'Back to the conversations' : 'Show archived conversations';
    toggle.setAttribute('aria-label', toggle.title);
  }
  const banner = document.getElementById('conv-archived-banner');
  if (banner) banner.hidden = !conversationListArchivedView;
  renderConvList();
  // The other view's pages come from the relay; the records already known
  // (an archived chat that was open, say) show at once.
  await refreshConversations({ preservePagination: false });
}

async function setConversationArchived(id, archived) {
  const result = await (archived ? archiveConversationApi(id) : unarchiveConversationApi(id));
  if (!result) return false;
  if (result.ok === false) {
    showTransientRelayNotice(
      String(result.message || '').trim() || `This conversation could not be ${archived ? 'archived' : 'unarchived'}.`,
      6000,
    );
    return false;
  }
  if (conversations[id]) conversations[id].archived = archived;
  renderConvList();
  window.syncChatTitleControls?.();
  window.syncComposerButtonState?.();
  return true;
}

export async function archiveConv(e, id) {
  e?.stopPropagation?.();
  closeContextMenu();
  await setConversationArchived(id, true);
}

export async function unarchiveConv(e, id) {
  e?.stopPropagation?.();
  closeContextMenu();
  await setConversationArchived(id, false);
}

/** The entries of a conversation row's menu. */
function conversationMenuItems(id) {
  const conversation = conversations[id];
  if (!conversation) return [];
  const isCurrent = currentConvId === id;
  const sdkSessionId = String(conversation.sdkSessionId || '').trim();
  const workerState = sdkSessionId ? getSessionWorkerState(sdkSessionId) : null;
  const running = conversationHasActiveTurn(id) || isConversationProcessing(conversation, workerState);
  const openFirst = async (then) => {
    if (!isCurrent) await openConversation(id);
    then();
  };
  return [
    { id: 'open', label: 'Open', onSelect: () => { void openConversation(id); } },
    { id: 'edit-title', label: 'Edit title', onSelect: () => { void openFirst(() => window.openChatTitleEditor?.()); } },
    MENU_SEPARATOR,
    { id: 'stop-turn', label: 'Stop turn', disabled: !running, onSelect: () => { void openFirst(() => openStopTurnConfirmationForConversation(id)); } },
    { id: 'kill-session', label: 'Kill session', disabled: !workerState && !sdkSessionId, onSelect: () => { void openFirst(() => window.openKillSessionConfirmation?.()); } },
    MENU_SEPARATOR,
    conversation.archived === true
      ? { id: 'unarchive', label: 'Unarchive', onSelect: () => { void unarchiveConv(null, id); } }
      : { id: 'archive', label: 'Archive', onSelect: () => { void archiveConv(null, id); } },
    { id: 'delete', label: 'Delete', danger: true, onSelect: () => { void deleteConv({ stopPropagation() {} }, id); } },
  ];
}

/** Right-click (and long press on touch) on a row opens its menu. Bound once; the list's rows are re-rendered freely. */
function bindConversationContextMenu(list) {
  if (!list || list.dataset.contextMenuBound === '1') return;
  list.dataset.contextMenuBound = '1';
  const openFor = (row, x, y) => {
    const id = String(row?.dataset?.conversationId || '').trim();
    if (!id) return;
    const items = conversationMenuItems(id);
    if (items.length) openContextMenu(x, y, items);
  };
  list.addEventListener('contextmenu', (event) => {
    const row = event.target?.closest?.('.conv-item');
    if (!row || !list.contains(row)) return;
    event.preventDefault();
    openFor(row, event.clientX, event.clientY);
  });
  bindLongPress(list, '.conv-item', (row, x, y) => openFor(row, x, y));
}

export async function deleteConv(e, id) {
  e.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  const result = await deleteConversationApi(id);
  if (!result) return;
  if (result.ok === false) {
    showTransientRelayNotice(String(result.message || '').trim() || 'This conversation could not be deleted.', 6000);
    return;
  }
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
