import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// A loaded conversation and the turn the socket reported running, on the real
// index.html in JSDOM (harness as in journal-view.switch-order.test.mjs). The
// record keeps whatever an earlier read said about the turn, such as the check
// before a send; only the payload being applied may end the page's turn.
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
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const store = await import('./store.js');
const journal = await import('./journal-view.js');
const backgroundTasks = await import('./background-tasks-view.mjs');

const ID = 'conv-tea';
const payload = (extra = {}) => ({
  id: ID,
  title: 'Sort the tea tins',
  messages: [{ id: 'q-tea', role: 'user', text: 'Label the green tea tin', timestamp: '2031-03-01T09:00:00.000Z' }],
  inFlight: null,
  ...extra,
});

// The check before the send copied the payload of that moment onto the record;
// then the socket reported the message taken by a worker.
function sentAndTaken() {
  store.conversations[ID] = {
    id: ID,
    title: 'Sort the tea tins',
    activeTurn: false,
    localTurnStatus: 'processing',
    localTurnStatusUpdatedAt: Date.now(),
    localTurnMessageId: 'q-tea',
  };
  store.setCurrentConv(ID);
}

test('a payload read while the message still waited keeps the turn the socket reported', () => {
  sentAndTaken();
  journal.applyLoadedConversationState(ID, payload({ activeTurn: true }));
  assert.equal(store.conversations[ID].localTurnStatus, 'processing');
});

test('a payload without a verdict, from an older relay, keeps it too', () => {
  sentAndTaken();
  journal.applyLoadedConversationState(ID, payload());
  assert.equal(store.conversations[ID].localTurnStatus, 'processing');
});

test('a payload that says no turn is left ends it', () => {
  sentAndTaken();
  journal.applyLoadedConversationState(ID, payload({ activeTurn: false }));
  assert.equal('localTurnStatus' in store.conversations[ID], false);
});

// The live poll asks while the agent works; the relay publishes a bigger
// task set before that answer is back, and the event lands first.
test('a reload asked for before a background_tasks event leaves the event\'s task set', () => {
  sentAndTaken();
  const task = (index) => ({ taskId: `tea-${index}`, taskType: 'local_agent', description: `Weigh tin ${index}`, startedAt: 1 });
  const ids = () => backgroundTasks.getConversationBackgroundTasks(ID).map((entry) => entry.taskId);
  backgroundTasks.setConversationBackgroundTasks(ID, [0, 1, 2].map(task), { event: true });
  const asked = backgroundTasks.backgroundTasksSnapshotMark(ID);
  // Another conversation's event says nothing about this one's set.
  backgroundTasks.setConversationBackgroundTasks('conv-other', [task(9)], { event: true });
  assert.equal(backgroundTasks.isBackgroundTasksSnapshotCurrent(ID, asked), true);
  backgroundTasks.setConversationBackgroundTasks(ID, [0, 1, 2, 3, 4].map(task), { event: true });
  journal.applyLoadedConversationState(ID, payload({ backgroundTasks: [0, 1, 2].map(task), endedBackgroundTasks: [] }), { backgroundTasksAsOf: asked });
  assert.deepEqual(ids(), ['tea-0', 'tea-1', 'tea-2', 'tea-3', 'tea-4']);
  // Asked after it: the answer is the newer word.
  journal.applyLoadedConversationState(ID, payload({ backgroundTasks: [task(0)] }), { backgroundTasksAsOf: backgroundTasks.backgroundTasksSnapshotMark(ID) });
  assert.deepEqual(ids(), ['tea-0']);
  // Without a mark (an open), as before.
  journal.applyLoadedConversationState(ID, payload({ backgroundTasks: [] }));
  assert.deepEqual(ids(), []);
});
