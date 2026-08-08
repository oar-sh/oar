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

/**
 * Build the best-effort fetcher the usage route calls. Errors and missing
 * logins yield `null` so the card degrades to the local estimated view.
 */
export function createGrokBillingUsageFetcher({
  fetchImpl = globalThis.fetch,
  readAuthKeyImpl = readGrokCliAuthKey,
  url = GROK_BILLING_URL,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  return async function fetchGrokBillingUsage() {
    if (typeof fetchImpl !== 'function') return null;
    const auth = readAuthKeyImpl();
    if (!auth?.key) return null;
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${auth.key}` },
        signal: AbortSignal.timeout?.(timeoutMs),
      });
      if (!response?.ok) return null;
      return normalizeGrokBillingCredits(await response.json());
    } catch {
      return null;
    }
  };
}
