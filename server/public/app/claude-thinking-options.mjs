// Mirrors shared/claude-thinking.mjs, which the browser cannot import (only
// server/public is served). shared/claude-thinking.test.mjs asserts the two
// stay identical.
//
// Relay defaults: thinking ON, thoughts VISIBLE (summarized). Two states per
// axis — there is no "host default", because it could only be stored as SQL
// NULL, which is indistinguishable from "never set" once NULL means the relay
// default. Turning thinking off applies at the next CLI spawn (the CLI ignores
// a mid-session disable); everything else applies on the next message.

export const DEFAULT_THINKING_ENABLED = true;

export const DEFAULT_THINKING_DISPLAY = 'summarized';

export const THINKING_DISPLAY_MODES = Object.freeze(['summarized', 'omitted']);

export function parseThinkingEnabled(value) {
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'false' || text === '0' || text === 'off') return false;
    if (text === 'true' || text === '1' || text === 'on') return true;
    return DEFAULT_THINKING_ENABLED;
  }
  if (value === true || value === 1) return true;
  return DEFAULT_THINKING_ENABLED;
}

export function parseThinkingDisplay(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'omitted' ? 'omitted' : DEFAULT_THINKING_DISPLAY;
}

export function formatThinkingLabel({ enabled = DEFAULT_THINKING_ENABLED, display = DEFAULT_THINKING_DISPLAY } = {}) {
  const enabledLabel = parseThinkingEnabled(enabled) ? 'On' : 'Off';
  const displayLabel = parseThinkingDisplay(display) === 'omitted' ? 'hidden' : 'visible';
  return `${enabledLabel} · ${displayLabel}`;
}
