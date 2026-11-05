import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_ACTIVITY_CAP_DEFAULT,
  LIVE_ACTIVITY_CAP_SLIDER_ID,
  LIVE_ACTIVITY_CAP_STORAGE_KEY,
  LIVE_ACTIVITY_CAP_UNLIMITED_POSITION,
  LIVE_ACTIVITY_CAP_VALUE_ID,
  formatLiveActivityCap,
  liveActivityCap,
  liveActivityCapFromSlider,
  parseLiveActivityCap,
  previewLiveActivityCap,
  serializeLiveActivityCap,
  sliderPositionForLiveActivityCap,
  syncLiveActivityCapSlider,
  updateLiveActivityCap,
} from './live-activity-cap.mjs';

function fakeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => { values.set(key, String(value)); },
    values,
  };
}

function fakeDocument() {
  const attributes = new Map();
  const slider = { value: '', setAttribute: (name, value) => attributes.set(name, value), attributes };
  const label = { textContent: '' };
  return {
    slider,
    label,
    getElementById: (id) => (id === LIVE_ACTIVITY_CAP_SLIDER_ID ? slider : id === LIVE_ACTIVITY_CAP_VALUE_ID ? label : null),
  };
}

test('50 lines unless set; 0 means no limit; anything else lands on a step of 10 within 10…500', () => {
  assert.equal(LIVE_ACTIVITY_CAP_DEFAULT, 50);
  for (const stored of [null, undefined, '', 'garbage', '-5']) assert.equal(parseLiveActivityCap(stored), 50, String(stored));
  assert.equal(parseLiveActivityCap('0'), 0);
  assert.equal(parseLiveActivityCap('10'), 10);
  assert.equal(parseLiveActivityCap('3'), 10);
  assert.equal(parseLiveActivityCap('123'), 120);
  assert.equal(parseLiveActivityCap('9000'), 500);
  for (const cap of [10, 50, 240, 500, 0]) assert.equal(parseLiveActivityCap(serializeLiveActivityCap(cap)), cap);
  assert.equal(serializeLiveActivityCap(Number.POSITIVE_INFINITY), '0');
});

test('the slider runs 10…500 by 10 and its last step is no limit', () => {
  assert.equal(LIVE_ACTIVITY_CAP_UNLIMITED_POSITION, 510);
  assert.equal(liveActivityCapFromSlider('10'), 10);
  assert.equal(liveActivityCapFromSlider('500'), 500);
  assert.equal(liveActivityCapFromSlider('510'), 0);
  assert.equal(liveActivityCapFromSlider('x'), 50);
  assert.equal(sliderPositionForLiveActivityCap(0), 510);
  assert.equal(sliderPositionForLiveActivityCap(70), 70);
  assert.equal(formatLiveActivityCap(50), '50 lines');
  assert.equal(formatLiveActivityCap(0), 'No limit');
});

test('a browser that never saw the setting reads 50 and stores nothing', () => {
  const store = fakeStore();
  assert.equal(liveActivityCap(store), 50);
  assert.equal(store.values.size, 0);
});

test('moving the thumb shows the value; letting go stores it and syncs the slider', () => {
  const store = fakeStore();
  const doc = fakeDocument();
  previewLiveActivityCap('510', { doc });
  assert.equal(doc.label.textContent, 'No limit');
  assert.equal(store.values.size, 0, 'a preview saves nothing');

  let seen = null;
  assert.equal(updateLiveActivityCap('10', { doc, store, onChange: (cap) => { seen = cap; } }), 10);
  assert.equal(seen, 10);
  assert.equal(store.values.get(LIVE_ACTIVITY_CAP_STORAGE_KEY), '10');
  assert.equal(doc.slider.value, '10');
  assert.equal(doc.label.textContent, '10 lines');
  assert.equal(doc.slider.attributes.get('aria-valuetext'), '10 lines');

  updateLiveActivityCap('510', { doc, store });
  assert.equal(store.values.get(LIVE_ACTIVITY_CAP_STORAGE_KEY), '0');
  assert.equal(liveActivityCap(store), 0);

  const reloaded = fakeDocument();
  syncLiveActivityCapSlider(reloaded, store);
  assert.equal(reloaded.slider.value, '510');
  assert.equal(reloaded.label.textContent, 'No limit');
});

test('storage that throws reads the default, and a page without the slider is left alone', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(liveActivityCap(broken), 50);
  assert.doesNotThrow(() => updateLiveActivityCap('100', { doc: fakeDocument(), store: broken }));
  assert.doesNotThrow(() => syncLiveActivityCapSlider({ getElementById: () => null }, fakeStore()));
  assert.doesNotThrow(() => syncLiveActivityCapSlider(null, fakeStore()));
});
