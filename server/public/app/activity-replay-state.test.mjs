import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  capRelayActivityEntries,
  compactBoundaryFromActivities,
  promotedCompactBoundaryEntry,
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
