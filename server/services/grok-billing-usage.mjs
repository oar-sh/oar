'use strict';

/**
 * Live Grok subscription quota for the Check Usage card.
 *
 * OIDC subscription logins have no USD billing; the authoritative quota is
 * the weekly SuperGrok percentage shown on grok.com → Settings → Usage. The
 * Grok CLI's chat proxy serves the same payload:
 *
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *   Authorization: Bearer <key from ~/.grok/auth.json>
 *
 * (Discovered 2026-08-08 by tracing the TUI's subscription watcher; the ACP
 * agent itself exposes no quota RPC — `x.ai/auth/check_subscription` is a
 * leader-side method.)
 *
 * The bearer key is the relay host's own CLI login (same host-login trust
 * model as turn execution). It is read fresh per fetch — the CLI rotates it
 * every few hours — and never logged or forwarded to clients.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const FETCH_TIMEOUT_MS = 6_000;

/**
 * Read the newest OIDC access key from the Grok CLI's auth store. Returns
 * null when the CLI is not logged in. Never throws.
 */
export function readGrokCliAuthKey({ homeDir = os.homedir(), fsImpl = fs } = {}) {
  try {
    const raw = fsImpl.readFileSync(path.join(homeDir, '.grok', 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    let best = null;
    for (const entry of Object.values(parsed)) {
      const key = String(entry?.key || '').trim();
      if (!key) continue;
      const createTime = Date.parse(entry?.create_time || '') || 0;
      if (!best || createTime > best.createTime) {
        best = { key, createTime, expiresAt: String(entry?.expires_at || '') || null };
      }
    }
    return best ? { key: best.key, expiresAt: best.expiresAt } : null;
  } catch {
    return null;
  }
}

function toPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function toIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * Normalize the proxy's billing payload into the fields the plan card needs.
 * Pure; returns null when nothing usable is present.
 */
export function normalizeGrokBillingCredits(payload = null) {
  const config = payload?.config && typeof payload.config === 'object' ? payload.config : payload;
  if (!config || typeof config !== 'object') return null;

  const usagePercent = toPercent(config.creditUsagePercent);
  const period = config.currentPeriod && typeof config.currentPeriod === 'object'
    ? config.currentPeriod
    : {};
  const periodType = String(period.type || '').trim();
  const products = (Array.isArray(config.productUsage) ? config.productUsage : [])
    .map((entry) => ({
      product: String(entry?.product || '').trim(),
      usagePercent: toPercent(entry?.usagePercent),
    }))
    .filter((entry) => entry.product && entry.usagePercent !== null);

  const normalized = {
    usagePercent,
    // "USAGE_PERIOD_TYPE_WEEKLY" → "weekly"
    periodType: periodType.replace(/^USAGE_PERIOD_TYPE_/, '').toLowerCase() || null,
    periodStart: toIso(period.start || config.billingPeriodStart),
    periodEnd: toIso(period.end || config.billingPeriodEnd),
    products,
  };
  if (normalized.usagePercent === null && !products.length) return null;
  return normalized;
}

const MAX_REPORTED_KEYS = 12;
const MAX_REPORTED_KEY_LENGTH = 40;

/**
 * The field names of an answer the normalizer could not use, for the card's
 * explanation. Names only, never values, capped in number and length, and
 * stripped to plain identifier characters so nothing odd reaches the page.
 * When the answer has the `config` wrapper, its inner names are the useful
 * ones, since that is the level the normalizer reads.
 */
export function describeGrokBillingPayloadKeys(payload = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const level = payload.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
    ? payload.config
    : payload;
  return Object.keys(level)
    .slice(0, MAX_REPORTED_KEYS)
    .map((key) => String(key).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, MAX_REPORTED_KEY_LENGTH))
    .filter(Boolean);
}

function isElapsed(isoText, nowMs) {
  const parsed = Date.parse(String(isoText || ''));
  return Number.isFinite(parsed) && parsed <= nowMs;
}

/**
 * Build the best-effort fetcher the usage route calls. Errors and missing
 * logins yield `null` so the card degrades to the local estimated view.
 *
 * The returned function also takes `{ onResult }`: a callback that receives
 * the full outcome `{ usage, reason, httpStatus, keys, checkedAt }`, so the
 * card can say why there is no figure. `reason` is a short stable code
 * (null on success): `no-login`, `login-expired`, `not-authorized`,
 * `http-<status>`, `timeout`, `network`, `unknown-format`. `keys` is set for
 * `unknown-format` only. The outcome never carries the key, the answer body,
 * header values or the URL.
 */
export function createGrokBillingUsageFetcher({
  fetchImpl = globalThis.fetch,
  readAuthKeyImpl = readGrokCliAuthKey,
  url = GROK_BILLING_URL,
  timeoutMs = FETCH_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  async function fetchGrokBillingUsageResult() {
    const nowMs = now();
    const outcome = (usage, reason, extra = {}) => ({
      usage,
      reason,
      httpStatus: null,
      keys: null,
      checkedAt: new Date(nowMs).toISOString(),
      ...extra,
    });
    if (typeof fetchImpl !== 'function') return outcome(null, 'network');
    let auth = null;
    try {
      auth = readAuthKeyImpl();
    } catch {
      auth = null;
    }
    if (!auth?.key) return outcome(null, 'no-login');
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${auth.key}` },
        signal: AbortSignal.timeout?.(timeoutMs),
      });
    } catch (error) {
      return outcome(null, isTimeoutError(error) ? 'timeout' : 'network');
    }
    if (!response?.ok) {
      const status = Number(response?.status);
      const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      if (httpStatus === 401 || httpStatus === 403) {
        // The CLI refreshes its key in place, so an elapsed expiry alone says
        // little; together with a refusal it is the likeliest cause.
        const reason = isElapsed(auth.expiresAt, nowMs) ? 'login-expired' : 'not-authorized';
        return outcome(null, reason, { httpStatus });
      }
      return outcome(null, httpStatus ? `http-${httpStatus}` : 'network', { httpStatus });
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      if (isTimeoutError(error)) return outcome(null, 'timeout');
      return outcome(null, 'unknown-format', { keys: [] });
    }
    const usage = normalizeGrokBillingCredits(payload);
    if (!usage) return outcome(null, 'unknown-format', { keys: describeGrokBillingPayloadKeys(payload) });
    return outcome(usage, null);
  }

  return async function fetchGrokBillingUsage({ onResult = null } = {}) {
    let result;
    try {
      result = await fetchGrokBillingUsageResult();
    } catch {
      result = { usage: null, reason: 'network', httpStatus: null, keys: null, checkedAt: new Date(now()).toISOString() };
    }
    if (typeof onResult === 'function') {
      try {
        onResult(result);
      } catch {
        // A broken observer must not cost the caller its answer.
      }
    }
    return result.usage;
  };
}

function isTimeoutError(error) {
  const name = String(error?.name || '');
  return name === 'TimeoutError' || name === 'AbortError';
}
