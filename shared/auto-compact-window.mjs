// The per-conversation auto-compact window: how many tokens of context the
// Claude CLI is allowed to accumulate before it compacts the conversation.
//
// This is a TOKEN COUNT, not a percentage — `Settings.autoCompactWindow` in the
// bundled CLI is compared directly against the model's context window, and the
// effective threshold is `min(setting, model max)`. Unset (null) means "Auto":
// the CLI keeps its model-tuned default (e.g. 967k on a 1M-window model), which
// is what `autoCompactThreshold` in the context-usage payload reports.
//
// Shared so the slider, the preferences write path and the worker all agree on
// the same discrete stops; the browser mirrors these constants in
// server/public/app/auto-compact-window-options.mjs (only server/public is
// served) and a unit test asserts the two lists stay identical.

/** Index 0 is `null` = Auto (model default). Every other stop is a token count. */
export const AUTO_COMPACT_WINDOW_STOPS = Object.freeze([
  null,
  50_000,
  100_000,
  150_000,
  200_000,
  300_000,
  500_000,
  1_000_000,
]);

const NUMERIC_STOPS = AUTO_COMPACT_WINDOW_STOPS.filter((stop) => stop !== null);

/**
 * Normalize any stored/wire value onto a stop.
 *
 * Absent, blank, 'auto', <= 0 and junk all mean Auto (null) — there is no
 * "disabled" state, so anything unusable falls back to the model default rather
 * than pinning an arbitrary window.
 */
export function parseAutoCompactWindow(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (!text || text === 'auto' || text === 'null') return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  // Snap to the nearest stop so a hand-edited row or an older client's value
  // still lands on something the slider can represent.
  let best = NUMERIC_STOPS[0];
  let bestDistance = Math.abs(numeric - best);
  for (const stop of NUMERIC_STOPS) {
    const distance = Math.abs(numeric - stop);
    if (distance < bestDistance) {
      best = stop;
      bestDistance = distance;
    }
  }
  return best;
}

/** 'Auto' | '50k' | '1M' — the slider's own label, so it must stay short. */
export function formatAutoCompactWindowLabel(value) {
  const window = parseAutoCompactWindow(value);
  if (window === null) return 'Auto';
  if (window >= 1_000_000) {
    const millions = window / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(window / 1000)}k`;
}

export function autoCompactWindowToIndex(value) {
  const window = parseAutoCompactWindow(value);
  const index = AUTO_COMPACT_WINDOW_STOPS.indexOf(window);
  return index >= 0 ? index : 0;
}

/**
 * What a queue delivery's `settings` should do to the worker's current window.
 *
 * Old relays omit `autoCompactWindow` entirely; that must keep whatever the
 * worker already had rather than silently resetting the pin. An explicit
 * `null` (or anything unusable) is the user choosing Auto and must clear it —
 * so the key's *presence*, not its truthiness, decides. A truthiness check
 * here would collapse both cases and break "return to Auto".
 *
 * Not snapped: the worker forwards the value to the CLI as-is, and the write
 * path already snapped it.
 *
 * @param {number|null} current the worker's last known window
 * @param {object|null|undefined} settings the delivery's settings bag
 * @returns {number|null}
 */
export function resolveDeliveredAutoCompactWindow(current, settings) {
  if (!settings || typeof settings !== 'object') return current ?? null;
  if (!Object.prototype.hasOwnProperty.call(settings, 'autoCompactWindow')) return current ?? null;
  const delivered = Number(settings.autoCompactWindow);
  return Number.isFinite(delivered) && delivered > 0 ? Math.round(delivered) : null;
}

export function autoCompactWindowFromIndex(index) {
  const i = Math.round(Number(index));
  if (!Number.isFinite(i) || i < 0 || i >= AUTO_COMPACT_WINDOW_STOPS.length) return null;
  return AUTO_COMPACT_WINDOW_STOPS[i];
}
