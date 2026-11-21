import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The Inbox draws into #messages, the transcript's place in index.html, so
// this runs against the real file. JSDOM stores a scrollTop that is set, which
// is all the scroll memory here needs; it runs no page scripts.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
// Left with nothing to go back to, the empty screen asks for the layout.
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);

// The relay: an Inbox with `inboxRelays` in it (nothing at first), every
// other request empty.
let inboxRelays = [];
globalThis.fetch = async (rawUrl) => {
  const url = new URL(String(rawUrl), 'http://localhost/');
  const body = url.pathname.endsWith('/api/inbox') ? { relays: inboxRelays } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
// The transcript the Inbox replaces, and what reopening it restores.
const opened = [];
window.openConversation = async (id) => { opened.push(id); };
window.renderConvList = () => {};

const { refreshInbox, toggleInboxView, isInboxViewActive } = await import('./inbox-ui.js');
const messages = document.getElementById('messages');

test('the Inbox opens at the top, not at the transcript\'s scroll height', async () => {
  messages.scrollTop = 1800;
  await toggleInboxView();
  assert.equal(isInboxViewActive(), true);
  assert.equal(messages.scrollTop, 0);
});

test('left and opened again, the Inbox comes back where it was scrolled', async () => {
  messages.scrollTop = 240;
  await toggleInboxView();
  assert.equal(isInboxViewActive(), false);
  // Opened with nothing open: closing it leaves the empty screen, not the list.
  assert.deepEqual(opened, []);
  assert.equal(document.getElementById('chat-title').textContent, 'Select or start a conversation');
  assert.equal(messages.querySelector('.inbox-view'), null);
  // The transcript is back and scrolled on its own; that height is not the Inbox's.
  messages.scrollTop = 5000;
  await toggleInboxView();
  assert.equal(isInboxViewActive(), true);
  assert.equal(messages.scrollTop, 240);
  await toggleInboxView();
});

test('a refresh that brings a new ask above the reader leaves the cards they read in place', async () => {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const ask = (id, minutes) => ({
    id,
    kind: 'ask',
    status: 'pending',
    question: `Which trail for ${id}?`,
    options: ['North', 'South'],
    session: { id: 'conv-marsh', title: 'Marsh walk' },
    createdAt: minutesAgo(minutes),
    updatedAt: minutesAgo(minutes),
  });
  // Newest first: a1 on top.
  inboxRelays = [{ id: 'self', name: 'bench-relay', self: true, reachable: true, items: [1, 2, 3, 4, 5, 6].map((n) => ask(`a${n}`, n)) }];
  // JSDOM lays nothing out: #messages shows 600 px from y=100, the cards
  // are 200 px each under a 50 px filter bar.
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this === messages) return { top: 100, bottom: 700 };
    const cards = [...messages.querySelectorAll('.inbox-item')];
    const index = cards.indexOf(this);
    if (index < 0) return original.call(this);
    const top = 100 + 50 + index * 200 - messages.scrollTop;
    return { top, bottom: top + 200 };
  };
  const topOf = (id) => messages.querySelector(`.inbox-item[data-item-id="${id}"]`).getBoundingClientRect().top;
  try {
    await toggleInboxView();
    assert.equal(isInboxViewActive(), true);
    // The reader is at a4.
    messages.scrollTop = 700;
    const before = topOf('a4');
    inboxRelays = [{ ...inboxRelays[0], items: [ask('a0', 0), ...inboxRelays[0].items] }];
    await refreshInbox();
    assert.equal(messages.querySelectorAll('.inbox-item')[0].dataset.itemId, 'a0', 'the new ask is listed first');
    assert.equal(topOf('a4'), before);
    assert.equal(messages.scrollTop, 900);
    await toggleInboxView();
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = original;
    inboxRelays = [];
  }
});
