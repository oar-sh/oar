'use strict';

export function createMessageRepository(db) {
    const queueHasImageOperationId = db.prepare(`PRAGMA table_info(queue)`).all()
        .some((column) => column.name === 'image_operation_id');
    const insertQueueSql = queueHasImageOperationId
        ? `INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, model_variant_id, reasoning_effort, context_tier, relay_mode, text, attachments, status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id, owner_assigned_at, owner_lease_expires_at, owner_last_claimed_at, image_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?, ?, ?, ?)`
        : `INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, model_variant_id, reasoning_effort, context_tier, relay_mode, text, attachments, status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id, owner_assigned_at, owner_lease_expires_at, owner_last_claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?, ?, ?)`;
    return {
        // messages
        getMessages:    db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`),
        getLatestConversationModel: db.prepare(`SELECT model FROM messages WHERE conversation_id = ? AND model IS NOT NULL AND model != '' ORDER BY timestamp DESC LIMIT 1`),
        getRecentMessagesDesc: db.prepare(`SELECT role, text, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?`),
        insertMsg:      db.prepare(`INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp, model_requested, model_actual, model_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        searchMessagesCount: db.prepare(`
          SELECT COUNT(*) AS cnt
          FROM messages_fts fts
          INNER JOIN messages m
            ON m.rowid = fts.rowid
          INNER JOIN conversations c
            ON c.id = m.conversation_id
          WHERE fts.text MATCH ?
            AND c.status != 'deleted'
        `),
        searchMessagesPage: db.prepare(`
          SELECT
            m.id AS message_id,
            m.conversation_id AS conversation_id,
            c.title AS conversation_title,
            m.role AS role,
            m.timestamp AS timestamp,
            m.text AS raw_text,
            snippet(messages_fts, 0, '<mark>', '</mark>', '…', 18) AS snippet,
            bm25(messages_fts) AS score
          FROM messages_fts fts
          INNER JOIN messages m
            ON m.rowid = fts.rowid
          INNER JOIN conversations c
            ON c.id = m.conversation_id
          WHERE fts.text MATCH ?
            AND c.status != 'deleted'
          ORDER BY score ASC, m.timestamp DESC, m.id DESC
          LIMIT ? OFFSET ?
        `),
        upsertMessageUsageSnapshot: db.prepare(`
          INSERT INTO message_usage_snapshots (
            response_message_id,
            queue_message_id,
            conversation_id,
            source,
            stale,
            premium_remaining,
            premium_entitlement,
            premium_used_percent,
            premium_delta_used,
            chat_remaining,
            chat_entitlement,
            chat_used_percent,
            chat_delta_used,
            plan_remaining,
            plan_entitlement,
            plan_used_percent,
            plan_delta_used,
            captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(response_message_id) DO UPDATE SET
            queue_message_id = excluded.queue_message_id,
            conversation_id = excluded.conversation_id,
            source = excluded.source,
            stale = excluded.stale,
            premium_remaining = excluded.premium_remaining,
            premium_entitlement = excluded.premium_entitlement,
            premium_used_percent = excluded.premium_used_percent,
            premium_delta_used = excluded.premium_delta_used,
            chat_remaining = excluded.chat_remaining,
            chat_entitlement = excluded.chat_entitlement,
            chat_used_percent = excluded.chat_used_percent,
            chat_delta_used = excluded.chat_delta_used,
            plan_remaining = excluded.plan_remaining,
            plan_entitlement = excluded.plan_entitlement,
            plan_used_percent = excluded.plan_used_percent,
            plan_delta_used = excluded.plan_delta_used,
            captured_at = excluded.captured_at
        `),
        getLatestMessageUsageSnapshotByConversation: db.prepare(`
          SELECT *
          FROM message_usage_snapshots
          WHERE conversation_id = ?
          ORDER BY captured_at DESC
          LIMIT 1
        `),
        listMessageUsageSnapshotsByConversation: db.prepare(`
          SELECT *
          FROM message_usage_snapshots
          WHERE conversation_id = ?
          ORDER BY captured_at ASC
        `),

        // queue
        insertQ:        db.prepare(insertQueueSql),
        queueHasImageOperationId,
        findPending:    db.prepare(`SELECT * FROM queue WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY retry_count ASC, CASE WHEN next_attempt_at IS NULL THEN 0 ELSE 1 END ASC, COALESCE(next_attempt_at, timestamp) ASC, timestamp ASC LIMIT 1`),
        findPendingForWorker: db.prepare(`
          SELECT q.*
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
            AND (
              COALESCE(
                NULLIF(q.owner_sdk_session_id, ''),
                NULLIF(rs.sdk_session_id, ''),
                NULLIF(c.sdk_session_id, '')
              ) IS NULL
              OR COALESCE(
                NULLIF(q.owner_sdk_session_id, ''),
                NULLIF(rs.sdk_session_id, ''),
                NULLIF(c.sdk_session_id, '')
              ) = ?
            )
          ORDER BY
            CASE
              WHEN COALESCE(
                NULLIF(q.owner_sdk_session_id, ''),
                NULLIF(rs.sdk_session_id, ''),
                NULLIF(c.sdk_session_id, '')
              ) = ? THEN 0
              ELSE 1
            END ASC,
            q.retry_count ASC,
            CASE WHEN q.next_attempt_at IS NULL THEN 0 ELSE 1 END ASC,
            COALESCE(q.next_attempt_at, q.timestamp) ASC,
            q.timestamp ASC
          LIMIT 1
        `),
        findPendingForSessionAffinity: db.prepare(`
          SELECT q.*
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
            AND COALESCE(
              NULLIF(q.owner_sdk_session_id, ''),
              NULLIF(rs.sdk_session_id, ''),
              NULLIF(c.sdk_session_id, '')
            ) = ?
          ORDER BY
            q.retry_count ASC,
            CASE WHEN q.next_attempt_at IS NULL THEN 0 ELSE 1 END ASC,
            COALESCE(q.next_attempt_at, q.timestamp) ASC,
            q.timestamp ASC
          LIMIT 1
        `),
        countQueueWorkForSessionAffinity: db.prepare(`
          SELECT COUNT(*) AS cnt
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE (
            (q.status = 'pending' AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?))
            OR q.status = 'processing'
          )
            AND COALESCE(
              NULLIF(q.owner_sdk_session_id, ''),
              NULLIF(rs.sdk_session_id, ''),
              NULLIF(c.sdk_session_id, '')
            ) = ?
        `),
        listPendingWorkerOwnerSessionIds: db.prepare(`
          SELECT COALESCE(
            NULLIF(q.owner_sdk_session_id, ''),
            NULLIF(rs.sdk_session_id, ''),
            NULLIF(c.sdk_session_id, '')
          ) AS sdk_session_id
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
            AND COALESCE(
              NULLIF(q.owner_sdk_session_id, ''),
              NULLIF(rs.sdk_session_id, ''),
              NULLIF(c.sdk_session_id, '')
            ) IS NOT NULL
          GROUP BY COALESCE(
            NULLIF(q.owner_sdk_session_id, ''),
            NULLIF(rs.sdk_session_id, ''),
            NULLIF(c.sdk_session_id, '')
          )
          ORDER BY MIN(q.timestamp) ASC
          LIMIT ?
        `),
        countStatus:    db.prepare(`SELECT status, COUNT(*) as cnt FROM queue WHERE status IN ('pending','processing','parked') GROUP BY status`),
        countRuntimeSessions: db.prepare(`SELECT COUNT(*) AS cnt FROM runtime_sessions WHERE status = 'active'`),
        setProcessing:  db.prepare(`UPDATE queue SET status = 'processing', processing_at = ? WHERE id = ?`),
        setProcessingWithWorkerLease: db.prepare(`
          UPDATE queue
          SET
            status = 'processing',
            processing_at = ?,
            owner_sdk_session_id = COALESCE(NULLIF(owner_sdk_session_id, ''), ?),
            owner_assigned_at = COALESCE(owner_assigned_at, ?),
            owner_lease_expires_at = ?,
            owner_last_claimed_at = ?
          WHERE id = ?
        `),
        setQueueRuntimeSession: db.prepare(`UPDATE queue SET runtime_session_id = ? WHERE id = ?`),
        setQueueResponseMessageId: db.prepare(`UPDATE queue SET response_message_id = ? WHERE id = ?`),
        setDone:        db.prepare(`UPDATE queue SET status = 'done', response = ?, processing_at = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL WHERE id = ? AND status IN ('processing', 'pending')`),
        setFailed:      db.prepare(`UPDATE queue SET status = 'failed', response = ?, processing_at = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL WHERE id = ?`),
        deleteConvQ:    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`),
        findQById:      db.prepare(`SELECT * FROM queue WHERE id = ?`),
        pruneQueue:     db.prepare(`DELETE FROM queue WHERE status = 'done' AND id NOT IN (SELECT id FROM queue WHERE status = 'done' ORDER BY timestamp DESC LIMIT 200)`),
        recoverStale:   db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, next_attempt_at = ?, owner_sdk_session_id = NULL, owner_assigned_at = NULL, owner_lease_expires_at = NULL, owner_last_claimed_at = NULL WHERE status = 'processing' AND processing_at < ?`),
        listRecoverableProcessing: db.prepare(`SELECT id, conversation_id FROM queue WHERE status = 'processing' AND processing_at < ?`),
        recoverProcessingBefore: db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, next_attempt_at = ?, owner_sdk_session_id = NULL, owner_assigned_at = NULL, owner_lease_expires_at = NULL, owner_last_claimed_at = NULL WHERE status = 'processing' AND processing_at < ?`),
        listQueueForPauseDrop: db.prepare(`SELECT id, conversation_id FROM queue WHERE status IN ('pending', 'processing', 'parked')`),
        deleteQueueById: db.prepare(`DELETE FROM queue WHERE id = ?`),
        getLatestProcessingQueueByConversation: db.prepare(`SELECT id, relay_mode, timestamp, processing_at FROM queue WHERE conversation_id = ? AND status = 'processing' ORDER BY COALESCE(processing_at, timestamp) DESC LIMIT 1`),
        parkPendingQueueForRestart: db.prepare(`
          UPDATE queue
          SET
            status = 'parked',
            next_attempt_at = NULL,
            parked_at = COALESCE(parked_at, @parkedAt),
            parked_target_session_id = @targetSessionId,
            parked_transaction_id = @transactionId,
            parked_reason = @reason
          WHERE status = 'pending'
        `),
        listParkedQueueForRelease: db.prepare(`
          SELECT id, conversation_id
          FROM queue
          WHERE status = 'parked'
            AND (
              parked_transaction_id IS NULL
              OR parked_transaction_id = ?
              OR parked_target_session_id = ?
            )
          ORDER BY COALESCE(parked_at, timestamp) ASC, timestamp ASC
        `),
        listAllParkedQueueForRelease: db.prepare(`
          SELECT id, conversation_id
          FROM queue
          WHERE status = 'parked'
          ORDER BY COALESCE(parked_at, timestamp) ASC, timestamp ASC
        `),
        releaseParkedQueueByIds: db.prepare(`
          UPDATE queue
          SET
            status = 'pending',
            parked_at = NULL,
            parked_target_session_id = NULL,
            parked_transaction_id = NULL,
            parked_reason = NULL
          WHERE id = ? AND status = 'parked'
        `),


        // uploads
        getUploadFile: db.prepare(`SELECT * FROM uploaded_files WHERE sha256 = ?`),
        insertUploadFile: db.prepare(`INSERT OR IGNORE INTO uploaded_files (sha256, original_name, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)`),
        insertUploadRef: db.prepare(`INSERT OR IGNORE INTO upload_refs (file_sha256, conversation_id, message_id, created_at) VALUES (?, ?, ?, ?)`),
        listUploadHashesByConversation: db.prepare(`SELECT DISTINCT file_sha256 FROM upload_refs WHERE conversation_id = ?`),
        deleteUploadRefsByConversation: db.prepare(`DELETE FROM upload_refs WHERE conversation_id = ?`),
        countUploadRefsBySha: db.prepare(`SELECT COUNT(*) AS cnt FROM upload_refs WHERE file_sha256 = ?`),
        deleteUploadFile: db.prepare(`DELETE FROM uploaded_files WHERE sha256 = ?`),
    };
}
