// Pure helpers for Settings → Relays → Agent sessions: whether agents may
// start and use sessions on this relay, and the longest time one remote_relay
// call may wait. DOM-free on purpose, like claude-cloud-ui.mjs: the section
// (agent-sessions-settings-ui.js) owns the elements, this module the decisions.
//
// One payload shape everywhere — GET and POST /api/settings/agent-sessions and
// the `agent_sessions_settings_updated` socket event:
//   { enabled, maxWaitSeconds, limits: { minWaitSeconds, maxWaitSeconds, stepSeconds }, maxActiveSessions }
// The relay stores seconds; the slider works in seconds too and only its label
// speaks minutes.

export const AGENT_SESSIONS_SOCKET_EVENT = 'agent_sessions_settings_updated';

// What the relay enforces when it says nothing else; the markup starts there.
export const AGENT_SESSIONS_DEFAULT_WAIT_SECONDS = 600;
export const AGENT_SESSIONS_DEFAULT_LIMITS = Object.freeze({
  minWaitSeconds: 120,
  maxWaitSeconds: 3600,
  stepSeconds: 60,
});

function positiveNumber(value) {
  // No coercion of null, '' or true into a number.
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** The slider's range and step in seconds; anything unusable falls back. */
export function normalizeAgentSessionsLimits(raw, fallback = AGENT_SESSIONS_DEFAULT_LIMITS) {
  const minWaitSeconds = positiveNumber(raw?.minWaitSeconds) ?? fallback.minWaitSeconds;
  const maxCandidate = positiveNumber(raw?.maxWaitSeconds) ?? fallback.maxWaitSeconds;
  return {
    minWaitSeconds,
    maxWaitSeconds: Math.max(minWaitSeconds, maxCandidate),
    stepSeconds: positiveNumber(raw?.stepSeconds) ?? fallback.stepSeconds,
  };
}

/**
 * A wait the relay will accept: inside the limits and on a step counted from
 * the minimum. Something that is not a number becomes `fallback`, clamped the
 * same way.
 */
export function clampWaitSeconds(value, limits = AGENT_SESSIONS_DEFAULT_LIMITS, fallback = AGENT_SESSIONS_DEFAULT_WAIT_SECONDS) {
  const { minWaitSeconds: min, maxWaitSeconds: max, stepSeconds: step } = normalizeAgentSessionsLimits(limits);
  const wanted = positiveNumber(value) ?? positiveNumber(fallback) ?? min;
  const bounded = Math.min(max, Math.max(min, wanted));
  const stepped = min + Math.round((bounded - min) / step) * step;
  // The last step may overshoot a maximum that is not on the grid.
  return stepped > max ? min + Math.floor((max - min) / step) * step : stepped;
}

/** 600 → "10 min", 150 → "2.5 min"; '' for something that is not a duration. */
export function formatWaitMinutesLabel(seconds) {
  const value = positiveNumber(seconds);
  if (value === null) return '';
  return `${Math.round((value / 60) * 10) / 10} min`;
}

/**
 * The section's state from a payload. A field the payload does not carry keeps
 * what `previous` had (the first payload falls back to "off" and the defaults).
 */
export function normalizeAgentSessionsSettings(payload, previous = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return previous;
  const limits = payload.limits && typeof payload.limits === 'object'
    ? normalizeAgentSessionsLimits(payload.limits)
    : (previous?.limits || { ...AGENT_SESSIONS_DEFAULT_LIMITS });
  const maxActive = positiveNumber(payload.maxActiveSessions);
  return {
    enabled: typeof payload.enabled === 'boolean' ? payload.enabled : previous?.enabled === true,
    maxWaitSeconds: positiveNumber(payload.maxWaitSeconds)
      ?? previous?.maxWaitSeconds
      ?? AGENT_SESSIONS_DEFAULT_WAIT_SECONDS,
    limits,
    maxActiveSessions: maxActive !== null ? Math.floor(maxActive) : (previous?.maxActiveSessions ?? null),
  };
}

/**
 * What an answer to the GET means for the section:
 *   'loaded'      — the settings; show the section.
 *   'unsupported' — an older relay without the route (404, or a 200 that is not
 *                   the settings); hide the section.
 *   'failed'      — the relay could not be asked (offline, paused, 5xx); keep
 *                   what is shown.
 */
export function classifyAgentSessionsLoad(result) {
  if (!result || typeof result !== 'object') return 'failed';
  if (result.ok === true) return typeof result.enabled === 'boolean' ? 'loaded' : 'unsupported';
  return Number(result.status) === 404 ? 'unsupported' : 'failed';
}

/**
 * Everything the section draws, from its state. `settings` is null until the
 * relay answered; `unsupported` hides the section for good; `loadFailed` shows
 * it switched off with a note when the very first read failed.
 */
export function agentSessionsViewModel({ settings = null, unsupported = false, loadFailed = false, saving = false } = {}) {
  const known = !!settings && !unsupported;
  const limits = normalizeAgentSessionsLimits(settings?.limits);
  const value = positiveNumber(settings?.maxWaitSeconds) ?? AGENT_SESSIONS_DEFAULT_WAIT_SECONDS;
  const cap = positiveNumber(settings?.maxActiveSessions);
  return {
    hidden: unsupported || (!settings && !loadFailed),
    toggle: {
      checked: known && settings.enabled === true,
      disabled: !known || saving,
    },
    slider: {
      min: limits.minWaitSeconds,
      max: limits.maxWaitSeconds,
      step: limits.stepSeconds,
      value,
      label: formatWaitMinutesLabel(value),
      // Not tied to the switch: the limit also governs waits on paired relays.
      disabled: !known || saving,
    },
    capText: known && cap !== null
      ? `At most ${Math.floor(cap)} of them work at the same time per conversation.`
      : '',
  };
}

/** The status line after a save the relay accepted. */
export function agentSessionsSavedText(change, settings) {
  if (change === 'enabled') {
    return settings?.enabled === true
      ? 'Agents may start and use sessions on this relay now.'
      : 'Agents can no longer start or use sessions on this relay.';
  }
  return `Agents may wait up to ${formatWaitMinutesLabel(settings?.maxWaitSeconds)} per tool call.`;
}
