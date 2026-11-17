import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings → Providers → Copilot: the "Enable GitHub Copilot" switch above the
// CLI row, against the real index.html (a renamed or dropped id fails here).
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
const alerts = [];
globalThis.alert = (text) => alerts.push(String(text));

const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const timer = nativeSetTimeout(...args);
  timer?.unref?.();
  return timer;
};

const requests = [];
let getResponder = async () => ({ engine: 'sdk', engines: ['sdk'], enabled: true, cliFound: true });
let postResponder = async (body) => ({ ok: true, engine: 'sdk', engines: ['sdk'], enabled: body.enabled, cliFound: true, warning: null });
globalThis.fetch = async (url, opts = {}) => {
  const method = String(opts.method || 'GET');
  const body = opts.body ? JSON.parse(opts.body) : null;
  requests.push({ url: String(url), method, body });
  const answer = method === 'POST' ? await postResponder(body) : await getResponder();
  const status = answer && typeof answer.status === 'number' ? answer.status : 200;
  const payload = answer && typeof answer.status === 'number' ? answer.body : answer;
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
};

const ui = await import('./copilot-settings-ui.js');
const { cliRowNote } = await import('./cli-install-ui.js');

const el = (id) => document.getElementById(id);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the switch sits above the CLI row in the Copilot panel', () => {
  const panel = el('settings-provider-panel-copilot');
  const toggle = el('copilot-enabled-toggle');
  assert.ok(panel.contains(toggle));
  assert.ok(panel.contains(el('copilot-settings-status')));
  assert.ok(toggle.compareDocumentPosition(el('cli-copilot-section')) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(document.querySelector('label[for="copilot-enabled-toggle"]').textContent, 'Enable GitHub Copilot');
});

test('a load shows the stored switch; an answer without `enabled` (older relay) reads as on', async () => {
  getResponder = async () => ({ engine: 'sdk', engines: ['sdk'], enabled: false, cliFound: true });
  await ui.refreshCopilotSettingsState();
  assert.equal(el('copilot-enabled-toggle').checked, false);
  assert.equal(ui.isCopilotEnabled(), false);
  assert.match(el('copilot-settings-status').textContent, /^Copilot is off/);
  assert.equal(el('copilot-settings-status').dataset.state, 'unconfigured');

  getResponder = async () => ({ engine: 'sdk', engines: ['sdk'] });
  await ui.refreshCopilotSettingsState();
  assert.equal(el('copilot-enabled-toggle').checked, true);
  assert.equal(ui.isCopilotEnabled(), true);
  assert.equal(el('copilot-settings-status').dataset.state, 'active');
});

test('flipping the switch posts it, applies the answer and tells the subscribers', async () => {
  getResponder = async () => ({ engine: 'sdk', engines: ['sdk'], enabled: true, cliFound: true });
  await ui.refreshCopilotSettingsState();
  const seen = [];
  const unsubscribe = ui.subscribeCopilotSettings((state) => seen.push(state.enabled));
  requests.length = 0;
  const toggle = el('copilot-enabled-toggle');
  toggle.checked = false;
  toggle.dispatchEvent(new dom.window.Event('change'));
  await settle();
  await settle();
  const post = requests.find((entry) => entry.method === 'POST');
  assert.ok(post.url.endsWith('/api/settings/copilot'));
  assert.deepEqual(post.body, { enabled: false });
  assert.equal(ui.isCopilotEnabled(), false);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.deepEqual(seen, [false]);
  unsubscribe();
});

test('a refused save puts the switch back and says why', async () => {
  getResponder = async () => ({ engine: 'sdk', engines: ['sdk'], enabled: true, cliFound: true });
  await ui.refreshCopilotSettingsState();
  postResponder = async () => ({ status: 500, body: { error: 'Copilot settings are unavailable' } });
  alerts.length = 0;
  await ui.toggleCopilotProvider(false);
  assert.equal(ui.isCopilotEnabled(), true);
  assert.equal(el('copilot-enabled-toggle').checked, true);
  assert.deepEqual(alerts, ['Copilot settings are unavailable']);
});

test('a failed load says so', async () => {
  getResponder = async () => ({ status: 500, body: { error: 'boom' } });
  await ui.refreshCopilotSettingsState();
  assert.equal(el('copilot-settings-status').textContent, 'Unable to load Copilot settings.');
  assert.equal(el('copilot-settings-status').dataset.state, 'error');
});

test('a socket event applies like a load', () => {
  ui.applyCopilotSettingsState({ enabled: false, cliFound: false });
  assert.equal(el('copilot-enabled-toggle').checked, false);
  // The line never claims the CLI is missing: the CLI row says that.
  ui.applyCopilotSettingsState({ enabled: true, cliFound: false });
  assert.equal(el('copilot-settings-status').textContent, ui.copilotSettingsStatusText({ enabled: true, cliFound: true, loaded: true }));
  assert.doesNotMatch(el('copilot-settings-status').textContent, /not installed|missing|need/i);
});

test('the CLI row of an installed Copilot that is switched off says to switch it on', () => {
  const row = { installed: true, checkedAt: '2026-11-16T22:00:00.000Z', hint: 'Log in once with copilot in a terminal.' };
  assert.equal(cliRowNote(row, { switchedOff: true }), 'Switch Copilot on above to use it. Log in once with copilot in a terminal.');
  assert.equal(cliRowNote(row), 'Log in once with copilot in a terminal.');
  assert.equal(cliRowNote({ installed: false, checkedAt: 'x' }, { switchedOff: true }), '');
});

test('socket-handlers applies copilot_settings_updated', async () => {
  const source = await readFile(fileURLToPath(new URL('./socket-handlers.js', import.meta.url)), 'utf8');
  assert.match(source, /socket\.on\('copilot_settings_updated', \(payload\) => \{\s*applyCopilotSettingsState\(payload \|\| \{\}\);/);
});

test('the OpenAI tab no longer says provider changes move empty chats', () => {
  const help = el('settings-provider-panel-openai').textContent;
  assert.doesNotMatch(help, /Provider changes also update conversations/);
  assert.match(help, /Chats keep their provider when the key is removed or OpenAI is switched off\./);
});
