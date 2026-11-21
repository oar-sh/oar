import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  abortCliProcess,
  createCliChildWatch,
  isSdkCliChild,
  killWindowsProcessTree,
} from './claude-cli-process.mjs';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/** A ChildProcess as Node announces it: no pid and no arguments until it has spawned. */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = undefined;
  child.spawnargs = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.started = (pid, spawnargs) => {
    child.pid = pid;
    child.spawnargs = spawnargs;
    child.emit('spawn');
  };
  return child;
}

function fakeChannel() {
  const listeners = [];
  return {
    subscriptions: [],
    subscribe(name, listener) {
      this.subscriptions.push(name);
      listeners.push(listener);
    },
    announce(child) {
      for (const listener of listeners) listener({ process: child });
    },
  };
}

const CLI_ARGS = ['claude.exe', '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--resume', 'abc'];

test('a CLI the SDK started is told from other children by its stream-json input', () => {
  assert.equal(isSdkCliChild({ spawnargs: CLI_ARGS }), true);
  assert.equal(isSdkCliChild({ spawnargs: ['claude.exe', '--input-format=stream-json'] }), true);
  assert.equal(isSdkCliChild({ spawnargs: ['git', 'status'] }), false);
  assert.equal(isSdkCliChild({ spawnargs: ['claude.exe', '--output-format', 'stream-json'] }), false);
  assert.equal(isSdkCliChild({}), false);
  assert.equal(isSdkCliChild(null), false);
});

test('each query gets the CLI child announced after it, oldest first', () => {
  const channel = fakeChannel();
  const watch = createCliChildWatch({ channel });
  const first = watch.watch();
  assert.equal(first.pid(), null, 'nothing announced yet');

  // Another child of the worker is not the CLI.
  const other = fakeChild();
  channel.announce(other);
  other.started(11, ['git', 'status']);
  assert.equal(first.pid(), null);

  const cli = fakeChild();
  channel.announce(cli);
  assert.equal(first.pid(), null, 'announced, not yet spawned: no pid to trust');
  cli.started(4242, CLI_ARGS);
  assert.equal(first.pid(), 4242);

  const second = watch.watch();
  const nextCli = fakeChild();
  channel.announce(nextCli);
  nextCli.started(4343, CLI_ARGS);
  assert.equal(second.pid(), 4343);
  assert.equal(first.pid(), 4242, 'the first query keeps its own');
  assert.deepEqual(channel.subscriptions, ['child_process'], 'one subscription for the worker');

  // A process that has ended has no tree to end, and its pid may be reused.
  cli.exitCode = 0;
  assert.equal(first.pid(), null);
  nextCli.signalCode = 'SIGTERM';
  assert.equal(second.pid(), null);
});

test('a query whose CLI never appeared does not take a later one', () => {
  const channel = fakeChannel();
  let clock = 1_000;
  const watch = createCliChildWatch({ channel, now: () => clock });
  const stale = watch.watch();
  clock += 61_000;
  const fresh = watch.watch();
  const cli = fakeChild();
  channel.announce(cli);
  cli.started(555, CLI_ARGS);
  assert.equal(stale.pid(), null);
  assert.equal(fresh.pid(), 555);
});

test('without a diagnostics channel there is no pid', () => {
  const watch = createCliChildWatch({ channel: { subscribe() { throw new Error('no channel'); } } });
  assert.equal(watch.watch().pid(), null);
});

function fakeSpawn() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const killer = new EventEmitter();
    calls.push({ command, args, options, killer });
    return killer;
  };
  return { calls, spawnImpl };
}

test('the process tree is ended with taskkill, without a shell, the pid as a number', async () => {
  const { calls, spawnImpl } = fakeSpawn();
  const env = { SystemRoot: 'C:\\Windows' };
  const done = killWindowsProcessTree('4242', { spawnImpl, env });
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /taskkill(\.exe)?$/i);
  assert.deepEqual(calls[0].args, ['/PID', '4242', '/T', '/F']);
  assert.deepEqual(calls[0].options, { stdio: 'ignore', windowsHide: true });
  assert.ok(!('shell' in calls[0].options));
  calls[0].killer.emit('exit', 0);
  assert.equal(await done, true);
});

test('a failed or missing taskkill resolves false and never rejects', async () => {
  const failed = fakeSpawn();
  const one = killWindowsProcessTree(4242, { spawnImpl: failed.spawnImpl });
  failed.calls[0].killer.emit('exit', 128);
  assert.equal(await one, false);

  const missing = fakeSpawn();
  const two = killWindowsProcessTree(4242, { spawnImpl: missing.spawnImpl });
  missing.calls[0].killer.emit('error', new Error('ENOENT'));
  assert.equal(await two, false);

  assert.equal(await killWindowsProcessTree(4242, { spawnImpl: () => { throw new Error('EPERM'); } }), false);

  const hung = fakeSpawn();
  assert.equal(await killWindowsProcessTree(4242, { spawnImpl: hung.spawnImpl, timeoutMs: 20 }), false);
});

test('nothing is spawned for a pid that is not one', async () => {
  const { calls, spawnImpl } = fakeSpawn();
  for (const pid of [0, -5, 'abc', null, undefined, '12; calc.exe']) {
    assert.equal(await killWindowsProcessTree(pid, { spawnImpl }), false);
  }
  assert.equal(calls.length, 0);
});

function processRecord(cliPid) {
  const abortController = new AbortController();
  return { abortController, turn: cliPid === undefined ? {} : { cliPid: () => cliPid } };
}

test('on Windows the CLI is aborted after its process tree was ended', async () => {
  const order = [];
  const record = processRecord(4242);
  record.abortController.signal.addEventListener('abort', () => order.push('abort'));
  let release = null;
  abortCliProcess(record, {
    platform: 'win32',
    killTreeImpl: (pid) => new Promise((resolve) => {
      order.push(`tree ${pid}`);
      release = resolve;
    }),
  });
  await tick();
  assert.deepEqual(order, ['tree 4242'], 'the abort waits: a dead CLI no longer leads to its children');
  release(true);
  await tick();
  assert.deepEqual(order, ['tree 4242', 'abort']);
});

test('the abort still happens when ending the tree fails, and at once without a pid', async () => {
  const failing = processRecord(4242);
  const lines = [];
  abortCliProcess(failing, {
    platform: 'win32',
    killTreeImpl: async () => { throw new Error('boom'); },
    dbg: (...parts) => lines.push(parts.join(' ')),
  });
  await tick();
  assert.equal(failing.abortController.signal.aborted, true);
  assert.match(lines[0], /ending the CLI process tree failed boom/);

  for (const record of [processRecord(null), processRecord(undefined)]) {
    const said = [];
    abortCliProcess(record, {
      platform: 'win32',
      killTreeImpl: () => assert.fail('no pid, no tree kill'),
      dbg: (...parts) => said.push(parts.join(' ')),
    });
    assert.equal(record.abortController.signal.aborted, true, 'synchronously');
    assert.deepEqual(said, ['no pid known for the CLI; stopping it without its process tree']);
  }
});

test('elsewhere the abort is the SDK\'s alone, as before', () => {
  for (const platform of ['linux', 'darwin']) {
    const record = processRecord(4242);
    abortCliProcess(record, {
      platform,
      killTreeImpl: () => assert.fail('not on this platform'),
      dbg: () => assert.fail('nothing to say'),
    });
    assert.equal(record.abortController.signal.aborted, true, 'synchronously');
  }
});
