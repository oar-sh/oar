import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { migrateBackgroundTaskRows } from '../migrations/0018-background-task-rows.mjs';
import { createSqliteBackgroundTaskPersistence } from './background-task-persistence.mjs';
import { createBackgroundTaskStore } from './background-task-store.mjs';
import { backgroundTaskDigest } from '../../shared/worker-runtime/background-task-digest.mjs';

// A relay restart is a second store on the same database: what the first one
// wrote is all the second one knows.

const shell = (taskId, extra = {}) => ({ taskId, taskType: 'local_bash', description: `run ${taskId}`, outputPath: `/tmp/out/${taskId}.log`, outputKind: 'file', ...extra });
const quiet = { warn() {} };

function relay() {
  const db = new Database(':memory:');
  migrateBackgroundTaskRows(db);
  let clock = 5_000_000;
  const boot = () => createBackgroundTaskStore({
    now: () => clock,
    persistence: createSqliteBackgroundTaskPersistence(db, { now: () => clock, logger: quiet }),
  });
  const rows = () => db.prepare(`SELECT store_key, task_id, state FROM background_task_rows ORDER BY store_key, task_id`).all()
    .map((row) => `${row.store_key}/${row.task_id}:${row.state}`);
  return { db, boot, rows, tick: (ms) => { clock += ms; }, now: () => clock };
}

test('an ended row survives the restart with its status, exit code and end time', () => {
  const { boot, tick } = relay();
  const before = boot();
  before.replace('sess-1', [shell('t1', { command: 'make check | tail -5' })]);
  before.settle('sess-1', 't1', { status: 'completed', exitCode: 3 });
  before.replace('sess-1', []);
  const endedAt = before.ended('sess-1')[0].endedAt;
  tick(10 * 60_000);

  const after = boot();
  const [row] = after.ended('sess-1');
  assert.equal(row.taskId, 't1');
  assert.equal(row.status, 'completed');
  assert.equal(row.exitCode, 3);
  assert.equal(row.endedAt, endedAt);
  assert.equal(row.outputPath, '/tmp/out/t1.log');
  assert.equal(row.command, 'make check | tail -5');
  assert.equal(row.stoppable, false);
  const found = after.findTask(['sess-1'], 't1');
  assert.equal(found.ended, true, 'the console of the ended task opens after the restart');
  assert.deepEqual(after.endedKeys(), ['sess-1']);
});

test('an ended row past its hour is not restored, and goes from the table', () => {
  const { boot, tick, rows } = relay();
  const before = boot();
  before.replace('sess-1', [shell('t1')]);
  before.replace('sess-1', []);
  tick(61 * 60_000);
  const after = boot();
  assert.deepEqual(after.ended('sess-1'), []);
  assert.deepEqual(rows(), []);
});

test('the health reading is not stored: the poller reads the file again', () => {
  const { boot, db } = relay();
  const before = boot();
  before.replace('sess-1', [shell('t1')]);
  before.setHealth('sess-1', 't1', { lastOutputAt: 1, size: 10 });
  before.replace('sess-1', []);
  assert.ok(before.ended('sess-1')[0].health, 'the ended row carries the reading in memory');
  const stored = db.prepare(`SELECT row_json FROM background_task_rows`).all().map((row) => JSON.parse(row.row_json));
  assert.equal(stored.length, 1);
  assert.equal('health' in stored[0], false);
  assert.equal('health' in boot().ended('sess-1')[0], false);
});

test('a running console task is held after the restart: readable, but not running until the worker says so', () => {
  const { boot } = relay();
  const before = boot();
  before.replace('sess-1', [shell('t1', { command: 'npm test 2>&1 | tail -40' }), { taskId: 'agent-1', taskType: 'local_agent', description: 'a sub-agent' }]);

  const after = boot();
  assert.deepEqual(after.get('sess-1'), [], 'the panel does not show it as running');
  assert.equal(after.hasRestored('sess-1'), true);
  const found = after.findTask(['conv-1', 'sess-1'], 't1');
  assert.equal(found.ended, false);
  assert.equal(found.restored, true);
  assert.equal(found.task.outputPath, '/tmp/out/t1.log', 'the console reads the file before the worker reports');
  assert.equal(found.task.command, 'npm test 2>&1 | tail -40', 'the command line is kept for the console\'s tail marker');
  assert.equal(after.findTask(['sess-1'], 'agent-1'), null, 'sub-agents are not stored');
  // Whatever its digest says, the worker is asked for its set.
  assert.equal(after.matches(backgroundTaskDigest(['t1']), 'sess-1'), false);
  assert.equal(after.matches(backgroundTaskDigest([]), 'sess-1'), false);
  assert.equal(after.hasReport('sess-1'), false);
});

test('listRestored names the held tasks, read only, until the worker settles them', () => {
  const { boot } = relay();
  const before = boot();
  before.replace('sess-1', [shell('t1')]);
  const after = boot();
  const held = after.listRestored();
  assert.deepEqual(held.map(({ key, task }) => [key, task.taskId, task.outputPath]), [['sess-1', 't1', '/tmp/out/t1.log']]);
  held[0].task.taskId = 'changed';
  assert.equal(after.listRestored()[0].task.taskId, 't1', 'a copy');
  after.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', description: 'run t1' }]);
  assert.deepEqual(after.listRestored(), []);
});

test('the worker\'s set after the restart: a task in it is live again, one not in it ended in the gap', () => {
  const { boot, rows } = relay();
  const before = boot();
  before.replace('sess-1', [shell('t1'), shell('t2')]);
  before.settle('sess-1', 't2', { status: 'failed', exitCode: 1 });

  const after = boot();
  // The resync names t1 only, and without its path: the path it had stays.
  after.replace('sess-1', [{ taskId: 't1', taskType: 'local_bash', description: 'run t1' }]);
  assert.deepEqual(after.get('sess-1').map((task) => [task.taskId, task.outputPath]), [['t1', '/tmp/out/t1.log']]);
  const ended = after.ended('sess-1');
  assert.deepEqual(ended.map((row) => [row.taskId, row.status, row.exitCode]), [['t2', 'failed', 1]],
    'the settle the runtime before was told is kept');
  assert.equal(after.hasRestored('sess-1'), false);
  assert.equal(after.matches(backgroundTaskDigest(['t1']), 'sess-1'), true, 'in step again');
  assert.deepEqual(rows(), ['sess-1/t1:live', 'sess-1/t2:ended']);
});

test('a worker that does not report is taken as gone: its held tasks end, and are never running again by themselves', () => {
  const { boot, rows } = relay();
  const before = boot();
  before.replace('sess-dead', [shell('t1')]);
  before.replace('sess-alive', [shell('t2')]);

  const after = boot();
  after.replace('sess-alive', [shell('t2')]);
  assert.deepEqual(after.endUnconfirmed(), ['sess-dead']);
  assert.deepEqual(after.get('sess-dead'), []);
  assert.deepEqual(after.ended('sess-dead').map((row) => [row.taskId, row.status]), [['t1', 'unknown']]);
  assert.equal(after.findTask(['sess-dead'], 't1').ended, true, 'its console stays readable as an ended task');
  assert.deepEqual(after.get('sess-alive').map((task) => task.taskId), ['t2']);
  assert.deepEqual(after.endUnconfirmed(), [], 'once');
  assert.deepEqual(rows(), ['sess-alive/t2:live', 'sess-dead/t1:ended']);

  // A worker on older code that was alive after all: its next set brings it back.
  after.replace('sess-dead', [shell('t1')]);
  assert.deepEqual(after.get('sess-dead').map((task) => task.taskId), ['t1']);
  assert.deepEqual(after.ended('sess-dead'), []);
  assert.deepEqual(rows(), ['sess-alive/t2:live', 'sess-dead/t1:live']);
});

test('a settle the worker sends again for a held task ends it with that status', () => {
  const { boot } = relay();
  boot().replace('sess-1', [shell('t1')]);
  const after = boot();
  const row = after.settle('sess-1', 't1', { status: 'completed', exitCode: 0 });
  assert.equal(row.status, 'completed');
  assert.equal(after.hasRestored('sess-1'), false);
  assert.deepEqual(after.ended('sess-1').map((entry) => entry.taskId), ['t1']);
  // A third runtime still has it.
  assert.equal(boot().ended('sess-1')[0].status, 'completed');
});

test('progress posts that change nothing stored write nothing', () => {
  let writes = 0;
  const persistence = {
    available: true,
    load: () => [],
    saveLive: () => { writes += 1; return true; },
    saveEnded: () => true,
    remove: () => true,
    forget: () => true,
    pruneEnded: () => 0,
  };
  const store = createBackgroundTaskStore({ persistence });
  store.replace('sess-1', [{ taskId: 'agent-1', taskType: 'local_agent' }]);
  assert.equal(writes, 0, 'a set without a console task is not stored');
  store.replace('sess-1', [shell('t1', { summary: 'step 1' }), { taskId: 'agent-1', taskType: 'local_agent', totalTokens: 10 }]);
  store.replace('sess-1', [shell('t1', { summary: 'step 2' }), { taskId: 'agent-1', taskType: 'local_agent', totalTokens: 20 }]);
  assert.equal(writes, 1);
  store.settle('sess-1', 't1', { status: 'completed', exitCode: 0 });
  assert.equal(writes, 2, 'how it ended is stored before the set drops it');
  store.replace('sess-1', []);
  assert.equal(writes, 3);
  store.replace('sess-1', []);
  assert.equal(writes, 3);
});

test('deleting the conversation deletes its stored rows', () => {
  const { boot, rows } = relay();
  const before = boot();
  before.replace('sess-1', [shell('t1'), shell('t2')]);
  before.replace('sess-1', [shell('t2')]);
  before.replace('sess-2', [shell('t3')]);
  before.forget('conv-1', 'sess-1');
  assert.deepEqual(rows(), ['sess-2/t3:live']);
  const after = boot();
  assert.equal(after.findTask(['sess-1'], 't1'), null);
  assert.equal(after.findTask(['sess-1'], 't2'), null);
});

test('rows past the per-key limit and past their hour leave the table too', () => {
  const { db, rows } = relay();
  let clock = 0;
  const store = createBackgroundTaskStore({
    now: () => clock,
    endedMax: 2,
    persistence: createSqliteBackgroundTaskPersistence(db, { now: () => clock, logger: quiet }),
  });
  for (const id of ['t1', 't2', 't3']) {
    store.replace('sess-1', [shell(id)]);
    store.replace('sess-1', []);
    clock += 1_000;
  }
  assert.deepEqual(rows(), ['sess-1/t2:ended', 'sess-1/t3:ended']);
  clock += 2 * 60 * 60_000;
  store.pruneAll();
  assert.deepEqual(rows(), []);
});

test('without the table the store keeps its rows in memory, as before', () => {
  const db = new Database(':memory:');
  const persistence = createSqliteBackgroundTaskPersistence(db, { logger: quiet });
  assert.equal(persistence.available, false);
  const store = createBackgroundTaskStore({ persistence });
  store.replace('sess-1', [shell('t1')]);
  store.replace('sess-1', []);
  assert.deepEqual(store.ended('sess-1').map((row) => row.taskId), ['t1']);
  assert.deepEqual(createBackgroundTaskStore({ persistence }).ended('sess-1'), []);
});

test('a write that fails is logged once and the store goes on in memory', () => {
  const { db } = relay();
  const warnings = [];
  const persistence = createSqliteBackgroundTaskPersistence(db, { logger: { warn: (line) => warnings.push(line) } });
  db.exec(`DROP TABLE background_task_rows`);
  const store = createBackgroundTaskStore({ persistence });
  store.replace('sess-1', [shell('t1')]);
  store.replace('sess-1', [shell('t1'), shell('t2')]);
  store.replace('sess-1', []);
  assert.deepEqual(store.ended('sess-1').map((row) => row.taskId).sort(), ['t1', 't2']);
  assert.equal(warnings.filter((line) => line.includes('could not write')).length, 1);
});

test('a live row nobody confirmed for hours is a dead worker\'s leftover: not restored, and gone from the table', () => {
  const { boot, tick, rows } = relay();
  // The worker went away mid-runtime without an empty set; the runtime ran on.
  boot().replace('sess-gone', [shell('t1')]);
  tick(7 * 60 * 60_000);
  const after = boot();
  assert.equal(after.hasRestored('sess-gone'), false);
  assert.equal(after.findTask(['sess-gone'], 't1'), null);
  assert.deepEqual(after.endUnconfirmed(), []);
  assert.deepEqual(after.ended('sess-gone'), [], 'no fresh ended row days later');
  assert.deepEqual(rows(), []);
});

test('a worker whose digest agrees keeps its stored rows confirmed, so a quiet long task is restored', () => {
  const { boot, tick } = relay();
  const before = boot();
  before.replace('sess-1', [shell('t1')]);
  for (let hour = 0; hour < 7; hour += 1) {
    tick(60 * 60_000);
    assert.equal(before.matches(backgroundTaskDigest(['t1']), 'sess-1'), true);
  }
  const after = boot();
  assert.equal(after.hasRestored('sess-1'), true, 'confirmed within the last half hour');
});

test('a held task ends when the runtime before last knew it running, so an old one is not shown as just ended', () => {
  const { boot, tick, now } = relay();
  boot().replace('sess-1', [shell('t1')]);
  const storedAt = now();
  tick(20 * 60_000);
  const after = boot();
  after.endUnconfirmed();
  assert.equal(after.ended('sess-1')[0].endedAt, storedAt);

  // Last confirmed two hours before the restart: past the hour at once.
  const other = relay();
  other.boot().replace('sess-2', [shell('t2')]);
  other.tick(2 * 60 * 60_000);
  const later = other.boot();
  assert.equal(later.hasRestored('sess-2'), true);
  later.endUnconfirmed();
  assert.deepEqual(later.ended('sess-2'), []);
  later.pruneAll();
  assert.deepEqual(other.rows(), []);
});
