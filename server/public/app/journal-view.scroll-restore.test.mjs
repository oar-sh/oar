import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// What openConversation asks the relay for and draws, by the place read the
// page saved for the conversation (transcript-reading-anchor.mjs) and the
// window it kept (conversation-payload-cache.mjs). The real index.html in
// JSDOM, as in journal-view.switch-order.test.mjs. JSDOM lays nothing out, so
// offsets are not measured here (the browser spec does that); which rows are
// drawn and which requests are made are.
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
  { id: 'conv-lantern', title: 'Sort the lantern festival notes' },
  { id: 'conv-ferry', title: 'Check the ferry timetable' },
].map((row, index) => ({ ...row, messageCount: 60, updatedAt: `2031-03-0${3 - index}T10:00:00.000Z`, sdkSessionId: `sid-${row.id}` }));

// Each conversation has 60 messages; the relay pages over them like the real one.
const history = new Map(rows.map((row) => [row.id, Array.from({ length: 60 }, (_, index) => ({
  id: `${row.id}-${String(index + 1).padStart(3, '0')}`,
  role: index % 2 ? 'assistant' : 'user',
  text: `Line ${index + 1} of ${row.title}`,
  timestamp: new Date(Date.UTC(2031, 2, 1, 9, 0, index)).toISOString(),
}))]));

function page(conversationId, params) {
  const all = history.get(conversationId);
  const limit = Math.min(100, Number(params.get('limit')) || 20);
  const around = params.get('aroundMessageId');
  const before = params.get('beforeMessageId');
  let start = Math.max(0, all.length - limit);
  if (around) {
    const at = all.findIndex((message) => message.id === around);
    if (at < 0) return [];
    start = Math.max(0, Math.min(all.length - limit, at - Math.floor((limit - 1) / 2)));
  } else if (before) {
    const at = all.findIndex((message) => message.id === before);
    start = Math.max(0, at - limit);
    return { slice: all.slice(start, at), start, end: at };
  }
  return { slice: all.slice(start, start + limit), start, end: Math.min(all.length, start + limit) };
}

const requests = [];
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const method = String(opts.method || 'GET');
  requests.push({ path: parsed.pathname, method, params: parsed.searchParams });
  const respond = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (parsed.pathname === '/api/conversations') {
    return respond({ conversations: rows, knownConversationIds: rows.map((row) => row.id), pageInfo: { hasMore: false, nextCursor: null } });
  }
  const conversation = parsed.pathname.match(/^\/api\/conversation\/([^/]+)$/);
  const row = conversation ? rows.find((candidate) => candidate.id === conversation[1]) : null;
  if (row && method === 'GET') {
    const selected = page(row.id, parsed.searchParams);
    const slice = Array.isArray(selected) ? selected : selected.slice;
    const all = history.get(row.id);
    const start = Array.isArray(selected) ? 0 : selected.start;
    const end = Array.isArray(selected) ? 0 : selected.end;
    const first = slice[0];
    const last = slice[slice.length - 1];
    return respond({
      id: row.id,
      title: row.title,
      sdkSessionId: row.sdkSessionId,
      draftText: '',
      draftUpdatedAt: null,
      messages: slice,
      pageInfo: {
        hasMore: start > 0,
        hasMoreOlder: start > 0,
        hasMoreNewer: end < all.length,
        nextCursor: first ? { beforeMessageId: first.id, beforeTimestamp: first.timestamp } : null,
        olderCursor: first ? { beforeMessageId: first.id, beforeTimestamp: first.timestamp } : null,
        newerCursor: last ? { afterMessageId: last.id, afterTimestamp: last.timestamp } : null,
      },
    });
  }
  return respond({});
};

const store = await import('./store.js');
const journal = await import('./journal-view.js');
const conversationView = await import('./conversation-view.js');
const { conversationPayloadCache } = await import('./conversation-payload-cache.mjs');

const el = (id) => document.getElementById(id);
const settle = async () => {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const shownIds = () => [...el('messages').querySelectorAll(':scope > .msg[data-message-id]')].map((node) => node.dataset.messageId);
// The reads an open makes; JSDOM keeps scrollTop at 0, so the loader also
// pages in older history at once, which is left out here.
const readsOf = (id) => requests.filter((request) => request.method === 'GET'
  && request.path === `/api/conversation/${id}`
  && !request.params.get('beforeMessageId')
  && !request.params.get('afterMessageId'));
const lastRead = (id) => readsOf(id).at(-1)?.params;

test.before(async () => {
  await journal.refreshConversations({ preservePagination: false });
});

test.beforeEach(() => {
  conversationPayloadCache.clear();
  localStorage.clear();
  requests.length = 0;
});

test('a first open with nothing saved asks for the newest 20 messages', async () => {
  await journal.openConversation('conv-lantern');
  await settle();
  assert.equal(lastRead('conv-lantern').get('limit'), '20');
  assert.equal(lastRead('conv-lantern').get('aroundMessageId'), null);
  assert.equal(shownIds().at(-1), 'conv-lantern-060');
});

test('after a reload, the messages around the one read are asked for and drawn', async () => {
  await journal.openConversation('conv-ferry');
  await settle();
  store.saveConversationReadingAnchor('conv-lantern', { messageId: 'conv-lantern-012', offsetPx: -8, atTail: false });
  requests.length = 0;
  await journal.openConversation('conv-lantern');
  // Before the loaders page on from the window's edges.
  const reads = readsOf('conv-lantern');
  assert.equal(reads.length, 1, 'one request');
  assert.equal(reads[0].params.get('aroundMessageId'), 'conv-lantern-012');
  assert.equal(reads[0].params.get('limit'), '40');
  assert.ok(shownIds().includes('conv-lantern-012'));
  assert.ok(!shownIds().includes('conv-lantern-060'), 'a window in the middle of the history');
  // The end is left to the jump-to-bottom button: the window does not reach it.
  assert.equal(conversationView.isConversationWindowAtTail(), false);
  await settle();
});

test('a reader who was at the end gets the newest page', async () => {
  await journal.openConversation('conv-ferry');
  await settle();
  store.saveConversationReadingAnchor('conv-lantern', { messageId: 'conv-lantern-059', offsetPx: 0, atTail: true });
  requests.length = 0;
  await journal.openConversation('conv-lantern');
  await settle();
  assert.equal(lastRead('conv-lantern').get('aroundMessageId'), null);
  assert.equal(lastRead('conv-lantern').get('limit'), '20');
});

test('a message read that is gone falls back to the newest page', async () => {
  await journal.openConversation('conv-ferry');
  await settle();
  store.saveConversationReadingAnchor('conv-lantern', { messageId: 'conv-lantern-deleted', offsetPx: 0, atTail: false });
  requests.length = 0;
  await journal.openConversation('conv-lantern');
  await settle();
  const reads = readsOf('conv-lantern');
  assert.equal(reads.length, 2);
  assert.equal(reads[1].params.get('aroundMessageId'), null);
  assert.equal(reads[1].params.get('limit'), '20');
  assert.equal(shownIds().at(-1), 'conv-lantern-060');
});

test('a switch back draws the kept window with its older page and merges the newest page into it', async () => {
  await journal.openConversation('conv-ferry');
  await settle();
  await journal.openConversation('conv-lantern');
  await settle();
  // An older page loaded while reading.
  await conversationView.loadOlderConversationMessages();
  await settle();
  const before = shownIds();
  assert.ok(before.length > 20, 'older pages are on the page');
  assert.equal(conversationPayloadCache.windowSize('conv-lantern'), before.length);
  store.saveConversationReadingAnchor('conv-lantern', { messageId: 'conv-lantern-025', offsetPx: 0, atTail: false });

  await journal.openConversation('conv-ferry');
  await settle();
  // Written while away, and a reply finished since it was kept.
  const lantern = history.get('conv-lantern');
  lantern[59] = { ...lantern[59], text: 'The finished last reply' };
  lantern.push({ id: 'conv-lantern-061', role: 'user', text: 'A line written meanwhile', timestamp: new Date(Date.UTC(2031, 2, 1, 9, 1, 0)).toISOString() });
  requests.length = 0;

  await journal.openConversation('conv-lantern');
  await settle();
  const reads = readsOf('conv-lantern');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].params.get('limit'), '20');
  assert.equal(reads[0].params.get('aroundMessageId'), null);
  const ids = shownIds();
  assert.deepEqual(ids.slice(0, before.length), before, 'the older pages are still there');
  assert.equal(ids.at(-1), 'conv-lantern-061', 'the new row joined');
  assert.equal(ids.length, before.length + 1);
  assert.match(el('messages').querySelector('[data-message-id="conv-lantern-060"]').textContent, /The finished last reply/);
  assert.equal(conversationPayloadCache.windowSize('conv-lantern'), before.length + 1);
  lantern.pop();
});

test('leaving a conversation cuts its kept window to the retention cap around the place read', async () => {
  localStorage.setItem('copilot_conversation_window_retention', '100');
  const many = Array.from({ length: 150 }, (_, index) => ({
    id: `conv-lantern-k${String(index).padStart(3, '0')}`,
    role: index % 2 ? 'assistant' : 'user',
    text: `Kept line ${index}`,
    timestamp: new Date(Date.UTC(2031, 2, 2, 9, 0, index)).toISOString(),
  }));
  await journal.openConversation('conv-lantern');
  await settle();
  conversationPayloadCache.remember('conv-lantern', { id: 'conv-lantern', title: rows[0].title, messages: many, pageInfo: { hasMoreOlder: true } });
  store.saveConversationReadingAnchor('conv-lantern', { messageId: 'conv-lantern-k020', offsetPx: 0, atTail: false });
  // The page shows no row of the kept window: the saved place stands.
  el('messages').innerHTML = '';
  await journal.openConversation('conv-ferry');
  await settle();
  assert.equal(conversationPayloadCache.windowSize('conv-lantern'), 100);
  const kept = conversationPayloadCache.read('conv-lantern');
  assert.equal(kept.messages[0].id, 'conv-lantern-k000');
  assert.equal(kept.hasMoreNewer, true);
});

test('reopening the conversation on screen with nothing kept rebuilds its end, not a window around the place read', async () => {
  await journal.openConversation('conv-lantern');
  await settle();
  conversationPayloadCache.forget('conv-lantern');
  store.saveConversationReadingAnchor('conv-lantern', { messageId: 'conv-lantern-012', offsetPx: 0, atTail: false });
  requests.length = 0;
  // A session bound, a click on the row, a push: the same conversation again.
  await journal.openConversation('conv-lantern');
  await settle();
  const reads = readsOf('conv-lantern');
  assert.equal(reads[0].params.get('aroundMessageId'), null);
  assert.equal(reads[0].params.get('limit'), '20');
  assert.equal(shownIds().at(-1), 'conv-lantern-060');
  assert.equal(conversationView.isConversationWindowAtTail(), true);
});

test('an apply that keeps the transcript leaves the kept window alone', async () => {
  await journal.openConversation('conv-ferry');
  await settle();
  await journal.openConversation('conv-lantern');
  await settle();
  await conversationView.loadOlderConversationMessages();
  await settle();
  const size = conversationPayloadCache.windowSize('conv-lantern');
  assert.ok(size > 20);
  journal.applyLoadedConversationState('conv-lantern', {
    id: 'conv-lantern',
    title: rows[0].title,
    messages: history.get('conv-lantern').slice(-20),
    pageInfo: { hasMoreOlder: true, hasMoreNewer: false },
  }, { keepTranscript: true, followLiveUpdates: false });
  assert.equal(conversationPayloadCache.windowSize('conv-lantern'), size);
});

test('a row deleted while away leaves the page and the kept window on the switch back', async () => {
  await journal.openConversation('conv-ferry');
  await settle();
  await journal.openConversation('conv-lantern');
  await settle();
  await conversationView.loadOlderConversationMessages();
  await settle();
  const before = shownIds();
  assert.ok(before.includes('conv-lantern-055'));
  store.saveConversationReadingAnchor('conv-lantern', { messageId: 'conv-lantern-030', offsetPx: 0, atTail: false });
  await journal.openConversation('conv-ferry');
  await settle();
  const lantern = history.get('conv-lantern');
  const at = lantern.findIndex((message) => message.id === 'conv-lantern-055');
  const [deleted] = lantern.splice(at, 1);
  try {
    await journal.openConversation('conv-lantern');
    await settle();
    const ids = shownIds();
    assert.equal(ids.includes('conv-lantern-055'), false, 'gone from the page');
    // Older than the newest page: the page says nothing about them, they stay.
    assert.deepEqual(ids.slice(0, 20), before.slice(0, 20));
    assert.equal(ids.length, before.length - 1);
    const kept = conversationPayloadCache.read('conv-lantern');
    assert.equal(kept.messages.some((message) => message.id === 'conv-lantern-055'), false, 'gone from the kept window');
    assert.equal(kept.messages.length, before.length - 1);
  } finally {
    lantern.splice(at, 0, deleted);
  }
});

// JSDOM lays nothing out: each row measures 100 px here, the transcript 600.
function layOutRows(box) {
  let top = 0;
  const height = () => box.querySelectorAll(':scope > .msg').length * 100;
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: height });
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value) => { top = Math.max(0, Math.min(height() - 600, Number(value) || 0)); },
  });
  return () => {
    delete box.clientHeight;
    delete box.scrollHeight;
    delete box.scrollTop;
  };
}

test('an older page keeps the place read as it lands, and a scroll right after it stands', async () => {
  await journal.openConversation('conv-ferry');
  await settle();
  const box = el('messages');
  const restore = layOutRows(box);
  try {
    await journal.openConversation('conv-lantern');
    await settle();
    assert.equal(shownIds().length, 20);
    // At the end, as after the jump-to-bottom button.
    assert.equal(box.scrollTop, 1400);
    await conversationView.loadOlderConversationMessages();
    assert.equal(shownIds().length, 40, 'the older page is on the page');
    assert.equal(box.scrollTop, 3400, 'the rows read stay where they were');
    // The reader scrolls up before the next frame: that is where they stay.
    box.scrollTop = 2100;
    await settle();
    assert.equal(box.scrollTop, 2100);
  } finally {
    restore();
  }
});
