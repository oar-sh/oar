'use strict';

import {
  REMOTE_RELAY_ERROR_CODES,
  REMOTE_RELAY_HEADERS,
  REMOTE_RELAY_LIMITS,
  checkRemoteRelayUrlPolicy,
} from '../../shared/remote-relay-contract.mjs';
import { PEER_KEY_PREFIX } from '../../shared/relay-credentials.mjs';
import { identityHeld, usablePeerToken } from './remote-relay-peer-keys.mjs';

// The outbound HTTP client a relay uses to call the OTHER relays it is paired
// with (plan §5.3). Deliberately separate from the worker `api` helper: that
// one adds X-Relay-* worker-identity headers, which a remote would read as
// queue ownership. This client sends exactly five headers — the bearer token,
// Accept, Content-Type (with a body), and the two x-oar-remote-* headers that
// carry the calling relay and the hop count — and nothing else.
//
// The token must never leave for a host the user did not configure, so
// redirects are refused rather than followed, and the address policy
// (https, or http only on loopback/private ranges) is re-checked per call.
//
// Peer keys: a relay at protocol 2 that gave this one a key is called with
// that key, never with an owner token. After a call with it worked the hook
// drops the owner token held for that relay; a 401 or PEER_KEY_REQUIRED on
// it asks once for a new key and retries once. A PEER_KEY_REQUIRED on a call
// made without a key is passed to the `required` hook (the row then says to
// add that relay again from its link).

const IDENTITY_PATH = '/api/relay/identity';
const LEGACY_STATUS_PATH = '/api/status';
const LEGACY_NAME_PATH = '/api/settings/pwa-app-name';
const REMOTE_ERROR_TEXT_MAX = 500;

export class RemoteRelayError extends Error {
  /**
   * `code` is one of REMOTE_RELAY_ERROR_CODES (or REMOTE_RELAY_HTTP_<status>).
   * `status` is the remote's HTTP status when it answered, `detail` a short
   * technical reason (a socket error code, the remote's own error code),
   * `remoteError` the remote's `error` text and `remoteBody` its parsed JSON.
   */
  constructor(code, message, { status = null, detail = null, remoteError = null, remoteBody = null } = {}) {
    super(message);
    this.name = 'RemoteRelayError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.remoteError = remoteError;
    this.remoteBody = remoteBody;
  }
}

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

function relayLabel(relay) {
  const name = toText(relay?.name) || hostOf(relay?.url);
  return name ? `Relay "${name}"` : 'The remote relay';
}

/** Does `relay` hold a key from that relay which that relay refused? */
function heldKeyRefused(relay) {
  return toText(relay?.peerToken).startsWith(PEER_KEY_PREFIX)
    && (relay.peerTokenState === 'revoked' || relay.peerTokenState === 'gone');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function tooLargeError(relay, maxBytes) {
  return new RemoteRelayError(
    REMOTE_RELAY_ERROR_CODES.unsupported,
    `${relayLabel(relay)} sent an answer larger than ${maxBytes} bytes`,
    { detail: 'response too large' },
  );
}

/** Reads the body as text, stopping (and cancelling the stream) past maxBytes. */
async function readCappedText(response, relay, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.(); } catch {}
    throw tooLargeError(relay, maxBytes);
  }
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = typeof response.text === 'function' ? String(await response.text()) : '';
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw tooLargeError(relay, maxBytes);
    return text;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    total += chunk.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw tooLargeError(relay, maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function parseJson(text) {
  if (!text.trim()) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function networkError(relay, error, timeoutMs) {
  const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
  const detail = timedOut
    ? `timed out after ${Math.round(timeoutMs / 100) / 10} s`
    : toText(error?.cause?.code || error?.code || error?.cause?.message || error?.message) || 'network error';
  return new RemoteRelayError(
    REMOTE_RELAY_ERROR_CODES.offline,
    `${relayLabel(relay)} is not reachable (${detail})`,
    { detail },
  );
}

/**
 * The error for a relay that answered with a non-2xx status and (maybe) a JSON
 * body. Shared with the in-process loopback, so a refusal of this relay's own
 * routes reads exactly like a paired relay's.
 */
export function remoteRelayHttpError(relay, status, body) {
  return httpError(relay, status, body);
}

// `credential` is what the refused request carried: 'key' (the key that
// relay gave this one, `oarp1_…`) or 'token' (a relay token). A 401 says
// which, so the row and the agent read what to fix.
function httpError(relay, status, body, { credential = 'token' } = {}) {
  const remoteError = isPlainObject(body) && toText(body.error) ? toText(body.error).slice(0, REMOTE_ERROR_TEXT_MAX) : null;
  const remoteCode = isPlainObject(body) && toText(body.code) ? toText(body.code).slice(0, 100) : null;
  const extras = { status, detail: remoteCode, remoteError, remoteBody: isPlainObject(body) ? body : null };
  const label = relayLabel(relay);
  if (status === 401) {
    const refused = credential === 'key' ? 'the key it gave this relay' : 'the token';
    return new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unauthorized, `${label} rejected ${refused} (401)`, extras);
  }
  if (status === 403 && remoteCode === REMOTE_RELAY_ERROR_CODES.inboundDisabled) {
    return new RemoteRelayError(
      REMOTE_RELAY_ERROR_CODES.inboundDisabled,
      `${label} does not accept prompts from other relays' agents (its inbound switch is off)`,
      extras,
    );
  }
  if (status === 404) {
    return new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.notFound, `${label}: not found${remoteError ? ` (${remoteError})` : ''}`, extras);
  }
  if (status === 403 && [
    REMOTE_RELAY_ERROR_CODES.peerScope,
    REMOTE_RELAY_ERROR_CODES.peerKeyRequired,
    REMOTE_RELAY_ERROR_CODES.originMismatch,
  ].includes(remoteCode)) {
    return new RemoteRelayError(remoteCode, `${label} refused: ${remoteError || remoteCode}`, extras);
  }
  return new RemoteRelayError(
    `${REMOTE_RELAY_ERROR_CODES.httpPrefix}${status}`,
    `${label} answered HTTP ${status}${remoteError ? `: ${remoteError}` : ''}`,
    extras,
  );
}

function capText(value, max) {
  const text = toText(value);
  return text ? text.slice(0, max) : '';
}

function normalizeIdentity(identity, host) {
  const remoteRelays = isPlainObject(identity.remoteRelays) ? identity.remoteRelays : {};
  const protocol = Number(remoteRelays.protocol);
  const publicUrl = capText(identity.publicUrl, 300);
  return {
    relayId: capText(identity.relayId, 100) || null,
    name: capText(identity.name, 60) || host,
    version: capText(identity.version, 40) || null,
    platform: capText(identity.platform, 20) || null,
    publicUrl: publicUrl && /^https?:\/\//i.test(publicUrl) ? publicUrl : null,
    // A relay that serves the identity route speaks at least protocol 1.
    protocol: Number.isInteger(protocol) && protocol >= 0 ? protocol : 1,
    inbound: remoteRelays.inbound !== false,
    peerKeys: remoteRelays.peerKeys === true,
    // Its page answers `?answer=<id>&option=<n>` after the person confirms.
    answerLink: isPlainObject(identity.capabilities) && identity.capabilities.answerLink === true,
    // It gives a relay that adds it one way a key of its own (0.9.27).
    inboundKeys: remoteRelays.inboundKeys === true,
  };
}

export function createRemoteRelayClient({
  fetchImpl = globalThis.fetch,
  getOwnRelayId = () => '',
  timeoutMs: defaultTimeoutMs = REMOTE_RELAY_LIMITS.requestTimeoutMs,
  maxBytes = REMOTE_RELAY_LIMITS.responseMaxBytes,
} = {}) {
  // `{ worked(relay), refused(relay) → Promise<entry|null>, required(relay) }` from the
  // peer-key service (set once it exists).
  let peerKeyHooks = null;

  function setPeerKeyHooks(hooks) {
    peerKeyHooks = hooks || null;
  }

  // The credential for that relay: its key for this relay when it gave one
  // and speaks protocol 2, else the token stored for it. This relay's own
  // owner token is never sent: it is kept only as a hash (an `own` entry
  // from before was given the token as its own when it moved out of the
  // config; `none` sends none). A held entry (its identity changed) gets
  // nothing: neither key nor token goes to that address until the owner
  // confirms.
  function tokenFor(relay) {
    if (identityHeld(relay)) return '';
    const peerToken = usablePeerToken(relay);
    if (peerToken) return peerToken;
    return relay?.tokenMode === 'custom' ? toText(relay?.token) : '';
  }

  /** The request URL: the stored base (with its path prefix) plus `path` and `query`. */
  function buildUrl(relay, path, query) {
    const base = toText(relay?.url).replace(/\/+$/, '');
    const route = String(path || '');
    if (!route.startsWith('/') || route.startsWith('//')) {
      throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.invalidInput, `Invalid remote path: ${route.slice(0, 80)}`);
    }
    let baseUrl;
    let target;
    try {
      baseUrl = new URL(base);
      target = new URL(`${base}${route}`);
    } catch {
      throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unsupported, `${relayLabel(relay)} has no valid address`);
    }
    // `..` segments must not climb out of the relay's path prefix.
    const prefix = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
    if (target.origin !== baseUrl.origin || !target.pathname.startsWith(prefix)) {
      throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.invalidInput, `Invalid remote path: ${route.slice(0, 80)}`);
    }
    if (isPlainObject(query)) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        target.searchParams.set(key, String(value));
      }
    }
    return target;
  }

  /**
   * One call to a remote relay. `relay` is a registry entry ({ url, tokenMode,
   * token?, name? }). Resolves to the parsed JSON body (null when empty);
   * rejects with a RemoteRelayError.
   */
  async function request(relay, method, path, options = {}) {
    const peerToken = usablePeerToken(relay);
    const retry = options.peerKeyRetry !== false && !!peerToken && !!peerKeyHooks;
    try {
      const answer = await requestOnce(relay, method, path, options);
      if (peerToken && options.peerKeyRetry !== false) {
        try { peerKeyHooks?.worked?.(relay); } catch {}
      }
      return answer;
    } catch (error) {
      const refusedKey = error instanceof RemoteRelayError && (
        error.code === REMOTE_RELAY_ERROR_CODES.unauthorized
        || error.code === REMOTE_RELAY_ERROR_CODES.peerKeyRequired
      ) && Number(error.status) > 0;
      // Refused for want of a key, and none was sent: nothing to retry with
      // (the health loop asks with a token held for it); the row says so.
      if (!peerToken && options.peerKeyRetry !== false
        && error instanceof RemoteRelayError && error.code === REMOTE_RELAY_ERROR_CODES.peerKeyRequired) {
        try { peerKeyHooks?.required?.(relay); } catch {}
      }
      if (!retry || !refusedKey) throw error;
      let fresh = null;
      try { fresh = await peerKeyHooks.refused(relay); } catch { fresh = null; }
      if (!fresh) throw error;
      return request(fresh, method, path, { ...options, peerKeyRetry: false });
    }
  }

  async function requestOnce(relay, method, path, { body, query, hops = 1, timeoutMs } = {}) {
    const target = buildUrl(relay, path, query);
    const policy = checkRemoteRelayUrlPolicy(target);
    if (!policy.ok) {
      throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unsupported, `${relayLabel(relay)}: ${policy.error}`);
    }
    const token = tokenFor(relay);
    if (!token) {
      // Its identity changed (another address, or another relay answers
      // there): nothing held for it, key or token, is sent until the owner
      // confirms.
      if (identityHeld(relay)) {
        throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unauthorized, `${relayLabel(relay)}: its identity changed, so nothing this relay holds for it is sent; confirm it in Settings → Relays`, { detail: 'identity held' });
      }
      // The key that relay gave this one was refused there (revoked, or it no
      // longer lists this relay), and no token is held for it: the refusal is
      // what stands, not "no token" (the row keeps saying Re-add from link).
      if (heldKeyRefused(relay)) {
        throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unauthorized, `${relayLabel(relay)} rejected the key it gave this relay (401)`, { detail: 'key refused' });
      }
      throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.unauthorized, `${relayLabel(relay)} has no token configured`);
    }
    if (typeof fetchImpl !== 'function') {
      throw new RemoteRelayError(REMOTE_RELAY_ERROR_CODES.offline, 'No HTTP client is available', { detail: 'fetch unavailable' });
    }

    const hopCount = Number.isInteger(Number(hops)) && Number(hops) >= 0 ? Number(hops) : 1;
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const ownRelayId = toText(getOwnRelayId?.());
    if (ownRelayId) headers[REMOTE_RELAY_HEADERS.origin] = ownRelayId;
    headers[REMOTE_RELAY_HEADERS.hops] = String(hopCount);
    const hasBody = body !== undefined;
    if (hasBody) headers['Content-Type'] = 'application/json';

    const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : defaultTimeoutMs;

    let response;
    try {
      response = await fetchImpl(target.href, {
        method: String(method || 'GET').toUpperCase(),
        headers,
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        // A redirect would carry the bearer token to wherever it points.
        redirect: 'manual',
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } catch (error) {
      throw networkError(relay, error, effectiveTimeoutMs);
    }

    const status = Number(response?.status) || 0;
    if (response?.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
      try { await response.body?.cancel?.(); } catch {}
      throw new RemoteRelayError(
        `${REMOTE_RELAY_ERROR_CODES.httpPrefix}${status || '3xx'}`,
        `${relayLabel(relay)} answered with a redirect; redirects are refused so the token cannot follow them (check the address, or a login page in front of the relay)`,
        { status: status || null, detail: 'redirect refused' },
      );
    }

    let text;
    try {
      text = await readCappedText(response, relay, maxBytes);
    } catch (error) {
      if (error instanceof RemoteRelayError) throw error;
      throw networkError(relay, error, effectiveTimeoutMs);
    }
    const parsed = parseJson(text);

    if (status < 200 || status >= 300) {
      throw httpError(relay, status, parsed.value, { credential: token.startsWith(PEER_KEY_PREFIX) ? 'key' : 'token' });
    }
    if (!parsed.ok) {
      throw new RemoteRelayError(
        REMOTE_RELAY_ERROR_CODES.unsupported,
        `${relayLabel(relay)} did not answer with JSON (is this an OAR relay address?)`,
        { status, detail: 'not json' },
      );
    }
    return parsed.value;
  }

  /**
   * Identity of the relay at `baseUrl`, used when adding one and by the health
   * check. A relay that predates remote relays (the identity route answers
   * 404) is described from /api/status and its PWA app name: protocol 0.
   */
  async function probe(baseUrl, token, { timeoutMs, relay: entry = null } = {}) {
    const url = toText(baseUrl).replace(/\/+$/, '');
    const host = hostOf(url);
    // A registry entry probes with its own credential (its key when it has
    // one); a pasted link with the token given.
    const relay = entry && toText(entry.url).replace(/\/+$/, '') === url
      ? entry
      : (token ? { url, tokenMode: 'custom', token } : { url, tokenMode: 'none' });
    const unexpected = () => new RemoteRelayError(
      REMOTE_RELAY_ERROR_CODES.unsupported,
      `${relayLabel(relay)} did not answer like an OAR relay`,
      { detail: 'unexpected identity' },
    );

    try {
      const identity = await request(relay, 'GET', IDENTITY_PATH, { timeoutMs });
      if (!isPlainObject(identity)) throw unexpected();
      return normalizeIdentity(identity, host);
    } catch (error) {
      if (!(error instanceof RemoteRelayError) || error.code !== REMOTE_RELAY_ERROR_CODES.notFound) throw error;
    }

    const status = await request(relay, 'GET', LEGACY_STATUS_PATH, { timeoutMs });
    if (!isPlainObject(status)) throw unexpected();
    let appName = '';
    try {
      const pwa = await request(relay, 'GET', LEGACY_NAME_PATH, { timeoutMs });
      appName = capText(pwa?.appName, 60);
    } catch {}
    return {
      relayId: null,
      name: appName || host,
      version: capText(status.version, 40) || null,
      platform: capText(status.platform, 20) || null,
      publicUrl: null,
      protocol: 0,
      inbound: true,
    };
  }

  return { tokenFor, request, probe, setPeerKeyHooks };
}
