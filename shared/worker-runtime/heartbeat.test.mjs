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
