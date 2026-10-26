import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings → Providers → Claude API and the composer's billing toggle render
// into markup that lives in index.html, so this runs against the real file:
// a renamed or dropped id fails here instead of in the browser. JSDOM does
// not run the page's scripts or inline handlers, so the handlers bootstrap.js
// exposes are called directly.
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

// Invented, and not shaped like an Anthropic key.
const TEST_KEY = 'test-console-key-0000000000000000';

// What GET /api/settings/claude-api answers (claude-api-settings-service.mjs describe()).
const SETTINGS = Object.freeze({
  configured: true,
  enabled: true,
  model: 'claude-sonnet-5-5',
  models: ['claude-sonnet-5-5', 'claude-opus-5-5'],
  availableModels: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5[1m]'],
  enabledModels: ['claude-sonnet-5-5', 'claude-opus-5-5'],
  discovered: true,
  monthlyCapUsd: 40,
  providerType: 'claude-api',
  label: 'Claude API',
});

const requests = [];
let getResponder = async () => SETTINGS;
let postResponder = async (url, body) => ({ ok: true, ...SETTINGS, ...body, apiKey: undefined });
globalThis.fetch = async (url, opts = {}) => {
  const method = String(opts.method || 'GET');
  const body = opts.body ? JSON.parse(opts.body) : null;
  requests.push({ url: String(url), method, body });
  const answer = method === 'POST' ? await postResponder(String(url), body) : await getResponder(String(url));
  const status = answer && typeof answer.status === 'number' ? answer.status : 200;
  const payload = answer && typeof answer.status === 'number' ? answer.body : answer;
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
};
const alerts = [];
globalThis.alert = (text) => alerts.push(String(text));
window.alert = globalThis.alert;
globalThis.confirm = () => true;
window.confirm = globalThis.confirm;

const { selectSettingsTab } = await import('./settings-tabs.js');
const ui = await import('./claude-api-settings-ui.js');
const store = await import('./store.js');
const usageLimit = await import('./usage-limit-ui.js');
const toggle = await import('./claude-billing-toggle-ui.js');

const el = (id) => document.getElementById(id);

test('the Claude API sub-tab sits after Claude and opens its own panel', () => {
  const order = Array.from(document.querySelectorAll('#settings-modal [data-settings-provider-tab]'))
    .map((button) => button.dataset.settingsProviderTab);
  assert.deepEqual(order, ['copilot', 'openai', 'claude', 'claude-api', 'claude-cloud', 'grok', 'cursor', 'deepseek']);
  assert.equal(el('settings-provider-tab-claude-api').textContent.trim(), 'Claude API');
  assert.equal(el('settings-provider-panel-claude-api').hasAttribute('hidden'), true);
  const result = selectSettingsTab('providers', 'claude-api');
  assert.equal(result.providerTab, 'claude-api');
  assert.equal(el('settings-provider-panel-claude-api').hidden, false);
  assert.equal(el('settings-provider-panel-claude').hidden, true);
});

test('the key field is a password field the relay never fills', async () => {
  const keyInput = el('claude-api-key-input');
  assert.equal(keyInput.type, 'password');
  assert.equal(keyInput.getAttribute('autocomplete'), 'new-password');
  keyInput.value = 'typed before the load';
  await ui.syncClaudeApiSettingsInputs();
  // The relay sends no key; the field only says one is saved.
  assert.equal(keyInput.value, '');
  assert.equal(keyInput.placeholder, 'Saved API key (enter to replace)');
  assert.equal(el('claude-api-enabled-toggle').checked, true);
  assert.equal(el('claude-api-model-select').value, 'claude-sonnet-5-5');
  assert.deepEqual(Array.from(el('claude-api-model-select').options).map((option) => option.value), SETTINGS.availableModels);
  assert.equal(el('claude-api-monthly-cap-input').value, '40');
  assert.equal(el('claude-api-settings-status').dataset.state, 'active');
  assert.equal(el('claude-api-remove-btn').disabled, false);
  assert.equal(el('claude-api-refresh-btn').disabled, false);
  assert.equal(el('claude-api-models-status').hidden, true);
});

test('the tab points to the Claude tab for the shared settings', () => {
  const panel = el('settings-provider-panel-claude-api');
  assert.match(panel.textContent, /Commit attribution, the background command limit, the effort levels and the compaction window are shared with Claude chats/);
  // No field of the Claude tab is repeated here.
  assert.equal(panel.querySelector('[id*="attribution"]'), null);
  assert.equal(panel.querySelector('[id*="background"]'), null);
  selectSettingsTab('providers', 'claude-api');
  ui.openClaudeTabFromClaudeApi();
  assert.equal(el('settings-provider-panel-claude').hidden, false);
  assert.equal(el('settings-provider-panel-claude-api').hidden, true);
});

test('before the first discovery the tab says the models are the Claude tab\'s', () => {
  ui.applyClaudeApiSettingsState({ ...SETTINGS, discovered: false }, { resetInputs: true });
  assert.equal(el('claude-api-models-status').hidden, false);
  assert.match(el('claude-api-models-status').textContent, /Claude tab's models/);
  ui.applyClaudeApiSettingsState(SETTINGS, { resetInputs: true });
});

function pickModel(model) {
  el('claude-api-model-select').value = model;
  el('claude-api-model-select').dispatchEvent(new window.Event('change'));
}

test('the first save of a key does not pin the default the select showed before discovery', async () => {
  // A fresh relay: no key, and the select holds the Claude tab's list with
  // its default, which the key may not have.
  ui.applyClaudeApiSettingsState({
    ...SETTINGS,
    configured: false,
    enabled: false,
    discovered: false,
    model: 'claude-sonnet-5',
    availableModels: ['claude-sonnet-5', 'claude-opus-5'],
  }, { resetInputs: true });
  assert.equal(el('claude-api-model-select').value, 'claude-sonnet-5');
  requests.length = 0;
  el('claude-api-key-input').value = TEST_KEY;
  await ui.saveClaudeApiSettings();
  let body = requests.find((request) => request.method === 'POST').body;
  assert.equal('model' in body, false, 'no model: the relay derives the default from the key\'s list');
  assert.equal(body.apiKey, TEST_KEY);
  // A pick from that pre-discovery list is not the key's either.
  ui.applyClaudeApiSettingsState({ ...SETTINGS, discovered: false, model: 'claude-sonnet-5', availableModels: ['claude-sonnet-5', 'claude-opus-5'] }, { resetInputs: true });
  pickModel('claude-opus-5');
  requests.length = 0;
  await ui.saveClaudeApiSettings();
  body = requests.find((request) => request.method === 'POST').body;
  assert.equal('model' in body, false);
  ui.applyClaudeApiSettingsState(SETTINGS, { resetInputs: true });
});

test('Save sends the typed key, the model and the cap, then forgets the key', async () => {
  requests.length = 0;
  el('claude-api-key-input').value = TEST_KEY;
  // Picked by hand from the key's discovered list: saved as the default.
  pickModel('claude-opus-5-5');
  el('claude-api-monthly-cap-input').value = '12.5';
  await ui.saveClaudeApiSettings();
  const post = requests.find((request) => request.method === 'POST');
  assert.match(post.url, /\/api\/settings\/claude-api$/);
  assert.deepEqual(post.body, { apiKey: TEST_KEY, model: 'claude-opus-5-5', monthlyCapUsd: 12.5, enabled: true });
  assert.equal(el('claude-api-key-input').value, '');
  // Saved again without a new pick: the default is not sent again.
  requests.length = 0;
  await ui.saveClaudeApiSettings();
  assert.equal('model' in requests.find((request) => request.method === 'POST').body, false);
  // An emptied cap is "no cap".
  requests.length = 0;
  el('claude-api-monthly-cap-input').value = '';
  await ui.saveClaudeApiSettings();
  assert.equal(requests.find((request) => request.method === 'POST').body.monthlyCapUsd, null);
});

test('a cap the relay would refuse is stopped before it is sent', async () => {
  requests.length = 0;
  alerts.length = 0;
  const capError = el('claude-api-monthly-cap-error');
  for (const text of ['-5', '0', '1.234']) {
    el('claude-api-monthly-cap-input').value = text;
    await ui.saveClaudeApiSettings();
    // Said under the field, not in an alert.
    assert.equal(capError.hidden, false, text);
    assert.match(capError.textContent, /monthly cap must be an amount of US dollars above 0/, text);
    assert.equal(el('claude-api-monthly-cap-input').getAttribute('aria-invalid'), 'true');
  }
  // Text the number field cannot read: the browser blanks the value and
  // flags it, which must not save "no cap".
  el('claude-api-monthly-cap-input').value = '';
  Object.defineProperty(el('claude-api-monthly-cap-input'), 'validity', { value: { badInput: true }, configurable: true });
  await ui.saveClaudeApiSettings();
  delete el('claude-api-monthly-cap-input').validity;
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(capError.hidden, false);
  // Typing in the field clears it.
  el('claude-api-monthly-cap-input').value = '5';
  el('claude-api-monthly-cap-input').dispatchEvent(new window.Event('input'));
  assert.equal(capError.hidden, true);
  assert.equal(el('claude-api-monthly-cap-input').hasAttribute('aria-invalid'), false);
  assert.equal(ui.parseClaudeApiCapInput('ten').ok, false);
  assert.deepEqual(ui.parseClaudeApiCapInput(' 7 '), { ok: true, capUsd: 7 });
  assert.deepEqual(ui.parseClaudeApiCapInput(''), { ok: true, capUsd: null });
  assert.equal(ui.claudeApiCapInputText(null), '');
  assert.equal(ui.claudeApiCapInputText(12.5), '12.5');
});

test('a refused key shows the relay\'s reason and keeps the tab as it was', async () => {
  alerts.length = 0;
  el('claude-api-monthly-cap-input').value = '';
  postResponder = async () => ({ status: 400, body: { error: 'This is a Claude OAuth access token (it signs in a Claude subscription), not an API key.', code: 'claude-api-key-oauth-access-token' } });
  el('claude-api-key-input').value = TEST_KEY;
  await ui.saveClaudeApiSettings();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /not an API key/);
  assert.doesNotMatch(alerts[0], new RegExp(TEST_KEY));
  assert.equal(ui.claudeApiSettingsState().enabled, true);
  postResponder = async (url, body) => ({ ok: true, ...SETTINGS, ...body, apiKey: undefined });
});

test('a key Anthropic refuses at discovery stays saved, and the status line says so until a discovery succeeds', async () => {
  alerts.length = 0;
  el('claude-api-monthly-cap-input').value = '';
  const refusal = 'Anthropic refused the Claude API key (401): invalid x-api-key';
  postResponder = async (url, body) => ({
    ok: true, ...SETTINGS, ...body, apiKey: undefined, discovered: false,
    discoveryError: { error: refusal, code: 'unauthorized' }, warning: refusal,
  });
  el('claude-api-key-input').value = TEST_KEY;
  await ui.saveClaudeApiSettings();
  assert.equal(alerts.length, 0);
  assert.equal(ui.claudeApiSettingsState().configured, true);
  const status = el('claude-api-settings-status');
  assert.equal(status.dataset.state, 'error');
  assert.match(status.textContent, /API key saved, but Anthropic refused it: .*401/);
  assert.doesNotMatch(status.textContent, new RegExp(TEST_KEY));
  // A plain read (the modal opened again) keeps the verdict.
  await ui.syncClaudeApiSettingsInputs();
  assert.equal(el('claude-api-settings-status').dataset.state, 'error');
  // A save whose discovery went through clears it.
  postResponder = async (url, body) => ({ ok: true, ...SETTINGS, ...body, apiKey: undefined, discoveryError: null });
  el('claude-api-key-input').value = TEST_KEY;
  await ui.saveClaudeApiSettings();
  assert.equal(el('claude-api-settings-status').dataset.state, 'active');
  assert.equal(ui.claudeApiSettingsState().discoveryError, null);
  postResponder = async (url, body) => ({ ok: true, ...SETTINGS, ...body, apiKey: undefined });
});

test('with no key saved the switch, Remove and Refresh are off, and Save asks for a key', async () => {
  ui.applyClaudeApiSettingsState({ ...SETTINGS, configured: false, enabled: false }, { resetInputs: true });
  assert.equal(el('claude-api-enabled-toggle').disabled, true);
  assert.equal(el('claude-api-remove-btn').disabled, true);
  assert.equal(el('claude-api-refresh-btn').disabled, true);
  assert.equal(el('claude-api-key-input').placeholder, 'Claude Console API key…');
  assert.equal(el('claude-api-settings-status').dataset.state, 'unconfigured');
  alerts.length = 0;
  requests.length = 0;
  await ui.saveClaudeApiSettings();
  assert.equal(requests.length, 0);
  assert.match(alerts[0], /Enter an API key from the Claude Console/);
  assert.deepEqual(ui.claudeApiSettingsStatus({ configured: true, enabled: false }).state, 'saved');
});

test('a refusal that moved the default model says so in the status line', () => {
  const refused = { configured: true, enabled: true, discoveryError: { error: 'invalid x-api-key (401)' } };
  assert.doesNotMatch(ui.claudeApiSettingsStatus(refused).text, /default model/);
  const moved = ui.claudeApiSettingsStatus({
    ...refused,
    discoveryError: { ...refused.discoveryError, defaultModelChanged: { from: 'claude-sonnet-6', to: 'claude-opus-5' } },
  });
  assert.equal(moved.state, 'error');
  assert.match(moved.text, /the default model is claude-opus-5 \(was claude-sonnet-6\)\.$/);
});

// ── The composer's billing toggle ────────────────────────────────────────

function billing(provider, extra = {}) {
  return {
    provider,
    pending: null,
    switchedAt: null,
    switchedBy: null,
    switchable: { to: provider === 'claude' ? 'claude-api' : 'claude', allowed: true, code: null, reason: null },
    ...extra,
  };
}

function openChat(id, provider, chatBilling) {
  store.conversations[id] = { id, runtimeProviderType: provider };
  store.setCurrentConv(id);
  usageLimit.setUsageLimitConversation(id, { providerType: provider, billing: chatBilling });
}

const providerChanges = [];

test('the toggle shows in a subscription chat once Claude API is on, and switches it', async () => {
  ui.applyClaudeApiSettingsState(SETTINGS, { resetInputs: true });
  toggle.initClaudeBillingToggle({
    isSharedReaderMode: () => false,
    onConversationProviderChanged: (id, provider) => providerChanges.push([id, provider]),
  });
  openChat('conv-sub', 'claude', billing('claude'));
  const row = el('claude-billing-toggle');
  assert.equal(row.hidden, false);
  const buttons = Array.from(row.querySelectorAll('.claude-billing-option'));
  assert.deepEqual(buttons.map((button) => [button.textContent, button.getAttribute('aria-pressed')]), [
    ['Subscription', 'true'],
    ['API key', 'false'],
  ]);
  assert.match(buttons[1].title, /no prompt cache/);

  requests.length = 0;
  postResponder = async (url) => (url.endsWith('/billing')
    ? { ok: true, conversationId: 'conv-sub', changed: true, provider: 'claude-api', released: false, billing: billing('claude-api') }
    : SETTINGS);
  buttons[1].click();
  await new Promise((resolve) => nativeSetTimeout(resolve, 0));
  const post = requests.find((request) => request.url.endsWith('/api/conversation/conv-sub/billing'));
  assert.deepEqual(post.body, { to: 'claude-api', by: 'user' });
  // The chat follows: its provider, the pressed side, and the cache warning.
  assert.equal(store.conversations['conv-sub'].runtimeProviderType, 'claude-api');
  assert.deepEqual(providerChanges.at(-1), ['conv-sub', 'claude-api']);
  assert.equal(row.dataset.billing, 'claude-api');
  assert.equal(row.querySelector('[aria-pressed="true"]').textContent, 'API key');
  assert.match(row.querySelector('.claude-billing-status').textContent, /no prompt cache and costs more/);
  assert.equal(row.querySelector('.claude-billing-status').dataset.kind, 'warning');
});

test('the waiting state follows the relay\'s billing events', () => {
  usageLimit.applyConversationBilling({
    conversationId: 'conv-sub',
    billing: billing('claude-api', { pending: { to: 'claude-api', waitingFor: 'background', backgroundTaskCount: 2, swapping: false } }),
  });
  const status = el('claude-billing-toggle').querySelector('.claude-billing-status');
  assert.equal(status.textContent, 'Moves to the API key once 2 background tasks finish.');
  assert.equal(status.dataset.kind, 'pending');
});

test('a switch back by another page moves the chat back', () => {
  usageLimit.applyConversationBilling({ conversationId: 'conv-sub', billing: billing('claude') });
  assert.equal(store.conversations['conv-sub'].runtimeProviderType, 'claude');
  assert.equal(el('claude-billing-toggle').dataset.billing, 'claude');
});

test('an unavailable side says why when pressed, and sends nothing', async () => {
  const reason = 'This month\'s Claude API spend has reached the cap set in Settings → Providers → Claude API.';
  usageLimit.applyConversationBilling({
    conversationId: 'conv-sub',
    billing: billing('claude', { switchable: { to: 'claude-api', allowed: false, code: 'CLAUDE_API_CAP_REACHED', reason } }),
  });
  const apiKey = el('claude-billing-toggle').querySelector('[data-billing="claude-api"]');
  assert.equal(apiKey.getAttribute('aria-disabled'), 'true');
  assert.equal(apiKey.title, reason);
  requests.length = 0;
  apiKey.click();
  await new Promise((resolve) => nativeSetTimeout(resolve, 0));
  assert.equal(requests.length, 0);
});

test('a refused switch keeps the chat where it was', async () => {
  usageLimit.applyConversationBilling({ conversationId: 'conv-sub', billing: billing('claude') });
  postResponder = async () => ({ status: 409, body: { ok: false, error: 'claude-opus-9 is not in the Claude API model list.', code: 'CLAUDE_BILLING_MODEL_UNAVAILABLE' } });
  const result = await toggle.switchClaudeBilling('conv-sub', 'claude-api');
  assert.equal(result.ok, false);
  assert.equal(store.conversations['conv-sub'].runtimeProviderType, 'claude');
  assert.equal(el('claude-billing-toggle').dataset.billing, 'claude');
  // The refused side is closed with the relay's reason: a second press asks nothing.
  const apiKey = el('claude-billing-toggle').querySelector('[data-billing="claude-api"]');
  assert.equal(apiKey.getAttribute('aria-disabled'), 'true');
  assert.equal(apiKey.title, 'claude-opus-9 is not in the Claude API model list.');
  assert.equal(usageLimit.conversationBillingState('conv-sub').switchable.code, 'CLAUDE_BILLING_MODEL_UNAVAILABLE');
  requests.length = 0;
  apiKey.click();
  await new Promise((resolve) => nativeSetTimeout(resolve, 0));
  assert.equal(requests.length, 0);
  // The chat's next billing event (a switch, or WP5's when the cap flips)
  // opens it again.
  usageLimit.applyConversationBilling({ conversationId: 'conv-sub', billing: billing('claude') });
  assert.equal(el('claude-billing-toggle').querySelector('[data-billing="claude-api"]').hasAttribute('aria-disabled'), false);
});

test('a refusal "Claude API is off" given since stays, even with the tab on', async () => {
  postResponder = async () => ({ status: 409, body: { ok: false, error: 'Claude API has no key.', code: 'CLAUDE_API_NOT_CONFIGURED' } });
  await toggle.switchClaudeBilling('conv-sub', 'claude-api');
  assert.equal(el('claude-billing-toggle').querySelector('[data-billing="claude-api"]').getAttribute('aria-disabled'), 'true');
  // An unknown refusal closes nothing.
  usageLimit.applyConversationBilling({ conversationId: 'conv-sub', billing: billing('claude') });
  postResponder = async () => ({ status: 500, body: { ok: false, error: 'boom', code: null } });
  await toggle.switchClaudeBilling('conv-sub', 'claude-api');
  assert.equal(el('claude-billing-toggle').querySelector('[data-billing="claude-api"]').hasAttribute('aria-disabled'), false);
});

test('a side refused while Claude API was off opens once the tab turns it on with a key', async () => {
  usageLimit.applyConversationBilling({ conversationId: 'conv-sub', billing: billing('claude') });
  postResponder = async () => ({ status: 409, body: { ok: false, error: 'Claude API is switched off, so this turn did not run.', code: 'CLAUDE_API_NOT_CONFIGURED' } });
  await toggle.switchClaudeBilling('conv-sub', 'claude-api');
  const side = () => el('claude-billing-toggle').querySelector('[data-billing="claude-api"]');
  assert.equal(side().getAttribute('aria-disabled'), 'true');
  // Opening Settings again (the same state) changes nothing.
  ui.applyClaudeApiSettingsState(SETTINGS, { resetInputs: true });
  assert.equal(side().getAttribute('aria-disabled'), 'true');
  // The tab: key removed, then a key saved and Claude API on. Only
  // claude_api_settings_updated arrives, no conversation_billing.
  ui.applyClaudeApiSettingsState({ ...SETTINGS, configured: false, enabled: false }, { resetInputs: true });
  ui.applyClaudeApiSettingsState(SETTINGS, { resetInputs: true });
  assert.equal(side().hasAttribute('aria-disabled'), false);
  assert.equal(usageLimit.conversationBillingState('conv-sub').switchable.allowed, true);
  postResponder = async (url, body) => ({ ok: true, ...SETTINGS, ...body, apiKey: undefined });
});

test('a switch on its way in one chat does not block another chat\'s', async () => {
  store.conversations['conv-a'] = { id: 'conv-a', runtimeProviderType: 'claude' };
  usageLimit.applyConversationBilling({ conversationId: 'conv-a', billing: billing('claude') });
  let release = null;
  const calls = [];
  postResponder = async (url) => {
    calls.push(url);
    if (url.includes('/conv-a/')) await new Promise((resolve) => { release = resolve; });
    return { ok: true, changed: true, provider: 'claude-api', released: false, billing: billing('claude-api') };
  };
  const first = toggle.switchClaudeBilling('conv-a', 'claude-api');
  await new Promise((resolve) => nativeSetTimeout(resolve, 0));
  // conv-a again: refused while its own is on its way; conv-sub: goes.
  assert.equal(await toggle.switchClaudeBilling('conv-a', 'claude-api'), null);
  const second = await toggle.switchClaudeBilling('conv-sub', 'claude-api');
  assert.equal(second.ok, true);
  release();
  assert.equal((await first).ok, true);
  assert.equal(calls.filter((url) => url.includes('/conv-a/')).length, 1);
  assert.equal(calls.filter((url) => url.includes('/conv-sub/')).length, 1);
  usageLimit.applyConversationBilling({ conversationId: 'conv-sub', billing: billing('claude') });
  postResponder = async (url, body) => ({ ok: true, ...SETTINGS, ...body, apiKey: undefined });
});

test('no toggle in other chats, nor in a subscription chat while Claude API is off', () => {
  openChat('conv-copilot', 'github', null);
  assert.equal(el('claude-billing-toggle').hidden, true);
  ui.applyClaudeApiSettingsState({ ...SETTINGS, enabled: false }, { resetInputs: true });
  openChat('conv-sub', 'claude', billing('claude'));
  assert.equal(el('claude-billing-toggle').hidden, true);
  // A chat on the key keeps it, to move back.
  openChat('conv-key', 'claude-api', billing('claude-api'));
  assert.equal(el('claude-billing-toggle').hidden, false);
  ui.applyClaudeApiSettingsState(SETTINGS, { resetInputs: true });
});

test('the dark theme: the tab\'s links take the accent, and New Chat\'s selects the inputs\' colours', async () => {
  const css = indexHtml;
  assert.match(css, /#settings-provider-panel-claude-api \.settings-help a \{ color: var\(--accent\); text-decoration: none; \}/);
  const block = /\/\* The selects take the inputs' look too[^]*?\{([^}]*)\}/.exec(css);
  assert.ok(block, 'the New Chat field rule');
  const selectors = css.slice(css.indexOf("/* The selects take the inputs' look too"), css.indexOf('{', css.indexOf("/* The selects take the inputs' look too")));
  for (const id of ['provider', 'model', 'reasoning', 'context', 'size', 'cwd']) {
    assert.match(selectors, new RegExp(`#new-conversation-${id}-select,`), id);
  }
  assert.match(block[1], /background: var\(--bg3\);/);
  // Disabled ones dim, as the composer's do, so they do not look editable.
  assert.match(css, /#new-conversation-context-select:disabled,\n  #new-conversation-size-select:disabled,\n  #new-conversation-cwd-select:disabled \{\n    opacity: 0\.55;\n    cursor: not-allowed;/);
  assert.match(css, /#new-conversation-reasoning-select:disabled,/);
  // The inline cap error outranks .settings-help (later in the sheet, grey).
  assert.match(css, /\.settings-help\.claude-api-field-error \{ color: var\(--danger\); \}/);
  assert.ok(css.indexOf('.settings-help.claude-api-field-error') < css.indexOf('  .settings-help {'), 'the help rule comes later, so two classes are needed');
  assert.ok(el('claude-api-monthly-cap-error').classList.contains('settings-help'));
  assert.match(block[1], /color: var\(--text\);/);
  // The status line takes the theme's success and danger tokens: the dark
  // ones in dark, readable ones on the light panel.
  assert.match(css, /\.settings-provider-status\[data-state="active"\] \{ color: var\(--success\); \}/);
  assert.match(css, /\.settings-provider-status\[data-state="error"\] \{ color: var\(--danger\); \}/);
  // The cap field's spin buttons are dark in the dark theme.
  assert.match(css, /:root:not\(\[data-theme="light"\]\) input\[type="number"\] \{ color-scheme: dark; \}/);
  assert.equal(el('claude-api-monthly-cap-input').getAttribute('type'), 'number');
  // The Settings toasts ("saved", "switched on") are readable in light too.
  assert.match(css, /:root\[data-theme="light"\] #relay-toast \{ color: #7d4e00; \}/);
  assert.ok(css.indexOf(':root[data-theme="light"] #relay-toast') > css.indexOf('  #relay-toast {'), 'after the base rule');
  // Both key-panel links are inside the help text the rule covers.
  for (const link of el('settings-provider-panel-claude-api').querySelectorAll('a')) {
    assert.ok(link.closest('.settings-help'), link.getAttribute('href'));
  }
});
