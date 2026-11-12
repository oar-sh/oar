import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// A paired relay's question answered in a popup (agent auth §13.2, 1a): the
// option button opens that relay's page with no opener and no referrer, sends
// nothing, and the Inbox reloads when this window is back in front.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);

const ITEM = {
  id: 'ask_far001', kind: 'ask', session: { id: 'conv-far', title: 'Far worker' }, question: 'Run the migration tonight?',
  options: ['Tonight', 'Tomorrow'], status: 'pending', createdAt: new Date().toISOString(),
};
const requests = [];
globalThis.fetch = async (rawUrl, opts = {}) => {
  const url = new URL(String(rawUrl), 'http://localhost/');
  requests.push({ method: String(opts.method || 'GET').toUpperCase(), path: url.pathname });
  const body = url.pathname.endsWith('/api/inbox')
    ? { relays: [{ id: 'self', name: 'bench-relay', self: true, reachable: true, items: [] }, { id: 'r-lab', name: 'lab-relay', url: 'https://relay-b.example.test', answerLink: true, reachable: true, items: [ITEM] }], pairedAnswers: false }
    : {};
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
window.openConversation = async () => {};
window.renderConvList = () => {};
const opened = [];
window.open = (...args) => { opened.push(args); return null; };

const { bindInboxActionHost, toggleInboxView, ANSWER_THERE_POPUP_FEATURES, openAnswerThere } = await import('./inbox-ui.js');
bindInboxActionHost(document.getElementById('messages'));
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

test('an option button opens the paired relay\'s page in a popup, with no opener, and answers nothing here', async () => {
  await toggleInboxView();
  await settle();
  const button = document.querySelector('[data-item-id="ask_far001"] [data-inbox-action="answer-there"][data-option="1"]');
  assert.ok(button, 'the popup button is drawn');
  requests.length = 0;
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await settle();
  assert.deepEqual(opened, [['https://relay-b.example.test/?answer=ask_far001&option=1', '_blank', 'popup,width=440,height=600,noopener,noreferrer']]);
  assert.equal(ANSWER_THERE_POPUP_FEATURES.includes('noopener'), true);
  assert.equal(requests.filter((entry) => entry.method === 'POST').length, 0, 'nothing is sent to any relay');
  assert.equal(button.disabled, false);

  // Back in front: the Inbox reloads, once.
  requests.length = 0;
  window.dispatchEvent(new dom.window.Event('focus'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.filter((entry) => entry.path === '/api/inbox').length, 1);
  window.dispatchEvent(new dom.window.Event('focus'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.filter((entry) => entry.path === '/api/inbox').length, 1, 'not on every focus');
});

test('only an http(s) address is opened', () => {
  opened.length = 0;
  assert.equal(openAnswerThere('javascript:alert(1)'), false);
  assert.equal(openAnswerThere(''), false);
  assert.deepEqual(opened, []);
});
