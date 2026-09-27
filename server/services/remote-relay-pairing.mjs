'use strict';

import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_PROTOCOL,
  checkRemoteRelayUrlPolicy,
  normalizeRemoteRelayLink,
} from '../../shared/remote-relay-contract.mjs';

// Adding a remote relay and the mutual introduction that follows (plan §5.4).
//
// Outbound (`addFromLink`, behind POST /api/remote-relays): the user pastes
// the other relay's web address. We probe it with the best token we have,
// save it, and — when both sides speak protocol 1 and we know our own public
// URL — introduce ourselves so the other relay lists us too.
//
// Inbound (`acceptPairing`, behind POST /api/remote-relays/pair): another
// relay introduces itself. For a relay not listed yet, the token it may carry
// is the one to use for it; it is stored for that remote only, never echoed
// and never logged. A relay already listed keeps its stored address and token.

// The inbound check must finish well inside the caller's own request budget,
// or the caller reports "not paired back" although we saved the entry.
const PAIR_CHECK_TIMEOUT_MS = 5_000;
export const REMOTE_RELAY_SELF_CODE = 'SELF';

function toText(value) {
  return String(value ?? '').trim();
}

function failure(status, code, error, extra = {}) {
  return { ok: false, status, code, error, ...extra };
}

export function createRemoteRelayPairing({
  registry,
  client,
  getOwnToken = () => '',
  now = () => new Date(),
} = {}) {
  function ownToken() {
    return toText(getOwnToken?.());
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
    const entries = registry.list();
    if (identity.relayId) {
      const byId = entries.find((entry) => entry.relayId === identity.relayId);
      if (byId) return byId;
    }
    const url = baseUrl.toLowerCase();
    return entries.find((entry) => entry.url.toLowerCase() === url) || null;
  }

  async function pairBackTo(relay, workingToken) {
    const publicUrl = registry.getSelfSettings().publicUrl;
    if (!publicUrl) {
      return { pairedBack: false, pairBackError: 'This relay\'s public URL is not set, so the other relay cannot reach it' };
    }
    if (!(Number(relay.protocol) >= 1)) {
      return { pairedBack: false, pairBackError: 'The other relay runs an older OAR without pairing; add this relay there by hand' };
    }
    const own = ownToken();
    const body = {
      relayId: registry.instanceId(),
      name: registry.selfName(),
      url: publicUrl,
      protocol: REMOTE_RELAY_PROTOCOL,
      // Only when the other relay needs a different token to call us back.
      ...(own && own !== workingToken ? { token: own } : {}),
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
  async function addFromLink({ url, token, pairBack = true, selfUrl } = {}) {
    const link = normalizeRemoteRelayLink(url);
    if (!link.ok) return failure(400, REMOTE_RELAY_ERROR_CODES.invalidInput, link.error);

    // Explicit field, then the link's ?token=, then this relay's own token.
    const workingToken = toText(token) || toText(link.token) || ownToken();

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

    const tokenFields = workingToken === ownToken()
      ? { tokenMode: 'own' }
      : { tokenMode: 'custom', token: workingToken };
    const existing = findExisting(identity, link.baseUrl);
    let saved;
    if (existing) {
      const updated = registry.update(existing.id, { url: link.baseUrl, ...tokenFields });
      if (!updated.ok) return failure(updated.status || 400, REMOTE_RELAY_ERROR_CODES.invalidInput, updated.error);
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
        lastStatus: 'online',
        lastSeenAt: now().toISOString(),
      });
    }
    if (!saved) return failure(409, REMOTE_RELAY_ERROR_CODES.unknown, 'The remote relay was removed while it was being added');

    const pairing = pairBack === false
      ? { pairedBack: false }
      : await pairBackTo(registry.get(saved.id) || saved, workingToken);

    const relay = registry.listPublic().find((entry) => entry.id === saved.id) || null;
    return {
      ok: true,
      relay,
      updated: !!existing,
      ...pairing,
      ...(link.warning ? { warning: link.warning } : {}),
    };
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
    const entry = registry.upsertFromPairing({
      relayId,
      name: toText(input.name).slice(0, 60),
      url: link.baseUrl,
      token: typeof input.token === 'string' ? input.token : '',
      ...(Number.isInteger(protocol) && protocol >= 0 ? { protocol } : {}),
    });
    try {
      await registry.check(entry.id, { timeoutMs: PAIR_CHECK_TIMEOUT_MS });
    } catch {}
    return { ok: true, relayId: registry.instanceId(), name: registry.selfName() };
  }

  return { addFromLink, acceptPairing };
}
