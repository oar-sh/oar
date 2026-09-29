'use strict';

import { normalizeRemoteRelayOrigin } from '../../shared/remote-relay-contract.mjs';

// Storage for remote relays that is not app settings: which remote relays a
// conversation has unlocked (the user mentioned them), and the provenance of
// messages and conversations another relay's agent created. Tables and
// columns come from migrations/0005-remote-relays.mjs.
//
// A relay whose agent wrote to a conversation is open to that conversation as
// well. That is read from the provenance, not stored as an unlock, so what the
// user allowed and what another agent started stay apart.

function parseOrigin(json) {
  if (!json) return null;
  try {
    return normalizeRemoteRelayOrigin(JSON.parse(json));
  } catch {
    return null;
  }
}

export function createRemoteRelayRepository(db) {
  const hasUnlock = db.prepare(`SELECT 1 FROM conversation_remote_relay_unlocks WHERE conversation_id = ? AND remote_relay_id = ?`);
  const listUnlocks = db.prepare(`SELECT remote_relay_id, message_id, created_at FROM conversation_remote_relay_unlocks WHERE conversation_id = ? ORDER BY created_at ASC`);
  const insertUnlock = db.prepare(`INSERT OR IGNORE INTO conversation_remote_relay_unlocks (conversation_id, remote_relay_id, message_id, created_at) VALUES (?, ?, ?, ?)`);
  const deleteUnlocksForRelay = db.prepare(`DELETE FROM conversation_remote_relay_unlocks WHERE remote_relay_id = ?`);
  const deleteUnlocksForConversation = db.prepare(`DELETE FROM conversation_remote_relay_unlocks WHERE conversation_id = ?`);
  const setMessageOrigin = db.prepare(`UPDATE messages SET origin_json = ? WHERE id = ?`);
  const getMessageOrigin = db.prepare(`SELECT origin_json FROM messages WHERE id = ?`);
  const setConversationOrigin = db.prepare(`UPDATE conversations SET origin_json = ? WHERE id = ?`);
  const getConversationOrigin = db.prepare(`SELECT origin_json FROM conversations WHERE id = ?`);
  const listUserMessageOrigins = db.prepare(`
    SELECT DISTINCT origin_json FROM messages
    WHERE conversation_id = ? AND role = 'user' AND origin_json IS NOT NULL
  `);
  const getLatestHumanMessage = db.prepare(`
    SELECT id FROM messages
    WHERE conversation_id = ? AND role = 'user' AND origin_json IS NULL
    ORDER BY timestamp DESC LIMIT 1
  `);

  return {
    hasUnlock(conversationId, remoteRelayId) {
      return !!hasUnlock.get(String(conversationId || ''), String(remoteRelayId || ''));
    },
    /** `[{ remoteRelayId, messageId, createdAt }]`, oldest first. */
    listUnlocks(conversationId) {
      return listUnlocks.all(String(conversationId || '')).map((row) => ({
        remoteRelayId: row.remote_relay_id,
        messageId: row.message_id || null,
        createdAt: row.created_at,
      }));
    },
    /** True when this call created the unlock (false when it already existed). */
    recordUnlock(conversationId, remoteRelayId, messageId = null, nowIso = new Date().toISOString()) {
      const conversation = String(conversationId || '').trim();
      const relay = String(remoteRelayId || '').trim();
      if (!conversation || !relay) return false;
      return insertUnlock.run(conversation, relay, messageId ? String(messageId) : null, nowIso).changes > 0;
    },
    forgetRelay(remoteRelayId) {
      return deleteUnlocksForRelay.run(String(remoteRelayId || '')).changes;
    },
    forgetConversation(conversationId) {
      return deleteUnlocksForConversation.run(String(conversationId || '')).changes;
    },
    setMessageOrigin(messageId, origin) {
      const normalized = normalizeRemoteRelayOrigin(origin);
      return setMessageOrigin.run(normalized ? JSON.stringify(normalized) : null, String(messageId || '')).changes > 0;
    },
    getMessageOrigin(messageId) {
      return parseOrigin(getMessageOrigin.get(String(messageId || ''))?.origin_json);
    },
    setConversationOrigin(conversationId, origin) {
      const normalized = normalizeRemoteRelayOrigin(origin);
      return setConversationOrigin.run(normalized ? JSON.stringify(normalized) : null, String(conversationId || '')).changes > 0;
    },
    getConversationOrigin(conversationId) {
      return parseOrigin(getConversationOrigin.get(String(conversationId || ''))?.origin_json);
    },
    /**
     * Did an agent on the relay with this instance id (the `relayId` of an
     * origin, not the local registry id) write to the conversation: by
     * starting it, or with a prompt in it?
     */
    hasContactFrom(conversationId, remoteInstanceId) {
      const conversation = String(conversationId || '').trim();
      const instance = String(remoteInstanceId || '').trim();
      if (!conversation || !instance) return false;
      if (parseOrigin(getConversationOrigin.get(conversation)?.origin_json)?.relayId === instance) return true;
      return listUserMessageOrigins.all(conversation)
        .some((row) => parseOrigin(row.origin_json)?.relayId === instance);
    },
    /** The id of the latest message the user wrote themselves, or null. */
    latestHumanMessageId(conversationId) {
      return getLatestHumanMessage.get(String(conversationId || ''))?.id || null;
    },
  };
}

/** Parses an `origin_json` column value read by other queries. */
export function parseRemoteRelayOriginJson(json) {
  return parseOrigin(json);
}
