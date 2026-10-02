'use strict';

import { REMOTE_RELAY_LOCAL_ID, normalizeRemoteRelayOrigin } from '../../shared/remote-relay-contract.mjs';

// Storage for remote relays that is not app settings: which remote relays a
// conversation has unlocked (the user mentioned them), and the provenance of
// messages and conversations another relay's agent created. Tables and
// columns come from migrations/0005-remote-relays.mjs.
//
// A relay whose agent wrote to a conversation is open to that conversation as
// well. That is read from the provenance, not stored as an unlock, so what the
// user allowed and what another agent started stay apart.
//
// Agent sessions on this relay itself reuse both: the user's "Allow" for a
// conversation's agent to start sessions here is an unlock under the local
// target's id, and a conversation such an agent created carries an origin
// with `local: true` that names the conversation it was created from.

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
  // Conversations an agent of this relay created that have a turn queued or
  // running. The origin is filtered in SQL only roughly (it is JSON text); the
  // caller matches the creating conversation on the parsed value.
  const listActiveLocalOrigins = db.prepare(`
    SELECT c.id, c.origin_json FROM conversations c
    WHERE c.origin_json LIKE '%"local":true%'
      AND COALESCE(c.status, '') <> 'deleted'
      AND EXISTS (
        SELECT 1 FROM queue q
        WHERE q.conversation_id = c.id AND q.status IN ('pending', 'processing', 'parked')
      )
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
    /** Did the user allow this conversation's agent to start sessions on this relay? */
    hasLocalSessionApproval(conversationId) {
      return !!hasUnlock.get(String(conversationId || ''), REMOTE_RELAY_LOCAL_ID);
    },
    /** Remembers that "Allow"; `messageId` is the turn it was given on. */
    recordLocalSessionApproval(conversationId, messageId = null, nowIso = new Date().toISOString()) {
      const conversation = String(conversationId || '').trim();
      if (!conversation) return false;
      return insertUnlock.run(conversation, REMOTE_RELAY_LOCAL_ID, messageId ? String(messageId) : null, nowIso).changes > 0;
    },
    /**
     * The ids of the conversations this conversation's agent created on this
     * relay that have a turn queued or running (pending, processing, parked).
     */
    listActiveLocalSessions(conversationId) {
      const creator = String(conversationId || '').trim();
      if (!creator) return [];
      return listActiveLocalOrigins.all()
        .filter((row) => {
          const origin = parseOrigin(row.origin_json);
          return origin?.local === true && origin.conversationId === creator;
        })
        .map((row) => String(row.id));
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
