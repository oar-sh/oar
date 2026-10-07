import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stand-in (same pattern as background-tasks-view.test.mjs): the
// header button, the summary modal's parts and the toast, by id; the pin
// buttons and bubbles of the transcript, by what the tests put on the page.
class FakeClassList {
  constructor() { this.names = new Set(); }
  add(...names) { for (const name of names) this.names.add(name); }
  remove(...names) { for (const name of names) this.names.delete(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : !!force;
    if (on) this.names.add(name); else this.names.delete(name);
    return on;
  }
  contains(name) { return this.names.has(name); }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList();
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.innerHTML = '';
    this.children = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  querySelector(selector) { return this.children[selector] || null; }
  querySelectorAll() { return []; }
  remove() {}
}

const elements = new Map();
function el(id) {
  if (!elements.has(id)) elements.set(id, new FakeElement(id));
  return elements.get(id);
}
const headerButton = el('pinned-messages-btn');
headerButton.hidden = true;
headerButton.children['.header-icon-count'] = new FakeElement();
const countEl = headerButton.children['.header-icon-count'];

// What is "on the page": message ids with a bubble, and their pin buttons.
const page = { bubbles: new Set(), pinButtons: new Map() };

globalThis.window = {
  location: { pathname: '/' },
  innerHeight: 0,
  addEventListener() {},
};
globalThis.document = {
  documentElement: { clientHeight: 0, style: { setProperty() {} } },
  addEventListener() {},
  getElementById: (id) => el(id),
  createElement: () => new FakeElement(),
  querySelector(selector) {
    const pinButton = selector.match(/^\.msg-pin-btn\[data-message-id="(.+)"\]$/);
    if (pinButton) return page.pinButtons.get(pinButton[1]) || null;
    const bubble = selector.match(/^#messages \.msg\[data-message-id="(.+)"\]$/);
    if (bubble) return page.bubbles.has(bubble[1]) ? new FakeElement() : null;
    if (selector === '#messages .msg[data-message-id]') return page.bubbles.size ? new FakeElement() : null;
    return null;
  },
};
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };
globalThis.CSS = { escape: (value) => String(value) };
globalThis.Element = FakeElement;
// The toast hides itself on a timer; a real one would outlive the tests.
globalThis.setTimeout = () => 0;

let fetchHandler = async () => ({ ok: true, status: 200, json: async () => ({}) });
const fetchCalls = [];
globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
  return fetchHandler(url, options);
};

const { summaryModalState, closeSummaryModal } = await import('./store.js');
const {
  PINNED_MESSAGES_MODAL_KIND,
  getConversationPins,
  initPinnedMessagesView,
  isMessagePinned,
  jumpToPinnedMessage,
  openPinnedMessagesModal,
  pinnedCountLabel,
  renderPinnedListHtml,
  setConversationPins,
  setPinsConversation,
  toggleMessagePin,
} = await import('./pinned-messages-view.mjs');

const syncedPinSets = [];
const focusCalls = [];
const openCalls = [];
let focusResult = false;
let onOpenConversation = () => {};
initPinnedMessagesView({
  openConversation: async (id, options) => {
    openCalls.push({ id, options });
    await onOpenConversation(id, options);
  },
  focusMessage: (id) => { focusCalls.push(id); return focusResult; },
  syncRenderedPinState: (ids) => { syncedPinSets.push([...ids].sort()); },
});

function pin(messageId, overrides = {}) {
  return {
    messageId,
    role: 'assistant',
    preview: `preview of ${messageId}`,
    timestamp: '2026-10-05T10:00:00.000Z',
    pinnedAt: '2026-10-05T11:00:00.000Z',
    attachmentCount: 0,
    hiddenFromShares: false,
    ...overrides,
  };
}

function resetPage() {
  page.bubbles.clear();
  page.pinButtons.clear();
  fetchCalls.length = 0;
  syncedPinSets.length = 0;
  focusCalls.length = 0;
  openCalls.length = 0;
  focusResult = false;
  onOpenConversation = () => {};
  closeSummaryModal();
  el('relay-toast').textContent = '';
}

function json(status, body) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function clickInModal(attribute, messageId) {
  const target = new FakeElement();
  target.closest = (selector) => (selector === `[${attribute}]` ? target : null);
  target.setAttribute(attribute, messageId);
  for (const handler of el('summary-modal-body').listeners.click || []) {
    handler({ target, preventDefault() {} });
  }
}

test('the list shows role, attachments, the hidden chip and the preview, in the order given', () => {
  const html = renderPinnedListHtml([
    pin('msg-1', { role: 'user', preview: 'How do I tag the build?', attachmentCount: 2, hiddenFromShares: true }),
    pin('msg-2', { preview: 'Run the tag script.' }),
  ]);

  assert.ok(html.indexOf('data-pin-jump="msg-1"') < html.indexOf('data-pin-jump="msg-2"'));
  assert.match(html, /<span class="pinned-row-meta">You · [^<]*📎 2 · <span class="pinned-row-chip">hidden from shared<\/span><\/span>/);
  assert.match(html, /<span class="pinned-row-meta">Agent · [^<]*<\/span>\s*<span class="pinned-row-preview">Run the tag script\.<\/span>/);
  assert.match(html, /class="pinned-row-unpin" data-pin-unpin="msg-2" title="Unpin" aria-label="Unpin">🗑<\/button>/);
});

test('the list escapes what a message says and what its id is', () => {
  const html = renderPinnedListHtml([pin('id"><img>', { preview: '<script>alert(1)</script> & more' })]);

  assert.doesNotMatch(html, /<script>|<img>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more/);
  assert.match(html, /data-pin-jump="id&quot;&gt;&lt;img&gt;"/);
});

test('an attachment-only message and an empty list say so', () => {
  assert.match(renderPinnedListHtml([pin('msg-1', { preview: '' })]), /<span class="pinned-row-no-text">\(no text\)<\/span>/);
  assert.match(renderPinnedListHtml([]), /No pinned messages\. Use Pin on a message to add one\./);
  assert.match(renderPinnedListHtml(null), /pinned-empty/);
  assert.equal(pinnedCountLabel(0), '');
  assert.equal(pinnedCountLabel(3), '3 pinned');
});

test('the header button shows only with pins, and carries their count', () => {
  resetPage();
  setPinsConversation('conv-a');
  assert.equal(headerButton.hidden, true);

  setConversationPins('conv-a', [pin('msg-1'), pin('msg-2')]);
  assert.equal(headerButton.hidden, false);
  assert.equal(countEl.textContent, '2');
  assert.equal(headerButton.getAttribute('aria-label'), 'Pinned messages (2)');
  assert.deepEqual(syncedPinSets.at(-1), ['msg-1', 'msg-2']);
  assert.equal(isMessagePinned('conv-a', 'msg-2'), true);
  assert.equal(isMessagePinned('conv-a', 'msg-9'), false);

  setConversationPins('conv-a', []);
  assert.equal(headerButton.hidden, true);
  assert.equal(countEl.textContent, '');
  assert.deepEqual(syncedPinSets.at(-1), []);
});

test('pins are kept per conversation; another conversation\'s update leaves the open view alone', () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-1')]);
  syncedPinSets.length = 0;

  setConversationPins('conv-b', [pin('other-1'), pin('other-2'), pin('other-3')]);
  assert.equal(countEl.textContent, '1');
  assert.equal(syncedPinSets.length, 0, 'the open transcript was not touched');
  assert.equal(getConversationPins('conv-b').length, 3);

  setPinsConversation('conv-b');
  assert.equal(countEl.textContent, '3');
  assert.deepEqual(syncedPinSets.at(-1), ['other-1', 'other-2', 'other-3']);
});

test('an unchanged list does not redraw the open modal (it arrives with every poll)', () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-1')]);
  openPinnedMessagesModal();
  assert.equal(summaryModalState.kind, PINNED_MESSAGES_MODAL_KIND);
  assert.equal(el('summary-modal-title').textContent, '📍 Pinned messages');
  assert.equal(el('summary-modal-subtitle').textContent, '1 pinned');
  assert.match(el('summary-modal-body').innerHTML, /data-pin-jump="msg-1"/);

  el('summary-modal-body').innerHTML = 'untouched';
  syncedPinSets.length = 0;
  setConversationPins('conv-a', [pin('msg-1')]);
  setPinsConversation('conv-a');
  assert.equal(el('summary-modal-body').innerHTML, 'untouched');
  assert.equal(syncedPinSets.length, 0);

  setConversationPins('conv-a', [pin('msg-1'), pin('msg-2')]);
  assert.match(el('summary-modal-body').innerHTML, /data-pin-jump="msg-2"/);
  assert.equal(el('summary-modal-subtitle').textContent, '2 pinned');
});

test('an older list never replaces a newer one, in whatever order they arrive', () => {
  resetPage();
  setPinsConversation('conv-rev');
  // The pin's own event first, then a load that left the relay before it.
  setConversationPins('conv-rev', [pin('msg-1')], 1700000000500);
  setConversationPins('conv-rev', [], 1700000000100);
  assert.equal(countEl.textContent, '1');
  assert.equal(isMessagePinned('conv-rev', 'msg-1'), true);

  // The same revision again (the next poll) and a newer one are both taken.
  setConversationPins('conv-rev', [pin('msg-1')], 1700000000500);
  setConversationPins('conv-rev', [], 1700000000900);
  assert.equal(headerButton.hidden, true);

  // A list without a revision (an older relay) is taken as it comes.
  setConversationPins('conv-rev', [pin('msg-2')]);
  assert.equal(countEl.textContent, '1');
  assert.equal(isMessagePinned('conv-rev', 'msg-2'), true);
});

test('closing the conversation closes its list and hides the button', () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-1')]);
  openPinnedMessagesModal();

  setPinsConversation(null);

  assert.equal(summaryModalState.kind, '');
  assert.equal(headerButton.hidden, true);
  assert.equal(getConversationPins('conv-a').length, 1, 'kept for when it is opened again');
});

test('pinning sends the opposite of what the control showed and applies the answer', async () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', []);
  const button = new FakeElement();
  page.pinButtons.set('msg-1', button);
  let seenWhileInFlight = null;
  fetchHandler = async () => {
    seenWhileInFlight = { disabled: button.disabled, text: button.textContent };
    return json(200, { ok: true, conversationId: 'conv-a', messageId: 'msg-1', pinned: true, pins: [pin('msg-1')] })();
  };

  await toggleMessagePin('conv-a', 'msg-1', false);

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/conversation\/conv-a\/message\/msg-1\/pin$/);
  assert.equal(fetchCalls[0].method, 'PATCH');
  assert.deepEqual(fetchCalls[0].body, { pinned: true });
  assert.deepEqual(seenWhileInFlight, { disabled: true, text: 'Pinning…' });
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Unpin');
  assert.equal(countEl.textContent, '1');
  assert.equal(el('relay-toast').textContent, 'Message pinned.');
});

test('a refusal restores the control and shows the relay\'s reason', async () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', []);
  const button = new FakeElement();
  page.pinButtons.set('msg-1', button);
  fetchHandler = json(409, { error: 'This conversation already has 100 pinned messages. Unpin one first.', code: 'pin-limit' });

  await toggleMessagePin('conv-a', 'msg-1', false);

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Pin');
  assert.equal(headerButton.hidden, true);
  assert.equal(el('relay-toast').textContent, 'This conversation already has 100 pinned messages. Unpin one first.');

  fetchHandler = async () => { throw new Error('offline'); };
  await toggleMessagePin('conv-a', 'msg-1', false);
  assert.equal(el('relay-toast').textContent, 'Could not pin the message.');
});

test('a second press while the first is in flight sends nothing', async () => {
  resetPage();
  setPinsConversation('conv-a');
  let release;
  fetchHandler = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, pinned: true, pins: [pin('msg-1')] }) });
  });

  const first = toggleMessagePin('conv-a', 'msg-1', false);
  await toggleMessagePin('conv-a', 'msg-1', false);
  assert.equal(fetchCalls.length, 1);
  release();
  await first;
});

test('an answer that arrives after a conversation switch does not touch the new conversation', async () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', []);
  setConversationPins('conv-b', [pin('other-1')]);
  // Same message id on the new page would be a different bubble: leave it.
  const strangerButton = new FakeElement();
  strangerButton.textContent = 'Pin';
  let release;
  fetchHandler = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, pinned: true, pins: [pin('msg-1')] }) });
  });

  const pending = toggleMessagePin('conv-a', 'msg-1', false);
  setPinsConversation('conv-b');
  page.pinButtons.set('msg-1', strangerButton);
  syncedPinSets.length = 0;
  release();
  await pending;

  assert.equal(countEl.textContent, '1', 'still the open conversation\'s count');
  assert.equal(strangerButton.textContent, 'Pin');
  assert.equal(syncedPinSets.length, 0);
  assert.deepEqual(getConversationPins('conv-a').map((item) => item.messageId), ['msg-1'], 'kept for when it is opened again');
});

test('the trash in a row unpins that message', async () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-1'), pin('msg-2')]);
  openPinnedMessagesModal();
  fetchHandler = json(200, { ok: true, pinned: false, pins: [pin('msg-2')] });

  clickInModal('data-pin-unpin', 'msg-1');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fetchCalls[0].body, { pinned: false });
  assert.match(fetchCalls[0].url, /\/message\/msg-1\/pin$/);
  assert.doesNotMatch(el('summary-modal-body').innerHTML, /data-pin-jump="msg-1"/);
  assert.match(el('summary-modal-body').innerHTML, /data-pin-jump="msg-2"/);
  assert.equal(summaryModalState.kind, PINNED_MESSAGES_MODAL_KIND, 'the list stays open');
  assert.equal(el('relay-toast').textContent, 'Message unpinned.');
});

test('a click in another modal\'s body is none of this module\'s business', () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-1')]);
  summaryModalState.kind = 'context';

  clickInModal('data-pin-unpin', 'msg-1');
  clickInModal('data-pin-jump', 'msg-1');

  assert.equal(fetchCalls.length, 0);
  assert.equal(focusCalls.length, 0);
  summaryModalState.kind = '';
});

test('a row for a message on the page closes the list and scrolls there', async () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-1')]);
  openPinnedMessagesModal();
  focusResult = true;

  clickInModal('data-pin-jump', 'msg-1');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(summaryModalState.kind, '', 'the modal is closed');
  assert.deepEqual(focusCalls, ['msg-1']);
  assert.equal(openCalls.length, 0, 'nothing is reloaded for a message already loaded');
});

test('a row for a message outside the loaded history loads the window around it', async () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-old')]);
  onOpenConversation = () => { page.bubbles.add('msg-old'); };

  await jumpToPinnedMessage('msg-old');

  assert.deepEqual(openCalls, [{ id: 'conv-a', options: { aroundMessageId: 'msg-old', focusMessageId: 'msg-old' } }]);
  assert.equal(el('relay-toast').textContent, '');
});

test('a message the relay no longer has: a notice, and the end of the conversation comes back', async () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-gone')]);

  await jumpToPinnedMessage('msg-gone');

  assert.equal(el('relay-toast').textContent, 'That message is no longer in this conversation.');
  assert.equal(openCalls.length, 2);
  assert.deepEqual(openCalls[1], { id: 'conv-a', options: undefined });
});

test('a window that loaded without the bubble (merged into a neighbour) is left in place', async () => {
  resetPage();
  setPinsConversation('conv-a');
  setConversationPins('conv-a', [pin('msg-merged')]);
  onOpenConversation = () => { page.bubbles.add('msg-neighbour'); };

  await jumpToPinnedMessage('msg-merged');

  assert.equal(el('relay-toast').textContent, 'That message is no longer in this conversation.');
  assert.equal(openCalls.length, 1);
});
