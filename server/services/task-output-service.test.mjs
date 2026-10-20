import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBackgroundTaskStore } from './background-task-store.mjs';
import {
  advanceRunnerScan,
  createRunnerScan,
  createTaskHealthPoller,
  createTaskOutputSnapshots,
  healthOfWindow,
  healthWithScan,
  inspectOutputFile,
  readBefore,
  readRange,
  readTail,
  safeChunkLength,
  shapeSnapshot,
  taskOutputSource,
} from './task-output-service.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-output-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeLines(file, count, prefix = 'line') {
  fs.writeFileSync(file, Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n');
}

const fixture = (name) => fs.readFileSync(new URL(`../../shared/fixtures/task-output/${name}`, import.meta.url));

test('readTail returns the last lines with byte offsets and the line model', async (t) => {
  const file = path.join(tempDir(t), 'out.log');
  writeLines(file, 10);
  const tail = await readTail(file, { lines: 3 });
  assert.equal(tail.ok, true);
  assert.equal(tail.text, 'line 8\nline 9\nline 10\n');
  assert.equal(tail.endOffset, fs.statSync(file).size);
  assert.equal(tail.startOffset, tail.endOffset - Buffer.byteLength(tail.text));
  assert.equal(tail.hasMoreBefore, true);
  assert.deepEqual(tail.lines.map((line) => line.text), ['line 8', 'line 9', 'line 10']);
  const all = await readTail(file);
  assert.equal(all.startOffset, 0);
  assert.equal(all.hasMoreBefore, false);
  assert.equal(all.lines.length, 10);
});

test('a byte window that starts mid-file starts on the next line', async (t) => {
  const file = path.join(tempDir(t), 'out.log');
  writeLines(file, 100);
  const tail = await readTail(file, { maxBytes: 30 });
  assert.match(tail.text, /^line \d+\n/);
  assert.ok(tail.text.endsWith('line 100\n'));
  assert.ok(Buffer.byteLength(tail.text) <= 30);
});

test('readBefore pages back from a startOffset to the beginning', async (t) => {
  const file = path.join(tempDir(t), 'out.log');
  writeLines(file, 10);
  const tail = await readTail(file, { lines: 4 });
  const page = await readBefore(file, { before: tail.startOffset, lines: 4 });
  assert.deepEqual(page.lines.map((line) => line.text), ['line 3', 'line 4', 'line 5', 'line 6']);
  assert.equal(page.endOffset, tail.startOffset);
  const first = await readBefore(file, { before: page.startOffset, lines: 4 });
  assert.deepEqual(first.lines.map((line) => line.text), ['line 1', 'line 2']);
  assert.equal(first.hasMoreBefore, false);
});

test('the tail stops short of a character or an escape the writer has not finished', async (t) => {
  const file = path.join(tempDir(t), 'out.log');
  const euro = Buffer.from('€');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('done\nprice 5'), euro.subarray(0, 2)]));
  const tail = await readTail(file);
  assert.equal(tail.text, 'done\nprice 5');
  assert.equal(tail.endOffset, fs.statSync(file).size - 2);
  assert.equal(safeChunkLength(Buffer.from('ok \x1b[3')), 3);
  assert.equal(safeChunkLength(Buffer.from('ok \x1b[31mred')), 11);
  assert.equal(safeChunkLength(Buffer.from('ok \x1b]0;title')), 3);
  assert.equal(safeChunkLength(Buffer.from('ok €')), 6);
});

test('what is read is cleaned: controls out, colours kept, secrets scrubbed, redraws collapsed', async (t) => {
  const file = path.join(tempDir(t), 'out.log');
  const token = ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('');
  fs.writeFileSync(file, `\x1b]0;title\x07\x1b[32mok\x1b[39m\nGITHUB_TOKEN=${token}\n10%\r50%\r100%\nsame\nsame\n`);
  const tail = await readTail(file);
  assert.equal(tail.text.includes('ghp_abcdefghij'), false);
  assert.deepEqual(tail.lines, [
    { text: '\x1b[32mok\x1b[39m', count: 1, ansi: true },
    { text: 'GITHUB_TOKEN=[redacted]', count: 1, ansi: false },
    { text: '100%', count: 1, ansi: false },
    { text: 'same', count: 2, ansi: false },
  ]);
});

test('the guard refuses relative paths, symlinks, folders and missing files', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'out.log');
  fs.writeFileSync(file, 'x\n');
  assert.deepEqual(await inspectOutputFile('out.log'), { ok: false, code: 'invalid-path' });
  assert.equal((await inspectOutputFile(path.join(dir, 'gone.log'))).code, 'missing');
  assert.equal((await inspectOutputFile(dir)).code, 'not-file');
  if (process.platform !== 'win32') { // host-platform: creating a symlink needs POSIX rights
    const link = path.join(dir, 'link.log');
    fs.symlinkSync(file, link);
    assert.equal((await inspectOutputFile(link)).code, 'symlink');
    assert.equal((await readTail(link)).ok, false);
    assert.equal((await readRange(link, { start: 0 })).ok, false, 'a live read does not follow it either');
  }
  assert.equal((await inspectOutputFile(file)).ok, true);
});

test('readRange reads from an offset, at most maxBytes, on a safe boundary', async (t) => {
  const file = path.join(tempDir(t), 'out.log');
  fs.writeFileSync(file, 'abc\ndef\nghi\n');
  const chunk = await readRange(file, { start: 4, maxBytes: 5 });
  assert.deepEqual({ offset: chunk.offset, endOffset: chunk.endOffset, text: chunk.text }, { offset: 4, endOffset: 9, text: 'def\ng' });
  const none = await readRange(file, { start: 12 });
  assert.equal(none.endOffset, 12);
  assert.equal(none.text, '');
});

test('taskOutputSource: file and spool rows have a path; snapshot and none do not', () => {
  assert.deepEqual(taskOutputSource({ outputPath: '/tmp/a.log' }), { kind: 'file', path: '/tmp/a.log' });
  assert.deepEqual(taskOutputSource({ outputPath: '/tmp/a.log', outputKind: 'spool' }), { kind: 'spool', path: '/tmp/a.log' });
  assert.deepEqual(taskOutputSource({ outputKind: 'snapshot' }), { kind: 'snapshot', path: '' });
  assert.deepEqual(taskOutputSource({ outputPath: 'relative.log' }), { kind: 'none', path: '' });
  assert.deepEqual(taskOutputSource({}), { kind: 'none', path: '' });
});

test('snapshots are kept per key and task for an hour and answer like a tail', () => {
  let clock = 1000;
  const snapshots = createTaskOutputSnapshots({ now: () => clock });
  snapshots.set('sess-1', 't1', { output: 'a\n\x1b[2Kb\n', totalBytes: 9000, truncated: true });
  const entry = snapshots.get(['conv-1', 'sess-1'], 't1');
  const shaped = shapeSnapshot(entry);
  assert.equal(shaped.text, 'a\nb\n');
  assert.equal(shaped.endOffset, 9000);
  assert.equal(shaped.truncated, true);
  assert.deepEqual(shaped.lines.map((line) => line.text), ['a', 'b']);
  clock += 61 * 60 * 1000;
  assert.equal(snapshots.get(['sess-1'], 't1'), null);
});

test('health of a window: counts and the byte offset of the first failure', () => {
  const buffer = fixture('vitest.txt');
  const health = healthOfWindow(buffer, 0);
  assert.equal(health.runner, 'vitest');
  assert.deepEqual(health.counts, { passed: 412, failed: 2, skipped: 0 });
  assert.equal(health.final, true);
  assert.match(buffer.subarray(health.firstFailureOffset, health.firstFailureOffset + 40).toString('utf8'), /^ FAIL {2}src\/bearing\.test\.ts/);
  // Offsets stay file offsets when the window starts later.
  const later = healthOfWindow(buffer.subarray(10), 10);
  assert.equal(later.firstFailureOffset, health.firstFailureOffset);
  assert.deepEqual(healthOfWindow(Buffer.from('plain log\n'), 0), { counts: null, runner: null, final: false, firstFailureOffset: null });
});

test('the health poller reads live tasks with a file and emits only on change', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'out.log');
  fs.writeFileSync(file, fixture('playwright-list.txt').subarray(0, fixture('playwright-list.txt').indexOf('  1) ')));
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [
    { taskId: 't1', taskType: 'local_bash', outputPath: file },
    { taskId: 't2', taskType: 'local_bash' },
    { taskId: 't3', taskType: 'local_bash', outputPath: path.join(dir, 'missing.log') },
  ]);
  const emitted = [];
  const poller = createTaskHealthPoller({ store, io: { emit: (event, payload) => emitted.push({ event, payload }) }, logger: null });
  await poller.tick();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'background_tasks_health');
  assert.equal(emitted[0].payload.conversationId, 'sess-1');
  // t2 has no file; t3's is not there yet: no output since its start.
  assert.deepEqual(Object.keys(emitted[0].payload.health), ['t1', 't3']);
  assert.equal(emitted[0].payload.health.t3.size, 0);
  const first = emitted[0].payload.health.t1;
  assert.deepEqual([first.runner, first.counts.passed, first.counts.failed, first.final], ['playwright', 1, 1, false]);
  assert.equal(first.size, fs.statSync(file).size);
  assert.deepEqual(store.health('sess-1', 't1'), first);

  await poller.tick();
  assert.equal(emitted.length, 1, 'nothing changed, nothing sent');

  fs.writeFileSync(file, fixture('playwright-list.txt'));
  await poller.tick();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].payload.health.t1.final, true);
  assert.equal(store.withHealth(store.get('sess-1'), 'sess-1')[0].health.final, true);
});

test('the poller starts and stops its timer', () => {
  const calls = [];
  const poller = createTaskHealthPoller({
    store: createBackgroundTaskStore(),
    io: null,
    setIntervalImpl: (fn, ms) => { calls.push(['set', ms]); return { unref() {} }; },
    clearIntervalImpl: () => calls.push(['clear']),
  });
  poller.start();
  poller.start();
  poller.stop();
  assert.deepEqual(calls, [['set', 10_000], ['clear']]);
});

test('a task whose file is not there yet has no output since its start', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'spool.log');
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: file, outputKind: 'spool', startedAt: 1_700_000_000_000 }]);
  const emitted = [];
  const poller = createTaskHealthPoller({ store, io: { emit: (event, payload) => emitted.push(payload) }, logger: null });
  await poller.tick();
  assert.deepEqual(emitted[0].health.t1, { lastOutputAt: 1_700_000_000_000, size: 0, counts: null, runner: null, final: false, firstFailureOffset: null });
  await poller.tick();
  assert.equal(emitted.length, 1);
  fs.writeFileSync(file, 'first output\n');
  await poller.tick();
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].health.t1.size, 13);
});

test('a task that ends between two ticks has its file read after the end', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'node-test.log');
  const passes = Array.from({ length: 13 }, (_, index) => `✔ case ${index + 1} (1.0ms)\n`);
  fs.writeFileSync(file, passes.slice(0, 10).join(''));
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: file }]);
  const emitted = [];
  const poller = createTaskHealthPoller({ store, io: { emit: (event, payload) => emitted.push(payload) }, logger: null });
  // Mid-run: ten passes, no summary yet.
  await poller.tick();
  assert.deepEqual([emitted[0].health.t1.counts.passed, emitted[0].health.t1.counts.failed, emitted[0].health.t1.final], [10, 0, false]);

  // More output and node:test's summary, then the task leaves the set.
  fs.appendFileSync(file, [
    ...passes.slice(10),
    '✖ case 14 (2.0ms)\n',
    'ℹ tests 14\n', 'ℹ suites 0\n', 'ℹ pass 13\n', 'ℹ fail 1\n',
    'ℹ cancelled 0\n', 'ℹ skipped 0\n', 'ℹ todo 0\n', 'ℹ duration_ms 12.5\n',
  ].join(''));
  store.settle('sess-1', 't1', { status: 'failed', exitCode: 1 });
  store.replace('sess-1', []);
  assert.equal(store.ended('sess-1')[0].health.counts.passed, 10, 'the ended row starts with the live reading');

  await poller.tick();
  assert.equal(emitted.length, 2);
  const last = emitted[1].health.t1;
  assert.deepEqual([last.counts.passed, last.counts.failed, last.final], [13, 1, true]);
  assert.equal(last.size, fs.statSync(file).size);
  // On the ended row, as the conversation payload and read_session serve it.
  const [row] = store.ended('sess-1');
  assert.deepEqual([row.health.counts.passed, row.health.counts.failed, row.health.final], [13, 1, true]);
  assert.equal(row.status, 'failed');
  assert.equal(store.findTask(['sess-1'], 't1').task.health.final, true);

  await poller.tick();
  assert.equal(emitted.length, 2, 'an unchanged ended file is not sent again');
});

test('an ended task whose file appeared after the last live reading gets its size', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'sleep.log');
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: file, startedAt: 1_700_000_000_000 }]);
  const emitted = [];
  const poller = createTaskHealthPoller({ store, io: { emit: (event, payload) => emitted.push(payload) }, logger: null });
  await poller.tick();
  assert.equal(emitted[0].health.t1.size, 0);
  fs.writeFileSync(file, 'slept forty seconds\ndone\n');
  store.replace('sess-1', []);
  await poller.tick();
  assert.equal(emitted[1].health.t1.size, 25);
  assert.equal(store.ended('sess-1')[0].health.size, 25);
});

test('poke runs a tick soon, once per burst', async () => {
  const timers = [];
  const store = createBackgroundTaskStore();
  const poller = createTaskHealthPoller({ store, io: null, logger: null, setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return {}; } });
  poller.poke();
  poller.poke();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 250);
  timers[0].fn();
  poller.poke();
  assert.equal(timers.length, 2);
});

// ─── Runs past the 64 KB window ──────────────────────────────────────────────

// A vitest run still going: its header, then `files` file lines of 5 tests
// (every 50th with one failure), padded so the log passes 64 KB early.
function vitestLiveLog(files) {
  const lines = [' RUN  v2.1.8 /work/lantern-app', ''];
  for (let index = 1; index <= files; index += 1) {
    const name = `src/lantern/module-${String(index).padStart(4, '0')}-with-a-longer-name.test.ts`;
    lines.push(index % 50 === 0 ? ` ❯ ${name} (5 tests | 1 failed) 12ms` : ` ✓ ${name} (5 tests) 3ms`);
  }
  return `${lines.join('\n')}\n`;
}

test('a live vitest run past 64 KB keeps its runner and counts every file', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'vitest-live.log');
  const text = vitestLiveLog(1500);
  fs.writeFileSync(file, text);
  assert.ok(Buffer.byteLength(text) > 64 * 1024 + 20_000, 'the header is well out of the window');
  // The window alone: the header is gone, so no runner and no chip.
  const buffer = fs.readFileSync(file);
  assert.equal(healthOfWindow(buffer.subarray(buffer.length - 64 * 1024), buffer.length - 64 * 1024).counts, null);

  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: file }]);
  const emitted = [];
  const poller = createTaskHealthPoller({ store, io: { emit: (event, payload) => emitted.push(payload) }, logger: null });
  await poller.tick();
  const reading = emitted[0].health.t1;
  assert.deepEqual([reading.runner, reading.counts, reading.final], ['vitest', { passed: 1500 * 5 - 30, failed: 30, skipped: 0 }, false]);
  // The first failure is a file offset, far before the window.
  assert.match(buffer.subarray(reading.firstFailureOffset, reading.firstFailureOffset + 40).toString('utf8'), /^ ❯ src\/lantern\/module-0050/);

  // It grows: only the new bytes are read, the counts go on.
  fs.appendFileSync(file, ' ✓ src/lantern/late.test.ts (7 tests) 2ms\n');
  await poller.tick();
  assert.deepEqual(emitted[1].health.t1.counts, { passed: 1500 * 5 - 30 + 7, failed: 30, skipped: 0 });

  // The closing summary wins, as before.
  fs.appendFileSync(file, '\n Test Files  30 failed | 1471 passed (1501)\n      Tests  30 failed | 7477 passed (7507)\n   Duration  41.2s\n');
  await poller.tick();
  const final = emitted[2].health.t1;
  assert.deepEqual([final.final, final.counts.passed, final.counts.failed], [true, 7477, 30]);
  assert.equal(final.firstFailureOffset, reading.firstFailureOffset, 'the first failure before the window comes from the scan');
});

test('a live node:test run past 64 KB is counted from its first line on', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'node-test-live.log');
  const lines = [];
  for (let index = 1; index <= 2500; index += 1) {
    lines.push(index === 7 ? `✖ lantern case ${index} keeps its wick trimmed (2.1ms)` : `✔ lantern case ${index} keeps its wick trimmed (1.0ms)`);
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  assert.ok(fs.statSync(file).size > 64 * 1024);
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: file }]);
  const emitted = [];
  const poller = createTaskHealthPoller({ store, io: { emit: (event, payload) => emitted.push(payload) }, logger: null });
  await poller.tick();
  const reading = emitted[0].health.t1;
  assert.deepEqual([reading.runner, reading.counts, reading.final], ['node:test', { passed: 2499, failed: 1, skipped: 0 }, false]);
  assert.equal(reading.firstFailureOffset, Buffer.byteLength(`${lines.slice(0, 6).join('\n')}\n`));
});

test('the scan catches up within its budget per tick, then reads only what is new', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'vitest-big.log');
  fs.writeFileSync(file, vitestLiveLog(3000));
  const size = fs.statSync(file).size;
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: file }]);
  const emitted = [];
  const poller = createTaskHealthPoller({ store, io: { emit: (event, payload) => emitted.push(payload) }, logger: null, scanBytesPerTick: 64 * 1024 });
  const ticks = Math.ceil(size / (64 * 1024));
  for (let tick = 1; tick < ticks; tick += 1) {
    await poller.tick();
    // While it catches up, the window alone: no header in it, no counts.
    assert.equal(store.health('sess-1', 't1').counts, null, `tick ${tick}`);
  }
  await poller.tick();
  assert.deepEqual(store.health('sess-1', 't1').counts, { passed: 3000 * 5 - 60, failed: 60, skipped: 0 }, 'caught up without the file changing');
  assert.equal(emitted.length, 2, 'the quiet reading, then the counts');
});

test('the runner scan holds an open line, skips an endless one, and starts over on a shorter file', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'scan.log');
  fs.writeFileSync(file, 'TAP version 13\nok 1 - spins\nok 2 - st');
  const scan = createRunnerScan(file);
  assert.equal(await advanceRunnerScan(scan, fs.statSync(file).size, { pieceBytes: 5 }), true);
  assert.deepEqual([scan.tally.result().passed, scan.tally.result().failed], [1, 0], 'the open line waits');
  fs.appendFileSync(file, `ops\n${'x'.repeat(70 * 1024)}\nnot ok 3 - falls\n`);
  await advanceRunnerScan(scan, fs.statSync(file).size);
  assert.deepEqual([scan.tally.result().passed, scan.tally.result().failed], [2, 1]);
  assert.equal(scan.carry, null);
  fs.writeFileSync(file, 'TAP version 13\nnot ok 1 - fresh\n');
  await advanceRunnerScan(scan, fs.statSync(file).size);
  assert.deepEqual([scan.tally.result().passed, scan.tally.result().failed, scan.tally.result().firstFailureLine], [0, 1, 15]);
});

test('the window decides a whole file and a final summary; the scan a run still going', () => {
  const whole = { runner: 'vitest', passed: 90, failed: 2, skipped: 1, firstFailureLine: 400, final: false };
  const live = { counts: { passed: 4, failed: 0, skipped: 0 }, runner: 'vitest', final: false, firstFailureOffset: null };
  assert.equal(healthWithScan(live, 0, whole), live, 'the window holds the whole file');
  assert.equal(healthWithScan(live, 100, null), live, 'no scan yet');
  assert.deepEqual(healthWithScan(live, 100, whole), { counts: { passed: 90, failed: 2, skipped: 1 }, runner: 'vitest', final: false, firstFailureOffset: 400 });
  const final = { counts: { passed: 91, failed: 2, skipped: 1 }, runner: 'vitest', final: true, firstFailureOffset: null };
  assert.deepEqual(healthWithScan(final, 100, whole), { ...final, firstFailureOffset: 400 });
  const finalClean = { ...final, counts: { passed: 93, failed: 0, skipped: 1 } };
  assert.equal(healthWithScan(finalClean, 100, whole), finalClean);
});

// An fs whose reads are counted, for what a tick costs.
function countingFs() {
  const counter = { bytes: 0 };
  const promises = {
    ...fs.promises,
    open: async (...args) => {
      const handle = await fs.promises.open(...args);
      return {
        stat: () => handle.stat(),
        read: async (...readArgs) => {
          const result = await handle.read(...readArgs);
          counter.bytes += result.bytesRead;
          return result;
        },
        close: () => handle.close(),
      };
    },
  };
  counter.fsImpl = { ...fs, promises, constants: fs.constants };
  return counter;
}

test('an ended row after a restart is read in its window only, never scanned from the start', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'vitest-ended.log');
  fs.writeFileSync(file, vitestLiveLog(4000));
  const size = fs.statSync(file).size;
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: file }]);
  store.replace('sess-1', []);
  const counter = countingFs();
  const poller = createTaskHealthPoller({ store, io: null, logger: null, fsImpl: counter.fsImpl });
  await poller.tick();
  assert.ok(counter.bytes <= 64 * 1024, `read ${counter.bytes} of ${size} bytes`);
  counter.bytes = 0;
  await poller.tick();
  assert.equal(counter.bytes, 0, 'settled: not read again');
});

test('the scans of a tick share one byte budget', async (t) => {
  const dir = tempDir(t);
  const files = ['a', 'b', 'c'].map((name) => {
    const file = path.join(dir, `${name}.log`);
    fs.writeFileSync(file, vitestLiveLog(3000));
    return file;
  });
  const size = fs.statSync(files[0]).size;
  const store = createBackgroundTaskStore();
  store.replace('sess-1', files.map((file, index) => ({ taskId: `t${index}`, taskType: 'local_bash', outputPath: file })));
  const counter = countingFs();
  const budget = 256 * 1024;
  const poller = createTaskHealthPoller({ store, io: null, logger: null, fsImpl: counter.fsImpl, scanBytesPerTick: budget });
  await poller.tick();
  // Each task: its window and a look at the file's start; the scans together: the budget.
  assert.ok(counter.bytes <= budget + 3 * 2 * 64 * 1024, `read ${counter.bytes}`);
  let ticks = 1;
  while (files.some((_, index) => !store.health('sess-1', `t${index}`)?.counts) && ticks < 20) {
    await poller.tick();
    ticks += 1;
  }
  assert.ok(ticks >= Math.ceil((3 * size) / budget), `caught up over ${ticks} ticks`);
  for (const [index] of files.entries()) assert.equal(store.health('sess-1', `t${index}`).counts.failed, 60);
});

test('a long log that is no test run is read once, then only what is new', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, Array.from({ length: 6000 }, (_, index) => `GET /lantern/${index} 200 3ms`).join('\n') + '\n');
  const size = fs.statSync(file).size;
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: file }]);
  const counter = countingFs();
  const poller = createTaskHealthPoller({ store, io: null, logger: null, fsImpl: counter.fsImpl });
  await poller.tick();
  assert.ok(counter.bytes <= size + 64 * 1024, `the window and the file once: ${counter.bytes}`);
  const late = 'GET /lantern/late 200 1ms\n';
  fs.appendFileSync(file, late);
  counter.bytes = 0;
  await poller.tick();
  assert.ok(counter.bytes <= 64 * 1024 + late.length, `then the window and the new line: ${counter.bytes}`);
  assert.equal(store.health('sess-1', 't1').counts, null);
});

// 120 KB of install and build output, then a vitest run of 7,500 tests whose
// header comes after it (it prints it once).
function buildThenVitest() {
  const build = [];
  for (let index = 0; build.join('\n').length < 120 * 1024; index += 1) {
    build.push(`[build] compiling src/lantern/part-${String(index).padStart(5, '0')}.ts (ok)`);
  }
  return `${build.join('\n')}\n${vitestLiveLog(1500)}`;
}

test('a test run whose header comes after 120 KB of build output is counted, live and after a restart', async (t) => {
  const dir = tempDir(t);
  const expected = { passed: 1500 * 5 - 30, failed: 30, skipped: 0 };
  // Live, the build first, then the whole run within one tick.
  const live = path.join(dir, 'live.log');
  const text = buildThenVitest();
  const at = text.indexOf(' RUN ');
  assert.ok(at > 120 * 1024 && text.length - at > 64 * 1024, 'header past the first 64 KB, and out of the last');
  fs.writeFileSync(live, text.slice(0, at));
  const store = createBackgroundTaskStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', outputPath: live }]);
  const poller = createTaskHealthPoller({ store, io: null, logger: null });
  await poller.tick();
  assert.equal(store.health('sess-1', 't1').counts, null, 'the build has no counts');
  fs.appendFileSync(live, text.slice(at));
  await poller.tick();
  assert.deepEqual(store.health('sess-1', 't1').counts, expected);

  // After a restart: a new poller meets the whole file at once.
  const restarted = path.join(dir, 'restarted.log');
  fs.writeFileSync(restarted, text);
  const fresh = createBackgroundTaskStore();
  fresh.replace('sess-2', [{ taskId: 't2', taskType: 'local_bash', outputPath: restarted }]);
  await createTaskHealthPoller({ store: fresh, io: null, logger: null }).tick();
  assert.deepEqual(fresh.health('sess-2', 't2').counts, expected);
});

test('each tick starts its scans at another task, so a busy log cannot starve the others', async (t) => {
  const dir = tempDir(t);
  const files = ['a', 'b'].map((name) => {
    const file = path.join(dir, `${name}.log`);
    fs.writeFileSync(file, vitestLiveLog(3000));
    return file;
  });
  const store = createBackgroundTaskStore();
  store.replace('sess-1', files.map((file, index) => ({ taskId: `t${index}`, taskType: 'local_bash', outputPath: file })));
  const size = fs.statSync(files[0]).size;
  // One tick's budget reads one file whole and no more.
  const poller = createTaskHealthPoller({ store, io: null, logger: null, scanBytesPerTick: size });
  await poller.tick();
  // The first task keeps growing, so it always has bytes to read.
  fs.appendFileSync(files[0], ' ✓ src/lantern/late-0.test.ts (5 tests) 1ms\n'.repeat(4000));
  await poller.tick();
  assert.ok(store.health('sess-1', 't0').counts, 'the first');
  assert.ok(store.health('sess-1', 't1').counts, 'and the other, on the next tick');
});

test('a scan starts over on a file replaced under the same path', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'scan.log');
  fs.writeFileSync(file, 'TAP version 13\nok 1 - spins\nok 2 - stops\n');
  const scan = createRunnerScan(file);
  let stats = fs.statSync(file);
  await advanceRunnerScan(scan, stats.size, { ino: stats.ino, mtimeMs: stats.mtimeMs });
  assert.equal(scan.tally.result().passed, 2);
  // Another file, as long or longer: a new inode.
  const other = path.join(dir, 'scan.next');
  fs.writeFileSync(other, 'TAP version 13\nnot ok 1 - fresh one\nok 2 - and this\n');
  fs.renameSync(other, file);
  stats = fs.statSync(file);
  await advanceRunnerScan(scan, stats.size, { ino: stats.ino, mtimeMs: stats.mtimeMs });
  assert.deepEqual([scan.tally.result().passed, scan.tally.result().failed], [1, 1]);
  // An mtime that went back: also a new file.
  await advanceRunnerScan(scan, stats.size + 0, { ino: stats.ino, mtimeMs: stats.mtimeMs - 5_000 });
  assert.equal(scan.offset, stats.size);
  assert.deepEqual([scan.tally.result().passed, scan.tally.result().failed], [1, 1], 'read again from the start');
});
