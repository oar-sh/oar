import test from 'node:test';
import assert from 'node:assert/strict';

import { createSwipeRecognizer, SWIPE_LOCK_PX, SWIPE_THRESHOLD_PX } from './viewer-gestures.mjs';

function make(options = {}) {
  const events = [];
  const recognizer = createSwipeRecognizer({
    onStart: (e) => events.push(['start', e]),
    onMove: (e) => events.push(['move', e]),
    onEnd: (e) => events.push(['end', e]),
    ...options,
  });
  return { events, recognizer };
}

const ev = (type, { id = 1, x = 200, y = 400, t = 0 } = {}) => ({ type, pointerId: id, clientX: x, clientY: y, timeStamp: t });

test('a slow drag past the threshold is a swipe in its direction, and the content followed it', () => {
  const { events, recognizer } = make();
  recognizer.handle(ev('pointerdown', { t: 0 }));
  recognizer.handle(ev('pointermove', { x: 200 - SWIPE_LOCK_PX, t: 50 }));
  recognizer.handle(ev('pointermove', { x: 200 - SWIPE_THRESHOLD_PX - 5, y: 410, t: 900 }));
  recognizer.handle(ev('pointerup', { x: 200 - SWIPE_THRESHOLD_PX - 5, y: 410, t: 1500 }));
  assert.deepEqual(events[0], ['start', { axis: 'x' }]);
  assert.deepEqual(events[1], ['move', { axis: 'x', dx: -SWIPE_LOCK_PX, dy: 0 }]);
  const end = events.at(-1)[1];
  assert.equal(end.axis, 'x');
  assert.equal(end.swipe, 'left');
  assert.equal(end.cancelled, false);
});

test('a short drag springs back, but a quick flick in the same direction counts', () => {
  const { events, recognizer } = make();
  recognizer.handle(ev('pointerdown', { t: 0 }));
  recognizer.handle(ev('pointermove', { x: 230, t: 40 }));
  recognizer.handle(ev('pointerup', { x: 232, t: 400 }));
  assert.equal(events.at(-1)[1].swipe, null, 'short and slow');

  events.length = 0;
  recognizer.handle(ev('pointerdown', { t: 1000 }));
  recognizer.handle(ev('pointermove', { x: 215, t: 1010 }));
  recognizer.handle(ev('pointermove', { x: 245, t: 1040 }));
  recognizer.handle(ev('pointerup', { x: 260, t: 1060 }));
  assert.equal(events.at(-1)[1].swipe, 'right', 'short but fast');
});

test('the axis is locked by the first clear movement, and a disabled axis declines the drag', () => {
  let horizontal = false;
  const { events, recognizer } = make({ horizontalEnabled: () => horizontal, verticalEnabled: () => true });
  // Sideways while sideways is off (an image zoomed in): nothing happens.
  recognizer.handle(ev('pointerdown', { t: 0 }));
  recognizer.handle(ev('pointermove', { x: 300, t: 50 }));
  recognizer.handle(ev('pointerup', { x: 320, t: 100 }));
  assert.equal(events.length, 0);
  // Downwards is on: a swipe down, even if it drifts sideways later.
  recognizer.handle(ev('pointerdown', { t: 200 }));
  recognizer.handle(ev('pointermove', { y: 420, t: 250 }));
  recognizer.handle(ev('pointermove', { x: 300, y: 520, t: 600 }));
  recognizer.handle(ev('pointerup', { x: 300, y: 520, t: 900 }));
  assert.equal(events[0][1].axis, 'y');
  assert.equal(events.at(-1)[1].swipe, 'down');
  horizontal = true;
});

test('a second finger, a pointercancel or cancel() end the drag without a swipe', () => {
  const { events, recognizer } = make();
  recognizer.handle(ev('pointerdown', { id: 1, t: 0 }));
  recognizer.handle(ev('pointermove', { id: 1, x: 260, t: 50 }));
  recognizer.handle(ev('pointerdown', { id: 2, x: 100, t: 60 }));
  assert.deepEqual(events.at(-1)[1], { axis: 'x', dx: 0, dy: 0, swipe: null, cancelled: true });
  recognizer.handle(ev('pointerup', { id: 2, t: 100 }));
  recognizer.handle(ev('pointerup', { id: 1, x: 300, t: 120 }));
  assert.equal(events.length, 3, 'the lifted fingers add nothing');

  events.length = 0;
  recognizer.handle(ev('pointerdown', { t: 500 }));
  recognizer.handle(ev('pointermove', { x: 300, t: 550 }));
  recognizer.handle(ev('pointercancel', { x: 300, t: 560 }));
  assert.equal(events.at(-1)[1].cancelled, true);
  assert.equal(recognizer.active, false);

  events.length = 0;
  recognizer.handle(ev('pointerdown', { t: 1000 }));
  recognizer.handle(ev('pointermove', { x: 300, t: 1050 }));
  assert.equal(recognizer.active, true);
  recognizer.cancel();
  assert.equal(events.at(-1)[1].cancelled, true);
  assert.equal(recognizer.active, false);
});

test('a pointer that may not start (on a control, say) is ignored entirely', () => {
  const { events, recognizer } = make({ canStart: () => false });
  recognizer.handle(ev('pointerdown', { t: 0 }));
  recognizer.handle(ev('pointermove', { x: 400, t: 50 }));
  recognizer.handle(ev('pointerup', { x: 400, t: 100 }));
  assert.equal(events.length, 0);
});
