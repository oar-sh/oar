import test from 'node:test';
import assert from 'node:assert/strict';

import { createAskUserBridge } from './ask-user-bridge.mjs';
import { QUESTION_TIMEOUT_CONTINUATION_TEXT } from '../../shared/question-timeout.mjs';

function makeApiStub({ answers = [], statuses = [] } = {}) {
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
