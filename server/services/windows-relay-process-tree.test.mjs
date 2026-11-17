import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findRelayProcesses,
  isSameProcess,
  stopRelayProcesses,
  taskkillLine,
  waitRelayProcessesGone,
} from './windows-relay-process-tree.mjs';

// platform-agnostic: the module compares Windows paths as text (no `path`),
// so these drive-letter literals never reach the host's path semantics.
const SERVER_DIR = 'C:\\Users\\dev\\oar\\server';
const NODE = '"C:\\Program Files\\nodejs\\node.exe"';
const T0 = 1_700_000_000_000;

function proc(processId, parentProcessId, commandLine, createdAt) {
  return { processId, parentProcessId, name: 'node.exe', commandLine, createdAt };
}

// One relay of this install with two workers, one agent CLI and a tunnel,
// and the look-alikes that are not its own.
function hostList() {
  return [
    proc(100, 90, 'C:\\Windows\\System32\\cmd.exe /d /c "C:\\Users\\dev\\.oar\\oar-web-relay-launcher.cmd"', T0),
    proc(101, 100, `${NODE} "${SERVER_DIR}\\server.js"`, T0 + 10),
    proc(102, 101, `${NODE} --max-old-space-size=4096 "${SERVER_DIR}\\server.js" --relay-runtime`, T0 + 20),
    proc(103, 102, 'C:\\Users\\dev\\bin\\cloudflared.exe tunnel run', T0 + 30),
    // Workers: their cmd.exe ended, so their parent pid names no process.
    proc(110, 555, `${NODE} ${SERVER_DIR}\\claude-worker\\claude-session-worker.mjs --session-id aaaa-1`, T0 + 40),
    proc(111, 556, `${NODE} "${SERVER_DIR}\\grok-worker\\grok-session-worker.mjs" --session-id bbbb-2`, T0 + 50),
    proc(112, 110, 'C:\\Users\\dev\\.local\\bin\\claude.exe --print', T0 + 60),
    // Another checkout's relay and worker; a look-alike folder; a worker
    // script under another root; a process older than the parent pid it names.
    proc(200, 1, `${NODE} "C:\\Users\\dev\\oar2\\server\\server.js"`, T0),
    proc(201, 200, `${NODE} "C:\\Users\\dev\\oar2\\server\\server.js" --relay-runtime`, T0 + 1),
    proc(202, 1, `${NODE} C:\\Users\\dev\\oar2\\server\\claude-worker\\claude-session-worker.mjs --session-id cccc-3`, T0 + 2),
    proc(203, 1, `${NODE} C:\\Users\\dev\\xoar\\server\\claude-worker\\claude-session-worker.mjs --session-id dddd-4`, T0 + 3),
    proc(204, 110, 'C:\\Users\\dev\\tool.exe', T0 - 5),
    proc(205, 1, `${NODE} C:\\Users\\dev\\oar\\server-old\\claude-worker\\claude-session-worker.mjs --session-id eeee-5`, T0 + 4),
  ];
}

const kinds = (found) => found.targets.map((target) => `${target.kind}:${target.processId}`);

test('the lock names the runtime; its parent is the supervisor; workers and what they started follow, in that order', () => {
  const found = findRelayProcesses(hostList(), { serverDir: SERVER_DIR, lockPid: 102 });
  assert.equal(found.runtime.processId, 102);
  assert.equal(found.supervisor.processId, 101);
  assert.deepEqual(found.workers.map((worker) => worker.processId), [110, 111]);
  assert.equal(found.workersSkipped, false);
  assert.deepEqual(kinds(found), ['supervisor:101', 'runtime:102', 'worker:110', 'worker:111', 'descendant:103', 'descendant:112']);
});

test('a process of another folder, a look-alike folder or a pid older than its parent is never one of ours', () => {
  const found = findRelayProcesses(hostList(), { serverDir: SERVER_DIR, lockPid: 102 });
  const pids = found.targets.map((target) => target.processId);
  for (const foreign of [100, 200, 201, 202, 203, 204, 205]) assert.ok(!pids.includes(foreign), `process ${foreign} is not this install's`);
  // The other checkout's runtime runs another folder's server.js: no reason to skip the workers.
  assert.deepEqual(found.otherRuntimes, []);
});

test('paths compare without case and with either slash', () => {
  const list = [
    proc(1, 9, 'node c:/users/DEV/oar/server/server.js', T0),
    proc(2, 1, 'node C:/Users/dev/OAR/server/server.js --relay-runtime', T0 + 1),
    proc(3, 9, 'node c:/users/dev/oar/server/cursor-worker/cursor-session-worker.mjs --session-id x', T0 + 2),
  ];
  assert.deepEqual(kinds(findRelayProcesses(list, { serverDir: SERVER_DIR, lockPid: 2 })), ['supervisor:1', 'runtime:2', 'worker:3']);
});

test('a lock that names no runtime of this install ties nothing; workers are still found by their path', () => {
  // The lock names another checkout's runtime, then a process that is gone.
  for (const lockPid of [201, 999, 0]) {
    const found = findRelayProcesses(hostList(), { serverDir: SERVER_DIR, lockPid });
    assert.equal(found.runtime, null);
    assert.equal(found.supervisor, null);
    assert.equal(found.workersSkipped, true, 'the runtime 102 the lock does not name is another relay of this folder');
  }
  // A worker without --session-id is no session worker.
  const list = [proc(5, 1, `node ${SERVER_DIR}\\claude-worker\\claude-session-worker.mjs`, T0)];
  assert.deepEqual(findRelayProcesses(list, { serverDir: SERVER_DIR }).workers, []);
});

test('another runtime of this folder that the lock does not name: workers are listed, not stopped', () => {
  const list = [
    ...hostList(),
    // A scratch relay run from the same checkout with another data folder.
    proc(300, 1, `${NODE} "${SERVER_DIR}\\server.js"`, T0 + 70),
    proc(301, 300, `${NODE} "${SERVER_DIR}\\server.js" --relay-runtime`, T0 + 71),
    proc(302, 1, `${NODE} ${SERVER_DIR}\\claude-worker\\claude-session-worker.mjs --session-id ffff-6`, T0 + 72),
  ];
  const found = findRelayProcesses(list, { serverDir: SERVER_DIR, lockPid: 102 });
  assert.equal(found.workersSkipped, true);
  assert.deepEqual(found.otherRuntimes.map((other) => other.processId), [301]);
  assert.deepEqual(found.workers.map((worker) => worker.processId), [110, 111, 302]);
  // The lock still ties the supervisor and the runtime (and the runtime's tunnel) to this install.
  assert.deepEqual(kinds(found), ['supervisor:101', 'runtime:102', 'descendant:103']);
});

test('a process created when the sweep began or later is no leftover', () => {
  const list = [...hostList(), proc(120, 556, `${NODE} ${SERVER_DIR}\\claude-worker\\claude-session-worker.mjs --session-id gggg-7`, T0 + 1000)];
  const found = findRelayProcesses(list, { serverDir: SERVER_DIR, lockPid: 102, before: T0 + 1000 });
  assert.ok(!found.targets.some((target) => target.processId === 120));
  // The task started the relay again: its new runtime, though the lock names it, is not ended.
  const restarted = findRelayProcesses([
    proc(130, 100, `${NODE} "${SERVER_DIR}\\server.js"`, T0 + 2000),
    proc(131, 130, `${NODE} "${SERVER_DIR}\\server.js" --relay-runtime`, T0 + 2001),
  ], { serverDir: SERVER_DIR, lockPid: 131, before: T0 + 1500 });
  assert.deepEqual(restarted.targets, []);
});

test('under an outer supervisor the runtime is the --supervised server.js, with no supervisor of ours', () => {
  const list = [
    proc(10, 1, 'C:\\tools\\nssm.exe', T0),
    proc(11, 10, `${NODE} "${SERVER_DIR}\\server.js" --supervised`, T0 + 1),
  ];
  const found = findRelayProcesses(list, { serverDir: SERVER_DIR, lockPid: 11 });
  assert.deepEqual(kinds(found), ['runtime:11']);
});

test('a supervisor started by a relative path is the lock-named runtime\'s parent all the same', () => {
  const list = [
    proc(101, 90, 'node server/server.js', T0),
    proc(102, 101, `${NODE} "${SERVER_DIR}\\server.js" --relay-runtime`, T0 + 1),
  ];
  assert.deepEqual(kinds(findRelayProcesses(list, { serverDir: SERVER_DIR, lockPid: 102 })), ['supervisor:101', 'runtime:102']);
  // Not a node process, or one with --relay-runtime, or younger than the runtime: no supervisor.
  for (const parent of [
    { ...proc(101, 90, 'cmd.exe /c server.js', T0), name: 'cmd.exe' },
    proc(101, 90, 'node server/server.js --relay-runtime', T0),
    proc(101, 90, 'node server/server.js', T0 + 5),
  ]) {
    assert.equal(findRelayProcesses([parent, list[1]], { serverDir: SERVER_DIR, lockPid: 102 }).supervisor, null);
  }
});

test('with no runtime of the folder at all, its one server.js without a runtime child is the supervisor', () => {
  // The runtime crashed; the supervisor waits to start the next one.
  const list = hostList().filter((entry) => ![102, 103].includes(entry.processId));
  const found = findRelayProcesses(list, { serverDir: SERVER_DIR, lockPid: 102 });
  assert.equal(found.unclear, false);
  assert.deepEqual(kinds(found), ['supervisor:101', 'worker:110', 'worker:111', 'descendant:112']);
  // Two of them: which is this relay's is not known.
  const two = findRelayProcesses([...list, proc(150, 1, `${NODE} "${SERVER_DIR}\\server.js"`, T0 + 9)], { serverDir: SERVER_DIR, lockPid: 102 });
  assert.equal(two.unclear, true);
  assert.deepEqual(two.targets, []);
});

test('a runtime of the folder the lock does not name, with none it names: unclear, nothing to stop, every candidate listed', () => {
  // A relaunched runtime before it took the lock (the lock names the one that crashed).
  const list = [...hostList().filter((entry) => entry.processId !== 102), proc(104, 101, `${NODE} "${SERVER_DIR}\\server.js" --relay-runtime`, T0 + 80)];
  const found = findRelayProcesses(list, { serverDir: SERVER_DIR, lockPid: 102 });
  assert.equal(found.unclear, true);
  assert.deepEqual(found.targets, []);
  assert.deepEqual(found.candidates.map((entry) => `${entry.kind}:${entry.processId}`), ['supervisor:101', 'runtime:104', 'worker:110', 'worker:111']);
  // Known as another relay's (seen beside the runtime the lock named): not unclear, and its supervisor is not ours.
  const scratch = [proc(300, 1, `${NODE} "${SERVER_DIR}\\server.js"`, T0 + 70), proc(301, 300, `${NODE} "${SERVER_DIR}\\server.js" --relay-runtime`, T0 + 71)];
  const known = findRelayProcesses([...hostList().filter((entry) => ![101, 102].includes(entry.processId)), ...scratch], { serverDir: SERVER_DIR, lockPid: 102, foreign: [scratch[1]] });
  assert.equal(known.unclear, false);
  assert.deepEqual(known.ownServers, []);
  assert.equal(known.workersSkipped, true);
});

test('stop: kind by kind, the list read again before each kind; a pid given to another process is left alone', async () => {
  const found = findRelayProcesses(hostList(), { serverDir: SERVER_DIR, lockPid: 102 });
  let current = hostList();
  const reads = [];
  const killed = [];
  const list = async () => {
    reads.push(killed.length);
    // Between the first look and the kill of the workers, worker 111 ended
    // and its pid went to another program.
    if (killed.length === 2) current = current.map((entry) => (entry.processId === 111 ? proc(111, 1, 'C:\\Windows\\notepad.exe', T0 + 500) : entry));
    return current;
  };
  const kill = async (pid) => {
    killed.push(pid);
    current = current.filter((entry) => entry.processId !== pid);
  };
  const result = await stopRelayProcesses({ targets: found.targets, list, kill });
  assert.deepEqual(killed, [101, 102, 110, 103, 112]);
  assert.deepEqual(result, { killed: [101, 102, 110, 103, 112], skipped: [111], failed: [] });
  assert.deepEqual(reads, [0, 1, 2, 3], 'one fresh list before each kind');
  assert.ok(current.some((entry) => entry.processId === 111), 'the program now at pid 111 still runs');
});

test('stop: a kill that does not go through is failed, with its reason, not killed', async () => {
  const found = findRelayProcesses(hostList(), { serverDir: SERVER_DIR, lockPid: 102 });
  const list = async () => hostList();
  const kill = async (pid) => (pid === 102 ? { ok: false, reason: 'Access is denied.' } : pid === 111 ? false : { ok: true });
  const result = await stopRelayProcesses({ targets: found.targets, list, kill });
  assert.deepEqual(result.killed, [101, 110, 103, 112]);
  assert.deepEqual(result.failed.map((entry) => [entry.processId, entry.kind, entry.reason]), [[102, 'runtime', 'Access is denied.'], [111, 'worker', 'the kill failed']]);
});

test('wait: done once none of the targets runs; the same pid of a newer process is not one of them', async () => {
  const targets = [{ ...proc(101, 100, 'node server.js', T0), kind: 'supervisor' }];
  let calls = 0;
  const list = async () => {
    calls += 1;
    return calls < 3 ? [proc(101, 100, 'node server.js', T0)] : [proc(101, 1, 'node server.js', T0 + 99)];
  };
  const result = await waitRelayProcessesGone({ targets, list, waitMs: 1000, pollMs: 1, sleep: async () => {} });
  assert.deepEqual(result, { ok: true, left: [] });
  assert.equal(calls, 3);
});

test('wait: the bound is hit with the processes left', async () => {
  const targets = [{ ...proc(110, 1, 'worker', T0), kind: 'worker' }];
  let clock = 0;
  const result = await waitRelayProcessesGone({
    targets,
    list: async () => [proc(110, 1, 'worker', T0)],
    waitMs: 30_000,
    pollMs: 300,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.left.map((left) => left.processId), [110]);
  assert.ok(clock >= 30_000 && clock < 30_600, 'waited the bound, not longer');
  assert.equal(taskkillLine(110), 'taskkill /PID 110 /F');
});

test('isSameProcess: same pid and start time; without start times, the command line', () => {
  assert.equal(isSameProcess(proc(1, 0, 'a', T0), proc(1, 0, 'b', T0)), true);
  assert.equal(isSameProcess(proc(1, 0, 'a', T0), proc(1, 0, 'a', T0 + 1)), false);
  assert.equal(isSameProcess(proc(1, 0, 'a', 0), proc(1, 0, 'a', 0)), true);
  assert.equal(isSameProcess(proc(1, 0, 'a', 0), proc(1, 0, 'b', 0)), false);
  assert.equal(isSameProcess(proc(1, 0, 'a', T0), proc(2, 0, 'a', T0)), false);
});
