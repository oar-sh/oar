/**
 * Renders the plan-usage ("Check Usage") modal body from the multi-provider
 * payload `/api/usage` returns.
 *
 * Plan-first by design: subscription credits, limits and resets lead, and the
 * token/cost diagnostics sit in collapsed sections underneath. Kept DOM-free so
 * it can be unit tested directly, mirroring `context-usage-view.mjs` — whose
 * bar/table vocabulary this deliberately reuses so the two modals look related.
 */

import { escapeHtml } from './context-usage-view.mjs';

// Null-prototype so an unrecognized `status`/`source` can only ever miss —
// a plain literal would resolve keys like `constructor` off the prototype and
// stringify a function into a badge.
const STATUS_BADGES = Object.freeze(Object.assign(Object.create(null), {
  ok: null,
  partial: 'Partial',
  unavailable: 'Unavailable',
  'not-configured': 'Not configured',
  error: 'Error',
}));

const SOURCE_LABELS = Object.freeze(Object.assign(Object.create(null), {
  live: 'Live',
  cache: 'Cached',
  worker: 'From last turn',
  manual: 'Estimated',
}));

/** Short tab captions; the card keeps the long label ("GitHub Copilot"). */
const TAB_LABELS = Object.freeze(Object.assign(Object.create(null), {
  github: 'Copilot',
  claude: 'Claude',
  'claude-cloud': 'Claude Cloud',
  cursor: 'Cursor',
  grok: 'Grok',
  deepseek: 'DeepSeek',
}));

// The composer speaks 'github'/'openai'/… while the usage report keys Copilot as
// 'github'; fold the spellings that mean the same provider onto one id so a
// session's provider can be matched against a card.
const PROVIDER_ALIASES = Object.freeze(Object.assign(Object.create(null), {
  copilot: 'github',
  'github-copilot': 'github',
  'copilot-github': 'github',
}));

/** @returns {string} the canonical usage-card id for a provider spelling. */
export function normalizeUsageProvider(value) {
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return '';
  return PROVIDER_ALIASES[key] || key;
}

/**
 * Which tab opens selected: the requested provider when it has a card (so a
 * Claude session lands on Claude), otherwise the first card — 'openai' sessions
 * have no card of their own and must not open onto an empty modal.
 */
export function resolveActiveUsageProvider(providers, activeProvider = '') {
  const ids = (Array.isArray(providers) ? providers : [])
    .filter(Boolean)
    .map((card) => normalizeUsageProvider(card.provider));
  const wanted = normalizeUsageProvider(activeProvider);
  if (wanted && ids.includes(wanted)) return wanted;
  return ids[0] || '';
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Green → amber → red, matching the composer's context-usage indicator ramp. */
export function utilizationColor(utilization) {
  const value = toNullableNumber(utilization);
  if (value === null) return '#6e7681';
  if (value >= 90) return '#f85149';
  if (value >= 75) return '#e3b341';
  if (value >= 50) return '#d29922';
  return '#3fb950';
}

export function formatAmount(value, unit) {
  const n = toNullableNumber(value);
  if (n === null) return null;
  if (unit === 'usd' || unit === 'cny') {
    const rounded = Math.round(n * 100) / 100;
    return `${rounded < 0 ? '-' : ''}${unit === 'cny' ? '¥' : '$'}${Math.abs(rounded).toFixed(2)}`;
  }
  if (unit === 'percent') return `${Math.round(n * 10) / 10}%`;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

/**
 * @param {object} [options]
 * @param {boolean} [options.expiry] the date is when the allowance ends for
 *   good (a credit), so it reads "expires …" instead of "resets …"
 */
export function formatResetCountdown(resetAt, now = new Date(), { expiry = false } = {}) {
  if (!resetAt) return null;
  const target = new Date(resetAt);
  if (Number.isNaN(target.getTime())) return null;
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const verb = expiry ? 'expires' : 'resets';
  const diffMs = target.getTime() - reference.getTime();
  if (diffMs <= 0) return expiry ? 'expired' : 'resets now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${verb} in ${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainderMinutes = minutes % 60;
    return remainderMinutes ? `${verb} in ${hours} h ${remainderMinutes} min` : `${verb} in ${hours} h`;
  }
  const days = Math.floor(hours / 24);
  if (days <= 14) {
    const remainderHours = hours % 24;
    return remainderHours ? `${verb} in ${days} d ${remainderHours} h` : `${verb} in ${days} d`;
  }
  return `${verb} ${target.toISOString().slice(0, 10)}`;
}

/**
 * The headline under a meter label: what is left, out of what, and how it was
 * derived. Providers that only report a percentage get just the percentage.
 */
export function meterSummaryText(meter) {
  if (!meter || typeof meter !== 'object') return '';
  if (meter.unlimited) return 'Unlimited';
  const unit = meter.unit || 'credits';
  const used = formatAmount(meter.used, unit);
  const allowance = formatAmount(meter.allowance, unit);
  const remaining = formatAmount(meter.remaining, unit);
  const utilization = toNullableNumber(meter.utilization);

  if (allowance !== null && used !== null) {
    const parts = [`${used} of ${allowance} used`];
    if (remaining !== null) {
      const remainingNumber = toNullableNumber(meter.remaining);
      // Overage reads as a magnitude ("9989 over"), not a signed value.
      parts.push(remainingNumber < 0
        ? `${formatAmount(Math.abs(remainingNumber), unit)} over`
        : `${remaining} left`);
    }
    return parts.join(' · ');
  }
  if (remaining !== null && allowance !== null) return `${remaining} of ${allowance} left`;
  if (used !== null) return `${used} used`;
  if (utilization !== null) return `${Math.round(utilization * 10) / 10}% used`;
  return '';
}

function renderMeter(meter, now) {
  const utilization = toNullableNumber(meter.utilization);
  const width = meter.unlimited ? 100 : Math.max(0, Math.min(100, utilization ?? 0));
  const color = meter.unlimited ? '#3fb950' : utilizationColor(utilization);
  const summary = meterSummaryText(meter);
  const countdown = formatResetCountdown(meter.resetAt, now, { expiry: meter.resetKind === 'expiry' });
  const percentLabel = meter.unlimited
    ? '∞'
    : (utilization === null ? '—' : `${Math.round(utilization)}%`);
  // The provider's own severity word; "normal" is the absence of a warning.
  const severity = String(meter.severity ?? '').trim().toLowerCase();
  const flags = [
    meter.estimated ? '<span class="plan-usage-flag">estimated</span>' : '',
    severity && severity !== 'normal'
      ? `<span class="plan-usage-flag plan-usage-flag-severity" data-severity="${escapeHtml(severity)}">${escapeHtml(severity.replace(/[_-]+/g, ' '))}</span>`
      : '',
  ].filter(Boolean).join('');
  const meta = [summary, countdown].filter(Boolean).join(' · ');

  return `
    <div class="plan-usage-meter plan-usage-meter-${escapeHtml(meter.emphasis || 'primary')}" data-meter-id="${escapeHtml(meter.id)}">
      <div class="plan-usage-meter-head">
        <span class="plan-usage-meter-label">${escapeHtml(meter.label)}${flags}</span>
        <span class="plan-usage-meter-pct">${escapeHtml(percentLabel)}</span>
      </div>
      <div class="plan-usage-bar" role="img" aria-label="${escapeHtml(`${meter.label}: ${percentLabel} used`)}">
        <span class="plan-usage-bar-fill${utilization === null && !meter.unlimited ? ' plan-usage-bar-unknown' : ''}" style="width:${width}%;background:${color}"></span>
      </div>
      ${meta ? `<div class="plan-usage-meter-meta">${escapeHtml(meta)}</div>` : ''}
      ${meter.note ? `<div class="plan-usage-meter-note">${escapeHtml(meter.note)}</div>` : ''}
    </div>
  `;
}

/**
 * A chart from `buildChart` data: stacked `columns` (one per item, e.g. a
 * day) or horizontal stacked `bars` (one per item, e.g. a model), drawn with
 * plain HTML and CSS. Colours come from the theme's series variables (fixed
 * order, so a series keeps its colour between reads); every item has a text
 * equivalent as its label, a tooltip on hover, focus or tap, and the chart
 * has a legend for more than one series and a table view of the same data.
 */
function renderChart(chart) {
  const series = Array.isArray(chart?.series) ? chart.series.filter((entry) => entry && entry.key) : [];
  const items = Array.isArray(chart?.items) ? chart.items.filter((entry) => entry && entry.key) : [];
  if (!series.length || !items.length) return '';
  const unit = chart.unit || 'credits';
  // Money under a cent keeps four decimals, as the card's estimates do.
  const amount = (value) => {
    const n = toNullableNumber(value) ?? 0;
    if ((unit === 'usd' || unit === 'cny') && n !== 0 && Math.abs(n) < 0.01) {
      return `${n < 0 ? '-' : ''}${unit === 'cny' ? '¥' : '$'}${Math.abs(n).toFixed(4)}`;
    }
    return formatAmount(n, unit) ?? '0';
  };
  const valueOf = (item, key) => Math.max(0, toNullableNumber(item.values?.[key]) ?? 0);
  const totalOf = (item) => series.reduce((sum, entry) => sum + valueOf(item, entry.key), 0);
  const seriesColor = (index) => `var(--plan-usage-series-${Math.min(index + 1, 5)})`;
  const partsText = (item) => {
    const total = totalOf(item);
    return series
      .map((entry) => ({ entry, value: valueOf(item, entry.key) }))
      .filter(({ value }) => value > 0)
      .map(({ entry, value }) => `${entry.label} ${amount(value)}${series.length > 1 && total > 0 ? ` (${Math.round((value / total) * 100)}%)` : ''}`)
      .join(', ');
  };
  const itemText = (item) => {
    const total = totalOf(item);
    if (total <= 0) return `${item.label}: nothing`;
    const parts = series.length > 1 ? partsText(item) : '';
    return `${item.label}: ${amount(total)}${parts ? ` (${parts})` : ''}`;
  };
  const max = Math.max(0, ...items.map(totalOf));
  const segments = (item, dimension) => series.map((entry, index) => {
    const value = valueOf(item, entry.key);
    if (value <= 0) return '';
    const base = dimension === 'height' ? max : totalOf(item);
    const share = base > 0 ? (value / base) * 100 : 0;
    return `<span class="plan-usage-chart-seg" data-series="${escapeHtml(entry.key)}" style="${dimension}:${share.toFixed(2)}%;background:${seriesColor(index)}" title="${escapeHtml(`${entry.label} ${amount(value)}`)}"></span>`;
  }).join('');

  const plot = chart.kind === 'bars'
    ? `<div class="plan-usage-chart-bars">${items.map((item) => `
        <div class="plan-usage-chart-row" tabindex="0" aria-label="${escapeHtml(itemText(item))}">
          <span class="plan-usage-chart-row-label">${escapeHtml(item.label)}</span>
          <span class="plan-usage-chart-bar" aria-hidden="true">${segments(item, 'width')}</span>
          <span class="plan-usage-chart-row-value">${escapeHtml(amount(totalOf(item)))}</span>
          <span class="plan-usage-chart-tip" role="tooltip">${escapeHtml(itemText(item))}</span>
        </div>`).join('')}</div>`
    : `<div class="plan-usage-chart-columns" style="--plan-usage-columns:${items.length}">${items.map((item) => `
        <div class="plan-usage-chart-col${totalOf(item) > 0 ? '' : ' plan-usage-chart-col-empty'}" tabindex="0" aria-label="${escapeHtml(itemText(item))}" data-item="${escapeHtml(item.key)}">
          <span class="plan-usage-chart-stack" aria-hidden="true">${segments(item, 'height')}</span>
          <span class="plan-usage-chart-tip" role="tooltip">${escapeHtml(itemText(item))}</span>
        </div>`).join('')}
        <span class="plan-usage-chart-axis" aria-hidden="true"><span>${escapeHtml(items[0].label)}</span><span>${escapeHtml(items[items.length - 1].label)}</span></span>
      </div>`;

  const legend = series.length > 1
    ? `<ul class="plan-usage-chart-legend">${series.map((entry, index) => `<li><span class="plan-usage-chart-swatch" style="background:${seriesColor(index)}" aria-hidden="true"></span>${escapeHtml(entry.label)}</li>`).join('')}</ul>`
    : '';
  const table = `
    <details class="plan-usage-chart-table">
      <summary>As a table</summary>
      <table class="plan-usage-detail-table">
        <thead><tr><th scope="col"></th>${series.map((entry) => `<th scope="col">${escapeHtml(entry.label)}</th>`).join('')}${series.length > 1 ? '<th scope="col">Total</th>' : ''}</tr></thead>
        <tbody>${items.filter((item) => totalOf(item) > 0).map((item) => `<tr><th scope="row">${escapeHtml(item.label)}</th>${series.map((entry) => `<td class="plan-usage-detail-value">${escapeHtml(amount(valueOf(item, entry.key)))}</td>`).join('')}${series.length > 1 ? `<td class="plan-usage-detail-value">${escapeHtml(amount(totalOf(item)))}</td>` : ''}</tr>`).join('')}</tbody>
      </table>
    </details>`;
  return `
    <figure class="plan-usage-chart plan-usage-chart-kind-${chart.kind === 'bars' ? 'bars' : 'columns'}" data-chart-id="${escapeHtml(chart.id)}" role="group" aria-label="${escapeHtml(chart.label)}">
      <figcaption class="plan-usage-chart-head">
        <span class="plan-usage-chart-label">${escapeHtml(chart.label)}</span>
        ${chart.summary ? `<span class="plan-usage-chart-summary">${escapeHtml(chart.summary)}</span>` : ''}
      </figcaption>
      ${plot}
      ${legend}
      ${chart.note ? `<div class="plan-usage-meter-note">${escapeHtml(chart.note)}</div>` : ''}
      ${table}
    </figure>
  `;
}

function renderDetailSection(section) {
  const rows = section.rows.map((row) => `
    <tr>
      <td class="plan-usage-detail-label">${escapeHtml(row.label)}${row.hint ? `<span class="plan-usage-detail-hint">${escapeHtml(row.hint)}</span>` : ''}</td>
      <td class="plan-usage-detail-value">${String(row.value).split(' · ').map((part) => `<span class="plan-usage-detail-part">${escapeHtml(part)}</span>`).join(' · ')}</td>
    </tr>
  `).join('');
  return `
    <details class="plan-usage-details" data-section-id="${escapeHtml(section.id)}"${section.open ? ' open' : ''}>
      <summary>${escapeHtml(section.label)}</summary>
      ${section.note ? `<div class="plan-usage-detail-note">${escapeHtml(section.note)}</div>` : ''}
      <table class="plan-usage-detail-table"><tbody>${rows}</tbody></table>
    </details>
  `;
}

/**
 * Hours of the day the card note names, shown in the reader's own time zone.
 * `utcRanges` are `[start, end)` whole hours in UTC; the day is `now`'s, so
 * daylight-saving time is the reader's current one. "03:00–06:00 and
 * 08:00–12:00 in your time zone" for `[[1, 4], [6, 10]]` read in Berlin in
 * summer. `timeZone` is for tests; the browser leaves it to Intl.
 */
export function formatLocalHourRanges(utcRanges, { now = new Date(), timeZone = undefined } = {}) {
  if (!Array.isArray(utcRanges) || !utcRanges.length) return null;
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  } catch {
    return null;
  }
  const day = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const clock = (hour) => formatter.format(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0, 0)));
  const parts = [];
  for (const range of utcRanges) {
    if (!Array.isArray(range) || range.length !== 2) return null;
    const start = Number(range[0]);
    const end = Number(range[1]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) return null;
    parts.push(`${clock(start)}–${clock(end)}`);
  }
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${joined} in your time zone`;
}

/** The note's text with its UTC hours replaced by the reader's local ones, when it names any. */
function noteTextForReader(note, { now, timeZone } = {}) {
  const text = String(note?.text ?? '').trim();
  const utcText = String(note?.hours?.utcText ?? '').trim();
  if (!text || !utcText || !text.includes(utcText)) return text;
  const local = formatLocalHourRanges(note.hours.utcRanges, { now, timeZone });
  return local ? text.split(utcText).join(local) : text;
}

/**
 * A note that is a figure (buildCardNote's label and value): one row of the
 * card's figures, the hint under the label, the whole sentence as its title.
 */
function renderFact(note) {
  const hint = String(note?.hint ?? '').trim();
  return `<div class="plan-usage-fact" data-note-id="${escapeHtml(note?.id ?? '')}" title="${escapeHtml(String(note?.text ?? '').trim())}">`
    + `<dt>${escapeHtml(note.label)}${hint ? `<span class="plan-usage-fact-hint">${escapeHtml(hint)}</span>` : ''}</dt>`
    + `<dd>${escapeHtml(note.value)}</dd></div>`;
}

const isFactNote = (note) => Boolean(String(note?.label ?? '').trim() && String(note?.value ?? '').trim());

function renderNote(note, { now, timeZone } = {}) {
  const text = noteTextForReader(note, { now, timeZone });
  if (!text) return '';
  const url = String(note?.link?.url ?? '').trim();
  const label = String(note?.link?.label ?? '').trim();
  // Same rule as the server's: only an absolute https link becomes an href.
  const link = label && /^https:\/\//i.test(url)
    ? ` <a class="plan-usage-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    : '';
  // The UTC wording stays on the element for a reader who wants it.
  const utcTitle = note?.hours?.utcText && text !== String(note.text ?? '').trim()
    ? ` title="${escapeHtml(String(note.text).trim())}"`
    : '';
  return `<div class="plan-usage-detail-note plan-usage-note" data-note-id="${escapeHtml(note?.id ?? '')}"${utcTitle}>${escapeHtml(text)}${link}</div>`;
}

/**
 * The signed-in account under the card title. Three distinct states, because
 * "we could not ask" must not be drawn as "you are logged out": no `account`
 * key renders nothing at all, `{loggedIn:false}` says so, anything else shows
 * whatever identity we have.
 */
function renderAccountLine(account) {
  if (!account || typeof account !== 'object') return '';
  if (account.loggedIn === false) {
    return '<span class="plan-usage-account plan-usage-account-signed-out">Not logged in</span>';
  }
  const parts = [account.email, account.plan]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  if (!parts.length) {
    return account.loggedIn === true
      ? '<span class="plan-usage-account">Logged in</span>'
      : '';
  }
  return `<span class="plan-usage-account">${parts.map(escapeHtml).join(' · ')}</span>`;
}

function renderCard(card, now, { active = true, timeZone = undefined } = {}) {
  const meters = Array.isArray(card.meters) ? card.meters : [];
  const charts = Array.isArray(card.charts) ? card.charts.filter(Boolean) : [];
  const details = Array.isArray(card.details) ? card.details : [];
  const allNotes = Array.isArray(card.notes) ? card.notes.filter(Boolean) : [];
  // Figures go in one list under the bars; sentences stay notes, and on a
  // card with figures they come last, after the tables, so the numbers read
  // first.
  const facts = allNotes.filter(isFactNote);
  const notes = allNotes.filter((note) => !isFactNote(note));
  const notesHtml = notes.map((note) => renderNote(note, { now, timeZone })).join('');
  const detailsHtml = details.map(renderDetailSection).join('');
  const links = Array.isArray(card.links) ? card.links : [];

  const statusBadge = STATUS_BADGES[card.status];
  const sourceBadge = SOURCE_LABELS[card.source];
  const badges = [
    card.planName ? `<span class="plan-usage-badge plan-usage-badge-plan">${escapeHtml(card.planName)}</span>` : '',
    statusBadge ? `<span class="plan-usage-badge plan-usage-badge-status">${escapeHtml(statusBadge)}</span>` : '',
    sourceBadge ? `<span class="plan-usage-badge">${escapeHtml(sourceBadge)}</span>` : '',
  ].filter(Boolean).join('');

  const primary = meters.filter((meter) => meter.emphasis !== 'secondary');
  const secondary = meters.filter((meter) => meter.emphasis === 'secondary');

  const metersHtml = meters.length
    ? `${primary.map((meter) => renderMeter(meter, now)).join('')}${
      secondary.length
        ? `<div class="plan-usage-secondary">${secondary.map((meter) => renderMeter(meter, now)).join('')}</div>`
        : ''
    }`
    : '';

  const capturedLabel = card.capturedAt
    ? `Updated ${escapeHtml(String(card.capturedAt).replace('T', ' ').slice(0, 16))} UTC`
    : '';

  const panelId = normalizeUsageProvider(card.provider);
  return `
    <section class="plan-usage-card plan-usage-card-${escapeHtml(card.provider)}" data-provider="${escapeHtml(card.provider)}" data-usage-panel="${escapeHtml(panelId)}" data-status="${escapeHtml(card.status)}" role="tabpanel" id="plan-usage-panel-${escapeHtml(panelId)}" aria-labelledby="plan-usage-tab-${escapeHtml(panelId)}" tabindex="0"${active ? '' : ' hidden'}>
      <header class="plan-usage-card-head">
        <span class="plan-usage-card-titles">
          <span class="plan-usage-card-title">${escapeHtml(card.label)}</span>
          ${renderAccountLine(card.account)}
        </span>
        <span class="plan-usage-badges">${badges}</span>
      </header>
      ${card.message ? `<div class="plan-usage-message">${escapeHtml(card.message)}</div>` : ''}
      ${metersHtml}
      ${facts.length ? `<dl class="plan-usage-facts">${facts.map(renderFact).join('')}</dl>` : ''}
      ${charts.map(renderChart).join('')}
      ${facts.length ? `${detailsHtml}${notesHtml}` : `${notesHtml}${detailsHtml}`}
      <div class="plan-usage-card-foot">
        ${capturedLabel ? `<span class="plan-usage-captured">${capturedLabel}</span>` : ''}
        ${links.map((link) => `<a class="plan-usage-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join('')}
      </div>
    </section>
  `;
}

function renderTab(card, activeProvider) {
  const id = normalizeUsageProvider(card.provider);
  const active = id === activeProvider;
  const label = TAB_LABELS[id] || card.label || id;
  return `<button type="button" class="plan-usage-tab${active ? ' active' : ''}" role="tab" id="plan-usage-tab-${escapeHtml(id)}" aria-controls="plan-usage-panel-${escapeHtml(id)}" aria-selected="${active ? 'true' : 'false'}" tabindex="${active ? '0' : '-1'}" data-usage-tab="${escapeHtml(id)}">${escapeHtml(label)}</button>`;
}

/**
 * @param {object|null} report the `/api/usage` payload
 * @param {object} [options]
 * @param {Date} [options.now] injectable clock so countdowns are testable
 * @param {string} [options.activeProvider] the session's provider; selects its
 *   tab when that provider has a card
 * @returns {string} modal body HTML, or '' when there is nothing to render
 */
export function renderPlanUsageHtml(report, { now = new Date(), activeProvider = '', timeZone = undefined } = {}) {
  const providers = Array.isArray(report?.providers) ? report.providers.filter(Boolean) : [];
  if (!providers.length) return '';
  const active = resolveActiveUsageProvider(providers, activeProvider);
  const tabs = providers.map((card) => renderTab(card, active)).join('');
  const cards = providers
    .map((card) => renderCard(card, now, { active: normalizeUsageProvider(card.provider) === active, timeZone }))
    .join('');
  return `<div class="plan-usage"><div class="plan-usage-tab-strip" role="tablist" aria-label="Usage providers">${tabs}</div>${cards}</div>`;
}

/** Subtitle for the modal header: the healthiest available "what matters now" line. */
export function planUsageSubtitle(report) {
  const providers = Array.isArray(report?.providers) ? report.providers.filter(Boolean) : [];
  if (!providers.length) return 'No usage data available';
  const available = providers.filter((card) => Array.isArray(card.meters) && card.meters.length);
  if (!available.length) return 'No plan limits reported yet';
  // A credit's expiry is not a reset: nothing refills on that date.
  const soonest = available
    .flatMap((card) => card.meters.map((meter) => (meter?.resetKind === 'expiry' ? null : meter?.resetAt)))
    .filter(Boolean)
    .sort()[0];
  const countdown = formatResetCountdown(soonest);
  return countdown
    ? `${available.length} provider${available.length === 1 ? '' : 's'} reporting · next reset ${countdown.replace(/^resets /, '')}`
    : `${available.length} provider${available.length === 1 ? '' : 's'} reporting`;
}
