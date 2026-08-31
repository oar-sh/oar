// Self-initiated ("continuation") turns: the runtime re-invoking the model with
// nobody having asked it to.
//
// The whole file is driven from ONE live capture — session 10a1a9ad,
// 2026-08-31, gpt-5.6-luna, "please set a timer to 1 minute and let me know
// when the timer fired" — split into the two fixtures it actually produced:
//
//   background-timer-turn.json         the delivered turn: bash{detach:true}
//                                      → "Timer set for 1 minute." → idle
//   background-timer-continuation.json 60s later, with NO active turn:
//                                      system.notification{shell_detached_completed}
//                                      → turn_start → read_bash
//                                      → "⏰ The 1-minute timer fired." → idle
//
// Before this change the second fixture's events were dropped on the floor
// (`routeEvent` returned early with no active turn) and the user never saw the
// reply they had been promised.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  createFakeCopilotClient,
  loadFixture,
  makeApiStub,
  makeContinuationApiStub,
  makeRunner,
  waitFor,
} from './copilot-sdk-test-harness.mjs';
import { CONTINUATION_TRIGGER } from './copilot-sdk-session-process.mjs';

const TIMER_TURN = loadFixture('background-timer-turn');
const TIMER_CONTINUATION = loadFixture('background-timer-continuation');
const TIMER_REPLY = '⏰ The 1-minute timer fired.';

const bodiesFor = (stub, route) => stub.bodiesFor(route);
const responsesFor = (stub, messageId) => bodiesFor(stub, '/api/response')
  .filter((body) => body.messageId === messageId);

/**
 * A runner whose delivered turn replays `events`, wired to an api stub that
 * mints synthetic rows like the relay's `/api/continuation-turn` route.
 */
function setup({
  events = TIMER_TURN,
  stub = makeContinuationApiStub(),
  clientOptions = {},
  // The FIRST send only, by default. A steering test sends a second prompt into
  // a live interaction, and replaying the delivered fixture again would answer
  // it with the first turn's transcript AND close the interaction underneath
  // the continuation — which is not what the runtime does. Tests that deliver a
  // second SEPARATE turn set this instead; without it that turn never sees a
  // terminator and sits out the whole 120 s stall watchdog before passing.
  replayEverySend = false,
  ...overrides
} = {}) {
  const client = createFakeCopilotClient({
    onSend: (session) => {
      if (replayEverySend || session.sends.length === 1) session.replay(events);
    },
    ...clientOptions,
  });
  const { runner } = makeRunner({ stub, client, continuationRetryDelayMs: 1, ...overrides });
  return { stub, client, runner };
}

/** Push the out-of-turn events the runtime produced when the timer fired. */
function fireTimer(client, events = TIMER_CONTINUATION) {
  client.session.replay(events);
}

// ------------------------------------------------------------- the finding --

test('a turn the runtime starts by itself becomes a continuation row and publishes its reply', async () => {
  const { stub, client, runner } = setup();

  // 1. The delivered turn settles normally — that part was already correct.
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  const delivered = responsesFor(stub, 'q-1');
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /Timer set for 1 minute/);
  assert.equal(runner.isTurnActive(), false);
  // The detached shell is still running, and the worker knows it.
  assert.equal(runner._getState().backgroundShells.length, 1);

  // 2. A minute later the runtime re-invokes the model on its own.
  fireTimer(client);
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });

  // A synthetic row was requested, with the fields the relay route reads.
  const registrations = bodiesFor(stub, '/api/continuation-turn');
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0], {
    conversationId: 'conv-1',
    sdkSessionId: 'conv-1',
    relayMode: 'agent',
    trigger: CONTINUATION_TRIGGER,
  });

  // 3. The reply landed IN that row — the thing the live session lost.
  const continuation = responsesFor(stub, 'cont-1')[0];
  assert.equal(continuation.conversationId, 'conv-1');
  assert.equal(continuation.text, TIMER_REPLY);
  assert.equal(continuation.model, 'gpt-5.6-luna');
  assert.equal(continuation.terminalError, undefined);

  // ...and nothing was cross-published into the user's already-settled row.
  assert.equal(responsesFor(stub, 'q-1').length, 1);
  assert.equal(
    bodiesFor(stub, '/api/stream').filter((b) => b.messageId === 'q-1' && b.text.includes(TIMER_REPLY)).length,
    0,
  );

  // The shell is closed again, and the turn released.
  assert.equal(runner._getState().backgroundShells.length, 0);
  assert.equal(runner.isTurnActive(), false);
  await runner.dispose();
});

test('a continuation streams and narrates into its own row', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  fireTimer(client);
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });

  const streams = bodiesFor(stub, '/api/stream').filter((body) => body.messageId === 'cont-1');
  assert.ok(streams.length >= 1);
  assert.equal(streams.every((body) => body.conversationId === 'conv-1'), true);
  assert.equal(streams[streams.length - 1].done, true);
  assert.equal(streams[streams.length - 1].text, TIMER_REPLY);

  const activities = bodiesFor(stub, '/api/activity').filter((body) => body.messageId === 'cont-1');
  // The settled-shell notification arrived BEFORE the row existed; it belongs
  // to the turn it triggered rather than being dropped.
  assert.ok(
    activities.some((body) => /Background shell 1 finished/.test(body.text)),
    `expected the settled-shell note, got ${JSON.stringify(activities.map((a) => a.text))}`,
  );
  // ...and it comes first, ahead of the tool line the turn itself produced.
  assert.match(activities[0].text, /Background shell 1 finished/);
  assert.ok(activities.some((body) => /read_bash|Read shell output/i.test(body.text)));
  await runner.dispose();
});

test('a continuation reports its usage through the same ingest as a delivered turn', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  // `assistant.usage` is ephemeral, so it is absent from the durable capture
  // the fixtures were cut from; the live stream carries one per model call.
  fireTimer(client, TIMER_CONTINUATION.slice(0, -1));
  client.session.emit({
    type: 'assistant.usage',
    ephemeral: true,
    data: { model: 'gpt-5.6-luna', inputTokens: 18, outputTokens: 12, cost: 1, totalNanoAiu: 431492000 },
  });
  client.session.emit({ type: 'session.idle', data: {} });
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });
  await runner.whenUsagePosted();

  const usage = runner.getLastTurnUsage();
  assert.equal(usage.messageId, 'cont-1');
  assert.equal(usage.model, 'gpt-5.6-luna');
  // The ingest POST rides the same fire-and-forget chain; a continuation spends
  // real quota (the live capture burned a premium request on it).
  const posted = bodiesFor(stub, '/api/copilot-plan-usage');
  assert.equal(posted[posted.length - 1].messageId, 'cont-1');
  await runner.dispose();
});

test('the heartbeat claims the synthetic row, or the relay recovers it mid-flight', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);

  fireTimer(client, TIMER_CONTINUATION.slice(0, -1)); // everything but session.idle
  await waitFor(() => runner.getActiveQueueMessageIds().length === 1, { label: 'continuation owned' });
  assert.deepEqual(runner.getActiveQueueMessageIds(), ['cont-1']);
  assert.equal(runner.getActiveQueueMessageId(), 'cont-1');
  assert.equal(runner._getState().activeTurnKind, 'continuation');

  client.session.emit({ type: 'session.idle', data: {} });
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
  await runner.dispose();
});

test('only the events that start work open a row — a stray terminator does not', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  // A late terminator, a usage checkpoint and a background-tasks ping all
  // arrive with no turn open. None of them is work.
  client.session.emit({ type: 'session.idle', data: {} });
  client.session.emit({ type: 'session.usage_checkpoint', data: { totalNanoAiu: 1 } });
  client.session.emit({ type: 'session.background_tasks_changed', data: {} });
  client.session.emit({ type: 'session.shutdown', data: { shutdownType: 'routine' } });
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  assert.deepEqual(bodiesFor(stub, '/api/continuation-turn'), []);
  assert.equal(runner.isTurnActive(), false);
  await runner.dispose();
});

// ------------------------------------------------------- replay suppression --

test('a resume replaying history mints no continuation rows', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  // The runtime replays the session's persisted events through the same
  // callback on resume. Every one of them is older than `resumeTime` — and one
  // is a durable `assistant.message` that, taken as new work, would mint a row
  // and republish an answer the relay already has.
  client.session.emit({
    type: 'session.resume',
    timestamp: '2026-08-31T15:00:00.100Z',
    data: { resumeTime: '2026-08-31T15:00:00.000Z', eventCount: TIMER_CONTINUATION.length, selectedModel: 'gpt-5.6-luna' },
  });
  client.session.replay(TIMER_CONTINUATION);
  await new Promise((resolve) => { setTimeout(resolve, 20); });

  assert.deepEqual(bodiesFor(stub, '/api/continuation-turn'), []);
  assert.equal(responsesFor(stub, 'cont-1').length, 0);
  assert.equal(runner.isTurnActive(), false);
  // The replay is also kept out of the shell tracker: it describes a shell that
  // already came and went.
  assert.equal(runner._getState().backgroundShells.length, 1, 'the live shell set is untouched by replay');
  await runner.dispose();
});

test('live work after a replay still opens a continuation', async () => {
  // The other direction: the replay window must close, or resume permanently
  // silences the worker.
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  client.session.emit({
    type: 'session.resume',
    timestamp: '2026-08-31T15:00:00.100Z',
    data: { resumeTime: '2026-08-31T15:00:00.000Z', eventCount: 50 },
  });
  client.session.replay(TIMER_CONTINUATION); // historical timestamps, suppressed
  // Now the same events with LIVE timestamps.
  client.session.replay(TIMER_CONTINUATION.map((event) => ({ ...event, timestamp: '2026-08-31T15:00:01.000Z' })));

  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });
  assert.equal(bodiesFor(stub, '/api/continuation-turn').length, 1);
  assert.equal(responsesFor(stub, 'cont-1')[0].text, TIMER_REPLY);
  await runner.dispose();
});

// --------------------------------------------------------- lifecycle pinning --

test('idle shutdown never stops a runtime with a background shell running', async () => {
  // Stopping the runtime kills its detached children, so an idle sweep here
  // would destroy the very command the user is waiting on.
  const { client, runner } = setup({ idleShutdownMs: 5, lifecyclePollMs: 5 });
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(runner._getState().backgroundShells.length, 1);

  await new Promise((resolve) => { setTimeout(resolve, 30); });
  runner._evaluateLifecycle();
  assert.equal(runner._getState().hasClient, true, 'the live shell pins the runtime');
  assert.equal(client.stopped, 0);
  await runner.dispose();
});

test('a settled shell holds the runtime open until its continuation arrives', async () => {
  const { stub, client, runner } = setup({ idleShutdownMs: 5, lifecyclePollMs: 5, continuationGraceMs: 60_000 });
  await runner.handlePendingPayload({ message: baseMessage });

  // Just the notification: the shell is finished, so nothing is running — but
  // the runtime is about to re-invoke the model, and closing it in that gap
  // loses the reply.
  client.session.emit(TIMER_CONTINUATION[0]);
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  runner._evaluateLifecycle();
  assert.equal(runner._getState().backgroundShells.length, 0);
  assert.equal(runner._getState().hasClient, true, 'the due continuation pins the runtime');

  client.session.replay(TIMER_CONTINUATION.slice(1));
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });
  await runner.dispose();
});

test('a continuation that never arrives stops pinning after the grace window', async () => {
  // The runtime notified and then decided it had nothing to say. Without this
  // backstop the runtime would be held open until the process died.
  const { client, runner } = setup({ idleShutdownMs: 5, lifecyclePollMs: 5, continuationGraceMs: 15 });
  await runner.handlePendingPayload({ message: baseMessage });
  client.session.emit(TIMER_CONTINUATION[0]);

  await waitFor(() => runner._getState().hasClient === false, { label: 'idle shutdown after grace' });
  assert.equal(client.stopped, 1);
  await runner.dispose();
});

test('the background-task cap stops a forgotten shell from pinning the runtime forever', async () => {
  const { client, runner } = setup({
    idleShutdownMs: 5,
    lifecyclePollMs: 5,
    continuationGraceMs: 5,
    // The knob's normal value is 30 minutes; a shell nobody will ever hear
    // back from must not outlive it.
    getBackgroundTaskTimeoutMs: () => 20,
  });
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(runner._getState().backgroundShells.length, 1);

  await waitFor(() => runner._getState().hasClient === false, { label: 'idle shutdown after the cap' });
  assert.equal(client.stopped, 1);
  await runner.dispose();
});

test('a cap of 0 means no limit, exactly like the sibling timeouts', async () => {
  const { client, runner } = setup({
    idleShutdownMs: 5,
    lifecyclePollMs: 5,
    continuationGraceMs: 5,
    getBackgroundTaskTimeoutMs: () => 0,
  });
  await runner.handlePendingPayload({ message: baseMessage });

  await new Promise((resolve) => { setTimeout(resolve, 40); });
  runner._evaluateLifecycle();
  assert.equal(runner._getState().hasClient, true);
  assert.equal(client.stopped, 0);
  await runner.dispose();
});

test('stopping the runtime forgets its shells rather than pinning the next one', async () => {
  const { client, runner } = setup({
    idleShutdownMs: 5,
    lifecyclePollMs: 5,
    continuationGraceMs: 5,
    getBackgroundTaskTimeoutMs: () => 10,
  });
  await runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasClient === false, { label: 'idle shutdown' });
  // The shells were children of the process that just ended.
  assert.deepEqual(runner._getState().backgroundShells, []);
  assert.equal(runner._getState().continuationDueSince, 0);
  assert.equal(client.stopped, 1);
  await runner.dispose();
});

// ------------------------------------------------- steering vs continuation --

test('a user message delivered during a continuation gets its own row and its own answer', async () => {
  // The single-flight delivery socket makes this rare, but it is reachable on a
  // socket reconnect — and it is the one path where two rows are open at once
  // with only one `session.idle` to close them both.
  const steeredReply = 'And here is the answer to your new question.';
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  // Open the continuation but do not let it terminate yet.
  fireTimer(client, TIMER_CONTINUATION.slice(0, -1));
  await waitFor(() => runner._getState().activeTurnKind === 'continuation', { label: 'continuation open' });

  const delivery = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'what time is it?' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'steered send' });
  assert.equal(client.session.sends[1].mode, 'enqueue');

  // The runtime picks the steered prompt up: a new `user.message` segment, its
  // own reply, and ONE `session.idle` closing the whole interaction.
  client.session.emit({ type: 'user.message', data: { content: 'what time is it?' } });
  client.session.emit({
    type: 'assistant.message',
    data: { messageId: 'steered-1', model: 'gpt-5.6-luna', content: steeredReply, toolRequests: [] },
  });
  client.session.emit({ type: 'session.idle', data: {} });

  assert.equal(await delivery, true);
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });

  // Each row is answered from its OWN prompt segment: the continuation owns the
  // implicit segment 0, the steered prompt opens segment 1.
  assert.equal(responsesFor(stub, 'cont-1')[0].text, TIMER_REPLY);
  assert.equal(responsesFor(stub, 'q-2')[0].text, steeredReply);
  // No cross-publishing in either direction.
  assert.ok(!responsesFor(stub, 'cont-1')[0].text.includes(steeredReply));
  assert.ok(!responsesFor(stub, 'q-2')[0].text.includes(TIMER_REPLY));
  await runner.dispose();
});

test('a delivery during a continuation never wedges the delivery socket', async () => {
  // `steerIntoActiveTurn` awaits the row's settle. If a continuation could end
  // without settling the rows steered into it, `onDeliver` would never resolve
  // and the relay would stop delivering to this worker entirely.
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  fireTimer(client, TIMER_CONTINUATION.slice(0, -1));
  await waitFor(() => runner._getState().activeTurnKind === 'continuation', { label: 'continuation open' });

  const delivery = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'steered send' });

  // The interaction ends without the runtime ever picking the steered prompt
  // up, which is what the single `session.idle` makes possible.
  client.session.emit({ type: 'session.idle', data: {} });

  assert.equal(await delivery, true, 'the delivery resolved rather than hanging');
  const steered = responsesFor(stub, 'q-2')[0];
  // Not requeued: the prompt is still in the runtime's pending queue, so a
  // redelivery would run it twice.
  assert.deepEqual(bodiesFor(stub, '/api/requeue'), []);
  assert.match(steered.text, /continues in the next turn/);
  await runner.dispose();
});

test('a continuation with nothing steered into it leaves the next turn unshifted', async () => {
  // The carried-prompt arithmetic has to know a continuation sent no prompt.
  // Getting it wrong shifts the NEXT delivered turn's segment and answers the
  // user's row with the wrong text.
  const { stub, client, runner } = setup({ events: [] });
  // First turn: no segments at all, then a bare terminator.
  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });
  client.session.emit({ type: 'user.message', data: { content: 'hello' } });
  client.session.emit({
    type: 'assistant.message',
    data: { messageId: 'm1', model: 'gpt-5-mini', content: 'first answer', toolRequests: [] },
  });
  client.session.emit({ type: 'session.idle', data: {} });
  assert.equal(await first, true);

  // A continuation that produces a reply and settles.
  client.session.emit({ type: 'assistant.turn_start', data: { turnId: '0' } });
  client.session.emit({
    type: 'assistant.message',
    data: { messageId: 'm2', model: 'gpt-5-mini', content: 'a continuation reply', toolRequests: [] },
  });
  client.session.emit({ type: 'session.idle', data: {} });
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });

  // The next delivered turn must be answered with its own text, not shifted.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3' } });
  await waitFor(() => client.session.sends.length === 2, { label: 'second send' });
  client.session.emit({ type: 'user.message', data: { content: 'hello again' } });
  client.session.emit({
    type: 'assistant.message',
    data: { messageId: 'm3', model: 'gpt-5-mini', content: 'second answer', toolRequests: [] },
  });
  client.session.emit({ type: 'session.idle', data: {} });
  assert.equal(await second, true);
  assert.equal(responsesFor(stub, 'q-3')[0].text, 'second answer');
  await runner.dispose();
});

// ------------------------------------------------------- degraded relay ------

test('a relay that will not mint a row drops the output instead of failing the worker', async () => {
  const stub = makeApiStub({ failRoutes: new Set(['/api/continuation-turn']) });
  const { client, runner } = setup({ stub, replayEverySend: true });
  await runner.handlePendingPayload({ message: baseMessage });
  const beforeResponses = bodiesFor(stub, '/api/response').length;
  const beforeStreams = bodiesFor(stub, '/api/stream').length;

  fireTimer(client);
  await waitFor(() => runner.isTurnActive() === false && bodiesFor(stub, '/api/continuation-turn').length === 3, {
    label: 'registration gave up',
  });

  // Three attempts, then the turn's relay output is discarded — it still lands
  // in the runtime's own transcript, and the worker is still healthy. Nothing
  // is published against a null message id, and nothing bleeds into the
  // delivered row that already settled.
  assert.equal(bodiesFor(stub, '/api/continuation-turn').length, 3);
  assert.equal(bodiesFor(stub, '/api/response').length, beforeResponses);
  assert.equal(bodiesFor(stub, '/api/stream').length, beforeStreams);
  const publishRoutes = new Set(['/api/response', '/api/stream', '/api/activity', '/api/thought', '/api/subagent-run']);
  assert.equal(
    stub.calls.some((call) => publishRoutes.has(call.routePath) && !call.body?.messageId),
    false,
    'nothing may publish against the continuation row that was never created',
  );

  // Still able to run a normal turn afterwards.
  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } }), true);
  assert.equal(responsesFor(stub, 'q-2').length, 1);
  await runner.dispose();
});

test('a relay that answers without a message id is retried, then honoured', async () => {
  // A truthy-but-empty body must not end the retry loop early.
  let attempt = 0;
  const stub = makeApiStub({
    routeResponses: {
      '/api/continuation-turn': () => {
        attempt += 1;
        return attempt < 2 ? { ok: true } : { ok: true, messageId: 'cont-9', conversationId: 'conv-1' };
      },
    },
  });
  const { client, runner } = setup({ stub });
  await runner.handlePendingPayload({ message: baseMessage });

  fireTimer(client);
  await waitFor(() => responsesFor(stub, 'cont-9').length === 1, { label: 'continuation response' });
  assert.equal(bodiesFor(stub, '/api/continuation-turn').length, 2);
  assert.equal(responsesFor(stub, 'cont-9')[0].text, TIMER_REPLY);
  await runner.dispose();
});

test('a relay that never answers gives up on the row rather than publishing to a null id', async () => {
  // The registration can also fail by never settling. The drive path's
  // invariant is the message id, not the "discarded" flag, because a POST
  // carrying `messageId: null` is attributed to nothing at all.
  const stub = makeApiStub({
    routeResponses: { '/api/continuation-turn': () => new Promise(() => {}) },
  });
  const { client, runner } = setup({ stub, continuationRegistrationTimeoutMs: 30 });
  await runner.handlePendingPayload({ message: baseMessage });
  const beforeResponses = bodiesFor(stub, '/api/response').length;

  fireTimer(client);
  await waitFor(() => runner.isTurnActive() === false, { label: 'continuation abandoned' });

  assert.equal(bodiesFor(stub, '/api/response').length, beforeResponses);
  const publishRoutes = new Set(['/api/response', '/api/stream', '/api/activity']);
  assert.equal(stub.calls.some((call) => publishRoutes.has(call.routePath) && !call.body?.messageId), false);
  await runner.dispose();
});

test('a row that exists still gets its answer when the bookkeeping after it throws', async () => {
  // Registration succeeded and only the control-poller start blew up. The turn
  // has somewhere to go, so its buffered output is released rather than binned.
  const stub = makeContinuationApiStub();
  const { client, runner } = setup({
    stub,
    controlPoller: {
      start: ({ queueMessageId }) => {
        if (String(queueMessageId).startsWith('cont-')) throw new Error('control poller unavailable');
        return { queueMessageId };
      },
      stop: () => {},
    },
  });
  await runner.handlePendingPayload({ message: baseMessage });

  fireTimer(client);
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });
  assert.equal(responsesFor(stub, 'cont-1')[0].text, TIMER_REPLY);
  await runner.dispose();
});

test('the continuation inherits the relay mode of the turn it continues', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'autopilot' } });
  fireTimer(client);
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'continuation response' });
  assert.equal(bodiesFor(stub, '/api/continuation-turn')[0].relayMode, 'autopilot');
  await runner.dispose();
});

test('a continuation that stalls fails its own row rather than holding it open', async () => {
  const { stub, client, runner } = setup({ turnStallTimeoutMs: 30 });
  await runner.handlePendingPayload({ message: baseMessage });

  // Open a continuation and then go silent.
  fireTimer(client, TIMER_CONTINUATION.slice(0, 3));
  await waitFor(() => responsesFor(stub, 'cont-1').length === 1, { label: 'stall failure' });

  const failed = responsesFor(stub, 'cont-1')[0];
  assert.equal(failed.terminalError.kind, 'copilot-turn-failed');
  assert.match(failed.text, /Retry or send a new message/);
  assert.equal(runner.isTurnActive(), false);
  await runner.dispose();
});
