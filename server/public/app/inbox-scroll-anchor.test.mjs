import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  captureListAnchor,
  inboxItemKey,
  inboxItemSection,
  restoreListAnchor,
} from './inbox-scroll-anchor.mjs';

// JSDOM lays nothing out, so the list is laid out here: every node with a
// `data-h` is a block of that height, stacked in document order, and the
// scroller shows `VIEW_HEIGHT` pixels of them from `VIEW_TOP` down.
const VIEW_TOP = 100;
const VIEW_HEIGHT = 600;

const dom = new JSDOM('<!doctype html><body></body>');
const { document } = dom.window;

function blocksOf(scroller) {
  return Array.from(scroller.querySelectorAll('[data-h]'));
}

function makeScroller() {
  const scroller = document.createElement('div');
  let scrollTop = 0;
  const contentHeight = () => blocksOf(scroller).reduce((sum, node) => sum + Number(node.dataset.h), 0);
  // Browsers clamp scrollTop to the scrollable range.
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value) => { scrollTop = Math.min(Math.max(0, contentHeight() - VIEW_HEIGHT), Math.max(0, Number(value))); },
  });
  scroller.getBoundingClientRect = () => ({ top: VIEW_TOP, bottom: VIEW_TOP + VIEW_HEIGHT });
  document.body.replaceChildren(scroller);
  return scroller;
}

dom.window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
  const scroller = this.closest('[data-scroller]');
  if (!scroller || this.dataset.h === undefined) return { top: 0, bottom: 0 };
  let offset = 0;
  for (const node of blocksOf(scroller)) {
    if (node === this) break;
    offset += Number(node.dataset.h);
  }
  const top = VIEW_TOP + offset - scroller.scrollTop;
  return { top, bottom: top + Number(this.dataset.h) };
};

function card(id, { status = 'pending', h = 200, relayId = 'self' } = {}) {
  const node = document.createElement('article');
  node.className = 'inbox-item';
  node.dataset.itemId = id;
  if (relayId) node.dataset.relayId = relayId;
  if (status) node.dataset.status = status;
  node.dataset.h = String(h);
  return node;
}

function divider() {
  const node = document.createElement('div');
  node.className = 'inbox-divider';
  node.dataset.h = '30';
  return node;
}

// An Inbox: a filter bar, then this relay's section with its pending cards,
// the divider and its closed cards.
function inbox(scroller, { pending = [], closed = [] }) {
  const section = document.createElement('section');
  section.className = 'inbox-relay';
  section.dataset.relayId = 'self';
  const bar = document.createElement('div');
  bar.dataset.h = '40';
  section.append(bar, ...pending.map((entry) => (typeof entry === 'string' ? card(entry) : entry)));
  if (closed.length) section.append(divider(), ...closed.map((id) => card(id, { status: 'answered' })));
  scroller.replaceChildren(section);
  scroller.dataset.scroller = '1';
}

const topOf = (scroller, id) => scroller.querySelector(`[data-item-id="${id}"]`).getBoundingClientRect().top;

test('captured: the first card reaching into view and the next three, with key, section and offset', () => {
  const scroller = makeScroller();
  inbox(scroller, { pending: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], closed: ['c1'] });
  // a1 spans 40–240 and a2 240–440: at 300, a1 is gone and a2 is cut.
  scroller.scrollTop = 300;
  const anchor = captureListAnchor(scroller);
  assert.equal(anchor.scrollTop, 300);
  assert.deepEqual(anchor.items.map((item) => item.key), ['self\na2', 'self\na3', 'self\na4', 'self\na5']);
  assert.deepEqual(anchor.items.map((item) => item.offset), [-60, 140, 340, 540]);
  assert.equal(anchor.items[0].section, 'self\npending');
});

test('a card added above the reader does not push the text down', () => {
  const scroller = makeScroller();
  inbox(scroller, { pending: ['a1', 'a2', 'a3', 'a4', 'a5'], closed: ['c1'] });
  scroller.scrollTop = 500;
  const before = topOf(scroller, 'a3');
  const anchor = captureListAnchor(scroller);
  // The refresh draws everything anew, with a new ask first.
  inbox(scroller, { pending: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'], closed: ['c1'] });
  scroller.scrollTop = 500;
  assert.equal(restoreListAnchor(scroller, anchor), true);
  assert.equal(topOf(scroller, 'a3'), before);
  assert.equal(scroller.scrollTop, 700);
});

test('a card removed above the reader does not pull the text up', () => {
  const scroller = makeScroller();
  inbox(scroller, { pending: ['a1', 'a2', 'a3', 'a4', 'a5'], closed: ['c1'] });
  scroller.scrollTop = 500;
  const before = topOf(scroller, 'a3');
  const anchor = captureListAnchor(scroller);
  inbox(scroller, { pending: ['a2', 'a3', 'a4', 'a5'], closed: ['c1'] });
  scroller.scrollTop = 500;
  assert.equal(restoreListAnchor(scroller, anchor), true);
  assert.equal(topOf(scroller, 'a3'), before);
});

test('the card the reader is at is answered: it moves away, and the card after it stays put', () => {
  const scroller = makeScroller();
  inbox(scroller, { pending: ['a1', 'a2', 'a3', 'a4', 'a5'], closed: ['c1'] });
  // a2 is the first card the reader sees.
  scroller.scrollTop = 250;
  const next = topOf(scroller, 'a3');
  const anchor = captureListAnchor(scroller);
  assert.equal(anchor.items[0].key, 'self\na2');
  inbox(scroller, { pending: ['a1', 'a3', 'a4', 'a5'], closed: ['a2', 'c1'] });
  scroller.scrollTop = 250;
  assert.equal(restoreListAnchor(scroller, anchor), true);
  assert.equal(topOf(scroller, 'a3'), next);
});

test('none of the captured cards left: the old scrollTop comes back', () => {
  const scroller = makeScroller();
  inbox(scroller, { pending: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] });
  scroller.scrollTop = 450;
  const anchor = captureListAnchor(scroller);
  inbox(scroller, { pending: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] });
  scroller.scrollTop = 0;
  assert.equal(restoreListAnchor(scroller, anchor), false);
  assert.equal(scroller.scrollTop, 450);
});

test('no anchor or no scroller: nothing moves', () => {
  const scroller = makeScroller();
  inbox(scroller, { pending: ['a1', 'a2', 'a3', 'a4'] });
  scroller.scrollTop = 120;
  assert.equal(captureListAnchor(null), null);
  assert.equal(restoreListAnchor(scroller, null), false);
  assert.equal(restoreListAnchor(null, { scrollTop: 0, items: [] }), false);
  assert.equal(scroller.scrollTop, 120);
});

test('a card not drawn (hidden, no box) is skipped when capturing', () => {
  const scroller = makeScroller();
  inbox(scroller, { pending: [card('a1', { h: 0 }), 'a2', 'a3'] });
  scroller.scrollTop = 0;
  const anchor = captureListAnchor(scroller);
  assert.equal(anchor.items[0].key, 'self\na2');
});

test('the section: a card without a status goes by the divider; pending and closed differ', () => {
  const scroller = makeScroller();
  const notice = card('n1', { status: '', relayId: '' });
  inbox(scroller, { pending: ['a1'], closed: ['c1'] });
  scroller.querySelector('.inbox-relay').append(notice);
  assert.equal(inboxItemSection(scroller.querySelector('[data-item-id="a1"]')), 'self\npending');
  assert.equal(inboxItemSection(scroller.querySelector('[data-item-id="c1"]')), 'self\nclosed');
  assert.equal(inboxItemSection(notice), 'self\nclosed');
  assert.equal(inboxItemKey(notice), 'self\nn1');
  assert.equal(inboxItemKey(document.createElement('article')), '');
});

test('generic: the caller names the rows, their keys and their sections', () => {
  const scroller = makeScroller();
  scroller.dataset.scroller = '1';
  const row = (name, group) => {
    const node = document.createElement('li');
    node.className = 'row';
    node.dataset.name = name;
    node.dataset.group = group;
    node.dataset.h = '100';
    return node;
  };
  const options = { keyOf: (node) => node.dataset.name, sectionOf: (node) => node.dataset.group };
  scroller.replaceChildren(...['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'].map((name) => row(name, 'g1')));
  scroller.scrollTop = 200;
  const anchor = captureListAnchor(scroller, '.row', options);
  assert.equal(anchor.items[0].key, 'r3');
  const r4 = () => scroller.querySelector('[data-name="r4"]').getBoundingClientRect().top;
  const before = r4();
  // r3 moved to another group, at the end: r4 holds the place.
  scroller.replaceChildren(...['r1', 'r2', 'r4', 'r5', 'r6', 'r7', 'r8'].map((name) => row(name, 'g1')), row('r3', 'g2'));
  assert.equal(restoreListAnchor(scroller, anchor, '.row', options), true);
  assert.equal(r4(), before);
  assert.equal(scroller.scrollTop, 100);
});
