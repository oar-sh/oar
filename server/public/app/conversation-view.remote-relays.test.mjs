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

// ─── Agent exchanges: the agent's prompt folds, the reply never does ─────────

const fxAt = (minute, second = 0) => `2026-10-01T10:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
const EXCHANGE = [
  { id: 'fx-u1', role: 'user', text: 'collect the numbers', timestamp: fxAt(0) },
  { id: 'fx-a1', role: 'assistant', text: 'collected', sourceMessageId: 'fx-u1', timestamp: fxAt(0, 20) },
  { id: 'fx-p1', role: 'user', text: HEADER_TEXT, origin: ORIGIN, timestamp: fxAt(1) },
  { id: 'fx-a2', role: 'assistant', text: 'Sam: the suite is green', sourceMessageId: 'fx-p1', timestamp: fxAt(1, 30) },
];
const foldRow = (id) => row(id)?.querySelector(':scope > details.agent-exchange-row') || null;
// Every class of the fold a node carries, the retired member class included.
const classesOf = (id) => ['agent-exchange-head', 'agent-exchange-member', 'agent-exchange-closed']
  .filter((name) => row(id).classList.contains(name));
const liveBubbleClasses = () => [...document.getElementById('thinking-indicator').classList].filter((name) => name.startsWith('agent-exchange-'));

test('an agent\'s prompt folds into one row and its reply stays as it is, like the user\'s own exchange', () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages(EXCHANGE, false, { conversationId: conv });

  const fold = foldRow('fx-p1');
  assert.ok(fold, 'the row is the prompt node\'s own');
  assert.equal(row('fx-p1').firstElementChild, fold);
  assert.equal(fold.open, false);
  assert.equal(fold.querySelector('.agent-exchange-text').textContent, 'note from win-test · report builder');
  assert.equal(fold.querySelector('.agent-exchange-status').textContent, 'answered below');
  assert.equal(fold.querySelector('summary').getAttribute('title'), 'note from win-test · report builder · answered below');
  assert.deepEqual(classesOf('fx-p1'), ['agent-exchange-head', 'agent-exchange-closed']);
  // The reply can carry a line for the user: no class of the fold reaches it.
  assert.deepEqual(classesOf('fx-a2'), []);
  assert.match(row('fx-a2').textContent, /Sam: the suite is green/);
  // Folded, not gone: the badge is rendered as before.
  assert.equal(row('fx-p1').querySelector('.msg-bubble .msg-origin-badge').textContent, '↗ from win-test · “report builder” · claude-sonnet-5');
  for (const id of ['fx-u1', 'fx-a1']) {
    assert.deepEqual(classesOf(id), [], id);
    assert.equal(foldRow(id), null, id);
  }

  // Opened, the class goes; a re-render rebuilds the nodes and keeps it open.
  fold.open = true;
  fold.dispatchEvent(new window.Event('toggle'));
  assert.deepEqual(classesOf('fx-p1'), ['agent-exchange-head']);
  const before = row('fx-p1');
  view.renderMessages([...EXCHANGE, { id: 'fx-u3', role: 'user', text: 'thanks', timestamp: fxAt(2) }], false, { conversationId: conv });
  assert.notEqual(row('fx-p1'), before);
  assert.equal(foldRow('fx-p1').open, true);
  // Folded again by the user: the same through a render.
  foldRow('fx-p1').open = false;
  foldRow('fx-p1').dispatchEvent(new window.Event('toggle'));
  view.renderMessages(EXCHANGE, false, { conversationId: conv });
  assert.deepEqual(classesOf('fx-p1'), ['agent-exchange-head', 'agent-exchange-closed']);
  assert.deepEqual(classesOf('fx-a2'), []);
});

test('a running agent turn\'s live bubble and reply stay out of the fold, and a jump to the prompt opens it', () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'fx-p4', role: 'user', text: 'rerun the suite', origin: ORIGIN, timestamp: fxAt(4) },
  ], false, { conversationId: conv });
  assert.equal(foldRow('fx-p4').querySelector('.agent-exchange-status').textContent, 'no reply yet');

  view.showThinking('fx-p4', false);
  const bubble = document.getElementById('thinking-indicator');
  assert.equal(bubble.previousElementSibling, row('fx-p4'));
  assert.deepEqual(liveBubbleClasses(), []);
  assert.equal(foldRow('fx-p4').querySelector('.agent-exchange-status').textContent, 'working…');

  // The reply arrives the way the socket appends it: a failed turn's note
  // names its prompt only through the anchor.
  view.removeThinking();
  view.appendMessage({
    role: 'assistant',
    text: 'The relay runtime hit a terminal error and could not complete this turn. Error code: relay.copilot-session-lost. Send the message again to retry.',
    timestamp: fxAt(5),
  }, false, 'fx-a4', false, 'fx-p4');
  assert.equal(foldRow('fx-p4').querySelector('.agent-exchange-status').textContent, 'failed');
  assert.deepEqual(classesOf('fx-a4'), []);

  // A jump to the reply leaves the prompt folded; one to the prompt opens it.
  assert.equal(view.focusConversationMessageById('fx-a4'), true);
  assert.equal(foldRow('fx-p4').open, false);
  assert.equal(view.focusConversationMessageById('fx-p4'), true);
  assert.equal(foldRow('fx-p4').open, true);
  assert.deepEqual(classesOf('fx-p4'), ['agent-exchange-head']);
});

// JSDOM fires a details' toggle on a timer, as a browser does on a task.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('an agent\'s prompt stays open while its turn works', async () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'fx-p8', role: 'user', text: 'tidy the legend', origin: ORIGIN, timestamp: fxAt(8) },
  ], false, { conversationId: conv });
  view.showThinking('fx-p8', false);
  try {
    assert.equal(foldRow('fx-p8').open, true);
    assert.equal(foldRow('fx-p8').querySelector('.agent-exchange-status').textContent, 'working…');
    assert.deepEqual(classesOf('fx-p8'), ['agent-exchange-head']);
    // The pass opening it is not a choice of the user's: still open, and
    // still the pass's to close.
    await settle();
    view.syncAgentExchangeFoldsNow();
    assert.equal(foldRow('fx-p8').open, true);
  } finally {
    view.removeThinking();
  }
});

test('an agent\'s prompt folds by itself once it is replied to, and the reply shows', async () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'fx-p9', role: 'user', text: 'check the totals', origin: ORIGIN, timestamp: fxAt(9) },
  ], false, { conversationId: conv });
  view.showThinking('fx-p9', false);
  assert.equal(foldRow('fx-p9').open, true);

  // The reply lands before the opened row's toggle has fired.
  view.removeThinking();
  view.appendMessage({ role: 'assistant', text: 'the totals add up', timestamp: fxAt(9, 40) }, false, 'fx-a9', false, 'fx-p9');
  assert.equal(foldRow('fx-p9').querySelector('.agent-exchange-status').textContent, 'answered below');
  assert.equal(foldRow('fx-p9').open, false);
  assert.deepEqual(classesOf('fx-p9'), ['agent-exchange-head', 'agent-exchange-closed']);
  assert.deepEqual(classesOf('fx-a9'), []);
  await settle();
  view.renderMessages([
    { id: 'fx-p9', role: 'user', text: 'check the totals', origin: ORIGIN, timestamp: fxAt(9) },
    { id: 'fx-a9', role: 'assistant', text: 'the totals add up', sourceMessageId: 'fx-p9', timestamp: fxAt(9, 40) },
  ], false, { conversationId: conv });
  assert.equal(foldRow('fx-p9').open, false);
  assert.deepEqual(classesOf('fx-a9'), []);
});

test('a working prompt the user closed stays closed with its live bubble shown, and opened again once replied it stays open', async () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'fx-p10', role: 'user', text: 'rename the sheet', origin: ORIGIN, timestamp: fxAt(10) },
  ], false, { conversationId: conv });
  view.showThinking('fx-p10', false);
  await settle();
  foldRow('fx-p10').open = false;
  await settle();
  assert.deepEqual(classesOf('fx-p10'), ['agent-exchange-head', 'agent-exchange-closed']);
  assert.deepEqual(liveBubbleClasses(), []);
  view.syncAgentExchangeFoldsNow();
  assert.equal(foldRow('fx-p10').open, false);

  view.removeThinking();
  view.appendMessage({ role: 'assistant', text: 'renamed', timestamp: fxAt(10, 30) }, false, 'fx-a10', false, 'fx-p10');
  assert.equal(foldRow('fx-p10').open, false);
  assert.deepEqual(classesOf('fx-a10'), []);

  foldRow('fx-p10').open = true;
  await settle();
  assert.deepEqual(classesOf('fx-p10'), ['agent-exchange-head']);
  view.renderMessages([
    { id: 'fx-p10', role: 'user', text: 'rename the sheet', origin: ORIGIN, timestamp: fxAt(10) },
    { id: 'fx-a10', role: 'assistant', text: 'renamed', sourceMessageId: 'fx-p10', timestamp: fxAt(10, 30) },
  ], false, { conversationId: conv });
  assert.equal(foldRow('fx-p10').open, true);
});

test('a user message steered into an agent\'s turn: the agent\'s prompt folds, everything else shows', () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'fx-p5', role: 'user', text: 'collect the totals', origin: ORIGIN, timestamp: fxAt(5) },
    { id: 'fx-a5', role: 'assistant', text: 'totals and the extra column', sourceMessageId: 'fx-p5', timestamp: fxAt(7) },
    { id: 'fx-u6', role: 'user', text: 'add a column for May', timestamp: fxAt(6) },
    { id: 'fx-m6', role: 'assistant', kind: 'folded', text: '_(Handled together with the previous reply — this message was steered into that turn.)_', sourceMessageId: 'fx-u6', timestamp: fxAt(7) },
  ], false, { conversationId: conv });
  assert.deepEqual(classesOf('fx-p5'), ['agent-exchange-head', 'agent-exchange-closed']);
  for (const id of ['fx-a5', 'fx-u6', 'fx-m6']) assert.deepEqual(classesOf(id), [], id);
  assert.ok(row('fx-u6').classList.contains('msg-steered'));
});

test('an agent\'s prompt steered into a running turn keeps its bubble and its marker', () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'fx-u11', role: 'user', text: 'collect the totals', timestamp: fxAt(11) },
    { id: 'fx-a11', role: 'assistant', text: 'totals, and the legend the note asked for', sourceMessageId: 'fx-u11', timestamp: fxAt(13) },
    { id: 'fx-p12', role: 'user', text: 'check the legend too', origin: ORIGIN, timestamp: fxAt(12) },
    { id: 'fx-m12', role: 'assistant', kind: 'folded', text: '_(Handled together with the previous reply — this message was steered into that turn.)_', sourceMessageId: 'fx-p12', timestamp: fxAt(13) },
  ], false, { conversationId: conv });
  for (const id of ['fx-u11', 'fx-a11', 'fx-p12', 'fx-m12']) assert.deepEqual(classesOf(id), [], id);
  assert.equal(foldRow('fx-p12'), null);
});

test('an open approval card changes nothing: the prompt stays folded as it was, the live bubble shows', () => {
  messagesEl.innerHTML = '';
  const conv = openConversation();
  view.renderMessages([
    { id: 'fx-p7', role: 'user', text: 'plan the release', origin: ORIGIN, timestamp: fxAt(7) },
  ], false, { conversationId: conv });
  view.showThinking('fx-p7', false);
  assert.ok(foldRow('fx-p7'));

  const board = { id: 'board-fixture-1', conversationId: conv, messageId: 'fx-p7', status: 'pending', title: 'Plan', body: 'ship it', actions: [] };
  store.relayBoards.set(board.id, board);
  try {
    view.syncAgentExchangeFoldsNow();
    assert.ok(foldRow('fx-p7'));
    assert.deepEqual(classesOf('fx-p7'), ['agent-exchange-head']);
    assert.deepEqual(liveBubbleClasses(), []);
  } finally {
    store.relayBoards.delete(board.id);
    view.removeThinking();
  }

  // The renderers of cards and boards have no call into the pass left.
  for (const file of ['./ask-user-view.js', './relay-board-view.js', './bootstrap.js']) {
    assert.equal(fs.readFileSync(new URL(file, import.meta.url), 'utf8').includes('syncAgentExchangeFolds'), false, file);
  }
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
