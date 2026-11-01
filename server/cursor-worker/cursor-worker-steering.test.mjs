import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCursorSteeringState } from './cursor-worker-steering.mjs';

// A turn runner as the heartbeat sees it: the two reads the snapshot takes.
function fakeRunner({ attempt = null, turnActive = false } = {}) {
  return {
    getActiveQueueAttempt: () => attempt,
    isTurnActive: () => turnActive,
  };
}

test('an idle Cursor worker is releasable and offers no steering', () => {
  assert.deepEqual(buildCursorSteeringState(fakeRunner()), {
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

test('an active attempt holds the release as a turn and names its row', () => {
  const state = buildCursorSteeringState(fakeRunner({ attempt: { id: 'q-7', attemptId: 'a-1' }, turnActive: true }));
  assert.equal(state.turnActive, true);
  assert.equal(state.messageId, 'q-7');
  assert.equal(state.releasable, false);
  assert.equal(state.releaseHold, 'turn');
});

test('a turn the runner reports before its row is known holds the release too', () => {
  const state = buildCursorSteeringState(fakeRunner({ turnActive: true }));
  assert.equal(state.releasable, false);
  assert.equal(state.releaseHold, 'turn');
  assert.equal(state.messageId, null);
});
