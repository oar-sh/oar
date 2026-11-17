import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// Compacting with a typed "/compact", on the real index.html in JSDOM
// (harness as in conversation-view.empty-composer.test.mjs): a compact the
// relay refuses (the chat's provider is off) shows the relay's own text, and
// the command stays in the composer; another chat opened while the compact
// runs keeps its composer.
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

const SOURCE = 'conv-fixture-source';
const TARGET = 'conv-fixture-target';
const OTHER = 'conv-fixture-other';
const REFUSAL_TEXT = 'Copilot is switched off on this relay, so this chat was not compacted. Nothing was changed. Switch it on in Settings → Providers → Copilot.';

// The compact route's answer for the next request (a promise to hold it);
// every other request is a plain success, and draft saves are recorded.
let compactAnswer = null;
const draftSaves = [];
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/draft')) draftSaves.push({ url: String(url), body: JSON.parse(options.body || '{}') });
  if (String(url).endsWith(`/api/conversation/${SOURCE}/compact`)) {
    const { status, body } = await compactAnswer;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
const alerts = [];
globalThis.alert = (text) => { alerts.push(String(text)); };
globalThis.confirm = () => true;
const opened = [];
window.refreshConversations = async () => {};
window.openConversation = async (id) => { opened.push(id); };
const originalError = console.error;
console.error = () => {};

const store = await import('./store.js');
const view = await import('./conversation-view.js');

function openSource() {
  alerts.length = 0;
  opened.length = 0;
  draftSaves.length = 0;
  store.conversations[SOURCE] = { id: SOURCE, title: 'Release checklist', archived: false };
  store.setCurrentConv(SOURCE);
}

const refused = () => ({
  status: 409,
  body: { ok: false, code: 'COPILOT_SWITCHED_OFF', error: REFUSAL_TEXT, provider: 'github', conversationId: SOURCE, compacted: false },
});

async function settled(check) {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'settled');
}

test.after(() => { console.error = originalError; });

test('a refused compact shows the relay\'s reason', async () => {
  openSource();
  compactAnswer = refused();
  await view.compactCurrentConversation();
  assert.deepEqual(alerts, [REFUSAL_TEXT]);
  assert.deepEqual(opened, []);
  assert.equal(store.currentConvId, SOURCE);
});

test('a typed "/compact" that the relay refuses stays in the composer', async () => {
  openSource();
  compactAnswer = refused();
  const input = document.getElementById('msg-input');
  input.value = '/compact';
  await view.sendMessage();
  await settled(() => alerts.length > 0);
  assert.deepEqual(alerts, [REFUSAL_TEXT]);
  assert.equal(input.value, '/compact');
});

test('a typed "/compact" that the relay makes clears the composer and opens the new chat', async () => {
  openSource();
  compactAnswer = { status: 200, body: { ok: true, compactedConversationId: TARGET, conversationId: TARGET } };
  const input = document.getElementById('msg-input');
  input.value = '/compact';
  await view.sendMessage();
  await settled(() => opened.length > 0);
  assert.deepEqual(opened, [TARGET]);
  assert.equal(input.value, '');
  assert.deepEqual(alerts, []);
});

test('the new chat opened by the relay\'s event during the refresh leaves the compacted chat\'s draft empty', async () => {
  openSource();
  compactAnswer = { status: 200, body: { ok: true, compactedConversationId: TARGET, conversationId: TARGET } };
  // The socket's conversation_compacted handler wins the race: it opens the
  // new chat while the compact still refreshes the list, and opening a chat
  // saves the draft of the one left (journal-view.js openConversation).
  let saved = null;
  window.refreshConversations = async () => {
    if (store.currentConvId !== SOURCE) return;
    saved = view.flushConversationDraft(SOURCE);
    store.conversations[TARGET] = { id: TARGET, title: 'Release checklist (compacted)', archived: false };
    store.setCurrentConv(TARGET);
  };
  const input = document.getElementById('msg-input');
  input.value = '/compact';
  await view.sendMessage();
  await settled(() => saved !== null);
  await saved;
  const sourceSaves = draftSaves.filter((save) => save.url.includes(SOURCE));
  assert.ok(sourceSaves.length > 0, 'the compacted chat\'s draft was saved');
  assert.equal(sourceSaves.at(-1).body.draftText, '');
  assert.equal(input.value, '');
  assert.deepEqual(opened, [], 'opened once, by the event');
  assert.deepEqual(alerts, []);
  window.refreshConversations = async () => {};
});

test('a chat opened while the compact runs keeps its composer and its draft', async () => {
  openSource();
  let answer = null;
  compactAnswer = new Promise((resolve) => { answer = resolve; });
  let refreshed = 0;
  window.refreshConversations = async () => { refreshed += 1; };
  const input = document.getElementById('msg-input');
  input.value = '/compact';
  await view.sendMessage();
  // The user opens another chat, whose composer holds its own draft.
  store.conversations[OTHER] = { id: OTHER, title: 'Other work', archived: false };
  store.setCurrentConv(OTHER);
  input.value = 'draft of the other chat';
  answer({ status: 200, body: { ok: true, compactedConversationId: TARGET, conversationId: TARGET } });
  await settled(() => refreshed > 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(input.value, 'draft of the other chat');
  assert.deepEqual(opened, [], 'the new chat is not opened over the other one');
  assert.equal(store.currentConvId, OTHER);
  assert.deepEqual(draftSaves.filter((save) => save.url.includes(OTHER) && !save.body.draftText), []);
  assert.deepEqual(alerts, []);
});
