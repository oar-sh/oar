'use strict';

import crypto from 'node:crypto';

import { createFixedWindowRateLimiter } from './rate-limit-service.mjs';
import { createLocalRequestCheck, expressRequestView } from './request-boundary.mjs';

// The relay's token check for the API (`auth`) and the Socket.IO handshake.
//
// The token is read from the Authorization header or the HttpOnly cookie,
// nothing else. A `?token=` in the page address is the app's sign-in link:
// the page (bootstrap.js) takes it out of the address and exchanges it once
// for the cookie with a Bearer request; no API route accepts it, so the token
// does not sit in API or asset URLs, logs and the browser history.
//
// Wrong tokens are counted per client address (Express `req.ip`, which
// follows `trust proxy`): after AUTH_FAILURE_LIMIT failures in one window,
// every request from that address is answered 429 with Retry-After until the
// window ends, the right token included, so guessing does not go on behind
// the 429s. Truly local requests (request-boundary.mjs) are never counted or
// refused: the relay's own workers and agent tools must not be locked out.

export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_MAX_CLIENTS = 4_096;

/**
 * Constant-time comparison so the token cannot be recovered through response
 * timing. The token length is fixed (a UUID), so the length short-circuit
 * leaks nothing secret; any empty or missing value is a non-match.
 */
export function tokensMatch(presented, expected) {
  const a = Buffer.from(String(presented || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function normalizeClientKey(value) {
  const text = String(value || '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  return (mapped ? mapped[1] : text).slice(0, 128);
}

/**
 * Fixed-window count of wrong tokens per client. A browser tab that still
 * holds an old cookie repeats the same wrong value on every request; one
 * value counts once per window, so only distinct guesses add up.
 */
export function createAuthFailureLockout({
  limit = AUTH_FAILURE_LIMIT,
  windowMs = AUTH_FAILURE_WINDOW_MS,
  maxClients = AUTH_FAILURE_MAX_CLIENTS,
  nowMs = Date.now,
} = {}) {
  const failures = createFixedWindowRateLimiter({ windowMs, limit, bucketTtlMs: windowMs, maxBuckets: maxClients, nowMs });
  // Evicting a fingerprint early only makes that value count again.
  const counted = createFixedWindowRateLimiter({ windowMs, limit: 1, bucketTtlMs: windowMs, maxBuckets: maxClients, nowMs });

  function check(clientKey) {
    const key = normalizeClientKey(clientKey);
    if (!key) return { ok: true, retryAfterSeconds: 0 };
    return failures.peek(key);
  }

  function recordFailure(clientKey, presentedToken) {
    const key = normalizeClientKey(clientKey);
    if (!key) return { ok: true, retryAfterSeconds: 0 };
    const fingerprint = crypto.createHash('sha256').update(String(presentedToken || '')).digest('hex').slice(0, 24);
    if (counted.consume(`${key}\n${fingerprint}`).ok) failures.consume(key);
    return failures.peek(key);
  }

  return { check, recordFailure, size: () => failures.size() };
}

export function createRelayAuth({
  app,
  getAuthToken,
  cookieName,
  cookiePath = '/',
  parseCookies,
  appendSetCookie,
  localRequestCheck = createLocalRequestCheck(),
  lockout = createAuthFailureLockout(),
  logger = console,
} = {}) {
  function bearerToken(headers) {
    return String(headers?.authorization || '').replace(/^Bearer\s+/i, '');
  }

  function lockedPayload(retryAfterSeconds) {
    return {
      error: `Too many failed sign-in attempts. Try again in ${retryAfterSeconds} s.`,
      retryAfterSeconds,
    };
  }

  function noteLocked(clientKey, state, via) {
    logger?.warn?.(`[auth] ${via} from ${clientKey} refused: too many wrong tokens (retry after ${state.retryAfterSeconds} s)`);
  }

  // The lockout key of a request; null for a truly local one (exempt).
  function lockoutKeyOf(req) {
    if (localRequestCheck.isTrulyLocal(req)) return null;
    return normalizeClientKey(req?.ip || req?.socket?.remoteAddress) || 'unknown';
  }

  function auth(req, res, next) {
    const lockoutKey = lockoutKeyOf(req);
    if (lockoutKey) {
      const state = lockout.check(lockoutKey);
      if (!state.ok) {
        res.setHeader('Retry-After', String(state.retryAfterSeconds));
        res.status(429).json(lockedPayload(state.retryAfterSeconds));
        return;
      }
    }
    const expected = getAuthToken();
    const cookies = parseCookies(req.headers.cookie);
    // req.secure is derived through the configured `trust proxy` boundary, so a
    // direct (untrusted) client cannot force a non-Secure cookie by omitting
    // X-Forwarded-Proto.
    const secureAttr = req.secure ? '; Secure' : '';
    // The token is intentionally NOT read from req.body (an easy CSRF/logging
    // vector) nor from the query string (see the top of this file).
    const token = bearerToken(req.headers) || cookies[cookieName];
    if (tokensMatch(token, expected)) {
      if (res && !tokensMatch(cookies[cookieName], expected)) {
        appendSetCookie(res, `${cookieName}=${encodeURIComponent(expected)}; Path=${cookiePath}; Max-Age=2592000; SameSite=Lax; HttpOnly${secureAttr}`);
      }
      next();
      return;
    }
    if (lockoutKey && token) {
      const state = lockout.recordFailure(lockoutKey, token);
      if (!state.ok) noteLocked(lockoutKey, state, `${req.method || 'request'} ${req.path || req.url || ''}`.trim());
    }
    if (res && cookies[cookieName]) {
      appendSetCookie(res, `${cookieName}=; Path=${cookiePath}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly${secureAttr}`);
    }
    res.status(401).json({ error: 'Unauthorized' });
  }

  /** The token a Socket.IO handshake presents: `auth.token`, else the cookie. */
  function socketAuthToken(socket) {
    const cookies = parseCookies(socket?.request?.headers?.cookie);
    return socket?.handshake?.auth?.token || cookies[cookieName];
  }

  function socketTokenValid(socket) {
    return tokensMatch(socketAuthToken(socket), getAuthToken());
  }

  // io.use() middleware.
  function socketMiddleware(socket, next) {
    const rawReq = socket?.request;
    const lockoutKey = localRequestCheck.isTrulyLocal(rawReq)
      ? null
      : normalizeClientKey(expressRequestView(app, rawReq).ip || rawReq?.socket?.remoteAddress) || 'unknown';
    if (lockoutKey) {
      const state = lockout.check(lockoutKey);
      if (!state.ok) {
        const error = new Error('Too many failed sign-in attempts');
        error.data = { retryAfterSeconds: state.retryAfterSeconds };
        next(error);
        return;
      }
    }
    if (socketTokenValid(socket)) {
      next();
      return;
    }
    const token = socketAuthToken(socket);
    if (lockoutKey && token) {
      const state = lockout.recordFailure(lockoutKey, token);
      if (!state.ok) noteLocked(lockoutKey, state, 'socket handshake');
    }
    next(new Error('Unauthorized'));
  }

  return { auth, socketMiddleware, socketAuthToken, socketTokenValid, lockout };
}
