const SW_URL = new URL(self.location.href);
const SW_VERSION = String(SW_URL.searchParams.get('v') || '').trim() || '0';
const CACHE_NAME = `copilot-remote-shell-v${SW_VERSION}`;
const REGISTRATION_SCOPE_PATH = (() => {
  const path = new URL(self.registration.scope).pathname || '/';
  return path.endsWith('/') ? path : `${path}/`;
})();
const STATIC_ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'app-icon-192.png',
  'app-icon-512.png',
  'favicon.ico',
  'app-icon.svg',
  'app-icon-light-192.png',
  'app-icon-light-512.png',
  'app-icon-light.svg',
  'app-icon-maskable-512.png',
  'app-icon-light-maskable-512.png',
];

function sameOrigin(url) {
  return url.origin === self.location.origin;
}

function isApiRequest(url) {
  return /\/api(?:\/|$)/.test(url.pathname) || /\/socket\.io(?:\/|$)/.test(url.pathname);
}

function isPwaMetadataRequest(url) {
  if (!url.pathname.startsWith(REGISTRATION_SCOPE_PATH)) return false;
  const relativePath = url.pathname.slice(REGISTRATION_SCOPE_PATH.length);
  return /^(?:manifest\.webmanifest|app-icon(?:-light)?(?:-maskable)?(?:-\d+)?\.(?:png|svg)|favicon\.ico)$/.test(relativePath);
}

function isApplicationModuleRequest(url) {
  if (!url.pathname.startsWith(`${REGISTRATION_SCOPE_PATH}app/`)) return false;
  return /\.(?:m?js)$/i.test(url.pathname);
}

async function cacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const assets = STATIC_ASSETS.map((asset) => new URL(asset, self.registration.scope).href);
  await cache.addAll(assets);
}

async function networkFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(cacheKey, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    throw new Error('Offline');
  }
}

async function cacheFirst(request, cacheKey) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(cacheKey, response.clone());
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await cacheShell();
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => (key === CACHE_NAME ? Promise.resolve() : caches.delete(key))));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (!sameOrigin(url) || isApiRequest(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, new URL('./', self.registration.scope).href));
    return;
  }

  if (isPwaMetadataRequest(url)) {
    event.respondWith(networkFirst(request, request.url));
    return;
  }

  if (isApplicationModuleRequest(url)) {
    event.respondWith(networkFirst(request, request.url));
    return;
  }

  event.respondWith(cacheFirst(request, request.url));
});

// ─── Web Push ────────────────────────────────────────────────────────────────

function scopeUrl(relative) {
  return new URL(relative, self.registration.scope).href;
}

async function handlePushEvent(event) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const maxActions = Number(Notification.maxActions || 0);
  let actions = choices.slice(0, maxActions).map((choice, index) => ({
    action: `choice-${index}`,
    title: String(choice).slice(0, 40),
  }));
  const options = {
    body: payload?.body || '',
    tag: payload?.tag || undefined,
    // Carried so a delivery delayed by doze is not misread as current.
    timestamp: Number(payload?.timestamp) || Date.now(),
    data,
    icon: scopeUrl('app-icon-192.png'),
    badge: scopeUrl('app-icon-192.png'),
  };
  if (data.type === NEW_SIGNIN_TYPE) {
    // One new browser: "Sign it out" from the lock screen (it only ever
    // removes access). Several in the window: the tap opens Security.
    actions = data.signOutSessionId && maxActions > 0 ? [{ action: SIGNOUT_SESSION_ACTION, title: 'Sign it out' }] : [];
    // The first push of a coalescing window is the security signal: it always
    // alerts, even over an older one under the same tag. A later sign-in in
    // the window replaces it without ringing again.
    options.silent = false;
    if (options.tag) options.renotify = data.quiet !== true;
  }
  options.actions = actions;
  await self.registration.showNotification(payload?.title || 'OAR', options);
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePushEvent(event));
});

// ─── The session's proof key ─────────────────────────────────────────────────
// The relay wants the browser session's key (X-OAR-Session-Proof) next to
// the cookie on every API request. The page keeps it in localStorage, which
// a worker cannot read, and a copy in this IndexedDB entry. Mirror of
// app/session-proof.mjs: keep the names in step.

const SESSION_PROOF_HEADER = 'X-OAR-Session-Proof';
const SESSION_PROOF_DB_NAME = 'oar-session-proof';
const SESSION_PROOF_DB_STORE = 'proof';
const SESSION_PROOF_DB_KEY = 'current';

function readSessionProof() {
  return new Promise((resolve) => {
    let request = null;
    try {
      request = indexedDB.open(SESSION_PROOF_DB_NAME, 1);
    } catch {
      resolve('');
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_PROOF_DB_STORE)) db.createObjectStore(SESSION_PROOF_DB_STORE);
    };
    request.onerror = () => resolve('');
    request.onsuccess = () => {
      const db = request.result;
      try {
        const read = db.transaction(SESSION_PROOF_DB_STORE, 'readonly').objectStore(SESSION_PROOF_DB_STORE).get(SESSION_PROOF_DB_KEY);
        read.onsuccess = () => {
          const value = String(read.result || '');
          try { db.close(); } catch {}
          resolve(/^oark1_[A-Za-z0-9_-]{16,}$/.test(value) ? value : '');
        };
        read.onerror = () => {
          try { db.close(); } catch {}
          resolve('');
        };
      } catch {
        try { db.close(); } catch {}
        resolve('');
      }
    };
  });
}

// The key goes to this relay's own API (`<scope>api/…`) and nowhere else.
function isRelayApiUrl(url) {
  try {
    const target = new URL(String(url || ''), self.registration.scope);
    const api = new URL('api/', self.registration.scope);
    return target.origin === api.origin && target.pathname.startsWith(api.pathname);
  } catch {
    return false;
  }
}

async function sessionProofHeaders(url) {
  if (!url || !isRelayApiUrl(url)) return {};
  const proof = await readSessionProof();
  return proof ? { [SESSION_PROOF_HEADER]: proof } : {};
}

// 401, or 403 AUTH_SESSION_PROOF (no key, or not this session's): this
// browser is not signed in here.
async function isSignedOutResponse(response) {
  if (!response) return false;
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  try {
    return (await response.clone().json())?.code === 'AUTH_SESSION_PROOF';
  } catch {
    return false;
  }
}

// A new browser signed in (push type newSignIn): the action that signs it out.
const NEW_SIGNIN_TYPE = 'newSignIn';
const SIGNOUT_SESSION_ACTION = 'signout-session';
// What a tap may open: Settings at a tab of this app, nothing else.
const SETTINGS_LINK = /^\?settings=[a-z]{1,20}$/;

// The worker holds no token: the page's HttpOnly cookie carries the browser
// session, with the session's proof key from IndexedDB beside it, and a
// fetch to its own scope is same-origin, so the relay's cross-site write
// check lets it through. Never an Authorization header.
async function signOutSessionFromNotification(sessionId) {
  const target = scopeUrl(`api/auth/sessions/${encodeURIComponent(sessionId)}`);
  const response = await fetch(target, {
    method: 'DELETE',
    credentials: 'include',
    headers: await sessionProofHeaders(target),
  });
  let current = false;
  if (response.ok) {
    try { current = (await response.clone().json())?.current === true; } catch {}
  }
  return { ok: response.ok, status: response.status, current, signedOut: await isSignedOutResponse(response) };
}

async function showSignInOutcomeNotification(body) {
  await self.registration.showNotification('OAR', {
    body,
    tag: 'oar-new-signin',
    data: { type: NEW_SIGNIN_TYPE, open: '?settings=security' },
    icon: scopeUrl('app-icon-192.png'),
    badge: scopeUrl('app-icon-192.png'),
  });
}

/** Settings at the tab of `open` (`?settings=<tab>`): an open window, else a new one. */
async function focusOrOpenSettings(open) {
  const link = SETTINGS_LINK.test(String(open || '')) ? String(open) : '?settings=security';
  const tab = link.slice('?settings='.length);
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const scopePath = new URL(self.registration.scope).pathname;
  const appClient = clients.find((client) => new URL(client.url).pathname.startsWith(scopePath));
  if (appClient) {
    try {
      await appClient.focus();
    } catch {}
    appClient.postMessage({ type: 'copilot-open-settings', tab });
    return;
  }
  await self.clients.openWindow(scopeUrl(link));
}

async function handleNewSignInClick(event, data) {
  event.notification.close();
  const sessionId = String(data.signOutSessionId || '');
  if (String(event.action || '') === SIGNOUT_SESSION_ACTION && sessionId) {
    let result = null;
    try {
      result = await signOutSessionFromNotification(sessionId);
    } catch {
      result = null;
    }
    // It was this very browser (signed in again here, say): signed out like
    // "Sign out this browser", so its outbox goes too. Another browser's
    // sign-out leaves this one's queued sends alone.
    if (result?.ok && result.current) {
      await clearSyncOutbox().catch(() => {});
      await showSignedOutNotification('');
      return;
    }
    if (result?.ok) {
      await showSignInOutcomeNotification('The new browser was signed out. Open Settings → Security to check the others.');
      return;
    }
    if (result?.status === 404) {
      await showSignInOutcomeNotification('That browser was already signed out.');
      return;
    }
    // 401, or 403 AUTH_SESSION_PROOF (this browser's key is gone): signed out.
    if (result?.signedOut) {
      await showSignedOutNotification('');
      return;
    }
    // Offline or refused: Security, where it can be signed out by hand.
  }
  await focusOrOpenSettings(data.open);
}

async function answerQuestionFromNotification(questionId, answer) {
  // Same-origin POST with credentials so the HttpOnly auth cookie applies,
  // and the session's key with it.
  const target = scopeUrl(`api/relay-question/${encodeURIComponent(questionId)}/answer`);
  const response = await fetch(target, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(await sessionProofHeaders(target)) },
    body: JSON.stringify({ answer }),
  });
  return { ok: response.ok, status: response.status, signedOut: await isSignedOutResponse(response) };
}

// The answer came back 401 (or without a valid session key): this browser
// was signed out (from another browser, by expiry, or the relay token it
// signed in with was replaced). Say so; tapping it opens OAR, which shows
// the sign-in.
async function showSignedOutNotification(conversationId) {
  await self.registration.showNotification('OAR', {
    body: 'Signed out, open OAR',
    tag: 'oar-signed-out',
    data: { conversationId: String(conversationId || ''), signedOut: true },
    icon: scopeUrl('app-icon-192.png'),
    badge: scopeUrl('app-icon-192.png'),
  });
}

async function focusOrOpenConversation(conversationId) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const scopePath = new URL(self.registration.scope).pathname;
  const appClient = clients.find((client) => new URL(client.url).pathname.startsWith(scopePath));
  if (appClient) {
    try {
      await appClient.focus();
    } catch {}
    if (conversationId) {
      appClient.postMessage({ type: 'copilot-open-conversation', conversationId });
    }
    return;
  }
  const target = conversationId
    ? scopeUrl(`?push_conv=${encodeURIComponent(conversationId)}`)
    : scopeUrl('./');
  await self.clients.openWindow(target);
}

async function handleNotificationClick(event) {
  const data = event.notification?.data || {};
  if (data.type === NEW_SIGNIN_TYPE) {
    await handleNewSignInClick(event, data);
    return;
  }
  const action = String(event.action || '');
  const choiceMatch = action.match(/^choice-(\d+)$/);
  if (choiceMatch && data.questionId) {
    const choice = (Array.isArray(data.choices) ? data.choices : [])[Number(choiceMatch[1])];
    if (choice) {
      event.notification.close();
      const answered = await answerQuestionFromNotification(data.questionId, String(choice));
      // If the answer did not land (expired, already answered, offline), fall
      // through to opening the conversation so the user can see why.
      if (answered.ok) return;
      if (answered.signedOut) {
        await showSignedOutNotification(data.conversationId);
        return;
      }
    }
  }
  // A card on a paired relay: it carries no question id, only the
  // link of its session there, and is answered there ("Open there").
  const url = String(data.url || '');
  if (!data.questionId && /^https?:\/\//i.test(url)) {
    event.notification.close();
    await self.clients.openWindow(url);
    return;
  }
  event.notification.close();
  await focusOrOpenConversation(String(data.conversationId || ''));
}

self.addEventListener('notificationclick', (event) => {
  event.waitUntil(handleNotificationClick(event));
});

// ─── Background Sync outbox ──────────────────────────────────────────────────
// Mirror of the IndexedDB layout in app/sync-outbox.mjs (this worker is a
// classic script and cannot import it). The page enqueues failed sends,
// ask_user answers, and pagehide draft flushes; this handler replays them in
// order when connectivity returns.

const SYNC_DB_NAME = 'copilot-remote-sync';
const SYNC_DB_VERSION = 1;
const SYNC_STORE_NAME = 'outbox';
const SYNC_TAG = 'copilot-outbox';
const SYNC_MAX_REPLAY_ATTEMPTS = 10;
// Mirrors DRAFT_FLUSH_MAX_AGE_MS in app/conversation-draft-sync.mjs: a draft
// flush replayed later than this would overwrite whatever the draft became.
const SYNC_DRAFT_FLUSH_MAX_AGE_MS = 5 * 60 * 1000;

function openSyncDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SYNC_DB_NAME, SYNC_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SYNC_STORE_NAME)) {
        db.createObjectStore(SYNC_STORE_NAME, { autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
  });
}

function syncRequestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

async function readSyncEntries(db) {
  const store = db.transaction(SYNC_STORE_NAME, 'readonly').objectStore(SYNC_STORE_NAME);
  const [keys, values] = await Promise.all([
    syncRequestAsPromise(store.getAllKeys()),
    syncRequestAsPromise(store.getAll()),
  ]);
  return keys.map((key, index) => ({ key, value: values[index] }));
}

function deleteSyncEntry(db, key) {
  const tx = db.transaction(SYNC_STORE_NAME, 'readwrite');
  tx.objectStore(SYNC_STORE_NAME).delete(key);
  return new Promise((resolve) => {
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

function updateSyncEntry(db, key, value) {
  const tx = db.transaction(SYNC_STORE_NAME, 'readwrite');
  tx.objectStore(SYNC_STORE_NAME).put(value, key);
  return new Promise((resolve) => {
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

// Refusals about this browser's sign-in, not about the request: a 401, and
// a 403 for a cookie without its session key or one from before sessions.
// The send stays queued for after the sign-in (or the cookie's trade).
const SYNC_KEEP_403_CODES = new Set(['AUTH_SESSION_PROOF', 'AUTH_COOKIE_UPGRADE']);

async function isSignInRefusal(response) {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  try {
    return SYNC_KEEP_403_CODES.has(String((await response.clone().json())?.code || ''));
  } catch {
    return false;
  }
}

// A 4xx (other than 408/429 and a sign-in refusal) is a server decision
// about this exact request — including the 409 DUPLICATE_MESSAGE_ID a
// replayed send gets when the first ambiguous attempt actually landed — so
// the entry is finished either way.
async function isFinalSyncResponse(response) {
  if (!response) return false;
  if (response.ok) return true;
  if (!(response.status >= 400 && response.status < 500)) return false;
  if (response.status === 408 || response.status === 429) return false;
  return !(await isSignInRefusal(response));
}

// Bumped when the page signs this browser out on purpose: a replay that
// began before stops sending.
let syncOutboxGeneration = 0;

async function replaySyncOutbox() {
  const generation = syncOutboxGeneration;
  const db = await openSyncDb();
  try {
    const entries = await readSyncEntries(db);
    for (const { key, value } of entries) {
      if (generation !== syncOutboxGeneration) return;
      if (value?.kind === 'draft-flush' && !(Date.now() - Number(value.createdAt || 0) <= SYNC_DRAFT_FLUSH_MAX_AGE_MS)) {
        await deleteSyncEntry(db, key);
        continue;
      }
      let response = null;
      try {
        const target = scopeUrl(String(value.path || '').replace(/^\//, ''));
        response = await fetch(target, {
          method: value.method || 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(await sessionProofHeaders(target)) },
          body: value.body,
        });
      } catch {
        response = null;
      }
      // Signed out while it was under way: the entry is gone, not put back.
      if (generation !== syncOutboxGeneration) return;
      if (await isFinalSyncResponse(response)) {
        await deleteSyncEntry(db, key);
        continue;
      }
      const attempts = Number(value.attempts || 0) + 1;
      if (attempts >= SYNC_MAX_REPLAY_ATTEMPTS) {
        await deleteSyncEntry(db, key);
        continue;
      }
      await updateSyncEntry(db, key, { ...value, attempts });
      // Rejecting keeps ordering intact and makes the browser retry the sync
      // with its own backoff.
      throw new Error('outbox replay incomplete');
    }
  } finally {
    try { db.close(); } catch {}
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(replaySyncOutbox());
});

// "Sign out this browser" (app/sync-outbox.mjs clearOutbox): the queued
// sends, answers and draft flushes are dropped, not sent after the next
// sign-in, and a replay under way stops.
const SYNC_CLEAR_MESSAGE = 'oar-clear-outbox';

async function clearSyncOutbox() {
  syncOutboxGeneration += 1;
  const db = await openSyncDb();
  try {
    const tx = db.transaction(SYNC_STORE_NAME, 'readwrite');
    tx.objectStore(SYNC_STORE_NAME).clear();
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } finally {
    try { db.close(); } catch {}
  }
}

self.addEventListener('message', (event) => {
  if (event?.data?.type !== SYNC_CLEAR_MESSAGE) return;
  const cleared = clearSyncOutbox().catch(() => {});
  if (typeof event.waitUntil === 'function') event.waitUntil(cleared);
});
