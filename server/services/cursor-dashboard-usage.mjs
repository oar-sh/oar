'use strict';

/**
 * Live Cursor plan quota for the Check Usage card.
 *
 * The Cursor API key exposes no plan/usage surface (`/v1/agents/:id/usage` is
 * feature-gated, everything else 404s). The percentages shown on
 * cursor.com/dashboard ("Included in Ultra": Total / Auto / API) come from the
 * dashboard's own web API, which authenticates with the browser session
 * cookie:
 *
 *   POST https://cursor.com/api/dashboard/get-current-period-usage
 *   Cookie: WorkosCursorSessionToken=<token>
 *   Origin: https://cursor.com
 *
 * The token resolves automatically from the relay host's Cursor IDE login
 * (state.vscdb `cursorAuth/accessToken`, same host-login trust model as the
 * Grok CLI's auth.json) — the cookie is `<sub-user-id>::<access JWT>`. A
 * manually pasted cookie (DevTools → Application → Cookies → cursor.com)
 * takes precedence for headless hosts without an IDE install. On 401/expiry
 * the card silently degrades to the local estimated view. Tokens never leave
 * the relay and are never echoed back to clients.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);

export const CURSOR_DASHBOARD_USAGE_URL = 'https://cursor.com/api/dashboard/get-current-period-usage';
const FETCH_TIMEOUT_MS = 6_000;
// The IDE access token lives for months; re-reading the multi-MB state.vscdb
// on every Check Usage open would be wasteful.
const IDE_TOKEN_CACHE_MS = 5 * 60_000;

/**
 * Default locations of the Cursor IDE's state database per platform.
 */
export function defaultCursorStateDbPath({ platform = process.platform, env = process.env, homeDir = os.homedir() } = {}) {
  if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim() || path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/**
 * Build the dashboard session cookie value from an IDE access token:
 * `WorkosCursorSessionToken=<userId>%3A%3A<jwt>` where userId is the JWT
 * `sub` claim with its provider prefix stripped. Pure; null when the token
 * is malformed or expired.
 */
export function sessionTokenFromAccessToken(accessToken, { now = () => Date.now() } = {}) {
  const token = String(accessToken || '').trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const sub = String(payload?.sub || '').trim();
  if (!sub) return null;
  const exp = Number(payload?.exp);
  if (Number.isFinite(exp) && exp * 1000 <= now()) return null;
  const userId = sub.includes('|') ? sub.split('|').pop() : sub;
  return `${userId}%3A%3A${token}`;
}

/**
 * Read the Cursor IDE's login from state.vscdb and build the dashboard
 * session token from it — the same host-login trust model as the Grok CLI's
 * auth.json. The db is opened READ-ONLY in place: it can be multiple GB, so
 * copying it is not an option, and SQLite's WAL mode supports concurrent
 * readers next to the running IDE. Never throws; null when the IDE is
 * absent, logged out, or the db is momentarily locked.
 */
export function readCursorIdeSessionToken({
  stateDbPath = defaultCursorStateDbPath(),
  fsImpl = fs,
  loadDatabase = null,
  now = () => Date.now(),
} = {}) {
  try {
    if (!fsImpl.existsSync(stateDbPath)) return null;
    // Lazy-required so importing this module never pays the native-module cost.
    const openDatabase = loadDatabase
      || ((file) => requireModule('better-sqlite3')(file, { readonly: true, fileMustExist: true, timeout: 1500 }));
    const db = openDatabase(stateDbPath);
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'").get();
      return sessionTokenFromAccessToken(row?.value, { now });
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
}

function toPercent(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function toCents(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  // The endpoint has shipped both ISO strings and unix-ms strings.
  const asNumber = Number(value);
  const timestamp = Number.isFinite(asNumber) && asNumber > 10_000_000_000
    ? asNumber
    : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/**
 * Normalize the dashboard payload into the fields the plan card needs.
 * Handles both the flat `planUsage` shape and the older
 * `individualUsage.plan` shape from /api/usage-summary. Pure; null when
 * nothing usable is present.
 */
export function normalizeCursorDashboardUsage(payload = null) {
  if (!payload || typeof payload !== 'object') return null;
  const plan = (payload.planUsage && typeof payload.planUsage === 'object')
    ? payload.planUsage
    : (payload.individualUsage?.plan && typeof payload.individualUsage.plan === 'object'
      ? payload.individualUsage.plan
      : null);
  if (!plan) return null;

  const normalized = {
    totalPercentUsed: toPercent(plan.totalPercentUsed),
    autoPercentUsed: toPercent(plan.autoPercentUsed),
    apiPercentUsed: toPercent(plan.apiPercentUsed),
    includedSpendCents: toCents(plan.includedSpend ?? plan.totalSpend),
    limitCents: toCents(plan.limit),
    remainingCents: toCents(plan.remaining),
    billingCycleStart: toIso(payload.billingCycleStart),
    billingCycleEnd: toIso(payload.billingCycleEnd),
    membershipType: String(payload.membershipType || '').trim() || null,
    displayMessage: String(payload.displayMessage || '').trim() || null,
    onDemand: (() => {
      const spend = payload.spendLimitUsage && typeof payload.spendLimitUsage === 'object'
        ? payload.spendLimitUsage
        : (payload.individualUsage?.onDemand && typeof payload.individualUsage.onDemand === 'object'
          ? payload.individualUsage.onDemand
          : null);
      if (!spend) return null;
      const usedCents = toCents(spend.individualUsed ?? spend.totalSpend ?? spend.used);
      const limitCents = toCents(spend.individualLimit ?? spend.limit);
      if (usedCents === null && limitCents === null) return null;
      return { usedCents, limitCents };
    })(),
  };

  const hasSignal = normalized.totalPercentUsed !== null
    || normalized.autoPercentUsed !== null
    || normalized.apiPercentUsed !== null
    || normalized.includedSpendCents !== null;
  return hasSignal ? normalized : null;
}

/**
 * Build the best-effort fetcher the usage route calls. Token resolution: a
 * manually stored session token wins (headless hosts), otherwise the host's
 * Cursor IDE login is used automatically. Errors, missing or expired tokens
 * yield `null` so the card degrades to the estimated view.
 */
export function createCursorDashboardUsageFetcher({
  getSessionToken = () => '',
  readIdeTokenImpl = readCursorIdeSessionToken,
  fetchImpl = globalThis.fetch,
  url = CURSOR_DASHBOARD_USAGE_URL,
  timeoutMs = FETCH_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  let cachedIdeToken = null;
  let cachedIdeTokenAt = 0;
  const resolveIdeToken = () => {
    if (cachedIdeToken && now() - cachedIdeTokenAt < IDE_TOKEN_CACHE_MS) return cachedIdeToken;
    cachedIdeToken = readIdeTokenImpl() || null;
    cachedIdeTokenAt = now();
    return cachedIdeToken;
  };
  return async function fetchCursorDashboardUsage() {
    if (typeof fetchImpl !== 'function') return null;
    const token = String(getSessionToken() || '').trim() || resolveIdeToken();
    if (!token) return null;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Cookie: `WorkosCursorSessionToken=${token}`,
          Origin: 'https://cursor.com',
          'Content-Type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout?.(timeoutMs),
      });
      if (!response?.ok) return null;
      return normalizeCursorDashboardUsage(await response.json());
    } catch {
      return null;
    }
  };
}
