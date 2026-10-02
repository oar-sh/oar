'use strict';

/**
 * Claude Cloud usage (provider `claude-cloud`).
 *
 * Cloud sessions are billed to the Claude account: a dollar credit is spent
 * first where the account holds one, and without it the turns count against
 * the same 5-hour and weekly windows the Claude card shows. So this card has
 * no windows of its own. It shows
 *  - the dollar buckets of the live account usage (the credit and its expiry),
 *  - what the relay's own cloud conversations have cost, as Anthropic reported
 *    it per session (the relay keeps the latest figure per conversation; there
 *    is no account-wide total to ask for),
 *  - the session detail of the latest cloud worker report.
 *
 * The credit arrives under an internal codename that may change, so every
 * top-level bucket of the usage body that carries a dollar limit is a meter;
 * the codename table only supplies a nicer label.
 */

import {
  SOURCE_LIVE,
  SOURCE_WORKER,
  STATUS_OK,
  STATUS_PARTIAL,
  STATUS_UNAVAILABLE,
  buildDetailSection,
  buildMeter,
  buildProviderCard,
  pickNonNegative,
  toFiniteNumber,
  toIsoTimestamp,
  toTrimmedString,
} from './plan-usage-contract.mjs';
import { CLAUDE_USAGE_URL, buildClaudeSessionSections, formatClaudeMoney } from './plan-usage-claude.mjs';

export const CLAUDE_CLOUD_PROVIDER_ID = 'claude-cloud';
export const CLAUDE_CLOUD_LABEL = 'Claude Cloud';

const CLAUDE_CODE_WEB_URL = 'https://claude.ai/code';

// Null-prototype: the keys come from an API body.
const DOLLAR_BUCKET_LABELS = Object.freeze(Object.assign(Object.create(null), {
  iguana_necktie: 'Cloud sessions credit',
}));

/** "maple_sprocket" → "Maple sprocket credit": the label of a bucket the table does not know. */
export function humanizeDollarBucketKey(key) {
  const words = String(key ?? '').replace(/[^A-Za-z0-9]+/g, ' ').trim().toLowerCase();
  if (!words) return 'Credit';
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} credit`;
}

/**
 * The dollar buckets of an account usage body, in the body's order: every
 * top-level value that is an object with a numeric `limit_dollars`.
 */
export function listClaudeDollarBuckets(usageBody) {
  if (!usageBody || typeof usageBody !== 'object' || Array.isArray(usageBody)) return [];
  const buckets = [];
  for (const [key, value] of Object.entries(usageBody)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const limitUsd = toFiniteNumber(value.limit_dollars);
    if (limitUsd === null) continue;
    buckets.push({
      key,
      label: DOLLAR_BUCKET_LABELS[key] || humanizeDollarBucketKey(key),
      limitUsd,
      usedUsd: toFiniteNumber(value.used_dollars),
      remainingUsd: toFiniteNumber(value.remaining_dollars),
      utilization: toFiniteNumber(value.utilization),
      expiresAt: toIsoTimestamp(value.resets_at),
    });
  }
  return buckets;
}

/**
 * What the credit-offer answer says: `{ open, amount }`, where `amount` is
 * the formatted sum when the answer names one. An offer that was granted
 * already is not open.
 */
export function describeClaudeCreditOffer(offer) {
  if (!offer || typeof offer !== 'object') return { open: false, amount: null };
  const open = (offer.available === true || offer.eligible === true) && offer.granted !== true;
  const minor = toFiniteNumber(offer.amount_minor_units);
  const amount = minor !== null && minor > 0 ? formatClaudeMoney(minor / 100, offer.currency) : null;
  return { open, amount };
}

/**
 * @param {object} options
 * @param {object|null} options.account  live account usage (`{ usage, prepaid,
 *   offer, fetchedAt, error }`), or null when it was not read
 * @param {object|null} options.spend    what the relay recorded: `{ totalUsd,
 *   conversationCount, conversation: { costUsd } | null }` (`conversation` is
 *   the one the modal was opened from, when it is a cloud conversation)
 * @param {object|null} options.usage    the latest `claude-cloud` snapshot
 * @param {string|null} options.capturedAt  when that snapshot was stored
 * @param {boolean} options.configured   Claude Cloud provider enabled
 */
export function buildClaudeCloudPlanCard({
  account = null,
  spend = null,
  usage = null,
  capturedAt = null,
  configured = true,
} = {}) {
  // Opt-in like Grok: no card at all while the provider is off.
  if (!configured) return null;

  const hasAccount = !!account?.usage && typeof account.usage === 'object';
  const buckets = hasAccount ? listClaudeDollarBuckets(account.usage) : [];
  const meters = buckets.map((bucket) => buildMeter({
    id: `claude-cloud-credit-${bucket.key.replace(/[^A-Za-z0-9_]+/g, '-')}`,
    label: bucket.label,
    unit: 'usd',
    used: bucket.usedUsd,
    allowance: bucket.limitUsd,
    remaining: bucket.remainingUsd,
    // The dollars are exact; the percentage only stands in when they are missing.
    utilization: bucket.usedUsd === null && bucket.remainingUsd === null ? bucket.utilization : null,
    resetAt: bucket.expiresAt,
    resetKind: 'expiry',
    emphasis: 'primary',
  })).filter(Boolean);
  const hasCredit = meters.length > 0;

  const details = [];
  const conversationCount = Math.max(0, Math.round(toFiniteNumber(spend?.conversationCount) || 0));
  if (conversationCount > 0) {
    const totalUsd = pickNonNegative(spend?.totalUsd) ?? 0;
    const countText = `${conversationCount} cloud conversation${conversationCount === 1 ? '' : 's'}`;
    meters.push(buildMeter({
      id: 'claude-cloud-spend',
      label: 'Cloud spend (OAR sessions)',
      unit: 'usd',
      used: totalUsd,
      emphasis: hasCredit ? 'secondary' : 'primary',
      note: `${countText} on this relay. Anthropic’s reported cost, not a billing statement.`,
    }));
    const rows = [{ label: 'All cloud conversations', value: formatClaudeMoney(totalUsd), hint: countText }];
    if (spend?.conversation && typeof spend.conversation === 'object') {
      const cost = pickNonNegative(spend.conversation.costUsd);
      rows.push({
        label: 'This conversation',
        value: cost === null ? '—' : formatClaudeMoney(cost),
        hint: cost === null ? 'No cost reported yet' : null,
      });
    }
    details.push(buildDetailSection({
      id: 'claude-cloud-spend',
      label: 'Cloud spend (OAR sessions)',
      note: 'The cost Anthropic reports per cloud session, summed over the cloud conversations this relay still has. Not a billing statement; sessions started elsewhere are not included.',
      rows,
    }));
  }

  details.push(...buildClaudeSessionSections(usage?.session, {
    idPrefix: 'claude-cloud',
    sessionLabel: 'Latest cloud session report',
    modelsLabel: 'By model (latest cloud session report)',
    costLabel: 'Reported cost',
    costHint: 'Anthropic’s reported cost, not a billing statement',
  }));

  const notes = [];
  const offer = describeClaudeCreditOffer(account?.offer);
  if (!hasCredit && offer.open) {
    notes.push({
      id: 'claude-cloud-credit-offer',
      text: offer.amount
        ? `A cloud credit of ${offer.amount} is available to claim on claude.ai.`
        : 'A cloud credit is available to claim on claude.ai.',
      link: { label: 'Open the usage page', url: CLAUDE_USAGE_URL },
    });
  }
  notes.push({
    id: 'claude-cloud-billing',
    text: 'Cloud turns spend the cloud credit first; without a credit they count against the Claude limits (5-hour and weekly).',
  });

  const resolvedMeters = meters.filter(Boolean);
  const resolvedDetails = details.filter(Boolean);
  let status = STATUS_OK;
  let message = null;
  if (!hasAccount) {
    status = resolvedMeters.length || resolvedDetails.length ? STATUS_PARTIAL : STATUS_UNAVAILABLE;
    message = ['The account usage could not be read, so a cloud credit is not shown.', toTrimmedString(account?.error)]
      .filter(Boolean)
      .join(' ');
  } else if (!resolvedMeters.length) {
    message = 'This account holds no cloud credit, and no cloud conversation on this relay has run yet.';
  }

  return buildProviderCard({
    provider: CLAUDE_CLOUD_PROVIDER_ID,
    label: CLAUDE_CLOUD_LABEL,
    status,
    message,
    source: hasAccount ? SOURCE_LIVE : SOURCE_WORKER,
    capturedAt: hasAccount ? (toIsoTimestamp(account.fetchedAt) || capturedAt) : capturedAt,
    meters: resolvedMeters,
    details: resolvedDetails,
    notes,
    links: [
      { label: 'Claude usage settings', url: CLAUDE_USAGE_URL },
      { label: 'Claude Code on the web', url: CLAUDE_CODE_WEB_URL },
    ],
  });
}
