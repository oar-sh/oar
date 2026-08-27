/**
 * Renders the context-usage modal body from the provider-neutral payload that
 * `/api/context` returns (see `server/services/context-usage-view.mjs`).
 *
 * Kept DOM-free and dependency-light so it can be unit tested directly.
 */

import {
  AUTO_COMPACT_WINDOW_STOPS,
  autoCompactWindowToIndex,
  formatAutoCompactWindowLabel,
  parseAutoCompactWindow,
} from './auto-compact-window-options.mjs';

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

// How the CLI describes where the effective threshold came from. Unknown
// sources are rendered verbatim rather than dropped, so a new CLI vocabulary
// still tells the user something.
const AUTOCOMPACT_SOURCE_LABELS = Object.freeze({
  auto: 'auto (model-tuned)',
  'model-default': 'model default',
  settings: 'from settings',
  env: 'from CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  clientdata: 'from client data',
});

function autocompactSourceLabel(source) {
  const key = String(source || '').trim();
  if (!key) return '';
  return AUTOCOMPACT_SOURCE_LABELS[key.toLowerCase()] || key;
}

/**
 * The Claude-only auto-compact window control: a snap-stop slider over
 * AUTO_COMPACT_WINDOW_STOPS plus the measured effective threshold.
 *
 * No stop is annotated as out of the model's reach: the payload carries no
 * trustworthy model-limit field. `rawMaxTokens` tracks the ACTIVE setting, not
 * the model's own window (probed on claude-opus-5[1m]: no setting → 1000000,
 * setting 100000 → 100000), so annotating from it told a user who had just
 * pinned 100k that every larger stop was pointless. Applied on the next
 * message delivery, which is why there is no live preview of the effect.
 *
 * `isAutoCompactEnabled` is tri-state on purpose: `null`/`undefined` means the
 * runtime has not reported yet (no context-usage snapshot exists before the
 * first turn) and must not be read as "disabled" — auto-compact is on by
 * default, so claiming otherwise next to an unknown threshold is a lie.
 *
 * @returns {string} HTML, or '' when there is nothing to control
 */
export function renderAutoCompactControlHtml({
  autoCompactWindow = null,
  autoCompactThreshold = null,
  autocompactSource = null,
  isAutoCompactEnabled = null,
  maxTokens = null,
} = {}) {
  const window = parseAutoCompactWindow(autoCompactWindow);
  const index = autoCompactWindowToIndex(window);

  const threshold = toNullableNumber(autoCompactThreshold);
  const sourceLabel = autocompactSourceLabel(autocompactSource);
  const effective = threshold === null
    ? '<span class="ctx-autocompact-muted">— (known after the first turn)</span>'
    : `compacts at ${escapeHtml(formatCompactTokens(threshold))}${toNullableNumber(maxTokens) === null
      ? ''
      : ` of ${escapeHtml(formatCompactTokens(maxTokens))}`} tokens${sourceLabel ? ` · ${escapeHtml(sourceLabel)}` : ''}`;

  // No toggle by design: the window is the only thing this control owns. Only
  // an explicit `false` from a real snapshot renders the note — unknown stays
  // silent rather than contradicting the "known after the first turn" line.
  const disabledNote = isAutoCompactEnabled === false
    ? '<div class="ctx-autocompact-note">Auto-compact is disabled for this session.</div>'
    : '';

  return `
    <div class="ctx-autocompact">
      <div class="ctx-autocompact-row">
        <label for="ctx-autocompact-slider">Auto-compact window:</label>
        <b id="ctx-autocompact-value">${escapeHtml(formatAutoCompactWindowLabel(window))}</b>
      </div>
      <input
        id="ctx-autocompact-slider"
        class="ctx-autocompact-slider"
        type="range"
        min="0"
        max="${AUTO_COMPACT_WINDOW_STOPS.length - 1}"
        step="1"
        value="${index}"
        aria-label="Auto-compact window"
      >
      <div class="ctx-autocompact-effective">Effective: ${effective}</div>
      ${disabledNote}
      <div class="ctx-autocompact-note">Applied on the next message in this conversation.</div>
    </div>
  `;
}

// Wire value ↔ segmented-button value. Two states per axis: the relay's
// defaults are On + Summarized, and an unset conversation reads back as those,
// so a third "host default" button could not be stored distinctly from unset.
const THINKING_ENABLED_CHOICES = Object.freeze([
  { key: 'on', label: 'On' },
  { key: 'off', label: 'Off' },
]);
const THINKING_DISPLAY_CHOICES = Object.freeze([
  { key: 'summarized', label: 'Summarized' },
  { key: 'omitted', label: 'Hidden' },
]);

/** Anything but an explicit off is on — the relay default. */
export function thinkingEnabledToKey(enabled) {
  return enabled === false ? 'off' : 'on';
}

export function thinkingEnabledFromKey(key) {
  return key !== 'off';
}

function renderThinkingButtons(axis, choices, activeKey) {
  return choices.map(({ key, label }) => `
        <button
          type="button"
          class="ctx-thinking-btn${key === activeKey ? ' is-active' : ''}"
          data-thinking-axis="${axis}"
          data-thinking-value="${key}"
          aria-pressed="${key === activeKey ? 'true' : 'false'}"
        >${escapeHtml(label)}</button>`).join('');
}

/**
 * Claude-only thinking control, rendered under the auto-compact slider.
 *
 * Two axes with different application semantics (probed 2026-08-26, see
 * docs/plans/claude-thinking-control.md): display changes and turning
 * thinking ON apply on the next message; turning it OFF only applies when the
 * CLI process next starts — the CLI silently ignores mid-session disabling —
 * so the note states both rather than pretending one uniform rule.
 *
 * @returns {string} HTML
 */
export function renderThinkingControlHtml({ thinkingEnabled = true, thinkingDisplay = null } = {}) {
  const enabledKey = thinkingEnabledToKey(thinkingEnabled);
  const displayKey = String(thinkingDisplay || '').trim().toLowerCase() === 'omitted'
    ? 'omitted'
    : 'summarized';
  return `
    <div class="ctx-thinking">
      <div class="ctx-thinking-row">
        <span class="ctx-thinking-label">Thinking:</span>
        <div class="ctx-thinking-group" role="group" aria-label="Thinking">
${renderThinkingButtons('enabled', THINKING_ENABLED_CHOICES, enabledKey)}
        </div>
      </div>
      <div class="ctx-thinking-row">
        <span class="ctx-thinking-label">Thinking text:</span>
        <div class="ctx-thinking-group" role="group" aria-label="Thinking text">
${renderThinkingButtons('display', THINKING_DISPLAY_CHOICES, displayKey)}
        </div>
      </div>
      <div class="ctx-thinking-note">Defaults are On and Summarized. Text changes and turning thinking on apply on the next message; turning it off applies to the next CLI session. Hiding the text does not reduce thinking or cost — it only keeps it out of the transcript.</div>
    </div>
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
  // Unused window the conversation may not occupy: without its own row the
  // reserve would just be missing from the table, since free space has it
  // subtracted out.
  const bufferRow = toNullableNumber(usage.bufferTokens) !== null && Number(usage.bufferTokens) > 0
    ? renderRow({
      name: 'Auto-compact reserve',
      tokens: usage.bufferTokens,
      percent: usage.bufferPercent,
      color: null,
      muted: true,
    })
    : '';

  // Deferred tool definitions are listed by the SDK but left out of
  // totalTokens, so the category rows legitimately sum higher than the
  // headline. Without this the table reads as an arithmetic error.
  const deferredNote = categories.some((category) => category.isDeferred === true)
    ? '<div class="ctx-usage-note">Deferred tools are listed but not loaded, so they are not counted in the total.</div>'
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
      ${deferredNote}
      ${capturedNote}
      <table class="ctx-usage-table">
        <thead>
          <tr><th>Category</th><th class="ctx-usage-num">Tokens</th><th class="ctx-usage-num">Usage</th></tr>
        </thead>
        <tbody>${rows}${freeRow}${bufferRow}</tbody>
      </table>
    </div>
  `;
}
