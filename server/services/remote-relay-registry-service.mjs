'use strict';

import { randomUUID as nodeRandomUUID } from 'crypto';

import {
  AGENT_SESSIONS_SOCKET_EVENT,
  REMOTE_RELAY_LIMITS,
  REMOTE_RELAY_PERMISSIONS,
  REMOTE_RELAY_PROTOCOL,
  REMOTE_RELAY_SETTING_KEYS,
  REMOTE_RELAY_SOCKET_EVENT,
  REMOTE_RELAY_ERROR_CODES,
  checkRemoteRelayUrlPolicy,
  normalizeRemoteRelayLink,
  normalizeRemoteRelayMaxWaitSeconds,
  normalizeRemoteRelayPermission,
} from '../../shared/remote-relay-contract.mjs';
import { remoteRelayAliases } from '../../shared/remote-relay-mentions.mjs';
import { normalizePeerKeyFields } from './remote-relay-peer-keys.mjs';

// The list of OTHER OAR relays this relay is paired with, and this relay's own
// identity towards them (plan §4, §5.1, §5.2). Everything lives in
// app_settings as JSON values, so there is no table to migrate:
//
//   relay_instance_id            this relay's stable id ("is that myself?")
//   remote_relays                the entries, tokens included
//   relay_public_url             how other relays reach this one
//   remote_relay_inbound_enabled accept prompts from other relays' agents
//   agent_sessions_enabled       this relay's own agents may start and use
//                                sessions on it (the local target; off by default)
//   remote_relay_max_wait_seconds the longest wait of one relay_tool call
//
// Tokens never leave through listPublic(), the socket event or any route; only
// the outbound client reads them (list()/get()/resolve() are server-internal).
// The same holds for peer keys (remote-relay-peer-keys.mjs): the key a paired
// relay gave this one (`peerToken`) and the hashes of the keys this relay gave
// it (`peerKeys`) stay in the stored entry.
//
// A health loop re-reads every remote's identity once a minute, so status,
// version and renames propagate. Unlocks are keyed by the entry `id`, which
// never changes, so a renamed remote keeps them.
//
// Inbound-only entries (`inboundOnly: true`): a relay that added this one one
// way holds a key this relay minted for it (POST …/peer-key/inbound). Such an
// entry has no address: this relay never calls it (no health probe, no key
// delivery, no agent target, no mention), so list(), resolve() and
// listPublic() leave it out; get() and listAll() see it (the key index, the
// refusal notices, Remove). listInboundPublic() is its row in Settings →
// Relays. When this relay adds that relay too, the entry becomes a normal
// one in place (adoptInboundHolder).

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

// How an entry calls its relay:
//   custom  with the token stored for it;
//   peer    with the key that relay gave this one (the token held for it
//           was dropped once the key worked, or none was ever stored: one
//           way with an inbound-only key); without a key it reads as none;
//   none    with no token (a pairing that gave us none, an inbound-only
//           entry, which is never called);
//   own     from before the owner token moved out of the config: "this
//           relay's own token". Never made any more; the boot that moves the
//           token out (bootChange 'migrated') turns these into `custom`.
// The relay's own owner token is never sent: own and none send nothing.
export const REMOTE_RELAY_TOKEN_MODES = Object.freeze(['custom', 'peer', 'none', 'own']);

// What an older OAR (0.9.26 and before) makes of a stored entry: anything
// but "custom with a token" reads as `own`, and `own` sends that relay's
// owner token on every call and every health probe. So an entry that sends
// no owner token (`peer`, `none`) is stored as `custom` with this fixed,
// non-secret placeholder in `token` and its real mode in `credential`. An
// older OAR sends the placeholder (the other relay answers 401) and never
// its owner token; this version reads the placeholder as no credential.
export const REMOTE_RELAY_NO_CREDENTIAL_TOKEN = 'oar-no-credential';

/** The entry as written to app_settings (see REMOTE_RELAY_NO_CREDENTIAL_TOKEN). */
export function toStoredRemoteRelayEntry(entry) {
  if (!entry || (entry.tokenMode !== 'peer' && entry.tokenMode !== 'none')) return entry;
  const { token: _token, ...rest } = entry;
  return { ...rest, tokenMode: 'custom', token: REMOTE_RELAY_NO_CREDENTIAL_TOKEN, credential: entry.tokenMode };
}

/** A stored entry's real mode and token, the placeholder read as no credential. */
function readStoredCredential(raw) {
  const token = toText(raw.token);
  if (raw.tokenMode === 'custom' && token === REMOTE_RELAY_NO_CREDENTIAL_TOKEN) {
    return { mode: raw.credential === 'peer' ? 'peer' : 'none', token: '' };
  }
  return { mode: raw.tokenMode, token };
}

function storedTokenMode(mode, token) {
  if (mode === 'custom') return token ? 'custom' : 'none';
  if (mode === 'none' || mode === 'peer') return 'none';
  return 'own';
}

/** A stored entry, defensively normalised (the setting may have been hand-edited). */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = toText(raw.id);
  const inboundOnly = raw.inboundOnly === true;
  // An inbound-only entry has no address (this relay never calls it) and is
  // known by its relay id alone.
  const url = inboundOnly ? '' : toText(raw.url).replace(/\/+$/, '');
  if (!id || (!url && !inboundOnly) || (inboundOnly && !toText(raw.relayId))) return null;
  const { mode, token } = readStoredCredential(raw);
  const peer = normalizePeerKeyFields(raw);
  // `peer`: the owner token held for that relay was dropped once its key
  // worked; without a key the entry reads as `none` (no credential).
  let tokenMode = storedTokenMode(mode, token);
  if (mode === 'peer' && peer.peerToken) tokenMode = 'peer';
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
    // Its page answers a question from `?answer=` (capabilities.answerLink).
    ...(raw.answerLink === true ? { answerLink: true } : {}),
    ...peer,
    ...(inboundOnly ? { inboundOnly: true, tokenMode: 'none' } : {}),
  };
}

// Kept out of every public view: credentials and the keys' hashes.
const PRIVATE_FIELDS = ['token', 'peerToken', 'peerTokenSeq', 'peerKeys', 'peerKeySeq', 'keyRelayId', 'keyUrl'];

/** The shape any API or socket payload may carry: no token or key, plus display helpers. */
function toPublic(entry, extra = null) {
  if (!entry) return null;
  const rest = { ...entry };
  for (const field of PRIVATE_FIELDS) delete rest[field];
  const policy = entry.inboundOnly ? { ok: true } : checkRemoteRelayUrlPolicy(entry.url);
  return {
    ...rest,
    ...(typeof extra === 'function' ? extra(entry) : {}),
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
  // The client owns token selection (tokenFor), so the registry never reads
  // a token itself. An `own` entry (none of its own) sends none.
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
  // Called with the removed entry (address and token still in it), after it
  // is gone from the list: the event link tells that relay its
  // subscriptions ended.
  onRemove = () => {},
} = {}) {
  let cachedInstanceId = '';
  let healthTimer = null;
  let sweeping = null;
  // The peer-key service (set once both exist): its index follows every
  // write, and it adds the key state to the public view.
  let peerKeys = null;

  function publicExtra(entry) {
    try {
      return peerKeys?.publicFields?.(entry) || {};
    } catch {
      return {};
    }
  }

  function publicOf(entry) {
    return toPublic(entry, publicExtra);
  }

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

  // Tokens from a pairing link, held in memory only while an add waits for
  // the key of that relay (holdToken): the entry reads as `custom` with the
  // token and is stored as `none`, so the token is never written to the
  // database once the key works. It goes when the entry's mode or token
  // changes (the key worked: `peer`), or is written once the add ends
  // without a working key (releaseHeldToken). A restart in between forgets
  // it: the entry reads as `none`, and adding it again fixes that.
  const heldTokens = new Map();

  function readList() {
    const stored = readJsonSetting(REMOTE_RELAY_SETTING_KEYS.relays);
    if (!Array.isArray(stored)) return [];
    const seen = new Set();
    const entries = [];
    for (const raw of stored) {
      let entry = normalizeEntry(raw);
      if (!entry || seen.has(entry.id)) continue;
      const held = heldTokens.get(entry.id);
      if (held && entry.tokenMode === 'none' && !entry.inboundOnly) entry = { ...entry, tokenMode: 'custom', token: held };
      seen.add(entry.id);
      entries.push(entry);
    }
    return entries;
  }

  /** What is written for an entry: a token held in memory is left out. */
  function withoutHeldToken(entry) {
    const held = heldTokens.get(entry.id);
    if (held === undefined) return entry;
    if (entry.tokenMode === 'custom' && entry.token === held) {
      const { token: _token, ...rest } = entry;
      return { ...rest, tokenMode: 'none' };
    }
    heldTokens.delete(entry.id);
    return entry;
  }

  function writeList(entries) {
    const ids = new Set(entries.map((entry) => entry.id));
    for (const id of [...heldTokens.keys()]) if (!ids.has(id)) heldTokens.delete(id);
    writeJsonSetting(REMOTE_RELAY_SETTING_KEYS.relays, entries.map(withoutHeldToken).map(toStoredRemoteRelayEntry));
    try {
      peerKeys?.rebuildIndex?.(entries);
    } catch (error) {
      logger?.warn?.(`[remote-relays] the key index could not be rebuilt: ${error?.message || error}`);
    }
  }

  function setPeerKeys(service) {
    peerKeys = service || null;
    try {
      peerKeys?.rebuildIndex?.(readList());
    } catch {}
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
      // imageInputs: send and create_session may carry images and image
      // options here; an older relay would drop them and run the turn without.
      // peerKeys: this relay issues and takes paired relays' own keys.
      // inboundKeys: a relay that adds this one one way gets a key of its
      // own here (POST …/peer-key/inbound), so it keeps no token of this one.
      remoteRelays: { protocol: REMOTE_RELAY_PROTOCOL, inbound: settings.inboundEnabled, imageInputs: true, peerKeys: true, inboundKeys: true },
      // answerLink: this relay's page takes `?answer=<id>&option=<n>` (a
      // paired relay's Inbox opens it in a popup; the person confirms here).
      capabilities: { answerLink: true },
    };
  }

  // For this relay's own Settings only, never for other relays: `defaultName`
  // is the name it goes by while the relay name is empty.
  function selfPayload() {
    return { ...selfIdentity(), ...getSelfSettings(), defaultName: toText(hostname) || 'OAR' };
  }

  function emitChange() {
    try {
      emit(REMOTE_RELAY_SOCKET_EVENT, { relays: listPublic(), inbound: listInboundPublic(), self: selfPayload() });
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

  // ─── Agent sessions ────────────────────────────────────────────────────────

  /** The payload of GET /api/settings/agent-sessions and of the socket event. */
  function getAgentSessionsSettings() {
    const enabled = readJsonSetting(REMOTE_RELAY_SETTING_KEYS.agentSessionsEnabled);
    return {
      enabled: enabled === true || enabled === 1 || ['true', '1', 'on'].includes(toText(enabled).toLowerCase()),
      maxWaitSeconds: normalizeRemoteRelayMaxWaitSeconds(readJsonSetting(REMOTE_RELAY_SETTING_KEYS.maxWaitSeconds)),
      limits: {
        minWaitSeconds: REMOTE_RELAY_LIMITS.waitMaxFloorSeconds,
        maxWaitSeconds: REMOTE_RELAY_LIMITS.waitMaxCeilingSeconds,
        stepSeconds: REMOTE_RELAY_LIMITS.waitMaxStepSeconds,
      },
      maxActiveSessions: REMOTE_RELAY_LIMITS.localActiveSessions,
    };
  }

  /**
   * `{ enabled?, maxWaitSeconds? }`. Nothing is rounded or clamped here: a
   * value outside the range, or off the slider's step, is refused, so what the
   * settings page shows is what was stored.
   */
  function setAgentSessionsSettings(patch = {}) {
    const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
      return invalid('enabled must be true or false');
    }
    if (input.maxWaitSeconds !== undefined) {
      const { waitMaxFloorSeconds: min, waitMaxCeilingSeconds: max, waitMaxStepSeconds: step } = REMOTE_RELAY_LIMITS;
      const seconds = input.maxWaitSeconds;
      if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < min || seconds > max || seconds % step !== 0) {
        return invalid(`maxWaitSeconds must be a whole number of seconds from ${min} to ${max}, in steps of ${step}`);
      }
    }
    if (input.enabled !== undefined) writeJsonSetting(REMOTE_RELAY_SETTING_KEYS.agentSessionsEnabled, input.enabled);
    if (input.maxWaitSeconds !== undefined) writeJsonSetting(REMOTE_RELAY_SETTING_KEYS.maxWaitSeconds, input.maxWaitSeconds);
    const settings = getAgentSessionsSettings();
    try {
      emit(AGENT_SESSIONS_SOCKET_EVENT, settings);
    } catch (error) {
      logger?.warn?.(`[remote-relays] agent sessions event failed: ${error?.message || error}`);
    }
    return { ok: true, ...settings };
  }

  // ─── Remote relays ─────────────────────────────────────────────────────────

  /** The relays this relay calls (inbound-only entries left out). */
  function list() {
    return readList().filter((entry) => !entry.inboundOnly);
  }

  /** Every entry, inbound-only ones included (the key index, notices, Remove). */
  function listAll() {
    return readList();
  }

  function listPublic() {
    return list().map(publicOf);
  }

  /** The inbound-only entries' rows: no address, no token, no key. */
  function listInboundPublic() {
    return readList().filter((entry) => entry.inboundOnly).map(publicOf);
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
    const entries = list();
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
    let tokenMode = token && (input.tokenMode === 'custom' || input.tokenMode === undefined) ? 'custom' : 'none';
    // Added one way with an inbound-only key: the key that relay gave this
    // one is the only credential stored, never the token from the link.
    const peerFields = input.tokenMode === 'peer' && toText(input.peerToken)
      ? { peerToken: input.peerToken, peerTokenSeq: input.peerTokenSeq, peerInboundOnly: input.peerInboundOnly === true }
      : null;
    if (peerFields) tokenMode = 'peer';
    const entry = normalizeEntry({
      relayId: input.relayId,
      name: input.name,
      version: input.version,
      platform: input.platform,
      protocol: input.protocol,
      answerLink: input.answerLink === true,
      lastSeenAt: input.lastSeenAt,
      lastStatus: input.lastStatus,
      lastError: input.lastError,
      id: `rr_${randomUUID()}`,
      url,
      tokenMode,
      ...(tokenMode === 'custom' ? { token } : {}),
      ...(peerFields || {}),
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
    for (const key of ['token', 'peerToken']) {
      if (Object.prototype.hasOwnProperty.call(fields, key) && fields[key] === undefined) delete merged[key];
    }
    const after = normalizeEntry(merged);
    entries[index] = after;
    writeList(entries);
    return { before, after };
  }

  /**
   * The peer-key service's writes: `fields`, or `(entry) => fields | null`
   * (null: nothing to write). `quiet` skips the socket event (the index is
   * rebuilt either way). Returns the stored entry, or null.
   */
  function patchPeerFields(id, fieldsOrFn, { quiet = false } = {}) {
    const current = get(id);
    if (!current) return null;
    const fields = typeof fieldsOrFn === 'function' ? fieldsOrFn(current) : fieldsOrFn;
    if (!fields || typeof fields !== 'object') return current;
    const result = patchStored(current.id, fields);
    if (!result) return null;
    if (!quiet && fingerprint(result.before) !== fingerprint(result.after)) emitChange();
    return result.after;
  }

  /**
   * Pairing: entry `id` (stored without a token) calls its relay with
   * `token`, held in memory only (see heldTokens).
   */
  function holdToken(id, token) {
    const entry = get(id);
    const value = toText(token);
    if (!entry || !value || entry.inboundOnly || entry.tokenMode !== 'none') return false;
    heldTokens.set(entry.id, value);
    return true;
  }

  /** The add ended: a token still held (no working key) is written now. */
  function releaseHeldToken(id) {
    const held = heldTokens.get(toText(id));
    if (held === undefined) return false;
    heldTokens.delete(toText(id));
    const entry = get(id);
    if (!entry || entry.tokenMode !== 'none') return false;
    patchStored(entry.id, { tokenMode: 'custom', token: held });
    return true;
  }

  /** User edits: `{ permission, url, token, tokenMode }` (PATCH /api/remote-relays/:id). */
  function update(id, patch = {}) {
    const current = get(id);
    if (!current) return invalid('Unknown remote relay', 404);
    if (current.inboundOnly) {
      return invalid(`"${current.name}" calls this relay only (inbound only): it has no address or token here to change. Remove it to revoke its key.`, 409);
    }
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
        // A keyed entry's address is pinned: re-pointing it revokes its keys
        // and holds issuance until the owner confirms (origin binding §4.3).
        Object.assign(fields, peerKeys?.pinnedChangeFields?.(current, { url: link.baseUrl }) || {});
      }
    }

    if (input.tokenMode !== undefined && !['own', 'custom', 'none'].includes(input.tokenMode)) {
      return invalid('tokenMode must be custom or none');
    }
    if (input.token !== undefined || input.tokenMode !== undefined) {
      const token = input.token !== undefined ? toText(input.token) : toText(current.token);
      // `own` (this relay's token) is never sent any more: it means none.
      const requested = input.tokenMode === 'own' ? 'none' : input.tokenMode;
      const tokenMode = requested !== undefined ? requested : (token ? 'custom' : 'none');
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
    return { ok: true, relay: publicOf(result.after) };
  }

  /** Local only: the other side keeps its own entry for this relay. */
  function remove(id) {
    const key = toText(id);
    const entries = readList();
    const removed = entries.find((entry) => entry.id === key) || null;
    const remaining = entries.filter((entry) => entry.id !== key);
    if (!key || !removed) return invalid('Unknown remote relay', 404);
    writeList(remaining);
    try {
      repository?.forgetRelay?.(key);
    } catch (error) {
      logger?.warn?.(`[remote-relays] forgetting unlocks failed: ${error?.message || error}`);
    }
    try {
      onRemove(removed);
    } catch (error) {
      logger?.warn?.(`[remote-relays] removal hook failed: ${error?.message || error}`);
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
    const byId = id ? entries.find((entry) => entry.relayId === id) : null;
    const byUrl = findByUrl(entries, baseUrl);
    // A relay id is unique: an introduction naming a listed relay's id at
    // another address, or a listed address under another id, changes no
    // entry (origin binding §4.3: pairing never rewrites an entry).
    if (byUrl && id && byUrl.relayId && byUrl.relayId !== id) {
      const error = new Error('That address belongs to another paired relay here; remove that entry first if it was replaced');
      error.status = 409;
      throw error;
    }
    const existing = byId || byUrl;
    const secret = toText(token);
    const selfDescription = {
      ...(toText(name) ? { name } : {}),
      ...(toText(offeredVersion) ? { version: offeredVersion } : {}),
      ...(toText(offeredPlatform) ? { platform: offeredPlatform } : {}),
    };
    // That relay held an inbound-only key here and now asks to be listed
    // both ways: the same entry becomes a normal one, unconfirmed like any
    // new entry from an introduction until its address proves to be it.
    if (existing?.inboundOnly) {
      if (!baseUrl) {
        const error = new Error('An introduction needs the relay\'s address');
        error.status = 400;
        throw error;
      }
      return adoptInboundHolder(existing.id, {
        url: baseUrl,
        ...(secret ? { tokenMode: 'custom', token: secret } : { tokenMode: 'none' }),
        ...selfDescription,
        ...(Number.isInteger(protocol) && protocol >= 0 ? { protocol } : {}),
        addedBy: 'pairing',
        unconfirmed: true,
      });
    }
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
      // The relay id and protocol stay as stored (the probe updates the
      // protocol; a keyed entry's id is pinned). An entry from before ids
      // were known takes the id once.
      const result = patchStored(existing.id, { ...(existing.relayId ? {} : { relayId: id }), ...selfDescription });
      if (result && fingerprint(result.before) !== fingerprint(result.after)) emitChange();
      return result?.after || existing;
    }
    const tokenFields = secret ? { tokenMode: 'custom', token: secret } : { tokenMode: 'none' };
    // A new entry from an introduction is unconfirmed (no key, no weight)
    // until its address proves to be that relay (a probe or a key check).
    const entry = add({
      ...selfDescription,
      ...(Number.isInteger(protocol) && protocol >= 0 ? { protocol } : {}),
      relayId: id,
      name: toText(name) || hostOf(baseUrl),
      url: baseUrl,
      ...tokenFields,
      addedBy: 'pairing',
    });
    return patchPeerFields(entry.id, { unconfirmed: true }) || entry;
  }

  /**
   * A relay that added this one one way asks for a key (POST
   * …/peer-key/inbound): its inbound-only entry, made or refreshed. Throws
   * 409 when that relay is listed here already as a normal entry (its key
   * comes the usual way). `{ entry, created }`.
   */
  function upsertInboundHolder({ relayId, name, version: offeredVersion, platform: offeredPlatform, protocol } = {}) {
    const id = toText(relayId).slice(0, 100);
    if (!id) {
      const error = new Error('relayId is required');
      error.status = 400;
      throw error;
    }
    const entries = readList();
    const existing = entries.find((entry) => entry.relayId === id) || null;
    if (existing && !existing.inboundOnly) {
      const error = new Error('This relay lists that relay already, both ways: its key comes the usual way');
      error.status = 409;
      throw error;
    }
    const described = {
      ...(toText(name) ? { name: toText(name).slice(0, 60) } : {}),
      ...(toText(offeredVersion) ? { version: offeredVersion } : {}),
      ...(toText(offeredPlatform) ? { platform: offeredPlatform } : {}),
      ...(Number.isInteger(protocol) && protocol >= 0 ? { protocol } : {}),
    };
    if (existing) {
      const result = patchStored(existing.id, described);
      if (result && fingerprint(result.before) !== fingerprint(result.after)) emitChange();
      return { entry: result?.after || existing, created: false };
    }
    const entry = normalizeEntry({
      ...described,
      id: `rr_${randomUUID()}`,
      relayId: id,
      inboundOnly: true,
      tokenMode: 'none',
      addedBy: 'pairing',
      addedAt: nowIso(),
    });
    writeList([...entries, entry]);
    emitChange();
    return { entry, created: true };
  }

  /**
   * An inbound-only entry becomes a normal one (this relay adds that relay,
   * or it introduces itself to be listed both ways): same id, no duplicate
   * row. The key it held is revoked and its epoch bumped: an inbound-only
   * key's holder was never checked at an address, so it does not carry over
   * to the relay found there; keys both ways follow the usual way.
   */
  function adoptInboundHolder(id, fields = {}) {
    const current = get(id);
    if (!current?.inboundOnly) return current;
    const result = patchStored(current.id, {
      ...fields,
      inboundOnly: false,
      peerKeys: [],
      epoch: (Number(current.epoch) || 0) + 1,
      everKeyed: false,
      keyRelayId: null,
      keyUrl: null,
      lastStatus: 'unknown',
      lastError: null,
    });
    if (!result) return null;
    try {
      logger?.log?.(`[remote-relays] "${current.name}" held an inbound-only key here and is now listed both ways; that key was revoked and keys follow both ways.`);
    } catch {}
    emitChange();
    return result.after;
  }

  /** Stores what a successful probe said. Returns `{ changed, relay }` (full entry). */
  function applyIdentity(id, identity, { emitOnChange = true } = {}) {
    let fields;
    if (identity?.relayId && identity.relayId === instanceId()) {
      // An address that turns out to be this relay itself must not look healthy.
      fields = { lastStatus: 'error', lastError: 'This address points at this relay itself' };
    } else {
      fields = { lastStatus: 'online', lastSeenAt: nowIso(), lastError: null };
      const current = get(id);
      let review = { fields: {} };
      try {
        review = peerKeys?.reviewIdentity?.(current, identity) || review;
      } catch {}
      // A keyed entry's relay id is pinned: another id at its address is held
      // for the owner, not adopted. Another entry's id is never taken either.
      const takenByOther = identity?.relayId && readList().some((entry) => entry.id !== id && entry.relayId === identity.relayId);
      if (identity?.relayId && !review.keepRelayId && !takenByOther) fields.relayId = identity.relayId;
      if (current?.unconfirmed && identity?.relayId && current.relayId && identity.relayId === current.relayId) fields.unconfirmed = false;
      if (toText(identity?.name)) fields.name = identity.name;
      if (identity?.version) fields.version = identity.version;
      if (identity?.platform) fields.platform = identity.platform;
      if (Number.isInteger(identity?.protocol)) fields.protocol = identity.protocol;
      if (typeof identity?.answerLink === 'boolean') fields.answerLink = identity.answerLink;
      Object.assign(fields, review.fields || {});
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
    // Inbound only: no address, never called.
    if (entry.inboundOnly) return { changed: false, relay: entry };
    let outcome;
    try {
      const identity = await client.probe(entry.url, client.tokenFor(entry), { timeoutMs, relay: entry });
      outcome = applyIdentity(entry.id, identity, { emitOnChange });
    } catch (error) {
      outcome = applyFailure(entry.id, error, { emitOnChange });
    }
    // Keys follow within one health interval: issue, rotate or ask.
    try {
      peerKeys?.afterProbe?.(entry.id);
    } catch {}
    return outcome;
  }

  /** Probes one remote now; the public entry, or null for an unknown id. */
  async function check(id, { timeoutMs } = {}) {
    const { relay } = await checkEntry(toText(id), { timeoutMs });
    return publicOf(relay);
  }

  /** One pass over every remote; a single event when anything changed. */
  function checkAll() {
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const ids = list().map((entry) => entry.id);
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

  /**
   * The owner token moved out of the config (owner-secret-store.mjs): every
   * entry that called a paired relay with "this relay's own token" (`own`)
   * gets that token stored as its own (`custom`), the one time the plain
   * value is known, so the pairing never needs it again. Returns how many.
   */
  function convertOwnEntries(ownToken) {
    const token = toText(ownToken);
    if (!token) return 0;
    const entries = readList();
    let converted = 0;
    const next = entries.map((entry) => {
      if (entry.tokenMode !== 'own' || entry.inboundOnly) return entry;
      converted += 1;
      return normalizeEntry({ ...entry, tokenMode: 'custom', token });
    });
    if (!converted) return 0;
    writeList(next);
    emitChange();
    return converted;
  }

  return {
    instanceId,
    selfName,
    selfIdentity,
    selfPayload,
    getSelfSettings,
    setSelfSettings,
    // The relay name lives outside the registry: its setter calls this so
    // every open Settings sees the new name.
    notifySelfChanged: emitChange,
    getAgentSessionsSettings,
    setAgentSessionsSettings,
    list,
    listAll,
    listPublic,
    listInboundPublic,
    get,
    resolve,
    add,
    update,
    remove,
    upsertFromPairing,
    upsertInboundHolder,
    adoptInboundHolder,
    recordIdentity,
    patchPeerFields,
    holdToken,
    releaseHeldToken,
    setPeerKeys,
    publicOf,
    check,
    checkAll,
    startHealthLoop,
    stopHealthLoop,
    tokenFor,
    convertOwnEntries,
    get healthLoopRunning() { return Boolean(healthTimer); },
  };
}
