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
const originUi = await import('./conversation-origin-ui.js');
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

// ─── Sessions an agent on this relay started (origin.local) ──────────────────

const LOCAL_ORIGIN = {
  kind: 'agent',
  local: true,
  relayId: 'relay-a',
  relayName: 'win-test',
  conversationId: 'c-lead',
  conversationTitle: 'release checklist',
  provider: 'claude',
  model: 'claude-sonnet-5',
};
const sidebarItem = (title) => [...document.querySelectorAll('#conv-list .conv-item')]
  .find((item) => item.querySelector('.conv-title').textContent.startsWith(title));
const headerOrigin = () => document.getElementById('chat-title-origin');

function seedAgentSessions() {
  for (const key of Object.keys(conversations)) delete conversations[key];
  conversations['c-lead'] = {
    id: 'c-lead', title: 'release checklist', updatedAt: '2026-09-27T10:00:00.000Z', messageCount: 6,
  };
  conversations['c-made'] = {
    id: 'c-made', title: 'docs pass', updatedAt: '2026-09-27T10:05:00.000Z', messageCount: 2, origin: LOCAL_ORIGIN,
  };
  conversations['c-remote'] = {
    id: 'c-remote', title: 'report builder', updatedAt: '2026-09-27T09:00:00.000Z', messageCount: 2, origin: ORIGIN,
  };
}

test('the sidebar marks a session an agent here started, and the marker opens that agent\'s conversation', async () => {
  seedAgentSessions();
  setCurrentConv('c-made');
  journal.renderConvList();

  const marker = sidebarItem('docs pass').querySelector('.conv-meta button.conv-origin-marker');
  assert.ok(marker, 'the marker is a button inside the row');
  assert.equal(marker.textContent, 'via agent · “release checklist”');
  assert.equal(marker.dataset.originConversationId, 'c-lead');
  // The other rows are as before.
  assert.equal(sidebarItem('report builder').querySelector('.conv-origin-marker').textContent, '↗ win-test');
  assert.equal(sidebarItem('report builder').querySelector('button.conv-origin-marker'), null);
  assert.equal(sidebarItem('release checklist').querySelector('.conv-origin-marker'), null);

  // JSDOM does not run the inline handler; call what it names. The row's own
  // click (open THIS conversation) must not fire as well.
  assert.equal(marker.getAttribute('onclick'), 'openOriginConversation(event, this)');
  let stopped = false;
  await journal.openOriginConversation({ stopPropagation() { stopped = true; }, preventDefault() {} }, marker);
  assert.equal(stopped, true);
  assert.equal(store.currentConvId, 'c-lead');
  assert.equal(document.getElementById('chat-title').textContent, 'release checklist');
  assert.ok(sidebarItem('release checklist').classList.contains('active'));
});

test('the sidebar marker follows a rename and turns into plain text when that conversation is deleted', async () => {
  seedAgentSessions();
  setCurrentConv('c-made');
  conversations['c-lead'] = { ...conversations['c-lead'], title: 'release 2 checklist' };
  journal.renderConvList();
  const stale = sidebarItem('docs pass').querySelector('button.conv-origin-marker');
  assert.equal(stale.textContent, 'via agent · “release 2 checklist”');

  delete conversations['c-lead'];
  // A click on a marker drawn before the deletion goes nowhere.
  await journal.openOriginConversation({ stopPropagation() {}, preventDefault() {} }, stale);
  assert.equal(store.currentConvId, 'c-made');

  const item = sidebarItem('docs pass');
  assert.equal(item.querySelector('button.conv-origin-marker'), null);
  const plain = item.querySelector('span.conv-origin-marker');
  // The title the conversation had when the session was created.
  assert.equal(plain.textContent, 'via agent · “release checklist”');
});

test('the header shows "via agent" for a local origin only', () => {
  seedAgentSessions();
  assert.equal(headerOrigin().hasAttribute('hidden'), true, 'the markup ships hidden');

  setCurrentConv('c-made');
  originUi.syncConversationOriginHeader();
  assert.equal(headerOrigin().hidden, false);
  const button = headerOrigin().querySelector('button.conv-origin-agent');
  assert.equal(button.textContent, 'via agent · “release checklist”');
  assert.equal(button.dataset.originConversationId, 'c-lead');
  // Synced again with nothing changed: the same node, so a tap is never lost.
  originUi.syncConversationOriginHeader();
  assert.equal(headerOrigin().querySelector('button'), button);

  // Another relay's agent, a person, no conversation: no header line.
  for (const id of ['c-remote', 'c-lead', null]) {
    setCurrentConv(id);
    originUi.syncConversationOriginHeader();
    assert.equal(headerOrigin().hidden, true);
    assert.equal(headerOrigin().textContent, '');
  }

  // The orchestrating conversation is gone: text, no button.
  delete conversations['c-lead'];
  setCurrentConv('c-made');
  originUi.syncConversationOriginHeader();
  assert.equal(headerOrigin().hidden, false);
  assert.equal(headerOrigin().querySelector('button'), null);
  assert.equal(headerOrigin().textContent, 'via agent · “release checklist”');
});

test('a conversation opened before the list knew it takes its origin from the detail answer', () => {
  seedAgentSessions();
  delete conversations['c-made'];
  setCurrentConv('c-made');
  journal.applyLoadedConversationState('c-made', { title: 'docs pass', messages: [], origin: LOCAL_ORIGIN });
  assert.deepEqual(conversations['c-made'].origin, LOCAL_ORIGIN);
  originUi.syncConversationOriginHeader();
  assert.equal(headerOrigin().querySelector('button').textContent, 'via agent · “release checklist”');

  // An answer without the field (an older relay) keeps what the list said; an
  // explicit null is a real "nobody but a person".
  journal.applyLoadedConversationState('c-made', { title: 'docs pass', messages: [] });
  assert.deepEqual(conversations['c-made'].origin, LOCAL_ORIGIN);
  journal.applyLoadedConversationState('c-made', { title: 'docs pass', messages: [], origin: null });
  assert.equal(conversations['c-made'].origin, null);
  originUi.syncConversationOriginHeader();
  assert.equal(headerOrigin().hidden, true);
});

test('the header line sits between the title and the folder, and the app keeps it in sync', () => {
  const slot = document.getElementById('chat-title-slot');
  assert.deepEqual([...slot.children].map((node) => node.id), [
    'chat-title-primary', 'chat-title-origin', 'chat-title-cwd', 'chat-title-session-usage',
  ]);
  // bootstrap.js cannot be loaded here as a whole: its header sync has to call
  // this one, and the marker's inline handler has to exist on window.
  const bootstrap = fs.readFileSync(new URL('./bootstrap.js', import.meta.url), 'utf8');
  // A Windows checkout with core.autocrlf reads the file with CRLF endings.
  assert.match(bootstrap, /\r?\n {2}syncConversationOriginHeader\(\);\r?\n/);
  assert.ok(bootstrap.includes('window.openOriginConversation = openOriginConversation;'));
});

test('a prompt from an agent on this relay carries a "via agent" badge that opens its conversation', () => {
  seedAgentSessions();
  messagesEl.innerHTML = '';
  setCurrentConv('c-made');
  view.renderMessages([
    { id: 'u9', role: 'user', text: 'check the docs build', origin: LOCAL_ORIGIN, timestamp: '2026-09-27T10:05:00.000Z' },
  ], false, { conversationId: 'c-made' });
  const bubble = row('u9').querySelector('.msg-bubble');
  assert.equal(bubble.querySelector('.msg-origin a'), null);
  const badge = bubble.querySelector('.msg-origin button.msg-origin-badge');
  assert.equal(badge.textContent, 'via agent · “release checklist” · claude-sonnet-5');
  assert.equal(badge.dataset.originConversationId, 'c-lead');
  assert.match(bubble.textContent, /check the docs build/);
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
