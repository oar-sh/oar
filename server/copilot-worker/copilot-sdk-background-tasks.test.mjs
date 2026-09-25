// Background tasks from the runtime's task registry (`rpc.tasks`): panel cards
// for background agents and shells with the model, live tool call and tokens
// the events add, per-card Stop via `tasks.cancel`, the lifecycle pin with
// cancel-on-expiry, and the completion heralds that make a continuation.
// Shapes per the 2026-09-25 fake-provider probe of runtime 1.0.88.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  createFakeCopilotClient,
  makeApiStub,
  makeContinuationApiStub,
  makeRunner,
  tick,
  waitFor,
} from './copilot-sdk-test-harness.mjs';

const AGENT_ID = 'e489d2f3-2431-4f95-9b71-f15a327f8c92';
const userMessage = (messageId, delivery = 'idle') => ({ type: 'user.message', data: { messageId, delivery, content: 'hello' } });
const startedAtIso = (agoMs = 1_000) => new Date(Date.now() - agoMs).toISOString();

function agentTask(overrides = {}) {
  return {
    type: 'agent', id: AGENT_ID, toolCallId: 'call_1_0', displayName: 'bg-probe', description: 'background probe',
    status: 'running', agentType: 'general-purpose', prompt: 'SUBAGENT-PROMPT: do a thing', resolvedModel: 'probe-model',
    executionMode: 'background', canPromoteToBackground: false, model: null, startedAt: startedAtIso(),
    ...overrides,
  };
}

function shellTask(overrides = {}) {
  return {
    type: 'shell', id: '0', description: 'timer', status: 'running', command: 'sleep 40 && echo timer-fired',
    attachmentMode: 'detached', executionMode: 'background', logPath: '/tmp/copilot-detached-0.log', pid: 4242,
    startedAt: startedAtIso(), ...overrides,
  };
}

/** The delivered turn's events: the model spawns a background agent and a detached shell, then replies. */
function spawnTurnEvents(messageId) {
  return [
    userMessage(messageId),
    { type: 'assistant.message', data: { messageId: 'm0', content: '' } },
    { type: 'tool.execution_start', data: { toolCallId: 'call_1_0', toolName: 'task', arguments: { agent_type: 'general-purpose', name: 'bg-probe', description: 'background probe', prompt: 'SUBAGENT-PROMPT: do a thing', mode: 'background' } } },
    {
      type: 'subagent.started',
      agentId: AGENT_ID,
      data: { toolCallId: 'call_1_0', agentName: 'general-purpose', agentDisplayName: 'bg-probe', agentDescription: 'background probe', model: 'probe-model', agentType: 'general-purpose', executionMode: 'background' },
    },
    { type: 'tool.execution_complete', data: { toolCallId: 'call_1_0', success: true, result: { content: `Agent started in background with agent_id: ${AGENT_ID}.` } } },
    { type: 'session.background_tasks_changed', data: {} },
    // The agent's own traffic, tagged with its id.
    { type: 'user.message', agentId: AGENT_ID, data: { messageId: 'sub-1', delivery: 'idle', content: 'SUBAGENT-PROMPT: do a thing', source: 'agent-x' } },
    { type: 'tool.execution_start', agentId: AGENT_ID, data: { toolCallId: 'call_3_0', toolName: 'bash', arguments: { command: 'sleep 6 && echo sub-tool-done', description: 'sub work', mode: 'sync' } } },
    { type: 'assistant.usage', agentId: AGENT_ID, data: { model: 'probe-model', inputTokens: 10, outputTokens: 10 } },
    { type: 'assistant.message', data: { messageId: 'm1', content: 'Main: spawned.' } },
    // `assistant.idle`: the main loop is done while the agent keeps `session.idle` deferred.
    { type: 'assistant.idle', data: {} },
  ];
}

function setup({ taskList, taskProgress = {}, stub = makeContinuationApiStub(), events = spawnTurnEvents, ...overrides } = {}) {
  const client = createFakeCopilotClient({
    tasksRpc: true,
    taskList,
    taskProgress,
    onSend: (session, _options, messageId) => { if (session.sends.length === 1) session.replay(events(messageId)); },
  });
  const { runner } = makeRunner({
    stub,
    client,
    taskRefreshMs: 1,
    taskPublishThrottleMs: 1,
    continuationRetryDelayMs: 1,
    ...overrides,
  });
  return { stub, client, runner };
}

const lastTasks = (stub) => stub.bodiesFor('/api/background-tasks').at(-1)?.tasks || null;

test('background agents and shells from the registry become stoppable cards with model, live tool call and tokens', async () => {
  const { stub, client, runner } = setup({
    taskList: [agentTask(), shellTask()],
    taskProgress: {
      [AGENT_ID]: { type: 'agent', recentActivity: [{ message: '▸ bash sub work', timestamp: startedAtIso(0) }] },
      0: { type: 'shell', recentOutput: '(no output yet)' },
    },
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  // The row settled on assistant.idle while the agent runs on.
  assert.equal(stub.bodiesFor('/api/response')[0].text, 'Main: spawned.');
  await runner.whenTasksRefreshed();
  await waitFor(() => (lastTasks(stub) || []).length === 2, { label: 'two cards' });
  const cards = lastTasks(stub);
  const agent = cards.find((card) => card.taskId === AGENT_ID);
  const shell = cards.find((card) => card.taskId === '0');
  assert.deepEqual(agent, {
    taskId: AGENT_ID,
    taskType: 'local_agent',
    description: 'background probe',
    startedAt: agent.startedAt,
    stoppable: true,
    subagentType: 'general-purpose',
    model: 'probe-model',
    modelInherited: false,
    lastToolCall: 'Tool (bash): sleep 6 && echo sub-tool-done',
    totalTokens: 20,
    summary: '▸ bash sub work',
  });
  assert.ok(Number.isFinite(agent.startedAt));
  assert.deepEqual(shell, {
    taskId: '0',
    taskType: 'local_bash',
    description: 'timer',
    startedAt: shell.startedAt,
    stoppable: true,
  });
  // The runtime's task registry, not the event-scraped shell set, is the truth.
  assert.equal(client.session.rpc.tasks.listCalls > 0, true);
  // No lane was opened for the background agent: it lives in the panel.
  assert.equal(stub.bodiesFor('/api/subagent-run').length, 0);
  const activities = stub.bodiesFor('/api/activity').map((body) => body.text);
  assert.ok(activities.some((text) => text.startsWith('Started background agent: bg-probe (general-purpose)')), activities.join(' | '));
  await runner.dispose();
});

test('a card without a spawn model inherits the session model, and a token total comes from subagent.completed', async () => {
  const { stub, client, runner } = setup({
    taskList: [agentTask({ resolvedModel: undefined, model: null })],
    events: (id) => [
      userMessage(id),
      { type: 'subagent.started', agentId: AGENT_ID, data: { toolCallId: 'call_1_0', agentName: 'general-purpose', agentDisplayName: 'bg-probe', agentType: 'general-purpose', executionMode: 'background' } },
      { type: 'session.background_tasks_changed', data: {} },
      { type: 'assistant.message', data: { messageId: 'm1', content: 'spawned' } },
      { type: 'assistant.idle', data: {} },
    ],
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  await waitFor(() => (lastTasks(stub) || []).length === 1, { label: 'card' });
  const card = lastTasks(stub)[0];
  assert.equal(card.model, 'gpt-5-mini');
  assert.equal(card.modelInherited, true);
  assert.equal('totalTokens' in card, false);

  client.session.emit({ type: 'subagent.completed', agentId: AGENT_ID, data: { toolCallId: 'call_1_0', agentName: 'general-purpose', totalTokens: 4321, totalToolCalls: 3, durationMs: 6000 } });
  await tick(5);
  await runner.whenTasksRefreshed();
  await waitFor(() => lastTasks(stub)?.[0]?.totalTokens === 4321, { label: 'final tokens' });
  await runner.dispose();
});

test('the panel Stop cancels the task through rpc.tasks and the card disappears', async () => {
  const { stub, client, runner } = setup({ taskList: [agentTask(), shellTask()] });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  await waitFor(() => (lastTasks(stub) || []).length === 2, { label: 'two cards' });

  assert.equal(await runner.stopBackgroundTask(AGENT_ID), true);
  assert.deepEqual(client.session.cancelledTasks, [AGENT_ID]);
  // The fake registry announces the change like the runtime; the re-read drops the card.
  await waitFor(() => (lastTasks(stub) || []).length === 1, { label: 'agent card gone' });
  assert.equal(lastTasks(stub)[0].taskId, '0');
  // Finished entries are left to the runtime's own tracking (removing them
  // could race the root agent's read_agent follow-up).
  assert.deepEqual(client.session.removedTasks, []);

  assert.equal(await runner.stopBackgroundTask('0'), true);
  await waitFor(() => (lastTasks(stub) || []).length === 0, { label: 'shell card gone' });
  // Unknown id: refused, never thrown.
  assert.equal(await runner.stopBackgroundTask('nope'), false);
  await runner.dispose();
});

test('live registry tasks pin the runtime; the cap cancels them instead of forgetting them', async () => {
  const { client, runner } = setup({
    taskList: [agentTask({ startedAt: startedAtIso(60_000) })],
    idleShutdownMs: 5,
    lifecyclePollMs: 60_000,
    getBackgroundTaskTimeoutMs: () => 0,
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  await tick(15);
  runner._evaluateLifecycle();
  await tick(5);
  assert.equal(client.stopped, 0, 'a running background agent holds the runtime');
  assert.equal(runner._getState().hasSession, true);

  // The agent finishes: the registry says so, the pin lifts, idle shutdown proceeds.
  client.session.taskList[0].status = 'completed';
  client.session.emit({ type: 'session.background_tasks_changed', data: {} });
  await tick(5);
  await runner.whenTasksRefreshed();
  await tick(15);
  runner._evaluateLifecycle();
  await waitFor(() => client.stopped === 1, { label: 'runtime idled out' });
  assert.deepEqual(runner._getState().backgroundTasks, []);
});

test('a task older than the cap is cancelled by the lifecycle, not forgotten', async () => {
  const { client, runner } = setup({
    taskList: [agentTask({ startedAt: startedAtIso(60_000) }), shellTask({ startedAt: startedAtIso(100) })],
    idleShutdownMs: 60_000,
    lifecyclePollMs: 60_000,
    getBackgroundTaskTimeoutMs: () => 30_000,
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  runner._evaluateLifecycle();
  await waitFor(() => client.session.cancelledTasks.includes(AGENT_ID), { label: 'expired agent cancelled' });
  assert.equal(client.session.cancelledTasks.includes('0'), false, 'the young shell stays');
  await runner.dispose();
});

test('an agent_idle notification heralds the continuation and its note rides into the continuation row', async () => {
  const stub = makeContinuationApiStub();
  const { client, runner } = setup({ stub, taskList: [agentTask()] });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  assert.equal(runner._getState().continuationDueSince, 0);

  // The runtime's own notification, then its follow-up turn under the old interaction.
  client.session.taskList[0].status = 'idle';
  client.session.emit({
    type: 'system.notification',
    data: {
      kind: { type: 'agent_idle', agentId: AGENT_ID, agentType: 'general-purpose', displayName: 'bg-probe', description: 'background probe' },
      content: '<system_notification>\nAgent "bg-probe" (general-purpose) has finished processing and is now idle.\n</system_notification>',
    },
  });
  await tick(5);
  assert.ok(runner._getState().continuationDueSince > 0, 'the herald pins the runtime for the continuation');
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm2', content: '' } });
  client.session.emit({ type: 'tool.execution_start', data: { toolCallId: 'r1', toolName: 'read_agent', arguments: { agent_id: AGENT_ID, since_turn: 0 } } });
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm3', content: 'The agent is done: SUB done.' } });
  client.session.emit({ type: 'assistant.idle', data: {} });
  client.session.emit({ type: 'session.idle', data: {} });
  await waitFor(() => stub.bodiesFor('/api/response').some((body) => body.messageId === 'cont-1'), { label: 'continuation published' });
  assert.equal(stub.bodiesFor('/api/response').find((body) => body.messageId === 'cont-1').text, 'The agent is done: SUB done.');
  const contActivities = stub.bodiesFor('/api/activity').filter((body) => body.messageId === 'cont-1').map((body) => body.text);
  assert.ok(contActivities.includes('Background agent bg-probe finished: background probe'), contActivities.join(' | '));
  await runner.whenTasksRefreshed();
  // An idle multi-turn agent neither pins nor shows.
  assert.deepEqual(runner._getState().backgroundTasks, []);
  await runner.dispose();
});

test('a runtime without rpc.tasks keeps the event-scraped shell cards (not stoppable)', async () => {
  const stub = makeApiStub();
  const client = createFakeCopilotClient({
    tasksRpc: false,
    onSend: (session, _options, id) => session.replay([
      userMessage(id),
      { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'sleep 40', description: 'timer', mode: 'async', detach: true } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: '<command started in detached background with shellId: 7>' } } },
      { type: 'assistant.message', data: { messageId: 'm1', content: 'Timer set.' } },
      { type: 'assistant.idle', data: {} },
    ]),
  });
  const { runner } = makeRunner({ stub, client, taskPublishThrottleMs: 1 });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await waitFor(() => (lastTasks(stub) || []).length === 1, { label: 'shell card' });
  assert.deepEqual(lastTasks(stub)[0], { taskId: '7', taskType: 'local_bash', description: 'timer', startedAt: lastTasks(stub)[0].startedAt, stoppable: false });
  assert.equal(runner._getState().sessionRpc.tasks, false);
  assert.equal(await runner.stopBackgroundTask('7'), false);
  await runner.dispose();
});

test('a task the runtime will not cancel at the cap is abandoned after a few refusals, so it cannot pin the runtime forever', async () => {
  const { client, runner } = setup({
    taskList: [shellTask({ startedAt: startedAtIso(60_000) })],
    idleShutdownMs: 5,
    lifecyclePollMs: 60_000,
    getBackgroundTaskTimeoutMs: () => 30_000,
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  // A shell whose process ignores the cancel: the registry keeps it running.
  client.session.rpc.tasks.cancel = async () => ({ cancelled: false });
  for (let poll = 0; poll < 3; poll += 1) {
    runner._evaluateLifecycle();
    await tick(10);
    assert.equal(client.stopped, 0, `still held after refusal ${poll + 1}`);
  }
  runner._evaluateLifecycle();
  await tick(10);
  assert.deepEqual(runner._getState().backgroundTasks, [], 'abandoned: no card, no pin');
  await tick(10);
  runner._evaluateLifecycle();
  await waitFor(() => client.stopped === 1, { label: 'the runtime idled out' });
});

test('a background agent spawned in an earlier turn opens no lane in a later one, and its spend still counts', async () => {
  const { stub, client, runner } = setup({ taskList: [agentTask()] });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  // Turn 2, with the agent still working underneath it.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'and now?' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'second send' });
  const id2 = client.session.idOfSend(1);
  client.session.emit(userMessage(id2));
  client.session.emit({ type: 'subagent.configured', agentId: AGENT_ID, data: { model: 'probe-model', multiTurn: true } });
  client.session.emit({ type: 'tool.execution_start', agentId: AGENT_ID, data: { toolCallId: 'c9', toolName: 'view', arguments: { path: 'a.txt' } } });
  client.session.emit({ type: 'assistant.usage', agentId: AGENT_ID, data: { model: 'probe-model', inputTokens: 30, outputTokens: 5 } });
  client.session.emit({ type: 'assistant.message', agentId: AGENT_ID, data: { messageId: 'sub-2', content: 'still going' } });
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm2', content: 'meanwhile, here' } });
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await second, true);
  assert.equal(stub.bodiesFor('/api/subagent-run').length, 0, 'no lane in either turn');
  assert.equal(stub.bodiesFor('/api/response').find((body) => body.messageId === 'q-2').text, 'meanwhile, here');
  await waitFor(() => lastTasks(stub)?.[0]?.lastToolCall === 'Tool (view): a.txt', { label: 'the card followed the agent' });
  assert.equal(lastTasks(stub)[0].totalTokens, 55);
  await runner.dispose();
});

test('without rpc.tasks an unlimited slider still falls back to the 30-minute shell cap', async () => {
  const stub = makeApiStub();
  const client = createFakeCopilotClient({
    tasksRpc: false,
    onSend: (session, _options, id) => session.replay([
      userMessage(id),
      { type: 'tool.execution_start', data: { toolCallId: 'c1', toolName: 'bash', arguments: { command: 'sleep 99999', description: 'forever', mode: 'async', detach: true } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'c1', success: true, result: { content: '<command started in detached background with shellId: 7>' } } },
      { type: 'assistant.message', data: { messageId: 'm1', content: 'started' } },
      { type: 'assistant.idle', data: {} },
    ]),
  });
  const { runner } = makeRunner({ stub, client, idleShutdownMs: 60_000, lifecyclePollMs: 60_000, getBackgroundTaskTimeoutMs: () => 0 });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(runner._getState().backgroundShells.length, 1);
  runner._evaluateLifecycle();
  assert.equal(runner._getState().backgroundShells.length, 1, 'a fresh shell is not expired by an unlimited slider');
  runner._getState().backgroundShells[0].startedAt -= 31 * 60_000;
  runner._evaluateLifecycle();
  assert.equal(runner._getState().backgroundShells.length, 0, 'the 30-minute default applied on the fallback path');
  await runner.dispose();
});
