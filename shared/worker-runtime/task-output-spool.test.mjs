import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTaskOutputSpool, spoolSafeName } from './task-output-spool.mjs';

function tempBase(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the path is <base>/oar-task-output/<session>/<task>.log, with unsafe characters replaced', (t) => {
  const baseDir = tempBase(t);
  const spool = createTaskOutputSpool({ sessionId: 'sess-a1', baseDir });
  assert.equal(spool.root, path.join(baseDir, 'oar-task-output', 'sess-a1'));
  assert.equal(spool.pathFor('task 7/../x'), path.join(spool.root, 'task_7_.._x.log'));
  assert.ok(path.isAbsolute(spool.pathFor('t1')));
  assert.equal(spoolSafeName('..'), '__');
  assert.throws(() => createTaskOutputSpool({ sessionId: '', baseDir }));
});

test('append writes in order and creates the folder owner-only', (t) => {
  const baseDir = tempBase(t);
  const spool = createTaskOutputSpool({ sessionId: 'sess-a1', baseDir });
  assert.deepEqual(spool.append('t1', 'first\n'), { ok: true, bytes: 6, capped: false });
  spool.append('t1', 'second\n');
  assert.equal(fs.readFileSync(spool.pathFor('t1'), 'utf8'), 'first\nsecond\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(spool.root).mode & 0o777, 0o700); // host-platform: POSIX modes
  assert.equal(spool.append('', 'x').ok, false);
});

test('the cap writes one marker line and drops the rest, on a character boundary', (t) => {
  const baseDir = tempBase(t);
  const spool = createTaskOutputSpool({ sessionId: 'sess-a1', baseDir, maxBytes: 10 });
  spool.append('t1', 'abcdefgh');
  const capped = spool.append('t1', 'ijklü');
  assert.equal(capped.capped, true);
  assert.equal(spool.append('t1', 'more\n').capped, true);
  const text = fs.readFileSync(spool.pathFor('t1'), 'utf8');
  assert.match(text, /^abcdefghij\n\[output capped at 50 MB: later output is not kept\]\n$/);
  // A new spool object for the same session (a worker restart) sees the cap.
  const again = createTaskOutputSpool({ sessionId: 'sess-a1', baseDir, maxBytes: 10 });
  assert.equal(again.append('t1', 'x').capped, true);
});

test('sweep removes ended files older than an hour, never a live task\'s', (t) => {
  const baseDir = tempBase(t);
  let clock = Date.now();
  const spool = createTaskOutputSpool({ sessionId: 'sess-a1', baseDir, now: () => clock });
  spool.append('quiet-live', 'still running\n');
  spool.append('ended', 'done\n');
  spool.end('ended');
  spool.append('fresh', 'new\n');
  spool.end('fresh');
  const old = (clock - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(spool.pathFor('quiet-live'), old, old);
  fs.utimesSync(spool.pathFor('ended'), old, old);
  assert.equal(spool.sweep(), 1);
  assert.ok(fs.existsSync(spool.pathFor('quiet-live')));
  assert.ok(!fs.existsSync(spool.pathFor('ended')));
  assert.ok(fs.existsSync(spool.pathFor('fresh')));
  clock += 2 * 60 * 60 * 1000;
  assert.equal(spool.sweep(), 1);
  assert.ok(!fs.existsSync(spool.pathFor('fresh')));
});

test('another session\'s folder goes only once it is a day old, and empty folders with it', (t) => {
  const baseDir = tempBase(t);
  const other = createTaskOutputSpool({ sessionId: 'sess-b2', baseDir });
  other.append('t9', 'left behind\n');
  const spool = createTaskOutputSpool({ sessionId: 'sess-a1', baseDir });
  assert.equal(spool.sweep(), 0);
  assert.ok(fs.existsSync(other.pathFor('t9')));
  const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(other.pathFor('t9'), old, old);
  assert.equal(spool.sweep(), 1);
  assert.ok(!fs.existsSync(other.root));
  // A sweep before anything was written does not throw.
  assert.equal(createTaskOutputSpool({ sessionId: 'sess-c3', baseDir: path.join(baseDir, 'nothing-here') }).sweep(), 0);
});
