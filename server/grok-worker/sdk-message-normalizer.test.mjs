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
  assert.match(activity.payload.text, /Tool \(read\)/);
  assert.match(activity.payload.text, /README\.md/);
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
