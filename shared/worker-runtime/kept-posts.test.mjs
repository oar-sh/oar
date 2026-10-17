import test from 'node:test';
import assert from 'node:assert/strict';
import { KEPT_POSTS_MAX, KEPT_POSTS_TIMEOUT_MS, KEPT_POSTS_TTL_MS, createKeptPosts } from './kept-posts.mjs';

function setup(options = {}) {
  const sent = [];
  const state = { away: false, refuse: false, clock: 1_000_000 };
  const kept = createKeptPosts({
    api: async (method, routePath, body) => {
      if (state.away) throw new Error('fetch failed');
      if (state.refuse) throw Object.assign(new Error('HTTP 400'), { status: 400 });
      sent.push({ method, routePath, body });
      return { ok: true };
    },
    now: () => state.clock,
    ...options,
  });
  return { kept, sent, state };
}

const settle = (n) => ({ conversationId: 'conv-fixture-builder', taskId: `task_fixture_${n}`, status: 'completed' });

test('a post that fails is kept and sent again, in order, once the relay answers', async () => {
  const { kept, sent, state } = setup();
  assert.equal(await kept.post('/api/background-task-settled', settle(0)), true);
  state.away = true;
  assert.equal(await kept.post('/api/background-task-settled', settle(1)), false);
  assert.equal(await kept.post('/api/background-task-settled', settle(2)), false);
  assert.equal(kept.size(), 2);
  assert.equal(await kept.flush(), 0, 'still away: nothing sent, nothing lost');
  assert.equal(kept.size(), 2);
  state.away = false;
  assert.equal(await kept.flush(), 2);
  assert.deepEqual(sent.map((call) => call.body.taskId), ['task_fixture_0', 'task_fixture_1', 'task_fixture_2']);
  assert.equal(kept.size(), 0);
  assert.equal(await kept.flush(), 0, 'sent once');
  assert.equal(sent.length, 3);
});

test('bounded: the newest twenty, for ten minutes', async () => {
  assert.equal(KEPT_POSTS_MAX, 20);
  assert.equal(KEPT_POSTS_TTL_MS, 10 * 60_000);
  const { kept, sent, state } = setup();
  state.away = true;
  for (let n = 0; n < 25; n += 1) await kept.post('/api/background-task-settled', settle(n));
  assert.equal(kept.size(), 20);
  state.clock += KEPT_POSTS_TTL_MS;
  await kept.post('/api/background-task-settled', settle(25));
  state.clock += 1;
  state.away = false;
  assert.equal(await kept.flush(), 1, 'the twenty-five older ones are past their time');
  assert.deepEqual(sent.map((call) => call.body.taskId), ['task_fixture_25']);
});

test('a post the relay refuses is not kept', async () => {
  const { kept, state } = setup();
  state.refuse = true;
  assert.equal(await kept.post('/api/background-task-settled', settle(1)), false);
  assert.equal(kept.size(), 0);
});

test('overlapping flushes send each kept post once', async () => {
  const { kept, sent, state } = setup();
  state.away = true;
  await kept.post('/api/background-task-settled', settle(1));
  state.away = false;
  await Promise.all([kept.flush(), kept.flush()]);
  assert.equal(sent.length, 1);
});

test('a post that gets no answer is given up after the timeout and kept', async () => {
  assert.equal(KEPT_POSTS_TIMEOUT_MS, 10_000);
  let hang = true;
  const sent = [];
  // A relay that takes the request and never answers; like fetch, the call
  // only ends when its signal aborts it.
  const api = (method, routePath, body, { signal } = {}) => new Promise((resolve, reject) => {
    assert.ok(signal instanceof AbortSignal, 'every kept post carries an abort signal');
    if (!hang) { sent.push(body); resolve({ ok: true }); return; }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const kept = createKeptPosts({ api, timeoutMs: 30 });
  const started = Date.now();
  assert.equal(await kept.post('/api/background-task-settled', settle(1)), false);
  assert.ok(Date.now() - started < 2_000, 'not held for minutes');
  assert.equal(kept.size(), 1);
  // The flush is bounded the same way, so what waits behind it is not held up either.
  assert.equal(await kept.flush(), 0);
  assert.equal(kept.size(), 1);
  hang = false;
  assert.equal(await kept.flush(), 1);
  assert.deepEqual(sent.map((body) => body.taskId), ['task_fixture_1']);
});
