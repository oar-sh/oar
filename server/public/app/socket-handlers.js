import {
  BASE,
  TOKEN,
  CLIENT_ID,
  DEVICE_ID,
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
  setCloudflaredTunnelState,
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
import { publishStatusEvent, recordStatusEvent } from './status-store.mjs';
import { renderConvList, refreshConversations, openConversation } from './journal-view.js';
import {
  upsertRelayQuestion,
  loadRelayQuestions,
  updatePendingQuestionBanner,
} from './ask-user-view.js';
import { upsertRelayBoard, loadRelayBoards, renderRelayBoards } from './relay-board-view.js';
import { setConversationBackgroundTasks } from './background-tasks-view.mjs';
import { setPreviews } from './preview-cards.mjs';
import { applyClaudeAuthState } from './claude-auth-ui.js';
import {
  showThinking,
  removeThinking,
  collapseThinkingThoughts,
  renderThinkingActivities,
  renderThinkingThoughts,
  renderRestoredSubagentBubbles,
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
  markSubagentStopUnsupported,
} from './conversation-view.js';
import { loadRepoBrowserTree, refreshRepoBrowserIfWorkspaceOpen } from './attachments-view.js';
import { clearMessageSearchRuntimeState } from './message-search-view.js';
import { stripRelayPromptContext } from './relay-prompt-sanitizer.mjs';
import { isLikelyLiveDuplicateMessage } from './live-message-dedupe.mjs';
import { mergeRelayThoughts } from './relay-thoughts.mjs';

const FALLBACK_MODE = 'agent';

// How long a liveness probe waits for its ack before declaring the transport a
// zombie. Comfortably above one mobile round-trip, far below the ~45s the
// engine's own ping timeout would need — which is the timer an Android freeze
// may have discarded, making the probe necessary in the first place.
const SOCKET_LIVENESS_TIMEOUT_MS = 5000;

/** @type {import('socket.io-client').Socket | null} */
let socket = null;
let socketActivityEnabled = true;
let livenessProbeInFlight = false;
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
 * @property {(payload?: object) => void} applyClaudeSettingsState
 * @property {(payload?: object) => void} applyGrokSettingsState
 * @property {(payload?: object) => void} applyCursorSettingsState
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

/**
 * Report this device's foreground state to the server, which uses it to decide
 * whether push notifications should be suppressed. Safe to call in any state:
 * a disconnected or absent socket makes it a no-op (the connect handler
 * re-asserts visibility as soon as the socket is back).
 */
export function emitDeviceVisibility(visible) {
  if (!socket?.connected) return;
  socket.emit('device_visibility', { deviceId: DEVICE_ID, visible: visible === true });
}

/**
 * Close the transport rather than the namespace socket when backgrounding.
 *
 * socket.disconnect() makes the server report "client namespace disconnect", which
 * is absent from socket.io's RECOVERABLE_DISCONNECT_REASONS, so the session is
 * discarded and connectionStateRecovery replays nothing when the phone returns.
 * Closing the engine surfaces as "transport close", which is recoverable. Manager
 * reconnection is suspended first so the close does not immediately trigger the
 * backoff loop we are trying to avoid while hidden.
 */
function suspendSocketForBackground() {
  // The "now hidden" heartbeat has to leave before the transport closes or it
  // never arrives and the device looks active until its socket drops.
  emitDeviceVisibility(false);
  const manager = socket?.io;
  manager?.reconnection(false);
  if (manager?.engine) {
    manager.engine.close();
    return;
  }
  if (socket?.connected || socket?.active) socket.disconnect();
}

function resumeSocketFromBackground() {
  socket?.io?.reconnection(true);
  if (socket && !socket.connected) socket.connect();
}

export function setSocketActivityEnabled(value) {
  socketActivityEnabled = !!value;
  if (!socket) return;
  if (!socketActivityEnabled) {
    suspendSocketForBackground();
    return;
  }
  resumeSocketFromBackground();
}

/**
 * Bring the relay socket back up, whatever state the manager is in. Safe to call on a
 * timer: connect() skips the manager while it is mid-backoff, so this cannot compete
 * with socket.io's own retry schedule.
 *
 * `socket.active` only distinguishes the two cases for the caller's benefit. It stays
 * true while the manager works through its backoff, and goes false once it gives up
 * for good — which is what happens after an explicit disconnect() or a rejected
 * handshake, since both destroy the socket instead of scheduling a retry. That is the
 * case worth reporting, because nothing else would have reconnected.
 * @returns {'connected'|'retrying'|'forced'|'disabled'}
 */
export function ensureSocketConnected() {
  if (!socketActivityEnabled || !socket) return 'disabled';
  if (socket.connected) return 'connected';
  const wasRetrying = socket.active;
  // Reconnection is suspended while backgrounded, so re-arm it before asking the
  // socket to connect. connect() is a no-op while the manager is mid-backoff.
  socket.io?.reconnection(true);
  socket.connect();
  return wasRetrying ? 'retrying' : 'forced';
}

/**
 * Last-resort recovery for manager states connect() cannot escape: a
 * `_reconnecting` flag whose backoff timer was dropped by an Android freeze, or
 * a connect attempt whose timers died with it. disconnect() forcibly clears the
 * manager state machine (skipReconnect/_reconnecting) and destroys whatever
 * engine is left; connect() then opens a clean handshake, and the socket's
 * retained recovery offset still lets the server replay missed events when the
 * outage stayed inside the recovery window.
 */
export function hardResetSocket() {
  if (!socket) return;
  try {
    socket.disconnect();
  } catch {}
  if (!socketActivityEnabled) return;
  socket.io?.reconnection(true);
  socket.connect();
}

/**
 * Distrust a socket that claims to be connected right after the app returns to
 * the foreground. A page frozen mid-connection can resume with `connected`
 * still true on a transport the server dropped hours ago, and if the engine's
 * ping-timeout timer was discarded with the freeze nothing ever notices — the
 * watchdog sees "connected" and stands down. An acked ping settles it: no ack
 * within the timeout means zombie, and closing the engine hands the manager a
 * real close event to reconnect from.
 */
export function verifySocketLiveness() {
  if (!socketActivityEnabled || !socket?.connected || livenessProbeInFlight) return;
  livenessProbeInFlight = true;
  socket.timeout(SOCKET_LIVENESS_TIMEOUT_MS).emit('client_ping', (err) => {
    livenessProbeInFlight = false;
    if (!err) return;
    // The engine may already have noticed and reconnected (or been suspended)
    // while the probe was outstanding; only kill a socket still playing alive.
    if (!socket?.connected) return;
    recordStatusEvent('relay-zombie-socket', { timeoutMs: SOCKET_LIVENESS_TIMEOUT_MS });
    socket.io?.engine?.close();
  });
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

  // The connect-time view resync is the only correction path for state whose
  // change events this client missed while suspended (e.g. a background-task
  // set the server has since emptied — an empty store never re-announces
  // itself). A connect that races the relay's own restart loses a one-shot
  // resync to a failed fetch and the stale state then survives indefinitely,
  // so failures retry with backoff until one pass lands on a live server.
  let connectResyncTimer = null;
  let connectResyncGeneration = 0;
  function resyncAfterConnect(attempt = 0) {
    const generation = attempt === 0 ? ++connectResyncGeneration : connectResyncGeneration;
    if (connectResyncTimer) {
      clearTimeout(connectResyncTimer);
      connectResyncTimer = null;
    }
    refreshCurrentView().catch(() => {
      if (generation !== connectResyncGeneration || attempt >= 4 || !socket?.connected) return;
      connectResyncTimer = setTimeout(() => {
        connectResyncTimer = null;
        resyncAfterConnect(attempt + 1);
      }, 2000 * (attempt + 1));
    });
  }

  socket.on('connect', () => {
    lastSocketErrorSignature = '';
    lastSocketErrorAt = 0;
    console.log('Socket connected');
    // Connect-time heartbeat. Also re-asserts visibility after a recovered
    // session, whose restored socket.data the server deliberately resets.
    emitDeviceVisibility(document.visibilityState === 'visible');
    clearMessageSearchRuntimeState();
    setRelayOnline(true);
    setCliOnline(true);
    renderConvList();
    resyncAfterConnect();
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
  // Keeps the relay dot's Cloudflare Tunnel colour live between status polls.
  socket.on('cloudflared_tunnel_status', (payload) => {
    setCloudflaredTunnelState(payload || null);
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
  socket.on('claude_settings_updated', (payload) => {
    deps?.applyClaudeSettingsState?.(payload || {});
    if (Number(payload?.reconciliation?.updatedUnstartedConversations || 0) > 0) {
      void Promise.resolve()
        .then(() => deps?.refreshCurrentView?.())
        .catch(() => {});
    }
  });
  // Login/logout transitions on the relay host. Broadcast to every client so a
  // login started on the desktop can be finished on a phone (and vice versa).
  socket.on('claude_auth_state', (payload) => {
    applyClaudeAuthState(payload || null);
  });
  socket.on('grok_settings_updated', (payload) => {
    deps?.applyGrokSettingsState?.(payload || {});
    if (Number(payload?.reconciliation?.updatedUnstartedConversations || 0) > 0) {
      void Promise.resolve()
        .then(() => deps?.refreshCurrentView?.())
        .catch(() => {});
    }
  });
  socket.on('cursor_settings_updated', (payload) => {
    deps?.applyCursorSettingsState?.(payload || {});
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
  socket.on('background_tasks', ({ conversationId, tasks }) => {
    setConversationBackgroundTasks(conversationId, tasks);
  });
  // REPLACE semantics for the whole set: the preview registry is relay-owned
  // and global, so every change ships the full list.
  socket.on('previews', ({ previews }) => {
    setPreviews(previews);
  });
  socket.on('relay_activity', ({ conversationId, messageId, text, subagentRunId, metadata }) => {
    if (!messageId || !text) return;
    const entry = {
      text: String(text || '').trim(),
      subagentRunId: subagentRunId ? String(subagentRunId).trim() : null,
      metadata: (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : null,
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
      appendThinkingActivity(entry, entry.subagentRunId, autoScroll);
    }
  });
  socket.on('relay_stream', ({ conversationId, messageId, text, done, seq, subagentRunId }) => {
    if (!messageId) return;
    if (subagentRunId) {
      upsertSubagentRun({ subagentRunId: String(subagentRunId).trim(), messageId, conversationId });
    }
    if (conversationId !== currentConvId) return;
    const autoScroll = isMessagesAtBottom();
    applyRelayStreamEvent({
      messageId,
      text: String(text || ''),
      done: !!done,
      seq,
      subagentRunId: subagentRunId ? String(subagentRunId).trim() : null,
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
  socket.on('subagent_status', ({ conversationId, messageId, subagentRunId, parentSubagentId, displayName, status, timestamp, stopUnsupported }) => {
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
    // The provider answered "not supported": pin the state so the button does
    // not re-arm into an endless click-and-fail loop.
    if (stopUnsupported) markSubagentStopUnsupported(subagentRunId);
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
  socket.on('conversation_preferences_updated', ({ conversationId, preferredRelayMode, preferredModel, preferredReasoningEffort, autoCompactWindow, thinkingEnabled, thinkingDisplay, senderClientId }) => {
    if (senderClientId && senderClientId === CLIENT_ID) return;
    const id = String(conversationId || '').trim();
    if (!id || !conversations[id]) return;
    conversations[id] = {
      ...conversations[id],
      preferredRelayMode: preferredRelayMode || conversations[id].preferredRelayMode || FALLBACK_MODE,
      preferredModel: preferredModel || conversations[id].preferredModel || '',
      preferredReasoningEffort: preferredReasoningEffort || conversations[id].preferredReasoningEffort || '',
      // null is a real value here (Auto), so only an omitted field keeps the
      // previously known one.
      autoCompactWindow: autoCompactWindow === undefined
        ? (conversations[id].autoCompactWindow ?? null)
        : (autoCompactWindow ?? null),
      // Same semantics: null = Host default for enabled, and the display is
      // an explicit mode string; only an omitted field keeps the known value.
      thinkingEnabled: thinkingEnabled === undefined
        ? (conversations[id].thinkingEnabled ?? null)
        : (thinkingEnabled ?? null),
      thinkingDisplay: thinkingDisplay === undefined
        ? (conversations[id].thinkingDisplay ?? null)
        : (thinkingDisplay ?? null),
    };
    if (String(currentConvId || '').trim() === id) {
      applyConversationPreferencesForConversation(id, {
        preferredRelayMode,
        preferredModel,
        preferredReasoningEffort,
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
    // pending/parked fire mid-turn (queueing, park/re-queue); only genuinely
    // terminal statuses may tear down the live bubble and reload the view.
    const isTerminalStatus = ['done', 'failed', 'dropped', 'cancelled'].includes(normalizedStatus);
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
      renderThinkingThoughts();
      if (messageId) renderRestoredSubagentBubbles(messageId);
      if (messageId) removeUserBubbleCancelButton(messageId);
    }
    if (clearsProcessingStatus) {
      clearPendingUserMessage(messageId);
      if (messageId) clearRelayStreamStateForMessage(messageId);
      if (messageId) clearBubbleCancelState(messageId);
      if (messageId) removeUserBubbleCancelButton(messageId);
    }
    if (conversationId === currentConvId && isTerminalStatus) {
      collapseThinkingThoughts();
      removeThinking();
      void refreshCurrentView().catch(() => {});
      scheduleContextUsageRefresh(conversationId, 220);
      refreshSessionWorkerStatus().catch(() => {});
      // Files the agent created during the turn appear now, via the restoring
      // path that keeps open folders and the current selection.
      refreshRepoBrowserIfWorkspaceOpen();
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
