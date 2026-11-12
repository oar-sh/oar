'use strict';

import crypto from 'node:crypto';

import { createFixedWindowRateLimiter } from './rate-limit-service.mjs';
import { cookieValues as defaultCookieValues } from './cookie-header.mjs';
import { createLocalRequestCheck, expressRequestView, isSameOriginRequest } from './request-boundary.mjs';
import { principalLabel, principalOf, tagPrincipal } from './relay-principal.mjs';
import {
  AGENT_TOKEN_KINDS,
  AGENT_TOKEN_PREFIX,
  BROWSER_SESSION_PREFIX,
  PEER_KEY_PREFIX,
  SESSION_PROOF_HEADER,
  SIGNIN_CODE_PREFIX,
} from '../../shared/relay-credentials.mjs';
import {
  AUTH_AGENT_TOKEN_HINT,
  AUTH_COOKIE_UPGRADE_MESSAGE,
  AUTH_CROSS_SITE_MESSAGE,
  AUTH_ERROR_CODES,
  AUTH_FILE_CAPABILITY_MESSAGE,
  AUTH_PERSON_REQUIRED_MESSAGE,
  AUTH_SESSION_PROOF_MESSAGE,
  AUTH_SIGNED_OUT_MESSAGE,
  AUTH_UPGRADE_PENDING_MESSAGE,
  ROUTE_ACCESS,
  isCookieOnlyRoute,
  isFileCapabilityRoute,
  routePolicyFor,
} from '../../shared/relay-route-policy.mjs';
import { FILE_CAPABILITY_REQUEST_KEY, fileCapabilityOf, precheckFileCapability } from './file-capability.mjs';

export { isPerson, principalOf, tagPrincipal } from './relay-principal.mjs';

// The relay's credential check for the API (`auth`) and the Socket.IO
// handshake.
//
// A credential is read from the Authorization header or the HttpOnly cookie,
// nothing else. A `?token=` in the page address is the app's sign-in link:
// the page (bootstrap.js) takes it out of the address and exchanges it once
// for the cookie with a Bearer request; no API route accepts it, so the token
// does not sit in API or asset URLs, logs and the browser history.
//
// resolvePrincipal tells who the request acts for, by the value's prefix:
//   Bearer oara1_…   an agent token (one session's, or the cli one)
//   Bearer oarp1_…   a paired relay's key (remote-relay-peer-keys.mjs): never
//                    the person, no cookie, only REMOTE_RELAY_PEER_ROUTES
//   anything else    compared with the owner token's hash (Bearer)
//   cookie oars1_…   a browser session (browser-session-service.mjs), but
//                    only with the session's proof key in the
//                    X-OAR-Session-Proof header (below)
//   cookie, other    a browser from before sessions holding the owner token:
//                    its page trades it once for a session at the sign-in
//                    route (`auth_method: 'upgrade'`); nothing else takes it
//                    (403 AUTH_COOKIE_UPGRADE tells the page to trade)
// and tags the request (relay-principal.mjs). Then the route policy
// (shared/relay-route-policy.mjs) decides: the person may call every route,
// an agent only the ones listed for agents (deny by default). A cookie
// request that writes must come from the relay's own page (AUTH_CROSS_SITE).
//
// The proof key. Cookies are per host, not per port (RFC 6265 §8.5): a dev
// server an agent runs on another port of the relay host gets the session
// cookie whenever the person opens it, and could replay it. So every session
// has a second secret, its proof key, handed to the page once in the sign-in
// answer and kept in the origin's own storage, which another port cannot
// read. A cookie request without the key gets 403 AUTH_SESSION_PROOF, reads
// included; only the content GETs a browser loads by itself (<img>, a
// download) go on the cookie alone (COOKIE_ONLY_API_ROUTES), and the two
// routes that read a file by its path take a file capability (`k`, file-
// capability.mjs) in place of the key: `auth` lets such a request through
// with the capability unchecked on `req`, the route checks it against the
// file it resolved, and file-serving.mjs sends nothing while it is unchecked.
// A key is made with a session only: a browser that has the cookie but lost
// the key signs in again. startBrowserSession is the one place sessions are
// made.
//
// Wrong values are counted per client address (Express `req.ip`, which
// follows `trust proxy`): after AUTH_FAILURE_LIMIT failures in one window,
// every request from that address is answered 429 with Retry-After until the
// window ends, the right token included, so guessing does not go on behind
// the 429s. A request's session cookie counts value by value: of its
// `copilot_auth` values only the first SESSION_COOKIE_VALUES_CHECKED are
// read, and each of those that matches nothing is a failure (the API, the
// sign-in route and the Socket.IO handshake alike), so a Cookie header with
// many values is no way around the limit. Truly local requests
// (request-boundary.mjs) are never counted or refused: the relay's own
// workers and agent tools must not be locked out.

export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_MAX_CLIENTS = 4_096;
const REFUSAL_LOG_WINDOW_MS = 60_000;
const PEER_KEY_CHECK_ROUTE = 'GET /api/remote-relays/peer-key/check';
const PEER_SCOPE_MESSAGE = 'A paired relay\'s key opens only the routes relays call each other on; this is not one of them.';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// The old-cookie trade: one session per old cookie and device. A second
// trade within UPGRADE_PENDING_MS (another tab, its request already on the
// way) is answered 409 AUTH_UPGRADE_PENDING and makes nothing; a later one
// makes a new session in place of the first. Only a hash of the old cookie
// and the device id and the row id are remembered, never a secret.
export const UPGRADE_PENDING_MS = 10_000;
const UPGRADE_MEMORY_MS = 10 * 60_000;
const UPGRADE_MEMORY_MAX = 256;
// The ways in that tell the person's other browsers (the sign-in notice):
// not the old-cookie trade, which is the same browser going on.
const SIGNIN_NOTICE_METHODS = new Set(['token', 'code', 'terminal']);
// The `copilot_auth` values of one request that are checked: another relay
// on this host, or a longer path, can add a second one. More are ignored,
// so one request cannot carry a list of guesses, and every value checked
// that matches nothing counts toward the lockout.
export const SESSION_COOKIE_VALUES_CHECKED = 2;

/**
 * Constant-time comparison so a token cannot be recovered through response
 * timing. Any empty or missing value is a non-match.
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

function headerText(value) {
  return String((Array.isArray(value) ? value[0] : value) ?? '').trim();
}


export function createRelayAuth({
  app,
  // The owner check: `verifyOwnerToken(value)` (owner-secret-store), or the
  // older `getAuthToken()` plain value (kept for focused tests).
  verifyOwnerToken = null,
  getAuthToken = null,
  // `verifyAgentToken(value)` → `{ kind: 's'|'c', subject }` or null.
  verifyAgentToken = () => null,
  // Peer keys: `(value, req) => ({ entryId, relayId, name, url, epoch, ... }) | null`.
  resolvePeerKey = null,
  // Runs once a principal passed the route policy: `(req, res, principal)`
  // → true after it answered a refusal (origin binding's claim checks).
  afterPrincipal = null,
  // Browser sessions (browser-session-service.mjs). Without them (the table
  // could not be made) no cookie is issued, and a cookie opens nothing.
  browserSessions = null,
  // Sign-in codes: `{ consume(code) → { ok, via } }` (browser-session-service.mjs).
  signInCodes = null,
  // A new browser session that signed in (agent auth §13.2, 2d):
  // `({ row, via })`, `via` 'token' | 'code' | 'terminal'. Called by
  // startBrowserSession before the answer goes out, so what it starts (the
  // sign-in notice, its push) is under way before the new browser can do
  // anything. Never for a renewal or the old-cookie trade (`upgrade`).
  onSessionCreated = null,
  // The owner token presented as Bearer by a non-browser client (no
  // `Sec-Fetch-Site: same-origin`): `({ address })`. Never the value.
  onOwnerBearerUse = null,
  // (rows) after a sign-in replaced this browser's earlier session: the
  // revocation effects (auth-routes.mjs createSessionRevocationEffects).
  onSessionsRevoked = () => {},
  cookieName,
  cookiePath = '/',
  parseCookies,
  // Every value of one cookie name in a Cookie header (cookie-header.mjs).
  cookieValues = defaultCookieValues,
  appendSetCookie,
  // Origins besides the relay's own a browser write may come from.
  allowedOrigins = [],
  localRequestCheck = createLocalRequestCheck(),
  lockout = createAuthFailureLockout(),
  policyFor = routePolicyFor,
  cookieOnlyRoute = isCookieOnlyRoute,
  fileCapabilityRoute = isFileCapabilityRoute,
  logger = console,
  nowMs = Date.now,
} = {}) {
  const ownerCheck = typeof verifyOwnerToken === 'function'
    ? verifyOwnerToken
    : (value) => tokensMatch(value, typeof getAuthToken === 'function' ? getAuthToken() : '');
  const refusalLog = createFixedWindowRateLimiter({ windowMs: REFUSAL_LOG_WINDOW_MS, limit: 1, bucketTtlMs: REFUSAL_LOG_WINDOW_MS, maxBuckets: 512, nowMs });

  function bearerToken(headers) {
    // `Bearer` alone (an empty token; clients trim the trailing space) is none.
    return headerText(headers?.authorization).replace(/^Bearer(?:\s+|$)/i, '').trim();
  }

  function proofOf(headers) {
    return headerText(headers?.[SESSION_PROOF_HEADER]);
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

  function clientAddressOf(req) {
    return normalizeClientKey(req?.ip || req?.socket?.remoteAddress);
  }

  // The address a sign-in notice and the signed-in browsers list show. When
  // the TCP peer is this host and forwarding headers came along, the
  // forwarded address is only what that process wrote, so it leads with
  // "this host" and is never shown alone. For display only: the lockout
  // keys on the client address (lockoutKeyOf).
  function noticeAddressOf(req) {
    const address = clientAddressOf(req);
    let reason = null;
    try { reason = localRequestCheck.explain(req)?.reason || null; } catch { reason = null; }
    if (reason !== 'marker' && reason !== 'forwarded') return address;
    const peer = normalizeClientKey(req?.socket?.remoteAddress);
    return address && address !== peer ? `this host (forwarded for ${address})` : 'this host';
  }

  function agentPrincipal(value) {
    let verified = null;
    try { verified = verifyAgentToken(value); } catch { verified = null; }
    if (!verified) return null;
    return verified.kind === AGENT_TOKEN_KINDS.session
      ? { kind: 'agent', agentKind: AGENT_TOKEN_KINDS.session, conversationId: verified.subject, via: 'bearer' }
      : { kind: 'agent', agentKind: AGENT_TOKEN_KINDS.cli, via: 'bearer' };
  }

  function peerPrincipal(value, req = null) {
    if (typeof resolvePeerKey !== 'function') return null;
    let peer = null;
    try { peer = resolvePeerKey(value, req); } catch { peer = null; }
    return peer ? { ...peer, kind: 'peer', via: 'bearer' } : null;
  }

  function ownerMatches(value) {
    try { return ownerCheck(value) === true; } catch { return false; }
  }

  function prefixedNonOwner(value) {
    return value.startsWith(AGENT_TOKEN_PREFIX)
      || value.startsWith(PEER_KEY_PREFIX)
      || value.startsWith(BROWSER_SESSION_PREFIX)
      || value.startsWith(SIGNIN_CODE_PREFIX);
  }

  /** A Bearer value's principal, or null. */
  function bearerPrincipal(value, req = null) {
    if (!value) return null;
    if (value.startsWith(AGENT_TOKEN_PREFIX)) return agentPrincipal(value);
    if (value.startsWith(PEER_KEY_PREFIX)) return peerPrincipal(value, req);
    // Browser sessions and sign-in codes are never Bearer credentials (a
    // code is taken by the sign-in route alone).
    if (value.startsWith(BROWSER_SESSION_PREFIX) || value.startsWith(SIGNIN_CODE_PREFIX)) return null;
    return ownerMatches(value) ? { kind: 'owner', via: 'bearer' } : null;
  }

  function sessionRowOf(value) {
    if (!browserSessions || !String(value || '').startsWith(BROWSER_SESSION_PREFIX)) return null;
    try { return browserSessions.resolve(value) || null; } catch { return null; }
  }

  function proofMatches(row, proof) {
    if (!row || !proof || !browserSessions) return false;
    try { return browserSessions.proofMatches(row, proof) === true; } catch { return false; }
  }

  /**
   * The session cookie of a request, read from its first
   * SESSION_COOKIE_VALUES_CHECKED distinct `copilot_auth` values (another
   * relay on this host, or a longer path, can add one of the same name):
   * `{ value, row, proofOk, legacy, values, misses }`.
   *   - `row`: the browser session of the first value that is one, the one
   *     the proof key belongs to when there is a key;
   *   - `legacy`: the first value that is the owner token (a browser from
   *     before sessions), when no value is a session;
   *   - `value`: the value used ('' for none), `values`: the ones checked;
   *   - `misses`: the values checked that matched nothing (each one counts
   *     toward the lockout: countMisses).
   * A value that matches nothing never hides one that does.
   */
  function sessionCookie(headers, proof = proofOf(headers)) {
    const values = [...new Set(cookieValues(headers?.cookie, cookieName).map((value) => String(value || '').trim()).filter(Boolean))]
      .slice(0, SESSION_COOKIE_VALUES_CHECKED);
    const misses = [];
    let first = null;
    let legacy = '';
    for (const value of values) {
      if (value.startsWith(BROWSER_SESSION_PREFIX)) {
        const row = sessionRowOf(value);
        if (!row) {
          misses.push(value);
          continue;
        }
        if (proofMatches(row, proof)) return { value, row, proofOk: true, legacy: '', values, misses };
        if (!first) first = { value, row };
        continue;
      }
      if (prefixedNonOwner(value) || !ownerMatches(value)) {
        misses.push(value);
        continue;
      }
      if (!legacy) legacy = value;
    }
    if (first) return { value: first.value, row: first.row, proofOk: false, legacy: '', values, misses };
    if (legacy) return { value: legacy, row: null, proofOk: false, legacy, values, misses };
    return { value: values[0] || '', row: null, proofOk: false, legacy: '', values, misses };
  }

  /**
   * `{ principal, presented, source, cookie, row, proofOk }` for a request:
   * the principal (or null), the value that was checked, where it came from
   * ('bearer', 'cookie' or '' for none), the session cookie as read
   * (`sessionCookie`), its browser session row and whether the request
   * carried that session's proof key.
   */
  function resolvePrincipal(req) {
    const bearer = bearerToken(req?.headers);
    const cookie = sessionCookie(req?.headers);
    if (bearer) return { principal: bearerPrincipal(bearer, req), presented: bearer, source: 'bearer', cookie, row: null, proofOk: false };
    if (cookie.row) {
      return {
        principal: { kind: 'browser', sessionId: cookie.row.id, via: 'cookie' },
        presented: cookie.value,
        source: 'cookie',
        cookie,
        row: cookie.row,
        proofOk: cookie.proofOk,
      };
    }
    if (cookie.legacy) {
      return { principal: { kind: 'owner', via: 'cookie', legacyCookie: true }, presented: cookie.legacy, source: 'cookie', cookie, row: null, proofOk: false };
    }
    if (cookie.value) return { principal: null, presented: cookie.value, source: 'cookie', cookie, row: null, proofOk: false };
    return { principal: null, presented: '', source: '', cookie, row: null, proofOk: false };
  }

  // The session cookie. Host-only: never a Domain attribute, so sibling hosts
  // of one registrable domain do not share it. req.secure is derived through
  // the configured `trust proxy` boundary, so a direct (untrusted) client
  // cannot force a non-Secure cookie by omitting X-Forwarded-Proto. Max-Age
  // runs to the idle or the absolute expiry, whichever comes first.
  function setSessionCookie(req, res, secret, row) {
    if (!res || typeof appendSetCookie !== 'function' || !secret) return;
    const maxAge = browserSessions?.cookieMaxAgeSeconds?.(row) ?? 0;
    const secureAttr = req.secure ? '; Secure' : '';
    appendSetCookie(res, `${cookieName}=${secret}; Path=${cookiePath}; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${secureAttr}`);
  }

  function clearCookie(req, res) {
    if (!res || typeof appendSetCookie !== 'function') return;
    const secureAttr = req.secure ? '; Secure' : '';
    appendSetCookie(res, `${cookieName}=; Path=${cookiePath}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax; HttpOnly${secureAttr}`);
  }

  /**
   * The one place a browser session is made (sign-in by token or code, the
   * upgrade of an old browser, and any later way in): the row, its cookie
   * on `res`, and `{ row, proof }` for the caller to answer with once
   * (`sessionAnswer`). The proof key goes nowhere else: not into a cookie,
   * a URL or a log. `replaces`: this browser's earlier session, signed out
   * once the new one exists. Null when none could be made.
   */
  function startBrowserSession(req, res, { authMethod, deviceId = '', label = '', replaces = null, clearFirst = false } = {}) {
    if (!browserSessions) return null;
    let made;
    try {
      made = browserSessions.create({
        authMethod,
        deviceId,
        label,
        userAgent: headerText(req?.headers?.['user-agent']),
        ip: noticeAddressOf(req),
      });
    } catch (error) {
      logger?.warn?.(`[auth] a browser session could not be made: ${error?.message || error}`);
      return null;
    }
    // The old browser's cookie is cleared, then the session's set (in this
    // order: a browser applies Set-Cookie headers one after the other).
    if (clearFirst) clearCookie(req, res);
    setSessionCookie(req, res, made.secret, made.row);
    if (replaces?.id && replaces.id !== made.row.id) {
      let revoked = null;
      try { revoked = browserSessions.revoke(replaces.id); } catch { revoked = null; }
      if (revoked) {
        try { onSessionsRevoked([revoked]); } catch (error) {
          logger?.warn?.(`[auth] after replacing a browser session: ${error?.message || error}`);
        }
        logger?.log?.(`[auth] browser session ${revoked.id} replaced by ${made.row.id} (signed in again).`);
      }
    }
    if (SIGNIN_NOTICE_METHODS.has(authMethod)) sessionCreated(made.row, authMethod, noticeAddressOf(req));
    return { row: made.row, proof: made.proof };
  }

  // A hook that throws never fails the sign-in: the session exists by now.
  function sessionCreated(row, via, address = null) {
    if (typeof onSessionCreated !== 'function' || !row?.id) return;
    try {
      onSessionCreated({ row, via, address });
    } catch (error) {
      logger?.warn?.(`[auth] after the sign-in of browser session ${row.id}: ${error?.message || error}`);
    }
  }

  function sameOriginFetch(req) {
    return headerText(req?.headers?.['sec-fetch-site']).toLowerCase() === 'same-origin';
  }

  function ownerBearerUsed(req) {
    if (typeof onOwnerBearerUse !== 'function') return;
    try { onOwnerBearerUse({ address: clientAddressOf(req) }); } catch {}
  }

  const upgrades = new Map();

  function upgradeKeyOf(legacy, deviceId) {
    return crypto.createHash('sha256').update(`${legacy}\n${deviceId}`).digest('hex');
  }

  /** The session an earlier trade of this old cookie made, while it lasts: `{ rowId, atMs, row }`. */
  function earlierUpgrade(key) {
    const at = nowMs();
    for (const [entryKey, entry] of upgrades) {
      if (at - entry.atMs < UPGRADE_MEMORY_MS && upgrades.size <= UPGRADE_MEMORY_MAX) break;
      upgrades.delete(entryKey);
    }
    const entry = upgrades.get(key);
    if (!entry) return null;
    let row = null;
    try { row = browserSessions?.get?.(entry.rowId) || null; } catch { row = null; }
    if (!row) {
      upgrades.delete(key);
      return null;
    }
    return { ...entry, row };
  }

  function noteUpgrade(key, rowId) {
    upgrades.delete(key);
    upgrades.set(key, { rowId, atMs: nowMs() });
  }

  /** The sign-in answer: the session and, for a new one, its proof key (once). */
  function sessionAnswer(row, proof = '') {
    return { session: { id: row.id, label: row.label }, ...(proof ? { proof } : {}) };
  }

  /**
   * CSRF for cookie principals (§4.3): a write must come from the relay's own
   * page. Same-site counts as foreign: a preview on another port of this host,
   * or a sibling host of the same domain, is same-site and gets the cookie.
   * A request with neither header is not a browser's.
   */
  function crossSiteWrite(req) {
    if (SAFE_METHODS.has(String(req?.method || 'GET').toUpperCase())) return false;
    const fetchSite = headerText(req?.headers?.['sec-fetch-site']).toLowerCase();
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') return true;
    return !isSameOriginRequest(req, { allowedOrigins });
  }

  function routeKeyOf(req) {
    const routePath = req?.route?.path;
    return `${String(req?.method || '').toUpperCase()} ${typeof routePath === 'string' ? routePath : (req?.path || req?.url || '')}`;
  }

  function logRefusal(kind, req, principal) {
    const key = `${kind} ${routeKeyOf(req)}`;
    if (!refusalLog.consume(key).ok) return;
    logger?.warn?.(`[auth] ${kind} refused: ${routeKeyOf(req)} (${principalLabel(principal)})`);
  }

  function refuseCrossSite(req, res, principal) {
    logRefusal('cross-site write', req, principal);
    res.status(403).json({ error: AUTH_CROSS_SITE_MESSAGE, code: AUTH_ERROR_CODES.crossSite });
  }

  function refuseOldCookie(req, res, principal) {
    logRefusal('cookie from before sessions', req, principal);
    res.status(403).json({ error: AUTH_COOKIE_UPGRADE_MESSAGE, code: AUTH_ERROR_CODES.cookieUpgrade });
  }

  function refuseMissingProof(req, res, principal) {
    logRefusal('cookie without its session key', req, principal);
    res.status(403).json({ error: AUTH_SESSION_PROOF_MESSAGE, code: AUTH_ERROR_CODES.sessionProof });
  }

  /** 403 for a principal the route's policy does not let in; false when it may go on. */
  function refuseByPolicy(req, res, principal) {
    if (principal.kind === 'owner' || principal.kind === 'browser' || principal.kind === 'internal') return false;
    const policy = policyFor(req?.method, req?.route?.path);
    if (principal.kind === 'agent') {
      if (policy.agent !== ROUTE_ACCESS.deny) return false;
      logRefusal('agent', req, principal);
      res.status(403).json({ error: AUTH_PERSON_REQUIRED_MESSAGE, code: AUTH_ERROR_CODES.personRequired });
      return true;
    }
    if (principal.kind === 'peer') {
      // A key its holder has not checked yet opens the check alone.
      if (principal.checkOnly && routeKeyOf(req) !== PEER_KEY_CHECK_ROUTE) {
        res.status(401).json({ error: 'Unauthorized' });
        return true;
      }
      if (policy.peer !== ROUTE_ACCESS.deny) return false;
      logRefusal('peer', req, principal);
      res.status(403).json({ error: PEER_SCOPE_MESSAGE, code: AUTH_ERROR_CODES.peerScope });
      return true;
    }
    res.status(403).json({ error: AUTH_PERSON_REQUIRED_MESSAGE, code: AUTH_ERROR_CODES.personRequired });
    return true;
  }

  /** Writes last seen at most every 10 minutes, and then sends the cookie again. */
  function renewSession(req, res, row, secret, { force = false, deviceId = '' } = {}) {
    if (!browserSessions || !row) return row;
    let outcome;
    try {
      outcome = browserSessions.touch(row, { ip: noticeAddressOf(req), deviceId, force });
    } catch {
      return row;
    }
    if (outcome?.touched) setSessionCookie(req, res, secret, outcome.row);
    return outcome?.row || row;
  }

  function lockoutRefusal(res, lockoutKey) {
    if (!lockoutKey) return false;
    const state = lockout.check(lockoutKey);
    if (state.ok) return false;
    res.setHeader('Retry-After', String(state.retryAfterSeconds));
    res.status(429).json(lockedPayload(state.retryAfterSeconds));
    return true;
  }

  function countFailure(req, lockoutKey, presented) {
    if (!lockoutKey || !presented) return;
    const state = lockout.recordFailure(lockoutKey, presented);
    if (!state.ok) noteLocked(lockoutKey, state, `${req.method || 'request'} ${req.path || req.url || ''}`.trim());
  }

  function refuseFileCapability(req, res, principal) {
    logRefusal('file capability', req, principal);
    res.status(403).json({ error: AUTH_FILE_CAPABILITY_MESSAGE, code: AUTH_ERROR_CODES.fileCapability });
  }

  /**
   * A cookie request without the key to a file-by-path route that carries a
   * file capability: 'none' when it carries none (or the route takes none),
   * 'refused' when the capability fails the checks that need no key and no
   * file (malformed, expired, or for a session the cookie does not hold
   * alive), else 'admitted': let through with the capability on `req`,
   * its MAC unchecked, with the sessions the cookie holds. The route checks
   * the MAC against the path it is asked for before anything else.
   */
  function admitFileCapability(req, cookie) {
    if (!fileCapabilityRoute(req?.method, req?.route?.path)) return 'none';
    const k = fileCapabilityOf(req);
    if (!k) return 'none';
    const sessionIds = [];
    for (const value of cookie?.values || []) {
      const live = sessionRowOf(value);
      if (live?.id) sessionIds.push(live.id);
    }
    if (!precheckFileCapability(k, { sessionIds, nowMs: nowMs() }).ok) return 'refused';
    req[FILE_CAPABILITY_REQUEST_KEY] = { k, sessionIds, verified: false };
    return 'admitted';
  }

  /** Every cookie value checked that matched nothing counts (once per value and window). */
  function countMisses(req, lockoutKey, cookie) {
    for (const value of cookie?.misses || []) countFailure(req, lockoutKey, value);
  }

  function auth(req, res, next) {
    const lockoutKey = lockoutKeyOf(req);
    if (lockoutRefusal(res, lockoutKey)) return;
    // The token is intentionally NOT read from req.body (an easy CSRF/logging
    // vector) nor from the query string (see the top of this file).
    const { principal, presented, source, cookie, row, proofOk } = resolvePrincipal(req);
    countMisses(req, lockoutKey, cookie);
    if (principal) {
      tagPrincipal(req, principal);
      if (principal.via === 'cookie') {
        if (crossSiteWrite(req)) {
          refuseCrossSite(req, res, principal);
          return;
        }
        // The cookie alone opens the content a browser loads by itself; every
        // other route needs the session's key. An old browser's owner-token
        // cookie has none: its page trades it at the sign-in route first,
        // told so by its own code (it is not signed out).
        // A session without a proof hash (none can be made now) never
        // passes, the cookie-only routes and file capabilities included.
        const keyless = !!row && !String(row.proof_hash || '').trim();
        // A file capability that fails the checks needing no key and no file
        // is refused here, before the route runs (403 AUTH_FILE_CAPABILITY).
        if (!proofOk && (keyless || !cookieOnlyRoute(req?.method, req?.route?.path))) {
          const capability = row && !keyless ? admitFileCapability(req, cookie) : 'none';
          if (capability === 'refused') {
            refuseFileCapability(req, res, principal);
            return;
          }
          if (capability !== 'admitted') {
            if (principal.legacyCookie) refuseOldCookie(req, res, principal);
            else refuseMissingProof(req, res, principal);
            return;
          }
        }
      } else if (principal.kind === 'owner' && source === 'bearer' && !sameOriginFetch(req)) {
        // A script, a paired relay on protocol 1, anything but a browser
        // page: when and from where, for Settings → Security (§13.2, 3a).
        ownerBearerUsed(req);
      }
      if (refuseByPolicy(req, res, principal)) return;
      if (typeof afterPrincipal === 'function') {
        let refused = false;
        try {
          refused = afterPrincipal(req, res, principal) === true;
        } catch (error) {
          // A check that could not run lets nothing through.
          try { logger?.warn?.(`[auth] the check after sign-in failed on ${req?.method || 'request'} ${req?.path || ''}: ${error?.message || error}`); } catch {}
          if (!res.headersSent) res.status(500).json({ error: 'The relay could not check this request' });
          return;
        }
        if (refused) return;
      }
      if (row && proofOk) renewSession(req, res, row, presented);
      next();
      return;
    }
    countFailure(req, lockoutKey, presented);
    // Only a cookie that matches nothing is cleared: a failed Bearer value
    // leaves the browser's cookie alone.
    if (source === 'cookie') clearCookie(req, res);
    // A browser whose cookie no longer counts (revoked, expired, or the
    // owner token it held was replaced) is told so: the app opens its
    // sign-in gate with "This browser was signed out".
    if (source === 'cookie') {
      res.status(401).json({ error: AUTH_SIGNED_OUT_MESSAGE, code: AUTH_ERROR_CODES.signedOut });
      return;
    }
    // A script that read the token from the config gets told where it went.
    // A browser (it sends Sec-Fetch-*) just gets the sign-in answer.
    if (!presented && !headerText(req?.headers?.['sec-fetch-site'])) {
      res.status(401).json({ error: AUTH_AGENT_TOKEN_HINT, code: AUTH_ERROR_CODES.unauthorized });
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
  }

  /**
   * POST /api/auth/session (§4.4): the sign-in exchange. `Authorization:
   * Bearer <owner token | oarc1_ sign-in code>`, body `{ deviceId, label? }`.
   * Makes a browser session, sets its cookie and answers `{ session: { id,
   * label }, proof }`: the proof key, once. Without a Bearer:
   *   - a session cookie with its key renews the session (no new key);
   *   - a session cookie without its key is refused (403
   *     AUTH_SESSION_PROOF): a key is never made for a cookie alone;
   *   - an old browser's owner-token cookie becomes a session (the upgrade):
   *     the answer clears the old cookie and sets the session's. One session
   *     per old cookie and device: a second trade within UPGRADE_PENDING_MS
   *     gets 409 AUTH_UPGRADE_PENDING and makes nothing (the browser's other
   *     tab is getting the first one), a later one replaces the first.
   * A sign-in by token or code over this browser's earlier session signs
   * that one out. Wrong values count toward the lockout; an agent or a
   * paired relay is refused (403), not counted.
   */
  function signIn(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const lockoutKey = lockoutKeyOf(req);
    if (lockoutRefusal(res, lockoutKey)) return;
    if (!browserSessions) {
      res.status(503).json({ error: 'This relay cannot keep browsers signed in right now (its database has no session table); see the relay log.' });
      return;
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const deviceId = String(body.deviceId || '').trim();
    const label = String(body.label || '').trim();
    const cookie = sessionCookie(req?.headers);
    countMisses(req, lockoutKey, cookie);
    const currentRow = cookie.row;
    const bearer = bearerToken(req?.headers);
    const fail = (presented, { signedOut = false } = {}) => {
      countFailure(req, lockoutKey, presented);
      if (cookie.value && !currentRow && !cookie.legacy) clearCookie(req, res);
      res.status(401).json(signedOut
        ? { error: AUTH_SIGNED_OUT_MESSAGE, code: AUTH_ERROR_CODES.signedOut }
        : { error: 'Invalid token', code: AUTH_ERROR_CODES.unauthorized });
    };
    const renewed = () => {
      const row = renewSession(req, res, currentRow, cookie.value, { force: true, deviceId });
      res.json({ ...sessionAnswer(row), renewed: true });
    };
    const issue = (authMethod, { replaces = currentRow, clearFirst = false } = {}) => {
      const made = startBrowserSession(req, res, { authMethod, deviceId, label, replaces, clearFirst });
      if (!made) {
        res.status(503).json({ error: 'The browser session could not be stored; see the relay log.' });
        return;
      }
      if (authMethod === 'upgrade') logger?.log?.(`[auth] a browser signed in before sessions now has session ${made.row.id}.`);
      else if (authMethod === 'code') logger?.log?.(`[auth] a sign-in code signed in browser session ${made.row.id}.`);
      else if (authMethod === 'terminal') logger?.log?.(`[auth] a sign-in code from the oar command (terminal) signed in browser session ${made.row.id}.`);
      res.json(sessionAnswer(made.row, made.proof));
      return made;
    };

    if (!bearer) {
      if (currentRow) {
        const principal = { kind: 'browser', sessionId: currentRow.id, via: 'cookie' };
        if (crossSiteWrite(req)) return refuseCrossSite(req, res, principal);
        if (!cookie.proofOk) return refuseMissingProof(req, res, principal);
        return renewed();
      }
      if (cookie.legacy) {
        if (crossSiteWrite(req)) return refuseCrossSite(req, res, { kind: 'owner' });
        const key = upgradeKeyOf(cookie.legacy, deviceId);
        const earlier = earlierUpgrade(key);
        const sinceMs = earlier ? nowMs() - earlier.atMs : Infinity;
        if (sinceMs < UPGRADE_PENDING_MS) {
          const retryAfterSeconds = Math.max(1, Math.ceil((UPGRADE_PENDING_MS - sinceMs) / 1000));
          res.setHeader('Retry-After', String(retryAfterSeconds));
          res.status(409).json({ error: AUTH_UPGRADE_PENDING_MESSAGE, code: AUTH_ERROR_CODES.upgradePending, retryAfterSeconds });
          return;
        }
        const made = issue('upgrade', { replaces: earlier?.row || null, clearFirst: true });
        if (made?.row?.id) noteUpgrade(key, made.row.id);
        return;
      }
      if (cookie.value) return fail(cookie.value, { signedOut: true });
      res.status(401).json({ error: 'Sign in with the relay token or a sign-in code.', code: AUTH_ERROR_CODES.unauthorized });
      return;
    }
    if (bearer.startsWith(SIGNIN_CODE_PREFIX)) {
      let used = null;
      try { used = signInCodes?.consume?.(bearer) || null; } catch { used = null; }
      if (used?.ok !== true) return fail(bearer);
      return issue(used.via === 'terminal' ? 'terminal' : 'code');
    }
    if (bearer.startsWith(AGENT_TOKEN_PREFIX)) {
      const agent = agentPrincipal(bearer);
      if (!agent) return fail(bearer);
      tagPrincipal(req, agent);
      logRefusal('agent', req, agent);
      res.status(403).json({ error: AUTH_PERSON_REQUIRED_MESSAGE, code: AUTH_ERROR_CODES.personRequired });
      return;
    }
    if (bearer.startsWith(PEER_KEY_PREFIX)) {
      if (!peerPrincipal(bearer, req)) return fail(bearer);
      res.status(403).json({ error: PEER_SCOPE_MESSAGE, code: AUTH_ERROR_CODES.peerScope });
      return;
    }
    if (bearer.startsWith(BROWSER_SESSION_PREFIX) || !ownerMatches(bearer)) return fail(bearer);
    // Signed in already, with the key: nothing new. Without the key, the
    // token makes a new session (and key) in place of the old one.
    if (currentRow && cookie.proofOk) return renewed();
    return issue('token');
  }

  /** The caller's own browser session row (the "this browser" of the list), or null. */
  function currentSessionOf(req) {
    const principal = principalOf(req);
    if (principal?.sessionId && browserSessions) {
      try {
        const row = browserSessions.get(principal.sessionId);
        if (row) return row;
      } catch {}
    }
    return sessionCookie(req?.headers).row;
  }

  /** The value a Socket.IO handshake presents: `auth.token`, else the cookie. */
  function socketAuthToken(socket) {
    return socket?.handshake?.auth?.token || sessionCookie(socket?.request?.headers, '').value;
  }

  /**
   * `{ principal, cookieWithoutProof, oldCookie, misses }` of a handshake.
   * The person's only (agents and peers never get one): the owner token as
   * `auth.token`, or the session cookie with its key as `auth.proof`.
   * `misses`: the cookie values checked that matched nothing.
   */
  function socketAuth(socket) {
    const handshakeToken = String(socket?.handshake?.auth?.token || '').trim();
    if (handshakeToken) {
      const principal = bearerPrincipal(handshakeToken);
      return { principal: principal?.kind === 'owner' ? principal : null, cookieWithoutProof: false, oldCookie: false, misses: [] };
    }
    const cookie = sessionCookie(socket?.request?.headers, String(socket?.handshake?.auth?.proof || '').trim());
    const { misses } = cookie;
    if (cookie.row && cookie.proofOk) return { principal: { kind: 'browser', sessionId: cookie.row.id, via: 'cookie' }, cookieWithoutProof: false, oldCookie: false, misses };
    return { principal: null, cookieWithoutProof: !!(cookie.row || cookie.legacy), oldCookie: !cookie.row && !!cookie.legacy, misses };
  }

  /** The person principal of a handshake, or null. */
  function socketPrincipal(socket) {
    return socketAuth(socket).principal;
  }

  function socketTokenValid(socket) {
    return !!socketPrincipal(socket);
  }

  /** Tags a socket with its principal and, for a browser, its session id (revoking drops it). */
  function tagSocket(socket, principal) {
    if (!socket || typeof socket !== 'object') return;
    socket.data = socket.data && typeof socket.data === 'object' ? socket.data : {};
    socket.data.principal = principal;
    socket.data.browserSessionId = principal?.kind === 'browser' ? String(principal.sessionId || '') : null;
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
    const { principal, cookieWithoutProof, oldCookie, misses } = socketAuth(socket);
    if (lockoutKey) {
      for (const value of misses) {
        const state = lockout.recordFailure(lockoutKey, value);
        if (!state.ok) noteLocked(lockoutKey, state, 'socket handshake');
      }
    }
    if (principal) {
      tagSocket(socket, principal);
      next();
      return;
    }
    // A real session cookie without its key (a page on another port of the
    // host, or a browser that lost the key): refused, not counted. An old
    // browser's cookie: its page trades it first.
    if (cookieWithoutProof) {
      const error = new Error('Unauthorized');
      error.data = { code: oldCookie ? AUTH_ERROR_CODES.cookieUpgrade : AUTH_ERROR_CODES.sessionProof };
      next(error);
      return;
    }
    const token = String(socketAuthToken(socket) || '').trim();
    // A genuine agent token or peer key is not a wrong guess: refused, not
    // counted (paired relays use HTTP only).
    if ((token.startsWith(AGENT_TOKEN_PREFIX) && agentPrincipal(token)) || (token.startsWith(PEER_KEY_PREFIX) && peerPrincipal(token))) {
      const error = new Error('Unauthorized');
      error.data = { code: AUTH_ERROR_CODES.personRequired };
      next(error);
      return;
    }
    if (lockoutKey && token) {
      const state = lockout.recordFailure(lockoutKey, token);
      if (!state.ok) noteLocked(lockoutKey, state, 'socket handshake');
    }
    next(new Error('Unauthorized'));
  }

  return {
    auth,
    signIn,
    resolvePrincipal,
    principalOf,
    currentSessionOf,
    startBrowserSession,
    sessionAnswer,
    setSessionCookie,
    clearCookie,
    crossSiteWrite,
    socketMiddleware,
    socketAuthToken,
    socketTokenValid,
    socketPrincipal,
    tagSocket,
    lockout,
  };
}
