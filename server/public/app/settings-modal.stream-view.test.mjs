import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// "Stream view" in Settings › Appearance, and its 🧠 mirror.
// Rendered against the real index.html.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
const { document } = dom.window;
globalThis.CustomEvent = dom.window.CustomEvent;
const store = dom.window.localStorage;

const { STREAM_VIEW_STORAGE_KEY, isStreamViewEnabled, updateStreamViewSetting } = await import('./stream-view-preference.mjs');
const { renderStreamViewPreferenceHtml, renderThoughtsPreferenceHtml } = await import('./context-usage-view.mjs');
const { syncThoughtsExpandedToggle, isThoughtsExpanded } = await import('./thoughts-preference.mjs');

const toggle = () => document.getElementById('stream-view-toggle');

test('the toggle sits in Settings › Appearance, off by default, with its help line', () => {
  assert.equal(document.querySelectorAll('#settings-modal [id="stream-view-toggle"]').length, 1);
  assert.equal(toggle().closest('[data-settings-panel]')?.id, 'settings-panel-appearance');
  assert.equal(toggle().type, 'checkbox');
  assert.equal(toggle().checked, false);
  assert.equal(toggle().getAttribute('onchange'), 'updateStreamViewSetting(this.checked)');
  assert.equal(document.querySelector('label[for="stream-view-toggle"]').textContent, 'Stream view: thoughts, tool calls and the reply in order');
  const help = toggle().closest('.settings-row').nextElementSibling;
  assert.equal(help.textContent, 'Turns recorded before this version keep the grouped layout.');
  const following = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
  assert.ok(document.getElementById('live-activity-cap-slider').compareDocumentPosition(toggle()) & following);
  assert.ok(toggle().compareDocumentPosition(document.getElementById('show-suspend-host-toggle')) & following);
});

test('the 🧠 row and the Settings toggle stay in step; the thoughts row is not touched', () => {
  store.clear();
  const body = document.getElementById('summary-modal-body');
  body.innerHTML = renderThoughtsPreferenceHtml({ expanded: isThoughtsExpanded(store) })
    + renderStreamViewPreferenceHtml({ on: isStreamViewEnabled(store) });
  const pressed = (selector) => body.querySelector(`${selector}[aria-pressed="true"]`);
  assert.equal(pressed('.ctx-stream-view-btn').dataset.streamView, 'off');
  assert.match(body.querySelector('.ctx-stream-view').textContent, /🧵 Stream view/);

  updateStreamViewSetting(true, { doc: document, store, target: dom.window });
  assert.equal(store.getItem(STREAM_VIEW_STORAGE_KEY), '1');
  assert.equal(toggle().checked, true);
  assert.equal(pressed('.ctx-stream-view-btn').dataset.streamView, 'on');
  // The thoughts row's buttons share the look, not the setting.
  syncThoughtsExpandedToggle(document, store);
  assert.equal(pressed('.ctx-thoughts-btn[data-thoughts-expanded]').dataset.thoughtsExpanded, 'on');
  assert.equal(body.querySelectorAll('.ctx-stream-view-btn.is-active').length, 1);
  store.clear();
});
