'use strict';

import { v4 as uuidv4 } from 'uuid';

function normalizeId(value) {
  return String(value || '').trim();
}

function makeError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function createSdkSessionSyncService(db) {
  const runtimeSessionColumns = new Set(
    db.prepare(`PRAGMA table_info(runtime_sessions)`).all().map((column) => String(column?.name || '').trim()),
  );
  const runtimeSessionsSupportProviders = runtimeSessionColumns.has('provider_type')
    && runtimeSessionColumns.has('provider_model');
  const providerSelect = runtimeSessionsSupportProviders
    ? 'provider_type, provider_model'
    : `'github' AS provider_type, NULL AS provider_model`;
  const getConversation = db.prepare(`
    SELECT id, sdk_session_id, status
    FROM conversations
    WHERE id = ?
    LIMIT 1
  `);

  const getConversationBySdkSessionId = db.prepare(`
    SELECT id, sdk_session_id, status
    FROM conversations
    WHERE sdk_session_id = ?
      AND id != ?
    LIMIT 1
  `);

  const getRuntimeSessionByConversation = db.prepare(`
    SELECT id, conversation_id, sdk_session_id, status, strategy, runtime_key, model, ${providerSelect}
    FROM runtime_sessions
    WHERE conversation_id = ?
    LIMIT 1
  `);

  const getRuntimeSessionBySdkSessionId = db.prepare(`
    SELECT id, conversation_id, sdk_session_id, status, strategy, runtime_key, model, ${providerSelect}
    FROM runtime_sessions
    WHERE sdk_session_id = ?
    LIMIT 1
  `);

  const updateConversationSdkSession = db.prepare(`
    UPDATE conversations
    SET sdk_session_id = ?, updated_at = ?
    WHERE id = ?
  `);

  const updateRuntimeSessionSdkSession = db.prepare(`
    UPDATE runtime_sessions
    SET conversation_id = ?,
        sdk_session_id = ?,
        last_used_at = ?,
        status = COALESCE(status, 'active')
    WHERE id = ?
  `);

  const migrateQueueOwnerSessionId = db.prepare(`
    UPDATE queue
    SET owner_sdk_session_id = ?
    WHERE status = 'pending'
      AND owner_sdk_session_id = ?
      AND conversation_id = ?
  `);

  const insertRuntimeSession = db.prepare(runtimeSessionsSupportProviders
    ? `
      INSERT INTO runtime_sessions (
        id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at, sdk_session_id, provider_type, provider_model
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 'github', NULL)
    `
    : `
      INSERT INTO runtime_sessions (
        id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at, sdk_session_id
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `);

  const syncSessionTx = db.transaction((sdkSessionIdRaw, conversationIdRaw) => {
    const sdkSessionId = normalizeId(sdkSessionIdRaw);
    const conversationId = normalizeId(conversationIdRaw);
    const nowIso = new Date().toISOString();

    if (!sdkSessionId || !conversationId) {
      throw makeError('Missing sdk_session_id or conversation_id', 400);
    }

    const conversation = getConversation.get(conversationId);
    if (!conversation || String(conversation.status || '').trim() === 'deleted') {
      throw makeError('Conversation not found', 404);
    }

    const existingConversationSdkSessionId = normalizeId(conversation.sdk_session_id);
    const placeholderConversationBinding = existingConversationSdkSessionId
      && existingConversationSdkSessionId === conversationId
      && existingConversationSdkSessionId !== sdkSessionId;
    if (existingConversationSdkSessionId && existingConversationSdkSessionId !== sdkSessionId && !placeholderConversationBinding) {
      throw makeError(
        `Conversation ${conversationId} is already bound to SDK session ${existingConversationSdkSessionId}`,
        409,
      );
    }

    const otherConversation = getConversationBySdkSessionId.get(sdkSessionId, conversationId);
    if (otherConversation) {
      throw makeError(
        `SDK session ${sdkSessionId} is already bound to conversation ${otherConversation.id}`,
        409,
      );
    }

    const runtimeSessionByConversation = getRuntimeSessionByConversation.get(conversationId) || null;
    const runtimeSessionBySdkSessionId = getRuntimeSessionBySdkSessionId.get(sdkSessionId) || null;

    if (runtimeSessionByConversation && runtimeSessionBySdkSessionId) {
      const sameRuntimeSession = String(runtimeSessionByConversation.id || '') === String(runtimeSessionBySdkSessionId.id || '');
      const sameConversation = String(runtimeSessionBySdkSessionId.conversation_id || '') === conversationId;
      const sameSdkSession = normalizeId(runtimeSessionByConversation.sdk_session_id) === sdkSessionId;
      const placeholderRuntimeBinding = normalizeId(runtimeSessionByConversation.sdk_session_id) === conversationId
        && normalizeId(runtimeSessionByConversation.sdk_session_id) !== sdkSessionId;
      if (!sameRuntimeSession && !sameConversation && !placeholderRuntimeBinding) {
        throw makeError(
          `SDK session ${sdkSessionId} is already bound to another runtime session`,
          409,
        );
      }
      if (!sameSdkSession && normalizeId(runtimeSessionByConversation.sdk_session_id)) {
        throw makeError(
          `Runtime session ${runtimeSessionByConversation.id} is already bound to SDK session ${normalizeId(runtimeSessionByConversation.sdk_session_id)}`,
          409,
        );
      }
    } else if (runtimeSessionBySdkSessionId && normalizeId(runtimeSessionBySdkSessionId.conversation_id) !== conversationId) {
      throw makeError(
        `SDK session ${sdkSessionId} is already bound to runtime session ${runtimeSessionBySdkSessionId.id}`,
        409,
      );
    }

    updateConversationSdkSession.run(sdkSessionId, nowIso, conversationId);
    if (placeholderConversationBinding) {
      migrateQueueOwnerSessionId.run(sdkSessionId, conversationId, conversationId);
    }

    let runtimeSessionId = null;
    let createdRuntimeSession = false;

    if (runtimeSessionByConversation) {
      const currentSdkSessionId = normalizeId(runtimeSessionByConversation.sdk_session_id);
      if (currentSdkSessionId && currentSdkSessionId !== sdkSessionId && currentSdkSessionId !== conversationId) {
        throw makeError(
          `Runtime session ${runtimeSessionByConversation.id} is already bound to SDK session ${currentSdkSessionId}`,
          409,
        );
      }

      updateRuntimeSessionSdkSession.run(conversationId, sdkSessionId, nowIso, runtimeSessionByConversation.id);
      runtimeSessionId = runtimeSessionByConversation.id;
    } else if (runtimeSessionBySdkSessionId) {
      const currentConversationId = normalizeId(runtimeSessionBySdkSessionId.conversation_id);
      if (currentConversationId && currentConversationId !== conversationId) {
        throw makeError(
          `SDK session ${sdkSessionId} is already bound to conversation ${currentConversationId}`,
          409,
        );
      }

      updateRuntimeSessionSdkSession.run(conversationId, sdkSessionId, nowIso, runtimeSessionBySdkSessionId.id);
      runtimeSessionId = runtimeSessionBySdkSessionId.id;
    } else {
      runtimeSessionId = uuidv4();
      createdRuntimeSession = true;
      insertRuntimeSession.run(
        runtimeSessionId,
        conversationId,
        'isolated',
        runtimeSessionId,
        null,
        nowIso,
        nowIso,
        sdkSessionId,
      );
    }

    return {
      conversationId,
      sdkSessionId,
      runtimeSessionId,
      createdRuntimeSession,
    };
  });

  return {
    syncSession({ sdk_session_id, conversation_id }) {
      return syncSessionTx(sdk_session_id, conversation_id);
    },
  };
}
