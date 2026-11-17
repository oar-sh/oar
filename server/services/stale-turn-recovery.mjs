'use strict';

import { buildRelayStopFailure } from '../../shared/relay-stop-failure.mjs';

// The stale-turn sweep: a `processing` row whose worker went silent, or whose
// turn ran past the max turn duration, goes back to the queue. Which rows
// qualify is decided by the repository (listRecoverableProcessing); this
// module decides what happens to them: continuations are torn down, consumed
// rows fail terminally, rows of an archived chat and rows out of retry budget
// fail, a row with the user's Stop pending ends as stopped, the rest are
// requeued and announced. A sub-agent's Stop still pending on a requeued row
// is settled here; a failed row's Stops and question cards end in
// the failure's own transaction (settleFailedRowControlsAndCards).

/**
 * `failRecoveredRowTerminally(row, reason)`, `failConsumedRowTerminally(row,
 * reason)` and `noteRestartTurnOutcome(row, outcome)` are the runtime's own;
 * `emit(event, payload)` is the socket broadcast.
 */
export function createStaleTurnRecovery({
  db,
  stmts,
  emit,
  maxRequeueRetries,
  failRecoveredRowTerminally,
  failConsumedRowTerminally,
  noteRestartTurnOutcome,
  warn = (line) => console.warn(line),
} = {}) {
  if (!db) throw new Error('createStaleTurnRecovery requires db');
  if (!stmts) throw new Error('createStaleTurnRecovery requires stmts');
  if (typeof emit !== 'function') throw new Error('createStaleTurnRecovery requires emit');

  // A sub-agent's Stop still pending for a requeued turn is settled: the
  // attempt it was aimed at is gone (a turn's Stop never gets here: its turn
  // ends as stopped, failIfStopRequested).
  const settleRecoveredAbortControls = db.prepare(`
    UPDATE relay_control_requests
    SET status = 'failed',
        error = ?,
        updated_at = ?,
        completed_at = ?
    WHERE queue_message_id = ?
      AND type IN ('abort_turn', 'abort_subagent')
      AND status IN ('pending', 'processing')
  `);
  const isConversationArchived = db.prepare(`SELECT 1 AS archived FROM conversations WHERE id = ? AND archived = 1`);
  const findPendingTurnStop = db.prepare(`
    SELECT 1 AS present FROM relay_control_requests
    WHERE queue_message_id = ? AND type = 'abort_turn' AND status IN ('pending', 'processing')
    LIMIT 1
  `);

  // How the archive ends a turn no worker will finish
  // (conversation-lifecycle-routes.mjs): a pending row of an archived chat is
  // neither claimed nor woken, so a requeue would leave it waiting for good.
  function failArchivedRow(row, reason) {
    const failureRecord = {
      kind: 'terminal',
      error: 'conversation-archived',
      code: 'conversation-archived',
      stableCode: 'relay.conversation-archived',
      message: 'This chat was archived while this reply was not finished.',
      guidance: 'Unarchive the chat and send the message again to continue.',
      reason,
      failedAt: new Date().toISOString(),
    };
    failRecoveredRowTerminally(row, 'conversation-archived', {
      failureRecord,
      failureText: `${failureRecord.message} Error code: ${failureRecord.stableCode}. ${failureRecord.guidance}`,
    });
    noteRestartTurnOutcome(row, 'failed');
  }

  // The dead-worker sweep's (server-runtime.mjs, recoverDeadWorkerProcessingRows)
  // per row, read when it handles the row: true when the row's chat is
  // archived and the row was failed as above.
  function failIfArchived(row, reason) {
    if (!isConversationArchived.get(row.conversation_id)) return false;
    failArchivedRow(row, reason);
    return true;
  }

  // A turn whose worker died or went silent with the user's Stop still
  // waiting for it (both sweeps): a replay would run the prompt the user stopped, so it ends as stopped, as
  // the Stop's own completion ends it (messages-routes.mjs). Only a Stop of
  // the turn: a sub-agent's Stop leaves the turn to the requeue. True when
  // the row was so handled.
  function failIfStopRequested(row, reason) {
    if (!findPendingTurnStop.get(row.id)) return false;
    const failureRecord = { ...buildRelayStopFailure(), reason };
    failRecoveredRowTerminally(row, reason, {
      failureRecord,
      failureText: `${failureRecord.message} Error code: ${failureRecord.stableCode}. ${failureRecord.guidance}`,
    });
    noteRestartTurnOutcome(row, 'failed');
    return true;
  }

  function recoverProcessingOlderThan(cutoffIso, requeueAtIso, { ceilingBeforeIso = null } = {}) {
    const params = { inactiveBefore: cutoffIso, ceilingBefore: ceilingBeforeIso || null };
    // Stale background-continuation turns are torn down, never requeued —
    // replaying one would deliver the CLI's own continuation as a user prompt.
    const staleContinuations = stmts.listStaleProcessingContinuations?.all?.(params) || [];
    for (const row of staleContinuations) {
      stmts.dropStaleContinuation?.run?.(row.id);
      emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'failed' });
      noteRestartTurnOutcome(row, 'cut');
      // A teardown is a turn ending with no reply; it must be visible in the
      // console log (the only trace of a silent one was `ignored=already_failed`
      // hours later, when the worker's reply arrived for the dead row).
      const lastSeen = row.owner_last_claimed_at || row.processing_at || row.timestamp || null;
      const reason = lastSeen && lastSeen < cutoffIso ? `inactive since ${lastSeen}` : `ceiling (started ${row.processing_at || row.timestamp})`;
      warn(`STALE CONTINUATION ${String(row.id).slice(0, 8)} conv=${String(row.conversation_id).slice(0, 8)} dropped: ${reason}`);
    }
    const listedRows = stmts.listRecoverableProcessing.all(params);
    for (const row of listedRows.filter((entry) => entry?.consumed_at)) {
      failConsumedRowTerminally(row, 'stale-recovery');
      noteRestartTurnOutcome(row, 'cut');
    }
    const unconsumedRows = listedRows.filter((entry) => !entry?.consumed_at);
    const archivedRows = unconsumedRows.filter((row) => !!isConversationArchived.get(row.conversation_id));
    for (const row of archivedRows) failArchivedRow(row, 'stale-recovery');
    const allRows = unconsumedRows.filter((row) => !archivedRows.includes(row));
    if (!allRows.length) return [];
    // Enforce the retry budget before requeueing: failing these rows first
    // flips them out of 'processing' so the recovery UPDATE below skips them.
    const overBudget = allRows.filter((row) => Number(row?.retry_count || 0) + 1 >= maxRequeueRetries);
    for (const row of overBudget) {
      failRecoveredRowTerminally(row, 'stale-recovery');
      noteRestartTurnOutcome(row, 'failed');
    }
    // A turn the user stopped is not replayed: it ends as stopped, as the
    // dead-worker sweep ends it. A sub-agent's Stop leaves it to the requeue.
    const dueRows = allRows
      .filter((row) => Number(row?.retry_count || 0) + 1 < maxRequeueRetries)
      .filter((row) => !failIfStopRequested(row, 'stale-recovery'));
    if (!dueRows.length) return [];

    // Requeue exactly the listed rows, and announce only the ones the
    // UPDATE took (its re-check of the rule is a safeguard; nothing runs
    // between the listing and here).
    const rows = [];
    const tx = db.transaction(() => {
      const now = new Date().toISOString();
      for (const row of dueRows) {
        if (stmts.recoverProcessingBefore.run({ ...params, id: row.id, requeueAt: requeueAtIso }).changes === 0) continue;
        settleRecoveredAbortControls.run('queue-recovered', now, now, row.id);
        rows.push(row);
      }
    });
    tx();
    if (!rows.length) return [];

    for (const row of rows) {
      emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'pending' });
      noteRestartTurnOutcome(row, 'requeued');
    }
    emit('queue_updated', { recovered: rows.length });
    return rows;
  }

  return { recoverProcessingOlderThan, failIfArchived, failIfStopRequested };
}
