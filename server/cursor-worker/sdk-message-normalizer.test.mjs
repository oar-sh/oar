import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSdkMessageNormalizer,
  formatToolActivityText,
  shouldEmitStreamUpdate,
  summarizeToolInput,
} from './sdk-message-normalizer.mjs';

function delta(update) {
  return { source: 'delta', update };
}

function stream(message) {
  return { source: 'stream', message };
}

function assistantText(text) {
  return stream({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

test('init message yields init action and records the model', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize(stream({ type: 'system', subtype: 'init', model: 'cursor-composer-1' }));
  assert.deepEqual(actions, [{ channel: 'init', payload: { sessionId: '', model: 'cursor-composer-1' } }]);
  assert.equal(normalizer.model, 'cursor-composer-1');
});

test('text deltas accumulate into cumulative stream snapshots with emit gating', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize(delta({ type: 'text-delta', text: 'Hello' }));
  assert.equal(first.length, 1);
  assert.equal(first[0].channel, 'stream');
  assert.deepEqual(first[0].payload, { text: 'Hello', done: false, subagentRunId: null });

  // Tiny delta with no terminal punctuation is suppressed.
  const second = normalizer.normalize(delta({ type: 'text-delta', text: ' wor' }));
  assert.equal(second.length, 0);

  // Punctuation flushes the accumulated snapshot.
  const third = normalizer.normalize(delta({ type: 'text-delta', text: 'ld.' }));
  assert.equal(third.length, 1);
  assert.equal(third[0].payload.text, 'Hello world.');
  assert.equal(normalizer.finalStreamText(), 'Hello world.');
});

test('first text-delta latches ownership; stream assistant text is fallback only', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize(delta({ type: 'text-delta', text: 'Streamed answer.' }));
  const suppressed = normalizer.normalize(assistantText('Full text from the stream surface.'));
  assert.deepEqual(suppressed, []);
  assert.equal(normalizer.finalStreamText(), 'Streamed answer.');
});

test('degraded mode: assistant text blocks become cumulative stream snapshots', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize(assistantText('First paragraph of the answer.'));
  assert.equal(first.length, 1);
  assert.equal(first[0].channel, 'stream');
  assert.equal(first[0].payload.text, 'First paragraph of the answer.');
  assert.equal(first[0].payload.subagentRunId, null);

  const second = normalizer.normalize(assistantText(' Second paragraph, still cumulative.'));
  assert.equal(second.length, 1);
  assert.equal(second[0].payload.text, 'First paragraph of the answer. Second paragraph, still cumulative.');
  assert.equal(normalizer.finalStreamText(), 'First paragraph of the answer. Second paragraph, still cumulative.');
});

test('thinking deltas coalesce into one thought with a stable reasoningId', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize(delta({ type: 'thinking-delta', text: 'ponder' }));
  assert.equal(first.length, 1);
  assert.equal(first[0].channel, 'thought');
  const reasoningId = first[0].payload.reasoningId;
  assert.equal(reasoningId, 'cursor-thought-main-0-0');
  assert.deepEqual(first[0].payload, { reasoningId, text: 'ponder', done: false, subagentRunId: null });

  const second = normalizer.normalize(delta({ type: 'thinking-delta', text: 'ing more' }));
  assert.equal(second[0].payload.reasoningId, reasoningId);
  assert.equal(second[0].payload.text, 'pondering more');

  const done = normalizer.normalize(delta({ type: 'thinking-completed', thinkingDurationMs: 1200 }));
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].payload, { reasoningId, text: 'pondering more', done: true, subagentRunId: null });

  // The next delta opens a new thought with a distinct id.
  const next = normalizer.normalize(delta({ type: 'thinking-delta', text: 'fresh thought' }));
  assert.equal(next[0].payload.reasoningId, 'cursor-thought-main-0-1');
});

test('step-completed force-closes an open thought; step-started bumps the step index', () => {
  const normalizer = createSdkMessageNormalizer();
  const open = normalizer.normalize(delta({ type: 'thinking-delta', text: 'half-done thought' }));
  const closed = normalizer.normalize(delta({ type: 'step-completed', stepId: 's1' }));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].payload.reasoningId, open[0].payload.reasoningId);
  assert.equal(closed[0].payload.done, true);

  normalizer.normalize(delta({ type: 'step-started', stepId: 's2' }));
  const nextStep = normalizer.normalize(delta({ type: 'thinking-delta', text: 'next step thought' }));
  assert.equal(nextStep[0].payload.reasoningId, 'cursor-thought-main-1-1');
});

test('degraded mode: stream thinking messages become single done thoughts', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize(stream({ type: 'thinking', text: 'stream-surface pondering', thinking_duration_ms: 800 }));
  assert.equal(first.length, 1);
  assert.equal(first[0].channel, 'thought');
  assert.equal(first[0].payload.text, 'stream-surface pondering');
  assert.equal(first[0].payload.done, true);

  const second = normalizer.normalize(stream({ type: 'thinking', text: 'a later thought' }));
  assert.notEqual(second[0].payload.reasoningId, first[0].payload.reasoningId);
});

test('first thinking-delta latches ownership; stream thinking messages are suppressed', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize(delta({ type: 'thinking-delta', text: 'delta-owned thought' }));
  const suppressed = normalizer.normalize(stream({ type: 'thinking', text: 'delta-owned thought, complete' }));
  assert.deepEqual(suppressed, []);
});

test('tool_call running frames emit one activity line and de-dupe by (call_id, status)', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize(stream({
    type: 'tool_call', call_id: 'call_1', name: 'Bash', status: 'running', args: { command: 'npm test' },
  }));
  assert.equal(first.length, 1);
  assert.equal(first[0].channel, 'activity');
  assert.equal(first[0].payload.text, 'Tool (Bash): npm test');
  assert.equal(first[0].payload.subagentRunId, null);

  const repeat = normalizer.normalize(stream({
    type: 'tool_call', call_id: 'call_1', name: 'Bash', status: 'running', args: { command: 'npm test' },
  }));
  assert.deepEqual(repeat, []);

  // A non-subagent completion emits nothing.
  const completed = normalizer.normalize(stream({ type: 'tool_call', call_id: 'call_1', name: 'Bash', status: 'completed' }));
  assert.deepEqual(completed, []);
});

test('tool_call error frames surface a truncated failure activity', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize(stream({ type: 'tool_call', call_id: 'call_2', name: 'Read', status: 'running', args: { path: '/home/dev/a' } }));
  const failed = normalizer.normalize(stream({
    type: 'tool_call', call_id: 'call_2', name: 'Read', status: 'error', result: `ENOENT ${'x'.repeat(400)}`,
  }));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].channel, 'activity');
  assert.match(failed[0].payload.text, /^Tool failed: ENOENT/);
  assert.ok(failed[0].payload.text.length <= 140);
  assert.ok(failed[0].payload.text.endsWith('…'));
});

test('subagent tool_call lifecycle is keyed by call_id', () => {
  const normalizer = createSdkMessageNormalizer();
  const start = normalizer.normalize(stream({
    type: 'tool_call', call_id: 'call_task_1', name: 'task', status: 'running', args: { description: 'Explore repo' },
  }));
  const subagentStart = start.find((action) => action.channel === 'subagent');
  assert.ok(subagentStart);
  assert.deepEqual(subagentStart.payload, {
    subagentRunId: 'call_task_1',
    parentSubagentId: null,
    displayName: 'Explore repo',
    status: 'running',
  });
  assert.ok(start.some((action) => action.channel === 'activity'));

  const complete = normalizer.normalize(stream({ type: 'tool_call', call_id: 'call_task_1', name: 'task', status: 'completed' }));
  assert.equal(complete.length, 1);
  assert.equal(complete[0].channel, 'subagent');
  assert.equal(complete[0].payload.status, 'completed');

  // Completion for a call_id we never opened emits nothing.
  const unknown = normalizer.normalize(stream({ type: 'tool_call', call_id: 'call_other', name: 'task', status: 'completed' }));
  assert.deepEqual(unknown, []);
});

test('subagent tool_call error frames mark the run failed', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize(stream({
    type: 'tool_call', call_id: 'call_agent_1', name: 'agent', status: 'running', args: { subagent_type: 'Explore' },
  }));
  const failed = normalizer.normalize(stream({
    type: 'tool_call', call_id: 'call_agent_1', name: 'agent', status: 'error', result: 'agent crashed',
  }));
  const subagent = failed.find((action) => action.channel === 'subagent');
  assert.ok(subagent);
  assert.equal(subagent.payload.status, 'failed');
  assert.equal(subagent.payload.displayName, 'Explore');
  const activity = failed.find((action) => action.channel === 'activity');
  assert.match(activity.payload.text, /Tool failed: agent crashed/);
});

test('terminal statuses map onto result subtypes', () => {
  const cases = [
    { status: 'FINISHED', isError: false, subtype: 'finished' },
    { status: 'ERROR', isError: true, subtype: 'error' },
    { status: 'EXPIRED', isError: true, subtype: 'expired' },
    { status: 'CANCELLED', isError: false, subtype: 'cancelled' },
  ];
  for (const { status, isError, subtype } of cases) {
    const normalizer = createSdkMessageNormalizer();
    normalizer.normalize(delta({ type: 'text-delta', text: 'Answer text.' }));
    const actions = normalizer.normalize(stream({ type: 'status', status }));
    assert.equal(actions.length, 1, status);
    assert.equal(actions[0].channel, 'result');
    assert.deepEqual(actions[0].payload, {
      text: 'Answer text.',
      isError,
      subtype,
      usage: null,
      totalCostUsd: null,
    });
  }
});

test('error status without streamed text falls back to the status message', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize(stream({ type: 'status', status: 'ERROR', message: 'model overloaded' }));
  assert.equal(actions[0].payload.text, 'model overloaded');
  assert.equal(actions[0].payload.isError, true);
});

test('usage is captured last-wins from both surfaces and exposed on the result', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 };
  const second = { inputTokens: 120, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 30, totalTokens: 1090 };
  assert.deepEqual(normalizer.normalize(delta({ type: 'turn-ended', usage: first })), []);
  assert.deepEqual(normalizer.normalize(stream({ type: 'usage', usage: second })), []);
  const result = normalizer.normalize(stream({ type: 'status', status: 'FINISHED' }));
  assert.deepEqual(result[0].payload.usage, second);
});

test('thought text is capped at 16KiB per thought', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize(delta({ type: 'thinking-delta', text: 'y'.repeat(20 * 1024) }));
  assert.equal(first[0].payload.text.length, 16 * 1024);
  const second = normalizer.normalize(delta({ type: 'thinking-delta', text: 'overflow' }));
  assert.equal(second[0].payload.text.length, 16 * 1024);
});

test('activity text is capped at 140 characters', () => {
  const text = formatToolActivityText('Bash', { command: 'x'.repeat(400) });
  assert.ok(text.length <= 140);
  assert.ok(text.endsWith('…'));
});

test('summarizeToolInput prefers meaningful fields and falls back to JSON', () => {
  assert.equal(summarizeToolInput('Bash', { command: 'npm test', prompt: 'ignored' }), 'npm test');
  assert.equal(summarizeToolInput('Read', { file_path: '/home/dev/x' }), '/home/dev/x');
  assert.equal(summarizeToolInput('Custom', { foo: 'bar' }), '{"foo":"bar"}');
  assert.equal(summarizeToolInput('Empty', {}), '');
});

test('shouldEmitStreamUpdate mirrors the copilot gating', () => {
  assert.equal(shouldEmitStreamUpdate('a', ''), true);
  assert.equal(shouldEmitStreamUpdate('ab', 'a'), false);
  assert.equal(shouldEmitStreamUpdate('a'.repeat(30), 'a'), true);
  assert.equal(shouldEmitStreamUpdate('ab.', 'a'), true);
  assert.equal(shouldEmitStreamUpdate('same', 'same'), false);
  assert.equal(shouldEmitStreamUpdate('', 'prev'), false);
});

test('task messages surface as truncated activity lines', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize(stream({ type: 'task', status: 'stopped', text: 'Background shell exited.' }));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].channel, 'activity');
  assert.equal(actions[0].payload.text, 'Background task stopped: Background shell exited.');
});

test('non-actionable events are ignored', () => {
  const normalizer = createSdkMessageNormalizer();
  const ignored = [
    delta({ type: 'tool-call-started', toolCallId: 'call_9' }),
    delta({ type: 'tool-call-completed', toolCallId: 'call_9' }),
    delta({ type: 'partial-tool-call', toolCallId: 'call_9' }),
    delta({ type: 'token-delta' }),
    delta({ type: 'summary' }),
    delta({ type: 'summary-started' }),
    delta({ type: 'user-message-appended' }),
    delta({ type: 'shell-output-delta' }),
    stream({ type: 'user' }),
    stream({ type: 'request', request_id: 'req-1' }),
    stream({ type: 'status', status: 'CREATING' }),
    stream({ type: 'status', status: 'RUNNING' }),
    null,
    { source: 'other' },
  ];
  for (const event of ignored) {
    assert.deepEqual(normalizer.normalize(event), []);
  }
});
