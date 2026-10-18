import {
  cliOnline,
  compactInFlight,
  conversations,
  CLIENT_ID,
  currentConvId,
  escHtml,
  fmtDate,
  generateId,
  hasPendingUserMessageDuplicate,
  clearPendingUserMessage,
  pendingUserMessageIds,
  pendingUserMessageEntries,
  trackPendingUserMessage,
  seenMessageIds,
  relayActivities,
  relayThoughts,
  selectedAttachments,
  setCompactInFlight,
  setCurrentConv,
  updateCompactButton,
  updateSessionPill,
  updateWorkspaceRootHints,
  applyContextUsageBar,
  scrollBottom,
  isMobileComposerViewport,
  releaseComposerFocusAfterSend,
  autoResize,
  setModelBanner,
  showTransientRelayNotice,
  repoBrowserState,
  saveConversationLoadedMessageCount,
  getSubagentRun,
  upsertSubagentRun,
  setSubagentStreamText,
  clearSubagentRunsForMessage,
  getRootSubagentRunsByMessage,
  getChildSubagentRuns,
  markSubagentCancelInFlight,
  clearSubagentCancelInFlight,
  isSubagentCancelInFlight,
  IS_SHARED_VIEW,
  SHARED_CONVERSATION_TOKEN,
  imageEditTarget,
  setImageEditTarget as setStoredImageEditTarget,
  getSessionWorkerState,
  openSummaryModal,
  closeSummaryModal,
  toggleSidebar,
  hasPendingUserMessageForConversation,
  isMessagesNearBottom,
} from './store.js';
import { getPendingQuestionCountsByConversation } from './ask-user-view.js';
import { sendMessage as sendMessageApi, cancelConversationTurn, cancelQueuedConversationTurn, cancelSubagentRun, compactConversation as compactConversationApi, scheduleContextUsageRefresh, loadConversation as loadConversationApi, loadSharedConversation, updateConversationDraft as updateConversationDraftApi, updateMessageShareVisibility, launchSessionWorker } from './api-client.js';
import { enqueueOutboxRequest, registerOutboxSync } from './sync-outbox.mjs';
import { linkifyWorkspaceMentionsInNode, parseAppFileHref, renderMarkdownPreview, rewriteLocalAssetUrlsInNode } from './router.js';
import { renderAttachmentMarkup, removeComposerAttachments, uploadAttachments, setComposerAttachments, setRepoBrowserSessionInfo, openGalleryItem } from './attachments-view.js';
import { chatMediaGallery, chatMediaItemFromNode } from './viewer-chat-gallery.mjs';
import { buildWorkflowRunCard } from './background-tasks-view.mjs';
import { mergeLiveSubagentRun, subagentRowsMarkup } from './subagent-row.mjs';
import { rememberSubagentRuns, syncSubagentRowClock } from './subagent-viewer.mjs';
import { isMessagePinned, toggleMessagePin } from './pinned-messages-view.mjs';
import { isMessageHiddenFromShares, setConversationHiddenMessages } from './hidden-messages-view.mjs';
import { parsePreviewCommand, runPreviewCommand } from './preview-command.mjs';
import { buildTranscriptPreviewCard } from './preview-cards.mjs';
import { closeSlashAutocomplete, handleSlashAutocompleteKey, updateSlashAutocomplete } from './slash-autocomplete.mjs';
import { closeMentionAutocomplete, handleMentionAutocompleteKey, updateMentionAutocomplete } from './mention-autocomplete.mjs';
import { renderRemoteOriginBadgeHtml } from './remote-relay-origin-view.mjs';
import { isRelayEventMessage, renderRelayEventRowHtml } from './relay-event-view.mjs';
import {
  AGENT_EXCHANGE_CLOSED_CLASS,
  AGENT_EXCHANGE_HEAD_CLASS,
  agentExchangeFoldOpen,
  agentExchangeRowOf,
  agentExchangeSummary,
  planAgentExchangeFolds,
  renderAgentExchangeRowHtml,
} from './agent-exchange-fold-view.mjs';
import { stripRemoteRelayDisplayArtifacts } from './relay-prompt-sanitizer.mjs';
import { evaluateUnknownCommandGuard } from './slash-commands.mjs';
import { attachCodeCopyButtons } from './code-copy.mjs';
import { relayErrorCtaActions } from './relay-error-ctas.mjs';
import { confirmCliInstall } from './cli-install-ui.js';
import { startGrokSignIn } from './grok-auth-ui.js';
import { openSettingsModal } from './settings-modal.js';
import {
  serializeDraftAttachments,
  hydrateDraftAttachments,
  draftAttachmentsEqual,
} from './composer-attachment-cache.mjs';
import { renderRelayQuestions } from './ask-user-view.js';
import { renderRelayBoards } from './relay-board-view.js';
import { getMessageThreadAnchor, sortConversationMessages } from './thread-order.mjs';
import {
  normalizeStreamSeq,
  deriveLatestInFlightStreamEvent,
  deriveInFlightStreamTextByThread,
  computeNextRelayStreamState,
} from './stream-state.mjs';
import {
  capRelayActivityEntries,
  compactBoundaryFromActivities,
  isCompactBoundaryActivityEntry,
  mergeRelayActivityTexts,
  normalizeRelayActivityEntry,
  promotedCompactBoundaryEntry,
  relayActivityEntryText,
  visibleActivityEntries,
} from './activity-replay-state.mjs';
import {
  COMPACT_PENDING_STAMP,
  SEPARATOR_CLASS,
  syncSeparatorRail,
  syncTranscriptSeparators,
} from './transcript-separators.mjs';
import { ABSORBED_MSG_CLASS, STEERED_MSG_CLASS, STEER_MARKER_CLASS_BY_KIND, syncSteeredTurnMerge } from './steered-turn-merge.mjs';
import { resolveSubagentFold, subagentFoldSummary, toggledSubagentFoldChoice } from './subagent-fold.mjs';
import { deriveComposerControlState, hasComposerDraft, hasUploadingAttachments } from './composer-control-state.mjs';
import { resolveNoConversationState } from './no-conversation-state.mjs';
import { getProviderReadiness, isProviderSetupRequired } from './provider-readiness.mjs';
import { buildLiveMessageFingerprint } from './live-message-dedupe.mjs';
import { createInfiniteLoader } from './infinite-loader.js';
import { normalizeDraftTimestampMs, isIncomingDraftTimestampStale } from './conversation-draft-timestamp-utils.mjs';
import {
  DRAFT_SYNC_PROTOCOL_VERSION,
  MAX_DRAFT_TEXT_LENGTH,
  draftTextForSync,
  draftAttachmentsKey,
  getSyncedDraft,
  isDraftSaveNoop,
  recordSyncedDraft,
  resolveDraftConflict,
  shouldApplyIncomingDraftToComposer,
} from './conversation-draft-sync.mjs';
import { isChatInteractionHeld, selectionIntersectsNode } from './selection-guard.mjs';
import { captureReadingAnchor, readingAnchorContentTop, readingAnchorHoldStep, readingAnchorScrollDelta } from './transcript-reading-anchor.mjs';
import { captureReadingBlock, restoreReadingBlock } from './transcript-viewport-anchor.mjs';
import {
  applyThinkingFollow,
  getThinkingFollowMode,
  initThinkingFollow,
  observeThinkingBubble,
  renderThinkingFollowButtonsHtml,
  syncThinkingFollowButtons,
  toggleThinkingFollowMode,
  unobserveThinkingBubble,
} from './thinking-follow.js';
import { beginOwnSend, followsTranscriptEnd, jumpTranscriptToBottom, nameOwnSendConversation, ownSendFollows, refreshJumpButton, scrollAfterOwnSend } from './transcript-jump-bottom-view.mjs';
import { createHeldBackLiveRows, newerPageReachesEnd } from './transcript-island.mjs';
import { buildInFlightSnapshotKey } from './in-flight-snapshot.mjs';
import { computeStablePrefixLength, planListPatch } from './streaming-dom-patch.mjs';
import { prefixToolActivityEmoji } from './tool-activity-emoji.mjs';
import { conversationPayloadCache } from './conversation-payload-cache.mjs';

const CONVERSATION_HISTORY_PAGE_SIZE = 20;
const HISTORY_LOAD_MORE_ID = 'history-load-more';
// The topmost transcript row, whichever kind it is: a day/compaction separator
// can sit above the first `.msg`, and anything that inserts "above the
// transcript" (the load-older control, a prepended history page) must land
// above that separator, not between it and its message.
const FIRST_TRANSCRIPT_ROW_SELECTOR = `.msg, .${SEPARATOR_CLASS}`;

// Batch guard: appendMessage syncs separators per insertion, which is right
// for a single live message but quadratic when a whole page is appended in a
// loop. Bulk paths suspend it and run one pass at the end.
let separatorSyncSuspended = 0;
let transcriptResizeObserved = null;

function syncSeparatorsNow() {
  if (separatorSyncSuspended > 0) return;
  const el = getMessagesElement();
  if (!el) return;
  syncTranscriptSeparators(el);
  syncSteeredTurnMerge(el);
  // After the merge pass: a steered row's class is one of its inputs.
  syncAgentExchangeFolds(el);
  observeTranscriptResize(el);
}

// Render-time offsets go stale whenever the transcript changes height without
// a message being added — an image finishing, a <details> opening, a font-size
// change — which would leave the rail's dots pointing at the wrong rows.
// Re-laying out the dots is cheap and touches no message nodes.
function observeTranscriptResize(el) {
  if (transcriptResizeObserved === el || typeof ResizeObserver !== 'function') return;
  transcriptResizeObserved = el;
  const observer = new ResizeObserver(() => syncSeparatorRail(el));
  observer.observe(el);
}

function withSuspendedSeparatorSync(fn) {
  separatorSyncSuspended += 1;
  try {
    return fn();
  } finally {
    separatorSyncSuspended -= 1;
  }
}
const OPAQUE_RELAY_TEXT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let thinkingMessageId = null;
let lastInFlightSnapshotKey = '';
let deferredMessageRender = null;
const relayStreamStateByMessageId = new Map();
// Cumulative main-thread stream text per message. The seq/done state above is
// shared across threads (the server numbers stream rows per queue message, not
// per thread), so the text has to be tracked separately or a subagent frame
// would clobber the reply preview.
const relayStreamTextByMessageId = new Map();
const completedMessageIds = new Set();
const bubbleCancelInFlight = new Set();
// Un-steer requests the relay acknowledged with 'cancel-requested': the worker
// answers asynchronously (message_status 'cancelled', or the row is answered
// after all). Until then the bubble reads "Cancelling…"; the timer restores
// the control if neither arrives.
const UNSTEER_ACK_FALLBACK_MS = 20_000;
const unsteerFallbackTimers = new Map();
const shareVisibilityInFlight = new Set();
const SUBAGENT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'dropped', 'done']);
let lastRenderedMessageSnapshotKey = '';
let sendInFlight = false;
const COMPOSER_DRAFT_DEBOUNCE_MS = 500;
const draftSaveTimerByConversation = new Map();
const draftSavePromiseByConversation = new Map();
// Conversations whose draft an in-flight send owns. POST /api/message clears
// draft_text in the same transaction that stores the message, so until that
// commit the server still serves the text the composer was just emptied of.
// Every refresh issued inside that window carries it — the 900ms live poll
// stays armed for the whole queue wait, and other clients can broadcast their
// own late save of it — and applying one re-types the queued message into the
// composer while its bubble sits in the transcript. Nothing but the send may
// speak for this conversation's draft until the send has cleared it.
const sendOwnedDraftConversations = new Set();
const activeTurnsByConversation = new Map();
let conversationHistoryState = {
  conversationId: '',
  hasMoreOlder: false,
  hasMoreNewer: false,
  oldestMessageId: '',
  oldestMessageTimestamp: '',
  newestMessageId: '',
  newestMessageTimestamp: '',
  loadedMessageCount: 0,
  loadingOlder: false,
  loadingNewer: false,
};
// Live rows for a window that ends above the conversation's end: held back
// until the newer pages bring them (transcript-island.mjs).
const heldBackLiveRows = createHeldBackLiveRows();

// After every change of conversationHistoryState: a window that meets the
// end, or another conversation's, holds no rows back. The button's count
// changes without the page changing, so it is told.
function syncHeldBackLiveRows() {
  const released = heldBackLiveRows.follow({
    conversationId: conversationHistoryState.conversationId,
    atTail: !conversationHistoryState.hasMoreNewer,
  });
  if (released) refreshJumpButton();
}

function renderImageEditTarget() {
  const chip = document.getElementById('image-edit-target');
  if (!chip) return;
  if (!imageEditTarget) {
    chip.classList.remove('visible');
    chip.innerHTML = '';
    return;
  }
  chip.innerHTML = `<span>Editing <strong>${escHtml(imageEditTarget.name)}</strong></span><button type="button" onclick="clearImageEditTarget()" aria-label="Cancel image edit target">✕</button>`;
  chip.classList.add('visible');
}

export function setImageEditTarget(target) {
  if (IS_SHARED_VIEW) return;
  setStoredImageEditTarget(target);
  renderImageEditTarget();
  const input = document.getElementById('msg-input');
  if (input) {
    input.placeholder = 'Describe how to edit this image…';
    input.focus();
  }
}

export function clearImageEditTarget() {
  setStoredImageEditTarget(null);
  renderImageEditTarget();
  // The placeholder is provider/model-aware; bootstrap owns the sync (window
  // global to avoid a circular import) with the static text as fallback.
  if (typeof window.syncComposerPlaceholder === 'function') {
    window.syncComposerPlaceholder();
  } else {
    const input = document.getElementById('msg-input');
    if (input) input.placeholder = 'Message Copilot…';
  }
}

export function jumpToImageParent(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  const node = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!node) {
    showTransientRelayNotice('Load earlier messages to view the source image.');
    return;
  }
  revealAgentExchangeMessage(id);
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.add('message-highlight');
  window.setTimeout(() => node.classList.remove('message-highlight'), 1400);
}

async function loadConversationHistoryPage(conversationId, options = {}) {
  if (!IS_SHARED_VIEW) {
    return loadConversationApi(conversationId, options);
  }
  // Shared mode must paginate through the token endpoint so hidden-from-share
  // messages stay filtered even when an owner auth cookie is present.
  const response = await loadSharedConversation(SHARED_CONVERSATION_TOKEN, options);
  if (!response || response.ok === false) return null;
  const { ok, status, error, shared, ...payload } = response;
  return payload;
}

// The loaders' cursors belong to the conversation recorded in
// conversationHistoryState. Between a conversation switch and the new
// conversation's first render they still hold the previous conversation's
// cursors; the switch entry point lives outside this module, so staleness is
// detected here and the loaders are reset before any fetch can spend an old
// cursor against the new conversation. Returns true when a reset happened.
function resetConversationPaginationIfStale() {
  const conversationId = String(currentConvId || '').trim();
  if (String(conversationHistoryState.conversationId || '').trim() === conversationId) return false;
  conversationHistoryLoader.reset({ hasMore: false, nextCursor: null });
  conversationFutureLoader.reset({ hasMore: false, nextCursor: null });
  return true;
}

function conversationPaginationCursorIsStale(conversationId) {
  return String(conversationHistoryState.conversationId || '').trim() !== String(conversationId || '').trim();
}

const conversationHistoryLoader = createInfiniteLoader({
  fetchPage: async (cursor) => {
    const conversationId = String(currentConvId || '').trim();
    if (!conversationId) {
      return {
        items: [],
        hasMore: false,
        nextCursor: null,
      };
    }
    if (conversationPaginationCursorIsStale(conversationId)) return null;
    const response = await loadConversationHistoryPage(conversationId, {
      limit: CONVERSATION_HISTORY_PAGE_SIZE,
      beforeMessageId: String(cursor?.beforeMessageId || '').trim(),
      beforeTimestamp: String(cursor?.beforeTimestamp || '').trim(),
    });
    if (String(currentConvId || '').trim() !== conversationId) return null;
    if (!response) throw new Error('Could not load older messages. Please try again.');
    return {
      items: response.messages || [],
      hasMore: !!response.pageInfo?.hasMore,
      nextCursor: response.pageInfo?.nextCursor || null,
    };
  },
  applyPage: async (page) => {
    const currentId = String(currentConvId || '').trim();
    const el = getMessagesElement();
    if (!currentId || !el) return;
    // Covers the prefetch buffer: a page fetched before a conversation switch
    // must not be applied to the newly opened conversation.
    if (conversationPaginationCursorIsStale(currentId)) return;
    const previousScrollTop = el.scrollTop;
    const previousScrollHeight = el.scrollHeight;
    const inserted = prependMessageNodes(page.items || []);
    // The kept window grows with the page: a switch back shows these rows too.
    if (!IS_SHARED_VIEW) conversationPayloadCache.addOlder(currentId, page.items || [], { hasMoreOlder: page.hasMore });
    setConversationHistoryState({
      conversationId: currentId,
      hasMoreOlder: page.hasMore,
      hasMoreNewer: conversationHistoryState.hasMoreNewer,
      oldestMessageId: String(page.nextCursor?.beforeMessageId || conversationHistoryState.oldestMessageId || '').trim(),
      oldestMessageTimestamp: String(page.nextCursor?.beforeTimestamp || conversationHistoryState.oldestMessageTimestamp || '').trim(),
      newestMessageId: String(conversationHistoryState.newestMessageId || '').trim(),
      newestMessageTimestamp: String(conversationHistoryState.newestMessageTimestamp || '').trim(),
      loadedMessageCount: getConversationLoadedMessageCount() + inserted.inserted,
      loadingOlder: false,
      loadingNewer: conversationHistoryState.loadingNewer,
    });
    renderRelayQuestions();
    renderRelayBoards();
    // Before the scroll restore below: the prepended page can add (or retire)
    // separator rows, and the height delta the restore measures has to include
    // them or the viewport jumps.
    syncTranscriptSeparators(el);
    // A steering pair split across the page boundary heals here (the absorbed
    // reply just arrived above its already-rendered steered user row).
    syncSteeredTurnMerge(el);
    // The page's agent exchanges fold before the height delta is measured.
    syncAgentExchangeFolds(el);
    requestAnimationFrame(() => {
      if (!el || String(currentConvId || '').trim() !== currentId) return;
      const nextScrollHeight = el.scrollHeight;
      el.scrollTop = previousScrollTop + (nextScrollHeight - previousScrollHeight);
      // The page's images have no height yet: the place read is held while
      // they come in, as after a restore.
      const place = captureConversationReadingAnchor();
      if (place?.conversationId === currentId) holdReadingAnchorWhileMediaLoads(el, place.anchor);
      void conversationHistoryLoader.handleBoundaryDistance(el.scrollTop);
    });
  },
  onError: (error, { mode }) => {
    if (mode === 'load') {
      showTransientRelayNotice(error?.message || 'Could not load older messages. Please try again.');
    }
  },
  onStateChange: (state) => {
    conversationHistoryState = {
      ...conversationHistoryState,
      hasMoreOlder: state.hasMore,
      loadingOlder: state.isLoading,
    };
    syncHistoryLoadMoreControl();
  },
});

const conversationFutureLoader = createInfiniteLoader({
  fetchPage: async (cursor) => {
    const conversationId = String(currentConvId || '').trim();
    if (!conversationId) {
      return {
        items: [],
        hasMore: false,
        nextCursor: null,
      };
    }
    if (conversationPaginationCursorIsStale(conversationId)) return null;
    const response = await loadConversationHistoryPage(conversationId, {
      limit: CONVERSATION_HISTORY_PAGE_SIZE,
      afterMessageId: String(cursor?.afterMessageId || '').trim(),
      afterTimestamp: String(cursor?.afterTimestamp || '').trim(),
    });
    if (String(currentConvId || '').trim() !== conversationId) return null;
    if (!response) throw new Error('Could not load newer messages. Please try again.');
    return {
      items: response.messages || [],
      hasMore: !!response.pageInfo?.hasMoreNewer,
      nextCursor: response.pageInfo?.newerCursor || null,
    };
  },
  applyPage: async (page) => {
    const currentId = String(currentConvId || '').trim();
    if (!currentId || conversationPaginationCursorIsStale(currentId)) return;
    const ordered = sortConversationMessages(page.items || []);
    // The last page may predate a row held back meanwhile: one more is asked
    // for, from this page's newest row. The loader reads hasMore and the
    // cursor off this page once it is applied.
    const heldBackIds = heldBackLiveRows.ids(currentId);
    if (!page.hasMore && heldBackIds.length && !newerPageReachesEnd({
      pageHasMore: page.hasMore,
      pageMessageIds: ordered.map((m) => m?.id),
      heldBackIds,
      renderedIds: renderedMessageIds(),
    })) {
      const newest = ordered[ordered.length - 1];
      page.hasMore = true;
      page.nextCursor = {
        afterMessageId: String(newest?.id || '').trim() || null,
        afterTimestamp: String(newest?.timestamp || '').trim() || null,
      };
    }
    if (!IS_SHARED_VIEW) conversationPayloadCache.addNewer(currentId, ordered, { hasMoreNewer: page.hasMore });
    let inserted = 0;
    withSuspendedSeparatorSync(() => {
      for (const m of ordered) {
        const msgId = String(m?.id || '').trim() || null;
        const node = appendMessage(m, false, msgId, true, null, false);
        if (node) inserted += 1;
      }
    });
    syncSeparatorsNow();
    setConversationHistoryState({
      conversationId: currentId,
      hasMoreOlder: conversationHistoryState.hasMoreOlder,
      hasMoreNewer: page.hasMore,
      oldestMessageId: String(conversationHistoryState.oldestMessageId || '').trim(),
      oldestMessageTimestamp: String(conversationHistoryState.oldestMessageTimestamp || '').trim(),
      newestMessageId: String(page.nextCursor?.afterMessageId || conversationHistoryState.newestMessageId || '').trim(),
      newestMessageTimestamp: String(page.nextCursor?.afterTimestamp || conversationHistoryState.newestMessageTimestamp || '').trim(),
      loadedMessageCount: getConversationLoadedMessageCount() + inserted,
      loadingOlder: conversationHistoryState.loadingOlder,
      loadingNewer: false,
    });
    // The window meets the end: a turn still running gets its live bubble,
    // which was not drawn under the window while it ended above.
    if (!page.hasMore) showLiveBubbleOfRunningTurn();
  },
  onError: (error, { mode }) => {
    if (mode === 'load') {
      showTransientRelayNotice(error?.message || 'Could not load newer messages. Please try again.');
    }
  },
  onStateChange: (state) => {
    conversationHistoryState = {
      ...conversationHistoryState,
      hasMoreNewer: state.hasMore,
      loadingNewer: state.isLoading,
    };
    syncHeldBackLiveRows();
  },
});

function isOpaqueRelayText(value) {
  const text = String(value || '').trim();
  return !!text && OPAQUE_RELAY_TEXT_PATTERN.test(text);
}

function setSendInFlight(value) {
  sendInFlight = !!value;
  syncSendButtonState();
}

function getActiveTurnForConversation(conversationId) {
  const conversationKey = String(conversationId || '').trim();
  if (!conversationKey) return null;
  return activeTurnsByConversation.get(conversationKey) || null;
}

// The session worker id a conversation is bound to. Same hydration shapes
// validateSelectedConversationBeforeSend handles: camelCase, snake_case, or
// only the runtime session binding.
function sdkSessionIdForConversation(conversationId) {
  const conversation = conversations[String(conversationId || '').trim()] || null;
  return String(
    conversation?.sdkSessionId
    || conversation?.sdk_session_id
    || conversation?.runtimeSession?.sdkSessionId
    || conversation?.runtimeSession?.sdk_session_id
    || '',
  ).trim();
}

// The worker-reported steering snapshot for a conversation's session worker
// (rides the status payload from the worker's heartbeat), or null.
function workerSteeringForConversation(conversationId) {
  const sdkSessionId = sdkSessionIdForConversation(conversationId);
  return sdkSessionId ? (getSessionWorkerState(sdkSessionId)?.steering || null) : null;
}

// Which conversations deliver a message typed mid-turn INTO the running turn
// (steering) rather than queueing it behind: exactly those whose session
// worker advertises it on its heartbeat steering snapshot (`supported` — the
// Claude and Copilot SDK workers both do). One rule for every provider; the
// provider name is not consulted (the name-based Claude rule was retired
// 2026-09-26 once every live Claude worker advertised the flag). Workers that
// do not advertise (the extension path, Cursor, Grok) stay strictly serial,
// so their composer keeps saying "Queue".
function conversationSupportsSteering(conversationId) {
  const conversationKey = String(conversationId || '').trim();
  if (!conversationKey) return false;
  return workerSteeringForConversation(conversationKey)?.supported === true;
}

// Pushed rows the conversation's worker reports it can still pull back out of
// its runtime (Copilot's queued lane): their bubbles keep Cancel.
function cancellableSteerIdsForConversation(conversationId) {
  const ids = workerSteeringForConversation(conversationId)?.cancellableIds;
  return new Set(Array.isArray(ids) ? ids : []);
}

// Whether steering into this conversation's live turn is momentarily held,
// and why. Two sources, freshest first: the client's own knowledge of an open
// question card (instant — the worker's heartbeat snapshot lags up to ~10s),
// then the worker-reported steering snapshot for the slower holds only it can
// see (compaction, post-compaction adoption, a running tool call).
function steeringHoldForConversation(conversationId) {
  const conversationKey = String(conversationId || '').trim();
  if (!conversationKey || !conversationSupportsSteering(conversationKey)) {
    return { held: false, reason: null };
  }
  try {
    const pendingQuestions = Number(getPendingQuestionCountsByConversation()?.[conversationKey] || 0);
    if (pendingQuestions > 0) return { held: true, reason: 'question' };
  } catch {}
  const steering = workerSteeringForConversation(conversationKey);
  if (steering && steering.turnActive && !steering.canSteer) {
    // The client's own question knowledge is authoritative both ways: it saw
    // the card answered instantly, while the worker snapshot lags ~10s.
    if (steering.holdReason === 'question') return { held: false, reason: null };
    // The 'delivery' hold covers the seconds while a turn-opening delivery is
    // still in flight — but a heartbeat-captured copy outlives that window by
    // up to a poll cycle and names the SAME turn, so the client cannot tell
    // stale from live. Ignore it: a steer sent into that window just queues
    // and rides in moments later, which was always safe.
    if (steering.holdReason === 'delivery') return { held: false, reason: null };
    // A snapshot naming a different turn than the one the client is watching
    // is a leftover from the previous turn — ignore it.
    const clientTurnMessageId = String(getActiveTurnForConversation(conversationKey)?.messageId || '').trim();
    if (steering.messageId && clientTurnMessageId && steering.messageId !== clientTurnMessageId) {
      return { held: false, reason: null };
    }
    return { held: true, reason: steering.holdReason || null };
  }
  return { held: false, reason: null };
}

function syncSendButtonState() {
  const btn = document.getElementById('send-btn');
  if (!btn) return;
  const currentTurn = getActiveTurnForConversation(currentConvId);
  const steeringHold = currentTurn
    ? steeringHoldForConversation(currentConvId)
    : { held: false, reason: null };
  const state = deriveComposerControlState({
    hasActiveTurn: !!currentTurn,
    hasDraft: hasComposerDraft({
      text: document.getElementById('msg-input')?.value || '',
      attachmentCount: selectedAttachments.length,
    }),
    sendInFlight,
    modelMetadataBlocked: window.isModelMetadataBlocked?.() === true,
    attachmentsUploading: hasUploadingAttachments(selectedAttachments),
    steeringSupported: conversationSupportsSteering(currentConvId),
    steeringHeld: steeringHold.held,
    steeringHoldReason: steeringHold.reason,
    archived: conversations[String(currentConvId || '').trim()]?.archived === true,
    setupRequired: !String(currentConvId || '').trim() && isProviderSetupRequired(),
  });
  btn.disabled = state.disabled;
  btn.dataset.action = state.action;
  btn.textContent = state.label;
  btn.title = state.title;
  // The textarea follows: locked with the setup placeholder while no provider
  // is ready, given back the moment readiness flips or a chat opens. The
  // shared view owns its own read-only field and is left alone.
  const input = document.getElementById('msg-input');
  if (input && !IS_SHARED_VIEW) {
    const lock = state.composerDisabled === true;
    if (lock) {
      input.disabled = true;
      input.placeholder = state.placeholder;
      input.dataset.setupLocked = '1';
    } else if (input.dataset.setupLocked === '1') {
      delete input.dataset.setupLocked;
      input.disabled = false;
      window.syncComposerPlaceholder?.();
    }
  }
}

// Button-only refresh for status, poll and question paths. It must never save
// the draft: an idle client that saves on every poll tick writes its stale
// composer text over another device's draft.
export function syncComposerButtonState() {
  syncSendButtonState();
}

// The composer's input handler: the user edited the text, so the draft is
// saved (debounced) as well as the button refreshed. While a send owns the
// draft nothing is saved — the send transaction clears the draft
// unconditionally after any such save — but the text is still cached, and
// the send saves it when it settles, wherever the user is by then.
export function syncComposerAfterUserEdit() {
  syncSendButtonState();
  const text = document.getElementById('msg-input')?.value || '';
  warnOnceIfDraftTooLong(text);
  if (isDraftOwnedByPendingSend(currentConvId)) {
    upsertConversationDraftState(currentConvId, { draftText: draftTextForSync(text) });
    return;
  }
  void scheduleConversationDraftSave({ conversationId: currentConvId, draftText: text });
}

/** Whether a send in flight holds this conversation's draft saves back. */
export function isConversationDraftHeldBySend(conversationId) {
  return isDraftOwnedByPendingSend(conversationId);
}

let draftLengthWarningShown = false;

function warnOnceIfDraftTooLong(text) {
  const tooLong = String(text || '').length > MAX_DRAFT_TEXT_LENGTH;
  if (tooLong && !draftLengthWarningShown) {
    showTransientRelayNotice(
      `Drafts are saved up to ${MAX_DRAFT_TEXT_LENGTH.toLocaleString('en-US')} characters; the rest stays only in this tab until you send.`,
      7000,
    );
  }
  draftLengthWarningShown = tooLong;
}

export function isSendInFlight() {
  return sendInFlight;
}

function clearDraftTimerForConversation(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  const timer = draftSaveTimerByConversation.get(id);
  if (!timer) return;
  clearTimeout(timer);
  draftSaveTimerByConversation.delete(id);
}

function isDraftOwnedByPendingSend(conversationId) {
  return sendOwnedDraftConversations.has(String(conversationId || '').trim());
}

function isDraftSavePending(conversationId) {
  const id = String(conversationId || '').trim();
  return draftSaveTimerByConversation.has(id) || draftSavePromiseByConversation.has(id);
}

/**
 * Called by openConversation once the composer belongs to the next
 * conversation (after the previous draft was flushed): replaces the previous
 * conversation's text with the next one's cached draft, so no blur, keystroke
 * or flush can save the old text under the new conversation — and so a load
 * that fails still leaves that conversation's known draft on screen rather
 * than an empty composer a keystroke would save over it. The load's hydrate
 * then reconciles against it like any other incoming draft.
 */
export function beginConversationDraftSwitch(nextConversationId) {
  const id = String(nextConversationId || '').trim();
  const cached = id ? conversations[id] : null;
  const text = String(cached?.draftText || '');
  const attachments = Array.isArray(cached?.draftAttachments) ? cached.draftAttachments : [];
  if (cached && !getSyncedDraft(id)) {
    recordSyncedDraft(id, { text: draftTextForSync(text), attachments, updatedAt: cached.draftUpdatedAt || null });
  }
  if (attachments.length) setComposerAttachments(hydrateDraftAttachments(attachments));
  const input = document.getElementById('msg-input');
  if (input && input.value !== text) {
    input.value = text;
    autoResize(input);
  }
  syncSendButtonState();
}

// Omitted version fields keep their current values: a local edit changes the
// text only, never the server version it was based on.
function upsertConversationDraftState(conversationId, {
  draftText = '',
  draftAttachments = undefined,
  draftUpdatedAt = undefined,
  draftUpdatedByClientId = undefined,
} = {}) {
  const id = String(conversationId || '').trim();
  if (!id || !conversations[id]) return;
  const existing = conversations[id];
  conversations[id] = {
    ...existing,
    draftText: String(draftText || ''),
    draftAttachments: draftAttachments === undefined
      ? (existing.draftAttachments || [])
      : (Array.isArray(draftAttachments) ? draftAttachments : []),
    draftUpdatedAt: draftUpdatedAt === undefined ? (existing.draftUpdatedAt || null) : (draftUpdatedAt || null),
    draftUpdatedByClientId: draftUpdatedByClientId === undefined
      ? (existing.draftUpdatedByClientId || null)
      : (draftUpdatedByClientId || null),
  };
}

/**
 * Persists the composer's attachment set for the active conversation. Called
 * whenever an attachment finishes uploading or is removed, so the cache is
 * written as a discrete action rather than riding the text debounce.
 *
 * Before a conversation exists there is nowhere to persist to: the attachments
 * simply stay in the composer (they were already uploaded) and are adopted by
 * the conversation created on the first send.
 */
export function persistComposerAttachments() {
  const id = String(currentConvId || '').trim();
  // A send owns the draft: its post-send save picks the attachments up.
  if (!id || isDraftOwnedByPendingSend(id)) return null;
  return scheduleConversationDraftSave({
    conversationId: id,
    draftText: document.getElementById('msg-input')?.value || '',
    draftAttachments: serializeDraftAttachments(selectedAttachments),
    immediate: true,
  });
}

// Saves the conversation's composer text (or, off screen, its cached text)
// when it differs from the synced draft.
function saveComposerIfUnsynced(conversationId) {
  const synced = getSyncedDraft(conversationId);
  const viewing = isCurrentConversation(conversationId);
  const text = draftTextForSync(viewing
    ? (document.getElementById('msg-input')?.value || '')
    : (conversations[conversationId]?.draftText || ''));
  const attachments = viewing ? serializeDraftAttachments(selectedAttachments) : undefined;
  const attachmentsKey = draftAttachmentsKey(attachments);
  if (synced && synced.text === text && (attachmentsKey === null || synced.attachmentsKey === null || synced.attachmentsKey === attachmentsKey)) return;
  void scheduleConversationDraftSave({ conversationId, draftText: text, draftAttachments: attachments });
}

// The server echoes a stored message to its sender (user_message with this
// client's id), which drops it from pendingUserMessageIds; status events for
// it do the same. Either means the send landed even if its response failed.
function hasSendEchoArrived(clientMessageId) {
  const id = String(clientMessageId || '').trim();
  return !!id && !pendingUserMessageIds.has(id);
}

// A send that failed hands its text back to the composer. Text typed while it
// was in flight is kept after it (blank line between) instead of being
// replaced, so neither is lost; if the send never emptied the composer, the
// composer still holds the message and is kept as it is. A send whose echo
// already arrived did land (the failure was only the response): putting its
// text back would invite a duplicate, so only the typing is kept.
function restoreComposerAfterFailedSend(conversationId, originalText, { viewing, composerCleared, sendLanded = false }) {
  const input = document.getElementById('msg-input');
  const current = viewing
    ? String(input?.value || '')
    : String(conversations[conversationId]?.draftText || '');
  let text = originalText;
  if (sendLanded) text = current;
  else if (!composerCleared) text = current || originalText;
  else if (current.trim()) text = `${originalText}

${current}`;
  if (viewing && input) {
    input.value = text;
    autoResize(input);
  }
  void scheduleConversationDraftSave({ conversationId, draftText: text, immediate: true });
}

function isDraftVersionConflict(response) {
  return response?.conflict === true || response?.code === 'draft-version-conflict';
}

function isCurrentConversation(conversationId) {
  return String(currentConvId || '').trim() === String(conversationId || '').trim();
}

// The version a save is based on. Always sent — even when null, which tells
// the server "I have seen no draft yet" and is conflict-checked like any other.
function draftSaveBaseVersion(conversationId) {
  const synced = getSyncedDraft(conversationId);
  if (synced) return synced.updatedAt || null;
  return conversations[conversationId]?.draftUpdatedAt || null;
}

function sendConversationDraft(conversationId, text, draftAttachments, baseDraftUpdatedAt) {
  return updateConversationDraftApi(conversationId, {
    draftText: text,
    clientId: CLIENT_ID,
    draftSyncVersion: DRAFT_SYNC_PROTOCOL_VERSION,
    baseDraftUpdatedAt,
    ...(draftAttachments === undefined ? {} : { draftAttachments }),
  });
}

function acknowledgeSavedDraft(conversationId, response, sentText) {
  const serverText = String(response?.draftText || '');
  const updatedAt = response?.draftUpdatedAt || response?.updatedAt || null;
  // The server stores whitespace-only text as "no draft"; remembering what was
  // sent keeps that composer from looking modified against the empty echo.
  const text = !serverText && !String(sentText || '').trim() ? String(sentText || '') : serverText;
  recordSyncedDraft(conversationId, { text, attachments: response?.draftAttachments, updatedAt });
  upsertConversationDraftState(conversationId, {
    draftText: serverText,
    draftAttachments: response?.draftAttachments,
    draftUpdatedAt: updatedAt,
    draftUpdatedByClientId: response?.draftUpdatedByClientId || response?.senderClientId || null,
  });
}

function applyDraftToComposer(conversationId, text, draftAttachments = undefined) {
  if (!isCurrentConversation(conversationId)) return;
  if (Array.isArray(draftAttachments)) {
    const hydrated = hydrateDraftAttachments(draftAttachments);
    if (!draftAttachmentsEqual(selectedAttachments, hydrated)) setComposerAttachments(hydrated);
  }
  const input = document.getElementById('msg-input');
  if (input && draftTextForSync(input.value) !== text) {
    input.value = text;
    autoResize(input);
  }
  syncSendButtonState();
}

function adoptServerDraft(conversationId, {
  draftText = '',
  draftAttachments = undefined,
  draftUpdatedAt = null,
  draftUpdatedByClientId = null,
} = {}) {
  const text = String(draftText || '');
  clearDraftTimerForConversation(conversationId);
  recordSyncedDraft(conversationId, { text, attachments: draftAttachments, updatedAt: draftUpdatedAt });
  upsertConversationDraftState(conversationId, { draftText: text, draftAttachments, draftUpdatedAt, draftUpdatedByClientId });
  applyDraftToComposer(conversationId, text, draftAttachments);
}

// The draft that lost the last conflict, per conversation, so it can be put
// back. It lives outside the toast: a later notice may cover the toast, and
// the action reads the slot when tapped. Cleared when the draft is sent.
const restorableDraftByConversation = new Map();

function draftHasContent({ text = '', attachments = undefined } = {}) {
  return !!String(text || '').trim() || (Array.isArray(attachments) && attachments.length > 0);
}

function currentComposerDraft(conversationId) {
  if (isCurrentConversation(conversationId)) {
    return {
      text: String(document.getElementById('msg-input')?.value || ''),
      attachments: serializeDraftAttachments(selectedAttachments),
    };
  }
  const conversation = conversations[conversationId] || {};
  return {
    text: String(conversation.draftText || ''),
    attachments: Array.isArray(conversation.draftAttachments) ? conversation.draftAttachments : [],
  };
}

function offerRestorableDraft(conversationId, message, actionLabel) {
  showTransientRelayNotice(message, 20000, {
    actionLabel,
    onAction: () => swapRestorableDraft(conversationId),
  });
}

function keepLosingDraft(conversationId, losingDraft) {
  if (!draftHasContent(losingDraft)) return;
  restorableDraftByConversation.set(String(conversationId || '').trim(), losingDraft);
  offerRestorableDraft(conversationId, 'Your edit replaced a newer draft from another device.', 'Restore');
}

// Restore is a swap: the draft it replaces takes the slot, so the offer can
// always be reversed.
function swapRestorableDraft(conversationId) {
  const id = String(conversationId || '').trim();
  const restored = restorableDraftByConversation.get(id);
  if (!restored) return;
  restorableDraftByConversation.set(id, currentComposerDraft(id));
  const text = String(restored.text || '');
  applyDraftToComposer(id, text, restored.attachments);
  void scheduleConversationDraftSave({
    conversationId: id,
    draftText: text,
    draftAttachments: Array.isArray(restored.attachments) ? restored.attachments : undefined,
    immediate: true,
  });
  offerRestorableDraft(id, 'Draft restored.', 'Undo');
}

// A 409 means another client saved since this one's base version. The local
// composer is re-read here (not the text the save carried): it may have moved
// on while the request was in flight, and the newest keystroke is what wins.
async function resolveDraftSaveConflict(id, { text, draftAttachments, synced, conflict }) {
  const serverText = String(conflict.draftText || '');
  const serverAttachments = Array.isArray(conflict.draftAttachments) ? conflict.draftAttachments : undefined;
  const viewing = isCurrentConversation(id);
  const localText = viewing ? draftTextForSync(document.getElementById('msg-input')?.value ?? text) : text;
  const localAttachments = draftAttachments === undefined
    ? undefined
    : (viewing ? serializeDraftAttachments(selectedAttachments) : draftAttachments);
  let outcome = resolveDraftConflict({
    localText,
    localAttachmentsKey: draftAttachmentsKey(localAttachments),
    baseText: synced ? synced.text : null,
    baseAttachmentsKey: synced ? synced.attachmentsKey : null,
    serverText,
    serverAttachmentsKey: draftAttachmentsKey(serverAttachments),
  });
  // Uploads in flight are not in the fingerprint; adopting would replace the
  // attachment list and drop them, so they count as a local edit.
  if (outcome === 'adopt' && viewing && hasUploadingAttachments(selectedAttachments)) outcome = 'keep-local';
  if (outcome === 'adopt') {
    adoptServerDraft(id, conflict);
    return conflict;
  }
  recordSyncedDraft(id, { text: serverText, attachments: serverAttachments, updatedAt: conflict.draftUpdatedAt || null });
  if (outcome === 'converged') {
    upsertConversationDraftState(id, {
      draftText: serverText,
      draftAttachments: serverAttachments,
      draftUpdatedAt: conflict.draftUpdatedAt || null,
      draftUpdatedByClientId: conflict.draftUpdatedByClientId || null,
    });
    return conflict;
  }
  const retry = await sendConversationDraft(id, localText, localAttachments, conflict.draftUpdatedAt || null);
  if (retry?.ok) {
    acknowledgeSavedDraft(id, retry, localText);
    const localKey = draftAttachmentsKey(localAttachments);
    const lostSomething = serverText !== localText
      || (localKey !== null && localKey !== draftAttachmentsKey(serverAttachments));
    if (lostSomething) keepLosingDraft(id, { text: serverText, attachments: serverAttachments });
    return retry;
  }
  // Lost a second race. The base stays at the first conflict's version, so the
  // retry scheduled here conflicts again and resolves (with its restore offer)
  // through this same path instead of leaving the edit unsaved.
  if (isDraftVersionConflict(retry)) {
    void scheduleConversationDraftSave({ conversationId: id, draftText: localText, draftAttachments: localAttachments });
  }
  return retry || null;
}

async function persistConversationDraft(conversationId, draftText, draftAttachments = undefined, { force = false } = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const text = String(draftText || '');
  const runPersist = async () => {
    const synced = getSyncedDraft(id);
    if (!force && isDraftSaveNoop({
      synced,
      text,
      attachmentsKey: draftAttachmentsKey(draftAttachments),
      knownUpdatedAt: conversations[id]?.draftUpdatedAt || null,
    })) {
      return { ok: true, skipped: true, conversationId: id, draftText: synced.text, draftUpdatedAt: synced.updatedAt };
    }
    const response = await sendConversationDraft(id, text, draftAttachments, draftSaveBaseVersion(id));
    if (response?.ok) {
      acknowledgeSavedDraft(id, response, text);
      return response;
    }
    if (isDraftVersionConflict(response)) {
      return resolveDraftSaveConflict(id, { text, draftAttachments, synced, conflict: response });
    }
    return response || null;
  };
  const previous = draftSavePromiseByConversation.get(id) || Promise.resolve();
  const next = previous
    .catch(() => null)
    .then(runPersist)
    .finally(() => {
      if (draftSavePromiseByConversation.get(id) === next) {
        draftSavePromiseByConversation.delete(id);
      }
    });
  draftSavePromiseByConversation.set(id, next);
  return next;
}

async function scheduleConversationDraftSave({
  conversationId,
  draftText,
  draftAttachments = undefined,
  immediate = false,
  force = false,
} = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const text = draftTextForSync(draftText);
  upsertConversationDraftState(id, { draftText: text, draftAttachments });
  clearDraftTimerForConversation(id);
  if (immediate) {
    return persistConversationDraft(id, text, draftAttachments, { force });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      draftSaveTimerByConversation.delete(id);
      persistConversationDraft(id, text, draftAttachments, { force }).then(resolve).catch(() => resolve(null));
    }, COMPOSER_DRAFT_DEBOUNCE_MS);
    draftSaveTimerByConversation.set(id, timer);
  });
}

export async function flushConversationDraft(conversationId = currentConvId) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const input = document.getElementById('msg-input');
  const draftText = String((id === String(currentConvId || '').trim() && input) ? input.value : (conversations[id]?.draftText || ''));
  if (isDraftOwnedByPendingSend(id)) {
    // Held: the send saves the cached text once it settles.
    upsertConversationDraftState(id, { draftText: draftTextForSync(draftText) });
    return null;
  }
  return scheduleConversationDraftSave({
    conversationId: id,
    draftText,
    immediate: true,
  });
}

// Shared tail of both incoming-draft paths (conversation load/poll and the
// cross-client broadcast) for the conversation on screen. `incoming.attachments`
// is undefined when the update did not carry attachments.
function reconcileIncomingComposerDraft(id, incoming) {
  const input = document.getElementById('msg-input');
  if (!input) return;
  const synced = getSyncedDraft(id);
  const composerAttachments = serializeDraftAttachments(selectedAttachments);
  if (!shouldApplyIncomingDraftToComposer({
    inputText: input.value,
    incomingText: incoming.text,
    syncedText: synced ? synced.text : null,
    inputAttachmentsKey: draftAttachmentsKey(composerAttachments),
    incomingAttachmentsKey: draftAttachmentsKey(incoming.attachments),
    syncedAttachmentsKey: synced ? synced.attachmentsKey : null,
    attachmentsUploading: hasUploadingAttachments(selectedAttachments),
  })) {
    // An unsaved local edit (typing, an attachment change, or a flush that
    // failed). Re-save it, attachments included, so the version check
    // decides: the same version saves, a newer one conflicts.
    if (!isDraftSavePending(id)) {
      void scheduleConversationDraftSave({ conversationId: id, draftText: input.value, draftAttachments: composerAttachments });
    }
    syncSendButtonState();
    return;
  }
  recordSyncedDraft(id, incoming);
  if (Array.isArray(incoming.attachments)) {
    const hydrated = hydrateDraftAttachments(incoming.attachments);
    if (!draftAttachmentsEqual(selectedAttachments, hydrated)) setComposerAttachments(hydrated);
  }
  // A composer longer than the draft limit matches its truncated echo; it must
  // not be cut down to it.
  if (draftTextForSync(input.value) !== incoming.text) {
    input.value = incoming.text;
    autoResize(input);
  }
  syncSendButtonState();
}

export function hydrateConversationDraft(conversationId, {
  draftText = '',
  draftAttachments = [],
  draftUpdatedAt = null,
  draftUpdatedByClientId = null,
} = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return;
  // A refresh in flight across a send predates the send's own clear.
  if (isDraftOwnedByPendingSend(id)) return;
  const normalizedDraftText = String(draftText || '');
  const normalizedAttachments = Array.isArray(draftAttachments) ? draftAttachments : [];
  const existingMs = normalizeDraftTimestampMs(conversations[id]?.draftUpdatedAt);
  const incomingMs = normalizeDraftTimestampMs(draftUpdatedAt);
  if (isIncomingDraftTimestampStale({ existingMs, incomingMs })) return;
  upsertConversationDraftState(id, {
    draftText: normalizedDraftText,
    draftAttachments: normalizedAttachments,
    draftUpdatedAt,
    draftUpdatedByClientId,
  });
  const syncedDraft = { text: normalizedDraftText, attachments: normalizedAttachments, updatedAt: draftUpdatedAt };
  if (String(currentConvId || '').trim() !== id) {
    if (!isDraftSavePending(id)) recordSyncedDraft(id, syncedDraft);
    return;
  }
  reconcileIncomingComposerDraft(id, syncedDraft);
}

export function applyIncomingConversationDraftUpdate({
  conversationId,
  draftText = '',
  draftAttachments = undefined,
  draftUpdatedAt = null,
  draftUpdatedByClientId = null,
  senderClientId = null,
} = {}) {
  const id = String(conversationId || '').trim();
  if (!id || !conversations[id]) return;
  if (senderClientId && senderClientId === CLIENT_ID) return;
  // Same window as above: a broadcast of the pre-send draft must not undo the
  // clear the send is still persisting.
  if (isDraftOwnedByPendingSend(id)) return;
  const incomingDraftText = String(draftText || '');
  const existingMs = normalizeDraftTimestampMs(conversations[id]?.draftUpdatedAt);
  const incomingMs = normalizeDraftTimestampMs(draftUpdatedAt);
  if (isIncomingDraftTimestampStale({ existingMs, incomingMs })) return;
  upsertConversationDraftState(id, {
    draftText: incomingDraftText,
    draftAttachments,
    draftUpdatedAt,
    draftUpdatedByClientId: draftUpdatedByClientId || senderClientId || null,
  });
  const syncedDraft = { text: incomingDraftText, attachments: draftAttachments, updatedAt: draftUpdatedAt };
  if (String(currentConvId || '').trim() !== id) {
    if (!isDraftSavePending(id)) recordSyncedDraft(id, syncedDraft);
    return;
  }
  reconcileIncomingComposerDraft(id, syncedDraft);
}

function setConversationTurnState(conversationId, state = null) {
  const conversationKey = String(conversationId || '').trim();
  if (!conversationKey) {
    syncSendButtonState();
    return;
  }
  if (!state || !String(state.messageId || '').trim()) {
    activeTurnsByConversation.delete(conversationKey);
    syncSendButtonState();
    return;
  }
  activeTurnsByConversation.set(conversationKey, {
    messageId: String(state.messageId || '').trim(),
    status: String(state.status || 'processing').trim().toLowerCase() || 'processing',
    cancelRequested: state.cancelRequested === true,
  });
  syncSendButtonState();
}

function getMessagesElement() {
  return document.getElementById('messages');
}

function resetConversationHistoryState() {
  const conversationId = String(currentConvId || '').trim();
  conversationHistoryState = {
    conversationId,
    hasMoreOlder: false,
    hasMoreNewer: false,
    oldestMessageId: '',
    oldestMessageTimestamp: '',
    newestMessageId: '',
    newestMessageTimestamp: '',
    loadedMessageCount: 0,
    loadingOlder: false,
    loadingNewer: false,
  };
  conversationHistoryLoader.reset({ hasMore: false, nextCursor: null });
  conversationFutureLoader.reset({ hasMore: false, nextCursor: null });
  saveConversationLoadedMessageCount(conversationId, 0);
  syncHistoryLoadMoreControl();
  syncHeldBackLiveRows();
}

function setConversationHistoryState(next = {}) {
  conversationHistoryState = {
    conversationId: String(next.conversationId || currentConvId || '').trim(),
    hasMoreOlder: !!next.hasMoreOlder,
    hasMoreNewer: !!next.hasMoreNewer,
    oldestMessageId: String(next.oldestMessageId || '').trim(),
    oldestMessageTimestamp: String(next.oldestMessageTimestamp || '').trim(),
    newestMessageId: String(next.newestMessageId || '').trim(),
    newestMessageTimestamp: String(next.newestMessageTimestamp || '').trim(),
    loadedMessageCount: Math.max(0, Number(next.loadedMessageCount) || 0),
    loadingOlder: !!next.loadingOlder,
    loadingNewer: !!next.loadingNewer,
  };
  saveConversationLoadedMessageCount(
    conversationHistoryState.conversationId,
    conversationHistoryState.loadedMessageCount,
  );
  syncHistoryLoadMoreControl();
  syncHeldBackLiveRows();
}

function getConversationHistoryCursor() {
  return String(conversationHistoryState.oldestMessageId || '').trim();
}

function getConversationFutureCursor() {
  return String(conversationHistoryState.newestMessageId || '').trim();
}

export function getConversationLoadedMessageCount() {
  return Math.max(0, Number(conversationHistoryState.loadedMessageCount) || 0);
}

export function initConversationHistoryLazyLoading() {
  const el = getMessagesElement();
  if (!el || el.dataset.historyLazyLoadBound === '1') return;
  el.dataset.historyLazyLoadBound = '1';
  el.addEventListener('scroll', () => {
    if (resetConversationPaginationIfStale()) return;
    void conversationHistoryLoader.handleBoundaryDistance(el.scrollTop);
    const forwardDistance = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
    void conversationFutureLoader.handleBoundaryDistance(forwardDistance);
  }, { passive: true });
}

function buildHistoryLoadMoreMarkup(loading = false) {
  const text = loading ? 'Loading older…' : 'Load older messages';
  return `
    <div id="${HISTORY_LOAD_MORE_ID}" class="history-load-more">
      <button type="button" class="history-load-more-btn" onclick="loadOlderConversationMessages()" ${loading ? 'disabled' : ''}>${text}</button>
    </div>`;
}

function syncHistoryLoadMoreControl() {
  const el = getMessagesElement();
  if (!el) return;
  let box = document.getElementById(HISTORY_LOAD_MORE_ID);
  if (!conversationHistoryState.hasMoreOlder) {
    box?.remove();
    return;
  }
  if (!box) {
    const marker = el.querySelector(FIRST_TRANSCRIPT_ROW_SELECTOR);
    if (!marker) {
      el.insertAdjacentHTML('beforeend', buildHistoryLoadMoreMarkup(conversationHistoryState.loadingOlder));
      return;
    }
    marker.insertAdjacentHTML('beforebegin', buildHistoryLoadMoreMarkup(conversationHistoryState.loadingOlder));
    return;
  }
  const btn = box.querySelector('button');
  if (!btn) return;
  btn.disabled = conversationHistoryState.loadingOlder;
  btn.textContent = conversationHistoryState.loadingOlder ? 'Loading older…' : 'Load older messages';
}

function splitVariantId(modelVariantId = '') {
  const value = String(modelVariantId || '').trim();
  if (!value) return { baseModelId: '', reasoningEffort: null };
  const match = value.match(/^(.*)-(none|low|medium|high|xhigh|max)$/i);
  if (!match) return { baseModelId: value, reasoningEffort: null };
  return {
    baseModelId: String(match[1] || '').trim(),
    reasoningEffort: String(match[2] || '').trim().toLowerCase(),
  };
}

// The user's fold of an event row, by message id: a re-render of the
// transcript must not open a row the user folded (or fold one they opened).
const relayEventFoldChoices = new Map();

function createRelayEventNode(msg, msgId) {
  const div = document.createElement('div');
  div.className = 'msg relay-event';
  if (msgId) div.dataset.messageId = msgId;
  const fingerprint = buildLiveMessageFingerprint({ ...msg, id: msgId || msg?.id || '' });
  div.dataset.messageRole = fingerprint.role || '';
  div.dataset.messageTextFingerprint = fingerprint.text || '';
  div.dataset.messageTimestamp = String(msg?.timestamp || '').trim();
  div.innerHTML = renderRelayEventRowHtml(msg, { escHtml, timeText: msg?.timestamp ? fmtDate(msg.timestamp) : '' });
  const row = div.querySelector('details');
  if (row && msgId) {
    if (relayEventFoldChoices.has(msgId)) row.open = relayEventFoldChoices.get(msgId);
    row.addEventListener('toggle', () => relayEventFoldChoices.set(msgId, row.open));
  }
  setAgentExchangeRow(div, msg, msgId);
  return div;
}

// Agent exchanges (agent-exchange-fold-view.mjs): an agent's prompt folds
// into one row; this session's reply to it always shows. What the fold pass
// needs of a message is kept on its node when the row is built, so the pass
// reads the transcript itself and not the payload it came from.
const AGENT_EXCHANGE_ROW_KEY = '__agentExchangeRow';
// The user's toggle of a folded prompt, by its id: true opened, false
// closed, unset none (agentExchangeFoldOpen: open while it works, else
// folded). Kept through any re-render.
const agentExchangeFoldChoices = new Map();
// Each folded prompt's status, by its id, as of the last pass.
let agentExchangeStatusByPromptId = new Map();

function setAgentExchangeRow(div, msg, msgId) {
  div[AGENT_EXCHANGE_ROW_KEY] = agentExchangeRowOf(msg, { id: msgId || msg?.id || '' });
}

// The rows the plan reads, in order, and the node of each. The live bubble
// is the running turn's row; cards and boards without a reply are not rows.
function agentExchangeTranscriptRows(el) {
  const rows = [];
  const nodes = new Map();
  for (const node of el.children) {
    if (!node.classList?.contains('msg')) continue;
    let row = null;
    if (node.id === 'thinking-indicator') {
      const id = String(node.dataset.messageId || '').trim();
      if (id) row = { id, role: 'assistant', live: true };
    } else if (node[AGENT_EXCHANGE_ROW_KEY]) {
      row = { ...node[AGENT_EXCHANGE_ROW_KEY], steered: node.classList.contains(STEERED_MSG_CLASS) };
    }
    if (!row) continue;
    rows.push(row);
    nodes.set(row, node);
  }
  return { rows, nodes };
}

/**
 * Fold the transcript's agent prompts. One idempotent pass, run after every
 * render and update of the list like the separator and merge passes. The
 * folded row lives in the prompt's own node, as its first child, so no
 * insertion path has to place it; closed, a class hides the prompt's bubble.
 * The replies and the live bubble are read for the row's status and are
 * otherwise left alone.
 */
function syncAgentExchangeFolds(el = getMessagesElement()) {
  if (!el) return;
  const { rows, nodes } = agentExchangeTranscriptRows(el);
  const plan = planAgentExchangeFolds(rows, {
    runningIds: [getActiveTurnForConversation(currentConvId)?.messageId],
  });
  const states = new Map();
  const statusByPromptId = new Map();
  for (const group of plan) {
    if (!group.fold) continue;
    const open = agentExchangeFoldOpen(group.status, agentExchangeFoldChoices.get(group.promptId));
    states.set(nodes.get(group.prompt), { group, open });
    statusByPromptId.set(group.promptId, group.status);
  }
  agentExchangeStatusByPromptId = statusByPromptId;
  for (const node of el.children) {
    if (node.classList?.contains('msg')) applyAgentExchangeState(node, states.get(node) || null);
  }
}

// For the paths that change the list outside a render: the live bubble
// coming and going. A bulk render runs the pass once at its end.
export function syncAgentExchangeFoldsNow() {
  if (separatorSyncSuspended > 0) return;
  syncAgentExchangeFolds();
}

function applyAgentExchangeState(node, state) {
  node.classList.toggle(AGENT_EXCHANGE_HEAD_CLASS, !!state);
  node.classList.toggle(AGENT_EXCHANGE_CLOSED_CLASS, !!state && !state.open);
  const existing = node.querySelector(':scope > .agent-exchange-row');
  if (!state) {
    existing?.remove();
    return;
  }
  const { group, open } = state;
  const summary = agentExchangeSummary(group.prompt.origin, group.status, { conversations });
  const timeText = fmtDate(node.dataset.messageTimestamp);
  const key = JSON.stringify([summary.text, timeText]);
  let row = existing;
  if (!row || row.dataset.summaryKey !== key) {
    const holder = document.createElement('div');
    holder.innerHTML = renderAgentExchangeRowHtml(summary, { escHtml, timeText, open });
    const fresh = holder.firstElementChild;
    fresh.dataset.summaryKey = key;
    fresh.dataset.promptId = group.promptId;
    fresh.addEventListener('toggle', () => onAgentExchangeToggle(fresh));
    if (row) row.replaceWith(fresh);
    else node.insertBefore(fresh, node.firstChild);
    row = fresh;
  }
  if (row.open !== open) row.open = open;
}

function onAgentExchangeToggle(row) {
  const promptId = String(row.dataset.promptId || '').trim();
  // The pass setting `open` fires this too, and a row it has since replaced
  // (its status changed) fires it late; only the user's toggle is news.
  if (!promptId || !row.isConnected) return;
  const shown = agentExchangeFoldOpen(agentExchangeStatusByPromptId.get(promptId), agentExchangeFoldChoices.get(promptId));
  if (shown === row.open) return;
  agentExchangeFoldChoices.set(promptId, row.open);
  syncAgentExchangeFolds();
}

// A search result, a pin or a jump to a folded prompt opens it first, so
// the message jumped to is the one on screen.
function revealAgentExchangeMessage(messageId) {
  const promptId = String(messageId || '').trim();
  if (!agentExchangeStatusByPromptId.has(promptId) || agentExchangeFoldChoices.get(promptId) === true) return;
  agentExchangeFoldChoices.set(promptId, true);
  syncAgentExchangeFolds();
}

function createMessageNode(msg, msgId = null, force = false) {
  const el = getMessagesElement();
  if (!el) return null;

  if (msgId) {
    const existing = el.querySelector(`[data-message-id="${msgId}"]`);
    if (existing) return existing;
    if (!force && seenMessageIds.has(msgId)) return null;
    seenMessageIds.add(msgId);
  }

  // An event message the relay wrote into a watcher's conversation: a
  // compact, foldable row, never a bubble of the user's.
  if (isRelayEventMessage(msg)) return createRelayEventNode(msg, msgId);

  // A prompt another relay's agent sent carries `origin`: its header line is
  // hidden (the badge below says the same), and a stray remote-relay mention
  // hint never shows on any user bubble.
  const remoteOrigin = (msg?.role === 'user' && msg?.origin && typeof msg.origin === 'object') ? msg.origin : null;
  if (msg?.role === 'user') {
    const displayText = stripRemoteRelayDisplayArtifacts(msg.text, { origin: remoteOrigin });
    if (displayText !== String(msg.text ?? '')) msg = { ...msg, text: displayText };
  }

  const div = document.createElement('div');
  div.className = `msg ${msg.role}`;
  if (remoteOrigin) div.classList.add('msg-from-remote-relay');
  if (msgId) div.dataset.messageId = msgId;
  const fingerprint = buildLiveMessageFingerprint({
    ...(msg && typeof msg === 'object' ? msg : {}),
    id: msgId || msg?.id || '',
  });
  div.dataset.messageRole = fingerprint.role || '';
  div.dataset.messageTextFingerprint = fingerprint.text || '';
  div.dataset.messageTimestamp = String(msg?.timestamp || '').trim();
  if (fingerprint.sourceMessageId) div.dataset.sourceMessageId = fingerprint.sourceMessageId;
  setAgentExchangeRow(div, msg, msgId);

  const label = msg.role === 'user' ? 'You' : '';
  const { baseModelId, reasoningEffort } = splitVariantId(msg.model);
  const explicitReasoningEffort = String(msg?.reasoningEffort || '').trim().toLowerCase() || null;
  const resolvedReasoningEffort = explicitReasoningEffort || reasoningEffort;
  const modelOrigin = String(msg?.modelOrigin || '').trim().toLowerCase();
  const modelTag = (msg.role === 'assistant' && baseModelId)
    ? ` <span class="msg-model">${escHtml(baseModelId)}</span>` : '';
  const reasoningTag = (msg.role === 'assistant' && resolvedReasoningEffort && resolvedReasoningEffort !== 'none')
    ? ` <span class="msg-reasoning">${escHtml(resolvedReasoningEffort)}</span>` : '';
  const modeTag = msg.mode
    ? ` <span class="msg-mode">${escHtml(msg.mode)}</span>` : '';
  const autoTag = (msg.role === 'assistant' && modelOrigin === 'auto')
    ? ' <span class="msg-auto">auto</span>' : '';
  // A turn the agent started on its own after a background task settled — no
  // user prompt precedes it, so say where it came from.
  const continuationTag = (msg.role === 'assistant' && String(msg?.kind || '').trim() === 'continuation')
    ? ' <span class="msg-continuation" title="The agent continued on its own after a background task finished.">background continuation</span>'
    : '';
  // A steering absorption: this reply continues through the next (steered)
  // user message. The class feeds syncSteeredTurnMerge, which joins the trio
  // into one visual flow.
  const messageKind = String(msg?.kind || '').trim();
  if (msg.role === 'assistant' && messageKind === 'absorbed') {
    div.classList.add(ABSORBED_MSG_CLASS);
  }
  // The settle marker of a steer the CLI consumed without a turn of its own:
  // folded into (and answered by) the turn above, or cut off unanswered by a
  // Stop. Compact, attached to its own user message, never merging forward.
  // Also the marker of a message answered on a continuation row, which only
  // shares the look.
  const steerMarkerClass = msg.role === 'assistant' ? STEER_MARKER_CLASS_BY_KIND[messageKind] : null;
  if (steerMarkerClass) div.classList.add(steerMarkerClass);
  const isStoppedSteer = msg.role === 'assistant' && messageKind === 'stopped';
  // The relay's note while this session's worker cannot be started
  // (worker-launch-note-service.mjs), rewritten in place as the episode goes
  // on. Once the relay has stopped trying, the note carries Retry: a launch
  // for once the cause is fixed.
  const isWorkerLaunchNote = msg.role === 'assistant' && messageKind.startsWith('worker-launch-');
  if (isWorkerLaunchNote) div.classList.add('msg-worker-launch', `msg-${messageKind}`);
  const workerLaunchActionsHtml = (!IS_SHARED_VIEW && msgId && messageKind === 'worker-launch-stopped')
    ? `<div class="msg-bubble-actions"><button type="button" class="bubble-action-btn" data-action="retry-worker-launch" data-message-id="${escHtml(msgId)}" title="Start the worker for this conversation again now">Retry</button></div>`
    : '';
  // A turn answered by a different provider than the conversation is bound to
  // (e.g. the Copilot relay answering a Cursor conversation) must be visible,
  // not silent: it ran on another plan than the header indicates.
  const executedProvider = String(msg?.executedProvider || '').trim().toLowerCase();
  const boundProvider = String(conversations[currentConvId]?.runtimeProviderType || '').trim().toLowerCase();
  // 'unknown' means the responder identity did not resolve, not that another
  // provider ran the turn — no chip for it. Nor without a bound provider to
  // compare with (a shared view of a conversation that has none).
  const crossProviderTag = (msg.role === 'assistant' && executedProvider && executedProvider !== 'unknown' && boundProvider && executedProvider !== boundProvider)
    ? ` <span class="msg-provider-mismatch" title="This turn was executed by the ${escHtml(executedProvider)} provider, not the conversation's ${escHtml(boundProvider)} provider.">ran on ${escHtml(executedProvider)}</span>`
    : '';
  const usage = (msg.role === 'assistant' && msg?.usage && typeof msg.usage === 'object') ? msg.usage : null;
  const deltaCredits = Number(usage?.premium?.deltaCredits ?? usage?.premium?.deltaUsed);
  const deltaMonthlyPercent = Number(usage?.plan?.deltaMonthlyPercent);
  // Number(null) is 0, which would make missing data render as "0% left".
  const monthlyPercentRemaining = usage?.plan?.percentRemaining == null
    ? NaN
    : Number(usage.plan.percentRemaining);
  const usageTurnParts = [];
  if (Number.isFinite(deltaCredits) && deltaCredits > 0) {
    usageTurnParts.push(`+${escHtml(String(deltaCredits))}`);
  }
  if (Number.isFinite(deltaMonthlyPercent) && deltaMonthlyPercent > 0) {
    usageTurnParts.push(`${escHtml(deltaMonthlyPercent.toFixed(3))}%`);
  }
  const usageTurnTag = usageTurnParts.length
    ? ` <span class="msg-usage">${usageTurnParts.join(' (')}${usageTurnParts.length > 1 ? ')' : ''}</span>`
    : '';
  // Exactly 0% remaining is real data and must render; only absent/NaN hides.
  const usageRemainingTag = Number.isFinite(monthlyPercentRemaining)
    ? ` <span class="msg-usage">month ${escHtml(monthlyPercentRemaining.toFixed(1))}% left</span>`
    : '';
  const usageStaleTag = usage?.stale
    ? ' <span class="msg-usage msg-usage-stale">stale</span>'
    : '';
  const content = renderMarkdownPreview(msg.text || '', false);
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  // capRelayActivityEntries, not slice: a boundary past the cap would take
  // the break row with it.
  const activities = Array.isArray(msg.activities)
    ? capRelayActivityEntries(msg.activities.filter(Boolean), 48)
    : [];
  // A compaction that happened during this turn is rendered as a full-width
  // break row immediately above this message (syncTranscriptSeparators reads
  // the stamp), so it must not also show up inside the bubble's activity list.
  // Only the promoted (last) boundary is hidden — see renderActivityMarkup.
  // A rendered row is a finished message, so a compaction start without an
  // end draws no line here (the live bubble owns the running one).
  const promotedBoundaryEntry = promotedCompactBoundaryEntry(activities);
  const compactBoundary = compactBoundaryFromActivities(activities);
  if (compactBoundary) {
    div.dataset.compactBoundary = `${compactBoundary.preTokens ?? ''}|${compactBoundary.postTokens ?? ''}`;
  }
  if (visibleActivityEntries(activities, promotedBoundaryEntry).length) div.classList.add('msg-with-activity');
  const thoughts = Array.isArray(msg.thoughts) ? msg.thoughts.filter((t) => t && String(t.text || '').trim()) : [];
  const attachmentHtml = attachments.length ? renderAttachmentMarkup(attachments, { messageId: msgId }) : '';
  const subagentRuns = Array.isArray(msg.subagentRuns) ? msg.subagentRuns.filter(Boolean) : [];
  const mainActivities = activities.filter((item) => !(normalizeRelayActivityEntry(item)?.subagentRunId));
  const mainThoughts = thoughts.filter((t) => !t?.subagentRunId);
  const activityHtml = mainActivities.length ? renderActivityMarkup(mainActivities, promotedBoundaryEntry) : '';
  const thoughtsHtml = mainThoughts.length ? renderThoughtsMarkup(mainThoughts) : '';
  // One row per sub-agent the turn spawned, as in the composer's task panel;
  // its title opens the agent's whole record. The store's copy wins: status
  // events keep it current after the bubble was built.
  rememberSubagentRuns(subagentRuns);
  const subagentHtml = subagentRowsMarkup(
    subagentRuns.map((run) => mergeLiveSubagentRun(run, getSubagentRun(run.subagentRunId))),
    { clickable: true },
  );
  // Finished background workflows persisted with this assistant message
  // (docs/plans/workflow-progress-tree.md, Phase 4). The template only
  // reserves a placeholder; the cards are DOM-built below so digest text
  // never passes through innerHTML.
  const workflowRuns = (msg.role === 'assistant' && Array.isArray(msg.workflowRuns))
    ? msg.workflowRuns.filter((run) => run && typeof run === 'object').slice(0, 5)
    : [];
  const workflowRunsHtml = workflowRuns.length ? '<div class="msg-workflow-runs"></div>' : '';
  const previewCards = (msg.role === 'assistant' && Array.isArray(msg.previewCards))
    ? msg.previewCards.filter((card) => card && typeof card === 'object').slice(0, 5)
    : [];
  const previewCardsHtml = previewCards.length ? '<div class="msg-preview-cards"></div>' : '';
  const hasVisibleText = Boolean(String(msg.text || '').trim());
  const bubbleClass = (!hasVisibleText && attachments.length && !activities.length)
    ? 'msg-bubble msg-bubble-media-only'
    : 'msg-bubble';

  const isQueuedUserMessage = msg.role === 'user' && msgId && pendingUserMessageIds.has(msgId);
  // A row the worker pushed into its runtime but reports as still unconsumed
  // (Copilot's queued lane, heartbeat `cancellableIds`) keeps Cancel too: the
  // worker pulls it back out and the row ends cancelled, never answered.
  const isCancellableSteer = !isQueuedUserMessage
    && msg.role === 'user'
    && !!msgId
    && cancellableSteerIdsForConversation(currentConvId).has(msgId);
  const showsCancelButton = isQueuedUserMessage || isCancellableSteer;
  const isCancelInFlight = showsCancelButton && bubbleCancelInFlight.has(msgId);
  // The conversation's hidden list once it is known (a change on another
  // device arrives there), else the message's own mark.
  const hiddenFromShares = isMessageHiddenFromShares(currentConvId, msgId) ?? (msg?.hiddenFromShares === true);
  const activeTurnMessageId = String(getActiveTurnForConversation(currentConvId)?.messageId || '').trim();
  const sourceMessageId = String(msg?.sourceMessageId || '').trim();
  const belongsToActiveTurn = !!activeTurnMessageId
    && (activeTurnMessageId === msgId || activeTurnMessageId === sourceMessageId);
  const canToggleShareVisibility = !IS_SHARED_VIEW && !!msgId && !isQueuedUserMessage && !belongsToActiveTurn;
  // From the conversation's pin list, not from the message: the list is
  // ordered by revision, and a bubble built from a live event has no pin
  // state of its own.
  const pinned = isMessagePinned(currentConvId, msgId);
  const shareVisibilityActionHtml = canToggleShareVisibility
    ? `<div class="msg-share-visibility">
        ${buildMessagePinControlsHtml(msgId, pinned)}
        ${hiddenFromShares ? HIDDEN_LABEL_HTML : ''}
        <button type="button" class="msg-share-visibility-btn" data-action="toggle-share-visibility" data-message-id="${escHtml(msgId)}" data-hidden-from-shares="${hiddenFromShares ? 'true' : 'false'}" title="${shareVisibilityButtonTitle(hiddenFromShares)}">${hiddenFromShares ? 'Unhide' : 'Hide'}</button>
      </div>`
    : '';
  // A terminal failure whose fix lives in the relay UI gets the fix as a button
  // instead of an instruction to open a shell on the host. Shared viewers get
  // none of them: they cannot install or sign in to anything.
  const relayErrorActions = (!IS_SHARED_VIEW && msg.role === 'assistant')
    ? relayErrorCtaActions(msg.text)
    : [];
  const relayErrorCtaHtml = relayErrorActions.length
    ? `<div class="msg-error-cta">${relayErrorActions
      .map((item) => `<button type="button" class="bubble-action-btn" data-action="relay-error-cta" data-cta="${escHtml(item.action)}">${escHtml(item.label)}</button>`)
      .join('')}</div>`
    : '';
  const userBubbleActionsHtml = (!IS_SHARED_VIEW && showsCancelButton)
    ? buildUserBubbleCancelActionsMarkup(msgId, isCancelInFlight)
    : '';
  // Resent per the relay (any device, survives reloads), or by this page.
  const resendState = isStoppedSteer && msgId
    ? (stoppedSteerResends.get(msgId) || (String(msg?.resentAs || '').trim() ? { status: 'sent' } : null))
    : null;
  const resendLabel = resendState?.status === 'sent' ? 'Resent' : (resendState ? 'Resending…' : 'Resend');
  const stoppedSteerActionsHtml = (!IS_SHARED_VIEW && isStoppedSteer && msgId)
    ? `<div class="msg-bubble-actions"><button type="button" class="bubble-action-btn" data-action="resend-stopped-steer" data-message-id="${escHtml(msgId)}" title="Send this message again as a new turn"${resendState ? ' disabled' : ''}>${resendLabel}</button></div>`
    : '';

  // Shared viewers get the badge without the link to the other relay (or, for
  // an agent on this relay, to the conversation it runs in).
  const originBadgeHtml = remoteOrigin
    ? renderRemoteOriginBadgeHtml(remoteOrigin, { linkable: !IS_SHARED_VIEW, conversations })
    : '';

  div.innerHTML = `
    <div class="${bubbleClass}">${shareVisibilityActionHtml}${thoughtsHtml}${originBadgeHtml}${content}${relayErrorCtaHtml}${attachmentHtml}${activityHtml}${subagentHtml}${workflowRunsHtml}${previewCardsHtml}${userBubbleActionsHtml}${stoppedSteerActionsHtml}${workerLaunchActionsHtml}</div>
    <div class="msg-label">${label}${modelTag}${reasoningTag}${modeTag}${autoTag}${continuationTag}${crossProviderTag}${usageTurnTag}${usageRemainingTag}${usageStaleTag} · ${fmtDate(msg.timestamp)}</div>`;

  const bubble = div.querySelector('.msg-bubble');
  // A running sub-agent's row keeps its clock going once the bubble is placed.
  if (subagentHtml.includes('data-started-at')) setTimeout(syncSubagentRowClock, 0);
  rewriteLocalAssetUrlsInNode(bubble, { preferDrive: msg.role === 'assistant' });
  linkifyWorkspaceMentionsInNode(bubble);
  // One collapsed "Finished background task" card per persisted run, sharing
  // the live panel's tree renderer. The native <details> owns the fold; open
  // state is deliberately not keyed across re-renders — the runs are
  // immutable once persisted, and this node is only rebuilt on a full
  // renderMessages pass, which runs only when the snapshot key changes
  // (buildMessageSnapshotKey covers the message fields INCLUDING a
  // runId/status signature of these runs, and short-circuits otherwise).
  if (workflowRuns.length) {
    const runsHolder = div.querySelector('.msg-workflow-runs');
    if (runsHolder) {
      for (const run of workflowRuns) {
        const card = buildWorkflowRunCard(run);
        if (card) runsHolder.appendChild(card);
      }
    }
  }
  // Persisted preview snapshots render as link cards; live/closed state is
  // overlaid from the current registry inside the builder.
  if (previewCards.length) {
    const cardsHolder = div.querySelector('.msg-preview-cards');
    if (cardsHolder) {
      for (const snapshot of previewCards) {
        const card = buildTranscriptPreviewCard(snapshot);
        if (card) cardsHolder.appendChild(card);
      }
    }
  }
  div.querySelectorAll('pre code').forEach((b) => hljs.highlightElement(b));
  attachCodeCopyButtons(div);
  // What a Resend of this message would send, kept on the node itself so it
  // lives exactly as long as the row is on screen.
  if (msg.role === 'user') {
    const { references, unavailable } = attachmentReferencesForResend(attachments);
    div[RESEND_PAYLOAD_KEY] = {
      text: String(msg.text || ''),
      attachments: references,
      unavailableAttachments: unavailable,
    };
  }
  return div;
}

// Never scrolls: the caller scrolls after the separator pass (see
// appendMessage).
function insertMessageNode(node, insertAfterId = null) {
  if (!node) return null;
  if (node.parentNode) return node;
  const el = getMessagesElement();
  if (!el) return null;
  const anchorId = String(insertAfterId || '').trim();
  const anchor = anchorId ? el.querySelector(`[data-message-id="${anchorId}"]`) : null;
  if (anchor && anchor.parentNode === el) {
    let next = anchor.nextSibling;
    // The line of a compaction that ran in this turn sits between the user
    // message and its live bubble; the reply lands under it, so the
    // separator pass relabels that line instead of replacing it.
    if (next?.nodeType === 1
      && next.classList?.contains(SEPARATOR_CLASS)
      && next.dataset?.separatorKey === `compact:${anchorId}`) {
      next = next.nextSibling;
    }
    if (next) el.insertBefore(node, next);
    else el.appendChild(node);
  } else {
    el.appendChild(node);
  }
  return node;
}

function prependMessageNodes(msgs) {
  const el = getMessagesElement();
  if (!el) return { inserted: 0, firstMessageId: '' };
  const ordered = sortConversationMessages(msgs || []);
  const fragment = document.createDocumentFragment();
  let inserted = 0;
  let firstMessageId = '';
  for (const m of ordered) {
    const msgId = String(m?.id || '').trim() || null;
    const node = createMessageNode(m, msgId, true);
    if (!node || node.parentNode) continue;
    if (!firstMessageId && msgId) firstMessageId = msgId;
    fragment.appendChild(node);
    inserted += 1;
  }
  if (!inserted) return { inserted: 0, firstMessageId: '' };
  const marker = el.querySelector(FIRST_TRANSCRIPT_ROW_SELECTOR);
  if (marker && marker.parentNode === el) {
    el.insertBefore(fragment, marker);
  } else {
    el.appendChild(fragment);
  }
  return { inserted, firstMessageId };
}

// A shared view's tool lines arrive filtered by the relay's path privacy
// setting (server/services/share-path-redaction.mjs); they are shown as sent.
export function decorateActivityText(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  return prefixToolActivityEmoji(value);
}

export function renderThoughtsMarkup(thoughts) {
  const items = (Array.isArray(thoughts) ? thoughts : [])
    .map((thought) => ({
      reasoningId: String(thought?.reasoningId || '').trim(),
      text: String(thought?.text || '').trim(),
    }))
    .filter((thought) => thought.text);
  if (!items.length) return '';
  const blocks = items
    .map((thought) => `<div class="msg-thought-item"${thought.reasoningId ? ` data-reasoning-id="${escHtml(thought.reasoningId)}"` : ''}>${renderMarkdownPreview(thought.text, false)}</div>`)
    .join('');
  return `
    <details class="msg-thoughts">
      <summary>💭 Thoughts (${items.length})</summary>
      <div class="msg-thoughts-list">${blocks}</div>
    </details>`;
}

function enhanceThoughtMarkup(root) {
  if (!(root instanceof Element)) return;
  rewriteLocalAssetUrlsInNode(root, { preferDrive: true });
  linkifyWorkspaceMentionsInNode(root);
  root.querySelectorAll('pre code').forEach((block) => {
    if (globalThis.hljs?.highlightElement) globalThis.hljs.highlightElement(block);
  });
  attachCodeCopyButtons(root);
}

// Streamed markdown grows at the tail, so only nodes from the first divergent
// top-level block onward are replaced. Signatures are cached on the container:
// enhancement passes (hljs, link rewriting) mutate the rendered nodes, so
// re-deriving signatures from the DOM would break the stable prefix at the
// first code block. Returns the appended nodes for scoped enhancement.
function patchRenderedMarkdown(box, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const nextNodes = [...template.content.childNodes];
  const signatureOf = (node) => (node.nodeType === 1 ? node.outerHTML : `#text:${node.textContent}`);
  const nextSignatures = nextNodes.map(signatureOf);
  const cached = box.__streamSignatures;
  const prevSignatures = Array.isArray(cached) && cached.length === box.childNodes.length
    ? cached
    : [...box.childNodes].map(signatureOf);
  const stable = computeStablePrefixLength(prevSignatures, nextSignatures);
  while (box.childNodes.length > stable) box.lastChild.remove();
  const appended = [];
  for (let i = stable; i < nextNodes.length; i += 1) {
    box.appendChild(nextNodes[i]);
    appended.push(nextNodes[i]);
  }
  box.__streamSignatures = nextSignatures;
  return appended;
}

function renderThoughtBody(body, text) {
  if (!body) return;
  if (selectionIntersectsNode(body)) return;
  const value = String(text || '');
  const fingerprint = `${value.length}:${value.slice(-32)}`;
  if (body.dataset.thoughtFingerprint === fingerprint) return;
  body.dataset.thoughtFingerprint = fingerprint;
  const appended = patchRenderedMarkdown(body, renderMarkdownPreview(value, false));
  for (const node of appended) {
    if (node.nodeType === 1) enhanceThoughtMarkup(node);
  }
}

export function renderActivityMarkup(activities, promotedBoundaryEntry = undefined) {
  // The compaction boundary that got promoted to a transcript break row must
  // not be repeated inside the collapsed tool-activity details. A turn that
  // compacted more than once only promotes its LAST boundary, so the earlier
  // ones stay visible here as prose rather than disappearing from the
  // transcript altogether (one break row per message is all the separator
  // planner can place).
  // A compaction's start and cancel steps are never prose either.
  const list = Array.isArray(activities) ? activities : [];
  const promoted = promotedBoundaryEntry === undefined
    ? promotedCompactBoundaryEntry(list)
    : promotedBoundaryEntry;
  const visible = visibleActivityEntries(list, promoted);
  const progress = visible.filter((item) => relayActivityEntryText(item).startsWith('● '));
  const tools = visible.filter((item) => !relayActivityEntryText(item).startsWith('● '));
  const progressHtml = progress.length
    ? `<div class="msg-activity-list">${progress.map((item) => `<div class="msg-activity-item">${escHtml(decorateActivityText(relayActivityEntryText(item)))}</div>`).join('')}</div>`
    : '';
  const toolsHtml = tools.length
    ? `
      <details class="msg-activity">
        <summary>🔧 Tool activity (${tools.length})</summary>
        <div class="msg-activity-list">${tools.map((item) => `<div class="msg-activity-item">${escHtml(decorateActivityText(relayActivityEntryText(item)))}</div>`).join('')}</div>
      </details>`
    : '';
  return `${progressHtml}${toolsHtml}`;
}

// Places the live bubble directly under its owning user message, or leaves a
// bubble already in the transcript where it is when that row is not rendered.
// Idempotent so the reuse path can call it every tick: a bubble built before
// its owning row existed gets re-anchored once the row appears.
function anchorThinkingBubble(div, messageId) {
  const el = document.getElementById('messages');
  if (!el || !div) return;
  const id = String(messageId || '').trim();
  const target = id ? el.querySelector(`[data-message-id="${id}"]`) : null;
  if (target && target.parentNode === el) {
    // The bubble's own compaction line sits between the two.
    let follower = target.nextSibling;
    while (follower && follower !== div && follower.classList?.contains('transcript-separator')) {
      follower = follower.nextSibling;
    }
    if (follower === div) return;
    const next = target.nextSibling;
    if (next) el.insertBefore(div, next);
    else el.appendChild(div);
    if (div.dataset.compactBoundary) syncSeparatorsNow();
    // A folded agent prompt's row says the turn is working.
    else syncAgentExchangeFoldsNow();
  } else if (div.parentNode !== el) {
    el.appendChild(div);
  }
}

// Which conversation a live bubble belongs to. #messages is shared by every
// conversation, so a bubble is only ever reused or preserved for its own.
function thinkingConversationKey() {
  return String(currentConvId || '').trim() || '__new__';
}

export function showThinking(messageId = null, autoScroll = true) {
  const nextMessageId = String(messageId || '').trim();
  if (nextMessageId) thinkingMessageId = nextMessageId;
  const existing = document.getElementById('thinking-indicator');
  // A window that ends above the conversation's end shows no live bubble:
  // under it, it would sit below rows that are not loaded. The turn's
  // thoughts, tools and text are kept all the same; the bubble is drawn once
  // the window meets the end.
  if (!isConversationWindowAtTail()) {
    // Through the same path as removeThinking, so the separators and the
    // agent folds no longer show the bubble either; the turn's id stays.
    if (existing) takeThinkingBubbleOff();
    return;
  }
  if (existing
    && existing.dataset.conversationId === thinkingConversationKey()
    && (!nextMessageId || String(existing.dataset.messageId || '') === nextMessageId)) {
    // Reuse the live bubble: rebuilding it every poll tick destroys any text
    // selection anchored inside and drops in-progress subagent bubbles.
    const stopBtn = existing.querySelector('[data-action="stop-turn"]');
    if (stopBtn && nextMessageId) {
      const stopping = bubbleCancelInFlight.has(nextMessageId);
      stopBtn.disabled = stopping;
      stopBtn.textContent = stopping ? 'Stopping…' : 'Stop';
      stopBtn.classList.toggle('stopping', stopping);
    }
    anchorThinkingBubble(existing, nextMessageId || existing.dataset.messageId);
    syncThinkingFollowButtons(existing, getThinkingFollowMode());
    observeThinkingBubble(existing);
    if (getThinkingFollowMode()) applyThinkingFollow();
    else if (autoScroll) scrollBottom();
    return;
  }
  existing?.remove();
  unobserveThinkingBubble();
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'thinking-indicator';
  div.dataset.conversationId = thinkingConversationKey();
  if (nextMessageId) div.dataset.messageId = nextMessageId;
  const isCancelInFlight = nextMessageId && bubbleCancelInFlight.has(nextMessageId);
  const stopBtnHtml = (!IS_SHARED_VIEW && nextMessageId)
    ? `<button type="button" class="bubble-action-btn${isCancelInFlight ? ' stopping' : ''}" data-action="stop-turn" data-message-id="${escHtml(nextMessageId)}"${isCancelInFlight ? ' disabled' : ''}>${isCancelInFlight ? 'Stopping…' : 'Stop'}</button>`
    : '';
  // Stop stays left; the follow buttons (💭 thoughts, 📃 answer, 🛠️ tools)
  // sit on the right. See thinking-follow.js.
  const followBtnsHtml = renderThinkingFollowButtonsHtml(getThinkingFollowMode());
  div.innerHTML = `
    <div class="thinking-bubble">
      <div class="thinking-bubble-header">${stopBtnHtml}${followBtnsHtml}</div>
      <details id="thinking-thoughts" class="thinking-thoughts-panel" open>
        <summary>💭 Thoughts</summary>
        <div class="thinking-thoughts-list"></div>
      </details>
      <div id="thinking-stream" class="thinking-stream" hidden></div>
      <div class="thinking-compacting-note" hidden>Compacting the conversation…</div>
      <div class="dots"><span></span><span></span><span></span></div>
      <div id="thinking-activity" class="thinking-activity"></div>
      <div class="subagent-bubbles-container" data-subagent-bubbles-root="1"></div>
    </div>`;
  anchorThinkingBubble(div, nextMessageId);
  syncThinkingCompaction(div);
  renderThinkingThoughts();
  renderThinkingStream();
  // A board the turn has posted already lives in its live bubble.
  renderRelayBoards();
  observeThinkingBubble(div);
  if (getThinkingFollowMode()) applyThinkingFollow();
  else if (autoScroll) scrollBottom();
}

export function removeThinking() {
  thinkingMessageId = null;
  lastInFlightSnapshotKey = '';
  takeThinkingBubbleOff();
}

// The live bubble leaves the page, with what hangs on it (its compaction
// line, the agent folds' "working"). The turn it shows is not forgotten:
// removeThinking does that; a window that stops reaching the end only hides
// the bubble until it meets the end again (showThinking).
function takeThinkingBubbleOff() {
  const hadBubble = !!document.getElementById('thinking-indicator');
  const wasCompacting = !!document.getElementById('thinking-indicator')?.dataset?.compactBoundary;
  unobserveThinkingBubble();
  document.getElementById('thinking-indicator')?.remove();
  // The bubble's compaction line goes with it, but only after the
  // caller's same-tick work: a reply appended right after this call takes
  // the line over (relabelled in place) instead of it being dropped first.
  if (wasCompacting) queueMicrotask(syncSeparatorsNow);
  // A turn that ended without a reply (cancelled) stops saying "working".
  if (hadBubble) syncAgentExchangeFoldsNow();
}

// The turn ends under a reader who is not at the end: the live bubble is
// taken off the page and the reply row is put in its place. The page is
// shorter for a moment (scrollTop can be clamped), and the reply is not as
// tall as the bubble was (its thoughts are folded). Whatever the reader looks
// at stays where it is: the block of text at the top of the viewport is noted
// before the swap and put back after it. Read in the bubble's stream, it is
// found again in the reply; in a row above or below the bubble, in that row.
export function captureLiveReplyReadingPosition() {
  const el = getMessagesElement();
  if (!el) return null;
  const bubble = document.getElementById('thinking-indicator');
  return {
    scrollTop: el.scrollTop,
    block: captureReadingBlock(el),
    // Below the bubble the pixel position is the wrong fallback: everything
    // the reader sees moves up or down with the swap, and scrollTop with it.
    belowBubble: !!bubble && bubble.getBoundingClientRect().bottom <= el.getBoundingClientRect().top,
  };
}

export function restoreLiveReplyReadingPosition(position) {
  const el = getMessagesElement();
  if (!el || !position || isChatInteractionHeld()) return;
  if (restoreReadingBlock(el, position.block)) return;
  if (!position.belowBubble) el.scrollTop = position.scrollTop;
}

// A rebuild of the transcript on the page that nobody asked to scroll: the
// reader keeps the text they are at, or failing that the pixel position.
function renderMessagesInPlace(msgs, meta) {
  const el = getMessagesElement();
  const reading = el ? { scrollTop: el.scrollTop, block: captureReadingBlock(el) } : null;
  const rendered = renderMessages(msgs, false, meta);
  if (el && reading && rendered && !restoreReadingBlock(el, reading.block)) el.scrollTop = reading.scrollTop;
  return rendered;
}

// The live turn's compaction line: the bubble stamps the turn's compaction
// for the separator pass — "Compacting context…" while the last compaction
// entry is a start without an end, the final label once the boundary is in —
// so the line sits above the bubble and the reply takes it over unchanged.
// The bubble's own note shows only while it runs.
function syncThinkingCompaction(bubble = document.getElementById('thinking-indicator')) {
  if (!bubble) return;
  const items = thinkingMessageId ? (relayActivities.get(thinkingMessageId) || []) : [];
  const boundary = compactBoundaryFromActivities(items, { processing: true });
  const note = bubble.querySelector('.thinking-compacting-note');
  if (note) note.hidden = !boundary?.pending;
  const stamp = !boundary
    ? ''
    : (boundary.pending ? COMPACT_PENDING_STAMP : `${boundary.preTokens ?? ''}|${boundary.postTokens ?? ''}`);
  if ((bubble.dataset.compactBoundary || '') === stamp) return;
  if (stamp) bubble.dataset.compactBoundary = stamp;
  else delete bubble.dataset.compactBoundary;
  if (bubble.parentNode) syncSeparatorsNow();
}

// Stop is one tap away on a sticky header, so a stray touch must not kill a
// long turn: confirm first, then run the existing stop path.
function openStopTurnConfirmation(conversationId, messageId) {
  const convId = String(conversationId || '').trim();
  const id = String(messageId || '').trim();
  if (!convId || !id) return;
  if (bubbleCancelInFlight.has(id)) return;
  openSummaryModal({
    title: 'Stop this turn?',
    subtitle: 'The agent stops after its current step',
    kind: 'stop-turn',
    bodyHtml: `
      <p>Stop the running turn? Work already done stays; anything the agent was about to do is cut short.</p>
      <div class="summary-modal-actions">
        <button class="chat-title-action-btn danger-btn" type="button" data-stop-turn-confirm="1">⏹ Stop turn</button>
        <button class="chat-title-action-btn" type="button" data-stop-turn-cancel="1">Keep running</button>
      </div>
    `,
  });
  const body = document.getElementById('summary-modal-body');
  body?.querySelector('[data-stop-turn-confirm]')?.addEventListener('click', (event) => {
    event.preventDefault();
    closeSummaryModal();
    void stopTurnByMessageId(convId, id);
  }, { once: true });
  body?.querySelector('[data-stop-turn-cancel]')?.addEventListener('click', (event) => {
    event.preventDefault();
    closeSummaryModal();
  }, { once: true });
}

/** The Stop confirmation for a conversation's running turn, from outside the bubble (the sidebar menu). */
export function openStopTurnConfirmationForConversation(conversationId) {
  const turn = getActiveTurnForConversation(conversationId);
  if (!turn?.messageId) return false;
  openStopTurnConfirmation(conversationId, turn.messageId);
  return true;
}

/** Whether a turn of this conversation is running as far as this page knows. */
export function conversationHasActiveTurn(conversationId) {
  return !!getActiveTurnForConversation(conversationId);
}

export function collapseThinkingThoughts() {
  const panel = document.getElementById('thinking-thoughts');
  if (!(panel instanceof HTMLDetailsElement)) return;
  panel.open = false;
  panel.querySelectorAll('.thinking-thought').forEach((row) => {
    if (row instanceof HTMLDetailsElement) row.open = false;
  });
}

export function clearRelayStreamState(messageId = null) {
  const id = String(messageId || '').trim();
  if (!id) {
    relayStreamStateByMessageId.clear();
    relayStreamTextByMessageId.clear();
    return;
  }
  relayStreamStateByMessageId.delete(id);
  relayStreamTextByMessageId.delete(id);
}

function rememberRelayStreamState(messageId, seq, done = false) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  const normalizedSeq = normalizeStreamSeq(seq);
  const prev = relayStreamStateByMessageId.get(id) || { seq: 0, done: false };
  const next = {
    seq: normalizedSeq === null ? prev.seq : normalizedSeq,
    done: prev.done || !!done,
  };
  relayStreamStateByMessageId.set(id, next);
  return next;
}

// Live reply preview: the assistant's text as it streams, rendered with the
// same markdown path the finished bubble uses. Replaced by the real assistant
// message when the turn completes and `removeThinking()` drops this bubble.
function renderThinkingStream() {
  const box = document.getElementById('thinking-stream');
  if (!box) return;
  // The store keeps the latest text; the next frame after the selection is
  // released repaints, so skipping here never loses content.
  if (selectionIntersectsNode(box)) return;
  const text = thinkingMessageId ? String(relayStreamTextByMessageId.get(thinkingMessageId) || '') : '';
  if (!text.trim()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  patchRenderedMarkdown(box, renderMarkdownPreview(text, false));
}

function renderSubagentStream(subagentRunId, text) {
  const id = String(subagentRunId || '').trim();
  if (!id) return;
  const bubble = ensureSubagentBubble(id);
  if (!bubble) return;
  let box = bubble.querySelector(':scope > .subagent-stream');
  if (!box) {
    box = document.createElement('div');
    box.className = 'subagent-stream';
    // Above the nested-children container so a subagent's own text stays with
    // its bubble rather than reading as part of a child run.
    const childrenContainer = bubble.querySelector(':scope > .subagent-bubbles-container');
    if (childrenContainer) bubble.insertBefore(box, childrenContainer);
    else bubble.appendChild(box);
  }
  if (selectionIntersectsNode(box)) return;
  const value = String(text || '');
  if (!value.trim()) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  patchRenderedMarkdown(box, renderMarkdownPreview(value, false));
  refreshSubagentSummary(bubble);
}

function patchActivityList(box, expectedTexts, className) {
  const current = Array.from(box.children, (row) => row.textContent || '');
  const plan = planListPatch(current, expectedTexts);
  if (plan.reset) box.innerHTML = '';
  for (const text of plan.appends) {
    const row = document.createElement('div');
    row.className = className;
    row.textContent = text;
    box.appendChild(row);
  }
}

export function renderThinkingActivities() {
  const items = thinkingMessageId ? (relayActivities.get(thinkingMessageId) || []) : [];
  const box = document.getElementById('thinking-activity');
  if (!box) return;
  // Idempotent replay: the live bubble is reused across poll ticks, so a
  // clear-and-replay (or the append path's last-row-only dedupe) would either
  // wipe selections or duplicate rows on every changed payload.
  const mainExpected = [];
  const bySubagentRun = new Map();
  for (const item of items) {
    const entry = normalizeRelayActivityEntry(item);
    if (!entry) continue;
    // The persisted message promotes a compaction boundary to a full-width
    // break row, so the live bubble must not show it as a prose line — it
    // would otherwise flip presentation the moment the turn lands.
    if (isCompactBoundaryActivityEntry(entry)) continue;
    const decorated = decorateActivityText(entry.text);
    if (entry.subagentRunId) {
      const list = bySubagentRun.get(entry.subagentRunId) || [];
      if (list[list.length - 1] !== decorated) list.push(decorated);
      bySubagentRun.set(entry.subagentRunId, list);
    } else if (mainExpected[mainExpected.length - 1] !== decorated) {
      mainExpected.push(decorated);
    }
  }
  if (!selectionIntersectsNode(box)) {
    patchActivityList(box, mainExpected, 'thinking-activity-item');
  }
  syncThinkingCompaction();
  for (const [subagentRunId, expected] of bySubagentRun) {
    const bubble = ensureSubagentBubble(subagentRunId);
    const runBox = bubble?.querySelector('.subagent-activity');
    if (runBox && !selectionIntersectsNode(runBox)) {
      patchActivityList(runBox, expected, 'subagent-activity-item');
      refreshSubagentSummary(bubble);
    }
  }
}

export function restoreInFlightThinking(inFlight, autoScroll = true) {
  const messageId = String(inFlight?.messageId || '').trim();
  const status = String(inFlight?.status || '').trim().toLowerCase();
  if (!messageId || status !== 'processing') {
    clearRelayStreamState();
    setConversationTurnState(currentConvId, null);
    thinkingMessageId = null;
    removeThinking();
    return;
  }
  // Skip the rebuild when the payload matches the previous tick: the 900ms
  // live poll would otherwise churn the DOM (and the user's selection) with
  // identical content. The indicator must belong to this turn's message —
  // skipping on a foreign bubble would let a misplaced one stick around.
  const snapshotKey = buildInFlightSnapshotKey(inFlight);
  const liveIndicator = document.getElementById('thinking-indicator');
  if (snapshotKey === lastInFlightSnapshotKey
    && liveIndicator
    && String(liveIndicator.dataset.messageId || '') === messageId) {
    return;
  }
  lastInFlightSnapshotKey = snapshotKey;
  // The snapshot may have been read before the newest live frame was stored.
  const liveStreamSeq = relayStreamStateByMessageId.get(messageId)?.seq || 0;
  const liveStreamText = relayStreamTextByMessageId.get(messageId);
  clearRelayStreamState();
  setConversationTurnState(currentConvId, { messageId, status: 'processing' });
  const activities = mergeRelayActivityTexts(
    relayActivities.get(messageId) || [],
    Array.isArray(inFlight.activities) ? inFlight.activities : [],
  );
  relayActivities.set(messageId, activities);
  const inFlightThoughts = Array.isArray(inFlight.thoughts) ? inFlight.thoughts : [];
  if (inFlightThoughts.length) {
    const thoughtMap = relayThoughts.get(messageId) || new Map();
    for (const entry of inFlightThoughts) {
      const key = String(entry?.reasoningId || `seq-${entry?.seq || thoughtMap.size}`);
      thoughtMap.set(key, { reasoningId: key, text: String(entry?.text || ''), done: !!entry?.done, subagentRunId: entry?.subagentRunId || null });
    }
    relayThoughts.set(messageId, thoughtMap);
  }
  const inFlightSubagentRuns = Array.isArray(inFlight.subagentRuns) ? inFlight.subagentRuns : [];
  clearSubagentRunsForMessage(messageId);
  for (const entry of inFlightSubagentRuns) {
    upsertSubagentRun({
      subagentRunId: entry?.subagentRunId,
      messageId: entry?.messageId || messageId,
      conversationId: entry?.conversationId || currentConvId,
      parentSubagentId: entry?.parentSubagentId || null,
      displayName: entry?.displayName || null,
      status: entry?.status || 'running',
      timestamp: entry?.updatedAt || entry?.startedAt || null,
    });
  }
  for (const item of activities) {
    const entry = normalizeRelayActivityEntry(item);
    if (!entry?.subagentRunId) continue;
    upsertSubagentRun({
      subagentRunId: entry.subagentRunId,
      messageId,
      conversationId: currentConvId,
    });
  }
  // Seed the per-thread stream text before the bubbles are built so both the
  // reply preview and each subagent bubble repaint on reload.
  const streamTextByThread = deriveInFlightStreamTextByThread(inFlight);
  if (streamTextByThread.main && streamTextByThread.main.seq >= liveStreamSeq) {
    relayStreamTextByMessageId.set(messageId, streamTextByThread.main.text);
  } else if (liveStreamText !== undefined) {
    relayStreamTextByMessageId.set(messageId, liveStreamText);
  }
  for (const [runId, entry] of streamTextByThread.bySubagentRunId) {
    upsertSubagentRun({ subagentRunId: runId, messageId, conversationId: currentConvId });
    setSubagentStreamText(runId, entry.text);
  }
  showThinking(messageId, autoScroll);
  // relay_stream frames are volatile, so a dropped one reaches the bubble only
  // from here; showThinking does not repaint a bubble it reuses.
  renderThinkingStream();
  renderThinkingActivities();
  renderThinkingThoughts();
  renderRestoredSubagentBubbles(messageId);
  const streamState = deriveLatestInFlightStreamEvent(inFlight);
  if (streamState) {
    rememberRelayStreamState(messageId, streamState.seq, streamState.done || !!inFlight?.streamDone);
    updateThinkingStreamStatus(messageId, streamState.done || !!inFlight?.streamDone, autoScroll);
    return;
  }
  const fallbackSeq = normalizeStreamSeq(inFlight?.lastStreamSeq);
  if (fallbackSeq !== null || inFlight?.streamDone) {
    rememberRelayStreamState(messageId, fallbackSeq === null ? 0 : fallbackSeq, !!inFlight?.streamDone);
  }
}

// `item` is either the plain activity text or a full activity entry
// ({ text, subagentRunId, metadata }); the entry form is what lets the live
// bubble recognise a compaction boundary.
export function appendThinkingActivity(item, subagentRunId = null, autoScroll = true) {
  const entry = normalizeRelayActivityEntry(
    item && typeof item === 'object' ? item : { text: item, subagentRunId },
  );
  if (!entry) return;
  // Same rule as renderThinkingActivities: a boundary becomes a break row on
  // the persisted message, so it never shows as live prose. Every
  // compaction step does move the live turn's compaction line, though.
  if (isCompactBoundaryActivityEntry(entry)) {
    syncThinkingCompaction();
    return;
  }
  const decorated = decorateActivityText(entry.text);

  if (subagentRunId) {
    const subagentBubble = ensureSubagentBubble(subagentRunId);
    if (subagentBubble) {
      const activityBox = subagentBubble.querySelector('.subagent-activity');
      if (activityBox) {
        const lastItem = activityBox.lastElementChild?.textContent || '';
        if (lastItem !== decorated) {
          const row = document.createElement('div');
          row.className = 'subagent-activity-item';
          row.textContent = decorated;
          activityBox.appendChild(row);
          refreshSubagentSummary(subagentBubble);
        }
      }
      if (autoScroll) scrollBottom();
    }
    // Without a bubble the store still holds the entry; it replays when the
    // bubble appears. Never demote subagent activity into the parent box.
    return;
  }

  const box = document.getElementById('thinking-activity');
  if (!box) return;
  const last = box.lastElementChild?.textContent || '';
  if (last === decorated) return;
  const row = document.createElement('div');
  row.className = 'thinking-activity-item';
  if (subagentRunId) row.dataset.subagentRunId = subagentRunId;
  row.textContent = decorated;
  box.appendChild(row);
  if (autoScroll) scrollBottom();
}

function getSubagentDisplayName(subagentRunId) {
  const entry = typeof getSubagentRun === 'function' ? getSubagentRun(subagentRunId) : null;
  if (entry?.displayName) return entry.displayName;
  const id = String(subagentRunId || '').trim();
  if (!id) return 'Subagent';
  const short = id.length > 12 ? `${id.slice(0, 8)}…` : id;
  return `Subagent ${short}`;
}

function getSubagentStatus(subagentRunId) {
  const entry = typeof getSubagentRun === 'function' ? getSubagentRun(subagentRunId) : null;
  return entry?.status || 'running';
}

function normalizeSubagentBubbleStatus(status) {
  const normalized = String(status || 'running').trim().toLowerCase() || 'running';
  if (normalized === 'processing') return 'running';
  return normalized;
}

function isSubagentTerminalStatus(status) {
  return SUBAGENT_TERMINAL_STATUSES.has(normalizeSubagentBubbleStatus(status));
}

function getSubagentParentId(subagentRunId) {
  const entry = typeof getSubagentRun === 'function' ? getSubagentRun(subagentRunId) : null;
  return entry?.parentSubagentId || null;
}

function findSubagentBubbleContainer(parentSubagentId, depth = 0) {
  if (!parentSubagentId) {
    return document.querySelector('#thinking-indicator .subagent-bubbles-container[data-subagent-bubbles-root="1"]');
  }
  let parentBubble = document.querySelector(`.subagent-bubble[data-subagent-run-id="${CSS.escape(parentSubagentId)}"]`);
  if (!parentBubble && depth < 8) {
    // Child events can arrive before the parent bubble exists; build the
    // parent chain on demand so the child still nests correctly.
    parentBubble = ensureSubagentBubble(parentSubagentId, depth + 1);
  }
  if (!parentBubble) return null;
  let container = parentBubble.querySelector(':scope > .subagent-bubbles-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'subagent-bubbles-container';
    parentBubble.appendChild(container);
  }
  return container;
}

function ensureSubagentBubble(subagentRunId, depth = 0) {
  const id = String(subagentRunId || '').trim();
  if (!id) return null;

  let bubble = document.querySelector(`.subagent-bubble[data-subagent-run-id="${CSS.escape(id)}"]`);
  if (bubble) {
    const status = getSubagentStatus(id);
    updateSubagentBubbleStatus(bubble, status);
    updateSubagentStopButton(id, isSubagentCancelInFlight(id), status);
    applySubagentFold(id);
    return bubble;
  }

  const parentSubagentId = getSubagentParentId(id);
  const container = findSubagentBubbleContainer(parentSubagentId, depth);
  if (!container) return null;

  bubble = document.createElement('div');
  bubble.className = 'subagent-bubble';
  bubble.dataset.subagentRunId = id;

  // The whole header folds and unfolds the bubble (a phone needs the large
  // target); the Stop button inside it keeps its own click.
  const header = document.createElement('div');
  header.className = 'subagent-bubble-header';
  header.dataset.action = 'toggle-subagent';
  header.dataset.subagentRunId = id;
  header.setAttribute('role', 'button');
  header.tabIndex = 0;

  const foldMark = document.createElement('span');
  foldMark.className = 'subagent-bubble-fold';
  foldMark.setAttribute('aria-hidden', 'true');
  header.appendChild(foldMark);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'subagent-bubble-name';
  nameSpan.textContent = getSubagentDisplayName(id);

  const statusSpan = document.createElement('span');
  statusSpan.className = 'subagent-bubble-status';
  const status = getSubagentStatus(id);
  statusSpan.dataset.status = normalizeSubagentBubbleStatus(status);
  statusSpan.textContent = normalizeSubagentBubbleStatus(status) === 'running'
    ? '● Running'
    : normalizeSubagentBubbleStatus(status).charAt(0).toUpperCase() + normalizeSubagentBubbleStatus(status).slice(1);

  // What the run is doing, in one line, for the header of a folded bubble.
  const summarySpan = document.createElement('span');
  summarySpan.className = 'subagent-bubble-summary';

  const controls = document.createElement('div');
  controls.className = 'subagent-bubble-controls';
  controls.appendChild(statusSpan);

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'bubble-action-btn subagent-stop-btn';
  stopBtn.dataset.action = 'stop-subagent';
  stopBtn.dataset.subagentRunId = id;
  controls.appendChild(stopBtn);

  header.appendChild(nameSpan);
  header.appendChild(summarySpan);
  header.appendChild(controls);

  const activityBox = document.createElement('div');
  activityBox.className = 'subagent-activity';

  const thoughtsBox = document.createElement('div');
  thoughtsBox.className = 'subagent-thoughts';

  bubble.appendChild(header);
  bubble.appendChild(thoughtsBox);
  bubble.appendChild(activityBox);
  container.appendChild(bubble);
  updateSubagentStopButton(id, isSubagentCancelInFlight(id), status);
  applySubagentFold(id);

  const entry = getSubagentRun(id);
  if (entry?.thoughts?.length) {
    for (const item of entry.thoughts) {
      appendThinkingThought(
        item?.reasoningId || `restored-${thoughtsBox.childElementCount}`,
        String(item?.text || ''),
        !!item?.done,
        id,
        false,
      );
    }
  }
  if (entry?.activities?.length) {
    for (const item of entry.activities) {
      const text = typeof item === 'string' ? item : String(item?.text || '').trim();
      if (!text) continue;
      const decorated = decorateActivityText(text);
      const lastItem = activityBox.lastElementChild?.textContent || '';
      if (lastItem === decorated) continue;
      const row = document.createElement('div');
      row.className = 'subagent-activity-item';
      row.textContent = decorated;
      activityBox.appendChild(row);
    }
  }
  if (entry?.streamText) {
    renderSubagentStream(id, entry.streamText);
  }
  refreshSubagentSummary(bubble);

  return bubble;
}

/** Bring the folded header's line up to date with what the bubble holds. */
function refreshSubagentSummary(bubble) {
  const summary = bubble?.querySelector(':scope > .subagent-bubble-header > .subagent-bubble-summary');
  if (!summary) return;
  const text = subagentFoldSummary({
    activities: Array.from(bubble.querySelectorAll(':scope > .subagent-activity > .subagent-activity-item'), (row) => row.textContent || ''),
    streamText: bubble.querySelector(':scope > .subagent-stream')?.textContent || '',
  });
  if (summary.textContent !== text) summary.textContent = text;
}

function updateSubagentBubbleStatus(bubble, status) {
  if (!bubble) return;
  const statusSpan = bubble.querySelector('.subagent-bubble-status');
  if (!statusSpan) return;
  const normalized = normalizeSubagentBubbleStatus(status);
  statusSpan.dataset.status = normalized;
  statusSpan.textContent = normalized === 'running' ? '● Running' : normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

// What the user chose by hand for a live subagent bubble ('open' | 'folded'),
// by run id. Kept outside the DOM: the live bubble is rebuilt on a
// conversation switch and on reload-restore, and the choice must survive it.
const subagentFoldChoices = new Map();
const MAX_SUBAGENT_FOLD_CHOICES = 500;

/** Show a live subagent bubble folded or open (see subagent-fold.mjs). */
function applySubagentFold(subagentRunId) {
  const id = String(subagentRunId || '').trim();
  if (!id) return;
  const bubble = document.querySelector(`.subagent-bubble[data-subagent-run-id="${CSS.escape(id)}"]`);
  if (!bubble) return;
  const folded = resolveSubagentFold({ choice: subagentFoldChoices.get(id) || null });
  bubble.classList.toggle('folded', folded);
  const header = bubble.querySelector(':scope > .subagent-bubble-header');
  if (header) {
    header.setAttribute('aria-expanded', folded ? 'false' : 'true');
    header.title = folded ? 'Show what this subagent did' : 'Fold this subagent';
  }
}

function toggleSubagentFold(subagentRunId) {
  const id = String(subagentRunId || '').trim();
  const bubble = id ? document.querySelector(`.subagent-bubble[data-subagent-run-id="${CSS.escape(id)}"]`) : null;
  if (!bubble) return;
  while (subagentFoldChoices.size >= MAX_SUBAGENT_FOLD_CHOICES) {
    subagentFoldChoices.delete(subagentFoldChoices.keys().next().value);
  }
  subagentFoldChoices.set(id, toggledSubagentFoldChoice(bubble.classList.contains('folded')));
  applySubagentFold(id);
}

const subagentStopUnsupported = new Set();

/** The provider answered "not supported": the control must not re-arm. */
export function markSubagentStopUnsupported(subagentRunId) {
  const id = String(subagentRunId || '').trim();
  if (!id) return;
  subagentStopUnsupported.add(id);
  updateSubagentStopButton(id, false);
}

function updateSubagentStopButton(subagentRunId, isStopping = false, statusOverride = null) {
  const id = String(subagentRunId || '').trim();
  if (!id) return;
  const btn = document.querySelector(`.subagent-stop-btn[data-action="stop-subagent"][data-subagent-run-id="${CSS.escape(id)}"]`);
  if (!btn) return;
  if (IS_SHARED_VIEW) {
    btn.hidden = true;
    btn.disabled = true;
    return;
  }
  const status = normalizeSubagentBubbleStatus(statusOverride || getSubagentStatus(id));
  const terminal = isSubagentTerminalStatus(status);
  // Nothing is left to stop once the run has ended; a disabled button there
  // only took the room the name needs.
  btn.hidden = terminal;
  if (subagentStopUnsupported.has(id)) {
    btn.disabled = true;
    btn.textContent = 'Stop unavailable';
    btn.title = 'Targeted subagent stop is not supported by this provider; use Stop on the whole turn.';
    btn.classList.remove('stopping');
    return;
  }
  const stopping = !!isStopping;
  btn.disabled = terminal || stopping;
  btn.textContent = stopping ? 'Stopping…' : 'Stop';
  btn.classList.toggle('stopping', stopping);
}

export function updateSubagentBubbleFromStatus(subagentRunId, status) {
  const id = String(subagentRunId || '').trim();
  if (!id) return;
  ensureSubagentBubble(id);
  const bubble = document.querySelector(`.subagent-bubble[data-subagent-run-id="${CSS.escape(id)}"]`);
  if (bubble) {
    updateSubagentBubbleStatus(bubble, status);
  }
  if (isSubagentTerminalStatus(status)) {
    clearSubagentCancelInFlight(id);
  }
  updateSubagentStopButton(id, isSubagentCancelInFlight(id), status);
  applySubagentFold(id);
}

function renderSubagentBubbleRecursive(entry) {
  if (!entry?.subagentRunId) return;
  ensureSubagentBubble(entry.subagentRunId);
  const children = getChildSubagentRuns(entry.subagentRunId);
  for (const child of children) {
    renderSubagentBubbleRecursive(child);
  }
}

export function renderRestoredSubagentBubbles(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  const rootRuns = getRootSubagentRunsByMessage(id);
  for (const entry of rootRuns) {
    renderSubagentBubbleRecursive(entry);
  }
}

function thoughtSummaryText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return 'Thinking…';
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}

export function setLiveThinkingThoughtState(row, done = false) {
  if (!row) return;
  row.dataset.done = done ? '1' : '0';
  // The temporary panel represents an active turn, so every thought remains visible
  // until the completed assistant message replaces it with collapsed history.
  row.open = true;
}

export function appendThinkingThought(reasoningId, text, done = false, subagentRunId = null, autoScroll = true) {
  const key = String(reasoningId || 'reasoning');
  const value = String(text || '');

  if (subagentRunId) {
    const subagentBubble = ensureSubagentBubble(subagentRunId);
    if (subagentBubble) {
      let thoughtsBox = subagentBubble.querySelector('.subagent-thoughts');
      if (!thoughtsBox) {
        thoughtsBox = document.createElement('div');
        thoughtsBox.className = 'subagent-thoughts';
        const activityBox = subagentBubble.querySelector('.subagent-activity');
        if (activityBox) subagentBubble.insertBefore(thoughtsBox, activityBox);
        else subagentBubble.appendChild(thoughtsBox);
      }
      let row = thoughtsBox.querySelector(`.thinking-thought[data-reasoning-id="${CSS.escape(key)}"]`);
      if (!row) {
        row = document.createElement('details');
        row.className = 'thinking-thought';
        row.open = !done;
        row.dataset.reasoningId = key;
        row.dataset.subagentRunId = subagentRunId;
        const summary = document.createElement('summary');
        const body = document.createElement('div');
        body.className = 'thinking-thought-body';
        row.appendChild(summary);
        row.appendChild(body);
        thoughtsBox.appendChild(row);
      }
      const summaryEl = row.querySelector('summary');
      const bodyEl = row.querySelector('.thinking-thought-body');
      if (summaryEl) summaryEl.textContent = `💭 ${thoughtSummaryText(value)}`;
      renderThoughtBody(bodyEl, value);
      setLiveThinkingThoughtState(row, done);
      if (autoScroll) scrollBottom();
    }
    // Keep subagent thoughts out of the parent panel; the store replays them
    // once the bubble exists.
    return;
  }

  const box = document.querySelector('#thinking-thoughts > .thinking-thoughts-list');
  if (!box) return;
  let row = box.querySelector(`.thinking-thought[data-reasoning-id="${CSS.escape(key)}"]`);
  if (!row) {
    row = document.createElement('details');
    row.className = 'thinking-thought';
    row.open = !done;
    row.dataset.reasoningId = key;
    if (subagentRunId) row.dataset.subagentRunId = subagentRunId;
    const summary = document.createElement('summary');
    const body = document.createElement('div');
    body.className = 'thinking-thought-body';
    row.appendChild(summary);
    row.appendChild(body);
    box.appendChild(row);
  }
  const summaryEl = row.querySelector('summary');
  const bodyEl = row.querySelector('.thinking-thought-body');
  if (summaryEl) summaryEl.textContent = `💭 ${thoughtSummaryText(value)}`;
  renderThoughtBody(bodyEl, value);
  setLiveThinkingThoughtState(row, done);
  if (autoScroll) scrollBottom();
}

export function renderThinkingThoughts() {
  const box = document.querySelector('#thinking-thoughts > .thinking-thoughts-list');
  if (!box) return;
  const thoughtMap = thinkingMessageId ? relayThoughts.get(thinkingMessageId) : null;
  if (!thoughtMap || !thoughtMap.size) return;
  for (const entry of thoughtMap.values()) {
    appendThinkingThought(entry.reasoningId, entry.text, entry.done, entry.subagentRunId || null, false);
  }
}

export function updateThinkingStreamStatus(messageId = null, done = false, autoScroll = true) {
  if (messageId) {
    if (thinkingMessageId && thinkingMessageId !== messageId) return;
    thinkingMessageId = messageId;
  }
  if (!document.getElementById('thinking-indicator')) {
    if (done) return;
    showThinking(thinkingMessageId, autoScroll);
  }
  if (done) {
    const dots = document.querySelector('#thinking-indicator .dots');
    if (dots) dots.style.display = 'none';
  }
  if (autoScroll) scrollBottom();
}

export function applyRelayStreamEvent({
  messageId,
  text,
  done = false,
  seq = null,
  subagentRunId = null,
  autoScroll = true,
} = {}) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  if (completedMessageIds.has(id)) return false;
  const previous = relayStreamStateByMessageId.get(id) || { seq: 0, done: false };
  const transition = computeNextRelayStreamState(previous, { seq, done });
  if (!transition.accept) return false;
  rememberRelayStreamState(id, transition.state.seq, transition.state.done);
  if (isOpaqueRelayText(text)) return true;
  const runId = String(subagentRunId || '').trim();
  if (runId) {
    // Subagent text belongs to its own bubble; the store keeps it so the bubble
    // can replay it if it is built after this frame arrived.
    setSubagentStreamText(runId, text);
  } else {
    relayStreamTextByMessageId.set(id, String(text || ''));
  }
  // Runs before rendering: it creates the thinking bubble when one is missing,
  // and adopts `messageId` as the active thinking message.
  updateThinkingStreamStatus(id, !!done, autoScroll);
  if (id !== thinkingMessageId) return true;
  if (runId) renderSubagentStream(runId, text);
  else renderThinkingStream();
  // Again once the text is in: it grew below the end the status scrolled to.
  if (autoScroll && !getThinkingFollowMode()) scrollBottom();
  return true;
}

export function flushDeferredMessageRender() {
  if (!deferredMessageRender) return;
  const { msgs, meta } = deferredMessageRender;
  deferredMessageRender = null;
  const deferredConversationId = String(meta?.conversationId || '').trim();
  if (deferredConversationId && deferredConversationId !== String(currentConvId || '').trim()) return;
  // Whoever asked for this render has long returned, and with it whatever
  // would have put the reader back; and where the reader was when it was
  // held back is not where they are now. Decided as it runs: at the end it
  // follows, anywhere else it leaves them at the text they read.
  if (followsTranscriptEnd()) renderMessages(msgs, true, meta);
  else renderMessagesInPlace(msgs, meta);
}

// Blacklists the id from further live relay_stream frames. Kept separate from
// the state clearing so mid-flow statuses ('pending'/'parked') can reset the
// bookkeeping without muting the rest of the turn.
export function markRelayStreamComplete(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  completedMessageIds.add(id);
  if (completedMessageIds.size > 100) {
    completedMessageIds.delete(completedMessageIds.values().next().value);
  }
}

export function clearRelayStreamStateForMessage(messageId) {
  markRelayStreamComplete(messageId);
  clearRelayStreamState(messageId);
}

export function applyConversationTurnStatus({ conversationId, messageId, status }) {
  const conversationKey = String(conversationId || '').trim();
  const messageKey = String(messageId || '').trim();
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (['cancelled', 'failed'].includes(normalizedStatus)) releaseStoppedSteerResendsOf(messageKey);
  if (!conversationKey) {
    syncSendButtonState();
    return;
  }
  if (normalizedStatus === 'processing' && messageKey) {
    const previous = getActiveTurnForConversation(conversationKey);
    setConversationTurnState(conversationKey, {
      messageId: messageKey,
      status: normalizedStatus,
      cancelRequested: previous?.messageId === messageKey ? previous.cancelRequested === true : false,
    });
    return;
  }
  if (['done', 'failed', 'dropped', 'pending', 'parked', 'cancelled'].includes(normalizedStatus)) {
    const previous = getActiveTurnForConversation(conversationKey);
    if (!previous || !messageKey || previous.messageId === messageKey) {
      setConversationTurnState(conversationKey, null);
      return;
    }
  }
  syncSendButtonState();
}

// Stopping a turn lives on the message bubbles only (the live turn's Stop and
// pending rows' Cancel). The composer's send button never doubles as Stop —
// the old stopCurrentConversationTurn composer path is gone with it.
async function stopTurnByMessageId(conversationId, messageId) {
  const conversationKey = String(conversationId || '').trim();
  const targetMessageId = String(messageId || '').trim();
  if (!conversationKey || !targetMessageId) return;
  if (bubbleCancelInFlight.has(targetMessageId)) return;

  bubbleCancelInFlight.add(targetMessageId);
  updateBubbleStopButton(targetMessageId, true);

  const activeTurn = getActiveTurnForConversation(conversationKey);
  if (activeTurn?.messageId === targetMessageId) {
    setConversationTurnState(conversationKey, {
      messageId: targetMessageId,
      status: activeTurn.status || 'processing',
      cancelRequested: true,
    });
  }

  const result = await cancelConversationTurn(conversationKey, {
    clientId: CLIENT_ID,
    messageId: targetMessageId,
  });

  if (!result?.ok) {
    bubbleCancelInFlight.delete(targetMessageId);
    updateBubbleStopButton(targetMessageId, false);
    if (activeTurn?.messageId === targetMessageId) {
      setConversationTurnState(conversationKey, {
        messageId: targetMessageId,
        status: activeTurn.status || 'processing',
        cancelRequested: false,
      });
    }
    showTransientRelayNotice('Could not stop the turn.');
    return;
  }

  if (
    result.acknowledgement === 'already-finished'
    || result.acknowledgement === 'no-active-turn'
    || result.acknowledgement === 'message-mismatch'
  ) {
    bubbleCancelInFlight.delete(targetMessageId);
    const latestTurn = getActiveTurnForConversation(conversationKey);
    if (latestTurn?.messageId === targetMessageId) {
      setConversationTurnState(conversationKey, null);
    }
    showTransientRelayNotice('That turn already finished.');
    return;
  }

  if (result.acknowledgement === 'active-turn-unbound') {
    bubbleCancelInFlight.delete(targetMessageId);
    updateBubbleStopButton(targetMessageId, false);
    const latestTurn = getActiveTurnForConversation(conversationKey);
    if (latestTurn?.messageId === targetMessageId) {
      setConversationTurnState(conversationKey, {
        messageId: targetMessageId,
        status: activeTurn?.status || 'processing',
        cancelRequested: false,
      });
    }
    showTransientRelayNotice('The turn is not bound to a live SDK session.');
    return;
  }

  showTransientRelayNotice('Stopping the turn…');
}

function updateBubbleStopButton(messageId, isStopping) {
  const btn = document.querySelector(`.bubble-action-btn[data-message-id="${messageId}"][data-action="stop-turn"]`);
  if (!btn) return;
  btn.disabled = isStopping;
  btn.textContent = isStopping ? 'Stopping…' : 'Stop';
  btn.classList.toggle('stopping', isStopping);
}

// The Cancel control of a user bubble: a pending row's, or a pushed row's the
// worker can still pull back (both post cancel-queued-turn).
function buildUserBubbleCancelActionsMarkup(messageId, isCancelling) {
  return `<div class="msg-bubble-actions"><button type="button" class="bubble-action-btn${isCancelling ? ' stopping' : ''}" data-action="cancel-queued" data-message-id="${escHtml(messageId)}"${isCancelling ? ' disabled' : ''}>${isCancelling ? 'Cancelling…' : 'Cancel'}</button></div>`;
}

function updateUserBubbleCancelButton(messageId, isCancelling) {
  const btn = document.querySelector(`.bubble-action-btn[data-message-id="${messageId}"][data-action="cancel-queued"]`);
  if (!btn) return;
  btn.disabled = isCancelling;
  btn.textContent = isCancelling ? 'Cancelling…' : 'Cancel';
  btn.classList.toggle('stopping', isCancelling);
}

export function removeUserBubbleCancelButton(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  const actionsContainer = document.querySelector(`.msg.user[data-message-id="${id}"] .msg-bubble-actions`);
  if (actionsContainer) actionsContainer.remove();
}

function clearUnsteerFallbackTimer(messageId) {
  const timer = unsteerFallbackTimers.get(messageId);
  if (timer === undefined) return;
  clearTimeout(timer);
  unsteerFallbackTimers.delete(messageId);
}

export function clearBubbleCancelState(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  bubbleCancelInFlight.delete(id);
  clearUnsteerFallbackTimer(id);
}

// Keeps the Cancel controls of the viewed conversation's pushed rows in step
// with what its worker reports as still un-steerable. Bubbles are built once
// (renderMessages skips unchanged payloads), and the worker's set changes on
// its own clock (the heartbeat), so the status refresh calls this next to the
// composer sync. Pending rows own their Cancel and are left alone; a row whose
// un-steer is still being acknowledged keeps its "Cancelling…" until the
// answer or the fallback arrives.
export function syncCancellableSteerButtons() {
  const el = getMessagesElement();
  if (!el || IS_SHARED_VIEW) return;
  const cancellableIds = cancellableSteerIdsForConversation(currentConvId);
  for (const rowNode of el.querySelectorAll('.msg.user[data-message-id]')) {
    const messageId = String(rowNode.dataset.messageId || '').trim();
    if (!messageId || pendingUserMessageIds.has(messageId)) continue;
    const button = rowNode.querySelector('.msg-bubble-actions [data-action="cancel-queued"]');
    if (cancellableIds.has(messageId)) {
      if (button) continue;
      const bubble = rowNode.querySelector('.msg-bubble');
      if (!bubble) continue;
      bubble.insertAdjacentHTML('beforeend', buildUserBubbleCancelActionsMarkup(messageId, bubbleCancelInFlight.has(messageId)));
      continue;
    }
    if (button && !bubbleCancelInFlight.has(messageId)) button.closest('.msg-bubble-actions')?.remove();
  }
}

// The relay forwarded an un-steer to the worker ('cancel-requested'): the row
// settles through the socket (message_status 'cancelled' removes the control;
// an answer after all re-renders it away). If neither lands, hand the control
// back — as "Cancel" when the worker still lists the row, gone otherwise.
function armUnsteerFallback(messageId) {
  clearUnsteerFallbackTimer(messageId);
  const timer = setTimeout(() => {
    unsteerFallbackTimers.delete(messageId);
    bubbleCancelInFlight.delete(messageId);
    if (cancellableSteerIdsForConversation(currentConvId).has(messageId)) {
      updateUserBubbleCancelButton(messageId, false);
    } else {
      removeUserBubbleCancelButton(messageId);
    }
  }, UNSTEER_ACK_FALLBACK_MS);
  timer?.unref?.();
  unsteerFallbackTimers.set(messageId, timer);
}

// Resend of a steer the user's Stop cut off unanswered (kind='stopped').
// Keyed by the marker row: one Resend per marker per page life — a second tap
// while the first is in flight, or after it landed, does nothing. The relay's
// duplicate guard backs this across reloads (a second Resend of the same text
// collides with the first).
const stoppedSteerResends = new Map();
const RESEND_PAYLOAD_KEY = '__relayResendPayload';

// Only uploads (by sha256) can be re-referenced; anything else — a legacy
// inline image — is counted so the user is told it was left out.
function attachmentReferencesForResend(attachments) {
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const references = list
    .map((attachment) => {
      const sha256 = String(attachment?.sha256 || '').trim().toLowerCase();
      if (!sha256) return null;
      return {
        sha256,
        name: String(attachment?.name || '').trim() || undefined,
        type: String(attachment?.type || '').trim() || undefined,
      };
    })
    .filter(Boolean);
  return { references, unavailable: list.length - references.length };
}

// The user message a stopped marker settles. By its source id whenever the
// marker names one — if that row is not loaded (a page boundary) there is no
// guessing, since the nearest user row above may be another stopped steer.
// Only a marker without a source falls back to the user row right above it.
function findStoppedSteerSource(markerNode) {
  const el = getMessagesElement();
  if (!el || !markerNode) return null;
  const sourceId = String(markerNode.dataset.sourceMessageId || '').trim();
  if (sourceId) {
    return el.querySelector(`.msg.user[data-message-id="${CSS.escape(sourceId)}"]`) || null;
  }
  for (let prev = markerNode.previousElementSibling; prev; prev = prev.previousElementSibling) {
    if (prev.classList?.contains(SEPARATOR_CLASS)) return null;
    if (prev.classList?.contains('msg') && prev.classList.contains('user')) return prev;
  }
  return null;
}

function syncStoppedSteerResendButton(markerId) {
  const btn = document.querySelector(`.bubble-action-btn[data-message-id="${CSS.escape(markerId)}"][data-action="resend-stopped-steer"]`);
  if (!btn) return;
  const state = stoppedSteerResends.get(markerId);
  btn.disabled = !!state;
  btn.textContent = state?.status === 'sent' ? 'Resent' : (state ? 'Resending…' : 'Resend');
}

// The Resend a marker's "Resent" rests on was cancelled or failed: the
// original may be resent again, as the relay agrees.
function releaseStoppedSteerResendsOf(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  for (const [markerId, entry] of stoppedSteerResends) {
    if (entry?.status !== 'sent' || entry.resentId !== id) continue;
    stoppedSteerResends.delete(markerId);
    syncStoppedSteerResendButton(markerId);
  }
}

// Retry on the worker-launch note: ask the relay for a launch now. The relay
// rewrites the note itself — the worker started, or the launches are
// exhausted again — so the button only has to report a refused request.
async function retryWorkerLaunch(conversationId, noteId) {
  const conversationKey = String(conversationId || '').trim();
  const id = String(noteId || '').trim();
  if (!conversationKey || !id) return;
  const btn = document.querySelector(`.bubble-action-btn[data-message-id="${CSS.escape(id)}"][data-action="retry-worker-launch"]`);
  if (btn?.disabled) return;
  const sdkSessionId = String(conversations[conversationKey]?.sdkSessionId || '').trim();
  if (!sdkSessionId) {
    showTransientRelayNotice('This conversation has no session to start a worker for.');
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
  }
  try {
    // apiFetch answers null for a refused request (the route says 409 with
    // the reason) as for a network failure: both re-arm the button.
    const result = await launchSessionWorker(sdkSessionId);
    if (!result || result.ok === false) throw new Error(String(result?.error || 'the relay refused the launch'));
  } catch (error) {
    showTransientRelayNotice(`The worker could not be started: ${error?.message || error}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Retry';
    }
  }
}

// A message the relay rewrote in place (the worker-launch note): the bubble is
// rebuilt where it stands, so the transcript keeps its order. False when the
// message is not on the page.
export function replaceRenderedMessage(msg, msgId) {
  const el = getMessagesElement();
  const id = String(msgId || '').trim();
  if (!el || !id) return false;
  const existing = el.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!existing) return false;
  const placeholder = document.createComment('replacing');
  existing.replaceWith(placeholder);
  seenMessageIds.delete(id);
  const fresh = createMessageNode(msg, id, true);
  placeholder.replaceWith(fresh || existing);
  // The rebuilt row takes its merge and fold classes back.
  if (fresh) syncSeparatorsNow();
  return Boolean(fresh);
}

async function resendStoppedSteer(conversationId, markerId) {
  const send = beginOwnSend();
  const conversationKey = String(conversationId || '').trim();
  const id = String(markerId || '').trim();
  if (!conversationKey || !id || stoppedSteerResends.has(id)) return;
  const markerNode = getMessagesElement()?.querySelector(`.msg.assistant[data-message-id="${CSS.escape(id)}"]`);
  const sourceNode = findStoppedSteerSource(markerNode);
  const payload = sourceNode?.[RESEND_PAYLOAD_KEY] || null;
  const text = String(payload?.text || '').trim();
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  if (!payload) {
    showTransientRelayNotice('The original message is not loaded — scroll up to it, then try Resend again.');
    return;
  }
  if (!text && !attachments.length) {
    showTransientRelayNotice('Nothing left to resend: the original message\'s attachments are no longer available.');
    return;
  }
  // Claimed before the first await: this is what makes a double tap a no-op.
  stoppedSteerResends.set(id, { status: 'sending' });
  syncStoppedSteerResendButton(id);
  const clientMessageId = generateId();
  let sent = false;
  // The message that now stands as this marker's Resend: a cancel or failure
  // of it releases the page's "Resent" (releaseStoppedSteerResendsOf).
  let resentId = clientMessageId;
  let bubbleAppended = false;
  const dropOptimisticBubble = () => {
    clearPendingUserMessage(clientMessageId);
    pendingUserMessageIds.delete(clientMessageId);
    seenMessageIds.delete(clientMessageId);
    if (bubbleAppended) document.querySelector(`.msg[data-message-id="${CSS.escape(clientMessageId)}"]`)?.remove();
  };
  try {
    if (!(await validateSelectedConversationBeforeSend(conversationKey))) return;
    const selectedModel = document.getElementById('model-select')?.value || '';
    const selectedReasoningEffort = String(document.getElementById('reasoning-effort-select')?.value || '').trim().toLowerCase();
    const selectedContextTier = String(document.getElementById('context-tier-select')?.value || 'default').trim();
    const selectedMode = document.getElementById('mode-select')?.value || 'agent';
    if (!selectedReasoningEffort) {
      showTransientRelayNotice('Select a reasoning effort after refreshing model metadata.');
      return;
    }
    // As a send from the composer (loadEndForOwnSend): the Resend goes to
    // the end.
    if (isCurrentConversation(conversationKey)) await loadEndForOwnSend();
    trackPendingUserMessage(clientMessageId, conversationKey, text, { attachments });
    pendingUserMessageIds.add(clientMessageId);
    if (isCurrentConversation(conversationKey) && isConversationWindowAtTail()) {
      appendMessage({
        role: 'user',
        text,
        model: selectedModel,
        mode: selectedMode,
        timestamp: new Date().toISOString(),
        attachments,
      }, ownSendFollows(send), clientMessageId, true);
      bubbleAppended = true;
    }
    const r = await sendMessageApi({
      messageId: clientMessageId,
      clientId: CLIENT_ID,
      text,
      model: selectedModel,
      reasoningEffort: selectedReasoningEffort,
      contextTier: selectedContextTier,
      relayMode: selectedMode,
      conversationId: conversationKey,
      attachments,
      resendOfMessageId: String(sourceNode?.dataset?.messageId || '').trim() || undefined,
    });
    if (!r) {
      if (!hasSendEchoArrived(clientMessageId)) {
        dropOptimisticBubble();
        showTransientRelayNotice('Could not resend the message. Please try again.');
        return;
      }
      sent = true;
      return;
    }
    if (r.duplicate) {
      dropOptimisticBubble();
      if (r.alreadyResent) {
        // Resent before (another tab or device): nothing to retry.
        sent = true;
        resentId = String(r.duplicateOfMessageId || '').trim() || null;
        showTransientRelayNotice('That message was already resent.');
        return;
      }
      // Another recent message has the same text — not a Resend of this one,
      // so the button stays available.
      showTransientRelayNotice('A message with the same text was sent in the last few minutes, so this one was not resent. Try again later.');
      return;
    }
    sent = true;
    const dropped = Number(payload.unavailableAttachments || 0) + Math.max(0, Number(r.droppedAttachmentCount) || 0);
    if (dropped > 0) {
      showTransientRelayNotice(`Resent without ${dropped} attachment${dropped === 1 ? '' : 's'} that ${dropped === 1 ? 'is' : 'are'} no longer available.`, 7000);
    }
    if (cliOnline && isCurrentConversation(conversationKey) && !getActiveTurnForConversation(conversationKey)?.messageId) {
      showThinking(r.messageId || null, ownSendFollows(send));
    }
  } catch (error) {
    if (!hasSendEchoArrived(clientMessageId)) {
      dropOptimisticBubble();
      showTransientRelayNotice(error?.message || 'Could not resend the message.');
    } else {
      sent = true;
    }
  } finally {
    if (sent) stoppedSteerResends.set(id, { status: 'sent', resentId });
    else stoppedSteerResends.delete(id);
    syncStoppedSteerResendButton(id);
  }
}

async function cancelQueuedTurnByMessageId(conversationId, messageId) {
  const conversationKey = String(conversationId || '').trim();
  const targetMessageId = String(messageId || '').trim();
  if (!conversationKey || !targetMessageId) return;
  if (bubbleCancelInFlight.has(targetMessageId)) return;

  bubbleCancelInFlight.add(targetMessageId);
  updateUserBubbleCancelButton(targetMessageId, true);

  const result = await cancelQueuedConversationTurn(conversationKey, {
    clientId: CLIENT_ID,
    messageId: targetMessageId,
  });

  if (!result?.ok) {
    bubbleCancelInFlight.delete(targetMessageId);
    updateUserBubbleCancelButton(targetMessageId, false);
    showTransientRelayNotice('Could not cancel the queued message.');
    return;
  }

  if (result.acknowledgement === 'not-found' || result.acknowledgement === 'conversation-mismatch') {
    bubbleCancelInFlight.delete(targetMessageId);
    removeUserBubbleCancelButton(targetMessageId);
    showTransientRelayNotice('Message not found in queue.');
    return;
  }

  if (result.acknowledgement === 'cancel-requested') {
    // The worker pulls the row out of its runtime and settles it through
    // POST /api/queue-cancelled → message_status 'cancelled'. Keep the
    // bubble in "Cancelling…" until then (or until the fallback hands it back).
    armUnsteerFallback(targetMessageId);
    return;
  }

  if (result.acknowledgement === 'already-processing') {
    bubbleCancelInFlight.delete(targetMessageId);
    removeUserBubbleCancelButton(targetMessageId);
    showTransientRelayNotice('Message is already being processed. Use Stop on the thinking bubble instead.');
    return;
  }

  if (result.acknowledgement === 'already-finished') {
    bubbleCancelInFlight.delete(targetMessageId);
    removeUserBubbleCancelButton(targetMessageId);
    showTransientRelayNotice('Message already finished.');
    return;
  }

  if (result.acknowledgement === 'cancelled') {
    bubbleCancelInFlight.delete(targetMessageId);
    removeUserBubbleCancelButton(targetMessageId);
    showTransientRelayNotice('Queued message cancelled.');
    return;
  }

  bubbleCancelInFlight.delete(targetMessageId);
  updateUserBubbleCancelButton(targetMessageId, false);
}

async function cancelSubagentByRunId(conversationId, subagentRunId) {
  const conversationKey = String(conversationId || '').trim();
  const targetSubagentRunId = String(subagentRunId || '').trim();
  if (!conversationKey || !targetSubagentRunId) return;
  if (isSubagentCancelInFlight(targetSubagentRunId)) return;

  markSubagentCancelInFlight(targetSubagentRunId);
  updateSubagentStopButton(targetSubagentRunId, true);

  const runEntry = getSubagentRun(targetSubagentRunId);
  const parentMessageId = String(runEntry?.messageId || '').trim() || null;
  const result = await cancelSubagentRun(conversationKey, targetSubagentRunId, {
    clientId: CLIENT_ID,
    parentMessageId,
  });

  if (!result?.ok) {
    clearSubagentCancelInFlight(targetSubagentRunId);
    updateSubagentStopButton(targetSubagentRunId, false);
    showTransientRelayNotice('Could not stop that subagent.');
    return;
  }

  if (result.acknowledgement === 'already-finished') {
    clearSubagentCancelInFlight(targetSubagentRunId);
    updateSubagentStopButton(targetSubagentRunId, false);
    showTransientRelayNotice('That subagent already finished.');
    return;
  }

  if (result.acknowledgement === 'already-cancelled') {
    clearSubagentCancelInFlight(targetSubagentRunId);
    updateSubagentBubbleFromStatus(targetSubagentRunId, 'cancelled');
    showTransientRelayNotice('That subagent is already cancelled.');
    return;
  }

  if (result.acknowledgement === 'not-found') {
    clearSubagentCancelInFlight(targetSubagentRunId);
    updateSubagentStopButton(targetSubagentRunId, false);
    showTransientRelayNotice('Subagent run not found.');
    return;
  }

  if (result.acknowledgement === 'message-mismatch') {
    clearSubagentCancelInFlight(targetSubagentRunId);
    updateSubagentStopButton(targetSubagentRunId, false);
    showTransientRelayNotice('Could not stop subagent due to message mismatch.');
    return;
  }

  if (result.acknowledgement === 'cancelled') {
    showTransientRelayNotice('Stopping subagent…');
    return;
  }

  clearSubagentCancelInFlight(targetSubagentRunId);
  updateSubagentStopButton(targetSubagentRunId, false);
}

const PINNED_LABEL_HTML = '<span class="msg-pinned-label">📍 Pinned</span>';

function pinButtonTitle(pinned) {
  return pinned ? 'Removes this message from the pinned list' : 'Adds this message to the pinned list';
}

// The pin half of a bubble's corner row. No whitespace between label and
// button: syncRenderedPinState finds the label as the button's sibling.
function buildMessagePinControlsHtml(msgId, pinned) {
  return `${pinned ? PINNED_LABEL_HTML : ''}<button type="button" class="msg-pin-btn" data-action="toggle-pin" data-message-id="${escHtml(msgId)}" data-pinned="${pinned ? 'true' : 'false'}" title="${pinButtonTitle(pinned)}">${pinned ? 'Unpin' : 'Pin'}</button>`;
}

// The pin list changed (this page, another device): bring the bubbles on the
// page in line without rebuilding them.
export function syncRenderedPinState(pinnedIds) {
  const el = getMessagesElement();
  if (!el) return;
  const ids = pinnedIds instanceof Set ? pinnedIds : new Set(pinnedIds || []);
  for (const button of el.querySelectorAll('.msg-pin-btn')) {
    const pinned = ids.has(String(button.dataset.messageId || '').trim());
    if ((button.dataset.pinned === 'true') === pinned) continue;
    button.dataset.pinned = pinned ? 'true' : 'false';
    button.disabled = false;
    button.textContent = pinned ? 'Unpin' : 'Pin';
    button.title = pinButtonTitle(pinned);
    const sibling = button.previousElementSibling;
    const label = sibling?.classList?.contains('msg-pinned-label') ? sibling : null;
    if (pinned && !label) button.insertAdjacentHTML('beforebegin', PINNED_LABEL_HTML);
    if (!pinned && label) label.remove();
  }
}

const HIDDEN_LABEL_HTML = '<span class="msg-hidden-label">Hidden from shared viewers</span>';

function shareVisibilityButtonTitle(hidden) {
  return hidden ? 'Shows this message in shared conversations' : 'Hides this message from shared conversations';
}

// The hidden list changed (this page, another device): bring the bubbles on
// the page in line without rebuilding them. A button whose own round trip is
// still out keeps its "Hiding…" until the answer.
export function syncRenderedShareVisibility(hiddenIds) {
  const el = getMessagesElement();
  if (!el) return;
  const ids = hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds || []);
  for (const button of el.querySelectorAll('.msg-share-visibility-btn')) {
    const messageId = String(button.dataset.messageId || '').trim();
    if (shareVisibilityInFlight.has(messageId)) continue;
    const hidden = ids.has(messageId);
    if ((button.dataset.hiddenFromShares === 'true') === hidden) continue;
    button.dataset.hiddenFromShares = hidden ? 'true' : 'false';
    button.disabled = false;
    button.textContent = hidden ? 'Unhide' : 'Hide';
    button.title = shareVisibilityButtonTitle(hidden);
    const sibling = button.previousElementSibling;
    const label = sibling?.classList?.contains('msg-hidden-label') ? sibling : null;
    if (hidden && !label) button.insertAdjacentHTML('beforebegin', HIDDEN_LABEL_HTML);
    if (!hidden && label) label.remove();
  }
}

async function toggleMessageShareVisibility(conversationId, messageId, hiddenFromShares) {
  const conversationKey = String(conversationId || '').trim();
  const targetMessageId = String(messageId || '').trim();
  if (!conversationKey || !targetMessageId || shareVisibilityInFlight.has(targetMessageId)) return;

  shareVisibilityInFlight.add(targetMessageId);
  const button = document.querySelector(`.msg-share-visibility-btn[data-message-id="${CSS.escape(targetMessageId)}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = hiddenFromShares ? 'Unhiding…' : 'Hiding…';
  }
  const result = await updateMessageShareVisibility(conversationKey, targetMessageId, !hiddenFromShares);
  shareVisibilityInFlight.delete(targetMessageId);
  if (!result?.ok) {
    if (button) {
      button.disabled = false;
      button.textContent = hiddenFromShares ? 'Unhide' : 'Hide';
    }
    showTransientRelayNotice(String(result?.error || '').trim() || 'Could not update shared-message visibility.');
    return;
  }

  showTransientRelayNotice(result.hiddenFromShares
    ? 'Message hidden from shared viewers.'
    : 'Message visible to shared viewers.');
  // Stored under its own conversation: the 🙈 count, even after a switch.
  if ('hiddenMessages' in result) {
    setConversationHiddenMessages(conversationKey, result.hiddenMessages, result.hiddenMessagesRevision);
  }
  // The reload below only refreshes the open view; if the user switched
  // conversations while the toggle round trip was in flight, rendering it
  // would replace the new conversation's messages with this one's.
  if (String(currentConvId || '').trim() !== conversationKey) return;
  const response = await loadConversationApi(conversationKey, {
    limit: Math.max(CONVERSATION_HISTORY_PAGE_SIZE, getConversationLoadedMessageCount()),
  });
  if (String(currentConvId || '').trim() !== conversationKey) return;
  if (response?.messages) {
    renderMessagesInPlace(response.messages, response);
  }
}

// Each CTA lands the user where the state actually lives: the provider panel
// shows the install log / the device code, so the settings modal is opened
// first and the action then runs on top of it.
function runRelayErrorCta(cta) {
  if (cta === 'install-grok-cli') {
    openSettingsModal('providers', 'grok');
    // The confirm sheet — never a bare curl | bash from a chat bubble.
    void confirmCliInstall('grok', 'install');
    return;
  }
  if (cta === 'sign-in-to-grok') {
    openSettingsModal('providers', 'grok');
    void startGrokSignIn();
    return;
  }
  if (cta === 'open-grok-settings') openSettingsModal('providers', 'grok');
  if (cta === 'open-claude-settings') openSettingsModal('providers', 'claude');
}

function handleBubbleActionClick(event) {
  const btn = event.target.closest('.bubble-action-btn, .msg-share-visibility-btn, .msg-pin-btn, .thinking-follow-btn, .subagent-bubble-header');
  if (!btn) return;
  const action = btn.dataset.action;
  const messageId = btn.dataset.messageId;
  const subagentRunId = btn.dataset.subagentRunId;

  if (action === 'relay-error-cta') {
    event.preventDefault();
    event.stopPropagation();
    runRelayErrorCta(String(btn.dataset.cta || ''));
  }

  if (action === 'toggle-share-visibility' && messageId) {
    event.preventDefault();
    event.stopPropagation();
    void toggleMessageShareVisibility(
      currentConvId,
      messageId,
      btn.dataset.hiddenFromShares === 'true',
    );
  }

  if (action === 'toggle-pin' && messageId) {
    event.preventDefault();
    event.stopPropagation();
    void toggleMessagePin(currentConvId, messageId, btn.dataset.pinned === 'true');
  }

  if (action === 'stop-turn' && messageId) {
    event.preventDefault();
    event.stopPropagation();
    openStopTurnConfirmation(currentConvId, messageId);
  }

  if (action === 'follow-thinking') {
    event.preventDefault();
    event.stopPropagation();
    const mode = toggleThinkingFollowMode(currentConvId, btn.dataset.follow);
    syncThinkingFollowButtons(document, mode);
    if (mode) applyThinkingFollow({ force: true });
  }

  if (action === 'cancel-queued' && messageId) {
    event.preventDefault();
    event.stopPropagation();
    void cancelQueuedTurnByMessageId(currentConvId, messageId);
  }

  if (action === 'resend-stopped-steer' && messageId) {
    event.preventDefault();
    event.stopPropagation();
    void resendStoppedSteer(currentConvId, messageId);
  }

  if (action === 'retry-worker-launch' && messageId) {
    event.preventDefault();
    event.stopPropagation();
    void retryWorkerLaunch(currentConvId, messageId);
  }

  if (action === 'stop-subagent' && subagentRunId) {
    event.preventDefault();
    event.stopPropagation();
    void cancelSubagentByRunId(currentConvId, subagentRunId);
  }

  if (action === 'toggle-subagent' && subagentRunId) {
    // A tap that ends a text selection inside the header is not a toggle.
    if (String(window.getSelection?.() || '').trim()) return;
    event.preventDefault();
    toggleSubagentFold(subagentRunId);
  }
}

// Enter and Space on a focused subagent header, like the click.
function handleBubbleActionKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const header = event.target.closest?.('.subagent-bubble-header');
  if (!header || event.target !== header) return;
  event.preventDefault();
  toggleSubagentFold(header.dataset.subagentRunId);
}

// A tap on a media attachment (its picture, chip or name) or on a picture
// embedded in a bubble opens it in the file viewer, together with the other
// media of the conversation to swipe through. Inline video/audio players in
// bubbles keep their native controls untouched.
function handleChatMediaClick(event) {
  const attachment = event.target.closest?.('.msg-attachment[data-media-url]');
  let node = null;
  if (attachment) {
    // The buttons under a generated image ("Edit this image") do their own work.
    if (event.target.closest?.('button')) return;
    if (!event.target.closest?.('img, .msg-attachment-video-chip, [data-media-open]')) return;
    node = attachment;
  } else {
    const img = event.target.closest?.('.msg-bubble img');
    if (!img || img.closest('.msg-attachment')) return;
    if (IS_SHARED_VIEW) return; // the file routes are cookie-authed; shared viewers would only see a failed load
    if (!String(img.getAttribute('src') || '').trim()) return;
    node = img;
  }
  event.preventDefault();
  event.stopPropagation();
  const options = { includeEmbedded: !IS_SHARED_VIEW, parseAppFileHref };
  const gallery = chatMediaGallery(getMessagesElement(), node, options);
  const item = gallery ? gallery.items[gallery.index] : chatMediaItemFromNode(node, options);
  void openGalleryItem(item, gallery);
}

// On a touch screen the corner row (Pin, Hide) is revealed by a tap on the
// bubble. The tap leaves an emulated :hover behind, which the CSS also honours,
// but Chromium drops that hover at the next scroll or layout change on some
// platforms (seen on Linux), and the row went back to `pointer-events: none`
// before it could be tapped. The class keeps the reveal until a tap lands
// outside the bubble. A pointer with hover keeps the hover reveal alone.
const REVEALED_BUBBLE_CLASS = 'msg-actions-revealed';
function handleBubbleTapReveal(event) {
  const bubble = event.target?.closest?.('.msg-bubble') || null;
  for (const revealed of document.querySelectorAll(`.msg-bubble.${REVEALED_BUBBLE_CLASS}`)) {
    if (revealed !== bubble) revealed.classList.remove(REVEALED_BUBBLE_CLASS);
  }
  if (!bubble || IS_SHARED_VIEW) return;
  if (!window.matchMedia?.('(hover: none)')?.matches) return;
  bubble.classList.add(REVEALED_BUBBLE_CLASS);
}

export function initBubbleActionHandlers() {
  const messagesEl = document.getElementById('messages');
  if (!messagesEl) return;
  messagesEl.addEventListener('click', handleBubbleActionClick);
  messagesEl.addEventListener('keydown', handleBubbleActionKeydown);
  messagesEl.addEventListener('click', handleChatMediaClick);
  // On the document: a tap outside the transcript clears the reveal too.
  document.addEventListener('click', handleBubbleTapReveal);
  initThinkingFollow({ getCurrentConversationId: () => currentConvId });
}

export function appendMessage(msg, scroll = true, msgId = null, force = false, insertAfterId = null, trackHistory = true) {
  const el = getMessagesElement();
  if (!el) return null;
  const empty = el.querySelector('.empty-state');
  if (empty) empty.remove();
  const node = createMessageNode(msg, msgId, force);
  const isNewNode = !!node && !node.parentNode;
  // A reply the socket delivers without its prompt's id in the message (a
  // failed turn's note) is placed under that prompt, and an agent prompt's
  // row reads its status from it.
  const exchangeRow = isNewNode ? node[AGENT_EXCHANGE_ROW_KEY] : null;
  const anchorId = String(insertAfterId || '').trim();
  if (exchangeRow?.role === 'assistant' && !exchangeRow.sourceMessageId && anchorId && anchorId !== String(msgId || '').trim()) {
    exchangeRow.sourceMessageId = anchorId;
  }
  // Insert without scrolling: the separator pass below can add a row above
  // this message, and scrolling before it runs leaves the viewport a
  // separator-height short of the bottom (which then reads as "not at
  // bottom" and suppresses auto-scroll for the next message too).
  // renderMessages orders it the same way.
  const insertedNode = insertMessageNode(node, insertAfterId);
  if (trackHistory && isNewNode && insertedNode) {
    const messageId = String(msgId || msg?.id || '').trim();
    const messageTimestamp = String(msg?.timestamp || '').trim();
    setConversationHistoryState({
      ...conversationHistoryState,
      newestMessageId: messageId || conversationHistoryState.newestMessageId,
      newestMessageTimestamp: messageTimestamp || conversationHistoryState.newestMessageTimestamp,
      loadedMessageCount: getConversationLoadedMessageCount() + 1,
    });
    if (conversationHistoryState.hasMoreNewer) {
      conversationFutureLoader.reset({
        hasMore: conversationHistoryState.hasMoreNewer,
        nextCursor: {
          afterMessageId: messageId || getConversationFutureCursor() || null,
          afterTimestamp: messageTimestamp || conversationHistoryState.newestMessageTimestamp || null,
        },
      });
    }
  }
  if (isNewNode && insertedNode) {
    // A reply takes over the board its turn posted (relay-board-view).
    if (msg?.role === 'assistant') renderRelayBoards();
    syncSeparatorsNow();
    if (scroll) scrollBottom();
  }
  return insertedNode;
}

export function getRenderedConversationMessageFingerprints(limit = 24) {
  const el = getMessagesElement();
  if (!el) return [];
  const rows = Array.from(el.querySelectorAll('.msg'));
  const tail = rows.slice(-Math.max(1, Number(limit) || 24));
  return tail.map((node) => ({
    id: String(node.dataset.messageId || '').trim(),
    role: String(node.dataset.messageRole || '').trim(),
    text: String(node.dataset.messageTextFingerprint || '').trim(),
    timestamp: String(node.dataset.messageTimestamp || '').trim(),
    sourceMessageId: String(node.dataset.sourceMessageId || '').trim(),
  }));
}

function buildMessageSnapshotKey(messages = [], meta = {}) {
  const conversationId = String(meta.conversationId || currentConvId || '').trim();
  const pageInfo = meta.pageInfo && typeof meta.pageInfo === 'object' ? meta.pageInfo : null;
  const hasMoreOlder = typeof meta.hasMoreOlder === 'boolean'
    ? meta.hasMoreOlder
    : (typeof meta.hasMoreHistory === 'boolean' ? meta.hasMoreHistory : !!pageInfo?.hasMoreOlder || !!pageInfo?.hasMore);
  const hasMoreNewer = typeof meta.hasMoreNewer === 'boolean'
    ? meta.hasMoreNewer
    : !!pageInfo?.hasMoreNewer;
  return JSON.stringify({
    conversationId,
    hasMoreOlder: !!hasMoreOlder,
    hasMoreNewer: !!hasMoreNewer,
    messages: (Array.isArray(messages) ? messages : []).map((item) => ({
      id: String(item?.id || '').trim(),
      role: String(item?.role || '').trim(),
      text: String(item?.text || ''),
      timestamp: String(item?.timestamp || '').trim(),
      model: String(item?.model || '').trim(),
      mode: String(item?.mode || '').trim(),
      attachments: Array.isArray(item?.attachments) ? item.attachments.length : 0,
      hiddenFromShares: item?.hiddenFromShares === true,
      // The continuation badge and the absorbed (steering) merge both hang
      // off kind; a payload differing only in it must not short-circuit.
      kind: String(item?.kind || '').trim(),
      resentAs: String(item?.resentAs || '').trim(),
      // Without this, a payload that differs from the last render only by a
      // newly linked compaction activity short-circuits below and the break
      // row never appears until some unrelated field changes.
      compactBoundary: (() => {
        const boundary = compactBoundaryFromActivities(item?.activities);
        return boundary ? `${boundary.preTokens ?? ''}|${boundary.postTokens ?? ''}` : '';
      })(),
      thoughts: (Array.isArray(item?.thoughts) ? item.thoughts : []).map((thought) => ({
        reasoningId: String(thought?.reasoningId || '').trim(),
        seq: Number.isFinite(Number(thought?.seq)) ? Number(thought.seq) : null,
        text: String(thought?.text || ''),
        done: !!thought?.done,
        timestamp: String(thought?.timestamp || '').trim(),
        subagentRunId: String(thought?.subagentRunId || '').trim(),
      })),
      // Cheap signature only — runs are immutable once persisted, so runId +
      // status is enough to catch a payload that differs only in its runs
      // (without one, such a payload would short-circuit and the card would
      // stay invisible until an unrelated change).
      workflowRuns: (Array.isArray(item?.workflowRuns) ? item.workflowRuns : []).map((run) => ({
        runId: String(run?.runId || '').trim(),
        status: String(run?.status || '').trim(),
      })),
    })),
  });
}

// Counts jumps into the history (a search result, a pinned message). A reload
// of the END of the conversation that was asked for before a jump and is
// answered after it would put the end back over the window just jumped to.
// Only jumps count: an ordinary reload must still be able to correct another.
let transcriptJumpEpoch = 0;

export function getTranscriptJumpEpoch() {
  return transcriptJumpEpoch;
}

export function noteTranscriptJump() {
  transcriptJumpEpoch += 1;
}

// Counts rows the socket put on the page: another client's message, a reply,
// a row rewritten in place. A reload whose request was on its way when one
// landed may not have it, and its rebuild would take it off the page again
// (transcript-reload-freshness.mjs).
let transcriptLiveRowEpoch = 0;

export function getTranscriptLiveRowEpoch() {
  return transcriptLiveRowEpoch;
}

export function noteTranscriptLiveRow() {
  transcriptLiveRowEpoch += 1;
}

function liveConversationCount() {
  return Object.values(conversations || {}).filter((conversation) => conversation && conversation.archived !== true).length;
}

function runEmptyStateAction(action) {
  switch (String(action || '').trim()) {
    case 'open-settings':
      openSettingsModal('providers');
      return;
    case 'new-chat':
      void window.newConversation?.();
      return;
    case 'show-conversations':
      toggleSidebar(true);
      return;
    default:
  }
}

function buildEmptyStateNode(model) {
  const node = document.createElement('div');
  node.className = 'empty-state';
  node.dataset.variant = model.variant;
  const actions = model.actions.map((action) => {
    const classes = ['empty-state-btn'];
    if (action.primary) classes.push('empty-state-btn-accent');
    if (action.link) classes.push('empty-state-link');
    return `<button type="button" id="${escHtml(action.id)}" class="${classes.join(' ')}" data-empty-action="${escHtml(action.action)}">${escHtml(action.label)}</button>`;
  }).join('');
  node.innerHTML = `
    <div class="icon">${escHtml(model.icon)}</div>
    <h3>${escHtml(model.heading)}</h3>
    <p>${escHtml(model.text)}</p>
    <div class="empty-state-actions">${actions}</div>`;
  for (const button of node.querySelectorAll('[data-empty-action]')) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      runEmptyStateAction(button.dataset.emptyAction);
    });
  }
  return node;
}

/**
 * Draws the "no conversation open" screen into the transcript, or redraws it
 * when readiness or the conversation list changed. A no-op with a
 * conversation open, in the shared view, or while the status view owns the
 * transcript. Idempotent: the same model leaves the node alone.
 */
export function renderNoConversationState() {
  if (IS_SHARED_VIEW) return false;
  if (String(currentConvId || '').trim()) return false;
  const el = getMessagesElement();
  if (!el || el.querySelector('.status-view')) return false;
  const existing = el.querySelector('.empty-state');
  // A transcript with rows in it belongs to something else (a render in flight).
  if (!existing && el.children.length) return false;
  const model = resolveNoConversationState({
    readiness: getProviderReadiness(),
    conversationCount: liveConversationCount(),
    mobile: isMobileComposerViewport(),
  });
  const key = JSON.stringify(model);
  if (existing && existing.dataset.emptyStateKey === key) return true;
  const node = buildEmptyStateNode(model);
  node.dataset.emptyStateKey = key;
  if (existing) existing.replaceWith(node);
  else el.appendChild(node);
  return true;
}

export function renderMessages(msgs, scroll = true, meta = {}) {
  const el = getMessagesElement();
  if (!el) return false;
  const ordered = sortConversationMessages(msgs || []);
  const snapshotKey = buildMessageSnapshotKey(ordered, meta);
  const statusViewMounted = !!el.querySelector('.status-view');
  if (snapshotKey && snapshotKey === lastRenderedMessageSnapshotKey && !statusViewMounted) {
    renderRelayQuestions();
    renderRelayBoards();
    deferredMessageRender = null;
    return false;
  }
  if (isChatInteractionHeld()) {
    // A full rebuild wipes the user's selection; park the latest payload and
    // replay it once the selection/drag is released.
    deferredMessageRender = { msgs, scroll, meta };
    return false;
  }
  deferredMessageRender = null;
  // Other rows: whoever renders them puts the reader in place.
  releaseReadingAnchorHold();
  const messageById = new Map(
    ordered
      .map((item) => [String(item?.id || '').trim(), item])
      .filter(([id]) => !!id),
  );
  // A payload that already carries this page's Resend but no resentAs on its
  // marker is newer than the page's provisional "Resent": the Resend was
  // cancelled or failed (possibly on another device), so the data wins.
  for (const item of ordered) {
    if (item?.role !== 'assistant' || String(item?.kind || '').trim() !== 'stopped') continue;
    const markerId = String(item?.id || '').trim();
    const entry = stoppedSteerResends.get(markerId);
    if (entry?.status === 'sent' && entry.resentId && messageById.has(entry.resentId) && !String(item?.resentAs || '').trim()) {
      stoppedSteerResends.delete(markerId);
    }
  }
  // Preserve optimistic pending user bubbles the payload does not yet carry.
  // A message is persisted the instant it is sent, but a poll whose response
  // predates the send returns a payload without it; rebuilding from that stale
  // payload would drop the just-sent bubble until the next poll catches up
  // (it "vanishes then reappears"). Steering makes this visible because the
  // absorbed-reply broadcast forces extra rebuilds during the send window.
  // Capturing the live DOM nodes keeps their exact content and handlers; the
  // wipe below orphans them but the references keep them alive to re-append.
  // Matches store.js pendingConversationKey (trimmed id, or '__new__').
  const renderConversationKey = String(meta.conversationId || currentConvId || '').trim() || '__new__';
  const pageInfo = meta.pageInfo && typeof meta.pageInfo === 'object' ? meta.pageInfo : null;
  const hasMoreNewer = typeof meta.hasMoreNewer === 'boolean'
    ? meta.hasMoreNewer
    : !!pageInfo?.hasMoreNewer;
  const preservedPendingNodes = [];
  // A kept pending bubble re-joins at the end of the loaded window, which is
  // only the newest end when nothing newer is left unloaded (a search jump
  // loads a window in the middle of the history).
  for (const id of (hasMoreNewer ? [] : pendingUserMessageIds)) {
    const pendingId = String(id || '').trim();
    if (!pendingId || messageById.has(pendingId)) continue;
    // Only this conversation's pending bubbles: a bubble still waiting in
    // another conversation must never be carried into the one being rendered
    // (a switch would otherwise drag it along).
    const entry = pendingUserMessageEntries.get(pendingId);
    if (String(entry?.conversationKey || '').trim() !== renderConversationKey) continue;
    const node = el.querySelector(`[data-message-id="${CSS.escape(pendingId)}"]`);
    if (node) preservedPendingNodes.push(node);
  }
  // Preserve the live thinking bubble across the wipe. It holds in-progress
  // thoughts, streamed text and subagent bubbles that a full re-derive would
  // lose (or briefly blank while restoreInFlightThinking rebuilds from the
  // server's inFlight snapshot). Re-appending the same node lets that restore
  // update it in place instead of rebuilding — the same reuse showThinking
  // already relies on. removeThinking() still drops it when the turn ends.
  const thinkingNode = document.getElementById('thinking-indicator');
  // Only when it genuinely lives in the transcript being rebuilt and belongs
  // to the conversation being rendered: a detached node must not be spliced
  // in as an extra row, and another conversation's bubble must not leak into
  // this one (it is dropped instead, so the next restore builds afresh).
  const thinkingNodeInTranscript = !!thinkingNode && thinkingNode.parentNode === el;
  // Nor under a window that ends above the conversation's end (showThinking).
  const preservedThinkingNode = (thinkingNodeInTranscript
    && !hasMoreNewer
    && thinkingNode.dataset.conversationId === renderConversationKey) ? thinkingNode : null;
  if (thinkingNodeInTranscript && !preservedThinkingNode) removeThinking();
  if (!ordered.length && !preservedPendingNodes.length && !preservedThinkingNode) {
    if (!currentConvId && !IS_SHARED_VIEW) {
      // Nothing open: the screen says what can be done here (no-conversation-state.mjs).
      el.innerHTML = '';
      renderNoConversationState();
    } else {
      el.innerHTML = `<div class="empty-state">
        <div class="icon">${currentConvId ? '💬' : '🚀'}</div>
        <h3>${currentConvId ? 'No messages yet' : 'New Conversation'}</h3>
        <p>${currentConvId ? 'Start the conversation below' : 'Type your first message below'}</p>
      </div>`;
    }
    resetConversationHistoryState();
    renderRelayQuestions();
    renderRelayBoards();
    lastRenderedMessageSnapshotKey = snapshotKey;
    return true;
  }
  const conversationId = String(meta.conversationId || currentConvId || '').trim();
  const hasMoreOlder = typeof meta.hasMoreOlder === 'boolean'
    ? meta.hasMoreOlder
    : (typeof meta.hasMoreHistory === 'boolean' ? meta.hasMoreHistory : !!pageInfo?.hasMoreOlder || !!pageInfo?.hasMore);
  const oldestMessageId = String(
    meta.historyCursor
    || pageInfo?.olderCursor?.beforeMessageId
    || pageInfo?.nextCursor?.beforeMessageId
    || ordered[0]?.id
    || '',
  ).trim();
  const oldestMessageTimestamp = String(
    pageInfo?.olderCursor?.beforeTimestamp
    || pageInfo?.nextCursor?.beforeTimestamp
    || ordered[0]?.timestamp
    || '',
  ).trim();
  const newestMessageId = String(meta.historyNewestMessageId || ordered[ordered.length - 1]?.id || '').trim();
  const newestMessageTimestamp = String(
    pageInfo?.newerCursor?.afterTimestamp
    || ordered[ordered.length - 1]?.timestamp
    || '',
  ).trim();
  el.innerHTML = hasMoreOlder ? buildHistoryLoadMoreMarkup(false) : '';
  setConversationHistoryState({
    conversationId,
    hasMoreOlder,
    hasMoreNewer,
    oldestMessageId,
    oldestMessageTimestamp,
    newestMessageId,
    newestMessageTimestamp,
    loadedMessageCount: ordered.length,
    loadingOlder: false,
    loadingNewer: false,
  });
  conversationHistoryLoader.reset({
    hasMore: hasMoreOlder,
    nextCursor: hasMoreOlder ? (pageInfo?.olderCursor || pageInfo?.nextCursor || {
      beforeMessageId: oldestMessageId || null,
      beforeTimestamp: null,
    }) : null,
  });
  conversationFutureLoader.reset({
    hasMore: hasMoreNewer,
    nextCursor: hasMoreNewer ? (pageInfo?.newerCursor || {
      afterMessageId: newestMessageId || null,
      afterTimestamp: newestMessageTimestamp || null,
    }) : null,
  });
  withSuspendedSeparatorSync(() => {
    for (const m of ordered) appendMessage(m, false, m.id || null, true, getMessageThreadAnchor(m, messageById), false);
    // A pending bubble the payload lacks is the newest message, so it re-joins
    // at the end. Re-appending the original node (not a fresh one) keeps its
    // cancel button and click handlers intact.
    for (const node of preservedPendingNodes) el.appendChild(node);
    // The live thinking bubble re-joins under its owning message right here:
    // restoreInFlightThinking skips an unchanged snapshot, so waiting for it
    // to re-anchor left the bubble at the end, below later (steered) rows.
    if (preservedThinkingNode) {
      el.appendChild(preservedThinkingNode);
      anchorThinkingBubble(preservedThinkingNode, preservedThinkingNode.dataset.messageId);
    }
  });
  syncSeparatorsNow();
  renderRelayQuestions();
  renderRelayBoards();
  lastRenderedMessageSnapshotKey = snapshotKey;
  if (scroll) scrollBottom();
  requestAnimationFrame(() => {
    const box = getMessagesElement();
    if (!box) return;
    void conversationHistoryLoader.handleBoundaryDistance(box.scrollTop);
    const forwardDistance = Math.max(0, box.scrollHeight - box.clientHeight - box.scrollTop);
    void conversationFutureLoader.handleBoundaryDistance(forwardDistance);
  });
  return true;
}

export async function loadOlderConversationMessages() {
  await conversationHistoryLoader.loadMore();
}

export async function loadNewerConversationMessages() {
  await conversationFutureLoader.loadMore();
}

// False while a window in the middle of the history is on the page (a search
// result or a pinned message was jumped to) and newer messages are unloaded.
export function isConversationWindowAtTail() {
  return !conversationHistoryState.hasMoreNewer;
}

/**
 * A live row for `conversationId` arrived (a message, a reply). True when it
 * is held back instead of put on the page: the window on the page is that
 * conversation's and ends above its end (transcript-island.mjs). The window
 * keeps loading newer pages from its own newest row, and the jump-to-bottom
 * button counts the row.
 */
export function holdBackLiveRow(conversationId, messageId) {
  const id = String(conversationId || '').trim();
  if (!id || isConversationWindowAtTail() || getRenderedConversationId() !== id) return false;
  heldBackLiveRows.note(id, messageId);
  // A reload whose request was on its way may lack this row as it would one
  // put on the page: counted, so it is asked again (loadKeepingLiveRows)
  // rather than rendered over the rows held.
  noteTranscriptLiveRow();
  refreshJumpButton();
  return true;
}

/** How many live rows wait below the window on the page. */
export function getHeldBackLiveRowCount() {
  return heldBackLiveRows.count(getRenderedConversationId());
}

/** The ids of the live rows that wait below the window on the page, oldest first. */
export function getHeldBackLiveRowIds() {
  return heldBackLiveRows.ids(getRenderedConversationId());
}

function renderedMessageIds() {
  const el = getMessagesElement();
  if (!el) return [];
  return Array.from(readingAnchorRows(el), (node) => String(node.dataset.messageId || '').trim());
}

// The running turn's live bubble, drawn from what the page kept of it (its
// thoughts, tools and text arrived while no bubble was drawn).
function showLiveBubbleOfRunningTurn() {
  if (document.getElementById('thinking-indicator')) return;
  const turn = getActiveTurnForConversation(currentConvId);
  const messageId = String(turn?.messageId || '').trim();
  if (!messageId || String(turn?.status || '').trim().toLowerCase() !== 'processing') return;
  showThinking(messageId, false);
  renderThinkingStream();
  renderThinkingActivities();
  renderThinkingThoughts();
  renderRestoredSubagentBubbles(messageId);
}

/** The conversation whose rows the transcript holds; during a switch, still the one left. */
export function getRenderedConversationId() {
  return String(conversationHistoryState.conversationId || '').trim();
}

// The message rows, without the live bubble: it carries its prompt's id.
function readingAnchorRows(el) {
  return el.querySelectorAll(':scope > .msg[data-message-id]:not(#thinking-indicator)');
}

/**
 * Where the reader is in the transcript on the page
 * (transcript-reading-anchor.mjs), for the conversation whose rows it holds;
 * null when no row is there.
 */
export function captureConversationReadingAnchor() {
  const el = getMessagesElement();
  const conversationId = getRenderedConversationId();
  if (!el || !conversationId) return null;
  const rows = readingAnchorRows(el);
  if (!rows.length) return null;
  const paneTop = el.getBoundingClientRect().top;
  const rectAt = (index) => rows[index].getBoundingClientRect();
  const anchor = captureReadingAnchor({
    rowCount: rows.length,
    rowAt: (index) => {
      const rect = rectAt(index);
      return { messageId: rows[index].dataset.messageId, top: rect.top, bottom: rect.bottom };
    },
    paneTop,
    atTail: isMessagesNearBottom() && isConversationWindowAtTail(),
  });
  return anchor ? { conversationId, anchor } : null;
}

function readingAnchorRow(el, messageId) {
  const id = String(messageId || '').trim();
  return id ? el.querySelector(`:scope > .msg[data-message-id="${CSS.escape(id)}"]:not(#thinking-indicator)`) : null;
}

/**
 * Puts the anchored message at its saved offset, or the reader at the end.
 * False when the message is not on the page. The place is then held while
 * the images on the page are still loading (holdReadingAnchorWhileMediaLoads).
 */
export function restoreConversationReadingAnchor(anchor) {
  const el = getMessagesElement();
  if (!el || !anchor) return false;
  if (anchor.atTail) {
    releaseReadingAnchorHold();
    el.scrollTop = el.scrollHeight;
    return true;
  }
  const row = readingAnchorRow(el, anchor.messageId);
  if (!row) return false;
  const delta = readingAnchorScrollDelta({
    rowTop: row.getBoundingClientRect().top,
    paneTop: el.getBoundingClientRect().top,
    offsetPx: anchor.offsetPx,
  });
  if (Math.abs(delta) > 0.5) el.scrollTop += delta;
  holdReadingAnchorWhileMediaLoads(el, anchor);
  return true;
}

// Images reserve no height until their bytes are in (the attachment payload
// carries no dimensions), so one above the place read that arrives after the
// place was put back pushes it down by its height. Chrome's scroll anchoring
// absorbs that; browsers without it (iOS Safari) do not. Long enough for a
// slow link, short enough that a forgotten hold cannot surprise anyone.
const READING_ANCHOR_HOLD_MAX_MS = 10_000;
let readingAnchorHold = null;

/**
 * Lets go of the place held while images load: whoever calls this moves the
 * reader themselves (the jump to the end, an own send).
 */
export function releaseReadingAnchorHold() {
  const hold = readingAnchorHold;
  if (!hold) return;
  readingAnchorHold = null;
  hold.cleanup();
}

function pendingTranscriptImages(el) {
  return Array.from(el.querySelectorAll('img')).filter((img) => !img.complete);
}

/**
 * Keeps the anchored message at its offset while images in the transcript
 * are loading: each one that is laid out at its height (a ResizeObserver
 * fires before the frame is painted; load and error events as a fallback)
 * scrolls by what it pushed. Lets go when they are all in, after
 * READING_ANCHOR_HOLD_MAX_MS, or as soon as the reader scrolls: a wheel, a
 * touch or a key, or a change of scrollTop that no growth above the row
 * explains (a drag of the scrollbar, a jump to the end, an own send). Growth
 * below the row (a reply streaming in at the end) is not the hold's to
 * correct (readingAnchorHoldStep). A reader at the end has nothing to hold
 * here: the jump-to-bottom follower keeps them at the end.
 */
function holdReadingAnchorWhileMediaLoads(el, anchor) {
  releaseReadingAnchorHold();
  if (!el || !anchor || anchor.atTail || !anchor.messageId) return;
  const pending = pendingTranscriptImages(el);
  if (!pending.length) return;
  const startRow = readingAnchorRow(el, anchor.messageId);
  if (!startRow) return;
  // Where the row sits in the content and the scroll, as of the last look:
  // the next look corrects by what moved the row in the content only.
  const seen = {
    rowContentTop: readingAnchorContentTop({
      rowTop: startRow.getBoundingClientRect().top,
      paneTop: el.getBoundingClientRect().top,
      scrollTop: el.scrollTop,
    }),
    scrollTop: el.scrollTop,
  };
  const check = () => {
    if (readingAnchorHold !== hold) return;
    const row = readingAnchorRow(el, anchor.messageId);
    if (!row) {
      releaseReadingAnchorHold();
      return;
    }
    const step = readingAnchorHoldStep({
      rowTop: row.getBoundingClientRect().top,
      paneTop: el.getBoundingClientRect().top,
      scrollTop: el.scrollTop,
      seen,
    });
    if (step.action === 'release') {
      releaseReadingAnchorHold();
      return;
    }
    if (step.action === 'correct') el.scrollTop += step.delta;
    seen.rowContentTop = step.rowContentTop;
    // Read back: the browser can clamp the correction.
    seen.scrollTop = el.scrollTop;
  };
  const onMediaSettled = () => {
    check();
    if (readingAnchorHold === hold && !pendingTranscriptImages(el).length) releaseReadingAnchorHold();
  };
  const onReaderInput = () => releaseReadingAnchorHold();
  // A key can scroll the pane from anywhere but a field being typed in (the
  // composer, a card's reply): typing there moves nothing.
  const onKeyDown = (event) => {
    const target = event?.target;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable === true)) return;
    releaseReadingAnchorHold();
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
  for (const img of pending) observer?.observe(img);
  el.addEventListener('load', onMediaSettled, true);
  el.addEventListener('error', onMediaSettled, true);
  // A video's box changes when its metadata is in.
  el.addEventListener('loadedmetadata', check, true);
  el.addEventListener('scroll', check, { passive: true });
  el.addEventListener('wheel', onReaderInput, { passive: true });
  el.addEventListener('touchstart', onReaderInput, { passive: true });
  document.addEventListener('keydown', onKeyDown, true);
  const timer = setTimeout(releaseReadingAnchorHold, READING_ANCHOR_HOLD_MAX_MS);
  const hold = {
    cleanup() {
      clearTimeout(timer);
      observer?.disconnect();
      el.removeEventListener('load', onMediaSettled, true);
      el.removeEventListener('error', onMediaSettled, true);
      el.removeEventListener('loadedmetadata', check, true);
      el.removeEventListener('scroll', check);
      el.removeEventListener('wheel', onReaderInput);
      el.removeEventListener('touchstart', onReaderInput);
      document.removeEventListener('keydown', onKeyDown, true);
    },
  };
  readingAnchorHold = hold;
}

/**
 * The window on the page no longer meets the end of the conversation (more
 * was written than one page holds): newer rows load as after a jump into
 * the history, and the jump-to-bottom button loads the end.
 */
export function detachConversationWindowFromTail() {
  const newestMessageId = String(conversationHistoryState.newestMessageId || '').trim();
  setConversationHistoryState({ ...conversationHistoryState, hasMoreNewer: true });
  // A live bubble on the page now sits under a window that ends above the
  // end, below rows that are not loaded: it goes until the window meets the
  // end again (showThinking draws none meanwhile).
  takeThinkingBubbleOff();
  conversationFutureLoader.reset({
    hasMore: true,
    nextCursor: {
      afterMessageId: newestMessageId || null,
      afterTimestamp: String(conversationHistoryState.newestMessageTimestamp || '').trim() || null,
    },
  });
}

// One message as the transcript's snapshot key sees it.
function messageRenderKey(message) {
  return buildMessageSnapshotKey([message], { conversationId: '', hasMoreOlder: false, hasMoreNewer: false });
}

/**
 * Whether the transcript on the page can take a merge of `previousMessages`'
 * window (mergeMessagesIntoTranscript) rather than a full render: not while
 * a bubble still waits for its send, the status view is up, a selection is
 * held, another conversation's rows are on the page, or a row of the window
 * is missing from it (what is merged in is placed next to those rows, and a
 * changed one is rebuilt where it stands).
 */
export function canMergeIntoTranscript(previousMessages, conversationId) {
  const el = getMessagesElement();
  const id = String(conversationId || '').trim();
  if (!el || !id) return false;
  if (isChatInteractionHeld()
    || el.querySelector('.status-view')
    || getRenderedConversationId() !== id
    || hasPendingUserMessageForConversation(id)) {
    return false;
  }
  const rendered = new Set(Array.from(readingAnchorRows(el), (node) => String(node.dataset.messageId || '').trim()));
  for (const message of previousMessages || []) {
    const messageId = String(message?.id || '').trim();
    if (messageId && !rendered.has(messageId)) return false;
  }
  return true;
}

/**
 * Puts a merged window (mergeTailPage) on the page without rebuilding it:
 * the rows the newest page changed are rebuilt where they stand, its new ones
 * are put in their place, the rows it dropped are taken off, every other row
 * stays as it is under the reader.
 * Falls back to a full render when the page holds rows the merge cannot
 * place (a bubble still waiting for its send, the status view, a held
 * selection). Returns true when the transcript changed.
 */
export function mergeMessagesIntoTranscript(previousMessages, msgs, meta = {}) {
  const el = getMessagesElement();
  if (!el) return false;
  const conversationId = String(meta.conversationId || currentConvId || '').trim();
  if (!canMergeIntoTranscript(previousMessages, conversationId)) return renderMessages(msgs, false, meta);
  const ordered = sortConversationMessages(msgs || []);
  const snapshotKey = buildMessageSnapshotKey(ordered, meta);
  if (snapshotKey === lastRenderedMessageSnapshotKey) return false;
  const previousById = new Map((previousMessages || []).map((m) => [String(m?.id || '').trim(), m]));
  const messageById = new Map(ordered.map((m) => [String(m?.id || '').trim(), m]).filter(([id]) => !!id));
  let previousId = '';
  withSuspendedSeparatorSync(() => {
    // A window row the merge left out was deleted while the reader was away
    // (mergeTailPage drops it): it leaves the page too. Taken off first, so
    // nothing merged in is placed next to it.
    for (const id of previousById.keys()) {
      if (!id || messageById.has(id)) continue;
      el.querySelector(`:scope > .msg[data-message-id="${CSS.escape(id)}"]:not(#thinking-indicator)`)?.remove();
      seenMessageIds.delete(id);
    }
    for (const m of ordered) {
      const id = String(m?.id || '').trim();
      if (!id) continue;
      const before = previousById.get(id);
      if (!before) {
        const threadAnchor = getMessageThreadAnchor(m, messageById);
        appendMessage(m, false, id, true, threadAnchor !== id ? threadAnchor : (previousId || null), false);
      } else if (messageRenderKey(before) !== messageRenderKey(m)) {
        replaceRenderedMessage(m, id);
      }
      previousId = id;
    }
  });
  const newest = ordered[ordered.length - 1] || null;
  setConversationHistoryState({
    ...conversationHistoryState,
    conversationId,
    newestMessageId: String(newest?.id || conversationHistoryState.newestMessageId || '').trim(),
    newestMessageTimestamp: String(newest?.timestamp || conversationHistoryState.newestMessageTimestamp || '').trim(),
    loadedMessageCount: ordered.length,
  });
  syncSeparatorsNow();
  renderRelayQuestions();
  renderRelayBoards();
  lastRenderedMessageSnapshotKey = snapshotKey;
  return true;
}

export function focusConversationMessageById(messageId, { behavior = 'smooth', block = 'center' } = {}) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  const el = getMessagesElement();
  if (!el) return false;
  // A folded agent prompt is opened before it is scrolled to.
  revealAgentExchangeMessage(id);
  const target = el.querySelector(`.msg[data-message-id="${CSS.escape(id)}"]`);
  if (!target) return false;
  target.scrollIntoView({ behavior, block, inline: 'nearest' });
  target.classList.add('msg-search-target');
  window.setTimeout(() => {
    target.classList.remove('msg-search-target');
  }, 2200);
  return true;
}

export function compactCurrentConversation() {
  if (!currentConvId || compactInFlight) return;
  const id = currentConvId;
  const conv = conversations[id];
  if (!conv || conv.archived) return;
  if (!confirm('Compact this conversation into a new one with carry-over summary?')) return;

  setCompactInFlight(true);
  try {
    const doCompact = async () => {
      const r = await compactConversationApi(id);
      if (!r?.compactedConversationId) throw new Error('Compaction failed');
      await window.refreshConversations?.();
      await window.openConversation?.(r.compactedConversationId);
    };
    void doCompact().catch((e) => {
      alert(e.message || 'Failed to compact conversation');
    }).finally(() => {
      setCompactInFlight(false);
    });
  } catch (e) {
    setCompactInFlight(false);
    alert(e.message || 'Failed to compact conversation');
  }
}

// Warn-once slot for the unknown-command guard; keyed by exact text so any
// edit re-arms the warning.
let unknownCommandWarned = null;

// An own message goes to the end of the conversation. Sent from a window that
// ends above it, its row put under the window would sit below rows that are
// not loaded, and would move the newer pages' cursor past them; no live
// bubble or reply would be drawn there either. So the end is loaded first,
// as the jump-to-bottom button does, and the row, the bubble and the reply
// follow at the end, whatever the scroll-on-send setting says: the end is
// where the message is. Resolves once the end is on the page, or its load
// failed (then the window still ends above, and no row is put under it).
function loadEndForOwnSend() {
  if (isConversationWindowAtTail()) return Promise.resolve();
  return jumpTranscriptToBottom();
}

export async function sendMessage() {
  // The reader's own send, as of now: what follows it scrolls to the end
  // only while they have not scrolled since.
  const send = beginOwnSend();
  const input = document.getElementById('msg-input');
  const originalComposerText = String(input?.value || '');
  const text = originalComposerText.trim();
  const mobileSend = isMobileComposerViewport();
  // A send while steering is held is allowed: the relay holds the message
  // and it steers in once the hold clears (the button reads "Queue").
  const hasDraft = hasComposerDraft({ text, attachmentCount: selectedAttachments.length });
  if (sendInFlight) {
    showTransientRelayNotice('Please wait for the current message to finish sending.');
    return;
  }
  if (!hasDraft) return;
  // No conversation open and no provider ready: a send would create a
  // Copilot chat that cannot run. The composer is locked in this state; this
  // guard covers a programmatic send, before any upload starts.
  if (!String(currentConvId || '').trim() && isProviderSetupRequired()) {
    showTransientRelayNotice('Set up a provider in Settings → Providers before starting a chat.', 6000);
    return;
  }
  closeSlashAutocomplete();
  closeMentionAutocomplete();

  // Warn-once typo guard: a message that looks like a command but matches none
  // would otherwise burn an agent turn as plain text.
  const guard = evaluateUnknownCommandGuard(text, {
    slot: unknownCommandWarned,
    hasAttachments: selectedAttachments.length > 0,
  });
  unknownCommandWarned = guard.slot;
  if (guard.warn) {
    showTransientRelayNotice(guard.notice);
    return;
  }

  if (text.toLowerCase() === '/compact' && selectedAttachments.length === 0) {
    input.value = '';
    autoResize(input);
    releaseComposerFocusAfterSend(input);
    void flushConversationDraft(currentConvId);
    compactCurrentConversation();
    scrollAfterOwnSend(send);
    return;
  }

  const previewCommand = selectedAttachments.length === 0 ? parsePreviewCommand(text) : null;
  if (previewCommand) {
    input.value = '';
    autoResize(input);
    releaseComposerFocusAfterSend(input);
    void flushConversationDraft(currentConvId);
    const result = await runPreviewCommand(previewCommand, { conversationId: currentConvId });
    showTransientRelayNotice(result.notice);
    return;
  }

  // Capture the send target and its composer payload before any await: the
  // message belongs to the conversation the user typed it in. If the user
  // opens another conversation while a round trip below is in flight, the
  // message still posts to this validated conversation and is simply not
  // rendered into (or drafted onto) the newly opened one — it shows up there
  // when that conversation is next loaded. The model/effort/tier/mode selects
  // and the image-edit target are captured here too: opening another
  // conversation rewrites the selects (applyConversationPreferences) and
  // clears the image-edit target, so a mid-await switch must not respell this
  // send with the other conversation's preferences.
  const targetConversationId = String(currentConvId || '').trim() || null;
  const draftAttachments = selectedAttachments.slice();
  const selectedModel = document.getElementById('model-select').value || '';
  const selectedReasoningEffort = String(document.getElementById('reasoning-effort-select')?.value || '').trim().toLowerCase();
  const selectedContextTier = String(document.getElementById('context-tier-select')?.value || 'default').trim();
  const selectedMode = document.getElementById('mode-select').value || 'agent';
  const draftImageEditTarget = imageEditTarget;
  let composerConversationId = targetConversationId;
  const viewingSendConversation = () => String(currentConvId || '').trim() === String(composerConversationId || '').trim();
  if (!(await validateSelectedConversationBeforeSend(targetConversationId))) {
    return;
  }
  if (window.isModelMetadataBlocked?.()) {
    showTransientRelayNotice('Model metadata is unavailable. Refresh models to continue.');
    return;
  }
  if (hasPendingUserMessageDuplicate(targetConversationId, text)) {
    showTransientRelayNotice('That message is already pending.');
    return;
  }
  if (targetConversationId) {
    // The send takes the draft over from here: the debounced save is dropped,
    // and no refresh may re-apply the draft this send is about to clear.
    clearDraftTimerForConversation(targetConversationId);
    sendOwnedDraftConversations.add(targetConversationId);
  }

  setSendInFlight(true);
  let composerClearedBySend = false;
  let attachments = [];
  let clientMessageId = null;
  try {
    // Alongside the upload: the end is loaded while the files go up.
    const endLoaded = viewingSendConversation() ? loadEndForOwnSend() : null;
    attachments = await uploadAttachments(draftAttachments);
    await endLoaded;

    const isNew = !targetConversationId;
    const msgTimestamp = new Date().toISOString();
    if (!selectedReasoningEffort) {
      showTransientRelayNotice('Select a reasoning effort after refreshing model metadata.');
      return;
    }
    const titleSeed = text || (attachments[0]?.name || 'Attachment');
    clientMessageId = generateId();
    trackPendingUserMessage(clientMessageId, targetConversationId, text, { attachments });
    pendingUserMessageIds.add(clientMessageId);
    // The message leaves the draft: from here the cached draft is only what is
    // typed next, which the post-send save (or a failure restore) builds on.
    if (targetConversationId) upsertConversationDraftState(targetConversationId, { draftText: '' });
    composerClearedBySend = true;
    if (viewingSendConversation()) {
      input.value = '';
      autoResize(input);
      releaseComposerFocusAfterSend(input);
      // Asked before the bubble is on the page.
      const follow = ownSendFollows(send);
      // Not under a window that still ends above the end (loadEndForOwnSend
      // failed): the row comes with the end.
      if (isConversationWindowAtTail()) {
        appendMessage({ role: 'user', text, model: selectedModel, mode: selectedMode, timestamp: msgTimestamp, attachments }, follow, clientMessageId, true);
      }
      scrollAfterOwnSend(send);
    }

    const body = {
      messageId: clientMessageId,
      clientId: CLIENT_ID,
      text,
      model: selectedModel,
      reasoningEffort: selectedReasoningEffort,
      contextTier: selectedContextTier,
      relayMode: selectedMode,
      conversationId: targetConversationId || undefined,
      newConversation: isNew || undefined,
      attachments,
      imageTarget: draftImageEditTarget
        ? {
            messageId: draftImageEditTarget.messageId,
            imageId: draftImageEditTarget.imageId,
            nodeId: draftImageEditTarget.nodeId,
          }
        : undefined,
    };

    const r = await sendMessageApi(body);
    if (!r) {
      // Offline: park the send in the durable outbox instead of bouncing it
      // back into the composer. The client-generated messageId makes a replay
      // after an ambiguous failure idempotent (the server answers 409 for a
      // send that already landed). Only existing conversations queue — a new
      // conversation needs the server's response to become usable.
      if (navigator.onLine === false && targetConversationId) {
        const queued = await enqueueOutboxRequest({
          kind: 'message',
          path: '/api/message',
          body: JSON.stringify(body),
        });
        if (queued) {
          void registerOutboxSync();
          showTransientRelayNotice('You are offline. Message queued — it will send when the connection returns.', 7000);
          if (viewingSendConversation()) removeComposerAttachments(draftAttachments);
          return;
        }
      }
      const sendLanded = hasSendEchoArrived(clientMessageId);
      if (!sendLanded) {
        clearPendingUserMessage(clientMessageId);
        const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
        pendingNode?.remove();
        pendingUserMessageIds.delete(clientMessageId);
        seenMessageIds.delete(clientMessageId);
      }
      restoreComposerAfterFailedSend(targetConversationId, originalComposerText, {
        viewing: viewingSendConversation(),
        composerCleared: composerClearedBySend,
        sendLanded,
      });
      if (!mobileSend && viewingSendConversation()) input.focus();
      setModelBanner('⚠️ Message could not be sent. Please try again.');
      return;
    }

    if (r.duplicate) {
      clearPendingUserMessage(clientMessageId);
      const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
      pendingNode?.remove();
      pendingUserMessageIds.delete(clientMessageId);
      seenMessageIds.delete(clientMessageId);
      if (!mobileSend && viewingSendConversation()) input.focus();
      showTransientRelayNotice('That message was already sent recently.');
      return;
    }

    if ((r.workspaceRootName || r.workspaceRootEntries || r.workspaceRootPath) && viewingSendConversation()) {
      updateWorkspaceRootHints(r);
      if (repoBrowserState.open && repoBrowserState.activeRoot === 'workspace') {
        // Restoring refresh: if the root really changed, the restore walk
        // finds nothing to re-open and falls back to the new root on its own.
        window.refreshRepoBrowser?.();
      }
    }
    if (r.compactedConversationId) {
      await window.refreshConversations?.();
      // Only follow the auto-compact redirect while the user is still in the
      // conversation that was compacted.
      if (viewingSendConversation()) {
        await window.openConversation?.(r.compactedConversationId);
        removeComposerAttachments(draftAttachments);
        if (!mobileSend) input.focus();
        // The send goes on in the conversation the compaction opened.
        scrollAfterOwnSend({ ...send, conversationId: String(r.compactedConversationId || '').trim() });
      }
      return;
    }
    if (r.warning) setModelBanner(`⚠️ ${r.warning}`);
    if (r.workspaceRootWarning) setModelBanner(`⚠️ ${r.workspaceRootWarning}`);
    const skippedRefs = Array.isArray(r.skippedReferenceAttachments) ? r.skippedReferenceAttachments : [];
    if (skippedRefs.length) {
      const firstReason = String(skippedRefs[0]?.reason || 'reference skipped');
      setModelBanner(`⚠️ Some referenced images were not attached (${firstReason}).`);
    }
    // Clear only while the user still views the send conversation: a mid-await
    // switch may have set a fresh image-edit target on the newly opened one.
    if (draftImageEditTarget && viewingSendConversation()) clearImageEditTarget();
    if (isNew || !targetConversationId) {
      // Adopt the created conversation as the current view only while the
      // user is still on the blank view the message was sent from.
      const adoptNewConversation = viewingSendConversation();
      if (adoptNewConversation) {
        setCurrentConv(r.conversationId);
        composerConversationId = r.conversationId;
        nameOwnSendConversation(send, r.conversationId);
      }
      conversations[r.conversationId] = {
        id: r.conversationId,
        title: titleSeed.slice(0, 60),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
        // The session the relay routed this first message to: the id its
        // worker is launched, registered and heartbeats under, so the
        // composer reads that worker's steering snapshot before the list
        // catches up. A binding that names another id (the placeholder
        // rekey) replaces it via conversation_session_bound.
        sdkSessionId: r.ownerSessionId || null,
        runtimeSessionId: r.runtimeSessionId || null,
        runtimeProviderType: r.runtimeProviderType || 'github',
        runtimeProviderModel: r.runtimeProviderModel || null,
        preferredRelayMode: r.preferredRelayMode || selectedMode,
        preferredModel: r.preferredModel || selectedModel,
        preferredReasoningEffort: r.preferredReasoningEffort || selectedReasoningEffort || 'none',
      };
      window.syncAutoModelAvailability?.();
      if (adoptNewConversation) {
        document.getElementById('chat-title').textContent = titleSeed.slice(0, 60);
        window.syncChatTitleControls?.();
        updateCompactButton();
      }
      window.renderConvList?.();
      if (adoptNewConversation) {
        applyContextUsageBar(null);
        scheduleContextUsageRefresh(r.conversationId, 0);
      }
    }
    if (conversations[r.conversationId]) {
      conversations[r.conversationId] = {
        ...conversations[r.conversationId],
        messageCount: Math.max(1, Number(conversations[r.conversationId].messageCount || 0)),
        runtimeSessionId: r.runtimeSessionId || conversations[r.conversationId].runtimeSessionId || null,
        runtimeProviderType: r.runtimeProviderType || conversations[r.conversationId].runtimeProviderType || 'github',
        runtimeProviderModel: r.runtimeProviderModel ?? conversations[r.conversationId].runtimeProviderModel ?? null,
      };
      window.syncAutoModelAvailability?.();
    }
    // Adopting the conversation can grow the composer (session-lock note,
    // warning banner), which shrinks the transcript under a pane that was
    // pinned to the newest message. Re-pin now rather than after the draft
    // save's round trip below, or the new bubble sits under the composer
    // for as long as that request takes.
    if (viewingSendConversation() && ownSendFollows(send)) scrollBottom();
    const persistedConversationId = String(r.conversationId || targetConversationId || '').trim();
    if (persistedConversationId) {
      restorableDraftByConversation.delete(persistedConversationId);
      // Forced: the send transaction already moved the server's version, and
      // this round trip is how the client learns it (a 409 carries it). What
      // is saved is the composer as it is now — the user may already have
      // typed the next message while this one was sending.
      const postSendText = viewingSendConversation()
        ? String(input.value || '')
        : String(conversations[persistedConversationId]?.draftText || '');
      const clearedDraft = await scheduleConversationDraftSave({
        conversationId: persistedConversationId,
        draftText: postSendText,
        immediate: true,
        force: true,
      });
      upsertConversationDraftState(persistedConversationId, {
        draftText: postSendText,
        // Prefer the server's version pointer (a 409 carries the one the send
        // transaction wrote when it cleared the draft) over this client's
        // clock: once the send releases the draft, every later refresh is
        // judged stale against this value, and a skewed clock would either
        // resurrect the sent text or freeze out a genuine remote draft.
        draftUpdatedAt: clearedDraft?.draftUpdatedAt || new Date().toISOString(),
        draftUpdatedByClientId: CLIENT_ID,
      });
    }
    if (cliOnline && viewingSendConversation()) {
      // A turn already running here owns the live bubble; adopting the
      // just-queued id would re-anchor it under the newest user message.
      const activeTurn = getActiveTurnForConversation(composerConversationId);
      if (!activeTurn?.messageId) showThinking(r.messageId || null, ownSendFollows(send));
    }

    // Only what this message took leaves the composer: attachments added (or
    // still uploading) since the send began stay, and the settle-time save
    // below persists them.
    if (viewingSendConversation()) {
      removeComposerAttachments(draftAttachments);
      if (!mobileSend) input.focus();
      scrollAfterOwnSend(send);
    }
  } catch (e) {
    const sendLanded = hasSendEchoArrived(clientMessageId);
    if (clientMessageId && !sendLanded) {
      clearPendingUserMessage(clientMessageId);
      const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
      pendingNode?.remove();
      pendingUserMessageIds.delete(clientMessageId);
      seenMessageIds.delete(clientMessageId);
    }
    restoreComposerAfterFailedSend(targetConversationId, originalComposerText, {
      viewing: viewingSendConversation(),
      composerCleared: composerClearedBySend,
      sendLanded,
    });
    alert(e.message || 'Failed to send message');
  } finally {
    setSendInFlight(false);
    // Every exit path has settled the draft by now: cleared it (success),
    // restored the composer text (offline/failure), or never touched it.
    if (targetConversationId) sendOwnedDraftConversations.delete(targetConversationId);
    // Edits made after the post-send save were held back while the send owned
    // the draft; save them now, on screen or not.
    if (targetConversationId) saveComposerIfUnsynced(targetConversationId);
  }
}

// Textarea input hook (inline oninput beside autoResize): keeps the slash
// menu in sync with the caret. Cheap no-op for non-slash text.
export function updateComposerSlashMenu(input) {
  updateSlashAutocomplete(input, { conversationId: currentConvId });
  // Second, so it sees the slash menu's verdict: the @relay popup never opens
  // over an open slash menu, and at most one of them ever handles keys.
  updateMentionAutocomplete(input);
}

export function handleKey(e) {
  // The open menu owns navigation keys; Ctrl/Cmd+Enter still falls through to
  // send because neither menu consumes it.
  if (handleSlashAutocompleteKey(e, e.target)) return;
  if (handleMentionAutocompleteKey(e, e.target)) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
  }
}

async function validateSelectedConversationBeforeSend(conversationId = currentConvId) {
  const convId = String(conversationId || '').trim();
  if (!convId) return true;

  const current = await loadConversationApi(convId, { limit: 1 });
  if (!current) {
    setModelBanner('⚠️ Selected conversation is unavailable. Please choose another conversation.');
    await window.refreshConversations?.();
    return false;
  }

  const conversationSessionId = String(current.sdkSessionId || current.sdk_session_id || '').trim();
  const runtimeSessionSessionId = String(current.runtimeSession?.sdkSessionId || current.runtimeSession?.sdk_session_id || '').trim();
  if (!conversationSessionId) {
    setModelBanner('⚠️ This conversation is waiting to be claimed by the relay. Please wait, or open another conversation.');
    return false;
  }
  if (!runtimeSessionSessionId || conversationSessionId !== runtimeSessionSessionId) {
    setModelBanner('⚠️ This conversation is bound to a different relay session. Wait for the matching session to claim it, or open another conversation.');
    return false;
  }

  conversations[convId] = {
    ...(conversations[convId] || {}),
    ...current,
    sdkSessionId: conversationSessionId,
    runtimeSessionId: current.runtimeSession?.id || null,
  };
  // The pill and repo browser describe the conversation being viewed; if the
  // user opened another conversation during the round trip above, applying
  // this one's session info would clobber the new view's.
  if (String(currentConvId || '').trim() === convId) {
    setRepoBrowserSessionInfo(current.sessionRootPath || '', current.sessionRootName || current.title || '');
    updateSessionPill(conversations[convId], current.runtimeSession || null);
  }
  return true;
}
