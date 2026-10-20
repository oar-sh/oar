// Grok's terminals as background tasks: a row per running terminal with its
// output spooled for the task console, a Stop that kills it, a settle notice
// with the exit code, and the heartbeat's digest and resync.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createAcpHostServices } from './acp-host-services.mjs';
import { createGrokTaskPublisher } from './grok-background-tasks.mjs';
import { createTaskOutputSpool } from '../../shared/worker-runtime/task-output-spool.mjs';

function createFakeTermProc(pid) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = pid;
  proc.kills = 0;
  proc.kill = () => { proc.kills += 1; };
  return proc;
}

function makeApi({ answers = {}, failRoutes = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    failRoutes,
    posts: (routePath) => calls.filter((call) => call.routePath === routePath).map((call) => call.body),
    api: async (method, routePath, body) => {
      calls.push({ method, routePath, body });
      if (failRoutes.has(routePath)) throw new Error(`stubbed failure for ${routePath}`);
      const answer = answers[routePath];
      return typeof answer === 'function' ? answer(body) : (answer ?? { ok: true });
    },
  };
}

// Most cases publish at once; the grace window has tests of its own.
function setup(t, { answers, onBackgroundTaskSetStale, publishAfterMs = 0 } = {}) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-grok-spool-'));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const spool = createTaskOutputSpool({ sessionId: 'conv-grok', baseDir });
  const stub = makeApi({ answers });
  const publisher = createGrokTaskPublisher({ api: stub.api, sdkSessionId: 'conv-grok', spool, onBackgroundTaskSetStale, publishAfterMs });
  t.after(() => publisher.close());
  const procs = [];
  const services = createAcpHostServices({
    cwd: '/home/dev/fixture-app',
    env: {},
    platform: 'linux',
    taskObserver: publisher,
    spawnImpl: () => {
      const proc = createFakeTermProc(4100 + procs.length);
      procs.push(proc);
      return proc;
    },
  });
  return { stub, spool, publisher, services, procs };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const lastSet = (stub) => stub.posts('/api/background-tasks').at(-1);

test('a terminal is a shell row naming its spool file, and its output lands there as it arrives', async (t) => {
  const { stub, spool, publisher, services, procs } = setup(t);
  const { terminalId } = await services.handlers['terminal/create']({ command: 'npm', args: ['test', '--', '--watch=false'] });
  await flush();
  const set = lastSet(stub);
  assert.equal(set.conversationId, 'conv-grok');
  assert.equal(set.order.seq, 1);
  assert.equal(set.tasks.length, 1);
  const [row] = set.tasks;
  assert.equal(row.taskId, terminalId);
  assert.equal(row.taskType, 'local_bash');
  assert.equal(row.description, 'npm test -- --watch=false');
  // The command line, for the console's `| tail` marker.
  assert.equal(row.command, 'npm test -- --watch=false');
  assert.equal(row.stoppable, true);
  assert.equal(row.outputKind, 'spool');
  assert.equal(row.outputPath, spool.pathFor(terminalId));
  assert.ok(Number.isFinite(row.startedAt));
  assert.deepEqual(publisher.backgroundTaskIds(), [terminalId]);

  procs[0].stdout.emit('data', Buffer.from('✓ adds\n'));
  procs[0].stderr.emit('data', Buffer.from('warn: slow\n'));
  assert.equal(fs.readFileSync(row.outputPath, 'utf8'), '✓ adds\nwarn: slow\n');
  // The agent still reads its own buffer.
  assert.equal(services.handlers['terminal/output']({ terminalId }).output, '✓ adds\nwarn: slow\n');
});

test('a long command line is cut to 500 characters for the description, 8,000 for the command (the relay cuts it after scrubbing)', async (t) => {
  const { stub, services } = setup(t);
  await services.handlers['terminal/create']({ command: `echo ${'x'.repeat(800)}` });
  await services.handlers['terminal/create']({ command: `echo ${'y'.repeat(9000)}` });
  await flush();
  const [short, long] = lastSet(stub).tasks;
  assert.equal(short.description.length, 500);
  assert.equal(short.command.length, 805);
  assert.equal(long.command.length, 8000);
});

test('an exit settles the task with its exit code and file, then the set drops it', async (t) => {
  const { stub, spool, publisher, services, procs } = setup(t);
  const { terminalId } = await services.handlers['terminal/create']({ command: 'npm test' });
  procs[0].stdout.emit('data', 'not ok 1 adds\n');
  procs[0].emit('exit', 1, null);
  await flush();
  await flush();
  const [settle] = stub.posts('/api/background-task-settled');
  assert.equal(settle.taskId, terminalId);
  assert.equal(settle.status, 'failed');
  assert.equal(settle.exitCode, 1);
  assert.equal(settle.outputPath, spool.pathFor(terminalId));
  assert.equal(settle.outputKind, 'spool');
  assert.equal(settle.taskType, 'local_bash');
  assert.equal(settle.description, 'npm test');
  assert.equal(settle.command, 'npm test');
  assert.deepEqual(lastSet(stub).tasks, []);
  assert.deepEqual(publisher.backgroundTaskIds(), []);
  const order = stub.calls.map((call) => call.routePath);
  assert.ok(order.lastIndexOf('/api/background-task-settled') < order.lastIndexOf('/api/background-tasks'), 'the end goes before the set without it');
  // The file stays for the relay.
  assert.equal(fs.readFileSync(spool.pathFor(terminalId), 'utf8'), 'not ok 1 adds\n');
});

test('a clean exit completes; the agent\'s release before the exit counts as a stop', async (t) => {
  const { stub, services, procs } = setup(t);
  const first = await services.handlers['terminal/create']({ command: 'true' });
  procs[0].emit('exit', 0, null);
  const second = await services.handlers['terminal/create']({ command: 'npm run dev' });
  await flush();
  assert.deepEqual(lastSet(stub).tasks.map((task) => task.taskId), [second.terminalId]);
  services.handlers['terminal/release']({ terminalId: second.terminalId });
  await flush();
  assert.deepEqual(lastSet(stub).tasks, [], 'released: the row goes at once');
  assert.equal(procs[1].kills, 1);
  procs[1].emit('exit', null, 'SIGTERM');
  await flush();
  await flush();
  const settles = stub.posts('/api/background-task-settled');
  assert.deepEqual(settles.map((body) => [body.taskId, body.status, body.exitCode]), [
    [first.terminalId, 'completed', 0],
    [second.terminalId, 'stopped', undefined],
  ]);
  assert.equal('exitCode' in settles[1], false, 'a killed process has no exit code');
  assert.equal(settles[1].summary, 'killed by SIGTERM');
});

test('the panel Stop kills the terminal\'s process and the settle says stopped', async (t) => {
  const { stub, publisher, services, procs } = setup(t);
  const { terminalId } = await services.handlers['terminal/create']({ command: 'sleep 600' });
  assert.equal(publisher.stop('term-unknown'), false);
  assert.equal(publisher.stop(terminalId), true);
  assert.equal(procs[0].kills, 1);
  procs[0].emit('exit', null, 'SIGTERM');
  await flush();
  await flush();
  assert.equal(stub.posts('/api/background-task-settled')[0].status, 'stopped');
  assert.equal(publisher.stop(terminalId), false, 'an ended terminal has nothing to stop');
});

test('a resync sends the same set flagged; a stale answer asks for a heartbeat once per ten seconds', async (t) => {
  let asked = 0;
  let answer = { ok: true };
  const { stub, publisher, services } = setup(t, {
    answers: { '/api/background-tasks': () => answer },
    onBackgroundTaskSetStale: () => { asked += 1; },
  });
  const { terminalId } = await services.handlers['terminal/create']({ command: 'npm run soak' });
  await flush();
  await publisher.resync();
  const posts = stub.posts('/api/background-tasks');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].resync, true);
  assert.deepEqual(posts[1].tasks.map((task) => task.taskId), [terminalId]);
  assert.equal(posts[1].tasks[0].startedAt, posts[0].tasks[0].startedAt);
  assert.equal(posts[1].order.epoch, posts[0].order.epoch);
  assert.ok(posts[1].order.seq > posts[0].order.seq);

  answer = { ok: true, stale: true, reason: 'not-holder' };
  await publisher.resync();
  await publisher.resync();
  assert.equal(asked, 1);
});

test('a settle the relay was not there to take is kept and sent after the next answered heartbeat', async (t) => {
  const { stub, publisher, services, procs } = setup(t);
  const { terminalId } = await services.handlers['terminal/create']({ command: 'npm test' });
  stub.failRoutes.add('/api/background-task-settled');
  procs[0].emit('exit', 2, null);
  await flush();
  await flush();
  assert.equal(stub.posts('/api/background-task-settled').length, 1);
  stub.failRoutes.clear();
  await publisher.flushKeptSettles();
  const settles = stub.posts('/api/background-task-settled');
  assert.equal(settles.length, 2);
  assert.equal(settles[1].taskId, terminalId);
  assert.equal(settles[1].exitCode, 2);
});

test('a rebuilt set of host services never reuses a terminal id', async (t) => {
  const { publisher } = setup(t);
  const make = () => createAcpHostServices({ platform: 'linux', env: {}, taskObserver: publisher, spawnImpl: () => createFakeTermProc(1) });
  const a = await make().handlers['terminal/create']({ command: 'ls' });
  const b = await make().handlers['terminal/create']({ command: 'ls' });
  assert.notEqual(a.terminalId, b.terminalId);
});

test('disposing the host services releases every terminal row', async (t) => {
  const { stub, services } = setup(t);
  await services.handlers['terminal/create']({ command: 'npm run dev' });
  await services.handlers['terminal/create']({ command: 'npm run watch' });
  await flush();
  assert.equal(lastSet(stub).tasks.length, 2);
  services.disposeAll();
  await flush();
  assert.deepEqual(lastSet(stub).tasks, []);
});

test('the spool is swept when the publisher starts', (t) => {
  let sweeps = 0;
  const spool = { pathFor: (id) => `/tmp/oar-task-output-fixture/${id}.log`, append: () => ({ ok: true }), sweep: () => { sweeps += 1; return 0; } };
  const publisher = createGrokTaskPublisher({ api: async () => ({}), sdkSessionId: 'conv-grok', spool });
  t.after(() => publisher.close());
  assert.equal(sweeps, 1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the default grace before a terminal becomes a row is 2 s', async () => {
  const { GROK_TERMINAL_PUBLISH_AFTER_MS } = await import('./grok-background-tasks.mjs');
  assert.equal(GROK_TERMINAL_PUBLISH_AFTER_MS, 2_000);
});

test('a terminal that ends inside the grace window is never published and never settles, but its output was spooled', async (t) => {
  const { stub, spool, publisher, services, procs } = setup(t, { publishAfterMs: 40 });
  const { terminalId } = await services.handlers['terminal/create']({ command: 'ls' });
  procs[0].stdout.emit('data', 'README.md\n');
  assert.deepEqual(publisher.backgroundTaskIds(), []);
  procs[0].emit('exit', 0, null);
  services.handlers['terminal/release']({ terminalId });
  await sleep(80);
  assert.equal(stub.posts('/api/background-tasks').length, 0);
  assert.equal(stub.posts('/api/background-task-settled').length, 0);
  assert.equal(fs.readFileSync(spool.pathFor(terminalId), 'utf8'), 'README.md\n');
});

test('a terminal released inside the grace window is never published either', async (t) => {
  const { stub, services } = setup(t, { publishAfterMs: 40 });
  const { terminalId } = await services.handlers['terminal/create']({ command: 'sleep 600' });
  services.handlers['terminal/release']({ terminalId });
  await sleep(80);
  assert.equal(stub.posts('/api/background-tasks').length, 0);
});

test('a terminal that outlives the grace window appears with everything it printed so far, and settles', async (t) => {
  const { stub, spool, publisher, services, procs } = setup(t, { publishAfterMs: 40 });
  const { terminalId } = await services.handlers['terminal/create']({ command: 'npm test' });
  procs[0].stdout.emit('data', 'ok 1 adds\n');
  assert.equal(stub.posts('/api/background-tasks').length, 0);
  await sleep(80);
  const [set] = stub.posts('/api/background-tasks');
  assert.deepEqual(set.tasks.map((task) => task.taskId), [terminalId]);
  assert.deepEqual(publisher.backgroundTaskIds(), [terminalId]);
  assert.equal(fs.readFileSync(spool.pathFor(terminalId), 'utf8'), 'ok 1 adds\n', 'output from before the row is there');
  procs[0].emit('exit', 0, null);
  await flush();
  await flush();
  assert.equal(stub.posts('/api/background-task-settled')[0].status, 'completed');
  assert.deepEqual(stub.posts('/api/background-tasks').at(-1).tasks, []);
});
