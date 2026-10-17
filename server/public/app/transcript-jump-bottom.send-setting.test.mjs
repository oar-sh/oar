import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCROLL_ON_SEND_STORAGE_KEY,
  SCROLL_ON_SEND_TOGGLE_ID,
  isScrollOnSendEnabled,
  parseScrollOnSendSetting,
  serializeScrollOnSendSetting,
  syncScrollOnSendToggle,
  updateScrollOnSendSetting,
} from './transcript-jump-bottom.mjs';

function fakeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    values,
  };
}

function fakeDocument() {
  const checkbox = { checked: null };
  return { checkbox, getElementById: (id) => (id === SCROLL_ON_SEND_TOGGLE_ID ? checkbox : null) };
}

test('the setting is on unless it was switched off', () => {
  assert.equal(parseScrollOnSendSetting(null), true);
  assert.equal(parseScrollOnSendSetting(undefined), true);
  assert.equal(parseScrollOnSendSetting(''), true);
  assert.equal(parseScrollOnSendSetting('1'), true);
  assert.equal(parseScrollOnSendSetting('true'), true);
  assert.equal(parseScrollOnSendSetting('garbage'), true);
  assert.equal(parseScrollOnSendSetting('0'), false);
  assert.equal(parseScrollOnSendSetting(' FALSE '), false);
});

test('what is stored reads back as it was set', () => {
  assert.equal(serializeScrollOnSendSetting(true), '1');
  assert.equal(serializeScrollOnSendSetting(false), '0');
  for (const value of [true, false]) {
    assert.equal(parseScrollOnSendSetting(serializeScrollOnSendSetting(value)), value);
  }
});

test('a browser that never saw the setting has it on, and stores nothing by reading it', () => {
  const store = fakeStore();
  assert.equal(isScrollOnSendEnabled(store), true);
  assert.equal(store.values.size, 0);
});

test('switching it off is stored under its key, survives a new read and ticks the checkbox off', () => {
  const store = fakeStore();
  const doc = fakeDocument();
  updateScrollOnSendSetting(false, { doc, store });
  assert.equal(store.values.get(SCROLL_ON_SEND_STORAGE_KEY), '0');
  assert.equal(isScrollOnSendEnabled(store), false);
  assert.equal(doc.checkbox.checked, false);

  // A reload: a fresh checkbox, the same storage.
  const reloaded = fakeDocument();
  syncScrollOnSendToggle(reloaded, store);
  assert.equal(reloaded.checkbox.checked, false);

  updateScrollOnSendSetting(true, { doc: reloaded, store });
  assert.equal(store.values.get(SCROLL_ON_SEND_STORAGE_KEY), '1');
  assert.equal(isScrollOnSendEnabled(store), true);
  assert.equal(reloaded.checkbox.checked, true);
});

test('storage that throws (private mode, a blocked origin) leaves the setting on', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const doc = fakeDocument();
  assert.equal(isScrollOnSendEnabled(broken), true);
  assert.doesNotThrow(() => updateScrollOnSendSetting(false, { doc, store: broken }));
  assert.equal(doc.checkbox.checked, true);
});

test('a page without the settings dialog is left alone', () => {
  assert.doesNotThrow(() => syncScrollOnSendToggle({ getElementById: () => null }, fakeStore()));
  assert.doesNotThrow(() => syncScrollOnSendToggle(null, fakeStore()));
});
