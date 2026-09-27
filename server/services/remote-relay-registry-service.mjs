'use strict';

import { randomUUID as nodeRandomUUID } from 'crypto';

import {
  REMOTE_RELAY_LIMITS,
  REMOTE_RELAY_PERMISSIONS,
  REMOTE_RELAY_PROTOCOL,
  REMOTE_RELAY_SETTING_KEYS,
  REMOTE_RELAY_SOCKET_EVENT,
  REMOTE_RELAY_ERROR_CODES,
  checkRemoteRelayUrlPolicy,
  normalizeRemoteRelayLink,
  normalizeRemoteRelayPermission,
} from '../../shared/remote-relay-contract.mjs';
import { remoteRelayAliases } from '../../shared/remote-relay-mentions.mjs';

// The list of OTHER OAR relays this relay is paired with, and this relay's own
// identity towards them (plan §4, §5.1, §5.2). Everything lives in
// app_settings as JSON values, so there is no table to migrate:
//
//   relay_instance_id            this relay's stable id ("is that myself?")
//   remote_relays                the entries, tokens included
//   relay_public_url             how other relays reach this one
//   remote_relay_inbound_enabled accept prompts from other relays' agents
//
// Tokens never leave through listPublic(), the socket event or any route; only
// the outbound client reads them (list()/get()/resolve() are server-internal).
//
// A health loop re-reads every remote's identity once a minute, so status,
// version and renames propagate. Unlocks are keyed by the entry `id`, which
// never changes, so a renamed remote keeps them.

export const REMOTE_RELAY_STATUSES = Object.freeze(['unknown', 'online', 'offline', 'unauthorized', 'error']);

// Plan §5.2: the periodic identity check gets a shorter budget than a tool call.
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
// Cloudflare and reverse-proxy answers that mean "the relay behind me is down".
const GATEWAY_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]);
const LAST_ERROR_MAX = 300;

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

function capOrNull(value, max) {
  const text = toText(value);
  return text ? text.slice(0, max) : null;
}

function statusForError(error) {
  if (error?.code === REMOTE_RELAY_ERROR_CODES.offline) return 'offline';
  if (error?.code === REMOTE_RELAY_ERROR_CODES.unauthorized) return 'unauthorized';
  if (GATEWAY_STATUSES.has(Number(error?.status))) return 'offline';
  return 'error';
}

// lastError is shown on the relay's own row, and a probe does not know the
// relay's name (its message says `Relay "<host>" is not reachable …`): keep
// only the predicate, "Not reachable (ECONNREFUSED)".
function describeFailure(error) {
  const text = toText(error?.message || error);
  const predicate = text.replace(/^(?:Relay "[^"]*"|The remote relay)\s+/, '');
  if (predicate === text) return text;
  return predicate.replace(/^is\s+/, '').replace(/^\S/, (first) => first.toUpperCase());
}

/** A stored entry, defensively normalised (the setting may have been hand-edited). */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = toText(raw.id);
  const url = toText(raw.url).replace(/\/+$/, '');
  if (!id || !url) return null;
  const token = toText(raw.token);
  const tokenMode = raw.tokenMode === 'custom' && token ? 'custom' : 'own';
  const protocol = Number(raw.protocol);
  return {
    id,
    relayId: capOrNull(raw.relayId, 100),
    name: capOrNull(raw.name, 60) || hostOf(url) || id,
    url,
    tokenMode,
    ...(tokenMode === 'custom' ? { token } : {}),
    permission: normalizeRemoteRelayPermission(raw.permission),
    addedBy: raw.addedBy === 'pairing' ? 'pairing' : 'user',
    addedAt: capOrNull(raw.addedAt, 40),
    version: capOrNull(raw.version, 40),
    platform: capOrNull(raw.platform, 20),
    lastSeenAt: capOrNull(raw.lastSeenAt, 40),
    lastStatus: REMOTE_RELAY_STATUSES.includes(raw.lastStatus) ? raw.lastStatus : 'unknown',
    lastError: capOrNull(raw.lastError, LAST_ERROR_MAX),
    protocol: Number.isInteger(protocol) && protocol >= 0 ? protocol : 0,
  };
}

/** The shape any API or socket payload may carry: no token, plus display helpers. */
function toPublic(entry) {
  if (!entry) return null;
  const { token: _token, ...rest } = entry;
  const policy = checkRemoteRelayUrlPolicy(entry.url);
  return {
    ...rest,
    host: hostOf(entry.url),
    httpWarning: policy.ok ? policy.warning || null : policy.error,
  };
}

/** Change detection ignores lastSeenAt: a healthy remote must not emit every minute. */
function fingerprint(entry) {
  if (!entry) return '';
  const { lastSeenAt: _seen, ...rest } = entry;
  return JSON.stringify(rest);
}

function invalid(error, status = 400) {
  return { ok: false, status, error };
}

export function createRemoteRelayRegistry({
  readSetting,
  writeSetting,
  client,
  repository = null,
  // getOwnToken is accepted for symmetry with the client; the client owns
  // token selection (tokenFor), so the registry never reads a token itself.
  getSelfName = () => '',
  hostname = '',
  platform = '',
  version = '',
  now = () => new Date(),
  emit = () => {},
  logger = console,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  randomUUID = nodeRandomUUID,
} = {}) {
  let cachedInstanceId = '';
  let healthTimer = null;
  let sweeping = null;

  function nowIso() {
    return now().toISOString();
  }

  /** app_settings values are JSON; a bare legacy string still reads as itself. */
  function readJsonSetting(key) {
    const raw = toText(readSetting(key));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function writeJsonSetting(key, value) {
    writeSetting(key, JSON.stringify(value));
  }

  function readList() {
    const stored = readJsonSetting(REMOTE_RELAY_SETTING_KEYS.relays);
    if (!Array.isArray(stored)) return [];
    const seen = new Set();
    const entries = [];
    for (const raw of stored) {
      const entry = normalizeEntry(raw);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
    return entries;
  }

  function writeList(entries) {
    writeJsonSetting(REMOTE_RELAY_SETTING_KEYS.relays, entries);
  }

  // ─── This relay ────────────────────────────────────────────────────────────

  function instanceId() {
    if (cachedInstanceId) return cachedInstanceId;
    const stored = toText(readJsonSetting(REMOTE_RELAY_SETTING_KEYS.instanceId));
    if (stored) {
      cachedInstanceId = stored;
      return stored;
    }
    const created = String(randomUUID());
    writeJsonSetting(REMOTE_RELAY_SETTING_KEYS.instanceId, created);
    cachedInstanceId = created;
    return created;
  }

  function selfName() {
    return toText(getSelfName?.()) || toText(hostname) || 'OAR';
  }

  function getSelfSettings() {
    const publicUrl = toText(readJsonSetting(REMOTE_RELAY_SETTING_KEYS.publicUrl));
    const inbound = readJsonSetting(REMOTE_RELAY_SETTING_KEYS.inboundEnabled);
    const disabled = inbound === false || inbound === 0 || ['false', '0', 'off'].includes(toText(inbound).toLowerCase());
    return { publicUrl, inboundEnabled: !disabled };
  }

  function selfIdentity() {
    const settings = getSelfSettings();
    return {
      relayId: instanceId(),
      name: selfName(),
      version: toText(version) || null,
      platform: toText(platform) || null,
      publicUrl: settings.publicUrl || null,
      remoteRelays: { protocol: REMOTE_RELAY_PROTOCOL, inbound: settings.inboundEnabled },
    };
  }

  function selfPayload() {
    return { ...selfIdentity(), ...getSelfSettings() };
  }

  function emitChange() {
    try {
      emit(REMOTE_RELAY_SOCKET_EVENT, { relays: listPublic(), self: selfPayload() });
    } catch (error) {
      logger?.warn?.(`[remote-relays] update event failed: ${error?.message || error}`);
    }
  }

  /**
   * `{ publicUrl?, inboundEnabled? }`. The public URL is stored as a bare
   * base URL (a pasted ?token= is dropped: this address is handed to other
   * relays); an empty string clears it.
   */
  function setSelfSettings(patch = {}) {
    const input = patch && typeof patch === 'object' ? patch : {};
    let nextPublicUrl;
    if (input.publicUrl !== undefined) {
      const raw = toText(input.publicUrl);
      if (!raw) {
        nextPublicUrl = '';
      } else {
        const link = normalizeRemoteRelayLink(raw);
        if (!link.ok) return invalid(link.error);
        nextPublicUrl = link.baseUrl;
      }
    }
    if (input.inboundEnabled !== undefined && typeof input.inboundEnabled !== 'boolean') {
      return invalid('inboundEnabled must be true or false');
    }
    if (nextPublicUrl !== undefined) writeJsonSetting(REMOTE_RELAY_SETTING_KEYS.publicUrl, nextPublicUrl);
    if (input.inboundEnabled !== undefined) writeJsonSetting(REMOTE_RELAY_SETTING_KEYS.inboundEnabled, input.inboundEnabled);
    emitChange();
    return { ok: true, ...getSelfSettings() };
  }

  // ─── Remote relays ─────────────────────────────────────────────────────────

  function list() {
    return readList();
  }

  function listPublic() {
    return readList().map(toPublic);
  }

  function get(id) {
    const key = toText(id);
    if (!key) return null;
    return readList().find((entry) => entry.id === key) || null;
  }

  /**
   * `{ relay }` for a unique case-insensitive match on a name or URL host (a
   * leading @ and a pasted URL are accepted), else `{ error, names }`. Unlike
   * a chat mention, an agent naming a relay may use a loopback or IP host too.
   */
  function resolve(nameOrAlias) {
    const entries = readList();
    let query = toText(nameOrAlias).replace(/^@/, '').toLowerCase();
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(query)) query = hostOf(query);
    const matches = query
      ? entries.filter((entry) => remoteRelayAliases(entry).includes(query) || hostOf(entry.url) === query)
      : [];
    if (matches.length === 1) return { relay: matches[0] };
    if (matches.length > 1) return { error: 'ambiguous', names: matches.map((entry) => entry.name) };
    return { error: 'unknown', names: entries.map((entry) => entry.name) };
  }

  /** Adds a validated entry (pairing does the probing and deduplication). */
  function add(input = {}) {
    const url = toText(input.url).replace(/\/+$/, '');
    const policy = checkRemoteRelayUrlPolicy(url);
    if (!url || !policy.ok) {
      const error = new Error(policy.error || 'A remote relay needs a URL');
      error.status = 400;
      throw error;
    }
    const token = toText(input.token);
    const tokenMode = token && (input.tokenMode === 'custom' || input.tokenMode === undefined) ? 'custom' : 'own';
    const entry = normalizeEntry({
      relayId: input.relayId,
      name: input.name,
      version: input.version,
      platform: input.platform,
      protocol: input.protocol,
      lastSeenAt: input.lastSeenAt,
      lastStatus: input.lastStatus,
      lastError: input.lastError,
      id: `rr_${randomUUID()}`,
      url,
      tokenMode,
      token,
      permission: input.permission,
      addedBy: input.addedBy,
      addedAt: nowIso(),
    });
    writeList([...readList(), entry]);
    emitChange();
    return entry;
  }

  /**
   * Internal read-modify-write by id. `fields` are merged over the stored
   * entry; a `token: undefined` field removes the token. Returns
   * `{ before, after }` (null when the entry is gone, e.g. removed while a
   * probe was in flight).
   */
  function patchStored(id, fields) {
    const entries = readList();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    const before = entries[index];
    const merged = { ...before, ...fields };
    if (Object.prototype.hasOwnProperty.call(fields, 'token') && fields.token === undefined) delete merged.token;
    const after = normalizeEntry(merged);
    entries[index] = after;
    writeList(entries);
    return { before, after };
  }

  /** User edits: `{ permission, url, token, tokenMode }` (PATCH /api/remote-relays/:id). */
  function update(id, patch = {}) {
    const current = get(id);
    if (!current) return invalid('Unknown remote relay', 404);
    const input = patch && typeof patch === 'object' ? patch : {};
    const fields = {};

    if (input.permission !== undefined) {
      const permission = toText(input.permission).toLowerCase();
      if (!REMOTE_RELAY_PERMISSIONS.includes(permission)) {
        return invalid(`permission must be one of: ${REMOTE_RELAY_PERMISSIONS.join(', ')}`);
      }
      fields.permission = normalizeRemoteRelayPermission(permission);
    }

    if (input.url !== undefined) {
      const link = normalizeRemoteRelayLink(input.url);
      if (!link.ok) return invalid(link.error);
      if (link.baseUrl !== current.url) {
        fields.url = link.baseUrl;
        fields.lastStatus = 'unknown';
        fields.lastError = null;
      }
    }

    if (input.tokenMode !== undefined && !['own', 'custom'].includes(input.tokenMode)) {
      return invalid('tokenMode must be own or custom');
    }
    if (input.token !== undefined || input.tokenMode !== undefined) {
      const token = input.token !== undefined ? toText(input.token) : toText(current.token);
      const tokenMode = input.tokenMode !== undefined ? input.tokenMode : (token ? 'custom' : 'own');
      if (tokenMode === 'custom' && !token) return invalid('A custom token cannot be empty');
      const nextToken = tokenMode === 'custom' ? token : undefined;
      if (tokenMode !== current.tokenMode || nextToken !== current.token) {
        fields.tokenMode = tokenMode;
        fields.token = nextToken;
        fields.lastStatus = 'unknown';
        fields.lastError = null;
      }
    }

    const result = Object.keys(fields).length ? patchStored(current.id, fields) : { before: current, after: current };
    if (!result) return invalid('Unknown remote relay', 404);
    if (fingerprint(result.before) !== fingerprint(result.after)) emitChange();
    return { ok: true, relay: toPublic(result.after) };
  }

  /** Local only: the other side keeps its own entry for this relay. */
  function remove(id) {
    const key = toText(id);
    const entries = readList();
    const remaining = entries.filter((entry) => entry.id !== key);
    if (!key || remaining.length === entries.length) return invalid('Unknown remote relay', 404);
    writeList(remaining);
    try {
      repository?.forgetRelay?.(key);
    } catch (error) {
      logger?.warn?.(`[remote-relays] forgetting unlocks failed: ${error?.message || error}`);
    }
    emitChange();
    return { ok: true };
  }

  function findByUrl(entries, url) {
    const target = toText(url).replace(/\/+$/, '').toLowerCase();
    return target ? entries.find((entry) => entry.url.toLowerCase() === target) || null : null;
  }

  /**
   * The inbound side of pairing: another relay introduced itself. Deduplicated
   * by relayId, else by URL. For a new entry a token means "use this one for
   * me"; none means our own token works there too. A known entry keeps the
   * address and token stored here (the user set them, or saw them set): an
   * introduction only refreshes what the relay says about itself, and a
   * different address or token it offers is logged, not taken.
   */
  function upsertFromPairing({ relayId, name, url, token, version: offeredVersion, platform: offeredPlatform, protocol } = {}) {
    const entries = readList();
    const id = toText(relayId);
    const baseUrl = toText(url).replace(/\/+$/, '');
    const existing = (id && entries.find((entry) => entry.relayId === id)) || findByUrl(entries, baseUrl);
    const secret = toText(token);
    const selfDescription = {
      ...(toText(name) ? { name } : {}),
      ...(toText(offeredVersion) ? { version: offeredVersion } : {}),
      ...(toText(offeredPlatform) ? { platform: offeredPlatform } : {}),
      ...(Number.isInteger(protocol) && protocol >= 0 ? { protocol } : {}),
    };
    if (existing) {
      const offeredOtherUrl = !!baseUrl && baseUrl.toLowerCase() !== existing.url.toLowerCase();
      const offeredOtherToken = secret
        ? existing.tokenMode !== 'custom' || secret !== existing.token
        : existing.tokenMode === 'custom';
      if (offeredOtherUrl || offeredOtherToken) {
        const changes = [
          offeredOtherUrl ? `address ${baseUrl} (kept ${existing.url})` : '',
          offeredOtherToken ? 'token (kept the stored one)' : '',
        ].filter(Boolean).join(' and a different ');
        const label = (toText(name) || existing.name).replace(/[\r\n"]+/g, ' ');
        try {
          logger?.warn?.(`[remote-relays] pairing from "${label}" offered a different ${changes}; change it in Settings → Relays if that is right`);
        } catch {}
      }
      const result = patchStored(existing.id, { relayId: id || existing.relayId, ...selfDescription });
      if (result && fingerprint(result.before) !== fingerprint(result.after)) emitChange();
      return result?.after || existing;
    }
    const tokenFields = secret ? { tokenMode: 'custom', token: secret } : { tokenMode: 'own' };
    return add({
      ...selfDescription,
      relayId: id,
      name: toText(name) || hostOf(baseUrl),
      url: baseUrl,
      ...tokenFields,
      addedBy: 'pairing',
    });
  }

  /** Stores what a successful probe said. Returns `{ changed, relay }` (full entry). */
  function applyIdentity(id, identity, { emitOnChange = true } = {}) {
    let fields;
    if (identity?.relayId && identity.relayId === instanceId()) {
      // An address that turns out to be this relay itself must not look healthy.
      fields = { lastStatus: 'error', lastError: 'This address points at this relay itself' };
    } else {
      fields = { lastStatus: 'online', lastSeenAt: nowIso(), lastError: null };
      if (identity?.relayId) fields.relayId = identity.relayId;
      if (toText(identity?.name)) fields.name = identity.name;
      if (identity?.version) fields.version = identity.version;
      if (identity?.platform) fields.platform = identity.platform;
      if (Number.isInteger(identity?.protocol)) fields.protocol = identity.protocol;
    }
    const result = patchStored(id, fields);
    if (!result) return { changed: false, relay: null };
    const changed = fingerprint(result.before) !== fingerprint(result.after);
    if (changed && emitOnChange) emitChange();
    return { changed, relay: result.after };
  }

  /** Public for pairing: the probe it already made counts as a check. */
  function recordIdentity(id, identity) {
    return applyIdentity(id, identity).relay;
  }

  function applyFailure(id, error, { emitOnChange = true } = {}) {
    const result = patchStored(id, {
      lastStatus: statusForError(error),
      lastError: describeFailure(error).slice(0, LAST_ERROR_MAX) || 'Check failed',
    });
    if (!result) return { changed: false, relay: null };
    const changed = fingerprint(result.before) !== fingerprint(result.after);
    if (changed && emitOnChange) emitChange();
    return { changed, relay: result.after };
  }

  async function checkEntry(id, { timeoutMs, emitOnChange = true } = {}) {
    const entry = get(id);
    if (!entry) return { changed: false, relay: null };
    try {
      const identity = await client.probe(entry.url, client.tokenFor(entry), { timeoutMs });
      return applyIdentity(entry.id, identity, { emitOnChange });
    } catch (error) {
      return applyFailure(entry.id, error, { emitOnChange });
    }
  }

  /** Probes one remote now; the public entry, or null for an unknown id. */
  async function check(id, { timeoutMs } = {}) {
    const { relay } = await checkEntry(toText(id), { timeoutMs });
    return toPublic(relay);
  }

  /** One pass over every remote; a single event when anything changed. */
  function checkAll() {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const ids = readList().map((entry) => entry.id);
      if (ids.length === 0) return false;
      const results = await Promise.all(ids.map((id) => checkEntry(id, {
        timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
        emitOnChange: false,
      }).catch(() => ({ changed: false }))));
      const changed = results.some((result) => result?.changed);
      if (changed) emitChange();
      return changed;
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  function startHealthLoop({ immediate = true } = {}) {
    if (healthTimer) return;
    healthTimer = setIntervalImpl(() => {
      checkAll().catch((error) => logger?.warn?.(`[remote-relays] health check failed: ${error?.message || error}`));
    }, REMOTE_RELAY_LIMITS.healthIntervalMs);
    // An idle relay must not be held awake by the health loop.
    if (typeof healthTimer?.unref === 'function') healthTimer.unref();
    if (immediate) void checkAll().catch(() => {});
  }

  function stopHealthLoop() {
    if (!healthTimer) return;
    clearIntervalImpl(healthTimer);
    healthTimer = null;
  }

  function tokenFor(relay) {
    return client.tokenFor(relay);
  }

  return {
    instanceId,
    selfName,
    selfIdentity,
    getSelfSettings,
    setSelfSettings,
    list,
    listPublic,
    get,
    resolve,
    add,
    update,
    remove,
    upsertFromPairing,
    recordIdentity,
    check,
    checkAll,
    startHealthLoop,
    stopHealthLoop,
    tokenFor,
    get healthLoopRunning() { return Boolean(healthTimer); },
  };
}
