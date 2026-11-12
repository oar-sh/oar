// The relay's credential formats, shared by the relay, its workers, the MCP
// server, the Copilot extension and the `oar` CLI. Pure (node:crypto only):
// no file is read or written here (services/owner-secret-store.mjs does that).
//
//   oaro1_<b64url 32 B>                      owner token (the person's sign-in credential)
//   oars1_<b64url 32 B>                      browser session (cookie)
//   oarc1_<b64url 32 B>                      sign-in code (single use)
//   oara1_<k>.<b64url subject>.<b64url mac>  agent token, k = s (one session) | c (cli)
//   oarp1_<b64url 32 B>                      peer key (a paired relay)
//   oark1_<b64url 32 B>                      a browser session's proof key (page storage, header)
//
// Owner tokens from before the prefix (a UUID or any other text) stay valid:
// the relay keeps only the SHA-256 of the trimmed value and compares hashes.
// An agent token is never stored: it is an HMAC under the relay's agentKey,
// recomputed and compared in constant time.

import crypto from 'node:crypto';

export const OWNER_TOKEN_PREFIX = 'oaro1_';
export const BROWSER_SESSION_PREFIX = 'oars1_';
export const SIGNIN_CODE_PREFIX = 'oarc1_';
export const AGENT_TOKEN_PREFIX = 'oara1_';
export const PEER_KEY_PREFIX = 'oarp1_';
export const SESSION_PROOF_PREFIX = 'oark1_';
// The header a signed-in page sends its session's proof key in.
export const SESSION_PROOF_HEADER = 'x-oar-session-proof';

export const AGENT_TOKEN_KINDS = Object.freeze({ session: 's', cli: 'c' });
// The subject of the one `c` token: the `oar` CLI and tools started by hand.
export const CLI_AGENT_SUBJECT = 'cli';
// The environment variable every session's processes get.
export const AGENT_TOKEN_ENV = 'OAR_AGENT_TOKEN';

// Any prefixed relay credential, for log redaction and the preview proxy.
export const RELAY_CREDENTIAL_PATTERN = /oar[oascpk]1_[A-Za-z0-9_\-.]+/g;
const RELAY_CREDENTIAL_TEST = /^oar[oascpk]1_[A-Za-z0-9_\-.]+$/;

const AGENT_SUBJECT_MAX = 200;
const AGENT_KEY_BYTES = 32;

function toText(value) {
  return String(value ?? '').trim();
}

/** True for a value with one of the relay's credential prefixes. */
export function isRelayCredential(value) {
  return RELAY_CREDENTIAL_TEST.test(toText(value));
}

/** Replaces every prefixed relay credential in a text with `replacement`. */
export function redactRelayCredentials(text, replacement = '[token]') {
  return String(text ?? '').replace(RELAY_CREDENTIAL_PATTERN, replacement);
}

/** SHA-256 hex of the trimmed value, '' for an empty one (the singleton lock uses the same). */
export function hashOwnerToken(value) {
  const token = toText(value);
  if (!token) return '';
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two equal-length hex digests; '' never matches. */
export function hashesMatch(left, right) {
  const a = Buffer.from(toText(left), 'utf8');
  const b = Buffer.from(toText(right), 'utf8');
  if (!a.length || !b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Does the presented value hash to `expectedHash`? Constant time. */
export function ownerTokenMatchesHash(presented, expectedHash) {
  const hash = hashOwnerToken(presented);
  // Hash both sides to the same length first, so even an unexpected stored
  // value never short-circuits on its length.
  return !!hash && hashesMatch(hash, toText(expectedHash).toLowerCase());
}

export function mintOwnerToken(randomBytes = crypto.randomBytes) {
  return `${OWNER_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function mintAgentKey(randomBytes = crypto.randomBytes) {
  return randomBytes(AGENT_KEY_BYTES).toString('base64url');
}

/** The agentKey as bytes, or null when it is not a usable key. */
export function agentKeyBytes(value) {
  if (Buffer.isBuffer(value)) return value.length >= 16 ? value : null;
  const text = toText(value);
  if (!/^[A-Za-z0-9_-]{22,}$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length >= 16 ? bytes : null;
}

function normalizeKind(kind) {
  const text = toText(kind);
  if (text === 'session' || text === AGENT_TOKEN_KINDS.session) return AGENT_TOKEN_KINDS.session;
  if (text === 'cli' || text === AGENT_TOKEN_KINDS.cli) return AGENT_TOKEN_KINDS.cli;
  return '';
}

function agentMac(key, kind, subject) {
  return crypto.createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(kind, 'utf8'), Buffer.from(subject, 'utf8')]))
    .digest();
}

/**
 * `oara1_<k>.<b64url subject>.<b64url HMAC-SHA256(agentKey, k‖subject)>`.
 * kind `s` (a session: subject = its conversation id) or `c` (subject `cli`).
 */
export function mintAgentTokenWithKey(agentKey, { kind, subject } = {}) {
  const key = agentKeyBytes(agentKey);
  if (!key) throw new Error('No agent key');
  const k = normalizeKind(kind);
  if (!k) throw new Error('Unknown agent token kind');
  const sub = k === AGENT_TOKEN_KINDS.cli ? (toText(subject) || CLI_AGENT_SUBJECT) : toText(subject);
  if (!sub || sub.length > AGENT_SUBJECT_MAX) throw new Error('Invalid agent token subject');
  const mac = agentMac(key, k, sub);
  return `${AGENT_TOKEN_PREFIX}${k}.${Buffer.from(sub, 'utf8').toString('base64url')}.${mac.toString('base64url')}`;
}

/** The parts of an agent token (unverified), or null when it does not have the shape. */
export function parseAgentToken(value) {
  const text = toText(value);
  if (!text.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const parts = text.slice(AGENT_TOKEN_PREFIX.length).split('.');
  if (parts.length !== 3) return null;
  const [k, subjectPart, macPart] = parts;
  if (k !== AGENT_TOKEN_KINDS.session && k !== AGENT_TOKEN_KINDS.cli) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(subjectPart) || !/^[A-Za-z0-9_-]{43}$/.test(macPart)) return null;
  const subject = Buffer.from(subjectPart, 'base64url').toString('utf8');
  if (!subject || subject.length > AGENT_SUBJECT_MAX || /[\u0000-\u001f]/.test(subject)) return null;
  // Canonical encoding only: one subject has one token.
  if (Buffer.from(subject, 'utf8').toString('base64url') !== subjectPart) return null;
  // The MAC too: 43 characters carry 258 bits, the last two of them unused.
  // A last character that differs only there decodes to the same bytes, and
  // would be a second spelling of the same token.
  const mac = Buffer.from(macPart, 'base64url');
  if (mac.toString('base64url') !== macPart) return null;
  return { kind: k, subject, mac };
}

/**
 * `{ kind: 's'|'c', subject }` for a genuine agent token under `agentKey`,
 * else null. The MAC is compared in constant time.
 */
export function verifyAgentTokenWithKey(agentKey, value) {
  const key = agentKeyBytes(agentKey);
  const parsed = parseAgentToken(value);
  if (!key || !parsed) return null;
  const expected = agentMac(key, parsed.kind, parsed.subject);
  if (expected.length !== parsed.mac.length || !crypto.timingSafeEqual(expected, parsed.mac)) return null;
  return { kind: parsed.kind, subject: parsed.subject };
}
