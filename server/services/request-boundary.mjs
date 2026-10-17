'use strict';

// Where a request came from, as far as the relay can tell.
//
// "Truly local" is the boundary for the few things only a process on the
// relay's own machine may do (run an image operation, open a session-worker
// socket): the TCP peer is loopback AND nothing in front of the relay touched
// the request. A same-host reverse proxy (Caddy, nginx), a hand-run
// cloudflared and the built-in tunnel all connect from 127.0.0.1 too, so the
// peer alone proves nothing; what tells them apart is what they add: an edge
// marker (`cf-ray`, or a configured one) or a forwarding header. Local workers
// and agent tools call the relay over 127.0.0.1 and send none of these.
//
// A forwarder that adds no header at all (an SSH reverse tunnel, a bare TCP
// proxy) cannot be told apart from a local process; the access token is then
// the only boundary, as it is for every other route.

// Cloudflare's edge stamps `cf-ray` on every proxied request and a remote
// client cannot strip it.
export const DEFAULT_TUNNEL_MARKER_HEADERS = Object.freeze(['cf-ray']);

// Headers a proxy adds to say who it forwards for. Read here only as a trace
// that a proxy was involved, never as an address.
export const FORWARDING_HEADERS = Object.freeze(['x-forwarded-for', 'forwarded', 'x-real-ip']);

function normalizeHeaderName(value) {
  return String(value || '').trim().toLowerCase();
}

function headerNamesFrom(source) {
  if (Array.isArray(source)) return source;
  if (source === undefined || source === null) return [];
  return String(source).split(',');
}

/**
 * The marker headers to look for: `cf-ray` always, plus every name from every
 * source given (an array or a comma-separated string). Sources are merged,
 * none replaces another, so `tunnelMarkerHeaders: []` in the config does not
 * switch off COPILOT_TUNNEL_MARKER_HEADERS.
 */
export function resolveTunnelMarkerHeaders(...sources) {
  const names = [...DEFAULT_TUNNEL_MARKER_HEADERS];
  for (const source of sources) {
    for (const entry of headerNamesFrom(source)) {
      const name = normalizeHeaderName(entry);
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** 127.0.0.0/8 and ::1, plain or IPv4-mapped. */
export function isLoopbackAddress(value) {
  let text = String(value || '').trim().toLowerCase();
  if (!text) return false;
  if (text === '::1' || text === '0:0:0:0:0:0:0:1') return true;
  if (text.startsWith('::ffff:')) text = text.slice(7);
  if (text === '7f00:1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(text);
}

function headerPresent(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value.some((entry) => String(entry || '').trim());
  return typeof value === 'string' ? !!value.trim() : !!value;
}

function peerAddressOf(req) {
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
}

/**
 * `markerHeaders`: names as resolveTunnelMarkerHeaders returns them (the
 * default `cf-ray` is added if missing).
 */
export function createLocalRequestCheck({ markerHeaders = DEFAULT_TUNNEL_MARKER_HEADERS } = {}) {
  const markers = resolveTunnelMarkerHeaders(markerHeaders);

  function matchedMarkerHeader(headers) {
    for (const name of markers) {
      if (headerPresent(headers, name)) return name;
    }
    return null;
  }

  function matchedForwardingHeader(headers) {
    for (const name of FORWARDING_HEADERS) {
      if (headerPresent(headers, name)) return name;
    }
    return null;
  }

  /**
   * Why a request is not truly local: `{ reason: 'peer' | 'marker' |
   * 'forwarded', header }`, or null when it is.
   */
  function explain(req) {
    if (!isLoopbackAddress(peerAddressOf(req))) return { reason: 'peer', header: null };
    const marker = matchedMarkerHeader(req?.headers);
    if (marker) return { reason: 'marker', header: marker };
    const forwarded = matchedForwardingHeader(req?.headers);
    if (forwarded) return { reason: 'forwarded', header: forwarded };
    return null;
  }

  function isTrulyLocal(req) {
    return explain(req) === null;
  }

  return {
    markerHeaders: markers,
    matchedMarkerHeader,
    explain,
    isTrulyLocal,
  };
}

function trustsPeer(req) {
  const trust = typeof req?.app?.get === 'function' ? req.app.get('trust proxy fn') : null;
  return typeof trust === 'function' && trust(peerAddressOf(req), 0) === true;
}

function firstListEntry(value) {
  return String(Array.isArray(value) ? value[0] : (value || '')).split(',')[0].trim();
}

/**
 * The host (with port) the client addressed: X-Forwarded-Host when the
 * immediate peer is a trusted proxy (Express `trust proxy`), else Host. A
 * direct client cannot forge it. Express's own `req.hostname` drops the port,
 * which a LAN address needs.
 */
export function requestHostOf(req) {
  if (trustsPeer(req)) {
    const forwardedHost = firstListEntry(req?.headers?.['x-forwarded-host']);
    if (forwardedHost) return forwardedHost;
  }
  return firstListEntry(req?.headers?.host);
}

/** An Express-style view of a raw request (a socket.io handshake), so `ip`, `protocol` and the trust checks follow `trust proxy`. */
export function expressRequestView(app, rawReq) {
  const view = Object.create(app.request);
  view.headers = rawReq?.headers || {};
  view.socket = rawReq?.socket || rawReq?.connection || null;
  view.connection = view.socket;
  view.method = rawReq?.method;
  view.url = rawReq?.url;
  return view;
}

function normalizedHost(protocol, host) {
  try {
    return new URL(`${protocol}//${host}`).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Same-origin check for a browser handshake. No Origin header (a non-browser
 * client) passes; otherwise the Origin's host must be the host the request
 * was addressed to (see requestHostOf), or be listed in `allowedOrigins`.
 */
export function isSameOriginRequest(req, { allowedOrigins = [] } = {}) {
  const origin = firstListEntry(req?.headers?.origin);
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === 'null') return false;
  const allowed = (Array.isArray(allowedOrigins) ? allowedOrigins : headerNamesFrom(allowedOrigins))
    .map((entry) => String(entry || '').trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  if (allowed.includes(parsed.origin.toLowerCase())) return true;
  const host = requestHostOf(req);
  if (!host) return false;
  return normalizedHost(parsed.protocol, host) === parsed.host.toLowerCase();
}
