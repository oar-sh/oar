import test from 'node:test';
import assert from 'node:assert/strict';

import { createAskUserBridge } from './ask-user-bridge.mjs';
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from './question-timeout.mjs';

function makeApiStub({ answers = [], statuses = [], structuredAnswers = [] } = {}) {
  const calls = [];
  let questionCounter = 0;
  const statusById = new Map();
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      if (method === 'POST' && routePath === '/api/relay-question') {
        questionCounter += 1;
        const id = `q-${questionCounter}`;
        statusById.set(id, {
          status: statuses[questionCounter - 1] || 'answered',
          answer: answers[questionCounter - 1] || '',
          ...(structuredAnswers[questionCounter - 1]
            ? { structuredAnswer: structuredAnswers[questionCounter - 1] }
            : {}),
        });
        return { question: { id } };
      }
      if (method === 'GET' && routePath.startsWith('/api/relay-question/')) {
        const id = routePath.split('/').pop();
        const state = statusById.get(id) || { status: 'answered', answer: '' };
        return { question: { id, ...state } };
      }
      return { ok: true };
    },
  };
}

const activeMessage = { id: 'msg-1', conversationId: 'conv-1', relayMode: 'agent' };

test('answers map is keyed by question text', async () => {
  const stub = makeApiStub({ answers: ['Use tmux'] });
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sdkSessionId: 'conv-1',
    sleep: async () => {},
  });
  const result = await bridge.handleAskUserQuestion({
    questions: [{
      question: 'How should workers run?',
      header: 'Workers',
      multiSelect: false,
      options: [
        { label: 'Use tmux', description: 'tmux sessions' },
        { label: 'Plain spawn', description: 'detached processes' },
      ],
    }],
  });
  assert.deepEqual(result.answers, { 'How should workers run?': 'Use tmux' });
  assert.equal(result.timedOut, false);
  const created = stub.calls.find((call) => call.routePath === '/api/relay-question');
  assert.deepEqual(created.body.choices, ['Use tmux', 'Plain spawn']);
  assert.equal(created.body.messageId, 'msg-1');
  assert.equal(created.body.conversationId, 'conv-1');
  assert.match(created.body.prompt, /How should workers run\?/);
  assert.match(created.body.prompt, /Use tmux: tmux sessions/);
});

test('timed out question returns the continuation text', async () => {
  const stub = makeApiStub({ statuses: ['timed_out'] });
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });
  const result = await bridge.handleAskUserQuestion({
    questions: [{
      question: 'Pick one?',
      header: 'Pick',
      multiSelect: false,
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
    }],
  });
  assert.equal(result.answers['Pick one?'], QUESTION_TIMEOUT_CONTINUATION_TEXT);
  assert.equal(result.timedOut, true);
});

test('multiple questions are asked sequentially and all collected', async () => {
  const stub = makeApiStub({ answers: ['First answer', 'Second answer'] });
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });
  const result = await bridge.handleAskUserQuestion({
    questions: [
      { question: 'Q1?', header: 'One', multiSelect: false, options: [{ label: 'x', description: '' }, { label: 'y', description: '' }] },
      { question: 'Q2?', header: 'Two', multiSelect: false, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] },
    ],
  });
  assert.deepEqual(result.answers, { 'Q1?': 'First answer', 'Q2?': 'Second answer' });
  const posts = stub.calls.filter((call) => call.routePath === '/api/relay-question');
  assert.equal(posts.length, 2);
});

test('empty question input yields empty answers without API calls', async () => {
  const stub = makeApiStub();
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });
  const result = await bridge.handleAskUserQuestion({ questions: [] });
  assert.deepEqual(result.answers, {});
  assert.equal(stub.calls.length, 0);
});

test('a requestedSchema on a question rides top-level into the create payload', async () => {
  // Structured-elicitation parity: the create route reads a TOP-LEVEL
  // `requestedSchema`; flat questions (every existing caller) omit it.
  const schema = { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] };
  const stub = makeApiStub({ answers: ['done'], structuredAnswers: [{ env: 'prod' }] });
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });

  const result = await bridge.handleAskUserQuestion({
    questions: [{ question: 'Deployment env?', requestedSchema: schema, options: [] }],
  });

  const created = stub.calls.find((call) => call.routePath === '/api/relay-question');
  assert.deepEqual(created.body.requestedSchema, schema);
  // The validated structured submission comes back alongside the flat answer.
  assert.deepEqual(result.answers, { 'Deployment env?': 'done' });
  assert.deepEqual(result.structuredAnswers, { 'Deployment env?': { env: 'prod' } });

  // A flat question sends no schema field at all and yields no structured map
  // entry — nothing changes for existing consumers.
  const flatStub = makeApiStub({ answers: ['A'] });
  const flatResult = await createAskUserBridge({
    api: flatStub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  }).handleAskUserQuestion({ questions: [{ question: 'Pick?', options: [{ label: 'A', description: '' }] }] });
  const flatCreated = flatStub.calls.find((call) => call.routePath === '/api/relay-question');
  assert.equal('requestedSchema' in flatCreated.body, false);
  assert.deepEqual(flatResult.structuredAnswers, {});
});

test('the waiter surfaces structuredAnswer and honours a per-call timeout', async () => {
  const stub = makeApiStub({ answers: ['ok'], structuredAnswers: [{ a: 1 }] });
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });
  const { question } = await stub.api('POST', '/api/relay-question', {});
  const answered = await bridge.waitForRelayQuestionAnswer(question.id);
  assert.equal(answered.answer, 'ok');
  assert.deepEqual(answered.structuredAnswer, { a: 1 });

  // Per-call timeoutMs overrides the bridge-wide default for one wait: a
  // 0ms deadline times the pending card out on the first poll.
  const pendingStub = makeApiStub({ statuses: ['pending'] });
  const pendingBridge = createAskUserBridge({
    api: pendingStub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });
  const { question: pendingQuestion } = await pendingStub.api('POST', '/api/relay-question', {});
  const timedOut = await pendingBridge.waitForRelayQuestionAnswer(pendingQuestion.id, { timeoutMs: 0 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(pendingStub.calls.some((call) => call.routePath.endsWith('/timeout')), true);
});

test('question source and rationale default to the Claude wire payload and are overridable', async () => {
  const question = {
    questions: [{
      question: 'Which one?',
      header: 'Pick',
      multiSelect: false,
      options: [{ label: 'A', description: '' }, { label: 'B', description: '' }],
    }],
  };

  const defaultStub = makeApiStub({ answers: ['A'] });
  await createAskUserBridge({
    api: defaultStub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  }).handleAskUserQuestion(question);
  const defaultPost = defaultStub.calls.find((call) => call.routePath === '/api/relay-question');
  assert.equal(defaultPost.body.context.source, 'AskUserQuestion');
  assert.match(defaultPost.body.context.rationale, /Claude requested clarification/);

  const cursorStub = makeApiStub({ answers: ['A'] });
  await createAskUserBridge({
    api: cursorStub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
    questionSource: 'ask_user',
    questionRationale: 'Cursor requested clarification to continue this turn.',
  }).handleAskUserQuestion(question);
  const cursorPost = cursorStub.calls.find((call) => call.routePath === '/api/relay-question');
  assert.equal(cursorPost.body.context.source, 'ask_user');
  assert.equal(cursorPost.body.context.rationale, 'Cursor requested clarification to continue this turn.');
});

test('one ask may carry its own source and rationale without changing the bridge default', async () => {
  const stub = makeApiStub({ answers: ['A', 'A'] });
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });
  const question = { questions: [{ question: 'Go ahead?', options: [{ label: 'A' }, { label: 'B' }] }] };
  await bridge.handleAskUserQuestion(question, { source: 'SampleCheck', rationale: 'A sample check needs you.' });
  await bridge.handleAskUserQuestion(question);
  const posts = stub.calls.filter((call) => call.routePath === '/api/relay-question');
  assert.equal(posts[0].body.context.source, 'SampleCheck');
  assert.equal(posts[0].body.context.rationale, 'A sample check needs you.');
  assert.equal(posts[1].body.context.source, 'AskUserQuestion');
  assert.match(posts[1].body.context.rationale, /Claude requested clarification/);
});

test('one ask may take no typed reply; every other ask still does', async () => {
  const stub = makeApiStub({ answers: ['A', 'A'] });
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });
  const question = { questions: [{ question: 'Go ahead?', options: [{ label: 'A' }, { label: 'B' }] }] };
  await bridge.handleAskUserQuestion(question, { allowFreeform: false });
  await bridge.handleAskUserQuestion(question);
  const posts = stub.calls.filter((call) => call.routePath === '/api/relay-question');
  assert.equal(posts[0].body.allowFreeform, false);
  assert.equal(posts[1].body.allowFreeform, true);
});

test('one ask may carry a card kind and the person-only flag; every other ask carries neither', async () => {
  const stub = makeApiStub({ answers: ['A', 'A'] });
  const bridge = createAskUserBridge({
    api: stub.api,
    getActiveMessage: () => activeMessage,
    sleep: async () => {},
  });
  const question = { questions: [{ question: 'Go ahead?', options: [{ label: 'A' }, { label: 'B' }] }] };
  await bridge.handleAskUserQuestion(question, { source: 'SampleCheck', kind: 'sensitive-file', personOnly: true });
  await bridge.handleAskUserQuestion(question, { personOnly: 'yes' });
  const posts = stub.calls.filter((call) => call.routePath === '/api/relay-question');
  assert.equal(posts[0].body.context.kind, 'sensitive-file');
  assert.equal(posts[0].body.context.personOnly, true);
  assert.equal('kind' in posts[1].body.context, false);
  assert.equal('personOnly' in posts[1].body.context, false, 'only a real boolean true');
});
