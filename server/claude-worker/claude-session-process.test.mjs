import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeSessionRunner } from './claude-session-process.mjs';
import { buildClaudePlanReadyBoardPayload } from './claude-turn-publisher.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';

// Keeps the tests off the real `~/.claude/projects`; transcript relocation has
// its own suite in claude-transcript-relocator.test.mjs.
const noopRelocate = () => ({ status: 'skipped' });

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await tick();
  }
}

function makeApiStub({ failRoutes = new Set(), continuationIds = [] } = {}) {
  const calls = [];
  let continuationCounter = 0;
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      if (failRoutes.has(routePath)) throw new Error(`stubbed failure for ${routePath}`);
      if (routePath === '/api/continuation-turn') {
        continuationCounter += 1;
        return { messageId: continuationIds[continuationCounter - 1] || `cont-${continuationCounter}` };
      }
      return { ok: true };
    },
  };
}

/**
 * A scriptable stand-in for the SDK Query: the test emits SDK messages when it
 * chooses, the stream only ends on endInput/close (like the real CLI), and
 * pushed user turns are recorded (and optionally echoed back as replays, which
 * is what the real stream does).
 */
function scriptedTurn({ echoPushes = false } = {}) {
  const queued = [];
  let wake = null;
  let ended = false;
  const turn = {
    pushed: [],
    endInputCalls: 0,
    closed: false,
    interrupts: 0,
    stoppedTasks: [],
    pushUserMessage(content) {
      if (ended) throw new Error('user message stream already ended');
      turn.pushed.push(content);
      if (echoPushes) {
        turn.emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content } });
      }
    },
    endInput() {
      turn.endInputCalls += 1;
      ended = true;
      wake?.();
    },
    close() {
      turn.closed = true;
      ended = true;
      wake?.();
    },
    async interrupt() {
      turn.interrupts += 1;
    },
    async stopTask(taskId) {
      turn.stoppedTasks.push(taskId);
    },
    emit(message) {
      queued.push(message);
      wake?.();
    },
    fail(error) {
      queued.push({ __throw: error });
      wake?.();
    },
    async* [Symbol.asyncIterator]() {
      for (;;) {
        while (queued.length) {
          const next = queued.shift();
          if (next?.__throw) throw next.__throw;
          yield next;
        }
        if (ended) return;
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
    },
  };
  return turn;
}

/** Emits the given messages, then the stream ends by itself. */
function fakeTurn(messages) {
  return {
    pushUserMessage() {},
    endInput() {},
    async* [Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

function initMessage(sessionId) {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-5' };
}

function resultMessage(text, sessionId) {
  return {
    type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId, num_turns: 1, duration_api_ms: 100,
  };
}

function phantomResultMessage(sessionId) {
  return {
    type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessionId, num_turns: 0, duration_api_ms: 0,
  };
}

function backgroundTasksMessage(tasks) {
  return { type: 'system', subtype: 'background_tasks_changed', tasks };
}

function taskNotificationMessage(taskId, status = 'completed') {
  return { type: 'system', subtype: 'task_notification', task_id: taskId, status, summary: 'settled' };
}

function userReplay(text) {
  return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text }] } };
}

function assistantText(text) {
  return { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } };
}

const baseMessage = {
  id: 'q-1',
  conversationId: 'conv-1',
  relayMode: 'agent',
  text: 'hello',
  model: 'claude-sonnet-5',
  attachments: [],
};

function makeRunner({ stub, startImpl, ...overrides }) {
  return createClaudeSessionRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeSessionImpl: startImpl,
    continuationRetryDelayMs: 10,
    ...overrides,
  });
}

async function settled(runner) {
  await waitFor(() => !runner._getProcess(), { label: 'process teardown' });
}

// ---------------------------------------------------------------------------
// Ported per-turn contract tests

test('a turn that finishes on tool activity alone publishes instead of requeueing', async () => {
  // Same defect the Cursor worker hit in conv 1e497a75: a successful result
  // carrying no prose is a completed turn, and requeuing it re-runs work whose
  // emptiness is deterministic until the retry cap fails the message.
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([initMessage('native-1'), resultMessage('', 'native-1')]),
  });

  await runner.handlePendingPayload({ message: { ...baseMessage } });

  assert.ok(
    !stub.calls.find((call) => call.routePath === '/api/requeue'),
    'a completed turn must never be requeued',
  );
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, EMPTY_TURN_COMPLETION_NOTE);
  assert.ok(!response.body.terminalError, 'a silent turn is a success, not a failure');
});

test('first turn persists the native session id and later spawns resume it', async () => {
  const stub = makeApiStub();
  const capturedSpawns = [];
  const runner = makeRunner({
    stub,
    startImpl: (params) => {
      capturedSpawns.push(params);
      return fakeTurn([initMessage('native-1'), resultMessage('done', 'native-1')]);
    },
  });

  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: null } });
  assert.equal(capturedSpawns[0].resume, '');
  const persist = stub.calls.find((call) => call.routePath === '/api/claude-native-session');
  assert.ok(persist, 'native session id must be persisted');
  assert.deepEqual(persist.body, { conversationId: 'conv-1', claudeNativeSessionId: 'native-1' });
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'done');

  // The first process wound down (its stream ended); the next turn's fresh
  // spawn resumes from the worker cache.
  await settled(runner);
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', claudeNativeSessionId: null } });
  assert.equal(capturedSpawns.length, 2);
  assert.equal(capturedSpawns[1].resume, 'native-1');
});

test('a respawned worker resumes from the server-persisted id (kill survival)', async () => {
  const stub = makeApiStub();
  const capturedSpawns = [];
  // Fresh runner = freshly spawned worker process after a kill.
  const runner = makeRunner({
    stub,
    startImpl: (params) => {
      capturedSpawns.push(params);
      return fakeTurn([initMessage('native-2'), resultMessage('resumed fine', 'native-2')]);
    },
  });
  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: 'native-1' } });
  assert.equal(capturedSpawns[0].resume, 'native-1');
  // The (possibly new) session id from the resumed turn is persisted so the
  // chain keeps working across further restarts.
  const persist = stub.calls.find((call) => call.routePath === '/api/claude-native-session');
  assert.equal(persist.body.claudeNativeSessionId, 'native-2');
});

test('a resuming spawn relocates the transcript into the current CWD first', async () => {
  const stub = makeApiStub();
  const relocations = [];
  const order = [];
  const runner = createClaudeSessionRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    // A worker respawned by the CWD relaunch runs in the new workspace root,
    // while the session id still points at the old root's transcript.
    cwd: '/tmp/new-root',
    relocateTranscriptImpl: (params) => {
      relocations.push(params);
      order.push('relocate');
      return { status: 'moved' };
    },
    startClaudeSessionImpl: () => {
      order.push('spawn');
      return fakeTurn([initMessage('native-1'), resultMessage('ok', 'native-1')]);
    },
  });

  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: 'native-1' } });

  assert.deepEqual(order, ['relocate', 'spawn']);
  assert.equal(relocations[0].nativeSessionId, 'native-1');
  assert.equal(relocations[0].cwd, '/tmp/new-root');
});

test('a first turn has no transcript to relocate', async () => {
  const stub = makeApiStub();
  const relocations = [];
  const runner = makeRunner({
    stub,
    relocateTranscriptImpl: (params) => {
      relocations.push(params);
      return { status: 'skipped' };
    },
    startImpl: () => fakeTurn([initMessage('native-1'), resultMessage('ok', 'native-1')]),
  });

  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: null } });

  assert.deepEqual(relocations, []);
});

test('failed persist is retried on the next init instead of being cached', async () => {
  const failRoutes = new Set(['/api/claude-native-session']);
  const stub = makeApiStub({ failRoutes });
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([initMessage('native-1'), resultMessage('ok', 'native-1')]),
  });
  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: null } });
  assert.equal(stub.calls.filter((call) => call.routePath === '/api/claude-native-session').length, 1);

  failRoutes.clear();
  await settled(runner);
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', claudeNativeSessionId: null } });
  const persists = stub.calls.filter((call) => call.routePath === '/api/claude-native-session');
  assert.equal(persists.length, 2, 'persist must be retried after a failure');
});

test('per-turn model and effort reach the SDK spawn', async () => {
  const stub = makeApiStub();
  const capturedSpawns = [];
  const runner = makeRunner({
    stub,
    startImpl: (params) => {
      capturedSpawns.push(params);
      return fakeTurn([initMessage('native-1'), resultMessage('ok', 'native-1')]);
    },
  });
  await runner.handlePendingPayload({
    message: {
      ...baseMessage,
      model: 'claude-opus-5[1m]',
      providerModel: 'claude-sonnet-5',
      reasoningEffort: 'xhigh',
    },
  });
  assert.equal(capturedSpawns[0].model, 'claude-opus-5[1m]');
  assert.equal(capturedSpawns[0].reasoningEffort, 'xhigh');
});

test('sdk failure publishes a terminal response instead of hanging the queue', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => {
      throw new Error('spawn failed');
    },
  });
  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.ok(response);
  assert.match(response.body.text, /spawn failed/);
  assert.equal(response.body.terminalError.kind, 'claude-turn-failed');
});

test('subagent stream text never stands in for the answer', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([
      initMessage('native-1'),
      // Main thread narrates, then a subagent streams after it. The stream
      // ends without a result envelope, so the fallback text is published.
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Main thread answer.' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sub',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Subagent chatter here.' } },
      },
    ]),
  });

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.ok(response, 'a response must be published');
  assert.equal(response.body.text, 'Main thread answer.');

  // The subagent text still reached the stream channel, tagged to its run.
  const subagentStream = stub.calls.find((call) => call.routePath === '/api/stream' && call.body.subagentRunId);
  assert.equal(subagentStream.body.subagentRunId, 'toolu_sub');
  assert.equal(subagentStream.body.text, 'Subagent chatter here.');
});

test('thoughts from the sdk stream reach the relay thought channel', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([
      initMessage('native-1'),
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'thinking', thinking: 'Weighing the options.' },
            { type: 'text', text: 'Checking the config first.' },
            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/etc/hosts' } },
          ],
        },
      },
      resultMessage('All set.', 'native-1'),
    ]),
  });

  await runner.handlePendingPayload({ message: { ...baseMessage } });
  const thoughts = stub.calls.filter((call) => call.routePath === '/api/thought');
  assert.equal(thoughts.length, 2, 'thinking and interim narration both publish');
  assert.equal(thoughts[0].body.text, 'Weighing the options.');
  assert.equal(thoughts[1].body.text, 'Checking the config first.');
  assert.ok(thoughts[0].body.reasoningId !== thoughts[1].body.reasoningId);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'All set.');
});

test('ExitPlanMode board falls back to the plan file when input.plan is empty', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const planFilePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-board-')), 'plan.md');
  fs.writeFileSync(planFilePath, '# Plan\n1. first\n2. second\n');
  t.after(() => fs.rmSync(path.dirname(planFilePath), { recursive: true, force: true }));

  const stub = makeApiStub();
  let capturedCanUseTool = null;
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: (params) => {
      capturedCanUseTool = params.canUseTool;
      return turn;
    },
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });
  turn.emit(initMessage('native-1'));
  await waitFor(() => capturedCanUseTool, { label: 'canUseTool wired' });
  const decision = await capturedCanUseTool('ExitPlanMode', { plan: '', planFilePath }, {});
  assert.equal(decision.behavior, 'deny', 'plan approval must come from the board, not the turn');
  turn.emit(resultMessage('Plan is ready for review.', 'native-1'));
  await pending;
  turn.endInput();
  const board = stub.calls.find((call) => call.routePath === '/api/relay-board');
  assert.ok(board, 'plan board must be posted');
  assert.match(board.body.body, /1\. first/);
  assert.equal(board.body.boardType, 'plan_ready');
});

test('plan board payload requires plan text', () => {
  assert.equal(buildClaudePlanReadyBoardPayload({ message: baseMessage, planText: '' }), null);
  const payload = buildClaudePlanReadyBoardPayload({ message: baseMessage, planText: '1. a\n2. b' });
  assert.equal(payload.boardType, 'plan_ready');
  assert.equal(payload.messageId, 'q-1');
});

test('context usage is read at each result over the live transport', async () => {
  const stub = makeApiStub();
  const events = [];
  const turn = scriptedTurn();
  turn.getContextUsage = async () => {
    events.push('getContextUsage');
    return { totalTokens: 247100, maxTokens: 1000000, percentage: 24.71, categories: [] };
  };

  const runner = makeRunner({
    stub,
    sdkSessionId: 'sess-1',
    startImpl: () => turn,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(resultMessage('done', 'native-1'));
  await pending;

  assert.deepEqual(events, ['getContextUsage'], 'read exactly once per turn');
  const post = stub.calls.find((call) => call.routePath === '/api/claude-context-usage');
  assert.ok(post, 'context usage must be published');
  assert.equal(post.body.conversationId, 'conv-1');
  assert.equal(post.body.sdkSessionId, 'sess-1');
  assert.equal(post.body.contextUsage.totalTokens, 247100);
  turn.endInput();
});

test('a runtime without the context control request still completes the turn', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([initMessage('native-1'), resultMessage('done', 'native-1')]),
  });

  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  assert.ok(stub.calls.find((call) => call.routePath === '/api/response'), 'response still published');
  assert.ok(
    !stub.calls.find((call) => call.routePath === '/api/claude-context-usage'),
    'nothing to publish when the runtime cannot report context',
  );
});

test('plan usage publishes a session cost even when the SDK reports no model breakdown', async () => {
  // The experimental /usage control request is optional; when it is missing the
  // stable result fields are the whole payload, and `total_cost_usd` can arrive
  // without `modelUsage`. Skipping that turn would silently drop session cost.
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([
      initMessage('native-1'),
      { ...resultMessage('done', 'native-1'), total_cost_usd: 0.42 },
    ]),
  });

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage } }), true);
  const post = stub.calls.find((call) => call.routePath === '/api/claude-plan-usage');
  assert.ok(post, 'plan usage must be published for a cost-only result');
  assert.equal(post.body.totalCostUsd, 0.42);
  assert.equal(post.body.usage, null);
});

test('a turn that reports no usage at all publishes no plan usage', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({
    stub,
    startImpl: () => fakeTurn([initMessage('native-1'), resultMessage('done', 'native-1')]),
  });

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage } }), true);
  assert.ok(
    !stub.calls.find((call) => call.routePath === '/api/claude-plan-usage'),
    'nothing usable to report',
  );
});

test('failing usage publishes do not disturb the response', async () => {
  const stub = makeApiStub({ failRoutes: new Set(['/api/claude-plan-usage', '/api/claude-context-usage']) });
  const turn = fakeTurn([
    initMessage('native-1'),
    { ...resultMessage('done', 'native-1'), total_cost_usd: 1.5 },
  ]);
  turn.getContextUsage = async () => ({ totalTokens: 10, maxTokens: 100, percentage: 10, categories: [] });
  const runner = makeRunner({ stub, startImpl: () => turn });

  assert.equal(await runner.handlePendingPayload({ message: { ...baseMessage } }), true);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'done');
});

test('a throwing stream publishes a terminal response and releases the input', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.fail(new Error('boom'));
  const handled = await pending;
  assert.equal(handled, true);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.match(response.body.text, /boom/);
  assert.equal(response.body.terminalError.kind, 'claude-turn-failed');
  assert.ok(turn.endInputCalls >= 1, 'a dead stream must release the input');
  await settled(runner);
});

// ---------------------------------------------------------------------------
// Persistent-process behavior (the 2353a9eb incident class)

test('a backgrounded bash task keeps the process alive and its continuation publishes as its own turn', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'e2e suite' }]));
  turn.emit(resultMessage('Runs started; I will be notified.', 'native-1'));
  assert.equal(await pending, true);

  const firstResponse = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(firstResponse.body.text, 'Runs started; I will be notified.');
  assert.equal(turn.endInputCalls, 0, 'the CLI process must survive the reply while the task runs');

  // The task settles; the CLI dequeues its notification as a fresh turn.
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('bash-1'));
  turn.emit(userReplay('<task-notification>bash-1 completed</task-notification>'));
  turn.emit(assistantText('All three runs passed.'));
  turn.emit(resultMessage('All three runs passed.', 'native-1'));

  const continuationResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.equal(continuationResponse.body.text, 'All three runs passed.');
  const registration = stub.calls.find((call) => call.routePath === '/api/continuation-turn');
  assert.equal(registration.body.conversationId, 'conv-1');
  // The settled-task activity line lands on the continuation turn.
  const activity = stub.calls.find((call) => call.routePath === '/api/activity' && call.body.messageId === 'cont-1');
  assert.match(activity.body.text, /bash-1 completed/);
  assert.equal(turn.endInputCalls, 0, 'still alive after the continuation');
  turn.endInput();
  await settled(runner);
});

test('a second user message reuses the live process instead of respawning', async () => {
  const stub = makeApiStub();
  const spawns = [];
  const turn = scriptedTurn({ echoPushes: true });
  const runner = makeRunner({
    stub,
    startImpl: (params) => {
      spawns.push(params);
      return turn;
    },
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'dev server' }]));
  turn.emit(resultMessage('first answer', 'native-1'));
  assert.equal(await first, true);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'second question' } });
  await waitFor(() => turn.pushed.length === 2, { label: 'second push' });
  turn.emit(assistantText('second answer'));
  turn.emit(resultMessage('second answer', 'native-1'));
  assert.equal(await second, true);

  assert.equal(spawns.length, 1, 'one CLI process carries both turns');
  const responses = stub.calls.filter((call) => call.routePath === '/api/response');
  assert.deepEqual(responses.map((call) => [call.body.messageId, call.body.text]), [
    ['q-1', 'first answer'],
    ['q-2', 'second answer'],
  ]);
  turn.endInput();
  await settled(runner);
});

test('a delivered message queued behind a continuation keeps its own reply', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);

  // Continuation begins...
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  turn.emit(userReplay('<task-notification>agent-1 completed</task-notification>'));
  turn.emit(assistantText('agent finished; wrapping up'));
  // ...and the user sends a new message mid-continuation. The CLI queues it;
  // the relay reply must not swallow the continuation's output.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'status?' } });
  await tick(20);
  turn.emit(resultMessage('agent finished; wrapping up', 'native-1'));
  const contResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.equal(contResponse.body.text, 'agent finished; wrapping up');

  // Now the CLI dequeues the pushed user message as its own turn.
  turn.emit(assistantText('here is the status'));
  turn.emit(resultMessage('here is the status', 'native-1'));
  assert.equal(await second, true);
  const secondResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal(secondResponse.body.text, 'here is the status');
  turn.endInput();
  await settled(runner);
});

test('the process idles out after idleShutdownMs with no work', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    idleShutdownMs: 40,
    lifecyclePollMs: 10,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await pending, true);
  await waitFor(() => turn.endInputCalls >= 1, { label: 'idle release' });
  await settled(runner);
});

test('live background tasks defer the idle shutdown', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    idleShutdownMs: 20,
    lifecyclePollMs: 5,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'e2e suite' }]));
  turn.emit(resultMessage('running', 'native-1'));
  assert.equal(await pending, true);
  await tick(100);
  assert.equal(turn.endInputCalls, 0, 'a live task must hold the process past the idle window');
  turn.endInput();
  await settled(runner);
});

test('the background-task timeout stops every live task', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    idleShutdownMs: 10_000,
    lifecyclePollMs: 5,
    getBackgroundTaskTimeoutMs: () => 30,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([
    { task_id: 'bash-1', task_type: 'local_bash', description: 'suite' },
    { task_id: 'agent-1', task_type: 'local_agent', description: 'job' },
  ]));
  turn.emit(resultMessage('running', 'native-1'));
  assert.equal(await pending, true);
  await waitFor(() => turn.stoppedTasks.length === 2, { label: 'tasks stopped' });
  assert.deepEqual([...turn.stoppedTasks].sort(), ['agent-1', 'bash-1']);
  turn.endInput();
  await settled(runner);
});

test('an abort control interrupts the turn but keeps the process alive', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  let capturedAbort = null;
  const controlPoller = {
    start: ({ onAbortTurn }) => {
      capturedAbort = onAbortTurn;
      return {};
    },
    stop: () => {},
  };
  const runner = makeRunner({ stub, startImpl: () => turn, controlPoller });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } },
  });
  await waitFor(() => capturedAbort, { label: 'abort control wired' });
  await capturedAbort();
  assert.equal(turn.interrupts, 1, 'abort maps to interrupt, not process death');
  turn.emit({ ...resultMessage('', 'native-1'), is_interrupt: true });
  assert.equal(await pending, true);
  const finalStream = stub.calls.filter((call) => call.routePath === '/api/stream').at(-1);
  assert.equal(finalStream.body.done, true);
  assert.equal(finalStream.body.text, 'partial answer');
  assert.ok(
    !stub.calls.find((call) => call.routePath === '/api/response'),
    'the abort control owns the queue row; no response is published',
  );
  assert.equal(turn.endInputCalls, 0, 'the process survives the interrupt');
  turn.endInput();
  await settled(runner);
});

test('a pending AskUserQuestion pins the process past the idle window', async () => {
  // The 2026-08-07 incident class: the user is typing an answer while nothing
  // streams; the process must not idle out under the pending question.
  const calls = [];
  let questionPolls = 0;
  const api = async (method, routePath, body) => {
    calls.push({ method, routePath, body });
    if (routePath === '/api/relay-question') return { question: { id: 'rq-1' } };
    if (routePath === '/api/relay-question/rq-1') {
      questionPolls += 1;
      return { question: { id: 'rq-1', status: questionPolls >= 10 ? 'answered' : 'pending', answer: 'option A' } };
    }
    return { ok: true };
  };
  let capturedCanUseTool = null;
  const turn = scriptedTurn();
  const runner = createClaudeSessionRunner({
    api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeSessionImpl: (params) => {
      capturedCanUseTool = params.canUseTool;
      return turn;
    },
    idleShutdownMs: 20,
    lifecyclePollMs: 5,
    askUserBridgeOptions: { questionPollMs: 10 },
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  await waitFor(() => capturedCanUseTool, { label: 'canUseTool wired' });
  const decision = await capturedCanUseTool('AskUserQuestion', {
    questions: [{ question: 'Proceed?', options: [{ label: 'option A' }, { label: 'option B' }] }],
  }, {});
  assert.equal(decision.behavior, 'allow');
  assert.equal(turn.endInputCalls, 0, 'the process must still be alive when the answer arrives');
  assert.ok(questionPolls >= 10, 'the question stayed pending well past the idle window');
  turn.emit(resultMessage('acted on option A', 'native-1'));
  assert.equal(await pending, true);
  const response = calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'acted on option A');
  turn.endInput();
  await settled(runner);
});

test('an orphan-task replay on resume never creates a continuation turn', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const runner = makeRunner({ stub, startImpl: () => turn });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: 'native-1' } });
  // The resumed CLI replays the orphaned-task bookkeeping turn first: the
  // notification, its replayed user message, and a zero-work result.
  turn.emit(initMessage('native-1'));
  turn.emit(taskNotificationMessage('orphan-1', 'stopped'));
  turn.emit(userReplay('<task-notification>orphan-1 stopped</task-notification>'));
  turn.emit(phantomResultMessage('native-1'));
  // Then the real delivered turn runs.
  turn.emit(assistantText('real answer'));
  turn.emit(resultMessage('real answer', 'native-1'));
  assert.equal(await pending, true);
  assert.ok(
    !stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    'bookkeeping replays must not become relay turns',
  );
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.messageId, 'q-1');
  assert.equal(response.body.text, 'real answer');
  // The orphan notification still surfaces, attached to the delivered turn.
  const activity = stub.calls.find((call) => call.routePath === '/api/activity' && /orphan-1/.test(call.body.text || ''));
  assert.equal(activity.body.messageId, 'q-1');
  turn.endInput();
  await settled(runner);
});

test('a mode-append change recycles an idle process but spares one holding tasks', async () => {
  const stub = makeApiStub();
  const spawns = [];
  const turns = [];
  const runner = makeRunner({
    stub,
    startImpl: (params) => {
      spawns.push(params);
      const turn = scriptedTurn({ echoPushes: true });
      turns.push(turn);
      return turn;
    },
  });

  // Turn 1 (agent), no background tasks left behind.
  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turns[0].emit(initMessage('native-1'));
  turns[0].emit(resultMessage('one', 'native-1'));
  assert.equal(await first, true);

  // Autopilot needs a different system prompt append → fresh process.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', relayMode: 'autopilot' } });
  await waitFor(() => turns.length === 2, { label: 'recycled spawn' });
  assert.equal(turns[0].endInputCalls >= 1, true, 'idle process released for the mode change');
  turns[1].emit(initMessage('native-1'));
  turns[1].emit(resultMessage('two', 'native-1'));
  assert.equal(await second, true);
  assert.equal(spawns[1].relayMode, 'autopilot');

  // Leave a live task, switch mode again: the process must survive.
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', relayMode: 'autopilot' } });
  await waitFor(() => turns[1].pushed.length === 2, { label: 'third push' });
  turns[1].emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'suite' }]));
  turns[1].emit(resultMessage('three', 'native-1'));
  assert.equal(await third, true);
  const fourth = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-4', relayMode: 'agent' } });
  await waitFor(() => turns[1].pushed.length === 3, { label: 'fourth push on same process' });
  turns[1].emit(resultMessage('four', 'native-1'));
  assert.equal(await fourth, true);
  assert.equal(spawns.length, 2, 'a task-holding process is never recycled for a mode change');
  turns[1].endInput();
  await settled(runner);
});

test('a failed continuation registration discards the turn without failing the process', async () => {
  const stub = makeApiStub({ failRoutes: new Set(['/api/continuation-turn']) });
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'suite' }]));
  turn.emit(resultMessage('started', 'native-1'));
  assert.equal(await pending, true);

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('bash-1'));
  turn.emit(userReplay('<task-notification>bash-1 completed</task-notification>'));
  turn.emit(assistantText('finished'));
  turn.emit(resultMessage('finished', 'native-1'));
  await waitFor(
    () => stub.calls.filter((call) => call.routePath === '/api/continuation-turn').length >= 3,
    { label: 'registration retries' },
  );
  await tick(30);
  const responses = stub.calls.filter((call) => call.routePath === '/api/response');
  assert.equal(responses.length, 1, 'the discarded continuation publishes nothing');
  assert.equal(turn.endInputCalls, 0, 'the process itself survives');
  turn.endInput();
  await settled(runner);
});
