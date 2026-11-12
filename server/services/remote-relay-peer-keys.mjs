'use strict';

import crypto from 'node:crypto';

import { PEER_KEY_PREFIX, hashOwnerToken, hashesMatch } from '../../shared/relay-credentials.mjs';
import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_HEADERS,
  REMOTE_RELAY_INBOUND_KEY_PATH,
  REMOTE_RELAY_PEER_KEY_PATHS,
  REMOTE_RELAY_PEER_KEY_PROTOCOL,
  REMOTE_RELAY_PROTOCOL,
  remoteRelayOneWayAdvice,
  remoteRelayReAddAdvice,
} from '../../shared/remote-relay-contract.mjs';
import { isDirectAgentRequest } from './remote-relay-inbound.mjs';

// Peer keys: a paired relay signs in here with a key of its own (`oarp1_…`),
// so the relay part of every origin it sends is the registry entry the key
// names, never what the request claims (origin binding).
//
// Two roles per registry entry:
//
//   issuer  this relay minted keys for that relay: `peerKeys` holds their
//           SHA-256 (never the key), at most the current one, a previous one
//           during a rotation and one in flight. An in-memory index
//           hash → entry is rebuilt on every registry write, so `auth` does
//           one hash and one Map read.
//   holder  that relay minted a key for this one: `peerToken` holds it, like
//           a stored token (never in listPublic, the socket event, a log or a
//           route). Once a call with it worked, the owner token held for that
//           relay is dropped (`tokenMode: 'peer'`). `peerTokenState` says why
//           no key works there: `revoked` (refused, and a new one was not
//           given), `gone` (that relay no longer lists this one) or
//           `required` (it wants a key and this relay holds none). The last
//           two are fixed by adding that relay again from its link; a key
//           delivered later clears the state. `unlisted` is no fault: this
//           relay was added there one way (that relay lists no entry for it,
//           so it gives it no key). It keeps calling on the token it holds,
//           unverified there, and Re-pair (which adds it there) brings keys.
//           That is the fallback for a relay without inbound-only keys
//           (below); `peerInboundOnly` marks the normal one-way case.
//
// Inbound-only keys (one-way pairing): the relay that adds another one with
// "Also add this relay there" off asks it, with the owner token from its
// link, for a key (POST …/peer-key/inbound, the person's call). The issuer
// lists the caller as an inbound-only entry (no address: it never calls it),
// mints the key with the same scope as any peer key and returns it in the
// answer; the caller checks it at the issuer's address (…/peer-key/check),
// keeps only the key (`peerInboundOnly`) and never stores the token. Removing
// the entry on the issuer revokes the key at once; a new request replaces
// it. The key survives the issuer's owner-token rotation.
//
// Issuance (the issuer's side): mint K with the next `seq`, store its hash as
// pending, POST it to the holder at the URL stored here (never back to
// whoever asked), with this relay's credential for it. The holder checks it
// at the issuer's URL it has stored (GET …/peer-key/check with Bearer K): the
// issuer answers `{ issuer, holder, seq }`, and only then the holder keeps K.
// The issuer marks K confirmed on its first normal use; until then the
// previous key stays current. A rotation's delivery carries a proof under the
// current key (HMAC keyed with the current key's hash, which both sides know
// and nobody else does).
//
// Pinning: once an entry was ever keyed its relay id and URL are pinned; a
// change of either (PATCH, a pairing, or the health probe finding another id
// at the URL) revokes its keys, bumps its `epoch` (stored verified origins
// lose their weight) and holds issuance until the owner confirms in
// Settings → Relays.

export const PEER_KEY_LIMITS = Object.freeze({
  // A key minted and not checked by its holder is dropped after this.
  pendingMs: 10 * 60_000,
  // The previous key stays valid this long after the new one is confirmed.
  retireGraceMs: 10 * 60_000,
  rotateAfterMs: 30 * 24 * 60 * 60_000,
  // A holder may still ask for a new key with a key retired this recently.
  retiredRequestMs: 7 * 24 * 60 * 60_000,
  lastUsedWriteMs: 60_000,
  requestIntervalMs: 60_000,
  // Probes in a row below protocol 2 before the issuer stops requiring a key.
  downgradeProbes: 3,
  checkTimeoutMs: 8_000,
  deliverTimeoutMs: 20_000,
  refusalLogWindowMs: 60_000,
});

export const PEER_KEY_STATUS = Object.freeze({
  active: 'active',
  waiting: 'waiting',
  older: 'older',
  held: 'held',
  revoked: 'revoked',
  none: 'none',
});

const MAX_KEYS = 3;
// Why no key from that relay works (holder side), see the header.
const PEER_TOKEN_STATES = Object.freeze(['revoked', 'gone', 'required', 'unlisted']);
const HEX64 = /^[0-9a-f]{64}$/;

function toText(value) {
  return String(value ?? '').trim();
}

function isoOrNull(value) {
  const text = toText(value);
  return text && !Number.isNaN(Date.parse(text)) ? text.slice(0, 40) : null;
}

function nonNegativeInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function msOf(iso) {
  const at = Date.parse(String(iso || ''));
  return Number.isFinite(at) ? at : 0;
}

export function mintPeerKey(randomBytes = crypto.randomBytes) {
  return `${PEER_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashPeerKey(key) {
  return hashOwnerToken(key);
}

function proofFromHash(currentHash, seq, newKeyHash) {
  return crypto.createHmac('sha256', String(currentHash || '')).update(`rotate|${seq}|${newKeyHash}`).digest('hex');
}

/** The proof a rotation's delivery carries: HMAC under the current key's hash. */
export function peerKeyRotationProof(currentKey, seq, newKey) {
  return proofFromHash(hashPeerKey(currentKey), seq, hashPeerKey(newKey));
}

function isPeerKeyValue(value) {
  const text = toText(value);
  return text.startsWith(PEER_KEY_PREFIX) && text.length > PEER_KEY_PREFIX.length + 20 && text.length < 200;
}

function normalizeKeyRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const hash = toText(raw.hash).toLowerCase();
  if (!HEX64.test(hash)) return null;
  return {
    hash,
    seq: nonNegativeInt(raw.seq),
    issuedAt: isoOrNull(raw.issuedAt),
    checkedAt: isoOrNull(raw.checkedAt),
    confirmedAt: isoOrNull(raw.confirmedAt),
    lastUsedAt: isoOrNull(raw.lastUsedAt),
    retiresAt: isoOrNull(raw.retiresAt),
  };
}

function normalizeHold(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reason = ['url', 'relayId'].includes(raw.reason) ? raw.reason : 'relayId';
  return {
    reason,
    relayId: toText(raw.relayId).slice(0, 100) || null,
    url: toText(raw.url).slice(0, 300) || null,
    at: isoOrNull(raw.at),
  };
}

/**
 * The peer-key fields of a stored registry entry, defensively normalised
 * (remote-relay-registry-service.mjs spreads them into every entry).
 */
export function normalizePeerKeyFields(raw = {}) {
  const keys = (Array.isArray(raw.peerKeys) ? raw.peerKeys : [])
    .map(normalizeKeyRecord).filter(Boolean).slice(-MAX_KEYS);
  const peerToken = isPeerKeyValue(raw.peerToken) ? toText(raw.peerToken) : '';
  const fields = {
    peerKeys: keys,
    peerKeySeq: Math.max(nonNegativeInt(raw.peerKeySeq), ...keys.map((key) => key.seq), 0),
    everKeyed: raw.everKeyed === true,
    keyRelayId: toText(raw.keyRelayId).slice(0, 100) || null,
    keyUrl: toText(raw.keyUrl).slice(0, 300) || null,
    epoch: nonNegativeInt(raw.epoch),
    identityHold: normalizeHold(raw.identityHold),
    keyRevoked: raw.keyRevoked === true,
    unconfirmed: raw.unconfirmed === true,
    downgradeProbes: nonNegativeInt(raw.downgradeProbes),
    downgraded: raw.downgraded === true,
    refusalNoticeAt: isoOrNull(raw.refusalNoticeAt),
    refusalNoticeDismissedAt: isoOrNull(raw.refusalNoticeDismissedAt),
    refusalNoticeEpoch: nonNegativeInt(raw.refusalNoticeEpoch),
    refusalNoticeCode: [REMOTE_RELAY_ERROR_CODES.originMismatch, REMOTE_RELAY_ERROR_CODES.peerKeyRequired].includes(raw.refusalNoticeCode)
      ? raw.refusalNoticeCode
      : null,
    // Holder side: that relay lists this one inbound only (it was added
    // there one way); the key it gave is the only credential held for it.
    peerInboundOnly: raw.peerInboundOnly === true,
  };
  if (peerToken) {
    fields.peerToken = peerToken;
    fields.peerTokenSeq = nonNegativeInt(raw.peerTokenSeq);
    fields.peerTokenConfirmedAt = isoOrNull(raw.peerTokenConfirmedAt);
  }
  fields.peerTokenState = PEER_TOKEN_STATES.includes(raw.peerTokenState) ? raw.peerTokenState : null;
  return fields;
}

/**
 * A pinned address as compared: scheme and host in lower case (they are
 * case-insensitive), the path as it is (two relays on one host under base
 * paths that differ in case are two addresses).
 */
export function pinnedUrlKey(value) {
  const text = toText(value).replace(/\/+$/, '');
  try {
    const parsed = new URL(text);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    return text;
  }
}

/**
 * The key this relay may use to call `relay`, or '' (none, not at protocol 2,
 * or withheld). A key goes only to the address it was keyed at: while an
 * identity change is held (another address, or another relay at it) it is
 * not sent, nor while the address differs from the pinned one.
 */
export function usablePeerToken(relay) {
  if (!relay || !isPeerKeyValue(relay.peerToken)) return '';
  if (relay.peerTokenState === 'revoked' || relay.peerTokenState === 'gone') return '';
  if (!(Number(relay.protocol) >= REMOTE_RELAY_PEER_KEY_PROTOCOL)) return '';
  if (peerTokenWithheld(relay)) return '';
  return toText(relay.peerToken);
}

/**
 * Is `relay` held (its identity changed: another relay answered at its
 * address, or the address is not the one it was keyed at)? Nothing this
 * relay holds for it, key or token, is sent until the owner confirms.
 */
export function identityHeld(relay) {
  if (!relay) return false;
  if (relay.identityHold) return true;
  return !!toText(relay.keyUrl) && pinnedUrlKey(relay.url) !== pinnedUrlKey(relay.keyUrl);
}

/** Does `relay` hold a key from that relay that is not sent (a held identity change)? */
export function peerTokenWithheld(relay) {
  if (!relay || !isPeerKeyValue(relay.peerToken)) return false;
  return identityHeld(relay);
}

/**
 * The relay id and address an entry is pinned to, or null: an entry this
 * relay keyed (issuer side), or one whose key this relay holds (holder side,
 * a one-way pairing too), so a key never follows a changed identity.
 */
function pinnedIdentityOf(entry) {
  if (!entry) return null;
  if (entry.everKeyed) return { relayId: toText(entry.keyRelayId || entry.relayId), url: entry.keyUrl || entry.url };
  if (isPeerKeyValue(entry.peerToken)) return { relayId: toText(entry.relayId), url: entry.keyUrl || entry.url };
  return null;
}

/** Is this entry one whose claims must come with its key (keyed, not downgraded)? */
export function entryRequiresPeerKey(entry) {
  return !!entry && entry.everKeyed === true && entry.downgraded !== true;
}

/** Does the issuer side hold a confirmed key for this entry? */
export function entryHasConfirmedKey(entry, nowMs = Date.now()) {
  return (Array.isArray(entry?.peerKeys) ? entry.peerKeys : [])
    .some((key) => key.confirmedAt && (!key.retiresAt || msOf(key.retiresAt) > nowMs));
}

/**
 * The peer-key state shown on an entry's row: `status` (active, waiting,
 * older, held, revoked, none), `lastUsedAt`, `theirKey` (this relay holds a
 * key from that relay), `leastPrivilege` (no owner token held for it).
 */
export function describePeerKeyState(entry, nowMs = Date.now()) {
  if (!entry) return null;
  const protocol = Number(entry.protocol) || 0;
  const confirmed = (entry.peerKeys || []).filter((key) => key.confirmedAt && (!key.retiresAt || msOf(key.retiresAt) > nowMs));
  const current = confirmed.reduce((best, key) => (!best || key.seq > best.seq ? key : best), null);
  let status;
  if (entry.identityHold) status = PEER_KEY_STATUS.held;
  else if (entry.keyRevoked) status = PEER_KEY_STATUS.revoked;
  else if (protocol < REMOTE_RELAY_PEER_KEY_PROTOCOL || entry.downgraded) status = PEER_KEY_STATUS.older;
  else if (current) status = PEER_KEY_STATUS.active;
  else status = PEER_KEY_STATUS.waiting;
  return {
    status,
    lastUsedAt: current?.lastUsedAt || null,
    confirmedAt: current?.confirmedAt || null,
    theirKey: !!usablePeerToken(entry) || (isPeerKeyValue(entry.peerToken) && entry.peerTokenState == null),
    theirKeyState: entry.peerTokenState || null,
    leastPrivilege: entry.tokenMode === 'peer',
    hold: entry.identityHold ? { reason: entry.identityHold.reason, relayId: entry.identityHold.relayId, url: entry.identityHold.url, at: entry.identityHold.at } : null,
    unconfirmed: entry.unconfirmed === true,
    // Holder side: that relay lists this one inbound only.
    listedInboundOnly: entry.peerInboundOnly === true,
    // Issuer side: this entry calls in only (no address here).
    inboundOnly: entry.inboundOnly === true,
  };
}

/** Express-style pattern match for the few route checks done here. */
function claimedRelayIdOf(req) {
  const header = req?.headers?.[REMOTE_RELAY_HEADERS.origin];
  const fromHeader = toText(Array.isArray(header) ? header[0] : header);
  const body = req?.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  const origin = body && body.origin && typeof body.origin === 'object' && !Array.isArray(body.origin) ? body.origin : null;
  const fromBody = toText(origin?.relayId);
  return { fromHeader: fromHeader.slice(0, 100), fromBody: fromBody.slice(0, 100) };
}

// Routes where a claim is neither stored nor used, and that a relay calls on
// another credential on purpose: its identity probe, the legacy probe, the
// pairing introduction and the key routes (a holder that lost its key asks
// for one on the owner token it may still hold).
const CLAIM_NEUTRAL_ROUTES = new Set([
  'GET /api/relay/identity',
  'GET /api/status',
  'GET /api/settings/pwa-app-name',
  'POST /api/remote-relays/pair',
  `POST ${REMOTE_RELAY_PEER_KEY_PATHS.deliver}`,
  `GET ${REMOTE_RELAY_PEER_KEY_PATHS.check}`,
  `POST ${REMOTE_RELAY_PEER_KEY_PATHS.request}`,
  // Re-adding one way asks for a new inbound-only key on the owner token
  // while the old key still names that relay.
  `POST ${REMOTE_RELAY_INBOUND_KEY_PATH}`,
]);

function routeKeyOf(req) {
  const routePath = req?.route?.path;
  const method = String(req?.method || '').toUpperCase() === 'HEAD' ? 'GET' : String(req?.method || '').toUpperCase();
  return `${method} ${typeof routePath === 'string' ? routePath : (req?.path || '')}`;
}

export function createPeerKeyService({
  registry,
  client,
  logger = console,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  // The local Inbox item on an entry's first refused claim (a re-render).
  onRefusalNotice = () => {},
} = {}) {
  // hash → { entryId, keySeq }; entryId → snapshot of the entry's fields auth needs.
  let index = new Map();
  let snapshots = new Map();
  const refusals = new Map();
  const refusalLog = new Map();
  const inFlight = new Map();
  const lastRequestAt = new Map();
  const failedDeliveryAt = new Map();
  const deliveriesInFlight = new Set();
  const lastUsedWrites = new Map();
  const holderRequests = new Map();

  function nowMs() {
    return now().getTime();
  }

  function nowIso() {
    return now().toISOString();
  }

  /** Called by the registry with the full list after every write (and at start). */
  function rebuildIndex(entries) {
    const nextIndex = new Map();
    const nextSnapshots = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry?.id) continue;
      nextSnapshots.set(entry.id, {
        id: entry.id,
        relayId: entry.relayId || '',
        name: entry.name || '',
        url: entry.url || '',
        epoch: Number(entry.epoch) || 0,
        everKeyed: entry.everKeyed === true,
        downgraded: entry.downgraded === true,
        identityHold: !!entry.identityHold,
        keyRevoked: entry.keyRevoked === true,
      });
      if (entry.identityHold || entry.keyRevoked) continue;
      for (const key of entry.peerKeys || []) {
        nextIndex.set(key.hash, { entryId: entry.id, seq: key.seq, issuedAt: key.issuedAt, checkedAt: key.checkedAt, confirmedAt: key.confirmedAt, retiresAt: key.retiresAt });
      }
    }
    index = nextIndex;
    snapshots = nextSnapshots;
  }

  function snapshotOf(entryId) {
    return snapshots.get(toText(entryId)) || null;
  }

  function snapshotByRelayId(relayId) {
    const id = toText(relayId);
    if (!id) return null;
    for (const snapshot of snapshots.values()) {
      if (snapshot.relayId === id) return snapshot;
    }
    return null;
  }

  // ─── auth ──────────────────────────────────────────────────────────────────

  /**
   * `createRelayAuth`'s resolvePeerKey: the principal of a Bearer `oarp1_…`,
   * or null (401, counted like a wrong token). A key its holder has not
   * checked yet is good for the check route only (`checkOnly`).
   */
  function resolvePeerKey(value) {
    if (!isPeerKeyValue(value)) return null;
    const hash = hashPeerKey(value);
    const found = index.get(hash);
    if (!found) return null;
    const entry = snapshotOf(found.entryId);
    if (!entry) return null;
    const at = nowMs();
    if (found.retiresAt && msOf(found.retiresAt) <= at) return null;
    const unchecked = !found.checkedAt && !found.confirmedAt;
    if (!found.confirmedAt && msOf(found.issuedAt) + PEER_KEY_LIMITS.pendingMs <= at && unchecked) return null;
    return {
      entryId: entry.id,
      relayId: entry.relayId,
      name: entry.name,
      url: entry.url,
      epoch: entry.epoch,
      keySeq: found.seq,
      keyHash: hash,
      ...(unchecked ? { checkOnly: true } : {}),
      ...(found.confirmedAt ? {} : { unconfirmed: true }),
    };
  }

  function writeRefusalLog(code, label, claimed, req) {
    const route = routeKeyOf(req);
    const key = `${label}\n${code}\n${route}`;
    const at = nowMs();
    const state = refusalLog.get(key);
    if (state && at - state.at < PEER_KEY_LIMITS.refusalLogWindowMs) {
      state.held += 1;
      return;
    }
    const held = state?.held || 0;
    refusalLog.set(key, { at, held: 0 });
    if (refusalLog.size > 512) refusalLog.delete(refusalLog.keys().next().value);
    const tail = held ? ` (+${held} more since the last line)` : '';
    try {
      logger?.warn?.(`[remote-relays] origin refused: ${code} peer=${label} claimed=${toText(claimed).slice(0, 8) || '-'} route=${route}${tail}`);
    } catch {}
  }

  function countRefusal(entryId, code) {
    const id = toText(entryId);
    if (!id) return;
    refusals.set(id, (refusals.get(id) || 0) + 1);
    // One Inbox item on the entry's first refusal (re-armed by a new epoch).
    try {
      const entry = registry.get(id);
      if (!entry) return;
      const epoch = Number(entry.epoch) || 0;
      if (entry.refusalNoticeAt && entry.refusalNoticeEpoch === epoch) return;
      registry.patchPeerFields(id, {
        refusalNoticeAt: nowIso(),
        refusalNoticeDismissedAt: null,
        refusalNoticeEpoch: epoch,
        refusalNoticeCode: code,
      });
      onRefusalNotice(id);
    } catch (error) {
      try { logger?.warn?.(`[remote-relays] the refusal notice could not be stored: ${error?.message || error}`); } catch {}
    }
  }

  function refuse(res, status, code, error) {
    res.status(status).json({ error, code });
  }

  /**
   * Runs after `auth` let a request in (createRelayAuth's `afterPrincipal`):
   * the origin-binding refusals, and the first-use confirmation of a key.
   * Returns true after answering a refusal.
   */
  function gate(req, res, principal) {
    const route = routeKeyOf(req);
    const { fromHeader, fromBody } = claimedRelayIdOf(req);
    if (principal?.kind === 'peer') {
      const claimed = [fromHeader, fromBody].find((value) => value && value !== principal.relayId);
      if (claimed) {
        writeRefusalLog(REMOTE_RELAY_ERROR_CODES.originMismatch, principal.name || principal.entryId, claimed, req);
        countRefusal(principal.entryId, REMOTE_RELAY_ERROR_CODES.originMismatch);
        refuse(res, 403, REMOTE_RELAY_ERROR_CODES.originMismatch,
          'Refused: this paired relay signed in with its own key and claimed to be another relay. A paired relay can only speak for itself.');
        return true;
      }
      if (!principal.checkOnly) noteKeyUse(principal);
      return false;
    }
    if (CLAIM_NEUTRAL_ROUTES.has(route)) return false;
    // An agent token's own request speaks for no relay: its claim is
    // ignored where origins are read (readRemoteRelayRequest), so it is not
    // refused here and never counts against the relay it named.
    if (isDirectAgentRequest(req)) return false;
    // The owner token or a browser claiming a relay that signs in with a key
    // of its own: that relay would have used its key.
    for (const claimed of new Set([fromHeader, fromBody].filter(Boolean))) {
      const snapshot = snapshotByRelayId(claimed);
      if (!snapshot || !snapshot.everKeyed || snapshot.downgraded) continue;
      writeRefusalLog(REMOTE_RELAY_ERROR_CODES.peerKeyRequired, 'owner-token', claimed, req);
      countRefusal(snapshot.id, REMOTE_RELAY_ERROR_CODES.peerKeyRequired);
      refuse(res, 403, REMOTE_RELAY_ERROR_CODES.peerKeyRequired,
        `Refused: relay "${snapshot.name}" signs in here with a key of its own, and this request claimed to be it without that key. If you are that relay and lost the key, re-add this relay there from its link (Settings → Relays → Add a relay, paste this relay's pairing link).`);
      return true;
    }
    return false;
  }

  /** First normal use confirms a key; `lastUsedAt` is written at most once a minute. */
  function noteKeyUse(principal) {
    const entryId = principal.entryId;
    const at = nowMs();
    if (principal.unconfirmed) {
      confirmKey(entryId, principal.keyHash);
      return;
    }
    const last = lastUsedWrites.get(entryId) || 0;
    if (at - last < PEER_KEY_LIMITS.lastUsedWriteMs) return;
    lastUsedWrites.set(entryId, at);
    try {
      registry.patchPeerFields(entryId, (entry) => ({
        peerKeys: entry.peerKeys.map((key) => (key.hash === principal.keyHash ? { ...key, lastUsedAt: nowIso() } : key)),
      }), { quiet: true });
    } catch {}
  }

  function confirmKey(entryId, keyHash) {
    let confirmed = false;
    try {
      registry.patchPeerFields(entryId, (entry) => {
        const target = entry.peerKeys.find((key) => key.hash === keyHash);
        if (!target || target.confirmedAt) return null;
        confirmed = true;
        const stamp = nowIso();
        const retiresAt = new Date(nowMs() + PEER_KEY_LIMITS.retireGraceMs).toISOString();
        return {
          peerKeys: entry.peerKeys.map((key) => {
            if (key.hash === keyHash) return { ...key, confirmedAt: stamp, checkedAt: key.checkedAt || stamp, lastUsedAt: stamp };
            // Older keys retire 10 minutes from now; unconfirmed older ones go.
            if (key.seq < target.seq) return key.confirmedAt ? { ...key, retiresAt: key.retiresAt || retiresAt } : null;
            return key;
          }).filter(Boolean),
          everKeyed: true,
          keyRelayId: entry.keyRelayId || entry.relayId,
          keyUrl: entry.keyUrl || entry.url,
          unconfirmed: false,
        };
      });
    } catch (error) {
      try { logger?.warn?.(`[remote-relays] confirming a peer key failed: ${error?.message || error}`); } catch {}
    }
    if (confirmed) {
      const entry = registry.get(entryId);
      try { logger?.log?.(`[remote-relays] peer key confirmed: "${entry?.name || entryId}" signs in with its own key now.`); } catch {}
    }
  }

  function refusedCount(entryId) {
    return refusals.get(toText(entryId)) || 0;
  }

  // ─── issuer: mint, deliver ─────────────────────────────────────────────────

  function credentialFor(entry) {
    return client.tokenFor(entry);
  }

  function pruneKeys(entry) {
    const at = nowMs();
    return (entry.peerKeys || []).filter((key) => {
      if (key.retiresAt && msOf(key.retiresAt) <= at - PEER_KEY_LIMITS.retiredRequestMs) return false;
      if (!key.confirmedAt && !key.checkedAt && msOf(key.issuedAt) + PEER_KEY_LIMITS.pendingMs <= at) return false;
      return true;
    });
  }

  /**
   * Mints a key for entry `entryId` and delivers it to that relay's stored
   * URL. One issuance per entry at a time (a second trigger joins the first).
   * `{ ok, code?, error? }`.
   */
  function issueTo(entryId, { reason = 'issue' } = {}) {
    const id = toText(entryId);
    if (inFlight.has(id)) return inFlight.get(id);
    const run = (async () => {
      const entry = registry.get(id);
      if (!entry) return { ok: false, code: 'unknown', error: 'Unknown remote relay' };
      // No address to deliver to: its key came in the answer to its request.
      if (entry.inboundOnly) return { ok: false, code: 'inbound-only', error: `Relay "${entry.name}" calls this relay only (inbound only): it has no address here to send a key to. It asks for a new one when it is added again.` };
      // That relay lists this one inbound only and takes no key from it.
      if (entry.peerInboundOnly) return { ok: false, code: 'one-way', error: `Relay "${entry.name}" lists this relay as inbound only and takes no key from it` };
      if (entry.identityHold) return { ok: false, code: 'held', error: 'The identity of this relay changed; confirm it in Settings → Relays first' };
      if (entry.keyRevoked && reason !== 'renew' && reason !== 'relinked') return { ok: false, code: 'revoked', error: 'Its key was revoked; Renew issues a new one' };
      if (!(Number(entry.protocol) >= REMOTE_RELAY_PEER_KEY_PROTOCOL)) {
        return { ok: false, code: 'older', error: `Relay "${entry.name}" runs an older OAR without keys` };
      }
      if (!toText(entry.relayId)) return { ok: false, code: 'unknown-id', error: 'The relay id of that relay is not known yet' };
      const credential = credentialFor(entry);
      if (!credential) return { ok: false, code: 'no-credential', error: `This relay holds no credential for "${entry.name}" to send a key with` };
      const key = mintPeerKey(randomBytes);
      const keyHash = hashPeerKey(key);
      const seq = (Number(entry.peerKeySeq) || 0) + 1;
      const current = (entry.peerKeys || []).filter((record) => record.confirmedAt && !record.retiresAt).sort((a, b) => b.seq - a.seq)[0] || null;
      registry.patchPeerFields(id, (stored) => ({
        peerKeys: [...pruneKeys(stored).filter((record) => record.confirmedAt), { hash: keyHash, seq, issuedAt: nowIso(), checkedAt: null, confirmedAt: null, lastUsedAt: null, retiresAt: null }].slice(-MAX_KEYS),
        peerKeySeq: seq,
        keyRevoked: false,
      }), { quiet: true });
      const body = {
        issuer: registry.instanceId(),
        seq,
        key,
        ...(current ? { proof: proofFromHash(current.hash, seq, keyHash) } : {}),
      };
      try {
        await client.request(entry, 'POST', REMOTE_RELAY_PEER_KEY_PATHS.deliver, { body, timeoutMs: PEER_KEY_LIMITS.deliverTimeoutMs, peerKeyRetry: false });
        try { logger?.log?.(`[remote-relays] peer key ${current ? 'rotated' : 'issued'} for "${entry.name}" (${reason}); delivered.`); } catch {}
        return { ok: true, seq };
      } catch (error) {
        // Not delivered: the pending hash goes, the previous key stays current.
        registry.patchPeerFields(id, (stored) => ({ peerKeys: stored.peerKeys.filter((record) => record.hash !== keyHash) }), { quiet: true });
        try { logger?.warn?.(`[remote-relays] peer key for "${entry.name}" not delivered (${reason}): ${toText(error?.message) || 'failed'}`); } catch {}
        return { ok: false, code: toText(error?.code) || 'delivery-failed', error: toText(error?.message) || 'The key could not be delivered' };
      }
    })().finally(() => {
      inFlight.delete(id);
    });
    inFlight.set(id, run);
    return run;
  }

  /**
   * GET …/peer-key/check, with Bearer K (checkOnly): `{ issuer, holder, seq }`
   * for the key the request presents. Marks it checked.
   */
  function handleCheck(principal) {
    if (principal?.kind !== 'peer') return { status: 401, body: { error: 'Unauthorized' } };
    registry.patchPeerFields(principal.entryId, (entry) => ({
      peerKeys: entry.peerKeys.map((key) => (key.hash === principal.keyHash && !key.checkedAt ? { ...key, checkedAt: nowIso() } : key)),
    }), { quiet: true });
    return { status: 200, body: { issuer: registry.instanceId(), holder: principal.relayId, seq: principal.keySeq } };
  }

  // ─── holder: take a delivery ───────────────────────────────────────────────

  /**
   * POST …/peer-key `{ issuer, seq, key, proof? }` from the relay `issuer`
   * (with its credential for this relay). Kept only after the check at the
   * issuer's stored URL agrees. `principal` is who signed in: the issuer's
   * own key (a paired relay delivers for itself alone) or the owner token
   * (the issuer holds this relay's token, or the person).
   */
  async function handleDelivery(principal, body = {}) {
    if (principal?.kind !== 'peer' && principal?.kind !== 'owner' && principal?.kind !== 'browser') {
      return { status: 403, body: { error: 'Only the relay that made a key delivers it', code: REMOTE_RELAY_ERROR_CODES.peerScope } };
    }
    const input = body && typeof body === 'object' ? body : {};
    const issuer = toText(input.issuer).slice(0, 100);
    const key = toText(input.key);
    const seq = nonNegativeInt(input.seq, -1);
    if (!issuer || !isPeerKeyValue(key) || seq < 1) return { status: 400, body: { error: 'issuer, seq and key are required', code: REMOTE_RELAY_ERROR_CODES.invalidInput } };
    if (principal.kind === 'peer' && toText(principal.relayId) !== issuer) {
      try { logger?.warn?.(`[remote-relays] "${toText(principal.name) || principal.entryId}" delivered a key in another relay's name; refused.`); } catch {}
      return { status: 403, body: { error: 'A paired relay delivers only the keys it made itself', code: REMOTE_RELAY_ERROR_CODES.originMismatch } };
    }
    const matches = registry.list().filter((entry) => entry.relayId === issuer);
    if (matches.length !== 1) return { status: 404, body: { error: 'No single paired relay with that id', code: REMOTE_RELAY_ERROR_CODES.notFound } };
    const entry = matches[0];
    if (principal.kind === 'peer' && principal.entryId !== entry.id) {
      return { status: 403, body: { error: 'A paired relay delivers only the keys it made itself', code: REMOTE_RELAY_ERROR_CODES.originMismatch } };
    }
    if (entry.identityHold) return { status: 409, body: { error: 'This relay holds that pairing until its owner confirms a changed identity', code: REMOTE_RELAY_ERROR_CODES.peerKeyRequired } };
    const heldSeq = isPeerKeyValue(entry.peerToken) ? Number(entry.peerTokenSeq) || 0 : 0;
    if (seq <= heldSeq) {
      // A replay, or an older delivery: nothing changes.
      return { status: 200, body: { ok: true, unchanged: true } };
    }
    // An inbound-only key is replaced when that relay lists this one both
    // ways: the check at its address below stands for the proof.
    if (isPeerKeyValue(entry.peerToken) && entry.peerTokenState == null && !entry.peerInboundOnly) {
      const expected = proofFromHash(hashPeerKey(entry.peerToken), seq, hashPeerKey(key));
      if (!hashesMatch(expected, toText(input.proof).toLowerCase())) {
        try { logger?.warn?.(`[remote-relays] a key delivery for "${entry.name}" without a valid rotation proof was ignored.`); } catch {}
        return { status: 403, body: { error: 'A new key needs a proof under the current one', code: REMOTE_RELAY_ERROR_CODES.peerKeyRequired } };
      }
    }
    // A delivery costs a call to the issuer's address with the key as
    // Bearer; a key the issuer does not know counts toward its lockout of
    // this relay. After a key it refused (or a check that did not match),
    // the next delivery for the entry waits a minute; one that checks out,
    // or a check that never got there, costs nothing there.
    const at = nowMs();
    if ((failedDeliveryAt.get(entry.id) || 0) + PEER_KEY_LIMITS.requestIntervalMs > at) {
      return { status: 429, body: { error: 'A key delivered less than a minute ago did not check out; try again later', code: REMOTE_RELAY_ERROR_CODES.rateLimited } };
    }
    // One check per entry at a time: deliveries sent together would all
    // reach the issuer before the first one's failure counts.
    if (deliveriesInFlight.has(entry.id)) {
      return { status: 429, body: { error: 'A key delivery for this relay is being checked; try again later', code: REMOTE_RELAY_ERROR_CODES.rateLimited } };
    }
    deliveriesInFlight.add(entry.id);
    try {
      return await checkAndStore(entry, { key, seq, at });
    } finally {
      deliveriesInFlight.delete(entry.id);
    }
  }

  async function checkAndStore(entry, { key, seq, at }) {
    const failed = (body) => {
      failedDeliveryAt.set(entry.id, at);
      return { status: 403, body };
    };
    // The check: the issuer at the URL stored here must know this key.
    let answer;
    try {
      answer = await client.request({ ...entry, tokenMode: 'custom', token: key, peerToken: undefined }, 'GET', REMOTE_RELAY_PEER_KEY_PATHS.check, {
        timeoutMs: PEER_KEY_LIMITS.checkTimeoutMs,
        peerKeyRetry: false,
        rawToken: key,
      });
    } catch (error) {
      try { logger?.warn?.(`[remote-relays] a key delivery for "${entry.name}" failed its check at ${entry.url}: ${toText(error?.message) || 'failed'}`); } catch {}
      const refusal = { error: 'The key did not check out at that relay\'s address', code: REMOTE_RELAY_ERROR_CODES.peerKeyRequired };
      // Refused there (a key it does not know): counted against this relay.
      const refused = Number(error?.status) === 401 || error?.code === REMOTE_RELAY_ERROR_CODES.unauthorized;
      return refused ? failed(refusal) : { status: 403, body: refusal };
    }
    if (toText(answer?.issuer) !== toText(entry.relayId) || toText(answer?.holder) !== registry.instanceId() || Number(answer?.seq) !== seq) {
      try { logger?.warn?.(`[remote-relays] a key delivery for "${entry.name}" did not match its check; dropped.`); } catch {}
      return failed({ error: 'The key did not check out at that relay\'s address', code: REMOTE_RELAY_ERROR_CODES.peerKeyRequired });
    }
    registry.patchPeerFields(entry.id, {
      peerToken: key,
      peerTokenSeq: seq,
      peerTokenConfirmedAt: null,
      peerTokenState: null,
      // A delivery means that relay lists this one both ways now.
      peerInboundOnly: false,
      // The check proved who answers at that URL.
      unconfirmed: false,
    });
    try { logger?.log?.(`[remote-relays] peer key from "${entry.name}" stored (seq ${seq}).`); } catch {}
    // First normal use confirms it on the issuer; the owner token held for
    // that relay goes once the call worked.
    setImmediateSafe(() => confirmHeldKey(entry.id));
    return { status: 200, body: { ok: true } };
  }

  function setImmediateSafe(fn) {
    setImmediate(() => {
      Promise.resolve().then(fn).catch(() => {});
    });
  }

  async function confirmHeldKey(entryId) {
    const entry = registry.get(entryId);
    if (!entry || !usablePeerToken(entry)) return false;
    try {
      await client.request(entry, 'GET', '/api/relay/identity', { timeoutMs: PEER_KEY_LIMITS.checkTimeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** The client's hook after a call with the key worked: confirmed, and the owner token goes. */
  function noteHeldKeyWorked(relay) {
    const entry = registry.get(relay?.id);
    if (!entry || !usablePeerToken(entry) || toText(entry.peerToken) !== toText(relay.peerToken)) return;
    const fields = {};
    if (!entry.peerTokenConfirmedAt) fields.peerTokenConfirmedAt = nowIso();
    if (entry.tokenMode !== 'peer') {
      fields.tokenMode = 'peer';
      fields.token = undefined;
    }
    if (!Object.keys(fields).length) return;
    registry.patchPeerFields(entry.id, fields);
    if (fields.tokenMode === 'peer') {
      try { logger?.log?.(`[remote-relays] "${entry.name}" took this relay's key; the token held for it was dropped.`); } catch {}
    }
  }

  /**
   * The client's hook after a call with the key was refused (401, or 403
   * PEER_KEY_REQUIRED): ask for a new key once, then retry once. Returns the
   * fresh entry to retry with, or null.
   */
  async function onHeldKeyRefused(relay) {
    const entry = registry.get(relay?.id);
    if (!entry) return null;
    const at = nowMs();
    if ((holderRequests.get(entry.id) || 0) + PEER_KEY_LIMITS.requestIntervalMs > at) return null;
    holderRequests.set(entry.id, at);
    const requested = await requestKeyFrom(entry, { presentKey: relay.peerToken });
    if (!requested.ok) {
      registry.patchPeerFields(entry.id, { peerTokenState: requested.gone ? 'gone' : 'revoked' });
      try { logger?.warn?.(`[remote-relays] "${entry.name}" refused this relay's key: ${requested.gone ? remoteRelayReAddAdvice(entry.name) : 'key revoked by the other relay'}.`); } catch {}
      return null;
    }
    const fresh = registry.get(entry.id);
    return usablePeerToken(fresh) && fresh.peerToken !== relay.peerToken ? fresh : null;
  }

  /**
   * The client's hook after a paired relay answered 403 PEER_KEY_REQUIRED to
   * a call made without a key from it (this relay holds none, or none it may
   * use): the row says to add that relay again from its link. A key
   * delivered later (the health loop keeps asking with a token it holds)
   * clears it.
   */
  function noteKeyRequired(relay) {
    const entry = registry.get(relay?.id);
    // Added one way: that relay lists no entry for this one, so its key-only
    // routes refuse this relay by design, and re-adding from the link would
    // not change that (Re-pair would).
    if (!entry || usablePeerToken(entry) || entry.peerTokenState === 'required' || entry.peerTokenState === 'unlisted') return;
    registry.patchPeerFields(entry.id, { peerTokenState: 'required' });
    try { logger?.warn?.(`[remote-relays] "${entry.name}" wants this relay's key for it, and this relay holds none it takes: ${remoteRelayReAddAdvice(entry.name)}.`); } catch {}
  }

  /**
   * The issuer answered a key request with 404: it lists no entry for this
   * relay. With no key held from it and none refused before, that is a
   * one-way add (`unlisted`), not a fault; a relay that took this one's key
   * before and dropped it reads `gone` (onHeldKeyRefused). Logged once.
   */
  function noteUnlisted(entryId) {
    const entry = registry.get(entryId);
    if (!entry || usablePeerToken(entry)) return false;
    if (entry.peerTokenState !== null && entry.peerTokenState !== 'required') return false;
    registry.patchPeerFields(entry.id, { peerTokenState: 'unlisted' });
    try { logger?.log?.(`[remote-relays] "${entry.name}" does not list this relay (added one way): it gives this relay no key, so this relay calls it with the token it holds and it takes this relay's prompts as claimed. To switch to keys, ${remoteRelayOneWayAdvice(entry.name)}.`); } catch {}
    return true;
  }

  /**
   * Asks `entry` (the issuer) for a key: POST …/peer-key/request with the key
   * held (or one retired lately), else the owner token held for it. The key
   * itself never comes back in the answer: the issuer delivers it.
   * `relink`: the owner token was just given in that relay's pairing link
   * (an add from the link), which renews a key it revoked (handleRequest).
   */
  async function requestKeyFrom(entry, { presentKey = '', relink = false } = {}) {
    const candidates = [];
    if (isPeerKeyValue(presentKey)) candidates.push({ target: { ...entry, tokenMode: 'custom', token: presentKey, peerToken: undefined }, owner: false });
    if (entry.tokenMode === 'custom' && toText(entry.token)) candidates.push({ target: { ...entry, peerToken: undefined }, owner: true });
    for (const { target, owner } of candidates) {
      try {
        await client.request(target, 'POST', REMOTE_RELAY_PEER_KEY_PATHS.request, {
          body: { relayId: registry.instanceId(), ...(relink && owner ? { relink: true } : {}) },
          timeoutMs: PEER_KEY_LIMITS.deliverTimeoutMs,
          peerKeyRetry: false,
        });
        return { ok: true };
      } catch (error) {
        if (Number(error?.status) === 404) return { ok: false, gone: true };
      }
    }
    return { ok: false };
  }

  /**
   * POST …/peer-key/request from relay `principal` (its key, a key retired
   * less than 7 days ago, or the owner token with `{ relayId }`). Starts an
   * issuance to that relay's stored URL; the answer never carries a key.
   *
   * `{ relink: true }` on the owner token (or from the person's browser) is
   * that relay being added again from this relay's pairing link: the person
   * of this relay, as with Renew, so a revoked key is renewed and the minute
   * between requests does not apply. An issuance already on its way there
   * (a Renew clicked at the same time) is the one it waits for: one key
   * at a time per entry, delivered to the stored address alone.
   */
  async function handleRequest(principal, body = {}) {
    let entry = null;
    let person = false;
    if (principal?.kind === 'peer') {
      entry = registry.get(principal.entryId);
    } else if (principal?.kind === 'owner' || principal?.kind === 'browser') {
      person = true;
      const relayId = toText(body?.relayId);
      const matches = relayId ? registry.list().filter((candidate) => candidate.relayId === relayId) : [];
      entry = matches.length === 1 ? matches[0] : null;
    } else {
      return { status: 403, body: { error: 'Only a paired relay asks for a key', code: REMOTE_RELAY_ERROR_CODES.peerScope } };
    }
    if (!entry) return { status: 404, body: { error: 'This relay does not list the calling relay; add it again from its link', code: REMOTE_RELAY_ERROR_CODES.notFound } };
    const relink = person && body?.relink === true;
    const at = nowMs();
    if (!relink && (lastRequestAt.get(entry.id) || 0) + PEER_KEY_LIMITS.requestIntervalMs > at) {
      return { status: 429, body: { error: 'A key was asked for less than a minute ago', code: REMOTE_RELAY_ERROR_CODES.rateLimited } };
    }
    lastRequestAt.set(entry.id, at);
    const result = relink
      ? await (inFlight.get(entry.id) || renew(entry.id, { reason: 'relinked' }))
      : await issueTo(entry.id, { reason: 'requested' });
    if (!result.ok) return { status: 409, body: { error: result.error, code: REMOTE_RELAY_ERROR_CODES.peerKeyRequired } };
    return { status: 200, body: { ok: true, delivered: true } };
  }

  /**
   * POST …/peer-key/inbound `{ relayId, name, protocol, version?, platform? }`
   * from the person (the owner token from this relay's pairing link, used by
   * the relay that adds this one one way): that relay becomes an
   * inbound-only entry here and gets a key, in the answer. Asked again, the
   * old key is replaced (revoked at once). A relay listed here both ways
   * gets 409 ALREADY_LISTED: its key comes the usual way.
   */
  function mintInbound(principal, body = {}) {
    if (principal?.kind !== 'owner' && principal?.kind !== 'browser') {
      return { status: 403, body: { error: 'Only the person signed in to this relay gives out an inbound-only key', code: REMOTE_RELAY_ERROR_CODES.forbidden } };
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const relayId = toText(input.relayId).slice(0, 100);
    if (!relayId) return { status: 400, body: { error: 'relayId is required', code: REMOTE_RELAY_ERROR_CODES.invalidInput } };
    if (relayId === registry.instanceId()) return { status: 400, body: { error: 'A relay cannot pair with itself', code: 'SELF' } };
    const protocol = Number(input.protocol);
    let holder;
    try {
      holder = registry.upsertInboundHolder({
        relayId,
        name: toText(input.name).replace(/[\r\n]+/g, ' ').slice(0, 60),
        version: toText(input.version).slice(0, 40),
        platform: toText(input.platform).slice(0, 20),
        ...(Number.isInteger(protocol) && protocol >= 0 ? { protocol } : {}),
      });
    } catch (error) {
      if (Number(error?.status) === 409) return { status: 409, body: { error: toText(error.message), code: REMOTE_RELAY_ERROR_CODES.alreadyListed } };
      return { status: Number(error?.status) || 400, body: { error: toText(error?.message) || 'Refused', code: REMOTE_RELAY_ERROR_CODES.invalidInput } };
    }
    const entry = holder.entry;
    const key = mintPeerKey(randomBytes);
    const keyHash = hashPeerKey(key);
    const seq = (Number(entry.peerKeySeq) || 0) + 1;
    const replaced = (entry.peerKeys || []).length > 0;
    // One live key per holder: the new one replaces any it held. It is good
    // for the check alone until its holder checks it (10 minutes), and
    // confirmed on its first normal use. A replaced key's prompts lose
    // their weight (new epoch): whoever asks now was not checked to be the
    // relay that held it.
    registry.patchPeerFields(entry.id, (stored) => ({
      peerKeys: [{ hash: keyHash, seq, issuedAt: nowIso(), checkedAt: null, confirmedAt: null, lastUsedAt: null, retiresAt: null }],
      peerKeySeq: seq,
      keyRevoked: false,
      ...(replaced ? { epoch: (Number(stored.epoch) || 0) + 1 } : {}),
    }));
    try {
      logger?.log?.(`[remote-relays] "${entry.name}" added this relay one way: ${replaced ? 'its inbound-only key was replaced' : 'it holds an inbound-only key'} (this relay never calls it). Remove it in Settings → Relays to revoke the key.`);
    } catch {}
    return { status: 200, body: { ok: true, issuer: registry.instanceId(), holder: relayId, seq, key } };
  }

  /** resolvePeerKey for the request route: a key retired less than 7 days ago still asks. */
  function resolveRetiredKey(value) {
    if (!isPeerKeyValue(value)) return null;
    const hash = hashPeerKey(value);
    for (const entry of (registry.listAll?.() || registry.list())) {
      if (entry.identityHold || entry.keyRevoked) continue;
      const key = (entry.peerKeys || []).find((record) => record.hash === hash);
      if (key && key.retiresAt && msOf(key.retiresAt) + PEER_KEY_LIMITS.retiredRequestMs > nowMs()) {
        return { kind: 'peer', entryId: entry.id, relayId: entry.relayId, name: entry.name, url: entry.url, epoch: entry.epoch, keySeq: key.seq, keyHash: hash, retired: true };
      }
    }
    return null;
  }

  // ─── health loop, pinning, downgrade ───────────────────────────────────────

  /**
   * What the health probe saw at an entry's URL. Returns the identity fields
   * the registry may store (a changed relay id of a keyed entry is not
   * adopted: it revokes and holds instead).
   */
  function reviewIdentity(entry, identity) {
    if (!entry || !identity) return { fields: {} };
    const fields = {};
    const seenId = toText(identity.relayId);
    const pinned = pinnedIdentityOf(entry);
    if (pinned && seenId && pinned.relayId && seenId !== pinned.relayId) {
      if (!entry.identityHold) {
        Object.assign(fields, revokeFields(entry), {
          identityHold: { reason: 'relayId', relayId: seenId, url: entry.url, at: nowIso() },
        });
        try { logger?.warn?.(`[remote-relays] identity changed: another relay answers at the address of "${entry.name}"; its keys are revoked and the key it gave this relay is not sent until you confirm in Settings → Relays.`); } catch {}
      }
      return { fields, keepRelayId: true };
    }
    const protocol = Number(identity.protocol);
    if (Number.isInteger(protocol)) {
      if (protocol < REMOTE_RELAY_PEER_KEY_PROTOCOL && entry.everKeyed) {
        const probes = (Number(entry.downgradeProbes) || 0) + 1;
        fields.downgradeProbes = probes;
        if (probes >= PEER_KEY_LIMITS.downgradeProbes && !entry.downgraded) {
          fields.downgraded = true;
          try { logger?.warn?.(`[remote-relays] "${entry.name}" runs an older OAR again (3 probes); its requests on a token are taken as unverified.`); } catch {}
        }
      } else if (protocol >= REMOTE_RELAY_PEER_KEY_PROTOCOL && (entry.downgradeProbes || entry.downgraded)) {
        fields.downgradeProbes = 0;
        fields.downgraded = false;
      }
    }
    return { fields };
  }

  function revokeFields(entry) {
    return {
      peerKeys: [],
      epoch: (Number(entry.epoch) || 0) + 1,
    };
  }

  /** After a health pass: issue, rotate, or ask for a key where one is due. */
  function afterProbe(entryId) {
    const entry = registry.get(entryId);
    if (!entry || entry.identityHold || entry.keyRevoked) return;
    if (!(Number(entry.protocol) >= REMOTE_RELAY_PEER_KEY_PROTOCOL) || entry.unconfirmed && !credentialFor(entry)) return;
    const at = nowMs();
    const confirmed = (entry.peerKeys || []).filter((key) => key.confirmedAt && !key.retiresAt).sort((a, b) => b.seq - a.seq)[0];
    const pending = (entry.peerKeys || []).some((key) => !key.confirmedAt && msOf(key.issuedAt) + PEER_KEY_LIMITS.pendingMs > at);
    const due = !confirmed || msOf(confirmed.confirmedAt) + PEER_KEY_LIMITS.rotateAfterMs <= at;
    // A relay that lists no entry for this one takes no key from it either:
    // no delivery to fail every minute (pairing it back delivers one).
    const unlisted = entry.peerTokenState === 'unlisted' || entry.peerInboundOnly === true;
    if (due && !pending && !unlisted && credentialFor(entry)) void issueTo(entry.id, { reason: confirmed ? 'rotation' : 'health' });
    if (!usablePeerToken(entry) && entry.peerTokenState !== 'gone' && entry.tokenMode === 'custom') {
      if ((holderRequests.get(entry.id) || 0) + PEER_KEY_LIMITS.requestIntervalMs <= at) {
        holderRequests.set(entry.id, at);
        // Still asked while unlisted: once that relay lists this one, its
        // key comes to this relay's address and clears the state.
        void requestKeyFrom(entry).then((requested) => {
          if (requested?.gone) noteUnlisted(entry.id);
        }).catch(() => {});
      }
    }
  }

  /** A pinned field changed (PATCH url, or the owner re-pointed it): the fields to merge. */
  function pinnedChangeFields(entry, { url, relayId } = {}) {
    const pinned = pinnedIdentityOf(entry);
    if (!pinned) return {};
    const urlChanged = url !== undefined && pinnedUrlKey(url) !== pinnedUrlKey(pinned.url);
    const idChanged = relayId !== undefined && toText(relayId) !== pinned.relayId;
    if (!urlChanged && !idChanged) {
      // Back at the pinned address: a hold that only the address change set
      // is lifted (nothing went to the other address; the key goes only to
      // the one it was keyed at). Another relay id seen there stays held.
      const hold = entry.identityHold;
      if (url !== undefined && hold?.reason === 'url' && (!hold.relayId || toText(hold.relayId) === pinned.relayId)) {
        try { logger?.log?.(`[remote-relays] the address of "${entry.name}" is the pinned one again; its identity is no longer held.`); } catch {}
        return { identityHold: null };
      }
      return {};
    }
    try { logger?.warn?.(`[remote-relays] identity changed: the ${urlChanged ? 'address' : 'relay id'} of "${entry.name}" was changed; its keys are revoked and nothing this relay holds for it is sent until you confirm in Settings → Relays.`); } catch {}
    return {
      ...revokeFields(entry),
      // The address it was keyed at, kept for a holder-side entry too: going
      // back to it lifts the hold.
      ...(urlChanged && !toText(entry.keyUrl) ? { keyUrl: pinned.url } : {}),
      // Another relay id already seen there stays the reason (going back to
      // the pinned address does not lift that one).
      identityHold: relayId === undefined && entry.identityHold?.reason === 'relayId'
        ? { ...entry.identityHold, url: toText(url) || null, at: nowIso() }
        : { reason: urlChanged ? 'url' : 'relayId', relayId: relayId !== undefined ? toText(relayId) || null : entry.relayId, url: url !== undefined ? toText(url) || null : entry.url, at: nowIso() },
    };
  }

  /** The owner confirmed a held identity change: the new URL and id become the pinned ones. */
  function confirmIdentity(entryId) {
    const entry = registry.get(entryId);
    if (!entry) return { ok: false, status: 404, error: 'Unknown remote relay' };
    if (!identityHeld(entry)) return { ok: true, relay: entry };
    const hold = entry.identityHold || {};
    registry.patchPeerFields(entry.id, (stored) => ({
      identityHold: null,
      ...(hold.relayId ? { relayId: hold.relayId } : {}),
      keyRelayId: hold.relayId || stored.relayId,
      keyUrl: stored.url,
      peerToken: undefined,
      peerTokenSeq: 0,
      peerTokenConfirmedAt: null,
      peerTokenState: null,
      refusalNoticeAt: null,
      refusalNoticeDismissedAt: null,
    }));
    try { logger?.log?.(`[remote-relays] identity change of "${entry.name}" confirmed by the owner.`); } catch {}
    return { ok: true, relay: registry.get(entry.id) };
  }

  function revoke(entryId) {
    const entry = registry.get(entryId);
    if (!entry) return { ok: false, status: 404, error: 'Unknown remote relay' };
    registry.patchPeerFields(entry.id, { ...revokeFields(entry), keyRevoked: true });
    try { logger?.log?.(`[remote-relays] peer key of "${entry.name}" revoked by the owner.`); } catch {}
    return { ok: true };
  }

  /**
   * Renew (the owner's button, or that relay added again from this relay's
   * link: `relinked`): a revoked entry takes keys again, and a new one goes
   * out. Joins an issuance already in flight for the entry.
   */
  async function renew(entryId, { reason = 'renew' } = {}) {
    const entry = registry.get(entryId);
    if (!entry) return { ok: false, status: 404, error: 'Unknown remote relay' };
    // A held identity change stays revoked for a re-add: the owner confirms first.
    if (entry.keyRevoked && !(reason === 'relinked' && entry.identityHold)) {
      registry.patchPeerFields(entry.id, { keyRevoked: false });
      if (reason === 'relinked') {
        try { logger?.log?.(`[remote-relays] "${entry.name}" was added again from this relay's pairing link: its revoked key is renewed.`); } catch {}
      }
    }
    return issueTo(entry.id, { reason });
  }

  /** The Inbox item of an entry: shown from its first refusal until dismissed. */
  function refusalNoticeItems() {
    const items = [];
    for (const entry of (registry.listAll?.() || registry.list())) {
      if (!entry.refusalNoticeAt || entry.refusalNoticeDismissedAt) continue;
      if (entry.refusalNoticeEpoch !== (Number(entry.epoch) || 0)) continue;
      const name = entry.name || entry.id;
      const mismatch = entry.refusalNoticeCode !== REMOTE_RELAY_ERROR_CODES.peerKeyRequired;
      items.push({
        id: `relay-refusal:${entry.id}`,
        kind: 'relay_notice',
        status: 'pending',
        createdAt: entry.refusalNoticeAt,
        relayEntryId: entry.id,
        relayName: name,
        code: entry.refusalNoticeCode || REMOTE_RELAY_ERROR_CODES.originMismatch,
        question: mismatch
          ? `${name} sent a request claiming to be another relay; it was refused.`
          : `A request claimed to be ${name} without its key; it was refused.`,
        detail: 'A paired relay can only speak for itself. Settings → Relays shows how many claims were refused since the relay started. Later refusals add no item.',
        refusedClaims: refusedCount(entry.id),
      });
    }
    return items;
  }

  function dismissRefusalNotice(entryId) {
    const entry = registry.get(entryId);
    if (!entry) return { ok: false, status: 404, error: 'Unknown remote relay' };
    registry.patchPeerFields(entry.id, { refusalNoticeDismissedAt: nowIso() });
    return { ok: true };
  }

  /** The public view's extra fields for an entry (no hash, no key). */
  function publicFields(entry) {
    return {
      peerKey: describePeerKeyState(entry, nowMs()),
      peerKeyConfirmed: entryHasConfirmedKey(entry, nowMs()) && !entry.downgraded,
      refusedClaims: refusedCount(entry.id),
    };
  }

  return {
    rebuildIndex,
    resolvePeerKey,
    resolveRetiredKey,
    gate,
    refusedCount,
    issueTo,
    handleCheck,
    handleDelivery,
    handleRequest,
    mintInbound,
    requestKeyFrom,
    confirmHeldKey,
    noteHeldKeyWorked,
    onHeldKeyRefused,
    noteKeyRequired,
    noteUnlisted,
    reviewIdentity,
    afterProbe,
    pinnedChangeFields,
    confirmIdentity,
    revoke,
    renew,
    refusalNoticeItems,
    dismissRefusalNotice,
    publicFields,
    protocol: REMOTE_RELAY_PROTOCOL,
  };
}
