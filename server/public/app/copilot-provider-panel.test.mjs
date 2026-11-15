import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings → Providers → Copilot, rendered from the real index.html: the CLI
// status row and nothing to choose, since the SDK worker is the only engine.
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
const settingsModal = await import('./settings-modal.js');

const el = (id) => document.getElementById(id);

test('the Copilot sub-tab leads the provider strip and is selected by default', () => {
  const strip = document.querySelector('#settings-modal .settings-subtab-strip');
  const order = Array.from(strip.querySelectorAll('[data-settings-provider-tab]'))
    .map((button) => button.dataset.settingsProviderTab);
  assert.deepEqual(order, ['copilot', 'openai', 'claude', 'claude-api', 'claude-cloud', 'grok', 'cursor', 'deepseek']);
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

  const result = selectSettingsTab('providers', 'claude');
  assert.equal(result.providerTab, 'claude');
  assert.equal(el('settings-provider-panel-claude').hidden, false);
  assert.equal(el('settings-provider-panel-copilot').hidden, true);
});

test('the Copilot panel holds the CLI status row and no engine choice', () => {
  const panel = el('settings-provider-panel-copilot');
  assert.ok(panel.querySelector('#cli-copilot-section'));
  assert.equal(panel.querySelectorAll('select').length, 0);
  for (const id of ['copilot-engine-select', 'copilot-save-btn', 'copilot-settings-status']) {
    assert.equal(el(id), null, id);
  }
  assert.doesNotMatch(panel.textContent, /engine/i);
  assert.equal('saveCopilotSettings' in settingsModal, false);
  assert.equal('applyCopilotSettingsState' in settingsModal, false);
});
