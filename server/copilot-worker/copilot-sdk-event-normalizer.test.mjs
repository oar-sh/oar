import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCopilotEventNormalizer,
  formatToolActivityText,
  isSubagentEvent,
  summarizeToolInput,
} from './copilot-sdk-event-normalizer.mjs';
import { loadFixture } from './copilot-sdk-test-harness.mjs';

/** Replay a whole fixture and collect every action, in order. */
function run(events) {
  const normalizer = createCopilotEventNormalizer();
  const actions = [];
  for (const event of events) {
    for (const action of normalizer.normalize(event)) actions.push(action);
  }
  return { normalizer, actions };
}

const channels = (actions) => actions.map((a) => a.channel);
const only = (actions, channel) => actions.filter((a) => a.channel === channel);
const terminal = (actions) => only(actions, 'result')[0]?.payload || null;

test('happy turn: init, streamed text, and one completed result', () => {
  const { actions, normalizer } = run(loadFixture('happy-turn'));

  const init = only(actions, 'init')[0];
  assert.equal(init.payload.resumed, false);
  assert.equal(init.payload.model, 'gpt-5-mini');
  assert.ok(init.payload.sessionId);

  const streams = only(actions, 'stream');
  assert.ok(streams.length >= 1, 'deltas should publish stream updates');
  assert.equal(streams.every((s) => s.payload.done === false), true);
  // Monotonic growth: every emission extends the previous one.
  for (let i = 1; i < streams.length; i += 1) {
    assert.ok(streams[i].payload.text.startsWith(streams[i - 1].payload.text));
  }

  const result = terminal(actions);
  assert.equal(result.isError, false);
  assert.equal(result.aborted, false);
  assert.equal(result.subtype, 'completed');
  assert.equal(result.text, normalizer.finalStreamText());
  // The durable assistant.message is authoritative over the delta accumulation.
  assert.equal(result.text, 'SPIKE_OK');
  // The emit gating deliberately suppresses the tail of a short answer, so the
  // last streamed text can lag the final text — which is exactly why the
  // session process always publishes a final `done` stream from the result.
  assert.ok(result.text.startsWith(streams[streams.length - 1].payload.text));

  assert.equal(result.usage.modelCalls, 1);
  assert.ok(result.usage.outputTokens >= 0);
  assert.ok(Number.isFinite(result.usage.timeToFirstTokenMs));
  assert.ok(result.contextUsage.tokenLimit > 0);
});

test('exactly one result action is emitted per turn', () => {
  for (const name of ['happy-turn', 'abort-turn', 'quota-turn', 'reasoning-turn', 'tool-permission-turn']) {
    const { actions } = run(loadFixture(name));
    assert.equal(only(actions, 'result').length, 1, `${name} should terminate exactly once`);
  }
});

test('reasoning turn: streaming thoughts close on the durable reasoning event', () => {
  const { actions } = run(loadFixture('reasoning-turn'));
  const thoughts = only(actions, 'thought');
  assert.ok(thoughts.length >= 2);

  const open = thoughts.filter((t) => t.payload.done === false);
  const closed = thoughts.filter((t) => t.payload.done === true);
  assert.ok(open.length >= 1);
  assert.equal(closed.length, 1);

  // One reasoning id for the whole thought, namespaced away from other
  // providers' ids, and the text only ever grows.
  const ids = new Set(thoughts.map((t) => t.payload.reasoningId));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^copilot-thought-/);
  assert.ok(closed[0].payload.text.startsWith(open[0].payload.text));

  // Reasoning never leaks into the answer.
  const result = terminal(actions);
  assert.equal(result.isError, false);
  assert.ok(!result.text.includes(closed[0].payload.text));
});

test('tool turn: execution start becomes an activity row and turn_end is not terminal', () => {
  const events = loadFixture('tool-permission-turn');
  const { actions } = run(events);

  const activities = only(actions, 'activity').map((a) => a.payload.text);
  assert.ok(activities.some((text) => text.startsWith('Tool (bash): echo ')), activities.join(' | '));
  assert.ok(activities.some((text) => text.startsWith('Permission approved: echo ')), activities.join(' | '));

  // This fixture has TWO assistant.turn_end events (one per model call) and a
  // single session.idle: the turn must survive the first turn_end.
  assert.equal(events.filter((e) => e.type === 'assistant.turn_end').length, 2);
  const result = terminal(actions);
  assert.equal(result.subtype, 'completed');
  assert.ok(result.text.length > 0);
  // Both model calls are billed to the one turn.
  assert.equal(result.usage.modelCalls, 2);
});

test('tool turn: the noisy event families produce no actions', () => {
  const events = loadFixture('tool-permission-turn');
  const noisy = events.filter((event) => [
    'session.background_tasks_changed',
    'pending_messages.modified',
    'assistant.streaming_delta',
    'assistant.tool_call_delta',
    'tool.execution_partial_result',
    'sandbox.decision',
    'model.tool_execution',
    'model.message',
  ].includes(event.type));
  assert.ok(noisy.length >= 25, 'fixture should carry the real event noise');

  const normalizer = createCopilotEventNormalizer();
  for (const event of noisy) assert.deepEqual(normalizer.normalize(event), []);
});

test('abort turn: partial delta text survives and the result is flagged aborted', () => {
  const events = loadFixture('abort-turn');
  // The runtime emits no assistant.message on abort — the only record of the
  // partial answer is the deltas the normalizer buffered.
  assert.equal(events.some((e) => e.type === 'assistant.message'), false);

  const { actions } = run(events);
  const result = terminal(actions);
  assert.equal(result.aborted, true);
  assert.equal(result.isError, false);
  assert.equal(result.subtype, 'aborted');
  assert.ok(result.text.length > 0, 'partial streamed text must be preserved');

  const streams = only(actions, 'stream');
  assert.equal(result.text, streams[streams.length - 1].payload.text);
});

test('abort turn: session.idle carries the aborted flag even without the abort event', () => {
  const events = loadFixture('abort-turn').filter((event) => event.type !== 'abort');
  const result = terminal(run(events).actions);
  assert.equal(result.aborted, true);
});

test('quota turn: session.error terminates a turn that never reaches idle', () => {
  const events = loadFixture('quota-turn');
  // The hazard this guards: a quota-failed turn produces no idle at all.
  assert.equal(events.some((e) => e.type === 'session.idle'), false);

  const { actions } = run(events);
  const result = terminal(actions);
  assert.equal(result.isError, true);
  assert.equal(result.subtype, 'quota');
  assert.match(result.errorMessage, /exceeded your monthly quota/);
  assert.equal(result.errorData.statusCode, 402);
  assert.equal(result.errorData.errorCode, 'quota_exceeded');
  // model.call_failure fires just before the error and carries the snapshots
  // the usage card wants.
  assert.ok(result.usage.quotaSnapshots.premium_interactions);
});

test('resume turn: the init action reports the resumed session and its event count', () => {
  const { actions } = run(loadFixture('resume-turn'));
  const resumeInit = only(actions, 'init').find((a) => a.payload.resumed);
  assert.ok(resumeInit, 'session.resume should publish an init action');
  assert.ok(resumeInit.payload.eventCount > 0);
  assert.equal(resumeInit.payload.model, 'gpt-5-mini');
  // `session.resume` carries no sessionId (unlike `session.start`) — the id
  // the caller supplied is the id, so there is nothing to re-learn here.
  assert.equal(resumeInit.payload.sessionId, '');

  // session.shutdown (twice in this fixture, from the pre-resume disconnect)
  // is not a failure: a graceful disconnect must not fail the next turn.
  const result = terminal(actions);
  assert.equal(result.isError, false);
  assert.equal(result.subtype, 'completed');
});

test('ask_user turn: the unforwardable question is surfaced as an activity row', () => {
  const { actions } = run(loadFixture('ask-user-turn'));
  const activities = only(actions, 'activity').map((a) => a.payload.text);
  assert.ok(
    activities.some((text) => text.startsWith('Copilot asked a question the SDK worker cannot forward yet:')),
    activities.join(' | '),
  );
  assert.ok(activities.some((text) => text.startsWith('Tool (ask_user):')), activities.join(' | '));
});

test('no fixture produces a subagent action (the SDK has no attribution yet)', () => {
  for (const name of ['happy-turn', 'tool-permission-turn', 'ask-user-turn', 'reasoning-turn']) {
    const { actions, normalizer } = run(loadFixture(name));
    assert.equal(only(actions, 'subagent').length, 0, name);
    assert.deepEqual(normalizer.activeSubagentRuns(), []);
  }
});

test('a failed tool execution publishes a failure activity naming the tool', () => {
  const normalizer = createCopilotEventNormalizer();
  normalizer.normalize({
    type: 'tool.execution_start',
    data: { toolCallId: 'call_1', toolName: 'bash', arguments: { command: 'false' } },
  });
  const actions = normalizer.normalize({
    type: 'tool.execution_complete',
    data: { toolCallId: 'call_1', success: false, error: { message: 'permission host rejected', code: 'failure' } },
  });
  assert.deepEqual(actions, [{
    channel: 'activity',
    payload: { text: 'Tool failed (bash): permission host rejected', subagentRunId: null },
  }]);
});

test('a session.error after a session.idle cannot publish a second result', () => {
  const normalizer = createCopilotEventNormalizer();
  assert.equal(normalizer.normalize({ type: 'session.idle', data: { mode: 'interactive' } }).length, 1);
  assert.deepEqual(normalizer.normalize({ type: 'session.error', data: { errorType: 'quota' } }), []);
});

test('session.model_change updates the model reported with the result', () => {
  const normalizer = createCopilotEventNormalizer();
  normalizer.normalize({ type: 'session.start', data: { sessionId: 's1', selectedModel: 'gpt-5-mini' } });
  const actions = normalizer.normalize({
    type: 'session.model_change',
    data: { newModel: 'claude-sonnet-5', previousModel: 'gpt-5-mini' },
  });
  assert.equal(actions[0].payload.model, 'claude-sonnet-5');
  assert.equal(normalizer.model, 'claude-sonnet-5');
});

test('multi-message turns join their non-empty assistant messages in order', () => {
  const normalizer = createCopilotEventNormalizer();
  const emit = (event) => normalizer.normalize(event);
  emit({ type: 'assistant.message_start', data: { messageId: 'm1' } });
  // The tool-call message has empty content and must contribute nothing.
  emit({ type: 'assistant.message', data: { messageId: 'm1', content: '', toolRequests: [{ toolCallId: 'c1' }] } });
  emit({ type: 'assistant.message_start', data: { messageId: 'm2' } });
  emit({ type: 'assistant.message_delta', data: { messageId: 'm2', deltaContent: 'second' } });
  emit({ type: 'assistant.message', data: { messageId: 'm2', content: 'second answer' } });
  assert.equal(normalizer.finalStreamText(), 'second answer');
});

test('a long answer streams incrementally as the deltas arrive', () => {
  const normalizer = createCopilotEventNormalizer();
  const actions = [];
  normalizer.normalize({ type: 'assistant.message_start', data: { messageId: 'm1' } });
  for (let i = 0; i < 6; i += 1) {
    for (const action of normalizer.normalize({
      type: 'assistant.message_delta',
      data: { messageId: 'm1', deltaContent: `sentence number ${i} of the answer. ` },
    })) actions.push(action);
  }
  const streams = only(actions, 'stream');
  assert.equal(streams.length, 6);
  for (let i = 1; i < streams.length; i += 1) {
    assert.ok(streams[i].payload.text.startsWith(streams[i - 1].payload.text));
  }
});

test('thought text is capped at 16k characters', () => {
  const normalizer = createCopilotEventNormalizer();
  const actions = normalizer.normalize({
    type: 'assistant.reasoning_delta',
    data: { reasoningId: 'r1', deltaContent: 'x'.repeat(20_000) },
  });
  assert.equal(actions[0].payload.text.length, 16 * 1024);
});

test('malformed and unknown events are inert', () => {
  const normalizer = createCopilotEventNormalizer();
  for (const event of [null, undefined, 'nope', 42, {}, { type: 'future.event', data: { a: 1 } }]) {
    assert.deepEqual(normalizer.normalize(event), []);
  }
});

test('summarizeToolInput prefers the human-readable argument', () => {
  assert.equal(summarizeToolInput({ command: 'ls -al', cwd: '/tmp' }), 'ls -al');
  assert.equal(summarizeToolInput({ question: 'which env?' }), 'which env?');
  assert.equal(summarizeToolInput({}), '');
  assert.equal(summarizeToolInput(null), '');
  assert.equal(summarizeToolInput({ weird: 1 }), 'weird=1');
});

test('the summarize fallback never walks an unbounded input', () => {
  // The row is truncated to 140 characters anyway; a tool called with a
  // megabyte of file contents must not be serialized in full to produce it.
  const huge = { blob: 'x'.repeat(500_000), rows: new Array(10_000).fill('y'), nested: { a: 1 } };
  const summary = summarizeToolInput(huge);
  assert.ok(summary.length < 600, `unbounded summary: ${summary.length}`);
  assert.match(summary, /^blob=x+…$/, 'the first value alone exhausts the budget');
  // Collections are counted, never expanded.
  assert.match(summarizeToolInput({ rows: new Array(10_000).fill('y') }), /^rows=\[10000 items\]$/);
  assert.equal(summarizeToolInput({ nested: { a: 1 }, ok: true }), 'nested={…} ok=true');
});

test('formatToolActivityText degrades without arguments', () => {
  assert.equal(formatToolActivityText('bash', { command: 'ls' }), 'Tool (bash): ls');
  assert.equal(formatToolActivityText('bash', null), 'Tool (bash)');
  assert.equal(formatToolActivityText('', null), 'Tool (tool)');
  assert.equal(formatToolActivityText('bash', { command: 'x'.repeat(300) }).length, 140);
});

test('subagent-tagged assistant and reasoning events never reach the main channels', () => {
  // `agentId` sits on the event ENVELOPE and is absent for the root agent.
  // The runtime forwards subagent streaming by default and the flag that
  // suppresses it also collapses the PARENT's tool-call streaming (verified
  // against runtime 1.0.82), so the filter has to live here.
  assert.equal(isSubagentEvent({ agentId: 'agent-7' }), true);
  assert.equal(isSubagentEvent({ agentId: '' }), false);
  assert.equal(isSubagentEvent({}), false);

  const normalizer = createCopilotEventNormalizer();
  normalizer.normalize({ type: 'assistant.message_start', data: { messageId: 'm1' } });
  normalizer.normalize({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'main answer' } });

  // A subagent's whole inner turn — hosted subagents emit no deltas at all,
  // their text arrives as one agentId-tagged assistant.message.
  assert.deepEqual(normalizer.normalize({
    type: 'assistant.message',
    agentId: 'agent-7',
    data: { messageId: 'sub-1', content: 'the subagent private notes' },
  }), []);
  assert.deepEqual(normalizer.normalize({
    type: 'assistant.reasoning_delta',
    agentId: 'agent-7',
    data: { reasoningId: 'sub-r1', deltaContent: 'subagent thinking' },
  }), []);

  assert.equal(normalizer.finalStreamText(), 'main answer');
});

test('subagent lifecycle events — documented or not — are inert, never noisy', () => {
  const normalizer = createCopilotEventNormalizer();
  for (const type of ['subagent.started', 'subagent.configured', 'subagent.completed', 'subagent.failed']) {
    // `subagent.configured` is undocumented (in no published schema) and was
    // only found by a live probe: an unknown event type must be ordinary.
    assert.deepEqual(normalizer.normalize({ type, agentId: 'agent-7', data: { agentName: 'explorer' } }), [], type);
  }
});

test('an empty authoritative assistant.message does not wipe the accumulated deltas', () => {
  // The tool-request message is documented to arrive with empty content;
  // letting it overwrite would blank an answer the user already watched
  // stream in.
  const normalizer = createCopilotEventNormalizer();
  normalizer.normalize({ type: 'assistant.message_start', data: { messageId: 'm1' } });
  normalizer.normalize({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'a real answer' } });
  normalizer.normalize({ type: 'assistant.message', data: { messageId: 'm1', toolRequests: [{ toolCallId: 'c1' }] } });
  assert.equal(normalizer.finalStreamText(), 'a real answer');

  normalizer.normalize({ type: 'assistant.message', data: { messageId: 'm1', content: '' } });
  assert.equal(normalizer.finalStreamText(), 'a real answer');

  // A message that DOES carry content is still authoritative over the deltas.
  normalizer.normalize({ type: 'assistant.message', data: { messageId: 'm1', content: 'the durable answer' } });
  assert.equal(normalizer.finalStreamText(), 'the durable answer');
});

test('reasoning deltas are gated like the stream channel', () => {
  const normalizer = createCopilotEventNormalizer();
  const emit = (deltaContent) => normalizer.normalize({
    type: 'assistant.reasoning_delta',
    data: { reasoningId: 'r1', deltaContent },
  });
  assert.equal(emit('thinking about it').length, 1);
  // A single extra character is below the gate (and not a sentence boundary,
  // which would flush it).
  assert.equal(emit('x').length, 0, 'sub-threshold growth must not publish');
  assert.equal(emit(` ${'x'.repeat(30)}`).length, 1);
});

test('a capped thought stops re-publishing identical text', () => {
  const normalizer = createCopilotEventNormalizer();
  const emit = (deltaContent) => normalizer.normalize({
    type: 'assistant.reasoning_delta',
    data: { reasoningId: 'r1', deltaContent },
  });
  assert.equal(emit('x'.repeat(20_000))[0].payload.text.length, 16 * 1024);
  // Past the cap the text can never change again, so nothing more is sent.
  for (let i = 0; i < 5; i += 1) assert.deepEqual(emit('x'.repeat(1_000)), []);
});

test('an empty reasoning event publishes no thought at all', () => {
  // Hosted models return encrypted reasoning: the events fire with no text.
  const normalizer = createCopilotEventNormalizer();
  assert.deepEqual(normalizer.normalize({
    type: 'assistant.reasoning_delta',
    data: { reasoningId: 'r1', deltaContent: '' },
  }), []);
  assert.deepEqual(normalizer.normalize({
    type: 'assistant.reasoning',
    data: { reasoningId: 'r1', content: '' },
  }), []);
});

test('a long streamed answer composes in linear time, not quadratic', () => {
  // The prefix of closed messages is cached; only the newest message's text is
  // appended per delta.
  const normalizer = createCopilotEventNormalizer();
  for (let message = 0; message < 40; message += 1) {
    normalizer.normalize({ type: 'assistant.message_start', data: { messageId: `m${message}` } });
    for (let delta = 0; delta < 40; delta += 1) {
      normalizer.normalize({
        type: 'assistant.message_delta',
        data: { messageId: `m${message}`, deltaContent: `chunk ${delta} ` },
      });
    }
  }
  const text = normalizer.finalStreamText();
  // Ordering across messages is preserved, which is the property the cache
  // must not break.
  assert.ok(text.startsWith('chunk 0 chunk 1 '));
  assert.equal(text.split('\n\n').length, 40);
  assert.ok(text.endsWith('chunk 39 '));
});
