import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import {
  DEFAULT_TASK_STALL_MINUTES,
  TASK_CONSOLE_MAX_LOADED_BYTES,
  TASK_STALL_MINUTES_MAX,
  TASK_STALL_MINUTES_MIN,
  buildLineNode,
  chunkAction,
  chunkEndOffset,
  consoleMetaParts,
  endedOutcome,
  findFirstFailureIndex,
  lineText,
  loadEarlierState,
  normalizeStallThreshold,
  runnerChip,
  stallHint,
  stepsLabel,
  taskHasConsole,
  taskOutputUnavailable,
} from './task-console-render.mjs';
import { createLineFolder } from './task-output-text.mjs';
import * as shared from '../../../shared/task-output-text.mjs';

const { document } = new JSDOM('<!doctype html><body></body>').window;

test('the stall threshold and its bounds match the relay setting', () => {
  assert.equal(DEFAULT_TASK_STALL_MINUTES, shared.DEFAULT_TASK_STALL_MINUTES);
  assert.equal(TASK_STALL_MINUTES_MIN, shared.TASK_STALL_MINUTES_MIN);
  assert.equal(TASK_STALL_MINUTES_MAX, shared.TASK_STALL_MINUTES_MAX);
  for (const value of [undefined, null, '', 'x', 0, 1, 7.4, 120, 500]) {
    assert.equal(normalizeStallThreshold(value), shared.normalizeTaskStallMinutes(value), String(value));
  }
  assert.equal(TASK_CONSOLE_MAX_LOADED_BYTES, shared.TASK_OUTPUT_LIMITS.modalBytesMax);
});

test('the stall hint appears after a quiet minute and turns amber at the threshold', () => {
  const now = Date.parse('2026-05-06T07:08:09Z');
  assert.equal(stallHint(now - 30_000, 10, now), null, 'fresh output says nothing');
  assert.equal(stallHint(null, 10, now), null, 'no health, no hint');
  assert.deepEqual(stallHint(now - 4 * 60_000, 10, now), { minutes: 4, text: 'no output for 4 min', warn: false });
  assert.deepEqual(stallHint(now - 12 * 60_000, 10, now), { minutes: 12, text: 'no output for 12 min', warn: true });
  assert.equal(stallHint(now - 2 * 60_000, 1, now).warn, true, 'a 1-minute threshold');
  assert.equal(stallHint(new Date(now - 11 * 60_000).toISOString(), undefined, now).warn, true, 'ISO time, default threshold');
});

test('the chip reads "✓ passed ✘ failed" and turns red on a failure', () => {
  assert.equal(runnerChip(null), null);
  assert.equal(runnerChip({ counts: null }), null);
  assert.equal(runnerChip({ counts: { passed: 0, failed: 0, skipped: 0 } }), null);
  assert.deepEqual(runnerChip({ runner: 'vitest', counts: { passed: 412, failed: 2, skipped: 3 } }), {
    text: '✓ 412 ✘ 2',
    failed: true,
    title: 'vitest: 412 passed, 2 failed, 3 skipped',
  });
  assert.deepEqual(runnerChip({ counts: { passed: 38, failed: 0 } }), { text: '✓ 38', failed: false, title: '38 passed, 0 failed' });
});

test('the chip takes the counts of every runner the relay parses', () => {
  const dir = new URL('../../../shared/fixtures/task-output/', import.meta.url);
  for (const name of ['vitest.txt', 'jest.txt', 'pytest.txt', 'playwright-list.txt', 'node-test-spec.txt']) {
    const parsed = shared.parseRunnerSummary(readFileSync(new URL(name, dir), 'utf8').split('\n'));
    const chip = runnerChip({ runner: parsed.runner, counts: parsed });
    assert.ok(chip, name);
    assert.match(chip.text, /^✓ \d+( ✘ \d+)?$/, name);
    assert.equal(chip.failed, parsed.failed > 0, name);
  }
});

test('an ended task reads ✓, ✘ or ■ from its status and exit code', () => {
  assert.deepEqual(endedOutcome({ status: 'completed', exitCode: 0 }), { icon: '✓', ok: true, failed: false, label: 'completed' });
  assert.deepEqual(endedOutcome({ status: 'failed', exitCode: 2 }), { icon: '✘', ok: false, failed: true, label: 'failed, exit code 2' });
  assert.equal(endedOutcome({ status: 'unknown', exitCode: 1 }).icon, '✘', 'a non-zero exit is a failure');
  assert.equal(endedOutcome({ status: 'failed', exitCode: null }).label, 'failed');
  assert.equal(endedOutcome({ status: 'stopped' }).icon, '■');
  assert.deepEqual(endedOutcome({ status: 'unknown' }), { icon: '✓', ok: true, failed: false, label: 'ended' });
});

test('steps read "22 steps", "1 step", or nothing', () => {
  assert.equal(stepsLabel(22), '22 steps');
  assert.equal(stepsLabel(1), '1 step');
  assert.equal(stepsLabel(0), '0 steps');
  assert.equal(stepsLabel(undefined), '');
  assert.equal(stepsLabel(-1), '');
});

test('shell and Monitor rows open the console; a row without output does not', () => {
  assert.equal(taskHasConsole({ taskType: 'local_bash' }), true);
  assert.equal(taskHasConsole({ taskType: 'monitor' }), true);
  assert.equal(taskHasConsole({ taskType: 'local_bash', outputKind: 'none' }), false);
  assert.equal(taskHasConsole({ taskType: 'shell', outputKind: 'spool' }), true, 'any type with an output kind');
  assert.equal(taskHasConsole({ taskType: 'local_agent' }), false);
  assert.equal(taskHasConsole({ taskType: 'local_workflow' }), false);
  assert.equal(taskOutputUnavailable({ outputKind: 'none' }), true);
  assert.equal(taskOutputUnavailable({ outputKind: 'file' }), false);
});

test('a line row carries colour spans and the ×N of a folded repeat, never markup', () => {
  const row = buildLineNode(document, { text: '\x1b[31m✘ broke\x1b[0m <b>not bold</b>', count: 3 });
  assert.equal(row.className, 'tc-line');
  const span = row.querySelector('span.tc-fg-1');
  assert.equal(span?.textContent, '✘ broke');
  assert.equal(row.querySelector('b'), null, 'worker text never becomes markup');
  assert.equal(row.querySelector('.tc-line-count')?.textContent, '×3');
  assert.match(row.textContent, /<b>not bold<\/b>/);

  const styled = buildLineNode(document, { text: '\x1b[1;4;3;2;44mall\x1b[0m', count: 1 });
  assert.equal(styled.querySelector('span').className, 'tc-bg-4 tc-bold tc-dim tc-italic tc-underline');
  assert.equal(styled.querySelector('.tc-line-count'), null, 'a single line has no counter');

  const empty = buildLineNode(document, { text: '', count: 1 });
  assert.ok(empty.textContent.length > 0, 'an empty line keeps its height');
  assert.equal(buildLineNode(document, { text: 'still writing' }, { partial: true }).className, 'tc-line tc-line-partial');
});

test('the folder feeds the rows: a progress redraw collapses, repeats fold', () => {
  const folder = createLineFolder();
  folder.feed('build 10%\rbuild 60%');
  const { lines, partial } = folder.feed('\rbuild 100%\nok\nok\nok\n');
  assert.deepEqual(lines.map((line) => [line.text, line.count]), [['build 100%', 1], ['ok', 3]]);
  assert.equal(partial, '');
  assert.equal(lineText(lines[1]), 'ok');
});

test('the first-failure jump lands on the first failing line of each runner', () => {
  const dir = new URL('../../../shared/fixtures/task-output/', import.meta.url);
  for (const name of ['vitest.txt', 'jest.txt', 'pytest.txt', 'playwright-list.txt', 'node-test-spec.txt', 'node-test-tap.txt']) {
    const folder = createLineFolder();
    const { lines } = folder.feed(readFileSync(new URL(name, dir), 'utf8'));
    const index = findFirstFailureIndex(lines);
    assert.ok(index >= 0, `${name}: a failing line is found`);
    const parsed = shared.parseRunnerSummary(lines);
    if (Number.isInteger(parsed?.firstFailureLine)) {
      assert.ok(index <= parsed.firstFailureLine, `${name}: no later than the relay's first failure`);
    }
  }
  assert.equal(findFirstFailureIndex([{ text: '✓ fine', count: 1 }, { text: '✖ failing tests:', count: 1 }]), -1);
  assert.equal(findFirstFailureIndex([]), -1);
});

test('a chunk applies where the view stands, repeats are ignored, gaps and shrinks refetch', () => {
  const view = { nextOffset: 100, size: 100 };
  assert.equal(chunkAction(view, { offset: 100, endOffset: 140, size: 140, text: 'x' }), 'apply');
  assert.equal(chunkAction(view, { offset: 60, endOffset: 100, size: 140 }), 'ignore', 'already shown');
  assert.equal(chunkAction(view, { offset: 120, endOffset: 140, size: 140 }), 'refetch', 'a gap');
  assert.equal(chunkAction(view, { offset: 60, endOffset: 130, size: 130 }), 'refetch', 'an overlap past the view');
  assert.equal(chunkAction(view, { offset: 100, size: 40 }), 'refetch', 'the file got shorter');
  assert.equal(chunkAction(view, { offset: 40, endOffset: 40, size: 40, text: '', reset: true }), 'refetch', "the relay's reset");
  assert.equal(chunkAction(view, { text: 'no offset' }), 'ignore');
  assert.equal(chunkEndOffset({ offset: 0, endOffset: 12, size: 99 }), 12);
  assert.equal(chunkEndOffset({ offset: 0, size: 99 }), 99, 'without an end offset, the size');
  assert.ok(Number.isNaN(chunkEndOffset({})));
});

test('"Load earlier" hides at the start of the file and stops at the 5 MB cap', () => {
  assert.equal(loadEarlierState({ hasMoreBefore: false, loadedBytes: 0 }).hidden, true);
  assert.deepEqual(loadEarlierState({ hasMoreBefore: true, loadedBytes: 1024 }), { hidden: false, disabled: false, text: 'Load earlier' });
  assert.deepEqual(loadEarlierState({ hasMoreBefore: true, loadedBytes: 1024, loading: true }), { hidden: false, disabled: true, text: 'Loading…' });
  assert.deepEqual(loadEarlierState({ hasMoreBefore: true, loadedBytes: 5 * 1024 * 1024 }), { hidden: false, disabled: true, text: 'older output not loaded' });
});

test('the header meta names the kind, the time and the outcome', () => {
  assert.deepEqual(consoleMetaParts({ task: { taskType: 'local_bash' }, elapsed: '4m 2s', ended: false }), ['Shell', '4m 2s', 'running']);
  assert.deepEqual(consoleMetaParts({ task: { taskType: 'monitor' }, elapsed: '', ended: true, status: 'failed', exitCode: 1 }), ['Monitor', 'failed, exit code 1']);
  assert.deepEqual(consoleMetaParts({ task: { taskType: 'local_bash' }, ended: false, kind: 'snapshot' }), ['Shell', 'running', 'last 8 KB, read again every 3 s']);
});
