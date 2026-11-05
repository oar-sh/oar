import test from 'node:test';
import assert from 'node:assert/strict';

import { isProgressActivityText, renderTurnStreamMarkup, turnStreamEntries } from './turn-stream-view.mjs';
import {
  FINISHED_ACTIVITY_LIMIT_PER_THREAD,
  capRelayActivityEntries,
  mergeRelayActivityTexts,
  normalizeRelayActivityEntry,
} from './activity-replay-state.mjs';
import { mergeRelayThoughts, normalizeRelayThoughtList } from './relay-thoughts.mjs';

// The fixture turn of the plan: thought, Read, thought, Grep, narration
// thought, Agent spawn, reply. Sub-agent rows carry numbers too but stay out.
const THOUGHTS = [
  { reasoningId: 'claude-thought-main-0-0', text: 'Find where the widget cache lives.', turnSeq: 1, done: true },
  { reasoningId: 'claude-thought-main-1-0', text: 'It is in cache.js; look for eviction.', turnSeq: 3, done: true },
  { reasoningId: 'claude-thought-main-2-0', text: 'I will ask an agent to check the tests.', turnSeq: 5, done: true },
  { reasoningId: 'claude-thought-sub', text: 'Sub-agent thinking', turnSeq: 7, done: true, subagentRunId: 'toolu_fixture_agent' },
];
const ACTIVITIES = [
  { text: 'Tool (Read): src/cache.js', subagentRunId: null, turnSeq: 2 },
  { text: 'Tool (Grep): evict', subagentRunId: null, turnSeq: 4 },
  { text: 'Tool (Agent): Check the widget tests', subagentRunId: null, turnSeq: 6 },
  { text: 'Tool (Glob): tests/**', subagentRunId: 'toolu_fixture_agent', turnSeq: 8 },
  { text: '● Explored the widget cache', subagentRunId: null, turnSeq: 9 },
];

test('the fixture turn lists thought, Read, thought, Grep, thought, Agent, then the reply', () => {
  const entries = turnStreamEntries({ thoughts: THOUGHTS, activities: ACTIVITIES, text: 'The cache evicts the oldest widget.' });
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.turnSeq]), [
    ['thought', 1], ['tool', 2], ['thought', 3], ['tool', 4], ['thought', 5], ['tool', 6], ['reply', null],
  ]);
  assert.equal(entries.at(-1).text, 'The cache evicts the oldest widget.');
  assert.equal(isProgressActivityText(ACTIVITIES[4].text), true, 'the progress line stays out');
});

test('a turn with a main-thread row lacking turnSeq keeps the grouped layout (null)', () => {
  assert.equal(turnStreamEntries({ thoughts: [{ ...THOUGHTS[0], turnSeq: undefined }], activities: ACTIVITIES, text: 'x' }), null);
  assert.equal(turnStreamEntries({ thoughts: THOUGHTS, activities: [{ text: 'Tool (Read): a.js' }, ...ACTIVITIES], text: 'x' }), null);
  // A sub-agent row without a number does not count: it is not in the list.
  assert.notEqual(turnStreamEntries({ thoughts: THOUGHTS, activities: [...ACTIVITIES, { text: 'Tool (x): y', subagentRunId: 'toolu_other' }], text: 'x' }), null);
  // Nothing to order: null as well.
  assert.equal(turnStreamEntries({ thoughts: [], activities: [], text: 'Just a reply.' }), null);
});

test('the "earlier tool lines omitted" row has no number, never makes a turn grouped, and sits at the gap', () => {
  // 3 main tool lines, cap 2 per thread: the first goes, the marker comes in its place.
  const rows = [
    { text: 'Tool (view): a.js', subagentRunId: null, turnSeq: 2 },
    { text: 'Tool (view): b.js', subagentRunId: null, turnSeq: 4 },
    { text: 'Tool (view): c.js', subagentRunId: null, turnSeq: 6 },
  ];
  const capped = capRelayActivityEntries(rows, 2, { omittedMarker: true });
  assert.deepEqual(capped.map((row) => row.text), ['… 1 earlier tool line omitted', 'Tool (view): b.js', 'Tool (view): c.js']);
  assert.equal(capped[0].metadata.fromTurnSeq, 2, 'where the first line left out was');
  const thoughts = [
    { reasoningId: 't1', text: 'First', turnSeq: 1 },
    { reasoningId: 't3', text: 'Second', turnSeq: 3 },
    { reasoningId: 't5', text: 'Third', turnSeq: 5 },
  ];
  const entries = turnStreamEntries({ thoughts, activities: capped, text: 'Done.' });
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.turnSeq]), [
    ['thought', 1], ['omitted', null], ['thought', 3], ['tool', 4], ['thought', 5], ['tool', 6], ['reply', null],
  ], 'all thoughts kept; the marker where the left-out line was, before the thought that followed it');
  // A marker without a place (an older relay) still goes before the next kept line.
  const { fromTurnSeq: _from, ...withoutFrom } = capped[0].metadata;
  const older = turnStreamEntries({ thoughts, activities: [{ ...capped[0], metadata: withoutFrom }, ...capped.slice(1)], text: '' });
  assert.deepEqual(older.map((entry) => entry.kind), ['thought', 'thought', 'omitted', 'tool', 'thought', 'tool']);
  // Without a cut there is no marker; a sub-agent's cut makes none either.
  assert.deepEqual(capRelayActivityEntries(rows, 5, { omittedMarker: true }).map((row) => row.text), rows.map((row) => row.text));
  const subRows = rows.map((row) => ({ ...row, subagentRunId: 'toolu_fixture_sub' }));
  assert.equal(capRelayActivityEntries(subRows, 2, { omittedMarker: true }).length, 2);
  assert.equal(FINISHED_ACTIVITY_LIMIT_PER_THREAD, 200);
});

test('the markup: closed thought folds, tool rows, the reply last; escaped', () => {
  const entries = turnStreamEntries({ thoughts: THOUGHTS, activities: ACTIVITIES, text: 'Reply <b>here</b>' });
  const html = renderTurnStreamMarkup(entries, { decorate: (text) => `🔧 ${text}` });
  assert.match(html, /^<div class="msg-turn-stream">/);
  assert.equal((html.match(/<details class="msg-stream-thought"/g) || []).length, 3);
  assert.doesNotMatch(html, /<details[^>]* open>/, 'closed on a finished turn');
  assert.match(html, /<div class="msg-activity-item msg-stream-tool" data-turn-seq="2">🔧 Tool \(Read\): src\/cache.js<\/div>/);
  assert.ok(html.indexOf('data-turn-seq="1"') < html.indexOf('data-turn-seq="2"'));
  assert.match(html, /<div class="msg-stream-reply"><p>Reply &lt;b&gt;here&lt;\/b&gt;<\/p><\/div><\/div>$/);
  assert.match(renderTurnStreamMarkup(entries, { thoughtsOpen: true }), /<details class="msg-stream-thought"[^>]* open>/);
});

test('turnSeq survives every merge on the way to the bubble (H1)', () => {
  // Activities: normalize, the poll merge (union by number), the live cap.
  assert.equal(normalizeRelayActivityEntry({ text: 'Tool (view): a.js', turnSeq: 7 }).turnSeq, 7);
  assert.equal('turnSeq' in normalizeRelayActivityEntry({ text: 'Tool (view): a.js' }), false);
  const live = [{ text: 'Tool (view): a.js', turnSeq: 2 }, { text: 'Tool (view): a.js', turnSeq: 4 }];
  const polled = [{ text: 'Tool (view): a.js', turnSeq: 2 }, { text: 'Tool (grep): b', turnSeq: 3 }, { text: 'Tool (view): a.js', turnSeq: 4 }];
  const merged = mergeRelayActivityTexts(live, polled, 50);
  assert.deepEqual(merged.map((row) => [row.text, row.turnSeq]), [['Tool (view): a.js', 2], ['Tool (grep): b', 3], ['Tool (view): a.js', 4]],
    'the same tool line twice stays twice; the union is in order');
  // Out of order on both sides still comes out sorted.
  assert.deepEqual(mergeRelayActivityTexts([{ text: 'c', turnSeq: 6 }], [{ text: 'a', turnSeq: 2 }], 50).map((row) => row.turnSeq), [2, 6]);

  // Thoughts: the newer text wins, the first number stays.
  const persisted = [{ reasoningId: 'r-1', seq: 1, text: 'Reading', done: false, turnSeq: 1 }];
  const cached = new Map([['r-1', { reasoningId: 'r-1', text: 'Reading the eviction code', done: true }]]);
  assert.deepEqual(mergeRelayThoughts(persisted, cached).map((entry) => [entry.text, entry.turnSeq, entry.done]), [['Reading the eviction code', 1, true]]);
  const later = [{ reasoningId: 'r-1', seq: 2, text: 'Reading the eviction code, done', turnSeq: 9 }];
  assert.equal(normalizeRelayThoughtList([...persisted, ...later])[0].turnSeq, 1, 'the first number known wins');
  assert.equal(normalizeRelayThoughtList([{ reasoningId: 'r-2', text: 'no number' }])[0].turnSeq, undefined);

  // End to end: these merged lists give the stream.
  const entries = turnStreamEntries({ thoughts: mergeRelayThoughts(persisted, cached), activities: merged, text: 'Done.' });
  assert.deepEqual(entries.map((entry) => entry.turnSeq), [1, 2, 3, 4, null]);
});
