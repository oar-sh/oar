'use strict';

// Queue rows that no worker will ever take, ended instead of left pending.
// A pending row counts in the status counts and holds the host awake as a
// running turn (listActiveQueueCountsByConversation), so one that never runs
// does both for good.

// A deleted conversation's queue is removed by the delete itself, right
// after it marks the conversation deleted; the sweep leaves it this long.
export const GONE_CONVERSATION_GRACE_MS = 60_000;

// A row bound to no session waited for a worker the relay never started,
// before the conversation id became the last owner fallback. One that waited
// longer than this is ended at boot instead of running that late.
export const OWNERLESS_ROW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const id8 = (value) => String(value || '').slice(0, 8);

// The failure record of a row that waited for a worker and did not run, as
// /api/requeue writes it for one that ran out of attempts.
function waitedOutRecord({ reason, message, failedAt }) {
  return {
    kind: 'requeue-timeout',
    error: 'timeout',
    code: 'retry-timeout',
    stableCode: 'relay.retry-timeout',
    reason,
    message,
    failedAt,
  };
}

/**
 * Fails the pending rows whose conversation is gone: missing, or deleted
 * longer ago than `graceMs`. There is no transcript to write to, so the row
 * is failed and announced, and one QUEUE line names it. Returns how many.
 */
export function failRowsOfGoneConversations({
  stmts,
  nowMs = Date.now(),
  graceMs = GONE_CONVERSATION_GRACE_MS,
  emit = () => {},
  log = () => {},
} = {}) {
  const cutoff = new Date(nowMs - graceMs).toISOString();
  const failedAt = new Date(nowMs).toISOString();
  let failed = 0;
  for (const row of stmts.listPendingRowsOfGoneConversations.all(cutoff)) {
    const record = waitedOutRecord({
      reason: 'conversation-gone',
      message: 'Its conversation is gone, the turn did not run.',
      failedAt,
    });
    // Compare-and-set on the status: a row settled meanwhile stays settled.
    if (stmts.setFailed.run(JSON.stringify(record), row.id).changes === 0) continue;
    failed += 1;
    emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'failed' });
    log(`QUEUE     failed ${id8(row.id)} conv=${id8(row.conversation_id)} reason=conversation-gone`);
  }
  return failed;
}

/**
 * Once at boot, before the first prime: reports the pending rows of live
 * conversations that are bound to no session, and fails those sent more
 * than `maxAgeMs` ago, with a note in their conversation. Younger ones are
 * left to run on their conversation's worker. Returns `{ count, oldestAt,
 * failed }`.
 */
export function failStaleOwnerlessRowsAtBoot({
  db,
  stmts,
  nowMs = Date.now(),
  maxAgeMs = OWNERLESS_ROW_MAX_AGE_MS,
  uuid,
  emit = () => {},
  log = () => {},
  noteError = () => {},
} = {}) {
  const summary = stmts.summarizeUnboundPendingRows.get() || null;
  const count = Number(summary?.count || 0);
  if (!count) return { count: 0, oldestAt: null, failed: 0 };
  const oldestAt = summary.oldest_at || null;
  const now = new Date(nowMs).toISOString();
  let failed = 0;
  for (const row of stmts.listUnboundPendingRowsBefore.all(new Date(nowMs - maxAgeMs).toISOString())) {
    const text = `This message waited since ${row.timestamp} for a worker the relay never started. It was not run; resend it if it is still wanted.`;
    const record = waitedOutRecord({ reason: 'ownerless-at-upgrade', message: text, failedAt: now });
    const responseId = uuid();
    const model = String(row.model || '').trim() || null;
    const mode = String(row.relay_mode || '').trim() || null;
    const written = db.transaction(() => {
      if (stmts.setFailed.run(JSON.stringify(record), row.id).changes === 0) return false;
      stmts.setQueueResponseMessageId?.run(responseId, row.id);
      stmts.insertMsg.run(responseId, row.conversation_id, 'assistant', text, model || 'unknown', mode, null, now, model, null, model ? 'user' : 'auto');
      stmts.setMessageSourceId?.run(row.id, responseId);
      stmts.updateConvTime?.run(now, row.conversation_id);
      return true;
    })();
    if (!written) continue;
    failed += 1;
    emit('assistant_message', {
      conversationId: row.conversation_id,
      sourceMessageId: row.id,
      messageId: responseId,
      message: { role: 'assistant', text, model: model || 'unknown', mode, timestamp: now },
    });
    emit('message_status', { messageId: row.id, conversationId: row.conversation_id, status: 'failed' });
    try { noteError({ conversationId: row.conversation_id, kind: 'turn_failed', message: text, queueMessageId: row.id }); } catch {}
  }
  const ageHours = oldestAt ? Math.floor((nowMs - Date.parse(oldestAt)) / 3_600_000) : 0;
  log(`QUEUE     ownerless pending rows=${count} oldest=${oldestAt || 'unknown'} age=${ageHours}h failed=${failed} (waited longer than ${Math.round(maxAgeMs / 3_600_000)}h)`);
  return { count, oldestAt, failed };
}
