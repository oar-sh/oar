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
  pickNonNegative,
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

// One AI credit is 1e9 nano-AIU. The SDK's `assistant.usage.totalNanoAiu` is
// the only place real per-turn spend appears: `cost` on the same event is the
// premium MULTIPLIER, not money, and there is no `premiumRequests` field.
const NANO_AIU_PER_CREDIT = 1_000_000_000;

/**
 * A single turn costs a small fraction of a credit, so the card's usual
 * 2-decimal rounding would report every turn as "0". Sub-cent turns get more
 * digits instead of being rounded away.
 */
function formatCredits(nanoAiu) {
  const numeric = toFiniteNumber(nanoAiu);
  if (numeric === null) return null;
  const credits = numeric / NANO_AIU_PER_CREDIT;
  return credits >= 0.01 ? credits.toFixed(2) : credits.toFixed(6);
}

/**
 * The numeric fields the SDK worker reports, declared ONCE.
 *
 * Both the normalizer and its "is there anything usable here?" check read this
 * list, so a field can never be normalized-but-not-accepted. That drift is not
 * hypothetical: `subagentModelCalls` was normalized while the acceptance check
 * listed the other six, so a payload carrying only that field was rejected with
 * a 400 by a route that had already understood it.
 *
 * Each entry reads its own value out of the post's three numeric homes, because
 * they are nested differently and the flat output shape hides that.
 */
const COPILOT_WORKER_USAGE_NUMBERS = Object.freeze([
  Object.freeze({ key: 'totalNanoAiu', read: (usage) => usage.totalNanoAiu }),
  Object.freeze({ key: 'inputTokens', read: (usage) => usage.inputTokens }),
  Object.freeze({ key: 'outputTokens', read: (usage) => usage.outputTokens }),
  Object.freeze({ key: 'modelCalls', read: (usage) => usage.modelCalls }),
  Object.freeze({ key: 'subagentModelCalls', read: (usage) => usage.subagentModelCalls }),
  Object.freeze({ key: 'contextTokens', read: (usage, contextUsage) => contextUsage.currentTokens }),
  // `account.getQuota()` reads a stale cache and never shows overage; the quota
  // snapshot riding the usage event is the only place it appears.
  Object.freeze({ key: 'cfiOverage', read: (usage, contextUsage, quotas) => quotas.cfi_overage }),
]);

/**
 * Normalise the SDK worker's per-turn usage post into the snapshot stored under
 * the `copilot-sdk` provider key.
 *
 * Kept deliberately narrow: only the fields the card can show, plus the ids
 * needed to say which turn they came from. Returns null for a payload with
 * nothing usable in it, which is what makes the route's 400 possible.
 *
 * Every count is clamped non-negative. These arrive from a worker over HTTP and
 * are rendered as spend and token totals, so a negative is either a bug or a
 * poster trying to write nonsense onto a shared card; "not reported" is the
 * honest reading of it either way.
 */
export function normalizeCopilotWorkerUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  const contextUsage = raw.contextUsage && typeof raw.contextUsage === 'object' ? raw.contextUsage : {};
  const quotaSnapshots = usage.quotaSnapshots && typeof usage.quotaSnapshots === 'object'
    ? usage.quotaSnapshots
    : {};
  const normalized = {
    conversationId: toTrimmedString(raw.conversationId),
    messageId: toTrimmedString(raw.messageId),
    model: toTrimmedString(raw.model),
    capturedAt: toTrimmedString(raw.capturedAt),
  };
  let hasNumbers = false;
  for (const field of COPILOT_WORKER_USAGE_NUMBERS) {
    const value = pickNonNegative(field.read(usage, contextUsage, quotaSnapshots));
    normalized[field.key] = value;
    if (value !== null) hasNumbers = true;
  }
  return hasNumbers ? normalized : null;
}

/**
 * How long a "last SDK worker turn" snapshot stays worth showing.
 *
 * The snapshot is written per turn and never expires on its own, so without a
 * cutoff a card would keep presenting one turn's numbers as current forever —
 * including after the relay is switched back to the extension engine, where no
 * new snapshot will ever arrive to replace it. A week is long enough to survive
 * a holiday and short enough that nothing on the card is quietly ancient.
 */
export const COPILOT_WORKER_USAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "3 hours ago" for a timestamp, falling back to the raw ISO string when it is
 * unparseable — an odd-looking timestamp is still more informative than
 * dropping the age entirely, and it is the shape a reader can report back.
 */
function formatSnapshotAge(capturedAt, now) {
  const text = toTrimmedString(capturedAt);
  if (!text) return null;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return text;
  const ageMs = now - parsed;
  // A worker clock slightly ahead of the relay's must not render "-1 minutes".
  if (ageMs < 60_000) return 'just now';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * The card section for the last SDK-worker turn.
 *
 * Additive by design: the meters above come from the account-level quota API
 * and are already correct for SDK sessions (they spend the same account's
 * allowance), so this only adds the per-turn detail no relay-side source can
 * see. Absent — extension engine, no turn yet, or a snapshot older than
 * `COPILOT_WORKER_USAGE_MAX_AGE_MS` — the card renders exactly as it did before.
 *
 * The section always says WHEN it was captured. These are one turn's numbers,
 * not a running total, and an undated row of token counts sitting under live
 * meters reads as though it were live too.
 */
export function buildCopilotWorkerUsageSection(usage, { now = Date.now() } = {}) {
  if (!usage || typeof usage !== 'object') return null;
  const capturedAt = toTrimmedString(usage.capturedAt);
  const capturedMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
  // An unparseable or missing timestamp is NOT treated as expired: the numbers
  // are still real, and the note degrades to whatever the payload said.
  if (!Number.isNaN(capturedMs) && now - capturedMs > COPILOT_WORKER_USAGE_MAX_AGE_MS) return null;
  const rows = [
    { label: 'AI credits', value: formatCredits(usage.totalNanoAiu) },
    { label: 'Input tokens', value: formatUnits(usage.inputTokens) },
    { label: 'Output tokens', value: formatUnits(usage.outputTokens) },
    { label: 'Context tokens', value: formatUnits(usage.contextTokens) },
    { label: 'Model calls', value: formatUnits(usage.modelCalls) },
    { label: 'Overage', value: formatUnits(usage.cfiOverage) },
  ].filter((row) => row.value !== null && row.value !== undefined);
  const model = toTrimmedString(usage.model);
  const age = formatSnapshotAge(capturedAt, now);
  const note = [model ? `Model ${model}` : null, age ? `as of ${age}` : null]
    .filter(Boolean)
    .join(' · ');
  return buildDetailSection({
    id: 'copilot-sdk-last-turn',
    label: 'Last SDK worker turn',
    note: note || null,
    rows,
  });
}

/**
 * @param {object} args
 * @param {object|null} args.summary  the quota snapshot from `fetchUsageSummary`
 * @param {object|null} args.billing  `{ items, timePeriod, scope, error }` or null
 * @param {object|null} args.workerUsage  the SDK worker's last-turn snapshot
 * @param {number} [args.now]  clock for ageing `workerUsage`; injected by tests
 */
export function buildCopilotPlanCard({
  summary = null,
  billing = null,
  workerUsage = null,
  error = null,
  capturedAt = new Date().toISOString(),
  now = Date.now(),
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

  const workerSection = buildCopilotWorkerUsageSection(workerUsage, { now });
  if (workerSection) details.push(workerSection);

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
