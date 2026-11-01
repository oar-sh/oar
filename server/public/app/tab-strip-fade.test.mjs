import test from 'node:test';
import assert from 'node:assert/strict';

const { tabStripFadeState, syncTabStripFade, revealTab } = await import('./tab-strip-fade.mjs');

test('the fade follows the scroll: right at the start, both between, left at the end, none when it fits', () => {
  assert.equal(tabStripFadeState({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }), '');
  assert.equal(tabStripFadeState({ scrollLeft: 0, scrollWidth: 300.6, clientWidth: 300 }), '', 'a sub-pixel overflow fits');
  assert.equal(tabStripFadeState({ scrollLeft: 0, scrollWidth: 400, clientWidth: 300 }), 'right');
  assert.equal(tabStripFadeState({ scrollLeft: 50, scrollWidth: 400, clientWidth: 300 }), 'both');
  assert.equal(tabStripFadeState({ scrollLeft: 100, scrollWidth: 400, clientWidth: 300 }), 'left');
  assert.equal(tabStripFadeState({ scrollLeft: 99.4, scrollWidth: 400, clientWidth: 300 }), 'left', 'a zoomed end counts');
  assert.equal(tabStripFadeState({ scrollLeft: 0, scrollWidth: 0, clientWidth: 0 }), '', 'not laid out');
});

// A strip of tabs `widths` wide each, `gap` apart, `clientWidth` wide.
function fakeStrip({ clientWidth, widths, gap = 4, fade = 44 }) {
  const attributes = new Map();
  const lefts = [];
  let x = 0;
  for (const width of widths) {
    lefts.push(x);
    x += width + gap;
  }
  const strip = {
    clientWidth,
    clientLeft: 0,
    scrollWidth: x - gap,
    scrollLeft: 0,
    fade,
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (name, value) => attributes.set(name, String(value)),
    hasAttribute: (name) => attributes.has(name),
    removeAttribute: (name) => attributes.delete(name),
    getBoundingClientRect: () => ({ left: 0, width: clientWidth }),
    contains: (node) => tabs.includes(node),
  };
  const tabs = widths.map((width, index) => ({
    getBoundingClientRect: () => ({ left: lefts[index] - strip.scrollLeft, width }),
  }));
  return { strip, tabs };
}

test('a chosen tab is scrolled whole into view, clear of the fade; at an end the strip stops there', () => {
  globalThis.getComputedStyle = (element) => ({ scrollPaddingLeft: `${element.fade}px` });
  const { strip, tabs } = fakeStrip({ clientWidth: 300, widths: [80, 80, 80, 80, 80, 80] });
  // The last tab: to the end, and only the left edge fades.
  revealTab(strip, tabs[5]);
  assert.equal(strip.scrollLeft, strip.scrollWidth - strip.clientWidth);
  assert.equal(strip.getAttribute('data-fade'), 'left');
  // One in the middle, cut by the left fade: it moves right of it.
  revealTab(strip, tabs[2]);
  const box = tabs[2].getBoundingClientRect();
  assert.equal(box.left, 44);
  assert.equal(strip.getAttribute('data-fade'), 'both');
  // Already clear: nothing moves.
  const before = strip.scrollLeft;
  revealTab(strip, tabs[3]);
  assert.equal(strip.scrollLeft, before);
  // The first: back to the start.
  revealTab(strip, tabs[0]);
  assert.equal(strip.scrollLeft, 0);
  assert.equal(strip.getAttribute('data-fade'), 'right');
});

test('a strip that fits loses its mark', () => {
  const { strip } = fakeStrip({ clientWidth: 300, widths: [80, 80] });
  strip.setAttribute('data-fade', 'right');
  assert.equal(syncTabStripFade(strip), '');
  assert.equal(strip.hasAttribute('data-fade'), false);
});
