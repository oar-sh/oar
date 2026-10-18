import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackgroundTaskStore, normalizeEndedTaskStatus } from './background-task-store.mjs';

const shell = (taskId, extra = {}) => ({ taskId, taskType: 'local_bash', description: `run ${taskId}`, outputPath: `/tmp/out/${taskId}.log`, ...extra });

function clockedStore(options = {}) {
  let clock = 1_000_000;
  const store = createBackgroundTaskStore({ now: () => clock, ...options });
  return { store, tick: (ms) => { clock += ms; }, now: () => clock };
}

test('a task with an output path that leaves the set becomes an ended row', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [shell('t1'), { taskId: 'agent-1', taskType: 'local_agent' }]);
  store.replace('sess-1', []);
  const ended = store.ended('sess-1');
  assert.equal(ended.length, 1, 'the sub-agent without output is not kept');
  assert.equal(ended[0].taskId, 't1');
  assert.equal(ended[0].status, 'unknown');
  assert.equal(ended[0].exitCode, null);
  assert.equal(ended[0].stoppable, false);
  assert.equal(ended[0].endedAt, 1_000_000);
});

test('a settle before the drop gives the ended row its status and exit code', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [shell('t1')]);
  assert.equal(store.settle('sess-1', 't1', { status: 'completed', exitCode: 2 }), null);
  store.replace('sess-1', []);
  const [row] = store.ended('sess-1');
  assert.equal(row.status, 'completed');
  assert.equal(row.exitCode, 2);
});

test('a settle after the drop updates the ended row', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [shell('t1')]);
  store.replace('sess-1', []);
  const row = store.settle('sess-1', 't1', { status: 'failed', exitCode: '1' });
  assert.equal(row.status, 'failed');
  assert.equal(store.ended('sess-1')[0].exitCode, 1);
});

test('a settle for a task never seen live becomes an ended row only when it names its output', () => {
  const { store } = clockedStore();
  assert.equal(store.settle('sess-1', 'ghost', { status: 'completed' }), null);
  const row = store.settle('sess-1', 'late', { status: 'killed', outputPath: '/tmp/out/late.log', description: 'npm test' });
  assert.equal(row.status, 'stopped');
  assert.equal(row.outputPath, '/tmp/out/late.log');
  assert.deepEqual(store.ended('sess-1').map((entry) => entry.taskId), ['late']);
});

test('a settle naming a path for a live task without one sets it; the first path wins', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash' }]);
  store.settle('sess-1', 't1', { status: 'completed', outputPath: '/tmp/out/first.log' });
  store.settle('sess-1', 't1', { status: 'completed', outputPath: '/tmp/out/second.log' });
  store.replace('sess-1', []);
  assert.equal(store.ended('sess-1')[0].outputPath, '/tmp/out/first.log');
});

test('ended rows expire after an hour and keep at most 20 per key, newest first', () => {
  const { store, tick } = clockedStore();
  for (let index = 0; index < 22; index += 1) {
    store.replace('sess-1', [shell(`t${index}`)]);
    store.replace('sess-1', []);
    tick(1000);
  }
  const ended = store.ended('sess-1');
  assert.equal(ended.length, 20);
  assert.equal(ended[0].taskId, 't21');
  assert.equal(ended.at(-1).taskId, 't2');
  tick(60 * 60 * 1000);
  assert.deepEqual(store.ended('sess-1'), []);
  assert.equal(store.findTask(['sess-1'], 't21'), null);
});

test('a task back in the set is no longer ended', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [shell('t1')]);
  store.replace('sess-1', []);
  store.replace('sess-1', [shell('t1')]);
  assert.deepEqual(store.ended('sess-1'), []);
  assert.equal(store.findTask(['sess-1'], 't1').ended, false);
});

test('health is held per live task, served with the rows and carried onto the ended row', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [shell('t1'), shell('t2')]);
  const reading = { lastOutputAt: 5, size: 10, counts: { passed: 3, failed: 1, skipped: 0 }, runner: 'vitest', firstFailureOffset: 4 };
  store.setHealth('sess-1', 't1', reading);
  assert.deepEqual(store.health('sess-1', 't1'), reading);
  const rows = store.withHealth(store.get('sess-1'), 'conv-1', 'sess-1');
  assert.deepEqual(rows[0].health, reading);
  assert.equal(rows[1].health, undefined);
  assert.equal(store.get('sess-1')[0].health, undefined, 'the stored row stays as posted');
  assert.deepEqual(store.findTask(['conv-1', 'sess-1'], 't1').task.health, reading);
  store.replace('sess-1', [shell('t2')]);
  assert.equal(store.health('sess-1', 't1'), null);
  assert.deepEqual(store.ended('sess-1')[0].health, reading);
});

test('findTask looks through every key, live before ended', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [shell('t1')]);
  store.replace('sess-1', []);
  store.replace('conv-1', [shell('t1', { description: 'again' })]);
  const found = store.findTask(['conv-1', 'sess-1'], 't1');
  assert.equal(found.ended, false);
  assert.equal(found.key, 'conv-1');
  assert.equal(store.findTask(['sess-1'], 't1').ended, true);
  assert.equal(store.findTask(['sess-2'], 't1'), null);
  assert.equal(store.findTask(['sess-1'], ''), null);
});

test('forget clears ended rows, pending settles and health', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [shell('t1'), shell('t2')]);
  store.setHealth('sess-1', 't2', { size: 1 });
  store.settle('sess-1', 't2', { status: 'failed' });
  store.replace('sess-1', [shell('t2')]);
  store.forget('sess-1');
  assert.deepEqual(store.ended('sess-1'), []);
  assert.equal(store.health('sess-1', 't2'), null);
  store.replace('sess-1', [shell('t2')]);
  store.replace('sess-1', []);
  assert.equal(store.ended('sess-1')[0].status, 'unknown', 'the forgotten settle does not come back');
});

test('ended statuses normalise to completed, failed, stopped or unknown', () => {
  assert.equal(normalizeEndedTaskStatus('completed'), 'completed');
  assert.equal(normalizeEndedTaskStatus('done', 1), 'failed');
  assert.equal(normalizeEndedTaskStatus('error'), 'failed');
  assert.equal(normalizeEndedTaskStatus('cancelled'), 'stopped');
  assert.equal(normalizeEndedTaskStatus('', 0), 'completed');
  assert.equal(normalizeEndedTaskStatus('', 3), 'failed');
  assert.equal(normalizeEndedTaskStatus('whatever'), 'unknown');
});

test('a settle\'s step count lands on the ended row, before or after the drop', () => {
  const { store } = clockedStore();
  store.replace('sess-1', [shell('t1', { steps: 3 }), shell('t2', { steps: 1 })]);
  store.settle('sess-1', 't1', { status: 'completed', steps: 22 });
  store.replace('sess-1', []);
  store.settle('sess-1', 't2', { status: 'completed', steps: 9 });
  const byId = Object.fromEntries(store.ended('sess-1').map((row) => [row.taskId, row.steps]));
  assert.deepEqual(byId, { t1: 22, t2: 9 });
  assert.equal(store.settle('sess-1', 'late', { status: 'failed', steps: 4, outputPath: '/tmp/out/late.log' }).steps, 4);
});

test('pruneAll expires ended rows and pending settles of keys nobody reads again', () => {
  const { store, tick } = clockedStore();
  store.replace('sess-1', [shell('t1')]);
  store.replace('sess-1', []);
  store.replace('sess-2', [shell('t2')]);
  store.settle('sess-2', 't2', { status: 'failed', exitCode: 1 });
  tick(30 * 60 * 1000);
  store.pruneAll();
  assert.equal(store.findTask(['sess-1'], 't1').ended, true, 'within the hour it stays');
  tick(31 * 60 * 1000);
  store.pruneAll();
  assert.deepEqual(store.ended('sess-1'), []);
  // The expired settle no longer colours the row the drop makes.
  store.replace('sess-2', []);
  assert.equal(store.ended('sess-2')[0].status, 'unknown');
});
