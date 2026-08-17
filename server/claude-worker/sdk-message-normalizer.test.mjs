import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSdkMessageNormalizer,
  formatToolActivityText,
  shouldEmitStreamUpdate,
  summarizeToolInput,
} from './sdk-message-normalizer.mjs';

function streamTextDelta(text, parentToolUseId = null) {
  return {
    type: 'stream_event',
    parent_tool_use_id: parentToolUseId,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
}

test('init message yields init action with session id and model', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-123',
    model: 'claude-sonnet-5',
  });
  assert.deepEqual(actions, [{ channel: 'init', payload: { sessionId: 'sess-123', model: 'claude-sonnet-5' } }]);
  assert.equal(normalizer.sessionId, 'sess-123');
});

test('text deltas accumulate into cumulative stream snapshots with emit gating', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize(streamTextDelta('Hello'));
  assert.equal(first.length, 1);
  assert.equal(first[0].channel, 'stream');
  assert.equal(first[0].payload.text, 'Hello');
  assert.equal(first[0].payload.subagentRunId, null);

  // Tiny delta with no terminal punctuation is suppressed.
  const second = normalizer.normalize(streamTextDelta(' wor'));
  assert.equal(second.length, 0);

  // Punctuation flushes the accumulated snapshot.
  const third = normalizer.normalize(streamTextDelta('ld.'));
  assert.equal(third.length, 1);
  assert.equal(third[0].payload.text, 'Hello world.');
});

test('thinking blocks map to coalesced thought snapshots with stable reasoningId', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking' } },
  });
  const delta = normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'pondering' } },
  });
  assert.equal(delta.length, 1);
  assert.equal(delta[0].channel, 'thought');
  const reasoningId = delta[0].payload.reasoningId;
  assert.ok(reasoningId);
  assert.equal(delta[0].payload.text, 'pondering');
  assert.equal(delta[0].payload.done, false);

  const stop = normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 1 },
  });
  assert.equal(stop.length, 1);
  assert.equal(stop[0].payload.reasoningId, reasoningId);
  assert.equal(stop[0].payload.done, true);
});

test('assistant tool_use blocks emit truncated activity lines', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].channel, 'activity');
  assert.equal(actions[0].payload.text, 'Tool (Bash): npm test');
  assert.equal(actions[0].payload.subagentRunId, null);
});

test('activity text is capped at 140 characters', () => {
  const longCommand = 'x'.repeat(400);
  const text = formatToolActivityText('Bash', { command: longCommand });
  assert.ok(text.length <= 140);
  assert.ok(text.endsWith('…'));
});

test('Task tool_use starts a subagent run and tool_result completes it', () => {
  const normalizer = createSdkMessageNormalizer();
  const start = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_task_1', name: 'Task', input: { description: 'Explore repo', prompt: 'go' } },
      ],
    },
  });
  const subagentStart = start.find((action) => action.channel === 'subagent');
  assert.ok(subagentStart);
  assert.equal(subagentStart.payload.subagentRunId, 'toolu_task_1');
  assert.equal(subagentStart.payload.displayName, 'Explore repo');
  assert.equal(subagentStart.payload.parentSubagentId, null);
  assert.equal(subagentStart.payload.status, 'running');

  const complete = normalizer.normalize({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_task_1', content: 'done' },
      ],
    },
  });
  const subagentDone = complete.find((action) => action.channel === 'subagent');
  assert.ok(subagentDone);
  assert.equal(subagentDone.payload.status, 'completed');
});

test('messages with parent_tool_use_id attribute to the subagent run', () => {
  const normalizer = createSdkMessageNormalizer();
  const streamed = normalizer.normalize(streamTextDelta('Working on the subtask.', 'toolu_task_1'));
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0].payload.subagentRunId, 'toolu_task_1');

  const toolActions = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: 'toolu_task_1',
    message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/tmp/a' } }] },
  });
  assert.equal(toolActions[0].payload.subagentRunId, 'toolu_task_1');
});

test('nested Task inside a subagent records parent linkage', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: 'toolu_task_parent',
    message: {
      content: [{ type: 'tool_use', id: 'toolu_task_child', name: 'Task', input: { description: 'Deep dive' } }],
    },
  });
  const subagent = actions.find((action) => action.channel === 'subagent');
  assert.equal(subagent.payload.parentSubagentId, 'toolu_task_parent');
});

test('failed tool_result surfaces an error activity', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: 'command not found' }],
    },
  });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].channel, 'activity');
  assert.match(actions[0].payload.text, /Tool failed: command not found/);
});

test('result success and error map to result actions', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5' });
  const success = normalizer.normalize({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'All done.',
    session_id: 's1',
  });
  assert.deepEqual(success[0].payload, {
    text: 'All done.',
    isError: false,
    subtype: 'success',
    sessionId: 's1',
    model: 'claude-sonnet-5',
    usage: null,
    modelUsage: null,
    totalCostUsd: null,
  });

  const failure = normalizer.normalize({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: '',
    session_id: 's1',
  });
  assert.equal(failure[0].payload.isError, true);
  assert.equal(failure[0].payload.subtype, 'error_during_execution');
});

function assistantMessage(content, parentToolUseId = null) {
  return { type: 'assistant', parent_tool_use_id: parentToolUseId, message: { content } };
}

test('thinking on a complete assistant message becomes a thought', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize(assistantMessage([
    { type: 'thinking', thinking: 'Considering the options.' },
    { type: 'text', text: 'Here is the answer.' },
  ]));
  assert.equal(actions.length, 1, 'final tool-free text is the answer, not a thought');
  assert.equal(actions[0].channel, 'thought');
  assert.equal(actions[0].payload.text, 'Considering the options.');
  assert.equal(actions[0].payload.done, true);
});

test('streamed thinking and its complete message share one reasoningId', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { role: 'assistant' } },
  });
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  });
  const streamed = normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'half a thought' } },
  });
  const complete = normalizer.normalize(assistantMessage([
    { type: 'thinking', thinking: 'half a thought, now whole' },
    { type: 'text', text: 'Done.' },
  ]));

  // Same id → the server upserts the streamed thought instead of duplicating it.
  assert.equal(complete[0].payload.reasoningId, streamed[0].payload.reasoningId);
  assert.equal(streamed[0].payload.done, false);
  assert.equal(complete[0].payload.done, true);
  assert.equal(complete[0].payload.text, 'half a thought, now whole');
});

test('per-block complete assistant events reuse the streamed reasoningId for late thinking blocks', () => {
  // The SDK delivers the complete message one content block at a time — every
  // event carries the same message id and arrives BEFORE that block's
  // content_block_stop (verified against @anthropic-ai/claude-agent-sdk 0.3.220).
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'msg_01', role: 'assistant' } },
  });
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  });
  normalizer.normalize(streamTextDelta('Status update.'));
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking' } },
  });
  const streamed = normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'weighing the options' } },
  });
  normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_01', content: [{ type: 'text', text: 'Status update.' }] },
  });
  const complete = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_01', content: [{ type: 'thinking', thinking: 'weighing the options' }] },
  });
  const stopped = normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 1 },
  });

  // One id across all three frames → the server upserts a single relay_thought
  // row instead of inserting a duplicate for the complete-message republish.
  const streamedId = streamed[0].payload.reasoningId;
  assert.equal(complete[0].payload.reasoningId, streamedId);
  assert.equal(stopped[0].payload.reasoningId, streamedId);
});

test('per-block completes pair each thinking block with its streamed frames in order', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'msg_02', role: 'assistant' } },
  });
  const streamThinkingBlock = (index, thinking) => {
    normalizer.normalize({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', index, content_block: { type: 'thinking' } },
    });
    return normalizer.normalize({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } },
    });
  };
  const firstStreamed = streamThinkingBlock(0, 'first idea');
  const firstComplete = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_02', content: [{ type: 'thinking', thinking: 'first idea' }] },
  });
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 0 },
  });
  const secondStreamed = streamThinkingBlock(1, 'second idea');
  const secondComplete = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_02', content: [{ type: 'thinking', thinking: 'second idea' }] },
  });

  assert.equal(firstComplete[0].payload.reasoningId, firstStreamed[0].payload.reasoningId);
  assert.equal(secondComplete[0].payload.reasoningId, secondStreamed[0].payload.reasoningId);
  assert.notEqual(firstComplete[0].payload.reasoningId, secondComplete[0].payload.reasoningId);
});

test('empty thinking blocks still consume their pairing slot', () => {
  // Under the summarized-thinking display, a message can carry an empty raw
  // thinking block followed by the non-empty summary block (seen live with
  // opus: [thinking(len=0), thinking(len=113)]). The empty block emits no
  // thought, but it must still consume its slot in the streamed-id pairing —
  // otherwise the summary consumes the empty block's id while its own streamed
  // frames finalize under the next id, duplicating the thought row.
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { id: 'msg_05', role: 'assistant' } },
  });
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  });
  normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 1, content_block: { type: 'thinking' } },
  });
  const streamed = normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'the summary' } },
  });
  const emptyComplete = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_05', content: [{ type: 'thinking', thinking: '' }] },
  });
  const summaryComplete = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_05', content: [{ type: 'thinking', thinking: 'the summary' }] },
  });
  const stopped = normalizer.normalize({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_stop', index: 1 },
  });

  assert.equal(emptyComplete.length, 0, 'empty thinking emits nothing');
  const streamedId = streamed[0].payload.reasoningId;
  assert.equal(summaryComplete[0].payload.reasoningId, streamedId);
  assert.equal(stopped[0].payload.reasoningId, streamedId);
});

test('complete thinking without streamed frames still gets distinct ids per message', () => {
  // Partial frames can be unavailable; per-block completes for two different
  // messages must not collide even though each carries its block at index 0.
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_03', content: [{ type: 'thinking', thinking: 'first' }] },
  });
  const second = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_04', content: [{ type: 'thinking', thinking: 'second' }] },
  });
  assert.notEqual(first[0].payload.reasoningId, second[0].payload.reasoningId);
});

test('interim narration alongside tool calls becomes a thought', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize(assistantMessage([
    { type: 'text', text: 'Let me check the tests first.' },
    { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
  ]));
  const thought = actions.find((action) => action.channel === 'thought');
  assert.ok(thought, 'narration sharing a message with tool calls is a thought');
  assert.equal(thought.payload.text, 'Let me check the tests first.');
  assert.equal(thought.payload.done, true);
  assert.ok(actions.some((action) => action.channel === 'activity'), 'the tool call still reports activity');
});

test('consecutive assistant messages get distinct thought ids', () => {
  const normalizer = createSdkMessageNormalizer();
  const first = normalizer.normalize(assistantMessage([
    { type: 'thinking', thinking: 'first' },
    { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } },
  ]));
  const second = normalizer.normalize(assistantMessage([
    { type: 'thinking', thinking: 'second' },
    { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/b' } },
  ]));
  assert.notEqual(first[0].payload.reasoningId, second[0].payload.reasoningId);
});

test('subagent thinking and narration attribute to the subagent run', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize(assistantMessage([
    { type: 'thinking', thinking: 'subagent pondering' },
    { type: 'text', text: 'subagent narrating' },
    { type: 'tool_use', id: 'toolu_x', name: 'Grep', input: { pattern: 'todo' } },
  ], 'toolu_parent'));
  const thoughts = actions.filter((action) => action.channel === 'thought');
  assert.equal(thoughts.length, 2);
  for (const thought of thoughts) {
    assert.equal(thought.payload.subagentRunId, 'toolu_parent');
  }
  // Thread-scoped ids keep a subagent's blocks from colliding with the main thread's.
  const mainThread = createSdkMessageNormalizer().normalize(assistantMessage([
    { type: 'thinking', thinking: 'main pondering' },
    { type: 'tool_use', id: 'toolu_y', name: 'Grep', input: { pattern: 'todo' } },
  ]));
  assert.notEqual(thoughts[0].payload.reasoningId, mainThread[0].payload.reasoningId);
});

test('shouldEmitStreamUpdate mirrors the copilot gating', () => {
  assert.equal(shouldEmitStreamUpdate('a', ''), true);
  assert.equal(shouldEmitStreamUpdate('ab', 'a'), false);
  assert.equal(shouldEmitStreamUpdate('a'.repeat(30), 'a'), true);
  assert.equal(shouldEmitStreamUpdate('ab.', 'a'), true);
  assert.equal(shouldEmitStreamUpdate('same', 'same'), false);
  assert.equal(shouldEmitStreamUpdate('', 'prev'), false);
});

test('summarizeToolInput prefers meaningful fields and falls back to JSON', () => {
  assert.equal(summarizeToolInput('Read', { file_path: '/tmp/x' }), '/tmp/x');
  assert.equal(summarizeToolInput('Custom', { foo: 'bar' }), '{"foo":"bar"}');
  assert.equal(summarizeToolInput('Empty', {}), '');
});

test('phantom zero-work result from an orphaned-task resume is skipped', () => {
  // A resumed session with orphaned background tasks emits a bookkeeping
  // result (num_turns 0, duration_api_ms 0) before the real turn. Emitting a
  // result action for it would make the runner close the input gate and kill
  // the control transport, so every later permission request fails with
  // "AbortError: Stream closed".
  const normalizer = createSdkMessageNormalizer();
  const phantom = normalizer.normalize({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 0,
    duration_api_ms: 0,
    result: '',
    session_id: 's1',
    total_cost_usd: 0,
  });
  assert.deepEqual(phantom, []);

  const real = normalizer.normalize({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 2,
    duration_api_ms: 5173,
    result: 'Done.',
    session_id: 's1',
  });
  assert.equal(real.length, 1);
  assert.equal(real[0].channel, 'result');
  assert.equal(real[0].payload.text, 'Done.');
});

test('zero-turn error results still map to result actions', () => {
  const normalizer = createSdkMessageNormalizer();
  const failure = normalizer.normalize({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    num_turns: 0,
    duration_api_ms: 0,
    result: '',
    session_id: 's1',
  });
  assert.equal(failure.length, 1);
  assert.equal(failure[0].payload.isError, true);
});

test('task_notification system messages surface as settled edge plus activity', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    status: 'stopped',
    summary: 'No completion record was found for this background shell command.',
  });
  assert.equal(actions.length, 2);
  assert.equal(actions[0].channel, 'background_task_settled');
  assert.deepEqual(actions[0].payload, { taskId: 'task-1', status: 'stopped' });
  assert.equal(actions[1].channel, 'activity');
  assert.match(actions[1].payload.text, /Background task task-1 stopped/);
});

test('background_tasks_changed maps the live set with replace semantics', () => {
  const normalizer = createSdkMessageNormalizer();
  const populated = normalizer.normalize({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [
      { task_id: 'agent-1', task_type: 'local_agent', description: 'Implement feature' },
      { task_id: '', task_type: 'local_bash', description: 'id-less entry is dropped' },
    ],
    session_id: 's1',
  });
  assert.equal(populated.length, 1);
  assert.equal(populated[0].channel, 'background_tasks');
  assert.deepEqual(populated[0].payload.tasks, [
    { taskId: 'agent-1', taskType: 'local_agent', description: 'Implement feature' },
  ]);

  const emptied = normalizer.normalize({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [],
    session_id: 's1',
  });
  assert.deepEqual(emptied, [{ channel: 'background_tasks', payload: { tasks: [] } }]);
});

// ---------------------------------------------------------------------------
// Per-block delivery correctness (2026-08-16 review)

test('narration demotion works across per-block assistant events sharing one message id', () => {
  const normalizer = createSdkMessageNormalizer();
  // One API message, delivered one block per event (the real SDK shape):
  // text first, then a tool_use — the text is interim narration.
  const textActions = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_A', content: [{ type: 'text', text: 'Let me check the file first.' }] },
  });
  assert.equal(textActions.length, 0, 'text buffers until the message proves itself narration or answer');
  const toolActions = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/x' } }] },
  });
  const narration = toolActions.find((action) => action.channel === 'thought');
  assert.ok(narration, 'the buffered text becomes a narration thought once the tool_use lands');
  assert.equal(narration.payload.text, 'Let me check the file first.');
  // A later text block in the same (tool-bearing) message demotes immediately.
  const followUp = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_A', content: [{ type: 'text', text: 'Now writing the fix.' }] },
  });
  assert.equal(followUp.filter((action) => action.channel === 'thought').length, 1);
  // The next message's lone text block is the answer — never a thought.
  const answer = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_B', content: [{ type: 'text', text: 'All done: the file is fixed.' }] },
  });
  assert.equal(answer.filter((action) => action.channel === 'thought').length, 0);
});

test('the live stream resets at each message boundary instead of concatenating', () => {
  const normalizer = createSdkMessageNormalizer();
  const longNarration = 'Let me look into the failing test before answering properly.';
  normalizer.normalize({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_A' } } });
  normalizer.normalize({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: longNarration } } });
  normalizer.normalize({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_B' } } });
  const answerDelta = 'The answer is forty-two, with confidence.';
  const actions = normalizer.normalize({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answerDelta } } });
  const stream = actions.find((action) => action.channel === 'stream');
  assert.ok(stream);
  assert.equal(stream.payload.text, answerDelta, 'the second message streams alone, not appended to the first');
  assert.equal(normalizer.finalStreamText(), answerDelta);
});

test('redacted thinking surfaces as a placeholder instead of vanishing', () => {
  const normalizer = createSdkMessageNormalizer();
  const actions = normalizer.normalize({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_R', content: [{ type: 'redacted_thinking', data: 'ENCRYPTED' }] },
  });
  const thought = actions.find((action) => action.channel === 'thought');
  assert.ok(thought);
  assert.match(thought.payload.text, /redacted/i);
});

test('a model refusal fallback updates the turn model and surfaces the notice', () => {
  const normalizer = createSdkMessageNormalizer();
  normalizer.normalize({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-fable-5' });
  const actions = normalizer.normalize({
    type: 'system',
    subtype: 'model_refusal_fallback',
    direction: 'retry',
    scope: 'session',
    originalModel: 'claude-fable-5',
    fallbackModel: 'claude-opus-4-8',
    content: 'Safeguards flagged this message. Switched to Opus 4.8.',
  });
  assert.deepEqual(actions[0], { channel: 'init', payload: { sessionId: 'sess-1', model: 'claude-opus-4-8' } });
  assert.equal(actions[1].channel, 'activity');
  assert.match(actions[1].payload.text, /Switched to Opus 4.8/);
  // The turn's result now reports the model that actually produced it.
  const [result] = normalizer.normalize({
    type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1', num_turns: 1, duration_api_ms: 5,
  });
  assert.equal(result.payload.model, 'claude-opus-4-8');
});
