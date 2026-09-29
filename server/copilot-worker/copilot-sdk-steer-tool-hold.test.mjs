// The tool hold of the Copilot SDK runner: a message that arrives while a
// tool call of the main agent is running is kept back and steered in at the
// tool boundary. Sent at once, the runtime ended a running shell command for
// it ("moved to background by the user") and asked the model again — the turn
// then answered the steer alone or failed on an empty reply (seen live
// 2026-09-29, see `mainToolsInFlight`).
//
// The hold is the one the question card and the compaction use: the delivery
// gate closes, a delivery that lands anyway is handed back `steering-held`,
// and the message waits in the relay's queue. Nothing here waits for an
// amount of time; every step waits for a state.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  createFakeCopilotClient,
  makeApiStub,
  makeRunner,
  waitFor,
} from './copilot-sdk-test-harness.mjs';

const userMessage = (messageId, delivery, content = '') => ({ type: 'user.message', data: { messageId, delivery, content } });
const assistantText = (messageId, content) => ({ type: 'assistant.message', data: { messageId, content } });
const idle = { type: 'assistant.idle', data: {} };
const toolStart = (toolCallId, toolName = 'bash', agentId = '') => ({
  type: 'tool.execution_start',
  ...(agentId ? { agentId } : {}),
  data: { toolCallId, toolName, arguments: { command: 'npm test' } },
});
const toolComplete = (toolCallId, agentId = '') => ({
  type: 'tool.execution_complete',
  ...(agentId ? { agentId } : {}),
  data: { toolCallId, success: true, result: { content: 'ok' } },
});
const responsesFor = (stub, id) => stub.bodiesFor('/api/response').filter((body) => body.messageId === id);
const heldHandBacks = (stub) => stub.bodiesFor('/api/requeue').filter((body) => body.class === 'steering-held').map((body) => body.messageId);
const allSends = (client) => client.sessions.flatMap((session) => session.sends);
// A delivery that is steered in after all resolves only with its turn, so a
// hold that broke would leave a test waiting for ever. Far above what any of
// them needs; none of them measures time.
const BOUNDED = { timeout: 20_000 };
const message = (id, text) => ({ ...baseMessage, id, attemptId: `a-${id}`, text });

/** A client whose Nth send replays `perSend[N](runtimeMessageId)`. */
function scriptedClient(perSend, clientOptions = {}) {
  let sendIndex = 0;
  return createFakeCopilotClient({
    ...clientOptions,
    onSend: (session, _options, messageId) => {
      const script = perSend[sendIndex] || (() => []);
      sendIndex += 1;
      session.replay(typeof script === 'function' ? script(messageId) : script);
    },
  });
}

/**
 * Opens q-1 as a live turn (prompt sent, first text streamed, no idle). The
 * runner is disposed with the test, so a failed assertion leaves no live turn
 * behind that keeps the process up.
 */
async function openLiveTurn(t, { stub = makeApiStub(), scripts = [], client = null, ...overrides } = {}) {
  const liveClient = client || scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'working on it')],
    ...scripts,
  ]);
  const readiness = [];
  const log = [];
  const made = makeRunner({
    stub,
    client: liveClient,
    onDeliveryReadinessChange: (ready) => readiness.push(ready),
    canHandBackHeldDelivery: () => true,
    dbg: (...parts) => log.push(parts.join(' ')),
    queueLaneRefreshMs: 1,
    orphanGraceMs: 30,
    ...overrides,
  });
  t.after(() => made.runner.dispose());
  const first = made.runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => liveClient.session?.sends.length === 1, { label: 'first send' });
  await waitFor(() => made.runner.canAcceptSteering() === true, { label: 'turn live and steerable' });
  return { ...made, stub, client: liveClient, first, readiness, log };
}

const foldedSteer = (content, reply) => (id) => [userMessage(id, 'steering', content), assistantText(`m-${content}`, reply)];

test('a steer that arrives while a command runs is kept back until the command has ended', BOUNDED, async (t) => {
  const { stub, client, runner, first, readiness, log } = await openLiveTurn(t, {
    scripts: [(id) => [...foldedSteer('also X', 'and X')(id), idle]],
  });
  assert.deepEqual(readiness, [false, true]);

  client.session.emit(toolStart('call-1'));
  assert.equal(runner.canAcceptSteering(), false, 'the gate closes with the event, not after its publishes');
  assert.equal(runner.isDeliveryHeld(), true);
  assert.equal(runner.steeringState().holdReason, 'tool');
  assert.equal(runner.steeringState().canSteer, false);
  assert.deepEqual(readiness, [false, true, false], 'the relay is told to stop delivering');

  // A delivery that was already on its way lands in the hold.
  assert.equal(await runner.handlePendingPayload({ message: message('q-2', 'also X') }), false);
  assert.deepEqual(stub.bodiesFor('/api/requeue'), [{ messageId: 'q-2', class: 'steering-held', attemptId: 'a-q-2' }]);
  assert.equal(client.session.sends.length, 1, 'nothing reached the runtime');
  assert.ok(
    log.some((line) => line.includes('steering held while a tool runs') && line.includes('q-2') && line.includes('tools=bash')),
    log.join('\n'),
  );
  // The worker does not claim the row it handed back: the queue owns it.
  assert.deepEqual(runner.getActiveQueueMessageIds().map((entry) => entry.id), ['q-1']);

  // The tool boundary opens the gate.
  client.session.emit(toolComplete('call-1'));
  assert.equal(runner.canAcceptSteering(), true);
  assert.equal(runner.steeringState().holdReason, null);
  assert.deepEqual(readiness, [false, true, false, true], 'the relay is told to deliver again');
  assert.ok(log.some((line) => line.includes('the running tool ended') && line.includes('handed back=1')), log.join('\n'));

  const redelivered = runner.handlePendingPayload({ message: message('q-2', 'also X') });
  await waitFor(() => client.session.sends.length === 2, { label: 'steered in at the tool boundary' });
  assert.equal(client.session.sends[1].mode, 'immediate');
  assert.match(client.session.sends[1].prompt, /also X/);
  assert.equal(await redelivered, true);
  assert.equal(await first, true);
  assert.equal(responsesFor(stub, 'q-2')[0].kind, 'folded');

  // The command was left to the runtime from start to end.
  assert.equal(client.session.abortCalls, 0);
  assert.deepEqual(client.session.interruptCalls, []);
  assert.deepEqual(client.session.cancelledTasks, []);
  assert.deepEqual(client.session.callLog.filter((call) => call !== 'send'), []);
});

test('two steers held for a command are steered in in the order they came', BOUNDED, async (t) => {
  const { stub, client, runner, first } = await openLiveTurn(t, {
    scripts: [
      foldedSteer('second', 'noted the second'),
      (id) => [...foldedSteer('third', 'noted the third')(id), idle],
    ],
  });
  client.session.emit(toolStart('call-1'));
  assert.equal(await runner.handlePendingPayload({ message: message('q-2', 'second') }), false);
  assert.equal(await runner.handlePendingPayload({ message: message('q-3', 'third') }), false);
  assert.deepEqual(heldHandBacks(stub), ['q-2', 'q-3']);
  assert.equal(client.session.sends.length, 1);

  client.session.emit(toolComplete('call-1'));
  // The relay's queue hands them out oldest first.
  const second = runner.handlePendingPayload({ message: message('q-2', 'second') });
  const third = runner.handlePendingPayload({ message: message('q-3', 'third') });
  await waitFor(() => client.session.sends.length === 3, { label: 'both steered in' });
  assert.match(client.session.sends[1].prompt, /second/);
  assert.match(client.session.sends[2].prompt, /third/);
  assert.equal(await second, true);
  assert.equal(await third, true);
  assert.equal(await first, true);
  assert.deepEqual(
    responsesFor(stub, 'q-1')[0].consumedSteerIds.map((entry) => entry.id),
    ['q-2', 'q-3'],
  );
});

test('with several commands running at once the hold lasts until the last one has ended', BOUNDED, async (t) => {
  const { client, runner, first } = await openLiveTurn(t);
  client.session.emit(toolStart('call-1'));
  client.session.emit(toolStart('call-2', 'view'));
  client.session.emit(toolComplete('call-1'));
  assert.equal(runner.canAcceptSteering(), false, 'call-2 still runs');
  assert.equal(runner.steeringState().holdReason, 'tool');
  client.session.emit(toolComplete('call-2'));
  assert.equal(runner.canAcceptSteering(), true);
  client.session.emit(idle);
  assert.equal(await first, true);
});

test('a steer that arrives with no tool running is steered in at once', BOUNDED, async (t) => {
  const { stub, client, runner, first, readiness } = await openLiveTurn(t, {
    scripts: [(id) => [...foldedSteer('also X', 'and X')(id), idle]],
  });
  // A tool that ran and ended leaves nothing behind.
  client.session.emit(toolStart('call-1'));
  client.session.emit(toolComplete('call-1'));
  assert.equal(runner.canAcceptSteering(), true);
  assert.deepEqual(readiness, [false, true, false, true]);

  const second = runner.handlePendingPayload({ message: message('q-2', 'also X') });
  await waitFor(() => client.session.sends.length === 2, { label: 'steered in' });
  assert.equal(client.session.sends[1].mode, 'immediate');
  assert.equal(await second, true);
  assert.equal(await first, true);
  assert.deepEqual(heldHandBacks(stub), []);
  assert.equal(responsesFor(stub, 'q-2')[0].kind, 'folded');
});

test('a tool that starts while the steer is being prepared keeps it back as well', BOUNDED, async (t) => {
  let releasePreview = () => {};
  const preview = new Promise((resolve) => { releasePreview = resolve; });
  let previewLookups = 0;
  const { stub, client, runner, first } = await openLiveTurn(t, {
    // Asked for the first message of a relay mode only: q-1 opens `agent`,
    // the steer below opens `plan`.
    getPreviewInstructionsImpl: () => {
      previewLookups += 1;
      return previewLookups === 1 ? '' : preview.then(() => '');
    },
  });
  const second = runner.handlePendingPayload({ message: { ...message('q-2', 'also X'), relayMode: 'plan' } });
  await waitFor(() => previewLookups === 2, { label: 'the steer is being prepared' });
  client.session.emit(toolStart('call-1'));
  releasePreview();
  assert.equal(await second, false);
  assert.deepEqual(heldHandBacks(stub), ['q-2']);
  assert.equal(client.session.sends.length, 1, 'nothing reached the runtime');
  assert.deepEqual(runner.getActiveQueueMessageIds().map((entry) => entry.id), ['q-1']);

  client.session.emit(toolComplete('call-1'));
  client.session.emit(idle);
  assert.equal(await first, true);
});

test('the tool of a background agent does not hold a steer of the main turn', BOUNDED, async (t) => {
  const { stub, client, runner, first, readiness } = await openLiveTurn(t, {
    scripts: [(id) => [...foldedSteer('also X', 'and X')(id), idle]],
  });
  client.session.emit(toolStart('agent-call-1', 'bash', 'agent-7'));
  assert.equal(runner.canAcceptSteering(), true);
  assert.equal(runner.isDeliveryHeld(), false);
  assert.deepEqual(readiness, [false, true], 'nothing to tell the relay');

  const second = runner.handlePendingPayload({ message: message('q-2', 'also X') });
  await waitFor(() => client.session.sends.length === 2, { label: 'steered in beside the agent' });
  assert.equal(await second, true);
  assert.equal(await first, true);
  assert.deepEqual(heldHandBacks(stub), []);
});

test('the tool of a background agent does not end the hold of a command of the main agent', BOUNDED, async (t) => {
  const { client, runner, first } = await openLiveTurn(t);
  // The same call id on both: the agent is what tells them apart.
  client.session.emit(toolStart('call-1'));
  client.session.emit(toolStart('call-1', 'bash', 'agent-7'));
  client.session.emit(toolComplete('call-1', 'agent-7'));
  assert.equal(runner.canAcceptSteering(), false);
  client.session.emit(toolComplete('call-1'));
  assert.equal(runner.canAcceptSteering(), true);
  client.session.emit(idle);
  assert.equal(await first, true);
});

test('a remote_relay call holds no steer, as before', BOUNDED, async (t) => {
  const { client, runner, first, readiness } = await openLiveTurn(t);
  client.session.emit(toolStart('call-1', 'remote_relay'));
  assert.equal(runner.canAcceptSteering(), true);
  assert.deepEqual(readiness, [false, true]);
  client.session.emit(toolComplete('call-1'));
  client.session.emit(idle);
  assert.equal(await first, true);
});

/**
 * q-2 is handed back for a running command, then the turn goes away in the
 * given way. The message must still be in the queue's hands — never answered,
 * never failed, never claimed — and run as a turn of its own when it comes
 * again.
 */
async function heldSteerSurvives(t, { endTurn, clientOptions = {}, runnerOptions = {} }) {
  const client = scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'working on it')],
    (id) => [userMessage(id, 'idle', 'also X'), assistantText('m2', 'did X'), idle],
  ], clientOptions);
  const opened = await openLiveTurn(t, { client, ...runnerOptions });
  const { stub, runner, first, readiness } = opened;
  client.session.emit(toolStart('call-1'));
  assert.equal(await runner.handlePendingPayload({ message: message('q-2', 'also X') }), false);
  assert.deepEqual(heldHandBacks(stub), ['q-2']);

  await endTurn(opened);
  assert.equal(await first, true);
  await waitFor(() => runner.isTurnActive() === false, { label: 'turn released' });
  assert.equal(runner.isDeliveryHeld(), false, 'no turn, no hold');
  assert.equal(readiness.at(-1), true, 'the relay was told to deliver again');
  assert.equal(allSends(client).length, 1, 'the held message never reached the runtime');
  assert.deepEqual(responsesFor(stub, 'q-2'), [], 'and was given no answer of any kind');
  assert.equal(stub.bodiesFor('/api/queue-consumed').length, 0);
  assert.equal(stub.bodiesFor('/api/queue-cancelled').length, 0);
  assert.deepEqual(heldHandBacks(stub), ['q-2'], 'handed back once, with no retry penalty');

  // The relay delivers it again: now it opens a turn.
  const redelivered = runner.handlePendingPayload({ message: message('q-2', 'also X') });
  await waitFor(() => allSends(client).length === 2, { label: 'q-2 runs as the next turn' });
  assert.match(allSends(client)[1].prompt, /also X/);
  assert.equal(await redelivered, true);
  const answers = responsesFor(stub, 'q-2');
  assert.equal(answers.length, 1);
  assert.match(answers[0].text, /did X/);
  assert.notEqual(answers[0].kind, 'folded');
  return opened;
}

test('a steer held for a command is not lost when the turn ends', BOUNDED, async (t) => {
  const { stub } = await heldSteerSurvives(t, {
    // The runtime closes the turn; the tool's own completion came first.
    endTurn: ({ client }) => client.session.replay([toolComplete('call-1'), assistantText('m1b', 'done'), idle]),
  });
  assert.equal(responsesFor(stub, 'q-1')[0].terminalError ?? null, null);
});

test('a steer held for a command is not lost when the turn fails', BOUNDED, async (t) => {
  const { stub } = await heldSteerSurvives(t, {
    endTurn: ({ client }) => client.session.emit({
      type: 'session.error',
      data: { errorType: 'query', message: 'No response was returned' },
    }),
  });
  assert.ok(responsesFor(stub, 'q-1')[0].terminalError, 'q-1 failed');
});

test('a steer held for a command is not lost when the turn is stopped', BOUNDED, async (t) => {
  let abortTurn = null;
  const { stub, client } = await heldSteerSurvives(t, {
    clientOptions: {
      onAbort: (session) => session.replay([
        { type: 'abort', data: { reason: 'user_abort' } },
        { type: 'assistant.idle', data: { aborted: true } },
      ]),
    },
    runnerOptions: {
      controlPoller: {
        start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return { id: 1 }; },
        stop: () => {},
      },
    },
    endTurn: () => abortTurn({ queueMessageId: 'q-1' }),
  });
  assert.deepEqual(client.sessions[0].interruptCalls, [{ flushQueued: false }]);
  // Only what the runtime held is settled as stopped; q-2 never got there.
  assert.deepEqual(stub.bodiesFor('/api/response').filter((body) => body.kind === 'stopped'), []);
});
