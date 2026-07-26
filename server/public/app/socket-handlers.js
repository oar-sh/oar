import {
  BASE,
  TOKEN,
  CLIENT_ID,
  currentConvId,
  conversations,
  seenMessageIds,
  pendingUserMessageIds,
  relayActivities,
  relayThoughts,
  relayQuestions,
  relayBoards,
  relayQuestionDrafts,
  repoBrowserState,
  setRelayOnline,
  setCliOnline,
  setCurrentConv,
  updateWorkspaceRootHints,
  updateCompactButton,
  updateSessionPill,
  clearPendingUserMessage,
  hasPendingUserMessageDuplicate,
  isMessagesAtBottom,
  upsertSubagentRun,
  addSubagentActivity,
  addSubagentThought,
  clearSubagentCancelInFlight,
  setConversationWatcherCount,
} from './store.js';
import { scheduleContextUsageRefresh } from './api-client.js';
import { publishStatusEvent } from './status-store.mjs';
import { renderConvList, refreshConversations, openConversation } from './journal-view.js';
import {
  upsertRelayQuestion,
  loadRelayQuestions,
  updatePendingQuestionBanner,
} from './ask-user-view.js';
import { upsertRelayBoard, loadRelayBoards, renderRelayBoards } from './relay-board-view.js';
import {
  showThinking,
  removeThinking,
  collapseThinkingThoughts,
  renderThinkingActivities,
  appendThinkingActivity,
  appendThinkingThought,
  applyRelayStreamEvent,
  clearRelayStreamStateForMessage,
  applyConversationTurnStatus,
  renderMessages,
  appendMessage,
  applyIncomingConversationDraftUpdate,
  getRenderedConversationMessageFingerprints,
  clearBubbleCancelState,
  removeUserBubbleCancelButton,
  updateSubagentBubbleFromStatus,
} from './conversation-view.js';
import { loadRepoBrowserTree } from './attachments-view.js';
import { clearMessageSearchRuntimeState } from './message-search-view.js';
import { stripRelayPromptContext } from './relay-prompt-sanitizer.mjs';
import { isLikelyLiveDuplicateMessage } from './live-message-dedupe.mjs';
import { mergeRelayThoughts } from './relay-thoughts.mjs';

const FALLBACK_MODE = 'agent';

/** @type {import('socket.io-client').Socket | null} */
let socket = null;
let socketActivityEnabled = true;
let lastSocketErrorSignature = '';
let lastSocketErrorAt = 0;

/** @type {SocketHandlerDeps | null} */
let deps = null;

/**
 * @typedef {Object} SocketHandlerDeps
 * @property {() => (void | Promise<void>)} refreshCurrentView
 * @property {() => (void | Promise<void>)} refreshSessionWorkerStatus
 * @property {(force?: boolean) => (void | Promise<void>)} refreshModelCatalog
 * @property {(payload?: object) => void} updateModelCatalogState
 * @property {() => (void | Promise<void>)} reconcileOpenModelVariantModal
 * @property {(payload?: object) => void} applyConversationWorkspaceRootUpdate
 * @property {(conversationId: string, title: string, updatedAt?: string | number | null) => void} applyConversationTitleUpdate
 * @property {() => void} syncChatTitleControls
 * @property {(conversationId: string, payload?: object) => void} applyConversationPreferencesForConversation
 * @property {(payload?: object) => void} applyOpenAISettingsState
 */

/**
 * Register bootstrap-local callbacks required by socket event handlers.
 * @param {SocketHandlerDeps} nextDeps
 */
export function initSocketHandlers(nextDeps) {
  deps = nextDeps;
}

export function getSocket() {
  return socket;
}

export function setSocketActivityEnabled(value) {
  socketActivityEnabled = !!value;
  if (!socket) return;
  if (!socketActivityEnabled) {
    if (socket.connected || socket.active) socket.disconnect();
    return;
  }
  if (!socket.connected) socket.connect();
}

function requireDeps() {
  if (!deps) {
    throw new Error('socket-handlers: call initSocketHandlers() before connectSocket()');
  }
  return deps;
}

export async function connectSocket(overrideDeps) {
  if (overrideDeps) {
    deps = overrideDeps;
  }
  const {
    refreshCurrentView,
    refreshSessionWorkerStatus,
    refreshModelCatalog,
    updateModelCatalogState,
    reconcileOpenModelVariantModal = async () => {},
    applyConversationWorkspaceRootUpdate,
    applyConversationTitleUpdate,
    syncChatTitleControls,
    applyConversationPreferencesForConversation,
  } = requireDeps();

  if (socket) {
    if (socketActivityEnabled && !socket.connected) socket.connect();
    return socket;
  }

  socket = io({
    path: `${BASE}/socket.io/`,
    auth: TOKEN ? { token: TOKEN, clientId: CLIENT_ID } : { clientId: CLIENT_ID },
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5,
    timeout: 10000,
    transports: ['websocket', 'polling'],
  });

  socket.on('connect', () => {
    lastSocketErrorSignature = '';
    lastSocketErrorAt = 0;
    console.log('Socket connected');
    clearMessageSearchRuntimeState();
    setRelayOnline(true);
    setCliOnline(true);
    renderConvList();
    refreshCurrentView().catch(() => {});
    refreshSessionWorkerStatus().catch(() => {});
    refreshModelCatalog().catch(() => {});
  });
  socket.on('connect_error', (e) => {
    setRelayOnline(false);
    const message = String(e?.message || 'unknown').trim() || 'unknown';
    const signature = `socket-error:${message}`;
    const now = Date.now();
    if (signature !== lastSocketErrorSignature || (now - lastSocketErrorAt) > 8000) {
      lastSocketErrorSignature = signature;
      lastSocketErrorAt = now;
      console.error('Socket error:', message);
    }
  });
  socket.on('disconnect', () => {
    setRelayOnline(false);
  });
  socket.on('cli_status', ({ online }) => {
    setCliOnline(online);
    renderConvList();
    if (online) refreshCurrentView().catch(() => {});
    refreshSessionWorkerStatus().catch(() => {});
    if (online) refreshModelCatalog().catch(() => {});
  });
  socket.on('models_updated', (payload) => {
    updateModelCatalogState(payload || {});
    void reconcileOpenModelVariantModal();
  });
  socket.on('openai_settings_updated', (payload) => {
    deps?.applyOpenAISettingsState?.(payload || {});
    if (Number(payload?.reconciliation?.updatedUnstartedConversations || 0) > 0) {
      void Promise.resolve()
        .then(() => deps?.refreshCurrentView?.())
        .catch(() => {});
    }
  });
  socket.on('shared_access', (event) => {
    publishStatusEvent(event);
  });
  socket.on('workspace_root_changed', (payload) => {
    updateWorkspaceRootHints(payload || {});
    if (repoBrowserState.activeRoot !== 'workspace') return;
    repoBrowserState.currentPath = '';
    if (repoBrowserState.open) {
      void loadRepoBrowserTree();
    }
  });
  socket.on('conversation_workspace_root_updated', (payload) => {
    updateWorkspaceRootHints(payload || {});
    applyConversationWorkspaceRootUpdate(payload || {});
  });
  socket.on('user_message', ({ conversationId, messageId, senderClientId, message }) => {
    const normalizedMessage = {
      ...(message && typeof message === 'object' ? message : {}),
      text: stripRelayPromptContext(message?.text, message?.mode),
    };
    if (senderClientId && senderClientId === CLIENT_ID) {
      pendingUserMessageIds.delete(messageId);
      return;
    }
    if (messageId && (pendingUserMessageIds.has(messageId) || seenMessageIds?.has(messageId))) {
      pendingUserMessageIds.delete(messageId);
      return;
    }
    if (conversationId === currentConvId) {
      const renderedMessages = getRenderedConversationMessageFingerprints(24);
      const hasPendingTextMatch = hasPendingUserMessageDuplicate(conversationId, normalizedMessage.text);
      if (isLikelyLiveDuplicateMessage({
        incomingMessageId: messageId,
        incomingMessage: normalizedMessage,
        existingMessages: renderedMessages,
        hasPendingTextMatch,
      })) {
        return;
      }
      appendMessage(normalizedMessage, true, messageId);
    }
  });
  socket.on('assistant_message', ({ conversationId, message, messageId, sourceMessageId }) => {
    const isCurrentConversation = conversationId === currentConvId;
    const autoScroll = isCurrentConversation ? isMessagesAtBottom() : false;
    collapseThinkingThoughts();
    removeThinking();
    if ((!message?.activities || !message.activities.length) && sourceMessageId) {
      const cached = relayActivities.get(sourceMessageId) || [];
      if (cached.length) message.activities = cached.slice(0, 48);
    }
    if (sourceMessageId) {
      const persistedThoughts = Array.isArray(message?.thoughts) ? message.thoughts : [];
      const cachedThoughts = relayThoughts.get(sourceMessageId);
      const mergedThoughts = mergeRelayThoughts(persistedThoughts, cachedThoughts);
      if (mergedThoughts.length) {
        message.thoughts = mergedThoughts;
      }
    }
    if (messageId && seenMessageIds?.has(messageId)) return;
    if (isCurrentConversation) {
      appendMessage(message, autoScroll, messageId || null, false, sourceMessageId || null);
      scheduleContextUsageRefresh(conversationId, 120);
    }
    if (sourceMessageId) relayActivities.delete(sourceMessageId);
    if (sourceMessageId) relayThoughts.delete(sourceMessageId);
    if (sourceMessageId) clearRelayStreamStateForMessage(sourceMessageId);
    refreshSessionWorkerStatus().catch(() => {});
  });
  socket.on('relay_question', ({ question }) => upsertRelayQuestion(question));
  socket.on('relay_question_updated', ({ question }) => upsertRelayQuestion(question));
  socket.on('relay_question_changed', () => {
    loadRelayQuestions(currentConvId);
  });
  socket.on('relay_board', ({ board }) => upsertRelayBoard(board));
  socket.on('relay_board_updated', ({ board }) => upsertRelayBoard(board));
  socket.on('relay_board_changed', () => {
    loadRelayBoards();
  });
  socket.on('relay_activity', ({ conversationId, messageId, text, subagentRunId }) => {
    if (!messageId || !text) return;
    const entry = {
      text: String(text || '').trim(),
      subagentRunId: subagentRunId ? String(subagentRunId).trim() : null,
    };
    if (!entry.text) return;
    const items = relayActivities.get(messageId) || [];
    const last = items[items.length - 1];
    const lastText = typeof last === 'string' ? last : String(last?.text || '');
    const lastSubagentRunId = typeof last === 'object' && last ? (last.subagentRunId || null) : null;
    if (lastText !== entry.text || lastSubagentRunId !== entry.subagentRunId) {
      relayActivities.set(messageId, items.concat(entry).slice(-24));
    }
    if (entry.subagentRunId) {
      upsertSubagentRun({ subagentRunId: entry.subagentRunId, messageId, conversationId });
      addSubagentActivity(entry.subagentRunId, entry.text);
    }
    if (conversationId === currentConvId) {
      const autoScroll = isMessagesAtBottom();
      appendThinkingActivity(entry.text, entry.subagentRunId, autoScroll);
    }
  });
  socket.on('relay_stream', ({ conversationId, messageId, text, done, seq }) => {
    if (!messageId) return;
    if (conversationId !== currentConvId) return;
    const autoScroll = isMessagesAtBottom();
    applyRelayStreamEvent({
      messageId,
      text: String(text || ''),
      done: !!done,
      seq,
      autoScroll,
    });
  });
  socket.on('relay_thought', ({ conversationId, messageId, reasoningId, text, done, subagentRunId }) => {
    if (!messageId) return;
    const key = String(reasoningId || 'reasoning');
    const thoughtMap = relayThoughts.get(messageId) || new Map();
    thoughtMap.set(key, { reasoningId: key, text: String(text || ''), done: !!done, subagentRunId: subagentRunId || null });
    relayThoughts.set(messageId, thoughtMap);
    if (subagentRunId) {
      upsertSubagentRun({ subagentRunId, messageId, conversationId });
      addSubagentThought(subagentRunId, { reasoningId: key, text: String(text || ''), done: !!done });
    }
    if (conversationId === currentConvId) {
      const autoScroll = isMessagesAtBottom();
      appendThinkingThought(key, String(text || ''), !!done, subagentRunId, autoScroll);
    }
  });
  socket.on('subagent_status', ({ conversationId, messageId, subagentRunId, parentSubagentId, displayName, status, timestamp }) => {
    if (!messageId || !subagentRunId) return;
    upsertSubagentRun({
      subagentRunId,
      messageId,
      conversationId,
      parentSubagentId,
      displayName,
      status,
      timestamp,
    });
    clearSubagentCancelInFlight(subagentRunId);
    if (conversationId === currentConvId) {
      updateSubagentBubbleFromStatus(subagentRunId, status);
    }
  });
  socket.on('conversation_compacted', async ({ sourceConversationId, targetConversationId }) => {
    if (!sourceConversationId || !targetConversationId) return;
    await refreshConversations();
    if (currentConvId === sourceConversationId) {
      await openConversation(targetConversationId);
    } else {
      updateCompactButton();
    }
  });
  socket.on('conversation_title_updated', ({ conversationId, title, updatedAt }) => {
    applyConversationTitleUpdate(conversationId, title, updatedAt);
    syncChatTitleControls();
  });
  socket.on('conversation_preferences_updated', ({ conversationId, preferredRelayMode, preferredModelsByMode, preferredReasoningByMode, senderClientId }) => {
    if (senderClientId && senderClientId === CLIENT_ID) return;
    const id = String(conversationId || '').trim();
    if (!id || !conversations[id]) return;
    conversations[id] = {
      ...conversations[id],
      preferredRelayMode: preferredRelayMode || conversations[id].preferredRelayMode || FALLBACK_MODE,
      preferredModelsByMode: preferredModelsByMode || conversations[id].preferredModelsByMode || {},
      preferredReasoningByMode: preferredReasoningByMode || conversations[id].preferredReasoningByMode || {},
    };
    if (String(currentConvId || '').trim() === id) {
      applyConversationPreferencesForConversation(id, {
        preferredRelayMode,
        preferredModelsByMode,
        preferredReasoningByMode,
      });
    }
  });
  socket.on('conversation_draft_updated', (payload = {}) => {
    applyIncomingConversationDraftUpdate(payload || {});
  });
  socket.on('conversation_watchers', ({ conversationId, watcherCount }) => {
    setConversationWatcherCount(conversationId, watcherCount);
    deps?.syncChatTitleControls?.();
  });
  socket.on('conversation_session_bound', async ({ conversationId, sdkSessionId, runtimeSessionId }) => {
    const id = String(conversationId || '').trim();
    if (!id) return;
    if (conversations[id]) {
      conversations[id] = {
        ...conversations[id],
        sdkSessionId: String(sdkSessionId || conversations[id].sdkSessionId || '').trim() || null,
        runtimeSessionId: String(runtimeSessionId || conversations[id].runtimeSessionId || '').trim() || null,
      };
    }
    await refreshConversations();
    if (currentConvId === id) {
      await openConversation(id);
    }
  });
  socket.on('message_status', ({ messageId, conversationId, status }) => {
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const clearsProcessingStatus = ['done', 'failed', 'dropped', 'pending', 'parked', 'cancelled'].includes(normalizedStatus);
    applyConversationTurnStatus({ conversationId, messageId, status });
    if (conversationId && conversations[conversationId]) {
      const conversation = conversations[conversationId];
      if (normalizedStatus === 'processing') {
        conversation.localTurnStatus = 'processing';
        conversation.localTurnStatusUpdatedAt = Date.now();
        conversation.localTurnMessageId = String(messageId || '').trim() || null;
      } else if (clearsProcessingStatus) {
        const trackedMessageId = String(conversation.localTurnMessageId || '').trim();
        const incomingMessageId = String(messageId || '').trim();
        if (!trackedMessageId || !incomingMessageId || trackedMessageId === incomingMessageId) {
          delete conversation.localTurnStatus;
          delete conversation.localTurnStatusUpdatedAt;
          delete conversation.localTurnMessageId;
        }
      }
    }
    if (conversationId === currentConvId && normalizedStatus === 'processing') {
      const autoScroll = isMessagesAtBottom();
      showThinking(messageId || null, autoScroll);
      renderThinkingActivities();
      if (messageId) removeUserBubbleCancelButton(messageId);
    }
    if (clearsProcessingStatus) {
      clearPendingUserMessage(messageId);
      if (messageId) clearRelayStreamStateForMessage(messageId);
      if (messageId) clearBubbleCancelState(messageId);
      if (messageId) removeUserBubbleCancelButton(messageId);
    }
    if (conversationId === currentConvId && clearsProcessingStatus) {
      collapseThinkingThoughts();
      removeThinking();
      void refreshCurrentView().catch(() => {});
      scheduleContextUsageRefresh(conversationId, 220);
      refreshSessionWorkerStatus().catch(() => {});
    }
    renderConvList();
  });
  socket.on('conversation_deleted', ({ conversationId }) => {
    delete conversations[conversationId];
    for (const [id, question] of relayQuestions.entries()) {
      if (question?.conversationId === conversationId) relayQuestions.delete(id);
    }
    for (const [id, board] of relayBoards.entries()) {
      if (board?.conversationId === conversationId) relayBoards.delete(id);
    }
    for (const id of relayQuestionDrafts.keys()) {
      const q = relayQuestionDrafts.get(id);
      if (!q || q.conversationId === conversationId) relayQuestionDrafts.delete(id);
    }
    updatePendingQuestionBanner();
    renderRelayBoards();
    renderConvList();
    if (currentConvId === conversationId) {
      setCurrentConv(null);
      renderMessages([]);
      document.getElementById('chat-title').textContent = 'Select or start a conversation';
      syncChatTitleControls();
      updateSessionPill(null, null);
      updateCompactButton();
      scheduleContextUsageRefresh(null);
    } else {
      updateCompactButton();
    }
  });

  if (socketActivityEnabled) {
    socket.connect();
  }
  return socket;
}
