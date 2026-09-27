// Finds the remote relays a user message mentions.
//
// A mention unlocks that relay for the conversation, so the rules are strict
// about token boundaries: a relay is mentioned by its name or by the DNS host
// of its URL, as a whole token, case-insensitively, with or without a leading @.
//
//   "ask @linux-test to run the suite"      → linux-test
//   "what is relay-b.example.test doing?"   → the relay whose host that is
//   "https://relay-b.example.test/x"        → same (URLs count)
//   "a.relay-b.example.test"                → nothing for a relay named
//                                             "relay-b.example.test" (a longer host)
//   "relay-b.example.test.backup"           → nothing (a longer name)
//   "curl localhost:3000"                   → nothing for a relay at localhost:8123
//
// A loopback name or an IP literal says where a relay runs, not which one it
// is, and turns up in everyday text ("curl localhost:3000", "ping 10.0.0.1")
// without its port: a URL host like that is no alias, and a relay whose name
// is one (it gave none, so its host stood in) needs the leading @.
//
// Shared by the server (which unlocks) and the browser (which highlights).

const NAME_CHAR = /[a-z0-9._-]/;
const TAIL_CHAR = /[a-z0-9_-]/;
const ALNUM = /[a-z0-9]/;

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

function startsToken(lower, index) {
  if (index === 0) return true;
  return !NAME_CHAR.test(lower[index - 1]);
}

/** An @ right before `index` that starts a token itself ("ask @x", not "mail@x"). */
function atMention(lower, index) {
  return index > 0 && lower[index - 1] === '@' && startsToken(lower, index - 1);
}

function endsToken(lower, end) {
  if (end >= lower.length) return true;
  const next = lower[end];
  if (TAIL_CHAR.test(next)) return false;
  if (next === '.' && end + 1 < lower.length && ALNUM.test(lower[end + 1])) return false;
  return true;
}

/**
 * Returns `[{ relayId, alias, index }]`, one entry per mentioned relay (the
 * first occurrence), in order of appearance. `relays` are `{ id, name, url }`.
 * Aliases equal to one of `selfNames` (this relay's own name) are ignored, and
 * an alias shared by two relays is ambiguous and ignored too.
 */
export function findRemoteRelayMentions(text, relays = [], { selfNames = [] } = {}) {
  const lower = String(text ?? '').toLowerCase();
  if (!lower || !Array.isArray(relays) || relays.length === 0) return [];
  const self = new Set(selfNames.map((name) => toText(name).toLowerCase()).filter(Boolean));

  const owners = new Map();
  for (const relay of relays) {
    const id = toText(relay?.id);
    if (!id) continue;
    for (const alias of remoteRelayAliases(relay)) {
      if (self.has(alias)) continue;
      const owner = owners.get(alias);
      owners.set(alias, owner && owner !== id ? null : id);
    }
  }

  const found = new Map();
  for (const [alias, relayId] of owners) {
    if (!relayId) continue;
    const needsAt = isAddressHost(alias);
    let from = 0;
    while (from <= lower.length - alias.length) {
      const index = lower.indexOf(alias, from);
      if (index === -1) break;
      if (startsToken(lower, index) && endsToken(lower, index + alias.length) && (!needsAt || atMention(lower, index))) {
        const previous = found.get(relayId);
        if (!previous || index < previous.index) found.set(relayId, { relayId, alias, index });
        break;
      }
      from = index + 1;
    }
  }
  return [...found.values()].sort((a, b) => a.index - b.index);
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
