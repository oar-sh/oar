import {
  DEFAULT_QUESTION_TIMEOUT_MS,
  QUESTION_TIMEOUT_CONTINUATION_TEXT,
} from './question-timeout.mjs';

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
  async function waitForRelayQuestionAnswer(questionId, { signal } = {}) {
    const started = Date.now();
    while (true) {
      if (signal?.aborted) {
        await api('POST', `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, timedOut: true, aborted: true };
      }
      const { question } = await api('GET', `/api/relay-question/${questionId}`);
      if (!question) throw new Error('Relay question missing');
      if (question.status === 'answered') {
        return { answer: String(question.answer || '').trim(), timedOut: false };
      }
      if (question.status === 'timed_out' || question.status === 'cancelled') {
        return { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, timedOut: true };
      }
      if (Date.now() - started >= questionTimeoutMs) {
        await api('POST', `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
        return { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, timedOut: true };
      }
      await sleep(questionPollMs);
    }
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
      sdk_session_id: sdkSessionId || undefined,
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
    const created = await api('POST', '/api/relay-question', questionPayload);
    const questionId = created?.question?.id;
    if (!questionId) throw new Error('Relay question could not be created');
    dbg('relay question created', questionId, 'prompt=', entry.question.slice(0, 80));
    return waitForRelayQuestionAnswer(questionId, { signal });
  }

  async function handleAskUserQuestion(input, { signal } = {}) {
    const questions = normalizeQuestions(input);
    if (!questions.length) {
      return { answers: {}, timedOut: false };
    }
    const answers = {};
    let timedOut = false;
    for (const entry of questions) {
      const result = await askSingleQuestion(entry, { signal });
      answers[entry.question] = result.answer;
      if (entry.rawQuestion && entry.rawQuestion !== entry.question) {
        answers[entry.rawQuestion] = result.answer;
      }
      if (result.timedOut) timedOut = true;
      if (result.aborted) break;
    }
    return { answers, timedOut };
  }

  return {
    handleAskUserQuestion,
    waitForRelayQuestionAnswer,
  };
}
