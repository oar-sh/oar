// Claude-parity steering for the Copilot SDK runner: the delivery gate and its
// holds, the steering-held hand-back, settling by `user.message.delivery`,
// Stop with steers in flight, un-steer, at-most-once settle markers, and the
// adoption of a pushed prompt whose run opened after its turn settled.
// Mechanics per the 2026-09-25 fake-provider probe of runtime 1.0.88 (plan:
// docs/plans/copilot-sdk-steering-background-parity.md §1).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  createFakeCopilotClient,
  makeApiStub,
  makeContinuationApiStub,
  makeFakeQuestionBridge,
  makeRunner,
  tick,
  waitFor,
} from './copilot-sdk-test-harness.mjs';
import { buildRelayStopFailure } from '../../shared/relay-stop-failure.mjs';

const userMessage = (messageId, delivery, content = '') => ({ type: 'user.message', data: { messageId, delivery, content } });
const assistantText = (messageId, content) => ({ type: 'assistant.message', data: { messageId, content } });
const responsesFor = (stub, id) => stub.bodiesFor('/api/response').filter((body) => body.messageId === id);

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

/** Opens q-1 as a live turn (prompt sent, first text streamed, no idle). */
async function openLiveTurn({ stub = makeApiStub(), scripts = [], client = null, ...overrides } = {}) {
  const liveClient = client || scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'working on it')],
    ...scripts,
  ]);
  const readiness = [];
  const made = makeRunner({
    stub,
    client: liveClient,
    onDeliveryReadinessChange: (ready) => readiness.push(ready),
    queueLaneRefreshMs: 1,
    orphanGraceMs: 30,
    ...overrides,
  });
  const first = made.runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => liveClient.session?.sends.length === 1, { label: 'first send' });
  await waitFor(() => made.runner.canAcceptSteering() === true, { label: 'turn live and steerable' });
  return { ...made, stub, client: liveClient, first, readiness };
}

// ------------------------------------------------------------------ gate --

test('the delivery hold: nothing steers in before the turn-opening send has resolved', async () => {
  let releaseSend = () => {};
  const gate = new Promise((resolve) => { releaseSend = resolve; });
  const client = createFakeCopilotClient();
  const createSession = client.createSession.bind(client);
  client.createSession = async (config) => {
    const session = await createSession(config);
    const send = session.send.bind(session);
    session.send = async (options) => { await gate; return send(options); };
    return session;
  };
  const stub = makeApiStub();
  const readiness = [];
  const { runner } = makeRunner({ stub, client, onDeliveryReadinessChange: (ready) => readiness.push(ready) });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner.isTurnActive(), { label: 'turn active' });
  assert.equal(runner.canAcceptSteering(), false);
  assert.equal(runner.isDeliveryHeld(), true);
  const held = runner.steeringState();
  assert.equal(held.turnActive, true);
  assert.equal(held.canSteer, false);
  assert.equal(held.holdReason, 'delivery');
  assert.equal(held.messageId, 'q-1');
  assert.equal(held.supported, true);
  assert.deepEqual(held.cancellableIds, []);
  assert.deepEqual(readiness, [false], 'the hold withdrew readiness once');

  releaseSend();
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'send resolved' });
  assert.equal(runner.isDeliveryHeld(), false);
  assert.equal(runner.steeringState().holdReason, null);
  assert.deepEqual(readiness, [false, true], 'the send re-armed it');

  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  assert.equal(runner.isDeliveryHeld(), false);
  assert.equal(runner.steeringState().turnActive, false);
  assert.deepEqual(readiness, [false, true], 'no turn = no hold; nothing new to report');
});

test('an open question card holds steering; a delivery is handed back steering-held and steers in after the answer', async () => {
  let answer = () => {};
  const card = new Promise((resolve) => { answer = resolve; });
  const questionBridge = makeFakeQuestionBridge({ userInputAnswer: 'staging', onAsk: () => card });
  const { stub, client, runner, first, readiness } = await openLiveTurn({
    questionBridge,
    scripts: [(id) => [userMessage(id, 'steering', 'also X'), assistantText('m2', 'and X'), { type: 'assistant.idle', data: {} }]],
    canHandBackHeldDelivery: () => true,
  });
  assert.deepEqual(readiness, [false, true]);

  // The runtime blocks in the ask_user handler.
  const asked = client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'which env?', choices: ['prod', 'staging'] });
  await waitFor(() => runner.isDeliveryHeld() === true, { label: 'card holds' });
  assert.equal(runner.steeringState().holdReason, 'question');
  assert.deepEqual(readiness, [false, true, false], 'the hold withdrew readiness at once');

  // A delivery landing in the hold is handed back — not pushed past the card.
  const second = { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'also X' };
  assert.equal(await runner.handlePendingPayload({ message: second }), false);
  assert.deepEqual(stub.bodiesFor('/api/requeue'), [{ messageId: 'q-2', class: 'steering-held', attemptId: 'a-2' }]);
  assert.equal(client.session.sends.length, 1, 'nothing was sent into the hold');
  assert.equal(questionBridge.userInputCalls.length, 1, 'the card is still the one open');

  // The answer re-arms the relay immediately; the re-delivered message steers in.
  answer();
  assert.deepEqual(await asked, { answer: 'staging', wasFreeform: false });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'hold released' });
  assert.deepEqual(readiness, [false, true, false, true]);
  const redelivered = runner.handlePendingPayload({ message: second });
  await waitFor(() => client.session.sends.length === 2, { label: 'steered in' });
  assert.equal(client.session.sends[1].mode, 'immediate');
  assert.equal(await redelivered, true);
  assert.equal(await first, true);
  assert.equal(responsesFor(stub, 'q-2')[0].kind, 'folded');
  assert.deepEqual(responsesFor(stub, 'q-1')[0].consumedSteerIds, [{ id: 'q-2', attemptId: 'a-2' }]);
});

test('against a relay without the hand-back, a held delivery is pushed the legacy way', async () => {
  let answer = () => {};
  const card = new Promise((resolve) => { answer = resolve; });
  const questionBridge = makeFakeQuestionBridge({ onAsk: () => card });
  const { stub, client, runner, first } = await openLiveTurn({
    questionBridge,
    scripts: [(id) => [userMessage(id, 'steering', 'also X'), assistantText('m2', 'and X'), { type: 'assistant.idle', data: {} }]],
    canHandBackHeldDelivery: () => false,
  });
  const asked = client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'which env?' });
  await waitFor(() => runner.isDeliveryHeld() === true, { label: 'card holds' });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'also X' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'pushed despite the hold' });
  assert.equal(stub.bodiesFor('/api/requeue').length, 0, 'nothing to hand back to');
  answer();
  await asked;
  assert.equal(await second, true);
  assert.equal(await first, true);
});

test('a compaction holds steering until it completes, and is narrated', async () => {
  const { stub, client, runner, first, readiness } = await openLiveTurn({ compactionStaleMs: 60_000 });
  client.session.emit({ type: 'session.compaction_start', data: { trigger: 'threshold', currentTokens: 100_000 } });
  await waitFor(() => runner.isDeliveryHeld() === true, { label: 'compaction holds' });
  assert.equal(runner.steeringState().holdReason, 'compaction');
  assert.deepEqual(readiness, [false, true, false]);
  client.session.emit({ type: 'session.compaction_complete', data: { success: true, messagesRemoved: 12, tokensRemoved: 48_000 } });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'compaction done' });
  assert.deepEqual(readiness, [false, true, false, true]);
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  const activities = stub.bodiesFor('/api/activity').map((body) => body.text);
  assert.ok(activities.includes('Compacting the conversation context…'), activities.join(' | '));
  assert.ok(activities.includes('Context compacted (removed 12 messages, 48k tokens)'), activities.join(' | '));
});

test('a compaction that never completes releases its hold after the stale cap', async () => {
  const { client, runner, first } = await openLiveTurn({ compactionStaleMs: 20 });
  client.session.emit({ type: 'session.compaction_start', data: {} });
  await waitFor(() => runner.isDeliveryHeld() === true, { label: 'compaction holds' });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'stale cap released it', timeoutMs: 2_000 });
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
});

// ------------------------------------------------------------------ stop --

test('Stop with steers in flight: the stopped row is left to the relay, every other pushed row settles as stopped', async () => {
  let abortTurn = null;
  const controlPoller = {
    start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return { id: 1 }; },
    stop: () => {},
  };
  const client = scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'working on it')],
    // The first steer is folded into the running turn; the second is never
    // started before the Stop.
    (id) => [userMessage(id, 'steering', 'also X'), assistantText('m2', 'and X')],
    () => [],
  ], {
    onAbort: (session) => session.replay([
      { type: 'abort', data: { reason: 'user_abort' } },
      { type: 'assistant.idle', data: { aborted: true } },
    ]),
  });
  const { stub, runner, first } = await openLiveTurn({ client, controlPoller });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'also X' } });
  await waitFor(() => runner._getState().activeEntries.some((entry) => entry.id === 'q-2' && entry.consumed), { label: 'q-2 folded' });
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'and Y' } });
  await waitFor(() => client.session.sends.length === 3, { label: 'q-3 pushed' });

  await abortTurn({ queueMessageId: 'q-1' });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(await third, true);

  // Targeted: the main turn only.
  assert.deepEqual(client.session.interruptCalls, [{ flushQueued: false }]);
  assert.equal(client.session.abortCalls, 0);
  // The stopped row: partial text, no response (the relay's abort control
  // settles it).
  assert.equal(responsesFor(stub, 'q-1').length, 0);
  const finalStream = stub.bodiesFor('/api/stream').filter((body) => body.messageId === 'q-1').at(-1);
  assert.equal(finalStream.done, true);
  assert.match(finalStream.text, /working on it/);
  // The folded steer and the never-started one both went unanswered.
  assert.equal(responsesFor(stub, 'q-2')[0].kind, 'stopped');
  assert.match(responsesFor(stub, 'q-2')[0].text, /Stopped with the turn/);
  assert.equal(responsesFor(stub, 'q-3')[0].kind, 'stopped');
  // Never requeued: the runtime cleared its lanes; Resend is the user's call.
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
  // The folded one was marked consumed at the fold, not at the Stop.
  assert.deepEqual(stub.bodiesFor('/api/queue-consumed'), [
    { conversationId: 'conv-1', entries: [{ id: 'q-2', attemptId: 'a-2' }] },
  ]);
});

const abortedIdle = (session) => session.replay([
  { type: 'abort', data: { reason: 'user_abort' } },
  { type: 'assistant.idle', data: { aborted: true } },
]);

test('Stop naming a row whose early settle is still publishing stops the run that is live, and never requeues it', async () => {
  let abortTurn = null;
  const controlPoller = { start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return { id: 1 }; }, stop: () => {} };
  const order = [];
  let releaseFirst = () => {};
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  let releaseSecond = () => {};
  const secondResponse = new Promise((resolve) => { releaseSecond = resolve; });
  const stub = makeApiStub({
    routeResponses: {
      '/api/response': (body) => {
        if (body.messageId === 'q-1') return firstResponse.then(() => { order.push('q-1 response landed'); return {}; });
        if (body.messageId === 'q-2') return secondResponse;
        return {};
      },
    },
  });
  const client = scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'first answer')],
    // q-2 runs as a run of its own, so q-1's complete reply settles early.
    (id) => [userMessage(id, 'queued', 'second'), assistantText('m2', 'second, partly')],
  ], { onAbort: abortedIdle });
  const { runner, first } = await openLiveTurn({ stub, client, controlPoller });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'second' } });
  await waitFor(() => responsesFor(stub, 'q-1').length === 1, { label: 'q-1 settled early, its response in flight' });

  // The relay's live-row picker still names q-1.
  const stopping = abortTurn({ queueMessageId: 'q-1' }).then(() => order.push('abort resolved'));
  await waitFor(() => responsesFor(stub, 'q-2').length === 1, { label: 'q-2 settled' });
  // A crash while the stop is publishing must fail q-2, not re-run it.
  assert.ok(runner.getActiveQueueMessageIds().find((entry) => entry.id === 'q-2')?.terminalError);
  releaseSecond({});
  releaseFirst();
  await stopping;
  assert.equal(await first, true);
  assert.equal(await second, true);

  // The ack fails the row it names; q-1's reply is on the relay before it.
  assert.deepEqual(order, ['q-1 response landed', 'abort resolved']);
  assert.equal(responsesFor(stub, 'q-1')[0].text, 'first answer');
  const stopped = responsesFor(stub, 'q-2')[0];
  assert.equal(stopped.terminalError.code, buildRelayStopFailure().code);
  assert.deepEqual(stub.bodiesFor('/api/requeue'), []);
  const finalStream = stub.bodiesFor('/api/stream').filter((body) => body.messageId === 'q-2').at(-1);
  assert.equal(finalStream.done, true);
  assert.match(finalStream.text, /second, partly/);
});

test('a Stop claimed by a turn that is still publishing stops the turn that is running', async () => {
  const pollers = [];
  const controlPoller = { start: ({ onAbortTurn }) => { pollers.push(onAbortTurn); return { id: pollers.length }; }, stop: () => {} };
  let releaseFirst = () => {};
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const stub = makeApiStub({ routeResponses: { '/api/response': (body) => (body.messageId === 'q-1' ? firstResponse : {}) } });
  const client = scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'first answer'), { type: 'assistant.idle', data: {} }],
    (id) => [userMessage(id, 'idle', 'second'), assistantText('m2', 'second, partly')],
  ], { onAbort: abortedIdle });
  const { runner } = makeRunner({ stub, client, controlPoller });
  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => responsesFor(stub, 'q-1').length === 1, { label: 'q-1 publishing' });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'second' } });
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'q-2 live' });
  assert.equal(pollers.length, 2);

  // q-1's poller runs until its publish is done, and claims the Stop for q-2.
  await pollers[0]({ queueMessageId: 'q-2' });
  await waitFor(() => client.session.interruptCalls.length === 1, { label: 'the running turn was interrupted' });
  assert.equal(await second, true);
  assert.deepEqual(client.session.interruptCalls, [{ flushQueued: false }]);
  // A user Stop, not a runtime interrupt: the relay's abort control settles q-2.
  assert.equal(responsesFor(stub, 'q-2').length, 0);
  const finalStream = stub.bodiesFor('/api/stream').filter((body) => body.messageId === 'q-2').at(-1);
  assert.equal(finalStream.done, true);
  assert.equal(finalStream.text, 'second, partly');

  releaseFirst({});
  assert.equal(await first, true);
  assert.equal(responsesFor(stub, 'q-1')[0].text, 'first answer');
});

// --------------------------------------------------------------- un-steer --

test('a pushed prompt still in the queued lane is cancellable; un-steer pulls it out and cancels the row', async () => {
  const { stub, client, runner, first } = await openLiveTurn({ scripts: [() => []] });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'never mind' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'q-2 pushed' });
  const runtimeId = client.session.idOfSend(1);
  // The runtime reports it in the queued lane.
  client.session.queueItems = [{ id: '7', messageId: runtimeId, displayText: 'never mind' }];
  client.session.emit({ type: 'pending_messages.modified', data: {} });
  await waitFor(() => runner.steeringState().cancellableIds.length === 1, { label: 'cancellable' });
  assert.deepEqual(runner.steeringState().cancellableIds, ['q-2']);

  assert.equal(await runner.cancelPushedMessage('q-2'), true);
  assert.deepEqual(client.session.removedQueueItems, ['7']);
  assert.deepEqual(stub.bodiesFor('/api/queue-cancelled'), [{ conversationId: 'conv-1', messageId: 'q-2', attemptId: 'a-2' }]);
  assert.equal(await second, true, 'the delivery resolved');
  assert.deepEqual(runner.getActiveQueueMessageIds().map((entry) => entry.id), ['q-1']);
  assert.deepEqual(runner.steeringState().cancellableIds, []);

  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  assert.equal(responsesFor(stub, 'q-2').length, 0, 'a cancelled row is never answered');
  assert.equal(responsesFor(stub, 'q-1')[0].text, 'working on it');
});

test('un-steer is refused once the runtime has taken the prompt, and on a runtime without rpc.queue', async () => {
  const { client, runner, first, stub } = await openLiveTurn({
    scripts: [(id) => [userMessage(id, 'steering', 'also X')]],
  });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'also X' } });
  await waitFor(() => runner._getState().activeEntries.some((entry) => entry.id === 'q-2' && entry.consumed), { label: 'consumed' });
  assert.equal(await runner.cancelPushedMessage('q-2'), false);
  assert.deepEqual(runner.steeringState().cancellableIds, []);
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(stub.bodiesFor('/api/queue-cancelled').length, 0);

  // No rpc.queue at all: nothing is ever cancellable, nothing throws.
  const old = await openLiveTurn({ client: scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'x')],
    () => [],
  ], { queueRpc: false }) });
  const pushed = old.runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  await waitFor(() => old.client.session.sends.length === 2, { label: 'pushed' });
  old.client.session.emit({ type: 'pending_messages.modified', data: {} });
  await tick(10);
  assert.deepEqual(old.runner.steeringState().cancellableIds, []);
  assert.equal(await old.runner.cancelPushedMessage('q-2'), false);
  assert.equal(old.runner._getState().sessionRpc.queue, false);
  old.client.session.emit({ type: 'assistant.idle', data: {} });
  await old.first;
  await pushed;
});

// ------------------------------------------------------- at-most-once --

test('a fold marker that cannot be saved retries, then fails terminally, then is handed to the heartbeat — never requeued', async () => {
  const calls = [];
  const api = async (method, routePath, body) => {
    calls.push({ routePath, body });
    if (body?.messageId === 'q-2' && (routePath === '/api/response' || routePath === '/api/requeue')) {
      throw new Error('relay down');
    }
    return {};
  };
  api.calls = calls;
  api.bodiesFor = (routePath) => calls.filter((call) => call.routePath === routePath).map((call) => call.body);
  const { client, runner, first } = await openLiveTurn({
    stub: api,
    scripts: [(id) => [userMessage(id, 'steering', 'also X'), assistantText('m2', 'and X'), { type: 'assistant.idle', data: {} }]],
    settleRetryDelaysMs: [1, 1],
    maxTerminalSettleAttempts: 2,
  });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'also X' } });
  assert.equal(await first, true);
  assert.equal(await second, true);

  const q2Responses = api.bodiesFor('/api/response').filter((body) => body.messageId === 'q-2');
  // 1 + 2 retries with the fold marker, then 2 terminal attempts.
  assert.equal(q2Responses.filter((body) => body.kind === 'folded').length, 3);
  const terminal = q2Responses.filter((body) => body.terminalError);
  assert.equal(terminal.length, 2);
  assert.equal(terminal[0].terminalError.code, 'steer-settle-failed');
  assert.match(terminal[0].terminalError.message, /already sent to Copilot/);
  // The requeue route was tried as the second channel, with the terminal
  // error — never a plain requeue.
  const requeues = api.bodiesFor('/api/requeue').filter((body) => body.messageId === 'q-2');
  assert.equal(requeues.length, 2);
  assert.ok(requeues.every((body) => body.terminalError?.code === 'steer-settle-failed'));
  // Still owned, and reported to the heartbeat as settle-failed.
  assert.deepEqual(runner.getSettleFailed().map((entry) => [entry.id, entry.attemptId, entry.terminalError.code]), [['q-2', 'a-2', 'steer-settle-failed']]);
  const owned = runner.getActiveQueueMessageIds().find((entry) => entry.id === 'q-2');
  assert.equal(owned?.terminalError?.code, 'steer-settle-failed');
  runner.acknowledgeSettleFailed(['q-2']);
  assert.deepEqual(runner.getSettleFailed(), []);
  assert.equal(runner.getActiveQueueMessageIds().some((entry) => entry.id === 'q-2'), false);
});

// ---------------------------------------------------------- adoption --

test('a pushed prompt whose run opens after its turn settled is adopted as its own turn, not a continuation', async () => {
  const client = scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'first answer')],
    // The drain's idle raced the send: the turn ends before the prompt runs.
    () => [{ type: 'assistant.idle', data: {} }],
  ]);
  const stub = makeApiStub();
  const { runner, first } = await openLiveTurn({ stub, client, orphanGraceMs: 500 });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'late one' } });
  // The primary's reply is published at once; the orphan is held for the grace.
  await waitFor(() => responsesFor(stub, 'q-1').length === 1, { label: 'primary settled' });
  assert.equal(responsesFor(stub, 'q-2').length, 0, 'the orphan is held during the grace');

  // The runtime opens the prompt's run a moment later.
  const runtimeId = client.session.idOfSend(1);
  client.session.emit(userMessage(runtimeId, 'idle', 'late one'));
  client.session.emit(assistantText('m2', 'late answer'));
  await waitFor(() => runner._getState().activeTurnKind === 'delivered', { label: 'adopted as its own turn' });
  assert.equal(await first, true, 'the first delivery resolves once its turn wrapped up');
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await second, true);
  assert.equal(responsesFor(stub, 'q-2')[0].text, 'late answer');
  assert.equal(responsesFor(stub, 'q-2')[0].kind, undefined);
  assert.equal(stub.bodiesFor('/api/continuation-turn').length, 0, 'not a continuation');
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('a pushed prompt the runtime never opens is noted as carried over once the grace expires', async () => {
  const client = scriptedClient([
    (id) => [userMessage(id, 'idle', 'hello'), assistantText('m1', 'first answer')],
    () => [{ type: 'assistant.idle', data: {} }],
  ]);
  const stub = makeApiStub();
  const { runner, first } = await openLiveTurn({ stub, client, orphanGraceMs: 20 });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'late one' } });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.match(responsesFor(stub, 'q-2')[0].text, /reply continues in the next turn/);
  assert.equal(runner.isTurnActive(), false);
});

// ------------------------------------------------- snapshot & ownership --

test('the steering snapshot names the row whose run is live, and ownership follows every pushed row', async () => {
  const { client, runner, first } = await openLiveTurn({
    scripts: [(id) => [userMessage(id, 'queued', 'second'), assistantText('m2', 'second answer')]],
  });
  assert.equal(runner.steeringState().messageId, 'q-1');
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'second' } });
  await waitFor(() => runner.steeringState().messageId === 'q-2', { label: 'q-2 owns the live run' });
  // q-1's run ended when q-2's opened: settled and released; q-2 still owned.
  assert.equal(await first, true);
  assert.deepEqual(runner.getActiveQueueMessageIds(), [{ id: 'q-2', attemptId: 'a-2' }]);
  assert.equal(runner.getActiveQueueMessageId(), 'q-2');
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await second, true);
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
});

// ------------------------------------------- un-steer, steering lane (live) --
//
// Live check 2026-09-25: immediate sends wait in the runtime's steering lane,
// which has no ids (`pendingItems` reports only their text), so the queued-lane
// path above never triggered. Only the newest waiting one can be removed —
// `queue.removeMostRecent` (fake-provider probe, runtime 1.0.88).

/** Two steers pushed and waiting (not yet injected) in the steering lane. */
async function twoWaitingSteers() {
  const made = await openLiveTurn({ scripts: [() => [], () => []] });
  const { client, runner } = made;
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'first steer' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'q-2 pushed' });
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', attemptId: 'a-3', text: 'second steer' } });
  await waitFor(() => client.session.sends.length === 3, { label: 'q-3 pushed' });
  client.session.steeringLane = [
    { messageId: client.session.idOfSend(1), text: 'first steer' },
    { messageId: client.session.idOfSend(2), text: 'second steer' },
  ];
  client.session.emit({ type: 'pending_messages.modified', data: {} });
  await waitFor(() => runner.steeringState().cancellableIds.length > 0, { label: 'snapshot refreshed' });
  return { ...made, second, third };
}

test('only the newest waiting steer is cancellable, and Cancel removes it with removeMostRecent', async () => {
  const { stub, client, runner, first, second, third } = await twoWaitingSteers();
  assert.deepEqual(runner.steeringState().cancellableIds, ['q-3'], 'the older waiting steer cannot be recalled');
  assert.equal(await runner.cancelPushedMessage('q-2'), false, 'not the newest: refused');
  assert.deepEqual(client.session.removedSteering, []);

  assert.equal(await runner.cancelPushedMessage('q-3'), true);
  assert.deepEqual(client.session.removedSteering, [client.session.idOfSend(2)]);
  assert.deepEqual(stub.bodiesFor('/api/queue-cancelled'), [{ conversationId: 'conv-1', messageId: 'q-3', attemptId: 'a-3' }]);
  assert.equal(await third, true);
  // Now q-2 is the newest waiting one.
  client.session.emit({ type: 'pending_messages.modified', data: {} });
  await waitFor(() => runner.steeringState().cancellableIds.includes('q-2'), { label: 'q-2 now recallable' });

  // q-2 runs after all; nothing is ever answered for q-3.
  client.session.steeringLane = [];
  client.session.emit(userMessage(client.session.idOfSend(1), 'queued', 'first steer'));
  client.session.emit(assistantText('m9', 'answer to the first steer'));
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(responsesFor(stub, 'q-2')[0].text, 'answer to the first steer');
  assert.equal(responsesFor(stub, 'q-3').length, 0);
});

test('a steer the runtime takes while the remove is in flight settles normally, never as cancelled', async () => {
  const { stub, client, runner, first, second, third } = await twoWaitingSteers();
  // The runtime folds q-3 in before answering the remove request.
  client.session.onRemoveMostRecent = (session) => {
    session.emit(userMessage(session.idOfSend(2), 'steering', 'second steer'));
    return { removed: true };
  };
  assert.equal(await runner.cancelPushedMessage('q-3'), false);
  assert.equal(stub.bodiesFor('/api/queue-cancelled').length, 0);
  client.session.onRemoveMostRecent = null;
  client.session.steeringLane = [];
  client.session.emit(userMessage(client.session.idOfSend(1), 'steering', 'first steer'));
  client.session.emit(assistantText('m9', 'handled both'));
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(await third, true);
  assert.equal(responsesFor(stub, 'q-3')[0].kind, 'folded');
});

test('a steer taken while the remove is in flight is not cancelled even when earlier events are still publishing', async () => {
  // The fold's `user.message` reaches the runner before the remove's answer,
  // but its dispatch-chain link waits behind a slow activity publish — so
  // `entry.consumed` is still false when the answer arrives. `removed: true`
  // then means the remove took some other client's newer message, not ours.
  let releaseActivity = () => {};
  const activityGate = new Promise((resolve) => { releaseActivity = resolve; });
  const stub = makeApiStub({ routeResponses: { '/api/activity': () => activityGate } });
  const logs = [];
  const made = await openLiveTurn({ stub, scripts: [() => [], () => []], dbg: (...parts) => logs.push(parts.join(' ')) });
  const { client, runner, first } = made;
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'first steer' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'q-2 pushed' });
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', attemptId: 'a-3', text: 'second steer' } });
  await waitFor(() => client.session.sends.length === 3, { label: 'q-3 pushed' });
  client.session.steeringLane = [
    { messageId: client.session.idOfSend(1), text: 'first steer' },
    { messageId: client.session.idOfSend(2), text: 'second steer' },
  ];
  client.session.emit({ type: 'pending_messages.modified', data: {} });
  await waitFor(() => runner.steeringState().cancellableIds.includes('q-3'), { label: 'q-3 recallable' });

  // A tool line whose publish hangs: every later event queues behind it.
  client.session.emit({ type: 'tool.execution_start', data: { toolCallId: 't1', toolName: 'powershell', arguments: { command: 'Start-Sleep 20' } } });
  await waitFor(() => stub.bodiesFor('/api/activity').length === 1, { label: 'activity publish in flight' });
  client.session.onRemoveMostRecent = (session) => {
    // Both steers fold in, then another client's message is the newest waiting one.
    session.emit(userMessage(session.idOfSend(1), 'steering', 'first steer'));
    session.emit(userMessage(session.idOfSend(2), 'steering', 'second steer'));
    return { removed: true };
  };
  assert.equal(await runner.cancelPushedMessage('q-3'), false);
  assert.equal(stub.bodiesFor('/api/queue-cancelled').length, 0, 'the row was not cancelled');
  assert.ok(logs.some((line) => line.includes('UN-STEER MISMATCH')), logs.join('\n'));

  client.session.onRemoveMostRecent = null;
  client.session.steeringLane = [];
  releaseActivity({});
  client.session.emit(assistantText('m9', 'handled both'));
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(await third, true);
  assert.equal(responsesFor(stub, 'q-3')[0].kind, 'folded');
});

test('a recalled prompt that runs after all is logged loudly', async () => {
  const logs = [];
  const made = await openLiveTurn({ scripts: [() => [], () => []], dbg: (...parts) => logs.push(parts.join(' ')) });
  const { client, runner, first } = made;
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'first steer' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'q-2 pushed' });
  client.session.steeringLane = [{ messageId: client.session.idOfSend(1), text: 'first steer' }];
  client.session.emit({ type: 'pending_messages.modified', data: {} });
  await waitFor(() => runner.steeringState().cancellableIds.includes('q-2'), { label: 'q-2 recallable' });
  // The remove answers `removed: true` but took something else (another
  // client's message pushed in the window); q-2's prompt is still queued.
  client.session.onRemoveMostRecent = () => ({ removed: true });
  assert.equal(await runner.cancelPushedMessage('q-2'), true);
  assert.equal(await second, true);
  assert.equal(logs.some((line) => line.includes('UN-STEER MISMATCH')), false);

  client.session.emit(userMessage(client.session.idOfSend(1), 'steering', 'first steer'));
  await waitFor(() => logs.some((line) => line.includes('UN-STEER MISMATCH') && line.includes('q-2')), { label: 'mismatch logged' });
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
});

test('a newer steer is never blocked by an un-steer, and never overtaken by its remove request', async () => {
  const { client, runner, first } = await twoWaitingSteers();
  let finishRemove = () => {};
  client.session.onRemoveMostRecent = (session) => new Promise((resolve) => {
    finishRemove = () => { session.removedSteering.push(session.steeringLane.pop().messageId); resolve({ removed: true }); };
  });
  const cancelling = runner.cancelPushedMessage('q-3');
  await waitFor(() => client.session.callLog.includes('removeMostRecent'), { label: 'remove issued' });
  // The remove is still unanswered: a new steer goes out anyway, after it.
  const fourth = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-4', text: 'third steer' } });
  await waitFor(() => client.session.sends.length === 4, { label: 'q-4 sent without waiting' });
  const order = client.session.callLog.filter((call) => call === 'removeMostRecent' || call === 'send').slice(-2);
  assert.deepEqual(order, ['removeMostRecent', 'send']);
  finishRemove();
  assert.equal(await cancelling, true);
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  await fourth;
});

test('while a steer send is still unanswered, no newest-recall is offered or attempted', async () => {
  // The runtime may already count the in-flight message as its newest waiting
  // one while this worker cannot name it yet: removeMostRecent would take it.
  const { client, runner, first } = await twoWaitingSteers();
  assert.deepEqual(runner.steeringState().cancellableIds, ['q-3']);
  let resolveSend = () => {};
  const realSend = client.session.send.bind(client.session);
  client.session.send = (options) => new Promise((resolve) => { resolveSend = () => resolve(realSend(options)); });
  const fourth = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-4', text: 'third steer' } });
  await waitFor(() => runner._getState().activeEntries.some((entry) => entry.id === 'q-4'), { label: 'q-4 send in flight' });
  assert.deepEqual(runner.steeringState().cancellableIds, [], 'nothing is offered while a send is unanswered');
  assert.equal(await runner.cancelPushedMessage('q-3'), false);
  assert.equal(client.session.callLog.includes('removeMostRecent'), false, 'no remove was attempted');
  resolveSend();
  await waitFor(() => client.session.sends.length === 4, { label: 'q-4 named' });
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  await fourth;
});

test('two un-steers at once run one after the other, each against a fresh read', async () => {
  const { stub, client, runner, first, second, third } = await twoWaitingSteers();
  const both = await Promise.all([runner.cancelPushedMessage('q-3'), runner.cancelPushedMessage('q-2')]);
  // q-3 (newest) goes first; then q-2 is the newest waiting one and goes too.
  assert.deepEqual(both, [true, true]);
  assert.deepEqual(client.session.removedSteering, [client.session.idOfSend(2), client.session.idOfSend(1)]);
  assert.deepEqual(stub.bodiesFor('/api/queue-cancelled').map((body) => body.messageId), ['q-3', 'q-2']);
  assert.equal(await second, true);
  assert.equal(await third, true);
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
});

test('a runtime without removeMostRecent never offers a newest-recall', async () => {
  const { client, runner, first } = await twoWaitingSteers();
  delete client.session.rpc.queue.removeMostRecent;
  client.session.emit({ type: 'pending_messages.modified', data: {} });
  await runner.whenQueueLaneRefreshed();
  await waitFor(() => runner.steeringState().cancellableIds.length === 0, { label: 'nothing offered' });
  assert.equal(await runner.cancelPushedMessage('q-3'), false);
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
});

test('the worker is told at once when a message becomes, and stops being, cancellable', async () => {
  let changes = 0;
  const made = await openLiveTurn({ scripts: [() => [], () => []], onCancellableChange: () => { changes += 1; } });
  const { client, runner, first } = made;
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'first steer' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'q-2 pushed' });
  client.session.steeringLane = [{ messageId: client.session.idOfSend(1), text: 'first steer' }];
  client.session.emit({ type: 'pending_messages.modified', data: {} });
  await waitFor(() => changes === 1, { label: 'became cancellable' });
  // Same state again: no repeat notification.
  client.session.emit({ type: 'pending_messages.modified', data: {} });
  await runner.whenQueueLaneRefreshed();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(changes, 1);
  // The runtime takes it: no longer cancellable.
  client.session.steeringLane = [];
  client.session.emit(userMessage(client.session.idOfSend(1), 'steering', 'first steer'));
  await waitFor(() => changes === 2, { label: 'stopped being cancellable' });
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  assert.equal(await second, true);
});

// ------------------------------------------------------------ releasable --
// Whether the relay may replace the worker now (its recycle after a deploy):
// the same `releasable` / `releaseHold` / `backgroundTaskCount` fields the
// Claude worker sends, from the runner's idle gates.

const releaseFields = (state) => ({
  releasable: state.releasable,
  releaseHold: state.releaseHold,
  backgroundTaskCount: state.backgroundTaskCount,
});

test('an idle worker is releasable, before its first turn and after a turn has settled', async () => {
  const { stub, client, runner, first } = await openLiveTurn();
  assert.deepEqual(releaseFields(runner.steeringState()), { releasable: false, releaseHold: 'turn', backgroundTaskCount: 0 });
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  await waitFor(() => runner.steeringState().releasable === true, { label: 'released after the turn' });
  assert.deepEqual(releaseFields(runner.steeringState()), { releasable: true, releaseHold: null, backgroundTaskCount: 0 });
  assert.equal(stub.bodiesFor('/api/response').length, 1);

  const fresh = makeRunner({ stub: makeApiStub(), client: createFakeCopilotClient() }).runner;
  assert.deepEqual(releaseFields(fresh.steeringState()), { releasable: true, releaseHold: null, backgroundTaskCount: 0 });
});

test('a turn holds the release from the delivery on, and so does an open question card', async () => {
  let releaseSend = () => {};
  const gate = new Promise((resolve) => { releaseSend = resolve; });
  const client = createFakeCopilotClient();
  const createSession = client.createSession.bind(client);
  client.createSession = async (config) => {
    const session = await createSession(config);
    const send = session.send.bind(session);
    session.send = async (options) => { await gate; return send(options); };
    return session;
  };
  const { runner } = makeRunner({ stub: makeApiStub(), client });
  const first = runner.handlePendingPayload({ message: baseMessage });
  // The prompt is not even sent yet: the delivery is a turn all the same.
  assert.deepEqual(releaseFields(runner.steeringState()), { releasable: false, releaseHold: 'turn', backgroundTaskCount: 0 });
  releaseSend();
  await waitFor(() => runner.canAcceptSteering() === true, { label: 'send resolved' });
  assert.equal(runner.steeringState().releaseHold, 'turn');
  client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await first, true);
  assert.equal(runner.steeringState().releasable, true);

  let answer = () => {};
  const card = new Promise((resolve) => { answer = resolve; });
  const questionBridge = makeFakeQuestionBridge({ userInputAnswer: 'staging', onAsk: () => card });
  const live = await openLiveTurn({ questionBridge });
  const asked = live.client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'which env?', choices: ['prod', 'staging'] });
  await waitFor(() => live.runner.steeringState().releaseHold === 'question', { label: 'card holds the release' });
  assert.equal(live.runner.steeringState().releasable, false);
  answer();
  await asked;
  await waitFor(() => live.runner.steeringState().releaseHold === 'turn', { label: 'the turn holds it after the answer' });
  live.client.session.emit({ type: 'assistant.idle', data: {} });
  assert.equal(await live.first, true);
  assert.equal(live.runner.steeringState().releasable, true);
});

test('a live background agent holds the release after its turn settled, and is counted', async () => {
  const agent = {
    type: 'agent', id: 'agent-1', toolCallId: 'call_1_0', displayName: 'bg-probe', description: 'background probe',
    status: 'running', agentType: 'general-purpose', executionMode: 'background', startedAt: new Date().toISOString(),
  };
  const client = createFakeCopilotClient({
    tasksRpc: true,
    taskList: [agent],
    onSend: (session, _options, messageId) => {
      if (session.sends.length !== 1) return;
      session.replay([
        userMessage(messageId, 'idle', 'hello'),
        assistantText('m1', 'Main: spawned.'),
        { type: 'session.background_tasks_changed', data: {} },
        { type: 'assistant.idle', data: {} },
      ]);
    },
  });
  const { runner } = makeRunner({
    stub: makeContinuationApiStub(),
    client,
    taskRefreshMs: 1,
    taskPublishThrottleMs: 1,
    continuationRetryDelayMs: 1,
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  await waitFor(() => runner.steeringState().releaseHold === 'background', { label: 'the agent holds the release' });
  assert.deepEqual(releaseFields(runner.steeringState()), { releasable: false, releaseHold: 'background', backgroundTaskCount: 1 });
  assert.equal(runner.steeringState().turnActive, false);

  // The agent finishes: nothing holds the worker any more.
  client.session.taskList[0].status = 'completed';
  client.session.emit({ type: 'session.background_tasks_changed', data: {} });
  await tick(5);
  await runner.whenTasksRefreshed();
  await waitFor(() => runner.steeringState().releasable === true, { label: 'released after the agent' });
  assert.deepEqual(releaseFields(runner.steeringState()), { releasable: true, releaseHold: null, backgroundTaskCount: 0 });
  await runner.dispose();
});

/** A client whose first send runs a whole turn: the prompt, a reply, idle. */
function oneTurnClient(clientOptions = {}) {
  return createFakeCopilotClient({
    ...clientOptions,
    onSend: (session, _options, messageId) => {
      if (session.sends.length !== 1) return;
      session.replay([userMessage(messageId, 'idle', 'hello'), assistantText('m1', 'ok'), { type: 'assistant.idle', data: {} }]);
    },
  });
}

test('a registry read that is due or on its way holds the release: whether a task lives is not known', async () => {
  const client = oneTurnClient({ tasksRpc: true, taskList: [] });
  const { runner } = makeRunner({
    stub: makeApiStub(),
    client,
    // Long enough to see the debounced read before it asks the runtime.
    taskRefreshMs: 40,
    taskPublishThrottleMs: 1,
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  await waitFor(() => runner.steeringState().releasable === true, { label: 'idle after the turn' });

  // The next read answers only when the test says so.
  let answer = () => {};
  const listed = new Promise((resolve) => { answer = resolve; });
  const tasksRpc = client.session.rpc.tasks;
  const list = tasksRpc.list.bind(tasksRpc);
  let asked = 0;
  tasksRpc.list = async () => { asked += 1; await listed; return list(); };

  client.session.emit({ type: 'session.background_tasks_changed', data: {} });
  await waitFor(() => runner.steeringState().releasable === false, { label: 'the due read holds' });
  assert.equal(asked, 0, 'the read is still debounced');
  assert.deepEqual(releaseFields(runner.steeringState()), { releasable: false, releaseHold: 'background', backgroundTaskCount: 0 });
  assert.equal(runner.steeringState().turnActive, false);

  await waitFor(() => asked === 1, { label: 'the read asks the runtime' });
  assert.deepEqual(releaseFields(runner.steeringState()), { releasable: false, releaseHold: 'background', backgroundTaskCount: 0 });

  answer();
  await waitFor(() => runner.steeringState().releasable === true, { label: 'released once the read answered' });
  assert.equal(runner.steeringState().releaseHold, null);
  await runner.dispose();
});

// `cliAlive` is the second half of what the relay's recycle reads: it
// replaces a stale worker only when it is releasable AND its runtime process
// is gone. Releasable with the runtime up is the idle window (a scheduled job
// may still wake the session), so the relay waits for the idle shutdown.
test('cliAlive: no runtime before the first turn; up between turns while releasable, the pair the relay waits on', async () => {
  const fresh = makeRunner({ stub: makeApiStub(), client: createFakeCopilotClient() }).runner;
  assert.equal(fresh.steeringState().cliAlive, false);

  const client = oneTurnClient();
  // Far beyond the test: the runtime stays in its idle window throughout.
  const { runner } = makeRunner({ stub: makeApiStub(), client, idleShutdownMs: 60_000, lifecyclePollMs: 5 });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  // The turn settled, the runtime is up, and nothing new arrives: a session
  // whose scheduled job is due inside the idle window looks exactly so.
  await waitFor(() => runner.steeringState().releasable === true, { label: 'releasable after the turn' });
  await tick(30);
  const between = runner.steeringState();
  assert.equal(between.releasable, true);
  assert.equal(between.releaseHold, null);
  assert.equal(between.cliAlive, true);
  assert.equal(client.stopped, 0, 'the runtime has not idled out');
  await runner.dispose();
});

test('cliAlive turns false once the runtime idles out', async () => {
  const client = oneTurnClient();
  const { runner } = makeRunner({ stub: makeApiStub(), client, idleShutdownMs: 20, lifecyclePollMs: 5 });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(runner.steeringState().cliAlive, true);
  await waitFor(() => runner._getState().hasClient === false, { label: 'idle shutdown' });
  const gone = runner.steeringState();
  assert.equal(gone.cliAlive, false);
  assert.equal(gone.releasable, true);
  await runner.dispose();
});
