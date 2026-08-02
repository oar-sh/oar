'use strict';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import {
  shouldParkForRestart,
  parkPendingQueueForRestart,
  releaseParkedQueueForReadyState,
} from '../services/relay-queue-gate-service.mjs';
import {
  persistConversationModelPreference as persistConversationModelPreferenceTx,
} from '../services/conversation-preferences-service.mjs';
import { killTmuxSession } from '../services/session-worker-launch-service.mjs';
import {
  fetchUsageSummaryPromise,
  staleUsageSnapshotFromRow,
  usageSnapshotFromRow,
  usageSnapshotFromSummary,
} from '../services/usage-snapshot-helpers.mjs';
import { openAIReasoningEffortsForModel } from '../../shared/openai-reasoning.mjs';
import { claudeBaseModelId, claudeLongContextModelId } from '../../shared/model-id.mjs';

export const SESSION_WORKER_OWNER_LEASE_MS = 120_000;
export const SESSION_WORKER_TRANSIENT_DEQUEUE_RETRIES = 2;
export const SESSION_WORKER_TRANSIENT_DEQUEUE_BACKOFF_MS = 25;
const SESSION_WORKER_IDLE_RECOVERY_GRACE_MS = 5_000;
const DUPLICATE_USER_MESSAGE_WINDOW_MS = 10 * 60 * 1000;
const OPAQUE_RESPONSE_TEXT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_RESPONSE_RECOVERY_WAIT_MS = 600_000;
const OPAQUE_RESPONSE_RECOVERY_POLL_MS = 250;
const STRANDED_SESSION_PRIME_COOLDOWN_MS = 10_000;
const STRANDED_SESSION_HEARTBEAT_FRESH_MS = 15_000;
// Hold finalization after a relay question is answered so the SDK has time to fire the next
// onUserInputRequest (multi-step ask_user). Without this, the transcript is used prematurely and
// the queue row is marked done while additional questions are still pending.
const RELAY_QUESTION_FINALIZATION_HOLD_MS = 5_000;
const AUTO_MODEL_SENTINEL = 'auto';
const USAGE_FETCH_RETRY_DELAY_MS = 250;

export function resolveOpenAIReasoningEffort(explicitReasoningEffort = '', model = '') {
  const explicit = String(explicitReasoningEffort || '').trim().toLowerCase();
  const supported = openAIReasoningEffortsForModel(model);
  if (explicit && !supported.includes(explicit)) {
    return {
      ok: false,
      effort: null,
      supported,
      error: `OpenAI model "${String(model || 'configured model').trim()}" does not support reasoning effort "${explicit}"`,
    };
  }
  const fallback = supported.includes('none') ? 'none' : (supported[0] || null);
  return { ok: true, effort: explicit || fallback, supported };
}

// runtimeBoundToOtherProvider covers sessions already pinned to a non-OpenAI
// provider (Claude, Cursor). Those resolve model ids against their own catalog,
// and providers reuse each other's ids, so matching the configured OpenAI model
// id there says nothing about the request targeting OpenAI.
export function shouldRequireNewOpenAIConversation({
  shouldCreateConversation = false,
  runtimeUsesOpenAI = false,
  requestedConfiguredOpenAIModel = false,
  githubModelAvailable = false,
  runtimeBoundToOtherProvider = false,
} = {}) {
  return (
    !shouldCreateConversation
    && !runtimeUsesOpenAI
    && !runtimeBoundToOtherProvider
    && requestedConfiguredOpenAIModel
    && !githubModelAvailable
  );
}

function normalizeRequestedProviderType(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-byok' || normalized === 'openai-image') return 'openai';
  if (normalized === 'github' || normalized === 'github-copilot') return 'github';
  if (normalized === 'cursor') return 'cursor';
  return '';
}

function deriveModelOrigin(model) {
  const requested = String(model || '').trim().toLowerCase();
  if (!requested) return null;
  return requested === AUTO_MODEL_SENTINEL ? 'auto' : 'manual';
}

function isAutoModel(model) {
  return String(model || '').trim().toLowerCase() === AUTO_MODEL_SENTINEL;
}

function isOpenAIImageModelId(model = '') {
  const normalized = String(model || '').trim().toLowerCase().replace(/^openai\//, '');
  return normalized.startsWith('gpt-image-') || normalized.startsWith('dall-e-');
}

const OPENAI_IMAGE_QUALITY_VALUES = new Set(['auto', 'low', 'medium', 'high']);
const OPENAI_IMAGE_SIZE_VALUES = new Set([
  'auto',
  '256x256',
  '512x512',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '1792x1024',
  '1024x1792',
]);

function normalizeOpenAIImageQuality(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return OPENAI_IMAGE_QUALITY_VALUES.has(normalized) ? normalized : '';
}

function normalizeOpenAIImageSize(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (OPENAI_IMAGE_SIZE_VALUES.has(normalized)) return normalized;
  if (normalized === 'default' || normalized === 'long_context') return 'auto';
  return '';
}

function normalizeSessionWorkerId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeDuplicateMessageText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findRecentDuplicateUserMessage({
  recentUserMessages = [],
  recentQueueRows = [],
  text = '',
  now = Date.now(),
  windowMs = DUPLICATE_USER_MESSAGE_WINDOW_MS,
} = {}) {
  const fingerprint = normalizeDuplicateMessageText(text);
  if (!fingerprint) return null;
  const maxAgeMs = Math.max(60_000, Number(windowMs) || DUPLICATE_USER_MESSAGE_WINDOW_MS);

  for (const row of Array.isArray(recentUserMessages) ? recentUserMessages : []) {
    const rowText = normalizeDuplicateMessageText(row?.text || '');
    if (!rowText || rowText !== fingerprint) continue;
    const rowTime = Date.parse(row?.timestamp || '');
    if (!Number.isFinite(rowTime)) continue;
    if ((now - rowTime) <= maxAgeMs) {
      return { source: 'message', messageId: row?.id || null, timestamp: row?.timestamp || null };
    }
  }

  for (const row of Array.isArray(recentQueueRows) ? recentQueueRows : []) {
    const rowText = normalizeDuplicateMessageText(row?.text || '');
    if (!rowText || rowText !== fingerprint) continue;
    const rowTime = Date.parse(row?.timestamp || '');
    if (!Number.isFinite(rowTime)) continue;
    const status = String(row?.status || '').trim().toLowerCase();
    if (['pending', 'processing', 'parked'].includes(status) && (now - rowTime) <= maxAgeMs) {
      return { source: 'queue', messageId: row?.id || null, timestamp: row?.timestamp || null, status };
    }
  }

  return null;
}

function addMsToIso(baseIso, ms) {
  const base = Date.parse(baseIso);
  const offset = Number(ms);
  const safeBase = Number.isFinite(base) ? base : Date.now();
  const safeOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return new Date(safeBase + safeOffset).toISOString();
}

function delay(ms) {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!timeoutMs) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function isTransientQueueError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('database is locked') || message.includes('database busy');
}

function isSessionWorkerRoutingEnabled(featureFlags = null) {
  return featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true;
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

function emitWorkerLoopTelemetry(telemetry, payload = {}) {
  if (typeof telemetry !== 'function') return;
  try {
    telemetry(payload);
  } catch {
    // Never break queue dequeue flow due to telemetry callback failures.
  }
}

function normalizeTerminalErrorCode(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^relay\./, '');
  return text.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || null;
}

function normalizeTerminalErrorText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function looksTerminalSessionLoadError(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  return text.includes('could not be loaded')
    || text.includes('corrupted or incompatible')
    || text.includes('session file is corrupted')
    || text.includes('session not found');
}

export function resolveBlockedWorkerTerminalFailure({
  blockedReason = null,
  requesterSessionId = null,
  lifecycle = null,
  worker = null,
} = {}) {
  const reason = String(blockedReason || '').trim().toLowerCase();
  if (!reason) return null;
  const sessionId = normalizeSessionWorkerId(requesterSessionId || worker?.sdkSessionId);
  const lastError = normalizeTerminalErrorText(
    lifecycle?.lastError
    || worker?.lastError
    || lifecycle?.degradedReason
    || null,
  );
  const base = {
    kind: 'terminal-worker-bootstrap',
    failedAt: new Date().toISOString(),
    blockedReason: reason,
    requesterSessionId: sessionId,
    retryCount: Math.max(0, Number(lifecycle?.retryCount || worker?.retryCount || 0)),
    detail: lastError || null,
  };
  if (reason === 'missing-session-id') {
    return {
      ...base,
      code: 'worker-missing-session-id',
      stableCode: 'relay.worker-missing-session-id',
      message: 'The relay could not route this turn because the target session id is missing.',
      guidance: 'Retry from a valid conversation. If this repeats, refresh the relay UI and try again.',
    };
  }
  if (reason === 'restart-exhausted') {
    return {
      ...base,
      code: 'worker-restart-exhausted',
      stableCode: 'relay.worker-restart-exhausted',
      message: 'The relay exhausted worker restart attempts for this session.',
      guidance: 'Avoid this session for now and create a fresh one. Delete the broken session if you no longer need it.',
    };
  }
  if (reason === 'spawn-failed' && looksTerminalSessionLoadError(lastError)) {
    return {
      ...base,
      code: 'worker-session-load-failed',
      stableCode: 'relay.worker-session-load-failed',
      message: 'The session could not be loaded by the worker runtime.',
      guidance: 'This session is likely corrupted or incompatible. Use a fresh session and delete this one if not needed.',
    };
  }
  return null;
}

export function resolvePrimedWorkerTerminalFailure({
  sessionId = null,
  primeResult = null,
} = {}) {
  const normalizedSessionId = normalizeSessionWorkerId(sessionId || primeResult?.worker?.sdkSessionId);
  if (!primeResult || typeof primeResult !== 'object') return null;

  if (primeResult.ok === false) {
    return resolveBlockedWorkerTerminalFailure({
      blockedReason: primeResult.error,
      requesterSessionId: normalizedSessionId,
      lifecycle: primeResult.lifecycle || null,
      worker: primeResult.worker || null,
    });
  }

  const lifecycle = primeResult.lifecycle && typeof primeResult.lifecycle === 'object'
    ? primeResult.lifecycle
    : null;
  const degradedReason = String(lifecycle?.degradedReason || '').trim().toLowerCase();
  if (String(lifecycle?.uiState || '').trim().toLowerCase() !== 'yellow') return null;

  if (degradedReason === 'stale-pid') {
    return {
      kind: 'terminal-worker-bootstrap',
      code: 'worker-stale-pid',
      stableCode: 'relay.worker-stale-pid',
      message: 'The worker process for this session is no longer alive.',
      guidance: 'Retry once. If this repeats, avoid this session and use a fresh one.',
      detail: normalizeTerminalErrorText(lifecycle?.lastError || degradedReason),
      failedAt: new Date().toISOString(),
      blockedReason: degradedReason,
      requesterSessionId: normalizedSessionId,
      retryCount: Math.max(0, Number(lifecycle?.retryCount || 0)),
    };
  }

  if (degradedReason === 'restart-exhausted' || degradedReason === 'spawn-failed') {
    return resolveBlockedWorkerTerminalFailure({
      blockedReason: degradedReason,
      requesterSessionId: normalizedSessionId,
      lifecycle,
      worker: primeResult.worker || null,
    });
  }

  return null;
}

function extractTerminalId(text, patterns = []) {
  const input = String(text || '');
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = String(match?.[1] || '').trim();
    if (value) return value;
  }
  return null;
}

export function parseTerminalFailureText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const stableCodeMatch = raw.match(/error code:\s*(relay\.[a-z0-9-]+)/i);
  if (!stableCodeMatch) return null;
  const stableCode = String(stableCodeMatch[1] || '').trim().toLowerCase();
  const code = normalizeTerminalErrorCode(stableCode);
  if (!code) return null;
  const message = normalizeTerminalErrorText(raw.slice(0, stableCodeMatch.index).trim().replace(/\s+$/, '.'));
  const detailMatch = raw.match(/details:\s*(.+)$/i);
  return {
    terminal: true,
    code,
    stableCode: `relay.${code}`,
    message,
    detail: normalizeTerminalErrorText(detailMatch?.[1]),
    functionCallId: extractTerminalId(raw, [
      /functioncallid\s*=\s*([a-z0-9_-]+)/i,
      /function call id[:=]\s*([a-z0-9_-]+)/i,
    ]),
    requestId: extractTerminalId(raw, [
      /requestid\s*=\s*([a-z0-9_-]+)/i,
      /request id[:=]\s*([a-z0-9_-]+)/i,
      /\b(req(?:uest)?[_-][a-z0-9_-]+)/i,
    ]),
  };
}

function buildTerminalFailureTextForChat(terminalFailure, fallbackMessage = null) {
  const failure = terminalFailure && typeof terminalFailure === 'object' ? terminalFailure : {};
  const code = normalizeTerminalErrorCode(failure.code || failure.stableCode) || 'unknown-terminal';
  const stableCode = `relay.${code}`;
  const message = normalizeTerminalErrorText(failure.message)
    || normalizeTerminalErrorText(fallbackMessage)
    || 'The relay runtime hit a terminal error and could not complete this turn.';
  const guidance = normalizeTerminalErrorText(failure.guidance)
    || 'Retry the message. If this keeps failing, restart the relay and include the error code.';
  const detail = normalizeTerminalErrorText(failure.detail);
  const ids = [
    normalizeTerminalErrorText(failure.functionCallId) ? `functionCallId=${failure.functionCallId}` : null,
    normalizeTerminalErrorText(failure.requestId) ? `requestId=${failure.requestId}` : null,
  ].filter(Boolean);
  return [
    message,
    `Error code: ${stableCode}.`,
    ids.length ? `IDs: ${ids.join(', ')}.` : null,
    guidance,
    detail ? `Details: ${detail}` : null,
  ].filter(Boolean).join(' ');
}

function isOpaqueResponseText(value) {
  const text = String(value || '').trim();
  return !!text && OPAQUE_RESPONSE_TEXT_PATTERN.test(text);
}

function findResolvedTranscriptAssistantText({
  conversation = null,
  queueTimestamp = null,
  readSessionTranscriptMessages = null,
} = {}) {
  if (typeof readSessionTranscriptMessages !== 'function') return '';
  const sdkSessionId = String(conversation?.sdk_session_id || conversation?.id || '').trim();
  if (!sdkSessionId) return '';

  const transcriptMessages = readSessionTranscriptMessages(sdkSessionId, { limit: 200 });
  if (!Array.isArray(transcriptMessages) || !transcriptMessages.length) return '';

  const queuedAt = Date.parse(String(queueTimestamp || '').trim());
  const assistantMessages = transcriptMessages
    .filter((message) => String(message?.role || '').trim().toLowerCase() === 'assistant')
    .map((message) => ({
      text: String(message?.text || '').trim(),
      timestampMs: Date.parse(String(message?.timestamp || '').trim()) || 0,
    }))
    .filter((message) => !!message.text);

  if (!assistantMessages.length) return '';

  const nonOpaqueMessages = assistantMessages.filter((message) => !isOpaqueResponseText(message.text));
  if (!Number.isFinite(queuedAt)) {
    return nonOpaqueMessages[nonOpaqueMessages.length - 1]?.text
      || assistantMessages[assistantMessages.length - 1]?.text
      || '';
  }

  const afterQueuedAt = assistantMessages.filter((message) => message.timestampMs >= queuedAt);
  if (!afterQueuedAt.length) return '';
  const nonOpaqueAfterQueuedAt = afterQueuedAt.filter((message) => !isOpaqueResponseText(message.text));
  return nonOpaqueAfterQueuedAt[nonOpaqueAfterQueuedAt.length - 1]?.text || '';
}

async function resolveRelayResponseText({
  text = '',
  conversation = null,
  queueTimestamp = null,
  readSessionTranscriptMessages = null,
  opaqueResponseRecoveryWaitMs = OPAQUE_RESPONSE_RECOVERY_WAIT_MS,
  opaqueResponseRecoveryPollMs = OPAQUE_RESPONSE_RECOVERY_POLL_MS,
  messageId = null,
  checkHasActiveRelayQuestion = null,
} = {}) {
  const rawText = String(text || '').trim();
  if (!isOpaqueResponseText(rawText)) return rawText;

  const maxWaitMs = Math.max(0, Number(opaqueResponseRecoveryWaitMs) || 0);
  const pollMs = Math.max(1, Number(opaqueResponseRecoveryPollMs) || OPAQUE_RESPONSE_RECOVERY_POLL_MS);
  const deadline = Date.now() + maxWaitMs;

  while (true) {
    // Don't finalize while there's a pending relay question or a recently-answered one for this
    // message. The SDK may fire another onUserInputRequest shortly after an answer is returned
    // (multi-step ask_user). Consuming transcript text before that window expires would mark the
    // queue row done and cause subsequent onUserInputRequest calls to get a 409.
    const hasActiveQuestion = messageId && typeof checkHasActiveRelayQuestion === 'function'
      ? checkHasActiveRelayQuestion(messageId)
      : false;

    if (!hasActiveQuestion) {
      const transcriptText = findResolvedTranscriptAssistantText({
        conversation,
        queueTimestamp,
        readSessionTranscriptMessages,
      });
      if (transcriptText) return transcriptText;
    }
    if (Date.now() >= deadline) return rawText;
    await delay(pollMs);
  }
}

export function resolveTerminalFailurePayload(payload = {}, { fallbackText = null } = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const parsedTextFailure = parseTerminalFailureText(body.text);
  const direct = body.terminalError && typeof body.terminalError === 'object'
    ? body.terminalError
    : null;
  const explicitCode = normalizeTerminalErrorCode(
    direct?.stableCode
    || direct?.code
    || body.terminalErrorCode
    || body.errorCode,
  );
  const explicitMessage = normalizeTerminalErrorText(
    direct?.message
    || body.terminalErrorMessage
    || body.errorMessage,
  );
  const explicitDetail = normalizeTerminalErrorText(
    direct?.detail
    || body.terminalErrorDetail
    || body.errorDetail,
  );
  const explicitGuidance = normalizeTerminalErrorText(
    direct?.guidance
    || body.terminalErrorGuidance
    || body.errorGuidance,
  );
  const functionCallId = normalizeTerminalErrorText(
    direct?.functionCallId
    || body.functionCallId,
  );
  const requestId = normalizeTerminalErrorText(
    direct?.requestId
    || body.requestId,
  );

  const terminalRequested = body.terminal === true
    || body.isTerminal === true
    || body.terminalError === true
    || body.errorKind === 'terminal'
    || !!direct
    || !!parsedTextFailure;
  if (!terminalRequested) return null;

  const code = explicitCode
    || normalizeTerminalErrorCode(parsedTextFailure?.code)
    || 'unknown-terminal';
  return {
    terminal: true,
    code,
    stableCode: `relay.${code}`,
    message: explicitMessage || parsedTextFailure?.message || normalizeTerminalErrorText(fallbackText),
    detail: explicitDetail || parsedTextFailure?.detail || null,
    guidance: explicitGuidance || null,
    functionCallId: functionCallId || parsedTextFailure?.functionCallId || null,
    requestId: requestId || parsedTextFailure?.requestId || null,
  };
}

export function extractRestartTerminalOutcome(orchestratorState = null) {
  const state = orchestratorState && typeof orchestratorState === 'object' ? orchestratorState : null;
  if (!state) return null;
  const code = String(state.terminalOutcomeCode || state.terminalOutcome || '').trim();
  if (!code) return null;
  return {
    phase: String(state.terminalOutcomePhase || '').trim() || null,
    code,
    message: String(state.terminalOutcomeMessage || '').trim() || null,
    attempts: Math.max(0, Number(state.terminalOutcomeAttempts || 0)),
    at: String(state.terminalOutcomeAt || '').trim() || null,
  };
}

export function buildFallbackRestartCompatibilityPayload({
  failureClass = null,
  requesterSessionId = null,
  relayRestartOrchestrator = null,
  inFlightProcessingCount = 0,
} = {}) {
  const currentState = relayRestartOrchestrator?.getState?.() || null;
  return {
    enabled: false,
    considered: false,
    requested: false,
    skipped: 'removed-single-runtime-fallback',
    failureClass: String(failureClass || '').trim().toLowerCase() || null,
    targetSessionId: normalizeSessionWorkerId(requesterSessionId),
    inFlightProcessingCount: Math.max(0, Number(inFlightProcessingCount || 0)),
    terminalOutcome: extractRestartTerminalOutcome(currentState),
    orchestratorState: currentState,
    restartRequest: null,
  };
}

export function resolveInitialQueueOwnerSessionId({
  routingEnabled = false,
  requesterSessionId = null,
  runtimeSession = null,
  conversationSdkSessionId = null,
  conversationId = null,
  isNewConversation = false,
} = {}) {
  if (!routingEnabled) return null;
  const runtimeSdkSessionId = normalizeSessionWorkerId(runtimeSession?.sdk_session_id);
  const boundConversationSessionId = normalizeSessionWorkerId(conversationSdkSessionId);
  const normalizedConversationId = normalizeSessionWorkerId(conversationId);
  const unboundConversation = !runtimeSdkSessionId && !boundConversationSessionId;
  if (normalizedConversationId && (isNewConversation || unboundConversation)) {
    return normalizedConversationId;
  }
  return normalizeSessionWorkerId(
    runtimeSdkSessionId
    || boundConversationSessionId
    || requesterSessionId,
  );
}

export function validateSubagentRunBinding({
  queueRow = null,
  messageId = '',
  conversationId = '',
  existingRun = null,
} = {}) {
  const normalizedMessageId = String(messageId || '').trim();
  const normalizedConversationId = String(conversationId || '').trim();
  if (!queueRow || typeof queueRow !== 'object') {
    return { ok: false, statusCode: 404, error: 'Queue message not found' };
  }
  const queueConversationId = String(queueRow.conversation_id || '').trim();
  if (!queueConversationId) {
    return { ok: false, statusCode: 409, error: 'Queue message is missing conversation binding' };
  }
  if (normalizedConversationId && queueConversationId !== normalizedConversationId) {
    return { ok: false, statusCode: 409, error: 'Queue message conversation mismatch' };
  }
  if (existingRun && typeof existingRun === 'object') {
    const runConversationId = String(existingRun.conversation_id || '').trim();
    const runMessageId = String(existingRun.queue_message_id || '').trim();
    if (runConversationId && runConversationId !== queueConversationId) {
      return { ok: false, statusCode: 409, error: 'Subagent run conversation mismatch' };
    }
    if (runMessageId && normalizedMessageId && runMessageId !== normalizedMessageId) {
      return { ok: false, statusCode: 409, error: 'Subagent run message mismatch' };
    }
  }
  return { ok: true, conversationId: queueConversationId };
}

export function shouldAutoPrimeStrandedSession({
  strandedRow = null,
  requesterSessionId = null,
} = {}) {
  const ownerSessionId = normalizeSessionWorkerId(strandedRow?.owner_sdk_session_id);
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  if (!ownerSessionId || !requesterSid) return false;
  if (ownerSessionId === requesterSid) return false;
  const rawRetryCount = Number(strandedRow?.retry_count);
  if (!Number.isFinite(rawRetryCount)) return false;
  const retryCount = Math.max(0, Math.trunc(rawRetryCount));
  if (retryCount > 0) return false;
  return true;
}

export function shouldTakeOverStrandedPendingMessage({
  strandedRow = null,
  requesterSessionId = null,
  primeResult = null,
  strandedLifecycle = null,
  nowMs = Date.now(),
  heartbeatFreshWindowMs = STRANDED_SESSION_HEARTBEAT_FRESH_MS,
} = {}) {
  if (!shouldAutoPrimeStrandedSession({ strandedRow, requesterSessionId })) return false;
  const lifecycle = (primeResult && typeof primeResult.lifecycle === 'object')
    ? primeResult.lifecycle
    : (strandedLifecycle && typeof strandedLifecycle === 'object' ? strandedLifecycle : null);
  if (!lifecycle) return false;
  const awaitingHeartbeat = lifecycle.awaitingHeartbeat === true;
  const degradedReason = String(lifecycle.degradedReason || '').trim().toLowerCase();
  const heartbeatAtMs = Date.parse(String(lifecycle.lastHeartbeatAt || '').trim());
  const heartbeatWindowMs = Math.max(1_000, Number(heartbeatFreshWindowMs) || STRANDED_SESSION_HEARTBEAT_FRESH_MS);
  const heartbeatFresh = Number.isFinite(heartbeatAtMs) && (nowMs - heartbeatAtMs) < heartbeatWindowMs;
  if (heartbeatFresh) return false;
  if (awaitingHeartbeat) return true;
  return degradedReason === 'startup-heartbeat-timeout' || degradedReason === 'stale-pid';
}

export function dequeuePendingMessage({
  db,
  stmts,
  nowIso,
  routingEnabled = false,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
  affinityOnly = false,
} = {}) {
  const currentIso = String(nowIso || '').trim() || new Date().toISOString();
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  const leaseExpiresAt = requesterSid ? addMsToIso(currentIso, ownerLeaseMs) : null;
  const dequeue = db.transaction(() => {
    let next = null;
    if (routingEnabled && requesterSid && stmts.findPendingForWorker) {
      next = stmts.findPendingForWorker.get(currentIso, requesterSid, requesterSid);
      // In routed worker mode, never fall back to the global queue. If this
      // worker has no matching owned/unowned work, another worker session must
      // pick up the turn instead of letting the wrong session steal it.
      if (!next) return null;
    } else if (!routingEnabled && requesterSid && stmts.findPendingForSessionAffinity) {
      next = stmts.findPendingForSessionAffinity.get(currentIso, requesterSid);
    }
    if (!next && affinityOnly) return null;
    if (!next) {
      next = stmts.findPending.get(currentIso);
    }
    if (!next) return null;
    if (routingEnabled && requesterSid && stmts.setProcessingWithWorkerLease) {
      stmts.setProcessingWithWorkerLease.run(currentIso, requesterSid, currentIso, leaseExpiresAt, currentIso, next.id);
      return {
        ...next,
        status: 'processing',
        processing_at: currentIso,
        owner_sdk_session_id: String(next.owner_sdk_session_id || '').trim() || requesterSid,
        owner_assigned_at: String(next.owner_assigned_at || '').trim() || currentIso,
        owner_lease_expires_at: leaseExpiresAt,
        owner_last_claimed_at: currentIso,
      };
    }
    stmts.setProcessing.run(currentIso, next.id);
    return {
      ...next,
      status: 'processing',
      processing_at: currentIso,
    };
  });
  return dequeue();
}

export function shouldFailRecoveredProcessingRow({
  reason = null,
  relayActivityCount = 0,
  relayStreamCount = 0,
} = {}) {
  const normalizedReason = String(reason || '').trim().toLowerCase();
  if (normalizedReason !== 'owner-heartbeat-idle') return false;
  return Math.max(0, Number(relayActivityCount || 0)) > 0
    || Math.max(0, Number(relayStreamCount || 0)) > 0;
}

export function buildHeartbeatIdleReplayFailure({
  requesterSessionId = null,
} = {}) {
  const normalizedSessionId = normalizeSessionWorkerId(requesterSessionId);
  return {
    kind: 'turn-aborted',
    error: 'turn-replay-blocked',
    code: 'turn-replay-blocked',
    stableCode: 'relay.turn-replay-blocked',
    message: 'System note: This turn had already started before the relay lost its active worker state, so it was ended instead of being replayed.',
    guidance: 'Send the message again if you still want that work to run.',
    failedAt: new Date().toISOString(),
    requesterSessionId: normalizedSessionId,
  };
}

export async function dequeuePendingMessageForWorkerLoop({
  db,
  stmts,
  nowIso,
  routingEnabled = false,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
  affinityOnly = false,
  sessionWorkerSupervisor = null,
  transientRetryLimit = SESSION_WORKER_TRANSIENT_DEQUEUE_RETRIES,
  transientRetryBackoffMs = SESSION_WORKER_TRANSIENT_DEQUEUE_BACKOFF_MS,
  relayRestartOrchestrator = null,
  inFlightProcessingCount = 0,
  telemetry = null,
} = {}) {
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  const routingWithWorker = routingEnabled && requesterSid;
  const retryLimit = Math.max(0, Number(transientRetryLimit) || 0);
  const backoffBaseMs = Math.max(1, Number(transientRetryBackoffMs) || 1);
  const supervisor = sessionWorkerSupervisor || null;

  if (routingWithWorker && typeof supervisor?.ensureWorker === 'function') {
    const killBlocked = supervisor?.isKillBlocked?.(requesterSid) === true;
    if (killBlocked) {
      const lifecycle = supervisor?.getLifecycleState?.(requesterSid) || null;
      const fallbackRestart = buildFallbackRestartCompatibilityPayload({
        failureClass: 'session-killed',
        requesterSessionId: requesterSid,
        relayRestartOrchestrator,
        inFlightProcessingCount,
      });
      emitWorkerLoopTelemetry(telemetry, {
        event: 'worker.ensure.blocked',
        sessionId: requesterSid,
        workerId: supervisor?.getWorkerState?.(requesterSid)?.workerId || null,
        conversationId: supervisor?.getWorkerState?.(requesterSid)?.conversationId || null,
        messageId: null,
        continuationId: null,
        state: supervisor?.getWorkerState?.(requesterSid)?.status || 'error',
        retry: lifecycle?.retryCount || 0,
        pid: supervisor?.getWorkerState?.(requesterSid)?.pid || null,
        blockedReason: 'session-killed',
        queue: null,
      });
      return {
        message: null,
        blockedReason: 'session-killed',
        worker: supervisor?.getWorkerState?.(requesterSid) || null,
        lifecycle,
        fallbackRestart,
        attempts: 0,
      };
    }
    const ensureResult = await supervisor.ensureWorker(requesterSid);
    if (!ensureResult?.ok) {
      const fallbackRestart = buildFallbackRestartCompatibilityPayload({
        failureClass: ensureResult?.error || null,
        requesterSessionId: requesterSid,
        relayRestartOrchestrator,
        inFlightProcessingCount,
      });
      emitWorkerLoopTelemetry(telemetry, {
        event: 'worker.ensure.blocked',
        sessionId: requesterSid,
        workerId: ensureResult?.worker?.workerId || null,
        conversationId: ensureResult?.worker?.conversationId || null,
        messageId: null,
        continuationId: null,
        state: ensureResult?.worker?.status || 'error',
        retry: ensureResult?.lifecycle?.retryCount || 0,
        pid: ensureResult?.worker?.pid || null,
        blockedReason: String(ensureResult?.error || 'worker-unavailable').trim() || 'worker-unavailable',
        queue: null,
      });
      return {
        message: null,
        blockedReason: String(ensureResult?.error || 'worker-unavailable').trim() || 'worker-unavailable',
        worker: ensureResult?.worker || null,
        lifecycle: ensureResult?.lifecycle || null,
        fallbackRestart,
        attempts: 0,
      };
    }
  }

  let attempt = 0;
  while (attempt <= retryLimit) {
    const currentIso = String(nowIso || '').trim() || new Date().toISOString();
    try {
      const message = dequeuePendingMessage({
        db,
        stmts,
        nowIso: currentIso,
        routingEnabled,
        requesterSessionId: requesterSid,
        ownerLeaseMs,
        affinityOnly,
      });
      emitWorkerLoopTelemetry(telemetry, {
        event: message ? 'queue.dequeue.success' : 'queue.dequeue.empty',
        sessionId: requesterSid,
        workerId: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid)?.workerId || null) : null,
        conversationId: message?.conversation_id || null,
        messageId: message?.id || null,
        continuationId: null,
        state: message ? 'processing' : 'ready',
        retry: attempt,
        pid: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid)?.pid || null) : null,
        queue: null,
      });
      if (message) {
        const dequeuedAtMs = Date.parse(currentIso);
        const queuedAtMs = Date.parse(String(message?.timestamp || '').trim());
        const queueWaitMs = Number.isFinite(dequeuedAtMs) && Number.isFinite(queuedAtMs)
          ? Math.max(0, dequeuedAtMs - queuedAtMs)
          : null;
      }
      return {
        message,
        blockedReason: null,
        worker: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid) || null) : null,
        lifecycle: routingWithWorker ? (supervisor?.getLifecycleState?.(requesterSid) || null) : null,
        attempts: attempt + 1,
      };
    } catch (error) {
      const transient = isTransientQueueError(error);
      emitWorkerLoopTelemetry(telemetry, {
        event: transient && attempt < retryLimit ? 'queue.dequeue.retry' : 'queue.dequeue.error',
        sessionId: requesterSid,
        workerId: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid)?.workerId || null) : null,
        conversationId: null,
        messageId: null,
        continuationId: null,
        state: 'error',
        retry: attempt + 1,
        pid: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid)?.pid || null) : null,
        queue: null,
        error: String(error?.message || error || 'dequeue-failed'),
      });
      if (!routingWithWorker || !transient || attempt >= retryLimit) {
        if (routingWithWorker && typeof supervisor?.markError === 'function') {
          supervisor.markError(requesterSid, error);
        }
        throw error;
      }
      const backoffMs = Math.min(500, backoffBaseMs * (2 ** attempt));
      await delay(backoffMs);
      attempt += 1;
    }
  }

  return {
    message: null,
    blockedReason: 'dequeue-retry-exhausted',
    worker: routingWithWorker ? (supervisor?.getWorkerState?.(requesterSid) || null) : null,
    lifecycle: routingWithWorker ? (supervisor?.getLifecycleState?.(requesterSid) || null) : null,
    attempts: retryLimit + 1,
  };
}

export function buildDequeuedRelayMessage({
  msg,
  stmts,
  parseAttachments = () => [],
  hydrateAttachment = (value) => value,
  ensureRuntimeSessionBinding,
  configuredConversationSessionMode,
  normalizeRelayMode,
  defaultRelayMode,
  defaultModel,
} = {}) {
  if (!msg) return null;
  const attachments = parseAttachments(msg.attachments).map(hydrateAttachment).filter(Boolean);
  const attachmentPromptContext = buildAttachmentPromptContext(attachments);
  let runtimeSession = msg.runtime_session_id ? stmts.getRuntimeSessionById.get(msg.runtime_session_id) : null;
  if (!runtimeSession) {
    const now = new Date().toISOString();
    runtimeSession = ensureRuntimeSessionBinding(
      msg.conversation_id,
      String(msg.model || '').trim() || null,
      now,
    );
    if (runtimeSession?.id && runtimeSession.id !== msg.runtime_session_id) {
      stmts.setQueueRuntimeSession.run(runtimeSession.id, msg.id);
    }
  }
  return {
    id: msg.id,
    conversationId: msg.conversation_id,
    runtimeSessionId: runtimeSession?.id || null,
    isNewConversation: msg.is_new_conversation === 1,
    model: String(msg.model || '').trim() || defaultModel,
    modelVariantId: String(msg.model_variant_id || '').trim() || String(msg.model || '').trim() || null,
    providerType: String(runtimeSession?.provider_type || '').trim().toLowerCase() || null,
    providerModel: String(runtimeSession?.provider_model || '').trim() || null,
    claudeNativeSessionId: String(runtimeSession?.claude_native_session_id || '').trim() || null,
    cursorAgentId: String(runtimeSession?.cursor_agent_id || '').trim() || null,
    reasoningEffort: String(msg.reasoning_effort || '').trim() || null,
    contextTier: String(msg.context_tier || '').trim() || 'default',
    quality: normalizeOpenAIImageQuality(msg.reasoning_effort),
    size: normalizeOpenAIImageSize(msg.context_tier),
    relayMode: normalizeRelayMode(msg.relay_mode) || defaultRelayMode,
    text: msg.text,
    attachments,
    attachmentPromptContext,
    conversationSessionMode: configuredConversationSessionMode,
    status: msg.status,
    timestamp: msg.timestamp,
    processingAt: msg.processing_at,
    ownerSessionId: String(msg.owner_sdk_session_id || '').trim() || null,
    ownerAssignedAt: msg.owner_assigned_at || null,
    ownerLeaseExpiresAt: msg.owner_lease_expires_at || null,
    imageOperationId: String(msg.image_operation_id || '').trim() || null,
  };
}

function buildAttachmentPromptContext(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  const lines = [
    '<system_reminder>',
    'Attached files:',
  ];
  for (let index = 0; index < attachments.length; index++) {
    const att = attachments[index];
    if (!att || typeof att !== 'object') continue;
    const name = String(att.name || '').trim() || `attachment-${index + 1}`;
    const mime = String(att.type || '').trim() || 'application/octet-stream';
    const pathValue = String(att.path || '').trim();
    const reference = String(att.reference || '').trim();
    const rawSize = Number(att.size);
    const size = Number.isFinite(rawSize) && rawSize >= 0 ? Math.round(rawSize) : 0;
    lines.push(`- File ${index + 1}: "${name}"`);
    if (pathValue) lines.push(`  Path: ${pathValue}`);
    if (reference) lines.push(`  Reference: @file:${pathValue || reference.replace(/^@+/, '')}`);
    lines.push(`  MIME: ${mime}`);
    lines.push(`  Size: ${size} bytes`);
  }
  lines.push('</system_reminder>');
  return lines.join('\n');
}

const GENERATED_IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
});

function normalizeStorageSegment(value, fallback = 'item') {
  const text = String(value || '').trim();
  const compact = text.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return compact.slice(0, 96) || fallback;
}

function resolveGeneratedImageExtension(mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase();
  return GENERATED_IMAGE_EXTENSIONS[normalized] || 'png';
}

function parseGeneratedImageData(raw) {
  const dataUrl = String(raw?.dataUrl || raw?.data_url || '').trim();
  if (dataUrl.startsWith('data:')) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
    if (!match) throw new Error('Invalid generated image data URL');
    return {
      mimeType: String(raw?.mimeType || raw?.mime_type || match[1] || '').trim().toLowerCase(),
      dataBase64: String(match[2] || '').trim(),
    };
  }
  return {
    mimeType: String(raw?.mimeType || raw?.mime_type || '').trim().toLowerCase(),
    dataBase64: String(raw?.data || raw?.base64 || raw?.b64_json || raw?.image_base64 || '').trim(),
  };
}

export function normalizeGeneratedImageResponses(rawGeneratedImages, { maxImages = 8, maxImageBytes = 20 * 1024 * 1024 } = {}) {
  if (!rawGeneratedImages) return [];
  const input = Array.isArray(rawGeneratedImages) ? rawGeneratedImages : [rawGeneratedImages];
  const output = [];
  for (const raw of input.slice(0, Math.max(1, Math.trunc(Number(maxImages) || 8)))) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = parseGeneratedImageData(raw);
    const mimeType = parsed.mimeType || 'image/png';
    if (!mimeType.startsWith('image/')) throw new Error('Generated image type must be image/*');
    if (!parsed.dataBase64) throw new Error('Generated image payload is missing base64 data');
    if (!/^[a-z0-9+/=\s]+$/i.test(parsed.dataBase64)) {
      throw new Error('Generated image payload is not valid base64');
    }
    const buffer = Buffer.from(parsed.dataBase64, 'base64');
    if (!buffer.length) throw new Error('Generated image payload is empty');
    if (buffer.length > maxImageBytes) throw new Error('Generated image payload is too large');
    output.push({
      mimeType,
      dataBase64: buffer.toString('base64'),
      size: buffer.length,
      name: String(raw?.name || raw?.filename || raw?.fileName || 'generated-image').trim().slice(0, 120) || 'generated-image',
    });
  }
  return output;
}

export function shouldAcceptAssistantResponsePayload({ text = '', terminalFailure = null, generatedImages = [] } = {}) {
  if (terminalFailure) return true;
  const trimmedText = String(text || '').trim();
  if (trimmedText) return true;
  return Array.isArray(generatedImages) && generatedImages.length > 0;
}

function parseOpenAIImageBase64Value(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^[a-z0-9+/=\s]+$/i.test(raw)) {
    throw new Error('OpenAI image payload contains invalid base64 data');
  }
  return Buffer.from(raw, 'base64').toString('base64');
}

function normalizeOpenAIImageOptionString(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  if (!/^[a-z0-9._-]{2,32}$/i.test(normalized)) {
    throw new Error(`Invalid OpenAI image option "${fieldName}"`);
  }
  return normalized;
}

export function normalizeOpenAIImageGenerateRequestBody(rawBody, { maxImages = 10 } = {}) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const messageId = String(body.messageId || '').trim();
  const conversationId = String(body.conversationId || '').trim();
  const model = String(body.model || '').trim();
  const prompt = String(body.prompt || '').trim();
  if (!messageId) throw new Error('Missing messageId');
  if (!conversationId) throw new Error('Missing conversationId');
  if (!model) throw new Error('Missing model');
  if (!prompt) throw new Error('Missing prompt');

  const hasN = Object.prototype.hasOwnProperty.call(body, 'n');
  let n = undefined;
  if (hasN) {
    const parsed = Number(body.n);
    const maxN = Math.max(1, Math.trunc(Number(maxImages) || 10));
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxN) {
      throw new Error(`Invalid n value (must be an integer between 1 and ${maxN})`);
    }
    n = parsed;
  }

  const sizeRaw = body.size;
  let size = undefined;
  if (sizeRaw !== undefined && sizeRaw !== null && String(sizeRaw).trim()) {
    const normalizedSize = String(sizeRaw).trim().toLowerCase();
    if (normalizedSize !== 'auto' && !/^\d{2,5}x\d{2,5}$/i.test(normalizedSize)) {
      throw new Error('Invalid size value (expected "<width>x<height>" or "auto")');
    }
    size = normalizedSize;
  }

  const quality = normalizeOpenAIImageOptionString(body.quality, 'quality');
  const attachments = body.attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    throw new Error('attachments must be an array when provided');
  }

  return {
    messageId,
    conversationId,
    model,
    prompt,
    n,
    size,
    quality,
    attachments: Array.isArray(attachments) ? attachments : [],
  };
}

function isOpenAIImageAttachment(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const type = String(raw.type || '').trim().toLowerCase();
  if (type.startsWith('image/')) return true;
  const dataUrl = String(raw.dataUrl || '').trim().toLowerCase();
  return dataUrl.startsWith('data:image/');
}

export function resolveOpenAIImageEditAttachment(rawAttachments, {
  maxImageBytes = 20 * 1024 * 1024,
  allowedRootPath = '',
  allowedGeneratedImagesRootPath = '',
} = {}) {
  const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
  const firstImage = attachments.find((entry) => isOpenAIImageAttachment(entry));
  if (!firstImage) return null;

  const dataUrl = String(firstImage.dataUrl || '').trim();
  let mimeType = String(firstImage.type || '').trim().toLowerCase();
  let bytes = null;

  if (dataUrl.startsWith('data:')) {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
    if (!match) throw new Error('Invalid image attachment data URL');
    mimeType = mimeType || String(match[1] || '').trim().toLowerCase();
    const payload = parseOpenAIImageBase64Value(match[2]);
    bytes = Buffer.from(payload, 'base64');
  } else {
    const filePath = String(firstImage.path || '').trim();
    if (!filePath) throw new Error('Image attachment is missing file path or data URL');
    const allowedRoot = String(allowedRootPath || '').trim();
    const generatedImagesRoot = String(allowedGeneratedImagesRootPath || '').trim();
    if (allowedRoot || generatedImagesRoot) {
      const resolvedPath = path.resolve(filePath);
      const isWithinRoot = (rootPath) => {
        if (!rootPath) return false;
        const resolvedRoot = path.resolve(rootPath);
        const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
        return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootPrefix);
      };
      const isGeneratedImagePath = (() => {
        if (!generatedImagesRoot || !isWithinRoot(generatedImagesRoot)) return false;
        const relativeParts = path.relative(path.resolve(generatedImagesRoot), resolvedPath).split(path.sep);
        return relativeParts.length >= 3
          && relativeParts[0] !== '..'
          && relativeParts[1] === 'generated-images';
      })();
      if (!isWithinRoot(allowedRoot) && !isGeneratedImagePath) {
        throw new Error('Image attachment path is outside the upload directory');
      }
    }
    if (!fs.existsSync(filePath)) throw new Error(`Image attachment file not found: ${filePath}`);
    bytes = fs.readFileSync(filePath);
  }

  if (!mimeType.startsWith('image/')) {
    throw new Error('Image attachment must use image/* MIME type');
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw new Error('Image attachment payload is empty');
  }
  if (bytes.length > maxImageBytes) {
    throw new Error('Image attachment is too large');
  }

  return {
    bytes,
    mimeType,
    name: String(firstImage.name || 'image').trim().slice(0, 120) || 'image',
  };
}

export function normalizeOpenAIImageApiGeneratedImages(payload, { maxImages = 8 } = {}) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const maxCount = Math.max(1, Math.trunc(Number(maxImages) || 8));
  const generatedImages = [];
  for (const [index, row] of rows.entries()) {
    if (index >= maxCount) break;
    if (!row || typeof row !== 'object') continue;
    const data = parseOpenAIImageBase64Value(row.b64_json || row.data || row.base64);
    if (!data) throw new Error('OpenAI image response is missing b64_json');
    const revisedPrompt = String(row.revised_prompt || row.revisedPrompt || '').trim();
    generatedImages.push({
      data,
      mimeType: 'image/png',
      name: `generated-image-${index + 1}`,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    });
  }
  if (!generatedImages.length) {
    throw new Error('OpenAI image response did not contain generated images');
  }
  return generatedImages;
}

function resolveGeneratedImageStoragePath({
  resolveSessionStateRoot,
  sdkSessionId,
  conversationId,
  responseMessageId,
  imageId,
  extension,
} = {}) {
  if (typeof resolveSessionStateRoot !== 'function') throw new Error('Session-state root is unavailable');
  const root = String(resolveSessionStateRoot() || '').trim();
  if (!root) throw new Error('Session-state root is unavailable');
  const safeSession = normalizeStorageSegment(sdkSessionId || conversationId || 'session', 'session');
  const safeConversation = normalizeStorageSegment(conversationId || 'conversation', 'conversation');
  const safeMessage = normalizeStorageSegment(responseMessageId || 'message', 'message');
  const safeImageId = normalizeStorageSegment(imageId || 'image', 'image');
  const fileName = `${safeImageId}.${extension}`;
  const relativePath = `${safeConversation}/${safeMessage}/${fileName}`;
  const absoluteDir = path.join(root, safeSession, 'generated-images', safeConversation, safeMessage);
  return {
    root,
    safeSession,
    relativePath,
    fileName,
    absoluteDir,
    absolutePath: path.join(absoluteDir, fileName),
  };
}

function resolveGeneratedImageReadPath({
  resolveSessionStateRoot,
  sessionId,
  relativePath,
} = {}) {
  if (typeof resolveSessionStateRoot !== 'function') return null;
  const root = String(resolveSessionStateRoot() || '').trim();
  if (!root) return null;
  const safeSession = normalizeStorageSegment(sessionId || '', '');
  if (!safeSession) return null;
  const rawRelative = String(relativePath || '').replace(/\\/g, '/').trim();
  if (!rawRelative) return null;
  const normalizedRelative = path.posix.normalize(rawRelative).replace(/^\/+/, '');
  if (!normalizedRelative || normalizedRelative.startsWith('..') || normalizedRelative.includes('/../')) return null;
  const baseDir = path.resolve(path.join(root, safeSession, 'generated-images'));
  const candidate = path.resolve(path.join(baseDir, normalizedRelative));
  if (!(candidate === baseDir || candidate.startsWith(`${baseDir}${path.sep}`))) return null;
  return candidate;
}

function createGeneratedImageAttachment({
  image,
  messageId,
  conversationId,
  sdkSessionId,
  imageIndex,
  resolveSessionStateRoot,
}) {
  const imageId = `img-${String(imageIndex + 1).padStart(2, '0')}`;
  const extension = resolveGeneratedImageExtension(image.mimeType);
  const location = resolveGeneratedImageStoragePath({
    resolveSessionStateRoot,
    sdkSessionId,
    conversationId,
    responseMessageId: messageId,
    imageId,
    extension,
  });
  fs.mkdirSync(location.absoluteDir, { recursive: true });
  const tmpPath = path.join(location.absoluteDir, `${location.fileName}.${process.pid}.${Date.now()}.tmp`);
  const bytes = Buffer.from(String(image.dataBase64 || ''), 'base64');
  fs.writeFileSync(tmpPath, bytes);
  try {
    fs.renameSync(tmpPath, location.absolutePath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {}
    throw error;
  }
  return {
    name: `${String(image.name || 'generated-image').replace(/\.[a-z0-9]+$/i, '') || 'generated-image'}-${imageIndex + 1}.${extension}`,
    type: image.mimeType,
    size: bytes.length,
    contentUrl: `/api/generated-image/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}/${encodeURIComponent(imageId)}/content`,
    generatedImage: {
      imageId,
      messageId,
      conversationId,
      sessionId: location.safeSession,
      relativePath: location.relativePath,
    },
  };
}

export function persistGeneratedImagesForAssistantResponse({
  images = [],
  messageId,
  conversationId,
  sdkSessionId,
  resolveSessionStateRoot,
} = {}) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const persistedAttachments = [];
  try {
    for (const [index, image] of images.entries()) {
      const attachment = createGeneratedImageAttachment({
        image,
        messageId,
        conversationId,
        sdkSessionId,
        imageIndex: index,
        resolveSessionStateRoot,
      });
      persistedAttachments.push(attachment);
    }
    return persistedAttachments;
  } catch (error) {
    cleanupPersistedGeneratedImagesForAssistantResponse({
      attachments: persistedAttachments,
      resolveSessionStateRoot,
    });
    throw error;
  }
}

export function cleanupPersistedGeneratedImagesForAssistantResponse({
  attachments = [],
  resolveSessionStateRoot,
} = {}) {
  if (!Array.isArray(attachments) || attachments.length === 0) return;
  for (const attachment of attachments) {
    const generatedImage = attachment?.generatedImage;
    const filePath = resolveGeneratedImageReadPath({
      resolveSessionStateRoot,
      sessionId: generatedImage?.sessionId,
      relativePath: generatedImage?.relativePath,
    });
    if (!filePath) continue;
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}

function serveFileWithRangeSupport(req, res, filePath, meta, { safeName, cacheDelete = null } = {}) {
  const fileSize = meta.size;
  const name = safeName || path.basename(filePath).replace(/"/g, '');
  const rangeHeader = req.headers['range'];

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', meta.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const onStreamError = (error) => {
    if (cacheDelete) cacheDelete(filePath);
    if (res.headersSent) { res.destroy(error); return; }
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.status(500).json({ error: 'Failed to read file' });
  };

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (!match) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
    if (start > end || start >= fileSize || end >= fileSize) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }
    const chunkSize = end - start + 1;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', String(chunkSize));
    res.status(206);
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', onStreamError);
    stream.pipe(res);
  } else {
    res.setHeader('Content-Length', String(fileSize));
    const stream = fs.createReadStream(filePath);
    stream.on('error', onStreamError);
    stream.pipe(res);
  }
}

export function registerMessagesRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    config,
    uuidv4,
    ts,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_ATTACHMENTS,
    uploadsDir,
    MAX_REPO_TREE_NODES,
    MAX_REQUEUE_RETRIES,
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
    maybeApplyWorkspaceRootFromMessage,
    updateConversationConfiguredWorkspaceRoot,
    getOrCreateConversation,
    ensureRuntimeSessionBinding,
    resolveConversationWorkspaceState,
    linkUploadReferences,
    normalizeAttachments,
    collectReferenceAttachmentsFromText,
    mergeMessageAttachments,
    attachmentSummary,
    createCompactedConversation,
    workspaceRootPayload,
    queueCounts,
    getModelCatalogState,
    buildRelayReadyBannerData,
    ensureSessionId,
    touchCli,
    recoverProcessingOlderThan,
    addMsIso,
    computeRetryDelayMs,
    resolveRequestedModel,
    resolveRequestedReasoningEffort = () => ({ ok: false, error: 'Reasoning metadata unavailable', supported: [] }),
    getOpenAIProviderSettings = () => ({ enabled: false, model: '' }),
    getClaudeProviderSettings = () => ({ enabled: false, model: '', models: [] }),
    getCursorProviderSettings = () => ({ enabled: false, model: '', models: [] }),
    rebindUnstartedOpenAIConversationModel = null,
    normalizeRelayMode,
    DEFAULT_RELAY_MODE,
    DEFAULT_MODEL,
    configuredConversationSessionMode,
    parseAttachments,
    hydrateAttachment,
    relayActivityForResponse,
    relayActivityForQueueMessage,
    relayThoughtsForResponse,
    relayThoughtsForQueueMessage,
    sanitizeActivityText,
    readSessionTranscriptMessages,
    inFlightStateForConversation,
    emitToClientsExceptSessionId,
    relayBridgeOwnerService,
    relayRestartOrchestrator,
    requestRelayShutdown,
    featureFlags,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
    sessionWorkerProcessInspector,
    resolveSessionStateRoot,
    fetchUsageSummary = null,
    opaqueResponseRecoveryWaitMs = OPAQUE_RESPONSE_RECOVERY_WAIT_MS,
    opaqueResponseRecoveryPollMs = OPAQUE_RESPONSE_RECOVERY_POLL_MS,
    relayQuestionFinalizationHoldMs = RELAY_QUESTION_FINALIZATION_HOLD_MS,
    imageOperationService = null,
  } = deps;

  const ttyConsoleActive = runtimeState?.ttyConsoleActive === true;
  const getMessageAttachmentsByConversation = db.prepare(`
    SELECT attachments
    FROM messages
    WHERE id = ? AND conversation_id = ?
    LIMIT 1
  `);

  function isAbnormalWorkerTelemetry(payload = {}, level = 'log') {
    const normalizedLevel = String(level || 'log').trim().toLowerCase();
    if (normalizedLevel === 'warn' || normalizedLevel === 'error') return true;
    const event = String(payload?.event || '').trim().toLowerCase();
    const state = String(payload?.state || '').trim().toLowerCase();
    if (state === 'error') return true;
    return event.includes('error')
      || event.includes('failed')
      || event.includes('failure')
      || event.includes('blocked');
  }

  function isLoopbackAddress(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return false;
    return text === '127.0.0.1'
      || text === '::1'
      || text === '::ffff:127.0.0.1'
      || text === '::ffff:7f00:1';
  }

  function isLoopbackRequest(req) {
    const socketAddress = req?.socket?.remoteAddress;
    const ipAddress = req?.ip;
    return isLoopbackAddress(socketAddress) || isLoopbackAddress(ipAddress);
  }

  function readBridgeIdentity(req) {
    return relayBridgeOwnerService?.normalizeIdentity?.({
      pid: req.headers['x-relay-process-pid'],
      parentPid: req.headers['x-relay-parent-pid'],
      sessionId: req.headers['x-relay-session-id'],
      conversationId: req.headers['x-relay-conversation-id'],
    }) || null;
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
    const shouldLog = !ttyConsoleActive || isAbnormalWorkerTelemetry(payload, level);
    if (!shouldLog) return;
    const method = typeof console[level] === 'function' ? level : 'log';
    console[method](`[${ts()}] WORKER    ${JSON.stringify(payload)}`);
  }

  function normalizeBindingValue(value) {
    const text = String(value || '').trim();
    return text || null;
  }

  function persistConversationModelPreference(conversationId, relayMode, model, reasoningEffort = '', nowIso = new Date().toISOString()) {
    const convId = String(conversationId || '').trim();
    const mode = normalizeRelayMode(relayMode) || DEFAULT_RELAY_MODE;
    const modelId = String(model || '').trim();
    if (!convId || !mode || !modelId) {
      return {
        preferredRelayMode: mode || DEFAULT_RELAY_MODE,
        preferredModel: '',
        preferredReasoningEffort: '',
      };
    }
    const persisted = persistConversationModelPreferenceTx({
      db,
      stmts,
      conversationId: convId,
      relayMode: mode,
      model: modelId,
      reasoningEffort,
      normalizeMode: (value) => normalizeRelayMode(value) || null,
      fallbackRelayMode: DEFAULT_RELAY_MODE,
      updatedAt: nowIso,
      tolerateMissingColumns: true,
    });
    return {
      preferredRelayMode: persisted.preferredRelayMode || mode,
      preferredModel: persisted.preferredModel || '',
      preferredReasoningEffort: persisted.preferredReasoningEffort || '',
    };
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

  function rejectSessionBinding(res, status, error, extra = {}) {
    return res.status(status).json({ error, ...extra });
  }

  function failQueueMessage({
    queueRow,
    messageId,
    conversationId,
    relayMode,
    model,
    responseText,
    failureRecord,
    markWorkerError = true,
  }) {
    const now = new Date().toISOString();
    const responseId = uuidv4();
    const requestedModel = String(queueRow?.model || '').trim() || null;
    const modelOrigin = deriveModelOrigin(requestedModel);
    const resolvedModel = String(model || '').trim()
      || (modelOrigin === 'auto' ? 'unknown' : requestedModel)
      || null;
    const modelActual = String(model || '').trim() || null;
    const tx = db.transaction(() => {
      const result = stmts.setFailed.run(JSON.stringify(failureRecord), messageId);
      if (result.changes === 0) return false;
      stmts.setQueueResponseMessageId?.run(responseId, messageId);
      stmts.insertMsg.run(
        responseId,
        conversationId,
        'assistant',
        responseText,
        resolvedModel,
        relayMode,
        null,
        now,
        requestedModel,
        modelActual,
        modelOrigin,
      );
      stmts.linkActivityToResponse?.run(responseId, messageId);
      stmts.linkStreamEventsToResponse?.run(responseId, messageId);
      stmts.updateConvTime.run(now, conversationId);
      stmts.pruneQueue?.run();
      return true;
    });
    const failed = tx();
    if (!failed) return null;
    io.emit('assistant_message', {
      conversationId,
      sourceMessageId: messageId,
      messageId: responseId,
      message: {
        role: 'assistant',
        text: responseText,
        model: resolvedModel,
        modelOrigin: modelOrigin || undefined,
        reasoningEffort: String(queueRow?.reasoning_effort || '').trim() || null,
        mode: relayMode,
        timestamp: now,
      },
    });
    io.emit('message_status', { messageId, conversationId, status: 'failed' });
    cancelPendingRelayQuestionsForMessage(messageId);
    const ownerSessionId = isSessionWorkerRoutingEnabled(featureFlags)
      ? normalizeSessionWorkerId(queueRow?.owner_sdk_session_id)
      : null;
    if (ownerSessionId) {
      if (markWorkerError) {
        sessionWorkerSupervisor?.markError?.(ownerSessionId, `queue-failed:${failureRecord?.code || failureRecord?.error || 'unknown'}`);
        emitSessionWorkerTelemetry('queue.message.failed', {
          sessionId: ownerSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(ownerSessionId)?.workerId || null,
          conversationId,
          messageId,
          continuationId: null,
          state: 'error',
          retry: Number(queueRow?.retry_count || 0),
          pid: null,
          extra: failureRecord?.code
            ? {
                failureKind: failureRecord?.kind || null,
                failureCode: failureRecord?.code || null,
                functionCallId: failureRecord?.functionCallId || null,
                requestId: failureRecord?.requestId || null,
              }
            : null,
        });
      } else {
        const existingWorker = sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
        sessionWorkerRegistry?.upsertWorker?.({
          ...(existingWorker || {}),
          sdkSessionId: ownerSessionId,
          status: 'ready',
        });
        sessionWorkerSupervisor?.markIdle?.(ownerSessionId, queueCounts?.().pendingCount || 0);
        emitSessionWorkerTelemetry('queue.message.stopped', {
          sessionId: ownerSessionId,
          workerId: existingWorker?.workerId || null,
          conversationId,
          messageId,
          continuationId: null,
          state: 'ready',
          retry: Number(queueRow?.retry_count || 0),
          pid: existingWorker?.pid || null,
          extra: failureRecord?.code
            ? {
                failureKind: failureRecord?.kind || null,
                failureCode: failureRecord?.code || null,
              }
            : null,
        });
      }
    }
    return { responseId, now };
  }

  function cancelPendingRelayQuestionsForMessage(messageId) {
    const targetMessageId = String(messageId || '').trim();
    if (!targetMessageId || typeof stmts.cancelPendingQuestionsByMessage?.run !== 'function') return 0;
    const pendingRows = typeof stmts.listPendingQuestionsByMessage?.all === 'function'
      ? stmts.listPendingQuestionsByMessage.all(targetMessageId)
      : [];
    if (!pendingRows.length) return 0;
    
    // Get the message start time to determine which questions are "stale"
    const queueRow = stmts.findQById?.get(targetMessageId) || null;
    const messageStartedAt = queueRow?.created_at || null;
    
    // Only cancel questions that were created BEFORE this turn started (stale orphans)
    // Keep questions created during the turn - they might still be waiting for answers
    const now = new Date().toISOString();
    let cancelledCount = 0;
    
    for (const row of pendingRows) {
      const questionCreatedAt = row.created_at || null;
      const isStale = messageStartedAt && questionCreatedAt && questionCreatedAt < messageStartedAt;
      
      if (isStale) {
        // This is an orphaned question from a previous attempt - cancel it
        const result = db.prepare(`UPDATE relay_questions SET status = 'cancelled', answered_at = ? WHERE id = ? AND status = 'pending'`).run(now, row.id);
        if ((result?.changes || 0) > 0) {
          cancelledCount++;
          const updated = stmts.getQuestion?.get(row.id) || null;
          if (updated && typeof deps.formatQuestionRow === 'function') {
            io.emit('relay_question_updated', { question: deps.formatQuestionRow(updated) });
          }
        }
      }
    }
    
    return cancelledCount;
  }

  const strandedPrimeCooldownBySession = new Map();

  const findPendingOwnedByOtherSession = db.prepare(`
    SELECT q.id, q.conversation_id, q.runtime_session_id, q.owner_sdk_session_id, q.retry_count
    FROM queue q
    WHERE q.status = 'pending'
      AND q.owner_sdk_session_id IS NOT NULL
      AND q.owner_sdk_session_id != ''
      AND q.owner_sdk_session_id != ?
      AND q.runtime_session_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM runtime_sessions rs
        WHERE rs.id = q.runtime_session_id
          AND rs.sdk_session_id = ?
      )
      AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
    ORDER BY q.retry_count ASC, CASE WHEN q.next_attempt_at IS NULL THEN 0 ELSE 1 END ASC, COALESCE(q.next_attempt_at, q.timestamp) ASC, q.timestamp ASC
    LIMIT 1
  `);
  const transferPendingOwnerToSession = db.prepare(`
    UPDATE queue
    SET owner_sdk_session_id = ?,
        owner_assigned_at = ?,
        owner_lease_expires_at = NULL,
        owner_last_claimed_at = NULL
    WHERE id = ?
      AND status = 'pending'
      AND owner_sdk_session_id = ?
  `);
  const findActiveOwnedBySession = db.prepare(`
    SELECT *
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status IN ('processing', 'pending', 'parked')
    ORDER BY
      CASE status WHEN 'processing' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END ASC,
      timestamp ASC
    LIMIT 1
  `);
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
  const listRecoverableProcessingOwnedBySession = db.prepare(`
    SELECT *
    FROM queue
    WHERE owner_sdk_session_id = ?
      AND status = 'processing'
      AND (? = '' OR id != ?)
      AND COALESCE(owner_last_claimed_at, processing_at, timestamp) <= ?
    ORDER BY COALESCE(processing_at, timestamp) DESC, timestamp DESC
  `);
  const refreshProcessingLeaseForOwnedMessage = db.prepare(`
    UPDATE queue
    SET owner_lease_expires_at = ?,
        owner_last_claimed_at = ?
    WHERE id = ?
      AND owner_sdk_session_id = ?
      AND status = 'processing'
  `);
  const recoverOwnedProcessingMessage = db.prepare(`
    UPDATE queue
    SET status = 'pending',
        processing_at = NULL,
        next_attempt_at = ?,
        owner_lease_expires_at = NULL
    WHERE id = ?
      AND owner_sdk_session_id = ?
      AND status = 'processing'
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
    return {
      kind: 'turn-aborted',
      error: 'turn-aborted',
      code: 'turn-aborted',
      stableCode: 'relay.turn-aborted',
      message: 'System note: This turn was stopped from the relay UI before completion.',
      guidance: 'Send a new message to continue when you are ready.',
      failedAt: new Date().toISOString(),
    };
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

  function recoverOwnedProcessingRowsForSession(
    sdkSessionId,
    {
      excludeMessageId = null,
      reason = 'owner-heartbeat-idle',
      graceMs = SESSION_WORKER_IDLE_RECOVERY_GRACE_MS,
    } = {},
  ) {
    const normalizedSessionId = normalizeSessionWorkerId(sdkSessionId);
    if (!normalizedSessionId) return [];
    const excludedId = String(excludeMessageId || '').trim();
    const cutoffIso = new Date(Date.now() - Math.max(1_000, Number(graceMs) || SESSION_WORKER_IDLE_RECOVERY_GRACE_MS)).toISOString();
    const rows = listRecoverableProcessingOwnedBySession.all(
      normalizedSessionId,
      excludedId,
      excludedId,
      cutoffIso,
    ) || [];
    if (!rows.length) return [];
    const rowsToFail = [];
    const rowsToRecover = [];
    for (const row of rows) {
      const relayActivityRows = stmts.listActivityByQueueMessage?.all?.(row.id);
      const relayStreamRows = stmts.listStreamEventsByQueueMessage?.all?.(row.id);
      const fallbackRelayActivities = Array.isArray(relayActivityRows)
        ? relayActivityRows
        : relayActivityForQueueMessage?.(row.id);
      const relayActivityCount = Array.isArray(fallbackRelayActivities) ? fallbackRelayActivities.length : 0;
      const relayStreamCount = Array.isArray(relayStreamRows) ? relayStreamRows.length : 0;
      if (shouldFailRecoveredProcessingRow({
        reason,
        relayActivityCount,
        relayStreamCount,
      })) {
        rowsToFail.push(row);
        continue;
      }
      rowsToRecover.push(row);
    }
    const requeueAt = addMsIso(2_000);
    const tx = db.transaction((recoverRows) => {
      for (const row of recoverRows) {
        recoverOwnedProcessingMessage.run(requeueAt, row.id, normalizedSessionId);
      }
    });
    tx(rowsToRecover);
    for (const row of rowsToRecover) {
      settleRelayAbortControlsForQueueMessage(row.id, {
        ok: false,
        error: reason,
      });
      settleRelaySubagentAbortControlsForQueueMessage(row.id, {
        ok: false,
        error: reason,
      });
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'pending' });
    }
    for (const row of rowsToFail) {
      const failureRecord = buildHeartbeatIdleReplayFailure({
        requesterSessionId: normalizedSessionId,
      });
      const failureText = buildTerminalFailureTextForChat(failureRecord);
      const failed = failQueueMessage({
        queueRow: row,
        messageId: row.id,
        conversationId: row.conversation_id,
        relayMode: normalizeRelayMode(row.relay_mode) || DEFAULT_RELAY_MODE,
        model: row.model || null,
        responseText: failureText,
        failureRecord,
        markWorkerError: false,
      });
      if (failed) {
        settleRelayAbortControlsForQueueMessage(row.id, {
          ok: false,
          error: failureRecord.code,
        });
        settleRelaySubagentAbortControlsForQueueMessage(row.id, {
          ok: false,
          error: failureRecord.code,
        });
      }
    }
    if (rowsToRecover.length || rowsToFail.length) {
      io.emit('queue_updated', {
        recovered: rowsToRecover.length,
        replayBlocked: rowsToFail.length,
        ownerSessionId: normalizedSessionId,
      });
    }
    return rows;
  }

  app.post('/api/session-worker/:sdkSessionId/kill', auth, async (req, res) => {
    const sdkSessionId = normalizeSessionWorkerId(req.params.sdkSessionId);
    if (!sdkSessionId) return res.status(400).json({ error: 'Missing session worker id' });

    const currentWorker = sessionWorkerRegistry?.getWorker?.(sdkSessionId) || null;
    sessionWorkerSupervisor?.markKilled?.(sdkSessionId);
    try {
      await sessionWorkerSupervisor?.cancelPendingStart?.(sdkSessionId);
    } catch {
      // If cancellation fails, keep going with the process kill cleanup.
    }

    // Collect ALL matching PIDs (not just first)
    const discoveredProcesses = process.platform === 'win32'
      ? (
          sessionWorkerProcessInspector?.findWindowsProcessTreeForSession?.(sdkSessionId)
          || sessionWorkerProcessInspector?.findWindowsProcessesForSession?.(sdkSessionId)
          || sessionWorkerProcessInspector?.findProcessesForSession?.(sdkSessionId)
          || []
        )
      : (sessionWorkerProcessInspector?.findProcessesForSession?.(sdkSessionId) || []);
    const allPids = [...new Set([
      ...discoveredProcesses.map((p) => (p.processId ? Number(p.processId) : null)).filter(Boolean),
      currentWorker?.pid ? Number(currentWorker.pid) : null,
    ].filter(Boolean))];

    let processStatus = 'not-running';
    let killedPids = [];

    if (allPids.length) {
      try {
        if (process.platform === 'win32') {
          // On Windows, kill through PowerShell to avoid process-group edge-cases.
          killedPids = sessionWorkerProcessInspector.stopWindowsPids(allPids);
        } else {
          killTmuxSession(sdkSessionId);
          for (const pid of allPids) {
            try {
              process.kill(pid, 'SIGTERM');
              killedPids.push(pid);
            } catch {
              // Ignore missing/already-dead processes.
            }
          }
          await delay(150);
          for (const pid of allPids) {
            try {
              process.kill(pid, 0);
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already exited or inaccessible.
            }
          }
        }
        processStatus = 'killed';
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to kill session worker', pids: allPids });
      }
    }

    // Audit marker — always emitted before responding
    console.log(`[KILL] session=${sdkSessionId} pids=${allPids.join(',') || 'none'} processStatus=${processStatus}`);

    // Post-kill verification — synchronous re-scan to confirm processes are gone
    const remainingPids = allPids.length
      ? (process.platform === 'win32'
          ? (
              sessionWorkerProcessInspector?.findWindowsProcessTreeForSession?.(sdkSessionId)
              || sessionWorkerProcessInspector?.findWindowsProcessesForSession?.(sdkSessionId)
              || []
            ).map((p) => p.processId).filter(Boolean)
          : ((sessionWorkerProcessInspector?.findProcessesForSession?.(sdkSessionId) || []).map((p) => p.processId).filter(Boolean)))
      : [];

    sessionWorkerRegistry?.removeWorker?.(sdkSessionId);
    sessionWorkerSupervisor?.clearRestartSchedule?.(sdkSessionId);
    sessionWorkerSupervisor?.resetHealth?.(sdkSessionId, { clearFailureCount: false });

    // Drain ALL owned processing rows, not just first
    const queueRows = findAllProcessingOwnedBySession.all(sdkSessionId) || [];
    const failedMessageIds = [];
    let releasedOwnedCount = 0;

    if (queueRows.length > 0) {
      for (const queueRow of queueRows) {
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
    const conversationId = String(req.params.conversationId || '').trim();
    const requestedMessageId = String(req.body?.messageId || req.body?.queueMessageId || '').trim();
    const sessionState = getConversationSessionState(conversationId);
    if (!sessionState.ok) {
      return rejectSessionBinding(res, sessionState.status, sessionState.error);
    }

    const queueRow = stmts.getLatestProcessingQueueByConversation.get(conversationId) || null;
    if (!queueRow) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'no-active-turn',
        requestedMessageId: requestedMessageId || null,
        activeMessageId: null,
      });
    }

    const activeMessageId = String(queueRow.id || '').trim();
    if (requestedMessageId && activeMessageId && requestedMessageId !== activeMessageId) {
      const requestedRow = stmts.findQById.get(requestedMessageId) || null;
      const requestedStatus = String(requestedRow?.status || '').trim().toLowerCase();
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: requestedStatus === 'processing' ? 'message-mismatch' : 'already-finished',
        requestedMessageId,
        activeMessageId,
      });
    }

    const sdkSessionId = normalizeSessionWorkerId(
      queueRow.owner_sdk_session_id
      || sessionState.runtimeSessionSdkSessionId
      || sessionState.conversationSdkSessionId,
    );
    if (!sdkSessionId) {
      return res.json({
        ok: true,
        queued: false,
        acknowledgement: 'active-turn-unbound',
        requestedMessageId: activeMessageId || requestedMessageId || null,
        activeMessageId,
      });
    }

    const existing = findActiveRelayControlByQueueMessage.get(activeMessageId, 'abort_turn') || null;
    if (existing) {
      return res.json({
        ok: true,
        queued: true,
        duplicate: true,
        acknowledgement: 'already-requested',
        requestedMessageId: activeMessageId || requestedMessageId || null,
        activeMessageId,
        control: formatRelayControlResponse(existing),
      });
    }

    const now = new Date().toISOString();
    const controlId = uuidv4();
    const requestPayload = JSON.stringify({
      source: 'relay-ui',
      requestedByClientId: String(req.body?.clientId || '').trim() || null,
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
    return res.json({
      ok: true,
      queued: true,
      acknowledgement: 'stop-queued',
      requestedMessageId: activeMessageId || requestedMessageId || null,
      activeMessageId,
      control: formatRelayControlResponse(control),
    });
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

  app.post('/api/conversation/:conversationId/cancel-queued-turn', auth, (req, res) => {
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

    const cancelQueuedTurn = db.transaction(() => {
      stmts.deleteQueueById.run(requestedMessageId);
      cancelPendingRelayQuestionsForMessage(requestedMessageId);
    });
    cancelQueuedTurn();

    io.emit('message_status', { messageId: requestedMessageId, conversationId, status: 'cancelled' });

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
          io.emit('subagent_status', {
            messageId: messageId || null,
            conversationId: conversationId || null,
            subagentRunId: targetSubagentRunId,
            parentSubagentId: parentSubagentId || undefined,
            displayName: displayName || undefined,
            status,
            timestamp: now,
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
      if (queueRow) {
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
    const fileType = String(req.headers['x-file-type'] || req.headers['content-type'] || req.query.type || 'application/octet-stream').trim().toLowerCase();

    try {
      const attachment = persistUploadBuffer(payload, { name: fileName, type: fileType });
      if (!attachment) return res.status(500).json({ error: 'Upload persistence failed' });
      res.json({ ok: true, attachment });
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
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(filePath).pipe(res);
  });

  app.get('/api/generated-image/:conversationId/:messageId/:imageId/content', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    const messageId = String(req.params.messageId || '').trim();
    const imageId = String(req.params.imageId || '').trim();
    if (!conversationId || !messageId || !imageId) {
      return res.status(400).json({ error: 'Invalid generated image reference' });
    }
    const messageRow = getMessageAttachmentsByConversation.get(messageId, conversationId);
    if (!messageRow) return res.status(404).json({ error: 'Generated image not found' });
    const attachments = parseAttachments(messageRow.attachments).map(hydrateAttachment).filter(Boolean);
    const attachment = attachments.find((entry) => {
      const generatedImage = entry?.generatedImage && typeof entry.generatedImage === 'object'
        ? entry.generatedImage
        : null;
      return String(generatedImage?.imageId || '').trim() === imageId;
    });
    if (!attachment) return res.status(404).json({ error: 'Generated image not found' });
    const generatedImage = attachment.generatedImage;
    const filePath = resolveGeneratedImageReadPath({
      resolveSessionStateRoot,
      sessionId: generatedImage?.sessionId,
      relativePath: generatedImage?.relativePath,
    });
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Generated image file missing' });
    }
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return res.status(404).json({ error: 'Generated image file missing' });
    }
    if (!stat.isFile()) return res.status(404).json({ error: 'Generated image file missing' });
    return serveFileWithRangeSupport(req, res, filePath, {
      size: stat.size,
      contentType: String(attachment.type || 'application/octet-stream').trim() || 'application/octet-stream',
    }, {
      safeName: path.basename(filePath).replace(/"/g, ''),
    });
  });

  app.get('/api/files/*', auth, (req, res) => {
    const requestedPath = String(req.params?.[0] || '').trim();
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    const filePath = resolveWorkspaceFilePath(requestedPath, rootOverride);
    if (!filePath) return res.status(400).json({ error: 'Invalid file path' });

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

  app.get('/api/files-preview/*', auth, (req, res) => {
    const requestedPath = String(req.params?.[0] || '').trim();
    const normalizedPath = normalizeWorkspaceRelativePath(requestedPath);
    const rootOverride = resolveScopedWorkspaceRootPath(req);
    const filePath = resolveWorkspaceFilePath(requestedPath, rootOverride);
    if (!filePath || !normalizedPath) return res.status(400).json({ error: 'Invalid file path' });

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
      rawUrl: `${remotePath}/api/files/${normalizedWebPath.split('/').map((part) => encodeURIComponent(part)).join('/')}${scopeSuffix}`,
    };

    if (kind !== 'binary' && kind !== 'image' && kind !== 'video') {
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

  app.get('/api/drives/file', auth, (req, res) => {
    const requestedPath = String(req.query.path || '').trim();

    if (process.platform !== 'win32') {
      const filePath = normalizeLinuxAbsolutePath(requestedPath);
      if (!filePath) return res.status(400).json({ error: 'Invalid Linux file path' });

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
        rawUrl: `${remotePath}/api/drives/file?path=${encodeURIComponent(filePath)}`,
      };

      if (kind !== 'binary' && kind !== 'image' && kind !== 'video') {
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
        rawUrl: `${remotePath}/api/drives/file?path=${encodeURIComponent(normalizedWebPath)}`,
      };

      if (kind !== 'binary' && kind !== 'image' && kind !== 'video') {
        payload.content = contentBuffer.toString('utf8');
      }

      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    });
  });

  // POST /api/message — browser sends a message
  app.post('/api/message', auth, async (req, res) => {
    const {
      messageId: clientMessageId,
      clientId,
      conversationId,
      text,
      newConversation,
      model,
      reasoningEffort,
      contextTier,
      relayMode,
      mode,
      providerType,
      provider,
      attachments: rawAttachments,
      imageTarget: rawImageTarget,
    } = req.body;
    const sessionId = clientId || ensureSessionId(req, res);
    const requesterIdentity = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requesterIdentity?.sessionId);
    const sessionWorkerRoutingEnabled = isSessionWorkerRoutingEnabled(featureFlags);
    let conversationSdkSessionId = null;
    const requestedRelayMode = normalizeRelayMode(relayMode || mode);
    const trimmedText = stripRelayPromptContext(text, requestedRelayMode || relayMode || mode);
    const normalizedAttachments = normalizeAttachments(rawAttachments);
    const referenceResolution = collectReferenceAttachmentsFromText(trimmedText);
    const attachments = mergeMessageAttachments(normalizedAttachments, referenceResolution.attachments);
    const imageTarget = rawImageTarget && typeof rawImageTarget === 'object'
      ? {
          messageId: String(rawImageTarget.messageId || '').trim(),
          imageId: String(rawImageTarget.imageId || '').trim(),
          nodeId: String(rawImageTarget.nodeId || '').trim() || null,
        }
      : null;
    const imageContinuityEnabled = featureFlags?.IMAGE_CONVERSATION_CONTINUITY_ENABLED === true;
    if (imageTarget && !imageContinuityEnabled) {
      return res.status(409).json({
        error: 'Conversational image editing is not enabled',
        code: 'IMAGE_CONTINUITY_DISABLED',
      });
    }

    if (trimmedText.toLowerCase() === '/compact') {
      if (attachments.length) return res.status(400).json({ error: 'Compact command does not accept attachments' });
      if (!conversationId) return res.status(400).json({ error: 'Compact command requires an existing conversation' });
      const compacted = createCompactedConversation(conversationId);
      if (!compacted) return res.status(404).json({ error: 'Conversation not found' });
      io.emit('conversation_compacted', compacted);
      return res.json({
        ok: true,
        command: 'compact',
        compacted: true,
        sourceConversationId: compacted.sourceConversationId,
        conversationId: compacted.targetConversationId,
        compactedConversationId: compacted.targetConversationId,
        runtimeSessionId: compacted.runtimeSessionId,
        summarySeedPreview: compacted.summarySeed.slice(0, 240),
      });
    }

    if (!trimmedText && attachments.length === 0) return res.status(400).json({ error: 'Empty message' });
    const shouldCreateConversation = !!newConversation || !conversationId;
    const existingRuntimeSession = shouldCreateConversation
      ? null
      : (stmts.getRuntimeSessionByConversation.get(conversationId) || null);
    const configuredOpenAI = getOpenAIProviderSettings();
    const requestedProviderType = normalizeRequestedProviderType(providerType || provider);
    const runtimeProviderType = String(existingRuntimeSession?.provider_type || '').trim().toLowerCase();
    const runtimeUsesOpenAI = runtimeProviderType === 'openai';
    // Providers that resell each other's model ids ("claude-opus-5" is served by
    // Claude, Copilot and Cursor alike) make a model id useless for deciding
    // which provider a request targets. A session already bound to an explicit
    // provider resolves ids against that provider's own catalog, so the
    // cross-provider guards below must not infer a switch from the id alone.
    const runtimeBoundToExplicitProvider = runtimeProviderType === 'openai'
      || runtimeProviderType === 'claude'
      || runtimeProviderType === 'cursor';
    const configuredOpenAIModel = String(configuredOpenAI?.model || '').trim();
    const availableOpenAIModels = new Set(
      (Array.isArray(configuredOpenAI?.models) ? configuredOpenAI.models : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    );
    const requestedOpenAIModel = String(model || '').trim();
    const requestedModelLooksOpenAI = !!requestedOpenAIModel && (
      requestedOpenAIModel === configuredOpenAIModel || availableOpenAIModels.has(requestedOpenAIModel)
    );
    const requestedGitHubModelResolution = requestedOpenAIModel
      ? resolveRequestedModel(model)
      : null;
    const requestedModelAvailableInGitHub = requestedGitHubModelResolution?.ok === true;
    const useOpenAIProvider = runtimeUsesOpenAI
      || (shouldCreateConversation && (
        requestedProviderType === 'openai'
        || (requestedProviderType === '' && (
          configuredOpenAI?.enabled === true
          && requestedModelLooksOpenAI
        ))
      ));
    if (
      !shouldCreateConversation
      && !runtimeUsesOpenAI
      && requestedModelLooksOpenAI
      && (
        requestedProviderType === 'openai'
        || (!requestedModelAvailableInGitHub && !runtimeBoundToExplicitProvider)
      )
    ) {
      return res.status(409).json({
        error: 'OpenAI model selection requires creating a new OpenAI conversation',
        code: 'OPENAI_MODEL_REQUIRES_NEW_CONVERSATION',
      });
    }
    if (shouldCreateConversation && requestedProviderType === 'openai' && configuredOpenAI?.configured !== true) {
      return res.status(400).json({
        error: 'OpenAI API key is not configured',
        code: 'OPENAI_NOT_CONFIGURED',
      });
    }
    const requestedConfiguredOpenAIModel = configuredOpenAI?.enabled
      && String(model || '').trim() === String(configuredOpenAI.model || '').trim();
    if (shouldRequireNewOpenAIConversation({
      shouldCreateConversation,
      runtimeUsesOpenAI,
      requestedConfiguredOpenAIModel,
      githubModelAvailable: requestedConfiguredOpenAIModel && requestedModelAvailableInGitHub,
      runtimeBoundToOtherProvider: runtimeBoundToExplicitProvider && !runtimeUsesOpenAI,
    })) {
      return res.status(409).json({
        error: 'The configured OpenAI model is available only when creating a new conversation',
        code: 'OPENAI_MODEL_REQUIRES_NEW_CONVERSATION',
      });
    }
    // Cursor conversations are bootstrap-created only, so an existing
    // github/openai/claude conversation cannot cross to the Cursor provider
    // mid-conversation. Cursor settings are read lazily so the hot path stays
    // untouched for non-Cursor requests.
    const runtimeUsesCursor = runtimeProviderType === 'cursor';
    if (!shouldCreateConversation && !runtimeUsesCursor) {
      let requestTargetsCursor = requestedProviderType === 'cursor';
      if (
        !requestTargetsCursor
        && !runtimeBoundToExplicitProvider
        && requestedOpenAIModel
        && !requestedModelAvailableInGitHub
      ) {
        const cursorSettings = getCursorProviderSettings();
        const cursorOnlyModels = new Set([
          String(cursorSettings?.model || '').trim(),
          ...(Array.isArray(cursorSettings?.models) ? cursorSettings.models : [])
            .map((value) => String(value || '').trim()),
        ].filter(Boolean));
        requestTargetsCursor = cursorSettings?.enabled === true && cursorOnlyModels.has(requestedOpenAIModel);
      }
      if (requestTargetsCursor) {
        return res.status(409).json({
          error: 'Cursor model selection requires creating a new Cursor conversation',
          code: 'CURSOR_MODEL_REQUIRES_NEW_CONVERSATION',
        });
      }
    }
    if (
      useOpenAIProvider
      && requestedOpenAIModel
      && requestedOpenAIModel !== String(existingRuntimeSession?.provider_model || '').trim()
      && requestedOpenAIModel !== configuredOpenAIModel
      && !availableOpenAIModels.has(requestedOpenAIModel)
    ) {
      return res.status(400).json({
        error: `OpenAI model "${requestedOpenAIModel}" is not available`,
        code: 'OPENAI_MODEL_UNAVAILABLE',
      });
    }
    if (
      runtimeUsesOpenAI
      && requestedOpenAIModel
      && requestedOpenAIModel !== String(existingRuntimeSession?.provider_model || '').trim()
    ) {
      if (typeof rebindUnstartedOpenAIConversationModel !== 'function') {
        return res.status(409).json({
          error: 'OpenAI session model cannot be changed after the session starts',
          code: 'OPENAI_SESSION_MODEL_LOCKED',
        });
      }
      try {
        const reboundRuntime = await rebindUnstartedOpenAIConversationModel({
          conversationId,
          model: requestedOpenAIModel,
        });
        existingRuntimeSession.provider_model = reboundRuntime?.provider_model || requestedOpenAIModel;
        existingRuntimeSession.model = reboundRuntime?.model || requestedOpenAIModel;
      } catch (error) {
        return res.status(409).json({
          error: String(error?.message || error || 'Failed to change OpenAI session model'),
          code: 'OPENAI_SESSION_MODEL_REBIND_FAILED',
        });
      }
    }
    const openAIModel = runtimeUsesOpenAI
      ? String(existingRuntimeSession?.provider_model || existingRuntimeSession?.model || '').trim()
      : (
          requestedOpenAIModel === configuredOpenAIModel || availableOpenAIModels.has(requestedOpenAIModel)
            ? requestedOpenAIModel
            : configuredOpenAIModel
        );
    // Claude conversations resolve models against the Claude provider
    // catalog (the Copilot catalog does not know these ids). Per-turn model
    // switching is allowed: each Claude turn is a fresh query() with resume.
    const runtimeUsesClaude = runtimeProviderType === 'claude';
    const configuredClaude = runtimeUsesClaude ? getClaudeProviderSettings() : null;
    const requestedClaudeModel = runtimeUsesClaude ? String(model || '').trim() : '';
    const availableClaudeModels = new Set([
      String(configuredClaude?.model || '').trim(),
      String(existingRuntimeSession?.provider_model || '').trim(),
      ...(Array.isArray(configuredClaude?.availableModels) ? configuredClaude.availableModels : []),
      ...(Array.isArray(configuredClaude?.models) ? configuredClaude.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean)
      .flatMap((value) => [value, claudeBaseModelId(value)])
      .filter(Boolean));
    // The composer sends the base Claude model id plus a context tier; the
    // "[1m]" long-context variant id is composed here so the worker (and the
    // context-usage accounting) keep seeing the id the Agent SDK expects.
    const applyClaudeContextTier = (modelId) => {
      const requestedTier = String(contextTier || 'default').trim().toLowerCase();
      const baseId = claudeBaseModelId(modelId);
      if (requestedTier === 'long_context') {
        const variantId = claudeLongContextModelId(modelId);
        const variantMatch = Array.from(availableClaudeModels)
          .find((id) => id.toLowerCase() === variantId.toLowerCase());
        return variantMatch || modelId;
      }
      return baseId && (availableClaudeModels.has(baseId) || baseId === modelId) ? baseId : modelId;
    };
    const claudeModel = runtimeUsesClaude
      ? applyClaudeContextTier(
          availableClaudeModels.has(requestedClaudeModel)
            ? requestedClaudeModel
            : (String(existingRuntimeSession?.provider_model || '').trim() || String(configuredClaude?.model || '').trim()),
        )
      : '';
    // Cursor conversations resolve models against the Cursor provider catalog
    // (the Copilot catalog does not know these ids). Per-turn model switching
    // is allowed: each Cursor turn resumes the persisted agent.
    const configuredCursor = runtimeUsesCursor ? getCursorProviderSettings() : null;
    const requestedCursorModel = runtimeUsesCursor ? String(model || '').trim() : '';
    const availableCursorModels = new Set([
      String(configuredCursor?.model || '').trim(),
      String(existingRuntimeSession?.provider_model || '').trim(),
      ...(Array.isArray(configuredCursor?.models) ? configuredCursor.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean));
    const cursorModel = runtimeUsesCursor
      ? (availableCursorModels.has(requestedCursorModel)
          ? requestedCursorModel
          : (String(existingRuntimeSession?.provider_model || '').trim() || String(configuredCursor?.model || '').trim()))
      : '';
    const modelResolution = useOpenAIProvider
      ? {
          ok: !!openAIModel,
          model: openAIModel,
          modelVariantId: openAIModel,
          reasoningEffort: null,
          error: openAIModel ? null : 'OpenAI model is not configured',
        }
      : (runtimeUsesClaude
        ? {
            ok: !!claudeModel,
            model: claudeModel,
            modelVariantId: claudeModel,
            reasoningEffort: null,
            error: claudeModel ? null : 'Claude model is not configured',
          }
        : (runtimeUsesCursor
          ? {
              ok: !!cursorModel,
              model: cursorModel,
              modelVariantId: cursorModel,
              reasoningEffort: null,
              error: cursorModel ? null : 'Cursor model is not configured',
            }
          : resolveRequestedModel(model)));
    if (!modelResolution.ok) return res.status(400).json({ error: modelResolution.error, supportedModels: modelResolution.available || [] });
    const requestedModel = String(modelResolution.model || '').trim();
    const requestedAutoModel = requestedModel.toLowerCase() === AUTO_MODEL_SENTINEL;
    if (requestedAutoModel && conversationId && !newConversation) {
      const messageCount = Number(stmts.getConversationMessageCount?.get?.(conversationId)?.count || 0);
      const activeQueueCount = Number(stmts.getConversationActiveQueueCount?.get?.(conversationId)?.count || 0);
      if (messageCount > 0 || activeQueueCount > 0) {
        return res.status(409).json({
          error: 'Auto model selection is available only for a new conversation',
          code: 'AUTO_MODEL_REQUIRES_NEW_CONVERSATION',
          conversationId,
        });
      }
    }
    const requestedModelVariantId = String(modelResolution.modelVariantId || model || requestedModel).trim();
    const explicitReasoningEffort = String(reasoningEffort || '').trim();
    const requestedContextTier = String(contextTier || 'default').trim().toLowerCase();
    const openAIImageModel = useOpenAIProvider && isOpenAIImageModelId(requestedModel);
    if (imageTarget && !openAIImageModel) {
      return res.status(400).json({
        error: 'Select an image model before editing a generated image',
        code: 'IMAGE_TARGET_REQUIRES_IMAGE_MODEL',
      });
    }
    // Claude conversations validate effort against the Claude provider's
    // per-model levels ('none' = SDK default). Effort is per-turn: each Claude
    // turn is a fresh query(), so it can change between messages.
    const resolveClaudeReasoningEffort = () => {
      const requestedEffort = String(explicitReasoningEffort || '').trim().toLowerCase();
      const supported = Array.isArray(configuredClaude?.effortsByModel?.[String(requestedModel || '').trim().toLowerCase()])
        ? configuredClaude.effortsByModel[String(requestedModel || '').trim().toLowerCase()]
        : ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
      const effort = supported.includes(requestedEffort) ? requestedEffort : 'none';
      return { ok: true, effort: effort === 'none' ? 'none' : effort, supported };
    };
    let reasoningResolution = useOpenAIProvider
      ? resolveOpenAIReasoningEffort(explicitReasoningEffort, openAIModel)
      : (runtimeUsesClaude
        ? resolveClaudeReasoningEffort()
        : (runtimeUsesCursor
          ? { ok: true, effort: 'none', supported: ['none'] }
          : resolveRequestedReasoningEffort(
              requestedModel,
              explicitReasoningEffort || modelResolution.reasoningEffort || null,
            )));
    if (!reasoningResolution?.ok && !explicitReasoningEffort) {
      const supportedEfforts = Array.isArray(reasoningResolution?.supported)
        ? reasoningResolution.supported.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const fallbackReasoningEffort = supportedEfforts.includes('none')
        ? 'none'
        : (supportedEfforts[0] || null);
      if (fallbackReasoningEffort) {
        reasoningResolution = resolveRequestedReasoningEffort(requestedModel, fallbackReasoningEffort);
      }
    }
    if (!reasoningResolution?.ok) {
      return res.status(400).json({
        error: reasoningResolution?.error || 'Unsupported reasoning effort',
        supportedReasoningEfforts: Array.isArray(reasoningResolution?.supported) ? reasoningResolution.supported : [],
      });
    }
    const requestedReasoningEffort = reasoningResolution.effort || null;
    let normalizedContextTier = requestedContextTier;
    if (openAIImageModel) {
      normalizedContextTier = normalizeOpenAIImageSize(requestedContextTier) || 'auto';
      if (!normalizedContextTier) {
        return res.status(400).json({ error: 'Unsupported image size option' });
      }
    } else if (!['default', 'long_context'].includes(requestedContextTier)) {
      return res.status(400).json({ error: 'Unsupported context tier' });
    }
    if (!requestedRelayMode) return res.status(400).json({ error: 'Unsupported relay mode' });
    const conversationWorkspaceState = (!shouldCreateConversation && typeof resolveConversationWorkspaceState === 'function')
      ? resolveConversationWorkspaceState({ conversationId })
      : null;
    let workspaceRootUpdate = attachments.length === 0
      ? maybeApplyWorkspaceRootFromMessage(
          trimmedText,
          conversationWorkspaceState?.currentWorkspaceRootPath || null,
        )
      : { attempted: false, changed: false };

    if (!shouldCreateConversation) {
      const sessionState = getConversationSessionState(conversationId);
      if (!sessionState.ok) {
        return rejectSessionBinding(res, sessionState.status, sessionState.error);
      }
      conversationSdkSessionId = sessionState.conversationSdkSessionId || null;
      if (!sessionState.conversationSdkSessionId || !sessionState.runtimeSessionSdkSessionId) {
        return rejectSessionBinding(res, 409, 'Conversation is not session-bound yet');
      }
      if (sessionState.conversationSdkSessionId !== sessionState.runtimeSessionSdkSessionId) {
        return rejectSessionBinding(res, 409, 'Conversation session binding mismatch');
      }
    }

    if (!shouldCreateConversation) {
      const recentUserMessages = stmts.getRecentMessagesDesc.all(conversationId, 20);
      const recentQueueRows = db.prepare(`
        SELECT id, text, status, timestamp
        FROM queue
        WHERE conversation_id = ?
        ORDER BY timestamp DESC
        LIMIT 20
      `).all(conversationId);
      const duplicateMessage = findRecentDuplicateUserMessage({
        recentUserMessages,
        recentQueueRows,
        text: trimmedText,
      });
      if (duplicateMessage) {
        return res.json({
          ok: true,
          duplicate: true,
          duplicateWindowMs: DUPLICATE_USER_MESSAGE_WINDOW_MS,
          duplicateSource: duplicateMessage.source,
          duplicateOfMessageId: duplicateMessage.messageId,
          duplicateOfTimestamp: duplicateMessage.timestamp,
          conversationId,
        });
      }
    }

    const convId = shouldCreateConversation ? uuidv4() : conversationId;
    if (shouldCreateConversation) {
      getOrCreateConversation(convId, trimmedText || attachmentSummary(attachments) || 'Image');
    }
    let conversationWorkspaceRootState = null;
    if (workspaceRootUpdate.changed && workspaceRootUpdate.resolvedPath) {
      if (typeof updateConversationConfiguredWorkspaceRoot !== 'function') {
        workspaceRootUpdate = {
          ...workspaceRootUpdate,
          changed: false,
          error: 'Conversation workspace updates are unavailable',
        };
      } else {
        const updateResult = updateConversationConfiguredWorkspaceRoot({
          conversationId: convId,
          rootPath: workspaceRootUpdate.resolvedPath,
        });
        if (!updateResult?.ok) {
          workspaceRootUpdate = {
            ...workspaceRootUpdate,
            changed: false,
            error: updateResult?.error || 'Failed to update conversation workspace root',
          };
        } else {
          conversationWorkspaceRootState = updateResult?.state || null;
          workspaceRootUpdate = {
            ...workspaceRootUpdate,
            changed: true,
            rootPath: conversationWorkspaceRootState?.configuredWorkspaceRootPath || workspaceRootUpdate.resolvedPath,
            rootName: conversationWorkspaceRootState?.configuredWorkspaceRootName || workspaceRootUpdate.rootName || null,
          };
        }
      }
    }
    const convSeed = stmts.getConvSeed.get(convId);
    const shouldApplySeed = Number(convSeed?.seed_pending || 0) > 0 && String(convSeed?.summary_seed || '').trim().length > 0;

    const now   = new Date().toISOString();
    const runtimeSession = ensureRuntimeSessionBinding(
      convId,
      requestedModel,
      now,
      null,
      {
        assignConfiguredProvider: shouldCreateConversation,
        providerType: shouldCreateConversation
          ? (useOpenAIProvider ? 'openai' : 'github')
          : '',
        providerModel: shouldCreateConversation && useOpenAIProvider
          ? requestedModel
          : null,
      },
    );
    const ownerSessionId = resolveInitialQueueOwnerSessionId({
      routingEnabled: sessionWorkerRoutingEnabled,
      requesterSessionId,
      runtimeSession,
      conversationSdkSessionId,
      conversationId: convId,
      isNewConversation: shouldCreateConversation,
    });
    const msgId = clientMessageId || uuidv4();
    const queueText = shouldApplySeed
      ? [
          '[Carry-over context from previous compacted conversation]',
          String(convSeed.summary_seed).trim(),
          '',
          '[New user request]',
          trimmedText || '(User sent image attachments only.)',
        ].join('\n')
      : trimmedText;

    const requestedModelOrigin = deriveModelOrigin(requestedModelVariantId || requestedModel);
    let conversationPreferences;
    let imageOperation = null;
    const persistMessageAndQueue = db.transaction(() => {
      stmts.insertMsg.run(
        msgId,
        convId,
        'user',
        trimmedText,
        requestedModelVariantId,
        requestedRelayMode,
        attachments.length ? JSON.stringify(attachments) : null,
        now,
        requestedModelVariantId || null,
        null,
        requestedModelOrigin,
      );
      linkUploadReferences(convId, msgId, attachments);
      stmts.updateConvTime.run(now, convId);
      if (typeof stmts.updateConvDraft?.run === 'function') {
        stmts.updateConvDraft.run(null, now, sessionId || null, convId);
      } else {
        db.prepare(`
          UPDATE conversations
          SET draft_text = NULL, draft_updated_at = ?, draft_updated_by_client_id = ?
          WHERE id = ?
        `).run(now, sessionId || null, convId);
      }
      conversationPreferences = persistConversationModelPreference(
        convId,
        requestedRelayMode,
        requestedModel,
        requestedReasoningEffort,
        now,
      );
      stmts.insertQ.run(
        msgId,
        convId,
        runtimeSession?.id || null,
        (!conversationId || !!newConversation) ? 1 : 0,
        requestedModel,
        requestedModelVariantId,
        requestedReasoningEffort,
        normalizedContextTier,
        requestedRelayMode,
        queueText,
        attachments.length ? JSON.stringify(attachments) : null,
        now,
        ownerSessionId,
        ownerSessionId ? now : null,
        null,
        null,
        null,
      );
      if (imageContinuityEnabled && openAIImageModel) {
        if (!imageOperationService?.createEnqueuedOperation) {
          throw new Error('Image operation service is unavailable');
        }
        imageOperation = imageOperationService.createEnqueuedOperation({
          conversationId: convId,
          sourceMessageId: msgId,
          queueMessageId: msgId,
          prompt: trimmedText,
          selectedImageModel: requestedModel,
          executionMode: 'direct_images',
          parameters: {
            quality: requestedReasoningEffort,
            size: normalizedContextTier,
            count: 1,
          },
          attachments,
          imageTarget,
          createdAt: now,
        });
      }
    });
    persistMessageAndQueue();
    io.emit('conversation_draft_updated', {
      conversationId: convId,
      draftText: '',
      draftUpdatedAt: now,
      draftUpdatedByClientId: sessionId || null,
      senderClientId: sessionId || null,
    });
    if (ownerSessionId) {
      const existingWorker = sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
      sessionWorkerRegistry?.upsertWorker?.({
        ...(existingWorker || {}),
        sdkSessionId: ownerSessionId,
        conversationId: convId,
        runtimeSessionId: runtimeSession?.id || null,
        status: existingWorker?.status || 'new',
      });
      const pendingDepth = Number(queueCounts?.().pendingCount || 0);
      sessionWorkerSupervisor?.markIdle?.(ownerSessionId, pendingDepth);
      if (sessionWorkerRoutingEnabled) {
        emitSessionWorkerTelemetry('queue.message.queued', {
          sessionId: ownerSessionId,
          workerId: existingWorker?.workerId || null,
          conversationId: convId,
          messageId: msgId,
          continuationId: null,
          state: existingWorker?.status || 'new',
          retry: 0,
          pid: existingWorker?.pid || null,
        });
        if (typeof sessionWorkerSupervisor?.ensureWorker === 'function') {
          sessionWorkerSupervisor?.clearRestartSchedule?.(ownerSessionId, { resetKilledMarker: true });
          void sessionWorkerSupervisor.ensureWorker(ownerSessionId).then((result) => {
            if (!result?.ok) {
              emitSessionWorkerTelemetry('worker.prime.failed', {
                sessionId: ownerSessionId,
                workerId: result?.worker?.workerId || null,
                conversationId: convId,
                messageId: msgId,
                continuationId: null,
                state: result?.worker?.status || 'error',
                retry: result?.lifecycle?.retryCount || 0,
                pid: result?.worker?.pid || null,
                level: 'warn',
                extra: { blockedReason: String(result?.error || 'worker-prime-failed') },
              });
            }
          }).catch((error) => {
            emitSessionWorkerTelemetry('worker.prime.failed', {
              sessionId: ownerSessionId,
              workerId: null,
              conversationId: convId,
              messageId: msgId,
              continuationId: null,
              state: 'error',
              retry: 0,
              pid: null,
              level: 'warn',
              extra: { error: String(error?.message || error || 'worker-prime-failed') },
            });
          });
        }
      }
    }
    if (shouldApplySeed) {
      stmts.clearConvSeed.run(now, convId);
    }

    console.log(`[${ts()}] QUEUED    ${msgId.slice(0,8)} conv=${convId.slice(0,8)} rs=${String(runtimeSession?.id || 'none').slice(0,8)} owner=${String(ownerSessionId || 'none').slice(0,8)} new=${!conversationId || !!newConversation} model=${requestedModel} variant=${requestedModelVariantId}${requestedReasoningEffort ? ` effort=${requestedReasoningEffort}` : ''} mode=${requestedRelayMode} text="${trimmedText.slice(0,60)}"${shouldApplySeed ? ' seeded=1' : ''}${attachments.length ? ` attachments=${attachments.length}` : ''}`);

    emitToClientsExceptSessionId(
      'user_message',
      {
        conversationId: convId,
        messageId: msgId,
        senderClientId: sessionId,
        message: {
          role: 'user',
          text: trimmedText,
          model: requestedModelVariantId,
          modelOrigin: requestedModelOrigin || undefined,
          mode: requestedRelayMode,
          timestamp: now,
          attachments,
        },
      },
      sessionId,
    );
    io.emit('message_status', { messageId: msgId, conversationId: convId, status: 'pending' });
    if (conversationWorkspaceRootState?.conversationId) {
      const workspaceHints = workspaceRootPayload();
      io.emit('conversation_workspace_root_updated', {
        conversationId: conversationWorkspaceRootState.conversationId,
        sdkSessionId: conversationWorkspaceRootState.sdkSessionId || null,
        configuredWorkspaceRootPath: conversationWorkspaceRootState.configuredWorkspaceRootPath || null,
        configuredWorkspaceRootName: conversationWorkspaceRootState.configuredWorkspaceRootName || null,
        runtimeWorkspaceRootPath: conversationWorkspaceRootState.runtimeWorkspaceRootPath || null,
        runtimeWorkspaceRootName: conversationWorkspaceRootState.runtimeWorkspaceRootName || null,
        currentWorkspaceRootPath: conversationWorkspaceRootState.currentWorkspaceRootPath || null,
        currentWorkspaceRootName: conversationWorkspaceRootState.currentWorkspaceRootName || null,
        recentWorkspaceRoots: Array.isArray(workspaceHints?.recentWorkspaceRoots) ? workspaceHints.recentWorkspaceRoots : [],
      });
    }
    res.json({
      ok: true,
      messageId: msgId,
      conversationId: convId,
      runtimeSessionId: runtimeSession?.id || null,
      runtimeProviderType: String(runtimeSession?.provider_type || (useOpenAIProvider ? 'openai' : 'github')).trim().toLowerCase(),
      runtimeProviderModel: runtimeSession?.provider_model || (useOpenAIProvider ? openAIModel : null),
      ownerSessionId: ownerSessionId || null,
      preferredRelayMode: conversationPreferences.preferredRelayMode,
      preferredModel: conversationPreferences.preferredModel,
      preferredReasoningEffort: conversationPreferences.preferredReasoningEffort,
      warning: modelResolution.warning || null,
      selectedModelVariantId: requestedModelVariantId,
      selectedBaseModel: requestedModel,
      selectedReasoningEffort: requestedReasoningEffort,
      workspaceRootWarning: workspaceRootUpdate.error || null,
      workspaceRootChanged: !!workspaceRootUpdate.changed,
      ...workspaceRootPayload(),
      referenceAttachmentCount: referenceResolution.attachments.length,
      skippedReferenceAttachments: referenceResolution.skipped,
      imageOperation: imageOperation
        ? {
            id: imageOperation.id,
            mode: imageOperation.mode,
            kind: imageOperation.kind,
          }
        : null,
    });
  });

  app.post('/api/heartbeat', auth, (req, res) => {
    touchCli();
    const requester = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requester?.sessionId);
    const activeQueueMessageId = String(req.body?.activeQueueMessageId || '').trim();
    if (requesterSessionId) {
      const existingRequesterWorker = sessionWorkerRegistry?.getWorker?.(requesterSessionId) || null;
      const requesterPid = Number(requester?.pid);
      const normalizedRequesterPid = Number.isInteger(requesterPid) && requesterPid > 0 ? requesterPid : null;
      const requesterConversationId = String(requester?.conversationId || '').trim() || null;
      const shouldPromoteReady = !existingRequesterWorker
        || existingRequesterWorker.status === 'new'
        || (!existingRequesterWorker.workerId && !existingRequesterWorker.pid);
      if (shouldPromoteReady) {
        sessionWorkerRegistry?.upsertWorker?.({
          ...(existingRequesterWorker || {}),
          sdkSessionId: requesterSessionId,
          status: 'ready',
          conversationId: requesterConversationId || existingRequesterWorker?.conversationId || null,
          pid: normalizedRequesterPid || existingRequesterWorker?.pid || null,
          queueDepth: Math.max(0, Number(queueCounts?.().pendingCount || 0)),
        });
      } else if (normalizedRequesterPid && existingRequesterWorker?.pid !== normalizedRequesterPid) {
        sessionWorkerRegistry?.upsertWorker?.({
          ...existingRequesterWorker,
          sdkSessionId: requesterSessionId,
          pid: normalizedRequesterPid,
        });
      }
      sessionWorkerSupervisor?.noteSessionHeartbeat?.(requesterSessionId);
      if (activeQueueMessageId) {
        const now = new Date().toISOString();
        const leaseExpiresAt = addMsToIso(now, SESSION_WORKER_OWNER_LEASE_MS);
        refreshProcessingLeaseForOwnedMessage.run(leaseExpiresAt, now, activeQueueMessageId, requesterSessionId);
        recoverOwnedProcessingRowsForSession(requesterSessionId, {
          excludeMessageId: activeQueueMessageId,
          reason: 'owner-heartbeat-mismatch',
        });
      } else {
        recoverOwnedProcessingRowsForSession(requesterSessionId, {
          reason: 'owner-heartbeat-idle',
        });
      }
    }
    relayBridgeOwnerService?.observe?.(requester);
    const { pendingCount } = queueCounts();
    res.json({ ok: true, pendingCount });
  });

  // POST /api/claude-native-session — Claude worker persists the native Agent
  // SDK session id so later turns can resume it across worker restarts.
  app.post('/api/claude-native-session', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    const claudeNativeSessionId = String(req.body?.claudeNativeSessionId || '').trim();
    if (!conversationId || !claudeNativeSessionId) {
      return res.status(400).json({ error: 'Missing conversationId or claudeNativeSessionId' });
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId);
    if (!runtimeSession) {
      return res.status(404).json({ error: 'Runtime session not found for conversation' });
    }
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'claude') {
      return res.status(409).json({ error: 'Conversation is not bound to the Claude provider' });
    }
    if (typeof stmts.updateRuntimeSessionClaudeNativeSessionId?.run !== 'function') {
      return res.status(500).json({ error: 'Claude native session storage is unavailable' });
    }
    stmts.updateRuntimeSessionClaudeNativeSessionId.run(
      claudeNativeSessionId,
      new Date().toISOString(),
      conversationId,
    );
    res.json({ ok: true });
  });

  // POST /api/claude-context-usage — Claude worker reports the session's
  // context-window breakdown after a turn. Claude sessions have no Copilot
  // events.jsonl to tail, so this is what feeds the composer indicator and the
  // context-usage modal for them.
  app.post('/api/claude-context-usage', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });

    const contextUsage = req.body?.contextUsage && typeof req.body.contextUsage === 'object'
      ? req.body.contextUsage
      : null;
    const modelUsage = req.body?.modelUsage && typeof req.body.modelUsage === 'object'
      ? req.body.modelUsage
      : null;
    if (!contextUsage && !modelUsage) {
      return res.status(400).json({ error: 'Missing contextUsage or modelUsage' });
    }

    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId);
    if (!runtimeSession) {
      return res.status(404).json({ error: 'Runtime session not found for conversation' });
    }
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'claude') {
      return res.status(409).json({ error: 'Conversation is not bound to the Claude provider' });
    }
    if (typeof stmts.updateRuntimeSessionContextUsage?.run !== 'function') {
      return res.status(500).json({ error: 'Context usage storage is unavailable' });
    }

    const payload = JSON.stringify({
      model: String(req.body?.model || '').trim() || null,
      contextUsage,
      modelUsage,
    });
    stmts.updateRuntimeSessionContextUsage.run(payload, new Date().toISOString(), conversationId);
    res.json({ ok: true });
  });

  // POST /api/cursor-agent-id — Cursor worker persists the Cursor agent id so
  // later turns can resume the agent across worker restarts.
  app.post('/api/cursor-agent-id', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    const cursorAgentId = String(req.body?.cursorAgentId || '').trim();
    if (!conversationId || !cursorAgentId) {
      return res.status(400).json({ error: 'Missing conversationId or cursorAgentId' });
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId);
    if (!runtimeSession) {
      return res.status(404).json({ error: 'Runtime session not found for conversation' });
    }
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'cursor') {
      return res.status(409).json({ error: 'Conversation is not bound to the Cursor provider' });
    }
    if (typeof stmts.updateRuntimeSessionCursorAgentId?.run !== 'function') {
      return res.status(500).json({ error: 'Cursor agent id storage is unavailable' });
    }
    stmts.updateRuntimeSessionCursorAgentId.run(
      cursorAgentId,
      new Date().toISOString(),
      conversationId,
    );
    res.json({ ok: true });
  });

  // POST /api/cursor-context-usage — Cursor worker reports the session's
  // context-window breakdown after a turn. Cursor sessions have no Copilot
  // events.jsonl to tail, so this is what feeds the composer indicator and the
  // context-usage modal for them.
  app.post('/api/cursor-context-usage', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });

    const contextUsage = req.body?.contextUsage && typeof req.body.contextUsage === 'object'
      ? req.body.contextUsage
      : null;
    const modelUsage = req.body?.modelUsage && typeof req.body.modelUsage === 'object'
      ? req.body.modelUsage
      : null;
    if (!contextUsage && !modelUsage) {
      return res.status(400).json({ error: 'Missing contextUsage or modelUsage' });
    }

    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId);
    if (!runtimeSession) {
      return res.status(404).json({ error: 'Runtime session not found for conversation' });
    }
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'cursor') {
      return res.status(409).json({ error: 'Conversation is not bound to the Cursor provider' });
    }
    if (typeof stmts.updateRuntimeSessionContextUsage?.run !== 'function') {
      return res.status(500).json({ error: 'Context usage storage is unavailable' });
    }

    const payload = JSON.stringify({
      model: String(req.body?.model || '').trim() || null,
      contextUsage,
      modelUsage,
    });
    stmts.updateRuntimeSessionContextUsage.run(payload, new Date().toISOString(), conversationId);
    res.json({ ok: true });
  });

  // GET /api/pending — CLI fetches next pending message
  app.get('/api/pending', auth, async (req, res) => {
    touchCli();
    const requester = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requester?.sessionId);
    const sessionWorkerRoutingEnabled = isSessionWorkerRoutingEnabled(featureFlags);
    const ownerObservation = relayBridgeOwnerService?.observe?.(requester) || null;
    const now = new Date().toISOString();
    let affinityOnlyDequeue = !sessionWorkerRoutingEnabled && Boolean(requesterSessionId);
    let enforceOwnerMismatch = requester && ownerObservation?.accepted === false && !sessionWorkerRoutingEnabled;
    if (enforceOwnerMismatch && requesterSessionId && stmts.countQueueWorkForSessionAffinity) {
      const scopedWork = stmts.countQueueWorkForSessionAffinity.get(now, requesterSessionId);
      if (Number(scopedWork?.cnt || 0) > 0) {
        enforceOwnerMismatch = false;
        affinityOnlyDequeue = true;
      }
    }
    if (enforceOwnerMismatch) {
      return res.json({
        message: null,
        ownerMismatch: true,
        activeBridgeOwner: relayBridgeOwnerService?.getOwner?.() || null,
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
      });
    }
    if (sessionWorkerRoutingEnabled && requesterSessionId) {
      const requesterKillBlocked = sessionWorkerSupervisor?.isKillBlocked?.(requesterSessionId) === true;
      if (requesterKillBlocked) {
        return res.json({
          message: null,
          routing: {
            enabled: true,
            requesterSessionId,
            blockedReason: 'session-killed',
            lifecycle: sessionWorkerSupervisor?.getLifecycleState?.(requesterSessionId) || null,
            fallbackRestart: null,
          },
          restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        });
      }
      sessionWorkerSupervisor?.noteSessionHeartbeat?.(requesterSessionId);
    }
    if (runtimeState.relayPaused) return res.json({ message: null, paused: true });
    if (runtimeState.tunnelState?.blocking) {
      return res.json({
        message: null,
        paused: true,
        reason: 'ssh_tunnel_required',
        sshTunnel: {
          mode: runtimeState.tunnelState?.mode ?? null,
          required: runtimeState.tunnelState?.required ?? false,
          connected: runtimeState.tunnelState?.connected ?? false,
          lastError: runtimeState.tunnelState?.lastError ?? null,
        },
      });
    }
    const counts = queueCounts();
    if (sessionWorkerRoutingEnabled && requesterSessionId) {
      const existingRequesterWorker = sessionWorkerRegistry?.getWorker?.(requesterSessionId) || null;
      if (!existingRequesterWorker) {
        sessionWorkerRegistry?.upsertWorker?.({
          sdkSessionId: requesterSessionId,
          workerId: `worker-${requesterSessionId.slice(0, 8)}`,
          conversationId: requester?.conversationId || null,
          status: 'ready',
          pid: requester?.pid || null,
          queueDepth: Math.max(0, Number(counts.pendingCount || 0)),
        });
      } else if (requester?.pid && existingRequesterWorker.pid !== requester.pid) {
        sessionWorkerRegistry?.upsertWorker?.({
          ...existingRequesterWorker,
          sdkSessionId: requesterSessionId,
          conversationId: requester?.conversationId || existingRequesterWorker.conversationId || null,
          pid: requester.pid,
          status: existingRequesterWorker.status || 'ready',
          queueDepth: Math.max(0, Number(counts.pendingCount || 0)),
        });
      }
    }
    const restartProbe = relayRestartOrchestrator?.onDequeueProbe({
      processingCount: counts.processingCount,
      cliOnline: runtimeState.cliOnline,
    }) || null;
    const shouldUseRestartQueueGate = !sessionWorkerRoutingEnabled;
    const parkedCount = shouldUseRestartQueueGate ? parkPendingQueueForRestart({ stmts, state: restartProbe?.state }) : 0;
    const releasedRows = shouldUseRestartQueueGate ? releaseParkedQueueForReadyState({ db, stmts, state: restartProbe?.state }) : [];
    for (const row of releasedRows) {
      io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'pending' });
    }
    if (shouldUseRestartQueueGate && restartProbe?.blockDequeue) {
      return res.json({
        message: null,
        restartOrchestrator: restartProbe.state || relayRestartOrchestrator?.getState?.() || null,
        control: restartProbe.control || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    }

    let dequeueResult = null;
    try {
      dequeueResult = await dequeuePendingMessageForWorkerLoop({
        db,
        stmts,
        nowIso: now,
        routingEnabled: sessionWorkerRoutingEnabled,
        requesterSessionId,
        ownerLeaseMs: SESSION_WORKER_OWNER_LEASE_MS,
        affinityOnly: affinityOnlyDequeue,
        sessionWorkerSupervisor,
        relayRestartOrchestrator,
        inFlightProcessingCount: Number(counts.processingCount || 0),
        telemetry: (payload = {}) => {
          if (!sessionWorkerRoutingEnabled) return;
          emitSessionWorkerTelemetry(payload.event, {
            sessionId: payload.sessionId || requesterSessionId,
            workerId: payload.workerId || null,
            conversationId: payload.conversationId || null,
            messageId: payload.messageId || null,
            continuationId: payload.continuationId || null,
            state: payload.state || null,
            retry: payload.retry || 0,
            pid: payload.pid || requester?.pid || null,
            queue: counts,
            level: payload.event === 'queue.dequeue.error' ? 'warn' : 'log',
            extra: payload.error ? { error: payload.error, blockedReason: payload.blockedReason || null } : (payload.blockedReason ? { blockedReason: payload.blockedReason } : null),
          });
        },
      });
    } catch (error) {
      console.warn(`[${ts()}] DEQUEUE   failed requester=${String(requesterSessionId || 'none').slice(0, 8)} err=${String(error?.message || error || 'unknown dequeue failure')}`);
      if (sessionWorkerRoutingEnabled) {
        emitSessionWorkerTelemetry('queue.dequeue.failure', {
          sessionId: requesterSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(requesterSessionId)?.workerId || null,
          conversationId: null,
          messageId: null,
          continuationId: null,
          state: 'error',
          retry: 0,
          pid: requester?.pid || null,
          queue: counts,
          level: 'warn',
          extra: { error: String(error?.message || error || 'unknown dequeue failure') },
        });
      }
      return res.status(500).json({
        error: 'Failed to dequeue pending message',
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    }
    let msg = dequeueResult?.message || null;
    let dequeueBlockedReason = String(dequeueResult?.blockedReason || '').trim() || null;
    let fallbackRestart = dequeueResult?.fallbackRestart || null;
    let primedSessionId = null;
    if (!msg && sessionWorkerRoutingEnabled && requesterSessionId && dequeueBlockedReason) {
      const blockedTerminalFailure = resolveBlockedWorkerTerminalFailure({
        blockedReason: dequeueBlockedReason,
        requesterSessionId,
        lifecycle: dequeueResult?.lifecycle || null,
        worker: dequeueResult?.worker || null,
      });
      if (blockedTerminalFailure) {
        const blockedRow = findActiveOwnedBySession.get(requesterSessionId);
        if (blockedRow) {
          const failureText = buildTerminalFailureTextForChat({
            code: blockedTerminalFailure.code,
            stableCode: blockedTerminalFailure.stableCode,
            message: blockedTerminalFailure.message,
            detail: blockedTerminalFailure.detail,
            guidance: blockedTerminalFailure.guidance,
            requestId: blockedRow?.id || null,
          });
          failQueueMessage({
            queueRow: blockedRow,
            messageId: blockedRow.id,
            conversationId: blockedRow.conversation_id,
            relayMode: normalizeRelayMode(blockedRow.relay_mode) || DEFAULT_RELAY_MODE,
            model: blockedRow.model || null,
            responseText: failureText,
            failureRecord: blockedTerminalFailure,
          });
        }
      }
      emitSessionWorkerTelemetry('queue.dequeue.blocked', {
        sessionId: requesterSessionId,
        workerId: dequeueResult?.worker?.workerId || null,
        conversationId: dequeueResult?.worker?.conversationId || null,
        messageId: null,
        continuationId: null,
        state: dequeueResult?.worker?.status || 'error',
        retry: dequeueResult?.lifecycle?.retryCount || 0,
        pid: requester?.pid || dequeueResult?.worker?.pid || null,
        queue: counts,
        extra: {
          blockedReason: dequeueBlockedReason,
          fallbackRestartRequested: fallbackRestart?.requested === true,
        },
      });
      return res.json({
        message: null,
        routing: {
          enabled: true,
          requesterSessionId,
          blockedReason: dequeueBlockedReason,
          lifecycle: dequeueResult?.lifecycle || null,
          fallbackRestart,
          terminalOutcome: fallbackRestart?.terminalOutcome || null,
        },
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    }
    if (!msg && sessionWorkerRoutingEnabled && requesterSessionId && !dequeueBlockedReason) {
      const strandedOwner = findPendingOwnedByOtherSession.get(requesterSessionId, requesterSessionId, now);
      const strandedSessionId = normalizeSessionWorkerId(strandedOwner?.owner_sdk_session_id);
      const strandedRuntimeSession = strandedOwner?.runtime_session_id
        ? stmts.getRuntimeSessionById.get(strandedOwner.runtime_session_id)
        : null;
      const strandedExpectedOwnerSessionId = normalizeSessionWorkerId(strandedRuntimeSession?.sdk_session_id);
      const requesterMatchesRuntimeBinding = !!requesterSessionId
        && !!strandedExpectedOwnerSessionId
        && requesterSessionId === strandedExpectedOwnerSessionId;
      const strandedWorker = strandedSessionId
        ? (sessionWorkerRegistry?.getWorker?.(strandedSessionId) || sessionWorkerSupervisor?.getWorkerState?.(strandedSessionId) || null)
        : null;
      const strandedLifecycle = strandedSessionId
        ? (sessionWorkerSupervisor?.getLifecycleState?.(strandedSessionId) || null)
        : null;
      const strandedStatus = String(strandedWorker?.status || '').trim().toLowerCase();
      const lastPrimeAtMs = strandedSessionId ? Number(strandedPrimeCooldownBySession.get(strandedSessionId) || 0) : 0;
      const nowMs = Date.now();
      const cooldownActive = lastPrimeAtMs > 0 && (nowMs - lastPrimeAtMs) < STRANDED_SESSION_PRIME_COOLDOWN_MS;
      const heartbeatMs = Date.parse(String(strandedLifecycle?.lastHeartbeatAt || '').trim());
      const heartbeatFresh = Number.isFinite(heartbeatMs) && (nowMs - heartbeatMs) < STRANDED_SESSION_HEARTBEAT_FRESH_MS;
      const shouldSkipPrime = cooldownActive
        || strandedStatus === 'processing'
        || strandedStatus === 'starting'
        || (strandedStatus === 'ready' && heartbeatFresh);
      if (
        requesterMatchesRuntimeBinding
        && !!strandedExpectedOwnerSessionId
        && 
        shouldAutoPrimeStrandedSession({
          strandedRow: strandedOwner,
          requesterSessionId,
        })
        && !shouldSkipPrime
        && typeof sessionWorkerSupervisor?.ensureWorker === 'function'
        && sessionWorkerSupervisor?.isKillBlocked?.(strandedSessionId) !== true
      ) {
        strandedPrimeCooldownBySession.set(strandedSessionId, nowMs);
        try {
          const primeResult = await sessionWorkerSupervisor.ensureWorker(strandedSessionId);
          const shouldTakeOver = shouldTakeOverStrandedPendingMessage({
            strandedRow: strandedOwner,
            requesterSessionId,
            primeResult,
            strandedLifecycle,
            nowMs,
            heartbeatFreshWindowMs: STRANDED_SESSION_HEARTBEAT_FRESH_MS,
          });
          const primedTerminalFailure = resolvePrimedWorkerTerminalFailure({
            sessionId: strandedSessionId,
            primeResult,
          });
          if (primedTerminalFailure && strandedOwner?.id && strandedOwner?.conversation_id) {
            const strandedRow = stmts.findQById.get(strandedOwner.id);
            if (strandedRow && ['processing', 'pending', 'parked'].includes(String(strandedRow.status || '').trim().toLowerCase())) {
              const failureText = buildTerminalFailureTextForChat({
                code: primedTerminalFailure.code,
                stableCode: primedTerminalFailure.stableCode,
                message: primedTerminalFailure.message,
                detail: primedTerminalFailure.detail,
                guidance: primedTerminalFailure.guidance,
                requestId: strandedRow.id,
              });
              failQueueMessage({
                queueRow: strandedRow,
                messageId: strandedRow.id,
                conversationId: strandedRow.conversation_id,
                relayMode: normalizeRelayMode(strandedRow.relay_mode) || DEFAULT_RELAY_MODE,
                model: strandedRow.model || null,
                responseText: failureText,
                failureRecord: primedTerminalFailure,
              });
            }
          }
          if (
            shouldTakeOver
            && strandedOwner?.id
            && typeof transferPendingOwnerToSession?.run === 'function'
          ) {
            const transferResult = transferPendingOwnerToSession.run(
              requesterSessionId,
              now,
              strandedOwner.id,
              strandedSessionId,
            );
            if (Number(transferResult?.changes || 0) > 0) {
              emitSessionWorkerTelemetry('worker.prime.takeover', {
                sessionId: requesterSessionId,
                workerId: sessionWorkerRegistry?.getWorker?.(requesterSessionId)?.workerId || null,
                conversationId: strandedOwner?.conversation_id || null,
                messageId: strandedOwner?.id || null,
                continuationId: null,
                state: 'ready',
                retry: Number(strandedOwner?.retry_count || 0),
                pid: requester?.pid || null,
                queue: counts,
                extra: {
                  previousOwnerSessionId: strandedSessionId,
                  degradedReason: String(primeResult?.lifecycle?.degradedReason || strandedLifecycle?.degradedReason || ''),
                },
              });
              const recoveryDequeue = await dequeuePendingMessageForWorkerLoop({
                db,
                stmts,
                nowIso: new Date().toISOString(),
                routingEnabled: sessionWorkerRoutingEnabled,
                requesterSessionId,
                ownerLeaseMs: SESSION_WORKER_OWNER_LEASE_MS,
                affinityOnly: affinityOnlyDequeue,
                sessionWorkerSupervisor,
                relayRestartOrchestrator,
                inFlightProcessingCount: Number(queueCounts()?.processingCount || 0),
              });
              if (recoveryDequeue?.message) {
                msg = recoveryDequeue.message;
                dequeueBlockedReason = String(recoveryDequeue?.blockedReason || '').trim() || null;
                fallbackRestart = recoveryDequeue?.fallbackRestart || null;
              }
            }
          }
          primedSessionId = strandedSessionId;
          emitSessionWorkerTelemetry('worker.prime.requested', {
            sessionId: strandedSessionId,
            workerId: primeResult?.worker?.workerId || null,
            conversationId: strandedOwner?.conversation_id || null,
            messageId: strandedOwner?.id || null,
            continuationId: null,
            state: primeResult?.worker?.status || (primeResult?.ok ? 'ready' : 'error'),
            retry: primeResult?.lifecycle?.retryCount || 0,
            pid: primeResult?.worker?.pid || null,
            queue: counts,
            level: primeResult?.ok ? 'log' : 'warn',
            extra: primeResult?.ok ? null : { blockedReason: String(primeResult?.error || 'worker-prime-failed') },
          });
        } catch (error) {
          emitSessionWorkerTelemetry('worker.prime.failed', {
            sessionId: strandedSessionId,
            workerId: null,
            conversationId: strandedOwner?.conversation_id || null,
            messageId: strandedOwner?.id || null,
            continuationId: null,
            state: 'error',
            retry: 0,
            pid: null,
            queue: counts,
            level: 'warn',
            extra: { error: String(error?.message || error || 'worker-prime-failed') },
          });
        }
      }
    }
    if (msg) {
      const out = buildDequeuedRelayMessage({
        msg,
        stmts,
        parseAttachments,
        hydrateAttachment,
        ensureRuntimeSessionBinding,
        configuredConversationSessionMode,
        normalizeRelayMode,
        defaultRelayMode: DEFAULT_RELAY_MODE,
        defaultModel: DEFAULT_MODEL,
      });
      
      if (out.attachments.length) {
        const withPathCount = out.attachments.filter((att) => String(att?.path || '').trim()).length;
        const names = out.attachments.map((att) => String(att?.name || '').trim() || 'attachment').slice(0, 3).join(', ');
        console.log(`[${ts()}] ATTACH    ${out.id.slice(0,8)} files=${out.attachments.length} paths=${withPathCount} names=${JSON.stringify(names)}`);
      }

      if (sessionWorkerRoutingEnabled && out.ownerSessionId) {
        const existingWorker = sessionWorkerRegistry?.getWorker?.(out.ownerSessionId) || null;
        sessionWorkerRegistry?.upsertWorker?.({
          ...(existingWorker || {}),
          sdkSessionId: out.ownerSessionId,
          conversationId: out.conversationId,
          runtimeSessionId: out.runtimeSessionId,
          status: 'processing',
        });
        const processingDepth = Number(counts.processingCount || 0);
        sessionWorkerSupervisor?.markProcessing?.(out.ownerSessionId, processingDepth);
      }
      if (sessionWorkerRoutingEnabled) {
        emitSessionWorkerTelemetry('queue.message.dequeued', {
          sessionId: out.ownerSessionId || requesterSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(out.ownerSessionId || requesterSessionId)?.workerId || null,
          conversationId: out.conversationId,
          messageId: out.id,
          continuationId: null,
          state: 'processing',
          retry: Number(msg.retry_count || 0),
          pid: requester?.pid || null,
          queue: counts,
        });
      }
      console.log(`[${ts()}] DEQUEUED  ${out.id.slice(0,8)} conv=${out.conversationId.slice(0,8)} rs=${String(out.runtimeSessionId || 'none').slice(0,8)} owner=${String(out.ownerSessionId || 'none').slice(0,8)} model=${out.model}${out.reasoningEffort ? ` effort=${out.reasoningEffort}` : ''} mode=${out.relayMode} text="${out.text.slice(0,60)}"${out.attachments.length ? ` attachments=${out.attachments.length}` : ''}`);
      io.emit('message_status', { messageId: out.id, conversationId: out.conversationId, status: 'processing' });
      res.json({
        message: out,
        routing: sessionWorkerRoutingEnabled ? {
          enabled: true,
          requesterSessionId,
        } : { enabled: false },
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    } else {
      if (sessionWorkerRoutingEnabled && requesterSessionId) {
        const pendingDepth = Number(queueCounts?.().pendingCount || 0);
        sessionWorkerSupervisor?.markIdle?.(requesterSessionId, pendingDepth);
        emitSessionWorkerTelemetry('queue.dequeue.idle', {
          sessionId: requesterSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(requesterSessionId)?.workerId || null,
          conversationId: null,
          messageId: null,
          continuationId: null,
          state: 'ready',
          retry: 0,
          pid: requester?.pid || null,
          queue: counts,
        });
      }
      res.json({
        message: null,
        routing: sessionWorkerRoutingEnabled ? {
          enabled: true,
          requesterSessionId,
          primedSessionId,
          terminalOutcome: null,
        } : { enabled: false },
        restartOrchestrator: relayRestartOrchestrator?.getState?.() || null,
        parkedCount,
        releasedCount: releasedRows.length,
      });
    }
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

  app.post('/api/relay/recover-processing', auth, (req, res) => {
    const rawMaxAge = Number(req.body?.maxAgeMs);
    const maxAgeMs = Number.isFinite(rawMaxAge)
      ? Math.max(5_000, Math.min(300_000, rawMaxAge))
      : 15_000;
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const requeueAt = addMsIso(5_000);
    const rows = recoverProcessingOlderThan(cutoff, requeueAt);
    if (!rows.length) return res.json({ ok: true, recovered: 0, maxAgeMs });
    console.log(`[${ts()}] RELAY     recovered processing=${rows.length} maxAgeMs=${maxAgeMs}`);
    return res.json({ ok: true, recovered: rows.length, maxAgeMs });
  });

  app.post('/api/queue/empty', auth, (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ error: 'Queue empty endpoint is localhost-only' });
    }
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
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ error: 'Relay shutdown endpoint is localhost-only' });
    }
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
    const result = requestRelayShutdown({ reason, requestedBy, restart });
    return res.json({ ok: true, ...result });
  });

  app.post('/api/image-operations/:operationId/execute', auth, async (req, res) => {
    if (!isLoopbackRequest(req)) {
      return res.status(403).json({ error: 'Image operation execution is localhost-only' });
    }
    if (featureFlags?.IMAGE_CONVERSATION_CONTINUITY_ENABLED !== true) {
      return res.status(404).json({ error: 'Image continuity is not enabled' });
    }
    const operationId = String(req.params.operationId || '').trim();
    const operation = operationId ? stmts.getOperation?.get(operationId) : null;
    if (!operation) return res.status(404).json({ error: 'Image operation not found' });

    const committedNodes = stmts.listNodesForOperation?.all(operationId) || [];
    if (committedNodes.length) {
      return res.json({ ok: true, outcome: 'completed', operationId, nodeCount: committedNodes.length });
    }
    const queueRow = stmts.findQById.get(operation.queue_message_id);
    if (!queueRow || queueRow.image_operation_id !== operationId) {
      return res.status(409).json({ error: 'Image operation queue linkage is unavailable' });
    }

    const now = new Date().toISOString();
    const selfHeaders = {
      Authorization: `Bearer ${config.authToken}`,
      'Content-Type': 'application/json',
    };
    const selfBaseUrl = `http://127.0.0.1:${config.port}`;
    const acquireAttempt = db.transaction(() => {
      const current = stmts.getLatestAttempt.get(operationId);
      if (current?.status === 'started') {
        const attemptStartedAt = Date.parse(current.started_at);
        const queueProcessingAt = Date.parse(queueRow.processing_at);
        const recoveredAfterAttempt = Number.isFinite(attemptStartedAt)
          && Number.isFinite(queueProcessingAt)
          && queueProcessingAt > attemptStartedAt + 1_000;
        if (!recoveredAfterAttempt) return { acquired: false, attempt: current };
        stmts.finishAttempt.run({
          id: current.id,
          status: 'uncertain',
          providerRequestId: null,
          providerConversationId: null,
          providerResponseId: null,
          httpStatus: null,
          errorCode: 'IMAGE_ATTEMPT_INTERRUPTED',
          errorMessage: 'Image execution was interrupted after provider dispatch may have begun',
          completedAt: now,
        });
        return { acquired: false, attempt: current, stale: true };
      }
      const attempt = {
        id: `img_attempt_${uuidv4()}`,
        operationId,
        attemptNumber: Math.max(1, Number(current?.attempt_number || 0) + 1),
        provider: operation.provider,
        capabilitySnapshotJson: JSON.stringify({
          executionMode: operation.execution_mode,
          endpoint: 'images',
        }),
        startedAt: now,
      };
      stmts.insertAttempt.run(attempt);
      return { acquired: true, attempt: stmts.getLatestAttempt.get(operationId) };
    });
    const acquired = acquireAttempt();
    if (acquired.stale) {
      await fetch(`${selfBaseUrl}${remotePath}/api/response`, {
        method: 'POST',
        headers: selfHeaders,
        body: JSON.stringify({
          messageId: operation.queue_message_id,
          conversationId: operation.conversation_id,
          terminalFailure: {
            code: 'IMAGE_ATTEMPT_INTERRUPTED',
            message: 'Image generation may have completed before the relay was interrupted. It was not retried to avoid duplicate images.',
            retryable: false,
          },
        }),
      }).catch(() => null);
      return res.status(409).json({
        ok: false,
        outcome: 'uncertain',
        operationId,
        error: 'The previous image attempt ended in an uncertain state and was not retried',
      });
    }
    if (!acquired.acquired) {
      return res.status(202).json({ ok: true, outcome: 'executing', operationId });
    }

    const requestAttachments = [];
    if (operation.parent_node_id) {
      const parentNode = stmts.getNode.get(operation.parent_node_id);
      const parentMessage = parentNode
        ? db.prepare(`SELECT attachments FROM messages WHERE id = ?`).get(parentNode.assistant_message_id)
        : null;
      const parentAttachment = parseAttachments(parentMessage?.attachments).find((attachment) => (
        String(attachment?.generatedImage?.imageId || '').trim() === parentNode?.attachment_image_id
      ));
      const generatedImage = parentAttachment?.generatedImage;
      const parentPath = resolveGeneratedImageReadPath({
        resolveSessionStateRoot,
        sessionId: generatedImage?.sessionId,
        relativePath: generatedImage?.relativePath,
      });
      if (!parentPath) {
        stmts.finishAttempt.run({
          id: acquired.attempt.id,
          status: 'failed_terminal',
          providerRequestId: null,
          providerConversationId: null,
          providerResponseId: null,
          httpStatus: 400,
          errorCode: 'IMAGE_PARENT_UNAVAILABLE',
          errorMessage: 'The parent generated image is unavailable',
          completedAt: new Date().toISOString(),
        });
        return res.status(409).json({
          ok: false,
          outcome: 'terminal',
          code: 'IMAGE_PARENT_UNAVAILABLE',
          error: 'The parent generated image is unavailable',
        });
      }
      requestAttachments.push({
        name: parentAttachment.name,
        type: parentAttachment.type,
        path: parentPath,
      });
    } else {
      for (const asset of stmts.listAssets.all(operationId)) {
        requestAttachments.push({
          name: asset.original_name || 'reference-image',
          type: asset.media_type,
          path: uploadPathForSha(asset.content_sha256),
        });
      }
    }

    let parameters = {};
    try {
      parameters = JSON.parse(operation.parameters_json || '{}');
    } catch {}
    const generationBody = {
      messageId: operation.queue_message_id,
      conversationId: operation.conversation_id,
      model: operation.selected_image_model,
      prompt: operation.prompt,
      n: Number.isInteger(Number(parameters.count)) ? Number(parameters.count) : 1,
      attachments: requestAttachments,
    };
    if (parameters.size === 'auto' || /^\d{2,5}x\d{2,5}$/i.test(String(parameters.size || ''))) {
      generationBody.size = parameters.size;
    }
    if (/^(auto|standard|hd|low|medium|high)$/i.test(String(parameters.quality || ''))) {
      generationBody.quality = parameters.quality;
    }

    let generatedPayload = null;
    try {
      const generatedResponse = await fetch(`${selfBaseUrl}${remotePath}/api/openai/images/generate`, {
        method: 'POST',
        headers: selfHeaders,
        body: JSON.stringify(generationBody),
      });
      generatedPayload = await generatedResponse.json().catch(() => ({}));
      if (!generatedResponse.ok) {
        const error = new Error(generatedPayload?.error || `OpenAI image request failed (${generatedResponse.status})`);
        error.status = generatedResponse.status;
        throw error;
      }
      const finalizeResponse = await fetch(`${selfBaseUrl}${remotePath}/api/response`, {
        method: 'POST',
        headers: selfHeaders,
        body: JSON.stringify({
          messageId: operation.queue_message_id,
          conversationId: operation.conversation_id,
          text: '',
          generatedImages: generatedPayload.generatedImages,
          model: generatedPayload.model || operation.selected_image_model,
        }),
      });
      const finalized = await finalizeResponse.json().catch(() => ({}));
      if (!finalizeResponse.ok) {
        const error = new Error(finalized?.error || `Image finalization failed (${finalizeResponse.status})`);
        error.status = finalizeResponse.status;
        throw error;
      }
      return res.json({
        ok: true,
        outcome: 'completed',
        operationId,
        generatedImageCount: Array.isArray(generatedPayload.generatedImages)
          ? generatedPayload.generatedImages.length
          : 0,
      });
    } catch (error) {
      const status = Number(error?.status || 0);
      const terminal = status >= 400 && status < 500;
      const uncertain = !!generatedPayload?.generatedImages;
      const outcome = terminal ? 'terminal' : (uncertain ? 'uncertain' : 'retryable');
      stmts.finishAttempt.run({
        id: acquired.attempt.id,
        status: terminal ? 'failed_terminal' : (uncertain ? 'uncertain' : 'failed_retryable'),
        providerRequestId: null,
        providerConversationId: null,
        providerResponseId: null,
        httpStatus: status || null,
        errorCode: terminal ? 'IMAGE_PROVIDER_REJECTED' : (uncertain ? 'IMAGE_FINALIZATION_UNCERTAIN' : 'IMAGE_PROVIDER_UNAVAILABLE'),
        errorMessage: String(error?.message || 'Image operation failed').slice(0, 500),
        completedAt: new Date().toISOString(),
      });
      if (outcome === 'retryable') {
        const requeueResponse = await fetch(`${selfBaseUrl}${remotePath}/api/requeue`, {
          method: 'POST',
          headers: selfHeaders,
          body: JSON.stringify({ messageId: operation.queue_message_id }),
        }).catch(() => null);
        if (!requeueResponse?.ok) {
          console.warn(`[${ts()}] IMAGE_OP  failed to requeue retryable operation=${operationId}`);
        }
      } else {
        const failure = {
          code: outcome === 'uncertain' ? 'IMAGE_FINALIZATION_UNCERTAIN' : 'IMAGE_PROVIDER_REJECTED',
          message: String(error?.message || 'Image operation failed').slice(0, 500),
          retryable: false,
        };
        const failResponse = await fetch(`${selfBaseUrl}${remotePath}/api/response`, {
          method: 'POST',
          headers: selfHeaders,
          body: JSON.stringify({
            messageId: operation.queue_message_id,
            conversationId: operation.conversation_id,
            terminalFailure: failure,
          }),
        }).catch(() => null);
        if (!failResponse?.ok) {
          console.warn(`[${ts()}] IMAGE_OP  failed to finalize ${outcome} operation=${operationId}`);
        }
      }
      return res.status(outcome === 'retryable' ? 503 : 409).json({
        ok: false,
        outcome,
        operationId,
        error: String(error?.message || 'Image operation failed'),
      });
    }
  });

  app.post('/api/openai/images/generate', auth, async (req, res) => {
    touchCli();
    const settings = getOpenAIProviderSettings();
    if (settings?.configured !== true || !String(settings?.apiKey || '').trim()) {
      return res.status(503).json({ error: 'OpenAI BYOK is not configured' });
    }

    let requestBody;
    try {
      requestBody = normalizeOpenAIImageGenerateRequestBody(req.body, {
        maxImages: MAX_UPLOAD_ATTACHMENTS,
      });
    } catch (error) {
      return res.status(400).json({ error: error?.message || 'Invalid OpenAI image request' });
    }

    const baseUrl = String(settings.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return res.status(503).json({ error: 'OpenAI base URL is not configured' });

    let editAttachment = null;
    if (Array.isArray(requestBody.attachments) && requestBody.attachments.length > 0) {
      try {
        editAttachment = resolveOpenAIImageEditAttachment(requestBody.attachments, {
          maxImageBytes: MAX_UPLOAD_BYTES,
          allowedRootPath: uploadsDir,
          allowedGeneratedImagesRootPath: resolveSessionStateRoot?.() || '',
        });
      } catch (error) {
        return res.status(400).json({ error: error?.message || 'Invalid image attachment' });
      }
    }

    const options = {
      model: requestBody.model,
      prompt: requestBody.prompt,
    };
    const supportsResponseFormat = String(requestBody.model || '')
      .trim()
      .toLowerCase()
      .replace(/^openai\//, '')
      .startsWith('dall-e-');
    if (supportsResponseFormat) options.response_format = 'b64_json';
    if (requestBody.n !== undefined) options.n = requestBody.n;
    if (requestBody.size) options.size = requestBody.size;
    if (requestBody.quality) options.quality = requestBody.quality;

    const endpoint = editAttachment ? '/images/edits' : '/images/generations';
    let response;
    try {
      if (editAttachment) {
        const form = new FormData();
        form.set('model', options.model);
        form.set('prompt', options.prompt);
        if (options.response_format) form.set('response_format', String(options.response_format));
        if (options.n !== undefined) form.set('n', String(options.n));
        if (options.size) form.set('size', String(options.size));
        if (options.quality) form.set('quality', String(options.quality));
        form.set(
          'image',
          new Blob([editAttachment.bytes], { type: editAttachment.mimeType }),
          editAttachment.name,
        );
        response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: form,
        });
      } else {
        response = await fetch(`${baseUrl}${endpoint}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(options),
        });
      }
    } catch (error) {
      return res.status(502).json({ error: `OpenAI image API request failed: ${error?.message || 'request error'}` });
    }

    const rawText = String(await response.text().catch(() => '')).trim();
    let payload = {};
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        return res.status(502).json({ error: 'OpenAI image API returned invalid JSON' });
      }
    }

    if (!response.ok) {
      const detail = String(payload?.error?.message || payload?.message || rawText).trim().slice(0, 240);
      const upstreamStatus = Number(response.status);
      const relayStatus = Number.isFinite(upstreamStatus) && upstreamStatus >= 400 && upstreamStatus < 500
        ? upstreamStatus
        : 502;
      return res.status(relayStatus).json({
        error: `OpenAI image API failed (${response.status})${detail ? `: ${detail}` : ''}`,
        upstreamStatus: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
      });
    }

    let generatedImages = [];
    try {
      generatedImages = normalizeOpenAIImageApiGeneratedImages(payload, {
        maxImages: MAX_UPLOAD_ATTACHMENTS,
      });
    } catch (error) {
      return res.status(502).json({ error: error?.message || 'OpenAI image API returned no images' });
    }

    return res.json({
      ok: true,
      generatedImages,
      model: requestBody.model,
      endpoint,
    });
  });

  // POST /api/response — CLI submits response
  app.post('/api/response', auth, async (req, res) => {
    touchCli();
    const { messageId, conversationId, text, model, mode, generatedImages: rawGeneratedImages } = req.body;
    const trimmedText = String(text || '').trim();
    const terminalFailure = resolveTerminalFailurePayload(req.body, { fallbackText: trimmedText });
    let generatedImages = [];
    try {
      generatedImages = normalizeGeneratedImageResponses(rawGeneratedImages, {
        maxImages: MAX_UPLOAD_ATTACHMENTS,
        maxImageBytes: MAX_UPLOAD_BYTES,
      });
    } catch (error) {
      return res.status(400).json({ error: error?.message || 'Invalid generated images payload' });
    }

    if (!shouldAcceptAssistantResponsePayload({ text: trimmedText, terminalFailure, generatedImages })) {
      return res.status(400).json({ error: 'Empty response' });
    }
    if (!messageId) return res.status(400).json({ error: 'Missing messageId' });

    const q = stmts.findQById.get(messageId);
    const targetConversationId = q?.conversation_id || conversationId;
    if (!targetConversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const responseBridgeIdentity = readBridgeIdentity(req);

    if (q && q.status === 'done') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_done`);
      return res.json({ ok: true, ignored: 'already_done' });
    }
    if (q && q.status === 'failed') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_failed`);
      return res.json({ ok: true, ignored: 'already_failed' });
    }

    const relayMode = normalizeRelayMode(mode || q?.relay_mode) || DEFAULT_RELAY_MODE;
    if (terminalFailure) {
      const failureText = buildTerminalFailureTextForChat(terminalFailure, trimmedText);
      const failed = failQueueMessage({
        queueRow: q,
        messageId,
        conversationId: targetConversationId,
        relayMode,
        model: model || q?.model || null,
        responseText: failureText,
        failureRecord: {
          kind: 'terminal',
          code: terminalFailure.code,
          stableCode: terminalFailure.stableCode,
          message: terminalFailure.message || null,
          detail: terminalFailure.detail || null,
          guidance: terminalFailure.guidance || null,
          functionCallId: terminalFailure.functionCallId || null,
          requestId: terminalFailure.requestId || null,
          failedAt: new Date().toISOString(),
        },
      });
      if (!failed) {
        console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=not_pending_or_processing`);
        return res.json({ ok: true, ignored: 'not_pending_or_processing' });
      }
      settleRelayAbortControlsForQueueMessage(messageId, {
        ok: false,
        error: 'queue-terminal-failure',
      });
      settleRelaySubagentAbortControlsForQueueMessage(messageId, {
        ok: false,
        error: 'queue-terminal-failure',
      });
      console.warn(
        `[${ts()}] FAILED    ${messageId?.slice(0,8)} conv=${targetConversationId?.slice(0,8)} code=${terminalFailure.stableCode}`
        + `${terminalFailure.functionCallId ? ` call=${terminalFailure.functionCallId}` : ''}`
        + `${terminalFailure.requestId ? ` req=${terminalFailure.requestId}` : ''}`,
      );
      return res.json({ ok: true, terminal: true, code: terminalFailure.stableCode });
    }

    const holdCutoff = new Date(Date.now() - relayQuestionFinalizationHoldMs).toISOString();
    const hasPendingQuestion = !!stmts.findPendingQuestionByMessage?.get(messageId);
    const hasRecentlyAnsweredQuestion = !!stmts.findRecentlyAnsweredQuestionByMessage?.get(messageId, holdCutoff);
    const conversation = stmts.getConvAnyStatus?.get?.(targetConversationId) || null;
    const resolvedText = await resolveRelayResponseText({
      text: trimmedText,
      conversation,
      queueTimestamp: q?.timestamp || null,
      readSessionTranscriptMessages,
      opaqueResponseRecoveryWaitMs,
      opaqueResponseRecoveryPollMs,
      messageId,
      checkHasActiveRelayQuestion: (msgId) => {
        // Block finalization if there's a pending relay question for this turn.
        if (stmts.findPendingQuestionByMessage?.get(msgId)) return true;
        // Also hold for a short window after a question was answered. The SDK may fire another
        // onUserInputRequest (next ask_user call) within a few seconds of the previous answer.
        const holdCutoffIso = new Date(Date.now() - relayQuestionFinalizationHoldMs).toISOString();
        return !!(stmts.findRecentlyAnsweredQuestionByMessage?.get(msgId, holdCutoffIso));
      },
    });
    if (!resolvedText && generatedImages.length === 0) return res.status(400).json({ error: 'Empty response' });

    const responseId = uuidv4();
    const requestedModel = String(q?.model || '').trim() || null;
    const modelOrigin = deriveModelOrigin(requestedModel);
    const explicitModel = String(model || '').trim() || null;
    const resolvedAssistantModel = explicitModel
      || (modelOrigin === 'auto' ? 'unknown' : requestedModel)
      || null;
    const conversationRow = stmts.getConvAnyStatus?.get?.(targetConversationId) || null;
    const sdkSessionId = String(conversationRow?.sdk_session_id || targetConversationId || '').trim() || targetConversationId;
    let generatedImageAttachments = [];
    try {
      generatedImageAttachments = persistGeneratedImagesForAssistantResponse({
        images: generatedImages,
        messageId: responseId,
        conversationId: targetConversationId,
        sdkSessionId,
        resolveSessionStateRoot,
      });
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to persist generated images' });
    }
    const assistantAttachments = generatedImageAttachments.length ? JSON.stringify(generatedImageAttachments) : null;
    const now = new Date().toISOString();
    const imageOperation = q?.image_operation_id
      ? stmts.getOperation?.get(q.image_operation_id)
      : null;
    const finalize = db.transaction(() => {
      const result = stmts.setDone.run(resolvedText, messageId);
      if (result.changes === 0) return false;
      stmts.setQueueResponseMessageId?.run(responseId, messageId);
      stmts.insertMsg.run(
        responseId,
        targetConversationId,
        'assistant',
        resolvedText,
        resolvedAssistantModel,
        relayMode,
        assistantAttachments,
        now,
        requestedModel,
        explicitModel,
        modelOrigin,
      );
      stmts.linkActivityToResponse.run(responseId, messageId);
      stmts.linkStreamEventsToResponse?.run(responseId, messageId);
      stmts.linkThoughtsToResponse?.run(responseId, messageId);
      stmts.updateConvTime.run(now, targetConversationId);
      if (imageOperation && generatedImageAttachments.length) {
        const previousAttempt = stmts.getLatestAttempt?.get(imageOperation.id) || null;
        const attemptId = previousAttempt?.status === 'started'
          ? previousAttempt.id
          : `img_attempt_${uuidv4()}`;
        if (previousAttempt?.status !== 'started') {
          stmts.insertAttempt.run({
            id: attemptId,
            operationId: imageOperation.id,
            attemptNumber: Math.max(1, Number(previousAttempt?.attempt_number || 0) + 1),
            provider: imageOperation.provider,
            capabilitySnapshotJson: JSON.stringify({
              executionMode: imageOperation.execution_mode,
              finalizer: 'response',
            }),
            startedAt: now,
          });
        }
        for (const [outputIndex, attachment] of generatedImageAttachments.entries()) {
          const nodeId = `img_node_${uuidv4()}`;
          stmts.insertNode.run({
            id: nodeId,
            imageSessionId: imageOperation.image_session_id,
            operationId: imageOperation.id,
            assistantMessageId: responseId,
            attachmentImageId: attachment.generatedImage.imageId,
            outputIndex,
            createdAt: now,
          });
          if (imageOperation.parent_node_id) {
            stmts.insertEdgeChecked({
              imageSessionId: imageOperation.image_session_id,
              parentNodeId: imageOperation.parent_node_id,
              childNodeId: nodeId,
              operationId: imageOperation.id,
              createdAt: now,
            });
          }
        }
        stmts.finishAttempt.run({
          id: attemptId,
          status: 'succeeded',
          providerRequestId: null,
          providerConversationId: null,
          providerResponseId: responseId,
          httpStatus: 200,
          errorCode: null,
          errorMessage: null,
          completedAt: now,
        });
        stmts.touchSession.run(now, imageOperation.image_session_id);
      }
      stmts.pruneQueue.run();
      return true;
    });

    let finalized = false;
    try {
      finalized = finalize();
    } catch (error) {
      cleanupPersistedGeneratedImagesForAssistantResponse({
        attachments: generatedImageAttachments,
        resolveSessionStateRoot,
      });
      throw error;
    }
    if (!finalized) {
      cleanupPersistedGeneratedImagesForAssistantResponse({
        attachments: generatedImageAttachments,
        resolveSessionStateRoot,
      });
      const currentRow = stmts.findQById?.get(messageId) || null;
      const currentStatus = String(currentRow?.status || 'unknown');
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=not_pending_or_processing actual_status=${currentStatus}`);
      // Ensure UI is updated even if the response was duplicate/late
      if (currentStatus === 'done') {
        io.emit('message_status', { messageId, conversationId: targetConversationId, status: 'done' });
      } else if (currentStatus === 'failed') {
        io.emit('message_status', { messageId, conversationId: targetConversationId, status: 'failed' });
      }
      return res.json({ ok: true, ignored: 'not_pending_or_processing', actualStatus: currentStatus });
    }
    const queuedAtMs = Date.parse(String(q?.timestamp || '').trim());
    const processingAtMs = Date.parse(String(q?.processing_at || '').trim());
    const finalizedAtMs = Date.parse(now);
    const queueToDoneMs = Number.isFinite(queuedAtMs) && Number.isFinite(finalizedAtMs)
      ? Math.max(0, finalizedAtMs - queuedAtMs)
      : null;
    const processingToDoneMs = Number.isFinite(processingAtMs) && Number.isFinite(finalizedAtMs)
      ? Math.max(0, finalizedAtMs - processingAtMs)
      : null;
    const queueToProcessingMs = Number.isFinite(queuedAtMs) && Number.isFinite(processingAtMs)
      ? Math.max(0, processingAtMs - queuedAtMs)
      : null;
    settleRelayAbortControlsForQueueMessage(messageId, {
      ok: true,
      note: 'queue message completed before stop control was applied',
    });
    settleRelaySubagentAbortControlsForQueueMessage(messageId, {
      ok: false,
      error: 'queue-message-completed',
    });
    if (q?.runtime_session_id) {
      const nowIso = new Date().toISOString();
      const existing = stmts.getRuntimeSessionById.get(q.runtime_session_id);
      if (existing?.id) {
        stmts.touchRuntimeSession.run(
          String(model || existing.model || '').trim() || null,
          nowIso,
          existing.id,
        );
      }
    }
    if (isSessionWorkerRoutingEnabled(featureFlags) && q?.owner_sdk_session_id) {
      const ownerSessionId = normalizeSessionWorkerId(q.owner_sdk_session_id);
      if (ownerSessionId) {
        const existingWorker = sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
        sessionWorkerRegistry?.upsertWorker?.({
          ...(existingWorker || {}),
          sdkSessionId: ownerSessionId,
          conversationId: q?.conversation_id || targetConversationId,
          runtimeSessionId: q?.runtime_session_id || null,
          status: 'ready',
        });
        const pendingDepth = Number(queueCounts?.().pendingCount || 0);
        sessionWorkerSupervisor?.markIdle?.(ownerSessionId, pendingDepth);
        emitSessionWorkerTelemetry('queue.message.completed', {
          sessionId: ownerSessionId,
          workerId: sessionWorkerRegistry?.getWorker?.(ownerSessionId)?.workerId || null,
          conversationId: q?.conversation_id || targetConversationId,
          messageId,
          continuationId: null,
          state: 'ready',
          retry: Number(q?.retry_count || 0),
          pid: null,
        });
      }
    }
    let usageSnapshot = null;
    // `fetchUsageSummary` reads GitHub Copilot plan quota. Running it for a
    // Claude or OpenAI turn costs a pointless round-trip and renders Copilot
    // premium-request numbers under a reply that never touched Copilot.
    const responseProviderType = String(
      stmts.getRuntimeSessionByConversation?.get(targetConversationId)?.provider_type || 'github',
    ).trim().toLowerCase();
    if (responseProviderType === 'github' && typeof fetchUsageSummary === 'function' && stmts.upsertMessageUsageSnapshot) {
      const previousUsageRow = stmts.getLatestMessageUsageSnapshotByConversation?.get(targetConversationId) || null;
      const previousUsageSnapshot = usageSnapshotFromRow(previousUsageRow);
      try {
        const summary = await fetchUsageSummaryPromise(fetchUsageSummary);
        usageSnapshot = usageSnapshotFromSummary(summary, previousUsageSnapshot, {
          source: 'live',
          stale: false,
          capturedAt: now,
        });
      } catch (firstError) {
        try {
          await delay(USAGE_FETCH_RETRY_DELAY_MS);
          const summary = await fetchUsageSummaryPromise(fetchUsageSummary);
          usageSnapshot = usageSnapshotFromSummary(summary, previousUsageSnapshot, {
            source: 'live-retry',
            stale: false,
            capturedAt: now,
          });
        } catch (retryError) {
          usageSnapshot = staleUsageSnapshotFromRow(previousUsageRow, { capturedAt: now });
        }
      }
      if (usageSnapshot) {
        stmts.upsertMessageUsageSnapshot.run(
          responseId,
          messageId,
          targetConversationId,
          usageSnapshot.source,
          usageSnapshot.stale ? 1 : 0,
          usageSnapshot.premium.remaining,
          usageSnapshot.premium.entitlement,
          usageSnapshot.premium.usedPercent,
          usageSnapshot.premium.deltaUsed,
          usageSnapshot.chat.remaining,
          usageSnapshot.chat.entitlement,
          usageSnapshot.chat.usedPercent,
          usageSnapshot.chat.deltaUsed,
          usageSnapshot.plan.remaining,
          usageSnapshot.plan.entitlement,
          usageSnapshot.plan.usedPercent,
          usageSnapshot.plan.deltaUsed,
          usageSnapshot.capturedAt,
        );
      }
    }
    const activities = relayActivityForResponse(responseId);
    const thoughts = relayThoughtsForResponse ? relayThoughtsForResponse(responseId) : [];
    const emittedImageAttachments = generatedImageAttachments.map(hydrateAttachment).filter(Boolean);

    const responseLogText = String(resolvedText || '');
    console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} conv=${targetConversationId?.slice(0,8)} mode=${relayMode} len=${responseLogText.length} preview="${responseLogText.slice(0,60)}"${generatedImageAttachments.length ? ` images=${generatedImageAttachments.length}` : ''}`);

    io.emit('assistant_message', {
      conversationId: targetConversationId,
      sourceMessageId: messageId,
      messageId: responseId,
      message: {
        role: 'assistant',
        text: resolvedText,
        attachments: emittedImageAttachments.length ? emittedImageAttachments : undefined,
        model: resolvedAssistantModel,
        modelOrigin: modelOrigin || undefined,
        reasoningEffort: String(q?.reasoning_effort || '').trim() || null,
        mode: relayMode,
        usage: usageSnapshot,
        timestamp: now,
        activities,
        thoughts,
      },
    });
    io.emit('message_status', { messageId, conversationId: targetConversationId, status: 'done' });
    cancelPendingRelayQuestionsForMessage(messageId);
    res.json({ ok: true });
  });

  // POST /api/activity — relay sends in-flight activity updates (tool/search sections)
  app.post('/api/activity', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, mode, subagentRunId } = req.body || {};
    const activityText = sanitizeActivityText(text);
    if (!messageId || !conversationId || !activityText) {
      return res.status(400).json({ error: 'Missing activity payload' });
    }

    const q = stmts.findQById.get(messageId);
    const responseMessageId = q?.response_message_id || null;
    const normalizedSubagentRunId = subagentRunId ? String(subagentRunId).trim() : null;
    stmts.insertActivity.run(
      messageId,
      responseMessageId,
      conversationId,
      normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      activityText,
      new Date().toISOString(),
      normalizedSubagentRunId,
    );

    io.emit('relay_activity', {
      messageId,
      conversationId,
      mode: normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      text: activityText,
      timestamp: new Date().toISOString(),
      subagentRunId: normalizedSubagentRunId || undefined,
    });
    res.json({ ok: true });
  });

  // POST /api/stream — relay sends in-flight assistant text stream updates
  app.post('/api/stream', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, mode, done, subagentRunId } = req.body || {};
    const streamText = String(text || '');
    const normalizedSubagentRunId = subagentRunId ? String(subagentRunId).trim() : null;
    if (!messageId || !conversationId) {
      return res.status(400).json({ error: 'Missing stream payload' });
    }

    const now = new Date().toISOString();
    const requestedConversationId = String(conversationId || '').trim();
    const queueRow = stmts.findQById.get(messageId);
    if (!queueRow) {
      return res.status(404).json({ error: 'Queue message not found' });
    }
    const queueConversationId = String(queueRow.conversation_id || '').trim();
    if (!queueConversationId || queueConversationId !== requestedConversationId) {
      return res.status(409).json({ error: 'Stream conversationId does not match queue conversation' });
    }

    const isStreamSeqConstraintError = (error) => {
      const message = String(error?.message || '').toLowerCase();
      return message.includes('unique constraint failed')
        && message.includes('relay_stream_events')
        && message.includes('queue_message_id')
        && message.includes('seq');
    };

    let seq = null;
    try {
      const insertStreamEventTx = db.transaction(() => {
        const q = stmts.findQById.get(messageId) || queueRow;
        const currentConversationId = String(q?.conversation_id || '').trim();
        if (!currentConversationId || currentConversationId !== requestedConversationId) {
          const error = new Error('Stream conversationId does not match queue conversation');
          error.code = 'STREAM_CONVERSATION_MISMATCH';
          throw error;
        }
        const responseMessageId = q?.response_message_id || null;
        const row = stmts.getLastStreamSeqByQueueMessage?.get(messageId);
        const maxSeq = Math.max(0, Number(row?.max_seq || 0));
        const nextSeq = maxSeq + 1;
        stmts.insertStreamEvent?.run(
          messageId,
          responseMessageId,
          conversationId,
          normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
          nextSeq,
          streamText,
          done ? 1 : 0,
          now,
          normalizedSubagentRunId,
        );
        return nextSeq;
      });
      const runInsertStreamEvent = typeof insertStreamEventTx?.immediate === 'function'
        ? insertStreamEventTx.immediate.bind(insertStreamEventTx)
        : insertStreamEventTx;
      const maxRetries = 4;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          seq = runInsertStreamEvent();
          break;
        } catch (error) {
          if (error?.code === 'STREAM_CONVERSATION_MISMATCH') {
            return res.status(409).json({ error: error.message });
          }
          const shouldRetry = isStreamSeqConstraintError(error) && attempt < maxRetries;
          if (!shouldRetry) throw error;
        }
      }
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to persist stream event' });
    }

    io.emit('relay_stream', {
      messageId,
      conversationId,
      mode: normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      text: streamText,
      done: !!done,
      seq,
      timestamp: now,
      subagentRunId: normalizedSubagentRunId || undefined,
    });
    res.json({ ok: true, seq });
  });

  // POST /api/thought — relay sends in-flight agent reasoning ("thoughts").
  // Mirrors /api/stream but preserves full text (no 200-char cap). Events with reasoningId
  // are persisted as coalesced snapshots (done false/true). Events without reasoningId are
  // persisted only for terminal blocks (done:true). All updates are emitted live.
  app.post('/api/thought', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, mode, reasoningId, done, subagentRunId } = req.body || {};
    const thoughtText = String(text || '');
    const normalizedSubagentRunId = subagentRunId ? String(subagentRunId).trim() : null;
    if (!messageId || !conversationId) {
      return res.status(400).json({ error: 'Missing thought payload' });
    }

    const now = new Date().toISOString();
    const requestedConversationId = String(conversationId || '').trim();
    const queueRow = stmts.findQById.get(messageId);
    if (!queueRow) {
      return res.status(404).json({ error: 'Queue message not found' });
    }
    const queueConversationId = String(queueRow.conversation_id || '').trim();
    if (!queueConversationId || queueConversationId !== requestedConversationId) {
      return res.status(409).json({ error: 'Thought conversationId does not match queue conversation' });
    }

    const relayMode = normalizeRelayMode(mode) || DEFAULT_RELAY_MODE;
    const normalizedReasoningId = String(reasoningId || '').trim() || null;
    let seq = null;
    const shouldPersistThought = !!done || !!normalizedReasoningId;
    if (shouldPersistThought) {
      const isThoughtSeqConstraintError = (error) => {
        const message = String(error?.message || '').toLowerCase();
        return message.includes('unique constraint failed')
          && message.includes('relay_thought')
          && message.includes('queue_message_id')
          && (message.includes('seq') || message.includes('reasoning_id'));
      };
      try {
        const insertThoughtTx = db.transaction(() => {
          const q = stmts.findQById.get(messageId) || queueRow;
          const currentConversationId = String(q?.conversation_id || '').trim();
          if (!currentConversationId || currentConversationId !== requestedConversationId) {
            const error = new Error('Thought conversationId does not match queue conversation');
            error.code = 'THOUGHT_CONVERSATION_MISMATCH';
            throw error;
          }
          const responseMessageId = q?.response_message_id || null;
          if (normalizedReasoningId) {
            const existingThought = stmts.getThoughtByQueueAndReasoning?.get(messageId, normalizedReasoningId) || null;
            if (existingThought) {
              const existingSeq = Math.max(0, Number(existingThought.seq || 0));
              stmts.updateThoughtByQueueAndReasoning?.run(
                responseMessageId,
                requestedConversationId,
                relayMode,
                thoughtText,
                done ? 1 : 0,
                now,
                normalizedSubagentRunId,
                messageId,
                normalizedReasoningId,
              );
              return existingSeq;
            }
          }
          const row = stmts.getLastThoughtSeqByQueueMessage?.get(messageId);
          const maxSeq = Math.max(0, Number(row?.max_seq || 0));
          const nextSeq = maxSeq + 1;
          stmts.insertThought?.run(
            messageId,
            responseMessageId,
            requestedConversationId,
            relayMode,
            normalizedReasoningId,
            nextSeq,
            thoughtText,
            done ? 1 : 0,
            now,
            normalizedSubagentRunId,
          );
          return nextSeq;
        });
        const runInsertThought = typeof insertThoughtTx?.immediate === 'function'
          ? insertThoughtTx.immediate.bind(insertThoughtTx)
          : insertThoughtTx;
        const maxRetries = 4;
        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
          try {
            seq = runInsertThought();
            break;
          } catch (error) {
            if (error?.code === 'THOUGHT_CONVERSATION_MISMATCH') {
              return res.status(409).json({ error: error.message });
            }
            const shouldRetry = isThoughtSeqConstraintError(error) && attempt < maxRetries;
            if (!shouldRetry) throw error;
          }
        }
      } catch (error) {
        return res.status(500).json({ error: error?.message || 'Failed to persist thought' });
      }
    }

    io.emit('relay_thought', {
      messageId,
      conversationId,
      mode: relayMode,
      reasoningId: normalizedReasoningId,
      text: thoughtText,
      done: !!done,
      seq,
      timestamp: now,
      subagentRunId: normalizedSubagentRunId || undefined,
    });
    res.json({ ok: true, seq });
  });

  // POST /api/subagent-run — relay notifies about subagent lifecycle events
  app.post('/api/subagent-run', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, subagentRunId, parentSubagentId, displayName, status } = req.body || {};
    const normalizedSubagentRunId = subagentRunId ? String(subagentRunId).trim() : null;
    const normalizedParentSubagentId = parentSubagentId ? String(parentSubagentId).trim() : null;
    const normalizedDisplayName = displayName ? String(displayName).trim() : null;
    const normalizedStatus = status ? String(status).trim() : 'running';

    if (!messageId || !conversationId || !normalizedSubagentRunId) {
      return res.status(400).json({ error: 'Missing required subagent-run fields: messageId, conversationId, subagentRunId' });
    }

    const q = stmts.findQById.get(messageId);
    const existingRun = stmts.getSubagentRun?.get(normalizedSubagentRunId);
    const binding = validateSubagentRunBinding({
      queueRow: q,
      messageId,
      conversationId,
      existingRun,
    });
    if (!binding.ok) {
      return res.status(binding.statusCode || 409).json({ error: binding.error || 'Subagent run binding mismatch' });
    }
    const authoritativeConversationId = String(binding.conversationId || conversationId || '').trim();

    const now = new Date().toISOString();

    if (existingRun) {
      const isTerminal = normalizedStatus === 'completed' || normalizedStatus === 'failed' || normalizedStatus === 'cancelled';
      stmts.updateSubagentRunStatus?.run(
        normalizedStatus,
        now,
        isTerminal ? now : null,
        normalizedSubagentRunId,
      );
    } else {
      stmts.insertSubagentRun?.run(
        normalizedSubagentRunId,
        messageId,
        authoritativeConversationId,
        normalizedParentSubagentId,
        normalizedDisplayName,
        normalizedStatus,
        now,
        now,
      );
    }

    io.emit('subagent_status', {
      messageId,
      conversationId: authoritativeConversationId,
      subagentRunId: normalizedSubagentRunId,
      parentSubagentId: normalizedParentSubagentId || undefined,
      displayName: normalizedDisplayName || undefined,
      status: normalizedStatus,
      timestamp: now,
    });

    res.json({ ok: true });
  });

  // POST /api/requeue — relay re-queues a message it failed to process
  app.post('/api/requeue', auth, (req, res) => {
    const { messageId } = req.body;
    const q = stmts.findQById.get(messageId);
    const terminalFailure = resolveTerminalFailurePayload(req.body);
    const ownerSessionId = isSessionWorkerRoutingEnabled(featureFlags)
      ? normalizeSessionWorkerId(q?.owner_sdk_session_id)
      : null;
    const currentStatus = String(q?.status || '').trim().toLowerCase();
    const canTerminalFail = q && ['processing', 'pending', 'parked'].includes(currentStatus);
    if (terminalFailure && canTerminalFail) {
      const failureText = buildTerminalFailureTextForChat(terminalFailure);
      const failed = failQueueMessage({
        queueRow: q,
        messageId,
        conversationId: q?.conversation_id,
        relayMode: normalizeRelayMode(q?.relay_mode) || DEFAULT_RELAY_MODE,
        model: q?.model || null,
        responseText: failureText,
        failureRecord: {
          kind: 'terminal',
          error: 'terminal-error',
          code: terminalFailure.code,
          stableCode: terminalFailure.stableCode,
          message: terminalFailure.message || null,
          detail: terminalFailure.detail || null,
          guidance: terminalFailure.guidance || null,
          functionCallId: terminalFailure.functionCallId || null,
          requestId: terminalFailure.requestId || null,
          retryCount: Number(q?.retry_count || 0),
          failedAt: new Date().toISOString(),
        },
      });
      if (failed) {
        settleRelayAbortControlsForQueueMessage(messageId, {
          ok: false,
          error: 'queue-terminal-failure',
        });
        settleRelaySubagentAbortControlsForQueueMessage(messageId, {
          ok: false,
          error: 'queue-terminal-failure',
        });
        console.warn(
          `[${ts()}] FAILED    ${messageId?.slice(0,8)} retry=${Number(q?.retry_count || 0)} reason=terminal code=${terminalFailure.stableCode}`,
        );
      }
      return res.json({ ok: true, terminal: true, code: terminalFailure.stableCode });
    }
    if (q && q.status === 'processing') {
      const retryCount = Number(q.retry_count || 0) + 1;
      if (retryCount >= MAX_REQUEUE_RETRIES) {
        const now = new Date().toISOString();
        const failText = `Relay timeout after ${retryCount} attempts. Message was skipped to keep the queue moving. Retry the message.`;
        failQueueMessage({
          queueRow: { ...q, retry_count: retryCount },
          messageId,
          conversationId: q.conversation_id,
          relayMode: normalizeRelayMode(q.relay_mode) || DEFAULT_RELAY_MODE,
          model: q.model || null,
          responseText: failText,
          failureRecord: {
            kind: 'requeue-timeout',
            error: 'timeout',
            code: 'retry-timeout',
            stableCode: 'relay.retry-timeout',
            retryCount,
            failedAt: now,
          },
        });
        console.log(`[${ts()}] FAILED    ${messageId?.slice(0,8)} retry=${retryCount} reason=timeout`);
      } else {
        const restartState = relayRestartOrchestrator?.getState?.() || null;
        const parkForRestart = shouldParkForRestart(restartState);
        const nextAttemptAt = parkForRestart ? null : addMsIso(computeRetryDelayMs(retryCount));
        const result = db.prepare(`
          UPDATE queue
          SET
            status = ?,
            processing_at = NULL,
            retry_count = ?,
            next_attempt_at = ?,
            owner_lease_expires_at = NULL,
            parked_at = ?,
            parked_target_session_id = ?,
            parked_transaction_id = ?,
            parked_reason = ?
          WHERE id = ? AND status = 'processing'
        `).run(
          parkForRestart ? 'parked' : 'pending',
          retryCount,
          nextAttemptAt,
          parkForRestart ? new Date().toISOString() : null,
          parkForRestart ? (restartState?.targetSessionId || null) : null,
          parkForRestart ? (restartState?.transactionId || null) : null,
          parkForRestart ? (restartState?.lastError || 'session-rebind-pending') : null,
          messageId,
        );
        if (result.changes > 0) {
          settleRelayAbortControlsForQueueMessage(messageId, {
            ok: false,
            error: parkForRestart ? 'queue-parked' : 'queue-requeued',
          });
          settleRelaySubagentAbortControlsForQueueMessage(messageId, {
            ok: false,
            error: parkForRestart ? 'queue-parked' : 'queue-requeued',
          });
          if (ownerSessionId) {
            sessionWorkerSupervisor?.markError?.(ownerSessionId, `requeue-retry:${retryCount}`);
            emitSessionWorkerTelemetry('queue.message.requeued', {
              sessionId: ownerSessionId,
              workerId: sessionWorkerRegistry?.getWorker?.(ownerSessionId)?.workerId || null,
              conversationId: q?.conversation_id || null,
              messageId,
              continuationId: null,
              state: parkForRestart ? 'parked' : 'pending',
              retry: retryCount,
              pid: null,
              extra: parkForRestart ? { parkedForRestart: true } : null,
            });
          }
          console.log(`[${ts()}] REQUEUED  ${messageId?.slice(0,8)} retry=${retryCount} status=${parkForRestart ? 'parked' : 'pending'}${nextAttemptAt ? ` next=${nextAttemptAt}` : ''}`);
          io.emit('message_status', { messageId, conversationId: q?.conversation_id, status: parkForRestart ? 'parked' : 'pending' });
        }
      }
    }
    res.json({ ok: true });
  });
}
