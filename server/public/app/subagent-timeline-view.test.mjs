import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTimelineState,
  formatToolInput,
  mergeTimelineEntries,
  orderedTimelineEntries,
  timelineEntryHtml,
  SUMMARY_FIELDS,
  toolCallSummary,
} from './subagent-timeline-view.mjs';
import { SUBAGENT_TOOL_CALL_SUMMARY_FIELDS, subagentToolCallSummary } from '../../../shared/subagent-timeline.mjs';

test('entries merge in seq order and an open entry grows in place', () => {
  const state = createTimelineState('toolu_fixture_alpha');
  let result = mergeTimelineEntries(state, [{ seq: 1, kind: 'text', text: 'The par', done: false }, { seq: 2, kind: 'tool_call', text: '{}' }]);
  assert.deepEqual(result, { changed: [1, 2], gap: false });
  result = mergeTimelineEntries(state, [{ seq: 1, kind: 'text', text: 'The parser is fine.', done: true }]);
  assert.deepEqual(result.changed, [1]);
  assert.equal(state.entries.get(1).text, 'The parser is fine.');
  // A late open snapshot never reopens a closed entry.
  result = mergeTimelineEntries(state, [{ seq: 1, kind: 'text', text: 'The par', done: false }]);
  assert.deepEqual(result.changed, []);
  assert.deepEqual(orderedTimelineEntries(state).map((entry) => entry.seq), [1, 2]);
});

test('a missed seq is a gap until it is filled', () => {
  const state = createTimelineState('run');
  mergeTimelineEntries(state, [{ seq: 1, kind: 'note', text: 'a' }]);
  let result = mergeTimelineEntries(state, [{ seq: 3, kind: 'note', text: 'c' }]);
  assert.equal(result.gap, true);
  assert.equal(state.lastSeq, 1, 'fetch again from the last contiguous seq');
  result = mergeTimelineEntries(state, [{ seq: 2, kind: 'note', text: 'b' }]);
  assert.equal(result.gap, false);
  assert.equal(state.lastSeq, 3);
});

test('a tool call reads as its tool and its main argument, with the full input folded', () => {
  const text = JSON.stringify({ command: 'npm test -- --grep widget', timeout: 120000 });
  assert.equal(toolCallSummary(text), 'npm test -- --grep widget');
  assert.match(formatToolInput(text), /\n {2}"timeout": 120000/);
  const html = timelineEntryHtml({ seq: 4, kind: 'tool_call', toolName: 'Bash', text });
  assert.match(html, /<details class="sav-fold">/, 'folded by default');
  assert.match(html, /🔧/);
  assert.match(html, /<span class="sav-tool-name">Bash<\/span>/);
  assert.match(html, /npm test -- --grep widget/);
  assert.match(html, /<pre class="sav-pre">/);
});

test('a tool result says its size, its cut and whether it failed, folded', () => {
  const html = timelineEntryHtml({ seq: 5, kind: 'tool_result', text: 'line one\nline two', metadata: { isError: true, cut: 9000 } });
  assert.match(html, /is-error/);
  assert.match(html, /Error · 17 chars · cut from 8\.8 KB/);
  assert.match(html, /line one/);
  assert.doesNotMatch(html, /<details class="sav-fold" open>/);
});

test('a thought is folded once done and open while it streams', () => {
  assert.doesNotMatch(timelineEntryHtml({ seq: 1, kind: 'thought', text: 'Done thinking', done: true }), /<details class="sav-fold" open>/);
  assert.match(timelineEntryHtml({ seq: 1, kind: 'thought', text: 'Still', done: false }), /<details class="sav-fold" open>/);
  assert.match(timelineEntryHtml({ seq: 1, kind: 'thought', text: 'Done', done: true }, { openDetails: true }), /<details class="sav-fold" open>/);
});

test('reply text goes through the markdown renderer, escaped by default', () => {
  const html = timelineEntryHtml({ seq: 2, kind: 'text', text: '<script>x</script>' });
  assert.doesNotMatch(html, /<script>/);
  const rendered = timelineEntryHtml({ seq: 2, kind: 'text', text: '**bold**' }, { renderMarkdown: (value) => `<strong>${value.replaceAll('*', '')}</strong>` });
  assert.match(rendered, /<strong>bold<\/strong>/);
});

test('a child entry is a clickable row from its header, or from the entry alone', () => {
  const children = new Map([['toolu_child', { subagentRunId: 'toolu_child', displayName: 'Check the fixtures', status: 'completed', subagentType: 'Explore' }]]);
  const html = timelineEntryHtml({ seq: 6, kind: 'child', toolUseId: 'toolu_child', text: 'Check the fixtures' }, { children });
  assert.match(html, /data-subagent-open="toolu_child"/);
  assert.match(html, /subagent-row-timeline/);
  assert.match(html, /Explore/);
  const bare = timelineEntryHtml({ seq: 7, kind: 'child', toolUseId: 'toolu_other', text: 'Count lines', metadata: { subagentType: 'general-purpose' } });
  assert.match(bare, /data-subagent-open="toolu_other"/);
  assert.match(bare, /general-purpose/);
});

test('a note is a muted line, a failure note is marked', () => {
  assert.match(timelineEntryHtml({ seq: 9, kind: 'note', text: 'Finished: ok', metadata: { status: 'completed' } }), /sav-note sav-note-completed/);
  assert.match(timelineEntryHtml({ seq: 9, kind: 'note', text: 'Process ended', metadata: { status: 'failed' } }), /sav-note-failed/);
});

test('the viewer and the relay know a tool call by the same line', () => {
  assert.deepEqual(SUMMARY_FIELDS, [...SUBAGENT_TOOL_CALL_SUMMARY_FIELDS]);
  const samples = [
    JSON.stringify({ command: 'npm test\n  -- --grep widget', timeout: 1000 }),
    JSON.stringify({ file_path: '/home/dev/widget/parser.js', old_string: 'a', new_string: 'b' }),
    JSON.stringify({ pattern: 'widget'.repeat(60) }),
    JSON.stringify({ alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5 }),
    JSON.stringify({}),
    'Tool (glob): src/**/widget*.js\nsecond line',
    '{ not json',
    '',
  ];
  for (const text of samples) assert.equal(toolCallSummary(text), subagentToolCallSummary(text), text);
});

test('a stripped tool call keeps its line and says its input is gone', () => {
  const html = timelineEntryHtml({
    seq: 7,
    kind: 'tool_call',
    toolName: 'Bash',
    text: 'grep -rn widget /home/dev/widget/src',
    metadata: { pruned: true, prunedAt: '2026-10-11T12:00:00.000Z', originalChars: 120, retentionDays: 90 },
  });
  assert.doesNotMatch(html, /<details/, 'nothing left to unfold');
  assert.match(html, /is-pruned/);
  assert.match(html, /grep -rn widget \/home\/dev\/widget\/src/);
  assert.match(html, /Input removed after 90 days/);
});

test('a stripped tool result says how big it was and that it is gone', () => {
  const html = timelineEntryHtml({
    seq: 8,
    kind: 'tool_result',
    text: '',
    metadata: { pruned: true, originalChars: 3000, retentionDays: 30, isError: true },
  });
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /is-error is-pruned/);
  assert.match(html, /Error · 2\.9 KB · output removed after 30 days/);
  const unknownAge = timelineEntryHtml({ seq: 9, kind: 'tool_result', text: '', metadata: { pruned: true } });
  assert.match(unknownAge, /Result · output removed</);
});
