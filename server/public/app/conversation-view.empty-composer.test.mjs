import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The composer with no chat open, on the real index.html in JSDOM (harness
// as in journal-view.claude-cloud.test.mjs): while Copilot is off it is not
// sendable (a send would start a chat on a provider nobody picked) and its
// button opens New Chat; with no provider on, the setup lock; with Copilot
// on, as before.
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


globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

await import('./store.js');
const view = await import('./conversation-view.js');
const readiness = await import('./provider-readiness.mjs');
const { NEW_CHAT_FIRST_TEXT, SETUP_REQUIRED_TEXT } = await import('./composer-control-state.mjs');

const OFF = { enabled: false };
const CATALOG = { models: ['auto', 'gpt-5.4-mini'], source: 'server-discovery:boot' };
const show = ({ copilot, claude }) => {
  readiness.updateProviderReadinessInputs({ copilot: { enabled: copilot }, claude: { enabled: claude }, openai: OFF, cursor: OFF, grok: OFF, catalog: CATALOG });
  view.syncComposerButtonState();
  const input = document.getElementById('msg-input');
  const button = document.getElementById('send-btn');
  return { disabled: input.disabled, placeholder: input.placeholder, action: button.dataset.action, label: button.textContent, buttonDisabled: button.disabled };
};

test('Copilot off and Claude on: locked, a neutral note, and the button opens New Chat', () => {
  assert.deepEqual(show({ copilot: false, claude: true }), {
    disabled: true, placeholder: NEW_CHAT_FIRST_TEXT, action: 'open-new-chat', label: 'New chat', buttonDisabled: false,
  });
});

test('Copilot off and nothing else on: the setup lock', () => {
  const state = show({ copilot: false, claude: false });
  assert.equal(state.disabled, true);
  assert.equal(state.placeholder, SETUP_REQUIRED_TEXT);
  assert.equal(state.action, 'send');
  assert.equal(state.buttonDisabled, true);
});

test('Copilot on: the composer is as before, unlocked', () => {
  const state = show({ copilot: true, claude: true });
  assert.equal(state.disabled, false);
  assert.equal(state.action, 'send');
  assert.equal(state.label, 'Send');
});
