import test from 'node:test';
import assert from 'node:assert/strict';

import { createRelayQuestion, waitForRelayQuestion } from './question-wait.mjs';
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from './question-timeout.mjs';

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function refused() {
  return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}

/** An api whose question poll answers from a script: an Error is thrown, anything else returned. */
function scriptedApi(polls, { create = [] } = {}) {
  const calls = [];
  const api = async (method, routePath, body) => {
    calls.push({ method, routePath, body });
    if (method === 'GET') {
      const next = polls.length > 1 ? polls.shift() : polls[0];
      if (next instanceof Error) throw next;
      return { question: next };
    }
    if (routePath === '/api/relay-question') {
      const next = create.length > 1 ? create.shift() : create[0];
      if (next instanceof Error) throw next;
      return next;
    }
    return { ok: true };
  };
  api.calls = calls;
  return api;
}

const noSleep = async () => {};

test('a relay that restarts while the card is open does not answer the question', async () => {
  // One failed poll used to end the wait, and the callers turn that into
  // "continue with your best judgement" while the card is still on screen.
  const api = scriptedApi([
    { status: 'pending' },
    refused(),
    new TypeError('fetch failed'),
    httpError(502),
    { status: 'pending' },
    { status: 'answered', answer: ' staging ' },
  ]);
  const lines = [];
  const result = await waitForRelayQuestion({
    api, questionId: 'card-1', deadlineMs: 60_000, sleep: noSleep, dbg: (...parts) => lines.push(parts.join(' ')),
  });
  assert.deepEqual(result, { answer: 'staging', structuredAnswer: null, timedOut: false });
  assert.equal(api.calls.filter((call) => call.method === 'POST').length, 0, 'the card was never expired');
  // Said once when the outage begins and once when it ends, not per poll.
  assert.equal(lines.length, 2);
  assert.match(lines[0], /the card stays open/);
  assert.match(lines[1], /after 3 failed poll\(s\)/);
});

test('polls are spaced further apart while the relay does not answer', async () => {
  const waits = [];
  const api = scriptedApi([refused(), refused(), refused(), refused(), { status: 'answered', answer: 'yes' }]);
  await waitForRelayQuestion({
    api, questionId: 'card-1', deadlineMs: 600_000, pollMs: 1500, sleep: async (ms) => { waits.push(ms); },
  });
  assert.deepEqual(waits, [3000, 6000, 10_000, 10_000]);
});

test('the relay\'s own refusal still ends the wait', async () => {
  await assert.rejects(
    waitForRelayQuestion({ api: scriptedApi([httpError(404)]), questionId: 'card-1', deadlineMs: 1000, sleep: noSleep }),
    /HTTP 404/,
  );
  await assert.rejects(
    waitForRelayQuestion({ api: scriptedApi([httpError(401)]), questionId: 'card-1', deadlineMs: 1000, sleep: noSleep }),
    /HTTP 401/,
  );
  await assert.rejects(
    waitForRelayQuestion({ api: scriptedApi([null]), questionId: 'card-1', deadlineMs: 1000, sleep: noSleep }),
    /Relay question missing/,
  );
});

test('an outage that outlasts the deadline ends as a timeout', async () => {
  let at = 0;
  const api = scriptedApi([refused()]);
  const result = await waitForRelayQuestion({
    api, questionId: 'card-1', deadlineMs: 5000, sleep: async (ms) => { at += ms; }, now: () => at,
  });
  assert.deepEqual(result, { answer: QUESTION_TIMEOUT_CONTINUATION_TEXT, structuredAnswer: null, timedOut: true });
  assert.equal(api.calls.at(-1).routePath, '/api/relay-question/card-1/timeout');
});

test('an abort ends the wait during an outage too', async () => {
  const controller = new AbortController();
  const api = scriptedApi([refused()]);
  const result = await waitForRelayQuestion({
    api,
    questionId: 'card-1',
    deadlineMs: 600_000,
    signal: controller.signal,
    sleep: async () => { controller.abort(); },
  });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, true);
});

test('a structured answer and an untrimmed answer come through', async () => {
  const api = scriptedApi([{ status: 'answered', answer: ' two words ', structuredAnswer: { env: 'staging' } }]);
  const result = await waitForRelayQuestion({ api, questionId: 'card-1', deadlineMs: 1000, sleep: noSleep, trimAnswer: false });
  assert.deepEqual(result, { answer: ' two words ', structuredAnswer: { env: 'staging' }, timedOut: false });
});

test('a card is created once the relay accepts connections again', async () => {
  const api = scriptedApi([], { create: [refused(), refused(), { question: { id: 'card-7' } }] });
  const waits = [];
  const id = await createRelayQuestion({ api, payload: { prompt: 'which one?' }, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(id, 'card-7');
  assert.deepEqual(waits, [500, 1000]);
});

test('a create that may have reached the relay is not sent twice', async () => {
  // A reset connection or a 502 says nothing about whether the card exists.
  for (const failure of [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), httpError(502)]) {
    const api = scriptedApi([], { create: [failure, { question: { id: 'card-7' } }] });
    await assert.rejects(createRelayQuestion({ api, payload: {}, sleep: noSleep }));
    assert.equal(api.calls.length, 1);
  }
});

test('a relay that stays away fails the create after its retries', async () => {
  const api = scriptedApi([], { create: [refused()] });
  await assert.rejects(createRelayQuestion({ api, payload: {}, sleep: noSleep, retryDelaysMs: [1, 1] }), /fetch failed/);
  assert.equal(api.calls.length, 3);
});
