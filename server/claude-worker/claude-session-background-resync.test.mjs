// The relay holds a worker's background-task set in memory only. The worker
// is the source of truth: it names its live task ids for the heartbeat's
// digest, sends the full set again when the relay asks, and keeps a settle
// notice the relay was not there to take.
import test from 'node:test';
import assert from 'node:assert/strict';

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
  taskNotificationMessage,
  userReplay,
  waitFor,
} from './claude-session-test-harness.mjs';

const TASK = { task_id: 'task_fixture_shell', task_type: 'local_bash', description: 'npm run soak' };
const postsTo = (stub, routePath) => stub.calls.filter((call) => call.routePath === routePath).map((call) => call.body);

/** A runner whose first turn ended with one background shell still running. */
async function withRunningShell({ stub = makeApiStub() } = {}) {
  const turn = scriptedTurn();
  const runner = makeRunner({ stub, startImpl: () => turn, lifecyclePollMs: 10 });
  const startedAfter = Date.now();
  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([TASK]));
  turn.emit(assistantText('started the soak run'));
  turn.emit(resultMessage('started the soak run', 'native-1'));
  assert.equal(await first, true);
  await waitFor(() => postsTo(stub, '/api/background-tasks').length === 1, { label: 'the set was published' });
  return {
    stub, turn, runner, startedAfter,
    async finish() {
      turn.emit(backgroundTasksMessage([]));
      turn.endInput();
      await settled(runner);
    },
  };
}

test('the worker names its live task ids and sends the full set again when asked, flagged as a resync', async () => {
  const { stub, runner, startedAfter, finish } = await withRunningShell();
  assert.deepEqual(runner.backgroundTaskIds(), ['task_fixture_shell']);
  const [published] = postsTo(stub, '/api/background-tasks');
  assert.equal('resync' in published, false, 'a change of the set is not a resync');

  await runner.resyncBackgroundTasks();
  const posts = postsTo(stub, '/api/background-tasks');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].resync, true);
  assert.equal(posts[1].conversationId, 'conv-1');
  assert.deepEqual(posts[1].tasks.map((task) => [task.taskId, task.taskType, task.description]), [['task_fixture_shell', 'local_bash', 'npm run soak']]);
  // The original start time, the same in every post: the relay restores it.
  assert.ok(posts[1].tasks[0].startedAt >= startedAfter && posts[1].tasks[0].startedAt <= Date.now());
  assert.equal(posts[1].tasks[0].startedAt, published.tasks[0].startedAt);

  // Asked again (the relay's set still differs): sent again, nothing swallows it.
  await runner.resyncBackgroundTasks();
  assert.equal(postsTo(stub, '/api/background-tasks').filter((body) => body.resync === true).length, 2);
  await finish();
});

test('a failed resync post does not throw; the next request sends the set again', async () => {
  const failRoutes = new Set();
  const stub = makeApiStub({ failRoutes });
  const { runner, finish } = await withRunningShell({ stub });
  failRoutes.add('/api/background-tasks');
  await runner.resyncBackgroundTasks();
  failRoutes.clear();
  await runner.resyncBackgroundTasks();
  const resyncs = postsTo(stub, '/api/background-tasks').filter((body) => body.resync === true);
  assert.equal(resyncs.length, 2, 'tried, failed, tried again');
  assert.deepEqual(resyncs[1].tasks.map((task) => task.taskId), ['task_fixture_shell']);
  await finish();
});

test('with no process the answer to a resync is the empty set', async () => {
  const stub = makeApiStub();
  const runner = makeRunner({ stub, startImpl: () => scriptedTurn() });
  assert.deepEqual(runner.backgroundTaskIds(), []);
  await runner.resyncBackgroundTasks();
  const [post] = postsTo(stub, '/api/background-tasks');
  assert.deepEqual(post, { conversationId: 'conv-1', tasks: [], order: post.order, resync: true });
  assert.equal(post.order.seq, 1);
});

test('every post of the set carries its place in the worker\'s order', async () => {
  const { stub, turn, runner, startedAfter, finish } = await withRunningShell();
  await runner.resyncBackgroundTasks();
  turn.emit(backgroundTasksMessage([TASK, { task_id: 'task_fixture_build', task_type: 'local_bash', description: 'npm run build' }]));
  await waitFor(() => postsTo(stub, '/api/background-tasks').length === 3, { label: 'the changed set was published' });
  await finish();
  await waitFor(() => postsTo(stub, '/api/background-tasks').at(-1).tasks.length === 0, { label: 'the empty set was published' });
  const orders = postsTo(stub, '/api/background-tasks').map((body) => body.order);
  assert.deepEqual(orders.map((order) => order.seq), orders.map((_, index) => index + 1), 'one count for ordinary posts and resyncs alike');
  assert.equal(new Set(orders.map((order) => order.epoch)).size, 1);
  assert.ok(orders[0].epoch <= startedAfter + 1_000 && orders[0].epoch > 0, 'the epoch is this worker\'s own start');
});

test('a resync while a throttled publish is waiting sends the current set once, and the wait is over', async () => {
  const { stub, turn, runner, finish } = await withRunningShell();
  // Progress is published on a trailing 2 s throttle.
  turn.emit({ type: 'system', subtype: 'task_progress', task_id: 'task_fixture_shell', summary: 'suite 3 of 9' });
  await waitFor(() => !!runner._getProcess().taskPublishTimer, { label: 'a throttled publish is waiting' });
  assert.equal(postsTo(stub, '/api/background-tasks').length, 1);

  await runner.resyncBackgroundTasks();
  const posts = postsTo(stub, '/api/background-tasks');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].resync, true);
  assert.equal(posts[1].tasks[0].summary, 'suite 3 of 9', 'the answer carries what the waiting publish would have');
  assert.ok(posts[1].order.seq > posts[0].order.seq);
  assert.equal(runner._getProcess().taskPublishTimer, null, 'nothing older is left to arrive after the answer');
  await finish();
});

test('a settle notice the relay was not there to take is kept and sent again, describing the task', async () => {
  const failRoutes = new Set(['/api/background-task-settled']);
  const stub = makeApiStub({ failRoutes });
  const { turn, runner, finish } = await withRunningShell({ stub });
  const startedAt = postsTo(stub, '/api/background-tasks')[0].tasks[0].startedAt;
  // The SDK drops the row, then says how the task ended; the relay is away.
  turn.emit(backgroundTasksMessage([]));
  turn.emit({ ...taskNotificationMessage('task_fixture_shell', 'failed', { skipTranscript: true }), summary: 'Exit code 2' });
  await waitFor(() => postsTo(stub, '/api/background-task-settled').length === 1, { label: 'the settle post was tried' });
  assert.deepEqual(runner.backgroundTaskIds(), []);

  // Still away at the next heartbeat round: kept.
  await runner.flushKeptTaskSettles();
  assert.equal(postsTo(stub, '/api/background-task-settled').length, 2);
  // The relay answers again (restarted: it never knew the task).
  failRoutes.clear();
  await runner.flushKeptTaskSettles();
  const posts = postsTo(stub, '/api/background-task-settled');
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[2], {
    conversationId: 'conv-1',
    taskId: 'task_fixture_shell',
    toolUseId: null,
    status: 'failed',
    summary: 'Exit code 2',
    description: 'npm run soak',
    taskType: 'local_bash',
    startedAt,
    // A shell's summary names its exit code.
    exitCode: 2,
  });
  // Taken: not sent a second time.
  await runner.flushKeptTaskSettles();
  assert.equal(postsTo(stub, '/api/background-task-settled').length, 3);
  await finish();
});

test('a task that never was in the published set is settled without a description', async () => {
  // The relay raises the end of a task it does not know only when the
  // notice describes it; a task that was never session-level background
  // work must stay as silent as it was.
  const { stub, turn, finish } = await withRunningShell();
  turn.emit(taskNotificationMessage('task_fixture_inturn', 'completed', { skipTranscript: true }));
  await waitFor(() => postsTo(stub, '/api/background-task-settled').length === 1, { label: 'the settle post' });
  const [post] = postsTo(stub, '/api/background-task-settled');
  assert.equal(post.taskId, 'task_fixture_inturn');
  assert.equal('description' in post, false);
  await finish();
});

test('told stale for its newest set, the worker asks for a heartbeat; an overtaken older post asks for nothing', async () => {
  let answer = { ok: true };
  const stub = makeApiStub({ routeResponses: { '/api/background-tasks': () => answer } });
  const turn = scriptedTurn();
  let asked = 0;
  const runner = makeRunner({ stub, startImpl: () => turn, lifecyclePollMs: 10, onBackgroundTaskSetStale: () => { asked += 1; } });
  const first = runner.handlePendingPayload({ message: { ...baseMessage } });
  turn.emit(initMessage('native-1'));
  turn.emit(userReplay('hello'));
  turn.emit(backgroundTasksMessage([TASK]));
  turn.emit(assistantText('started the soak run'));
  turn.emit(resultMessage('started the soak run', 'native-1'));
  assert.equal(await first, true);
  await waitFor(() => postsTo(stub, '/api/background-tasks').length === 1, { label: 'the set was published' });
  assert.equal(asked, 0);

  // The relay drops the newest set (it takes another process for the session's holder).
  answer = { ok: true, count: 1, stale: true, reason: 'not-holder' };
  await runner.resyncBackgroundTasks();
  assert.equal(asked, 1);
  // Dropped again at once: the periodic beat repeats the request, no storm of extra ones.
  await runner.resyncBackgroundTasks();
  assert.equal(asked, 1);
  answer = { ok: true };
  turn.emit(backgroundTasksMessage([]));
  turn.endInput();
  await settled(runner);
});
