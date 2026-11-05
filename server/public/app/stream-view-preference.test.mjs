import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STREAM_VIEW_CHANGE_EVENT,
  STREAM_VIEW_STORAGE_KEY,
  STREAM_VIEW_TOGGLE_ID,
  isStreamViewEnabled,
  parseStreamViewSetting,
  serializeStreamViewSetting,
  syncStreamViewToggle,
  updateStreamViewSetting,
} from './stream-view-preference.mjs';

function fakeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    values,
  };
}

function fakeButton(value) {
  const classes = new Set();
  const attributes = new Map();
  return {
    dataset: { streamView: value },
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    setAttribute: (name, v) => attributes.set(name, v),
    getAttribute: (name) => attributes.get(name),
  };
}

function fakeDocument() {
  const checkbox = { checked: null };
  const buttons = [fakeButton('on'), fakeButton('off')];
  return {
    checkbox,
    buttons,
    getElementById: (id) => (id === STREAM_VIEW_TOGGLE_ID ? checkbox : null),
    querySelectorAll: (selector) => (selector.includes('.ctx-stream-view-btn') ? buttons : []),
  };
}

test('the stream view is off unless switched on', () => {
  for (const stored of [null, undefined, '', '0', 'false', 'garbage']) assert.equal(parseStreamViewSetting(stored), false, String(stored));
  assert.equal(parseStreamViewSetting('1'), true);
  assert.equal(parseStreamViewSetting(' TRUE '), true);
  for (const value of [true, false]) assert.equal(parseStreamViewSetting(serializeStreamViewSetting(value)), value);
  const store = fakeStore();
  assert.equal(isStreamViewEnabled(store), false);
  assert.equal(store.values.size, 0, 'reading stores nothing');
});

test('switching it on is stored, syncs the checkbox and the 🧠 buttons, and tells the page once', () => {
  const store = fakeStore();
  const doc = fakeDocument();
  const events = [];
  const target = { dispatchEvent: (event) => events.push(event) };
  updateStreamViewSetting(true, { doc, store, target });
  assert.equal(store.values.get(STREAM_VIEW_STORAGE_KEY), '1');
  assert.equal(doc.checkbox.checked, true);
  assert.equal(doc.buttons[0].getAttribute('aria-pressed'), 'true');
  assert.equal(doc.buttons[1].classList.contains('is-active'), false);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, STREAM_VIEW_CHANGE_EVENT);
  assert.deepEqual(events[0].detail, { on: true });
  // The same value again changes nothing, so the page does not re-render.
  updateStreamViewSetting(true, { doc, store, target });
  assert.equal(events.length, 1);
  updateStreamViewSetting(false, { doc, store, target });
  assert.equal(events.length, 2);
  assert.equal(doc.checkbox.checked, false);
});

test('storage that throws reads off; a page without the controls is left alone', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(isStreamViewEnabled(broken), false);
  assert.doesNotThrow(() => updateStreamViewSetting(true, { doc: fakeDocument(), store: broken, target: null }));
  assert.doesNotThrow(() => syncStreamViewToggle(null, fakeStore()));
});
