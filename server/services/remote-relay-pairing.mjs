'use strict';

import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_INBOUND_KEY_PATH,
  REMOTE_RELAY_PEER_KEY_PATHS,
  REMOTE_RELAY_PEER_KEY_PROTOCOL,
  REMOTE_RELAY_PROTOCOL,
  checkRemoteRelayUrlPolicy,
  normalizeRemoteRelayLink,
} from '../../shared/remote-relay-contract.mjs';
import { PEER_KEY_PREFIX } from '../../shared/relay-credentials.mjs';
import { identityHeld, usablePeerToken } from './remote-relay-peer-keys.mjs';

// Adding a remote relay and the mutual introduction that follows (plan §5.4).
//
// Outbound (`addFromLink`, behind POST /api/remote-relays): the user pastes
// the other relay's web address. We probe it with the token given (the field
// or the link's ?token=), save it, and introduce ourselves so the other relay
// lists us too. The introduction carries no token: this relay keeps its owner
// token only as a hash, so a relay below PAIR_BACK_MIN_PROTOCOL (which could
// only call back with an owner token) is told to add us by hand instead.
//
// Inbound (`acceptPairing`, behind POST /api/remote-relays/pair): another
// relay introduces itself. For a relay not listed yet, the token it may carry
// is the one to use for it; it is stored for that remote only, never echoed
// and never logged. A relay already listed keeps its stored address and token.
//
// Peer keys bring pairing both ways back for protocol 2: after the
// introduction this relay sends the other one a key of its own (with the
// token from the link), and asks it for one in return, which comes to this
// relay's public address. Neither relay ever holds the other's owner token
// once its key works. `repair` is the one-click Re-pair of Settings → Relays.
//
// One way ("Also add this relay there" off) with a relay that gives
// inbound-only keys (0.9.27): the token from the link is used for the add
// alone, in memory. The other relay mints a key for this one and lists it as
// inbound only (it never calls it); this relay checks the key at that
// relay's address and stores the key, never the token. When anything of
// that fails, nothing is stored. A relay without inbound-only keys (older
// than 0.9.27) is added as before: this relay keeps its token, its prompts
// arrive there as claimed, and the row says One way (protocol 2) or Old
// version.

// The inbound check must finish well inside the caller's own request budget,
// or the caller reports "not paired back" although we saved the entry.
const PAIR_CHECK_TIMEOUT_MS = 5_000;
// The inbound-only key request and its check, each.
const INBOUND_KEY_TIMEOUT_MS = 15_000;
export const REMOTE_RELAY_SELF_CODE = 'SELF';
// The lowest protocol that can call back without an owner token (peer keys
// raise REMOTE_RELAY_PROTOCOL to it). Below it pair-back is by hand.
export const PAIR_BACK_MIN_PROTOCOL = 2;
export const PAIR_BACK_BY_HAND_MESSAGE = "The other relay runs an OAR that pairs back only with this relay's token, which this relay no longer hands out; add this relay there by hand with its token";

function toText(value) {
  return String(value ?? '').trim();
}

function failure(status, code, error, extra = {}) {
  return { ok: false, status, code, error, ...extra };
}

export function createRemoteRelayPairing({
  registry,
  client,
  now = () => new Date(),
  logger = console,
  // The relay's base path (config.remotePath): with the page's origin it
  // makes this relay's own address.
  basePath = '',
  // The peer-key service (remote-relay-peer-keys.mjs); without it pairing
  // works as before keys.
  peerKeys = null,
} = {}) {
  /**
   * Keys both ways with a relay at protocol 2: this relay's key for it
   * (delivered with the credential held for it), then a request for its key
   * for this relay. `{ ours, theirs }`, each `{ ok, error? }`.
   *
   * `relink`: an add from that relay's pairing link. The request goes on
   * the token from the link and asks that relay to renew a key it revoked
   * for this one; it is asked once more when no key it takes is held here
   * after the answer (a key it renewed at the same time came before the
   * add dropped the old one, and its issuance was the one the request
   * waited for).
   */
  async function exchangeKeys(entryId, { relink = false } = {}) {
    if (!peerKeys) return null;
    const entry = registry.get(entryId);
    if (!entry || !(Number(entry.protocol) >= REMOTE_RELAY_PEER_KEY_PROTOCOL)) return null;
    let ours;
    try {
      ours = await peerKeys.issueTo(entry.id, { reason: 'pairing' });
    } catch (error) {
      ours = { ok: false, error: toText(error?.message) };
    }
    const ask = async () => {
      const fresh = registry.get(entry.id);
      if (!fresh || usablePeerToken(fresh)) return { ok: true };
      try {
        const answer = await peerKeys.requestKeyFrom(fresh, { relink });
        // Asked and answered, yet nothing this relay may use came: not ok.
        return answer?.ok && !usablePeerToken(registry.get(entry.id)) ? { ok: false } : answer;
      } catch (error) {
        return { ok: false, error: toText(error?.message) };
      }
    };
    let theirs = await ask();
    if (relink && theirs?.ok !== true && theirs?.gone !== true) theirs = await ask();
    // It lists no entry for this relay (added one way): no key either way,
    // and the row says so instead of "Re-add from link".
    if (theirs?.gone === true) peerKeys.noteUnlisted?.(entry.id);
    // A key held from that relay is confirmed with a first call now, so the
    // token from the link goes before the add ends (and is never written).
    const held = registry.get(entry.id);
    if (held && held.tokenMode === 'custom' && usablePeerToken(held)) {
      try { await peerKeys.confirmHeldKey?.(entry.id); } catch {}
    }
    const unlisted = theirs?.gone === true && registry.get(entry.id)?.peerTokenState === 'unlisted';
    return {
      ours: { ok: ours?.ok === true, ...(ours?.ok ? {} : { error: ours?.error || null }) },
      theirs: { ok: theirs?.ok === true, ...(unlisted ? { unlisted: true } : {}) },
    };
  }

  /**
   * Whether `baseUrl` is this relay's own address: its public URL, or the
   * origin the page that asks was opened at, with the relay's base path.
   * Without its own token the probe cannot read the other side's identity
   * (it asks for a token), so the address has to tell.
   */
  function isOwnAddress(baseUrl, requestOrigin) {
    const key = (value) => toText(value).replace(/\/+$/, '').toLowerCase();
    const target = key(baseUrl);
    if (!target) return false;
    const own = [registry.getSelfSettings?.()?.publicUrl];
    const origin = toText(requestOrigin);
    if (/^https?:\/\/[^/]+$/i.test(origin)) own.push(`${origin}${toText(basePath).replace(/\/+$/, '')}`);
    return own.some((candidate) => key(candidate) && key(candidate) === target);
  }

  /** Stores the browser-derived address as our public URL, once, if none is set. */
  function adoptSelfUrl(selfUrl) {
    const raw = toText(selfUrl);
    if (!raw || registry.getSelfSettings().publicUrl) return;
    const link = normalizeRemoteRelayLink(raw);
    if (!link.ok || !checkRemoteRelayUrlPolicy(link.baseUrl).ok) return;
    registry.setSelfSettings({ publicUrl: link.baseUrl });
  }

  function findExisting(identity, baseUrl) {
    // Inbound-only entries too: adding a relay that holds one makes it a
    // normal entry in place.
    const entries = registry.listAll?.() || registry.list();
    if (identity.relayId) {
      const byId = entries.find((entry) => entry.relayId === identity.relayId);
      if (byId) return byId;
    }
    const url = baseUrl.toLowerCase();
    return entries.find((entry) => entry.url.toLowerCase() === url) || null;
  }

  async function pairBackTo(relay) {
    const publicUrl = registry.getSelfSettings().publicUrl;
    if (!publicUrl) {
      return { pairedBack: false, pairBackError: 'This relay\'s public URL is not set, so the other relay cannot reach it' };
    }
    if (!(Number(relay.protocol) >= 1)) {
      return { pairedBack: false, pairBackError: 'The other relay runs an older OAR without pairing; add this relay there by hand' };
    }
    if (!(Number(relay.protocol) >= PAIR_BACK_MIN_PROTOCOL)) {
      return { pairedBack: false, pairBackError: PAIR_BACK_BY_HAND_MESSAGE };
    }
    // No token: the way back is the other relay's own credential for us.
    const body = {
      relayId: registry.instanceId(),
      name: registry.selfName(),
      url: publicUrl,
      protocol: REMOTE_RELAY_PROTOCOL,
    };
    try {
      await client.request(relay, 'POST', '/api/remote-relays/pair', { body });
      return { pairedBack: true };
    } catch (error) {
      return { pairedBack: false, pairBackError: toText(error?.message) || 'Pairing back failed' };
    }
  }

  /**
   * POST /api/remote-relays `{ url, token?, pairBack = true, selfUrl? }`.
   * Failures carry the intended HTTP `status`; a 401 is `{ ok:false,
   * needsToken:true }` so the UI can show the token field.
   */
  async function addFromLink({ url, token, pairBack = true, selfUrl } = {}, { requestOrigin = '' } = {}) {
    const link = normalizeRemoteRelayLink(url);
    if (!link.ok) return failure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, link.error);
    if (isOwnAddress(link.baseUrl, requestOrigin)) {
      return failure(400, REMOTE_RELAY_SELF_CODE, 'That address is this relay itself');
    }

    // Explicit field, then the link's ?token=. Without one the probe goes
    // without a token, and a relay that wants one asks for it (needsToken).
    const workingToken = toText(token) || toText(link.token);

    let identity;
    try {
      identity = await client.probe(link.baseUrl, workingToken);
    } catch (error) {
      if (error?.code === REMOTE_RELAY_ERROR_CODES.unauthorized) {
        return failure(200, error.code, 'The other relay rejected the token. Enter its token.', { needsToken: true });
      }
      const status = error?.code === REMOTE_RELAY_ERROR_CODES.invalidInput ? 400 : 502;
      return failure(status, error?.code || REMOTE_RELAY_ERROR_CODES.offline, toText(error?.message) || 'The other relay could not be reached');
    }

    if (identity.relayId && identity.relayId === registry.instanceId()) {
      return failure(400, REMOTE_RELAY_SELF_CODE, 'That address is this relay itself');
    }

    adoptSelfUrl(selfUrl);

    // One way, with a relay that gives inbound-only keys: the token stays in
    // memory. null: that relay lists this one both ways already, or it has
    // no such route after all; the add goes on as below.
    if (pairBack === false && peerKeys && workingToken
      && Number(identity.protocol) >= REMOTE_RELAY_PEER_KEY_PROTOCOL && identity.inboundKeys === true) {
      const oneWay = await addInboundOnly({ link, identity, workingToken });
      if (oneWay) return oneWay;
    }

    // A relay with keys gets the token in memory only: the entry is stored
    // without it, and it is written only if no key works by the end of the
    // add (holdToken). An older relay's entry keeps it, as before.
    const holdInMemory = !!workingToken && Number(identity.protocol) >= REMOTE_RELAY_PEER_KEY_PROTOCOL
      && !!peerKeys && typeof registry.holdToken === 'function';
    const tokenFields = workingToken && !holdInMemory
      ? { tokenMode: 'custom', token: workingToken }
      : { tokenMode: 'none' };
    const existing = findExisting(identity, link.baseUrl);
    let saved;
    if (existing?.inboundOnly) {
      // It held an inbound-only key here: the same entry, now called too.
      saved = registry.adoptInboundHolder(existing.id, { url: link.baseUrl, ...tokenFields, addedBy: 'user' });
      if (saved) saved = registry.recordIdentity(existing.id, identity);
    } else if (existing) {
      const updated = registry.update(existing.id, { url: link.baseUrl, ...tokenFields });
      if (!updated.ok) return failure(updated.status || 400, REMOTE_RELAY_ERROR_CODES.invalidInput, updated.error);
      // Pasting the link again is the re-pair of a relay whose key or token
      // stopped working: the key held from it goes, and a new one is asked
      // for with the token just given.
      if (workingToken) {
        registry.patchPeerFields?.(existing.id, { peerToken: undefined, peerTokenSeq: 0, peerTokenConfirmedAt: null, peerTokenState: null, peerInboundOnly: false });
      }
      saved = registry.recordIdentity(existing.id, identity);
    } else {
      saved = registry.add({
        relayId: identity.relayId,
        name: identity.name,
        url: link.baseUrl,
        ...tokenFields,
        addedBy: 'user',
        version: identity.version,
        platform: identity.platform,
        protocol: identity.protocol,
        // Its page takes ?answer= (the Inbox's popup buttons), from the
        // probe just made; the periodic probe keeps it current.
        answerLink: identity.answerLink === true,
        lastStatus: 'online',
        lastSeenAt: now().toISOString(),
      });
    }
    if (!saved) return failure(409, REMOTE_RELAY_ERROR_CODES.unknown, 'The remote relay was removed while it was being added');
    if (holdInMemory) registry.holdToken(saved.id, workingToken);

    let pairing;
    let keys;
    try {
      pairing = pairBack === false
        ? { pairedBack: false }
        : await pairBackTo(registry.get(saved.id) || saved);
      // Protocol 2: keys both ways. Keys need an entry on both sides (a key
      // goes only to the address its issuer has stored, with that issuer's
      // credential for the holder), so a one-way add (pairing back off or
      // failed, and no entry for this relay there) gets none: this relay keeps
      // calling on the token from the link, unverified there, and the answer
      // says so (`keys.theirs.unlisted`). Re-pair adds this relay there.
      // The token from the link is that relay's person: a key it revoked
      // for this relay is renewed (relink).
      keys = await exchangeKeys(saved.id, { relink: !!workingToken });
    } finally {
      // No working key: the token is written now, so the pairing keeps working.
      if (holdInMemory) registry.releaseHeldToken(saved.id);
    }

    const relay = registry.listPublic().find((entry) => entry.id === saved.id) || null;
    // One way with a relay older than 0.9.27 (no keys at all): it keeps the
    // token, and the answer says so.
    const older = pairBack === false && !(Number(identity.protocol) >= REMOTE_RELAY_PEER_KEY_PROTOCOL);
    return {
      ok: true,
      relay,
      updated: !!existing,
      ...pairing,
      ...(older ? { oneWay: 'older' } : {}),
      ...(keys ? { keys } : {}),
      ...(link.warning ? { warning: link.warning } : {}),
    };
  }

  /**
   * One way with an inbound-only key (see the header). The answer of
   * addFromLink, a plain failure with nothing stored, or null when that
   * relay lists this one both ways already (409 ALREADY_LISTED) or has no
   * such route (404: an older build), so the add goes on as before.
   */
  async function addInboundOnly({ link, identity, workingToken }) {
    const name = toText(identity.name) || 'The other relay';
    // In memory only: never stored, logged or put in an answer.
    const target = { name: identity.name, url: link.baseUrl, tokenMode: 'custom', token: workingToken };
    const nothingSaved = (status, code, text) => failure(status, code, `${text} Nothing was saved here; try Add again.`);
    let minted;
    try {
      minted = await client.request(target, 'POST', REMOTE_RELAY_INBOUND_KEY_PATH, {
        body: {
          relayId: registry.instanceId(),
          name: registry.selfName(),
          protocol: REMOTE_RELAY_PROTOCOL,
        },
        timeoutMs: INBOUND_KEY_TIMEOUT_MS,
        peerKeyRetry: false,
      });
    } catch (error) {
      if (Number(error?.status) === 404) return null;
      if (toText(error?.remoteBody?.code) === REMOTE_RELAY_ERROR_CODES.alreadyListed) return null;
      return nothingSaved(502, error?.code || REMOTE_RELAY_ERROR_CODES.offline, `${name} did not give this relay a key: ${toText(error?.message) || 'the request failed'}.`);
    }
    const key = toText(minted?.key);
    const seq = Number(minted?.seq);
    if (!key.startsWith(PEER_KEY_PREFIX) || !Number.isInteger(seq) || seq < 1
      || toText(minted?.holder) !== registry.instanceId()
      || (identity.relayId && toText(minted?.issuer) !== identity.relayId)) {
      return nothingSaved(502, REMOTE_RELAY_ERROR_CODES.unsupported, `${name} answered the key request in a way this relay cannot use.`);
    }
    // The check at that relay's address: it issued this key, for this relay.
    try {
      const checked = await client.request({ ...target, token: key }, 'GET', REMOTE_RELAY_PEER_KEY_PATHS.check, {
        timeoutMs: INBOUND_KEY_TIMEOUT_MS,
        peerKeyRetry: false,
      });
      if (toText(checked?.issuer) !== toText(minted.issuer) || toText(checked?.holder) !== registry.instanceId() || Number(checked?.seq) !== seq) {
        return nothingSaved(502, REMOTE_RELAY_ERROR_CODES.unsupported, `The key ${name} gave did not check out at its address.`);
      }
    } catch (error) {
      return nothingSaved(502, error?.code || REMOTE_RELAY_ERROR_CODES.offline, `The key ${name} gave could not be checked at its address: ${toText(error?.message) || 'the check failed'}.`);
    }

    // Only the key is stored, never the token. The keys this relay gave
    // that relay before go: it lists this one inbound only and holds none.
    const keyFields = {
      tokenMode: 'peer',
      token: undefined,
      peerToken: key,
      peerTokenSeq: seq,
      peerTokenConfirmedAt: null,
      peerTokenState: null,
      peerInboundOnly: true,
      peerKeys: [],
    };
    let existing = findExisting(identity, link.baseUrl);
    let saved;
    try {
      if (existing?.inboundOnly) {
        registry.adoptInboundHolder(existing.id, { url: link.baseUrl, tokenMode: 'none', addedBy: 'user' });
      } else if (existing) {
        const updated = registry.update(existing.id, { url: link.baseUrl });
        if (!updated.ok) return nothingSaved(updated.status || 400, REMOTE_RELAY_ERROR_CODES.invalidInput, toText(updated.error));
      }
      if (existing) {
        registry.patchPeerFields(existing.id, keyFields);
        saved = registry.recordIdentity(existing.id, identity);
      } else {
        saved = registry.add({
          relayId: identity.relayId,
          name: identity.name,
          url: link.baseUrl,
          tokenMode: 'peer',
          peerToken: key,
          peerTokenSeq: seq,
          peerInboundOnly: true,
          addedBy: 'user',
          version: identity.version,
          platform: identity.platform,
          protocol: identity.protocol,
          answerLink: identity.answerLink === true,
          lastStatus: 'online',
          lastSeenAt: now().toISOString(),
        });
      }
    } catch (error) {
      return nothingSaved(500, REMOTE_RELAY_ERROR_CODES.internal, `The key ${name} gave could not be stored: ${toText(error?.message) || 'failed'}.`);
    }
    if (!saved) return failure(409, REMOTE_RELAY_ERROR_CODES.unknown, 'The remote relay was removed while it was being added');
    // The first call with it confirms it there.
    try { await peerKeys.confirmHeldKey(saved.id); } catch {}
    try {
      logger?.log?.(`[remote-relays] "${toText(identity.name) || saved.name}" added one way: it gave this relay a key of its own and lists it as inbound only; its token was not kept.`);
    } catch {}
    const relay = registry.listPublic().find((entry) => entry.id === saved.id) || null;
    return {
      ok: true,
      relay,
      updated: !!existing,
      pairedBack: false,
      oneWay: 'inbound-only',
      keys: { ours: { ok: false, inboundOnly: true }, theirs: { ok: true, inboundOnly: true } },
      ...(link.warning ? { warning: link.warning } : {}),
    };
  }

  /**
   * POST /api/remote-relays/:id/repair: a held identity change first asks
   * the owner (`needsConfirm`; `confirmIdentity` confirms it), then probe the
   * stored address (with the credential held for it), pair back without
   * rewriting the entry, and
   * keys both ways. A relay below protocol 2, or one that refuses what this
   * relay holds for it, answers `needsLink` (paste its pairing link).
   */
  async function repair(entryId, { confirmIdentity = false } = {}) {
    const entry = registry.get(toText(entryId));
    if (!entry) return failure(404, REMOTE_RELAY_ERROR_CODES.unknown, 'Unknown remote relay');
    if (entry.inboundOnly) {
      return failure(409, REMOTE_RELAY_ERROR_CODES.unsupported, `"${entry.name}" calls this relay only (inbound only): there is nothing to re-pair here. To list it both ways, add it from its pairing link; Remove revokes its key.`);
    }
    // A held identity change comes first: nothing is sent there until the
    // owner confirms, and a pairing link pasted now would leave the hold in
    // place (and that relay's token stored here).
    let target = entry;
    let confirmedNow = false;
    if (identityHeld(entry)) {
      if (!confirmIdentity || !peerKeys) {
        const hold = entry.identityHold || {};
        const changedUrl = hold.reason === 'url' || !entry.identityHold;
        return failure(409, 'IDENTITY_CHANGED', changedUrl
          ? `The address of "${entry.name}" changed. Confirm it is the relay you meant, then Re-pair.`
          : `Another relay identity answers at the address of "${entry.name}". Confirm it is the relay you meant, then Re-pair.`, {
          needsConfirm: true,
          identity: { name: null, version: null, relayId: hold.relayId ? `${toText(hold.relayId).slice(0, 8)}…` : null },
        });
      }
      peerKeys.confirmIdentity(entry.id);
      target = registry.get(entry.id) || entry;
      confirmedNow = true;
    }
    const credential = client.tokenFor(target);
    if (!credential) {
      return failure(200, REMOTE_RELAY_ERROR_CODES.unauthorized, `This relay holds no working credential for "${entry.name}". Paste its pairing link to re-pair.`, { needsLink: true });
    }
    let identity;
    try {
      identity = await client.probe(target.url, credential, { relay: target });
    } catch (error) {
      if (error?.code === REMOTE_RELAY_ERROR_CODES.unauthorized || Number(error?.status) === 401) {
        return failure(200, error.code || REMOTE_RELAY_ERROR_CODES.unauthorized, `"${entry.name}" no longer accepts what this relay holds for it. Paste its pairing link to re-pair.`, { needsLink: true });
      }
      return failure(502, error?.code || REMOTE_RELAY_ERROR_CODES.offline, toText(error?.message) || 'The other relay could not be reached');
    }
    registry.recordIdentity(entry.id, identity);
    let current = registry.get(entry.id);
    if (current?.identityHold) {
      // Just confirmed, and yet another identity answers: ask again.
      if (!confirmIdentity || !peerKeys || confirmedNow) {
        return failure(409, 'IDENTITY_CHANGED', `Another relay identity answers at the address of "${entry.name}". Confirm it is the relay you meant, then Re-pair.`, {
          needsConfirm: true,
          identity: { name: identity.name, version: identity.version, relayId: identity.relayId ? `${toText(identity.relayId).slice(0, 8)}…` : null },
        });
      }
      peerKeys.confirmIdentity(entry.id);
      current = registry.get(entry.id);
    }
    if (!(Number(identity.protocol) >= REMOTE_RELAY_PEER_KEY_PROTOCOL)) {
      return failure(200, REMOTE_RELAY_ERROR_CODES.unsupported, `"${entry.name}" runs an older OAR (${identity.version || 'no version'}) without keys. Update it to 0.9.27 or later, then Re-pair; until then paste its pairing link to renew the token.`, { needsLink: true, older: true });
    }
    // Listed there inbound only: its key opens no pairing route, so only the
    // pairing link (with "Also add this relay there" on) makes it two-way.
    if (current.peerInboundOnly && usablePeerToken(current)) {
      return failure(200, REMOTE_RELAY_ERROR_CODES.unsupported, `"${entry.name}" lists this relay as inbound only (it was added there one way), so Re-pair cannot add this relay there with the key it holds. Add it again with "Also add this relay there" on to make the pairing two-way.`, { needsLink: true, oneWay: true });
    }
    // Pairing back needs the token: with a key this relay is listed there.
    const pairing = usablePeerToken(current) ? { pairedBack: true } : await pairBackTo(current);
    if (current.keyRevoked) registry.patchPeerFields?.(current.id, { keyRevoked: false });
    const keys = await exchangeKeys(current.id);
    const relay = registry.listPublic().find((item) => item.id === current.id) || null;
    return { ok: true, relay, ...pairing, ...(keys ? { keys } : {}) };
  }

  /**
   * POST /api/remote-relays/pair: another relay introduces itself as
   * `{ relayId, name, url, protocol, token? }`. The entry is kept even when
   * that URL is not reachable from here yet (a tunnel that is not up).
   */
  async function acceptPairing(body = {}) {
    const input = body && typeof body === 'object' ? body : {};
    const relayId = toText(input.relayId).slice(0, 100);
    if (!relayId) return failure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, 'relayId is required');
    if (relayId === registry.instanceId()) {
      return failure(400, REMOTE_RELAY_SELF_CODE, 'A relay cannot pair with itself');
    }
    const link = normalizeRemoteRelayLink(input.url);
    if (!link.ok) return failure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, link.error);

    // A relay already listed here keeps the address and token stored for it;
    // only a new one takes the offered ones (see upsertFromPairing).
    const protocol = Number(input.protocol);
    let entry;
    try {
      entry = registry.upsertFromPairing({
        relayId,
        name: toText(input.name).slice(0, 60),
        url: link.baseUrl,
        token: typeof input.token === 'string' ? input.token : '',
        ...(Number.isInteger(protocol) && protocol >= 0 ? { protocol } : {}),
      });
    } catch (error) {
      return failure(Number(error?.status) || 409, REMOTE_RELAY_ERROR_CODES.invalidInput, toText(error?.message) || 'Pairing refused');
    }
    try {
      await registry.check(entry.id, { timeoutMs: PAIR_CHECK_TIMEOUT_MS });
    } catch {}
    return { ok: true, relayId: registry.instanceId(), name: registry.selfName() };
  }

  return { addFromLink, acceptPairing, repair, exchangeKeys };
}
