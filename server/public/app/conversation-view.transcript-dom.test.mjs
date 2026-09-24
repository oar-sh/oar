import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// Transcript behaviour on a REAL DOM: the app's own index.html loaded into
// JSDOM (scripts not executed), with conversation-view.js imported on top.
// The modules bind listeners to fixed element ids at import time, which the
// real page provides; innerHTML, sibling traversal, getElementById and click
// bubbling are all genuine, so these tests assert what the user would see —
// row order, classes, the live bubble's position — not the source text.

// The app's periodic timers (sidebar spinner, polls) must not keep the test
// process alive once the suite is done.
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

// fetch: tests install a handler; every request is logged.
const fetchLog = [];
let fetchHandler = async (url) => { throw new Error(`unexpected fetch: ${url}`); };
globalThis.fetch = async (url, opts = {}) => {
  const entry = { url: String(url), method: String(opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null };
  fetchLog.push(entry);
  const payload = await fetchHandler(entry.url, entry);
  return { ok: true, status: 200, json: async () => payload };
};

const store = await import('./store.js');
const view = await import('./conversation-view.js');
const { chatSelectionGuard } = await import('./selection-guard.mjs');
const { conversations, setCurrentConv } = store;

const messagesEl = document.getElementById('messages');
view.initBubbleActionHandlers();

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `${prefix}-${seq}`;
}

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();

function openConversation(provider = 'claude') {
  const id = uid('conv');
  conversations[id] = { id, title: 'Transcript', runtimeProviderType: provider };
  setCurrentConv(id);
  return id;
}

function selectComposerPreferences() {
  const setOptions = (id, value) => {
    const select = document.getElementById(id);
    select.innerHTML = `<option value="${value}">${value}</option>`;
    select.value = value;
  };
  setOptions('model-select', 'claude-sonnet-5');
  setOptions('reasoning-effort-select', 'medium');
  setOptions('context-tier-select', 'default');
  setOptions('mode-select', 'agent');
}

function validationPayload(sessionId) {
  return { sdkSessionId: sessionId, runtimeSession: { sdkSessionId: sessionId, id: 'rt-dom' }, title: 'Transcript' };
}

const rows = () => [...messagesEl.querySelectorAll(':scope > .msg')];
const rowIds = () => rows().map((node) => node.id === 'thinking-indicator' ? 'live' : node.dataset.messageId);
const row = (id) => rows().find((node) => node.id !== 'thinking-indicator' && node.dataset.messageId === id) || null;
const liveBubble = () => document.getElementById('thinking-indicator');

function resetView() {
  view.removeThinking();
  messagesEl.innerHTML = '';
  fetchLog.length = 0;
}

// Validation and the draft save answer at once; the send itself waits on the
// returned deferred, so a test can act while it is in flight.
function pendingSendHarness(conv) {
  const post = deferred();
  fetchHandler = async (url, { method }) => {
    if (method === 'GET' && url.includes(`/api/conversation/${conv}?`)) return validationPayload('sess-dom');
    if (method === 'POST' && url.endsWith('/api/message')) return post.promise;
    if (url.includes(`/api/conversation/${conv}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: at(100) };
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  return post;
}

// ---------------------------------------------------------------------------
// 3a — settle markers on reload. Assistant rows are timestamped when they are
// answered, so a steer's settle stub and a handed-off reply arrive AFTER the
// later user message; the transcript must still anchor each under its prompt.
// ---------------------------------------------------------------------------

test('reload: a folded steer renders as a marker under its own message, and the next message is a normal turn', () => {
  resetView();
  const conv = openConversation();
  view.renderMessages([
    { id: 'u1', role: 'user', text: 'first', timestamp: at(0) },
    { id: 'u2', role: 'user', text: 'steered in', timestamp: at(5) },
    { id: 'a1', role: 'assistant', text: 'the one answer', timestamp: at(30), sourceMessageId: 'u1' },
    { id: 'a2', role: 'assistant', text: '_(Handled together with the previous reply — this message was steered into that turn.)_', timestamp: at(31), sourceMessageId: 'u2', kind: 'folded' },
    { id: 'u3', role: 'user', text: 'a new question', timestamp: at(60) },
    { id: 'a3', role: 'assistant', text: 'a new answer', timestamp: at(70), sourceMessageId: 'u3' },
  ], false, { conversationId: conv });

  assert.deepEqual(rowIds(), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  assert.ok(row('a2').classList.contains('msg-folded'));
  assert.ok(!row('a2').classList.contains('msg-absorbed'), 'a fold is not a handoff');
  assert.ok(row('u2').classList.contains('msg-steered'), 'the folded message reads as steered');
  assert.ok(!row('u3').classList.contains('msg-steered'), 'the next ordinary message is not steered');
  assert.ok(!row('a3').classList.contains('msg-steered-continuation'), 'and its reply is not merged into a finished turn');
});

test('reload: a handed-off reply sorts above the steered message and merges into one flow', () => {
  resetView();
  const conv = openConversation();
  view.renderMessages([
    { id: 'u1', role: 'user', text: 'first', timestamp: at(0) },
    { id: 'u2', role: 'user', text: 'actually, also this', timestamp: at(5) },
    // Saved when the handoff happened — after u2 was sent.
    { id: 'a1', role: 'assistant', text: 'starting on the first', timestamp: at(8), sourceMessageId: 'u1', kind: 'absorbed' },
    { id: 'a2', role: 'assistant', text: 'did both', timestamp: at(40), sourceMessageId: 'u2' },
    { id: 'u3', role: 'user', text: 'thanks', timestamp: at(60) },
  ], false, { conversationId: conv });

  assert.deepEqual(rowIds(), ['u1', 'a1', 'u2', 'a2', 'u3']);
  assert.ok(row('a1').classList.contains('msg-absorbed'));
  assert.ok(row('u2').classList.contains('msg-steered'));
  assert.ok(row('a2').classList.contains('msg-steered-continuation'));
  assert.ok(!row('u3').classList.contains('msg-steered'));
});

test('reload: a steer cut off by Stop renders a marker with Resend, never merging forward', () => {
  resetView();
  const conv = openConversation();
  view.renderMessages([
    { id: 'u1', role: 'user', text: 'first', timestamp: at(0) },
    { id: 'u2', role: 'user', text: 'steered then stopped', timestamp: at(5) },
    { id: 'a1', role: 'assistant', text: 'partial', timestamp: at(9), sourceMessageId: 'u1' },
    { id: 'a2', role: 'assistant', text: '_(Stopped with the turn — not answered.)_', timestamp: at(10), sourceMessageId: 'u2', kind: 'stopped' },
    { id: 'u3', role: 'user', text: 'next', timestamp: at(60) },
  ], false, { conversationId: conv });

  assert.deepEqual(rowIds(), ['u1', 'a1', 'u2', 'a2', 'u3']);
  assert.ok(row('a2').classList.contains('msg-steer-stopped'));
  assert.match(row('a2').textContent, /Stopped with the turn — not answered/);
  const resend = row('a2').querySelector('[data-action="resend-stopped-steer"]');
  assert.ok(resend, 'the marker offers Resend');
  assert.equal(resend.textContent, 'Resend');
  assert.ok(!row('u3').classList.contains('msg-steered'));
  assert.equal(messagesEl.querySelectorAll('[data-action="resend-stopped-steer"]').length, 1, 'only the stopped marker offers it');
});

test('Resend re-sends the original text and attachment references once, however fast it is tapped', async () => {
  resetView();
  const conv = openConversation();
  store.setCliOnline(false);
  selectComposerPreferences();
  const sha = 'a'.repeat(64);
  view.renderMessages([
    { id: 'u1', role: 'user', text: 'first', timestamp: at(0) },
    {
      id: 'u2',
      role: 'user',
      text: 'look at this screenshot',
      timestamp: at(5),
      attachments: [{ sha256: sha, name: 'screen.png', type: 'image/png', size: 1200, url: `/api/uploads/${sha}` }],
    },
    { id: 'a2', role: 'assistant', text: '_(Stopped with the turn — not answered.)_', timestamp: at(10), sourceMessageId: 'u2', kind: 'stopped' },
  ], false, { conversationId: conv });

  const post = deferred();
  fetchHandler = async (url, { method }) => {
    if (method === 'GET' && url.includes(`/api/conversation/${conv}?`)) return validationPayload('sess-dom');
    if (method === 'POST' && url.endsWith('/api/message')) return post.promise;
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
  const button = () => row('a2').querySelector('[data-action="resend-stopped-steer"]');
  button().click();
  button().click();
  await settle();
  button().click();
  await settle();
  assert.equal(button().disabled, true, 'disabled while the resend is in flight');

  const posts = fetchLog.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/api/message'));
  assert.equal(posts.length, 1, 'three taps, one message');
  assert.equal(posts[0].body.text, 'look at this screenshot');
  assert.equal(posts[0].body.conversationId, conv);
  assert.equal(posts[0].body.resendOfMessageId, 'u2');
  assert.deepEqual(posts[0].body.attachments, [{ sha256: sha, name: 'screen.png', type: 'image/png' }]);

  // The resent message shows as a normal pending bubble while it sends.
  const pending = row(posts[0].body.messageId);
  assert.ok(pending?.classList.contains('user'));
  assert.ok(pending.querySelector('[data-action="cancel-queued"]'), 'with Cancel, like any queued message');

  post.resolve({ conversationId: conv, messageId: posts[0].body.messageId });
  await settle();
  await settle();
  assert.equal(button().textContent, 'Resent');
  assert.equal(button().disabled, true);
  button().click();
  await settle();
  assert.equal(fetchLog.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/api/message')).length, 1);
});

test('a failed Resend removes its bubble and can be tried again', async () => {
  resetView();
  const conv = openConversation();
  selectComposerPreferences();
  // Message ids are unique per page life; the Resend state is keyed by them.
  const userId = uid('u');
  const markerId = uid('a');
  view.renderMessages([
    { id: userId, role: 'user', text: 'try me again', timestamp: at(5) },
    { id: markerId, role: 'assistant', text: '_(Stopped with the turn — not answered.)_', timestamp: at(10), sourceMessageId: userId, kind: 'stopped' },
  ], false, { conversationId: conv });
  fetchHandler = async (url, { method }) => {
    if (method === 'GET') return validationPayload('sess-dom');
    throw new Error('network down');
  };
  row(markerId).querySelector('[data-action="resend-stopped-steer"]').click();
  await settle();
  await settle();
  assert.deepEqual(rowIds(), [userId, markerId], 'the optimistic bubble is gone');
  const button = row(markerId).querySelector('[data-action="resend-stopped-steer"]');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Resend');
});
