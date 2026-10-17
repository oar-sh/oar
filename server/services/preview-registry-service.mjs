'use strict';

import crypto from 'crypto';

// Preview lane registry: the set of dev servers and folders published through
// the dedicated preview listener (persisted through an injected store, so it
// survives a restart), plus the config normalization and the startup
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


export const PREVIEW_TOKEN_REDACTION = '[preview link removed]';
// The path prefix as typed, percent-encoded, or encoded more than once.
const PATH_PREFIX_SRC = 'test(?:_|%(?:25)*5f)';
// A preview path is recognised from this many hex characters on, whatever
// follows and however long the run is: a link that was cut short (a reply
// still streaming, a turn that failed inside it, a capped line) is then
// removed like a whole one, and at most 7 of a token's 32 characters can
// remain, which leaves 100 bits to guess. Shorter runs stay, so names such as
// `test_add` or `test_1` read as written.
export const PREVIEW_REDACT_MIN_HEX = 8;
const PREVIEW_PATH_TOKEN_GLOBAL_RE = new RegExp(`${PATH_PREFIX_SRC}[0-9a-f]{${PREVIEW_REDACT_MIN_HEX},}`, 'gi');

// `abcdefgh(?:i(?:j(?:k)?)?)?`: the first `min` characters, then any more.
function prefixSource(token, min) {
  let tail = '';
  for (let i = token.length - 1; i >= min; i -= 1) tail = `(?:${token[i]}${tail})?`;
  return `${token.slice(0, min)}${tail}`;
}

// `(?:(?:(?:a)?b)?c)?defghijk`: the last `min` characters, with any more before.
function suffixSource(token, min) {
  let head = '';
  for (let i = 0; i < token.length - min; i += 1) head = `(?:${head}${token[i]})?`;
  return `${head}${token.slice(token.length - min)}`;
}

/**
 * Removes preview capabilities from every string of a JSON-like value. Returns
 * a copy; the input is untouched. Redacted are:
 * - each `test_<hex>` path segment with at least PREVIEW_REDACT_MIN_HEX hex
 *   characters, also with the `_` percent-encoded, wherever it stands: a
 *   whole link, one cut short, one glued to more hex;
 * - each occurrence of one of `tokens` (the relay's known previews: the
 *   preview tool's list output quotes them bare), or of its first
 *   PREVIEW_REDACT_MIN_HEX characters or more, wherever it stands;
 * - the end of one of `tokens`, of that length or more, at the start of a
 *   string (a link that runs across two strings).
 *
 * Ordinary text is hit only where `test_` is followed by eight or more hex
 * digits (`test_deadbeef`), or where it holds eight characters of a known
 * token by chance.
 */
export function redactPreviewTokens(value, { tokens = [] } = {}) {
  const bare = [...new Set((tokens || []).map(toText).filter((token) => isPreviewToken(token)))];
  // Every pattern here does a bounded amount of work per character, so the
  // pass is linear in the length of the text: it runs on a public route, on
  // whatever a transcript holds. In particular nothing looks back over a run
  // of whitespace; the start of a string is found by plain code.
  const startRe = bare.length > 0
    ? new RegExp(`(?:${bare.map((token) => suffixSource(token, PREVIEW_REDACT_MIN_HEX)).join('|')})`, 'iy')
    : null;
  const bareRe = bare.length > 0
    ? new RegExp(`(?:${bare.map((token) => prefixSource(token, PREVIEW_REDACT_MIN_HEX)).join('|')})`, 'gi')
    : null;
  const redactText = (text) => {
    let out = text.replace(PREVIEW_PATH_TOKEN_GLOBAL_RE, PREVIEW_TOKEN_REDACTION);
    if (!bareRe) return out;
    // The start of the string first: what is left of a link begun in another one.
    const start = out.search(/\S/);
    if (start !== -1) {
      startRe.lastIndex = start;
      const match = startRe.exec(out);
      if (match) out = `${out.slice(0, start)}${PREVIEW_TOKEN_REDACTION}${out.slice(start + match[0].length)}`;
    }
    return out.replace(bareRe, PREVIEW_TOKEN_REDACTION);
  };
  const walk = (node, depth) => {
    if (typeof node === 'string') return redactText(node);
    if (!node || typeof node !== 'object' || depth > 64) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (typeof node.toJSON === 'function') return walk(node.toJSON(), depth + 1);
    const out = {};
    for (const [key, item] of Object.entries(node)) out[key] = walk(item, depth + 1);
    return out;
  };
  return walk(value, 0);
}

/**
 * A short, stable name for a preview in logs: the token itself is the
 * capability, so it never goes into a log line.
 */
export function previewLogId(token) {
  return crypto.createHash('sha256').update(toText(token)).digest('hex').slice(0, 8);
}

// A row a restore could not judge is checked again on the health probe's beat
// for this long, then dropped: ten minutes outlast a busy database or a mount
// that comes up late, and a link nobody can check does not stay for ever.
const DEFAULT_KEPT_ROW_MAX_AGE_MS = 10 * 60_000;
// The shutdown flush waits this long on a locked database, not the driver's
// default: the runtime's force-exit timer is armed only after it.
const FLUSH_BUSY_TIMEOUT_MS = 250;

// Writes of `last_hit_at` are coalesced to one per preview per minute: a page
// load is dozens of requests, and the column only feeds the "last opened" line.
const DEFAULT_HIT_PERSIST_INTERVAL_MS = 60_000;

function sameTargetKey({ conversationId, mode, targetHost, targetPort, rootDir }) {
  const conv = toText(conversationId);
  return mode === 'static'
    ? JSON.stringify([conv, 'static', toText(rootDir)])
    : JSON.stringify([conv, 'port', normalizeHost(targetHost), Number(targetPort)]);
}

function formatAge(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/**
 * The live preview set. Kept in memory for the hot path and written through to
 * an injected store (the `previews` table), so a restarted runtime restores
 * every link it handed out. Nothing expires on its own: a preview ends when it
 * is closed, when its conversation is deleted, or when a restore finds it no
 * longer valid (folder gone or outside its workspace root, port preview from
 * an earlier host boot, conversation gone).
 *
 * A row a restore could not judge (a check threw, or answered with an fs
 * error rather than a "no") is kept apart: not served, but listed as
 * `unverified`, counted towards the limit, closable, and checked again by
 * recheckKeptRows until it is restored, refused, or too old.
 */
export function createPreviewRegistry({
  config,
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
  onChange = null,
  store = null,
  hostBootId = '',
  isSameHostBoot = (a, b) => !!toText(a) && toText(a) === toText(b),
  // (conversationId) => boolean: does the conversation still exist (not deleted)?
  checkConversation = null,
  // (rootDir, conversationId) => { ok, rootDir } | { ok:false, error, transient? }:
  // the registration-time jail, run again against the conversation's workspace
  // root. `transient` (an fs error, not a "no") keeps the row to be checked again.
  checkStaticRoot = null,
  hitPersistIntervalMs = DEFAULT_HIT_PERSIST_INTERVAL_MS,
  keptRowMaxAgeMs = DEFAULT_KEPT_ROW_MAX_AGE_MS,
  logger = console,
} = {}) {
  const entries = new Map();
  // token -> { row, since, reason }: stored rows no check could judge yet.
  const kept = new Map();
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
      lastHitAt: entry.lastHitAt ?? null,
      online: entry.online,
      lastSeenOnline: entry.lastSeenOnline,
      hits: entry.hits,
    };
  }

  function keptRecord({ row }) {
    const basePath = previewBasePath(row.token);
    return {
      token: row.token,
      conversationId: toText(row.conversationId) || null,
      label: toText(row.label).slice(0, 120) || 'preview',
      mode: row.mode,
      targetHost: row.targetHost ?? null,
      targetPort: row.targetPort ?? null,
      rootDir: row.rootDir ?? null,
      url: `${settings.publicBaseUrl}${basePath}`,
      basePath,
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
      lastHitAt: Number.isFinite(row.lastHitAt) ? row.lastHitAt : null,
      online: false,
      lastSeenOnline: null,
      hits: 0,
      // Not served until a check passes.
      unverified: true,
    };
  }

  function storeCall(name, ...args) {
    if (!store || typeof store[name] !== 'function') return undefined;
    try {
      return store[name](...args);
    } catch (error) {
      logger?.warn?.(`[preview] store ${name} failed: ${error?.message || error}`);
      return undefined;
    }
  }

  // Writes that threw (a locked or busy database) are kept here and retried by
  // retryPendingWrites — on the health probe's beat and at shutdown — so the
  // table converges with memory instead of bringing a closed link back, or
  // losing a live one, at the next start. Keyed by the stored token:
  // 'upsert' writes the live entry again, 'remove' deletes the row.
  //
  // One entry per token, and only for a token that is live or has a row: a
  // preview whose insert never landed leaves nothing behind when it is closed,
  // so cycles of create and close on a failing store do not grow the map.
  const pendingWrites = new Map();
  // Conversation ids whose rows are still to be deleted, each with the tokens
  // that were closed with it: those rows are still stored.
  const pendingConversationRemovals = new Map();

  // Counts the writes that threw, for passes that must stop at the first one.
  let storeWriteFailures = 0;

  // true when the write went through, or there is nothing to write to; false
  // when the store threw. Logs the first failure of a key only.
  function storeWrite(key, name, ...args) {
    if (!store || typeof store[name] !== 'function') return true;
    try {
      store[name](...args);
      return true;
    } catch (error) {
      storeWriteFailures += 1;
      if (!pendingWrites.has(key) && !pendingConversationRemovals.has(key)) {
        logger?.warn?.(`[preview] store ${name} failed, retried later: ${error?.message || error}`);
      }
      return false;
    }
  }

  // A failed write goes to the end of the line, so one that keeps failing
  // does not hold the others back.
  function setPending(token, op) {
    pendingWrites.delete(token);
    pendingWrites.set(token, op);
  }

  function upsertRow(entry) {
    const ok = storeWrite(entry.token, 'insert', { ...toPublicRecord(entry), hostBootId });
    if (ok) {
      entry.stored = true;
      pendingWrites.delete(entry.token);
    } else {
      setPending(entry.token, 'upsert');
    }
    return ok;
  }

  function removeRow(token) {
    const ok = storeWrite(token, 'remove', token);
    if (ok) pendingWrites.delete(token);
    else setPending(token, 'remove');
    return ok;
  }

  function liveTokensOfConversation(conversationId) {
    const tokens = [];
    for (const entry of entries.values()) {
      if (entry.conversationId === conversationId) tokens.push(entry.token);
    }
    for (const [token, held] of kept) {
      if (toText(held.row.conversationId) === conversationId) tokens.push(token);
    }
    return tokens;
  }

  // One pass over the failed writes, stopped at the first that fails again:
  // on a locked database every attempt blocks for the driver's timeout, and
  // the next one would only block again. -> how many are still pending.
  function retryPendingWrites() {
    const pendingCount = () => pendingWrites.size + pendingConversationRemovals.size;
    for (const [token, op] of [...pendingWrites]) {
      if (op === 'upsert') {
        const entry = entries.get(token);
        // Gone since without a close of its own: nothing is left to write.
        if (!entry) pendingWrites.delete(token);
        else if (!upsertRow(entry)) return pendingCount();
      } else if (!removeRow(token)) {
        return pendingCount();
      }
    }
    for (const [conversationId, closedTokens] of [...pendingConversationRemovals]) {
      // Only what was there when the delete was asked for: a preview
      // registered under the same conversation id since then is in memory, and
      // its row stays.
      const ok = storeWrite(conversationId, 'removeForConversation', conversationId, {
        exceptTokens: liveTokensOfConversation(conversationId),
      });
      if (!ok) {
        pendingConversationRemovals.delete(conversationId);
        pendingConversationRemovals.set(conversationId, closedTokens);
        return pendingCount();
      }
      pendingConversationRemovals.delete(conversationId);
    }
    return pendingCount();
  }

  function emitChange(reason, entry, record = entry ? toPublicRecord(entry) : null) {
    if (typeof onChange !== 'function') return;
    try {
      onChange({ reason, preview: record, previews: list() });
    } catch {}
  }

  function list() {
    return [
      ...[...entries.values()].map(toPublicRecord),
      ...[...kept.values()].map(keptRecord),
    ].sort((a, b) => a.createdAt - b.createdAt);
  }

  function listForConversation(conversationId) {
    const id = toText(conversationId);
    if (!id) return [];
    return list().filter((entry) => entry.conversationId === id);
  }

  function buildEntry(token, fields) {
    const basePath = previewBasePath(token);
    return {
      token,
      basePath,
      // Rebuilt from the current settings on every boot, so a changed public
      // address moves every restored link with it.
      url: `${settings.publicBaseUrl}${basePath}`,
      createdAt: now(),
      lastHitAt: null,
      persistedHitAt: null,
      hitWriteAt: null,
      lastSeenOnline: null,
      hits: 0,
      ...fields,
    };
  }

  function insertEntry(fields) {
    const token = createPreviewToken({ randomBytes });
    const entry = buildEntry(token, fields);
    entries.set(token, entry);
    upsertRow(entry);
    emitChange('created', entry);
    return { ok: true, preview: toPublicRecord(entry) };
  }

  function findSameTarget(fields) {
    const key = sameTargetKey(fields);
    for (const entry of entries.values()) {
      if (sameTargetKey(entry) === key) return entry;
    }
    return null;
  }

  function findKeptSameTarget(fields) {
    const key = sameTargetKey(fields);
    for (const held of kept.values()) {
      if (sameTargetKey(held.row) === key) return held;
    }
    return null;
  }

  // A registration of a kept row's target has just passed the target's own
  // checks (the folder jail, the port rules), so the row comes back under its
  // token, if its conversation still exists. Two rows do not come back and
  // are dropped: one whose conversation is gone, and a port row from an
  // earlier host boot, whose old link must not reach whatever listens on the
  // port now. -> the result of create, or null (go on as without the row).
  function reviveKept(held, fields) {
    const { row } = held;
    const conversationId = toText(row.conversationId);
    if (conversationId && typeof checkConversation === 'function') {
      let exists;
      try {
        exists = checkConversation(conversationId);
      } catch (error) {
        held.reason = `conversation check failed: ${errorText(error)}`;
        return {
          ok: false,
          status: 503,
          error: 'This preview is stored but could not be checked yet; try again in a moment.',
        };
      }
      if (!exists) {
        kept.delete(row.token);
        dropRow(row, 'its conversation no longer exists');
        return null;
      }
    }
    kept.delete(row.token);
    if (fields.mode === 'port' && !isSameHostBoot(row.hostBootId, hostBootId)) {
      dropRow(row, 'port preview from an earlier host boot');
      return null;
    }
    const entry = buildEntry(row.token, {
      ...fields,
      label: toText(row.label).slice(0, 120) || fields.label,
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt : now(),
      lastHitAt: Number.isFinite(row.lastHitAt) ? row.lastHitAt : null,
      persistedHitAt: Number.isFinite(row.lastHitAt) ? row.lastHitAt : null,
      stored: true,
    });
    entries.set(entry.token, entry);
    upsertRow(entry);
    emitChange('restored', entry);
    return { ok: true, existing: true, preview: toPublicRecord(entry) };
  }

  function describeTarget(entry) {
    if (entry.mode === 'static') {
      return `folder ${toText(entry.rootDir).split(/[\\/]/).filter(Boolean).pop() || entry.rootDir}`;
    }
    return `port ${entry.targetPort}`;
  }

  function tooManyError() {
    const at = now();
    const oldest = list()
      .slice(0, 3)
      .map((entry) => `"${entry.label}" (${describeTarget(entry)}, published ${formatAge(at - entry.createdAt)}, `
        + `${entry.lastHitAt ? `last opened ${formatAge(at - entry.lastHitAt)}` : 'never opened'})`);
    // More can be live than the limit (rows restored after it was lowered).
    const toClose = Math.max(1, entries.size + kept.size - settings.maxLive + 1);
    return {
      ok: false,
      status: 429,
      error: `Too many live previews (max ${settings.maxLive}); previews stay until closed. `
        + `Oldest: ${oldest.join('; ')}. Close ${toClose === 1 ? 'one' : toClose} in Settings → Previews, with the preview tool's `
        + `close action (list shows the tokens), or with DELETE /api/previews/:token.`,
    };
  }

  // A second create for the same conversation and the same target returns the
  // live preview instead of minting another token, so every link handed out
  // for that target stays one link.
  function createOrReuse(fields) {
    if (!settings.enabled) {
      return { ok: false, status: 503, error: 'Preview lane is disabled' };
    }
    const existing = findSameTarget(fields);
    if (existing) return { ok: true, existing: true, preview: toPublicRecord(existing) };
    const held = findKeptSameTarget(fields);
    const revived = held ? reviveKept(held, fields) : null;
    if (revived) return revived;
    // Kept rows count: each of them may be a live link again at any moment.
    if (entries.size + kept.size >= settings.maxLive) return tooManyError();
    return insertEntry(fields);
  }

  function create({ conversationId, port, host, label } = {}) {
    if (!settings.enabled) return { ok: false, status: 503, error: 'Preview lane is disabled' };
    const target = validatePreviewTarget({ host, port }, settings);
    if (!target.ok) return { ok: false, status: 400, error: target.error };

    return createOrReuse({
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
    if (!settings.enabled) return { ok: false, status: 503, error: 'Preview lane is disabled' };
    const root = toText(rootDir);
    if (!root) return { ok: false, status: 400, error: 'Missing rootDir' };

    return createOrReuse({
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

  // The throttle runs on the time of the last attempt, so a failing store is
  // not hammered once per request; a hit that did not get written is written
  // by the next attempt or by flushHits.
  // -> false when the write failed.
  function persistHit(entry, at = now()) {
    if (!entry.lastHitAt || entry.persistedHitAt === entry.lastHitAt) return true;
    entry.hitWriteAt = at;
    const hitAt = entry.lastHitAt;
    if (!storeWrite(`hit:${entry.token}`, 'touch', entry.token, hitAt)) return false;
    entry.persistedHitAt = hitAt;
    return true;
  }

  function recordHit(token, at = now()) {
    const entry = entries.get(toText(token));
    if (!entry) return;
    entry.hits += 1;
    entry.lastHitAt = at;
    if (entry.hitWriteAt === null || at - entry.hitWriteAt >= hitPersistIntervalMs) {
      persistHit(entry, at);
    }
  }

  // Writes the hits the throttle held back and retries failed writes; called
  // on shutdown, which it must not hold up: it gives up at the first write
  // that fails and waits only briefly on a locked database.
  function flushHits() {
    const flush = () => {
      if (retryPendingWrites() > 0) return;
      for (const entry of entries.values()) {
        if (!persistHit(entry)) return;
      }
    };
    if (typeof store?.withBusyTimeout === 'function') store.withBusyTimeout(FLUSH_BUSY_TIMEOUT_MS, flush);
    else flush();
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
    if (!entry) {
      const held = kept.get(toText(token));
      if (!held) return { ok: false, status: 404, error: 'Unknown preview' };
      const record = keptRecord(held);
      kept.delete(record.token);
      removeRow(record.token);
      emitChange('closed', null, record);
      return { ok: true, preview: record };
    }
    entries.delete(entry.token);
    // A row that never reached the store needs no delete.
    if (entry.stored) removeRow(entry.token);
    else pendingWrites.delete(entry.token);
    emitChange('closed', entry);
    return { ok: true, preview: toPublicRecord(entry) };
  }

  function closeForConversation(conversationId) {
    const id = toText(conversationId);
    if (!id) return 0;
    let closed = 0;
    const closedTokens = new Set(pendingConversationRemovals.get(id) || []);
    for (const entry of [...entries.values()]) {
      if (entry.conversationId !== id) continue;
      entries.delete(entry.token);
      // Covered by the conversation-wide delete below (or its retry).
      pendingWrites.delete(entry.token);
      closedTokens.add(entry.token);
      closed += 1;
    }
    for (const [token, held] of [...kept]) {
      if (toText(held.row.conversationId) !== id) continue;
      kept.delete(token);
      pendingWrites.delete(token);
      closedTokens.add(token);
      closed += 1;
    }
    // Also rows this runtime never loaded (lane off at boot).
    if (storeWrite(id, 'removeForConversation', id)) pendingConversationRemovals.delete(id);
    else pendingConversationRemovals.set(id, closedTokens);
    if (closed > 0) emitChange('closed', null);
    return closed;
  }

  // Drops the in-memory set only; the stored rows stay. Not part of shutdown
  // any more: a restart restores the set from the store.
  function clear() {
    const had = entries.size + kept.size > 0;
    entries.clear();
    kept.clear();
    if (had) emitChange('cleared', null);
  }

  function dropRow(row, reason) {
    removeRow(row.token);
    logger?.warn?.(`[preview] not restored ${previewLogId(row.token)} "${toText(row.label)}": ${reason}`);
    return { outcome: 'dropped' };
  }

  // A check that threw, or answered with an fs error rather than a "no",
  // proves nothing about the row: it stays, unserved, and is checked again.
  // Logged once, not on every check.
  function skipRow(row, reason) {
    const held = kept.get(row?.token);
    if (held) {
      held.reason = reason;
      return { outcome: 'skipped' };
    }
    logger?.warn?.(`[preview] not restored ${previewLogId(row?.token)} "${toText(row?.label)}", `
      + `kept and checked again: ${reason}`);
    if (typeof row?.token === 'string' && row.token === toText(row.token) && isPreviewToken(row.token)) {
      kept.set(row.token, { row, since: now(), reason });
    }
    return { outcome: 'skipped' };
  }

  function errorText(error) {
    return error?.message || String(error);
  }

  // -> { outcome: 'restored' | 'dropped' | 'skipped' | 'present' }
  function restoreRow(row) {
    // Only the canonical form is ever written; a row in another form (hand
    // written, upper case) is deleted by the value it is stored under.
    if (typeof row.token !== 'string' || row.token !== toText(row.token) || !isPreviewToken(row.token)) {
      return dropRow(row, 'invalid token');
    }
    if (entries.has(row.token)) return { outcome: 'present' };
    const conversationId = toText(row.conversationId) || null;
    if (conversationId && typeof checkConversation === 'function') {
      let exists;
      try {
        exists = checkConversation(conversationId);
      } catch (error) {
        return skipRow(row, `conversation check failed: ${errorText(error)}`);
      }
      if (!exists) return dropRow(row, 'its conversation no longer exists');
    }
    let fields;
    let rewrite = false;
    if (row.mode === 'static') {
      let rootDir = toText(row.rootDir);
      if (!rootDir) return dropRow(row, 'no folder');
      if (typeof checkStaticRoot === 'function') {
        let checked;
        try {
          checked = checkStaticRoot(rootDir, conversationId);
        } catch (error) {
          return skipRow(row, `folder check failed: ${errorText(error)}`);
        }
        if (!checked?.ok && checked?.transient) return skipRow(row, checked.error || 'folder check failed');
        if (!checked?.ok) return dropRow(row, checked?.error || 'folder refused');
        if (checked.rootDir && checked.rootDir !== rootDir) {
          rootDir = checked.rootDir;
          rewrite = true;
        }
      }
      fields = { mode: 'static', targetHost: null, targetPort: null, rootDir, online: true };
    } else if (row.mode === 'port') {
      if (!isSameHostBoot(row.hostBootId, hostBootId)) {
        return dropRow(row, 'port preview from an earlier host boot');
      }
      const target = validatePreviewTarget({ host: row.targetHost, port: row.targetPort }, settings);
      if (!target.ok) return dropRow(row, target.error);
      fields = { mode: 'port', targetHost: target.host, targetPort: target.port, rootDir: null, online: null };
      // An uptime-based id matches within a tolerance; storing the current one
      // keeps clock drift from adding up across restarts.
      rewrite = toText(row.hostBootId) !== toText(hostBootId);
    } else {
      return dropRow(row, 'unknown mode');
    }
    const entry = buildEntry(row.token, {
      ...fields,
      conversationId,
      label: toText(row.label).slice(0, 120) || (fields.mode === 'static' ? 'static preview' : `localhost:${fields.targetPort}`),
      createdAt: Number.isFinite(row.createdAt) ? row.createdAt : now(),
      lastHitAt: Number.isFinite(row.lastHitAt) ? row.lastHitAt : null,
      persistedHitAt: Number.isFinite(row.lastHitAt) ? row.lastHitAt : null,
      stored: true,
    });
    entries.set(entry.token, entry);
    if (rewrite) upsertRow(entry);
    return { outcome: 'restored' };
  }

  // Checks the kept rows again; called on the health probe's beat, so a
  // failure that passes heals without a restart. A row is restored, dropped
  // by the answer of its check, or, when it has stayed unjudgeable for
  // keptRowMaxAgeMs, dropped and logged. Anything that may have blocked for
  // a database timeout ends the pass: a row that still cannot be judged (it
  // moves to the end of the line), or a write that failed. A row past the
  // bound is not deleted here but left to the next retry of pending writes,
  // so a pass waits once at most.
  // -> how many rows are still kept.
  function recheckKeptRows() {
    if (!settings.enabled || kept.size === 0) return kept.size;
    let changed = false;
    const failuresBefore = storeWriteFailures;
    for (const [token, held] of [...kept]) {
      if (storeWriteFailures !== failuresBefore) break;
      let result;
      try {
        result = restoreRow(held.row);
      } catch (error) {
        result = skipRow(held.row, `restore failed: ${errorText(error)}`);
      }
      if (result.outcome !== 'skipped') {
        kept.delete(token);
        changed = true;
        if (result.outcome === 'restored') {
          logger?.log?.(`[preview] restored ${previewLogId(token)} "${toText(held.row.label)}" on a later check`);
        }
        continue;
      }
      kept.delete(token);
      if (now() - held.since >= keptRowMaxAgeMs) {
        setPending(token, 'remove');
        changed = true;
        logger?.warn?.(`[preview] dropped ${previewLogId(token)} "${toText(held.row.label)}": `
          + `could not be checked for ${Math.round(keptRowMaxAgeMs / 60_000)} min (${held.reason})`);
      } else {
        kept.set(token, held);
      }
      break;
    }
    if (changed) emitChange('rechecked', null);
    return kept.size;
  }

  // The store's upkeep on the health probe's beat: failed writes first, and
  // the kept rows only when none of them failed again, so that a sweep on a
  // locked database waits for one timeout and not for one per step.
  function maintain() {
    const failuresBefore = storeWriteFailures;
    retryPendingWrites();
    if (storeWriteFailures === failuresBefore) recheckKeptRows();
  }

  // The stored tokens as last read while the lane is off; null until a read
  // went through.
  let storedTokens = null;
  let storedTokensReadFailed = false;

  // Every token that is or may again become a working link, for the redaction
  // of shared transcripts:
  // - live and kept previews;
  // - rows that are still stored because their delete has not landed yet (a
  //   closed preview, a deleted conversation, a kept row past its bound): a
  //   crash before the delete lands brings them back;
  // - with the lane off (nothing loaded), the stored rows. A read that fails
  //   there is never taken for "no tokens": the last list that was read
  //   stays in use, and without one this throws, so the caller shares nothing
  //   rather than a transcript it could not redact.
  function knownTokens() {
    const tokens = new Set([...entries.keys(), ...kept.keys()]);
    for (const [token, op] of pendingWrites) {
      if (op === 'remove') tokens.add(token);
    }
    for (const closedTokens of pendingConversationRemovals.values()) {
      for (const token of closedTokens) tokens.add(token);
    }
    if (!settings.enabled && store && typeof store.list === 'function') {
      try {
        const rows = store.list() || [];
        storedTokens = rows.map((row) => toText(row?.token)).filter((token) => isPreviewToken(token));
        storedTokensReadFailed = false;
      } catch (error) {
        if (!storedTokensReadFailed) {
          logger?.warn?.(`[preview] stored previews could not be read for redaction, `
            + `${storedTokens ? 'the last list stays in use' : 'none was read yet'}: ${errorText(error)}`);
        }
        storedTokensReadFailed = true;
        if (!storedTokens) throw new Error('The stored previews could not be read');
      }
      for (const token of storedTokens) tokens.add(token);
    }
    return [...tokens];
  }

  // Restores the stored set. With the lane off nothing is loaded or served and
  // the rows stay untouched for the next boot that has it on.
  function restore() {
    if (!settings.enabled || !store) return { restored: 0, dropped: 0, skipped: 0 };
    const rows = storeCall('list') || [];
    const counts = { restored: 0, dropped: 0, skipped: 0 };
    for (const row of rows) {
      let result;
      try {
        result = restoreRow(row);
      } catch (error) {
        result = skipRow(row, `restore failed: ${errorText(error)}`);
      }
      if (counts[result.outcome] !== undefined) counts[result.outcome] += 1;
    }
    if (rows.length > 0) {
      logger?.log?.(`[preview] restored ${counts.restored} preview(s)`
        + `${counts.dropped ? `, dropped ${counts.dropped}` : ''}`
        + `${counts.skipped ? `, kept ${counts.skipped} to check again` : ''}`);
    }
    return counts;
  }

  restore();

  return {
    settings,
    get size() { return entries.size; },
    get keptCount() { return kept.size; },
    create,
    createStatic,
    resolve,
    recordHit,
    flushHits,
    retryPendingWrites,
    recheckKeptRows,
    maintain,
    knownTokens,
    get pendingWriteCount() { return pendingWrites.size + pendingConversationRemovals.size; },
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
