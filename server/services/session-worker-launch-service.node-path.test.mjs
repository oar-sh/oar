import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  appendNodeDirectoryToPath,
  buildTmuxWorkerShellCommand,
  describeWindowsStartFailure,
  launchSessionCli,
  locateExecutable,
  resolveWorkerNodeDirectory,
  resolveWorkerNodeExecutable,
} from './session-worker-launch-service.mjs';

// Which Node a worker runs on, the PATH it gets, and what a launch that does
// not come up says about itself. The platform is always injected.

const WIN_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const WIN_ENV = Object.freeze({
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  Path: 'C:\\Windows\\System32;C:\\Windows',
  COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
  COPILOT_WEB_RELAY_ROOT: 'C:\\Users\\dev\\oar',
});
const SESSION = 'abc12345-0000-4000-8000-000000000001';

// A child that reports how `cmd /c start` ended, the way node's ChildProcess
// does; `exit` undefined leaves it running.
function fakeStartChild({ exit, error } = {}) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  child.killed = 0;
  child.kill = () => { child.killed += 1; return true; };
  setImmediate(() => {
    if (error) child.emit('error', error);
    else if (exit !== undefined) child.emit('exit', exit, null);
  });
  return child;
}

function windowsLaunch({ env = {}, child = fakeStartChild({ exit: 0 }), found = null, locate = () => 'located', logs = [] } = {}) {
  const spawnCalls = [];
  const launched = launchSessionCli({
    targetSessionId: SESSION,
    processCwd: 'C:\\Users\\dev\\oar',
    workspaceRoot: 'C:\\Users\\dev\\repo',
    env: { ...WIN_ENV, ...env },
    platform: 'win32',
    allowProcessReuse: false,
    prepareOarMcpConfigImpl: () => null,
    prepareWorkerLogFileImpl: () => null,
    locateExecutableImpl: locate,
    processInspector: { async findProcessForSessionAsync() { return found; } },
    detachedPollAttempts: 2,
    detachedPollDelayMs: 1,
    windowsStartGraceMs: 0,
    log: (line) => logs.push(line),
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
  });
  return { launched, spawnCalls, logs };
}

// ─── Which Node ──────────────────────────────────────────────────────────────

test('a worker runs on the relay\'s own Node unless COPILOT_WEB_RELAY_NODE says otherwise', () => {
  assert.equal(resolveWorkerNodeExecutable({}), process.execPath);
  assert.equal(resolveWorkerNodeExecutable({}, { execPath: WIN_NODE }), WIN_NODE);
  assert.equal(resolveWorkerNodeExecutable({ COPILOT_WEB_RELAY_NODE: ' /opt/node/bin/node ' }), '/opt/node/bin/node');
});

test('the Node folder is the override\'s when it is a path, else the relay\'s', () => {
  assert.equal(resolveWorkerNodeDirectory({}, { platform: 'win32', execPath: WIN_NODE }), 'C:\\Program Files\\nodejs');
  assert.equal(resolveWorkerNodeDirectory({ COPILOT_WEB_RELAY_NODE: '/opt/node/bin/node' }, { platform: 'linux', execPath: '/usr/bin/node' }), '/opt/node/bin');
  assert.equal(resolveWorkerNodeDirectory({ COPILOT_WEB_RELAY_NODE: 'node' }, { platform: 'linux', execPath: '/usr/bin/node' }), '/usr/bin');
});

test('the win32 console launch starts the relay\'s Node by absolute path, a path with spaces as one argument', async () => {
  const { launched, spawnCalls } = windowsLaunch({ env: { COPILOT_WEB_RELAY_NODE: WIN_NODE }, found: { processId: process.pid } });
  assert.equal((await launched).pid, process.pid);
  assert.equal(spawnCalls[0].command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(spawnCalls[0].args, [
    '/d', '/s', '/c', 'start',
    'Claude Worker abc12345',
    WIN_NODE,
    path.join('C:\\Users\\dev\\oar', 'server', 'claude-worker', 'claude-session-worker.mjs'),
    '--session-id', SESSION,
  ]);
  // Node quotes an argument with a space for cmd.exe; it must not arrive pre-quoted.
  assert.ok(!spawnCalls[0].args.some((arg) => arg.startsWith('"')));
  assert.equal(spawnCalls[0].options.shell, undefined);
});

test('without an override the win32 launch uses process.execPath, never a bare node', async () => {
  const { launched, spawnCalls } = windowsLaunch({ found: { processId: process.pid } });
  await launched;
  assert.equal(spawnCalls[0].args[5], process.execPath);
});

// ─── PATH ────────────────────────────────────────────────────────────────────

test('the Node folder goes at the end of PATH, under the key PATH already has', () => {
  const env = appendNodeDirectoryToPath({ Path: 'C:\\Windows\\System32' }, 'C:\\Program Files\\nodejs', { platform: 'win32' });
  assert.deepEqual(Object.keys(env), ['Path'], 'no second PATH key next to Path');
  assert.equal(env.Path, 'C:\\Windows\\System32;C:\\Program Files\\nodejs');
  const posix = appendNodeDirectoryToPath({ PATH: '/usr/bin:' }, '/opt/node/bin', { platform: 'linux' });
  assert.equal(posix.PATH, '/usr/bin:/opt/node/bin');
  assert.equal(appendNodeDirectoryToPath({}, '/opt/node/bin', { platform: 'linux' }).PATH, '/opt/node/bin');
});

test('a PATH that already has the Node folder is left exactly as it is', () => {
  const env = { Path: 'C:\\PROGRAM FILES\\NODEJS\\;C:\\Windows' };
  assert.equal(appendNodeDirectoryToPath(env, 'C:\\Program Files\\nodejs', { platform: 'win32' }), env);
  const posix = { PATH: '/opt/node/bin/:/usr/bin' };
  assert.equal(appendNodeDirectoryToPath(posix, '/opt/node/bin', { platform: 'linux' }), posix);
  // Case matters away from Windows.
  assert.notEqual(appendNodeDirectoryToPath({ PATH: '/OPT/node/bin' }, '/opt/node/bin', { platform: 'linux' }).PATH, '/OPT/node/bin');
});

test('a worker started on win32 gets the Node folder at the end of its PATH', async () => {
  const { launched, spawnCalls } = windowsLaunch({ env: { COPILOT_WEB_RELAY_NODE: WIN_NODE }, found: { processId: process.pid } });
  await launched;
  const env = spawnCalls[0].options.env;
  assert.equal(env.Path, 'C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs');
  assert.equal(env.PATH, undefined);
});

test('the tmux command appends the Node folder to the login shell\'s PATH unless it is there', () => {
  const command = buildTmuxWorkerShellCommand('session-1', {
    COPILOT_WEB_RELAY_WORKER_KIND: 'grok',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_WEB_RELAY_NODE: '/opt/node 24/bin/node',
  });
  assert.ok(command.includes(`case ":$PATH:" in *:'/opt/node 24/bin':*) ;; *) PATH="$PATH:"'/opt/node 24/bin';; esac; export PATH; `));
  assert.ok(command.includes(`exec '/opt/node 24/bin/node' `));
  // The PATH line comes before the worker starts.
  assert.ok(command.indexOf('export PATH;') < command.indexOf('exec '));
});

// ─── Finding Node before the launch ──────────────────────────────────────────

function fakeFs(files) {
  return {
    statSync(candidate) {
      if (!files.includes(candidate)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => true };
    },
  };
}

test('locateExecutable looks a bare name up on PATH, with PATHEXT on Windows', () => {
  const winFs = fakeFs(['C:\\Program Files\\nodejs\\node.EXE']);
  const env = { Path: 'C:\\Windows;C:\\Program Files\\nodejs', PATHEXT: '.COM;.EXE' };
  assert.equal(locateExecutable('node', { env, platform: 'win32', fsImpl: winFs }), 'C:\\Program Files\\nodejs\\node.EXE');
  assert.equal(locateExecutable('node', { env: { Path: 'C:\\Windows' }, platform: 'win32', fsImpl: winFs }), null);
  const posixFs = fakeFs(['/opt/node/bin/node']);
  assert.equal(locateExecutable('node', { env: { PATH: '/usr/bin:/opt/node/bin' }, platform: 'linux', fsImpl: posixFs }), '/opt/node/bin/node');
  assert.equal(locateExecutable('/opt/node/bin/node', { env: {}, platform: 'linux', fsImpl: posixFs }), '/opt/node/bin/node');
  assert.equal(locateExecutable('/opt/other/node', { env: {}, platform: 'linux', fsImpl: posixFs }), null);
});

test('a Node that is not there fails the launch before anything is spawned, and the log says where it looked', async () => {
  const logs = [];
  const { launched, spawnCalls } = windowsLaunch({
    env: { COPILOT_WEB_RELAY_NODE: 'C:\\Users\\dev\\gone\\node.exe' },
    locate: () => null,
    logs,
  });
  await assert.rejects(launched, /^Error: worker-node-not-found: C:\\Users\\dev\\gone\\node\.exe \(set by COPILOT_WEB_RELAY_NODE\)$/);
  assert.equal(spawnCalls.length, 0);
  assert.equal(logs.length, 1);
  // The override's own folder was appended to the PATH it was looked up on.
  assert.match(logs[0], /^worker launcher: session=abc12345 cannot start: Node "C:\\Users\\dev\\gone\\node\.exe" \(COPILOT_WEB_RELAY_NODE\) was not found; PATH=C:\\Windows\\System32;C:\\Windows;C:\\Users\\dev\\gone SystemRoot=\(not set\) ComSpec=C:\\Windows\\System32\\cmd\.exe$/);
});

// ─── A start that does not come up ───────────────────────────────────────────

test('start ending with an error code fails the launch with the program named and the PATH logged', async () => {
  const { launched, logs } = windowsLaunch({ child: fakeStartChild({ exit: 9059 }) });
  await assert.rejects(launched, (error) => {
    assert.equal(error.message, `worker-spawn-failed: Windows could not start ${process.execPath} (start ended with exit code 9059)`);
    return true;
  });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes(`command: C:\\Windows\\System32\\cmd.exe /d /s /c start Claude Worker abc12345 ${process.execPath} `));
  assert.ok(logs[0].includes('PATH=C:\\Windows\\System32;C:\\Windows;'));
  assert.ok(logs[0].includes('ComSpec=C:\\Windows\\System32\\cmd.exe'));
});

test('start that never returns (a dialog no one sees) fails the launch and is killed', async () => {
  const child = fakeStartChild();
  const { launched } = windowsLaunch({ child });
  await assert.rejects(launched, /^Error: worker-spawn-failed: Windows could not start .* \(start did not return; it may be showing an error dialog\)$/);
  assert.equal(child.killed, 1);
});

test('cmd.exe that cannot run at all fails the launch', async () => {
  const error = Object.assign(new Error('spawn cmd.exe ENOENT'), { code: 'ENOENT' });
  const { launched } = windowsLaunch({ child: fakeStartChild({ error }) });
  await assert.rejects(launched, /^Error: worker-spawn-failed: could not run C:\\Windows\\System32\\cmd\.exe \(ENOENT\)$/);
});

test('start that returned 0 with no worker seen yet keeps the unknown pid, and says so in the log', async () => {
  const { launched, logs } = windowsLaunch({ child: fakeStartChild({ exit: 0 }) });
  const result = await launched;
  assert.equal(result.pid, null);
  assert.equal(result.launchMode, 'console');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /no worker process seen after 2 checks; it may still report in\. program: .* PATH=/);
});

test('a start that returns during the grace is not a failure', async () => {
  const child = new EventEmitter();
  child.unref = () => {};
  child.kill = () => assert.fail('not killed');
  setTimeout(() => child.emit('exit', 0, null), 60);
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: SESSION,
    processCwd: 'C:\\Users\\dev\\oar',
    env: { ...WIN_ENV },
    platform: 'win32',
    allowProcessReuse: false,
    prepareOarMcpConfigImpl: () => null,
    prepareWorkerLogFileImpl: () => null,
    locateExecutableImpl: () => 'located',
    processInspector: { async findProcessForSessionAsync() { return null; } },
    detachedPollAttempts: 1,
    detachedPollDelayMs: 1,
    windowsStartGraceMs: 2_000,
    spawnImpl(command, args) { spawnCalls.push({ command, args }); return child; },
  });
  assert.equal(launched.pid, null);
});

test('a worker found while start is still running is a success', async () => {
  const child = fakeStartChild();
  const { launched } = windowsLaunch({ child, found: { processId: process.pid } });
  assert.equal((await launched).pid, process.pid);
  assert.equal(child.killed, 0);
});

test('describeWindowsStartFailure stays silent when nothing reports the outcome', () => {
  assert.equal(describeWindowsStartFailure({ tracked: false }), null);
  assert.equal(describeWindowsStartFailure({ tracked: true, exited: true, code: 0 }), null);
  assert.match(describeWindowsStartFailure({ tracked: true, exited: true, code: null, signal: 'SIGTERM' }, { program: 'gh' }), /could not start gh \(start ended with signal SIGTERM\)/);
});

test('a POSIX spawn without a pid names the command and the reason', async () => {
  const logs = [];
  const child = new EventEmitter();
  child.unref = () => {};
  // A POSIX Node, not the host's: on a Windows host process.execPath has no
  // POSIX folder, and the launch is POSIX here whatever runs the test.
  const posixNode = '/home/dev/node/bin/node';
  const launched = launchSessionCli({
    targetSessionId: SESSION,
    cwd: '/home/dev/repo',
    env: {
      PATH: '/home/dev/bin',
      COPILOT_WEB_RELAY_NODE: posixNode,
      COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
      COPILOT_WEB_RELAY_ROOT: '/home/dev/oar',
    },
    platform: 'linux',
    allowProcessReuse: false,
    execFileSyncImpl() { throw new Error('no tmux'); },
    locateExecutableImpl: () => 'located',
    log: (line) => logs.push(line),
    spawnImpl() {
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    },
  });
  await assert.rejects(launched, /^Error: worker-spawn-unhealthy:missing-pid \(\/home\/dev\/node\/bin\/node: ENOENT\)$/);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].endsWith(`could not start ${posixNode} (ENOENT); PATH=/home/dev/bin:/home/dev/node/bin`), logs[0]);
});
