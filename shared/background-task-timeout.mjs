// Ceiling on how long background tasks alone may keep a conversation's
// persistent Claude CLI process alive, shared so the settings slider and the
// worker enforcing it agree on bounds and formatting.
//
// 0 means no limit — the default: a process holding live tasks stays up until
// the tasks finish, the user stops them from the composer panel, or the
// worker/relay goes down. Mirrors shared/turn-ceiling.mjs.

export const BACKGROUND_TASK_TIMEOUT_MIN_MINUTES = 0;
export const BACKGROUND_TASK_TIMEOUT_MAX_MINUTES = 600;
export const BACKGROUND_TASK_TIMEOUT_STEP_MINUTES = 5;
export const DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES = 0;

/** 0 disables the timeout entirely (unlimited). */
export function normalizeBackgroundTaskTimeoutMinutes(value, fallback = DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES) {
  // Number('') and Number(null) are both 0, which would silently read as
  // "no limit". Absent input is absent, not a request to disable the timeout.
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  if (rounded <= BACKGROUND_TASK_TIMEOUT_MIN_MINUTES) return 0;
  return Math.min(BACKGROUND_TASK_TIMEOUT_MAX_MINUTES, rounded);
}

export function backgroundTaskTimeoutMinutesToMs(minutes) {
  return normalizeBackgroundTaskTimeoutMinutes(minutes) * 60_000;
}

/** An unset setting means "never configured", which is the default — not 0. */
export function readBackgroundTaskTimeoutSetting(storedValue) {
  const text = storedValue === null || storedValue === undefined ? '' : String(storedValue).trim();
  if (!text) return DEFAULT_BACKGROUND_TASK_TIMEOUT_MINUTES;
  return normalizeBackgroundTaskTimeoutMinutes(text);
}

export function parseBackgroundTaskTimeoutUpdate(value) {
  const minutes = normalizeBackgroundTaskTimeoutMinutes(value, null);
  if (minutes === null) return { ok: false, error: 'timeoutMinutes must be a number' };
  return { ok: true, minutes };
}

export function formatBackgroundTaskTimeoutLabel(minutes) {
  const normalized = normalizeBackgroundTaskTimeoutMinutes(minutes);
  if (normalized === 0) return 'No limit';
  if (normalized < 60) return `${normalized} min`;
  const hours = Math.floor(normalized / 60);
  const remainder = normalized % 60;
  const hourLabel = `${hours} h`;
  return remainder ? `${hourLabel} ${remainder} min` : hourLabel;
}
