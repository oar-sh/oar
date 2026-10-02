import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// The relay's note while a session's worker cannot be started, on the real
// index.html in JSDOM (see conversation-view.transcript-dom.test.mjs for the
// harness): the note renders as a notice, is rewritten in place without
// moving, carries Retry only once the relay has stopped trying, and Retry asks
// the relay for a launch of this conversation's session.
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
const fetchLog = [];
// Opening a conversation fires unrelated reads (relay boards); they answer
// empty, and the assertions look at launch calls only.
let fetchHandler = async () => ({});
globalThis.fetch = async (url, opts = {}) => {
  const entry = { url: String(url), method: String(opts.method || 'GET'), body: opts.body ? JSON.parse(opts.body) : null };
  fetchLog.push(entry);
  const payload = await fetchHandler(entry.url, entry);
  return { ok: true, status: 200, json: async () => payload };
};
const store = await import('./store.js');
const view = await import('./conversation-view.js');
const { conversations, setCurrentConv } = store;
const messagesEl = document.getElementById('messages');
view.initBubbleActionHandlers();

const T0 = Date.parse('2026-10-01T14:44:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const rowIds = () => [...messagesEl.querySelectorAll(':scope > .msg')].map((node) => node.dataset.messageId);
const row = (id) => messagesEl.querySelector(`:scope > .msg[data-message-id="${id}"]`);
const retryButton = (id) => row(id)?.querySelector('.bubble-action-btn[data-action="retry-worker-launch"]') || null;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const launchCalls = () => fetchLog.filter((entry) => entry.url.includes('/api/session-worker/')).map((entry) => [entry.method, entry.url]);

test('the worker-launch note is rewritten in place and carries Retry only once the relay has stopped', async () => {
  messagesEl.innerHTML = '';
  fetchLog.length = 0;
  const conv = 'conv-note';
  conversations[conv] = { id: conv, title: 'Note', runtimeProviderType: 'claude', sdkSessionId: 'sess-note' };
  setCurrentConv(conv);

  view.appendMessage({ role: 'user', text: 'hello?', timestamp: at(0) }, false, 'user-1');
  view.appendMessage({
    role: 'assistant',
    kind: 'worker-launch-failed',
    text: '⚠️ The worker for this conversation could not be started (6 tries). Cause: windows-process-snapshot-unreadable. Your message stays queued; the relay tries again every 1 minute until 14:54 UTC.',
    timestamp: at(51),
  }, false, 'note-1');
  view.appendMessage({ role: 'user', text: 'still there?', timestamp: at(120) }, false, 'user-2');

  assert.deepEqual(rowIds(), ['user-1', 'note-1', 'user-2']);
  assert.ok(row('note-1').classList.contains('msg-worker-launch'), 'the note is marked as the relay\'s notice');
  assert.equal(retryButton('note-1'), null, 'no Retry while the relay keeps trying');

  // Stopped: same id, same place, now with Retry.
  const replaced = view.replaceRenderedMessage({
    role: 'assistant',
    kind: 'worker-launch-stopped',
    text: '⛔ The worker for this conversation could not be started; the relay stopped trying after 10 minutes (16 tries). Cause: windows-process-snapshot-unreadable. Your message stays queued — press Retry once the cause is fixed.',
    timestamp: at(51),
  }, 'note-1');
  assert.equal(replaced, true);
  assert.deepEqual(rowIds(), ['user-1', 'note-1', 'user-2'], 'the note keeps its place');
  assert.match(row('note-1').textContent, /stopped trying after 10 minutes/);
  assert.ok(row('note-1').classList.contains('msg-worker-launch-stopped'));
  const retry = retryButton('note-1');
  assert.ok(retry, 'Retry is offered once the relay has stopped');

  // Retry asks the relay to launch this conversation's session.
  fetchHandler = async (url, { method }) => (
    (method === 'POST' && url.endsWith('/api/session-worker/sess-note/launch')) ? { ok: true, reused: false } : {}
  );
  retry.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.deepEqual(launchCalls(), [['POST', '/api/session-worker/sess-note/launch']]);
  assert.equal(retry.disabled, true);
  assert.equal(retry.textContent, 'Retrying…');

  // Started: the relay rewrites the note once more; the button is gone.
  view.replaceRenderedMessage({
    role: 'assistant',
    kind: 'worker-launch-started',
    text: '✅ The worker for this conversation started at 15:40 UTC. The queued message is being delivered.',
    timestamp: at(51),
  }, 'note-1');
  assert.deepEqual(rowIds(), ['user-1', 'note-1', 'user-2']);
  assert.equal(retryButton('note-1'), null);
  assert.ok(row('note-1').classList.contains('msg-worker-launch-started'));

  // A message that is not on the page is reported, not invented.
  assert.equal(view.replaceRenderedMessage({ role: 'assistant', text: 'x', timestamp: at(1) }, 'absent'), false);
});

test('a refused launch re-arms Retry and tells the user', async () => {
  messagesEl.innerHTML = '';
  fetchLog.length = 0;
  const conv = 'conv-note-2';
  conversations[conv] = { id: conv, title: 'Note', runtimeProviderType: 'claude', sdkSessionId: 'sess-note-2' };
  setCurrentConv(conv);
  view.appendMessage({ role: 'assistant', kind: 'worker-launch-stopped', text: '⛔ stopped', timestamp: at(0) }, false, 'note-2');
  fetchHandler = async (url) => (url.includes('/api/session-worker/') ? { ok: false, error: 'spawn-failed' } : {});
  const retry = retryButton('note-2');
  retry.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  await flush();
  assert.equal(launchCalls().length, 1);
  assert.equal(retry.disabled, false, 'the button is armed again');
  assert.equal(retry.textContent, 'Retry');
});
