'use strict';

function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeMessageRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'assistant' || role === 'user') return role;
  return '';
}

function normalizeMessageTimestamp(value, fallbackIso) {
  const text = String(value || '').trim();
  if (!text) return fallbackIso;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return fallbackIso;
  return new Date(parsed).toISOString();
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseAttachments(value) {
  if (Array.isArray(value)) return value.filter((attachment) => attachment && typeof attachment === 'object');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((attachment) => attachment && typeof attachment === 'object') : [];
  } catch {
    return [];
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function attachmentSha256(attachment) {
  const sha256 = String(attachment?.sha256 || '').trim().toLowerCase();
  return SHA256_PATTERN.test(sha256) ? sha256 : '';
}

function attachmentSizeBytes(attachment) {
  const size = Number(attachment?.size ?? attachment?.size_bytes ?? attachment?.sizeBytes);
  return Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0;
}

function attachmentSignature(attachments, detail = { sha: true, size: true }) {
  const parts = ensureArray(attachments)
    .map((attachment) => {
      const sha256 = detail.sha ? attachmentSha256(attachment) : '';
      if (sha256) return `sha:${sha256}`;
      const name = String(attachment?.name || attachment?.displayName || '').trim().toLowerCase();
      const type = String(attachment?.type || attachment?.mimeType || '').trim().toLowerCase();
      if (!name && !type) return '';
      const size = detail.size ? attachmentSizeBytes(attachment) : 0;
      return `${name}\u0000${type}${size ? `\u0000${size}` : ''}`;
    })
    .filter(Boolean)
    .sort();
  return parts.length ? parts.join('\u0001') : '';
}

// SDK hint attachments never carry a sha256 in the fallback matching path
// (sha-bearing attachments are persisted directly) and their reported sizes
// are unreliable, so matching only uses the fields the hints actually have.
function signatureDetailForHints(hintAttachments) {
  const hints = ensureArray(hintAttachments).filter((attachment) => attachment && typeof attachment === 'object');
  return {
    sha: hints.length > 0 && hints.every((attachment) => !!attachmentSha256(attachment)),
    size: false,
  };
}

function attachmentTimestampDistance(left, right) {
  const leftMs = Date.parse(String(left || ''));
  const rightMs = Date.parse(String(right || ''));
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) return Number.POSITIVE_INFINITY;
  return Math.abs(leftMs - rightMs);
}

function candidateSignatureForHints(candidateAttachments, hintAttachments) {
  const hints = ensureArray(hintAttachments);
  const imageOnlyHints = hints.length > 0
    && hints.every((attachment) => String(attachment?.type || attachment?.mimeType || '').trim().toLowerCase().startsWith('image/'));
  const comparable = imageOnlyHints
    ? ensureArray(candidateAttachments).filter((attachment) => (
        String(attachment?.type || attachment?.mimeType || '').trim().toLowerCase().startsWith('image/')
      ))
    : candidateAttachments;
  return attachmentSignature(comparable, signatureDetailForHints(hintAttachments));
}

function normalizeActivityEntry(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = String(value.text || '').trim();
    if (!text) return null;
    const subagentRunId = value.subagentRunId ? String(value.subagentRunId).trim() : null;
    return { text, subagentRunId };
  }
  const text = String(value || '').trim();
  if (!text) return null;
  return { text, subagentRunId: null };
}

function normalizeThoughtEntry(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = String(value.text || '').trim();
  if (!text) return null;
  return {
    reasoningId: String(value.reasoningId || '').trim() || `history-thought-${index + 1}`,
    text,
    done: value.done !== false,
    subagentRunId: value.subagentRunId ? String(value.subagentRunId).trim() : null,
  };
}

export function createSessionHistoryRefreshService({
  db,
  stmts,
  parseSessionEventsToMessages = null,
  inFlightStateForConversation = null,
  isDeletedSdkSession = null,
} = {}) {
  const messageColumns = new Set(
    db.prepare(`PRAGMA table_info(messages)`).all().map((column) => String(column?.name || '').trim()),
  );
  const messagesSupportShareVisibility = messageColumns.has('hidden_from_shares')
    && messageColumns.has('share_hidden_at');
  const listExistingMessageAttachments = messageColumns.has('attachments')
    ? db.prepare(`
        SELECT id, attachments, timestamp
        FROM messages
        WHERE conversation_id = ? AND attachments IS NOT NULL
      `)
    : null;
  const listHiddenMessageVisibility = messagesSupportShareVisibility
    ? db.prepare(`
        SELECT id, role, text, timestamp, share_hidden_at
        FROM messages
        WHERE conversation_id = ? AND hidden_from_shares = 1
      `)
    : null;
  const restoreHiddenMessageVisibility = messagesSupportShareVisibility
    ? db.prepare(`
        UPDATE messages
        SET hidden_from_shares = 1, share_hidden_at = ?
        WHERE conversation_id = ? AND id = ?
      `)
    : null;
  const countBusyQueueByConversation = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM queue
    WHERE conversation_id = ?
      AND status IN ('pending', 'processing', 'parked')
  `);
  const countMessagesByConversation = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM messages
    WHERE conversation_id = ?
  `);
  const tableNames = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
      .map((row) => String(row?.name || '').trim()),
  );
  const queueColumns = tableNames.has('queue')
    ? new Set(db.prepare(`PRAGMA table_info(queue)`).all().map((column) => String(column?.name || '').trim()))
    : new Set();
  const listQueuedAttachments = queueColumns.has('attachments') && queueColumns.has('timestamp')
    ? db.prepare(`
        SELECT id, attachments, timestamp
        FROM queue
        WHERE conversation_id = ? AND attachments IS NOT NULL
      `)
    : null;
  const listReferencedAttachments = tableNames.has('upload_refs') && tableNames.has('uploaded_files')
    ? db.prepare(`
        SELECT
          ref.message_id,
          MIN(ref.created_at) AS timestamp,
          file.sha256,
          file.original_name,
          file.mime_type,
          file.size_bytes
        FROM upload_refs ref
        JOIN uploaded_files file ON file.sha256 = ref.file_sha256
        WHERE ref.conversation_id = ?
        GROUP BY ref.message_id, file.sha256, file.original_name, file.mime_type, file.size_bytes
        ORDER BY ref.message_id, MIN(ref.created_at), file.original_name
      `)
    : null;
  const insertUploadRef = tableNames.has('upload_refs')
    ? db.prepare(`
        INSERT OR IGNORE INTO upload_refs (file_sha256, conversation_id, message_id, created_at)
        VALUES (?, ?, ?, ?)
      `)
    : null;

  const deleteConversationMessages = typeof stmts?.deleteConvMsg?.run === 'function'
    ? stmts.deleteConvMsg
    : db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);
  const deleteConversationActivity = typeof stmts?.deleteConvActivity?.run === 'function'
    ? stmts.deleteConvActivity
    : db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`);
  const deleteConversationThoughts = typeof stmts?.deleteConvThoughts?.run === 'function'
    ? stmts.deleteConvThoughts
    : db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`);
  const deleteConversationStreamEvents = typeof stmts?.deleteConvStreamEvents?.run === 'function'
    ? stmts.deleteConvStreamEvents
    : db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`);
  const deleteConversationSubagentRuns = typeof stmts?.deleteConvSubagentRuns?.run === 'function'
    ? stmts.deleteConvSubagentRuns
    : db.prepare(`DELETE FROM subagent_runs WHERE conversation_id = ?`);

  function collectAttachmentCandidates(conversationId) {
    const candidates = new Map();
    const addCandidate = (sourceMessageId, attachments, timestamp, priority) => {
      const parsed = parseAttachments(attachments);
      const signature = attachmentSignature(parsed);
      if (!signature) return;
      const key = normalizeId(sourceMessageId) || `${signature}:${timestamp || ''}`;
      const existing = candidates.get(key);
      if (existing && existing.priority <= priority) return;
      candidates.set(key, {
        sourceMessageId: key,
        attachments: parsed,
        signature,
        timestamp: String(timestamp || '').trim(),
        priority,
      });
    };

    for (const row of listExistingMessageAttachments?.all(conversationId) || []) {
      addCandidate(row.id, row.attachments, row.timestamp, 0);
    }
    for (const row of listQueuedAttachments?.all(conversationId) || []) {
      addCandidate(row.id, row.attachments, row.timestamp, 1);
    }

    const referencedByMessage = new Map();
    for (const row of listReferencedAttachments?.all(conversationId) || []) {
      const messageId = normalizeId(row.message_id);
      if (!messageId) continue;
      const group = referencedByMessage.get(messageId) || {
        timestamp: row.timestamp,
        attachments: [],
      };
      group.attachments.push({
        name: String(row.original_name || '').trim(),
        type: String(row.mime_type || '').trim().toLowerCase(),
        size: Number(row.size_bytes || 0),
        sha256: String(row.sha256 || '').trim().toLowerCase(),
      });
      referencedByMessage.set(messageId, group);
    }
    for (const [messageId, group] of referencedByMessage) {
      addCandidate(messageId, group.attachments, group.timestamp, 2);
    }
    return Array.from(candidates.values());
  }

  function resolveRebuiltAttachments(message, candidates, consumedCandidates) {
    const messageAttachments = parseAttachments(message?.attachments);
    const persistedMessageAttachments = messageAttachments.filter((attachment) => (
      String(attachment?.sha256 || '').trim()
      || String(attachment?.contentUrl || '').trim()
      || String(attachment?.dataUrl || '').trim()
      || attachment?.generatedImage
    ));
    if (persistedMessageAttachments.length) return persistedMessageAttachments;

    const messageId = normalizeId(message?.id);
    const sameIdCandidate = candidates.find((candidate) => candidate.sourceMessageId === messageId);
    if (sameIdCandidate) {
      consumedCandidates.add(sameIdCandidate.sourceMessageId);
      return sameIdCandidate.attachments;
    }

    const signature = attachmentSignature(messageAttachments, signatureDetailForHints(messageAttachments));
    if (!signature) return [];
    const matching = candidates
      .filter((candidate) => (
        !consumedCandidates.has(candidate.sourceMessageId)
        && candidateSignatureForHints(candidate.attachments, messageAttachments) === signature
      ))
      .sort((left, right) => (
        attachmentTimestampDistance(left.timestamp, message?.timestamp)
          - attachmentTimestampDistance(right.timestamp, message?.timestamp)
        || left.priority - right.priority
      ));
    const selected = matching[0];
    if (!selected) return [];
    consumedCandidates.add(selected.sourceMessageId);
    return selected.attachments;
  }

  function insertRebuiltMessages(conversationId, messages = [], attachmentCandidates = []) {
    const nowIso = new Date().toISOString();
    const consumedAttachmentCandidates = new Set();
    for (const message of ensureArray(messages)) {
      const role = normalizeMessageRole(message?.role);
      if (!role) continue;
      const messageId = normalizeId(message?.id);
      if (!messageId) continue;
      const timestamp = normalizeMessageTimestamp(message?.timestamp, nowIso);
      const attachments = resolveRebuiltAttachments(message, attachmentCandidates, consumedAttachmentCandidates);
      stmts.insertMsg.run(
        messageId,
        conversationId,
        role,
        String(message?.text || ''),
        role === 'assistant' ? (String(message?.model || '').trim() || null) : null,
        String(message?.mode || '').trim() || null,
        attachments.length ? JSON.stringify(attachments) : null,
        timestamp,
        null,
        role === 'assistant' ? (String(message?.model || '').trim() || null) : null,
        null,
      );
      for (const attachment of attachments) {
        const sha256 = String(attachment?.sha256 || '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sha256)) continue;
        insertUploadRef?.run(sha256, conversationId, messageId, timestamp);
      }
      if (role !== 'assistant') continue;
      const activities = ensureArray(message?.activities)
        .map((value) => normalizeActivityEntry(value))
        .filter(Boolean);
      for (const activity of activities) {
        stmts.insertActivity.run(
          String(message?.sourceMessageId || messageId),
          messageId,
          conversationId,
          String(message?.mode || 'agent').trim() || 'agent',
          activity.text,
          timestamp,
          activity.subagentRunId,
        );
      }
      const thoughts = ensureArray(message?.thoughts)
        .map((value, index) => normalizeThoughtEntry(value, index))
        .filter(Boolean);
      for (let index = 0; index < thoughts.length; index += 1) {
        const thought = thoughts[index];
        if (typeof stmts.insertThought?.run !== 'function') continue;
        stmts.insertThought.run(
          String(message?.sourceMessageId || messageId),
          messageId,
          conversationId,
          String(message?.mode || 'agent').trim() || 'agent',
          thought.reasoningId,
          index + 1,
          thought.text,
          thought.done ? 1 : 0,
          timestamp,
          thought.subagentRunId,
        );
      }
    }
  }

  function normalizeHiddenMatchText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function resolveHiddenMessageId(hiddenMessage, rebuiltMessages, consumedIds) {
    const hiddenId = normalizeId(hiddenMessage?.id);
    const sameIdMatch = rebuiltMessages.find((message) => normalizeId(message?.id) === hiddenId);
    if (sameIdMatch) {
      consumedIds.add(hiddenId);
      return hiddenId;
    }
    const role = normalizeMessageRole(hiddenMessage?.role);
    const text = normalizeHiddenMatchText(hiddenMessage?.text);
    if (!role || !text) return '';
    const matching = rebuiltMessages
      .filter((message) => {
        const messageId = normalizeId(message?.id);
        return messageId
          && !consumedIds.has(messageId)
          && normalizeMessageRole(message?.role) === role
          && normalizeHiddenMatchText(message?.text) === text;
      })
      .sort((left, right) => (
        attachmentTimestampDistance(left?.timestamp, hiddenMessage?.timestamp)
          - attachmentTimestampDistance(right?.timestamp, hiddenMessage?.timestamp)
      ));
    const selected = matching[0];
    if (!selected) return '';
    const selectedId = normalizeId(selected.id);
    consumedIds.add(selectedId);
    return selectedId;
  }

  const clearRetrievableHistoryTx = db.transaction((conversationId) => {
    deleteConversationMessages.run(conversationId);
    deleteConversationActivity.run(conversationId);
    deleteConversationThoughts.run(conversationId);
    deleteConversationStreamEvents.run(conversationId);
    deleteConversationSubagentRuns.run(conversationId);
  });

  const persistRebuiltHistoryTx = db.transaction((conversationId, messages = []) => {
    insertRebuiltMessages(conversationId, messages);
  });

  const replaceRetrievableHistoryTx = db.transaction((conversationId, messages = []) => {
    const hiddenMessages = listHiddenMessageVisibility?.all(conversationId) || [];
    const attachmentCandidates = collectAttachmentCandidates(conversationId);
    deleteConversationMessages.run(conversationId);
    deleteConversationActivity.run(conversationId);
    deleteConversationThoughts.run(conversationId);
    deleteConversationStreamEvents.run(conversationId);
    deleteConversationSubagentRuns.run(conversationId);
    insertRebuiltMessages(conversationId, messages, attachmentCandidates);
    const rebuiltMessages = ensureArray(messages);
    const consumedHiddenIds = new Set();
    for (const hiddenMessage of hiddenMessages) {
      const resolvedId = resolveHiddenMessageId(hiddenMessage, rebuiltMessages, consumedHiddenIds);
      if (!resolvedId) continue;
      restoreHiddenMessageVisibility.run(
        hiddenMessage.share_hidden_at || new Date().toISOString(),
        conversationId,
        resolvedId,
      );
    }
  });

  function evaluateRefreshIdleState(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return { idle: false, reason: 'missing-conversation-id' };
    const queueBusyCount = Number(countBusyQueueByConversation.get(sid)?.cnt || 0);
    if (queueBusyCount > 0) return { idle: false, reason: 'queue-busy' };
    if (typeof inFlightStateForConversation === 'function') {
      const inFlight = inFlightStateForConversation(sid);
      const status = String(inFlight?.status || '').trim().toLowerCase();
      if (status === 'processing' || status === 'pending' || status === 'parked') {
        return { idle: false, reason: 'turn-processing' };
      }
    }
    return { idle: true };
  }

  function mapSdkEventsToMessages(events = []) {
    if (typeof parseSessionEventsToMessages !== 'function') return [];
    return parseSessionEventsToMessages(ensureArray(events));
  }

  function countRetrievableMessages(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return 0;
    return Number(countMessagesByConversation.get(sid)?.cnt || 0);
  }

  function clearRetrievableHistory(conversationId) {
    const sid = normalizeId(conversationId);
    if (!sid) return false;
    clearRetrievableHistoryTx(sid);
    return true;
  }

  function persistRebuiltHistory(conversationId, messages = []) {
    const sid = normalizeId(conversationId);
    if (!sid) return { insertedCount: 0 };
    persistRebuiltHistoryTx(sid, messages);
    return { insertedCount: ensureArray(messages).length };
  }

  function replaceRetrievableHistory(conversationId, messages = []) {
    const sid = normalizeId(conversationId);
    if (!sid) return { insertedCount: 0 };
    replaceRetrievableHistoryTx(sid, messages);
    return { insertedCount: ensureArray(messages).length };
  }

  return {
    evaluateRefreshIdleState,
    mapSdkEventsToMessages,
    countRetrievableMessages,
    clearRetrievableHistory,
    persistRebuiltHistory,
    replaceRetrievableHistory,
  };
}
