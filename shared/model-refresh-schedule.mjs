// "Check for new models" (Settings → General → Models): the relay asks each
// enabled provider for its model list on a timer, skipping a provider whose
// list was refreshed recently by anything (the Refresh button, a settings
// save, a login, an install, the boot). Relay-wide app_settings keys:
//
//   model_refresh_auto            'true' / 'false'; absent = on
//   model_refresh_interval_hours  6 / 12 / 24 / 72 / 168; absent = 24
//   model_refresh_excluded        JSON list of provider ids left out; absent = none
//   model_refresh_last            JSON { <provider>: { at, ok, error, lastOkAt, lastFailureAt } }

export const MODEL_REFRESH_AUTO_SETTING_KEY = 'model_refresh_auto';
export const MODEL_REFRESH_INTERVAL_HOURS_SETTING_KEY = 'model_refresh_interval_hours';
export const MODEL_REFRESH_EXCLUDED_SETTING_KEY = 'model_refresh_excluded';
export const MODEL_REFRESH_LAST_SETTING_KEY = 'model_refresh_last';

export const DEFAULT_MODEL_REFRESH_AUTO = true;
export const MODEL_REFRESH_INTERVAL_HOURS_CHOICES = Object.freeze([6, 12, 24, 72, 168]);
export const DEFAULT_MODEL_REFRESH_INTERVAL_HOURS = 24;
// A failed check is tried again at most this often, whatever the interval.
export const MODEL_REFRESH_FAILURE_RETRY_MS = 60 * 60 * 1000;
// The first look a minute after boot (overdue providers are checked then),
// then every quarter of an hour.
export const MODEL_REFRESH_FIRST_TICK_MS = 60 * 1000;
export const MODEL_REFRESH_TICK_MS = 15 * 60 * 1000;

// The providers in the order Settings and Select Models list them; `github`
// is Copilot. `tab` is the provider's Select Models tab.
export const MODEL_REFRESH_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'github', label: 'Copilot', tab: 'copilot' }),
  Object.freeze({ id: 'openai', label: 'OpenAI', tab: 'openai' }),
  Object.freeze({ id: 'claude', label: 'Claude', tab: 'anthropic' }),
  Object.freeze({ id: 'claude-api', label: 'Claude API', tab: 'claude-api' }),
  Object.freeze({ id: 'cursor', label: 'Cursor', tab: 'cursor' }),
  Object.freeze({ id: 'grok', label: 'Grok', tab: 'grok' }),
  Object.freeze({ id: 'deepseek', label: 'DeepSeek', tab: 'deepseek' }),
]);
const PROVIDER_IDS = new Set(MODEL_REFRESH_PROVIDERS.map((provider) => provider.id));

export function modelRefreshProvider(id) {
  return MODEL_REFRESH_PROVIDERS.find((provider) => provider.id === String(id || '').trim().toLowerCase()) || null;
}

/** An unset or unreadable setting is on. */
export function readModelRefreshAutoSetting(storedValue) {
  const text = String(storedValue ?? '').trim().toLowerCase();
  if (text === 'false') return false;
  if (text === 'true') return true;
  return DEFAULT_MODEL_REFRESH_AUTO;
}

export function parseModelRefreshAutoUpdate(value) {
  if (typeof value !== 'boolean') return { ok: false, error: 'auto must be true or false' };
  return { ok: true, auto: value };
}

/** One of the choices; an unset or unknown value is the default. */
export function readModelRefreshIntervalHoursSetting(storedValue) {
  const hours = Number(String(storedValue ?? '').trim());
  return MODEL_REFRESH_INTERVAL_HOURS_CHOICES.includes(hours) ? hours : DEFAULT_MODEL_REFRESH_INTERVAL_HOURS;
}

export function parseModelRefreshIntervalHoursUpdate(value) {
  const hours = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN);
  if (!MODEL_REFRESH_INTERVAL_HOURS_CHOICES.includes(hours)) {
    return { ok: false, error: `intervalHours must be one of ${MODEL_REFRESH_INTERVAL_HOURS_CHOICES.join(', ')}` };
  }
  return { ok: true, intervalHours: hours };
}

function knownProviderIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => PROVIDER_IDS.has(value)))];
}

/** The providers left out of the check; unknown ids are dropped. */
export function readModelRefreshExcludedSetting(storedValue) {
  try {
    return knownProviderIds(JSON.parse(String(storedValue || '[]')));
  } catch {
    return [];
  }
}

export function parseModelRefreshExcludedUpdate(value) {
  if (!Array.isArray(value)) return { ok: false, error: 'excluded must be a list of provider ids' };
  const unknown = value.map((entry) => String(entry || '').trim().toLowerCase()).filter((entry) => entry && !PROVIDER_IDS.has(entry));
  if (unknown.length) return { ok: false, error: `Unknown provider: ${unknown[0]}` };
  return { ok: true, excluded: knownProviderIds(value) };
}

function isoOrNull(value) {
  const text = String(value ?? '').trim();
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

/** The last refresh of each provider; entries that cannot be read are dropped. */
export function readModelRefreshLastSetting(storedValue) {
  let parsed;
  try {
    parsed = JSON.parse(String(storedValue || '{}'));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(parsed)) {
    if (!PROVIDER_IDS.has(id) || !entry || typeof entry !== 'object') continue;
    const at = isoOrNull(entry.at);
    if (!at) continue;
    out[id] = {
      at,
      ok: entry.ok === true,
      error: entry.ok === true ? null : (String(entry.error || '').trim().slice(0, 300) || null),
      lastOkAt: isoOrNull(entry.lastOkAt),
      lastFailureAt: isoOrNull(entry.lastFailureAt),
    };
  }
  return out;
}
