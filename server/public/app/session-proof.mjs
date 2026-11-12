// The browser session's proof key (agent auth, the per-session key).
//
// The session itself is the HttpOnly cookie `copilot_auth`. A cookie is sent
// to every port of the host, so a page on another port (an agent's dev
// server) gets it too; the key is what that page does not get. The relay
// hands it over once, in the sign-in answer (`proof`), and wants it back as
// `X-OAR-Session-Proof` on every API request the page makes, and as
// `auth.proof` in the Socket.IO handshake. Only there: a request to any
// other address (another origin, or a path of this one outside its /api)
// goes without it (sessionProofHeaders(url)).
//
// It is kept per origin, which includes the port: in localStorage for the
// page, and in IndexedDB for the service worker (which cannot read
// localStorage and answers cards from notifications). No key means signed
// out: the relay never makes a key for a cookie alone.
//
// sw.js reads the same IndexedDB entry (SESSION_PROOF_DB_NAME, store, key);
// keep the three names in step with it.

export const SESSION_PROOF_HEADER = 'X-OAR-Session-Proof';
export const SESSION_PROOF_STORAGE_KEY = 'oar_session_proof';
export const SESSION_PROOF_DB_NAME = 'oar-session-proof';
export const SESSION_PROOF_DB_STORE = 'proof';
export const SESSION_PROOF_DB_KEY = 'current';
const SESSION_PROOF_PATTERN = /^oark1_[A-Za-z0-9_-]{16,}$/;

let memoryValue = '';
// False after localStorage refused a write (a private mode): memory holds the key then.
let storageWritable = true;

function validProof(value) {
  const text = String(value || '').trim();
  return SESSION_PROOF_PATTERN.test(text) ? text : '';
}

function storage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** The key of this origin's session, or ''. Read on every call: another tab may have signed in. */
export function getSessionProof() {
  const store = storage();
  if (store && storageWritable) {
    try {
      memoryValue = validProof(store.getItem(SESSION_PROOF_STORAGE_KEY));
      return memoryValue;
    } catch {}
  }
  return memoryValue;
}

function pageLocation() {
  try { return globalThis.location || globalThis.window?.location || null; } catch { return null; }
}

/** `url` resolved against this page, or null when it is no address. */
function resolvedUrl(url) {
  const text = typeof url === 'string' ? url.trim() : (url instanceof URL ? url.href : '');
  const here = String(pageLocation()?.href || '');
  if (!text || !here) return null;
  try { return new URL(text, here); } catch { return null; }
}

function pageOrigin() {
  try { return new URL(String(pageLocation()?.href || '')).origin; } catch { return ''; }
}

/** True in a page with an origin of its own (not about:blank, not a test without one). */
export function hasPageOrigin() {
  const origin = pageOrigin();
  return !!origin && origin !== 'null';
}

/** True when `url` goes to this page's own origin (scheme, host and port). */
export function isSameOriginUrl(url) {
  const target = resolvedUrl(url);
  const origin = pageOrigin();
  return !!target && !!origin && origin !== 'null' && target.origin === origin;
}

/**
 * True for a picture this page may fetch itself (the marker editor reads
 * its bytes): one of this origin (a blob: of this page included) or an
 * inline data: image. A picture from anywhere else (an agent can put any
 * address in a message) is only shown, never fetched by the page.
 */
export function isOwnImageUrl(url) {
  const target = resolvedUrl(url);
  if (!target) return false;
  if (target.protocol === 'data:') return /^image\//i.test(target.pathname);
  return isSameOriginUrl(target);
}

/**
 * True when `url` is this relay's own API: this page's origin and a path
 * under `${base}/api/`. The key goes there and nowhere else: not to a
 * picture an agent put in a message (its server, on another port of this
 * host, gets the cookie but must not get the key), not to a page or an
 * asset of this origin.
 */
export function isRelayApiUrl(url, base = '') {
  if (!isSameOriginUrl(url)) return false;
  const root = String(base || '').trim().replace(/\/+$/, '');
  const prefix = `${root && !root.startsWith('/') ? '/' : ''}${root}/api/`;
  return resolvedUrl(url).pathname.startsWith(prefix);
}

/**
 * `{ 'X-OAR-Session-Proof': key }` for a request to `url`, or {}: without a
 * key, without a `url`, or for any address that is not this relay's own API
 * (isRelayApiUrl; `base` is the app's base path).
 */
export function sessionProofHeaders(url, base = '') {
  if (!isRelayApiUrl(url, base)) return {};
  const proof = getSessionProof();
  return proof ? { [SESSION_PROOF_HEADER]: proof } : {};
}

function openProofDb() {
  return new Promise((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory?.open) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = factory.open(SESSION_PROOF_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SESSION_PROOF_DB_STORE)) db.createObjectStore(SESSION_PROOF_DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
  });
}

async function writeProofDb(value) {
  let db = null;
  try {
    db = await openProofDb();
    await new Promise((resolve) => {
      const tx = db.transaction(SESSION_PROOF_DB_STORE, 'readwrite');
      const store = tx.objectStore(SESSION_PROOF_DB_STORE);
      if (value) store.put(value, SESSION_PROOF_DB_KEY);
      else store.delete(SESSION_PROOF_DB_KEY);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
  } catch {} finally {
    try { db?.close(); } catch {}
  }
}

async function readProofDb() {
  let db = null;
  try {
    db = await openProofDb();
    return await new Promise((resolve) => {
      const request = db.transaction(SESSION_PROOF_DB_STORE, 'readonly').objectStore(SESSION_PROOF_DB_STORE).get(SESSION_PROOF_DB_KEY);
      request.onsuccess = () => resolve(validProof(request.result));
      request.onerror = () => resolve('');
    });
  } catch {
    return '';
  } finally {
    try { db?.close(); } catch {}
  }
}

/** Keeps the key a sign-in answered with, for the page and the service worker. */
export async function storeSessionProof(value) {
  const proof = validProof(value);
  if (!proof) return false;
  memoryValue = proof;
  try {
    storage()?.setItem(SESSION_PROOF_STORAGE_KEY, proof);
    storageWritable = true;
  } catch {
    storageWritable = false;
  }
  await writeProofDb(proof);
  return true;
}

/** Forgets the key (signed out): the page and the service worker alike. */
export async function clearSessionProof() {
  memoryValue = '';
  try { storage()?.removeItem(SESSION_PROOF_STORAGE_KEY); } catch {}
  await writeProofDb('');
}

/**
 * At start: the two copies agree. A key only in IndexedDB (localStorage
 * evicted on its own) comes back to the page; a key only in localStorage
 * (written by the inline sign-in fallback) goes to the service worker.
 */
export async function syncSessionProof() {
  const page = getSessionProof();
  if (page) {
    await writeProofDb(page);
    return page;
  }
  const kept = await readProofDb();
  if (!kept) return '';
  memoryValue = kept;
  try { storage()?.setItem(SESSION_PROOF_STORAGE_KEY, kept); } catch {}
  return kept;
}
