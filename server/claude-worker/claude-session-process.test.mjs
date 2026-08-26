import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import osModule from 'node:os';
import nodePathModule from 'node:path';

import { createClaudeSessionRunner } from './claude-session-process.mjs';
import { buildClaudePlanReadyBoardPayload } from './claude-turn-publisher.mjs';
import { EMPTY_TURN_COMPLETION_NOTE } from '../../shared/empty-turn-completion.mjs';
import {
  noopRelocate,
  tick,
  waitFor,
  makeApiStub,
  scriptedTurn,
  fakeTurn,
  initMessage,
  resultMessage,
  phantomResultMessage,
  backgroundTasksMessage,
  taskNotificationMessage,
  compactBoundaryMessage,
  compactingStatusMessage,
  compactSummaryReplay,
  taskNotificationReplay,
  userReplay,
  assistantText,
  baseMessage,
  makeRunner,
  settled,
} from './claude-session-test-harness.mjs';

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

test('ultracode reaches the SDK spawn as the sentinel, not a bare effort', async () => {
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
    message: { ...baseMessage, reasoningEffort: 'ultracode' },
  });
  // The adapter owns the translation to effort 'xhigh' + settings flags; the
  // runner must hand it the sentinel untouched.
  assert.equal(capturedSpawns[0].reasoningEffort, 'ultracode');
});

test('mid-session effort changes toggle the ultracode flags, idempotently', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const flagCalls = [];
  turn.applyFlagSettings = async (settings) => { flagCalls.push(settings); };
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage, reasoningEffort: 'medium' } });
  turn.emit(initMessage('native-1'));
  turn.emit(resultMessage('first answer', 'native-1'));
  assert.equal(await first, true);
  assert.deepEqual(flagCalls, [], 'spawn-time effort must not produce a flag-settings call');

  const second = runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-2', text: 'go ultracode', reasoningEffort: 'ultracode' },
  });
  await waitFor(() => turn.pushed.length === 2, { label: 'second push' });
  turn.emit(resultMessage('ultracode answer', 'native-1'));
  assert.equal(await second, true);
  assert.deepEqual(flagCalls, [
    { ultracode: true, enableWorkflows: true, effortLevel: 'xhigh' },
  ]);

  // Same effort again: no redundant control request.
  const third = runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-3', text: 'still ultracode', reasoningEffort: 'ultracode' },
  });
  await waitFor(() => turn.pushed.length === 3, { label: 'third push' });
  turn.emit(resultMessage('still ultracode', 'native-1'));
  assert.equal(await third, true);
  assert.equal(flagCalls.length, 1, 'unchanged effort must not re-send flag settings');

  // Leaving ultracode clears the session flags alongside the new effort.
  const fourth = runner.handlePendingPayload({
    message: { ...baseMessage, id: 'q-4', text: 'back to high', reasoningEffort: 'high' },
  });
  await waitFor(() => turn.pushed.length === 4, { label: 'fourth push' });
  turn.emit(resultMessage('back to high', 'native-1'));
  assert.equal(await fourth, true);
  assert.deepEqual(flagCalls[1], { ultracode: null, enableWorkflows: null, effortLevel: 'high' });

  turn.endInput();
  await settled(runner);
});

test('the auto-compact window reaches the spawn and reconciles drift live', async () => {
  const stub = makeApiStub();
  const capturedSpawns = [];
  const turn = scriptedTurn({ echoPushes: true });
  const flagCalls = [];
  turn.applyFlagSettings = async (settings) => { flagCalls.push(settings); };
  // The window arrives piggybacked on each delivery, so the runner reads it
  // through a getter rather than off the message.
  let deliveredWindow = 150000;
  const runner = makeRunner({
    stub,
    startImpl: (params) => {
      capturedSpawns.push(params);
      return turn;
    },
    getAutoCompactWindow: () => deliveredWindow,
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(resultMessage('first', 'native-1'));
  assert.equal(await first, true);
  assert.equal(capturedSpawns[0].autoCompactWindow, 150000, 'spawn carries the window');
  assert.deepEqual(flagCalls, [], 'a spawn-time window needs no flag-settings call');

  // Unchanged window: no redundant control request.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2' } });
  await waitFor(() => turn.pushed.length === 2, { label: 'second push' });
  turn.emit(resultMessage('second', 'native-1'));
  assert.equal(await second, true);
  assert.equal(flagCalls.length, 0);

  deliveredWindow = 500000;
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3' } });
  await waitFor(() => turn.pushed.length === 3, { label: 'third push' });
  turn.emit(resultMessage('third', 'native-1'));
  assert.equal(await third, true);
  assert.deepEqual(flagCalls, [{ autoCompactWindow: 500000 }]);

  // Back to Auto: the flag layer must be cleared, or the setting is one-way.
  deliveredWindow = null;
  const fourth = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-4' } });
  await waitFor(() => turn.pushed.length === 4, { label: 'fourth push' });
  turn.emit(resultMessage('fourth', 'native-1'));
  assert.equal(await fourth, true);
  assert.deepEqual(flagCalls[1], { autoCompactWindow: null });

  turn.endInput();
  await settled(runner);
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

test('a background-task continuation with no user-replay (real SDK shape) still publishes', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'sleep 8' }]));
  turn.emit(resultMessage('Started; I will be notified.', 'native-1'));
  assert.equal(await pending, true);

  // Real SDK continuation shape, captured from the live SDK via a scratch probe:
  // the task settles (background_tasks_changed []), a completion notification
  // arrives, then a BARE init opens the continuation turn followed straight by
  // assistant/result — there is NO user-message replay. Before the init-boundary
  // fix, resolveContext() dropped the assistant frame as between-turn chatter and
  // the continuation never reached the relay (the live "silent continuation" bug).
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('bash-1'));
  turn.emit(initMessage('native-1'));
  turn.emit(assistantText('FINISHED'));
  turn.emit(resultMessage('FINISHED', 'native-1'));

  const continuationResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.equal(continuationResponse.body.text, 'FINISHED');
  const registration = stub.calls.find((call) => call.routePath === '/api/continuation-turn');
  assert.ok(registration, 'the continuation registered its own relay turn');

  turn.endInput();
  await settled(runner);
});

test('a settled task keeps the process alive for its continuation even when the notification is silent', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  // A short idle window with a fast lifecycle poll so an idle-out would fire
  // within the test; the settle-grace must hold the process open regardless.
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    idleShutdownMs: 40,
    lifecyclePollMs: 10,
    notificationGraceMs: 500,
  });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'e2e suite' }]));
  turn.emit(resultMessage('Runs started; I will be notified.', 'native-1'));
  assert.equal(await pending, true);

  // The task settles and its completion notification is silent (skip_transcript).
  // Before the settle-grace fix this left nothing pinning the process, so it
  // idled out in the gap before the continuation's first traffic and the
  // "you will be notified" turn was lost until the next user message respawned it.
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('bash-1', 'completed', { skipTranscript: true }));

  // Wait well past idleShutdownMs; the process must still be alive.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(runner._getProcess(), 'the process must survive the settle→continuation gap');
  assert.equal(turn.endInputCalls, 0, 'no idle-out endInput during the settle grace');

  // The continuation then arrives and publishes as its own turn.
  turn.emit(userReplay('<task-notification>bash-1 completed</task-notification>'));
  turn.emit(assistantText('All three runs passed.'));
  turn.emit(resultMessage('All three runs passed.', 'native-1'));
  const continuationResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.equal(continuationResponse.body.text, 'All three runs passed.');

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
  // No echo: the real CLI replays a queued message only when it dequeues it,
  // which for this test's scenario is AFTER the continuation's own result
  // (an immediate mid-turn replay means absorption — covered separately).
  const turn = scriptedTurn();
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
  turn.emit(userReplay('status?'));
  turn.emit(assistantText('here is the status'));
  turn.emit(resultMessage('here is the status', 'native-1'));
  assert.equal(await second, true);
  const secondResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal(secondResponse.body.text, 'here is the status');
  turn.endInput();
  await settled(runner);
});

test('a message absorbed into a running continuation completes on that turn result', async () => {
  // The 2026-08-18 deadlock (conv f93135ac row 962c36b1): the CLI dequeued a
  // pushed message INTO the running background-continuation turn (its replay
  // arrived while the continuation context was active) and emitted ONE result
  // for the whole turn. The delivered row must get that result — not sit in
  // pendingDelivered forever while the continuation swallows the answer.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);

  // Continuation opens and is mid-flight...
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  turn.emit(userReplay('<task-notification>agent-1 completed</task-notification>'));
  turn.emit(assistantText('checking what the agent produced'));
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  // ...and the CLI dequeues the pushed message into the SAME turn (steering):
  // replay mid-turn, then the turn's single result.
  turn.emit(userReplay('quick question'));
  turn.emit(assistantText('here is the answer'));
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await second, true);
  const secondResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    { label: 'absorbed message response' },
  );
  assert.equal(secondResponse.body.text, 'here is the answer');
  // The handed-off continuation streamed no text, so it settles by requeue
  // (the server drops a processing continuation quietly) — never a response
  // that would swallow the answer.
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/requeue' && call.body.messageId === 'cont-1'),
    { label: 'continuation requeue-drop' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    undefined,
  );
  assert.equal(runner._getProcess().pendingDelivered.length, 0);
  turn.endInput();
  await settled(runner);
});

test('a message absorbed into a running delivered turn frees both rows', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(assistantText('working on it'));
  // Second message lands while the first turn is still streaming; the CLI
  // absorbs it: replay mid-turn, one result for the combined turn.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'and also this' } });
  await tick(20);
  turn.emit(userReplay('and also this'));
  turn.emit(resultMessage('did both things', 'native-1'));

  // The first row settles at the handoff boundary with a merge note — NEVER
  // a requeue, which would re-deliver a prompt the CLI already consumed and
  // execute it twice. The second row owns the turn's result. Both
  // handlePendingPayload calls resolve — nothing is orphaned.
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/requeue' && call.body.messageId === 'q-1'),
    undefined,
  );
  const firstResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1');
  assert.match(firstResponse.body.text, /merged into the next message/);
  const secondResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal(secondResponse.body.text, 'did both things');
  assert.equal(runner._getProcess().pendingDelivered.length, 0);
  turn.endInput();
  await settled(runner);
});

test('the watchdog fails over a delivered entry the CLI never opens a turn for', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    pendingDeliveredTimeoutMs: 60,
    lifecyclePollMs: 10,
  });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  // No user replay ever arrives — the CLI dropped (or silently absorbed) the
  // push. The watchdog must fail the row over instead of renewing its lease
  // forever.
  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.ok(response?.body?.terminalError, 'terminal error published');
  assert.match(String(response.body.text || ''), /watchdog/);
  assert.equal(runner._getProcess().pendingDelivered.length, 0);
  turn.endInput();
  await settled(runner);
});

// ---------------------------------------------------------------------------
// Compaction (conv 563e252e, 2026-08-20: a 614k-token session resumed against a
// freshly lowered 100k window compacted for 133s at resume)

function compactionActivities(stub) {
  return stub.calls.filter(
    (call) => call.routePath === '/api/activity' && call.body?.metadata?.kind === 'compact_boundary',
  );
}

test('a compaction with no turn open publishes onto the next turn, exactly once', async () => {
  // Compaction at resume arrives before anything attaches, so the per-turn
  // normalizer never sees it — the boundary was dropped on the floor and no
  // conversation had ever recorded one.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  await tick(20);
  assert.equal(compactionActivities(stub).length, 0, 'nothing to publish onto yet');

  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await pending, true);

  const boundaries = compactionActivities(stub);
  assert.equal(boundaries.length, 1);
  assert.equal(boundaries[0].body.messageId, 'q-1');
  // post_tokens is genuinely absent from real auto-compact payloads: the row
  // degrades to a pre-only label instead of losing its metadata.
  assert.deepEqual(boundaries[0].body.metadata, {
    kind: 'compact_boundary',
    preTokens: 614117,
    postTokens: null,
  });
  assert.equal(boundaries[0].body.text, 'Context compacted (was 614.1k tokens)');
  turn.endInput();
  await settled(runner);
});

test('a compaction during a turn publishes exactly once, on that turn', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(compactBoundaryMessage({ preTokens: 120000, postTokens: 40000 }));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await pending, true);

  // The buffer is what a second publish would come out of, and it only drains
  // when another context activates — so the next turn is where a duplicate
  // would show up, not this one.
  assert.deepEqual(runner._getProcess().pendingActivities, [], 'nothing left to re-publish');
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'again' } });
  turn.emit(userReplay('again'));
  turn.emit(resultMessage('done again', 'native-1'));
  assert.equal(await second, true);

  const boundaries = compactionActivities(stub);
  assert.equal(boundaries.length, 1, 'the process-level observer must not double-publish');
  assert.equal(boundaries[0].body.messageId, 'q-1');
  assert.equal(boundaries[0].body.text, 'Context compacted (120k → 40k tokens)');
  turn.endInput();
  await settled(runner);
});

test('the watchdog leaves a delivered entry alone while the CLI is compacting', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    pendingDeliveredTimeoutMs: 60,
    lifecyclePollMs: 10,
  });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  // Compaction is minutes of completely silent work: no active turn, no live
  // task, no control round-trip. Counting it as idleness failed the row over
  // on a turn the CLI went on to answer.
  // Announced once and then silence — the CLI's periodic re-emit is
  // remote-control-only, so the hold has to survive on this single signal.
  turn.emit(compactingStatusMessage());
  await tick(200);
  assert.equal(runner._getProcess().pendingDelivered.length, 1, 'not reaped mid-compaction');

  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(resultMessage('answered after compacting', 'native-1'));
  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'answered after compacting');
  assert.ok(!response.body.terminalError);
  turn.endInput();
  await settled(runner);
});

test('the turn the CLI re-opens after compacting belongs to the delivered message', { timeout: 15_000 }, async () => {
  // The CLI answers the delivered message AFTER the boundary, re-opening the
  // turn with its own compaction summary — text that matches no pending entry.
  // Read as a self-opened turn, the answer published on a synthetic
  // continuation row and the real one orphaned until the watchdog failed it.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(assistantText('here is the answer'));
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'here is the answer');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    undefined,
    'the delivered row owns the turn — no synthetic one may be registered',
  );
  assert.equal(runner._getProcess().pendingDelivered.length, 0);
  turn.endInput();
  await settled(runner);
});

test('after a settled task, a compaction replay and a notification each get the right turn', { timeout: 15_000 }, async () => {
  // Both halves at once, in a session that has had a background task settle —
  // the case every bookkeeping design got wrong in one direction or the other.
  // The compaction's own replay belongs to the delivered message; the task's
  // notification replay belongs to a continuation of its own. They are told
  // apart by the CLI's `<task-notification>` tag, not by what the runner
  // believes it is owed.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 30 });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  // A message is pushed, then the CLI compacts for longer than any
  // continuation grace window before dequeuing anything.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(80);
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  // The compaction re-opens the delivered turn with its own summary: q-2's.
  turn.emit(compactSummaryReplay());
  turn.emit(resultMessage('answered after compacting', 'native-1'));
  assert.equal(await second, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-2',
  );
  assert.equal(response.body.text, 'answered after compacting');
  assert.ok(!response.body.terminalError, 'the delivered row must not be failed over');

  // The task's notification is still owed a turn, and opens its own.
  turn.emit(userReplay('<task-notification>agent-1 completed</task-notification>'));
  turn.emit(resultMessage('the agent finished', 'native-1'));
  const continuation = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.equal(continuation.body.text, 'the agent finished');
  turn.endInput();
  await settled(runner);
});

// Both orders in which a compaction can land inside a turn the CLI opened for
// a settled task. The untagged summary row follows ANY compaction, so "is this
// message a notification" cannot answer "is this turn the delivered message's"
// on its own — the turn-level signal has to carry it.
test('a compaction inside a task continuation does not take the queued message', { timeout: 15_000 }, async () => {
  // The notification replays FIRST, so the turn is already the task's when the
  // compaction fires. Adoption here posted the agent's report as the answer to
  // the user's queued message.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 30 });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  // The CLI opens the task's continuation, then compacts inside it.
  turn.emit(taskNotificationReplay());
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(resultMessage('the agent finished', 'native-1'));

  const continuation = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the task report gets its own row' },
  );
  assert.equal(continuation.body.text, 'the agent finished');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    undefined,
    'the queued message must not be closed by the task report',
  );

  // The delivered message is still owed its turn, and gets it.
  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-2',
  );
  assert.equal(response.body.text, 'your answer');
  turn.endInput();
  await settled(runner);
});

test('an adopted turn is handed back when the notification replays after the summary', { timeout: 15_000 }, async () => {
  // The reverse order: the summary row arrives first and adoption takes the
  // queued row, then the notification replays into the SAME turn — proving the
  // turn was the task's all along. Nothing has published yet, so the adoption
  // unwinds instead of stealing the answer.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 30 });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 0, 'adopted, provisionally');
  turn.emit(taskNotificationReplay());
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 1, 'handed back to the queue head');
  turn.emit(resultMessage('the agent finished', 'native-1'));

  const continuation = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the task report gets its own row' },
  );
  assert.equal(continuation.body.text, 'the agent finished');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    undefined,
    'the queued message must not be closed by the task report',
  );

  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-2',
  );
  assert.equal(response.body.text, 'your answer');
  turn.endInput();
  await settled(runner);
});

test('a streaming adopted turn is not unwound by a late notification', { timeout: 15_000 }, async () => {
  // The hand-back must be strictly between the summary row and the turn's
  // first output: once the adopted turn has streamed, unwinding it would drop
  // published text on the floor.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(assistantText('working on it'));
  await tick(20);
  turn.emit(taskNotificationReplay());
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 0, 'the adoption is committed');
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'here is the answer');
  turn.endInput();
  await settled(runner);
});

// A helper for the several orders below that need a settled background task
// before the compaction: runs one delivered turn that dispatches `agent-1`,
// then settles it. Leaves the process idle with nothing queued.
async function settleOneBackgroundTask(runner, turn, stub) {
  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  return stub;
}

test('a system frame between the summary and the notification does not commit the adoption', { timeout: 15_000 }, async () => {
  // The provisional flag may only be spent by real OUTPUT. The compaction's
  // own terminator status lands between the summary row and the notification
  // replay in the most ordinary order there is; committing on it would make
  // the hand-back unreachable exactly where it is needed.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 30 });
  await settleOneBackgroundTask(runner, turn, stub);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  turn.emit(taskNotificationReplay());
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 1, 'handed back despite the status frame');
  turn.emit(resultMessage('the agent finished', 'native-1'));

  const continuation = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the task report gets its own row' },
  );
  assert.equal(continuation.body.text, 'the agent finished');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    undefined,
  );
  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  turn.endInput();
  await settled(runner);
});

test('a self-opened turn with any stamped origin is not the compaction replay', { timeout: 15_000 }, async () => {
  // SDKMessageOrigin is a nine-member union and the compact summary carries
  // NO origin at all, so the test has to be positive: a cross-session `peer`
  // message read as the compaction's summary would steal the row for good
  // (the hand-back only recognizes task notifications).
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit({
    type: 'user',
    parent_tool_use_id: null,
    origin: { kind: 'peer', from: 'other-session' },
    message: { role: 'user', content: 'please review PR 42' },
  });
  turn.emit(resultMessage('reviewed PR 42 for you', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    { label: 'the peer turn registers its own row' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1'),
    undefined,
    'a peer message must not close the queued row',
  );

  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  assert.equal(await pending, true);
  turn.endInput();
  await settled(runner);
});

test('a compaction inside a bare-init continuation does not take the queued message', { timeout: 15_000 }, async () => {
  // The live-verified continuation shape has NO user replay at all — just a
  // bare init. With a message queued behind it, that init is the only signal
  // that the turn is the CLI's own, and nothing later can correct a wrong
  // adoption.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 5_000 });
  await settleOneBackgroundTask(runner, turn, stub);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(assistantText('the agent finished'));
  turn.emit(resultMessage('the agent finished', 'native-1'));

  const continuation = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the bare-init continuation gets its own row' },
  );
  assert.equal(continuation.body.text, 'the agent finished');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    undefined,
  );
  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  turn.endInput();
  await settled(runner);
});

test('a provisional adoption absorbed as steering gives the row back instead of merging it', { timeout: 15_000 }, async () => {
  // The absorbed-steering branch settles the outgoing turn with "merged into
  // the next message" and never requeues it — correct for a row the CLI has
  // consumed, catastrophic for one it has not: a provisionally adopted row was
  // never replayed, so it is still owed a turn.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await tick(20);
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'and another' } });
  await tick(20);
  turn.emit(userReplay('and another'));
  turn.emit(resultMessage('answering the third', 'native-1'));
  assert.equal(await third, true);

  const answerFor = (id) => stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === id,
  )?.body.text;
  assert.equal(answerFor('q-3'), 'answering the third');
  assert.equal(answerFor('q-2'), undefined, 'q-2 must not be settled as merged');

  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('answering the second', 'native-1'));
  assert.equal(await second, true);
  assert.equal(answerFor('q-2'), 'answering the second');
  turn.endInput();
  await settled(runner);
});

test('a phantom result on an adopted turn gives the row back instead of wedging', { timeout: 15_000 }, async () => {
  // A phantom closes the turn with nothing published and is skipped by the
  // normalizer, so a committed adoption would leave the context active with
  // no result ever coming — the queue entry gone from the watchdog's reach and
  // handlePendingPayload never resolving.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(phantomResultMessage('native-1'));
  await tick(30);
  const proc = runner._getProcess();
  assert.equal(proc.activeCtx, null, 'the phantom released the context');
  assert.equal(proc.pendingDelivered.length, 1, 'the row is back under the watchdog');

  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'the real answer');
  turn.endInput();
  await settled(runner);
});

test('a handed-back row goes to the head of the queue, and only once', { timeout: 15_000 }, async () => {
  // Ordering and idempotence of the restore: the handed-back entry is still
  // the next thing the CLI owes, anything queued behind it stays behind it,
  // and the restored context must lose its provisional flag so a LATER
  // notification cannot unwind it a second time.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 30 });
  await settleOneBackgroundTask(runner, turn, stub);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await tick(20);
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'and another' } });
  await tick(20);
  // Stamped as if the watchdog had already started counting this entry as
  // unattached; the restore has to clear it or the CLI's own compaction time
  // is charged against the row it is about to replay.
  runner._getProcess().activeCtx.deliveredEntry.unattachedSince = 1;
  // Likewise the provisional quiet clock: it is per-adoption, and carried into
  // a later one the row would be reaped on the first poll of a turn that was
  // about to answer it.
  runner._getProcess().activeCtx.provisionalSince = 1;
  turn.emit(taskNotificationReplay());
  await tick(20);
  const proc = runner._getProcess();
  assert.deepEqual(
    proc.pendingDelivered.map((entry) => entry.ctx.message.id),
    ['q-2', 'q-3'],
    'restored to the head, not appended behind q-3',
  );
  assert.equal(proc.pendingDelivered[0].ctx.adoptedFromCompaction, false, 'no longer provisional');
  assert.equal(proc.pendingDelivered[0].unattachedSince, 0, 'the unattached clock restarts');
  assert.equal(proc.pendingDelivered[0].ctx.provisionalSince, 0, 'the provisional clock restarts');
  turn.emit(resultMessage('the agent finished', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the task report gets its own row' },
  );

  // Attached for real now: a notification arriving mid-turn must NOT unwind it.
  turn.emit(userReplay('quick question'));
  await tick(20);
  turn.emit(taskNotificationReplay());
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  const answerFor = (id) => stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === id,
  )?.body.text;
  assert.equal(answerFor('q-2'), 'your answer');
  turn.emit(userReplay('and another'));
  turn.emit(resultMessage('the third answer', 'native-1'));
  assert.equal(await third, true);
  turn.endInput();
  await settled(runner);
});

test('the delivered message replaying its own text after the summary keeps the turn', { timeout: 15_000 }, async () => {
  // The hand-back triggers on a task notification specifically. The CLI also
  // replays the delivered message's own text after a compaction, and that
  // replay is the confirmation the adoption was RIGHT — unwinding on it would
  // hand the row's own turn to a synthetic continuation.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'here is the answer');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    undefined,
    'no synthetic row — the turn was the delivered message’s all along',
  );
  turn.endInput();
  await settled(runner);
});

test('a handed-back adoption leaves no control poller running', { timeout: 15_000 }, async () => {
  // activateContext starts a poller per attach, and the restored entry gets
  // another one when it attaches for real; the provisional one has to be
  // stopped or the abort control for a dead context outlives it.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const started = [];
  const stopped = [];
  const controlPoller = {
    start: ({ queueMessageId }) => {
      const state = { queueMessageId };
      started.push(state);
      return state;
    },
    stop: (state) => { if (state) stopped.push(state); },
  };
  const runner = makeRunner({ stub, startImpl: () => turn, controlPoller, notificationGraceMs: 30 });
  await settleOneBackgroundTask(runner, turn, stub);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await tick(20);
  const provisional = started.at(-1);
  assert.equal(provisional.queueMessageId, 'q-2', 'the adoption started a poller for q-2');
  turn.emit(taskNotificationReplay());
  await tick(20);
  assert.ok(stopped.includes(provisional), 'the provisional poller is stopped on hand-back');

  turn.emit(resultMessage('the agent finished', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the task report gets its own row' },
  );
  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  turn.endInput();
  await settled(runner);
  assert.equal(started.length, stopped.length, 'every poller started was stopped');
});

test('a restored row does not inherit the turn that displaced it', { timeout: 15_000 }, async () => {
  // Normalizer inheritance is for a genuine hand-off, where the outgoing
  // context is settled and never used again. A RESTORED one runs its own turn
  // later, and a shared normalizer publishes the displacing turn's streamed
  // text as the restored row's answer — its stream text survives a result.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await tick(20);
  runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'and another' } }).catch(() => {});
  await tick(20);
  turn.emit(userReplay('and another'));
  turn.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the third answer only' } },
  });
  turn.emit(resultMessage('the third answer only', 'native-1'));
  await tick(30);
  // The stream ends with q-2 still queued: it must be requeued, never answered
  // with text that belongs to q-3.
  turn.endInput();
  await settled(runner);

  const answerFor = (id) => stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === id,
  )?.body.text;
  assert.equal(answerFor('q-3'), 'the third answer only');
  assert.notEqual(answerFor('q-2'), 'the third answer only', 'q-2 must not inherit q-3’s text');
  await second.catch(() => {});
});

test('a settled task does not divert a delivered turn that has no replay', { timeout: 15_000 }, async () => {
  // Suppressing adoption after a task settles must not also divert assistant
  // traffic: a delivered turn whose replay never precedes its output attaches
  // on that output, and marking the turn self-opened would fail the row over
  // while publishing its answer on a synthetic continuation.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    notificationGraceMs: 5_000,
    pendingDeliveredTimeoutMs: 300,
    lifecyclePollMs: 10,
  });
  await settleOneBackgroundTask(runner, turn, stub);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(initMessage('native-1'));
  turn.emit(assistantText('your answer'));
  turn.emit(resultMessage('your answer', 'native-1'));

  assert.equal(await second, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-2',
  );
  assert.equal(response.body.text, 'your answer');
  assert.ok(!response.body.terminalError, 'the row must not be failed over');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    undefined,
    'no synthetic row — this turn was the delivered message’s',
  );
  turn.endInput();
  await settled(runner);
});

test('a provisional adoption that produces nothing gives the row back to the watchdog', { timeout: 15_000 }, async () => {
  // Adoption takes the entry out of pendingDelivered on an inference. If the
  // turn then goes silent, nothing can fail the row over and the process is
  // pinned forever by its own guess — worse than the orphan it replaced.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    pendingDeliveredTimeoutMs: 100,
    idleShutdownMs: 5_000,
    lifecyclePollMs: 10,
  });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 0, 'adopted');

  // Total silence from here: the row comes back and the watchdog fails it
  // over, instead of the process sitting pinned on its own guess forever.
  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.match(response.body.terminalError.message, /never opened a turn for this message/);
  turn.endInput();
  await settled(runner);
});

test('a compaction inside a discarded continuation still reaches the next turn', { timeout: 15_000 }, async () => {
  // A continuation whose registration fails every attempt is `discarded` but
  // still the active context, and dispatchToContext drops everything handed to
  // it. Read as "a context is active", the boundary would be published into
  // that void and the break row would vanish.
  const stub = makeApiStub({ failRoutes: new Set(['/api/continuation-turn']) });
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-0', text: 'first' } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('first'));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);

  turn.emit(userReplay('a turn the CLI opened by itself'));
  turn.emit(assistantText('working'));
  await waitFor(
    () => runner._getProcess()?.activeCtx?.discarded,
    { label: 'the continuation gave up registering' },
  );
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(resultMessage('done', 'native-1'));
  await tick(30);

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  assert.equal(await pending, true);
  const boundaries = compactionActivities(stub);
  assert.equal(boundaries.length, 1, 'buffered past the discarded context, published once');
  assert.equal(boundaries[0].body.messageId, 'q-1');
  turn.endInput();
  await settled(runner);
});

test('an adoption committed by stream deltas alone is not unwound', { timeout: 15_000 }, async () => {
  // A turn can publish through stream_event deltas without ever emitting a
  // complete assistant frame. Committing only on `assistant` would let a later
  // notification hand back a row whose answer is already on the wire.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'here is the answer' } },
  });
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/stream' && call.body.messageId === 'q-1'),
    { label: 'the adopted turn is already publishing' },
  );
  turn.emit(taskNotificationReplay());
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 0, 'committed — no hand-back');
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'here is the answer');
  turn.endInput();
  await settled(runner);
});

test('a live subagent’s chatter does not commit a provisional adoption', { timeout: 15_000 }, async () => {
  // A background task's stream arrives at top level carrying
  // parent_tool_use_id. It is not the adopted turn's output, and a task
  // running while the user's message is queued is the ordinary state of the
  // conversation this whole fix came from — committing on it would disarm the
  // hand-back in exactly the window it exists for.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 5_000 });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([
    { task_id: 'agent-1', task_type: 'local_agent', description: 'job' },
    { task_id: 'agent-2', task_type: 'local_agent', description: 'other job' },
  ]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);

  // agent-1 settles; agent-2 keeps streaming.
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-2', task_type: 'local_agent', description: 'other job' }]));
  turn.emit(taskNotificationMessage('agent-1'));
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await tick(20);
  turn.emit({
    type: 'assistant',
    parent_tool_use_id: 'tool-2',
    message: { content: [{ type: 'text', text: 'agent-2 thinking out loud' }] },
  });
  turn.emit({
    type: 'stream_event',
    parent_tool_use_id: 'tool-2',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'more chatter' } },
  });
  await tick(20);
  turn.emit(taskNotificationReplay());
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 1, 'still provisional — handed back');
  turn.emit(resultMessage('the agent finished its job', 'native-1'));

  const continuation = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the task report gets its own row' },
  );
  assert.equal(continuation.body.text, 'the agent finished its job');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    undefined,
  );

  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your real answer', 'native-1'));
  assert.equal(await second, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-2',
  );
  assert.equal(response.body.text, 'your real answer');
  turn.endInput();
  await settled(runner);
});

test('a permission-mode change during a compaction does not release the hold', { timeout: 15_000 }, async () => {
  // `{status:null, permissionMode}` is a mode-change notice and says nothing
  // about compaction — and the user can change the relay mode while a 133 s
  // compaction runs. Read as a terminator it would drop the hold that keeps
  // the watchdog, idle shutdown and the mode-change recycle off the CLI's back.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    idleShutdownMs: 40,
    lifecyclePollMs: 10,
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);

  turn.emit(compactingStatusMessage());
  await tick(20);
  turn.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' });
  await tick(30);
  assert.ok(runner._getProcess()?.compactingSince, 'the hold survives a mode notice');
  await tick(150);
  assert.ok(runner._getProcess(), 'and still guards the process against idling out');

  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  turn.endInput();
  await settled(runner);
});

test('a self-opened turn whose first block is not text is not the compaction replay', { timeout: 15_000 }, async () => {
  // The origin test cannot see a message with no readable leading text, so an
  // image- or document-led turn opener would fall through to "not a task
  // notification" and be adopted. Unreadable means not adopted.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } },
        { type: 'text', text: 'what is in this screenshot?' },
      ],
    },
  });
  turn.emit(resultMessage('a screenshot of a terminal', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    { label: 'the unreadable turn registers its own row' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1'),
    undefined,
    'an unreadable opener must not close the queued row',
  );

  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  assert.equal(await pending, true);
  turn.endInput();
  await settled(runner);
});

test('a row restored by the reaper can be adopted again by a later compaction', { timeout: 15_000 }, async () => {
  // The quiet clock is per-adoption. Carried over from a previous one, the
  // second adoption is reaped on the first lifecycle poll and the row is
  // failed over on a turn that was about to answer it.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    pendingDeliveredTimeoutMs: 200,
    idleShutdownMs: 10_000,
    lifecyclePollMs: 10,
  });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await waitFor(
    () => runner._getProcess()?.pendingDelivered.length === 1,
    { label: 'the silent adoption is reaped back onto the queue' },
  );

  // A second compaction, and this time the turn answers.
  turn.emit(compactBoundaryMessage({ preTokens: 400000 }));
  turn.emit(compactSummaryReplay());
  await tick(60);
  assert.equal(runner._getProcess().pendingDelivered.length, 0, 'adopted again');
  assert.ok(runner._getProcess().activeCtx?.adoptedFromCompaction, 'and still provisional');
  turn.emit(assistantText('here is the answer'));
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'here is the answer');
  assert.ok(!response.body.terminalError, 'the second adoption must not inherit the first’s clock');
  turn.endInput();
  await settled(runner);
});

test('a stale settle clock cannot re-open adoption on a bare-init continuation', { timeout: 15_000 }, async () => {
  // The same steal as the bare-init case, but with the settle clock long
  // erased: a turn attached in between (activateContext zeroes the settle
  // timestamps) and the compaction outlives any grace anyway. Suppression has
  // to come from the init itself, not from how recently a task settled.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 30 });
  await settleOneBackgroundTask(runner, turn, stub);

  // An ordinary turn in between wipes notificationPendingAt / taskSettledAt.
  const middle = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'and this' } });
  await tick(20);
  turn.emit(userReplay('and this'));
  turn.emit(resultMessage('answered the middle one', 'native-1'));
  assert.equal(await middle, true);
  await tick(60);

  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'quick question' } });
  await tick(20);
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(assistantText('the background agent finished'));
  turn.emit(resultMessage('the background agent finished', 'native-1'));

  const continuation = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the report gets its own row' },
  );
  assert.equal(continuation.body.text, 'the background agent finished');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-3'),
    undefined,
    'the queued row must not take the report',
  );

  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('here is the real answer', 'native-1'));
  assert.equal(await third, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-3',
  );
  assert.equal(response.body.text, 'here is the real answer');
  turn.endInput();
  await settled(runner);
});

test('a compaction on the spawn’s own init still adopts', { timeout: 15_000 }, async () => {
  // The counterweight to the rule above: compaction AT RESUME — the incident
  // this whole fix exists for — happens right after the spawn's first init,
  // and must still be adopted rather than suppressed along with everything
  // else.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(assistantText('here is the answer'));
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'here is the answer');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    undefined,
    'the delivered row owns the resume-time compaction’s turn',
  );
  turn.endInput();
  await settled(runner);
});

test('init-time suppression lasts one turn, not the whole process', { timeout: 15_000 }, async () => {
  // The suppression flag says "the turn THIS init opened is the CLI's own". If
  // it never cleared it would latch for the process's life and adoption would
  // be dead for every later compaction — the original orphan bug, silently
  // back.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);

  // A bare init with a message queued: suppression on.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(initMessage('native-1'));
  await tick(20);
  assert.equal(runner._getProcess().continuationInitPending, true);
  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  assert.equal(runner._getProcess().continuationInitPending, false, 'cleared by the turn that opened');

  // A later compaction re-opens a third message's turn: adoption must work.
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'and another' } });
  await tick(20);
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(assistantText('the third answer'));
  turn.emit(resultMessage('the third answer', 'native-1'));
  assert.equal(await third, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-3',
  );
  assert.equal(response.body.text, 'the third answer');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    undefined,
    'adoption is alive again — no synthetic row',
  );
  turn.endInput();
  await settled(runner);
});

test('a Stop taken during a provisional adoption does not silence the real turn', { timeout: 15_000 }, async () => {
  // activateContext keys a control poller on the adopted row, so the
  // provisional window is the one moment a still-QUEUED message is Stoppable.
  // That abort belongs to the turn that was running; carried on the restored
  // context it would make finalizeContext take its interrupted branch and
  // publish no response when the row finally runs for real.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  let capturedAbort = null;
  const controlPoller = {
    start: ({ queueMessageId, onAbortTurn }) => {
      if (queueMessageId === 'q-1') capturedAbort = onAbortTurn;
      return { queueMessageId };
    },
    stop: () => {},
  };
  const runner = makeRunner({ stub, startImpl: () => turn, controlPoller });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  await waitFor(() => capturedAbort, { label: 'the adopted row is Stoppable' });
  await capturedAbort();
  turn.emit(taskNotificationReplay());
  await tick(20);
  assert.equal(runner._getProcess().pendingDelivered.length, 1, 'handed back');
  turn.emit(resultMessage('the agent finished', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'the continuation settles' },
  );

  turn.emit(userReplay('hello'));
  turn.emit(assistantText('here is your answer'));
  turn.emit(resultMessage('here is your answer', 'native-1'));
  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.ok(response, 'the row must still get a response');
  assert.equal(response.body.text, 'here is your answer');
  turn.endInput();
  await settled(runner);
});

test('the reaper cannot put a settling turn back on the queue', { timeout: 15_000 }, async () => {
  // An adopted turn silent past the provisional timeout whose first output is
  // its own `result`: the lifecycle poll can land inside finalizeContext's
  // awaited publishes. Restoring there puts a FINALIZED context on the queue,
  // and the next turn to attach it wedges the process for good — finalize
  // returns early, so the context is never closed and never released.
  const stub = makeApiStub();
  const slow = {
    calls: stub.calls,
    api: async (method, routePath, body) => {
      const result = await stub.api(method, routePath, body);
      if (routePath === '/api/response') await new Promise((resolve) => setTimeout(resolve, 120));
      return result;
    },
  };
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub: slow,
    startImpl: () => turn,
    pendingDeliveredTimeoutMs: 100,
    idleShutdownMs: 10_000,
    lifecyclePollMs: 10,
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  // Late enough that the provisional clock expires DURING finalizeContext's
  // awaited publishes, which is the only window the race has.
  await tick(80);
  turn.emit(resultMessage('the answer', 'native-1'));
  await tick(20);
  assert.equal(
    runner._getProcess().activeCtx?.adoptedFromCompaction,
    false,
    'the result commits the adoption before finalize starts awaiting',
  );
  assert.equal(await second, true);
  await tick(60);
  assert.equal(runner._getProcess().pendingDelivered.length, 0, 'an answered row is not owed again');

  // The process must still be able to run a turn.
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'and another' } });
  await tick(20);
  turn.emit(assistantText('third answer'));
  turn.emit(resultMessage('third answer', 'native-1'));
  assert.equal(await third, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-3',
  );
  assert.equal(response.body.text, 'third answer');
  turn.endInput();
  await settled(runner);
});

test('a boundary restarts the unattached clock of an entry near the deadline', { timeout: 15_000 }, async () => {
  // The watchdog resets pending clocks only WHILE compacting; an entry that
  // was already close to the deadline when the boundary lands would otherwise
  // be failed over during the post-boundary replay gap — on a turn the CLI is
  // about to open for it.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    pendingDeliveredTimeoutMs: 120,
    idleShutdownMs: 10_000,
    lifecyclePollMs: 10,
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(100);
  // Not compacting, so the clock has been running the whole time.
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  await tick(60);
  assert.equal(runner._getProcess().pendingDelivered.length, 1, 'not reaped across the boundary');

  turn.emit(compactSummaryReplay());
  turn.emit(assistantText('your answer'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-2',
  );
  assert.equal(response.body.text, 'your answer');
  assert.ok(!response.body.terminalError);
  turn.endInput();
  await settled(runner);
});

test('the adopted message’s own replay makes the adoption final', { timeout: 15_000 }, async () => {
  // Every unwind rests on "the CLI never consumed this prompt". Once the row's
  // own text replays, that is false: handing the turn back would fail the row
  // over for a message the CLI has already taken, and the answer would land on
  // a synthetic continuation — the exact incident this fix exists to prevent.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(userReplay('hello'));
  await tick(20);
  assert.equal(
    runner._getProcess().activeCtx?.adoptedFromCompaction,
    false,
    'confirmed by the replay, no longer provisional',
  );
  // A notification arriving now must not unwind it.
  turn.emit(taskNotificationReplay());
  turn.emit(assistantText('here is the answer'));
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'here is the answer');
  assert.ok(!response.body.terminalError, 'the row must not be failed over');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    undefined,
  );
  turn.endInput();
  await settled(runner);
});

test('a mid-turn absorption picks the message it matches, not the queue head', { timeout: 15_000 }, async () => {
  // The 2026-08-18 steering fix matched only the head. With two messages
  // queued the CLI can absorb the second, and head-only matching then lets the
  // running turn keep an answer that belongs to it while BOTH queued rows die
  // to the watchdog.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, pendingDeliveredTimeoutMs: 0 });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(assistantText('working on it'));
  await tick(20);
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'second' } });
  const third = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-3', text: 'third' } });
  await tick(20);
  // The CLI absorbs the THIRD message into the running turn.
  turn.emit(userReplay('third'));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await first, true);
  assert.equal(await third, true);

  const answerFor = (id) => stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === id,
  )?.body.text;
  assert.match(answerFor('q-1'), /merged into the next message/);
  assert.equal(answerFor('q-3'), 'done');

  turn.emit(userReplay('second'));
  turn.emit(resultMessage('the second answer', 'native-1'));
  assert.equal(await second, true);
  assert.equal(answerFor('q-2'), 'the second answer');
  turn.endInput();
  await settled(runner);
});

test('a compaction summary delivered as plain string content is still adopted', { timeout: 15_000 }, async () => {
  // `content` is a plain string on real rows as often as a block array. Read
  // only as an array, the summary is "unreadable" and falls through to
  // non-adoption — the orphan bug, back for the common wire shape.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: 'This session is being continued from a previous conversation…' },
  });
  turn.emit(assistantText('here is the answer'));
  turn.emit(resultMessage('here is the answer', 'native-1'));

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'here is the answer');
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    undefined,
    'the delivered row owns the turn',
  );
  turn.endInput();
  await settled(runner);
});

test('a legacy notification replay with string content and no origin still opens its own turn', { timeout: 15_000 }, async () => {
  // Real notification rows carry `content` as a plain string, not a block
  // array. An emitter predating `origin` leaves only the `<task-notification>`
  // tag to go on, and the tag can only be read if string content is read.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: '<task-notification id="agent-1">agent-1 completed</task-notification>' },
  });
  turn.emit(resultMessage('the agent finished', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    { label: 'the legacy notification registers its own row' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1'),
    undefined,
    'the queued row must not take the task report',
  );

  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  assert.equal(await pending, true);
  turn.endInput();
  await settled(runner);
});

test('a compaction alone keeps the process alive past the idle timeout', { timeout: 15_000 }, async () => {
  // A compaction produces no stream traffic for minutes and nothing else is
  // "live" while it runs; an idle shutdown under it kills the CLI mid-flight.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, idleShutdownMs: 40, lifecyclePollMs: 10 });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);
  turn.emit(compactingStatusMessage());
  await tick(200);
  assert.ok(runner._getProcess(), 'the process must survive the compaction');

  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'success' });
  turn.endInput();
  await settled(runner);
});

test('a boundary with nothing queued cannot adopt a message delivered after it', { timeout: 15_000 }, async () => {
  // The window is armed for the entries waiting on the compaction. Arming it
  // with an empty queue would leave it open for whatever is pushed next, and
  // the CLI's own next turn would take that row.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await first, true);
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  await tick(20);
  assert.equal(runner._getProcess().compactReplayUntil, 0, 'nothing was waiting on this compaction');

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(compactSummaryReplay());
  turn.emit(resultMessage('some other turn', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    { label: 'the CLI turn registers its own row' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    undefined,
    'a boundary that predates the message must not adopt it',
  );

  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  turn.endInput();
  await settled(runner);
});

test('two queued messages replayed out of order each get their own answer', { timeout: 15_000 }, async () => {
  // Pairing by queue position alone answers each message with the other's
  // turn; the replay's text is what identifies which entry it opens.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  turn.emit(initMessage('native-1'));
  await tick(20);
  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('the second answer', 'native-1'));
  assert.equal(await second, true);
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the first answer', 'native-1'));
  assert.equal(await first, true);

  const answerFor = (id) => stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === id,
  )?.body.text;
  assert.equal(answerFor('q-2'), 'the second answer');
  assert.equal(answerFor('q-1'), 'the first answer');
  turn.endInput();
  await settled(runner);
});

test('a task notification for an unknown task leaves a pending delivered row alone', { timeout: 15_000 }, async () => {
  // A notification whose task was never in a live set (a stale worker, a
  // resumed session) must neither adopt the pending row nor make the CLI's own
  // turn look like the compaction's.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(taskNotificationMessage('never-seen-agent'));
  await tick(20);
  turn.emit(userReplay('<task-notification>never-seen-agent completed</task-notification>'));
  turn.emit(resultMessage('stale task report', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation for the unknown task' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1'),
    undefined,
    'the pending row must not be closed by a stale task report',
  );

  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.equal(response.body.text, 'the real answer');
  turn.endInput();
  await settled(runner);
});

test('the adoption window expires instead of waiting for a turn that never comes', { timeout: 15_000 }, async () => {
  // Safety property: an armed window that is never spent must not sit open,
  // or an unrelated self-opened turn minutes later would adopt the row.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, compactReplayAdoptionMs: 30 });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  await tick(80);
  // Past the window: an untagged self-opened turn is no longer the
  // compaction's replay and must not take the delivered row.
  turn.emit(compactSummaryReplay());
  turn.emit(resultMessage('some other turn', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    { label: 'continuation registered after the window expired' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1'),
    undefined,
  );

  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  assert.equal(await pending, true);
  turn.endInput();
  await settled(runner);
});

test('one boundary can adopt one turn, not every turn after it', { timeout: 15_000 }, async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit(compactSummaryReplay());
  turn.emit(resultMessage('answered after compacting', 'native-1'));
  assert.equal(await first, true);

  // The window was spent by that turn. A second self-opened turn — no new
  // boundary — is the CLI's own and must register a continuation.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(20);
  turn.emit(userReplay('some other self-opened turn'));
  turn.emit(resultMessage('not your answer', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    { label: 'second turn registers its own row' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    undefined,
    'the window is one-shot',
  );

  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('your answer', 'native-1'));
  assert.equal(await second, true);
  turn.endInput();
  await settled(runner);
});

test('a failed compaction disarms the window it opened', { timeout: 15_000 }, async () => {
  // No boundary and no replay follow a failed compaction — the turn carries on
  // uncompacted — so the window must not stay open for a later turn to take.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit({ type: 'system', subtype: 'status', status: null, compact_result: 'failed' });
  await tick(20);
  assert.equal(runner._getProcess().compactReplayUntil, 0, 'window disarmed');
  assert.equal(runner._getProcess().compactingSince, 0, 'hold released');

  turn.emit(userReplay('a turn of the CLI\'s own'));
  turn.emit(resultMessage('not your answer', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    { label: 'continuation after a failed compaction' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1'),
    undefined,
  );
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  assert.equal(await pending, true);
  turn.endInput();
  await settled(runner);
});

// Bounded: this turn can only end through the watchdog, so a regression
// that keeps the hold standing would otherwise hang rather than fail.
test('a compact_error disarms the window just like compact_result failed', { timeout: 15_000 }, async () => {
  // Both spellings are optional in the SDK type and both mean the compaction
  // produced nothing: no boundary, no replay, the turn carries on uncompacted.
  // A window left armed would only widen the chance of a later self-opened
  // turn taking the row.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit({ type: 'system', subtype: 'status', status: null, compact_error: 'out of memory' });
  await tick(20);
  assert.equal(runner._getProcess().compactReplayUntil, 0, 'window disarmed');
  assert.equal(runner._getProcess().compactingSince, 0, 'hold released');

  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('the real answer', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1'),
    { label: 'the turn carries on uncompacted' },
  );
  turn.endInput();
  await settled(runner);
});

test('an early compact start that compacts nothing releases the hold', { timeout: 5_000 }, async () => {
  // The CLI announces 'compacting', then reports a BARE null status — no
  // compact_result, no boundary. Read as "still compacting", the hold would
  // stand until the staleness cap, delaying the watchdog by minutes.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    pendingDeliveredTimeoutMs: 60,
    lifecyclePollMs: 10,
  });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(compactingStatusMessage());
  turn.emit({ type: 'system', subtype: 'status', status: null });
  // A permission-mode notice shares the shape but says nothing about
  // compaction, so it must not be mistaken for either edge.
  turn.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.ok(response?.body?.terminalError, 'the watchdog is no longer held off');
  turn.endInput();
  await settled(runner);
});

// Bounded: this turn can only end through the watchdog, so a regression
// that keeps the hold standing would otherwise hang rather than fail.
test('a compaction hold that is never released expires on its own', { timeout: 5_000 }, async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    pendingDeliveredTimeoutMs: 60,
    lifecyclePollMs: 10,
    compactionStaleMs: 50,
  });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  // Announced and then nothing at all: no boundary, no terminating status.
  turn.emit(compactingStatusMessage());

  assert.equal(await pending, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-1',
  );
  assert.ok(response?.body?.terminalError, 'the hold cannot outlive the staleness cap');
  turn.endInput();
  await settled(runner);
});

test('a buffered boundary survives a flood of between-turn notices', async () => {
  // The buffer is capped, and it used to drop from the front — so a boundary
  // buffered between turns lost its break row to ordinary chatter. Structured
  // entries carry transcript geometry no later line restores.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'local_agent', description: 'job' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await first, true);

  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  for (let index = 0; index < 60; index += 1) {
    turn.emit(taskNotificationMessage('agent-1', `settled ${index}`));
  }
  await tick(20);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'again' } });
  turn.emit(userReplay('again'));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await second, true);

  const boundaries = compactionActivities(stub);
  assert.equal(boundaries.length, 1, 'the boundary outlived the chatter');
  assert.equal(boundaries[0].body.messageId, 'q-2');
  turn.endInput();
  await settled(runner);
});

test('an api_retry between turns tolerates a buffered boundary ahead of it', async () => {
  // The collapse-consecutive-retries peek reads the tail of a buffer that now
  // holds prepared actions as well as prose; treating one as a string throws
  // inside the stream consumer and takes the process down.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await first, true);

  // Between turns, with no delivered row to post onto: both entries buffer.
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  turn.emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 500, session_id: 'native-1' });
  await tick(20);
  assert.ok(runner._getProcess(), 'the stream consumer must still be alive');

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'again' } });
  turn.emit(userReplay('again'));
  turn.emit(resultMessage('done again', 'native-1'));
  assert.equal(await second, true);

  assert.equal(compactionActivities(stub).length, 1);
  assert.ok(
    stub.calls.find((call) => call.routePath === '/api/activity'
      && call.body.messageId === 'q-2'
      && /500/.test(call.body.text || '')),
    'the retry notice rides along with it',
  );
  turn.endInput();
  await settled(runner);
});

test('a second notification replay after a compaction still opens its own turn', async () => {
  // Two tasks settle with a continuation in between, so the runner has already
  // seen one of the CLI's own turns before the compaction. Every bookkeeping
  // design mis-accounted here — a boolean latch was cleared by the first
  // continuation, a per-task ledger was drained by a turn that opened for an
  // unrelated reason — and the second notification replay then closed the
  // user's queued row with the background task's report. Reading the tag off
  // the message has no state to get wrong.
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, notificationGraceMs: 30 });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([
    { task_id: 'agent-1', task_type: 'local_agent', description: 'job one' },
    { task_id: 'agent-2', task_type: 'local_agent', description: 'job two' },
  ]));
  turn.emit(resultMessage('dispatched both', 'native-1'));
  assert.equal(await first, true);

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('agent-1'));
  turn.emit(taskNotificationMessage('agent-2'));
  // Continuation #1 runs and settles exactly one of the two debts.
  turn.emit(userReplay('<task-notification>agent-1 completed</task-notification>'));
  turn.emit(resultMessage('agent-1 finished', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'first continuation response' },
  );

  // The user sends a message, and a compaction lands before the CLI dequeues
  // anything — well past any continuation grace window.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'quick question' } });
  await tick(80);
  turn.emit(compactingStatusMessage());
  turn.emit(compactBoundaryMessage({ preTokens: 614117 }));
  await tick(20);
  // Continuation #2 — still owed — must open its own turn.
  turn.emit(userReplay('<task-notification>agent-2 completed</task-notification>'));
  turn.emit(resultMessage('agent-2 finished', 'native-1'));
  await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-2'),
    { label: 'second continuation response' },
  );
  assert.equal(
    stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2'),
    undefined,
    'the queued user row must not be closed by the second background task report',
  );

  turn.emit(userReplay('quick question'));
  turn.emit(resultMessage('answered', 'native-1'));
  assert.equal(await second, true);
  const response = stub.calls.find(
    (call) => call.routePath === '/api/response' && call.body.messageId === 'q-2',
  );
  assert.equal(response.body.text, 'answered');
  turn.endInput();
  await settled(runner);
});

test('an api_retry during a turn surfaces as an activity on that turn', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit({
    type: 'system',
    subtype: 'api_retry',
    attempt: 2,
    max_retries: 10,
    retry_delay_ms: 6110,
    error_status: 529,
    session_id: 'native-1',
  });
  const activity = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/activity' && /529/.test(call.body.text || '')),
    { label: 'api_retry activity' },
  );
  assert.equal(activity.body.messageId, 'q-1');
  assert.match(activity.body.text, /overloaded \(529\) — retrying 2\/10 in ~6s/);
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await pending, true);
  turn.endInput();
  await settled(runner);
});

test('an api_retry before the turn attaches posts immediately on the waiting row', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  // The request stalls before the CLI replays the pushed message: the notice
  // must land on the waiting delivered row NOW, not after the stall ends.
  turn.emit({
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 611,
    error_status: 529,
    session_id: 'native-1',
  });
  const activity = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/activity' && /529/.test(call.body.text || '')),
    { label: 'immediate api_retry activity' },
  );
  assert.equal(activity.body.messageId, 'q-1');
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await pending, true);
  turn.endInput();
  await settled(runner);
});

test('an api_retry between turns is carried into the next turn as an activity', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await first, true);

  turn.emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 500, session_id: 'native-1' });
  await tick(20);
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'again' } });
  await tick(20);
  turn.emit(userReplay('again'));
  const carried = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/activity' && /500/.test(call.body.text || '')),
    { label: 'carried api_retry activity' },
  );
  assert.equal(carried.body.messageId, 'q-2');
  turn.emit(resultMessage('done again', 'native-1'));
  assert.equal(await second, true);
  turn.endInput();
  await settled(runner);
});

test('a cold start posts an activity so the wait is explained', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  const activity = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/activity' && /cold start/.test(call.body.text || '')),
    { label: 'cold start activity' },
  );
  assert.equal(activity.body.messageId, 'q-1');
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(resultMessage('done', 'native-1'));
  assert.equal(await pending, true);
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

test('subagent tasks publish model, inheritance, and subagent type', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  // The spawn block is the only place a pinned model exists (task events
  // carry subagent_type but no model — live-verified against SDK 0.3.226).
  turn.emit({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [{
        type: 'tool_use',
        id: 'toolu-pin',
        name: 'Task',
        input: { model: 'haiku', subagent_type: 'Explore', prompt: 'dig' },
      }],
    },
  });
  turn.emit(backgroundTasksMessage([
    { task_id: 'agent-1', task_type: 'local_agent', description: 'pinned job' },
    { task_id: 'agent-2', task_type: 'local_agent', description: 'unpinned job' },
    { task_id: 'bash-1', task_type: 'local_bash', description: 'dev server' },
  ]));
  turn.emit({
    type: 'system', subtype: 'task_started', task_id: 'agent-1', tool_use_id: 'toolu-pin', task_type: 'local_agent', subagent_type: 'Explore', description: 'pinned job',
  });
  turn.emit({
    type: 'system', subtype: 'task_started', task_id: 'agent-2', tool_use_id: 'toolu-unpin', task_type: 'local_agent', subagent_type: 'general-purpose', description: 'unpinned job',
  });
  turn.emit({
    type: 'system', subtype: 'task_progress', task_id: 'agent-2', tool_use_id: 'toolu-unpin', subagent_type: 'general-purpose', last_tool_name: 'Bash', usage: { total_tokens: 12345 },
  });
  // Membership republish flushes the throttled task_started/progress merges
  // into one immediate publish carrying the enriched fields.
  turn.emit(backgroundTasksMessage([
    { task_id: 'agent-1', task_type: 'local_agent', description: 'pinned job' },
    { task_id: 'agent-2', task_type: 'local_agent', description: 'unpinned job' },
    { task_id: 'bash-1', task_type: 'local_bash', description: 'dev server' },
  ]));
  turn.emit(resultMessage('spawned', 'native-1'));
  assert.equal(await pending, true);

  const publish = await waitFor(() => stub.calls.findLast(
    (call) => call.routePath === '/api/background-tasks'
      && call.body.tasks?.length === 3
      && call.body.tasks.some((task) => task.subagentType),
  ), { label: 'enriched task publish' });
  const byId = new Map(publish.body.tasks.map((task) => [task.taskId, task]));
  const pinned = byId.get('agent-1');
  assert.equal(pinned.model, 'haiku', 'the spawn block\'s explicit model wins');
  assert.equal(pinned.modelInherited, false);
  assert.equal(pinned.subagentType, 'Explore');
  const unpinned = byId.get('agent-2');
  assert.equal(unpinned.model, 'claude-sonnet-5', 'no pin falls back to the session model');
  assert.equal(unpinned.modelInherited, true);
  assert.equal(unpinned.subagentType, 'general-purpose');
  assert.equal(unpinned.totalTokens, 12345);
  assert.equal(unpinned.lastToolName, 'Bash');
  const bash = byId.get('bash-1');
  assert.equal(bash.model, null, 'bash tasks run no model of their own');
  assert.equal(bash.modelInherited, false);
  assert.equal(bash.subagentType, null);
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

// ---------------------------------------------------------------------------
// Persistent-process hardening (2026-08-16 review)

test('a discarded continuation releases the active slot when its turn ends', async () => {
  const stub = makeApiStub({ failRoutes: new Set(['/api/continuation-turn']) });
  const turn = scriptedTurn({ echoPushes: true });
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'watch' }]));
  turn.emit(resultMessage('first answer', 'native-1'));
  assert.equal(await first, true);

  // The CLI opens a continuation on its own; every registration attempt fails.
  turn.emit(taskNotificationMessage('bash-1'));
  turn.emit(userReplay('<task-notification>bash-1 completed</task-notification>'));
  turn.emit(assistantText('continuation prose'));
  await waitFor(() => runner._getProcess()?.activeCtx?.discarded, { label: 'context discarded' });

  // Its top-level result must release the active slot — before the fix the
  // dead context stayed active and every later turn wedged on it.
  turn.emit(resultMessage('continuation prose', 'native-1'));
  await waitFor(() => runner._getProcess()?.activeCtx === null, { label: 'active slot released' });

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'follow-up' } });
  await waitFor(() => turn.pushed.length === 2, { label: 'second push' });
  turn.emit(assistantText('follow-up answer'));
  turn.emit(resultMessage('follow-up answer', 'native-1'));
  assert.equal(await second, true);
  const followUp = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal(followUp.body.text, 'follow-up answer');
  turn.endInput();
  await settled(runner);
});

test('between-turn subagent chatter never opens a continuation turn', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'agent', description: 'background research' }]));
  turn.emit(resultMessage('spawned a background agent', 'native-1'));
  assert.equal(await first, true);

  // The background agent streams between turns (parented frames) and a stray
  // top-level tool_result lands. None of it follows a self-opened boundary,
  // so none of it may open a continuation: no top-level result would ever
  // close that context and the process could never idle out.
  turn.emit({ type: 'assistant', parent_tool_use_id: 'tool-1', message: { content: [{ type: 'text', text: 'subagent prose' }] } });
  turn.emit({ type: 'stream_event', parent_tool_use_id: 'tool-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
  turn.emit({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } });
  await tick(50);
  assert.ok(
    !stub.calls.find((call) => call.routePath === '/api/continuation-turn'),
    'between-turn chatter must not register a continuation',
  );
  assert.equal(runner._getProcess().activeCtx, null);
  turn.endInput();
  await settled(runner);
});

test('a push-race respawn closes the old process and keeps the task panel intact', async () => {
  const stub = makeApiStub();
  const turns = [];
  const runner = makeRunner({
    stub,
    startImpl: () => {
      const turn = scriptedTurn({ echoPushes: true });
      if (turns.length === 0) {
        // The first process's stream dies between the liveness check and the
        // second push: pushUserMessage throws without the runner having seen
        // the stream end yet.
        const originalPush = turn.pushUserMessage;
        let pushes = 0;
        turn.pushUserMessage = (content) => {
          pushes += 1;
          if (pushes >= 2) throw new Error('user message stream already ended');
          originalPush(content);
        };
      }
      turns.push(turn);
      return turn;
    },
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turns[0].emit(initMessage('native-1'));
  turns[0].emit(backgroundTasksMessage([{ task_id: 'bash-1', task_type: 'local_bash', description: 'dev server' }]));
  turns[0].emit(resultMessage('first answer', 'native-1'));
  assert.equal(await first, true);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'second' } });
  await waitFor(() => turns.length === 2, { label: 'respawn after push race' });
  assert.equal(turns[0].closed, true, 'the superseded process must be torn down');
  turns[1].emit(initMessage('native-1'));
  turns[1].emit(assistantText('second answer'));
  turns[1].emit(resultMessage('second answer', 'native-1'));
  assert.equal(await second, true);

  // The old process died holding bash-1; its cleanup must not blank the panel
  // now owned by the replacement process.
  const emptyPanelPost = stub.calls.find(
    (call) => call.routePath === '/api/background-tasks' && Array.isArray(call.body.tasks) && call.body.tasks.length === 0,
  );
  assert.ok(!emptyPanelPost, 'a superseded process must not clear the replacement\'s task panel');
  turns[1].endInput();
  await settled(runner);
});

test('an AskUserQuestion between turns attaches to a fresh continuation turn instead of being denied', async () => {
  const calls = [];
  const api = async (method, routePath, body) => {
    calls.push({ method, routePath, body });
    if (routePath === '/api/continuation-turn') return { messageId: 'cont-1' };
    if (routePath === '/api/relay-question') return { question: { id: 'rq-1' } };
    if (routePath === '/api/relay-question/rq-1') {
      return { question: { id: 'rq-1', status: 'answered', answer: 'option A' } };
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
    continuationRetryDelayMs: 10,
    askUserBridgeOptions: { questionPollMs: 10 },
  });

  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'agent-1', task_type: 'agent', description: 'background agent' }]));
  turn.emit(resultMessage('spawned', 'native-1'));
  assert.equal(await first, true);

  // Between turns, the background agent asks a question. Before the fix the
  // bridge posted queueId undefined, the route 409ed, and the question was
  // silently denied.
  const decision = await capturedCanUseTool('AskUserQuestion', {
    questions: [{ question: 'Proceed?', options: [{ label: 'option A' }, { label: 'option B' }] }],
  }, {});
  assert.equal(decision.behavior, 'allow');
  assert.equal(decision.updatedInput.answers['Proceed?'], 'option A');
  const questionPost = calls.find((call) => call.routePath === '/api/relay-question');
  assert.equal(questionPost.body.queueId, 'cont-1', 'the question must ride the registered continuation turn');

  // The flow's eventual result closes the continuation like any other.
  turn.emit(resultMessage('acted on option A', 'native-1'));
  await waitFor(
    () => calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  turn.endInput();
  await settled(runner);
});

test('a session-scoped refusal fallback is recorded truthfully and the pinned model is repinned next turn', async () => {
  // Live incident (conv 3366b9d3): a security-audit session pinned to
  // claude-fable-5[1m] tripped Fable's safeguards; the CLI switched the whole
  // session to Opus 4.8 (system/model_refusal_fallback, scope "session") and
  // every later turn silently ran — and was partly mis-recorded as — the
  // wrong model until a process respawn reset it.
  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const setModelCalls = [];
  turn.setModel = async (model) => { setModelCalls.push(model); };
  const runner = makeRunner({ stub, startImpl: () => turn });

  const pinned = { ...baseMessage, model: 'claude-fable-5[1m]' };
  const first = runner.handlePendingPayload({ message: pinned });
  turn.emit({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-fable-5' });
  // Mid-turn, the API refuses on Fable and the CLI retries on the fallback.
  turn.emit({
    type: 'system',
    subtype: 'model_refusal_fallback',
    direction: 'retry',
    scope: 'session',
    trigger: 'refusal',
    originalModel: 'claude-fable-5',
    fallbackModel: 'claude-opus-4-8',
    content: 'Safeguards flagged this message. Switched to Opus 4.8.',
  });
  turn.emit(assistantText('answer from the fallback model'));
  turn.emit(resultMessage('answer from the fallback model', 'native-1'));
  assert.equal(await first, true);

  const firstResponse = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(
    firstResponse.body.model,
    'claude-opus-4-8',
    'the fallback turn must be attributed to the model that actually ran',
  );
  const notice = stub.calls.find(
    (call) => call.routePath === '/api/activity' && /Switched to Opus 4.8/.test(call.body.text || ''),
  );
  assert.ok(notice, 'the model switch must be visible to the user');

  // The next delivered turn re-asserts the pinned model even though the
  // relay-side request never changed.
  const second = runner.handlePendingPayload({ message: { ...pinned, id: 'q-2', text: 'next question' } });
  await waitFor(() => turn.pushed.length === 2, { label: 'second push' });
  assert.deepEqual(setModelCalls, ['claude-fable-5[1m]'], 'the drifted session must be repinned');
  turn.emit({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-fable-5' });
  turn.emit(resultMessage('back on the pinned model', 'native-1'));
  assert.equal(await second, true);
  const secondResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal(secondResponse.body.model, 'claude-fable-5');
  // The repin is one-shot: a third turn with no new fallback stays quiet.
  const third = runner.handlePendingPayload({ message: { ...pinned, id: 'q-3', text: 'third' } });
  await waitFor(() => turn.pushed.length === 3, { label: 'third push' });
  assert.equal(setModelCalls.length, 1, 'no redundant setModel once repinned');
  turn.emit(resultMessage('third answer', 'native-1'));
  assert.equal(await third, true);
  turn.endInput();
  await settled(runner);
});

test('an auto composer keeps the CLI\'s refusal fallback instead of repinning', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const setModelCalls = [];
  turn.setModel = async (model) => { setModelCalls.push(model); };
  const runner = makeRunner({ stub, startImpl: () => turn, defaultModel: '' });

  const first = runner.handlePendingPayload({ message: { ...baseMessage, model: 'auto' } });
  turn.emit({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'claude-fable-5' });
  turn.emit({
    type: 'system',
    subtype: 'model_refusal_fallback',
    direction: 'retry',
    scope: 'session',
    originalModel: 'claude-fable-5',
    fallbackModel: 'claude-opus-4-8',
    content: 'Safeguards flagged this message. Switched to Opus 4.8.',
  });
  turn.emit(resultMessage('fallback answer', 'native-1'));
  assert.equal(await first, true);

  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', model: 'auto', text: 'again' } });
  await waitFor(() => turn.pushed.length === 2, { label: 'second push' });
  assert.deepEqual(setModelCalls, [], 'auto means the CLI owns the model; no repin');
  turn.emit(resultMessage('still on the fallback', 'native-1'));
  assert.equal(await second, true);
  const secondResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal(secondResponse.body.model, 'claude-opus-4-8', 'attribution follows what actually runs');
  turn.endInput();
  await settled(runner);
});

// ---------------------------------------------------------------------------
// Workflow progress poller

function makeWorkflowSessionDir(t, runId) {
  const sessionDir = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'wf-session-'));
  t.after(() => fsSync.rmSync(sessionDir, { recursive: true, force: true }));
  const runDir = nodePathModule.join(sessionDir, 'subagents', 'workflows', runId);
  fsSync.mkdirSync(runDir, { recursive: true });
  return { sessionDir, runDir };
}

function digestPublishes(stub) {
  return stub.calls.filter(
    (call) => call.routePath === '/api/background-tasks'
      && call.body.tasks?.some((task) => task.workflowProgress),
  );
}

test('a live workflow task publishes a journal digest, and only on change', async (t) => {
  const { sessionDir, runDir } = makeWorkflowSessionDir(t, 'wf_live-1');
  fsSync.writeFileSync(
    nodePathModule.join(runDir, 'journal.jsonl'),
    '{"type":"started","key":"v2:a","agentId":"agent-a"}\n'
    + '{"type":"started","key":"v2:b","agentId":"agent-b"}\n',
  );
  // agent-a has a transcript whose first line carries the prompt (the live
  // label); agent-b has none yet, so its label falls back.
  fsSync.writeFileSync(
    nodePathModule.join(runDir, 'agent-agent-a.jsonl'),
    `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Review the logic of shared/model-id.mjs' }, agentId: 'agent-a' })}\n`,
  );

  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    workflowPollMs: 20,
    resolveWorkflowSessionDirImpl: () => sessionDir,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'wf-task-1', task_type: 'local_workflow', description: 'ultracode run' }]));
  turn.emit(resultMessage('workflow dispatched', 'native-1'));
  assert.equal(await pending, true);

  const withDigest = await waitFor(
    () => digestPublishes(stub)[0],
    { label: 'live digest publish' },
  );
  const digest = withDigest.body.tasks[0].workflowProgress;
  assert.equal(digest.status, 'running');
  assert.equal(digest.runId, 'wf_live-1');
  assert.deepEqual(digest.agents.map((agent) => [agent.label, agent.state]), [
    ['Review the logic of shared/model-id.mjs', 'running'],
    ['agent 2', 'running'],
  ]);

  // Nothing on disk changed: several poll intervals must add no publish.
  const before = digestPublishes(stub).length;
  await tick(150);
  assert.equal(digestPublishes(stub).length, before, 'an unchanged digest must not republish');

  // The journal grows → the digest changes → exactly the changed tree ships.
  fsSync.appendFileSync(
    nodePathModule.join(runDir, 'journal.jsonl'),
    '{"type":"result","key":"v2:a","agentId":"agent-a","result":{"ok":true}}\n',
  );
  await waitFor(() => {
    const latest = digestPublishes(stub).at(-1);
    return latest?.body.tasks[0].workflowProgress.agents?.[0]?.state === 'done';
  }, { label: 'done-state republish' });

  turn.endInput();
  await settled(runner);
});

test('the settle notification publishes the completed run record and the poller stops', async (t) => {
  const { sessionDir, runDir } = makeWorkflowSessionDir(t, 'wf_live-2');
  fsSync.writeFileSync(
    nodePathModule.join(runDir, 'journal.jsonl'),
    '{"type":"started","key":"v2:a","agentId":"agent-a"}\n',
  );

  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    workflowPollMs: 20,
    resolveWorkflowSessionDirImpl: () => sessionDir,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'wf-task-2', task_type: 'local_workflow', description: 'ultracode run' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await pending, true);
  await waitFor(() => digestPublishes(stub).length >= 1, { label: 'live digest publish' });

  // Completion: the CLI writes the run record (the only live→record switch
  // point) and then notifies. The final read must ship the completed tree —
  // with the previews stripped — before the row clears.
  fsSync.mkdirSync(nodePathModule.join(sessionDir, 'workflows'), { recursive: true });
  fsSync.writeFileSync(
    nodePathModule.join(sessionDir, 'workflows', 'wf_live-2.json'),
    JSON.stringify({
      runId: 'wf_live-2',
      taskId: 'wf-task-2',
      status: 'completed',
      workflowName: 'demo-run',
      agentCount: 1,
      totalTokens: 4242,
      phases: [{ title: 'Review' }],
      logs: ['1 finding verified'],
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Review' },
        {
          type: 'workflow_agent',
          index: 1,
          label: 'review:logic',
          phaseIndex: 1,
          phaseTitle: 'Review',
          model: 'claude-sonnet-5',
          state: 'done',
          attempt: 1,
          lastToolName: 'StructuredOutput',
          tokens: 4242,
          toolCalls: 3,
          durationMs: 1000,
          startedAt: 123,
          promptPreview: 'PREVIEW-MUST-NOT-SHIP',
          resultPreview: 'PREVIEW-MUST-NOT-SHIP',
        },
      ],
    }),
  );
  turn.emit(taskNotificationMessage('wf-task-2'));
  const finalPublish = await waitFor(() => {
    const latest = digestPublishes(stub).at(-1);
    return latest?.body.tasks[0].workflowProgress.status === 'completed' ? latest : null;
  }, { label: 'final record digest' });
  const finalDigest = finalPublish.body.tasks[0].workflowProgress;
  assert.equal(finalDigest.workflowName, 'demo-run');
  assert.equal(finalDigest.totalTokens, 4242);
  assert.deepEqual(finalDigest.phases, [{ index: 1, title: 'Review' }]);
  assert.equal(finalDigest.agents[0].label, 'review:logic');
  assert.ok(!JSON.stringify(finalDigest).includes('PREVIEW-MUST-NOT-SHIP'), 'previews must be stripped');

  // The task leaves the live set: the poller must stop and its state prune.
  turn.emit(backgroundTasksMessage([]));
  await waitFor(() => runner._getProcess()?.workflowPollTimer === null, { label: 'poller stopped' });
  assert.equal(runner._getProcess().workflowStates.size, 0, 'settled workflow state must not linger');

  turn.endInput();
  await settled(runner);
});

test('a workflow task with nothing on disk polls silently and settles clean', async (t) => {
  const missingDir = nodePathModule.join(osModule.tmpdir(), `wf-missing-${process.pid}-${Date.now()}`);
  t.after(() => fsSync.rmSync(missingDir, { recursive: true, force: true }));

  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    workflowPollMs: 10,
    resolveWorkflowSessionDirImpl: () => missingDir,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'wf-task-3', task_type: 'local_workflow', description: 'authoring' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await pending, true);

  // Many poll intervals against a session dir that does not exist: no digest,
  // no error, the row keeps publishing bare.
  await tick(100);
  assert.equal(digestPublishes(stub).length, 0, 'nothing to digest means nothing attached');
  assert.ok(runner._getProcess().workflowPollTimer, 'the poller keeps waiting for the dir to appear');

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('wf-task-3'));
  await waitFor(() => runner._getProcess()?.workflowPollTimer === null, { label: 'poller stopped' });
  turn.endInput();
  await settled(runner);
});

// ---------------------------------------------------------------------------
// Settled-workflow digests on the summarizing response (`workflowRuns`)

function workflowRunRecordJson(runId, taskId, overrides = {}) {
  return JSON.stringify({
    runId,
    taskId,
    status: 'completed',
    workflowName: 'demo-run',
    agentCount: 1,
    totalTokens: 4242,
    durationMs: 927637,
    phases: [{ title: 'Review' }],
    logs: ['1 finding verified'],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Review' },
      { type: 'workflow_agent', index: 1, label: 'review:logic', phaseIndex: 1, phaseTitle: 'Review', state: 'done', tokens: 4242 },
    ],
    ...overrides,
  });
}

test('a settled workflow rides the NEXT response as workflowRuns, exactly once', async (t) => {
  const { sessionDir, runDir } = makeWorkflowSessionDir(t, 'wf_card-1');
  fsSync.writeFileSync(
    nodePathModule.join(runDir, 'journal.jsonl'),
    '{"type":"started","key":"v2:a","agentId":"agent-a"}\n',
  );

  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    workflowPollMs: 20,
    resolveWorkflowSessionDirImpl: () => sessionDir,
  });
  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'wf-card-task', task_type: 'local_workflow', description: 'ultracode run' }]));
  turn.emit(resultMessage('workflow dispatched', 'native-1'));
  assert.equal(await first, true);

  // The dispatching turn's own response carries no runs — nothing settled yet.
  const firstResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-1');
  assert.equal('workflowRuns' in firstResponse.body, false, 'no workflowRuns before any settle');

  // Completion in the live SDK's order: the run record lands, the task row
  // drops (background_tasks_changed), THEN the notification arrives.
  fsSync.mkdirSync(nodePathModule.join(sessionDir, 'workflows'), { recursive: true });
  fsSync.writeFileSync(
    nodePathModule.join(sessionDir, 'workflows', 'wf_card-1.json'),
    workflowRunRecordJson('wf_card-1', 'wf-card-task'),
  );
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('wf-card-task'));
  turn.emit(userReplay('<task-notification>wf-card-task completed</task-notification>'));
  turn.emit(assistantText('The workflow finished.'));
  turn.emit(resultMessage('The workflow finished.', 'native-1'));

  const contResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.ok(Array.isArray(contResponse.body.workflowRuns), 'the summarizing response carries workflowRuns');
  assert.equal(contResponse.body.workflowRuns.length, 1);
  const run = contResponse.body.workflowRuns[0];
  assert.equal(run.runId, 'wf_card-1');
  assert.equal(run.status, 'completed');
  assert.equal(run.workflowName, 'demo-run');
  assert.equal(run.durationMs, 927637, 'the record-level run duration rides the digest');
  assert.equal(run.agents[0].label, 'review:logic');

  // A later turn must not re-attach the already-delivered digest.
  const second = runner.handlePendingPayload({ message: { ...baseMessage, id: 'q-2', text: 'status?' } });
  await tick(20);
  turn.emit(assistantText('nothing new'));
  turn.emit(resultMessage('nothing new', 'native-1'));
  assert.equal(await second, true);
  const secondResponse = stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'q-2');
  assert.equal('workflowRuns' in secondResponse.body, false, 'the buffer drains on attach');

  turn.endInput();
  await settled(runner);
});

test('a stopped workflow with no run record attaches its live digest with the notification status', async (t) => {
  const { sessionDir, runDir } = makeWorkflowSessionDir(t, 'wf_card-2');
  fsSync.writeFileSync(
    nodePathModule.join(runDir, 'journal.jsonl'),
    '{"type":"started","key":"v2:a","agentId":"agent-a"}\n',
  );

  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    workflowPollMs: 20,
    resolveWorkflowSessionDirImpl: () => sessionDir,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'wf-stop-task', task_type: 'local_workflow', description: 'ultracode run' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await pending, true);
  // The poller must have digested the journal before the settle, or there is
  // no live digest to fall back on.
  await waitFor(() => digestPublishes(stub).length >= 1, { label: 'live digest publish' });

  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('wf-stop-task', 'stopped'));
  turn.emit(userReplay('<task-notification>wf-stop-task stopped</task-notification>'));
  turn.emit(assistantText('The workflow was stopped.'));
  turn.emit(resultMessage('The workflow was stopped.', 'native-1'));

  const contResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.equal(contResponse.body.workflowRuns.length, 1);
  const run = contResponse.body.workflowRuns[0];
  assert.equal(run.runId, 'wf_card-2');
  assert.equal(run.status, 'stopped', "the notification's status replaces the stale 'running'");
  assert.equal(run.durationMs, null, 'the journal knows no run duration');

  turn.endInput();
  await settled(runner);
});

test('a run record that lands after the settle still upgrades the card at drain time', async (t) => {
  // Observed live (session 713eeda8): the task row dropped and the
  // notification fired a beat BEFORE the CLI flushed the run record, so the
  // persisted card froze on the journal snapshot — a done workflow showing a
  // "running" verify agent and no token/duration totals.
  const { sessionDir, runDir } = makeWorkflowSessionDir(t, 'wf_card-3');
  fsSync.writeFileSync(
    nodePathModule.join(runDir, 'journal.jsonl'),
    '{"type":"started","key":"v2:a","agentId":"agent-a"}\n',
  );

  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    workflowPollMs: 20,
    resolveWorkflowSessionDirImpl: () => sessionDir,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage([{ task_id: 'wf-late-task', task_type: 'local_workflow', description: 'ultracode run' }]));
  turn.emit(resultMessage('dispatched', 'native-1'));
  assert.equal(await pending, true);
  await waitFor(() => digestPublishes(stub).length >= 1, { label: 'live digest publish' });

  // Both settle signals arrive with NO record on disk: the buffer holds the
  // stale journal snapshot (agent still 'running').
  turn.emit(backgroundTasksMessage([]));
  turn.emit(taskNotificationMessage('wf-late-task'));

  // The record lands only now — after the settle, before the summarizing
  // response drains the buffer.
  fsSync.mkdirSync(nodePathModule.join(sessionDir, 'workflows'), { recursive: true });
  fsSync.writeFileSync(
    nodePathModule.join(sessionDir, 'workflows', 'wf_card-3.json'),
    workflowRunRecordJson('wf_card-3', 'wf-late-task'),
  );

  turn.emit(userReplay('<task-notification>wf-late-task completed</task-notification>'));
  turn.emit(assistantText('The workflow finished.'));
  turn.emit(resultMessage('The workflow finished.', 'native-1'));

  const contResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.equal(contResponse.body.workflowRuns.length, 1);
  const run = contResponse.body.workflowRuns[0];
  assert.equal(run.runId, 'wf_card-3');
  assert.equal(run.status, 'completed');
  assert.equal(run.workflowName, 'demo-run', 'the drain-time retry upgraded to the record digest');
  assert.equal(run.durationMs, 927637, 'record-level totals ride the upgraded digest');
  assert.ok(
    run.agents.every((agent) => agent.state !== 'running'),
    'no agent stays frozen in a running state on a finished card',
  );

  turn.endInput();
  await settled(runner);
});

test('the settled-workflow buffer caps at 5, dropping the oldest', async (t) => {
  const sessionDir = fsSync.mkdtempSync(nodePathModule.join(osModule.tmpdir(), 'wf-session-'));
  t.after(() => fsSync.rmSync(sessionDir, { recursive: true, force: true }));
  fsSync.mkdirSync(nodePathModule.join(sessionDir, 'workflows'), { recursive: true });
  const taskIds = Array.from({ length: 6 }, (_, i) => `wf-cap-${i + 1}`);
  for (const [i, taskId] of taskIds.entries()) {
    fsSync.writeFileSync(
      nodePathModule.join(sessionDir, 'workflows', `wf_cap-${i + 1}.json`),
      workflowRunRecordJson(`wf_cap-${i + 1}`, taskId),
    );
  }

  const stub = makeApiStub();
  const turn = scriptedTurn({ echoPushes: true });
  const runner = makeRunner({
    stub,
    startImpl: () => turn,
    workflowPollMs: 20,
    resolveWorkflowSessionDirImpl: () => sessionDir,
  });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(backgroundTasksMessage(taskIds.map((taskId) => ({
    task_id: taskId, task_type: 'local_workflow', description: `run ${taskId}`,
  }))));
  turn.emit(resultMessage('six workflows dispatched', 'native-1'));
  assert.equal(await pending, true);

  // All six leave the live set at once; the buffer holds only the last five.
  turn.emit(backgroundTasksMessage([]));
  turn.emit(userReplay('<task-notification>all settled</task-notification>'));
  turn.emit(assistantText('All workflows finished.'));
  turn.emit(resultMessage('All workflows finished.', 'native-1'));

  const contResponse = await waitFor(
    () => stub.calls.find((call) => call.routePath === '/api/response' && call.body.messageId === 'cont-1'),
    { label: 'continuation response' },
  );
  assert.equal(contResponse.body.workflowRuns.length, 5, 'capped at 5');
  assert.deepEqual(
    contResponse.body.workflowRuns.map((entry) => entry.runId),
    ['wf_cap-2', 'wf_cap-3', 'wf_cap-4', 'wf_cap-5', 'wf_cap-6'],
    'the oldest settled digest is the one dropped',
  );

  turn.endInput();
  await settled(runner);
});

test('the CLI-reported model backs the response when the composer says auto', async () => {
  const stub = makeApiStub();
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, defaultModel: '' });
  const pending = runner.handlePendingPayload({ message: { ...baseMessage, model: 'auto' } });
  turn.emit(initMessage('native-1'));
  turn.emit(resultMessage('the answer', 'native-1'));
  assert.equal(await pending, true);
  const response = stub.calls.find((call) => call.routePath === '/api/response');
  assert.equal(response.body.model, 'claude-sonnet-5', 'the init model must back the response, not null');
  turn.endInput();
  await settled(runner);
});
