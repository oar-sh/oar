// File capabilities (`k`) for the page's native loads of files by path.
//
// GET /api/drives/file and /api/files/* do not open on the session cookie
// alone: a fetch of the app carries the session's proof key, but an <img>,
// a <video> (and its Range requests), a download link or a PDF opened in a
// new tab cannot. Those addresses carry a capability instead, `k`, which the
// relay makes at POST /api/files/capability (asked with the proof key): an
// HMAC bound to this browser session and the one file, valid for at most
// ten minutes. Its expiry is readable in the value itself
// (`fc1.<session>.<expiry s, base 36>.<mac>`), the rest is the relay's.
//
// How the page uses them:
//   - builders that can (the markdown sanitizer, the file viewer, the
//     attachment cards) take a fresh `k` from the cache here; without one a
//     media element gets its address in `data-oar-file-src` instead of
//     `src`, so nothing loads before the capability is there;
//   - installFileCapabilityPolicy watches the document: every such address
//     in `src`, `href`, `data-oar-file-src` or `data-viewer-open-tab` gets
//     its `k` (one request for many), links get a new one before theirs
//     runs out, and a media element whose load fails on its address gets a
//     new `k` once (a video goes on where it was).

import { SESSION_PROOF_STORAGE_KEY } from './session-proof.mjs';

export const FILE_CAPABILITY_PARAM = 'k';
export const DEFERRED_FILE_SRC_ATTR = 'data-oar-file-src';
const OPEN_TAB_ATTR = 'data-viewer-open-tab';
// A cached `k` with less than this left is not handed out for a new load.
const USE_MARGIN_MS = 60_000;
// Links get a new `k` when theirs has less than this left.
const REFRESH_MARGIN_MS = 3 * 60_000;
const REFRESH_INTERVAL_MS = 60_000;
// A media element is given a new `k` after a failed load at most this often:
// a missing file fails twice and is left to fail.
const RETRY_GAP_MS = 60_000;
const MAX_BATCH = 100;
// Parameters that do not change which file an address names.
const NON_PATH_PARAMS = new Set([FILE_CAPABILITY_PARAM, 'v', 'as']);
const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'AUDIO', 'SOURCE', 'IFRAME', 'EMBED']);
// Elements that may hold a file address (narrowed by text; checked exactly).
const FILE_ADDRESS_SELECTOR = [
  `[${DEFERRED_FILE_SRC_ATTR}]`,
  `[${OPEN_TAB_ATTR}]`,
  ...['img', 'video', 'audio', 'source', 'iframe', 'embed'].flatMap((tag) => [`${tag}[src*="/api/files/"]`, `${tag}[src*="/api/drives/file"]`]),
  'a[href*="/api/files/"]',
  'a[href*="/api/drives/file"]',
].join(', ');

let settings = {
  base: '',
  mint: null,
  now: () => Date.now(),
  origin: () => (typeof window !== 'undefined' ? window.location.origin : 'http://localhost'),
};
// key (the address without k, v, as) → { k, expMs }
const cache = new Map();
let queue = null;
// Bumped by resetFileCapabilities (sign-out, sign-in): an answer to a
// request made before it brings no `k` into the cache or the page.
let generation = 0;
// Every `k` handed out since the last reset (k → expMs), and those of the
// sessions before it: a link of the page still carrying one of the latter
// is given a new `k` at the next look, like one about to run out.
let issued = new Map();
const retired = new Map();

/**
 * `base`: the app's base path; `mint(urls)`: the POST to
 * /api/files/capability, resolving `{ urls }` (or null).
 */
export function configureFileCapabilities(options = {}) {
  settings = { ...settings, ...options };
}

function pruneExpired(map) {
  const now = settings.now();
  for (const [k, expMs] of map) if (expMs <= now) map.delete(k);
}

/**
 * Signed out, or signed in as a new session: every `k` cached so far
 * belonged to the session before and is forgotten, any queued request is
 * dropped, and an answer still on its way is ignored (its `k` is retired
 * too). Links of the page that still carry an old `k` get a new one at the
 * next look (hydrateFileCapabilities, the policy's timer).
 */
export function resetFileCapabilities() {
  generation += 1;
  pruneExpired(retired);
  for (const [k, expMs] of issued) retired.set(k, expMs);
  issued = new Map();
  cache.clear();
  const dropped = queue;
  queue = null;
  for (const list of dropped?.waiters.values() || []) for (const resolve of list) resolve('');
}

function isRetiredCapability(k) {
  if (!k || !retired.has(k)) return false;
  if (retired.get(k) > settings.now()) return true;
  retired.delete(k);
  return false;
}

function parsedSameOrigin(url) {
  const text = String(url || '').trim();
  if (!text || /^(?:data|blob|javascript):/i.test(text)) return null;
  try {
    const parsed = new URL(text, `${settings.origin()}/`);
    return parsed.origin === settings.origin() ? parsed : null;
  } catch {
    return null;
  }
}

function appPathOf(pathname) {
  const base = String(settings.base || '').replace(/\/+$/, '');
  if (base && (pathname === base || pathname.startsWith(`${base}/`))) return pathname.slice(base.length);
  return pathname;
}

/**
 * The cache key of a file-by-path address (its path and the parameters that
 * choose the file, as an address relative to the origin), or '' for any
 * other address.
 */
export function fileCapabilityKeyOf(url) {
  const parsed = parsedSameOrigin(url);
  if (!parsed) return '';
  const appPath = appPathOf(parsed.pathname);
  if (appPath !== '/api/drives/file' && !(appPath.startsWith('/api/files/') && appPath.length > '/api/files/'.length)) return '';
  const kept = [];
  for (const [name, value] of parsed.searchParams) {
    if (!NON_PATH_PARAMS.has(name)) kept.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  return `${parsed.pathname}${kept.length ? `?${kept.join('&')}` : ''}`;
}

/** Is this an address of GET /api/drives/file or /api/files/*? */
export function isFileCapabilityUrl(url) {
  return !!fileCapabilityKeyOf(url);
}

function expiryOfCapability(k) {
  const parts = String(k || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'fc1') return 0;
  const seconds = parseInt(parts[2], 36);
  return Number.isFinite(seconds) ? seconds * 1000 : 0;
}

function capabilityIn(url) {
  const parsed = parsedSameOrigin(url);
  return parsed ? String(parsed.searchParams.get(FILE_CAPABILITY_PARAM) || '') : '';
}

/** When the `k` in `url` runs out (ms), or 0 for none. */
export function fileCapabilityExpiry(url) {
  return expiryOfCapability(capabilityIn(url));
}

/**
 * Does `url` carry a `k` with more than `marginMs` left (and not one of a
 * session signed out since)?
 */
export function hasFreshFileCapability(url, marginMs = USE_MARGIN_MS) {
  const k = capabilityIn(url);
  return expiryOfCapability(k) - settings.now() > marginMs && !isRetiredCapability(k);
}

/** `url` with `k` set (any earlier `k` taken out); the rest as written. */
export function withFileCapability(url, k) {
  const text = String(url || '');
  const hashAt = text.indexOf('#');
  const head = hashAt >= 0 ? text.slice(0, hashAt) : text;
  const hash = hashAt >= 0 ? text.slice(hashAt) : '';
  const queryAt = head.indexOf('?');
  const pathPart = queryAt >= 0 ? head.slice(0, queryAt) : head;
  const kept = (queryAt >= 0 ? head.slice(queryAt + 1) : '')
    .split('&')
    .filter((pair) => pair && pair.split('=')[0] !== FILE_CAPABILITY_PARAM);
  if (k) kept.push(`${FILE_CAPABILITY_PARAM}=${encodeURIComponent(k)}`);
  return `${pathPart}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}

function cachedCapability(key, marginMs = USE_MARGIN_MS) {
  const entry = cache.get(key);
  if (!entry) return '';
  if (entry.expMs - settings.now() > marginMs) return entry.k;
  if (entry.expMs <= settings.now()) cache.delete(key);
  return '';
}

/**
 * `url` with a fresh cached `k`, when there is one; else `url` as it is
 * (any other address, or one whose `k` must still be asked for).
 */
export function withCachedFileCapability(url, marginMs = USE_MARGIN_MS) {
  const key = fileCapabilityKeyOf(url);
  if (!key) return url;
  if (hasFreshFileCapability(url, marginMs)) return url;
  const k = cachedCapability(key, marginMs);
  return k ? withFileCapability(url, k) : url;
}

function flush() {
  const batch = queue;
  queue = null;
  if (!batch) return;
  const askedIn = generation;
  pruneExpired(issued);
  const keys = [...batch.waiters.keys()];
  for (let at = 0; at < keys.length; at += MAX_BATCH) {
    const chunk = keys.slice(at, at + MAX_BATCH);
    let request;
    try {
      request = typeof settings.mint === 'function' ? Promise.resolve(settings.mint(chunk)) : Promise.resolve(null);
    } catch {
      request = Promise.resolve(null);
    }
    request.catch(() => null).then((answer) => {
      const signed = Array.isArray(answer?.urls) ? answer.urls : [];
      // Asked for by a session signed out since: nothing of it is used.
      const current = askedIn === generation;
      chunk.forEach((key, index) => {
        const k = typeof signed[index] === 'string' ? capabilityIn(signed[index]) : '';
        const expMs = expiryOfCapability(k);
        const usable = !!k && expMs > settings.now();
        if (usable && current) {
          cache.set(key, { k, expMs });
          issued.set(k, expMs);
        } else if (usable) {
          retired.set(k, expMs);
        }
        for (const resolve of batch.waiters.get(key) || []) resolve(usable && current ? k : '');
      });
    });
  }
}

function requestCapability(key) {
  if (!queue) {
    queue = { waiters: new Map() };
    setTimeout(flush, 0);
  }
  return new Promise((resolve) => {
    const list = queue.waiters.get(key) || [];
    list.push(resolve);
    queue.waiters.set(key, list);
  });
}

/**
 * Each address with a fresh `k` (asked for in one request); any other
 * address, or one the relay gave none for, comes back as it was. `force`
 * asks anew even with a fresh `k` in the cache (a load that failed on it).
 */
export async function signFileUrls(urls, { force = false, marginMs = USE_MARGIN_MS } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  return Promise.all(list.map(async (url) => {
    const key = fileCapabilityKeyOf(url);
    if (!key) return url;
    if (!force) {
      const k = cachedCapability(key, marginMs);
      if (k) return withFileCapability(url, k);
    } else {
      cache.delete(key);
    }
    const k = await requestCapability(key);
    return k ? withFileCapability(url, k) : url;
  }));
}

export async function signFileUrl(url, options = {}) {
  const [signed] = await signFileUrls([url], options);
  return signed;
}

function escAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The source attribute for a media element in HTML text: `src="…"` with a
 * cached `k`, or the address in `data-oar-file-src` until one is there (any
 * other address: a plain `src`).
 */
export function fileSrcAttribute(url) {
  const signed = withCachedFileCapability(url);
  if (isFileCapabilityUrl(signed) && !hasFreshFileCapability(signed)) {
    return `${DEFERRED_FILE_SRC_ATTR}="${escAttr(url)}"`;
  }
  return `src="${escAttr(signed)}"`;
}

/**
 * The same for an element not yet in the document (it must not be: an
 * element of the page loads its `src` at once): `src` gets a cached `k`, or
 * moves to `data-oar-file-src`. True when the address is a file address.
 */
export function deferFileSrc(element) {
  const src = String(element?.getAttribute?.('src') || '').trim();
  if (!src || !isFileCapabilityUrl(src)) return false;
  setFileSrc(element, src);
  return true;
}

/**
 * Points a media element at `url`: with a cached `k` when it is a file
 * address, or in `data-oar-file-src` (no `src`, so no load) until there is
 * one; any other address goes into `src` as it is.
 */
export function setFileSrc(element, url) {
  const signed = withCachedFileCapability(url);
  if (isFileCapabilityUrl(signed) && !hasFreshFileCapability(signed)) {
    element.removeAttribute('src');
    element.setAttribute(DEFERRED_FILE_SRC_ATTR, url);
    return;
  }
  element.removeAttribute(DEFERRED_FILE_SRC_ATTR);
  if (element.getAttribute('src') !== signed) element.setAttribute('src', signed);
}

function reloadMediaOf(element) {
  if (element.tagName === 'SOURCE') {
    const media = element.parentElement;
    if (media && typeof media.load === 'function') {
      try { media.load(); } catch {}
    }
  }
}

function setSignedAttr(element, attr, before, signed) {
  if (!signed || signed === before) return;
  // Only when nothing else changed the address in the meantime.
  if (attr === DEFERRED_FILE_SRC_ATTR) {
    if (element.getAttribute(DEFERRED_FILE_SRC_ATTR) !== before) return;
    if (!hasFreshFileCapability(signed, 0)) return;
    element.removeAttribute(DEFERRED_FILE_SRC_ATTR);
    element.setAttribute('src', signed);
    reloadMediaOf(element);
    return;
  }
  if (element.getAttribute(attr) !== before) return;
  element.setAttribute(attr, signed);
  if (attr === 'src') reloadMediaOf(element);
}

/** The file addresses in and under `root` that need a `k`: [{ element, attr, url }]. */
function staleFileAddresses(root, { refreshLinks = false } = {}) {
  const found = [];
  const visit = (element) => {
    if (!element?.getAttribute) return;
    const deferred = element.getAttribute(DEFERRED_FILE_SRC_ATTR);
    if (deferred) found.push({ element, attr: DEFERRED_FILE_SRC_ATTR, url: deferred });
    const tag = String(element.tagName || '').toUpperCase();
    if (MEDIA_TAGS.has(tag)) {
      const src = element.getAttribute('src');
      // A media element is given a `k` once; a later one only after a failed load.
      if (src && isFileCapabilityUrl(src) && !capabilityIn(src)) found.push({ element, attr: 'src', url: src });
    }
    const links = [];
    if (tag === 'A' && element.getAttribute('href')) links.push('href');
    if (element.hasAttribute(OPEN_TAB_ATTR)) links.push(OPEN_TAB_ATTR);
    for (const attr of links) {
      const url = element.getAttribute(attr);
      if (!isFileCapabilityUrl(url)) continue;
      const k = capabilityIn(url);
      if (!k || isRetiredCapability(k) || (refreshLinks && !hasFreshFileCapability(url, REFRESH_MARGIN_MS))) found.push({ element, attr, url });
    }
  };
  if (root?.nodeType === 1) visit(root);
  root?.querySelectorAll?.(FILE_ADDRESS_SELECTOR).forEach(visit);
  return found;
}

/**
 * Gives every file address in and under `root` its `k` (one request).
 * `refreshLinks`: links whose `k` runs out soon get a new one too.
 */
export async function hydrateFileCapabilities(root, { refreshLinks = false } = {}) {
  const found = staleFileAddresses(root, { refreshLinks });
  if (!found.length) return 0;
  const signed = await signFileUrls(found.map((entry) => entry.url), { marginMs: refreshLinks ? REFRESH_MARGIN_MS : USE_MARGIN_MS });
  found.forEach((entry, index) => setSignedAttr(entry.element, entry.attr, entry.url, signed[index]));
  return found.length;
}

/**
 * A media element whose load failed on a file address: a new `k`, at most
 * once a minute per element (a missing file is then left to fail). A video
 * or audio goes on from where it was. True when a new load was started; the
 * failure is then not passed on.
 */
export function retryFileLoad(element, { retried, onDone = () => {} } = {}) {
  const tag = String(element?.tagName || '').toUpperCase();
  if (!MEDIA_TAGS.has(tag)) return false;
  const src = String(element.getAttribute('src') || '');
  if (!isFileCapabilityUrl(src)) return false;
  const last = retried?.get(element) || 0;
  if (last && settings.now() - last < RETRY_GAP_MS) return false;
  retried?.set(element, settings.now());
  const media = tag === 'SOURCE' ? element.parentElement : element;
  const resumeAt = Number(media?.currentTime) || 0;
  const wasPlaying = media && typeof media.paused === 'boolean' ? !media.paused || media.autoplay : false;
  void signFileUrl(src, { force: true }).then((signed) => {
    if (!signed || signed === src || element.getAttribute('src') !== src) {
      onDone(false);
      return;
    }
    if (tag !== 'IMG' && media && (resumeAt > 0 || wasPlaying)) {
      media.addEventListener('loadedmetadata', () => {
        if (resumeAt > 0) { try { media.currentTime = resumeAt; } catch {} }
        if (wasPlaying) { try { media.play?.()?.catch?.(() => {}); } catch {} }
      }, { once: true });
    }
    element.setAttribute('src', signed);
    reloadMediaOf(element);
    onDone(true);
  });
  return true;
}

/**
 * Watches `documentRef` for file addresses (added, or set later) and gives
 * them their `k`; keeps links' `k` fresh while the page is open; gives a
 * failed media load one new `k`. Install before any other document-level
 * error listener that should see only real failures.
 */
export function installFileCapabilityPolicy({ documentRef = document, intervalMs = REFRESH_INTERVAL_MS } = {}) {
  const root = documentRef?.documentElement;
  if (!root || root.dataset.fileCapabilityPolicy === 'installed') return () => {};
  root.dataset.fileCapabilityPolicy = 'installed';
  const retried = new WeakMap();

  let pendingNodes = null;
  const schedule = (node) => {
    if (!pendingNodes) {
      pendingNodes = new Set();
      queueMicrotask(() => {
        const nodes = pendingNodes;
        pendingNodes = null;
        for (const each of nodes) {
          if (each.isConnected === false) continue;
          void hydrateFileCapabilities(each);
        }
      });
    }
    pendingNodes.add(node);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') schedule(record.target);
      for (const node of record.addedNodes || []) {
        if (node?.nodeType === 1) schedule(node);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['src', 'href', DEFERRED_FILE_SRC_ATTR, OPEN_TAB_ATTR],
  });

  const onError = (event) => {
    const target = event?.target;
    if (!target || target.nodeType !== 1) return;
    if (retryFileLoad(target, { retried })) {
      // The page's own handlers see only a load that failed with a fresh `k`.
      event.stopImmediatePropagation();
    }
  };
  documentRef.addEventListener('error', onError, true);

  const refresh = () => { void hydrateFileCapabilities(root, { refreshLinks: true }); };
  const timer = setInterval(refresh, Math.max(1_000, Number(intervalMs) || REFRESH_INTERVAL_MS));
  // Timers sleep with a hidden page: back in view, links are checked at once.
  const onVisible = () => { if (documentRef.visibilityState !== 'hidden') refresh(); };
  documentRef.addEventListener('visibilitychange', onVisible);
  documentRef.defaultView?.addEventListener?.('pageshow', onVisible);
  documentRef.defaultView?.addEventListener?.('focus', onVisible);

  // Another tab of this browser signed out or in anew: the proof key they
  // share changed under this page, which sees no 401 for it, so the `k`s of
  // the session before go here too.
  const onStorage = (event) => {
    const key = event?.key;
    if (key !== null && key !== SESSION_PROOF_STORAGE_KEY) return;
    if (key !== null && event.oldValue === event.newValue) return;
    resetFileCapabilities();
    refresh();
  };
  documentRef.defaultView?.addEventListener?.('storage', onStorage);

  void hydrateFileCapabilities(root);

  return () => {
    observer.disconnect();
    documentRef.defaultView?.removeEventListener?.('storage', onStorage);
    clearInterval(timer);
    documentRef.removeEventListener('error', onError, true);
    documentRef.removeEventListener('visibilitychange', onVisible);
    documentRef.defaultView?.removeEventListener?.('pageshow', onVisible);
    documentRef.defaultView?.removeEventListener?.('focus', onVisible);
    delete root.dataset.fileCapabilityPolicy;
  };
}
