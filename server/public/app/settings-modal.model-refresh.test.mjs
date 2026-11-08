import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// "Check for new models" in Settings › General › Models: the markup starts at
// the relay's defaults (on, every 24 h) until its value loads, and keeps them
// after that request fails; a loaded answer lands on the switch, the interval
// and one "Check <provider>" row per provider with its last check; each
// control posts its own field. Rendered against the real index.html; JSDOM
// does not execute the page's <script> tags.
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
  refreshModelRefreshSettings,
  updateModelRefreshAutoSetting,
  updateModelRefreshIntervalSetting,
  updateModelRefreshProviderSetting,
} = await import('./settings-modal.js');

const toggle = () => document.getElementById('model-refresh-auto-toggle');
const interval = () => document.getElementById('model-refresh-interval-select');
const providerRows = () => [...document.querySelectorAll('#model-refresh-providers .model-refresh-provider-row')];
const providerBox = (id) => document.querySelector(`#model-refresh-providers input[data-model-refresh-provider="${id}"]`);
const providersText = () => document.getElementById('model-refresh-providers').textContent.trim();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const HOUR = 3_600_000;

function answer(overrides = {}) {
  return {
    auto: true,
    intervalHours: 12,
    intervalChoices: [6, 12, 24, 72, 168],
    default: { auto: true, intervalHours: 24 },
    excluded: ['grok'],
    providers: [
      { id: 'cursor', label: 'Cursor', last: { at: new Date(Date.now() - 3 * HOUR).toISOString(), ok: true, error: null } },
      { id: 'grok', label: 'Grok', last: null },
      { id: 'deepseek', label: 'DeepSeek', last: { at: new Date(Date.now() - HOUR).toISOString(), ok: false, error: 'HTTP 503' } },
    ],
    last: {},
    ...overrides,
  };
}

test('the section sits in Settings › General after Turns and tasks, at the relay defaults', () => {
  const section = document.getElementById('settings-section-models');
  assert.ok(section.closest('#settings-panel-general'), 'in the General tab');
  assert.equal(section.previousElementSibling.id, 'settings-section-turns');
  assert.equal(document.getElementById('settings-section-models-title').textContent, 'Models');
  assert.equal(toggle().checked, true);
  assert.match(document.querySelector('label[for="model-refresh-auto-toggle"]').textContent, /Check for new models/);
  assert.equal(interval().value, '24');
  assert.deepEqual([...interval().options].map((option) => [option.value, option.textContent]), [
    ['6', 'Every 6 h'], ['12', 'Every 12 h'], ['24', 'Every 24 h'], ['72', 'Every 3 days'], ['168', 'Every 7 days'],
  ]);
  assert.ok(section.contains(document.getElementById('model-refresh-providers')));
});

test('the defaults stay while the setting loads and after the load fails', async (t) => {
  t.mock.method(console, 'error', () => {});
  let failLoad = null;
  t.mock.method(globalThis, 'fetch', () => new Promise((_resolve, reject) => { failLoad = reject; }));
  const refreshed = refreshModelRefreshSettings();
  assert.equal(typeof failLoad, 'function', 'the load is in flight');
  assert.equal(toggle().checked, true);
  // No answer yet: the provider list says so, it does not claim there is none.
  assert.equal(providersText(), 'Loading…');
  failLoad(new Error('relay unreachable'));
  await refreshed;
  assert.equal(toggle().checked, true);
  assert.equal(interval().value, '24');
  assert.equal(interval().disabled, false);
  assert.match(providersText(), /^Could not load the providers: The relay could not be reached \(relay unreachable\)\.$/);
  assert.doesNotMatch(providersText(), /No provider is switched on/);
  assert.equal(providerRows().length, 0);
});

test('a refused read shows the relay\'s reason; a retry shows "Loading…" again', async (t) => {
  t.mock.method(console, 'error', () => {});
  let release = null;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { release = resolve; }));
  const refreshed = refreshModelRefreshSettings();
  assert.equal(providersText(), 'Loading…', 'the earlier failure gives way to the new read');
  release(jsonResponse({ error: 'Settings store unavailable' }, 503));
  await refreshed;
  assert.equal(providersText(), 'Could not load the providers: Settings store unavailable');
});

test('a loaded answer lands on the switch, the interval and one row per provider', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(String(url), /\/api\/model-refresh-settings$/);
    return jsonResponse(answer());
  });
  await refreshModelRefreshSettings();
  assert.equal(toggle().checked, true);
  assert.equal(interval().value, '12');
  assert.deepEqual(providerRows().map((row) => row.querySelector('label span').textContent), ['Check Cursor', 'Check Grok', 'Check DeepSeek']);
  assert.equal(providerBox('cursor').checked, true);
  assert.equal(providerBox('grok').checked, false, 'an excluded provider is unticked');
  assert.equal(providerBox('deepseek').checked, true);
  const lastOf = (id) => providerBox(id).closest('.settings-row').querySelector('.model-refresh-provider-last').textContent;
  assert.equal(lastOf('cursor'), 'Last checked 3 h ago');
  assert.equal(lastOf('grok'), 'Not checked yet');
  assert.equal(lastOf('deepseek'), 'Last check failed 1 h ago: HTTP 503');
  // Each label names its box.
  for (const row of providerRows()) {
    assert.equal(row.querySelector('label').htmlFor, row.querySelector('input').id);
  }
});

test('a later failed read keeps the providers it had under the reason', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => jsonResponse({ error: 'Busy' }, 500));
  await refreshModelRefreshSettings();
  const list = document.getElementById('model-refresh-providers');
  assert.equal(list.firstElementChild.textContent, 'Could not load the providers: Busy');
  assert.deepEqual(providerRows().map((row) => row.querySelector('input').dataset.modelRefreshProvider), ['cursor', 'grok', 'deepseek']);
  assert.doesNotMatch(list.textContent, /No provider is switched on/);
});

test('an enabled provider that is not set up says so, and its box still edits the list', async (t) => {
  const posts = [];
  let state = answer({
    excluded: [],
    providers: [
      { id: 'cursor', label: 'Cursor', setUp: false, last: { at: new Date(Date.now() - HOUR).toISOString(), ok: true, error: null } },
      // A relay from before the field: set up.
      { id: 'grok', label: 'Grok', last: null },
    ],
  });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      posts.push(body);
      state = { ...state, ...body };
    }
    return jsonResponse(state);
  });
  await refreshModelRefreshSettings();
  const lastOf = (id) => providerBox(id).closest('.settings-row').querySelector('.model-refresh-provider-last').textContent;
  assert.equal(lastOf('cursor'), 'Not set up');
  assert.equal(lastOf('grok'), 'Not checked yet');
  assert.equal(providerBox('cursor').checked, true);
  assert.equal(providerBox('cursor').disabled, false);
  await updateModelRefreshProviderSetting('cursor', false);
  assert.deepEqual(posts.at(-1), { excluded: ['cursor'] });
  assert.equal(providerBox('cursor').checked, false);
  assert.equal(lastOf('cursor'), 'Not set up');
});

test('"No provider is switched on" only from an answer that lists none', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(answer({ providers: [] })));
  await refreshModelRefreshSettings();
  assert.equal(providersText(), 'No provider is switched on.');
  assert.equal(providerRows().length, 0);
});

test('with the check off, the interval and the providers are greyed out', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(answer({ auto: false })));
  await refreshModelRefreshSettings();
  assert.equal(toggle().checked, false);
  assert.equal(toggle().disabled, false);
  assert.equal(interval().disabled, true);
  assert.ok(providerRows().every((row) => row.querySelector('input').disabled));
});

test('each control posts its own field and shows the relay\'s answer', async (t) => {
  t.mock.method(console, 'error', () => {});
  let state = answer({ auto: false });
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      posts.push(body);
      state = { ...state, ...body };
    }
    return jsonResponse(state);
  });
  await refreshModelRefreshSettings();

  await updateModelRefreshAutoSetting(true);
  assert.deepEqual(posts.at(-1), { auto: true });
  assert.equal(toggle().checked, true);
  assert.equal(interval().disabled, false);

  await updateModelRefreshIntervalSetting('72');
  assert.deepEqual(posts.at(-1), { intervalHours: 72 });
  assert.equal(interval().value, '72');

  await updateModelRefreshProviderSetting('cursor', false);
  assert.deepEqual(posts.at(-1), { excluded: ['grok', 'cursor'] });
  assert.equal(providerBox('cursor').checked, false);

  // Ticking a box from the page takes the provider out of the list again.
  providerBox('grok').checked = true;
  providerBox('grok').dispatchEvent(new dom.window.Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(posts.at(-1), { excluded: ['cursor'] });
  assert.equal(providerBox('grok').checked, true);
  assert.equal(providerBox('grok').disabled, false);
});

test('a refused change keeps the shown value and says why', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => (options.method === 'POST'
    ? jsonResponse({ error: 'Invalid interval' }, 400)
    : jsonResponse(answer())));
  await refreshModelRefreshSettings();
  const alerts = [];
  const originalAlert = globalThis.alert;
  globalThis.alert = (message) => alerts.push(message);
  try {
    await updateModelRefreshIntervalSetting('5');
  } finally {
    globalThis.alert = originalAlert;
  }
  assert.deepEqual(alerts, ['Invalid interval']);
  assert.equal(interval().value, '12');
  assert.equal(interval().disabled, false);
});
