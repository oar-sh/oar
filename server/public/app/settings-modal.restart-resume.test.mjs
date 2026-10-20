import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// "After a relay restart, tell interrupted sessions to carry on" in
// Settings › General: off in the markup and until the relay says otherwise;
// a change posts `{ enabled }`. Rendered against the real index.html.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLInputElement = dom.window.HTMLInputElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const { refreshRestartResumeSetting, updateRestartResumeSettingFromToggle } = await import('./settings-modal.js');

const toggle = () => document.getElementById('restart-resume-toggle');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('the toggle sits in Settings › General, off by default', () => {
  assert.ok(toggle().closest('#settings-panel-general'), 'in the General tab');
  assert.equal(toggle().checked, false);
  assert.match(document.querySelector('label[for="restart-resume-toggle"]').textContent, /After a relay restart, tell interrupted sessions to carry on/);
});

test('it stays off when the setting does not load', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('relay unreachable'); });
  await refreshRestartResumeSetting();
  assert.equal(toggle().checked, false);
});

test('the relay\'s value lands on the toggle, and a change posts it', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (options.method === 'POST') return jsonResponse({ enabled: calls.at(-1).body.enabled, default: false });
    return jsonResponse({ enabled: true, default: false });
  });
  await refreshRestartResumeSetting();
  assert.equal(toggle().checked, true);
  await updateRestartResumeSettingFromToggle(false);
  const post = calls.find((call) => call.method === 'POST');
  assert.match(post.url, /\/api\/settings\/restart-resume$/);
  assert.deepEqual(post.body, { enabled: false });
  assert.equal(toggle().checked, false);
  assert.equal(toggle().disabled, false);
});
