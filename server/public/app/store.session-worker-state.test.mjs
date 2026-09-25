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

const { setSessionWorkerStatesFromStatusPayload, getSessionWorkerState } = await import('./store.js');

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
