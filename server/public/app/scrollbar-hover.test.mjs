import test from 'node:test';
import assert from 'node:assert/strict';

import { initScrollbarHover, pointerOnScrollbar, SCROLLBAR_WIDE_CLASS } from './scrollbar-hover.mjs';

test('the pointer is on the scrollbar within its width, plus a little reach', () => {
  const rect = { left: 100, right: 500 };
  const on = (clientX, barWidth = 12) => pointerOnScrollbar({ clientX, rect, barWidth });
  assert.equal(on(495), true);
  assert.equal(on(500), true);
  assert.equal(on(488), true);
  assert.equal(on(484), true, 'four pixels of reach left of the scrollbar');
  assert.equal(on(483), false);
  assert.equal(on(501), false);
  assert.equal(on(495, 0), false, 'an area without a scrollbar has none to be on');
});

// A minimal page: one scroll area with a 12 px scrollbar at x 488..500.
function makePage({ canHover = true } = {}) {
  const listeners = new Map();
  const classes = new Set();
  const area = {
    nodeType: 1,
    parentElement: null,
    scrollHeight: 2000,
    clientHeight: 600,
    offsetWidth: 400,
    clientWidth: 388,
    getBoundingClientRect: () => ({ left: 100, right: 500 }),
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
  };
  const doc = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    querySelectorAll: () => (classes.has(SCROLLBAR_WIDE_CLASS) ? [area] : []),
    documentElement: { addEventListener() {}, removeEventListener() {} },
  };
  const win = { matchMedia: () => ({ matches: canHover }) };
  return { area, doc, win, classes, fire: (type, event) => listeners.get(type)?.(event), listeners };
}

test('the scrollbar under the pointer widens and goes back after the linger', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = makePage();
  initScrollbarHover({ doc: page.doc, win: page.win, lingerMs: 2500 });

  page.fire('mousemove', { target: page.area, clientX: 300 });
  assert.equal(page.classes.has(SCROLLBAR_WIDE_CLASS), false, 'the middle of the area is not the scrollbar');

  page.fire('mousemove', { target: page.area, clientX: 494 });
  assert.equal(page.classes.has(SCROLLBAR_WIDE_CLASS), true);

  // Off the scrollbar: it stays wide for the linger, and coming back in time
  // keeps it.
  page.fire('mousemove', { target: page.area, clientX: 300 });
  t.mock.timers.tick(2000);
  assert.equal(page.classes.has(SCROLLBAR_WIDE_CLASS), true);
  page.fire('mousemove', { target: page.area, clientX: 494 });
  t.mock.timers.tick(2400);
  assert.equal(page.classes.has(SCROLLBAR_WIDE_CLASS), true);

  page.fire('mousemove', { target: page.area, clientX: 300 });
  t.mock.timers.tick(1000);
  // Scrolling (a thumb drag) starts the linger again.
  page.fire('scroll', { target: page.area });
  t.mock.timers.tick(2400);
  assert.equal(page.classes.has(SCROLLBAR_WIDE_CLASS), true);
  t.mock.timers.tick(200);
  assert.equal(page.classes.has(SCROLLBAR_WIDE_CLASS), false);
});

test('a device without a hovering fine pointer gets no listeners', () => {
  const page = makePage({ canHover: false });
  initScrollbarHover({ doc: page.doc, win: page.win });
  assert.equal(page.listeners.size, 0);
});
