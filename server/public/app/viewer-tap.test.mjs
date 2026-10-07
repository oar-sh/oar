import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTapRecognizer,
  DOUBLE_TAP_WINDOW_MS,
  TAP_MAX_DURATION_MS,
  TAP_MAX_MOVE_PX,
} from './viewer-tap.mjs';

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
  };
}

function make(options = {}) {
  const clock = fakeClock();
  const taps = [];
  const recognizer = createTapRecognizer({
    onTap: (point) => taps.push(point),
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    ...options,
  });
  return { clock, taps, recognizer };
}

const ev = (type, { id = 1, x = 100, y = 100, t = 0, target = null } = {}) => (
  { type, pointerId: id, clientX: x, clientY: y, timeStamp: t, target }
);

test('a quick, still pointer is a tap, reported once the double-tap window has passed', () => {
  const { clock, taps, recognizer } = make();
  recognizer.handle(ev('pointerdown', { t: 0 }));
  recognizer.handle(ev('pointerup', { t: 80, x: 103, y: 98 }));
  assert.equal(taps.length, 0, 'held back for a possible second tap');
  clock.advance(DOUBLE_TAP_WINDOW_MS - 1);
  assert.equal(taps.length, 0);
  clock.advance(1);
  assert.deepEqual(taps, [{ clientX: 103, clientY: 98 }]);
});

test('a second pointer within the window swallows the tap (a double tap zooms instead)', () => {
  const { clock, taps, recognizer } = make();
  recognizer.handle(ev('pointerdown', { t: 0 }));
  recognizer.handle(ev('pointerup', { t: 60 }));
  recognizer.handle(ev('pointerdown', { t: 200 }));
  recognizer.handle(ev('pointerup', { t: 260 }));
  clock.advance(DOUBLE_TAP_WINDOW_MS * 3);
  assert.equal(taps.length, 0);
});

test('moving too far, holding too long, or a pinch is not a tap', () => {
  const { clock, taps, recognizer } = make();
  // A drag.
  recognizer.handle(ev('pointerdown', { t: 0 }));
  recognizer.handle(ev('pointermove', { t: 30, x: 100 + TAP_MAX_MOVE_PX + 1 }));
  recognizer.handle(ev('pointerup', { t: 60, x: 100 + TAP_MAX_MOVE_PX + 1 }));
  clock.advance(DOUBLE_TAP_WINDOW_MS * 2);
  assert.equal(taps.length, 0);
  // A long press.
  recognizer.handle(ev('pointerdown', { t: 1000 }));
  recognizer.handle(ev('pointerup', { t: 1000 + TAP_MAX_DURATION_MS + 1 }));
  clock.advance(DOUBLE_TAP_WINDOW_MS * 2);
  assert.equal(taps.length, 0);
  // A pinch: a second pointer joins before the first lifts.
  recognizer.handle(ev('pointerdown', { id: 1, t: 2000 }));
  recognizer.handle(ev('pointerdown', { id: 2, t: 2010, x: 200 }));
  recognizer.handle(ev('pointerup', { id: 2, t: 2100, x: 220 }));
  recognizer.handle(ev('pointerup', { id: 1, t: 2110 }));
  clock.advance(DOUBLE_TAP_WINDOW_MS * 2);
  assert.equal(taps.length, 0);
  // And the recognizer is clean again afterwards.
  recognizer.handle(ev('pointerdown', { t: 3000 }));
  recognizer.handle(ev('pointerup', { t: 3050 }));
  clock.advance(DOUBLE_TAP_WINDOW_MS);
  assert.equal(taps.length, 1);
});

test('a pointer that lands on a control, or ends a text selection, is left alone', () => {
  const { clock, taps, recognizer } = make({
    isInteractive: (target) => target === 'button',
    hasSelection: () => selectionActive,
  });
  let selectionActive = false;
  recognizer.handle(ev('pointerdown', { t: 0, target: 'button' }));
  recognizer.handle(ev('pointerup', { t: 50, target: 'button' }));
  clock.advance(DOUBLE_TAP_WINDOW_MS);
  assert.equal(taps.length, 0);

  selectionActive = true;
  recognizer.handle(ev('pointerdown', { t: 100 }));
  recognizer.handle(ev('pointerup', { t: 150 }));
  clock.advance(DOUBLE_TAP_WINDOW_MS);
  assert.equal(taps.length, 0);
});

test('a cancelled pointer and cancel() both drop the tap in flight', () => {
  const { clock, taps, recognizer } = make();
  recognizer.handle(ev('pointerdown', { t: 0 }));
  recognizer.handle(ev('pointercancel', { t: 50 }));
  clock.advance(DOUBLE_TAP_WINDOW_MS);
  assert.equal(taps.length, 0);

  recognizer.handle(ev('pointerdown', { t: 100 }));
  recognizer.handle(ev('pointerup', { t: 150 }));
  recognizer.cancel();
  clock.advance(DOUBLE_TAP_WINDOW_MS);
  assert.equal(taps.length, 0);
});
