import { deriveModelOrigin, normalizeSessionWorkerId } from './messages-helpers.mjs';

// The terminal failure of a queue row: the row is marked failed (fenced on
// its attempt when one is named), a failure reply is stored with the turn's
// partial output linked to it, and the turn's sub-agents, clients, push,
// relay events and worker bookkeeping are told. It keeps no state of its
// own: every effect goes through the objects it is made with.
export function createFailQueueMessage({
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
}) {
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
    const ownerSessionId = normalizeSessionWorkerId(queueRow?.owner_sdk_session_id);
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

  return failQueueMessage;
}
