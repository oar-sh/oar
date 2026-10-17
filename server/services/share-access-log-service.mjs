'use strict';

import { createHmac } from 'node:crypto';

// What counts as an open of a shared conversation.
//
// The shared page fetches GET /api/shared/:token every 900 ms while it is in
// the foreground, so a fetch is not an open. Two rules decide:
//
// - The page's first fetch after it loads carries `open=1`. That fetch is an
//   open, unless the same viewer opened the same share in the last
//   RELOAD_DEDUPE_MS (a double load, a reload storm).
// - Any other fetch is an open only when the viewer has not fetched the share
//   for IDLE_MS: a page that slept in the background and came back, or a
//   client that never sends the flag (a script reading the API). Nobody reads
//   the share unlogged by leaving the flag out.
//
// A viewer is the share's lineage plus a keyed hash of address and user agent
// (`viewerKey`), so the rules and the "distinct viewers" count work whether or
// not the address is stored. When the address is unknown (no socket address),
// every fetch of that viewer looks alike, which only merges viewers.
//
// Last-seen times live in memory. After a relay restart the last logged open
// stands in for them, so a reader polling across the restart counts once more
// only when their last open is older than IDLE_MS.

export const SHARE_OPEN_IDLE_MS = 30 * 60_000;
export const SHARE_OPEN_RELOAD_DEDUPE_MS = 10_000;
const DEFAULT_MAX_TRACKED_VIEWERS = 4_096;
const USER_AGENT_MAX = 512;

function cleanText(value, max) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text ? text.slice(0, max) : '';
}

/** `::ffff:203.0.113.7` is the IPv4 address it wraps. */
export function normalizeViewerIp(value) {
  const ip = String(value || '').trim();
  if (!ip) return '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return (mapped ? mapped[1] : ip).slice(0, 128);
}

/**
 * The viewer of a public share request: the address as Express derives it
 * through the app's `trust proxy` setting (a forwarded header from an
 * untrusted peer is ignored), the user agent, and the edge's country, read
 * only when the request came through a trusted proxy.
 */
export function readShareRequestViewer(req) {
  const ip = normalizeViewerIp(req?.ip || req?.socket?.remoteAddress || '');
  const userAgent = cleanText(req?.headers?.['user-agent'], USER_AGENT_MAX);
  let country = '';
  const trust = typeof req?.app?.get === 'function' ? req.app.get('trust proxy fn') : null;
  const peer = String(req?.socket?.remoteAddress || '').trim();
  if (typeof trust === 'function' && peer && trust(peer, 0)) {
    const header = String(req?.headers?.['cf-ipcountry'] || '').trim().toUpperCase();
    if (/^[A-Z0-9]{2}$/.test(header)) country = header;
  }
  return { ip, userAgent, country };
}

export function createShareAccessLog({
  repository,
  now = () => Date.now(),
  idleMs = SHARE_OPEN_IDLE_MS,
  reloadDedupeMs = SHARE_OPEN_RELOAD_DEDUPE_MS,
  maxTrackedViewers = DEFAULT_MAX_TRACKED_VIEWERS,
} = {}) {
  // `${lineageId}:${viewerKey}` -> { seenAt, openedAt } (epoch ms)
  const viewers = new Map();

  function viewerKeyFor(ip, userAgent) {
    return createHmac('sha256', repository.readViewerKeySecret())
      .update(`${ip || ''}\n${userAgent || ''}`)
      .digest('hex')
      .slice(0, 32);
  }

  function prune(at) {
    for (const [key, entry] of viewers) {
      if (at - entry.seenAt > idleMs) viewers.delete(key);
    }
    if (viewers.size <= maxTrackedViewers) return;
    const oldest = [...viewers.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [key] of oldest.slice(0, viewers.size - maxTrackedViewers)) viewers.delete(key);
  }

  /**
   * Called for every successful read of a share. Logs an open when the rules
   * above say so; `storeIp` false keeps the address out of the row.
   */
  function noteFetch({ share, viewer, opened = false, storeIp = true }) {
    const at = Number(now());
    const viewerKey = viewerKeyFor(viewer?.ip, viewer?.userAgent);
    const key = `${share.lineageId}:${viewerKey}`;
    let entry = viewers.get(key);
    if (!entry) {
      const lastOpen = Date.parse(repository.lastOpenAt(share.lineageId, viewerKey) || '');
      if (Number.isFinite(lastOpen)) entry = { seenAt: lastOpen, openedAt: lastOpen };
    }
    const isOpen = !entry
      || (opened ? at - entry.openedAt > reloadDedupeMs : at - entry.seenAt > idleMs);
    let recorded = false;
    if (isOpen) {
      recorded = repository.recordOpen({
        lineageId: share.lineageId,
        conversationId: share.conversationId,
        openedAt: new Date(at).toISOString(),
        ip: storeIp ? viewer?.ip || null : null,
        userAgent: viewer?.userAgent || null,
        country: viewer?.country || null,
        viewerKey,
      });
    }
    viewers.set(key, { seenAt: at, openedAt: isOpen ? at : entry.openedAt });
    prune(at);
    return { opened: isOpen, recorded, viewerKey };
  }

  return { noteFetch, viewerKeyFor };
}
