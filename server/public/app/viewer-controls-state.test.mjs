import test from 'node:test';
import assert from 'node:assert/strict';

import { createControlsState, CONTROLS_AUTO_HIDE_MS } from './viewer-controls-state.mjs';

// A hand-driven clock: timers fire only when the test advances time.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at > now) continue;
        pending.delete(id);
        entry.fn();
      }
    },
    get pendingCount() { return pending.size; },
  };
}

function make(options = {}) {
  const clock = fakeClock();
  const changes = [];
  const controls = createControlsState({
    onChange: (visible) => changes.push(visible),
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    ...options,
  });
  return { clock, changes, controls };
}

test('controls start visible and a tap toggles them, with no clock for still content', () => {
  const { clock, changes, controls } = make();
  assert.equal(controls.visible, true);
  controls.toggle();
  assert.equal(controls.visible, false);
  controls.toggle();
  assert.equal(controls.visible, true);
  clock.advance(CONTROLS_AUTO_HIDE_MS * 10);
  assert.equal(controls.visible, true, 'an image never hides its controls by itself');
  assert.deepEqual(changes, [false, true]);
});

test('while media plays the controls fade after the auto-hide delay', () => {
  const { clock, controls } = make();
  controls.setPlaying(true);
  clock.advance(CONTROLS_AUTO_HIDE_MS - 1);
  assert.equal(controls.visible, true);
  clock.advance(1);
  assert.equal(controls.visible, false);
});

test('an interaction keeps the controls up and restarts the clock', () => {
  const { clock, controls } = make();
  controls.setPlaying(true);
  clock.advance(CONTROLS_AUTO_HIDE_MS - 500);
  controls.interaction();
  clock.advance(CONTROLS_AUTO_HIDE_MS - 500);
  assert.equal(controls.visible, true, 'the clock was restarted by the interaction');
  clock.advance(500);
  assert.equal(controls.visible, false);
  controls.interaction();
  assert.equal(controls.visible, true, 'an interaction on hidden controls shows them');
});

test('a tap during playback shows the controls and they fade again; pausing pins them', () => {
  const { clock, controls } = make();
  controls.setPlaying(true);
  clock.advance(CONTROLS_AUTO_HIDE_MS);
  assert.equal(controls.visible, false);
  controls.toggle();
  assert.equal(controls.visible, true);
  clock.advance(CONTROLS_AUTO_HIDE_MS);
  assert.equal(controls.visible, false, 'still playing, so they fade once more');
  controls.setPlaying(false);
  assert.equal(controls.visible, true, 'a paused player is never left bare');
  clock.advance(CONTROLS_AUTO_HIDE_MS * 2);
  assert.equal(controls.visible, true);
  assert.equal(clock.pendingCount, 0);
});

test('hiding by hand cancels the clock, and reset returns to the opening state', () => {
  const { clock, controls } = make();
  controls.setPlaying(true);
  controls.hide();
  assert.equal(clock.pendingCount, 0);
  controls.reset();
  assert.equal(controls.visible, true);
  assert.equal(controls.playing, false);
  clock.advance(CONTROLS_AUTO_HIDE_MS * 2);
  assert.equal(controls.visible, true);
});

test('the auto-hide delay can be chosen', () => {
  const { clock, controls } = make({ autoHideMs: 100 });
  controls.setPlaying(true);
  clock.advance(99);
  assert.equal(controls.visible, true);
  clock.advance(1);
  assert.equal(controls.visible, false);
});
