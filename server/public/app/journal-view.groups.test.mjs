import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// Session groups in the sidebar, on the real index.html in JSDOM (harness as
// in journal-view.archive.test.mjs): the head row with its fold button and
// pill, the members under it, the fold rule and the stored choice, the
// waiting mark on a folded head, the synthetic head of a hand-made group, a
// hand-given name on an agent-made group, the title filter, the group
// entries of the row menus, and the picker after a dissolve. Titles are
// invented. JSDOM runs no inline handlers without scripts enabled, so a
// click on an inline-handled element is played by running its handler.
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

const GROUP = 'grp_release';
const HAND = 'grp_hand';
const rows = [
  { id: 'conv-lead', title: 'Release lead', archived: false, messageCount: 4, updatedAt: '2031-02-01T10:00:00.000Z', groupId: GROUP, groupRole: 'head' },
  { id: 'conv-docs', sdkSessionId: 'conv-docs', title: 'Docs pass', archived: false, messageCount: 2, updatedAt: '2031-02-03T10:00:00.000Z', groupId: GROUP, groupRole: 'member', activeTurn: true, sessionState: 'running_turn' },
  { id: 'conv-tests', title: 'Tests pass', archived: false, messageCount: 1, updatedAt: '2031-02-02T10:00:00.000Z', groupId: GROUP, groupRole: 'member', origin: { kind: 'agent', relayName: 'linux-test', conversationId: 'conv-lead', local: true, hops: 0 } },
  { id: 'conv-solo', title: 'Lone chat', archived: false, messageCount: 7, updatedAt: '2031-02-02T12:00:00.000Z' },
  { id: 'conv-hand-1', title: 'Old import', archived: false, messageCount: 3, updatedAt: '2031-01-05T10:00:00.000Z', groupId: HAND, groupRole: 'member' },
];
const groups = {
  [GROUP]: { id: GROUP, name: null, displayName: 'Release lead', parentConversationId: 'conv-lead', memberCount: 3, liveMemberCount: 3 },
  [HAND]: { id: HAND, name: 'Sample batch', displayName: 'Sample batch', parentConversationId: null, memberCount: 1, liveMemberCount: 1 },
};
const requests = [];
const routes = {
  '/api/conversations': (entry) => ({
    conversations: rows.filter((row) => (entry.query.archived === 'only' ? row.archived : entry.query.archived === 'true' || !row.archived)),
    knownConversationIds: rows.map((row) => row.id),
    pageInfo: { hasMore: false, nextCursor: null },
    groups: Object.fromEntries(Object.entries(groups).filter(([id]) => rows.some((row) => row.groupId === id))),
  }),
  '/api/relay-questions': () => ({ questions: [] }),
};
globalThis.fetch = async (url, opts = {}) => {
  const parsed = new URL(String(url), 'http://localhost');
  const entry = { path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), method: String(opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null };
  requests.push(entry);
  const answer = routes[parsed.pathname] ? await routes[parsed.pathname](entry) : { ok: true };
  return { ok: true, status: 200, json: async () => answer };
};

const journal = await import('./journal-view.js');
const store = await import('./store.js');
await import('./ask-user-view.js');
window.openConversation = async () => {};
// The inline handlers the rows use, as bootstrap.js exposes them on the page.
globalThis.toggleConversationGroupFold = journal.toggleConversationGroupFold;
globalThis.openConversation = (id) => window.openConversation(id);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const listed = () => [...document.querySelectorAll('#conv-list .conv-item')].map((node) => node.dataset.conversationId || `group:${node.dataset.groupId}`);
const headRow = (id) => document.querySelector(`#conv-list .conv-item.conv-group-head[data-conversation-id="${id}"]`);
const syntheticHead = (groupId) => document.querySelector(`#conv-list .conv-group-synthetic[data-group-id="${groupId}"]`);
const foldOf = (groupId) => document.querySelector(`#conv-list [data-group-fold="${groupId}"]`);
/** A click on an element with an inline handler: the handler runs with a real-looking event. */
const click = (node) => {
  const handler = node.getAttribute('onclick');
  assert.ok(handler, 'the element handles its click inline');
  const event = { stopPropagation() {}, preventDefault() {}, target: node, currentTarget: node };
  new Function('event', handler).call(node, event);
};
const menuOf = (node) => {
  node.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
  const menu = document.querySelector('.context-menu');
  const items = [...menu.querySelectorAll('.context-menu-item')].map((item) => [item.dataset.menuItem, item.disabled, item.textContent]);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return items;
};

test('a group lists its head first with a fold button and a pill, the members indented, open while a member runs', async () => {
  await journal.refreshConversations({ preservePagination: false });
  // The group's newest row (Docs pass, 02-03) lifts it above the lone chat (02-02 12:00).
  assert.deepEqual(listed(), ['conv-lead', 'conv-docs', 'conv-tests', 'conv-solo', `group:${HAND}`]);
  const head = headRow('conv-lead');
  assert.ok(head, 'the head row carries the group class');
  assert.equal(head.dataset.groupId, GROUP);
  assert.equal(foldOf(GROUP).getAttribute('aria-expanded'), 'true');
  assert.equal(foldOf(GROUP).disabled, false);
  // The pill counts every row of the group, the head included.
  assert.equal(head.querySelector('.conv-group-summary').textContent, '3 · 1 running');
  assert.ok(head.querySelector('.conv-group-summary').classList.contains('conv-group-summary-running'));
  const member = document.querySelector('[data-conversation-id="conv-tests"]');
  assert.ok(member.classList.contains('conv-group-member'));
  assert.equal(member.dataset.groupId, GROUP);
  // The member's "via agent" marker is left out under its own creator's head.
  assert.equal(member.querySelector('.conv-origin-marker'), null);
  // The hand-made group has no head row in the list: a synthetic head, folded
  // (nothing runs), a plain row whose fold button is the control.
  const hand = syntheticHead(HAND);
  assert.equal(hand.getAttribute('role'), null);
  assert.equal(hand.getAttribute('aria-label'), null);
  assert.equal(hand.querySelector('.conv-title').textContent.trim(), '▸Sample batch');
  assert.equal(hand.querySelector('.conv-group-summary').textContent, '1 session');
  assert.equal(document.querySelector('[data-conversation-id="conv-hand-1"]'), null);
});

test('the fold button folds an active group, keeps the focus and the choice; the synthetic head unfolds on click', async () => {
  const fold = foldOf(GROUP);
  fold.focus();
  click(fold);
  assert.deepEqual(listed(), ['conv-lead', 'conv-solo', `group:${HAND}`]);
  assert.equal(foldOf(GROUP).getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, foldOf(GROUP), 'the fold button keeps the focus across the re-render');
  assert.deepEqual(JSON.parse(localStorage.getItem('copilot_conv_group_folds')), { [GROUP]: 'folded' });
  // A re-render keeps the user's fold.
  journal.renderConvList();
  assert.deepEqual(listed(), ['conv-lead', 'conv-solo', `group:${HAND}`]);
  click(syntheticHead(HAND));
  assert.deepEqual(listed(), ['conv-lead', 'conv-solo', `group:${HAND}`, 'conv-hand-1']);
  assert.deepEqual(JSON.parse(localStorage.getItem('copilot_conv_group_folds')), { [GROUP]: 'folded', [HAND]: 'open' });
  click(foldOf(HAND));
  assert.deepEqual(listed(), ['conv-lead', 'conv-solo', `group:${HAND}`]);
});

test('a waiting card in a folded member shows first on the head; its pill opens that member', async () => {
  const openedIds = [];
  window.openConversation = async (id) => { openedIds.push(id); };
  store.relayQuestions.set('q-1', { id: 'q-1', conversationId: 'conv-tests', status: 'pending', prompt: 'Which branch?' });
  journal.renderConvList();
  const pill = headRow('conv-lead').querySelector('.conv-group-summary');
  assert.equal(pill.textContent, '3 · 1 waiting for you, 1 running');
  assert.ok(pill.classList.contains('conv-group-summary-waiting'));
  assert.equal(pill.dataset.openWaiting, 'conv-tests');
  assert.deepEqual(listed(), ['conv-lead', 'conv-solo', `group:${HAND}`], 'still folded');
  click(pill);
  await flush();
  assert.deepEqual(openedIds, ['conv-tests'], 'the pill opens the waiting member');
  // Keyboard: Enter on the pill opens it too.
  pill.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.deepEqual(openedIds, ['conv-tests', 'conv-tests']);
  // "Stop all running" counts the waiting member: its turn is live.
  const items = menuOf(headRow('conv-lead'));
  assert.deepEqual(items.find(([id]) => id === 'group-stop').slice(1), [false, 'Stop all running (2)']);
  store.relayQuestions.delete('q-1');
  window.openConversation = async () => {};
});

test('the group that holds the open chat stays open and its fold button says so', async () => {
  store.setCurrentConv('conv-tests');
  journal.renderConvList();
  assert.deepEqual(listed(), ['conv-lead', 'conv-docs', 'conv-tests', 'conv-solo', `group:${HAND}`]);
  const fold = foldOf(GROUP);
  assert.equal(fold.disabled, true);
  assert.match(fold.getAttribute('aria-label'), /its chat is open/);
  click(fold);
  assert.deepEqual(JSON.parse(localStorage.getItem('copilot_conv_group_folds')), { [GROUP]: 'folded', [HAND]: 'folded' }, 'the choice is untouched');
  store.setCurrentConv(null);
  journal.renderConvList();
  assert.deepEqual(listed(), ['conv-lead', 'conv-solo', `group:${HAND}`]);
});

test('a title filter shows a matching member under its head as context, and opens every listed group', async () => {
  journal.setConversationListFilter('tests');
  await flush();
  assert.deepEqual(listed(), ['conv-lead', 'conv-tests']);
  assert.equal(foldOf(GROUP).disabled, true);
  journal.setConversationListFilter('sample');
  await flush();
  assert.deepEqual(listed(), [`group:${HAND}`, 'conv-hand-1']);
  journal.setConversationListFilter('');
  await flush();
  assert.deepEqual(listed(), ['conv-lead', 'conv-solo', `group:${HAND}`]);
});

test('a name given by hand shows on the head row; the filter finds it', async () => {
  groups[GROUP].name = 'Night batch';
  groups[GROUP].displayName = 'Night batch';
  await journal.refreshConversations({ preservePagination: false });
  const head = headRow('conv-lead');
  assert.equal(head.querySelector('.conv-title').textContent.trim(), '▸Night batch');
  assert.equal(head.querySelector('.conv-title').getAttribute('title'), 'Night batch · Release lead');
  journal.setConversationListFilter('night');
  await flush();
  assert.deepEqual(listed(), ['conv-lead', 'conv-docs', 'conv-tests']);
  journal.setConversationListFilter('');
  await flush();
  groups[GROUP].name = null;
  groups[GROUP].displayName = 'Release lead';
  await journal.refreshConversations({ preservePagination: false });
  assert.equal(headRow('conv-lead').querySelector('.conv-title').textContent.trim(), '▸Release lead');
});

test('the row menus carry the group entries: the head its actions, a member leave and move, a lone chat add', async () => {
  assert.deepEqual(menuOf(headRow('conv-lead')).map(([id]) => id), [
    'open', 'edit-title', 'stop-turn', 'kill-session',
    'group-archive', 'group-stop', 'group-rename', 'group-dissolve', 'group-move', 'group-remove',
    'archive', 'delete',
  ]);
  assert.deepEqual(menuOf(headRow('conv-lead')).find(([id]) => id === 'group-stop').slice(1), [false, 'Stop all running (1)'], 'one member runs');
  assert.deepEqual(menuOf(document.querySelector('[data-conversation-id="conv-solo"]')).map(([id]) => id), [
    'open', 'edit-title', 'stop-turn', 'kill-session', 'group-add', 'archive', 'delete',
  ]);
  assert.deepEqual(menuOf(syntheticHead(HAND)).map(([id]) => id), ['group-archive', 'group-stop', 'group-rename', 'group-dissolve']);
  click(foldOf(GROUP));
  // A member also steps up and down the group's order; the first cannot go up.
  const docsMenu = menuOf(document.querySelector('[data-conversation-id="conv-docs"]'));
  assert.deepEqual(docsMenu.map(([id]) => id), [
    'open', 'edit-title', 'stop-turn', 'kill-session', 'group-move-up', 'group-move-down', 'group-move', 'group-remove', 'archive', 'delete',
  ]);
  assert.deepEqual(docsMenu.filter(([id]) => id.startsWith('group-move-')).map(([, disabled, label]) => [label, disabled]), [['Move up', true], ['Move down', false]]);
  const testsMenu = menuOf(document.querySelector('[data-conversation-id="conv-tests"]'));
  assert.deepEqual(testsMenu.filter(([id]) => id.startsWith('group-move-')).map(([, disabled, label]) => [label, disabled]), [['Move up', false], ['Move down', true]]);
});

test('Move up puts the member before the one above it, through the relay; the row flashes and the move is announced', async () => {
  const before = requests.length;
  routes['/api/conversation/conv-tests/group'] = () => ({ ok: true, groupId: GROUP, previousGroupId: GROUP, changed: true, order: ['conv-lead', 'conv-tests', 'conv-docs'] });
  const row = document.querySelector('[data-conversation-id="conv-tests"]');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
  document.querySelector('[data-menu-item="group-move-up"]').click();
  await flush();
  await flush();
  const sent = requests.slice(before).filter((request) => request.path === '/api/conversation/conv-tests/group');
  assert.deepEqual(sent.map((request) => [request.method, request.body]), [['PUT', { groupId: GROUP, beforeConversationId: 'conv-docs' }]]);
  // The answer changes nothing: the relay's event is the only source of the order.
  assert.deepEqual(['conv-lead', 'conv-tests', 'conv-docs'].map((id) => store.conversations[id].groupPosition ?? null), [null, null, null]);
  assert.ok(document.querySelector('[data-conversation-id="conv-tests"]').classList.contains('conv-drop-flash'));
  journal.applyConversationGroupEvent({
    groupId: GROUP,
    conversationIds: ['conv-tests'],
    group: { ...groups[GROUP] },
    memberships: { 'conv-tests': { groupId: GROUP, role: 'member' } },
    order: ['conv-lead', 'conv-tests', 'conv-docs'],
    positions: { 'conv-tests': 10, 'conv-docs': 20 },
  });
  assert.deepEqual(listed().slice(0, 3), ['conv-lead', 'conv-tests', 'conv-docs']);
  assert.ok(document.querySelector('[data-conversation-id="conv-tests"]').classList.contains('conv-drop-flash'), 'flashed again where the event put it');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.getElementById('conv-list-announce').textContent, 'Moved “Tests pass” within “Release lead”');
  delete routes['/api/conversation/conv-tests/group'];
});

test('a refused move says why and reloads the list', async () => {
  const notices = [];
  const fetchesBefore = requests.filter((request) => request.path === '/api/conversations').length;
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const parsed = new URL(String(url), 'http://localhost');
    if (parsed.pathname === '/api/conversation/conv-tests/group') {
      requests.push({ path: parsed.pathname, method: opts.method, body: JSON.parse(opts.body || 'null'), query: {} });
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'Group not found' }) };
    }
    return saved(url, opts);
  };
  const toast = document.getElementById('relay-toast');
  // The order the move above set: Tests pass first now, so it can go down.
  assert.deepEqual(listed().slice(0, 3), ['conv-lead', 'conv-tests', 'conv-docs']);
  const row = document.querySelector('[data-conversation-id="conv-tests"]');
  row.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 60 }));
  document.querySelector('[data-menu-item="group-move-down"]').click();
  await new Promise((resolve) => setTimeout(resolve, 250));
  notices.push(toast?.textContent || '');
  assert.match(notices[0], /Group not found/);
  assert.equal(requests.filter((request) => request.path === '/api/conversations').length, fetchesBefore + 1, 'the list was fetched again');
  globalThis.fetch = saved;
});

test('the picker lists the groups by name and makes a new one; a pick moves the conversation', async () => {
  journal.openConversationGroupPicker('conv-solo');
  const picker = document.getElementById('conv-group-picker');
  assert.ok(picker, 'the picker opened');
  const choices = [...picker.querySelectorAll('[data-group-choice]')].map((node) => [node.dataset.groupChoice, node.querySelector('.conv-group-choice-name').textContent]);
  assert.deepEqual(choices, [[GROUP, 'Release lead'], [HAND, 'Sample batch']]);
  picker.querySelector(`[data-group-choice="${HAND}"]`).click();
  await flush();
  await flush();
  const moved = requests.find((request) => request.method === 'PUT' && request.path === '/api/conversation/conv-solo/group');
  assert.deepEqual(moved.body, { groupId: HAND });

  journal.openConversationGroupPicker('conv-docs');
  const input = document.getElementById('conv-group-create-input');
  input.value = 'Night batch';
  document.getElementById('conv-group-create-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  await flush();
  const created = requests.find((request) => request.method === 'POST' && request.path === '/api/conversation-groups');
  assert.deepEqual(created.body, { name: 'Night batch', conversationIds: ['conv-docs'] });
});

test('after a dissolve the picker no longer offers the dead group', async () => {
  // The relay dissolved the hand-made group: its row is a plain row now, and
  // the next list fetch carries no such group.
  rows[4].groupId = null;
  rows[4].groupRole = null;
  await journal.refreshConversations({ preservePagination: false });
  assert.equal(store.conversationGroups[HAND], undefined, 'the group map forgets it');
  journal.openConversationGroupPicker('conv-solo');
  const choices = [...document.querySelectorAll('#conv-group-picker [data-group-choice]')].map((node) => node.dataset.groupChoice);
  assert.deepEqual(choices, [GROUP]);
  // The stored fold choice of a group that is merely not loaded stays.
  localStorage.setItem('copilot_conv_group_folds', JSON.stringify({ grp_older_page: 'open', [GROUP]: 'folded' }));
  store.setConversationGroupFoldChoice(GROUP, 'open');
  assert.deepEqual(JSON.parse(localStorage.getItem('copilot_conv_group_folds')), { grp_older_page: 'open', [GROUP]: 'open' });
});

test('a group change event is applied in place: the name, the membership, the end of a group; no fetch', async () => {
  const fetchesBefore = requests.filter((request) => request.path === '/api/conversations').length;
  // The lone chat joins the release group, which gets a name, as the relay announces it.
  assert.equal(journal.applyConversationGroupEvent({
    groupId: GROUP,
    conversationIds: ['conv-solo'],
    group: { id: GROUP, name: 'Night batch', displayName: 'Night batch', parentConversationId: 'conv-lead', memberCount: 4, liveMemberCount: 4 },
    memberships: { 'conv-solo': { groupId: GROUP, role: 'member' } },
  }), 'in-place');
  assert.equal(document.querySelector('[data-conversation-id="conv-solo"]').classList.contains('conv-group-member'), true);
  assert.equal(headRow('conv-lead').querySelector('.conv-title').textContent.trim(), '▾Night batch');
  // The group's hand order, when the relay sends it, lands on the records.
  journal.applyConversationGroupEvent({
    groupId: GROUP,
    conversationIds: ['conv-solo'],
    group: { id: GROUP, name: 'Night batch', displayName: 'Night batch', parentConversationId: 'conv-lead', memberCount: 4, liveMemberCount: 4 },
    memberships: { 'conv-solo': { groupId: GROUP, role: 'member' } },
    order: ['conv-lead', 'conv-solo', 'conv-docs', 'conv-tests'],
    positions: { 'conv-lead': null, 'conv-solo': 1, 'conv-docs': 2, 'conv-tests': 'x' },
  });
  assert.deepEqual(['conv-lead', 'conv-solo', 'conv-docs', 'conv-tests'].map((id) => store.conversations[id].groupPosition), [null, 1, 2, null]);
  // Dissolved: every named row is a plain row again and the group is forgotten.
  assert.equal(journal.applyConversationGroupEvent({
    groupId: GROUP,
    conversationIds: ['conv-lead', 'conv-docs', 'conv-tests', 'conv-solo'],
    group: null,
    memberships: { 'conv-lead': null, 'conv-docs': null, 'conv-tests': null, 'conv-solo': null },
  }), 'in-place');
  assert.equal(document.querySelector('#conv-list .conv-group-head'), null);
  assert.equal(store.conversationGroups[GROUP], undefined);
  assert.equal(store.conversations['conv-solo'].groupPosition, null, 'a row out of its group has no place in one');
  assert.equal(requests.filter((request) => request.path === '/api/conversations').length, fetchesBefore, 'nothing was fetched');
  // An event that names a row this page has not loaded, or carries no detail, schedules one fetch.
  assert.equal(journal.applyConversationGroupEvent({ groupId: 'grp_far', conversationIds: ['conv-far'], group: { id: 'grp_far', displayName: 'Far' }, memberships: { 'conv-far': { groupId: 'grp_far', role: 'member' } } }), 'fetch');
  assert.equal(journal.applyConversationGroupEvent({ groupId: 'grp_far', conversationIds: ['conv-far'] }), 'fetch');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(requests.filter((request) => request.path === '/api/conversations').length, fetchesBefore + 1, 'two events within a moment, one fetch');
  // Back to the fixture for the tests below.
  await journal.refreshConversations({ preservePagination: false });
});

test('a fetched row is the truth and a gone worker ends its background work; the events only move it forward', async () => {
  // The docs member fetched as background_only (its turn ended, a task runs).
  rows[1].activeTurn = false;
  rows[1].sessionState = 'background_only';
  rows[1].sessionTasks = [{ taskId: 't-1', status: 'running' }];
  await journal.refreshConversations({ preservePagination: false });
  assert.equal(store.conversations['conv-docs'].backgroundTaskCount, 1);
  let items = menuOf(headRow('conv-lead'));
  assert.deepEqual(items.find(([id]) => id === 'group-stop').slice(1), [false, 'Stop all running (1)'], 'background work counts');
  // The status poll answers without a worker for it: the work is gone with the worker.
  store.setSessionWorkerStatesFromStatusPayload({ workers: [] });
  journal.renderConvList();
  items = menuOf(headRow('conv-lead'));
  assert.deepEqual(items.find(([id]) => id === 'group-stop').slice(1), [true, 'Stop all running (0)'], 'no live worker, no background work');
  // A live worker brings it back.
  store.setSessionWorkerStatesFromStatusPayload({ workers: [{ sdkSessionId: 'conv-docs', status: 'ready' }] });
  journal.renderConvList();
  assert.deepEqual(menuOf(headRow('conv-lead')).find(([id]) => id === 'group-stop').slice(1), [false, 'Stop all running (1)']);
  // A reconnect fetches the list again: what the relay says replaces what the events left.
  rows[1].sessionState = 'idle';
  rows[1].sessionTasks = [];
  await journal.refreshLoadedConversations();
  assert.deepEqual(menuOf(headRow('conv-lead')).find(([id]) => id === 'group-stop').slice(1), [true, 'Stop all running (0)']);
  delete rows[1].activeTurn;
  delete rows[1].sessionState;
  delete rows[1].sessionTasks;
});

test('overlapping refreshes run one at a time and the last state lands on every page', async () => {
  // Two pages of one row each; the second refresh starts while the first is
  // mid-flight and changes what the relay answers.
  const pageRows = [
    { id: 'conv-p1', title: 'Page one', archived: false, messageCount: 1, updatedAt: '2031-03-02T10:00:00.000Z' },
    { id: 'conv-p2', title: 'Page two', archived: false, messageCount: 1, updatedAt: '2031-03-01T10:00:00.000Z' },
  ];
  let version = 'a';
  let delayMs = 30;
  routes['/api/conversations'] = async (entry) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const start = entry.query.beforeConversationId ? pageRows.findIndex((row) => row.id === entry.query.beforeConversationId) + 1 : 0;
    const page = pageRows.slice(start, start + 1).map((row) => ({ ...row, title: `${row.title} ${version}` }));
    const last = page[page.length - 1];
    return { conversations: page, pageInfo: { hasMore: start + 1 < pageRows.length, nextCursor: last ? { beforeConversationId: last.id, beforeUpdatedAt: last.updatedAt } : null }, groups: {} };
  };
  for (const id of Object.keys(store.conversations)) delete store.conversations[id];
  await journal.refreshConversations({ preservePagination: false });
  // The lazy loader brings page two by itself (the list has no height here).
  for (let attempt = 0; attempt < 40 && !store.conversations['conv-p2']; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(Object.keys(store.conversations).sort(), ['conv-p1', 'conv-p2']);
  const countBefore = requests.filter((request) => request.path === '/api/conversations').length;
  const first = journal.refreshLoadedConversations();
  await new Promise((resolve) => setTimeout(resolve, 10));
  version = 'b';
  const second = journal.refreshLoadedConversations();
  await Promise.all([first, second]);
  assert.equal(store.conversations['conv-p1'].title, 'Page one b');
  assert.equal(store.conversations['conv-p2'].title, 'Page two b', 'the deep page carries the last state');
  const fetched = requests.filter((request) => request.path === '/api/conversations').length - countBefore;
  assert.ok(fetched >= 3 && fetched <= 4, `one run plus one rerun, not two interleaved: ${fetched} fetches`);
  delayMs = 0;
});

test('a drag holds the list\'s re-renders until the row is let go; a loose row onto another makes a group, shown open', async () => {
  // Two loose rows from the test above. JSDOM lays nothing out: every row gets a box.
  const list = document.getElementById('conv-list');
  journal.renderConvList();
  const layout = () => {
    list.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 400, width: 200, height: 400 });
    [...list.querySelectorAll('.conv-item')].forEach((node, index) => {
      node.getBoundingClientRect = () => ({ left: 0, top: index * 40, right: 200, bottom: index * 40 + 38, width: 200, height: 38 });
    });
  };
  layout();
  assert.deepEqual(listed(), ['conv-p1', 'conv-p2']);
  const pointer = (target, type, y, buttons = 1) => target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: 50, clientY: y, pointerType: 'mouse', button: 0, buttons, pointerId: 3 }));
  const dragged = document.querySelector('[data-conversation-id="conv-p2"]');
  pointer(dragged, 'pointerdown', 60);
  pointer(dragged, 'pointermove', 20);
  assert.ok(document.querySelector('.conv-drag-ghost'), 'dragging');
  assert.ok(document.querySelector('[data-conversation-id="conv-p1"]').classList.contains('conv-drop-new-group'));
  // A change arrives mid-drag: applied to the record, drawn later.
  store.conversations['conv-p1'].title = 'Page one renamed';
  journal.renderConvList();
  assert.equal(document.querySelector('[data-conversation-id="conv-p1"] .conv-title').textContent.trim(), 'Page one b', 'not drawn during the drag');
  routes['/api/conversation-groups'] = (entry) => ({ ok: true, group: { id: 'grp_pair', name: null, parentConversationId: null, members: entry.body.conversationIds } });
  const before = requests.length;
  pointer(document, 'pointerup', 20, 0);
  assert.equal(document.querySelector('[data-conversation-id="conv-p1"] .conv-title').textContent.trim(), 'Page one renamed', 'drawn once let go');
  await flush();
  await flush();
  const made = requests.slice(before).filter((request) => request.method === 'POST' && request.path === '/api/conversation-groups');
  assert.deepEqual(made.map((request) => request.body), [{ name: null, conversationIds: ['conv-p1', 'conv-p2'] }]);
  // The relay's event brings the group.
  journal.applyConversationGroupEvent({
    groupId: 'grp_pair',
    conversationIds: ['conv-p1', 'conv-p2'],
    group: { id: 'grp_pair', name: null, displayName: 'Page one renamed', parentConversationId: null, memberCount: 2, liveMemberCount: 2 },
    memberships: { 'conv-p1': { groupId: 'grp_pair', role: 'member' }, 'conv-p2': { groupId: 'grp_pair', role: 'member' } },
    order: ['conv-p1', 'conv-p2'],
    positions: { 'conv-p1': null, 'conv-p2': null },
  });
  // The new group shows open (nothing in it runs, which would fold it), its rows under a synthetic head.
  assert.deepEqual(listed(), ['group:grp_pair', 'conv-p1', 'conv-p2']);
  assert.equal(localStorage.getItem('copilot_conv_group_folds')?.includes('grp_pair') || false, false, 'no fold choice is stored');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(document.getElementById('conv-list-announce').textContent, 'New group with “Page one renamed” and “Page two b”');
  delete routes['/api/conversation-groups'];
});
