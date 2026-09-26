import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import {
  DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES,
  formatBackgroundTaskTimeoutLabel,
} from '../../../shared/background-task-timeout.mjs';

// Until the relay's value loads, and for good if that request fails, the
// Background task timeout slider shows the markup and the settings modal's
// own starting state. Both must be the default the relay enforces: they used
// to read "No limit" while 4 hours was enforced. Rendered against the real
// index.html; JSDOM does not execute the page's <script> tags.
const indexHtml = await readFile(
  fileURLToPath(new URL('../index.html', import.meta.url)),
  'utf8',
);
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const { refreshBackgroundTaskTimeoutSetting } = await import('./settings-modal.js');

const DEFAULT_VALUE = String(DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES);
const DEFAULT_LABEL = formatBackgroundTaskTimeoutLabel(DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES);
const slider = () => document.getElementById('background-task-timeout-slider');
const label = () => document.getElementById('background-task-timeout-value');

test('the slider markup starts at the shared default', () => {
  assert.equal(slider().value, DEFAULT_VALUE);
  assert.equal(label().textContent, DEFAULT_LABEL);
});

test('the slider shows the shared default while the setting loads and after the load fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  let failLoad = null;
  t.mock.method(globalThis, 'fetch', () => new Promise((_resolve, reject) => { failLoad = reject; }));

  const refreshed = refreshBackgroundTaskTimeoutSetting();
  assert.equal(typeof failLoad, 'function', 'the load is in flight');
  assert.equal(slider().value, DEFAULT_VALUE);
  assert.equal(label().textContent, DEFAULT_LABEL);

  failLoad(new Error('relay unreachable'));
  await refreshed;
  assert.equal(slider().value, DEFAULT_VALUE);
  assert.equal(label().textContent, DEFAULT_LABEL);
});
