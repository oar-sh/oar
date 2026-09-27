// The browser's copy of this relay's remote-relay list (Settings → Relays and
// the composer's @mention popup read it). Filled lazily from
// GET /api/remote-relays and replaced wholesale by the relay's
// `remote_relays_updated` socket event; never carries tokens.

import { IS_SHARED_VIEW } from './store.js';
import { loadRemoteRelays } from './api-client.js';

// A relay without the feature answers 404; do not ask again on every "@".
const FAILED_LOAD_RETRY_MS = 60_000;
const KNOWN_STATUSES = new Set(['online', 'offline', 'unauthorized', 'error', 'unknown']);

/** A remote's health for its dot: online, offline, unauthorized, error or unknown. */
export function remoteRelayStatus(relay) {
  const status = String(relay?.lastStatus || '').trim().toLowerCase();
  return KNOWN_STATUSES.has(status) ? status : 'unknown';
}

let snapshot = null; // { relays: [], self: {} | null } once known
let loadPromise = null;
let lastFailedLoadAt = 0;
const listeners = new Set();

function normalizeRelay(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  return { ...raw, id };
}

function normalizeSnapshot(payload) {
  const relays = Array.isArray(payload?.relays)
    ? payload.relays.map(normalizeRelay).filter(Boolean)
    : [];
  const self = payload?.self && typeof payload.self === 'object' ? { ...payload.self } : null;
  return { relays, self };
}

function notify() {
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      console.warn('[remote-relays] listener failed', error?.message || error);
    }
  }
}

/** The last known `{ relays, self }`, or null before the first load. */
export function getRemoteRelaysSnapshot() {
  return snapshot;
}

export function getRemoteRelays() {
  return snapshot?.relays || [];
}

/**
 * Replaces the list (socket event, GET response). A payload without a
 * `relays` array is ignored rather than wiping what is known; `self` survives
 * a payload that omits it.
 */
export function setRemoteRelaysSnapshot(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.relays)) return snapshot;
  const next = normalizeSnapshot(payload);
  if (!next.self && snapshot?.self) next.self = snapshot.self;
  snapshot = next;
  lastFailedLoadAt = 0;
  notify();
  return snapshot;
}

/** Applies one relay a PATCH/check answered with, without a full reload. */
export function upsertRemoteRelay(relay) {
  const normalized = normalizeRelay(relay);
  if (!normalized || !snapshot) return snapshot;
  const relays = snapshot.relays.slice();
  const index = relays.findIndex((entry) => entry.id === normalized.id);
  if (index === -1) relays.push(normalized);
  else relays[index] = normalized;
  snapshot = { ...snapshot, relays };
  notify();
  return snapshot;
}

export function removeRemoteRelayFromSnapshot(id) {
  const key = String(id || '').trim();
  if (!snapshot || !key) return snapshot;
  snapshot = { ...snapshot, relays: snapshot.relays.filter((entry) => entry.id !== key) };
  notify();
  return snapshot;
}

/** Fetches the list now. Resolves to the snapshot (null when unavailable). */
export async function refreshRemoteRelays() {
  if (IS_SHARED_VIEW) return snapshot;
  const payload = await loadRemoteRelays();
  if (payload && Array.isArray(payload.relays)) return setRemoteRelaysSnapshot(payload);
  lastFailedLoadAt = Date.now();
  return snapshot;
}

/** Loads once, lazily (first "@" in the composer); later calls reuse the cache. */
export function ensureRemoteRelaysLoaded() {
  if (snapshot) return Promise.resolve(snapshot);
  if (IS_SHARED_VIEW) return Promise.resolve(null);
  if (loadPromise) return loadPromise;
  if (lastFailedLoadAt && Date.now() - lastFailedLoadAt < FAILED_LOAD_RETRY_MS) return Promise.resolve(null);
  loadPromise = refreshRemoteRelays().finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

export function subscribeRemoteRelays(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: forget everything. */
export function resetRemoteRelaysStoreForTests() {
  snapshot = null;
  loadPromise = null;
  lastFailedLoadAt = 0;
}
