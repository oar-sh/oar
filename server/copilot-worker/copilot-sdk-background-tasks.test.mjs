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
import { createCopilotQuestionBridge } from './copilot-question-bridge.mjs';
import { BACKGROUND_QUESTION_NOTE } from './copilot-sdk-session-process.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';

const AGENT_ID = 'e489d2f3-2431-4f95-9b71-f15a327f8c92';
const userMessage = (messageId, delivery = 'idle') => ({ type: 'user.message', data: { messageId, delivery, content: 'hello' } });
const responsesFor = (stub, id) => stub.bodiesFor('/api/response').filter((body) => body.messageId === id);
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

// ---------------------------------- continuations with nothing to show ------
//
// When a background agent finishes, the runtime often opens a follow-up turn
// that produces no text and runs no tool (live, gpt-5.6-luna, 2026-09-26).
// Its row would only ever say "the turn completed without a text reply"; the
// task card already showed the agent finishing, so that row settles silently.

/** The runtime's completion notification for the background agent. */
function agentCompleted(client) {
  client.session.taskList[0].status = 'completed';
  client.session.emit({
    type: 'system.notification',
    data: {
      kind: { type: 'agent_completed', agentId: AGENT_ID, agentType: 'general-purpose', displayName: 'bg-probe', description: 'background probe', status: 'completed' },
      content: '<system_notification>\nAgent "bg-probe" (general-purpose) has completed.\n</system_notification>',
    },
  });
}

/** A follow-up turn the runtime opens by itself: `events` between its start and its idle. */
function runtimeFollowUp(client, events = []) {
  client.session.emit({ type: 'assistant.turn_start', data: { turnId: '0', interactionId: 'i-follow-up' } });
  client.session.emit({ type: 'assistant.message', data: { messageId: 'f0', content: '', toolRequests: [] } });
  for (const event of events) client.session.emit(event);
  client.session.emit({ type: 'assistant.idle', data: {} });
}

test('a runtime-opened continuation with no text and no tool activity settles silently', async () => {
  let releaseDrop;
  const dropGate = new Promise((resolve) => { releaseDrop = resolve; });
  const stub = makeContinuationApiStub({ routeResponses: { '/api/requeue': () => dropGate } });
  const { client, runner } = setup({ stub, taskList: [agentTask()] });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  agentCompleted(client);
  runtimeFollowUp(client);
  await waitFor(() => stub.bodiesFor('/api/requeue').length === 1, { label: 'continuation row torn down' });

  // Torn down through the requeue route's continuation branch (the relay drops
  // a processing continuation quietly), fenced to the attempt it was minted
  // under — no response, no note streamed into the row.
  assert.deepEqual(stub.bodiesFor('/api/requeue')[0], { messageId: 'cont-1', attemptId: 'attempt-cont-1' });
  assert.equal(responsesFor(stub, 'cont-1').length, 0);
  assert.equal(stub.bodiesFor('/api/stream').filter((body) => body.messageId === 'cont-1').length, 0);
  // Still claimed while the teardown is in flight, released once it lands.
  assert.deepEqual(runner.getActiveQueueMessageIds(), [{ id: 'cont-1', attemptId: 'attempt-cont-1' }]);
  releaseDrop({ ok: true, dropped: 'continuation' });
  await waitFor(() => runner.isTurnActive() === false, { label: 'continuation released' });
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
  assert.equal(runner.canAcceptSteering(), false);
  assert.equal(runner.isDeliveryHeld(), false);
  await runner.dispose();
});

test('a runtime-opened continuation whose only work was a tool call keeps its row', async () => {
  const { stub, client, runner } = setup({ taskList: [agentTask()] });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  agentCompleted(client);
  runtimeFollowUp(client, [
    { type: 'tool.execution_start', data: { toolCallId: 'r1', toolName: 'read_agent', arguments: { agent_id: AGENT_ID } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'r1', success: true, result: { content: 'SUB done.' } } },
  ]);
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation published' });
  assert.equal(responsesFor(stub, 'cont-1')[0].text, EMPTY_TURN_COMPLETION_NOTE);
  assert.deepEqual(stub.bodiesFor('/api/requeue'), []);
  const activities = stub.bodiesFor('/api/activity').filter((body) => body.messageId === 'cont-1').map((body) => body.text);
  assert.ok(activities.some((text) => text.startsWith('Tool (read_agent)')), activities.join(' | '));
  await runner.dispose();
});

test('a runtime-opened continuation with text keeps its row', async () => {
  const { stub, client, runner } = setup({ taskList: [agentTask()] });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  agentCompleted(client);
  runtimeFollowUp(client, [{ type: 'assistant.message', data: { messageId: 'f1', content: 'The agent finished.' } }]);
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation published' });
  assert.equal(responsesFor(stub, 'cont-1')[0].text, 'The agent finished.');
  assert.deepEqual(stub.bodiesFor('/api/requeue'), []);
  await runner.dispose();
});

test('a delivered message whose turn ends with no text still gets the note', async () => {
  const { stub, runner } = setup({
    events: (id) => [userMessage(id), { type: 'assistant.message', data: { messageId: 'm0', content: '' } }, { type: 'assistant.idle', data: {} }],
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(responsesFor(stub, 'q-1')[0].text, EMPTY_TURN_COMPLETION_NOTE);
  assert.deepEqual(stub.bodiesFor('/api/requeue'), []);
  await runner.dispose();
});

test('an empty continuation a user message was folded into keeps its row for that message', async () => {
  const { stub, client, runner } = setup({ taskList: [agentTask()] });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  agentCompleted(client);
  client.session.emit({ type: 'assistant.turn_start', data: { turnId: '0', interactionId: 'i-follow-up' } });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'continuation row registered' });
  const steered = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'status?' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'steered send' });
  client.session.emit({ type: 'user.message', data: { content: 'status?', messageId: client.session.idOfSend(1), delivery: 'steering' } });
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await steered, true);
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation published' });
  // The steered row settles as folded into the continuation's reply, so that
  // reply must exist for the user's message to point at.
  assert.equal(responsesFor(stub, 'cont-1')[0].text, EMPTY_TURN_COMPLETION_NOTE);
  assert.deepEqual(responsesFor(stub, 'cont-1')[0].consumedSteerIds, [{ id: 'q-2', attemptId: null }]);
  assert.equal(responsesFor(stub, 'q-2')[0].kind, 'folded');
  assert.deepEqual(stub.bodiesFor('/api/requeue'), []);
  await runner.dispose();
});

// ------------------------------------------ questions from background agents --
//
// A background agent can ask the human (ask_user, an ask-mode approval) after
// the turn that spawned it settled on `assistant.idle`, and a card needs a
// `processing` row. So a question with no turn live gets a continuation row of
// its own, and a card raised during a live turn keeps that turn's row open
// until it is answered.

/**
 * The relay's question routes for the REAL bridge: a card without a row is
 * refused with a 409, as `/api/relay-question` does, and every card stays
 * pending until the test answers it.
 */
function questionRelay() {
  const cards = [];
  const routeResponses = {
    '/api/relay-question': (body) => {
      if (!body?.queueId) {
        const error = new Error('No active relay turn');
        error.status = 409;
        throw error;
      }
      const card = { id: `rq-${cards.length + 1}`, body, status: 'pending', answer: null };
      cards.push(card);
      return { question: { id: card.id } };
    },
  };
  for (let index = 1; index <= 3; index += 1) {
    const id = `rq-${index}`;
    const find = () => cards.find((card) => card.id === id);
    routeResponses[`/api/relay-question/${id}`] = () => ({ question: { id, status: find().status, answer: find().answer } });
    routeResponses[`/api/relay-question/${id}/timeout`] = () => {
      if (find().status === 'pending') find().status = 'timed_out';
      return {};
    };
  }
  return {
    cards,
    stub: makeContinuationApiStub({ routeResponses }),
    answer(id, text) {
      const card = cards.find((entry) => entry.id === id);
      card.status = 'answered';
      card.answer = text;
    },
  };
}

function setupQuestions(overrides = {}) {
  const relay = questionRelay();
  const made = setup({
    stub: relay.stub,
    taskList: [agentTask()],
    createQuestionBridgeImpl: (options) => createCopilotQuestionBridge(options),
    questionPollMs: 1,
    ...overrides,
  });
  return { ...made, relay };
}

test('an ask-mode approval from a background agent after the turn settled gets a row of its own and reaches the human', async () => {
  const { relay, stub, client, runner } = setupQuestions();
  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'ask' } }), true);
  assert.equal(runner.isTurnActive(), false, 'q-1 settled on assistant.idle; the agent runs on');

  // The agent wants to write: the runtime calls the handler with no turn open.
  const decision = client.createAttempts[0].onPermissionRequest({ kind: 'write', fileName: 'notes.md' });
  await waitFor(() => relay.cards.length === 1, { label: 'card created' });
  const card = relay.cards[0].body;
  assert.equal(card.queueId, 'cont-1');
  assert.equal(card.attemptId, 'attempt-cont-1');
  assert.equal(card.context.source, 'onPermissionRequest');
  assert.equal(stub.mintedContinuations[0].body.relayMode, 'ask');
  relay.answer('rq-1', 'Approve');
  assert.deepEqual(await decision, { kind: 'approve-once' });

  // Nothing else would ever close a row that exists only for the card.
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'question row settled' });
  assert.equal(responsesFor(stub, 'cont-1')[0].text, BACKGROUND_QUESTION_NOTE);
  assert.equal(responsesFor(stub, 'cont-1')[0].terminalError, undefined);
  await waitFor(() => runner.isTurnActive() === false, { label: 'row released' });
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
  await runner.dispose();
});

test('ask_user from a background agent after the turn settled reaches the human, through the relay tool and the built-in', async () => {
  const { relay, stub, client, runner } = setupQuestions();
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  const config = client.createAttempts[0];
  const tool = config.tools.find((entry) => entry.name === 'ask_user');

  const viaTool = tool.handler({ question: 'Which env?', choices: ['prod', 'staging'] }, { toolCallId: 'c1' });
  await waitFor(() => relay.cards.length === 1, { label: 'tool card' });
  assert.equal(relay.cards[0].body.queueId, 'cont-1');
  relay.answer('rq-1', 'staging');
  assert.equal(await viaTool, 'User selected: staging');
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'first question row settled' });

  const viaBuiltIn = config.onUserInputRequest({ requestId: 'r2', question: 'Proceed?', choices: ['yes', 'no'] });
  await waitFor(() => relay.cards.length === 2, { label: 'built-in card' });
  assert.equal(relay.cards[1].body.queueId, 'cont-2');
  relay.answer('rq-2', 'yes');
  assert.deepEqual(await viaBuiltIn, { answer: 'yes', wasFreeform: false });
  await waitFor(() => responsesFor(stub, 'cont-2').length === 1, { label: 'second question row settled' });
  assert.equal(responsesFor(stub, 'cont-2')[0].text, BACKGROUND_QUESTION_NOTE);
  await runner.dispose();
});

test('a card a background agent raises during a live turn keeps that row open past assistant.idle until it is answered', async () => {
  const { relay, stub, client, runner } = setupQuestions({ events: (id) => spawnTurnEvents(id).slice(0, -1) });
  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'q-1 live' });

  const asked = client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'Keep the old file?', choices: ['yes', 'no'] });
  await waitFor(() => relay.cards.length === 1, { label: 'card on q-1' });
  assert.equal(relay.cards[0].body.queueId, 'q-1');

  // The main loop idles while the agent still waits on the human.
  client.session.emit({ type: 'assistant.idle', data: {} });
  await tick(30);
  assert.equal(relay.cards[0].status, 'pending', 'the card was not timed out');
  assert.equal(responsesFor(stub, 'q-1').length, 0, 'the row waits for its card');
  assert.deepEqual(runner.getActiveQueueMessageIds().map((entry) => entry.id), ['q-1'], 'and stays claimed meanwhile');
  assert.equal(stub.bodiesFor('/api/continuation-turn').length, 0);

  relay.answer('rq-1', 'no');
  assert.deepEqual(await asked, { answer: 'no', wasFreeform: false });
  assert.equal(await first, true);
  assert.equal(responsesFor(stub, 'q-1').length, 1);
  assert.equal(responsesFor(stub, 'q-1')[0].text, 'Main: spawned.');
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
  await runner.dispose();
});

test('a Stop while a settled row waits on a background card ends the card and interrupts nothing', async () => {
  let abortTurn = null;
  const controlPoller = { start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return {}; }, stop: () => {} };
  const { relay, stub, client, runner } = setupQuestions({
    events: (id) => spawnTurnEvents(id).slice(0, -1),
    controlPoller,
  });
  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'q-1 live' });
  const asked = client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'Keep?', choices: ['yes', 'no'] });
  await waitFor(() => relay.cards.length === 1, { label: 'card on q-1' });
  client.session.emit({ type: 'assistant.idle', data: {} });
  await tick(20);

  await abortTurn({ queueMessageId: 'q-1' });
  await asked;
  assert.equal(await first, true);
  assert.equal(relay.cards[0].status, 'timed_out', 'the card was ended');
  // The main loop is no longer this row's: a runtime interrupt would hit whatever runs next.
  assert.deepEqual(client.session.interruptCalls, []);
  assert.equal(client.session.abortCalls, 0);
  // Stopped: the relay's abort control settles the row, so no response.
  assert.equal(responsesFor(stub, 'q-1').length, 0);
  const finalStream = stub.bodiesFor('/api/stream').filter((body) => body.messageId === 'q-1').at(-1);
  assert.equal(finalStream.done, true);
  assert.equal(finalStream.text, 'Main: spawned.');
  await runner.dispose();
});

test('a Stop naming a row that waits on a background card ends that card, even when a newer turn claims it', async () => {
  const pollers = [];
  const controlPoller = { start: ({ onAbortTurn }) => { pollers.push(onAbortTurn); return {}; }, stop: () => {} };
  const { relay, stub, client, runner } = setupQuestions({
    events: (id) => spawnTurnEvents(id).slice(0, -1),
    controlPoller,
  });
  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'q-1 live' });
  const asked = client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'Keep?', choices: ['yes', 'no'] });
  await waitFor(() => relay.cards.length === 1, { label: 'card on q-1' });
  client.session.emit({ type: 'assistant.idle', data: {} });
  // Root work of its own opens a continuation, whose poller is the newest.
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm7', content: 'Meanwhile, root work.' } });
  await waitFor(() => pollers.length === 2, { label: 'continuation poller' });

  await pollers[1]({ queueMessageId: 'q-1' });
  await waitFor(() => relay.cards[0].status === 'timed_out', { label: 'the card was ended' });
  await asked;
  assert.equal(await first, true);
  assert.equal(responsesFor(stub, 'q-1').length, 0, 'stopped: the abort control settles it');
  assert.deepEqual(client.session.interruptCalls, [], 'the continuation was not interrupted');
  assert.equal(runner._getState().activeTurnKind, 'continuation');
  client.session.emit({ type: 'assistant.idle', data: {} });
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation settled' });
  assert.equal(responsesFor(stub, 'cont-1')[0].text, 'Meanwhile, root work.');
  await runner.dispose();
});

test('root work that starts while a background question is open merges into its row and ends on assistant.idle', async () => {
  const { relay, stub, client, runner } = setupQuestions();
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  const asked = client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'Proceed?', choices: ['yes', 'no'] });
  await waitFor(() => relay.cards.length === 1, { label: 'card' });
  assert.equal(relay.cards[0].body.queueId, 'cont-1');

  // The root agent starts work of its own while the card is still open.
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm5', content: 'Root follow-up while you decide.' } });
  await tick(10);
  relay.answer('rq-1', 'yes');
  assert.deepEqual(await asked, { answer: 'yes', wasFreeform: false });
  await tick(20);
  assert.equal(responsesFor(stub, 'cont-1').length, 0, 'root work keeps the row open until its own terminator');

  client.session.emit({ type: 'assistant.idle', data: {} });
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation settled' });
  assert.equal(responsesFor(stub, 'cont-1')[0].text, 'Root follow-up while you decide.');
  assert.equal(stub.bodiesFor('/api/continuation-turn').length, 1, 'one row for the question and the work');
  await runner.dispose();
});
