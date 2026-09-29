// Waiting for the answer to a question card, and creating the card, through
// a relay that is briefly not there.
//
// A card may be open for hours and is polled every 1.5 s. One poll that failed
// — the relay restarting, a reset connection, a 502 from a proxy in front of
// it — used to end the wait with an error, and the callers turn an error into
// an answer: "continue with your best judgement" for a question, a rejection
// for an approval. The card itself stayed open, so the user later answered a
// question nobody was waiting on any more. The relay keeps its cards across a
// restart; the wait only has to outlast it.

import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from './question-timeout.mjs';
import { isRelayUnreachableError, isTransientRelayError } from './worker-runtime/relay-errors.mjs';

const DEFAULT_POLL_MS = 1500;
/** The spacing between polls grows to this while the relay does not answer. */
const MAX_OUTAGE_POLL_MS = 10_000;
/** Attempts to create a card while the relay refuses connections (~16 s). */
const DEFAULT_CREATE_RETRY_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000, 8_000]);

function sleepDefault(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a question card. Retried only while the relay refuses the
 * connection: any other failure may have created the card, and a second
 * request would put a second one in front of the user.
 */
export async function createRelayQuestion({
  api, payload, sleep = sleepDefault, retryDelaysMs = DEFAULT_CREATE_RETRY_DELAYS_MS, signal = null, dbg = () => {},
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const created = await api('POST', '/api/relay-question', payload);
      const questionId = created?.question?.id;
      if (!questionId) throw new Error('Relay question could not be created');
      return questionId;
    } catch (error) {
      if (!isRelayUnreachableError(error) || attempt >= retryDelaysMs.length || signal?.aborted) throw error;
      dbg('relay unreachable while creating a question; trying again', error?.message || String(error));
      await sleep(retryDelaysMs[attempt]);
    }
  }
}

/**
 * Poll a card until it is answered, times out, is cancelled, or `signal`
 * aborts the wait. Resolves `{ answer, structuredAnswer, timedOut, aborted? }`.
 * Rejects only on the relay's own refusal (a 4xx, a card that does not exist).
 */
export async function waitForRelayQuestion({
  api,
  questionId,
  deadlineMs,
  pollMs = DEFAULT_POLL_MS,
  sleep = sleepDefault,
  signal = null,
  trimAnswer = true,
  now = Date.now,
  dbg = () => {},
} = {}) {
  const started = now();
  const expired = { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, structuredAnswer: null, timedOut: true };
  let failedPolls = 0;
  while (true) {
    if (signal?.aborted) {
      await api('POST', `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
      return { ...expired, aborted: true };
    }
    let question = null;
    let outage = null;
    try {
      ({ question } = await api('GET', `/api/relay-question/${questionId}`));
      if (!question) throw Object.assign(new Error('Relay question missing'), { status: 404 });
    } catch (error) {
      if (!isTransientRelayError(error)) throw error;
      outage = error;
    }
    if (outage) {
      failedPolls += 1;
      if (failedPolls === 1) dbg('relay did not answer the question poll; the card stays open', questionId, outage?.message || String(outage));
    } else {
      if (failedPolls) dbg('relay answers the question poll again', questionId, `after ${failedPolls} failed poll(s)`);
      failedPolls = 0;
      if (question.status === 'answered') {
        const answer = String(question.answer || '');
        return {
          answer: trimAnswer ? answer.trim() : answer,
          // The validated structured submission, when the card carried a
          // `requestedSchema` and the relay stored one. Null otherwise — flat
          // consumers read `answer` and never see a shape change.
          structuredAnswer: question.structuredAnswer && typeof question.structuredAnswer === 'object'
            && !Array.isArray(question.structuredAnswer)
            ? question.structuredAnswer
            : null,
          timedOut: false,
        };
      }
      if (question.status === 'timed_out' || question.status === 'cancelled') return { ...expired };
    }
    if (now() - started >= deadlineMs) {
      await api('POST', `/api/relay-question/${questionId}/timeout`, {}).catch(() => {});
      return { ...expired };
    }
    await sleep(failedPolls ? Math.min(MAX_OUTAGE_POLL_MS, pollMs * 2 ** Math.min(failedPolls, 6)) : pollMs);
  }
}
