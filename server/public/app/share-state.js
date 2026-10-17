// The relay's active public shares, as it last reported them: one entry per
// shared conversation (Settings → Shared conversations) and whether the open
// conversation has one (the ⋯ menu's "Stop sharing"). Read from GET /api/shares
// when the socket connects and again on every share event; no DOM here.

import { listConversationShares } from './api-client.js';

let shares = [];
let settings = { storeViewerIp: true, accessLog: true };
let loaded = false;
let refreshInFlight = null;
let refreshAgain = false;
const listeners = new Set();

function notify() {
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.error('share listener failed', error); }
  }
}

function normalizeShare(entry) {
  const conversationId = String(entry?.conversationId || '').trim();
  if (!conversationId) return null;
  const count = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0);
  return {
    conversationId,
    title: String(entry?.title || '').trim(),
    archived: entry?.archived === true,
    shareUrl: String(entry?.shareUrl || '').trim(),
    sharedSince: entry?.sharedSince || null,
    renewedAt: entry?.renewedAt || null,
    lastOpenedAt: entry?.lastOpenedAt || null,
    openCount: count(entry?.openCount),
    viewerCount: count(entry?.viewerCount),
  };
}

/** Takes a GET /api/shares body (or the same shape). */
export function applySharesSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return;
  shares = (Array.isArray(payload.shares) ? payload.shares : []).map(normalizeShare).filter(Boolean);
  settings = {
    storeViewerIp: payload.storeViewerIp !== false,
    accessLog: payload.accessLog !== false,
  };
  loaded = true;
  notify();
}

export function applyShareSettings(next) {
  if (!next || typeof next.storeViewerIp !== 'boolean') return;
  settings = { ...settings, storeViewerIp: next.storeViewerIp };
  notify();
}

/** A share this page just stopped: gone before the relay's event arrives. */
export function forgetShare(conversationId) {
  const id = String(conversationId || '').trim();
  const next = shares.filter((share) => share.conversationId !== id);
  if (next.length === shares.length) return;
  shares = next;
  notify();
}

export function getShares() {
  return shares.slice();
}

export function getShareSettings() {
  return { ...settings };
}

export function sharesLoaded() {
  return loaded;
}

export function hasActiveShare(conversationId) {
  const id = String(conversationId || '').trim();
  return !!id && shares.some((share) => share.conversationId === id);
}

/**
 * Reads the list again. Calls during a read are folded into one more read
 * after it, so the last event always wins. Rejects with the relay's reason.
 */
export async function refreshShares() {
  if (refreshInFlight) {
    refreshAgain = true;
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    try {
      do {
        refreshAgain = false;
        const payload = await listConversationShares();
        if (payload) applySharesSnapshot(payload);
      } while (refreshAgain);
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export function subscribeShares(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
