'use strict';

// The stale-turn sweep: a `processing` row whose worker went silent, or whose
// turn ran past the max turn duration, goes back to the queue. Which rows
// qualify is decided by the repository (listRecoverableProcessing); this
// module decides what happens to them: continuations are torn down, consumed
// rows fail terminally, rows out of retry budget fail, the rest are requeued
// and announced.

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

  // A Stop still pending for a requeued turn is settled: the attempt it was
  // aimed at is gone.
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
    const allRows = listedRows.filter((entry) => !entry?.consumed_at);
    if (!allRows.length) return [];
    // Enforce the retry budget before requeueing: failing these rows first
    // flips them out of 'processing' so the recovery UPDATE below skips them.
    const overBudget = allRows.filter((row) => Number(row?.retry_count || 0) + 1 >= maxRequeueRetries);
    for (const row of overBudget) {
      failRecoveredRowTerminally(row, 'stale-recovery');
      noteRestartTurnOutcome(row, 'failed');
    }
    const dueRows = allRows.filter((row) => Number(row?.retry_count || 0) + 1 < maxRequeueRetries);
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

  return { recoverProcessingOlderThan };
}
