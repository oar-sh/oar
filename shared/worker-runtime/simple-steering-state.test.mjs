import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSimpleSteeringState } from './simple-steering-state.mjs';
import { normalizeWorkerSteeringSnapshot } from '../../server/services/session-worker-registry-service.mjs';

const idle = {
  turnActive: false,
  canSteer: false,
  holdReason: null,
  messageId: null,
  supported: false,
  cancellableIds: [],
  releasable: true,
  releaseHold: null,
  backgroundTaskCount: 0,
};

test('an idle worker is releasable and offers no steering', () => {
  assert.deepEqual(buildSimpleSteeringState(), idle);
  assert.deepEqual(buildSimpleSteeringState({ activeAttempt: null, turnActive: false, backgroundTaskCount: 0 }), idle);
});

test('an active attempt is a turn that holds the release, and names its row', () => {
  assert.deepEqual(buildSimpleSteeringState({ activeAttempt: { id: 'q-1', attemptId: 'a-1' } }), {
    ...idle,
    turnActive: true,
    messageId: 'q-1',
    releasable: false,
    releaseHold: 'turn',
  });
});

test('a turn the runner reports without a row id still holds the release', () => {
  const state = buildSimpleSteeringState({ turnActive: true });
  assert.equal(state.turnActive, true);
  assert.equal(state.messageId, null);
  assert.equal(state.releasable, false);
  assert.equal(state.releaseHold, 'turn');
});

test('live background work holds the release between turns and is counted; a turn comes first', () => {
  assert.deepEqual(buildSimpleSteeringState({ backgroundTaskCount: 2 }), {
    ...idle,
    releasable: false,
    releaseHold: 'background',
    backgroundTaskCount: 2,
  });
  const both = buildSimpleSteeringState({ activeAttempt: { id: 'q-1' }, backgroundTaskCount: 1 });
  assert.equal(both.releaseHold, 'turn');
  assert.equal(both.backgroundTaskCount, 1);
});

test('a count that is not a positive whole number counts as none', () => {
  for (const value of [undefined, null, -1, 1.5, Number.NaN, '3x']) {
    const state = buildSimpleSteeringState({ backgroundTaskCount: value });
    assert.equal(state.backgroundTaskCount, 0, String(value));
    assert.equal(state.releasable, true, String(value));
  }
});

test('the relay keeps every field as the worker sent it', () => {
  for (const state of [
    buildSimpleSteeringState(),
    buildSimpleSteeringState({ activeAttempt: { id: 'q-1' } }),
    buildSimpleSteeringState({ backgroundTaskCount: 3 }),
  ]) {
    assert.deepEqual(normalizeWorkerSteeringSnapshot(state), state);
  }
});
