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

// The relay: an Inbox with nothing in it, every other request empty.
globalThis.fetch = async (rawUrl) => {
  const url = new URL(String(rawUrl), 'http://localhost/');
  const body = url.pathname.endsWith('/api/inbox') ? { relays: [] } : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
// The transcript the Inbox replaces, and what reopening it restores.
const opened = [];
window.openConversation = async (id) => { opened.push(id); };
window.renderConvList = () => {};

const { toggleInboxView, isInboxViewActive } = await import('./inbox-ui.js');
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
  // The transcript is back and scrolled on its own; that height is not the Inbox's.
  messages.scrollTop = 5000;
  await toggleInboxView();
  assert.equal(isInboxViewActive(), true);
  assert.equal(messages.scrollTop, 240);
  await toggleInboxView();
});
