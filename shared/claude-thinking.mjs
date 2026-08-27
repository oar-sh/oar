// Per-conversation thinking control for the Claude worker: whether the CLI's
// extended thinking runs, and whether its text is visible in the transcript.
//
// THE RELAY'S DEFAULTS ARE ON + SUMMARIZED. copilot-remote deliberately takes
// a position here rather than deferring to the CLI: a relay you read on a
// phone is a place where seeing the model's reasoning is the point.
//
// There is deliberately no "host default" state on either axis:
//   - The worker sets no `settingSources`, so it loads no filesystem settings
//     — "host" only ever meant the CLI's built-in default, which is itself ON
//     for supported models. It was near-synonymous with On even before this.
//   - A host-default state has to be stored as SQL NULL, which is
//     indistinguishable from "never set". Once NULL resolves to the relay
//     default, picking "host default" would silently do nothing.
// So both axes are two-state, and NULL in the DB means "never set → relay
// default".
//
// Probed against the bundled CLI 2.1.226 / SDK 0.3.226 on 2026-08-26
// (docs/plans/claude-thinking-control.md → Probe results):
//
// - `enabled` — `Settings.alwaysThinkingEnabled`, honored at SPAWN in both
//   directions, but mid-session only ENABLING works: a mid-session `false` is
//   accepted and silently ignored, so turning thinking off takes effect at the
//   next CLI spawn.
// - `display` — 'summarized' (a readable summary of the reasoning; the raw
//   chain of thought is never exposed by the API on any setting) or 'omitted'
//   (the block still arrives, with empty text). Applies live both ways via
//   `setMaxThinkingTokens(budget, display)`. NOTE: display is visibility only
//   — the model thinks, and bills, identically either way, so 'omitted' is not
//   a cost control. `Thinking: Off` is.
//
// Shared so the browser control, the preferences write path and the worker
// agree; the browser mirror lives in
// server/public/app/claude-thinking-options.mjs (only server/public is served)
// and a unit test asserts the two stay identical.

/** Thinking runs unless the conversation explicitly turns it off. */
export const DEFAULT_THINKING_ENABLED = true;

/** Thoughts are visible unless the conversation explicitly hides them. */
export const DEFAULT_THINKING_DISPLAY = 'summarized';

export const THINKING_DISPLAY_MODES = Object.freeze(['summarized', 'omitted']);

/**
 * Normalize any stored/wire value onto the on/off state.
 *
 * Anything unusable — absent, NULL, junk, an older client's value — resolves
 * to the relay default (on) rather than silently disabling thinking.
 */
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

/** 'summarized' | 'omitted'; anything unusable is the default, never hidden by accident. */
export function parseThinkingDisplay(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'omitted' ? 'omitted' : DEFAULT_THINKING_DISPLAY;
}

/** Short label for the control ("On · visible", "Off · hidden"). */
export function formatThinkingLabel({ enabled = DEFAULT_THINKING_ENABLED, display = DEFAULT_THINKING_DISPLAY } = {}) {
  const enabledLabel = parseThinkingEnabled(enabled) ? 'On' : 'Off';
  const displayLabel = parseThinkingDisplay(display) === 'omitted' ? 'hidden' : 'visible';
  return `${enabledLabel} · ${displayLabel}`;
}

/**
 * What a queue delivery's `settings` should do to the worker's current
 * thinking state — the twin of `resolveDeliveredAutoCompactWindow`: an absent
 * key (an older relay that does not send these yet) keeps the last known
 * value, while a present key replaces it. Presence, not truthiness, decides —
 * a truthiness check would read an explicit `false` as "not mentioned" and
 * make turning thinking off impossible.
 *
 * @param {{enabled: boolean, display: string}|null} current
 * @param {object|null|undefined} settings the delivery's settings bag
 * @returns {{enabled: boolean, display: string}}
 */
export function resolveDeliveredThinking(current, settings) {
  const base = {
    enabled: parseThinkingEnabled(current?.enabled),
    display: parseThinkingDisplay(current?.display),
  };
  if (!settings || typeof settings !== 'object') return base;
  if (Object.prototype.hasOwnProperty.call(settings, 'thinkingEnabled')) {
    base.enabled = parseThinkingEnabled(settings.thinkingEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(settings, 'thinkingDisplay')) {
    base.display = parseThinkingDisplay(settings.thinkingDisplay);
  }
  return base;
}
