// Pure geometry/selection helpers for the "Change CWD" known-CWD picker.
// Kept DOM-free so they can run under `node --test` without a browser.

const FLIP_THRESHOLD_PX = 180;

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Decide where the fixed-position picker panel should sit relative to its trigger.
 * Used on desktop only; the mobile layout is a bottom sheet driven purely by CSS.
 */
export function resolveCwdMenuPlacement({
  triggerRect,
  viewportWidth = 0,
  viewportHeight = 0,
  panelHeight = 0,
  gap = 6,
  edge = 8,
  minHeight = 140,
  maxHeight = 300,
} = {}) {
  const top = Number(triggerRect?.top) || 0;
  const left = Number(triggerRect?.left) || 0;
  const width = Math.max(0, Number(triggerRect?.width) || 0);
  const height = Math.max(0, Number(triggerRect?.height) || 0);
  const bottom = top + height;

  const spaceBelow = Math.max(0, viewportHeight - bottom - gap - edge);
  const spaceAbove = Math.max(0, top - gap - edge);
  const flip = spaceBelow < FLIP_THRESHOLD_PX && spaceAbove > spaceBelow;
  const available = flip ? spaceAbove : spaceBelow;

  const desiredHeight = panelHeight > 0 ? Math.min(panelHeight, maxHeight) : maxHeight;
  const resolvedMaxHeight = clamp(Math.min(desiredHeight, available), Math.min(minHeight, available), maxHeight);

  const resolvedWidth = width > 0 ? width : 260;
  const maxLeft = Math.max(edge, viewportWidth - resolvedWidth - edge);
  const resolvedLeft = clamp(left, edge, maxLeft);
  const resolvedTop = flip
    ? Math.max(edge, top - gap - resolvedMaxHeight)
    : bottom + gap;

  return {
    placement: flip ? 'above' : 'below',
    top: resolvedTop,
    left: resolvedLeft,
    width: resolvedWidth,
    maxHeight: resolvedMaxHeight,
  };
}

/**
 * Move the active option by `delta`, clamped at both ends (no wrap-around, per the
 * ARIA APG listbox default). Returns -1 when there is nothing to activate.
 */
export function resolveActiveOptionIndex(currentIndex, delta, count) {
  const total = Number(count) || 0;
  if (total <= 0) return -1;
  const step = Number(delta) || 0;
  const current = Number.isInteger(currentIndex) ? currentIndex : -1;
  if (current < 0) return step < 0 ? total - 1 : 0;
  return clamp(current + step, 0, total - 1);
}

/**
 * Type-ahead: find the next entry whose label or path starts with `buffer`,
 * searching forward from `fromIndex` and wrapping once.
 */
export function resolveTypeaheadIndex(entries, buffer, fromIndex = -1) {
  const needle = String(buffer || '').trim().toLowerCase();
  if (!needle || !Array.isArray(entries) || !entries.length) return -1;
  const total = entries.length;
  const start = Number.isInteger(fromIndex) && fromIndex >= 0 ? fromIndex : -1;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (start + offset + total) % total;
    const entry = entries[index] || {};
    const label = String(entry.label || '').toLowerCase();
    const pathValue = String(entry.path || '').toLowerCase();
    if (label.startsWith(needle) || pathValue.startsWith(needle)) return index;
  }
  return -1;
}
