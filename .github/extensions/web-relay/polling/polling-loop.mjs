import fs from "fs";
import {
  buildTerminalFailureText,
  isTerminalSendAndWaitError,
  normalizeTerminalSendAndWaitError,
} from "../runtime/send-and-wait-errors.mjs";
import { getActiveSession } from "../runtime/session-registry.mjs";
import { DEFAULT_QUESTION_TIMEOUT_MS } from "../../../../shared/question-timeout.mjs";
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from "../../../../shared/question-timeout.mjs";
import { EMPTY_TURN_COMPLETION_NOTE } from "../../../../shared/empty-turn-completion.mjs";
import { stripPromptContextPrefix } from "../skills/prompt-context.mjs";

function isImageAttachment(att) {
  const type = String(att?.type || "").toLowerCase();
  return type.startsWith("image/");
}

export function classifySwitchingFailure(input = {}) {
  const explicitRetryable = input?.retryable;
  const reason = String(input?.reason || "switch-call-failed").trim() || "switch-call-failed";
  if (typeof explicitRetryable === "boolean") {
    return { reason, retryable: explicitRetryable };
  }
  const nonRetryable = new Set([
    "switch-api-missing",
    "target-session-invalid",
  ]);
  return { reason, retryable: !nonRetryable.has(reason) };
}

export function evaluateSwitchRetry({
  retryable = false,
  attempts = 0,
  maxRetries = 2,
} = {}) {
  const safeAttempts = Math.max(0, Math.trunc(Number(attempts) || 0));
  const safeMaxRetries = Math.max(0, Math.trunc(Number(maxRetries) || 0));
  if (!retryable || safeAttempts >= safeMaxRetries) {
    return {
      shouldRetry: false,
      attempts: Math.min(safeAttempts, safeMaxRetries),
    };
  }
  return {
    shouldRetry: true,
    attempts: safeAttempts + 1,
  };
}

function readImageBlobFromDataUrl(att) {
  const dataUrl = String(att?.dataUrl || "").trim();
  if (!dataUrl.startsWith("data:")) return null;
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) return null;
  const mimeType = String(match[1] || "").trim().toLowerCase();
  const data = String(match[2] || "").trim();
  if (!mimeType.startsWith("image/") || !data) return null;
  return {
    type: "blob",
    data,
    mimeType,
    displayName: String(att?.name || "image"),
  };
}

function readImageBlobFromPath(att) {
  const filePath = String(att?.path || "").trim();
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  const bytes = fs.readFileSync(filePath);
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  const mimeType = String(att?.type || "application/octet-stream").trim().toLowerCase();
  return {
    type: "blob",
    data: bytes.toString("base64"),
    mimeType,
    displayName: String(att?.name || "image"),
  };
}

function normalizeWorkerLivenessIssueReason(reason) {
  const normalized = String(reason || "").trim().toLowerCase();
  if (!normalized) return "worker-unavailable";
  return normalized.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "worker-unavailable";
}

export async function processSdkSessionDeleteRequest({
  request,
  api,
  session,
  dbg = () => {},
  getActiveSessionFn = getActiveSession,
} = {}) {
  const sdkSessionId = String(request?.sdkSessionId || "").trim();
  if (!sdkSessionId) return false;

  if (!session || typeof session.deleteSession !== "function") {
    const errorText = "SDK deleteSession() is unavailable in this CLI runtime";
    dbg("sdk delete unsupported", `session=${sdkSessionId}`);
    await api("POST", "/api/sdk-session-delete/result", {
      sdk_session_id: sdkSessionId,
      conversation_id: request?.conversationId || undefined,
      ok: false,
      unsupported: true,
      error: errorText,
    }).catch(() => {});
    return true;
  }

  let ok = false;
  let errorText = "";
  try {
    const activeSession = getActiveSessionFn();
    const activeSdkSessionId = String(activeSession?.sdkSessionId || "").trim();
    if (activeSdkSessionId && activeSdkSessionId === sdkSessionId) {
      throw new Error("Refusing to delete the currently active SDK session");
    }
    await session.deleteSession(sdkSessionId);
    ok = true;
    await session.log(`🧹 Deleted SDK session ${sdkSessionId.slice(0, 8)} from relay request`, { ephemeral: true });
  } catch (error) {
    errorText = String(error?.message || error || "unknown delete failure").trim() || "unknown delete failure";
    dbg("sdk delete failed", `session=${sdkSessionId}`, errorText);
    await session.log(`⚠️ SDK session delete failed (${sdkSessionId.slice(0, 8)}): ${errorText}`);
  }

  await api("POST", "/api/sdk-session-delete/result", {
    sdk_session_id: sdkSessionId,
    conversation_id: request?.conversationId || undefined,
    ok,
    error: ok ? undefined : errorText,
  }).catch(() => {});
  return true;
}

function buildWorkerLivenessTerminalFailure({ message, ownerSessionId, issueReason, detail = "" } = {}) {
  const reason = normalizeWorkerLivenessIssueReason(issueReason);
  const detailParts = [
    ownerSessionId ? `session=${ownerSessionId}` : null,
    detail ? String(detail).trim() : null,
  ].filter(Boolean);
  return {
    kind: "worker-session-unavailable",
    code: reason,
    stableCode: `relay.${reason}`,
    message: "System note: This session worker stopped responding and the relay marked the turn as unavailable.",
    guidance: "Use ☠️ Kill session from the conversation menu if you want to reset it, then retry or send a new message.",
    detail: detailParts.join(" | ") || null,
    failedAt: new Date().toISOString(),
    requesterSessionId: String(ownerSessionId || "").trim() || null,
    queueMessageId: String(message?.id || "").trim() || null,
  };
}

function buildSdkAttachments(rawAttachments) {
  const input = Array.isArray(rawAttachments) ? rawAttachments : [];
  const sdkAttachments = [];
  for (const att of input) {
    if (!att || typeof att !== "object") continue;

    if (isImageAttachment(att)) {
      const blobFromPath = readImageBlobFromPath(att);
      if (blobFromPath) {
        sdkAttachments.push(blobFromPath);
        continue;
      }
      const blobFromDataUrl = readImageBlobFromDataUrl(att);
      if (blobFromDataUrl) {
        sdkAttachments.push(blobFromDataUrl);
      }
      continue;
    }

    const filePath = String(att?.path || "").trim();
    if (filePath && fs.existsSync(filePath)) {
      sdkAttachments.push({
        type: "file",
        path: filePath,
        displayName: String(att?.name || ""),
      });
    }
  }
  return sdkAttachments;
}

function collectStreamTextCandidates(value, out, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const text = value;
    if (text) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStreamTextCandidates(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  collectStreamTextCandidates(value.text, out, depth + 1);
  collectStreamTextCandidates(value.delta, out, depth + 1);
  collectStreamTextCandidates(value.content, out, depth + 1);
  collectStreamTextCandidates(value.output_text, out, depth + 1);
  collectStreamTextCandidates(value.outputText, out, depth + 1);
  collectStreamTextCandidates(value.message, out, depth + 1);
  collectStreamTextCandidates(value.response, out, depth + 1);
  collectStreamTextCandidates(value.result, out, depth + 1);
  collectStreamTextCandidates(value.output, out, depth + 1);
}

export function extractStreamTextFromEvent(event) {
  const candidates = [];
  collectStreamTextCandidates(event?.data, candidates);
  collectStreamTextCandidates(event, candidates);
  if (!candidates.length) return "";
  const normalized = candidates
    .map((candidate) => String(candidate || ""))
    .filter((candidate) => candidate.length > 0);
  if (!normalized.length) return "";
  normalized.sort((a, b) => b.length - a.length);
  return normalized[0];
}

export function shouldEmitRelayStreamUpdate(nextText, previousText) {
  const next = String(nextText || "");
  const prev = String(previousText || "");
  if (!next) return false;
  if (!prev) return true;
  if (next === prev) return false;
  const delta = next.length - prev.length;
  if (delta >= 24) return true;
  if (delta > 0 && /[\n.!?:)]$/.test(next)) return true;
  if (delta <= 0) return true;
  return false;
}

export function resolveEmptyFinalTextHandling({ lastStreamedSent = "", lastActivityText = "", hasGeneratedImages = false } = {}) {
  const streamed = String(lastStreamedSent || "").trim();
  if (streamed) {
    return { action: "use_stream_text", text: streamed };
  }
  if (hasGeneratedImages) {
    return { action: "publish_generated_images_only", reason: "empty-final-text:generated-images" };
  }
  const activity = String(lastActivityText || "").trim();
  if (activity) {
    // The turn ran tools but produced no prose: a COMPLETED turn, not a
    // failed delivery. Requeueing re-ran work whose emptiness was
    // deterministic until the retry cap failed it (Claude/Cursor parity via
    // the shared completion note).
    return {
      action: "publish_completion_note",
      reason: `empty-final-text:last-activity:${activity.slice(0, 120)}`,
    };
  }
  return {
    action: "requeue",
    reason: "empty-final-text:no-stream-or-text",
  };
}

export function shouldUseDirectOpenAIImageApi(message = {}) {
  const providerType = String(message?.providerType || "").trim().toLowerCase();
  if (providerType !== "openai") return false;
  const model = String(message?.providerModel || message?.model || "").trim().toLowerCase();
  return model.startsWith("gpt-image-") || model.startsWith("dall-e-");
}

function isDirectOpenAIImageTerminalStatus(status) {
  const numeric = Number(status);
  if (!Number.isFinite(numeric)) return false;
  return (
    numeric === 400
    || numeric === 401
    || numeric === 403
    || numeric === 404
    || numeric === 409
    || numeric === 422
    || numeric === 429
    || numeric === 503
  );
}

export async function publishRelayStreamEvent({
  api,
  message,
  text,
  done = false,
  dbg = () => {},
} = {}) {
  const value = String(text || "");
  try {
    await api("POST", "/api/stream", {
      messageId: message?.id,
      conversationId: message?.conversationId,
      mode: message?.relayMode || "agent",
      text: value,
      done: !!done,
    });
    return { ok: true, text: value };
  } catch (streamError) {
    dbg("relay stream publish failed", `msgId=${message?.id || "none"}`, streamError?.message || String(streamError));
    return { ok: false, text: value };
  }
}

function extractToolCallInputObject(value, toolName, depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractToolCallInputObject(item, toolName, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const name = value.name || value.tool || value.function_name || value.toolName || value.tool_name;
  if (String(name || "").trim() === toolName) {
    const input = value.input || value.arguments || value.params || value.args || null;
    if (input && typeof input === "object") return input;
    if (typeof value.arguments === "string") {
      try {
        const parsed = JSON.parse(value.arguments);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {}
    }
  }
  const CONTAINER_KEYS = ["data", "output", "content", "tool_calls", "toolRequests", "calls", "items", "results", "steps", "turns", "messages", "events"];
  for (const key of CONTAINER_KEYS) {
    const child = value[key];
    if (child === undefined || child === null) continue;
    const found = extractToolCallInputObject(child, toolName, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizePlanBoardActions(rawActions, recommendedAction = "") {
  const ids = Array.isArray(rawActions)
    ? rawActions
      .map((entry) => {
        if (typeof entry === "string") return entry.trim().toLowerCase();
        if (entry && typeof entry === "object") {
          return String(entry.id || entry.actionId || entry.value || "").trim().toLowerCase();
        }
        return "";
      })
      .filter(Boolean)
    : [];
  const sourceIds = ids.length ? ids : ["autopilot", "interactive", "exit_only"];
  const seen = new Set();
  const deduped = [];
  for (const id of sourceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  const recommended = String(recommendedAction || "").trim().toLowerCase();
  return {
    actions: deduped.map((id) => {
      if (id === "autopilot_fleet") return { id, label: "Implement with autopilot fleet", mode: "autopilot" };
      if (id === "autopilot") return { id, label: "Implement in autopilot", mode: "autopilot" };
      if (id === "interactive") return { id, label: "Stop here and prompt myself", mode: "agent" };
      if (id === "exit_only") return { id, label: "Stop here", mode: "agent" };
      return { id, label: id.replace(/[_-]+/g, " "), mode: null };
    }),
    recommendedAction: recommended || null,
  };
}

function countPlanLikeLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]\s+|\d+\.\s+)/.test(line))
    .length;
}

export function buildPlanReadyBoardPayload({ finalEvent, message, finalText = "" } = {}) {
  const exitPlanInput = extractToolCallInputObject(finalEvent, "exit_plan_mode");
  const taskCompleteInput = extractToolCallInputObject(finalEvent, "task_complete");
  const toolInput = (exitPlanInput && typeof exitPlanInput === "object")
    ? exitPlanInput
    : ((taskCompleteInput && typeof taskCompleteInput === "object") ? taskCompleteInput : null);
  const fallbackSummary = String(finalText || "").trim();
  const allowPlanModeFallback =
    !toolInput
    && String(message?.relayMode || "").trim().toLowerCase() === "plan"
    && countPlanLikeLines(fallbackSummary) >= 2;
  if (!toolInput && !allowPlanModeFallback) return null;
  const summary = String(
    toolInput?.summary
    || toolInput?.result
    || toolInput?.output
    || toolInput?.message
    || fallbackSummary
    || "",
  ).trim();
  if (!summary) return null;
  const normalized = normalizePlanBoardActions(toolInput?.actions, toolInput?.recommendedAction);
  const source = exitPlanInput
    ? "exit_plan_mode"
    : (taskCompleteInput ? "task_complete" : "plan-mode-fallback");
  return {
    queueId: message?.id,
    messageId: message?.id,
    conversationId: message?.conversationId,
    mode: message?.relayMode || "agent",
    boardType: "plan_ready",
    title: "Plan ready for review",
    body: summary,
    actions: normalized.actions,
    recommendedAction: normalized.recommendedAction,
    context: {
      source,
      queueMessageId: message?.id || null,
      conversationId: message?.conversationId || null,
      relayMode: message?.relayMode || "agent",
    },
  };
}

export function createPollingLoop({
  sleep,
  pollMs,
  api,
  dbg,
  session,
  sendTimeout,
  publishModelSnapshot,
  setModelForMessage,
  buildPromptWithRelayContext,
  sendAndWaitWithHardTimeout,
  sendWithBestEffortStreaming,
  extractFinalText,
  extractGeneratedImages = () => [],
  getLastActivityText,
  getCurrentModelId,
  getPreferredConversationSessionMode,
  getSupportsIsolatedSessions,
  getWarnedConversationModeFallback,
  setWarnedConversationModeFallback,
  getPollingLoopStarted,
  setPollingLoopStarted,
  getSessionReady,
  getWaitingForAI,
  syncActiveSession,
  ensureSessionForConversation,
  setActiveMsg,
  setWaitingForAI,
  setRelayTurnActive,
  setLastActivityText,
  setLastAskUserBridge,
  setPendingAskUserRequest,
  clearRelayScopeState,
  shouldFetchPending = () => true,
  handleControl,
}) {
  let stopRequested = false;
  let lastAbortControlCheckAt = 0;
  let activeTurnMessageId = "";
  let iterationPromise = null;
  const isAutoRequestedModel = (value) => String(value || "").trim().toLowerCase() === "auto";
  const requestedManualModelOrNull = (message) => {
    const requested = String(message?.model || "").trim();
    if (!requested || isAutoRequestedModel(requested)) return null;
    return requested;
  };
  const resolveResponseModel = async (message, { finalEvent = null, unknownForAuto = false } = {}) => {
    const eventModel = String(finalEvent?.data?.model || finalEvent?.data?.modelId || "").trim();
    if (eventModel) return eventModel;
    const currentModel = String(await getCurrentModelId() || "").trim();
    if (currentModel) return currentModel;
    const requestedManualModel = requestedManualModelOrNull(message);
    if (requestedManualModel) return requestedManualModel;
    if (unknownForAuto && isAutoRequestedModel(message?.model)) return "unknown";
    return null;
  };

  async function waitForRelayQuestionAnswer(questionId, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS, pollIntervalMs = 1500) {
    const started = Date.now();
    while (true) {
      const { question } = await api("GET", `/api/relay-question/${questionId}`);
      if (!question) throw new Error("Relay question missing");
      if (question.status === "answered") {
        return {
          answer: String(question.answer || "").trim(),
          structuredAnswer: question.structuredAnswer && typeof question.structuredAnswer === "object"
            ? question.structuredAnswer
            : null,
          timedOut: false,
        };
      }
      if (question.status === "timed_out" || question.status === "cancelled") {
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
          structuredAnswer: null,
          timedOut: true,
        };
      }
      if (Date.now() - started >= timeoutMs) {
        await api("POST", `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return {
          answer: QUESTION_TIMEOUT_CONTINUATION_TEXT,
          structuredAnswer: null,
          timedOut: true,
        };
      }
      await sleep(pollIntervalMs);
    }
  }

  async function processPendingSdkSessionDeletes() {
    const status = await api("GET", "/api/status").catch(() => null);
    if (status?.relayPaused) return false;
    const pending = await api("GET", "/api/sdk-session-delete/pending").catch(() => null);
    const request = pending?.request || null;
    return processSdkSessionDeleteRequest({ request, api, session, dbg });
  }

  async function checkActiveAbortControl(message, { force = false } = {}) {
    const ownerSessionId = String(message?.ownerSessionId || "").trim();
    if (!ownerSessionId || !getWaitingForAI()) return false;
    const now = Date.now();
    if (!force && (now - lastAbortControlCheckAt) < 1200) return false;
    lastAbortControlCheckAt = now;
    const queueMessageId = String(message?.id || "").trim();
    const pending = await api("GET", `/api/control/active?sdkSessionId=${encodeURIComponent(ownerSessionId)}&queueMessageId=${encodeURIComponent(queueMessageId)}`).catch(() => null);
    const control = pending?.control || null;
    const controlType = String(control?.type || "").trim();
    if (!control || !controlType) return false;

    if (controlType === "abort_subagent") {
      const targetRunId = String(control?.request?.subagentRunId || "").trim();
      if (!targetRunId) {
        await api("POST", `/api/control/${encodeURIComponent(control.id)}/result`, {
          ok: false,
          error: "invalid-subagent-control-request",
        }).catch(() => {});
        return false;
      }

      const tryAbortSubagent = async () => {
        if (!session) return { ok: false, error: "SDK session is unavailable in this CLI runtime" };
        const candidates = [
          () => (typeof session.abortSubagentRun === "function" ? session.abortSubagentRun(targetRunId) : null),
          () => (typeof session.abortSubagent === "function" ? session.abortSubagent(targetRunId) : null),
          () => (typeof session.abortAgent === "function" ? session.abortAgent(targetRunId) : null),
          () => (typeof session.abort === "function" && Number(session.abort.length || 0) > 0 ? session.abort({ subagentRunId: targetRunId }) : null),
          () => (typeof session.abort === "function" && Number(session.abort.length || 0) > 0 ? session.abort({ agentId: targetRunId }) : null),
          () => (typeof session.abort === "function" && Number(session.abort.length || 0) > 0 ? session.abort(targetRunId) : null),
        ];
        for (const invoke of candidates) {
          try {
            const result = invoke();
            if (result && typeof result.then === "function") await result;
            else if (result === null) continue;
            return { ok: true };
          } catch (error) {
            const messageText = String(error?.message || error || "subagent abort failed").trim() || "subagent abort failed";
            if (/is not a function/i.test(messageText)) continue;
            return { ok: false, error: messageText };
          }
        }
        return { ok: false, error: "Targeted subagent cancellation is not supported by this runtime." };
      };

      const abortResult = await tryAbortSubagent();
      if (!abortResult.ok) {
        await api("POST", `/api/control/${encodeURIComponent(control.id)}/result`, {
          ok: false,
          error: abortResult.error,
        }).catch(() => {});
        await session?.log?.(`⚠️ Subagent stop request could not be executed (${targetRunId.slice(0, 8)}): ${abortResult.error}`);
        return false;
      }

      await session?.log?.(`⛔ Stop requested for subagent ${targetRunId.slice(0, 8)}`, { ephemeral: true });
      await api("POST", `/api/control/${encodeURIComponent(control.id)}/result`, {
        ok: true,
        note: `targeted subagent abort completed (${targetRunId})`,
      }).catch(() => {});
      return false;
    }

    if (controlType !== "abort_turn") return false;

    if (!session || typeof session.abort !== "function") {
      const error = "SDK abort() is unavailable in this CLI runtime";
      await api("POST", `/api/control/${encodeURIComponent(control.id)}/result`, {
        ok: false,
        error,
      }).catch(() => {});
      await session?.log?.(`⚠️ Stop request could not be executed: ${error}`);
      return false;
    }

    await session.log(`⛔ Stop requested for relay turn ${String(message?.id || "").slice(0, 8)}`, { ephemeral: true });
    await session.abort();
    await api("POST", `/api/control/${encodeURIComponent(control.id)}/result`, {
      ok: true,
      note: "session.abort() completed",
    }).catch(() => {});
    const abortError = new Error("Relay turn aborted by user request");
    abortError.code = "RELAY_TURN_ABORTED";
    abortError.controlId = control.id;
    throw abortError;
  }

  async function handlePendingPayload(pending, source = "poll") {
    const pendingBlockedReason = String(pending?.routing?.blockedReason || "").trim();
    const control = pending?.control || null;
    if (control && typeof handleControl === "function") {
      const handled = await handleControl(control, pending);
      if (handled) return true;
    }
    const { message } = pending || {};

    if (!message) return false;

    activeTurnMessageId = String(message.id || "");
    setActiveMsg(message);
    if (typeof ensureSessionForConversation !== "function") {
      dbg("session routing unavailable for msgId", message.id, "ensureSessionForConversation is not configured");
      await session.log("⚠️ Session routing is unavailable for this turn");
      await api("POST", "/api/response", {
        messageId: message.id,
        conversationId: message.conversationId,
        text: "I couldn't process this turn because session routing is unavailable in the relay runtime. Please retry after the relay extension is fully initialized.",
        model: await resolveResponseModel(message),
      }).catch(async () => {
        await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
      });
      setActiveMsg(null);
      return true;
    }

    const sessionResolution = await ensureSessionForConversation(message.conversationId, source);
    if (sessionResolution && !sessionResolution.ok) {
      const activeSdkSessionId = String(sessionResolution?.activeSessionId || "").trim();
      const targetSdkSessionId = String(sessionResolution?.targetSessionId || "").trim();
      const detail = String(sessionResolution?.message || "").trim();
      const retryable = sessionResolution?.retryable === true;
      dbg(
        "session availability check failed for msgId",
        message.id,
        `reason=${sessionResolution.reason || "unknown"}`,
        `active=${activeSdkSessionId || "none"}`,
        `target=${targetSdkSessionId || "none"}`,
      );
      await session.log(
        detail
          ? `⚠️ Session unavailable for this turn: ${detail}`
          : "⚠️ Session unavailable for this turn",
      );
      if (retryable) {
        await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
      } else {
        await api("POST", "/api/response", {
          messageId: message.id,
          conversationId: message.conversationId,
          text: detail
            ? `System note: I could not process this turn because the bound SDK session is unavailable (${detail}).`
            : "System note: I could not process this turn because the bound SDK session is unavailable.",
          model: await resolveResponseModel(message),
        }).catch(async () => {
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        });
      }
      setActiveMsg(null);
      return true;
    }

    const synced = await syncActiveSession?.(source, true);
    if (!synced) {
      dbg("session sync failed before processing msgId", message.id, "- requeueing");
      await session.log("⚠️ Session sync failed before processing; re-queuing turn");
      await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
      setActiveMsg(null);
      return true;
    }
    setWaitingForAI(true);
    setRelayTurnActive(true, message);
    setLastActivityText("");
    setLastAskUserBridge(null);
    setPendingAskUserRequest?.(null);

    const label = message.isNewConversation ? "new conv" : "existing conv";
    await session.log(`📨 [${label}] Web message (${message.model || "default"}${message.reasoningEffort ? `:${message.reasoningEffort}` : ""} / ${message.relayMode || "agent"}): "${String(message.text || "").slice(0, 80)}"`);
    dbg("session.send: queuing for msgId", message.id, `source=${source}`, pendingBlockedReason ? `blocked=${pendingBlockedReason}` : "");
    let lastStreamedSent = "";
    const pushRelayStream = async (text, done = false) => {
      const value = String(text || "");
      if (!value && !done) return;
      if (!done && value === lastStreamedSent) return;
      const publish = await publishRelayStreamEvent({
        api,
        message,
        text: value,
        done,
        dbg,
      });
      if (!done && publish.ok) lastStreamedSent = value;
    };
    let sendAndWaitStartedAtMs = 0;
    const processDirectOpenAIImageRequest = async () => {
      if (!shouldUseDirectOpenAIImageApi(message)) return false;
      if (message?.imageOperationId) {
        const result = await api(
          "POST",
          `/api/image-operations/${encodeURIComponent(message.imageOperationId)}/execute`,
          { messageId: message.id },
        ).catch((error) => {
          if (error?.status === 409 || error?.status === 503) {
            return error?.payload || { outcome: error?.status === 503 ? "retryable" : "terminal" };
          }
          throw error;
        });
        const outcome = String(result?.outcome || "").trim().toLowerCase();
        if (!["completed", "executing", "terminal", "uncertain", "retryable"].includes(outcome)) {
          throw new Error("Image operation returned an invalid outcome");
        }
        await session.log(`Image operation ${outcome}`, {
          ephemeral: true,
        });
        return true;
      }
      const directModel = String(message?.providerModel || requestedManualModelOrNull(message) || message?.model || "").trim();
      const prompt = String(message?.text || "").trim();
      if (!directModel) throw new Error("OpenAI image request is missing model");
      if (!prompt) throw new Error("OpenAI image request is missing prompt");
      await api("POST", "/api/activity", {
        messageId: message.id,
        conversationId: message.conversationId,
        mode: message.relayMode || "agent",
        text: `Calling OpenAI image API directly (${directModel})`,
      }).catch(() => {});
      let directResult;
      try {
        directResult = await api("POST", "/api/openai/images/generate", {
          messageId: message.id,
          conversationId: message.conversationId,
          model: directModel,
          prompt,
          n: message?.n,
          size: message?.size || message?.contextTier,
          quality: message?.quality || message?.reasoningEffort,
          attachments: Array.isArray(message?.attachments) ? message.attachments : [],
        });
      } catch (error) {
        if (isDirectOpenAIImageTerminalStatus(error?.status)) {
          const terminalError = new Error(
            `OpenAI image request failed: ${error?.detail || `HTTP ${error?.status || "error"}`}`,
          );
          terminalError.code = "RELAY_OPENAI_IMAGE_TERMINAL";
          throw terminalError;
        }
        throw error;
      }
      const generatedImages = Array.isArray(directResult?.generatedImages) ? directResult.generatedImages : [];
      if (!generatedImages.length) {
        throw new Error("OpenAI image API returned no images");
      }
      await api("POST", "/api/response", {
        messageId: message.id,
        conversationId: message.conversationId,
        text: "",
        generatedImages,
        model: String(directResult?.model || directModel).trim() || directModel,
        modelOrigin: isAutoRequestedModel(message?.model) ? "auto" : "manual",
      });
      await session.log(`✅ Sent generated image response (${generatedImages.length} image${generatedImages.length === 1 ? "" : "s"})`, { ephemeral: true });
      return true;
    };

    try {
      const handledWithDirectImageApi = await processDirectOpenAIImageRequest();
      if (handledWithDirectImageApi) return true;

      if (message.model && !isAutoRequestedModel(message.model)) {
        const modelSwitch = await setModelForMessage(message.model, message.contextTier);
        const activeModel = modelSwitch.after || modelSwitch.current || "unknown";
        const switchText = modelSwitch.confirmationPending
          ? `Model switch requested: requested=${message.model} active=pending target=${activeModel} via=${modelSwitch.via || "switchTo"}`
          : modelSwitch.switched
          ? `Model selected: requested=${message.model} active=${activeModel} via=${modelSwitch.via || "switchTo"}`
          : `Model switch failed: requested=${message.model} active=${activeModel}${modelSwitch.error ? ` error=${modelSwitch.error}` : ""}`;
        await publishModelSnapshot("model-switch", true);
        await api("POST", "/api/activity", {
          messageId: message.id,
          conversationId: message.conversationId,
          mode: message.relayMode || "agent",
          text: switchText,
        }).catch(() => {});
        dbg("model switch", switchText);
      } else if (isAutoRequestedModel(message.model)) {
        await api("POST", "/api/activity", {
          messageId: message.id,
          conversationId: message.conversationId,
          mode: message.relayMode || "agent",
          text: "Model selection: Auto routing is active for this new SDK session",
        }).catch(() => {});
      }

      const prompt = await buildPromptWithRelayContext(message);

      const sdkAttachments = buildSdkAttachments(message.attachments);
      const payload = sdkAttachments.length ? { prompt, attachments: sdkAttachments } : { prompt };
      if (message.reasoningEffort && String(message.reasoningEffort || "").trim().toLowerCase() !== "none") {
        payload.reasoningEffort = String(message.reasoningEffort || "").trim();
      }
      if (sdkAttachments.length) {
        const imageCount = sdkAttachments.filter((att) => att.type === "blob").length;
        const fileCount = sdkAttachments.filter((att) => att.type === "file").length;
        dbg("sdk attachments prepared", `msgId=${message.id}`, `total=${sdkAttachments.length}`, `images=${imageCount}`, `files=${fileCount}`);
        await api("POST", "/api/activity", {
          messageId: message.id,
          conversationId: message.conversationId,
          mode: message.relayMode || "agent",
          text: `Attached ${sdkAttachments.length} file(s) to SDK request${imageCount ? ` (images=${imageCount})` : ""}${fileCount ? ` (files=${fileCount})` : ""}.`,
        }).catch(() => {});
      }

      let finalEvent;
      let lastWorkerStatusCheckAt = 0;
      const inspectActiveWorkerLiveness = async () => {
        await checkActiveAbortControl(message, { force: true });
        const ownerSessionId = String(message?.ownerSessionId || "").trim();
        if (!ownerSessionId) return;
        const now = Date.now();
        if ((now - lastWorkerStatusCheckAt) < 10_000) return;
        lastWorkerStatusCheckAt = now;

        const status = await api("GET", "/api/status").catch(() => null);
        const workers = Array.isArray(status?.sessionWorker?.workers) ? status.sessionWorker.workers : [];
        const worker = workers.find((entry) => String(entry?.sdkSessionId || "").trim() === ownerSessionId) || null;
        if (!worker) {
          throw Object.assign(new Error("Active session worker is missing from relay status"), {
            code: "RELAY_WORKER_UNAVAILABLE",
            terminalFailure: buildWorkerLivenessTerminalFailure({
              message,
              ownerSessionId,
              issueReason: "worker-missing",
              detail: "No worker snapshot was reported for the owning session.",
            }),
          });
        }

        const degraded = String(worker?.uiState || "").trim().toLowerCase() === "yellow";
        const degradedReason = String(worker?.degradedReason || "").trim().toLowerCase();
        const routingMismatch = (
          (worker?.conversationId && String(worker.conversationId).trim() !== String(message?.conversationId || "").trim())
          || (message?.runtimeSessionId && worker?.runtimeSessionId && String(worker.runtimeSessionId).trim() !== String(message.runtimeSessionId).trim())
        );
        if (!degraded && !routingMismatch) return;

        const issueReason = routingMismatch
          ? "worker-routing-mismatch"
          : (degradedReason || "worker-degraded");
        const detail = routingMismatch
          ? `workerConversation=${String(worker?.conversationId || "").trim() || "none"} workerRuntime=${String(worker?.runtimeSessionId || "").trim() || "none"}`
          : String(worker?.lastError || worker?.degradedReason || "").trim();
        throw Object.assign(new Error(`Active session worker became unavailable (${issueReason})`), {
          code: "RELAY_WORKER_UNAVAILABLE",
          terminalFailure: buildWorkerLivenessTerminalFailure({
            message,
            ownerSessionId,
            issueReason,
            detail,
          }),
        });
      };
      const sendWithoutStreaming = async (sendPayload) => {
        const turnPromise = Promise.resolve().then(() => sendAndWaitWithHardTimeout(sendPayload, sendTimeout));
        while (true) {
          const outcome = await Promise.race([
            turnPromise.then((value) => ({ done: true, value })),
            sleep(1000).then(() => ({ done: false })),
          ]);
          if (outcome.done) return outcome.value;
          await inspectActiveWorkerLiveness();
        }
      };
      try {
        sendAndWaitStartedAtMs = Date.now();
        finalEvent = await sendWithoutStreaming(payload);
      } catch (attachmentError) {
        if (!sdkAttachments.length) throw attachmentError;
        dbg("sdk attachment delivery failed", `msgId=${message.id}`, attachmentError?.message || String(attachmentError));
        await api("POST", "/api/activity", {
          messageId: message.id,
          conversationId: message.conversationId,
          mode: message.relayMode || "agent",
          text: `Attachment delivery failed (${attachmentError?.message || "unknown error"}). Retrying without SDK attachments.`,
        }).catch(() => {});
        finalEvent = await sendWithoutStreaming({ prompt });
      }
      const sendAndWaitDurationMs = sendAndWaitStartedAtMs > 0 ? Math.max(0, Date.now() - sendAndWaitStartedAtMs) : null;
      dbg("session.sendAndWait: completed for msgId", message.id, sendAndWaitDurationMs ? `durationMs=${sendAndWaitDurationMs}` : "");

      const text = stripPromptContextPrefix(extractFinalText(finalEvent), message, "", prompt);
      const generatedImagePayload = extractGeneratedImages(finalEvent);
      const generatedImages = Array.isArray(generatedImagePayload) ? generatedImagePayload : [];
      const model = await resolveResponseModel(message, { finalEvent, unknownForAuto: true });
      const boardPayload = buildPlanReadyBoardPayload({
        finalEvent,
        message,
        finalText: text,
      });
      if (boardPayload) {
        try {
          await api("POST", "/api/relay-board", boardPayload);
        } catch (boardError) {
          dbg("plan board publish failed", `msgId=${message.id}`, boardError?.message || String(boardError));
        }
      }

      if (!text) {
        const emptyHandling = resolveEmptyFinalTextHandling({
          lastStreamedSent,
          lastActivityText: String(getLastActivityText?.() || ""),
          hasGeneratedImages: generatedImages.length > 0,
        });
        if (emptyHandling.action === "use_stream_text") {
          const streamedText = String(emptyHandling.text || "");
          dbg("sendAndWait returned empty content; finalizing from streamed text msgId", message.id, `len=${streamedText.length}`);
          await session.log("⚠️ Empty final envelope text — using streamed text as final reply");
          await pushRelayStream(streamedText, true);
          await api("POST", "/api/response", {
            messageId: message.id,
            conversationId: message.conversationId,
            text: streamedText,
            generatedImages,
            model,
            modelOrigin: isAutoRequestedModel(message?.model) ? "auto" : "manual",
          });
        } else if (emptyHandling.action === "publish_generated_images_only") {
          dbg("sendAndWait returned empty text but generated images were captured; finalizing msgId", message.id, `images=${generatedImages.length}`);
          await api("POST", "/api/response", {
            messageId: message.id,
            conversationId: message.conversationId,
            text: "",
            generatedImages,
            model,
            modelOrigin: isAutoRequestedModel(message?.model) ? "auto" : "manual",
          });
        } else if (emptyHandling.action === "publish_completion_note") {
          dbg("sendAndWait returned empty content after tool activity; publishing completion note msgId", message.id, emptyHandling.reason || "");
          await api("POST", "/api/response", {
            messageId: message.id,
            conversationId: message.conversationId,
            text: EMPTY_TURN_COMPLETION_NOTE,
            generatedImages,
            model,
            modelOrigin: isAutoRequestedModel(message?.model) ? "auto" : "manual",
          });
        } else {
          dbg("sendAndWait returned empty content; re-queueing msgId", message.id, emptyHandling.reason || "empty-final-text");
          await session.log("⚠️ Empty assistant response envelope — re-queuing instead of sending fallback");
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        }
      } else {
        await pushRelayStream(text || lastStreamedSent, true);
        await api("POST", "/api/response", {
          messageId: message.id,
          conversationId: message.conversationId,
          text,
          generatedImages,
          model,
          modelOrigin: isAutoRequestedModel(message?.model) ? "auto" : "manual",
        });
        await session.log(`✅ Sent response to web (${text.length} chars)`, { ephemeral: true });
      }
    } catch (e) {
      const terminalFailure = normalizeTerminalSendAndWaitError(e);
      dbg(
        "sendAndWait ERROR for msgId",
        message.id,
        ":",
        e.message,
        `terminal=${terminalFailure ? "yes" : "no"}`,
        `stableCode=${terminalFailure?.stableCode || "none"}`,
      );
      if (String(e?.code || "").trim() === "RELAY_TURN_ABORTED") {
        await pushRelayStream(lastStreamedSent, true);
      } else if (isTerminalSendAndWaitError(e)) {
        const failureText = buildTerminalFailureText(e);
        await session.log("❌ Terminal SDK/tool-output error — marking turn failed", { level: "error" }).catch((logError) => {
          dbg("session.log failed while reporting terminal error", message.id, logError?.message || String(logError));
        });
        await pushRelayStream(lastStreamedSent, true);
        await api("POST", "/api/response", {
          messageId: message.id,
          conversationId: message.conversationId,
          text: failureText,
          terminalError: terminalFailure || undefined,
          model: await resolveResponseModel(message, { unknownForAuto: true }),
        }).catch(async (responseError) => {
          dbg("terminal response publish failed for msgId", message.id, responseError?.message || String(responseError));
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        });
      } else if (e?.code === "RELAY_WORKER_UNAVAILABLE" && e?.terminalFailure) {
        await session.log("⚠️ Session worker became unavailable during the turn — marking it failed").catch((logError) => {
          dbg("session.log failed while reporting worker-unavailable", message.id, logError?.message || String(logError));
        });
        await pushRelayStream(lastStreamedSent, true);
        await api("POST", "/api/response", {
          messageId: message.id,
          conversationId: message.conversationId,
          terminalError: e.terminalFailure,
          model: await resolveResponseModel(message, { unknownForAuto: true }),
        }).catch(async () => {
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        });
      } else if (String(e?.code || "").trim() === "RELAY_OPENAI_IMAGE_TERMINAL") {
        await pushRelayStream(lastStreamedSent, true);
        await api("POST", "/api/response", {
          messageId: message.id,
          conversationId: message.conversationId,
          text: String(e?.message || "OpenAI image request failed").trim(),
          model: await resolveResponseModel(message, { unknownForAuto: true }),
        }).catch(async () => {
          await api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
        });
      } else {
        await session.log(`❌ Response failed: ${e.message}; re-queuing`, { level: "error" }).catch((logError) => {
          dbg("session.log failed while reporting generic send error", message.id, logError?.message || String(logError));
        });
        api("POST", "/api/requeue", { messageId: message.id }).catch(() => {});
      }
    } finally {
      setLastActivityText("");
      setPendingAskUserRequest?.(null);
      clearRelayScopeState?.();
      setRelayTurnActive(false, message);
      setActiveMsg(null);
      setWaitingForAI(false);
      activeTurnMessageId = "";
    }
    return true;
  }

  async function runPollingIteration() {
    if (!getSessionReady()) return;
    try {
        await api("POST", "/api/heartbeat", {
          activeQueueMessageId: getWaitingForAI() ? activeTurnMessageId || undefined : undefined,
        });
        await publishModelSnapshot("poll");

        if (getWaitingForAI()) return;
        // Keep SDK-session-delete maintenance best-effort only; never starve
        // user turn dequeue when delete requests are backlogged/retrying.
        await processPendingSdkSessionDeletes();
        if (!shouldFetchPending()) return;

        const pending = await api("GET", "/api/pending");
        await handlePendingPayload(pending, "poll");
    } catch (error) {
      dbg("runPollingIteration failed", error?.message || String(error));
      // Server may be down — keep retrying silently
    }
  }

  async function runPollingIterationSerialized() {
    if (iterationPromise) return iterationPromise;
    iterationPromise = Promise.resolve()
      .then(() => runPollingIteration())
      .finally(() => {
        iterationPromise = null;
      });
    return iterationPromise;
  }

  async function startPolling() {
    if (getPollingLoopStarted()) return;
    setPollingLoopStarted(true);
    stopRequested = false;
    dbg("startPolling: entered");
    await session.log("🔄 Polling started", { ephemeral: true });

    while (!stopRequested) {
      await sleep(pollMs);
      if (stopRequested) break;
      await runPollingIterationSerialized();
    }

    setPollingLoopStarted(false);
    dbg("startPolling: exited");
  }

  async function kick() {
    if (stopRequested || !getPollingLoopStarted()) return false;
    await runPollingIterationSerialized();
    return true;
  }

  function stopPolling() {
    stopRequested = true;
  }

  return {
    handlePendingPayload,
    startPolling,
    kick,
    stopPolling,
  };
}
