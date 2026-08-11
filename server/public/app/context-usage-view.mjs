/**
 * Renders the context-usage modal body from the provider-neutral payload that
 * `/api/context` returns (see `server/services/context-usage-view.mjs`).
 *
 * Kept DOM-free and dependency-light so it can be unit tested directly.
 */

// The SDK labels categories with names, not CSS. Anything unmapped falls back
// to a neutral swatch rather than rendering an invalid color.
const CATEGORY_COLORS = Object.freeze({
  gray: '#6e7681',
  grey: '#6e7681',
  blue: '#3b82f6',
  green: '#3fb950',
  orange: '#e3b341',
  yellow: '#e3b341',
  red: '#f85149',
  purple: '#a371f7',
  magenta: '#db61a2',
  cyan: '#39c5cf',
  white: '#c9d1d9',
});
const FALLBACK_CATEGORY_COLOR = '#6e7681';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// `Number(null)` and `Number('')` are 0, not NaN, so a plain isFinite check
// would render "absent" as a real zero.
function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function categoryColor(name) {
  const key = String(name || '').trim().toLowerCase();
  return CATEGORY_COLORS[key] || FALLBACK_CATEGORY_COLOR;
}

/**
 * 4823 → "4.8k", 221340 → "221.3k", 1000000 → "1.0M". Matches the compact
 * token formatting used by Claude Code's own context display.
 */
export function formatCompactTokens(value) {
  const n = toNullableNumber(value);
  if (n === null) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsagePercent(value, { digits = 1 } = {}) {
  const n = toNullableNumber(value);
  if (n === null) return '—';
  return `${n.toFixed(digits)}%`;
}

function renderBarSegments(categories, maxTokens) {
  const max = toNullableNumber(maxTokens);
  if (max === null || max <= 0) return '';
  return categories
    .map((category) => {
      const percent = toNullableNumber(category.percent);
      if (percent === null || percent <= 0) return '';
      return `<span class="ctx-usage-bar-seg" style="width:${percent}%;background:${categoryColor(category.color)}" title="${escapeHtml(category.name)}"></span>`;
    })
    .join('');
}

// Estimate wording keyed by the snapshot's estimate_kind; the fallback covers
// kinds added server-side before this file learns about them.
const ESTIMATE_NOTES = Object.freeze({
  'assistant-output-lower-bound':
    'Estimated lower bound — this runtime does not report a full breakdown.',
  'cursor-per-call-average':
    'Estimated from the turn’s aggregate token usage — the Cursor runtime does not report context occupancy directly.',
});
const DEFAULT_ESTIMATE_NOTE = 'Estimated — this runtime does not report context occupancy directly.';

function estimateNoteText(estimateKind) {
  return ESTIMATE_NOTES[String(estimateKind || '').trim()] || DEFAULT_ESTIMATE_NOTE;
}

function formatCapturedAt(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const stamp = new Date(raw);
  if (Number.isNaN(stamp.getTime())) return '';
  return stamp.toLocaleString();
}

function renderRow({ name, tokens, percent, color, muted = false }) {
  const swatch = color === null
    ? '<span class="ctx-usage-swatch ctx-usage-swatch-empty"></span>'
    : `<span class="ctx-usage-swatch" style="background:${categoryColor(color)}"></span>`;
  return `
    <tr class="${muted ? 'ctx-usage-row-muted' : ''}">
      <td class="ctx-usage-cat">${swatch}${escapeHtml(name)}</td>
      <td class="ctx-usage-num">${escapeHtml(formatCompactTokens(tokens))}</td>
      <td class="ctx-usage-num ctx-usage-pct">${escapeHtml(formatUsagePercent(percent))}</td>
    </tr>
  `;
}

/**
 * @param {object|null} usage the `contextUsage` field of an /api/context response
 * @returns {string} modal body HTML, or '' when there is nothing to render
 */
export function renderContextUsageHtml(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const categories = Array.isArray(usage.categories) ? usage.categories : [];
  const hasTotals = toNullableNumber(usage.totalTokens) !== null
    && toNullableNumber(usage.maxTokens) !== null;
  if (!categories.length && !hasTotals) return '';

  const headline = hasTotals
    ? `${formatCompactTokens(usage.totalTokens)} / ${formatCompactTokens(usage.maxTokens)} tokens (${formatUsagePercent(usage.percentage, { digits: 0 })})`
    : '';

  const rows = categories.map((category) => renderRow(category)).join('');
  const freeRow = toNullableNumber(usage.freeTokens) !== null
    ? renderRow({
      name: 'Free space',
      tokens: usage.freeTokens,
      percent: usage.freePercent,
      color: null,
      muted: true,
    })
    : '';

  const estimateNote = usage.isEstimate
    ? `<div class="ctx-usage-note">${escapeHtml(estimateNoteText(usage.estimateKind))}</div>`
    : '';
  const capturedNote = formatCapturedAt(usage.capturedAt)
    ? `<div class="ctx-usage-note">As of the last completed turn (${escapeHtml(formatCapturedAt(usage.capturedAt))}${usage.model ? ` on ${escapeHtml(usage.model)}` : ''}).</div>`
    : '';

  return `
    <div class="ctx-usage">
      ${usage.model ? `<div class="ctx-usage-model">${escapeHtml(usage.model)}</div>` : ''}
      ${headline ? `<div class="ctx-usage-headline">${escapeHtml(headline)}</div>` : ''}
      <div class="ctx-usage-bar">${renderBarSegments(categories, usage.maxTokens)}</div>
      ${estimateNote}
      ${capturedNote}
      <table class="ctx-usage-table">
        <thead>
          <tr><th>Category</th><th class="ctx-usage-num">Tokens</th><th class="ctx-usage-num">Usage</th></tr>
        </thead>
        <tbody>${rows}${freeRow}</tbody>
      </table>
    </div>
  `;
}
