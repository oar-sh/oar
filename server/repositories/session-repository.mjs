'use strict';

export function createSessionRepository(db) {
    const runtimeSessionColumns = new Set(
      db.prepare(`PRAGMA table_info(runtime_sessions)`).all().map((column) => String(column?.name || '').trim()),
    );
    const runtimeSessionsSupportProviders = runtimeSessionColumns.has('provider_type')
      && runtimeSessionColumns.has('provider_model');
    const runtimeProviderSelect = runtimeSessionsSupportProviders
      ? 'rs.model AS runtime_model, rs.provider_type AS runtime_provider_type, rs.provider_model AS runtime_provider_model'
      : 'rs.model AS runtime_model, NULL AS runtime_provider_type, NULL AS runtime_provider_model';
    return {
        // conversations
        getConv:        db.prepare(`SELECT * FROM conversations WHERE id = ? AND status != 'deleted'`),
        getConvAnyStatus: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
        getConvBySdkSessionId: db.prepare(`SELECT * FROM conversations WHERE sdk_session_id = ? AND status != 'deleted' ORDER BY updated_at DESC LIMIT 1`),
        listConvIdsMissingRuntimeSession: db.prepare(`SELECT c.id AS id FROM conversations c LEFT JOIN runtime_sessions rs ON rs.conversation_id = c.id WHERE rs.id IS NULL AND c.status != 'deleted'`),
        runtimeSessionsSupportProviders,
        listConvs:      db.prepare(`SELECT c.id, c.title, c.title_source, c.archived, c.compacted_into, c.compacted_from, c.sdk_session_id, c.preferred_relay_mode, c.preferred_models_by_mode, c.preferred_reasoning_by_mode, c.configured_workspace_root_path, c.runtime_workspace_root_path, c.draft_text, c.draft_updated_at, c.draft_updated_by_client_id, c.created_at, c.updated_at, rs.id AS runtime_session_id, rs.strategy AS runtime_strategy, rs.status AS runtime_status, rs.last_used_at AS runtime_last_used_at, ${runtimeProviderSelect}, COUNT(m.id) as message_count FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id LEFT JOIN runtime_sessions rs ON rs.conversation_id = c.id WHERE c.status != 'deleted' AND (? = 1 OR c.archived = 0) GROUP BY c.id ORDER BY CASE WHEN c.sdk_session_id IS NULL OR c.sdk_session_id = '' THEN 1 ELSE 0 END ASC, c.updated_at DESC`),
        insertConv:     db.prepare(`INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`),
        updateConvTime: db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`),
        updateConvTitle: db.prepare(`UPDATE conversations SET title = ?, title_source = 'manual' WHERE id = ?`),
        updateConvPreferences: db.prepare(`UPDATE conversations SET preferred_relay_mode = ?, preferred_models_by_mode = ?, preferred_reasoning_by_mode = ?, updated_at = ? WHERE id = ?`),
        updateConvConfiguredWorkspaceRoot: db.prepare(`UPDATE conversations SET configured_workspace_root_path = ?, updated_at = ? WHERE id = ?`),
        updateConvRuntimeWorkspaceRoot: db.prepare(`UPDATE conversations SET runtime_workspace_root_path = ?, updated_at = ? WHERE id = ?`),
        seedConvConfiguredWorkspaceRootIfMissing: db.prepare(`UPDATE conversations SET configured_workspace_root_path = ?, updated_at = ? WHERE id = ? AND (configured_workspace_root_path IS NULL OR configured_workspace_root_path = '')`),
        updateConvSeed: db.prepare(`UPDATE conversations SET summary_seed = ?, seed_pending = ?, compacted_from = ?, updated_at = ? WHERE id = ?`),
        markConvCompacted: db.prepare(`UPDATE conversations SET archived = 1, compacted_into = ?, updated_at = ? WHERE id = ?`),
        getConvSeed:    db.prepare(`SELECT summary_seed, seed_pending FROM conversations WHERE id = ?`),
        clearConvSeed:  db.prepare(`UPDATE conversations SET seed_pending = 0, updated_at = ? WHERE id = ?`),
        updateConvDraft: db.prepare(`UPDATE conversations SET draft_text = ?, draft_updated_at = ?, draft_updated_by_client_id = ? WHERE id = ?`),
        archiveConv:    db.prepare(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?`),
        deleteConv:     db.prepare(`DELETE FROM conversations WHERE id = ?`),

        // messages
        getMessages:    db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`),
        getConversationMessageCount: db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`),
        getConversationActiveQueueCount: db.prepare(`SELECT COUNT(*) AS count FROM queue WHERE conversation_id = ? AND status IN ('pending', 'processing', 'parked')`),
        getLatestConversationModel: db.prepare(`SELECT model FROM messages WHERE conversation_id = ? AND model IS NOT NULL AND model != '' ORDER BY timestamp DESC LIMIT 1`),
        getRecentMessagesDesc: db.prepare(`SELECT role, text, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?`),
        insertMsg:      db.prepare(`INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp, model_requested, model_actual, model_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),

        // queue
        insertQ:        db.prepare(`INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, model_variant_id, reasoning_effort, relay_mode, text, attachments, status, timestamp, retry_count, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL)`),
        findPending:    db.prepare(`SELECT * FROM queue WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY retry_count ASC, CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END ASC, COALESCE(next_attempt_at, timestamp) ASC, timestamp ASC LIMIT 1`),
        countStatus:    db.prepare(`SELECT status, COUNT(*) as cnt FROM queue WHERE status IN ('pending','processing','parked') GROUP BY status`),
        countRuntimeSessions: db.prepare(`SELECT COUNT(*) AS cnt FROM runtime_sessions WHERE status = 'active'`),
        setProcessing:  db.prepare(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = ?`),
        setQueueRuntimeSession: db.prepare(`UPDATE queue SET runtime_session_id = ? WHERE id = ?`),
        setQueueResponseMessageId: db.prepare(`UPDATE queue SET response_message_id = ? WHERE id = ?`),
        setDone:        db.prepare(`UPDATE queue SET status = 'done', response = ?, processing_at = NULL, next_attempt_at = NULL WHERE id = ? AND status IN ('processing', 'pending')`),
        setFailed:      db.prepare(`UPDATE queue SET status = 'failed', response = ?, processing_at = NULL, next_attempt_at = NULL WHERE id = ?`),
        deleteConvQ:    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`),
        findQById:      db.prepare(`SELECT * FROM queue WHERE id = ?`),
        pruneQueue:     db.prepare(`DELETE FROM queue WHERE status = 'done' AND id NOT IN (SELECT id FROM queue WHERE status = 'done' ORDER BY timestamp DESC LIMIT 200)`),
        recoverStale:   db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, next_attempt_at = ? WHERE status = 'processing' AND processing_at < ?`),
        listRecoverableProcessing: db.prepare(`SELECT id, conversation_id FROM queue WHERE status = 'processing' AND processing_at < ?`),
        recoverProcessingBefore: db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, next_attempt_at = ? WHERE status = 'processing' AND processing_at < ?`),
        listQueueForPauseDrop: db.prepare(`SELECT id, conversation_id FROM queue WHERE status IN ('pending', 'processing', 'parked')`),
        deleteQueueById: db.prepare(`DELETE FROM queue WHERE id = ?`),
        getLatestProcessingQueueByConversation: db.prepare(`SELECT id, relay_mode, timestamp, processing_at FROM queue WHERE conversation_id = ? AND status = 'processing' ORDER BY COALESCE(processing_at, timestamp) DESC LIMIT 1`),

        // runtime sessions
        getRuntimeSessionByConversation: db.prepare(`SELECT * FROM runtime_sessions WHERE conversation_id = ?`),
        getRuntimeSessionBySdkSessionId: db.prepare(`SELECT * FROM runtime_sessions WHERE sdk_session_id = ?`),
        getRuntimeSessionById: db.prepare(`SELECT * FROM runtime_sessions WHERE id = ?`),
        listRuntimeSessions: db.prepare(`SELECT rs.*, c.title AS conversation_title, c.updated_at AS conversation_updated_at FROM runtime_sessions rs LEFT JOIN conversations c ON c.id = rs.conversation_id ORDER BY rs.last_used_at DESC`),
        insertRuntimeSession: db.prepare(runtimeSessionsSupportProviders
          ? `INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at, sdk_session_id, provider_type, provider_model) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
          : `INSERT INTO runtime_sessions (id, conversation_id, strategy, runtime_key, model, status, created_at, last_used_at, sdk_session_id) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`),
        setConvSdkSessionIdIfMissing: db.prepare(`UPDATE conversations SET sdk_session_id = ?, updated_at = ? WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id = '')`),
        setRuntimeSessionSdkSessionIdIfMissing: db.prepare(`UPDATE runtime_sessions SET sdk_session_id = ?, last_used_at = ?, status = 'active' WHERE id = ? AND (sdk_session_id IS NULL OR sdk_session_id = '')`),
        touchRuntimeSession: db.prepare(`UPDATE runtime_sessions SET model = ?, last_used_at = ?, status = 'active' WHERE id = ?`),
        listRuntimeSessionProviderCandidates: db.prepare(`
          SELECT
            rs.*,
            c.sdk_session_id AS conversation_sdk_session_id,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT COUNT(*) FROM queue q WHERE q.conversation_id = c.id AND q.status IN ('pending', 'processing', 'parked')) AS active_queue_count
          FROM runtime_sessions rs
          JOIN conversations c ON c.id = rs.conversation_id
          WHERE c.status != 'deleted'
        `),
        updateRuntimeSessionProvider: runtimeSessionsSupportProviders
          ? db.prepare(`
              UPDATE runtime_sessions
              SET provider_type = ?, provider_model = ?, model = ?, last_used_at = ?, status = 'active'
              WHERE id = ?
            `)
          : null,
        deleteRuntimeSessionByConversation: db.prepare(`DELETE FROM runtime_sessions WHERE conversation_id = ?`),

        // deleted sdk sessions tombstones (hide rediscovered SDK sessions after UI delete)
        listDeletedSdkSessions: db.prepare(`SELECT sdk_session_id FROM deleted_sdk_sessions`),
        getDeletedSdkSession: db.prepare(`SELECT sdk_session_id FROM deleted_sdk_sessions WHERE sdk_session_id = ? LIMIT 1`),
        markDeletedSdkSession: db.prepare(`INSERT OR REPLACE INTO deleted_sdk_sessions (sdk_session_id, deleted_at) VALUES (?, ?)`),
        clearDeletedSdkSession: db.prepare(`DELETE FROM deleted_sdk_sessions WHERE sdk_session_id = ?`),
        deleteDeletedSdkSessions: db.prepare(`DELETE FROM deleted_sdk_sessions`),

        // recent workspace roots (relay-owned CWD history)
        upsertRecentWorkspaceRoot: db.prepare(`
          INSERT INTO recent_workspace_roots (path, last_seen_at)
          VALUES (?, ?)
          ON CONFLICT(path) DO UPDATE SET
            last_seen_at = excluded.last_seen_at
        `),
        listRecentWorkspaceRoots: db.prepare(`
          SELECT path, last_seen_at
          FROM recent_workspace_roots
          ORDER BY last_seen_at DESC
          LIMIT ?
        `),
        pruneRecentWorkspaceRoots: db.prepare(`
          DELETE FROM recent_workspace_roots
          WHERE path NOT IN (
            SELECT path
            FROM recent_workspace_roots
            ORDER BY last_seen_at DESC
            LIMIT ?
          )
        `),
        deleteRecentWorkspaceRoots: db.prepare(`DELETE FROM recent_workspace_roots`),

        // app settings
        getAppSetting: db.prepare(`
          SELECT key, value, updated_at
          FROM app_settings
          WHERE key = ?
          LIMIT 1
        `),
        upsertAppSetting: db.prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `),
        deleteAppSetting: db.prepare(`DELETE FROM app_settings WHERE key = ?`),

        // SDK session delete bridge queue (server <-> extension)
        upsertSdkDeleteRequest: db.prepare(`
          INSERT INTO sdk_delete_requests (
            sdk_session_id, conversation_id, status, requested_at, updated_at, processing_at, retry_count, next_attempt_at, last_error
          ) VALUES (?, ?, 'pending', ?, ?, NULL, 0, NULL, NULL)
          ON CONFLICT(sdk_session_id) DO UPDATE SET
            conversation_id = COALESCE(excluded.conversation_id, sdk_delete_requests.conversation_id),
            status = 'pending',
            requested_at = excluded.requested_at,
            updated_at = excluded.updated_at,
            processing_at = NULL,
            retry_count = 0,
            next_attempt_at = NULL,
            last_error = NULL
        `),
        dequeueSdkDeleteRequest: db.prepare(`
          SELECT sdk_session_id, conversation_id, retry_count, requested_at
          FROM sdk_delete_requests
          WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY requested_at ASC
          LIMIT 1
        `),
        setSdkDeleteRequestProcessing: db.prepare(`
          UPDATE sdk_delete_requests
          SET status = 'processing', processing_at = ?, updated_at = ?, last_error = NULL
          WHERE sdk_session_id = ? AND status = 'pending'
        `),
        resetStaleSdkDeleteProcessing: db.prepare(`
          UPDATE sdk_delete_requests
          SET status = 'pending', processing_at = NULL, updated_at = ?
          WHERE status = 'processing' AND processing_at < ?
        `),
        getSdkDeleteRequestBySessionId: db.prepare(`
          SELECT sdk_session_id, conversation_id, status, retry_count, requested_at, updated_at, next_attempt_at, last_error
          FROM sdk_delete_requests
          WHERE sdk_session_id = ?
          LIMIT 1
        `),
        setSdkDeleteRequestPendingWithError: db.prepare(`
          UPDATE sdk_delete_requests
          SET status = 'pending',
              processing_at = NULL,
              retry_count = retry_count + 1,
              next_attempt_at = ?,
              updated_at = ?,
              last_error = ?
          WHERE sdk_session_id = ?
        `),
        deleteSdkDeleteRequest: db.prepare(`DELETE FROM sdk_delete_requests WHERE sdk_session_id = ?`),
        deleteSdkDeleteRequests: db.prepare(`DELETE FROM sdk_delete_requests`),
        // SDK session import ledger
        getSdkSessionImport: db.prepare(`
          SELECT sdk_session_id, conversation_id, status, attempt_count, started_at, completed_at,
                 source_started_at, source_modified_at, updated_at, last_error
          FROM sdk_session_imports WHERE sdk_session_id = ? LIMIT 1
        `),
        upsertSdkSessionImport: db.prepare(`
          INSERT INTO sdk_session_imports (
            sdk_session_id, conversation_id, status, attempt_count, started_at, completed_at,
            source_started_at, source_modified_at, updated_at, last_error
          )
          VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, NULL, ?, NULL)
          ON CONFLICT(sdk_session_id) DO NOTHING
        `),
        claimSdkSessionImport: db.prepare(`
          UPDATE sdk_session_imports
          SET status = 'processing', attempt_count = attempt_count + 1, started_at = ?, updated_at = ?, last_error = NULL
          WHERE sdk_session_id = ?
            AND (? = 1 OR status != 'completed')
            AND status != 'processing'
        `),
        completeSdkSessionImport: db.prepare(`
          UPDATE sdk_session_imports
          SET conversation_id = ?, status = 'completed', completed_at = ?, source_started_at = ?,
              source_modified_at = ?, updated_at = ?, last_error = NULL
          WHERE sdk_session_id = ?
        `),
        failSdkSessionImport: db.prepare(`
          UPDATE sdk_session_imports
          SET status = 'failed', updated_at = ?, last_error = ?
          WHERE sdk_session_id = ?
        `),
        resetInterruptedSdkSessionImports: db.prepare(`
          UPDATE sdk_session_imports
          SET status = 'failed', updated_at = ?, last_error = 'Interrupted before import completion'
          WHERE status = 'processing'
        `),
        resetSdkSessionImports: db.prepare(`DELETE FROM sdk_session_imports`),
        listDeletedConversationsBySdkSessionId: db.prepare(`
          SELECT id, sdk_session_id
          FROM conversations
          WHERE status = 'deleted' AND sdk_session_id = ?
        `),
        // public conversation shares
        getConversationShareByConversationId: db.prepare(`
          SELECT token, conversation_id, created_at, last_accessed_at, revoked_at
          FROM conversation_shares
          WHERE conversation_id = ?
            AND (revoked_at IS NULL OR revoked_at = '')
          ORDER BY created_at DESC
          LIMIT 1
        `),
        getConversationShareByToken: db.prepare(`
          SELECT token, conversation_id, created_at, last_accessed_at, revoked_at
          FROM conversation_shares
          WHERE token = ?
          LIMIT 1
        `),
        insertConversationShare: db.prepare(`
          INSERT INTO conversation_shares (
            token,
            conversation_id,
            created_at,
            last_accessed_at,
            revoked_at
          ) VALUES (?, ?, ?, ?, NULL)
        `),
        touchConversationShare: db.prepare(`
          UPDATE conversation_shares
          SET last_accessed_at = ?
          WHERE token = ?
            AND (revoked_at IS NULL OR revoked_at = '')
        `),
        revokeConversationShareByToken: db.prepare(`
          UPDATE conversation_shares
          SET revoked_at = ?
          WHERE token = ?
            AND (revoked_at IS NULL OR revoked_at = '')
        `),
    };
}
