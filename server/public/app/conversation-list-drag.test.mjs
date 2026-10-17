import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { bindConversationListDrag, conversationRowKey } from './conversation-list-drag.mjs';

// The pointer side of the sidebar drag on a small list in JSDOM. JSDOM lays
// nothing out, so every row gets a box: 38 px tall, one every 40 px, in a
// list 200 × 400 at the viewport's corner. Names are invented.
const dom = new JSDOM(`<!doctype html><body><div id="conv-list">
  <div class="conv-item conv-group-head" data-conversation-id="c-lead" data-group-id="g-alpha"><div class="conv-title">Lead</div><button class="conv-archive">A</button></div>
  <div class="conv-item conv-group-member" data-conversation-id="c-m1" data-group-id="g-alpha"><div class="conv-title">One</div></div>
  <div class="conv-item conv-group-member" data-conversation-id="c-m2" data-group-id="g-alpha"><div class="conv-title">Two</div><span class="conv-group-summary" data-open-waiting="c-m2" role="button">pill</span></div>
  <div class="conv-item" data-conversation-id="c-solo"><div class="conv-title">Solo</div></div>
  <div class="conv-item conv-group-head conv-group-synthetic" data-group-id="g-folded"><div class="conv-title">Folded</div></div>
  <div class="conv-item" data-conversation-id="c-solo-2"><div class="conv-title">Solo two</div></div>
</div></body>`, { url: 'http://localhost/' });
const { window } = dom;
const { document } = window;
const list = document.getElementById('conv-list');
const ROW_PITCH = 40;
const ROW_HEIGHT = 38;
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
list.getBoundingClientRect = () => rect(0, 0, 200, 400);
let scrollTop = 0;
Object.defineProperty(list, 'scrollTop', { get: () => scrollTop, set: (value) => { scrollTop = Math.max(0, Math.min(200, value)); } });
const layout = () => {
  [...list.querySelectorAll('.conv-item')].forEach((row, index) => {
    row.getBoundingClientRect = () => rect(0, index * ROW_PITCH - scrollTop, 200, ROW_HEIGHT);
  });
};
layout();
const frames = [];
window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
window.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
let vibrated = 0;
Object.defineProperty(window.navigator, 'vibrate', { value: () => { vibrated += 1; return true; }, configurable: true });

const items = () => [
  { key: 'c-lead', kind: 'head', conversationId: 'c-lead', groupId: 'g-alpha', open: true, memberIds: ['c-m1', 'c-m2'] },
  { key: 'c-m1', kind: 'member', conversationId: 'c-m1', groupId: 'g-alpha' },
  { key: 'c-m2', kind: 'member', conversationId: 'c-m2', groupId: 'g-alpha' },
  { key: 'c-solo', kind: 'row', conversationId: 'c-solo', groupId: null },
  { key: 'group:g-folded', kind: 'head', conversationId: null, groupId: 'g-folded', open: false, memberIds: ['c-f1'] },
  { key: 'c-solo-2', kind: 'row', conversationId: 'c-solo-2', groupId: null },
];
const log = { holds: [], drops: [], opens: [], rerenders: 0 };
let enabled = true;
const drag = bindConversationListDrag(list, {
  isEnabled: () => enabled,
  describeItems: items,
  onHold: (held) => log.holds.push(held),
  rerender: () => { log.rerenders += 1; layout(); },
  setDragOpen: (groupId, open) => log.opens.push([groupId, open]),
  onDrop: (result, id) => log.drops.push([id, result.action, result.groupId, result.beforeConversationId]),
  documentRef: document,
  windowRef: window,
  releaseFallbackMs: 0,
});
/** A held list is let go a moment after a release (after its click). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const reset = () => {
  log.holds.length = 0;
  log.drops.length = 0;
  log.opens.length = 0;
  log.rerenders = 0;
};

const row = (key) => list.querySelector(key.startsWith('group:') ? `[data-group-id="${key.slice(6)}"].conv-group-synthetic` : `[data-conversation-id="${key}"]`);
/** The y of a point at `fraction` of row `index`'s height. */
const yIn = (index, fraction) => index * ROW_PITCH - scrollTop + ROW_HEIGHT * fraction;
const pointer = (target, type, { x = 50, y = 0, pointerType = 'mouse', buttons = 1, button = 0, pointerId = 1 } = {}) => {
  const event = new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType, buttons, button, pointerId });
  target.dispatchEvent(event);
  return event;
};
const marks = () => [...list.querySelectorAll('.conv-item')]
  .map((node) => [conversationRowKey(node), [...node.classList].filter((name) => name.startsWith('conv-drop-') || name.startsWith('conv-drag-')).sort().join(' ')])
  .filter(([, names]) => names);
const ghost = () => document.querySelector('.conv-drag-ghost');
const clickSwallowed = (target) => {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

test('the row key is the conversation id, or the group of a synthetic head', () => {
  assert.equal(conversationRowKey(row('c-m1')), 'c-m1');
  assert.equal(conversationRowKey(row('group:g-folded')), 'group:g-folded');
});

test('a mouse drag starts past 4 px, dims the source, follows with a ghost, marks the drop, and drops on release', async () => {
  reset();
  const source = row('c-m2');
  pointer(source, 'pointerdown', { y: yIn(2, 0.5) });
  pointer(source, 'pointermove', { y: yIn(2, 0.5) + 3 });
  assert.equal(ghost(), null, 'not yet');
  assert.deepEqual(log.holds, []);
  pointer(source, 'pointermove', { y: yIn(1, 0.1) });
  assert.ok(ghost(), 'a ghost follows the pointer');
  assert.equal(ghost().getAttribute('aria-hidden'), 'true');
  assert.equal(ghost().querySelector('button'), null, 'without the row\'s buttons');
  assert.equal(ghost().dataset.conversationId, undefined);
  assert.ok(list.classList.contains('conv-list-dragging'));
  assert.deepEqual(log.holds, [true], 're-renders are held');
  assert.deepEqual(marks(), [
    ['c-lead', 'conv-drop-group'],
    ['c-m1', 'conv-drop-before conv-drop-group'],
    ['c-m2', 'conv-drag-source conv-drop-group'],
  ]);
  // Over a loose row's middle: a grouped row leaves (the line, no tint).
  pointer(document, 'pointermove', { y: yIn(3, 0.3) });
  assert.deepEqual(marks(), [['c-m2', 'conv-drag-source'], ['c-solo', 'conv-drop-before']]);
  assert.equal(list.dataset.dropAction, 'leave');
  // Back over the first member and let go.
  pointer(document, 'pointermove', { y: yIn(1, 0.2) });
  pointer(document, 'pointerup', { y: yIn(1, 0.2), buttons: 0 });
  assert.deepEqual(log.drops, [['c-m2', 'reorder', 'g-alpha', 'c-m1']]);
  assert.deepEqual(log.holds, [true, false]);
  assert.equal(ghost(), null);
  assert.deepEqual(marks(), []);
  assert.ok(!list.classList.contains('conv-list-dragging'));
  assert.equal(list.dataset.dropAction, undefined);
  const fromKeyboard = new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 });
  source.dispatchEvent(fromKeyboard);
  assert.equal(fromKeyboard.defaultPrevented, false, 'a keyboard click is never swallowed');
  assert.equal(clickSwallowed(source), true, 'the click that ends a drag opens nothing');
  assert.equal(clickSwallowed(source), false);
  // Right after a cancelled drag, a new press clicks as usual.
  pointer(source, 'pointerdown', { y: yIn(2, 0.5) });
  pointer(source, 'pointermove', { y: yIn(0, 0.5) });
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  pointer(source, 'pointerup', { y: yIn(0, 0.5), buttons: 0 });
  pointer(source, 'pointerdown', { y: yIn(2, 0.5) });
  pointer(source, 'pointerup', { y: yIn(2, 0.5), buttons: 0 });
  assert.equal(clickSwallowed(source), false, 'the new press ended the guard');
  log.holds.length = 0;
});

test('a mouse press on a row button or the pill is not a drag; a press without moving stays a click', () => {
  reset();
  const button = row('c-lead').querySelector('button');
  pointer(button, 'pointerdown', { y: yIn(0, 0.5) });
  pointer(button, 'pointermove', { y: yIn(3, 0.5) });
  assert.equal(ghost(), null);
  pointer(button, 'pointerup', { y: yIn(3, 0.5), buttons: 0 });
  const pill = row('c-m2').querySelector('[data-open-waiting]');
  pointer(pill, 'pointerdown', { y: yIn(2, 0.5) });
  pointer(pill, 'pointermove', { y: yIn(4, 0.5) });
  assert.equal(ghost(), null);
  pointer(pill, 'pointerup', { y: yIn(4, 0.5), buttons: 0 });
  // A right button, or a move with no button held, starts nothing.
  pointer(row('c-solo'), 'pointerdown', { y: yIn(3, 0.5), button: 2, buttons: 2 });
  pointer(row('c-solo'), 'pointermove', { y: yIn(5, 0.5), buttons: 2 });
  assert.equal(ghost(), null);
  pointer(row('c-solo'), 'pointerdown', { y: yIn(3, 0.5) });
  pointer(row('c-solo'), 'pointermove', { y: yIn(5, 0.5), buttons: 0 });
  assert.equal(ghost(), null);
  // A synthetic head carries no conversation: nothing to drag.
  pointer(row('group:g-folded'), 'pointerdown', { y: yIn(4, 0.5) });
  pointer(row('group:g-folded'), 'pointermove', { y: yIn(1, 0.5) });
  assert.equal(ghost(), null);
  pointer(row('group:g-folded'), 'pointerup', { y: yIn(1, 0.5), buttons: 0 });
  assert.equal(clickSwallowed(row('c-solo')), false, 'a plain click goes through');
  assert.deepEqual(log.holds, []);
});

test('a loose row over a loose row\'s middle offers a new group; Escape gives the row back', () => {
  reset();
  pointer(row('c-solo-2'), 'pointerdown', { y: yIn(5, 0.5) });
  pointer(row('c-solo-2'), 'pointermove', { y: yIn(3, 0.5) });
  assert.deepEqual(marks(), [['c-solo', 'conv-drop-new-group'], ['c-solo-2', 'conv-drag-source']]);
  const key = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(key);
  assert.equal(key.defaultPrevented, true);
  assert.equal(ghost(), null);
  assert.deepEqual(marks(), []);
  pointer(document, 'pointerup', { y: yIn(3, 0.5), buttons: 0 });
  assert.deepEqual(log.drops, [], 'a cancelled drag drops nothing');
  assert.deepEqual(log.holds, [true, false]);
});

test('a pointercancel gives the row back; nothing starts while dragging is off', () => {
  reset();
  pointer(row('c-solo'), 'pointerdown', { y: yIn(3, 0.5) });
  pointer(row('c-solo'), 'pointermove', { y: yIn(5, 0.5) });
  assert.ok(ghost());
  pointer(document, 'pointercancel', { y: yIn(5, 0.5) });
  assert.equal(ghost(), null);
  assert.deepEqual(log.drops, []);
  enabled = false;
  pointer(row('c-solo'), 'pointerdown', { y: yIn(3, 0.5) });
  pointer(row('c-solo'), 'pointermove', { y: yIn(5, 0.5) });
  assert.equal(ghost(), null);
  pointer(row('c-solo'), 'pointerup', { y: yIn(5, 0.5), buttons: 0 });
  enabled = true;
});

test('hovering a folded head opens it for the drag, and closes it again unless the row went in', async () => {
  reset();
  pointer(row('c-solo'), 'pointerdown', { y: yIn(3, 0.5) });
  pointer(row('c-solo'), 'pointermove', { y: yIn(4, 0.2) });
  assert.deepEqual(marks(), [['c-solo', 'conv-drag-source'], ['group:g-folded', 'conv-drop-group conv-drop-inside']]);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(log.opens, [['g-folded', true]]);
  assert.equal(log.rerenders, 1);
  assert.ok(row('c-solo').classList.contains('conv-drag-source'), 'the source is marked again after the re-render');
  // Let go elsewhere: the group folds back.
  pointer(document, 'pointermove', { y: yIn(5, 0.5) });
  pointer(document, 'pointerup', { y: yIn(5, 0.5), buttons: 0 });
  assert.deepEqual(log.drops, [['c-solo', 'new-group', null, null]]);
  assert.deepEqual(log.opens, [['g-folded', true], ['g-folded', false]]);

  // Into it: it stays open.
  reset();
  pointer(row('c-solo'), 'pointerdown', { y: yIn(3, 0.5) });
  pointer(row('c-solo'), 'pointermove', { y: yIn(4, 0.2) });
  await new Promise((resolve) => setTimeout(resolve, 650));
  pointer(document, 'pointerup', { y: yIn(4, 0.2), buttons: 0 });
  assert.deepEqual(log.drops, [['c-solo', 'join', 'g-folded', null]]);
  assert.deepEqual(log.opens, [['g-folded', true]]);

  // A head passed over quickly does not open.
  reset();
  pointer(row('c-solo'), 'pointerdown', { y: yIn(3, 0.5) });
  pointer(row('c-solo'), 'pointermove', { y: yIn(4, 0.5) });
  pointer(document, 'pointermove', { y: yIn(5, 0.5) });
  await new Promise((resolve) => setTimeout(resolve, 650));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.deepEqual(log.opens, []);
});

test('the list scrolls by itself near its edges, and the drop target follows', () => {
  reset();
  scrollTop = 0;
  frames.length = 0;
  pointer(row('c-m1'), 'pointerdown', { y: yIn(1, 0.5) });
  pointer(row('c-m1'), 'pointermove', { y: 395 });
  assert.equal(list.dataset.dropAction, 'leave', 'below the last row: out of the group');
  const frame = frames.filter(Boolean).at(-1);
  frame();
  assert.ok(scrollTop > 0, `scrolled down: ${scrollTop}`);
  layout();
  // Near the top it scrolls back up.
  pointer(document, 'pointermove', { y: 2 });
  const before = scrollTop;
  frames.filter(Boolean).at(-1)();
  assert.ok(scrollTop < before, `scrolled up: ${scrollTop}`);
  // In the middle it stays.
  layout();
  pointer(document, 'pointermove', { y: 200 });
  const still = scrollTop;
  frames.filter(Boolean).at(-1)();
  assert.equal(scrollTop, still);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  scrollTop = 0;
  layout();
});

test('touch: a lift holds the list and the finger; a lifted row that moves drags; leaving the list gives it back', async () => {
  reset();
  const lifted = row('c-m1');
  drag.lift(lifted);
  assert.ok(lifted.classList.contains('conv-drag-lifted'));
  assert.equal(vibrated, 1, 'a short buzz');
  assert.deepEqual(log.holds, [true]);
  const move = new window.Event('touchmove', { bubbles: true, cancelable: true });
  lifted.dispatchEvent(move);
  assert.equal(move.defaultPrevented, true, 'the list does not scroll under a lifted row');
  // Taken out of the list by a re-render, the row still keeps the finger.
  const next = lifted.nextSibling;
  lifted.remove();
  const detached = new window.Event('touchmove', { bubbles: true, cancelable: true });
  lifted.querySelector('.conv-title').dispatchEvent(detached);
  assert.equal(detached.defaultPrevented, true, 'the held row guards itself');
  list.insertBefore(lifted, next);
  // Released in place: the long press opens the menu and ends the lift; the
  // list is let go once the release's click had its turn.
  drag.unlift();
  assert.ok(!lifted.classList.contains('conv-drag-lifted'));
  assert.deepEqual(log.holds, [true]);
  await settle();
  assert.deepEqual(log.holds, [true, false]);
  const free = new window.Event('touchmove', { bubbles: true, cancelable: true });
  lifted.dispatchEvent(free);
  assert.equal(free.defaultPrevented, false, 'a plain swipe scrolls');

  // Lifted, then moved: a drag from where the press began.
  reset();
  drag.lift(lifted);
  const started = drag.beginTouchDrag(lifted, 50, yIn(1, 0.5), new window.PointerEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 50, clientY: yIn(2, 0.8) }));
  assert.equal(started, true);
  assert.equal(drag.isActive(), true);
  assert.equal(list.style.touchAction, 'none');
  assert.ok(!lifted.classList.contains('conv-drag-lifted'));
  assert.deepEqual(marks(), [
    ['c-lead', 'conv-drop-group'],
    ['c-m1', 'conv-drag-source conv-drop-group'],
    ['c-m2', 'conv-drop-after conv-drop-group'],
  ]);
  // Another finger's moves are not this drag's.
  pointer(document, 'pointermove', { pointerType: 'touch', pointerId: 9, y: yIn(3, 0.5) });
  assert.deepEqual(marks().find(([key]) => key === 'c-m2'), ['c-m2', 'conv-drop-after conv-drop-group']);
  // Out of the list: the drag ends without a drop.
  pointer(document, 'pointermove', { pointerType: 'touch', pointerId: 7, x: 260, y: yIn(2, 0.5) });
  assert.equal(drag.isActive(), false);
  assert.equal(list.style.touchAction, '');
  assert.deepEqual(log.drops, []);
  assert.deepEqual(log.holds, [true, false]);

  // A touch drag dropped in place does nothing; one dropped elsewhere lands.
  reset();
  drag.lift(lifted);
  drag.beginTouchDrag(lifted, 50, yIn(1, 0.5), new window.PointerEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 50, clientY: yIn(2, 0.8) }));
  pointer(document, 'pointerup', { pointerType: 'touch', pointerId: 7, y: yIn(2, 0.8), buttons: 0 });
  assert.deepEqual(log.drops, [['c-m1', 'reorder', 'g-alpha', null]]);

  // While dragging is off nothing lifts (the long press keeps its old menu),
  // and neither does a synthetic head.
  reset();
  enabled = false;
  assert.equal(drag.canLift(lifted), false);
  assert.equal(drag.lift(lifted), false);
  assert.ok(!lifted.classList.contains('conv-drag-lifted'));
  const unguarded = new window.Event('touchmove', { bubbles: true, cancelable: true });
  lifted.dispatchEvent(unguarded);
  assert.equal(unguarded.defaultPrevented, false, 'the list scrolls');
  assert.equal(drag.beginTouchDrag(lifted, 50, yIn(1, 0.5), new window.PointerEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: 50, clientY: yIn(3, 0.5) })), false);
  assert.equal(ghost(), null);
  assert.deepEqual(log.holds, []);
  enabled = true;
  assert.equal(drag.canLift(lifted), true);
  assert.equal(drag.canLift(row('group:g-folded')), false);
});

test('touch: the list holds still from the touch on; a scroll or a release lets it go after its click', async () => {
  reset();
  const touched = row('c-solo').querySelector('.conv-title');
  pointer(touched, 'pointerdown', { pointerType: 'touch', pointerId: 11, y: yIn(3, 0.5) });
  assert.deepEqual(log.holds, [true], 'held from the touch');
  pointer(touched, 'pointercancel', { pointerType: 'touch', pointerId: 11, y: yIn(3, 0.5) });
  await settle();
  assert.deepEqual(log.holds, [true, false], 'the browser took a scroll: let go');
  // A tap: still held while its click runs, let go after it.
  reset();
  let heldDuringClick = null;
  const probe = () => { heldDuringClick = log.holds.at(-1); };
  touched.addEventListener('click', probe);
  pointer(touched, 'pointerdown', { pointerType: 'touch', pointerId: 15, y: yIn(3, 0.5) });
  pointer(touched, 'pointerup', { pointerType: 'touch', pointerId: 15, y: yIn(3, 0.5), buttons: 0 });
  touched.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  touched.removeEventListener('click', probe);
  assert.equal(heldDuringClick, true, 'the tap\'s click lands on the rows it was made on');
  await settle();
  assert.deepEqual(log.holds, [true, false]);
  // A lift outlives the touch's own release until the long press ends it.
  pointer(touched, 'pointerdown', { pointerType: 'touch', pointerId: 12, y: yIn(3, 0.5) });
  drag.lift(row('c-solo'));
  pointer(touched, 'pointerup', { pointerType: 'touch', pointerId: 12, y: yIn(3, 0.5), buttons: 0 });
  await settle();
  assert.deepEqual(log.holds, [true, false, true], 'still lifted');
  drag.unlift();
  await settle();
  assert.deepEqual(log.holds, [true, false, true, false]);
  // Another finger's release is not this press's.
  pointer(touched, 'pointerdown', { pointerType: 'touch', pointerId: 13, y: yIn(3, 0.5) });
  pointer(document, 'pointerup', { pointerType: 'touch', pointerId: 14, y: yIn(3, 0.5), buttons: 0 });
  await settle();
  assert.equal(log.holds.at(-1), true);
  pointer(document, 'pointerup', { pointerType: 'touch', pointerId: 13, y: yIn(3, 0.5), buttons: 0 });
  await settle();
  assert.equal(log.holds.at(-1), false);
});

test('a page sent to the background ends a drag as a cancel and a held finger without a drop', async () => {
  reset();
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  pointer(row('c-solo'), 'pointerdown', { y: yIn(3, 0.5) });
  pointer(row('c-solo'), 'pointermove', { y: yIn(5, 0.5) });
  assert.ok(ghost());
  hidden = true;
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(ghost(), null);
  assert.equal(drag.isActive(), false);
  assert.deepEqual(log.drops, []);
  assert.deepEqual(log.holds, [true, false]);
  hidden = false;
  pointer(document, 'pointerup', { y: yIn(5, 0.5), buttons: 0 });
  // A finger holding a lifted row: let go at once, no drop.
  reset();
  const touched = row('c-solo');
  pointer(touched, 'pointerdown', { pointerType: 'touch', pointerId: 21, y: yIn(3, 0.5) });
  drag.lift(touched);
  hidden = true;
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.ok(!touched.classList.contains('conv-drag-lifted'));
  assert.deepEqual(log.holds, [true, false]);
  const free = new window.Event('touchmove', { bubbles: true, cancelable: true });
  touched.dispatchEvent(free);
  assert.equal(free.defaultPrevented, false);
  hidden = false;
  delete document.hidden;
});
