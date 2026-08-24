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
  if (unit === 'usd') {
    const rounded = Math.round(n * 100) / 100;
    return `${rounded < 0 ? '-' : ''}$${Math.abs(rounded).toFixed(2)}`;
  }
  if (unit === 'percent') return `${Math.round(n * 10) / 10}%`;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

export function formatResetCountdown(resetAt, now = new Date()) {
  if (!resetAt) return null;
  const target = new Date(resetAt);
  if (Number.isNaN(target.getTime())) return null;
  const reference = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const diffMs = target.getTime() - reference.getTime();
  if (diffMs <= 0) return 'resets now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `resets in ${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainderMinutes = minutes % 60;
    return remainderMinutes ? `resets in ${hours} h ${remainderMinutes} min` : `resets in ${hours} h`;
  }
  const days = Math.floor(hours / 24);
  if (days <= 14) {
    const remainderHours = hours % 24;
    return remainderHours ? `resets in ${days} d ${remainderHours} h` : `resets in ${days} d`;
  }
  return `resets ${target.toISOString().slice(0, 10)}`;
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
      parts.push(toNullableNumber(meter.remaining) < 0 ? `${remaining} over` : `${remaining} left`);
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
  const countdown = formatResetCountdown(meter.resetAt, now);
  const percentLabel = meter.unlimited
    ? '∞'
    : (utilization === null ? '—' : `${Math.round(utilization)}%`);
  const flags = [
    meter.estimated ? '<span class="plan-usage-flag">estimated</span>' : '',
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

function renderDetailSection(section) {
  const rows = section.rows.map((row) => `
    <tr>
      <td class="plan-usage-detail-label">${escapeHtml(row.label)}${row.hint ? `<span class="plan-usage-detail-hint">${escapeHtml(row.hint)}</span>` : ''}</td>
      <td class="plan-usage-detail-value">${escapeHtml(row.value)}</td>
    </tr>
  `).join('');
  return `
    <details class="plan-usage-details" data-section-id="${escapeHtml(section.id)}">
      <summary>${escapeHtml(section.label)}</summary>
      ${section.note ? `<div class="plan-usage-detail-note">${escapeHtml(section.note)}</div>` : ''}
      <table class="plan-usage-detail-table"><tbody>${rows}</tbody></table>
    </details>
  `;
}

function renderCard(card, now) {
  const meters = Array.isArray(card.meters) ? card.meters : [];
  const details = Array.isArray(card.details) ? card.details : [];
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

  return `
    <section class="plan-usage-card plan-usage-card-${escapeHtml(card.provider)}" data-provider="${escapeHtml(card.provider)}" data-status="${escapeHtml(card.status)}">
      <header class="plan-usage-card-head">
        <span class="plan-usage-card-title">${escapeHtml(card.label)}</span>
        <span class="plan-usage-badges">${badges}</span>
      </header>
      ${card.message ? `<div class="plan-usage-message">${escapeHtml(card.message)}</div>` : ''}
      ${metersHtml}
      ${details.map(renderDetailSection).join('')}
      <div class="plan-usage-card-foot">
        ${capturedLabel ? `<span class="plan-usage-captured">${capturedLabel}</span>` : ''}
        ${links.map((link) => `<a class="plan-usage-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`).join('')}
      </div>
    </section>
  `;
}

/**
 * @param {object|null} report the `/api/usage` payload
 * @param {object} [options]
 * @param {Date} [options.now] injectable clock so countdowns are testable
 * @returns {string} modal body HTML, or '' when there is nothing to render
 */
export function renderPlanUsageHtml(report, { now = new Date() } = {}) {
  const providers = Array.isArray(report?.providers) ? report.providers.filter(Boolean) : [];
  if (!providers.length) return '';
  return `<div class="plan-usage">${providers.map((card) => renderCard(card, now)).join('')}</div>`;
}

/** Subtitle for the modal header: the healthiest available "what matters now" line. */
export function planUsageSubtitle(report) {
  const providers = Array.isArray(report?.providers) ? report.providers.filter(Boolean) : [];
  if (!providers.length) return 'No usage data available';
  const available = providers.filter((card) => Array.isArray(card.meters) && card.meters.length);
  if (!available.length) return 'No plan limits reported yet';
  const soonest = available
    .flatMap((card) => card.meters.map((meter) => meter.resetAt))
    .filter(Boolean)
    .sort()[0];
  const countdown = formatResetCountdown(soonest);
  return countdown
    ? `${available.length} provider${available.length === 1 ? '' : 's'} reporting · next reset ${countdown.replace(/^resets /, '')}`
    : `${available.length} provider${available.length === 1 ? '' : 's'} reporting`;
}
