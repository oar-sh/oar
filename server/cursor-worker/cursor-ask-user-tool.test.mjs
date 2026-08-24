import test from 'node:test';
import assert from 'node:assert/strict';

import { createAskUserTool } from './cursor-ask-user-tool.mjs';

function createRecordingBridge(result) {
  const calls = [];
  return {
    calls,
    handleAskUserQuestion: async (input, options) => {
      calls.push({ input, options });
      return result;
    },
  };
}

test('tool shape steers the model and validates 1-4 questions with 2-6 options', () => {
  const tool = createAskUserTool({ bridge: createRecordingBridge({ answers: {}, timedOut: false }) });
  assert.equal(tool.name, 'ask_user');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(
    tool.description,
    'Ask the user one or more clarifying questions and wait for their answers. '
    + 'This is the ONLY way to ask the user anything: a question written as plain '
    + 'reply text is NOT shown interactively and ends the turn unanswered. Call '
    + 'this tool whenever user input would materially change the result, before '
    + 'making assumptions. Provide 2-4 concise options per question; the user can '
    + 'always answer in free text instead. This tool blocks until the user '
    + 'responds; on timeout it returns an instruction to continue under the '
    + 'current relay mode.',
  );

  const schema = tool.inputSchema;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['questions']);
  const questions = schema.properties.questions;
  assert.equal(questions.type, 'array');
  assert.equal(questions.minItems, 1);
  assert.equal(questions.maxItems, 4);
  const entry = questions.items;
  assert.deepEqual(entry.required, ['question', 'options']);
  assert.equal(entry.properties.question.type, 'string');
  assert.equal(entry.properties.header.type, 'string');
  assert.equal(entry.properties.multiSelect.type, 'boolean');
  assert.equal(entry.properties.multiSelect.default, false);
  const options = entry.properties.options;
  assert.equal(options.type, 'array');
  assert.equal(options.minItems, 2);
  assert.equal(options.maxItems, 6);
  assert.deepEqual(options.items.required, ['label']);
  assert.equal(options.items.properties.label.type, 'string');
  assert.equal(options.items.properties.description.type, 'string');
});

test('execute returns structured answers plus Q/A text', async () => {
  const bridge = createRecordingBridge({
    answers: { 'Which db?': 'sqlite', 'Which port?': '8080' },
    timedOut: false,
  });
  const tool = createAskUserTool({ bridge });
  const args = {
    questions: [{
      question: 'Which db?',
      options: [{ label: 'sqlite' }, { label: 'postgres' }],
    }],
  };
  const result = await tool.execute(args);
  assert.equal(bridge.calls.length, 1);
  assert.equal(bridge.calls[0].input, args);
  assert.deepEqual(result.structuredContent, {
    answers: { 'Which db?': 'sqlite', 'Which port?': '8080' },
    timedOut: false,
  });
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'Q: Which db?\nA: sqlite\n\nQ: Which port?\nA: 8080',
  }]);
});

test('execute passes the current abort signal to the bridge', async () => {
  const bridge = createRecordingBridge({ answers: {}, timedOut: false });
  const controller = new AbortController();
  const tool = createAskUserTool({ bridge, getAbortSignal: () => controller.signal });
  await tool.execute({ questions: [] });
  assert.equal(bridge.calls[0].options.signal, controller.signal);

  // Missing getAbortSignal is fine: signal is simply undefined.
  const bareBridge = createRecordingBridge({ answers: {}, timedOut: false });
  const bareTool = createAskUserTool({ bridge: bareBridge });
  await bareTool.execute({ questions: [] });
  assert.equal(bareBridge.calls[0].options.signal, undefined);
});

test('timedOut passes through to structuredContent', async () => {
  const bridge = createRecordingBridge({
    answers: { 'Q?': '[No user response before timeout — continue according to the current relay mode.]' },
    timedOut: true,
  });
  const tool = createAskUserTool({ bridge });
  const result = await tool.execute({ questions: [{ question: 'Q?', options: [] }] });
  assert.equal(result.structuredContent.timedOut, true);
});

test('empty answers produce the no-response text', async () => {
  const tool = createAskUserTool({ bridge: createRecordingBridge({ answers: {}, timedOut: false }) });
  const result = await tool.execute({ questions: [] });
  assert.deepEqual(result.structuredContent, { answers: {}, timedOut: false });
  assert.deepEqual(result.content, [{ type: 'text', text: 'No user response.' }]);
});

test('a bridge failure returns text instead of throwing', async () => {
  const tool = createAskUserTool({
    bridge: { handleAskUserQuestion: async () => { throw new Error('relay down'); } },
  });
  const result = await tool.execute({ questions: [{ question: 'Q?', options: [] }] });
  assert.equal(result.structuredContent, undefined);
  assert.deepEqual(result.content, [{
    type: 'text',
    text: 'ask_user failed: relay down. Continue without user input.',
  }]);
});
