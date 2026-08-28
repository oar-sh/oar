'use strict';

export function createQuestionRepository(db) {
    return {
        // relay questions
        insertQuestion: db.prepare(`INSERT INTO relay_questions (id, queue_id, conversation_id, message_id, relay_mode, prompt, choices, request, request_schema, status, answer, structured_answer, sdk_session_id, owner_worker_id, continuation_id, continuation_question_id, created_at, answered_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, ?, NULL, ?)`),
        getQuestion:    db.prepare(`SELECT * FROM relay_questions WHERE id = ?`),
        findPendingQuestionByMessage: db.prepare(`SELECT * FROM relay_questions WHERE message_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`),
        listPendingQuestionsByMessage: db.prepare(`SELECT * FROM relay_questions WHERE message_id = ? AND status = 'pending' ORDER BY created_at ASC`),
        findRecentlyAnsweredQuestionByMessage: db.prepare(`SELECT * FROM relay_questions WHERE message_id = ? AND status = 'answered' AND answered_at >= ? ORDER BY answered_at DESC LIMIT 1`),
        listQuestions:  db.prepare(`SELECT * FROM relay_questions WHERE status = ? AND (? IS NULL OR conversation_id = ?) ORDER BY created_at ASC`),
        timeoutQuestion:db.prepare(`UPDATE relay_questions SET status = 'timed_out' WHERE id = ? AND status = 'pending'`),
        cancelPendingQuestionsByMessage: db.prepare(`UPDATE relay_questions SET status = 'cancelled', answered_at = COALESCE(answered_at, ?) WHERE message_id = ? AND status = 'pending'`),
        deleteConvQuestions: db.prepare(`DELETE FROM relay_questions WHERE conversation_id = ?`),
        expireQuestions: db.prepare(`UPDATE relay_questions SET status = 'timed_out' WHERE status = 'pending' AND expires_at < ?`),

        // relay activity
        insertActivity: db.prepare(`INSERT INTO relay_activity (queue_message_id, response_message_id, conversation_id, relay_mode, text, created_at, subagent_run_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        linkActivityToResponse: db.prepare(`UPDATE relay_activity SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
        listActivityByResponse: db.prepare(`SELECT text, subagent_run_id, metadata_json FROM relay_activity WHERE response_message_id = ? ORDER BY id ASC`),
        listActivityByQueueMessage: db.prepare(`SELECT text, subagent_run_id, metadata_json FROM relay_activity WHERE queue_message_id = ? ORDER BY id ASC`),
        deleteConvActivity: db.prepare(`DELETE FROM relay_activity WHERE conversation_id = ?`),

        // relay stream events — every update carries the full text-so-far
        // (all workers publish cumulative snapshots), so the store keeps ONE
        // row per (queue message, subagent thread) and replaces it in place.
        getLastStreamSeqByQueueMessage: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM relay_stream_events WHERE queue_message_id = ?`),
        getStreamEventByQueueAndThread: db.prepare(`SELECT id, seq, done FROM relay_stream_events WHERE queue_message_id = ? AND subagent_run_id IS ? LIMIT 1`),
        insertStreamEvent: db.prepare(`INSERT INTO relay_stream_events (queue_message_id, response_message_id, conversation_id, relay_mode, seq, text, done, created_at, subagent_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        updateStreamEventByQueueAndThread: db.prepare(`
          UPDATE relay_stream_events
          SET response_message_id = COALESCE(response_message_id, ?),
              conversation_id = ?,
              relay_mode = ?,
              seq = ?,
              text = ?,
              done = CASE WHEN done = 1 OR ? = 1 THEN 1 ELSE 0 END,
              created_at = ?
          WHERE queue_message_id = ?
            AND subagent_run_id IS ?
        `),
        linkStreamEventsToResponse: db.prepare(`UPDATE relay_stream_events SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
        listStreamEventsByResponse: db.prepare(`SELECT seq, text, done, created_at, subagent_run_id FROM relay_stream_events WHERE response_message_id = ? ORDER BY seq ASC, id ASC`),
        listStreamEventsByQueueMessage: db.prepare(`SELECT seq, text, done, created_at, subagent_run_id FROM relay_stream_events WHERE queue_message_id = ? ORDER BY seq ASC, id ASC`),
        deleteConvStreamEvents: db.prepare(`DELETE FROM relay_stream_events WHERE conversation_id = ?`),

        // relay thoughts (agent reasoning)
        getLastThoughtSeqByQueueMessage: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM relay_thought WHERE queue_message_id = ?`),
        getThoughtByQueueAndReasoning: db.prepare(`SELECT seq FROM relay_thought WHERE queue_message_id = ? AND reasoning_id = ? LIMIT 1`),
        insertThought: db.prepare(`INSERT INTO relay_thought (queue_message_id, response_message_id, conversation_id, relay_mode, reasoning_id, seq, text, done, created_at, subagent_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        updateThoughtByQueueAndReasoning: db.prepare(`
          UPDATE relay_thought
          SET response_message_id = COALESCE(response_message_id, ?),
              conversation_id = ?,
              relay_mode = ?,
              text = ?,
              done = CASE WHEN done = 1 OR ? = 1 THEN 1 ELSE 0 END,
              created_at = ?,
              subagent_run_id = COALESCE(?, subagent_run_id)
          WHERE queue_message_id = ?
            AND reasoning_id = ?
        `),
        linkThoughtsToResponse: db.prepare(`UPDATE relay_thought SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
        listThoughtsByResponse: db.prepare(`SELECT reasoning_id, seq, text, done, created_at, subagent_run_id FROM relay_thought WHERE response_message_id = ? ORDER BY seq ASC, id ASC`),
        listThoughtsByQueueMessage: db.prepare(`SELECT reasoning_id, seq, text, done, created_at, subagent_run_id FROM relay_thought WHERE queue_message_id = ? ORDER BY seq ASC, id ASC`),
        deleteConvThoughts: db.prepare(`DELETE FROM relay_thought WHERE conversation_id = ?`),

        // subagent runs
        insertSubagentRun: db.prepare(`
          INSERT INTO subagent_runs (
            id, queue_message_id, conversation_id, parent_subagent_id, display_name, status, started_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
        `),
        getSubagentRun: db.prepare(`SELECT * FROM subagent_runs WHERE id = ?`),
        updateSubagentRunStatus: db.prepare(`
          UPDATE subagent_runs
          SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
          WHERE id = ?
        `),
        listSubagentRunsByQueueMessage: db.prepare(`
          SELECT id, queue_message_id, conversation_id, parent_subagent_id, display_name, status, started_at, updated_at, completed_at
          FROM subagent_runs
          WHERE queue_message_id = ?
          ORDER BY started_at ASC, id ASC
        `),
        // Terminal-state reconciliation: whatever ends a turn (response, fail,
        // abort) also ends its subagent runs — nothing else ever will, and an
        // un-reconciled row renders as a bubble stuck "running" forever.
        listRunningSubagentRunsByQueueMessage: db.prepare(`
          SELECT id, conversation_id, parent_subagent_id, display_name
          FROM subagent_runs
          WHERE queue_message_id = ? AND status = 'running'
        `),
        closeRunningSubagentRunsByQueueMessage: db.prepare(`
          UPDATE subagent_runs
          SET status = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?)
          WHERE queue_message_id = ? AND status = 'running'
        `),
        listSubagentRunsByResponse: db.prepare(`
          SELECT sr.id, sr.queue_message_id, sr.conversation_id, sr.parent_subagent_id, sr.display_name, sr.status, sr.started_at, sr.updated_at, sr.completed_at
          FROM subagent_runs sr
          WHERE sr.queue_message_id IN (
            SELECT id FROM queue WHERE response_message_id = ?
            UNION
            SELECT DISTINCT queue_message_id FROM relay_activity WHERE response_message_id = ? AND queue_message_id IS NOT NULL
            UNION
            SELECT DISTINCT queue_message_id FROM relay_thought WHERE response_message_id = ? AND queue_message_id IS NOT NULL
          )
          ORDER BY sr.started_at ASC, sr.id ASC
        `),
        deleteConvSubagentRuns: db.prepare(`DELETE FROM subagent_runs WHERE conversation_id = ?`),

        // workflow runs — final digests of settled background workflows,
        // attached to the assistant message that reports the completion.
        // Inserted inside the /api/response finalize transaction, so rows key
        // directly on the response message id (unlike subagent_runs, which are
        // written before the response id exists and need queue-id resolution).
        insertWorkflowRun: db.prepare(`
          INSERT INTO workflow_runs (
            id, response_message_id, conversation_id, run_index, digest_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `),
        listWorkflowRunsByResponse: db.prepare(`
          SELECT id, response_message_id, conversation_id, run_index, digest_json, created_at
          FROM workflow_runs
          WHERE response_message_id = ?
          ORDER BY run_index ASC, id ASC
        `),
        deleteConvWorkflowRuns: db.prepare(`DELETE FROM workflow_runs WHERE conversation_id = ?`),

        // preview cards — snapshots of previews published mid-turn, written
        // with the queue id and linked to the response at finalize (the same
        // two-step relay_activity uses, because the response id does not exist
        // while the turn is still running).
        insertPreviewCard: db.prepare(`
          INSERT INTO preview_cards (
            id, queue_message_id, response_message_id, conversation_id, preview_json, created_at
          ) VALUES (?, ?, NULL, ?, ?, ?)
        `),
        linkPreviewCardsToResponse: db.prepare(`UPDATE preview_cards SET response_message_id = ? WHERE queue_message_id = ? AND response_message_id IS NULL`),
        listPreviewCardsByResponse: db.prepare(`
          SELECT id, preview_json, created_at
          FROM preview_cards
          WHERE response_message_id = ?
          ORDER BY created_at ASC, id ASC
        `),
        deleteConvPreviewCards: db.prepare(`DELETE FROM preview_cards WHERE conversation_id = ?`),

        // relay boards
        insertBoard: db.prepare(`INSERT INTO relay_boards (id, queue_id, conversation_id, message_id, board_type, relay_mode, title, body, actions_json, recommended_action, context_json, status, selected_action, acted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`),
        getBoard: db.prepare(`SELECT * FROM relay_boards WHERE id = ?`),
        findBoardByMessageType: db.prepare(`SELECT * FROM relay_boards WHERE message_id = ? AND board_type = ? ORDER BY created_at DESC LIMIT 1`),
        listBoards: db.prepare(`SELECT * FROM relay_boards WHERE status = ? AND (? IS NULL OR conversation_id = ?) ORDER BY created_at ASC`),
        markBoardAction: db.prepare(`UPDATE relay_boards SET status = 'acted', selected_action = ?, acted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`),
        dismissBoard: db.prepare(`UPDATE relay_boards SET status = 'dismissed', selected_action = ?, acted_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`),
        deleteConvBoards: db.prepare(`DELETE FROM relay_boards WHERE conversation_id = ?`),
    };
}
