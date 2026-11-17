import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// New Chat's provider list with the Copilot switch, on the real index.html in
// JSDOM (harness as in journal-view.claude-cloud.test.mjs): Copilot is listed
// only while it is on, nothing is forced first, the last used provider is
// preselected, and with nothing on the modal opens with nothing to start.
const nativeSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const timer = nativeSetInterval(...args);
  timer?.unref?.();
  return timer;
};
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLDetailsElement = window.HTMLDetailsElement;
globalThis.NodeFilter = window.NodeFilter;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

// GET /api/models as the relay answers it: Copilot's models only while it is on.
const COPILOT_CATALOG = {
  models: ['auto', 'gpt-5.4-mini'],
  providersByModel: { 'gpt-5.4-mini': ['github-copilot'] },
  reasoningByModel: { auto: ['low', 'medium', 'high'], 'gpt-5.4-mini': ['low', 'medium', 'high'] },
};
function catalog() {
  const copilotOn = settings.copilot.enabled !== false;
  const claudeOn = settings.claude.enabled === true;
  return {
    models: [...(claudeOn ? ['claude-sonnet-5'] : []), ...(copilotOn ? COPILOT_CATALOG.models : [])],
    currentModel: copilotOn ? 'gpt-5.4-mini' : '',
    defaultModel: copilotOn ? 'gpt-5.4-mini' : '',
    source: 'server-discovery:boot',
    providersByModel: { ...(claudeOn ? { 'claude-sonnet-5': ['claude'] } : {}), ...(copilotOn ? COPILOT_CATALOG.providersByModel : {}) },
    reasoningByModel: { ...(claudeOn ? { 'claude-sonnet-5': ['none', 'low', 'high'] } : {}), ...(copilotOn ? COPILOT_CATALOG.reasoningByModel : {}) },
    reasoningByProvider: claudeOn ? { claude: { 'claude-sonnet-5': ['none', 'low', 'high'] } } : {},
    modelMetadataByModel: claudeOn ? { 'claude-sonnet-5': { provider: 'claude' } } : {},
    metadataValid: true,
    reasoningMetadataValid: true,
  };
}
const CLAUDE_ON = { configured: true, enabled: true, model: 'claude-sonnet-5', models: ['claude-sonnet-5'], availableModels: ['claude-sonnet-5'] };
const OFF = { configured: false, enabled: false, model: '', models: [] };

const requests = [];
const settings = { copilot: { engine: 'sdk', engines: ['sdk'], enabled: false, cliFound: true }, claude: CLAUDE_ON };
const routes = {
  '/api/models': () => catalog(),
  '/api/settings/copilot': () => settings.copilot,
  '/api/settings/claude': () => settings.claude,
  '/api/settings/openai': () => OFF,
  '/api/settings/cursor': () => OFF,
  '/api/settings/grok': () => OFF,
  '/api/conversation/bootstrap': () => ({ conversationId: 'conv-new', preferredModel: 'claude-sonnet-5', preferredReasoningEffort: 'none' }),
  '/api/conversation/conv-new': () => ({ id: 'conv-new', title: 'New Conversation', messages: [], runtimeSession: { providerType: 'claude', providerModel: 'claude-sonnet-5' } }),
};
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  requests.push({ path: parsed.pathname, method: String(opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null });
  const answer = routes[parsed.pathname] ? await routes[parsed.pathname]() : {};
  return { ok: true, status: 200, json: async () => answer };
};

await import('./store.js');
const journal = await import('./journal-view.js');

const el = (id) => document.getElementById(id);
const optionValues = (id) => Array.from(el(id).options).map((option) => option.value);
const modalVisible = () => el('new-conversation-model-modal').classList.contains('visible');

test('Copilot off and only Claude on: Claude alone, preselected, the row hidden; the chat starts on Claude and is remembered', async () => {
  localStorage.removeItem('oar_new_chat_provider');
  await journal.newConversation();
  assert.equal(modalVisible(), true);
  assert.deepEqual(optionValues('new-conversation-provider-select'), ['claude']);
  assert.equal(el('new-conversation-provider-select').value, 'claude');
  assert.equal(el('new-conversation-provider-row').hidden, true);
  assert.equal(el('new-conversation-model-confirm').hidden, false);
  assert.deepEqual(optionValues('new-conversation-model-select'), ['claude-sonnet-5']);
  requests.length = 0;
  await journal.confirmNewConversationModel();
  const bootstrap = requests.find((request) => request.path === '/api/conversation/bootstrap');
  assert.equal(bootstrap.body.providerType, 'claude');
  assert.equal(bootstrap.body.model, 'claude-sonnet-5');
  assert.equal(localStorage.getItem('oar_new_chat_provider'), 'claude');
});

test('Copilot on beside Claude: both listed, the last used preselected', async () => {
  settings.copilot = { engine: 'sdk', engines: ['sdk'], enabled: true, cliFound: true };
  await journal.newConversation();
  assert.deepEqual(optionValues('new-conversation-provider-select'), ['github', 'claude']);
  assert.equal(el('new-conversation-provider-select').value, 'claude');
  assert.equal(el('new-conversation-provider-row').hidden, false);
  journal.closeNewConversationModelModal();
  localStorage.removeItem('oar_new_chat_provider');
  await journal.newConversation();
  assert.equal(el('new-conversation-provider-select').value, 'github', 'none remembered: the first listed');
  journal.closeNewConversationModelModal();
});

test('nothing on: the modal opens in its setup state with nothing to start', async () => {
  settings.copilot = { engine: 'sdk', engines: ['sdk'], enabled: false, cliFound: false };
  settings.claude = OFF;
  await journal.newConversation();
  assert.equal(modalVisible(), true);
  assert.deepEqual(optionValues('new-conversation-provider-select'), []);
  assert.equal(el('new-conversation-model-confirm').hidden, true);
  assert.equal(el('new-conversation-open-settings').hidden, false);
  assert.equal(el('new-conversation-setup-note').hidden, false);
  journal.closeNewConversationModelModal();
  settings.claude = CLAUDE_ON;
});
