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
