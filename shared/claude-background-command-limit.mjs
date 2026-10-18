// How long a backgrounded Bash command of a Claude session may run before
// Claude Code stops it, when the agent passes no `timeout` of its own. The
// CLI's own default is 30 minutes; long test or GPU runs were cut off there.
//
// Shared so the settings slider, the relay that stores the value and the
// worker that hands it to the CLI agree on bounds, steps and formatting. The
// browser mirrors the default in
// server/public/app/claude-background-command-limit-options.mjs (only
// server/public is served), and the slider's static markup in
// server/public/index.html starts at it; unit tests pin both to this module.

export const CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES = 30;
export const CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES = 480;
export const CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES = 30;
export const DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES = 120;

/** Clamped to 30 min … 8 h and snapped to the slider's 30-minute steps. */
export function normalizeClaudeBackgroundCommandLimitMinutes(value, fallback = DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const step = CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES;
  const snapped = Math.round(numeric / step) * step;
  return Math.min(
    CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES,
    Math.max(CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES, snapped),
  );
}

export function claudeBackgroundCommandLimitMinutesToMs(minutes) {
  return normalizeClaudeBackgroundCommandLimitMinutes(minutes) * 60_000;
}

export const DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MS = DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES * 60_000;

/** An unset setting means "never configured", which is the default. */
export function readClaudeBackgroundCommandLimitSetting(storedValue) {
  const text = storedValue === null || storedValue === undefined ? '' : String(storedValue).trim();
  return normalizeClaudeBackgroundCommandLimitMinutes(text);
}

export function parseClaudeBackgroundCommandLimitUpdate(value) {
  const minutes = normalizeClaudeBackgroundCommandLimitMinutes(value, null);
  if (minutes === null) return { ok: false, error: 'backgroundCommandLimitMinutes must be a number' };
  return { ok: true, minutes };
}

export function formatClaudeBackgroundCommandLimitLabel(minutes) {
  const normalized = normalizeClaudeBackgroundCommandLimitMinutes(minutes);
  if (normalized < 60) return `${normalized} min`;
  const hours = Math.floor(normalized / 60);
  const remainder = normalized % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

/** The fields every Claude settings payload carries for the slider. */
export function claudeBackgroundCommandLimitSettingsFields(settings = {}) {
  return {
    backgroundCommandLimitMinutes: normalizeClaudeBackgroundCommandLimitMinutes(settings?.backgroundCommandLimitMinutes),
    backgroundCommandLimitMinMinutes: CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES,
    backgroundCommandLimitMaxMinutes: CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES,
    backgroundCommandLimitStepMinutes: CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES,
    backgroundCommandLimitDefaultMinutes: DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES,
  };
}

/**
 * What a delivery's `settings` does to the worker's limit (ms): an absent or
 * junk key (an older relay) keeps the last known value; a present one is
 * clamped like the setting itself.
 */
export function resolveDeliveredClaudeBackgroundCommandLimitMs(current, settings) {
  const kept = Number.isFinite(Number(current)) && Number(current) > 0
    ? claudeBackgroundCommandLimitMinutesToMs(Number(current) / 60_000)
    : DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MS;
  if (!settings || typeof settings !== 'object') return kept;
  if (!Object.prototype.hasOwnProperty.call(settings, 'claudeBackgroundCommandLimitMs')) return kept;
  const delivered = Number(settings.claudeBackgroundCommandLimitMs);
  if (settings.claudeBackgroundCommandLimitMs === null || !Number.isFinite(delivered) || delivered <= 0) return kept;
  return claudeBackgroundCommandLimitMinutesToMs(delivered / 60_000);
}
