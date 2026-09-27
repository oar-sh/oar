import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

import { withRemotePromptHeader } from '../../../shared/remote-relay-contract.mjs';

// Remote-relay pieces of the transcript, the sidebar and the composer, on the
// app's REAL index.html (scripts not executed) with the real modules on top:
// the provenance badge and hidden header on user bubbles, the sidebar marker,
// and the @relay popup wired through the composer's own input/key handlers.

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
globalThis.Event = window.Event;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.CSS = { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const store = await import('./store.js');
const view = await import('./conversation-view.js');
const journal = await import('./journal-view.js');
const relays = await import('./remote-relays-store.mjs');
const { initSlashAutocomplete, isSlashAutocompleteOpen, closeSlashAutocomplete } = await import('./slash-autocomplete.mjs');
const { initMentionAutocomplete, isMentionAutocompleteOpen, closeMentionAutocomplete } = await import('./mention-autocomplete.mjs');

const { conversations, setCurrentConv } = store;
const messagesEl = document.getElementById('messages');
initSlashAutocomplete();
initMentionAutocomplete();

const ORIGIN = {
  kind: 'agent',
  relayId: 'relay-a',
  relayName: 'win-test',
  relayUrl: 'https://relay-a.example.test',
  conversationId: 'conv-src',
  conversationTitle: 'report builder',
  provider: 'claude',
  model: 'claude-sonnet-5',
  hops: 1,
};
const HEADER_TEXT = withRemotePromptHeader('run the suite and report back', ORIGIN);

let seq = 0;
function openConversation(extra = {}) {
  seq += 1;
  const id = `conv-${seq}`;
  conversations[id] = { id, title: 'Remote work', runtimeProviderType: 'claude', updatedAt: new Date().toISOString(), messageCount: 2, ...extra };
  setCurrentConv(id);
  return id;
}

const row = (id) => [...messagesEl.querySelectorAll(':scope > .msg')].find((node) => node.dataset.messageId === id) || null;

test('a user bubble with origin shows the badge and hides the header line', () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'u1', role: 'user', text: HEADER_TEXT, origin: ORIGIN, timestamp: '2026-09-27T10:00:00.000Z' },
    { id: 'a1', role: 'assistant', text: 'done', sourceMessageId: 'u1', timestamp: '2026-09-27T10:00:05.000Z' },
  ], false, { conversationId: conv });

  const bubble = row('u1').querySelector('.msg-bubble');
  const badge = bubble.querySelector('.msg-origin a.msg-origin-badge');
  assert.ok(badge, 'the badge renders inside the bubble');
  assert.equal(badge.textContent, '↗ from win-test · “report builder” · claude-sonnet-5');
  assert.equal(badge.getAttribute('href'), 'https://relay-a.example.test/?conv=conv-src');
  assert.equal(badge.getAttribute('target'), '_blank');
  assert.match(badge.getAttribute('rel'), /noopener/);
  // Directly above the text, and the header line itself is gone.
  const text = bubble.querySelector('.msg-origin').nextElementSibling;
  assert.equal(text.tagName, 'P');
  assert.equal(text.textContent, 'run the suite and report back');
  assert.doesNotMatch(bubble.textContent, /Remote prompt from an agent/);
  assert.match(bubble.textContent, /run the suite and report back/);
  assert.ok(row('u1').classList.contains('msg-from-remote-relay'));
  // Replies carry no badge.
  assert.equal(row('a1').querySelector('.msg-origin'), null);
});

test('without origin the text is left exactly as typed and no badge renders', () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'u2', role: 'user', text: HEADER_TEXT, timestamp: '2026-09-27T10:00:00.000Z' },
  ], false, { conversationId: conv });
  const bubble = row('u2').querySelector('.msg-bubble');
  assert.equal(bubble.querySelector('.msg-origin'), null);
  assert.match(bubble.textContent, /Remote prompt from an agent on relay "win-test"/);
});

test('a stray mention hint never shows on a user bubble', () => {
  messagesEl.innerHTML = '';
  openConversation();
  view.appendMessage({
    role: 'user',
    text: 'ask @linux-test to run it\n\n<system_reminder>The user mentioned the remote OAR relay "linux-test" (online, OAR 0.9.4). Use the remote_relay tool for work there.</system_reminder>',
    timestamp: '2026-09-27T10:00:00.000Z',
  }, false, 'u3', true);
  const bubble = row('u3').querySelector('.msg-bubble');
  assert.doesNotMatch(bubble.textContent, /system_reminder|The user mentioned the remote OAR relay/);
  assert.match(bubble.textContent, /ask @linux-test to run it/);
});

test('the sidebar marks conversations another relay created', () => {
  for (const key of Object.keys(conversations)) delete conversations[key];
  conversations['c-remote'] = {
    id: 'c-remote', title: 'report builder', updatedAt: '2026-09-27T10:00:00.000Z', messageCount: 2, origin: ORIGIN,
  };
  conversations['c-local'] = {
    id: 'c-local', title: 'sidebar polish', updatedAt: '2026-09-27T09:00:00.000Z', messageCount: 4,
  };
  journal.renderConvList();
  const items = [...document.querySelectorAll('#conv-list .conv-item')];
  assert.equal(items.length, 2);
  const remote = items.find((item) => item.querySelector('.conv-title').textContent.startsWith('report builder'));
  const local = items.find((item) => item.querySelector('.conv-title').textContent.startsWith('sidebar polish'));
  assert.equal(remote.querySelector('.conv-meta .conv-origin-marker').textContent, '↗ win-test');
  assert.equal(local.querySelector('.conv-origin-marker'), null);
});

// ─── Composer: slash menu and @relay popup share the keyboard ────────────────

const input = document.getElementById('msg-input');
input.addEventListener('keydown', (event) => view.handleKey(event));
// The textarea's inline oninput is not executed by JSDOM; mirror it.
input.addEventListener('input', () => view.updateComposerSlashMenu(input));

function type(text) {
  input.value = text;
  input.selectionStart = input.selectionEnd = text.length;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function press(key, modifiers = {}) {
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
  input.dispatchEvent(event);
  return event.defaultPrevented;
}

test('the composer routes keys to whichever popup is open, never both', () => {
  closeSlashAutocomplete();
  closeMentionAutocomplete();
  relays.setRemoteRelaysSnapshot({
    relays: [{ id: 'rr-1', name: 'linux-test', url: 'https://relay-b.example.test', host: 'relay-b.example.test', lastStatus: 'online' }],
    self: { name: 'win-test' },
  });
  input.focus();

  type('/');
  assert.equal(isSlashAutocompleteOpen(), true);
  assert.equal(isMentionAutocompleteOpen(), false);
  assert.equal(press('Tab'), true);
  assert.equal(input.value, '/compact ');

  type('please ask @li');
  assert.equal(isSlashAutocompleteOpen(), false);
  assert.equal(isMentionAutocompleteOpen(), true);
  assert.equal(document.getElementById('mention-autocomplete-popup').classList.contains('visible'), true);
  assert.equal(press('Tab'), true);
  assert.equal(input.value, 'please ask @linux-test ');
  assert.equal(isMentionAutocompleteOpen(), false);

  // @file: tokens are left alone by both.
  type('open @file:src/app.js');
  assert.equal(isMentionAutocompleteOpen(), false);
  assert.equal(isSlashAutocompleteOpen(), false);
  assert.equal(press('Tab'), false);
  assert.equal(input.value, 'open @file:src/app.js');

  // Escape on the popup closes it without leaking to document handlers.
  type('@');
  let leaked = false;
  const onEscape = () => { leaked = true; };
  document.addEventListener('keydown', onEscape);
  try {
    assert.equal(press('Escape'), true);
  } finally {
    document.removeEventListener('keydown', onEscape);
  }
  assert.equal(isMentionAutocompleteOpen(), false);
  assert.equal(leaked, false);
});
