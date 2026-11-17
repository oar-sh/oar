import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// A Copilot chat's draft while Copilot is switched off, on the real
// index.html in JSDOM (harness as in journal-view.claude-cloud.test.mjs): the
// locked composer shows the draft read-only and never writes or clears it,
// also when the lock lands on a composer that still holds another chat's text
// (switching back to the chat: the lock disables the focused textarea, whose
// blur flushes it).
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


const requests = [];
const CONVERSATIONS = {
  'conv-gh': { id: 'conv-gh', title: 'Copilot chat', messages: [], draftText: 'locked draft', draftUpdatedAt: '2026-11-17T01:00:00.000Z', runtimeSession: { providerType: 'github', model: 'gpt-5.4-mini' } },
  'conv-claude': { id: 'conv-claude', title: 'Claude chat', messages: [], draftText: '', draftUpdatedAt: null, runtimeSession: { providerType: 'claude', providerModel: 'claude-sonnet-5' } },
};
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const entry = { path: parsed.pathname, method: String(opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null };
  requests.push(entry);
  const conversation = CONVERSATIONS[parsed.pathname.replace('/api/conversation/', '')];
  let answer = {};
  if (conversation && entry.method === 'GET') answer = conversation;
  if (entry.method === 'PATCH' && parsed.pathname.endsWith('/draft')) {
    answer = { ok: true, draftText: entry.body?.draftText ?? '', draftUpdatedAt: '2026-11-17T01:05:00.000Z' };
  }
  return { ok: true, status: 200, json: async () => answer };
};

const store = await import('./store.js');
const journal = await import('./journal-view.js');
const view = await import('./conversation-view.js');
const readiness = await import('./provider-readiness.mjs');

for (const conversation of Object.values(CONVERSATIONS)) {
  store.conversations[conversation.id] = { id: conversation.id, title: conversation.title, runtimeProviderType: conversation.runtimeSession.providerType, draftText: conversation.draftText, draftUpdatedAt: conversation.draftUpdatedAt };
}
const OFF = { enabled: false };
const CATALOG = { models: ['claude-sonnet-5'], source: 'server-discovery:boot' };
const setCopilot = (enabled) => {
  readiness.updateProviderReadinessInputs({ copilot: { enabled }, claude: { enabled: true }, openai: OFF, cursor: OFF, grok: OFF, catalog: CATALOG });
  view.syncComposerButtonState();
};
const input = () => document.getElementById('msg-input');
const draftSaves = (id) => requests.filter((request) => request.method === 'PATCH' && request.path === `/api/conversation/${id}/draft`);
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('Copilot off: the Copilot chat shows its draft read-only, and a flush of the locked composer writes nothing new', async () => {
  setCopilot(false);
  await journal.openConversation('conv-gh');
  await settle();
  view.syncComposerButtonState();
  assert.equal(input().disabled, true, 'locked');
  assert.equal(input().value, 'locked draft', 'the draft shows');
  // The switch back from another chat: the lock lands while the composer still
  // holds that chat's text, and the blur flushes it.
  input().value = '';
  requests.length = 0;
  await view.flushConversationDraft('conv-gh');
  await settle();
  assert.equal(draftSaves('conv-gh').some((request) => request.body?.draftText === ''), false, 'the draft was not cleared');
  assert.equal(store.conversations['conv-gh'].draftText, 'locked draft');
});

test('away and back while off, then Copilot on again: the draft is still there and editable', async () => {
  input().value = 'locked draft';
  await journal.openConversation('conv-claude');
  await settle();
  view.syncComposerButtonState();
  assert.equal(input().disabled, false, 'a Claude chat is not locked');
  requests.length = 0;
  await journal.openConversation('conv-gh');
  await settle();
  view.syncComposerButtonState();
  assert.equal(input().value, 'locked draft');
  assert.equal(draftSaves('conv-gh').some((request) => request.body?.draftText === ''), false);
  setCopilot(true);
  assert.equal(input().disabled, false);
  assert.equal(input().value, 'locked draft');
});
