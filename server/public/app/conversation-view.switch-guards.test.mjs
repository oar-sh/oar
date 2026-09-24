import test from 'node:test';
import assert from 'node:assert/strict';

// Regression tests for the mid-await conversation-switch guards: every async
// flow in conversation-view.js that touches the view after an await must bail
// out of its side effects when the user opened another conversation while the
// awaited round trip was in flight. Each flow gets a "switched" test (start on
// conversation A, flip to B while a deferred fetch is pending, resolve, assert
// B was untouched) and a happy-path test (no switch, the flow still works).

// ---------------------------------------------------------------------------
// DOM stub — rich enough for renderMessages/sendMessage/toggle flows, built
// before the module graph is imported (store.js reads window/document at
// module scope).
// ---------------------------------------------------------------------------

class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { for (const n of names) this.names.add(n); }
  remove(...names) { for (const n of names) this.names.delete(n); }
  toggle(name, force) {
    const next = force === undefined ? !this.names.has(name) : !!force;
    if (next) this.names.add(name); else this.names.delete(name);
    return next;
  }
  contains(name) { return this.names.has(name); }
}

// One compound selector: `.a.b`, `[data-x="1"]`, `.msg[data-message-timestamp]`.
// Attribute *presence* is supported as well as equality, because the transcript
// code selects on `.msg[data-message-timestamp]`; without it every separator
// query would silently return nothing and the feature under test would be a
// no-op here.
function parseCompoundSelector(selector) {
  const sel = String(selector || '').trim();
  if (!sel || /[\s>+~]/.test(sel)) return null;
  const attrs = [];
  let rest = sel.replace(/\[([^\]=]+)="([^"]*)"\]/g, (_, name, value) => {
    attrs.push([name.trim(), value]);
    return '';
  });
  rest = rest.replace(/\[([^\]=]+)\]/g, (_, name) => {
    attrs.push([name.trim(), null]);
    return '';
  });
  if (rest.includes('[') || rest.includes(']')) return null;
  const classes = rest.split('.').map((part) => part.trim()).filter(Boolean);
  return { classes, attrs };
}

// A selector list (`.msg, .transcript-separator`) matches if any branch does.
function parseSimpleSelector(selector) {
  const parts = String(selector || '').split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  const parsed = parts.map((part) => parseCompoundSelector(part));
  if (parsed.some((entry) => !entry)) return null;
  return parsed;
}

function matchesCompound(el, parsed) {
  for (const cls of parsed.classes) {
    const tokens = String(el.className || '').split(/\s+/).filter(Boolean);
    if (!tokens.includes(cls) && !el.classList.contains(cls)) return false;
  }
  for (const [name, value] of parsed.attrs) {
    if (!name.startsWith('data-')) return false;
    const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const has = !!el.dataset && Object.prototype.hasOwnProperty.call(el.dataset, key);
    if (value === null) {
      if (!has) return false;
      continue;
    }
    if (String(el.dataset?.[key] ?? '') !== value) return false;
  }
  return true;
}

function elementMatches(el, parsedList) {
  if (!parsedList) return false;
  return parsedList.some((parsed) => matchesCompound(el, parsed));
}

function* walkDescendants(el) {
  for (const child of el.children) {
    yield child;
    yield* walkDescendants(child);
  }
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = new FakeClassList();
    this.listeners = {};
    this.value = '';
    this.textContent = '';
    this.title = '';
    this.placeholder = '';
    this.hidden = false;
    this.disabled = false;
    this.scrollTop = 0;
    // Every row is 100px tall unless a test pins a height, so scroll
    // assertions can tell "scrolled before the separator was inserted" from
    // "scrolled after".
    this._scrollHeight = null;
    this.clientHeight = 0;
    this.focusCount = 0;
    this._innerHTML = '';
    this._className = '';
  }
  get className() {
    return this._className || [...this.classList.names].join(' ');
  }
  set className(value) {
    this._className = String(value || '');
    this.classList = new FakeClassList();
    for (const token of this._className.split(/\s+/).filter(Boolean)) this.classList.add(token);
  }
  set innerHTML(value) { this._innerHTML = String(value); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  getAttribute() { return null; }
  setAttribute() {}
  removeAttribute() {}
  get scrollHeight() {
    return this._scrollHeight === null ? this.children.length * 100 : this._scrollHeight;
  }
  set scrollHeight(value) { this._scrollHeight = Number(value) || 0; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get nodeType() { return this.tagName === '#FRAGMENT' ? 11 : 1; }
  get previousSibling() {
    const siblings = this.parentNode?.children || [];
    const idx = siblings.indexOf(this);
    return idx > 0 ? siblings[idx - 1] : null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.children || [];
    const idx = siblings.indexOf(this);
    return (idx !== -1 && idx + 1 < siblings.length) ? siblings[idx + 1] : null;
  }
  // A fragment splices its children in and empties itself, like the real DOM —
  // otherwise a prepended history page would land as one opaque node and the
  // ordering this file asserts would be meaningless.
  _spliceNodes(node) {
    if (node?.tagName !== '#FRAGMENT') return null;
    const moved = node.children.slice();
    node.children = [];
    return moved;
  }
  appendChild(node) {
    const fragmentChildren = this._spliceNodes(node);
    if (fragmentChildren) {
      for (const child of fragmentChildren) {
        child.parentNode = this;
        this.children.push(child);
      }
      return node;
    }
    if (node?.parentNode) node.remove();
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, ref) {
    const fragmentChildren = this._spliceNodes(node);
    if (fragmentChildren) {
      const at = this.children.indexOf(ref);
      const target = at === -1 ? this.children.length : at;
      for (const child of fragmentChildren) child.parentNode = this;
      this.children.splice(target, 0, ...fragmentChildren);
      return node;
    }
    if (node?.parentNode) node.remove();
    node.parentNode = this;
    const idx = this.children.indexOf(ref);
    if (idx === -1) this.children.push(node);
    else this.children.splice(idx, 0, node);
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx !== -1) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }
  insertAdjacentHTML() {}
  querySelector(selector) {
    const parsed = parseSimpleSelector(selector);
    if (!parsed) return null;
    for (const node of walkDescendants(this)) {
      if (elementMatches(node, parsed)) return node;
    }
    return null;
  }
  querySelectorAll(selector) {
    const parsed = parseSimpleSelector(selector);
    if (!parsed) return [];
    return [...walkDescendants(this)].filter((node) => elementMatches(node, parsed));
  }
  closest() { return null; }
  focus() { this.focusCount += 1; }
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

// Every id resolves to a persistent fake element: several modules bind
// listeners to fixed ids at import time and would throw on null.
const elementsById = new Map();
function getById(id) {
  if (!elementsById.has(id)) {
    const el = new FakeElement();
    el.id = id;
    elementsById.set(id, el);
  }
  return elementsById.get(id);
}

globalThis.window = {
  innerHeight: 800,
  innerWidth: 1024,
  location: { pathname: '/' },
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  setTimeout,
  clearTimeout,
};
globalThis.document = {
  documentElement: { clientHeight: 800, clientWidth: 1024, style: { setProperty() {}, removeProperty() {} } },
  body: { classList: new FakeClassList() },
  activeElement: null,
  addEventListener() {},
  getElementById: (id) => getById(id),
  createElement: (tag) => new FakeElement(tag),
  createDocumentFragment: () => new FakeElement('#fragment'),
  querySelector: (selector) => getById('messages')?.querySelector(selector) ?? null,
  querySelectorAll: (selector) => getById('messages')?.querySelectorAll(selector) ?? [],
};
globalThis.sessionStorage = { getItem: () => '', setItem() {}, removeItem() {} };
const localStorageStore = new Map();
globalThis.localStorage = {
  getItem: (key) => (localStorageStore.has(key) ? localStorageStore.get(key) : null),
  setItem: (key, value) => { localStorageStore.set(key, String(value)); },
  removeItem: (key) => { localStorageStore.delete(key); },
};
globalThis.requestAnimationFrame = () => 0;
globalThis.CSS = { escape: (value) => String(value) };
// Makes rewriteLocalAssetUrlsInNode a no-op (`node instanceof Element` is false
// for every fake node); marked stays undefined so renderMarkdownPreview takes
// its DOM-free escaped-text fallback.
globalThis.Element = class Element {};

// ---------------------------------------------------------------------------
// fetch stub — tests install a per-test handler; deferred() lets a test flip
// the current conversation while an awaited request is still pending.
// ---------------------------------------------------------------------------

const fetchLog = [];
let fetchHandler = async (url) => { throw new Error(`unexpected fetch: ${url}`); };
globalThis.fetch = async (url, opts = {}) => {
  fetchLog.push({ url: String(url), method: String(opts.method || 'GET'), body: opts.body || null });
  const payload = await fetchHandler(String(url), opts);
  return { ok: true, status: 200, json: async () => payload };
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const store = await import('./store.js');
const view = await import('./conversation-view.js');
const { setCurrentConv, conversations, repoBrowserState } = store;

const messagesEl = getById('messages');
view.initBubbleActionHandlers();
view.initConversationHistoryLazyLoading();
const bubbleClickHandler = messagesEl.listeners.click[0];
const messagesScrollHandler = messagesEl.listeners.scroll[0];

let uniqueCounter = 0;
function nextId(prefix) {
  uniqueCounter += 1;
  return `${prefix}-${uniqueCounter}`;
}

function makeMessage(id, overrides = {}) {
  return {
    id,
    role: 'user',
    text: `text of ${id}`,
    timestamp: new Date(1700000000000 + (uniqueCounter += 1) * 1000).toISOString(),
    ...overrides,
  };
}

function validationPayload(sessionId, rootPath, title) {
  return {
    sdkSessionId: sessionId,
    runtimeSession: { sdkSessionId: sessionId, id: 'rt-1' },
    sessionRootPath: rootPath,
    sessionRootName: `${title} root`,
    title,
  };
}

function resetComposer(text = '') {
  const input = getById('msg-input');
  input.value = text;
  getById('model-select').value = 'test-model';
  getById('reasoning-effort-select').value = 'medium';
  getById('context-tier-select').value = 'default';
  getById('mode-select').value = 'agent';
}

function resetSessionIndicators() {
  const chatTitle = getById('chat-title');
  delete chatTitle.dataset.copilotSessionId;
  chatTitle.title = '';
  repoBrowserState.sessionRootPath = '';
  repoBrowserState.sessionRootName = 'Session';
}

// The transcript container holds message bubbles AND full-width separator
// rows, so message assertions go through these rather than raw children.
function messageRows() {
  return messagesEl.children.filter((node) => node.classList.contains('msg'));
}

function separatorRows() {
  return messagesEl.children.filter((node) => node.classList.contains('transcript-separator'));
}

function fireShareToggleClick(messageId, hiddenFromShares) {
  const btn = new FakeElement('button');
  btn.dataset = {
    action: 'toggle-share-visibility',
    messageId,
    hiddenFromShares: hiddenFromShares ? 'true' : 'false',
  };
  bubbleClickHandler({ target: { closest: () => btn }, preventDefault() {}, stopPropagation() {} });
}

// ---------------------------------------------------------------------------
// Bug 1 — sendMessage posts to (and renders in) the conversation it was typed
// in, never the one the user switched to mid-send.
// ---------------------------------------------------------------------------

test('sendMessage posts to the validated conversation when the user switches mid-validation, without rendering into the new one', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  resetComposer('typed in a');
  messagesEl.innerHTML = '';
  const validation = deferred();
  fetchHandler = async (url, opts) => {
    if (url.includes(`/api/conversation/${convA}?`)) return validation.promise;
    if (url.includes('/api/message')) return { conversationId: convA, messageId: nextId('srv') };
    if (url.includes(`/api/conversation/${convA}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    throw new Error(`unexpected fetch: ${opts.method || 'GET'} ${url}`);
  };

  const sendPromise = view.sendMessage();
  await settle();
  // The user clicks conversation B in the sidebar while validation is pending.
  setCurrentConv(convB);
  getById('msg-input').value = 'draft of b';
  validation.resolve(validationPayload('sess-a', '/root-a', 'A'));
  await sendPromise;

  const post = fetchLog.find((entry) => entry.url.includes('/api/message'));
  assert.ok(post, 'the message must still be posted');
  assert.equal(JSON.parse(post.body).conversationId, convA, 'the post targets the conversation the message was typed in');
  assert.equal(messageRows().length, 0, 'no user bubble is rendered into the newly opened conversation');
  assert.equal(getById('msg-input').value, 'draft of b', 'the new conversation\'s composer draft is untouched');
  const draftPatch = fetchLog.find((entry) => entry.url.includes(`/api/conversation/${convA}/draft`));
  assert.ok(draftPatch, 'the sent conversation\'s draft is still cleared');
  assert.equal(JSON.parse(draftPatch.body).draftText, '');
  assert.ok(
    !fetchLog.some((entry) => entry.url.includes(`/api/conversation/${convB}/draft`)),
    'no draft write ever targets the switched-to conversation',
  );
});

test('sendMessage happy path: unswitched flow posts, renders the bubble, and clears the composer', async () => {
  const convA = nextId('conv-a');
  conversations[convA] = { id: convA, title: 'A' };
  setCurrentConv(convA);
  resetComposer('hello there');
  messagesEl.innerHTML = '';
  fetchHandler = async (url) => {
    if (url.includes(`/api/conversation/${convA}?`)) return validationPayload('sess-a', '/root-a', 'A');
    if (url.includes('/api/message')) return { conversationId: convA, messageId: nextId('srv') };
    if (url.includes(`/api/conversation/${convA}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    throw new Error(`unexpected fetch: ${url}`);
  };

  await view.sendMessage();

  const post = fetchLog.find((entry) => entry.url.includes('/api/message') && JSON.parse(entry.body).text === 'hello there');
  assert.ok(post, 'the message was posted');
  assert.equal(JSON.parse(post.body).conversationId, convA);
  assert.equal(messageRows().length, 1, 'the user bubble is rendered');
  assert.match(messageRows()[0].className, /\bmsg\b/);
  assert.match(messageRows()[0].className, /\buser\b/);
  assert.equal(getById('msg-input').value, '', 'the composer is cleared');
});

test('sendMessage posts the composer selection and image-edit target captured at send time, not the switched-to conversation\'s', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  resetComposer('composer capture test');
  messagesEl.innerHTML = '';
  view.setImageEditTarget({ messageId: 'img-msg-a', imageId: 'img-1', nodeId: 'node-1', name: 'photo.png' });
  const validation = deferred();
  fetchHandler = async (url, opts) => {
    if (url.includes(`/api/conversation/${convA}?`)) return validation.promise;
    if (url.includes('/api/message')) return { conversationId: convA, messageId: nextId('srv') };
    if (url.includes(`/api/conversation/${convA}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    throw new Error(`unexpected fetch: ${opts.method || 'GET'} ${url}`);
  };

  const sendPromise = view.sendMessage();
  await settle();
  // The user opens conversation B mid-validation. Opening a conversation
  // rewrites the composer selects (applyConversationPreferences runs on every
  // open) and clears the image-edit target (journal-view's openConversation);
  // simulate both so a post-await read of the live DOM would be caught.
  setCurrentConv(convB);
  getById('model-select').value = 'model-of-b';
  getById('reasoning-effort-select').value = 'high';
  getById('context-tier-select').value = 'extended';
  getById('mode-select').value = 'plan';
  view.clearImageEditTarget();
  validation.resolve(validationPayload('sess-a', '/root-a', 'A'));
  await sendPromise;

  const post = fetchLog.find((entry) => entry.url.includes('/api/message') && entry.body && JSON.parse(entry.body).text === 'composer capture test');
  assert.ok(post, 'the message must still be posted');
  const body = JSON.parse(post.body);
  assert.equal(body.model, 'test-model', 'the model captured before the await is sent');
  assert.equal(body.reasoningEffort, 'medium', 'the reasoning effort captured before the await is sent');
  assert.equal(body.contextTier, 'default', 'the context tier captured before the await is sent');
  assert.equal(body.relayMode, 'agent', 'the mode captured before the await is sent');
  assert.deepEqual(
    body.imageTarget,
    { messageId: 'img-msg-a', imageId: 'img-1', nodeId: 'node-1' },
    'the image-edit target captured before the await still rides the request',
  );
});

test('sendMessage completing after a switch leaves the newly opened conversation\'s image-edit target alone', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  resetComposer('clears only its own target');
  messagesEl.innerHTML = '';
  view.setImageEditTarget({ messageId: 'img-msg-a2', imageId: 'img-2', nodeId: 'node-2', name: 'a.png' });
  const validation = deferred();
  fetchHandler = async (url, opts) => {
    if (url.includes(`/api/conversation/${convA}?`)) return validation.promise;
    if (url.includes('/api/message')) return { conversationId: convA, messageId: nextId('srv') };
    if (url.includes(`/api/conversation/${convA}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    throw new Error(`unexpected fetch: ${opts.method || 'GET'} ${url}`);
  };

  const sendPromise = view.sendMessage();
  await settle();
  setCurrentConv(convB);
  // Mid-await the user sets a fresh image-edit target on conversation B; the
  // send finishing on A must not clear it out from under them.
  view.setImageEditTarget({ messageId: 'img-msg-b', imageId: 'img-b', nodeId: 'node-b', name: 'b.png' });
  validation.resolve(validationPayload('sess-a', '/root-a', 'A'));
  await sendPromise;

  assert.equal(store.imageEditTarget?.messageId, 'img-msg-b', 'the target set on the switched-to conversation survives the send');
  const post = fetchLog.find((entry) => entry.url.includes('/api/message') && entry.body && JSON.parse(entry.body).text === 'clears only its own target');
  assert.equal(JSON.parse(post.body).imageTarget.messageId, 'img-msg-a2', 'the send still carried its own captured target');
  view.clearImageEditTarget();
});

test('sendMessage happy path: an unswitched image-edit send posts the target and then clears it', async () => {
  const convA = nextId('conv-a');
  conversations[convA] = { id: convA, title: 'A' };
  setCurrentConv(convA);
  resetComposer('image edit happy path');
  messagesEl.innerHTML = '';
  view.setImageEditTarget({ messageId: 'img-msg-h', imageId: 'img-h', nodeId: 'node-h', name: 'h.png' });
  fetchHandler = async (url) => {
    if (url.includes(`/api/conversation/${convA}?`)) return validationPayload('sess-a', '/root-a', 'A');
    if (url.includes('/api/message')) return { conversationId: convA, messageId: nextId('srv') };
    if (url.includes(`/api/conversation/${convA}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    throw new Error(`unexpected fetch: ${url}`);
  };

  await view.sendMessage();

  const post = fetchLog.find((entry) => entry.url.includes('/api/message') && entry.body && JSON.parse(entry.body).text === 'image edit happy path');
  assert.equal(JSON.parse(post.body).imageTarget.messageId, 'img-msg-h');
  assert.equal(store.imageEditTarget, null, 'the posted target is cleared on the conversation it belonged to');
});

// ---------------------------------------------------------------------------
// Bug 2 — toggleMessageShareVisibility must not render the toggled
// conversation's reload into a conversation opened mid-toggle.
// ---------------------------------------------------------------------------

test('share-visibility toggle: a reload resolving after a switch is not rendered into the new conversation', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  const msgA1 = makeMessage(nextId('msg-a'));
  const msgA2 = makeMessage(nextId('msg-a'), { role: 'assistant' });
  view.renderMessages([msgA1, msgA2], false, { conversationId: convA });
  assert.equal(messageRows().length, 2, 'precondition: conversation A is rendered');

  const reload = deferred();
  fetchHandler = async (url, opts) => {
    if (url.includes('/share-visibility')) return { ok: true, hiddenFromShares: true };
    if (url.includes(`/api/conversation/${convA}?`)) return reload.promise;
    throw new Error(`unexpected fetch: ${opts.method || 'GET'} ${url}`);
  };
  fireShareToggleClick(msgA1.id, false);
  await settle();

  // The user opens conversation B while the reload is in flight.
  setCurrentConv(convB);
  const msgB1 = makeMessage(nextId('msg-b'));
  view.renderMessages([msgB1], false, { conversationId: convB });
  assert.equal(messageRows().length, 1);

  reload.resolve({ messages: [msgA1, { ...msgA2, hiddenFromShares: true }], pageInfo: {} });
  await settle();
  await settle();

  assert.equal(messageRows().length, 1, 'conversation B still shows only its own message');
  assert.equal(messageRows()[0].dataset.messageId, msgB1.id);
  const viewStateKeyB = [...localStorageStore.keys()].find((key) => key.includes(convB));
  assert.ok(viewStateKeyB, 'conversation B has its own persisted view state');
  assert.equal(
    JSON.parse(localStorageStore.get(viewStateKeyB)).loadedMessageCount,
    1,
    'conversation B\'s persisted loaded count was not clobbered by A\'s reload',
  );
});

test('share-visibility toggle: a switch during the toggle round trip skips the reload fetch entirely', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  const msgA1 = makeMessage(nextId('msg-a'));
  view.renderMessages([msgA1], false, { conversationId: convA });

  const patch = deferred();
  fetchHandler = async (url) => {
    if (url.includes('/share-visibility')) return patch.promise;
    throw new Error(`unexpected fetch: ${url}`);
  };
  fireShareToggleClick(msgA1.id, false);
  await settle();
  setCurrentConv(convB);
  const logLengthBeforeResolve = fetchLog.length;
  patch.resolve({ ok: true, hiddenFromShares: true });
  await settle();
  await settle();

  assert.equal(fetchLog.length, logLengthBeforeResolve, 'no reload request is issued for a stale view');
});

test('share-visibility toggle happy path: unswitched flow reloads and re-renders the conversation', async () => {
  const convA = nextId('conv-a');
  conversations[convA] = { id: convA, title: 'A' };
  setCurrentConv(convA);
  const msgA1 = makeMessage(nextId('msg-a'));
  const msgA2 = makeMessage(nextId('msg-a'), { role: 'assistant' });
  view.renderMessages([msgA1, msgA2], false, { conversationId: convA });

  fetchHandler = async (url) => {
    if (url.includes('/share-visibility')) return { ok: true, hiddenFromShares: true };
    if (url.includes(`/api/conversation/${convA}?`)) {
      return { messages: [{ ...msgA1, hiddenFromShares: true }, msgA2], pageInfo: {} };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fireShareToggleClick(msgA1.id, false);
  await settle();
  await settle();

  assert.equal(messageRows().length, 2, 'the reloaded conversation is rendered');
  assert.match(
    messageRows()[0].innerHTML,
    /Hidden from shared viewers/,
    'the re-render reflects the new share visibility',
  );
});

// ---------------------------------------------------------------------------
// Bug 3 — pagination cursors from the previous conversation must not be spent
// against the newly opened one, and stale in-flight pages must not apply.
// ---------------------------------------------------------------------------

function primeHistoryPage(convId, messages, cursorId) {
  view.renderMessages(messages, false, {
    conversationId: convId,
    pageInfo: {
      hasMore: true,
      nextCursor: { beforeMessageId: cursorId, beforeTimestamp: '2026-01-01T00:00:00.000Z' },
    },
  });
}

test('pagination: a load-older issued after a conversation switch does not fetch with the old cursor', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  primeHistoryPage(convA, [makeMessage(nextId('msg-a')), makeMessage(nextId('msg-a'))], nextId('cursor-a'));
  assert.equal(view.getConversationLoadedMessageCount(), 2);

  // Conversation switch starts (setCurrentConv runs before the new load).
  setCurrentConv(convB);
  fetchHandler = async (url) => { throw new Error(`unexpected fetch: ${url}`); };
  const logLengthBefore = fetchLog.length;
  await view.loadOlderConversationMessages();

  assert.equal(fetchLog.length, logLengthBefore, 'no page is fetched with the stale cursor');
  assert.equal(view.getConversationLoadedMessageCount(), 2, 'the history state is untouched');
});

test('pagination: a scroll during the switch gap resets the loaders before any cursor can be spent', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  primeHistoryPage(convA, [makeMessage(nextId('msg-a'))], nextId('cursor-a'));

  setCurrentConv(convB);
  messagesScrollHandler();

  // Even back on the original conversation the reset loaders hold no cursor;
  // only the new conversation load re-primes them.
  setCurrentConv(convA);
  fetchHandler = async (url) => { throw new Error(`unexpected fetch: ${url}`); };
  const logLengthBefore = fetchLog.length;
  await view.loadOlderConversationMessages();
  assert.equal(fetchLog.length, logLengthBefore, 'the reset cleared the stale cursor');
});

test('pagination: an in-flight older-page response for the previous conversation is dropped after a switch', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  const cursorId = nextId('cursor-a');
  primeHistoryPage(convA, [makeMessage(nextId('msg-a')), makeMessage(nextId('msg-a'))], cursorId);
  assert.equal(view.getConversationLoadedMessageCount(), 2);

  const page = deferred();
  fetchHandler = async (url) => {
    if (url.includes(`beforeMessageId=${cursorId}`)) return page.promise;
    throw new Error(`unexpected fetch: ${url}`);
  };
  const loadPromise = view.loadOlderConversationMessages();
  await settle();
  setCurrentConv(convB);
  page.resolve({ messages: [makeMessage(nextId('msg-a-old'))], pageInfo: { hasMore: false } });
  await loadPromise;

  assert.equal(view.getConversationLoadedMessageCount(), 2, 'the stale page is not applied');
});

test('pagination happy path: load-older on the same conversation prepends the page above the rows already shown', async () => {
  const convA = nextId('conv-a');
  conversations[convA] = { id: convA, title: 'A' };
  setCurrentConv(convA);
  const cursorId = nextId('cursor-a');
  const first = makeMessage(nextId('msg-a'), { timestamp: '2026-02-11T09:00:00.000Z' });
  const second = makeMessage(nextId('msg-a'), { timestamp: '2026-02-11T09:01:00.000Z' });
  primeHistoryPage(convA, [first, second], cursorId);
  assert.equal(view.getConversationLoadedMessageCount(), 2);

  const older = makeMessage(nextId('msg-a-old'), { timestamp: '2026-02-10T09:00:00.000Z' });
  fetchHandler = async (url) => {
    if (url.includes(`beforeMessageId=${cursorId}`)) {
      return { messages: [older], pageInfo: { hasMore: false } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  await view.loadOlderConversationMessages();

  assert.equal(view.getConversationLoadedMessageCount(), 3, 'the older page was applied');
  // Position, not just count: the older page must land ABOVE the rows that
  // were already there (an appendChild fallback would bury it at the bottom).
  assert.deepEqual(
    messageRows().map((node) => node.dataset.messageId),
    [older.id, first.id, second.id],
    'the older message is the topmost bubble',
  );
  // …and the separator pass reruns over the merged transcript: the prepended
  // day gets its own row on top, the original day keeps its own.
  assert.deepEqual(
    messagesEl.children.map((node) => node.dataset.separatorKind || `msg:${node.dataset.messageId}`),
    ['day', `msg:${older.id}`, 'day', `msg:${first.id}`, `msg:${second.id}`],
  );
});

// ---------------------------------------------------------------------------
// Transcript separators — day rollovers and compaction boundaries are
// full-width rows synced after every insertion path.
// ---------------------------------------------------------------------------

function separatorLayout() {
  return messagesEl.children.map((node) => node.dataset.separatorKind || `msg:${node.dataset.messageId}`);
}

test('separators: a day row opens each local day and a compaction row sits before the message that compacted', () => {
  const convId = nextId('conv-sep');
  conversations[convId] = { id: convId, title: 'S' };
  setCurrentConv(convId);
  const dayOne = makeMessage(nextId('msg-sep'), { timestamp: '2026-02-10T10:00:00.000Z' });
  const dayTwo = makeMessage(nextId('msg-sep'), {
    role: 'assistant',
    timestamp: '2026-02-11T10:00:00.000Z',
    activities: [
      { text: 'Read foo.txt' },
      { text: 'Compacted the context', metadata: { kind: 'compact_boundary', preTokens: 120000, postTokens: 30000 } },
    ],
  });
  view.renderMessages([dayOne, dayTwo], false, { conversationId: convId });

  assert.deepEqual(separatorLayout(), ['day', `msg:${dayOne.id}`, 'day', 'compact', `msg:${dayTwo.id}`]);
  const compactRow = separatorRows().find((node) => node.dataset.separatorKind === 'compact');
  assert.match(compactRow.dataset.separatorLabel, /Context compacted · 120k → 30k tokens/);
  // The promoted boundary is the break row, so it is not repeated as prose.
  assert.doesNotMatch(messageRows()[1].innerHTML, /Compacted the context/);
  assert.match(messageRows()[1].innerHTML, /Read foo\.txt/);
});

test('separators: an appended message that opens a new day still leaves the transcript at the bottom', () => {
  const convId = nextId('conv-scroll');
  conversations[convId] = { id: convId, title: 'Scroll' };
  setCurrentConv(convId);
  const dayOne = makeMessage(nextId('msg-scroll'), { timestamp: '2026-02-10T10:00:00.000Z' });
  view.renderMessages([dayOne], false, { conversationId: convId });
  // The user is pinned to the bottom when the reply arrives.
  messagesEl.scrollTop = messagesEl.scrollHeight;

  const dayTwo = makeMessage(nextId('msg-scroll'), { role: 'assistant', timestamp: '2026-02-11T10:00:00.000Z' });
  view.appendMessage(dayTwo, true, dayTwo.id, true);

  assert.deepEqual(separatorLayout(), ['day', `msg:${dayOne.id}`, 'day', `msg:${dayTwo.id}`]);
  // Scrolling before the separator row existed would leave the viewport a
  // separator-height short — which then reads as "not at bottom" and
  // suppresses auto-scroll for the next message too.
  assert.equal(
    messagesEl.scrollTop,
    messagesEl.scrollHeight,
    'the scroll accounts for the separator the append introduced',
  );
});

test('live bubble: a compaction boundary is never appended as thinking prose', () => {
  const box = getById('thinking-activity');
  box.children = [];
  view.appendThinkingActivity({ text: 'Read foo.txt' }, null, false);
  view.appendThinkingActivity(
    { text: 'Compacted the context', metadata: { kind: 'compact_boundary', preTokens: 120000, postTokens: 30000 } },
    null,
    false,
  );
  view.appendThinkingActivity('Wrote bar.txt', null, false);

  assert.deepEqual(
    box.children.map((node) => node.textContent),
    ['Read foo.txt', 'Wrote bar.txt'].map((text) => view.decorateActivityText(text)),
    'the boundary is left to the persisted break row',
  );
});

test('live bubble: a replayed activity list renders every entry except the compaction boundary', () => {
  const convId = nextId('conv-live');
  conversations[convId] = { id: convId, title: 'L' };
  setCurrentConv(convId);
  const messageId = nextId('msg-live');
  view.showThinking(messageId, false);
  const box = getById('thinking-activity');
  box.children = [];
  store.relayActivities.set(messageId, [
    { text: 'Read foo.txt', subagentRunId: null },
    {
      text: 'Compacted the context',
      subagentRunId: null,
      metadata: { kind: 'compact_boundary', preTokens: 120000, postTokens: 30000 },
    },
    { text: 'Wrote bar.txt', subagentRunId: null },
  ]);

  view.renderThinkingActivities();

  assert.deepEqual(
    box.children.map((node) => node.textContent),
    ['Read foo.txt', 'Wrote bar.txt'].map((text) => view.decorateActivityText(text)),
  );
  store.relayActivities.delete(messageId);
  view.removeThinking();
});

test('separators: a turn that compacted twice promotes the last boundary and keeps the earlier one visible', () => {
  const convId = nextId('conv-sep2');
  conversations[convId] = { id: convId, title: 'S2' };
  setCurrentConv(convId);
  const msg = makeMessage(nextId('msg-sep'), {
    role: 'assistant',
    timestamp: '2026-02-12T10:00:00.000Z',
    activities: [
      { text: 'compaction one', metadata: { kind: 'compact_boundary', preTokens: 100000, postTokens: 20000 } },
      { text: 'compaction two', metadata: { kind: 'compact_boundary', preTokens: 110000, postTokens: 25000 } },
    ],
  });
  view.renderMessages([msg], false, { conversationId: convId });

  assert.deepEqual(separatorLayout(), ['day', 'compact', `msg:${msg.id}`]);
  const compactRow = separatorRows().find((node) => node.dataset.separatorKind === 'compact');
  assert.match(compactRow.dataset.separatorLabel, /110k → 25k/, 'the last boundary is the promoted one');
  // Lossless: the boundary that could not be promoted stays in the bubble.
  assert.match(messageRows()[0].innerHTML, /compaction one/);
  assert.doesNotMatch(messageRows()[0].innerHTML, /compaction two/);
});

// ---------------------------------------------------------------------------
// Bug 4 — validateSelectedConversationBeforeSend must not apply the fetched
// session info to the title pill / repo browser after a switch.
// ---------------------------------------------------------------------------

test('send validation resolving after a switch leaves the session pill and repo browser untouched', async () => {
  const convA = nextId('conv-a');
  const convB = nextId('conv-b');
  conversations[convA] = { id: convA, title: 'A' };
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convA);
  resetComposer('pill test');
  resetSessionIndicators();
  messagesEl.innerHTML = '';
  const validation = deferred();
  fetchHandler = async (url) => {
    if (url.includes(`/api/conversation/${convA}?`)) return validation.promise;
    if (url.includes('/api/message')) return { conversationId: convA, messageId: nextId('srv') };
    if (url.includes(`/api/conversation/${convA}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    throw new Error(`unexpected fetch: ${url}`);
  };

  const sendPromise = view.sendMessage();
  await settle();
  setCurrentConv(convB);
  validation.resolve(validationPayload('sess-stale', '/stale-root', 'A'));
  await sendPromise;

  assert.equal(getById('chat-title').dataset.copilotSessionId, undefined, 'the stale session id is not applied to the pill');
  assert.equal(repoBrowserState.sessionRootPath, '', 'the repo browser keeps the current conversation\'s root');
});

test('send validation happy path: unswitched flow applies the session pill and repo browser root', async () => {
  const convA = nextId('conv-a');
  conversations[convA] = { id: convA, title: 'A' };
  setCurrentConv(convA);
  resetComposer('pill test 2');
  resetSessionIndicators();
  messagesEl.innerHTML = '';
  fetchHandler = async (url) => {
    if (url.includes(`/api/conversation/${convA}?`)) return validationPayload('sess-live', '/live-root', 'A');
    if (url.includes('/api/message')) return { conversationId: convA, messageId: nextId('srv') };
    if (url.includes(`/api/conversation/${convA}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    throw new Error(`unexpected fetch: ${url}`);
  };

  await view.sendMessage();

  assert.equal(getById('chat-title').dataset.copilotSessionId, 'sess-live', 'the session pill reflects the validated conversation');
  assert.equal(repoBrowserState.sessionRootPath, '/live-root', 'the repo browser root reflects the validated conversation');
});

// ---------------------------------------------------------------------------
// Bug 5 — the monthly quota badge renders at exactly 0% and hides only when
// the data is absent (null/undefined/NaN).
// ---------------------------------------------------------------------------

function renderAssistantWithQuota(percentRemaining) {
  const convId = nextId('conv-q');
  conversations[convId] = { id: convId, title: 'Q' };
  setCurrentConv(convId);
  const message = makeMessage(nextId('msg-q'), {
    role: 'assistant',
    ...(percentRemaining === undefined ? {} : { usage: { plan: { percentRemaining } } }),
  });
  view.renderMessages([message], false, { conversationId: convId });
  assert.equal(messageRows().length, 1);
  return messageRows()[0].innerHTML;
}

test('quota badge renders "0.0% left" for exactly 0% remaining', () => {
  assert.match(renderAssistantWithQuota(0), /month 0\.0% left/);
});

test('quota badge still renders positive percentages', () => {
  assert.match(renderAssistantWithQuota(42.5), /month 42\.5% left/);
});

test('quota badge hides when the plan data is null, missing, or NaN', () => {
  assert.doesNotMatch(renderAssistantWithQuota(null), /% left/);
  assert.doesNotMatch(renderAssistantWithQuota(undefined), /% left/);
  assert.doesNotMatch(renderAssistantWithQuota('not-a-number'), /% left/);
});

// ---------------------------------------------------------------------------
// buildMessageSnapshotKey — a payload differing only in a message's persisted
// workflowRuns must NOT short-circuit renderMessages (the finished-task card
// would otherwise stay invisible until some unrelated change re-rendered the
// transcript). Rides this file's DOM harness because the key is internal to
// renderMessages, whose return value distinguishes a re-render (true) from
// the short-circuit (false).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Live-bubble anchoring — the thinking indicator belongs to the message whose
// turn is running: a send during an active turn must not re-adopt it, and the
// reuse path must re-anchor a bubble that drifted below newer rows.
// ---------------------------------------------------------------------------

// The harness getElementById map never learns about ids assigned after
// creation, so the div built by showThinking is found via the transcript.
function liveIndicators() {
  return messagesEl.children.filter((node) => node.id === 'thinking-indicator');
}

function resetThinkingIndicatorStub() {
  const stub = getById('thinking-indicator');
  stub.remove();
  delete stub.dataset.messageId;
  return stub;
}

test('live bubble: a send during an active turn does not re-anchor the bubble under the new message', async () => {
  const convId = nextId('conv-anchor');
  conversations[convId] = { id: convId, title: 'Anchor' };
  setCurrentConv(convId);
  resetThinkingIndicatorStub();
  store.setCliOnline(true);
  const msgA = makeMessage(nextId('msg-a'));
  view.renderMessages([msgA], false, { conversationId: convId });
  view.showThinking(msgA.id, false);
  assert.equal(liveIndicators().length, 1, 'precondition: the turn has a live bubble');
  const aRow = messagesEl.children.find((node) => node.dataset.messageId === msgA.id && node.id !== 'thinking-indicator');
  assert.equal(aRow.nextSibling, liveIndicators()[0], 'precondition: the bubble sits under its owning message');
  view.applyConversationTurnStatus({ conversationId: convId, messageId: msgA.id, status: 'processing' });

  resetComposer('a follow-up queued behind the running turn');
  fetchHandler = async (url) => {
    if (url.includes(`/api/conversation/${convId}?`)) return validationPayload('sess-anchor', '/root-anchor', 'Anchor');
    if (url.includes('/api/message')) return { conversationId: convId, messageId: nextId('srv') };
    if (url.includes(`/api/conversation/${convId}/draft`)) return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    throw new Error(`unexpected fetch: ${url}`);
  };
  await view.sendMessage();

  const indicators = liveIndicators();
  assert.equal(indicators.length, 1, 'the running turn keeps a single live bubble');
  assert.equal(indicators[0].dataset.messageId, msgA.id, 'the bubble still belongs to the active turn');
  assert.equal(aRow.nextSibling, indicators[0], 'the bubble stays anchored under the active turn\'s message');
  const bRow = messagesEl.children.find((node) => node.classList.contains('msg')
    && node.id !== 'thinking-indicator'
    && node.dataset.messageId !== msgA.id);
  assert.ok(bRow, 'the queued follow-up is rendered');
  assert.ok(
    messagesEl.children.indexOf(bRow) > messagesEl.children.indexOf(indicators[0]),
    'the queued follow-up lands below the streaming bubble, not above it',
  );

  view.applyConversationTurnStatus({ conversationId: convId, messageId: msgA.id, status: 'done' });
  indicators[0].remove();
  view.removeThinking();
});

test('live bubble: the reuse branch re-anchors an indicator that drifted below newer rows', () => {
  const convId = nextId('conv-reanchor');
  conversations[convId] = { id: convId, title: 'Re' };
  setCurrentConv(convId);
  const msgA = makeMessage(nextId('msg-a'));
  const msgB = makeMessage(nextId('msg-b'), { role: 'assistant' });
  view.renderMessages([msgA, msgB], false, { conversationId: convId });
  // Simulate a bubble built while its owning row was still unrendered: right
  // message id, but stuck at the transcript end.
  const indicator = resetThinkingIndicatorStub();
  indicator.dataset.messageId = msgA.id;
  indicator.className = 'msg assistant';
  messagesEl.appendChild(indicator);
  assert.equal(messagesEl.lastElementChild, indicator, 'precondition: the bubble is misplaced at the end');

  view.showThinking(msgA.id, false);

  const aRow = messagesEl.children.find((node) => node.dataset.messageId === msgA.id && node !== indicator);
  assert.equal(aRow.nextSibling, indicator, 'the reused bubble is re-anchored under its owning message');
  indicator.remove();
  delete indicator.dataset.messageId;
  view.removeThinking();
});

test('stream blacklist: a mid-flow reset keeps live frames flowing, only completion mutes them', () => {
  const messageId = nextId('msg-stream');
  // Pin the live bubble to another turn so the frames below exercise only the
  // accept/blacklist state machine, not the markdown paint the fake DOM lacks.
  resetThinkingIndicatorStub();
  view.showThinking(nextId('msg-decoy'), false);
  assert.equal(
    view.applyRelayStreamEvent({ messageId, text: 'chunk one', seq: 1, autoScroll: false }),
    true,
    'a fresh message renders live frames',
  );
  // What message_status 'pending'/'parked' now do: reset the bookkeeping only.
  view.clearRelayStreamState(messageId);
  assert.equal(
    view.applyRelayStreamEvent({ messageId, text: 'chunk two', seq: 1, autoScroll: false }),
    true,
    'a reset message accepts frames again',
  );
  // What terminal statuses do: the id is blacklisted from further frames.
  view.clearRelayStreamStateForMessage(messageId);
  assert.equal(
    view.applyRelayStreamEvent({ messageId, text: 'late chunk', seq: 2, autoScroll: false }),
    false,
    'a completed message ignores late frames',
  );
  for (const node of liveIndicators()) node.remove();
  view.removeThinking();
});

// ---------------------------------------------------------------------------
// Bug 6 — the post-send draft echo. POST /api/message clears draft_text in the
// same transaction that stores the message, so between the composer clear and
// that commit the server still serves the pre-send draft. Every refresh issued
// inside that window carries the sent text: the 900ms live poll (armed for the
// whole queue wait by the pending user message) and cross-client draft socket
// events. Applying one re-types the message the user just queued back into the
// composer while its bubble stays in the transcript.
// ---------------------------------------------------------------------------

const PRE_SEND_DRAFT_AT = '2026-02-12T10:00:00.000Z';

// Puts conversation `convId` in the reported state: a turn is already running
// (the send button reads "Queue"), the composer holds `text`, and the server's
// draft for it was last persisted at PRE_SEND_DRAFT_AT.
function primeQueuedSend(convId, text) {
  conversations[convId] = {
    id: convId,
    title: 'D',
    draftText: text,
    draftUpdatedAt: PRE_SEND_DRAFT_AT,
  };
  setCurrentConv(convId);
  resetThinkingIndicatorStub();
  messagesEl.innerHTML = '';
  resetComposer(text);
  const runningId = nextId('msg-running');
  view.renderMessages([makeMessage(runningId)], false, { conversationId: convId });
  view.applyConversationTurnStatus({ conversationId: convId, messageId: runningId, status: 'processing' });
  return runningId;
}

function stubQueuedSendFetches(convId, postResult) {
  fetchHandler = async (url) => {
    if (url.includes(`/api/conversation/${convId}?`)) return validationPayload('sess-d', '/root-d', 'D');
    if (url.includes('/api/message')) return postResult;
    if (url.includes(`/api/conversation/${convId}/draft`)) {
      return { ok: true, draftText: '', draftUpdatedAt: new Date().toISOString() };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('draft echo: a live-poll refresh carrying the pre-send draft does not re-type the queued message into the composer', async () => {
  const convId = nextId('conv-draft');
  const runningId = primeQueuedSend(convId, 'queued while busy');
  const post = deferred();
  stubQueuedSendFetches(convId, post.promise);

  const sendPromise = view.sendMessage();
  await settle();
  assert.equal(getById('msg-input').value, '', 'precondition: the send cleared the composer');

  // The poll response was produced before POST /api/message committed, so it
  // carries the pre-send text at the pre-send version — not older than what
  // this client last knew, so the timestamp guard alone lets it through.
  view.hydrateConversationDraft(convId, {
    draftText: 'queued while busy',
    draftAttachments: [],
    draftUpdatedAt: PRE_SEND_DRAFT_AT,
    draftUpdatedByClientId: null,
  });

  assert.equal(getById('msg-input').value, '', 'the stale draft is not re-typed into the composer');

  post.resolve({ conversationId: convId, messageId: nextId('srv') });
  await sendPromise;
  assert.equal(getById('msg-input').value, '', 'the composer is still empty once the send lands');
  assert.equal(conversations[convId].draftText, '', 'the cached draft is the cleared one');

  // A refresh that started before the commit but only lands after the send let
  // the draft go is caught by the version the send adopted from the server.
  view.hydrateConversationDraft(convId, {
    draftText: 'queued while busy',
    draftAttachments: [],
    draftUpdatedAt: PRE_SEND_DRAFT_AT,
    draftUpdatedByClientId: null,
  });
  assert.equal(getById('msg-input').value, '', 'a late pre-send refresh is still rejected as stale');
  view.applyConversationTurnStatus({ conversationId: convId, messageId: runningId, status: 'done' });
});

test('draft echo: a cross-client draft event carrying the pre-send draft is ignored while the send is in flight', async () => {
  const convId = nextId('conv-draft');
  const runningId = primeQueuedSend(convId, 'queued from the phone');
  const post = deferred();
  stubQueuedSendFetches(convId, post.promise);

  const sendPromise = view.sendMessage();
  await settle();
  assert.equal(getById('msg-input').value, '', 'precondition: the send cleared the composer');

  // Another device's debounced PUT of the same (pre-send) text lands late and
  // is broadcast back here.
  view.applyIncomingConversationDraftUpdate({
    conversationId: convId,
    draftText: 'queued from the phone',
    draftAttachments: [],
    draftUpdatedAt: PRE_SEND_DRAFT_AT,
    senderClientId: 'other-device',
  });

  assert.equal(getById('msg-input').value, '', 'the stale broadcast is not re-typed into the composer');

  post.resolve({ conversationId: convId, messageId: nextId('srv') });
  await sendPromise;
  assert.equal(getById('msg-input').value, '', 'the composer is still empty once the send lands');
  view.applyConversationTurnStatus({ conversationId: convId, messageId: runningId, status: 'done' });
});

test('draft sync: a draft written on another device after the send still reaches the composer', async () => {
  const convId = nextId('conv-draft');
  const runningId = primeQueuedSend(convId, 'sent from here');
  stubQueuedSendFetches(convId, { conversationId: convId, messageId: nextId('srv') });

  await view.sendMessage();
  assert.equal(getById('msg-input').value, '', 'precondition: the send cleared the composer');

  const laterDraftAt = new Date(Date.now() + 60_000).toISOString();
  view.applyIncomingConversationDraftUpdate({
    conversationId: convId,
    draftText: 'typed on the laptop',
    draftAttachments: [],
    draftUpdatedAt: laterDraftAt,
    senderClientId: 'other-device',
  });
  assert.equal(getById('msg-input').value, 'typed on the laptop', 'cross-device draft sync still updates the composer');

  // …and so does the refresh that carries it, which is how a device that
  // missed the socket event catches up.
  view.hydrateConversationDraft(convId, {
    draftText: 'edited again on the laptop',
    draftAttachments: [],
    draftUpdatedAt: new Date(Date.now() + 120_000).toISOString(),
    draftUpdatedByClientId: 'other-device',
  });
  assert.equal(getById('msg-input').value, 'edited again on the laptop', 'a later refresh still restores the newest draft');

  view.applyConversationTurnStatus({ conversationId: convId, messageId: runningId, status: 'done' });
  resetComposer('');
});

test('draft restore: opening a conversation with no send in flight still hydrates its saved draft', () => {
  const convId = nextId('conv-draft');
  conversations[convId] = { id: convId, title: 'D' };
  setCurrentConv(convId);
  resetComposer('');

  view.hydrateConversationDraft(convId, {
    draftText: 'half-written question',
    draftAttachments: [],
    draftUpdatedAt: PRE_SEND_DRAFT_AT,
    draftUpdatedByClientId: 'other-device',
  });

  assert.equal(getById('msg-input').value, 'half-written question', 'the saved draft is restored on open');
  resetComposer('');
});

// ---------------------------------------------------------------------------
// Bug 7 — cross-device draft wipe. Status/poll/question paths used to share
// the composer sync that also scheduled a draft save, and every local edit
// nulled the base version, so an idle device saved its (empty) composer over
// the other device's draft every few seconds without any version check.
// ---------------------------------------------------------------------------

const SERVER_DRAFT_V1 = '2026-09-24T09:00:00.000Z';
const SERVER_DRAFT_V2 = '2026-09-24T09:05:00.000Z';

function draftPatches(convId) {
  return fetchLog
    .filter((entry) => entry.method === 'PATCH' && entry.url.includes(`/api/conversation/${convId}/draft`))
    .map((entry) => JSON.parse(entry.body));
}

// Opens `convId` with the server draft `text` at `version`, as a conversation
// load would.
function openWithServerDraft(convId, text, version) {
  conversations[convId] = { id: convId, title: 'Sync' };
  setCurrentConv(convId);
  resetComposer('');
  document.activeElement = null;
  view.hydrateConversationDraft(convId, {
    draftText: text,
    draftAttachments: [],
    draftUpdatedAt: version,
    draftUpdatedByClientId: 'other-device',
  });
}

test('draft sync: button-only refreshes never save the draft', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, '', SERVER_DRAFT_V1);
  fetchHandler = async (url) => { throw new Error(`unexpected fetch: ${url}`); };
  fetchLog.length = 0;

  // What the 3s question poll, worker status poll and attachment preview do.
  for (let i = 0; i < 3; i += 1) view.syncComposerButtonState();
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.deepEqual(draftPatches(convId), [], 'no draft write comes from a button refresh');
});

test('draft sync: a local edit keeps the server base version and the save carries it', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'hello', SERVER_DRAFT_V1);
  fetchHandler = async (url) => {
    if (url.includes(`/api/conversation/${convId}/draft`)) {
      return { ok: true, draftText: 'hello world', draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V2 };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fetchLog.length = 0;

  getById('msg-input').value = 'hello world';
  view.syncComposerAfterUserEdit();
  assert.equal(conversations[convId].draftUpdatedAt, SERVER_DRAFT_V1, 'the keystroke does not erase the base version');
  assert.equal(conversations[convId].draftText, 'hello world', 'the local text is tracked');

  await new Promise((resolve) => setTimeout(resolve, 600));
  const patches = draftPatches(convId);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].baseDraftUpdatedAt, SERVER_DRAFT_V1, 'the save is version-checked against the synced draft');
  assert.equal(conversations[convId].draftUpdatedAt, SERVER_DRAFT_V2, 'the acknowledged version becomes the next base');
});

test('draft sync: a never-versioned conversation sends an explicit null base', async () => {
  const convId = nextId('conv-sync');
  conversations[convId] = { id: convId, title: 'Fresh' };
  setCurrentConv(convId);
  resetComposer('first words');
  fetchHandler = async (url) => {
    if (url.includes(`/api/conversation/${convId}/draft`)) {
      return { ok: true, draftText: 'first words', draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V1 };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fetchLog.length = 0;

  await view.flushConversationDraft(convId);

  const [patch] = draftPatches(convId);
  assert.ok(patch, 'the draft is saved');
  assert.ok(Object.prototype.hasOwnProperty.call(patch, 'baseDraftUpdatedAt'), 'the base field is present');
  assert.equal(patch.baseDraftUpdatedAt, null);
  resetComposer('');
});

test('draft sync: flushing an unchanged composer sends nothing', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'already saved', SERVER_DRAFT_V1);
  fetchHandler = async (url) => { throw new Error(`unexpected fetch: ${url}`); };
  fetchLog.length = 0;

  await view.flushConversationDraft(convId);
  view.syncComposerAfterUserEdit();
  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.deepEqual(draftPatches(convId), [], 'text equal to the synced draft is not re-saved');
  resetComposer('');
});

test('draft sync: a focused but untouched composer adopts another device\'s draft; a typed one keeps its text', () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, '', SERVER_DRAFT_V1);
  const input = getById('msg-input');
  document.activeElement = input;

  view.applyIncomingConversationDraftUpdate({
    conversationId: convId,
    draftText: 'typed on the phone',
    draftAttachments: [],
    draftUpdatedAt: SERVER_DRAFT_V2,
    senderClientId: 'other-device',
  });
  assert.equal(input.value, 'typed on the phone', 'the idle focused composer follows the remote draft');

  input.value = 'typed on the phone, then edited here';
  view.hydrateConversationDraft(convId, {
    draftText: 'phone edits again',
    draftAttachments: [],
    draftUpdatedAt: '2026-09-24T09:10:00.000Z',
    draftUpdatedByClientId: 'other-device',
  });
  assert.equal(input.value, 'typed on the phone, then edited here', 'unsaved local typing is never overwritten while focused');

  document.activeElement = null;
  resetComposer('');
});

test('draft sync: on a version conflict the newest local edit wins and the other device\'s text is offered back', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'base text', SERVER_DRAFT_V1);
  let patchCount = 0;
  fetchHandler = async (url, opts) => {
    if (!url.includes(`/api/conversation/${convId}/draft`)) throw new Error(`unexpected fetch: ${url}`);
    patchCount += 1;
    const body = JSON.parse(opts.body);
    if (patchCount === 1) {
      return {
        ok: false,
        conflict: true,
        code: 'draft-version-conflict',
        draftText: 'written on the phone',
        draftAttachments: [],
        draftUpdatedAt: SERVER_DRAFT_V2,
      };
    }
    return { ok: true, draftText: body.draftText, draftAttachments: [], draftUpdatedAt: new Date(Date.now() + patchCount).toISOString() };
  };
  fetchLog.length = 0;

  getById('msg-input').value = 'written on the laptop';
  await view.flushConversationDraft(convId);

  const patches = draftPatches(convId);
  assert.equal(patches.length, 2, 'the rejected save is retried once');
  assert.equal(patches[0].baseDraftUpdatedAt, SERVER_DRAFT_V1);
  assert.equal(patches[1].baseDraftUpdatedAt, SERVER_DRAFT_V2, 'the retry is based on the conflicting server version');
  assert.equal(patches[1].draftText, 'written on the laptop');
  assert.equal(getById('msg-input').value, 'written on the laptop', 'the local edit stays in the composer');

  const toast = getById('relay-toast');
  assert.ok(toast.classList.contains('has-action'), 'the toast offers an action');
  const restore = toast.children.find((child) => child.className === 'relay-toast-action');
  assert.ok(restore, 'a Restore button is shown');
  restore.listeners.click[0]();
  await settle();
  assert.equal(getById('msg-input').value, 'written on the phone', 'Restore puts the other device\'s text back');
  const restored = draftPatches(convId).at(-1);
  assert.equal(restored.draftText, 'written on the phone', 'and saves it');
  resetComposer('');
});

test('draft sync: a conflict against an unchanged composer silently adopts the server draft', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'same', SERVER_DRAFT_V1);
  fetchHandler = async (url) => {
    if (!url.includes(`/api/conversation/${convId}/draft`)) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: false,
      conflict: true,
      code: 'draft-version-conflict',
      draftText: 'newer remote text',
      draftAttachments: [],
      draftUpdatedAt: SERVER_DRAFT_V2,
    };
  };
  fetchLog.length = 0;
  getById('relay-toast').children = [];

  // The user types and then undoes back to the synced text while the save is
  // in flight; the conflict finds the composer unmodified.
  getById('msg-input').value = 'same plus';
  const save = view.flushConversationDraft(convId);
  getById('msg-input').value = 'same';
  await save;

  assert.equal(draftPatches(convId).length, 1, 'no retry');
  assert.equal(getById('msg-input').value, 'newer remote text');
  assert.equal(getById('relay-toast').children.length, 0, 'no restore toast');
  resetComposer('');
});

function latestToastAction() {
  const actions = getById('relay-toast').children.filter((child) => child.className === 'relay-toast-action');
  return actions.at(-1) || null;
}

function conflictPayload(text, version, attachments = []) {
  return { ok: false, conflict: true, code: 'draft-version-conflict', draftText: text, draftAttachments: attachments, draftUpdatedAt: version };
}

test('draft sync: Restore is a swap that can be undone', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'base text', SERVER_DRAFT_V1);
  let patchCount = 0;
  fetchHandler = async (url, opts) => {
    if (!url.includes(`/api/conversation/${convId}/draft`)) throw new Error(`unexpected fetch: ${url}`);
    patchCount += 1;
    if (patchCount === 1) return conflictPayload('phone text', SERVER_DRAFT_V2);
    const body = JSON.parse(opts.body);
    return { ok: true, draftText: body.draftText, draftAttachments: [], draftUpdatedAt: new Date(Date.now() + patchCount * 1000).toISOString() };
  };
  getById('msg-input').value = 'laptop text';
  await view.flushConversationDraft(convId);

  latestToastAction().listeners.click[0]();
  await settle();
  assert.equal(getById('msg-input').value, 'phone text');
  const undo = latestToastAction();
  assert.equal(undo.textContent, 'Undo', 'the restore offers its own reversal');
  undo.listeners.click[0]();
  await settle();
  assert.equal(getById('msg-input').value, 'laptop text', 'Undo brings the winning edit back');
  assert.equal(draftPatches(convId).at(-1).draftText, 'laptop text', 'and saves it');
  resetComposer('');
});

test('draft sync: an attachment-only losing draft is still offered back', async () => {
  const convId = nextId('conv-sync');
  const laptopShot = { sha256: 'a'.repeat(64), name: 'laptop.png', type: 'image/png', size: 10 };
  conversations[convId] = { id: convId, title: 'Sync' };
  setCurrentConv(convId);
  resetComposer('');
  view.hydrateConversationDraft(convId, { draftText: 'caption', draftAttachments: [laptopShot], draftUpdatedAt: SERVER_DRAFT_V1 });
  const phoneShot = [{ sha256: 'c'.repeat(64), name: 'phone.png', type: 'image/png', size: 10 }];
  getById('relay-toast').children = [];
  let patchCount = 0;
  fetchHandler = async (url, opts) => {
    patchCount += 1;
    if (patchCount === 1) return conflictPayload('caption', SERVER_DRAFT_V2, phoneShot);
    const body = JSON.parse(opts.body);
    return { ok: true, draftText: body.draftText, draftAttachments: body.draftAttachments ?? [], draftUpdatedAt: new Date(Date.now() + 5000).toISOString() };
  };
  // The laptop removes its screenshot while the phone swapped in another one.
  store.selectedAttachments.length = 0;
  await view.persistComposerAttachments();

  const restore = latestToastAction();
  assert.ok(restore, 'the phone\'s screenshot can be restored');
  restore.listeners.click[0]();
  await settle();
  assert.deepEqual(
    draftPatches(convId).at(-1).draftAttachments.map((row) => row.sha256),
    [phoneShot[0].sha256],
    'Restore saves the losing attachments too',
  );
  resetComposer('');
});

test('draft sync: a plain notice over the Restore toast hands the toast back', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'base', SERVER_DRAFT_V1);
  getById('relay-toast').children = [];
  let patchCount = 0;
  fetchHandler = async (url, opts) => {
    patchCount += 1;
    if (patchCount === 1) return conflictPayload('theirs', SERVER_DRAFT_V2);
    return { ok: true, draftText: JSON.parse(opts.body).draftText, draftAttachments: [], draftUpdatedAt: new Date(Date.now() + 5000).toISOString() };
  };
  getById('msg-input').value = 'mine';
  await view.flushConversationDraft(convId);
  const toast = getById('relay-toast');
  assert.ok(toast.classList.contains('has-action'));

  store.showTransientRelayNotice('Something unrelated happened.', 1500);
  assert.ok(!toast.classList.contains('has-action'), 'the plain notice covers the toast');
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.ok(toast.classList.contains('has-action'), 'the Restore toast comes back afterwards');
  latestToastAction().listeners.click[0]();
  await settle();
  assert.equal(getById('msg-input').value, 'theirs', 'and still restores the losing draft');
  resetComposer('');
});

test('draft sync: a refresh after a failed save never reverts the unsaved edit, and the edit is re-saved', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'saved text', SERVER_DRAFT_V1);
  let online = false;
  fetchHandler = async (url, opts) => {
    if (!online) throw new Error('relay restarting');
    return { ok: true, draftText: JSON.parse(opts.body).draftText, draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V2 };
  };
  fetchLog.length = 0;

  // The blur flush dies with the relay.
  getById('msg-input').value = 'saved text plus an unsaved edit';
  await view.flushConversationDraft(convId);
  online = true;

  // Reconnect/foreground refresh: the same, older server draft comes back.
  view.hydrateConversationDraft(convId, {
    draftText: 'saved text',
    draftAttachments: [],
    draftUpdatedAt: SERVER_DRAFT_V1,
    draftUpdatedByClientId: 'other-device',
  });
  assert.equal(getById('msg-input').value, 'saved text plus an unsaved edit', 'the edit is not reverted');

  await new Promise((resolve) => setTimeout(resolve, 600));
  const retried = draftPatches(convId).at(-1);
  assert.equal(retried.draftText, 'saved text plus an unsaved edit', 'the edit is saved once the relay is back');
  assert.equal(retried.baseDraftUpdatedAt, SERVER_DRAFT_V1);
  resetComposer('');
});

test('draft sync: a conversation switch empties the composer and holds saves until the new draft lands', async () => {
  const convA = nextId('conv-switch-a');
  const convB = nextId('conv-switch-b');
  openWithServerDraft(convA, 'draft of A', SERVER_DRAFT_V1);
  conversations[convB] = { id: convB, title: 'B' };
  view.hydrateConversationDraft(convB, { draftText: 'draft of B', draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V1 });
  fetchHandler = async (url) => { throw new Error(`unexpected fetch: ${url}`); };
  fetchLog.length = 0;
  const input = getById('msg-input');
  document.activeElement = input;

  // What openConversation does after flushing A, then a programmatic switch
  // (push notification, compaction) while the composer keeps focus.
  view.beginConversationDraftSwitch(convB);
  setCurrentConv(convB);
  assert.equal(input.value, '', 'A\'s text is gone from the composer');
  await view.flushConversationDraft(convB);
  view.syncComposerAfterUserEdit();
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(draftPatches(convB), [], 'nothing is saved under B before B\'s draft arrives');

  view.hydrateConversationDraft(convB, { draftText: 'draft of B', draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V1 });
  assert.equal(input.value, 'draft of B', 'the focused composer takes B\'s draft');
  document.activeElement = null;
  resetComposer('');
});

test('draft sync: typing into a just-switched composer before its draft lands keeps the typing and offers the draft back', async () => {
  const convB = nextId('conv-switch-b');
  conversations[convB] = { id: convB, title: 'B' };
  setCurrentConv(convB);
  resetComposer('');
  getById('relay-toast').children = [];
  fetchHandler = async (url, opts) => ({ ok: true, draftText: JSON.parse(opts.body).draftText, draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V2 });
  fetchLog.length = 0;

  view.beginConversationDraftSwitch(convB);
  getById('msg-input').value = 'typed right away';
  view.hydrateConversationDraft(convB, { draftText: 'saved draft of B', draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V1 });

  assert.equal(getById('msg-input').value, 'typed right away');
  assert.ok(latestToastAction(), 'B\'s saved draft is offered back');
  await new Promise((resolve) => setTimeout(resolve, 600));
  const saved = draftPatches(convB).at(-1);
  assert.equal(saved.draftText, 'typed right away');
  assert.equal(saved.baseDraftUpdatedAt, SERVER_DRAFT_V1, 'based on the draft it replaces');
  resetComposer('');
});

test('draft sync: a remote draft deferred while typing is surfaced when the typing is undone', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'shared', SERVER_DRAFT_V1);
  const input = getById('msg-input');
  let patchCount = 0;
  fetchHandler = async (url, opts) => {
    patchCount += 1;
    // Every save of this client was based on V1; the server holds V2.
    const body = JSON.parse(opts.body);
    if (body.baseDraftUpdatedAt === SERVER_DRAFT_V1) return conflictPayload('phone edit', SERVER_DRAFT_V2);
    return { ok: true, draftText: body.draftText, draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V2 };
  };
  fetchLog.length = 0;

  // Mid-typing, the phone's draft arrives and is deferred…
  input.value = 'shared + typing';
  view.applyIncomingConversationDraftUpdate({
    conversationId: convId, draftText: 'phone edit', draftAttachments: [], draftUpdatedAt: SERVER_DRAFT_V2, senderClientId: 'phone',
  });
  assert.equal(input.value, 'shared + typing');
  // …then the typing is undone back to the synced text before any save ran.
  input.value = 'shared';
  await view.flushConversationDraft(convId);

  assert.ok(draftPatches(convId).length >= 1, 'the undo is not treated as a no-op against the stale base');
  assert.equal(input.value, 'phone edit', 'the phone\'s draft is shown instead of silently kept away');
  resetComposer('');
});

test('draft sync: a second lost race schedules a retry instead of leaving the edit unsaved', async () => {
  const convId = nextId('conv-sync');
  openWithServerDraft(convId, 'base', SERVER_DRAFT_V1);
  const V3 = '2026-09-24T09:07:00.000Z';
  let patchCount = 0;
  fetchHandler = async (url, opts) => {
    patchCount += 1;
    const body = JSON.parse(opts.body);
    if (patchCount === 1) return conflictPayload('phone 1', SERVER_DRAFT_V2);
    if (patchCount === 2) return conflictPayload('phone 2', V3);
    if (body.baseDraftUpdatedAt !== V3) return conflictPayload('phone 2', V3);
    return { ok: true, draftText: body.draftText, draftAttachments: [], draftUpdatedAt: '2026-09-24T09:09:00.000Z' };
  };
  fetchLog.length = 0;

  getById('msg-input').value = 'laptop edit';
  await view.flushConversationDraft(convId);
  await new Promise((resolve) => setTimeout(resolve, 700));

  const last = draftPatches(convId).at(-1);
  assert.equal(last.draftText, 'laptop edit', 'the edit is eventually saved');
  assert.equal(last.baseDraftUpdatedAt, V3);
  assert.equal(conversations[convId].draftUpdatedAt, '2026-09-24T09:09:00.000Z');
  resetComposer('');
});

test('draft sync: the post-send save keeps text typed while the send was in flight', async () => {
  const convId = nextId('conv-draft');
  const runningId = primeQueuedSend(convId, 'first message');
  const post = deferred();
  stubQueuedSendFetches(convId, post.promise);

  const sendPromise = view.sendMessage();
  await settle();
  getById('msg-input').value = 'next message, typed during the send';
  post.resolve({ conversationId: convId, messageId: nextId('srv') });
  await sendPromise;

  const cleared = draftPatches(convId).at(-1);
  assert.equal(cleared.draftText, 'next message, typed during the send', 'the post-send save does not wipe the new typing');
  assert.equal(getById('msg-input').value, 'next message, typed during the send');
  view.applyConversationTurnStatus({ conversationId: convId, messageId: runningId, status: 'done' });
  resetComposer('');
});

test('renderMessages re-renders when only a message\'s workflowRuns change', () => {
  const convId = nextId('conv-wr');
  conversations[convId] = { id: convId, title: 'WR' };
  setCurrentConv(convId);
  const msg = makeMessage(nextId('msg-wr'), { role: 'assistant' });
  assert.equal(view.renderMessages([msg], false, { conversationId: convId }), true, 'first paint renders');
  assert.equal(view.renderMessages([msg], false, { conversationId: convId }), false, 'an identical payload short-circuits');

  const run = { runId: 'wf_snap_1', status: 'completed', agentCount: 2, agents: [] };
  const withRun = { ...msg, workflowRuns: [run] };
  assert.equal(view.renderMessages([withRun], false, { conversationId: convId }), true, 'a runs-only difference re-renders');
  assert.equal(view.renderMessages([withRun], false, { conversationId: convId }), false, 'the run-bearing payload then settles');
  assert.equal(
    view.renderMessages([{ ...msg, workflowRuns: [{ ...run, status: 'failed' }] }], false, { conversationId: convId }),
    true,
    'a run status change re-renders too',
  );
});
