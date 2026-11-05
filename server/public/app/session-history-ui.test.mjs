import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The wiring on the real index.html: the overlay ids, the observer, the
// popstate listener, the address and the title.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/oar/?theme=dark' });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.MutationObserver = window.MutationObserver;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
let phone = false;
window.matchMedia = () => ({ get matches() { return phone; }, addEventListener() {}, removeEventListener() {} });

const { conversations } = await import('./store.js');
const ui = await import('./session-history-ui.js');
const { GONE_STORAGE_KEY } = await import('./session-history.mjs');
const { openContextMenu } = await import('./context-menu.mjs');

const el = (id) => document.getElementById(id);
// Generous: the observer and the settle run on later ticks, and a busy machine delays them.
const wait = (ms = 120) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 120)));
const opened = [];
const closed = [];
const hide = (id) => () => { closed.push(id); el(id).classList.remove('visible'); };
const unshow = (id) => () => { closed.push(id); el(id).hidden = true; };
// What the Inbox's and Status's closers were told: [name, options].
const viewCloses = [];

conversations['conv-kestrel'] = { id: 'conv-kestrel', title: 'Kestrel ringing log' };
conversations['conv-plover'] = { id: 'conv-plover', title: 'Plover beach count' };

ui.initSessionHistory({
  openConversation: (id, options) => { opened.push([id, options]); ui.noteConversationShown(id, options?.history); },
  openSidebar: () => el('sidebar').classList.add('open'),
  closeSidebar: () => { closed.push('sidebar'); el('sidebar').classList.remove('open'); },
  closeComposerSettings: () => { closed.push('composer-settings'); el('composer-settings').hidden = true; },
  closeChatActionsMenu: () => { closed.push('chat-actions-menu'); el('chat-actions-menu').hidden = true; },
  closeSummaryModal: hide('summary-modal'),
  closeSettingsModal: hide('settings-modal'),
  closeMessageSearchModal: hide('message-search-modal'),
  closeRepoBrowser: hide('repo-browser-modal'),
  closeNewConversationModelModal: hide('new-conversation-model-modal'),
  closeInboxView: (options) => { closed.push('inbox'); viewCloses.push(['inbox', options]); document.body.classList.remove('inbox-view-active'); },
  closeStatusView: (options) => { closed.push('status'); viewCloses.push(['status', options]); document.body.classList.remove('status-view-active'); },
  closeChangeCwdMenu: unshow('change-cwd-menu'),
  closeGitChangesModal: hide('git-changes-modal'),
  closeGitDiffViewer: hide('git-diff-modal'),
  closeTmuxInspector: hide('tmux-inspector-modal'),
  closeAnnotateEditor: hide('image-annotate-modal'),
  closeRelayWatchPanel: unshow('relay-watch-panel'),
  closeQuestionsPanel: unshow('questions-panel'),
  closeRelaySchedulePanel: unshow('relay-schedule-panel'),
  closeEmojiPicker: hide('emoji-popup'),
});

test('the first session replaces the page entry; the address and the title follow', async () => {
  const length = window.history.length;
  ui.noteConversationShown('conv-kestrel', 'replace');
  await wait();
  assert.equal(window.history.length, length);
  assert.equal(window.location.search, '?theme=dark&conv=conv-kestrel');
  assert.equal(window.history.state.oarConv, 'conv-kestrel');
  assert.equal(document.title, 'Kestrel ringing log');
});

test('a switch pushes; back opens the one before without pushing', async () => {
  const length = window.history.length;
  ui.noteConversationShown('conv-plover');
  await wait();
  assert.equal(window.history.length, length + 1);
  assert.equal(document.title, 'Plover beach count');
  window.history.back();
  await wait(50);
  assert.deepEqual(opened.at(-1), ['conv-kestrel', { history: 'none' }]);
  assert.equal(window.location.search, '?theme=dark&conv=conv-kestrel');
  assert.equal(document.title, 'Kestrel ringing log');
  assert.equal(window.history.length, length + 1);
  window.history.forward();
  await wait(50);
  assert.deepEqual(opened.at(-1), ['conv-plover', { history: 'none' }]);
});

test('each watched overlay takes an entry, and back closes it', async () => {
  const overlays = [
    ['summary-modal', () => el('summary-modal').classList.add('visible')],
    ['settings-modal', () => el('settings-modal').classList.add('visible')],
    ['message-search-modal', () => el('message-search-modal').classList.add('visible')],
    ['repo-browser-modal', () => el('repo-browser-modal').classList.add('visible')],
    ['new-conversation-model-modal', () => el('new-conversation-model-modal').classList.add('visible')],
    ['composer-settings', () => { el('composer-settings').hidden = false; }],
    ['chat-actions-menu', () => { el('chat-actions-menu').hidden = false; }],
    ['git-changes-modal', () => el('git-changes-modal').classList.add('visible')],
    ['git-diff-modal', () => el('git-diff-modal').classList.add('visible')],
    ['tmux-inspector-modal', () => el('tmux-inspector-modal').classList.add('visible')],
    ['image-annotate-modal', () => el('image-annotate-modal').classList.add('visible')],
    ['emoji-popup', () => el('emoji-popup').classList.add('visible')],
    ['inbox', () => document.body.classList.add('inbox-view-active')],
    ['status', () => document.body.classList.add('status-view-active')],
  ];
  const length = window.history.length;
  for (const [name, show] of overlays) {
    show();
    await wait();
    assert.ok(window.history.state?.oarOverlay, `${name} took an entry`);
    window.history.back();
    await wait(50);
    assert.equal(closed.at(-1), name, `back closed ${name}`);
    assert.equal(window.history.state?.oarConv, 'conv-plover', `${name}: still on the session`);
    // Opening it again replaces the stale forward entry: the stack does not grow.
    assert.equal(window.history.length, length + 1);
  }
});

test('one view opened from the other: back tells its closer the session history stands on', async () => {
  for (const [first, second] of [['status', 'inbox'], ['inbox', 'status']]) {
    assert.equal(window.history.state?.oarConv, 'conv-plover');
    viewCloses.length = 0;
    document.body.classList.add(`${first}-view-active`);
    await wait();
    // The second leaves the first and takes the transcript's place.
    document.body.classList.remove(`${first}-view-active`);
    document.body.classList.add(`${second}-view-active`);
    await wait();
    assert.ok(window.history.state?.oarOverlay, `${first} → ${second}: an entry`);
    window.history.back();
    await wait(50);
    assert.deepEqual(viewCloses, [[second, { returnTo: 'conv-plover' }]], `${first} → ${second}`);
    assert.equal(document.body.classList.contains(`${second}-view-active`), false);
    assert.equal(window.history.state?.oarConv, 'conv-plover');
  }
});

test('overlays built on first use (the chip panels, a row\'s menu) are watched once they exist', async () => {
  const length = window.history.length;
  for (const id of ['relay-watch-panel', 'relay-schedule-panel', 'questions-panel']) {
    // Built hidden on <body>, as the chips' modules do, then opened.
    const panel = document.createElement('div');
    panel.id = id;
    panel.className = 'relay-watch-panel';
    panel.hidden = true;
    document.body.appendChild(panel);
    await wait();
    assert.equal(window.history.state?.oarOverlay, undefined, `${id}: hidden takes nothing`);
    panel.hidden = false;
    await wait();
    assert.ok(window.history.state?.oarOverlay, `${id} took an entry`);
    window.history.back();
    await wait(50);
    assert.equal(closed.at(-1), id);
    assert.equal(panel.hidden, true);
    assert.equal(window.history.state?.oarConv, 'conv-plover');
    assert.equal(window.history.length, length);
  }
  const menu = openContextMenu(10, 10, [{ label: 'Rename', onSelect: () => {} }]);
  await wait();
  assert.ok(window.history.state?.oarOverlay, 'the row menu took an entry');
  window.history.back();
  await wait(50);
  assert.equal(menu.isConnected, false, 'back closed the row menu');
  assert.equal(window.history.state?.oarConv, 'conv-plover');
});

test('the Change CWD folder list closes before its dialog', async () => {
  const summary = el('summary-modal');
  summary.classList.add('visible');
  await wait();
  const host = document.createElement('div');
  host.innerHTML = '<div id="change-cwd-menu" class="change-cwd-menu-panel" role="listbox" hidden></div>';
  summary.appendChild(host);
  await wait();
  el('change-cwd-menu').hidden = false;
  await wait();
  window.history.back();
  await wait(50);
  assert.equal(closed.at(-1), 'change-cwd-menu');
  assert.equal(summary.classList.contains('visible'), true, 'the dialog stays');
  assert.ok(window.history.state?.oarOverlay, 'still on the dialog\'s entry');
  window.history.back();
  await wait(50);
  assert.equal(closed.at(-1), 'summary-modal');
  assert.equal(window.history.state?.oarConv, 'conv-plover');
  host.remove();
});

test('a conversation found gone is kept in the tab\'s storage', () => {
  ui.noteConversationGone('conv-gannet');
  assert.equal(ui.noteConversationMissing('conv-shrike'), false, 'not reached by a pop: the caller clears it');
  const stored = JSON.parse(window.sessionStorage.getItem(GONE_STORAGE_KEY));
  assert.ok(stored.includes('conv-gannet'));
  assert.ok(stored.includes('conv-shrike'));
});

test('the sidebar is an overlay on a phone only', async () => {
  el('sidebar').classList.add('open');
  await wait();
  assert.equal(window.history.state?.oarOverlay, undefined, 'not on a wide screen');
  el('sidebar').classList.remove('open');
  phone = true;
  el('sidebar').classList.add('open');
  await wait();
  assert.ok(window.history.state?.oarOverlay);
  window.history.back();
  await wait(50);
  assert.equal(el('sidebar').classList.contains('open'), false);
  phone = false;
});

test('a waiting question opens its conversation in place of nothing, never out of the Inbox', async () => {
  globalThis.fetch = async (rawUrl) => {
    const url = new URL(String(rawUrl), 'http://localhost/');
    const body = url.pathname.endsWith('/api/relay-questions')
      ? { questions: [{ id: 'q-wren', conversationId: 'conv-kestrel', status: 'pending', createdAt: '2026-01-02T03:04:05Z', question: 'Ring the next one?' }] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const jumps = [];
  window.openConversation = async (id, options) => { jumps.push([id, options]); };
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
  const { loadRelayQuestions } = await import('./ask-user-view.js');
  document.body.classList.add('inbox-view-active');
  await loadRelayQuestions(null);
  assert.deepEqual(jumps, [], 'the Inbox is being read');
  document.body.classList.remove('inbox-view-active');
  document.body.classList.add('status-view-active');
  await loadRelayQuestions(null);
  assert.deepEqual(jumps, [], 'so is Status');
  document.body.classList.remove('status-view-active');
  // A link the relay did not know said so: nothing opens by itself after it.
  ui.noteConversationMissing('conv-bittern');
  assert.equal(ui.isConversationAutoOpenHeld(), true);
  await loadRelayQuestions(null);
  assert.deepEqual(jumps, [], 'the notice keeps the screen empty');
  // Until the reader opens one.
  ui.noteConversationShown('conv-plover', 'none');
  assert.equal(ui.isConversationAutoOpenHeld(), false);
  await loadRelayQuestions(null);
  assert.deepEqual(jumps, [['conv-kestrel', { history: 'replace' }]], 'nothing open: it replaces');
  await wait(50);
});

test('leaving a view with no session of its own opens `returnTo`; a stored one wins', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
  const { toggleStatusView } = await import('./status-view.mjs');
  const { toggleInboxView } = await import('./inbox-ui.js');
  const { setCurrentConv } = await import('./store.js');
  const reopened = [];
  window.openConversation = async (id) => { reopened.push(id); setCurrentConv(id); };
  for (const [name, toggle] of [['status', toggleStatusView], ['inbox', toggleInboxView]]) {
    reopened.length = 0;
    // Opened over nothing (as from the other view): none is stored.
    setCurrentConv(null);
    await toggle();
    assert.equal(document.body.classList.contains(`${name}-view-active`), true);
    await toggle({ returnTo: 'conv-plover' });
    assert.equal(document.body.classList.contains(`${name}-view-active`), false);
    assert.deepEqual(reopened, ['conv-plover'], `${name}: back to returnTo`);
    // Opened over a session: that one, whatever returnTo says.
    setCurrentConv('conv-kestrel');
    await toggle();
    await toggle({ returnTo: 'conv-plover' });
    assert.deepEqual(reopened, ['conv-plover', 'conv-kestrel'], `${name}: back to its own`);
    await wait(50);
  }
  setCurrentConv(null);
});

test('a renamed session renames the document', () => {
  conversations['conv-plover'] = { ...conversations['conv-plover'], title: 'Plover beach count, spring' };
  ui.syncSessionDocumentTitle();
  assert.equal(document.title, 'Plover beach count, spring');
});
