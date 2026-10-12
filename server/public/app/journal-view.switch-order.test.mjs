import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// Opening conversations while the draft of the one being left is still being
// saved, on the real index.html in JSDOM (harness as in
// journal-view.claude-cloud.test.mjs). The save is held until the test lets
// it through, as a slow link holds it. Every click takes effect at once and
// the last one wins; the held save still carries the left conversation's text.
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
  { id: 'conv-garden', title: 'Plan the garden app release' },
  { id: 'conv-kite', title: 'Sketch the kite flight log' },
  { id: 'conv-recipes', title: 'Tidy the recipe index' },
].map((row, index) => ({ ...row, messageCount: 2, updatedAt: `2031-02-0${3 - index}T10:00:00.000Z`, sdkSessionId: `sid-${row.id}` }));

const conversationPayload = (row) => ({
  id: row.id,
  title: row.title,
  sdkSessionId: row.sdkSessionId,
  draftText: '',
  draftUpdatedAt: null,
  messages: [
    { id: `${row.id}-q`, role: 'user', text: `First question in ${row.title}`, timestamp: '2031-02-01T09:00:00.000Z' },
    { id: `${row.id}-a`, role: 'assistant', text: `First answer in ${row.title}`, timestamp: '2031-02-01T09:00:01.000Z' },
  ],
});

const requests = [];
let heldDraftSaves = [];
let holdDraftSaves = false;
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const entry = { path: parsed.pathname, method: String(opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null };
  requests.push(entry);
  const respond = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (parsed.pathname === '/api/conversations') {
    return respond({ conversations: rows, knownConversationIds: rows.map((row) => row.id), pageInfo: { hasMore: false, nextCursor: null } });
  }
  const draft = parsed.pathname.match(/^\/api\/conversation\/([^/]+)\/draft$/);
  if (draft && entry.method === 'PATCH') {
    const saved = { ok: true, conversationId: draft[1], draftText: entry.body?.draftText || '', draftUpdatedAt: new Date().toISOString() };
    if (!holdDraftSaves) return respond(saved);
    return new Promise((resolve) => { heldDraftSaves.push(() => resolve(respond(saved))); });
  }
  const conversation = parsed.pathname.match(/^\/api\/conversation\/([^/]+)$/);
  const row = conversation ? rows.find((candidate) => candidate.id === conversation[1]) : null;
  if (row) return respond(conversationPayload(row));
  return respond({});
};

const store = await import('./store.js');
const journal = await import('./journal-view.js');

const el = (id) => document.getElementById(id);
const settle = async () => {
  for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};
const transcriptTexts = () => [...el('messages').querySelectorAll('.msg')].map((node) => node.textContent);
const titleOf = (id) => rows.find((row) => row.id === id).title;

async function startIn(id, draftText) {
  holdDraftSaves = false;
  await journal.openConversation(id);
  await settle();
  el('msg-input').value = draftText;
  heldDraftSaves = [];
  holdDraftSaves = true;
}

async function releaseDraftSaves() {
  holdDraftSaves = false;
  while (heldDraftSaves.length) heldDraftSaves.shift()();
  await settle();
}

const draftSavesOf = (id) => requests.filter((request) => request.method === 'PATCH' && request.path === `/api/conversation/${id}/draft`);

test.before(async () => {
  await journal.refreshConversations({ preservePagination: false });
});

// A failed assertion must not leave a save held for the next test.
test.afterEach(releaseDraftSaves);

test('a quick run through several conversations opens the last one clicked at once', async () => {
  await startIn('conv-garden', 'half-written note about the release');
  const before = draftSavesOf('conv-garden').length;

  const opening = [journal.openConversation('conv-kite'), journal.openConversation('conv-recipes')];
  // Before any save returns: the last click owns the view and the composer.
  assert.equal(store.currentConvId, 'conv-recipes');
  assert.equal(el('chat-title').textContent, titleOf('conv-recipes'));
  assert.equal(el('msg-input').value, '');

  await settle();
  assert.equal(heldDraftSaves.length > 0, true, 'the draft save is still held');
  assert.ok(transcriptTexts().some((text) => text.includes('First question in Tidy the recipe index')), 'its transcript loaded without waiting for the save');

  await releaseDraftSaves();
  await Promise.all(opening);
  assert.equal(store.currentConvId, 'conv-recipes');
  assert.equal(el('chat-title').textContent, titleOf('conv-recipes'));
  assert.ok(transcriptTexts().some((text) => text.includes('First question in Tidy the recipe index')));
  assert.ok(document.querySelector('#conv-list .conv-item.active[data-conversation-id="conv-recipes"]'));
  const saves = draftSavesOf('conv-garden').slice(before);
  assert.ok(saves.length >= 1, 'leaving the conversation saved its draft');
  assert.equal(saves[0].body.draftText, 'half-written note about the release');
});

test('a click back on the conversation still open keeps it open after the held save returns', async () => {
  await startIn('conv-garden', 'half-written note about the returns');
  const before = draftSavesOf('conv-garden').length;

  const opening = [journal.openConversation('conv-kite'), journal.openConversation('conv-garden')];
  assert.equal(store.currentConvId, 'conv-garden');
  assert.equal(el('chat-title').textContent, titleOf('conv-garden'));
  // The draft typed before the round trip comes back with the conversation.
  assert.equal(el('msg-input').value, 'half-written note about the returns');

  await releaseDraftSaves();
  await Promise.all(opening);
  assert.equal(store.currentConvId, 'conv-garden');
  assert.equal(el('chat-title').textContent, titleOf('conv-garden'));
  assert.ok(transcriptTexts().some((text) => text.includes('First question in Plan the garden app release')));
  assert.ok(!transcriptTexts().some((text) => text.includes('Sketch the kite flight log')));
  assert.equal(draftSavesOf('conv-garden').slice(before)[0]?.body.draftText, 'half-written note about the returns');
});

test('clicking the open conversation again saves nothing and keeps it open', async () => {
  await startIn('conv-kite', 'a note for the kite log');
  const before = requests.filter((request) => request.method === 'PATCH').length;

  await journal.openConversation('conv-kite');
  await settle();
  assert.equal(store.currentConvId, 'conv-kite');
  assert.equal(el('chat-title').textContent, titleOf('conv-kite'));
  assert.equal(el('msg-input').value, 'a note for the kite log');
  assert.equal(requests.filter((request) => request.method === 'PATCH').length, before);
});
