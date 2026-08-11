import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

test('free space row is omitted when unknown', () => {
  const html = renderContextUsageHtml({ ...usage, freeTokens: null });
  assert.ok(!html.includes('Free space'));
  assert.match(html, /Messages/);
});
