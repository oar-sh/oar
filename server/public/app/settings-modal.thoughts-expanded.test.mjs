import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// "Expand thoughts while an agent works" in Settings › Appearance,
// and its mirror in the 🧠 modal. Rendered against the real index.html.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
const { document } = dom.window;
globalThis.CustomEvent = dom.window.CustomEvent;

const {
  THOUGHTS_EXPANDED_CHANGE_EVENT,
  THOUGHTS_EXPANDED_STORAGE_KEY,
  isThoughtsExpanded,
  syncThoughtsExpandedToggle,
  updateThoughtsExpandedSetting,
} = await import('./thoughts-preference.mjs');
const { renderThoughtsPreferenceHtml } = await import('./context-usage-view.mjs');

const toggle = () => document.getElementById('thoughts-expanded-toggle');
const store = dom.window.localStorage;

test('the toggle sits in Settings › Appearance, on by default', () => {
  assert.equal(document.querySelectorAll('#settings-modal [id="thoughts-expanded-toggle"]').length, 1);
  assert.equal(toggle().closest('[data-settings-panel]')?.id, 'settings-panel-appearance');
  assert.equal(toggle().type, 'checkbox');
  assert.equal(toggle().checked, true);
  assert.equal(toggle().getAttribute('onchange'), 'updateThoughtsExpandedSetting(this.checked)');
  assert.equal(document.querySelector('label[for="thoughts-expanded-toggle"]').textContent, 'Expand thoughts while an agent works');
  const help = toggle().closest('.settings-row').nextElementSibling;
  assert.ok(help.classList.contains('settings-help'));
  assert.match(help.textContent, /live turn, in sub-agent bubbles and in the sub-agent viewer\.$/);
});

test('it comes after text scaling and before the Suspend host row', () => {
  const following = dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
  const fontScale = document.getElementById('font-scale-select');
  const suspend = document.getElementById('show-suspend-host-toggle');
  assert.ok(fontScale.compareDocumentPosition(toggle()) & following);
  assert.ok(toggle().compareDocumentPosition(suspend) & following);
});

test('the Settings toggle and the 🧠 row stay in step while both are shown', () => {
  store.clear();
  const body = document.getElementById('summary-modal-body');
  body.innerHTML = renderThoughtsPreferenceHtml({ expanded: isThoughtsExpanded(store) });
  const pressed = () => body.querySelector('.ctx-thoughts-btn[aria-pressed="true"]')?.dataset.thoughtsExpanded;
  const events = [];
  dom.window.addEventListener(THOUGHTS_EXPANDED_CHANGE_EVENT, (event) => events.push(event.detail.expanded));

  // The 🧠 button: Collapsed.
  updateThoughtsExpandedSetting(false, { doc: document, store, target: dom.window });
  assert.equal(store.getItem(THOUGHTS_EXPANDED_STORAGE_KEY), '0');
  assert.equal(toggle().checked, false);
  assert.equal(pressed(), 'off');
  assert.equal(body.querySelectorAll('.ctx-thoughts-btn.is-active').length, 1);

  // The Settings checkbox: on again.
  updateThoughtsExpandedSetting(true, { doc: document, store, target: dom.window });
  assert.equal(toggle().checked, true);
  assert.equal(pressed(), 'on');
  assert.deepEqual(events, [false, true]);

  // A fresh open reads the stored value.
  store.setItem(THOUGHTS_EXPANDED_STORAGE_KEY, '0');
  toggle().checked = true;
  syncThoughtsExpandedToggle(document, store);
  assert.equal(toggle().checked, false);
  assert.equal(pressed(), 'off');
  store.clear();
});
