import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The sidebar's 🔥 toggle (active sessions only), on the real index.html in
// JSDOM (harness as in journal-view.archive.test.mjs): the three conditions
// with their live signals, AND with the title filter, the count, the empty
// state, the per-browser setting, the timer for the five-minute edge, and the
// drain that loads only as many pages as the active sessions need.
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
window.confirm = () => true;

// Switched on in an earlier visit: the page starts with 🔥 on.
window.localStorage.setItem('copilot_conv_active_filter', '1');

const MINUTE = 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
// Page one: newest first. The edge row leaves the window shortly after the
// test starts; the waiting session sits on page two, page three has nothing
// active (the drain must not fetch it).
const pageOne = [
  { id: 'conv-recent', title: 'Recently finished', archived: false, messageCount: 2, updatedAt: ago(1 * MINUTE) },
  { id: 'conv-edge', title: 'About to age out', archived: false, messageCount: 2, updatedAt: ago(5 * MINUTE - 400) },
  { id: 'conv-working', title: 'Working turn', archived: false, messageCount: 4, updatedAt: ago(3 * 60 * MINUTE), activeTurn: true },
  { id: 'conv-background', title: 'Background build', archived: false, messageCount: 4, updatedAt: ago(4 * 60 * MINUTE), sessionState: 'background_only' },
  { id: 'conv-plan', title: 'Plan waiting', archived: false, messageCount: 3, updatedAt: ago(5 * 60 * MINUTE) },
  { id: 'conv-old', title: 'Old notes', archived: false, messageCount: 9, updatedAt: ago(6 * 60 * MINUTE) },
];
const pageTwo = [
  { id: 'conv-asking', title: 'Asking a question', archived: false, messageCount: 5, updatedAt: ago(30 * 60 * MINUTE) },
];
const pageThree = [
  { id: 'conv-ancient', title: 'Ancient chat', archived: false, messageCount: 1, updatedAt: ago(90 * 60 * MINUTE) },
];
const archivedRows = [
  { id: 'conv-archived', title: 'Archived but recent', archived: true, messageCount: 1, updatedAt: ago(30 * 1000) },
];
const cursorOf = (row) => ({ beforeConversationId: row.id, beforeUpdatedAt: row.updatedAt });
// The pages in order; later tests add older ones.
const chain = [pageOne, pageTwo, pageThree];
let inboxItems = [
  { id: 'board-1', kind: 'plan', session: { id: 'conv-plan', title: 'Plan waiting' }, status: 'pending', createdAt: ago(MINUTE) },
  { id: 'card-old', kind: 'ask_user', session: { id: 'conv-old', title: 'Old notes' }, status: 'answered', createdAt: ago(MINUTE) },
];
const requests = [];
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const query = Object.fromEntries(parsed.searchParams);
  requests.push({ path: parsed.pathname, query, method: String(opts.method || 'GET') });
  let answer = {};
  if (parsed.pathname === '/api/conversations') {
    const page = (index) => ({
      conversations: chain[index],
      pageInfo: index + 1 < chain.length ? { hasMore: true, nextCursor: cursorOf(chain[index].at(-1)) } : { hasMore: false, nextCursor: null },
    });
    if (query.archived === 'only') {
      answer = { conversations: archivedRows, pageInfo: { hasMore: false, nextCursor: null } };
    } else if (!query.beforeConversationId) {
      answer = page(0);
    } else {
      answer = page(chain.findIndex((rows) => rows.at(-1).id === query.beforeConversationId) + 1);
    }
  } else if (parsed.pathname === '/api/inbox') {
    answer = { relays: [{ id: 'self', self: true, name: 'this relay', reachable: true, items: inboxItems }], pending: 1 };
  }
  return { ok: true, status: 200, json: async () => answer };
};

const store = await import('./store.js');
const journal = await import('./journal-view.js');
const inbox = await import('./inbox-ui.js');
window.renderConvList = journal.renderConvList;
window.openConversation = async () => {};
window.toggleArchivedConversations = journal.toggleArchivedConversations;

const el = (id) => document.getElementById(id);
const toggle = () => el('conv-active-toggle');
const badge = () => toggle().querySelector('.conv-active-count');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listedIds = () => [...document.querySelectorAll('#conv-list .conv-item')].map((node) => node.dataset.conversationId).filter(Boolean);
const pageRequests = () => requests.filter((request) => request.path === '/api/conversations' && request.query.beforeConversationId);
async function settle() {
  for (let i = 0; i < 20; i += 1) await sleep(0);
}

test('the 🔥 toggle sits left of the title filter with a fixed name, pressed from the stored setting', async () => {
  const row = el('conv-filter-row');
  assert.equal(row.firstElementChild, toggle(), 'first in the filter row');
  assert.equal(toggle().tagName, 'BUTTON');
  assert.equal(toggle().getAttribute('type'), 'button');
  journal.initConversationFilter();
  assert.equal(toggle().getAttribute('aria-label'), 'Show active sessions only');
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  assert.equal(journal.isConversationListActiveOnly(), true);
  // A paint before the first page has arrived: loading, not "Nothing active".
  journal.renderConvList();
  assert.match(el('conv-list').textContent, /Loading conversations/);
  assert.doesNotMatch(el('conv-list').textContent, /Nothing active/);
  assert.equal(badge().hidden, true, 'no count yet');
});

test('with 🔥 on: working, recent and waiting rows show, old and archived ones do not; only the needed page is drained', async () => {
  // A question waits in a session on page two (ask_user or a Safety check:
  // the page's own pending cards).
  store.relayQuestions.set('q-1', { id: 'q-1', status: 'pending', conversationId: 'conv-asking', createdAt: ago(MINUTE) });
  await inbox.refreshInbox();
  // Stamped now, not at import: this row leaves the window in under a second.
  pageOne[1].updatedAt = ago(5 * MINUTE - 600);
  await journal.refreshConversations({ preservePagination: false });
  await settle();
  assert.deepEqual(pageRequests().map((request) => request.query.beforeConversationId), ['conv-old'], 'page two only: page three holds nothing active');
  assert.deepEqual(listedIds(), ['conv-recent', 'conv-edge', 'conv-working', 'conv-background', 'conv-plan', 'conv-asking']);
  assert.equal(badge().textContent, '6');
  assert.equal(badge().hidden, false);
  assert.match(toggle().title, /^Showing 6 active sessions/);
  assert.equal(el('conv-filter-status').textContent, '6 active sessions');
});

test('a row ages out at the five-minute edge on one timer, no event needed', async () => {
  assert.ok(listedIds().includes('conv-edge'));
  await sleep(900);
  assert.equal(listedIds().includes('conv-edge'), false);
  assert.ok(listedIds().includes('conv-recent'), 'the newer row stays');
  assert.equal(badge().textContent, '5');
});

test('live: a finished turn and an answered card drop their rows; a new turn brings one back', async () => {
  const working = store.conversations['conv-working'];
  working.activeTurn = false;
  working.sessionState = 'idle';
  journal.renderConvList();
  assert.equal(listedIds().includes('conv-working'), false, 'old and idle: out');
  store.relayQuestions.get('q-1').status = 'answered';
  journal.renderConvList();
  assert.equal(listedIds().includes('conv-asking'), false);
  // A message_status stamps the record (socket-handlers.js): recent again.
  store.conversations['conv-old'].localActivityAt = Date.now();
  journal.renderConvList();
  assert.ok(listedIds().includes('conv-old'));
  delete store.conversations['conv-old'].localActivityAt;
  journal.renderConvList();
});

test('the title filter and 🔥 combine (AND); an empty result offers to turn 🔥 off', async () => {
  journal.setConversationListFilter('plan');
  await settle();
  assert.deepEqual(listedIds(), ['conv-plan']);
  journal.setConversationListFilter('ancient');
  await settle();
  assert.deepEqual(listedIds(), []);
  assert.match(el('conv-list').textContent, /No active sessions match your filter/);
  journal.setConversationListFilter('');
  await settle();
  assert.ok(listedIds().includes('conv-plan'));
});

test('nothing active: "Nothing active right now" and its button turns 🔥 off, stored', async () => {
  inboxItems = [];
  await inbox.refreshInbox();
  store.conversations['conv-background'].sessionState = 'idle';
  store.conversations['conv-recent'].updatedAt = ago(60 * MINUTE);
  journal.renderConvList();
  assert.deepEqual(listedIds(), []);
  const list = el('conv-list');
  assert.match(list.textContent, /Nothing active right now/);
  assert.equal(badge().textContent, '0');
  const off = list.querySelector('[data-active-filter-off]');
  assert.equal(off.tagName, 'BUTTON');
  off.click();
  assert.equal(journal.isConversationListActiveOnly(), false);
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  assert.equal(window.localStorage.getItem('copilot_conv_active_filter'), '0');
  assert.equal(badge().hidden, true, 'no count while off');
  assert.ok(listedIds().includes('conv-old'));
  assert.ok(listedIds().includes('conv-ancient'));
});

test('the toggle click turns 🔥 back on and stores it; the Archived view leaves it out', async () => {
  toggle().click();
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  assert.equal(window.localStorage.getItem('copilot_conv_active_filter'), '1');
  await journal.toggleArchivedConversations(true);
  assert.equal(toggle().disabled, true);
  assert.deepEqual(listedIds(), ['conv-archived'], 'the Archived view lists its rows unfiltered');
  await journal.toggleArchivedConversations(false);
  assert.equal(toggle().disabled, false);
  assert.equal(listedIds().includes('conv-archived'), false);
  journal.setConversationListActiveOnly(false);
});

test('a worker still keyed by a loaded conversation\'s id, or a card in a loaded archived one, starts no drain', async () => {
  // A long history behind the pages so far: six more pages, nothing active.
  for (let index = 0; index < 6; index += 1) {
    chain.push([{ id: `conv-history-${index}`, title: `History ${index}`, archived: false, messageCount: 1, updatedAt: ago((100 + index) * 60 * MINUTE) }]);
  }
  journal.setConversationListActiveOnly(true);
  // Whatever the scroll loader started while 🔥 was off settles first.
  await sleep(50);
  // Before its SDK session is bound, a new conversation's worker goes by the conversation's id.
  store.setSessionWorkerStatesFromStatusPayload({ workers: [{ sdkSessionId: 'conv-old', status: 'processing' }] });
  store.relayQuestions.set('q-archived', { id: 'q-archived', status: 'pending', conversationId: 'conv-archived', createdAt: ago(MINUTE) });
  const before = pageRequests().length;
  await journal.refreshConversations({ preservePagination: false });
  await sleep(300);
  assert.equal(pageRequests().length, before, 'no page past the first');
  store.setSessionWorkerStatesFromStatusPayload({ workers: [] });
  store.relayQuestions.delete('q-archived');
});

test('a card in a session no page holds is chased for three pages, then given up, also after a reset', async () => {
  // A pending card in a conversation the live list never holds (archived, never loaded here).
  store.relayQuestions.set('q-elsewhere', { id: 'q-elsewhere', status: 'pending', conversationId: 'conv-never-listed', createdAt: ago(MINUTE) });
  const before = pageRequests().length;
  await journal.refreshConversations({ preservePagination: false });
  await sleep(400);
  assert.equal(pageRequests().length - before, 3, 'three pages without it, then no more (of eight)');
  // A cursor reset (reconnect, session bound) does not chase it again.
  await journal.refreshConversations({ preservePagination: false });
  await sleep(300);
  assert.equal(pageRequests().length - before, 3);
  assert.match(el('conv-filter-status').textContent, /active session/);
});

test('switching 🔥 on announces the search, not a partial "loaded" count, until the drain ends', async () => {
  journal.setConversationListActiveOnly(false);
  await journal.refreshConversations({ preservePagination: false });
  // Every text the status region takes, in order.
  const spoken = [];
  const observer = new window.MutationObserver(() => spoken.push(el('conv-filter-status').textContent));
  observer.observe(el('conv-filter-status'), { childList: true, characterData: true, subtree: true });
  journal.setConversationListActiveOnly(true);
  // Switched on anew: the card's session is looked for again.
  await sleep(400);
  observer.disconnect();
  assert.ok(spoken.length >= 2, JSON.stringify(spoken));
  assert.match(spoken[0], /searching older conversations/);
  assert.equal(spoken.some((text) => /loaded/.test(text)), false, JSON.stringify(spoken));
  assert.doesNotMatch(spoken.at(-1), /searching|loaded/);
  store.relayQuestions.delete('q-elsewhere');
  journal.setConversationListActiveOnly(false);
});
