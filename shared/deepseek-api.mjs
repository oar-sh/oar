// A small client for the two DeepSeek endpoints the relay calls itself:
// `GET /models` (model discovery) and `GET /user/balance` (the usage card).
// Turns do not go through here: the session worker runs Claude Code against
// DeepSeek's Anthropic-compatible endpoint (`deepseekAnthropicBaseUrl`).
//
// The API key is sent to the configured base URL and nowhere else, and it is
// in no error this module produces: a response body is quoted only after the
// key has been taken out of it.

import { DEFAULT_DEEPSEEK_BASE_URL } from './deepseek-models.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * The base URL as stored: `https:` on any host, or `http:` on a loopback host
 * (a local proxy, a capture tool, the tests' fake API). No credentials, query
 * or fragment; trailing slashes are dropped. An empty value is the default.
 */
export function normalizeDeepSeekBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: true, baseUrl: DEFAULT_DEEPSEEK_BASE_URL };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'The DeepSeek base URL is not a valid URL' };
  }
  if (url.username || url.password) return { ok: false, error: 'The DeepSeek base URL must not contain credentials' };
  if (url.search || url.hash) return { ok: false, error: 'The DeepSeek base URL must not contain a query or fragment' };
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, error: 'The DeepSeek base URL must use https (http only on a loopback address)' };
  }
  const baseUrl = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  return { ok: true, baseUrl };
}

/** Where Claude Code is pointed for DeepSeek turns. */
export function deepseekAnthropicBaseUrl(baseUrl = DEFAULT_DEEPSEEK_BASE_URL) {
  const normalized = normalizeDeepSeekBaseUrl(baseUrl);
  return `${normalized.ok ? normalized.baseUrl : DEFAULT_DEEPSEEK_BASE_URL}/anthropic`;
}

export class DeepSeekApiError extends Error {
  constructor(message, { code = 'error', status = null } = {}) {
    super(message);
    this.name = 'DeepSeekApiError';
    this.code = code;
    this.status = status;
  }
}

function codeForStatus(status) {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 402) return 'insufficient_balance';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'transient';
  return 'error';
}

function redact(text, apiKey) {
  const value = String(text ?? '');
  const key = String(apiKey ?? '').trim();
  return key ? value.split(key).join('[redacted]') : value;
}

function toAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createDeepSeekApiClient({
  baseUrl = DEFAULT_DEEPSEEK_BASE_URL,
  apiKey = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalized = normalizeDeepSeekBaseUrl(baseUrl);
  const key = String(apiKey ?? '').trim();

  async function getJson(pathname, what) {
    if (!normalized.ok) throw new DeepSeekApiError(normalized.error, { code: 'invalid_base_url' });
    if (!key) throw new DeepSeekApiError('DeepSeek API key is not configured', { code: 'not_configured' });
    let response;
    try {
      response = await fetchImpl(`${normalized.baseUrl}${pathname}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new DeepSeekApiError(`DeepSeek ${what} failed: ${redact(error?.message || error, key)}`, { code: 'network' });
    }
    if (!response.ok) {
      const detail = redact(String(await response.text().catch(() => '')).trim(), key).slice(0, 240);
      throw new DeepSeekApiError(
        `DeepSeek ${what} failed (${response.status})${detail ? `: ${detail}` : ''}`,
        { code: codeForStatus(response.status), status: response.status },
      );
    }
    try {
      return await response.json();
    } catch {
      throw new DeepSeekApiError(`DeepSeek ${what} returned invalid JSON`, { code: 'invalid_response' });
    }
  }

  return {
    baseUrl: normalized.ok ? normalized.baseUrl : '',

    /** The model ids `GET /models` lists, in its order, without duplicates. */
    async listModels() {
      const payload = await getJson('/models', 'model discovery');
      const ids = (Array.isArray(payload?.data) ? payload.data : [])
        .map((entry) => String(entry?.id ?? '').trim())
        .filter(Boolean);
      return Array.from(new Set(ids));
    },

    /**
     * `GET /user/balance`: `{ isAvailable, balances: [{ currency, total,
     * granted, toppedUp }] }`, amounts as numbers (DeepSeek sends strings).
     */
    async getBalance() {
      const payload = await getJson('/user/balance', 'balance check');
      const balances = (Array.isArray(payload?.balance_infos) ? payload.balance_infos : [])
        .map((entry) => ({
          currency: String(entry?.currency ?? '').trim().toUpperCase(),
          total: toAmount(entry?.total_balance),
          granted: toAmount(entry?.granted_balance),
          toppedUp: toAmount(entry?.topped_up_balance),
        }))
        .filter((entry) => entry.currency);
      return { isAvailable: payload?.is_available === true, balances };
    },
  };
}
