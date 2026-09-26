import test from 'node:test';
import assert from 'node:assert/strict';

// The session worker state the status poll installs on the store: the
// heartbeat steering snapshot's `supported` opt-in and `cancellableIds` ride
// it (composer gate, pushed rows' Cancel), and both take part in the change
// hash so a flip in either re-derives the UI.
//
// store.js touches window/document at import time — the same browser-global
// stub the other store-importing suites install.
globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { clientHeight: 0 },
  addEventListener() {},
  getElementById() { return { addEventListener() {} }; },
};
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };

const {
  setSessionWorkerStatesFromStatusPayload,
  getSessionWorkerState,
  applySessionWorkerSteering,
} = await import('./store.js');

const worker = (steering, extra = {}) => ({ sdkSessionId: 'sess-1', status: 'processing', pid: 4242, workerId: 'w-1', updatedAt: '2026-09-25T10:00:00.000Z', steering, ...extra });

test('a Copilot SDK worker snapshot carries supported and cancellableIds; the Claude 4-field shape normalizes them away', () => {
  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({
    turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: [' u2 ', 'u3', ''],
  })] }), true);
  assert.deepEqual(getSessionWorkerState('sess-1').steering, {
    turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: ['u2', 'u3'],
  });

  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({
    turnActive: true, canSteer: false, holdReason: 'question', messageId: 'u1',
  })] }), true);
  assert.deepEqual(getSessionWorkerState('sess-1').steering, {
    turnActive: true, canSteer: false, holdReason: 'question', messageId: 'u1', supported: false, cancellableIds: [],
  });

  // Not-quite-boolean / not-quite-array inputs degrade, never throw.
  setSessionWorkerStatesFromStatusPayload({ workers: [worker({ turnActive: true, canSteer: true, supported: 'yes', cancellableIds: 'u2' })] });
  assert.deepEqual(getSessionWorkerState('sess-1').steering.cancellableIds, []);
  assert.equal(getSessionWorkerState('sess-1').steering.supported, false);

  // No snapshot at all.
  setSessionWorkerStatesFromStatusPayload({ workers: [worker(null)] });
  assert.equal(getSessionWorkerState('sess-1').steering, null);
});

test('the change hash covers supported and cancellableIds, so a flip in either counts as a new payload', () => {
  const base = { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: ['u2'] };
  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker(base)] }), true);
  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({ ...base })] }), false, 'identical payload: no change');

  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({ ...base, cancellableIds: ['u2', 'u3'] })] }), true, 'a row became cancellable');
  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({ ...base, cancellableIds: ['u3'] })] }), true, 'a row was consumed');
  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({ ...base, cancellableIds: [] })] }), true, 'the set emptied');
  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({ ...base, cancellableIds: [] })] }), false);

  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({ ...base, cancellableIds: [], supported: false })] }), true, 'the opt-in flipped');
  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [worker({ ...base, cancellableIds: [], supported: false })] }), false);
  assert.equal(getSessionWorkerState('sess-1').steering.supported, false);
});

test('a broadcast snapshot patches the known entry in place and takes part in the change hash', () => {
  setSessionWorkerStatesFromStatusPayload({ workers: [worker(null), { ...worker(null), sdkSessionId: 'sess-2' }] });
  const snapshot = { turnActive: false, canSteer: false, holdReason: null, messageId: null, supported: true, cancellableIds: [' u2 '] };

  assert.equal(applySessionWorkerSteering('sess-1', snapshot), true);
  assert.deepEqual(getSessionWorkerState('sess-1').steering, { ...snapshot, cancellableIds: ['u2'] });
  // Everything else on the entry, and every other entry, is untouched.
  assert.equal(getSessionWorkerState('sess-1').pid, 4242);
  assert.equal(getSessionWorkerState('sess-1').status, 'processing');
  assert.equal(getSessionWorkerState('sess-2').steering, null);

  assert.equal(applySessionWorkerSteering('sess-1', { ...snapshot }), false, 'the same snapshot again is no change');
  // The next poll carrying the same state is no change either: the hash moved
  // with the patch.
  assert.equal(setSessionWorkerStatesFromStatusPayload({ workers: [
    worker({ ...snapshot }),
    { ...worker(null), sdkSessionId: 'sess-2' },
  ] }), false);

  assert.equal(applySessionWorkerSteering('sess-1', null), true, 'a cleared snapshot is a change');
  assert.equal(getSessionWorkerState('sess-1').steering, null);

  // An entry the client has not seen yet cannot be patched: the caller
  // refreshes the whole status instead.
  assert.equal(applySessionWorkerSteering('sess-unknown', snapshot), null);
  assert.equal(getSessionWorkerState('sess-unknown'), null);
  assert.equal(applySessionWorkerSteering('', snapshot), null);
});
