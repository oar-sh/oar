import { randomUUID } from 'crypto';
import { normalizeWorkerKind } from '../services/session-worker-registry-service.mjs';
import { STEER_SETTLE_FAILED_STABLE_CODE } from '../../shared/steer-settle-failure.mjs';
import { validateOpenAIImageOptions } from '../../shared/openai-image-options.mjs';
import { isRelayAutomatedMessageKind } from '../../shared/relay-events.mjs';
import { isRelayShutdownQueued, relayShutdownGateReply } from '../services/relay-shutdown-gate.mjs';
import { buildClaudeCloudDelivery, isClaudeCloudProviderType } from '../services/claude-cloud-session-service.mjs';
import { normalizeClaudeBilling } from '../services/claude-billing-switch-service.mjs';
import {
  SESSION_WORKER_OWNER_LEASE_MS,
  addMsToIso,
  buildTerminalFailureTextForChat,
  delay,
  normalizeOpenAIImageSize,
  normalizeSessionWorkerId,
  normalizeTerminalErrorCode,
  resolveTerminalFailurePayload,
} from './messages-helpers.mjs';

// The claim side of a session worker's queue: the claim itself (the HTTP
// poll and the socket delivery's dequeue), the message it is handed, the
// rows its runtime consumed or dropped, and the requeue of a row it could
// not process.

export const SESSION_WORKER_TRANSIENT_DEQUEUE_RETRIES = 2;
export const SESSION_WORKER_TRANSIENT_DEQUEUE_BACKOFF_MS = 25;

// A quality or size any image model family takes (shared/openai-image-options.mjs),
// or ''. The model's own family is checked where the request is built.
function normalizeOpenAIImageQuality(value = '') {
  const checked = validateOpenAIImageOptions({ quality: value });
  return checked.ok ? (checked.values.quality || '') : '';
}

function isTransientQueueError(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('database is locked') || message.includes('database busy');
}

function emitWorkerLoopTelemetry(telemetry, payload = {}) {
  if (typeof telemetry !== 'function') return;
  try {
    telemetry(payload);
  } catch {
    // Never break queue dequeue flow due to telemetry callback failures.
  }
}

/**
 * Whether a pending row must wait for its conversation's live turn to end
 * instead of being handed to the worker, which would steer it into that turn.
 * A steer switches the live turn's mode (the Claude worker re-applies the
 * permission mode on every delivery), so across plan mode it would change
 * what the running turn may do: an "Approve plan" follow-up would give a
 * running plan turn write access, and a plan message would take it from a
 * running write turn. Rows on the same side of plan mode steer as before.
 */
export function crossesPlanBoundaryOfLiveTurn({ stmts, row } = {}) {
  const conversationId = String(row?.conversation_id || '').trim();
  if (!conversationId || typeof stmts?.listProcessingQueueByConversation?.all !== 'function') return false;
  const isPlan = (mode) => String(mode || '').trim().toLowerCase() === 'plan';
  const pendingIsPlan = isPlan(row.relay_mode);
  return stmts.listProcessingQueueByConversation.all(conversationId)
    .some((live) => String(live?.id || '') !== String(row.id || '') && isPlan(live?.relay_mode) !== pendingIsPlan);
}
export function dequeuePendingMessage({
  db,
  stmts,
  nowIso,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
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
  // Only a worker that names its session claims, and only that session's
  // rows: there is no claim for a requester without one.
  if (!requesterSid) return null;
  const leaseExpiresAt = addMsToIso(currentIso, ownerLeaseMs);
  let fenced = null;
  const dequeue = db.transaction(() => {
    const next = stmts.findPendingForWorker.get(currentIso, requesterSid);
    if (!next) return null;
    fenced = claudeBillingFence({ stmts, row: next, workerKind, claudeApiClaimCheck });
    if (fenced) return null;
    // Across plan mode, a row waits for the live turn instead of steering in.
    // The claim statement leaves such rows out (planBoundaryHoldSql); this is
    // the fail-closed backstop for one that does not.
    if (crossesPlanBoundaryOfLiveTurn({ stmts, row: next })) return null;
    // One processing attempt = one attempt_id. Minted here for every claim —
    // even for callers that never echo it back — so finalization, requeue, and
    // question writes can be fenced to the attempt that actually owns the row.
    const attemptId = randomUUID();
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
  });
  const claimed = dequeue();
  if (fenced && typeof onBillingFence === 'function') {
    try { onBillingFence({ ...fenced, requesterSessionId: requesterSid }); } catch {}
  }
  return claimed;
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

export async function dequeuePendingMessageForWorkerLoop({
  db,
  stmts,
  nowIso,
  requesterSessionId = null,
  ownerLeaseMs = SESSION_WORKER_OWNER_LEASE_MS,
  sessionWorkerSupervisor = null,
  transientRetryLimit = SESSION_WORKER_TRANSIENT_DEQUEUE_RETRIES,
  transientRetryBackoffMs = SESSION_WORKER_TRANSIENT_DEQUEUE_BACKOFF_MS,
  telemetry = null,
  workerKind = null,
  onBillingFence = null,
  claudeApiClaimCheck = null,
  // () → true while the replacement fence (services/worker-replacement.mjs)
  // is up for the requesting process. The caller asks it before calling; it
  // is asked again before every claim, since ensureWorker and a transient
  // error's backoff both wait, and the worker recycle can raise the fence
  // meanwhile.
  isReplacementFenced = null,
} = {}) {
  const requesterSid = normalizeSessionWorkerId(requesterSessionId);
  const routingWithWorker = Boolean(requesterSid);
  let billingFenced = null;
  const retryLimit = Math.max(0, Number(transientRetryLimit) || 0);
  const backoffBaseMs = Math.max(1, Number(transientRetryBackoffMs) || 1);
  const supervisor = sessionWorkerSupervisor || null;

  if (routingWithWorker && typeof supervisor?.ensureWorker === 'function') {
    const killBlocked = supervisor?.isKillBlocked?.(requesterSid) === true;
    if (killBlocked) {
      const lifecycle = supervisor?.getLifecycleState?.(requesterSid) || null;
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
        attempts: 0,
      };
    }
    const ensureResult = await supervisor.ensureWorker(requesterSid);
    if (!ensureResult?.ok) {
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
        attempts: 0,
      };
    }
  }

  let attempt = 0;
  while (attempt <= retryLimit) {
    // The process asking is being replaced: no row is claimed for it, the
    // same answer as the caller's own fence check gives.
    if (routingWithWorker && typeof isReplacementFenced === 'function' && isReplacementFenced() === true) {
      return {
        message: null,
        blockedReason: 'worker-replacement',
        worker: supervisor?.getWorkerState?.(requesterSid) || null,
        lifecycle: supervisor?.getLifecycleState?.(requesterSid) || null,
        attempts: attempt,
      };
    }
    const currentIso = String(nowIso || '').trim() || new Date().toISOString();
    try {
      const message = dequeuePendingMessage({
        db,
        stmts,
        nowIso: currentIso,
        requesterSessionId: requesterSid,
        ownerLeaseMs,
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
  const imageOptions = parseQueueImageOptions(msg.image_options_json);
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
    // An image turn's options as the send settled them; a turn without an
    // operation sends them with its direct request.
    ...(imageOptions ? { imageOptions } : {}),
    ...(isRelayAutomatedMessageKind(messageKind) ? { messageKind } : {}),
  };
}

function parseQueueImageOptions(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

// `deps` is the object registerMessagesRoutes gets; `shared` carries what
// that function resolved or built itself (the deps that have a default
// there, and its own helpers), as the same values.
export function registerMessagesWorkerClaimRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    touchCli,
    ts,
    queueCounts,
    runtimeState,
    DEFAULT_MODEL,
    DEFAULT_RELAY_MODE,
    normalizeRelayMode,
    configuredConversationSessionMode,
    ensureRuntimeSessionBinding,
    hydrateAttachment,
    parseAttachments,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
  } = deps;
  const {
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
  } = shared;

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

    // As the pending cancel does: the row's pending question cards are
    // cancelled and read before the delete, which takes them along
    // (relay_questions.queue_id cascades), and announced once the delete
    // committed. No attempt of the row counts as current: every pending card
    // an attempt of the row asked is cancelled.
    const cancelledQuestions = [];
    const cancelPushedTurn = db.transaction(() => {
      const now = new Date().toISOString();
      for (const question of stmts.cancelPendingQuestionsForStaleAttempts?.all?.(now, messageId, '') || []) {
        const updated = stmts.getQuestion?.get?.(question.id) || null;
        if (updated && typeof deps.formatQuestionRow === 'function') cancelledQuestions.push(deps.formatQuestionRow(updated));
      }
      stmts.deleteQueueById.run(messageId);
    });
    cancelPushedTurn();
    // A processing row may carry open Stop controls (the live-turn picker can
    // land on it before it has output); they fail like on a requeue so no
    // caller waits on a row that no longer exists.
    settleRelayAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-cancelled' });
    settleRelaySubagentAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-cancelled' });

    io.emit('message_status', { messageId, conversationId, status: 'cancelled' });
    for (const question of cancelledQuestions) io.emit('relay_question_updated', { question });
    console.log(`[${ts()}] UNSTEERED ${messageId.slice(0, 8)} conv=${conversationId.slice(0, 8)}`);
    res.json({ ok: true, cancelled: true });
  });

  // GET /api/pending — a session's next row, for a process that plays the
  // session's worker over HTTP (the e2e fake worker); the workers take their
  // work over the worker socket. The poller names its session and gets that
  // session's rows only, through the claim the socket delivery uses.
  // The kind a poller is fenced as: the one its worker stated, else none, as
  // on the socket. A worker of unknown kind gets the rows of a chat that
  // never switched, and none of a chat that has (kind-unknown): such a chat
  // waits for a worker that says its kind.
  function httpPendingWorkerKind(requesterSessionId) {
    const stated = requesterSessionId ? sessionWorkerRegistry?.getWorker?.(requesterSessionId)?.kind : null;
    return normalizeWorkerKind(stated) || null;
  }

  app.get('/api/pending', auth, async (req, res) => {
    touchCli();
    const requester = readBridgeIdentity(req);
    const requesterSessionId = normalizeSessionWorkerId(requester?.sessionId);
    if (!requesterSessionId) {
      return res.status(400).json({ error: 'Missing x-relay-session-id: a poller names the session it works for' });
    }
    // On a relay that launches its workers, every one of them says its kind
    // before it asks for work. A process that polls for a session and never
    // said one (a Copilot CLI an earlier version started) is handed nothing
    // and is not registered: the turn waits for the session's worker.
    if (workersStateTheirKind?.() === true && !httpPendingWorkerKind(requesterSessionId)) {
      return res.json({ message: null, reason: 'worker-kind-unstated' });
    }
    const blocked = (blockedReason, lifecycle = null) => res.json({
      message: null,
      routing: { enabled: true, requesterSessionId, blockedReason, lifecycle },
    });
    if (sessionWorkerSupervisor?.isKillBlocked?.(requesterSessionId) === true) {
      return blocked('session-killed', sessionWorkerSupervisor?.getLifecycleState?.(requesterSessionId) || null);
    }
    // The process asking is being replaced (the worker recycle): no work,
    // as for a killed session, so no turn starts on the pid being stopped.
    // Unlike the killed marker, the fence outlives the marker's grace and
    // every clearRestartSchedule; the new worker has another pid and takes
    // what waited meanwhile.
    if (workerReplacementFence?.isHeld?.(requesterSessionId, requester?.pid) === true) {
      return blocked('worker-replacement', sessionWorkerSupervisor?.getLifecycleState?.(requesterSessionId) || null);
    }
    sessionWorkerSupervisor?.noteSessionHeartbeat?.(requesterSessionId);
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

    let dequeueResult = null;
    try {
      dequeueResult = await dequeuePendingMessageForWorkerLoop({
        db,
        stmts,
        nowIso: new Date().toISOString(),
        requesterSessionId,
        ownerLeaseMs: SESSION_WORKER_OWNER_LEASE_MS,
        sessionWorkerSupervisor,
        // No Claude worker polls here; one that does is fenced as on the
        // socket: by the kind it stated, the key's claim check, and a fenced
        // row asks for the swap or fails closed as there.
        workerKind: httpPendingWorkerKind(requesterSessionId),
        claudeApiClaimCheck,
        onBillingFence: onClaudeBillingFence,
        // The fence check above, asked again before every claim.
        isReplacementFenced: () => workerReplacementFence?.isHeld?.(requesterSessionId, requester?.pid) === true,
        telemetry: (payload = {}) => {
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
      console.warn(`[${ts()}] DEQUEUE   failed requester=${requesterSessionId.slice(0, 8)} err=${String(error?.message || error || 'unknown dequeue failure')}`);
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
      return res.status(500).json({ error: 'Failed to dequeue pending message' });
    }
    const msg = dequeueResult?.message || null;
    const dequeueBlockedReason = String(dequeueResult?.blockedReason || '').trim() || null;
    if (!msg && dequeueBlockedReason) {
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
        extra: { blockedReason: dequeueBlockedReason },
      });
      return blocked(dequeueBlockedReason, dequeueResult?.lifecycle || null);
    }
    if (!msg) {
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
      return res.json({ message: null, routing: { enabled: true, requesterSessionId } });
    }
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
    if (out.ownerSessionId) {
      const existingWorker = sessionWorkerRegistry?.getWorker?.(out.ownerSessionId) || null;
      sessionWorkerRegistry?.upsertWorker?.({
        ...(existingWorker || {}),
        sdkSessionId: out.ownerSessionId,
        conversationId: out.conversationId,
        runtimeSessionId: out.runtimeSessionId,
        status: 'processing',
      });
      sessionWorkerSupervisor?.markProcessing?.(out.ownerSessionId, Number(counts.processingCount || 0));
    }
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
    console.log(`[${ts()}] DEQUEUED  ${out.id.slice(0,8)} conv=${out.conversationId.slice(0,8)} rs=${String(out.runtimeSessionId || 'none').slice(0,8)} owner=${String(out.ownerSessionId || 'none').slice(0,8)} model=${out.model}${out.reasoningEffort ? ` effort=${out.reasoningEffort}` : ''} mode=${out.relayMode} text="${out.text.slice(0,60)}"${out.attachments.length ? ` attachments=${out.attachments.length}` : ''}`);
    io.emit('message_status', { messageId: out.id, conversationId: out.conversationId, status: 'processing' });
    res.json({ message: out, routing: { enabled: true, requesterSessionId } });
  });
}

// POST /api/requeue, registered last as before: it uses the image turn's
// previews and requeue stop, which exist once the image routes are.
export function registerMessagesWorkerRequeueRoute(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    ts,
    queueCounts,
    MAX_REQUEUE_RETRIES,
    DEFAULT_RELAY_MODE,
    normalizeRelayMode,
    addMsIso,
    computeRetryDelayMs,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
  } = deps;
  const {
    failQueueMessage,
    settleRelayAbortControlsForQueueMessage,
    settleRelaySubagentAbortControlsForQueueMessage,
    emitSessionWorkerTelemetry,
    staleAttemptLog,
    imagePreviews,
    imageTurnRequeueStop,
    failConsumedQueueRow,
  } = shared;

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
    const ownerSessionId = normalizeSessionWorkerId(q?.owner_sdk_session_id);
    const currentStatus = String(q?.status || '').trim().toLowerCase();
    const canTerminalFail = q && ['processing', 'pending', 'parked'].includes(currentStatus);
    // A branch that ends the worker's turn without a response tells the
    // registry the worker is idle, as /api/response does: a delivery left the
    // entry 'processing', and nothing else would clear it before the next one.
    const markOwnerIdle = () => {
      if (!ownerSessionId) return;
      const existingWorker = sessionWorkerRegistry?.getWorker?.(ownerSessionId) || null;
      sessionWorkerRegistry?.upsertWorker?.({
        ...(existingWorker || {}),
        sdkSessionId: ownerSessionId,
        status: 'ready',
      });
      sessionWorkerSupervisor?.markIdle?.(ownerSessionId, Number(queueCounts?.().pendingCount || 0));
    };
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
      markOwnerIdle();
      io.emit('message_status', { messageId, conversationId: q.conversation_id, status: 'failed' });
      console.log(`[${ts()}] CONTINUATION DROPPED ${messageId?.slice(0,8)} reason=requeue`);
      return res.json({ ok: true, dropped: 'continuation' });
    }
    if (q && q.status === 'processing' && q.consumed_at) {
      // The CLI already took this prompt: any requeue class would run it again.
      failConsumedQueueRow(q, { reason: 'requeue', attemptId: claimedAttemptId });
      return res.json({ ok: true, terminal: true, code: STEER_SETTLE_FAILED_STABLE_CODE });
    }
    if (q && q.status === 'processing') {
      // An image turn whose request went to OpenAI is never run again: a
      // second run is billed again. One still running here finishes the row
      // itself; one that ended, or was cut off, ends with the note.
      const imageStop = imageTurnRequeueStop(q);
      if (imageStop?.running) return res.json({ ok: true, held: 'image-request-running' });
      if (imageStop) {
        const failed = failQueueMessage({
          queueRow: q,
          messageId,
          conversationId: q.conversation_id,
          relayMode: normalizeRelayMode(q.relay_mode) || DEFAULT_RELAY_MODE,
          model: q.model || null,
          responseText: buildTerminalFailureTextForChat(imageStop.failure),
          failureRecord: {
            kind: 'terminal',
            error: 'image-not-requeued',
            code: normalizeTerminalErrorCode(imageStop.failure.code),
            stableCode: `relay.${normalizeTerminalErrorCode(imageStop.failure.code)}`,
            message: imageStop.failure.message,
            guidance: imageStop.failure.guidance,
            retryCount: Number(q.retry_count || 0),
            failedAt: new Date().toISOString(),
          },
          attemptId: claimedAttemptId,
        });
        if (failed) {
          settleRelayAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-terminal-failure' });
          settleRelaySubagentAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-terminal-failure' });
          console.warn(`[${ts()}] FAILED    ${messageId?.slice(0,8)} reason=image-not-requeued code=${imageStop.failure.code}`);
          imagePreviews.finish(messageId, 'failed');
        }
        return res.json({ ok: true, terminal: true, code: `relay.${normalizeTerminalErrorCode(imageStop.failure.code)}` });
      }
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
      // queue trigger) for the worker the billing swap brings up. That worker
      // runs no turn now and is marked idle; a steering-held worker's live
      // turn goes on.
      const result = db.prepare(`
        UPDATE queue
        SET status = 'pending', processing_at = NULL, attempt_id = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL
        WHERE id = ? AND status = 'processing'${claimedAttemptId ? ` AND attempt_id = ?` : ''}
      `).run(...(claimedAttemptId ? [messageId, claimedAttemptId] : [messageId]));
      if (result.changes > 0) {
        settleRelayAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-requeued' });
        settleRelaySubagentAbortControlsForQueueMessage(messageId, { ok: false, error: 'queue-requeued' });
        if (handBackClass === 'kind-mismatch') markOwnerIdle();
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
        const transientRequeue = isTransientRequeue({
          queueRow: q,
          relayActivityCount: stmts.listActivityByQueueMessage?.all?.(messageId)?.length || 0,
          relayStreamCount: stmts.listStreamEventsByQueueMessage?.all?.(messageId)?.length || 0,
        });
        const nextAttemptAt = addMsIso(computeRetryDelayMs(retryCount, { transient: transientRequeue }));
        const result = db.prepare(`
          UPDATE queue
          SET
            status = 'pending',
            processing_at = NULL,
            attempt_id = NULL,
            retry_count = ?,
            next_attempt_at = ?,
            owner_lease_expires_at = NULL
          WHERE id = ? AND status = 'processing'${claimedAttemptId ? ` AND attempt_id = ?` : ''}
        `).run(
          retryCount,
          nextAttemptAt,
          ...(claimedAttemptId ? [messageId, claimedAttemptId] : [messageId]),
        );
        if (result.changes > 0) {
          settleRelayAbortControlsForQueueMessage(messageId, {
            ok: false,
            error: 'queue-requeued',
          });
          settleRelaySubagentAbortControlsForQueueMessage(messageId, {
            ok: false,
            error: 'queue-requeued',
          });
          if (ownerSessionId) {
            sessionWorkerSupervisor?.markError?.(ownerSessionId, `requeue-retry:${retryCount}`);
            emitSessionWorkerTelemetry('queue.message.requeued', {
              sessionId: ownerSessionId,
              workerId: sessionWorkerRegistry?.getWorker?.(ownerSessionId)?.workerId || null,
              conversationId: q?.conversation_id || null,
              messageId,
              continuationId: null,
              state: 'pending',
              retry: retryCount,
              pid: null,
              extra: null,
            });
          }
          console.log(`[${ts()}] REQUEUED  ${messageId?.slice(0,8)} retry=${retryCount} class=${transientRequeue ? 'transient' : 'failure'} status=pending${nextAttemptAt ? ` next=${nextAttemptAt}` : ''}`);
          io.emit('message_status', { messageId, conversationId: q?.conversation_id, status: 'pending' });
        }
      }
    }
    res.json({ ok: true });
  });
}
