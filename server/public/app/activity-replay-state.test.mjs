import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  capRelayActivityEntries,
  compactBoundaryFromActivities,
  compactionEntryState,
  promotedCompactBoundaryEntry,
  visibleActivityEntries,
} from './activity-replay-state.mjs';

// The activity list of a turn is capped from the FRONT (the start of a turn is
// what a reader wants), which used to drop the compaction boundary of exactly
// the turns that compact hardest: a long agentic turn records its boundary
// well past the cap, and the client filters compact entries out of the bubble,
// so the break row vanished with no prose fallback.

function prose(count, prefix = 'tool') {
  return Array.from({ length: count }, (_, index) => ({
    text: `${prefix} ${index + 1}`,
    subagentRunId: null,
  }));
}

function boundary(preTokens, postTokens, text = 'Context compacted') {
  return { text, subagentRunId: null, metadata: { kind: 'compact_boundary', preTokens, postTokens } };
}

test('capRelayActivityEntries keeps a boundary recorded past the cap', () => {
  const rows = [...prose(54), boundary(120000, 30000), ...prose(20, 'after')];
  const capped = capRelayActivityEntries(rows, 48);

  assert.equal(capped.length, 48);
  assert.ok(capped.includes(rows[54]), 'the boundary row survives the cap');
  assert.deepEqual(
    capped.slice(0, 3).map((row) => row.text),
    ['tool 1', 'tool 2', 'tool 3'],
    'the leading prose rows still fill the rest of the budget',
  );
  assert.equal(capped[capped.length - 1], rows[54], 'original order is preserved');
  assert.deepEqual(compactBoundaryFromActivities(capped), { preTokens: 120000, postTokens: 30000 });
});

test('capRelayActivityEntries is a plain head cap when nothing is structured', () => {
  const rows = prose(60);
  assert.deepEqual(capRelayActivityEntries(rows, 48), rows.slice(0, 48));
  assert.deepEqual(capRelayActivityEntries(rows, 100), rows, 'a short list is returned intact');
  assert.deepEqual(capRelayActivityEntries(null, 48), []);
});

test('capRelayActivityEntries keeps every boundary of a twice-compacted turn', () => {
  const first = boundary(100000, 20000, 'compaction one');
  const second = boundary(110000, 25000, 'compaction two');
  const rows = [...prose(30), first, ...prose(30, 'more'), second];
  const capped = capRelayActivityEntries(rows, 48);

  assert.equal(capped.length, 48);
  assert.ok(capped.includes(first) && capped.includes(second));
  assert.equal(promotedCompactBoundaryEntry(capped), second, 'the last boundary is the promoted one');
});

test('capRelayActivityEntries never exceeds the cap, even with more boundaries than budget', () => {
  const rows = Array.from({ length: 10 }, (_, index) => boundary(index, index));
  const capped = capRelayActivityEntries(rows, 4);
  assert.equal(capped.length, 4);
  assert.deepEqual(capped, rows.slice(-4), 'the most recent boundaries win');
});

test('promotedCompactBoundaryEntry returns the entry itself so the bubble can keep the others', () => {
  const first = boundary(1, 2, 'one');
  const second = boundary(3, 4, 'two');
  assert.equal(promotedCompactBoundaryEntry([first, { text: 'ls' }, second]), second);
  assert.equal(promotedCompactBoundaryEntry([{ text: 'ls' }]), null);
  assert.equal(promotedCompactBoundaryEntry([]), null);
});

function pending() {
  return { text: 'Compacting context…', subagentRunId: null, metadata: { kind: 'compact_boundary', state: 'pending' } };
}

function cancelled() {
  return { text: 'Compaction ended without a result', subagentRunId: null, metadata: { kind: 'compact_boundary', state: 'cancelled' } };
}

test('compactionEntryState names the three steps of a compaction', () => {
  assert.equal(compactionEntryState(pending()), 'pending');
  assert.equal(compactionEntryState(cancelled()), 'cancelled');
  assert.equal(compactionEntryState(boundary(1, 2)), 'boundary');
  assert.equal(compactionEntryState({ text: 'ls' }), null);
  assert.equal(compactionEntryState({ text: 'note', metadata: { kind: 'compact_window_respawn', from: null, to: 100000 } }), null);
});

test('a running compaction is promoted only while its message is processing', () => {
  const start = pending();
  const rows = [{ text: 'ls' }, start];
  assert.equal(promotedCompactBoundaryEntry(rows, { processing: true }), start);
  assert.deepEqual(compactBoundaryFromActivities(rows, { processing: true }), { pending: true, preTokens: null, postTokens: null });
  assert.equal(promotedCompactBoundaryEntry(rows), null, 'a finished message never shows a dangling start');
  assert.equal(compactBoundaryFromActivities(rows), null);
});

test('the last compaction entry wins: boundary after start, nothing after cancel', () => {
  const end = boundary(120000, null);
  assert.equal(promotedCompactBoundaryEntry([pending(), end], { processing: true }), end);
  assert.equal(promotedCompactBoundaryEntry([pending(), cancelled()], { processing: true }), null);
  // A second compaction that ended without a result leaves the first one's line.
  const first = boundary(100000, 20000);
  assert.equal(promotedCompactBoundaryEntry([first, pending(), cancelled()]), first);
  // A second one still running replaces the first one's line while it runs.
  const second = pending();
  assert.equal(promotedCompactBoundaryEntry([first, second], { processing: true }), second);
  assert.equal(promotedCompactBoundaryEntry([first, second]), first);
});

test('start and cancel steps are never prose; earlier boundaries and the respawn note are', () => {
  const first = boundary(100000, 20000, 'compaction one');
  const second = boundary(110000, 25000, 'compaction two');
  const note = { text: 'Restarted the session to apply the compaction window (Auto → 100k)', subagentRunId: null, metadata: { kind: 'compact_window_respawn', from: null, to: 100000 } };
  const rows = [pending(), first, note, pending(), cancelled(), pending(), second];
  const promoted = promotedCompactBoundaryEntry(rows);
  assert.equal(promoted, second);
  assert.deepEqual(visibleActivityEntries(rows, promoted), [first, note]);
});

// The relay's own reads must go through the helper: a bare `.slice(0, 48)`
// there is the original bug.
test('server-runtime caps relay activity rows through capRelayActivityEntries', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../../server-runtime.mjs', import.meta.url)), 'utf8');
  for (const fn of ['relayActivityForResponse', 'relayActivityForQueueMessage']) {
    const body = new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}`).exec(source)?.[0];
    assert.ok(body, `${fn} must exist`);
    assert.match(body, /capRelayActivityEntries\(/, `${fn} must cap through the shared helper`);
    assert.doesNotMatch(body, /\.slice\(0,\s*\d+\)/, `${fn} must not head-slice the rows`);
  }
});

test('the live cap drops old ordinary lines but never a compaction entry or the restart note', async () => {
  const { capLiveActivityEntries, LIVE_ACTIVITY_CAP } = await import('./activity-replay-state.mjs');
  const line = (n) => ({ text: `Tool ${n}`, subagentRunId: null, metadata: null });
  const pending = { text: 'Compacting context…', metadata: { kind: 'compact_boundary', state: 'pending' } };
  const boundary = { text: 'Context compacted', metadata: { kind: 'compact_boundary', preTokens: 9, postTokens: 3 } };
  const restart = { text: 'Restarted the session', metadata: { kind: 'compact_window_respawn', from: null, to: 100000 } };

  const short = [line(1), pending, line(2)];
  assert.equal(capLiveActivityEntries(short), short, 'a list under the cap is returned as it is');

  const busy = [restart, pending, boundary, ...Array.from({ length: 40 }, (_, i) => line(i))];
  const capped = capLiveActivityEntries(busy);
  assert.deepEqual(capped.slice(0, 3), [restart, pending, boundary]);
  assert.equal(capped.length, 3 + LIVE_ACTIVITY_CAP);
  assert.equal(capped[3].text, 'Tool 16', 'the oldest ordinary lines went');
  assert.equal(capped.at(-1).text, 'Tool 39');
});
