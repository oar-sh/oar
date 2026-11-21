import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// "Maximum live previews" at the top of Settings › Previews: the markup starts
// at the relay default and the 0..128 range, the label reads "0: no new
// previews" at 0, a loaded value lands on the slider, and a change posts
// `{ maxLive }`. Rendered against the real index.html; JSDOM does not execute
// the page's <script> tags.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const {
  formatPreviewMaxLiveLabel,
  previewPreviewMaxLiveSetting,
  refreshPreviewMaxLiveSetting,
  updatePreviewMaxLiveSetting,
} = await import('./settings-modal.js');

const slider = () => document.getElementById('preview-max-live-slider');
const label = () => document.getElementById('preview-max-live-value');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('the slider is the first setting of the Previews tab, 0 to 128, starting at 8', () => {
  const panel = document.getElementById('settings-panel-previews');
  assert.ok(slider().closest('#settings-panel-previews'), 'in the Previews tab');
  assert.equal(panel.querySelector('input, label'), document.querySelector('label[for="preview-max-live-slider"]'), 'above the list');
  assert.ok(slider().compareDocumentPosition(document.getElementById('settings-previews-list')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(slider().min, '0');
  assert.equal(slider().max, '128');
  assert.equal(slider().step, '1');
  assert.equal(slider().value, '8');
  assert.equal(label().textContent, '8');
  assert.match(document.querySelector('label[for="preview-max-live-slider"]').textContent, /Maximum live previews/);
  assert.equal(slider().getAttribute('oninput'), 'previewPreviewMaxLiveSetting(this.value)');
  assert.equal(slider().getAttribute('onchange'), 'updatePreviewMaxLiveSetting(this.value)');
  assert.equal(window.previewPreviewMaxLiveSetting, previewPreviewMaxLiveSetting, 'the inline handlers resolve');
  assert.equal(window.updatePreviewMaxLiveSetting, updatePreviewMaxLiveSetting);
});

test('the label shows the count, and 0 as no new previews', () => {
  assert.equal(formatPreviewMaxLiveLabel(0), '0: no new previews');
  assert.equal(formatPreviewMaxLiveLabel('0'), '0: no new previews');
  assert.equal(formatPreviewMaxLiveLabel(1), '1');
  assert.equal(formatPreviewMaxLiveLabel(128), '128');
  previewPreviewMaxLiveSetting('0');
  assert.equal(label().textContent, '0: no new previews', 'dragging only moves the label');
});

test('the slider keeps the default when the load fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('relay unreachable'); });
  await refreshPreviewMaxLiveSetting();
  assert.equal(slider().value, '8');
  assert.equal(label().textContent, '8');
});

test('a loaded value lands on the slider, and a change posts the limit', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || 'GET', body });
    if (options.method === 'POST') return jsonResponse({ maxLive: body.maxLive, min: 0, max: 128, default: 8 });
    return jsonResponse({ maxLive: 20, min: 0, max: 128, default: 8 });
  });
  await refreshPreviewMaxLiveSetting();
  assert.equal(slider().value, '20');
  assert.equal(label().textContent, '20');
  assert.match(calls[0].url, /\/api\/settings\/preview-max-live$/);

  await updatePreviewMaxLiveSetting('0');
  const post = calls.find((call) => call.method === 'POST');
  assert.match(post.url, /\/api\/settings\/preview-max-live$/);
  assert.deepEqual(post.body, { maxLive: 0 });
  assert.equal(slider().value, '0');
  assert.equal(label().textContent, '0: no new previews');
  assert.equal(slider().disabled, false);
});
