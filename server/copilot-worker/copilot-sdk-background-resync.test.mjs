// The relay holds a worker's background-task set in memory only. The worker
// names its live task ids for the heartbeat's digest and sends the full set
// again when the relay asks. Its own "unchanged, not sent" check must not
// swallow that answer, and must not count a post the relay never took.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  baseMessage,
  createFakeCopilotClient,
  loadFixture,
  makeContinuationApiStub,
  makeRunner,
  waitFor,
} from './copilot-sdk-test-harness.mjs';

// One delivered turn that opens a detached shell (a one-minute timer) and
// settles while the shell runs on.
const TIMER_TURN = loadFixture('background-timer-turn');
const taskPosts = (stub) => stub.bodiesFor('/api/background-tasks');

async function withRunningShell({ failRoutes = new Set() } = {}) {
  const stub = makeContinuationApiStub({ failRoutes });
  const client = createFakeCopilotClient({
    onSend: (session) => { if (session.sends.length === 1) session.replay(TIMER_TURN); },
  });
  const { runner } = makeRunner({ stub, client, continuationRetryDelayMs: 1 });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  assert.equal(runner._getState().backgroundShells.length, 1);
  return { stub, client, runner, failRoutes };
}

test('the worker names its live task ids and answers a resync although the set is unchanged', async () => {
  const { stub, runner } = await withRunningShell();
  await waitFor(() => taskPosts(stub).some((body) => body.tasks.length === 1), { label: 'the shell was published' });
  const before = taskPosts(stub).length;
  const published = taskPosts(stub).at(-1);
  assert.equal('resync' in published, false);
  assert.deepEqual(runner.backgroundTaskIds(), [published.tasks[0].taskId]);

  // The same set again: the signature check drops an ordinary publish…
  runner._publishBackgroundTasks({ immediate: true });
  assert.equal(taskPosts(stub).length, before);
  // …but not the answer to the relay asking.
  await runner.resyncBackgroundTasks();
  const posts = taskPosts(stub);
  assert.equal(posts.length, before + 1);
  assert.equal(posts.at(-1).resync, true);
  assert.deepEqual(posts.at(-1).tasks, published.tasks, 'the full set, with its original start time');
  assert.ok(posts.at(-1).tasks[0].startedAt > 0);
  // Asked again, answered again.
  await runner.resyncBackgroundTasks();
  assert.equal(taskPosts(stub).length, before + 2);
});

test('a set whose post failed is not remembered as sent', async () => {
  const failRoutes = new Set(['/api/background-tasks']);
  const { stub, runner } = await withRunningShell({ failRoutes });
  await waitFor(() => taskPosts(stub).some((body) => body.tasks.length === 1), { label: 'the publish was tried' });
  const tried = taskPosts(stub).length;
  // The relay is away for the resync too: tried, not thrown.
  await runner.resyncBackgroundTasks();
  assert.equal(taskPosts(stub).length, tried + 1);

  failRoutes.clear();
  // The next ordinary publish of the very same set goes out: the relay never took it.
  await runner._publishBackgroundTasks({ immediate: true });
  assert.equal(taskPosts(stub).length, tried + 2);
  assert.equal('resync' in taskPosts(stub).at(-1), false);
  // Taken now: the same set again is dropped.
  await runner._publishBackgroundTasks({ immediate: true });
  assert.equal(taskPosts(stub).length, tried + 2);
});

test('with no background work the worker reports no ids and answers a resync with the empty set', async () => {
  const stub = makeContinuationApiStub();
  const client = createFakeCopilotClient({});
  const { runner } = makeRunner({ stub, client });
  assert.deepEqual(runner.backgroundTaskIds(), []);
  await runner.resyncBackgroundTasks();
  const post = taskPosts(stub).at(-1);
  assert.deepEqual(post, { conversationId: 'conv-1', tasks: [], order: post.order, resync: true });
});

test('two posts on their way at once: each carries its order, and the newer one says what the relay holds', async () => {
  // The relay answers the posts when the test lets it, in the order it chooses.
  const answers = [];
  const stub = makeContinuationApiStub({
    routeResponses: { '/api/background-tasks': () => new Promise((resolve) => { answers.push(resolve); }) },
  });
  const client = createFakeCopilotClient({
    onSend: (session) => { if (session.sends.length === 1) session.replay(TIMER_TURN); },
  });
  const { runner } = makeRunner({ stub, client, continuationRetryDelayMs: 1 });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await waitFor(() => taskPosts(stub).some((body) => body.tasks.length === 1), { label: 'the shell\'s post is on its way' });
  const first = taskPosts(stub).length - 1;

  // The timer fires while that post is unanswered: the set empties, a second post leaves.
  client.session.replay(loadFixture('background-timer-continuation'));
  await waitFor(() => taskPosts(stub).at(-1).tasks.length === 0, { label: 'the empty set\'s post is on its way' });
  const posts = taskPosts(stub);
  const last = posts.length - 1;
  assert.ok(posts[last].order.seq > posts[first].order.seq, 'numbered in the order they were built');
  assert.equal(posts[last].order.epoch, posts[first].order.epoch);

  // The relay answers the newer post first, the older one after it.
  answers[last]({});
  await new Promise((resolve) => setImmediate(resolve));
  for (const [index, answer] of answers.entries()) if (index !== last) answer({});
  await new Promise((resolve) => setImmediate(resolve));

  // What the relay holds is the newer set: publishing it again sends nothing.
  await runner._publishBackgroundTasks({ immediate: true });
  assert.equal(taskPosts(stub).length, posts.length, 'the older answer did not overwrite what the worker knows the relay holds');
});

test('a set the relay answers stale is not recorded as taken, and the worker asks for a heartbeat', async () => {
  let answer = { ok: true, count: 1, stale: true, reason: 'not-holder' };
  const stub = makeContinuationApiStub({ routeResponses: { '/api/background-tasks': () => answer } });
  const client = createFakeCopilotClient({
    onSend: (session) => { if (session.sends.length === 1) session.replay(TIMER_TURN); },
  });
  let asked = 0;
  const { runner } = makeRunner({ stub, client, continuationRetryDelayMs: 1, onBackgroundTaskSetStale: () => { asked += 1; } });
  assert.equal(await runner.handlePendingPayload({ message: baseMessage }), true);
  await waitFor(() => taskPosts(stub).some((body) => body.tasks.length === 1), { label: 'the shell was published' });
  await waitFor(() => asked === 1, { label: 'the worker asked for a heartbeat' });
  const dropped = taskPosts(stub).length;

  // The relay takes sets again. The very same set goes out: it was never taken.
  answer = { ok: true, count: 1 };
  await runner._publishBackgroundTasks({ immediate: true });
  assert.equal(taskPosts(stub).length, dropped + 1);
  assert.equal(taskPosts(stub).at(-1).tasks.length, 1);
  // Taken now: not sent again.
  await runner._publishBackgroundTasks({ immediate: true });
  assert.equal(taskPosts(stub).length, dropped + 1);
  assert.equal(asked, 1);
});
