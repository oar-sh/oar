import fs from 'fs';
import path from 'path';
import { FAILURE_NOTE_LEAD_MAX } from '../../shared/failure-note-text.mjs';
import {
  fetchUsageSummaryPromise,
  staleUsageSnapshotFromRow,
  usageSnapshotFromRow,
  usageSnapshotFromSummary,
} from '../services/usage-snapshot-helpers.mjs';
import { isUsageLimitTerminalError } from '../services/usage-limit-pause-service.mjs';
import { sanitizeSubagentRunId } from '../../shared/subagent-run-id.mjs';
import {
  TASK_OUTPUT_LIMITS,
  cleanTaskText,
  normalizeTaskCommand,
  normalizeTaskOutputKind,
  normalizeTaskOutputPath,
} from '../../shared/task-output-text.mjs';
import { ANSWERED_ELSEWHERE_KIND, STEER_FOLDED_TEXT } from '../../shared/steer-settle-markers.mjs';
import { formatOpenAIImageSummary, isOpenAIImageModelId } from '../../shared/openai-image-options.mjs';
import { formatOpenAIImageUsd } from '../../shared/openai-image-spend.mjs';
import { readImageHeader } from '../../shared/image-header.mjs';
import { sanitizeRunHeaderPatch } from '../services/subagent-timeline-service.mjs';
import { SUBAGENT_TASK_TYPES, isTerminalSubagentRunStatus, normalizeSubagentRunStatus } from '../../shared/subagent-timeline.mjs';
import { createSubagentTimelinePublisher } from '../services/subagent-viewer-rooms.mjs';
import { normalizeClaudeBilling } from '../services/claude-billing-switch-service.mjs';
import {
  CLAUDE_API_CAP_STOP_SOURCE,
  OPAQUE_RESPONSE_RECOVERY_POLL_MS,
  OPAQUE_RESPONSE_RECOVERY_WAIT_MS,
  SESSION_WORKER_OWNER_LEASE_MS,
  addMsToIso,
  buildTerminalFailureTextForChat,
  delay,
  deriveModelOrigin,
  isBase64Text,
  normalizeSessionWorkerId,
  normalizeStorageSegment,
  resolveGeneratedImageReadPath,
  resolveTerminalFailurePayload,
  splitBase64DataUrl,
} from './messages-helpers.mjs';

// What a session worker publishes for a turn: the response (with its
// generated images), the continuation turns its runtime starts on its own,
// the live lanes (activity, stream, thoughts, sub-agent runs and their
// timelines) and its background tasks.

const OPAQUE_RESPONSE_TEXT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const USAGE_FETCH_RETRY_DELAY_MS = 250;

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

// Which provider actually executed a turn, derived from the authenticated
// responder identity: a session worker names its sdk session via the bridge
// header, and that session's runtime row names the provider. The response
// payload has no say — a misrouted responder must not be able to mask itself.
//
// Identity-less responders are the interesting case. One of them is
// expected: this server finalizing an image operation it executed itself. It
// calls the provider's own API with the conversation's BYOK key and then
// self-posts to /api/response with no bridge headers, and that turn genuinely
// ran on the bound provider. Any other responder without an identity is
// taken for the Copilot plan.
// OpenAI BYOK chat turns are not identity-less: they run on a Copilot SDK worker
// launched with COPILOT_PROVIDER_TYPE=openai, which does
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

const GENERATED_IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
});

function resolveGeneratedImageExtension(mimeType) {
  const normalized = String(mimeType || '').trim().toLowerCase();
  return GENERATED_IMAGE_EXTENSIONS[normalized] || 'png';
}

function parseGeneratedImageData(raw) {
  const dataUrl = String(raw?.dataUrl || raw?.data_url || '').trim();
  if (dataUrl.startsWith('data:')) {
    const parts = splitBase64DataUrl(dataUrl);
    if (!parts) throw new Error('Invalid generated image data URL');
    return {
      mimeType: String(raw?.mimeType || raw?.mime_type || parts.mimeType || '').trim().toLowerCase(),
      dataBase64: parts.payload.trim(),
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
    if (!isBase64Text(parsed.dataBase64)) {
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

// The longest image note /api/response takes into the reply text.
const OPENAI_IMAGE_NOTE_MAX = 500;

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

function createGeneratedImageAttachment({
  image,
  messageId,
  conversationId,
  sdkSessionId,
  imageIndex,
  resolveSessionStateRoot,
}) {
  const imageId = `img-${String(imageIndex + 1).padStart(2, '0')}`;
  const bytes = Buffer.from(String(image.dataBase64 || ''), 'base64');
  // The type and pixel size the image's own header gives; the type the
  // sender named only when the header is not one the reader knows.
  const header = readImageHeader(bytes);
  const mimeType = header?.mime || image.mimeType;
  const extension = resolveGeneratedImageExtension(mimeType);
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
    type: mimeType,
    size: bytes.length,
    ...(header ? { width: header.width, height: header.height } : {}),
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

// `deps` is the object registerMessagesRoutes gets; `shared` carries what
// that function resolved or built itself (the deps that have a default
// there, and its own helpers), as the same values.
export function registerMessagesWorkerOutputRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    touchCli,
    ts,
    uuidv4,
    queueCounts,
    DEFAULT_RELAY_MODE,
    normalizeRelayMode,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_ATTACHMENTS,
    backgroundTaskStore,
    sendWorkerControl,
    hydrateAttachment,
    pushDispatchService,
    readSessionTranscriptMessages,
    relayActivityForResponse,
    relayThoughtsForResponse,
    resolveSessionStateRoot,
    sanitizeActivityText,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
  } = deps;
  const {
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
  } = shared;

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

  /**
   * The reply line of an image turn: what came back, and what this turn's
   * tries were booked at ("~USD 0.21", marked "(estimate)" when any part is
   * one, "(price unknown, estimated)" for the stand-in); from 80 % of the
   * daily cap on, today's spend against it.
   */
  function openAIImageReplyLine({ images, model, turnId }) {
    let cost = null;
    let state = null;
    try {
      cost = imageSpend.turnCost(turnId);
      state = imageSpend.buildState();
    } catch (error) {
      console.warn(`[${ts()}] IMAGE     the cost of ${String(turnId || '').slice(0, 8)} could not be read: ${error?.message || error}`);
    }
    let line = formatOpenAIImageSummary({ images, model, costUsd: cost ? cost.costUsd : null });
    if (cost?.unknownPrice) line += ' (price unknown, estimated)';
    else if (cost?.estimated) line += ' (estimate)';
    // The spend state's own rule (booked and in flight, `warning`), as the
    // banner reads it.
    if (state?.capUsd && state.warning) {
      const todayUsd = (Number(state.spentUsd) || 0) + (Number(state.reservedUsd) || 0);
      line += ` · today ${formatOpenAIImageUsd(todayUsd)} of ${state.capUsd.toFixed(2)} (${Math.round((todayUsd / state.capUsd) * 100)} %)`;
    }
    return line;
  }

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
    // that send no attemptId (workers of an earlier version, the server's
    // own image finalization) keep the legacy conditional semantics.
    const claimedAttemptId = String(req.body.attemptId || '').trim() || null;
    if (claimedAttemptId && q && String(q.attempt_id || '') !== claimedAttemptId) {
      staleAttemptLog.note({ messageId, attemptId: claimedAttemptId, currentAttemptId: q.attempt_id, route: 'response', status: q.status });
      return res.status(409).json({ error: 'stale_attempt', currentStatus: q.status });
    }
    if (!claimedAttemptId && q && q.status === 'processing') {
      console.log(`[${ts()}] FENCE     ${messageId?.slice(0,8)} legacy unfenced response write`);
    }

    // The partial previews of an image turn go once its reply or its
    // failure note is stored (or was already).
    if (q && q.status === 'done') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_done`);
      imagePreviews.finish(messageId, 'done');
      return res.json({ ok: true, ignored: 'already_done' });
    }
    if (q && q.status === 'failed') {
      console.log(`[${ts()}] RESPONSE  ${messageId?.slice(0,8)} ignored=already_failed`);
      imagePreviews.finish(messageId, 'failed');
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
      imagePreviews.finish(messageId, 'failed');
      return res.json({ ok: true, terminal: true, code: terminalFailure.stableCode });
    }

    const conversation = stmts.getConvAnyStatus?.get?.(targetConversationId) || null;
    let resolvedText = await resolveRelayResponseText({
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
    // An image turn whose model wrote no text: the reply line says what came
    // back ("1 image · 1536x1024 · gpt-image-2"), so the chat and an agent
    // that reads text only see the same.
    const imageTurnModel = [resolvedAssistantModel, requestedModel].find((candidate) => isOpenAIImageModelId(candidate)) || '';
    const imageSummaryLine = Boolean(!resolvedText && generatedImageAttachments.length && (q?.image_operation_id || imageTurnModel));
    if (imageSummaryLine) {
      resolvedText = openAIImageReplyLine({
        images: generatedImageAttachments,
        model: imageTurnModel || resolvedAssistantModel || '',
        turnId: messageId,
      });
    }
    // The image request came through on its second try, and the first may
    // have been billed as well: the reply says so, on the reply line when
    // that is the text, so an agent that reads text only sees it too.
    const imageNote = generatedImageAttachments.length
      ? String(req.body.imageNote || '').trim().slice(0, OPENAI_IMAGE_NOTE_MAX)
      : '';
    if (imageNote) {
      resolvedText = imageSummaryLine
        ? `${resolvedText}. Note: ${imageNote}`
        : `${String(resolvedText || '').trimEnd()}${resolvedText ? '\n\n' : ''}Note: ${imageNote}`;
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
        imagePreviews.finish(messageId, 'done');
      } else if (currentStatus === 'failed') {
        io.emit('message_status', { messageId, conversationId: targetConversationId, status: 'failed' });
        imagePreviews.finish(messageId, 'failed');
      }
      return res.json({ ok: true, ignored: 'not_pending_or_processing', actualStatus: currentStatus });
    }
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
    if (q?.owner_sdk_session_id) {
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
      } catch {
        try {
          await delay(USAGE_FETCH_RETRY_DELAY_MS);
          const summary = await fetchUsageSummaryPromise(fetchUsageSummary);
          usageSnapshot = usageSnapshotFromSummary(summary, previousUsageSnapshot, {
            source: 'live-retry',
            stale: false,
            capturedAt: now,
          });
        } catch {
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
    // The final images are in the chat: the previews go.
    imagePreviews.finish(messageId, generatedImageAttachments.length ? 'done' : 'failed');
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
  // after finalization are legitimate), and writers without an attemptId
  // (older workers) keep legacy behavior.
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
    // The row's place in the turn's order (thoughts and tool lines share
    // it): numbered and written in one IMMEDIATE transaction, so two writers
    // on the same turn never get the same number.
    let turnSeq = null;
    const insertActivityRow = () => {
      turnSeq = stmts.nextTurnSeq?.(messageId) ?? null;
      return stmts.insertActivity.run(
        messageId,
        responseMessageId,
        conversationId,
        normalizeRelayMode(mode) || DEFAULT_RELAY_MODE,
        activityText,
        new Date().toISOString(),
        normalizedSubagentRunId,
        normalizedMetadata ? JSON.stringify(normalizedMetadata) : null,
        turnSeq,
      );
    };
    const insertActivityTx = typeof db?.transaction === 'function' ? db.transaction(insertActivityRow) : null;
    const activityRow = typeof insertActivityTx?.immediate === 'function'
      ? insertActivityTx.immediate()
      : insertActivityRow();
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
      ...(turnSeq !== null ? { turnSeq } : {}),
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
    // The thought's place in the turn's order: given on its first write and
    // kept by every update, so a thought sits where its first chunk arrived.
    let turnSeq = null;
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
              return { seq: existingSeq, turnSeq: existingThought.turn_seq == null ? null : Number(existingThought.turn_seq) };
            }
          }
          const row = stmts.getLastThoughtSeqByQueueMessage?.get(messageId);
          const maxSeq = Math.max(0, Number(row?.max_seq || 0));
          const nextSeq = maxSeq + 1;
          const nextTurn = stmts.nextTurnSeq?.(messageId) ?? null;
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
            nextTurn,
          );
          return { seq: nextSeq, turnSeq: nextTurn };
        });
        const runInsertThought = typeof insertThoughtTx?.immediate === 'function'
          ? insertThoughtTx.immediate.bind(insertThoughtTx)
          : insertThoughtTx;
        const maxRetries = 4;
        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
          try {
            ({ seq, turnSeq } = runInsertThought());
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

    // An update in flight (done false) is volatile, as relay_stream: each one
    // carries the whole thought so far (up to MAX_THOUGHT_CHARS), so keeping
    // them in the connection-state-recovery buffer, or queueing them on a
    // socket that does not drain, holds a turn's worth of copies — gigabytes
    // for a few long reasoning turns at once. A reconnect resync reads the
    // stored snapshot instead; the final thought (done) is never dropped.
    (done ? io : io.volatile).emit('relay_thought', {
      messageId,
      conversationId,
      mode: relayMode,
      reasoningId: normalizedReasoningId,
      text: thoughtText,
      done: !!done,
      seq,
      timestamp: now,
      subagentRunId: normalizedSubagentRunId || undefined,
      ...(turnSeq !== null ? { turnSeq } : {}),
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
}
