import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// 📓 Questions against the real index.html: the header icon, the list under
// it, the phone's sheet and backdrop, and the list kept current by the
// socket, a reconnect and the Inbox's "open".
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const dom = new JSDOM(indexHtml, { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });
let phone = false;
window.matchMedia = (query) => ({ matches: phone && /max-width: 680px/.test(query), addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 0);
globalThis.CSS ??= { escape: (value) => String(value).replace(/["\\]/g, '\\$&') };
window.renderConvList = () => {};

const NOW = Date.now();
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
function ask(id, extra = {}) {
  return {
    id,
    kind: 'ask',
    conversationId: 'conv-heron',
    session: { id: 'conv-heron', title: 'Heron nest survey' },
    question: `Question ${id}?`,
    options: ['Option A', 'Option B'],
    status: 'pending',
    urgency: 'normal',
    createdAt: minutesAgo(10),
    updatedAt: minutesAgo(10),
    ...extra,
  };
}

// The relay: GET /api/relay-asks answers from `served`, per conversation;
// `hold` keeps the next answer back until it is released.
const served = new Map();
const requests = [];
let hold = null;
globalThis.fetch = async (rawUrl) => {
  const url = new URL(String(rawUrl), 'http://localhost/');
  requests.push(url.pathname + url.search);
  if (hold && url.pathname.endsWith('/api/relay-asks')) {
    const { promise, list } = hold;
    hold = null;
    await promise;
    return new Response(JSON.stringify({ available: true, asks: list, pending: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  let body = {};
  if (url.pathname.endsWith('/api/relay-asks')) {
    body = { available: true, asks: served.get(url.searchParams.get('conversationId')) || [], pending: 0 };
  } else if (url.pathname.endsWith('/api/inbox')) {
    body = { relays: [] };
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const ui = await import('./questions-panel-ui.js');
const { bindMenuAction } = await import('./tap-actions.js');
// A click a pointer made (detail 1), as a tap's is; element.click() has detail 0.
const tapClick = () => new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
const store = await import('./store.js');
ui.initQuestionsPanel();

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const button = () => document.getElementById('questions-btn');
const count = () => button().querySelector('.header-icon-count');
const panel = () => document.getElementById('questions-panel');
const backdrop = () => document.getElementById('questions-panel-backdrop');
const cardIds = () => [...panel().querySelectorAll('.inbox-item')].map((card) => card.dataset.itemId);

async function show(conversationId, asks) {
  served.set(conversationId, asks);
  store.setCurrentConv(conversationId);
  ui.setQuestionsConversation(conversationId);
  // Already on screen: a load as after a reconnect.
  await ui.refreshQuestions();
  await wait();
}

test('📓 is hidden at zero, and comes first in the header', async () => {
  const actions = document.getElementById('chat-header-actions');
  assert.equal(actions.firstElementChild.id, 'questions-btn');
  await show('conv-empty', []);
  assert.equal(button().hidden, true);
  assert.equal(button().dataset.count, '0');
});

test('an urgent ask waiting: the urgent count in red; answered, the open count as usual', async () => {
  await show('conv-heron', [ask('q1'), ask('q2', { urgency: 'now' }), ask('q3')]);
  assert.equal(button().hidden, false);
  assert.equal(count().textContent, '1');
  assert.equal(count().classList.contains('is-urgent'), true);
  assert.equal(button().dataset.count, '3');
  assert.equal(button().dataset.urgent, '1');
  assert.equal(button().getAttribute('title'), 'Questions (1 urgent of 3 open)');
  assert.equal(button().getAttribute('aria-label'), 'Questions (1 urgent of 3 open)');
  ui.noteQuestionAskUpdated(ask('q2', { urgency: 'now', status: 'answered', choice: 'Option B', answer: 'Option B', answeredAt: minutesAgo(0) }));
  assert.equal(count().textContent, '2');
  assert.equal(count().classList.contains('is-urgent'), false);
  assert.equal(button().getAttribute('title'), 'Questions (2 open)');
});

test('the list: urgent first with its Details open, answered under the divider; it stays open across an answer', async () => {
  await show('conv-heron', [ask('q1', { createdAt: minutesAgo(3) }), ask('q2', { urgency: 'now', detail: 'Why it matters' }), ask('q3', { createdAt: minutesAgo(1) })]);
  button().click();
  assert.equal(ui.isQuestionsPanelOpen(), true);
  assert.equal(panel().hidden, false);
  assert.equal(button().getAttribute('aria-expanded'), 'true');
  assert.equal(panel().querySelector('.questions-panel-title').textContent, '📓 Questions · 1 urgent · 3 open');
  assert.deepEqual(cardIds(), ['q2', 'q3', 'q1']);
  assert.equal(panel().querySelector('.inbox-item[data-item-id="q2"] details.inbox-item-detail').open, true);
  ui.noteQuestionAskUpdated(ask('q2', { urgency: 'now', status: 'answered', choice: 'Option B', answer: 'Option B', answeredAt: minutesAgo(0) }));
  assert.equal(ui.isQuestionsPanelOpen(), true);
  assert.deepEqual(cardIds(), ['q3', 'q1', 'q2']);
  assert.equal(panel().querySelector('.inbox-divider').textContent, 'Answered in the last day');
  assert.equal(panel().querySelector('.inbox-item[data-item-id="q2"] .inbox-item-outcome').textContent, 'Answered: Option B');
  assert.equal(panel().querySelector('.inbox-item[data-item-id="q2"] button'), null);
  ui.closeQuestionsPanel();
});

test('a typed draft survives a re-render from the socket', async () => {
  await show('conv-heron', [ask('q1'), ask('q3')]);
  ui.openQuestionsPanel({ anchor: button() });
  const field = panel().querySelector('.inbox-item[data-item-id="q1"] .inbox-answer-text');
  field.value = 'Half a thought';
  field.dispatchEvent(new window.Event('input', { bubbles: true }));
  ui.noteQuestionAskUpdated(ask('q3', { status: 'dismissed', answeredAt: minutesAgo(0) }));
  assert.equal(panel().querySelector('.inbox-item[data-item-id="q1"] .inbox-answer-text').value, 'Half a thought');
  ui.closeQuestionsPanel();
});

test('Escape, ✕ and a click outside close it; Escape gives the focus back to 📓', async () => {
  await show('conv-heron', [ask('q1')]);
  ui.openQuestionsPanel({ anchor: button() });
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(ui.isQuestionsPanelOpen(), false);
  assert.equal(panel().hidden, true);
  assert.equal(button().getAttribute('aria-expanded'), 'false');

  ui.openQuestionsPanel({ anchor: button() });
  panel().querySelector('.questions-panel-close').click();
  assert.equal(ui.isQuestionsPanelOpen(), false);

  ui.openQuestionsPanel({ anchor: button() });
  // A click inside (a card's Details) keeps it open; one outside closes it.
  panel().querySelector('.inbox-item').click();
  assert.equal(ui.isQuestionsPanelOpen(), true);
  document.getElementById('messages').click();
  assert.equal(ui.isQuestionsPanelOpen(), false);
});

test('opened at an ask: that card is marked', async () => {
  await show('conv-heron', [ask('q1'), ask('q3')]);
  ui.openQuestionsPanel({ askId: 'q1' });
  assert.equal(panel().querySelector('.questions-card-focus')?.dataset.itemId, 'q1');
  assert.equal(panel().querySelectorAll('.questions-card-focus').length, 1);
  ui.closeQuestionsPanel();
  ui.openQuestionsPanel();
  assert.equal(panel().querySelector('.questions-card-focus'), null);
  ui.closeQuestionsPanel();
});

test('on a phone: a sheet over a dim backdrop; a tap on the backdrop closes it', async () => {
  phone = true;
  try {
    await show('conv-heron', [ask('q1')]);
    const input = document.getElementById('msg-input');
    input.focus();
    ui.openQuestionsPanel({ anchor: button() });
    assert.equal(panel().classList.contains('is-sheet'), true);
    assert.equal(backdrop().hidden, false);
    assert.notEqual(document.activeElement, input, 'the composer lets go of the keyboard');
    // Opened from 📓 (a click): the next tap on the backdrop closes it.
    backdrop().click();
    assert.equal(ui.isQuestionsPanelOpen(), false);
    assert.equal(backdrop().hidden, true);
    // Opened from ︙ by a mouse (or a script): a tap on the backdrop right
    // away closes it too; nothing is owed.
    ui.openQuestionsPanel({ anchor: document.getElementById('chat-actions-menu-btn') });
    backdrop().dispatchEvent(tapClick());
    assert.equal(ui.isQuestionsPanelOpen(), false);
    assert.equal(backdrop().hidden, true);
  } finally {
    phone = false;
  }
  ui.openQuestionsPanel({ anchor: button() });
  assert.equal(panel().classList.contains('is-sheet'), false);
  assert.equal(backdrop().hidden, true);
  ui.closeQuestionsPanel();
});

test('on a phone, the ︙ entry\'s touch: its own click is swallowed by the entry\'s tap guard, the next tap closes', async () => {
  phone = true;
  // The ︙ twin as bootstrap.js binds it (bindHeaderPriorityAction): a menu
  // action that opens the list under ︙.
  const twin = document.getElementById('chat-menu-questions');
  bindMenuAction(twin, () => ui.openQuestionsPanel({ anchor: document.getElementById('chat-actions-menu-btn') }));
  try {
    await show('conv-heron', [ask('g1')]);
    twin.hidden = false;
    // A finger lifts on the entry: it runs on the pointerup.
    const lift = new window.Event('pointerup', { bubbles: true, cancelable: true });
    Object.defineProperties(lift, { pointerType: { value: 'touch' }, button: { value: 0 } });
    twin.dispatchEvent(lift);
    assert.equal(ui.isQuestionsPanelOpen(), true);
    assert.equal(backdrop().hidden, false);
    // The compatibility click the browser fires a few ms later lands on the
    // backdrop that is now under the finger: no tap.
    backdrop().dispatchEvent(tapClick());
    assert.equal(ui.isQuestionsPanelOpen(), true, 'the opening touch\'s click does not close it');
    // A real tap, right after: closes it, with no waiting.
    backdrop().dispatchEvent(tapClick());
    assert.equal(ui.isQuestionsPanelOpen(), false);
  } finally {
    twin.hidden = true;
    phone = false;
  }
});

test('a compaction moves an ask: it leaves this list; a paired relay\'s mirror is never listed', async () => {
  await show('conv-heron', [ask('q1'), ask('q3')]);
  ui.noteQuestionAskUpdated(ask('q1', { conversationId: 'conv-heron-2', session: { id: 'conv-heron-2' } }));
  assert.equal(button().dataset.count, '1');
  ui.noteQuestionAskUpdated(ask('m1', { relayId: 'r-field' }));
  assert.equal(button().dataset.count, '1');
  // A new ask of this conversation joins.
  ui.noteQuestionAskUpdated(ask('q4', { urgency: 'now' }));
  assert.equal(button().dataset.count, '2');
  assert.equal(count().textContent, '1');
});

test('a reconnect loads the list again: what changed while away shows', async () => {
  await show('conv-heron', [ask('q1')]);
  assert.equal(button().dataset.count, '1');
  served.set('conv-heron', [ask('q1'), ask('q5'), ask('q6', { urgency: 'now' })]);
  const before = requests.length;
  await ui.refreshQuestions();
  assert.ok(requests.slice(before).includes('/api/relay-asks?conversationId=conv-heron'));
  assert.equal(button().dataset.count, '3');
  assert.equal(count().classList.contains('is-urgent'), true);
});

test('the socket\'s connect handler reloads 📓 next to the Inbox, and every ask update reaches it', async () => {
  const source = await readFile(fileURLToPath(new URL('./socket-handlers.js', import.meta.url)), 'utf8');
  assert.match(source, /void refreshInbox\(\);\s*\n\s*void refreshQuestions\(\);/);
  assert.match(source, /socket\.on\(RELAY_ASK_SOCKET_EVENT, \(payload\) => \{\s*\n\s*noteRelayAskUpdated\(payload\);\s*\n\s*noteQuestionAskUpdated\(payload\?\.ask\);/);
});

test('the Inbox\'s "open": the conversation opens with 📓 open at that ask', async () => {
  ui.setQuestionsConversation(null);
  assert.equal(button().hidden, true);
  served.set('conv-plover', [ask('p1', { conversationId: 'conv-plover' }), ask('p2', { conversationId: 'conv-plover' })]);
  ui.requestQuestionsPanelAt('conv-plover', 'p2');
  ui.setQuestionsConversation('conv-plover');
  // Not before its list is in.
  assert.equal(ui.isQuestionsPanelOpen(), false);
  await wait();
  assert.equal(ui.isQuestionsPanelOpen(), true);
  assert.equal(panel().querySelector('.questions-card-focus')?.dataset.itemId, 'p2');
  // Another conversation on screen closes it.
  ui.setQuestionsConversation('conv-heron');
  assert.equal(ui.isQuestionsPanelOpen(), false);
});

test('back closes it (an overlay the history watches)', async () => {
  const source = await readFile(fileURLToPath(new URL('./session-history-ui.js', import.meta.url)), 'utf8');
  assert.match(source, /name: 'questions-panel', find: byId\('questions-panel'\), isOpen: isShown, close: closers\.closeQuestionsPanel/);
});

// ─── The stub in the asking turn's bubble ─────────────────────────────────────

const messages = () => document.getElementById('messages');
function reply(queueId, text = 'Reply text') {
  const row = document.createElement('div');
  row.className = 'msg assistant';
  row.dataset.sourceMessageId = queueId;
  row.innerHTML = `<div class="msg-bubble"><p>${text}</p><div class="msg-bubble-actions"></div></div>`;
  return row;
}
const stubsOf = (askId) => [...messages().querySelectorAll(`.msg-ask-stub[data-ask-id="${askId}"]`)];

test('stubs: in the asking turn\'s reply, oldest first, before its action row; standalone only when pending; none when cancelled', async () => {
  messages().replaceChildren(reply('q-turn-1'));
  const waiting = document.createElement('div');
  waiting.className = 'msg relay-question-container';
  messages().append(waiting);
  await show('conv-heron', [
    ask('s2', { queueId: 'q-turn-1', createdAt: minutesAgo(4) }),
    ask('s1', { queueId: 'q-turn-1', urgency: 'now', createdAt: minutesAgo(6) }),
    ask('s3', { queueId: 'q-turn-1', status: 'answered', choice: 'Option B', answer: 'Option B', answeredAt: minutesAgo(1), createdAt: minutesAgo(2) }),
    ask('s4', { queueId: null, createdAt: minutesAgo(3) }),
    ask('s5', { queueId: null, status: 'answered', choice: 'Option A', answeredAt: minutesAgo(1) }),
    ask('s6', { queueId: 'q-turn-1', status: 'cancelled', updatedAt: minutesAgo(1) }),
  ]);
  ui.renderQuestionStubs();
  const bubble = messages().querySelector('.msg.assistant > .msg-bubble');
  const row = bubble.querySelector(':scope > .msg-ask-stubs');
  assert.ok(row, 'a stub row in the bubble');
  assert.equal(row.nextElementSibling?.className, 'msg-bubble-actions');
  assert.deepEqual([...row.children].map((node) => node.dataset.askId), ['s1', 's2', 's3']);
  assert.equal(row.children[0].textContent, '📓 Question for you · urgent');
  assert.equal(row.children[0].classList.contains('is-urgent'), true);
  assert.equal(row.children[0].querySelector('.msg-ask-stub-urgent').textContent, 'urgent');
  assert.equal(row.children[2].textContent, '📓 Answered: Option B');
  assert.equal(row.children[2].classList.contains('is-closed'), true);
  const standalone = messages().querySelector(':scope > .relay-ask-stub-container');
  assert.ok(standalone, 'the standalone line');
  assert.equal(standalone.nextElementSibling, waiting, 'before the cards a turn waits on');
  assert.deepEqual([...standalone.querySelectorAll('.msg-ask-stub')].map((node) => node.dataset.askId), ['s4']);
  assert.equal(stubsOf('s5').length, 0, 'a closed ask without its turn: no stub');
  assert.equal(stubsOf('s6').length, 0, 'a cancelled ask: no stub');
  assert.equal(messages().querySelector('.relay-ask-container'), null, 'no inline cards');
  // Idempotent: drawn again, the same nodes.
  const first = stubsOf('s1')[0];
  ui.renderQuestionStubs();
  assert.equal(stubsOf('s1')[0], first);
});

test('a stub moves, never doubles: standalone → its bubble once loaded, live bubble → reply', async () => {
  messages().replaceChildren();
  const live = document.createElement('div');
  live.id = 'thinking-indicator';
  live.dataset.messageId = 'q-live';
  live.innerHTML = '<div class="thinking-bubble"><div class="thinking-text">working</div><div class="dots"></div></div>';
  messages().append(live);
  await show('conv-heron', [ask('m1', { queueId: 'q-older' }), ask('m2', { queueId: 'q-live' })]);
  ui.renderQuestionStubs();
  assert.equal(stubsOf('m1')[0].closest('.relay-ask-stub-container') !== null, true, 'its turn not loaded: standalone');
  const liveStub = stubsOf('m2')[0];
  assert.ok(liveStub.closest('#thinking-indicator'), 'in the live bubble');
  assert.equal(liveStub.parentElement.nextElementSibling?.className, 'dots', 'before the dots');
  // An older page comes in with m1's turn; the live turn ends in a reply.
  messages().prepend(reply('q-older', 'Older reply'));
  live.remove();
  messages().append(reply('q-live', 'Final reply'));
  ui.renderQuestionStubs();
  for (const id of ['m1', 'm2']) assert.equal(stubsOf(id).length, 1, `${id}: one stub`);
  assert.ok(stubsOf('m1')[0].closest('.msg.assistant[data-source-message-id="q-older"]'));
  assert.ok(stubsOf('m2')[0].closest('.msg.assistant[data-source-message-id="q-live"]'));
  assert.equal(messages().querySelector('.relay-ask-stub-container'), null, 'the empty standalone line goes');
  // Moved to another conversation (a compaction): its stub leaves this one.
  ui.noteQuestionAskUpdated(ask('m1', { queueId: 'q-older', conversationId: 'conv-heron-2', session: { id: 'conv-heron-2' } }));
  assert.equal(stubsOf('m1').length, 0);
  // Another view on screen: no stubs.
  document.body.classList.add('inbox-view-active');
  ui.renderQuestionStubs();
  assert.equal(stubsOf('m2').length, 0);
  document.body.classList.remove('inbox-view-active');
  ui.renderQuestionStubs();
  assert.equal(stubsOf('m2').length, 1);
});

test('a tap on a stub opens 📓 at its ask', async () => {
  messages().replaceChildren(reply('q-turn-1'));
  await show('conv-heron', [ask('t1', { queueId: 'q-turn-1' }), ask('t2', { queueId: 'q-turn-1' })]);
  ui.renderQuestionStubs();
  stubsOf('t2')[0].click();
  assert.equal(ui.isQuestionsPanelOpen(), true);
  assert.equal(panel().querySelector('.questions-card-focus')?.dataset.itemId, 't2');
  ui.closeQuestionsPanel();
});

// ─── Fixes: first-load race, position, scroll once, stale open requests ───────

test('an update before the first list lands, and an older list copy does not undo a newer one', async () => {
  store.setCurrentConv('conv-egret');
  let release;
  hold = { promise: new Promise((resolve) => { release = resolve; }), list: [
    ask('e1', { conversationId: 'conv-egret', updatedAt: minutesAgo(5) }),
    ask('e2', { conversationId: 'conv-egret', updatedAt: minutesAgo(5) }),
  ] };
  ui.setQuestionsConversation('conv-egret');
  await wait();
  // While the list is on its way: a new ask, and e1 answered.
  ui.noteQuestionAskUpdated(ask('e3', { conversationId: 'conv-egret', updatedAt: minutesAgo(0) }));
  ui.noteQuestionAskUpdated(ask('e1', { conversationId: 'conv-egret', status: 'answered', choice: 'Option A', answeredAt: minutesAgo(0), updatedAt: minutesAgo(0) }));
  assert.equal(button().dataset.count, '1', 'counted before the list is in');
  release();
  await wait(10);
  const { pending, answered } = ui.currentQuestions();
  assert.deepEqual(pending.map((entry) => entry.id).sort(), ['e2', 'e3']);
  assert.deepEqual(answered.map((entry) => entry.id), ['e1']);
  // A reconnect's list from before an update: the update stands.
  hold = { promise: Promise.resolve(), list: [ask('e2', { conversationId: 'conv-egret', updatedAt: minutesAgo(5) })] };
  const reload = ui.refreshQuestions();
  ui.noteQuestionAskUpdated(ask('e2', { conversationId: 'conv-egret', status: 'dismissed', answeredAt: minutesAgo(0), updatedAt: minutesAgo(0) }));
  await reload;
  assert.equal(ui.currentQuestions().pending.length, 0);
  assert.deepEqual(ui.currentQuestions().answered.map((entry) => entry.id).sort(), ['e2']);
});

test('the last pending ask answered: the list stays where it hung, and Escape focuses ︙', async () => {
  const menuButton = document.getElementById('chat-actions-menu-btn');
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  button().getBoundingClientRect = () => (button().hidden ? rect(0, 0, 0, 0) : rect(900, 10, 40, 28));
  menuButton.getBoundingClientRect = () => rect(1200, 10, 28, 28);
  try {
    messages().replaceChildren();
    await show('conv-heron', [ask('j1')]);
    ui.openQuestionsPanel({ anchor: button() });
    const left = panel().style.left;
    const top = panel().style.top;
    ui.noteQuestionAskUpdated(ask('j1', { status: 'answered', choice: 'Option A', answeredAt: minutesAgo(0), updatedAt: minutesAgo(0) }));
    assert.equal(button().hidden, true, '📓 hides: nothing pending');
    assert.equal(ui.isQuestionsPanelOpen(), true);
    assert.equal(panel().style.left, left, 'not thrown over to ︙');
    assert.equal(panel().style.top, top);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(document.activeElement, menuButton);
  } finally {
    delete button().getBoundingClientRect;
    delete menuButton.getBoundingClientRect;
  }
});

test('opened from ︙, the list follows ︙ when the header re-fits', async () => {
  const menuButton = document.getElementById('chat-actions-menu-btn');
  const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });
  let menuLeft = 1200;
  menuButton.getBoundingClientRect = () => rect(menuLeft, 10, 28, 28);
  const panelWidth = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.id === 'questions-panel' ? 400 : 0; } });
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 2000 });
  try {
    await show('conv-heron', [ask('h1')]);
    ui.openQuestionsPanel({ anchor: menuButton });
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 5))));
    await frames();
    const before = parseFloat(panel().style.left);
    // An icon appears left of ︙ and pushes it 45 px to the right.
    menuLeft = 1245;
    window.dispatchEvent(new window.CustomEvent('oar:header-actions-change'));
    await frames();
    assert.equal(parseFloat(panel().style.left) - before, 45, 'right edges stay lined up');
    ui.closeQuestionsPanel({ focus: false });
  } finally {
    delete menuButton.getBoundingClientRect;
    if (panelWidth) Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', panelWidth);
    delete document.documentElement.clientWidth;
  }
});

test('opened at an ask, it scrolls there once; later redraws leave the scroll alone', async () => {
  let scrolls = 0;
  const original = window.Element.prototype.scrollIntoView;
  window.Element.prototype.scrollIntoView = function scrollIntoView() { scrolls += 1; };
  try {
    await show('conv-heron', [ask('f1'), ask('f2')]);
    ui.openQuestionsPanel({ askId: 'f1' });
    assert.equal(scrolls, 1);
    ui.noteQuestionAskUpdated(ask('f2', { status: 'dismissed', answeredAt: minutesAgo(0), updatedAt: minutesAgo(0) }));
    assert.equal(scrolls, 1);
    assert.equal(panel().querySelector('.questions-card-focus')?.dataset.itemId, 'f1', 'still marked');
    ui.closeQuestionsPanel();
  } finally {
    window.Element.prototype.scrollIntoView = original;
  }
});

test('an open request for a conversation that did not open is dropped', async () => {
  served.set('conv-gannet', [ask('g1', { conversationId: 'conv-gannet' })]);
  // Landed elsewhere.
  ui.requestQuestionsPanelAt('conv-gannet', 'g1');
  ui.setQuestionsConversation('conv-heron');
  store.setCurrentConv('conv-gannet');
  ui.setQuestionsConversation('conv-gannet');
  await wait(10);
  assert.equal(ui.isQuestionsPanelOpen(), false);
  // The open failed (nothing switched): settled, it never fires later.
  await show('conv-heron', [ask('q1')]);
  ui.requestQuestionsPanelAt('conv-gannet', 'g1');
  ui.settleQuestionsPanelRequest();
  store.setCurrentConv('conv-gannet');
  ui.setQuestionsConversation('conv-gannet');
  await wait(10);
  assert.equal(ui.isQuestionsPanelOpen(), false);
});
