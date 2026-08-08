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
  return /^(?:manifest\.webmanifest|app-icon(?:-\d+)?\.png|app-icon\.svg|favicon\.ico)$/.test(relativePath);
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
  const actions = choices.slice(0, maxActions).map((choice, index) => ({
    action: `choice-${index}`,
    title: String(choice).slice(0, 40),
  }));
  await self.registration.showNotification(payload?.title || 'Copilot Remote', {
    body: payload?.body || '',
    tag: payload?.tag || undefined,
    // Carried so a delivery delayed by doze is not misread as current.
    timestamp: Number(payload?.timestamp) || Date.now(),
    data,
    icon: scopeUrl('app-icon-192.png'),
    badge: scopeUrl('app-icon-192.png'),
    actions,
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePushEvent(event));
});

async function answerQuestionFromNotification(questionId, answer) {
  // Same-origin POST with credentials so the HttpOnly auth cookie applies.
  const response = await fetch(scopeUrl(`api/relay-question/${encodeURIComponent(questionId)}/answer`), {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
  return response.ok;
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
  const action = String(event.action || '');
  const choiceMatch = action.match(/^choice-(\d+)$/);
  if (choiceMatch && data.questionId) {
    const choice = (Array.isArray(data.choices) ? data.choices : [])[Number(choiceMatch[1])];
    if (choice) {
      event.notification.close();
      const ok = await answerQuestionFromNotification(data.questionId, String(choice));
      // If the answer did not land (expired, already answered, offline), fall
      // through to opening the conversation so the user can see why.
      if (ok) return;
    }
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

// A 4xx (other than 408/429) is a server decision about this exact request —
// including the 409 DUPLICATE_MESSAGE_ID a replayed send gets when the first
// ambiguous attempt actually landed — so the entry is finished either way.
function isFinalSyncResponse(response) {
  if (!response) return false;
  if (response.ok) return true;
  return response.status >= 400 && response.status < 500
    && response.status !== 408 && response.status !== 429;
}

async function replaySyncOutbox() {
  const db = await openSyncDb();
  try {
    const entries = await readSyncEntries(db);
    for (const { key, value } of entries) {
      let response = null;
      try {
        response = await fetch(scopeUrl(String(value.path || '').replace(/^\//, '')), {
          method: value.method || 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: value.body,
        });
      } catch {
        response = null;
      }
      if (isFinalSyncResponse(response)) {
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
