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
  makeFakeQuestionBridge,
  makeRunner,
  tick,
  waitFor,
} from './copilot-sdk-test-harness.mjs';

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
