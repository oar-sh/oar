'use strict';

/**
 * GitHub Copilot plan usage.
 *
 * Two independent sources are folded together here:
 *  - the quota snapshot the relay already fetched for the per-turn usage
 *    deltas (fast, always available with the CLI's own token), which carries
 *    the allowance/remaining/reset that the meters need; and
 *  - the official REST billing usage report (optional, personal scope), which
 *    adds per-model/per-product cost detail but no allowance.
 *
 * The billing report is strictly additive: when the token cannot read billing
 * (the common case for a plain `gh auth token`) the card still renders every
 * meter from the quota snapshot.
 */

import {
  SOURCE_CACHE,
  SOURCE_LIVE,
  STATUS_ERROR,
  STATUS_OK,
  STATUS_PARTIAL,
  buildDetailSection,
  buildMeter,
  buildProviderCard,
  buildUnavailableCard,
  roundCurrency,
  toFiniteNumber,
  toTrimmedString,
} from './plan-usage-contract.mjs';

export const COPILOT_PROVIDER_ID = 'github';
export const COPILOT_LABEL = 'GitHub Copilot';

const BILLING_DOCS_URL = 'https://github.com/settings/billing';

/**
 * GitHub renamed the metered unit from "premium requests" to "AI credits"
 * without changing the quota-snapshot field names, so the same numbers must be
 * labelled from whatever the payload says the plan actually meters.
 */
export function resolvePremiumBucketLabel(summary = {}) {
  const explicitUnit = toTrimmedString(summary?.premiumInteractions?.unit)
    || toTrimmedString(summary?.unit);
  if (explicitUnit) {
    if (/credit/i.test(explicitUnit)) return { label: 'AI credits', unit: 'credits' };
    if (/request|interaction/i.test(explicitUnit)) return { label: 'Premium requests', unit: 'requests' };
  }
  // The AI-credit plans meter in units of $0.01, which produces entitlements in
  // the thousands; the legacy premium-request plans are in the hundreds.
  const entitlement = toFiniteNumber(summary?.premiumInteractions?.entitlement);
  if (entitlement !== null && entitlement >= 1000) return { label: 'AI credits', unit: 'credits' };
  return { label: 'Premium requests', unit: 'requests' };
}

function resetTimestamp(summary) {
  const raw = toTrimmedString(summary?.resetDate);
  if (!raw) return null;
  // The quota API reports a bare calendar day; anchoring it to UTC midnight
  // keeps the countdown honest instead of drifting with the viewer's zone.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00.000Z`;
  return raw;
}

function formatUnits(value, unit) {
  const numeric = toFiniteNumber(value);
  if (numeric === null) return null;
  if (unit === 'usd') return `$${(Math.round(numeric * 100) / 100).toFixed(2)}`;
  return String(Math.round(numeric * 100) / 100);
}

/**
 * Fold the REST billing `usageItems[]` into per-product and per-model totals.
 * Both the AI-credit report (which carries `model`) and the plain usage report
 * (which does not) are accepted.
 */
export function summarizeBillingUsageItems(items = []) {
  const rows = Array.isArray(items) ? items : [];
  const byProduct = new Map();
  const byModel = new Map();
  let netAmount = 0;
  let grossAmount = 0;
  let discountAmount = 0;
  let netQuantity = 0;

  for (const item of rows) {
    const net = toFiniteNumber(item?.netAmount) || 0;
    const gross = toFiniteNumber(item?.grossAmount) || 0;
    const discount = toFiniteNumber(item?.discountAmount) || 0;
    // The AI-credit report uses netQuantity; the plain usage report uses quantity.
    const quantity = toFiniteNumber(item?.netQuantity ?? item?.quantity) || 0;
    netAmount += net;
    grossAmount += gross;
    discountAmount += discount;
    netQuantity += quantity;

    const product = toTrimmedString(item?.product) || 'Other';
    const productEntry = byProduct.get(product) || { net: 0, quantity: 0 };
    productEntry.net += net;
    productEntry.quantity += quantity;
    byProduct.set(product, productEntry);

    const model = toTrimmedString(item?.model);
    if (model) {
      const modelEntry = byModel.get(model) || { net: 0, quantity: 0 };
      modelEntry.net += net;
      modelEntry.quantity += quantity;
      byModel.set(model, modelEntry);
    }
  }

  if (!rows.length) return null;
  const sortByNetDesc = (a, b) => b[1].net - a[1].net || b[1].quantity - a[1].quantity;
  return {
    netAmount: roundCurrency(netAmount),
    grossAmount: roundCurrency(grossAmount),
    discountAmount: roundCurrency(discountAmount),
    netQuantity: Math.round(netQuantity * 1000) / 1000,
    byProduct: Array.from(byProduct.entries()).sort(sortByNetDesc)
      .map(([name, entry]) => ({ name, net: roundCurrency(entry.net), quantity: Math.round(entry.quantity * 1000) / 1000 })),
    byModel: Array.from(byModel.entries()).sort(sortByNetDesc)
      .map(([name, entry]) => ({ name, net: roundCurrency(entry.net), quantity: Math.round(entry.quantity * 1000) / 1000 })),
  };
}

/**
 * GitHub sometimes reports `percent_remaining: 0` with no denominator, which
 * must read as "unknown" rather than "fully consumed" — the same guard the
 * per-turn usage snapshots apply.
 */
function utilizationFromPercentRemaining(bucket = {}) {
  const percentRemaining = toFiniteNumber(bucket?.percentRemaining);
  if (percentRemaining === null) return null;
  const hasDenominatorContext = toFiniteNumber(bucket?.entitlement) !== null
    || toFiniteNumber(bucket?.remaining) !== null;
  if (!hasDenominatorContext && percentRemaining === 0) return null;
  return 100 - percentRemaining;
}

/**
 * @param {object} args
 * @param {object|null} args.summary  the quota snapshot from `fetchUsageSummary`
 * @param {object|null} args.billing  `{ items, timePeriod, scope, error }` or null
 */
export function buildCopilotPlanCard({
  summary = null,
  billing = null,
  error = null,
  capturedAt = new Date().toISOString(),
  stale = false,
} = {}) {
  if (!summary) {
    return buildUnavailableCard({
      provider: COPILOT_PROVIDER_ID,
      label: COPILOT_LABEL,
      status: STATUS_ERROR,
      message: toTrimmedString(error) || 'Copilot quota is unavailable.',
      capturedAt,
      links: [{ label: 'GitHub billing settings', url: BILLING_DOCS_URL }],
    });
  }

  const resetAt = resetTimestamp(summary);
  const premiumBucket = resolvePremiumBucketLabel(summary);
  const meters = [];

  const premium = summary?.premiumInteractions || {};
  meters.push(buildMeter({
    id: 'copilot-premium',
    label: premiumBucket.label,
    unit: premiumBucket.unit,
    unlimited: premium?.unlimited === true,
    remaining: premium?.remaining,
    allowance: premium?.entitlement,
    utilization: utilizationFromPercentRemaining(premium),
    resetAt,
  }));

  const plan = summary?.planQuota || {};
  meters.push(buildMeter({
    id: 'copilot-plan',
    label: 'Plan quota',
    unit: premiumBucket.unit,
    unlimited: plan?.unlimited === true,
    remaining: plan?.remaining,
    allowance: plan?.entitlement,
    utilization: utilizationFromPercentRemaining(plan),
    resetAt,
  }));

  const chat = summary?.chat || {};
  meters.push(buildMeter({
    id: 'copilot-chat',
    label: 'Chat & completions',
    unit: 'requests',
    unlimited: chat?.unlimited === true,
    remaining: chat?.remaining,
    allowance: chat?.entitlement,
    utilization: utilizationFromPercentRemaining(chat),
    resetAt,
    emphasis: 'secondary',
    note: chat?.unlimited === true ? 'Included with your plan' : null,
  }));

  const details = [];
  const billingSummary = billing?.items ? summarizeBillingUsageItems(billing.items) : null;
  if (billingSummary) {
    const period = billing?.timePeriod || {};
    const periodLabel = [period?.year, period?.month, period?.day].filter(Boolean).join('-');
    details.push(buildDetailSection({
      id: 'copilot-billing-totals',
      label: 'Billed usage this period',
      note: periodLabel ? `Reporting period ${periodLabel}` : null,
      rows: [
        { label: 'Billed (net)', value: formatUnits(billingSummary.netAmount, 'usd') },
        { label: 'Gross', value: formatUnits(billingSummary.grossAmount, 'usd') },
        { label: 'Included / discounted', value: formatUnits(billingSummary.discountAmount, 'usd') },
        { label: 'Billable quantity', value: formatUnits(billingSummary.netQuantity) },
      ],
    }));
    if (billingSummary.byModel.length) {
      details.push(buildDetailSection({
        id: 'copilot-billing-models',
        label: 'By model',
        rows: billingSummary.byModel.slice(0, 12).map((entry) => ({
          label: entry.name,
          value: formatUnits(entry.net, 'usd') ?? '—',
          hint: `${formatUnits(entry.quantity)} units`,
        })),
      }));
    }
    if (billingSummary.byProduct.length) {
      details.push(buildDetailSection({
        id: 'copilot-billing-products',
        label: 'By product',
        rows: billingSummary.byProduct.slice(0, 12).map((entry) => ({
          label: entry.name,
          value: formatUnits(entry.net, 'usd') ?? '—',
          hint: `${formatUnits(entry.quantity)} units`,
        })),
      }));
    }
  }

  const billingError = toTrimmedString(billing?.error);
  const resolvedMeters = meters.filter(Boolean);
  return buildProviderCard({
    provider: COPILOT_PROVIDER_ID,
    label: COPILOT_LABEL,
    status: resolvedMeters.length ? (billingError ? STATUS_PARTIAL : STATUS_OK) : STATUS_PARTIAL,
    planName: toTrimmedString(summary?.plan),
    accountLabel: toTrimmedString(billing?.scope),
    message: billingError
      ? `Detailed billing data unavailable: ${billingError}`
      : null,
    source: stale ? SOURCE_CACHE : SOURCE_LIVE,
    stale,
    capturedAt,
    meters: resolvedMeters,
    details,
    links: [{ label: 'GitHub billing settings', url: BILLING_DOCS_URL }],
  });
}
