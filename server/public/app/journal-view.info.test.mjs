import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The sidebar row's ⓘ, on the real index.html in JSDOM (harness as in
// journal-view.groups.test.mjs): one button stands for "an agent started
// it", "watched" and "scheduled"; its menu lists them with their actions and
// a tap on it never opens the row. Titles are invented.
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
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
window.confirm = () => true;

const rows = [
  { id: 'conv-planner', title: 'Garden planner', archived: false, messageCount: 5, updatedAt: '2031-03-01T10:00:00.000Z' },
  { id: 'conv-seeds', title: 'Seed order', archived: false, messageCount: 2, updatedAt: '2031-03-02T10:00:00.000Z', origin: { kind: 'agent', local: true, relayName: 'shed-relay', conversationId: 'conv-planner', conversationTitle: 'Garden planner', hops: 0 } },
  { id: 'conv-water', title: 'Watering log', archived: false, messageCount: 9, updatedAt: '2031-03-01T12:00:00.000Z' },
  { id: 'conv-plain', title: 'Compost notes', archived: false, messageCount: 1, updatedAt: '2031-02-20T10:00:00.000Z' },
];
const routes = {
  '/api/conversations': () => ({
    conversations: rows,
    knownConversationIds: rows.map((row) => row.id),
    pageInfo: { hasMore: false, nextCursor: null },
    groups: {},
  }),
  '/api/relay-questions': () => ({ questions: [] }),
};
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url), 'http://localhost');
  const answer = routes[parsed.pathname] ? await routes[parsed.pathname]() : { ok: true };
  return { ok: true, status: 200, json: async () => answer };
};

const journal = await import('./journal-view.js');
const store = await import('./store.js');
const { applyRelayEventSubscriptions } = await import('./relay-event-subscriptions-ui.js');
const { applyRelaySchedules } = await import('./relay-schedules-ui.js');
window.openConversation = async () => {};
globalThis.openConversation = (id) => window.openConversation(id);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const rowOf = (id) => document.querySelector(`#conv-list .conv-item[data-conversation-id="${id}"]`);
const infoOf = (id) => rowOf(id)?.querySelector('.conv-info-btn') || null;
const openMenu = () => document.querySelector('.context-menu');
const escape = () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

test('a row an agent started shows the ⓘ in its meta line and no marker pill; a row without one has none', async () => {
  await journal.refreshConversations({ preservePagination: false });
  const button = infoOf('conv-seeds');
  assert.ok(button, 'the ⓘ is there');
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(button.parentElement.classList.contains('conv-meta'), true);
  assert.equal(button.textContent, 'ⓘ');
  assert.equal(button.getAttribute('aria-label'), 'Details: started by an agent');
  assert.equal(button.getAttribute('title'), 'Details: started by an agent');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  for (const selector of ['.conv-origin-marker', '.conv-watched-badge', '.conv-scheduled-badge']) {
    assert.equal(document.querySelector(`#conv-list ${selector}`), null, selector);
  }
  assert.equal(infoOf('conv-plain'), null);
  assert.equal(infoOf('conv-planner'), null);
});

test('the ⓘ opens its menu under itself and never the row; Escape closes it and gives the focus back', async () => {
  let rowClicks = 0;
  rowOf('conv-seeds').addEventListener('click', () => { rowClicks += 1; });
  const button = infoOf('conv-seeds');
  button.focus();
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
  button.dispatchEvent(event);
  assert.equal(rowClicks, 0, 'the row\'s own click (open this conversation) never runs');
  assert.equal(event.defaultPrevented, true);
  const menu = openMenu();
  assert.ok(menu);
  assert.deepEqual([...menu.children].map((node) => [node.dataset.menuItem, node.tagName, node.textContent]), [
    ['origin', 'BUTTON', 'Started by an agent in “Garden planner”'],
  ]);
  escape();
  assert.equal(openMenu(), null);
  assert.equal(document.activeElement, infoOf('conv-seeds'), 'the focus is back on the ⓘ');
  assert.equal(store.currentConvId, null);
});

test('the origin line opens the conversation whose agent started this one', async () => {
  infoOf('conv-seeds').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  openMenu().querySelector('[data-menu-item="origin"]').click();
  await settle();
  assert.equal(openMenu(), null, 'the menu closes');
  assert.equal(store.currentConvId, 'conv-planner');
});

test('watched and scheduled join the same ⓘ as lines of text, each named in its label', async () => {
  applyRelayEventSubscriptions([
    { id: 'sub_fixture', watcher: 'conv-planner', relay: 'self', scope: 'sessions', sessions: [{ id: 'conv-water' }, { id: 'conv-seeds' }], events: ['turn_end'] },
  ]);
  const next = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  applyRelaySchedules([
    { id: 'sch_fixture', session: { id: 'conv-water', title: 'Watering log' }, title: 'Morning round', text: 'Check the beds.', everyMinutes: 1440, once: false, nextFireAt: next },
  ]);
  journal.renderConvList();
  assert.equal(infoOf('conv-seeds').getAttribute('aria-label'), 'Details: started by an agent, watched');
  const water = infoOf('conv-water');
  assert.equal(water.getAttribute('aria-label'), 'Details: watched, scheduled');
  water.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  const items = [...openMenu().children].map((node) => [node.dataset.menuItem, node.className, node.textContent]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], ['watched', 'context-menu-note', 'Watched by Garden planner']);
  assert.equal(items[1][0], 'scheduled');
  assert.equal(items[1][1], 'context-menu-note');
  assert.match(items[1][2], /^Scheduled · next .+/);
  escape();
  assert.equal(infoOf('conv-plain'), null);
  applyRelayEventSubscriptions([]);
  applyRelaySchedules([]);
  journal.renderConvList();
  assert.equal(infoOf('conv-water'), null, 'gone with the last of them');
});

test('a menu of lines only takes the focus and names every watcher', async () => {
  applyRelayEventSubscriptions([
    { id: 'sub_fixture_a', watcher: 'conv-planner', relay: 'self', scope: 'sessions', sessions: [{ id: 'conv-water' }], events: ['turn_end'] },
    { id: 'sub_fixture_b', watcher: 'conv-plain', relay: 'self', scope: 'sessions', sessions: [{ id: 'conv-water' }], events: ['turn_end'] },
  ]);
  journal.renderConvList();
  const water = infoOf('conv-water');
  water.focus();
  water.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  const menu = openMenu();
  assert.deepEqual([...menu.children].map((node) => node.textContent), ['Watched by 2 sessions: Garden planner, Compost notes']);
  await settle();
  assert.equal(document.activeElement, menu, 'focus on the menu, so it is read out');
  assert.equal(menu.getAttribute('tabindex'), '-1');
  assert.equal(menu.getAttribute('aria-label'), 'Watched by 2 sessions: Garden planner, Compost notes');
  escape();
  assert.equal(openMenu(), null);
  assert.equal(document.activeElement, infoOf('conv-water'), 'Escape gives the focus back to the ⓘ');
  applyRelayEventSubscriptions([]);
  journal.renderConvList();
});
