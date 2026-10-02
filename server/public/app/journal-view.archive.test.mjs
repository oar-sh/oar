import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The sidebar's Archived view and the row context menu, on the real
// index.html in JSDOM (harness as in journal-view.claude-cloud.test.mjs):
// archive from the row, the 🗄 toggle, unarchive, and the menu a right-click
// or a long press opens.
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

const rows = [
  { id: 'conv-live-1', title: 'Sample live chat', archived: false, messageCount: 3, updatedAt: '2031-02-02T10:00:00.000Z' },
  { id: 'conv-live-2', title: 'Another live chat', archived: false, messageCount: 1, updatedAt: '2031-02-01T10:00:00.000Z' },
  { id: 'conv-old-1', title: 'Sample archived chat', archived: true, messageCount: 8, updatedAt: '2031-01-01T10:00:00.000Z' },
];
const requests = [];
const routes = {
  '/api/conversations': (entry) => ({
    conversations: rows.filter((row) => (entry.query.archived === 'only' ? row.archived : entry.query.archived === 'true' || !row.archived)),
    knownConversationIds: rows.map((row) => row.id),
    pageInfo: { hasMore: false, nextCursor: null },
  }),
};
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const entry = { path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: String(opts.method || 'GET') };
  requests.push(entry);
  const archive = parsed.pathname.match(/^\/api\/conversation\/([^/]+)\/(archive|unarchive)$/);
  if (archive) {
    const row = rows.find((candidate) => candidate.id === archive[1]);
    if (row) row.archived = archive[2] === 'archive';
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  const answer = routes[parsed.pathname] ? await routes[parsed.pathname](entry) : {};
  return { ok: true, status: 200, json: async () => answer };
};

const journal = await import('./journal-view.js');
window.archiveConv = journal.archiveConv;
window.unarchiveConv = journal.unarchiveConv;
window.toggleArchivedConversations = journal.toggleArchivedConversations;
window.openConversation = async () => {};

const el = (id) => document.getElementById(id);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const listedIds = () => [...document.querySelectorAll('#conv-list .conv-item')].map((node) => node.dataset.conversationId);
const requestsTo = (path) => requests.filter((request) => request.path === path);

test('the live list shows the live chats with an Archive button each', async () => {
  await journal.refreshConversations({ preservePagination: false });
  assert.deepEqual(listedIds(), ['conv-live-1', 'conv-live-2']);
  assert.deepEqual(requestsTo('/api/conversations').at(-1).query.archived, undefined);
  const row = document.querySelector('[data-conversation-id="conv-live-1"]');
  assert.equal(row.querySelector('.conv-archive').title, 'Archive');
  assert.equal(row.querySelector('.conv-delete').title, 'Delete');
  assert.equal(el('conv-archived-banner').hidden, true);
});

test('archiving from the row takes the chat out of the list; the Archived view lists it with Unarchive', async () => {
  // The row button's inline handler is the same function (JSDOM runs no
  // inline handlers without scripts enabled).
  assert.equal(document.querySelector('[data-conversation-id="conv-live-1"] .conv-archive').getAttribute('onclick'), "archiveConv(event,'conv-live-1')");
  await journal.archiveConv(null, 'conv-live-1');
  assert.deepEqual(requests.filter((request) => request.method === 'POST').map((request) => request.path), ['/api/conversation/conv-live-1/archive']);
  assert.deepEqual(listedIds(), ['conv-live-2']);

  await journal.toggleArchivedConversations();
  assert.equal(el('conv-archived-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(el('conv-archived-banner').hidden, false);
  assert.equal(requestsTo('/api/conversations').at(-1).query.archived, 'only');
  assert.deepEqual(listedIds(), ['conv-live-1', 'conv-old-1']);
  const row = document.querySelector('[data-conversation-id="conv-old-1"]');
  assert.equal(row.classList.contains('archived'), true);
  assert.equal(row.querySelector('.conv-archive').title, 'Unarchive');

  assert.equal(row.querySelector('.conv-archive').getAttribute('onclick'), "unarchiveConv(event,'conv-old-1')");
  await journal.unarchiveConv(null, 'conv-old-1');
  assert.equal(requests.filter((request) => request.method === 'POST').at(-1).path, '/api/conversation/conv-old-1/unarchive');
  assert.deepEqual(listedIds(), ['conv-live-1']);

  await journal.toggleArchivedConversations();
  assert.equal(el('conv-archived-toggle').getAttribute('aria-pressed'), 'false');
  assert.deepEqual(listedIds(), ['conv-live-2', 'conv-old-1']);
});

test('a right-click on a row opens its menu; Archive in it archives the chat', async () => {
  const row = document.querySelector('[data-conversation-id="conv-live-2"]');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
  const menu = document.querySelector('.context-menu');
  assert.ok(menu, 'menu opened');
  const labels = [...menu.querySelectorAll('.context-menu-item')].map((item) => [item.dataset.menuItem, item.disabled]);
  assert.deepEqual(labels, [
    ['open', false], ['edit-title', false], ['stop-turn', true], ['kill-session', true], ['archive', false], ['delete', false],
  ]);
  menu.querySelector('[data-menu-item="archive"]').click();
  await flush();
  await flush();
  assert.equal(document.querySelector('.context-menu'), null);
  assert.equal(requests.filter((request) => request.method === 'POST').at(-1).path, '/api/conversation/conv-live-2/archive');
  assert.deepEqual(listedIds(), ['conv-old-1']);

  // The same row in the Archived view offers Unarchive.
  await journal.toggleArchivedConversations();
  const archivedRow = document.querySelector('[data-conversation-id="conv-live-2"]');
  archivedRow.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
  assert.ok(document.querySelector('[data-menu-item="unarchive"]'));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(document.querySelector('.context-menu'), null);
  await journal.toggleArchivedConversations();
});
