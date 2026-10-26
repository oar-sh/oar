'use strict';

import { createAskUserRoutingService } from '../services/ask-user-routing-service.mjs';
import { admitRemoteRelayRequest, readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { REMOTE_RELAY_ERROR_CODES, isRemoteRelayApprovalQuestion } from '../../shared/remote-relay-contract.mjs';
import { isRelayAskId, relayQuestionKind } from '../../shared/relay-asks.mjs';
import { sendRelayAskError } from './relay-ask-routes.mjs';
import { closedQuestionAnswer, questionAcceptsFreeText } from '../../shared/question-answer-rule.mjs';
import {
  extractRequestedSchema,
  normalizeSchema,
  schemaFields,
  validateStructuredAnswer,
  summarizeStructuredAnswer,
  flatAnswerToStructured,
} from '../../shared/question-schema.mjs';

function normalizeId(value) {
  const text = String(value || '').trim();
  return text || null;
}

function resolveNestedValue(source, keyPath) {
  let current = source;
  for (const key of keyPath) {
    if (!current || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

function firstKnownValue(source, keyPaths = []) {
  for (const keyPath of keyPaths) {
    const value = resolveNestedValue(source, keyPath);
    const normalized = normalizeId(value);
    if (normalized) return normalized;
  }
  return null;
}

function parseRowJson(value) {
  try {
    return JSON.parse(String(value || ''));
  } catch {
    return null;
  }
}

/**
 * A stored question row that is this relay's Allow / Deny card for one of its
 * own agent's calls to another relay (remote-relay-caller-context.mjs). The
 * context lives in the row's request envelope.
 */
function isRemoteRelayApprovalRow(row) {
  const envelope = parseRowJson(row?.request);
  return envelope ? isRemoteRelayApprovalQuestion(envelope) : false;
}

/**
 * The choices of a stored card that takes no typed text (approval and
 * permission cards, and a card with choices that stored no flag, as the
 * runtime's formatQuestionRow reads it for the card view), or null for a
 * card that takes any reply.
 */
function closedQuestionOfRow(row) {
  const envelope = parseRowJson(row?.request);
  const parsedChoices = parseRowJson(row?.choices);
  const choices = Array.isArray(parsedChoices) ? parsedChoices.map((choice) => String(choice ?? '')) : [];
  const allowFreeform = envelope && typeof envelope === 'object' && typeof envelope.allowFreeform === 'boolean'
    ? envelope.allowFreeform
    : null;
  if (questionAcceptsFreeText({ allowFreeform, choices })) return null;
  return { choices, multiSelect: envelope?.context?.multiSelect === true };
}

function extractContinuationOwnership(rawRequest) {
  const parsed = rawRequest && typeof rawRequest === 'object' ? rawRequest : null;
  if (!parsed) {
    return {
      continuationId: null,
      continuationQuestionId: null,
    };
  }

  return {
    continuationId: firstKnownValue(parsed, [
      ['continuationId'],
      ['continuation_id'],
      ['continuation', 'id'],
      ['toolArgs', 'continuationId'],
      ['toolArgs', 'continuation_id'],
      ['toolArgs', 'continuation', 'id'],
      ['input', 'continuationId'],
      ['input', 'continuation_id'],
      ['input', 'continuation', 'id'],
      ['request', 'continuationId'],
      ['request', 'continuation_id'],
      ['request', 'continuation', 'id'],
      ['arguments', 'continuationId'],
      ['arguments', 'continuation_id'],
      ['arguments', 'continuation', 'id'],
    ]),
    continuationQuestionId: firstKnownValue(parsed, [
      ['questionId'],
      ['question_id'],
      ['askUserQuestionId'],
      ['ask_user_question_id'],
      ['continuation', 'questionId'],
      ['continuation', 'question_id'],
      ['toolArgs', 'questionId'],
      ['toolArgs', 'question_id'],
      ['input', 'questionId'],
      ['input', 'question_id'],
      ['request', 'questionId'],
      ['request', 'question_id'],
      ['arguments', 'questionId'],
      ['arguments', 'question_id'],
    ]),
  };
}

export function registerAskUserRoutes(app, deps) {
  const {
    auth,
    io,
    db,
    stmts,
    runtimeState,
    uuidv4,
    ts,
    questionExpiresAt,
    sanitizeRelayQuestionPrompt,
    sanitizeRelayQuestionRequest,
    sanitizeRelayQuestionContext,
    parseQuestionRequest,
    normalizeQuestionChoices,
    formatQuestionRow,
    normalizeRelayMode,
    DEFAULT_RELAY_MODE,
    sessionWorkerRegistry,
    pushDispatchService,
    // Relay event subscriptions: a question is an event for its watchers.
    relayEventService = null,
    // Remote relays: another relay's agent answering a question is refused
    // while the inbound switch is off. Absent in older wiring (no-op).
    remoteRelayInbound = null,
    // Questions that don't block (relay-ask-service.mjs): their ids answer
    // here like a card's. Absent in older wiring (no asks).
    relayAskService = null,
  } = deps;

  const continuationRoutingEnabled = runtimeState?.featureFlags?.SESSION_WORKER_CONTINUATION_ROUTING_ENABLED === true;
  const workerRoutingEnabled = runtimeState?.featureFlags?.SESSION_WORKER_ROUTING_ENABLED === true;
  const askUserRoutingService = createAskUserRoutingService(db, {
    continuationRoutingEnabled,
    sessionWorkerRegistry,
  });

  // A request from another relay's agent, by the test the inbound switch
  // applies (X-OAR-Remote-Origin or a body origin). Made even without the
  // remote-relay deps: an approval card is only ever this relay's user's.
  function fromRemoteRelay(req) {
    return readRemoteRelayRequest(req, remoteRelayInbound || {}).remote;
  }

  app.get('/api/relay-questions', auth, (req, res) => {
    const conversationId = req.query.conversationId ? String(req.query.conversationId) : null;
    const status = String(req.query.status || 'pending').trim() || 'pending';
    let rows = stmts.listQuestions.all(status, conversationId, conversationId);
    if (fromRemoteRelay(req)) rows = rows.filter((row) => !isRemoteRelayApprovalRow(row));
    const questions = rows.map(formatQuestionRow).map((question) => ({ ...question, kind: relayQuestionKind(question) }));
    // Questions that don't block, on request (read_session's pendingQuestions):
    // the cards' own readers take only what a turn waits on.
    if (String(req.query.includeAsks || '') === '1' && relayAskService?.isAvailable?.() && status === 'pending') {
      const asks = conversationId ? relayAskService.listOf(conversationId) : relayAskService.listHere();
      questions.push(...asks.filter((ask) => !ask.relayId && ask.status === 'pending' && (!conversationId || ask.conversationId === conversationId)));
    }
    res.json({ questions });
  });

  app.get('/api/relay-question/:id', auth, (req, res) => {
    if (isRelayAskId(req.params.id)) {
      const ask = relayAskService?.get?.(req.params.id) || null;
      return ask ? res.json({ question: ask }) : res.status(404).json({ error: 'Not found' });
    }
    const row = stmts.getQuestion.get(req.params.id);
    if (!row || (isRemoteRelayApprovalRow(row) && fromRemoteRelay(req))) {
      return res.status(404).json({ error: 'Not found' });
    }
    const question = formatQuestionRow(row);
    res.json({ question: { ...question, kind: relayQuestionKind(question) } });
  });

  /**
   * An ask (relay_tool `ask`) is the user's to answer: from this relay's
   * own UI here, from a paired relay's Inbox through its own route
   * (relay-ask-routes.mjs). Never from an agent, this relay's or another's.
   */
  function refuseAgentOnAsk(req, res) {
    if (!fromRemoteRelay(req)) return false;
    console.warn(`[${ts()}] QUESTION  reject id=${String(req.params.id || '').slice(0, 12)} reason=ask-from-agent`);
    res.status(403).json({
      error: 'This question was asked with ask: only the user answers it, in the Inbox or the session.',
      code: REMOTE_RELAY_ERROR_CODES.forbidden,
    });
    return true;
  }

  function answerAsk(req, res, dismiss) {
    if (refuseAgentOnAsk(req, res)) return;
    if (!relayAskService?.isAvailable?.()) return res.status(503).json({ error: 'Questions that don\'t block are not available on this relay right now' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    try {
      const ask = dismiss
        ? relayAskService.dismiss(req.params.id)
        : relayAskService.answer(req.params.id, { answer: String(body.answer ?? ''), choice: String(body.choice ?? '') });
      console.log(`[${ts()}] QUESTION  ${String(ask.id).slice(0, 12)} ${dismiss ? 'dismissed' : 'answered'} (ask)`);
      res.json({ ok: true, question: ask });
    } catch (error) {
      sendRelayAskError(res, error, dismiss ? 'The dismissal' : 'The answer');
    }
  }

  // POST /api/relay-question/:id/dismiss — an ask closed without an answer.
  app.post('/api/relay-question/:id/dismiss', auth, (req, res) => {
    if (!isRelayAskId(req.params.id)) return res.status(400).json({ error: 'Only a question asked with ask can be dismissed; a card waits for its answer.' });
    answerAsk(req, res, true);
  });

  app.post('/api/relay-question', auth, (req, res) => {
    const { queueId, messageId, conversationId, mode, prompt, choices, request, context, allowFreeform, requestedSchema } = req.body;
    console.log(`[${ts()}] relay-question POST: ${choices?.length ?? 0} possible answer(s)`);
    const q = stmts.findQById.get(queueId || messageId);
    if (!q || q.status !== 'processing') {
      return res.status(409).json({ error: 'No active relay turn' });
    }
    // Attempt fencing: a caller that names its processing attempt may only
    // open a card while that attempt still owns the row. The stored value is
    // always the row's own attempt_id (server-authoritative), so stale-attempt
    // cleanup covers questions from unfenced callers too.
    const claimedAttemptId = String(req.body.attemptId || '').trim() || null;
    if (claimedAttemptId && String(q.attempt_id || '') !== claimedAttemptId) {
      console.warn(`[${ts()}] STALE ATTEMPT ${String(q.id).slice(0,8)} route=relay-question claimed=${claimedAttemptId.slice(0,8)} current=${String(q.attempt_id || '').slice(0,8) || 'none'}`);
      return res.status(409).json({ error: 'stale_attempt' });
    }

    const effectiveMessageId = messageId || q.id;
    
    // Check for an identical pending question (same prompt + choices) to handle retries.
    // Do NOT reuse questions with different prompts/choices - this allows multiple
    // concurrent ask_user calls in the same turn to each create their own question.
    const promptText = sanitizeRelayQuestionPrompt({ prompt });
    const normalizedChoices = normalizeQuestionChoices(choices);
    const choicesJson = normalizedChoices.length ? JSON.stringify(normalizedChoices) : null;
    
    const existingPending = stmts.findPendingQuestionByMessage.get(effectiveMessageId);
    if (existingPending) {
      const existingPrompt = String(existingPending.prompt || '');
      const existingChoices = existingPending.choices || null;
      const promptMatches = existingPrompt === promptText;
      const choicesMatch = existingChoices === choicesJson;
      
      if (promptMatches && choicesMatch) {
        // This is likely a retry of the same question - reuse it
        const question = formatQuestionRow(existingPending);
        return res.json({ question, reused: true });
      }
      // Different question - continue to create a new one
    }

    const relayMode = normalizeRelayMode(mode || q.relay_mode) || DEFAULT_RELAY_MODE;
    const now = new Date().toISOString();
    const questionId = uuidv4();
    const requestedSessionId = normalizeId(req.body.sdk_session_id);
    const queueOwnerSessionId = workerRoutingEnabled || continuationRoutingEnabled
      ? normalizeId(q.owner_sdk_session_id)
      : null;
    const sdkSessionId = requestedSessionId || queueOwnerSessionId || null;
    const ownerWorkerId = sdkSessionId
      ? normalizeId(sessionWorkerRegistry?.getWorker?.(sdkSessionId)?.workerId)
      : null;
    const parsedQuestionRequest = parseQuestionRequest(request);
    const requestJson = sanitizeRelayQuestionRequest({
      request: parsedQuestionRequest,
      context: sanitizeRelayQuestionContext(context),
      allowFreeform: typeof allowFreeform === 'boolean' ? allowFreeform : (!normalizedChoices.length),
    });
    // Capture the elicitation requestedSchema (explicit field or nested in the request)
    // so multi-field structured answers can be validated and rendered.
    const resolvedSchema = normalizeSchema(requestedSchema)
      || extractRequestedSchema(requestedSchema)
      || extractRequestedSchema(parsedQuestionRequest);
    const requestSchemaJson = resolvedSchema ? JSON.stringify(resolvedSchema) : null;
    const continuation = continuationRoutingEnabled
      ? extractContinuationOwnership(parsedQuestionRequest)
      : { continuationId: null, continuationQuestionId: null };
    // questionExpiresAt normalizes: absent/junk falls back to the 8h default,
    // explicit finite values (including 0) are honored.
    const expiresAt = questionExpiresAt(now, req.body.timeout_ms);

    stmts.insertQuestion.run(
      questionId,
      q.id,
      conversationId || q.conversation_id,
      effectiveMessageId,
      relayMode,
      promptText,
      choicesJson,
      requestJson,
      requestSchemaJson,
      sdkSessionId,
      ownerWorkerId,
      continuation.continuationId,
      continuation.continuationQuestionId,
      now,
      expiresAt,
      String(q.attempt_id || '').trim() || null,
    );

    const question = formatQuestionRow(stmts.getQuestion.get(questionId));
    const fieldCount = resolvedSchema ? schemaFields(resolvedSchema).length : 0;
    console.log(`[${ts()}] QUESTION  ${questionId.slice(0,8)} conv=${question.conversationId.slice(0,8)} mode=${relayMode} fields=${fieldCount} prompt="${promptText.slice(0,60)}"`);
    io.emit('relay_question', { question });
    void pushDispatchService?.notifyQuestion?.(question);
    try { relayEventService?.noteQuestion?.(question); } catch {}
    res.json({ question });
  });

  app.post('/api/relay-question/:id/answer', auth, (req, res) => {
    if (!admitRemoteRelayRequest(req, res, remoteRelayInbound)) return;
    if (isRelayAskId(req.params.id)) return answerAsk(req, res, false);
    const id = String(req.params.id || '').trim();
    const { answer, structuredAnswer, sdk_session_id, continuation_id, continuation_question_id } = req.body;
    const sdkSessionId = normalizeId(sdk_session_id);
    const continuationId = normalizeId(continuation_id);
    const continuationQuestionId = normalizeId(continuation_question_id);

    const row = stmts.getQuestion.get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Allow / Deny on this relay's own call to another relay is its user's
    // decision; the relay that call went to must never make it.
    if (isRemoteRelayApprovalRow(row) && fromRemoteRelay(req)) {
      console.warn(`[${ts()}] QUESTION  reject id=${id.slice(0, 8)} reason=remote-relay-approval-from-remote`);
      return res.status(403).json({ error: 'Only this relay\'s user can answer a remote relay approval' });
    }
    if (row.status !== 'pending') return res.status(409).json({ error: `Question already ${row.status}` });

    const schema = parseQuestionRequest(row.request_schema);
    const hasSchema = schema && typeof schema === 'object' && schemaFields(schema).length > 0;

    // Resolve a structured answer object when a schema is present. Accept either
    // an explicit `structuredAnswer` object or, for single-field schemas, the
    // flat `answer` string mapped onto the lone field (backward compatibility).
    let structured = null;
    let flatText = String(answer || '').trim();

    if (hasSchema) {
      let candidate = null;
      if (structuredAnswer && typeof structuredAnswer === 'object' && !Array.isArray(structuredAnswer)) {
        candidate = structuredAnswer;
      } else if (flatText) {
        candidate = flatAnswerToStructured(schema, flatText);
      }
      if (!candidate) {
        return res.status(400).json({ error: 'Structured answer required', schema });
      }
      const validation = validateStructuredAnswer(schema, candidate);
      if (!validation.ok) {
        return res.status(400).json({ error: 'Invalid structured answer', fields: validation.errors });
      }
      structured = validation.value;
      flatText = summarizeStructuredAnswer(schema, structured) || flatText;
    } else if (!flatText) {
      return res.status(400).json({ error: 'Empty answer' });
    } else {
      // A card that takes no typed text is answered by its choices only.
      // Anything else is refused and the card stays open: it must not pass
      // for an answer (an approval reader would take it for a denial).
      const closed = closedQuestionOfRow(row);
      if (closed) {
        const accepted = closedQuestionAnswer(closed, flatText);
        if (!accepted) {
          console.warn(`[${ts()}] QUESTION  reject id=${id.slice(0, 8)} reason=not-a-choice`);
          return res.status(400).json({ error: 'This question takes one of its choices, not typed text', choices: closed.choices });
        }
        flatText = accepted;
      }
    }

    const result = askUserRoutingService.routeAnswer({
      question_id: id,
      sdk_session_id: sdkSessionId,
      continuation_id: continuationId,
      continuation_question_id: continuationQuestionId,
      answer: flatText,
      structured_answer: structured ? JSON.stringify(structured) : null,
    });
    if (!result.ok) {
      console.warn(
        `[${ts()}] QUESTION  reject id=${id.slice(0, 8)} reason=${String(result.error || 'unknown').slice(0, 64)} sid=${String(sdkSessionId || 'none').slice(0, 8)}`,
      );
      if (result.error === 'session mismatch' || result.error === 'owner mismatch') {
        const targetSessionId = String(row.sdk_session_id || '').trim() || null;
        return res.status(403).json({ error: result.error, expectedSessionId: targetSessionId });
      }
      return res.status(400).json({ error: result.error });
    }

    const question = formatQuestionRow(stmts.getQuestion.get(id));
    console.log(`[${ts()}] QUESTION  ${id.slice(0,8)} answered ${structured ? `fields=${Object.keys(structured).length}` : `len=${flatText.length}`}`);
    io.emit('relay_question_updated', { question });
    res.json({ ok: true, question });
  });

  app.post('/api/relay-question/:id/timeout', auth, (req, res) => {
    const row = stmts.getQuestion.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (isRemoteRelayApprovalRow(row) && fromRemoteRelay(req)) {
      return res.status(403).json({ error: 'Only this relay\'s user can answer a remote relay approval' });
    }
    if (row.status !== 'pending') return res.json({ ok: true, question: formatQuestionRow(row) });

    const result = stmts.timeoutQuestion.run(row.id);
    if (result.changes > 0) {
      const question = formatQuestionRow(stmts.getQuestion.get(row.id));
      console.log(`[${ts()}] QUESTION  ${row.id.slice(0,8)} timed out`);
      io.emit('relay_question_updated', { question });
      return res.json({ ok: true, question });
    }

    return res.json({ ok: true, question: formatQuestionRow(stmts.getQuestion.get(row.id)) });
  });
}
