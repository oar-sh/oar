'use strict';

import http from 'http';

import { parsePreviewPath } from './preview-registry-service.mjs';
import { serveStaticPreview } from './preview-static-handler.mjs';

// The preview listener. A bare http.Server on its own loopback port whose
// handler has exactly two outcomes: proxy to a registered upstream, or an error
// page. The relay's express app, auth middleware, socket.io, static files and
// /api routes are NOT mounted here — preview traffic cannot reach relay
// functionality because none of it exists on this port.

// RFC 9110 §7.6.1: connection-specific headers must not be forwarded by a proxy.
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// Response headers the preview lane owns and must not inherit from the upstream.
// Service-Worker-Allowed matters most: every preview shares one origin, so an
// upstream that widened its worker scope to "/" could intercept another
// preview's traffic.
const STRIPPED_RESPONSE_HEADERS = new Set([
  'service-worker-allowed',
  'x-robots-tag',
]);

const CONNECT_TIMEOUT_MS = 10_000;
const RELAY_COOKIE_NAMES = ['copilot_auth'];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/**
 * Removes relay credentials from a Cookie header. The preview app is a
 * different origin, so a browser never sends these — but a hand-crafted request
 * (curl, a webhook, a misconfigured front proxy) could, and the previewed app
 * has no business seeing the relay's session token.
 */
export function stripRelayCookies(cookieHeader, cookieNames = RELAY_COOKIE_NAMES) {
  const text = String(cookieHeader || '');
  if (!text) return '';
  const names = cookieNames.map((name) => String(name || '').toLowerCase());
  const kept = text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const name = part.split('=')[0].trim().toLowerCase();
      return !names.includes(name);
    });
  return kept.join('; ');
}

export function sanitizeRequestHeaders(headers = {}, {
  targetHost,
  targetPort,
  basePath,
  forwardedHost = '',
  forwardedProto = 'https',
  forwardedFor = '',
  cookieNames = RELAY_COOKIE_NAMES,
  bearerTokens = [],
} = {}) {
  const out = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (name === 'host') continue;
    if (name === 'cookie') {
      const cookie = stripRelayCookies(value, cookieNames);
      if (cookie) out.cookie = cookie;
      continue;
    }
    if (name === 'authorization') {
      // Only the relay's own bearer token is withheld; an app's Basic/Bearer
      // auth is legitimate traffic and must pass through.
      const presented = String(value || '').replace(/^Bearer\s+/i, '').trim();
      if (presented && bearerTokens.some((token) => token && token === presented)) continue;
      out.authorization = value;
      continue;
    }
    out[name] = value;
  }

  // Dev servers with host checks (Vite, webpack-dev-server) expect their own
  // host, so the upstream Host is the target, and the public one travels in
  // X-Forwarded-Host alongside the prefix the app needs for its base path.
  out.host = `${targetHost}:${targetPort}`;
  if (basePath) out['x-forwarded-prefix'] = basePath.replace(/\/$/, '');
  if (forwardedHost) out['x-forwarded-host'] = forwardedHost;
  out['x-forwarded-proto'] = forwardedProto;
  if (forwardedFor) out['x-forwarded-for'] = forwardedFor;
  return out;
}

/**
 * Rewrites an upstream Location so a server-side redirect lands back inside the
 * preview prefix instead of at the preview origin's root.
 */
export function rewriteLocation(location, { basePath, targetHost, targetPort }) {
  const value = String(location || '');
  if (!value) return value;
  const prefix = basePath.replace(/\/$/, '');

  if (value.startsWith('//')) return value;
  if (value.startsWith('/')) {
    return value.startsWith(`${prefix}/`) || value === prefix ? value : `${prefix}${value}`;
  }
  // An absolute redirect back to the upstream's own address (dev servers emit
  // these) is rewritten to the equivalent preview path; anything pointing
  // elsewhere is left alone, since it is an intentional off-site redirect.
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  const sameUpstream = parsed.hostname === targetHost
    && Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) === Number(targetPort);
  if (!sameUpstream) return value;
  return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Scopes an upstream cookie to this preview. Previews share one origin, so
 * without this a Path=/ cookie from one preview would be sent to every other
 * one; Domain is dropped for the same reason. A cookie impersonating a relay
 * credential is discarded outright.
 */
export function rewriteSetCookie(setCookieValue, { basePath, cookieNames = RELAY_COOKIE_NAMES } = {}) {
  const value = String(setCookieValue || '');
  if (!value) return null;
  const name = value.split('=')[0].trim().toLowerCase();
  if (cookieNames.map((entry) => String(entry).toLowerCase()).includes(name)) return null;

  const parts = value.split(';').map((part) => part.trim()).filter(Boolean);
  const kept = parts.filter((part, index) => {
    if (index === 0) return true;
    const attr = part.split('=')[0].trim().toLowerCase();
    // __Host- cookies require Path=/ and no Domain; rewriting the path breaks
    // that contract, so the prefix is applied and the __Host- guarantee is
    // simply not available inside a shared preview origin.
    return attr !== 'path' && attr !== 'domain';
  });
  kept.push(`Path=${basePath}`);
  return kept.join('; ');
}

export function sanitizeResponseHeaders(headers = {}, { basePath, targetHost, targetPort }) {
  const out = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = String(rawName).toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (STRIPPED_RESPONSE_HEADERS.has(name)) continue;
    if (name === 'location') {
      out.location = rewriteLocation(value, { basePath, targetHost, targetPort });
      continue;
    }
    if (name === 'set-cookie') {
      const cookies = (Array.isArray(value) ? value : [value])
        .map((entry) => rewriteSetCookie(entry, { basePath }))
        .filter(Boolean);
      if (cookies.length) out['set-cookie'] = cookies;
      continue;
    }
    out[name] = value;
  }
  out['x-robots-tag'] = 'noindex, nofollow, noarchive';
  return out;
}

function errorPage({ title, detail }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.55 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem;
         background: #14161a; color: #e6e8ec; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { margin: 0 0 .75rem; color: #a8aebb; }
  code { background: #1e2128; padding: .1rem .35rem; border-radius: 4px; color: #e6e8ec; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${detail}</p>
<p>Served by the copilot-remote preview lane.</p></main></body></html>`;
}

function sendErrorPage(res, status, { title, detail }) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  const body = errorPage({ title, detail });
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow, noarchive',
  });
  res.end(body);
}

function clientIp(req) {
  return String(req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/**
 * Connect-only timeout. A response timeout would kill SSE and long-poll, so the
 * clock stops the moment the socket is connected.
 */
function guardConnectTimeout(upstreamReq, timeoutMs, onTimeout) {
  upstreamReq.once('socket', (socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => {
      onTimeout();
      upstreamReq.destroy(Object.assign(new Error('Preview upstream connect timeout'), {
        code: 'ETIMEDOUT',
      }));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    const clear = () => clearTimeout(timer);
    socket.once('connect', clear);
    socket.once('error', clear);
    upstreamReq.once('error', clear);
    upstreamReq.once('response', clear);
  });
}

export function createPreviewProxyServer({
  registry,
  logger = console,
  httpImpl = http,
  relayBearerTokens = [],
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
} = {}) {
  const agent = new httpImpl.Agent({ keepAlive: true, maxSockets: 64 });
  let server = null;
  // First hit per token is always logged; after that at most one line a minute,
  // so a busy dev server cannot flood the relay log.
  const lastHitLogAt = new Map();
  // Upgraded sockets are detached from the http.Server the moment the handshake
  // completes, so neither close() nor closeAllConnections() can reach them. An
  // open HMR connection would therefore hang shutdown forever unless the lane
  // tracks the pairs itself.
  const upgradedSockets = new Set();

  function trackUpgradedSocket(socket) {
    if (!socket) return;
    upgradedSockets.add(socket);
    const forget = () => upgradedSockets.delete(socket);
    socket.once('close', forget);
    socket.once('error', forget);
  }

  function logHit(entry, req) {
    const now = Date.now();
    const last = lastHitLogAt.get(entry.token) || 0;
    if (now - last < 60_000) return;
    lastHitLogAt.set(entry.token, now);
    logger?.log?.(`[preview] ${entry.token.slice(0, 8)} → :${entry.targetPort} ${req.method} ${req.url} from ${clientIp(req)}`);
  }

  function resolveRequest(req) {
    const parsed = parsePreviewPath(req.url || '/');
    if (!parsed) return { kind: 'not-found' };
    const entry = registry.resolve(parsed.token);
    if (!entry) return { kind: 'not-found' };
    if (parsed.upstreamPath === null) {
      return { kind: 'redirect', location: `${entry.basePath}${parsed.query}` };
    }
    return { kind: 'proxy', entry, upstreamPath: parsed.upstreamPath };
  }

  function handleRequest(req, res) {
    const resolved = resolveRequest(req);

    if (resolved.kind === 'not-found') {
      sendErrorPage(res, 404, {
        title: 'No such preview',
        detail: 'This preview link is unknown or has been closed.',
      });
      return;
    }

    if (resolved.kind === 'redirect') {
      // Relative asset URLs resolve against the parent path without this.
      res.writeHead(301, { location: resolved.location, 'cache-control': 'no-store' });
      res.end();
      return;
    }

    const { entry, upstreamPath } = resolved;
    registry.recordHit(entry.token);
    logHit(entry, req);

    // Static previews are answered in-process — no upstream, no forwarding.
    if (entry.mode === 'static') {
      serveStaticPreview(entry, upstreamPath, req, res, {
        sendNotFound: (response) => sendErrorPage(response, 404, {
          title: 'Not found',
          detail: 'No such file in this preview.',
        }),
      });
      return;
    }

    const headers = sanitizeRequestHeaders(req.headers, {
      targetHost: entry.targetHost,
      targetPort: entry.targetPort,
      basePath: entry.basePath,
      forwardedHost: String(req.headers.host || ''),
      forwardedProto: String(req.headers['x-forwarded-proto'] || 'https'),
      forwardedFor: clientIp(req),
      bearerTokens: relayBearerTokens,
    });

    const upstreamReq = httpImpl.request({
      host: entry.targetHost,
      port: entry.targetPort,
      method: req.method,
      path: upstreamPath,
      headers,
      agent,
    });

    let timedOut = false;
    guardConnectTimeout(upstreamReq, connectTimeoutMs, () => { timedOut = true; });

    upstreamReq.on('response', (upstreamRes) => {
      const outHeaders = sanitizeResponseHeaders(upstreamRes.headers, {
        basePath: entry.basePath,
        targetHost: entry.targetHost,
        targetPort: entry.targetPort,
      });
      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      // 204/304 and HEAD carry no body; piping one would desync the connection.
      if (req.method === 'HEAD' || upstreamRes.statusCode === 204 || upstreamRes.statusCode === 304) {
        upstreamRes.resume();
        res.end();
        return;
      }
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => { try { res.destroy(); } catch {} });
    });

    upstreamReq.on('error', (error) => {
      const refused = String(error?.code || '') === 'ECONNREFUSED';
      const detail = refused || timedOut
        ? `Nothing is listening on <code>${escapeHtml(entry.targetHost)}:${entry.targetPort}</code>. The dev server behind this preview has probably exited — restart it on the same port and reload; this link stays valid.`
        : `The upstream connection failed: <code>${escapeHtml(error?.code || error?.message || 'unknown error')}</code>.`;
      sendErrorPage(res, 502, { title: 'Preview upstream unreachable', detail });
    });

    req.on('aborted', () => { try { upstreamReq.destroy(); } catch {} });
    res.on('close', () => { try { upstreamReq.destroy(); } catch {} });
    req.pipe(upstreamReq);
  }

  // WebSocket upgrades (Vite HMR, an app's own socket) ride the same prefix.
  function handleUpgrade(req, socket, head) {
    const resolved = resolveRequest(req);
    // Static previews have nothing to upgrade to; refuse like an unknown token.
    if (resolved.kind !== 'proxy' || resolved.entry?.mode === 'static') {
      try {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      } catch {}
      try { socket.destroy(); } catch {}
      return;
    }

    const { entry, upstreamPath } = resolved;
    registry.recordHit(entry.token);

    const headers = sanitizeRequestHeaders(req.headers, {
      targetHost: entry.targetHost,
      targetPort: entry.targetPort,
      basePath: entry.basePath,
      forwardedHost: String(req.headers.host || ''),
      forwardedProto: String(req.headers['x-forwarded-proto'] || 'https'),
      forwardedFor: clientIp(req),
      bearerTokens: relayBearerTokens,
    });
    // The upgrade handshake needs exactly the hop-by-hop headers the proxy
    // strips everywhere else, so they are restored for this one request.
    headers.connection = 'Upgrade';
    headers.upgrade = String(req.headers.upgrade || 'websocket');

    const upstreamReq = httpImpl.request({
      host: entry.targetHost,
      port: entry.targetPort,
      method: req.method,
      path: upstreamPath,
      headers,
      agent: false,
    });
    guardConnectTimeout(upstreamReq, connectTimeoutMs, () => {});

    upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        for (const entryValue of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${entryValue}`);
        }
      }
      try {
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      } catch {
        try { upstreamSocket.destroy(); } catch {}
        return;
      }
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      trackUpgradedSocket(socket);
      trackUpgradedSocket(upstreamSocket);
      upstreamSocket.on('error', () => { try { socket.destroy(); } catch {} });
      socket.on('error', () => { try { upstreamSocket.destroy(); } catch {} });
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    // A dev server that answers an upgrade with a plain response (404 on an
    // unknown HMR path) must not leave the client hanging.
    upstreamReq.on('response', (upstreamRes) => {
      try {
        socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\nConnection: close\r\n\r\n`);
      } catch {}
      upstreamRes.resume();
      try { socket.destroy(); } catch {}
    });

    upstreamReq.on('error', () => {
      try {
        socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      } catch {}
      try { socket.destroy(); } catch {}
    });

    upstreamReq.end();
  }

  function start() {
    const settings = registry.settings;
    if (!settings?.enabled) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      server = httpImpl.createServer(handleRequest);
      server.on('upgrade', handleUpgrade);
      server.once('error', reject);
      server.listen(settings.port, settings.bindHost, () => {
        server.removeListener('error', reject);
        const address = server.address();
        logger?.log?.(`[preview] listener on http://${settings.bindHost}:${address?.port} → ${settings.publicBaseUrl}`);
        resolve(address);
      });
    });
  }

  function stop() {
    // The keep-alive agent pools upstream sockets, which keep the event loop
    // alive long after the listener is closed — a shutdown that skipped this
    // would hang the process instead of exiting.
    try { agent.destroy(); } catch {}
    lastHitLogAt.clear();
    for (const socket of upgradedSockets) {
      try { socket.destroy(); } catch {}
    }
    upgradedSockets.clear();
    return new Promise((resolve) => {
      if (!server) return resolve();
      const current = server;
      server = null;
      current.close(() => resolve());
      // Keep-alive sockets would otherwise hold the close open past shutdown.
      try { current.closeAllConnections?.(); } catch {}
    });
  }

  return {
    start,
    stop,
    handleRequest,
    handleUpgrade,
    get address() { return server?.address?.() || null; },
    get listening() { return Boolean(server?.listening); },
  };
}
