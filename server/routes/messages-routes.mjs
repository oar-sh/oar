'use strict';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { stripRelayPromptContext } from '../services/relay-prompt-sanitizer.mjs';
import { resolveUploadMimeType } from '../services/mime-sniffer.mjs';
import { fileVersionToken, serveFileWithRangeSupport, withFileVersion } from '../services/file-serving.mjs';
import { validateEntryName } from '../services/explorer-entry-name.mjs';
import { countEntries, createDirectory, removeEntry, renameEntry } from '../services/explorer-mutations.mjs';
import {
  shouldParkForRestart,
  parkPendingQueueForRestart,
  releaseParkedQueueForReadyState,
} from '../services/relay-queue-gate-service.mjs';
import {
  persistConversationModelPreference as persistConversationModelPreferenceTx,
} from '../services/conversation-preferences-service.mjs';
import { fallbackReasoningEffort, inheritedConversationModel } from '../services/conversation-model-fallback.mjs';
import { killTmuxSession } from '../services/session-worker-launch-service.mjs';
import { normalizeWorkerKind, normalizeWorkerSteeringSnapshot } from '../services/session-worker-registry-service.mjs';
import {
  buildSteerSettleFailure,
  steerAgentLabelForProvider,
  STEER_SETTLE_FAILED_CODE,
  STEER_SETTLE_FAILED_STABLE_CODE,
} from '../../shared/steer-settle-failure.mjs';
import { FAILURE_NOTE_LEAD_MAX, matchFailureNote } from '../../shared/failure-note-text.mjs';
import { buildRelayStopFailure } from '../../shared/relay-stop-failure.mjs';
import { stopSessionWorkerProcesses } from '../services/session-worker-stop-service.mjs';
import {
  fetchUsageSummaryPromise,
  staleUsageSnapshotFromRow,
  usageSnapshotFromRow,
  usageSnapshotFromSummary,
} from '../services/usage-snapshot-helpers.mjs';
import { claudePlanUsageFromResult, normalizeClaudePlanUsage } from '../services/plan-usage-claude.mjs';
import { isUsageLimitTerminalError } from '../services/usage-limit-pause-service.mjs';
import { normalizeCopilotWorkerUsage } from '../services/plan-usage-copilot.mjs';
import { normalizeGrokTurnUsage } from '../services/plan-usage-grok.mjs';
import { normalizeDeepSeekUsageReport } from '../services/plan-usage-deepseek.mjs';
import { openAIReasoningEffortsForModel } from '../../shared/openai-reasoning.mjs';
import { DEFAULT_CLAUDE_REASONING_EFFORTS } from '../services/provider-reasoning-effort.mjs';
import { claudeBaseModelId, claudeLongContextModelId } from '../../shared/model-id.mjs';
import { sanitizeSubagentRunId } from '../../shared/subagent-run-id.mjs';
import { normalizeBackgroundTaskDigest } from '../../shared/worker-runtime/background-task-digest.mjs';
import {
  DEFAULT_TASK_STALL_MINUTES,
  TASK_OUTPUT_LIMITS,
  cleanTaskText,
  normalizeTaskCommand,
  normalizeTaskOutputKind,
  normalizeTaskOutputPath,
} from '../../shared/task-output-text.mjs';
import { readBefore, readTail, shapeSnapshot, taskOutputSource } from '../services/task-output-service.mjs';
import { taskKindOf } from '../services/session-activity-tracker.mjs';
import { ANSWERED_ELSEWHERE_KIND, STEER_FOLDED_TEXT } from '../../shared/steer-settle-markers.mjs';
import { isLiveResend } from '../services/steer-resend.mjs';
import {
  checkRequestedProviderModel,
  resolveProviderModelSelection,
  unknownProviderModelText,
} from '../services/provider-model-selection.mjs';
import { stripRemotePromptHeader } from '../../shared/remote-relay-contract.mjs';
import { stripModelTierSuffix } from '../../shared/claude-cloud/repo-url.mjs';
import {
  createSubagentTimelineService,
  mapSubagentRunHeader,
  sanitizeRunHeaderPatch,
  TIMELINE_READ_DEFAULT_LIMIT,
} from '../services/subagent-timeline-service.mjs';
import { SUBAGENT_TASK_TYPES, isTerminalSubagentRunStatus, normalizeSubagentRunStatus } from '../../shared/subagent-timeline.mjs';
import { isRelayAutomatedMessageKind } from '../../shared/relay-events.mjs';
import { isRelayShutdownQueued, relayShutdownGateReply } from '../services/relay-shutdown-gate.mjs';
import { createStaleAttemptLogLimiter } from '../services/stale-attempt-log-limiter.mjs';
import { createSubagentTimelinePublisher } from '../services/subagent-viewer-rooms.mjs';
import { createLocalRequestCheck } from '../services/request-boundary.mjs';
import { buildClaudeCloudDelivery, isClaudeCloudProviderType } from '../services/claude-cloud-session-service.mjs';
import {
  DEEPSEEK_REASONING_EFFORTS,
  DEFAULT_DEEPSEEK_REASONING_EFFORT,
  deepseekModelAcceptsImages,
  deepseekModelLabel,
  deepseekReasoningEffortFor,
} from '../../shared/deepseek-models.mjs';
import { TASK_OUTPUT_NONE_MESSAGES } from '../public/app/task-console-render.mjs';
import { recordClaudeCliStart } from '../services/claude-session-leftovers.mjs';
import { normalizeClaudeBilling } from '../services/claude-billing-switch-service.mjs';
import { createClaudeApiStopNoteLedger } from '../services/plan-usage-claude-api.mjs';
import { normalizeClaudeApiUsageReport } from '../services/claude-api-usage-service.mjs';
import {
  admitRemoteRelayRequest,
  readRemoteRelayRequest,
  findMentionedRemoteRelays,
  findOriginRemoteRelay,
  formatRemoteRelayOriginHint,
  formatRemoteRelayMentionHint,
  recordRemoteRelayUnlocks,
  withRemoteRelayMentionHint,
} from '../services/remote-relay-inbound.mjs';

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
// Preview kinds whose bytes travel in the preview JSON; media and PDF are
// fetched by the browser from the raw URL instead.
const TEXT_PREVIEW_KINDS = new Set(['markdown', 'code', 'text']);
// An upload's URL names its bytes (the sha256), so a kept answer stays right.
const UPLOAD_CONTENT_CACHE_CONTROL = 'private, max-age=31536000, immutable';

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
  // Without these, an explicit request for a bootstrap-only provider read as
  // "no provider stated" and the guards below could never fire.
  if (normalized === 'grok' || normalized === 'xai' || normalized === 'xai-grok') return 'grok';
  if (normalized === 'claude' || normalized === 'anthropic') return 'claude';
  // Its own provider, never read as `claude`.
  if (normalized === 'claude-cloud') return 'claude-cloud';
  if (normalized === 'deepseek') return 'deepseek';
  // Its own provider too (Claude on an API key), never read as `claude`.
  if (normalized === 'claude-api') return 'claude-api';
  return '';
}

const BOOTSTRAP_ONLY_PROVIDER_LABELS = Object.freeze({
  cursor: 'Cursor',
  grok: 'Grok',
  claude: 'Claude',
  'claude-cloud': 'Claude Cloud',
  deepseek: 'DeepSeek',
  'claude-api': 'Claude API',
});

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

const MAX_ACTIVITY_METADATA_BYTES = 2048;

// Structured sidecar for an activity row. Only plain objects with a `kind`
// survive, and only up to a small size cap — the column exists so the
// transcript can promote a row (today: the Claude compaction boundary) to a
// break row, not as a general blob store. Junk degrades to null, which leaves
// the row as ordinary prose activity.
export function sanitizeActivityMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = String(value.kind || '').trim();
  if (!kind) return null;
  const normalized = { ...value, kind };
  let serialized = '';
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    return null;
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_ACTIVITY_METADATA_BYTES) return null;
  return normalized;
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
  // A message the user deliberately sends again (Resend of a steer a Stop
  // cut off) is not a duplicate of its own original, nor of an earlier Resend
  // of it that was cancelled or failed.
  exemptMessageIds = [],
} = {}) {
  const fingerprint = normalizeDuplicateMessageText(text);
  if (!fingerprint) return null;
  const maxAgeMs = Math.max(60_000, Number(windowMs) || DUPLICATE_USER_MESSAGE_WINDOW_MS);
  const exempt = new Set((Array.isArray(exemptMessageIds) ? exemptMessageIds : [])
    .map((id) => String(id || '').trim()).filter(Boolean));
  const isExempt = (row) => exempt.has(String(row?.id || '').trim());
  // A message whose turn failed never ran, so sending it again is a retry,
  // not a double submit. Only failed rows: a cancelled or finished turn stays
  // a duplicate, as before.
  const failedTurnIds = new Set((Array.isArray(recentQueueRows) ? recentQueueRows : [])
    .filter((row) => String(row?.status || '').trim().toLowerCase() === 'failed')
    .map((row) => String(row?.id || '').trim())
    .filter(Boolean));

  for (const row of Array.isArray(recentUserMessages) ? recentUserMessages : []) {
    if (isExempt(row)) continue;
    if (failedTurnIds.has(String(row?.id || '').trim())) continue;
    const rowText = normalizeDuplicateMessageText(row?.text || '');
    if (!rowText || rowText !== fingerprint) continue;
    const rowTime = Date.parse(row?.timestamp || '');
    if (!Number.isFinite(rowTime)) continue;
    if ((now - rowTime) <= maxAgeMs) {
      return { source: 'message', messageId: row?.id || null, timestamp: row?.timestamp || null };
    }
  }

  for (const row of Array.isArray(recentQueueRows) ? recentQueueRows : []) {
    if (isExempt(row)) continue;
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

/**
 * Reads a failure a sender reported as text only, without a `terminalError`
 * record. The text has to BE a failure note, not merely contain one
 * (shared/failure-note-text.mjs): a reply that quoted a note was stored as a
 * failed turn, cut off at the quoted code.
 */
export function parseTerminalFailureText(text) {
  const raw = String(text || '').trim();
  const note = matchFailureNote(raw);
  if (!note) return null;
  const code = normalizeTerminalErrorCode(note.stableCode);
  if (!code) return null;
  const message = normalizeTerminalErrorText(note.lead.trim().replace(/\s+$/, '.'));
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

export function buildTerminalFailureTextForChat(terminalFailure, fallbackMessage = null) {
  const failure = terminalFailure && typeof terminalFailure === 'object' ? terminalFailure : {};
  const code = normalizeTerminalErrorCode(failure.code || failure.stableCode) || 'unknown-terminal';
  const stableCode = `relay.${code}`;
  const message = normalizeTerminalErrorText(failure.message)
    || normalizeTerminalErrorText(fallbackMessage)
    || 'The relay runtime hit a terminal error and could not complete this turn.';
  const guidance = normalizeTerminalErrorText(failure.guidance)
    || 'Send the message again to retry. If this keeps failing, include the error code when you report it.';
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

/**
 * `inferFromText`: whether a text shaped like a failure note counts as one
 * when no record came with it. A session worker always sends the record
 * (`terminalError`), so for its publishes (an `attemptId` names the attempt)
 * the text is a reply whatever it says — a reply that names a code after
 * fixing a failed test is a reply. Senders without an attempt (the Copilot
 * extension, a note read from another relay) still report as text.
 */
export function resolveTerminalFailurePayload(payload = {}, { fallbackText = null, inferFromText = true } = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const parsedTextFailure = inferFromText ? parseTerminalFailureText(body.text) : null;
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
  // Known from the text alone: nothing but the shape of the text says that
  // this is a failure, so the text is kept as it was sent.
  const fromText = !!parsedTextFailure && !direct && !explicitCode
    && body.terminal !== true && body.isTerminal !== true && body.errorKind !== 'terminal';
  return {
    terminal: true,
    ...(fromText ? { fromText: true } : {}),
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

// Which provider actually executed a turn, derived from the authenticated
// responder identity: a session worker names its sdk session via the bridge
// header, and that session's runtime row names the provider. The response
// payload has no say — a misrouted responder must not be able to mask itself.
//
// Identity-less responders are the interesting case. Two of them exist:
//   - server/relay.mjs, launched by hand with plain env (nothing sets
//     COPILOT_PROVIDER_TYPE for it), so it authenticates on the Copilot
//     plan no matter what the conversation is bound to. A turn it answers for
//     a non-github conversation really did run on the wrong plan.
//   - this server finalizing an image operation it executed itself: it calls
//     the provider's own API with the conversation's BYOK key and then
//     self-posts to /api/response with no bridge headers. That one genuinely
//     ran on the bound provider.
// OpenAI BYOK chat turns are not identity-less: they run on a Copilot CLI
// launched with COPILOT_PROVIDER_TYPE=openai whose web-relay extension does
// send X-Relay-Session-Id, so they resolve through the runtime row above.
export function resolveExecutedProviderForResponse({
  stmts,
  responseBridgeIdentity,
  conversationProvider = null,
  serverExecutedOperation = false,
  // The kind the responding worker said it is. A Claude chat moves between
  // the subscription and the API key, and its runtime row names the billing
  // of now, not the one a turn that ends after a switch ran on: the worker's
  // own kind is what ran.
  responderKind = null,
} = {}) {
  const boundProvider = String(conversationProvider || '').trim().toLowerCase() || 'github';
  const responderSessionId = normalizeSessionWorkerId(responseBridgeIdentity?.sessionId);
  const responderBilling = normalizeClaudeBilling(responderKind);
  if (responderSessionId && responderBilling) return responderBilling;
  if (responderSessionId) {
    const runtimeSession = stmts?.getRuntimeSessionBySdkSessionId?.get?.(responderSessionId) || null;
    const providerType = String(runtimeSession?.provider_type || '').trim().toLowerCase();
    // A session id that names no runtime row proves nothing; reporting
    // 'github' here would fabricate a mismatch out of a stale identity.
    return providerType || 'unknown';
  }
  if (serverExecutedOperation) return boundProvider;
  return 'github';
}

// The provider check above cannot see same-provider cross-*conversation*
// execution: worker A answering conversation B's turn resolves to the right
// provider and stays invisible. This companion check compares the responder's
// own conversation binding against the turn's conversation. Absent identity or
// an unmatched runtime row prove nothing and report no mismatch.
export function resolveResponderConversationMismatch({
  stmts,
  responseBridgeIdentity,
  targetConversationId = null,
} = {}) {
  const target = String(targetConversationId || '').trim();
  const responderSessionId = normalizeSessionWorkerId(responseBridgeIdentity?.sessionId);
  if (!target || !responderSessionId) {
    return { crossConversation: false, responderConversationId: null };
  }
  const runtimeSession = stmts?.getRuntimeSessionBySdkSessionId?.get?.(responderSessionId) || null;
  const responderConversationId = String(runtimeSession?.conversation_id || '').trim() || null;
  return {
    crossConversation: Boolean(responderConversationId && responderConversationId !== target),
    responderConversationId,
  };
}

export function dequeuePendingMessage({
  db,
  stmts,
  nowIso,
  routingEnabled = false,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
  affinityOnly = false,
  // The kind the requesting worker says it is ("claude", "claude-api", ...),
  // null when unknown. A Claude chat's row is claimed only by a worker of
  // the row's billing (claudeBillingFence); a refused claim calls
  // `onBillingFence` and claims nothing.
  workerKind = null,
  onBillingFence = null,
  // () → null, or `{ code, error }` when a Claude API row must not run now
  // (the provider off, no key, the monthly cap): such a row is fenced too,
  // whatever the worker, and the caller fails it closed.
  claudeApiClaimCheck = null,
} = {}) {
  const currentIso = String(nowIso || '').trim() || new Date().toISOString();
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  const leaseExpiresAt = requesterSid ? addMsToIso(currentIso, ownerLeaseMs) : null;
  let fenced = null;
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
    if (next && requesterSid) {
      fenced = claudeBillingFence({ stmts, row: next, workerKind, claudeApiClaimCheck });
      if (fenced) return null;
    }
    if (!next && affinityOnly) return null;
    if (!next) {
      // Requesters that reach the global fallback carry no worker identity
      // (the legacy Copilot relay CLI, or a bridge client whose affinity scan
      // came up empty). Conversations bound to a session-worker provider are
      // off limits here: their turns must only ever run on their own worker.
      next = stmts.findPendingForLegacyRelay
        ? stmts.findPendingForLegacyRelay.get(currentIso)
        : stmts.findPending.get(currentIso);
    }
    if (!next) return null;
    // One processing attempt = one attempt_id. Minted here for every claim —
    // even for callers that never echo it back — so finalization, requeue, and
    // question writes can be fenced to the attempt that actually owns the row.
    const attemptId = randomUUID();
    if (routingEnabled && requesterSid && stmts.setProcessingWithWorkerLease) {
      stmts.setProcessingWithWorkerLease.run(currentIso, attemptId, requesterSid, currentIso, leaseExpiresAt, currentIso, next.id);
      return {
        ...next,
        status: 'processing',
        processing_at: currentIso,
        attempt_id: attemptId,
        owner_sdk_session_id: String(next.owner_sdk_session_id || '').trim() || requesterSid,
        owner_assigned_at: String(next.owner_assigned_at || '').trim() || currentIso,
        owner_lease_expires_at: leaseExpiresAt,
        owner_last_claimed_at: currentIso,
      };
    }
    stmts.setProcessing.run(currentIso, attemptId, next.id);
    return {
      ...next,
      status: 'processing',
      processing_at: currentIso,
      attempt_id: attemptId,
    };
  });
  const claimed = dequeue();
  if (fenced && typeof onBillingFence === 'function') {
    try { onBillingFence({ ...fenced, requesterSessionId: requesterSid }); } catch {}
  }
  return claimed;
}

// The `source` of an abort_turn control queued for a continuation on the
// key that the Claude API claim check refuses (POST /api/continuation-turn):
// the cap, no key, or the provider switched off.
const CLAUDE_API_CAP_STOP_SOURCE = 'claude-api-cap';

/**
 * What a note on a Claude API turn that did not run tells the user to do,
 * without the full stop: the cap is raised, a switched-off Claude API is
 * switched on, a missing key is set up; or the chat moves to the
 * subscription.
 */
export function claudeApiRemedyText({ code = '', switchedOff = false } = {}) {
  const place = 'Settings → Providers → Claude API';
  if (String(code) === 'CLAUDE_API_CAP_REACHED') return `Switch this chat to the subscription, or raise the monthly cap in ${place}`;
  if (switchedOff) return `Switch this chat to the subscription, or switch Claude API on in ${place}`;
  return `Switch this chat to the subscription, or set Claude API up in ${place}`;
}

const CLAUDE_API_STOP_NOTE_LABELS = 2;
const CLAUDE_API_STOP_NOTE_LABEL_CHARS = 40;

/**
 * The note for a self-started turn on the key the Claude API claim check
 * refused (`refusal`: `{ code, error, switchedOff? }`), with the background tasks the
 * relay stopped and those no stop reaches (`tasks`: `{ stopped, unreached }`
 * of `{ label }`). One paragraph whose lead stays within
 * FAILURE_NOTE_LEAD_MAX, so it still reads as a failure note and the
 * transcript's buttons find its code: at most two labels per list, cut to
 * 40 characters, then only the counts if the lead is still too long. The
 * fixed sentences and the code are never cut.
 */
export function buildClaudeApiStopNoteText({ refusal = {}, tasks = {} } = {}) {
  const code = String(refusal.code || 'CLAUDE_API_NOT_CONFIGURED');
  const stableCode = `relay.${code.toLowerCase().replace(/_/g, '-')}`;
  const reason = String(refusal.error || '').trim()
    .replace(/,? so this turn did not run\.$/, '.')
    .replace(/\s*This turn did not run\.$/, '');
  const stopped = Array.isArray(tasks.stopped) ? tasks.stopped : [];
  const unreached = Array.isArray(tasks.unreached) ? tasks.unreached : [];
  const cut = (label) => {
    const text = String(label || '').trim().replace(/\s+/g, ' ') || 'a task';
    return text.length > CLAUDE_API_STOP_NOTE_LABEL_CHARS ? `${text.slice(0, CLAUDE_API_STOP_NOTE_LABEL_CHARS - 1).trimEnd()}…` : text;
  };
  const named = (list, shown) => {
    const labels = list.slice(0, shown).map((task) => cut(task.label));
    const more = list.length - labels.length;
    return `${labels.join(', ')}${more ? ` and ${more} more` : ''}`;
  };
  const tasksText = (shown) => [
    stopped.length
      ? (shown ? `Background tasks stopped: ${named(stopped, shown)}. ` : `${stopped.length} background task${stopped.length === 1 ? '' : 's'} stopped. `)
      : '',
    unreached.length
      ? (shown
        ? `Still running (stop them in the task panel): ${named(unreached, shown)}. `
        : `${unreached.length}${stopped.length ? ' more' : ` background task${unreached.length === 1 ? '' : 's'}`} still running (stop them in the task panel). `)
      : '',
  ].join('');
  const lead = (shown) => `${reason} Claude Code started this turn by itself when a background task reported back. `
    + 'It is being stopped, but its first request may already be billed, and a short turn can end first. '
    + tasksText(shown)
    + `${claudeApiRemedyText({ code, switchedOff: refusal.switchedOff === true })}. `;
  let shown = CLAUDE_API_STOP_NOTE_LABELS;
  while (shown > 0 && lead(shown).length > FAILURE_NOTE_LEAD_MAX) shown -= 1;
  return `${lead(shown)}Error code: ${stableCode}.`;
}

/**
 * Whether a worker of `workerKind` must not claim `row`, a Claude chat's
 * turn: null when it may, else `{ conversationId, messageId, rowBilling,
 * workerKind, reason }`. The row's billing is its stamp (queue.provider),
 * else its chat's. A worker that states no kind is taken at its chat's
 * word, except on a chat that has switched since (a worker from before the
 * switch existed: it is replaced once, when idle).
 */
export function claudeBillingFence({ stmts, row, workerKind = null, claudeApiClaimCheck = null } = {}) {
  if (!row) return null;
  const runtime = stmts?.getRuntimeSessionByConversation?.get?.(row.conversation_id) || null;
  const chatBilling = normalizeClaudeBilling(runtime?.provider_type);
  const rowBilling = normalizeClaudeBilling(row.provider) || chatBilling;
  if (!rowBilling) return null;
  const kind = normalizeWorkerKind(workerKind);
  const base = {
    conversationId: String(row.conversation_id || ''),
    messageId: String(row.id || ''),
    rowBilling,
    workerKind: kind,
  };
  if (rowBilling === 'claude-api' && typeof claudeApiClaimCheck === 'function') {
    let refusal = null;
    try {
      refusal = claudeApiClaimCheck() || null;
    } catch (error) {
      // A check that cannot answer does not let a turn run on the key: the
      // row fails closed as unconfigured. Subscription rows never get here.
      console.warn(`[claude-billing] Claude API claim check failed for ${String(row.id || '').slice(0, 8)}: ${error?.message || error} — the row fails closed`);
      refusal = {
        code: 'CLAUDE_API_NOT_CONFIGURED',
        error: 'The relay could not check Claude API (key, switch, cap), so this turn did not run.',
      };
    }
    if (refusal) return { ...base, reason: 'claude-api-unavailable', refusal };
  }
  if (kind) return kind === rowBilling ? null : { ...base, reason: 'kind-mismatch' };
  if (String(runtime?.billing_switched_at || '').trim()) return { ...base, reason: 'kind-unknown' };
  return null;
}

// A requeue for a turn that produced nothing and was only briefly in flight is
// a startup/routing hiccup, not a provider failure: the worker was still
// booting, or the bound session was not available yet. Those deserve a short
// retry. Anything that streamed text, logged activity, or ran for a while is
// treated as a real failure and keeps the long backoff ladder.
export const TRANSIENT_REQUEUE_MAX_PROCESSING_MS = 15_000;

export function isTransientRequeue({
  queueRow = null,
  relayActivityCount = 0,
  relayStreamCount = 0,
  nowMs = Date.now(),
  maxProcessingMs = TRANSIENT_REQUEUE_MAX_PROCESSING_MS,
} = {}) {
  if (Math.max(0, Number(relayActivityCount || 0)) > 0) return false;
  if (Math.max(0, Number(relayStreamCount || 0)) > 0) return false;
  const startedAtMs = Date.parse(String(queueRow?.processing_at || '').trim());
  // No processing_at means the row never even began; treat that as transient.
  if (!Number.isFinite(startedAtMs)) return true;
  return (nowMs - startedAtMs) < Math.max(0, Number(maxProcessingMs) || 0);
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
  workerKind = null,
  onBillingFence = null,
  claudeApiClaimCheck = null,
} = {}) {
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  const routingWithWorker = routingEnabled && requesterSid;
  let billingFenced = null;
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
        workerKind,
        claudeApiClaimCheck,
        onBillingFence: (fence) => {
          billingFenced = fence;
          if (typeof onBillingFence === 'function') onBillingFence(fence);
        },
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
        // The next row is of another billing than this worker: it waits for
        // the swap (claude-billing-swap-service.mjs).
        blockedReason: !message && billingFenced ? 'billing-swap' : null,
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
  getCursorProviderSettings = () => null,
  getClaudeCloudProviderSettings = () => null,
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
  const providerType = String(runtimeSession?.provider_type || '').trim().toLowerCase() || null;
  // A Claude chat's billing for this row: its stamp, else the chat's. The
  // worker runs it only when that is its own kind.
  const billing = normalizeClaudeBilling(msg.provider) || normalizeClaudeBilling(providerType) || null;
  // The Cursor worker declares one subagent per enabled model, because the
  // SDK's built-in subagent model menu is stuck at `inherit` +
  // `composer-2.5-fast` (see cursor-subagent-roster.mjs). Delivered per turn
  // rather than baked into the worker's launch env so toggling models in the
  // Select Models modal takes effect on the next turn, with no respawn.
  let cursorSubagentModels = [];
  if (providerType === 'cursor') {
    const cursorSettings = getCursorProviderSettings();
    cursorSubagentModels = (Array.isArray(cursorSettings?.enabledModels) ? cursorSettings.enabledModels : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean);
  }
  // A Claude Cloud worker creates its session from the first delivered
  // message and sends into it afterwards: the repository, the branch and the
  // binding it reported ride on every message, so a restarted worker needs
  // nothing but the delivery. Other providers never get the field.
  const claudeCloud = isClaudeCloudProviderType(providerType)
    ? buildClaudeCloudDelivery({
        conversation: stmts.getConvAnyStatus?.get?.(msg.conversation_id) || null,
        runtimeSession,
        fallbackEnvironmentId: getClaudeCloudProviderSettings()?.environmentId || '',
      })
    : null;
  // A message the relay wrote itself (a relay event, a scheduled prompt): the
  // workers deliver it without the steer note, which speaks as the user.
  let messageKind = '';
  try {
    messageKind = String(stmts.getMessageByConversation?.get?.(msg.id, msg.conversation_id)?.kind || '').trim();
  } catch {}
  return {
    id: msg.id,
    conversationId: msg.conversation_id,
    runtimeSessionId: runtimeSession?.id || null,
    isNewConversation: msg.is_new_conversation === 1,
    model: String(msg.model || '').trim() || defaultModel,
    modelVariantId: String(msg.model_variant_id || '').trim() || String(msg.model || '').trim() || null,
    providerType,
    ...(billing ? { billing } : {}),
    providerModel: String(runtimeSession?.provider_model || '').trim() || null,
    claudeNativeSessionId: String(runtimeSession?.claude_native_session_id || '').trim() || null,
    cursorAgentId: String(runtimeSession?.cursor_agent_id || '').trim() || null,
    cursorSubagentModels,
    grokNativeSessionId: String(runtimeSession?.grok_native_session_id || '').trim() || null,
    ...(isClaudeCloudProviderType(providerType) ? { claudeCloud } : {}),
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
    attemptId: String(msg.attempt_id || '').trim() || null,
    ownerSessionId: String(msg.owner_sdk_session_id || '').trim() || null,
    ownerAssignedAt: msg.owner_assigned_at || null,
    ownerLeaseExpiresAt: msg.owner_lease_expires_at || null,
    imageOperationId: String(msg.image_operation_id || '').trim() || null,
    ...(isRelayAutomatedMessageKind(messageKind) ? { messageKind } : {}),
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
  // Folders of earlier versions that uploads are still read from: only a
  // sha256-named blob directly inside one counts.
  allowedBlobRootPaths = [],
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
    const blobRoots = (Array.isArray(allowedBlobRootPaths) ? allowedBlobRootPaths : [])
      .map((root) => String(root || '').trim())
      .filter(Boolean);
    const generatedImagesRoot = String(allowedGeneratedImagesRootPath || '').trim();
    if (allowedRoot || blobRoots.length || generatedImagesRoot) {
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
      const isOldUploadBlob = blobRoots.some((root) => (
        path.dirname(resolvedPath) === path.resolve(root)
        && /^[a-f0-9]{64}$/.test(path.basename(resolvedPath))
      ));
      if (!isWithinRoot(allowedRoot) && !isOldUploadBlob && !isGeneratedImagePath) {
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

// Structural sanitizer for the workflow-progress digest a Claude session
// worker attaches to its background-task rows (docs/plans/workflow-progress-tree.md,
// Phase 2). The relay never trusts worker JSON: strings are trimmed and
// length-clamped, arrays hard-capped, numbers accepted only when finite, and
// unknown fields dropped at every level. A wrong-typed field degrades to
// null; a wrong-typed digest (or one with no phases and no agents) returns
// null so the row simply carries no workflowProgress — the ingest never 400s
// because of this field.
export function sanitizeWorkflowProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cleanString = (raw, maxLength) => {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const text = String(raw).trim().slice(0, maxLength);
    return text || null;
  };
  const cleanNumber = (raw) => {
    if (raw === null || raw === undefined || typeof raw === 'object' || typeof raw === 'boolean') return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  };
  const cleanCount = (raw) => {
    const num = cleanNumber(raw);
    return num === null ? null : Math.max(0, Math.floor(num));
  };
  const isEntryObject = (entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry);
  const phases = (Array.isArray(value.phases) ? value.phases : [])
    .filter(isEntryObject)
    .slice(0, 50)
    .map((phase) => ({
      index: cleanNumber(phase.index),
      title: cleanString(phase.title, 120),
    }));
  const agentEntries = (Array.isArray(value.agents) ? value.agents : []).filter(isEntryObject);
  const agents = agentEntries
    .slice(0, 100)
    .map((agent) => ({
      index: cleanNumber(agent.index),
      label: cleanString(agent.label, 160),
      phaseIndex: cleanNumber(agent.phaseIndex),
      phaseTitle: cleanString(agent.phaseTitle, 120),
      model: cleanString(agent.model, 80),
      state: cleanString(agent.state, 32),
      attempt: cleanNumber(agent.attempt),
      lastToolName: cleanString(agent.lastToolName, 160),
      tokens: cleanNumber(agent.tokens),
      toolCalls: cleanNumber(agent.toolCalls),
      durationMs: cleanNumber(agent.durationMs),
      startedAt: cleanNumber(agent.startedAt),
    }));
  if (!phases.length && !agents.length) return null;
  // Agents dropped by the relay's own cap are added to the worker-reported
  // omission count so the client's "N more" stays truthful.
  const truncatedAgents = agentEntries.length - agents.length;
  const reportedOmitted = cleanCount(value.agentsOmitted);
  const agentsOmitted = (reportedOmitted === null && truncatedAgents === 0)
    ? null
    : (reportedOmitted ?? 0) + truncatedAgents;
  const logs = (Array.isArray(value.logs) ? value.logs : [])
    .map((line) => cleanString(line, 300))
    .filter(Boolean)
    .slice(0, 5);
  return {
    runId: cleanString(value.runId, 64),
    workflowName: cleanString(value.workflowName, 120),
    status: cleanString(value.status, 32),
    agentCount: cleanCount(value.agentCount),
    totalTokens: cleanCount(value.totalTokens),
    durationMs: cleanCount(value.durationMs),
    phases,
    logs,
    agents,
    agentsOmitted,
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
    config,
    uuidv4,
    ts,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_ATTACHMENTS,
    uploadsDir,
    uploadReadDirs = [uploadsDir],
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
    getGrokProviderSettings = () => ({ enabled: false, model: '', models: [] }),
    getClaudeCloudProviderSettings = () => ({ enabled: false, defaultModel: '', environmentId: '', models: [] }),
    getDeepSeekProviderSettings = () => ({ enabled: false, model: '', models: [] }),
    getClaudeApiProviderSettings = () => ({ enabled: false, model: '', models: [], availableModels: [], effortsByModel: {} }),
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
    // Resolves the live turn among a conversation's processing rows (mid-turn
    // steering can leave more than one). Falls back to the newest-processing
    // query for older wiring/tests that do not supply it.
    resolveLiveTurnQueueRow = (conversationId) => stmts.getLatestProcessingQueueByConversation.get(conversationId) || null,
    emitToClientsExceptSessionId,
    relayBridgeOwnerService,
    relayRestartOrchestrator,
    requestRelayShutdown,
    cancelRelayShutdown = null,
    // Truly local = loopback peer, no tunnel marker, no forwarding header
    // (services/request-boundary.mjs). The runtime passes the check built
    // with the configured marker headers.
    isTrulyLocalRequest = createLocalRequestCheck().isTrulyLocal,
    featureFlags,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
    sessionWorkerProcessInspector,
    // Seams for stopSessionWorkerProcesses (platform, killImpl, isPidAliveImpl,
    // killTmuxSessionImpl). Tests must inject these instead of relying on the
    // host OS, so the suite behaves identically on Windows and POSIX.
    sessionWorkerStopOverrides = null,
    resolveSessionStateRoot,
    fetchUsageSummary = null,
    planUsageService = null,
    usageLimitPauseService = null,
    // The Claude billing switch (claude-billing-switch-service.mjs): the
    // billing route, and the send-path guards that refuse a switch by send.
    claudeBillingSwitchService = null,
    // The Claude API booking (claude-api-usage-service.mjs).
    claudeApiUsageService = null,
    // The delivery fence's runtime half for GET /api/pending, as on the
    // socket: the Claude API claim check (null: no refusal) and what a fenced
    // row does (the swap, or fail closed).
    claudeApiClaimCheck = null,
    onClaudeBillingFence = null,
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

  const ttyConsoleActive = runtimeState?.ttyConsoleActive === true;

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

  // A conversation's sub-agent run by its task id. A Claude agent resumed by
  // a new message keeps its task id, and the CLI names the call that resumed
  // it (SendMessage) as the task's tool use, an id no run row carries: its
  // run is the one the task id leads to.
  function subagentRunOfTask(conversationId, taskId) {
    const conversation = String(conversationId || '').trim();
    const task = String(taskId || '').trim().slice(0, 200);
    if (!conversation || !task) return null;
    try {
      return stmts.getSubagentRunByTaskId?.get?.(conversation, task) || null;
    } catch {
      return null;
    }
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

  // Only to the pages whose viewer shows this run, and volatile: a batch a
  // connection cannot take is dropped (never kept for a reconnect replay);
  // the viewer sees the hole in `seq` and fetches it.
  const publishSubagentTimeline = createSubagentTimelinePublisher(io, deps.subagentTimelineDefer ? { defer: deps.subagentTimelineDefer } : {});
  function emitSubagentTimeline(run, entries) {
    if (!run || !entries?.length) return;
    publishSubagentTimeline({
      conversationId: String(run.conversation_id || ''),
      messageId: run.queue_message_id ? String(run.queue_message_id) : null,
      subagentRunId: String(run.id),
      entries,
      truncated: Number(run.truncated || 0) === 1,
    });
  }

  // Copilot and Cursor publish their sub-agents on the live lanes only; the
  // relay copies each frame into the run's timeline (the Claude worker writes
  // its own and owns its runs' timelines).
  function mirrorSubagentFrame(frame) {
    if (!frame?.runId) return;
    try {
      const mirrored = subagentTimeline.mirrorFrame(frame);
      if (!mirrored) return;
      const run = mirrored.truncated ? (stmts.getSubagentRun?.get?.(frame.runId) || mirrored.run) : mirrored.run;
      if (mirrored.truncated) emitSubagentStatus(run);
      emitSubagentTimeline(run, mirrored.entries);
    } catch (error) {
      console.warn(`[${ts()}] SUBAGENT MIRROR failed run=${String(frame.runId).slice(0, 12)}: ${error?.message || error}`);
    }
  }

  function activityTimelineFrame(text) {
    const value = String(text || '');
    const toolMatch = /^Tool \(([^)]+)\)/.exec(value);
    if (toolMatch) return { kind: 'tool_call', toolName: toolMatch[1], text: value };
    if (/^Tool failed:/i.test(value)) return { kind: 'tool_result', text: value, metadata: { isError: true } };
    return { kind: 'note', text: value };
  }
  // Whether a conversation's history holds an image the user attached. Read
  // only for a DeepSeek model switch; prepared on first use, so a database
  // without the messages table (tests) is answered with "no".
  let conversationHasImageStatement = null;
  function conversationHasImageAttachment(conversationId) {
    try {
      conversationHasImageStatement ||= db.prepare(`
        SELECT 1 FROM messages
        WHERE conversation_id = ? AND role = 'user' AND attachments LIKE '%"image/%'
        LIMIT 1
      `);
      return !!conversationHasImageStatement.get(conversationId);
    } catch {
      return false;
    }
  }
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

  // The stored preferences, for a send that must leave them alone.
  function readConversationModelPreference(conversationId, fallbackRelayMode = DEFAULT_RELAY_MODE) {
    const row = stmts.getConvAnyStatus?.get?.(String(conversationId || '').trim()) || null;
    return {
      preferredRelayMode: normalizeRelayMode(row?.preferred_relay_mode) || fallbackRelayMode || DEFAULT_RELAY_MODE,
      preferredModel: String(row?.preferred_model || '').trim(),
      preferredReasoningEffort: String(row?.preferred_reasoning_effort || '').trim(),
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

  function failQueueMessage({
    queueRow,
    messageId,
    conversationId,
    relayMode,
    model,
    responseText,
    failureRecord,
    markWorkerError = true,
    executedProvider = null,
    attemptId = null,
    // Extra writes that must commit only with the (fenced) failure itself.
    withinTransaction = null,
  }) {
    const now = new Date().toISOString();
    const responseId = uuidv4();
    const requestedModel = String(queueRow?.model || '').trim() || null;
    const modelOrigin = deriveModelOrigin(requestedModel);
    const resolvedModel = String(model || '').trim()
      || (modelOrigin === 'auto' ? 'unknown' : requestedModel)
      || null;
    const modelActual = String(model || '').trim() || null;
    const fencedAttemptId = String(attemptId || '').trim() || null;
    const tx = db.transaction(() => {
      const result = fencedAttemptId
        ? stmts.setFailedFenced.run(JSON.stringify(failureRecord), messageId, fencedAttemptId)
        : stmts.setFailed.run(JSON.stringify(failureRecord), messageId);
      if (result.changes === 0) return false;
      if (typeof withinTransaction === 'function') withinTransaction(now);
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
      stmts.setMessageSourceId?.run(messageId, responseId);
      // Provenance travels with terminal failures too — the original hijack
      // incident's signature was stolen turns dying on 402, which exited
      // exactly here with no executed_provider recorded.
      if (executedProvider) stmts.setMessageExecutedProvider?.run(executedProvider, responseId);
      stmts.linkActivityToResponse?.run(responseId, messageId);
      stmts.linkStreamEventsToResponse?.run(responseId, messageId);
      // A failed turn keeps its reasoning: without this link the thoughts
      // stayed response_message_id NULL and vanished from the transcript.
      stmts.linkThoughtsToResponse?.run(responseId, messageId);
      // A preview published before the turn failed is still live and public;
      // its card must not vanish with the error.
      stmts.linkPreviewCardsToResponse?.run(responseId, messageId);
      stmts.updateConvTime.run(now, conversationId);
      stmts.pruneQueue?.run();
      return true;
    });
    const failed = tx();
    if (!failed) return null;
    // A failed turn ends its subagents: whatever was still 'running' can
    // never receive a terminal transition from a worker that just gave up,
    // and an un-reconciled row renders as a bubble stuck running forever.
    reconcileSubagentRunsForTerminalTurn(messageId, { status: 'failed' });
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
    void pushDispatchService?.notifyTurnFailed?.({ conversationId, messageId: responseId, sourceMessageId: messageId, text: responseText });
    // A Stop from the relay ends the turn; anything else failed it.
    try {
      if (String(failureRecord?.code || '') === 'turn-aborted') {
        relayEventService?.noteTurnEnd?.({ conversationId, queueMessageId: messageId, status: 'stopped' });
      } else {
        relayEventService?.noteError?.({
          conversationId,
          kind: 'turn_failed',
          message: failureRecord?.message || failureRecord?.error || responseText,
          queueMessageId: messageId,
        });
      }
    } catch {}
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
    ORDER BY q.timestamp ASC, q.rowid ASC
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
        attempt_id = NULL,
        next_attempt_at = ?,
        owner_lease_expires_at = NULL
    WHERE id = ?
      AND owner_sdk_session_id = ?
      AND status = 'processing'
      AND consumed_at IS NULL
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

  // The Claude API claim check for a continuation on the key, failing closed
  // as the delivery fence does: `{ code, error }` or null. Without the
  // runtime's check (older wiring, tests) the cap seam alone is asked.
  function claudeApiContinuationRefusal() {
    try {
      if (typeof claudeApiClaimCheck === 'function') return claudeApiClaimCheck() || null;
      let cap = null;
      try { cap = getClaudeApiCapState() || null; } catch { cap = { reached: true }; }
      return cap?.reached === true
        ? { code: 'CLAUDE_API_CAP_REACHED', error: `${String(cap.error || '').trim() || 'This month\'s Claude API spend has reached its cap.'} This turn did not run.` }
        : null;
    } catch (error) {
      console.warn(`[claude-billing] Claude API claim check failed for a continuation: ${error?.message || error} — it is stopped`);
      return { code: 'CLAUDE_API_NOT_CONFIGURED', error: 'The relay could not check Claude API (key, switch, cap), so this turn did not run.' };
    }
  }

  // The episode of a refusal, for its note (claudeApiStopLedger): the cap's
  // month and value, or the refusal's code.
  function claudeApiStopEpisode(code) {
    if (code !== 'CLAUDE_API_CAP_REACHED') return String(code || 'refused');
    try {
      return `cap:${String(getClaudeApiCapState()?.episode || '')}`;
    } catch {
      return 'cap:unreadable';
    }
  }

  // Stops the live background tasks of a key worker whose self-started turn
  // is refused: each report would start another such turn, and a billing
  // switch waits for them. `{ stopped, unreached }`, each `[{ taskId,
  // label, reason? }]`: the stops sent, and the tasks no stop reaches (not
  // stoppable, or the worker has no socket to take it).
  function stopClaudeApiBackgroundTasks(conversationId, sessionId) {
    const conversation = stmts.getConvAnyStatus?.get?.(conversationId) || null;
    const workerSessionId = String(sessionId || conversation?.sdk_session_id || conversationId);
    const keys = [...new Set([conversationId, workerSessionId, String(conversation?.sdk_session_id || '')].filter(Boolean))];
    const stopped = [];
    const unreached = [];
    const seen = new Set();
    for (const task of keys.flatMap((key) => backgroundTaskStore?.get?.(key) || [])) {
      const taskId = String(task?.taskId || '').trim();
      if (!taskId || seen.has(taskId)) continue;
      seen.add(taskId);
      const label = String(task?.description || task?.command || task?.taskType || '').trim().replace(/\s+/g, ' ').slice(0, 80) || taskId;
      if (task?.stoppable === false) {
        unreached.push({ taskId, label, reason: 'no-stop' });
      } else if (sendWorkerControl?.(workerSessionId, { type: 'stop_background_task', taskId })) {
        stopped.push({ taskId, label });
      } else {
        unreached.push({ taskId, label, reason: 'worker-not-connected' });
      }
    }
    if (stopped.length || unreached.length) {
      console.log(`[${ts()}] CLAUDE API STOP conv=${conversationId.slice(0, 8)} background tasks stopped=${stopped.length} unreached=${unreached.length}`);
    }
    return { stopped, unreached };
  }

  /**
   * The note for a self-started turn on the key the claim check refused,
   * written when the turn is registered (a short turn can end before the
   * worker's control poller takes the stop): the refusal, what the stop can
   * and can't do, the background tasks stopped and those no stop reached,
   * and the way out, its code last where the transcript's buttons look.
   */
  function writeClaudeApiStopNote({ conversationId, relayMode, refusal, tasks, now }) {
    const text = buildClaudeApiStopNoteText({ refusal, tasks });
    const noteId = uuidv4();
    stmts.insertMsg.run(noteId, conversationId, 'assistant', text, null, relayMode, null, now, null, null, null);
    stmts.updateConvTime?.run?.(now, conversationId);
    io.emit('assistant_message', {
      conversationId,
      messageId: noteId,
      message: { id: noteId, role: 'assistant', text, model: null, mode: relayMode, attachments: [], timestamp: now },
    });
    return noteId;
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
      excludeMessageIds = null,
      reason = 'owner-heartbeat-idle',
      graceMs = SESSION_WORKER_IDLE_RECOVERY_GRACE_MS,
    } = {},
  ) {
    const normalizedSessionId = normalizeSessionWorkerId(sdkSessionId);
    if (!normalizedSessionId) return [];
    const excludedIds = new Set(
      [excludeMessageId, ...(Array.isArray(excludeMessageIds) ? excludeMessageIds : [])]
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    );
    const cutoffIso = new Date(Date.now() - Math.max(1_000, Number(graceMs) || SESSION_WORKER_IDLE_RECOVERY_GRACE_MS)).toISOString();
    const rows = (listRecoverableProcessingOwnedBySession.all(
      normalizedSessionId,
      '',
      '',
      cutoffIso,
    ) || []).filter((row) => !excludedIds.has(String(row.id)));
    if (!rows.length) return [];
    const rowsToFail = [];
    const rowsToRecover = [];
    for (const row of rows) {
      if (String(row.kind || '') === 'continuation') {
        // A background continuation whose worker stopped claiming it has no
        // user to answer and must never be replayed as a prompt: tear it down
        // quietly.
        stmts.dropStaleContinuation?.run?.(row.id);
        io.emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'failed' });
        noteRestartTurnOutcome(row, 'cut');
        continue;
      }
      if (row.consumed_at) {
        failConsumedQueueRow(row, { reason });
        noteRestartTurnOutcome(row, 'cut');
        continue;
      }
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
      noteRestartTurnOutcome(row, 'requeued');
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
        // Started, so not replayed: a turn the agent never heard the end of.
        noteRestartTurnOutcome(row, 'cut');
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
    if (readRemoteRelayRequest(req, remoteRelayInbound).remote) {
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
    if (process.platform !== 'win32') {
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

  function sendMutationResult(res, result, extra = {}) {
    if (!result?.ok) return res.status(Number(result?.statusCode) || 500).json({ error: result?.error || 'Request failed' });
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
    return sendMutationResult(res, renameEntry(source.absolutePath, newName), { path: workspaceWebPath(destination.relative) });
  });

  app.post('/api/repo/delete', auth, (req, res) => {
    const target = resolveWorkspaceMutationTarget(req, res, req.body?.path);
    if (!target) return;
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
      return sendMutationResult(res, createDirectory(targetAbsolute), { path: webPathOf(targetAbsolute) });
    });
  });

  app.post('/api/drives/rename', auth, (req, res) => {
    const newName = validatedName(res, req.body?.newName);
    if (!newName) return;
    withDriveMutationTarget(req, res, req.body?.path, {}, (sourceAbsolute, webPathOf) => {
      const result = renameEntry(sourceAbsolute, newName);
      return sendMutationResult(res, result, result.ok ? { path: webPathOf(result.path) } : {});
    });
  });

  app.post('/api/drives/delete', auth, (req, res) => {
    withDriveMutationTarget(req, res, req.body?.path, {}, (targetAbsolute) => {
      if (req.body?.dryRun === true) {
        const counted = countEntries(targetAbsolute);
        return sendMutationResult(res, counted, counted.ok ? { kind: counted.kind, files: counted.files, dirs: counted.dirs, capped: counted.capped } : {});
      }
      return sendMutationResult(res, removeEntry(targetAbsolute));
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

  // A Resend of a steer a Stop cut off unanswered. Honored only for a user
  // message of this conversation whose own settle marker is kind='stopped' and
  // whose text is what is being sent; anything else is an ordinary send (and
  // gets the ordinary duplicate guard). Returns { originId } to honor it,
  // { alreadyResentAs } when an earlier Resend of it still stands (from any
  // device, at any time), or null.
  function resolveStoppedSteerResend(conversationId, rawMessageId, text) {
    const messageId = String(rawMessageId || '').trim();
    if (!messageId || !conversationId) return null;
    try {
      const original = db.prepare(`
        SELECT id, text, mode FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'
      `).get(messageId, conversationId);
      if (!original) return null;
      // Stored user text may carry the relay's prompt context; the incoming
      // text is already stripped, so compare like with like.
      const originalText = stripRelayPromptContext(original.text, original.mode);
      if (normalizeDuplicateMessageText(originalText) !== normalizeDuplicateMessageText(text)) return null;
      const stopped = db.prepare(`
        SELECT 1 FROM messages
        WHERE conversation_id = ? AND role = 'assistant' AND kind = 'stopped'
          AND (source_message_id = ? OR id IN (SELECT response_message_id FROM queue WHERE id = ?))
        LIMIT 1
      `).get(conversationId, messageId, messageId);
      if (!stopped) return null;
      const earlier = db.prepare(`
        SELECT m.id,
          q.id AS queue_id,
          q.status AS queue_status,
          EXISTS (SELECT 1 FROM messages a WHERE a.role = 'assistant' AND a.source_message_id = m.id) AS answered
        FROM messages m
        LEFT JOIN queue q ON q.id = m.id
        WHERE m.conversation_id = ? AND m.role = 'user' AND m.resend_of_message_id = ?
      `).all(conversationId, messageId);
      const standing = earlier.find((row) => isLiveResend({
        hasQueueRow: !!row.queue_id,
        queueStatus: row.queue_status,
        answered: !!row.answered,
      }));
      if (standing) return { alreadyResentAs: standing.id };
      return { originId: messageId, exemptIds: [messageId, ...earlier.map((row) => row.id)] };
    } catch {
      return null;
    }
  }

  // POST /api/message — browser sends a message
  // The send route's handler. The billing route runs it too, for an agent's
  // send that switches the chat's billing with its message: that request
  // carries `oarBillingSwitch` (set by the route, never read from a body),
  // and the switch happens in the same transaction as the enqueue.
  const handleSendMessage = async (req, res) => {
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
    // A prompt from another relay's agent (body `origin` or the
    // X-OAR-Remote-Origin header) is refused while the inbound switch is off.
    // Otherwise its provenance is stored with the message, and it never
    // unlocks relays or touches the composer draft and preferences.
    const remoteRequest = admitRemoteRelayRequest(req, res, remoteRelayInbound);
    if (!remoteRequest) return;
    const sessionId = clientId || ensureSessionId(req, res);
    const requesterIdentity = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requesterIdentity?.sessionId);
    const sessionWorkerRoutingEnabled = isSessionWorkerRoutingEnabled(featureFlags);
    let conversationSdkSessionId = null;
    // The conversation's saved choices, for a send that leaves one out: a
    // send to an existing conversation that names no mode runs in the mode
    // the conversation is in, not the relay default.
    const existingConversation = (!newConversation && conversationId)
      ? (stmts.getConvAnyStatus?.get?.(conversationId) || null)
      : null;
    const explicitRelayModeGiven = !!String(relayMode || mode || '').trim();
    const savedRelayMode = !explicitRelayModeGiven && existingConversation?.preferred_relay_mode
      ? normalizeRelayMode(existingConversation.preferred_relay_mode)
      : null;
    const requestedRelayMode = savedRelayMode || normalizeRelayMode(relayMode || mode);
    const trimmedText = stripRelayPromptContext(text, requestedRelayMode || relayMode || mode);
    const normalizedAttachments = normalizeAttachments(rawAttachments);
    const requestedAttachmentCount = Math.min(
      MAX_UPLOAD_ATTACHMENTS,
      Array.isArray(rawAttachments) ? rawAttachments.filter((item) => item && typeof item === 'object').length : (rawAttachments ? 1 : 0),
    );
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
    const boundProviderType = String(existingRuntimeSession?.provider_type || '').trim().toLowerCase();
    // A Claude chat runs on the subscription (`claude`) or the saved API key
    // (`claude-api`). A send never moves it: the billing route does
    // (claude-billing-switch-service.mjs). A send that names the other
    // billing is refused, and so is one from a page that still showed the
    // other one (`billing`), so nobody's turn runs on a bill they did not
    // see. A send without `billing` (an older page, an agent) is not checked.
    const boundClaudeBilling = shouldCreateConversation ? '' : normalizeClaudeBilling(boundProviderType);
    const billingSwitch = boundClaudeBilling && req.oarBillingSwitch
      ? { to: normalizeClaudeBilling(req.oarBillingSwitch.to), by: String(req.oarBillingSwitch.by || 'agent') }
      : null;
    if (boundClaudeBilling && !billingSwitch) {
      const namedBilling = normalizeClaudeBilling(requestedProviderType);
      if (namedBilling && namedBilling !== boundClaudeBilling) {
        return res.status(409).json({
          error: `This chat runs on the ${boundClaudeBilling === 'claude-api' ? 'Claude API key' : 'Claude subscription'}. Switch its billing first; a send does not.`,
          code: 'CLAUDE_BILLING_SWITCH_REQUIRED',
          conversationId,
          billing: boundClaudeBilling,
        });
      }
      const shownBilling = normalizeClaudeBilling(req.body?.billing);
      if (shownBilling && shownBilling !== boundClaudeBilling) {
        // The text is not lost: it goes into the chat's draft (after what is
        // there), where every page shows it, so a page's own retry and a
        // replay from the outbox both leave it for the user to send again.
        const keptText = String(trimmedText || '').trim();
        const conversationRow = keptText ? (stmts.getConvAnyStatus?.get?.(conversationId) || null) : null;
        if (conversationRow) {
          const draft = String(conversationRow.draft_text || '');
          if (!draft.includes(keptText)) {
            const keptDraft = draft.trim() ? `${draft.replace(/\s+$/, '')}\n\n${keptText}` : keptText;
            const keptAt = new Date().toISOString();
            db.prepare(`UPDATE conversations SET draft_text = ?, draft_updated_at = ?, draft_updated_by_client_id = NULL WHERE id = ?`)
              .run(keptDraft, keptAt, conversationId);
            // The draft's attachments stay what they are: the update must not
            // clear them on the other pages.
            let keptAttachments = [];
            try {
              const parsed = JSON.parse(String(conversationRow.draft_attachments || '[]'));
              keptAttachments = Array.isArray(parsed) ? parsed : [];
            } catch {
              keptAttachments = [];
            }
            io.emit('conversation_draft_updated', {
              conversationId,
              draftText: keptDraft,
              draftAttachments: keptAttachments,
              draftUpdatedAt: keptAt,
              draftUpdatedByClientId: null,
              senderClientId: null,
            });
          }
        }
        return res.status(409).json({
          error: `This chat now runs on the ${boundClaudeBilling === 'claude-api' ? 'Claude API key' : 'Claude subscription'}. Send again to confirm.`,
          code: 'CLAUDE_BILLING_CHANGED',
          conversationId,
          billing: boundClaudeBilling,
          keptInDraft: true,
        });
      }
    }
    // A switch with the message: the rest of the send resolves the model,
    // effort and limits against the billing it switches to.
    const runtimeProviderType = billingSwitch?.to || boundProviderType;
    // An agent's send to a chat on the key while this month's cap is reached
    // is refused before anything is stored, so the agent hears it at once (a
    // page's send is queued and refused at the claim, with its note there).
    // A send that switches to the key was refused by the switch's own check;
    // one that names the key for a chat already on it (a switch that changes
    // nothing) is refused here like any other.
    if (remoteRequest.remote && (!billingSwitch || billingSwitch.to === 'claude-api') && runtimeProviderType === 'claude-api') {
      let cap = null;
      try { cap = getClaudeApiCapState() || null; } catch { cap = { reached: true }; }
      if (cap?.reached === true) {
        return res.status(409).json({
          error: `${String(cap.error || '').trim() || 'This month\'s Claude API spend has reached its cap.'} Nothing was queued. Send with provider "claude" to move the session to the Claude subscription, or ask the user to raise the cap.`,
          code: 'CLAUDE_API_CAP_REACHED',
          conversationId,
          billing: 'claude-api',
        });
      }
    }
    const runtimeUsesOpenAI = runtimeProviderType === 'openai';
    // Providers that resell each other's model ids ("claude-opus-5" is served by
    // Claude, Copilot and Cursor alike) make a model id useless for deciding
    // which provider a request targets. A session already bound to an explicit
    // provider resolves ids against that provider's own catalog, so the
    // cross-provider guards below must not infer a switch from the id alone.
    // A session already bound to a managed provider resolves models against
    // that provider's catalog. Include every non-github worker provider here
    // so cross-provider mid-chat guards do not mis-fire (e.g. Cursor listing
    // a Grok model id must not 409 a Grok-bound conversation).
    const runtimeBoundToExplicitProvider = runtimeProviderType === 'openai'
      || runtimeProviderType === 'claude'
      || runtimeProviderType === 'cursor'
      || runtimeProviderType === 'grok'
      || runtimeProviderType === 'claude-cloud'
      || runtimeProviderType === 'deepseek'
      || runtimeProviderType === 'claude-api';
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
    // This create path can only bind github/openai sessions. Accepting a
    // Cursor, Grok or Claude request here would silently produce a GitHub
    // conversation running a model the caller never asked for.
    const bootstrapOnlyProvider = shouldCreateConversation
      ? BOOTSTRAP_ONLY_PROVIDER_LABELS[requestedProviderType]
      : null;
    if (bootstrapOnlyProvider) {
      // 409 to match its siblings (CURSOR/GROK_MODEL_REQUIRES_NEW_CONVERSATION),
      // which report the same "wrong entry point for this provider" condition.
      return res.status(409).json({
        error: `Creating a ${bootstrapOnlyProvider} conversation requires POST /api/conversation/bootstrap`,
        code: 'PROVIDER_REQUIRES_BOOTSTRAP',
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
    // A Copilot conversation is bound too, for the model-id guards below only:
    // Copilot resells Claude and GPT models under ids of its own
    // ("claude-opus-5.5"), so a Claude-form id another provider lists
    // ("claude-opus-5-5") is a model Copilot lacks, answered by the Copilot
    // check further down, never a switch to Cursor, Grok or DeepSeek. (It is
    // not in runtimeBoundToExplicitProvider: that one also picks the catalog.)
    const runtimeBoundForModelGuards = runtimeBoundToExplicitProvider || runtimeProviderType === 'github';
    // Cursor conversations are bootstrap-created only, so an existing
    // github/openai/claude conversation cannot cross to the Cursor provider
    // mid-conversation. Cursor settings are read lazily so the hot path stays
    // untouched for non-Cursor requests.
    const runtimeUsesCursor = runtimeProviderType === 'cursor';
    if (!shouldCreateConversation && !runtimeUsesCursor) {
      let requestTargetsCursor = requestedProviderType === 'cursor';
      if (
        !requestTargetsCursor
        && !runtimeBoundForModelGuards
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
    // Grok conversations are bootstrap-created only (same isolation as Cursor).
    const runtimeUsesGrok = runtimeProviderType === 'grok';
    if (!shouldCreateConversation && !runtimeUsesGrok) {
      let requestTargetsGrok = requestedProviderType === 'grok';
      if (
        !requestTargetsGrok
        && !runtimeBoundForModelGuards
        && requestedOpenAIModel
        && !requestedModelAvailableInGitHub
      ) {
        const grokSettings = getGrokProviderSettings();
        const grokOnlyModels = new Set([
          String(grokSettings?.model || '').trim(),
          ...(Array.isArray(grokSettings?.models) ? grokSettings.models : [])
            .map((value) => String(value || '').trim()),
        ].filter(Boolean));
        requestTargetsGrok = grokSettings?.enabled === true && grokOnlyModels.has(requestedOpenAIModel);
      }
      if (requestTargetsGrok) {
        return res.status(409).json({
          error: 'Grok model selection requires creating a new Grok conversation',
          code: 'GROK_MODEL_REQUIRES_NEW_CONVERSATION',
        });
      }
    }
    // DeepSeek conversations are bootstrap-created only too. Its ids are its
    // own ("deepseek-*"), so an id alone may name it for an unbound session.
    const runtimeUsesDeepSeek = runtimeProviderType === 'deepseek';
    if (!shouldCreateConversation && !runtimeUsesDeepSeek) {
      let requestTargetsDeepSeek = requestedProviderType === 'deepseek';
      if (
        !requestTargetsDeepSeek
        && !runtimeBoundForModelGuards
        && requestedOpenAIModel
        && !requestedModelAvailableInGitHub
      ) {
        const deepseekSettings = getDeepSeekProviderSettings();
        const deepseekOnlyModels = new Set([
          String(deepseekSettings?.model || '').trim(),
          ...(Array.isArray(deepseekSettings?.models) ? deepseekSettings.models : [])
            .map((value) => String(value || '').trim()),
        ].filter(Boolean));
        requestTargetsDeepSeek = deepseekSettings?.enabled === true && deepseekOnlyModels.has(requestedOpenAIModel);
      }
      if (requestTargetsDeepSeek) {
        return res.status(409).json({
          error: 'DeepSeek model selection requires creating a new DeepSeek conversation',
          code: 'DEEPSEEK_MODEL_REQUIRES_NEW_CONVERSATION',
        });
      }
    }
    // Claude Cloud conversations are bootstrap-created only as well: each
    // carries the repository its cloud session clones. Only an explicit
    // provider counts here — the cloud's model ids are the Claude provider's
    // own, so an id alone never means "cloud".
    const runtimeUsesClaudeCloud = runtimeProviderType === 'claude-cloud';
    if (!shouldCreateConversation && !runtimeUsesClaudeCloud && requestedProviderType === 'claude-cloud') {
      return res.status(409).json({
        error: 'Claude Cloud requires creating a new Claude Cloud conversation',
        code: 'CLAUDE_CLOUD_REQUIRES_NEW_CONVERSATION',
      });
    }
    // Claude API conversations are bootstrap-created only as well, and asked
    // for by name only: their model ids are the Claude provider's. Moving a
    // chat between the subscription and the key is not a send's to make here.
    const runtimeUsesClaudeApi = runtimeProviderType === 'claude-api';
    if (!shouldCreateConversation && !runtimeUsesClaudeApi && requestedProviderType === 'claude-api') {
      return res.status(409).json({
        error: 'Claude API requires creating a new Claude API conversation',
        code: 'CLAUDE_API_REQUIRES_NEW_CONVERSATION',
      });
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
    // A Claude API conversation runs the same CLI on an API key: the same
    // rules, against its own model list and efforts.
    const runtimeUsesClaude = runtimeProviderType === 'claude' || runtimeUsesClaudeApi;
    const configuredClaude = runtimeUsesClaude
      ? (runtimeUsesClaudeApi ? getClaudeApiProviderSettings() : getClaudeProviderSettings())
      : null;
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
    const availableCursorModels = [
      String(configuredCursor?.model || '').trim(),
      String(existingRuntimeSession?.provider_model || '').trim(),
      ...(Array.isArray(configuredCursor?.models) ? configuredCursor.models : []),
    ].map((value) => String(value || '').trim()).filter(Boolean);
    // A model the Cursor provider does not offer is refused instead of quietly
    // relabelled: silently answering with the pinned/default model is how a
    // conversation ended up running a different model than the composer showed.
    const cursorModelSelection = runtimeUsesCursor
      ? resolveProviderModelSelection({
          requestedModel: requestedCursorModel,
          configuredModel: String(existingRuntimeSession?.provider_model || '').trim()
            || String(configuredCursor?.model || '').trim(),
          availableModels: availableCursorModels,
        })
      : null;
    if (cursorModelSelection && !cursorModelSelection.ok) {
      return res.status(400).json({
        error: `Cursor model "${cursorModelSelection.requestedModel}" is not available`,
        code: 'CURSOR_MODEL_UNAVAILABLE',
        supportedModels: cursorModelSelection.availableModels || [],
      });
    }
    const cursorModel = cursorModelSelection ? cursorModelSelection.model : '';
    const configuredGrok = runtimeUsesGrok ? getGrokProviderSettings() : null;
    const requestedGrokModel = runtimeUsesGrok ? String(model || '').trim() : '';
    const pinnedGrokModel = runtimeUsesGrok
      ? String(existingRuntimeSession?.provider_model || '').trim()
      : '';
    // The Grok ACP surface has no mid-session model switch (the model rides
    // only on session/new `_meta`), so the model pinned at bootstrap is
    // locked for the conversation's lifetime. A different request is refused
    // rather than silently relabeled.
    if (
      runtimeUsesGrok
      && requestedGrokModel
      && requestedGrokModel.toLowerCase() !== AUTO_MODEL_SENTINEL
      && pinnedGrokModel
      && requestedGrokModel.toLowerCase() !== pinnedGrokModel.toLowerCase()
    ) {
      return res.status(409).json({
        error: 'Grok model switching requires creating a new Grok conversation',
        code: 'GROK_MODEL_REQUIRES_NEW_CONVERSATION',
      });
    }
    const grokModel = runtimeUsesGrok
      ? (pinnedGrokModel || String(configuredGrok?.model || '').trim())
      : '';
    // Claude Cloud conversations resolve models against the cloud provider's
    // own list (plain ids, no "[1m]" tier). The first message creates the
    // cloud session with the conversation's model; a later change is applied
    // by the worker before the next message (see below).
    const configuredClaudeCloud = runtimeUsesClaudeCloud ? getClaudeCloudProviderSettings() : null;
    const pinnedClaudeCloudModel = runtimeUsesClaudeCloud
      ? stripModelTierSuffix(existingRuntimeSession?.provider_model)
      : '';
    const claudeCloudModelSelection = runtimeUsesClaudeCloud
      ? resolveProviderModelSelection({
          requestedModel: stripModelTierSuffix(model),
          configuredModel: pinnedClaudeCloudModel || String(configuredClaudeCloud?.defaultModel || '').trim(),
          availableModels: Array.isArray(configuredClaudeCloud?.models) ? configuredClaudeCloud.models : [],
        })
      : null;
    if (claudeCloudModelSelection && !claudeCloudModelSelection.ok) {
      return res.status(400).json({
        error: `Claude Cloud model "${claudeCloudModelSelection.requestedModel}" is not available`,
        code: 'CLAUDE_CLOUD_MODEL_UNAVAILABLE',
        supportedModels: claudeCloudModelSelection.availableModels || [],
      });
    }
    // A cloud session's model can be switched between turns (the worker
    // sends set_model before the message), so a changed model is taken as
    // for a local Claude chat.
    const claudeCloudModel = claudeCloudModelSelection ? claudeCloudModelSelection.model : '';
    // DeepSeek conversations resolve models against the DeepSeek catalog and
    // may switch between turns, like Claude ones (the worker's CLI switches
    // before the next message). A model DeepSeek does not offer is refused.
    const configuredDeepSeek = runtimeUsesDeepSeek ? getDeepSeekProviderSettings() : null;
    const pinnedDeepSeekModel = runtimeUsesDeepSeek ? String(existingRuntimeSession?.provider_model || '').trim() : '';
    const deepseekModelSelection = runtimeUsesDeepSeek
      ? resolveProviderModelSelection({
          requestedModel: String(model || '').trim(),
          configuredModel: pinnedDeepSeekModel || String(configuredDeepSeek?.model || '').trim(),
          availableModels: [
            String(configuredDeepSeek?.model || '').trim(),
            pinnedDeepSeekModel,
            ...(Array.isArray(configuredDeepSeek?.models) ? configuredDeepSeek.models : []),
          ].map((value) => String(value || '').trim()).filter(Boolean),
        })
      : null;
    if (deepseekModelSelection && !deepseekModelSelection.ok) {
      return res.status(400).json({
        error: `DeepSeek model "${deepseekModelSelection.requestedModel}" is not available`,
        code: 'DEEPSEEK_MODEL_UNAVAILABLE',
        supportedModels: deepseekModelSelection.availableModels || [],
      });
    }
    const deepseekModel = deepseekModelSelection ? deepseekModelSelection.model : '';
    // A model without image input cannot take over a session whose transcript
    // carries images: the resumed history would fail the whole request.
    if (
      runtimeUsesDeepSeek
      && deepseekModel
      && pinnedDeepSeekModel
      && deepseekModel.toLowerCase() !== pinnedDeepSeekModel.toLowerCase()
      && !deepseekModelAcceptsImages(deepseekModel)
      && conversationHasImageAttachment(conversationId)
    ) {
      return res.status(409).json({
        error: `${deepseekModelLabel(deepseekModel)} takes no images, and this conversation already has some. Stay on ${deepseekModelLabel(pinnedDeepSeekModel)}, or start a new DeepSeek conversation for ${deepseekModelLabel(deepseekModel)}.`,
        code: 'DEEPSEEK_MODEL_TEXT_ONLY',
      });
    }
    // What the request itself chose. Only these are saved as the
    // conversation's preference; a value filled in below never is.
    const explicitModelGiven = !!requestedOpenAIModel;
    const conversationReasoningEffort = String(existingConversation?.preferred_reasoning_effort || '').trim().toLowerCase();
    // A Copilot conversation sent no model keeps its own: the saved
    // preference, the runtime session's model, the latest user message's,
    // and the catalog default only when it has none of these. A model the
    // catalog no longer lists is refused rather than swapped for another.
    const usesGitHubCatalog = !useOpenAIProvider && !runtimeBoundToExplicitProvider;
    const inheritedModel = usesGitHubCatalog && !shouldCreateConversation && !explicitModelGiven
      ? inheritedConversationModel({
          conversation: existingConversation,
          runtimeSession: existingRuntimeSession,
          latestUserMessageModel: stmts.getLatestUserMessageModel?.get?.(conversationId)?.model || '',
        })
      : null;
    const githubModelResolution = usesGitHubCatalog
      ? resolveRequestedModel(inheritedModel ? inheritedModel.model : model)
      : null;
    if (inheritedModel && !githubModelResolution?.ok) {
      return res.status(409).json({
        error: `This conversation's model "${inheritedModel.model}" is no longer available. Choose a model and send again.`,
        code: 'CONVERSATION_MODEL_UNAVAILABLE',
        conversationId,
        model: inheritedModel.model,
        supportedModels: githubModelResolution?.available || [],
      });
    }
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
          : (runtimeUsesGrok
            ? {
                ok: !!grokModel,
                model: grokModel,
                modelVariantId: grokModel,
                reasoningEffort: null,
                error: grokModel ? null : 'Grok model is not configured',
              }
            : (runtimeUsesClaudeCloud
              ? {
                  ok: !!claudeCloudModel,
                  model: claudeCloudModel,
                  modelVariantId: claudeCloudModel,
                  reasoningEffort: null,
                  error: claudeCloudModel ? null : 'Claude Cloud model is not configured',
                }
              : (runtimeUsesDeepSeek
                ? {
                    ok: !!deepseekModel,
                    model: deepseekModel,
                    modelVariantId: deepseekModel,
                    reasoningEffort: null,
                    error: deepseekModel ? null : 'DeepSeek model is not configured',
                  }
                : githubModelResolution)))));
    // A model Copilot does not list is named with its close matches, as the
    // bootstrap names it: "claude-opus-5-5" (the Claude form) gets "did you
    // mean 'claude-opus-5.5'?". Refused before anything is stored.
    if (!modelResolution.ok && modelResolution === githubModelResolution && explicitModelGiven) {
      const copilotCheck = checkRequestedProviderModel({
        requestedModel: requestedOpenAIModel,
        provider: 'github',
        models: Array.isArray(githubModelResolution.available) ? githubModelResolution.available : [],
      });
      if (copilotCheck.status === 'unknown') {
        return res.status(400).json({
          error: unknownProviderModelText({ model: copilotCheck.model, provider: 'github', suggestions: copilotCheck.suggestions, models: copilotCheck.models }),
          code: 'COPILOT_MODEL_UNAVAILABLE',
          supportedModels: copilotCheck.models,
          ...(copilotCheck.suggestions.length ? { suggestedModels: copilotCheck.suggestions } : {}),
        });
      }
    }
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
    // A send that names no effort runs with the conversation's own, clamped
    // to the nearest level the model has. Null when there is nothing to keep
    // or it neither matches nor clamps (an ultracode on a model without it):
    // the provider's own default applies then.
    const conversationEffortFor = (supported) => (
      !explicitReasoningEffort && conversationReasoningEffort
        ? (fallbackReasoningEffort([conversationReasoningEffort], supported, { fallback: '' }) || null)
        : null
    );
    // Claude conversations validate effort against the Claude provider's
    // per-model levels ('none' = SDK default). Effort is per-turn: each Claude
    // turn is a fresh query(), so it can change between messages.
    const resolveClaudeReasoningEffort = () => {
      const requestedEffort = String(explicitReasoningEffort || '').trim().toLowerCase();
      const supported = Array.isArray(configuredClaude?.effortsByModel?.[String(requestedModel || '').trim().toLowerCase()])
        ? configuredClaude.effortsByModel[String(requestedModel || '').trim().toLowerCase()]
        : [...DEFAULT_CLAUDE_REASONING_EFFORTS];
      const kept = conversationEffortFor(supported);
      if (kept) return { ok: true, effort: kept, supported };
      const effort = supported.includes(requestedEffort) ? requestedEffort : 'none';
      return { ok: true, effort: effort === 'none' ? 'none' : effort, supported };
    };
    // Cursor conversations validate effort against the discovered per-model
    // tiers ('none' = reasoning/thinking off where the model can express it,
    // model default otherwise). Effort is per-turn: it maps onto model params
    // on each agent.send, so it can change between messages.
    const resolveCursorReasoningEffort = () => {
      const requestedEffort = String(explicitReasoningEffort || '').trim().toLowerCase();
      const discovered = configuredCursor?.effortsByModel?.[String(requestedModel || '').trim().toLowerCase()];
      if (!Array.isArray(discovered)) {
        // 'auto' / undiscovered model: pass the request through untouched —
        // the worker validates it against the resolved model's live params
        // and falls back to the model default on any mismatch. Clamping to
        // 'none' here would actively disable thinking on the resolved model.
        // The conversation's own effort goes through the same way.
        return { ok: true, effort: requestedEffort || conversationReasoningEffort, supported: [] };
      }
      const kept = conversationEffortFor(discovered);
      if (kept) return { ok: true, effort: kept, supported: discovered };
      const effort = discovered.includes(requestedEffort) ? requestedEffort : 'none';
      return { ok: true, effort, supported: discovered };
    };
    const resolveGrokReasoningEffort = () => {
      const requestedEffort = String(explicitReasoningEffort || '').trim().toLowerCase();
      const supported = Array.isArray(configuredGrok?.effortsByModel?.[String(requestedModel || '').trim().toLowerCase()])
        ? configuredGrok.effortsByModel[String(requestedModel || '').trim().toLowerCase()]
        : ['none', 'low', 'medium', 'high'];
      const kept = conversationEffortFor(supported);
      if (kept) return { ok: true, effort: kept, supported };
      const effort = supported.includes(requestedEffort) ? requestedEffort : 'none';
      return { ok: true, effort, supported };
    };
    // DeepSeek takes none/low/high/max for every model; other names map to
    // what DeepSeek would run ("medium" is high), and no stated effort is the
    // conversation's own, else high, DeepSeek's default.
    const resolveDeepSeekReasoningEffort = () => {
      const supported = [...DEEPSEEK_REASONING_EFFORTS];
      const requestedEffort = deepseekReasoningEffortFor(explicitReasoningEffort);
      if (requestedEffort) return { ok: true, effort: requestedEffort, supported };
      const kept = deepseekReasoningEffortFor(conversationReasoningEffort);
      return { ok: true, effort: kept || DEFAULT_DEEPSEEK_REASONING_EFFORT, supported };
    };
    let reasoningResolution = useOpenAIProvider
      ? resolveOpenAIReasoningEffort(
          explicitReasoningEffort || conversationEffortFor(openAIReasoningEffortsForModel(openAIModel)) || '',
          openAIModel,
        )
      : (runtimeUsesClaude
        ? resolveClaudeReasoningEffort()
        : (runtimeUsesCursor
          ? resolveCursorReasoningEffort()
          : (runtimeUsesGrok
            ? resolveGrokReasoningEffort()
            // A cloud session takes no effort: whatever was asked, it is none.
            : (runtimeUsesClaudeCloud
              ? { ok: true, effort: 'none', supported: ['none'] }
              : (runtimeUsesDeepSeek
                ? resolveDeepSeekReasoningEffort()
                : resolveRequestedReasoningEffort(
                    requestedModel,
                    explicitReasoningEffort || modelResolution.reasoningEffort || null,
                  ))))));
    // No effort sent (or the model's variant carried one it lacks): the
    // conversation's own effort, clamped to the model's levels, else its
    // lowest level that is not 'none'. Some models list 'none' and the API
    // still refuses it, so it is taken only when the conversation chose it or
    // the model has nothing else.
    if (!reasoningResolution?.ok && !explicitReasoningEffort) {
      const supportedEfforts = Array.isArray(reasoningResolution?.supported)
        ? reasoningResolution.supported.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
        : [];
      const fallbackEffort = fallbackReasoningEffort(
        [modelResolution.reasoningEffort, conversationReasoningEffort],
        supportedEfforts,
      );
      if (fallbackEffort) {
        reasoningResolution = resolveRequestedReasoningEffort(requestedModel, fallbackEffort);
      }
    }
    if (!reasoningResolution?.ok) {
      return res.status(400).json({
        error: reasoningResolution?.error || 'Unsupported reasoning effort',
        supportedReasoningEfforts: Array.isArray(reasoningResolution?.supported) ? reasoningResolution.supported : [],
      });
    }
    const requestedReasoningEffort = reasoningResolution.effort || null;
    // The request's own effort: sent as such, or carried by the variant id of
    // a model it named.
    const explicitEffortGiven = !!explicitReasoningEffort || (explicitModelGiven && !!modelResolution.reasoningEffort);
    let normalizedContextTier = requestedContextTier;
    if (openAIImageModel) {
      normalizedContextTier = normalizeOpenAIImageSize(requestedContextTier) || 'auto';
      if (!normalizedContextTier) {
        return res.status(400).json({ error: 'Unsupported image size option' });
      }
    } else if (!['default', 'long_context'].includes(requestedContextTier)) {
      return res.status(400).json({ error: 'Unsupported context tier' });
    } else if (runtimeUsesClaudeCloud || runtimeUsesDeepSeek) {
      // The cloud has no long-context tier to pick, and DeepSeek's one window
      // is already 1M.
      normalizedContextTier = 'default';
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

    const resend = shouldCreateConversation
      ? null
      : resolveStoppedSteerResend(conversationId, req.body.resendOfMessageId, trimmedText);
    if (resend?.alreadyResentAs) {
      return res.json({
        ok: true,
        duplicate: true,
        queued: false,
        alreadyResent: true,
        duplicateOfMessageId: resend.alreadyResentAs,
        conversationId,
      });
    }
    const resendOriginId = resend?.originId || null;
    // Another relay's agent sends every prompt with a fresh messageId, and a
    // retry of the same send hits the messageId check at insert. The text
    // window below would instead swallow a deliberate repeat ("run the tests
    // again"), which the agent cannot tell from a lost send.
    const exemptFromTextDuplicateCheck = remoteRequest.remote && !!clientMessageId;
    if (!shouldCreateConversation && !exemptFromTextDuplicateCheck) {
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
        exemptMessageIds: resend?.exemptIds || [],
      });
      if (duplicateMessage) {
        return res.json({
          ok: true,
          duplicate: true,
          // Said outright for a caller that reads only `ok`: nothing new runs.
          queued: false,
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
      // An agent's prompt opens with the sending relay's header line, which
      // says who is talking, not what the conversation is about.
      const titleText = remoteRequest.remote ? stripRemotePromptHeader(trimmedText).trim() : trimmedText;
      getOrCreateConversation(convId, titleText || attachmentSummary(attachments) || 'Image');
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
    const promptText = shouldApplySeed
      ? [
          '[Carry-over context from previous compacted conversation]',
          String(convSeed.summary_seed).trim(),
          '',
          '[New user request]',
          trimmedText || '(User sent image attachments only.)',
        ].join('\n')
      : trimmedText;
    // Only what a human typed unlocks a remote relay by mention (decision 19);
    // a prompt from a relay's agent opens that one relay and no other. The hint
    // rides in the queued prompt only, so the stored message and the user's
    // bubble stay exactly what was typed.
    const mentionedRemoteRelays = remoteRequest.remote
      ? []
      : findMentionedRemoteRelays(remoteRelayInbound, trimmedText);
    // A prompt from another relay's agent opens that relay for this
    // conversation (it may be answered): the agent is told where it came from.
    const remoteRelayHint = remoteRequest.remote
      ? formatRemoteRelayOriginHint(findOriginRemoteRelay(remoteRelayInbound, remoteRequest.origin), remoteRequest.origin)
      : formatRemoteRelayMentionHint(mentionedRemoteRelays);
    const queueText = withRemoteRelayMentionHint(promptText, remoteRelayHint);
    // A Resend never came from the composer, and neither did another relay's
    // agent: whatever the user is typing there stays their draft.
    const keepsComposerDraft = !!resendOriginId || remoteRequest.remote;

    const requestedModelOrigin = deriveModelOrigin(requestedModelVariantId || requestedModel);
    let conversationPreferences;
    let imageOperation = null;
    // The switch's announcement, made once the send has committed.
    let announceBillingSwitch = null;
    const persistMessageAndQueue = db.transaction(() => {
      // First, so the row below is stamped with the new billing; a refused
      // switch undoes the whole send.
      if (billingSwitch) {
        const switched = claudeBillingSwitchService?.switchBilling?.({
          conversationId: convId,
          to: billingSwitch.to,
          by: billingSwitch.by,
          model: claudeModel,
          deferAnnounce: true,
        }) || { ok: false, status: 501, code: 'CLAUDE_BILLING_UNAVAILABLE', error: 'The billing switch is unavailable' };
        if (!switched.ok) throw Object.assign(new Error(switched.error), { billingRefusal: switched });
        announceBillingSwitch = switched.announce || null;
      }
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
      if (remoteRequest.origin) remoteRelayInbound?.repository?.setMessageOrigin?.(msgId, remoteRequest.origin);
      linkUploadReferences(convId, msgId, attachments);
      stmts.updateConvTime.run(now, convId);
      if (resendOriginId) stmts.setMessageResendOf?.run(resendOriginId, msgId);
      if (!keepsComposerDraft) {
        if (typeof stmts.updateConvDraft?.run === 'function') {
          stmts.updateConvDraft.run(null, now, sessionId || null, convId);
        } else {
          db.prepare(`
            UPDATE conversations
            SET draft_text = NULL, draft_updated_at = ?, draft_updated_by_client_id = ?
            WHERE id = ?
          `).run(now, sessionId || null, convId);
        }
        // The message now owns these blobs, so the draft placeholders can go. The
        // sent-message references were just inserted above, so nothing is orphaned.
        if (typeof stmts.updateConvDraftAttachments?.run === 'function') {
          stmts.updateConvDraftAttachments.run(null, now, sessionId || null, convId);
        } else {
          db.prepare(`
            UPDATE conversations
            SET draft_attachments = NULL, draft_updated_at = ?, draft_updated_by_client_id = ?
            WHERE id = ?
          `).run(now, sessionId || null, convId);
        }
        stmts.deleteDraftUploadRefs?.run?.(convId);
      }
      // Cursor allows per-turn model switching, so the pinned provider_model has
      // to follow the accepted model; otherwise the conversation list and the
      // composer keep restoring the model chosen at bootstrap.
      if (
        runtimeUsesCursor
        && cursorModel
        && runtimeSession?.id
        && cursorModel !== String(existingRuntimeSession?.provider_model || '').trim()
        && typeof stmts.updateRuntimeSessionProvider?.run === 'function'
      ) {
        stmts.updateRuntimeSessionProvider.run('cursor', cursorModel, cursorModel, now, runtimeSession.id);
      }
      // Claude switches per turn too, and the worker launch env reads
      // provider_model || model — without this a relaunched worker came up on
      // the model chosen at bootstrap, not the one the composer last used.
      if (
        runtimeUsesClaude
        && claudeModel
        && runtimeSession?.id
        && claudeModel !== String(existingRuntimeSession?.provider_model || '').trim()
        && typeof stmts.updateRuntimeSessionProvider?.run === 'function'
      ) {
        stmts.updateRuntimeSessionProvider.run(runtimeUsesClaudeApi ? 'claude-api' : 'claude', claudeModel, claudeModel, now, runtimeSession.id);
      }
      // DeepSeek follows the composer the same way: a relaunched worker reads
      // provider_model, so it has to be the model last used.
      if (
        runtimeUsesDeepSeek
        && deepseekModel
        && runtimeSession?.id
        && deepseekModel !== String(existingRuntimeSession?.provider_model || '').trim()
        && typeof stmts.updateRuntimeSessionProvider?.run === 'function'
      ) {
        stmts.updateRuntimeSessionProvider.run('deepseek', deepseekModel, deepseekModel, now, runtimeSession.id);
      }
      // A cloud conversation follows the composer like a Claude one: the
      // worker switches the sandbox's model before the message.
      if (
        runtimeUsesClaudeCloud
        && claudeCloudModel
        && runtimeSession?.id
        && claudeCloudModel !== String(existingRuntimeSession?.provider_model || '').trim()
        && typeof stmts.updateRuntimeSessionProvider?.run === 'function'
      ) {
        stmts.updateRuntimeSessionProvider.run('claude-cloud', claudeCloudModel, claudeCloudModel, now, runtimeSession.id);
      }
      // Another relay's agent picks the model and mode of its own turn; the
      // composer keeps restoring the user's choice for this conversation.
      // Any other send to an existing conversation saves only what it named:
      // a model or an effort filled in from a fallback is never written back
      // as the conversation's choice (an empty effort keeps the stored one).
      const savedModel = String(existingConversation?.preferred_model || '').trim();
      if (shouldCreateConversation) {
        conversationPreferences = persistConversationModelPreference(
          convId, requestedRelayMode, requestedModel, requestedReasoningEffort, now,
        );
      } else if (remoteRequest.remote || (!explicitModelGiven && !(explicitEffortGiven && savedModel))) {
        conversationPreferences = readConversationModelPreference(convId, requestedRelayMode);
      } else {
        conversationPreferences = persistConversationModelPreference(
          convId,
          requestedRelayMode,
          explicitModelGiven ? requestedModel : savedModel,
          explicitEffortGiven ? requestedReasoningEffort : '',
          now,
        );
      }
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
    try {
      persistMessageAndQueue();
      try { announceBillingSwitch?.(); } catch {}
    } catch (error) {
      if (error?.billingRefusal) {
        const refused = error.billingRefusal;
        return res.status(refused.status || 409).json({
          error: refused.error,
          code: refused.code,
          conversationId: convId,
          ...(refused.model ? { model: refused.model } : {}),
        });
      }
      // A replayed send (Background Sync outbox) with a caller-supplied id hits
      // the messages.id primary key. Surface it as a clean 409 so the replay
      // can treat "already accepted" as success instead of retrying forever.
      const constraintViolation = String(error?.code || '').startsWith('SQLITE_CONSTRAINT');
      if (clientMessageId && constraintViolation && stmts.getMessageByConversation?.get?.(msgId, convId)) {
        return res.status(409).json({
          error: 'Message already exists',
          code: 'DUPLICATE_MESSAGE_ID',
          messageId: msgId,
          conversationId: convId,
        });
      }
      throw error;
    }
    recordRemoteRelayUnlocks(remoteRelayInbound, {
      conversationId: convId,
      messageId: msgId,
      relays: mentionedRemoteRelays,
    });
    if (!keepsComposerDraft) {
      io.emit('conversation_draft_updated', {
        conversationId: convId,
        draftText: '',
        draftAttachments: [],
        draftUpdatedAt: now,
        draftUpdatedByClientId: sessionId || null,
        senderClientId: sessionId || null,
      });
    }
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

    console.log(`[${ts()}] QUEUED    ${msgId.slice(0,8)} conv=${convId.slice(0,8)} rs=${String(runtimeSession?.id || 'none').slice(0,8)} owner=${String(ownerSessionId || 'none').slice(0,8)} new=${!conversationId || !!newConversation} model=${requestedModel} variant=${requestedModelVariantId}${requestedReasoningEffort ? ` effort=${requestedReasoningEffort}` : ''} mode=${requestedRelayMode} text="${trimmedText.slice(0,60)}"${shouldApplySeed ? ' seeded=1' : ''}${attachments.length ? ` attachments=${attachments.length}` : ''}${remoteRequest.remote ? ` remote=${remoteRequest.origin?.relayName || remoteRequest.origin?.relayId || 'unknown'} hops=${remoteRequest.origin?.hops ?? '?'}` : ''}${mentionedRemoteRelays.length ? ` mentions=${mentionedRemoteRelays.length}` : ''}`);

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
          ...(remoteRequest.origin ? { origin: remoteRequest.origin } : {}),
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
      runtimeProviderType: billingSwitch?.to
        || String(runtimeSession?.provider_type || (useOpenAIProvider ? 'openai' : 'github')).trim().toLowerCase(),
      ...(billingSwitch ? { billingSwitched: true } : {}),
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
      // Attachment references that no longer resolve (a deleted upload) are
      // dropped silently by normalizeAttachments; the sender is told how many.
      droppedAttachmentCount: Math.max(0, requestedAttachmentCount - normalizedAttachments.length),
      imageOperation: imageOperation
        ? {
            id: imageOperation.id,
            mode: imageOperation.mode,
            kind: imageOperation.kind,
          }
        : null,
    });
  };
  app.post('/api/message', auth, handleSendMessage);

  // POST /api/conversation/:id/billing — move a Claude chat between the
  // subscription and the saved API key (`to`: "claude" | "claude-api"): the
  // composer's toggle, the usage-limit note's button (`by: "usage-limit"`)
  // and an agent's `send` with a provider (`by: "agent"`). With `message`
  // (the body /api/message takes), the switch and the enqueue are one
  // transaction: a send that is refused leaves the billing as it was, and a
  // refused switch sends nothing. Applies from the next turn; a running one
  // finishes on its billing.
  app.post('/api/conversation/:id/billing', auth, async (req, res) => {
    if (!claudeBillingSwitchService) {
      return res.status(501).json({ ok: false, error: 'The billing switch is unavailable', code: 'CLAUDE_BILLING_UNAVAILABLE' });
    }
    const conversationId = String(req.params?.id || '').trim();
    const to = normalizeClaudeBilling(req.body?.to ?? req.body?.provider);
    const byValue = String(req.body?.by || '').trim().toLowerCase();
    const by = ['user', 'agent', 'usage-limit'].includes(byValue) ? byValue : 'user';
    const message = req.body?.message && typeof req.body.message === 'object' && !Array.isArray(req.body.message)
      ? req.body.message
      : null;
    // Checked first, so a refusal names the switch's reason before the send's.
    const check = claudeBillingSwitchService.checkSwitch({ conversationId, to, model: message?.model || '' });
    if (!check.ok) {
      return res.status(check.status || 409).json({
        ok: false,
        error: check.error,
        code: check.code,
        conversationId,
        ...(check.model ? { model: check.model } : {}),
      });
    }
    if (message) {
      const sendRequest = Object.create(req);
      sendRequest.body = {
        ...message,
        conversationId,
        newConversation: false,
        provider: undefined,
        providerType: undefined,
        billing: undefined,
      };
      sendRequest.oarBillingSwitch = { to: check.to, by };
      return handleSendMessage(sendRequest, res);
    }
    if (by === 'usage-limit' && check.to !== 'claude-api') {
      return res.status(400).json({ ok: false, error: 'The usage-limit note switches to the API key only', code: 'CLAUDE_BILLING_INVALID' });
    }
    const result = claudeBillingSwitchService.switchBilling({ conversationId, to: check.to, by });
    if (!result?.ok) {
      return res.status(result?.status || 409).json({
        ok: false,
        error: result?.error || 'The billing switch failed',
        code: result?.code || null,
        conversationId,
        ...(result?.model ? { model: result.model } : {}),
      });
    }
    return res.json({
      ok: true,
      conversationId,
      changed: result.changed,
      provider: result.provider,
      released: !!result.released,
      billing: claudeBillingSwitchService.billingState(conversationId),
    });
  });

  app.post('/api/heartbeat', auth, (req, res) => {
    touchCli();
    const requester = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requester?.sessionId);
    const settleFailedHandled = [];
    const settleFailedSkipped = [];
    let resyncBackgroundTasks = false;
    const activeQueueMessageId = String(req.body?.activeQueueMessageId || '').trim();
    // A persistent-process worker can hold several live rows at once (the
    // running turn plus a delivered message queued behind it plus a
    // background continuation); every one of them needs its lease refreshed
    // or the owner-recovery below replays a turn the worker still owns.
    const activeQueueMessageIds = [...new Set(
      [
        activeQueueMessageId,
        ...(Array.isArray(req.body?.activeQueueMessageIds) ? req.body.activeQueueMessageIds : []),
      ].map((value) => String(value || '').trim()).filter(Boolean),
    )];
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
      // The worker's composer-facing steering snapshot rides the heartbeat;
      // store it on the registry entry (status payload spreads it to clients)
      // only when it actually changed, so quiet heartbeats stay write-free.
      // Normalized with the registry's own rules BEFORE comparing — comparing
      // raw against stored would never converge for values the registry drops.
      const steering = normalizeWorkerSteeringSnapshot(req.body?.steering);
      if (steering) {
        const workerForSteering = sessionWorkerRegistry?.getWorker?.(requesterSessionId) || null;
        const stored = workerForSteering?.steering || null;
        const storedCancellableIds = Array.isArray(stored?.cancellableIds) ? stored.cancellableIds : [];
        const changed = !stored
          || stored.turnActive !== steering.turnActive
          || stored.canSteer !== steering.canSteer
          || (stored.holdReason || null) !== (steering.holdReason || null)
          || (stored.messageId || null) !== (steering.messageId || null)
          // The Copilot SDK worker's opt-in and its un-steerable set: a flip
          // in either must reach the status payload (composer gate, bubble
          // Cancel), so it counts as a change like the hold fields do.
          || (stored.supported === true) !== (steering.supported === true)
          || storedCancellableIds.join('\n') !== steering.cancellableIds.join('\n')
          // The running CLI's compaction window (context-usage modal).
          || JSON.stringify(stored.autoCompactWindow ?? null) !== JSON.stringify(steering.autoCompactWindow ?? null)
          // Whether a billing swap may replace the worker now, and why not.
          || (stored.releasable ?? null) !== (steering.releasable ?? null)
          || (stored.releaseHold || null) !== (steering.releaseHold || null)
          || (stored.backgroundTaskCount || 0) !== (steering.backgroundTaskCount || 0);
        if (workerForSteering && changed) {
          sessionWorkerRegistry?.upsertWorker?.({ ...workerForSteering, steering });
          // Pushed rather than left for the clients' status poll: the
          // composer's Steer/Queue label and the pushed rows' Cancel read it,
          // and the poll would add up to 4 s to a heartbeat that already lags.
          io.emit('session_worker_steering', { sdkSessionId: requesterSessionId, steering });
        }
      }
      // The worker's kind (a Claude chat's billing runs only on its own kind):
      // recorded when it says one and the registry has another.
      const heartbeatKind = normalizeWorkerKind(req.body?.workerKind);
      if (heartbeatKind) {
        const workerForKind = sessionWorkerRegistry?.getWorker?.(requesterSessionId) || null;
        if (workerForKind && workerForKind.kind !== heartbeatKind) {
          sessionWorkerRegistry?.upsertWorker?.({ ...workerForKind, kind: heartbeatKind });
        }
      }
      sessionWorkerSupervisor?.noteSessionHeartbeat?.(requesterSessionId);
      // The worker's digest of its live background-task ids against the set
      // held for it (keyed as the worker posts, by its session id). They
      // differ after a relay restart, which starts with no sets, and after a
      // lost post either way round: the answer then asks for the full set
      // again. A worker that sends no digest has no opinion and is never
      // asked; a relay that holds a set while the worker reports none asks
      // too, and the empty answer ends those tasks.
      // The process this beat comes from holds the session: a set post of
      // another process is a late one (see the task route).
      backgroundTaskStore?.noteHolder?.(requesterSessionId, normalizedRequesterPid);
      const taskDigest = normalizeBackgroundTaskDigest(req.body?.backgroundTasks);
      if (taskDigest && typeof backgroundTaskStore?.matches === 'function') {
        resyncBackgroundTasks = !backgroundTaskStore.matches(taskDigest, requesterSessionId, requesterConversationId);
      }
      // The placeholder for background work this runtime was never told the
      // details of (a worker that cannot resync yet): the pages hear when it
      // appears and when it goes without a set having replaced it.
      if (!resyncBackgroundTasks && backgroundWorkView) {
        const unreported = backgroundWorkView.hasUnreportedWork(requesterSessionId) === true;
        if (backgroundTaskStore?.announce?.(requesterSessionId, unreported)) {
          io.emit('background_tasks', {
            conversationId: requesterSessionId,
            tasks: backgroundWorkView.panelTasks(requesterSessionId, requesterConversationId),
            endedTasks: backgroundTaskStore?.ended?.(requesterSessionId) || [],
          });
        }
      }
      // Consumed steers whose settle the worker could not save within its
      // retry budget (e.g. its writes keep failing): the relay fails them
      // itself with the worker's terminal error, never requeueing them.
      const settleFailedEntries = Array.isArray(req.body?.settleFailed) ? req.body.settleFailed.slice(0, 50) : [];
      const requesterConversationForSettle = String(requester?.conversationId || '').trim() || null;
      for (const entry of settleFailedEntries) {
        const id = String(entry?.id || '').trim();
        const row = id ? stmts.findQById.get(id) : null;
        if (!row || row.status !== 'processing') {
          if (id) settleFailedHandled.push(id);
          continue;
        }
        // Only the worker that owns the row may have it failed, and only in a
        // conversation that worker serves.
        // Anything else is acknowledged as skipped: the worker has no claim on
        // the row, so it stops reporting it (and releases its hold), and the
        // row takes the ordinary recovery path — where a consumed mark still
        // fails it rather than re-running it.
        const rowSession = normalizeSessionWorkerId(stmts.getRuntimeSessionByConversation?.get(row.conversation_id)?.sdk_session_id);
        if (normalizeSessionWorkerId(row.owner_sdk_session_id) !== requesterSessionId
          || (rowSession !== requesterSessionId && String(row.conversation_id) !== String(requesterConversationForSettle || ''))) {
          settleFailedSkipped.push(id);
          continue;
        }
        const attemptId = String(entry?.attemptId || '').trim() || null;
        if (attemptId && String(row.attempt_id || '') !== attemptId) {
          settleFailedHandled.push(id);
          continue;
        }
        failConsumedQueueRow(row, {
          reason: 'settle-failed',
          terminalError: entry?.terminalError && typeof entry.terminalError === 'object' ? entry.terminalError : null,
          attemptId,
        });
        settleFailedHandled.push(id);
      }
      if (activeQueueMessageIds.length) {
        const now = new Date().toISOString();
        const leaseExpiresAt = addMsToIso(now, SESSION_WORKER_OWNER_LEASE_MS);
        for (const id of activeQueueMessageIds) {
          refreshProcessingLeaseForOwnedMessage.run(leaseExpiresAt, now, id, requesterSessionId);
          // The worker has the turn: if it was running when the relay
          // started, the restart did not cut it off.
          noteRestartTurnOutcome({ id }, 'claimed');
        }
        recoverOwnedProcessingRowsForSession(requesterSessionId, {
          excludeMessageIds: activeQueueMessageIds,
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
    res.json({
      ok: true,
      pendingCount,
      ...(settleFailedHandled.length ? { settleFailedHandled } : {}),
      ...(settleFailedSkipped.length ? { settleFailedSkipped } : {}),
      ...(resyncBackgroundTasks ? { resyncBackgroundTasks: true } : {}),
    });
  });

  // POST /api/queue-consumed — the Claude worker marks rows whose prompt the
  // CLI has taken when no response carries the mark (a turn the user stopped,
  // a turn handed off mid-reply). Consumed rows are at-most-once: recovery
  // fails them terminally instead of re-running them.
  app.post('/api/queue-consumed', auth, (req, res) => {
    touchCli();
    const requesterSessionId = normalizeSessionWorkerId(readBridgeIdentity(req)?.sessionId);
    if (!requesterSessionId) return res.status(403).json({ error: 'Worker identity required' });
    const conversationId = String(req.body?.conversationId || '').trim();
    const entries = normalizeConsumedSteerEntries(req.body?.entries);
    if (!conversationId || !entries.length) return res.status(400).json({ error: 'Missing conversationId or entries' });
    // `consumed: false` un-marks a steer the CLI then replayed as a turn of
    // its own. Either way only the owning worker, on the row's current
    // attempt, may touch the mark.
    const statement = req.body?.consumed === false ? stmts.clearQueueConsumed : stmts.markQueueConsumed;
    const at = new Date().toISOString();
    let changed = 0;
    for (const entry of entries) {
      changed += Number(statement?.run({
        at,
        id: entry.id,
        conversationId,
        owner: requesterSessionId,
        attemptId: entry.attemptId,
      })?.changes || 0);
    }
    res.json({ ok: true, changed });
  });

  // POST /api/queue-cancelled — the owning worker reports that a pushed but
  // still unconsumed row was removed from its runtime (an un-steer the user
  // asked for through cancel-queued-turn → `cancel_pushed_message`). The row
  // ends exactly like a pending cancel: deleted, its open cards cancelled, no
  // assistant row, `message_status: cancelled`. Fenced like /api/queue-consumed:
  // only the row's owner, on the row's current attempt, may settle it.
  app.post('/api/queue-cancelled', auth, (req, res) => {
    touchCli();
    const requesterSessionId = normalizeSessionWorkerId(readBridgeIdentity(req)?.sessionId);
    if (!requesterSessionId) return res.status(403).json({ error: 'Worker identity required' });
    const conversationId = String(req.body?.conversationId || '').trim();
    const messageId = String(req.body?.messageId || '').trim();
    const attemptId = String(req.body?.attemptId || '').trim() || null;
    if (!conversationId || !messageId) return res.status(400).json({ error: 'Missing conversationId or messageId' });

    const row = stmts.findQById.get(messageId) || null;
    if (!row) return res.status(404).json({ error: 'not-found' });
    if (String(row.conversation_id || '').trim() !== conversationId) {
      return res.status(409).json({ error: 'conversation-mismatch' });
    }
    const status = String(row.status || '').trim().toLowerCase();
    if (status !== 'processing') return res.status(409).json({ error: 'not-processing', status });
    if (normalizeSessionWorkerId(row.owner_sdk_session_id) !== requesterSessionId) {
      return res.status(409).json({ error: 'not-owned' });
    }
    const rowAttemptId = String(row.attempt_id || '').trim() || null;
    if (attemptId && rowAttemptId && attemptId !== rowAttemptId) {
      staleAttemptLog.note({ messageId, attemptId, currentAttemptId: rowAttemptId, route: 'queue-cancelled', status: row.status });
      return res.status(409).json({ error: 'stale_attempt' });
    }

    // Same transaction shape as the pending cancel above: delete first, so the
    // question cancel sees no current attempt and flips every pending card of
    // the row (with foreign keys on, the cascade has already taken them).
    const cancelPushedTurn = db.transaction(() => {
      stmts.deleteQueueById.run(messageId);
      cancelPendingRelayQuestionsForMessage(messageId);
    });
    cancelPushedTurn();
    // A processing row may carry open Stop controls (the live-turn picker can
    // land on it before it has output); they fail like on a requeue so no
    // caller waits on a row that no longer exists.
    settleRelayAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-cancelled' });
    settleRelaySubagentAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-cancelled' });

    io.emit('message_status', { messageId, conversationId, status: 'cancelled' });
    console.log(`[${ts()}] UNSTEERED ${messageId.slice(0, 8)} conv=${conversationId.slice(0, 8)}`);
    res.json({ ok: true, cancelled: true });
  });

  // POST /api/grok-native-session — Grok worker persists the ACP session id so
  // later turns can session/load it across worker restarts.
  app.post('/api/grok-native-session', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    const grokNativeSessionId = String(req.body?.grokNativeSessionId || '').trim();
    if (!conversationId || !grokNativeSessionId) {
      return res.status(400).json({ error: 'Missing conversationId or grokNativeSessionId' });
    }
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId);
    if (!runtimeSession) {
      return res.status(404).json({ error: 'Runtime session not found for conversation' });
    }
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'grok') {
      return res.status(409).json({ error: 'Conversation is not bound to the Grok provider' });
    }
    if (typeof stmts.updateRuntimeSessionGrokNativeSessionId?.run !== 'function') {
      return res.status(500).json({ error: 'Grok native session storage is unavailable' });
    }
    stmts.updateRuntimeSessionGrokNativeSessionId.run(
      grokNativeSessionId,
      new Date().toISOString(),
      conversationId,
    );
    res.json({ ok: true });
  });

  // POST /api/claude-native-session — Claude worker persists the native Agent
  // SDK session id so later turns can resume it across worker restarts. A
  // DeepSeek worker also reports each CLI start (`cliStartedAt`, ms), which
  // the relay records so deleting the conversation finds every CLI's shell
  // snapshot.
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
    // The DeepSeek worker runs the same CLI (against DeepSeek) and resumes
    // its sessions the same way; the Claude API worker is the Claude one on
    // an API key.
    const nativeSessionProvider = String(runtimeSession.provider_type || 'github').trim().toLowerCase();
    if (nativeSessionProvider !== 'claude' && nativeSessionProvider !== 'deepseek' && nativeSessionProvider !== 'claude-api') {
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
    const cliStartedAt = Number(req.body?.cliStartedAt);
    if (nativeSessionProvider === 'deepseek' && Number.isFinite(cliStartedAt) && cliStartedAt > 0 && cliStartedAt <= Date.now() + 60_000) {
      recordClaudeCliStart({ configRoot: deepseekClaudeConfigDir, nativeSessionId: claudeNativeSessionId, startedAt: cliStartedAt });
    }
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
    // The Claude Cloud worker reports the same shape (the cloud session's
    // context and token usage), and so do the DeepSeek and Claude API ones
    // (the same CLI).
    const contextUsageProvider = String(runtimeSession.provider_type || 'github').trim().toLowerCase();
    if (!['claude', 'claude-cloud', 'deepseek', 'claude-api'].includes(contextUsageProvider)) {
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

  // POST /api/grok-plan-usage — Grok worker reports per-prompt tokens/cost from
  // the session/prompt result `_meta`. There is no ACP plan-quota API; the
  // relay stores the last turn and optionally accumulates spend into a local
  // monthly cycle when the user sets an allowance.
  app.post('/api/grok-plan-usage', auth, (req, res) => {
    touchCli();
    if (!planUsageService) return res.status(500).json({ error: 'Plan usage storage is unavailable' });
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId);
    if (!runtimeSession) {
      return res.status(404).json({ error: 'Runtime session not found for conversation' });
    }
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'grok') {
      return res.status(409).json({ error: 'Conversation is not bound to the Grok provider' });
    }
    const usage = normalizeGrokTurnUsage({
      ...(req.body?.usage && typeof req.body.usage === 'object' ? req.body.usage : {}),
      model: req.body?.model,
      modelId: req.body?.model || req.body?.usage?.modelId,
      capturedAt: req.body?.capturedAt,
    });
    if (!usage) return res.status(400).json({ error: 'Missing usable usage payload' });
    const allowances = getGrokPlanAllowanceSettings();
    const applied = planUsageService.recordGrokUsageReport(usage, {
      resetDay: allowances.resetDay,
    });
    if (!applied) return res.status(400).json({ error: 'Missing usable usage metrics' });
    res.json({ ok: true, cycle: applied.cycle.key });
  });

  // POST /api/deepseek-plan-usage — DeepSeek worker reports, after a turn,
  // the CLI's running token totals per model (cache hit, cache miss, output)
  // for its Claude Code session, with the time and the id of the CLI
  // process (`runId`). The relay books what they add to the totals last
  // reported for that session (a resumed CLI starts from its session's
  // earlier totals), with the estimated cost at the price of that time
  // (shared/deepseek-pricing.mjs). Totals below the checkpoint under the
  // checkpoint's run id are a stale report (retried or out of order) and
  // book nothing; under another run id, or without one, they are a CLI
  // counting from zero again, booked in full. The web searches and fetches
  // come as `requests`: with a run id the process's running counts, booked
  // like the tokens; without one the turn's counts, booked as they are.
  // Priced from 2026-10-31 16:00 UTC.
  app.post('/api/deepseek-plan-usage', auth, (req, res) => {
    touchCli();
    if (!planUsageService?.recordDeepSeekUsageReport) {
      return res.status(500).json({ error: 'Plan usage storage is unavailable' });
    }
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId);
    if (!runtimeSession) {
      return res.status(404).json({ error: 'Runtime session not found for conversation' });
    }
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'deepseek') {
      return res.status(409).json({ error: 'Conversation is not bound to the DeepSeek provider' });
    }
    const parsed = normalizeDeepSeekUsageReport(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const booked = planUsageService.recordDeepSeekUsageReport({ ...parsed.report, conversationId });
    if (!booked) return res.status(400).json({ error: 'Missing usable usage metrics' });
    res.json({ ok: true, at: booked.at, models: booked.models.map((entry) => entry.model) });
  });

  // POST /api/claude-api-usage — both Claude workers (the subscription's and
  // the Claude API one) report, after every turn, the CLI process's own
  // totals per model with Claude Code's cost estimate (`runCounts`) and the
  // CLI's session totals (`sessionTotals`). The relay books what turns on
  // the key cost (claude-api-usage-service.mjs); a subscription report only
  // keeps the session's mark, against which a resumed run's first result is
  // measured. What a report ran on is the posting worker's registered kind;
  // a body that says otherwise is logged as a fence failure.
  app.post('/api/claude-api-usage', auth, (req, res) => {
    touchCli();
    if (!claudeApiUsageService) return res.status(501).json({ error: 'Claude API usage storage is unavailable' });
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const runtimeSession = stmts.getRuntimeSessionByConversation.get(conversationId);
    if (!runtimeSession) return res.status(404).json({ error: 'Runtime session not found for conversation' });
    if (!normalizeClaudeBilling(runtimeSession.provider_type)) {
      return res.status(409).json({ error: 'Conversation is not a Claude conversation' });
    }
    const parsed = normalizeClaudeApiUsageReport(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const requesterSid = normalizeSessionWorkerId(readBridgeIdentity(req)?.sessionId);
    const registeredKind = normalizeClaudeBilling(requesterSid ? sessionWorkerRegistry?.getWorker?.(requesterSid)?.kind : '');
    const statedKind = normalizeClaudeBilling(parsed.report.billing);
    if (registeredKind && statedKind && registeredKind !== statedKind) {
      console.warn(`[${ts()}] BILLING FENCE FAILURE usage conv=${conversationId.slice(0, 8)} stated=${statedKind} registered=${registeredKind} — booked as the registered kind`);
    }
    const billing = registeredKind || statedKind;
    if (!billing) return res.status(400).json({ error: 'Missing billing' });
    const booked = claudeApiUsageService.recordReport({ conversationId, billing, report: parsed.report });
    if (!booked) return res.status(400).json({ error: 'Missing usable usage metrics' });
    if (booked.booked.length) {
      try { checkClaudeApiCap('usage'); } catch {}
    }
    res.json({ ok: true, billing: booked.billing, basis: booked.basis, models: booked.booked.map((entry) => entry.model) });
  });

  // POST /api/claude-plan-usage — Claude worker reports the session's
  // structured /usage data (plan rate-limit windows + session cost totals).
  //
  // Read from the live query transport at the end of a turn; the relay never
  // opens an extra turn to refresh it, so the newest reading is whatever the
  // last real turn produced.
  app.post('/api/claude-plan-usage', auth, (req, res) => {
    touchCli();
    if (!planUsageService) return res.status(500).json({ error: 'Plan usage storage is unavailable' });
    // Same binding validation as every other provider usage route: only a
    // Claude-bound conversation's worker may write the Claude card. The
    // snapshot itself is global, so a misrouted poster would corrupt it for
    // everyone.
    // A Claude Cloud worker posts here too; its report is kept under its own
    // snapshot key, so the Claude card stays what the Claude workers wrote.
    const conversationId = String(req.body?.conversationId || '').trim();
    let snapshotProvider = 'claude';
    if (conversationId) {
      const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
      const boundProvider = String(runtimeSession?.provider_type || 'github').trim().toLowerCase();
      if (runtimeSession && boundProvider !== 'claude' && boundProvider !== 'claude-cloud') {
        return res.status(409).json({ error: 'Conversation is not bound to the Claude provider' });
      }
      if (runtimeSession && boundProvider === 'claude-cloud') snapshotProvider = 'claude-cloud';
    }
    const usage = normalizeClaudePlanUsage(req.body?.usage)
      || claudePlanUsageFromResult({
        modelUsage: req.body?.modelUsage,
        totalCostUsd: req.body?.totalCostUsd,
      });
    if (!usage) return res.status(400).json({ error: 'Missing usable usage payload' });
    planUsageService.saveSnapshot(snapshotProvider, usage, {
      source: 'worker',
      error: String(req.body?.error || '').trim() || null,
    });
    res.json({ ok: true });
  });

  // POST /api/claude-usage-limit — the Claude worker forwards what the CLI
  // reported about the subscription's usage limit (a `rate_limit_event`): the
  // clients warn before the limit and show the reset once it is reached.
  app.post('/api/claude-usage-limit', auth, (req, res) => {
    touchCli();
    if (!usageLimitPauseService) return res.status(501).json({ error: 'Usage limit handling is unavailable' });
    // The report is the account's, so only a Claude-bound conversation's
    // worker may write it (same validation as the plan usage card); a Claude
    // Cloud chat runs on the same account and reports the same limit.
    const conversationId = String(req.body?.conversationId || '').trim();
    if (conversationId) {
      const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
      const boundProvider = String(runtimeSession?.provider_type || 'github').trim().toLowerCase();
      if (runtimeSession && boundProvider !== 'claude' && boundProvider !== 'claude-cloud') {
        return res.status(409).json({ error: 'Conversation is not bound to the Claude provider' });
      }
    }
    const state = usageLimitPauseService.recordReport({ report: req.body?.report });
    res.json({ ok: true, state });
  });

  // POST /api/copilot-plan-usage — the Copilot SDK worker reports the turn's
  // billing/token detail.
  //
  // The Copilot card's meters are fetched relay-side from the account-level
  // quota API and already cover SDK sessions, so this is strictly additive: it
  // carries the two things no relay-side source can see — `totalNanoAiu` (real
  // spend; the event's `cost` is the premium multiplier, not money) and
  // `quotaSnapshots.cfi_overage` (overage, which `account.getQuota()`'s cached
  // read never shows).
  app.post('/api/copilot-plan-usage', auth, (req, res) => {
    touchCli();
    if (!planUsageService) return res.status(500).json({ error: 'Plan usage storage is unavailable' });
    // Stricter than the Claude route's binding check on purpose, and it has to
    // be. `github` is the DEFAULT provider binding, so a row-shaped fallback
    // ("no runtime session? assume github") would accept ANY fabricated
    // conversationId from any authenticated poster and let it overwrite a
    // snapshot the whole relay reads. The session must exist AND be bound —
    // the same order the Grok route uses. (A BYOK `openai` conversation spends
    // the user's own key rather than Copilot quota, so its numbers do not
    // belong on the Copilot plan card either; the worker declines to post them,
    // and the binding check is the backstop.)
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
    if (!runtimeSession) {
      return res.status(404).json({ error: 'Runtime session not found for conversation' });
    }
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'github') {
      return res.status(409).json({ error: 'Conversation is not bound to the Copilot provider' });
    }
    const usage = normalizeCopilotWorkerUsage(req.body);
    if (!usage) return res.status(400).json({ error: 'Missing usable usage payload' });
    planUsageService.saveSnapshot('copilot-sdk', usage, {
      source: 'worker',
      error: String(req.body?.error || '').trim() || null,
    });
    res.json({ ok: true });
  });

  // POST /api/cursor-plan-usage — Cursor worker reports the agent's cumulative
  // billed usage. The relay diffs it against the stored checkpoint and books
  // the increase into the current billing cycle under the pool implied by the
  // model that ran the turn.
  app.post('/api/cursor-plan-usage', auth, (req, res) => {
    touchCli();
    if (!planUsageService) return res.status(500).json({ error: 'Plan usage storage is unavailable' });
    const agentId = String(req.body?.agentId || '').trim();
    if (!agentId) return res.status(400).json({ error: 'Missing agentId' });
    // The worker sends its conversation id; require the binding like the
    // sibling routes so spend cannot be booked from a misrouted poster.
    const conversationId = String(req.body?.conversationId || '').trim();
    if (conversationId) {
      const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
      const boundProvider = String(runtimeSession?.provider_type || 'github').trim().toLowerCase();
      if (runtimeSession && boundProvider !== 'cursor') {
        return res.status(409).json({ error: 'Conversation is not bound to the Cursor provider' });
      }
    }
    const allowances = getCursorPlanAllowanceSettings();
    const applied = planUsageService.recordCursorUsageReport(
      {
        agentId,
        model: req.body?.model,
        agentCreated: req.body?.agentCreated === true,
        rawCostCents: req.body?.rawCostCents,
        chargedCents: req.body?.chargedCents,
        inputTokens: req.body?.inputTokens,
        outputTokens: req.body?.outputTokens,
        cacheReadTokens: req.body?.cacheReadTokens,
        cacheWriteTokens: req.body?.cacheWriteTokens,
        totalTokens: req.body?.totalTokens,
        runCount: req.body?.runCount,
        capturedAt: req.body?.capturedAt,
      },
      { resetDay: allowances.resetDay },
    );
    if (!applied) return res.status(400).json({ error: 'Missing usable usage metrics' });
    res.json({ ok: true, pool: applied.pool, cycle: applied.cycle.key, changed: applied.changed });
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

  // POST /api/relay-session-link — the Copilot relay reports which SDK session
  // it created to execute a conversation's turns. The startup import sweep
  // consults these links so relay execution vehicles are never surfaced as
  // stand-alone conversations ("shadow" duplicates in the conversation list).
  app.post('/api/relay-session-link', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    const sdkSessionId = String(req.body?.sdkSessionId || '').trim();
    if (!conversationId || !sdkSessionId) {
      return res.status(400).json({ error: 'Missing conversationId or sdkSessionId' });
    }
    if (typeof stmts.upsertRelaySessionLink?.run !== 'function') {
      return res.status(500).json({ error: 'Relay session link storage is unavailable' });
    }
    stmts.upsertRelaySessionLink.run(sdkSessionId, conversationId, new Date().toISOString());
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

  // POST /api/grok-context-usage — Grok worker reports the session's
  // context-window breakdown after a turn (per-prompt tokens from the ACP
  // result `_meta`). Grok sessions have no Copilot events.jsonl to tail, so
  // this is what feeds the composer indicator and the context-usage modal.
  app.post('/api/grok-context-usage', auth, (req, res) => {
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
    if (String(runtimeSession.provider_type || 'github').trim().toLowerCase() !== 'grok') {
      return res.status(409).json({ error: 'Conversation is not bound to the Grok provider' });
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
  // The kind a poller of GET /api/pending is fenced as: the one its worker
  // stated, else none, as on the socket. A worker of unknown kind gets the
  // rows of a chat that never switched, and none of a chat that has
  // (kind-unknown): such a chat waits for a worker that says its kind.
  function httpPendingWorkerKind(requesterSessionId) {
    const stated = requesterSessionId ? sessionWorkerRegistry?.getWorker?.(requesterSessionId)?.kind : null;
    return normalizeWorkerKind(stated) || null;
  }

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
    // A queued shutdown or restart waits for the processing turns only: a
    // pending row handed out now would start a turn that postpones it again.
    if (isRelayShutdownQueued(runtimeState)) return res.json(relayShutdownGateReply(runtimeState));
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
    if (runtimeState.cloudflaredTunnelState?.blocking) {
      return res.json({
        message: null,
        paused: true,
        reason: 'cloudflared_tunnel_required',
        cloudflaredTunnel: {
          mode: runtimeState.cloudflaredTunnelState?.mode ?? null,
          required: runtimeState.cloudflaredTunnelState?.required ?? false,
          connected: runtimeState.cloudflaredTunnelState?.connected ?? false,
          lastError: runtimeState.cloudflaredTunnelState?.lastError ?? null,
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
        // No Claude worker polls here; one that does is fenced as on the
        // socket: by the kind it stated, the key's claim check, and a fenced
        // row asks for the swap or fails closed as there.
        workerKind: httpPendingWorkerKind(requesterSessionId),
        claudeApiClaimCheck,
        onBillingFence: onClaudeBillingFence,
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
                workerKind: httpPendingWorkerKind(requesterSessionId),
                claudeApiClaimCheck,
                onBillingFence: onClaudeBillingFence,
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
        getCursorProviderSettings,
        getClaudeCloudProviderSettings,
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

  // Called by the relay's own worker on this machine; nothing that came in
  // through a proxy or the tunnel may start a provider image request.
  app.post('/api/image-operations/:operationId/execute', auth, async (req, res) => {
    if (!isTrulyLocalRequest(req)) {
      return res.status(403).json({ error: 'Image operation execution is reachable from this machine only' });
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
          // `terminalError` is the field /api/response reads; under any other
          // name the failure was refused as an empty reply and the row stayed
          // processing until the relay recovered and re-ran it.
          terminalError: {
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
            terminalError: failure,
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
          allowedBlobRootPaths: uploadReadDirs.slice(1),
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

  // Responses that are settle markers, not replies: stamped with their kind,
  // and no "turn completed" push. The last one is not a steer's: it closes a
  // message whose answer was published on a continuation row, and that reply
  // already sent the push.
  const SETTLED_STEER_KINDS = new Set(['folded', 'stopped', ANSWERED_ELSEWHERE_KIND]);

  // POST /api/response — CLI submits response
  app.post('/api/response', auth, async (req, res) => {
    touchCli();
    const { messageId, conversationId, text, model, mode, generatedImages: rawGeneratedImages } = req.body;
    // A steering absorption (Claude worker): this reply ends where a message
    // pushed mid-turn was picked up, and the turn continues on that message's
    // own row. Stamped as kind='absorbed' so the transcript renders the two
    // turns as one merged flow.
    // A worker not yet respawned onto 0.9.3 still stamps its fold stubs
    // absorbed:true; the stub text identifies them, and 'absorbed' on a fold
    // would mis-merge the next ordinary message.
    const staleFoldStub = req.body.absorbed === true && String(text || '').trim() === STEER_FOLDED_TEXT;
    const absorbed = req.body.absorbed === true && !staleFoldStub;
    // The other settle stubs of a consumed steer (never re-run — the CLI saw
    // it): 'folded' was answered by the turn it was steered into and renders
    // as a marker on its own message; 'stopped' was steered into a turn the
    // user then stopped, so it went unanswered and the client offers Resend.
    const requestedKind = staleFoldStub ? 'folded' : String(req.body.kind || '').trim();
    const settledKind = absorbed
      ? 'absorbed'
      : (SETTLED_STEER_KINDS.has(requestedKind) ? requestedKind : null);
    // Steers pushed into the turn this response finishes and not yet settled:
    // the CLI has taken their prompts, so they are marked consumed together
    // with this commit and no recovery path may ever re-run them.
    const consumedSteerEntries = normalizeConsumedSteerEntries(req.body.consumedSteerIds)
      .filter((entry) => entry.id !== String(messageId || '').trim());
    // Runs inside the response's fenced write (both the success and the
    // terminal-failure transaction), so a superseded attempt's late publish
    // can never mark rows; the steers must share the finishing row's owner.
    const markSteersConsumed = (conversationIdForMark, atIso) => {
      const owner = normalizeSessionWorkerId(q?.owner_sdk_session_id);
      for (const entry of consumedSteerEntries) {
        stmts.markQueueConsumed?.run({
          at: atIso,
          id: entry.id,
          conversationId: conversationIdForMark,
          owner,
          attemptId: entry.attemptId,
        });
      }
    };
    let trimmedText = String(text || '').trim();
    let terminalFailure = resolveTerminalFailurePayload(req.body, {
      fallbackText: trimmedText,
      inferFromText: !String(req.body?.attemptId || '').trim(),
    });
    // Final digests of background workflows that settled during this turn —
    // the transcript's "Finished background task" cards. Same structural
    // sanitizer as the live panel rows; junk entries drop silently (this
    // field must never fail a response), and the array caps at 5.
    const workflowRuns = (Array.isArray(req.body.workflowRuns) ? req.body.workflowRuns : [])
      .map((entry) => sanitizeWorkflowProgress(entry))
      .filter(Boolean)
      .slice(0, 5);
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

    // Attempt fencing: a writer that names its processing attempt may only
    // settle the row while that attempt is still the row's current one. A
    // mismatch means the row was requeued (and possibly re-dequeued) after
    // this writer started — its work is superseded, not mergeable. Writers
    // that send no attemptId (the extension engine, mid-rollout workers) keep
    // the legacy conditional semantics.
    const claimedAttemptId = String(req.body.attemptId || '').trim() || null;
    if (claimedAttemptId && q && String(q.attempt_id || '') !== claimedAttemptId) {
      staleAttemptLog.note({ messageId, attemptId: claimedAttemptId, currentAttemptId: q.attempt_id, route: 'response', status: q.status });
      return res.status(409).json({ error: 'stale_attempt', currentStatus: q.status });
    }
    if (!claimedAttemptId && q && q.status === 'processing') {
      console.log(`[${ts()}] FENCE     ${messageId?.slice(0,8)} legacy unfenced response write`);
    }

    if (q && q.status === 'done') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_done`);
      return res.json({ ok: true, ignored: 'already_done' });
    }
    if (q && q.status === 'failed') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_failed`);
      return res.json({ ok: true, ignored: 'already_failed' });
    }

    const relayMode = normalizeRelayMode(mode || q?.relay_mode) || DEFAULT_RELAY_MODE;
    // A Claude turn refused at the usage limit is paused, not failed: its row
    // ends with a note like any answered one, and a follow-up is queued that
    // is held until the reset (usage-limit-pause-service).
    const usageLimitPause = terminalFailure && q && isUsageLimitTerminalError(req.body?.terminalError)
      ? (usageLimitPauseService?.planPause?.({
        terminalError: req.body.terminalError,
        conversationId: targetConversationId,
        // What the refused turn ran on (its row's billing), and the chat's
        // billing of now: a chat switched to the API key meanwhile carries on
        // there instead of waiting for the subscription's reset.
        providerType: normalizeClaudeBilling(q?.provider)
          || stmts.getRuntimeSessionByConversation?.get(targetConversationId)?.provider_type,
        chatProviderType: stmts.getRuntimeSessionByConversation?.get(targetConversationId)?.provider_type,
        queueRow: q,
        partialText: req.body?.partialText,
      }) || null)
      : null;
    if (usageLimitPause) {
      trimmedText = usageLimitPause.noteText;
      terminalFailure = null;
    }
    if (terminalFailure) {
      // Terminal failures carry provenance too: the original hijack incident
      // presented exactly as stolen turns dying on 402 through this path.
      const terminalConversationProvider = String(
        stmts.getRuntimeSessionByConversation?.get(targetConversationId)?.provider_type || '',
      ).trim().toLowerCase() || 'github';
      const terminalExecutedProvider = resolveExecutedProviderForResponse({
        stmts,
        responseBridgeIdentity,
        conversationProvider: terminalConversationProvider,
        serverExecutedOperation: !!q?.image_operation_id,
      });
      if (terminalExecutedProvider === 'unknown') {
        console.warn(`[${ts()}] PROVIDER UNRESOLVED ${messageId?.slice(0, 8)} conv=${targetConversationId?.slice(0, 8)} bound=${terminalConversationProvider} responder=${normalizeSessionWorkerId(responseBridgeIdentity?.sessionId)?.slice(0, 8) || 'none'} — terminal failure from a responder identity matching no runtime session`);
      } else if (terminalExecutedProvider !== terminalConversationProvider) {
        console.warn(`[${ts()}] PROVIDER MISMATCH ${messageId?.slice(0, 8)} conv=${targetConversationId?.slice(0, 8)} bound=${terminalConversationProvider} executed=${terminalExecutedProvider} — terminal failure answered by the wrong provider`);
      }
      const terminalCrossConversation = resolveResponderConversationMismatch({
        stmts,
        responseBridgeIdentity,
        targetConversationId,
      });
      if (terminalCrossConversation.crossConversation) {
        console.warn(`[${ts()}] CONVERSATION MISMATCH ${messageId?.slice(0, 8)} conv=${targetConversationId?.slice(0, 8)} responderConv=${terminalCrossConversation.responderConversationId?.slice(0, 8)} — terminal failure posted by another conversation's worker`);
      }
      // A failure read from the text alone keeps that text, whole: it is the
      // note already, and should the reading be wrong, nothing of a reply is
      // lost.
      const failureText = terminalFailure.fromText
        ? trimmedText
        : buildTerminalFailureTextForChat(terminalFailure, trimmedText);
      // What the turn had written before it failed stays readable: the note
      // goes below it instead of replacing it.
      const partialText = String(req.body.partialText || '').trim();
      const failed = failQueueMessage({
        queueRow: q,
        messageId,
        conversationId: targetConversationId,
        relayMode,
        model: model || q?.model || null,
        responseText: partialText ? `${partialText}\n\n${failureText}` : failureText,
        executedProvider: terminalExecutedProvider,
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
        attemptId: claimedAttemptId,
        // An errored turn still took the steers pushed into it.
        withinTransaction: (atIso) => markSteersConsumed(targetConversationId, atIso),
      });
      if (!failed) {
        const currentRow = stmts.findQById?.get(messageId) || null;
        if (claimedAttemptId && currentRow && String(currentRow.attempt_id || '') !== claimedAttemptId) {
          staleAttemptLog.note({ messageId, attemptId: claimedAttemptId, currentAttemptId: currentRow.attempt_id, route: 'response-terminal', status: currentRow.status });
          return res.status(409).json({ error: 'stale_attempt', currentStatus: String(currentRow.status || 'unknown') });
        }
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
    const conversationProvider = String(
      stmts.getRuntimeSessionByConversation?.get(targetConversationId)?.provider_type || '',
    ).trim().toLowerCase() || 'github';
    const responderKind = sessionWorkerRegistry?.getWorker?.(normalizeSessionWorkerId(responseBridgeIdentity?.sessionId))?.kind || null;
    const executedProvider = resolveExecutedProviderForResponse({
      stmts,
      responseBridgeIdentity,
      conversationProvider,
      // Image operations are executed by this server against the conversation's
      // own provider API, then finalized through an identity-less self-post.
      serverExecutedOperation: !!q?.image_operation_id,
      responderKind,
    });
    // A Claude chat's row ran on a worker of another billing than it was
    // stamped with: the delivery fence failed. What ran is recorded.
    const stampedBilling = normalizeClaudeBilling(q?.provider);
    const ranBilling = normalizeClaudeBilling(executedProvider);
    // A claimed turn on the key answered (it passed the claim check): the
    // next refusal of a self-started turn there is a new episode, with its
    // own note. A continuation that slipped through before its stop is not.
    if (ranBilling === 'claude-api' && String(q?.kind || '') !== 'continuation') claudeApiStopLedger.clear(targetConversationId);
    if (stampedBilling && ranBilling && stampedBilling !== ranBilling) {
      console.warn(`[${ts()}] BILLING FENCE FAILURE ${messageId?.slice(0, 8)} conv=${targetConversationId?.slice(0, 8)} stamped=${stampedBilling} ran=${ranBilling} — a Claude turn ran on the other billing`);
    }
    // A Claude chat that switched billing mid-turn finished that turn on the
    // billing it started with: not a mismatch.
    const switchedClaudeTurn = ranBilling && normalizeClaudeBilling(conversationProvider) && (!stampedBilling || stampedBilling === ranBilling);
    if (executedProvider === 'unknown') {
      // An identity that names no runtime session is itself an anomaly (a stale
      // or forged header), just not evidence of cross-provider execution. Say so
      // rather than staying silent.
      console.warn(`[${ts()}] PROVIDER UNRESOLVED ${messageId?.slice(0, 8)} conv=${targetConversationId?.slice(0, 8)} bound=${conversationProvider} responder=${normalizeSessionWorkerId(responseBridgeIdentity?.sessionId)?.slice(0, 8) || 'none'} — responder identity matches no runtime session`);
    } else if (executedProvider !== conversationProvider && !switchedClaudeTurn) {
      console.warn(`[${ts()}] PROVIDER MISMATCH ${messageId?.slice(0, 8)} conv=${targetConversationId?.slice(0, 8)} bound=${conversationProvider} executed=${executedProvider} — turn answered by the wrong provider`);
    }
    const responderConversationCheck = resolveResponderConversationMismatch({
      stmts,
      responseBridgeIdentity,
      targetConversationId,
    });
    if (responderConversationCheck.crossConversation) {
      console.warn(`[${ts()}] CONVERSATION MISMATCH ${messageId?.slice(0, 8)} conv=${targetConversationId?.slice(0, 8)} responderConv=${responderConversationCheck.responderConversationId?.slice(0, 8)} — turn answered by another conversation's worker`);
    }
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
      const result = claimedAttemptId
        ? stmts.setDoneFenced.run(resolvedText, messageId, claimedAttemptId)
        : stmts.setDone.run(resolvedText, messageId);
      if (result.changes === 0) return false;
      markSteersConsumed(targetConversationId, now);
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
      stmts.setMessageSourceId?.run(messageId, responseId);
      if (String(q?.kind || '') === 'continuation') {
        stmts.setMessageKind?.run('continuation', responseId);
      } else if (settledKind) {
        stmts.setMessageKind?.run(settledKind, responseId);
      }
      // The workflow cards persist atomically with the assistant message they
      // annotate — keyed directly on the response id (see workflow_runs DDL).
      for (const [runIndex, digest] of workflowRuns.entries()) {
        stmts.insertWorkflowRun?.run(
          `wfr_${uuidv4()}`,
          responseId,
          targetConversationId,
          runIndex,
          JSON.stringify(digest),
          now,
        );
      }
      stmts.setMessageExecutedProvider?.run(executedProvider, responseId);
      stmts.linkActivityToResponse.run(responseId, messageId);
      stmts.linkStreamEventsToResponse?.run(responseId, messageId);
      stmts.linkThoughtsToResponse?.run(responseId, messageId);
      stmts.linkPreviewCardsToResponse?.run(responseId, messageId);
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
      if (claimedAttemptId && currentRow && String(currentRow.attempt_id || '') !== claimedAttemptId) {
        staleAttemptLog.note({ messageId, attemptId: claimedAttemptId, currentAttemptId: currentRow.attempt_id, route: 'response-finalize', status: currentStatus });
        return res.status(409).json({ error: 'stale_attempt', currentStatus });
      }
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
        // In the message too, as on reload: a stopped marker's Resend finds
        // its original through it.
        sourceMessageId: messageId,
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
        executedProvider,
        kind: String(q?.kind || '') === 'continuation'
          ? 'continuation'
          : (settledKind || undefined),
        // Live-appended messages must show their workflow cards without a
        // reload; conversation reloads serve the same digests from the DB.
        workflowRuns: workflowRuns.length ? workflowRuns : undefined,
      },
    });
    io.emit('message_status', { messageId, conversationId: targetConversationId, status: 'done' });
    if (usageLimitPause) {
      try {
        usageLimitPauseService.schedulePause(usageLimitPause, { queueRow: q });
      } catch (error) {
        console.warn(`[${ts()}] USAGE LIMIT ${messageId?.slice(0, 8)} conv=${targetConversationId?.slice(0, 8)} the follow-up could not be queued: ${error?.message || error}`);
      }
    }
    // An absorbed row is not a finished turn — the reply continues on the
    // steered message's row, whose own completion sends the one notification.
    // A stopped steer has no reply at all, and a message answered on a
    // continuation row was notified by that row.
    if (!settledKind) {
      void pushDispatchService?.notifyTurnComplete?.({
        conversationId: targetConversationId,
        messageId: responseId,
        // The push service skips turns another relay's agent started.
        sourceMessageId: messageId,
        text: resolvedText,
      });
      // A turn paused at the usage limit did not end: it is an error event
      // for whoever watches the session.
      try {
        if (usageLimitPause) {
          relayEventService?.noteError?.({
            conversationId: targetConversationId,
            kind: 'usage_limit',
            message: usageLimitPause.noteText,
            queueMessageId: messageId,
          });
        } else {
          relayEventService?.noteTurnEnd?.({
            conversationId: targetConversationId,
            queueMessageId: messageId,
            replyText: resolvedText,
            status: 'done',
          });
        }
      } catch {}
    }
    cancelPendingRelayQuestionsForMessage(messageId);
    res.json({ ok: true });
  });

  // Providers whose workers turn runtime-initiated activity into continuation
  // rows: the Claude worker (background tasks/agents) and the Copilot SDK
  // worker (detached background shells) serving both Copilot-CLI providers.
  // A Claude Cloud session can take a turn of its own too: one the agent
  // starts when its background work reports back, or one started on
  // claude.ai; the cloud worker follows it and registers it here. The Claude
  // API worker is the Claude one on an API key.
  const CONTINUATION_PROVIDER_TYPES = new Set(['claude', 'github', 'openai', 'claude-cloud', 'claude-api']);

  // POST /api/continuation-turn — a session worker's CLI started a turn on its
  // own (a background task's notification). The synthetic queue row gives that
  // turn the full relay surface — stream, thoughts, activity, questions, and a
  // response of its own — without any user message: born 'processing', owned
  // by the session, and excluded from every delivery/recovery path.
  app.post('/api/continuation-turn', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const conversation = stmts.getConvAnyStatus?.get?.(conversationId) || null;
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
    // Fail closed on an unbound conversation: without a runtime-session row the
    // provider is unknowable, and defaulting it would let a stale worker mint
    // rows for a conversation it no longer owns (same hardening as the
    // copilot-plan-usage ingest).
    if (!runtimeSession) {
      return res.status(404).json({ error: 'No runtime session for conversation' });
    }
    const providerType = String(runtimeSession.provider_type || '').trim().toLowerCase();
    // Claude and both Copilot-CLI providers (github hosted, openai BYOK) run
    // workers that continue runtime-initiated turns; refuse the rest rather
    // than minting a row no worker will ever answer.
    if (!CONTINUATION_PROVIDER_TYPES.has(providerType)) {
      return res.status(409).json({ error: `Background continuations are not supported for ${providerType || 'unbound'} conversations` });
    }
    const requester = readBridgeIdentity(req);
    const ownerSessionId = normalizeSessionWorkerId(requester?.sessionId)
      || normalizeSessionWorkerId(req.body?.sdkSessionId)
      || String(conversation.sdk_session_id || conversationId);
    const relayMode = normalizeRelayMode(req.body?.relayMode) || DEFAULT_RELAY_MODE;
    // Idempotent registration: the worker mints one operation id before its
    // first attempt and repeats it on every retry, so a retry whose previous
    // request committed but lost its response resolves to the same row
    // instead of minting a twin that nobody will ever settle.
    const operationId = String(req.body?.operationId || '').trim() || null;
    const respondWithExistingRow = (row) => {
      if (String(row.conversation_id || '') !== conversationId) {
        return res.status(409).json({ error: 'Continuation operation id is bound to another conversation' });
      }
      console.log(`[${ts()}] CONTINUATION ${String(row.id).slice(0, 8)} conv=${conversationId.slice(0, 8)} reused op=${operationId.slice(0, 8)}`);
      return res.json({ ok: true, messageId: row.id, conversationId: row.conversation_id, attemptId: row.attempt_id || null, existing: true });
    };
    if (operationId) {
      const existing = stmts.findQByContinuationOp?.get?.(operationId) || null;
      if (existing) return respondWithExistingRow(existing);
    }
    const messageId = uuidv4();
    const attemptId = uuidv4();
    const now = new Date().toISOString();
    const leaseExpiresAt = addMsToIso(now, SESSION_WORKER_OWNER_LEASE_MS);
    // A Claude chat's continuation runs on the worker that started it,
    // whose billing may no longer be the chat's (a switch waiting for this
    // very background work): stamped with that worker's kind.
    const continuationBilling = normalizeClaudeBilling(sessionWorkerRegistry?.getWorker?.(ownerSessionId)?.kind);
    // A turn the CLI starts by itself on the key passes no claim, so the
    // claim check (the cap, the key, the switch) is asked here: when it
    // refuses, the row is still minted (the worker needs its id), with a
    // stop for it that the worker's control poller picks up; the stop's
    // result stops the worker's background tasks and fails the row.
    let capStop = null;
    if ((continuationBilling || normalizeClaudeBilling(providerType)) === 'claude-api') {
      const refusal = claudeApiContinuationRefusal();
      if (refusal) {
        const code = String(refusal.code || 'CLAUDE_API_NOT_CONFIGURED');
        capStop = {
          source: CLAUDE_API_CAP_STOP_SOURCE,
          code,
          error: String(refusal.error || '').trim() || 'Claude API is unavailable, so this turn did not run.',
          // Its note says to switch Claude API on rather than to set it up.
          ...(refusal.switchedOff === true ? { switchedOff: true } : {}),
          episode: claudeApiStopEpisode(code),
        };
      } else {
        claudeApiStopLedger.clear(conversationId);
      }
    }
    // The row, its stamp and a cap stop commit together (a database without
    // transactions, a test's stand-in, runs them in order).
    const insertContinuationRow = () => {
      stmts.insertContinuationQ.run(
        messageId,
        conversationId,
        runtimeSession?.id || null,
        String(req.body?.model || '').trim() || null,
        relayMode,
        '[background continuation]',
        now,
        now,
        ownerSessionId,
        now,
        leaseExpiresAt,
        now,
        attemptId,
        operationId,
      );
      if (continuationBilling) stmts.setQueueProvider?.run?.(continuationBilling, messageId);
      if (capStop) {
        insertRelayControlRequest.run(uuidv4(), 'abort_turn', conversationId, messageId, ownerSessionId, JSON.stringify(capStop), now, now);
      }
    };
    const insertContinuation = typeof db.transaction === 'function' ? db.transaction(insertContinuationRow) : insertContinuationRow;
    try {
      insertContinuation();
    } catch (error) {
      // Lost the race against a concurrent duplicate registration: the unique
      // index on continuation_op_id guarantees the winner's row exists now.
      if (operationId && String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        const existing = stmts.findQByContinuationOp?.get?.(operationId) || null;
        if (existing) return respondWithExistingRow(existing);
      }
      throw error;
    }
    console.log(`[${ts()}] CONTINUATION ${messageId.slice(0, 8)} conv=${conversationId.slice(0, 8)} owner=${ownerSessionId.slice(0, 8)} trigger=${String(req.body?.trigger || 'background_task')}${operationId ? ` op=${operationId.slice(0, 8)}` : ''}${capStop ? ' stopped=claude-api-cap' : ''}`);
    if (capStop) {
      // Not left to the stop: a turn that ends before the worker's control
      // poller takes it still gets its tasks stopped and the note.
      try {
        const tasks = stopClaudeApiBackgroundTasks(conversationId, ownerSessionId);
        if (!claudeApiStopLedger.has(conversationId, capStop.episode)) {
          writeClaudeApiStopNote({ conversationId, relayMode, refusal: capStop, tasks, now });
          claudeApiStopLedger.note(conversationId, capStop.episode);
        }
      } catch (error) {
        console.warn(`[${ts()}] CLAUDE API STOP conv=${conversationId.slice(0, 8)}: ${error?.message || error}`);
      }
    }
    io.emit('message_status', { messageId, conversationId, status: 'processing', kind: 'continuation' });
    io.emit('queue_updated', { continuation: 1 });
    res.json({ ok: true, messageId, conversationId, attemptId });
  });

  // An integer from a worker's post, or undefined (dropped from the row).
  function wholeNumber(value, { min = Number.MIN_SAFE_INTEGER } = {}) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return undefined;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min ? number : undefined;
  }

  // A task row's console fields as the publish route keeps them.
  function taskOutputFields(task) {
    const outputPath = normalizeTaskOutputPath(task?.outputPath);
    const requestedKind = String(task?.outputKind || '').trim();
    if (!outputPath && !requestedKind) return {};
    const outputKind = normalizeTaskOutputKind(requestedKind, outputPath);
    // A file kind without a readable path has nothing to show.
    if ((outputKind === 'file' || outputKind === 'spool') && !outputPath) return { outputKind: 'none' };
    return { ...(outputPath ? { outputPath } : {}), outputKind };
  }

  // `background_tasks` with the health readings on the live rows and the
  // ended rows beside them, for the key the worker posts under.
  function emitBackgroundTasks(key, tasks = backgroundTaskStore?.get?.(key) || []) {
    io.emit('background_tasks', {
      conversationId: key,
      tasks: backgroundTaskStore?.withHealth ? backgroundTaskStore.withHealth(tasks, key) : tasks,
      endedTasks: backgroundTaskStore?.ended?.(key) || [],
    });
  }

  function resolveTaskConversationId(id) {
    const key = String(id || '').trim();
    if (!key) return '';
    try {
      return String(resolveConversationRecord?.({ conversationId: key, sdkSessionId: key })?.id || key);
    } catch {
      return key;
    }
  }

  // POST /api/background-task-settled — how a background task ended, where
  // the worker learns it (the Claude worker's task_notification): status,
  // summary, and the reason for an unusual end. The task leaves the live set
  // on its own; this only says how it ended.
  app.post('/api/background-task-settled', auth, (req, res) => {
    touchCli();
    const conversationId = resolveTaskConversationId(req.body?.conversationId);
    const taskId = String(req.body?.taskId || '').trim();
    if (!conversationId || !taskId) return res.status(400).json({ error: 'Missing conversationId or taskId' });
    // Only a number the worker sent: a missing or null exit code stays null
    // (Number(null) would read as a clean exit).
    const exitCode = wholeNumber(req.body?.exitCode);
    // Scrubbed like the output: a description can be the command line.
    const settledDescription = cleanTaskText(String(req.body?.description || ''), 500);
    // The store is keyed as the worker posts. A task with a console stays
    // viewable as an ended row; one that ended while this runtime was away
    // becomes one when the post names its output.
    const settledOutputPath = normalizeTaskOutputPath(req.body?.outputPath);
    const endedRow = backgroundTaskStore?.settle?.(String(req.body?.conversationId || '').trim(), taskId, {
      status: req.body?.status,
      exitCode: exitCode ?? null,
      steps: wholeNumber(req.body?.steps, { min: 0 }),
      outputPath: settledOutputPath || undefined,
      outputKind: settledOutputPath ? normalizeTaskOutputKind(req.body?.outputKind, settledOutputPath) : undefined,
      description: settledDescription,
      command: normalizeTaskCommand(req.body?.command) || undefined,
      taskType: String(req.body?.taskType || '').trim().slice(0, 80),
      startedAt: Number(req.body?.startedAt) || null,
    }) || null;
    if (endedRow) {
      emitBackgroundTasks(String(req.body?.conversationId || '').trim());
      pokeTaskHealth?.();
    }
    sessionActivityTracker?.noteTaskSettled?.(conversationId, {
      taskId,
      toolUseId: sanitizeSubagentRunId(req.body?.toolUseId) || null,
      // Which run ended (a resumed agent runs again under the same task id).
      ...(req.body?.taskRunId ? { taskRunId: String(req.body.taskRunId).trim().slice(0, 200) } : {}),
      status: String(req.body?.status || '').trim().slice(0, 40) || 'completed',
      summary: cleanTaskText(String(req.body?.summary || ''), 500) || null,
      exitCode: exitCode ?? null,
      // What the task was, from a worker that sends it: the end of a task
      // this runtime never knew (it ended while the relay was away) is
      // still an event then.
      ...(settledDescription ? {
        description: settledDescription,
        taskType: String(req.body?.taskType || '').trim().slice(0, 80),
        startedAt: Number(req.body?.startedAt) || null,
      } : {}),
    });
    relayEventService?.afterStateChange?.(conversationId);
    res.json({ ok: true });
  });

  // POST /api/background-tasks — a session worker publishes its live
  // background-task set (REPLACE semantics, mirroring the SDK's
  // background_tasks_changed signal) so the composer panel tracks it live.
  // `resync: true` marks the set as the answer to a heartbeat that asked for
  // it again (`resyncBackgroundTasks`): the same replace, and the pages get
  // the set again, but a task the relay had forgotten is not a new start.
  // `order` lets the relay drop a set that a newer one overtook.
  app.post('/api/background-tasks', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    if (!conversationId) return res.status(400).json({ error: 'Missing conversationId' });
    const tasks = (Array.isArray(req.body?.tasks) ? req.body.tasks : [])
      .map((task) => ({
        taskId: String(task?.taskId || '').trim(),
        taskType: String(task?.taskType || '').trim(),
        // Scrubbed like the output before anything keeps or sends them: a
        // description can be the command line (Grok's terminals, a Copilot
        // shell without one), a summary or tool call can quote one.
        description: cleanTaskText(String(task?.description || ''), 500),
        // A shell task's command line, where the worker knows it: scrubbed
        // like the output and cut at 2,000 characters before it is kept, so
        // every reader (the pages, read_session, the stored row) gets it so.
        command: normalizeTaskCommand(task?.command) || undefined,
        startedAt: Number(task?.startedAt) || null,
        summary: cleanTaskText(String(task?.summary || ''), 500) || null,
        lastToolName: String(task?.lastToolName || '').trim() || null,
        lastToolCall: cleanTaskText(String(task?.lastToolCall || '').replace(/\s+/g, ' '), 300) || null,
        totalTokens: Number.isFinite(Number(task?.totalTokens)) ? Number(task.totalTokens) : null,
        subagentType: String(task?.subagentType || '').trim().slice(0, 120) || null,
        model: String(task?.model || '').trim().slice(0, 120) || null,
        modelInherited: task?.modelInherited === true,
        // Copilot detached shells cannot be stopped from the host side; the
        // panel hides the Stop button for them. Absent/true = stoppable.
        stoppable: task?.stoppable !== false,
        // Sanitized digest or undefined: JSON serialization (store broadcast,
        // conversation payload) drops the key entirely for flat rows.
        workflowProgress: sanitizeWorkflowProgress(task?.workflowProgress) || undefined,
        // The spawning tool_use id: the sub-agent run this task is. The panel
        // opens the run's viewer from it.
        toolUseId: sanitizeSubagentRunId(task?.toolUseId) || undefined,
        // Which run of the task this is (the SDK's run id): a resumed agent
        // keeps its task id and runs again under a new one.
        taskRunId: String(task?.taskRunId || '').trim().slice(0, 200) || undefined,
        // The console (shell and Monitor tasks): the file holding the
        // output, how it is obtained ('none': the provider has none to give).
        ...taskOutputFields(task),
        // Tool calls a sub-agent made so far.
        steps: wholeNumber(task?.steps, { min: 0 }),
        exitCode: wholeNumber(task?.exitCode),
      }))
      .filter((task) => task.taskId);
    // A resumed agent's row names the call that resumed it, which no run
    // carries: it opens the run of its task instead (a worker that remembers
    // the spawn sends that already).
    const runConversationId = resolveTaskConversationId(conversationId);
    for (const task of tasks) {
      if (!task.toolUseId || !SUBAGENT_TASK_TYPES.has(task.taskType) || stmts.getSubagentRun?.get?.(task.toolUseId)) continue;
      const run = subagentRunOfTask(runConversationId, task.taskId);
      if (run) task.toolUseId = String(run.id);
    }
    // The first path a task names wins: a later post cannot point a live
    // task's console at another file.
    for (const task of tasks) {
      const held = (backgroundTaskStore?.get?.(conversationId) || []).find((entry) => entry?.taskId === task.taskId);
      if (held?.outputPath && task.outputPath !== held.outputPath) {
        task.outputPath = held.outputPath;
        task.outputKind = held.outputKind;
      }
    }
    const resync = req.body?.resync === true;
    // Posts can overtake each other on the way (an ordinary publish and the
    // answer to a resync, two publishes): a worker numbers its sets
    // (`order: { epoch, seq }`), and one older than the newest applied is
    // dropped, or a task of the newer set would read as ended. A worker
    // that numbers none is taken as it comes.
    // A drop is never silent: it is logged, and the answer says `stale`,
    // on which the worker asks for a heartbeat (which makes it the holder
    // of the session if it was not yet, and has the relay ask for the set).
    const setOrder = backgroundTaskStore?.acceptOrder?.(conversationId, req.body?.order, {
      pid: readBridgeIdentity(req)?.pid,
    });
    if (setOrder && setOrder.accepted === false) {
      console.log(`[${typeof ts === 'function' ? ts() : new Date().toISOString()}] BG-TASKS set dropped (${setOrder.reason}) session=${conversationId.slice(0, 8)} epoch=${Number(req.body?.order?.epoch) || 0} seq=${Number(req.body?.order?.seq) || 0} tasks=${tasks.length}`);
      return res.json({ ok: true, count: tasks.length, stale: true, reason: setOrder.reason });
    }
    // A task with a console that leaves the set ended: its file is read once
    // more soon (its last output often lands after the poller's last look).
    const nextIds = new Set(tasks.map((task) => task.taskId));
    const endedWithConsole = (backgroundTaskStore?.get?.(conversationId) || [])
      .some((task) => task?.outputPath && !nextIds.has(task.taskId));
    backgroundTaskStore?.replace?.(conversationId, tasks);
    backgroundTaskStore?.announce?.(conversationId, false);
    if (endedWithConsole) pokeTaskHealth?.();
    emitBackgroundTasks(conversationId, tasks);
    // The store is keyed as the worker posts (its SDK session id); the
    // tracker by the conversation.
    try {
      const trackedConversationId = resolveTaskConversationId(conversationId);
      sessionActivityTracker?.noteTaskSet?.(trackedConversationId, tasks, { resync });
      relayEventService?.afterStateChange?.(trackedConversationId);
    } catch {}
    // The panel's copy of a task lives in memory and goes when the task
    // settles; what the run's row needs of it is kept on the run.
    for (const task of tasks) {
      if (!task.toolUseId) continue;
      const before = stmts.getSubagentRun?.get?.(task.toolUseId) || null;
      if (!before || String(before.conversation_id || '') !== conversationId) continue;
      const patch = sanitizeRunHeaderPatch({
        model: task.model,
        modelInherited: task.model ? task.modelInherited : undefined,
        subagentType: task.subagentType,
        taskId: task.taskId,
        totalTokens: task.totalTokens,
        background: true,
      });
      if (!patch) continue;
      const after = subagentTimeline.applyHeader(before.id, patch);
      const changed = after && ['model', 'model_inherited', 'subagent_type', 'task_id', 'total_tokens', 'background']
        .some((column) => before[column] !== after[column]);
      if (changed) emitSubagentStatus(after);
    }
    res.json({ ok: true, count: tasks.length, ...(resync ? { resync: true } : {}) });
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

  // POST /api/background-tasks/:taskId/output-snapshot — a worker's answer
  // to `task_output_snapshot`: the task's latest output where it has no
  // file (Claude's getTaskOutput, its last 8 KiB).
  app.post('/api/background-tasks/:taskId/output-snapshot', auth, (req, res) => {
    touchCli();
    const key = String(req.body?.conversationId || '').trim();
    const taskId = String(req.params.taskId || '').trim();
    if (!key || !taskId) return res.status(400).json({ error: 'Missing conversationId or taskId' });
    if (typeof req.body?.output !== 'string') return res.status(400).json({ error: 'output must be a string' });
    taskOutputSnapshots?.set?.(key, taskId, {
      output: req.body.output.slice(0, TASK_OUTPUT_LIMITS.chunkBytes),
      totalBytes: req.body?.totalBytes,
      truncated: req.body?.truncated === true,
    });
    res.json({ ok: true });
  });

  // POST /api/activity — relay sends in-flight activity updates (tool/search sections)
  // Optional attempt fence for the live lanes (stream/thought/activity/
  // subagent): a writer that names its processing attempt is rejected once
  // the row's current attempt differs — the row was requeued or re-dequeued
  // after this writer started, and its output belongs to a superseded turn.
  // Same-attempt writes pass regardless of row status (trailing writes right
  // after finalization are legitimate), and writers without an attemptId keep
  // legacy behavior until the extension engine is retired.
  function rejectStaleAttemptWrite({ req, res, queueRow, route }) {
    const claimed = String(req.body?.attemptId || '').trim();
    if (!claimed || !queueRow) return false;
    const current = String(queueRow.attempt_id || '');
    if (current === claimed) return false;
    staleAttemptLog.note({ messageId: queueRow.id, attemptId: claimed, currentAttemptId: current, route, status: queueRow.status });
    res.status(409).json({ error: 'stale_attempt', currentStatus: String(queueRow.status || 'unknown') });
    return true;
  }

  app.post('/api/activity', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, text, mode, subagentRunId, metadata } = req.body || {};
    const activityText = sanitizeActivityText(text);
    if (!messageId || !conversationId || !activityText) {
      return res.status(400).json({ error: 'Missing activity payload' });
    }

    const q = stmts.findQById.get(messageId);
    if (rejectStaleAttemptWrite({ req, res, queueRow: q, route: 'activity' })) return;
    try { sessionActivityTracker?.touch?.(q?.conversation_id || conversationId); } catch {}
    const responseMessageId = q?.response_message_id || null;
    const normalizedSubagentRunId = subagentRunId ? String(subagentRunId).trim() : null;
    const normalizedMetadata = sanitizeActivityMetadata(metadata);
    const activityRow = stmts.insertActivity.run(
      messageId,
      responseMessageId,
      conversationId,
      normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      activityText,
      new Date().toISOString(),
      normalizedSubagentRunId,
      normalizedMetadata ? JSON.stringify(normalizedMetadata) : null,
    );
    if (normalizedSubagentRunId) {
      // The lane keeps the capped line; the timeline copy keeps what came in.
      mirrorSubagentFrame({
        runId: normalizedSubagentRunId,
        key: `activity:${activityRow?.lastInsertRowid ?? Date.now()}`,
        ...activityTimelineFrame(String(text || '').trim() || activityText),
      });
    }

    io.emit('relay_activity', {
      messageId,
      conversationId,
      mode: normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
      text: activityText,
      timestamp: new Date().toISOString(),
      subagentRunId: normalizedSubagentRunId || undefined,
      ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}),
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
    if (rejectStaleAttemptWrite({ req, res, queueRow, route: 'stream' })) return;
    try { sessionActivityTracker?.touch?.(queueConversationId); } catch {}

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
        // Each update carries the full text-so-far, so the row for this thread
        // is replaced in place — appending would persist the whole reply once
        // per update. seq still advances per update so readers and the client
        // stream state machine can order snapshots across threads.
        const existing = stmts.getStreamEventByQueueAndThread?.get(messageId, normalizedSubagentRunId) || null;
        if (existing) {
          // A done snapshot is final for its thread; drop stale non-done
          // stragglers, mirroring the client's stream state machine.
          if (Number(existing.done || 0) === 1 && !done) {
            return Math.max(0, Number(existing.seq || 0));
          }
          stmts.updateStreamEventByQueueAndThread?.run(
            responseMessageId,
            conversationId,
            normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
            nextSeq,
            streamText,
            done ? 1 : 0,
            now,
            messageId,
            normalizedSubagentRunId,
          );
          return nextSeq;
        }
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

    if (normalizedSubagentRunId) {
      // One reply text per run and turn, updated in place as it grows.
      mirrorSubagentFrame({ runId: normalizedSubagentRunId, key: `stream:${messageId}`, kind: 'text', text: streamText, done: !!done });
    }

    // Volatile keeps these out of the connection-state-recovery buffer. Each chunk
    // carries the full text so far, so replaying a turn's worth of them costs
    // megabytes to deliver what one reconnect resync already fetches from
    // relay_stream_events. Live delivery to connected clients is unchanged.
    io.volatile.emit('relay_stream', {
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
    if (rejectStaleAttemptWrite({ req, res, queueRow, route: 'thought' })) return;
    try { sessionActivityTracker?.touch?.(queueConversationId); } catch {}

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

    if (normalizedSubagentRunId && (normalizedReasoningId || done) && String(thoughtText).trim()) {
      mirrorSubagentFrame({
        runId: normalizedSubagentRunId,
        key: normalizedReasoningId ? `thought:${normalizedReasoningId}` : `thought:${messageId}:${seq}`,
        kind: 'thought',
        text: thoughtText,
        done: !!done,
      });
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

  // POST /api/subagent-run — relay notifies about subagent lifecycle events.
  // A new run needs the turn that spawned it (messageId). An update to a known
  // run may come without one: a background agent outlives its turn, and its
  // end (or its header) arrives between turns or during a later turn; the run
  // row names its own turn. Header fields (model, type, task id, background,
  // who writes the timeline) are patched onto the run.
  app.post('/api/subagent-run', auth, (req, res) => {
    touchCli();
    const { messageId, conversationId, subagentRunId, parentSubagentId, displayName, status } = req.body || {};
    // Provider call ids become row ids verbatim; malformed ones (embedded
    // newlines, concatenated ids — seen live) are sanitized at the door.
    const normalizedSubagentRunId = sanitizeSubagentRunId(subagentRunId);
    const normalizedParentSubagentId = sanitizeSubagentRunId(parentSubagentId);
    const normalizedDisplayName = displayName ? String(displayName).trim() : null;
    const normalizedStatus = status ? normalizeSubagentRunStatus(status) : 'running';
    const normalizedMessageId = String(messageId || '').trim();

    if (!conversationId || !normalizedSubagentRunId) {
      return res.status(400).json({ error: 'Missing required subagent-run fields: messageId, conversationId, subagentRunId' });
    }
    const existingRun = stmts.getSubagentRun?.get(normalizedSubagentRunId);
    if (!normalizedMessageId && !existingRun) {
      return res.status(400).json({ error: 'Missing required subagent-run fields: messageId, conversationId, subagentRunId' });
    }

    let authoritativeConversationId;
    if (normalizedMessageId) {
      const q = stmts.findQById.get(normalizedMessageId);
      if (rejectStaleAttemptWrite({ req, res, queueRow: q, route: 'subagent-run' })) return;
      const binding = validateSubagentRunBinding({
        queueRow: q,
        messageId: normalizedMessageId,
        conversationId,
        existingRun,
      });
      if (!binding.ok) {
        return res.status(binding.statusCode || 409).json({ error: binding.error || 'Subagent run binding mismatch' });
      }
      authoritativeConversationId = String(binding.conversationId || conversationId || '').trim();
    } else {
      authoritativeConversationId = String(existingRun.conversation_id || '').trim();
      if (authoritativeConversationId !== String(conversationId).trim()) {
        return res.status(409).json({ error: 'Subagent run conversation mismatch' });
      }
    }

    const now = new Date().toISOString();

    if (existingRun) {
      // Without a status the post is a header update and leaves the run's
      // state alone.
      if (status) {
        const isTerminal = normalizedStatus === 'completed' || normalizedStatus === 'failed' || normalizedStatus === 'cancelled';
        stmts.updateSubagentRunStatus?.run(
          normalizedStatus,
          now,
          isTerminal ? now : null,
          normalizedSubagentRunId,
        );
      }
    } else {
      stmts.insertSubagentRun?.run(
        normalizedSubagentRunId,
        normalizedMessageId,
        authoritativeConversationId,
        normalizedParentSubagentId,
        normalizedDisplayName,
        normalizedStatus,
        now,
        now,
      );
    }
    const headerPatch = sanitizeRunHeaderPatch({
      model: req.body?.model,
      modelInherited: req.body?.modelInherited,
      subagentType: req.body?.subagentType,
      taskId: req.body?.taskId,
      background: req.body?.background === true,
      timelineOwner: req.body?.timelineOwner,
    });
    if (headerPatch) subagentTimeline.applyHeader(normalizedSubagentRunId, headerPatch);

    const run = stmts.getSubagentRun?.get?.(normalizedSubagentRunId);
    if (run) {
      emitSubagentStatus(run);
    } else {
      io.emit('subagent_status', {
        messageId: normalizedMessageId || null,
        conversationId: authoritativeConversationId,
        subagentRunId: normalizedSubagentRunId,
        parentSubagentId: normalizedParentSubagentId || undefined,
        displayName: normalizedDisplayName || undefined,
        status: normalizedStatus,
        timestamp: now,
      });
    }

    res.json({ ok: true });
  });

  // POST /api/subagent-timeline — a worker publishes entries of a sub-agent's
  // record (and, optionally, a header patch) for a run it already announced.
  // Fenced by the run row, not by an open turn: a background agent keeps
  // writing after its turn ended, and its entries belong to that turn. A run
  // the relay does not know yet but whose parent it does (an agent spawned
  // inside another) is created under the parent's turn; a run of a task the
  // relay knows by its task id (a resumed agent: same task, new tool use) is
  // that task's run; anything else is a 404 the worker retries once the spawn
  // has landed.
  app.post('/api/subagent-timeline', auth, (req, res) => {
    touchCli();
    const conversationId = String(req.body?.conversationId || '').trim();
    let runId = sanitizeSubagentRunId(req.body?.subagentRunId);
    if (!conversationId || !runId) {
      return res.status(400).json({ error: 'Missing conversationId or subagentRunId' });
    }
    if (!subagentTimeline.supported()) {
      return res.status(503).json({ error: 'timeline_unavailable' });
    }
    const rawHeader = req.body?.header && typeof req.body.header === 'object' ? req.body.header : {};
    let run = stmts.getSubagentRun?.get?.(runId) || null;
    // A finished run that a later run of its task (posted under another id)
    // sets running again: the relay marks where it resumed, once per id.
    let resumedNote = null;
    if (!run) {
      run = subagentRunOfTask(conversationId, req.body?.taskId || rawHeader.taskId);
      if (run && isTerminalSubagentRunStatus(normalizeSubagentRunStatus(run.status))
        && rawHeader.status && normalizeSubagentRunStatus(rawHeader.status) === 'running') {
        resumedNote = { key: `relay:resumed:${runId}`, kind: 'note', text: 'Resumed with a new message', metadata: { resumed: true } };
      }
      if (run) runId = String(run.id);
    }
    let created = false;
    if (!run) {
      const parentId = sanitizeSubagentRunId(rawHeader.parentSubagentId);
      const parent = parentId ? (stmts.getSubagentRun?.get?.(parentId) || null) : null;
      if (!parent) return res.status(404).json({ error: 'unknown_run' });
      if (String(parent.conversation_id || '') !== conversationId) {
        return res.status(409).json({ error: 'Subagent run conversation mismatch' });
      }
      const now = new Date().toISOString();
      const displayName = String(rawHeader.displayName || '').trim().slice(0, 500) || 'Subagent';
      stmts.insertSubagentRun?.run(runId, parent.queue_message_id, parent.conversation_id, parentId, displayName, 'running', now, now);
      run = stmts.getSubagentRun?.get?.(runId) || null;
      if (!run) return res.status(500).json({ error: 'Failed to create the run' });
      created = true;
    }
    if (String(run.conversation_id || '') !== conversationId) {
      return res.status(409).json({ error: 'Subagent run conversation mismatch' });
    }
    const patch = sanitizeRunHeaderPatch(rawHeader);
    if (patch) run = subagentTimeline.applyHeader(runId, patch) || run;
    let stored;
    try {
      const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
      stored = subagentTimeline.applyEntries(run, resumedNote ? [resumedNote, ...entries] : entries);
    } catch (error) {
      return res.status(500).json({ error: error?.message || 'Failed to store the timeline' });
    }
    if (stored.truncated) run = stmts.getSubagentRun?.get?.(runId) || run;
    if (created || patch || stored.truncated) emitSubagentStatus(run);
    emitSubagentTimeline(run, stored.entries);
    try { sessionActivityTracker?.touch?.(conversationId); } catch {}
    res.json({ ok: true, stored: stored.entries.length, truncated: stored.truncated });
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

  // POST /api/requeue — relay re-queues a message it failed to process
  app.post('/api/requeue', auth, (req, res) => {
    const { messageId } = req.body;
    const q = stmts.findQById.get(messageId);
    const terminalFailure = resolveTerminalFailurePayload(req.body);
    // A fenced requeue from a superseded attempt is refused outright: honoring
    // it would yank the row out from under the attempt that now owns it (or
    // terminal-fail a row that has already been requeued to someone else).
    const claimedAttemptId = String(req.body?.attemptId || '').trim() || null;
    if (claimedAttemptId && q && String(q.attempt_id || '') !== claimedAttemptId) {
      staleAttemptLog.note({ messageId, attemptId: claimedAttemptId, currentAttemptId: q.attempt_id, route: 'requeue', status: q.status });
      return res.status(409).json({ error: 'stale_attempt', currentStatus: String(q.status || 'unknown') });
    }
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
        attemptId: claimedAttemptId,
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
    if (q && q.status === 'processing' && String(q.kind || '') === 'continuation') {
      // A continuation has no user prompt to replay; a worker that gives up on
      // one just tears it down.
      stmts.dropStaleContinuation?.run?.(messageId);
      io.emit('message_status', { messageId, conversationId: q.conversation_id, status: 'failed' });
      console.log(`[${ts()}] CONTINUATION DROPPED ${messageId?.slice(0,8)} reason=requeue`);
      return res.json({ ok: true, dropped: 'continuation' });
    }
    if (q && q.status === 'processing' && q.consumed_at) {
      // The CLI already took this prompt: any requeue class would run it again.
      failConsumedQueueRow(q, { reason: 'requeue', attemptId: claimedAttemptId });
      return res.json({ ok: true, terminal: true, code: STEER_SETTLE_FAILED_STABLE_CODE });
    }
    if (q && q.status === 'processing' && String(req.body?.code || '').trim() === 'relay.provider-mismatch') {
      // A routing refusal, not a delivery failure: the legacy relay handed
      // back a turn that belongs to a session worker. No retry increment and
      // no backoff — the owner worker must be able to claim it immediately
      // instead of paying a 60s ladder for the relay's mistake.
      db.prepare(`
        UPDATE queue
        SET status = 'pending', processing_at = NULL, attempt_id = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL
        WHERE id = ? AND status = 'processing'${claimedAttemptId ? ` AND attempt_id = ?` : ''}
      `).run(...(claimedAttemptId ? [messageId, claimedAttemptId] : [messageId]));
      io.emit('message_status', { messageId, conversationId: q.conversation_id, status: 'pending' });
      console.log(`[${ts()}] REQUEUED  ${messageId?.slice(0,8)} class=provider-mismatch retry=${Number(q.retry_count || 0)}`);
      return res.json({ ok: true, mismatch: true });
    }
    const handBackClass = String(req.body?.class || '').trim();
    if (q && q.status === 'processing' && (handBackClass === 'steering-held' || handBackClass === 'kind-mismatch')) {
      // The worker refused to push the message because its live turn is
      // holding steering (an open question card, a compaction, an adoption).
      // Not a failure: no retry increment, no backoff, and the owner is kept —
      // the same worker takes it again the moment it signals ready, which is
      // when the hold ends, so the message steers into the resumed turn.
      // `kind-mismatch`: a Claude chat's row reached a worker of the other
      // billing; back to pending (re-stamped to the chat's billing by the
      // queue trigger) for the worker the billing swap brings up.
      const result = db.prepare(`
        UPDATE queue
        SET status = 'pending', processing_at = NULL, attempt_id = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL
        WHERE id = ? AND status = 'processing'${claimedAttemptId ? ` AND attempt_id = ?` : ''}
      `).run(...(claimedAttemptId ? [messageId, claimedAttemptId] : [messageId]));
      if (result.changes > 0) {
        settleRelayAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-requeued' });
        settleRelaySubagentAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-requeued' });
        io.emit('message_status', { messageId, conversationId: q.conversation_id, status: 'pending' });
        console.log(`[${ts()}] REQUEUED  ${messageId?.slice(0,8)} class=${handBackClass} retry=${Number(q.retry_count || 0)}`);
      }
      return res.json({ ok: true, held: true });
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
        const transientRequeue = isTransientRequeue({
          queueRow: q,
          relayActivityCount: stmts.listActivityByQueueMessage?.all?.(messageId)?.length || 0,
          relayStreamCount: stmts.listStreamEventsByQueueMessage?.all?.(messageId)?.length || 0,
        });
        const nextAttemptAt = parkForRestart
          ? null
          : addMsIso(computeRetryDelayMs(retryCount, { transient: transientRequeue }));
        const result = db.prepare(`
          UPDATE queue
          SET
            status = ?,
            processing_at = NULL,
            attempt_id = NULL,
            retry_count = ?,
            next_attempt_at = ?,
            owner_lease_expires_at = NULL,
            parked_at = ?,
            parked_target_session_id = ?,
            parked_transaction_id = ?,
            parked_reason = ?
          WHERE id = ? AND status = 'processing'${claimedAttemptId ? ` AND attempt_id = ?` : ''}
        `).run(
          parkForRestart ? 'parked' : 'pending',
          retryCount,
          nextAttemptAt,
          parkForRestart ? new Date().toISOString() : null,
          parkForRestart ? (restartState?.targetSessionId || null) : null,
          parkForRestart ? (restartState?.transactionId || null) : null,
          parkForRestart ? (restartState?.lastError || 'session-rebind-pending') : null,
          ...(claimedAttemptId ? [messageId, claimedAttemptId] : [messageId]),
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
          console.log(`[${ts()}] REQUEUED  ${messageId?.slice(0,8)} retry=${retryCount} class=${transientRequeue ? 'transient' : 'failure'} status=${parkForRestart ? 'parked' : 'pending'}${nextAttemptAt ? ` next=${nextAttemptAt}` : ''}`);
          io.emit('message_status', { messageId, conversationId: q?.conversation_id, status: parkForRestart ? 'parked' : 'pending' });
        }
      }
    }
    res.json({ ok: true });
  });
}
