import { DEFAULT_QUESTION_TIMEOUT_MS } from './question-timeout.mjs';
import { createRelayQuestion, waitForRelayQuestion } from './question-wait.mjs';

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeQuestions(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return questions
    .map((entry) => ({
      question: String(entry?.question || '').trim(),
      // The SDK joins answers back by EXACT question text; a model question
      // with stray whitespace must still match its answer key.
      rawQuestion: String(entry?.question || ''),
      header: String(entry?.header || '').trim(),
      multiSelect: entry?.multiSelect === true,
      // Structured-elicitation parity: a schema object rides through to the
      // create payload untouched (the server normalizes and validates it).
      requestedSchema: entry?.requestedSchema && typeof entry.requestedSchema === 'object'
        && !Array.isArray(entry.requestedSchema)
        ? entry.requestedSchema
        : null,
      options: (Array.isArray(entry?.options) ? entry.options : [])
        .map((option) => ({
          label: String(option?.label || '').trim(),
          description: String(option?.description || '').trim(),
        }))
        .filter((option) => option.label),
    }))
    .filter((entry) => entry.question);
}

/**
 * Bridge a provider worker's ask-user tool onto the relay question cards.
 *
 * `handleAskUserQuestion(input, { signal })` posts one relay question per
 * question entry, waits for the answers, and returns the collected `answers`
 * map (question text -> answer string). Provider workers identify themselves
 * via `questionSource` / `questionRationale` (defaults preserve the Claude
 * worker's original wire payload).
 */
export function createAskUserBridge({
  api,
  getActiveMessage,
  sdkSessionId = '',
  sleep = sleepDefault,
  questionPollMs = 1500,
  questionTimeoutMs = DEFAULT_QUESTION_TIMEOUT_MS,
  questionSource = 'AskUserQuestion',
  questionRationale = 'Claude requested clarification to continue this turn.',
  dbg = () => {},
} = {}) {
  // `timeoutMs` overrides the bridge-wide default for one wait (a structured
  // elicitation may carry its own deadline). Additive: existing callers pass
  // only `signal` and behave exactly as before.
  // The wait survives a relay that is briefly not there (question-wait.mjs).
  function waitForRelayQuestionAnswer(questionId, { signal, timeoutMs } = {}) {
    return waitForRelayQuestion({
      api,
      questionId,
      deadlineMs: timeoutMs ?? questionTimeoutMs,
      pollMs: questionPollMs,
      sleep,
      signal,
      dbg,
    });
  }

  async function askSingleQuestion(entry, { signal } = {}) {
    const activeMsg = typeof getActiveMessage === 'function' ? getActiveMessage() : null;
    const choices = entry.options.map((option) => option.label);
    const promptParts = [entry.question];
    const optionDetails = entry.options
      .filter((option) => option.description)
      .map((option) => `- ${option.label}: ${option.description}`);
    if (optionDetails.length) promptParts.push(optionDetails.join('\n'));
    const questionPayload = {
      queueId: activeMsg?.id,
      messageId: activeMsg?.id,
      conversationId: activeMsg?.conversationId,
      mode: activeMsg?.relayMode || 'agent',
      prompt: promptParts.join('\n\n'),
      choices,
      allowFreeform: true,
      // Top-level, as the create route reads it (elicitation parity; absent
      // for the flat question shape every existing caller sends).
      ...(entry.requestedSchema ? { requestedSchema: entry.requestedSchema } : {}),
      sdk_session_id: sdkSessionId || undefined,
      // Fences the card to the delivering attempt: the server refuses creation
      // once the row has been requeued to a newer attempt.
      attemptId: activeMsg?.attemptId || undefined,
      timeout_ms: questionTimeoutMs,
      context: {
        source: questionSource,
        rationale: questionRationale,
        queueMessageId: activeMsg?.id || null,
        conversationId: activeMsg?.conversationId || null,
        relayMode: activeMsg?.relayMode || 'agent',
        header: entry.header || undefined,
        multiSelect: entry.multiSelect || undefined,
      },
    };
    const questionId = await createRelayQuestion({ api, payload: questionPayload, sleep, signal, dbg });
    dbg('relay question created', questionId, 'prompt=', entry.question.slice(0, 80));
    return waitForRelayQuestionAnswer(questionId, { signal });
  }

  async function handleAskUserQuestion(input, { signal } = {}) {
    const questions = normalizeQuestions(input);
    if (!questions.length) {
      return { answers: {}, structuredAnswers: {}, timedOut: false };
    }
    const answers = {};
    // Validated structured submissions, keyed like `answers`, present only for
    // questions that carried a `requestedSchema`. Flat consumers keep reading
    // `answers` unchanged.
    const structuredAnswers = {};
    let timedOut = false;
    for (const entry of questions) {
      const result = await askSingleQuestion(entry, { signal });
      answers[entry.question] = result.answer;
      if (result.structuredAnswer) structuredAnswers[entry.question] = result.structuredAnswer;
      if (entry.rawQuestion && entry.rawQuestion !== entry.question) {
        answers[entry.rawQuestion] = result.answer;
        if (result.structuredAnswer) structuredAnswers[entry.rawQuestion] = result.structuredAnswer;
      }
      if (result.timedOut) timedOut = true;
      if (result.aborted) break;
    }
    return { answers, structuredAnswers, timedOut };
  }

  return {
    handleAskUserQuestion,
    waitForRelayQuestionAnswer,
  };
}
