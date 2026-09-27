// Browser mirror of the pieces of shared/remote-relay-contract.mjs and
// shared/remote-relay-mentions.mjs the web UI needs. The browser cannot import
// shared/ (only server/public is served), so these are hand-kept copies;
// remote-relay-shared.test.mjs asserts they behave exactly like the originals.

export const REMOTE_RELAY_PERMISSIONS = Object.freeze(['read', 'prompt', 'full']);
export const REMOTE_RELAY_DEFAULT_PERMISSION = 'full';
export const REMOTE_RELAY_SOCKET_EVENT = 'remote_relays_updated';

// The header line a relay puts at the top of a prompt it forwards. The UI
// hides it on bubbles that carry `origin` (the badge shows the same facts).
export const REMOTE_PROMPT_HEADER_PATTERN = /^\[Remote prompt from an agent on relay "[^"\r\n]*"[^\r\n]*\](?:\r?\n){1,2}/;

const NAME_CHAR = /[a-z0-9._-]/;

function toText(value) {
  return String(value ?? '').trim();
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function normalizeRemoteRelayPermission(value) {
  const permission = toText(value).toLowerCase();
  return REMOTE_RELAY_PERMISSIONS.includes(permission) ? permission : REMOTE_RELAY_DEFAULT_PERMISSION;
}

export function stripRemotePromptHeader(text) {
  return String(text ?? '').replace(REMOTE_PROMPT_HEADER_PATTERN, '');
}

/** Link that opens one conversation in a relay's web UI. */
export function remoteConversationUrl(baseUrl, conversationId) {
  const base = toText(baseUrl).replace(/\/+$/, '');
  const id = toText(conversationId);
  if (!base) return '';
  return id ? `${base}/?conv=${encodeURIComponent(id)}` : `${base}/`;
}

/** localhost (and *.localhost), an IPv4 literal, or an IPv6 literal (bracketed as URL hosts are). */
export function isAddressHost(host) {
  const value = toText(host).toLowerCase();
  if (!value) return false;
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return true;
  return value.startsWith('[') || value.includes(':');
}

/** The lowercase aliases a relay can be mentioned by: its name and its URL host, unless that is an address. */
export function remoteRelayAliases(relay) {
  const aliases = new Set();
  const name = toText(relay?.name).toLowerCase();
  if (name) aliases.add(name);
  const host = hostOf(relay?.url);
  if (host && !isAddressHost(host)) aliases.add(host);
  return [...aliases];
}

/**
 * For the composer: the partial `@word` token ending at `caret`, or null.
 * `{ start, end, query }` where start is the index of the `@`.
 */
export function mentionQueryAt(text, caret) {
  const value = String(text ?? '');
  const end = Number.isInteger(caret) ? Math.min(Math.max(caret, 0), value.length) : value.length;
  let start = end;
  while (start > 0 && NAME_CHAR.test(value[start - 1].toLowerCase())) start -= 1;
  if (start === 0 || value[start - 1] !== '@') return null;
  const at = start - 1;
  if (at > 0 && !/\s|[([{"'`,;]/.test(value[at - 1])) return null;
  return { start: at, end, query: value.slice(start, end).toLowerCase() };
}

/** How far the mention token that starts at `from` runs (the rest of a word the caret sits in). */
export function mentionTokenEnd(text, from) {
  const value = String(text ?? '');
  let end = Math.min(Math.max(Number(from) || 0, 0), value.length);
  while (end < value.length && NAME_CHAR.test(value[end].toLowerCase())) end += 1;
  return end;
}
