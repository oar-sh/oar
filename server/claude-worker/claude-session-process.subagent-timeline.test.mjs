import test from 'node:test';
import assert from 'node:assert/strict';

import { createSubagentTimelineRecorder } from './subagent-timeline-recorder.mjs';
import {
  waitFor,
  makeApiStub,
  scriptedTurn,
  initMessage,
  resultMessage,
  backgroundTasksMessage,
  userReplay,
  assistantText,
  baseMessage,
  makeRunner,
} from './claude-session-test-harness.mjs';

// A background agent outlives the turn that spawned it. Its frames arrive
// between turns and during the next turn; they must reach its own run's
// timeline and never the later turn's lanes.

const RUN = 'toolu_fixture_background';

function spawnFrame() {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg-main-1', content: [{ type: 'tool_use', id: RUN, name: 'Agent', input: { description: 'Survey the widget parser', subagent_type: 'general-purpose', prompt: 'Look.' } }] },
  };
}

function launchReceipt() {
  return {
    type: 'user',
    parent_tool_use_id: null,
    tool_use_result: { status: 'async_launched', agentId: 'agent-fixture' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: RUN, content: 'Async agent launched successfully.' }] },
  };
}

const subThinking = (text, id) => ({ type: 'assistant', parent_tool_use_id: RUN, message: { id, model: 'claude-fixture-model', content: [{ type: 'thinking', thinking: text }] } });
const subText = (text, id) => ({ type: 'assistant', parent_tool_use_id: RUN, message: { id, model: 'claude-fixture-model', content: [{ type: 'text', text }] } });

test('a background agent\'s frames go to its own run, between turns and during a later turn', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const recorder = createSubagentTimelineRecorder({ api: stub.api, conversationId: 'conv-1', flushIntervalMs: 5, writerId: 'w' });
  const runner = makeRunner({ stub, startImpl: () => turn, subagentTimelineRecorder: recorder });

  // Turn 1 spawns the agent in the background and ends.
  const first = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-1', text: 'hello' } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(spawnFrame());
  turn.emit({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: RUN, subagent_type: 'general-purpose', is_backgrounded: true });
  turn.emit(backgroundTasksMessage([{ task_id: 'task-1', task_type: 'local_agent', description: 'Survey the widget parser' }]));
  turn.emit(launchReceipt());
  turn.emit(subThinking('Starting with the parser.', 'msg-sub-1'));
  turn.emit(assistantText('I started a background agent.'));
  turn.emit(resultMessage('I started a background agent.', 'native-1'));
  await first;
  await waitFor(() => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1'), { label: 'turn 1 response' });

  const spawnPost = stub.calls.filter((call) => call.routePath === '/api/subagent-run' && call.body.subagentRunId === RUN);
  assert.ok(spawnPost.length >= 2);
  assert.equal(spawnPost[0].body.timelineOwner, 'worker');
  assert.equal(spawnPost.at(-1).body.status, 'running', 'the launch receipt does not end the run');
  assert.equal(spawnPost.at(-1).body.background, true);

  // Between turns: nothing to publish on a lane, but the run records it.
  turn.emit(subThinking('The parser has two entry points.', 'msg-sub-2'));

  // Turn 2 runs while the agent keeps working.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'next' } });
  await waitFor(() => turn.pushed.length >= 2, { label: 'turn 2 pushed' });
  turn.emit(userReplay('next'));
  turn.emit({ type: 'assistant', parent_tool_use_id: RUN, message: { id: 'msg-sub-3a', model: 'claude-fixture-model', content: [{ type: 'tool_use', id: 'toolu_grep_1', name: 'Grep', input: { pattern: 'tokenize' } }] } });
  turn.emit(subText('Both entry points share one tokenizer.', 'msg-sub-3'));
  turn.emit({ type: 'system', subtype: 'task_notification', task_id: 'task-1', tool_use_id: RUN, status: 'completed', summary: 'Found the shared tokenizer', usage: { total_tokens: 2048 } });
  turn.emit(assistantText('Noted.'));
  turn.emit(resultMessage('Noted.', 'native-1'));
  await second;
  await waitFor(() => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'), { label: 'turn 2 response' });
  await recorder.flush();

  // No lane write of turn 2 carries the earlier turn's agent.
  const laneWrites = stub.calls.filter((call) => ['/api/stream', '/api/thought', '/api/activity', '/api/subagent-run'].includes(call.routePath)
    && call.body.messageId === 'q-2' && call.body.subagentRunId === RUN);
  assert.deepEqual(laneWrites, []);

  // The run's own timeline has all of it, in order, and its end.
  const timeline = stub.calls.filter((call) => call.routePath === '/api/subagent-timeline' && call.body.subagentRunId === RUN);
  const byKey = new Map();
  for (const call of timeline) for (const entry of call.body.entries) byKey.set(entry.key, entry);
  assert.deepEqual([...byKey.values()].map((entry) => [entry.kind, entry.text]), [
    ['thought', 'Starting with the parser.'],
    ['thought', 'The parser has two entry points.'],
    ['tool_call', '{\n  "pattern": "tokenize"\n}'],
    ['text', 'Both entry points share one tokenizer.'],
    ['note', 'Finished: Found the shared tokenizer'],
  ]);
  const lastHeader = timeline.map((call) => call.body.header).filter(Boolean).at(-1);
  assert.equal(lastHeader.status, 'completed');
  assert.equal(lastHeader.totalTokens, 2048);
  assert.ok(timeline.every((call) => !('messageId' in call.body)), 'run-scoped: no turn named');

  turn.endInput();
});
