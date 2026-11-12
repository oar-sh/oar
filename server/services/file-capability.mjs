'use strict';

import crypto from 'node:crypto';

import { FILE_CAPABILITY_PARAM, FILE_CAPABILITY_TTL_MS } from '../../shared/relay-route-policy.mjs';

// File capabilities (`k`): how a browser page loads a file by path natively.
//
// An <img>, a <video> with its Range requests, a download link or a PDF in a
// new tab cannot send the session's proof key header, and the cookie alone
// must not open GET /api/drives/file or /api/files/* (a page on another port
// of the host gets the cookie). So the page asks, with its key, for a
// capability per file (POST /api/files/capability) and puts it in the
// address as `k`:
//
//   fc1.<session id>.<expiry, unix seconds, base 36>.<HMAC-SHA256, base64url>
//
// The HMAC is over the session id, the expiry and the path the file route
// is asked for, absolute and normalized as a string (no symlink resolved,
// nothing read from the disk), under a key only the relay holds:
// derived from the agentKey in relay-secrets.json (never sent to anyone), or
// a key of this process when there is none. It opens that one file for that
// browser session until the expiry, at most FILE_CAPABILITY_TTL_MS (10 min)
// after it was made, and only while the session lives (not signed out, not
// expired), and only with that session's own cookie on the request. The path
// is not in the token: the route checks the capability against the path it
// was asked for before it does anything else with it (resolves links, looks
// at the disk, lists the drives), so a wrong `k` gets the same 403 whatever
// the path; only then does it check the real path the way it checks any.

export { FILE_CAPABILITY_PARAM, FILE_CAPABILITY_TTL_MS };
export const FILE_CAPABILITY_PREFIX = 'fc1';
// Where `auth` leaves a capability it let through for the route to check;
// file-serving.mjs refuses to send a file while it is unchecked.
export const FILE_CAPABILITY_REQUEST_KEY = 'oarFileCapability';

const KEY_LABEL = 'oar file capability key v1';
const MAC_LABEL = 'oar-file-capability-v1';
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// A clock a little ahead on the minting side is no reason to refuse.
const EXPIRY_SKEW_S = 5;

/**
 * A key of its own for one use (`label`), derived from the agentKey bytes
 * (32 bytes); null without one. File capabilities and media tags
 * (media-tag.mjs) each have their label, so neither key opens the other.
 */
export function deriveRelayKey(agentKey, label) {
  if (!Buffer.isBuffer(agentKey) || agentKey.length < 16 || !label) return null;
  return crypto.createHmac('sha256', agentKey).update(String(label)).digest();
}

/** The capability key from the agentKey bytes (32 bytes), or null. */
export function deriveFileCapabilityKey(agentKey) {
  return deriveRelayKey(agentKey, KEY_LABEL);
}

function macOf(key, sessionId, expSeconds, filePath) {
  return crypto.createHmac('sha256', key)
    .update(`${MAC_LABEL}\0${sessionId}\0${expSeconds}\0${filePath}`)
    .digest('base64url');
}

/** `{ sessionId, expSeconds, mac }` of a well-formed capability, else null. Checks nothing else. */
export function parseFileCapability(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 200) return null;
  const parts = text.split('.');
  if (parts.length !== 4 || parts[0] !== FILE_CAPABILITY_PREFIX) return null;
  const [, sessionId, expText, mac] = parts;
  if (!SESSION_ID_PATTERN.test(sessionId) || !/^[0-9a-z]{1,10}$/.test(expText) || !MAC_PATTERN.test(mac)) return null;
  const expSeconds = parseInt(expText, 36);
  if (!Number.isSafeInteger(expSeconds) || expSeconds <= 0) return null;
  return { sessionId, expSeconds, mac };
}

/**
 * The checks of a capability that need no key and no file: well formed, for
 * one of `sessionIds` (the live sessions the request's cookie holds), not
 * expired and not further out than a capability is ever made for. `auth`
 * runs them before the route; `verify` again. `{ ok: true, parsed }` or
 * `{ ok: false, reason }` ('malformed' | 'session' | 'expired').
 */
export function precheckFileCapability(value, { sessionIds = [], nowMs = Date.now(), ttlMs = FILE_CAPABILITY_TTL_MS } = {}) {
  const parsed = parseFileCapability(value);
  if (!parsed) return { ok: false, reason: 'malformed' };
  const ids = new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds]).map((id) => String(id || '')).filter(Boolean));
  if (!ids.has(parsed.sessionId)) return { ok: false, reason: 'session' };
  const lifetimeMs = Math.max(1_000, Math.min(Number(ttlMs) || FILE_CAPABILITY_TTL_MS, FILE_CAPABILITY_TTL_MS));
  const nowSeconds = Number(nowMs) / 1000;
  if (parsed.expSeconds <= nowSeconds) return { ok: false, reason: 'expired' };
  if (parsed.expSeconds > nowSeconds + lifetimeMs / 1000 + EXPIRY_SKEW_S) return { ok: false, reason: 'expired' };
  return { ok: true, parsed };
}

/** The first `k` of a request's query (Express may hand an array). */
export function fileCapabilityOf(req) {
  const value = req?.query?.[FILE_CAPABILITY_PARAM];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim() : '';
}

/**
 * @param {object} options
 * @param {() => Buffer|null} options.getKey  the derived key, read live
 * @param {(id: string) => object|null} options.getSession  the live row of a browser session id
 */
export function createFileCapabilities({
  getKey = () => null,
  getSession = () => null,
  nowMs = Date.now,
  ttlMs = FILE_CAPABILITY_TTL_MS,
  randomBytes = crypto.randomBytes,
} = {}) {
  const lifetimeMs = Math.max(1_000, Math.min(Number(ttlMs) || FILE_CAPABILITY_TTL_MS, FILE_CAPABILITY_TTL_MS));
  // Without an agentKey (a relay that could not write its secrets file):
  // capabilities of this process only. A restart makes the page ask again.
  const processKey = randomBytes(32);

  function key() {
    let derived = null;
    try { derived = getKey(); } catch { derived = null; }
    return Buffer.isBuffer(derived) && derived.length >= 16 ? derived : processKey;
  }

  function sessionLive(sessionId) {
    try { return !!getSession(sessionId); } catch { return false; }
  }

  /** `{ k, expiresAtMs }` for a live browser session and an absolute path; null otherwise. */
  function mint({ sessionId, filePath } = {}) {
    const id = String(sessionId || '');
    const target = String(filePath || '');
    if (!SESSION_ID_PATTERN.test(id) || !target || !sessionLive(id)) return null;
    const expSeconds = Math.floor((nowMs() + lifetimeMs) / 1000);
    const k = `${FILE_CAPABILITY_PREFIX}.${id}.${expSeconds.toString(36)}.${macOf(key(), id, expSeconds, target)}`;
    return { k, expiresAtMs: expSeconds * 1000 };
  }

  /**
   * Does `value` open `filePath` for one of `sessionIds` (the sessions the
   * request's cookie holds)? `{ ok: true, sessionId }` or `{ ok: false,
   * reason }` with reason 'malformed' | 'session' | 'expired' | 'mac' | 'revoked'.
   */
  function verify(value, { filePath, sessionIds = [] } = {}) {
    const target = String(filePath || '');
    const checked = precheckFileCapability(value, { sessionIds, nowMs: nowMs(), ttlMs: lifetimeMs });
    if (!checked.ok) return checked;
    if (!target) return { ok: false, reason: 'malformed' };
    const { parsed } = checked;
    const expected = Buffer.from(macOf(key(), parsed.sessionId, parsed.expSeconds, target), 'utf8');
    const presented = Buffer.from(parsed.mac, 'utf8');
    if (expected.length !== presented.length || !crypto.timingSafeEqual(expected, presented)) return { ok: false, reason: 'mac' };
    if (!sessionLive(parsed.sessionId)) return { ok: false, reason: 'revoked' };
    return { ok: true, sessionId: parsed.sessionId };
  }

  return { mint, verify, ttlMs: lifetimeMs };
}

/**
 * `url` with its `k` set to `k` (every earlier `k` taken out); the rest of
 * the address stays as it was written.
 */
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
