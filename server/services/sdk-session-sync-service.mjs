'use strict';

import { randomUUID as uuidv4 } from 'crypto';

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

  // Rekeying a placeholder must carry every live queue row with it: a
  // processing/parked row left under the placeholder id would be orphaned the
  // moment the real session id takes over (audit #22). attempt_id is
  // deliberately untouched — owner migration must not invalidate the Phase 1
  // attempt fence on an in-flight row.
  const migrateQueueOwnerSessionId = db.prepare(`
    UPDATE queue
    SET owner_sdk_session_id = ?
    WHERE status IN ('pending', 'processing', 'parked')
      AND owner_sdk_session_id = ?
      AND conversation_id = ?
  `);

  // Once a session syncs, the relay drives it: its ledger row (if it was ever
  // imported) flips to relay ownership so the startup import sweep can never
  // again overwrite relay history with the raw CLI transcript. One-way by
  // design; rows that never existed are a no-op.
  const markImportRelayOwned = db.prepare(`
    UPDATE sdk_session_imports
    SET origin = 'relay', updated_at = ?
    WHERE sdk_session_id = ? AND (origin IS NULL OR origin != 'relay')
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

  // Every conflict check, no writes. syncSessionTx runs it immediately before
  // mutating; the session-sync route additionally runs it (via validateBinding,
  // with requireConversation off — workspace learning may legitimately create
  // the conversation afterwards) BEFORE workspace learning is allowed to touch
  // any table, so a doomed request is vetoed while everything is pristine
  // (audit #21).
  function assertNoBindingConflicts(sdkSessionId, conversationId, { requireConversation = true } = {}) {
    if (!sdkSessionId || !conversationId) {
      throw makeError('Missing sdk_session_id or conversation_id', 400);
    }

    const conversation = getConversation.get(conversationId) || null;
    const conversationMissing = !conversation || String(conversation.status || '').trim() === 'deleted';
    if (conversationMissing && requireConversation) {
      throw makeError('Conversation not found', 404);
    }

    const existingConversationSdkSessionId = conversationMissing ? '' : normalizeId(conversation.sdk_session_id);
    const placeholderConversationBinding = !!(existingConversationSdkSessionId
      && existingConversationSdkSessionId === conversationId
      && existingConversationSdkSessionId !== sdkSessionId);
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

    if (runtimeSessionByConversation) {
      const currentSdkSessionId = normalizeId(runtimeSessionByConversation.sdk_session_id);
      if (currentSdkSessionId && currentSdkSessionId !== sdkSessionId && currentSdkSessionId !== conversationId) {
        throw makeError(
          `Runtime session ${runtimeSessionByConversation.id} is already bound to SDK session ${currentSdkSessionId}`,
          409,
        );
      }
    }

    return {
      placeholderConversationBinding,
      runtimeSessionByConversation,
      runtimeSessionBySdkSessionId,
    };
  }

  // ORDERING CONTRACT (audit #22): the queue dequeue path reads
  // owner_sdk_session_id to route pending work, so the placeholder→real rekey
  // below must be visible before the next dequeue considers this
  // conversation's rows. Both run on the same better-sqlite3 connection and
  // this whole rekey is one synchronous transaction, so a dequeue can never
  // observe a half-rekeyed state; callers must keep the in-memory registry
  // rekey immediately after this transaction commits (see the session-sync
  // route) rather than deferring it past other queue work.
  const syncSessionTx = db.transaction((sdkSessionIdRaw, conversationIdRaw) => {
    const sdkSessionId = normalizeId(sdkSessionIdRaw);
    const conversationId = normalizeId(conversationIdRaw);
    const nowIso = new Date().toISOString();

    const {
      placeholderConversationBinding,
      runtimeSessionByConversation,
      runtimeSessionBySdkSessionId,
    } = assertNoBindingConflicts(sdkSessionId, conversationId, { requireConversation: true });

    updateConversationSdkSession.run(sdkSessionId, nowIso, conversationId);
    let migratedQueueRows = 0;
    if (placeholderConversationBinding) {
      migratedQueueRows = Number(migrateQueueOwnerSessionId.run(sdkSessionId, conversationId, conversationId).changes || 0);
    }

    let runtimeSessionId = null;
    let createdRuntimeSession = false;

    if (runtimeSessionByConversation) {
      updateRuntimeSessionSdkSession.run(conversationId, sdkSessionId, nowIso, runtimeSessionByConversation.id);
      runtimeSessionId = runtimeSessionByConversation.id;
    } else if (runtimeSessionBySdkSessionId) {
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

    markImportRelayOwned.run(nowIso, sdkSessionId);
    if (conversationId !== sdkSessionId) {
      // A conversation originally imported under its own session id keeps a
      // ledger row under that id; rebinding to a new CLI session means the
      // relay owns that history now too.
      markImportRelayOwned.run(nowIso, conversationId);
    }

    return {
      conversationId,
      sdkSessionId,
      runtimeSessionId,
      createdRuntimeSession,
      migratedQueueRows,
      // Non-null when this sync rekeyed a placeholder binding: the caller must
      // rekey any in-memory worker-registry entry from this id to sdkSessionId.
      placeholderSdkSessionId: placeholderConversationBinding ? conversationId : null,
    };
  });

  return {
    syncSession({ sdk_session_id, conversation_id }) {
      return syncSessionTx(sdk_session_id, conversation_id);
    },
    // Read-only conflict probe for the session-sync route's validate-first
    // ordering. Missing conversations pass — workspace learning creates them.
    validateBinding({ sdk_session_id, conversation_id }) {
      assertNoBindingConflicts(normalizeId(sdk_session_id), normalizeId(conversation_id), { requireConversation: false });
      return true;
    },
  };
}
