// The task console reads a Claude shell task's output from the file the CLI
// writes. The worker names that file on the task row (read off the Bash
// result, or the settle notification), falls back to the CLI's getTaskOutput
// snapshot, and counts a sub-agent's tool calls as its steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assistantText,
  backgroundTasksMessage,
  baseMessage,
  initMessage,
  makeApiStub,
  makeRunner,
  resultMessage,
  scriptedTurn,
  settled,
  userReplay,
  waitFor,
} from './claude-session-test-harness.mjs';
import {
  MAX_TASK_COMMAND_CHARS,
  discoverTaskOutputPaths,
  exitCodeFromSummary,
  parseOutputAnnouncement,
  shellCommandsOf,
  usableOutputPath,
} from './task-output-discovery.mjs';

const postsTo = (stub, routePath) => stub.calls.filter((call) => call.routePath === routePath).map((call) => call.body);
const lastSet = (stub) => postsTo(stub, '/api/background-tasks').at(-1)?.tasks || [];
const rowOf = (stub, taskId) => lastSet(stub).find((task) => task.taskId === taskId) || null;

const TASKS_DIR = '/tmp/claude-1000/-home-dev-fixture-app/5b1f0c2e-fixture/tasks';

/** The Bash tool's result for a backgrounded command, as the CLI sends it. */
function backgroundBashResult(taskId, outputPath, { structured = true, toolUseId = `toolu_${taskId}` } = {}) {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `Command running in background with ID: ${taskId}. Output is being written to: ${outputPath}. You will be notified when it completes.`,
      }],
    },
    ...(structured ? { tool_use_result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId } } : {}),
  };
}

async function withRunner({ stub = makeApiStub(), tasks = [] } = {}) {
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, lifecyclePollMs: 10 });
  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  if (tasks.length) turn.emit(backgroundTasksMessage(tasks));
  return {
    stub,
    turn,
    runner,
    async endTurn() {
      turn.emit(assistantText('started'));
      turn.emit(resultMessage('started', 'native-1'));
      assert.equal(await first, true);
    },
    async finish() {
      turn.emit(backgroundTasksMessage([]));
      turn.endInput();
      await settled(runner);
    },
  };
}

// --- discovery (pure) ---------------------------------------------------------

test('every Bash background wording names the task file', () => {
  const file = `${TASKS_DIR}/b8k2m4x7q.output`;
  for (const text of [
    `Command running in background with ID: b8k2m4x7q. Output is being written to: ${file}.`,
    `Command was manually backgrounded by user with ID: b8k2m4x7q. Output is being written to: ${file}.`,
    `Command did not complete within its 120s timeout and was moved to the background (ID: b8k2m4x7q). Output is being written to: ${file}. You will be notified when it completes.`,
    `Command was moved to the background (ID: b8k2m4x7q) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: ${file}.`,
  ]) {
    assert.deepEqual(parseOutputAnnouncement(text), { taskId: 'b8k2m4x7q', outputPath: file }, text);
  }
  // The MCP task wording: no colon, a semicolon after the path.
  assert.deepEqual(
    parseOutputAnnouncement('Output is being written to /tmp/fixture/tasks/k1a2b3c4d.output; use Read on that path for interim output.'),
    { taskId: 'k1a2b3c4d', outputPath: '/tmp/fixture/tasks/k1a2b3c4d.output' },
  );
});

test('a Windows path with spaces reads whole; relative or overlong paths are refused', () => {
  // platform-agnostic: the announcement parser treats the path as an opaque string.
  const file = 'C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\C--Users-dev-My Project\\5b1f\\tasks\\b0aa11bb2.output';
  assert.deepEqual(
    parseOutputAnnouncement(`Command running in background with ID: b0aa11bb2. Output is being written to: ${file}. You will be notified when it completes.`),
    { taskId: 'b0aa11bb2', outputPath: file },
  );
  assert.equal(parseOutputAnnouncement('Output is being written to: tasks/b1.output.'), null);
  assert.equal(usableOutputPath(`/${'x'.repeat(1024)}`), '');
  assert.equal(usableOutputPath('/home/dev/fixture.log'), '/home/dev/fixture.log');
  assert.equal(parseOutputAnnouncement('Command finished with exit code 0'), null);
});

test('the structured result names the task when one call is answered; array content is read too', () => {
  const found = discoverTaskOutputPaths({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'Output is being written to: /tmp/fixture/custom.log.' }] }] },
    tool_use_result: { backgroundTaskId: 'b9zz8yy7x' },
  });
  assert.deepEqual(found, [{ taskId: 'b9zz8yy7x', outputPath: '/tmp/fixture/custom.log', toolUseId: 'toolu_1' }]);
  assert.deepEqual(discoverTaskOutputPaths(assistantText('Output is being written to: /tmp/x/b1.output.')), []);
});

test('a foreground command that prints the phrase binds nothing; the MCP note does', () => {
  const printed = (text) => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: text }] },
    tool_use_result: { stdout: text, stderr: '', interrupted: false },
  });
  assert.deepEqual(discoverTaskOutputPaths(printed('build started\nOutput is being written to: /tmp/fixture/tasks/b8k2m4x7q.output.\n')), []);
  assert.deepEqual(discoverTaskOutputPaths(printed('Output is being written to: /tmp/fixture/tasks/b8k2m4x7q.output.')), []);
  assert.deepEqual(
    discoverTaskOutputPaths(printed('Output is being written to /tmp/fixture/tasks/k1a2b3c4d.output; use Read on that path for interim output.')),
    [{ taskId: 'k1a2b3c4d', outputPath: '/tmp/fixture/tasks/k1a2b3c4d.output', toolUseId: 'toolu_fg' }],
  );
});

test('the exit code comes from the settle summary, last mention first', () => {
  assert.equal(exitCodeFromSummary('Background command "npm test" failed with exit code 2'), 2);
  assert.equal(exitCodeFromSummary('Background command "check exit code 7 handling" completed (exit code 0)'), 0);
  assert.equal(exitCodeFromSummary('Background command "npm test" was stopped'), null);
});

/** The assistant message whose tool_use starts a shell task. */
function shellCall(toolUseId, command, name = 'Bash') {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input: { command, description: 'Run the checks', run_in_background: true } }] },
  };
}

test('the command lines of Bash and Monitor calls, by tool_use id, bounded at 8,000 characters', () => {
  assert.deepEqual(shellCommandsOf(shellCall('toolu_a', 'npm test 2>&1 | tail -40')), [{ toolUseId: 'toolu_a', command: 'npm test 2>&1 | tail -40' }]);
  assert.deepEqual(shellCommandsOf(shellCall('toolu_m', 'tail -f /tmp/dev.log', 'Monitor')), [{ toolUseId: 'toolu_m', command: 'tail -f /tmp/dev.log' }]);
  assert.deepEqual(shellCommandsOf(shellCall('toolu_r', 'not a shell', 'Read')), []);
  assert.deepEqual(shellCommandsOf({ ...shellCall('toolu_u', 'x'), type: 'user' }), []);
  assert.equal(shellCommandsOf(shellCall('toolu_l', `echo ${'x'.repeat(9000)}`))[0].command.length, MAX_TASK_COMMAND_CHARS);
});

// --- the runner -----------------------------------------------------------------

test('a shell row carries the file its Bash result announced, and a snapshot kind before that', async () => {
  const file = `${TASKS_DIR}/b8k2m4x7q.output`;
  const { stub, turn, endTurn, finish } = await withRunner({
    tasks: [{ task_id: 'b8k2m4x7q', task_type: 'local_bash', description: 'npm run soak' }],
  });
  await waitFor(() => rowOf(stub, 'b8k2m4x7q'), { label: 'the row was published' });
  assert.equal(rowOf(stub, 'b8k2m4x7q').outputKind, 'snapshot');
  assert.equal('outputPath' in rowOf(stub, 'b8k2m4x7q'), false);

  turn.emit(backgroundBashResult('b8k2m4x7q', file));
  await waitFor(() => rowOf(stub, 'b8k2m4x7q')?.outputPath, { label: 'the row names the file' });
  assert.equal(rowOf(stub, 'b8k2m4x7q').outputKind, 'file');
  assert.equal(rowOf(stub, 'b8k2m4x7q').outputPath, file);
  await endTurn();
  await finish();
});

test('a shell row and its settle carry the command line of the Bash call that started it', async () => {
  const file = `${TASKS_DIR}/b7c6d5e4f.output`;
  const { stub, turn, runner, endTurn } = await withRunner();
  turn.emit(shellCall('toolu_b7c6', 'npm test 2>&1 | tail -40'));
  turn.emit(backgroundBashResult('b7c6d5e4f', file, { toolUseId: 'toolu_b7c6' }));
  turn.emit(backgroundTasksMessage([{ task_id: 'b7c6d5e4f', task_type: 'local_bash', description: 'Run the unit tests' }]));
  await waitFor(() => rowOf(stub, 'b7c6d5e4f')?.command, { label: 'the row names the command' });
  assert.equal(rowOf(stub, 'b7c6d5e4f').command, 'npm test 2>&1 | tail -40');
  assert.equal(rowOf(stub, 'b7c6d5e4f').description, 'Run the unit tests');
  await endTurn();
  turn.emit(backgroundTasksMessage([]));
  turn.emit({ type: 'system', subtype: 'task_notification', task_id: 'b7c6d5e4f', status: 'completed', summary: 'Background command "npm test" completed (exit code 0)', skip_transcript: true });
  await waitFor(() => postsTo(stub, '/api/background-task-settled').length === 1, { label: 'the settle post' });
  assert.equal(postsTo(stub, '/api/background-task-settled')[0].command, 'npm test 2>&1 | tail -40');
  turn.endInput();
  await settled(runner);
});

test('a Monitor row takes its command from task_started\'s tool_use id; an agent row has none', async () => {
  const { stub, turn, endTurn, finish } = await withRunner({
    tasks: [
      { task_id: 'm1n2o3p4q', task_type: 'local_bash', description: 'watch the dev log' },
      { task_id: 'a9b8c7d6e', task_type: 'local_agent', description: 'review the diff' },
    ],
  });
  turn.emit(shellCall('toolu_mon1', 'tail -f /tmp/dev.log | grep --line-buffered ERROR', 'Monitor'));
  turn.emit({ type: 'system', subtype: 'task_started', task_id: 'm1n2o3p4q', task_type: 'local_bash', description: 'watch the dev log', tool_use_id: 'toolu_mon1' });
  turn.emit({ type: 'system', subtype: 'task_started', task_id: 'a9b8c7d6e', task_type: 'local_agent', description: 'review the diff', tool_use_id: 'toolu_mon1' });
  await waitFor(() => rowOf(stub, 'm1n2o3p4q')?.command, { label: 'the monitor row names its command', timeoutMs: 5000 });
  assert.equal(rowOf(stub, 'm1n2o3p4q').command, 'tail -f /tmp/dev.log | grep --line-buffered ERROR');
  assert.equal('command' in rowOf(stub, 'a9b8c7d6e'), false, 'only shell rows');
  await endTurn();
  await finish();
});

test('a live task keeps its command when 200 newer Bash calls have come and gone', async () => {
  const { stub, turn, runner, endTurn } = await withRunner();
  turn.emit(shellCall('toolu_long', 'npm run soak 2>&1 | tail -20'));
  turn.emit(backgroundTasksMessage([{ task_id: 'b0l1o2n3g', task_type: 'local_bash', description: 'soak' }]));
  turn.emit({ type: 'system', subtype: 'task_started', task_id: 'b0l1o2n3g', task_type: 'local_bash', description: 'soak', tool_use_id: 'toolu_long' });
  await waitFor(() => rowOf(stub, 'b0l1o2n3g')?.command, { label: 'the row names its command', timeoutMs: 5000 });
  for (let index = 0; index < 250; index += 1) turn.emit(shellCall(`toolu_n${index}`, `echo ${index}`));
  await runner.resyncBackgroundTasks();
  assert.equal(rowOf(stub, 'b0l1o2n3g').command, 'npm run soak 2>&1 | tail -20');
  await endTurn();
  turn.emit(backgroundTasksMessage([]));
  turn.emit({ type: 'system', subtype: 'task_notification', task_id: 'b0l1o2n3g', status: 'completed', summary: 'done (exit code 0)', skip_transcript: true });
  await waitFor(() => postsTo(stub, '/api/background-task-settled').length === 1, { label: 'the settle post' });
  assert.equal(postsTo(stub, '/api/background-task-settled')[0].command, 'npm run soak 2>&1 | tail -20');
  turn.endInput();
  await settled(runner);
});

test('a path announced before the task joins the set is used when it does', async () => {
  const file = `${TASKS_DIR}/b1c2d3e4f.output`;
  const { stub, turn, endTurn, finish } = await withRunner();
  turn.emit(backgroundBashResult('b1c2d3e4f', file, { structured: false }));
  turn.emit(backgroundTasksMessage([{ task_id: 'b1c2d3e4f', task_type: 'local_bash', description: 'npm run build' }]));
  await waitFor(() => rowOf(stub, 'b1c2d3e4f'), { label: 'the row was published' });
  assert.equal(rowOf(stub, 'b1c2d3e4f').outputPath, file);
  await endTurn();
  await finish();
});

test('a Monitor task gets the file next to a known one, only once it exists', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-claude-task-output-'));
  try {
    const shellFile = path.join(dir, 'b5h6j7k8l.output');
    const { stub, turn, runner, endTurn, finish } = await withRunner({
      tasks: [
        { task_id: 'b5h6j7k8l', task_type: 'local_bash', description: 'npm run dev' },
        { task_id: 'b9m8n7p6q', task_type: 'local_bash', description: 'watch the dev log' },
      ],
    });
    turn.emit(backgroundBashResult('b5h6j7k8l', shellFile));
    await waitFor(() => rowOf(stub, 'b5h6j7k8l')?.outputPath, { label: 'the shell row names its file' });
    assert.equal(rowOf(stub, 'b9m8n7p6q').outputKind, 'snapshot', 'no file yet: nothing is named');

    fs.writeFileSync(path.join(dir, 'b9m8n7p6q.output'), 'ready\n');
    await runner.resyncBackgroundTasks();
    assert.equal(rowOf(stub, 'b9m8n7p6q').outputPath, path.join(dir, 'b9m8n7p6q.output'));
    assert.equal(rowOf(stub, 'b9m8n7p6q').outputKind, 'file');
    await endTurn();
    await finish();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent rows carry no output fields; their steps come from task_progress and ride the settle post', async () => {
  const { stub, turn, endTurn, finish } = await withRunner({
    tasks: [{ task_id: 'a1b2c3d4e', task_type: 'local_agent', description: 'review the diff' }],
  });
  turn.emit({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'a1b2c3d4e',
    description: 'review the diff',
    usage: { total_tokens: 1200, tool_uses: 22, duration_ms: 9000 },
  });
  await endTurn();
  await waitFor(() => rowOf(stub, 'a1b2c3d4e')?.steps === 22, { label: 'the step count was published' });
  const row = rowOf(stub, 'a1b2c3d4e');
  assert.equal('outputPath' in row, false);
  assert.equal('outputKind' in row, false);

  turn.emit(backgroundTasksMessage([]));
  turn.emit({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'a1b2c3d4e',
    status: 'completed',
    summary: 'Agent "review the diff" finished',
    output_file: `${TASKS_DIR}/a1b2c3d4e.output`,
    usage: { total_tokens: 1500, tool_uses: 25, duration_ms: 12000 },
    skip_transcript: true,
  });
  await waitFor(() => postsTo(stub, '/api/background-task-settled').length === 1, { label: 'the settle post' });
  const [settle] = postsTo(stub, '/api/background-task-settled');
  assert.equal(settle.steps, 25);
  assert.equal('outputPath' in settle, false, 'an agent has no console');
  assert.equal('exitCode' in settle, false);
  await finish();
});

test('a shell settle names its file and exit code, from output_file when no result announced it', async () => {
  const file = `${TASKS_DIR}/b2x3y4z5a.output`;
  const { stub, turn, endTurn, finish } = await withRunner({
    tasks: [{ task_id: 'b2x3y4z5a', task_type: 'local_bash', description: 'npm test' }],
  });
  await endTurn();
  turn.emit(backgroundTasksMessage([]));
  turn.emit({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'b2x3y4z5a',
    status: 'failed',
    summary: 'Background command "npm test" failed with exit code 1',
    output_file: file,
    skip_transcript: true,
  });
  await waitFor(() => postsTo(stub, '/api/background-task-settled').length === 1, { label: 'the settle post' });
  const [settle] = postsTo(stub, '/api/background-task-settled');
  assert.equal(settle.outputPath, file);
  assert.equal(settle.exitCode, 1);
  assert.equal(settle.status, 'failed');
  assert.equal(settle.taskType, 'local_bash');
  await finish();
});

test('the snapshot control posts the CLI\'s getTaskOutput answer for the relay to serve', async () => {
  const { stub, turn, runner, endTurn, finish } = await withRunner({
    tasks: [{ task_id: 'b7q6w5e4r', task_type: 'local_bash', description: 'npm run soak' }],
  });
  const asked = [];
  turn.getTaskOutput = async (taskId) => {
    asked.push(taskId);
    return { output: 'suite 3 of 9\n', total_bytes: 40_960, truncated: true };
  };
  await endTurn();
  assert.equal(await runner.snapshotTaskOutput('b7q6w5e4r'), true);
  assert.deepEqual(asked, ['b7q6w5e4r']);
  const snapshot = stub.calls.find((call) => call.routePath === '/api/background-tasks/b7q6w5e4r/output-snapshot');
  assert.ok(snapshot, 'posted to the task\'s snapshot route');
  assert.equal(snapshot.method, 'POST');
  assert.deepEqual(snapshot.body, { conversationId: 'conv-1', output: 'suite 3 of 9\n', totalBytes: 40_960, truncated: true });

  // A CLI that refuses (the task is not a shell): nothing is posted.
  turn.getTaskOutput = async () => { throw new Error('not a shell task'); };
  assert.equal(await runner.snapshotTaskOutput('b7q6w5e4r'), false);
  assert.equal(stub.calls.filter((call) => call.routePath.endsWith('/output-snapshot')).length, 1);
  await finish();
});

test('without a process or without getTaskOutput the snapshot control does nothing', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({ stub, startImpl: () => scriptedTurn() });
  assert.equal(await runner.snapshotTaskOutput('b7q6w5e4r'), false);
  assert.equal(stub.calls.length, 0);
});
