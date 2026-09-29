import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectProcessDescendants,
  createProcessTreeWatch,
  isChildProcessOf,
} from './process-tree.mjs';
import { makeFakeClock, makeFakeProcessTable } from './process-tree-test-harness.mjs';

// The layout that was measured: the worker (9001) under the relay (9000), the
// runtime (4100) under the worker, a shell (4200) with a python child (4201)
// under the runtime, and somebody else's processes next to them.
const WORKER = 9001;
const RELAY = 9000;
const RUNTIME = 4100;
const measuredLayout = () => [
  { processId: 1, parentProcessId: 0, createdAt: 10, name: 'init' },
  { processId: RELAY, parentProcessId: 1, createdAt: 100, name: 'node' },
  { processId: WORKER, parentProcessId: RELAY, createdAt: 200, name: 'node' },
  { processId: RUNTIME, parentProcessId: WORKER, createdAt: 300, name: 'node' },
  { processId: 4200, parentProcessId: RUNTIME, createdAt: 400, name: 'bash', sessionLeader: true },
  { processId: 4201, parentProcessId: 4200, createdAt: 410, name: 'python3', sessionLeader: false },
  // Another worker's runtime and its command: none of this tree's business.
  { processId: 5100, parentProcessId: RELAY, createdAt: 310, name: 'node' },
  { processId: 5200, parentProcessId: 5100, createdAt: 420, name: 'bash', sessionLeader: true },
  { processId: 7000, parentProcessId: 1, createdAt: 50, name: 'sshd' },
];

function watchOver(fake, options = {}) {
  const clock = makeFakeClock();
  const log = [];
  const watch = createProcessTreeWatch({
    rootPid: RUNTIME,
    lister: fake.lister,
    signal: fake.signal,
    protectedPids: [WORKER, RELAY],
    pollMs: 0,
    now: clock.now,
    sleep: clock.sleep,
    dbg: (...parts) => log.push(parts.join(' ')),
    ...options,
  });
  return { watch, clock, log };
}

test('the descendants of a process are found from a process list, a parent before its children', () => {
  const found = collectProcessDescendants(measuredLayout(), { processId: RUNTIME, createdAt: 300 });
  assert.deepEqual(found.map((proc) => proc.processId), [4200, 4201]);

  // The whole list below the relay, and nothing above or beside it.
  const belowRelay = collectProcessDescendants(measuredLayout(), { processId: RELAY, createdAt: 100 });
  assert.deepEqual(belowRelay.map((proc) => proc.processId), [WORKER, RUNTIME, 4200, 4201, 5100, 5200]);
});

test('a process older than its "parent" is no child of it', () => {
  // Windows keeps the pid of a creator that is long gone, and hands that pid
  // out again: 610 was started before the process that now has pid 600.
  const list = [
    { processId: 600, parentProcessId: 1, createdAt: 5_000 },
    { processId: 610, parentProcessId: 600, createdAt: 1_000 },
    { processId: 620, parentProcessId: 600, createdAt: 6_000 },
  ];
  assert.equal(isChildProcessOf(list[1], list[0]), false);
  assert.deepEqual(collectProcessDescendants(list, list[0]).map((proc) => proc.processId), [620]);
});

test('a process list that names itself as its own ancestor ends the walk', () => {
  const list = [
    { processId: 600, parentProcessId: 610, createdAt: 0 },
    { processId: 610, parentProcessId: 600, createdAt: 0 },
  ];
  assert.deepEqual(collectProcessDescendants(list, list[0]).map((proc) => proc.processId), [610]);
});

test('`accept` leaves a process out with everything it started', () => {
  const found = collectProcessDescendants(measuredLayout(), { processId: RELAY, createdAt: 100 }, {
    accept: (child) => child.processId !== 5100,
  });
  assert.deepEqual(found.map((proc) => proc.processId), [WORKER, RUNTIME, 4200, 4201]);
});

test('the tree is read when the watch starts, and the log says how many processes it holds', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch, log } = watchOver(fake);

  assert.deepEqual(await watch.latest(), { count: 2, commands: 1 });
  assert.deepEqual(watch.members().map((proc) => proc.processId), [4200, 4201]);
  assert.deepEqual(log, ['runtime process tree read: 2 processes below pid 4100']);

  // The same tree read again is not logged again.
  await watch.snapshot();
  assert.equal(log.length, 1);
});

test('a runtime that was killed leaves its commands to pid 1, and the tree that was read still finds them', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch, log } = watchOver(fake);

  fake.end(RUNTIME);
  // Nothing in the list names the runtime any more.
  assert.deepEqual(collectProcessDescendants(fake.lister.list(), { processId: RUNTIME, createdAt: 300 }), []);
  assert.deepEqual(await watch.snapshot(), { count: 2, commands: 1 });

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }, { pid: 4201, name: 'SIGTERM' }]);
  assert.deepEqual(result.ended, [4200, 4201]);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(result.left, []);
  assert.deepEqual(log.slice(1), [
    'stopping what the runtime left running (runtime-exit): pid 4200, 4201',
    'runtime process tree stopped (runtime-exit): 2 ended on SIGTERM, 0 killed, 0 still running',
  ]);
});

test('nothing outside the tree is signalled', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch } = watchOver(fake);
  fake.end(RUNTIME);

  await watch.stop('runtime-gone');

  // pid 1, the relay, the worker, the other worker's runtime and command, and
  // the stranger are all still there.
  assert.deepEqual(fake.pids(), [1, 5100, 5200, 7000, RELAY, WORKER]);
  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201]);
});

test('the pid of a command that ended and was handed out again is left alone', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch, log } = watchOver(fake);
  fake.end(RUNTIME);
  // The python process ended by itself; its pid now belongs to somebody
  // else's process, started later.
  fake.end(4201);
  fake.add({ processId: 4201, parentProcessId: 7000, createdAt: 900, name: 'backup' });

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }]);
  assert.deepEqual(result.refused, [4201]);
  assert.equal(fake.has(4201), true);
  assert.ok(log.includes('runtime process tree (runtime-exit): pid 4201 now belongs to another process; left alone'));
});

test('a pid that changes hands between the list and the signal is left alone', async () => {
  // The list is read, and only then does the process end and its pid go to
  // another: the check right before the signal is what catches it.
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch } = watchOver(fake);
  fake.end(RUNTIME);
  const list = fake.lister.list.bind(fake.lister);
  fake.lister.list = () => {
    const entries = list();
    fake.end(4201);
    fake.add({ processId: 4201, parentProcessId: 7000, createdAt: 900, name: 'backup' });
    return entries;
  };

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }]);
  assert.deepEqual(result.refused, [4201]);
  assert.equal(fake.has(4201), true);
});

test('a process whose start time is not known is never signalled', async () => {
  const layout = measuredLayout().map((proc) => (proc.processId === 4201 ? { ...proc, createdAt: 0 } : proc));
  const fake = makeFakeProcessTable(layout);
  const { watch } = watchOver(fake);
  fake.end(RUNTIME);

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }]);
  assert.deepEqual(result.refused, [4201]);
});

test('the worker, the relay and pid 1 are never signalled, whatever the process list says', async () => {
  // A list that (wrongly) names them as children of the runtime.
  const fake = makeFakeProcessTable([
    { processId: 1, parentProcessId: RUNTIME, createdAt: 310 },
    { processId: RELAY, parentProcessId: RUNTIME, createdAt: 320 },
    { processId: WORKER, parentProcessId: RUNTIME, createdAt: 330 },
    { processId: RUNTIME, parentProcessId: 1, createdAt: 300 },
    { processId: 4200, parentProcessId: RUNTIME, createdAt: 400 },
  ]);
  const { watch } = watchOver(fake);

  await watch.stop('turn-failure');

  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }]);
  assert.deepEqual(fake.pids(), [1, RUNTIME, RELAY, WORKER]);
});

test('a command that ignores SIGTERM is killed after the bounded wait', async () => {
  const fake = makeFakeProcessTable(measuredLayout(), { ignoresTerm: [4200] });
  const { watch, clock } = watchOver(fake, { stopGraceMs: 3_000, killWaitMs: 1_000, exitPollMs: 100 });
  fake.end(RUNTIME);

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals, [
    { pid: 4200, name: 'SIGTERM' },
    { pid: 4201, name: 'SIGTERM' },
    { pid: 4200, name: 'SIGKILL' },
  ]);
  assert.deepEqual(result.ended, [4201]);
  assert.deepEqual(result.killed, [4200]);
  assert.deepEqual(result.left, []);
  // The wait is the grace and no more. It is counted on the clock the watch
  // was given, not measured.
  assert.equal(clock.slept(), 3_000);
});

test('a clock that stands still does not hold the stop', async () => {
  const fake = makeFakeProcessTable(measuredLayout(), { ignoresTerm: [4200] });
  let sleeps = 0;
  const { watch } = watchOver(fake, {
    stopGraceMs: 300,
    killWaitMs: 200,
    exitPollMs: 100,
    now: () => 5_000,
    sleep: async () => { sleeps += 1; },
  });
  fake.end(RUNTIME);

  const result = await watch.stop('runtime-exit');

  assert.equal(sleeps, 3);
  assert.deepEqual(result.killed, [4200]);
});

test('a command that ends on SIGTERM is not waited for', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch, clock } = watchOver(fake);
  fake.end(RUNTIME);

  await watch.stop('runtime-exit');

  assert.equal(clock.slept(), 0);
  assert.deepEqual(fake.signalled('SIGKILL'), []);
});

test('a watch that never saw the runtime alive knows no tree', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  fake.end(RUNTIME);
  const { watch } = watchOver(fake);

  assert.deepEqual(await watch.stop('runtime-exit'), {
    reason: 'runtime-exit', found: 0, ended: [], killed: [], left: [], refused: [],
  });
  assert.deepEqual(fake.signals, []);
});

test('what a stubborn command started during the wait is killed with it', async () => {
  const fake = makeFakeProcessTable(measuredLayout(), { ignoresTerm: [4200] });
  const clock = makeFakeClock();
  let started = false;
  const watch = createProcessTreeWatch({
    rootPid: RUNTIME,
    lister: fake.lister,
    signal: fake.signal,
    pollMs: 0,
    stopGraceMs: 500,
    exitPollMs: 100,
    now: clock.now,
    sleep: async (ms) => {
      if (!started) {
        started = true;
        fake.add({ processId: 4202, parentProcessId: 4200, createdAt: 500, name: 'make' });
      }
      await clock.sleep(ms);
    },
  });
  fake.end(RUNTIME);

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signalled('SIGKILL'), [4200, 4202]);
  assert.deepEqual(result.killed, [4200, 4202]);
  assert.deepEqual(fake.pids(), [1, 5100, 5200, 7000, RELAY, WORKER]);
});

test('a process that survives the kill is reported, and the stop still ends', async () => {
  const fake = makeFakeProcessTable(measuredLayout(), { ignoresTerm: [4200] });
  const kills = [];
  const { watch, clock, log } = watchOver(fake, {
    stopGraceMs: 300,
    killWaitMs: 200,
    exitPollMs: 100,
    // A kill that does not take.
    signal: (pid, name) => {
      if (name !== 'SIGKILL') return fake.signal(pid, name);
      kills.push(pid);
      return true;
    },
  });
  fake.end(RUNTIME);

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(kills, [4200]);
  assert.deepEqual(result.killed, []);
  assert.deepEqual(result.left, [4200]);
  assert.equal(clock.slept(), 500);
  assert.equal(
    log.at(-1),
    'runtime process tree stopped (runtime-exit): 1 ended on SIGTERM, 0 killed, 1 still running (pid 4200)',
  );
});

test('what a command has started since the tree was last read is stopped with it', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch } = watchOver(fake);
  fake.end(RUNTIME);
  // The shell went on to its next command after the last read.
  fake.end(4201);
  fake.add({ processId: 4300, parentProcessId: 4200, createdAt: 600, name: 'make' });

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals, [{ pid: 4200, name: 'SIGTERM' }, { pid: 4300, name: 'SIGTERM' }]);
  assert.deepEqual(result.ended, [4200, 4300]);
});

test('a command that ended by itself leaves nothing to stop', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch, log } = watchOver(fake);
  fake.end(4201);
  fake.end(4200);
  fake.end(RUNTIME);

  assert.deepEqual(await watch.snapshot(), { count: 0, commands: 0 });
  const result = await watch.stop('runtime-exit');

  assert.equal(result.found, 0);
  assert.deepEqual(fake.signals, []);
  assert.equal(log.at(-1), 'runtime process tree (runtime-exit): nothing left to stop');
});

test('a command that was started to outlive the session is left alone with what it started', async () => {
  const fake = makeFakeProcessTable([
    ...measuredLayout(),
    { processId: 4400, parentProcessId: RUNTIME, createdAt: 430, name: 'sh', commandLine: 'sh -c keep-me-running' },
    { processId: 4401, parentProcessId: 4400, createdAt: 440, name: 'node' },
  ]);
  const { watch, log } = watchOver(fake, {
    keepSubtree: (proc) => proc.commandLine.includes('keep-me-running'),
  });
  assert.deepEqual(await watch.latest(), { count: 2, commands: 1 });
  assert.equal(log[0], 'runtime process tree read: 2 processes below pid 4100 (1 detached command left out)');
  fake.end(RUNTIME);

  await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201]);
  assert.equal(fake.has(4400), true);
  assert.equal(fake.has(4401), true);
});

test('the command line of a child is asked for where the list does not carry it', async () => {
  const fake = makeFakeProcessTable([
    ...measuredLayout(),
    { processId: 4400, parentProcessId: RUNTIME, createdAt: 430, name: 'sh' },
  ]);
  const asked = [];
  fake.lister.describe = (pid) => { asked.push(pid); return pid === 4400 ? 'sh -c keep-me-running' : 'bash'; };
  const { watch } = watchOver(fake, { keepSubtree: (proc) => proc.commandLine.includes('keep-me-running') });

  assert.deepEqual(watch.members().map((proc) => proc.processId), [4200, 4201]);
  // Only of the runtime's own children: that is where a command starts.
  assert.deepEqual(asked, [4200, 4400]);
});

test('what the runtime starts inside its own session is a helper, not a command', async () => {
  const fake = makeFakeProcessTable([
    ...measuredLayout(),
    { processId: 4500, parentProcessId: RUNTIME, createdAt: 430, name: 'node', sessionLeader: false },
  ]);
  const { watch } = watchOver(fake);
  assert.deepEqual(await watch.latest(), { count: 3, commands: 1 });
  fake.end(RUNTIME);

  // It is stopped all the same: it is part of the tree.
  await watch.stop('runtime-exit');
  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201, 4500]);
});

test('a process list that cannot be read stops nothing', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch, log } = watchOver(fake);
  fake.end(RUNTIME);
  fake.lister.list = () => { throw new Error('EMFILE: too many open files'); };

  assert.deepEqual(await watch.snapshot(), { count: 2, commands: 1 });
  const result = await watch.stop('runtime-exit');

  assert.equal(result.found, 0);
  assert.deepEqual(fake.signals, []);
  assert.match(log.at(-1), /not stopped \(runtime-exit\): the process list could not be read EMFILE/);
});

test('a runtime whose pid is not known is not watched and nothing is signalled', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const watch = createProcessTreeWatch({ rootPid: 0, lister: fake.lister, signal: fake.signal, pollMs: 0 });

  assert.deepEqual(await watch.snapshot(), { count: 0, commands: 0 });
  assert.equal((await watch.stop('runtime-exit')).found, 0);
  assert.equal(fake.listCount(), 0);
  assert.deepEqual(fake.signals, []);
});

test('a tree is stopped once, and a closed watch reads nothing more', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch } = watchOver(fake);
  fake.end(RUNTIME);

  const [first, second] = await Promise.all([watch.stop('runtime-exit'), watch.stop('turn-failure')]);
  assert.equal(first, second);
  assert.equal(fake.signals.length, 2);

  const lists = fake.listCount();
  await watch.snapshot();
  watch.commandStarting();
  assert.equal(fake.listCount(), lists);
});

test('a closed watch signals nothing: the runtime ended in good order', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch } = watchOver(fake);

  watch.close();
  const lists = fake.listCount();
  await watch.snapshot();

  assert.equal(fake.listCount(), lists);
  assert.deepEqual(fake.signals, []);
});

// ----------------------------------------------------------------- windows --
//
// Unverified on Windows: these tests pin the rules with a process table that
// behaves as Windows is documented to (a child keeps the pid of a parent that
// has ended; the list is read as a whole; SIGTERM ends a process at once).

test('windows: the children of a runtime that has ended are found by the pid they kept', async () => {
  const fake = makeFakeProcessTable(measuredLayout(), { posix: false });
  const { watch } = watchOver(fake);
  await watch.latest();
  // Started after the last read, and the runtime is killed right after.
  fake.add({ processId: 4600, parentProcessId: RUNTIME, createdAt: 700, name: 'cmd.exe' });
  fake.end(RUNTIME);

  assert.deepEqual(await watch.snapshot(), { count: 3, commands: 2 });
  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201, 4600]);
  assert.deepEqual(result.ended, [4200, 4201, 4600]);
  assert.deepEqual(fake.pids(), [1, 5100, 5200, 7000, RELAY, WORKER]);
});

test('windows: a process that was given the pid of the runtime keeps its own children', async () => {
  const fake = makeFakeProcessTable(measuredLayout(), { posix: false });
  const { watch } = watchOver(fake);
  await watch.latest();
  fake.end(RUNTIME);
  // The pid goes to somebody else's process, which starts a child.
  fake.add({ processId: RUNTIME, parentProcessId: 7000, createdAt: 800, name: 'backup.exe' });
  fake.add({ processId: 4700, parentProcessId: RUNTIME, createdAt: 810, name: 'robocopy.exe' });

  await watch.stop('runtime-exit');

  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201]);
  assert.equal(fake.has(RUNTIME), true);
  assert.equal(fake.has(4700), true);
});

test('windows: a process that names the runtime as its parent but is older than it is not its child', async () => {
  const fake = makeFakeProcessTable([
    ...measuredLayout(),
    // Its creator had pid 4100 long before the runtime was given it.
    { processId: 4800, parentProcessId: RUNTIME, createdAt: 60, name: 'explorer.exe' },
  ], { posix: false });
  const { watch } = watchOver(fake);
  await watch.latest();
  fake.end(RUNTIME);

  await watch.stop('runtime-gone');

  assert.deepEqual(fake.signals.map((entry) => entry.pid), [4200, 4201]);
  assert.equal(fake.has(4800), true);
});

test('windows: a runtime that was never seen alive is not walked from its pid alone', async () => {
  const fake = makeFakeProcessTable(measuredLayout(), { posix: false });
  fake.end(RUNTIME);
  const { watch, log } = watchOver(fake);
  await watch.latest();

  const result = await watch.stop('runtime-exit');

  assert.equal(result.found, 0);
  assert.deepEqual(fake.signals, []);
  assert.equal(log.at(-1), 'runtime process tree (runtime-exit): nothing left to stop');
});

test('windows: the tree is not polled and not read at a command start', async () => {
  const fake = makeFakeProcessTable(measuredLayout(), { posix: false });
  const { watch } = watchOver(fake, { pollMs: 1, commandLooksMs: [1] });
  await watch.latest();
  assert.equal(fake.listCount(), 1);

  watch.commandStarting();
  // Whatever time passes, no timer of the watch is there to fire.
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(fake.listCount(), 1);
  watch.close();
});

test('windows: a pid that was handed out again during the wait is not killed', async () => {
  // Without a cheap read the wait asks whether the pid exists; the list read
  // before the kill is what tells whose it is.
  const fake = makeFakeProcessTable(measuredLayout(), { posix: false, ignoresTerm: [4200, 4201] });
  const clock = makeFakeClock();
  let handedOut = false;
  const watch = createProcessTreeWatch({
    rootPid: RUNTIME,
    lister: fake.lister,
    signal: fake.signal,
    pollMs: 0,
    stopGraceMs: 300,
    exitPollMs: 100,
    now: clock.now,
    sleep: async (ms) => {
      if (!handedOut) {
        handedOut = true;
        fake.end(4201);
        fake.add({ processId: 4201, parentProcessId: 7000, createdAt: 900, name: 'backup.exe' });
      }
      await clock.sleep(ms);
    },
  });
  await watch.latest();
  fake.end(RUNTIME);

  const result = await watch.stop('runtime-exit');

  assert.deepEqual(fake.signalled('SIGKILL'), [4200]);
  assert.deepEqual(result.killed, [4200]);
  assert.deepEqual(result.ended, [4201]);
  assert.equal(fake.has(4201), true);
});

test('a read that fails is logged and keeps the last tree, whichever way it fails', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch, log } = watchOver(fake, {
    keepSubtree: () => { throw new Error('the rule broke'); },
  });
  // The first read failed inside the walk: nothing is known, nothing thrown.
  assert.deepEqual(await watch.latest(), { count: 0, commands: 0 });
  assert.match(log.at(-1), /process tree could not be read the rule broke/);

  const windows = makeFakeProcessTable(measuredLayout(), { posix: false });
  const other = watchOver(windows);
  await other.watch.latest();
  windows.lister.list = async () => { throw new Error('powershell.exe timed out'); };

  assert.deepEqual(await other.watch.snapshot(), { count: 2, commands: 1 });
  assert.match(other.log.at(-1), /process tree could not be read powershell\.exe timed out/);
});

test('the watch says whether the runtime had ended when it last looked', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  const { watch } = watchOver(fake);
  assert.equal(await watch.runtimeEnded(), false);

  fake.end(RUNTIME);
  // Not before it has looked again.
  assert.equal(await watch.runtimeEnded(), false);
  await watch.snapshot();
  assert.equal(await watch.runtimeEnded(), true);

  // A runtime that was never seen is not taken for dead: nothing is known.
  const unseen = watchOver(makeFakeProcessTable(measuredLayout().filter((proc) => proc.processId !== RUNTIME)));
  await unseen.watch.snapshot();
  assert.equal(await unseen.watch.runtimeEnded(), false);

  // Its pid in the hands of another process: ended.
  const reused = makeFakeProcessTable(measuredLayout());
  const other = watchOver(reused);
  reused.end(RUNTIME);
  reused.add({ processId: RUNTIME, parentProcessId: 7000, createdAt: 900, name: 'backup' });
  await other.watch.snapshot();
  assert.equal(await other.watch.runtimeEnded(), true);
});

test('a command start is looked at once it can be there, and once more', async () => {
  const fake = makeFakeProcessTable(measuredLayout().filter((proc) => ![4200, 4201].includes(proc.processId)));
  const { watch } = watchOver(fake, { commandLooksMs: [1, 2] });
  assert.deepEqual(await watch.latest(), { count: 0, commands: 0 });

  fake.add({ processId: 4200, parentProcessId: RUNTIME, createdAt: 400, name: 'bash', sessionLeader: true });
  watch.commandStarting();
  // A second command that starts while the looks are due adds none.
  watch.commandStarting();

  const lists = fake.listCount();
  for (let i = 0; i < 1_000 && fake.listCount() < lists + 2; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
  assert.equal(fake.listCount(), lists + 2);
  assert.deepEqual(watch.members().map((proc) => proc.processId), [4200]);
  watch.close();
});

test('the tree of a busy runtime is read again and again, that of an idle one is not', async () => {
  const fake = makeFakeProcessTable(measuredLayout());
  let busy = false;
  const { watch } = watchOver(fake, { pollMs: 1, isBusy: () => busy });
  await watch.latest();
  const lists = fake.listCount();

  await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.equal(fake.listCount(), lists, 'an idle runtime is not read');

  busy = true;
  for (let i = 0; i < 1_000 && fake.listCount() < lists + 2; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
  assert.ok(fake.listCount() >= lists + 2);
  watch.close();
});
