'use strict';

import { URL } from 'url';

import { buildAcceptedWorkerPaths } from './session-worker-websocket-service.mjs';

// Cloudflare's edge stamps `cf-ray` on every proxied request and a remote client
// cannot strip it, so its presence means the request came in over the tunnel
// rather than from a local session worker on 127.0.0.1.
const DEFAULT_TUNNEL_MARKER_HEADERS = ['cf-ray'];

function normalizeHeaderName(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeMarkerHeaders(extraHeaders) {
  const names = [...DEFAULT_TUNNEL_MARKER_HEADERS];
  const extras = Array.isArray(extraHeaders)
    ? extraHeaders
    : String(extraHeaders || '').split(',');
  for (const entry of extras) {
    const name = normalizeHeaderName(entry);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function requestPathname(req) {
  const rawUrl = String(req?.url || '/');
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return rawUrl.split('?')[0] || '/';
  }
}

/**
 * Blocks session-worker WebSocket paths when the request arrived through a
 * public tunnel. The guard keys off *the path being a worker path*, never off
 * "unauthenticated request bearing cf-ray" — shared conversations legitimately
 * arrive over Cloudflare with no credentials and must keep working.
 */
export function createTunnelWorkerPathGuard({
  pathPrefix = '',
  extraMarkerHeaders = [],
  logger = console,
} = {}) {
  const workerPaths = new Set(buildAcceptedWorkerPaths(pathPrefix));
  const markerHeaders = normalizeMarkerHeaders(extraMarkerHeaders);

  function isWorkerPath(pathname) {
    if (workerPaths.has(pathname)) return true;
    // The prefix is stripped later in the express pipeline, so tolerate both forms.
    for (const workerPath of workerPaths) {
      if (pathname === workerPath || pathname === `${workerPath}/`) return true;
    }
    return false;
  }

  function matchedMarkerHeader(headers) {
    if (!headers) return null;
    for (const name of markerHeaders) {
      const value = headers[name];
      if (typeof value === 'string' ? value.trim() : value) return name;
    }
    return null;
  }

  function evaluate(req) {
    const pathname = requestPathname(req);
    if (!isWorkerPath(pathname)) return { blocked: false, pathname, marker: null };
    const marker = matchedMarkerHeader(req?.headers);
    if (!marker) return { blocked: false, pathname, marker: null };
    return { blocked: true, pathname, marker };
  }

  // Express middleware: 403 the request before any auth middleware runs.
  function requestMiddleware(req, res, next) {
    const result = evaluate(req);
    if (!result.blocked) {
      next();
      return;
    }
    logger?.warn?.(`[tunnel-guard] Blocked session-worker path ${result.pathname} carrying ${result.marker}`);
    res.status(403).json({ error: 'Session worker endpoints are not reachable through the tunnel' });
  }

  // Raw upgrade guard: destroy the socket before the WebSocket handshake.
  function handleUpgrade(req, socket) {
    const result = evaluate(req);
    if (!result.blocked) return false;
    logger?.warn?.(`[tunnel-guard] Blocked session-worker upgrade ${result.pathname} carrying ${result.marker}`);
    try {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    } catch {}
    try { socket.destroy(); } catch {}
    return true;
  }

  return {
    markerHeaders,
    workerPaths: [...workerPaths],
    evaluate,
    requestMiddleware,
    handleUpgrade,
  };
}
