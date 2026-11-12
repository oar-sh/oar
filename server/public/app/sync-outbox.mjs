import { BASE, CLIENT_ID, authHeaders, conversations } from './store.js';
import { draftFlushRequestBody, getSyncedDraft, isStaleDraftFlushEntry } from './conversation-draft-sync.mjs';

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
// Refusals about this browser's sign-in, not about the request (a 401, a
// 403 AUTH_SESSION_PROOF or AUTH_COOKIE_UPGRADE): the send stays queued for
// after the sign-in. sw.js keeps the same rule.
const KEEP_403_CODES = new Set(['AUTH_SESSION_PROOF', 'AUTH_COOKIE_UPGRADE']);

async function isSignInRefusal(response) {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  try {
    return KEEP_403_CODES.has(String((await response.clone().json())?.code || ''));
  } catch {
    return false;
  }
}

export async function isFinalResponse(response) {
  if (!response) return false;
  if (response.ok) return true;
  if (!(response.status >= 400 && response.status < 500)) return false;
  if (response.status === 408 || response.status === 429) return false;
  return !(await isSignInRefusal(response));
}

/**
 * Page-side replay for browsers without Background Sync. Replays in insertion
 * order; stops at the first retryable failure so ordering is preserved.
 */
// Bumped by clearOutbox: a page replay under way stops.
let outboxGeneration = 0;

export async function replayOutboxFromPage() {
  if (!('indexedDB' in window)) return { replayed: 0 };
  const generation = outboxGeneration;
  let db = null;
  let replayed = 0;
  try {
    db = await openOutboxDb();
    const entries = await readOutboxEntries(db);
    for (const { key, value } of entries) {
      if (generation !== outboxGeneration) break;
      if (isStaleDraftFlushEntry(value)) {
        await deleteOutboxEntry(db, key);
        continue;
      }
      let response = null;
      try {
        const target = `${BASE}${value.path}`;
        response = await fetch(target, {
          method: value.method || 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(target) },
          body: value.body,
        });
      } catch {
        response = null;
      }
      if (generation !== outboxGeneration) break;
      if (await isFinalResponse(response)) {
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

// What the page tells its service worker to empty the outbox with (sw.js
// listens for the same type).
export const OUTBOX_CLEAR_MESSAGE = 'oar-clear-outbox';

/**
 * This browser signed itself out on purpose ("Sign out this browser"): what
 * it queued while signed in is not sent by whoever signs in next. Empties
 * the outbox here and tells the service worker, which empties it too and
 * stops a replay it is in. A refused send (401, 403 AUTH_SESSION_PROOF)
 * keeps its entries for after the sign-in, up to MAX_REPLAY_ATTEMPTS.
 * True when the page's store was emptied.
 */
export async function clearOutbox() {
  outboxGeneration += 1;
  let cleared = false;
  if (typeof indexedDB !== 'undefined' && indexedDB) {
    let db = null;
    try {
      db = await openOutboxDb();
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      cleared = await new Promise((resolve) => {
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } catch {
      cleared = false;
    } finally {
      try { db?.close(); } catch {}
    }
  }
  try { globalThis.navigator?.serviceWorker?.controller?.postMessage({ type: OUTBOX_CLEAR_MESSAGE }); } catch {}
  return cleared;
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
export async function enqueueDraftFlushForBackgroundSync(conversationId, { afterPendingSend = false } = {}) {
  const id = String(conversationId || '').trim();
  if (!id) return false;
  const conversation = conversations[id];
  if (!conversation) return false;
  const input = document.getElementById('msg-input');
  const body = draftFlushRequestBody({
    inputText: input ? input.value : (conversation.draftText || ''),
    synced: getSyncedDraft(id),
    fallbackText: conversation.draftText,
    fallbackUpdatedAt: conversation.draftUpdatedAt,
    clientId: CLIENT_ID,
    afterPendingSend,
  });
  if (!body) return false;
  const queued = await enqueueOutboxRequest({
    kind: 'draft-flush',
    path: `/api/conversation/${encodeURIComponent(id)}/draft`,
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (queued) void registerOutboxSync();
  return queued;
}
