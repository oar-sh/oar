import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { MENU_SEPARATOR, bindLongPress, closeContextMenu, openContextMenu } from './context-menu.mjs';

const dom = new JSDOM('<!doctype html><body><div id="list"><div class="row" data-id="a">A</div><div class="row" data-id="b">B</div></div></body>', { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
window.innerWidth = 400;
window.innerHeight = 800;

const menu = () => document.querySelector('.context-menu');
const items = () => [...document.querySelectorAll('.context-menu-item')].map((item) => item.textContent);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a menu shows its entries, separators and danger items; a click runs the entry and closes it', async () => {
  const picked = [];
  openContextMenu(10, 20, [
    { id: 'open', label: 'Open', onSelect: () => picked.push('open') },
    MENU_SEPARATOR,
    { id: 'delete', label: 'Delete', danger: true, onSelect: () => picked.push('delete') },
    { id: 'stop', label: 'Stop', disabled: true, onSelect: () => picked.push('stop') },
  ]);
  assert.ok(menu());
  assert.deepEqual(items(), ['Open', 'Delete', 'Stop']);
  assert.equal(document.querySelectorAll('.context-menu-sep').length, 1);
  assert.equal(document.querySelector('[data-menu-item="delete"]').classList.contains('context-menu-item-danger'), true);
  assert.equal(document.querySelector('[data-menu-item="stop"]').disabled, true);
  await tick();
  assert.equal(document.activeElement, document.querySelector('[data-menu-item="open"]'), 'the first entry has focus');

  document.querySelector('[data-menu-item="delete"]').click();
  assert.deepEqual(picked, ['delete']);
  assert.equal(menu(), null);
});

test('only one menu is open; Escape and a pointer-down outside close it, one inside does not', () => {
  openContextMenu(10, 20, [{ label: 'One', onSelect() {} }]);
  openContextMenu(30, 40, [{ label: 'Two', onSelect() {} }]);
  assert.deepEqual(items(), ['Two']);

  menu().dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  assert.ok(menu(), 'inside: stays');
  document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  assert.equal(menu(), null, 'outside: closed');

  openContextMenu(10, 20, [{ label: 'Three', onSelect() {} }]);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(menu(), null);

  openContextMenu(10, 20, [{ label: 'Four', onSelect() {} }]);
  closeContextMenu();
  assert.equal(menu(), null);
});

test('a menu near the edge is kept on screen', () => {
  const node = openContextMenu(395, 795, [{ label: 'Edge', onSelect() {} }]);
  // JSDOM measures nothing, so the box is 0×0: the menu sits at the margin.
  assert.equal(node.style.left, '395px');
  assert.equal(node.style.top, '795px');
  closeContextMenu();
  const far = openContextMenu(5000, 5000, [{ label: 'Far', onSelect() {} }]);
  assert.equal(far.style.left, '396px');
  assert.equal(far.style.top, '796px');
  closeContextMenu();
});

test('a long press on a touch pointer fires after the delay unless the finger moves or lifts; a mouse never does', () => {
  const list = document.getElementById('list');
  const fired = [];
  const timers = [];
  bindLongPress(list, '.row', (row, x, y) => fired.push([row.dataset.id, x, y]), {
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutImpl: (id) => { timers[id - 1] = null; },
  });
  const rowA = list.querySelector('[data-id="a"]');
  const press = (target, type, pointerType, x = 10, y = 10) => target.dispatchEvent(
    new window.PointerEvent(type, { bubbles: true, pointerType, clientX: x, clientY: y }),
  );

  press(rowA, 'pointerdown', 'touch', 12, 34);
  assert.equal(timers.filter(Boolean).length, 1);
  timers[0]();
  assert.deepEqual(fired, [['a', 12, 34]]);

  // Moved: cancelled. Lifted: cancelled.
  press(rowA, 'pointerdown', 'touch');
  press(rowA, 'pointermove', 'touch', 40, 10);
  assert.equal(timers.at(-1), null);
  press(rowA, 'pointerdown', 'touch');
  press(rowA, 'pointerup', 'touch');
  assert.equal(timers.at(-1), null);

  // A mouse pointer is left to the contextmenu event.
  const before = timers.length;
  press(rowA, 'pointerdown', 'mouse');
  assert.equal(timers.length, before);
  assert.deepEqual(fired, [['a', 12, 34]]);
});

test('a lifting long press opens on release without a move, offers a move as a drag, and swallows the release click', () => {
  const dom2 = new JSDOM('<!doctype html><body><div id="list"><div class="row" data-id="a">A</div></div></body>', { url: 'http://localhost/' });
  const win = dom2.window;
  const list = win.document.getElementById('list');
  const row = list.querySelector('.row');
  const log = [];
  const timers = [];
  let clock = 1000;
  let takeMoves = true;
  let liftable = true;
  bindLongPress(list, '.row', (target, x, y) => log.push(['menu', target.dataset.id, x, y]), {
    setTimeoutImpl: (fn) => { timers.push(fn); return timers.length; },
    clearTimeoutImpl: (id) => { timers[id - 1] = null; },
    now: () => clock,
    lift: {
      canLift: () => liftable,
      onLift: (target, x, y) => log.push(['lift', target.dataset.id, x, y]),
      onMove: (target, x, y, event) => { log.push(['move', target.dataset.id, x, y, event.clientY]); return takeMoves; },
      onEnd: (target) => log.push(['end', target.dataset.id]),
    },
  });
  const press = (type, x = 10, y = 10, pointerType = 'touch') => row.dispatchEvent(
    new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerType, clientX: x, clientY: y }),
  );
  const clickRow = (detail = 1) => {
    const event = new win.MouseEvent('click', { bubbles: true, cancelable: true, detail });
    row.dispatchEvent(event);
    return event.defaultPrevented;
  };

  // Held, then released in place: lifted at the delay, the menu on release.
  press('pointerdown', 12, 34);
  timers.at(-1)();
  assert.deepEqual(log, [['lift', 'a', 12, 34]], 'nothing opens at the delay');
  press('pointermove', 15, 38);
  assert.equal(log.length, 1, 'a move inside the slop does nothing');
  press('pointerup', 15, 38);
  assert.deepEqual(log.slice(1), [['end', 'a'], ['menu', 'a', 12, 34]]);
  assert.equal(clickRow(0), false, 'a keyboard click is never swallowed');
  assert.equal(clickRow(), true, 'the click of that release is swallowed');
  assert.equal(clickRow(), false, 'only that one');
  // A new press right after the release is the user's: its click goes through.
  press('pointerdown', 12, 34);
  press('pointerup', 12, 34);
  assert.equal(clickRow(), false);
  press('pointerdown', 12, 34);
  timers.at(-1)();
  press('pointerup', 12, 34);
  press('pointerdown', 50, 50, 'mouse');
  assert.equal(clickRow(), false, 'a mouse press ends the guard too');
  clock += 1000;

  // Held, then moved: the move is offered, taken, and the release opens nothing.
  log.length = 0;
  press('pointerdown', 10, 10);
  timers.at(-1)();
  press('pointermove', 10, 40);
  assert.deepEqual(log, [['lift', 'a', 10, 10], ['move', 'a', 10, 10, 40]]);
  press('pointerup', 10, 40);
  assert.equal(log.length, 2, 'no menu, no end: the drag owns the gesture');
  assert.equal(clickRow(), false);

  // A move that is not taken (drag off) keeps the press lifted: the release opens the menu.
  log.length = 0;
  takeMoves = false;
  press('pointerdown', 10, 10);
  timers.at(-1)();
  press('pointermove', 10, 60);
  press('pointerup', 10, 60);
  assert.deepEqual(log.map(([kind]) => kind), ['lift', 'move', 'end', 'menu']);
  takeMoves = true;
  clock += 1000;

  // Moved before the delay: a scroll, nothing fires; a lift later is not owed.
  log.length = 0;
  press('pointerdown', 10, 10);
  press('pointermove', 10, 40);
  assert.equal(timers.at(-1), null, 'the timer is cancelled');
  press('pointerup', 10, 40);
  assert.deepEqual(log, []);
  assert.equal(clickRow(), false);

  // A cancel while lifted still opens the menu; a cancel before the delay does not.
  press('pointerdown', 10, 10);
  timers.at(-1)();
  press('pointercancel', 10, 10);
  assert.deepEqual(log.map(([kind]) => kind), ['lift', 'end', 'menu']);
  log.length = 0;
  press('pointerdown', 10, 10);
  press('pointercancel', 10, 10);
  assert.equal(timers.at(-1), null);
  assert.deepEqual(log, []);

  // A browser contextmenu during a touch press is swallowed; one without a press is not.
  press('pointerdown', 10, 10);
  const during = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  let reached = false;
  list.addEventListener('contextmenu', () => { reached = true; });
  row.dispatchEvent(during);
  assert.equal(during.defaultPrevented, true);
  assert.equal(reached, false, 'the list\'s own handler does not see it');
  press('pointerup', 10, 10);
  const later = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  row.dispatchEvent(later);
  assert.equal(reached, true);

  // A row that cannot lift keeps the plain long press: the menu at the delay, a move cancels it.
  log.length = 0;
  liftable = false;
  press('pointerdown', 12, 34);
  timers.at(-1)();
  assert.deepEqual(log, [['menu', 'a', 12, 34]]);
  press('pointerup', 12, 34);
  assert.deepEqual(log, [['menu', 'a', 12, 34]], 'nothing more on release');
  press('pointerdown', 10, 10);
  press('pointermove', 10, 40);
  assert.equal(timers.at(-1), null);
  liftable = true;

  // A page sent to the background ends a lifted press without a menu.
  log.length = 0;
  let hidden = false;
  Object.defineProperty(win.document, 'hidden', { configurable: true, get: () => hidden });
  press('pointerdown', 10, 10);
  timers.at(-1)();
  hidden = true;
  win.document.dispatchEvent(new win.Event('visibilitychange'));
  press('pointercancel', 10, 10);
  assert.deepEqual(log.map(([kind]) => kind), ['lift', 'end']);
  hidden = false;

  // A mouse is left to the real contextmenu.
  const before = timers.length;
  press('pointerdown', 10, 10, 'mouse');
  assert.equal(timers.length, before);
});
