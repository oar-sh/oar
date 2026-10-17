'use strict';

import { URL } from 'url';

import { buildAcceptedWorkerPaths } from './session-worker-websocket-service.mjs';
import { createLocalRequestCheck, resolveTunnelMarkerHeaders } from './request-boundary.mjs';

function requestPathname(req) {
  const rawUrl = String(req?.url || '/');
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    return rawUrl.split('?')[0] || '/';
  }
}

/**
 * Blocks session-worker WebSocket paths for every request that is not truly
 * local (request-boundary.mjs): a peer that is not loopback, an edge marker
 * header, or a forwarding header. Session workers are spawned by the relay on
 * its own machine and connect over 127.0.0.1 without any of these. The guard
 * keys off *the path being a worker path*, never off "unauthenticated request
 * bearing cf-ray" — shared conversations legitimately arrive over Cloudflare
 * with no credentials and must keep working.
 */
export function createTunnelWorkerPathGuard({
  pathPrefix = '',
  extraMarkerHeaders = [],
  localRequestCheck = null,
  logger = console,
} = {}) {
  const workerPaths = new Set(buildAcceptedWorkerPaths(pathPrefix));
  const localCheck = localRequestCheck
    || createLocalRequestCheck({ markerHeaders: resolveTunnelMarkerHeaders(extraMarkerHeaders) });
  const markerHeaders = localCheck.markerHeaders;

  function isWorkerPath(pathname) {
    if (workerPaths.has(pathname)) return true;
    // The prefix is stripped later in the express pipeline, so tolerate both forms.
    for (const workerPath of workerPaths) {
      if (pathname === workerPath || pathname === `${workerPath}/`) return true;
    }
    return false;
  }

  function describeRefusal(refusal) {
    if (!refusal) return null;
    if (refusal.reason === 'peer') return 'a non-loopback peer';
    return refusal.header;
  }

  function evaluate(req, socket = null) {
    const pathname = requestPathname(req);
    if (!isWorkerPath(pathname)) return { blocked: false, pathname, marker: null };
    const refusal = localCheck.explain({ headers: req?.headers, socket: req?.socket || socket });
    if (!refusal) return { blocked: false, pathname, marker: null };
    return { blocked: true, pathname, marker: describeRefusal(refusal), reason: refusal.reason };
  }

  // Express middleware: 403 the request before any auth middleware runs.
  function requestMiddleware(req, res, next) {
    const result = evaluate(req);
    if (!result.blocked) {
      next();
      return;
    }
    logger?.warn?.(`[tunnel-guard] Blocked session-worker path ${result.pathname}: not local (${result.marker})`);
    res.status(403).json({ error: 'Session worker endpoints are reachable from this machine only' });
  }

  // Raw upgrade guard: destroy the socket before the WebSocket handshake.
  function handleUpgrade(req, socket) {
    const result = evaluate(req, socket);
    if (!result.blocked) return false;
    logger?.warn?.(`[tunnel-guard] Blocked session-worker upgrade ${result.pathname}: not local (${result.marker})`);
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
