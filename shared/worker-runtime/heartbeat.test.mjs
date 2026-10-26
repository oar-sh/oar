import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeatController } from './heartbeat.mjs';

function makeController({ getSteeringState } = {}) {
  const calls = [];
  let timer = null;
  const controller = createHeartbeatController({
    api: async (method, path, body) => { calls.push({ method, path, body }); },
    pollMs: 60_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => timer,
    setHeartbeatTimer: (value) => { timer = value; },
    getActiveQueueMessageId: () => 'q-1',
    getActiveQueueMessageIds: () => ['q-1', 'q-2'],
    ...(getSteeringState ? { getSteeringState } : {}),
  });
  return { controller, calls };
}

test('the heartbeat body carries the steering snapshot when the worker provides one', async () => {
  const { controller, calls } = makeController({
    getSteeringState: () => ({ turnActive: true, canSteer: false, holdReason: 'question' }),
  });
  await controller.pulseHeartbeat();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.steering, { turnActive: true, canSteer: false, holdReason: 'question' });
  assert.equal(calls[0].body.activeQueueMessageId, 'q-1');
  assert.deepEqual(calls[0].body.activeQueueMessageIds, ['q-1', 'q-2']);
});

test('workers without a steering probe keep the previous heartbeat body shape', async () => {
  const { controller, calls } = makeController();
  await controller.pulseHeartbeat();
  assert.equal(calls.length, 1);
  assert.equal('steering' in calls[0].body, false);
});

test('a non-object steering snapshot is dropped from the body', async () => {
  const { controller, calls } = makeController({ getSteeringState: () => 'nope' });
  await controller.pulseHeartbeat();
  assert.equal('steering' in calls[0].body, false);
});

test('settle-failed rows ride the heartbeat and the relay’s acknowledgement is handed back', async () => {
  const calls = [];
  const acknowledged = [];
  let timer = null;
  const entry = { id: 'q-9', attemptId: 'a-9', terminalError: { stableCode: 'relay.steer-settle-failed' } };
  const controller = createHeartbeatController({
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      return { ok: true, settleFailedHandled: ['q-9'], settleFailedSkipped: ['q-8'] };
    },
    pollMs: 60_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => timer,
    setHeartbeatTimer: (value) => { timer = value; },
    getActiveQueueMessageIds: () => ['q-9'],
    getSettleFailed: () => [entry],
    onSettleFailedHandled: (ids) => acknowledged.push(...ids),
  });
  await controller.pulseHeartbeat();
  assert.deepEqual(calls[0].body.settleFailed, [entry]);
  assert.deepEqual(acknowledged, ['q-9', 'q-8'], 'failed and skipped rows are both released');
});

test('requested pulses coalesce into one that carries the state at the end of the window', async () => {
  const calls = [];
  const timers = [];
  let steering = { turnActive: true, canSteer: false, holdReason: 'delivery' };
  const controller = createHeartbeatController({
    api: async (method, path, body) => { calls.push(body); },
    pollMs: 60_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => null,
    setHeartbeatTimer: () => {},
    getSteeringState: () => steering,
    setTimeoutImpl: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { handle.cleared = true; },
  });

  controller.requestPulse();
  steering = { turnActive: true, canSteer: true, holdReason: null };
  controller.requestPulse();
  assert.equal(timers.length, 1, 'one window, one pulse');
  assert.equal(timers[0].ms, 300);
  timers[0].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((body) => body.steering), [{ turnActive: true, canSteer: true, holdReason: null }]);

  // The window is spent: the next request opens a new one, which a stop
  // cancels.
  controller.requestPulse();
  assert.equal(timers.length, 2);
  controller.stopHeartbeat();
  assert.equal(timers[1].cleared, true);
  controller.requestPulse();
  assert.equal(timers.length, 3, 'a stop does not leave the window wedged');
});

// ─── Background tasks: the digest and the relay asking for the set again ─────

function makeTaskController({ answers = [{ ok: true }], ids = () => ['task_fixture_b', 'task_fixture_a'], ...options } = {}) {
  const calls = [];
  const log = [];
  let timer = null;
  let beat = 0;
  const controller = createHeartbeatController({
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      const answer = answers[Math.min(beat, answers.length - 1)];
      beat += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    pollMs: 60_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => timer,
    setHeartbeatTimer: (value) => { timer = value; },
    getActiveQueueMessageId: () => '',
    ...(ids ? { getBackgroundTaskIds: ids } : {}),
    onResyncBackgroundTasks: () => { log.push('resync'); },
    onAnswered: () => { log.push('answered'); },
    ...options,
  });
  return { controller, calls, log };
}

test('the heartbeat body carries a digest of the live task ids, sorted ids only', async () => {
  const { controller, calls } = makeTaskController();
  await controller.pulseHeartbeat();
  const sent = calls[0].body.backgroundTasks;
  assert.equal(sent.count, 2);
  assert.match(sent.digest, /^[0-9a-f]{16}$/);
  const other = makeTaskController({ ids: () => ['task_fixture_a', 'task_fixture_b'] });
  await other.controller.pulseHeartbeat();
  assert.deepEqual(other.calls[0].body.backgroundTasks, sent, 'order does not matter');
  const none = makeTaskController({ ids: () => [] });
  await none.controller.pulseHeartbeat();
  assert.equal(none.calls[0].body.backgroundTasks.count, 0, '"no tasks" is an opinion too');
  assert.notEqual(none.calls[0].body.backgroundTasks.digest, sent.digest);
});

test('a worker that publishes no task sets sends no digest', async () => {
  // Cursor, Grok and Claude Cloud workers: the relay reads a missing digest
  // as no opinion and never asks them for a set.
  const { controller, calls } = makeTaskController({ ids: null });
  await controller.pulseHeartbeat();
  assert.equal('backgroundTasks' in calls[0].body, false);
});

test('the relay asking for the set again reaches the worker, after the kept posts', async () => {
  const { controller, log } = makeTaskController({ answers: [{ ok: true, resyncBackgroundTasks: true }, { ok: true }] });
  await controller.pulseHeartbeat();
  assert.deepEqual(log, ['answered', 'resync']);
  await controller.pulseHeartbeat();
  assert.deepEqual(log, ['answered', 'resync', 'answered'], 'not asked, not sent');
});

test('a relay that predates the digest answers without the field and nothing is sent again', async () => {
  const { controller, calls, log } = makeTaskController({ answers: [{ ok: true, pendingCount: 0 }] });
  assert.equal(await controller.pulseHeartbeat(), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(log, ['answered']);
});

test('a resync that fails is asked for again by the next beat; a beat that fails asks for nothing', async () => {
  let attempts = 0;
  const { controller, log } = makeTaskController({
    answers: [{ ok: true, resyncBackgroundTasks: true }, new Error('relay away'), { ok: true, resyncBackgroundTasks: true }],
    onResyncBackgroundTasks: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('post failed');
    },
  });
  assert.equal(await controller.pulseHeartbeat(), true, 'a failed resync does not fail the beat');
  assert.equal(await controller.pulseHeartbeat(), false);
  assert.equal(attempts, 1);
  assert.equal(await controller.pulseHeartbeat(), true);
  assert.equal(attempts, 2);
  assert.deepEqual(log, ['answered', 'answered']);
});

test('a worker that states its kind says it in every beat; one that does not sends no key', async () => {
  const calls = [];
  let timer = null;
  const controller = createHeartbeatController({
    api: async (method, path, body) => { calls.push({ method, path, body }); },
    pollMs: 60_000,
    getSessionReady: () => true,
    getHeartbeatTimer: () => timer,
    setHeartbeatTimer: (value) => { timer = value; },
    getActiveQueueMessageId: () => '',
    workerKind: 'claude-api',
  });
  await controller.pulseHeartbeat();
  assert.equal(calls[0].body.workerKind, 'claude-api');
  const { controller: plain, calls: plainCalls } = makeController();
  await plain.pulseHeartbeat();
  assert.equal('workerKind' in plainCalls[0].body, false);
});
