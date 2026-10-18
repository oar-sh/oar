import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// "Claude background command limit" in Settings › Providers › Claude: a loaded
// value and its bounds land on the slider, dragging updates the label, and
// "Save Claude settings" posts the value with the rest of the Claude settings.
// Rendered against the real index.html; JSDOM does not execute the page's
// <script> tags.
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
  applyClaudeSettingsState,
  previewClaudeBackgroundCommandLimit,
  saveClaudeSettings,
} = await import('./settings-modal.js');

const slider = () => document.getElementById('claude-background-command-limit-slider');
const label = () => document.getElementById('claude-background-command-limit-value');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

test('the slider sits in the Claude provider panel with a help text about new sessions', () => {
  assert.ok(slider().closest('#settings-provider-panel-claude'), 'in the Claude provider panel');
  assert.equal(slider().value, '120');
  assert.equal(label().textContent, '2 h');
  assert.match(document.querySelector('label[for="claude-background-command-limit-slider"]').textContent, /Claude background command limit/);
  assert.match(slider().nextElementSibling.textContent, /Applies to Claude sessions started after you save/);
});

test('a loaded value and its bounds land on the slider', () => {
  applyClaudeSettingsState({
    model: 'claude-sonnet-5',
    backgroundCommandLimitMinutes: 330,
    backgroundCommandLimitMinMinutes: 30,
    backgroundCommandLimitMaxMinutes: 480,
    backgroundCommandLimitStepMinutes: 30,
  }, { resetInputs: true });
  assert.equal(slider().value, '330');
  assert.equal(slider().max, '480');
  assert.equal(label().textContent, '5 h 30 min');
});

test('dragging updates the label and a later load does not overwrite the unsaved choice', () => {
  applyClaudeSettingsState({ backgroundCommandLimitMinutes: 120 }, { resetInputs: true });
  slider().value = '240';
  previewClaudeBackgroundCommandLimit(slider().value);
  assert.equal(label().textContent, '4 h');
  applyClaudeSettingsState({ backgroundCommandLimitMinutes: 120 });
  assert.equal(slider().value, '240');
  assert.equal(label().textContent, '4 h');
});

test('saving posts the slider value with the Claude settings', async (t) => {
  const alerts = [];
  globalThis.alert = (message) => alerts.push(message);
  t.after(() => { delete globalThis.alert; });
  applyClaudeSettingsState({ backgroundCommandLimitMinutes: 120 }, { resetInputs: true });
  slider().value = '450';
  previewClaudeBackgroundCommandLimit(slider().value);
  const posted = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse({ model: 'claude-sonnet-5', backgroundCommandLimitMinutes: 450 });
  });
  await saveClaudeSettings();
  assert.deepEqual(alerts, []);
  assert.equal(posted.length, 1);
  assert.match(posted[0].url, /\/api\/settings\/claude$/);
  assert.equal(posted[0].body.backgroundCommandLimitMinutes, 450);
  assert.equal(slider().value, '450');
  assert.equal(label().textContent, '7 h 30 min');
});
