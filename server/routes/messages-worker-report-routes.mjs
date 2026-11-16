import { normalizeWorkerKind, normalizeWorkerSteeringSnapshot } from '../services/session-worker-registry-service.mjs';
import { claudePlanUsageFromResult, normalizeClaudePlanUsage } from '../services/plan-usage-claude.mjs';
import { normalizeCopilotWorkerUsage } from '../services/plan-usage-copilot.mjs';
import { normalizeGrokTurnUsage } from '../services/plan-usage-grok.mjs';
import { normalizeDeepSeekUsageReport } from '../services/plan-usage-deepseek.mjs';
import { normalizeBackgroundTaskDigest } from '../../shared/worker-runtime/background-task-digest.mjs';
import { normalizeBuildId } from '../../shared/build-id.mjs';
import { recordClaudeCliStart } from '../services/claude-session-leftovers.mjs';
import { normalizeClaudeBilling } from '../services/claude-billing-switch-service.mjs';
import { normalizeTurnTokenUsageReport } from '../../shared/turn-token-usage.mjs';
import { normalizeClaudeApiUsageReport } from '../services/claude-api-usage-service.mjs';
import {
  SESSION_WORKER_OWNER_LEASE_MS,
  addMsToIso,
  buildTerminalFailureTextForChat,
  normalizeSessionWorkerId,
} from './messages-helpers.mjs';

// The reports a session worker posts: its heartbeat (with the recovery of
// the rows it no longer holds), its native session ids, and its context,
// plan, API and token usage, usage limit and Cursor agent id.

const SESSION_WORKER_IDLE_RECOVERY_GRACE_MS = 5_000;

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

// `deps` is the object registerMessagesRoutes gets; `shared` carries what
// that function resolved or built itself (the deps that have a default
// there, and its own helpers), as the same values.
export function registerMessagesWorkerReportRoutes(app, deps, shared) {
  const {
    auth,
    io,
    db,
    stmts,
    touchCli,
    ts,
    queueCounts,
    backgroundTaskStore,
    sessionWorkerRegistry,
    sessionWorkerSupervisor,
    addMsIso,
    normalizeRelayMode,
    DEFAULT_RELAY_MODE,
    relayActivityForQueueMessage,
  } = deps;
  const {
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
  } = shared;

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
          || (stored.backgroundTaskCount || 0) !== (steering.backgroundTaskCount || 0)
          // Whether the worker's CLI child still runs: the worker recycle
          // waits for it to be gone, so a flip must be stored.
          || (stored.cliAlive ?? null) !== (steering.cliAlive ?? null);
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
      // The build id of the code the worker started on, recorded the same way:
      // only when it says one and the registry has another, so quiet
      // heartbeats stay write-free.
      const heartbeatBuildId = normalizeBuildId(req.body?.buildId);
      if (heartbeatBuildId) {
        const workerForBuild = sessionWorkerRegistry?.getWorker?.(requesterSessionId) || null;
        if (workerForBuild && workerForBuild.buildId !== heartbeatBuildId) {
          sessionWorkerRegistry?.upsertWorker?.({ ...workerForBuild, buildId: heartbeatBuildId });
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
    const { pendingCount } = queueCounts();
    res.json({
      ok: true,
      pendingCount,
      ...(settleFailedHandled.length ? { settleFailedHandled } : {}),
      ...(settleFailedSkipped.length ? { settleFailedSkipped } : {}),
      ...(resyncBackgroundTasks ? { resyncBackgroundTasks: true } : {}),
    });
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

  // POST /api/turn-token-usage — every worker reports, after a turn, the
  // turn's tokens per model (`models`), or a Claude cloud worker the
  // session's running totals (`sessionTotals`), keyed by turn, run and model
  // (shared/turn-token-usage.mjs). Advisory and idempotent: a retried or
  // reordered report books only what it adds (token-usage-service.mjs).
  // Who ran the turn is the relay's to say: the chat's provider, and for a
  // Claude chat the posting worker's registered kind (the billing can switch
  // between turns). A body that says otherwise is logged. A deleted chat
  // takes no report, so a late retry cannot book its turn a second time; an
  // archived one does.
  app.post('/api/turn-token-usage', auth, (req, res) => {
    touchCli();
    if (!tokenUsageService) return res.status(501).json({ error: 'Token usage storage is unavailable' });
    const parsed = normalizeTurnTokenUsageReport(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const { report } = parsed;
    const conversationId = report.conversationId;
    if (!stmts.getConv?.get?.(conversationId)) return res.status(404).json({ error: 'Conversation not found' });
    // The binding's provider wins over the report's. A chat whose binding is
    // gone for a moment (a cache rebuild) still books, as the provider the
    // report states.
    const runtimeSession = stmts.getRuntimeSessionByConversation?.get?.(conversationId) || null;
    const chatProvider = String(runtimeSession?.provider_type || report.provider || '').trim().toLowerCase();
    let provider = chatProvider;
    let billing = '';
    if (chatProvider === 'openai') {
      // A chat on the user's own OpenAI key runs on the Copilot SDK.
      provider = 'github';
      billing = 'byok-openai';
    } else if (chatProvider === 'github') {
      billing = report.billing;
    } else if (normalizeClaudeBilling(chatProvider)) {
      const requesterSid = normalizeSessionWorkerId(readBridgeIdentity(req)?.sessionId);
      const registeredKind = normalizeClaudeBilling(requesterSid ? sessionWorkerRegistry?.getWorker?.(requesterSid)?.kind : '');
      // The worker that ran the turn, then the chat's billing; the report's
      // own word only when the chat has no binding.
      provider = registeredKind || normalizeClaudeBilling(chatProvider);
    } else if (!['claude-cloud', 'deepseek', 'cursor', 'grok'].includes(chatProvider)) {
      return res.status(409).json({ error: 'Conversation keeps no token usage' });
    }
    if (report.provider && report.provider !== provider) {
      console.warn(`[${ts()}] token usage conv=${conversationId.slice(0, 8)} stated=${report.provider} booked=${provider}`);
    }
    if (report.sessionTotals && provider !== 'claude-cloud') {
      return res.status(400).json({ error: 'sessionTotals is for Claude cloud only' });
    }
    const booked = report.sessionTotals
      ? tokenUsageService.recordCloudSessionTotals({ conversationId, provider, billing, report })
      : tokenUsageService.recordTurn({ conversationId, provider, billing, report });
    if (!booked) return res.status(501).json({ error: 'Token usage storage is unavailable' });
    res.json({ ok: true, provider, billing, models: booked.map((entry) => entry.model) });
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
}
