'use strict';

// Pinned messages: the pinned_at column detection and its SQL in one place.
// The statements are null on a database the 0008 migration has not reached
// yet; every caller treats that as "no pins".
export function createMessagePinStatements(db) {
  const messageColumns = new Set(
    db.prepare(`PRAGMA table_info(messages)`).all().map((column) => String(column?.name || '').trim()),
  );
  const messagesSupportPins = messageColumns.has('pinned_at');
  if (!messagesSupportPins) {
    return {
      messagesSupportPins,
      setMessagePinnedAt: null,
      listPinnedMessages: null,
      countPinnedMessages: null,
    };
  }
  return {
    messagesSupportPins,
    setMessagePinnedAt: db.prepare(`
      UPDATE messages
      SET pinned_at = ?
      WHERE id = ? AND conversation_id = ?
    `),
    // Conversation order, not pin order: the list reads like a table of contents.
    listPinnedMessages: db.prepare(`
      SELECT id, role, text, mode, attachments, timestamp, pinned_at, hidden_from_shares
      FROM messages
      WHERE conversation_id = ? AND pinned_at IS NOT NULL
      ORDER BY timestamp ASC
    `),
    countPinnedMessages: db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM messages
      WHERE conversation_id = ? AND pinned_at IS NOT NULL
    `),
  };
}
