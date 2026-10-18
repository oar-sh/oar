import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// Archiving a chat whose process is live asks first, on the real index.html
// in JSDOM (harness as in journal-view.archive.test.mjs): a green row opens
// the confirmation and Cancel, Escape or the backdrop keep it; an offline row
// archives at once.
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

// The relay reports a live idle worker as the row's runtime ui state.
const rows = [
  { id: 'conv_fixture_green', title: 'Idle worker chat', archived: false, messageCount: 4, updatedAt: '2031-03-03T10:00:00.000Z', runtimeSessionUiState: 'ready', runtimeSessionStatus: 'ready' },
  { id: 'conv_fixture_busy', title: 'Working chat', archived: false, messageCount: 2, updatedAt: '2031-03-02T10:00:00.000Z', runtimeSessionUiState: 'ready', runtimeSessionStatus: 'processing' },
  { id: 'conv_fixture_turn', title: 'Turn on the relay', archived: false, messageCount: 1, updatedAt: '2031-03-01T12:00:00.000Z', activeTurn: true },
  { id: 'conv_fixture_offline', title: 'Offline chat', archived: false, messageCount: 1, updatedAt: '2031-03-01T10:00:00.000Z' },
];
const requests = [];
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const entry = { path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: String(opts.method || 'GET') };
  requests.push(entry);
  const archive = parsed.pathname.match(/^\/api\/conversation\/([^/]+)\/archive$/);
  if (archive) {
    const row = rows.find((candidate) => candidate.id === archive[1]);
    if (row) row.archived = true;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (parsed.pathname === '/api/conversations') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        conversations: rows.filter((row) => !row.archived),
        knownConversationIds: rows.map((row) => row.id),
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const store = await import('./store.js');
const journal = await import('./journal-view.js');
window.closeSummaryModal = store.closeSummaryModal;
window.openConversation = async () => {};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const listedIds = () => [...document.querySelectorAll('#conv-list .conv-item')].map((node) => node.dataset.conversationId);
const archivePosts = () => requests.filter((request) => request.method === 'POST').map((request) => request.path);
const modal = () => document.getElementById('summary-modal');
const modalOpen = () => modal().classList.contains('visible');
const modalButton = (name) => document.querySelector(`#summary-modal-body [data-archive-${name}]`);

test('the rows show green for the live workers', async () => {
  await journal.refreshConversations({ preservePagination: false });
  assert.deepEqual(listedIds(), ['conv_fixture_green', 'conv_fixture_busy', 'conv_fixture_turn', 'conv_fixture_offline']);
  assert.ok(document.querySelector('[data-conversation-id="conv_fixture_green"]').classList.contains('worker-ui-ready'));
  assert.ok(document.querySelector('[data-conversation-id="conv_fixture_offline"]').classList.contains('worker-ui-offline'));
});

test('a working row is marked for the bright green, an idle one is not, and no dots follow a title', () => {
  const rowOf = (id) => document.querySelector(`[data-conversation-id="${id}"]`);
  assert.equal(rowOf('conv_fixture_busy').classList.contains('conv-working'), true);
  assert.equal(rowOf('conv_fixture_green').classList.contains('conv-working'), false);
  assert.equal(rowOf('conv_fixture_offline').classList.contains('conv-working'), false);
  assert.equal(document.querySelectorAll('#conv-list .conv-processing-dots').length, 0);
  assert.equal(rowOf('conv_fixture_busy').querySelector('.conv-title').textContent, 'Working chat');
});

test('a green chat asks first; Cancel keeps it', async () => {
  const pending = journal.archiveConv(null, 'conv_fixture_green');
  await flush();
  assert.equal(modalOpen(), true);
  assert.equal(modal().dataset.kind, 'archive-confirm');
  assert.equal(document.getElementById('summary-modal-subtitle').textContent, 'Idle worker chat');
  assert.match(document.getElementById('summary-modal-body').textContent, /Archive this session\? Its process is still active\./);
  assert.equal(document.activeElement, modalButton('cancel'));
  modalButton('cancel').click();
  await pending;
  assert.equal(modalOpen(), false);
  assert.deepEqual(archivePosts(), []);
  assert.ok(listedIds().includes('conv_fixture_green'));
});

test('Escape and the backdrop keep it too', async () => {
  let pending = journal.archiveConv(null, 'conv_fixture_green');
  await flush();
  assert.equal(modalOpen(), true);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await pending;
  assert.equal(modalOpen(), false);

  pending = journal.archiveConv(null, 'conv_fixture_green');
  await flush();
  modal().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await pending;
  assert.equal(modalOpen(), false);
  assert.deepEqual(archivePosts(), []);
});

test('a chat working on a reply asks with its own reason', async () => {
  const pending = journal.archiveConv(null, 'conv_fixture_busy');
  await flush();
  assert.match(document.getElementById('summary-modal-body').textContent, /still working on a reply/);
  modalButton('cancel').click();
  await pending;
  assert.deepEqual(archivePosts(), []);
});

test('a chat the relay lists with an active turn asks, even with no worker state here', async () => {
  const pending = journal.archiveConv(null, 'conv_fixture_turn');
  await flush();
  assert.equal(modalOpen(), true);
  assert.match(document.getElementById('summary-modal-body').textContent, /still working on a reply/);
  modalButton('cancel').click();
  await pending;
  assert.deepEqual(archivePosts(), []);
});

test('confirming archives the green chat', async () => {
  const pending = journal.archiveConv(null, 'conv_fixture_green');
  await flush();
  modalButton('confirm').click();
  await pending;
  assert.equal(modalOpen(), false);
  assert.deepEqual(archivePosts(), ['/api/conversation/conv_fixture_green/archive']);
  assert.equal(listedIds().includes('conv_fixture_green'), false);
});

test('an offline chat archives at once, with no dialog', async () => {
  await journal.archiveConv(null, 'conv_fixture_offline');
  assert.equal(modalOpen(), false);
  assert.equal(archivePosts().at(-1), '/api/conversation/conv_fixture_offline/archive');
  assert.equal(listedIds().includes('conv_fixture_offline'), false);
});
