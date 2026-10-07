import test from 'node:test';
import assert from 'node:assert/strict';

import { BACK_GUARD_APP, BACK_GUARD_FLOOR, armBackGuardOnFirstInteraction, installBackGuard } from './back-guard.mjs';

// A window that records listeners and can fire events by name.
function fakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); },
    removeEventListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn)); },
    fire(name) { for (const fn of [...(listeners.get(name) || [])]) fn(); },
    count(name) { return (listeners.get(name) || []).length; },
  };
}
import { createViewerHistory, VIEWER_HISTORY_MARK } from './viewer-history.mjs';

// A history whose back() queues the popstate the browser would fire.
function fakeHistory(initialState = null) {
  const entries = [{ state: initialState }];
  let index = 0;
  const pending = [];
  return {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    get index() { return index; },
    pushState(state) { entries.splice(index + 1); entries.push({ state }); index += 1; },
    replaceState(state) { entries[index] = { state }; },
    back() { if (index > 0) { index -= 1; pending.push('popstate'); } else pending.push('left'); },
    flush(...listeners) {
      const out = [];
      while (pending.length) {
        const event = pending.shift();
        if (event === 'left') { out.push('left'); continue; }
        for (const listener of listeners) listener();
      }
      return out;
    },
  };
}

test('installing lays a floor beneath the app entry; back lands on it and the app entry is pushed again', () => {
  const history = fakeHistory();
  let floorHits = 0;
  const guard = installBackGuard({ history, onFloor: () => { floorHits += 1; } });
  assert.equal(history.length, 2);
  assert.deepEqual(history.state, { [BACK_GUARD_APP]: true });

  for (let presses = 0; presses < 3; presses += 1) {
    history.back();
    const left = history.flush(() => guard.onPopState());
    assert.deepEqual(left, [], 'the app is never left');
    assert.equal(history.index, 1);
    assert.deepEqual(history.state, { [BACK_GUARD_APP]: true });
    assert.equal(floorHits, presses + 1, 'each swallowed press is announced, to say "press back again to close"');
  }
});

test('the guard keeps what the entry already held, and installs once across reloads', () => {
  const history = fakeHistory({ kept: 1 });
  installBackGuard({ history });
  assert.deepEqual(history.length, 2);
  // Reloaded on the app entry: nothing is added again.
  installBackGuard({ history });
  assert.equal(history.length, 2);
  history.back();
  history.flush();
  assert.deepEqual(history.state, { kept: 1, [BACK_GUARD_FLOOR]: true });
});

test('the file viewer still closes with back, and only the step out of the app is swallowed', () => {
  const history = fakeHistory();
  const guard = installBackGuard({ history });
  let viewerClosed = 0;
  const viewer = createViewerHistory({ history, onBack: () => { viewerClosed += 1; } });
  const listeners = [() => viewer.onPopState(), () => guard.onPopState()];

  viewer.opened();
  assert.deepEqual(history.state, { [VIEWER_HISTORY_MARK]: true });
  history.back();
  history.flush(...listeners);
  assert.equal(viewerClosed, 1);
  assert.deepEqual(history.state, { [BACK_GUARD_APP]: true }, 'back from the viewer lands on the app, nothing re-pushed');
  assert.equal(history.length, 3, 'the viewer entry stays as a forward entry until replaced');

  history.back();
  const left = history.flush(...listeners);
  assert.deepEqual(left, []);
  assert.deepEqual(history.state, { [BACK_GUARD_APP]: true });
  assert.equal(viewerClosed, 1, 'the viewer is not told again');

  // A hand close of the viewer pops its own entry and leaves the app entry.
  viewer.opened();
  viewer.closed();
  history.flush(...listeners);
  assert.deepEqual(history.state, { [BACK_GUARD_APP]: true });
});

test('armed at the first touch or key, once, and from then on back stays in the app', () => {
  const history = fakeHistory();
  const target = fakeTarget();
  const armed = armBackGuardOnFirstInteraction({ history, target });
  assert.equal(armed.armed, false);
  assert.equal(history.length, 1, 'nothing is laid down at start-up');
  // Back before any interaction leaves, as the browser would have it anyway.
  history.back();
  assert.deepEqual(history.flush(), ['left']);

  target.fire('pointerdown');
  assert.equal(armed.armed, true);
  assert.equal(history.length, 2);
  assert.equal(target.count('pointerdown') + target.count('keydown') + target.count('touchstart'), 0, 'the one-time listeners are gone');
  target.fire('keydown');
  assert.equal(history.length, 2, 'a second interaction arms nothing more');

  history.back();
  const left = history.flush(() => target.fire('popstate'));
  assert.deepEqual(left, []);
  assert.deepEqual(history.state, { [BACK_GUARD_APP]: true });
});

test('not installed where the back button is the browser\'s (a tab, the shared view)', () => {
  const history = fakeHistory();
  assert.equal(installBackGuard({ history, enabled: false }), null);
  assert.equal(history.length, 1);
  assert.equal(installBackGuard({ history: null }), null);
});
