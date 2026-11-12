'use strict';

// When the owner token was last used by something other than a browser page
// (agent auth §13.2, 3a): a script, a paired relay still on protocol 1, any
// Bearer request without `Sec-Fetch-Site: same-origin`. Kept as
// `{ at, address }`, never the value. Settings → Security shows it in the
// rotation dialog, so the person can tell what a rotation will cut off.
//
// The record lives in memory and in app_settings `auth_owner_token_last_use`
// (`{ current, previous, owner, since }`), written at most every 10 minutes:
// a restart loses at most the last 10 minutes of uses. A rotation moves
// `current` to `previous`. The store keeps a short prefix of the owner hash
// (`owner`; the full hash is in app_settings already) to notice a rotation
// done while the relay was down (`oar setup --new-token`).

export const OWNER_TOKEN_LAST_USE_SETTING_KEY = 'auth_owner_token_last_use';
export const OWNER_TOKEN_LAST_USE_WRITE_INTERVAL_MS = 10 * 60 * 1000;
const OWNER_TAG_LENGTH = 16;
const ADDRESS_MAX = 64;

function toText(value) {
  return String(value ?? '').trim();
}

function useOf(value) {
  if (!value || typeof value !== 'object') return null;
  const at = toText(value.at);
  if (!Number.isFinite(Date.parse(at))) return null;
  return { at, address: toText(value.address).slice(0, ADDRESS_MAX) || null };
}

/**
 * @param {object} options
 * @param {() => string} options.ownerHash the current owner hash (owner-secret-store)
 * @param {() => string|null} [options.createdAt] when the current token was made or last rotated
 */
export function createOwnerTokenUseTracker({
  readSetting = () => null,
  writeSetting = () => {},
  ownerHash = () => '',
  createdAt = () => null,
  now = () => Date.now(),
  writeIntervalMs = OWNER_TOKEN_LAST_USE_WRITE_INTERVAL_MS,
  logger = console,
} = {}) {
  let current = null;
  let previous = null;
  let since = null;
  let ownerTag = '';
  let lastWriteAt = -Infinity;
  let dirty = false;

  function tagOfOwner() {
    return toText(ownerHash()).toLowerCase().slice(0, OWNER_TAG_LENGTH);
  }

  function iso(ms) {
    return new Date(ms).toISOString();
  }

  // `use`: a write for a recorded use, which starts the 10-minute throttle
  // (a rotation's write does not).
  function persist({ use = false } = {}) {
    try {
      writeSetting(OWNER_TOKEN_LAST_USE_SETTING_KEY, JSON.stringify({ current, previous, owner: ownerTag, since }));
      if (use) lastWriteAt = now();
      dirty = false;
    } catch (error) {
      logger?.warn?.(`[auth] the owner token's last use could not be stored: ${error?.message || error}`);
    }
  }

  // The token changed since the record was made: its uses become `previous`.
  function syncOwner() {
    const tag = tagOfOwner();
    if (!tag || tag === ownerTag) return false;
    // A first start keeps no earlier record: the token's own age is the
    // start. After a rotation the record starts now.
    const rotated = !!ownerTag;
    if (rotated) previous = current;
    current = null;
    ownerTag = tag;
    since = rotated ? iso(now()) : (toText(createdAt()) || iso(now()));
    persist();
    return true;
  }

  function load() {
    let stored = null;
    try { stored = JSON.parse(String(readSetting(OWNER_TOKEN_LAST_USE_SETTING_KEY) || 'null')); } catch { stored = null; }
    if (stored && typeof stored === 'object') {
      current = useOf(stored.current);
      previous = useOf(stored.previous);
      ownerTag = toText(stored.owner).toLowerCase();
      since = Number.isFinite(Date.parse(stored.since || '')) ? stored.since : null;
    }
    syncOwner();
  }

  /** A non-browser use of the owner token, from `address`. */
  function record({ address = '' } = {}) {
    syncOwner();
    current = { at: iso(now()), address: toText(address).slice(0, ADDRESS_MAX) || null };
    dirty = true;
    if (now() - lastWriteAt >= writeIntervalMs) persist({ use: true });
    return current;
  }

  /** Writes a pending record at once (shutdown). */
  function flush() {
    if (dirty) persist();
  }

  /**
   * `{ lastNonBrowserUse, previousLastNonBrowserUse, since }`: `since` is
   * when the current token's record began (its creation or rotation, or
   * the first start that kept one), for "not since …".
   */
  function view() {
    return { lastNonBrowserUse: current, previousLastNonBrowserUse: previous, since };
  }

  load();

  return { record, view, syncOwner, flush };
}
