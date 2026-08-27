import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderAutoCompactControlHtml,
  renderThinkingControlHtml,
  thinkingEnabledFromKey,
  thinkingEnabledToKey,
  renderContextUsageHtml,
  formatCompactTokens,
  formatUsagePercent,
  categoryColor,
  escapeHtml,
} from './context-usage-view.mjs';

// The reference breakdown from the context-usage modal.
const usage = {
  model: 'claude-opus-5[1m]',
  totalTokens: 247100,
  maxTokens: 1000000,
  percentage: 24.71,
  categories: [
    { name: 'System prompt', tokens: 4800, percent: 0.48, color: 'gray' },
    { name: 'System tools', tokens: 19200, percent: 1.92, color: 'blue' },
    { name: 'Skills', tokens: 1800, percent: 0.18, color: 'green' },
    { name: 'Messages', tokens: 221300, percent: 22.13, color: 'orange' },
  ],
  freeTokens: 752900,
  freePercent: 75.29,
  isEstimate: false,
};

test('compact token formatting matches the reference display', () => {
  assert.equal(formatCompactTokens(4800), '4.8k');
  assert.equal(formatCompactTokens(19200), '19.2k');
  assert.equal(formatCompactTokens(221300), '221.3k');
  assert.equal(formatCompactTokens(752900), '752.9k');
  assert.equal(formatCompactTokens(1000000), '1.0M');
  assert.equal(formatCompactTokens(940), '940');
  assert.equal(formatCompactTokens(null), '—');
  assert.equal(formatCompactTokens('nope'), '—');
});

test('percent formatting', () => {
  assert.equal(formatUsagePercent(22.13), '22.1%');
  assert.equal(formatUsagePercent(24.71, { digits: 0 }), '25%');
  assert.equal(formatUsagePercent(undefined), '—');
});

test('renders the model, headline, categories and free space', () => {
  const html = renderContextUsageHtml(usage);
  assert.match(html, /claude-opus-5\[1m\]/);
  assert.match(html, /247\.1k \/ 1\.0M tokens \(25%\)/);
  for (const name of ['System prompt', 'System tools', 'Skills', 'Messages', 'Free space']) {
    assert.ok(html.includes(name), `missing category ${name}`);
  }
  assert.match(html, /221\.3k/);
  assert.match(html, /22\.1%/);
  assert.match(html, /752\.9k/);
  assert.match(html, /75\.3%/);
});

test('bar has one segment per category, sized by percent', () => {
  const html = renderContextUsageHtml(usage);
  const segments = html.match(/ctx-usage-bar-seg/g) || [];
  assert.equal(segments.length, 4);
  assert.match(html, /width:22\.13%/);
  assert.match(html, /background:#e3b341/, 'orange maps to a concrete color');
});

test('unknown colors fall back rather than emitting invalid CSS', () => {
  assert.equal(categoryColor('blue'), '#3b82f6');
  assert.equal(categoryColor('chartreuse'), '#6e7681');
  assert.equal(categoryColor(null), '#6e7681');
});

test('estimate flag renders a caveat worded per estimate kind', () => {
  const lowerBound = renderContextUsageHtml({
    ...usage,
    isEstimate: true,
    estimateKind: 'assistant-output-lower-bound',
  });
  assert.match(lowerBound, /Estimated lower bound/);

  const cursorAverage = renderContextUsageHtml({
    ...usage,
    isEstimate: true,
    estimateKind: 'cursor-per-call-average',
  });
  assert.match(cursorAverage, /aggregate token usage/);

  const unknownKind = renderContextUsageHtml({ ...usage, isEstimate: true });
  assert.match(unknownKind, /Estimated —/);

  assert.ok(!renderContextUsageHtml(usage).includes('Estimated'));
});

test('capturedAt renders a staleness note naming the model', () => {
  const html = renderContextUsageHtml({
    ...usage,
    capturedAt: '2026-08-10T19:19:32.236Z',
  });
  assert.match(html, /As of the last completed turn \(/);
  assert.match(html, /on claude-opus-5\[1m\]/);
  assert.ok(!renderContextUsageHtml({ ...usage, capturedAt: 'not-a-date' })
    .includes('As of the last completed turn'));
});

test('category names are escaped', () => {
  const html = renderContextUsageHtml({
    ...usage,
    categories: [{ name: '<img src=x onerror=1>', tokens: 10, percent: 1, color: 'blue' }],
  });
  assert.ok(!html.includes('<img'), 'raw markup must not reach the DOM');
  assert.match(html, /&lt;img/);
  assert.equal(escapeHtml('a & "b"'), 'a &amp; &quot;b&quot;');
});

test('empty and malformed payloads render nothing', () => {
  assert.equal(renderContextUsageHtml(null), '');
  assert.equal(renderContextUsageHtml(undefined), '');
  assert.equal(renderContextUsageHtml('nope'), '');
  assert.equal(renderContextUsageHtml({ categories: [] }), '');
});

test('deferred categories get a note explaining why the rows out-sum the total', () => {
  // Upstream behaviour, not a bug: the SDK lists deferred tool definitions but
  // leaves them out of totalTokens, so the table has to say so.
  const plain = renderContextUsageHtml(usage);
  assert.ok(!plain.includes('Deferred tools'), 'no note without a deferred row');

  const html = renderContextUsageHtml({
    ...usage,
    categories: [
      ...usage.categories,
      { name: 'MCP tools (deferred)', tokens: 21000, percent: 2.1, color: 'blue', isDeferred: true },
    ],
  });
  assert.match(html, /Deferred tools are listed but not loaded, so they are not counted in the total\./);
  // The numbers themselves are untouched.
  assert.match(html, /247\.1k \/ 1\.0M tokens \(25%\)/);
});

test('free space row is omitted when unknown', () => {
  const html = renderContextUsageHtml({ ...usage, freeTokens: null });
  assert.ok(!html.includes('Free space'));
  assert.match(html, /Messages/);
});

// ── Auto-compact window control (Claude only) ────────────────────────────────

test('the control renders the stored window and the measured threshold', () => {
  const html = renderAutoCompactControlHtml({
    autoCompactWindow: 150000,
    autoCompactThreshold: 967000,
    autocompactSource: 'auto',
    isAutoCompactEnabled: true,
    maxTokens: 1000000,
  });
  assert.match(html, /id="ctx-autocompact-slider"/);
  assert.match(html, /type="range"/);
  // 7 stops: Auto, 100k, 150k, 200k, 300k, 500k, 1M — nothing below the
  // CLI's 100k floor, which it would silently ignore.
  assert.match(html, /min="0"[\s\S]*max="6"[\s\S]*step="1"/);
  assert.match(html, /value="2"/, '150k is stop index 2');
  assert.match(html, /id="ctx-autocompact-value">150k</);
  // Tokens straight through — no percent conversion anywhere in this line.
  assert.match(html, /Effective: compacts at 967\.0k of 1\.0M tokens · auto \(model-tuned\)/);
  assert.ok(!html.includes('Auto-compact is disabled'));
});

test('Auto is the zero index and reads as Auto', () => {
  const html = renderAutoCompactControlHtml({ autoCompactWindow: null, maxTokens: 200000 });
  assert.match(html, /value="0"/);
  assert.match(html, /id="ctx-autocompact-value">Auto</);
});

test('before the first turn the effective line says so, and nothing claims disabled', () => {
  // No context-usage snapshot exists yet, so the caller passes no enabled flag.
  const html = renderAutoCompactControlHtml({ autoCompactWindow: 100000 });
  assert.match(html, /Effective: <span class="ctx-autocompact-muted">— \(known after the first turn\)/);
  // Auto-compact is on by default: "unknown" must not render as "disabled",
  // which would also contradict the muted effective line right above it.
  assert.ok(
    !html.includes('Auto-compact is disabled'),
    'an unknown enabled state must not be reported as disabled',
  );
  // Explicitly-unknown spellings read the same way.
  for (const isAutoCompactEnabled of [null, undefined]) {
    assert.ok(
      !renderAutoCompactControlHtml({ autoCompactWindow: 100000, isAutoCompactEnabled })
        .includes('Auto-compact is disabled'),
      `expected no disabled note for ${String(isAutoCompactEnabled)}`,
    );
  }
  // Only a snapshot that actually reports false says so.
  assert.match(
    renderAutoCompactControlHtml({ autoCompactWindow: 100000, isAutoCompactEnabled: false }),
    /Auto-compact is disabled for this session\./,
  );
  assert.ok(!renderAutoCompactControlHtml({ autoCompactWindow: 100000, isAutoCompactEnabled: true })
    .includes('Auto-compact is disabled'));
});

test('no stop is annotated as beyond the model, whatever the payload reports', () => {
  // The payload carries no trustworthy model limit: `rawMaxTokens` follows the
  // ACTIVE window (probed: pinning 100k reports 100000 on a 1M model), so the
  // old note told a user who had just narrowed the window that widening it
  // again was pointless.
  const html = renderAutoCompactControlHtml({
    autoCompactWindow: 100000,
    autoCompactThreshold: 90000,
    autocompactSource: 'settings',
    isAutoCompactEnabled: true,
    maxTokens: 100000,
  });
  assert.ok(!html.includes('capped to model limit'));
  assert.ok(!/\d+k, \d+k/.test(html), 'no list of unreachable stops');
  assert.match(html, /Effective: compacts at 90\.0k of 100\.0k tokens · from settings/);
});

test('a disabled session gets a read-only note and no toggle', () => {
  const html = renderAutoCompactControlHtml({ isAutoCompactEnabled: false });
  assert.match(html, /Auto-compact is disabled for this session\./);
  assert.ok(!html.includes('type="checkbox"'));
});

test('an unknown source string is rendered escaped, not dropped', () => {
  const html = renderAutoCompactControlHtml({
    autoCompactThreshold: 500000,
    maxTokens: 1000000,
    autocompactSource: '<img src=x>',
    isAutoCompactEnabled: true,
  });
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img src=x&gt;/);
});

test('the thinking control renders both axes with the stored state active', () => {
  const html = renderThinkingControlHtml({ thinkingEnabled: false, thinkingDisplay: 'omitted' });
  assert.match(html, /data-thinking-axis="enabled"[^>]*data-thinking-value="off"[^>]*aria-pressed="true"/s);
  assert.match(html, /data-thinking-axis="display"[^>]*data-thinking-value="omitted"[^>]*aria-pressed="true"/s);
  // Exactly one active button per axis.
  assert.equal((html.match(/is-active/g) || []).length, 2);
});

test('the thinking control defaults to On + Summarized', () => {
  const html = renderThinkingControlHtml({});
  assert.match(html, /data-thinking-axis="enabled"[^>]*data-thinking-value="on"[^>]*aria-pressed="true"/s);
  assert.match(html, /data-thinking-value="summarized"[^>]*aria-pressed="true"/s);
  // Two states per axis — no "host default" button to pick that could not be
  // stored distinctly from "never set".
  assert.equal((html.match(/data-thinking-axis="enabled"/g) || []).length, 2);
  assert.equal((html.match(/data-thinking-axis="display"/g) || []).length, 2);
  assert.doesNotMatch(html, /Host default/);
});

test('the thinking note states the asymmetric semantics and that hiding is not a cost control', () => {
  const html = renderThinkingControlHtml({});
  assert.match(html, /next message/);
  assert.match(html, /next CLI session/);
  assert.match(html, /does not reduce thinking or cost/);
});

test('thinking enabled key mapping round-trips, and anything but off is on', () => {
  assert.equal(thinkingEnabledFromKey(thinkingEnabledToKey(true)), true);
  assert.equal(thinkingEnabledFromKey(thinkingEnabledToKey(false)), false);
  // A legacy null (the old "host default") maps onto the relay default.
  assert.equal(thinkingEnabledToKey(null), 'on');
  assert.equal(thinkingEnabledFromKey('on'), true);
  assert.equal(thinkingEnabledFromKey('off'), false);
});
