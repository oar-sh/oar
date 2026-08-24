import { BASE, CLIENT_ID, authHeaders, conversations } from './store.js';

// Durable outbox for Background Sync: message sends, ask_user answers, and
// draft flushes that failed (or might die mid-flight on pagehide) are queued
// in IndexedDB and replayed by the service worker's `sync` handler. The store
// layout here must match the reader in sw.js, which cannot import modules.

const DB_NAME = 'copilot-remote-sync';
const DB_VERSION = 1;
const STORE_NAME = 'outbox';
export const OUTBOX_SYNC_TAG = 'copilot-outbox';
const MAX_REPLAY_ATTEMPTS = 10;

function openOutboxDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
  });
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/**
 * @param {{ kind: string, path: string, method?: string, body: string }} entry
 *   `path` is BASE-relative (e.g. "/api/message"); `body` is a JSON string.
 */
export async function enqueueOutboxRequest(entry) {
  if (!('indexedDB' in window)) return false;
  try {
    const db = await openOutboxDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add({
      kind: String(entry?.kind || 'request'),
      path: String(entry?.path || ''),
      method: String(entry?.method || 'POST'),
      body: String(entry?.body || ''),
      createdAt: Date.now(),
      attempts: 0,
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB write aborted'));
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask the service worker to replay the outbox when connectivity returns.
 * Returns false when Background Sync is unavailable (non-Chromium); the caller
 * falls back to page-side replay via initOutboxFallbackReplay().
 */
export async function registerOutboxSync() {
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration && 'sync' in registration) {
      await registration.sync.register(OUTBOX_SYNC_TAG);
      return true;
    }
  } catch {}
  return false;
}

async function readOutboxEntries(db) {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const [keys, values] = await Promise.all([
    requestAsPromise(store.getAllKeys()),
    requestAsPromise(store.getAll()),
  ]);
  return keys.map((key, index) => ({ key, value: values[index] }));
}

async function deleteOutboxEntry(db, key) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).delete(key);
  return new Promise((resolve) => {
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

async function updateOutboxEntry(db, key, value) {
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(value, key);
  return new Promise((resolve) => {
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

// A 4xx (other than timeout/rate-limit) means the server made a decision about
// this exact request — including 409 DUPLICATE_MESSAGE_ID for a send that
// actually landed on a previous ambiguous attempt — so the entry is finished.
function isFinalResponse(response) {
  if (!response) return false;
  if (response.ok) return true;
  return response.status >= 400 && response.status < 500
    && response.status !== 408 && response.status !== 429;
}

/**
 * Page-side replay for browsers without Background Sync. Replays in insertion
 * order; stops at the first retryable failure so ordering is preserved.
 */
export async function replayOutboxFromPage() {
  if (!('indexedDB' in window)) return { replayed: 0 };
  let db = null;
  let replayed = 0;
  try {
    db = await openOutboxDb();
    const entries = await readOutboxEntries(db);
    for (const { key, value } of entries) {
      let response = null;
      try {
        response = await fetch(`${BASE}${value.path}`, {
          method: value.method || 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: value.body,
        });
      } catch {
        response = null;
      }
      if (isFinalResponse(response)) {
        await deleteOutboxEntry(db, key);
        replayed += 1;
        continue;
      }
      const attempts = Number(value.attempts || 0) + 1;
      if (attempts >= MAX_REPLAY_ATTEMPTS) {
        await deleteOutboxEntry(db, key);
      } else {
        await updateOutboxEntry(db, key, { ...value, attempts });
      }
      break;
    }
  } catch {} finally {
    try { db?.close(); } catch {}
  }
  return { replayed };
}

let fallbackReplayBound = false;

/**
 * When Background Sync is unsupported, replay the queue from the page on load
 * and whenever connectivity returns.
 */
export async function initOutboxFallbackReplay() {
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (registration && 'sync' in registration) return;
  } catch {}
  if (fallbackReplayBound) return;
  fallbackReplayBound = true;
  void replayOutboxFromPage();
  window.addEventListener('online', () => {
    void replayOutboxFromPage();
  });
}

/**
 * Best-effort durable draft flush for pagehide: the direct PATCH the page
 * fires can be killed mid-flight, so the same update is queued for the
 * service worker. If the direct write wins, the replay's baseDraftUpdatedAt
 * is stale and the server rejects it with a version conflict, which the
 * replay treats as final. Only queues when the draft differs from the last
 * persisted state.
 */
export async function enqueueDraftFlushForBackgroundSync(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) return false;
  const conversation = conversations[id];
  if (!conversation) return false;
  const input = document.getElementById('msg-input');
  const draftText = String(input ? input.value : (conversation.draftText || ''));
  if (draftText === String(conversation.draftText || '')) return false;
  const queued = await enqueueOutboxRequest({
    kind: 'draft-flush',
    path: `/api/conversation/${encodeURIComponent(id)}/draft`,
    method: 'PATCH',
    body: JSON.stringify({
      draftText,
      clientId: CLIENT_ID,
      baseDraftUpdatedAt: conversation.draftUpdatedAt || null,
    }),
  });
  if (queued) void registerOutboxSync();
  return queued;
}
