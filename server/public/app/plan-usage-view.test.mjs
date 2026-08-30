import test from 'node:test';
import assert from 'node:assert/strict';

import {
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
