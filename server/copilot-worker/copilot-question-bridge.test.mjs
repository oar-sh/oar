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
function makeRelay({ answerWith = null, status = 'answered', neverSettles = false } = {}) {
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
      return { question: { id: 'question-1', status, answer: answerWith } };
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
