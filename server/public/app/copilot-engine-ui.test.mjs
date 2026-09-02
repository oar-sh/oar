import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Like the Claude auth UI smoke test, this renders the REAL index.html so a
// renamed or dropped element id fails here rather than in the browser. JSDOM
// does not execute the page's <script> tags, so this is pure markup + module.
const indexHtml = await readFile(
  fileURLToPath(new URL('../index.html', import.meta.url)),
  'utf8',
);
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});

const { selectSettingsTab } = await import('./settings-tabs.js');
const { applyCopilotSettingsState } = await import('./settings-modal.js');

const el = (id) => document.getElementById(id);

test('the Copilot sub-tab leads the provider strip and is selected by default', () => {
  const strip = document.querySelector('#settings-modal .settings-subtab-strip');
  const order = Array.from(strip.querySelectorAll('[data-settings-provider-tab]'))
    .map((button) => button.dataset.settingsProviderTab);
  assert.deepEqual(order, ['copilot', 'openai', 'claude', 'grok', 'cursor']);
  // Copilot is the default provider, so its panel is the one a first-time
  // visitor lands on — which means it, and only it, ships un-hidden.
  assert.equal(el('settings-provider-panel-copilot').hidden, false);
  assert.equal(el('settings-provider-panel-openai').hasAttribute('hidden'), true);
});

test('the Copilot panel is reachable by deep link and hides the others', () => {
  selectSettingsTab('providers', 'copilot');
  assert.equal(el('settings-provider-tab-copilot').getAttribute('aria-selected'), 'true');
  assert.equal(el('settings-provider-panel-copilot').hidden, false);
  assert.equal(el('settings-provider-panel-claude').hidden, true);

  // The pre-existing sub-tabs must keep working unchanged.
  const result = selectSettingsTab('providers', 'claude');
  assert.equal(result.providerTab, 'claude');
  assert.equal(el('settings-provider-panel-claude').hidden, false);
  assert.equal(el('settings-provider-panel-copilot').hidden, true);
});

test('the engine select and its save button carry the expected ids', () => {
  const select = el('copilot-engine-select');
  assert.ok(select);
  assert.deepEqual(
    Array.from(select.options).map((option) => option.value),
    ['extension', 'sdk'],
  );
  assert.ok(el('copilot-save-btn'));
  assert.ok(el('copilot-settings-status'));
});

test('applying settings drives the select and the status line', () => {
  const state = applyCopilotSettingsState({ engine: 'sdk' });
  assert.equal(state.engine, 'sdk');
  assert.equal(el('copilot-engine-select').value, 'sdk');
  assert.match(el('copilot-settings-status').textContent, /headless SDK worker/);
  assert.equal(el('copilot-settings-status').dataset.state, 'active');

  applyCopilotSettingsState({ engine: 'extension' });
  assert.equal(el('copilot-engine-select').value, 'extension');
  assert.match(el('copilot-settings-status').textContent, /web-relay extension/);
});

test('an unknown or missing engine falls back to the shipping default', () => {
  applyCopilotSettingsState({ engine: 'sdk' });
  assert.equal(applyCopilotSettingsState({ engine: 'quantum' }).engine, 'extension');
  assert.equal(el('copilot-engine-select').value, 'extension');
  assert.equal(applyCopilotSettingsState({}).engine, 'extension');
});

test('a refused save shows the relay reason in the status line', () => {
  // The relay refuses the SDK engine with something actionable ("restart the
  // relay", "routing is disabled"). An alert is gone the moment it is
  // dismissed, so the panel would otherwise show the old engine with no
  // explanation of why the choice did not stick.
  const reason = 'The SDK engine requires session worker routing, which is disabled on this relay.';
  const status = el('copilot-settings-status');

  applyCopilotSettingsState({ engine: 'extension' }, { error: reason });
  assert.equal(status.textContent, reason);
  assert.equal(status.dataset.state, 'error');
  // The select still shows what the relay is actually on, not the rejected pick.
  assert.equal(el('copilot-engine-select').value, 'extension');

  // Any later apply that carries no error — a successful save, a refresh, or a
  // broadcast from another tab — puts the normal description back.
  applyCopilotSettingsState({ engine: 'sdk' });
  assert.match(status.textContent, /headless SDK worker/);
  assert.equal(status.dataset.state, 'active');
});
