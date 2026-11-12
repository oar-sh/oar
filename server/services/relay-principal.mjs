'use strict';

// Who a request acts for, as `auth` (relay-auth.mjs) resolved it:
//
//   { kind: 'owner' }                         the owner token (Bearer, or today's cookie)
//   { kind: 'browser', sessionId }            a browser session (reserved: browser sessions)
//   { kind: 'agent', agentKind: 's', conversationId }   one session's agent token
//   { kind: 'agent', agentKind: 'c' }         the cli agent token (the `oar` CLI, tools started by hand)
//   { kind: 'peer', entryId, relayId, epoch } a paired relay's key (remote-relay-peer-keys.mjs)
//   { kind: 'internal' }                      a call the relay makes to itself
//
// The tag lives in a WeakMap, so nothing sent over HTTP can claim it, and the
// lookup walks the prototype chain: a route that re-dispatches with
// `Object.create(req)` (the billing switch) keeps the caller it had.

export const PRINCIPAL_KINDS = Object.freeze(['owner', 'browser', 'agent', 'peer', 'internal']);
const PERSON_KINDS = new Set(['owner', 'browser']);
const MAX_PROTOTYPE_DEPTH = 32;

const principals = new WeakMap();

export function tagPrincipal(req, principal) {
  if (req && typeof req === 'object' && principal && PRINCIPAL_KINDS.includes(principal.kind)) {
    principals.set(req, Object.freeze({ ...principal }));
  }
  return req;
}

export function principalOf(req) {
  let current = req;
  for (let depth = 0; current && typeof current === 'object' && depth < MAX_PROTOTYPE_DEPTH; depth += 1) {
    const found = principals.get(current);
    if (found) return found;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

/** The owner or a browser of the owner: the person. Anything untagged is not. */
export function isPerson(req) {
  return PERSON_KINDS.has(principalOf(req)?.kind);
}

export function isAgent(req) {
  return principalOf(req)?.kind === 'agent';
}

/** The conversation an agent token is bound to ('' for the cli token and for non-agents). */
export function agentConversationOf(req) {
  const principal = principalOf(req);
  return principal?.kind === 'agent' ? String(principal.conversationId || '') : '';
}

/**
 * "Not the owner" for the in-route checks that used to read only the
 * remote-relay flag: an agent token, a paired relay's key, or a request
 * another relay sent on the owner token (an older relay, unverified).
 */
export function notPerson(req, remoteFacts = null) {
  return !isPerson(req) || remoteFacts?.remote === true;
}

/** A short label for logs: `agent:<conv 8>`, `agent:cli`, `owner`, ... */
export function principalLabel(principal) {
  if (!principal) return 'none';
  if (principal.kind === 'agent') {
    return principal.agentKind === 'c' ? 'agent:cli' : `agent:${String(principal.conversationId || '').slice(0, 8)}`;
  }
  return principal.kind;
}
