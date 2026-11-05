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

// The activity list of a turn is capped per thread (the main agent, each
// sub-agent), keeping the newest rows. A cap used to drop the compaction
// boundary of exactly the turns that compact hardest: a long agentic turn
// records its boundary well away from the kept rows, and the client filters
// compact entries out of the bubble, so the break row vanished with no prose
// fallback. Structured rows are always kept.

function prose(count, prefix = 'tool', subagentRunId = null) {
  return Array.from({ length: count }, (_, index) => ({
    text: `${prefix} ${index + 1}`,
    subagentRunId,
  }));
}

function boundary(preTokens, postTokens, text = 'Context compacted') {
  return { text, subagentRunId: null, metadata: { kind: 'compact_boundary', preTokens, postTokens } };
}

test('capRelayActivityEntries keeps a boundary recorded before the kept rows', () => {
  const rows = [...prose(54), boundary(120000, 30000), ...prose(20, 'after')];
  const capped = capRelayActivityEntries(rows, 48);

  assert.equal(capped.length, 49, 'the newest 48 prose rows and the boundary');
  assert.ok(capped.includes(rows[54]), 'the boundary row survives the cap');
  assert.deepEqual(
    capped.slice(0, 3).map((row) => row.text),
    ['tool 27', 'tool 28', 'tool 29'],
    'the oldest prose rows went',
  );
  assert.equal(capped.at(-1).text, 'after 20');
  assert.equal(capped[28], rows[54], 'original order is preserved');
  assert.deepEqual(compactBoundaryFromActivities(capped), { preTokens: 120000, postTokens: 30000 });
});

test('capRelayActivityEntries keeps the newest rows when nothing is structured', () => {
  const rows = prose(60);
  assert.deepEqual(capRelayActivityEntries(rows, 48), rows.slice(-48));
  const short = capRelayActivityEntries(rows, 100);
  assert.deepEqual(short, rows, 'a short list is returned intact');
  assert.notEqual(short, rows, 'as a copy');
  assert.deepEqual(capRelayActivityEntries(null, 48), []);
});

test('capRelayActivityEntries keeps every boundary of a twice-compacted turn', () => {
  const first = boundary(100000, 20000, 'compaction one');
  const second = boundary(110000, 25000, 'compaction two');
  const rows = [...prose(30), first, ...prose(30, 'more'), second];
  const capped = capRelayActivityEntries(rows, 48);

  assert.equal(capped.length, 50);
  assert.ok(capped.includes(first) && capped.includes(second));
  assert.equal(promotedCompactBoundaryEntry(capped), second, 'the last boundary is the promoted one');
});

test('capRelayActivityEntries counts each thread apart', () => {
  const main = prose(6, 'main');
  const subs = ['toolu_fixture_a', 'toolu_fixture_b', 'toolu_fixture_c'].map((id) => prose(300, id, id));
  // Interleaved the way a busy turn records them.
  const rows = [main[0], ...subs[0].slice(0, 100), main[1], main[2], ...subs[1], main[3], ...subs[0].slice(100), ...subs[2], main[4], main[5]];
  const capped = capRelayActivityEntries(rows, 200);

  assert.deepEqual(capped.filter((row) => !row.subagentRunId), main, 'every main line stays');
  for (const sub of subs) {
    const kept = capped.filter((row) => row.subagentRunId === sub[0].subagentRunId);
    assert.deepEqual(kept, sub.slice(-200), 'each sub-agent keeps its newest 200');
  }
  assert.deepEqual(capped, rows.filter((row) => capped.includes(row)), 'order preserved');
});

test('capRelayActivityEntries with more boundaries than the cap keeps the newest boundaries, as many as the cap', () => {
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
test('server-runtime caps relay activity rows through the shared helpers, newest per thread', async () => {
  const { FINISHED_ACTIVITY_LIMIT_PER_THREAD, FINISHED_SUBAGENT_ACTIVITY_LIMIT_PER_THREAD, IN_FLIGHT_ACTIVITY_LIMIT_PER_THREAD } = await import('./activity-replay-state.mjs');
  assert.equal(FINISHED_ACTIVITY_LIMIT_PER_THREAD, 200);
  assert.equal(FINISHED_SUBAGENT_ACTIVITY_LIMIT_PER_THREAD, 50);
  assert.equal(IN_FLIGHT_ACTIVITY_LIMIT_PER_THREAD, 500);
  const source = fs.readFileSync(fileURLToPath(new URL('../../server-runtime.mjs', import.meta.url)), 'utf8');
  for (const [fn, call] of [['relayActivityForResponse', /capFinishedActivityEntries\(/], ['relayActivityForQueueMessage', /capRelayActivityEntries\([\s\S]*inFlightActivityCap\(activityCap\)/]]) {
    const body = new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}`).exec(source)?.[0];
    assert.ok(body, `${fn} must exist`);
    assert.match(body, call, `${fn} must cap through the shared helper`);
    assert.doesNotMatch(body, /\.slice\(0,\s*\d+\)/, `${fn} must not head-slice the rows`);
  }
  // The in-flight snapshot takes the page's cap; the conversation route
  // passes its query param, nobody else does.
  assert.match(source, /function relayActivityForQueueMessage\(queueMessageId, activityCap = undefined\)/);
  assert.match(source, /function inFlightStateForConversation\(conversationId, \{ activityCap = undefined \} = \{\}\)[\s\S]*?activities: relayActivityForQueueMessage\(row\.id, activityCap\)/);
  const routes = fs.readFileSync(fileURLToPath(new URL('../../routes/sessions-routes.mjs', import.meta.url)), 'utf8');
  assert.match(routes, /inFlightStateForConversation\(resolvedConversationId, \{ activityCap: req\.query\.activityCap \}\)/);
});

test('the in-flight cap a request asks for: 1…500, 0 = 500, anything else 50', async () => {
  const { inFlightActivityCap, LIVE_ACTIVITY_CAP } = await import('./activity-replay-state.mjs');
  assert.equal(LIVE_ACTIVITY_CAP, 50);
  for (const [value, cap] of [[undefined, 50], [null, 50], ['', 50], ['junk', 50], ['-5', 50], ['12.5', 50], ['10', 10], ['200', 200], ['500', 500], ['900', 500], ['0', 500], [120, 120]]) {
    assert.equal(inFlightActivityCap(value), cap, String(value));
  }
});

test('without a cap the in-flight snapshot holds at most 50 ordinary rows per thread', async () => {
  const { inFlightActivityCap } = await import('./activity-replay-state.mjs');
  const rows = [...prose(120, 'main'), ...prose(300, 'sub', 'toolu_fixture_busy'), boundary(10, 5)];
  const capped = capRelayActivityEntries(rows, inFlightActivityCap(undefined));
  assert.equal(capped.filter((row) => !row.subagentRunId && !row.metadata).length, 50);
  assert.equal(capped.filter((row) => row.subagentRunId).length, 50);
  assert.ok(capped.includes(rows.at(-1)), 'the boundary is kept');
});

test('a finished turn keeps the main agent\'s newest 200 and each sub-agent\'s newest 50', async () => {
  const { capFinishedActivityEntries } = await import('./activity-replay-state.mjs');
  const main = prose(250, 'main');
  const sub = prose(120, 'sub', 'toolu_fixture_agent');
  const capped = capFinishedActivityEntries([...main.slice(0, 100), ...sub, ...main.slice(100)]);
  assert.deepEqual(capped.filter((row) => !row.subagentRunId && !row.metadata), main.slice(-200));
  assert.deepEqual(capped.filter((row) => row.subagentRunId), sub.slice(-50));
  // The main agent's cut is marked, right before its first kept line.
  const marker = capped.findIndex((row) => row.metadata?.kind === 'activity_omitted');
  assert.equal(capped[marker].text, '… 50 earlier tool lines omitted');
  assert.equal(capped[marker + 1], main[50]);
});

test('the live cap drops old ordinary lines per thread but never a compaction entry or the restart note', async () => {
  const { capLiveActivityEntries, LIVE_ACTIVITY_CAP } = await import('./activity-replay-state.mjs');
  assert.equal(LIVE_ACTIVITY_CAP, 50, 'the setting\'s default');
  const line = (n) => ({ text: `Tool ${n}`, subagentRunId: null, metadata: null });
  const pending = { text: 'Compacting context…', metadata: { kind: 'compact_boundary', state: 'pending' } };
  const boundary = { text: 'Context compacted', metadata: { kind: 'compact_boundary', preTokens: 9, postTokens: 3 } };
  const restart = { text: 'Restarted the session', metadata: { kind: 'compact_window_respawn', from: null, to: 100000 } };

  const short = [line(1), pending, line(2)];
  assert.equal(capLiveActivityEntries(short), short, 'a list under the cap is returned as it is');

  const busy = [restart, pending, boundary, ...Array.from({ length: 80 }, (_, i) => line(i))];
  const capped = capLiveActivityEntries(busy);
  assert.deepEqual(capped.slice(0, 3), [restart, pending, boundary]);
  assert.equal(capped.length, 3 + LIVE_ACTIVITY_CAP);
  assert.equal(capped[3].text, 'Tool 30', 'the oldest ordinary lines went');
  assert.equal(capped.at(-1).text, 'Tool 79');

  const ten = capLiveActivityEntries(busy, 10);
  assert.equal(ten.length, 13);
  assert.equal(ten[3].text, 'Tool 70');
});

test('the live cap keeps the main agent\'s lines through 100 sub-agent lines', async () => {
  const { capLiveActivityEntries } = await import('./activity-replay-state.mjs');
  const main = prose(6, 'Main tool');
  const sub = prose(100, 'Sub tool', 'toolu_fixture_explore');
  const rows = [main[0], main[1], ...sub.slice(0, 50), main[2], main[3], ...sub.slice(50), main[4], main[5]];

  const capped = capLiveActivityEntries(rows, 50);
  assert.deepEqual(capped.filter((row) => !row.subagentRunId), main, 'all six main lines stay');
  assert.deepEqual(capped.filter((row) => row.subagentRunId), sub.slice(-50), 'the sub-agent keeps its newest 50');

  // Under the old turn-wide cap of 24 the main lines were gone.
  assert.equal(capLiveActivityEntries(rows, 24).filter((row) => !row.subagentRunId).length, 6);
});

test('a live cap of 0 (no limit) keeps every line', async () => {
  const { capLiveActivityEntries } = await import('./activity-replay-state.mjs');
  const rows = [...prose(600), ...prose(700, 'Sub', 'toolu_fixture_long')];
  assert.equal(capLiveActivityEntries(rows, 0), rows);
  assert.equal(capLiveActivityEntries(rows, Number.POSITIVE_INFINITY), rows);
});

test('a poll merge follows the same per-thread rule', async () => {
  const { mergeRelayActivityTexts } = await import('./activity-replay-state.mjs');
  const main = prose(4, 'Main');
  const sub = prose(80, 'Sub', 'toolu_fixture_grep');
  const existing = [main[0], ...sub.slice(0, 40)];
  const incoming = [main[0], ...sub.slice(0, 40), main[1], ...sub.slice(40), main[2], main[3]];

  const merged = mergeRelayActivityTexts(existing, incoming, 30);
  assert.deepEqual(merged.filter((row) => !row.subagentRunId).map((row) => row.text), main.map((row) => row.text));
  assert.deepEqual(merged.filter((row) => row.subagentRunId).map((row) => row.text), sub.slice(-30).map((row) => row.text));
  assert.equal(mergeRelayActivityTexts(existing, incoming, 0).length, 84, 'no limit keeps all');
});
