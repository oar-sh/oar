import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAKE_SDK_PATHS,
  baseMessage,
  createFakeCopilotClient,
  eventsThrough,
  expectedPromptPrefix,
  loadFixture,
  makeApiStub,
  makeFakeQuestionBridge,
  makeRunner,
  promptWithPrefix,
  tick,
  waitFor,
} from './copilot-sdk-test-harness.mjs';
import { USER_INPUT_UNSUPPORTED_ANSWER } from './copilot-sdk-adapter.mjs';
import { RUNTIME_INTERRUPTED_NOTE } from './copilot-sdk-session-process.mjs';

const bodyOf = (stub, route) => stub.bodiesFor(route)[0] || null;
const lastBodyOf = (stub, route) => stub.bodiesFor(route).slice(-1)[0] || null;

/** A runner wired to a fake client that replays `events` when a prompt lands. */
function setup({ events = loadFixture('happy-turn'), clientOptions = {}, ...overrides } = {}) {
  const stub = makeApiStub(overrides.apiStubOptions);
  delete overrides.apiStubOptions;
  const client = createFakeCopilotClient({
    onSend: (session) => session.replay(events),
    ...clientOptions,
  });
  const { runner, started, questionBridge } = makeRunner({ stub, client, ...overrides });
  return { stub, client, runner, started, questionBridge };
}

test('a happy turn publishes streamed text and a completed response', async () => {
  const { stub, client, runner, started } = setup();

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  // Client start is lazy: nothing spawns until the first delivery.
  assert.equal(started.length, 1);
  assert.equal(started[0].paths, FAKE_SDK_PATHS);

  // Streaming has to be requested explicitly — the SDK default is off and
  // yields no deltas at all.
  const config = client.createAttempts[0];
  assert.equal(config.streaming, true);
  assert.equal(config.sessionId, 'conv-1');
  assert.equal(config.model, 'gpt-5-mini');
  assert.equal(config.workingDirectory, '/tmp/relay-fixture-workspace');

  const streams = stub.bodiesFor('/api/stream');
  assert.ok(streams.length >= 2);
  assert.equal(streams.every((body) => body.messageId === 'q-1' && body.conversationId === 'conv-1'), true);

  // The final stream is always published from the result, even when the emit
  // gating suppressed the last incremental update.
  const final = streams[streams.length - 1];
  assert.equal(final.done, true);
  assert.equal(final.text, 'SPIKE_OK');

  const response = bodyOf(stub, '/api/response');
  assert.equal(response.text, 'SPIKE_OK');
  assert.equal(response.messageId, 'q-1');
  assert.equal(response.modelOrigin, 'manual');
  assert.equal(response.terminalError, undefined);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('send takes ONE MessageOptions object, prompt and agentMode included', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  // `send(options)` has no second parameter: anything passed positionally is
  // dropped on the floor by the real SDK.
  assert.equal(client.session.sends.length, 1);
  assert.deepEqual(client.session.sends[0], {
    prompt: promptWithPrefix('hello'),
    // "immediate", always: mid-turn it is a real steer, and when the main loop
    // is idle it starts at once even while background work keeps the
    // session-level idle deferred ("enqueue" freezes there — probe 2026-09-25).
    mode: 'immediate',
    agentMode: 'interactive',
  });
});

test('the turn does not settle on assistant.turn_end, only on session.idle', async () => {
  const events = loadFixture('tool-permission-turn');
  const { stub, runner } = setup({ events });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  // This fixture ends the first model call (turn_end) before the tool runs;
  // settling there would publish a reply that is missing the real answer.
  assert.equal(events.filter((e) => e.type === 'assistant.turn_end').length, 2);
  const activities = stub.bodiesFor('/api/activity').map((b) => b.text);
  assert.ok(activities.some((text) => text.startsWith('Tool (bash):')), activities.join(' | '));
  assert.ok(bodyOf(stub, '/api/response').text.length > 0);
  assert.equal(stub.bodiesFor('/api/response').length, 1);
});

test('a turn that ends before session.idle never publishes a response', async () => {
  // Everything up to the last turn_end but no idle: the row stays open rather
  // than being settled on a per-model-call boundary.
  const events = eventsThrough(loadFixture('happy-turn'), 'assistant.turn_end');
  const { stub, client, runner } = setup({ events });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => stub.bodiesFor('/api/stream').length > 0, { label: 'streamed text' });
  assert.equal(stub.bodiesFor('/api/response').length, 0);
  assert.equal(runner.isTurnActive(), true);

  // The late terminator settles it, and only then does the row get a response.
  client.session.emit({ type: 'session.idle', data: { mode: 'interactive' } });
  assert.equal(await pending, true);
  assert.equal(stub.bodiesFor('/api/response').length, 1);
});

test('reasoning deltas publish on the thought channel', async () => {
  const { stub, runner } = setup({ events: loadFixture('reasoning-turn') });
  await runner.handlePendingPayload({ message: baseMessage });

  const thoughts = stub.bodiesFor('/api/thought');
  assert.ok(thoughts.length >= 2);
  assert.match(thoughts[0].reasoningId, /^copilot-thought-/);
  assert.equal(thoughts[0].done, false);
  assert.equal(thoughts[thoughts.length - 1].done, true);
  assert.equal(thoughts.every((t) => t.messageId === 'q-1'), true);
});

test('an abort publishes the partial text and no response row', async () => {
  const events = loadFixture('abort-turn');
  const abortIndex = events.findIndex((event) => event.type === 'abort');
  const beforeAbort = events.slice(0, abortIndex);
  const afterAbort = events.slice(abortIndex);

  const stub = makeApiStub();
  const client = createFakeCopilotClient({
    onSend: (session) => session.replay(beforeAbort),
    onAbort: (session) => session.replay(afterAbort),
  });
  let abortTurn = null;
  const controlPoller = {
    start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return { id: 1 }; },
    stop: () => {},
  };
  const { runner } = makeRunner({ stub, client, controlPoller });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => stub.bodiesFor('/api/stream').length > 0, { label: 'partial text' });
  await abortTurn({ queueMessageId: 'q-1' });
  assert.equal(await pending, true);

  // Stop = the targeted interrupt when the runtime has it: the main turn ends,
  // background agents and promoted shells keep running under their own Stop.
  // `session.abort()` would also cancel every background agent.
  assert.deepEqual(client.session.interruptCalls, [{ flushQueued: false }]);
  assert.equal(client.session.abortCalls, 0);
  // The queue row's fate belongs to the server-side abort control: publishing
  // a response here would double-settle it.
  assert.equal(stub.bodiesFor('/api/response').length, 0);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
  const final = lastBodyOf(stub, '/api/stream');
  assert.equal(final.done, true);
  assert.ok(final.text.length > 0, 'the partial answer must survive the abort');
});

test('a runtime without interruptMainTurn is stopped with session.abort()', async () => {
  const events = loadFixture('abort-turn');
  const abortIndex = events.findIndex((event) => event.type === 'abort');
  const stub = makeApiStub();
  const client = createFakeCopilotClient({
    interruptRpc: false,
    onSend: (session) => session.replay(events.slice(0, abortIndex)),
    onAbort: (session) => session.replay(events.slice(abortIndex)),
  });
  let abortTurn = null;
  const controlPoller = {
    start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return { id: 1 }; },
    stop: () => {},
  };
  const { runner } = makeRunner({ stub, client, controlPoller });
  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => stub.bodiesFor('/api/stream').length > 0, { label: 'partial text' });
  await abortTurn({ queueMessageId: 'q-1' });
  assert.equal(await pending, true);
  assert.equal(client.session.abortCalls, 1);
  assert.equal(stub.bodiesFor('/api/response').length, 0);
});

test('an abort that lands while the session is still connecting is not lost', async () => {
  // The hazard: `session.abort()` during `ensureSession` is a no-op on a null
  // session, and the turn would then go on to send the prompt the user just
  // cancelled — and hang until the relay's delivery watchdog gave up.
  const stub = makeApiStub();
  let releaseCreate = null;
  const blocked = new Promise((resolve) => { releaseCreate = resolve; });
  const client = createFakeCopilotClient({ onSend: (session) => session.replay(loadFixture('happy-turn')) });
  const createSession = client.createSession.bind(client);
  client.createSession = async (config) => {
    await blocked;
    return createSession(config);
  };

  let abortTurn = null;
  const controlPoller = {
    start: ({ onAbortTurn }) => { abortTurn = onAbortTurn; return { id: 1 }; },
    stop: () => {},
  };
  const { runner } = makeRunner({ stub, client, controlPoller });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner.isTurnActive(), { label: 'turn active' });
  await abortTurn();
  releaseCreate();

  assert.equal(await pending, true);
  // The prompt is never sent. Nothing of this turn's is running inside the
  // runtime, so nothing is interrupted either — an abort() here would only
  // cancel background work the user did not ask to stop.
  assert.equal(client.session.sends.length, 0);
  assert.equal(client.session.abortCalls, 0);
  assert.equal(client.session.interruptCalls.length, 0);
  // Still an abort: the server-side control settles the row, not this worker.
  assert.equal(stub.bodiesFor('/api/response').length, 0);
  assert.equal(lastBodyOf(stub, '/api/stream').done, true);
});

test('a runtime-initiated abort settles the row instead of leaving it pending', async () => {
  // `result.aborted` with no relay-side abort in flight: nothing server-side
  // is waiting to settle this row, so returning "delivered" here would strand
  // it until the delivery watchdog failed it with a misleading Relay timeout.
  const { stub, runner } = setup({
    events: [
      { type: 'assistant.message_start', data: { messageId: 'm1' } },
      { type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'half an ans' } },
      { type: 'abort', data: { reason: 'remote_command' } },
      { type: 'session.idle', data: { aborted: true } },
    ],
  });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  const response = bodyOf(stub, '/api/response');
  assert.ok(response, 'the row must be settled by this worker');
  assert.match(response.text, /^half an ans\n\n/);
  assert.match(response.text, /runtime interrupted this turn/);
  assert.equal(lastBodyOf(stub, '/api/stream').text, response.text);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
  assert.match(RUNTIME_INTERRUPTED_NOTE, /Resend the message/);
});

test('the row stays claimed until every publish for it has landed', async () => {
  // The heartbeat's owner-recovery guard reads the active ids. If they empty
  // during the publish window the relay sees an idle owner, recovers the
  // still-processing row and re-delivers it — a duplicate execution racing the
  // response that was already in flight.
  const seen = [];
  const stub = makeApiStub();
  const client = createFakeCopilotClient({ onSend: (session) => session.replay(loadFixture('happy-turn')) });
  const { runner } = makeRunner({
    stub: async (method, routePath, body) => {
      if (routePath === '/api/response' || routePath === '/api/stream') {
        seen.push({ routePath, ids: runner.getActiveQueueMessageIds() });
      }
      return stub(method, routePath, body);
    },
    client,
  });

  await runner.handlePendingPayload({ message: baseMessage });

  const responsePublish = seen.find((entry) => entry.routePath === '/api/response');
  assert.deepEqual(responsePublish.ids, [{ id: 'q-1', attemptId: null }]);
  assert.equal(seen.every((entry) => entry.ids.length === 1), true);
  // …and released once the turn is done.
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
});

test('a quota error fails the turn terminally as relay.quota-exhausted', async () => {
  const { stub, runner } = setup({ events: loadFixture('quota-turn') });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  const response = bodyOf(stub, '/api/response');
  assert.equal(response.terminalError.kind, 'copilot-turn-failed');
  assert.equal(response.terminalError.code, 'quota-exhausted');
  assert.equal(response.terminalError.stableCode, 'relay.quota-exhausted');
  assert.equal(response.terminalError.queueMessageId, 'q-1');
  assert.ok(Date.parse(response.terminalError.failedAt) > 0);
  assert.match(response.text, /no AI credits left for this billing window/);
  assert.match(response.text, /Open Check Usage/);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('a quota turn still reports the quota snapshots it captured', async () => {
  const { runner } = setup({ events: loadFixture('quota-turn') });
  await runner.handlePendingPayload({ message: baseMessage });
  const usage = runner.getLastTurnUsage();
  assert.equal(usage.conversationId, 'conv-1');
  assert.ok(usage.usage.quotaSnapshots.premium_interactions);
});

test('per-turn usage is captured for the ingest wiring phase 2 adds', async () => {
  const { runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  const usage = runner.getLastTurnUsage();
  assert.equal(usage.messageId, 'q-1');
  assert.equal(usage.model, 'spike-model');
  assert.equal(usage.usage.modelCalls, 1);
  assert.ok(Number.isFinite(usage.usage.timeToFirstTokenMs));
  assert.ok(usage.contextUsage.tokenLimit > 0);
  assert.ok(Date.parse(usage.capturedAt) > 0);
});

test('resume is attempted before create, and a live session is reused', async () => {
  const { client, runner } = setup({ clientOptions: { resumeAvailable: false } });

  await runner.handlePendingPayload({ message: baseMessage });
  // Brand-new conversation: resume is tried (and reports "not found") before
  // create.
  assert.equal(client.resumeAttempts.length, 1);
  assert.equal(client.resumeAttempts[0].sessionId, 'conv-1');
  assert.equal(client.createAttempts.length, 1);

  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  // A live session is reused rather than re-resumed.
  assert.equal(client.resumeAttempts.length, 1);
  assert.equal(client.createAttempts.length, 1);
  assert.equal(client.sessions.length, 1);
});

test('a session that already exists is resumed with the relay session id', async () => {
  const { client, runner } = setup({ clientOptions: { resumeAvailable: true } });

  await runner.handlePendingPayload({ message: baseMessage });

  assert.equal(client.resumeAttempts.length, 1);
  assert.equal(client.createAttempts.length, 0);
  assert.equal(client.session.resumed, true);
  assert.equal(client.resumeAttempts[0].config.streaming, true);
  assert.equal(client.resumeAttempts[0].config.sessionId, 'conv-1');
});

test('a resumed session has the requested model applied explicitly', async () => {
  // `config.model` is not guaranteed to be honoured on resume, and assuming it
  // was made a mismatch permanent: the tracked model already equalled the
  // request, so the per-turn switch could never fire to correct it. The
  // application goes through rpc.model.switchTo DIRECTLY — the facade's
  // setModel discards the switch result (SDK 1.0.13), so a refused switch
  // would be indistinguishable from one that landed.
  const { client, runner } = setup({ clientOptions: { resumeAvailable: true } });
  await runner.handlePendingPayload({ message: baseMessage });

  assert.deepEqual(client.session.rpc.model.switchToCalls, [{ modelId: 'gpt-5-mini' }]);
  assert.deepEqual(client.session.setModelCalls, []);
  assert.equal(runner._getState().appliedModel, 'gpt-5-mini');
});

test('a TRANSIENT resume failure fails the turn instead of blanking the conversation', async () => {
  // Falling through to createSession here would start an empty session over
  // live state and silently discard the whole conversation history.
  const { stub, client, runner } = setup({
    clientOptions: { resumeAvailable: false, resumeFailure: 'transient' },
  });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  assert.equal(client.resumeAttempts.length, 1);
  assert.equal(client.createAttempts.length, 0, 'a transient failure must not create a blank session');
  const response = bodyOf(stub, '/api/response');
  assert.equal(response.terminalError.stableCode, 'copilot.turn-error');
  assert.match(response.text, /Retry or send a new message/);
});

test('idle shutdown stops the runtime and the next delivery resumes it', async () => {
  const { client, runner } = setup({ idleShutdownMs: 20, lifecyclePollMs: 5 });

  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(runner._getState().hasClient, true);

  await waitFor(() => runner._getState().hasClient === false, { label: 'idle shutdown' });
  assert.equal(client.stopped, 1);
  assert.equal(client.sessions[0].disconnected, true);

  // The worker process stays up; the next delivery rebuilds and — because the
  // session state now exists — RESUMES rather than starting a fresh thread.
  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } }), true);
  assert.equal(client.resumeAttempts.length, 2);
  assert.equal(client.createAttempts.length, 1);
  assert.equal(client.sessions.length, 2);

  await runner.dispose();
});

test('an in-flight turn is never interrupted by the idle sweep', async () => {
  const { client, runner } = setup({ events: [], idleShutdownMs: 1, lifecyclePollMs: 5 });
  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner.isTurnActive(), { label: 'turn active' });

  // Well past the idle window, but a live turn pins the runtime open.
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  runner._evaluateLifecycle();
  assert.equal(runner._getState().hasClient, true);
  assert.equal(client.stopped, 0);

  client.session.emit({ type: 'session.idle', data: { mode: 'interactive' } });
  assert.equal(await pending, true);
  await runner.dispose();
});

test('agent and autopilot turns auto-approve every permission request', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  const { onPermissionRequest } = client.createAttempts[0];
  // `{kind:"allow"}` is rejected by the runtime ("unknown variant `allow`")
  // and silently fails the tool call, so only `approve-once` is ever emitted.
  assert.deepEqual(await onPermissionRequest({ kind: 'write', fileName: 'a.txt' }), { kind: 'approve-once' });

  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'autopilot' } });
  assert.deepEqual(await onPermissionRequest({ kind: 'shell', fullCommandText: 'rm -rf x' }), { kind: 'approve-once' });
});

test('plan mode denies non-read tools locally, without asking the user', async () => {
  const { client, runner, questionBridge } = setup();
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });
  const { onPermissionRequest } = client.createAttempts[0];

  // The handler reads the mode off the LIVE turn: one session serves every
  // turn of a conversation and the user can switch modes between them.
  const denied = await onPermissionRequest({ kind: 'write', fileName: 'src/app.js', intention: 'rewrite it' });
  assert.equal(denied.kind, 'reject');
  assert.match(denied.feedback, /plan mode/);
  assert.match(denied.feedback, /src\/app\.js/);

  // Reading is still allowed, so a plan turn can actually research.
  assert.deepEqual(
    await onPermissionRequest({ kind: 'read', path: 'src/app.js', intention: 'read it' }),
    { kind: 'approve-once' },
  );
  assert.deepEqual(
    await onPermissionRequest({ kind: 'shell', fullCommandText: 'ls', commands: [{ identifier: 'ls', readOnly: true }] }),
    { kind: 'approve-once' },
  );

  // Plan mode is a "describe, do not act" mode: a card per tool call would be
  // noise, so nothing was asked.
  assert.equal(questionBridge.approvalCalls.length, 0);
});

test('ask mode routes a mutating tool to the user and honours the answer', async () => {
  const approving = makeFakeQuestionBridge({ approve: true });
  const { client, runner } = setup({ questionBridge: approving });
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'ask' } });
  const { onPermissionRequest } = client.createAttempts[0];

  assert.deepEqual(
    await onPermissionRequest({ kind: 'write', fileName: 'src/app.js' }),
    { kind: 'approve-once' },
  );
  assert.equal(approving.approvalCalls.length, 1);

  // Reads short-circuit: prompting to read a file the model may already read
  // is pure friction.
  assert.deepEqual(await onPermissionRequest({ kind: 'read', path: 'a.js' }), { kind: 'approve-once' });
  assert.equal(approving.approvalCalls.length, 1);
});

test('a denied ask-mode approval carries the human reason back as feedback', async () => {
  const denying = makeFakeQuestionBridge({ approve: false, approvalFeedback: 'not on the prod config' });
  const { client, runner } = setup({ questionBridge: denying });
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'ask' } });
  const { onPermissionRequest } = client.createAttempts[0];

  const decision = await onPermissionRequest({ kind: 'write', fileName: 'prod.json' });
  assert.deepEqual(decision, { kind: 'reject', feedback: 'not on the prod config' });
});

test('an unanswered ask-mode card is user-not-available, never a reject', async () => {
  // A rejection reads to the model as a considered refusal to work around; an
  // absent human is a different fact and has its own decision kind.
  const silent = makeFakeQuestionBridge({ approvalTimedOut: true });
  const { client, runner } = setup({ questionBridge: silent });
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'ask' } });
  const { onPermissionRequest } = client.createAttempts[0];

  assert.deepEqual(
    await onPermissionRequest({ kind: 'write', fileName: 'a.js' }),
    { kind: 'user-not-available' },
  );
});

test('a question bridge failure falls back to the local policy instead of throwing', async () => {
  // A handler that throws is auto-answered `user-not-available` by the SDK with
  // no explanation; the local policy at least tells the model why.
  const broken = makeFakeQuestionBridge();
  broken.askToolApproval = async () => { throw new Error('relay unreachable'); };
  const { client, runner } = setup({ questionBridge: broken });
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'ask' } });
  const { onPermissionRequest } = client.createAttempts[0];

  const decision = await onPermissionRequest({ kind: 'write', fileName: 'a.js' });
  assert.equal(decision.kind, 'reject');
  assert.match(decision.feedback, /ask mode/);
});

test('the relay mode is threaded to the runtime as agentMode', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });
  assert.equal(client.session.sends[0].agentMode, 'plan');

  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'ask' } });
  // `ask` has no runtime equivalent; the permission policy carries it instead.
  assert.equal(client.session.sends[1].agentMode, 'interactive');
});

test('ask_user reaches the human and the answer goes back to the runtime', async () => {
  const bridge = makeFakeQuestionBridge({ userInputAnswer: 'staging' });
  const { client, runner } = setup({ questionBridge: bridge });
  await runner.handlePendingPayload({ message: baseMessage });

  const config = client.createAttempts[0];
  // `wasFreeform` is REQUIRED by UserInputResponse and the runtime's
  // deserializer is strict — omitting it fails the tool call silently.
  assert.deepEqual(
    await config.onUserInputRequest({ requestId: 'r1', question: 'which env?', choices: ['prod', 'staging'] }),
    { answer: 'staging', wasFreeform: false },
  );
  assert.equal(bridge.userInputCalls[0].request.question, 'which env?');
});

test('a question bridge failure answers in-band rather than failing the tool call', async () => {
  // The runtime BLOCKS the turn on this handler: a throw fails the tool call
  // silently and a hang holds the queue row until the delivery watchdog fires.
  const broken = makeFakeQuestionBridge();
  broken.askUserInput = async () => { throw new Error('relay unreachable'); };
  const { client, runner } = setup({ questionBridge: broken });
  await runner.handlePendingPayload({ message: baseMessage });

  const config = client.createAttempts[0];
  assert.deepEqual(await config.onUserInputRequest({ requestId: 'r1', question: 'which env?' }), {
    answer: USER_INPUT_UNSUPPORTED_ANSWER,
    wasFreeform: true,
  });
  // No schema, no card: a request that cannot round-trip declines in-band.
  assert.deepEqual(await config.onElicitationRequest({}), { action: 'decline' });
});

test('attachments travel as MessageOptions.attachments, with paths in the prompt', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({
    message: {
      ...baseMessage,
      text: 'review this',
      attachments: [{ name: 'notes.md', type: 'text/markdown', path: '/tmp/relay-fixture-workspace/notes.md' }],
      attachmentPromptContext: '<system_reminder>Attached files: notes.md</system_reminder>',
    },
    // The file does not exist on disk, so only the prompt context survives —
    // which is the contract that matters: nothing the relay supplied is lost.
  });

  const sent = client.session.sends[0];
  assert.ok(sent.prompt.startsWith(`${expectedPromptPrefix('agent')} review this\n\n`), sent.prompt.slice(0, 200));
  assert.match(sent.prompt, /<system_reminder>Attached files: notes\.md<\/system_reminder>$/);
});

test('a version-skew warning is logged once at client start', async () => {
  const logs = [];
  const { runner } = setup({
    startWarning: 'Copilot SDK/runtime version skew: SDK bundle 1.0.82, runtime reports 1.0.78.',
    dbg: (...parts) => logs.push(parts.join(' ')),
  });
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(logs.filter((line) => line.includes('version skew')).length, 1);
});

test('a failed send fails the row terminally and drops the dead session', async () => {
  const stub = makeApiStub();
  const client = createFakeCopilotClient();
  const { runner } = makeRunner({ stub, client });
  // Replace send once the session exists by failing at create time instead.
  client.createSession = async () => { throw new Error('runtime handshake failed'); };

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  const response = bodyOf(stub, '/api/response');
  assert.equal(response.terminalError.stableCode, 'copilot.turn-error');
  assert.match(response.text, /runtime handshake failed/);
  // The half-built runtime is torn down so the next delivery rebuilds it.
  assert.equal(runner._getState().hasClient, false);
});

test('an auth failure names the relay-host fix', async () => {
  const stub = makeApiStub();
  const client = createFakeCopilotClient();
  client.createSession = async () => { throw new Error('not logged in'); };
  const { runner } = makeRunner({ stub, client });

  await runner.handlePendingPayload({ message: baseMessage });
  const response = bodyOf(stub, '/api/response');
  assert.equal(response.terminalError.stableCode, 'copilot.authentication_failed');
  assert.match(response.text, /Run `copilot` on the relay host and sign in/);
});

test('a rejected /api/response requeues the row', async () => {
  const { stub, runner } = setup({ apiStubOptions: { failRoutes: new Set(['/api/response']) } });
  await runner.handlePendingPayload({ message: baseMessage });
  assert.deepEqual(bodyOf(stub, '/api/requeue'), { messageId: 'q-1' });
});

test('a delivered attempt id is echoed on every write for the row', async () => {
  // The queue row carries the attempt it was dequeued under; the server
  // refuses writes whose attempt no longer matches, so every publish that
  // names the messageId must name the attempt too.
  const { stub, runner } = setup();
  await runner.handlePendingPayload({ message: { ...baseMessage, attemptId: 'attempt-1' } });

  const streams = stub.bodiesFor('/api/stream');
  assert.ok(streams.length >= 2);
  assert.equal(streams.every((body) => body.attemptId === 'attempt-1'), true);
  assert.equal(bodyOf(stub, '/api/response').attemptId, 'attempt-1');
  const activities = stub.bodiesFor('/api/activity');
  assert.equal(activities.every((body) => body.attemptId === 'attempt-1'), true);
});

test('a response rejected with a non-409 still requeues, fenced to the attempt', async () => {
  const { stub, runner } = setup({ apiStubOptions: { failRoutes: new Set(['/api/response']) } });
  await runner.handlePendingPayload({ message: { ...baseMessage, attemptId: 'attempt-1' } });
  assert.deepEqual(bodyOf(stub, '/api/requeue'), { messageId: 'q-1', attemptId: 'attempt-1' });
});

test('a stale_attempt 409 on the response drops the reply instead of requeueing', async () => {
  // The row already moved on to another attempt (requeued and re-delivered
  // elsewhere); a requeue from this one would 409 the same way, and looping on
  // it would fight the attempt that now owns the row.
  const staleError = Object.assign(new Error('HTTP 409 /api/response: stale_attempt'), {
    status: 409,
    detail: 'stale_attempt',
  });
  const { stub, runner } = setup({
    apiStubOptions: { routeResponses: { '/api/response': () => { throw staleError; } } },
  });
  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, attemptId: 'attempt-old' } }), true);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('a turn that ends with no prose publishes the completion note, never a requeue', async () => {
  // Only the terminator: a turn can legitimately end on tool activity alone.
  const { stub, runner } = setup({ events: [{ type: 'session.idle', data: { mode: 'interactive' } }] });
  await runner.handlePendingPayload({ message: baseMessage });

  const response = bodyOf(stub, '/api/response');
  assert.match(response.text, /^System note: the turn completed without a text reply\.$/);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('a delivery with no message is refused without touching the runtime', async () => {
  const { stub, runner, started } = setup();
  assert.equal(await runner.handlePendingPayload({}), false);
  assert.equal(started.length, 0);
  assert.equal(stub.calls.length, 0);
});

test('the active queue message id is exposed only while a turn runs', async () => {
  const { client, runner } = setup({ events: [] });
  assert.equal(runner.getActiveQueueMessageId(), '');
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner.isTurnActive(), { label: 'turn active' });
  // The claim happens before the runtime is even built — a cold-start delivery
  // still owns its row. The entries carry the delivery's attempt id (null
  // here) so the crash guard's requeues stay fenced.
  assert.equal(runner.getActiveQueueMessageId(), 'q-1');
  assert.deepEqual(runner.getActiveQueueMessageIds(), [{ id: 'q-1', attemptId: null }]);

  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  client.session.emit({ type: 'session.idle', data: { mode: 'interactive' } });
  await pending;
  assert.equal(runner.getActiveQueueMessageId(), '');
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
});

test('an auto model defers to the provider model and marks the response auto', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({
    message: { ...baseMessage, model: 'auto', providerModel: 'gpt-5.4-mini' },
  });
  assert.equal(client.createAttempts[0].model, 'gpt-5.4-mini');
  assert.equal(bodyOf(stub, '/api/response').modelOrigin, 'auto');
});

test('a per-turn model change switches the live session instead of rebuilding it', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'claude-sonnet-5' } });

  assert.deepEqual(client.session.rpc.model.switchToCalls, [{ modelId: 'claude-sonnet-5' }]);
  assert.equal(client.sessions.length, 1);
  assert.equal(runner._getState().appliedModel, 'claude-sonnet-5');
});

test('a rejected model switch fails the row instead of running on the old model', async () => {
  // The #13 policy: an explicit selection the runtime does not confirm must
  // never silently run the prompt on the previous model. The row fails
  // terminally with a record naming requested vs actual.
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  client.session.rpc.model.switchTo = async () => { throw new Error('model unavailable'); };

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'nope' } }), true);

  const responses = stub.bodiesFor('/api/response');
  assert.equal(responses.length, 2);
  const failed = responses[1];
  assert.equal(failed.terminalError.stableCode, 'relay.model-switch-unconfirmed');
  assert.match(failed.text, /"nope"/);
  assert.match(failed.text, /"gpt-5-mini"/);
  // The prompt was never sent on the wrong model...
  assert.equal(client.session.sends.length, 1);
  // ...and the healthy session survives: a selection problem is not a dead
  // runtime, and tearing it down would kill live detached shells.
  assert.equal(runner._getState().hasSession, true);
});

test('the dequeued reasoningEffort is applied before the prompt is sent', async () => {
  // Audit #9: the worker changed models but dropped the row's effort on the
  // floor entirely (and SDK 1.0.13 silently discards it in MessageOptions).
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: { ...baseMessage, reasoningEffort: 'high' } });

  // Same turn-one model as always, with the effort riding the switch.
  assert.deepEqual(client.session.rpc.model.effortCalls, [{ reasoningEffort: 'high' }]);
  assert.equal(runner._getState().appliedEffort, 'high');

  // Same model, same effort: the next turn costs zero model RPCs.
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', reasoningEffort: 'high' } });
  assert.equal(client.session.rpc.model.effortCalls.length, 1);
  assert.equal(client.session.rpc.model.switchToCalls.length, 0);

  // An effort-only change uses the effort RPC, not a model switch.
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', reasoningEffort: 'low' } });
  assert.deepEqual(client.session.rpc.model.effortCalls, [
    { reasoningEffort: 'high' },
    { reasoningEffort: 'low' },
  ]);
  assert.equal(client.session.rpc.model.switchToCalls.length, 0);
  assert.equal(client.session.sends.length, 3);
});

test('a model change carries the row effort in one switchTo', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-2', model: 'gpt-5.4', reasoningEffort: 'xhigh' },
  });
  assert.deepEqual(client.session.rpc.model.switchToCalls, [{ modelId: 'gpt-5.4', reasoningEffort: 'xhigh' }]);
  assert.equal(runner._getState().appliedModel, 'gpt-5.4');
  assert.equal(runner._getState().appliedEffort, 'xhigh');
});

test('a deferred switch that drains in time proceeds; one that expires fails the row', async () => {
  // `deferred: true` means the switch is queued behind an active turn and the
  // LIVE model is unchanged until it drains; the worker waits (bounded) for
  // the session.model_change that proves the drain.
  const drained = setup({
    clientOptions: {
      modelRpc: {
        switchTo: (params, session) => {
          setTimeout(() => session.emit({
            type: 'session.model_change',
            data: { newModel: params.modelId, reasoningEffort: params.reasoningEffort || null },
          }), 5);
          return { deferred: true };
        },
      },
    },
    modelSwitchTimeoutMs: 2_000,
  });
  await drained.runner.handlePendingPayload({ message: baseMessage });
  assert.equal(await drained.runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-2', model: 'gpt-5.4' },
  }), true);
  assert.equal(drained.stub.bodiesFor('/api/response')[1].terminalError, undefined);
  assert.equal(drained.runner._getState().appliedModel, 'gpt-5.4');
  assert.equal(drained.client.session.sends.length, 2);

  const expired = setup({
    clientOptions: { modelRpc: { switchTo: () => ({ deferred: true }) } },
    modelSwitchTimeoutMs: 20,
  });
  await expired.runner.handlePendingPayload({ message: baseMessage });
  assert.equal(await expired.runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-2', model: 'gpt-5.4' },
  }), true);
  const failed = expired.stub.bodiesFor('/api/response')[1];
  assert.equal(failed.terminalError.stableCode, 'relay.model-switch-unconfirmed');
  assert.match(failed.text, /"gpt-5\.4"/);
  assert.match(failed.text, /"gpt-5-mini"/);
  // The unconfirmed prompt never went out.
  assert.equal(expired.client.session.sends.length, 1);
});

test('a confirmation-required switch fails the row rather than deciding for the user', async () => {
  const { stub, client, runner } = setup({
    clientOptions: {
      modelRpc: {
        switchTo: () => ({ confirmation: { targetModelDisplayName: 'X', currentTokens: 1, targetLimit: 2 } }),
      },
    },
  });
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'gpt-5.4' } });
  assert.equal(stub.bodiesFor('/api/response')[1].terminalError.stableCode, 'relay.model-switch-unconfirmed');
  assert.equal(client.session.sends.length, 1);
});

test('effort none resets to the model default the catalog reports', async () => {
  const catalog = [{
    id: 'gpt-5-mini',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    defaultReasoningEffort: 'medium',
  }];
  const { client, runner } = setup({ clientOptions: { modelRpc: { catalog } } });
  await runner.handlePendingPayload({ message: { ...baseMessage, reasoningEffort: 'high' } });
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', reasoningEffort: 'none' } });

  assert.deepEqual(client.session.rpc.model.effortCalls, [
    { reasoningEffort: 'high' },
    { reasoningEffort: 'medium' },
  ]);
  assert.equal(runner._getState().appliedEffort, 'medium');
});

test('an effort the model does not support fails the row before anything is sent', async () => {
  const catalog = [{
    id: 'gpt-5-mini',
    supportedReasoningEfforts: ['low', 'medium'],
    defaultReasoningEffort: 'medium',
  }];
  const { stub, client, runner } = setup({ clientOptions: { modelRpc: { catalog } } });
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', reasoningEffort: 'max' } });

  const failed = stub.bodiesFor('/api/response')[1];
  assert.equal(failed.terminalError.stableCode, 'relay.model-switch-unconfirmed');
  assert.match(failed.text, /"max"/);
  assert.equal(client.session.rpc.model.effortCalls.length, 0);
  assert.equal(client.session.sends.length, 1);
});

test('the send mode seam threads MessageOptions.mode through to send', async () => {
  const { client, runner } = setup({ resolveSendModeImpl: () => 'enqueue' });
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(client.session.sends[0].mode, 'enqueue');
});

test('no mode field is sent when the seam resolves an empty mode', async () => {
  const { client, runner } = setup({ resolveSendModeImpl: () => '' });
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal('mode' in client.session.sends[0], false);
});

test('the default send mode is immediate', async () => {
  // Fake-provider probe against runtime 1.0.88 (2026-09-25): "immediate" is a
  // real steer mid-turn (delivery:"steering" at the next tool boundary, or
  // queued to the FRONT and run right after when the model is mid-stream),
  // and when the main loop is idle it starts at once — while an "enqueue"
  // message sent behind a running background agent sits frozen until the
  // session-level idle. Immediate is the only mode that never strands a row.
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(client.session.sends[0].mode, 'immediate');
});

test('the stall watchdog fails a silent turn terminally', async () => {
  const { stub, runner } = setup({ events: [], turnStallTimeoutMs: 20 });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  const response = bodyOf(stub, '/api/response');
  assert.equal(response.terminalError.stableCode, 'copilot.turn-error');
  assert.match(response.text, /produced no events for 0s|watchdog/);
});

test('a stall that fires before anything awaits the turn is not an unhandled rejection', async () => {
  // The stall can reject `turn.done` while `send()` is still in flight. An
  // unhandled rejection there is escalated by the worker crash guard into a
  // whole-worker failure, taking every other conversation down with it.
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const stub = makeApiStub();
    const client = createFakeCopilotClient();
    const { runner } = makeRunner({ stub, client, turnStallTimeoutMs: 5 });
    // A `send` that never resolves: the stall fires with nothing awaiting.
    const createSession = client.createSession.bind(client);
    client.createSession = async (config) => {
      const session = await createSession(config);
      session.send = () => new Promise(() => {});
      return session;
    };

    const pending = runner.handlePendingPayload({ message: baseMessage });
    await new Promise((resolve) => { setTimeout(resolve, 40); });
    // The stall rejected the turn while `send` was still in flight. What
    // matters is that no unhandled rejection escaped — and that the row was
    // failed terminally rather than held behind a send that never resolves.
    assert.equal(rejections.length, 0, `unhandled: ${rejections.map(String).join(', ')}`);
    await waitFor(() => stub.bodiesFor('/api/response').length === 1, { label: 'terminal failure published' });
    assert.equal(bodyOf(stub, '/api/response').terminalError.stableCode, 'copilot.turn-error');
    assert.equal(await pending, true);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('the stall watchdog defaults to on, and 0 disables it', async () => {
  // Emphatically not disabled by default: the 10s heartbeat keeps renewing the
  // relay's processing lease, so without a ceiling a wedged turn holds its row
  // open forever and no watchdog can free it.
  const { client, runner } = setup({ events: [], turnStallTimeoutMs: 0 });
  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner.isTurnActive(), { label: 'turn active' });
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(runner.isTurnActive(), true, '0 must disable the ceiling');

  client.session.emit({ type: 'session.idle', data: { mode: 'interactive' } });
  assert.equal(await pending, true);

  // The default (120s) is far away, so a short silent turn is untouched by it.
  const second = setup({ events: [] });
  const running = second.runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => second.runner.isTurnActive(), { label: 'second turn active' });
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(second.runner.isTurnActive(), true);
  second.client.session.emit({ type: 'session.idle', data: { mode: 'interactive' } });
  assert.equal(await running, true);
});

test('a runtime that dies under a live turn fails the row instead of wedging it', async () => {
  // Without this the 10s heartbeat keeps renewing the processing lease against
  // a corpse and the row is held until the relay's delivery watchdog gives up.
  const stub = makeApiStub();
  const client = createFakeCopilotClient();
  let killRuntime = null;
  client.processExitPromise = new Promise((_resolve, reject) => { killRuntime = reject; });
  client.processExitPromise.catch(() => {});
  const { runner } = makeRunner({ stub, client, turnStallTimeoutMs: 0 });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => runner._getState().hasSession, { label: 'session created' });
  killRuntime(new Error('CLI server exited with code 1\nstderr: boom'));

  assert.equal(await pending, true);
  const response = bodyOf(stub, '/api/response');
  assert.equal(response.terminalError.stableCode, 'copilot.turn-error');
  assert.match(response.text, /runtime exited before the turn completed/);
  assert.match(response.text, /exited with code 1/);
  // The dead handles are dropped so the next delivery rebuilds.
  assert.equal(runner._getState().hasClient, false);
});

test('a runtime death between turns just drops the handles', async () => {
  const stub = makeApiStub();
  const client = createFakeCopilotClient({ onSend: (session) => session.replay(loadFixture('happy-turn')) });
  let killRuntime = null;
  client.processExitPromise = new Promise((_resolve, reject) => { killRuntime = reject; });
  client.processExitPromise.catch(() => {});
  const { runner } = makeRunner({ stub, client });

  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(runner._getState().hasClient, true);

  killRuntime(new Error('CLI server exited unexpectedly with code 0'));
  await waitFor(() => runner._getState().hasClient === false, { label: 'handles dropped' });
  assert.equal(stub.bodiesFor('/api/response').length, 1, 'no phantom failure row');
});

test('dispose stops the session and the runtime', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.dispose();

  assert.equal(client.sessions[0].disconnected, true);
  assert.equal(client.stopped, 1);
  assert.equal(runner._getState().hasClient, false);
  assert.equal(runner._getState().hasSession, false);
});

test('dispose is safe before anything started', async () => {
  const { client, runner, started } = setup();
  await runner.dispose();
  assert.equal(started.length, 0);
  assert.equal(client.stopped, 0);
});

// ---------------------------------------------------------------- subagents --

test('a subagent run reaches the relay lane, and its prose stays out of the reply', async () => {
  // Replayed from a live BYOK capture of a real `task` call, so the event
  // shapes (envelope agentId, the undocumented subagent.configured, a reply
  // that arrives as ONE tagged assistant.message with no deltas) are the
  // runtime's, not a hand-written guess.
  const { stub, runner } = setup({ events: loadFixture('subagent-turn') });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);

  const runs = stub.bodiesFor('/api/subagent-run');
  assert.equal(runs.length, 2);
  assert.equal(runs[0].status, 'running');
  assert.equal(runs[0].displayName, 'Probe Helper');
  assert.equal(runs[0].messageId, 'q-1');
  assert.equal(runs[0].conversationId, 'conv-1');
  assert.equal(runs[1].status, 'completed');
  assert.equal(runs[1].subagentRunId, runs[0].subagentRunId);

  // The subagent's reply went to the lane...
  const laneStream = stub.bodiesFor('/api/stream').find((b) => b.subagentRunId);
  assert.equal(laneStream.text, 'SUBAGENT_REPLY');
  assert.equal(laneStream.subagentRunId, runs[0].subagentRunId);

  // ...and emphatically not into the turn's answer.
  const response = lastBodyOf(stub, '/api/response');
  assert.equal(response.text, 'PARENT_DONE');
});

test('a subagent left running when the turn dies is closed, not left spinning', async () => {
  // The relay only reconciles open runs when the row FAILS; an aborted turn is
  // settled server-side, so the worker has to close its own or the bubble spins
  // forever.
  const events = [
    { type: 'subagent.started', agentId: 'agent-x', data: { agentDisplayName: 'Stray', toolCallId: 'c1' } },
  ];
  const { stub, client, runner } = setup({ events });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => stub.bodiesFor('/api/subagent-run').length > 0, { label: 'run opened' });
  client.session.emit({ type: 'abort', data: {} });
  client.session.emit({ type: 'session.idle', data: { aborted: true } });
  await pending;

  const runs = stub.bodiesFor('/api/subagent-run');
  assert.equal(runs.at(-1).status, 'failed');
  assert.equal(runs.at(-1).subagentRunId, 'agent-x');
});

// --------------------------------------------------------------- plan board --

test('an exit-plan request posts the board and refuses to exit plan mode', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });

  const { onExitPlanModeRequest } = client.createAttempts[0];
  // A turn has to be active for the board to bind to a queue row.
  const pending = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'plan' } });
  await waitFor(() => runner.isTurnActive(), { label: 'turn active' });
  const result = await onExitPlanModeRequest({ summary: 'short', planContent: '- a\n- b' });
  await pending;

  const board = bodyOf(stub, '/api/relay-board');
  assert.equal(board.boardType, 'plan_ready');
  assert.equal(board.body, '- a\n- b');
  assert.equal(board.context.source, 'exit_plan_mode');

  // Approving would tell the runtime the plan was accepted and the SAME turn
  // would roll straight into implementing while the board sits unanswered.
  assert.equal(result.approved, false);
  assert.match(result.feedback, /shown to the user in the relay for review/);
});

test('a plan-shaped answer with no exit-plan hook still posts a board', async () => {
  const events = [
    { type: 'user.message', data: {} },
    { type: 'assistant.message', data: { messageId: 'm1', content: '- research the schema\n- write the migration' } },
    { type: 'session.idle', data: {} },
  ];
  const { stub, runner } = setup({ events });

  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });

  const board = bodyOf(stub, '/api/relay-board');
  assert.equal(board.context.source, 'plan-mode-fallback');
  assert.match(board.body, /research the schema/);

  // The board must go out BEFORE the response: /api/relay-board 409s once the
  // queue row leaves `processing`.
  const routes = stub.calls.map((c) => c.routePath);
  assert.ok(routes.indexOf('/api/relay-board') < routes.indexOf('/api/response'), routes.join(' | '));
});

test('an agent-mode turn never posts a plan board, however list-shaped', async () => {
  const events = [
    { type: 'user.message', data: {} },
    { type: 'assistant.message', data: { messageId: 'm1', content: '- did this\n- did that' } },
    { type: 'session.idle', data: {} },
  ];
  const { stub, runner } = setup({ events });
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(stub.bodiesFor('/api/relay-board').length, 0);
});

// ----------------------------------------------------------------- steering --

/**
 * A client whose Nth send replays a different slice of the interaction. A
 * slice may be a function of the runtime message id that send resolved, so a
 * scripted `user.message` can echo it the way the real runtime does.
 */
function steeringClient(perSend, clientOptions = {}) {
  let sendIndex = 0;
  return createFakeCopilotClient({
    ...clientOptions,
    onSend: (session, _options, messageId) => {
      const script = perSend[sendIndex] || [];
      sendIndex += 1;
      session.replay(typeof script === 'function' ? script(messageId) : script);
    },
  });
}

/** The runtime's acknowledgement that it started work on a pushed prompt. */
function userMessage(messageId, delivery, content = '') {
  return { type: 'user.message', data: { messageId, delivery, content } };
}

test('a delivery mid-turn is steered in; run as its own turn (delivery:queued) it gets its own answer', async () => {
  // Probe against runtime 1.0.88: an immediate prompt the runtime cannot inject
  // (the model is mid-stream) is moved to the FRONT of the queue and run right
  // after as `user.message{delivery:"queued"}` — a run of its own, on the same
  // interaction, closed by ONE idle for the whole drain. Its row gets that
  // run's reply; the primary row settles the moment the new run opens.
  const client = steeringClient([
    (id) => [
      userMessage(id, 'idle', 'hello'),
      { type: 'assistant.message', data: { messageId: 'm1', content: 'first answer' } },
    ],
    (id) => [
      userMessage(id, 'queued', 'actually, do it this way'),
      { type: 'assistant.message', data: { messageId: 'm2', content: 'second answer' } },
      { type: 'session.idle', data: {} },
    ],
  ]);
  const stub = makeApiStub();
  const { runner } = makeRunner({ stub, client });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });

  const steered = { ...baseMessage, id: 'q-2', text: 'actually, do it this way' };
  const second = runner.handlePendingPayload({ message: steered });

  assert.equal(await first, true);
  assert.equal(await second, true);

  // Steered into the SAME session, never a second turn.
  assert.equal(client.sessions.length, 1);
  assert.equal(client.session.sends.length, 2);
  assert.equal(client.session.sends[1].mode, 'immediate');
  assert.match(client.session.sends[1].prompt, /actually, do it this way/);

  // Each row is answered with the text of ITS OWN run.
  const responses = stub.bodiesFor('/api/response');
  assert.equal(responses.length, 2);
  assert.equal(responses.find((r) => r.messageId === 'q-1').text, 'first answer');
  assert.equal(responses.find((r) => r.messageId === 'q-2').text, 'second answer');
  assert.equal(responses.find((r) => r.messageId === 'q-2').kind, undefined);
  // The primary settled BEFORE the steered run's reply — when its run ended.
  assert.equal(responses[0].messageId, 'q-1');
  // A steered row is never requeued: the runtime already consumed the prompt.
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
  // Nothing was folded, so nothing was marked consumed.
  assert.equal(stub.bodiesFor('/api/queue-consumed').length, 0);
});

test('a steer the runtime folds into the running turn (delivery:steering) settles as folded', async () => {
  // Probe against runtime 1.0.88: an immediate prompt sent during a tool call
  // is injected right after the tool result as `delivery:"steering"`, under
  // the SAME interaction. The reply that follows belongs to the running row;
  // the steered row settles with Claude's fold marker and is marked consumed
  // the moment the runtime takes it.
  const client = steeringClient([
    (id) => [
      userMessage(id, 'idle', 'hello'),
      { type: 'assistant.message', data: { messageId: 'm1', content: 'started work' } },
    ],
    (id) => [
      userMessage(id, 'steering', 'also mention X'),
      { type: 'assistant.message', data: { messageId: 'm2', content: 'done, and X too' } },
      { type: 'assistant.idle', data: {} },
    ],
  ]);
  const stub = makeApiStub();
  const { runner } = makeRunner({ stub, client });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'a-2', text: 'also mention X' } });
  assert.equal(await first, true);
  assert.equal(await second, true);

  const responses = stub.bodiesFor('/api/response');
  const primary = responses.find((r) => r.messageId === 'q-1');
  const folded = responses.find((r) => r.messageId === 'q-2');
  // The whole reply — before and after the injection — is the primary's.
  assert.equal(primary.text, 'started work\n\ndone, and X too');
  assert.deepEqual(primary.consumedSteerIds, [{ id: 'q-2', attemptId: 'a-2' }]);
  assert.equal(folded.kind, 'folded');
  assert.match(folded.text, /steered into that turn/);
  // Consumed at the acknowledgement, not at the end: a crash in between must
  // fail the row, never re-run it.
  assert.deepEqual(stub.bodiesFor('/api/queue-consumed'), [
    { conversationId: 'conv-1', entries: [{ id: 'q-2', attemptId: 'a-2' }] },
  ]);
  // The primary's response landed before the fold marker.
  assert.ok(responses.indexOf(primary) < responses.indexOf(folded));
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('the turn settles on assistant.idle while the session-level idle stays deferred', async () => {
  // A background agent keeps `session.idle` deferred for as long as it runs;
  // `assistant.idle` says the main loop is done. The row must not wait.
  const client = steeringClient([
    (id) => [
      userMessage(id, 'idle', 'hello'),
      { type: 'assistant.message', data: { messageId: 'm1', content: 'spawned a background agent' } },
      { type: 'assistant.idle', data: {} },
    ],
  ]);
  const stub = makeApiStub();
  const { runner } = makeRunner({ stub, client });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(bodyOf(stub, '/api/response').text, 'spawned a background agent');
  assert.equal(runner.isTurnActive(), false);
  // The late session-level idle is not an opener: nothing happens.
  client.session.emit({ type: 'session.idle', data: {} });
  await tick(5);
  assert.equal(stub.bodiesFor('/api/continuation-turn').length, 0);
  assert.equal(stub.bodiesFor('/api/response').length, 1);
});

test('the heartbeat claims the steered row too, or the relay recovers it mid-flight', async () => {
  // Neither send settles the interaction, so both rows are genuinely in flight
  // at the same time — which is the only moment this can be observed.
  const client = steeringClient([[], []]);
  const stub = makeApiStub();
  const { runner } = makeRunner({ stub, client });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', attemptId: 'attempt-q2' } });
  await waitFor(() => runner.getActiveQueueMessageIds().length === 2, { label: 'both rows owned' });

  // A row missing from this list is recovered as `owner-heartbeat-mismatch` and
  // re-delivered while the runtime is still answering it. Each entry carries
  // its OWN row's attempt id, never the host turn's.
  assert.deepEqual(runner.getActiveQueueMessageIds(), [
    { id: 'q-1', attemptId: null },
    { id: 'q-2', attemptId: 'attempt-q2' },
  ]);

  client.session.emit({ type: 'session.idle', data: {} });
  await first;
  await second;
  assert.deepEqual(runner.getActiveQueueMessageIds(), []);
});

test('a steered prompt the runtime never started is noted, not requeued', async () => {
  // The prompt is still queued INSIDE the runtime and will be answered at the
  // start of the next turn; redelivering the row would run it twice.
  //
  // Events are emitted by hand rather than replayed from a send, so the
  // interaction provably ends with only ONE prompt segment open — replaying on
  // send would race the steer and make the outcome depend on timing.
  const client = steeringClient([[], []]);
  const stub = makeApiStub();
  const { runner } = makeRunner({ stub, client });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  await waitFor(() => runner.getActiveQueueMessageIds().length === 2, { label: 'row steered in' });

  // The runtime answers the first prompt and goes idle without ever opening a
  // segment for the steered one.
  client.session.emit({ type: 'user.message', data: {} });
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm1', content: 'only answer' } });
  client.session.emit({ type: 'session.idle', data: {} });

  assert.equal(await first, true);
  assert.equal(await second, true);

  const responses = stub.bodiesFor('/api/response');
  assert.equal(responses.find((r) => r.messageId === 'q-1').text, 'only answer');
  const steeredResponse = responses.find((r) => r.messageId === 'q-2');
  assert.match(steeredResponse.text, /reply continues in the next turn/);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('a steering send that never reached the runtime requeues its row', async () => {
  // Nothing consumed the prompt, so redelivery is safe — and is the only way
  // the row gets answered at all.
  const client = steeringClient([[], [{ type: 'session.idle', data: {} }]]);
  const stub = makeApiStub();
  const { runner } = makeRunner({ stub, client });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });
  client.session.send = async () => { throw new Error('connection lost'); };

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } }), true);
  assert.deepEqual(stub.bodiesFor('/api/requeue'), [{ messageId: 'q-2' }]);

  client.session.emit({ type: 'session.idle', data: {} });
  await first;
});

test('a turn that throws still settles the rows steered into it', async () => {
  // Otherwise `steerIntoActiveTurn` waits forever on a settle that never comes,
  // holding its queue row behind a heartbeat that keeps renewing the lease.
  const client = steeringClient([[], []]);
  const stub = makeApiStub();
  const { runner } = makeRunner({ stub, client, turnStallTimeoutMs: 40 });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });

  assert.equal(await first, true);
  assert.equal(await second, true);

  const steeredResponse = stub.bodiesFor('/api/response').find((r) => r.messageId === 'q-2');
  assert.ok(steeredResponse, 'the steered row must be settled');
  assert.equal(steeredResponse.terminalError.stableCode, 'copilot.turn-error');
});

// ------------------------------------------------------- previews / config --

test('the preview-lane block is injected into the first prompt of a mode', async () => {
  const { client, runner } = setup({
    relayToolInstructions: '# Tools\n\n## Preview servers\n\nplaceholder',
    getPreviewInstructionsImpl: () => '## Preview servers\n\nPOST /api/previews to publish',
  });

  await runner.handlePendingPayload({ message: baseMessage });
  assert.match(client.session.sends[0].prompt, /POST \/api\/previews to publish/);
  assert.doesNotMatch(client.session.sends[0].prompt, /placeholder/);
});

test('compaction is configured explicitly rather than left to the runtime default', async () => {
  // Pinned to the runtime's own documented defaults so a future change to them
  // cannot silently move where a long relay conversation starts compacting.
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  assert.deepEqual(client.createAttempts[0].infiniteSessions, {
    enabled: true,
    backgroundCompactionThreshold: 0.8,
    bufferExhaustionThreshold: 0.95,
  });
});

test('a hosted turn posts its usage to the copilot ingest', async () => {
  const { stub, runner } = setup({ env: {} });
  await runner.handlePendingPayload({ message: baseMessage });

  const posts = stub.bodiesFor('/api/copilot-plan-usage');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].conversationId, 'conv-1');
  assert.equal(posts[0].messageId, 'q-1');
  // The relay normalises; the worker posts the captured shape as-is, so the
  // fields only it can see have to survive the trip.
  assert.ok(posts[0].usage);
});

test('a BYOK turn posts no copilot usage', async () => {
  // BYOK spends the user's own key, not Copilot quota, and its usage events
  // report cost 0 — those numbers do not belong on the Copilot plan card.
  const { stub, runner } = setup({
    env: {
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: 'sk-test',
      COPILOT_MODEL: 'gpt-5.4-mini',
    },
  });
  await runner.handlePendingPayload({ message: baseMessage });

  assert.equal(stub.bodiesFor('/api/copilot-plan-usage').length, 0);
});

test('a hosted session carries no BYOK provider block', async () => {
  const { client, runner } = setup({ env: {} });
  await runner.handlePendingPayload({ message: baseMessage });

  assert.equal('provider' in client.createAttempts[0], false);
});

test('an openai-provider session carries its BYOK provider into the session config', async () => {
  // The runtime ignores COPILOT_PROVIDER_* for SDK-created sessions, so the
  // same relay configuration the extension path reads from the environment has
  // to be re-expressed here or the conversation silently runs on hosted models.
  const { client, runner } = setup({
    env: {
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: 'https://example.test/v1',
      COPILOT_PROVIDER_API_KEY: 'sk-test',
      COPILOT_PROVIDER_WIRE_API: 'responses',
      COPILOT_MODEL: 'gpt-5.4-mini',
    },
  });
  await runner.handlePendingPayload({ message: baseMessage });

  const { provider } = client.createAttempts[0];
  assert.deepEqual(provider, {
    type: 'openai',
    baseUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    wireApi: 'responses',
    // gpt-5.4-mini's 256k window, minus the completion that has to fit in it.
    maxPromptTokens: 128_000,
    maxOutputTokens: 128_000,
  });
  // Leaving modelId unset is what keeps setModel authoritative for the session.
  assert.equal('modelId' in provider, false);
});

test('a hosted model switch uses the observed switchTo RPC and keeps the one session', async () => {
  const { client, runner } = setup({ env: {} });
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'gpt-5.4' } });

  assert.deepEqual(client.session.rpc.model.switchToCalls, [{ modelId: 'gpt-5.4' }]);
  // The facade's setModel is bypassed: it discards the ModelSwitchToResult.
  assert.deepEqual(client.session.setModelCalls, []);
  // One session for the whole conversation: nothing was torn down.
  assert.equal(client.sessions.length, 1);
  assert.equal(client.session.disconnected, false);
});

test('a BYOK model switch rebuilds the session so the ceilings follow the model', async () => {
  // `SessionConfig.provider` carries the model's token ceilings and runtime
  // 1.0.82 has no way to update it mid-session — setModel takes no provider,
  // there is no setProvider, and the registry-add RPC belongs to the named
  // multi-provider surface, which the runtime rejects alongside the singular
  // `provider` this worker uses. A bare setModel would therefore leave gpt-4o's
  // ceilings describing a gpt-4.1 session.
  const { client, runner } = setup({
    env: {
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: 'sk-test',
      COPILOT_MODEL: 'gpt-4o',
    },
  });
  await runner.handlePendingPayload({ message: { ...baseMessage, model: 'gpt-4o' } });
  assert.equal(client.createAttempts[0].provider.maxPromptTokens, 111_616);
  const firstSession = client.session;

  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'gpt-4.1' } });

  // The old session was disposed and a NEW one built for the new model...
  assert.equal(firstSession.disconnected, true);
  assert.equal(client.sessions.length, 2);
  assert.notEqual(client.session, firstSession);
  // ...with ceilings that describe gpt-4.1 rather than gpt-4o.
  const rebuilt = client.resumeAttempts[client.resumeAttempts.length - 1].config;
  assert.equal(rebuilt.provider.maxPromptTokens, 1_014_808);
  assert.equal(rebuilt.provider.maxOutputTokens, 32_768);
  // History is preserved: the rebuild RESUMES the same session id rather than
  // creating a blank second one.
  assert.equal(rebuilt.sessionId, 'conv-1');
  assert.equal(client.createAttempts.length, 1);
  // Both turns still published their reply.
  assert.equal(client.sessions[1].sends.length, 1);
  // No RPC attempt preceded the rebuild: the two models' provider blocks
  // differ (ceilings follow the model) and no RPC can carry ceilings, so an
  // in-place switch could never be sufficient.
  assert.equal(firstSession.rpc.model.switchToCalls.length, 0);
});

test('a BYOK switch with unchanged ceilings tries the RPC first and rebuilds only on rejection', async () => {
  // Explicit ceiling overrides make the provider block model-independent, so
  // an in-place switch IS sufficient — the live RPC is tried first and a
  // confirmed switch keeps the one session.
  const { client, runner } = setup({
    env: {
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: 'sk-test',
      COPILOT_PROVIDER_MAX_PROMPT_TOKENS: '100000',
      COPILOT_PROVIDER_MAX_OUTPUT_TOKENS: '20000',
      COPILOT_MODEL: 'gpt-4o',
    },
  });
  await runner.handlePendingPayload({ message: { ...baseMessage, model: 'gpt-4o' } });
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'gpt-4.1' } });

  assert.deepEqual(client.session.rpc.model.switchToCalls, [{ modelId: 'gpt-4.1' }]);
  assert.equal(client.sessions.length, 1);
  assert.equal(client.session.disconnected, false);

  // The runtime rejects the next switch (a singular-provider session may not
  // accept bare model ids at all) → the dispose+resume fallback, carrying the
  // row's effort into the rebuilt config. Never a terminal failure: BYOK has
  // this second mechanism, so an RPC refusal is not an unhonoured selection.
  const firstSession = client.session;
  firstSession.rpc.model.switchTo = async () => { throw new Error('registry rejected the model'); };
  await runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-3', model: 'gpt-4o', reasoningEffort: 'high' },
  });

  assert.equal(firstSession.disconnected, true);
  assert.equal(client.sessions.length, 2);
  const rebuilt = client.resumeAttempts[client.resumeAttempts.length - 1].config;
  assert.equal(rebuilt.model, 'gpt-4o');
  assert.equal(rebuilt.reasoningEffort, 'high');
  assert.equal(rebuilt.sessionId, 'conv-1');
  // All three turns answered.
  assert.equal(client.sessions[1].sends.length, 1);
});

test('a failed send re-sends the mode guidance on the same-mode retry', async () => {
  // Audit #32: the mode used to be recorded as prompted while BUILDING the
  // prefix, so a send that failed left the retry without guidance the runtime
  // never received. The commit now happens only after send() resolves.
  const stub = makeApiStub();
  const client = createFakeCopilotClient({ onSend: (session) => session.replay(loadFixture('happy-turn')) });
  const originalCreate = client.createSession.bind(client);
  client.createSession = async (config) => {
    const session = await originalCreate(config);
    session.send = async () => { throw new Error('socket dropped before the prompt landed'); };
    return session;
  };
  const { runner } = makeRunner({ stub, client });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(bodyOf(stub, '/api/response').terminalError.stableCode, 'copilot.turn-error');

  // The retry (a fresh delivery after the teardown) resumes and must carry the
  // FULL agent-mode guidance again, not just the cheap marker.
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  assert.equal(client.session.sends.length, 1);
  assert.equal(client.session.sends[0].prompt, promptWithPrefix('hello'));
});

test('an elicitation with a schema round-trips as a structured card and accepts', async () => {
  const bridge = makeFakeQuestionBridge({ structuredAnswer: { env: 'prod', replicas: 2 } });
  const { client, runner } = setup({ questionBridge: bridge });
  await runner.handlePendingPayload({ message: baseMessage });

  const config = client.createAttempts[0];
  const schema = {
    type: 'object',
    properties: { env: { type: 'string' }, replicas: { type: 'number' } },
    required: ['env'],
  };
  const result = await config.onElicitationRequest({
    sessionId: 'conv-1',
    message: 'Deployment details?',
    requestedSchema: schema,
    mode: 'form',
    elicitationSource: 'deploy-mcp',
  });

  // The validated structuredAnswer maps 1:1 onto ElicitationResult.content.
  assert.deepEqual(result, { action: 'accept', content: { env: 'prod', replicas: 2 } });
  const call = bridge.structuredCalls[0];
  assert.deepEqual(call.spec.requestedSchema, schema);
  assert.match(call.spec.prompt, /Deployment details\?/);
  // The requesting MCP server is named, so the human knows who is asking.
  assert.match(call.spec.prompt, /deploy-mcp/);
});

test('an elicitation declines on timeout, on url mode, and without a schema', async () => {
  const bridge = makeFakeQuestionBridge({ structuredTimedOut: true });
  const { client, runner } = setup({ questionBridge: bridge });
  await runner.handlePendingPayload({ message: baseMessage });
  const config = client.createAttempts[0];
  const schema = { type: 'object', properties: { env: { type: 'string' } } };

  // An unanswered card declines — the current behaviour, preserved.
  assert.deepEqual(
    await config.onElicitationRequest({ message: 'x', requestedSchema: schema }),
    { action: 'decline' },
  );
  // A browser redirect cannot render as a relay card.
  assert.deepEqual(
    await config.onElicitationRequest({ mode: 'url', url: 'https://example.test/auth' }),
    { action: 'decline' },
  );
  // No schema, no form.
  assert.deepEqual(await config.onElicitationRequest({ message: 'x' }), { action: 'decline' });
  // Only the schema-carrying form request reached the bridge at all.
  assert.equal(bridge.structuredCalls.length, 1);
});

test('the usage ingest never delays a finished reply', async () => {
  // The POST runs after the stall watchdog is disarmed on a client with no
  // request timeout, so awaiting it would let an unresponsive relay hold a
  // COMPLETED turn and its still-open queue row.
  let releaseIngest = () => {};
  const gate = new Promise((resolve) => { releaseIngest = resolve; });
  const stub = makeApiStub();
  const calls = [];
  const gatedApi = async (method, routePath, body) => {
    calls.push(routePath);
    if (routePath === '/api/copilot-plan-usage') await gate;
    return stub(method, routePath, body);
  };
  gatedApi.bodiesFor = stub.bodiesFor;

  const client = createFakeCopilotClient({ onSend: (session) => session.replay(loadFixture('happy-turn')) });
  const { runner } = makeRunner({ stub: gatedApi, client });

  // Resolves while the ingest POST is still hanging.
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(stub.bodiesFor('/api/response').length, 1);
  // The POST was issued (ordering is deterministic), just not waited on.
  assert.equal(calls.includes('/api/copilot-plan-usage'), true);
  assert.equal(calls.indexOf('/api/response') < calls.indexOf('/api/copilot-plan-usage'), true);

  releaseIngest();
  await runner.whenUsagePosted();
});

test('a rejected usage ingest is swallowed rather than failing the turn', async () => {
  const { stub, runner } = setup({
    env: {},
    apiStubOptions: { failRoutes: new Set(['/api/copilot-plan-usage']) },
  });

  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenUsagePosted();
  assert.equal(stub.bodiesFor('/api/response').length, 1);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('shutdown closes any question card still waiting for a human', async () => {
  const { runner, questionBridge } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  await runner.dispose();
  assert.equal(questionBridge.cancelledCount, 1);
});

test('the captured usage carries real spend, not just the premium multiplier', async () => {
  // `cost` is the multiplier and there is no `premiumRequests` field at all;
  // `copilotUsage.totalNanoAiu` is the number a usage card must show. Phase 3
  // only adds the transport, so the shape has to be right now.
  const events = [
    { type: 'user.message', data: {} },
    {
      type: 'assistant.usage',
      data: {
        model: 'gpt-5.4-mini',
        inputTokens: 100,
        outputTokens: 20,
        cost: 0.33,
        copilotUsage: { totalNanoAiu: 4200 },
      },
    },
    { type: 'model.call_failure', data: { quotaSnapshots: { cfi_overage: { used: 3 } } } },
    { type: 'assistant.message', data: { messageId: 'm1', content: 'done' } },
    { type: 'session.idle', data: {} },
  ];
  const { runner } = setup({ events });
  await runner.handlePendingPayload({ message: baseMessage });

  const captured = runner.getLastTurnUsage();
  assert.equal(captured.usage.totalNanoAiu, 4200);
  assert.equal(captured.usage.cost, 0.33);
  assert.deepEqual(captured.usage.quotaSnapshots.cfi_overage, { used: 3 });
  // The model that actually billed, taken off the usage event rather than the
  // requested one.
  assert.equal(captured.usage.model, 'gpt-5.4-mini');
});

// ------------------------------------------------- review regression guards --

test('a prompt left queued in the runtime is answered on the next row, as its note promised', async () => {
  // A steered prompt the runtime never started stays in its pending queue and
  // is picked up FIRST next time. Its row was settled with the "reply
  // continues in the next turn" note, so the next row's reply carries both
  // answers — the leftover's first, then its own. Nothing is dropped and no
  // row is answered with someone else's reply alone.
  const client = steeringClient([[], [], []]);
  const stub = makeApiStub();
  const { runner } = makeRunner({ stub, client });

  // Turn 1: q-2 is steered in but the runtime goes idle without starting it.
  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  await waitFor(() => runner.getActiveQueueMessageIds().length === 2, { label: 'steered in' });
  client.session.emit({ type: 'user.message', data: {} });
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm1', content: 'answer to q-1' } });
  client.session.emit({ type: 'session.idle', data: {} });
  await first;
  await second;

  // Turn 2: the runtime works through the leftover q-2 prompt first, then q-3.
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3' } });
  await waitFor(() => client.session.sends.length === 3, { label: 'third send' });
  client.session.emit({ type: 'user.message', data: {} });
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm2', content: 'leftover q-2 answer' } });
  client.session.emit({ type: 'user.message', data: {} });
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm3', content: 'answer to q-3' } });
  client.session.emit({ type: 'session.idle', data: {} });
  assert.equal(await third, true);

  const q3 = stub.bodiesFor('/api/response').find((r) => r.messageId === 'q-3');
  assert.equal(q3.text, 'leftover q-2 answer\n\nanswer to q-3');
  const q2 = stub.bodiesFor('/api/response').find((r) => r.messageId === 'q-2');
  assert.match(q2.text, /reply continues in the next turn/);
});

test('a turn settling mid-steer hands the row back instead of wedging the socket', async () => {
  // `steerIntoActiveTurn` awaits the relay-context build before registering the
  // row. If the turn settles during that await, `settleSteeredRows` has already
  // run — a row pushed afterwards would never be settled and `onDeliver` would
  // never resolve, wedging the single-flight delivery socket.
  const client = steeringClient([[], [{ type: 'session.idle', data: {} }]]);
  const stub = makeApiStub();
  let releaseSteer = () => {};
  const gate = new Promise((resolve) => { releaseSteer = resolve; });
  let calls = 0;
  const { runner } = makeRunner({
    stub,
    client,
    getPreviewInstructionsImpl: async () => {
      calls += 1;
      // Block only the steering delivery's build, not the first turn's.
      if (calls > 1) await gate;
      return '';
    },
  });

  const first = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => client.session?.sends.length === 1, { label: 'first send' });

  // Start the steer, let it block, then settle the turn underneath it.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'plan' } });
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  client.session.emit({ type: 'assistant.message', data: { messageId: 'm1', content: 'done' } });
  client.session.emit({ type: 'session.idle', data: {} });
  assert.equal(await first, true);
  releaseSteer();

  // The row must still be answered — as its own turn, since steering was
  // abandoned before anything was sent.
  assert.equal(await second, true);
  const q2 = stub.bodiesFor('/api/response').find((r) => r.messageId === 'q-2');
  assert.ok(q2, 'the handed-back row must be settled');
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
});

test('the stall watchdog waits for a human instead of failing the row under them', async () => {
  // The runtime emits NO events while blocked in a question handler, and the
  // card's own timeout is 8 hours against a 120s stall ceiling. Failing here
  // would settle the row and then hand the human's answer to a dead turn.
  const client = createFakeCopilotClient({ onSend: () => {} });
  const stub = makeApiStub();
  let asked = () => {};
  const askedOnce = new Promise((resolve) => { asked = resolve; });
  let release = () => {};
  const humanThinking = new Promise((resolve) => { release = resolve; });
  const slowHuman = makeFakeQuestionBridge({
    userInputAnswer: 'staging',
    onAsk: async () => { asked(); await humanThinking; },
  });
  const { runner } = makeRunner({ stub, client, questionBridge: slowHuman, turnStallTimeoutMs: 25 });

  const pending = runner.handlePendingPayload({ message: baseMessage });
  await waitFor(() => !!client.session, { label: 'session' });
  const answer = client.createAttempts[0].onUserInputRequest({ requestId: 'r1', question: 'which env?' });
  await askedOnce;

  // Well past the 25ms ceiling with the human still thinking.
  await new Promise((resolve) => { setTimeout(resolve, 90); });
  assert.equal(runner.isTurnActive(), true, 'the row must not be failed while a human is answering');
  assert.equal(stub.bodiesFor('/api/response').length, 0);

  release();
  assert.deepEqual(await answer, { answer: 'staging', wasFreeform: true });

  client.session.emit({ type: 'session.idle', data: {} });
  assert.equal(await pending, true);
});

test('a plan board the relay refused is reported as not posted', async () => {
  // Telling the agent the plan is "shown to the user for review" when the POST
  // failed ends the turn with the plan visible nowhere — and latches off the
  // text-shape fallback that could still have posted it.
  const { client, runner } = setup({
    events: [],
    apiStubOptions: { failRoutes: new Set(['/api/relay-board']) },
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });
  await waitFor(() => client.createAttempts.length > 0, { label: 'session created' });
  const result = await client.createAttempts[0].onExitPlanModeRequest({ summary: '- a\n- b' });
  client.session.emit({ type: 'session.idle', data: {} });
  await pending;

  assert.equal(result.approved, false);
  assert.match(result.feedback, /could not be shown for review/);
});
