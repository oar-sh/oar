'use strict';

import { createShareVisibilityStatements } from './share-visibility-statements.mjs';
import { createMessagePinStatements } from './message-pin-statements.mjs';
import { createConversationHistoryPageStatements } from '../services/conversation-history-page.mjs';

/**
 * The claim's plan-boundary hold, part of every findPending*
 * statement: a pending row waits while its conversation has a live turn on
 * the other side of plan mode, because handing it to the worker would steer
 * it into that turn and switch what the turn may do. The conversation's later
 * rows wait behind it whatever their mode, so one conversation keeps its
 * order, while the claim goes on to other conversations' rows.
 * `PLAN_BOUNDARY_HOLD_MARK` lets a test find any claim without it.
 */
export const PLAN_BOUNDARY_HOLD_MARK = '/* plan-boundary-hold */';

export function planBoundaryHoldSql(alias) {
  return `${PLAN_BOUNDARY_HOLD_MARK} NOT EXISTS (
    SELECT 1
    FROM queue held
    JOIN queue live
      ON live.conversation_id = held.conversation_id
     AND live.status = 'processing'
     AND live.id != held.id
    WHERE held.conversation_id = ${alias}.conversation_id
      AND held.status = 'pending'
      AND COALESCE(held.kind, '') != 'continuation'
      AND (held.timestamp < ${alias}.timestamp OR (held.timestamp = ${alias}.timestamp AND held.rowid <= ${alias}.rowid))
      AND (LOWER(TRIM(COALESCE(live.relay_mode, ''))) = 'plan') != (LOWER(TRIM(COALESCE(held.relay_mode, ''))) = 'plan')
  )`;
}

/**
 * The session a queue row is bound to: its owner, else its runtime session's,
 * else its conversation's session. NULL for a row of a chat that was never
 * bound. Needs the aliases q (queue), rs (the row's runtime session) and c
 * (its conversation).
 */
export const QUEUE_ROW_BOUND_SESSION_SQL = `COALESCE(
              NULLIF(q.owner_sdk_session_id, ''),
              NULLIF(rs.sdk_session_id, ''),
              NULLIF(c.sdk_session_id, '')
            )`;

/**
 * The session a queue row belongs to: the bound one, else the session named
 * like its conversation (the id a worker of a chat that was never bound runs
 * under). Never NULL, so every pending row has one session whose worker may
 * claim it and for which the waker launches one. The claim
 * (findPendingForWorker) and the waker (listPendingWorkerOwnerSessionIds) both
 * read it, so they never disagree. Same aliases.
 */
export const QUEUE_ROW_SESSION_SQL = `COALESCE(${QUEUE_ROW_BOUND_SESSION_SQL}, q.conversation_id)`;

/**
 * A queue row whose conversation is not archived. The claim
 * (findPendingForWorker) and the waker (listPendingWorkerOwnerSessionIds)
 * both must read it, so they never disagree: a row of an archived
 * conversation is neither woken nor claimed until the conversation is
 * unarchived. Nor does such a pending row hold off host suspend
 * (listActiveQueueCountsByConversation). None is stranded by a send: every queue write into an archived
 * conversation unarchives it (queue-insert.mjs). A row whose conversation row
 * is missing passes, as before. Needs the alias c (its conversation).
 */
export const QUEUE_ROW_NOT_ARCHIVED_SQL = 'COALESCE(c.archived, 0) = 0';

/**
 * The clause that leaves out a turn paused at the Claude usage limit
 * (usage-limit-pause-service) while its hold lasts: a pending follow-up held
 * until the reset. The waker, the queue counts and the unarchive's wake
 * (conversation-lifecycle-routes) all read it, so they never disagree. An
 * empty clause when the queue has no usage_limit_pause column (hasColumn).
 */
export function notHeldForUsageLimit(alias = '', hasColumn = true) {
    return hasColumn
        ? `AND NOT (${alias}usage_limit_pause IS NOT NULL AND ${alias}status = 'pending' AND ${alias}next_attempt_at IS NOT NULL AND ${alias}next_attempt_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
        : '';
}

/**
 * What a row's terminal failure ends with it, called inside the failure's
 * transaction once the row is failed: every pending question card of the
 * row (any attempt's) is cancelled, and every pending Stop of it settled as
 * failed, since no worker takes the row again. Needs the question
 * repository's statements in `stmts`. Returns the cancelled cards' ids, for
 * the caller to announce after the commit.
 */
export function settleFailedRowControlsAndCards(stmts, rowId, at) {
    stmts.settleAbortControlsForFailedRow.run(at, at, rowId);
    return stmts.cancelPendingQuestionsForRow.all(at, rowId).map((question) => question.id);
}

export function createMessageRepository(db) {
    const shareVisibility = createShareVisibilityStatements(db);
    const messagePins = createMessagePinStatements(db);
    const queueHasImageOperationId = db.prepare(`PRAGMA table_info(queue)`).all()
        .some((column) => column.name === 'image_operation_id');
    // A turn paused at the Claude usage limit (usage-limit-pause-service): a
    // pending follow-up held until the reset. It is not work waiting for a
    // worker, so it neither keeps one warm nor counts as queued.
    const queueHasUsageLimitPause = db.prepare(`PRAGMA table_info(queue)`).all()
        .some((column) => column.name === 'usage_limit_pause');
    const queueHasProvider = db.prepare(`PRAGMA table_info(queue)`).all()
        .some((column) => column.name === 'provider');
    // When a processing row is due for the stale sweep; one rule for the
    // listings and the requeue, so the UPDATE can never take a row the
    // listing did not. Inactivity is measured from the last heartbeat, the
    // ceiling (@ceilingBefore, NULL = no limit) from the later of the turn's
    // start and its last answered question, and a turn waiting on an
    // unanswered question is never due. The comments at the statements say why.
    const staleProcessingSql = `(
              (
                COALESCE(owner_last_claimed_at, processing_at, timestamp) < @inactiveBefore
                OR (
                  @ceilingBefore IS NOT NULL
                  AND MAX(
                    COALESCE(processing_at, timestamp),
                    COALESCE((SELECT MAX(answered_at) FROM relay_questions WHERE queue_id = queue.id), '')
                  ) < @ceilingBefore
                )
              )
              AND id NOT IN (SELECT queue_id FROM relay_questions WHERE status = 'pending')
            )`;
    const messageColumns = new Set(db.prepare(`PRAGMA table_info(messages)`).all().map((column) => column.name));
    const messagesHaveSourceId = messageColumns.has('source_message_id');
    const messagesHaveResendOf = messageColumns.has('resend_of_message_id');
    const insertQueueSql = queueHasImageOperationId
        ? `INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, model_variant_id, reasoning_effort, context_tier, relay_mode, text, attachments, status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id, owner_assigned_at, owner_lease_expires_at, owner_last_claimed_at, image_operation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?, ?, ?, ?)`
        : `INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, model_variant_id, reasoning_effort, context_tier, relay_mode, text, attachments, status, timestamp, retry_count, next_attempt_at, owner_sdk_session_id, owner_assigned_at, owner_lease_expires_at, owner_last_claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, NULL, ?, ?, ?, ?)`;
    return {
        // messages
        getMessages:    db.prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC`),
        getSharedMessages: shareVisibility.getSharedMessages,
        // One history page in SQL (conversation-history-page.mjs).
        conversationHistoryPage: createConversationHistoryPageStatements(db),
        getMessageByConversation: db.prepare(`SELECT * FROM messages WHERE id = ? AND conversation_id = ? LIMIT 1`),
        setMessageShareVisibility: shareVisibility.setMessageShareVisibility,
        listHiddenMessages: shareVisibility.listHiddenMessages,
        setMessagePinnedAt: messagePins.setMessagePinnedAt,
        listPinnedMessages: messagePins.listPinnedMessages,
        countPinnedMessages: messagePins.countPinnedMessages,
        getLatestConversationModel: db.prepare(`SELECT model FROM messages WHERE conversation_id = ? AND model IS NOT NULL AND model != '' ORDER BY timestamp DESC LIMIT 1`),
        // The model of the conversation's latest user turn: one of the
        // fallbacks for a send that names no model.
        getLatestUserMessageModel: db.prepare(`SELECT model FROM messages WHERE conversation_id = ? AND role = 'user' AND model IS NOT NULL AND model != '' ORDER BY timestamp DESC LIMIT 1`),
        getRecentMessagesDesc: db.prepare(`SELECT id, role, text, timestamp FROM messages WHERE conversation_id = ? ORDER BY timestamp DESC LIMIT ?`),
        insertMsg:      db.prepare(`INSERT INTO messages (id, conversation_id, role, text, model, mode, attachments, timestamp, model_requested, model_actual, model_origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        // Provenance is derived from the authenticated responder identity at
        // /api/response time, never from the response payload.
        setMessageExecutedProvider: db.prepare(`UPDATE messages SET executed_provider = ? WHERE id = ?`),
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
        getMessageUsageSnapshotByResponse: db.prepare(`
          SELECT *
          FROM message_usage_snapshots
          WHERE response_message_id = ? AND conversation_id = ?
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
        // A background-continuation turn: born 'processing' and owned by its
        // session worker — the CLI already started it on its own, so it must
        // never be handed out as deliverable work.
        insertContinuationQ: db.prepare(`INSERT INTO queue (id, conversation_id, runtime_session_id, is_new_conversation, model, relay_mode, text, status, kind, timestamp, processing_at, retry_count, owner_sdk_session_id, owner_assigned_at, owner_lease_expires_at, owner_last_claimed_at, attempt_id, continuation_op_id) VALUES (?, ?, ?, 0, ?, ?, ?, 'processing', 'continuation', ?, ?, 0, ?, ?, ?, ?, ?, ?)`),
        // Idempotent continuation registration: a worker retry after a lost
        // response resolves to the row its operation id already created.
        findQByContinuationOp: db.prepare(`SELECT * FROM queue WHERE continuation_op_id = ?`),
        setMessageKind: db.prepare(`UPDATE messages SET kind = ? WHERE id = ?`),
        // The durable answer→prompt link (the queue's copy is pruned), so a
        // reload still anchors the reply under the message it answers.
        setMessageSourceId: messagesHaveSourceId
            ? db.prepare(`UPDATE messages SET source_message_id = ? WHERE id = ?`)
            : null,
        setMessageResendOf: messagesHaveResendOf
            ? db.prepare(`UPDATE messages SET resend_of_message_id = ? WHERE id = ?`)
            : null,
        // Quiet teardown for a continuation whose worker died: there is no
        // user to answer, so it fails without the terminal-failure ceremony.
        dropStaleContinuation: db.prepare(`UPDATE queue SET status = 'failed', processing_at = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL WHERE id = ? AND status = 'processing' AND kind = 'continuation'`),
        // Claim ordering (findPendingForWorker): strict send order, rowid
        // breaking same-millisecond ties.
        // Neither retry_count nor next_attempt_at may rank rows: dead-worker
        // recovery and /api/requeue bump retry_count, so ranking by it ran a
        // recovered OLDER message after newer ones in the same conversation,
        // and ranking expired-backoff rows behind fresh arrivals starved them
        // for as long as new messages kept coming (live 2026-09-19: a
        // steer-recovered row waited 5 minutes while newer messages jumped
        // it). Head-of-line protection is the WHERE clause's next_attempt_at
        // backoff plus MAX_REQUEUE_RETRIES, which fails a row for good.
        findPendingForWorker: db.prepare(`
          SELECT q.*
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND COALESCE(q.kind, '') != 'continuation'
            AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
            -- Only the requesting session's own rows: a row is never handed to
            -- the worker of another session, whatever its provider.
            AND ${QUEUE_ROW_SESSION_SQL} = ?
            AND ${QUEUE_ROW_NOT_ARCHIVED_SQL}
            AND ${planBoundaryHoldSql('q')}
          ORDER BY
            q.timestamp ASC,
            q.rowid ASC
          LIMIT 1
        `),
        // The sessions with pending rows, for the waker to launch. A row of a
        // conversation that is gone (no row, or deleted and about to be
        // removed with its queue) or archived launches nothing.
        listPendingWorkerOwnerSessionIds: db.prepare(`
          SELECT ${QUEUE_ROW_SESSION_SQL} AS sdk_session_id
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            ${notHeldForUsageLimit('q.', queueHasUsageLimitPause)}
            AND c.id IS NOT NULL
            AND c.status != 'deleted'
            AND ${QUEUE_ROW_NOT_ARCHIVED_SQL}
          GROUP BY ${QUEUE_ROW_SESSION_SQL}
          ORDER BY MIN(q.timestamp) ASC
          LIMIT ?
        `),
        // Pending rows no worker will take because their conversation is gone:
        // no row any more (the queue has no foreign key to it), or deleted
        // before the cutoff and not removed with its queue, as when the relay
        // stopped between the two steps of a delete. A delete normally
        // removes them itself, so the cutoff leaves it the time to.
        listPendingRowsOfGoneConversations: db.prepare(`
          SELECT q.id, q.conversation_id
          FROM queue q
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND (c.id IS NULL OR (c.status = 'deleted' AND c.updated_at < ?))
          ORDER BY q.timestamp ASC, q.rowid ASC
        `),
        // Pending rows of a live conversation that are bound to no session:
        // before the conversation id became the last owner fallback, no worker
        // was launched for them. How many there are and the oldest's send time.
        summarizeUnboundPendingRows: db.prepare(`
          SELECT COUNT(*) AS count, MIN(q.timestamp) AS oldest_at
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND c.status != 'deleted'
            AND ${QUEUE_ROW_BOUND_SESSION_SQL} IS NULL
        `),
        // The same rows, sent before the cutoff.
        listUnboundPendingRowsBefore: db.prepare(`
          SELECT q.id, q.conversation_id, q.model, q.relay_mode, q.timestamp
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND c.status != 'deleted'
            AND ${QUEUE_ROW_BOUND_SESSION_SQL} IS NULL
            AND q.timestamp < ?
          ORDER BY q.timestamp ASC, q.rowid ASC
        `),
        // A session's waiting rows the worker would claim (not the
        // continuations it starts itself): failed in one go when its
        // provider cannot run a turn (the Copilot switch off).
        listPendingRowsForSession: db.prepare(`
          SELECT q.id
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND ${QUEUE_ROW_SESSION_SQL} = ?
            AND COALESCE(q.kind, '') != 'continuation'
        `),
        // A session's pending rows on the Claude API key (a row's stamp, else
        // the billing bound with the second parameter): failed closed instead
        // of a launch while Claude API cannot run a turn
        // (server-runtime.mjs, failClaudeApiRowsWithoutLaunch). The rows of the
        // session as the claim reads them, ownerless ones included.
        listPendingClaudeApiRowsForSession: db.prepare(`
          SELECT q.id
          FROM queue q
          LEFT JOIN runtime_sessions rs
            ON rs.id = q.runtime_session_id
          LEFT JOIN conversations c
            ON c.id = q.conversation_id
          WHERE q.status = 'pending'
            AND ${QUEUE_ROW_SESSION_SQL} = ?
            AND COALESCE(q.kind, '') != 'continuation'
            AND LOWER(COALESCE(${queueHasProvider ? 'q.provider' : 'NULL'}, ?)) = 'claude-api'
        `),
        // A pending row of an archived chat is neither claimed nor woken
        // (QUEUE_ROW_NOT_ARCHIVED_SQL), so it is not queued work; a processing
        // or parked one still counts.
        countStatus:    db.prepare(`SELECT status, COUNT(*) as cnt FROM queue WHERE status IN ('pending','processing','parked') ${notHeldForUsageLimit('', queueHasUsageLimitPause)} AND NOT (status = 'pending' AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = queue.conversation_id AND c.archived = 1)) GROUP BY status`),
        // A failed row's Stops (settleFailedRowControlsAndCards).
        settleAbortControlsForFailedRow: db.prepare(`
          UPDATE relay_control_requests
          SET status = 'failed', error = 'queue-failed', updated_at = ?, completed_at = ?
          WHERE queue_message_id = ?
            AND type IN ('abort_turn', 'abort_subagent')
            AND status IN ('pending', 'processing')
        `),
        // Stale recovery has nothing to look at while no row is processing.
        hasProcessingRow: db.prepare(`SELECT 1 AS present FROM queue WHERE status = 'processing' LIMIT 1`),
        // The earliest future retry time of a pending row (a backoff, a
        // usage-limit hold): the relay wakes its queue then. A hold until the
        // user resumes (year 9999) is no time.
        nextPendingAttemptAt: db.prepare(`
          SELECT MIN(next_attempt_at) AS due FROM queue
          WHERE status = 'pending' AND next_attempt_at IS NOT NULL
            AND next_attempt_at > ? AND next_attempt_at < '9999'
        `),
        // Deferred host suspend: which conversations still hold live turns. A
        // pending row of an archived chat is no turn to wait for: nothing
        // claims it until the chat is unarchived. A processing one still
        // counts, as a live worker may be running it.
        listActiveQueueCountsByConversation: db.prepare(`
          SELECT q.conversation_id, COUNT(*) AS cnt, MAX(c.title) AS title
          FROM queue q LEFT JOIN conversations c ON c.id = q.conversation_id
          WHERE (q.status IN ('processing','parked') OR (q.status = 'pending' AND ${QUEUE_ROW_NOT_ARCHIVED_SQL}))
          GROUP BY q.conversation_id
        `),
        countRuntimeSessions: db.prepare(`SELECT COUNT(*) AS cnt FROM runtime_sessions WHERE status = 'active'`),
        setProcessingWithWorkerLease: db.prepare(`
          UPDATE queue
          SET
            status = 'processing',
            processing_at = ?,
            attempt_id = ?,
            owner_sdk_session_id = COALESCE(NULLIF(owner_sdk_session_id, ''), ?),
            owner_assigned_at = COALESCE(owner_assigned_at, ?),
            owner_lease_expires_at = ?,
            owner_last_claimed_at = ?
          WHERE id = ?
        `),
        setQueueRuntimeSession: db.prepare(`UPDATE queue SET runtime_session_id = ? WHERE id = ?`),
        // The billing a row runs on (migration 0031): a continuation is the
        // kind of the worker whose CLI started it, whatever the chat's now.
        setQueueProvider: queueHasProvider
          ? db.prepare(`UPDATE queue SET provider = ? WHERE id = ?`)
          : null,
        setQueueResponseMessageId: db.prepare(`UPDATE queue SET response_message_id = ? WHERE id = ?`),
        // Legacy (unfenced) finalization keeps 'pending' in the set so a
        // response landing after a stale-sweep requeue still finalizes; fenced
        // finalization deliberately does not — a fenced writer whose row went
        // back to pending has by definition been superseded.
        setDone:        db.prepare(`UPDATE queue SET status = 'done', response = ?, processing_at = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL WHERE id = ? AND status IN ('processing', 'pending')`),
        setDoneFenced:  db.prepare(`UPDATE queue SET status = 'done', response = ?, processing_at = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL WHERE id = ? AND status = 'processing' AND attempt_id = ?`),
        // The status set mirrors canTerminalFail (processing/pending/parked):
        // failure must never overwrite a row another attempt already settled.
        setFailed:      db.prepare(`UPDATE queue SET status = 'failed', response = ?, processing_at = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL WHERE id = ? AND status IN ('processing', 'pending', 'parked')`),
        setFailedFenced: db.prepare(`UPDATE queue SET status = 'failed', response = ?, processing_at = NULL, next_attempt_at = NULL, owner_lease_expires_at = NULL WHERE id = ? AND status = 'processing' AND attempt_id = ?`),
        deleteConvQ:    db.prepare(`DELETE FROM queue WHERE conversation_id = ?`),
        findQById:      db.prepare(`SELECT * FROM queue WHERE id = ?`),
        pruneQueue:     db.prepare(`DELETE FROM queue WHERE status = 'done' AND id NOT IN (SELECT id FROM queue WHERE status = 'done' ORDER BY timestamp DESC LIMIT 200)`),
        // Recovery clears only the lease, never the owner: a recovered row must
        // stay routed to its provider worker so the primer respawns that worker
        // instead of the row becoming claimable by the global relay poll.
        recoverStale:   db.prepare(`UPDATE queue SET status = 'pending', processing_at = NULL, attempt_id = NULL, next_attempt_at = ?, owner_lease_expires_at = NULL, owner_last_claimed_at = NULL WHERE status = 'processing' AND COALESCE(kind, '') != 'continuation' AND consumed_at IS NULL AND processing_at < ?`),
        // Staleness is inactivity, not elapsed turn time: owner_last_claimed_at is
        // refreshed by every worker heartbeat for the message it is working on, so a
        // long-but-alive turn keeps moving the cutoff. processing_at is only the
        // fallback for rows without an owner (session-worker routing disabled), and
        // it is what the separate absolute ceiling measures.
        //
        // A turn blocked on an unanswered AskUserQuestion is never stale — it is
        // waiting on the human, and relay_questions carries its own expiry.
        //
        // The ceiling counts from the last human interaction with the turn, not
        // from its start: answering a question restarts the clock. Otherwise an
        // interview that waited hours for its answers would be cut off by the
        // ceiling the moment the last answer arrived (live 2026-10-10: a
        // five-question interview lost its reply that way).
        listRecoverableProcessing: db.prepare(`
          SELECT id, conversation_id, kind, relay_mode, model, retry_count, consumed_at
          FROM queue
          WHERE status = 'processing'
            AND COALESCE(kind, '') != 'continuation'
            AND ${staleProcessingSql}
        `),
        // Requeues one row listRecoverableProcessing returned, so the caller
        // knows exactly which rows it requeued and announces only those. The
        // sweep runs synchronously, so nothing changes between listing and
        // requeue; re-checking the same rule here is a safeguard that keeps
        // this statement from ever taking a row the listing would not.
        recoverProcessingBefore: db.prepare(`
          UPDATE queue
          SET status = 'pending',
              processing_at = NULL,
              attempt_id = NULL,
              next_attempt_at = @requeueAt,
              owner_lease_expires_at = NULL,
              owner_last_claimed_at = NULL,
              retry_count = retry_count + 1
          WHERE id = @id
            AND status = 'processing'
            AND COALESCE(kind, '') != 'continuation'
            AND consumed_at IS NULL
            AND ${staleProcessingSql}
        `),
        // Dead-worker recovery: the owner's process is provably gone, so its
        // in-flight rows go back to pending — owner intact (the primer
        // respawns that worker; the row must never become global prey) and
        // retry_count incremented so a worker that dies on every delivery
        // eventually exhausts the same budget as any other retry loop. The
        // pending-question exemption deliberately does NOT apply here: a dead
        // worker can never collect its answer, so holding the row would leak
        // both the row and the question.
        listProcessingRowsForOwner: db.prepare(`
          SELECT id, conversation_id, kind, retry_count, consumed_at, relay_mode, model
          FROM queue
          WHERE status = 'processing'
            AND NULLIF(owner_sdk_session_id, '') = ?
        `),
        // The worker recycle's quiet window (worker-recycle-service.mjs): the
        // last time the session had a delivery or a turn end, as an ISO
        // string, or NULL when the queue holds no row of it. Over the rows the
        // session owns: a row is stamped with its owner at enqueue under
        // session-worker routing and at the latest by its claim, and a
        // conversation rebound to another session leaves its old rows with the
        // session that ran them. The queue keeps no completion time
        // (setDone clears processing_at), so a turn's end is its response
        // message's timestamp; the claim and the heartbeat lease
        // (owner_last_claimed_at) and the assignment stand for the delivery.
        // Each column is COALESCEd: SQLite's multi-argument MAX() is NULL as
        // soon as one argument is.
        getOwnerLastActivityAt: db.prepare(`
          SELECT MAX(NULLIF(MAX(
            COALESCE(q.processing_at, ''),
            COALESCE(q.owner_assigned_at, ''),
            COALESCE(q.owner_last_claimed_at, ''),
            COALESCE(m.timestamp, '')
          ), '')) AS last_activity_at
          FROM queue q
          LEFT JOIN messages m ON m.id = q.response_message_id
          WHERE NULLIF(q.owner_sdk_session_id, '') = ?
        `),
        recoverProcessingRowKeepOwner: db.prepare(`
          UPDATE queue
          SET status = 'pending',
              processing_at = NULL,
              attempt_id = NULL,
              next_attempt_at = ?,
              owner_lease_expires_at = NULL,
              owner_last_claimed_at = NULL,
              retry_count = retry_count + 1
          WHERE id = ? AND status = 'processing' AND consumed_at IS NULL
        `),
        // See the queue.consumed_at migration: at-most-once rows.
        // Fenced like every other worker write: the row must be processing in
        // this conversation, owned by the same worker session (NULL-safe, for
        // routing-disabled installs), and — when the caller names one — still
        // on the attempt it was pushed under.
        markQueueConsumed: db.prepare(`
          UPDATE queue
          SET consumed_at = COALESCE(consumed_at, @at)
          WHERE id = @id AND conversation_id = @conversationId AND status = 'processing'
            AND NULLIF(owner_sdk_session_id, '') IS @owner
            AND (@attemptId IS NULL OR attempt_id = @attemptId)
        `),
        // A consumed steer the CLI then replayed as a turn of its own is an
        // ordinary in-flight row again.
        clearQueueConsumed: db.prepare(`
          UPDATE queue
          SET consumed_at = NULL
          WHERE id = @id AND conversation_id = @conversationId AND status = 'processing'
            AND NULLIF(owner_sdk_session_id, '') IS @owner
            AND (@attemptId IS NULL OR attempt_id = @attemptId)
        `),
        listProcessingOwnerSessionIds: db.prepare(`
          SELECT DISTINCT NULLIF(owner_sdk_session_id, '') AS sdk_session_id
          FROM queue
          WHERE status = 'processing'
            AND NULLIF(owner_sdk_session_id, '') IS NOT NULL
          LIMIT ?
        `),
        // A continuation with no live worker can only be torn down — replaying
        // it as deliverable work would send the CLI's own bookkeeping text back
        // to the CLI as a user prompt.
        //
        // Same staleness rules as listRecoverableProcessing: a continuation
        // waiting on an unanswered question is never stale, and an answer
        // restarts the ceiling clock. A background-agent interview hangs its
        // question cards on the continuation row, so without this a long
        // interview was torn down by the ceiling while the human was still
        // answering (live 2026-10-10).
        listStaleProcessingContinuations: db.prepare(`
          SELECT id, conversation_id, timestamp, processing_at, owner_last_claimed_at
          FROM queue
          WHERE status = 'processing'
            AND kind = 'continuation'
            AND ${staleProcessingSql}
        `),
        listQueueForPauseDrop: db.prepare(`SELECT id, conversation_id FROM queue WHERE status IN ('pending', 'processing', 'parked')`),
        // Authoritative "is a turn in flight" signal for the conversation list.
        // Clients otherwise track this from one-shot message_status socket events,
        // which are lost if the socket drops between the final status and delivery.
        listConversationIdsWithActiveQueue: db.prepare(`SELECT DISTINCT conversation_id FROM queue WHERE status IN ('pending', 'processing', 'parked')`),
        deleteQueueById: db.prepare(`DELETE FROM queue WHERE id = ?`),
        getLatestProcessingQueueByConversation: db.prepare(`SELECT id, relay_mode, timestamp, processing_at FROM queue WHERE conversation_id = ? AND status = 'processing' ORDER BY COALESCE(processing_at, timestamp) DESC LIMIT 1`),
        // All processing rows, oldest first. Mid-turn steering means a
        // conversation can have more than one processing row at once (the live
        // turn plus a steered message folded into it), so the single-row query
        // above is ambiguous — callers that need "the live turn" resolve it
        // from this list by which row is actually producing output.
        listProcessingQueueByConversation: db.prepare(`SELECT id, relay_mode, timestamp, processing_at FROM queue WHERE conversation_id = ? AND status = 'processing' ORDER BY COALESCE(processing_at, timestamp) ASC`),
        // Read-only: how many rows are parked and when the oldest was parked.
        summarizeParkedQueue: db.prepare(`
          SELECT COUNT(*) AS count, MIN(COALESCE(parked_at, timestamp)) AS oldest_parked_at
          FROM queue
          WHERE status = 'parked'
        `),

        // uploads
        getUploadFile: db.prepare(`SELECT * FROM uploaded_files WHERE sha256 = ?`),
        insertUploadFile: db.prepare(`INSERT OR IGNORE INTO uploaded_files (sha256, original_name, mime_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)`),
        insertUploadRef: db.prepare(`INSERT OR IGNORE INTO upload_refs (file_sha256, conversation_id, message_id, created_at) VALUES (?, ?, ?, ?)`),
        listUploadHashesByConversation: db.prepare(`SELECT DISTINCT file_sha256 FROM upload_refs WHERE conversation_id = ?`),
        deleteUploadRefsByConversation: db.prepare(`DELETE FROM upload_refs WHERE conversation_id = ?`),
        countUploadRefsBySha: db.prepare(`SELECT COUNT(*) AS cnt FROM upload_refs WHERE file_sha256 = ?`),
        deleteUploadFile: db.prepare(`DELETE FROM uploaded_files WHERE sha256 = ?`),

        // Draft attachment references use a sentinel message id so a composer
        // draft can hold a blob alive before any message exists.
        listDraftUploadHashes: db.prepare(`SELECT file_sha256 FROM upload_refs WHERE conversation_id = ? AND message_id = '__draft__'`),
        deleteDraftUploadRefs: db.prepare(`DELETE FROM upload_refs WHERE conversation_id = ? AND message_id = '__draft__'`),
        deleteDraftUploadRef: db.prepare(`DELETE FROM upload_refs WHERE conversation_id = ? AND message_id = '__draft__' AND file_sha256 = ?`),
    };
}
