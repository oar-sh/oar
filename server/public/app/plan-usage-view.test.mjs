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

test('a Tokens section renders each kind as its own part, "—" kept, with the reason in its note', () => {
  const html = renderPlanUsageHtml(
    report({
      details: [{
        id: 'github-token-usage-byok-openai',
        label: 'Tokens — own OpenAI key',
        note: 'OpenAI does not report cache writes. Counting since Oct 1, 2026.',
        rows: [{ label: 'Today', value: 'in 1.2M · out 340k · cache w — · cache r 45.3M', hint: '97% of input from the cache' }],
      }],
    }),
    { now: NOW },
  );
  assert.match(html, /<summary>Tokens — own OpenAI key<\/summary>/);
  assert.match(html, /<span class="plan-usage-detail-part">cache w —<\/span>/);
  assert.equal((html.match(/plan-usage-detail-part/g) || []).length, 4);
  assert.match(html, /OpenAI does not report cache writes\./);
  assert.match(html, /97% of input from the cache/);
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
  assert.match(html, /class="plan-usage-chart-col plan-usage-chart-col-start" tabindex="0" aria-label="Aug 6: \$3\.00 \(Model A \$1\.00 \(33%\), Model B \$2\.00 \(67%\)\)" data-item="2026-08-06"/);
  assert.match(html, /class="plan-usage-chart-col plan-usage-chart-col-empty" tabindex="0" aria-label="Aug 7: nothing"/);
  assert.match(html, /aria-label="Aug 8: \$4\.01 \(Model A \$4\.00 \(100%\), Model B \$0\.0050 \(0%\)\)"/);
  // Heights are shares of the tallest column; colours come from the theme's series variables in order.
  assert.match(html, /data-series="a" style="height:24\.97%;background:var\(--plan-usage-series-1\)" title="Model A \$1\.00"/);
  assert.match(html, /data-series="b" style="height:49\.94%;background:var\(--plan-usage-series-2\)" title="Model B \$2\.00"/);
  assert.match(html, /data-series="a" style="height:99\.88%;background:var\(--plan-usage-series-1\)" title="Model A \$4\.00"/);
  // A zero segment is not drawn.
  assert.equal((html.match(/plan-usage-chart-seg/g) || []).length, 4);
  assert.match(html, /<span class="plan-usage-chart-tip" role="tooltip">Aug 6: \$3\.00/);
  // The legend gives each series' total in the window; above the plot, the peak day and the total.
  assert.match(html, /<ul class="plan-usage-chart-legend"><li><span class="plan-usage-chart-swatch" style="background:var\(--plan-usage-series-1\)" aria-hidden="true"><\/span>Model A<span class="plan-usage-chart-legend-value">\$5\.00<\/span><\/li><li>[^<]*<span class="plan-usage-chart-swatch" style="background:var\(--plan-usage-series-2\)" aria-hidden="true"><\/span>Model B<span class="plan-usage-chart-legend-value">\$2\.0\d<\/span><\/li><\/ul>/);
  assert.match(html, /<div class="plan-usage-chart-scale"><span>Peak \$4\.0\d · Aug 8<\/span><span>Total \$7\.0\d<\/span><\/div>/);
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

test('a bars chart: every bar against the largest, so a smaller total draws a shorter bar', () => {
  const chart = {
    id: 'shares',
    label: 'Where the money goes',
    kind: 'bars',
    unit: 'usd',
    series: [{ key: 'hit', label: 'Cache hit' }, { key: 'miss', label: 'Cache miss' }],
    items: [
      { key: 'flash', label: 'Flash', values: { hit: 1, miss: 3 } },
      { key: 'pro', label: 'Pro', values: { hit: 0.5, miss: 0.5 } },
    ],
  };
  const html = renderPlanUsageHtml(report({ meters: [], charts: [chart] }), { now: NOW });
  assert.match(html, /data-series="hit" style="width:25\.00%;[^"]*" title="Cache hit \$1\.00"/);
  assert.match(html, /data-series="miss" style="width:75\.00%;[^"]*" title="Cache miss \$3\.00"/);
  assert.match(html, /data-series="hit" style="width:12\.50%;[^"]*" title="Cache hit \$0\.50"/);
  assert.match(html, /data-series="miss" style="width:12\.50%;[^"]*" title="Cache miss \$0\.50"/);
});

test('a share chart: one line cut by model, largest first and "Other models" last, each in its series colour, with a list of amounts and shares', () => {
  const chart = {
    id: 'claude-spend-shares-30d',
    label: 'Where it would go at API prices, last 30 days',
    kind: 'share',
    unit: 'usd',
    windowDays: 30,
    series: [
      { key: 'model:Fable 5.2', label: 'Fable 5.2' },
      { key: 'model:Haiku 5.5', label: 'Haiku 5.5' },
      { key: 'model:Opus 5.5', label: 'Opus 5.5' },
      { key: 'other', label: 'Other models' },
    ],
    items: [{ key: 'last-30d', label: 'Last 30 days', values: { 'model:Fable 5.2': 190, 'model:Haiku 5.5': 0, 'model:Opus 5.5': 1700, other: 110 } }],
    note: "Claude Code's figure at API prices; the subscription is billed flat, this is not charged.",
  };
  const html = renderPlanUsageHtml(report({ meters: [], charts: [chart] }), { now: NOW, chartWindow: 30 });
  assert.match(html, /<figure class="plan-usage-chart plan-usage-chart-kind-share" data-chart-id="claude-spend-shares-30d" role="group" aria-label="Where it would go at API prices, last 30 days" data-window="30">/);
  // One line; each part as long as its share of the total, in the colour its series has in the daily chart.
  assert.match(html, /<div class="plan-usage-chart-strip" role="img" aria-label="Last 30 days: \$2000\.00; Opus 5\.5 \$1700\.00 \(85%\), Fable 5\.2 \$190\.00 \(10%\), Other models \$110\.00 \(6%\)">/);
  const segs = [...html.matchAll(/class="plan-usage-chart-seg" data-series="([^"]+)" style="width:([\d.]+)%;background:var\(--plan-usage-series-(\d)\)"/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(segs, [['model:Opus 5.5', '85.00', '3'], ['model:Fable 5.2', '9.50', '1']]);
  // "Other models" is grey, wherever it sits.
  assert.match(html, /data-series="other" style="width:5\.50%;background:var\(--plan-usage-series-other\)"/);
  // A model with nothing draws no part and no row.
  assert.doesNotMatch(html, /Haiku 5\.5/);
  // The list is the legend: swatch, name, amount, share.
  assert.match(html, /<li data-series="model:Opus 5\.5"><span class="plan-usage-chart-swatch" style="background:var\(--plan-usage-series-3\)" aria-hidden="true"><\/span><span class="plan-usage-chart-share-name">Opus 5\.5<\/span><span class="plan-usage-chart-share-value">\$1700\.00<\/span><span class="plan-usage-chart-share-pct">85%<\/span><\/li>/);
  assert.doesNotMatch(html, /plan-usage-chart-legend|plan-usage-chart-bars|plan-usage-chart-row/);
  assert.match(html, /class="plan-usage-meter-note">Claude Code&#39;s figure at API prices/);
  assert.match(html, /<tr><th scope="row">Total<\/th><td class="plan-usage-detail-value">\$2000\.00<\/td><td class="plan-usage-detail-value">100%<\/td><\/tr>/);
  // A part under 1% says so; a share with nothing in it draws nothing.
  const tiny = renderPlanUsageHtml(report({ meters: [], charts: [{ ...chart, items: [{ ...chart.items[0], values: { 'model:Opus 5.5': 999, 'model:Fable 5.2': 1 } }] }] }), { now: NOW, chartWindow: 30 });
  assert.match(tiny, /<span class="plan-usage-chart-share-pct">&lt;1%<\/span>/);
  const empty = renderPlanUsageHtml(report({ meters: [], charts: [{ ...chart, items: [{ ...chart.items[0], values: {} }] }] }), { now: NOW, chartWindow: 30 });
  assert.doesNotMatch(empty, /plan-usage-chart-kind-share/);
});

test('series colours: eight in a fixed order, then grey; "other" is grey wherever it sits', () => {
  const series = Array.from({ length: 10 }, (_, index) => ({ key: `model:m${index}`, label: `M${index}` }));
  const chart = {
    id: 'many',
    label: 'Where the money goes, last 30 days',
    kind: 'share',
    unit: 'usd',
    series,
    items: [{ key: 'last-30d', label: 'Last 30 days', values: Object.fromEntries(series.map((entry, index) => [entry.key, 20 - index])) }],
  };
  const html = renderPlanUsageHtml(report({ meters: [], charts: [chart] }), { now: NOW });
  const colours = [...html.matchAll(/<li data-series="model:m(\d)"><span class="plan-usage-chart-swatch" style="background:var\(--plan-usage-series-([\w]+)\)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(colours, [['0', '1'], ['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'], ['5', '6'], ['6', '7'], ['7', '8'], ['8', 'other'], ['9', 'other']]);
  // Every model is listed and in the table, none folded away.
  assert.equal((html.match(/<th scope="row">M\d<\/th>/g) || []).length, 10);
  const daily = renderPlanUsageHtml(report({ meters: [], charts: [{ id: 'd', label: 'Daily', kind: 'columns', unit: 'usd', series: [{ key: 'model:a', label: 'A' }, { key: 'other', label: 'Other models' }], items: [{ key: '2026-08-08', label: 'Aug 8', values: { 'model:a': 1, other: 1 } }] }] }), { now: NOW });
  assert.match(daily, /data-series="other" style="height:[\d.]+%;background:var\(--plan-usage-series-other\)"/);
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

test('a detail row with a title shows it when pointed at; one without has none', () => {
  const section = {
    id: 'claude-token-usage-by-model',
    label: 'Tokens by model, this month',
    open: true,
    rows: [
      { label: 'Claude Opus 5.5', value: 'in 150 · out 15', hint: null, title: 'Model ids: claude-opus-5-5, claude-opus-5-5-<dated>' },
      { label: 'Claude Haiku 4.5', value: 'in 1 · out 1', hint: null },
    ],
    note: null,
  };
  const html = renderPlanUsageHtml(report({ meters: [], details: [section] }), { now: NOW });
  assert.match(html, /<tr title="Model ids: claude-opus-5-5, claude-opus-5-5-&lt;dated&gt;">\s*<td class="plan-usage-detail-label">Claude Opus 5\.5</);
  assert.match(html, /<tr>\s*<td class="plan-usage-detail-label">Claude Haiku 4\.5</);
});

test('the Claude API card renders from the server\'s builder: its tab, the cap bar in dollars, "estimate incomplete"', async () => {
  const { buildClaudeApiPlanCard } = await import('../../services/plan-usage-claude-api.mjs');
  const models = [
    { model: 'claude-sonnet-5-5', hitTokens: 0, missTokens: 1000, outputTokens: 100, costUsd: 4.2, unknownCostTokens: 0 },
    { model: 'claude-new-model', hitTokens: 0, missTokens: 300, outputTokens: 30, costUsd: 0, unknownCostTokens: 330 },
  ];
  const card = buildClaudeApiPlanCard({
    settings: { configured: true, enabled: true, monthlyCapUsd: 5 },
    spend: {
      bounds: { today: '2026-08-08', month: '2026-08', monthStart: '2026-08-01', monthEnd: '2026-08-31', nextMonthStart: '2026-09-01' },
      today: { models, costUsd: 4.2, unknownCostTokens: 330 },
      month: { models, costUsd: 4.2, unknownCostTokens: 330 },
      lastSeenAt: '2026-08-08T11:00:00.000Z',
    },
    resetAt: '2026-09-01T00:00:00.000Z',
    timeZone: 'UTC',
  });
  const html = renderPlanUsageHtml({ version: 2, generatedAt: NOW.toISOString(), providers: [card] }, { now: NOW, activeProvider: 'claude-api' });
  assert.match(html, /data-usage-panel="claude-api"/);
  assert.match(html, /Claude API/);
  assert.match(html, /data-meter-id="claude-api-monthly-cap"/);
  assert.match(html, /\$4\.20/);
  assert.match(html, /estimate incomplete/);
  assert.match(html, /no price known/);
  assert.match(html, /platform\.claude\.com\/settings\/billing/);
});

test('the DeepSeek budget help text names the steps the bar is drawn with', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /The bar changes colour at 50 % and 75 % of the budget and turns red at 90 %\./);
  assert.doesNotMatch(html, /amber near the budget and red over it/);
  // The steps themselves: two changes of colour, then red.
  assert.equal(utilizationColor(49), '#3fb950');
  assert.equal(utilizationColor(50), '#d29922');
  assert.equal(utilizationColor(75), '#e3b341');
  assert.equal(utilizationColor(90), '#f85149');
});

test('the OpenAI images card draws its meter, figures and badges from the spend state', async () => {
  const { buildOpenAIImagePlanCard } = await import('../../services/plan-usage-openai-image.mjs');
  const state = {
    day: '2026-08-08', capUsd: 5, spentUsd: 4, reservedUsd: 0.1, estimatedUsd: 0.2, unknownPriceUsd: 0,
    monthUsd: 7.8, ratio: 0.82, warning: true, reached: false, allowedToday: false, allowedAt: null,
  };
  const card = buildOpenAIImagePlanCard({ state, configured: true });
  const html = renderPlanUsageHtml({ version: 2, generatedAt: NOW.toISOString(), providers: [card] }, { now: NOW, activeProvider: 'openai-image' });
  assert.match(html, /data-usage-panel="openai"/);
  assert.match(html, /OpenAI images/);
  assert.match(html, /class="plan-usage-bar-mark" style="left:80%"/);
  assert.match(html, /USD 4\.10 of 5\.00 · resets at midnight/);
  assert.match(html, /Today&#39;s OpenAI image spend: USD 4\.10 of 5\.00\./);
  assert.match(html, /Estimated<span class="plan-usage-fact-hint">/);
  assert.equal((html.match(/data-meter-id="openai-images-daily-cap"/g) || []).length, 1, 'one meter, not the generic one too');
  assert.doesNotMatch(html, /\$/);
  // A newer state redraws the card alone.
  const { renderPlanUsageCardHtml } = await import('./plan-usage-view.mjs');
  const reached = renderPlanUsageCardHtml({ ...card, imageSpend: { ...state, spentUsd: 5, reached: true } }, { now: NOW });
  assert.match(reached, /Cap reached/);
  assert.match(reached, /Daily image cap reached/);
  assert.equal(normalizeUsageProvider('openai-image'), 'openai');
});

test('the tokens unit: 999, 12.3k, 4.6M, 1.2B on the column, the tooltip, the bar total and the table', () => {
  assert.deepEqual([999, 12_300, 4_600_000, 1_234_500_000, 0].map((value) => formatAmount(value, 'tokens')), ['999', '12.3k', '4.6M', '1.2B', '0']);
  const daily = {
    id: 'github-daily-tokens-7d',
    label: 'Daily tokens, last 7 days',
    kind: 'columns',
    unit: 'tokens',
    windowDays: 7,
    series: [{ key: 'model:a', label: 'Opus 5.5' }, { key: 'model:b', label: 'GPT' }],
    items: [{ key: '2026-08-08', label: 'Aug 8', values: { 'model:a': 1_200_000_000, 'model:b': 999 } }],
  };
  const split = {
    id: 'github-token-shares-7d',
    label: 'Where the tokens go, last 7 days',
    kind: 'bars',
    unit: 'tokens',
    windowDays: 7,
    series: [{ key: 'inputTokens', label: 'Fresh input' }, { key: 'cacheReadTokens', label: 'Cache reads' }],
    items: [{ key: 'Opus 5.5', label: 'Opus 5.5', values: { inputTokens: 12_300, cacheReadTokens: 4_600_000 } }],
  };
  const html = renderPlanUsageHtml(report({ meters: [], charts: [daily, split] }), { now: NOW, chartWindow: 7 });
  assert.match(html, /class="plan-usage-chart-col plan-usage-chart-col-start" tabindex="0" aria-label="Aug 8: 1\.2B tokens \(Opus 5\.5 1\.2B tokens \(100%\), GPT 999 tokens \(0%\)\)"/);
  assert.match(html, /<span class="plan-usage-chart-tip" role="tooltip">Aug 8: 1\.2B tokens \(Opus 5\.5 1\.2B tokens/);
  assert.match(html, /class="plan-usage-chart-row-value">4\.6M tokens</);
  assert.match(html, /title="Fresh input 12\.3k tokens"/);
  assert.match(html, /<td class="plan-usage-detail-value">1\.2B tokens<\/td>/);
});

const windowChart = (windowDays, extra = {}) => ({
  id: `grok-daily-spend-${windowDays}d`,
  label: `Daily spend, last ${windowDays} days`,
  kind: 'columns',
  unit: 'usd',
  windowDays,
  series: [{ key: 'model:grok-5', label: 'grok-5' }],
  items: [{ key: '2026-08-08', label: 'Aug 8', values: { 'model:grok-5': windowDays / 10 } }],
  ...extra,
});

test('the window picker: on a card with windowed charts only, the picked window shown, the others hidden', () => {
  const charts = [windowChart(7), windowChart(30), windowChart(90)];
  const html = renderPlanUsageHtml(multiReport(
    { provider: 'grok', label: 'Grok', charts },
    { provider: 'cursor', label: 'Cursor', charts: [] },
  ), { now: NOW, activeProvider: 'grok', chartWindow: 30 });
  const grok = panelHtml(html, 'grok');
  assert.match(grok, /<div class="plan-usage-charts" data-chart-window="30">/);
  assert.match(grok, /<fieldset class="plan-usage-chart-window">\s*<legend class="plan-usage-chart-window-legend">Window<\/legend>/);
  assert.deepEqual([...grok.matchAll(/<input type="radio" name="plan-usage-chart-window-grok" value="(\d+)"( checked)?>/g)].map((match) => [match[1], Boolean(match[2])]), [
    ['7', false], ['30', true], ['90', false],
  ]);
  assert.match(grok, /<label><input type="radio" name="plan-usage-chart-window-grok" value="7"><span>7 days<\/span><\/label>/);
  assert.match(grok, /data-chart-id="grok-daily-spend-7d" role="group" aria-label="Daily spend, last 7 days" data-window="7" hidden>/);
  assert.match(grok, /data-chart-id="grok-daily-spend-30d" role="group" aria-label="Daily spend, last 30 days" data-window="30">/);
  assert.match(grok, /data-chart-id="grok-daily-spend-90d" role="group" aria-label="Daily spend, last 90 days" data-window="90" hidden>/);
  assert.doesNotMatch(grok, /Nothing to chart in the last/);
  // No windowed charts, no picker.
  assert.doesNotMatch(panelHtml(html, 'cursor'), /plan-usage-chart-window|plan-usage-charts/);
  // Another window picked: its charts show.
  const ninety = panelHtml(renderPlanUsageHtml(multiReport({ provider: 'grok', label: 'Grok', charts }), { now: NOW, chartWindow: 90 }), 'grok');
  assert.match(ninety, /value="90" checked>/);
  assert.match(ninety, /data-window="90">/);
  assert.match(ninety, /data-window="30" hidden>/);
  // A bad window falls back to the stored one (none in Node: 30).
  assert.match(renderPlanUsageHtml(multiReport({ provider: 'grok', label: 'Grok', charts }), { now: NOW, chartWindow: 31 }), /value="30" checked>/);
});

test('a chart without a window is never hidden; an empty window says so and keeps the picker', () => {
  const allTime = { id: 'deepseek-spend-shares', label: 'Where the money goes', kind: 'bars', unit: 'usd', series: [{ key: 'miss', label: 'Cache miss' }], items: [{ key: 'flash', label: 'Flash', values: { miss: 1 } }] };
  const html = renderPlanUsageHtml(multiReport({ provider: 'deepseek', label: 'DeepSeek', charts: [windowChart(30), windowChart(90), allTime] }), { now: NOW, chartWindow: 7 });
  assert.match(html, /data-chart-id="deepseek-spend-shares" role="group" aria-label="Where the money goes">/);
  assert.match(html, /value="7" checked>/);
  assert.match(html, /<div class="plan-usage-chart-empty plan-usage-meter-note" data-window="7">Nothing to chart in the last 7 days\.<\/div>/);
  assert.doesNotMatch(html, /data-window="30">/);
  // Picked 30: the empty line is there for 7, hidden.
  const thirty = renderPlanUsageHtml(multiReport({ provider: 'deepseek', label: 'DeepSeek', charts: [windowChart(30), windowChart(90)] }), { now: NOW, chartWindow: 30 });
  assert.match(thirty, /data-window="7" hidden>Nothing to chart in the last 7 days\./);
  // A report kept from before windows: no picker, charts as before.
  const old = renderPlanUsageHtml(multiReport({ provider: 'grok', label: 'Grok', charts: [{ ...windowChart(30), windowDays: undefined }] }), { now: NOW });
  assert.doesNotMatch(old, /plan-usage-chart-window|data-window/);
  assert.match(old, /data-chart-id="grok-daily-spend-30d" role="group" aria-label="Daily spend, last 30 days">/);
});

test('the picker and its charts are escaped', () => {
  const html = renderPlanUsageHtml(multiReport({ provider: 'x"<y>', label: 'X', charts: [windowChart(30, { id: 'c"<1>', label: 'L <b>' })] }), { now: NOW, chartWindow: 30 });
  assert.match(html, /name="plan-usage-chart-window-x&quot;&lt;y&gt;"/);
  assert.match(html, /data-chart-id="c&quot;&lt;1&gt;" role="group" aria-label="L &lt;b&gt;" data-window="30">/);
  assert.doesNotMatch(html, /<b>|<y>/);
});

test('a column in the first or last fifth opens its tooltip towards the middle, at 7, 30 and 90 days', () => {
  const edgesOf = (count) => {
    const items = Array.from({ length: count }, (_, index) => ({ key: `d${index}`, label: `D${index}`, values: { a: index % 2 } }));
    const html = renderPlanUsageHtml(report({ meters: [], charts: [{ id: 'c', label: 'C', kind: 'columns', unit: 'usd', series: [{ key: 'a', label: 'A' }], items }] }), { now: NOW });
    return [...html.matchAll(/class="plan-usage-chart-col(?: plan-usage-chart-col-empty)?( plan-usage-chart-col-(start|end))?" tabindex="0" aria-label="[^"]*" data-item="d(\d+)"/g)]
      .map((match) => match[2] || 'middle');
  };
  const runs = (edges) => ['start', 'middle', 'end'].map((name) => edges.filter((edge) => edge === name).length);
  // A fifth, rounded up, at each end.
  assert.deepEqual(edgesOf(7), ['start', 'start', 'middle', 'middle', 'middle', 'end', 'end']);
  assert.deepEqual(runs(edgesOf(30)), [6, 18, 6]);
  assert.deepEqual(runs(edgesOf(90)), [18, 54, 18]);
  // In order: the starts first, the ends last.
  const ninety = edgesOf(90);
  assert.deepEqual([ninety[17], ninety[18], ninety[71], ninety[72]], ['start', 'middle', 'middle', 'end']);
  // A single column is a start.
  assert.deepEqual(edgesOf(1), ['start']);
});
