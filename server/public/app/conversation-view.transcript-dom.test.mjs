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

function renderStoppedPair(conv, { text = 'cut off by Stop', attachments = [], markerExtra = {} } = {}) {
  const userId = uid('u');
  const markerId = uid('a');
  view.renderMessages([
    { id: userId, role: 'user', text, timestamp: at(5), attachments },
    { id: markerId, role: 'assistant', text: '_(Stopped with the turn — not answered.)_', timestamp: at(10), sourceMessageId: userId, kind: 'stopped', ...markerExtra },
  ], false, { conversationId: conv });
  return { userId, markerId, button: () => row(markerId).querySelector('[data-action="resend-stopped-steer"]') };
}

function resendHarness(conv, postResponse) {
  fetchHandler = async (url, { method, body }) => {
    if (method === 'GET' && url.includes(`/api/conversation/${conv}?`)) return validationPayload('sess-dom');
    if (method === 'POST' && url.endsWith('/api/message')) return postResponse(body);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };
}

const toastText = () => document.getElementById('relay-toast')?.textContent || '';
const messagePosts = () => fetchLog.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/api/message'));

test('a marker whose own message is not loaded never resends the message above it', async () => {
  resetView();
  const conv = openConversation();
  selectComposerPreferences();
  const markerId = uid('a');
  // Page boundary: the marker's source is outside the window, and the row
  // above is ANOTHER stopped steer.
  view.renderMessages([
    { id: 'other-u', role: 'user', text: 'a different stopped steer', timestamp: at(1) },
    { id: 'other-a', role: 'assistant', text: '_(Stopped with the turn — not answered.)_', timestamp: at(2), sourceMessageId: 'other-u', kind: 'stopped' },
    { id: markerId, role: 'assistant', text: '_(Stopped with the turn — not answered.)_', timestamp: at(3), sourceMessageId: 'not-loaded-u', kind: 'stopped' },
  ], false, { conversationId: conv });
  resendHarness(conv, () => { throw new Error('must not post'); });
  row(markerId).querySelector('[data-action="resend-stopped-steer"]').click();
  await settle();
  assert.equal(messagePosts().length, 0);
  assert.match(toastText(), /scroll up/i);
  assert.equal(row(markerId).querySelector('[data-action="resend-stopped-steer"]').disabled, false);
});

test('a marker the relay reports as resent renders Resent, disabled, from the data', () => {
  resetView();
  const conv = openConversation();
  const { button } = renderStoppedPair(conv, { markerExtra: { resentAs: 'msg-resent-elsewhere' } });
  assert.equal(button().textContent, 'Resent');
  assert.equal(button().disabled, true);
});

test('an unrelated recent message with the same text does not lock Resend', async () => {
  resetView();
  const conv = openConversation();
  selectComposerPreferences();
  const { button } = renderStoppedPair(conv);
  resendHarness(conv, () => ({ ok: true, duplicate: true, duplicateOfMessageId: 'someone-typed-it', conversationId: conv }));
  button().click();
  await settle();
  await settle();
  assert.equal(button().disabled, false);
  assert.equal(button().textContent, 'Resend');
  assert.match(toastText(), /not resent/i);
});

test('a Resend the relay already has from another device settles as Resent', async () => {
  resetView();
  const conv = openConversation();
  selectComposerPreferences();
  const { button, userId, markerId } = renderStoppedPair(conv);
  resendHarness(conv, () => ({ ok: true, duplicate: true, alreadyResent: true, duplicateOfMessageId: 'msg-from-phone', conversationId: conv }));
  button().click();
  await settle();
  await settle();
  assert.equal(button().textContent, 'Resent');
  assert.deepEqual(rowIds(), [userId, markerId], 'no stray optimistic bubble');
});

test('a Resend that loses attachments says how many', async () => {
  resetView();
  const conv = openConversation();
  selectComposerPreferences();
  const sha = 'd'.repeat(64);
  const { button } = renderStoppedPair(conv, {
    attachments: [
      { sha256: sha, name: 'kept.png', type: 'image/png' },
      { name: 'inline.png', type: 'image/png', dataUrl: 'data:image/png;base64,AAAA' },
    ],
  });
  resendHarness(conv, (body) => ({ ok: true, conversationId: conv, messageId: body.messageId, droppedAttachmentCount: 0 }));
  button().click();
  await settle();
  await settle();
  assert.deepEqual(messagePosts()[0].body.attachments.map((item) => item.sha256), [sha]);
  assert.match(toastText(), /without 1 attachment/);
});

test('a cancelled or failed Resend gives the Resend button back', async () => {
  for (const status of ['cancelled', 'failed']) {
    resetView();
    const conv = openConversation();
    selectComposerPreferences();
    const { button } = renderStoppedPair(conv);
    resendHarness(conv, (body) => ({ ok: true, conversationId: conv, messageId: body.messageId }));
    button().click();
    await settle();
    await settle();
    assert.equal(button().textContent, 'Resent');
    const resentId = messagePosts()[0].body.messageId;
    view.applyConversationTurnStatus({ conversationId: conv, messageId: uid('unrelated'), status });
    assert.equal(button().textContent, 'Resent', `an unrelated ${status} status changes nothing`);
    view.applyConversationTurnStatus({ conversationId: conv, messageId: resentId, status });
    assert.equal(button().textContent, 'Resend', `${status}: available again`);
    assert.equal(button().disabled, false);
  }
});

test('a payload that carries the Resend but no resentAs overrides the page\'s Resent; a stale one does not', async () => {
  resetView();
  const conv = openConversation();
  selectComposerPreferences();
  const { button, userId, markerId } = renderStoppedPair(conv);
  resendHarness(conv, (body) => ({ ok: true, conversationId: conv, messageId: body.messageId }));
  button().click();
  await settle();
  await settle();
  const resentId = messagePosts()[0].body.messageId;
  const base = [
    { id: userId, role: 'user', text: 'cut off by Stop', timestamp: at(5) },
    { id: markerId, role: 'assistant', text: '_(Stopped with the turn — not answered.)_', timestamp: at(10), sourceMessageId: userId, kind: 'stopped' },
  ];
  // A poll that predates the Resend: the page's Resent stands.
  view.renderMessages([...base, { id: uid('a'), role: 'assistant', text: 'older reply', timestamp: at(1) }], false, { conversationId: conv });
  assert.equal(button().textContent, 'Resent');
  // A payload that has the Resend and still no resentAs: it was cancelled or
  // failed elsewhere — the data wins.
  view.renderMessages([...base, { id: resentId, role: 'user', text: 'cut off by Stop', timestamp: at(20) }], false, { conversationId: conv });
  assert.equal(button().textContent, 'Resend');
  assert.equal(button().disabled, false);
  store.clearPendingUserMessage(resentId);
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
  // A Claude conversation steers because its worker advertises it. The
  // session id is the one the send harness binds the conversation to.
  const conv = openConversation('claude');
  conversations[conv].sdkSessionId = 'sess-dom';
  setWorkerSteering('sess-dom', {
    turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: [],
  });
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

// ---------------------------------------------------------------------------
// Auto-scroll yields to an active selection or drag.
// ---------------------------------------------------------------------------

test('auto-scroll yields while the user selects or drags in the chat', () => {
  let scrollTop = 0;
  Object.defineProperty(messagesEl, 'scrollHeight', { configurable: true, get: () => 900 });
  Object.defineProperty(messagesEl, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = value; } });
  try {
    chatSelectionGuard.pointerDown('messages');
    store.scrollBottom();
    assert.equal(scrollTop, 0, 'held: no programmatic scroll');
    chatSelectionGuard.pointerUp();
    store.scrollBottom();
    assert.equal(scrollTop, 900);
  } finally {
    delete messagesEl.scrollHeight;
    delete messagesEl.scrollTop;
  }
});

// ---------------------------------------------------------------------------
// Socket events driving the live turn: the real handlers, registered on a
// fake socket.io client.
// ---------------------------------------------------------------------------

const socketHandlers = new Map();
globalThis.io = () => ({
  connected: true,
  on: (event, handler) => socketHandlers.set(event, handler),
  emit() {},
  connect() {},
});
const refreshCurrentViewCalls = [];
const { connectSocket } = await import('./socket-handlers.js');
await connectSocket({
  refreshCurrentView: async () => { refreshCurrentViewCalls.push(store.currentConvId); },
  refreshSessionWorkerStatus: async () => {},
  refreshModelCatalog: async () => {},
  updateModelCatalogState: () => {},
  applyConversationWorkspaceRootUpdate: () => {},
  applyConversationTitleUpdate: () => {},
  syncChatTitleControls: () => {},
  applyConversationPreferencesForConversation: () => {},
});
const fire = (event, payload) => socketHandlers.get(event)(payload);

function liveTurn(conv, messageId) {
  view.renderMessages([{ id: messageId, role: 'user', text: 'working on it', timestamp: at(0) }], false, { conversationId: conv });
  fire('message_status', { conversationId: conv, messageId, status: 'processing' });
  assert.ok(liveBubble(), 'precondition: the turn has a live bubble');
}

test('only terminal statuses tear down the live bubble and refresh the view', () => {
  resetView();
  const conv = openConversation();
  const messageId = uid('u');
  liveTurn(conv, messageId);
  refreshCurrentViewCalls.length = 0;
  for (const status of ['pending', 'parked']) {
    fire('message_status', { conversationId: conv, messageId, status });
    assert.ok(liveBubble(), `'${status}' fires mid-turn and keeps the bubble`);
  }
  assert.equal(refreshCurrentViewCalls.length, 0);
  fire('message_status', { conversationId: conv, messageId, status: 'done' });
  assert.equal(liveBubble(), null);
  assert.equal(refreshCurrentViewCalls.length, 1, 'the end of the turn reloads the view');
});

test('live stream frames survive the enqueue-time pending ack and stop after completion', () => {
  resetView();
  const conv = openConversation();
  const messageId = uid('u');
  liveTurn(conv, messageId);
  fire('message_status', { conversationId: conv, messageId, status: 'pending' });
  fire('relay_stream', { conversationId: conv, messageId, text: 'first words', seq: 1 });
  const stream = () => liveBubble()?.querySelector('#thinking-stream');
  assert.match(stream().textContent, /first words/, 'a pending ack never mutes the turn');
  fire('message_status', { conversationId: conv, messageId, status: 'done' });
  fire('relay_stream', { conversationId: conv, messageId, text: 'late frame', seq: 2 });
  assert.equal(liveBubble(), null, 'a frame after completion does not resurrect the bubble');
});

test('a background conversation finishing its turn leaves the viewed live bubble alone', () => {
  resetView();
  const conv = openConversation();
  const messageId = uid('u');
  liveTurn(conv, messageId);
  const bubble = liveBubble();
  fire('assistant_message', {
    conversationId: uid('conv-other'),
    messageId: uid('a'),
    sourceMessageId: uid('u'),
    message: { role: 'assistant', text: 'elsewhere', timestamp: at(30) },
  });
  assert.equal(liveBubble(), bubble);
  fire('assistant_message', {
    conversationId: conv,
    messageId: uid('a'),
    sourceMessageId: messageId,
    message: { role: 'assistant', text: 'here', timestamp: at(30), sourceMessageId: messageId },
  });
  assert.equal(liveBubble(), null, 'the viewed conversation\'s own answer replaces it');
});

test('a live-appended stopped marker can resend its original', () => {
  resetView();
  const conv = openConversation();
  const userId = uid('u');
  view.renderMessages([{ id: userId, role: 'user', text: 'cut off', timestamp: at(0) }], false, { conversationId: conv });
  const markerId = uid('a');
  fire('assistant_message', {
    conversationId: conv,
    messageId: markerId,
    sourceMessageId: userId,
    message: { role: 'assistant', text: '_(Stopped with the turn — not answered.)_', kind: 'stopped', sourceMessageId: userId, timestamp: at(5) },
  });
  assert.deepEqual(rowIds(), [userId, markerId]);
  assert.equal(row(markerId).dataset.sourceMessageId, userId);
  assert.ok(row(userId).classList.contains('msg-steered'));
  assert.ok(row(markerId).querySelector('[data-action="resend-stopped-steer"]'));
});

test('deleting the viewed conversation over the socket clears its live bubble', () => {
  resetView();
  const conv = openConversation();
  liveTurn(conv, uid('u'));
  fire('conversation_deleted', { conversationId: conv });
  assert.equal(store.currentConvId, null);
  assert.equal(liveBubble(), null);
});

// ---------------------------------------------------------------------------
// Worker-advertised steering (decision 9) and un-steer for the queued lane
// (decision 8): the composer gate and the pushed rows' Cancel both derive
// from the session worker's heartbeat steering snapshot on the status payload.
// ---------------------------------------------------------------------------

// A conversation bound to a session worker, with that worker's steering
// snapshot installed on the store (as the status poll does).
function openWorkerConversation(provider, steering) {
  const conv = openConversation(provider);
  const sdkSessionId = uid('sess');
  conversations[conv].sdkSessionId = sdkSessionId;
  setWorkerSteering(sdkSessionId, steering);
  return { conv, sdkSessionId };
}

function setWorkerSteering(sdkSessionId, steering) {
  return store.setSessionWorkerStatesFromStatusPayload({
    workers: steering === null
      ? []
      : [{ sdkSessionId, status: 'processing', pid: 4242, workerId: `w-${sdkSessionId}`, steering }],
  });
}

const cancelButtonOf = (id) => row(id)?.querySelector('.msg-bubble-actions [data-action="cancel-queued"]') || null;
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test('the composer reads Steer exactly when the conversation\'s worker advertises steering, whatever the provider', () => {
  resetView();
  selectComposerPreferences();
  const input = document.getElementById('msg-input');
  const button = document.getElementById('send-btn');
  let lastTitle = '';
  const labelFor = (provider, steering) => {
    const { conv } = openWorkerConversation(provider, steering);
    view.renderMessages([{ id: 'u1', role: 'user', text: 'running', timestamp: at(0) }], false, { conversationId: conv });
    view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'processing' });
    input.value = 'a thought mid-turn';
    view.syncComposerButtonState();
    const label = button.textContent;
    lastTitle = button.title || '';
    view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'done' });
    input.value = '';
    return label;
  };

  // The Copilot SDK worker opted in on its heartbeat.
  assert.equal(labelFor('github', { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: [] }), 'Steer');
  // A worker that never advertises (the extension path, or an older
  // snapshot): strictly serial, so the message queues behind the turn.
  assert.equal(labelFor('github', { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1' }), 'Queue');
  assert.equal(labelFor('github', null), 'Queue');
  // Claude keeps its provider rule, with or without a worker snapshot.
  // The provider name alone no longer decides: a Claude conversation steers
  // because its worker advertises it, like any other.
  assert.equal(labelFor('claude', { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true }), 'Steer');
  assert.equal(labelFor('claude', { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1' }), 'Queue');
  assert.equal(labelFor('claude', null), 'Queue');
  // The advertised gate still honours the worker's holds like Claude's does.
  assert.equal(labelFor('github', { turnActive: true, canSteer: false, holdReason: 'compaction', messageId: 'u1', supported: true, cancellableIds: [] }), 'Queue');
  assert.match(lastTitle, /compact/i);
  input.value = '';
});

test('a pushed row the worker lists as cancellable keeps Cancel; the set is re-synced from the status payload without a rebuild', () => {
  resetView();
  const { conv, sdkSessionId } = openWorkerConversation('github', {
    turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: ['u2'],
  });
  view.renderMessages([
    { id: 'u1', role: 'user', text: 'the live turn', timestamp: at(0) },
    { id: 'u2', role: 'user', text: 'pushed behind it', timestamp: at(5) },
    { id: 'u3', role: 'user', text: 'consumed already', timestamp: at(6) },
  ], false, { conversationId: conv });
  view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'processing' });

  assert.ok(cancelButtonOf('u2'), 'the un-steerable row renders Cancel');
  assert.equal(cancelButtonOf('u2').textContent, 'Cancel');
  assert.equal(cancelButtonOf('u1'), null, 'the live turn has no Cancel (Stop lives on the live bubble)');
  assert.equal(cancelButtonOf('u3'), null, 'a processing row the worker does not list has none');

  // The worker consumed u2 and pushed u3: the next status payload changes the
  // hash, and the targeted sync moves the control without re-rendering.
  assert.equal(setWorkerSteering(sdkSessionId, { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: ['u3'] }), true);
  view.syncCancellableSteerButtons();
  assert.equal(cancelButtonOf('u2'), null);
  assert.ok(cancelButtonOf('u3'));
  assert.equal(cancelButtonOf('u3').textContent, 'Cancel');

  // A repeat of the same payload is not a change.
  assert.equal(setWorkerSteering(sdkSessionId, { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: ['u3'] }), false);

  // A pending (not yet claimed) row owns its own Cancel and is left alone by
  // the sync whatever the worker lists.
  const pendingId = uid('pending');
  store.trackPendingUserMessage(pendingId, conv, 'still queued');
  store.pendingUserMessageIds.add(pendingId);
  view.appendMessage({ role: 'user', text: 'still queued', timestamp: at(10) }, false, pendingId, true);
  assert.ok(cancelButtonOf(pendingId));
  setWorkerSteering(sdkSessionId, { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: [] });
  view.syncCancellableSteerButtons();
  assert.ok(cancelButtonOf(pendingId), 'pending Cancel untouched');
  assert.equal(cancelButtonOf('u3'), null);
  store.clearPendingUserMessage(pendingId);
  view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'done' });
});

test('cancelling a pushed row: cancel-requested keeps "Cancelling…" until the worker reports it cancelled', async () => {
  resetView();
  const { conv } = openWorkerConversation('github', {
    turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: ['u2'],
  });
  view.renderMessages([
    { id: 'u1', role: 'user', text: 'the live turn', timestamp: at(0) },
    { id: 'u2', role: 'user', text: 'pushed behind it', timestamp: at(5) },
  ], false, { conversationId: conv });
  view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'processing' });
  fetchHandler = async (url, { method }) => {
    if (method === 'POST' && url.endsWith(`/api/conversation/${conv}/cancel-queued-turn`)) {
      return { ok: true, cancelled: false, acknowledgement: 'cancel-requested', requestedMessageId: 'u2', status: 'processing' };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  cancelButtonOf('u2').click();
  await flushMicrotasks();
  await flushMicrotasks();
  const cancelPost = fetchLog.find((entry) => entry.method === 'POST' && entry.url.endsWith('/cancel-queued-turn'));
  assert.equal(cancelPost?.body?.messageId, 'u2', 'the existing cancel-queued route is reused');
  assert.equal(cancelButtonOf('u2').textContent, 'Cancelling…');
  assert.equal(cancelButtonOf('u2').disabled, true);

  // The worker pulled it out of the runtime: the relay's message_status
  // 'cancelled' (from /api/queue-cancelled) clears the control.
  refreshCurrentViewCalls.length = 0;
  fire('message_status', { conversationId: conv, messageId: 'u2', status: 'cancelled' });
  assert.equal(cancelButtonOf('u2'), null);
  assert.equal(refreshCurrentViewCalls.length, 1, 'terminal status reloads the view as for any cancel');
  view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'done' });
});

test('cancelling a pushed row: the 20 s fallback hands the control back when neither answer arrives', async (t) => {
  resetView();
  const { conv, sdkSessionId } = openWorkerConversation('github', {
    turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: ['u2', 'u3'],
  });
  view.renderMessages([
    { id: 'u1', role: 'user', text: 'the live turn', timestamp: at(0) },
    { id: 'u2', role: 'user', text: 'pushed behind it', timestamp: at(5) },
    { id: 'u3', role: 'user', text: 'pushed later', timestamp: at(6) },
  ], false, { conversationId: conv });
  view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'processing' });
  fetchHandler = async (url, { method, body }) => {
    if (method === 'POST' && url.endsWith(`/api/conversation/${conv}/cancel-queued-turn`)) {
      return { ok: true, cancelled: false, acknowledgement: 'cancel-requested', requestedMessageId: body.messageId, status: 'processing' };
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  };

  t.mock.timers.enable({ apis: ['setTimeout'] });
  cancelButtonOf('u2').click();
  cancelButtonOf('u3').click();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(cancelButtonOf('u2').textContent, 'Cancelling…');
  assert.equal(cancelButtonOf('u3').textContent, 'Cancelling…');

  // Meanwhile the worker consumed u3 (dropped from the set) but still lists
  // u2. The sync leaves both alone while their un-steer is unanswered.
  setWorkerSteering(sdkSessionId, { turnActive: true, canSteer: true, holdReason: null, messageId: 'u1', supported: true, cancellableIds: ['u2'] });
  view.syncCancellableSteerButtons();
  assert.equal(cancelButtonOf('u2').textContent, 'Cancelling…');
  assert.equal(cancelButtonOf('u3').textContent, 'Cancelling…');

  t.mock.timers.tick(19_999);
  assert.equal(cancelButtonOf('u2').textContent, 'Cancelling…', 'not yet');
  t.mock.timers.tick(1);
  assert.equal(cancelButtonOf('u2').textContent, 'Cancel', 'still listed: the control is handed back');
  assert.equal(cancelButtonOf('u2').disabled, false);
  assert.equal(cancelButtonOf('u3'), null, 'no longer listed: the control is gone');
  t.mock.timers.reset();

  // A second tap works again after the fallback.
  fetchLog.length = 0;
  cancelButtonOf('u2').click();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(fetchLog.filter((entry) => entry.url.endsWith('/cancel-queued-turn')).length, 1);
  assert.equal(cancelButtonOf('u2').textContent, 'Cancelling…');
  fire('message_status', { conversationId: conv, messageId: 'u2', status: 'cancelled' });
  assert.equal(cancelButtonOf('u2'), null);
  view.applyConversationTurnStatus({ conversationId: conv, messageId: 'u1', status: 'done' });
});
