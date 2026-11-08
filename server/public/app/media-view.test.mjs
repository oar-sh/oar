import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The global Media view takes the transcript's place in the real page, as
// the Inbox does; jsdom runs no page scripts, the API is injected.
const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const indexHtml = await read('../index.html');
const bootstrapSource = await read('./bootstrap.js');
const journalSource = await read('./journal-view.js');
const historySource = await read('./session-history-ui.js');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const store = await import('./store.js');
const { isMediaViewActive, leaveMediaView, toggleMediaView } = await import('./media-view.js');
const { CHAT_ACTIONS_MENU_ENTRY_IDS, resolveChatActionsMenuState } = await import('./chat-actions-menu-state.mjs');

const fetchJson = async (url) => (url.startsWith('/api/media/facets')
  ? { sessions: [], providers: [] }
  : { items: [], nextCursor: null, missingHidden: 0, indexing: { pending: 0 } });

test('the view opens in the transcript place, hides the composer, and goes back to the session it came from', async () => {
  const opened = [];
  window.openConversation = async (id, options) => opened.push([id, options]);
  store.setCurrentConv('conv-before');
  let othersLeft = 0;
  await toggleMediaView({ fetchJson, leaveOthers: () => { othersLeft += 1; } });
  assert.equal(isMediaViewActive(), true);
  assert.equal(othersLeft, 1, 'the Inbox and Status give way');
  assert.ok(document.body.classList.contains('media-view-active'));
  assert.equal(document.getElementById('input-area').hasAttribute('hidden'), true);
  assert.equal(document.getElementById('chat-title').textContent, '🖼️ Media');
  assert.ok(document.querySelector('#messages .media-gallery[data-scope="global"] .media-gallery-filters'));
  assert.equal(store.currentConvId, null);

  await toggleMediaView({ fetchJson });
  assert.equal(isMediaViewActive(), false);
  assert.equal(document.body.classList.contains('media-view-active'), false);
  assert.deepEqual(opened, [['conv-before', { restoreScroll: true }]]);
});

test('opening a session leaves the view; leaving twice is harmless', async () => {
  store.setCurrentConv(null);
  await toggleMediaView({ fetchJson });
  assert.equal(leaveMediaView(), true);
  assert.equal(leaveMediaView(), false);
  assert.equal(document.getElementById('input-area').hasAttribute('hidden'), false);
  assert.match(journalSource, /export async function openConversation\(id, options = \{\}\) \{[\s\S]{0,200}const didLeaveMediaView = leaveMediaView\(\);/);
});

test('🖼️ Media is a menu entry next to Settings, shown with or without a session, never in a shared view', () => {
  const menu = document.getElementById('chat-actions-menu');
  const ids = [...menu.querySelectorAll('.chat-actions-menu-item')].map((node) => node.id);
  assert.equal(ids[ids.indexOf('chat-menu-settings') - 1], 'chat-menu-media');
  assert.equal(document.getElementById('chat-menu-media').textContent, '🖼️ Media');
  const index = CHAT_ACTIONS_MENU_ENTRY_IDS.indexOf('chat-menu-media');
  assert.equal(CHAT_ACTIONS_MENU_ENTRY_IDS[index + 1], 'chat-menu-settings');
  assert.equal(resolveChatActionsMenuState({ conversationId: '' }).entries['chat-menu-media'].hidden, false);
  assert.equal(resolveChatActionsMenuState({ conversationId: 'c1' }).entries['chat-menu-media'].hidden, false);
  assert.equal(resolveChatActionsMenuState({ sharedMode: true }).entries['chat-menu-media'].hidden, true);
});

test('wiring: the menu entry, back, and the Inbox and Status leave each other', () => {
  assert.match(bootstrapSource, /bindMenuAction\(document\.getElementById\('chat-menu-media'\), \(event\) => \{[\s\S]*?closeChatActionsMenu\(\);\s*void window\.toggleMediaView\(\);/);
  assert.match(bootstrapSource, /closeMediaView: \(\{ returnTo = '' \} = \{\}\) => \{ if \(isMediaViewActive\(\)\) void toggleMediaView\(\{ returnTo \}\); \},/);
  assert.match(bootstrapSource, /window\.toggleInboxView = \(\) => \{\s*leaveMediaView\(\);/);
  assert.match(bootstrapSource, /window\.toggleStatusView = \(\) => \{\s*leaveInboxView\(\);\s*leaveMediaView\(\);/);
  assert.match(historySource, /name: 'media', find: \(\) => document\.body, isOpen: \(el\) => !!el\?\.classList\?\.contains\('media-view-active'\), close: backToSession\(closers\.closeMediaView\)/);
});
