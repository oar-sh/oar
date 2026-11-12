'use strict';

import crypto from 'node:crypto';

// New sign-in notices (agent auth §13.2, 2d; rulings §13.9).
//
// Every browser session that signs in with the relay token, a sign-in link
// or a terminal code (never a renewal, a parallel request that found the
// session just made, or the one-time upgrade of a browser from before
// sessions) leaves a notice:
//
//   - kept in app_settings `auth_signin_notices` (JSON): at most 20, for 7
//     days. The label and address are snapshots taken at sign-in, so a later
//     rename by the new session does not change what others were told;
//   - sent at once as the Socket.IO event `auth_new_signin` to every person
//     socket but the new session's;
//   - pushed (`newSignIn`, push-dispatch-service.mjs) before the sign-in
//     answer goes out.
//
// Notices are relay-wide and acknowledged per viewer session: one browser's
// Dismiss hides it for that browser only, so a new session cannot hide its
// own trail from the others. A browser that signs in later (after being
// signed out, say) still sees every notice of the last 7 days it has not
// dismissed itself; there is no "signed in before the event" filter. A
// sign-out never touches a notice or a push already on its way.

export const SIGNIN_NOTICES_SETTING_KEY = 'auth_signin_notices';
export const SIGNIN_NOTICE_MAX = 20;
export const SIGNIN_NOTICE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
export const SIGNIN_NOTICE_ID_PREFIX = 'signin-';
export const SIGNIN_NOTICE_SOCKET_EVENT = 'auth_new_signin';
export const SIGNIN_NOTICE_VIAS = Object.freeze(['token', 'code', 'terminal']);
// "via …" as the banner and the push say it.
export const SIGNIN_VIA_LABELS = Object.freeze({
  token: 'the relay token',
  code: 'a sign-in link',
  terminal: 'the terminal',
});

const LABEL_MAX = 80;
const USER_AGENT_MAX = 80;
const ADDRESS_MAX = 80;
// Acks are session ids; there are at most 50 sessions at a time.
const ACKS_MAX = 60;

function toText(value) {
  return String(value ?? '').trim();
}

function capped(value, max) {
  return toText(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max);
}

/** `signin-<eventId>` → `<eventId>`, or '' for any other notice id. */
export function signInNoticeEventId(publicId) {
  const id = toText(publicId);
  if (!id.startsWith(SIGNIN_NOTICE_ID_PREFIX)) return '';
  const eventId = id.slice(SIGNIN_NOTICE_ID_PREFIX.length);
  return /^[A-Za-z0-9_-]{1,40}$/.test(eventId) ? eventId : '';
}

/**
 * The sockets a sign-in notice goes to: the person's, as the handshake
 * tagged them (relay-auth.mjs tagSocket): the owner token, or a browser
 * session that came with its proof key (a cookie without it gets no
 * socket). An untagged socket, an agent's or a peer's never; nor the new
 * browser's own session (`exceptSessionId`).
 */
export function signInNoticeRecipients(sockets, { exceptSessionId = '' } = {}) {
  const except = toText(exceptSessionId);
  const out = [];
  for (const socket of sockets || []) {
    const principal = socket?.data?.principal;
    if (principal?.kind === 'owner') {
      out.push(socket);
      continue;
    }
    if (principal?.kind !== 'browser') continue;
    const sessionId = toText(socket.data.browserSessionId);
    if (!sessionId || sessionId !== toText(principal.sessionId)) continue;
    if (except && sessionId === except) continue;
    out.push(socket);
  }
  return out;
}

function parseList(raw) {
  if (raw == null) return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === 'object' && toText(entry.id)) : [];
  } catch {
    return [];
  }
}

/**
 * @param {object} options
 * @param {(key: string) => string|null} options.readSetting
 * @param {(key: string, value: string) => void} options.writeSetting
 * @param {(event: string, payload: object, options: { exceptSessionId: string }) => number} [options.emitToPersonSockets]
 * @param {(notice: object) => unknown} [options.notifyPush] gets the stored entry plus `deviceId`; must start the push before it returns
 * @param {(sessionId: string) => boolean} [options.isSessionLive] for `signedOut` in the view
 */
export function createSignInNoticeService({
  readSetting,
  writeSetting,
  emitToPersonSockets = () => 0,
  notifyPush = () => null,
  isSessionLive = () => true,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  maxNotices = SIGNIN_NOTICE_MAX,
  keepMs = SIGNIN_NOTICE_KEEP_MS,
  logger = console,
} = {}) {
  function fresh(list, at = now()) {
    return list.filter((entry) => {
      const stamp = Date.parse(entry.at || '');
      return Number.isFinite(stamp) && at - stamp < keepMs;
    });
  }

  function load() {
    let raw = null;
    try { raw = readSetting?.(SIGNIN_NOTICES_SETTING_KEY) ?? null; } catch { raw = null; }
    return fresh(parseList(raw));
  }

  function save(list) {
    try {
      writeSetting?.(SIGNIN_NOTICES_SETTING_KEY, JSON.stringify(list));
      return true;
    } catch (error) {
      logger?.warn?.(`[auth] the sign-in notices could not be stored: ${error?.message || error}`);
      return false;
    }
  }

  function live(sessionId) {
    try { return isSessionLive(sessionId) === true; } catch { return true; }
  }

  /**
   * Which notice goes when the list is over its cap, or -1 for none: the
   * oldest one that is done with (its session signed out, or a sign-in by
   * token or link some browser dismissed), else the oldest that is not a
   * terminal sign-in. A terminal sign-in's notice stays while its session
   * is signed in, dismissed or not: any session can dismiss it for itself,
   * so a dismissal proves nothing, and a session made from a terminal code
   * could otherwise push its own notice out with sign-in links. Terminal
   * codes are limited (3 in 10 minutes) and notices kept 7 days, so the list
   * stays bounded. The notice just made is never the one that goes.
   */
  function evictionIndex(list, keepId) {
    const acked = (entry) => Array.isArray(entry.ackedBy) && entry.ackedBy.length > 0;
    const done = list.findIndex((entry) => entry.id !== keepId
      && (!entry.sessionId || !live(entry.sessionId) || (entry.via !== 'terminal' && acked(entry))));
    if (done >= 0) return done;
    return list.findIndex((entry) => entry.id !== keepId && entry.via !== 'terminal');
  }

  /**
   * The API shape. `dismissible`: whether this viewer can acknowledge it
   * (a browser session can; the owner token, with no session, cannot).
   * `signedOut`: the new session is gone by now.
   */
  function view(entry, { dismissible = true } = {}) {
    const via = SIGNIN_NOTICE_VIAS.includes(entry.via) ? entry.via : 'token';
    return {
      id: `${SIGNIN_NOTICE_ID_PREFIX}${entry.id}`,
      sessionId: toText(entry.sessionId) || null,
      label: toText(entry.label) || 'Browser',
      userAgent: toText(entry.userAgent) || null,
      address: toText(entry.address) || null,
      via,
      viaLabel: SIGNIN_VIA_LABELS[via],
      at: entry.at || null,
      signedOut: entry.sessionId ? !live(entry.sessionId) : true,
      dismissible,
    };
  }

  /**
   * A new session signed in: the notice is stored, sent to the other person
   * sockets and pushed, all before this returns. Returns its view.
   */
  function record({ row, via, address = null } = {}) {
    if (!row?.id) return null;
    const kind = SIGNIN_NOTICE_VIAS.includes(via) ? via : 'token';
    const entry = {
      id: randomBytes(6).toString('base64url'),
      sessionId: toText(row.id),
      label: capped(row.label, LABEL_MAX),
      userAgent: capped(row.user_agent, USER_AGENT_MAX),
      address: capped(typeof address === 'string' ? address : row.last_ip, ADDRESS_MAX),
      via: kind,
      at: new Date(now()).toISOString(),
      ackedBy: [],
    };
    const list = load();
    list.push(entry);
    while (list.length > maxNotices) {
      const index = evictionIndex(list, entry.id);
      if (index < 0) break;
      list.splice(index, 1);
    }
    save(list);
    const notice = view(entry, { dismissible: true });
    // The push first: it must be under way whatever the socket send does.
    try {
      notifyPush({ ...entry, noticeId: notice.id, deviceId: toText(row.device_id) });
    } catch (error) {
      logger?.warn?.(`[auth] the new sign-in push could not be sent: ${error?.message || error}`);
    }
    try {
      emitToPersonSockets(SIGNIN_NOTICE_SOCKET_EVENT, { notice }, { exceptSessionId: entry.sessionId });
    } catch (error) {
      logger?.warn?.(`[auth] the new sign-in notice could not be sent to the open pages: ${error?.message || error}`);
    }
    logger?.log?.(`[auth] new sign-in: browser session ${entry.sessionId} via ${SIGNIN_VIA_LABELS[kind]} (notice ${notice.id}).`);
    return notice;
  }

  /**
   * The notices one viewer is shown, newest first. A browser session sees
   * every notice of the last 7 days but its own sign-in's and the ones it
   * dismissed. Without a session (the owner token) the relay-wide list: all
   * of them, none dismissible.
   */
  function listFor({ viewerSessionId = '' } = {}) {
    const viewer = toText(viewerSessionId);
    const list = load().slice().reverse();
    if (!viewer) return list.map((entry) => view(entry, { dismissible: false }));
    return list
      .filter((entry) => entry.sessionId !== viewer && !(Array.isArray(entry.ackedBy) && entry.ackedBy.includes(viewer)))
      .map((entry) => view(entry, { dismissible: true }));
  }

  /**
   * Hides the given notices for one viewer session, in one write ("Got it"
   * on the banner's sign-in row). Returns how many it found.
   */
  function ackMany(publicIds, viewerSessionId) {
    const viewer = toText(viewerSessionId);
    const eventIds = new Set((Array.isArray(publicIds) ? publicIds : []).map(signInNoticeEventId).filter(Boolean));
    if (!viewer || eventIds.size === 0) return 0;
    const list = load();
    let found = 0;
    for (const entry of list) {
      if (!eventIds.has(entry.id)) continue;
      found += 1;
      const acked = Array.isArray(entry.ackedBy) ? entry.ackedBy.filter((id) => id !== viewer) : [];
      acked.push(viewer);
      entry.ackedBy = acked.slice(-ACKS_MAX);
    }
    if (found > 0) save(list);
    return found;
  }

  /** Hides one notice for one viewer session: 'ok', or 'not-found'. */
  function ack(publicId, viewerSessionId) {
    return ackMany([publicId], viewerSessionId) > 0 ? 'ok' : 'not-found';
  }

  return { record, listFor, ack, ackMany, all: () => load().map((entry) => view(entry, { dismissible: false })) };
}
