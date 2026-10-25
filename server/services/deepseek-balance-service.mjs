'use strict';

// The DeepSeek account balance for the usage card: `GET /user/balance` with
// the saved key and base URL (shared/deepseek-api.mjs), only while DeepSeek
// is on. An answer is kept for a minute, a failure for 15 seconds, and a
// changed key or endpoint is read afresh. Never throws: a failure is an
// answer of its own, `{ ok: false, code, error }`, whose text never holds the
// key, with the last good answer beside it as `previous`.

import { createDeepSeekApiClient } from '../../shared/deepseek-api.mjs';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_ERROR_TTL_MS = 15_000;
// The usage modal waits for its slowest read, so this one is kept short.
const DEFAULT_TIMEOUT_MS = 5_000;

function redact(text, apiKey) {
  const value = String(text ?? '');
  const key = String(apiKey ?? '').trim();
  return key ? value.split(key).join('[redacted]') : value;
}

export function createDeepSeekBalanceService({
  getSettings = () => null,
  fetchImpl = globalThis.fetch,
  createClient = createDeepSeekApiClient,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  errorTtlMs = DEFAULT_ERROR_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  let cache = null; // { identity, entry, expiresAt }
  let lastGood = null; // { identity, entry }
  let inflight = null; // { identity, promise }

  function readSettings() {
    try {
      return getSettings() || null;
    } catch {
      return null;
    }
  }

  async function read(settings) {
    const fetchedAt = new Date(now()).toISOString();
    if (!settings.apiKey) {
      return { ok: false, code: 'not_configured', error: 'DeepSeek API key is not configured', fetchedAt };
    }
    try {
      const client = createClient({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, fetchImpl, timeoutMs });
      const { isAvailable, balances } = await client.getBalance();
      return { ok: true, isAvailable: isAvailable === true, balances: Array.isArray(balances) ? balances : [], fetchedAt };
    } catch (error) {
      return {
        ok: false,
        code: String(error?.code || 'error'),
        error: redact(error?.message || error || 'DeepSeek balance check failed', settings.apiKey).slice(0, 300),
        fetchedAt,
      };
    }
  }

  /**
   * The balance, or null while DeepSeek is off. `{ force: true }` skips the
   * cache (a fresh read is still shared with one already running).
   */
  async function getBalance({ force = false } = {}) {
    const settings = readSettings();
    if (settings?.enabled !== true) return null;
    const identity = `${settings.baseUrl || ''}\n${settings.apiKey || ''}`;
    const answer = (entry, cached) => (entry.ok || lastGood?.identity !== identity
      ? { ...entry, cached }
      : { ...entry, cached, previous: lastGood.entry });
    if (!force && cache && cache.identity === identity && cache.expiresAt > now()) {
      return answer(cache.entry, true);
    }
    if (!inflight || inflight.identity !== identity) {
      const promise = read(settings).then((entry) => {
        cache = { identity, entry, expiresAt: now() + (entry.ok ? ttlMs : errorTtlMs) };
        if (entry.ok) lastGood = { identity, entry };
        return entry;
      }).finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
      inflight = { identity, promise };
    }
    return answer(await inflight.promise, false);
  }

  /**
   * The last good answer for the saved key and endpoint, without reading
   * anew; null when there is none (or DeepSeek is off).
   */
  function peekBalance() {
    const settings = readSettings();
    if (settings?.enabled !== true) return null;
    const identity = `${settings.baseUrl || ''}\n${settings.apiKey || ''}`;
    return lastGood?.identity === identity ? lastGood.entry : null;
  }

  return { getBalance, peekBalance };
}
