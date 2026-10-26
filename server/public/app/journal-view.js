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
  saveConversationScrollTop,
  loadConversationReadingAnchor,
  saveConversationReadingAnchor,
  isMessagesNearBottom,
  IS_SHARED_VIEW,
  openSummaryModal,
  closeSummaryModal,
  setSummaryModalLeaveHandler,
  conversationGroups,
  mergeConversationGroups,
  forgetKeptEmptyConversationGroups,
  readConversationGroupFoldChoices,
  pruneConversationGroups,
  hasSessionWorkerStatus,
  setConversationGroupFoldChoice,
} from './store.js';
import { archiveConfirmationFor } from './archive-confirm.mjs';
import { arrangeConversationList, conversationGroupPosition } from './conversation-group-order.mjs';
import { describeDragItems, dropAnnouncement, groupMoveStep } from './conversation-group-drag.mjs';
import { bindConversationListDrag } from './conversation-list-drag.mjs';
import { applyFetchedTurnStateToConversation } from './conversation-turn-state.mjs';
import {
  groupIsActive,
  groupSummaryText,
  memberStateClass,
  resolveGroupFold,
  summarizeGroupMembers,
  toggledGroupFoldChoice,
} from './conversation-group-state.mjs';
import {
  loadConversations as loadConversationsApi,
  loadConversation,
  deleteConversation as deleteConversationApi,
  archiveConversation as archiveConversationApi,
  unarchiveConversation as unarchiveConversationApi,
  createConversationGroup as createConversationGroupApi,
  renameConversationGroup as renameConversationGroupApi,
  moveConversationToGroup as moveConversationToGroupApi,
  placeConversationInGroup as placeConversationInGroupApi,
  removeConversationFromGroup as removeConversationFromGroupApi,
  dissolveConversationGroup as dissolveConversationGroupApi,
  archiveConversationGroup as archiveConversationGroupApi,
  stopConversationGroup as stopConversationGroupApi,
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
  loadDeepSeekSettings,
  loadClaudeApiSettings,
  loadOpenAISettings,
} from './api-client.js';
import { isSetupRequired, updateProviderReadinessInputs } from './provider-readiness.mjs';
import { SETUP_TEXT } from './no-conversation-state.mjs';
import { openSettingsModal } from './settings-modal.js';
import { START_ON_SUBSCRIPTION_ACTION, newChatClaudeApiRefusalActions } from './relay-error-ctas.mjs';
import { captureReadingBlock, restoreReadingBlock } from './transcript-viewport-anchor.mjs';
import { runRelayErrorCta, renderMessages, renderNoConversationState, restoreInFlightThinking, focusConversationMessageById, noteTranscriptJump, getTranscriptJumpEpoch, getTranscriptLiveRowEpoch, flushConversationDraft, hydrateConversationDraft, beginConversationDraftSwitch, openStopTurnConfirmationForConversation, conversationHasActiveTurn, captureConversationReadingAnchor, restoreConversationReadingAnchor, detachConversationWindowFromTail, mergeMessagesIntoTranscript, isConversationWindowAtTail } from './conversation-view.js';
import { mergeTailPage } from './transcript-reading-anchor.mjs';
import { readWindowRetention } from './conversation-window-retention.mjs';
import { MENU_SEPARATOR, bindLongPress, closeContextMenu, openContextMenu } from './context-menu.mjs';
import {
  isBackgroundTasksSnapshotCurrent,
  setBackgroundTasksConversation,
  setConversationBackgroundTasks,
  setConversationEndedBackgroundTasks,
  setConversationTaskStallMinutes,
} from './background-tasks-view.mjs';
import { setConversationPins, setPinsConversation } from './pinned-messages-view.mjs';
import { setConversationHiddenMessages, setHiddenMessagesConversation } from './hidden-messages-view.mjs';
import { setUsageLimitConversation } from './usage-limit-ui.js';
import { mergeConversationPreviews } from './preview-cards.mjs';
import { loadRelayQuestions, getPendingQuestionCountsByConversation } from './ask-user-view.js';
import { loadRelayBoards } from './relay-board-view.js';
import { clearAttachments, setRepoBrowserSessionInfo, loadRepoBrowserTree, getRepoBrowserLaunchCwdPath, openRepoBrowserForCwdPick } from './attachments-view.js';
import { buildKnownCwdOptions, normalizeKnownCwdPath } from './known-cwd-options.mjs';
import { shouldApplyConversationLoad } from './activity-replay-state.mjs';
import { conversationPayloadCache, payloadHasMoreOlder, windowPageInfo } from './conversation-payload-cache.mjs';
import { loadKeepingLiveRows, shouldKeepTranscriptOnReload } from './transcript-reload-freshness.mjs';
import { createInfiniteLoader } from './infinite-loader.js';
import {
  buildNewConversationModelChoices,
  newConversationContextTierState,
  preselectNewConversationModel,
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
import { leaveInboxView } from './inbox-ui.js';
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
import { relayEventWatchedMarkerHtml } from './relay-event-subscriptions-ui.js';
import { relayScheduleMarkerHtml } from './relay-schedules-ui.js';
import {
  normalizeConversationFilter,
  conversationMatchesFilter,
  filterConversations,
  drainRemainingPages,
  describeFilterMatchCount,
} from './conversation-list-filter.mjs';

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
let lastConvListHtml = '';
// The list as last rendered, as drag items (conversation-group-drag.mjs).
let lastConvListDragItems = [];
// While a row is lifted or dragged the list is not re-rendered: what arrives
// meanwhile is applied to the records and drawn once the row is let go.
let convListRenderHeld = false;
let convListRenderDeferred = false;
// Groups held open without a stored choice: unfolded by hovering a drag over
// them, or the target of a drop. Until the page reloads or the user folds them.
const convListTransientOpenGroups = new Set();
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
let newConversationDeepSeekSettingsCache = null;
let newConversationClaudeApiSettingsCache = null;
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
// Rows the fetches since the last page-one refresh brought (refreshLoadedConversations).
let conversationRowsFetchedSinceRefresh = 0;
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
  // 'processing' until it aged out, leaving the list row marked as working forever.
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
  // The relay's view of the session (state and live task set) is the truth
  // whenever a payload arrives; the events move it forward in between.
  applyFetchedTurnStateToConversation(conversations[id], record);
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
    mergeConversationGroups(response.groups);
    return {
      items: response.conversations || [],
      hasMore: !!response.pageInfo?.hasMore,
      nextCursor: response.pageInfo?.nextCursor || null,
    };
  },
  applyPage: async (page) => {
    applyConversationPage(page.items);
    conversationRowsFetchedSinceRefresh += Array.isArray(page.items) ? page.items.length : 0;
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

const LIVE_WORKER_STATUSES = new Set(['starting', 'ready', 'processing']);

/** A worker entry from the status poll that stands for a live process. */
function isWorkerStateLive(workerState) {
  return !!workerState && LIVE_WORKER_STATUSES.has(String(workerState?.status || '').trim().toLowerCase());
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
  // The owner's kept empty groups come with the first page only: the page
  // names the ones still kept.
  forgetKeptEmptyConversationGroups();
  mergeConversationGroups(r.groups);
  applyConversationPage(r.conversations || []);
  conversationRowsFetchedSinceRefresh = Array.isArray(r.conversations) ? r.conversations.length : 0;
  // A group no loaded row belongs to any more (dissolved, or its rows left)
  // is forgotten: the picker offers the groups that exist.
  pruneConversationGroups(Object.values(conversations).map((conversation) => conversation?.groupId));
  resetConversationListPageState(r.pageInfo || null, {
    preserveProgress: preservePagination,
  });
  renderConvList();
  // With nothing open the transcript's screen depends on whether chats exist.
  if (!currentConvId) renderNoConversationState();
  updateCompactButton();
  // A reset bumps the loader version, which aborts any in-flight filter drain;
  // restart it so an active filter keeps covering the unloaded pages.
  if (normalizeConversationFilter(conversationListFilterText)) {
    void drainConversationListForFilter();
  }
}

/**
 * Fetches every loaded page again: page one, then as many older pages as
 * the list had, so a change on a row far down the list (a group action on
 * an old chat, a reconnect) shows without a reload. One refresh runs at a
 * time: a call while one runs marks it to run once more afterwards, so the
 * last state always lands and two refreshes never interleave their pages.
 */
let loadedConversationsRefreshRunning = null;
let loadedConversationsRefreshAgain = false;
export function refreshLoadedConversations() {
  if (loadedConversationsRefreshRunning) {
    loadedConversationsRefreshAgain = true;
    return loadedConversationsRefreshRunning;
  }
  loadedConversationsRefreshRunning = (async () => {
    try {
      do {
        loadedConversationsRefreshAgain = false;
        await refreshLoadedConversationsOnce();
      } while (loadedConversationsRefreshAgain);
    } finally {
      loadedConversationsRefreshRunning = null;
    }
  })();
  return loadedConversationsRefreshRunning;
}

async function refreshLoadedConversationsOnce() {
  const loadedBefore = Object.values(conversations)
    .filter((conversation) => (conversation?.archived === true) === conversationListArchivedView).length;
  // Rows of pages not fetched again stay in the map as they were, so the
  // pages are counted by what the fetches bring, not by what the map holds.
  await refreshConversations({ preservePagination: false });
  let guard = 0;
  while (conversationRowsFetchedSinceRefresh < loadedBefore && conversationListLoader.getState().hasMore && guard < 50) {
    guard += 1;
    const before = conversationRowsFetchedSinceRefresh;
    await conversationListLoader.loadMore();
    if (conversationRowsFetchedSinceRefresh === before) break;
  }
  pruneConversationGroups(Object.values(conversations).map((conversation) => conversation?.groupId));
  renderConvList();
}

// Several events within a moment (a group action touches its members one by
// one) give one refresh.
const LOADED_REFRESH_COALESCE_MS = 150;
let loadedConversationsRefreshTimer = null;
export function scheduleLoadedConversationsRefresh() {
  if (loadedConversationsRefreshTimer) return;
  loadedConversationsRefreshTimer = setTimeout(() => {
    loadedConversationsRefreshTimer = null;
    refreshLoadedConversations().catch(() => {});
  }, LOADED_REFRESH_COALESCE_MS);
}

/**
 * A `conversation_group_changed` event. What it carries is applied in
 * place: the group's summary (or its end) and the named conversations'
 * membership. A fetch is scheduled only when the event names a conversation
 * this page has not loaded (it may now belong under a loaded head), or
 * carries no detail (an older relay).
 */
export function applyConversationGroupEvent(payload) {
  const groupId = String(payload?.groupId || '').trim();
  const memberships = payload?.memberships && typeof payload.memberships === 'object' ? payload.memberships : null;
  if (!groupId || !memberships) {
    scheduleLoadedConversationsRefresh();
    return 'fetch';
  }
  if (payload.group && typeof payload.group === 'object') {
    mergeConversationGroups({ [groupId]: payload.group });
  } else {
    delete conversationGroups[groupId];
  }
  let needsFetch = false;
  for (const [conversationId, membership] of Object.entries(memberships)) {
    const record = conversations[conversationId];
    if (!record) {
      needsFetch = true;
      continue;
    }
    record.groupId = membership?.groupId ? String(membership.groupId) : null;
    record.groupRole = record.groupId ? (membership?.role === 'head' ? 'head' : 'member') : null;
    if (!record.groupId) record.groupPosition = null;
  }
  applyConversationGroupPositions(payload.positions);
  pruneConversationGroups(Object.values(conversations).map((conversation) => conversation?.groupId));
  renderConvList();
  if (pendingConvRowFlash && Date.now() < pendingConvRowFlash.until && Object.hasOwn(memberships, pendingConvRowFlash.id)) {
    flashConversationRow(pendingConvRowFlash.id);
    pendingConvRowFlash = null;
  }
  if (needsFetch) scheduleLoadedConversationsRefresh();
  return needsFetch ? 'fetch' : 'in-place';
}

/**
 * The hand order of a group's rows (`{ [conversationId]: number | null }`),
 * as the relay announces it. An older relay sends none.
 */
function applyConversationGroupPositions(positions) {
  if (!positions || typeof positions !== 'object') return;
  for (const [conversationId, position] of Object.entries(positions)) {
    const record = conversations[conversationId];
    if (!record) continue;
    record.groupPosition = conversationGroupPosition({ groupPosition: position });
  }
}

/**
 * A sidebar row's state: its colour (green is 'ready') and whether it works
 * (a turn or background work), which keeps a ready title bright green.
 */
function conversationRowState(conversation, pendingByConversation = getPendingQuestionCountsByConversation()) {
  const pendingCount = Number(pendingByConversation[conversation?.id] || 0);
  const sdkSessionId = String(conversation?.sdkSessionId || '').trim();
  const workerState = sdkSessionId ? getSessionWorkerState(sdkSessionId) : null;
  const visualState = resolveConversationUiState({
    conversation,
    workerState,
    hasPendingQuestion: pendingCount > 0,
  });
  const processing = isConversationProcessing(conversation, workerState)
    || String(conversation?.sessionState || '').trim() === 'running_turn';
  // Background work lives in the session's worker: once the worker status is
  // known, a session without a live worker has none, whatever the last
  // event or fetch said (the worker was killed, or the relay restarted).
  let sessionState = String(conversation?.sessionState || '').trim();
  if (sessionState === 'background_only' && hasSessionWorkerStatus() && !isWorkerStateLive(workerState)) sessionState = 'idle';
  return {
    visualState,
    processing,
    working: processing || sessionState === 'background_only',
    pendingCount,
    // A turn or background work, whether or not a card waits in it: what
    // "Stop all running" acts on, and what keeps an archive from it.
    live: processing || pendingCount > 0 || conversation?.activeTurn === true || sessionState === 'running_turn' || sessionState === 'background_only',
    // The member class the group's head row sums up (conversation-group-state.mjs).
    memberState: memberStateClass({
      pendingCount,
      visualState,
      processing,
      activeTurn: conversation?.activeTurn === true,
      sessionState,
    }),
  };
}

/** Whether the conversation works now: the chat header's title follows the row's. */
export function isConversationWorking(conversation) {
  return !!conversation && conversationRowState(conversation).working;
}

/** The group's head and its name for the picker and the menus. */
function groupDisplayName(groupId) {
  const info = conversationGroups[groupId] || null;
  const head = info?.parentConversationId ? conversations[info.parentConversationId] : null;
  return String(info?.name || head?.title || info?.displayName || 'Group').trim() || 'Group';
}

/** The loaded rows of a group, in the current view and across it. */
function groupMemberRows(groupId, { inViewOnly = true } = {}) {
  return Object.values(conversations).filter((conversation) => String(conversation?.groupId || '') === groupId
    && (!inViewOnly || (conversation?.archived === true) === conversationListArchivedView));
}

/**
 * What a head row shows for its group: the classes of every row in it, the
 * head included (the menu's "Archive group (N)" and "Stop all running (N)"
 * count the same rows), their summary, and the first row a waiting card
 * sits in.
 */
function describeGroupForHead(group, viewOf) {
  const rows = group.head ? [group.head, ...group.members] : [...group.members];
  const states = rows.map((row) => viewOf(row).memberState);
  const summary = summarizeGroupMembers(states);
  const firstWaiting = rows.find((row) => viewOf(row).memberState === 'waiting') || null;
  return { summary, firstWaiting, forcedOpen: false };
}

export function renderConvList() {
  if (convListRenderHeld) {
    convListRenderDeferred = true;
    return;
  }
  paintConvList();
}

function holdConvListRender(held) {
  convListRenderHeld = held === true;
  if (convListRenderHeld || !convListRenderDeferred) return;
  convListRenderDeferred = false;
  paintConvList();
}

function paintConvList() {
  const list = document.getElementById('conv-list');
  const activeFilter = normalizeConversationFilter(conversationListFilterText);
  // The live list and the Archived view are two views of the same records.
  const inView = Object.values(conversations).filter((conversation) => (conversation?.archived === true) === conversationListArchivedView);
  const pendingByConversation = getPendingQuestionCountsByConversation();
  const rowViews = new Map();
  const viewOf = (conversation) => {
    const id = String(conversation?.id || '');
    if (!rowViews.has(id)) rowViews.set(id, conversationRowState(conversation, pendingByConversation));
    return rowViews.get(id);
  };
  const foldChoices = readConversationGroupFoldChoices();
  const groupDescriptions = new Map();
  // Groups order with the same rules the list route pages by; a group is
  // folded once nothing in it runs or waits, unless the user chose otherwise.
  const items = arrangeConversationList(inView, conversationGroups, {
    matches: activeFilter ? (row) => conversationMatchesFilter(row, activeFilter) : null,
    groupNameMatches: activeFilter ? (info) => conversationMatchesFilter({ title: info?.displayName || info?.name }, activeFilter) : null,
    // An owner's group an agent emptied shows in the live list, empty.
    emptyGroups: !conversationListArchivedView,
    isOpen: (groupId, group) => {
      const described = describeGroupForHead(group, viewOf);
      const holdsOpenConversation = !!currentConvId && group.members.some((row) => row.id === currentConvId);
      // Open whatever the choice: the fold button then says so and does nothing.
      described.forcedOpen = holdsOpenConversation || !!activeFilter;
      groupDescriptions.set(groupId, described);
      if (convListTransientOpenGroups.has(groupId)) return true;
      return resolveGroupFold({
        choice: foldChoices[groupId] || null,
        active: groupIsActive(described.summary),
        holdsOpenConversation,
        filterActive: !!activeFilter,
      });
    },
  });
  lastConvListDragItems = describeDragItems(items);
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
  if (items.length === 0) {
    const emptyText = activeFilter && inView.length > 0
      ? 'No conversations match your filter'
      : (conversationListArchivedView ? 'No archived conversations' : 'No conversations yet');
    list.innerHTML = `<div style="padding:12px;color:var(--muted);font-size:0.85rem;text-align:center">${emptyText}</div>${footerHtml}`;
    lastConvListHtml = '';
    scheduleConversationListBoundaryCheck();
    return;
  }
  // The head row's pill: the member count and what the members are doing;
  // while folded, its "waiting" part opens the member the card sits in.
  const groupPillHtml = (item) => {
    const described = groupDescriptions.get(item.group.id) || describeGroupForHead(item.group, viewOf);
    const text = groupSummaryText(described.summary);
    if (!text) return '';
    const waitingId = described.firstWaiting ? String(described.firstWaiting.id) : '';
    // Inline like the row's own buttons: the row's click handler must not
    // run (it would open the head and re-render the list first).
    // The full text is the title: a narrow sidebar shortens the pill with an ellipsis.
    const title = waitingId ? `${text} · open the session that is waiting for you` : text;
    return `<span class="conv-group-summary conv-group-summary-${described.summary.strongest}" title="${escHtml(title)}"${waitingId ? ` data-open-waiting="${escHtml(waitingId)}" role="button" tabindex="0" onclick="event.stopPropagation();openConversation('${escHtml(waitingId)}')"` : ''}>${escHtml(text)}</span>`;
  };
  const foldButtonHtml = (item) => {
    const forced = (groupDescriptions.get(item.group.id) || {}).forcedOpen === true || item.group.contextOnly === true || !!activeFilter;
    const label = forced
      ? (activeFilter ? 'Open while the filter is on' : 'Open while its chat is open')
      : (item.group.open ? 'Fold group' : 'Unfold group');
    return `<button class="conv-group-fold" type="button" data-group-fold="${escHtml(item.group.id)}" aria-expanded="${item.group.open ? 'true' : 'false'}" aria-label="${label}" title="${label}"${forced ? ' disabled' : ''} onclick="toggleConversationGroupFold(event,'${escHtml(item.group.id)}')">${item.group.open ? '▾' : '▸'}</button>`;
  };
  const rowHtml = (c, item) => {
    const view = viewOf(c);
    const providerIndicatorLabel = conversationProviderIndicatorLabel(c);
    const providerIndicatorKey = conversationProviderIndicatorKey(c);
    const providerIndicatorHtml = providerIndicatorLabel
      ? `<span class="conv-provider-indicator"${providerIndicatorKey ? ` data-provider="${providerIndicatorKey}"` : ''}>${providerIndicatorLabel}</span>`
      : '';
    // "↗ win-test": another relay's agent created this conversation.
    // "via agent · “title”": an agent in that conversation on this relay did.
    // A member under its creator's head row says that already, so it is left out there.
    const originMarkerHtml = item.kind === 'member' && item.group.head && c.origin?.local === true && c.origin.conversationId === item.group.head.id
      ? ''
      : renderConversationOriginMarkerHtml(c, { conversations });
    // "watched": a session another conversation watches by id (relay events).
    const watchedMarkerHtml = relayEventWatchedMarkerHtml(c.id);
    // "scheduled": a schedule fires into this session (relay_tool schedule).
    const scheduledMarkerHtml = relayScheduleMarkerHtml(c.id);
    const groupClass = item.kind === 'head' ? ' conv-group-head' : (item.kind === 'member' ? ' conv-group-member' : '');
    const groupAttr = item.kind === 'head' || item.kind === 'member' ? ` data-group-id="${escHtml(item.group.id)}"` : '';
    // A head row shows the name the group was given by hand; until then the
    // conversation's own title (the group's name follows it).
    const handName = item.kind === 'head' ? String(item.group.info?.name || '').trim() : '';
    const rowTitle = handName || c.title;
    const titleAttr = handName && handName !== c.title ? ` title="${escHtml(`${handName} · ${c.title}`)}"` : '';
    return `
    <div class="conv-item worker-ui-${view.visualState}${view.working ? ' conv-working' : ''}${c.id === currentConvId ? ' active' : ''}${c.archived ? ' archived' : ''}${groupClass}" data-conversation-id="${c.id}"${groupAttr} onclick="openConversation('${c.id}')">
      <div class="conv-title"${titleAttr}>${item.kind === 'head' ? foldButtonHtml(item) : ''}${escHtml(rowTitle)}${pendingByConversation[c.id] ? ` <span class="conv-open-questions">${pendingByConversation[c.id]} open</span>` : ''}</div>
      <div class="conv-meta"><span class="conv-meta-primary">${fmtDate(c.updatedAt)} · ${c.messageCount} msg${c.messageCount !== 1 ? 's' : ''}</span>${item.kind === 'head' ? groupPillHtml(item) : ''}${originMarkerHtml}${watchedMarkerHtml}${scheduledMarkerHtml}${providerIndicatorHtml}</div>
      ${c.archived
        ? `<button class="conv-archive" onclick="unarchiveConv(event,'${c.id}')" title="Unarchive" aria-label="Unarchive">📂</button>`
        : `<button class="conv-archive" onclick="archiveConv(event,'${c.id}')" title="Archive" aria-label="Archive">🗄</button>`}
      <button class="conv-delete" onclick="deleteConv(event,'${c.id}')" title="Delete">🗑</button>
    </div>`;
  };
  // A group whose head is not in this view (made by hand, or its head is
  // archived or deleted): a head line of its own, with the name and the pill.
  const syntheticHeadHtml = (item) => {
    const name = groupDisplayName(item.group.id);
    // An owner's group an agent emptied: no members, nothing to fold; its
    // menu (right-click or long-press) renames or dissolves it.
    if (item.group.empty) {
      return `
    <div class="conv-item conv-group-head conv-group-synthetic conv-group-empty worker-ui-offline" data-group-id="${escHtml(item.group.id)}" title="An agent moved the last session out of this group; rename or dissolve it from its menu.">
      <div class="conv-title">${escHtml(name)}</div>
      <div class="conv-meta"><span class="conv-meta-primary">group · empty</span></div>
    </div>`;
    }
    const described = groupDescriptions.get(item.group.id) || describeGroupForHead(item.group, viewOf);
    return `
    <div class="conv-item conv-group-head conv-group-synthetic worker-ui-${described.summary.strongest === 'waiting' ? 'question' : 'offline'}" data-group-id="${escHtml(item.group.id)}" onclick="toggleConversationGroupFold(event,'${escHtml(item.group.id)}')">
      <div class="conv-title">${foldButtonHtml(item)}${escHtml(name)}</div>
      <div class="conv-meta"><span class="conv-meta-primary">group</span>${groupPillHtml(item)}</div>
    </div>`;
  };
  const listHtml = `${items.map((item) => (item.conversation ? rowHtml(item.conversation, item) : syntheticHeadHtml(item))).join('')}${footerHtml}`;
  if (listHtml !== lastConvListHtml) {
    list.innerHTML = listHtml;
    lastConvListHtml = listHtml;
  }
  bindConversationContextMenu(list);
  bindConversationGroupControls(list);
  window.syncChatTitleControls?.();
  scheduleConversationListBoundaryCheck();
}

/**
 * Keyboard access to the waiting pill (its click is inline, like the rows'
 * buttons; the fold is a real button). Bound once on the list.
 */
function bindConversationGroupControls(list) {
  if (!list || list.dataset.groupControlsBound === '1') return;
  list.dataset.groupControlsBound = '1';
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const waiting = event.target?.closest?.('[data-open-waiting]');
    if (!waiting || !list.contains(waiting)) return;
    event.preventDefault();
    event.stopPropagation();
    void (window.openConversation || openConversation)(waiting.dataset.openWaiting);
  });
}

/**
 * Folds or unfolds a group; the choice is kept until the user changes it. A
 * group held open (its chat is open, or a filter is on) keeps its choice.
 * The fold button keeps the focus across the re-render.
 */
export function toggleConversationGroupFold(event, groupId) {
  event?.stopPropagation?.();
  event?.preventDefault?.();
  const id = String(groupId || '').trim();
  if (!id) return;
  const button = document.querySelector(`#conv-list [data-group-fold="${CSS.escape(id)}"]`);
  if (button?.disabled) return;
  const currentlyOpen = button ? button.getAttribute('aria-expanded') === 'true' : true;
  convListTransientOpenGroups.delete(id);
  setConversationGroupFoldChoice(id, toggledGroupFoldChoice(currentlyOpen));
  renderConvList();
  document.querySelector(`#conv-list [data-group-fold="${CSS.escape(id)}"]`)?.focus?.({ preventScroll: true });
}

// keepTranscript: the page shows a window this payload must not replace (the
// user jumped into the history; the payload is the end of the conversation).
// Everything but the messages still applies.
// fromCache: the payload is the window kept from an earlier visit
// (conversation-payload-cache.mjs), drawn while the fresh one is on its way.
// Only the transcript and what goes with it is drawn: the record, the
// composer, the draft, the live bubble and the tasks wait for the fresh answer.
// viewAnchor: the place read (transcript-reading-anchor.mjs) the restore
// puts back, in place of savedScrollTop.
// mergeFrom: the messages on the page; the payload's are merged into them
// rather than drawn anew (mergeMessagesIntoTranscript).
// windowPayload: with keepTranscript, the window the page keeps, kept for
// the next visit in place of nothing.
// backgroundTasksAsOf: backgroundTasksSnapshotMark(id) as the request left;
// the payload's task sets are left out when an event brought newer ones since.
export function applyLoadedConversationState(id, response, {
  restoreScroll = false,
  savedScrollTop = null,
  viewAnchor = null,
  followLiveUpdates = !restoreScroll,
  keepTranscript = false,
  fromCache = false,
  mergeFrom = null,
  windowPayload = null,
  backgroundTasksAsOf = null,
} = {}) {
  if (!response) {
    if (!IS_SHARED_VIEW) conversationPayloadCache.forget(id);
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
    renderMessages([]);
    window.syncChatTitleControls?.();
    return;
  }
  if (fromCache) {
    applyCachedConversationState(id, response, { viewAnchor });
    return;
  }
  if (!IS_SHARED_VIEW) {
    // The page keeps a window this payload does not show: what it shows is
    // not this payload, so only a window the caller names is kept for the
    // next visit. Without one the entry already there stays: it follows the
    // page (its pages and live rows are added to it), so it still is the
    // window on screen. The cache keeps this very object, uncopied: nothing
    // below may change it.
    if (windowPayload) conversationPayloadCache.remember(id, windowPayload);
    else if (!keepTranscript) conversationPayloadCache.remember(id, response);
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
    // A shared payload has no runtime session, only the provider (null when
    // none is bound); the shared view keeps an unknown one unknown.
    runtimeProviderType: response.runtimeSession?.providerType
      ?? response.runtimeProviderType
      ?? existingConversation.runtimeProviderType
      ?? (IS_SHARED_VIEW ? null : 'github'),
    runtimeProviderModel: response.runtimeSession?.providerModel
      ?? existingConversation.runtimeProviderModel
      ?? null,
    runtimeModel: response.runtimeSession?.model
      ?? existingConversation.runtimeModel
      ?? null,
    // The session's state and live tasks, as the single payload reports them.
    ...(typeof response.activeTurn === 'boolean' ? { activeTurn: response.activeTurn } : {}),
    ...(response.sessionState ? { sessionState: response.sessionState } : {}),
    ...(Array.isArray(response.backgroundTasks) ? { backgroundTasks: response.backgroundTasks } : {}),
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
    // This payload's verdict only: the record's copy can predate the turn the
    // socket has since reported running, and would end it on the page.
    activeTurn: response.activeTurn,
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
  // Their Hide / Unhide too, from the hidden list (owner payloads only).
  if ('hiddenMessages' in response) setConversationHiddenMessages(id, response.hiddenMessages, response.hiddenMessagesRevision);
  setHiddenMessagesConversation(id);
  let didRenderMessages = false;
  if (!keepTranscript) {
    didRenderMessages = mergeFrom
      ? mergeMessagesIntoTranscript(mergeFrom, response.messages, response)
      : renderMessages(response.messages, !restoreScroll, response);
  }
  hydrateConversationDraft(id, {
    draftText: response.draftText,
    draftAttachments: response.draftAttachments,
    draftUpdatedAt: response.draftUpdatedAt,
    draftUpdatedByClientId: response.draftUpdatedByClientId,
  });
  restoreInFlightThinking(response.inFlight || null, followLiveUpdates);
  setBackgroundTasksConversation(id);
  // Absent from an older relay's payload: the threshold keeps its default.
  if ('taskStallMinutes' in response) setConversationTaskStallMinutes(id, response.taskStallMinutes);
  if (isBackgroundTasksSnapshotCurrent(id, backgroundTasksAsOf)) {
    setConversationBackgroundTasks(id, response.backgroundTasks || []);
    // Absent from an older relay's payload: keep what the socket said.
    if (Array.isArray(response.endedBackgroundTasks)) setConversationEndedBackgroundTasks(id, response.endedBackgroundTasks);
  }
  setUsageLimitConversation(id, {
    // Absent from an older relay's payload: keep what the socket said.
    pause: 'usageLimitPause' in response ? response.usageLimitPause : undefined,
    providerType: response.runtimeSession?.providerType,
    // A Claude chat's billing and whether it may switch (an older relay: absent).
    billing: 'billing' in response ? response.billing : undefined,
  });
  // Merge, not replace: this payload only carries one conversation's previews.
  mergeConversationPreviews(id, response.previews || []);
  updateSessionPill(conversations[id], response.runtimeSession || null);
  window.syncChatTitleControls?.();
  if (!restoreScroll || !didRenderMessages) return;
  restoreConversationScroll(id, savedScrollTop, viewAnchor);
}

// The place read when it is on the page, else the pixel position given, else
// the end.
function restoreConversationScroll(id, savedScrollTop, viewAnchor = null) {
  const el = document.getElementById('messages');
  if (!el) return;
  if (viewAnchor && restoreConversationReadingAnchor(viewAnchor)) {
    saveConversationScrollTop(id, el.scrollTop);
    return;
  }
  if (Number.isFinite(savedScrollTop)) {
    el.scrollTop = savedScrollTop;
    saveConversationScrollTop(id, el.scrollTop);
    return;
  }
  el.scrollTop = el.scrollHeight;
  saveConversationScrollTop(id, el.scrollTop);
}

function payloadHasMessage(response, messageId) {
  const id = String(messageId || '').trim();
  return !!id && Array.isArray(response?.messages) && response.messages.some((message) => String(message?.id || '').trim() === id);
}

// The kept window of a conversation, when it holds the place read: a window
// without it (a row edited since dropped it, the kept rows were cut) would
// put the reader somewhere else.
function readCachedWindow(id, anchor) {
  const cached = conversationPayloadCache.read(id);
  if (!cached) return null;
  if (anchor && !anchor.atTail && anchor.messageId && !payloadHasMessage(cached, anchor.messageId)) return null;
  return cached;
}

// The conversation being left: its place is noted as it is on the page, and
// its kept window is cut down to the retention cap around that place.
function keepPlaceOfConversationLeft(conversationId) {
  const captured = captureConversationReadingAnchor();
  const shown = captured?.conversationId === conversationId;
  // During a quick run through several conversations the page still shows
  // an earlier one: the place saved for this one stands.
  const anchor = shown ? captured.anchor : loadConversationReadingAnchor(conversationId);
  if (shown) saveConversationReadingAnchor(conversationId, anchor);
  conversationPayloadCache.trim(conversationId, {
    cap: readWindowRetention(),
    anchorMessageId: anchor?.messageId || '',
    atTail: anchor?.atTail === true,
  });
}

// The kept window of a conversation, drawn on a switch back to it, at the
// place read. Pins and the hidden list are revision-guarded, so an older copy
// cannot undo a newer change the socket brought.
function applyCachedConversationState(id, response, { viewAnchor = null } = {}) {
  setRepoBrowserSessionInfo(response.sessionRootPath || '', response.sessionRootName || response.title || '');
  if ('pins' in response) setConversationPins(id, response.pins, response.pinsRevision);
  setPinsConversation(id);
  if ('hiddenMessages' in response) setConversationHiddenMessages(id, response.hiddenMessages, response.hiddenMessagesRevision);
  setHiddenMessagesConversation(id);
  const didRenderMessages = renderMessages(response.messages, false, response);
  // The panel shows this conversation's tasks as the socket keeps them.
  setBackgroundTasksConversation(id);
  window.syncChatTitleControls?.();
  if (!didRenderMessages) return;
  restoreConversationScroll(id, null, viewAnchor);
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

// The fresh answer for a conversation whose kept window is on the page (drawn
// on the switch back, or still there when the conversation on screen is
// opened again). A window that reaches the end takes the answer's rows: those
// it has are replaced (a reply may have finished since), the new ones join
// it, nothing else is rebuilt. A reader at the end stays at the end, one who
// is not keeps the message they are at where it is, wherever they scrolled
// to while the answer was on its way. A window in the middle of the history
// keeps its rows: they do not change (an edit comes as message_updated, which
// drops the window of a conversation not on screen and updates the one on
// screen); the rest of the answer applies.
function applyFreshOverCachedConversation(id, response, { cached, keepTranscript = false } = {}) {
  const atEnd = isMessagesNearBottom() && isConversationWindowAtTail();
  if (keepTranscript) {
    applyLoadedConversationState(id, response, { keepTranscript: true, followLiveUpdates: false });
    return;
  }
  const keptWindow = (hasMoreNewer) => ({
    ...response,
    messages: cached.messages,
    hasMoreOlder: cached.hasMoreOlder,
    hasMoreNewer,
  });
  if (cached.hasMoreNewer) {
    applyLoadedConversationState(id, response, { keepTranscript: true, followLiveUpdates: false, windowPayload: keptWindow(true) });
    return;
  }
  // The kept copy was read before the request: every row of it predates the
  // answer, so a newer one the answer lacks was deleted while away.
  const merged = mergeTailPage(cached.messages, response.messages, {
    pageHasMoreOlder: payloadHasMoreOlder(response),
    windowPredatesPage: true,
  });
  if (!merged) {
    // More was written than the answer holds: a reader at the end gets the
    // end; anyone else keeps the window, which no longer reaches it.
    if (atEnd) {
      applyLoadedConversationState(id, response, { restoreScroll: false });
      return;
    }
    detachConversationWindowFromTail();
    applyLoadedConversationState(id, response, { keepTranscript: true, followLiveUpdates: false, windowPayload: keptWindow(true) });
    return;
  }
  const place = atEnd ? null : captureConversationReadingAnchor()?.anchor;
  const flags = { hasMoreOlder: cached.hasMoreOlder, hasMoreNewer: false };
  applyLoadedConversationState(id, {
    ...response,
    messages: merged.messages,
    ...flags,
    pageInfo: windowPageInfo(merged.messages, flags),
  }, {
    mergeFrom: cached.messages,
    followLiveUpdates: atEnd,
  });
  const messagesEl = document.getElementById('messages');
  if (!messagesEl) return;
  if (atEnd) messagesEl.scrollTop = messagesEl.scrollHeight;
  else if (place) restoreConversationReadingAnchor(place);
  saveConversationScrollTop(id, messagesEl.scrollTop);
}

export async function openConversation(id, options = {}) {
  // The Inbox owns the transcript like the status view does.
  const didLeaveInboxView = leaveInboxView();
  const didLeaveStatusView = leaveStatusView() || didLeaveInboxView;
  document.getElementById('input-area')?.removeAttribute('hidden');
  const previousConversationId = String(currentConvId || '').trim();
  const nextConversationId = String(id || '').trim();
  if (previousConversationId && nextConversationId && previousConversationId !== nextConversationId) {
    // Reads the composer now, before it changes hands below, and saves in the
    // background: a switch that waited for the save would take over the view
    // when the save returns, after any click the user made meanwhile.
    void flushConversationDraft(previousConversationId);
    window.clearImageEditTarget?.();
  }
  const switchingConversation = !!nextConversationId && previousConversationId !== nextConversationId;
  if (switchingConversation && previousConversationId && !IS_SHARED_VIEW) keepPlaceOfConversationLeft(previousConversationId);
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
  const keepsPlace = !forceFreshWindow && !IS_SHARED_VIEW;
  const savedAnchor = keepsPlace ? loadConversationReadingAnchor(id) : null;
  // Switching back to a conversation seen before on this page: its kept
  // window is drawn at once, at the place read, and the fresh answer below
  // is merged into it.
  const cached = keepsPlace ? readCachedWindow(id, savedAnchor) : null;
  if (cached && (switchingConversation || didLeaveStatusView)) {
    applyLoadedConversationState(id, cached, { fromCache: true, viewAnchor: savedAnchor });
  }
  // Nothing kept (a reload, a window dropped): a reader who was not at the
  // end gets the messages around the one they read, as after a search jump.
  // Only when the page does not show the conversation already: reopening the
  // one on screen (a session bound, a click on it, a push) rebuilds its end
  // under the reader, a jump would throw away the window they scrolled.
  const showsOtherTranscript = switchingConversation || didLeaveStatusView;
  const anchorMessageId = !cached && showsOtherTranscript && savedAnchor && !savedAnchor.atTail
    ? String(savedAnchor.messageId || '').trim()
    : '';
  const cachedJumpEpoch = cached ? getTranscriptJumpEpoch() : 0;
  const load = (around = aroundMessageId || anchorMessageId) => loadConversation(id, {
    limit: around ? 40 : 20,
    aroundMessageId: around || undefined,
  });
  const stillWanted = () => shouldApplyConversationLoad({
    requestedConversationId: id,
    activeConversationId: currentConvId,
    capturedVersion,
    currentVersion: openConversationVersion,
  });
  // The drawn copy takes live rows from the socket while the answer is on its
  // way; an answer that may lack them is asked again, as the live poll does.
  const { response: fetched, stale } = cached
    ? await loadKeepingLiveRows(load, getTranscriptLiveRowEpoch)
    : { response: await load(), stale: false };
  if (!stillWanted()) return;
  let r = fetched;
  const anchorFound = !!anchorMessageId && payloadHasMessage(r, anchorMessageId);
  if (r && anchorMessageId && !anchorFound) {
    // The message read is gone (deleted, compacted away): the end instead.
    r = await load('');
    if (!stillWanted()) return;
  }
  if (r && cached) {
    applyFreshOverCachedConversation(id, r, {
      cached,
      // A jump into the history from the drawn copy (a pin) wins. A stale
      // answer is still merged, unlike on the live poll: the drawn copy
      // predates the rows stored while the reader was away.
      keepTranscript: shouldKeepTranscriptOnReload({
        stale,
        jumped: getTranscriptJumpEpoch() !== cachedJumpEpoch,
        showsLiveTranscript: false,
      }),
    });
  } else if (r) {
    // The conversation on screen opened again (a worker bound its session):
    // its rows are rebuilt under the reader, who keeps the text they are at.
    const messagesEl = document.getElementById('messages');
    const rereading = !switchingConversation && !anchorFound && !isMessagesNearBottom();
    const reading = rereading ? captureReadingBlock(messagesEl) : null;
    // Counted when the window is put on the page, not when it is asked for:
    // a reload of the end that is still on its way must see the change.
    if (forceFreshWindow || anchorFound) noteTranscriptJump();
    applyLoadedConversationState(id, r, {
      restoreScroll: rereading || anchorFound,
      savedScrollTop: rereading ? (messagesEl?.scrollTop ?? null) : null,
      viewAnchor: anchorFound ? savedAnchor : null,
    });
    if (reading) restoreReadingBlock(messagesEl, reading);
    if (focusMessageId) {
      requestAnimationFrame(() => {
        focusConversationMessageById(focusMessageId, { behavior: 'smooth', block: 'center' });
      });
    }
  } else {
    conversationPayloadCache.forget(id);
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
  if (normalized === 'claude-api') return 'claude-api';
  if (normalized === CLAUDE_CLOUD_PROVIDER) return CLAUDE_CLOUD_PROVIDER;
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'grok') return 'grok';
  if (normalized === 'deepseek') return 'deepseek';
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
  const hasDeepSeek = providers.includes('deepseek');
  const hasClaudeApi = providers.includes('claude-api');
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
  if (normalizedProvider === 'deepseek') {
    if (hasDeepSeek) return true;
    const deepseekModel = String(newConversationDeepSeekSettingsCache?.model || '').trim();
    const deepseekModels = Array.isArray(newConversationDeepSeekSettingsCache?.models)
      ? newConversationDeepSeekSettingsCache.models.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    return normalizedModelId === deepseekModel || deepseekModels.includes(normalizedModelId);
  }
  if (normalizedProvider === 'claude-api') {
    if (hasClaudeApi) return true;
    const claudeApiModel = String(newConversationClaudeApiSettingsCache?.model || '').trim();
    const claudeApiModels = Array.isArray(newConversationClaudeApiSettingsCache?.models)
      ? newConversationClaudeApiSettingsCache.models.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    return normalizedModelId === claudeApiModel || claudeApiModels.includes(normalizedModelId);
  }
  // Claude API serves the Claude provider's ids: still none of Copilot's.
  const claudeOnly = hasClaude && providers.every((provider) => provider === 'claude' || provider === 'claude-api');
  if (claudeOnly) return false;
  const cursorOnly = hasCursor && providers.every((provider) => provider === 'cursor');
  if (cursorOnly) return false;
  const grokOnly = hasGrok && providers.every((provider) => provider === 'grok');
  if (grokOnly) return false;
  const deepseekOnly = hasDeepSeek && providers.every((provider) => provider === 'deepseek');
  if (deepseekOnly) return false;
  // Should a relay ever tag catalog rows for Claude Cloud, they are no more
  // Copilot's than the other runtimes' rows are.
  const exclusiveOnly = providers.length > 0 && providers.every((provider) => (
    provider === 'claude' || provider === 'cursor' || provider === 'grok' || provider === 'deepseek'
    || provider === 'claude-api' || provider === CLAUDE_CLOUD_PROVIDER
  ));
  if (exclusiveOnly) return false;
  return providers.some((provider) => (
    provider !== 'openai-byok'
    && provider !== 'claude'
    && provider !== 'cursor'
    && provider !== 'grok'
    && provider !== 'deepseek'
    && provider !== 'claude-api'
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
  // A DeepSeek chat with nothing remembered starts at DeepSeek's own default.
  const storedEffort = localStorage.getItem(REASONING_STORAGE_KEY);
  const preferred = resolvePreferredReasoningEffort(efforts, [
    storedEffort || (provider === 'deepseek' ? 'high' : ''),
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
  if (normalizedProvider === 'claude-api') {
    help.textContent = 'Claude API chats run through the Claude Agent SDK on the API key saved in Settings, billed to its Claude Console organisation. The chat can switch to the subscription later.';
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
  if (normalizedProvider === 'deepseek') {
    help.textContent = "DeepSeek chats run Claude Code on the relay host against DeepSeek's API, billed to your saved DeepSeek key.";
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
      annotateContextWindow: normalizedProvider !== 'claude' && normalizedProvider !== 'claude-api' && !isCloud,
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
  } else {
    const preselected = preselectNewConversationModel(Array.from(target.options, (option) => option.value), {
      storedModel,
      providerDefault: normalizedProvider === 'claude-api' ? newConversationClaudeApiSettingsCache?.model : '',
      allowAuto: normalizedProvider !== 'openai-image',
    });
    if (preselected) target.value = preselected;
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

// The New Chat modal with no provider known to be ready: a note above the
// buttons, Open Settings → Providers as the main button, and the usual Start
// (same id, same handler) as a secondary "Start a Copilot chat anyway".
function applyNewConversationSetupState(setupRequired) {
  const note = document.getElementById('new-conversation-setup-note');
  const openSettings = document.getElementById('new-conversation-open-settings');
  const confirm = document.getElementById('new-conversation-model-confirm');
  if (note) {
    note.hidden = !setupRequired;
    note.textContent = setupRequired ? SETUP_TEXT : '';
  }
  if (openSettings) {
    openSettings.hidden = !setupRequired;
    if (openSettings.dataset.bound !== '1') {
      openSettings.dataset.bound = '1';
      openSettings.addEventListener('click', (event) => {
        event.preventDefault();
        closeNewConversationModelModal();
        openSettingsModal('providers');
      });
    }
  }
  if (confirm) confirm.textContent = setupRequired ? 'Start a Copilot chat anyway' : 'Start chat';
}

async function openNewConversationModelModal() {
  const [catalog, settings, claudeSettings, cursorSettings, grokSettings, claudeCloudSettings, deepseekSettings, claudeApiSettings] = await Promise.all([
    loadModelCatalog(),
    loadOpenAISettings(),
    loadClaudeSettings(),
    loadCursorSettings(),
    loadGrokSettings(),
    // null on a relay without Claude Cloud: the option is simply not offered.
    loadClaudeCloudSettings(),
    // The same for a relay without DeepSeek.
    loadDeepSeekSettings(),
    // And without Claude API.
    loadClaudeApiSettings(),
  ]);
  newConversationCatalogCache = catalog || null;
  newConversationOpenAISettingsCache = settings || null;
  newConversationClaudeSettingsCache = claudeSettings || null;
  newConversationCursorSettingsCache = cursorSettings || null;
  newConversationGrokSettingsCache = grokSettings || null;
  newConversationClaudeCloudSettingsCache = claudeCloudSettings || null;
  newConversationDeepSeekSettingsCache = deepseekSettings || null;
  newConversationClaudeApiSettingsCache = claudeApiSettings || null;
  // Fresh answers for the readiness question, shared with the empty screen
  // and the composer. With no provider known to be ready the modal opens in
  // its setup state: Settings is the main button, Start stays as "anyway".
  const readiness = updateProviderReadinessInputs({
    openai: settings || null,
    claude: claudeSettings || null,
    claudeCloud: claudeCloudSettings || null,
    cursor: cursorSettings || null,
    grok: grokSettings || null,
    deepseek: deepseekSettings || null,
    claudeApi: claudeApiSettings || null,
    catalog: catalog || null,
  });
  applyNewConversationSetupState(isSetupRequired(readiness));
  // Every open starts from empty cloud fields; the folder lookup refills them.
  resetNewConversationCloudState();
  clearNewConversationClaudeApiRefusal();
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
    if (claudeApiSettings?.enabled === true) {
      options.push({ value: 'claude-api', label: 'Claude API' });
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
    if (deepseekSettings?.enabled === true) {
      options.push({ value: 'deepseek', label: 'DeepSeek' });
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
        clearNewConversationClaudeApiRefusal();
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
    // Claude API refused to start (this month's cap, no key, switched off):
    // nothing was bound. The relay's words stay in the modal, with the way
    // to fix it and the same chat on the subscription.
    const claudeApiActions = !recovered && selectedProvider === 'claude-api'
      ? newChatClaudeApiRefusalActions(error?.payload?.code, {
        subscriptionOffered: newConversationProviderOffered('claude'),
      })
      : [];
    if (claudeApiActions.length) {
      showNewConversationClaudeApiRefusal(error?.message || 'Claude API could not start this chat.', claudeApiActions, selectedModel);
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

function newConversationProviderOffered(provider) {
  return Array.from(document.getElementById('new-conversation-provider-select')?.options || [])
    .some((option) => option.value === provider);
}

function clearNewConversationClaudeApiRefusal() {
  const note = document.getElementById('new-conversation-refusal');
  if (!note) return;
  note.replaceChildren();
  note.hidden = true;
}

// The same chat, started on the Claude provider: its model when the Claude
// list has it, the choices the modal holds otherwise.
async function startNewConversationOnSubscription(model) {
  const providerSelect = document.getElementById('new-conversation-provider-select');
  if (!providerSelect || newConversationInFlight) return;
  clearNewConversationClaudeApiRefusal();
  // The effort chosen for the refused chat: rebuilding the lists for Claude
  // would fall back to the stored one.
  const effort = String(document.getElementById('new-conversation-reasoning-select')?.value || '').trim().toLowerCase();
  providerSelect.value = 'claude';
  await populateNewConversationModelSelect('claude');
  const modelSelect = document.getElementById('new-conversation-model-select');
  if (modelSelect && Array.from(modelSelect.options).some((option) => option.value === model)) {
    modelSelect.value = model;
    await populateNewConversationReasoningSelect(model);
  }
  const reasoningSelect = document.getElementById('new-conversation-reasoning-select');
  if (effort && reasoningSelect && Array.from(reasoningSelect.options).some((option) => option.value === effort)) {
    reasoningSelect.value = effort;
  }
  await confirmNewConversationModel();
}

function showNewConversationClaudeApiRefusal(message, actions, model) {
  const note = document.getElementById('new-conversation-refusal');
  if (!note) {
    showTransientRelayNotice(message, 12000);
    return;
  }
  const text = document.createElement('div');
  text.className = 'new-conversation-refusal-text';
  text.textContent = message;
  const buttons = document.createElement('div');
  buttons.className = 'new-conversation-refusal-actions';
  for (const item of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'summary-btn';
    button.dataset.action = item.action;
    button.textContent = item.label;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      if (item.action === START_ON_SUBSCRIPTION_ACTION) {
        void startNewConversationOnSubscription(model);
        return;
      }
      closeNewConversationModelModal();
      runRelayErrorCta(item.action);
    });
    buttons.appendChild(button);
  }
  note.replaceChildren(text, buttons);
  note.hidden = false;
  // The modal's body scrolls: on a phone the note lands below the fold.
  note.scrollIntoView?.({ block: 'nearest' });
}

export async function confirmNewConversationModel() {
  if (newConversationInFlight) return;
  clearNewConversationClaudeApiRefusal();
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

export function setConversationListFilter(text) {
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
  conversationPayloadCache.forget(id);
  renderConvList();
  window.syncChatTitleControls?.();
  window.syncComposerButtonState?.();
  return true;
}

const ARCHIVE_CONFIRM_KIND = 'archive-confirm';

/** Resolves true when the user confirms; Cancel, Escape, the backdrop or × keep the chat. */
function askBeforeArchive(id, confirmation) {
  const title = String(conversations[id]?.title || '').trim();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openSummaryModal({
      title: 'Archive session',
      subtitle: title,
      kind: ARCHIVE_CONFIRM_KIND,
      bodyHtml: `
        <p>${escHtml(confirmation.message)}</p>
        <p>${escHtml(confirmation.detail)}</p>
        <div class="summary-modal-actions">
          <button class="chat-title-action-btn" type="button" data-archive-confirm="1">🗄 Archive</button>
          <button class="chat-title-action-btn" type="button" data-archive-cancel="1">Cancel</button>
        </div>
      `,
    });
    // Runs on every way out of the modal, another modal replacing it included.
    setSummaryModalLeaveHandler(ARCHIVE_CONFIRM_KIND, () => settle(false));
    const body = document.getElementById('summary-modal-body');
    body?.querySelector('[data-archive-confirm]')?.addEventListener('click', (event) => {
      event.preventDefault();
      settle(true);
      closeSummaryModal();
    }, { once: true });
    const cancel = body?.querySelector('[data-archive-cancel]');
    cancel?.addEventListener('click', (event) => {
      event.preventDefault();
      closeSummaryModal();
    }, { once: true });
    cancel?.focus?.();
  });
}

export async function archiveConv(e, id) {
  e?.stopPropagation?.();
  closeContextMenu();
  // A chat whose process is live (green, idle or not) asks first: archiving
  // stops that process. The relay still refuses a chat with a running turn.
  const conversation = conversations[id];
  const view = conversation ? conversationRowState(conversation) : null;
  const confirmation = archiveConfirmationFor({
    archived: conversation?.archived === true,
    visualState: view?.visualState,
    running: conversationHasActiveTurn(id) || conversation?.activeTurn === true || view?.processing === true,
  });
  if (confirmation && !(await askBeforeArchive(id, confirmation))) return;
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
  const groupId = String(conversation.groupId || '').trim();
  const groupInfo = groupId ? conversationGroups[groupId] || null : null;
  const isHead = !!groupId && groupInfo?.parentConversationId === id;
  // Group entries: a head carries the group's actions; a member can leave or
  // move, and step up or down the group's order (the keyboard's way to do
  // what a drag does); an ungrouped conversation can join or start a group.
  const memberIds = !groupId || isHead
    ? []
    : (lastConvListDragItems.find((item) => item.kind === 'head' && item.groupId === groupId)?.memberIds || []);
  const stepEntries = memberIds.includes(id)
    ? ['up', 'down'].map((direction) => {
        const step = groupMoveStep(memberIds, id, direction);
        return {
          id: `group-move-${direction}`,
          label: direction === 'up' ? 'Move up' : 'Move down',
          disabled: !step,
          onSelect: () => { if (step) void placeConversationInGroupOrder(id, groupId, step.beforeConversationId); },
        };
      })
    : [];
  const groupEntries = !groupId
    ? [{ id: 'group-add', label: 'Add to group…', onSelect: () => { openConversationGroupPicker(id); } }]
    : [
        ...(isHead ? groupMenuItems(groupId) : []),
        ...(isHead ? [MENU_SEPARATOR] : []),
        ...stepEntries,
        { id: 'group-move', label: 'Move to another group…', onSelect: () => { openConversationGroupPicker(id); } },
        { id: 'group-remove', label: 'Remove from group', onSelect: () => { void removeConversationFromGroup(id); } },
      ];
  return [
    { id: 'open', label: 'Open', onSelect: () => { void openConversation(id); } },
    { id: 'edit-title', label: 'Edit title', onSelect: () => { void openFirst(() => window.openChatTitleEditor?.()); } },
    MENU_SEPARATOR,
    { id: 'stop-turn', label: 'Stop turn', disabled: !running, onSelect: () => { void openFirst(() => openStopTurnConfirmationForConversation(id)); } },
    { id: 'kill-session', label: 'Kill session', disabled: !workerState && !sdkSessionId, onSelect: () => { void openFirst(() => window.openKillSessionConfirmation?.()); } },
    MENU_SEPARATOR,
    ...groupEntries,
    MENU_SEPARATOR,
    conversation.archived === true
      ? { id: 'unarchive', label: 'Unarchive', onSelect: () => { void unarchiveConv(null, id); } }
      : { id: 'archive', label: 'Archive', onSelect: () => { void archiveConv(null, id); } },
    { id: 'delete', label: 'Delete', danger: true, onSelect: () => { void deleteConv({ stopPropagation() {} }, id); } },
  ];
}

/** The group actions of a head row (live or synthetic): archive, stop, rename, dissolve. */
function groupMenuItems(groupId) {
  const id = String(groupId || '').trim();
  if (!id || !conversationGroups[id]) return [];
  const pendingByConversation = getPendingQuestionCountsByConversation();
  const rows = groupMemberRows(id, { inViewOnly: false });
  const liveRows = rows.filter((row) => row.archived !== true);
  // What the action stops: every turn and every stoppable background task,
  // in a member that waits on a card as much as in one that works.
  const running = liveRows.filter((row) => conversationRowState(row, pendingByConversation).live).length;
  return [
    { id: 'group-archive', label: `Archive group (${liveRows.length})`, disabled: !liveRows.length, onSelect: () => { void archiveConversationGroup(id); } },
    { id: 'group-stop', label: `Stop all running (${running})`, disabled: !running, onSelect: () => { void stopConversationGroup(id); } },
    { id: 'group-rename', label: 'Rename group', onSelect: () => { openConversationGroupRename(id); } },
    { id: 'group-dissolve', label: 'Dissolve group', onSelect: () => { void dissolveConversationGroup(id); } },
  ];
}

/** Resolves true when the user confirms; Cancel, Escape, the backdrop or × say no. */
function askConfirmation({ title, subtitle = '', message, detail = '', confirmLabel, kind }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openSummaryModal({
      title,
      subtitle,
      kind,
      bodyHtml: `
        <p>${escHtml(message)}</p>
        ${detail ? `<p>${escHtml(detail)}</p>` : ''}
        <div class="summary-modal-actions">
          <button class="chat-title-action-btn" type="button" data-confirm="1">${escHtml(confirmLabel)}</button>
          <button class="chat-title-action-btn" type="button" data-cancel="1">Cancel</button>
        </div>
      `,
    });
    setSummaryModalLeaveHandler(kind, () => settle(false));
    const body = document.getElementById('summary-modal-body');
    body?.querySelector('[data-confirm]')?.addEventListener('click', (event) => {
      event.preventDefault();
      settle(true);
      closeSummaryModal();
    }, { once: true });
    const cancel = body?.querySelector('[data-cancel]');
    cancel?.addEventListener('click', (event) => {
      event.preventDefault();
      closeSummaryModal();
    }, { once: true });
    cancel?.focus?.();
  });
}

function groupActionFailed(result, fallback) {
  showTransientRelayNotice(String(result?.error || result?.message || '').trim() || fallback, 6000);
}

/** Archive every member that can be archived now; the skipped ones are named. */
async function archiveConversationGroup(groupId) {
  closeContextMenu();
  const name = groupDisplayName(groupId);
  const liveRows = groupMemberRows(groupId, { inViewOnly: false }).filter((row) => row.archived !== true);
  const pendingByConversation = getPendingQuestionCountsByConversation();
  const busy = liveRows.filter((row) => conversationRowState(row, pendingByConversation).live).length;
  const confirmed = await askConfirmation({
    title: 'Archive group',
    subtitle: name,
    kind: 'group-archive-confirm',
    message: `Archive the ${liveRows.length} session${liveRows.length === 1 ? '' : 's'} of this group?`,
    detail: busy
      ? `${busy} of them ${busy === 1 ? 'is' : 'are'} still working and will stay; stop them first to archive everything.`
      : 'Archiving stops their idle processes. The chats stay in the Archived view.',
    confirmLabel: '🗄 Archive group',
  });
  if (!confirmed) return;
  const result = await archiveConversationGroupApi(groupId);
  if (!result) return;
  if (result.ok === false) {
    groupActionFailed(result, 'The group could not be archived.');
    return;
  }
  const skipped = Array.isArray(result.skipped) ? result.skipped : [];
  for (const id of result.archived || []) {
    if (conversations[id]) conversations[id].archived = true;
    conversationPayloadCache.forget(id);
  }
  renderConvList();
  if (skipped.length) {
    const names = skipped.map((entry) => `“${String(entry.title || entry.id).trim()}”`).join(', ');
    showTransientRelayNotice(`${result.archived?.length || 0} archived; still working and kept: ${names}.`, 8000);
  } else {
    showTransientRelayNotice(`${result.archived?.length || 0} session${result.archived?.length === 1 ? '' : 's'} archived.`, 4000);
  }
  // The relay's conversation_group_changed event applies the change in place.
}

/** A stop for every member's live turn and stoppable background task. */
async function stopConversationGroup(groupId) {
  closeContextMenu();
  const name = groupDisplayName(groupId);
  const confirmed = await askConfirmation({
    title: 'Stop all running',
    subtitle: name,
    kind: 'group-stop-confirm',
    message: 'Stop every running turn and background task in this group?',
    detail: 'Each session stops at its next safe point; the chats stay where they are.',
    confirmLabel: '⏹ Stop all',
  });
  if (!confirmed) return;
  const result = await stopConversationGroupApi(groupId);
  if (!result) return;
  if (result.ok === false) {
    groupActionFailed(result, 'The group could not be stopped.');
    return;
  }
  const turns = result.turns?.length || 0;
  const tasks = result.tasks?.length || 0;
  const unstoppable = result.unstoppable?.length || 0;
  const parts = [];
  if (turns) parts.push(`${turns} turn${turns === 1 ? '' : 's'}`);
  if (tasks) parts.push(`${tasks} background task${tasks === 1 ? '' : 's'}`);
  let text = parts.length ? `Stop requested for ${parts.join(' and ')}.` : 'Nothing was running in this group.';
  if (unstoppable) text += ` ${unstoppable} task${unstoppable === 1 ? ' has' : 's have'} no Stop button; use Kill session there.`;
  showTransientRelayNotice(text, 6000);
}

/** Members become ungrouped rows; nothing else changes. */
async function dissolveConversationGroup(groupId) {
  closeContextMenu();
  const confirmed = await askConfirmation({
    title: 'Dissolve group',
    subtitle: groupDisplayName(groupId),
    kind: 'group-dissolve-confirm',
    message: 'Dissolve this group? Its sessions stay, as single rows.',
    confirmLabel: 'Dissolve',
  });
  if (!confirmed) return;
  const result = await dissolveConversationGroupApi(groupId);
  if (!result) return;
  if (result.ok === false) {
    groupActionFailed(result, 'The group could not be dissolved.');
    return;
  }
  // The relay's conversation_group_changed event applies the change in place.
}

async function removeConversationFromGroup(conversationId) {
  closeContextMenu();
  const result = await removeConversationFromGroupApi(conversationId);
  if (!result) return;
  if (result.ok === false) {
    groupActionFailed(result, 'The conversation could not leave its group.');
    return;
  }
  // The relay's conversation_group_changed event applies the change in place.
}

const GROUP_RENAME_KIND = 'group-rename';
const GROUP_PICKER_KIND = 'group-picker';
const GROUP_NAME_MAX_LENGTH = 60;

/** A name for the group; empty returns it to the head's title. */
export function openConversationGroupRename(groupId) {
  closeContextMenu();
  const id = String(groupId || '').trim();
  const info = conversationGroups[id];
  if (!info) return;
  openSummaryModal({
    title: 'Rename group',
    subtitle: groupDisplayName(id),
    kind: GROUP_RENAME_KIND,
    bodyHtml: `
      <form id="conv-group-rename-form" class="conv-group-form">
        <input id="conv-group-rename-input" class="conv-group-input" type="text" maxlength="${GROUP_NAME_MAX_LENGTH}" value="${escHtml(info.name || '')}" placeholder="${escHtml(info.parentConversationId ? 'Leave empty to use the head session’s title' : 'Group name')}" autocomplete="off" spellcheck="false" aria-label="Group name">
        <div class="summary-modal-actions">
          <button class="chat-title-action-btn" type="submit" data-rename-save="1">Save</button>
          <button class="chat-title-action-btn" type="button" data-cancel="1">Cancel</button>
        </div>
      </form>
    `,
  });
  const body = document.getElementById('summary-modal-body');
  const form = body?.querySelector('#conv-group-rename-form');
  const input = body?.querySelector('#conv-group-rename-input');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = String(input?.value || '').trim();
    closeSummaryModal();
    const result = await renameConversationGroupApi(id, name);
    if (!result) return;
    if (result.ok === false) {
      groupActionFailed(result, 'The group could not be renamed.');
      return;
    }
    // The relay's conversation_group_changed event applies the change in place.
  });
  body?.querySelector('[data-cancel]')?.addEventListener('click', (event) => {
    event.preventDefault();
    closeSummaryModal();
  }, { once: true });
  requestAnimationFrame(() => {
    input?.focus({ preventScroll: true });
    input?.select?.();
  });
}

/**
 * The groups a conversation can join (the loaded ones, by name, with their
 * counts) and a new group with a name. Desktop and phone share it; it also
 * reaches the groups a drag cannot: on another page, or in the other view.
 */
export function openConversationGroupPicker(conversationId) {
  closeContextMenu();
  const id = String(conversationId || '').trim();
  const conversation = conversations[id];
  if (!conversation) return;
  const currentGroupId = String(conversation.groupId || '').trim();
  const choices = Object.values(conversationGroups)
    .map((info) => ({
      id: info.id,
      name: groupDisplayName(info.id),
      count: Number(info.memberCount || groupMemberRows(info.id, { inViewOnly: false }).length || 0),
      current: info.id === currentGroupId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const listHtml = choices.length
    ? choices.map((choice) => `
        <button class="conv-group-choice" type="button" data-group-choice="${escHtml(choice.id)}"${choice.current ? ' disabled aria-current="true"' : ''}>
          <span class="conv-group-choice-name">${escHtml(choice.name)}</span>
          <span class="conv-group-choice-count">${choice.count} session${choice.count === 1 ? '' : 's'}${choice.current ? ' · current' : ''}</span>
        </button>`).join('')
    : '<p class="conv-group-picker-empty">No groups yet. Make one below.</p>';
  openSummaryModal({
    title: currentGroupId ? 'Move to another group' : 'Add to group',
    subtitle: String(conversation.title || '').trim(),
    kind: GROUP_PICKER_KIND,
    bodyHtml: `
      <div id="conv-group-picker" class="conv-group-picker">
        <div class="conv-group-choices">${listHtml}</div>
        <form id="conv-group-create-form" class="conv-group-form">
          <label class="conv-group-form-label" for="conv-group-create-input">New group</label>
          <div class="conv-group-form-row">
            <input id="conv-group-create-input" class="conv-group-input" type="text" maxlength="${GROUP_NAME_MAX_LENGTH}" placeholder="Group name" autocomplete="off" spellcheck="false" aria-label="New group name">
            <button class="chat-title-action-btn" type="submit" data-group-create="1">Create</button>
          </div>
        </form>
      </div>
    `,
  });
  const body = document.getElementById('summary-modal-body');
  body?.querySelector('.conv-group-choices')?.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-group-choice]');
    if (!button || button.disabled) return;
    event.preventDefault();
    closeSummaryModal();
    const result = await moveConversationToGroupApi(id, button.dataset.groupChoice);
    if (!result) return;
    if (result.ok === false) {
      groupActionFailed(result, 'The conversation could not join that group.');
      return;
    }
    // The relay's conversation_group_changed event applies the change in place.
  });
  const form = body?.querySelector('#conv-group-create-form');
  const input = body?.querySelector('#conv-group-create-input');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = String(input?.value || '').trim();
    closeSummaryModal();
    const result = await createConversationGroupApi({ name: name || null, conversationIds: [id] });
    if (!result) return;
    if (result.ok === false) {
      groupActionFailed(result, 'The group could not be made.');
      return;
    }
    // The relay's conversation_group_changed event applies the change in place.
  });
  requestAnimationFrame(() => {
    (choices.length ? body?.querySelector('[data-group-choice]:not([disabled])') : input)?.focus?.({ preventScroll: true });
  });
}

/** A move inside a group's order from the row menu (Move up / Move down). */
async function placeConversationInGroupOrder(conversationId, groupId, beforeConversationId) {
  closeContextMenu();
  await applyConversationListDrop({ action: 'reorder', groupId, beforeConversationId }, conversationId);
}

/** Says what a drop did, for a screen reader. */
function announceConversationList(text) {
  const region = document.getElementById('conv-list-announce');
  if (!region || !text) return;
  // Emptied first so the same sentence twice is announced twice.
  region.textContent = '';
  requestAnimationFrame(() => { region.textContent = text; });
}

const CONV_ROW_FLASH_MS = 1200;
// The relay's event moves the row; it may arrive after the call's answer, so
// the row flashes again where the event puts it, for a moment after a drop.
const CONV_ROW_FLASH_PENDING_MS = 3000;
let pendingConvRowFlash = null;

/** The moved row, briefly highlighted and brought into view. */
function flashConversationRow(conversationId) {
  const row = document.querySelector(`#conv-list .conv-item[data-conversation-id="${CSS.escape(String(conversationId))}"]`);
  if (!row) return;
  row.classList.remove('conv-drop-flash');
  // Restarts the animation on a row that is still flashing.
  void row.offsetWidth;
  row.classList.add('conv-drop-flash');
  setTimeout(() => row.classList.remove('conv-drop-flash'), CONV_ROW_FLASH_MS);
  row.scrollIntoView?.({ block: 'nearest' });
}

/**
 * A drop from the sidebar (conversation-group-drag.mjs), or a step from the
 * row menu: the relay call, then the row flashed and the move announced. The
 * records change only by the relay's `conversation_group_changed` event, as
 * for every group action: an answer that arrives after a newer event must
 * not undo it. A refusal says why and reloads the list.
 */
async function applyConversationListDrop(result, conversationId) {
  const id = String(conversationId || '').trim();
  const title = String(conversations[id]?.title || '').trim();
  const groupName = result.groupId ? groupDisplayName(result.groupId) : '';
  let response = null;
  let fallback = '';
  let announcement = dropAnnouncement(result.action, { title, groupName });
  if (result.action === 'new-group') {
    const otherId = String(result.targetConversationId || '').trim();
    response = await createConversationGroupApi({ name: null, conversationIds: [otherId, id] });
    fallback = 'The group could not be made.';
    // Shown open, though nothing in it runs (which would fold it).
    if (response && response.ok !== false && response.group?.id) convListTransientOpenGroups.add(String(response.group.id));
    announcement = dropAnnouncement('new-group', { title, otherTitle: conversations[otherId]?.title });
  } else if (result.action === 'leave') {
    response = await removeConversationFromGroupApi(id);
    fallback = 'The conversation could not leave its group.';
  } else if (result.action === 'reorder' || result.action === 'join') {
    response = await placeConversationInGroupApi(id, { groupId: result.groupId, beforeConversationId: result.beforeConversationId ?? null });
    fallback = result.action === 'join' ? 'The conversation could not join that group.' : 'The conversation could not be moved.';
    if (response && response.ok !== false) convListTransientOpenGroups.add(result.groupId);
  } else {
    return;
  }
  if (!response || response.ok === false) {
    if (response) groupActionFailed(response, fallback);
    scheduleLoadedConversationsRefresh();
    return;
  }
  renderConvList();
  flashConversationRow(id);
  pendingConvRowFlash = { id, until: Date.now() + CONV_ROW_FLASH_PENDING_MS };
  announceConversationList(announcement);
}

/**
 * Right-click (and long press on touch) on a row opens its menu; a mouse
 * drag, or a long press that moves, drags it. Bound once; the list's rows
 * are re-rendered freely.
 */
function bindConversationContextMenu(list) {
  if (!list || list.dataset.contextMenuBound === '1') return;
  list.dataset.contextMenuBound = '1';
  // Rows move only where their place means something: not in the Archived
  // view and not under a title filter (the menu entries still work there).
  const drag = bindConversationListDrag(list, {
    isEnabled: () => !IS_SHARED_VIEW && !conversationListArchivedView && !normalizeConversationFilter(conversationListFilterText),
    describeItems: () => lastConvListDragItems,
    onHold: (held) => holdConvListRender(held),
    rerender: () => paintConvList(),
    setDragOpen: (groupId, open) => {
      if (open) convListTransientOpenGroups.add(groupId);
      else convListTransientOpenGroups.delete(groupId);
    },
    onDrop: (result, conversationId) => { void applyConversationListDrop(result, conversationId); },
  });
  const openFor = (row, x, y) => {
    const id = String(row?.dataset?.conversationId || '').trim();
    // A synthetic head row stands for its group: the group's actions only.
    const items = id
      ? conversationMenuItems(id)
      : (row?.classList?.contains('conv-group-synthetic') ? groupMenuItems(row.dataset.groupId) : []);
    if (items.length) openContextMenu(x, y, items);
  };
  list.addEventListener('contextmenu', (event) => {
    const row = event.target?.closest?.('.conv-item');
    if (!row || !list.contains(row)) return;
    event.preventDefault();
    openFor(row, event.clientX, event.clientY);
  });
  // A long press lifts the row: released in place it opens the menu, moved
  // it becomes a drag. Where rows cannot move (a synthetic head, the
  // Archived view, a filter) it opens the menu at the delay, as it always did.
  bindLongPress(list, '.conv-item', (row, x, y) => openFor(row, x, y), {
    lift: {
      canLift: (row) => drag.canLift(row),
      onLift: (row) => drag.lift(row),
      onMove: (row, x, y, event) => drag.beginTouchDrag(row, x, y, event),
      onEnd: () => drag.unlift(),
    },
  });
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
  conversationPayloadCache.forget(id);
  renderConvList();
  if (currentConvId === id) clearOpenConversation();
}

/**
 * The conversation on screen is gone (deleted here or from another device):
 * nothing is open, the header says so, the transcript shows the empty state
 * and the ⋯ menu keeps its relay-wide entries. One place for both callers.
 */
export function clearOpenConversation() {
  setCurrentConv(null);
  clearAttachments();
  setRepoBrowserSessionInfo('', '');
  restoreInFlightThinking(null);
  renderMessages([]);
  const title = document.getElementById('chat-title');
  if (title) title.textContent = 'Select or start a conversation';
  window.syncChatTitleControls?.();
  updateSessionPill(null, null);
  updateCompactButton();
  scheduleContextUsageRefresh(null);
}
