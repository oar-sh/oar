'use strict';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { resolveUploadMimeType } from '../services/mime-sniffer.mjs';
import { fileVersionToken, serveFileWithRangeSupport, withFileVersion } from '../services/file-serving.mjs';
import { FILE_CAPABILITY_REQUEST_KEY, withFileCapability } from '../services/file-capability.mjs';
import { registerMediaRoutes } from './media-routes.mjs';
import {
  AUTO_MODEL_SENTINEL,
  CLAUDE_API_CAP_STOP_SOURCE,
  OPAQUE_RESPONSE_RECOVERY_POLL_MS,
  OPAQUE_RESPONSE_RECOVERY_WAIT_MS,
  buildTerminalFailureTextForChat,
  deriveModelOrigin,
  normalizeSessionWorkerId,
  resolveGeneratedImageReadPath,
} from './messages-helpers.mjs';
import { registerGeneratedImageContentRoute, registerMessagesImageRoutes } from './messages-image-routes.mjs';
import { createFailQueueMessage } from './messages-queue-failure.mjs';
import { registerMessagesWorkerReportRoutes } from './messages-worker-report-routes.mjs';
import { registerMessagesWorkerClaimRoutes, registerMessagesWorkerRequeueRoute } from './messages-worker-claim-routes.mjs';
import { registerMessagesWorkerOutputRoutes } from './messages-worker-output-routes.mjs';
import { registerMessagesIntakeRoutes } from './messages-intake-routes.mjs';
import { validateEntryName } from '../services/explorer-entry-name.mjs';
import { countEntries, createDirectory, removeEntry, renameEntry } from '../services/explorer-mutations.mjs';
import { killTmuxSession } from '../services/session-worker-launch-service.mjs';
import {
  buildSteerSettleFailure,
  steerAgentLabelForProvider,
  STEER_SETTLE_FAILED_CODE,
  STEER_SETTLE_FAILED_STABLE_CODE,
} from '../../shared/steer-settle-failure.mjs';
import { buildRelayStopFailure } from '../../shared/relay-stop-failure.mjs';
import { stopSessionWorkerProcesses } from '../services/session-worker-stop-service.mjs';
import { sanitizeSubagentRunId } from '../../shared/subagent-run-id.mjs';
import { DEFAULT_TASK_STALL_MINUTES } from '../../shared/task-output-text.mjs';
import { readBefore, readTail, shapeSnapshot, taskOutputSource } from '../services/task-output-service.mjs';
import { taskKindOf } from '../services/session-activity-tracker.mjs';
import { createOpenAIImagePreviewTurns } from '../services/openai-image-preview-turns.mjs';
import {
  OPENAI_IMAGE_CAP_WARN_RATIO,
} from '../../shared/openai-image-spend.mjs';
import { createOpenAIImageSpendService } from '../services/openai-image-spend-service.mjs';
import {
  createSubagentTimelineService,
  mapSubagentRunHeader,
  TIMELINE_READ_DEFAULT_LIMIT,
} from '../services/subagent-timeline-service.mjs';
import { createStaleAttemptLogLimiter } from '../services/stale-attempt-log-limiter.mjs';
import { createLocalRequestCheck, isCliOverLoopback } from '../services/request-boundary.mjs';
import { TASK_OUTPUT_NONE_MESSAGES } from '../public/app/task-console-render.mjs';
import { createClaudeApiStopNoteLedger } from '../services/plan-usage-claude-api.mjs';
import { notPerson, principalLabel, principalOf } from '../services/relay-principal.mjs';
import { AUTH_ERROR_CODES, AUTH_FILE_CAPABILITY_MESSAGE, FILE_PROTECTED_MESSAGE } from '../../shared/relay-route-policy.mjs';
import {
  admitRemoteRelayRequest,
  readRemoteRelayRequest,
} from '../services/remote-relay-inbound.mjs';

export {
  SESSION_WORKER_OWNER_LEASE_MS,
  buildTerminalFailureTextForChat,
  parseTerminalFailureText,
  resolveTerminalFailurePayload,
} from './messages-helpers.mjs';
export { buildHeartbeatIdleReplayFailure, shouldFailRecoveredProcessingRow } from './messages-worker-report-routes.mjs';
export {
  SESSION_WORKER_TRANSIENT_DEQUEUE_BACKOFF_MS,
  SESSION_WORKER_TRANSIENT_DEQUEUE_RETRIES,
  TRANSIENT_REQUEUE_MAX_PROCESSING_MS,
  buildDequeuedRelayMessage,
  claudeBillingFence,
  crossesPlanBoundaryOfLiveTurn,
  dequeuePendingMessage,
  dequeuePendingMessageForWorkerLoop,
  isTransientRequeue,
} from './messages-worker-claim-routes.mjs';
export {
  buildClaudeApiStopNoteText,
  claudeApiRemedyText,
  cleanupPersistedGeneratedImagesForAssistantResponse,
  normalizeGeneratedImageResponses,
  persistGeneratedImagesForAssistantResponse,
  resolveExecutedProviderForResponse,
  resolveResponderConversationMismatch,
  sanitizeActivityMetadata,
  sanitizeWorkflowProgress,
  shouldAcceptAssistantResponsePayload,
  validateSubagentRunBinding,
} from './messages-worker-output-routes.mjs';
export {
  resolveInitialQueueOwnerSessionId,
  resolveOpenAIReasoningEffort,
  shouldRequireNewOpenAIConversation,
} from './messages-intake-routes.mjs';

// Hold finalization after a relay question is answered so the SDK has time to fire the next
// onUserInputRequest (multi-step ask_user). Without this, the transcript is used prematurely and
// the queue row is marked done while additional questions are still pending.
const RELAY_QUESTION_FINALIZATION_HOLD_MS = 5_000;
// Preview kinds whose bytes travel in the preview JSON; media and PDF are
// fetched by the browser from the raw URL instead.
const TEXT_PREVIEW_KINDS = new Set(['markdown', 'code', 'text']);
// An upload's URL names its bytes (the sha256), so a kept answer stays right.
const UPLOAD_CONTENT_CACHE_CONTROL = 'private, max-age=31536000, immutable';

// The path a `{*splat}` route matched: express 5 hands it over as its
// decoded segments, or not at all when the path ends at the slash.
export function splatPath(req) {
  const splat = req.params?.splat;
  return Array.isArray(splat) ? splat.join('/') : String(splat || '');
}

function isAutoModel(model) {
  return String(model || '').trim().toLowerCase() === AUTO_MODEL_SENTINEL;
}

function normalizeTelemetryText(value, fallback = 'none') {
  const text = String(value || '').trim();
  return text || fallback;
}

function toTelemetryRetry(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

function toTelemetryPid(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const pid = Math.trunc(numeric);
  return pid > 0 ? pid : null;
}

function toTelemetryQueueField(queue = null) {
  if (!queue || typeof queue !== 'object') return 'pending=0,processing=0,parked=0';
  const pending = toTelemetryRetry(queue.pendingCount);
  const processing = toTelemetryRetry(queue.processingCount);
  const parked = toTelemetryRetry(queue.parkedCount);
  return `pending=${pending},processing=${processing},parked=${parked}`;
}

export function buildSessionWorkerLogEnvelope({
  event = 'session-worker-event',
  worker = null,
  session = null,
  conversation = null,
  message = null,
  continuation = null,
  state = null,
  queue = null,
  retry = 0,
  pid = null,
} = {}) {
  return {
    event: normalizeTelemetryText(event, 'session-worker-event'),
    worker: normalizeTelemetryText(worker),
    session: normalizeTelemetryText(session),
    conversation: normalizeTelemetryText(conversation),
    message: normalizeTelemetryText(message),
    continuation: normalizeTelemetryText(continuation),
    state: normalizeTelemetryText(state, 'unknown'),
    queue: normalizeTelemetryText(queue, toTelemetryQueueField(null)),
    retry: toTelemetryRetry(retry),
    pid: toTelemetryPid(pid),
  };
}

export function registerMessagesRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    pushDispatchService,
    runtimeState,
    uuidv4,
    ts,
    MAX_UPLOAD_BYTES,
    uploadsDir,
    uploadReadDirs = [uploadsDir],
    // What a send's `imagePaths` never reads, beside the upload dirs: the
    // relay's data dir (`dirs`), its database and config files (`files`).
    imageInputDenyPaths = { dirs: [], files: [] },
    // File capabilities (`k`, services/file-capability.mjs): `{ mint, verify }`.
    fileCapabilities = null,
    // `(rawPath, rootPath) => absolute path | null`: the path GET /api/files/*
    // is asked for, normalized as a string (no link resolved, nothing read);
    // what a file capability is checked against.
    resolveWorkspaceFileTargetPath = () => null,
    // The platform the file-by-path and explorer-change routes serve paths of.
    filePlatform = process.platform,
    // Media tags (`t`, services/media-tag.mjs): what opens GET /api/media/:id/content.
    mediaTags = undefined,
    // `{ isProtected, touchesProtected }` (services/relay-protected-files.mjs):
    // the relay's secrets, database and config, never served, changed,
    // moved or deleted (nor a folder holding them).
    protectedRelayFiles = null,
    MAX_REPO_TREE_NODES,
    MAX_IMAGE_DATA_URL_LENGTH,
    MAX_WORKSPACE_PREVIEW_BYTES,
    MAX_REFERENCE_IMAGE_ATTACHMENT_BYTES,
    remotePath,
    parseBooleanQueryFlag,
    fetchBrowsableDrives,
    fetchWorkspaceDirectoryEntries,
    fetchDriveDirectoryEntries,
    mapDriveDirectoryEntry,
    driveDisplayName,
    normalizeDriveAbsolutePath,
    driveRootFromAbsolutePath,
    toDriveWebPath,
    normalizeLinuxAbsolutePath,
    fetchLinuxDirectoryEntries,
    mapLinuxDirectoryEntry,
    readWorkspaceFileMeta,
    // The cache readWorkspaceFileMeta fills. The routes drop an entry when a
    // read shows it is out of date; the name was used here without ever
    // being handed in, so each of those paths threw a ReferenceError.
    workspaceFileMetaCache,
    resolveWorkspaceFilePath,
    normalizeWorkspaceRelativePath,
    previewLanguageForWorkspaceFile,
    readWorkspaceFilePreviewBuffer,
    isLikelyBinaryPreviewBuffer,
    isLikelyTextContentType,
    workspacePreviewKindForMeta,
    workspaceContentType,
    persistUploadBuffer,
    isSha256,
    uploadPathForSha,
    uploadContentUrlForSha,
    resolveConversationWorkspaceState,
    queueCounts,
    getModelCatalogState,
    buildRelayReadyBannerData,
    backgroundTaskStore,
    backgroundWorkView = null,
    // The 8 KiB a worker posts for a task without an output file
    // (services/task-output-service.mjs createTaskOutputSnapshots).
    taskOutputSnapshots = null,
    // Has the health poller read soon (a task with a console ended).
    pokeTaskHealth = null,
    // What a recovery did with a turn that was running when the relay
    // started (services/restart-resume-service.mjs noteOutcome).
    noteRestartTurnOutcome = () => {},
    getTaskStallMinutes = () => DEFAULT_TASK_STALL_MINUTES,
    sendWorkerControl,
    resolveRequestedReasoningEffort = () => ({ ok: false, error: 'Reasoning metadata unavailable', supported: [] }),
    getOpenAIProviderSettings = () => ({ enabled: false, model: '' }),
    getClaudeProviderSettings = () => ({ enabled: false, model: '', models: [] }),
    getCursorProviderSettings = () => ({ enabled: false, model: '', models: [] }),
    getGrokProviderSettings = () => ({ enabled: false, model: '', models: [] }),
    getClaudeCloudProviderSettings = () => ({ enabled: false, defaultModel: '', environmentId: '', models: [] }),
    getDeepSeekProviderSettings = () => ({ enabled: false, model: '', models: [] }),
    getClaudeApiProviderSettings = () => ({ enabled: false, model: '', models: [], availableModels: [], effortsByModel: {} }),
    rebindUnstartedOpenAIConversationModel = null,
    normalizeRelayMode,
    DEFAULT_RELAY_MODE,
    DEFAULT_MODEL,
    relayThoughtsForQueueMessage,
    inFlightStateForConversation,
    // Resolves the live turn among a conversation's processing rows (mid-turn
    // steering can leave more than one). Falls back to the newest-processing
    // query for older wiring/tests that do not supply it.
    resolveLiveTurnQueueRow = (conversationId) => stmts.getLatestProcessingQueueByConversation.get(conversationId) || null,
    requestRelayShutdown,
    cancelRelayShutdown = null,
    // Truly local = loopback peer, no tunnel marker, no forwarding header
    // (services/request-boundary.mjs). The runtime passes the check built
    // with the configured marker headers.
    isTrulyLocalRequest = createLocalRequestCheck().isTrulyLocal,
    // How long the partial previews of an image request that ended wait for
    // the turn's end (services/openai-image-preview-turns.mjs).
    openAIImagePreviewLeftoverMs,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
    sessionWorkerProcessInspector,
    // Seams for stopSessionWorkerProcesses (platform, killImpl, isPidAliveImpl,
    // killTmuxSessionImpl). Tests must inject these instead of relying on the
    // host OS, so the suite behaves identically on Windows and POSIX.
    sessionWorkerStopOverrides = null,
    // The replacement fence (services/worker-replacement.mjs): a worker
    // process the recycle is replacing is handed no work by /api/pending.
    workerReplacementFence = null,
    resolveSessionStateRoot,
    fetchUsageSummary = null,
    planUsageService = null,
    usageLimitPauseService = null,
    // The Claude billing switch (claude-billing-switch-service.mjs): the
    // billing route, and the send-path guards that refuse a switch by send.
    claudeBillingSwitchService = null,
    // The Claude API booking (claude-api-usage-service.mjs).
    claudeApiUsageService = null,
    // Tokens per turn for every provider (token-usage-service.mjs).
    tokenUsageService = null,
    // OpenAI image spend and its daily cap (openai-image-spend-service.mjs):
    // the runtime shares one instance with the settings routes. Without it
    // (tests) the routes make their own over tokenUsageService.
    openAIImageSpend = null,
    // The delivery fence's runtime half for GET /api/pending, as on the
    // socket: the Claude API claim check (null: no refusal) and what a fenced
    // row does (the swap, or fail closed).
    claudeApiClaimCheck = null,
    onClaudeBillingFence = null,
    // Whether every worker of this relay says its kind; a function.
    workersStateTheirKind = null,
    // The Claude API monthly cap's one seam (`{ reached, error? }`; a throw
    // counts as reached): an agent's send to a chat on the key is refused
    // while it is reached. Absent in older wiring and most tests: no cap.
    getClaudeApiCapState = () => ({ reached: false }),
    // Asks whether the cap flipped after a booked report (the runtime then
    // re-announces the Claude chats' billing states). A no-op without it.
    checkClaudeApiCap = () => {},
    // The notes for self-started turns stopped on the key, once per chat per
    // episode (plan-usage-claude-api.mjs); the runtime shares its own, which
    // the cap watch and the settings route clear.
    claudeApiStopLedger = createClaudeApiStopNoteLedger(),
    getCursorPlanAllowanceSettings = () => ({ cursorModelsUsd: null, otherModelsUsd: null, resetDay: 1 }),
    getGrokPlanAllowanceSettings = () => ({ monthlyUsd: null, resetDay: 1 }),
    opaqueResponseRecoveryWaitMs = OPAQUE_RESPONSE_RECOVERY_WAIT_MS,
    opaqueResponseRecoveryPollMs = OPAQUE_RESPONSE_RECOVERY_POLL_MS,
    relayQuestionFinalizationHoldMs = RELAY_QUESTION_FINALIZATION_HOLD_MS,
    imageOperationService = null,
    // Remote relays (server/services/remote-relay-inbound.mjs): origin on
    // agent-sent messages, the inbound switch, and mention unlocks. Absent in
    // older wiring and most tests, where every remote-relay step is a no-op.
    remoteRelayInbound = null,
    // Session groups (repositories/conversation-group-repository.mjs): the
    // group stop route. Absent in older wiring and most tests.
    conversationGroups = null,
    // Relay event subscriptions (services/relay-event-service.mjs) and the
    // per-session activity they read (services/session-activity-tracker.mjs).
    // Absent in older wiring and most tests: every hook is then a no-op.
    relayEventService = null,
    sessionActivityTracker = null,
    // A worker's SDK session id or a conversation id → the conversation row.
    resolveConversationRecord = null,
    // DeepSeek's Claude Code config directory, which the relay owns: each CLI
    // start a DeepSeek worker reports is recorded there for the delete
    // (claude-session-leftovers.mjs).
    deepseekClaudeConfigDir = '',
  } = deps;

  // An app_settings value as text ('' when unset or unreadable).
  const readAppSettingText = (key) => {
    try {
      return String(stmts?.getAppSetting?.get?.(key)?.value ?? '').trim();
    } catch {
      return '';
    }
  };
  // OpenAI image spend: the cap check and reservation before each try, its
  // booking after, the send-time refusal and the spend state.
  const imageSpend = openAIImageSpend || createOpenAIImageSpendService({
    tokenUsageService,
    readSetting: readAppSettingText,
    db,
    emit: (event, payload) => io?.emit?.(event, payload),
    logger: console,
  });

  // ─── Sub-agent runs: header, timeline, live events ─────────────────────────
  const subagentTimeline = createSubagentTimelineService({ db, stmts });

  // The live background task a run belongs to (the panel's row), if any: the
  // task's spawning tool_use id is the run id.
  function liveTaskForSubagentRun(run) {
    const tasks = backgroundTaskStore?.get?.(run?.conversation_id) || [];
    const runId = String(run?.id || '');
    const taskId = String(run?.task_id || '');
    return tasks.find((task) => (task?.toolUseId && task.toolUseId === runId) || (taskId && task?.taskId === taskId)) || null;
  }

  // Stop is offered while a run is running: a background run through its
  // task, a foreground run through the sub-agent cancel route.
  function isSubagentRunStoppable(run) {
    if (String(run?.status || '') !== 'running') return false;
    const task = liveTaskForSubagentRun(run);
    if (task) return task.stoppable !== false;
    return Number(run?.background || 0) !== 1;
  }

  // Every subagent_status event carries the whole header and the run's own
  // turn, so a client can place it without having seen the run before.
  function subagentStatusEvent(run, extra = {}) {
    const header = mapSubagentRunHeader(run, { stoppable: isSubagentRunStoppable(run) });
    if (!header) return null;
    return { ...header, timestamp: new Date().toISOString(), ...extra };
  }

  function emitSubagentStatus(run, extra = {}) {
    const event = subagentStatusEvent(run, extra);
    if (event) io.emit('subagent_status', event);
    try { sessionActivityTracker?.noteSubagentRun?.(run); } catch {}
  }

  // The identity a worker sends with each request: null when it names
  // neither a pid nor a session.
  function readBridgeIdentity(req) {
    const positiveInt = (value) => {
      const num = Number.parseInt(String(value || ''), 10);
      return Number.isInteger(num) && num > 0 ? num : null;
    };
    const text = (value) => String(value || '').trim() || null;
    const identity = {
      pid: positiveInt(req.headers['x-relay-process-pid']),
      parentPid: positiveInt(req.headers['x-relay-parent-pid']),
      sessionId: text(req.headers['x-relay-session-id']),
      conversationId: text(req.headers['x-relay-conversation-id']),
    };
    return identity.pid || identity.sessionId ? identity : null;
  }

  function resolveConversationWorkspaceScope(req) {
    const conversationId = String(
      req?.query?.conversationId
      || req?.query?.conversation_id
      || req?.headers?.['x-conversation-id']
      || '',
    ).trim();
    const sdkSessionId = String(
      req?.query?.sdkSessionId
      || req?.query?.sdk_session_id
      || req?.headers?.['x-sdk-session-id']
      || '',
    ).trim();
    if (!conversationId && !sdkSessionId) return null;
    return { conversationId, sdkSessionId };
  }

  function resolveScopedWorkspaceRootPath(req) {
    if (typeof resolveConversationWorkspaceState !== 'function') return null;
    const scope = resolveConversationWorkspaceScope(req);
    if (!scope) return null;
    const state = resolveConversationWorkspaceState(scope);
    const rootPath = String(state?.currentWorkspaceRootPath || '').trim();
    return rootPath || null;
  }

  function scopedWorkspaceQuerySuffix(req) {
    const scope = resolveConversationWorkspaceScope(req);
    if (!scope) return '';
    const params = new URLSearchParams();
    if (scope.conversationId) params.set('conversationId', scope.conversationId);
    if (scope.sdkSessionId) params.set('sdkSessionId', scope.sdkSessionId);
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  function emitSessionWorkerTelemetry(event, {
    sessionId = null,
    workerId = null,
    conversationId = null,
    messageId = null,
    continuationId = null,
    state = null,
    retry = 0,
    pid = null,
    queue = null,
    level = 'log',
    extra = null,
  } = {}) {
    const envelope = buildSessionWorkerLogEnvelope({
      event,
      worker: workerId,
      session: sessionId,
      conversation: conversationId,
      message: messageId,
      continuation: continuationId,
      state,
      queue: queue ? toTelemetryQueueField(queue) : toTelemetryQueueField(queueCounts?.() || null),
      retry,
      pid,
    });
    const payload = extra && typeof extra === 'object'
      ? { ...envelope, ...extra }
      : envelope;
    const method = typeof console[level] === 'function' ? level : 'log';
    console[method](`[${ts()}] WORKER    ${JSON.stringify(payload)}`);
  }

  function normalizeBindingValue(value) {
    const text = String(value || '').trim();
    return text || null;
  }

  function getConversationSessionState(conversationId) {
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      return { ok: false, status: 400, error: 'Missing conversationId' };
    }
    const conversation = stmts.getConvAnyStatus.get(normalizedConversationId) || null;
    if (!conversation || String(conversation.status || '').trim() === 'deleted') {
      return { ok: false, status: 404, error: 'Conversation not found' };
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(normalizedConversationId) || null;
    const runtimeSessionBySdkSessionId = conversation?.sdk_session_id && stmts.getRuntimeSessionBySdkSessionId
      ? (stmts.getRuntimeSessionBySdkSessionId.get(String(conversation.sdk_session_id).trim()) || null)
      : null;
    const conversationSdkSessionId = normalizeBindingValue(conversation.sdk_session_id);
    const runtimeSessionSdkSessionId = normalizeBindingValue(runtimeSession?.sdk_session_id);
    return {
      ok: true,
      conversation,
      runtimeSession,
      runtimeSessionBySdkSessionId,
      conversationSdkSessionId,
      runtimeSessionSdkSessionId,
    };
  }

  // One warning per superseded attempt: a worker streaming for a requeued
  // row writes several times a second until it learns of the refusal.
  const staleAttemptLog = createStaleAttemptLogLimiter({ warn: (line) => console.warn(`[${ts()}] ${line}`) });

  function rejectSessionBinding(res, status, error, extra = {}) {
    return res.status(status).json({ error, ...extra });
  }

  function reconcileSubagentRunsForTerminalTurn(messageId, { status = 'failed' } = {}) {
    // A background run outlives the turn that spawned it: its worker reports
    // its end (task_notification), and a dead worker's runs are closed by the
    // worker-death sweep. Closing it here marked live agents failed.
    const running = (stmts.listRunningSubagentRunsByQueueMessage?.all?.(messageId) || [])
      .filter((run) => Number(run.background || 0) !== 1 && !liveTaskForSubagentRun(run));
    if (!running.length) return 0;
    const now = new Date().toISOString();
    for (const run of running) {
      stmts.updateSubagentRunStatus?.run?.(status, now, now, run.id);
      const closed = stmts.getSubagentRun?.get?.(run.id) || { ...run, status, completed_at: now };
      // messageId is the run's own turn: the browser drops a status event it
      // cannot place, which left these runs showing "running" until a reload.
      emitSubagentStatus(closed, { queueMessageId: messageId, reconciled: true });
    }
    return running.length;
  }

  const failQueueMessage = createFailQueueMessage({
    db,
    stmts,
    io,
    uuidv4,
    pushDispatchService,
    relayEventService,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
    queueCounts,
    reconcileSubagentRunsForTerminalTurn,
    cancelPendingRelayQuestionsForMessage,
    emitSessionWorkerTelemetry,
  });

  // Cancels question cards left behind by a superseded processing attempt.
  // Questions carry the attempt_id of the row state they were created under,
  // so "stale" is exact: any pending card whose attempt differs from the
  // attempt the row currently records. Cards belonging to that attempt stay
  // pending — an answer may still be on its way in. A row with NO current
  // attempt (finalized by a legacy responder after a requeue cleared it) makes
  // every attempt-stamped card stale: the empty string matches none of them.
  // The name the steer-settle wording uses for the runtime that took the
  // prompt, from the conversation's provider type (the shared mapping the
  // server runtime's recovery path uses too).
  function steerSettleAgentLabelForConversation(conversationId) {
    const id = String(conversationId || '').trim();
    if (!id) return undefined;
    return steerAgentLabelForProvider(stmts.getRuntimeSessionByConversation?.get?.(id)?.provider_type);
  }

  /**
   * Terminal failure for a row whose prompt the worker's runtime already
   * consumed — a folded or stopped steer whose settle never landed.
   * At-most-once: every path that would requeue such a row comes here instead,
   * since re-delivery would run the prompt a second time. `terminalError` lets
   * a worker supply the path-accurate wording; the default is the fold wording.
   */
  function failConsumedQueueRow(queueRow, { reason = 'recovery', terminalError = null, attemptId = null } = {}) {
    const agentLabel = steerSettleAgentLabelForConversation(queueRow?.conversation_id);
    const failure = terminalError && typeof terminalError === 'object'
      ? { ...buildSteerSettleFailure(queueRow, { agentLabel }), ...terminalError }
      : buildSteerSettleFailure(queueRow, { agentLabel });
    const failed = failQueueMessage({
      queueRow,
      messageId: queueRow.id,
      conversationId: queueRow.conversation_id,
      relayMode: normalizeRelayMode(queueRow.relay_mode) || DEFAULT_RELAY_MODE,
      model: queueRow.model || null,
      responseText: buildTerminalFailureTextForChat(failure),
      failureRecord: {
        ...failure,
        kind: 'terminal',
        error: 'terminal-error',
        reason: String(reason || 'recovery'),
        retryCount: Number(queueRow?.retry_count || 0),
      },
      markWorkerError: false,
      attemptId,
    });
    if (failed) {
      settleRelayAbortControlsForQueueMessage(queueRow.id, { ok: false, error: STEER_SETTLE_FAILED_CODE });
      settleRelaySubagentAbortControlsForQueueMessage(queueRow.id, { ok: false, error: STEER_SETTLE_FAILED_CODE });
      console.warn(`[${ts()}] FAILED    ${String(queueRow.id).slice(0, 8)} reason=${reason} code=${STEER_SETTLE_FAILED_STABLE_CODE} (consumed; never re-run)`);
    }
    return failed;
  }

  function normalizeConsumedSteerEntries(raw) {
    const seen = new Set();
    return (Array.isArray(raw) ? raw : [])
      .map((entry) => (entry && typeof entry === 'object'
        ? { id: String(entry.id || '').trim(), attemptId: String(entry.attemptId || '').trim() || null }
        : { id: String(entry || '').trim(), attemptId: null }))
      .filter((entry) => {
        if (!entry.id || seen.has(entry.id)) return false;
        seen.add(entry.id);
        return true;
      })
      .slice(0, 100);
  }

  function cancelPendingRelayQuestionsForMessage(messageId) {
    const targetMessageId = String(messageId || '').trim();
    if (!targetMessageId || typeof stmts.cancelPendingQuestionsForStaleAttempts?.all !== 'function') return 0;
    const queueRow = stmts.findQById?.get(targetMessageId) || null;
    const currentAttemptId = String(queueRow?.attempt_id || '').trim();
    const now = new Date().toISOString();
    const cancelledRows = stmts.cancelPendingQuestionsForStaleAttempts.all(now, targetMessageId, currentAttemptId);
    for (const row of cancelledRows) {
      const updated = stmts.getQuestion?.get(row.id) || null;
      if (updated && typeof deps.formatQuestionRow === 'function') {
        io.emit('relay_question_updated', { question: deps.formatQuestionRow(updated) });
      }
    }
    return cancelledRows.length;
  }

  const findProcessingOwnedBySession = db.prepare(`
    SELECT *
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status = 'processing'
    ORDER BY COALESCE(processing_at, timestamp) DESC, timestamp DESC
    LIMIT 1
  `);
  const findAllProcessingOwnedBySession = db.prepare(`
    SELECT *
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status = 'processing'
    ORDER BY COALESCE(processing_at, timestamp) DESC, timestamp DESC
  `);
  const findAllNonProcessingOwnedBySession = db.prepare(`
    SELECT id, conversation_id, status
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status IN ('pending', 'parked')
    ORDER BY timestamp ASC
  `);
  const clearNonProcessingOwnedBySession = db.prepare(`
    UPDATE queue
    SET owner_sdk_session_id = NULL,
        owner_assigned_at = NULL,
        owner_lease_expires_at = NULL,
        owner_last_claimed_at = NULL
    WHERE owner_sdk_session_id = ?
      AND status IN ('pending', 'parked')
  `);
  const findMostRecentConversationForSession = db.prepare(`
    SELECT conversation_id
    FROM queue
    WHERE owner_sdk_session_id = ?
    ORDER BY COALESCE(processing_at, timestamp) DESC, timestamp DESC
    LIMIT 1
  `);
  const findActiveRelayControlByQueueMessage = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE queue_message_id = ?
      AND type = ?
      AND status IN ('pending', 'processing')
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const findActiveRelaySubagentControlByRunId = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE queue_message_id = ?
      AND type = 'abort_subagent'
      AND status IN ('pending', 'processing')
      AND json_extract(request, '$.subagentRunId') = ?
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const insertRelayControlRequest = db.prepare(`
    INSERT INTO relay_control_requests (
      id,
      type,
      conversation_id,
      queue_message_id,
      sdk_session_id,
      status,
      request,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `);
  const findPendingRelayControlForSession = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE sdk_session_id = ?
      AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const findPendingRelayControlForSessionAndMessage = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE sdk_session_id = ?
      AND queue_message_id = ?
      AND status = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const claimRelayControlRequest = db.prepare(`
    UPDATE relay_control_requests
    SET status = 'processing', updated_at = ?
    WHERE id = ?
      AND status = 'pending'
  `);
  const getRelayControlRequestById = db.prepare(`
    SELECT *
    FROM relay_control_requests
    WHERE id = ?
    LIMIT 1
  `);
  const completeRelayControlRequest = db.prepare(`
    UPDATE relay_control_requests
    SET status = 'done',
        result = ?,
        error = NULL,
        updated_at = ?,
        completed_at = ?
    WHERE id = ?
      AND status IN ('pending', 'processing')
  `);
  const failRelayControlRequest = db.prepare(`
    UPDATE relay_control_requests
    SET status = 'failed',
        error = ?,
        updated_at = ?,
        completed_at = ?
    WHERE id = ?
      AND status IN ('pending', 'processing')
  `);
  const settleRelayControlsForQueueMessage = db.prepare(`
    UPDATE relay_control_requests
    SET status = ?,
        result = ?,
        error = ?,
        updated_at = ?,
        completed_at = ?
    WHERE queue_message_id = ?
      AND type = 'abort_turn'
      AND status IN ('pending', 'processing')
  `);
  const settleRelaySubagentControlsForQueueMessage = db.prepare(`
    UPDATE relay_control_requests
    SET status = ?,
        result = ?,
        error = ?,
        updated_at = ?,
        completed_at = ?
    WHERE queue_message_id = ?
      AND type = 'abort_subagent'
      AND status IN ('pending', 'processing')
  `);

  function insertSystemMessageForConversation({ conversationId, text, model = null, relayMode = null }) {
    const now = new Date().toISOString();
    const messageId = uuidv4();
    const tx = db.transaction(() => {
      const normalizedModel = String(model || '').trim() || null;
      stmts.insertMsg.run(
        messageId,
        conversationId,
        'assistant',
        text,
        normalizedModel,
        relayMode || null,
        null,
        now,
        null,
        normalizedModel,
        deriveModelOrigin(normalizedModel),
      );
      stmts.updateConvTime.run(now, conversationId);
    });
    tx();
    io.emit('assistant_message', {
      conversationId,
      sourceMessageId: null,
      messageId,
      message: {
        role: 'assistant',
        text,
        model: String(model || '').trim() || null,
        modelOrigin: deriveModelOrigin(model) || undefined,
        mode: relayMode || null,
        timestamp: now,
      },
    });
    return messageId;
  }

  function parseJsonObject(value) {
    const text = String(value || '').trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function formatRelayControlResponse(row) {
    if (!row) return null;
    return {
      id: String(row.id || '').trim(),
      type: String(row.type || '').trim(),
      conversationId: String(row.conversation_id || '').trim() || null,
      queueMessageId: String(row.queue_message_id || '').trim() || null,
      sdkSessionId: String(row.sdk_session_id || '').trim() || null,
      status: String(row.status || '').trim() || null,
      request: parseJsonObject(row.request),
      result: parseJsonObject(row.result),
      error: String(row.error || '').trim() || null,
      createdAt: String(row.created_at || '').trim() || null,
      updatedAt: String(row.updated_at || '').trim() || null,
      completedAt: String(row.completed_at || '').trim() || null,
    };
  }

  function buildRelayStopFailurePayload() {
    return buildRelayStopFailure();
  }

  // The key stop's request (`{ source, code, error, episode }`), or null for any other control.
  function claudeApiCapStopOf(control) {
    let request = null;
    try { request = JSON.parse(String(control?.request || 'null')); } catch { request = null; }
    return request?.source === CLAUDE_API_CAP_STOP_SOURCE ? request : null;
  }

  function settleRelayAbortControlsForQueueMessage(queueMessageId, { ok = true, note = null, error = null } = {}) {
    const id = String(queueMessageId || '').trim();
    if (!id) return 0;
    const now = new Date().toISOString();
    const result = ok
      ? JSON.stringify({ source: 'relay-runtime', note: String(note || '').trim() || null })
      : null;
    const settled = settleRelayControlsForQueueMessage.run(
      ok ? 'done' : 'failed',
      result,
      ok ? null : String(error || 'stale-control').trim() || 'stale-control',
      now,
      now,
      id,
    );
    return Number(settled?.changes || 0);
  }

  function settleRelaySubagentAbortControlsForQueueMessage(queueMessageId, { ok = true, note = null, error = null } = {}) {
    const id = String(queueMessageId || '').trim();
    if (!id) return 0;
    const now = new Date().toISOString();
    const result = ok
      ? JSON.stringify({ source: 'relay-runtime', note: String(note || '').trim() || null })
      : null;
    const settled = settleRelaySubagentControlsForQueueMessage.run(
      ok ? 'done' : 'failed',
      result,
      ok ? null : String(error || 'stale-control').trim() || 'stale-control',
      now,
      now,
      id,
    );
    return Number(settled?.changes || 0);
  }

  function relayControlRequestPayload(row) {
    return parseJsonObject(row?.request) || null;
  }

  function relayControlSubagentRunId(row) {
    const requestPayload = relayControlRequestPayload(row);
    return String(requestPayload?.subagentRunId || '').trim() || null;
  }

  // A worker survives EPERM probes (alive, different owner), so only ESRCH
  // and bad pids count as dead — the same read as the supervisor's probe.
  function isWorkerPidAlive(pidValue) {
    const pid = Number(pidValue);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = String(error?.code || '').trim().toUpperCase();
      if (code === 'EPERM') return true;
      return false;
    }
  }

  app.post('/api/session-worker/:sdkSessionId/kill', auth, async (req, res) => {
    const sdkSessionId = normalizeSessionWorkerId(req.params.sdkSessionId);
    if (!sdkSessionId) return res.status(400).json({ error: 'Missing session worker id' });

    const currentWorker = sessionWorkerRegistry?.getWorker?.(sdkSessionId) || null;
    sessionWorkerSupervisor?.markKilled?.(sdkSessionId);
    try {
      // Wait for an in-flight spawn to settle before enumerating processes:
      // a fire-and-forget cancellation let the spawn's child appear right
      // after the scan and survive the kill.
      await sessionWorkerSupervisor?.cancelPendingStart?.(sdkSessionId, { wait: true });
    } catch {
      // If cancellation fails, keep going with the process kill cleanup.
    }

    // Deterministic stop — the shared service enumerates every matching PID,
    // signals, polls, escalates once, and verifies, instead of the one-shot
    // scan-and-signal pass that used to report success with survivors.
    const stopped = await stopSessionWorkerProcesses({
      sdkSessionId,
      worker: currentWorker,
      processInspector: sessionWorkerProcessInspector,
      isPidAliveImpl: isWorkerPidAlive,
      killTmuxSessionImpl: killTmuxSession,
      ...(sessionWorkerStopOverrides || {}),
    });
    const allPids = stopped.pids || [];
    const remainingPids = stopped.remainingPids || [];
    const killedPids = allPids.filter((pid) => !remainingPids.includes(pid));
    const processStatus = allPids.length
      ? (stopped.ok ? 'killed' : 'kill-incomplete')
      : 'not-running';

    // Audit marker — always emitted before responding
    console.log(`[KILL] session=${sdkSessionId} pids=${allPids.join(',') || 'none'} processStatus=${processStatus}${remainingPids.length ? ` remaining=${remainingPids.join(',')}` : ''}`);

    if (!stopped.ok) {
      // Verified survivors (or a failed stop pass): keep the registry entry
      // and every owned queue row. Clearing them while a CLI is still alive is
      // what let a "successful" kill leave an orphan worker holding the
      // session's work.
      return res.status(409).json({
        ok: false,
        error: stopped.error || 'Session worker processes survived the kill',
        sdkSessionId,
        killedPids,
        remainingPids,
        processStatus,
        escalated: stopped.escalated === true,
        timedOut: stopped.timedOut === true,
      });
    }

    sessionWorkerRegistry?.removeWorker?.(sdkSessionId);
    sessionWorkerSupervisor?.clearRestartSchedule?.(sdkSessionId);
    sessionWorkerSupervisor?.resetHealth?.(sdkSessionId, { clearFailureCount: false });
    // Re-arm the kill block now that the processes are actually gone. Windows
    // process-tree discovery and the kill itself are synchronous and take
    // seconds — longer than the block's grace window — so the marker set at the
    // top of this route has already expired by the time the worker dies, and
    // the first delivery check after this handler yields spawns a replacement
    // for the session that was just killed.
    sessionWorkerSupervisor?.markKilled?.(sdkSessionId);

    // Drain ALL owned processing rows, not just first
    const queueRows = findAllProcessingOwnedBySession.all(sdkSessionId) || [];
    const failedMessageIds = [];
    let releasedOwnedCount = 0;

    if (queueRows.length > 0) {
      for (const queueRow of queueRows) {
        if (String(queueRow.kind || '') === 'continuation') {
          // A background continuation has no user prompt behind it, so it is
          // torn down quietly instead of answering the chat with a terminal
          // failure for a turn nobody asked for.
          stmts.dropStaleContinuation?.run?.(queueRow.id);
          io.emit('message_status', {
            messageId: queueRow.id,
            conversationId: queueRow.conversation_id,
            status: 'failed',
          });
          continue;
        }
        const failureRecord = {
          kind: 'manual-session-kill',
          code: 'worker-session-killed',
          stableCode: 'relay.worker-session-killed',
          message: '[System Message] This session was killed from the relay UI before the turn completed.',
          guidance: 'Retry the request or send a new message to relaunch the session if needed.',
          detail: [
            `session=${sdkSessionId}`,
            allPids.length ? `pids=${allPids.join(',')}` : 'pid=none',
            `processStatus=${processStatus}`,
          ].join(' | '),
          failedAt: new Date().toISOString(),
          requesterSessionId: sdkSessionId,
        };
        const failureText = buildTerminalFailureTextForChat(failureRecord);
        const failed = failQueueMessage({
          queueRow,
          messageId: queueRow.id,
          conversationId: queueRow.conversation_id,
          relayMode: queueRow.relay_mode || DEFAULT_RELAY_MODE,
          model: queueRow.model || DEFAULT_MODEL,
          responseText: failureText,
          failureRecord,
          markWorkerError: false,
        });

        if (failed?.responseId) failedMessageIds.push(failed.responseId);
      }
    } else if (processStatus === 'not-running') {
      // not-running case: emit [System Message] into conversation history
      const conversationId = currentWorker?.conversationId
        || findMostRecentConversationForSession.get(sdkSessionId)?.conversation_id
        || null;
      if (conversationId) {
        insertSystemMessageForConversation({
          conversationId,
          text: '[System Message] Session kill requested — no live worker process was found.',
        });
      }
    }

    const nonProcessingOwnedRows = findAllNonProcessingOwnedBySession.all(sdkSessionId) || [];
    if (nonProcessingOwnedRows.length > 0) {
      const released = clearNonProcessingOwnedBySession.run(sdkSessionId);
      releasedOwnedCount = Number(released?.changes || 0);
    }

    const conversationId = queueRows[0]?.conversation_id || currentWorker?.conversationId || null;

    io.emit('session_worker_killed', {
      sdkSessionId,
      conversationId,
      killedPids,
      remainingPids,
      processStatus,
      failedMessageIds,
      releasedOwnedCount,
    });

    return res.json({
      ok: true,
      sdkSessionId,
      killedPids,
      remainingPids,
      processStatus,
      failedMessageIds,
      releasedOwnedCount,
    });
  });

  app.post('/api/conversation/:conversationId/cancel-turn', auth, (req, res) => {
    if (!admitRemoteRelayRequest(req, res, remoteRelayInbound)) return;
    const conversationId = String(req.params.conversationId || '').trim();
    const requestedMessageId = String(req.body?.messageId || req.body?.queueMessageId || '').trim();
    const outcome = requestTurnStop(conversationId, {
      requestedMessageId,
      clientId: String(req.body?.clientId || '').trim() || null,
    });
    if (!outcome.ok) return rejectSessionBinding(res, outcome.status, outcome.error);
    return res.json(outcome.body);
  });

  /**
   * The work of POST /api/conversation/:id/cancel-turn: an `abort_turn`
   * control for the live turn. `{ ok: true, body }` with the route's answer,
   * or `{ ok: false, status, error }` when the conversation is unknown.
   */
  function requestTurnStop(conversationId, { requestedMessageId = '', clientId = null } = {}) {
    const sessionState = getConversationSessionState(conversationId);
    if (!sessionState.ok) return { ok: false, status: sessionState.status, error: sessionState.error };

    // The live turn, not merely the newest processing row: a steered message
    // folded into the running turn is also `processing`, and Stop must target
    // the turn actually executing (which the worker interrupts as a whole).
    const queueRow = resolveLiveTurnQueueRow(conversationId) || null;
    if (!queueRow) {
      return {
        ok: true,
        body: {
          ok: true,
          queued: false,
          acknowledgement: 'no-active-turn',
          requestedMessageId: requestedMessageId || null,
          activeMessageId: null,
        },
      };
    }

    const activeMessageId = String(queueRow.id || '').trim();
    if (requestedMessageId && activeMessageId && requestedMessageId !== activeMessageId) {
      const requestedRow = stmts.findQById.get(requestedMessageId) || null;
      const requestedStatus = String(requestedRow?.status || '').trim().toLowerCase();
      return {
        ok: true,
        body: {
          ok: true,
          queued: false,
          acknowledgement: requestedStatus === 'processing' ? 'message-mismatch' : 'already-finished',
          requestedMessageId,
          activeMessageId,
        },
      };
    }

    const sdkSessionId = normalizeSessionWorkerId(
      queueRow.owner_sdk_session_id
      || sessionState.runtimeSessionSdkSessionId
      || sessionState.conversationSdkSessionId,
    );
    if (!sdkSessionId) {
      return {
        ok: true,
        body: {
          ok: true,
          queued: false,
          acknowledgement: 'active-turn-unbound',
          requestedMessageId: activeMessageId || requestedMessageId || null,
          activeMessageId,
        },
      };
    }

    const existing = findActiveRelayControlByQueueMessage.get(activeMessageId, 'abort_turn') || null;
    if (existing) {
      return {
        ok: true,
        body: {
          ok: true,
          queued: true,
          duplicate: true,
          acknowledgement: 'already-requested',
          requestedMessageId: activeMessageId || requestedMessageId || null,
          activeMessageId,
          control: formatRelayControlResponse(existing),
        },
      };
    }

    const now = new Date().toISOString();
    const controlId = uuidv4();
    const requestPayload = JSON.stringify({
      source: 'relay-ui',
      requestedByClientId: clientId || null,
    });
    insertRelayControlRequest.run(
      controlId,
      'abort_turn',
      conversationId,
      activeMessageId,
      sdkSessionId,
      requestPayload,
      now,
      now,
    );
    const control = getRelayControlRequestById.get(controlId) || null;
    return {
      ok: true,
      body: {
        ok: true,
        queued: true,
        acknowledgement: 'stop-queued',
        requestedMessageId: activeMessageId || requestedMessageId || null,
        activeMessageId,
        control: formatRelayControlResponse(control),
      },
    };
  }

  // POST /api/conversation-groups/:id/stop — "Stop all running" on a session
  // group's head row: a stop for every member's live turn, and a stop for
  // every stoppable background task. Tasks the panel shows no Stop button
  // for are listed as `unstoppable`. The owner's action only: a paired
  // relay's agent is refused.
  app.post('/api/conversation-groups/:id/stop', auth, (req, res) => {
    if (notPerson(req, readRemoteRelayRequest(req, remoteRelayInbound))) {
      return res.status(403).json({ error: 'Session groups are managed by this relay\'s owner only.' });
    }
    const groupId = String(req.params.id || '').trim();
    const group = groupId ? conversationGroups?.getGroup?.(groupId) : null;
    if (!group) return res.status(404).json({ ok: false, error: 'Group not found' });
    const clientId = String(req.body?.clientId || '').trim() || null;
    const turns = [];
    const tasks = [];
    const unstoppable = [];
    for (const member of conversationGroups.membersOf(groupId)) {
      if (member.archived) continue;
      const outcome = requestTurnStop(member.id, { clientId });
      if (outcome.ok && outcome.body.queued === true) turns.push({ id: member.id, messageId: outcome.body.activeMessageId });
      const conversation = stmts.getConvAnyStatus?.get?.(member.id) || null;
      const sessionId = String(conversation?.sdk_session_id || member.id);
      const liveTasks = [...new Set([member.id, sessionId])].flatMap((key) => backgroundTaskStore?.get?.(key) || []);
      for (const task of liveTasks) {
        // The store holds what the publish route keeps: `taskId`.
        const taskId = String(task?.taskId || '').trim();
        if (!taskId) continue;
        if (task?.stoppable === false) {
          unstoppable.push({ id: member.id, taskId, reason: 'no-stop' });
          continue;
        }
        const sent = sendWorkerControl?.(sessionId, { type: 'stop_background_task', taskId });
        if (sent) tasks.push({ id: member.id, taskId });
        else unstoppable.push({ id: member.id, taskId, reason: 'worker-not-connected' });
      }
    }
    if (turns.length || tasks.length) {
      console.log(`[${ts()}] GROUP STOP ${groupId.slice(0, 12)} turns=${turns.length} tasks=${tasks.length}`);
    }
    return res.json({ ok: true, turns, tasks, unstoppable });
  });

  app.post('/api/conversation/:conversationId/subagent/:subagentRunId/cancel', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    const subagentRunId = String(req.params.subagentRunId || '').trim();
    const parentMessageId = String(req.body?.parentMessageId || '').trim();
    const sessionState = getConversationSessionState(conversationId);
    if (!sessionState.ok) {
      return rejectSessionBinding(res, sessionState.status, sessionState.error);
    }
    if (!subagentRunId) {
      return res.status(400).json({ error: 'Missing subagentRunId' });
    }

    const subagentRun = stmts.getSubagentRun?.get(subagentRunId) || null;
    if (!subagentRun) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'not-found',
        subagentRunId,
      });
    }

    const runConversationId = String(subagentRun.conversation_id || '').trim();
    if (!runConversationId || runConversationId !== conversationId) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'not-found',
        subagentRunId,
      });
    }

    const authoritativeMessageId = String(subagentRun.queue_message_id || '').trim();
    if (parentMessageId && authoritativeMessageId && parentMessageId !== authoritativeMessageId) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'message-mismatch',
        subagentRunId,
        parentMessageId,
        authoritativeMessageId,
      });
    }

    const status = String(subagentRun.status || '').trim().toLowerCase();
    if (status === 'cancelled') {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'already-cancelled',
        subagentRunId,
        status,
      });
    }
    if (!['pending', 'processing', 'running'].includes(status)) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'already-finished',
        subagentRunId,
        status,
      });
    }

    const queueRow = authoritativeMessageId ? (stmts.findQById.get(authoritativeMessageId) || null) : null;
    const sdkSessionId = normalizeSessionWorkerId(
      queueRow?.owner_sdk_session_id
      || sessionState.runtimeSessionSdkSessionId
      || sessionState.conversationSdkSessionId,
    );
    if (!sdkSessionId) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'already-finished',
        subagentRunId,
        status,
      });
    }

    const existing = findActiveRelaySubagentControlByRunId.get(authoritativeMessageId, subagentRunId) || null;
    if (existing) {
      return res.json({
        ok: true,
        queued: true,
        duplicate: true,
        acknowledgement: 'cancelled',
        subagentRunId,
        control: formatRelayControlResponse(existing),
      });
    }

    const now = new Date().toISOString();
    const controlId = uuidv4();
    const requestPayload = JSON.stringify({
      source: 'relay-ui',
      requestedByClientId: String(req.body?.clientId || '').trim() || null,
      subagentRunId,
      parentMessageId: authoritativeMessageId || null,
    });
    insertRelayControlRequest.run(
      controlId,
      'abort_subagent',
      conversationId,
      authoritativeMessageId || null,
      sdkSessionId,
      requestPayload,
      now,
      now,
    );
    const control = getRelayControlRequestById.get(controlId) || null;
    return res.json({
      ok: true,
      queued: true,
      acknowledgement: 'cancelled',
      subagentRunId,
      control: formatRelayControlResponse(control),
    });
  });

  // The session worker that can still pull a processing row back out of its
  // runtime: the row's owner first (the worker that claimed it), then the
  // conversation's bound session. Only a worker whose latest heartbeat lists
  // the id as cancellable qualifies — the relay never guesses at the runtime's
  // queue state.
  function findWorkerHoldingCancellableMessage({ queueRow, conversationId, messageId }) {
    if (typeof sessionWorkerRegistry?.getWorker !== 'function') return null;
    const conversation = stmts.getConvAnyStatus?.get?.(conversationId) || null;
    const candidates = [...new Set([
      normalizeSessionWorkerId(queueRow?.owner_sdk_session_id),
      normalizeSessionWorkerId(conversation?.sdk_session_id),
    ].filter(Boolean))];
    for (const sessionId of candidates) {
      const worker = sessionWorkerRegistry.getWorker(sessionId);
      const cancellableIds = Array.isArray(worker?.steering?.cancellableIds) ? worker.steering.cancellableIds : [];
      if (cancellableIds.includes(messageId)) return worker;
    }
    return null;
  }

  // Asks the owning worker to remove a pushed-but-unconsumed row from its
  // runtime (`cancel_pushed_message`). True when the control went out over a
  // live worker socket; the worker then settles the row through
  // POST /api/queue-cancelled. False (no such worker, id not cancellable, or
  // the socket is gone) leaves the row on its ordinary path.
  function requestPushedMessageCancel({ queueRow, conversationId, messageId }) {
    const worker = findWorkerHoldingCancellableMessage({ queueRow, conversationId, messageId });
    if (!worker) return false;
    const sent = sendWorkerControl?.(worker.sdkSessionId, {
      type: 'cancel_pushed_message',
      messageId,
      conversationId,
    });
    if (!sent) return false;
    console.log(`[${ts()}] UNSTEER REQ ${messageId.slice(0, 8)} conv=${conversationId.slice(0, 8)}`);
    return true;
  }

  app.post('/api/conversation/:conversationId/cancel-queued-turn', auth, (req, res) => {
    if (!admitRemoteRelayRequest(req, res, remoteRelayInbound)) return;
    const conversationId = String(req.params.conversationId || '').trim();
    const requestedMessageId = String(req.body?.messageId || '').trim();
    if (!conversationId) {
      return res.status(400).json({ error: 'Missing conversationId' });
    }
    if (!requestedMessageId) {
      return res.status(400).json({ error: 'Missing messageId' });
    }

    const queueRow = stmts.findQById.get(requestedMessageId) || null;
    if (!queueRow) {
      return res.json({
        ok: true,
        cancelled: false,
        acknowledgement: 'not-found',
        requestedMessageId,
      });
    }

    const rowConversationId = String(queueRow.conversation_id || '').trim();
    if (rowConversationId !== conversationId) {
      return res.json({
        ok: true,
        cancelled: false,
        acknowledgement: 'conversation-mismatch',
        requestedMessageId,
        actualConversationId: rowConversationId || null,
      });
    }

    const currentStatus = String(queueRow.status || '').trim().toLowerCase();
    if (currentStatus === 'processing') {
      // Un-steer: a row the owning worker pushed into its runtime but reports
      // as still unconsumed (heartbeat `steering.cancellableIds`) can be pulled
      // back out. The worker answers through POST /api/queue-cancelled once the
      // runtime confirms the removal; until then the row stays processing.
      if (requestPushedMessageCancel({ queueRow, conversationId, messageId: requestedMessageId })) {
        return res.json({
          ok: true,
          cancelled: false,
          acknowledgement: 'cancel-requested',
          requestedMessageId,
          status: currentStatus,
        });
      }
      return res.json({
        ok: true,
        cancelled: false,
        acknowledgement: 'already-processing',
        requestedMessageId,
        status: currentStatus,
      });
    }
    if (!['pending', 'parked'].includes(currentStatus)) {
      return res.json({
        ok: true,
        cancelled: false,
        acknowledgement: 'already-finished',
        requestedMessageId,
        status: currentStatus,
      });
    }

    // The row's pending question cards are cancelled and read before the
    // delete, which takes them along (relay_questions.queue_id cascades), and
    // announced once the delete committed. No attempt of the row counts as
    // current: every pending card an attempt of the row asked is cancelled.
    const cancelledQuestions = [];
    const cancelQueuedTurn = db.transaction(() => {
      const now = new Date().toISOString();
      for (const question of stmts.cancelPendingQuestionsForStaleAttempts?.all?.(now, requestedMessageId, '') || []) {
        const updated = stmts.getQuestion?.get?.(question.id) || null;
        if (updated && typeof deps.formatQuestionRow === 'function') cancelledQuestions.push(deps.formatQuestionRow(updated));
      }
      stmts.deleteQueueById.run(requestedMessageId);
    });
    cancelQueuedTurn();

    io.emit('message_status', { messageId: requestedMessageId, conversationId, status: 'cancelled' });
    for (const question of cancelledQuestions) io.emit('relay_question_updated', { question });

    return res.json({
      ok: true,
      cancelled: true,
      acknowledgement: 'cancelled',
      requestedMessageId,
      previousStatus: currentStatus,
    });
  });

  app.get('/api/control/active', auth, (req, res) => {
    const bridgeIdentity = readBridgeIdentity(req);
    const sdkSessionId = normalizeSessionWorkerId(req.query?.sdkSessionId || bridgeIdentity?.sessionId);
    const queueMessageId = String(req.query?.queueMessageId || req.query?.messageId || '').trim();
    if (!sdkSessionId) {
      return res.status(400).json({ error: 'Missing sdkSessionId' });
    }

    const pending = queueMessageId
      ? (findPendingRelayControlForSessionAndMessage.get(sdkSessionId, queueMessageId) || null)
      : (findPendingRelayControlForSession.get(sdkSessionId) || null);
    if (!pending) {
      return res.json({ ok: true, control: null });
    }
    const pendingType = String(pending.type || '').trim();
    if (pendingType === 'abort_turn') {
      const targetMessageId = String(pending.queue_message_id || '').trim();
      const targetRow = targetMessageId ? (stmts.findQById.get(targetMessageId) || null) : null;
      const targetOwnerSessionId = normalizeSessionWorkerId(targetRow?.owner_sdk_session_id);
      if (!targetRow || String(targetRow.status || '').trim().toLowerCase() !== 'processing' || targetOwnerSessionId !== sdkSessionId) {
        const now = new Date().toISOString();
        failRelayControlRequest.run('stale-control', now, now, pending.id);
        return res.json({ ok: true, control: null });
      }
    }
    if (pendingType === 'abort_subagent') {
      const targetMessageId = String(pending.queue_message_id || '').trim();
      const targetRow = targetMessageId ? (stmts.findQById.get(targetMessageId) || null) : null;
      const targetOwnerSessionId = normalizeSessionWorkerId(targetRow?.owner_sdk_session_id);
      const targetSubagentRunId = relayControlSubagentRunId(pending);
      const targetSubagentRun = targetSubagentRunId ? (stmts.getSubagentRun?.get(targetSubagentRunId) || null) : null;
      const targetSubagentStatus = String(targetSubagentRun?.status || '').trim().toLowerCase();
      const cancellableSubagentStatus = ['running', 'pending', 'processing'];
      const stale = (
        !targetRow
        || String(targetRow.status || '').trim().toLowerCase() !== 'processing'
        || targetOwnerSessionId !== sdkSessionId
        || !targetSubagentRun
        || String(targetSubagentRun.queue_message_id || '').trim() !== targetMessageId
        || String(targetSubagentRun.conversation_id || '').trim() !== String(pending.conversation_id || '').trim()
        || !cancellableSubagentStatus.includes(targetSubagentStatus)
      );
      if (stale) {
        const now = new Date().toISOString();
        failRelayControlRequest.run('stale-control', now, now, pending.id);
        return res.json({ ok: true, control: null });
      }
    }

    const now = new Date().toISOString();
    const claimed = claimRelayControlRequest.run(now, pending.id);
    if (claimed.changes === 0) {
      return res.json({ ok: true, control: null });
    }

    const control = getRelayControlRequestById.get(pending.id) || pending;
    return res.json({ ok: true, control: formatRelayControlResponse(control) });
  });

  /**
   * A continuation on the key, stopped because the Claude API claim check
   * refused it: its note was written, and its tasks stopped, when it was
   * registered, so the row fails quietly.
   */
  function settleClaudeApiContinuationStop({ queueRow, queueMessageId }) {
    if (Number(stmts.dropStaleContinuation?.run?.(queueMessageId)?.changes || 0) > 0) {
      io.emit('message_status', { messageId: queueMessageId, conversationId: queueRow.conversation_id, status: 'failed' });
    }
  }

  app.post('/api/control/:controlId/result', auth, (req, res) => {
    const controlId = String(req.params.controlId || '').trim();
    if (!controlId) {
      return res.status(400).json({ error: 'Missing control id' });
    }

    const control = getRelayControlRequestById.get(controlId) || null;
    if (!control) {
      return res.status(404).json({ error: 'Control request not found' });
    }

    const now = new Date().toISOString();
    const ok = req.body?.ok === true;
    if (!ok) {
      const errorText = String(req.body?.error || 'relay control failed').trim() || 'relay control failed';
      failRelayControlRequest.run(errorText, now, now, controlId);
      if (String(control.type || '').trim() === 'abort_subagent') {
        const targetSubagentRunId = relayControlSubagentRunId(control);
        const targetRun = targetSubagentRunId ? (stmts.getSubagentRun?.get(targetSubagentRunId) || null) : null;
        if (targetRun) {
          const messageId = String(targetRun.queue_message_id || control.queue_message_id || '').trim();
          const conversationId = String(targetRun.conversation_id || control.conversation_id || '').trim();
          const parentSubagentId = targetRun.parent_subagent_id ? String(targetRun.parent_subagent_id).trim() : null;
          const displayName = targetRun.display_name ? String(targetRun.display_name).trim() : null;
          const status = String(targetRun.status || 'running').trim().toLowerCase() || 'running';
          const stopUnsupported = /not supported/i.test(errorText);
          io.emit('subagent_status', {
            messageId: messageId || null,
            conversationId: conversationId || null,
            subagentRunId: targetSubagentRunId,
            parentSubagentId: parentSubagentId || undefined,
            displayName: displayName || undefined,
            status,
            timestamp: now,
            // Lets the client pin a "not supported by provider" state on the
            // stop control instead of re-arming a button that can never work.
            ...(stopUnsupported ? { stopUnsupported: true } : {}),
          });
          if (messageId && conversationId) {
            io.emit('relay_activity', {
              messageId,
              conversationId,
              mode: 'agent',
              text: `System note: Could not stop this subagent (${errorText}).`,
              timestamp: now,
              subagentRunId: targetSubagentRunId || undefined,
            });
          }
        }
      }
      return res.json({ ok: true, control: formatRelayControlResponse(getRelayControlRequestById.get(controlId) || control) });
    }

    const resultPayload = JSON.stringify({
      source: 'relay-runtime',
      note: String(req.body?.note || '').trim() || null,
    });
    completeRelayControlRequest.run(resultPayload, now, now, controlId);

    if (String(control.type || '').trim() === 'abort_turn') {
      const queueMessageId = String(control.queue_message_id || '').trim();
      const queueRow = queueMessageId ? (stmts.findQById.get(queueMessageId) || null) : null;
      const capStop = queueRow ? claudeApiCapStopOf(control) : null;
      if (capStop) {
        settleClaudeApiContinuationStop({ queueRow, queueMessageId });
      } else if (queueRow) {
        const failureRecord = buildRelayStopFailurePayload();
        failQueueMessage({
          queueRow,
          messageId: queueMessageId,
          conversationId: String(control.conversation_id || queueRow.conversation_id || '').trim(),
          relayMode: normalizeRelayMode(queueRow.relay_mode) || DEFAULT_RELAY_MODE,
          model: queueRow.model || null,
          responseText: buildTerminalFailureTextForChat(failureRecord),
          failureRecord,
          markWorkerError: false,
        });
      }
    }
    if (String(control.type || '').trim() === 'abort_subagent') {
      const targetSubagentRunId = relayControlSubagentRunId(control);
      const targetRun = targetSubagentRunId ? (stmts.getSubagentRun?.get(targetSubagentRunId) || null) : null;
      if (targetRun) {
        const messageId = String(targetRun.queue_message_id || control.queue_message_id || '').trim();
        const conversationId = String(targetRun.conversation_id || control.conversation_id || '').trim();
        const parentSubagentId = targetRun.parent_subagent_id ? String(targetRun.parent_subagent_id).trim() : null;
        const displayName = targetRun.display_name ? String(targetRun.display_name).trim() : null;
        stmts.updateSubagentRunStatus?.run('cancelled', now, now, targetSubagentRunId);
        io.emit('subagent_status', {
          messageId: messageId || null,
          conversationId: conversationId || null,
          subagentRunId: targetSubagentRunId,
          parentSubagentId: parentSubagentId || undefined,
          displayName: displayName || undefined,
          status: 'cancelled',
          timestamp: now,
        });
      }
    }

    return res.json({ ok: true, control: formatRelayControlResponse(getRelayControlRequestById.get(controlId) || control) });
  });

  app.post('/api/upload', auth, express.raw({ type: () => true, limit: `${MAX_UPLOAD_BYTES}b` }), (req, res) => {
    const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!payload.length) return res.status(400).json({ error: 'Empty upload payload' });
    if (payload.length > MAX_UPLOAD_BYTES) return res.status(400).json({ error: 'Uploaded file too large' });

    const rawNameHeader = String(req.headers['x-file-name'] || req.query.name || '').trim();
    let decodedName = '';
    try { decodedName = decodeURIComponent(rawNameHeader); } catch { decodedName = rawNameHeader; }
    const fileName = decodedName || `upload-${Date.now()}`;
    const claimedType = String(req.headers['x-file-type'] || req.headers['content-type'] || req.query.type || 'application/octet-stream').trim().toLowerCase();
    // The MIME type is client supplied, so verify it against the actual bytes
    // before it is stored and later handed to a model or a download.
    const resolvedType = resolveUploadMimeType(payload, claimedType);
    const fileType = resolvedType.mimeType;

    try {
      const attachment = persistUploadBuffer(payload, { name: fileName, type: fileType });
      if (!attachment) return res.status(500).json({ error: 'Upload persistence failed' });
      res.json({ ok: true, attachment, mimeTypeCorrected: resolvedType.corrected });
    } catch (e) {
      res.status(400).json({ error: e?.message || 'Upload failed' });
    }
  });

  app.get('/api/upload/:sha256/content', auth, (req, res) => {
    const sha256 = String(req.params.sha256 || '').trim().toLowerCase();
    if (!isSha256(sha256)) return res.status(400).json({ error: 'Invalid file id' });
    const file = stmts.getUploadFile.get(sha256);
    if (!file) return res.status(404).json({ error: 'Not found' });
    const filePath = uploadPathForSha(sha256);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Missing file on disk' });
    serveFileWithRangeSupport(req, res, filePath, { contentType: file.mime_type }, {
      safeName: String(file.name || file.file_name || '').replace(/"/g, ''),
      cacheControl: UPLOAD_CONTENT_CACHE_CONTROL,
    });
  });

  registerGeneratedImageContentRoute(app, deps);

  // The media gallery (🧠 Media tab, global Media view) and its index.
  registerMediaRoutes(app, {
    auth,
    db,
    uploadPathForSha,
    fetchBrowsableDrives,
    isProtectedFile: isProtectedRelayFile,
    ...(mediaTags ? { mediaTags } : {}),
    resolveGeneratedImagePath: ({ sessionId, relativePath }) => resolveGeneratedImageReadPath({
      resolveSessionStateRoot,
      sessionId,
      relativePath,
    }),
  });

  function isProtectedRelayFile(filePath) {
    try { return protectedRelayFiles?.isProtected?.(filePath) === true; } catch { return true; }
  }

  function refuseFileCapability(res) {
    res.status(403).json({ error: AUTH_FILE_CAPABILITY_MESSAGE, code: AUTH_ERROR_CODES.fileCapability });
    return true;
  }

  /**
   * First thing a file route does for a request `auth` let in on a file
   * capability: its MAC against the path the request asks for, absolute and
   * normalized as a string (`targetOf()`, which reads nothing from the disk;
   * '' for a path the route would refuse). A wrong one gets 403
   * AUTH_FILE_CAPABILITY whatever the path (missing, a link, the relay's
   * own files): no link is resolved, no file looked at and no drive listed
   * before it. A right one is marked on the request for that path, which
   * file-serving.mjs checks again. True when refused; false without a
   * capability (the request carries the proof key or a Bearer).
   */
  function fileCapabilityRefused(req, res, targetOf) {
    const capability = req?.[FILE_CAPABILITY_REQUEST_KEY];
    if (!capability) return false;
    let target = '';
    try { target = String((typeof targetOf === 'function' ? targetOf() : targetOf) || ''); } catch { target = ''; }
    let checked = null;
    try { checked = target ? fileCapabilities?.verify?.(capability.k, { filePath: target, sessionIds: capability.sessionIds }) : null; } catch { checked = null; }
    if (!checked?.ok) return refuseFileCapability(res);
    capability.verified = true;
    capability.verifiedPath = target;
    return false;
  }

  /**
   * Before a file route reads `filePath`, after its path checks: 403 for the
   * relay's own secrets, database and config, whoever asks; the check
   * resolves links, so the file a verified capability's path really is gets
   * looked at too. A request on a capability must be about the path it was
   * verified for. True when refused.
   */
  function fileAccessRefused(req, res, filePath) {
    const capability = req?.[FILE_CAPABILITY_REQUEST_KEY];
    if (capability && (capability.verified !== true || capability.verifiedPath !== filePath)) return refuseFileCapability(res);
    if (isProtectedRelayFile(filePath)) {
      res.status(403).json({ error: FILE_PROTECTED_MESSAGE, code: AUTH_ERROR_CODES.protectedFile });
      return true;
    }
    return false;
  }

  // The absolute path GET /api/drives/file or /api/files/* resolves for a
  // relative address of either (with or without the relay's base path), as
  // the routes themselves resolve it; '' for anything else.
  function fileRoutePathOf(rawUrl) {
    const text = String(rawUrl || '').trim();
    if (!text.startsWith('/') || text.startsWith('//') || text.length > 4096) return '';
    let parsed = null;
    try { parsed = new URL(text, 'http://relay.invalid'); } catch { return ''; }
    const base = String(remotePath || '').replace(/\/+$/, '');
    let appPath = parsed.pathname;
    if (base && (appPath === base || appPath.startsWith(`${base}/`))) appPath = appPath.slice(base.length);
    if (appPath === '/api/drives/file') {
      return driveFileTargetPath(String(parsed.searchParams.get('path') || '').trim());
    }
    if (appPath.startsWith('/api/files/')) {
      let requestedPath = '';
      try {
        requestedPath = appPath.slice('/api/files/'.length).split('/').map((segment) => decodeURIComponent(segment)).join('/').trim();
      } catch {
        return '';
      }
      const query = Object.fromEntries(parsed.searchParams.entries());
      const rootOverride = resolveScopedWorkspaceRootPath({ query, headers: {} });
      // Only for a path the route would serve (a link out of the workspace
      // is not one); signed as the string the route checks it against.
      if (!resolveWorkspaceFilePath(requestedPath, rootOverride)) return '';
      return resolveWorkspaceFileTargetPath(requestedPath, rootOverride) || '';
    }
    return '';
  }

  // The absolute path GET /api/drives/file is asked for, normalized as a
  // string; '' for one it refuses on its face.
  function driveFileTargetPath(requestedPath) {
    return (filePlatform === 'win32' ? normalizeDriveAbsolutePath(requestedPath) : normalizeLinuxAbsolutePath(requestedPath)) || '';
  }

  // File capabilities for the page's native loads (an <img>, a <video>, a
  // download, a PDF in a new tab): `{ urls: [...] }`, relative addresses of
  // GET /api/drives/file or /api/files/*, gives back `{ urls, expiresAt }`,
  // each address with its `k` (null for one that names no file the routes
  // would serve). Only a browser session gets capabilities; the owner token
  // gets the addresses back as they are (its Bearer reads them).
  const FILE_CAPABILITY_MAX_URLS = 200;
  app.post('/api/files/capability', auth, (req, res) => {
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : null;
    if (!urls || urls.length > FILE_CAPABILITY_MAX_URLS || urls.some((url) => typeof url !== 'string')) {
      return res.status(400).json({ error: `urls: a list of at most ${FILE_CAPABILITY_MAX_URLS} addresses` });
    }
    const principal = principalOf(req);
    res.setHeader('Cache-Control', 'no-store');
    if (principal?.kind !== 'browser') {
      return res.json({ urls: urls.map((url) => (fileRoutePathOf(url) ? url : null)), expiresAt: null });
    }
    let expiresAtMs = null;
    const signed = urls.map((url) => {
      const filePath = fileRoutePathOf(url);
      if (!filePath || isProtectedRelayFile(filePath)) return null;
      const made = fileCapabilities?.mint?.({ sessionId: principal.sessionId, filePath });
      if (!made?.k) return null;
      expiresAtMs = expiresAtMs === null ? made.expiresAtMs : Math.min(expiresAtMs, made.expiresAtMs);
      return withFileCapability(url, made.k);
    });
    return res.json({ urls: signed, expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString() });
  });

  app.get('/api/files/{*splat}', auth, (req, res) => {
    const requestedPath = splatPath(req).trim();
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    // A capability first, then the path checks (a link out of the
    // workspace): no 400-or-403 difference for a wrong `k`.
    if (fileCapabilityRefused(req, res, () => resolveWorkspaceFileTargetPath(requestedPath, rootOverride))) return;
    const filePath = resolveWorkspaceFilePath(requestedPath, rootOverride);
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });
    if (fileAccessRefused(req, res, filePath)) return;

    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    serveFileWithRangeSupport(req, res, filePath, meta, {
      safeName: path.basename(filePath).replace(/"/g, ''),
      cacheDelete: (p) => workspaceFileMetaCache.delete(p),
    });
  });

  app.get('/api/files-preview/{*splat}', auth, (req, res) => {
    const requestedPath = splatPath(req).trim();
    const normalizedPath = normalizeWorkspaceRelativePath(requestedPath);
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    const filePath = resolveWorkspaceFilePath(requestedPath, rootOverride);
    if (!filePath || !normalizedPath) return res.status(400).json({ error: 'Invalid file path' });
    if (fileAccessRefused(req, res, filePath)) return;

    // The preview carries the version the download link is built from, so
    // it reads the file's metadata fresh, not from the short-lived cache.
    workspaceFileMetaCache.delete(filePath);
    let meta = null;
    try {
      meta = readWorkspaceFileMeta(filePath);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
    }

    if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
    if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

    const ext = path.extname(filePath).toLowerCase();
    const size = Number(meta.size || 0);
    const contentType = meta.contentType || workspaceContentType(filePath);
    const language = previewLanguageForWorkspaceFile(filePath);

    let previewBuffer = Buffer.alloc(0);
    try {
      previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
    } catch (error) {
      workspaceFileMetaCache.delete(filePath);
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.status(500).json({ error: 'Failed to read file' });
    }

    const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
    const contentBuffer = truncated
      ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
      : previewBuffer;

    const likelyBinaryType = contentType === 'application/pdf'
      || contentType === 'application/octet-stream';
    const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
    const likelyTextType = isLikelyTextContentType(contentType);

    let kind = workspacePreviewKindForMeta(filePath, contentType);
    if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
      kind = 'binary';
    } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
      kind = 'binary';
    }

    const normalizedWebPath = normalizedPath.replace(/\\/g, '/');
    const scopeSuffix = scopedWorkspaceQuerySuffix(req);
    const payload = {
      ok: true,
      path: normalizedWebPath,
      name: path.basename(filePath),
      kind,
      language,
      contentType,
      size,
      truncated,
      previewBytes: contentBuffer.length,
      mtimeMs: meta.mtimeMs ?? null,
      version: fileVersionToken(meta),
      rawUrl: withFileVersion(`${remotePath}/api/files/${normalizedWebPath.split('/').map((part) => encodeURIComponent(part)).join('/')}${scopeSuffix}`, fileVersionToken(meta)),
    };

    if (TEXT_PREVIEW_KINDS.has(kind)) {
      payload.content = contentBuffer.toString('utf8');
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json(payload);
  });

  app.get('/api/repo/tree', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const includeHeavy = parseBooleanQueryFlag(req.query.includeHeavy, false);
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    fetchWorkspaceDirectoryEntries('', {
      includeHidden,
      includeHeavy,
      rootPath: rootOverride,
    }, (listErr, payload) => {
      if (listErr) return res.status(Number(listErr?.statusCode) || 500).json({ error: listErr?.message || 'Failed to load repository tree' });
      const root = payload?.node || {
        path: '',
        name: 'repo',
        type: 'dir',
        children: [],
        childrenLoaded: true,
        lazy: false,
      };
      const childCount = Array.isArray(root.children) ? root.children.length : 0;
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        root,
        rootPath: payload?.rootPath || rootOverride || null,
        rootName: payload?.rootName || String(root?.name || 'repo'),
        includeHidden,
        includeHeavy,
        nodeCount: childCount + 1,
        maxNodes: MAX_REPO_TREE_NODES,
        truncated: false,
      });
    });
  });

  app.get('/api/repo/list', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const includeHeavy = parseBooleanQueryFlag(req.query.includeHeavy, false);
    const requestedPath = String(req.query.path || '').trim();
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    fetchWorkspaceDirectoryEntries(requestedPath, {
      includeHidden,
      includeHeavy,
      rootPath: rootOverride,
    }, (listErr, payload) => {
      if (listErr) return res.status(Number(listErr?.statusCode) || 500).json({ error: listErr?.message || 'Failed to list repository directory' });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        node: payload?.node || null,
        rootPath: payload?.rootPath || rootOverride || null,
        rootName: payload?.rootName || null,
        includeHidden,
        includeHeavy,
      });
    });
  });

  app.get('/api/drives/roots', auth, (req, res) => {
    if (process.platform !== 'win32') {
      return fetchLinuxDirectoryEntries('/', { includeHidden: false }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to enumerate Linux root' });
        const children = entries.map(mapLinuxDirectoryEntry).filter((entry) => !!entry?.path);
        const root = {
          path: '/',
          name: '/',
          type: 'dir',
          children,
          childrenLoaded: true,
          lazy: false,
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.json({
          ok: true,
          root,
          nodeCount: children.length + 1,
          truncated: false,
          maxNodes: children.length + 1,
          includeHidden: false,
          includeHeavy: false,
          rootName: 'Linux Root',
        });
      });
    }
    fetchBrowsableDrives((err, drives) => {
      if (err) return res.status(500).json({ error: err.message || 'Failed to enumerate drives' });
      const root = {
        path: '',
        name: 'Drives',
        type: 'dir',
        children: drives.map((drive) => ({
          path: drive.webPath,
          name: driveDisplayName(drive),
          type: 'dir',
          driveType: drive.driveType,
          label: drive.label || '',
          sizeBytes: drive.sizeBytes,
          freeBytes: drive.freeBytes,
          children: [],
          lazy: true,
          childrenLoaded: false,
        })),
        childrenLoaded: true,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        ok: true,
        root,
        nodeCount: root.children.length + 1,
        truncated: false,
        maxNodes: root.children.length + 1,
        includeHidden: false,
        includeHeavy: false,
        rootName: 'Drives',
        driveTypes: ['fixed', 'removable'],
      });
    });
  });

  app.get('/api/drives/list', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const requestedPath = String(req.query.path || '').trim();

    if (process.platform !== 'win32') {
      const absolutePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!absolutePath) return res.status(400).json({ error: 'Invalid Linux path' });

      let stat = null;
      try {
        stat = fs.statSync(absolutePath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return res.status(404).json({ error: 'Path not found' });
        return res.status(500).json({ error: error?.message || 'Failed to read path metadata' });
      }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must reference a directory' });

      return fetchLinuxDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list directory' });
        const children = entries.map(mapLinuxDirectoryEntry).filter((entry) => !!entry?.path);
        const node = {
          path: absolutePath,
          name: absolutePath === '/' ? '/' : (path.basename(absolutePath) || absolutePath),
          type: 'dir',
          children,
          childrenLoaded: true,
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ok: true, node, includeHidden });
      });
    }

    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const absolutePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
      if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive path' });
      }

      let stat = null;
      try {
        stat = fs.statSync(absolutePath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return res.status(404).json({ error: 'Path not found' });
        return res.status(500).json({ error: error?.message || 'Failed to read path metadata' });
      }
      if (!stat.isDirectory()) return res.status(400).json({ error: 'Path must reference a directory' });

      fetchDriveDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list directory' });
        const children = entries
          .map(mapDriveDirectoryEntry)
          .filter((entry) => {
            if (!entry?.path) return false;
            const entryRoot = driveRootFromAbsolutePath(entry.path).toUpperCase();
            return allowedRoots.has(entryRoot);
          });
        const driveMeta = drives.find((drive) => drive.rootAbsolute.toUpperCase() === rootAbsolute);
        const nodePath = toDriveWebPath(absolutePath);
        const node = {
          path: nodePath,
          name: absolutePath.length <= 3 ? driveDisplayName(driveMeta) : (path.win32.basename(absolutePath) || nodePath),
          type: 'dir',
          driveType: driveMeta?.driveType || null,
          label: driveMeta?.label || '',
          children,
          childrenLoaded: true,
        };
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          ok: true,
          node,
          includeHidden,
        });
      });
    });
  });

  // The Session root of the explorer, listed the way `/api/drives/list` lists a
  // directory but with two differences that only make sense for a session:
  //
  //  - a not-yet-created root is an empty folder, not a 404. The Claude Agent
  //    SDK creates `<nativeSessionId>/` lazily, the first time the session
  //    writes a subagent or tool-result file, so a young session legitimately
  //    has a root path that has no directory behind it yet.
  //  - the sibling `<nativeSessionId>.jsonl` transcript is listed as a child.
  //    It lives one level up, in the project directory, which is not browsable
  //    on its own because it holds every session for the workspace.
  //
  // The transcript is derived from the requested path rather than accepted from
  // the client, so this endpoint reaches nothing `/api/drives/list` would not.
  app.get('/api/session-root/list', auth, (req, res) => {
    const includeHidden = parseBooleanQueryFlag(req.query.includeHidden, false);
    const requestedPath = String(req.query.path || '').trim();

    function transcriptChild(absolutePath, mapEntry, basename) {
      const transcriptPath = `${absolutePath}.jsonl`;
      let stat = null;
      try {
        stat = fs.statSync(transcriptPath);
      } catch {
        return null;
      }
      if (!stat.isFile()) return null;
      return mapEntry({
        name: basename(transcriptPath),
        fullPath: transcriptPath,
        type: 'file',
        size: stat.size,
        mtime: stat.mtime ? stat.mtime.toISOString() : null,
      });
    }

    function directoryState(absolutePath) {
      try {
        return fs.statSync(absolutePath).isDirectory() ? 'dir' : 'other';
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
        return 'error';
      }
    }

    if (process.platform !== 'win32') {
      const absolutePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!absolutePath) return res.status(400).json({ error: 'Invalid Linux path' });

      const state = directoryState(absolutePath);
      if (state === 'error') return res.status(500).json({ error: 'Failed to read session root metadata' });
      if (state === 'other') return res.status(400).json({ error: 'Session root must reference a directory' });

      const respond = (children) => {
        const transcript = transcriptChild(absolutePath, mapLinuxDirectoryEntry, path.posix.basename);
        const node = {
          path: absolutePath,
          name: path.posix.basename(absolutePath) || absolutePath,
          type: 'dir',
          children: transcript ? [...children, transcript] : children,
          childrenLoaded: true,
          lazy: false,
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ok: true, node, includeHidden, exists: state === 'dir' });
      };

      if (state === 'missing') return respond([]);
      return fetchLinuxDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list session root' });
        return respond(entries.map(mapLinuxDirectoryEntry).filter((entry) => !!entry?.path));
      });
    }

    return fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const absolutePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
      if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive path' });
      }

      const state = directoryState(absolutePath);
      if (state === 'error') return res.status(500).json({ error: 'Failed to read session root metadata' });
      if (state === 'other') return res.status(400).json({ error: 'Session root must reference a directory' });

      const respond = (children) => {
        const transcript = transcriptChild(absolutePath, mapDriveDirectoryEntry, path.win32.basename);
        const nodePath = toDriveWebPath(absolutePath);
        const node = {
          path: nodePath,
          name: path.win32.basename(absolutePath) || nodePath,
          type: 'dir',
          children: transcript ? [...children, transcript] : children,
          childrenLoaded: true,
          lazy: false,
        };
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ ok: true, node, includeHidden, exists: state === 'dir' });
      };

      if (state === 'missing') return respond([]);
      return fetchDriveDirectoryEntries(absolutePath, { includeHidden }, (listErr, entries) => {
        if (listErr) return res.status(500).json({ error: listErr.message || 'Failed to list session root' });
        return respond(entries
          .map(mapDriveDirectoryEntry)
          .filter((entry) => {
            if (!entry?.path) return false;
            return allowedRoots.has(driveRootFromAbsolutePath(entry.path).toUpperCase());
          }));
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Explorer changes: new folder, rename, delete. Two routes per operation,
  // one for the conversation's workspace (relative paths, resolved exactly like
  // `/api/files/*`) and one for the drives and session roots (absolute paths,
  // checked exactly like `/api/drives/list`). Each write route therefore
  // reaches nothing its listing route would not show.
  // ---------------------------------------------------------------------------

  function workspaceWebPath(relativePath) {
    return String(relativePath || '').split(path.sep).join('/');
  }

  // Resolve a workspace entry from a request body: `{ absolutePath, relative }`
  // or `null` after answering the request with the error.
  function resolveWorkspaceMutationTarget(req, res, rawRelativePath) {
    const relative = normalizeWorkspaceRelativePath(rawRelativePath);
    if (!relative) {
      res.status(400).json({ error: 'Invalid path' });
      return null;
    }
    const absolutePath = resolveWorkspaceFilePath(relative, resolveScopedWorkspaceRootPath(req));
    if (!absolutePath) {
      res.status(400).json({ error: 'Invalid path' });
      return null;
    }
    return { absolutePath, relative };
  }

  // Resolve an absolute drives/session path from a request body and hand it
  // on, with the function that turns an absolute path into the explorer's
  // path form for the answer. Answers the request itself on a bad path.
  function withDriveMutationTarget(req, res, rawPath, { allowRoot = false } = {}, next) {
    const requestedPath = String(rawPath || '').trim();
    if (filePlatform !== 'win32') {
      const absolutePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!absolutePath) return res.status(400).json({ error: 'Invalid Linux path' });
      if (absolutePath === '/' && !allowRoot) return res.status(400).json({ error: 'The root folder cannot be changed' });
      return next(absolutePath, (value) => value);
    }
    return fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const absolutePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(absolutePath).toUpperCase();
      if (!absolutePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive path' });
      }
      if (absolutePath.toUpperCase() === rootAbsolute && !allowRoot) {
        return res.status(400).json({ error: 'A drive root cannot be changed' });
      }
      return next(absolutePath, toDriveWebPath);
    });
  }

  function validatedName(res, rawName) {
    const check = validateEntryName(rawName);
    if (!check.ok) {
      res.status(400).json({ error: check.error });
      return null;
    }
    return check.name;
  }

  // The relay's own secrets, database and config, and any folder holding
  // them, are never created, renamed, moved or deleted here, whoever asks.
  function mutationRefused(res, ...targets) {
    const refused = targets.some((target) => {
      try { return protectedRelayFiles?.touchesProtected?.(target) === true; } catch { return true; }
    });
    if (refused) res.status(403).json({ error: FILE_PROTECTED_MESSAGE, code: AUTH_ERROR_CODES.protectedFile });
    return refused;
  }

  function sendMutationResult(res, result, extra = {}) {
    if (!result?.ok) {
      const status = Number(result?.statusCode) || 500;
      // An unexpected failure is logged with its message (the protected files
      // were refused before any change was tried, so it names none of them).
      if (status >= 500) console.warn(`[explorer] ${res.req?.path || 'change'} failed (${status}): ${result?.error || 'no message'}`);
      return res.status(status).json({ error: result?.error || 'Request failed' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, ...extra });
  }

  app.post('/api/repo/mkdir', auth, (req, res) => {
    const name = validatedName(res, req.body?.name);
    if (!name) return;
    const parentRelative = normalizeWorkspaceRelativePath(req.body?.path);
    if (String(req.body?.path || '').trim() && !parentRelative) return res.status(400).json({ error: 'Invalid path' });
    const target = resolveWorkspaceMutationTarget(req, res, parentRelative ? `${workspaceWebPath(parentRelative)}/${name}` : name);
    if (!target) return;
    if (mutationRefused(res, target.absolutePath)) return;
    return sendMutationResult(res, createDirectory(target.absolutePath), { path: workspaceWebPath(target.relative) });
  });

  app.post('/api/repo/rename', auth, (req, res) => {
    const newName = validatedName(res, req.body?.newName);
    if (!newName) return;
    const source = resolveWorkspaceMutationTarget(req, res, req.body?.path);
    if (!source) return;
    const parentWeb = workspaceWebPath(path.dirname(source.relative));
    const destinationWeb = parentWeb && parentWeb !== '.' ? `${parentWeb}/${newName}` : newName;
    // The destination goes through the same resolver: a new name can never
    // leave the workspace or land on the root.
    const destination = resolveWorkspaceMutationTarget(req, res, destinationWeb);
    if (!destination) return;
    if (mutationRefused(res, source.absolutePath, destination.absolutePath)) return;
    return sendMutationResult(res, renameEntry(source.absolutePath, newName), { path: workspaceWebPath(destination.relative) });
  });

  app.post('/api/repo/delete', auth, (req, res) => {
    const target = resolveWorkspaceMutationTarget(req, res, req.body?.path);
    if (!target) return;
    if (mutationRefused(res, target.absolutePath)) return;
    if (req.body?.dryRun === true) {
      const counted = countEntries(target.absolutePath);
      return sendMutationResult(res, counted, counted.ok ? { kind: counted.kind, files: counted.files, dirs: counted.dirs, capped: counted.capped } : {});
    }
    return sendMutationResult(res, removeEntry(target.absolutePath));
  });

  app.post('/api/drives/mkdir', auth, (req, res) => {
    const name = validatedName(res, req.body?.name);
    if (!name) return;
    withDriveMutationTarget(req, res, req.body?.path, { allowRoot: true }, (parentAbsolute, webPathOf) => {
      const targetAbsolute = path.join(parentAbsolute, name);
      if (mutationRefused(res, targetAbsolute)) return;
      return sendMutationResult(res, createDirectory(targetAbsolute), { path: webPathOf(targetAbsolute) });
    });
  });

  app.post('/api/drives/rename', auth, (req, res) => {
    const newName = validatedName(res, req.body?.newName);
    if (!newName) return;
    withDriveMutationTarget(req, res, req.body?.path, {}, (sourceAbsolute, webPathOf) => {
      if (mutationRefused(res, sourceAbsolute, path.join(path.dirname(sourceAbsolute), newName))) return;
      const result = renameEntry(sourceAbsolute, newName);
      return sendMutationResult(res, result, result.ok ? { path: webPathOf(result.path) } : {});
    });
  });

  app.post('/api/drives/delete', auth, (req, res) => {
    withDriveMutationTarget(req, res, req.body?.path, {}, (targetAbsolute) => {
      if (mutationRefused(res, targetAbsolute)) return;
      if (req.body?.dryRun === true) {
        const counted = countEntries(targetAbsolute);
        return sendMutationResult(res, counted, counted.ok ? { kind: counted.kind, files: counted.files, dirs: counted.dirs, capped: counted.capped } : {});
      }
      return sendMutationResult(res, removeEntry(targetAbsolute));
    });
  });

  app.get('/api/drives/file', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();
    // A capability first: before the path checks, the disk and the drive list.
    if (fileCapabilityRefused(req, res, () => driveFileTargetPath(requestedPath))) return;

    if (filePlatform !== 'win32') {
      const filePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!filePath) return res.status(400).json({ error: 'Invalid Linux file path' });
      if (fileAccessRefused(req, res, filePath)) return;

      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      return serveFileWithRangeSupport(req, res, filePath, meta, {
        safeName: path.basename(filePath).replace(/"/g, ''),
        cacheDelete: (p) => workspaceFileMetaCache.delete(p),
      });
    }

    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const filePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
      if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive file path' });
      }
      if (fileAccessRefused(req, res, filePath)) return;

      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      serveFileWithRangeSupport(req, res, filePath, meta, {
        safeName: path.win32.basename(filePath).replace(/"/g, ''),
        cacheDelete: (p) => workspaceFileMetaCache.delete(p),
      });
    });
  });

  app.get('/api/drives/files-preview', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();

    if (process.platform !== 'win32') {
      const filePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!filePath) return res.status(400).json({ error: 'Invalid Linux file path' });
      if (fileAccessRefused(req, res, filePath)) return;

      // Fresh metadata: the download link's version comes from this answer.
      workspaceFileMetaCache.delete(filePath);
      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      const ext = path.extname(filePath).toLowerCase();
      const size = Number(meta.size || 0);
      const contentType = meta.contentType || workspaceContentType(filePath);
      const language = previewLanguageForWorkspaceFile(filePath);

      let previewBuffer = Buffer.alloc(0);
      try {
        previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
      } catch (error) {
        workspaceFileMetaCache.delete(filePath);
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return res.status(404).json({ error: 'File not found' });
        }
        return res.status(500).json({ error: 'Failed to read file' });
      }

      const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
      const contentBuffer = truncated
        ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
        : previewBuffer;

      const likelyBinaryType = contentType === 'application/pdf' || contentType === 'application/octet-stream';
      const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
      const likelyTextType = isLikelyTextContentType(contentType);

      let kind = workspacePreviewKindForMeta(filePath, contentType);
      if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
        kind = 'binary';
      } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
        kind = 'binary';
      }

      const payload = {
        ok: true,
        path: filePath,
        name: path.basename(filePath),
        kind,
        language,
        contentType,
        size,
        truncated,
        previewBytes: contentBuffer.length,
        mtimeMs: meta.mtimeMs ?? null,
        version: fileVersionToken(meta),
        rawUrl: withFileVersion(`${remotePath}/api/drives/file?path=${encodeURIComponent(filePath)}`, fileVersionToken(meta)),
      };

      if (TEXT_PREVIEW_KINDS.has(kind)) {
        payload.content = contentBuffer.toString('utf8');
      }

      res.setHeader('Cache-Control', 'no-store');
      return res.json(payload);
    }

    fetchBrowsableDrives((drivesErr, drives) => {
      if (drivesErr) return res.status(500).json({ error: drivesErr.message || 'Failed to enumerate drives' });
      const allowedRoots = new Set(drives.map((drive) => drive.rootAbsolute.toUpperCase()));
      const filePath = normalizeDriveAbsolutePath(requestedPath);
      const rootAbsolute = driveRootFromAbsolutePath(filePath).toUpperCase();
      if (!filePath || !rootAbsolute || !allowedRoots.has(rootAbsolute)) {
        return res.status(400).json({ error: 'Invalid drive file path' });
      }
      if (fileAccessRefused(req, res, filePath)) return;

      // Fresh metadata: the download link's version comes from this answer.
      workspaceFileMetaCache.delete(filePath);
      let meta = null;
      try {
        meta = readWorkspaceFileMeta(filePath);
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to read file metadata' });
      }

      if (!meta || meta.kind === 'missing') return res.status(404).json({ error: 'File not found' });
      if (meta.kind !== 'file') return res.status(400).json({ error: 'Path must reference a file' });

      const ext = path.extname(filePath).toLowerCase();
      const size = Number(meta.size || 0);
      const contentType = meta.contentType || workspaceContentType(filePath);
      const language = previewLanguageForWorkspaceFile(filePath);

      let previewBuffer = Buffer.alloc(0);
      try {
        previewBuffer = readWorkspaceFilePreviewBuffer(filePath, size);
      } catch (error) {
        workspaceFileMetaCache.delete(filePath);
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          return res.status(404).json({ error: 'File not found' });
        }
        return res.status(500).json({ error: 'Failed to read file' });
      }

      const truncated = size > MAX_WORKSPACE_PREVIEW_BYTES;
      const contentBuffer = truncated
        ? previewBuffer.subarray(0, Math.min(previewBuffer.length, MAX_WORKSPACE_PREVIEW_BYTES))
        : previewBuffer;

      const likelyBinaryType = contentType === 'application/pdf'
        || contentType === 'application/octet-stream';
      const likelyBinaryBytes = isLikelyBinaryPreviewBuffer(contentBuffer);
      const likelyTextType = isLikelyTextContentType(contentType);

      let kind = workspacePreviewKindForMeta(filePath, contentType);
      if ((kind === 'markdown' || kind === 'code' || kind === 'text') && likelyBinaryType) {
        kind = 'binary';
      } else if ((kind === 'markdown' || kind === 'code' || kind === 'text') && (!likelyTextType && likelyBinaryBytes)) {
        kind = 'binary';
      }

      const normalizedWebPath = toDriveWebPath(filePath);
      const payload = {
        ok: true,
        path: normalizedWebPath,
        name: path.win32.basename(filePath),
        kind,
        language,
        contentType,
        size,
        truncated,
        previewBytes: contentBuffer.length,
        mtimeMs: meta.mtimeMs ?? null,
        version: fileVersionToken(meta),
        rawUrl: withFileVersion(`${remotePath}/api/drives/file?path=${encodeURIComponent(normalizedWebPath)}`, fileVersionToken(meta)),
      };

      if (TEXT_PREVIEW_KINDS.has(kind)) {
        payload.content = contentBuffer.toString('utf8');
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    });
  });

  registerMessagesIntakeRoutes(app, deps, {
    uploadReadDirs,
    imageInputDenyPaths,
    resolveRequestedReasoningEffort,
    getOpenAIProviderSettings,
    getClaudeProviderSettings,
    getCursorProviderSettings,
    getGrokProviderSettings,
    getClaudeCloudProviderSettings,
    getDeepSeekProviderSettings,
    getClaudeApiProviderSettings,
    rebindUnstartedOpenAIConversationModel,
    claudeBillingSwitchService,
    getClaudeApiCapState,
    imageOperationService,
    remoteRelayInbound,
    readAppSettingText,
    imageSpend,
    readBridgeIdentity,
    emitSessionWorkerTelemetry,
    getConversationSessionState,
    rejectSessionBinding,
  });

  registerMessagesWorkerReportRoutes(app, deps, {
    backgroundWorkView,
    noteRestartTurnOutcome,
    planUsageService,
    usageLimitPauseService,
    claudeApiUsageService,
    tokenUsageService,
    checkClaudeApiCap,
    getCursorPlanAllowanceSettings,
    getGrokPlanAllowanceSettings,
    deepseekClaudeConfigDir,
    readBridgeIdentity,
    failQueueMessage,
    failConsumedQueueRow,
    settleRelayAbortControlsForQueueMessage,
    settleRelaySubagentAbortControlsForQueueMessage,
  });

  registerMessagesWorkerClaimRoutes(app, deps, {
    getCursorProviderSettings,
    getClaudeCloudProviderSettings,
    claudeApiClaimCheck,
    onClaudeBillingFence,
    workersStateTheirKind,
    workerReplacementFence,
    readBridgeIdentity,
    normalizeConsumedSteerEntries,
    settleRelayAbortControlsForQueueMessage,
    settleRelaySubagentAbortControlsForQueueMessage,
    emitSessionWorkerTelemetry,
    staleAttemptLog,
  });

  app.post('/api/relay/pause', auth, (req, res) => {
    runtimeState.relayPaused = true;
    const rows = stmts.listQueueForPauseDrop.all();
    const dropQueue = db.transaction(() => {
      for (const row of rows) {
        stmts.deleteQueueById.run(row.id);
      }
    });
    dropQueue();

    for (const row of rows) {
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'dropped' });
    }

    io.emit('relay_pause_state', { paused: true, droppedCount: rows.length });
    console.log(`[${ts()}] RELAY     paused dropped=${rows.length}`);
    res.json({ ok: true, paused: true, droppedCount: rows.length });
  });

  app.post('/api/relay/resume', auth, (req, res) => {
    runtimeState.relayPaused = false;
    io.emit('relay_pause_state', { paused: false });
    console.log(`[${ts()}] RELAY     resumed`);
    res.json({ ok: true, paused: false });
  });

  // Emptying the queue, restarting the relay and withdrawing a restart are
  // the user's own maintenance actions: the browser app calls them from a
  // phone, over the tunnel and over the LAN. The token is the boundary.
  app.post('/api/queue/empty', auth, (req, res) => {
    const rows = stmts.listQueueForPauseDrop.all();
    const droppedCount = rows.length;
    if (!droppedCount) {
      return res.json({ ok: true, droppedCount: 0, queue: queueCounts() });
    }
    const beforeQueue = queueCounts();
    const dropQueue = db.transaction(() => {
      for (const row of rows) {
        stmts.deleteQueueById.run(row.id);
      }
    });
    dropQueue();
    for (const row of rows) {
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'dropped' });
    }
    const afterQueue = queueCounts();
    io.emit('queue_updated', { droppedCount, reason: 'manual-empty-queue' });
    console.log(`[${ts()}] RELAY     queue emptied dropped=${droppedCount}`);
    return res.json({
      ok: true,
      droppedCount,
      queueBefore: beforeQueue,
      queue: afterQueue,
    });
  });

  app.post('/api/relay/shutdown', auth, (req, res) => {
    if (typeof requestRelayShutdown !== 'function') {
      return res.status(501).json({ error: 'Relay shutdown orchestration is unavailable' });
    }
    const reason = String(req.body?.reason || 'manual-request').trim().slice(0, 140) || 'manual-request';
    const requestedBy = String(req.body?.requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
    const rawRestart = req.body?.restart;
    const restart = rawRestart === true
      || rawRestart === 1
      || String(rawRestart || '').trim().toLowerCase() === 'true'
      || String(rawRestart || '').trim() === '1';
    // `immediate` starts it now, without waiting for the running turns (the
    // banner's "Restart now"); the answer names what it did not wait for.
    const rawImmediate = req.body?.immediate;
    const immediate = rawImmediate === true
      || rawImmediate === 1
      || String(rawImmediate || '').trim().toLowerCase() === 'true'
      || String(rawImmediate || '').trim() === '1';
    // The banner's "Restart now" names the queued request it saw (see
    // services/relay-restart-queue.mjs); a stale one is refused.
    const expectRequestedAt = String(req.body?.expectRequestedAt || '').trim().slice(0, 40) || null;
    // An agent may queue a restart, nothing else (agent auth §0.3): it waits
    // for idle as always. A restart now, a plain shutdown, anything that
    // would cut running turns, is the person's. One exception: the `oar`
    // CLI's own token (the cli kind), straight over loopback, may stop the
    // relay and restart it now (`oar stop`, `stop --now`, `restart --now`,
    // `oar uninstall`). That is no boundary: a process of the same user can
    // end the relay anyway; the CLI asks before it does (docs/security.md).
    //
    // "Over loopback" means really local: any forwarding header
    // (X-Forwarded-For, Forwarded, X-Real-IP, X-Forwarded-Proto) means a proxy
    // in front, which connects from 127.0.0.1 for every public request too.
    const principal = principalOf(req);
    const cutsOff = !restart || immediate || !!expectRequestedAt;
    const cliToken = principal?.kind === 'agent' && principal.agentKind === 'c';
    const cliOverLoopback = isCliOverLoopback(principal, req, { isTrulyLocal: isTrulyLocalRequest });
    if (cliOverLoopback && cutsOff) {
      const action = restart ? 'restart-now' : (immediate ? 'stop-now' : 'stop');
      console.log(`[auth] cli stop/restart-now: ${reason} (${action})`);
    } else if (notPerson(req)) {
      if (cutsOff) {
        return res.status(403).json({
          error: cliToken
            ? 'The oar command may stop the relay or restart it now only straight over loopback, with no proxy in between. From here, queued restart only: POST /api/relay/shutdown with { "restart": true, "reason": "..." }.'
            : 'An agent token gets the queued restart only: POST /api/relay/shutdown with { "restart": true, "reason": "..." }. Restarting now or shutting down is the user\'s, in the relay UI.',
          code: AUTH_ERROR_CODES.personRequired,
        });
      }
      const caller = principal?.conversationId ? String(principal.conversationId) : principalLabel(principal);
      console.log(`[auth] agent restart queued by ${caller}: ${reason}`);
    }
    const result = requestRelayShutdown({ reason, requestedBy, restart, immediate, expectRequestedAt });
    return res.json({ ok: true, ...result });
  });

  // Withdraw a queued (not yet started) shutdown/restart. Same trust boundary
  // as queueing one.
  app.post('/api/relay/shutdown/cancel', auth, (req, res) => {
    if (typeof cancelRelayShutdown !== 'function') {
      return res.status(501).json({ error: 'Relay shutdown orchestration is unavailable' });
    }
    const requestedBy = String(req.body?.requestedBy || 'localhost-api').trim().slice(0, 80) || 'localhost-api';
    const result = cancelRelayShutdown({ requestedBy });
    return res.json({ ok: true, ...result });
  });

  // The partial previews of the running image turns: files beside the
  // turn's final images, events to the owner's clients (every socket is the
  // owner's: share views read over HTTP and have none).
  const imagePreviews = createOpenAIImagePreviewTurns({
    resolveSessionStateRoot,
    sessionIdFor: (conversationId) => String(stmts.getConvAnyStatus?.get?.(conversationId)?.sdk_session_id || '').trim() || conversationId,
    emit: (event, payload) => io?.emit?.(event, payload),
    ...(openAIImagePreviewLeftoverMs !== undefined ? { leftoverMs: openAIImagePreviewLeftoverMs } : {}),
  });

  const { imageTurnRequeueStop } = registerMessagesImageRoutes(app, deps, { imageSpend, imagePreviews });

  registerMessagesWorkerOutputRoutes(app, deps, {
    taskOutputSnapshots,
    pokeTaskHealth,
    fetchUsageSummary,
    usageLimitPauseService,
    claudeApiClaimCheck,
    getClaudeApiCapState,
    claudeApiStopLedger,
    opaqueResponseRecoveryWaitMs,
    opaqueResponseRecoveryPollMs,
    relayQuestionFinalizationHoldMs,
    relayEventService,
    sessionActivityTracker,
    resolveConversationRecord,
    readBridgeIdentity,
    failQueueMessage,
    cancelPendingRelayQuestionsForMessage,
    normalizeConsumedSteerEntries,
    settleRelayAbortControlsForQueueMessage,
    settleRelaySubagentAbortControlsForQueueMessage,
    emitSessionWorkerTelemetry,
    emitSubagentStatus,
    insertRelayControlRequest,
    staleAttemptLog,
    subagentTimeline,
    imageSpend,
    imagePreviews,
  });

  // POST /api/conversation/:conversationId/background-task/:taskId/stop —
  // fire-and-forget stop push to the conversation's session worker. The
  // resulting background_tasks_changed replaces the panel's set.
  app.post('/api/conversation/:conversationId/background-task/:taskId/stop', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    const taskId = String(req.params.taskId || '').trim();
    if (!conversationId || !taskId) return res.status(400).json({ error: 'Missing conversationId or taskId' });
    const conversation = stmts.getConvAnyStatus?.get?.(conversationId) || null;
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const sessionId = String(conversation.sdk_session_id || conversationId);
    const sent = sendWorkerControl?.(sessionId, { type: 'stop_background_task', taskId });
    if (!sent) return res.status(409).json({ error: 'Session worker is not connected' });
    console.log(`[${ts()}] BG-TASK STOP ${taskId} conv=${conversationId.slice(0, 8)}`);
    res.json({ ok: true });
  });

  // ─── Task console ──────────────────────────────────────────────────────────

  // The task a conversation's console asks for: in the live or the ended set
  // of the conversation, under its own id or its worker's session id (the
  // key the worker posts under), as the stop route resolves it.
  function findConversationTask(conversationId, taskId) {
    const conversation = stmts.getConvAnyStatus?.get?.(conversationId) || null;
    if (!conversation) return { conversation: null, found: null, sessionId: '' };
    const sessionId = String(conversation.sdk_session_id || conversationId);
    const found = backgroundTaskStore?.findTask?.([conversationId, sessionId], taskId) || null;
    return { conversation, found, sessionId };
  }

  // The providers whose workers name a shell task's output (a file, a spool
  // or a snapshot). A task of theirs without one comes from a worker that
  // started before the console existed.
  const TASK_OUTPUT_PROVIDERS = new Set(['claude', 'github', 'copilot', 'grok', 'deepseek', 'claude-api']);
  const SUBAGENT_OUTPUT_MESSAGE = TASK_OUTPUT_NONE_MESSAGES.subagent;

  // Why a task has no output to show, for the console's `none` answer. The
  // texts are the page's own (task-console-render.mjs), so the row's hover
  // title and the console say the same.
  function noOutputMessage(conversationId, task) {
    if (taskKindOf(task?.taskType) === 'subagent') return SUBAGENT_OUTPUT_MESSAGE;
    let provider = '';
    try {
      provider = String(stmts.getRuntimeSessionByConversation?.get?.(conversationId)?.provider_type || '').trim().toLowerCase();
    } catch {}
    if (!provider || TASK_OUTPUT_PROVIDERS.has(provider)) {
      return TASK_OUTPUT_NONE_MESSAGES.noOutputFile;
    }
    return TASK_OUTPUT_NONE_MESSAGES.provider;
  }

  // A task the session's task list shows that the task store does not hold:
  // a sub-agent (live or ended, its run is its record) or a task that ended
  // without a console. The activity tracker knows it by its task or run id.
  function trackedTask(conversationId, taskId) {
    let view = null;
    try { view = sessionActivityTracker?.describe?.(conversationId) || null; } catch {}
    const tasks = Array.isArray(view?.tasks) ? view.tasks : [];
    const found = tasks.find((task) => !task?.placeholder && (String(task?.id || '') === taskId || String(task?.runId || '') === taskId));
    if (found) return found;
    const run = stmts.getSubagentRun?.get?.(taskId) || null;
    if (run && String(run.conversation_id || '') === conversationId) {
      return { id: taskId, kind: 'subagent', type: run.subagent_type || null, description: run.display_name || '', status: run.status || null };
    }
    return null;
  }

  function taskStallMinutes() {
    try {
      return getTaskStallMinutes();
    } catch {
      return DEFAULT_TASK_STALL_MINUTES;
    }
  }

  // GET /api/conversation/:conversationId/background-task/:taskId/output —
  // the console's read of a shell or Monitor task's output. Without
  // `before`: the last `lines` lines (default 2,000, at most 5,000) within
  // 256 KB; with `before` (a startOffset of an earlier answer): the lines
  // ending there. Everything is cleaned (controls out, colours kept,
  // credentials scrubbed) for every reader. Another relay's agent reads it
  // too (relay_tool read_task_output, read permission): no inbound switch,
  // nothing it reads changes anything.
  app.get('/api/conversation/:conversationId/background-task/:taskId/output', auth, async (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    const taskId = String(req.params.taskId || '').trim();
    if (!conversationId || !taskId) return res.status(400).json({ error: 'Missing conversationId or taskId' });
    const { conversation, found, sessionId } = findConversationTask(conversationId, taskId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!found) {
      const tracked = trackedTask(conversationId, taskId);
      if (!tracked) return res.status(404).json({ error: 'Task not found', code: 'task-not-found' });
      const running = String(tracked.status || 'running') === 'running';
      const subagent = tracked.kind !== 'shell';
      return res.json({
        ok: true,
        taskId,
        kind: 'none',
        ended: !running,
        status: running ? 'running' : String(tracked.status || 'unknown'),
        exitCode: running ? null : (Number.isInteger(tracked.exitCode) ? tracked.exitCode : null),
        health: null,
        taskStallMinutes: taskStallMinutes(),
        task: {
          taskId,
          taskType: tracked.type || (subagent ? 'local_agent' : 'local_bash'),
          description: String(tracked.description || ''),
          startedAt: Date.parse(tracked.startedAt) || null,
          endedAt: Date.parse(tracked.endedAt) || null,
          stoppable: false,
        },
        message: subagent ? SUBAGENT_OUTPUT_MESSAGE : noOutputMessage(conversationId, { taskType: 'local_bash' }),
      });
    }
    const { task, ended, key } = found;
    // Held since a relay restart: its worker has not said yet whether it
    // still runs, so it is neither running nor stoppable.
    const held = !ended && found.restored === true;
    const { kind, path } = taskOutputSource(task);
    const head = {
      ok: true,
      taskId,
      kind,
      ended,
      status: ended ? task.status : (held ? 'held' : 'running'),
      ...(held ? { held: true } : {}),
      exitCode: ended ? (task.exitCode ?? null) : null,
      health: task.health || null,
      taskStallMinutes: taskStallMinutes(),
      task: {
        taskId,
        taskType: task.taskType || null,
        description: task.description || '',
        ...(task.command ? { command: task.command } : {}),
        startedAt: task.startedAt || null,
        endedAt: task.endedAt || null,
        stoppable: !ended && !held && task.stoppable !== false,
      },
    };
    if (kind === 'none') {
      return res.json({ ...head, message: noOutputMessage(conversationId, task) });
    }
    if (kind === 'snapshot') {
      // The worker answers a request with a post of the task's last 8 KiB;
      // the console asks again every few seconds and gets the newest copy.
      const cached = taskOutputSnapshots?.get?.([key, sessionId, conversationId], taskId) || null;
      if (!ended) {
        const sent = sendWorkerControl?.(sessionId, { type: 'task_output_snapshot', taskId });
        if (!sent && !cached) return res.status(409).json({ error: 'Session worker is not connected', code: 'worker-not-connected' });
      }
      if (!cached) return res.json({ ...head, pending: true, text: '', lines: [], startOffset: 0, endOffset: 0, size: 0, mtime: null, hasMoreBefore: false });
      return res.json({ ...head, ...shapeSnapshot(cached) });
    }
    if (!path) return res.json({ ...head, kind: 'none', message: TASK_OUTPUT_NONE_MESSAGES.noPath });
    const lines = req.query?.lines;
    const before = req.query?.before;
    const read = before !== undefined && before !== ''
      ? await readBefore(path, { before, lines })
      : await readTail(path, { lines });
    if (!read.ok) {
      // No file yet (a spool is named before its first byte) reads as no
      // output yet; one the relay does not read (a symlink, a folder) is
      // said so instead of failing.
      const empty = { text: '', lines: [], startOffset: 0, endOffset: 0, size: 0, mtime: null, hasMoreBefore: false };
      return res.json({ ...head, ...empty, ...(read.code === 'missing' ? {} : { unavailable: read.code }) });
    }
    return res.json({ ...head, ...read });
  });

  // GET /api/conversation/:conversationId/subagent/:subagentRunId — one run's
  // record for the viewer: header, entries after `after` (plus open ones),
  // child runs. `complete` is false when more entries follow this page.
  app.get('/api/conversation/:conversationId/subagent/:subagentRunId', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    const runId = sanitizeSubagentRunId(req.params.subagentRunId);
    if (!conversationId || !runId) return res.status(400).json({ error: 'Missing conversationId or subagentRunId' });
    const run = stmts.getSubagentRun?.get?.(runId) || null;
    if (!run || String(run.conversation_id || '') !== conversationId) {
      return res.status(404).json({ error: 'Sub-agent run not found' });
    }
    const page = subagentTimeline.readTimeline(run, {
      afterSeq: Number(req.query?.after) || 0,
      limit: Number(req.query?.limit) || TIMELINE_READ_DEFAULT_LIMIT,
      isStoppable: isSubagentRunStoppable,
    });
    const task = liveTaskForSubagentRun(run);
    if (page.run && task?.taskId) page.run.taskId = page.run.taskId || task.taskId;
    res.json(page);
  });

  registerMessagesWorkerRequeueRoute(app, deps, {
    failQueueMessage,
    failConsumedQueueRow,
    settleRelayAbortControlsForQueueMessage,
    settleRelaySubagentAbortControlsForQueueMessage,
    emitSessionWorkerTelemetry,
    staleAttemptLog,
    imagePreviews,
    imageTurnRequeueStop,
  });
}
