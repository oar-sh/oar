import {
  CLIENT_ID,
  currentConvId,
  conversations,
  repoBrowserState,
  workspaceRootPath,
  defaultSessionWorkspaceRootPath,
  defaultSessionWorkspaceRootWarning,
  getConversationWorkspaceState,
  escHtml,
  setToken,
  setCliOnline,
  setRelayOnline,
  setSessionWorkerStatesFromStatusPayload,
  setCurrentConv,
  updateWorkspaceRootHints,
  updateCliStatus,
  cliOnline,
  openSidebar,
  closeSidebar,
  updateCompactButton,
  updateSessionPill,
  setModelBanner,
  showTransientRelayNotice,
  applyContextUsageBar,
  scrollBottom,
  isMessagesAtBottom,
  setHistoryRefreshInFlight,
  isHistoryRefreshInFlight,
  setSummaryModalLoading,
  renderSummaryModalContent,
  openSummaryModal,
  closeSummaryModal,
  refreshSummaryModal,
  syncViewportMetrics,
  isMobileComposerViewport,
  releaseComposerFocusAfterSend,
  autoResize,
  initSidebarLayout,
  toggleSidebar,
  loadConversationScrollTop,
  loadConversationLoadedMessageCount,
  saveConversationScrollTop,
  getSessionWorkerState,
  resolveConversationUiState,
  summaryModalState,
  IS_SHARED_VIEW,
  SHARED_CONVERSATION_TOKEN,
  getConversationWatcherCount,
  generateId,
} from './store.js';
import {
  verifyExistingSession,
  verifyToken,
  refreshWorkspaceRootHints,
  loadUsageSummary,
  loadContextSummary,
  loadModelCatalog,
  loadModelVariantCatalog,
  refreshModelVariantCatalog,
  saveEnabledModelVariants,
  updateClaudeSettings,
  updateCursorSettings,
  updateGrokSettings,
  loadConversation,
  refreshConversationHistory,
  updateConversationTitle,
  updateConversationPreferences,
  createConversationShareLink,
  updateDefaultSessionWorkspaceRoot,
  scheduleContextUsageRefresh,
  loadSharedConversation,
  reportSharedViewerPresence,
  setNetworkRequestsEnabled,
} from './api-client.js';
import { loadConversations, refreshConversations, openConversation, renderConvList, applyLoadedConversationState, initConversationListLazyLoading } from './journal-view.js';
import {
  newConversation,
  confirmNewConversationModel,
  closeNewConversationModelModal,
  deleteConv,
} from './journal-view.js';
import {
  loadRelayQuestions,
  getPendingQuestionCountsByConversation,
} from './ask-user-view.js';
import { openPendingQuestionFromBanner, submitRelayQuestionChoice, submitRelayQuestionAnswer, submitRelayStructuredAnswer, onRelayQuestionDraftInput, handleRelayQuestionKey } from './ask-user-view.js';
import { loadRelayBoards, submitRelayBoardAction } from './relay-board-view.js';
import {
  restoreInFlightThinking,
  renderMessages,
  appendMessage,
  compactCurrentConversation,
  sendMessage,
  handleKey,
  getConversationLoadedMessageCount,
  loadOlderConversationMessages,
  syncComposerControlState,
  persistComposerAttachments,
  flushConversationDraft,
  initConversationHistoryLazyLoading,
  initBubbleActionHandlers,
  isSendInFlight,
  setImageEditTarget,
  clearImageEditTarget,
  jumpToImageParent,
  flushDeferredMessageRender,
} from './conversation-view.js';
import { bindChatSelectionGuard, chatSelectionGuard, isChatInteractionHeld } from './selection-guard.mjs';
import { loadRepoBrowserTree, openRepoBrowser, closeRepoBrowser, setRepoBrowserSessionInfo, resetWorkspaceRepoBrowserForRootChange } from './attachments-view.js';
import { handleAttachmentInput, retryAttachmentUpload, handleComposerPaste, handleComposerDrop, refreshComposerAttachmentWarning, removeAttachment, clearAttachments, openUploadedAttachmentViewer, setFilePreviewMode, toggleFilePreviewHtml, closeFilePreview, goBackFilePreview, openWorkspaceFilePreview, openWorkspaceFilePreviewFromRepo, setRepoBrowserRoot, setRepoBrowserViewMode, toggleRepoBrowserHidden, toggleRepoBrowserHeavy, refreshRepoBrowser, focusRepoTree, setRepoCurrentPath } from './attachments-view.js';
import { initEmojiPicker, toggleEmojiPicker } from './emoji-view.js';
import { dataTransferHasFiles } from './composer-paste.mjs';
import { isReasoningOffUnsupported, reasoningEffortOptionLabel, reasoningEffortOptionTitle } from './reasoning-effort-labels.mjs';
import {
  firstDefinedPreference,
  normalizePreferenceValue,
  resolveComposerReasoningEffort,
  resolveConversationComposerSelection,
} from './conversation-preferences.mjs';
import {
  modelSelectorOptionsEqual,
  normalizeModelSelectorOptions,
} from './model-selector-options.mjs';
import {
  isOpenAIImageModelId,
  sessionLockNoteText,
  sessionLockProviderKey,
} from './conversation-provider-indicator.mjs';
import {
  initMessageSearchView,
  openMessageSearchModal,
  closeMessageSearchModal,
} from './message-search-view.js';
import {
  initGitChangesView,
  openGitChangesModal,
  closeGitChangesModal,
  openGitDiffViewer,
  closeGitDiffViewer,
  setGitDiffMode,
} from './git-changes-view.js';

import {
  initSocketHandlers,
  connectSocket,
  setSocketActivityEnabled,
  ensureSocketConnected,
  hardResetSocket,
  verifySocketLiveness,
  emitDeviceVisibility,
} from './socket-handlers.js';
import {
  adviseWatchdogTick,
  RELAY_WATCHDOG_HARD_RESET_TICKS,
} from './relay-watchdog-policy.mjs';
import {
  initInstallButton,
  initFullscreenButton,
  promptInstallApp,
  toggleFullscreen,
  applyPwaManifestFromSettings,
  registerPwaShell,
  updatePwaAppName,
} from './pwa-install.js';
import { renderContextUsageHtml } from './context-usage-view.mjs';
import { renderPlanUsageHtml, planUsageSubtitle } from './plan-usage-view.mjs';
import { initFontScaling, updateFontScaleFromSelect } from './font-scaling.js';
import { initClientDiagnostics, recordStatusEvent } from './status-store.mjs';
import { isStatusViewActive, toggleStatusView } from './status-view.mjs';
import { installExternalLinkPolicy, openExternalNavigation } from './external-link-policy.mjs';
import {
  initCwdPicker,
  openChangeCwdModal,
  confirmChangeCwd,
  confirmChangeCwdAndLaunch,
  syncChatHeaderWorkspaceLabel,
  normalizeKnownCwdPath,
  clearLegacyKnownCwdHistoryStorage,
} from './cwd-picker.js';
import { bindTapAction, bindMenuAction } from './tap-actions.js';

let pendingExternalLinkUrl = '';

function showExternalLinkFallback(url) {
  pendingExternalLinkUrl = String(url || '').trim();
  if (!pendingExternalLinkUrl) return;
  openSummaryModal({
    title: 'Open external link',
    subtitle: 'Your browser blocked opening a separate tab',
    bodyHtml: `
      <p>The Copilot Remote app remains open. Copy this link and open it in your system browser:</p>
      <pre><code>${escHtml(pendingExternalLinkUrl)}</code></pre>
      <div class="summary-actions">
        <button class="summary-btn" type="button" onclick="copyExternalLinkUrl()">Copy link</button>
        <button class="summary-btn" type="button" onclick="retryExternalLinkOpen()">Open again</button>
        <button class="summary-close" type="button" onclick="closeSummaryModal()">Close</button>
      </div>
    `,
    kind: 'external-link-fallback',
  });
}

async function copyExternalLinkUrl() {
  if (!pendingExternalLinkUrl) return;
  await copyTextToClipboard(pendingExternalLinkUrl);
  showTransientRelayNotice('External link copied.');
}

function retryExternalLinkOpen() {
  if (!pendingExternalLinkUrl) return;
  openExternalNavigation(pendingExternalLinkUrl, showExternalLinkFallback);
}
import { initTmuxInspectorView, closeTmuxInspectorView } from './tmux-inspector-view.js';
import {
  initTheme,
  updateTheme,
  openSettingsModal,
  closeSettingsModal,
  syncSuspendHostVisibility,
  updateShowSuspendHostSetting,
  syncDefaultSessionWorkspaceRootInput,
  updateDefaultSessionWorkspaceRootSetting,
  saveOpenAISettings,
  removeOpenAISettings,
  toggleOpenAIProvider,
  applyOpenAISettingsState,
  refreshOpenAISettingsState,
  saveClaudeSettings,
  toggleClaudeProvider,
  applyClaudeSettingsState,
  refreshClaudeSettingsState,
  saveGrokSettings,
  toggleGrokProvider,
  applyGrokSettingsState,
  refreshGrokSettingsState,
  saveCursorSettings,
  removeCursorSettings,
  saveCursorAllowanceSettings,
  resetCursorAllowanceAccounting,
  saveCursorDashboardToken,
  removeCursorDashboardToken,
  saveGrokAllowanceSettings,
  resetGrokAllowanceAccounting,
  toggleCursorProvider,
  applyCursorSettingsState,
  refreshCursorSettingsState,
  updateWindowsAutostartSettingFromToggle,
  previewTurnCeilingSetting,
  updateTurnCeilingSetting,
  previewBackgroundTaskTimeoutSetting,
  updateBackgroundTaskTimeoutSetting,
} from './settings-modal.js';
import {
  togglePushOnThisDevice,
  updatePushPreferencesFromControls,
} from './push-settings.js';
import {
  enqueueDraftFlushForBackgroundSync,
  initOutboxFallbackReplay,
} from './sync-outbox.mjs';
import {
  initActionConfirmations,
  openKillSessionConfirmation,
  confirmKillCurrentSession,
  openRestartRelayConfirmation,
  confirmRestartWebRelay,
  openEmptyQueueConfirmation,
  confirmEmptyQueue,
  openSuspendHostConfirmation,
  confirmSuspendHost,
} from './action-confirmations.js';

const MODEL_STORAGE_KEY = 'copilot_selected_model';
// The New Chat modal used to keep its own model key, so a selection made there
// never reached the composer. Both now read MODEL_STORAGE_KEY.
const LEGACY_MODEL_STORAGE_KEY = 'copilot_model';
const REASONING_STORAGE_KEY = 'copilot_selected_reasoning_effort';
const MODE_STORAGE_KEY = 'copilot_selected_mode';
const AUTO_MODEL_OPTION = 'auto';
// Claude "[1m]" long-context variants surface as the base model plus the
// long_context tier in the context-size dropdown, never as separate entries.
const CLAUDE_LONG_CONTEXT_PATTERN = /\[1m\]$/i;
const FALLBACK_MODEL = 'gpt-5.4-mini';
const FALLBACK_REASONING_EFFORT = 'none';
const FALLBACK_MODE = 'agent';
const PROVIDER_LABELS = {
  openai: 'OpenAI',
  'openai-byok': 'OpenAI (BYOK)',
  claude: 'Claude SDK',
  cursor: 'Cursor SDK',
  grok: 'Grok',
  'github-copilot': 'GitHub Copilot',
  // Vendor grouping for Copilot-served rows, distinct from the Claude SDK runtime.
  anthropic: 'Anthropic',
  google: 'Google',
  microsoft: 'Microsoft',
  other: 'Other',
};
const CHAT_TITLE_MAX_LENGTH = 120;
const LOCAL_PROCESSING_STALE_MS = 5 * 60 * 1000;
const FOREGROUND_RECOVERY_DEBOUNCE_MS = 1000;
// Upper bound on how long the in-flight latch may stay set. A recovery request
// that never settles (frozen renderer, half-open mobile socket) must not be able
// to keep the latch closed, because that would suppress every later recovery.
const FOREGROUND_RECOVERY_TIMEOUT_MS = 20000;
const RELAY_WATCHDOG_INTERVAL_MS = 5000;
// The server treats a visibility report older than 90s as stale, so a foregrounded
// device has to keep re-asserting itself or it silently stops counting as active
// and push suppression stops working mid-turn. 30s leaves room for two dropped
// beats inside that window. Tests shorten this rather than waiting it out.
const DEVICE_VISIBILITY_HEARTBEAT_MS = Number.isFinite(Number(window.__COPILOT_VISIBILITY_HEARTBEAT_MS))
  ? Math.max(50, Number(window.__COPILOT_VISIBILITY_HEARTBEAT_MS))
  : 30_000;
// How long a hidden page keeps its transport before suspending it. Brief
// app switches then never drop the socket at all. 45s matches the server's
// ping window (pingInterval 25s + pingTimeout 20s): past that the server has
// already dropped the client, so waiting longer would be inert. Tests override
// this to avoid waiting out the real grace period.
const BACKGROUND_SUSPEND_GRACE_MS = Number.isFinite(Number(window.__COPILOT_BACKGROUND_GRACE_MS))
  ? Math.max(0, Number(window.__COPILOT_BACKGROUND_GRACE_MS))
  : 45_000;

let relayQuestionPollTimer = null;
let relayBoardPollTimer = null;
let sessionWorkerStatusPollTimer = null;
let sharedConversationPollTimer = null;
let sharedPresencePollTimer = null;
let sharedConversationPollInFlight = false;
let sharedConversationRequestSeq = 0;
let sharedConversationAppliedSeq = 0;
let liveConversationPollTimer = null;
let liveConversationPollInFlight = false;
let sharedViewerIdFallback = '';
let sharedConversationRenderKey = '';
let sharedConversationLastError = '';
let networkLifecycleBound = false;
let foregroundRecoveryTimer = null;
let foregroundRecoveryInFlight = false;
let foregroundRecoveryWatchdogTimer = null;
let foregroundRecoveryGeneration = 0;
let relayConnectionWatchdogTimer = null;
let relayWatchdogDisconnectedTicks = 0;
let deviceVisibilityHeartbeatTimer = null;
let backgroundSuspendTimer = null;
let appSharedMode = false;
let viewportBaseHeight = window.innerHeight || document.documentElement.clientHeight || 0;
let chatTitleEditingConversationId = null;
let relayQuestionRenderHash = '';
let modelCatalogState = {
  models: [FALLBACK_MODEL],
  currentModel: FALLBACK_MODEL,
  defaultModel: FALLBACK_MODEL,
  reasoningByModel: {},
  reasoningByProvider: {},
  providersByModel: {},
  reasoningEfforts: [],
  modelMetadataByModel: {},
  stale: true,
  metadataValid: false,
  reasoningMetadataValid: false,
  warning: null,
  error: null,
  refreshedAt: null,
};
let lastHealthyModelCatalogState = null;
let deferredModelCatalogPayload = null;
let modelMetadataBlocked = true;
let modelMetadataRetryInFlight = false;
let modelVariantCatalogState = {
  variants: [],
  enabledVariantIds: [],
  reasoningByModel: {},
  source: null,
  refreshedAt: null,
  warning: null,
  error: null,
  reasoningEfforts: [],
};
let modelVariantCatalogProviderTab = 'copilot';
let suppressConversationPreferenceSync = false;
let conversationPreferenceWriteVersion = 0;
let latestQueueStatus = {
  pendingCount: 0,
  processingCount: 0,
  parkedCount: 0,
};
const SHARED_VIEWER_ID_STORAGE_KEY = 'copilot_shared_viewer_id';
const AUTH_TOKEN_STORAGE_KEY = 'copilot_auth_token';
const AUTH_COOKIE_NAME = 'copilot_auth';

function resolveSharedTokenFromLocation() {
  const configured = String(window.__COPILOT_APP_CONFIG?.sharedToken || SHARED_CONVERSATION_TOKEN || '').trim().toLowerCase();
  if (configured) return configured;
  const pathToken = String(window.location.pathname || '').match(/\/shared\/([^/?#]+)\/?$/i);
  if (!pathToken) return '';
  return String(pathToken[1] || '').trim().toLowerCase();
}

function isSharedReaderMode() {
  if (IS_SHARED_VIEW) return true;
  return !!resolveSharedTokenFromLocation();
}

function getTokenFromUrl() {
  return new URLSearchParams(window.location.search).get('token');
}

function resolveAuthCookiePath() {
  const configuredBase = typeof window.__COPILOT_APP_CONFIG?.basePath === 'string'
    ? window.__COPILOT_APP_CONFIG.basePath.trim()
    : '';
  if (configuredBase && configuredBase !== '/') {
    return configuredBase.startsWith('/')
      ? configuredBase.replace(/\/+$/, '') || '/'
      : `/${configuredBase.replace(/\/+$/, '')}`;
  }
  const pathname = String(window.location.pathname || '/');
  const sharedIndex = pathname.indexOf('/shared/');
  const base = sharedIndex >= 0
    ? pathname.slice(0, sharedIndex).replace(/\/+$/, '')
    : pathname.replace(/\/+$/, '');
  return base || '/';
}

function clearLegacyClientAuthCookie() {
  const path = resolveAuthCookiePath();
  document.cookie = `${AUTH_COOKIE_NAME}=; Path=${path}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

function consumeLegacyPersistedAuthToken() {
  let sessionValue = '';
  let localValue = '';
  try {
    sessionValue = String(sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '').trim();
    sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    sessionValue = '';
  }
  try {
    localValue = String(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || '').trim();
    localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    localValue = '';
  }
  clearLegacyClientAuthCookie();
  return sessionValue || localValue;
}

function stripTokenFromUrl() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('token')) return;
  url.searchParams.delete('token');
  history.replaceState(null, document.title, `${url.pathname}${url.search}${url.hash}`);
}

function ensureTrailingSlashPath() {
  if (isSharedReaderMode()) return false;
  const url = new URL(window.location.href);
  const path = url.pathname || '/';
  if (path === '/' || path.endsWith('/')) return false;
  const lastSegment = path.split('/').filter(Boolean).pop() || '';
  if (lastSegment.includes('.')) return false;
  url.pathname = `${path}/`;
  window.location.replace(url.toString());
  return true;
}

function sharedViewerId() {
  let viewerId = '';
  try {
    viewerId = String(sessionStorage.getItem(SHARED_VIEWER_ID_STORAGE_KEY) || '').trim();
  } catch {
    viewerId = sharedViewerIdFallback;
  }
  if (!viewerId) {
    viewerId = generateId();
    sharedViewerIdFallback = viewerId;
    try {
      sessionStorage.setItem(SHARED_VIEWER_ID_STORAGE_KEY, viewerId);
    } catch {}
  }
  return viewerId;
}

function stopSharedModeTimers() {
  if (sharedConversationPollTimer) {
    clearInterval(sharedConversationPollTimer);
    sharedConversationPollTimer = null;
  }
  if (sharedPresencePollTimer) {
    clearInterval(sharedPresencePollTimer);
    sharedPresencePollTimer = null;
  }
  if (liveConversationPollTimer) {
    clearInterval(liveConversationPollTimer);
    liveConversationPollTimer = null;
  }
  sharedConversationPollInFlight = false;
  sharedConversationRequestSeq = 0;
  sharedConversationAppliedSeq = 0;
  liveConversationPollInFlight = false;
}

function isAppForegrounded() {
  return document.visibilityState === 'visible';
}

// Polling gates on foreground state alone. It deliberately ignores the recovery
// latch: polling is the fallback that keeps the UI current while the socket is
// down, so a slow or stalled recovery pass must not silence it.
function shouldRunForegroundNetworkWork() {
  return isAppForegrounded();
}

function setForegroundNetworkWorkEnabled(enabled) {
  const next = !!enabled;
  setNetworkRequestsEnabled(next);
  setSocketActivityEnabled(next);
}

function clearForegroundRecoveryLatch() {
  if (foregroundRecoveryWatchdogTimer) {
    clearTimeout(foregroundRecoveryWatchdogTimer);
    foregroundRecoveryWatchdogTimer = null;
  }
  foregroundRecoveryInFlight = false;
}

async function runForegroundRecovery(reason = 'visible') {
  if (!isAppForegrounded()) return;
  // Re-enabling the transport happens ahead of the stampede guard. An explicit
  // socket.disconnect() drops socket.io's own reconnect subscriptions, so this is
  // the only route back online and it must never be skippable.
  setForegroundNetworkWorkEnabled(true);
  if (foregroundRecoveryInFlight) {
    recordStatusEvent('foreground-recovery-skipped', { reason });
    return;
  }
  const generation = ++foregroundRecoveryGeneration;
  foregroundRecoveryInFlight = true;
  foregroundRecoveryWatchdogTimer = setTimeout(() => {
    foregroundRecoveryWatchdogTimer = null;
    foregroundRecoveryInFlight = false;
    recordStatusEvent('foreground-recovery-timeout', {
      reason,
      timeoutMs: FOREGROUND_RECOVERY_TIMEOUT_MS,
    });
  }, FOREGROUND_RECOVERY_TIMEOUT_MS);
  try {
    if (appSharedMode) {
      await refreshSharedConversation();
      await pulseSharedViewerPresence();
      return;
    }
    // Each step recovers a different slice of missed state; isolate their
    // failures so one fetch losing a race with a restarting relay cannot
    // skip the rest — refreshCurrentView in particular is the only
    // correction path for change events this client missed while suspended
    // (an emptied background-task store never re-announces itself).
    const recoverySteps = [
      ['session-worker-status', () => refreshSessionWorkerStatus()],
      ['current-view', () => refreshCurrentView()],
      ['model-catalog', () => refreshModelCatalog(true)],
      ['relay-questions', () => loadRelayQuestions(currentConvId)],
      ['relay-boards', () => loadRelayBoards()],
    ];
    for (const [step, run] of recoverySteps) {
      try {
        await run();
      } catch (error) {
        console.warn(`[foreground-recovery:${reason}] ${step}`, error?.message || error);
      }
    }
  } catch (error) {
    console.warn(`[foreground-recovery:${reason}]`, error?.message || error);
  } finally {
    // The watchdog may already have released the latch and let a newer pass take
    // ownership; only the pass that still owns it may clear it.
    if (foregroundRecoveryGeneration === generation) clearForegroundRecoveryLatch();
  }
}

function scheduleForegroundRecovery(reason = 'visible', { immediate = false } = {}) {
  if (foregroundRecoveryTimer) {
    clearTimeout(foregroundRecoveryTimer);
    foregroundRecoveryTimer = null;
  }
  if (immediate) {
    void runForegroundRecovery(reason);
    return;
  }
  foregroundRecoveryTimer = setTimeout(() => {
    foregroundRecoveryTimer = null;
    void runForegroundRecovery(reason);
  }, FOREGROUND_RECOVERY_DEBOUNCE_MS);
}

function cancelBackgroundSuspend() {
  if (!backgroundSuspendTimer) return;
  clearTimeout(backgroundSuspendTimer);
  backgroundSuspendTimer = null;
}

// Defer the background suspend by the grace period so a quick app switch keeps
// the socket alive (and connectionStateRecovery never even has to replay).
function scheduleBackgroundSuspend() {
  cancelBackgroundSuspend();
  if (BACKGROUND_SUSPEND_GRACE_MS <= 0) {
    setForegroundNetworkWorkEnabled(false);
    return;
  }
  backgroundSuspendTimer = setTimeout(() => {
    backgroundSuspendTimer = null;
    // A throttled or sleep-delayed timer can fire at the exact moment the user
    // returns; re-check visibility so it cannot tear down a healthy connection.
    if (document.visibilityState !== 'hidden') return;
    setForegroundNetworkWorkEnabled(false);
  }, BACKGROUND_SUSPEND_GRACE_MS);
}

// A notification tap in the service worker either messages an existing window
// (copilot-open-conversation) or opens a fresh one with ?push_conv=<id>.
function initPushNotificationClientHooks() {
  if (!('serviceWorker' in navigator)) return;
  if (window.__pushNotificationHooksBound) return;
  window.__pushNotificationHooksBound = true;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type !== 'copilot-open-conversation') return;
    const conversationId = String(data.conversationId || '').trim();
    if (!conversationId) return;
    void openConversation(conversationId).catch(() => {});
  });
}

function consumePushConversationDeepLink() {
  const url = new URL(window.location.href);
  const conversationId = String(url.searchParams.get('push_conv') || '').trim();
  if (!conversationId) return '';
  url.searchParams.delete('push_conv');
  history.replaceState(null, document.title, `${url.pathname}${url.search}${url.hash}`);
  return conversationId;
}

function handleForegroundTransition(reason, { immediate = false } = {}) {
  if (!isAppForegrounded()) return;
  // The app came back before the grace period elapsed; keep the socket.
  cancelBackgroundSuspend();
  // The transport comes back right away; only the data refresh is debounced.
  setForegroundNetworkWorkEnabled(true);
  // Tell the server this device is foregrounded again so push suppression
  // resumes. If the socket is still reconnecting this is a no-op; the
  // connect-time heartbeat covers that case.
  emitDeviceVisibility(true);
  // A socket that reports connected after a freeze may be a zombie whose
  // ping-timeout timer died with the freeze; probe it instead of trusting it.
  verifySocketLiveness();
  scheduleForegroundRecovery(reason, { immediate });
}

// socket.io gives up permanently after an explicit disconnect or a rejected
// handshake, so a dropped relay never comes back on its own while the app stays in
// the foreground. This is the safety net for that. It deliberately does not
// consult navigator.onLine: Android Chrome can report a stale `false` after a
// standby resume while fetches work fine, and that guard once muzzled the
// watchdog for the rest of the page's life. A failed connect attempt is cheap;
// a silently disabled watchdog is not.
//
// connect() alone cannot escape every wedged manager state (see
// relay-watchdog-policy.mjs), so ticks spent disconnected escalate to a hard
// reset of the socket.
function startRelayConnectionWatchdog() {
  if (relayConnectionWatchdogTimer || appSharedMode) return;
  relayConnectionWatchdogTimer = setInterval(() => {
    if (!isAppForegrounded()) {
      // Background ticks say nothing about the connection; a count carried
      // across a resume could trigger a reset before reconnection had a chance.
      relayWatchdogDisconnectedTicks = 0;
      return;
    }
    const state = ensureSocketConnected();
    if (state === 'forced') recordStatusEvent('relay-reconnect-forced', {});
    const advice = adviseWatchdogTick({ state, disconnectedTicks: relayWatchdogDisconnectedTicks });
    relayWatchdogDisconnectedTicks = advice.disconnectedTicks;
    if (advice.hardReset) {
      hardResetSocket();
      recordStatusEvent('relay-socket-hard-reset', {
        state,
        afterTicks: RELAY_WATCHDOG_HARD_RESET_TICKS,
      });
    }
  }, RELAY_WATCHDOG_INTERVAL_MS);
}

// Visibility is reported on transitions, but the server ages those reports out
// after 90s. Without a periodic re-assert, a user who simply sits and reads for
// longer than that stops looking active, and a turn finishing afterwards pushes a
// notification to the phone already in their hand.
function startDeviceVisibilityHeartbeat() {
  if (deviceVisibilityHeartbeatTimer || appSharedMode) return;
  deviceVisibilityHeartbeatTimer = setInterval(() => {
    if (!isAppForegrounded()) return;
    emitDeviceVisibility(true);
  }, DEVICE_VISIBILITY_HEARTBEAT_MS);
}

function initNetworkLifecycleHandling() {
  if (networkLifecycleBound) return;
  networkLifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // The "now hidden" heartbeat goes out immediately — the transport stays
      // up for the grace period, so without it the device would keep looking
      // active and suppress push notifications for every device.
      emitDeviceVisibility(false);
      scheduleBackgroundSuspend();
      return;
    }
    handleForegroundTransition('visibility');
  });
  window.addEventListener('online', () => {
    handleForegroundTransition('online', { immediate: true });
  });
  window.addEventListener('offline', () => {
    cancelBackgroundSuspend();
    setForegroundNetworkWorkEnabled(false);
  });
  window.addEventListener('pageshow', () => {
    handleForegroundTransition('pageshow', { immediate: true });
  });
  window.addEventListener('pagehide', () => {
    // The page is going away; no grace period, suspend immediately.
    cancelBackgroundSuspend();
    setForegroundNetworkWorkEnabled(false);
  });
  // Android Chrome freezes backgrounded PWAs. A freeze/resume cycle can happen
  // without any visibility transition, so resume needs its own recovery trigger.
  document.addEventListener('freeze', () => {
    // Timers will not run while frozen, so the pending grace timer is useless;
    // suspend now while code can still run.
    cancelBackgroundSuspend();
    setForegroundNetworkWorkEnabled(false);
  });
  document.addEventListener('resume', () => {
    handleForegroundTransition('resume', { immediate: true });
  });
}

function syncThemeMenuLabel() {
  const button = document.getElementById('chat-menu-shared-theme-toggle');
  if (!button) return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  button.textContent = isLight ? '🌙 Night mode' : '☀️ Day mode';
}

function initThemeMenuToggle() {
  const themeBtn = document.getElementById('chat-menu-shared-theme-toggle');
  if (!themeBtn) return;
  themeBtn.hidden = false;
  syncThemeMenuLabel();
  if (themeBtn.dataset.bound === '1') return;
  themeBtn.dataset.bound = '1';
  bindMenuAction(themeBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    updateTheme(isLight ? 'dark' : 'light');
    syncThemeMenuLabel();
    closeChatActionsMenu();
  });
}

function disableSharedControl(element, {
  title = 'Shared conversation (read-only)',
  hide = false,
} = {}) {
  if (!element) return;
  element.disabled = true;
  element.setAttribute('aria-disabled', 'true');
  if (title) element.title = title;
  if (hide) element.hidden = true;
}

function hideSharedMenuEntry(element) {
  if (!element) return;
  element.hidden = true;
  element.setAttribute('aria-hidden', 'true');
  if ('disabled' in element) element.disabled = true;
  if ('tabIndex' in element) element.tabIndex = -1;
}

function applySharedReaderUi() {
  document.body.classList.add('shared-reader-mode', 'sidebar-collapsed');
  closeSidebar();
  const sidebar = document.getElementById('sidebar');
  const sidebarResizer = document.getElementById('sidebar-resizer');
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const newConversationBtn = document.getElementById('new-conv-btn');
  const searchBtn = document.getElementById('message-search-btn');
  const contextBtn = document.getElementById('context-btn');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const input = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const attachBtn = document.getElementById('attach-btn');
  const emojiBtn = document.getElementById('emoji-btn');
  const repoDesktopBtn = document.getElementById('repo-browser-desktop-btn');
  const repoInputBtn = document.getElementById('repo-browser-input-btn');
  const repoFabBtn = document.getElementById('repo-browser-fab');
  const modelSelect = document.getElementById('model-select');
  const effortSelect = document.getElementById('reasoning-effort-select');
  const modeSelect = document.getElementById('mode-select');
  const chatMenuBtn = document.getElementById('chat-actions-menu-btn');
  const chatMenu = document.getElementById('chat-actions-menu');
  const sharedThemeBtn = document.getElementById('chat-menu-shared-theme-toggle');
  const installBtn = document.getElementById('install-btn');
  const activeElement = document.activeElement;
  if (chatMenu && activeElement instanceof Element && chatMenu.contains(activeElement)) {
    activeElement.blur();
  }
  closeChatActionsMenu();
  if (sidebar) sidebar.hidden = true;
  if (sidebarResizer) sidebarResizer.hidden = true;
  if (sidebarToggle) sidebarToggle.hidden = true;
  if (newConversationBtn) newConversationBtn.hidden = true;
  disableSharedControl(searchBtn);
  disableSharedControl(contextBtn);
  if (fullscreenBtn) fullscreenBtn.hidden = true;
  if (input) {
    input.readOnly = true;
    input.disabled = true;
    input.placeholder = 'Shared conversation (read-only)';
  }
  disableSharedControl(sendBtn);
  disableSharedControl(attachBtn);
  disableSharedControl(emojiBtn);
  disableSharedControl(repoDesktopBtn, { hide: true });
  disableSharedControl(repoInputBtn);
  if (repoFabBtn) repoFabBtn.hidden = true;
  disableSharedControl(installBtn, { hide: true, title: 'PWA install is unavailable for shared conversations' });
  if (modelSelect) modelSelect.hidden = true;
  if (effortSelect) effortSelect.hidden = true;
  if (modeSelect) modeSelect.hidden = true;
  if (chatMenu && sharedThemeBtn) {
    for (const child of Array.from(chatMenu.children)) {
      if (child !== sharedThemeBtn) hideSharedMenuEntry(child);
    }
    sharedThemeBtn.hidden = false;
    sharedThemeBtn.removeAttribute('aria-hidden');
    sharedThemeBtn.disabled = false;
    sharedThemeBtn.tabIndex = 0;
    syncThemeMenuLabel();
  } else if (chatMenuBtn) {
    chatMenuBtn.hidden = true;
  }
  if (chatMenuBtn && !sharedThemeBtn) chatMenuBtn.hidden = true;
}

function syncChatTitleWatcherIndicator() {
  const indicator = document.getElementById('chat-title-watch-indicator');
  if (!indicator) return;
  if (isSharedReaderMode()) {
    indicator.hidden = true;
    return;
  }
  const convId = String(currentConvId || '').trim();
  const watcherCount = convId ? getConversationWatcherCount(convId) : 0;
  indicator.hidden = watcherCount <= 0;
  indicator.title = watcherCount > 0 ? `${watcherCount} watcher${watcherCount === 1 ? '' : 's'} currently reading this conversation` : '';
}

function computeSharedConversationRenderKey(response = null) {
  const messages = Array.isArray(response?.messages) ? response.messages : [];
  const ids = messages.map((message) => `${String(message?.id || '').trim()}:${String(message?.timestamp || '').trim()}`).join('|');
  const inFlight = response?.inFlight || null;
  return [
    String(response?.id || '').trim(),
    String(response?.updatedAt || '').trim(),
    messages.length,
    ids,
    String(inFlight?.messageId || '').trim(),
    String(inFlight?.status || '').trim(),
    String(inFlight?.lastStreamSeq || '').trim(),
    inFlight?.streamDone ? '1' : '0',
  ].join('::');
}

function resolveStableScrollTopForLiveRefresh(messagesEl, capturedScrollTop) {
  const captured = Number(capturedScrollTop);
  const current = Number(messagesEl?.scrollTop);
  if (!Number.isFinite(current)) return Number.isFinite(captured) ? captured : 0;
  if (!Number.isFinite(captured)) return current;
  if (Math.abs(current - captured) > 2) return current;
  return captured;
}

async function refreshSharedConversation() {
  if (sharedConversationPollInFlight) return;
  const sharedToken = resolveSharedTokenFromLocation();
  if (!sharedToken) return;
  sharedConversationPollInFlight = true;
  const requestSeq = ++sharedConversationRequestSeq;
  const messagesEl = document.getElementById('messages');
  const preserveBottom = isMessagesAtBottom();
  const savedScrollTop = messagesEl?.scrollTop || 0;
  try {
    const response = await loadSharedConversation(sharedToken, { limit: 120 });
    if (requestSeq < sharedConversationAppliedSeq) return;
    if (!response?.ok) {
      const message = String(response?.error || 'Could not load shared conversation.').trim();
      if (message && message !== sharedConversationLastError) {
        setModelBanner(`⚠️ ${message}`);
        sharedConversationLastError = message;
      }
      return;
    }
    if (sharedConversationLastError) {
      sharedConversationLastError = '';
      setModelBanner('');
    }
    const convId = String(response.id || '').trim();
    if (!convId) return;
    setCurrentConv(convId);
    conversations[convId] = {
      ...(conversations[convId] || {}),
      id: convId,
      title: String(response.title || 'Shared conversation').trim() || 'Shared conversation',
      updatedAt: response.updatedAt || new Date().toISOString(),
      messageCount: Array.isArray(response.messages) ? response.messages.length : 0,
      sdkSessionId: null,
      runtimeSessionId: null,
    };
    const titleEl = document.getElementById('chat-title');
    if (titleEl) titleEl.textContent = conversations[convId].title;
    const renderKey = computeSharedConversationRenderKey(response);
    if (renderKey && renderKey === sharedConversationRenderKey) {
      sharedConversationAppliedSeq = requestSeq;
      return;
    }
    sharedConversationRenderKey = renderKey;
    const stableSavedScrollTop = resolveStableScrollTopForLiveRefresh(messagesEl, savedScrollTop);
    applyLoadedConversationState(convId, response, {
      restoreScroll: !preserveBottom,
      savedScrollTop: preserveBottom ? null : stableSavedScrollTop,
      followLiveUpdates: preserveBottom,
    });
    sharedConversationAppliedSeq = requestSeq;
    syncViewportMetrics();
  } finally {
    sharedConversationPollInFlight = false;
  }
}

async function pulseSharedViewerPresence() {
  const sharedToken = resolveSharedTokenFromLocation();
  if (!sharedToken) return;
  await reportSharedViewerPresence(sharedToken, sharedViewerId()).catch(() => {});
}

async function initSharedConversationReader() {
  applySharedReaderUi();
  await refreshSharedConversation();
  await pulseSharedViewerPresence();
  stopSharedModeTimers();
  sharedConversationPollTimer = setInterval(() => {
    if (!shouldRunForegroundNetworkWork()) return;
    void refreshSharedConversation();
  }, 900);
  sharedPresencePollTimer = setInterval(() => {
    if (!shouldRunForegroundNetworkWork()) return;
    void pulseSharedViewerPresence();
  }, 12_000);
}

function showAuthError(msg) {
  document.getElementById('auth-error').textContent = msg;
}

function resolveAuthErrorMessage(result = null) {
  if (result?.status === 401) return 'Invalid token';
  if (result?.status === 403) return 'Access denied';
  if (result?.status > 0) return `Authentication failed (${result.status})`;
  return String(result?.error || 'Could not reach the relay').trim() || 'Could not reach the relay';
}

function syncPwaVersionMenuEntry() {
  const chip = document.getElementById('chat-menu-pwa-version');
  const value = document.getElementById('chat-menu-pwa-version-value');
  if (!chip) return;
  const version = String(window.__COPILOT_PWA_VERSION || '').trim();
  if (value) {
    value.textContent = version ? `v${version}` : 'v?';
    return;
  }
  chip.textContent = version ? `PWA shell version: v${version}` : 'PWA shell version: v?';
}

function normalizeQueueCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function updateQueueStatusFromPayload(payload = null) {
  if (!payload || typeof payload !== 'object') return;
  latestQueueStatus = {
    pendingCount: normalizeQueueCount(payload.pendingCount ?? payload.queue?.pendingCount),
    processingCount: normalizeQueueCount(payload.processingCount ?? payload.queue?.processingCount),
    parkedCount: normalizeQueueCount(payload.parkedCount ?? payload.queue?.parkedCount),
  };
}

function syncQueueStatusMenuEntry(payload = null) {
  if (payload) updateQueueStatusFromPayload(payload);
  const chip = document.getElementById('chat-menu-queue-status');
  const value = document.getElementById('chat-menu-queue-status-value');
  if (!chip) return;
  const statusText = `pending=${latestQueueStatus.pendingCount}, processing=${latestQueueStatus.processingCount}, parked=${latestQueueStatus.parkedCount}`;
  if (value) {
    value.textContent = statusText;
    return;
  }
  chip.textContent = `Queue: ${statusText}`;
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

function humanizeModelLabel(modelId = '') {
  const text = String(modelId || '').trim();
  if (!text) return '';
  if (/^gpt-/i.test(text)) {
    return text
      .replace(/^gpt-/i, 'GPT-')
      .replace(/-codex$/i, ' Codex')
      .replace(/-mini$/i, ' Mini');
  }
  if (/^claude-/i.test(text)) {
    return text
      .replace(/^claude-/i, 'Claude ')
      .split('-')
      .map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : (part.charAt(0).toUpperCase() + part.slice(1))))
      .join(' ');
  }
  if (/^gemini-/i.test(text)) {
    return text
      .replace(/^gemini-/i, 'Gemini ')
      .split('-')
      .map((part) => (/^\d+(\.\d+)?$/.test(part) ? part : (part.charAt(0).toUpperCase() + part.slice(1))))
      .join(' ');
  }
  return text;
}

function modelOptionLabel(modelVariantId = '') {
  if (String(modelVariantId || '').trim().toLowerCase() === AUTO_MODEL_OPTION) return 'Auto';
  const { baseModelId, reasoningEffort } = splitVariantId(modelVariantId);
  if (!baseModelId) return modelVariantId;
  const baseLabel = humanizeModelLabel(baseModelId);
  return reasoningEffort ? `${baseLabel} (${reasoningEffort})` : baseLabel;
}

function normalizeReasoningEffortList(efforts = []) {
  const values = Array.isArray(efforts)
    ? efforts.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return Array.from(new Set(values));
}

function isModelMetadataHealthy(payload = modelCatalogState) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.metadataValid === false) return false;
  if (payload.stale) return false;
  const reasoningByModel = payload.reasoningByModel && typeof payload.reasoningByModel === 'object'
    ? payload.reasoningByModel
    : {};
  const modelIds = Object.keys(reasoningByModel).filter((modelId) => modelId !== AUTO_MODEL_OPTION);
  if (!modelIds.length) return false;
  return modelIds.every((modelId) => {
    const efforts = reasoningByModel[modelId];
    return Array.isArray(efforts) && efforts.length > 0;
  });
}

function syncModelMetadataBlocker(message = '') {
  // Shared readers have no model picker, so metadata problems are not actionable there.
  if (isSharedReaderMode()) {
    document.getElementById('model-metadata-blocker')?.classList.remove('visible');
    return;
  }
  const blocker = document.getElementById('model-metadata-blocker');
  const text = document.getElementById('model-metadata-blocker-text');
  const retryBtn = document.getElementById('model-metadata-retry-btn');
  const blocked = modelMetadataBlocked || !isModelMetadataHealthy();
  if (text) {
    text.textContent = String(message || '').trim()
      || 'Model metadata is unavailable. Refresh to choose a model and reasoning effort.';
  }
  if (retryBtn) retryBtn.disabled = modelMetadataRetryInFlight;
  blocker?.classList.toggle('visible', blocked);
  const modelSelect = document.getElementById('model-select');
  const reasoningSelect = document.getElementById('reasoning-effort-select');
  if (modelSelect) {
    modelSelect.disabled = blocked;
    modelSelect.title = blocked ? 'Model metadata unavailable' : 'Model';
  }
  if (reasoningSelect) {
    reasoningSelect.disabled = blocked;
    reasoningSelect.title = blocked ? 'Reasoning metadata unavailable' : 'Reasoning effort';
  }
  window.syncComposerControlState?.();
}

function currentConversationHasMessages() {
  const conversation = currentConvId ? conversations[currentConvId] : null;
  return Number(conversation?.messageCount || 0) > 0;
}

function currentOpenAIModelLock() {
  const conversation = currentConvId ? conversations[currentConvId] : null;
  const providerType = String(
    conversation?.runtimeProviderType
    || conversation?.runtime_provider_type
    || '',
  ).trim().toLowerCase();
  const providerIsOpenAI = providerType === 'openai' || providerType === 'openai-byok';
  if (!providerIsOpenAI || !currentConversationHasMessages()) return null;
  return {
    model: String(
      conversation?.runtimeProviderModel
      || conversation?.runtime_provider_model
      || '',
    ).trim(),
  };
}

// A Grok conversation's model is fixed once the first message exists: the ACP
// session cannot switch models mid-session and the relay 409s any attempt, so
// the composer pins the picker instead of offering a switch that would fail.
function currentGrokModelLock() {
  const conversation = currentConvId ? conversations[currentConvId] : null;
  const providerType = String(
    conversation?.runtimeProviderType
    || conversation?.runtime_provider_type
    || '',
  ).trim().toLowerCase();
  if (providerType !== 'grok' || !currentConversationHasMessages()) return null;
  return {
    model: String(
      conversation?.runtimeProviderModel
      || conversation?.runtime_provider_model
      || '',
    ).trim(),
  };
}

function currentRuntimeModelLock() {
  return currentOpenAIModelLock() || currentGrokModelLock();
}

// The runtime model decides the OpenAI/OpenAI Image distinction. Before the
// first message the runtime model can still be rebound, so the composer
// selection is the fresher source there.
function sessionLockModelForCurrentConversation() {
  const conversation = currentConvId ? conversations[currentConvId] : null;
  const runtimeModel = String(
    conversation?.runtimeProviderModel
    || conversation?.runtime_provider_model
    || conversation?.runtimeModel
    || conversation?.runtime_model
    || '',
  ).trim();
  if (currentConversationHasMessages()) return runtimeModel;
  return String(document.getElementById('model-select')?.value || '').trim() || runtimeModel;
}

function currentSessionProviderLock({ pinnedModel = '' } = {}) {
  // Shared readers have no model picker, so a lock note would be noise.
  if (!currentConvId || isSharedReaderMode()) return null;
  const providerType = activeComposerProviderType();
  const model = sessionLockModelForCurrentConversation();
  const noteText = sessionLockNoteText({ providerType, model, pinnedModel });
  if (!noteText) return null;
  return { providerKey: sessionLockProviderKey({ providerType, model }), noteText };
}

function syncAutoModelAvailability() {
  const select = document.getElementById('model-select');
  if (!select) return;
  updateModeSelectorForProvider();
  const currentProviderScope = normalizeModelSelectorProviderType(activeComposerProviderType());
  if (select.dataset.providerScope !== currentProviderScope) {
    updateModelCatalogState(modelCatalogState);
    return;
  }
  const autoOption = Array.from(select.options).find((option) => option.value.toLowerCase() === AUTO_MODEL_OPTION);
  const hasMessages = currentConversationHasMessages();
  const runtimeLock = currentRuntimeModelLock();
  for (const option of Array.from(select.options)) {
    if (option.dataset.runtimeModelLock === '1' && option.value !== runtimeLock?.model) {
      option.remove();
    }
  }
  if (autoOption) {
    autoOption.disabled = hasMessages;
    autoOption.title = hasMessages ? 'Auto is available only for a new conversation' : '';
  }
  if (hasMessages && select.value.toLowerCase() === AUTO_MODEL_OPTION) {
    const fallback = [
      modelCatalogState.currentModel,
      modelCatalogState.defaultModel,
      ...modelCatalogState.models,
    ].find((modelId) => String(modelId || '').trim().toLowerCase() !== AUTO_MODEL_OPTION
      && Array.from(select.options).some((option) => option.value === modelId));
    if (fallback) select.value = fallback;
  }
  if (runtimeLock?.model && !Array.from(select.options).some((option) => option.value === runtimeLock.model)) {
    const option = document.createElement('option');
    option.value = runtimeLock.model;
    option.textContent = `🔒 ${modelOptionLabel(runtimeLock.model)}`;
    option.dataset.runtimeModelLock = '1';
    select.appendChild(option);
  }
  if (runtimeLock?.model) {
    select.value = runtimeLock.model;
  }
  select.dataset.runtimeModelLocked = runtimeLock ? '1' : '0';
  const metadataBlocked = modelMetadataBlocked || !isModelMetadataHealthy();
  select.disabled = metadataBlocked || !!runtimeLock;
  select.title = runtimeLock
    ? `Model locked to ${runtimeLock.model || 'the configured provider model'} for this active session`
    : (metadataBlocked ? 'Model metadata unavailable' : 'Model');
  syncSessionLockNote({ pinnedModel: runtimeLock?.model || '' });
}

function syncSessionLockNote({ pinnedModel = '' } = {}) {
  const note = document.getElementById('model-lock-note');
  if (!note) return;
  const providerLock = currentSessionProviderLock({ pinnedModel });
  note.hidden = !providerLock;
  note.textContent = providerLock?.noteText || '';
  if (providerLock?.providerKey) {
    note.dataset.provider = providerLock.providerKey;
  } else {
    delete note.dataset.provider;
  }
}

function applyModelMetadataHardFail(message = '') {
  if (isSharedReaderMode()) return;
  modelMetadataBlocked = true;
  syncModelMetadataBlocker(message);
  setModelBanner(`⚠️ ${String(message || 'Model metadata is unavailable.').trim()}`);
}

function clearModelMetadataHardFail() {
  modelMetadataBlocked = false;
  syncModelMetadataBlocker('');
  if (!modelCatalogState.warning && !modelCatalogState.stale) {
    setModelBanner('');
  }
}

async function startAppWithErrorHandling() {
  try {
    await initApp();
    return true;
  } catch (error) {
    console.error('[bootstrap] initApp failed', error);
    showAuthGate();
    showAuthError(`App initialization failed: ${String(error?.message || error || 'unknown error')}`);
    return false;
  }
}

function activeComposerProviderType() {
  const conversation = conversations[currentConvId] || null;
  return String(
    conversation?.runtimeProviderType
    || conversation?.runtime_provider_type
    || 'github',
  ).trim().toLowerCase();
}

function normalizeModelSelectorProviderType(providerType = '') {
  const normalized = String(providerType || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-byok') return 'openai';
  if (normalized === 'claude') return 'claude';
  if (normalized === 'cursor') return 'cursor';
  if (normalized === 'grok') return 'grok';
  return 'github';
}

function modelProvidersForId(modelId, providersByModel = {}) {
  const key = String(modelId || '').trim().toLowerCase();
  if (!key) return [];
  const providers = providersByModel?.[key];
  if (!Array.isArray(providers)) return [];
  return providers.map((provider) => String(provider || '').trim().toLowerCase()).filter(Boolean);
}

function openAIImageSizesForModel(modelId = '') {
  const normalized = String(modelId || '').trim().toLowerCase().replace(/^openai\//, '');
  if (normalized.startsWith('dall-e-2')) return ['256x256', '512x512', '1024x1024'];
  if (normalized.startsWith('dall-e-3')) return ['1024x1024', '1792x1024', '1024x1792'];
  return ['auto', '1024x1024', '1536x1024', '1024x1536'];
}

function modelVisibleForActiveProvider(modelId, activeProviderType, providersByModel = {}) {
  const normalizedModelId = String(modelId || '').trim().toLowerCase();
  if (!normalizedModelId) return false;
  if (normalizedModelId === AUTO_MODEL_OPTION) return true;
  const providers = modelProvidersForId(normalizedModelId, providersByModel);
  const hasOpenAIByok = providers.includes('openai-byok');
  const hasClaude = providers.includes('claude');
  const hasCursor = providers.includes('cursor');
  const hasGrok = providers.includes('grok');
  const hasNonExclusiveProvider = providers.some((provider) => (
    provider !== 'openai-byok'
    && provider !== 'claude'
    && provider !== 'cursor'
    && provider !== 'grok'
  ));
  const activeProvider = normalizeModelSelectorProviderType(activeProviderType);
  if (activeProvider === 'openai') return hasOpenAIByok;
  if (activeProvider === 'claude') return hasClaude;
  if (activeProvider === 'cursor') return hasCursor;
  if (activeProvider === 'grok') return hasGrok;
  return !((hasOpenAIByok || hasClaude || hasCursor || hasGrok) && !hasNonExclusiveProvider);
}

function buildModelSelectorOptions(models = [], providersByModel = {}, activeProviderType = '') {
  const normalizedOptions = normalizeModelSelectorOptions(models.length ? models : [FALLBACK_MODEL], {
    autoValue: AUTO_MODEL_OPTION,
    labelFor: modelOptionLabel,
  });
  return normalizedOptions.filter((option) => modelVisibleForActiveProvider(
    option.value,
    activeProviderType,
    providersByModel,
  ));
}

function reasoningOptionsForModel(modelId = '') {
  if (!isModelMetadataHealthy()) return [];
  const key = String(modelId || '').trim().toLowerCase();
  const provider = activeComposerProviderType();
  const providerOptions = modelCatalogState.reasoningByProvider?.[provider]?.[key];
  if (Array.isArray(providerOptions)) return normalizeReasoningEffortList(providerOptions);
  return normalizeReasoningEffortList(modelCatalogState.reasoningByModel?.[key] || []);
}

function reasoningProviderKey(providerType = '') {
  const key = String(providerType || '').trim().toLowerCase();
  if (key === 'openai-byok') return 'openai';
  if (key === 'github-copilot') return 'github';
  return key;
}

function reasoningOptionsForProviderModel(providerType = '', modelId = '') {
  if (!isModelMetadataHealthy()) return [];
  const key = String(modelId || '').trim().toLowerCase();
  if (!key) return [];
  const provider = reasoningProviderKey(providerType);
  const providerOptions = modelCatalogState.reasoningByProvider?.[provider]?.[key];
  if (Array.isArray(providerOptions) && providerOptions.length) {
    return normalizeReasoningEffortList(providerOptions);
  }
  return normalizeReasoningEffortList(modelCatalogState.reasoningByModel?.[key] || []);
}

function selectedReasoningEffortValue() {
  const select = document.getElementById('reasoning-effort-select');
  const value = String(select?.value || '').trim().toLowerCase();
  if (value) return value;
  return FALLBACK_REASONING_EFFORT;
}

// Opt in to persist=true only from a user-initiated change. Every other caller
// is re-rendering options (catalog refresh, provider rescope, applying a stored
// preference), and letting those write the shared fallback storage is what made
// a transient resolution the remembered default.
function updateReasoningSelectorForModel(modelId, preferredEffort = '', { persist = false } = {}) {
  const select = document.getElementById('reasoning-effort-select');
  if (!select) return;
  select.title = isOpenAIImageModelId(modelId) ? 'Quality' : 'Reasoning effort';
  const options = reasoningOptionsForModel(modelId);
  const currentEffort = String(select.value || '').trim().toLowerCase();
  const storedEffort = String(localStorage.getItem(REASONING_STORAGE_KEY) || '').trim().toLowerCase();
  select.innerHTML = '';
  if (!options.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Unavailable';
    select.appendChild(opt);
    select.value = '';
    return;
  }
  const reasoningOffUnsupported = isReasoningOffUnsupported(
    modelCatalogState,
    activeComposerProviderType(),
    modelId,
  );
  for (const effort of options) {
    const opt = document.createElement('option');
    opt.value = effort;
    opt.textContent = reasoningEffortOptionLabel(effort, { reasoningOffUnsupported });
    const optionTitle = reasoningEffortOptionTitle(effort);
    if (optionTitle) opt.title = optionTitle;
    select.appendChild(opt);
  }
  const resolved = resolveComposerReasoningEffort({
    preferredEffort,
    storedEffort,
    currentEffort,
    supportedEfforts: options,
  });
  select.value = resolved;
  if (persist && resolved) localStorage.setItem(REASONING_STORAGE_KEY, resolved);
}

// Rebuilds the option list for the active conversation's provider without
// touching the selection, mirroring updateModeSelectorForProvider. Preferences
// used to be clamped against the previous provider's options, which is how a
// Cursor conversation could keep the Claude model that was selected before it.
function rebuildModelSelectorOptionsForProvider() {
  const select = document.getElementById('model-select');
  if (!select || isSharedReaderMode()) return false;
  const activeProviderType = activeComposerProviderType();
  const scope = normalizeModelSelectorProviderType(activeProviderType);
  if (select.dataset.providerScope === scope) return false;
  // Same rule as the catalog refresh: never re-render the list out from under
  // an open picker. The scope stays unset so the rebuild happens on blur.
  if (document.activeElement === select) return false;
  const nextOptions = buildModelSelectorOptions(
    modelCatalogState.models,
    modelCatalogState.providersByModel,
    activeProviderType,
  );
  const currentOptions = Array.from(select.options)
    .filter((option) => option.dataset.runtimeModelLock !== '1')
    .map((option) => ({ value: option.value, label: option.textContent }));
  if (!modelSelectorOptionsEqual(currentOptions, nextOptions)) {
    const selectedBefore = String(select.value || '').trim();
    const lockedOptions = Array.from(select.options).filter((option) => option.dataset.runtimeModelLock === '1');
    select.innerHTML = '';
    for (const option of nextOptions) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.appendChild(opt);
    }
    for (const locked of lockedOptions) select.appendChild(locked);
    // Emptying the select resets the value to the first option, which would
    // hand the clamp below "auto" instead of what was actually selected.
    if (Array.from(select.options).some((option) => option.value === selectedBefore)) {
      select.value = selectedBefore;
    }
  }
  select.dataset.providerScope = scope;
  return true;
}

function updateModelCatalogState(payload) {
  // Shared readers never load the catalog, so this would only surface
  // "metadata unavailable" warnings for a picker they cannot see.
  if (isSharedReaderMode()) return;
  const select = document.getElementById('model-select');
  if (!select) return;
  const models = Array.isArray(payload?.models)
    ? payload.models.map((m) => String(m || '').trim()).filter(Boolean)
    : [];
  const currentModel = String(payload?.currentModel || models[0] || '').trim();
  const defaultModel = String(payload?.defaultModel || models[0] || '').trim();
  const normalizedModelOptions = normalizeModelSelectorOptions(models.length ? models : [FALLBACK_MODEL], {
    autoValue: AUTO_MODEL_OPTION,
    labelFor: modelOptionLabel,
  });
  const normalizedModels = normalizedModelOptions.map((option) => option.value);

  const nextState = {
    models: normalizedModels,
    currentModel: currentModel || normalizedModels[0] || FALLBACK_MODEL,
    defaultModel: defaultModel || normalizedModels[0] || FALLBACK_MODEL,
    reasoningByModel: payload?.reasoningByModel && typeof payload.reasoningByModel === 'object'
      ? Object.fromEntries(Object.entries(payload.reasoningByModel).map(([modelId, efforts]) => [
        String(modelId || '').trim().toLowerCase(),
        normalizeReasoningEffortList(efforts),
      ]))
      : {},
    reasoningByProvider: payload?.reasoningByProvider && typeof payload.reasoningByProvider === 'object'
      ? Object.fromEntries(Object.entries(payload.reasoningByProvider).map(([provider, entries]) => [
        String(provider || '').trim().toLowerCase(),
        entries && typeof entries === 'object'
          ? Object.fromEntries(Object.entries(entries).map(([modelId, efforts]) => [
              String(modelId || '').trim().toLowerCase(),
              normalizeReasoningEffortList(efforts),
            ]))
          : {},
      ]))
      : {},
    reasoningOffUnsupportedByProvider: payload?.reasoningOffUnsupportedByProvider && typeof payload.reasoningOffUnsupportedByProvider === 'object'
      ? Object.fromEntries(Object.entries(payload.reasoningOffUnsupportedByProvider).map(([provider, entries]) => [
        String(provider || '').trim().toLowerCase(),
        entries && typeof entries === 'object'
          ? Object.fromEntries(Object.entries(entries).map(([modelId, unsupported]) => [
              String(modelId || '').trim().toLowerCase(),
              unsupported === true,
            ]))
          : {},
      ]))
      : {},
    providersByModel: payload?.providersByModel && typeof payload.providersByModel === 'object'
      ? Object.fromEntries(Object.entries(payload.providersByModel).map(([modelId, providers]) => [
        String(modelId || '').trim().toLowerCase(),
        Array.isArray(providers)
          ? providers.map((provider) => String(provider || '').trim().toLowerCase()).filter(Boolean)
          : [],
      ]))
      : {},
    reasoningEfforts: normalizeReasoningEffortList(payload?.reasoningEfforts || []),
    modelMetadataByModel: payload?.modelMetadataByModel && typeof payload.modelMetadataByModel === 'object'
      ? payload.modelMetadataByModel
      : {},
    stale: !!payload?.stale,
    metadataValid: payload?.metadataValid === true,
    reasoningMetadataValid: payload?.reasoningMetadataValid === true,
    warning: payload?.warning ? String(payload.warning) : null,
    error: payload?.error ? String(payload.error) : null,
    refreshedAt: payload?.refreshedAt || null,
  };
  const activeProviderType = activeComposerProviderType();
  const nextOptions = buildModelSelectorOptions(
    normalizedModels,
    nextState.providersByModel,
    activeProviderType,
  );
  const nextModels = nextOptions.map((option) => option.value);
  const currentOptions = Array.from(select.options)
    .filter((option) => option.dataset.runtimeModelLock !== '1')
    .map((option) => ({
      value: option.value,
      label: option.textContent,
    }));
  const optionsChanged = !modelSelectorOptionsEqual(currentOptions, nextOptions);
  if (optionsChanged && document.activeElement === select) {
    deferredModelCatalogPayload = payload;
    return;
  }
  deferredModelCatalogPayload = null;

  const nextHealthy = isModelMetadataHealthy(nextState);
  const currentlyHealthy = isModelMetadataHealthy(modelCatalogState);
  if (!nextHealthy && !currentlyHealthy && isModelMetadataHealthy(lastHealthyModelCatalogState)) {
    modelCatalogState = { ...lastHealthyModelCatalogState };
    clearModelMetadataHardFail();
    setModelBanner('⚠️ Model metadata refresh failed; restored last known good catalog.');
    syncModelMetadataBlocker();
    return;
  }
  if (!nextHealthy && currentlyHealthy) {
    setModelBanner('⚠️ Model metadata refresh failed; keeping last known good catalog.');
    syncModelMetadataBlocker();
    return;
  }

  modelCatalogState = nextState;

  if (!nextHealthy) {
    applyModelMetadataHardFail(
      modelCatalogState.error
        ? `Model metadata error: ${modelCatalogState.error}`
        : (modelCatalogState.warning || 'Model metadata is stale or incomplete.'),
    );
  } else {
    lastHealthyModelCatalogState = modelCatalogState;
    clearModelMetadataHardFail();
  }

  const selectedBefore = select.value;
  if (optionsChanged) {
    select.innerHTML = '';
    for (const option of nextOptions) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      select.appendChild(opt);
    }
  }
  select.dataset.providerScope = normalizeModelSelectorProviderType(activeProviderType);

  // A catalog refresh re-renders options and keeps the current selection valid;
  // it must not decide what is selected. The active conversation's preferences
  // are reapplied at the end, so a refresh cannot overwrite the user's pick.
  const keptSelection = nextModels.includes(selectedBefore) ? selectedBefore : '';
  const nextSelection = keptSelection
    || [
      localStorage.getItem(MODEL_STORAGE_KEY),
      modelCatalogState.currentModel,
      modelCatalogState.defaultModel,
    ].map((value) => String(value || '').trim()).find((value) => value && nextModels.includes(value))
    || nextModels[0];
  select.value = nextSelection;
  updateReasoningSelectorForModel(nextSelection, '');
  updateContextTierSelector(nextSelection);

  if (modelCatalogState.warning && isModelMetadataHealthy(modelCatalogState)) {
    setModelBanner(`⚠️ ${modelCatalogState.warning}`);
  } else if (modelCatalogState.stale && isModelMetadataHealthy(modelCatalogState)) {
    setModelBanner('⚠️ Model list is cached from CLI; selection may be stale.');
  } else if (isModelMetadataHealthy(modelCatalogState)) {
    setModelBanner('');
  }

  syncModelMetadataBlocker();
  syncAutoModelAvailability();
  // The rebuilt catalog may now contain the conversation's preferred model for
  // the first time (provider models arrive after the initial catalog load).
  if (currentConvId) applyConversationPreferencesForConversation(currentConvId);
}

function selectedModelValue() {
  const select = document.getElementById('model-select');
  const value = String(select?.value || '').trim();
  if (value) return value;
  return modelCatalogState.currentModel || modelCatalogState.defaultModel || FALLBACK_MODEL;
}

function updateContextTierSelector(modelId) {
  const select = document.getElementById('context-tier-select');
  if (!select) return;
  if (isOpenAIImageModelId(modelId)) {
    const current = String(select.value || '').trim().toLowerCase();
    const imageSizes = openAIImageSizesForModel(modelId);
    select.innerHTML = '';
    for (const size of imageSizes) {
      const option = document.createElement('option');
      option.value = size;
      option.textContent = size;
      select.appendChild(option);
    }
    select.value = imageSizes.includes(current) ? current : 'auto';
    select.title = 'Image size';
    updateModelPricingDetails(modelId, 'default');
    return;
  }
  const metadata = modelCatalogState.modelMetadataByModel?.[modelId] || {};
  const defaultLimit = Number(metadata.defaultContextLimitTokens);
  const longLimit = Number(metadata.longContextLimitTokens);
  const current = select.value;
  select.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = 'default';
  defaultOption.textContent = Number.isFinite(defaultLimit) && defaultLimit > 0
    ? `${Math.round(defaultLimit / 1000)}K`
    : '—';
  select.appendChild(defaultOption);
  if (Number.isFinite(longLimit) && longLimit > 0) {
    const longOption = document.createElement('option');
    longOption.value = 'long_context';
    longOption.textContent = `${Math.round(longLimit / 1000)}K`;
    select.appendChild(longOption);
  }
  select.value = current === 'long_context' && select.querySelector('option[value="long_context"]')
    ? 'long_context'
    : 'default';
  select.title = 'Context window';
  updateModelPricingDetails(modelId, select.value);
}

function updateModelPricingDetails(modelId, tier) {
  const details = document.getElementById('model-pricing-details');
  const summary = document.getElementById('model-pricing-summary');
  const grid = document.getElementById('model-pricing-grid');
  if (!details || !summary || !grid) return;
  const metadata = modelCatalogState.modelMetadataByModel?.[modelId] || {};
  const pricing = metadata?.pricing?.[tier === 'long_context' ? 'longContext' : 'default'];
  if (!pricing || typeof pricing !== 'object') {
    details.open = false;
    details.style.display = 'none';
    grid.replaceChildren();
    return;
  }
  const perMillion = (value) => {
    const price = Number(value);
    const batchSize = Number(pricing.batchSize) || 1000000;
    return Number.isFinite(price) ? (price * 1000000) / batchSize : null;
  };
  const input = perMillion(pricing.input);
  summary.textContent = `${tier === 'long_context' ? 'Long context' : 'Default'} pricing${input !== null ? ` · ${input} credits / 1M input` : ''}`;
  grid.replaceChildren();
  for (const [label, value] of [['Input', pricing.input], ['Output', pricing.output], ['Cache read', pricing.cacheRead], ['Cache write', pricing.cacheWrite]]) {
    const credits = perMillion(value);
    if (credits === null) continue;
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const valueEl = document.createElement('b');
    valueEl.textContent = String(credits);
    grid.append(labelEl, valueEl);
  }
  details.style.display = grid.childElementCount ? '' : 'none';
}

// Relay modes each provider backend actually honors. All four providers
// currently support the full set — Copilot/OpenAI via prompt-context
// injection, Claude via permissionMode + system-prompt appends, Cursor via
// native plan mode plus message-text nudges for ask/autopilot — but the
// composer builds its options from this table so a provider that loses (or
// gains) a mode only needs a change here.
const RELAY_MODE_LABELS = { agent: 'Agent', ask: 'Ask', plan: 'Plan', autopilot: 'Autopilot' };
const RELAY_MODES_BY_PROVIDER = {
  github: ['agent', 'ask', 'plan', 'autopilot'],
  openai: ['agent', 'ask', 'plan', 'autopilot'],
  claude: ['agent', 'ask', 'plan', 'autopilot'],
  cursor: ['agent', 'ask', 'plan', 'autopilot'],
  grok: ['agent', 'ask', 'plan', 'autopilot'],
};

function relayModesForProvider(providerType = '') {
  const scope = normalizeModelSelectorProviderType(providerType);
  const modes = RELAY_MODES_BY_PROVIDER[scope];
  return Array.isArray(modes) && modes.length ? modes : RELAY_MODES_BY_PROVIDER.github;
}

// Same cache-and-rebuild idiom as the model select: dataset.providerScope
// remembers which provider the current options were built for.
function updateModeSelectorForProvider() {
  const select = document.getElementById('mode-select');
  if (!select || isSharedReaderMode()) return;
  const scope = normalizeModelSelectorProviderType(activeComposerProviderType());
  if (select.dataset.providerScope === scope) return;
  const modes = relayModesForProvider(scope);
  const selectedBefore = String(select.value || '').trim().toLowerCase();
  select.innerHTML = '';
  for (const mode of modes) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = RELAY_MODE_LABELS[mode] || mode;
    select.appendChild(option);
  }
  select.dataset.providerScope = scope;
  select.value = modes.includes(selectedBefore)
    ? selectedBefore
    : (modes.includes(FALLBACK_MODE) ? FALLBACK_MODE : modes[0]);
}

function modeOptions() {
  return Array.from(document.getElementById('mode-select')?.options || []).map((option) => option.value);
}

function modelOptions() {
  return Array.from(document.getElementById('model-select')?.options || []).map((option) => option.value);
}

async function persistCurrentConversationPreferences() {
  const convId = String(currentConvId || '').trim();
  if (!convId || suppressConversationPreferenceSync) return;
  const modeSelect = document.getElementById('mode-select');
  const modelSelect = document.getElementById('model-select');
  if (!modeSelect || !modelSelect) return;
  const mode = String(modeSelect.value || '').trim() || FALLBACK_MODE;
  const model = String(modelSelect.value || '').trim();
  // The raw value, not selectedReasoningEffortValue(): a model with no reasoning
  // options leaves the selector empty, and that helper's 'none' fallback would
  // record an effort the user never picked when they only changed the mode.
  const reasoningEffort = String(document.getElementById('reasoning-effort-select')?.value || '').trim().toLowerCase();
  // These keys hold the last explicit choice, so they are not rolled back when
  // the write below fails: the user did make the choice either way.
  localStorage.setItem(MODE_STORAGE_KEY, mode);
  if (model) localStorage.setItem(MODEL_STORAGE_KEY, model);
  if (reasoningEffort) localStorage.setItem(REASONING_STORAGE_KEY, reasoningEffort);

  // For Claude conversations the 1M context tier is stored as the "[1m]"
  // variant of the preferred model, so it survives reopening the conversation.
  const contextTier = String(document.getElementById('context-tier-select')?.value || 'default').trim().toLowerCase();
  const preferredModelWithTier = model
    && contextTier === 'long_context'
    && activeComposerProviderType() === 'claude'
    && !CLAUDE_LONG_CONTEXT_PATTERN.test(model)
    ? `${model}[1m]`
    : model;

  // Record the choice locally before the round-trip: a catalog refresh landing
  // while the PATCH is in flight reapplies preferences, and it must see the new
  // selection rather than the one being replaced.
  const previousRecord = conversations[convId] || null;
  if (previousRecord) {
    conversations[convId] = {
      ...previousRecord,
      preferredRelayMode: mode,
      preferredModel: preferredModelWithTier || previousRecord.preferredModel || '',
      preferredReasoningEffort: reasoningEffort || previousRecord.preferredReasoningEffort || '',
    };
  }

  const writeVersion = ++conversationPreferenceWriteVersion;
  const response = await updateConversationPreferences(convId, {
    clientId: CLIENT_ID,
    preferredRelayMode: mode,
    preferredModel: preferredModelWithTier,
    preferredReasoningEffort: reasoningEffort,
  });
  if (writeVersion !== conversationPreferenceWriteVersion) return;
  if (!response) {
    // The server never took the write, so the optimistic preference has to go
    // back rather than linger as one the next apply would trust. Only the three
    // preference fields are restored: the poll rewrites the rest of the record
    // (messageCount, runtime binding, title) during the round trip.
    if (previousRecord && conversations[convId]) {
      conversations[convId] = {
        ...conversations[convId],
        preferredRelayMode: previousRecord.preferredRelayMode,
        preferredModel: previousRecord.preferredModel,
        preferredReasoningEffort: previousRecord.preferredReasoningEffort,
      };
    }
    return;
  }
  if (conversations[convId]) {
    conversations[convId] = {
      ...conversations[convId],
      preferredRelayMode: response.preferredRelayMode,
      preferredModel: response.preferredModel || conversations[convId].preferredModel || '',
      preferredReasoningEffort: response.preferredReasoningEffort || conversations[convId].preferredReasoningEffort || '',
    };
  }
}

function applyConversationPreferences({
  preferredRelayMode = '',
  preferredModel = '',
  preferredReasoningEffort = '',
  preferredContextTier = 'default',
} = {}) {
  const modeSelect = document.getElementById('mode-select');
  const modelSelect = document.getElementById('model-select');
  if (!modeSelect || !modelSelect) return;

  // Options first, so the preference clamp below sees the provider's modes and
  // models. Clamping before the model rebuild let the previous conversation's
  // provider decide which models were "supported" for this one.
  updateModeSelectorForProvider();
  rebuildModelSelectorOptionsForProvider();
  const supportedModes = modeOptions();
  const supportedModels = modelOptions().length ? modelOptions() : modelCatalogState.models;
  const selection = resolveConversationComposerSelection({
    preferredRelayMode,
    preferredModel,
    selectedMode: modeSelect.value || localStorage.getItem(MODE_STORAGE_KEY) || FALLBACK_MODE,
    selectedModel: modelSelect.value || localStorage.getItem(MODEL_STORAGE_KEY) || FALLBACK_MODEL,
    supportedModes,
    supportedModels,
    fallbackMode: FALLBACK_MODE,
    fallbackModel: FALLBACK_MODEL,
  });
  // finally, because the flag also gates every composer change handler: leaking
  // it as true would silently stop the composer from persisting anything at all
  // until the page is reloaded.
  suppressConversationPreferenceSync = true;
  try {
    modeSelect.value = selection.mode;
    if (selection.model) modelSelect.value = selection.model;
    syncAutoModelAvailability();
    updateReasoningSelectorForModel(
      selection.model || modelSelect.value,
      String(preferredReasoningEffort || '').trim().toLowerCase(),
    );
    updateContextTierSelector(selection.model || modelSelect.value);
    const tierSelect = document.getElementById('context-tier-select');
    const desiredTier = String(preferredContextTier || 'default').trim().toLowerCase();
    if (tierSelect && Array.from(tierSelect.options).some((option) => option.value === desiredTier)) {
      tierSelect.value = desiredTier;
      updateModelPricingDetails(selection.model || modelSelect.value, tierSelect.value);
    }
  } finally {
    suppressConversationPreferenceSync = false;
  }
  // Nothing is written to the shared "last used" storage here. Applying a
  // conversation's stored preferences is not a choice: it runs on every open,
  // on the ~1s live poll, on a catalog refresh and on another client's edit,
  // so persisting the clamp let one conversation's resolution become the
  // default for the next New Chat. Only persistCurrentConversationPreferences
  // (a user edit) and a successful bootstrap write those keys.
}

function applyConversationPreferencesForConversation(conversationId, payload = {}) {
  const convId = String(conversationId || currentConvId || '').trim();
  const conversation = convId ? conversations[convId] : null;
  // Unset preferences arrive as '', so each source has to fall through rather
  // than stop at an empty string the way `??` did.
  const preferredRelayMode = firstDefinedPreference(
    payload?.preferredRelayMode,
    conversation?.preferredRelayMode,
    localStorage.getItem(MODE_STORAGE_KEY),
  ) || FALLBACK_MODE;
  const preferredModel = firstDefinedPreference(
    payload?.preferredModel,
    conversation?.preferredModel,
    localStorage.getItem(MODEL_STORAGE_KEY),
  );
  // No localStorage fallback here on purpose: updateReasoningSelectorForModel
  // already consults the shared "last used" effort, but below the conversation's
  // own value. Feeding it in as `preferredEffort` would promote it above the
  // selector's current state and let one conversation's clamp leak into the next.
  const preferredReasoningEffort = firstDefinedPreference(
    payload?.preferredReasoningEffort,
    conversation?.preferredReasoningEffort,
  );
  const runtimeModel = firstDefinedPreference(
    payload?.runtimeModel,
    conversation?.runtimeProviderModel,
    conversation?.runtime_provider_model,
    conversation?.runtimeModel,
    conversation?.runtime_model,
  );
  // The runtime binding only stands in for an unstarted conversation that has
  // no stored preference. Preferring it over one would let every catalog
  // refresh revert a model the user changed before sending anything.
  const effectivePreferredModel = normalizePreferenceValue(
    preferredModel
    || (Number(conversation?.messageCount || 0) === 0 ? runtimeModel : ''),
  );
  // A stored "[1m]" id decomposes into the base model plus the 1M context tier.
  const isLongContextModel = CLAUDE_LONG_CONTEXT_PATTERN.test(effectivePreferredModel);
  applyConversationPreferences({
    preferredRelayMode,
    preferredModel: effectivePreferredModel.replace(CLAUDE_LONG_CONTEXT_PATTERN, ''),
    preferredReasoningEffort,
    preferredContextTier: isLongContextModel ? 'long_context' : 'default',
  });
}

function initModelSelector() {
  const select = document.getElementById('model-select');
  if (!select) return;
  if (!select.dataset.bound) {
    select.dataset.bound = '1';
    select.addEventListener('change', () => {
      if (suppressConversationPreferenceSync) return;
      if (currentConversationHasMessages() && select.value.toLowerCase() === AUTO_MODEL_OPTION) {
        syncAutoModelAvailability();
        setModelBanner('⚠️ Auto model selection is available only for a new conversation.');
        return;
      }
      // Carry the current effort across the model change so switching models
      // does not quietly downgrade a deliberate "high" to the model's default.
      // The raw value, not selectedReasoningEffortValue(): its 'none' fallback
      // for an empty selector would overwrite a remembered effort.
      updateReasoningSelectorForModel(
        select.value,
        String(document.getElementById('reasoning-effort-select')?.value || '').trim().toLowerCase(),
        { persist: true },
      );
      updateContextTierSelector(select.value);
      syncSessionLockNote({ pinnedModel: currentRuntimeModelLock()?.model || '' });
      refreshComposerAttachmentWarning();
      void persistCurrentConversationPreferences().catch(() => {});
    });
    select.addEventListener('blur', () => {
      if (!deferredModelCatalogPayload) return;
      const payload = deferredModelCatalogPayload;
      deferredModelCatalogPayload = null;
      updateModelCatalogState(payload);
    });
  }

}

function initContextTierSelector() {
  const select = document.getElementById('context-tier-select');
  if (!select || select.dataset.bound === '1') return;
  select.dataset.bound = '1';
  select.addEventListener('change', () => {
    updateModelPricingDetails(selectedModelValue(), select.value);
    if (suppressConversationPreferenceSync) return;
    void persistCurrentConversationPreferences().catch(() => {});
  });
}

function initReasoningSelector() {
  const select = document.getElementById('reasoning-effort-select');
  if (!select || select.dataset.bound === '1') return;
  select.dataset.bound = '1';
  select.addEventListener('change', () => {
    if (suppressConversationPreferenceSync) return;
    void persistCurrentConversationPreferences().catch(() => {});
  });
}

function initModeSelector() {
  const select = document.getElementById('mode-select');
  if (!select) return;
  const saved = localStorage.getItem(MODE_STORAGE_KEY);
  const available = Array.from(select.options).map(o => o.value);
  if (saved && available.includes(saved)) {
    select.value = saved;
  } else if (!saved && available.includes(FALLBACK_MODE)) {
    select.value = FALLBACK_MODE;
  }
  if (select.dataset.bound === '1') return;
  select.dataset.bound = '1';
  select.addEventListener('change', () => {
    if (suppressConversationPreferenceSync) return;
    void persistCurrentConversationPreferences().catch(() => {});
  });
}

function refreshModelCatalog(force = false) {
  return loadModelCatalog().then((r) => {
    if (!r) {
      if (isModelMetadataHealthy(modelCatalogState) || isModelMetadataHealthy(lastHealthyModelCatalogState)) {
        setModelBanner('⚠️ Could not refresh model metadata; using last known good catalog.');
        syncModelMetadataBlocker();
        return null;
      }
      applyModelMetadataHardFail(force
        ? 'Could not refresh live model metadata.'
        : 'Could not load model metadata.');
      return null;
    }
    updateModelCatalogState(r);
    return r;
  });
}

function reportOpenAIModelDiscoveryFailure(payload) {
  const discovery = payload?.openAIModelDiscovery;
  if (discovery && discovery.ok === false) {
    showTransientRelayNotice(
      `GitHub models refreshed, but OpenAI model discovery failed. Cached OpenAI models were kept: ${discovery.error || 'unknown error'}`,
      8000,
    );
  }
  const claudeDiscovery = payload?.claudeModelDiscovery;
  if (claudeDiscovery && claudeDiscovery.ok === false && !claudeDiscovery.skipped) {
    showTransientRelayNotice(
      `Claude model discovery failed. Cached Claude models were kept: ${claudeDiscovery.error || 'unknown error'}`,
      8000,
    );
  }
  const cursorDiscovery = payload?.cursorModelDiscovery;
  if (cursorDiscovery && cursorDiscovery.ok === false && !cursorDiscovery.skipped) {
    showTransientRelayNotice(
      `Cursor model discovery failed. Cached Cursor models were kept: ${cursorDiscovery.error || 'unknown error'}`,
      8000,
    );
  }
  const grokDiscovery = payload?.grokModelDiscovery;
  if (grokDiscovery && grokDiscovery.ok === false && !grokDiscovery.skipped) {
    showTransientRelayNotice(
      `Grok model discovery failed. Cached Grok models were kept: ${grokDiscovery.error || 'unknown error'}`,
      8000,
    );
  }
}

async function retryModelMetadataRefresh() {
  if (modelMetadataRetryInFlight) return;
  modelMetadataRetryInFlight = true;
  syncModelMetadataBlocker('Refreshing model metadata…');
  try {
    let variantError = null;
    try {
      const refreshed = await refreshModelVariantCatalog();
      if (!refreshed) variantError = new Error('Model variant refresh returned empty');
      reportOpenAIModelDiscoveryFailure(refreshed);
    } catch (e) {
      variantError = e;
    }
    await refreshModelCatalog(true);
    if (variantError) console.warn('[retryModelMetadataRefresh] variant refresh issue:', variantError.message);
    if (modelCatalogState?.refreshedAt) console.log('[retryModelMetadataRefresh] refreshedAt:', modelCatalogState.refreshedAt);
    if (!isModelMetadataHealthy()) {
      throw new Error('Model metadata is still unavailable after refresh');
    }
    showTransientRelayNotice('Model metadata refreshed.');
  } catch (error) {
    applyModelMetadataHardFail(error?.message || 'Model metadata refresh failed.');
  } finally {
    modelMetadataRetryInFlight = false;
    syncModelMetadataBlocker();
  }
}

function applyModelVariantCatalogState(payload) {
  const rawVariants = Array.isArray(payload?.variants)
    ? payload.variants.map((entry) => ({
      variantId: String(entry?.variantId || '').trim(),
      baseModelId: String(entry?.baseModelId || '').trim(),
      provider: String(entry?.provider || 'other').trim().toLowerCase() || 'other',
      label: String(entry?.label || '').trim(),
      releaseStatus: String(entry?.releaseStatus || '').trim().toLowerCase() || null,
      reasoningEffort: String(entry?.reasoningEffort || '').trim().toLowerCase() || null,
      selectable: entry?.selectable !== false,
      enabled: !!entry?.enabled,
      sortOrder: Number.isFinite(Number(entry?.sortOrder)) ? Math.max(0, Math.trunc(Number(entry.sortOrder))) : 0,
    })).filter((entry) => entry.variantId && entry.baseModelId)
    : [];
  const canonicalizeId = (value) => String(value || '').trim().toLowerCase();
  const dedupedVariantsMap = new Map();
  for (const entry of rawVariants) {
    const dedupeKey = canonicalizeId(entry.variantId);
    const existing = dedupedVariantsMap.get(dedupeKey);
    if (!existing) {
      dedupedVariantsMap.set(dedupeKey, {
        ...entry,
        variantId: dedupeKey,
        baseModelId: canonicalizeId(entry.baseModelId),
      });
      continue;
    }
    dedupedVariantsMap.set(dedupeKey, {
      ...existing,
      enabled: existing.enabled || entry.enabled,
      releaseStatus: (existing.releaseStatus === null || entry.releaseStatus === null)
        ? null
        : (existing.releaseStatus || entry.releaseStatus),
      sortOrder: Math.min(existing.sortOrder, entry.sortOrder),
      label: existing.label || entry.label,
      provider: existing.provider || entry.provider,
    });
  }
  const variants = Array.from(dedupedVariantsMap.values());
  const requestedEnabledVariantIds = Array.isArray(payload?.enabledVariantIds)
    ? payload.enabledVariantIds.map((value) => canonicalizeId(value)).filter(Boolean)
    : variants.filter((entry) => entry.enabled).map((entry) => entry.variantId);
  const enabledVariantIds = new Set(requestedEnabledVariantIds.filter((value) => dedupedVariantsMap.has(value)));
  modelVariantCatalogState = {
    variants,
    enabledVariantIds: Array.from(enabledVariantIds),
    reasoningByModel: payload?.reasoningByModel && typeof payload.reasoningByModel === 'object'
      ? Object.fromEntries(Object.entries(payload.reasoningByModel).map(([modelId, efforts]) => [
        String(modelId || '').trim().toLowerCase(),
        normalizeReasoningEffortList(efforts),
      ]))
      : {},
    source: String(payload?.source || '').trim() || null,
    refreshedAt: payload?.refreshedAt || null,
    warning: payload?.warning ? String(payload.warning) : null,
    error: payload?.error ? String(payload.error) : null,
    reasoningEfforts: Array.isArray(payload?.reasoningEfforts)
      ? payload.reasoningEfforts.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [],
    claudeModels: payload?.claudeModels && typeof payload.claudeModels === 'object'
      ? {
        defaultModel: String(payload.claudeModels.defaultModel || '').trim(),
        availableModels: Array.isArray(payload.claudeModels.availableModels)
          ? payload.claudeModels.availableModels.map((value) => String(value || '').trim()).filter(Boolean)
          : [],
        enabledModels: Array.isArray(payload.claudeModels.enabledModels)
          ? payload.claudeModels.enabledModels.map((value) => String(value || '').trim()).filter(Boolean)
          : [],
      }
      : null,
    cursorModels: payload?.cursorModels && typeof payload.cursorModels === 'object'
      ? {
        defaultModel: String(payload.cursorModels.defaultModel || '').trim(),
        availableModels: Array.isArray(payload.cursorModels.availableModels)
          ? payload.cursorModels.availableModels.map((value) => String(value || '').trim()).filter(Boolean)
          : [],
        enabledModels: Array.isArray(payload.cursorModels.enabledModels)
          ? payload.cursorModels.enabledModels.map((value) => String(value || '').trim()).filter(Boolean)
          : [],
      }
      : null,
    grokModels: payload?.grokModels && typeof payload.grokModels === 'object'
      ? {
        defaultModel: String(payload.grokModels.defaultModel || '').trim(),
        availableModels: Array.isArray(payload.grokModels.availableModels)
          ? payload.grokModels.availableModels.map((value) => String(value || '').trim()).filter(Boolean)
          : [],
        enabledModels: Array.isArray(payload.grokModels.enabledModels)
          ? payload.grokModels.enabledModels.map((value) => String(value || '').trim()).filter(Boolean)
          : [],
      }
      : null,
  };
}

function buildReasoningEffortsByBaseModel(variants = [], reasoningByModel = {}) {
  const map = new Map();
  for (const entry of variants) {
    const baseModelId = String(entry.baseModelId || '').trim().toLowerCase();
    if (!baseModelId) continue;
    if (!map.has(baseModelId)) {
      map.set(baseModelId, {
        label: entry.label,
        efforts: new Set(),
      });
    }
    const effort = String(entry.reasoningEffort || '').trim().toLowerCase();
    if (effort) map.get(baseModelId).efforts.add(effort);
  }
  for (const [baseModelId, efforts] of Object.entries(reasoningByModel || {})) {
    const key = String(baseModelId || '').trim().toLowerCase();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { label: humanizeModelLabel(key), efforts: new Set() });
    }
    for (const effort of Array.isArray(efforts) ? efforts : []) {
      const normalized = String(effort || '').trim().toLowerCase();
      if (normalized) map.get(key).efforts.add(normalized);
    }
  }
  return map;
}

function renderReasoningEffortChipRow(efforts = []) {
  const list = Array.from(efforts).sort();
  if (!list.length) {
    return '<span class="model-reasoning-chip model-reasoning-chip-muted">standard</span>';
  }
  return list.map((effort) => `<span class="model-reasoning-chip">${escHtml(effort)}</span>`).join('');
}

async function reconcileOpenModelVariantModal() {
  const modal = document.getElementById('summary-modal');
  if (!modal?.classList.contains('visible')) return;
  if (summaryModalState.kind !== 'select-models') return;
  const payload = await loadModelVariantCatalog();
  if (!payload) return;
  applyModelVariantCatalogState(payload);
  renderModelVariantCatalogBody();
}

function renderModelVariantCatalogBody() {
  const providersByModel = modelCatalogState.providersByModel || {};
  const variantBelongsToTab = (entry, tab) => {
    const activeTab = String(tab || 'copilot').trim().toLowerCase();
    const baseModelId = String(entry?.baseModelId || '').trim().toLowerCase();
    const entryProvider = String(entry?.provider || '').trim().toLowerCase();
    const providers = modelProvidersForId(baseModelId, providersByModel);
    const hasOpenAIByok = providers.includes('openai-byok');
    // Each tab lists only rows sourced from that runtime: the Claude SDK tab
    // shows Claude-SDK rows exclusively, the Cursor SDK tab Cursor rows, the
    // Grok tab Grok rows, and Copilot never shows rows that a different runtime
    // contributed (there is no cross-runtime switching).
    if (activeTab === 'anthropic') {
      return entryProvider === 'claude';
    }
    if (entryProvider === 'claude') return false;
    if (activeTab === 'cursor') {
      return entryProvider === 'cursor';
    }
    if (entryProvider === 'cursor') return false;
    if (activeTab === 'grok') {
      return entryProvider === 'grok';
    }
    if (entryProvider === 'grok') return false;
    if (activeTab === 'openai') {
      return hasOpenAIByok || entryProvider === 'openai-byok';
    }
    // Copilot tab: only models the Copilot CLI itself serves.
    if (entryProvider === 'openai-byok') return false;
    if (hasOpenAIByok) {
      return providers.some((provider) => (
        provider !== 'openai-byok'
        && provider !== 'claude'
        && provider !== 'cursor'
        && provider !== 'grok'
      ));
    }
    return true;
  };
  const grouped = new Map();
  for (const entry of modelVariantCatalogState.variants) {
    const providerKey = String(entry.provider || 'other').trim().toLowerCase() || 'other';
    if (!grouped.has(providerKey)) grouped.set(providerKey, []);
    grouped.get(providerKey).push(entry);
  }
  const openAIBaseModelsAlreadyListed = new Set(
    modelVariantCatalogState.variants
      .filter((entry) => variantBelongsToTab(entry, 'openai'))
      .map((entry) => String(entry.baseModelId || '').trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [modelId, providers] of Object.entries(modelCatalogState.providersByModel || {})) {
    const baseModelId = String(modelId || '').trim().toLowerCase();
    if (!baseModelId) continue;
    const providerList = Array.isArray(providers) ? providers : [];
    if (!providerList.includes('openai-byok')) continue;
    if (openAIBaseModelsAlreadyListed.has(baseModelId)) continue;
    const providerRows = grouped.get('openai-byok') || [];
    providerRows.push({
      variantId: `${baseModelId}--provider-openai-byok`,
      baseModelId,
      provider: 'openai-byok',
      label: humanizeModelLabel(baseModelId),
      releaseStatus: null,
      reasoningEffort: null,
      selectable: false,
      enabled: false,
      sortOrder: Number.MAX_SAFE_INTEGER,
    });
    grouped.set('openai-byok', providerRows);
    openAIBaseModelsAlreadyListed.add(baseModelId);
  }
  const claudeCatalog = modelVariantCatalogState.claudeModels;
  if (claudeCatalog?.availableModels?.length) {
    const claudeEnabledSet = new Set(claudeCatalog.enabledModels || []);
    const claudeDefaultModel = String(claudeCatalog.defaultModel || '').trim();
    const providerRows = [];
    for (const [index, claudeModelId] of claudeCatalog.availableModels.entries()) {
      const isDefaultModel = claudeModelId === claudeDefaultModel;
      providerRows.push({
        variantId: `${claudeModelId}--provider-claude`,
        baseModelId: claudeModelId,
        provider: 'claude',
        label: humanizeModelLabel(claudeModelId),
        releaseStatus: null,
        reasoningEffort: null,
        // The default model always stays enabled; deselecting it would leave
        // Claude conversations without a model.
        selectable: !isDefaultModel,
        enabled: claudeEnabledSet.has(claudeModelId) || isDefaultModel,
        claudeModelId,
        sortOrder: index,
      });
    }
    grouped.set('claude', providerRows);
  }
  const cursorCatalog = modelVariantCatalogState.cursorModels;
  if (cursorCatalog?.availableModels?.length) {
    const cursorEnabledSet = new Set(cursorCatalog.enabledModels || []);
    const cursorDefaultModel = String(cursorCatalog.defaultModel || '').trim();
    const providerRows = [];
    for (const [index, cursorModelId] of cursorCatalog.availableModels.entries()) {
      const isDefaultModel = cursorModelId === cursorDefaultModel;
      providerRows.push({
        variantId: `${cursorModelId}--provider-cursor`,
        baseModelId: cursorModelId,
        provider: 'cursor',
        label: humanizeModelLabel(cursorModelId),
        releaseStatus: null,
        reasoningEffort: null,
        // The default model always stays enabled; deselecting it would leave
        // Cursor conversations without a model.
        selectable: !isDefaultModel,
        enabled: cursorEnabledSet.has(cursorModelId) || isDefaultModel,
        cursorModelId,
        sortOrder: index,
      });
    }
    grouped.set('cursor', providerRows);
  }
  const grokCatalog = modelVariantCatalogState.grokModels;
  if (grokCatalog?.availableModels?.length) {
    const grokEnabledSet = new Set(grokCatalog.enabledModels || []);
    const grokDefaultModel = String(grokCatalog.defaultModel || '').trim();
    const providerRows = [];
    for (const [index, grokModelId] of grokCatalog.availableModels.entries()) {
      const isDefaultModel = grokModelId === grokDefaultModel;
      providerRows.push({
        variantId: `${grokModelId}--provider-grok`,
        baseModelId: grokModelId,
        provider: 'grok',
        label: humanizeModelLabel(grokModelId),
        releaseStatus: null,
        reasoningEffort: null,
        // The default model always stays enabled; deselecting it would leave
        // Grok conversations without a model.
        selectable: !isDefaultModel,
        enabled: grokEnabledSet.has(grokModelId) || isDefaultModel,
        grokModelId,
        sortOrder: index,
      });
    }
    grouped.set('grok', providerRows);
  }
  const selected = new Set(modelVariantCatalogState.enabledVariantIds);
  const selectedOrder = new Map(
    modelVariantCatalogState.enabledVariantIds.map((variantId, index) => [variantId, index]),
  );
  const providerSortMeta = (providerKey) => {
    const rows = grouped.get(providerKey) || [];
    const selectedPositions = rows
      .filter((row) => selected.has(row.variantId))
      .map((row) => selectedOrder.get(row.variantId))
      .filter((value) => Number.isFinite(value));
    const hasSelected = selectedPositions.length > 0;
    const firstSelectedPos = hasSelected ? Math.min(...selectedPositions) : Number.POSITIVE_INFINITY;
    return { hasSelected, firstSelectedPos };
  };
  const providerOrder = Array.from(grouped.keys()).sort((a, b) => {
    const aMeta = providerSortMeta(a);
    const bMeta = providerSortMeta(b);
    if (aMeta.hasSelected !== bMeta.hasSelected) return aMeta.hasSelected ? -1 : 1;
    if (aMeta.firstSelectedPos !== bMeta.firstSelectedPos) return aMeta.firstSelectedPos - bMeta.firstSelectedPos;
    const aLabel = PROVIDER_LABELS[a] || a;
    const bLabel = PROVIDER_LABELS[b] || b;
    return aLabel.localeCompare(bLabel);
  });
  const refreshedLabel = modelVariantCatalogState.refreshedAt
    ? new Date(modelVariantCatalogState.refreshedAt).toLocaleString()
    : 'Never';
  const providerBelongsToTab = (providerKey, tab) => (
    (grouped.get(String(providerKey || '').trim().toLowerCase()) || [])
      .some((entry) => variantBelongsToTab(entry, tab))
  );
  const hasOpenAITab = providerOrder.some((providerKey) => providerBelongsToTab(providerKey, 'openai'));
  const hasCopilotTab = providerOrder.some((providerKey) => providerBelongsToTab(providerKey, 'copilot'));
  const hasAnthropicTab = providerOrder.some((providerKey) => providerBelongsToTab(providerKey, 'anthropic'));
  const hasCursorTab = providerOrder.some((providerKey) => providerBelongsToTab(providerKey, 'cursor'));
  const hasGrokTab = providerOrder.some((providerKey) => providerBelongsToTab(providerKey, 'grok'));
  if (modelVariantCatalogProviderTab === 'openai' && !hasOpenAITab) modelVariantCatalogProviderTab = 'copilot';
  if (modelVariantCatalogProviderTab === 'anthropic' && !hasAnthropicTab) modelVariantCatalogProviderTab = 'copilot';
  if (modelVariantCatalogProviderTab === 'cursor' && !hasCursorTab) modelVariantCatalogProviderTab = 'copilot';
  if (modelVariantCatalogProviderTab === 'grok' && !hasGrokTab) modelVariantCatalogProviderTab = 'copilot';
  if (modelVariantCatalogProviderTab === 'copilot' && !hasCopilotTab) {
    if (hasOpenAITab) modelVariantCatalogProviderTab = 'openai';
    else if (hasAnthropicTab) modelVariantCatalogProviderTab = 'anthropic';
    else if (hasCursorTab) modelVariantCatalogProviderTab = 'cursor';
    else if (hasGrokTab) modelVariantCatalogProviderTab = 'grok';
  }
  const visibleProviderOrder = providerOrder.filter((providerKey) => providerBelongsToTab(providerKey, modelVariantCatalogProviderTab));
  const providerTabButtons = `
    <div class="summary-tab-strip" style="display:flex;gap:8px;align-items:center;">
      <button type="button" class="summary-btn model-provider-tab${modelVariantCatalogProviderTab === 'copilot' ? ' active' : ''}" data-model-provider-tab="copilot">Copilot</button>
      <button type="button" class="summary-btn model-provider-tab${modelVariantCatalogProviderTab === 'openai' ? ' active' : ''}" data-model-provider-tab="openai" ${hasOpenAITab ? '' : 'disabled'}>OpenAI</button>
      <button type="button" class="summary-btn model-provider-tab${modelVariantCatalogProviderTab === 'anthropic' ? ' active' : ''}" data-model-provider-tab="anthropic" ${hasAnthropicTab ? '' : 'disabled'}>Claude SDK</button>
      <button type="button" class="summary-btn model-provider-tab${modelVariantCatalogProviderTab === 'cursor' ? ' active' : ''}" data-model-provider-tab="cursor" ${hasCursorTab ? '' : 'disabled'}>Cursor SDK</button>
      <button type="button" class="summary-btn model-provider-tab${modelVariantCatalogProviderTab === 'grok' ? ' active' : ''}" data-model-provider-tab="grok" ${hasGrokTab ? '' : 'disabled'}>Grok</button>
    </div>
  `;
  const warnings = [
    modelVariantCatalogState.warning ? `⚠️ ${escHtml(modelVariantCatalogState.warning)}` : '',
    modelVariantCatalogState.error ? `⚠️ ${escHtml(modelVariantCatalogState.error)}` : '',
  ].filter(Boolean);
  const reasoningByBaseModel = buildReasoningEffortsByBaseModel(
    modelVariantCatalogState.variants,
    modelVariantCatalogState.reasoningByModel,
  );
  const groupsHtml = visibleProviderOrder.map((providerKey) => {
    const providerLabel = PROVIDER_LABELS[providerKey] || providerKey;
    const rows = (grouped.get(providerKey) || [])
      .filter((entry) => variantBelongsToTab(entry, modelVariantCatalogProviderTab));
    rows.sort((a, b) => {
      const aSelected = selected.has(a.variantId);
      const bSelected = selected.has(b.variantId);
      if (aSelected !== bSelected) return aSelected ? -1 : 1;

      const aSelectedPos = selectedOrder.has(a.variantId)
        ? selectedOrder.get(a.variantId)
        : Number.POSITIVE_INFINITY;
      const bSelectedPos = selectedOrder.has(b.variantId)
        ? selectedOrder.get(b.variantId)
        : Number.POSITIVE_INFINITY;
      if (aSelectedPos !== bSelectedPos) return aSelectedPos - bSelectedPos;

      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.variantId.localeCompare(b.variantId);
    });
    const byBaseModel = new Map();
    for (const row of rows) {
      const baseModelId = String(row.baseModelId || '').trim().toLowerCase();
      if (!byBaseModel.has(baseModelId)) byBaseModel.set(baseModelId, []);
      byBaseModel.get(baseModelId).push(row);
    }
    const baseModelBlocks = Array.from(byBaseModel.entries()).map(([baseModelId, variantRows]) => {
      const providerEfforts = reasoningOptionsForProviderModel(providerKey, baseModelId);
      const fallbackMeta = reasoningByBaseModel.get(baseModelId) || { label: humanizeModelLabel(baseModelId), efforts: new Set() };
      const meta = providerEfforts.length
        ? { ...fallbackMeta, efforts: new Set(providerEfforts) }
        : fallbackMeta;
      const label = meta.label || humanizeModelLabel(baseModelId) || baseModelId;
      const variantRowsHtml = variantRows.map((row) => {
        const selectable = row.selectable !== false;
        // SDK-provider rows (Claude/Cursor/Grok) carry their own enabled flag; only
        // Copilot variant rows read the enabledVariantIds selection.
        const sdkProviderModelId = row.claudeModelId || row.cursorModelId || row.grokModelId || '';
        const checked = sdkProviderModelId
          ? row.enabled === true
          : (selectable && selected.has(row.variantId));
        const effortChip = row.reasoningEffort
          ? ` <span class="model-reasoning-chip">${escHtml(row.reasoningEffort)}</span>`
          : '';
        const unavailable = row.releaseStatus === 'unavailable';
        const statusChip = unavailable
          ? ' <span class="model-reasoning-chip model-reasoning-chip-warn">unavailable</span>'
          : '';
        const fixedChip = !selectable
          ? (sdkProviderModelId
            ? ' <span class="model-reasoning-chip">default model</span>'
            : ' <span class="model-reasoning-chip">managed in settings</span>')
          : '';
        const sdkModelAttr = row.claudeModelId
          ? ` data-claude-model="${escHtml(row.claudeModelId)}"`
          : (row.cursorModelId
            ? ` data-cursor-model="${escHtml(row.cursorModelId)}"`
            : (row.grokModelId ? ` data-grok-model="${escHtml(row.grokModelId)}"` : ''));
        return `
          <label class="model-variant-row">
            <input class="model-variant-checkbox" type="checkbox" data-selectable="${selectable ? '1' : '0'}" data-variant-id="${escHtml(row.variantId)}"${sdkModelAttr} ${checked ? 'checked' : ''} ${selectable ? '' : 'disabled'}>
            <span class="model-variant-row-copy">
              <span class="model-variant-row-title">${escHtml(row.variantId)}${effortChip}${statusChip}${fixedChip}</span>
            </span>
          </label>
        `;
      }).join('');
      return `
        <div class="model-base-group">
          <div class="model-base-header">
            <div class="model-base-title">${escHtml(label)}</div>
            <div class="model-base-reasoning">
              <span class="model-base-reasoning-label">Reasoning</span>
              ${renderReasoningEffortChipRow(meta.efforts)}
            </div>
            <code class="model-base-id">${escHtml(baseModelId)}</code>
          </div>
          <div class="model-variant-list">${variantRowsHtml}</div>
        </div>
      `;
    }).join('');
    return `
      <section class="model-provider-group">
        <div class="model-provider-title">${escHtml(providerLabel)}</div>
        ${baseModelBlocks || '<div class="model-provider-empty">No models</div>'}
      </section>
    `;
  }).join('');
  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:10px">
      ${providerTabButtons}
      <div style="font-size:0.8rem;color:var(--muted)">
        Saved globally for this relay. Refreshed: <strong>${escHtml(refreshedLabel)}</strong>
      </div>
      <div style="font-size:0.78rem;color:var(--muted)">
        Variants marked unavailable are preserved from earlier selections so updates do not reset your models.
      </div>
      <div style="font-size:0.78rem;color:var(--muted)">
        Each model shows all supported reasoning efforts above its selectable variants.
      </div>
      ${warnings.map((line) => `<div style="font-size:0.78rem;color:var(--warn,#f7c873)">${line}</div>`).join('')}
      <div style="display:grid;gap:10px">${groupsHtml || '<div style="color:var(--muted)">No models discovered yet. Click Refresh.</div>'}</div>
    </div>
  `;
  renderSummaryModalContent({
    title: '🤗 Select Models',
    subtitle: 'Choose model variants shown in the composer selector',
    bodyHtml,
    refresh: async () => {
      const refreshed = await refreshModelVariantCatalog();
      if (!refreshed) throw new Error('Failed to refresh model variants');
      reportOpenAIModelDiscoveryFailure(refreshed);
      applyModelVariantCatalogState(refreshed);
      renderModelVariantCatalogBody();
      await refreshModelCatalog(true);
    },
    kind: 'select-models',
  });
  const headerActions = document.querySelector('#summary-modal .summary-header-actions');
  const refreshBtn = document.getElementById('summary-modal-refresh');
  if (headerActions && refreshBtn && !document.getElementById('summary-modal-save-models')) {
    const saveBtn = document.createElement('button');
    saveBtn.id = 'summary-modal-save-models';
    saveBtn.className = 'summary-btn';
    saveBtn.type = 'button';
    saveBtn.textContent = '💾 Save enabled models';
    saveBtn.onclick = () => saveSelectedModelsFromModal();
    headerActions.insertBefore(saveBtn, refreshBtn);
  }
  for (const button of Array.from(document.querySelectorAll('[data-model-provider-tab]'))) {
    button.onclick = () => {
      const nextTab = String(button.dataset.modelProviderTab || '').trim().toLowerCase();
      if (!nextTab || nextTab === modelVariantCatalogProviderTab) return;
      modelVariantCatalogProviderTab = nextTab;
      renderModelVariantCatalogBody();
    };
  }
}

async function openSelectModelsModal() {
  modelVariantCatalogProviderTab = 'copilot';
  openSummaryModal({
    title: '🤗 Select Models',
    subtitle: 'Loading…',
    bodyHtml: '<div class="summary-loading">Loading saved model variants…</div>',
    kind: 'select-models',
  });
  setSummaryModalLoading(true);
  try {
    const payload = await loadModelVariantCatalog();
    if (!payload) throw new Error('Failed to load model variants');
    applyModelVariantCatalogState(payload);
    renderModelVariantCatalogBody();
  } catch (error) {
    renderSummaryModalContent({
      title: '🤗 Select Models',
      subtitle: 'Unable to load',
      bodyHtml: `<div class="summary-error">Failed to load model variants: ${escHtml(error?.message || 'Unknown error')}</div>`,
      kind: 'select-models',
    });
  } finally {
    setSummaryModalLoading(false);
  }
}

async function saveSelectedModelsFromModal() {
  const body = document.getElementById('summary-modal-body');
  if (!body) return;
  const claudeCheckboxes = Array.from(body.querySelectorAll('.model-variant-checkbox[data-claude-model]'));
  const selectedClaudeModels = claudeCheckboxes
    .filter((input) => input.checked)
    .map((input) => String(input.getAttribute('data-claude-model') || '').trim())
    .filter(Boolean);
  const cursorCheckboxes = Array.from(body.querySelectorAll('.model-variant-checkbox[data-cursor-model]'));
  const selectedCursorModels = cursorCheckboxes
    .filter((input) => input.checked)
    .map((input) => String(input.getAttribute('data-cursor-model') || '').trim())
    .filter(Boolean);
  const grokCheckboxes = Array.from(body.querySelectorAll('.model-variant-checkbox[data-grok-model]'));
  const selectedGrokModels = grokCheckboxes
    .filter((input) => input.checked)
    .map((input) => String(input.getAttribute('data-grok-model') || '').trim())
    .filter(Boolean);
  // Only the active provider tab's rows are in the DOM, but the PATCH
  // replaces the WHOLE enabled set — so the save must only change rows the
  // user could actually see. Off-screen variants keep their stored state,
  // otherwise saving from e.g. the OpenAI tab silently disables every
  // Copilot-only vendor group (Anthropic, Google, …).
  const renderedVariantCheckboxes = Array.from(body.querySelectorAll('.model-variant-checkbox[data-selectable="1"]:not([data-claude-model]):not([data-cursor-model]):not([data-grok-model])'));
  const renderedVariantIds = new Set(renderedVariantCheckboxes
    .map((input) => String(input.getAttribute('data-variant-id') || '').trim())
    .filter(Boolean));
  const checkedVariantIds = renderedVariantCheckboxes
    .filter((input) => input.checked)
    .map((input) => String(input.getAttribute('data-variant-id') || '').trim())
    .filter(Boolean);
  const checkedVariantSet = new Set(checkedVariantIds);
  const selectedVariantIds = (modelVariantCatalogState.enabledVariantIds || [])
    .filter((variantId) => !renderedVariantIds.has(variantId) || checkedVariantSet.has(variantId));
  for (const variantId of checkedVariantIds) {
    if (!selectedVariantIds.includes(variantId)) selectedVariantIds.push(variantId);
  }
  const hasVariantRows = renderedVariantCheckboxes.length > 0;
  if (hasVariantRows && !selectedVariantIds.length) {
    alert('Select at least one model variant.');
    return;
  }
  setSummaryModalLoading(true);
  try {
    if (hasVariantRows) {
      const saved = await saveEnabledModelVariants(selectedVariantIds);
      if (!saved) throw new Error('Failed to save model selection');
      applyModelVariantCatalogState(saved);
    }
    if (claudeCheckboxes.length) {
      const savedClaude = await updateClaudeSettings({ enabledModels: selectedClaudeModels });
      if (!savedClaude) throw new Error('Failed to save Claude model selection');
      applyClaudeSettingsState(savedClaude);
    }
    if (cursorCheckboxes.length) {
      const savedCursor = await updateCursorSettings({ enabledModels: selectedCursorModels });
      if (!savedCursor) throw new Error('Failed to save Cursor model selection');
      applyCursorSettingsState(savedCursor);
    }
    if (grokCheckboxes.length) {
      const savedGrok = await updateGrokSettings({ enabledModels: selectedGrokModels });
      if (!savedGrok) throw new Error('Failed to save Grok model selection');
      applyGrokSettingsState(savedGrok);
    }
    if (claudeCheckboxes.length || cursorCheckboxes.length || grokCheckboxes.length) {
      const refreshedCatalog = await loadModelVariantCatalog();
      if (refreshedCatalog) applyModelVariantCatalogState(refreshedCatalog);
    }
    renderModelVariantCatalogBody();
    await refreshModelCatalog(true);
    showTransientRelayNotice('Saved model selection.');
  } catch (error) {
    alert(error?.message || 'Failed to save model selection');
  } finally {
    setSummaryModalLoading(false);
  }
}

async function loadUsageSummaryAndRender() {
  const d = await loadUsageSummary();
  if (!d) throw new Error('Unable to load usage data');
  const planHtml = renderPlanUsageHtml(d);
  if (planHtml) {
    renderSummaryModalContent({
      title: 'Plan usage',
      subtitle: planUsageSubtitle(d),
      bodyHtml: planHtml,
      refresh: loadUsageSummaryAndRender,
      kind: 'usage',
    });
    return;
  }
  // Legacy relay (or a relay without the plan-usage service): fall back to the
  // Copilot-only text summary rather than showing an empty modal.
  const pct = d.premiumInteractions?.percentRemaining != null
    ? ` (${d.premiumInteractions.percentRemaining.toFixed(1)}% left)`
    : '';
  const msg = `Chat/Completions: ${d.chat?.unlimited ? 'Unlimited ✅' : `${d.chat?.remaining} remaining`}\n` +
    `Premium interactions: ${d.premiumInteractions?.remaining} / ${d.premiumInteractions?.entitlement} remaining${pct}`;
  renderSummaryModalContent({
    title: 'Copilot Usage',
    subtitle: `Resets ${d.resetDate || 'unknown'}`,
    bodyHtml: `<pre>${escHtml(msg)}</pre>`,
    refresh: loadUsageSummaryAndRender,
    kind: 'usage',
  });
}

async function loadContextSummaryAndRender(convId) {
  const trimmedConvId = String(convId || '').trim();
  const payload = await loadContextSummary(trimmedConvId);
  if (!payload) throw new Error('Unable to load context');
  const sessionId = String(payload.copilotSessionId || payload.snapshot?.copilot_session_id || '').trim();
  const refreshLookupId = sessionId || trimmedConvId || null;
  const providerLabel = payload.providerType === 'claude'
    ? 'Claude'
    : (payload.providerType === 'cursor'
      ? 'Cursor'
      : (payload.providerType === 'grok' ? 'Grok' : 'Copilot'));
  const subtitle = sessionId
    ? `${providerLabel} session ${sessionId.slice(0, 8)}`
    : (trimmedConvId ? `Conversation ${trimmedConvId.slice(0, 8)}` : 'No conversation selected');

  const usageHtml = renderContextUsageHtml(payload.contextUsage);
  const detailText = String(payload.text || '').trim();
  // The structured breakdown is the answer; the runtime's own text dump stays
  // available underneath for the details it carries that categories don't.
  const bodyHtml = usageHtml
    ? `${usageHtml}${detailText
      ? `<details class="ctx-usage-raw"><summary>Raw details</summary><pre>${escHtml(detailText)}</pre></details>`
      : ''}`
    : `<pre>${escHtml(detailText || 'No context data available.')}</pre>`;

  renderSummaryModalContent({
    title: 'Context usage',
    subtitle,
    bodyHtml,
    refresh: () => loadContextSummaryAndRender(refreshLookupId),
    kind: 'context',
  });
}

async function showUsage() {
  const btn = document.getElementById('chat-menu-usage') || document.getElementById('usage-btn');
  if (btn) {
    btn.textContent = '⏳';
    btn.disabled = true;
  }
  openSummaryModal({
    title: 'Plan usage',
    subtitle: 'Loading…',
    bodyHtml: '<div class="summary-loading">Fetching plan usage across providers…</div>',
    refresh: loadUsageSummaryAndRender,
    kind: 'usage',
  });
  setSummaryModalLoading(true);
  try {
    await loadUsageSummaryAndRender();
  } catch (e) {
    renderSummaryModalContent({
      title: 'Plan usage',
      subtitle: 'Unable to load',
      bodyHtml: `<div class="summary-error">Failed to fetch usage: ${escHtml(e.message || 'Unknown error')}</div>`,
      refresh: loadUsageSummaryAndRender,
      kind: 'usage',
    });
  } finally {
    if (btn) {
      btn.textContent = btn.id === 'chat-menu-usage' ? '📊 Check Usage' : '📊';
      btn.disabled = false;
    }
  }
}

async function showContext() {
  const btn = document.getElementById('context-btn');
  const convId = String(currentConvId || '').trim();
  if (!convId) {
    // /api/context has no data without a conversation, so say so rather than
    // opening a modal that can only ever render an error.
    openSummaryModal({
      title: 'Context usage',
      subtitle: 'No conversation selected',
      bodyHtml: '<div class="summary-loading">Open a conversation to see its context usage.</div>',
      kind: 'context',
    });
    return;
  }
  if (btn) {
    btn.textContent = '⏳';
    btn.disabled = true;
  }
  openSummaryModal({
    title: 'Context usage',
    subtitle: `Conversation ${convId.slice(0, 8)}`,
    bodyHtml: '<div class="summary-loading">Fetching context snapshot…</div>',
    refresh: () => loadContextSummaryAndRender(convId),
    kind: 'context',
  });
  setSummaryModalLoading(true);
  try {
    await loadContextSummaryAndRender(convId);
  } catch (e) {
    renderSummaryModalContent({
      title: 'Context usage',
      subtitle: 'Unable to load',
      bodyHtml: `<div class="summary-error">Failed to fetch context: ${escHtml(e.message || 'Unknown error')}</div>`,
      refresh: () => loadContextSummaryAndRender(convId || null),
      kind: 'context',
    });
  } finally {
    if (btn) {
      btn.textContent = '🧠';
      btn.disabled = false;
    }
  }
}

function renderSessionInstructionDocs(docs) {
  const items = Array.isArray(docs) ? docs : [];
  if (!items.length) {
    return '<div class="summary-loading">No session instruction files were found.</div>';
  }

  return `<div style="display:flex;flex-direction:column;gap:12px">${
    items.map((doc) => {
      const title = String(doc?.title || doc?.sessionId || 'Session instructions').trim();
      const name = String(doc?.name || '').trim();
      const gender = String(doc?.gender || '').trim();
      const summary = [name, gender].filter(Boolean).join(' · ');
      const sessionId = String(doc?.sessionId || '').trim();
      const updatedAt = String(doc?.updatedAt || '').trim();
      const content = escHtml(String(doc?.content || '').trim());
      return `
        <details open style="border:1px solid var(--border);border-radius:10px;background:var(--bg3);padding:10px 12px">
          <summary style="cursor:pointer;font-weight:600;outline:none">${escHtml(title)}</summary>
          <div style="margin-top:6px;font-size:0.78rem;color:var(--muted)">
            ${escHtml(summary || sessionId)}
            ${updatedAt ? ` · ${escHtml(updatedAt)}` : ''}
          </div>
          <pre style="margin-top:10px;white-space:pre-wrap;word-break:break-word">${content}</pre>
        </details>
      `;
    }).join('')
  }</div>`;
}


function startRelayQuestionPolling() {
  if (relayQuestionPollTimer) return;
  relayQuestionPollTimer = setInterval(() => {
    if (!shouldRunForegroundNetworkWork()) return;
    loadRelayQuestions(currentConvId).catch(() => {});
  }, 3000);
}

function startRelayBoardPolling() {
  if (relayBoardPollTimer) return;
  relayBoardPollTimer = setInterval(() => {
    if (!shouldRunForegroundNetworkWork()) return;
    loadRelayBoards().catch(() => {});
  }, 3000);
}

async function refreshSessionWorkerStatus() {
  const currentId = String(currentConvId || '').trim();
  const currentConversation = currentId ? conversations[currentId] : null;
  const currentSdkSessionId = String(currentConversation?.sdkSessionId || currentConversation?.sdk_session_id || '').trim();
  const previousWorkerState = currentSdkSessionId ? getSessionWorkerState(currentSdkSessionId) : null;
  const previousWorkerStatus = String(previousWorkerState?.status || '').trim().toLowerCase();
  const status = await refreshWorkspaceRootHints();
  if (!status) return;
  syncQueueStatusMenuEntry(status);
  if (setSessionWorkerStatesFromStatusPayload(status.sessionWorker)) {
    renderConvList();
  }
  updateCliStatus();
  const nextWorkerState = currentSdkSessionId ? getSessionWorkerState(currentSdkSessionId) : null;
  const transitionedToOffline = (
    ['starting', 'ready', 'processing'].includes(previousWorkerStatus)
    && !nextWorkerState
  );
  const hasSessionUsageSummary = !!(
    currentConversation?.sessionUsageSummary
    || currentConversation?.session_usage_summary
  );
  if (transitionedToOffline && currentId && !hasSessionUsageSummary) {
    refreshCurrentView().catch(() => {});
  }
}

function startSessionWorkerStatusPolling() {
  if (sessionWorkerStatusPollTimer) return;
  sessionWorkerStatusPollTimer = setInterval(() => {
    if (!shouldRunForegroundNetworkWork()) return;
    refreshSessionWorkerStatus().catch(() => {});
  }, 4000);
}

async function pollAuthenticatedCurrentConversationLive() {
  if (liveConversationPollInFlight) return;
  if (isSharedReaderMode()) return;
  const currentId = String(currentConvId || '').trim();
  if (!currentId) return;
  const currentConversation = conversations[currentId] || null;
  const isProcessing = String(currentConversation?.localTurnStatus || '').trim().toLowerCase() === 'processing'
    || !!document.getElementById('thinking-indicator');
  if (!isProcessing) return;
  // Refreshing while the user selects or drags in the chat would rebuild the
  // DOM under the selection; the guard's release callback re-polls right away.
  if (isChatInteractionHeld()) return;

  liveConversationPollInFlight = true;
  try {
    const messagesEl = document.getElementById('messages');
    const preserveBottom = isMessagesAtBottom();
    const savedScrollTop = messagesEl?.scrollTop || 0;
    const savedLoadedCount = loadConversationLoadedMessageCount(currentId);
    const requestLimit = Math.max(20, getConversationLoadedMessageCount() || 0, savedLoadedCount || 0);
    const response = await loadConversation(currentId, { limit: requestLimit });
    if (!response) return;
    if (String(currentConvId || '').trim() !== currentId) return;
    const stableSavedScrollTop = resolveStableScrollTopForLiveRefresh(messagesEl, savedScrollTop);
    applyLoadedConversationState(currentId, response, {
      restoreScroll: !preserveBottom,
      savedScrollTop: preserveBottom ? null : stableSavedScrollTop,
      followLiveUpdates: preserveBottom,
    });
  } finally {
    liveConversationPollInFlight = false;
  }
}

function startLiveConversationPolling() {
  if (liveConversationPollTimer || isSharedReaderMode()) return;
  liveConversationPollTimer = setInterval(() => {
    if (!shouldRunForegroundNetworkWork()) return;
    pollAuthenticatedCurrentConversationLive().catch(() => {});
  }, 900);
}

function setupViewportTracking() {
  syncViewportMetrics();
  const update = () => syncViewportMetrics();
  window.addEventListener('resize', update, { passive: true });
  window.addEventListener('orientationchange', update, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', update, { passive: true });
    window.visualViewport.addEventListener('scroll', update, { passive: true });
  }

  // The page root must never scroll: #app is viewport-sized and body hides its
  // scrollbar, but programmatic scrolls (scrollIntoView, focus reveals) can
  // still shift the root and push the header off-screen with no way back.
  const clampRootScroll = () => {
    if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) {
      window.scrollTo(0, 0);
    }
  };
  clampRootScroll();
  window.addEventListener('scroll', clampRootScroll, { passive: true });

  // The relay question cards create their reply controls dynamically, so the
  // keyboard-open bookkeeping is delegated instead of bound per input.
  const isQuestionTextControl = (node) => node instanceof Element
    && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT')
    && !!node.closest('.relay-question-container');
  document.addEventListener('focusin', (event) => {
    if (!isQuestionTextControl(event.target)) return;
    document.body.classList.add('keyboard-open');
    syncViewportMetrics();
  });
  document.addEventListener('focusout', (event) => {
    if (!isQuestionTextControl(event.target)) return;
    document.body.classList.remove('keyboard-open');
    syncViewportMetrics();
  });

  const input = document.getElementById('msg-input');
  if (input && input.dataset.viewportBound !== '1') {
    input.dataset.viewportBound = '1';
    input.addEventListener('input', () => {
      syncComposerControlState();
    }, { passive: true });
    input.addEventListener('focus', () => {
      document.body.classList.add('keyboard-open');
      syncViewportMetrics();
    }, { passive: true });
    input.addEventListener('blur', () => {
      document.body.classList.remove('keyboard-open');
      syncViewportMetrics();
      void flushConversationDraft(currentConvId);
    }, { passive: true });
  }
}

function composerAttachmentsAllowed() {
  // Shared read-only viewers must never be able to attach files.
  return !appSharedMode && !IS_SHARED_VIEW;
}

function initComposerAttachmentInput() {
  const input = document.getElementById('msg-input');
  if (input && input.dataset.pasteBound !== '1') {
    input.dataset.pasteBound = '1';
    input.addEventListener('paste', (event) => {
      if (!composerAttachmentsAllowed()) return;
      void handleComposerPaste(event);
    });
  }

  const dropZone = document.getElementById('input-area');
  if (!dropZone || dropZone.dataset.dropBound === '1') return;
  dropZone.dataset.dropBound = '1';

  // dragenter/dragleave fire for every child element, so the highlight is
  // reference counted instead of toggled, otherwise it flickers on each hover.
  let dragDepth = 0;
  const clearHighlight = () => {
    dragDepth = 0;
    dropZone.classList.remove('composer-dropzone-active');
  };

  dropZone.addEventListener('dragenter', (event) => {
    if (!composerAttachmentsAllowed() || !dataTransferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth += 1;
    dropZone.classList.add('composer-dropzone-active');
  });

  dropZone.addEventListener('dragover', (event) => {
    if (!composerAttachmentsAllowed() || !dataTransferHasFiles(event.dataTransfer)) return;
    // Without preventDefault the browser refuses the drop entirely.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  dropZone.addEventListener('dragleave', (event) => {
    if (!dragDepth) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropZone.classList.remove('composer-dropzone-active');
  });

  dropZone.addEventListener('drop', (event) => {
    clearHighlight();
    if (!composerAttachmentsAllowed()) return;
    void handleComposerDrop(event);
  });

  window.addEventListener('dragend', clearHighlight);
}

function initMessageScrollPersistence() {
  const el = document.getElementById('messages');
  if (!el || el.dataset.scrollPersistenceBound === '1') return;
  el.dataset.scrollPersistenceBound = '1';
  el.addEventListener('scroll', () => {
    const convId = String(currentConvId || '').trim();
    if (!convId) return;
    saveConversationScrollTop(convId, el.scrollTop);
  }, { passive: true });
}

async function runConversationHistoryRefresh({ source = 'menu' } = {}) {
  const currentId = String(currentConvId || '').trim();
  if (!currentId) {
    if (source !== 'pull') showTransientRelayNotice('Select a conversation first.');
    return false;
  }
  const eligibility = canRefreshConversationHistory(currentId);
  if (!eligibility.ok) {
    showTransientRelayNotice(eligibility.reason);
    return false;
  }

  const messagesEl = document.getElementById('messages');
  const scrollTop = messagesEl?.scrollTop || 0;
  const savedLoadedCount = loadConversationLoadedMessageCount(currentId);
  const requestLimit = Math.max(20, getConversationLoadedMessageCount() || 0, savedLoadedCount || 0);

  setHistoryRefreshInFlight(true);
  syncRefreshHistoryMenuState();
  try {
    const refreshed = await refreshConversationHistory(currentId, { limit: requestLimit });
    if (!refreshed) {
      throw new Error('History refresh request failed.');
    }
    if (String(currentConvId || '').trim() === currentId) {
      applyLoadedConversationState(currentId, refreshed, { restoreScroll: false });
    }
    await refreshConversations();
    await loadRelayQuestions(currentId);
    await loadRelayBoards();
    scheduleContextUsageRefresh(currentId, 0);

    if (messagesEl && String(currentConvId || '').trim() === currentId) {
      const savedScrollTop = loadConversationScrollTop(currentId);
      const nextScrollTop = Number.isFinite(savedScrollTop) ? savedScrollTop : scrollTop;
      messagesEl.scrollTop = nextScrollTop;
      if (Number.isFinite(nextScrollTop) && nextScrollTop >= 0) {
        saveConversationScrollTop(currentId, nextScrollTop);
      }
    }
    showTransientRelayNotice('Conversation history refreshed.');
    return true;
  } catch (error) {
    const message = String(error?.message || '').trim() || 'Could not refresh conversation history.';
    showTransientRelayNotice(message);
    return false;
  } finally {
    setHistoryRefreshInFlight(false);
    syncRefreshHistoryMenuState();
  }
}

let refreshViewVersion = 0;

async function refreshCurrentView() {
  const capturedVersion = ++refreshViewVersion;
  const messagesEl = document.getElementById('messages');
  const preserveBottom = isMessagesAtBottom();
  const scrollTop = messagesEl?.scrollTop || 0;
  const stableSavedScrollTop = resolveStableScrollTopForLiveRefresh(messagesEl, scrollTop);

  await refreshConversations();

  const currentId = String(currentConvId || '').trim();
  if (!currentId) {
    setRepoBrowserSessionInfo('', '');
    renderMessages([]);
    restoreInFlightThinking(null);
    scheduleContextUsageRefresh(null);
    syncRefreshHistoryMenuState();
    return;
  }

  const savedLoadedCount = loadConversationLoadedMessageCount(currentId);
  const requestLimit = Math.max(20, getConversationLoadedMessageCount() || 0, savedLoadedCount || 0);
  const r = await loadConversation(currentId, { limit: requestLimit });
  if (capturedVersion < refreshViewVersion) return;
  if (String(currentConvId || '').trim() !== currentId) return;
  if (r) {
    applyLoadedConversationState(currentId, r, {
      restoreScroll: !preserveBottom,
      savedScrollTop: preserveBottom ? null : stableSavedScrollTop,
      followLiveUpdates: preserveBottom,
    });
  } else {
    setRepoBrowserSessionInfo('', '');
    restoreInFlightThinking(null);
  }
  await loadRelayQuestions(currentId);
  await loadRelayBoards();
  scheduleContextUsageRefresh(currentId, 0);
  if (messagesEl && String(currentConvId || '').trim() === currentId) {
    if (!preserveBottom && Number.isFinite(stableSavedScrollTop) && stableSavedScrollTop >= 0) {
      messagesEl.scrollTop = stableSavedScrollTop;
    }
    saveConversationScrollTop(currentId, messagesEl.scrollTop);
  }
  syncRefreshHistoryMenuState();
}

async function copyTextToClipboard(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {}
  }
  try {
    const el = document.createElement('textarea');
    el.value = value;
    el.setAttribute('readonly', 'readonly');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return !!ok;
  } catch {
    return false;
  }
}

function initChatTitleCopy() {
  const title = document.getElementById('chat-title');
  if (!title || title.dataset.copyBound === '1') return;
  title.dataset.copyBound = '1';
  if (title.dataset.fullscreenBound) delete title.dataset.fullscreenBound;

  title.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const sessionId = String(title.dataset.copilotSessionId || '').trim();
    if (!sessionId) return;
    copyTextToClipboard(sessionId).then((ok) => {
      if (ok) {
        showTransientRelayNotice(`Copied Copilot session ID: ${sessionId.slice(0, 8)}…`);
      } else {
        showTransientRelayNotice('Could not copy session ID.');
      }
    }).catch(() => {});
  }, true);
}

function getChatTitleElements() {
  return {
    wrap: document.getElementById('chat-title-wrap'),
    title: document.getElementById('chat-title'),
    editBtn: document.getElementById('chat-actions-menu-btn'),
    editor: document.getElementById('chat-title-editor'),
    input: document.getElementById('chat-title-input'),
    saveBtn: document.getElementById('chat-title-save-btn'),
    cancelBtn: document.getElementById('chat-title-cancel-btn'),
  };
}

function closeChatActionsMenu() {
  const menu = document.getElementById('chat-actions-menu');
  const trigger = document.getElementById('chat-actions-menu-btn');
  const backdrop = document.getElementById('chat-actions-menu-backdrop');
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (backdrop && !window.__chatActionsMenuShieldTimer) backdrop.classList.remove('visible');
}

function toggleChatActionsMenu() {
  const menu = document.getElementById('chat-actions-menu');
  const trigger = document.getElementById('chat-actions-menu-btn');
  if (!menu || !trigger || trigger.hidden || trigger.disabled) return;
  syncRefreshHistoryMenuState();
  syncThemeMenuLabel();
  const willOpen = !!menu.hidden;
  menu.hidden = !willOpen;
  trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

function isConversationLocallyProcessing(conversation) {
  if (!conversation || typeof conversation !== 'object') return false;
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

function canRefreshConversationHistory(conversationId) {
  const currentId = String(conversationId || '').trim();
  if (!currentId) {
    return { ok: false, reason: 'Select a conversation first.' };
  }
  if (isHistoryRefreshInFlight()) {
    return { ok: false, reason: 'History refresh is already running.' };
  }
  if (isSendInFlight()) {
    return { ok: false, reason: 'Wait for the current send to finish before refreshing history.' };
  }
  const conversation = conversations[currentId] || null;
  if (isConversationLocallyProcessing(conversation)) {
    return { ok: false, reason: 'Wait for the current turn to finish before refreshing history.' };
  }
  return { ok: true };
}

function syncRefreshHistoryMenuState() {
  const button = document.getElementById('chat-menu-refresh-history');
  if (!button) return;
  if (button.hidden || button.getAttribute('aria-hidden') === 'true') {
    button.disabled = true;
    button.tabIndex = -1;
    button.setAttribute('aria-disabled', 'true');
    return;
  }
  if (isHistoryRefreshInFlight()) {
    button.disabled = true;
    button.title = 'Refreshing conversation history';
    return;
  }
  const eligibility = canRefreshConversationHistory(currentConvId);
  button.disabled = !eligibility.ok;
  button.title = eligibility.ok ? 'Rebuild this conversation history from SDK events.' : eligibility.reason;
}

function lockChatActionsMenuShield(ms = 300) {
  const backdrop = document.getElementById('chat-actions-menu-backdrop');
  if (!backdrop) return;
  if (window.__chatActionsMenuShieldTimer) {
    window.clearTimeout(window.__chatActionsMenuShieldTimer);
  }
  backdrop.classList.add('visible');
  window.__chatActionsMenuShieldTimer = window.setTimeout(() => {
    window.__chatActionsMenuShieldTimer = null;
    const menu = document.getElementById('chat-actions-menu');
    if (menu?.hidden) backdrop.classList.remove('visible');
  }, Math.max(150, Number(ms) || 300));
}


function syncChatTitleControls() {
  const { title, editBtn, editor, input } = getChatTitleElements();
  const convId = String(currentConvId || '').trim();
  const killBtn = document.getElementById('chat-menu-kill-session');
  const sharedMode = isSharedReaderMode();
  const conversation = convId ? (conversations[convId] || null) : null;
  const sdkSessionId = String(conversation?.sdkSessionId || '').trim();
  if (title) {
    if (!convId || !conversation) {
      delete title.dataset.uiState;
    } else {
      const pendingByConversation = getPendingQuestionCountsByConversation();
      const pendingCount = Number(pendingByConversation[convId] || 0);
      const workerState = sdkSessionId ? getSessionWorkerState(sdkSessionId) : null;
      const uiState = resolveConversationUiState({
        conversation,
        workerState,
        hasPendingQuestion: pendingCount > 0,
      });
      title.dataset.uiState = uiState;
    }
  }
  if (chatTitleEditingConversationId && chatTitleEditingConversationId !== convId) {
    chatTitleEditingConversationId = null;
  }
  const editing = convId && chatTitleEditingConversationId === convId;
  document.body.classList.toggle('chat-title-editing', !!editing);
  if (title) title.hidden = editing;
  if (editBtn) {
    editBtn.hidden = !convId;
    editBtn.disabled = !convId || editing;
  }
  if (killBtn) {
    killBtn.disabled = sharedMode || !convId || !sdkSessionId;
    killBtn.hidden = sharedMode || !convId;
  }
  if (editor) {
    editor.hidden = !editing;
  }
  if (input) {
    input.maxLength = CHAT_TITLE_MAX_LENGTH;
  }
  if (!convId && chatTitleEditingConversationId) {
    chatTitleEditingConversationId = null;
  }
  if (!editing && editor && !editor.hidden) {
    editor.hidden = true;
  }
  if (!isStatusViewActive()) {
    syncChatHeaderWorkspaceLabel();
  }
  syncChatTitleWatcherIndicator();
}

function openChatTitleEditor() {
  const convId = String(currentConvId || '').trim();
  if (!convId) return;
  const { title, editBtn, editor, input } = getChatTitleElements();
  closeChatActionsMenu();
  const currentTitle = String(conversations[convId]?.title || title?.textContent || convId).trim() || convId;
  chatTitleEditingConversationId = convId;
  document.body.classList.add('chat-title-editing');
  if (title) title.hidden = true;
  if (editBtn) editBtn.disabled = true;
  if (editor) editor.hidden = false;
  if (input) {
    input.maxLength = CHAT_TITLE_MAX_LENGTH;
    input.value = currentTitle;
    requestAnimationFrame(() => {
      if (chatTitleEditingConversationId !== convId) return;
      window.setTimeout(() => {
        if (chatTitleEditingConversationId !== convId) return;
        input.focus({ preventScroll: true });
        input.select();
      }, 50);
    });
  }
}

function closeChatTitleEditor() {
  chatTitleEditingConversationId = null;
  document.body.classList.remove('chat-title-editing');
  const { title, editBtn, editor, input } = getChatTitleElements();
  closeChatActionsMenu();
  if (editor) editor.hidden = true;
  if (title) title.hidden = !String(currentConvId || '').trim();
  if (editBtn) editBtn.disabled = !String(currentConvId || '').trim();
  if (input) {
    const convId = String(currentConvId || '').trim();
    input.value = convId ? String(conversations[convId]?.title || title?.textContent || convId) : '';
  }
  syncChatTitleControls();
}

function applyConversationTitleUpdate(conversationId, title, updatedAt) {
  const id = String(conversationId || '').trim();
  const nextTitle = String(title || '').trim();
  if (!id || !nextTitle) return;
  const existing = conversations[id] || { id, archived: false, messageCount: 0 };
  conversations[id] = {
    ...existing,
    title: nextTitle,
    updatedAt: String(updatedAt || existing.updatedAt || new Date().toISOString()),
  };
  if (currentConvId === id) {
    const titleEl = document.getElementById('chat-title');
    if (titleEl) titleEl.textContent = nextTitle;
  }
  renderConvList();
}

function applyConversationWorkspaceRootUpdate(payload = {}) {
  const conversationId = String(payload.conversationId || '').trim();
  if (!conversationId) return;
  const existing = conversations[conversationId] || { id: conversationId, archived: false, messageCount: 0 };
  const previousCurrentPath = String(existing.currentWorkspaceRootPath || '').trim();
  // A relaunch into a new CWD must not keep the old runtime root alive through
  // the `existing` fallback: the payload is the post-relaunch truth.
  const nextRuntimePath = Object.prototype.hasOwnProperty.call(payload, 'runtimeWorkspaceRootPath')
    ? String(payload.runtimeWorkspaceRootPath || '').trim()
    : String(existing.runtimeWorkspaceRootPath || '').trim();
  const nextRuntimeName = Object.prototype.hasOwnProperty.call(payload, 'runtimeWorkspaceRootName')
    ? String(payload.runtimeWorkspaceRootName || '').trim()
    : String(existing.runtimeWorkspaceRootName || '').trim();
  conversations[conversationId] = {
    ...existing,
    configuredWorkspaceRootPath: String(payload.configuredWorkspaceRootPath || existing.configuredWorkspaceRootPath || '').trim() || null,
    configuredWorkspaceRootName: String(payload.configuredWorkspaceRootName || existing.configuredWorkspaceRootName || '').trim() || null,
    runtimeWorkspaceRootPath: nextRuntimePath || null,
    runtimeWorkspaceRootName: nextRuntimeName || null,
    currentWorkspaceRootPath: String(payload.currentWorkspaceRootPath || existing.currentWorkspaceRootPath || '').trim() || null,
    currentWorkspaceRootName: String(payload.currentWorkspaceRootName || existing.currentWorkspaceRootName || '').trim() || null,
  };
  if (currentConvId !== conversationId) return;
  syncChatHeaderWorkspaceLabel();
  const nextCurrentPath = String(conversations[conversationId].currentWorkspaceRootPath || '').trim();
  const rootChanged = nextCurrentPath.toLowerCase() !== previousCurrentPath.toLowerCase();
  if (rootChanged) {
    resetWorkspaceRepoBrowserForRootChange();
  } else if (repoBrowserState.activeRoot === 'workspace' && repoBrowserState.open) {
    // Same root: refresh through the restoring path so open folders and the
    // current selection survive.
    refreshRepoBrowser();
  }
}

async function submitChatTitleEditor() {
  const convId = String(chatTitleEditingConversationId || currentConvId || '').trim();
  if (!convId) return;
  const { input } = getChatTitleElements();
  const nextTitle = String(input?.value || '').replace(/[\r\n]+/g, ' ').trim();
  if (!nextTitle) {
    setModelBanner('⚠️ Conversation title cannot be empty.');
    input?.focus();
    return;
  }
  if (nextTitle.length > CHAT_TITLE_MAX_LENGTH) {
    setModelBanner(`⚠️ Conversation title must be ${CHAT_TITLE_MAX_LENGTH} characters or fewer.`);
    input?.focus();
    return;
  }

  const result = await updateConversationTitle(convId, nextTitle);
  if (!result) {
    alert('Failed to update conversation title');
    return;
  }

  applyConversationTitleUpdate(result.conversationId || convId, result.title || nextTitle, result.updatedAt);
  closeChatTitleEditor();
}


initSocketHandlers({
  refreshCurrentView,
  refreshSessionWorkerStatus,
  refreshModelCatalog,
  updateModelCatalogState,
  reconcileOpenModelVariantModal,
  applyConversationWorkspaceRootUpdate,
  applyConversationTitleUpdate,
  syncChatTitleControls,
  applyConversationPreferencesForConversation,
  applyOpenAISettingsState,
  applyClaudeSettingsState,
  applyGrokSettingsState,
  applyCursorSettingsState,
});

initCwdPicker({
  applyConversationWorkspaceRootUpdate,
  refreshSessionWorkerStatus,
});

initActionConfirmations({
  lockChatActionsMenuShield,
  closeChatActionsMenu,
  syncQueueStatusMenuEntry,
  refreshSessionWorkerStatus,
  exposeOnWindow: false,
});
initTmuxInspectorView({
  bindMenuAction,
  lockChatActionsMenuShield,
  closeChatActionsMenu,
});

function showAuthGate(error = '') {
  document.getElementById('startup-loading')?.remove();
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app').classList.remove('visible');
  showAuthError(error);
  document.getElementById('token-input')?.focus();
}

// Runs before anything reads MODEL_STORAGE_KEY so the first load after an
// upgrade already sees the model the user last picked in the New Chat modal.
function migrateLegacyModelStorageKey() {
  try {
    const legacy = String(localStorage.getItem(LEGACY_MODEL_STORAGE_KEY) || '').trim();
    if (!legacy) return;
    if (!String(localStorage.getItem(MODEL_STORAGE_KEY) || '').trim()) {
      localStorage.setItem(MODEL_STORAGE_KEY, legacy);
    }
    localStorage.removeItem(LEGACY_MODEL_STORAGE_KEY);
  } catch {}
}

async function initApp() {
  migrateLegacyModelStorageKey();
  initClientDiagnostics();
  installExternalLinkPolicy({ onFallback: showExternalLinkFallback });
  const sharedMode = isSharedReaderMode();
  appSharedMode = sharedMode;
  initNetworkLifecycleHandling();
  setForegroundNetworkWorkEnabled(document.visibilityState === 'visible');
  const sharedThemeBtn = document.getElementById('chat-menu-shared-theme-toggle');
  initTheme();
  initThemeMenuToggle();
  if (sharedThemeBtn && sharedMode) sharedThemeBtn.hidden = false;
  initFontScaling();
  if (!sharedMode) {
    clearLegacyKnownCwdHistoryStorage();
  }
  syncPwaVersionMenuEntry();
  syncQueueStatusMenuEntry();
  if (!sharedMode) {
    syncSuspendHostVisibility();
  }
  setupViewportTracking();
  bindChatSelectionGuard();
  chatSelectionGuard.onRelease(() => {
    flushDeferredMessageRender();
    pollAuthenticatedCurrentConversationLive().catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    stopSharedModeTimers();
    // The direct flush below can be killed mid-flight by the browser; the
    // queued copy survives and is replayed by Background Sync. If the direct
    // write wins, the replay hits a draft version conflict and is dropped.
    if (!appSharedMode) void enqueueDraftFlushForBackgroundSync(currentConvId);
    void flushConversationDraft(currentConvId);
    closeTmuxInspectorView();
  });
  document.getElementById('startup-loading')?.remove();
  document.getElementById('auth-gate').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  initSidebarLayout();
  const chatActionsMenuBtn = document.getElementById('chat-actions-menu-btn');
  bindTapAction(chatActionsMenuBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleChatActionsMenu();
  });
  if (!sharedMode) {
    const chatMenuEditBtn = document.getElementById('chat-menu-edit-title');
    const chatMenuUsageBtn = document.getElementById('chat-menu-usage');
    bindMenuAction(chatMenuUsageBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      showUsage().catch((error) => {
        alert(error?.message || 'Failed to load usage');
      });
    });
    bindMenuAction(chatMenuEditBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      openChatTitleEditor();
    });
    const chatMenuCompactBtn = document.getElementById('chat-menu-compact');
    if (chatMenuCompactBtn && !chatMenuCompactBtn.hidden && !chatMenuCompactBtn.disabled) {
      bindMenuAction(chatMenuCompactBtn, (event) => {
        event.preventDefault();
        event.stopPropagation();
        lockChatActionsMenuShield(350);
        closeChatActionsMenu();
        compactCurrentConversation().catch((error) => {
          alert(error?.message || 'Failed to compact conversation');
        });
      });
    }
    const chatMenuShareConversationBtn = document.getElementById('chat-menu-share-conversation');
    bindMenuAction(chatMenuShareConversationBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      const convId = String(currentConvId || '').trim();
      if (!convId) {
        showTransientRelayNotice('Select a conversation first.');
        return;
      }
      createConversationShareLink(convId).then(async (result) => {
        const shareUrl = String(result?.shareUrl || '').trim();
        if (!shareUrl) {
          showTransientRelayNotice(result?.error || 'Could not create share link.');
          return;
        }
        const copied = await copyTextToClipboard(shareUrl);
        showTransientRelayNotice(copied ? 'Share link copied to clipboard.' : shareUrl);
      }).catch((error) => {
        showTransientRelayNotice(error?.message || 'Could not create share link.');
      });
    });
    const chatMenuRefreshHistoryBtn = document.getElementById('chat-menu-refresh-history');
    if (chatMenuRefreshHistoryBtn && !chatMenuRefreshHistoryBtn.hidden && !chatMenuRefreshHistoryBtn.disabled) {
      bindMenuAction(chatMenuRefreshHistoryBtn, (event) => {
        event.preventDefault();
        event.stopPropagation();
        lockChatActionsMenuShield(350);
        closeChatActionsMenu();
        runConversationHistoryRefresh({ source: 'menu' }).catch(() => {});
      });
    }
    const chatMenuSelectModelsBtn = document.getElementById('chat-menu-select-models');
    bindMenuAction(chatMenuSelectModelsBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      openSelectModelsModal().catch((error) => {
        alert(error?.message || 'Failed to open model selector');
      });
    });
    const chatMenuChangeCwdBtn = document.getElementById('chat-menu-change-cwd');
    bindMenuAction(chatMenuChangeCwdBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      openChangeCwdModal();
    });
    const chatMenuGitChangesBtn = document.getElementById('chat-menu-git-changes');
    bindMenuAction(chatMenuGitChangesBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      openGitChangesModal();
    });
    const chatMenuSettingsBtn = document.getElementById('chat-menu-settings');
    bindMenuAction(chatMenuSettingsBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      openSettingsModal();
    });
    const chatMenuRestartRelayBtn = document.getElementById('chat-menu-restart-relay');
    bindMenuAction(chatMenuRestartRelayBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      openRestartRelayConfirmation();
    });
    const chatMenuEmptyQueueBtn = document.getElementById('chat-menu-empty-queue');
    bindMenuAction(chatMenuEmptyQueueBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      openEmptyQueueConfirmation();
    });
    const chatMenuKillBtn = document.getElementById('chat-menu-kill-session');
    bindMenuAction(chatMenuKillBtn, (event) => {
      event.preventDefault();
      event.stopPropagation();
      lockChatActionsMenuShield(350);
      closeChatActionsMenu();
      openKillSessionConfirmation();
    });
  }
  const sidebarToggleBtn = document.getElementById('sidebar-toggle');
  bindTapAction(sidebarToggleBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleSidebar();
  });
  if (!window.__chatActionsMenuBound) {
    window.__chatActionsMenuBound = true;
    document.addEventListener('click', (event) => {
      const menuWrap = document.getElementById('chat-actions-menu-wrap');
      if (!menuWrap) return;
      if (menuWrap.contains(event.target)) return;
      closeChatActionsMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      closeChatActionsMenu();
    });
  }
  const chatTitleEditor = document.getElementById('chat-title-editor');
  if (chatTitleEditor && chatTitleEditor.dataset.bound !== '1') {
    chatTitleEditor.dataset.bound = '1';
    chatTitleEditor.addEventListener('submit', (event) => {
      event.preventDefault();
      submitChatTitleEditor().catch((error) => {
        alert(error?.message || 'Failed to update conversation title');
      });
    });
  }
  const chatTitleInput = document.getElementById('chat-title-input');
  if (chatTitleInput && chatTitleInput.dataset.bound !== '1') {
    chatTitleInput.dataset.bound = '1';
    chatTitleInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeChatTitleEditor();
      }
    });
  }
  const chatTitleCancelBtn = document.getElementById('chat-title-cancel-btn');
  if (chatTitleCancelBtn && chatTitleCancelBtn.dataset.bound !== '1') {
    chatTitleCancelBtn.dataset.bound = '1';
    chatTitleCancelBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeChatTitleEditor();
    });
  }
  if (sharedMode) {
    initFullscreenButton();
    initConversationHistoryLazyLoading();
    initBubbleActionHandlers();
    initMessageScrollPersistence();
    syncChatTitleControls();
    await initSharedConversationReader();
    return;
  }
  initModeSelector();
  initModelSelector();
  initReasoningSelector();
  initContextTierSelector();
  const modelMetadataRetryBtn = document.getElementById('model-metadata-retry-btn');
  if (modelMetadataRetryBtn && modelMetadataRetryBtn.dataset.bound !== '1') {
    modelMetadataRetryBtn.dataset.bound = '1';
    modelMetadataRetryBtn.addEventListener('click', () => {
      void retryModelMetadataRefresh();
    });
  }
  syncModelMetadataBlocker();
  const status = await refreshWorkspaceRootHints();
  syncQueueStatusMenuEntry(status);
  setSessionWorkerStatesFromStatusPayload(status?.sessionWorker || null);
  await refreshOpenAISettingsState();
  await refreshCursorSettingsState();
  await refreshGrokSettingsState();
  await refreshModelCatalog(true);
  initFullscreenButton();
  initInstallButton();
  syncRefreshHistoryMenuState();
  initChatTitleCopy();
  initEmojiPicker();
  initConversationListLazyLoading();
  initConversationHistoryLazyLoading();
  initBubbleActionHandlers();
  initMessageScrollPersistence();
  initComposerAttachmentInput();
  initMessageSearchView({ openConversation });
  initGitChangesView();
  syncChatTitleControls();
  connectSocket();
  startRelayConnectionWatchdog();
  startDeviceVisibilityHeartbeat();
  startRelayQuestionPolling();
  startRelayBoardPolling();
  startSessionWorkerStatusPolling();
  startLiveConversationPolling();
  initPushNotificationClientHooks();
  // Browsers without Background Sync replay the outbox from the page instead.
  void initOutboxFallbackReplay();
  await loadConversations();
  const pushConversationId = consumePushConversationDeepLink();
  if (pushConversationId) {
    await openConversation(pushConversationId).catch(() => {});
  }
  await loadRelayQuestions(currentConvId);
  await loadRelayBoards();
  updateCompactButton();
  document.getElementById('msg-input').focus();
}

async function doAuth() {
  const tokenInput = document.getElementById('token-input');
  const val = tokenInput.value.trim() || getTokenFromUrl();
  if (!val) return showAuthError('Please enter a token');
  const result = await verifyToken(val);
  if (result?.ok) {
    setToken('');
    tokenInput.value = '';
    await startAppWithErrorHandling();
  } else {
    showAuthError(resolveAuthErrorMessage(result));
  }
}


async function bootstrap() {
  if (ensureTrailingSlashPath()) return;
  const sharedMode = isSharedReaderMode();
  if (sharedMode && navigator.serviceWorker?.getRegistrations) {
    navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister().catch(() => false))))
      .catch(() => {});
  }
  if (!sharedMode) {
    await applyPwaManifestFromSettings();
  }
  if (!sharedMode) {
    registerPwaShell();
    initInstallButton();
  }
  if (sharedMode) {
    await startAppWithErrorHandling();
    return;
  }
  const urlToken = getTokenFromUrl();
  if (urlToken) stripTokenFromUrl();
  const persistedToken = consumeLegacyPersistedAuthToken();
  const bootstrapToken = String(urlToken || persistedToken || '').trim();
  const existingSession = await verifyExistingSession(bootstrapToken);
  if (existingSession?.ok) {
    setToken('');
    await startAppWithErrorHandling();
    return;
  }
  if (bootstrapToken) {
    setToken('');
    document.getElementById('token-input').value = '';
    showAuthGate(resolveAuthErrorMessage(existingSession));
    return;
  }
  showAuthGate();
}

window.updateTheme = updateTheme;
window.updateFontScaleFromSelect = updateFontScaleFromSelect;
window.updatePwaAppName = updatePwaAppName;
window.updateDefaultSessionWorkspaceRootSetting = updateDefaultSessionWorkspaceRootSetting;
window.saveOpenAISettings = saveOpenAISettings;
window.removeOpenAISettings = removeOpenAISettings;
window.toggleOpenAIProvider = toggleOpenAIProvider;
window.saveClaudeSettings = saveClaudeSettings;
window.toggleClaudeProvider = toggleClaudeProvider;
window.saveGrokSettings = saveGrokSettings;
window.toggleGrokProvider = toggleGrokProvider;
window.saveCursorSettings = saveCursorSettings;
window.removeCursorSettings = removeCursorSettings;
window.saveCursorAllowanceSettings = saveCursorAllowanceSettings;
window.resetCursorAllowanceAccounting = resetCursorAllowanceAccounting;
window.saveCursorDashboardToken = saveCursorDashboardToken;
window.removeCursorDashboardToken = removeCursorDashboardToken;
window.saveGrokAllowanceSettings = saveGrokAllowanceSettings;
window.resetGrokAllowanceAccounting = resetGrokAllowanceAccounting;
window.toggleCursorProvider = toggleCursorProvider;
window.updateShowSuspendHostSetting = updateShowSuspendHostSetting;
window.updateWindowsAutostartSettingFromToggle = updateWindowsAutostartSettingFromToggle;
window.previewTurnCeilingSetting = previewTurnCeilingSetting;
window.updateTurnCeilingSetting = updateTurnCeilingSetting;
window.previewBackgroundTaskTimeoutSetting = previewBackgroundTaskTimeoutSetting;
window.updateBackgroundTaskTimeoutSetting = updateBackgroundTaskTimeoutSetting;
window.togglePushOnThisDevice = togglePushOnThisDevice;
window.updatePushPreferencesFromControls = updatePushPreferencesFromControls;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.doAuth = doAuth;
window.initApp = initApp;
window.connectSocket = connectSocket;
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window.toggleSidebar = toggleSidebar;
window.showUsage = showUsage;
window.openChangeCwdModal = openChangeCwdModal;
window.confirmChangeCwd = confirmChangeCwd;
window.confirmChangeCwdAndLaunch = confirmChangeCwdAndLaunch;
window.showContext = showContext;
window.promptInstallApp = promptInstallApp;
window.toggleFullscreen = toggleFullscreen;
window.syncAutoModelAvailability = syncAutoModelAvailability;
window.openRepoBrowser = openRepoBrowser;
window.closeRepoBrowser = closeRepoBrowser;
window.loadRepoBrowserTree = loadRepoBrowserTree;
window.refreshRepoBrowser = refreshRepoBrowser;
window.initModeSelector = initModeSelector;
window.initModelSelector = initModelSelector;
window.refreshModelCatalog = refreshModelCatalog;
window.retryModelMetadataRefresh = retryModelMetadataRefresh;
window.isModelMetadataBlocked = () => modelMetadataBlocked || !isModelMetadataHealthy();
window.saveSelectedModelsFromModal = saveSelectedModelsFromModal;
window.selectedModelValue = selectedModelValue;
window.selectedReasoningEffortValue = selectedReasoningEffortValue;
window.getPreferredModelSelection = () => selectedModelValue();
window.applyConversationPreferences = applyConversationPreferencesForConversation;
window.applyModelCatalogState = updateModelCatalogState;
window.updateCliStatus = updateCliStatus;
window.showAuthError = showAuthError;
window.registerPwaShell = registerPwaShell;
window.newConversation = newConversation;
window.confirmNewConversationModel = confirmNewConversationModel;
window.closeNewConversationModelModal = closeNewConversationModelModal;
window.deleteConv = deleteConv;
window.openConversation = openConversation;
window.toggleStatusView = toggleStatusView;
window.refreshConversations = refreshConversations;
window.renderConvList = renderConvList;
window.handleAttachmentInput = handleAttachmentInput;
window.retryAttachmentUpload = retryAttachmentUpload;
window.removeAttachment = removeAttachment;
window.clearAttachments = clearAttachments;
window.openUploadedAttachmentViewer = openUploadedAttachmentViewer;
window.setFilePreviewMode = setFilePreviewMode;
window.toggleFilePreviewHtml = toggleFilePreviewHtml;
window.closeFilePreview = closeFilePreview;
window.goBackFilePreview = goBackFilePreview;
window.openWorkspaceFilePreview = openWorkspaceFilePreview;
window.openWorkspaceFilePreviewFromRepo = openWorkspaceFilePreviewFromRepo;
window.setRepoBrowserRoot = setRepoBrowserRoot;
window.setRepoBrowserViewMode = setRepoBrowserViewMode;
window.toggleRepoBrowserHidden = toggleRepoBrowserHidden;
window.toggleRepoBrowserHeavy = toggleRepoBrowserHeavy;
window.focusRepoTree = focusRepoTree;
window.setRepoCurrentPath = setRepoCurrentPath;
window.toggleEmojiPicker = toggleEmojiPicker;
window.submitRelayQuestionChoice = submitRelayQuestionChoice;
window.submitRelayQuestionAnswer = submitRelayQuestionAnswer;
window.submitRelayStructuredAnswer = submitRelayStructuredAnswer;
window.onRelayQuestionDraftInput = onRelayQuestionDraftInput;
window.handleRelayQuestionKey = handleRelayQuestionKey;
window.openPendingQuestionFromBanner = openPendingQuestionFromBanner;
window.submitRelayBoardAction = submitRelayBoardAction;
window.compactCurrentConversation = compactCurrentConversation;
window.sendMessage = sendMessage;
window.syncComposerControlState = syncComposerControlState;
window.persistComposerAttachments = persistComposerAttachments;
window.appendMessage = appendMessage;
window.loadOlderConversationMessages = loadOlderConversationMessages;
window.handleKey = handleKey;
window.setImageEditTarget = setImageEditTarget;
window.clearImageEditTarget = clearImageEditTarget;
window.jumpToImageParent = jumpToImageParent;
window.autoResize = autoResize;
window.closeSummaryModal = closeSummaryModal;
window.refreshSummaryModal = refreshSummaryModal;
window.renderSummaryModalContent = renderSummaryModalContent;
window.setSummaryModalLoading = setSummaryModalLoading;
window.openSummaryModal = openSummaryModal;
window.syncChatTitleControls = syncChatTitleControls;
window.closeChatActionsMenu = closeChatActionsMenu;
window.openSuspendHostConfirmation = openSuspendHostConfirmation;
window.confirmKillCurrentSession = confirmKillCurrentSession;
window.confirmRestartWebRelay = confirmRestartWebRelay;
window.confirmSuspendHost = confirmSuspendHost;
window.confirmEmptyQueue = confirmEmptyQueue;
window.openMessageSearchModal = openMessageSearchModal;
window.closeMessageSearchModal = closeMessageSearchModal;
window.openGitChangesModal = openGitChangesModal;
window.closeGitChangesModal = closeGitChangesModal;
window.openGitDiffViewer = openGitDiffViewer;
window.closeGitDiffViewer = closeGitDiffViewer;
window.setGitDiffMode = setGitDiffMode;
window.copyExternalLinkUrl = copyExternalLinkUrl;
window.retryExternalLinkOpen = retryExternalLinkOpen;

window.addEventListener('copilot:external-link-fallback', (event) => {
  showExternalLinkFallback(event.detail?.url);
});

bootstrap();
