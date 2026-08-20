// Mirrors shared/auto-compact-window.mjs, which the browser cannot import
// (only server/public is served). shared/auto-compact-window.test.mjs asserts
// the two stop lists stay identical.
//
// The value is a TOKEN COUNT, not a percent: it is the amount of context the
// Claude CLI lets a conversation reach before compacting. null = "Auto", the
// CLI's model-tuned default.

export const AUTO_COMPACT_WINDOW_STOPS = Object.freeze([
  null,
  100000,
  150000,
  200000,
  300000,
  500000,
  1000000,
]);

export function parseAutoCompactWindow(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (!text || text === 'auto' || text === 'null') return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const stop of AUTO_COMPACT_WINDOW_STOPS) {
    if (stop === null) continue;
    const distance = Math.abs(numeric - stop);
    if (distance < bestDistance) {
      best = stop;
      bestDistance = distance;
    }
  }
  return best;
}

export function formatAutoCompactWindowLabel(value) {
  const window = parseAutoCompactWindow(value);
  if (window === null) return 'Auto';
  if (window >= 1000000) {
    const millions = window / 1000000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(window / 1000)}k`;
}

export function autoCompactWindowToIndex(value) {
  const index = AUTO_COMPACT_WINDOW_STOPS.indexOf(parseAutoCompactWindow(value));
  return index >= 0 ? index : 0;
}

export function autoCompactWindowFromIndex(index) {
  const i = Math.round(Number(index));
  if (!Number.isFinite(i) || i < 0 || i >= AUTO_COMPACT_WINDOW_STOPS.length) return null;
  return AUTO_COMPACT_WINDOW_STOPS[i];
}
