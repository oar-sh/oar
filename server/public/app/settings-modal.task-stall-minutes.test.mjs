import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  DEFAULT_TASK_STALL_MINUTES,
  TASK_STALL_MINUTES_MAX,
  TASK_STALL_MINUTES_MIN,
} from '../../../shared/task-output-text.mjs';

// "Mark a background task as quiet after" in Settings › General: the markup
// and the modal's starting state show the relay's default until its value
// loads (and after that request fails); a loaded value and its bounds land on
// the slider; a change posts `{ minutes }`. Rendered against the real
// index.html; JSDOM does not execute the page's <script> tags.
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
  refreshTaskStallMinutesSetting,
  updateTaskStallMinutesSetting,
  previewTaskStallMinutesSetting,
} = await import('./settings-modal.js');

const slider = () => document.getElementById('task-stall-minutes-slider');
const label = () => document.getElementById('task-stall-minutes-value');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('the slider sits in Settings › General and its markup starts at the relay default and bounds', () => {
  assert.ok(slider().closest('#settings-panel-general'), 'in the General tab');
  assert.equal(slider().value, String(DEFAULT_TASK_STALL_MINUTES));
  assert.equal(slider().min, String(TASK_STALL_MINUTES_MIN));
  assert.equal(slider().max, String(TASK_STALL_MINUTES_MAX));
  assert.equal(label().textContent, `${DEFAULT_TASK_STALL_MINUTES} min`);
  assert.match(document.querySelector('label[for="task-stall-minutes-slider"]').textContent, /Mark a background task as quiet after/);
});

test('the slider shows the default while the setting loads and after the load fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  let failLoad = null;
  t.mock.method(globalThis, 'fetch', () => new Promise((_resolve, reject) => { failLoad = reject; }));
  const refreshed = refreshTaskStallMinutesSetting();
  assert.equal(typeof failLoad, 'function', 'the load is in flight');
  assert.equal(slider().value, String(DEFAULT_TASK_STALL_MINUTES));
  failLoad(new Error('relay unreachable'));
  await refreshed;
  assert.equal(slider().value, String(DEFAULT_TASK_STALL_MINUTES));
  assert.equal(label().textContent, `${DEFAULT_TASK_STALL_MINUTES} min`);
});

test('a loaded value lands on the slider, and a change posts the minutes', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (options.method === 'POST') return jsonResponse({ minutes: 25, min: 1, max: 120, default: 10 });
    return jsonResponse({ minutes: 15, min: 1, max: 120, default: 10 });
  });
  await refreshTaskStallMinutesSetting();
  assert.equal(slider().value, '15');
  assert.equal(label().textContent, '15 min');

  previewTaskStallMinutesSetting('40');
  assert.equal(label().textContent, '40 min', 'dragging only moves the label');
  await updateTaskStallMinutesSetting('25');
  const post = calls.find((call) => call.method === 'POST');
  assert.match(post.url, /\/api\/settings\/task-stall-minutes$/);
  assert.deepEqual(post.body, { minutes: 25 });
  assert.equal(slider().value, '25');
  assert.equal(slider().disabled, false);
});
