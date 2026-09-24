import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunnerLinkBridge, failSettlingRowsOnShutdown } from './claude-worker-link-wiring.mjs';

test('the bridge turns the runner’s gate flips into link readiness frames', () => {
  const frames = [];
  const bridge = createRunnerLinkBridge();
  bridge.onDeliveryReadinessChange(false); // before attach: dropped, not thrown
  bridge.attach({
    notifyReady: async (reason) => { frames.push(['ready', reason]); return true; },
    notifyUnready: (reason) => { frames.push(['unready', reason]); return true; },
    serverSupports: (capability) => capability === 'steering-held',
  });
  bridge.onDeliveryReadinessChange(false);
  bridge.onDeliveryReadinessChange(true);
  assert.deepEqual(frames, [['unready', 'steering-held'], ['ready', 'steering-resumed']]);
  assert.equal(bridge.canHandBackHeldDelivery(), true);
});

test('without the relay advertising steering-held, held deliveries are not handed back', () => {
  const bridge = createRunnerLinkBridge();
  assert.equal(bridge.canHandBackHeldDelivery(), false, 'no link yet: assume an older relay');
  bridge.attach({ notifyReady: async () => true, notifyUnready: () => true, serverSupports: () => false });
  assert.equal(bridge.canHandBackHeldDelivery(), false);
});

test('shutdown fails only the settling rows, fenced and with their terminal error', async () => {
  const calls = [];
  const terminalError = { stableCode: 'relay.steer-settle-failed', message: 'already sent' };
  const runner = {
    getActiveQueueMessageIds: () => [
      { id: 'q-live', attemptId: 'a-live' },
      { id: 'q-settling', attemptId: 'a-settling', terminalError },
    ],
  };
  const failed = await failSettlingRowsOnShutdown({
    api: async (method, routePath, body) => { calls.push({ method, routePath, body }); return { ok: true }; },
    runner,
  });
  assert.equal(failed, 1);
  assert.deepEqual(calls, [{
    method: 'POST',
    routePath: '/api/requeue',
    body: { messageId: 'q-settling', attemptId: 'a-settling', terminalError },
  }]);
});

test('a hanging relay cannot hold the shutdown past its cap', async () => {
  const started = Date.now();
  await failSettlingRowsOnShutdown({
    api: () => new Promise(() => {}),
    runner: { getActiveQueueMessageIds: () => [{ id: 'q-1', terminalError: { code: 'x' } }] },
    timeoutMs: 40,
  });
  assert.ok(Date.now() - started < 1_000);
});
