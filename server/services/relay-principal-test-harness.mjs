// Test helpers: tag a fake request with the principal `auth` would have
// given it (relay-auth.mjs). Route tests that call handlers directly skip
// `auth`, so they say who is calling here; an untagged request is nobody
// (not the person), exactly as in the relay.
import { tagPrincipal } from './relay-principal.mjs';

export const OWNER_PRINCIPAL = Object.freeze({ kind: 'owner', via: 'bearer' });

export function agentPrincipal(conversationId = 'agent-conversation') {
  return { kind: 'agent', agentKind: 's', conversationId: String(conversationId), via: 'bearer' };
}

export const CLI_AGENT_PRINCIPAL = Object.freeze({ kind: 'agent', agentKind: 'c', via: 'bearer' });

export function asOwner(req) {
  return tagPrincipal(req, OWNER_PRINCIPAL);
}

export function asAgent(req, conversationId) {
  return tagPrincipal(req, agentPrincipal(conversationId));
}

/** `principal` undefined: the owner; null: untagged; else that principal. */
export function withPrincipal(req, principal) {
  if (principal === null) return req;
  return tagPrincipal(req, principal === undefined ? OWNER_PRINCIPAL : principal);
}

/**
 * A paired relay signed in with its own key (peer keys): `entry` is the
 * registry entry the key names ({ id, relayId, name, url, epoch? }).
 */
export function peerPrincipal(entry = {}) {
  return {
    kind: 'peer',
    entryId: String(entry.id || ''),
    relayId: String(entry.relayId || ''),
    name: String(entry.name || ''),
    url: String(entry.url || ''),
    epoch: Number(entry.epoch) || 0,
    keySeq: 1,
    via: 'bearer',
  };
}

export function asPeer(req, entry) {
  return tagPrincipal(req, peerPrincipal(entry));
}
