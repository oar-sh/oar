import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatLocalHourRanges,
  formatAmount,
  formatResetCountdown,
  meterSummaryText,
  normalizeUsageProvider,
  planUsageSubtitle,
  renderPlanUsageHtml,
  resolveActiveUsageProvider,
  utilizationColor,
} from './plan-usage-view.mjs';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function meter(overrides = {}) {
  return {
    id: 'm1',
    label: 'AI credits',
    unit: 'credits',
    unlimited: false,
    estimated: false,
    emphasis: 'primary',
    used: 1100,
    allowance: 1500,
    remaining: 400,
    utilization: 73.33,
    resetAt: '2026-09-01T00:00:00.000Z',
    note: null,
    ...overrides,
  };
}

function report(cardOverrides = {}) {
  return {
    version: 2,
    generatedAt: NOW.toISOString(),
    providers: [{
      provider: 'github',
      label: 'GitHub Copilot',
      status: 'ok',
      planName: 'copilot_pro',
      message: null,
      source: 'live',
      capturedAt: NOW.toISOString(),
      stale: false,
      meters: [meter()],
      details: [],
      links: [{ label: 'GitHub billing settings', url: 'https://github.com/settings/billing' }],
      ...cardOverrides,
    }],
  };
}

function multiReport(...cardOverrides) {
  const base = report().providers[0];
  return {
    version: 2,
    generatedAt: NOW.toISOString(),
    providers: cardOverrides.map((overrides) => ({ ...base, meters: [], ...overrides })),
  };
}

const THREE_PROVIDERS = () => multiReport(
  { provider: 'github', label: 'GitHub Copilot' },
  { provider: 'claude', label: 'Claude' },
  { provider: 'cursor', label: 'Cursor' },
);

/** The section for one provider, so per-panel assertions cannot read a sibling. */
function panelHtml(html, provider) {
  const start = html.indexOf(`data-usage-panel="${provider}"`);
  assert.notEqual(start, -1, `no panel for ${provider}`);
  const from = html.lastIndexOf('<section', start);
  const end = html.indexOf('</section>', start);
  return html.slice(from, end);
}

test('an empty or malformed report renders nothing', () => {
  assert.equal(renderPlanUsageHtml(null), '');
  assert.equal(renderPlanUsageHtml({ providers: [] }), '');
  assert.equal(renderPlanUsageHtml('nope'), '');
});

test('a meter renders a clamped bar with an accessible label', () => {
  const html = renderPlanUsageHtml(report(), { now: NOW });
  assert.match(html, /class="plan-usage-bar-fill"[^>]*width:73\.33%/);
  assert.match(html, /aria-label="AI credits: 73% used"/);
  assert.match(html, /1100 of 1500 used · 400 left/);
});

test('overage clamps the bar at 100% and is worded as "over"', () => {
  const html = renderPlanUsageHtml(
    report({ meters: [meter({ used: 1600, remaining: -100, utilization: 100 })] }),
    { now: NOW },
  );
  assert.match(html, /width:100%/);
  assert.match(html, /100 over/);
  // The overage is a magnitude — a signed "-100 over" is the bug this guards.
  assert.doesNotMatch(html, /-100 over/);
});

test('an unknown utilization renders a striped bar instead of a false zero', () => {
  const html = renderPlanUsageHtml(
    report({ meters: [meter({ used: null, allowance: null, remaining: null, utilization: null })] }),
    { now: NOW },
  );
  assert.match(html, /plan-usage-bar-unknown/);
  assert.match(html, /plan-usage-meter-pct">—</);
});

test('unlimited buckets render as full and infinite', () => {
  const html = renderPlanUsageHtml(
    report({ meters: [meter({ unlimited: true, used: null, allowance: null, remaining: null, utilization: null })] }),
    { now: NOW },
  );
  assert.match(html, /∞/);
  assert.match(html, /Unlimited/);
});

test('estimated meters are flagged in the UI', () => {
  const html = renderPlanUsageHtml(
    report({ meters: [meter({ estimated: true })] }),
    { now: NOW },
  );
  assert.match(html, /plan-usage-flag">estimated</);
});

test('secondary meters are grouped below the primary ones', () => {
  const html = renderPlanUsageHtml(
    report({ meters: [meter(), meter({ id: 'm2', label: 'Chat', emphasis: 'secondary' })] }),
    { now: NOW },
  );
  assert.match(html, /plan-usage-secondary/);
  assert.ok(html.indexOf('data-meter-id="m1"') < html.indexOf('data-meter-id="m2"'));
});

test('detail sections render collapsed with their note', () => {
  const html = renderPlanUsageHtml(
    report({
      details: [{
        id: 'claude-behaviors-day',
        label: 'What is driving usage',
        note: 'Approximate, from local transcripts',
        rows: [{ label: 'API requests', value: '120', hint: null }],
      }],
    }),
    { now: NOW },
  );
  assert.match(html, /<details class="plan-usage-details"/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  assert.match(html, /Approximate, from local transcripts/);
});

test('card content is HTML-escaped', () => {
  const html = renderPlanUsageHtml(
    report({ message: '<img src=x onerror=alert(1)>', meters: [meter({ label: '<script>' })] }),
    { now: NOW },
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('an unrecognized status or source renders no badge instead of a prototype value', () => {
  const html = renderPlanUsageHtml(
    report({ status: 'constructor', source: 'toString' }),
    { now: NOW },
  );
  assert.doesNotMatch(html, /function/);
  assert.doesNotMatch(html, /native code/);
  assert.match(html, /data-status="constructor"/);
});

test('links open safely in a new tab', () => {
  const html = renderPlanUsageHtml(report(), { now: NOW });
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
});

test('unavailable cards still render their explanation', () => {
  const html = renderPlanUsageHtml(
    report({ status: 'unavailable', meters: [], message: 'No Claude usage captured yet.' }),
    { now: NOW },
  );
  assert.match(html, /data-status="unavailable"/);
  assert.match(html, /No Claude usage captured yet\./);
});

test('reset countdowns scale from minutes to a date', () => {
  assert.equal(formatResetCountdown('2026-08-08T12:30:00.000Z', NOW), 'resets in 30 min');
  assert.equal(formatResetCountdown('2026-08-08T15:00:00.000Z', NOW), 'resets in 3 h');
  assert.equal(formatResetCountdown('2026-08-11T12:00:00.000Z', NOW), 'resets in 3 d');
  assert.equal(formatResetCountdown('2026-09-30T12:00:00.000Z', NOW), 'resets 2026-09-30');
  assert.equal(formatResetCountdown('2026-08-08T11:00:00.000Z', NOW), 'resets now');
  assert.equal(formatResetCountdown(null, NOW), null);
  assert.equal(formatResetCountdown('not-a-date', NOW), null);
});

test('amounts format per unit', () => {
  assert.equal(formatAmount(12.5, 'usd'), '$12.50');
  assert.equal(formatAmount(-3.5, 'usd'), '-$3.50');
  assert.equal(formatAmount(73.33, 'percent'), '73.3%');
  assert.equal(formatAmount(1500, 'credits'), '1500');
  assert.equal(formatAmount(25000, 'credits'), '25.0k');
  assert.equal(formatAmount(null, 'credits'), null);
});

test('bar colour escalates with utilization', () => {
  assert.equal(utilizationColor(10), '#3fb950');
  assert.equal(utilizationColor(80), '#e3b341');
  assert.equal(utilizationColor(95), '#f85149');
  assert.equal(utilizationColor(null), '#6e7681');
});

test('a utilization-only meter summarises as a percentage', () => {
  assert.equal(
    meterSummaryText(meter({ used: null, allowance: null, remaining: null, utilization: 61.5 })),
    '61.5% used',
  );
});

test('provider spellings fold onto the card ids the report uses', () => {
  assert.equal(normalizeUsageProvider('copilot'), 'github');
  assert.equal(normalizeUsageProvider('GitHub-Copilot'), 'github');
  assert.equal(normalizeUsageProvider(' Claude '), 'claude');
  assert.equal(normalizeUsageProvider('openai'), 'openai');
  assert.equal(normalizeUsageProvider(null), '');
});

test('the active tab is the requested provider when it has a card', () => {
  const providers = THREE_PROVIDERS().providers;
  assert.equal(resolveActiveUsageProvider(providers, 'claude'), 'claude');
  assert.equal(resolveActiveUsageProvider(providers, 'copilot'), 'github');
});

test('a provider without a card falls back to the first card', () => {
  const providers = THREE_PROVIDERS().providers;
  // 'openai' sessions have no usage card of their own.
  assert.equal(resolveActiveUsageProvider(providers, 'openai'), 'github');
  assert.equal(resolveActiveUsageProvider(providers, 'grok'), 'github');
  assert.equal(resolveActiveUsageProvider(providers, ''), 'github');
  assert.equal(resolveActiveUsageProvider([], 'claude'), '');
});

test('one tab per provider, with the session provider selected', () => {
  const html = renderPlanUsageHtml(THREE_PROVIDERS(), { now: NOW, activeProvider: 'claude' });
  assert.match(html, /<div class="plan-usage-tab-strip" role="tablist"/);
  assert.match(html, /data-usage-tab="github"[^>]*>Copilot</);
  assert.match(html, /data-usage-tab="cursor"[^>]*>Cursor</);
  assert.match(
    html,
    /class="plan-usage-tab active"[^>]*aria-selected="true"[^>]*aria-controls="plan-usage-panel-claude"|aria-controls="plan-usage-panel-claude"[^>]*aria-selected="true"/,
  );
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.equal((html.match(/tabindex="-1"/g) || []).length, 2);
});

test('only the active provider card is visible', () => {
  const html = renderPlanUsageHtml(THREE_PROVIDERS(), { now: NOW, activeProvider: 'cursor' });
  assert.doesNotMatch(panelHtml(html, 'cursor'), /\shidden/);
  assert.match(panelHtml(html, 'github'), /\shidden/);
  assert.match(panelHtml(html, 'claude'), /\shidden/);
  assert.match(panelHtml(html, 'cursor'), /role="tabpanel"[^>]*/);
  assert.match(panelHtml(html, 'cursor'), /aria-labelledby="plan-usage-tab-cursor"/);
});

test('an unknown active provider still opens the first card', () => {
  const html = renderPlanUsageHtml(THREE_PROVIDERS(), { now: NOW, activeProvider: 'openai' });
  assert.doesNotMatch(panelHtml(html, 'github'), /\shidden/);
  assert.match(panelHtml(html, 'claude'), /\shidden/);
});

test('the Claude account renders as email · plan under the card title', () => {
  const html = renderPlanUsageHtml(
    multiReport({ provider: 'claude', label: 'Claude', account: { loggedIn: true, email: 'someone@example.com', plan: 'max' } }),
    { now: NOW },
  );
  assert.match(html, /class="plan-usage-account">someone@example\.com · max</);
});

test('a logged-out Claude account says so, and a missing one says nothing', () => {
  const out = renderPlanUsageHtml(
    multiReport({ provider: 'claude', label: 'Claude', account: { loggedIn: false } }),
    { now: NOW },
  );
  assert.match(out, /plan-usage-account-signed-out">Not logged in</);
  // No account key at all = the status probe failed; the card must not claim
  // either state.
  const unknown = renderPlanUsageHtml(multiReport({ provider: 'claude', label: 'Claude' }), { now: NOW });
  assert.doesNotMatch(unknown, /plan-usage-account/);
  assert.doesNotMatch(unknown, /Not logged in/);
});

test('a logged-in account with no details still reads as logged in', () => {
  const html = renderPlanUsageHtml(
    multiReport({ provider: 'claude', label: 'Claude', account: { loggedIn: true } }),
    { now: NOW },
  );
  assert.match(html, /class="plan-usage-account">Logged in</);
});

test('the account line is HTML-escaped', () => {
  const html = renderPlanUsageHtml(
    multiReport({
      provider: 'claude',
      label: 'Claude',
      account: { loggedIn: true, email: '<img src=x onerror=alert(1)>', plan: '"max"' },
    }),
    { now: NOW },
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('the subtitle counts reporting providers and the nearest reset', () => {
  assert.match(planUsageSubtitle(report()), /1 provider reporting · next reset/);
  assert.equal(planUsageSubtitle({ providers: [] }), 'No usage data available');
  assert.equal(
    planUsageSubtitle({ providers: [{ provider: 'claude', meters: [] }] }),
    'No plan limits reported yet',
  );
});

// ─── Claude Cloud card, notes, severity, expiry ──────────────────────────────

const CLOUD_CARD = () => ({
  provider: 'claude-cloud',
  label: 'Claude Cloud',
  source: 'live',
  planName: null,
  meters: [meter({
    id: 'claude-cloud-credit-sample',
    label: 'Cloud sessions credit',
    unit: 'usd',
    used: 3.25,
    allowance: 80,
    remaining: 76.75,
    utilization: 4.06,
    resetAt: '2026-11-20T08:00:00.000Z',
    resetKind: 'expiry',
  })],
  notes: [
    {
      id: 'claude-cloud-credit-offer',
      text: 'A cloud credit of $120.00 is available to claim on claude.ai.',
      link: { label: 'Open the usage page', url: 'https://claude.ai/settings/usage' },
    },
    { id: 'claude-cloud-billing', text: 'Cloud turns spend the cloud credit first.', link: null },
  ],
  links: [{ label: 'Claude Code on the web', url: 'https://claude.ai/code' }],
});

test('the Claude Cloud card gets its own tab and opens for a cloud conversation', () => {
  const data = multiReport(
    { provider: 'github', label: 'GitHub Copilot' },
    { provider: 'claude', label: 'Claude' },
    CLOUD_CARD(),
  );
  assert.equal(resolveActiveUsageProvider(data.providers, 'claude-cloud'), 'claude-cloud');
  assert.equal(resolveActiveUsageProvider(data.providers, 'claude'), 'claude');
  const html = renderPlanUsageHtml(data, { now: NOW, activeProvider: 'claude-cloud' });
  assert.match(html, /id="plan-usage-tab-claude-cloud"[^>]*aria-selected="true"[^>]*>Claude Cloud<\/button>/);
  assert.match(html, /id="plan-usage-tab-claude"[^>]*aria-selected="false"/);
  const panel = panelHtml(html, 'claude-cloud');
  assert.doesNotMatch(panel.slice(0, panel.indexOf('>')), /\shidden/);
  assert.match(panel, /\$3\.25 of \$80\.00 used · \$76\.75 left/);
});

test('a credit’s date reads as an expiry, not as a reset', () => {
  const html = renderPlanUsageHtml(multiReport(CLOUD_CARD()), { now: NOW });
  assert.match(html, /\$76\.75 left · expires 2026-11-20/);
  assert.doesNotMatch(html, /resets 2026-11-20/);

  assert.equal(formatResetCountdown('2026-08-11T12:00:00.000Z', NOW, { expiry: true }), 'expires in 3 d');
  assert.equal(formatResetCountdown('2026-08-08T12:30:00.000Z', NOW, { expiry: true }), 'expires in 30 min');
  assert.equal(formatResetCountdown('2026-08-08T15:20:00.000Z', NOW, { expiry: true }), 'expires in 3 h 20 min');
  assert.equal(formatResetCountdown('2026-08-08T11:00:00.000Z', NOW, { expiry: true }), 'expired');
  assert.equal(formatResetCountdown(null, NOW, { expiry: true }), null);
});

test('an expiry is not offered as the next reset in the subtitle', () => {
  assert.equal(planUsageSubtitle(multiReport(CLOUD_CARD())), '1 provider reporting');
  const mixed = multiReport(CLOUD_CARD(), { provider: 'claude', label: 'Claude', meters: [meter({ resetAt: '2099-01-01T00:00:00.000Z' })] });
  assert.equal(planUsageSubtitle(mixed), '2 providers reporting · next reset 2099-01-01');
});

test('card notes render above the details, with their link when they have one', () => {
  const html = renderPlanUsageHtml(
    multiReport({
      ...CLOUD_CARD(),
      details: [{ id: 'claude-cloud-spend', label: 'Cloud spend', note: null, rows: [{ label: 'All', value: '$1.00', hint: null }] }],
    }),
    { now: NOW },
  );
  assert.match(
    html,
    /<div class="plan-usage-detail-note plan-usage-note" data-note-id="claude-cloud-credit-offer">A cloud credit of \$120\.00 is available to claim on claude\.ai\. <a class="plan-usage-link" href="https:\/\/claude\.ai\/settings\/usage" target="_blank" rel="noopener noreferrer">Open the usage page<\/a><\/div>/,
  );
  assert.match(html, /data-note-id="claude-cloud-billing">Cloud turns spend the cloud credit first\.<\/div>/);
  assert.ok(html.indexOf('data-note-id="claude-cloud-billing"') < html.indexOf('<details'));
  assert.ok(html.indexOf('data-meter-id="claude-cloud-credit-sample"') < html.indexOf('data-note-id="claude-cloud-credit-offer"'));
});

test('a note is escaped, and a link that is not https stays text', () => {
  const html = renderPlanUsageHtml(
    report({
      notes: [
        { id: 'a"b', text: '<b>bold</b>', link: { label: '<i>go</i>', url: 'https://example.com/?a=1&b="2"' } },
        { id: 'unsafe', text: 'no link here', link: { label: 'click', url: 'javascript:alert(1)' } },
        { id: 'empty', text: '   ' },
        null,
      ],
    }),
    { now: NOW },
  );
  assert.doesNotMatch(html, /<b>bold<\/b>/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(html, /data-note-id="a&quot;b"/);
  assert.match(html, /href="https:\/\/example\.com\/\?a=1&amp;b=&quot;2&quot;"/);
  assert.match(html, /&lt;i&gt;go&lt;\/i&gt;<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /data-note-id="unsafe">no link here<\/div>/);
  assert.doesNotMatch(html, /data-note-id="empty"/);
});

test('a note\'s hours of the day are shown in the reader\'s time zone, the UTC wording stays as the title', () => {
  const html = renderPlanUsageHtml(
    report({
      notes: [
        { id: 'hours', text: 'Peak is 01:00–04:00 and 06:00–10:00 UTC; <b>cheaper</b> otherwise.', link: null, hours: { utcRanges: [[1, 4], [6, 10]], utcText: '01:00–04:00 and 06:00–10:00 UTC' } },
        // Data the text does not name is left alone.
        { id: 'plain', text: 'Nothing timed.', link: null, hours: { utcRanges: [[1, 4]], utcText: '01:00–04:00 UTC' } },
      ],
    }),
    { now: new Date('2026-07-01T12:00:00.000Z'), timeZone: 'America/New_York' },
  );
  assert.match(html, /data-note-id="hours" title="Peak is 01:00–04:00 and 06:00–10:00 UTC; &lt;b&gt;cheaper&lt;\/b&gt; otherwise\.">Peak is 21:00–00:00 and 02:00–06:00 in your time zone; &lt;b&gt;cheaper&lt;\/b&gt; otherwise\.<\/div>/);
  assert.match(html, /data-note-id="plain">Nothing timed\.<\/div>/);
  assert.equal(formatLocalHourRanges([[1, 4], [6, 10]], { now: new Date('2026-10-21T12:00:00.000Z'), timeZone: 'Europe/Berlin' }), '03:00–06:00 and 08:00–12:00 in your time zone');
  // Winter: the same hours, one hour earlier.
  assert.equal(formatLocalHourRanges([[1, 4], [6, 10]], { now: new Date('2026-12-01T12:00:00.000Z'), timeZone: 'Europe/Berlin' }), '02:00–05:00 and 07:00–11:00 in your time zone');
  assert.equal(formatLocalHourRanges([[1, 4]], { timeZone: 'UTC' }), '01:00–04:00 in your time zone');
  assert.equal(formatLocalHourRanges([[4, 1]], { timeZone: 'UTC' }), null);
  assert.equal(formatLocalHourRanges([], { timeZone: 'UTC' }), null);
  assert.equal(formatLocalHourRanges([[1, 4]], { timeZone: 'Not/AZone' }), null);
});

test('a card without notes renders none', () => {
  assert.doesNotMatch(renderPlanUsageHtml(report(), { now: NOW }), /plan-usage-note/);
});

test('a severity other than normal is flagged on its meter', () => {
  const html = renderPlanUsageHtml(
    report({
      meters: [
        meter({ id: 'calm', severity: 'normal' }),
        meter({ id: 'none', severity: null }),
        meter({ id: 'hot', label: 'Weekly limit', severity: 'near_limit' }),
      ],
    }),
    { now: NOW },
  );
  const flags = html.match(/plan-usage-flag-severity/g) || [];
  assert.equal(flags.length, 1);
  assert.match(html, /Weekly limit<span class="plan-usage-flag plan-usage-flag-severity" data-severity="near_limit">near limit<\/span>/);

  const escaped = renderPlanUsageHtml(report({ meters: [meter({ severity: '<x>' })] }), { now: NOW });
  assert.doesNotMatch(escaped, /<x>/);
  assert.match(escaped, /data-severity="&lt;x&gt;"/);
});

test('a meter in yuan reads with the yuan sign', () => {
  assert.equal(formatAmount(40, 'cny'), '¥40.00');
  assert.equal(formatAmount(-0.5, 'cny'), '-¥0.50');
  const html = renderPlanUsageHtml(
    report({ meters: [meter({ id: 'deepseek-balance-cny', label: 'Balance (CNY)', unit: 'cny', used: 40, allowance: 150, remaining: 110, utilization: 26.67, resetAt: null })] }),
    { now: NOW },
  );
  assert.match(html, /data-meter-id="deepseek-balance-cny"/);
  assert.match(html, /¥40\.00 of ¥150\.00 used · ¥110\.00 left/);
  assert.match(html, /aria-label="Balance \(CNY\): 27% used"/);
});

test('a columns chart: one column per item stacked by series, a text equivalent on each, a legend and a table', () => {
  const chart = {
    id: 'daily',
    label: 'Daily spend, last 3 days',
    kind: 'columns',
    unit: 'usd',
    series: [{ key: 'a', label: 'Model A' }, { key: 'b', label: 'Model B' }],
    items: [
      { key: '2026-08-06', label: 'Aug 6', values: { a: 1, b: 2 } },
      { key: '2026-08-07', label: 'Aug 7', values: { a: 0, b: 0 } },
      { key: '2026-08-08', label: 'Aug 8', values: { a: 4, b: 0.005 } },
    ],
    note: 'Estimated, by UTC day.',
    summary: null,
  };
  const html = renderPlanUsageHtml(report({ meters: [], charts: [chart] }), { now: NOW });
  assert.match(html, /<figure class="plan-usage-chart plan-usage-chart-kind-columns" data-chart-id="daily" role="group" aria-label="Daily spend, last 3 days">/);
  // The figure never wears the plot's class: that made the whole figure a
  // grid of one column per day, title, legend and table squeezed into them.
  assert.doesNotMatch(html, /<figure[^>]*\bplan-usage-chart-(?:columns|bars)\b/);
  assert.match(html, /class="plan-usage-chart-label">Daily spend, last 3 days</);
  assert.match(html, /style="--plan-usage-columns:3"/);
  // Each column says what it holds; an empty day says so.
  assert.match(html, /class="plan-usage-chart-col" tabindex="0" aria-label="Aug 6: \$3\.00 \(Model A \$1\.00 \(33%\), Model B \$2\.00 \(67%\)\)" data-item="2026-08-06"/);
  assert.match(html, /class="plan-usage-chart-col plan-usage-chart-col-empty" tabindex="0" aria-label="Aug 7: nothing"/);
  assert.match(html, /aria-label="Aug 8: \$4\.01 \(Model A \$4\.00 \(100%\), Model B \$0\.0050 \(0%\)\)"/);
  // Heights are shares of the tallest column; colours come from the theme's series variables in order.
  assert.match(html, /data-series="a" style="height:24\.97%;background:var\(--plan-usage-series-1\)" title="Model A \$1\.00"/);
  assert.match(html, /data-series="b" style="height:49\.94%;background:var\(--plan-usage-series-2\)" title="Model B \$2\.00"/);
  assert.match(html, /data-series="a" style="height:99\.88%;background:var\(--plan-usage-series-1\)" title="Model A \$4\.00"/);
  // A zero segment is not drawn.
  assert.equal((html.match(/plan-usage-chart-seg/g) || []).length, 4);
  assert.match(html, /<span class="plan-usage-chart-tip" role="tooltip">Aug 6: \$3\.00/);
  assert.match(html, /<ul class="plan-usage-chart-legend"><li><span class="plan-usage-chart-swatch" style="background:var\(--plan-usage-series-1\)" aria-hidden="true"><\/span>Model A<\/li><li>[^<]*<span class="plan-usage-chart-swatch" style="background:var\(--plan-usage-series-2\)" aria-hidden="true"><\/span>Model B<\/li><\/ul>/);
  assert.match(html, /class="plan-usage-chart-axis" aria-hidden="true"><span>Aug 6<\/span><span>Aug 8<\/span>/);
  assert.match(html, /class="plan-usage-meter-note">Estimated, by UTC day\.</);
  // The table has the same numbers, without the empty day.
  assert.match(html, /<summary>As a table<\/summary>/);
  assert.match(html, /<thead><tr><th scope="col"><\/th><th scope="col">Model A<\/th><th scope="col">Model B<\/th><th scope="col">Total<\/th><\/tr><\/thead>/);
  assert.match(html, /<tr><th scope="row">Aug 6<\/th><td class="plan-usage-detail-value">\$1\.00<\/td><td class="plan-usage-detail-value">\$2\.00<\/td><td class="plan-usage-detail-value">\$3\.00<\/td><\/tr>/);
  assert.doesNotMatch(html, /<th scope="row">Aug 7</);
  // Labels are escaped wherever they land.
  const escaped = renderPlanUsageHtml(report({ meters: [], charts: [{ ...chart, label: 'A <b>', series: [{ key: 'a', label: '<i>' }], items: [{ key: 'x', label: '"q"', values: { a: 1 } }] }] }), { now: NOW });
  assert.doesNotMatch(escaped, /<b>|<i>/);
  assert.match(escaped, /aria-label="A &lt;b&gt;"/);
  assert.match(escaped, /aria-label="&quot;q&quot;: \$1\.00"/);
});

test('a bars chart: one row per item with its shares, the total beside it, and a summary line; one series needs no legend', () => {
  const chart = {
    id: 'shares',
    label: 'Where the money goes',
    kind: 'bars',
    unit: 'cny',
    series: [{ key: 'hit', label: 'Cache hit' }, { key: 'miss', label: 'Cache miss' }],
    items: [{ key: 'flash', label: 'Flash', values: { hit: 1, miss: 3 } }],
    summary: 'Cache saved about ¥49.00',
  };
  const html = renderPlanUsageHtml(report({ meters: [], charts: [chart] }), { now: NOW });
  assert.match(html, /<figure class="plan-usage-chart plan-usage-chart-kind-bars" data-chart-id="shares"/);
  assert.match(html, /class="plan-usage-chart-summary">Cache saved about ¥49\.00</);
  assert.match(html, /class="plan-usage-chart-row" tabindex="0" aria-label="Flash: ¥4\.00 \(Cache hit ¥1\.00 \(25%\), Cache miss ¥3\.00 \(75%\)\)"/);
  assert.match(html, /<span class="plan-usage-chart-bar" aria-hidden="true"><span class="plan-usage-chart-seg" data-series="hit" style="width:25\.00%;background:var\(--plan-usage-series-1\)" title="Cache hit ¥1\.00"><\/span><span class="plan-usage-chart-seg" data-series="miss" style="width:75\.00%;background:var\(--plan-usage-series-2\)" title="Cache miss ¥3\.00"><\/span><\/span>/);
  assert.match(html, /class="plan-usage-chart-row-value">¥4\.00</);
  // One series: no shares in the text, no legend, no total column.
  const single = renderPlanUsageHtml(report({ meters: [], charts: [{ ...chart, series: [{ key: 'hit', label: 'Cache hit' }], summary: null }] }), { now: NOW });
  assert.match(single, /aria-label="Flash: ¥1\.00"/);
  assert.doesNotMatch(single, /plan-usage-chart-legend|plan-usage-chart-summary|<th scope="col">Total/);
  // A chart without series or items, or a card without charts, draws nothing.
  const none = renderPlanUsageHtml(report({ meters: [], charts: [{ ...chart, items: [] }, { ...chart, series: [] }, null] }), { now: NOW });
  assert.doesNotMatch(none, /plan-usage-chart/);
  assert.doesNotMatch(renderPlanUsageHtml(report(), { now: NOW }), /plan-usage-chart/);
});

test('a note with a label and a value is a row of figures; on a card with figures the sentences follow the tables', () => {
  const section = { id: 'by-model', label: 'Tokens by model', open: true, rows: [{ label: 'Model A', value: 'cache hit 1.0M · cache miss 2.0k · output 30', hint: null }], note: null };
  const fact = { id: 'spend', text: 'Estimated spend: $3.00 since 2026-08-01', label: 'Estimated spend', value: '$3.00', hint: 'since 2026-08-01', link: null, hours: null };
  const sentence = { id: 'about', text: 'How the estimate is made.', link: null, hours: null };
  const html = renderPlanUsageHtml(report({ meters: [], notes: [fact, sentence], details: [section] }), { now: NOW });
  assert.match(html, /<dl class="plan-usage-facts"><div class="plan-usage-fact" data-note-id="spend" title="Estimated spend: \$3\.00 since 2026-08-01"><dt>Estimated spend<span class="plan-usage-fact-hint">since 2026-08-01<\/span><\/dt><dd>\$3\.00<\/dd><\/div><\/dl>/);
  assert.match(html, /data-section-id="by-model" open>/);
  // The value breaks between its parts only.
  assert.match(html, /<span class="plan-usage-detail-part">cache hit 1\.0M<\/span> · <span class="plan-usage-detail-part">cache miss 2\.0k<\/span> · <span class="plan-usage-detail-part">output 30<\/span>/);
  assert.ok(html.indexOf('data-section-id="by-model"') < html.indexOf('data-note-id="about"'), 'the sentences come after the tables');
  // A card without figures keeps its order: notes, then the tables, closed.
  const plain = renderPlanUsageHtml(report({ meters: [], notes: [sentence], details: [{ ...section, open: undefined }] }), { now: NOW });
  assert.ok(plain.indexOf('data-note-id="about"') < plain.indexOf('data-section-id="by-model"'));
  assert.match(plain, /data-section-id="by-model">/);
  assert.doesNotMatch(plain, /plan-usage-facts/);
});
