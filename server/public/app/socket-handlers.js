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
  updateWorkspaceRootHints,
  updateCompactButton,
  clearPendingUserMessage,
  hasPendingUserMessageDuplicate,
  upsertSubagentRun,
  getSubagentRun,
  addSubagentActivity,
  addSubagentThought,
  clearSubagentCancelInFlight,
  setConversationWatcherCount,
  setUpdateState,
  applySessionWorkerSteering,
  refreshSummaryModal,
  summaryModalState,
  IS_SHARED_VIEW,
} from './store.js';
import { scheduleContextUsageRefresh } from './api-client.js';
import { capLiveActivityEntries } from './activity-replay-state.mjs';
import { publishStatusEvent, recordStatusEvent } from './status-store.mjs';
import { clearOpenConversation, renderConvList, refreshConversations, scheduleLoadedConversationsRefresh, applyConversationGroupEvent, openConversation } from './journal-view.js';
import { applyBackgroundTasksToConversation, applyTurnStatusToConversation } from './conversation-turn-state.mjs';
import { applyRelayEventSubscriptions, loadRelayEventSubscriptions } from './relay-event-subscriptions-ui.js';
import { applyRelaySchedules, loadRelaySchedules } from './relay-schedules-ui.js';
import { noteInboxQuestionsChanged, noteRelayAskUpdated, refreshInbox } from './inbox-ui.js';
import { INBOX_REMOTE_CHANGED_EVENT, RELAY_ASK_SOCKET_EVENT } from './inbox-view.mjs';
import {
  upsertRelayQuestion,
  loadRelayQuestions,
  updatePendingQuestionBanner,
} from './ask-user-view.js';
import { upsertRelayBoard, loadRelayBoards, renderRelayBoards } from './relay-board-view.js';
import { setConversationBackgroundTasks, setConversationTaskHealth } from './background-tasks-view.mjs';
import { handleTaskConsoleReconnect, handleTaskOutputChunk } from './task-console.mjs';
import { setConversationPins } from './pinned-messages-view.mjs';
import { setConversationHiddenMessages } from './hidden-messages-view.mjs';
import { setPreviews } from './preview-cards.mjs';
import { applyShareSettings, hasActiveShare, refreshShares } from './share-state.js';
import { handleShareOpened, handleViewerIpsForgotten } from './shared-conversations-settings.js';
import { setRemoteRelaysSnapshot } from './remote-relays-store.mjs';
import { REMOTE_RELAY_SOCKET_EVENT } from './remote-relay-shared.mjs';
import { AGENT_SESSIONS_SOCKET_EVENT } from './agent-sessions-settings.mjs';
import { applyAgentSessionsSettingsState, refreshAgentSessionsSection } from './agent-sessions-settings-ui.js';
import { applyClaudeAuthState } from './claude-auth-ui.js';
import { applyGrokAuthState } from './grok-auth-ui.js';
import { applyClaudeCloudSettingsState, refreshClaudeCloudSettingsState } from './claude-cloud-settings-ui.js';
import { applyClaudeCloudSessionEvent } from './claude-cloud-conversation-ui.js';
import { updateProviderReadinessInputs } from './provider-readiness.mjs';
import { applyCliInstallState } from './cli-install-ui.js';
import { renderUpdateSection } from './update-ui.js';
import { applyHostSuspendState, applyRelayShutdownState } from './host-suspend-ui.js';
import { applyClaudeUsageLimit, applyConversationBilling, applyUsageLimitPause } from './usage-limit-ui.js';
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
  clearRelayStreamState,
  clearRelayStreamStateForMessage,
  applyConversationTurnStatus,
  renderMessages,
  appendMessage,
  captureLiveReplyReadingPosition,
  restoreLiveReplyReadingPosition,
  replaceRenderedMessage,
  noteTranscriptLiveRow,
  applyIncomingConversationDraftUpdate,
  getRenderedConversationMessageFingerprints,
  holdBackLiveRow,
  isConversationWindowAtTail,
  clearBubbleCancelState,
  removeUserBubbleCancelButton,
  updateSubagentBubbleFromStatus,
  markSubagentStopUnsupported,
  syncComposerButtonState,
  syncCancellableSteerButtons,
} from './conversation-view.js';
import { followsTranscriptEnd, noteTranscriptNews } from './transcript-jump-bottom-view.mjs';
import { loadRepoBrowserTree, refreshRepoBrowserIfWorkspaceOpen } from './attachments-view.js';
import { clearMessageSearchRuntimeState } from './message-search-view.js';
import { stripRelayPromptContext } from './relay-prompt-sanitizer.mjs';
import { isLikelyLiveDuplicateMessage } from './live-message-dedupe.mjs';
import { mergeRelayThoughts } from './relay-thoughts.mjs';
import { conversationPayloadCache } from './conversation-payload-cache.mjs';
import { planOnlyAfterBroadcast } from './plan-board-shared.mjs';

// A live row of the conversation on screen joins its kept window, so a
// switch away and back still shows it. Rows of other conversations do not:
// their kept copy is what the reader saw, and the switch back fetches the rest.
function keepLiveRow(conversationId, message, messageId) {
  if (IS_SHARED_VIEW || !message || typeof message !== 'object') return;
  const id = String(message.id || messageId || '').trim();
  if (!id) return;
  conversationPayloadCache.upsertMessage(conversationId, message.id ? message : { ...message, id });
}
import {
  handleSubagentStatusEventForViewer,
  handleSubagentTimelineEvent,
  handleSubagentViewerReconnect,
  refreshSubagentRows,
} from './subagent-viewer.mjs';

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
 * @property {(payload?: object) => void} applyDeepSeekSettingsState
 * @property {(payload?: object) => void} applyClaudeApiSettingsState
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
    // Events missed while the socket was down may have changed any of the
    // conversations kept for a quick switch back.
    conversationPayloadCache.clear();
    setRelayOnline(true);
    setCliOnline(true);
    renderConvList();
    resyncAfterConnect();
    // Every loaded page again, not page one only: events missed while the
    // socket was down touched rows anywhere in the list.
    scheduleLoadedConversationsRefresh();
    refreshSessionWorkerStatus().catch(() => {});
    refreshModelCatalog().catch(() => {});
    // An open sub-agent viewer fetches whatever it missed while away.
    handleSubagentViewerReconnect();
    // An open task console watches again and reads what it missed.
    void handleTaskConsoleReconnect();
    // Subscriptions that changed while away.
    void loadRelayEventSubscriptions();
    // Schedules that changed or fired while away.
    void loadRelaySchedules();
    // Questions asked or answered while away.
    void refreshInbox();
    // Shares made or stopped while away.
    void refreshShares().catch(() => {});
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
  // Each settings event also feeds provider readiness (provider-readiness.mjs),
  // so a Settings save changes the empty screen without a reload.
  socket.on('openai_settings_updated', (payload) => {
    const state = deps?.applyOpenAISettingsState?.(payload || {});
    updateProviderReadinessInputs({ openai: state || payload || null });
    if (Number(payload?.reconciliation?.updatedUnstartedConversations || 0) > 0) {
      void Promise.resolve()
        .then(() => deps?.refreshCurrentView?.())
        .catch(() => {});
    }
  });
  // No view refresh here: the engine switch rebinds nothing — it only changes
  // which worker the NEXT Copilot conversation spawns.
  socket.on('copilot_settings_updated', (payload) => {
    deps?.applyCopilotSettingsState?.(payload || {});
  });
  socket.on('claude_settings_updated', (payload) => {
    const state = deps?.applyClaudeSettingsState?.(payload || {});
    updateProviderReadinessInputs({ claude: state || payload || null });
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
  // Same contract for Grok, one state shorter (no code to paste back). Success
  // arrives twice — once off the cached status, once when the confirming read
  // lands — so the renderer is idempotent rather than transition-driven.
  socket.on('grok_auth_state', (payload) => {
    applyGrokAuthState(payload || null);
  });
  // CLI install transitions AND log chunks. The payload always carries the whole
  // retained buffer plus a monotonic logSeq, so a client that connects
  // mid-install renders the full log instead of a suffix.
  socket.on('cli_install_state', (payload) => {
    applyCliInstallState(payload || null);
  });
  // Self-update transitions AND npm log chunks; same whole-buffer contract as
  // cli_install_state, so a client connecting mid-update renders the full log.
  socket.on('update_state', (payload) => {
    setUpdateState(payload || null);
    renderUpdateSection();
  });
  // Pending host suspend / relay restart: banner + menu labels on every
  // device. Also sent on connect, so a reconnecting client catches up.
  socket.on('host_suspend_state', (payload) => {
    applyHostSuspendState(payload || null);
  });
  socket.on('relay_shutdown_state', (payload) => {
    applyRelayShutdownState(payload || null);
  });
  // The Claude usage limit: a conversation's paused turn, and the account's
  // latest report (also sent on connect).
  // A Claude chat moved between the subscription and the API key, or what it
  // may switch to changed (a swap waiting, the key removed).
  socket.on('conversation_billing', (payload) => {
    applyConversationBilling(payload || null);
  });
  socket.on('usage_limit_pause', (payload) => {
    applyUsageLimitPause(payload || null);
  });
  socket.on('claude_usage_limit', (payload) => {
    applyClaudeUsageLimit(payload || null);
  });
  // Claude Cloud settings (enable, default model, environment). The event
  // carries the same shape as GET /api/settings/claude-cloud; one without a
  // body is read as "something changed" and answered with a fresh read.
  socket.on('claude_cloud_settings_updated', (payload) => {
    if (payload && typeof payload === 'object') {
      updateProviderReadinessInputs({ claudeCloud: applyClaudeCloudSettingsState(payload) || null });
    } else {
      void refreshClaudeCloudSettingsState().then((state) => {
        updateProviderReadinessInputs({ claudeCloud: state || null });
      });
    }
  });
  // A cloud session got its id, pushed a branch or reported a new cost: the
  // conversation's `cloud` field changed, and with it the cloud line.
  socket.on('claude_cloud_session', (payload) => {
    if (applyClaudeCloudSessionEvent(payload || null)) deps?.syncChatTitleControls?.();
  });
  socket.on('grok_settings_updated', (payload) => {
    const state = deps?.applyGrokSettingsState?.(payload || {});
    updateProviderReadinessInputs({ grok: state || payload || null });
    if (Number(payload?.reconciliation?.updatedUnstartedConversations || 0) > 0) {
      void Promise.resolve()
        .then(() => deps?.refreshCurrentView?.())
        .catch(() => {});
    }
  });
  socket.on('deepseek_settings_updated', (payload) => {
    const state = deps?.applyDeepSeekSettingsState?.(payload || {});
    updateProviderReadinessInputs({ deepseek: state || payload || null });
    if (Number(payload?.reconciliation?.updatedUnstartedConversations || 0) > 0) {
      void Promise.resolve()
        .then(() => deps?.refreshCurrentView?.())
        .catch(() => {});
    }
  });
  // The Claude API tab saved (a key, the switch, the cap): the tab, New
  // Chat's readiness and the composer's billing toggle follow.
  socket.on('claude_api_settings_updated', (payload) => {
    const state = deps?.applyClaudeApiSettingsState?.(payload || {});
    updateProviderReadinessInputs({ claudeApi: state || payload || null });
    if (Number(payload?.reconciliation?.updatedUnstartedConversations || 0) > 0) {
      void Promise.resolve()
        .then(() => deps?.refreshCurrentView?.())
        .catch(() => {});
    }
  });
  socket.on('cursor_settings_updated', (payload) => {
    const state = deps?.applyCursorSettingsState?.(payload || {});
    updateProviderReadinessInputs({ cursor: state || payload || null });
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
      // `origin`: a prompt another relay's agent sent; its header line hides.
      text: stripRelayPromptContext(message?.text, message?.mode, { origin: message?.origin }),
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
      // A window that ends above the conversation's end takes no live row:
      // the newer pages bring it, and the jump-to-bottom badge counts it.
      if (holdBackLiveRow(conversationId, messageId || normalizedMessage.id)) return;
      // Another client's message (an agent's prompt included) follows the
      // end like any live row: a reader scrolled up stays where they are,
      // and the jump-to-bottom badge counts it.
      appendMessage(normalizedMessage, followsTranscriptEnd(), messageId);
      noteTranscriptLiveRow();
      keepLiveRow(conversationId, normalizedMessage, messageId);
    }
  });
  socket.on('assistant_message', ({ conversationId, message, messageId, sourceMessageId }) => {
    const isCurrentConversation = conversationId === currentConvId;
    const autoScroll = isCurrentConversation ? followsTranscriptEnd() : false;
    // A reader who is not at the end keeps what they read where it is while
    // the reply takes the live bubble's place.
    const reading = isCurrentConversation && !autoScroll ? captureLiveReplyReadingPosition() : null;
    // A background conversation finishing its turn must not wipe the viewed
    // conversation's live bubble.
    if (isCurrentConversation) {
      collapseThinkingThoughts();
      removeThinking();
    }
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
    if (messageId && seenMessageIds?.has(messageId)) {
      restoreLiveReplyReadingPosition(reading);
      return;
    }
    // Held back under a window that ends above the conversation's end, as
    // in user_message.
    if (isCurrentConversation && !holdBackLiveRow(conversationId, messageId || message?.id)) {
      appendMessage(message, autoScroll, messageId || null, false, sourceMessageId || null);
      restoreLiveReplyReadingPosition(reading);
      noteTranscriptLiveRow();
      keepLiveRow(conversationId, message, messageId);
    }
    if (isCurrentConversation) scheduleContextUsageRefresh(conversationId, 120);
    if (sourceMessageId) relayActivities.delete(sourceMessageId);
    if (sourceMessageId) relayThoughts.delete(sourceMessageId);
    if (sourceMessageId) clearRelayStreamStateForMessage(sourceMessageId);
    refreshSessionWorkerStatus().catch(() => {});
  });
  // A folder's commit attribution changed (any client): an open context modal
  // re-reads it so its row and effect text match.
  socket.on('workspace_root_attribution_updated', () => {
    if (summaryModalState.kind === 'context') refreshSummaryModal().catch(() => {});
  });
  // A message the relay rewrote in place (the note while a session's worker
  // cannot be started): same id, new text or kind. Not on the page yet (the
  // conversation was opened after it was written): appended like any other.
  socket.on('message_updated', ({ conversationId, messageId, message }) => {
    // A row rewritten in place. Another conversation's kept window would show
    // the old one: it is dropped. The window on screen takes the new row as
    // the page does, so a switch away and back keeps both the row and the
    // window around it.
    if (!messageId || conversationId !== currentConvId || !message) {
      conversationPayloadCache.forget(conversationId);
      return;
    }
    if (!replaceRenderedMessage(message, messageId)) {
      // A row outside a window that ends above the conversation's end: the
      // newer pages bring it as it is now.
      if (!isConversationWindowAtTail()) return;
      appendMessage(message, followsTranscriptEnd(), messageId, false);
    }
    noteTranscriptLiveRow();
    keepLiveRow(conversationId, message, messageId);
  });
  socket.on('relay_question', ({ question }) => {
    upsertRelayQuestion(question);
    noteInboxQuestionsChanged();
  });
  socket.on('relay_question_updated', ({ question }) => {
    upsertRelayQuestion(question);
    noteInboxQuestionsChanged();
  });
  socket.on('relay_question_changed', () => {
    loadRelayQuestions(currentConvId);
    noteInboxQuestionsChanged();
  });
  // A paired relay's pending cards changed (this relay checks them every ~20 s).
  socket.on(INBOX_REMOTE_CHANGED_EVENT, () => noteInboxQuestionsChanged());
  // Questions that don't block: one ask, after every change of it.
  socket.on(RELAY_ASK_SOCKET_EVENT, (payload) => noteRelayAskUpdated(payload));
  socket.on('relay_board', ({ board }) => upsertRelayBoard(board));
  socket.on('relay_board_updated', ({ board }) => upsertRelayBoard(board));
  socket.on('relay_board_changed', () => {
    loadRelayBoards();
    // Plan cards are in the Inbox too.
    noteInboxQuestionsChanged();
  });
  // Relay event subscriptions: the whole active list, after every change.
  socket.on('relay_event_subscriptions', ({ subscriptions }) => {
    applyRelayEventSubscriptions(subscriptions);
  });
  // Relay schedules: the whole active list, after every change.
  socket.on('relay_schedules', ({ schedules }) => {
    applyRelaySchedules(schedules);
  });
  socket.on('background_tasks', ({ conversationId, tasks, endedTasks }) => {
    setConversationBackgroundTasks(conversationId, tasks, { endedTasks, event: true });
    // The sidebar's row (and its group's head) count background work as
    // running; the set arrives under the conversation or its session id.
    const id = String(conversationId || '').trim();
    const record = conversations[id]
      || Object.values(conversations).find((conversation) => String(conversation?.sdkSessionId || '') === id)
      || null;
    if (record && applyBackgroundTasksToConversation(record, tasks)) renderConvList();
  });
  // The relay's health poller: last output time and test-runner counts of
  // shell and Monitor tasks, only when they changed.
  socket.on('background_tasks_health', ({ conversationId, health }) => {
    setConversationTaskHealth(conversationId, health);
  });
  // New bytes of the task the console shows; the relay sends them only while
  // this page's console watches that task.
  socket.on('task_output_chunk', (payload) => {
    handleTaskOutputChunk(payload);
  });
  // A message was pinned or unpinned (any client): the conversation's whole
  // pin list, replacing what this page had.
  socket.on('conversation_pins_updated', ({ conversationId, pins, revision }) => {
    setConversationPins(conversationId, pins, revision);
  });
  // A message was hidden from or shown to shared viewers (any client): the
  // conversation's whole hidden list, replacing what this page had.
  socket.on('conversation_hidden_messages_updated', ({ conversationId, hiddenMessages, revision }) => {
    setConversationHiddenMessages(conversationId, hiddenMessages, revision);
  });
  // REPLACE semantics for the whole set: the preview registry is relay-owned
  // and global, so every change ships the full list.
  socket.on('previews', ({ previews }) => {
    setPreviews(previews);
  });
  // Public shares: the events name the conversation only; the list (Settings
  // → Sharing, the ⋯ menu's Stop sharing) is read again.
  for (const event of ['share_created', 'share_renewed', 'share_revoked']) {
    socket.on(event, () => {
      void refreshShares().catch(() => {});
    });
  }
  // A deleted conversation takes its share along.
  socket.on('conversation_deleted', ({ conversationId } = {}) => {
    if (hasActiveShare(conversationId)) void refreshShares().catch(() => {});
  });
  socket.on('share_opened', ({ conversationId } = {}) => {
    handleShareOpened(conversationId);
  });
  socket.on('share_settings_changed', (payload) => {
    applyShareSettings(payload || null);
  });
  socket.on('share_viewer_ips_forgotten', () => {
    handleViewerIpsForgotten();
  });
  // REPLACE semantics too: the relay ships the whole remote-relay list (no
  // tokens) whenever a remote is added, removed, renamed or changes status.
  socket.on(REMOTE_RELAY_SOCKET_EVENT, (payload) => {
    setRemoteRelaysSnapshot(payload || null);
  });
  // Agent sessions (Settings → Relays): the event carries the same shape as
  // GET /api/settings/agent-sessions; one without a body is answered with a
  // fresh read.
  socket.on(AGENT_SESSIONS_SOCKET_EVENT, (payload) => {
    if (payload && typeof payload === 'object') applyAgentSessionsSettingsState(payload);
    else void refreshAgentSessionsSection();
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
    // The same line again (a repeated event) adds nothing.
    const added = lastText !== entry.text || lastSubagentRunId !== entry.subagentRunId;
    if (added) relayActivities.set(messageId, capLiveActivityEntries(items.concat(entry)));
    if (entry.subagentRunId) {
      upsertSubagentRun({ subagentRunId: entry.subagentRunId, messageId, conversationId });
      addSubagentActivity(entry.subagentRunId, entry.text);
    }
    if (conversationId === currentConvId) {
      const autoScroll = followsTranscriptEnd();
      appendThinkingActivity(entry, entry.subagentRunId, autoScroll);
      if (added && !autoScroll) noteTranscriptNews();
    }
  });
  socket.on('relay_stream', ({ conversationId, messageId, text, done, seq, subagentRunId }) => {
    if (!messageId) return;
    if (subagentRunId) {
      upsertSubagentRun({ subagentRunId: String(subagentRunId).trim(), messageId, conversationId });
    }
    if (conversationId !== currentConvId) return;
    const autoScroll = followsTranscriptEnd();
    const accepted = applyRelayStreamEvent({
      messageId,
      text: String(text || ''),
      done: !!done,
      seq,
      subagentRunId: subagentRunId ? String(subagentRunId).trim() : null,
      autoScroll,
    });
    // A frame that was dropped (out of order, a finished turn) is no news.
    if (accepted && !autoScroll) noteTranscriptNews();
  });
  socket.on('relay_thought', ({ conversationId, messageId, reasoningId, text, done, subagentRunId }) => {
    if (!messageId) return;
    const key = String(reasoningId || 'reasoning');
    const thoughtMap = relayThoughts.get(messageId) || new Map();
    const known = thoughtMap.get(key);
    // The same thought again (a repeated event) adds nothing.
    const added = !known || known.text !== String(text || '') || known.done !== !!done;
    thoughtMap.set(key, { reasoningId: key, text: String(text || ''), done: !!done, subagentRunId: subagentRunId || null });
    relayThoughts.set(messageId, thoughtMap);
    if (subagentRunId) {
      upsertSubagentRun({ subagentRunId, messageId, conversationId });
      addSubagentThought(subagentRunId, { reasoningId: key, text: String(text || ''), done: !!done });
    }
    if (conversationId === currentConvId) {
      const autoScroll = followsTranscriptEnd();
      appendThinkingThought(key, String(text || ''), !!done, subagentRunId, autoScroll);
      if (added && !autoScroll) noteTranscriptNews();
    }
  });
  socket.on('subagent_status', (payload = {}) => {
    const { conversationId, subagentRunId, status, stopUnsupported } = payload;
    if (!subagentRunId) return;
    // An event without its turn is placed on the run the store already
    // knows; one for an unknown run without a turn cannot be placed.
    const messageId = payload.messageId || getSubagentRun(subagentRunId)?.messageId || null;
    if (!messageId) return;
    upsertSubagentRun({ ...payload, messageId });
    clearSubagentCancelInFlight(subagentRunId);
    // The provider answered "not supported": pin the state so the button does
    // not re-arm into an endless click-and-fail loop.
    if (stopUnsupported) markSubagentStopUnsupported(subagentRunId);
    if (conversationId === currentConvId) {
      updateSubagentBubbleFromStatus(subagentRunId, status);
      refreshSubagentRows(subagentRunId);
    }
    handleSubagentStatusEventForViewer({ ...payload, messageId });
  });
  // Entries of a sub-agent's record; the relay sends them only while this
  // page's viewer watches that run.
  socket.on('subagent_timeline', (payload) => {
    handleSubagentTimelineEvent(payload);
  });
  socket.on('conversation_compacted', async ({ sourceConversationId, targetConversationId }) => {
    if (!sourceConversationId || !targetConversationId) return;
    conversationPayloadCache.forget(sourceConversationId);
    conversationPayloadCache.forget(targetConversationId);
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
  socket.on('conversation_preferences_updated', ({ conversationId, preferredRelayMode, preferredModel, preferredReasoningEffort, autoCompactWindow, thinkingEnabled, thinkingDisplay, mayCreateSessions, planOnly, senderClientId }) => {
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
      // The owner's "agents may start sessions"; an older relay omits it.
      mayCreateSessions: typeof mayCreateSessions === 'boolean'
        ? mayCreateSessions
        : conversations[id].mayCreateSessions === true,
      // Plan-only: a broadcast without it (an older relay, a board's mode
      // follow-up) keeps the known value.
      planOnly: planOnlyAfterBroadcast(planOnly, conversations[id].planOnly),
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
    // The composer reads the worker's steering snapshot under the session id
    // just bound; fetch it now rather than on the next status poll.
    refreshSessionWorkerStatus().catch(() => {});
    await refreshConversations();
    if (currentConvId === id) {
      await openConversation(id);
    }
  });
  // A worker's steering snapshot changed (its heartbeat): the composer's
  // Steer/Queue label and the pushed rows' Cancel follow it at once instead of
  // on the next status poll.
  socket.on('session_worker_steering', ({ sdkSessionId, steering } = {}) => {
    const changed = applySessionWorkerSteering(sdkSessionId, steering);
    if (changed === null) {
      refreshSessionWorkerStatus().catch(() => {});
      return;
    }
    if (!changed) return;
    syncComposerButtonState();
    syncCancellableSteerButtons();
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
      // The row's turn fields follow the event, open or not: the title colour, a
      // group head's pill and its fold read them between list fetches.
      applyTurnStatusToConversation(conversation, normalizedStatus);
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
      const autoScroll = followsTranscriptEnd();
      showThinking(messageId || null, autoScroll);
      renderThinkingActivities();
      renderThinkingThoughts();
      if (messageId) renderRestoredSubagentBubbles(messageId);
      if (messageId) removeUserBubbleCancelButton(messageId);
    }
    if (normalizedStatus === 'processing') {
      // A worker owns the message now: dropping the pending entry re-arms the
      // duplicate-send guard and hands poll liveness over to localTurnStatus.
      clearPendingUserMessage(messageId);
    }
    if (clearsProcessingStatus) {
      // 'pending'/'parked' mean the message is (still) queued: its pending
      // entry keeps the live poll armed while it waits, and only a genuinely
      // terminal status may blacklist the id from relay_stream frames — the
      // server acks every enqueue with 'pending', which would otherwise mute
      // live streaming for the whole turn.
      if (isTerminalStatus) clearPendingUserMessage(messageId);
      if (messageId && isTerminalStatus) clearRelayStreamStateForMessage(messageId);
      else if (messageId) clearRelayStreamState(messageId);
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
  // A session group changed (a member joined or left, a name, a dissolve,
  // here or from another device): every loaded page is fetched again with
  // its groups, so a row far down the list changes too.
  socket.on('conversation_group_changed', (payload) => {
    applyConversationGroupEvent(payload);
  });
  socket.on('conversation_archived', ({ conversationId, archived }) => {
    const id = String(conversationId || '').trim();
    if (!id) return;
    const conversation = conversations[id];
    if (conversation) conversation.archived = archived !== false;
    conversationPayloadCache.forget(id);
    renderConvList();
    if (currentConvId === id) {
      syncChatTitleControls();
      syncComposerButtonState();
    }
  });
  socket.on('conversation_deleted', ({ conversationId }) => {
    delete conversations[conversationId];
    conversationPayloadCache.forget(conversationId);
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
      clearOpenConversation();
    } else {
      updateCompactButton();
    }
  });

  if (socketActivityEnabled) {
    socket.connect();
  }
  return socket;
}
