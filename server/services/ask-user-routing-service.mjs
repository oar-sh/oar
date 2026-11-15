'use strict';

function normalizeId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function loadRelayQuestionColumns(db) {
  try {
    const rows = db.prepare(`PRAGMA table_info(relay_questions)`).all();
    return new Set(rows.map((row) => String(row?.name || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function createAskUserRoutingService(db, options = {}) {
  const sessionWorkerRegistry = options?.sessionWorkerRegistry || null;
  const relayQuestionColumns = loadRelayQuestionColumns(db);
  const hasContinuationColumns =
    relayQuestionColumns.has('continuation_id')
    && relayQuestionColumns.has('continuation_question_id');
  const hasStructuredAnswerColumn = relayQuestionColumns.has('structured_answer');

  const findQuestion = db.prepare(`SELECT * FROM relay_questions WHERE id = ?`);
  const updateAnswered = db.prepare(`
    UPDATE relay_questions
    SET status = 'answered', answer = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `);
  const updateAnsweredStructured = hasStructuredAnswerColumn
    ? db.prepare(`
      UPDATE relay_questions
      SET status = 'answered', answer = ?, structured_answer = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `)
    : null;
  const findBySdkSessionAndMessage = db.prepare(`
    SELECT * FROM relay_questions
    WHERE sdk_session_id = ? AND message_id = ?
    LIMIT 1
  `);
  const findByContinuation = hasContinuationColumns
    ? db.prepare(`
      SELECT *
      FROM relay_questions
      WHERE continuation_id = ?
        AND continuation_question_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    : null;

  function routeAnswer({ question_id, sdk_session_id, answer, structured_answer, conversation_id, continuation_id, continuation_question_id }) {
    const row = findQuestion.get(question_id);
    if (!row) return { ok: false, error: 'Question not found' };

    const rowSession = normalizeId(row.sdk_session_id);
    const incomingSession = normalizeId(sdk_session_id);
    const rowConversation = normalizeId(row.conversation_id);
    const incomingConversation = normalizeId(conversation_id);
    const rowContinuationId = normalizeId(row.continuation_id);
    const incomingContinuationId = normalizeId(continuation_id);
    const rowContinuationQuestionId = normalizeId(row.continuation_question_id);
    const incomingContinuationQuestionId = normalizeId(continuation_question_id);
    const ownerWorkerId = normalizeId(row.owner_worker_id);
    const workerOwnerSessionId = ownerWorkerId
      ? normalizeId(sessionWorkerRegistry?.getWorkerByWorkerId?.(ownerWorkerId)?.sdkSessionId)
      : null;

    if (rowContinuationId && incomingContinuationId && rowContinuationId !== incomingContinuationId) {
      return { ok: false, error: 'continuation mismatch' };
    }
    if (rowContinuationQuestionId && incomingContinuationQuestionId && rowContinuationQuestionId !== incomingContinuationQuestionId) {
      return { ok: false, error: 'continuation question mismatch' };
    }
    if (rowConversation && incomingConversation && rowConversation !== incomingConversation) {
      return { ok: false, error: 'conversation mismatch' };
    }
    if (rowSession && workerOwnerSessionId && rowSession !== workerOwnerSessionId) {
      return { ok: false, error: 'owner mismatch' };
    }

    const expectedSession = rowSession || workerOwnerSessionId;
    if (expectedSession || incomingSession) {
      if (!expectedSession || !incomingSession || expectedSession !== incomingSession) {
        return { ok: false, error: 'session mismatch' };
      }
    }

    if (structured_answer && updateAnsweredStructured) {
      updateAnsweredStructured.run(answer, structured_answer, question_id);
    } else {
      updateAnswered.run(answer, question_id);
    }
    return { ok: true };
  }

  function lookupQuestion({ sdk_session_id, message_id, continuation_id, continuation_question_id }) {
    const continuationId = normalizeId(continuation_id);
    const continuationQuestionId = normalizeId(continuation_question_id);
    if (hasContinuationColumns && continuationId && continuationQuestionId) {
      const continuationMatch = findByContinuation?.get(continuationId, continuationQuestionId) || null;
      if (continuationMatch) return continuationMatch;
    }

    const sessionId = normalizeId(sdk_session_id);
    const messageId = normalizeId(message_id);
    if (!sessionId || !messageId) return null;
    return findBySdkSessionAndMessage.get(sessionId, messageId) || null;
  }

  return { routeAnswer, lookupQuestion };
}
