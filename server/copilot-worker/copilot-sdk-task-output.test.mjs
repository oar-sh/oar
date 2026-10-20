// The task console for Copilot shells: a detached shell names its own log, an
// attached one has its recent-output window mirrored into the session's spool
// (overlapping windows merged), and background agents count their steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  baseMessage,
  createFakeCopilotClient,
  createMemorySpool,
  makeContinuationApiStub,
  makeRunner,
  tick,
  waitFor,
} from './copilot-sdk-test-harness.mjs';
import { createShellOutputMirror, newOutputSuffix, overlapLength } from './copilot-shell-output-mirror.mjs';
import { createTaskOutputSpool } from '../../shared/worker-runtime/task-output-spool.mjs';

const AGENT_ID = '3c0f5a1e-7d2b-4e8a-9f61-0b2c4d6e8a10';
const startedAtIso = (agoMs = 1_000) => new Date(Date.now() - agoMs).toISOString();
const lastTasks = (stub) => stub.bodiesFor('/api/background-tasks').at(-1)?.tasks || null;

function attachedShell(overrides = {}) {
  return {
    type: 'shell', id: '1', description: 'run the suite', status: 'running', command: 'npm test',
    attachmentMode: 'attached', executionMode: 'background', pid: 5151, startedAt: startedAtIso(), ...overrides,
  };
}

function agentTask(overrides = {}) {
  return {
    type: 'agent', id: AGENT_ID, toolCallId: 'call_7_0', displayName: 'fixture-agent', description: 'tidy the docs',
    status: 'running', agentType: 'general-purpose', resolvedModel: 'probe-model', executionMode: 'background',
    startedAt: startedAtIso(), ...overrides,
  };
}

function setup({ taskList, taskProgress = {}, events, spool = createMemorySpool(), progressRpc = true } = {}) {
  const client = createFakeCopilotClient({
    tasksRpc: true,
    taskList,
    taskProgress,
    onSend: (session, _options, messageId) => {
      if (session.sends.length !== 1) return;
      if (!progressRpc) delete session.rpc.tasks.getProgress;
      session.replay(events ? events(messageId) : [
        { type: 'user.message', data: { messageId, delivery: 'idle', content: 'hello' } },
        { type: 'session.background_tasks_changed', data: {} },
        { type: 'assistant.message', data: { messageId: 'm1', content: 'started' } },
        { type: 'assistant.idle', data: {} },
      ]);
    },
  });
  const stub = makeContinuationApiStub();
  const { runner } = makeRunner({
    stub,
    client,
    taskRefreshMs: 1,
    taskPublishThrottleMs: 1,
    continuationRetryDelayMs: 1,
    taskOutputSpool: spool,
  });
  return { stub, client, runner, spool };
}

async function refresh(client, runner) {
  client.session.emit({ type: 'session.background_tasks_changed', data: {} });
  await tick(5);
  await runner.whenTasksRefreshed();
}

// --- the overlap merge (pure) ---------------------------------------------------

test('a growing window appends its new tail; a sliding one only what follows the overlap', () => {
  assert.deepEqual(newOutputSuffix('', 'a\nb\n'), { text: 'a\nb\n', gap: false });
  assert.deepEqual(newOutputSuffix('a\nb\n', 'a\nb\nc\n'), { text: 'c\n', gap: false });
  assert.deepEqual(newOutputSuffix('a\nb\nc\n', 'b\nc\nd\ne\n'), { text: 'd\ne\n', gap: false });
  // A partial line that grew.
  assert.deepEqual(newOutputSuffix('a\nbuilding', 'a\nbuilding... done\nnext'), { text: '... done\nnext', gap: false });
  // Nothing new: the same window, or one wholly inside the last.
  assert.deepEqual(newOutputSuffix('a\nb\nc\n', 'a\nb\nc\n'), { text: '', gap: false });
  assert.deepEqual(newOutputSuffix('x\na\nb\n', 'a\nb\n'), { text: '', gap: false });
  // More output than the window between two reads: nothing shared.
  assert.deepEqual(newOutputSuffix('a\nb\n', 'y\nz\n'), { text: 'y\nz\n', gap: true });
});

test('the overlap is the longest suffix of the old window that starts the new one', () => {
  assert.equal(overlapLength('xxabab', 'ababz'), 4);
  assert.equal(overlapLength('aaaa', 'aaab'), 3);
  assert.equal(overlapLength('abc', 'abc'), 3);
  assert.equal(overlapLength('abc', 'xyz'), 0);
  assert.equal(overlapLength('', 'abc'), 0);
});

test('the mirror writes each window\'s new part to the spool file, a gap after a line break', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-copilot-spool-'));
  try {
    const spool = createTaskOutputSpool({ sessionId: 'conv-fixture', baseDir });
    const mirror = createShellOutputMirror({ spool });
    assert.equal(mirror.mirror('1', '(no output yet)'), '');
    assert.equal(mirror.has('1'), true, 'a fed window names the file even before output');
    mirror.mirror('1', 'ok 1 first\nok 2 sec');
    mirror.mirror('1', 'ok 1 first\nok 2 second\nok 3 third');
    mirror.mirror('1', 'ok 3 third\nok 4 fourth');
    mirror.mirror('1', 'ok 9 ninth');
    assert.equal(
      fs.readFileSync(spool.pathFor('1'), 'utf8'),
      'ok 1 first\nok 2 second\nok 3 third\nok 4 fourth\nok 9 ninth',
    );
    mirror.forget('1');
    assert.equal(mirror.has('1'), false);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

// --- the runner -----------------------------------------------------------------

test('an attached shell row names the spool file its recent output is mirrored into', async () => {
  const progress = { 1: { type: 'shell', recentOutput: '> fixture-app@1.0.0 test\n' } };
  const { client, runner, spool } = setup({ taskList: [attachedShell()], taskProgress: progress });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  await waitFor(() => spool.files.get('1'), { label: 'the first window was mirrored' });

  client.session.taskProgress[1] = { type: 'shell', recentOutput: '> fixture-app@1.0.0 test\n✓ adds (2 ms)\n' };
  await refresh(client, runner);
  client.session.taskProgress[1] = { type: 'shell', recentOutput: '✓ adds (2 ms)\n✓ subtracts (1 ms)\n' };
  await refresh(client, runner);
  assert.equal(spool.files.get('1'), '> fixture-app@1.0.0 test\n✓ adds (2 ms)\n✓ subtracts (1 ms)\n');
  await runner.dispose();
});

test('the card carries the spool path, the last window is taken when the shell ends, and the mirror ends', async () => {
  const { stub, client, runner, spool } = setup({
    taskList: [attachedShell()],
    taskProgress: { 1: { type: 'shell', recentOutput: 'step 1\n' } },
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  await waitFor(() => lastTasks(stub)?.[0]?.outputKind === 'spool', { label: 'the card names the spool' });
  const card = lastTasks(stub)[0];
  assert.equal(card.outputPath, spool.pathFor('1'));
  assert.equal(card.taskType, 'local_bash');
  // The shell tool's command line rides the card, for the console's `| tail` marker.
  assert.equal(card.command, 'npm test');

  // The shell finishes: its card goes, its last window still lands.
  client.session.taskList[0].status = 'completed';
  client.session.taskProgress[1] = { type: 'shell', recentOutput: 'step 1\nstep 2\ndone\n' };
  await refresh(client, runner);
  await waitFor(() => (lastTasks(stub) || []).length === 0, { label: 'the card is gone' });
  assert.equal(spool.files.get('1'), 'step 1\nstep 2\ndone\n');
  assert.deepEqual(spool.ended, ['1']);
  await waitFor(() => stub.bodiesFor('/api/background-task-settled').length, { label: 'the settle post' });
  assert.equal(stub.bodiesFor('/api/background-task-settled')[0].command, 'npm test');
  await runner.dispose();
});

test('a shell with no progress RPC gets no output fields', async () => {
  const { runner } = setup({ taskList: [attachedShell()], progressRpc: false });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  const cards = runner._getState().backgroundTasks;
  assert.equal(cards.length, 1);
  assert.equal('outputPath' in cards[0], false);
  assert.equal('outputKind' in cards[0], false);
  await runner.dispose();
});

test('the spool is swept when the runner starts', () => {
  const spool = createMemorySpool();
  const { runner } = setup({ taskList: [], spool });
  assert.equal(spool.sweeps, 1);
  return runner.dispose();
});

test('a background agent counts its tool calls as steps; the runtime\'s total wins at the end', async () => {
  const { client, runner } = setup({
    taskList: [agentTask()],
    events: (messageId) => [
      { type: 'user.message', data: { messageId, delivery: 'idle', content: 'hello' } },
      { type: 'subagent.started', agentId: AGENT_ID, data: { toolCallId: 'call_7_0', agentName: 'general-purpose', agentDisplayName: 'fixture-agent', agentType: 'general-purpose', executionMode: 'background' } },
      { type: 'session.background_tasks_changed', data: {} },
      { type: 'tool.execution_start', agentId: AGENT_ID, data: { toolCallId: 'call_8_0', toolName: 'view', arguments: { path: '/home/dev/fixture-app/README.md' } } },
      { type: 'tool.execution_start', agentId: AGENT_ID, data: { toolCallId: 'call_8_1', toolName: 'bash', arguments: { command: 'ls docs' } } },
      { type: 'assistant.message', data: { messageId: 'm1', content: 'spawned' } },
      { type: 'assistant.idle', data: {} },
    ],
  });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await runner.whenTasksRefreshed();
  await waitFor(() => runner._getState().backgroundTasks[0]?.steps === 2, { label: 'two steps' });

  client.session.emit({ type: 'subagent.completed', agentId: AGENT_ID, data: { toolCallId: 'call_7_0', totalTokens: 900, totalToolCalls: 22, durationMs: 4000 } });
  await tick(5);
  await runner.whenTasksRefreshed();
  await waitFor(() => runner._getState().backgroundTasks[0]?.steps === 22, { label: 'the runtime\'s total' });
  assert.equal('outputPath' in runner._getState().backgroundTasks[0], false);
  await runner.dispose();
});
