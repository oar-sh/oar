import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// The Inbox's filters, Groups picker and folds against the real index.html:
// what a click changes, what localStorage keeps, and what a refresh keeps.
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
window.openConversation = async () => {};
window.renderConvList = () => {};

// A filter stored before 0.9.32: read once, then gone.
localStorage.setItem('oar_inbox_filter', 'mine');

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const STORAGE = { id: 'grp-storage', name: 'Storage work' };
function ask(id, group = null, extra = {}) {
  return {
    id, kind: 'ask', status: 'pending', question: `Question ${id}?`, options: [], createdAt: minutesAgo(5),
    session: { id: `conv-${id}`, title: `Session ${id}`, startedBy: 'owner', group }, ...extra,
  };
}
let selfItems = [ask('a1', STORAGE), ask('a2'), ask('a3', STORAGE, { status: 'answered', answer: 'Yes', answeredAt: minutesAgo(2) })];
const labItems = [ask('l1')];
let inboxReads = 0;
globalThis.fetch = async (rawUrl) => {
  const url = new URL(String(rawUrl), 'http://localhost/');
  let body = {};
  if (url.pathname.endsWith('/api/inbox')) {
    inboxReads += 1;
    body = { relays: [
      { id: 'self', name: 'bench-relay', self: true, reachable: true, items: selfItems },
      { id: 'r-lab', name: 'lab-relay', url: 'https://relay-b.example.test', reachable: true, items: labItems },
    ] };
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const ui = await import('./inbox-ui.js');
const messages = document.getElementById('messages');
const stored = () => JSON.parse(localStorage.getItem('oar_inbox_view') || 'null');
const shownIds = () => [...messages.querySelectorAll('.inbox-item')].map((node) => node.dataset.itemId);
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('the stored filter of an older version becomes the view\'s "who" and its key goes', async () => {
  ui.startInbox();
  assert.equal(localStorage.getItem('oar_inbox_filter'), null);
  assert.equal(stored().who, 'mine');
  await ui.toggleInboxView();
  assert.equal(messages.querySelector('[data-inbox-filter="mine"]').getAttribute('aria-pressed'), 'true');
  messages.querySelector('[data-inbox-filter="all"]').click();
  assert.equal(stored().who, 'all');
});

test('Unanswered and This relay: a click narrows the list and is kept', async () => {
  assert.deepEqual(shownIds().sort(), ['a1', 'a2', 'a3', 'l1']);
  const chip = () => messages.querySelector('[data-inbox-view="unanswered"]');
  chip().focus();
  chip().click();
  await wait();
  assert.equal(stored().unanswered, true);
  assert.equal(chip().getAttribute('aria-pressed'), 'true');
  assert.equal(document.activeElement, chip(), 'the new chip has the focus');
  assert.deepEqual(shownIds().sort(), ['a1', 'a2', 'l1']);
  messages.querySelector('[data-inbox-view="this-relay"]').click();
  assert.equal(stored().thisRelay, true);
  assert.deepEqual(shownIds().sort(), ['a1', 'a2']);
  await ui.refreshInbox();
  assert.deepEqual(shownIds().sort(), ['a1', 'a2'], 'a refresh keeps the filters');
  for (const action of ['unanswered', 'this-relay']) messages.querySelector(`[data-inbox-view="${action}"]`).click();
  assert.deepEqual([stored().unanswered, stored().thisRelay], [false, false]);
});

test('Groups: a ticked group narrows the list; the picker stays open across a redraw', async () => {
  const summary = messages.querySelector('details.inbox-groups-picker > summary');
  assert.equal(summary.textContent, 'Groups ▾');
  messages.querySelector('details.inbox-groups-picker').open = true;
  await wait();
  const box = [...messages.querySelectorAll('input[data-inbox-group-key]')].find((node) => node.dataset.inboxGroupKey === 'self\ngrp-storage');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(stored().groups, ['self\ngrp-storage']);
  assert.deepEqual(shownIds().sort(), ['a1', 'a3']);
  assert.equal(messages.querySelector('details.inbox-groups-picker').open, true);
  // Each card names its group, which the scroll anchor reads as part of its section.
  assert.deepEqual([...messages.querySelectorAll('.inbox-item')].map((node) => node.dataset.groupId), ['grp-storage', 'grp-storage']);
  // Escape closes it.
  const again = messages.querySelector('input[data-inbox-group-key]');
  again.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(messages.querySelector('details.inbox-groups-picker').open, false);
  // Unticked: everything again.
  const ticked = [...messages.querySelectorAll('input[data-inbox-group-key]')].find((node) => node.checked);
  ticked.checked = false;
  ticked.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(stored().groups, []);
  assert.equal(shownIds().length, 4);
});

test('➖ folds every card in view, the folds survive a refresh and a reload, ➕ unfolds them', async () => {
  const foldAll = () => messages.querySelector('.inbox-fold-all');
  assert.equal(foldAll().textContent, '➖');
  foldAll().click();
  assert.equal(messages.querySelectorAll('.inbox-item:not(.is-folded)').length, 0);
  assert.equal(foldAll().textContent, '➕');
  assert.deepEqual(stored().foldedItems.sort(), ['r-lab\nl1', 'self\na1', 'self\na2', 'self\na3']);
  await ui.refreshInbox();
  assert.equal(messages.querySelectorAll('.inbox-item.is-folded').length, 4, 'a refresh keeps them');
  // A new item comes unfolded.
  selfItems = [ask('a4'), ...selfItems];
  await ui.refreshInbox();
  assert.deepEqual([...messages.querySelectorAll('.inbox-item:not(.is-folded)')].map((node) => node.dataset.itemId), ['a4']);
  assert.equal(foldAll().textContent, '➖');
  // One card unfolded by its row, then folded by its chevron.
  messages.querySelector('.inbox-item[data-item-id="a1"] .inbox-item-unfold').click();
  assert.ok(messages.querySelector('.inbox-item[data-item-id="a1"] .inbox-answer'));
  messages.querySelector('.inbox-item[data-item-id="a1"] .inbox-item-fold').click();
  assert.ok(messages.querySelector('.inbox-item[data-item-id="a1"]').classList.contains('is-folded'));
  // An item that left the list is forgotten.
  selfItems = selfItems.filter((entry) => entry.id !== 'a2');
  await ui.refreshInbox();
  assert.equal(stored().foldedItems.includes('self\na2'), false);
  // ➖ again folds the new one too, then ➕ unfolds every card.
  foldAll().click();
  assert.equal(foldAll().textContent, '➕');
  foldAll().click();
  assert.equal(messages.querySelectorAll('.inbox-item.is-folded').length, 0);
  assert.deepEqual(stored().foldedItems, []);
});

test('a section folds to its heading and counts, and stays folded', async () => {
  const toggle = () => messages.querySelector('.inbox-relay[data-relay-id="r-lab"] .inbox-section-fold');
  toggle().click();
  assert.deepEqual(stored().foldedSections, ['r-lab']);
  assert.equal(toggle().getAttribute('aria-expanded'), 'false');
  assert.equal(messages.querySelector('.inbox-relay[data-relay-id="r-lab"] .inbox-item'), null);
  await ui.refreshInbox();
  assert.equal(messages.querySelector('.inbox-relay[data-relay-id="r-lab"] .inbox-item'), null);
  toggle().click();
  assert.deepEqual(stored().foldedSections, []);
});

test('a group change on this relay loads the Inbox again', async () => {
  const before = inboxReads;
  ui.noteInboxGroupsChanged();
  await wait(550);
  assert.equal(inboxReads, before + 1);
});
