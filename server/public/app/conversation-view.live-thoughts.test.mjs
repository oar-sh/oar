import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The live bubble's thoughts on a REAL DOM: the app's index.html in JSDOM
// (scripts not executed), conversation-view.js imported on top, and the rows
// made by the real showThinking / appendThinkingThought. Whether a row starts
// open follows the "Expand thoughts" setting unless the reader folded or
// opened that thought by hand; the hand choice belongs to that thought of
// that turn only.

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
const view = await import('./conversation-view.js');
const { THOUGHTS_EXPANDED_STORAGE_KEY } = await import('./thoughts-preference.mjs');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const convId = 'conv-live-thoughts';
store.conversations[convId] = { id: convId, title: 'Widget cache plan', runtimeProviderType: 'claude' };
store.setCurrentConv(convId);

// A reasoning id the way a provider numbers it: positional within a turn, so
// the first thought of the next turn has the same id.
const FIRST_THOUGHT = 'claude-thought-main-0-0';

function startTurn(messageId) {
  view.removeThinking();
  view.showThinking(messageId, false);
  assert.ok(document.getElementById('thinking-thoughts'), 'the live bubble is up');
}

function thought(messageId, reasoningId, text, { done = false, subagentRunId = null } = {}) {
  view.appendThinkingThought(reasoningId, text, done, subagentRunId, false, messageId);
}

function liveRow(reasoningId) {
  return document.querySelector(`#thinking-thoughts .thinking-thought[data-reasoning-id="${reasoningId}"]`);
}

function subagentRow(runId, reasoningId) {
  return document.querySelector(`.subagent-bubble[data-subagent-run-id="${runId}"] .thinking-thought[data-reasoning-id="${reasoningId}"]`);
}

// The reader clicks the summary: the browser flips `open` and fires toggle.
async function foldByHand(row) {
  row.open = !row.open;
  row.dispatchEvent(new window.Event('toggle'));
  await settle();
}

test('setting on (the default): a live thought starts open; a hand fold sticks across chunks and a rebuild', async () => {
  localStorage.removeItem(THOUGHTS_EXPANDED_STORAGE_KEY);
  startTurn('turn-on-1');
  thought('turn-on-1', 'fixture-on', 'The widget cache needs a size cap');
  await settle();
  const row = liveRow('fixture-on');
  assert.equal(row.open, true);
  // The summary stays as the fold header of an open row.
  assert.ok(row.querySelector('summary')?.textContent.includes('The widget cache needs a size cap'));

  await foldByHand(row);
  thought('turn-on-1', 'fixture-on', 'The widget cache needs a size cap first.');
  thought('turn-on-1', 'fixture-on', 'The widget cache needs a size cap first.', { done: true });
  assert.equal(liveRow('fixture-on'), row, 'the same row grew');
  assert.equal(row.open, false);
  assert.equal(row.dataset.done, '1');

  // The bubble is rebuilt (a conversation switch, a poll replay): the fold
  // comes back with the row.
  startTurn('turn-on-1');
  thought('turn-on-1', 'fixture-on', 'The widget cache needs a size cap first.', { done: true });
  assert.notEqual(liveRow('fixture-on'), row);
  assert.equal(liveRow('fixture-on').open, false);
  // Another thought still follows the setting.
  thought('turn-on-1', 'fixture-on-other', 'Then the hit counter');
  assert.equal(liveRow('fixture-on-other').open, true);
});

test('setting off: a live thought starts folded; one opened by hand stays open', async () => {
  localStorage.setItem(THOUGHTS_EXPANDED_STORAGE_KEY, '0');
  startTurn('turn-off-1');
  thought('turn-off-1', 'fixture-off', 'Measuring the pool');
  thought('turn-off-1', 'fixture-off-done', 'The pool holds sixteen widgets.', { done: true });
  await settle();
  assert.equal(liveRow('fixture-off').open, false);
  assert.equal(liveRow('fixture-off-done').open, false);

  await foldByHand(liveRow('fixture-off'));
  thought('turn-off-1', 'fixture-off', 'Measuring the pool: twelve are busy at peak.');
  assert.equal(liveRow('fixture-off').open, true);
  assert.equal(liveRow('fixture-off-done').open, false);
  localStorage.removeItem(THOUGHTS_EXPANDED_STORAGE_KEY);
});

test('a hand fold belongs to its turn: the same reasoning id in the next turn follows the setting', async () => {
  localStorage.removeItem(THOUGHTS_EXPANDED_STORAGE_KEY);
  startTurn('turn-a');
  thought('turn-a', FIRST_THOUGHT, 'Reading the eviction code');
  await settle();
  await foldByHand(liveRow(FIRST_THOUGHT));
  assert.equal(liveRow(FIRST_THOUGHT).open, false);

  startTurn('turn-b');
  thought('turn-b', FIRST_THOUGHT, 'Reading the widget registry');
  await settle();
  assert.equal(liveRow(FIRST_THOUGHT).open, true, 'turn B\'s first thought starts open');

  // And turn A, shown again, still has its fold.
  startTurn('turn-a');
  thought('turn-a', FIRST_THOUGHT, 'Reading the eviction code');
  assert.equal(liveRow(FIRST_THOUGHT).open, false);
});

test('the page folding the rows at turn end is not the reader\'s choice', async () => {
  localStorage.removeItem(THOUGHTS_EXPANDED_STORAGE_KEY);
  startTurn('turn-end-1');
  thought('turn-end-1', 'fixture-end', 'Wrapping up the widget plan', { done: true });
  await settle();
  view.collapseThinkingThoughts();
  await settle();
  assert.equal(liveRow('fixture-end').open, false);

  startTurn('turn-end-1');
  thought('turn-end-1', 'fixture-end', 'Wrapping up the widget plan', { done: true });
  assert.equal(liveRow('fixture-end').open, true);
});

test('a sub-agent thought keeps its own fold, apart from a main one with the same id', async () => {
  localStorage.removeItem(THOUGHTS_EXPANDED_STORAGE_KEY);
  const runId = 'toolu_fixture_explore';
  startTurn('turn-sub-1');
  store.upsertSubagentRun({ subagentRunId: runId, messageId: 'turn-sub-1', conversationId: convId, displayName: 'Explore the widget store', status: 'running' });
  thought('turn-sub-1', 'fixture-shared', 'Listing the widget files', { subagentRunId: runId });
  thought('turn-sub-1', 'fixture-shared', 'Planning the widget cache');
  await settle();
  const sub = subagentRow(runId, 'fixture-shared');
  assert.ok(sub, 'the sub-agent row is in its bubble');
  assert.equal(sub.open, true);
  await foldByHand(sub);

  thought('turn-sub-1', 'fixture-shared', 'Listing the widget files: two found', { subagentRunId: runId });
  assert.equal(subagentRow(runId, 'fixture-shared').open, false);
  assert.equal(liveRow('fixture-shared').open, true, 'the main thought is not folded');

  // Rebuilt from the store (no turn id on a restored sub-agent row), the fold
  // is still there.
  const restored = view.createLiveThoughtRow('fixture-shared', runId);
  assert.equal(restored.open, false);
});
