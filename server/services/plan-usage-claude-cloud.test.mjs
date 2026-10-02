import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeCloudPlanCard,
  describeClaudeCreditOffer,
  humanizeDollarBucketKey,
  listClaudeDollarBuckets,
} from './plan-usage-claude-cloud.mjs';
import { claudePlanUsageFromResult } from './plan-usage-claude.mjs';

const FETCHED_AT = '2026-10-02T10:00:30.000Z';

function window(utilization, resetsAt) {
  return { utilization, resets_at: resetsAt, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null };
}

// The account usage body with invented readings. `iguana_necktie` is the one
// codename the label table knows; `maple_sprocket` stands for any other.
function usageBody(overrides = {}) {
  return {
    five_hour: window(7, '2026-10-02T15:00:00Z'),
    seven_day: window(44, '2026-10-06T09:00:00Z'),
    seven_day_opus: null,
    iguana_necktie: {
      utilization: 4, resets_at: '2026-11-20T08:00:00Z', limit_dollars: 80, used_dollars: 3.25, remaining_dollars: 76.75, locked_reason: null,
    },
    maple_sprocket: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
    limits: [{ kind: 'session', percent: 7, severity: 'normal', resets_at: '2026-10-02T15:00:00Z', scope: null }],
    spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0, enabled: false },
    seven_day_breakdown: { rows: [{ key: 'claude_code', display_name: 'Claude Code', percent: 100 }] },
    member_dashboard_available: false,
    ...overrides,
  };
}

function account(overrides = {}) {
  return { usage: usageBody(), prepaid: null, offer: null, fetchedAt: FETCHED_AT, error: null, ...overrides };
}

test('no card while the provider is off', () => {
  assert.equal(buildClaudeCloudPlanCard({ configured: false, account: account() }), null);
});

test('only top-level objects with a dollar limit are dollar buckets', () => {
  const buckets = listClaudeDollarBuckets(usageBody({
    maple_sprocket: { utilization: 50, resets_at: null, limit_dollars: 20, used_dollars: 10, remaining_dollars: 10 },
    limits: [{ limit_dollars: 5 }],
    not_an_object: 12,
  }));
  assert.deepEqual(buckets, [
    { key: 'iguana_necktie', label: 'Cloud sessions credit', limitUsd: 80, usedUsd: 3.25, remainingUsd: 76.75, utilization: 4, expiresAt: '2026-11-20T08:00:00.000Z' },
    { key: 'maple_sprocket', label: 'Maple sprocket credit', limitUsd: 20, usedUsd: 10, remainingUsd: 10, utilization: 50, expiresAt: null },
  ]);
  assert.deepEqual(listClaudeDollarBuckets(null), []);
  assert.deepEqual(listClaudeDollarBuckets([]), []);
  // A missing limit is not "a limit that is not null".
  assert.deepEqual(listClaudeDollarBuckets({ spend: { limit: null }, extra_usage: { monthly_limit: 10 } }), []);
});

test('an unknown bucket key is humanised, and a prototype key is not a label', () => {
  assert.equal(humanizeDollarBucketKey('maple_sprocket'), 'Maple sprocket credit');
  assert.equal(humanizeDollarBucketKey('ROSE__lantern-2'), 'Rose lantern 2 credit');
  assert.equal(humanizeDollarBucketKey(''), 'Credit');
  const [bucket] = listClaudeDollarBuckets({ constructor: { limit_dollars: 1, used_dollars: 0 } });
  assert.equal(bucket.label, 'Constructor credit');
});

test('the credit is a dollar meter whose date is its expiry', () => {
  const card = buildClaudeCloudPlanCard({ account: account() });
  assert.equal(card.provider, 'claude-cloud');
  assert.equal(card.label, 'Claude Cloud');
  assert.equal(card.status, 'ok');
  assert.equal(card.source, 'live');
  assert.equal(card.capturedAt, FETCHED_AT);
  assert.equal(card.message, null);
  assert.deepEqual(card.meters, [{
    id: 'claude-cloud-credit-iguana_necktie',
    label: 'Cloud sessions credit',
    unit: 'usd',
    unlimited: false,
    estimated: false,
    emphasis: 'primary',
    used: 3.25,
    allowance: 80,
    remaining: 76.75,
    utilization: 4.06,
    resetAt: '2026-11-20T08:00:00.000Z',
    resetKind: 'expiry',
    severity: null,
    note: null,
  }]);
  assert.deepEqual(card.links, [
    { label: 'Claude usage settings', url: 'https://claude.ai/settings/usage' },
    { label: 'Claude Code on the web', url: 'https://claude.ai/code' },
  ]);
});

test('every dollar bucket becomes a meter, a bucket without dollars used falls back to its percentage', () => {
  const card = buildClaudeCloudPlanCard({
    account: account({
      usage: usageBody({
        maple_sprocket: { utilization: 25, resets_at: '2026-12-01T00:00:00Z', limit_dollars: 40, used_dollars: null, remaining_dollars: null },
      }),
    }),
  });
  assert.deepEqual(card.meters.map((meter) => [meter.id, meter.label, meter.used, meter.allowance, meter.remaining, meter.utilization]), [
    ['claude-cloud-credit-iguana_necktie', 'Cloud sessions credit', 3.25, 80, 76.75, 4.06],
    ['claude-cloud-credit-maple_sprocket', 'Maple sprocket credit', 10, 40, 30, 25],
  ]);
});

test('the relay’s own cloud spend is a meter and a section, labelled as reported cost', () => {
  const card = buildClaudeCloudPlanCard({
    account: account(),
    spend: { totalUsd: 1.2345, conversationCount: 3, conversation: { costUsd: 0.18 } },
  });
  const spend = card.meters.find((meter) => meter.id === 'claude-cloud-spend');
  assert.equal(spend.label, 'Cloud spend (OAR sessions)');
  assert.equal(spend.unit, 'usd');
  assert.equal(spend.used, 1.235);
  assert.equal(spend.allowance, null);
  assert.equal(spend.emphasis, 'secondary');
  assert.equal(spend.estimated, false);
  assert.match(spend.note, /^3 cloud conversations on this relay\./);
  assert.match(spend.note, /reported cost, not a billing statement/);

  const section = card.details.find((entry) => entry.id === 'claude-cloud-spend');
  assert.match(section.note, /Not a billing statement/);
  assert.deepEqual(section.rows, [
    { label: 'All cloud conversations', value: '$1.23', hint: '3 cloud conversations' },
    { label: 'This conversation', value: '$0.18', hint: null },
  ]);
});

test('the modal’s conversation row is there only for a cloud conversation', () => {
  const other = buildClaudeCloudPlanCard({ account: account(), spend: { totalUsd: 0.5, conversationCount: 1, conversation: null } });
  const section = other.details.find((entry) => entry.id === 'claude-cloud-spend');
  assert.deepEqual(section.rows, [{ label: 'All cloud conversations', value: '$0.50', hint: '1 cloud conversation' }]);
  assert.match(other.meters.find((meter) => meter.id === 'claude-cloud-spend').note, /^1 cloud conversation on this relay\./);

  const fresh = buildClaudeCloudPlanCard({ account: account(), spend: { totalUsd: 0, conversationCount: 1, conversation: { costUsd: null } } });
  assert.deepEqual(fresh.details.find((entry) => entry.id === 'claude-cloud-spend').rows[1], {
    label: 'This conversation', value: '—', hint: 'No cost reported yet',
  });
});

test('without cloud conversations there is no spend meter and no spend section', () => {
  for (const spend of [null, { totalUsd: 0, conversationCount: 0, conversation: null }]) {
    const card = buildClaudeCloudPlanCard({ account: account(), spend });
    assert.deepEqual(card.meters.map((meter) => meter.id), ['claude-cloud-credit-iguana_necktie']);
    assert.equal(card.details.length, 0);
  }
});

test('without a credit the spend meter leads', () => {
  const card = buildClaudeCloudPlanCard({
    account: account({ usage: usageBody({ iguana_necktie: null }) }),
    spend: { totalUsd: 2, conversationCount: 2, conversation: null },
  });
  assert.deepEqual(card.meters.map((meter) => [meter.id, meter.emphasis]), [['claude-cloud-spend', 'primary']]);
  assert.equal(card.status, 'ok');
  assert.equal(card.message, null);
});

test('an open offer is a note with the amount and the link, only while there is no credit', () => {
  const open = { available: true, eligible: true, granted: false, amount_minor_units: 12000, currency: 'USD' };
  const noCredit = usageBody({ iguana_necktie: null });
  const card = buildClaudeCloudPlanCard({ account: account({ usage: noCredit, offer: open }) });
  assert.deepEqual(card.notes[0], {
    id: 'claude-cloud-credit-offer',
    text: 'A cloud credit of $120.00 is available to claim on claude.ai.',
    link: { label: 'Open the usage page', url: 'https://claude.ai/settings/usage' },
  });
  assert.equal(card.message, 'This account holds no cloud credit, and no cloud conversation on this relay has run yet.');

  const eligibleOnly = buildClaudeCloudPlanCard({ account: account({ usage: noCredit, offer: { available: false, eligible: true } }) });
  assert.equal(eligibleOnly.notes[0].text, 'A cloud credit is available to claim on claude.ai.');

  const withCredit = buildClaudeCloudPlanCard({ account: account({ offer: open }) });
  assert.equal(withCredit.notes.some((note) => note.id === 'claude-cloud-credit-offer'), false);

  for (const offer of [null, { available: false, eligible: false, granted: false }, { available: true, granted: true }]) {
    const none = buildClaudeCloudPlanCard({ account: account({ usage: noCredit, offer }) });
    assert.equal(none.notes.some((note) => note.id === 'claude-cloud-credit-offer'), false);
  }
});

test('describeClaudeCreditOffer formats the amount of the currency it names', () => {
  assert.deepEqual(describeClaudeCreditOffer({ available: true, amount_minor_units: 2550, currency: 'EUR' }), { open: true, amount: '25.50 EUR' });
  assert.deepEqual(describeClaudeCreditOffer({ eligible: true, amount_minor_units: null }), { open: true, amount: null });
  assert.deepEqual(describeClaudeCreditOffer('nope'), { open: false, amount: null });
});

test('the card always says how cloud turns are billed', () => {
  const card = buildClaudeCloudPlanCard({ account: account() });
  assert.deepEqual(card.notes, [{
    id: 'claude-cloud-billing',
    text: 'Cloud turns spend the cloud credit first; without a credit they count against the Claude limits (5-hour and weekly).',
    link: null,
  }]);
});

test('the latest cloud snapshot shows as session details under its own ids', () => {
  const usage = claudePlanUsageFromResult({
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 5200, outputTokens: 800, cacheReadInputTokens: 40000, costUSD: 0.21 } },
    totalCostUsd: 0.21,
  });
  const card = buildClaudeCloudPlanCard({ account: account(), usage, capturedAt: '2026-10-02T09:30:00.000Z' });
  assert.deepEqual(card.details.map((section) => [section.id, section.label]), [
    ['claude-cloud-session', 'Latest cloud session report'],
    ['claude-cloud-models', 'By model (latest cloud session report)'],
  ]);
  assert.deepEqual(card.details[0].rows, [
    { label: 'Reported cost', value: '$0.21', hint: 'Anthropic’s reported cost, not a billing statement' },
  ]);
  assert.equal(card.details[1].rows[0].label, 'claude-sonnet-5-5');
  assert.equal(card.details[1].rows[0].hint, 'in 5.2k · out 800 · cache r 40.0k');
  // The account was read, so that is the card's time.
  assert.equal(card.capturedAt, FETCHED_AT);
});

test('when the account could not be read the card shows what the relay recorded and says so', () => {
  const failed = { usage: null, prepaid: null, offer: null, fetchedAt: FETCHED_AT, error: 'The Claude login has expired.' };
  const card = buildClaudeCloudPlanCard({
    account: failed,
    spend: { totalUsd: 0.9, conversationCount: 2, conversation: null },
    capturedAt: '2026-10-02T09:30:00.000Z',
  });
  assert.equal(card.status, 'partial');
  assert.equal(card.source, 'worker');
  assert.equal(card.capturedAt, '2026-10-02T09:30:00.000Z');
  assert.equal(card.message, 'The account usage could not be read, so a cloud credit is not shown. The Claude login has expired.');
  assert.deepEqual(card.meters.map((meter) => meter.id), ['claude-cloud-spend']);

  const nothing = buildClaudeCloudPlanCard({ account: null });
  assert.equal(nothing.status, 'unavailable');
  assert.equal(nothing.message, 'The account usage could not be read, so a cloud credit is not shown.');
  assert.equal(nothing.meters.length, 0);
  assert.equal(nothing.notes.length, 1);
  assert.equal(nothing.links.length, 2);
});
