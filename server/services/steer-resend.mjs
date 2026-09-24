// Resend of a steer a Stop cut off unanswered (kind='stopped'): shared by the
// POST /api/message guard and the transcript payload, so "Resent" on screen
// and the relay's refusal of a second Resend agree.

/**
 * Whether an earlier Resend still stands. A cancelled queued message loses
 * its queue row; a failed one keeps it as 'failed'; a finished one may have
 * been pruned from the queue, which its answer (linked by source) proves.
 */
export function isLiveResend({ hasQueueRow = false, queueStatus = null, answered = false } = {}) {
  if (hasQueueRow) {
    return !['failed', 'cancelled'].includes(String(queueStatus || '').trim().toLowerCase());
  }
  return !!answered;
}

/**
 * Original message id → the id of a Resend of it that still stands, from one
 * conversation's messages (DB rows) and queue rows ({ id, status }).
 */
export function liveResendsByOriginal(dbMessages = [], queueRows = []) {
  const queueById = new Map((Array.isArray(queueRows) ? queueRows : [])
    .map((row) => [String(row?.id || '').trim(), row]));
  const answeredSources = new Set();
  for (const message of Array.isArray(dbMessages) ? dbMessages : []) {
    if (message?.role !== 'assistant') continue;
    const source = String(message?.source_message_id || '').trim();
    if (source) answeredSources.add(source);
  }
  for (const row of queueById.values()) {
    if (row?.response_message_id) answeredSources.add(String(row.id || '').trim());
  }
  const result = new Map();
  for (const message of Array.isArray(dbMessages) ? dbMessages : []) {
    if (message?.role !== 'user') continue;
    const original = String(message?.resend_of_message_id || '').trim();
    if (!original || result.has(original)) continue;
    const id = String(message?.id || '').trim();
    const queueRow = queueById.get(id);
    if (isLiveResend({ hasQueueRow: !!queueRow, queueStatus: queueRow?.status, answered: answeredSources.has(id) })) {
      result.set(original, id);
    }
  }
  return result;
}
