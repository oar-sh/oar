'use strict';

import crypto from 'node:crypto';

import { BROWSER_SESSION_PREFIX, SESSION_PROOF_PREFIX, SIGNIN_CODE_PREFIX, hashOwnerToken, hashesMatch } from '../../shared/relay-credentials.mjs';

// Browser sessions (agent auth §4): what keeps a browser signed in.
//
// The cookie `copilot_auth` holds `oars1_<b64url 32 B>`; the database
// (browser_sessions, migration 0041) keeps only its SHA-256, and a memory map
// from that hash to the row answers every request without a query. A session
// stays valid while it is used: 30 days idle (sliding), 400 days at most
// (absolute). `touch` writes last seen, the address and the idle expiry at
// most once every 10 minutes per session, and the caller then sends the
// cookie again with its new Max-Age. Expired rows go at boot and hourly. At
// most 50 rows: a new one pushes out the one seen least recently.
//
// Every session has a proof key besides its cookie secret (`oark1_…`): the
// sign-in answer carries it once, the page keeps it in its origin's storage
// and sends it with every API request; the row keeps only its SHA-256
// (`proof_hash`). A cookie reaches every port of the host, the key does not.
// No key is ever made for a session that already exists.
//
// A session that goes (signed out, pushed out by the 50, expired) goes the
// same way every time: `onRemoved(rows, reason)` drops its sockets and its
// device's push rows (auth-routes.mjs createSessionRevocationEffects).
//
// Sign-in codes (`oarc1_…`, single use, 10 minutes) live in memory only, as
// hashes: a QR or link that signs one more device in, without the owner
// token changing hands.

export const BROWSER_SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const BROWSER_SESSION_ABSOLUTE_MS = 400 * 24 * 60 * 60 * 1000;
export const BROWSER_SESSION_TOUCH_INTERVAL_MS = 10 * 60 * 1000;
export const BROWSER_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
export const BROWSER_SESSION_MAX_ROWS = 50;
// How a session signed in: the relay token, the one-time upgrade of a browser
// from before sessions, a sign-in code made in Settings → Security, or one
// made by `oar url --sign-in` (the terminal).
export const BROWSER_SESSION_AUTH_METHODS = Object.freeze(['token', 'upgrade', 'code', 'terminal']);
export const SIGNIN_CODE_TTL_MS = 10 * 60 * 1000;
const SIGNIN_CODE_MAX = 20;
// Where a sign-in code was made: Settings → Security (`code`) or the oar
// command (`terminal`). It becomes the session's auth_method.
export const SIGNIN_CODE_VIAS = Object.freeze(['code', 'terminal']);
// Terminal codes: at most 3 in 10 minutes (agent auth §13.2, 2c).
export const SIGNIN_CODE_LIMITS = Object.freeze({ terminal: Object.freeze({ limit: 3, windowMs: 10 * 60 * 1000 }) });

const LABEL_MAX = 80;
const USER_AGENT_MAX = 200;
const DEVICE_ID_MAX = 128;
// The shown address: an IP, or "this host (forwarded for <ip>)".
const IP_MAX = 80;

function toText(value) {
  return String(value ?? '').trim();
}

function capped(value, max) {
  return toText(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}

/** A short label for a browser from its user agent: "Chrome on Android". */
export function labelFromUserAgent(userAgent) {
  const ua = toText(userAgent);
  if (!ua) return 'Browser';
  let browser = 'Browser';
  if (/\bEdg(?:e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/\bOPR\/|\bOpera\b/.test(ua)) browser = 'Opera';
  else if (/\bSamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if (/\bFirefox\/|\bFxiOS\//.test(ua)) browser = 'Firefox';
  else if (/\bChrome\/|\bCriOS\/|\bChromium\//.test(ua)) browser = 'Chrome';
  else if (/\bSafari\//.test(ua)) browser = 'Safari';
  else if (/^curl\//i.test(ua)) browser = 'curl';
  let system = '';
  if (/\biPhone\b/.test(ua)) system = 'iPhone';
  else if (/\biPad\b/.test(ua)) system = 'iPad';
  else if (/\bAndroid\b/.test(ua)) system = 'Android';
  else if (/\bWindows\b/.test(ua)) system = 'Windows';
  else if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) system = 'macOS';
  else if (/\bCrOS\b/.test(ua)) system = 'ChromeOS';
  else if (/\bLinux\b/.test(ua)) system = 'Linux';
  return system ? `${browser} on ${system}` : browser;
}

export function mintBrowserSessionSecret(randomBytes = crypto.randomBytes) {
  return `${BROWSER_SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function mintSessionProof(randomBytes = crypto.randomBytes) {
  return `${SESSION_PROOF_PREFIX}${randomBytes(32).toString('base64url')}`;
}

function mintSessionId(randomBytes) {
  // 'bs_' + 12 base64url characters (9 random bytes).
  return `bs_${randomBytes(9).toString('base64url')}`;
}

/** The API shape of a row; `currentId` marks the caller's own session. */
export function formatBrowserSessionRow(row, { currentId = '' } = {}) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    label: String(row.label || '') || labelFromUserAgent(row.user_agent),
    userAgent: String(row.user_agent || '') || null,
    deviceId: String(row.device_id || '') || null,
    authMethod: String(row.auth_method || ''),
    createdAt: row.created_at || null,
    lastSeenAt: row.last_seen_at || null,
    lastIp: String(row.last_ip || '') || null,
    expiresAt: row.expires_at || null,
    absoluteExpiresAt: row.absolute_expires_at || null,
    current: !!currentId && String(row.id || '') === String(currentId),
  };
}

/**
 * @param {object} options
 * @param {import('better-sqlite3').Database} options.db
 */
export function createBrowserSessionService({
  db,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  logger = console,
  idleMs = BROWSER_SESSION_IDLE_MS,
  absoluteMs = BROWSER_SESSION_ABSOLUTE_MS,
  touchIntervalMs = BROWSER_SESSION_TOUCH_INTERVAL_MS,
  maxRows = BROWSER_SESSION_MAX_ROWS,
  // (rows, reason) after rows went without a revoke call: 'cap' (more than
  // maxRows) or 'expired'. Revoke's callers run the same effects themselves.
  onRemoved = null,
} = {}) {
  let removedHandler = typeof onRemoved === 'function' ? onRemoved : null;
  const sql = {
    listAll: db.prepare(`SELECT * FROM browser_sessions ORDER BY last_seen_at DESC, created_at DESC`),
    getById: db.prepare(`SELECT * FROM browser_sessions WHERE id = ?`),
    insert: db.prepare(`
      INSERT INTO browser_sessions (
        id, secret_hash, label, user_agent, device_id, auth_method,
        created_at, last_seen_at, last_ip, expires_at, absolute_expires_at, proof_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    touch: db.prepare(`UPDATE browser_sessions SET last_seen_at = ?, last_ip = ?, expires_at = ? WHERE id = ?`),
    rename: db.prepare(`UPDATE browser_sessions SET label = ? WHERE id = ?`),
    setDeviceIfEmpty: db.prepare(`UPDATE browser_sessions SET device_id = ? WHERE id = ? AND device_id = ''`),
    delete: db.prepare(`DELETE FROM browser_sessions WHERE id = ?`),
    count: db.prepare(`SELECT COUNT(*) AS n FROM browser_sessions`),
    leastRecent: db.prepare(`SELECT * FROM browser_sessions ORDER BY last_seen_at ASC, created_at ASC LIMIT ?`),
    expired: db.prepare(`SELECT * FROM browser_sessions WHERE expires_at <= ? OR absolute_expires_at <= ?`),
  };
  // secret_hash → row; the rows as the table has them.
  const byHash = new Map();
  // session id → last touch written (ms): the 10-minute throttle.
  const touchedAt = new Map();

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  function remember(row) {
    if (row?.secret_hash) byHash.set(row.secret_hash, row);
    return row;
  }

  function forget(row) {
    if (!row) return;
    if (row.secret_hash) byHash.delete(row.secret_hash);
    touchedAt.delete(row.id);
  }

  function load() {
    byHash.clear();
    for (const row of sql.listAll.all()) remember(row);
    return byHash.size;
  }

  function isExpired(row, at = now()) {
    const idle = Date.parse(row?.expires_at || '');
    const absolute = Date.parse(row?.absolute_expires_at || '');
    return !Number.isFinite(idle) || !Number.isFinite(absolute) || idle <= at || absolute <= at;
  }

  function deleteRow(row) {
    if (!row) return null;
    sql.delete.run(row.id);
    forget(row);
    return row;
  }

  function noteRemoved(rows, reason) {
    const gone = rows.filter(Boolean);
    if (!gone.length || !removedHandler) return;
    try { removedHandler(gone, reason); } catch (error) {
      logger?.warn?.(`[auth] after removing browser sessions: ${error?.message || error}`);
    }
  }

  /** Deletes the rows past their idle or absolute expiry; returns them. */
  function cleanupExpired() {
    const stamp = iso(now());
    const rows = sql.expired.all(stamp, stamp);
    for (const row of rows) deleteRow(row);
    // Rows the table lost some other way (a hand edit) leave the map too.
    const lost = [];
    for (const [hash, row] of byHash) {
      if (isExpired(row)) {
        byHash.delete(hash);
        touchedAt.delete(row.id);
        if (!rows.some((gone) => gone.id === row.id)) lost.push(row);
      }
    }
    if (rows.length) logger?.log?.(`[auth] ${rows.length} expired browser session${rows.length === 1 ? '' : 's'} removed.`);
    noteRemoved([...rows, ...lost], 'expired');
    return rows;
  }

  function list({ currentId = '' } = {}) {
    return sql.listAll.all().filter((row) => !isExpired(row)).map((row) => formatBrowserSessionRow(row, { currentId }));
  }

  function get(id) {
    const row = sql.getById.get(toText(id));
    return row && !isExpired(row) ? row : null;
  }

  /**
   * The live row of a cookie secret, or null. An expired row is deleted on
   * the spot (`{ row: null, expired: true }` from `lookup`).
   */
  function lookup(secret) {
    const value = toText(secret);
    if (!value.startsWith(BROWSER_SESSION_PREFIX)) return { row: null, expired: false };
    const hash = hashOwnerToken(value);
    const row = byHash.get(hash) || null;
    if (!row) return { row: null, expired: false };
    // The map is keyed by the hash; compare once more in constant time.
    if (!hashesMatch(row.secret_hash, hash)) return { row: null, expired: false };
    if (isExpired(row)) {
      noteRemoved([deleteRow(row)], 'expired');
      return { row: null, expired: true };
    }
    return { row, expired: false };
  }

  function resolve(secret) {
    return lookup(secret).row;
  }

  /**
   * Does `presented` prove this session (the page's key)? Constant time on
   * the hashes; a row without a key (made before keys) never matches.
   */
  function proofMatches(row, presented) {
    const expected = toText(row?.proof_hash);
    const value = toText(presented);
    if (!expected || !value.startsWith(SESSION_PROOF_PREFIX)) return false;
    return hashesMatch(expected, hashOwnerToken(value));
  }

  /**
   * A new session: `{ secret, proof, row }`. The secret goes into the cookie
   * once, the proof key into the sign-in answer once; neither is kept. Over
   * `maxRows` the least recently seen go first.
   */
  function create({ authMethod, label = '', userAgent = '', deviceId = '', ip = '' } = {}) {
    const method = BROWSER_SESSION_AUTH_METHODS.includes(authMethod) ? authMethod : 'token';
    const at = now();
    const secret = mintBrowserSessionSecret(randomBytes);
    const proof = mintSessionProof(randomBytes);
    const ua = capped(userAgent, USER_AGENT_MAX);
    const row = {
      id: mintSessionId(randomBytes),
      secret_hash: hashOwnerToken(secret),
      label: capped(label, LABEL_MAX) || labelFromUserAgent(ua),
      user_agent: ua,
      device_id: capped(deviceId, DEVICE_ID_MAX),
      auth_method: method,
      created_at: iso(at),
      last_seen_at: iso(at),
      last_ip: capped(ip, IP_MAX),
      expires_at: iso(Math.min(at + idleMs, at + absoluteMs)),
      absolute_expires_at: iso(at + absoluteMs),
      proof_hash: hashOwnerToken(proof),
    };
    const overflow = Number(sql.count.get()?.n || 0) - maxRows + 1;
    const pushedOut = [];
    if (overflow > 0) {
      for (const old of sql.leastRecent.all(overflow)) {
        pushedOut.push(deleteRow({ ...old, ...(byHash.get(old.secret_hash) || {}) }));
        logger?.log?.(`[auth] browser session ${old.id} signed out: more than ${maxRows} browsers.`);
      }
    }
    sql.insert.run(
      row.id, row.secret_hash, row.label, row.user_agent, row.device_id, row.auth_method,
      row.created_at, row.last_seen_at, row.last_ip, row.expires_at, row.absolute_expires_at, row.proof_hash,
    );
    touchedAt.set(row.id, at);
    remember(row);
    // After the insert: the effects ask whether the device is still signed
    // in, and the new row may be that device's.
    noteRemoved(pushedOut, 'cap');
    return { secret, proof, row };
  }

  /**
   * A session made without a device id (an old browser's upgrade) takes the
   * one its page sends once after start; a session that has one keeps it.
   */
  function adoptDevice(row, deviceId) {
    const device = capped(deviceId, DEVICE_ID_MAX);
    if (!row?.id || !device || toText(row.device_id)) return row;
    const result = sql.setDeviceIfEmpty.run(device, row.id);
    if (!result.changes) return row;
    const next = { ...row, device_id: device };
    remember(next);
    return next;
  }

  /**
   * Last seen, address and idle expiry, at most once per `touchIntervalMs`
   * (`force` writes regardless: a sign-in renewal). `{ touched, row }`; when
   * touched, the caller sends the cookie again with the new Max-Age. A
   * device id is stored when the row has none, throttled or not.
   */
  function touch(row, { ip = '', deviceId = '', force = false } = {}) {
    if (!row?.id) return { touched: false, row };
    row = adoptDevice(row, deviceId);
    const at = now();
    const last = touchedAt.get(row.id);
    if (!force && Number.isFinite(last) && at - last < touchIntervalMs) return { touched: false, row };
    const absolute = Date.parse(row.absolute_expires_at);
    const next = {
      ...row,
      last_seen_at: iso(at),
      last_ip: capped(ip, IP_MAX) || row.last_ip,
      expires_at: iso(Math.min(at + idleMs, Number.isFinite(absolute) ? absolute : at + idleMs)),
    };
    const result = sql.touch.run(next.last_seen_at, next.last_ip, next.expires_at, row.id);
    if (!result.changes) {
      forget(row);
      return { touched: false, row: null };
    }
    touchedAt.set(row.id, at);
    remember(next);
    return { touched: true, row: next };
  }

  /** Seconds the cookie may live: until the idle or the absolute expiry, whichever is first. */
  function cookieMaxAgeSeconds(row) {
    const at = now();
    const idle = Date.parse(row?.expires_at || '');
    const absolute = Date.parse(row?.absolute_expires_at || '');
    const ends = Math.min(Number.isFinite(idle) ? idle : at + idleMs, Number.isFinite(absolute) ? absolute : at + absoluteMs);
    return Math.max(0, Math.floor((ends - at) / 1000));
  }

  function rename(id, label) {
    const row = get(id);
    if (!row) return null;
    const next = capped(label, LABEL_MAX) || labelFromUserAgent(row.user_agent);
    sql.rename.run(next, row.id);
    const updated = { ...row, label: next };
    if (byHash.has(row.secret_hash)) remember({ ...byHash.get(row.secret_hash), label: next });
    return updated;
  }

  /** Deletes one session; returns its row, or null when there was none. */
  function revoke(id) {
    const row = sql.getById.get(toText(id));
    if (!row) return null;
    return deleteRow({ ...row, ...(byHash.get(row.secret_hash) || {}) });
  }

  /** Deletes every session but `keepId` (none kept when it is empty); returns the rows. */
  function revokeAllExcept(keepId = '') {
    const keep = toText(keepId);
    const removed = [];
    for (const row of sql.listAll.all()) {
      if (keep && row.id === keep) continue;
      removed.push(deleteRow(row));
    }
    return removed;
  }

  /** Is there a live session (other than `exceptId`) with this device id? */
  function hasLiveDevice(deviceId, { exceptId = '' } = {}) {
    const device = toText(deviceId);
    if (!device) return false;
    for (const row of byHash.values()) {
      if (row.device_id === device && row.id !== exceptId && !isExpired(row)) return true;
    }
    return false;
  }

  let cleanupTimer = null;
  /** Expired rows go now and then hourly; returns a stop function. */
  function startCleanup({ intervalMs = BROWSER_SESSION_CLEANUP_INTERVAL_MS } = {}) {
    try { cleanupExpired(); } catch (error) { logger?.warn?.(`[auth] browser session cleanup failed: ${error?.message || error}`); }
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = setInterval(() => {
      try { cleanupExpired(); } catch (error) { logger?.warn?.(`[auth] browser session cleanup failed: ${error?.message || error}`); }
    }, intervalMs);
    cleanupTimer.unref?.();
    return stopCleanup;
  }

  function stopCleanup() {
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
  }

  load();

  return {
    load,
    list,
    get,
    lookup,
    resolve,
    proofMatches,
    create,
    touch,
    rename,
    revoke,
    revokeAllExcept,
    hasLiveDevice,
    cleanupExpired,
    cookieMaxAgeSeconds,
    formatRow: formatBrowserSessionRow,
    startCleanup,
    stopCleanup,
    size: () => byHash.size,
    // The runtime wires the revocation effects once its sockets exist.
    setOnRemoved: (handler) => { removedHandler = typeof handler === 'function' ? handler : null; },
  };
}

/**
 * Sign-in codes: `mint({ via, minter })` → `{ code, expiresAt }`,
 * `consume(code)` → `{ ok, via }` (ok once, within `ttlMs`). Kept as
 * hashes, in memory only (a restart ends them); at most `max` at a time, the
 * oldest dropped first.
 *
 * `via` is where the code was made (SIGNIN_CODE_VIAS; the session it signs in
 * gets it as its auth_method). `minter` names who made it (a browser
 * session's id, `owner`, `terminal`): a new code revokes that minter's
 * previous one, so one browser never has two live codes on screen. A `via`
 * with a limit (SIGNIN_CODE_LIMITS: terminal, 3 per 10 min) answers
 * `{ limited: true, retryAfterSeconds }` once it is used up, and mints none.
 */
export function createSignInCodes({
  ttlMs = SIGNIN_CODE_TTL_MS,
  max = SIGNIN_CODE_MAX,
  limits = SIGNIN_CODE_LIMITS,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  // hash → { expires (ms), via, minter }, in mint order.
  const codes = new Map();
  // via → the mint times (ms) inside its window.
  const minted = new Map();

  function prune(at = now()) {
    for (const [hash, entry] of codes) {
      if (entry.expires <= at) codes.delete(hash);
    }
  }

  function limitState(via, at) {
    const rule = limits?.[via];
    if (!rule) return { ok: true, retryAfterSeconds: 0 };
    const recent = (minted.get(via) || []).filter((stamp) => at - stamp < rule.windowMs);
    minted.set(via, recent);
    if (recent.length < rule.limit) return { ok: true, retryAfterSeconds: 0 };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + rule.windowMs - at) / 1000)) };
  }

  function mint({ via = 'code', minter = '' } = {}) {
    const at = now();
    prune(at);
    const kind = SIGNIN_CODE_VIAS.includes(via) ? via : 'code';
    const state = limitState(kind, at);
    if (!state.ok) return { limited: true, retryAfterSeconds: state.retryAfterSeconds };
    const who = toText(minter).slice(0, 80);
    if (who) {
      for (const [hash, entry] of codes) {
        if (entry.minter === who) codes.delete(hash);
      }
    }
    while (codes.size >= max) codes.delete(codes.keys().next().value);
    const code = `${SIGNIN_CODE_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expires = at + ttlMs;
    codes.set(hashOwnerToken(code), { expires, via: kind, minter: who });
    if (limits?.[kind]) minted.get(kind).push(at);
    return { code, expiresAt: new Date(expires).toISOString(), via: kind };
  }

  function consume(value) {
    const code = toText(value);
    if (!code.startsWith(SIGNIN_CODE_PREFIX)) return { ok: false, via: null };
    const hash = hashOwnerToken(code);
    const entry = codes.get(hash);
    if (entry === undefined) return { ok: false, via: null };
    codes.delete(hash);
    return entry.expires > now() ? { ok: true, via: entry.via } : { ok: false, via: null };
  }

  return { mint, consume, size: () => { prune(); return codes.size; }, clear: () => codes.clear() };
}
