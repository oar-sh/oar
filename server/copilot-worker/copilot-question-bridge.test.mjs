import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCopilotQuestionBridge,
  deriveWasFreeform,
  normalizeUserInputChoices,
} from './copilot-question-bridge.mjs';
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from '../../shared/question-timeout.mjs';

const ACTIVE_MESSAGE = { id: 'q-1', conversationId: 'conv-1', relayMode: 'ask' };

/**
 * A relay stand-in. `answerWith` settles the question on the Nth poll, so a
 * test can prove the bridge actually waited rather than returning early.
 */
function makeRelay({ answerWith = null, structuredAnswerWith = null, status = 'answered', neverSettles = false } = {}) {
  const calls = [];
  let timedOut = false;
  async function api(method, path, body) {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/api/relay-question') {
      return { question: { id: 'question-1' } };
    }
    if (method === 'POST' && path.endsWith('/timeout')) {
      timedOut = true;
      return { ok: true };
    }
    if (method === 'GET' && path.startsWith('/api/relay-question/')) {
      // Faithful to the relay: once a card is timed out, every later poll sees
      // it, which is how a cancelled waiter unblocks.
      if (timedOut) return { question: { id: 'question-1', status: 'timed_out' } };
      if (neverSettles) return { question: { id: 'question-1', status: 'pending' } };
      return {
        question: {
          id: 'question-1',
          status,
          answer: answerWith,
          // What formatQuestionRow serves for an answered schema card.
          ...(structuredAnswerWith ? { structuredAnswer: structuredAnswerWith } : {}),
        },
      };
    }
    return {};
  }
  api.calls = calls;
  api.created = () => calls.find((c) => c.path === '/api/relay-question')?.body || null;
  api.timeouts = () => calls.filter((c) => c.path.endsWith('/timeout'));
  return api;
}

function makeBridge(api, overrides = {}) {
  return createCopilotQuestionBridge({
    api,
    sdkSessionId: 'conv-1',
    getActiveMessage: () => ACTIVE_MESSAGE,
    questionPollMs: 1,
    sleep: () => Promise.resolve(),
    ...overrides,
  });
}

test('a null choices list means free text, not a card nobody can answer', () => {
  // `choices` is documented as nullable; turning null into [] alongside
  // allowFreeform:false would render an unanswerable card.
  assert.deepEqual(normalizeUserInputChoices(null), []);
  assert.deepEqual(normalizeUserInputChoices(['a', ' b ', '', null]), ['a', 'b']);
  assert.deepEqual(normalizeUserInputChoices([{ label: 'x' }, { value: 'y' }]), ['x', 'y']);
});

test('wasFreeform is derived, because the wire path is identical either way', () => {
  // The UI posts the chosen label as `answer`, so "picked" and "typed" are
  // indistinguishable on the wire and must be inferred.
  assert.equal(deriveWasFreeform('prod', ['prod', 'staging']), false);
  assert.equal(deriveWasFreeform('something else', ['prod', 'staging']), true);
  assert.equal(deriveWasFreeform('anything', []), true);
  assert.equal(deriveWasFreeform(QUESTION_TIMEOUT_CONTINUATION_TEXT, ['prod']), true);
});

test('ask_user creates a card carrying the question, its choices and the queue row', async () => {
  const api = makeRelay({ answerWith: 'staging' });
  const bridge = makeBridge(api);

  const result = await bridge.askUserInput({
    requestId: 'r1',
    question: 'which environment?',
    choices: ['prod', 'staging'],
    allowFreeform: false,
  });

  assert.deepEqual(result, { answer: 'staging', wasFreeform: false, timedOut: false });
  const created = api.created();
  assert.equal(created.prompt, 'which environment?');
  assert.deepEqual(created.choices, ['prod', 'staging']);
  assert.equal(created.allowFreeform, false);
  // The relay 409s ("No active relay turn") unless the queue row is processing,
  // so the row ids have to ride along.
  assert.equal(created.queueId, 'q-1');
  assert.equal(created.messageId, 'q-1');
  assert.equal(created.conversationId, 'conv-1');
  assert.equal(created.sdk_session_id, 'conv-1');
  assert.equal(created.context.source, 'onUserInputRequest');
});

test('a "select all that apply" question is flagged multi-select for the card; an ordinary one is not', async () => {
  const api = makeRelay({ answerWith: 'staging, prod' });
  const bridge = makeBridge(api);
  const result = await bridge.askUserInput({
    requestId: 'r1',
    question: 'Which environments should I deploy to? Select all that apply.',
    choices: ['prod', 'staging', 'dev'],
  });
  assert.equal(api.created().context.multiSelect, true);
  // The joined labels come back as a freeform answer, which the runtime accepts.
  assert.deepEqual(result, { answer: 'staging, prod', wasFreeform: true, timedOut: false });

  const single = makeRelay({ answerWith: 'prod' });
  await makeBridge(single).askUserInput({ requestId: 'r2', question: 'Which environment?', choices: ['prod', 'staging'] });
  assert.equal('multiSelect' in single.created().context, false);
});

test('a question with no choices always allows free text', async () => {
  const api = makeRelay({ answerWith: 'Simon' });
  const bridge = makeBridge(api);

  const result = await bridge.askUserInput({ question: 'what is your name?', choices: null, allowFreeform: false });

  // allowFreeform:false alongside no choices would be unanswerable, so the
  // request's own flag is overridden rather than obeyed.
  assert.equal(api.created().allowFreeform, true);
  assert.equal(result.wasFreeform, true);
  assert.equal(result.answer, 'Simon');
});

test('an unanswered card returns the continuation text and says it timed out', async () => {
  const api = makeRelay({ status: 'timed_out' });
  const bridge = makeBridge(api);

  const result = await bridge.askUserInput({ question: 'still there?', choices: ['yes'] });

  assert.equal(result.answer, QUESTION_TIMEOUT_CONTINUATION_TEXT);
  assert.equal(result.timedOut, true);
  // Never reported as a chosen answer — the model must be able to tell.
  assert.equal(result.wasFreeform, true);
});

test('aborting the turn times the card out instead of leaving it pending', async () => {
  const api = makeRelay({ neverSettles: true });
  const bridge = makeBridge(api);
  const controller = new AbortController();
  controller.abort();

  const result = await bridge.askUserInput({ question: 'which one?' }, { signal: controller.signal });

  assert.equal(result.timedOut, true);
  assert.equal(api.timeouts().length, 1);
});

test('a tool approval offers approve/deny and reads a plain approval', async () => {
  const api = makeRelay({ answerWith: 'Approve' });
  const bridge = makeBridge(api);

  const result = await bridge.askToolApproval({ kind: 'shell', fullCommandText: 'rm -rf build' });

  assert.equal(result.approved, true);
  const created = api.created();
  assert.deepEqual(created.choices, ['Approve', 'Deny']);
  assert.equal(created.allowFreeform, true);
  // The prompt has to name what is about to run, or the card is unanswerable.
  assert.match(created.prompt, /shell: rm -rf build/);
  assert.equal(created.context.source, 'onPermissionRequest');
});

test('a freeform denial becomes the feedback the model sees', async () => {
  const api = makeRelay({ answerWith: 'no, that would delete the release artifacts' });
  const bridge = makeBridge(api);

  const result = await bridge.askToolApproval({ kind: 'shell', fullCommandText: 'rm -rf build' });

  assert.equal(result.approved, false);
  assert.equal(result.feedback, 'no, that would delete the release artifacts');
});

test('a plain Deny click does not echo the button label back as a reason', async () => {
  const api = makeRelay({ answerWith: 'Deny' });
  const bridge = makeBridge(api);

  const result = await bridge.askToolApproval({ kind: 'write', fileName: 'a.js' });

  assert.equal(result.approved, false);
  assert.equal(result.feedback, 'The user declined this action.');
});

test('shutdown settles the cards this worker is still waiting on', async () => {
  // A card left pending sits in the UI inviting an answer that nothing is left
  // to read; the relay's own sweeper would take up to its expiry to notice.
  const api = makeRelay({ neverSettles: true });
  // A real sleep here: the point is to catch the bridge mid-wait, which an
  // instantly-resolving sleep would spin straight past.
  const bridge = makeBridge(api, { questionPollMs: 20, sleep: undefined });

  const pending = bridge.askUserInput({ question: 'which one?' });
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal(bridge.pendingQuestionCount(), 1);

  assert.equal(await bridge.cancelPendingQuestions(), 1);
  assert.equal(api.timeouts().length, 1);
  assert.equal(bridge.pendingQuestionCount(), 0);

  // And the waiter unblocks, because the next poll sees the closed row — the
  // cancel must not leave the handler hanging forever either.
  const result = await pending;
  assert.equal(result.timedOut, true);
});

test('a question created while shutdown is in flight is expired at birth, never left pending', async () => {
  // `cancelPendingQuestions` snapshots the pending ids — but a create POST
  // still in flight resolves AFTER that snapshot, and its card used to be left
  // pending in the UI with nothing left to poll for its answer.
  let releaseCreate;
  const createGate = new Promise((resolve) => { releaseCreate = resolve; });
  const calls = [];
  async function api(method, path, body) {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/api/relay-question') return createGate;
    return { ok: true };
  }
  const bridge = makeBridge(api);

  const lateQuestionId = 'question-9';
  const pending = bridge.askUserInput({ question: 'which one?' });
  // Catch the create mid-flight, not before it started.
  await new Promise((resolve) => { setTimeout(resolve, 1); });
  const cancelled = bridge.cancelPendingQuestions();
  releaseCreate({ question: { id: lateQuestionId } });

  const result = await pending;
  // Shaped like a timeout, so the runner's handlers degrade exactly as they do
  // for an unanswered card.
  assert.equal(result.timedOut, true);
  assert.equal(result.answer, QUESTION_TIMEOUT_CONTINUATION_TEXT);
  // The late card was never pending: the shutdown awaited the create and the
  // create expired its own card the moment it saw the bridge closing.
  assert.equal(await cancelled, 0);
  assert.equal(bridge.pendingQuestionCount(), 0);
  const expiries = calls.filter((c) => c.path.endsWith('/timeout'));
  assert.equal(expiries.length, 1);
  assert.equal(expiries[0].path, `/api/relay-question/${lateQuestionId}/timeout`);
  // And nothing ever polled for an answer nobody is left to read.
  assert.equal(calls.filter((c) => c.method === 'GET').length, 0);

  // Once closing, no further card is minted at all.
  const late = await bridge.askUserInput({ question: 'still there?' });
  assert.equal(late.timedOut, true);
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/api/relay-question').length, 1);
});

test('a structured card round-trips the schema and returns the validated answer', async () => {
  // Audit #17: the elicitation path. The create payload carries a TOP-LEVEL
  // requestedSchema (that is the field the create route reads), and the
  // answered card comes back with the relay-validated structuredAnswer.
  const schema = {
    type: 'object',
    properties: { env: { type: 'string' }, replicas: { type: 'number' } },
    required: ['env'],
  };
  const api = makeRelay({ answerWith: 'submitted', structuredAnswerWith: { env: 'prod', replicas: 2 } });
  const bridge = makeBridge(api);

  const result = await bridge.askStructured({
    prompt: 'Deployment details?',
    requestedSchema: schema,
    timeoutMs: 30_000,
  });

  assert.deepEqual(result.structuredAnswer, { env: 'prod', replicas: 2 });
  assert.equal(result.timedOut, false);
  const created = api.created();
  assert.deepEqual(created.requestedSchema, schema);
  assert.equal(created.prompt, 'Deployment details?');
  // A schema card is free-text plus form; it offers no choice buttons.
  assert.deepEqual(created.choices, []);
  // The per-call deadline reaches the card's own expiry.
  assert.equal(created.timeout_ms, 30_000);
  assert.equal(created.context.source, 'onElicitationRequest');
  assert.equal(created.queueId, 'q-1');
});

test('an answered schema card without a validated structured body yields null, not a forgery', async () => {
  const api = makeRelay({ answerWith: 'freeform words instead of the form' });
  const bridge = makeBridge(api);
  const result = await bridge.askStructured({
    prompt: 'Details?',
    requestedSchema: { type: 'object', properties: { a: { type: 'string' } } },
  });
  assert.equal(result.structuredAnswer, null);
  assert.equal(result.timedOut, false);
});

test('an unanswered structured card times out with no structured answer', async () => {
  const api = makeRelay({ status: 'timed_out' });
  const bridge = makeBridge(api);
  const result = await bridge.askStructured({
    prompt: 'Details?',
    requestedSchema: { type: 'object', properties: { a: { type: 'string' } } },
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.structuredAnswer, null);
});

test('askStructured after shutdown mints no card and reads as a timeout', async () => {
  const api = makeRelay({ neverSettles: true });
  const bridge = makeBridge(api);
  await bridge.cancelPendingQuestions();

  const result = await bridge.askStructured({
    prompt: 'Details?',
    requestedSchema: { type: 'object', properties: { a: { type: 'string' } } },
  });

  // Shaped like a timeout so the elicitation handler declines, exactly as it
  // does for an unanswered card.
  assert.equal(result.timedOut, true);
  assert.equal(result.structuredAnswer, null);
  assert.equal(api.calls.filter((c) => c.method === 'POST' && c.path === '/api/relay-question').length, 0);
});

test('a relay that will not create the card raises rather than hanging', async () => {
  const api = async (method, path) => {
    if (method === 'POST' && path === '/api/relay-question') return { question: null };
    return {};
  };
  const bridge = makeBridge(api);
  await assert.rejects(
    () => bridge.askUserInput({ question: 'anything?' }),
    /Relay question could not be created/,
  );
});
