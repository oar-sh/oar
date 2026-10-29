import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The service worker's notification tap: a paired relay's card
// opens its session there; this relay's own push opens its conversation here,
// and a choice button answers it here.

const SW_SOURCE = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://relay-a.example.test/';

function loadWorker({ windows = [] } = {}) {
  const listeners = new Map();
  const opened = [];
  const fetched = [];
  const self = {
    location: { href: `${SCOPE}sw.js?v=1`, origin: 'https://relay-a.example.test' },
    registration: { scope: SCOPE, showNotification: async () => {} },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { opened.push(url); return null; },
    },
    addEventListener: (type, handler) => listeners.set(type, handler),
  };
  const context = vm.createContext({
    self,
    URL,
    console,
    fetch: async (url, options) => { fetched.push({ url, body: options?.body }); return { ok: true }; },
  });
  vm.runInContext(SW_SOURCE, context);
  async function click(data, action = '') {
    let closed = false;
    let done = null;
    listeners.get('notificationclick')({
      action,
      notification: { data, close: () => { closed = true; } },
      waitUntil: (promise) => { done = promise; },
    });
    await done;
    return closed;
  }
  return { click, opened, fetched };
}

test('a paired relay\'s card opens its session there', async () => {
  const worker = loadWorker();
  const closed = await worker.click({ type: 'question', url: 'https://relay-b.example.test/?conv=conv-1', remoteRelayId: 'r-b', tag: 'remote-r-b-q1' });
  assert.equal(closed, true);
  assert.deepEqual(worker.opened, ['https://relay-b.example.test/?conv=conv-1']);
  assert.deepEqual(worker.fetched, [], 'nothing is answered');
});

test('a link that is no http(s) one is not opened; this relay opens instead', async () => {
  const worker = loadWorker();
  await worker.click({ type: 'question', url: 'javascript:alert(1)' });
  assert.deepEqual(worker.opened, [SCOPE]);
});

test('this relay\'s own question opens its conversation here, and a choice answers it here', async () => {
  const worker = loadWorker();
  await worker.click({ type: 'question', questionId: 'q1', conversationId: 'conv-9', choices: ['Allow', 'Deny'] });
  assert.deepEqual(worker.opened, [`${SCOPE}?push_conv=conv-9`]);
  await worker.click({ type: 'question', questionId: 'q1', conversationId: 'conv-9', choices: ['Allow', 'Deny'] }, 'choice-1');
  assert.deepEqual(worker.fetched, [{ url: `${SCOPE}api/relay-question/q1/answer`, body: JSON.stringify({ answer: 'Deny' }) }]);
  assert.equal(worker.opened.length, 1, 'an answer that landed opens nothing');
});
