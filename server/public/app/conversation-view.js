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
  scrollBottomAfterSend,
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
} from './store.js';
import { sendMessage as sendMessageApi, cancelConversationTurn, cancelQueuedConversationTurn, cancelSubagentRun, compactConversation as compactConversationApi, scheduleContextUsageRefresh, loadConversation as loadConversationApi, loadSharedConversation, updateConversationDraft as updateConversationDraftApi, updateMessageShareVisibility } from './api-client.js';
import { enqueueOutboxRequest, registerOutboxSync } from './sync-outbox.mjs';
import { linkifyWorkspaceMentionsInNode, renderMarkdownPreview, rewriteLocalAssetUrlsInNode } from './router.js';
import { renderAttachmentMarkup, clearAttachments, uploadAttachments, setComposerAttachments, setRepoBrowserSessionInfo } from './attachments-view.js';
import { buildWorkflowRunCard } from './background-tasks-view.mjs';
import { parsePreviewCommand, runPreviewCommand } from './preview-command.mjs';
import { buildTranscriptPreviewCard } from './preview-cards.mjs';
import { closeSlashAutocomplete, handleSlashAutocompleteKey, updateSlashAutocomplete } from './slash-autocomplete.mjs';
import { evaluateUnknownCommandGuard } from './slash-commands.mjs';
import { attachCodeCopyButtons } from './code-copy.mjs';
import { relayErrorCtaActions } from './relay-error-ctas.mjs';
import { confirmCliInstall } from './cli-install-ui.js';
import { startGrokSignIn } from './grok-auth-ui.js';
import { openSettingsModal } from './settings-modal.js';
import {
  serializeDraftAttachments,
  hydrateDraftAttachments,
  mergeDraftAttachmentUpdate,
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
} from './activity-replay-state.mjs';
import { SEPARATOR_CLASS, syncSeparatorRail, syncTranscriptSeparators } from './transcript-separators.mjs';
import { deriveComposerControlState, hasComposerDraft, hasUploadingAttachments } from './composer-control-state.mjs';
import { buildLiveMessageFingerprint } from './live-message-dedupe.mjs';
import { createInfiniteLoader } from './infinite-loader.js';
import { normalizeDraftTimestampMs, isIncomingDraftTimestampStale } from './conversation-draft-timestamp-utils.mjs';
import { isChatInteractionHeld, selectionIntersectsNode } from './selection-guard.mjs';
import { buildInFlightSnapshotKey } from './in-flight-snapshot.mjs';
import { computeStablePrefixLength, planListPatch } from './streaming-dom-patch.mjs';

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
const shareVisibilityInFlight = new Set();
const SUBAGENT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'dropped', 'done']);
let lastRenderedMessageSnapshotKey = '';
let sendInFlight = false;
const COMPOSER_DRAFT_DEBOUNCE_MS = 500;
const draftSaveTimerByConversation = new Map();
const draftSavePromiseByConversation = new Map();
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
  const input = document.getElementById('msg-input');
  if (input) input.placeholder = 'Message Copilot…';
}

export function jumpToImageParent(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  const node = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!node) {
    showTransientRelayNotice('Load earlier messages to view the source image.');
    return;
  }
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
    requestAnimationFrame(() => {
      if (!el || String(currentConvId || '').trim() !== currentId) return;
      const nextScrollHeight = el.scrollHeight;
      el.scrollTop = previousScrollTop + (nextScrollHeight - previousScrollHeight);
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

function syncSendButtonState() {
  const btn = document.getElementById('send-btn');
  if (!btn) return;
  const currentTurn = getActiveTurnForConversation(currentConvId);
  const state = deriveComposerControlState({
    hasActiveTurn: !!currentTurn,
    cancelRequested: currentTurn?.cancelRequested === true,
    hasDraft: hasComposerDraft({
      text: document.getElementById('msg-input')?.value || '',
      attachmentCount: selectedAttachments.length,
    }),
    sendInFlight,
    modelMetadataBlocked: window.isModelMetadataBlocked?.() === true,
    attachmentsUploading: hasUploadingAttachments(selectedAttachments),
  });
  btn.disabled = state.disabled;
  btn.dataset.action = state.action;
  btn.textContent = state.label;
  btn.title = state.title;
}

export function syncComposerControlState() {
  syncSendButtonState();
  void scheduleConversationDraftSave({
    conversationId: currentConvId,
    draftText: document.getElementById('msg-input')?.value || '',
  });
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

function upsertConversationDraftState(conversationId, {
  draftText = '',
  draftAttachments = undefined,
  draftUpdatedAt = null,
  draftUpdatedByClientId = null,
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
    draftUpdatedAt: draftUpdatedAt || null,
    draftUpdatedByClientId: draftUpdatedByClientId || null,
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
  if (!id) return null;
  return scheduleConversationDraftSave({
    conversationId: id,
    draftText: document.getElementById('msg-input')?.value || '',
    draftAttachments: serializeDraftAttachments(selectedAttachments),
    immediate: true,
  });
}

async function persistConversationDraft(conversationId, draftText, draftAttachments = undefined) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const text = String(draftText || '');
  const runPersist = async () => {
    const baseDraftUpdatedAt = conversations[id]?.draftUpdatedAt || null;
    const response = await updateConversationDraftApi(id, {
      draftText: text,
      clientId: CLIENT_ID,
      baseDraftUpdatedAt,
      ...(draftAttachments === undefined ? {} : { draftAttachments }),
    });
    if (!response?.ok) {
      if (response?.conflict === true || response?.code === 'draft-version-conflict') {
        applyIncomingConversationDraftUpdate({
          conversationId: id,
          draftText: response.draftText || '',
          draftAttachments: response.draftAttachments,
          draftUpdatedAt: response.draftUpdatedAt || null,
          draftUpdatedByClientId: response.draftUpdatedByClientId || null,
        });
      }
      return response || null;
    }
    upsertConversationDraftState(id, {
      draftText: response.draftText,
      draftAttachments: response.draftAttachments,
      draftUpdatedAt: response.draftUpdatedAt || response.updatedAt || null,
      draftUpdatedByClientId: response.draftUpdatedByClientId || response.senderClientId || null,
    });
    return response;
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
} = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const text = String(draftText || '');
  upsertConversationDraftState(id, { draftText: text, draftAttachments });
  clearDraftTimerForConversation(id);
  if (immediate) {
    return persistConversationDraft(id, text, draftAttachments);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      draftSaveTimerByConversation.delete(id);
      persistConversationDraft(id, text, draftAttachments).then(resolve).catch(() => resolve(null));
    }, COMPOSER_DRAFT_DEBOUNCE_MS);
    draftSaveTimerByConversation.set(id, timer);
  });
}

export async function flushConversationDraft(conversationId = currentConvId) {
  const id = String(conversationId || '').trim();
  if (!id) return null;
  const input = document.getElementById('msg-input');
  const draftText = String((id === String(currentConvId || '').trim() && input) ? input.value : (conversations[id]?.draftText || ''));
  return scheduleConversationDraftSave({
    conversationId: id,
    draftText,
    immediate: true,
  });
}

export function hydrateConversationDraft(conversationId, {
  draftText = '',
  draftAttachments = [],
  draftUpdatedAt = null,
  draftUpdatedByClientId = null,
} = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return;
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
  if (String(currentConvId || '').trim() !== id) return;
  // Restore the composer's pending attachments for the conversation being opened.
  if (!draftAttachmentsEqual(selectedAttachments, hydrateDraftAttachments(normalizedAttachments))) {
    setComposerAttachments(hydrateDraftAttachments(normalizedAttachments));
  }
  const input = document.getElementById('msg-input');
  if (!input) return;
  const isFocused = document.activeElement === input;
  if (isFocused && input.value !== normalizedDraftText) {
    syncSendButtonState();
    return;
  }
  if (input.value !== normalizedDraftText) {
    input.value = normalizedDraftText;
    autoResize(input);
  }
  syncSendButtonState();
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
  if (String(currentConvId || '').trim() !== id) return;
  if (draftAttachments !== undefined) {
    const merged = mergeDraftAttachmentUpdate({
      existing: selectedAttachments,
      incoming: hydrateDraftAttachments(Array.isArray(draftAttachments) ? draftAttachments : []),
      existingUpdatedAt: conversations[id]?.draftUpdatedAt || null,
      incomingUpdatedAt: draftUpdatedAt,
      isLocalEcho: senderClientId === CLIENT_ID,
    });
    if (merged.changed) setComposerAttachments(merged.attachments);
  }
  const input = document.getElementById('msg-input');
  if (!input) return;
  const isFocused = document.activeElement === input;
  if (isFocused && input.value !== incomingDraftText) return;
  if (input.value !== incomingDraftText) {
    input.value = incomingDraftText;
    autoResize(input);
  }
  syncSendButtonState();
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

function createMessageNode(msg, msgId = null, force = false) {
  const el = getMessagesElement();
  if (!el) return null;

  if (msgId) {
    const existing = el.querySelector(`[data-message-id="${msgId}"]`);
    if (existing) return existing;
    if (!force && seenMessageIds.has(msgId)) return null;
    seenMessageIds.add(msgId);
  }

  const div = document.createElement('div');
  div.className = `msg ${msg.role}`;
  if (msgId) div.dataset.messageId = msgId;
  const fingerprint = buildLiveMessageFingerprint({
    ...(msg && typeof msg === 'object' ? msg : {}),
    id: msgId || msg?.id || '',
  });
  div.dataset.messageRole = fingerprint.role || '';
  div.dataset.messageTextFingerprint = fingerprint.text || '';
  div.dataset.messageTimestamp = String(msg?.timestamp || '').trim();
  if (fingerprint.sourceMessageId) div.dataset.sourceMessageId = fingerprint.sourceMessageId;

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
  // A turn answered by a different provider than the conversation is bound to
  // (e.g. the Copilot relay answering a Cursor conversation) must be visible,
  // not silent: it ran on another plan than the header indicates.
  const executedProvider = String(msg?.executedProvider || '').trim().toLowerCase();
  const boundProvider = String(conversations[currentConvId]?.runtimeProviderType || 'github').trim().toLowerCase();
  // 'unknown' means the responder identity did not resolve, not that another
  // provider ran the turn — no chip for it.
  const crossProviderTag = (msg.role === 'assistant' && executedProvider && executedProvider !== 'unknown' && executedProvider !== boundProvider)
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
  const promotedBoundaryEntry = promotedCompactBoundaryEntry(activities);
  const compactBoundary = compactBoundaryFromActivities(activities);
  if (compactBoundary) {
    div.dataset.compactBoundary = `${compactBoundary.preTokens ?? ''}|${compactBoundary.postTokens ?? ''}`;
  }
  if (activities.some((item) => item !== promotedBoundaryEntry)) div.classList.add('msg-with-activity');
  const thoughts = Array.isArray(msg.thoughts) ? msg.thoughts.filter((t) => t && String(t.text || '').trim()) : [];
  const attachmentHtml = attachments.length ? renderAttachmentMarkup(attachments, { messageId: msgId }) : '';
  const subagentRuns = Array.isArray(msg.subagentRuns) ? msg.subagentRuns.filter(Boolean) : [];
  const mainActivities = activities.filter((item) => !(normalizeRelayActivityEntry(item)?.subagentRunId));
  const mainThoughts = thoughts.filter((t) => !t?.subagentRunId);
  const activityHtml = mainActivities.length ? renderActivityMarkup(mainActivities, promotedBoundaryEntry) : '';
  const thoughtsHtml = mainThoughts.length ? renderThoughtsMarkup(mainThoughts) : '';
  const subagentHtml = renderSubagentRunsMarkup(subagentRuns, activities, thoughts);
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
  const isCancelInFlight = isQueuedUserMessage && bubbleCancelInFlight.has(msgId);
  const hiddenFromShares = msg?.hiddenFromShares === true;
  const activeTurnMessageId = String(getActiveTurnForConversation(currentConvId)?.messageId || '').trim();
  const sourceMessageId = String(msg?.sourceMessageId || '').trim();
  const belongsToActiveTurn = !!activeTurnMessageId
    && (activeTurnMessageId === msgId || activeTurnMessageId === sourceMessageId);
  const canToggleShareVisibility = !IS_SHARED_VIEW && !!msgId && !isQueuedUserMessage && !belongsToActiveTurn;
  const shareVisibilityActionHtml = canToggleShareVisibility
    ? `<div class="msg-share-visibility">
        ${hiddenFromShares ? '<span class="msg-hidden-label">Hidden from shared viewers</span>' : ''}
        <button type="button" class="msg-share-visibility-btn" data-action="toggle-share-visibility" data-message-id="${escHtml(msgId)}" data-hidden-from-shares="${hiddenFromShares ? 'true' : 'false'}" title="${hiddenFromShares ? 'Shows this message in shared conversations' : 'Hides this message from shared conversations'}">${hiddenFromShares ? 'Unhide' : 'Hide'}</button>
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
  const userBubbleActionsHtml = (!IS_SHARED_VIEW && isQueuedUserMessage)
    ? `<div class="msg-bubble-actions"><button type="button" class="bubble-action-btn${isCancelInFlight ? ' stopping' : ''}" data-action="cancel-queued" data-message-id="${escHtml(msgId)}"${isCancelInFlight ? ' disabled' : ''}>${isCancelInFlight ? 'Cancelling…' : 'Cancel'}</button></div>`
    : '';

  div.innerHTML = `
    <div class="${bubbleClass}">${shareVisibilityActionHtml}${thoughtsHtml}${content}${relayErrorCtaHtml}${attachmentHtml}${activityHtml}${subagentHtml}${workflowRunsHtml}${previewCardsHtml}${userBubbleActionsHtml}</div>
    <div class="msg-label">${label}${modelTag}${reasoningTag}${modeTag}${autoTag}${continuationTag}${crossProviderTag}${usageTurnTag}${usageRemainingTag}${usageStaleTag} · ${fmtDate(msg.timestamp)}</div>`;

  const bubble = div.querySelector('.msg-bubble');
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
    const next = anchor.nextSibling;
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

export function decorateActivityText(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const maskSharedPathSegments = (input) => {
    const source = String(input || '');
    const tokenMasked = source.replace(/@(file|folder):([^\s`]+)/gi, (_m, kind, rawPath) => {
      const normalized = String(rawPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
      const segments = normalized.split('/').filter(Boolean);
      const basename = segments[segments.length - 1] || normalized;
      return `@${String(kind || '').toLowerCase()}:${basename}`;
    });
    return tokenMasked.replace(/([A-Za-z]:)?(?:[\\/~.]?[\\/])(?:[^\\/\s]+[\\/])+([^\\/\s]+)/g, (_m, _prefix, basename) => basename);
  };
  const sharedSafeValue = IS_SHARED_VIEW ? maskSharedPathSegments(value) : value;
  if (/^[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(sharedSafeValue)) return sharedSafeValue;
  if (sharedSafeValue.startsWith('● ')) return `🔄 ${sharedSafeValue.slice(2).trim()}`;
  if (/^Model selected:/i.test(sharedSafeValue)) return `🧠 ${sharedSafeValue}`;
  if (/^Search \((glob|grep)\)/i.test(sharedSafeValue)) return `🔍 ${sharedSafeValue}`;
  if (/^Tool \(ask_user\)/i.test(sharedSafeValue)) return `❓ ${sharedSafeValue}`;
  if (/^Tool \(view\)/i.test(sharedSafeValue)) return `👀 ${sharedSafeValue}`;
  if (/^Tool \(apply_patch\)/i.test(sharedSafeValue)) return `🪡 ${sharedSafeValue}`;
  if (/^Tool \(powershell\)/i.test(sharedSafeValue)) return `🪓 ${sharedSafeValue}`;
  if (/^Tool \(edit\)/i.test(sharedSafeValue)) return `📝 ${sharedSafeValue}`;
  if (/^Tool \(read_file\)/i.test(sharedSafeValue)) return `📄 ${sharedSafeValue}`;
  if (/^Tool \((grep_search|file_search)\)/i.test(sharedSafeValue)) return `🔎 ${sharedSafeValue}`;
  if (/^Tool \(semantic_search\)/i.test(sharedSafeValue)) return `🧭 ${sharedSafeValue}`;
  if (/^Tool \(vscode_listCodeUsages\)/i.test(sharedSafeValue)) return `🔗 ${sharedSafeValue}`;
  if (/^Tool \(vscode_renameSymbol\)/i.test(sharedSafeValue)) return `✏️ ${sharedSafeValue}`;
  if (/^Tool \(list_dir\)/i.test(sharedSafeValue)) return `📂 ${sharedSafeValue}`;
  if (/^Tool \(create_directory\)/i.test(sharedSafeValue)) return `📁 ${sharedSafeValue}`;
  if (/^Tool \((delete|remove)\)/i.test(sharedSafeValue)) return `🗑️ ${sharedSafeValue}`;
  if (/^Tool \(execution_subagent\)/i.test(sharedSafeValue)) return `🚀 ${sharedSafeValue}`;
  if (/^Tool \(get_errors\)/i.test(sharedSafeValue)) return `🚨 ${sharedSafeValue}`;
  if (/^Tool \(debug_[^)]+\)/i.test(sharedSafeValue)) return `🐞 ${sharedSafeValue}`;
  if (/^Tool \(fetch_webpage\)/i.test(sharedSafeValue)) return `🌐 ${sharedSafeValue}`;
  if (/^Tool \(github_[^)]+\)/i.test(sharedSafeValue)) return `🐙 ${sharedSafeValue}`;
  if (/^Tool \(run_in_terminal\)/i.test(sharedSafeValue)) return `🖥️ ${sharedSafeValue}`;
  if (/^Tool \((create_file|write)\)/i.test(sharedSafeValue)) return `🆕 ${sharedSafeValue}`;
  if (/^Tool \((bash|shell|terminal)\)/i.test(sharedSafeValue)) return `🔧 ${sharedSafeValue}`;
  if (/^Tool \((sql|sqlite)\)/i.test(sharedSafeValue)) return `🗄️ ${sharedSafeValue}`;
  if (/^Tool \(/i.test(sharedSafeValue)) return `🛠️ ${sharedSafeValue}`;
  return `ℹ️ ${sharedSafeValue}`;
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
  const list = Array.isArray(activities) ? activities : [];
  const promoted = promotedBoundaryEntry === undefined
    ? promotedCompactBoundaryEntry(list)
    : promotedBoundaryEntry;
  const visible = list.filter((item) => item !== promoted);
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

// Persisted nested subagent sections: groups a finished message's activities
// and thoughts by subagentRunId and renders one collapsible block per run,
// nested by parentSubagentId — mirroring the live sub-bubbles.
export function renderSubagentRunsMarkup(subagentRuns, activities, thoughts) {
  const activityByRun = new Map();
  for (const item of (Array.isArray(activities) ? activities : [])) {
    const entry = normalizeRelayActivityEntry(item);
    if (!entry?.subagentRunId) continue;
    const list = activityByRun.get(entry.subagentRunId) || [];
    list.push(entry.text);
    activityByRun.set(entry.subagentRunId, list);
  }
  const thoughtsByRun = new Map();
  for (const thought of (Array.isArray(thoughts) ? thoughts : [])) {
    const runId = thought?.subagentRunId ? String(thought.subagentRunId).trim() : '';
    const text = String(thought?.text || '').trim();
    if (!runId || !text) continue;
    const list = thoughtsByRun.get(runId) || [];
    list.push({ reasoningId: String(thought?.reasoningId || '').trim(), text });
    thoughtsByRun.set(runId, list);
  }
  const runsById = new Map();
  for (const run of (Array.isArray(subagentRuns) ? subagentRuns : [])) {
    const runId = String(run?.subagentRunId || '').trim();
    if (!runId) continue;
    runsById.set(runId, {
      subagentRunId: runId,
      parentSubagentId: run?.parentSubagentId ? String(run.parentSubagentId).trim() : null,
      displayName: String(run?.displayName || '').trim() || `Subagent ${runId.slice(0, 8)}`,
      status: String(run?.status || 'completed').trim().toLowerCase(),
    });
  }
  // Items may reference runs whose metadata rows are unavailable; synthesize.
  for (const runId of new Set([...activityByRun.keys(), ...thoughtsByRun.keys()])) {
    if (!runsById.has(runId)) {
      runsById.set(runId, {
        subagentRunId: runId,
        parentSubagentId: null,
        displayName: `Subagent ${runId.slice(0, 8)}`,
        status: 'completed',
      });
    }
  }
  if (!runsById.size) return '';
  const childrenByParent = new Map();
  const roots = [];
  for (const run of runsById.values()) {
    const parentId = run.parentSubagentId && runsById.has(run.parentSubagentId) ? run.parentSubagentId : null;
    if (parentId) {
      const children = childrenByParent.get(parentId) || [];
      children.push(run);
      childrenByParent.set(parentId, children);
    } else {
      roots.push(run);
    }
  }
  const renderRun = (run) => {
    const runActivities = activityByRun.get(run.subagentRunId) || [];
    const runThoughts = thoughtsByRun.get(run.subagentRunId) || [];
    const children = childrenByParent.get(run.subagentRunId) || [];
    const thoughtsBlock = runThoughts.length
      ? `<details class="msg-thoughts msg-subagent-thoughts"><summary>💭 Thoughts (${runThoughts.length})</summary><div class="msg-thoughts-list">${runThoughts.map((thought) => `<div class="msg-thought-item"${thought.reasoningId ? ` data-reasoning-id="${escHtml(thought.reasoningId)}"` : ''}>${renderMarkdownPreview(thought.text, false)}</div>`).join('')}</div></details>`
      : '';
    const activitiesBlock = runActivities.length
      ? `<div class="msg-activity-list">${runActivities.map((text) => `<div class="msg-activity-item">${escHtml(decorateActivityText(text))}</div>`).join('')}</div>`
      : '';
    const childrenBlock = children.map(renderRun).join('');
    const statusLabel = run.status && run.status !== 'completed' ? ` · ${escHtml(run.status)}` : '';
    return `
      <details class="msg-activity msg-subagent-run" data-subagent-run-id="${escHtml(run.subagentRunId)}">
        <summary>🤖 ${escHtml(run.displayName)}${statusLabel}${runActivities.length ? ` (${runActivities.length})` : ''}</summary>
        ${thoughtsBlock}${activitiesBlock}${childrenBlock}
      </details>`;
  };
  return roots.map(renderRun).join('');
}

export function showThinking(messageId = null, autoScroll = true) {
  const nextMessageId = String(messageId || '').trim();
  if (nextMessageId) thinkingMessageId = nextMessageId;
  const existing = document.getElementById('thinking-indicator');
  if (existing && (!nextMessageId || String(existing.dataset.messageId || '') === nextMessageId)) {
    // Reuse the live bubble: rebuilding it every poll tick destroys any text
    // selection anchored inside and drops in-progress subagent bubbles.
    const stopBtn = existing.querySelector('[data-action="stop-turn"]');
    if (stopBtn && nextMessageId) {
      const stopping = bubbleCancelInFlight.has(nextMessageId);
      stopBtn.disabled = stopping;
      stopBtn.textContent = stopping ? 'Stopping…' : 'Stop';
      stopBtn.classList.toggle('stopping', stopping);
    }
    if (autoScroll) scrollBottom();
    return;
  }
  existing?.remove();
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg assistant';
  div.id = 'thinking-indicator';
  if (nextMessageId) div.dataset.messageId = nextMessageId;
  const isCancelInFlight = nextMessageId && bubbleCancelInFlight.has(nextMessageId);
  const stopBtnHtml = (!IS_SHARED_VIEW && nextMessageId)
    ? `<button type="button" class="bubble-action-btn${isCancelInFlight ? ' stopping' : ''}" data-action="stop-turn" data-message-id="${escHtml(nextMessageId)}"${isCancelInFlight ? ' disabled' : ''}>${isCancelInFlight ? 'Stopping…' : 'Stop'}</button>`
    : '';
  div.innerHTML = `
    <div class="thinking-bubble">
      <div class="thinking-bubble-header">${stopBtnHtml}</div>
      <details id="thinking-thoughts" class="thinking-thoughts-panel" open>
        <summary>💭 Thoughts</summary>
        <div class="thinking-thoughts-list"></div>
      </details>
      <div id="thinking-stream" class="thinking-stream" hidden></div>
      <div class="dots"><span></span><span></span><span></span></div>
      <div id="thinking-activity" class="thinking-activity"></div>
      <div class="subagent-bubbles-container" data-subagent-bubbles-root="1"></div>
    </div>`;
  const target = nextMessageId ? el.querySelector(`[data-message-id="${nextMessageId}"]`) : null;
  if (target && target.parentNode === el) {
    const next = target.nextSibling;
    if (next) el.insertBefore(div, next);
    else el.appendChild(div);
  } else {
    el.appendChild(div);
  }
  renderThinkingThoughts();
  renderThinkingStream();
  if (autoScroll) scrollBottom();
}

export function removeThinking() {
  thinkingMessageId = null;
  lastInFlightSnapshotKey = '';
  document.getElementById('thinking-indicator')?.remove();
}

export function collapseThinkingThoughts() {
  const panel = document.getElementById('thinking-thoughts');
  if (!(panel instanceof HTMLDetailsElement)) return;
  panel.open = false;
  panel.querySelectorAll('.thinking-thought').forEach((row) => {
    if (row instanceof HTMLDetailsElement) row.open = false;
  });
}

function clearRelayStreamState(messageId = null) {
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
  for (const [subagentRunId, expected] of bySubagentRun) {
    const bubble = ensureSubagentBubble(subagentRunId);
    const runBox = bubble?.querySelector('.subagent-activity');
    if (runBox && !selectionIntersectsNode(runBox)) {
      patchActivityList(runBox, expected, 'subagent-activity-item');
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
  // identical content.
  const snapshotKey = buildInFlightSnapshotKey(inFlight);
  if (snapshotKey === lastInFlightSnapshotKey && document.getElementById('thinking-indicator')) {
    return;
  }
  lastInFlightSnapshotKey = snapshotKey;
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
  if (streamTextByThread.main) {
    relayStreamTextByMessageId.set(messageId, streamTextByThread.main.text);
  }
  for (const [runId, entry] of streamTextByThread.bySubagentRunId) {
    upsertSubagentRun({ subagentRunId: runId, messageId, conversationId: currentConvId });
    setSubagentStreamText(runId, entry.text);
  }
  showThinking(messageId, autoScroll);
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
  // the persisted message, so it never shows as live prose.
  if (isCompactBoundaryActivityEntry(entry)) return;
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
    return bubble;
  }

  const parentSubagentId = getSubagentParentId(id);
  const container = findSubagentBubbleContainer(parentSubagentId, depth);
  if (!container) return null;

  bubble = document.createElement('div');
  bubble.className = 'subagent-bubble';
  bubble.dataset.subagentRunId = id;

  const header = document.createElement('div');
  header.className = 'subagent-bubble-header';

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

  return bubble;
}

function updateSubagentBubbleStatus(bubble, status) {
  if (!bubble) return;
  const statusSpan = bubble.querySelector('.subagent-bubble-status');
  if (!statusSpan) return;
  const normalized = normalizeSubagentBubbleStatus(status);
  statusSpan.dataset.status = normalized;
  statusSpan.textContent = normalized === 'running' ? '● Running' : normalized.charAt(0).toUpperCase() + normalized.slice(1);
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
  if (subagentStopUnsupported.has(id)) {
    btn.disabled = true;
    btn.textContent = 'Stop unavailable';
    btn.title = 'Targeted subagent stop is not supported by this provider; use Stop on the whole turn.';
    btn.classList.remove('stopping');
    return;
  }
  const status = normalizeSubagentBubbleStatus(statusOverride || getSubagentStatus(id));
  const terminal = isSubagentTerminalStatus(status);
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
  return true;
}

export function flushDeferredMessageRender() {
  if (!deferredMessageRender) return;
  const { msgs, scroll, meta } = deferredMessageRender;
  deferredMessageRender = null;
  const deferredConversationId = String(meta?.conversationId || '').trim();
  if (deferredConversationId && deferredConversationId !== String(currentConvId || '').trim()) return;
  renderMessages(msgs, scroll, meta);
}

export function clearRelayStreamStateForMessage(messageId) {
  const id = String(messageId || '').trim();
  if (id) {
    completedMessageIds.add(id);
    if (completedMessageIds.size > 100) {
      completedMessageIds.delete(completedMessageIds.values().next().value);
    }
  }
  clearRelayStreamState(messageId);
}

export function applyConversationTurnStatus({ conversationId, messageId, status }) {
  const conversationKey = String(conversationId || '').trim();
  const messageKey = String(messageId || '').trim();
  const normalizedStatus = String(status || '').trim().toLowerCase();
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

async function stopCurrentConversationTurn(conversationId) {
  const conversationKey = String(conversationId || '').trim();
  const activeTurn = getActiveTurnForConversation(conversationKey);
  if (!conversationKey || !activeTurn?.messageId) return;
  if (activeTurn.cancelRequested) return;
  if (isMobileComposerViewport() && !confirm('Stop the current turn?')) return;
  setConversationTurnState(conversationKey, {
    messageId: activeTurn.messageId,
    status: activeTurn.status || 'processing',
    cancelRequested: true,
  });
  const expectedMessageId = activeTurn.messageId;
  const result = await cancelConversationTurn(conversationKey, {
    clientId: CLIENT_ID,
    messageId: expectedMessageId,
  });
  if (!result?.ok) {
    setConversationTurnState(conversationKey, {
      messageId: expectedMessageId,
      status: activeTurn.status || 'processing',
      cancelRequested: false,
    });
    showTransientRelayNotice('Could not stop the current turn.');
    return;
  }
  if (
    result.acknowledgement === 'already-finished'
    || result.acknowledgement === 'no-active-turn'
    || result.acknowledgement === 'message-mismatch'
  ) {
    const latestTurn = getActiveTurnForConversation(conversationKey);
    if (latestTurn?.messageId === expectedMessageId) {
      setConversationTurnState(conversationKey, null);
    }
    showTransientRelayNotice('That turn already finished.');
    return;
  }
  if (result.acknowledgement === 'active-turn-unbound') {
    const latestTurn = getActiveTurnForConversation(conversationKey);
    if (latestTurn?.messageId === expectedMessageId) {
      setConversationTurnState(conversationKey, {
        messageId: expectedMessageId,
        status: activeTurn.status || 'processing',
        cancelRequested: false,
      });
    }
    showTransientRelayNotice('The active turn is not bound to a live SDK session.');
    return;
  }
  showTransientRelayNotice('Stopping the current turn…');
}

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

export function clearBubbleCancelState(messageId) {
  const id = String(messageId || '').trim();
  if (!id) return;
  bubbleCancelInFlight.delete(id);
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
    showTransientRelayNotice('Could not update shared-message visibility.');
    return;
  }

  showTransientRelayNotice(result.hiddenFromShares
    ? 'Message hidden from shared viewers.'
    : 'Message visible to shared viewers.');
  // The reload below only refreshes the open view; if the user switched
  // conversations while the toggle round trip was in flight, rendering it
  // would replace the new conversation's messages with this one's.
  if (String(currentConvId || '').trim() !== conversationKey) return;
  const response = await loadConversationApi(conversationKey, {
    limit: Math.max(CONVERSATION_HISTORY_PAGE_SIZE, getConversationLoadedMessageCount()),
  });
  if (String(currentConvId || '').trim() !== conversationKey) return;
  if (response?.messages) {
    renderMessages(response.messages, false, response);
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
  const btn = event.target.closest('.bubble-action-btn, .msg-share-visibility-btn');
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

  if (action === 'stop-turn' && messageId) {
    event.preventDefault();
    event.stopPropagation();
    void stopTurnByMessageId(currentConvId, messageId);
  }

  if (action === 'cancel-queued' && messageId) {
    event.preventDefault();
    event.stopPropagation();
    void cancelQueuedTurnByMessageId(currentConvId, messageId);
  }

  if (action === 'stop-subagent' && subagentRunId) {
    event.preventDefault();
    event.stopPropagation();
    void cancelSubagentByRunId(currentConvId, subagentRunId);
  }
}

export function initBubbleActionHandlers() {
  const messagesEl = document.getElementById('messages');
  if (!messagesEl) return;
  messagesEl.addEventListener('click', handleBubbleActionClick);
}

export function appendMessage(msg, scroll = true, msgId = null, force = false, insertAfterId = null, trackHistory = true) {
  const el = getMessagesElement();
  if (!el) return null;
  const empty = el.querySelector('.empty-state');
  if (empty) empty.remove();
  const node = createMessageNode(msg, msgId, force);
  const isNewNode = !!node && !node.parentNode;
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
  const messageById = new Map(
    ordered
      .map((item) => [String(item?.id || '').trim(), item])
      .filter(([id]) => !!id),
  );
  if (!ordered.length) {
    el.innerHTML = `<div class="empty-state">
      <div class="icon">${currentConvId ? '💬' : '🚀'}</div>
      <h3>${currentConvId ? 'No messages yet' : 'New Conversation'}</h3>
      <p>${currentConvId ? 'Start the conversation below' : 'Type your first message below'}</p>
    </div>`;
    resetConversationHistoryState();
    renderRelayQuestions();
    renderRelayBoards();
    lastRenderedMessageSnapshotKey = snapshotKey;
    return true;
  }
  const conversationId = String(meta.conversationId || currentConvId || '').trim();
  const pageInfo = meta.pageInfo && typeof meta.pageInfo === 'object' ? meta.pageInfo : null;
  const hasMoreOlder = typeof meta.hasMoreOlder === 'boolean'
    ? meta.hasMoreOlder
    : (typeof meta.hasMoreHistory === 'boolean' ? meta.hasMoreHistory : !!pageInfo?.hasMoreOlder || !!pageInfo?.hasMore);
  const hasMoreNewer = typeof meta.hasMoreNewer === 'boolean'
    ? meta.hasMoreNewer
    : !!pageInfo?.hasMoreNewer;
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

export function focusConversationMessageById(messageId, { behavior = 'smooth', block = 'center' } = {}) {
  const id = String(messageId || '').trim();
  if (!id) return false;
  const el = getMessagesElement();
  if (!el) return false;
  const target = el.querySelector(`[data-message-id="${id}"]`);
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

export async function sendMessage() {
  const input = document.getElementById('msg-input');
  const originalComposerText = String(input?.value || '');
  const text = originalComposerText.trim();
  const mobileSend = isMobileComposerViewport();
  const activeTurn = getActiveTurnForConversation(currentConvId);
  const hasDraft = hasComposerDraft({ text, attachmentCount: selectedAttachments.length });
  if (sendInFlight) {
    showTransientRelayNotice('Please wait for the current message to finish sending.');
    return;
  }
  if (!hasDraft) return;
  closeSlashAutocomplete();

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
    compactCurrentConversation();
    scrollBottomAfterSend();
    return;
  }

  const previewCommand = selectedAttachments.length === 0 ? parsePreviewCommand(text) : null;
  if (previewCommand) {
    input.value = '';
    autoResize(input);
    releaseComposerFocusAfterSend(input);
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
    clearDraftTimerForConversation(targetConversationId);
  }

  setSendInFlight(true);
  let attachments = [];
  let clientMessageId = null;
  try {
    attachments = await uploadAttachments(draftAttachments);

    const isNew = !targetConversationId;
    const msgTimestamp = new Date().toISOString();
    if (!selectedReasoningEffort) {
      showTransientRelayNotice('Select a reasoning effort after refreshing model metadata.');
      return;
    }
    const titleSeed = text || (attachments[0]?.name || 'Attachment');
    clientMessageId = generateId();
    trackPendingUserMessage(clientMessageId, targetConversationId, text);
    pendingUserMessageIds.add(clientMessageId);
    if (viewingSendConversation()) {
      input.value = '';
      autoResize(input);
      releaseComposerFocusAfterSend(input);
      appendMessage({ role: 'user', text, model: selectedModel, mode: selectedMode, timestamp: msgTimestamp, attachments }, true, clientMessageId, true);
      scrollBottomAfterSend();
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
          if (viewingSendConversation()) clearAttachments();
          return;
        }
      }
      clearPendingUserMessage(clientMessageId);
      const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
      pendingNode?.remove();
      pendingUserMessageIds.delete(clientMessageId);
      seenMessageIds.delete(clientMessageId);
      if (viewingSendConversation()) {
        input.value = originalComposerText;
        autoResize(input);
      }
      void scheduleConversationDraftSave({
        conversationId: targetConversationId,
        draftText: originalComposerText,
        immediate: true,
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
        clearAttachments();
        if (!mobileSend) input.focus();
        scrollBottomAfterSend();
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
      }
      conversations[r.conversationId] = {
        id: r.conversationId,
        title: titleSeed.slice(0, 60),
        updatedAt: new Date().toISOString(),
        messageCount: 1,
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
    const persistedConversationId = String(r.conversationId || targetConversationId || '').trim();
    if (persistedConversationId) {
      await scheduleConversationDraftSave({
        conversationId: persistedConversationId,
        draftText: '',
        immediate: true,
      });
      upsertConversationDraftState(persistedConversationId, {
        draftText: '',
        draftUpdatedAt: new Date().toISOString(),
        draftUpdatedByClientId: CLIENT_ID,
      });
    }
    if (cliOnline && viewingSendConversation()) showThinking(r.messageId || null);

    if (viewingSendConversation()) {
      clearAttachments();
      if (!mobileSend) input.focus();
      scrollBottomAfterSend();
    }
  } catch (e) {
    if (clientMessageId) {
      clearPendingUserMessage(clientMessageId);
      const pendingNode = document.querySelector(`[data-message-id="${clientMessageId}"]`);
      pendingNode?.remove();
      pendingUserMessageIds.delete(clientMessageId);
      seenMessageIds.delete(clientMessageId);
    }
    if (viewingSendConversation()) {
      input.value = originalComposerText;
      autoResize(input);
    }
    void scheduleConversationDraftSave({
      conversationId: targetConversationId,
      draftText: originalComposerText,
      immediate: true,
    });
    alert(e.message || 'Failed to send message');
  } finally {
    setSendInFlight(false);
  }
}

// Textarea input hook (inline oninput beside autoResize): keeps the slash
// menu in sync with the caret. Cheap no-op for non-slash text.
export function updateComposerSlashMenu(input) {
  updateSlashAutocomplete(input, { conversationId: currentConvId });
}

export function handleKey(e) {
  // The open menu owns navigation keys; Ctrl/Cmd+Enter still falls through to
  // send because the menu never consumes it.
  if (handleSlashAutocompleteKey(e, e.target)) return;
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
