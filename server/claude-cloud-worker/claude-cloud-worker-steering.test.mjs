import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaudeCloudSteeringState } from './claude-cloud-worker-steering.mjs';

// A stand-in for the runner: only the three functions the snapshot reads.
function fakeRunner({ attempt = null, turnActive = false, hold = '' } = {}) {
  return {
    getActiveQueueAttempt: () => attempt,
    isTurnActive: () => turnActive,
    releaseHold: () => hold,
  };
}

test('between turns with nothing running in the cloud the worker may be replaced', () => {
  assert.deepEqual(buildClaudeCloudSteeringState(fakeRunner()), {
    turnActive: false,
    canSteer: false,
    holdReason: null,
    messageId: null,
    supported: false,
    cancellableIds: [],
    releasable: true,
    releaseHold: null,
    backgroundTaskCount: 0,
  });
});

test('a turn holds the release and names its row', () => {
  const state = buildClaudeCloudSteeringState(fakeRunner({
    attempt: { id: 'queue-message-1', attemptId: 'attempt-1' },
    turnActive: true,
    hold: 'turn',
  }));

  assert.equal(state.turnActive, true);
  assert.equal(state.messageId, 'queue-message-1');
  assert.equal(state.releasable, false);
  assert.equal(state.releaseHold, 'turn');
  assert.equal(state.supported, false);
  assert.equal(state.canSteer, false);
});

test('cloud work no relay turn owns holds the release without a turn', () => {
  const state = buildClaudeCloudSteeringState(fakeRunner({ hold: 'background' }));

  assert.equal(state.turnActive, false);
  assert.equal(state.messageId, null);
  assert.equal(state.releasable, false);
  assert.equal(state.releaseHold, 'background');
  assert.equal(state.backgroundTaskCount, 0);
});

test('a runner without the hold function is still held by its turn', () => {
  const state = buildClaudeCloudSteeringState({
    getActiveQueueAttempt: () => ({ id: 'queue-message-2' }),
    isTurnActive: () => false,
  });

  assert.equal(state.turnActive, true);
  assert.equal(state.releasable, false);
  assert.equal(state.releaseHold, 'turn');
});
