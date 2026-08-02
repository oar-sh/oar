'use strict';

// Shared between message-repository and session-repository so the
// hidden-from-shares column detection and SQL stay in one place.
export function createShareVisibilityStatements(db) {
  const messageColumns = new Set(
    db.prepare(`PRAGMA table_info(messages)`).all().map((column) => String(column?.name || '').trim()),
  );
  const messagesSupportShareVisibility = messageColumns.has('hidden_from_shares')
    && messageColumns.has('share_hidden_at');
  return {
    messagesSupportShareVisibility,
    getSharedMessages: db.prepare(messagesSupportShareVisibility
      ? `SELECT * FROM messages WHERE conversation_id = ? AND hidden_from_shares = 0 ORDER BY timestamp ASC`
      : `SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`),
    setMessageShareVisibility: messagesSupportShareVisibility
      ? db.prepare(`
          UPDATE messages
          SET hidden_from_shares = ?, share_hidden_at = ?
          WHERE id = ? AND conversation_id = ?
        `)
      : null,
  };
}
