import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings → Providers → Claude Cloud renders into markup that lives in
// index.html, so this runs against the real file: a renamed or dropped id
// fails here instead of in the browser. JSDOM does not run the page's scripts
// or inline handlers, so the handlers bootstrap.js exposes are called directly.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => {
  const timer = nativeSetTimeout(...args);
  timer?.unref?.();
  return timer;
};

const SETTINGS = Object.freeze({
  enabled: true,
  defaultModel: 'claude-sonnet-5-5',
  environmentId: 'env_01EXAMPLEaaaaaaaaaaaaaaaa',
  environments: [
    { id: 'env_01EXAMPLEaaaaaaaaaaaaaaaa', name: 'Default' },
    { id: 'env_01EXAMPLEbbbbbbbbbbbbbbbb', name: 'Sandbox two' },
  ],
  environmentsError: null,
  account: { loggedIn: true, email: 'dev@example.com', orgName: 'Example Org', subscriptionType: 'max' },
  token: { source: 'file', hasToken: true, expiresAt: '2099-01-01T00:00:00.000Z' },
  models: ['claude-opus-5', 'claude-sonnet-5-5'],
});

// GET answers `getResponder`, POST answers `postResponder`; a responder that
// returns { status, body } answers with that status.
const requests = [];
let getResponder = async () => SETTINGS;
let postResponder = async (body) => ({ ...SETTINGS, ...body });
globalThis.fetch = async (url, opts = {}) => {
  const method = String(opts.method || 'GET');
  const body = opts.body ? JSON.parse(opts.body) : null;
  requests.push({ url: String(url), method, body });
  const answer = method === 'POST' ? await postResponder(body) : await getResponder();
  const status = answer && typeof answer.status === 'number' ? answer.status : 200;
  const payload = answer && typeof answer.status === 'number' ? answer.body : answer;
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
};

const { selectSettingsTab } = await import('./settings-tabs.js');
const ui = await import('./claude-cloud-settings-ui.js');

const el = (id) => document.getElementById(id);
const optionValues = (id) => Array.from(el(id).options).map((option) => option.value);
const optionLabels = (id) => Array.from(el(id).options).map((option) => option.textContent);

test('the Claude Cloud sub-tab sits after Claude and opens its own panel', () => {
  const order = Array.from(document.querySelectorAll('#settings-modal [data-settings-provider-tab]'))
    .map((button) => button.dataset.settingsProviderTab);
  assert.deepEqual(order, ['copilot', 'openai', 'claude', 'claude-cloud', 'grok', 'cursor']);
  assert.equal(el('settings-provider-tab-claude-cloud').textContent.trim(), 'Claude Cloud');
  assert.equal(el('settings-provider-panel-claude-cloud').hasAttribute('hidden'), true);

  const result = selectSettingsTab('providers', 'claude-cloud');
  assert.equal(result.providerTab, 'claude-cloud');
  assert.equal(el('settings-provider-panel-claude-cloud').hidden, false);
  assert.equal(el('settings-provider-panel-claude').hidden, true);
  assert.equal(el('claude-cloud-open-link').getAttribute('href'), 'https://claude.ai/code');
});

test('a relay without the routes shows a plain note, not an error', async () => {
  getResponder = async () => ({ status: 404, body: { error: 'Not found' } });
  const state = await ui.openClaudeCloudSettingsSection();
  assert.equal(state, null);
  assert.equal(ui.isClaudeCloudEnabled(), false);
  assert.equal(el('claude-cloud-settings-status').textContent, 'Claude Cloud is not available on this relay.');
  assert.notEqual(el('claude-cloud-settings-status').dataset.state, 'error');
  for (const id of ['claude-cloud-enabled-toggle', 'claude-cloud-environment-select', 'claude-cloud-model-select', 'claude-cloud-save-btn']) {
    assert.equal(el(id).disabled, true, id);
  }
  assert.equal(el('claude-cloud-account-row').hidden, true);
  assert.equal(el('claude-cloud-token').hidden, true);
  getResponder = async () => SETTINGS;
});

test('the loaded settings fill the toggle, the account, the token line and both selects', async () => {
  await ui.openClaudeCloudSettingsSection();
  assert.equal(ui.isClaudeCloudEnabled(), true);
  assert.equal(el('claude-cloud-enabled-toggle').checked, true);
  assert.equal(el('claude-cloud-enabled-toggle').disabled, false);
  assert.equal(el('claude-cloud-account-row').hidden, false);
  assert.equal(el('claude-cloud-account').textContent, 'Billed to dev@example.com · Example Org · Max');
  assert.equal(el('claude-cloud-account').dataset.state, 'active');
  assert.match(el('claude-cloud-token').textContent, /^Login: read from the Claude CLI on the relay host, valid until /);
  assert.equal(el('claude-cloud-token').dataset.state, 'active');
  assert.deepEqual(optionValues('claude-cloud-environment-select'), [
    'env_01EXAMPLEaaaaaaaaaaaaaaaa',
    'env_01EXAMPLEbbbbbbbbbbbbbbbb',
  ]);
  assert.deepEqual(optionLabels('claude-cloud-environment-select'), [
    'Default (env_01EXAMPLEaaaaaaaaaaaaaaaa)',
    'Sandbox two (env_01EXAMPLEbbbbbbbbbbbbbbbb)',
  ]);
  assert.equal(el('claude-cloud-environment-select').value, 'env_01EXAMPLEaaaaaaaaaaaaaaaa');
  assert.equal(el('claude-cloud-environment-note').hidden, true);
  assert.deepEqual(optionValues('claude-cloud-model-select'), ['claude-opus-5', 'claude-sonnet-5-5']);
  assert.deepEqual(optionLabels('claude-cloud-model-select'), ['Opus 5', 'Sonnet 5.5']);
  assert.equal(el('claude-cloud-model-select').value, 'claude-sonnet-5-5');
  assert.equal(el('claude-cloud-settings-status').textContent, 'Claude Cloud is enabled. Select Claude Cloud in New Chat to start with Sonnet 5.5.');
  assert.equal(el('claude-cloud-settings-status').dataset.state, 'active');
  assert.equal(el('claude-cloud-save-btn').disabled, false);
});

test('Save posts the two selects and nothing else', async () => {
  requests.length = 0;
  const environment = el('claude-cloud-environment-select');
  const model = el('claude-cloud-model-select');
  environment.value = 'env_01EXAMPLEbbbbbbbbbbbbbbbb';
  environment.dispatchEvent(new dom.window.Event('change'));
  model.value = 'claude-opus-5';
  model.dispatchEvent(new dom.window.Event('change'));

  // A socket update that lands before Save must not undo the unsaved picks.
  ui.applyClaudeCloudSettingsState({ ...SETTINGS });
  assert.equal(environment.value, 'env_01EXAMPLEbbbbbbbbbbbbbbbb');
  assert.equal(model.value, 'claude-opus-5');

  await ui.saveClaudeCloudSettings();
  const posts = requests.filter((request) => request.method === 'POST');
  assert.deepEqual(posts, [{
    url: '/api/settings/claude-cloud',
    method: 'POST',
    body: { defaultModel: 'claude-opus-5', environmentId: 'env_01EXAMPLEbbbbbbbbbbbbbbbb' },
  }]);
  assert.equal(ui.getClaudeCloudSettings().defaultModel, 'claude-opus-5');
  assert.equal(ui.getClaudeCloudSettings().environmentId, 'env_01EXAMPLEbbbbbbbbbbbbbbbb');
  assert.equal(model.value, 'claude-opus-5');
});

test('a refused enable is shown in the tab and the toggle goes back', async () => {
  ui.applyClaudeCloudSettingsState({ ...SETTINGS, enabled: false }, { resetInputs: true });
  assert.equal(el('claude-cloud-enabled-toggle').checked, false);
  assert.match(el('claude-cloud-settings-status').textContent, /^Not enabled\./);

  requests.length = 0;
  postResponder = async () => ({
    status: 400,
    body: { error: 'Sign in to Claude on the relay host first.', code: 'claude_cloud_login_missing' },
  });
  el('claude-cloud-enabled-toggle').checked = true;
  await ui.toggleClaudeCloudProvider(true);
  assert.deepEqual(requests.map((request) => request.body), [{ enabled: true }]);
  assert.equal(el('claude-cloud-enabled-toggle').checked, false);
  assert.equal(el('claude-cloud-enabled-toggle').disabled, false);
  assert.equal(el('claude-cloud-settings-status').textContent, 'Sign in to Claude on the relay host first.');
  assert.equal(el('claude-cloud-settings-status').dataset.state, 'error');
  assert.equal(ui.isClaudeCloudEnabled(), false);

  postResponder = async (body) => ({ ...SETTINGS, ...body });
  await ui.toggleClaudeCloudProvider(true);
  assert.equal(el('claude-cloud-enabled-toggle').checked, true);
  assert.equal(el('claude-cloud-settings-status').dataset.state, 'active');
});

test('subscribers hear every applied state, and a partial event keeps the rest', () => {
  const seen = [];
  const unsubscribe = ui.subscribeClaudeCloudSettings((state) => seen.push(state?.enabled));
  ui.applyClaudeCloudSettingsState({ ...SETTINGS, enabled: true }, { resetInputs: true });
  // An event that only says what changed leaves the lists where they were.
  ui.applyClaudeCloudSettingsState({ enabled: false });
  assert.deepEqual(seen, [true, false]);
  assert.deepEqual(ui.getClaudeCloudSettings().models, ['claude-opus-5', 'claude-sonnet-5-5']);
  assert.equal(ui.getClaudeCloudSettings().environmentId, 'env_01EXAMPLEaaaaaaaaaaaaaaaa');
  unsubscribe();
  ui.applyClaudeCloudSettingsState({ enabled: true });
  assert.deepEqual(seen, [true, false]);
  // Not a payload: nothing changes.
  assert.equal(ui.applyClaudeCloudSettingsState(null), ui.getClaudeCloudSettings());
});

test('a stored environment the account no longer lists stays selectable', () => {
  assert.deepEqual(
    ui.claudeCloudEnvironmentOptions({ environmentId: 'env_01EXAMPLEcccccccccccccccc', environments: [{ id: 'env_01EXAMPLEaaaaaaaaaaaaaaaa', name: '' }] }),
    [
      { value: 'env_01EXAMPLEaaaaaaaaaaaaaaaa', label: 'env_01EXAMPLEaaaaaaaaaaaaaaaa' },
      { value: 'env_01EXAMPLEcccccccccccccccc', label: 'env_01EXAMPLEcccccccccccccccc (saved)' },
    ],
  );
  // The list call failed: the stored id is the one option, and the note says why.
  const failed = { environmentId: 'env_01EXAMPLEaaaaaaaaaaaaaaaa', environments: null, environmentsError: 'GitHub is not connected' };
  assert.deepEqual(ui.claudeCloudEnvironmentOptions(failed), [
    { value: 'env_01EXAMPLEaaaaaaaaaaaaaaaa', label: 'env_01EXAMPLEaaaaaaaaaaaaaaaa (saved)' },
  ]);
  assert.equal(ui.claudeCloudEnvironmentNoteText(failed), 'Could not list the cloud environments: GitHub is not connected');
  assert.match(ui.claudeCloudEnvironmentNoteText({ environments: [] }), /^No cloud environment found\. Open claude\.ai\/code once/);
  assert.equal(ui.claudeCloudEnvironmentNoteText({ environmentId: 'env_01EXAMPLEaaaaaaaaaaaaaaaa', environments: [] }), '');
  // The relay lists environments only while the provider is on and signed in:
  // "not asked" must not read as "the account has none".
  assert.equal(
    ui.claudeCloudEnvironmentNoteText({ enabled: false, environments: null, token: { hasToken: true } }),
    'The environments of the account are listed once Claude Cloud is enabled.',
  );
  assert.equal(
    ui.claudeCloudEnvironmentNoteText({ enabled: false, environments: null, token: { hasToken: false } }),
    'The environments are listed once the relay host is signed in to Claude.',
  );
  assert.equal(
    ui.claudeCloudEnvironmentNoteText({ enabled: true, environments: null, token: { hasToken: true } }),
    'The cloud environments have not been listed yet.',
  );

  ui.applyClaudeCloudSettingsState({ ...SETTINGS, environments: [], environmentId: '' }, { resetInputs: true });
  assert.deepEqual(optionLabels('claude-cloud-environment-select'), ['No environment found']);
  assert.equal(el('claude-cloud-environment-select').disabled, true);
  assert.equal(el('claude-cloud-environment-note').hidden, false);
  // Switched off: what GET answers then (nothing was asked of the account).
  ui.applyClaudeCloudSettingsState(
    { ...SETTINGS, enabled: false, environments: null, environmentId: null },
    { resetInputs: true },
  );
  assert.deepEqual(optionLabels('claude-cloud-environment-select'), ['Not listed yet']);
  assert.equal(
    el('claude-cloud-environment-note').textContent,
    'The environments of the account are listed once Claude Cloud is enabled.',
  );
  ui.applyClaudeCloudSettingsState({ ...SETTINGS }, { resetInputs: true });
});

test('the account line degrades one field at a time', () => {
  assert.equal(ui.claudeCloudAccountLineText(null), 'Claude account status unavailable.');
  assert.equal(ui.claudeCloudAccountLineState(null), 'pending');
  assert.equal(ui.claudeCloudAccountLineText({ loggedIn: false }), 'Not signed in to Claude on the relay host.');
  assert.equal(ui.claudeCloudAccountLineState({ loggedIn: false }), 'unconfigured');
  assert.equal(ui.claudeCloudAccountLineText({ loggedIn: true }), 'Signed in to Claude.');
  assert.equal(
    ui.claudeCloudAccountLineText({ loggedIn: true, email: 'dev@example.com', orgName: 'dev@example.com', subscriptionType: null }),
    'Billed to dev@example.com',
  );
});

test('the token line says where the login comes from and never shows it', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z');
  const formatTime = (date) => date.toISOString();
  assert.equal(
    ui.claudeCloudTokenLineText({ source: 'file', hasToken: true, expiresAt: '2026-10-02T18:00:00.000Z' }, { now, formatTime }),
    'Login: read from the Claude CLI on the relay host, valid until 2026-10-02T18:00:00.000Z.',
  );
  const expired = { source: 'file', hasToken: true, expiresAt: '2026-10-02T08:00:00.000Z' };
  assert.match(ui.claudeCloudTokenLineText(expired, { now, formatTime }), /It has expired; the relay picks up the new one/);
  assert.equal(ui.claudeCloudTokenLineState(expired, { now }), 'pending');
  assert.equal(
    ui.claudeCloudTokenLineText({ source: 'env', hasToken: true, expiresAt: null }, { now, formatTime }),
    'Login: CLAUDE_CODE_OAUTH_TOKEN from the relay environment.',
  );
  assert.equal(
    ui.claudeCloudTokenLineText({ source: 'file', hasToken: true, expiresAt: null }, { now, formatTime }),
    'Login: read from the Claude CLI on the relay host.',
  );
  for (const token of [null, { source: 'none', hasToken: false }, { source: 'file', hasToken: false }]) {
    assert.equal(
      ui.claudeCloudTokenLineText(token, { now, formatTime }),
      'No Claude login found on the relay host. Sign in on the Claude tab first.',
    );
    assert.equal(ui.claudeCloudTokenLineState(token, { now }), 'error');
  }
});

test('the status line tells loading, unavailable, disabled and enabled apart', () => {
  assert.deepEqual(ui.claudeCloudStatusLine(null), { text: 'Loading Claude Cloud settings…', state: 'pending' });
  assert.deepEqual(
    ui.claudeCloudStatusLine(null, { loadFailed: true }),
    { text: 'Claude Cloud is not available on this relay.', state: 'unconfigured' },
  );
  assert.equal(ui.claudeCloudStatusLine({ enabled: false }).state, 'unconfigured');
  assert.equal(ui.claudeCloudStatusLine({ enabled: true, defaultModel: '' }).text, 'Claude Cloud is enabled. Select Claude Cloud in New Chat.');
  assert.deepEqual(ui.claudeCloudStatusLine({ enabled: true }, { error: 'No.' }), { text: 'No.', state: 'error' });
});

test('Claude login jumps to the Claude tab, where the account is managed', () => {
  selectSettingsTab('providers', 'claude-cloud');
  ui.openClaudeCloudLoginTab();
  assert.equal(el('settings-provider-panel-claude').hidden, false);
  assert.equal(el('settings-provider-panel-claude-cloud').hidden, true);
});
