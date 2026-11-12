import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings › Appearance: the look-and-feel rows that were General's first
// block, in a tab of their own right after General. Rendered against the real
// index.html; the tab logic is the real settings-tabs.js.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const { selectSettingsTab } = await import('./settings-tabs.js');

const el = (id) => document.getElementById(id);
const APPEARANCE_IDS = [
  'theme-select',
  'font-scale-select',
  'thoughts-expanded-toggle',
  'live-activity-cap-slider',
  'stream-view-toggle',
  'show-suspend-host-toggle',
];

test('Appearance is the second tab, right after General', () => {
  const tabs = [...document.querySelectorAll('#settings-modal [data-settings-tab]')];
  assert.deepEqual(tabs.map((tab) => tab.dataset.settingsTab), ['general', 'appearance', 'providers', 'relays', 'security', 'previews', 'shares', 'notifications', 'features']);
  const tab = el('settings-tab-appearance');
  assert.equal(tab.textContent.trim(), 'Appearance');
  assert.equal(tab.getAttribute('role'), 'tab');
  assert.equal(tab.getAttribute('aria-controls'), 'settings-panel-appearance');
  assert.equal(tab.getAttribute('aria-selected'), 'false');
  // General still ships selected, so a first visit opens there.
  assert.equal(el('settings-tab-general').getAttribute('aria-selected'), 'true');
  const panel = el('settings-panel-appearance');
  assert.equal(panel.getAttribute('role'), 'tabpanel');
  assert.equal(panel.getAttribute('aria-labelledby'), 'settings-tab-appearance');
  assert.equal(panel.hidden, true);
});

test('it holds the six rows in their old order, under one line saying they stay in this browser', () => {
  const panel = el('settings-panel-appearance');
  assert.equal(panel.firstElementChild, el('appearance-browser-note'));
  assert.equal(el('appearance-browser-note').textContent, 'These settings are kept in this browser; other devices keep their own.');
  const found = APPEARANCE_IDS.map((id) => {
    assert.equal(document.querySelectorAll(`[id="${id}"]`).length, 1, `${id} once`);
    assert.equal(el(id).closest('[data-settings-panel]'), panel, `${id} in Appearance`);
    return el(id);
  });
  for (let i = 1; i < found.length; i += 1) {
    assert.ok(found[i - 1].compareDocumentPosition(found[i]) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, `${APPEARANCE_IDS[i - 1]} before ${APPEARANCE_IDS[i]}`);
  }
  // A screen reader hears the line with each control it is about.
  for (const control of found) assert.equal(control.getAttribute('aria-describedby'), 'appearance-browser-note', control.id);
  // The tab's name is the heading; the line above says it once for all rows.
  assert.equal(panel.querySelector('.settings-section-title'), null);
  assert.doesNotMatch(panel.textContent, /Saved in this browser/);
  assert.equal(el('settings-section-appearance'), null);
});

test('General keeps Reading, Turns and tasks, Models, This computer and Updates', () => {
  const general = el('settings-panel-general');
  for (const id of APPEARANCE_IDS) assert.equal(general.contains(el(id)), false, `${id} left General`);
  for (const id of ['pwa-app-name-input', 'restart-resume-toggle', 'relay-restart-max-wait-select']) {
    assert.equal(el(id).closest('[data-settings-panel]').id, 'settings-panel-relays', `${id} in Relays`);
  }
  for (const id of ['default-session-workspace-root-input', 'windows-autostart-setting', 'agent-sdk-koffi-row']) {
    assert.equal(el(id).closest('.settings-section').id, 'settings-section-computer', `${id} in This computer`);
  }
  assert.equal(el('settings-section-relay'), null);
});

test('a click on Appearance shows its panel and is remembered', () => {
  localStorage.clear();
  selectSettingsTab('general');
  el('settings-tab-appearance').click();
  assert.equal(el('settings-tab-appearance').getAttribute('aria-selected'), 'true');
  assert.equal(el('settings-panel-appearance').hidden, false);
  assert.equal(el('settings-panel-general').hidden, true);
  assert.equal(localStorage.getItem('copilot_settings_tab'), 'appearance');
  // Reopened without a tab: back on Appearance.
  assert.equal(selectSettingsTab().tab, 'appearance');
});

test('a remembered or deep-linked General still opens General; unknown tabs fall back', () => {
  // A browser that last had Settings open on General, before the split.
  localStorage.setItem('copilot_settings_tab', 'general');
  assert.equal(selectSettingsTab().tab, 'general');
  assert.equal(el('settings-panel-general').hidden, false);
  assert.equal(el('settings-panel-appearance').hidden, true);
  // An old deep link to General.
  selectSettingsTab('appearance');
  assert.equal(selectSettingsTab('general').tab, 'general');
  // Unknown values keep the remembered tab; nothing remembered opens General.
  assert.equal(selectSettingsTab('ui').tab, 'general');
  localStorage.setItem('copilot_settings_tab', 'no-such-tab');
  assert.equal(selectSettingsTab().tab, 'general');
  localStorage.clear();
  assert.equal(selectSettingsTab().tab, 'general');
});
