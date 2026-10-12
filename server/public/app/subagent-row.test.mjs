import test from 'node:test';
import assert from 'node:assert/strict';

import { formatRunDuration, mergeLiveSubagentRun, subagentRowHtml, subagentRowsMarkup, topLevelSubagentRuns } from './subagent-row.mjs';

const NOW = Date.parse('2026-10-10T10:10:00.000Z');

const run = (overrides = {}) => ({
  subagentRunId: 'toolu_fixture_alpha',
  displayName: 'Survey the widget parser',
  status: 'completed',
  model: 'claude-opus-5-5',
  subagentType: 'general-purpose',
  totalTokens: 213000,
  startedAt: '2026-10-10T10:00:00.000Z',
  completedAt: '2026-10-10T10:09:53.000Z',
  ...overrides,
});

test('a row carries the panel row grammar: title, model, type badge, tokens and time', () => {
  const html = subagentRowHtml(run(), { now: NOW });
  assert.match(html, /class="bg-task-row subagent-row subagent-row-bubble"/);
  assert.match(html, /data-subagent-open="toolu_fixture_alpha"/);
  assert.match(html, />Survey the widget parser</);
  assert.match(html, /<span class="bg-task-model"[^>]*>Opus 5\.5</);
  assert.match(html, /<span class="bg-task-badge">general-purpose</);
  assert.match(html, />213k tok</);
  assert.match(html, />9m 53s</);
  assert.match(html, /✓ Completed/);
  assert.doesNotMatch(html, /bg-task-stop/, 'Stop lives in the panel and the viewer, not in the bubble');
});

test('a running row counts from its start and says when it runs in the background', () => {
  const html = subagentRowHtml(run({ status: 'running', completedAt: null, background: true }), { now: NOW });
  assert.match(html, /is-running/);
  assert.match(html, /data-started-at="2026-10-10T10:00:00.000Z"/);
  assert.match(html, />10m 0s</);
  assert.match(html, /Running · in the background/);
});

test('a shared view gets the row without the button', () => {
  const html = subagentRowHtml(run(), { clickable: false, now: NOW });
  assert.doesNotMatch(html, /data-subagent-open/);
  assert.match(html, /<span class="bg-task-desc">Survey the widget parser<\/span>/);
});

test('missing fields stay blank and names are escaped', () => {
  const html = subagentRowHtml({ subagentRunId: 'run-x', displayName: '<b>x</b> & "y"', status: 'failed' }, { now: NOW });
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; &amp; &quot;y&quot;/);
  assert.doesNotMatch(html, /bg-task-model/);
  assert.doesNotMatch(html, /bg-task-tokens/);
  assert.match(html, /<span class="bg-task-badge">Subagent</);
  assert.match(html, /✗ Failed/);
  assert.equal(subagentRowHtml({ displayName: 'no id' }), '');
});

test('the bubble lists top-level runs in spawn order, children stay in their parent', () => {
  const runs = [
    run({ subagentRunId: 'b', startedAt: '2026-10-10T10:02:00.000Z' }),
    run({ subagentRunId: 'child', parentSubagentId: 'a', startedAt: '2026-10-10T10:01:30.000Z' }),
    run({ subagentRunId: 'a', startedAt: '2026-10-10T10:01:00.000Z' }),
  ];
  assert.deepEqual(topLevelSubagentRuns(runs).map((entry) => entry.subagentRunId), ['a', 'b']);
  const markup = subagentRowsMarkup(runs, { now: NOW });
  assert.equal((markup.match(/data-subagent-row=/g) || []).length, 2);
  assert.equal(subagentRowsMarkup([]), '');
});

test('durations read in seconds, minutes and hours', () => {
  const start = '2026-10-10T10:00:00.000Z';
  assert.equal(formatRunDuration(start, '2026-10-10T10:00:42.000Z'), '42s');
  assert.equal(formatRunDuration(start, '2026-10-10T11:04:00.000Z'), '1h 4m');
  assert.equal(formatRunDuration(null), '');
});

test('a live entry without a reported status or header leaves the payload run as it is', () => {
  const base = run();
  const laneMade = { subagentRunId: base.subagentRunId, status: 'running', model: null, totalTokens: null, statusReported: false, activities: [] };
  assert.deepEqual(mergeLiveSubagentRun(base, laneMade), base);
  const reported = { ...laneMade, status: 'failed', statusReported: true, totalTokens: 999 };
  const merged = mergeLiveSubagentRun(base, reported);
  assert.equal(merged.status, 'failed');
  assert.equal(merged.totalTokens, 999);
  assert.equal(merged.model, 'claude-opus-5-5');
});
