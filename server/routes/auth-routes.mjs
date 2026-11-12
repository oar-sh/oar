'use strict';

import { principalOf } from '../services/relay-principal.mjs';
import { createLocalRequestCheck, isCliOverLoopback, requestHostOf } from '../services/request-boundary.mjs';
import { AUTH_ERROR_CODES } from '../../shared/relay-route-policy.mjs';
import { SIGNIN_NOTICE_ID_PREFIX } from '../services/signin-notice-service.mjs';

// The person's sign-in and security routes (agent auth §4, §5):
//
//   POST   /api/auth/session              the sign-in exchange (relay-auth.mjs signIn)
//   DELETE /api/auth/session              sign out this browser
//   GET    /api/auth/sessions             the signed-in browsers, `current` marked
//   PATCH  /api/auth/sessions/:id         rename one
//   DELETE /api/auth/sessions/:id         sign one out
//   DELETE /api/auth/sessions             sign out all others (the current one stays)
//   POST   /api/auth/signin-codes         a single-use link that signs one more device in
//   POST   /api/auth/signin-codes/terminal the same for `oar url --sign-in`: the cli
//                                         token straight over loopback only
//   GET    /api/auth/owner-token          whether there is one, when it was made and replaced
//   POST   /api/auth/owner-token/rotate   a new owner token, shown once
//   GET    /api/auth/notices              the security notices for the banner
//   POST   /api/auth/notices/:id/dismiss
//   POST   /api/auth/notices/dismiss-signins  { ids }: this browser's "Got it"
//
// All but the sign-in exchange sit behind `auth` and are person-only in the
// route policy; a cookie write must come from the relay's own page. The
// terminal sign-in code is the one exception: the policy lets agent tokens
// past `auth` ('row') and the route takes the cli kind over loopback alone.

export const AUTH_NOTICE_IDS = Object.freeze({
  // The owner token was readable by agents until this version (it sat in
  // config.json): a new one is recommended. Shown until a rotation, or until
  // dismissed for this token.
  rotateAfterUpgrade: 'rotate-after-upgrade',
  // The owner hash changed with no rotation by OAR (owner-secret-store.mjs).
  changedOutside: 'changed-outside',
  // The relay was started with `--token` on its command line (a supervisor
  // of an earlier version keeps passing it): visible in the process list,
  // and ignored once relay-secrets.json exists. A stop and start ends it.
  argvToken: 'argv-token',
});
export const UPGRADE_NOTICE_SETTING_KEY = 'auth_upgrade_notice_dismissed';
// At most this many sign-in notices per "Got it" (the relay keeps 20).
const SIGNIN_DISMISS_MAX = 50;
// The "changed outside OAR" banner was dismissed for this owner hash: a new
// token stays recommended (the Security tab's dot) until a rotation.
export const CHANGED_OUTSIDE_DISMISSED_SETTING_KEY = 'auth_changed_outside_dismissed';
// The Security tab's "Recommended" dot (§13.2, 3b).
export const AUTH_RECOMMENDATION_IDS = Object.freeze({ rotateOwnerToken: 'rotate-owner-token' });
export const UPGRADE_NOTICE_MESSAGE = 'Your relay token was readable by agents until this version of OAR. Generate a new one in Settings → Security.';
// The terminal route's refusals.
export const AUTH_TERMINAL_ONLY_CODE = 'AUTH_TERMINAL_ONLY';
export const TERMINAL_CODE_PERSON_MESSAGE = 'Terminal sign-in codes are for the oar command on the relay\'s host. In the web UI, use Settings → Security → Sign in another device.';
export const TERMINAL_CODE_AGENT_MESSAGE = 'Only the oar command, straight over loopback with no proxy in between, makes terminal sign-in codes (oar url --sign-in).';
export const ARGV_TOKEN_MESSAGE = 'This relay was started with its token on the command line, where other programs on this computer can read it. Stop and start the relay once (oar stop, then oar start) so it runs without it, then generate a new token in Settings → Security.';
export const CHANGED_OUTSIDE_MESSAGE = 'The relay token was changed outside OAR. If you did not do this, generate a new one in Settings → Security and check who can write to this computer.';

function toText(value) {
  return String(value ?? '').trim();
}

function parseJson(value) {
  if (value == null) return null;
  try { return JSON.parse(String(value)); } catch { return null; }
}

/**
 * The paired relays a rotation leaves on the old token: every entry without a
 * confirmed peer key from this relay (`peerKeyConfirmed`, the registry's
 * public view). A keyed peer signs in with its key and keeps working.
 */
export function affectedRelaysOf(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && entry.peerKeyConfirmed !== true)
    .map((entry) => ({ id: toText(entry.id), name: toText(entry.name) || toText(entry.id), url: toText(entry.url) || null }));
}

/**
 * The address a request came in on, for links: the protocol and host as
 * `trust proxy` sees them (X-Forwarded-Host only from a trusted proxy,
 * requestHostOf), plus the relay's base path.
 */
export function requestBaseUrl(req, basePath = '') {
  return `${req?.protocol || 'http'}://${requestHostOf(req)}${basePath || ''}`;
}

/** `<base>/?<param>=<value>`, the base without a trailing slash. */
export function signInLink(base, param, value) {
  const root = toText(base).replace(/\/+$/, '');
  return `${root}/?${param}=${encodeURIComponent(value)}`;
}

/**
 * What revoking sessions does besides deleting their rows: their sockets are
 * disconnected, and the push rows of their device go when no other live
 * session has that device id (a lost phone stops getting card pushes).
 */
export function createSessionRevocationEffects({
  browserSessions,
  disconnectBrowserSessions = () => 0,
  deletePushDevicesForDevice = () => 0,
  logger = console,
} = {}) {
  return function afterRevoke(rows) {
    const revoked = (Array.isArray(rows) ? rows : []).filter((row) => row?.id);
    if (!revoked.length) return { sockets: 0, pushDevices: 0 };
    let sockets = 0;
    try { sockets = Number(disconnectBrowserSessions(revoked.map((row) => row.id))) || 0; } catch {}
    let pushDevices = 0;
    const devices = new Set(revoked.map((row) => toText(row.device_id)).filter(Boolean));
    for (const deviceId of devices) {
      let stillSignedIn = false;
      try { stillSignedIn = browserSessions?.hasLiveDevice?.(deviceId) === true; } catch {}
      if (stillSignedIn) continue;
      try { pushDevices += Number(deletePushDevicesForDevice(deviceId)) || 0; } catch (error) {
        logger?.warn?.(`[auth] the push subscriptions of a signed-out browser could not be removed: ${error?.message || error}`);
      }
    }
    return { sockets, pushDevices };
  };
}

export function registerAuthRoutes(app, deps) {
  const {
    auth,
    relayAuth,
    browserSessions,
    signInCodes,
    ownerSecretStore,
    remoteRelayRegistry = null,
    // New sign-in notices (signin-notice-service.mjs); none: no `signins`.
    signInNotices = null,
    // The owner token's last non-browser use (owner-token-use.mjs).
    ownerTokenUse = null,
    // `(text) → { size, bits } | null`: the QR matrix of a sign-in link.
    qrMatrix = null,
    onSessionsRevoked = () => {},
    readSetting = () => null,
    writeSetting = () => {},
    publicBaseUrl = () => '',
    // Truly local (request-boundary.mjs), with the relay's marker headers.
    isTrulyLocalRequest = createLocalRequestCheck().isTrulyLocal,
    logger = console,
  } = deps;

  function noStore(res) {
    res.setHeader('Cache-Control', 'no-store');
  }

  function currentRowOf(req) {
    try { return relayAuth?.currentSessionOf?.(req) || null; } catch { return null; }
  }

  /** Who did it, for the log: `session bs_…`, or `the owner token`. */
  function actorOf(req, current = currentRowOf(req)) {
    if (current?.id) return `session ${current.id}`;
    return principalOf(req)?.kind === 'owner' ? 'the owner token' : 'the person';
  }

  function unavailable(res) {
    return res.status(503).json({ error: 'Browser sessions are not available on this relay right now; see the relay log.' });
  }

  function afterRevoke(rows) {
    try { return onSessionsRevoked(rows) || null; } catch (error) {
      logger?.warn?.(`[auth] after signing out: ${error?.message || error}`);
      return null;
    }
  }

  // ─── Sign in ────────────────────────────────────────────────────────────────

  app.post('/api/auth/session', (req, res) => relayAuth.signIn(req, res));

  // Sign out this browser: its session goes, the cookie is cleared.
  app.delete('/api/auth/session', auth, (req, res) => {
    noStore(res);
    const current = currentRowOf(req);
    let revoked = null;
    if (current && browserSessions) {
      revoked = browserSessions.revoke(current.id);
      if (revoked) {
        afterRevoke([revoked]);
        logger?.log?.(`[auth] browser session ${revoked.id} signed itself out.`);
      }
    }
    relayAuth?.clearCookie?.(req, res);
    res.json({ ok: true, id: revoked?.id || null });
  });

  // ─── The signed-in browsers ─────────────────────────────────────────────────

  app.get('/api/auth/sessions', auth, (req, res) => {
    if (!browserSessions) return unavailable(res);
    noStore(res);
    const currentId = currentRowOf(req)?.id || '';
    res.json({ sessions: browserSessions.list({ currentId }), currentId: currentId || null });
  });

  app.patch('/api/auth/sessions/:id', auth, (req, res) => {
    if (!browserSessions) return unavailable(res);
    const label = req.body?.label;
    if (typeof label !== 'string') return res.status(400).json({ error: 'Send { "label": "…" }' });
    const row = browserSessions.rename(req.params.id, label);
    if (!row) return res.status(404).json({ error: 'No signed-in browser with that id.' });
    const currentId = currentRowOf(req)?.id || '';
    res.json({ session: browserSessions.formatRow(row, { currentId }) });
  });

  app.delete('/api/auth/sessions/:id', auth, (req, res) => {
    if (!browserSessions) return unavailable(res);
    noStore(res);
    const current = currentRowOf(req);
    const revoked = browserSessions.revoke(req.params.id);
    if (!revoked) return res.status(404).json({ error: 'No signed-in browser with that id.' });
    const effects = afterRevoke([revoked]);
    const isCurrent = !!current && current.id === revoked.id;
    if (isCurrent) relayAuth?.clearCookie?.(req, res);
    logger?.log?.(`[auth] browser session ${revoked.id} signed out by ${actorOf(req, current)}.`);
    res.json({ ok: true, id: revoked.id, current: isCurrent, ...(effects ? { effects } : {}) });
  });

  // "Sign out all other browsers": the current one stays.
  app.delete('/api/auth/sessions', auth, (req, res) => {
    if (!browserSessions) return unavailable(res);
    noStore(res);
    const current = currentRowOf(req);
    const revoked = browserSessions.revokeAllExcept(current?.id || '').filter(Boolean);
    const effects = afterRevoke(revoked);
    logger?.log?.(`[auth] ${revoked.length} other browser session${revoked.length === 1 ? '' : 's'} signed out by ${actorOf(req, current)}.`);
    res.json({ ok: true, revoked: revoked.length, kept: current?.id || null, ...(effects ? { effects } : {}) });
  });

  // ─── Sign in another device ─────────────────────────────────────────────────

  // Who made a code, so that a new one revokes the same minter's previous
  // one: the browser session, else the owner token.
  function minterOf(req) {
    const current = currentRowOf(req);
    if (current?.id) return current.id;
    return principalOf(req)?.kind === 'owner' ? 'owner' : 'person';
  }

  app.post('/api/auth/signin-codes', auth, (req, res) => {
    if (!browserSessions || !signInCodes) return unavailable(res);
    noStore(res);
    const { code, expiresAt } = signInCodes.mint({ via: 'code', minter: minterOf(req) });
    logger?.log?.(`[auth] a sign-in code was made by ${actorOf(req)} (single use, until ${expiresAt}).`);
    const link = signInLink(publicBaseUrl(req), 'signin', code);
    // The QR matrix rides in this answer, so no second request carries the code.
    let qr = null;
    try { qr = typeof qrMatrix === 'function' ? qrMatrix(link) : null; } catch { qr = null; }
    res.json({ code, link, expiresAt, qr });
  });

  // `oar url --sign-in` (agent auth §13.2, 2c): the cli agent token, straight
  // over loopback, gets one code; the CLI prints the link and a QR code. The
  // person is sent to Settings → Security, a session's agent token and any
  // proxied request are refused. Not a boundary against a process of the
  // user's (docs/security.md): the controls are the sign-in notice and its
  // push, "via the terminal" in the list, this log line and the limit.
  app.post('/api/auth/signin-codes/terminal', auth, (req, res) => {
    noStore(res);
    const principal = principalOf(req);
    if (principal?.kind === 'owner' || principal?.kind === 'browser') {
      return res.status(403).json({ error: TERMINAL_CODE_PERSON_MESSAGE, code: AUTH_TERMINAL_ONLY_CODE });
    }
    if (!isCliOverLoopback(principal, req, { isTrulyLocal: isTrulyLocalRequest })) {
      logger?.warn?.(`[auth] a terminal sign-in code was refused: ${principal?.agentKind === 'c' ? 'the oar command\'s token, not straight over loopback' : 'not the oar command\'s token'}.`);
      return res.status(403).json({ error: TERMINAL_CODE_AGENT_MESSAGE, code: AUTH_ERROR_CODES.personRequired });
    }
    if (!browserSessions || !signInCodes) return unavailable(res);
    const minted = signInCodes.mint({ via: 'terminal', minter: 'terminal' });
    if (minted.limited) {
      res.setHeader('Retry-After', String(minted.retryAfterSeconds));
      logger?.warn?.('[auth] a terminal sign-in code was refused: more than 3 in 10 minutes.');
      return res.status(429).json({ error: `At most 3 terminal sign-in codes in 10 minutes. Try again in ${minted.retryAfterSeconds} s.`, retryAfterSeconds: minted.retryAfterSeconds });
    }
    logger?.log?.(`[auth] a sign-in code was made by the oar command (terminal, single use, until ${minted.expiresAt}).`);
    res.json({ code: minted.code, expiresAt: minted.expiresAt });
  });

  // ─── The owner token ────────────────────────────────────────────────────────

  // The public view: it says whether this relay holds a confirmed key for
  // each entry (`peerKeyConfirmed`), which is what a rotation leaves working.
  function pairedRelays() {
    try {
      return remoteRelayRegistry?.listPublic?.() || remoteRelayRegistry?.list?.() || [];
    } catch {
      return [];
    }
  }

  // `{ lastNonBrowserUse, previousLastNonBrowserUse, lastNonBrowserUseSince }`:
  // `{ at, address }` or null, never the value (§13.2, 3a).
  function ownerTokenUseView() {
    let view = null;
    try { view = ownerTokenUse?.view?.() || null; } catch { view = null; }
    return {
      lastNonBrowserUse: view?.lastNonBrowserUse || null,
      previousLastNonBrowserUse: view?.previousLastNonBrowserUse || null,
      lastNonBrowserUseSince: view?.since || null,
    };
  }

  app.get('/api/auth/owner-token', auth, (_req, res) => {
    noStore(res);
    res.json({ ownerToken: ownerSecretStore.status(), pairedRelays: pairedRelays().length, ...ownerTokenUseView() });
  });

  // §5: a new owner token. The old one fails at once (Bearer and cookie);
  // browser sessions, agents and the worker sockets keep working. The token
  // is in this answer once, and nowhere else.
  app.post('/api/auth/owner-token/rotate', auth, (req, res) => {
    noStore(res);
    const actor = actorOf(req);
    let rotated;
    try {
      rotated = ownerSecretStore.rotateOwnerToken({ reason: `by ${actor}` });
    } catch (error) {
      logger?.warn?.(`[auth] owner token rotation failed: ${error?.code || error?.message || error}`);
      return res.status(500).json({ error: 'The new relay token could not be stored; the current one still works. See the relay log.' });
    }
    // The old token's uses become `previous`; the answer names its last one.
    try { ownerTokenUse?.syncOwner?.(); } catch {}
    logger?.log?.(`[auth] owner token rotated by ${actor}.`);
    res.json({
      token: rotated.token,
      pairingLink: signInLink(publicBaseUrl(req), 'token', rotated.token),
      affectedRelays: affectedRelaysOf(pairedRelays()),
      rotatedAt: rotated.rotatedAt,
      lastNonBrowserUse: ownerTokenUseView().previousLastNonBrowserUse,
    });
  });

  // ─── Security notices (the banner) ──────────────────────────────────────────

  function upgradeNoticeDue() {
    const status = ownerSecretStore.status();
    if (!status?.legacyPlaintext) return false;
    const dismissed = parseJson(readSetting(UPGRADE_NOTICE_SETTING_KEY));
    // Dismissed for this token (the hash in relay-secrets.json): a token that
    // later reappears in plain text brings the notice back.
    return toText(dismissed?.hash) !== toText(storedOwnerHash());
  }

  function storedOwnerHash() {
    return ownerSecretStore.storedOwnerHash?.() ?? ownerSecretStore.ownerTokenHash();
  }

  // Dismissed for this run only: the next start with a --token says it again.
  let argvNoticeDismissed = false;

  function notices() {
    const list = [];
    if (!argvNoticeDismissed && ownerSecretStore.argvTokenGiven?.()) {
      list.push({ id: AUTH_NOTICE_IDS.argvToken, message: ARGV_TOKEN_MESSAGE });
    }
    if (upgradeNoticeDue()) {
      list.push({ id: AUTH_NOTICE_IDS.rotateAfterUpgrade, message: UPGRADE_NOTICE_MESSAGE, action: 'rotate' });
    }
    const alert = ownerSecretStore.ownerTokenAlert?.();
    if (alert) {
      list.push({ id: AUTH_NOTICE_IDS.changedOutside, message: CHANGED_OUTSIDE_MESSAGE, reason: toText(alert.reason) || 'file', at: alert.at || null, action: 'rotate' });
    }
    return list;
  }

  // The new sign-ins this viewer is shown (§13.9): a browser session, every
  // notice it has not dismissed but its own sign-in's; the owner token
  // without a session, the relay-wide list (not dismissible).
  function signinsFor(req) {
    if (!signInNotices) return [];
    try {
      return signInNotices.listFor({ viewerSessionId: currentRowOf(req)?.id || '' });
    } catch (error) {
      logger?.warn?.(`[auth] the sign-in notices could not be read: ${error?.message || error}`);
      return [];
    }
  }

  // §13.2, 3b: a new token stays recommended (a dot on the Security tab)
  // after its banner was dismissed, while the token is one agents could read
  // (legacy plaintext) or one changed outside OAR; a rotation ends both.
  function rotationRecommended() {
    const hash = toText(storedOwnerHash());
    if (!hash) return false;
    const status = ownerSecretStore.status();
    if (status?.legacyPlaintext && !upgradeNoticeDue()) return true;
    const changed = parseJson(readSetting(CHANGED_OUTSIDE_DISMISSED_SETTING_KEY));
    return !ownerSecretStore.ownerTokenAlert?.() && toText(changed?.hash) === hash;
  }

  function recommendations() {
    return rotationRecommended() ? [{ id: AUTH_RECOMMENDATION_IDS.rotateOwnerToken, tab: 'security' }] : [];
  }

  function noticesAnswer(req) {
    return { notices: notices(), signins: signinsFor(req), recommendations: recommendations() };
  }

  app.get('/api/auth/notices', auth, (req, res) => {
    noStore(res);
    res.json(noticesAnswer(req));
  });

  // "Got it" on the banner's sign-in row: the ones this browser was shown,
  // all at once, for this browser only.
  app.post('/api/auth/notices/dismiss-signins', auth, (req, res) => {
    noStore(res);
    const viewer = currentRowOf(req)?.id || '';
    if (!viewer) return res.status(400).json({ error: 'A sign-in notice is dismissed per browser; sign in with this browser first.' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, SIGNIN_DISMISS_MAX).map(toText) : null;
    if (!ids || ids.length === 0 || !ids.every((id) => id.startsWith(SIGNIN_NOTICE_ID_PREFIX))) {
      return res.status(400).json({ error: 'ids: the sign-in notices to dismiss.' });
    }
    const dismissed = signInNotices?.ackMany?.(ids, viewer) || 0;
    return res.json({ ok: true, dismissed, ...noticesAnswer(req) });
  });

  app.post('/api/auth/notices/:id/dismiss', auth, (req, res) => {
    noStore(res);
    const id = toText(req.params.id);
    if (id.startsWith(SIGNIN_NOTICE_ID_PREFIX)) {
      // Acknowledged per viewer: a browser session dismisses it for itself.
      const viewer = currentRowOf(req)?.id || '';
      if (!viewer) return res.status(400).json({ error: 'A sign-in notice is dismissed per browser; sign in with this browser first.' });
      if (signInNotices?.ack?.(id, viewer) !== 'ok') return res.status(404).json({ error: 'No such notice.' });
      return res.json({ ok: true, ...noticesAnswer(req) });
    }
    if (id === AUTH_NOTICE_IDS.rotateAfterUpgrade) {
      writeSetting(UPGRADE_NOTICE_SETTING_KEY, JSON.stringify({ at: new Date().toISOString(), hash: storedOwnerHash() }));
    } else if (id === AUTH_NOTICE_IDS.argvToken) {
      argvNoticeDismissed = true;
    } else if (id === AUTH_NOTICE_IDS.changedOutside) {
      if (ownerSecretStore.ownerTokenAlert?.()) {
        writeSetting(CHANGED_OUTSIDE_DISMISSED_SETTING_KEY, JSON.stringify({ at: new Date().toISOString(), hash: storedOwnerHash() }));
      }
      ownerSecretStore.clearAlert({ writeSetting });
    } else {
      return res.status(404).json({ error: 'No such notice.' });
    }
    res.json({ ok: true, ...noticesAnswer(req) });
  });
}
