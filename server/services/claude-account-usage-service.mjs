'use strict';

// The Claude account's usage, read live for the "Check Usage" modal.
//
// Three reads with the Claude CLI's login, none of which costs a model turn:
// the usage windows and dollar buckets, the prepaid credits, and whether a
// usage credit is on offer. The first one is the result; the other two are
// garnish, and their failure only leaves their field empty.
//
// The Claude Cloud switch is the user's consent for the relay to use that
// login at all, so while it is off nothing is read and nothing that was read
// before is handed out. Nothing here sees the token: the injected cloud client
// reads it itself, and the only error text passed on is the client's own
// (which the client has redacted), with a bearer header taken out once more.

import { ClaudeCloudError } from '../../shared/claude-cloud/credentials.mjs';

const DEFAULT_CACHE_MS = 60_000;
// A failed read is kept for a shorter time: long enough that a modal that is
// opened and refreshed does not ask again at once, short enough that the next
// look after a hiccup is live.
const MAX_ERROR_CACHE_MS = 15_000;
const MAX_ERROR_CHARS = 300;
const GENERIC_ERROR = 'The Claude account usage could not be read.';
const TIMEOUT_ERROR = 'The Claude account usage did not arrive in time.';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** What the card may show about a failed read; never more than the client's own words. */
function describeError(error) {
  if (!(error instanceof ClaudeCloudError)) return GENERIC_ERROR;
  const text = String(error.message || '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return GENERIC_ERROR;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/**
 * `cloudClient`: shared/claude-cloud/api-client.mjs (`getAccountUsage`,
 * `getOrganizationId`, `getPrepaidCredits`, `getCreditGrantOffer`).
 * `isEnabled`: whether the Claude Cloud provider is switched on.
 * `now`: the clock, as a Date or as milliseconds.
 */
export function createClaudeAccountUsageService({
  cloudClient = null,
  isEnabled = () => false,
  now = () => Date.now(),
  cacheMs = DEFAULT_CACHE_MS,
} = {}) {
  const keepMs = Number.isFinite(Number(cacheMs)) && Number(cacheMs) > 0 ? Number(cacheMs) : 0;
  let cached = null;
  let inFlight = null;

  function nowMs() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(ms) ? ms : Date.now();
  }

  function enabled() {
    try {
      return isEnabled() === true;
    } catch {
      return false;
    }
  }

  async function readOptional(method) {
    if (typeof cloudClient?.[method] !== 'function') return null;
    try {
      const body = await cloudClient[method]();
      return isPlainObject(body) ? body : null;
    } catch {
      return null;
    }
  }

  /** The prepaid credits and the offer: both need the organisation, which is asked for once. */
  async function readExtras() {
    if (typeof cloudClient?.getOrganizationId === 'function') {
      try {
        await cloudClient.getOrganizationId();
      } catch {
        return [null, null];
      }
    }
    return Promise.all([readOptional('getPrepaidCredits'), readOptional('getCreditGrantOffer')]);
  }

  async function readUsage() {
    if (typeof cloudClient?.getAccountUsage !== 'function') {
      return { usage: null, error: GENERIC_ERROR };
    }
    try {
      const body = await cloudClient.getAccountUsage();
      return isPlainObject(body) ? { usage: body, error: null } : { usage: null, error: GENERIC_ERROR };
    } catch (error) {
      return { usage: null, error: describeError(error) };
    }
  }

  async function fetchAll() {
    const [{ usage, error }, [prepaid, offer]] = await Promise.all([
      readUsage(),
      readExtras().catch(() => [null, null]),
    ]);
    return { usage, prepaid, offer, fetchedAt: new Date(nowMs()).toISOString(), error };
  }

  function load() {
    if (cached && nowMs() - cached.at < (cached.value.error ? Math.min(keepMs, MAX_ERROR_CACHE_MS) : keepMs)) {
      return Promise.resolve(cached.value);
    }
    if (!inFlight) {
      inFlight = fetchAll()
        .catch(() => ({ usage: null, prepaid: null, offer: null, fetchedAt: new Date(nowMs()).toISOString(), error: GENERIC_ERROR }))
        .then((value) => {
          cached = { at: nowMs(), value };
          return value;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  }

  /**
   * Resolves `{ usage, prepaid, offer, fetchedAt, error }`, or null while the
   * provider is off. Never rejects. With `timeoutMs`, a read that takes
   * longer resolves with an `error` and no data; the read itself goes on and
   * fills the cache for the next caller.
   */
  async function getAccountUsage({ timeoutMs = 0 } = {}) {
    if (!enabled()) {
      cached = null;
      return null;
    }
    let value;
    try {
      const pending = load();
      if (Number(timeoutMs) > 0) {
        let timer = null;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ usage: null, prepaid: null, offer: null, fetchedAt: null, error: TIMEOUT_ERROR }), Number(timeoutMs));
          timer.unref?.();
        });
        value = await Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
      } else {
        value = await pending;
      }
    } catch {
      value = { usage: null, prepaid: null, offer: null, fetchedAt: null, error: GENERIC_ERROR };
    }
    // Switched off while the answer was on its way: it is not handed out.
    if (!enabled()) {
      cached = null;
      return null;
    }
    return value;
  }

  /**
   * The last answer without a read, however old, or null when there is none
   * (or the provider is off): for a caller that wants the other providers
   * live and this one as it was.
   */
  function peekAccountUsage() {
    if (!enabled()) return null;
    return cached?.value || null;
  }

  return { getAccountUsage, peekAccountUsage };
}
