import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHART_WINDOW_STORAGE_KEY,
  applyChartWindow,
  normalizeChartWindow,
  readChartWindow,
  storeChartWindow,
} from './plan-usage-chart-window.mjs';

function fakeStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const throwing = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
};

test('the window is 7, 30 or 90, as a number or its text; anything else is none', () => {
  assert.deepEqual([7, 30, 90, '7', ' 90 '].map(normalizeChartWindow), [7, 30, 90, 7, 90]);
  for (const value of [0, 31, 30.5, '30d', '', null, undefined, Number.NaN, {}, '1e1']) {
    assert.equal(normalizeChartWindow(value), null, String(value));
  }
});

// The tests below run in order: nothing is picked on this page until the second.
test('read: the stored window, else 30 while nothing was picked; no storage or a broken one is never an error', () => {
  assert.equal(readChartWindow(fakeStorage()), 30);
  assert.equal(readChartWindow(fakeStorage({ [CHART_WINDOW_STORAGE_KEY]: '90' })), 90);
  assert.equal(readChartWindow(fakeStorage({ [CHART_WINDOW_STORAGE_KEY]: 'week' })), 30);
  assert.equal(readChartWindow(fakeStorage({ [CHART_WINDOW_STORAGE_KEY]: '31' })), 30);
  assert.equal(readChartWindow(null), 30);
  assert.equal(readChartWindow(throwing), 30);
  assert.equal(CHART_WINDOW_STORAGE_KEY, 'oar.usage.chartWindow.v1');
});

test('store: the storage keeps the pick, and without a working one the page still does', () => {
  const storage = fakeStorage();
  assert.equal(storeChartWindow(7, storage), true);
  assert.equal(storage.values.get(CHART_WINDOW_STORAGE_KEY), '7');
  assert.equal(readChartWindow(storage), 7);
  assert.equal(storeChartWindow(45, storage), false);
  assert.equal(readChartWindow(storage), 7);
  // Stored: the storage answers (another tab may have picked since).
  assert.equal(readChartWindow(fakeStorage({ [CHART_WINDOW_STORAGE_KEY]: '30' })), 30);
  // A pick the storage did not take (none, or a full one that keeps the
  // value before): the page's pick, not 30 and not the old value.
  assert.equal(storeChartWindow(90, null), false);
  assert.equal(readChartWindow(null), 90);
  assert.equal(readChartWindow(throwing), 90);
  assert.equal(readChartWindow(storage), 90);
  assert.equal(storeChartWindow(7, throwing), false);
  assert.equal(readChartWindow(throwing), 7);
  assert.equal(readChartWindow(fakeStorage({ [CHART_WINDOW_STORAGE_KEY]: '30' })), 7);
  // Stored again: the storage answers again.
  assert.equal(storeChartWindow(30, storage), true);
  assert.equal(readChartWindow(fakeStorage({ [CHART_WINDOW_STORAGE_KEY]: '90' })), 90);
});

// Just what applyChartWindow touches: blocks, their radios and their windowed elements.
function fakeElement(attributes = {}) {
  const attrs = new Map(Object.entries(attributes));
  return {
    hidden: attrs.has('hidden'),
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => attrs.set(name, String(value)),
  };
}

function fakeBlock(windows, { emptyWindows = [] } = {}) {
  const inputs = [7, 30, 90].map((days) => ({ value: String(days), checked: days === 30 }));
  const windowed = [
    ...windows.map((days) => fakeElement({ 'data-window': String(days), ...(days === 30 ? {} : { hidden: '' }) })),
    ...emptyWindows.map((days) => fakeElement({ 'data-window': String(days), hidden: '' })),
  ];
  const block = fakeElement({ 'data-chart-window': '30' });
  block.inputs = inputs;
  block.windowed = windowed;
  block.querySelectorAll = (selector) => (selector === '.plan-usage-chart-window input' ? inputs : (selector === '[data-window]' ? windowed : []));
  return block;
}

test('apply: every block gets the window, its radio checked, the other windows hidden', () => {
  const grok = fakeBlock([7, 7, 30, 30, 90, 90]);
  const cursor = fakeBlock([30, 30, 90, 90], { emptyWindows: [7] });
  const root = { querySelectorAll: (selector) => (selector === '.plan-usage-charts' ? [grok, cursor] : []) };
  assert.equal(applyChartWindow(root, 7), 7);
  for (const block of [grok, cursor]) {
    assert.equal(block.getAttribute('data-chart-window'), '7');
    assert.deepEqual(block.inputs.map((input) => input.checked), [true, false, false]);
  }
  assert.deepEqual(grok.windowed.map((element) => element.hidden), [false, false, true, true, true, true]);
  // The card without a 7-day chart shows its "no turns" line instead.
  assert.deepEqual(cursor.windowed.map((element) => element.hidden), [true, true, true, true, false]);
  // A bad window applies 30; no root is no error.
  assert.equal(applyChartWindow(root, 'x'), 30);
  assert.deepEqual(grok.windowed.map((element) => element.hidden), [true, true, false, false, true, true]);
  assert.equal(applyChartWindow(null, 90), 90);
});
