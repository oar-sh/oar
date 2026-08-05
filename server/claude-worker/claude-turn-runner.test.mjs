import test from 'node:test';
import assert from 'node:assert/strict';

import { createClaudeTurnRunner, buildClaudePlanReadyBoardPayload } from './claude-turn-runner.mjs';

// Keeps the turn tests off the real `~/.claude/projects`; transcript
// relocation has its own suite in claude-transcript-relocator.test.mjs.
const noopRelocate = () => ({ status: 'skipped' });

function makeApiStub({ failRoutes = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      if (failRoutes.has(routePath)) throw new Error(`stubbed failure for ${routePath}`);
      return { ok: true };
    },
  };
}

function fakeTurn(messages) {
  return {
    async* [Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

function initMessage(sessionId) {
  return { type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-sonnet-5' };
}

function resultMessage(text, sessionId) {
  return { type: 'result', subtype: 'success', is_error: false, result: text, session_id: sessionId };
}

function backgroundTasksMessage(tasks) {
  return { type: 'system', subtype: 'background_tasks_changed', tasks };
}

function taskNotificationMessage(taskId, status = 'completed') {
  return { type: 'system', subtype: 'task_notification', task_id: taskId, status, summary: 'settled' };
}

// Mirrors the real CLI's lifetime: the message stream only ends after the
// input gate is released (endInput), never on its own. `onYield` observes the
// runner's state at the moment each message is handed over.
function gatedFakeTurn(messages, { onYield } = {}) {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const turn = {
    endInputCalls: 0,
    async* [Symbol.asyncIterator]() {
      for (const message of messages) {
        onYield?.(message, turn);
        yield message;
      }
      await gate;
    },
  };
  turn.endInput = () => {
    turn.endInputCalls += 1;
    release();
  };
  return turn;
}

const baseMessage = {
  id: 'q-1',
  conversationId: 'conv-1',
  relayMode: 'agent',
  text: 'hello',
  model: 'claude-sonnet-5',
  attachments: [],
};

test('first turn persists the native session id and later turns resume it', async () => {
  const stub = makeApiStub();
  const capturedTurns = [];
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: (params) => {
      capturedTurns.push(params);
      return fakeTurn([initMessage('native-1'), resultMessage('done', 'native-1')]);
    },
  });

  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: null } });
  assert.equal(capturedTurns[0].resume, '');
  const persist = stub.calls.find((call) => call.routePath === '/api/claude-native-session');
  assert.ok(persist, 'native session id must be persisted');
  assert.deepEqual(persist.body, { conversationId: 'conv-1', claudeNativeSessionId: 'native-1' });
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'done');

  // Second turn without a server-provided id resumes from the worker cache.
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', claudeNativeSessionId: null } });
  assert.equal(capturedTurns[1].resume, 'native-1');
});

test('a respawned worker resumes from the server-persisted id (kill survival)', async () => {
  const stub = makeApiStub();
  const capturedTurns = [];
  // Fresh runner = freshly spawned worker process after a kill.
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: (params) => {
      capturedTurns.push(params);
      return fakeTurn([initMessage('native-2'), resultMessage('resumed fine', 'native-2')]);
    },
  });
  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: 'native-1' } });
  assert.equal(capturedTurns[0].resume, 'native-1');
  // The (possibly new) session id from the resumed turn is persisted so the
  // chain keeps working across further restarts.
  const persist = stub.calls.find((call) => call.routePath === '/api/claude-native-session');
  assert.equal(persist.body.claudeNativeSessionId, 'native-2');
});

test('a resuming turn relocates the transcript into the current CWD first', async () => {
  const stub = makeApiStub();
  const relocations = [];
  const order = [];
  const runner = createClaudeTurnRunner({
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
    startClaudeTurnImpl: () => {
      order.push('turn');
      return fakeTurn([initMessage('native-1'), resultMessage('ok', 'native-1')]);
    },
  });

  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: 'native-1' } });

  assert.deepEqual(order, ['relocate', 'turn']);
  assert.equal(relocations[0].nativeSessionId, 'native-1');
  assert.equal(relocations[0].cwd, '/tmp/new-root');
});

test('a first turn has no transcript to relocate', async () => {
  const stub = makeApiStub();
  const relocations = [];
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: (params) => {
      relocations.push(params);
      return { status: 'skipped' };
    },
    startClaudeTurnImpl: () => fakeTurn([initMessage('native-1'), resultMessage('ok', 'native-1')]),
  });

  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: null } });

  assert.deepEqual(relocations, []);
});

test('failed persist is retried on the next turn instead of being cached', async () => {
  const failRoutes = new Set(['/api/claude-native-session']);
  const stub = makeApiStub({ failRoutes });
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => fakeTurn([initMessage('native-1'), resultMessage('ok', 'native-1')]),
  });
  await runner.handlePendingPayload({ message: { ...baseMessage, claudeNativeSessionId: null } });
  assert.equal(stub.calls.filter((call) => call.routePath === '/api/claude-native-session').length, 1);

  failRoutes.clear();
  await runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', claudeNativeSessionId: null } });
  const persists = stub.calls.filter((call) => call.routePath === '/api/claude-native-session');
  assert.equal(persists.length, 2, 'persist must be retried after a failure');
});

test('per-turn model and effort reach the SDK turn', async () => {
  const stub = makeApiStub();
  const capturedTurns = [];
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: (params) => {
      capturedTurns.push(params);
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
  assert.equal(capturedTurns[0].model, 'claude-opus-5[1m]');
  assert.equal(capturedTurns[0].reasoningEffort, 'xhigh');
});

test('sdk failure publishes a terminal response instead of hanging the queue', async () => {
  const stub = makeApiStub();
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => {
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
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => fakeTurn([
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
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => fakeTurn([
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
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: (params) => {
      capturedCanUseTool = params.canUseTool;
      return fakeTurn([initMessage('native-1'), resultMessage('Plan is ready for review.', 'native-1')]);
    },
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage, relayMode: 'plan' } });
  // Give runTurn a tick to hand canUseTool to the SDK stub, then fire the
  // interception the way the CLI would mid-turn.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(capturedCanUseTool, 'runner must wire canUseTool into the turn');
  const decision = await capturedCanUseTool('ExitPlanMode', { plan: '', planFilePath }, {});
  assert.equal(decision.behavior, 'deny', 'plan approval must come from the board, not the turn');
  await pending;
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

test('context usage is read while the query is still open and then published', async () => {
  const stub = makeApiStub();
  const events = [];
  // A Query that only answers control requests until its iterator is drained,
  // mirroring the SDK tearing down the transport when the turn ends.
  function contextAwareTurn(messages) {
    let closed = false;
    return {
      async getContextUsage() {
        if (closed) throw new Error('transport closed');
        events.push('getContextUsage');
        return { totalTokens: 247100, maxTokens: 1000000, percentage: 24.71, categories: [] };
      },
      async* [Symbol.asyncIterator]() {
        for (const message of messages) yield message;
        closed = true;
      },
    };
  }

  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'sess-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => contextAwareTurn([initMessage('native-1'), resultMessage('done', 'native-1')]),
  });

  await runner.handlePendingPayload({ message: { ...baseMessage } });

  assert.deepEqual(events, ['getContextUsage'], 'read exactly once, before the transport closed');
  const post = stub.calls.find((call) => call.routePath === '/api/claude-context-usage');
  assert.ok(post, 'context usage must be published');
  assert.equal(post.body.conversationId, 'conv-1');
  assert.equal(post.body.sdkSessionId, 'sess-1');
  assert.equal(post.body.contextUsage.totalTokens, 247100);
});

test('a runtime without the context control request still completes the turn', async () => {
  const stub = makeApiStub();
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'sess-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => fakeTurn([initMessage('native-1'), resultMessage('done', 'native-1')]),
  });

  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  assert.ok(stub.calls.find((call) => call.routePath === '/api/response'), 'response still published');
  assert.ok(
    !stub.calls.find((call) => call.routePath === '/api/claude-context-usage'),
    'nothing to publish when the runtime cannot report context',
  );
});

test('a failing context publish does not disturb the response', async () => {
  const stub = makeApiStub({ failRoutes: new Set(['/api/claude-context-usage']) });
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'sess-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => ({
      async getContextUsage() {
        return { totalTokens: 10, maxTokens: 100, percentage: 10, categories: [] };
      },
      async* [Symbol.asyncIterator]() {
        yield initMessage('native-1');
        yield resultMessage('done', 'native-1');
      },
    }),
  });

  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'done');
});

test('a live background agent holds the input gate across its continuation turn', async () => {
  const stub = makeApiStub();
  const contextReads = [];
  let releasesAtNotification = -1;
  const turn = gatedFakeTurn([
    initMessage('native-1'),
    backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'impl' }]),
    resultMessage('dispatched', 'native-1'),
    backgroundTasksMessage([]),
    taskNotificationMessage('agent-1'),
    initMessage('native-1'), // the CLI dequeues the notification as a new turn
    resultMessage('followed up', 'native-1'),
  ], {
    onYield: (message, self) => {
      // The gate must still be held when the settled notification arrives —
      // a released gate is the "Stream closed" permission staleness bug.
      if (message.subtype === 'task_notification') releasesAtNotification = self.endInputCalls;
    },
  });
  turn.getContextUsage = async () => {
    contextReads.push('read');
    return { totalTokens: 1, maxTokens: 100, percentage: 1, categories: [] };
  };

  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => turn,
  });
  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });

  assert.equal(handled, true);
  assert.equal(releasesAtNotification, 0, 'gate must stay held while the agent runs');
  assert.equal(contextReads.length, 1, 'context is read once, at the real end of the turn');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'dispatched\n\nfollowed up', 'every result segment is the answer');
});

test('backgrounded bash alone does not hold the gate', async () => {
  const stub = makeApiStub();
  const turn = gatedFakeTurn([
    initMessage('native-1'),
    // A dev server: never settles, must not wedge the turn.
    backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'npm run dev' }]),
    resultMessage('server started', 'native-1'),
  ]);
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => turn,
  });
  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true);
  assert.ok(turn.endInputCalls >= 1, 'result must release the gate immediately');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'server started');
});

test('a task that settles before the result still holds the gate for its continuation', async () => {
  const stub = makeApiStub();
  let initsSeen = 0;
  let releasesAtContinuationInit = -1;
  const turn = gatedFakeTurn([
    initMessage('native-1'),
    backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'quick job' }]),
    backgroundTasksMessage([]),
    taskNotificationMessage('agent-1'),
    // The fast-completion race: the live set is already empty when the main
    // turn's result arrives, but the notification's continuation is queued.
    resultMessage('dispatched', 'native-1'),
    initMessage('native-1'),
    resultMessage('followed up', 'native-1'),
  ], {
    onYield: (message, self) => {
      if (message.subtype !== 'init') return;
      initsSeen += 1;
      if (initsSeen === 2) releasesAtContinuationInit = self.endInputCalls;
    },
  });
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => turn,
  });
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(releasesAtContinuationInit, 0, 'gate must still be held when the continuation starts');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'dispatched\n\nfollowed up');
});

test('a held gate is released after stream silence when no continuation comes', async () => {
  const stub = makeApiStub();
  const turn = gatedFakeTurn([
    initMessage('native-1'),
    backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]),
    backgroundTasksMessage([]),
    taskNotificationMessage('agent-1'),
    resultMessage('dispatched', 'native-1'),
    // Stream then hangs: the promised continuation never materializes.
  ]);
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => turn,
    backgroundIdleReleaseMs: 30,
    backgroundLingerPollMs: 10,
  });
  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true, 'idle backstop must end the turn');
  assert.ok(turn.endInputCalls >= 1);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'dispatched');
});

test('the linger cap releases the gate even while an agent is still live', async () => {
  const stub = makeApiStub();
  const turn = gatedFakeTurn([
    initMessage('native-1'),
    backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'wedged job' }]),
    resultMessage('dispatched', 'native-1'),
    // Stream hangs with the agent forever "running".
  ]);
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'conv-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => turn,
    backgroundLingerCapMs: 40,
    backgroundLingerPollMs: 10,
  });
  const handled = await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.equal(handled, true, 'linger cap must end the turn');
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.text, 'dispatched');
});

test('the input gate is released on success and on error paths', async () => {
  const stub = makeApiStub();
  let releasedOnSuccess = 0;
  const successTurn = {
    endInput: () => { releasedOnSuccess += 1; },
    async getContextUsage() { return { totalTokens: 1, maxTokens: 100, percentage: 1, categories: [] }; },
    async* [Symbol.asyncIterator]() {
      yield initMessage('native-1');
      yield resultMessage('done', 'native-1');
    },
  };
  const runner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'sess-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => successTurn,
  });
  await runner.handlePendingPayload({ message: { ...baseMessage } });
  assert.ok(releasedOnSuccess >= 1, 'gate must release after capture');

  let releasedOnError = 0;
  const errorTurn = {
    endInput: () => { releasedOnError += 1; },
    // eslint-disable-next-line require-yield
    async* [Symbol.asyncIterator]() { throw new Error('boom'); },
  };
  const errorRunner = createClaudeTurnRunner({
    api: stub.api,
    sdkSessionId: 'sess-1',
    cwd: '/tmp',
    relocateTranscriptImpl: noopRelocate,
    startClaudeTurnImpl: () => errorTurn,
  });
  await errorRunner.handlePendingPayload({ message: { ...baseMessage } });
  assert.ok(releasedOnError >= 1, 'a throwing turn must still release the gate');
});
