import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// "Tool lines shown while an agent works" in Settings › Appearance.
// Rendered against the real index.html.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
const { document } = dom.window;
const store = dom.window.localStorage;

const { LIVE_ACTIVITY_CAP_STORAGE_KEY, syncLiveActivityCapSlider, updateLiveActivityCap } = await import('./live-activity-cap.mjs');

const slider = () => document.getElementById('live-activity-cap-slider');
const value = () => document.getElementById('live-activity-cap-value');

test('the slider sits in Settings › Appearance at 50 lines, 10…500 plus no limit', () => {
  assert.equal(document.querySelectorAll('#settings-modal [id="live-activity-cap-slider"]').length, 1);
  assert.equal(slider().closest('[data-settings-panel]')?.id, 'settings-panel-appearance');
  assert.equal(slider().type, 'range');
  assert.equal(slider().min, '10');
  assert.equal(slider().max, '510');
  assert.equal(slider().step, '10');
  assert.equal(slider().value, '50');
  assert.equal(value().textContent, '50 lines');
  assert.equal(slider().getAttribute('oninput'), 'previewLiveActivityCap(this.value)');
  assert.equal(slider().getAttribute('onchange'), 'updateLiveActivityCap(this.value)');
  assert.match(document.querySelector('label[for="live-activity-cap-slider"]').textContent, /^Tool lines shown while an agent works/);
  const help = slider().closest('.settings-row').nextElementSibling;
  assert.ok(help.classList.contains('settings-help'));
  assert.match(help.textContent, /^Per agent: the main agent and each sub-agent keep this many of their newest tool lines/);
  assert.match(help.textContent, /The relay keeps up to 500 per agent\.$/);
});

test('it comes after the thoughts toggle and before the Suspend host row', () => {
  const following = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(document.getElementById('thoughts-expanded-toggle').compareDocumentPosition(slider()) & following);
  assert.ok(slider().compareDocumentPosition(document.getElementById('show-suspend-host-toggle')) & following);
});

test('a stored value shows on open; a change is stored', () => {
  store.setItem(LIVE_ACTIVITY_CAP_STORAGE_KEY, '0');
  syncLiveActivityCapSlider(document, store);
  assert.equal(slider().value, '510');
  assert.equal(value().textContent, 'No limit');
  updateLiveActivityCap('120', { doc: document, store });
  assert.equal(store.getItem(LIVE_ACTIVITY_CAP_STORAGE_KEY), '120');
  assert.equal(value().textContent, '120 lines');
  store.clear();
});
