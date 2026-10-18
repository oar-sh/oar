import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WINDOW_RETENTION_DEFAULT,
  WINDOW_RETENTION_SLIDER_ID,
  WINDOW_RETENTION_STORAGE_KEY,
  WINDOW_RETENTION_UNLIMITED_POSITION,
  WINDOW_RETENTION_VALUE_ID,
  formatWindowRetention,
  parseWindowRetention,
  previewWindowRetention,
  readWindowRetention,
  serializeWindowRetention,
  sliderPositionForWindowRetention,
  syncWindowRetentionSlider,
  updateWindowRetention,
  windowRetentionFromSlider,
} from './conversation-window-retention.mjs';

function fakeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    values,
  };
}

function fakeDocument() {
  const attributes = {};
  const slider = { value: null, setAttribute: (name, value) => { attributes[name] = value; }, attributes };
  const label = { textContent: '' };
  return {
    slider,
    label,
    getElementById: (id) => (id === WINDOW_RETENTION_SLIDER_ID ? slider : (id === WINDOW_RETENTION_VALUE_ID ? label : null)),
  };
}

test('the default is 200, and damaged values fall back to it', () => {
  assert.equal(WINDOW_RETENTION_DEFAULT, 200);
  assert.equal(parseWindowRetention(null), 200);
  assert.equal(parseWindowRetention(''), 200);
  assert.equal(parseWindowRetention('garbage'), 200);
  assert.equal(parseWindowRetention('-5'), 200);
  assert.equal(parseWindowRetention('none'), Infinity);
  assert.equal(parseWindowRetention('700'), 700);
  // Off-step and out-of-range counts snap to the slider's steps.
  assert.equal(parseWindowRetention('260'), 300);
  assert.equal(parseWindowRetention('40'), 100);
  assert.equal(parseWindowRetention('5000'), 1000);
});

test('what is stored reads back as it was set', () => {
  for (const cap of [100, 200, 1000, Infinity]) {
    assert.equal(parseWindowRetention(serializeWindowRetention(cap)), cap);
  }
  assert.equal(serializeWindowRetention(Infinity), 'none');
});

test('the far end of the slider is no limit', () => {
  assert.equal(windowRetentionFromSlider('100'), 100);
  assert.equal(windowRetentionFromSlider(1000), 1000);
  assert.equal(windowRetentionFromSlider(WINDOW_RETENTION_UNLIMITED_POSITION), Infinity);
  assert.equal(sliderPositionForWindowRetention(Infinity), WINDOW_RETENTION_UNLIMITED_POSITION);
  assert.equal(sliderPositionForWindowRetention(400), 400);
  assert.equal(formatWindowRetention(Infinity), 'No limit');
  assert.equal(formatWindowRetention(1000), '1,000 messages');
});

test('a browser that never saw the setting has the default and stores nothing by reading it', () => {
  const store = fakeStore();
  assert.equal(readWindowRetention(store), 200);
  assert.equal(store.values.size, 0);
});

test('moving the slider shows the value; letting go saves it and hands on the cap', () => {
  const store = fakeStore();
  const doc = fakeDocument();
  previewWindowRetention('600', { doc });
  assert.equal(doc.label.textContent, '600 messages');
  assert.equal(doc.slider.attributes['aria-valuetext'], '600 messages');
  assert.equal(store.values.size, 0);

  const caps = [];
  assert.equal(updateWindowRetention(String(WINDOW_RETENTION_UNLIMITED_POSITION), { doc, store, onChange: (cap) => caps.push(cap) }), Infinity);
  assert.equal(store.values.get(WINDOW_RETENTION_STORAGE_KEY), 'none');
  assert.deepEqual(caps, [Infinity]);
  assert.equal(doc.label.textContent, 'No limit');

  const reloaded = fakeDocument();
  syncWindowRetentionSlider(reloaded, store);
  assert.equal(reloaded.slider.value, String(WINDOW_RETENTION_UNLIMITED_POSITION));
  assert.equal(reloaded.slider.attributes['aria-valuetext'], 'No limit');
});

test('storage that throws leaves the default', () => {
  const broken = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
  };
  const doc = fakeDocument();
  assert.equal(readWindowRetention(broken), 200);
  assert.doesNotThrow(() => updateWindowRetention('300', { doc, store: broken }));
  assert.equal(doc.slider.value, '200');
});

test('a page without the settings dialog is left alone', () => {
  assert.doesNotThrow(() => syncWindowRetentionSlider({ getElementById: () => null }, fakeStore()));
  assert.doesNotThrow(() => syncWindowRetentionSlider(null, fakeStore()));
  assert.doesNotThrow(() => previewWindowRetention('300', { doc: null }));
});
