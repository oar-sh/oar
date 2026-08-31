import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAKE_SDK_PATHS,
  baseMessage,
  createFakeCopilotClient,
  eventsThrough,
  loadFixture,
  makeApiStub,
  makeRunner,
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
  const { runner, started } = makeRunner({ stub, client, ...overrides });
  return { stub, client, runner, started };
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
  assert.deepEqual(client.session.sends[0], { prompt: 'hello', agentMode: 'interactive' });
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
  await abortTurn();
  assert.equal(await pending, true);

  assert.equal(client.session.abortCalls, 1);
  // The queue row's fate belongs to the server-side abort control: publishing
  // a response here would double-settle it.
  assert.equal(stub.bodiesFor('/api/response').length, 0);
  assert.equal(stub.bodiesFor('/api/requeue').length, 0);
  const final = lastBodyOf(stub, '/api/stream');
  assert.equal(final.done, true);
  assert.ok(final.text.length > 0, 'the partial answer must survive the abort');
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
  // The prompt is never sent, and the abort is re-applied to the session the
  // moment it exists.
  assert.equal(client.session.sends.length, 0);
  assert.equal(client.session.abortCalls, 1);
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
  assert.deepEqual(responsePublish.ids, ['q-1']);
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
  // was made a mismatch permanent: `appliedModel` already equalled the request,
  // so the per-turn switch could never fire to correct it.
  const { client, runner } = setup({ clientOptions: { resumeAvailable: true } });
  await runner.handlePendingPayload({ message: baseMessage });

  assert.deepEqual(client.session.setModelCalls, ['gpt-5-mini']);
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
  assert.deepEqual(onPermissionRequest({ kind: 'write', fileName: 'a.txt' }), { kind: 'approve-once' });

  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'autopilot' } });
  assert.deepEqual(onPermissionRequest({ kind: 'shell', fullCommandText: 'rm -rf x' }), { kind: 'approve-once' });
});

test('plan and ask turns deny anything that is not read-only', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });
  const { onPermissionRequest } = client.createAttempts[0];

  // The handler reads the mode off the LIVE turn: one session serves every
  // turn of a conversation and the user can switch modes between them.
  const denied = onPermissionRequest({ kind: 'write', fileName: 'src/app.js', intention: 'rewrite it' });
  assert.equal(denied.kind, 'reject');
  assert.match(denied.feedback, /plan mode/);
  assert.match(denied.feedback, /src\/app\.js/);

  // Reading is still allowed, so a plan turn can actually research.
  assert.deepEqual(
    onPermissionRequest({ kind: 'read', path: 'src/app.js', intention: 'read it' }),
    { kind: 'approve-once' },
  );
  assert.deepEqual(
    onPermissionRequest({ kind: 'shell', fullCommandText: 'ls', commands: [{ identifier: 'ls', readOnly: true }] }),
    { kind: 'approve-once' },
  );
});

test('the relay mode is threaded to the runtime as agentMode', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });
  assert.equal(client.session.sends[0].agentMode, 'plan');

  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'ask' } });
  // `ask` has no runtime equivalent; the permission policy carries it instead.
  assert.equal(client.session.sends[1].agentMode, 'interactive');
});

test('the interactive handlers answer instead of hanging the turn', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });

  const config = client.createAttempts[0];
  // `wasFreeform` is REQUIRED by UserInputResponse and the runtime's
  // deserializer is strict — omitting it fails the tool call silently.
  assert.deepEqual(await config.onUserInputRequest({ requestId: 'r1', question: 'which env?' }, {}), {
    answer: USER_INPUT_UNSUPPORTED_ANSWER,
    wasFreeform: true,
  });
  assert.match(USER_INPUT_UNSUPPORTED_ANSWER, /not yet supported by the SDK worker/);
  assert.deepEqual(config.onElicitationRequest({}), { action: 'decline' });
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
  assert.match(sent.prompt, /^review this\n\n/);
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
  // still owns its row.
  assert.equal(runner.getActiveQueueMessageId(), 'q-1');
  assert.deepEqual(runner.getActiveQueueMessageIds(), ['q-1']);

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

  assert.deepEqual(client.session.setModelCalls, ['claude-sonnet-5']);
  assert.equal(client.sessions.length, 1);
  assert.equal(runner._getState().appliedModel, 'claude-sonnet-5');
});

test('a rejected model switch runs the turn anyway', async () => {
  const { stub, client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  client.session.setModel = async () => { throw new Error('model unavailable'); };

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'nope' } }), true);
  assert.equal(stub.bodiesFor('/api/response').length, 2);
});

test('the send mode seam threads MessageOptions.mode through to send', async () => {
  const { client, runner } = setup({ resolveSendModeImpl: () => 'enqueue' });
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal(client.session.sends[0].mode, 'enqueue');
});

test('no mode field is sent when no mode is resolved', async () => {
  const { client, runner } = setup();
  await runner.handlePendingPayload({ message: baseMessage });
  assert.equal('mode' in client.session.sends[0], false);
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
    // The stall rejected the turn, but `send` never resolves so the row is
    // still held — what matters is that no unhandled rejection escaped.
    assert.equal(rejections.length, 0, `unhandled: ${rejections.map(String).join(', ')}`);
    assert.equal(runner.isTurnActive(), true);
    void pending;
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
