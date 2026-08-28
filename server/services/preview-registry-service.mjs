'use strict';

import crypto from 'crypto';

// Preview lane registry: the in-memory set of dev servers published through the
// dedicated preview listener, plus the config normalization and the startup
// interlocks that keep that listener a separate origin from the relay.
//
// This module is deliberately http-free. It owns *what is allowed*; the listener
// (preview-proxy-server.mjs) owns the wire. Nothing here can reach relay state.

export const PREVIEW_PATH_PREFIX = 'test_';
export const PREVIEW_TOKEN_BYTES = 16;
const PREVIEW_TOKEN_RE = /^[0-9a-f]{32}$/;
const PREVIEW_PATH_RE = /^\/test_([0-9a-f]{32})(\/.*)?$/;

const DEFAULT_MAX_LIVE = 8;
const MIN_TARGET_PORT = 1024;
const MAX_PORT = 65535;

// Hostnames that always resolve back to this machine. A preview target is one of
// these unless the operator has explicitly widened the allowlist.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function toText(value) {
  return String(value ?? '').trim();
}

function parsePort(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_PORT) return value;
  const text = toText(value);
  if (!/^\d+$/.test(text)) return null;
  const num = Number.parseInt(text, 10);
  if (!Number.isInteger(num) || num < 0 || num > MAX_PORT) return null;
  return num;
}

function normalizeHost(value) {
  const host = toText(value).toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' ? '127.0.0.1' : host;
}

export function isLoopbackHost(value) {
  const host = toText(value).toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host)) return true;
  // The whole 127.0.0.0/8 block is loopback, not just .0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host.split('.').slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return host === '0:0:0:0:0:0:0:1';
}

function normalizeHostList(rawValue) {
  const entries = Array.isArray(rawValue)
    ? rawValue
    : toText(rawValue).split(',');
  const out = [];
  for (const entry of entries) {
    const host = normalizeHost(entry);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

// The public origin is compared by *hostname*, never by port: cookies are scoped
// to a host and ignore the port, so relay.example.com:3333 and
// relay.example.com:3334 would still share the relay's auth cookie. Only a
// different hostname is a real boundary.
function parseHostname(rawUrl) {
  const text = toText(rawUrl);
  if (!text) return '';
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeBaseUrl(rawUrl) {
  const text = toText(rawUrl);
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  // Preview URLs are built as `${base}/test_<token>/`, so a trailing slash on the
  // configured base would double up.
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * Normalizes the `previews` config block and runs the startup interlocks.
 *
 * Every interlock failure is collected rather than thrown: the caller keeps the
 * relay running and leaves the preview lane down, because a misconfigured
 * preview lane must never take the relay with it — but it must also never come
 * up half-configured, since each interlock is load-bearing for the isolation
 * argument.
 */
export function normalizePreviewsConfig(rawConfig = {}, {
  env = process.env,
  relayPort = null,
  relayHostnames = [],
  reservedPorts = [],
} = {}) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const envEnabled = toText(env?.COPILOT_PREVIEWS_ENABLED).toLowerCase();
  const enabled = envEnabled === '1' || envEnabled === 'true'
    ? true
    : (envEnabled === '0' || envEnabled === 'false' ? false : raw.enabled === true);

  const normalizedRelayPort = parsePort(relayPort);
  const envPort = parsePort(env?.COPILOT_PREVIEWS_PORT);
  const configPort = parsePort(raw.port);
  // Default is relay port + 1: a front proxy (Caddy, a cloudflared public
  // hostname) needs a fixed target, so the default has to be predictable.
  const defaultPort = Number.isInteger(normalizedRelayPort) && normalizedRelayPort < MAX_PORT
    ? normalizedRelayPort + 1
    : null;
  const port = envPort ?? configPort ?? defaultPort;

  const bindHost = normalizeHost(
    toText(env?.COPILOT_PREVIEWS_BIND_HOST) || toText(raw.bindHost) || '127.0.0.1',
  );
  const allowPublicBind = raw.allowPublicBind === true;

  const publicBaseUrl = normalizeBaseUrl(
    toText(env?.COPILOT_PREVIEWS_PUBLIC_BASE_URL) || toText(raw.publicBaseUrl),
  );
  const publicHostname = parseHostname(publicBaseUrl);

  const allowedTargetHosts = normalizeHostList(
    env?.COPILOT_PREVIEWS_ALLOWED_TARGET_HOSTS ?? raw.allowedTargetHosts,
  );

  const maxLiveRaw = Number(raw.maxLive);
  const maxLive = Number.isInteger(maxLiveRaw) && maxLiveRaw > 0 ? maxLiveRaw : DEFAULT_MAX_LIVE;

  const normalizedRelayHostnames = normalizeHostList(relayHostnames);
  const normalizedReservedPorts = (Array.isArray(reservedPorts) ? reservedPorts : [reservedPorts])
    .map((entry) => parsePort(entry))
    .filter((entry) => Number.isInteger(entry) && entry > 0);

  const errors = [];
  if (enabled) {
    // Interlock 1 — a public base URL is mandatory and must not share the relay's
    // hostname. Same hostname means shared cookies and same-origin fetch, which
    // removes the entire browser-side boundary.
    if (!publicBaseUrl) {
      errors.push('previews.publicBaseUrl is required (an http(s) URL on a hostname of your own)');
    } else if (publicHostname && normalizedRelayHostnames.includes(publicHostname)) {
      errors.push(`previews.publicBaseUrl must use a different hostname than the relay (got ${publicHostname})`);
    }

    // Interlock 2 — the listener must not collide with the relay's own ports.
    // Port 0 is an explicit opt-in to an ephemeral port.
    if (!Number.isInteger(port)) {
      errors.push('previews.port could not be resolved (set previews.port or config.port)');
    } else if (port !== 0) {
      if (port < MIN_TARGET_PORT) {
        errors.push(`previews.port must be >= ${MIN_TARGET_PORT} (got ${port})`);
      } else if (normalizedReservedPorts.includes(port) || port === normalizedRelayPort) {
        errors.push(`previews.port ${port} collides with a relay port`);
      }
    }

    // Interlock 3 — the front proxy is expected to be local. Binding a public
    // interface by accident would put every preview on the LAN unfiltered.
    if (!isLoopbackHost(bindHost) && !allowPublicBind) {
      errors.push(`previews.bindHost ${bindHost} is not loopback; set previews.allowPublicBind to override`);
    }
  }

  // Ports the relay owns: a preview must never be pointed at one of these, or it
  // would republish the relay UI (login page and all) on the public preview host.
  const deniedTargetPorts = [...new Set([
    ...normalizedReservedPorts,
    ...(Number.isInteger(normalizedRelayPort) ? [normalizedRelayPort] : []),
    ...(Number.isInteger(port) && port > 0 ? [port] : []),
  ])];

  return {
    enabled: enabled && errors.length === 0,
    requested: enabled,
    port,
    bindHost,
    allowPublicBind,
    publicBaseUrl,
    publicHostname,
    allowedTargetHosts,
    deniedTargetPorts,
    maxLive,
    errors,
  };
}

export function createPreviewToken({ randomBytes = crypto.randomBytes } = {}) {
  return Buffer.from(randomBytes(PREVIEW_TOKEN_BYTES)).toString('hex');
}

export function isPreviewToken(value) {
  return PREVIEW_TOKEN_RE.test(toText(value));
}

/**
 * Splits a preview request path into its token and the upstream path.
 * Returns null for anything that is not a preview path at all, and
 * `{ token, upstreamPath: null }` for a bare `/test_<token>` that needs the
 * trailing-slash redirect (relative asset URLs resolve wrongly without it).
 */
export function parsePreviewPath(rawPath) {
  const text = toText(rawPath);
  if (!text.startsWith('/')) return null;
  const [pathname] = text.split('#');
  const queryIndex = pathname.indexOf('?');
  const bare = queryIndex === -1 ? pathname : pathname.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : pathname.slice(queryIndex);
  const match = PREVIEW_PATH_RE.exec(bare);
  if (!match) return null;
  const [, token, rest] = match;
  if (!rest) return { token, upstreamPath: null, query };
  return { token, upstreamPath: `${rest}${query}`, query };
}

export function previewBasePath(token) {
  return `/${PREVIEW_PATH_PREFIX}${token}/`;
}

/**
 * Validates an upstream target. Called at registration *and* re-checked by the
 * listener against the stored record, so a stored value can never drift into
 * something the policy would reject.
 */
export function validatePreviewTarget({ host, port } = {}, {
  allowedTargetHosts = [],
  deniedTargetPorts = [],
} = {}) {
  const normalizedHost = normalizeHost(host || '127.0.0.1');
  const normalizedPort = parsePort(port);

  if (!normalizedHost) return { ok: false, error: 'Missing target host' };
  if (!Number.isInteger(normalizedPort)) return { ok: false, error: 'Invalid target port' };
  if (normalizedPort < MIN_TARGET_PORT || normalizedPort > MAX_PORT) {
    return { ok: false, error: `Target port must be between ${MIN_TARGET_PORT} and ${MAX_PORT}` };
  }
  if (deniedTargetPorts.includes(normalizedPort)) {
    return { ok: false, error: `Port ${normalizedPort} belongs to the relay and cannot be previewed` };
  }
  if (!isLoopbackHost(normalizedHost) && !allowedTargetHosts.includes(normalizedHost)) {
    return { ok: false, error: `Target host ${normalizedHost} is not loopback and not in previews.allowedTargetHosts` };
  }
  return { ok: true, host: normalizedHost, port: normalizedPort };
}

/**
 * The live preview set. In-memory by design: a relay restart drops every
 * preview, which is the agreed lifecycle (nothing expires on its own, so a
 * restart is the only implicit cleanup).
 */
export function createPreviewRegistry({
  config,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  onChange = null,
} = {}) {
  const entries = new Map();
  const settings = config || normalizePreviewsConfig({});

  function toPublicRecord(entry) {
    return {
      token: entry.token,
      conversationId: entry.conversationId,
      label: entry.label,
      mode: entry.mode,
      targetHost: entry.targetHost,
      targetPort: entry.targetPort,
      rootDir: entry.rootDir,
      url: entry.url,
      basePath: entry.basePath,
      createdAt: entry.createdAt,
      online: entry.online,
      lastSeenOnline: entry.lastSeenOnline,
      hits: entry.hits,
    };
  }

  function emitChange(reason, entry) {
    if (typeof onChange !== 'function') return;
    try {
      onChange({ reason, preview: entry ? toPublicRecord(entry) : null, previews: list() });
    } catch {}
  }

  function list() {
    return [...entries.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toPublicRecord);
  }

  function listForConversation(conversationId) {
    const id = toText(conversationId);
    if (!id) return [];
    return list().filter((entry) => entry.conversationId === id);
  }

  function insertEntry(fields) {
    const token = createPreviewToken({ randomBytes });
    const basePath = previewBasePath(token);
    const entry = {
      token,
      basePath,
      url: `${settings.publicBaseUrl}${basePath}`,
      createdAt: now(),
      lastSeenOnline: null,
      hits: 0,
      ...fields,
    };
    entries.set(token, entry);
    emitChange('created', entry);
    return { ok: true, preview: toPublicRecord(entry) };
  }

  function checkCreatable() {
    if (!settings.enabled) {
      return { ok: false, status: 503, error: 'Preview lane is disabled' };
    }
    if (entries.size >= settings.maxLive) {
      return { ok: false, status: 429, error: `Too many live previews (max ${settings.maxLive})` };
    }
    return { ok: true };
  }

  function create({ conversationId, port, host, label } = {}) {
    const creatable = checkCreatable();
    if (!creatable.ok) return creatable;
    const target = validatePreviewTarget({ host, port }, settings);
    if (!target.ok) return { ok: false, status: 400, error: target.error };

    return insertEntry({
      mode: 'port',
      conversationId: toText(conversationId) || null,
      label: toText(label).slice(0, 120) || `localhost:${target.port}`,
      targetHost: target.host,
      targetPort: target.port,
      rootDir: null,
      // null = never probed yet; the card shows no badge until the first probe.
      online: null,
    });
  }

  // Static mode. `rootDir` must arrive already jailed (realpath inside the
  // workspace root) — the route owns that check because it has fs access and
  // the workspace resolver; the registry stays fs-free.
  function createStatic({ conversationId, rootDir, label } = {}) {
    const creatable = checkCreatable();
    if (!creatable.ok) return creatable;
    const root = toText(rootDir);
    if (!root) return { ok: false, status: 400, error: 'Missing rootDir' };

    return insertEntry({
      mode: 'static',
      conversationId: toText(conversationId) || null,
      label: toText(label).slice(0, 120) || root.split(/[\\/]/).filter(Boolean).pop() || 'static preview',
      targetHost: null,
      targetPort: null,
      rootDir: root,
      // There is no upstream to die: a static preview is online by definition,
      // and the health probe skips it.
      online: true,
    });
  }

  // Hot path (every proxied request): returns the raw entry, re-validated
  // against current policy so a config reload cannot leave a stale grant live.
  function resolve(token) {
    if (!settings.enabled || !isPreviewToken(token)) return null;
    const entry = entries.get(token);
    if (!entry) return null;
    // Static entries have no upstream target; their per-request policy is the
    // path jail inside the static handler.
    if (entry.mode !== 'static') {
      const target = validatePreviewTarget(
        { host: entry.targetHost, port: entry.targetPort },
        settings,
      );
      if (!target.ok) return null;
    }
    return entry;
  }

  function recordHit(token, at = now()) {
    const entry = entries.get(toText(token));
    if (!entry) return;
    entry.hits += 1;
    entry.lastHitAt = at;
  }

  function markHealth(token, online, at = now()) {
    const entry = entries.get(toText(token));
    if (!entry) return false;
    const next = online === true;
    if (next) entry.lastSeenOnline = at;
    if (entry.online === next) return false;
    entry.online = next;
    emitChange('health', entry);
    return true;
  }

  function close(token) {
    const entry = entries.get(toText(token));
    if (!entry) return { ok: false, status: 404, error: 'Unknown preview' };
    entries.delete(entry.token);
    emitChange('closed', entry);
    return { ok: true, preview: toPublicRecord(entry) };
  }

  function closeForConversation(conversationId) {
    const id = toText(conversationId);
    if (!id) return 0;
    let closed = 0;
    for (const entry of [...entries.values()]) {
      if (entry.conversationId !== id) continue;
      entries.delete(entry.token);
      closed += 1;
    }
    if (closed > 0) emitChange('closed', null);
    return closed;
  }

  function clear() {
    const had = entries.size > 0;
    entries.clear();
    if (had) emitChange('cleared', null);
  }

  return {
    settings,
    get size() { return entries.size; },
    create,
    createStatic,
    resolve,
    recordHit,
    markHealth,
    close,
    closeForConversation,
    clear,
    list,
    listForConversation,
    get: (token) => {
      const entry = entries.get(toText(token));
      return entry ? toPublicRecord(entry) : null;
    },
  };
}
