// Mirrors shared/claude-background-command-limit.mjs, which the browser cannot
// import (only server/public is served).
// shared/claude-background-command-limit.test.mjs asserts the two stay
// identical.
//
// The Claude settings slider shows the default until the relay's own value
// loads; the authoritative bounds come from GET /api/settings/claude.

export const DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES = 120;
export const CLAUDE_BACKGROUND_COMMAND_LIMIT_MIN_MINUTES = 30;
export const CLAUDE_BACKGROUND_COMMAND_LIMIT_MAX_MINUTES = 480;
export const CLAUDE_BACKGROUND_COMMAND_LIMIT_STEP_MINUTES = 30;

export function formatClaudeBackgroundCommandLimitLabel(minutes) {
  const numeric = Math.round(Number(minutes));
  const value = Number.isFinite(numeric) && numeric > 0 ? numeric : DEFAULT_CLAUDE_BACKGROUND_COMMAND_LIMIT_MINUTES;
  if (value < 60) return `${value} min`;
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}
