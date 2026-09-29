'use strict';

// The inbound side of remote relays, shared by the message, conversation and
// question routes: which requests come from another relay's agent, the
// inbound switch, provenance ("origin") for API payloads, and the mentions in
// a human message that unlock a remote relay for its conversation (plus the
// hint the agent gets with that turn).
//
// `inbound` is the runtime's `remoteRelayInbound` dep:
//   { listRelays, selfNames, inboundEnabled, recordUnlock, describeRelay, repository }
// Every helper treats a missing one as "feature absent": nothing is remote,
// nothing unlocks, and the routes behave exactly as before.

import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_HEADERS,
  REMOTE_RELAY_TOOL_NAME,
  normalizeRemoteRelayOrigin,
  stripRemotePromptHeader,
} from '../../shared/remote-relay-contract.mjs';
import { findRemoteRelayMentions } from '../../shared/remote-relay-mentions.mjs';

export const REMOTE_INBOUND_DISABLED_RESPONSE = Object.freeze({
  error: 'This relay does not accept prompts from other relays\' agents',
  code: REMOTE_RELAY_ERROR_CODES.inboundDisabled,
});

function headerValue(req, name) {
  const value = req?.headers?.[name];
  return String((Array.isArray(value) ? value[0] : value) ?? '').trim();
}

function headerHops(req) {
  const text = headerValue(req, REMOTE_RELAY_HEADERS.hops);
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

/**
 * What a request says about coming from another relay's agent.
 * `remote` is true for the X-OAR-Remote-Origin header or any `origin` in the
 * body, even a malformed one, so such a request can never unlock a relay.
 * `origin` is the sanitised provenance to store: the body's, or a minimal one
 * built from the header (its value is the sender's relay id), so a turn an
 * agent started is always recognisable as one. The hop count is the larger of
 * the body's and the X-OAR-Remote-Hops header's.
 */
export function readRemoteRelayRequest(req, inbound, { body = req?.body } = {}) {
  if (!inbound) return { remote: false, origin: null };
  const rawOrigin = body && typeof body === 'object' ? body.origin : undefined;
  const senderRelayId = headerValue(req, REMOTE_RELAY_HEADERS.origin);
  const remote = !!senderRelayId || (rawOrigin !== undefined && rawOrigin !== null);
  if (!remote) return { remote: false, origin: null };
  const hops = headerHops(req);
  let origin = normalizeRemoteRelayOrigin(rawOrigin)
    || normalizeRemoteRelayOrigin(senderRelayId ? { relayId: senderRelayId, hops: hops ?? 1 } : null);
  if (origin && hops !== null && hops > origin.hops) {
    origin = normalizeRemoteRelayOrigin({ ...origin, hops });
  }
  return { remote: true, origin };
}

/** The inbound switch; on by default, closed when it cannot be read. */
export function remoteRelayInboundEnabled(inbound) {
  if (!inbound || typeof inbound.inboundEnabled !== 'function') return true;
  try {
    return inbound.inboundEnabled() !== false;
  } catch {
    return false;
  }
}

/**
 * Applies the inbound switch to a write route. Returns the request's
 * remote-relay facts (see readRemoteRelayRequest), or null after answering
 * 403 REMOTE_INBOUND_DISABLED because the request came from another relay's
 * agent and this relay does not accept those.
 */
export function admitRemoteRelayRequest(req, res, inbound) {
  const request = readRemoteRelayRequest(req, inbound);
  if (!request.remote || remoteRelayInboundEnabled(inbound)) return request;
  res.status(403).json({ ...REMOTE_INBOUND_DISABLED_RESPONSE });
  return null;
}

/**
 * The origin a public share may show: the facts the prompt's header line
 * already states, without the other relay's address or ids.
 */
export function publicRemoteRelayOrigin(origin) {
  if (!origin || typeof origin !== 'object') return null;
  return { ...origin, relayId: '', relayUrl: '', conversationId: '' };
}

// ─── Mentions ────────────────────────────────────────────────────────────────

// A remote relay names itself (pairing, health checks), so its name is
// untrusted inside a prompt block: no quotes, tags or line breaks.
function hintText(value, max = 60) {
  return String(value ?? '').replace(/[\r\n"<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The remote relays a human message mentions, in order of appearance:
 * `[{ relayId, name, online, version }]`. `text` is what the user typed; a
 * remote-prompt header line (a Resend of an agent's message) is not the user's
 * and is ignored. Empty without the feature or when the registry cannot be
 * read — a mention never breaks a send.
 */
export function findMentionedRemoteRelays(inbound, text) {
  if (!inbound || typeof inbound.listRelays !== 'function') return [];
  try {
    const listedRelays = inbound.listRelays();
    const relays = Array.isArray(listedRelays) ? listedRelays : [];
    const selfNames = typeof inbound.selfNames === 'function' ? (inbound.selfNames() || []) : [];
    const mentions = findRemoteRelayMentions(stripRemotePromptHeader(text), relays, {
      selfNames: Array.isArray(selfNames) ? selfNames : [],
    });
    return mentions.map(({ relayId }) => {
      const listed = relays.find((relay) => String(relay?.id || '').trim() === relayId) || {};
      let described = null;
      try {
        described = typeof inbound.describeRelay === 'function' ? inbound.describeRelay(relayId) : null;
      } catch {
        described = null;
      }
      return {
        relayId,
        name: String(described?.name || listed.name || relayId),
        online: typeof described?.online === 'boolean'
          ? described.online
          : String(listed.lastStatus || '').trim().toLowerCase() === 'online',
        version: String(described?.version || listed.version || '').trim(),
      };
    });
  } catch {
    return [];
  }
}

/**
 * The one reminder block the agent gets with a turn whose message mentions
 * remote relays ('' for none). It rides in the queued prompt only, never in
 * the stored message, and the prompt sanitizers strip <system_reminder>
 * blocks from anything displayed.
 */
export function formatRemoteRelayMentionHint(relays = []) {
  const described = (Array.isArray(relays) ? relays : [])
    .map((relay) => {
      const name = hintText(relay?.name) || hintText(relay?.relayId);
      if (!name) return '';
      const version = hintText(relay?.version, 40);
      const status = relay?.online ? 'online' : 'offline';
      return `"${name}" (${version ? `${status}, OAR ${version}` : status})`;
    })
    .filter(Boolean);
  if (!described.length) return '';
  const subject = described.length === 1
    ? `the remote OAR relay ${described[0]}`
    : `the remote OAR relays ${described.join(', ')}`;
  return `<system_reminder>The user mentioned ${subject}. The ${REMOTE_RELAY_TOOL_NAME} tool can list, read, prompt and create sessions there.</system_reminder>`;
}

/**
 * The paired relay a remote prompt came from: `{ relayId, name }` (`relayId`
 * is the local registry id), or null when the sender is not paired here or
 * names no relay id.
 */
export function findOriginRemoteRelay(inbound, origin) {
  const instance = String(origin?.relayId || '').trim();
  if (!inbound || typeof inbound.listRelays !== 'function' || !instance) return null;
  try {
    const listed = inbound.listRelays();
    const relay = (Array.isArray(listed) ? listed : [])
      .find((entry) => String(entry?.relayId || '').trim() === instance);
    return relay ? { relayId: String(relay.id || ''), name: String(relay.name || relay.id || '') } : null;
  } catch {
    return null;
  }
}

/**
 * The reminder the agent gets with a prompt another relay's agent sent: that
 * relay is open to this conversation, and where the sender's session is. ''
 * when the sender is not a paired relay. Like the mention hint, it rides in
 * the queued prompt only.
 */
export function formatRemoteRelayOriginHint(relay, origin) {
  const name = hintText(relay?.name);
  if (!name) return '';
  const session = hintText(origin?.conversationId, 80);
  const where = session ? `relay "${name}", session "${session}"` : `relay "${name}"`;
  return `<system_reminder>This prompt came from an agent on the paired OAR relay "${name}". `
    + 'Your reply to it is handed back to that agent by itself. '
    + `For more than the reply (reading its session, a question, a later report) the ${REMOTE_RELAY_TOOL_NAME} tool is open for that relay in this conversation: ${where}. `
    + 'A prompt you send there while its turn is still running is steered into that turn.</system_reminder>';
}

/** The queued prompt with the mention hint after the user's text. */
export function withRemoteRelayMentionHint(promptText, hint) {
  const text = String(promptText ?? '');
  if (!hint) return text;
  return text ? `${text}\n\n${hint}` : hint;
}

/**
 * Persists the unlocks for a stored human message. Returns how many were new.
 * Failures are swallowed: the message is already accepted, and the agent
 * learns about a missing unlock from the tool's LOCKED answer.
 */
export function recordRemoteRelayUnlocks(inbound, { conversationId, messageId, relays = [] } = {}) {
  if (!inbound || typeof inbound.recordUnlock !== 'function') return 0;
  let created = 0;
  for (const relay of Array.isArray(relays) ? relays : []) {
    try {
      if (inbound.recordUnlock(conversationId, relay?.relayId, messageId)) created += 1;
    } catch {
      // Keep going: one relay's failure must not cost the others their unlock.
    }
  }
  return created;
}
