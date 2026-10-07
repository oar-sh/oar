import test from 'node:test';
import assert from 'node:assert/strict';

import { createViewerHistory, VIEWER_HISTORY_MARK } from './viewer-history.mjs';

// A history with entries and a popstate that fires when back() is called,
// as the browser does (asynchronously there; here on demand via flush()).
function fakeHistory() {
  const entries = [{ state: null }];
  let index = 0;
  const pending = [];
  const h = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state) { entries.splice(index + 1); entries.push({ state }); index += 1; },
    back() { if (index > 0) { index -= 1; pending.push('popstate'); } },
    /** The user pressed the system back button. */
    userBack() { h.back(); },
    flush(listener) { while (pending.length) { pending.shift(); listener(); } },
    get index() { return index; },
  };
  return h;
}

function make() {
  const history = fakeHistory();
  let backs = 0;
  let clock = 1000;
  const viewer = createViewerHistory({ history, onBack: () => { backs += 1; }, now: () => clock });
  return { history, viewer, backs: () => backs, tick: (ms) => { clock += ms; } };
}

test('opening pushes one marked entry, and stepping through files adds no more', () => {
  const { history, viewer } = make();
  viewer.opened();
  viewer.opened();
  viewer.opened();
  assert.equal(history.length, 2);
  assert.deepEqual(history.state, { [VIEWER_HISTORY_MARK]: true });
  assert.equal(viewer.pushed, true);
});

test('the system back gesture closes the viewer and consumes only our entry', () => {
  const { history, viewer, backs } = make();
  viewer.opened();
  history.userBack();
  history.flush(() => viewer.onPopState());
  assert.equal(backs(), 1);
  assert.equal(viewer.pushed, false);
  assert.equal(history.index, 0);
  // The viewer closing in response must not pop anything further.
  viewer.closed();
  assert.equal(history.index, 0);
  // A second back is the app's own business: nothing of ours answers it.
  history.userBack();
  history.flush(() => viewer.onPopState());
  assert.equal(backs(), 1);
});

test('closing by hand takes the entry back out, and the pop it causes is ignored', () => {
  const { history, viewer, backs } = make();
  viewer.opened();
  viewer.closed();
  assert.equal(history.index, 0, 'our entry is gone');
  history.flush(() => viewer.onPopState());
  assert.equal(backs(), 0, 'our own pop closes nothing (the viewer is closed already)');
  // Open again afterwards: a fresh entry, and the back gesture works as before.
  viewer.opened();
  assert.equal(history.index, 1);
  history.userBack();
  history.flush(() => viewer.onPopState());
  assert.equal(backs(), 1);
});

test('a pop that comes long after our own back() is the user\'s', () => {
  const { history, viewer, backs, tick } = make();
  viewer.opened();
  viewer.closed();
  tick(5000);
  viewer.opened();
  history.flush(() => viewer.onPopState()); // the old pop, late
  assert.equal(backs(), 1, 'treated as a real back: the viewer closes');
});

test('closing when the current entry is not ours leaves history alone', () => {
  const { history, viewer } = make();
  viewer.opened();
  history.pushState({ somethingElse: true });
  viewer.closed();
  assert.equal(history.index, 2);
  assert.equal(viewer.pushed, false);
});
