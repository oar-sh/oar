// A small client for the one Anthropic endpoint the relay calls itself with a
// Claude API key: `GET /v1/models`, the model discovery of the Claude API
// provider (Settings → Providers → Claude API). Turns do not go through here:
// the session worker runs Claude Code on the key.
//
// The key goes to the Anthropic API and nowhere else. The only other target
// is a fake API on the loopback interface, named by OAR_ANTHROPIC_API_BASE_URL
// for tests; any other value of that variable is ignored (the rule of
// shared/claude-cloud/base-url.mjs, which this module reuses). There is no
// base-URL setting and no parameter that takes one.
//
// The key is in no error this module produces: a response body is quoted only
// after the key has been taken out of it.

import { loopbackBaseUrlOrNull } from './claude-cloud/base-url.mjs';

export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_API_BASE_URL_ENV = 'OAR_ANTHROPIC_API_BASE_URL';
export const ANTHROPIC_API_VERSION = '2023-06-01';

const DEFAULT_TIMEOUT_MS = 10_000;
// The largest page `GET /v1/models` serves.
const MODELS_PAGE_LIMIT = 1000;
// One page holds every model today; the cap keeps a cursor that never ends
// from turning into an endless walk.
const MAX_MODEL_PAGES = 20;
const MAX_DETAIL_CHARS = 240;
// The effort levels the Models API reports per model, in ladder order.
const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The base URL for the client: the loopback URL named by
 * OAR_ANTHROPIC_API_BASE_URL, else the Anthropic API.
 */
export function resolveAnthropicApiBaseUrl(env = process.env) {
  return loopbackBaseUrlOrNull(env?.[ANTHROPIC_API_BASE_URL_ENV]) || ANTHROPIC_API_BASE_URL;
}

export class AnthropicApiError extends Error {
  constructor(message, { code = 'error', status = null } = {}) {
    super(message);
    this.name = 'AnthropicApiError';
    this.code = code;
    this.status = status;
  }
}

function codeForStatus(status) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'transient';
  return 'error';
}

function redact(text, apiKey) {
  const value = String(text ?? '');
  const key = String(apiKey ?? '').trim();
  return key ? value.split(key).join('[redacted]') : value;
}

function toText(value) {
  return String(value ?? '').trim();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

/**
 * A capability as the API writes it (`{ supported: true }`) or as a plain
 * boolean; null when it is missing or of another shape.
 */
function capabilitySupported(value) {
  if (typeof value === 'boolean') return value;
  if (value && typeof value === 'object' && typeof value.supported === 'boolean') return value.supported;
  return null;
}

/** `{ type: 'error', error: { type, message } }` as one line, or the raw text. */
function errorDetail(text) {
  const raw = toText(text);
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const type = toText(parsed?.error?.type);
    const message = toText(parsed?.error?.message);
    if (type || message) return [type, message].filter(Boolean).join(': ');
  } catch {
    // Not JSON: the text as it came.
  }
  return raw;
}

/**
 * One entry of `GET /v1/models` in OAR's terms, or null without an id:
 * `{ id, displayName, contextWindow, maxOutput, imageInput, effort,
 * effortLevels, thinking, thinkingTypes }`. Every field but the id may be
 * missing in an answer, so each one is null (or an empty list) then.
 */
export function mapAnthropicModel(entry) {
  const id = toText(entry?.id);
  if (!id) return null;
  const capabilities = entry?.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
  const effort = capabilities.effort;
  const effortObject = effort && typeof effort === 'object' ? effort : {};
  const thinking = capabilities.thinking;
  const thinkingTypesObject = thinking && typeof thinking === 'object' && thinking.types && typeof thinking.types === 'object'
    ? thinking.types
    : {};
  return {
    id,
    displayName: toText(entry?.display_name) || id,
    contextWindow: positiveInteger(entry?.max_input_tokens),
    maxOutput: positiveInteger(entry?.max_tokens),
    imageInput: capabilitySupported(capabilities.image_input),
    effort: capabilitySupported(effort),
    effortLevels: EFFORT_LEVELS.filter((level) => capabilitySupported(effortObject[level]) === true),
    thinking: capabilitySupported(thinking),
    thinkingTypes: Object.keys(thinkingTypesObject)
      .filter((type) => capabilitySupported(thinkingTypesObject[type]) === true)
      .map((type) => type.toLowerCase()),
  };
}

export function createAnthropicApiClient({
  apiKey = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const baseUrl = resolveAnthropicApiBaseUrl(env);
  const key = toText(apiKey);

  async function getJson(pathname, what) {
    if (!key) throw new AnthropicApiError('Claude API key is not configured', { code: 'not_configured' });
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${pathname}`, {
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_API_VERSION,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new AnthropicApiError(
        timedOut
          ? `Anthropic ${what} timed out after ${timeoutMs} ms`
          : `Anthropic ${what} failed: ${redact(error?.message || error, key)}`,
        { code: timedOut ? 'timeout' : 'network' },
      );
    }
    if (!response.ok) {
      const detail = redact(errorDetail(await response.text().catch(() => '')), key).slice(0, MAX_DETAIL_CHARS);
      throw new AnthropicApiError(
        `Anthropic ${what} failed (${response.status})${detail ? `: ${detail}` : ''}`,
        { code: codeForStatus(response.status), status: response.status },
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AnthropicApiError(`Anthropic ${what} returned invalid JSON`, { code: 'invalid_response' });
    }
  }

  return {
    baseUrl,

    /**
     * Every model the key may use (mapAnthropicModel), in the API's order,
     * without duplicates. Follows `has_more` / `last_id` page by page.
     */
    async listModels() {
      const models = [];
      const seen = new Set();
      const cursors = new Set();
      let afterId = '';
      for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(MODELS_PAGE_LIMIT) });
        if (afterId) query.set('after_id', afterId);
        const payload = await getJson(`/v1/models?${query.toString()}`, 'model discovery');
        for (const entry of Array.isArray(payload?.data) ? payload.data : []) {
          const model = mapAnthropicModel(entry);
          if (!model || seen.has(model.id)) continue;
          seen.add(model.id);
          models.push(model);
        }
        const lastId = toText(payload?.last_id);
        if (payload?.has_more !== true || !lastId || cursors.has(lastId)) break;
        cursors.add(lastId);
        afterId = lastId;
      }
      return models;
    },
  };
}
