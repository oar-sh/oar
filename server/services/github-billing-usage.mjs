'use strict';

/**
 * Optional personal-scope GitHub billing usage.
 *
 * This is strictly additive detail on top of the quota snapshot: the billing
 * REST endpoints require a classic PAT with billing scope (fine-grained tokens
 * are explicitly unsupported), which a plain `gh auth token` usually is not.
 * Every failure path therefore returns `{ error }` rather than throwing, so the
 * Copilot card still renders its meters.
 *
 * Scope is personal only — no organization or enterprise probing.
 */

const API_ROOT = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function getJson(url, token, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { headers: authHeaders(token), signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const compact = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const error = new Error(`HTTP ${response.status}${compact ? `: ${compact}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(error) {
  const status = Number(error?.status);
  if (status === 403) return 'the token lacks billing permissions (a classic PAT with the manage_billing scope is required)';
  if (status === 404) return 'no billing report is available for this account';
  if (status === 401) return 'the token is not authorized for billing data';
  return String(error?.message || error || 'unknown error');
}

/**
 * Whether the failure is about *access* rather than a transient fault. These
 * verdicts do not change between two opens of the usage modal, so the caller
 * caches them instead of paying for the same doomed requests every time.
 */
function isAccessFailure(error) {
  const status = Number(error?.status);
  return status === 401 || status === 403 || status === 404;
}

/**
 * @returns {Promise<{items: object[], timePeriod: object|null, scope: string|null, error: string|null, denied: boolean}>}
 *   `denied` means every candidate refused on access grounds — worth caching.
 */
export async function fetchPersonalBillingUsage({
  token,
  login = '',
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const authToken = String(token || '').trim();
  if (!authToken) return { items: [], timePeriod: null, scope: null, error: 'no GitHub token available', denied: false };
  if (typeof fetchImpl !== 'function') {
    return { items: [], timePeriod: null, scope: null, error: 'fetch is unavailable', denied: false };
  }

  // A caller-supplied login skips this round trip entirely; the relay caches
  // the resolved name so only the first billing read pays for it.
  let username = String(login || '').trim();
  if (!username) {
    try {
      const user = await getJson(`${API_ROOT}/user`, authToken, fetchImpl);
      username = String(user?.login || '').trim();
    } catch (error) {
      return { items: [], timePeriod: null, scope: null, error: describeFailure(error), denied: isAccessFailure(error) };
    }
  }
  if (!username) {
    return { items: [], timePeriod: null, scope: null, error: 'could not resolve the GitHub username', denied: false };
  }

  const reference = now();
  const date = reference instanceof Date && !Number.isNaN(reference.getTime()) ? reference : new Date();
  const query = `year=${date.getUTCFullYear()}&month=${date.getUTCMonth() + 1}`;
  const encodedUser = encodeURIComponent(username);

  // AI credits is the current metering unit; premium requests is the legacy
  // report and is still the only one populated on older plans.
  const candidates = [
    `${API_ROOT}/users/${encodedUser}/settings/billing/ai_credit/usage?${query}`,
    `${API_ROOT}/users/${encodedUser}/settings/billing/premium_request/usage?${query}`,
  ];

  let lastError = null;
  // Only an all-access-failure verdict is cacheable: an endpoint that answered
  // with an empty period simply has no usage yet and will have some later.
  let denied = true;
  for (const url of candidates) {
    try {
      const payload = await getJson(url, authToken, fetchImpl);
      const items = Array.isArray(payload?.usageItems) ? payload.usageItems : [];
      denied = false;
      if (!items.length) {
        lastError = lastError || 'no billed usage reported for this period';
        continue;
      }
      return {
        items,
        timePeriod: payload?.timePeriod || null,
        scope: username,
        error: null,
        denied: false,
      };
    } catch (error) {
      if (!isAccessFailure(error)) denied = false;
      lastError = describeFailure(error);
    }
  }

  return { items: [], timePeriod: null, scope: username, error: lastError || 'billing usage is unavailable', denied };
}
