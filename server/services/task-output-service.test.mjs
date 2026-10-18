import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBackgroundTaskStore } from './background-task-store.mjs';
import {
  createTaskHealthPoller,
  createTaskOutputSnapshots,
  healthOfWindow,
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
