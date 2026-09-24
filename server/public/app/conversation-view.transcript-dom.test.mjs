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

// ---------------------------------------------------------------------------
// 3c — the live bubble across rebuilds. #messages is shared by every
// conversation; the bubble is kept only for its own and re-anchored under its
// owning message on every rebuild.
// ---------------------------------------------------------------------------

test('a rebuild keeps the live bubble as the same node, anchored under its message above later rows', () => {
  resetView();
  const conv = openConversation();
  const turn = [
    { id: 'u1', role: 'user', text: 'long task', timestamp: at(0) },
  ];
  view.renderMessages(turn, false, { conversationId: conv });
  view.showThinking('u1', false);
  const bubble = liveBubble();
  assert.deepEqual(rowIds(), ['u1', 'live']);

  // A steered message lands and the poll rebuilds the transcript.
  view.renderMessages([...turn, { id: 'u2', role: 'user', text: 'steer', timestamp: at(5) }], false, { conversationId: conv });
  assert.equal(liveBubble(), bubble, 'the in-progress bubble is kept, not rebuilt');
  assert.deepEqual(rowIds(), ['u1', 'live', 'u2'], 'anchored under its message, not left at the end');
});

test('the live bubble stays anchored when the in-flight snapshot is unchanged after a rebuild', () => {
  resetView();
  const conv = openConversation();
  const inFlight = { messageId: 'u1', status: 'processing', activities: [], thoughts: [] };
  const base = [{ id: 'u1', role: 'user', text: 'long task', timestamp: at(0) }];
  view.renderMessages(base, false, { conversationId: conv });
  view.restoreInFlightThinking(inFlight, false);
  const bubble = liveBubble();
  view.renderMessages([...base, { id: 'u2', role: 'user', text: 'steer', timestamp: at(5) }], false, { conversationId: conv });
  // The live poll's restore skips an identical snapshot — nothing else would
  // move the bubble back.
  view.restoreInFlightThinking(inFlight, false);
  assert.equal(liveBubble(), bubble, 'an identical snapshot is not rebuilt');
  assert.deepEqual(rowIds(), ['u1', 'live', 'u2']);
});

test('opening another conversation drops the previous conversation\'s live bubble', () => {
  resetView();
  const convA = openConversation();
  view.renderMessages([{ id: 'ua', role: 'user', text: 'running in A', timestamp: at(0) }], false, { conversationId: convA });
  view.showThinking('ua', false);
  assert.ok(liveBubble());

  const convB = openConversation();
  view.renderMessages([{ id: 'ub', role: 'user', text: 'quiet B', timestamp: at(0) }], false, { conversationId: convB });
  assert.equal(liveBubble(), null, 'A\'s bubble never leaks into B');
  assert.deepEqual(rowIds(), ['ub']);

  // A later restore for B builds B's own bubble from scratch.
  view.restoreInFlightThinking({ messageId: 'ub', status: 'processing' }, false);
  assert.equal(liveBubble()?.dataset.conversationId, convB);
  assert.deepEqual(rowIds(), ['ub', 'live']);
});

test('deleting the open conversation (render with no conversation) leaves no live bubble behind', () => {
  resetView();
  const conv = openConversation();
  view.renderMessages([{ id: 'u1', role: 'user', text: 'doomed', timestamp: at(0) }], false, { conversationId: conv });
  view.showThinking('u1', false);
  setCurrentConv(null);
  view.renderMessages([]);
  assert.equal(liveBubble(), null);
  assert.ok(messagesEl.querySelector('.empty-state'), 'the empty state is shown, not a stray bubble');
});

test('showThinking reuses the bubble for the same message and rebuilds it for another', () => {
  resetView();
  const conv = openConversation();
  view.renderMessages([
    { id: 'u1', role: 'user', text: 'one', timestamp: at(0) },
    { id: 'a1', role: 'assistant', text: 'done', timestamp: at(9), sourceMessageId: 'u1' },
    { id: 'u2', role: 'user', text: 'two', timestamp: at(10) },
  ], false, { conversationId: conv });
  view.showThinking('u1', false);
  const first = liveBubble();
  view.showThinking('u1', false);
  assert.equal(liveBubble(), first, 'same message: the same node');
  view.showThinking('u2', false);
  assert.notEqual(liveBubble(), first, 'another message: a new bubble');
  assert.equal(liveBubble().dataset.messageId, 'u2');
  assert.deepEqual(rowIds(), ['u1', 'a1', 'u2', 'live']);
  assert.equal(document.querySelectorAll('#thinking-indicator').length, 1);
});

test('restoreInFlightThinking skips an identical payload and repaints a changed one', () => {
  resetView();
  const conv = openConversation();
  view.renderMessages([{ id: 'u1', role: 'user', text: 'task', timestamp: at(0) }], false, { conversationId: conv });
  view.restoreInFlightThinking({ messageId: 'u1', status: 'processing', activities: ['Reading a file'] }, false);
  const bubble = liveBubble();
  const activityRow = bubble.querySelector('.thinking-activity-item');
  assert.match(activityRow.textContent, /Reading a file/);
  view.restoreInFlightThinking({ messageId: 'u1', status: 'processing', activities: ['Reading a file'] }, false);
  assert.equal(bubble.querySelector('.thinking-activity-item'), activityRow, 'identical payload: no repaint');
  view.restoreInFlightThinking({ messageId: 'u1', status: 'processing', activities: ['Reading a file', 'Running tests'] }, false);
  assert.equal(liveBubble(), bubble);
  assert.equal(bubble.querySelectorAll('.thinking-activity-item').length, 2);
  view.restoreInFlightThinking(null, false);
  assert.equal(liveBubble(), null, 'a finished turn drops the bubble');
});

// ---------------------------------------------------------------------------
// 3d — optimistic pending bubbles across rebuilds.
// ---------------------------------------------------------------------------

test('a stale rebuild keeps a just-sent text bubble as the same node, with its Cancel', async () => {
  resetView();
  const conv = openConversation('github');
  selectComposerPreferences();
  const history = [{ id: 'u1', role: 'user', text: 'earlier', timestamp: at(0) }];
  view.renderMessages(history, false, { conversationId: conv });
  document.getElementById('msg-input').value = 'just sent';
  const post = pendingSendHarness(conv);
  const sending = view.sendMessage();
  await settle();
  await settle();
  const sentId = fetchLog.find((entry) => entry.method === 'POST')?.body.messageId;
  const bubble = row(sentId);
  assert.ok(bubble, 'the optimistic bubble is up');

  // A poll whose response predates the send rebuilds without it.
  view.renderMessages([...history, { id: 'a1', role: 'assistant', text: 'old reply', timestamp: at(9), sourceMessageId: 'u1' }], false, { conversationId: conv });
  assert.equal(row(sentId), bubble, 'kept as the same node');
  assert.ok(bubble.querySelector('[data-action="cancel-queued"]'));
  assert.deepEqual(rowIds(), ['u1', 'a1', sentId], 'and still the newest row');

  // Once the payload carries it, the rebuild renders it once.
  post.resolve({ conversationId: conv, messageId: sentId });
  await sending;
  view.renderMessages([...history, { id: sentId, role: 'user', text: 'just sent', timestamp: at(20) }], false, { conversationId: conv });
  assert.equal(messagesEl.querySelectorAll(`:scope > .msg[data-message-id="${sentId}"]`).length, 1);
});

test('a stale rebuild keeps an attachment-only (screenshot) send too', async () => {
  resetView();
  const conv = openConversation('github');
  selectComposerPreferences();
  const history = [{ id: 'u1', role: 'user', text: 'earlier', timestamp: at(0) }];
  view.renderMessages(history, false, { conversationId: conv });
  document.getElementById('msg-input').value = '';
  const sha = 'b'.repeat(64);
  store.selectedAttachments.push({
    id: 'att-dom-1',
    name: 'screen.png',
    type: 'image/png',
    uploadState: 'uploaded',
    sha256: sha,
    uploaded: { sha256: sha, name: 'screen.png', type: 'image/png', size: 900 },
  });
  const post = pendingSendHarness(conv);
  const sending = view.sendMessage();
  await settle();
  await settle();
  const sentPost = fetchLog.find((entry) => entry.method === 'POST' && entry.url.endsWith('/api/message'));
  assert.equal(sentPost.body.text, '');
  assert.equal(sentPost.body.attachments[0].sha256, sha);
  const bubble = row(sentPost.body.messageId);
  assert.ok(bubble);

  // A poll whose response predates the send rebuilds without it.
  view.renderMessages([...history, { id: uid('a'), role: 'assistant', text: 'old reply', timestamp: at(9), sourceMessageId: 'u1' }], false, { conversationId: conv });
  assert.equal(row(sentPost.body.messageId), bubble, 'the screenshot bubble does not vanish');

  post.resolve({ conversationId: conv, messageId: sentPost.body.messageId });
  await sending;
});

test('a pending bubble is not appended to a window that has newer messages unloaded', () => {
  resetView();
  const conv = openConversation();
  const pendingId = uid('pending');
  store.trackPendingUserMessage(pendingId, conv, 'queued at the end');
  store.pendingUserMessageIds.add(pendingId);
  view.appendMessage({ role: 'user', text: 'queued at the end', timestamp: at(500) }, false, pendingId, true);
  // A search jump loads a window in the middle of the history.
  view.renderMessages([
    { id: 'm1', role: 'user', text: 'middle question', timestamp: at(100) },
    { id: 'm2', role: 'assistant', text: 'middle answer', timestamp: at(110), sourceMessageId: 'm1' },
  ], false, { conversationId: conv, hasMoreNewer: true });
  assert.deepEqual(rowIds(), ['m1', 'm2'], 'the newest message is not spliced below an old window');
  store.clearPendingUserMessage(pendingId);
});

test('another conversation\'s pending bubble is never carried into the one being rendered', () => {
  resetView();
  const convA = openConversation();
  const pendingId = uid('pending');
  store.trackPendingUserMessage(pendingId, convA, 'waiting in A');
  store.pendingUserMessageIds.add(pendingId);
  view.appendMessage({ role: 'user', text: 'waiting in A', timestamp: at(0) }, false, pendingId, true);
  const convB = openConversation();
  view.renderMessages([{ id: 'b1', role: 'user', text: 'B only', timestamp: at(0) }], false, { conversationId: convB });
  assert.deepEqual(rowIds(), ['b1']);
  store.clearPendingUserMessage(pendingId);
});

test('the empty state is not shown while a pending bubble is on screen', () => {
  resetView();
  const conv = openConversation();
  const pendingId = uid('pending');
  store.trackPendingUserMessage(pendingId, conv, 'first message ever');
  store.pendingUserMessageIds.add(pendingId);
  view.appendMessage({ role: 'user', text: 'first message ever', timestamp: at(0) }, false, pendingId, true);
  view.renderMessages([], false, { conversationId: conv });
  assert.equal(messagesEl.querySelector('.empty-state'), null);
  assert.deepEqual(rowIds(), [pendingId]);
  store.clearPendingUserMessage(pendingId);
});

// ---------------------------------------------------------------------------
// 3b — a message sent while steering is held (open question card) queues.
// ---------------------------------------------------------------------------

test('while a question card holds steering the button reads Queue, and sending it posts', async () => {
  resetView();
  const conv = openConversation('claude');
  selectComposerPreferences();
  view.renderMessages([{ id: 'u1', role: 'user', text: 'running', timestamp: at(0) }], false, { conversationId: conv });
  view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'processing' });
  store.relayQuestions.set('rq-dom', { id: 'rq-dom', conversationId: conv, status: 'pending', createdAt: at(1) });
  const input = document.getElementById('msg-input');
  input.value = 'after the card';
  view.syncComposerButtonState();
  const button = document.getElementById('send-btn');
  assert.equal(button.textContent, 'Queue');
  assert.equal(button.disabled, false);
  assert.match(button.title, /after you answer the question/i);

  const post = pendingSendHarness(conv);
  const sending = view.sendMessage();
  await settle();
  await settle();
  const sent = fetchLog.find((entry) => entry.method === 'POST' && entry.url.endsWith('/api/message'));
  assert.ok(sent, 'the held send is posted, not refused');
  assert.equal(sent.body.text, 'after the card');
  post.resolve({ conversationId: conv, messageId: sent.body.messageId });
  await sending;

  store.relayQuestions.delete('rq-dom');
  input.value = 'steer now';
  view.syncComposerButtonState();
  assert.equal(button.textContent, 'Steer', 'the hold ends: back to Steer');
  view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'done' });
  input.value = '';
});
