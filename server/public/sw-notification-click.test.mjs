import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The service worker's notification tap: a paired relay's card
// opens its session there; this relay's own push opens its conversation here,
// and a choice button answers it here.

const SW_SOURCE = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://relay-a.example.test/';
// A made-up key of the right shape; compared, never printed.
const KEY = `oark1_${'k'.repeat(43)}`;


// The page's IndexedDB copy of the session's proof key, as far as the worker
// reads it (app/session-proof.mjs writes it).
function fakeIndexedDb(entries = new Map()) {
  const stores = new Map();
  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: (name) => stores.has(name) },
          createObjectStore: (name) => { stores.set(name, entries); },
          transaction: (name) => ({
            objectStore: () => ({
              get: (key) => {
                const read = {};
                queueMicrotask(() => { read.result = stores.get(name)?.get(key); read.onsuccess?.(); });
                return read;
              },
            }),
          }),
          close() {},
        };
        request.result = db;
        if (!stores.size) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function loadWorker({
  windows = [],
  proof = '',
  answer = { ok: true, status: 200, body: {} },
  respond = () => answer,
  maxActions = 2,
} = {}) {
  const listeners = new Map();
  const opened = [];
  const fetched = [];
  const shown = [];
  const notified = [];
  const self = {
    location: { href: `${SCOPE}sw.js?v=1`, origin: 'https://relay-a.example.test' },
    registration: {
      scope: SCOPE,
      showNotification: async (title, options) => { shown.push({ title, options }); notified.push(options?.body); },
    },
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
    queueMicrotask,
    Notification: { maxActions },
    ...(proof ? { indexedDB: fakeIndexedDb(new Map([['current', proof]])) } : {}),
    fetch: async (url, options) => {
      const headers = { ...(options?.headers || {}) };
      fetched.push({
        url,
        body: options?.body,
        method: options?.method || 'GET',
        credentials: options?.credentials,
        headers,
        proof: headers['X-OAR-Session-Proof'] || null,
      });
      const given = respond(url, options) || {};
      const response = { ok: given.ok, status: given.status, json: async () => given.body ?? {}, clone: () => response };
      return response;
    },
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
  async function push(payload) {
    let done = null;
    listeners.get('push')({ data: { json: () => payload }, waitUntil: (promise) => { done = promise; } });
    await done;
  }
  return { click, push, opened, fetched, shown, notified, context };
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
  assert.deepEqual(worker.fetched.map(({ url, body, proof }) => ({ url, body, proof })), [{ url: `${SCOPE}api/relay-question/q1/answer`, body: JSON.stringify({ answer: 'Deny' }), proof: null }]);
  assert.equal(worker.opened.length, 1, 'an answer that landed opens nothing');
});

test('an answer from a notification goes with the cookie only: credentials included, no Authorization header', async () => {
  const worker = loadWorker();
  await worker.click({ type: 'question', questionId: 'q2', conversationId: 'conv-9', choices: ['Allow', 'Deny'] }, 'choice-0');
  assert.equal(worker.fetched.length, 1);
  const [call] = worker.fetched;
  assert.equal(call.method, 'POST');
  assert.equal(call.credentials, 'include');
  assert.equal(Object.keys(call.headers).some((name) => name.toLowerCase() === 'authorization'), false);
  assert.equal(new URL(call.url).origin, 'https://relay-a.example.test', 'its own scope: same-origin');
});

const NEW_SIGNIN_DATA = { type: 'newSignIn', noticeId: 'signin-ev1', count: 1, quiet: false, open: '?settings=security', signOutSessionId: 'bs_new1' };

test('a new sign-in push: "Sign it out" for one browser, and a quiet replacement does not ring again', async () => {
  const worker = loadWorker();
  await worker.push({ title: 'New browser signed in', body: 'Chrome on Android, 192.168.1.20, via a sign-in link. Not you? Sign it out.', tag: 'oar-new-signin', data: NEW_SIGNIN_DATA });
  const first = worker.shown[0].options;
  assert.equal(first.tag, 'oar-new-signin');
  assert.equal(first.renotify, true, 'the first push of a window rings, even over an older one with the same tag');
  assert.equal(first.silent, false, 'the first push of a window is never silent');
  assert.deepEqual([...first.actions].map((entry) => ({ ...entry })), [{ action: 'signout-session', title: 'Sign it out' }]);
  await worker.push({ title: '2 new browsers signed in', body: '…', tag: 'oar-new-signin', data: { ...NEW_SIGNIN_DATA, count: 2, quiet: true, signOutSessionId: undefined } });
  const second = worker.shown[1].options;
  assert.equal(second.renotify, false, 'a later sign-in in the window replaces it without ringing');
  assert.deepEqual([...second.actions], [], 'several browsers: no single one to sign out');
});

test('"Sign it out" sends DELETE for that session with the cookie only, and says what happened', async () => {
  const worker = loadWorker();
  const closed = await worker.click(NEW_SIGNIN_DATA, 'signout-session');
  assert.equal(closed, true);
  assert.equal(worker.fetched.length, 1);
  const [call] = worker.fetched;
  assert.equal(call.url, `${SCOPE}api/auth/sessions/bs_new1`);
  assert.equal(call.method, 'DELETE');
  assert.equal(call.credentials, 'include');
  assert.equal(Object.keys(call.headers).some((name) => name.toLowerCase() === 'authorization'), false);
  assert.match(worker.shown[0].options.body, /^The new browser was signed out\./);
  assert.equal(worker.opened.length, 0);

  const gone = loadWorker({ respond: () => ({ ok: false, status: 404 }) });
  await gone.click(NEW_SIGNIN_DATA, 'signout-session');
  assert.equal(gone.shown[0].options.body, 'That browser was already signed out.');

  const signedOut = loadWorker({ respond: () => ({ ok: false, status: 401 }) });
  await signedOut.click(NEW_SIGNIN_DATA, 'signout-session');
  assert.equal(signedOut.shown[0].options.body, 'Signed out, open OAR');

  // Refused for another reason: Security opens, to do it by hand.
  const refused = loadWorker({ respond: () => ({ ok: false, status: 500 }) });
  await refused.click(NEW_SIGNIN_DATA, 'signout-session');
  assert.deepEqual(refused.opened, [`${SCOPE}?settings=security`]);
});

test('"Sign it out" sends the session\'s proof key from IndexedDB; a refusal for a missing key says "Signed out"', async () => {
  const worker = loadWorker({ proof: KEY });
  await worker.click(NEW_SIGNIN_DATA, 'signout-session');
  assert.equal(worker.fetched.length, 1);
  assert.equal(worker.fetched[0].method, 'DELETE');
  assert.ok(worker.fetched[0].proof === KEY, 'the key goes along with the cookie');
  assert.equal(Object.keys(worker.fetched[0].headers).some((name) => name.toLowerCase() === 'authorization'), false);

  const noKey = loadWorker({ answer: { ok: false, status: 403, body: { code: 'AUTH_SESSION_PROOF' } } });
  await noKey.click(NEW_SIGNIN_DATA, 'signout-session');
  assert.equal(noKey.fetched[0].proof, null);
  assert.deepEqual(noKey.notified, ['Signed out, open OAR']);
  assert.deepEqual(noKey.opened, []);

  // Another 403 (a cross-site refusal, say): Security opens instead.
  const other = loadWorker({ answer: { ok: false, status: 403, body: { code: 'AUTH_CROSS_SITE' } } });
  await other.click(NEW_SIGNIN_DATA, 'signout-session');
  assert.deepEqual(other.notified, []);
  assert.deepEqual(other.opened, [`${SCOPE}?settings=security`]);
});

test('tapping a new sign-in opens Settings → Security: a new window, or the open one told', async () => {
  const worker = loadWorker();
  await worker.click(NEW_SIGNIN_DATA);
  assert.deepEqual(worker.fetched, [], 'a tap signs nothing out');
  assert.deepEqual(worker.opened, [`${SCOPE}?settings=security`]);

  const messages = [];
  const app = { url: `${SCOPE}?conv=conv-1`, focus: async () => {}, postMessage: (message) => messages.push({ ...message }) };
  const open = loadWorker({ windows: [app] });
  await open.click(NEW_SIGNIN_DATA);
  assert.deepEqual(open.opened, []);
  assert.deepEqual(messages, [{ type: 'copilot-open-settings', tab: 'security' }]);

  // Only a Settings link of this app is opened.
  const odd = loadWorker();
  await odd.click({ ...NEW_SIGNIN_DATA, open: 'https://elsewhere.example.test/' });
  assert.deepEqual(odd.opened, [`${SCOPE}?settings=security`]);
});

test('an answer from a notification carries the session\'s proof key from IndexedDB', async () => {
  const worker = loadWorker({ proof: KEY });
  await worker.click({ type: 'question', questionId: 'q2', conversationId: 'conv-2', choices: ['Yes'] }, 'choice-0');
  assert.equal(worker.fetched.length, 1);
  assert.ok(worker.fetched[0].proof === KEY, 'the key goes along with the cookie');
  assert.deepEqual(worker.opened, []);
});

test('an answer refused for a missing or foreign key (403 AUTH_SESSION_PROOF) says "Signed out", like a 401', async () => {
  for (const answer of [{ ok: false, status: 403, body: { code: 'AUTH_SESSION_PROOF' } }, { ok: false, status: 401, body: { code: 'AUTH_SIGNED_OUT' } }]) {
    const worker = loadWorker({ answer });
    await worker.click({ type: 'question', questionId: 'q3', conversationId: 'conv-3', choices: ['Yes'] }, 'choice-0');
    assert.deepEqual(worker.notified, ['Signed out, open OAR'], String(answer.status));
    assert.deepEqual(worker.opened, []);
  }
  // Another refusal (already answered) opens the conversation instead.
  const other = loadWorker({ answer: { ok: false, status: 409, body: {} } });
  await other.click({ type: 'question', questionId: 'q4', conversationId: 'conv-4', choices: ['Yes'] }, 'choice-0');
  assert.deepEqual(other.notified, []);
  assert.deepEqual(other.opened, [`${SCOPE}?push_conv=conv-4`]);
});

test('the outbox replay sends the session\'s proof key too', () => {
  assert.match(SW_SOURCE, /const target = scopeUrl\([^\n]*value\.path[^\n]*\);\s*response = await fetch\(target, \{[\s\S]*?headers: \{ 'Content-Type': 'application\/json', \.\.\.\(await sessionProofHeaders\(target\)\) \},\s*body: value\.body,/);
});

test('the worker sends the key to this relay\'s own api/ only', async () => {
  const worker = loadWorker({ proof: KEY });
  assert.ok((await worker.context.sessionProofHeaders(`${SCOPE}api/relay-question/q1/answer`))['X-OAR-Session-Proof'] === KEY);
  for (const url of [undefined, '', 'https://relay-a.example.test:5173/api/x', 'https://other.example.test/api/x', `${SCOPE}x.png`, `${SCOPE}apix`, `${SCOPE}api/../x.png`]) {
    assert.deepEqual({ ...(await worker.context.sessionProofHeaders(url)) }, {}, String(url));
  }
});

test('the outbox replay keeps a queued send refused for this browser\'s sign-in (401, 403 AUTH_SESSION_PROOF or AUTH_COOKIE_UPGRADE); other 4xx finish it', async () => {
  const { context } = loadWorker();
  const answer = (status, body = {}) => {
    const response = { ok: status >= 200 && status < 300, status, json: async () => body, clone: () => response };
    return response;
  };
  for (const kept of [answer(401, { code: 'AUTH_SIGNED_OUT' }), answer(403, { code: 'AUTH_SESSION_PROOF' }), answer(403, { code: 'AUTH_COOKIE_UPGRADE' }), answer(408), answer(429), answer(503), null]) {
    assert.equal(await context.isFinalSyncResponse(kept), false, String(kept?.status));
  }
  for (const finished of [answer(200), answer(400), answer(403, { code: 'AUTH_PERSON_REQUIRED' }), answer(403), answer(409, { code: 'DUPLICATE_MESSAGE_ID' })]) {
    assert.equal(await context.isFinalSyncResponse(finished), true, String(finished.status));
  }
});

// An IndexedDB of named databases, each a map of stores, enough for the
// outbox: reads, writes, deletes and clear, completed a tick later.
function fakeOutboxIndexedDb(databases = new Map()) {
  const later = (fn) => setTimeout(fn, 0);
  return {
    databases,
    open(name) {
      const request = {};
      later(() => {
        if (!databases.has(name)) databases.set(name, new Map());
        const stores = databases.get(name);
        const fresh = !stores.size;
        const db = {
          objectStoreNames: { contains: (store) => stores.has(store) },
          createObjectStore: (store) => { stores.set(store, new Map()); },
          transaction: (store) => {
            const tx = {};
            const done = () => later(() => tx.oncomplete?.());
            const answer = (fn) => {
              const read = {};
              later(() => { read.result = fn(); read.onsuccess?.(); done(); });
              return read;
            };
            tx.objectStore = () => ({
              getAllKeys: () => answer(() => [...stores.get(store).keys()]),
              getAll: () => answer(() => [...stores.get(store).values()]),
              get: (key) => answer(() => stores.get(store).get(key)),
              put: (value, key) => answer(() => stores.get(store).set(key, value)),
              delete: (key) => answer(() => stores.get(store).delete(key)),
              clear: () => answer(() => stores.get(store).clear()),
            });
            return tx;
          },
          close() {},
        };
        request.result = db;
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

test('"Sign out this browser": the page\'s message empties the outbox, and a replay under way stops sending', async () => {
  const listeners = new Map();
  const fetched = [];
  const idb = fakeOutboxIndexedDb();
  let release = null;
  const context = vm.createContext({
    self: {
      location: { href: `${SCOPE}sw.js?v=1`, origin: 'https://relay-a.example.test' },
      registration: { scope: SCOPE },
      clients: { matchAll: async () => [] },
      addEventListener: (type, handler) => listeners.set(type, handler),
    },
    URL,
    console,
    queueMicrotask,
    setTimeout,
    indexedDB: idb,
    // The first replayed send hangs until released: the sign-out comes meanwhile.
    fetch: async (url) => {
      fetched.push(url);
      if (fetched.length === 1) await new Promise((resolve) => { release = resolve; });
      return { ok: false, status: 503, json: async () => ({}), clone() { return this; } };
    },
  });
  vm.runInContext(SW_SOURCE, context);
  // Three queued sends, as the page leaves them.
  const outbox = new Map([[1, { kind: 'message', path: '/api/message', method: 'POST', body: '{}', createdAt: Date.now(), attempts: 0 }],
    [2, { kind: 'message', path: '/api/message', method: 'POST', body: '{}', createdAt: Date.now(), attempts: 0 }],
    [3, { kind: 'answer', path: '/api/relay-question/q1/answer', method: 'POST', body: '{}', createdAt: Date.now(), attempts: 0 }]]);
  idb.databases.set('copilot-remote-sync', new Map([['outbox', outbox]]));

  let replay = null;
  listeners.get('sync')({ tag: 'copilot-outbox', waitUntil: (promise) => { replay = promise.catch(() => {}); } });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  // Another message type does nothing.
  listeners.get('message')({ data: { type: 'something-else' }, waitUntil: () => {} });
  assert.equal(outbox.size, 3);
  let cleared = null;
  listeners.get('message')({ data: { type: 'oar-clear-outbox' }, waitUntil: (promise) => { cleared = promise; } });
  await cleared;
  assert.equal(outbox.size, 0, 'the outbox is empty');
  release();
  await replay;
  assert.equal(fetched.length, 1, 'nothing more is sent after the sign-out');
  assert.equal(outbox.size, 0, 'the send under way is not put back');
});

test('"Sign it out" on a new sign-in keeps this browser\'s outbox for another browser, and empties it when the session was this one', async () => {
  async function signOutWith(current) {
    const listeners = new Map();
    const shown = [];
    const idb = fakeOutboxIndexedDb();
    const outbox = new Map([[1, { kind: 'message', path: '/api/message', method: 'POST', body: '{}', createdAt: Date.now(), attempts: 0 }]]);
    idb.databases.set('copilot-remote-sync', new Map([['outbox', outbox]]));
    const context = vm.createContext({
      self: {
        location: { href: `${SCOPE}sw.js?v=1`, origin: 'https://relay-a.example.test' },
        registration: { scope: SCOPE, showNotification: async (title, options) => { shown.push(options?.body); } },
        clients: { matchAll: async () => [], openWindow: async () => null },
        addEventListener: (type, handler) => listeners.set(type, handler),
      },
      URL,
      console,
      queueMicrotask,
      setTimeout,
      Notification: { maxActions: 2 },
      indexedDB: idb,
      fetch: async () => {
        const response = { ok: true, status: 200, json: async () => ({ ok: true, id: 'bs_new1', current }), clone: () => response };
        return response;
      },
    });
    vm.runInContext(SW_SOURCE, context);
    let done = null;
    listeners.get('notificationclick')({
      action: 'signout-session',
      notification: { data: NEW_SIGNIN_DATA, close: () => {} },
      waitUntil: (promise) => { done = promise; },
    });
    await done;
    return { outbox, shown };
  }
  const other = await signOutWith(false);
  assert.equal(other.outbox.size, 1, 'another browser signed out: this one\'s queued sends stay');
  assert.match(other.shown[0], /^The new browser was signed out\./);
  const self = await signOutWith(true);
  assert.equal(self.outbox.size, 0, 'this very browser signed out: its outbox goes too');
  assert.deepEqual(self.shown, ['Signed out, open OAR']);
});

test('the 10-attempt cap stays: a send failing ten times is dropped', () => {
  assert.match(SW_SOURCE, /const SYNC_MAX_REPLAY_ATTEMPTS = 10;/);
});
