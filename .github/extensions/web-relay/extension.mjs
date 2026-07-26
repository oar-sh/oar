/**
 * web-relay — Copilot CLI Extension
 *
 * Bridges the web server (localhost:3333) to this CLI session.
 * Polls for queued messages from the browser and submits them to
 * the Copilot agent. Captures responses, forwards clarification
 * questions back to the browser, and posts replies back.
 */
import { joinSession } from "@github/copilot-sdk/extension";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { generateHighEntropyToken } from "./utils/token-generation.mjs";
import { delay, killProcessTree, sleep } from "./utils/process-utils.mjs";
import {
  resolveRelayPaths,
  loadTokenFromConfig,
  loadRelayInstructionsFromFile,
  resolveRelayServerUrl,
} from "./runtime/config-loader.mjs";
import { createDebugLogger } from "./runtime/debug-log.mjs";
import { createApiClient } from "./runtime/api-client.mjs";
import {
  formatToolActivity,
  formatToolResultActivity,
  isAskUserTool,
  normalizeActivityText,
  extractQuestionChoices,
  extractQuestionPrompt,
  serializeRequest,
} from "./skills/tool-activity.mjs";
import { buildPromptWithMode } from "./skills/prompt-context.mjs";
import { createQuestionBridge } from "./skills/question-bridge.mjs";
import { createQuestionRoutingHooks } from "./skills/question-routing-hooks.mjs";
import { createReasoningStreamHandlers } from "./skills/reasoning-stream.mjs";
import { createSubagentLifecycleHandlers } from "./skills/subagent-lifecycle.mjs";
import { createHeartbeatController } from "./polling/heartbeat.mjs";
import { createPollingLoop } from "./polling/polling-loop.mjs";
import { createManagedServerLifecycle } from "./server-lifecycle/managed-server.mjs";
import { createModelSwitchingService } from "./model-api/model-switching.mjs";
import { createSessionRuntimeManager } from "./runtime/session-runtime-manager.mjs";
import { createSessionIoHelpers } from "./runtime/session-io.mjs";
import { createWorkerWebSocketLink } from "./runtime/worker-websocket-link.mjs";
import { resolveSessionBinding } from "./runtime/session-binding.mjs";
import { createBannerStateStore } from "./runtime/banner-state.mjs";
import { clearSession, getActiveSession, registerSession } from "./runtime/session-registry.mjs";
import { syncSessionToServer, syncWorkspaceRootToServer } from "./runtime/session-sync-bridge.mjs";
import { joinSessionWithRetry } from "./runtime/session-join-retry.mjs";
import { resolveWorkspaceRootPath } from "./runtime/workspace-root.mjs";

const POLL_MS      = 10_000;
const HEARTBEAT_MS = 10_000;

const TOKEN_FALLBACK = generateHighEntropyToken();

const {
  CONFIG_PATH,
  RELAY_TOOLS_PATH,
  SERVER_DIR,
  LOG_DIR,
  SERVER_LOG_PATH,
  SERVER_ERR_PATH,
} = resolveRelayPaths(import.meta.url);
const SERVER_URL = resolveRelayServerUrl({ configPath: CONFIG_PATH });
const SERVER_START_TIMEOUT_MS = 20_000;
const NODE_BIN = process.env.COPILOT_WEB_RELAY_NODE || "node";

const CONFIG_TOKEN = loadTokenFromConfig(CONFIG_PATH);
const TOKEN = CONFIG_TOKEN || TOKEN_FALLBACK;
const TOKEN_WAS_GENERATED = !CONFIG_TOKEN;
const RELAY_TOOL_INSTRUCTIONS = loadRelayInstructionsFromFile(RELAY_TOOLS_PATH);
const QUESTION_POLL_MS = 1500;
const MAX_TOOL_DETAIL_LENGTH = 140;
const RESTART_CONTROL_STARTUP_GRACE_MS = 20_000;
const STARTUP_VERIFICATION_DELAY_MS = 1500;

const MODEL_SNAPSHOT_MIN_INTERVAL_MS = 30_000;
const BANNER_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
const BANNER_DEDUPE_COOLDOWN_MS = 15 * 1000;
const { dbg } = createDebugLogger({ logDir: LOG_DIR });
const api = createApiClient({
  serverUrl: SERVER_URL,
  token: TOKEN,
  getHeaders: () => ({
    "X-Relay-Process-Pid": String(process.pid),
    "X-Relay-Parent-Pid": String(process.ppid),
    "X-Relay-Session-Id": String(session?.sessionId || ""),
    "X-Relay-Conversation-Id": String(getCurrentConversationId() || ""),
  }),
});
const bannerStateStore = createBannerStateStore({
  stateFilePath: path.resolve(LOG_DIR, "relay-banner-state.json"),
  dbg,
  ttlMs: BANNER_DEDUPE_TTL_MS,
  cooldownMs: BANNER_DEDUPE_COOLDOWN_MS,
});

function normalizeRelayMode(value) {
  const mode = String(value || "agent").trim().toLowerCase();
  if (mode === "plan" || mode === "ask" || mode === "autopilot" || mode === "agent") return mode;
  return "agent";
}

let lastPromptedRelayMode = null;
const buildPromptWithRelayContext = (message) => {
  const relayMode = normalizeRelayMode(message?.relayMode);
  const includeInstructions = lastPromptedRelayMode !== relayMode;
  const prompt = buildPromptWithMode(
    { ...message, relayMode },
    RELAY_TOOL_INSTRUCTIONS,
    { includeInstructions },
  );
  lastPromptedRelayMode = relayMode;
  return prompt;
};

const managedServerLifecycle = createManagedServerLifecycle({
  api,
  dbg,
  fs,
  spawn,
  killProcessTree,
  delay,
  token: TOKEN,
  logDir: LOG_DIR,
  serverDir: SERVER_DIR,
  serverLogPath: SERVER_LOG_PATH,
  serverErrPath: SERVER_ERR_PATH,
  relayPort: Number(new URL(SERVER_URL).port) || 3333,
  nodeBin: NODE_BIN,
  serverStartTimeoutMs: SERVER_START_TIMEOUT_MS,
});

const ensureManagedServer = managedServerLifecycle.ensureManagedServer;
const stopManagedServer = managedServerLifecycle.stopManagedServer;

process.on("exit", () => {
  shutdownStarted = true;
  sessionReady = false;
  clearSession();
  pollingLoopController?.stopPolling?.();
  stopHeartbeat();
  workerWebSocketLink?.stop?.();
  managedServerLifecycle.killManagedProcessTree();
});
process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

if (!TOKEN) {
  console.warn("[web-relay] No authToken found in server/config.json; API calls will fail until configured.");
}

dbg("extension.mjs loaded, TOKEN:", TOKEN ? TOKEN.slice(0,3)+"***" : "(none)");

// ─── State ────────────────────────────────────────────────────────────────────
let activeMsg       = null;   // the web message currently being processed
let waitingForAI    = false;  // true while the agent is generating a response
let relayTurnActive = false;  // true while processing a relay-originated turn
let sessionReady    = false;
const SEND_TIMEOUT  = 2 * 60 * 60_000; // keep long ask_user pauses viable without letting broken turns linger all day
let heartbeatTimer  = null;
let pollingLoopStarted = false;
let activatingRelay = null;
let shutdownStarted = false;
let lastRenderedRelayBannerKey = "";
let preferredConversationSessionMode = "isolated";
let warnedConversationModeFallback = false;

const relayScopeState = new Map();
let activeRelayScopeKey = null;

let session = null;
let heartbeatController = null;
let pollingLoopController = null;
let restartControlPromise = null;
let startupVerificationTimer = null;
let restartControlGraceUntilMs = 0;
let deferredSessionEnd = false;
let workerWebSocketLink = null;
let reasoningStreamUnsubscribe = null;
let subagentLifecycleUnsubscribe = null;

function getCurrentConversationId() {
  const conversationId = String(activeMsg?.conversationId || "").trim();
  if (conversationId) return conversationId;
  const persistedConversationId = String(getActiveSession()?.conversationId || "").trim();
  return persistedConversationId || null;
}

function getCurrentWorkspaceRootPath() {
  return resolveWorkspaceRootPath({
    session,
    env: process.env,
    cwd: process.cwd(),
  });
}

function normalizeRelayScopeValue(value) {
  const text = String(value || "").trim();
  return text || null;
}

function buildRelayScopeKey({ conversationId, sdkSessionId } = {}) {
  const convId = normalizeRelayScopeValue(conversationId);
  const sessionId = normalizeRelayScopeValue(sdkSessionId);
  if (sessionId && convId) return `${sessionId}::${convId}`;
  if (convId) return `conv::${convId}`;
  if (sessionId) return `sdk::${sessionId}`;
  return null;
}

function getRelayScopeKey() {
  if (activeRelayScopeKey) return activeRelayScopeKey;
  return buildRelayScopeKey({
    conversationId: activeMsg?.conversationId,
    sdkSessionId: session?.sessionId,
  });
}

function ensureRelayScopeState(scopeKey) {
  if (!scopeKey) return null;
  let state = relayScopeState.get(scopeKey);
  if (!state) {
    state = {
      lastActivityText: "",
      lastAskUserBridge: null,
      pendingAskUserRequest: null,
    };
    relayScopeState.set(scopeKey, state);
  }
  return state;
}

function getScopedRelayState() {
  const scopeKey = getRelayScopeKey();
  const state = ensureRelayScopeState(scopeKey);
  return { scopeKey, state };
}

function getScopedLastActivityText() {
  const { state } = getScopedRelayState();
  return state?.lastActivityText || "";
}

function setScopedLastActivityText(value) {
  const { state } = getScopedRelayState();
  if (!state) return;
  state.lastActivityText = String(value || "");
}

function getScopedLastAskUserBridge() {
  const { state } = getScopedRelayState();
  return state?.lastAskUserBridge || null;
}

function setScopedLastAskUserBridge(value) {
  const { state } = getScopedRelayState();
  if (!state) return;
  state.lastAskUserBridge = value || null;
}

function getScopedPendingAskUserRequest() {
  const { state } = getScopedRelayState();
  return state?.pendingAskUserRequest || null;
}

function setScopedPendingAskUserRequest(value) {
  const { state } = getScopedRelayState();
  if (!state) return;
  state.pendingAskUserRequest = value || null;
}

function clearScopedRelayState() {
  const { scopeKey } = getScopedRelayState();
  if (!scopeKey) return;
  relayScopeState.delete(scopeKey);
}

function refreshSessionRegistry() {
  const sdkSessionId = String(session?.sessionId || "").trim();
  if (!sdkSessionId) {
    clearSession();
    return null;
  }

  const currentConversationId = getCurrentConversationId();
  const existingConversationId = String(getActiveSession()?.conversationId || "").trim() || null;
  return registerSession(sdkSessionId, currentConversationId || existingConversationId);
}

async function syncActiveSession(reason, forceSync = false) {
  const activeSession = refreshSessionRegistry();
  if (!activeSession?.sdkSessionId || !activeSession?.conversationId) return false;

  try {
    return await syncSessionToServer(activeSession.sdkSessionId, activeSession.conversationId, api, forceSync, {
      workspaceRootPath: getCurrentWorkspaceRootPath(),
    });
  } catch (e) {
    dbg("session sync failed:", reason, e?.message || String(e));
    return false;
  }
}

async function syncStartupWorkspaceRoot(reason = "startup") {
  const currentWorkspaceRootPath = resolveWorkspaceRootPath({
    session,
    env: process.env,
    cwd: process.cwd(),
    includeProcessCwd: true,
  });
  if (!currentWorkspaceRootPath) return false;
  try {
    return await syncWorkspaceRootToServer(currentWorkspaceRootPath, api, {
      sdkSessionId: String(session?.sessionId || "").trim() || null,
    });
  } catch (e) {
    dbg("workspace root sync failed:", reason, e?.message || String(e));
    return false;
  }
}

async function ensureSessionForConversation(conversationId, reason = "dequeue") {
  const convId = String(conversationId || "").trim();
  if (!convId) {
    return {
      ok: false,
      reason: "conversation-id-missing",
      retryable: false,
      message: "Missing conversation id for session binding check",
      activeSessionId: String(session?.sessionId || "").trim() || null,
      targetSessionId: null,
    };
  }

  let details = null;
  try {
    details = await api("GET", `/api/conversation/${encodeURIComponent(convId)}`);
  } catch (error) {
    return {
      ok: false,
      reason: "conversation-load-failed",
      retryable: true,
      message: `Failed to load conversation binding: ${error?.message || String(error)}`,
      activeSessionId: String(session?.sessionId || "").trim() || null,
      targetSessionId: null,
    };
  }

  const binding = resolveSessionBinding({
    conversationId: convId,
    details,
    activeSessionId: String(session?.sessionId || "").trim() || null,
  });
  if (binding?.ok) {
    registerSession(binding.activeSessionId, convId);
    return {
      ok: true,
      switched: false,
      via: binding?.via || "session-liveness",
      activeSessionId: binding.activeSessionId,
      targetSessionId: binding.targetSessionId,
    };
  }

  if (binding?.canClaim === true && binding?.activeSessionId) {
    try {
      await syncSessionToServer(binding.activeSessionId, convId, api, true, {
        workspaceRootPath: getCurrentWorkspaceRootPath(),
      });
      registerSession(binding.activeSessionId, convId);
      return {
        ok: true,
        switched: false,
        via: "session-claim",
        activeSessionId: binding.activeSessionId,
        targetSessionId: binding.activeSessionId,
      };
    } catch (error) {
      return {
        ok: false,
        reason: "session-claim-failed",
        retryable: true,
        message: `Failed to claim conversation binding: ${error?.message || String(error)}`,
        activeSessionId: binding.activeSessionId || String(session?.sessionId || "").trim() || null,
        targetSessionId: null,
      };
    }
  }

  const targetSessionId = String(binding?.targetSessionId || "").trim();
  if (targetSessionId) {
    const switched = await sessionRuntimeManager.activateSession(targetSessionId, reason);
    if (!switched?.ok) {
      return {
        ok: false,
        reason: switched?.reason || binding?.reason || "session-switch-failed",
        retryable: switched?.retryable === true || binding?.retryable === true,
        message: switched?.error
          ? `Failed to activate bound SDK session: ${switched.error}`
          : (binding?.message || "Failed to activate bound SDK session"),
        activeSessionId: String(session?.sessionId || "").trim() || null,
        targetSessionId,
      };
    }
    const switchedSessionId = String(switched?.activeSessionId || targetSessionId).trim();
    try {
      await syncSessionToServer(switchedSessionId, convId, api, true, {
        workspaceRootPath: getCurrentWorkspaceRootPath(),
      });
      registerSession(switchedSessionId, convId);
      return {
        ok: true,
        switched: true,
        via: switched?.source || "runtime-switch",
        activeSessionId: switchedSessionId,
        targetSessionId,
      };
    } catch (error) {
      return {
        ok: false,
        reason: "session-sync-after-switch-failed",
        retryable: true,
        message: `Switched to SDK session ${targetSessionId} but failed to sync binding: ${error?.message || String(error)}`,
        activeSessionId: switchedSessionId || null,
        targetSessionId,
      };
    }
  }

  return binding;
}

const sessionIo = createSessionIoHelpers({
  getSession: () => session,
  sleep,
  dbg,
});

const modelSwitchingService = createModelSwitchingService({
  api,
  dbg,
  getSession: () => session,
  modelSnapshotMinIntervalMs: MODEL_SNAPSHOT_MIN_INTERVAL_MS,
});

const sessionRuntimeManager = createSessionRuntimeManager({
  dbg,
  getSession: () => session,
  setSession: (nextSession) => {
    if (nextSession && typeof nextSession === "object") {
      session = nextSession;
    }
  },
});

const getCurrentModelId = modelSwitchingService.getCurrentModelId;
const setModelForMessage = modelSwitchingService.setModelForMessage;
const publishModelSnapshot = modelSwitchingService.publishModelSnapshot;

const questionBridge = createQuestionBridge({
  api,
  dbg,
  sleep,
  getQuestionWaitTimeoutMs: () => SEND_TIMEOUT,
  questionPollMs: QUESTION_POLL_MS,
  getActiveMessage: () => activeMsg,
  extractQuestionPrompt,
  extractQuestionChoices,
  serializeRequest,
});

function startHeartbeat() {
  if (!heartbeatController) {
    heartbeatController = createHeartbeatController({
      api,
      pollMs: HEARTBEAT_MS,
      getSessionReady: () => sessionReady,
      getHeartbeatTimer: () => heartbeatTimer,
      setHeartbeatTimer: (timer) => { heartbeatTimer = timer; },
      getActiveQueueMessageId: () => ((waitingForAI || relayTurnActive) ? activeMsg?.id || null : null),
    });
  }
  heartbeatController.startHeartbeat();
}

async function pulseHeartbeat(reason = "unknown") {
  if (!heartbeatController) {
    startHeartbeat();
  }
  const ok = await heartbeatController?.pulseHeartbeat?.();
  if (!ok) {
    dbg("heartbeat pulse failed", reason);
  }
  return !!ok;
}

function stopHeartbeat() {
  heartbeatController?.stopHeartbeat();
}

function flushDeferredSessionEnd(reason = "deferred-onSessionEnd") {
  if (!deferredSessionEnd || shutdownStarted || waitingForAI || relayTurnActive) return;
  deferredSessionEnd = false;
  queueMicrotask(() => {
    void gracefulShutdown(reason);
  });
}

async function startPolling() {
  if (!pollingLoopController) {
    pollingLoopController = createPollingLoop({
      sleep,
      pollMs: POLL_MS,
      api,
      dbg,
      session,
      sendTimeout: SEND_TIMEOUT,
      publishModelSnapshot,
      setModelForMessage,
      buildPromptWithRelayContext,
      sendAndWaitWithHardTimeout,
      sendWithBestEffortStreaming,
      extractFinalText,
      extractGeneratedImages,
      getLastActivityText: () => getScopedLastActivityText(),
      getCurrentModelId,
      getPreferredConversationSessionMode: () => preferredConversationSessionMode,
      getSupportsIsolatedSessions: () => false,
      getWarnedConversationModeFallback: () => warnedConversationModeFallback,
      setWarnedConversationModeFallback: (value) => { warnedConversationModeFallback = value; },
      getPollingLoopStarted: () => pollingLoopStarted,
      setPollingLoopStarted: (value) => { pollingLoopStarted = value; },
      getSessionReady: () => sessionReady,
      getWaitingForAI: () => waitingForAI,
      setActiveMsg: (value) => { activeMsg = value; },
      setWaitingForAI: (value) => {
        waitingForAI = value;
        if (!waitingForAI) {
          flushDeferredSessionEnd();
        }
      },
      setRelayTurnActive: (value, message = null) => {
        relayTurnActive = !!value;
        if (relayTurnActive) {
          activeRelayScopeKey = buildRelayScopeKey({
            conversationId: message?.conversationId || activeMsg?.conversationId,
            sdkSessionId: session?.sessionId,
          });
          ensureRelayScopeState(activeRelayScopeKey);
        } else {
          activeRelayScopeKey = null;
          void subagentLifecycleHandlers.finalizeTurn(message || activeMsg).finally(() => {
            subagentLifecycleHandlers.reset();
          });
          reasoningStreamHandlers.reset();
          flushDeferredSessionEnd();
        }
      },
      setLastActivityText: (value) => { setScopedLastActivityText(value); },
      setLastAskUserBridge: (value) => { setScopedLastAskUserBridge(value); },
      setPendingAskUserRequest: (value) => { setScopedPendingAskUserRequest(value); },
      clearRelayScopeState: () => { clearScopedRelayState(); },
      // Worker-routed turns are delivered over the session-worker WebSocket.
      // Keep this loop for heartbeat/maintenance only; do not dequeue via HTTP
      // when the worker socket is disconnected or stale.
      shouldFetchPending: () => false,
      syncActiveSession,
      ensureSessionForConversation,
    });
  }

  await pollingLoopController.startPolling();
}

function startWorkerWebSocketLink() {
  if (!pollingLoopController || workerWebSocketLink) return;
  workerWebSocketLink = createWorkerWebSocketLink({
    serverUrl: SERVER_URL,
    token: TOKEN,
    dbg,
    getPid: () => process.pid,
    getSessionReady: () => sessionReady,
    getSessionId: () => session?.sessionId || null,
    onDeliver: async (pending, reason = "ws-deliver") => {
      await pollingLoopController?.handlePendingPayload?.(pending, reason);
    },
  });
  workerWebSocketLink.start();
}

async function forwardRelayQuestion(request) {
  return questionBridge.forwardRelayQuestion(request);
}

const subagentLifecycleHandlers = createSubagentLifecycleHandlers({
  api,
  dbg,
  getRelayTurnActive: () => relayTurnActive,
  getActiveMessage: () => activeMsg,
});

const questionRoutingHooks = createQuestionRoutingHooks({
  api,
  dbg,
  forwardRelayQuestion,
  isAskUserTool,
  normalizeActivityText,
  formatToolActivity,
  formatToolResultActivity,
  extractQuestionChoices,
  maxToolDetailLength: MAX_TOOL_DETAIL_LENGTH,
  getRelayTurnActive: () => relayTurnActive,
  getActiveMessage: () => activeMsg,
  setLastAskUserBridge: (value) => {
    setScopedLastAskUserBridge(value);
  },
  getLastActivityText: () => getScopedLastActivityText(),
  setLastActivityText: (value) => {
    setScopedLastActivityText(value);
  },
  setPendingAskUserRequest: (value) => {
    setScopedPendingAskUserRequest(value);
  },
});

const reasoningStreamHandlers = createReasoningStreamHandlers({
  api,
  dbg,
  getRelayTurnActive: () => relayTurnActive,
  getActiveMessage: () => activeMsg,
  notifySubagentAgentId: (agentId) => subagentLifecycleHandlers.ensureFromAgentId(agentId),
});

async function requeueActiveMessage(reason) {
  if (!waitingForAI || !activeMsg?.id) return false;
  const messageId = activeMsg.id;
  dbg("re-queue active relay message", `msgId=${messageId}`, `reason=${reason}`);
  try {
    await api("POST", "/api/requeue", { messageId });
    return true;
  } catch (e) {
    dbg("re-queue active relay message failed", `msgId=${messageId}`, e?.message || String(e));
    return false;
  }
}

async function gracefulShutdown(reason) {
  if (shutdownStarted) return;
  if (reason === "onSessionEnd" && (waitingForAI || relayTurnActive)) {
    deferredSessionEnd = true;
    dbg("graceful shutdown deferred until active relay turn settles", reason);
    return;
  }
  shutdownStarted = true;
  dbg("graceful shutdown", reason);
  if (startupVerificationTimer) {
    clearTimeout(startupVerificationTimer);
    startupVerificationTimer = null;
  }
  pollingLoopController?.stopPolling?.();
  stopHeartbeat();
  try {
    reasoningStreamUnsubscribe?.();
  } catch (e) {
    dbg("reasoning-stream unsubscribe failed:", e?.message || String(e));
  }
  reasoningStreamUnsubscribe = null;
  try {
    subagentLifecycleUnsubscribe?.();
  } catch (e) {
    dbg("subagent-lifecycle unsubscribe failed:", e?.message || String(e));
  }
  subagentLifecycleUnsubscribe = null;
  workerWebSocketLink?.stop?.();
  workerWebSocketLink = null;
  sessionReady = false;
  clearSession();
  await Promise.race([
    requeueActiveMessage(reason),
    sleep(500).then(() => false),
  ]).catch(() => false);
  await stopManagedServer();
}

function scheduleStartupVerification(reason, attemptsRemaining = 4) {
  if (shutdownStarted) return;
  if (startupVerificationTimer) {
    clearTimeout(startupVerificationTimer);
    startupVerificationTimer = null;
  }
  const remaining = Math.max(0, Number(attemptsRemaining || 0));
  if (remaining <= 0) return;
  startupVerificationTimer = setTimeout(() => {
    startupVerificationTimer = null;
    void verifyRelayStartup(reason, remaining);
  }, STARTUP_VERIFICATION_DELAY_MS);
}

async function verifyRelayStartup(reason, attemptsRemaining) {
  if (shutdownStarted || !sessionReady) return;
  const remaining = Math.max(0, Number(attemptsRemaining || 0));
  const status = await api("GET", "/api/status").catch(() => null);
  if (status?.cliOnline === true) {
    dbg("startup verification confirmed cliOnline", reason);
    return;
  }
  dbg(
    "startup verification retry",
    reason,
    `remaining=${remaining}`,
    `polling=${pollingLoopStarted ? "started" : "stopped"}`,
  );
  await syncActiveSession(`${reason}-startup-verify`, true).catch(() => false);
  await pulseHeartbeat(`${reason}-startup-verify`);
  startHeartbeat();
  startPolling().catch((error) => {
    dbg("startup verification polling restart failed", error?.message || String(error));
  });
  if (remaining > 1) {
    scheduleStartupVerification(reason, remaining - 1);
  }
}

function relayBannerCacheKey(readyBanner = null) {
  if (!readyBanner || typeof readyBanner !== "object") return "";
  const parts = [
    String(readyBanner.localUrl || ""),
    String(readyBanner.networkText || ""),
    String(readyBanner.remoteUrl || ""),
    String(readyBanner.pollingUrl || ""),
    String(readyBanner.authText || ""),
    String(readyBanner.listenHost || ""),
  ];
  return parts.join("|");
}

function summarizeRelayConnection(status, readyBanner) {
  const localUrl = String(readyBanner?.localUrl || `${SERVER_URL}/`).trim();
  const networkText = String(
    readyBanner?.networkText
    || (status?.localhostOnly ? "disabled (localhost only)" : `enabled (${String(status?.listenHost || "0.0.0.0")})`)
    || "unavailable"
  ).trim();
  const remoteUrl = String(readyBanner?.remoteUrl || "").trim();
  const authText = `token=${TOKEN}`;
  const pollingUrl = String(readyBanner?.pollingUrl || `${SERVER_URL}/api/pending`).trim();
  return {
    localUrl,
    networkText,
    remoteUrl,
    authText,
    pollingUrl,
  };
}

function buildFallbackReadyBannerFromStatus(status = null) {
  const localUrl = `${SERVER_URL}/`;
  const pollingUrl = `${SERVER_URL}/api/pending`;
  const localhostOnly = status?.localhostOnly === true || String(status?.localhostOnly || "").toLowerCase() === "true";
  const listenHost = String(status?.listenHost || "").trim();
  const networkText = localhostOnly
    ? "disabled (localhost only)"
    : `enabled (${listenHost || "0.0.0.0"})`;

  const tunnelEnabled = status?.sshTunnel?.enabled === true;
  const tunnelHost = String(status?.sshTunnel?.host || "").trim();
  const remoteUrl = tunnelEnabled && tunnelHost ? `https://${tunnelHost.slice(0, 30)}/` : null;
  const authText = `token=${TOKEN}`;

  const fmt = (label, value) => `║  ${String(label || "").padEnd(11)}${String(value || "").padEnd(46)}║`;
  return {
    title: "Copilot Web Proxy  -  Ready",
    localUrl,
    networkUrl: localhostOnly ? null : "(computed from status)",
    networkText,
    remoteUrl,
    authText,
    pollingUrl,
    localhostOnly,
    listenHost: listenHost || (localhostOnly ? "127.0.0.1" : "0.0.0.0"),
    lines: [
      "╔══════════════════════════════════════════════════════════════╗",
      "║         Copilot Web Proxy  -  Ready                         ║",
      "╠══════════════════════════════════════════════════════════════╣",
      fmt("Local:", localUrl),
      fmt("Network:", networkText),
      ...(remoteUrl ? [fmt("Remote:", remoteUrl)] : []),
      fmt("Auth:", authText),
      "╠══════════════════════════════════════════════════════════════╣",
      "║  CLI polling URL (for monitoring mode):                      ║",
      fmt("GET:", pollingUrl),
      "╚══════════════════════════════════════════════════════════════╝",
    ],
  };
}

async function renderRelayReadyBannerFromStatus(status, { force = false } = {}) {
  if (!session) return;
  const readyBanner = status?.readyBanner && typeof status.readyBanner === "object"
    ? status.readyBanner
    : (status && typeof status === "object" ? buildFallbackReadyBannerFromStatus(status) : null);
  if (!readyBanner) {
    await session.log("🌐 Web relay connected (status banner unavailable)", { ephemeral: true });
    return;
  }

  const nextKey = relayBannerCacheKey(readyBanner);
  if (!force && nextKey && nextKey === lastRenderedRelayBannerKey) {
    dbg("relay banner suppressed: in-memory cache key match");
    return;
  }

  const suppress = bannerStateStore.shouldSuppress({
    sessionId: String(session?.sessionId || "").trim() || "unknown",
    bannerKey: nextKey || "fallback-banner",
    token: TOKEN,
    force,
  });
  if (suppress.suppress) {
    dbg("relay banner suppressed:", suppress.reason);
    if (nextKey) lastRenderedRelayBannerKey = nextKey;
    return;
  }

  const info = summarizeRelayConnection(status, readyBanner);
  await session.log("🌐 Web relay connected", { ephemeral: true });
  await session.log(`🏠 Local: ${info.localUrl}`, { ephemeral: true });
  await session.log(`🖧 Network: ${info.networkText}`, { ephemeral: true });
  if (info.remoteUrl) {
    await session.log(`🌍 Remote: ${info.remoteUrl}`, { ephemeral: true });
  }
  await session.log(`🔐 Auth: ${info.authText}`, { ephemeral: true });
  await session.log(`📡 Pending: ${info.pollingUrl}`, { ephemeral: true });

  if (nextKey) {
    lastRenderedRelayBannerKey = nextKey;
  }
  bannerStateStore.markShown({
    sessionId: String(session?.sessionId || "").trim() || "unknown",
    bannerKey: nextKey || "fallback-banner",
    token: TOKEN,
  });
}

// Start the web server as soon as the extension loads so users get relay availability
// even before the SDK session emits onSessionStart.
try {
  await ensureManagedServer();
} catch (e) {
  dbg("managed web server bootstrap failed:", e?.message || String(e));
}

// ─── Join the session ─────────────────────────────────────────────────────────
session = await joinSessionWithRetry({
  joinSessionImpl: joinSession,
  dbg,
  delay: sleep,
  retries: 5,
  retryDelayMs: 1500,
  joinOptions: {
  // Enable streaming so assistant.reasoning_delta and assistant.message_delta are emitted.
  // (The complete assistant.reasoning event fires regardless; this flag only adds deltas.)
  streaming: true,
  // onUserInputRequest must be a TOP-LEVEL property (not inside hooks) so the SDK calls
  // session.registerUserInputHandler() and sends requestUserInput: true to the CLI runtime.
  // When inside hooks it is silently ignored, causing the CLI to show its own terminal prompt.
  onUserInputRequest: async (request) => {
    dbg("onUserInputRequest CALLED!", "keys=", Object.keys(request || {}).join(","), "platform=", process.platform);
    return questionRoutingHooks.onUserInputRequest(request);
  },
  // onElicitationRequest handles multi-field structured `ask_user` forms (requestedSchema).
  // Must be a TOP-LEVEL property so the SDK registers the elicitation capability and routes
  // structured form requests here instead of flattening them through onUserInputRequest.
  onElicitationRequest: async (request) => {
    dbg("onElicitationRequest CALLED!", "keys=", Object.keys(request || {}).join(","), "mode=", request?.mode || "form", "platform=", process.platform);
    return questionRoutingHooks.onElicitationRequest(request);
  },
  hooks: {
    onSessionStart: async () => {
      dbg("onSessionStart fired");
      await syncStartupWorkspaceRoot("onSessionStart");
      try {
        await ensureRelayActive("onSessionStart");
      } catch (e) {
        await session.log(`⚠️ Web relay activation failed: ${e?.message || String(e)}`, { ephemeral: true });
        dbg("onSessionStart activation failed:", e?.message || String(e));
      }
      try {
        await session.log(`🔐 Web relay token: ${TOKEN}`, { ephemeral: true });
        await session.log(
          TOKEN_WAS_GENERATED
            ? "🔐 Token source: generated for this CLI session"
            : "🔐 Token source: server/config.json",
          { ephemeral: true }
        );
        await session.log("🌐 Web relay loaded — worker websocket delivery enabled with heartbeat maintenance", { ephemeral: true });
      } catch (e) { dbg("session.log error:", e.message); }
    },
    onPreToolUse: async (request) => {
      await subagentLifecycleHandlers.onPreToolUse(request);
      return questionRoutingHooks.onPreToolUse(request);
    },
    onPostToolUse: async (request, result) => {
      await subagentLifecycleHandlers.onPostToolUse(request, result);
      await questionRoutingHooks.onPostToolUse(request, result);
    },
    onSessionEnd: async () => {
      dbg("onSessionEnd fired");
      await gracefulShutdown("onSessionEnd");
    },
  },
  },
});

refreshSessionRegistry();
dbg("copilot session id:", session?.sessionId || "(none)");
dbg("joinSession resolved");
dbg("platform:", process.platform, "onUserInputRequest handler registered at top level");
try {
  reasoningStreamUnsubscribe = reasoningStreamHandlers.attach(session);
  subagentLifecycleUnsubscribe = subagentLifecycleHandlers.attach(session);
} catch (e) {
  dbg("reasoning-stream attach failed:", e?.message || String(e));
}
setTimeout(() => {
  ensureRelayActive("post-join-fallback").catch((e) => {
    dbg("post-join fallback activation failed:", e?.message || String(e));
  });
}, 1000);

// ─── Polling loop ─────────────────────────────────────────────────────────────
async function ensureRelayActive(reason) {
  if (shutdownStarted) {
    dbg("ensureRelayActive skipped: shutdown in progress", reason);
    return;
  }
  if (activatingRelay) return activatingRelay;
  activatingRelay = (async () => {
    dbg("ensureRelayActive", reason);
    await ensureManagedServer();
    sessionReady = true;
    await syncActiveSession(reason);
    const status = await api("GET", "/api/status").catch(() => null);
    const restartState = String(status?.restartOrchestrator?.state || "").trim().toLowerCase();
    const restartTx = String(status?.restartOrchestrator?.transactionId || "").trim();
    const restartTarget = String(status?.restartOrchestrator?.targetSessionId || "").trim();
    dbg(
      "relay status snapshot",
      `reason=${reason}`,
      `cliOnline=${status?.cliOnline === true ? "yes" : "no"}`,
      `orchestrator=${restartState || "none"}`,
      `transaction=${restartTx || "none"}`,
      `target=${restartTarget || "none"}`,
    );
    await renderRelayReadyBannerFromStatus(status, { force: false }).catch((e) => {
      dbg("render relay banner failed:", e?.message || String(e));
    });
    const requestedMode = String(status?.conversationSessionMode || "").trim().toLowerCase();
    preferredConversationSessionMode = requestedMode || "isolated";
    warnedConversationModeFallback = false;
    await api("POST", "/api/relay/recover-processing", { maxAgeMs: status?.processingTimeoutMs || (10 * 60 * 1000) }).catch(() => {});
    await publishModelSnapshot("relay-active", true);
    startHeartbeat();
    await pulseHeartbeat(`${reason}-initial`);
    restartControlGraceUntilMs = Date.now() + RESTART_CONTROL_STARTUP_GRACE_MS;
    startPolling().catch((error) => {
      dbg("startPolling failed", reason, error?.message || String(error));
    });
    startWorkerWebSocketLink();
    scheduleStartupVerification(reason);
    dbg("relay active", reason);
  })().finally(() => {
    activatingRelay = null;
  });
  return activatingRelay;
}

const extractFinalText = sessionIo.extractFinalText;
const extractGeneratedImages = sessionIo.extractGeneratedImages;
const sendAndWaitWithHardTimeout = sessionIo.sendAndWaitWithHardTimeout;
const sendWithBestEffortStreaming = sessionIo.sendWithBestEffortStreaming;
