import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSdkMessageNormalizer,
  extractTextContent,
  formatToolActivityText,
  shouldEmitStreamUpdate,
} from './sdk-message-normalizer.mjs';
import { extractGrokModelsFromInitialize } from './acp-client.mjs';
import { classifyGrokError } from './grok-sdk-adapter.mjs';
import { buildGrokUserText, grokModeNudge } from './grok-turn-runner.mjs';
import { MAX_THOUGHT_CHARS } from '../../shared/thought-cap.mjs';

test('extractTextContent handles nested ACP content shapes', () => {
  assert.equal(extractTextContent({ text: 'hello' }), 'hello');
  assert.equal(extractTextContent({ content: { text: 'nested' } }), 'nested');
  assert.equal(extractTextContent('plain'), 'plain');
  assert.equal(extractTextContent(null), '');
});

test('shouldEmitStreamUpdate gates small deltas like other providers', () => {
  assert.equal(shouldEmitStreamUpdate('Hello world.', ''), true);
  assert.equal(shouldEmitStreamUpdate('Hello world.', 'Hello world.'), false);
  assert.equal(shouldEmitStreamUpdate('Hello world. Next sentence starts', 'Hello world.'), false);
  assert.equal(shouldEmitStreamUpdate('Hello world. Next sentence ends.', 'Hello world.'), true);
  const long = 'x'.repeat(30);
  assert.equal(shouldEmitStreamUpdate(`Hello${long}`, 'Hello'), true);
});

test('normalizeAcpUpdate maps message and thought chunks to relay channels', () => {
  const normalizer = createSdkMessageNormalizer();
  const streamActions = normalizer.normalizeAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hello from Grok. ' },
  });
  assert.equal(streamActions.length, 1);
  assert.equal(streamActions[0].channel, 'stream');
  assert.match(streamActions[0].payload.text, /Hello from Grok/);

  const thoughtActions = normalizer.normalizeAcpUpdate({
    sessionUpdate: 'agent_thought_chunk',
    content: { text: 'thinking…' },
  });
  assert.equal(thoughtActions.length, 1);
  assert.equal(thoughtActions[0].channel, 'thought');
  assert.match(thoughtActions[0].payload.reasoningId, /^grok-thought-main-/);
  assert.equal(thoughtActions[0].payload.done, false);

  const more = normalizer.normalizeAcpUpdate({
    sessionUpdate: 'agent_message_chunk',
    content: { text: 'More text that is long enough to flush again!!' },
  });
  assert.ok(more.some((a) => a.channel === 'stream'));

  const finalized = normalizer.finalizeResult({ stopReason: 'end_turn' });
  assert.ok(finalized.some((a) => a.channel === 'result'));
  assert.ok(finalized.some((a) => a.channel === 'thought' && a.payload.done === true));
  const result = finalized.find((a) => a.channel === 'result');
  assert.match(result.payload.text, /Hello from Grok/);
  assert.equal(result.payload.isError, false);
});

test('normalizeAcpUpdate maps tool_call to activity lines', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalizeAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-1',
    title: 'Read file',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'C:/git/copilot-remote/README.md' },
  });
  assert.ok(actions.some((a) => a.channel === 'activity'));
  const activity = actions.find((a) => a.channel === 'activity');
  // The ACP `kind` is the tool CATEGORY, not the name — the human-readable
  // title labels the line, with the category only as a last resort.
  assert.match(activity.payload.text, /Tool \(Read file\)/);
  assert.match(activity.payload.text, /README\.md/);

  const categoryOnly = createSdkMessageNormalizer().normalizeAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-2',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'npm test' },
  });
  assert.match(
    categoryOnly.find((a) => a.channel === 'activity').payload.text,
    /Tool \(execute\)/,
    'the category still labels frames that carry no name or title',
  );
});

test('a task-shaped tool call opens a subagent run (the category never matches)', () => {
  const normalizer = createSdkMessageNormalizer();
  const opened = normalizer.normalizeAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-task-1',
    title: 'Task: research the failing suite',
    kind: 'other',
    status: 'in_progress',
  });
  const running = opened.find((a) => a.channel === 'subagent');
  assert.ok(running, 'a Task-titled tool call must open a subagent run');
  assert.equal(running.payload.status, 'running');
  assert.equal(running.payload.subagentRunId, 'tc-task-1');

  const closed = normalizer.normalizeAcpUpdate({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'tc-task-1',
    title: 'Task: research the failing suite',
    kind: 'other',
    status: 'completed',
  });
  const terminal = closed.find((a) => a.channel === 'subagent');
  assert.equal(terminal.payload.status, 'completed');
});

test('a relay_tool call through the OAR MCP server reads as its action and target', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalizeAcpUpdate({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc-rr-1',
    title: 'oar/relay_tool',
    kind: 'other',
    status: 'pending',
    rawInput: { action: 'create_session', relay: 'linux-test', text: 'sidebar polish' },
  });
  assert.equal(
    actions.find((a) => a.channel === 'activity').payload.text,
    'Tool (relay_tool): create_session → linux-test: “sidebar polish”',
  );
  // An explicit name wins over the title; a frame without arguments stays generic.
  assert.equal(formatToolActivityText('mcp__oar__relay_tool', { action: 'list_relays' }, 'Remote relay'), 'Tool (relay_tool): list_relays');
  assert.equal(formatToolActivityText('mcp__oar__remote_relay', { action: 'list_relays' }, 'Remote relay'), 'Tool (relay_tool): list_relays', 'the old name');
  assert.equal(formatToolActivityText('', null, 'relay_tool'), 'Tool (relay_tool)');
});

test('formatToolActivityText and classifyGrokError are pure helpers', () => {
  assert.match(formatToolActivityText('bash', { command: 'ls -la' }), /bash/);
  const auth = classifyGrokError(new Error('not logged in'));
  assert.equal(auth.isAuth, true);
  assert.equal(auth.code, 'grok.authentication_failed');
  const missing = classifyGrokError(new Error('spawn grok ENOENT'));
  assert.equal(missing.code, 'grok.cli_missing');
});

test('extractGrokModelsFromInitialize reads modelState meta', () => {
  const extracted = extractGrokModelsFromInitialize({
    _meta: {
      modelState: {
        currentModelId: 'grok-4.5',
        availableModels: [
          { modelId: 'grok-4.5', reasoningEfforts: ['high', 'medium', 'low'] },
          { modelId: 'grok-code-fast-1', reasoningEfforts: ['low'] },
        ],
      },
    },
  });
  assert.equal(extracted.defaultModel, 'grok-4.5');
  assert.ok(extracted.models.includes('grok-4.5'));
  assert.ok(extracted.models.includes('grok-code-fast-1'));
  assert.deepEqual(extracted.effortsByModel['grok-4.5'], ['high', 'medium', 'low']);
});

test('grokModeNudge and buildGrokUserText', () => {
  assert.match(grokModeNudge('ask', ''), /ask/i);
  assert.equal(grokModeNudge('ask', 'ask'), '');
  assert.match(grokModeNudge('agent', 'ask'), /no longer apply/i);
  const text = buildGrokUserText({
    text: 'Hello',
    attachments: [{ path: 'C:/tmp/a.txt' }],
  });
  assert.match(text, /Hello/);
  assert.match(text, /a\.txt/);
});

test('a long thought streamed one token at a time is gated and stops at the cap', () => {
  const normalizer = createSdkMessageNormalizer();
  let interim = 0;
  let afterCap = 0;
  for (let i = 0; i < 2 * MAX_THOUGHT_CHARS; i += 1) {
    const out = normalizer.normalizeAcpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: '考' } });
    interim += out.length;
    if (i >= MAX_THOUGHT_CHARS) afterCap += out.length;
  }
  assert.ok(interim <= Math.ceil(MAX_THOUGHT_CHARS / 24) + 1, `${interim} interim thoughts`);
  assert.equal(afterCap, 0, 'no update once the capped text stops changing');
  const final = normalizer.finalizeResult({}).find((action) => action.channel === 'thought');
  assert.equal(final.payload.done, true);
  assert.equal(final.payload.text.length, MAX_THOUGHT_CHARS);
});

// Feeds ACP updates through one normalizer and returns every action plus the
// finalized ones, so a test can check the streamed and the final text.
function runTurn(updates, finalizeArgs = {}) {
  const normalizer = createSdkMessageNormalizer();
  const actions = [];
  for (const update of updates) actions.push(...normalizer.normalizeAcpUpdate(update));
  const finalized = normalizer.finalizeResult(finalizeArgs);
  const streams = [...actions, ...finalized].filter((action) => action.channel === 'stream');
  return {
    normalizer,
    actions,
    finalized,
    lastStream: streams.at(-1)?.payload.text,
    resultText: finalized.find((action) => action.channel === 'result').payload.text,
  };
}

const text = (value, extra = {}) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value }, ...extra });
const toolCall = (id) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Read file', kind: 'read', status: 'pending', rawInput: { path: 'notes/plan.txt' } });
const toolUpdate = (id, status) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status });
const thought = (value) => ({ sessionUpdate: 'agent_thought_chunk', content: { text: value } });

test('text runs either side of a tool call are joined by one blank line', () => {
  const turn = runTurn([
    text('Let me look at the folder first.'),
    toolCall('tc-a'),
    toolUpdate('tc-a', 'in_progress'),
    toolUpdate('tc-a', 'completed'),
    text('The folder holds two files.'),
  ]);
  assert.equal(turn.resultText, 'Let me look at the folder first.\n\nThe folder holds two files.');
  assert.equal(turn.lastStream, turn.resultText);
  assert.equal(turn.normalizer.finalStreamText(), turn.resultText);
});

test('a turn without tool calls is the plain concatenation of its chunks', () => {
  const turn = runTurn([text('First line,'), text(' same line.\nSecond'), text(' line.\n\nThird.')]);
  assert.equal(turn.resultText, 'First line, same line.\nSecond line.\n\nThird.');
  assert.equal(turn.normalizer.finalStreamText(), 'First line, same line.\nSecond line.\n\nThird.');
});

test('newlines already around a tool call still give exactly one blank line', () => {
  for (const preamble of ['Checking.\n', 'Checking.\n\n', 'Checking.  \n ']) {
    const turn = runTurn([text(preamble), toolCall('tc-b'), text('\nAll good.'), text(' Done.')]);
    assert.equal(turn.resultText, 'Checking.\n\nAll good. Done.', JSON.stringify(preamble));
    assert.equal(turn.lastStream, turn.resultText);
  }
});

test('whitespace after a final tool call leaves nothing dangling', () => {
  const turn = runTurn([text('Writing the report now. '), toolCall('tc-c'), toolUpdate('tc-c', 'completed'), text('\n\n'), text(' ')]);
  assert.equal(turn.resultText, 'Writing the report now.');
  assert.equal(turn.lastStream, 'Writing the report now.');
  assert.equal(turn.normalizer.finalStreamText(), 'Writing the report now.');
});

test('a late update of a known tool call does not break a sentence', () => {
  const turn = runTurn([
    toolCall('tc-d'),
    text('The build is still'),
    toolUpdate('tc-d', 'completed'),
    text(' running in the background.'),
  ]);
  assert.equal(turn.resultText, 'The build is still running in the background.');
});

test('an update for a tool call never seen before counts as a new call', () => {
  const turn = runTurn([text('Before.'), toolUpdate('tc-e', 'in_progress'), text('After.')]);
  assert.equal(turn.resultText, 'Before.\n\nAfter.');
});

test('a thought between two text runs gives one blank line', () => {
  const turn = runTurn([text('Part one.'), thought('weighing the options'), text('Part two.')]);
  assert.equal(turn.resultText, 'Part one.\n\nPart two.');
  assert.equal(turn.lastStream, turn.resultText);
});

test('two tool calls in a row still give exactly one blank line', () => {
  const turn = runTurn([
    text('Opening both files.'),
    toolCall('tc-f'),
    toolCall('tc-g'),
    toolUpdate('tc-f', 'completed'),
    toolUpdate('tc-g', 'completed'),
    text('Both files match.'),
  ]);
  assert.equal(turn.resultText, 'Opening both files.\n\nBoth files match.');
});

test('a change of message id between text chunks starts a new run', () => {
  const turn = runTurn([
    text('One', { messageId: 'msg-1' }),
    text(' sentence.', { messageId: 'msg-1' }),
    text('Another.', { messageId: 'msg-2' }),
  ]);
  assert.equal(turn.resultText, 'One sentence.\n\nAnother.');
});

test('a join that trims published whitespace still streams the joined text', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalizeAcpUpdate(text('Short. '));
  assert.equal(first[0].payload.text, 'Short. ');
  normalizer.normalizeAcpUpdate(toolCall('tc-h'));
  const joined = normalizer.normalizeAcpUpdate(text('Ok'));
  assert.equal(joined.length, 1);
  assert.equal(joined[0].payload.text, 'Short.\n\nOk');
  const final = normalizer.finalizeResult({}).filter((action) => action.channel === 'stream');
  assert.equal(final.length, 1);
  assert.equal(final[0].payload.done, true);
  assert.equal(final[0].payload.text, 'Short.\n\nOk');
});

test('finalizeResult with an explicit text keeps that text', () => {
  const turn = runTurn([text('Streamed part.'), toolCall('tc-i'), text('More.')], { text: '  Given reply.  ' });
  assert.equal(turn.resultText, 'Given reply.');
  const done = turn.finalized.find((action) => action.channel === 'stream');
  assert.equal(done.payload.text, 'Given reply.');
  assert.equal(done.payload.done, true);
});
