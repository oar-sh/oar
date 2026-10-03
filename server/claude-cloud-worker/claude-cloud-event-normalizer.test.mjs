import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createClaudeCloudEventNormalizer,
  isInterruptedCloudResult,
  readCloudResult,
  readCloudSessionUsage,
  toCloudSequence,
} from './claude-cloud-event-normalizer.mjs';
import {
  MODEL,
  SESSION_URL,
  assistantText,
  assistantThinking,
  assistantToolUse,
  branchPushed,
  cloudEvent,
  cloudSession,
  sandboxLog,
  sessionInit,
  stoppedResult,
  toolRequest,
  toolResponse,
  toolResult,
  turnResult,
  userPrompt,
} from './claude-cloud-test-harness.mjs';

const activityTexts = (actions) => actions.filter((action) => action.channel === 'activity').map((action) => action.payload.text);

test('sandbox log lines become short activity rows: steps that begin, no completions, no repeats', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const lines = [
    sandboxLog(2, 'Allocating sandbox'),
    sandboxLog(3, 'Launching the agent from its install directory', null),
    sandboxLog(4, 'Environment runner started', 'completed'),
    sandboxLog(5, 'Fetching repository example-org/sample-repo'),
    sandboxLog(6, 'Fetching repository example-org/sample-repo', 'completed'),
    sandboxLog(7, 'No setup script configured', 'skipped'),
    sandboxLog(8, 'Starting Claude Code'),
    sandboxLog(9, 'Starting Claude Code'),
    sandboxLog(10, 'Clone failed, trying again', null, 'warn'),
  ].flatMap((event) => normalizer.normalize(event));

  assert.deepEqual(activityTexts(lines), [
    'Cloud: Allocating sandbox',
    'Cloud: Fetching repository example-org/sample-repo',
    'Cloud: No setup script configured',
    'Cloud: Starting Claude Code',
    'Cloud: Clone failed, trying again',
  ]);
});

test('system/init names the model and says where the agent runs', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const actions = normalizer.normalize(sessionInit(14));

  assert.deepEqual(actions[0], { channel: 'init', payload: { model: MODEL } });
  assert.deepEqual(activityTexts(actions), [`Claude Code running in the cloud (model ${MODEL})`]);
  assert.equal(normalizer.model, MODEL);
});

test('text blocks accumulate in order with a blank line between them; subagent text stays out', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const first = normalizer.normalize(assistantText(15, 'Reading the repository.'));
  const subagent = assistantText(16, 'Subagent report.');
  subagent.payload.parent_tool_use_id = 'toolu_example_parent';
  const nested = normalizer.normalize(subagent);
  const second = normalizer.normalize(assistantText(17, 'The licence file is in place.'));

  assert.deepEqual(first, [{ channel: 'stream', payload: { text: 'Reading the repository.', done: false, subagentRunId: null } }]);
  assert.deepEqual(nested, []);
  assert.equal(second[0].payload.text, 'Reading the repository.\n\nThe licence file is in place.');
  assert.equal(normalizer.streamText(), 'Reading the repository.\n\nThe licence file is in place.');
});

test('thinking becomes a thought whose id survives a replay of the same event', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const [thought] = normalizer.normalize(assistantThinking(21, 'The file is missing; add it.'));
  const [replayed] = createClaudeCloudEventNormalizer().normalize(assistantThinking(21, 'The file is missing; add it.'));

  assert.equal(thought.channel, 'thought');
  assert.equal(thought.payload.text, 'The file is missing; add it.');
  assert.equal(thought.payload.done, true);
  assert.equal(thought.payload.reasoningId, replayed.payload.reasoningId);
  assert.notEqual(
    thought.payload.reasoningId,
    normalizer.normalize(assistantThinking(22, 'Next thought.'))[0].payload.reasoningId,
  );
});

test('tool calls and failed tool results become activity rows; subagents are tracked', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const bash = normalizer.normalize(assistantToolUse(15, 'Bash', { command: 'ls -la' }));
  const task = normalizer.normalize(assistantToolUse(16, 'Task', { description: 'Check the docs' }, 'toolu_example_task'));
  const failed = normalizer.normalize(toolResult(17, 'toolu_example_15', { isError: true, content: 'exit code 2' }));
  const settled = normalizer.normalize(toolResult(18, 'toolu_example_task'));
  const quiet = normalizer.normalize(toolResult(19, 'toolu_example_other'));

  assert.deepEqual(activityTexts(bash), ['Tool (Bash): ls -la']);
  assert.deepEqual(task[0], {
    channel: 'subagent',
    payload: { subagentRunId: 'toolu_example_task', parentSubagentId: null, displayName: 'Check the docs', status: 'running' },
  });
  assert.deepEqual(activityTexts(failed), ['Tool failed: exit code 2']);
  assert.equal(settled[0].payload.status, 'completed');
  assert.deepEqual(quiet, []);
});

test('a push is an activity row and a push action; other vcs changes are nothing', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const pushed = normalizer.normalize(branchPushed(30, 'feature/licence'));
  const other = branchPushed(31, 'feature/licence');
  other.payload.kind = 'checkout';

  assert.deepEqual(activityTexts(pushed), ['Cloud: pushed branch feature/licence']);
  assert.deepEqual(pushed.at(-1), { channel: 'push', payload: { branch: 'feature/licence' } });
  assert.deepEqual(normalizer.normalize(other), []);
});

test('only the agent\'s can_use_tool requests ask the user; client requests are ignored', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const input = { questions: [{ question: 'Which colour?', options: [{ label: 'Blue' }, { label: 'Green' }] }] };
  const asked = normalizer.normalize(toolRequest(16, { requestId: 'request-1', toolName: 'AskUserQuestion', input }));
  const fromClient = normalizer.normalize(cloudEvent(1, {
    type: 'control_request', request_id: 'request-0', request: { subtype: 'set_permission_mode', mode: 'auto' },
  }, 'client'));
  const echoed = normalizer.normalize(toolRequest(17, { requestId: 'request-2', toolName: 'Bash', input: {}, source: 'client' }));
  const settled = normalizer.normalize(toolResponse(18, 'request-1'));

  assert.equal(asked.length, 1);
  assert.equal(asked[0].channel, 'permission');
  assert.equal(asked[0].payload.requestId, 'request-1');
  assert.equal(asked[0].payload.toolName, 'AskUserQuestion');
  assert.deepEqual(asked[0].payload.input, input);
  assert.deepEqual(fromClient, []);
  assert.deepEqual(echoed, []);
  assert.deepEqual(settled, [{ channel: 'permission_settled', payload: { requestId: 'request-1' } }]);
});

test('a usage limit shows once per change of status; "allowed" is silent', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const limit = (sequence, status) => cloudEvent(sequence, {
    type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1_800_000_000, rateLimitType: 'five_hour' },
  });

  assert.deepEqual(normalizer.normalize(limit(16, 'allowed')), []);
  assert.deepEqual(activityTexts(normalizer.normalize(limit(17, 'rejected'))), [
    'Claude usage limit reached, resets 2027-01-15T08:00:00Z',
  ]);
  assert.deepEqual(normalizer.normalize(limit(18, 'rejected')), []);
});

test('the prompt, the turn result and unknown events produce no actions', () => {
  const normalizer = createClaudeCloudEventNormalizer();

  assert.deepEqual(normalizer.normalize(userPrompt(1, 'Add a licence file')), []);
  assert.deepEqual(normalizer.normalize(turnResult(25, { result: 'Done.' })), []);
  assert.deepEqual(normalizer.normalize(cloudEvent(12, { type: 'active_goal', value: null })), []);
  assert.deepEqual(normalizer.normalize({ event_type: 'user' }), []);
  assert.deepEqual(normalizer.normalize(null), []);
});

test('readCloudResult tells a finished turn, a failed one and a stopped one apart', () => {
  const done = readCloudResult(turnResult(25, { result: ' Done. ' }).payload);
  const failed = readCloudResult(turnResult(26, { subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' }).payload);
  const stopped = readCloudResult(stoppedResult(27).payload);

  assert.equal(done.text, 'Done.');
  assert.equal(done.isError, false);
  assert.equal(done.interrupted, false);
  assert.equal(done.totalCostUsd, 0.05);
  assert.deepEqual(Object.keys(done.modelUsage), [MODEL]);
  assert.equal(failed.isError, true);
  assert.equal(failed.interrupted, false);
  assert.equal(failed.subtype, 'error_max_turns');
  assert.equal(stopped.text, '');
  assert.equal(stopped.isError, true);
  assert.equal(stopped.interrupted, true);
  assert.deepEqual(stopped.errors, ['The turn was interrupted.']);
  assert.equal(isInterruptedCloudResult({ terminal_reason: 'completed' }), false);
});

test('readCloudSessionUsage maps the session onto the context-usage shape, wrapped or not', () => {
  const session = cloudSession({ workerStatus: 'running', costUsd: 0.42 });
  const usage = readCloudSessionUsage(session);

  assert.deepEqual(usage.contextUsage, {
    model: MODEL,
    totalTokens: 60_000,
    maxTokens: 1_000_000,
    percentage: 6,
    categories: [],
    apiUsage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  });
  assert.equal(usage.costUsd, 0.42);
  assert.equal(usage.sessionUrl, SESSION_URL);
  assert.equal(usage.workerStatus, 'running');
  assert.deepEqual(readCloudSessionUsage({ response_shape: session }), usage);
  assert.deepEqual(readCloudSessionUsage({ id: 'x' }), { contextUsage: null, costUsd: null, sessionUrl: null, workerStatus: null });
});

test('toCloudSequence reads the wire\'s string numbers', () => {
  assert.equal(toCloudSequence('26'), 26);
  assert.equal(toCloudSequence(0), 0);
  assert.equal(toCloudSequence(null), null);
  assert.equal(toCloudSequence(''), null);
  assert.equal(toCloudSequence('next'), null);
});

test('a thinking block the cloud sends without its text becomes a placeholder thought; one with nothing at all is skipped', () => {
  const normalizer = createClaudeCloudEventNormalizer();
  const signedOnly = cloudEvent(31, {
    type: 'assistant',
    session_id: 'cse_01EXAMPLEnormalizer000001',
    parent_tool_use_id: null,
    message: { id: 'msg_example_31', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'EqYGCtABCBIYAipA' }] },
  });
  const [thought] = normalizer.normalize(signedOnly);
  assert.equal(thought.channel, 'thought');
  assert.equal(thought.payload.text, '[Thinking — the cloud does not show the text]');
  assert.equal(thought.payload.done, true);

  const bare = cloudEvent(32, {
    type: 'assistant',
    session_id: 'cse_01EXAMPLEnormalizer000001',
    parent_tool_use_id: null,
    message: { id: 'msg_example_32', role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
  });
  assert.deepEqual(normalizer.normalize(bare), []);
});
