import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// A chat unarchived elsewhere (another tab, an agent's send into it) comes
// back to the sidebar without a reload: the real conversation_archived
// handler, registered on a fake socket.io client, over the real journal view
// on the app's index.html in JSDOM (harness as in journal-view.archive.test.mjs).
// Titles and ids are fictional.
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

const rows = [
  { id: 'conv-live-1', title: 'Release notes', archived: false, messageCount: 3, updatedAt: '2031-02-02T10:00:00.000Z' },
  { id: 'conv-live-2', title: 'Parser review', archived: false, messageCount: 1, updatedAt: '2031-02-01T10:00:00.000Z' },
  { id: 'conv-old-1', title: 'Old migration', archived: true, messageCount: 8, updatedAt: '2031-01-01T10:00:00.000Z' },
  { id: 'conv-old-2', title: 'Old benchmark', archived: true, messageCount: 2, updatedAt: '2030-12-01T10:00:00.000Z' },
];
const requests = [];
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const entry = { path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: String(opts.method || 'GET') };
  requests.push(entry);
  const answer = parsed.pathname === '/api/conversations'
    ? {
        conversations: rows
          .filter((row) => (entry.query.archived === 'only' ? row.archived : !row.archived))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        knownConversationIds: rows.map((row) => row.id),
        pageInfo: { hasMore: false, nextCursor: null },
      }
    : {};
  return { ok: true, status: 200, json: async () => answer };
};

const journal = await import('./journal-view.js');
window.openConversation = async () => {};

const socketHandlers = new Map();
globalThis.io = () => ({
  connected: true,
  on: (event, handler) => socketHandlers.set(event, handler),
  emit() {},
  connect() {},
});
const { connectSocket } = await import('./socket-handlers.js');
await connectSocket({
  refreshCurrentView: async () => {},
  refreshSessionWorkerStatus: async () => {},
  refreshModelCatalog: async () => {},
  updateModelCatalogState: () => {},
  applyConversationWorkspaceRootUpdate: () => {},
  applyConversationTitleUpdate: () => {},
  syncChatTitleControls: () => {},
  applyConversationPreferencesForConversation: () => {},
});
const fire = (event, payload) => socketHandlers.get(event)(payload);

const listedIds = () => [...document.querySelectorAll('#conv-list .conv-item')].map((node) => node.dataset.conversationId);
const listFetches = () => requests.filter((request) => request.path === '/api/conversations').length;
// The handler's fetch is coalesced over a short window; waits for its effect.
async function eventually(check, label, timeoutMs = 2_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`not within ${timeoutMs} ms: ${label}`);
}
const quiet = () => new Promise((resolve) => setTimeout(resolve, 400));

// A send or another tab brings the chat back with a fresh updated_at.
function unarchiveOnServer(id) {
  const row = rows.find((candidate) => candidate.id === id);
  row.archived = false;
  row.updatedAt = '2031-03-01T10:00:00.000Z';
}

test('a chat this page never loaded, unarchived elsewhere, is fetched and listed without a reload', async () => {
  await journal.refreshConversations({ preservePagination: false });
  assert.deepEqual(listedIds(), ['conv-live-1', 'conv-live-2']);
  unarchiveOnServer('conv-old-1');
  fire('conversation_archived', { conversationId: 'conv-old-1', archived: false });
  await eventually(() => listedIds()[0] === 'conv-old-1', 'the unarchived chat at the top of the list');
  assert.deepEqual(listedIds(), ['conv-old-1', 'conv-live-1', 'conv-live-2']);
});

test('a loaded chat archived and unarchived elsewhere changes in place, with no fetch', async () => {
  await journal.refreshConversations({ preservePagination: false });
  fire('conversation_archived', { conversationId: 'conv-live-2', archived: true });
  assert.deepEqual(listedIds(), ['conv-old-1', 'conv-live-1']);
  const before = listFetches();
  fire('conversation_archived', { conversationId: 'conv-live-2', archived: false });
  assert.deepEqual(listedIds(), ['conv-old-1', 'conv-live-1', 'conv-live-2']);
  await quiet();
  assert.equal(listFetches(), before);
});

test('an unknown chat archived elsewhere fetches nothing', async () => {
  const before = listFetches();
  fire('conversation_archived', { conversationId: 'conv-elsewhere', archived: true });
  await quiet();
  assert.equal(listFetches(), before);
});

test('the Archived view does not fetch for a chat unarchived elsewhere: it would not list it', async () => {
  await journal.toggleArchivedConversations();
  assert.deepEqual(listedIds(), ['conv-old-2']);
  const before = listFetches();
  fire('conversation_archived', { conversationId: 'conv-unseen', archived: false });
  await quiet();
  assert.equal(listFetches(), before);
  await journal.toggleArchivedConversations();
});
