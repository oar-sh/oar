// `oar stop` and `oar restart` on Windows end the relay's whole process tree
// (server/services/windows-relay-process-tree.mjs). The platform is injected
// ('win32'); the process list, taskkill, schtasks and the relay are fakes, so
// no process of the host is listed or touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { runRestart, runStop } from '../bin/oar.js';
import { hashOwnerToken } from '../shared/relay-credentials.mjs';

const CONFIG = { port: 4100, localhostOnly: true, pollIntervalMs: 3000 };
const NODE = '"C:\\Program Files\\nodejs\\node.exe"';

// An install of the global layout with a relay that ran once, and the host
// it runs on: the process list (`processes`), what taskkill and schtasks were
// asked (`calls`), and one log of the lines and questions in their order.
function makeHost(t, { platform = 'win32' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-cli-windows-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const packageRoot = path.join(root, 'pkg');
  const serverDir = path.join(packageRoot, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const stateRoot = path.join(root, 'state');
  const dataDir = path.join(stateRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'config.json'), JSON.stringify(CONFIG));
  fs.writeFileSync(path.join(dataDir, 'relay-secrets.json'), JSON.stringify({
    version: 1,
    owner: { hash: hashOwnerToken('old-token'), createdAt: '2026-01-01T00:00:00.000Z', rotatedAt: null, legacyPlaintext: false },
    agentKey: crypto.randomBytes(32).toString('base64url'),
  }));
  const host = {
    root, packageRoot, serverDir, dataDir,
    processes: [],
    calls: [],
    log: [],
    listReads: 0,
    // Pids taskkill cannot end: they outlive a kill it takes (`survivors`), or it refuses (`denied`).
    survivors: new Set(),
    denied: new Set(),
    // Called after each taskkill or schtasks call, with its arguments.
    onCall: null,
    bootTask: 'missing',
  };
  host.writeLock = (pid) => fs.writeFileSync(path.join(dataDir, 'relay-server.lock'), JSON.stringify({ pid, startedAt: '2026-11-16T10:00:00.000Z', format: 2 }));
  host.output = () => host.log.filter((entry) => !entry.startsWith('? ')).join('\n');
  host.pids = () => host.processes.map((proc) => proc.processId);
  host.killed = () => host.calls.filter((call) => /taskkill(\.exe)?$/i.test(call[0])).map((call) => Number(call[2]));
  host.remove = (...pids) => { host.processes = host.processes.filter((proc) => !pids.includes(proc.processId)); };
  host.spawnSyncImpl = (command, args = []) => {
    const call = [command, ...args];
    if (/taskkill(\.exe)?$/i.test(command)) {
      host.calls.push(call);
      assert.ok(!args.some((arg) => /^\/t$/i.test(arg)), 'never taskkill /T');
      const pid = Number(args[1]);
      if (host.denied.has(pid)) return { status: 1, stdout: '', stderr: `ERROR: The process with PID ${pid} could not be terminated.\r\nReason: Access is denied.\r\n` };
      if (!host.survivors.has(pid)) host.remove(pid);
      host.onCall?.(call);
      return { status: 0 };
    }
    if (/schtasks(\.exe)?$/i.test(command)) {
      host.calls.push(call);
      return host.onCall?.(call) || { status: 0 };
    }
    return { status: 1 };
  };
  host.processListImpl = {
    list: async () => {
      host.listReads += 1;
      return host.processes.map((proc) => ({ ...proc }));
    },
  };
  host.options = (overrides = {}) => ({
    packageRoot,
    homeDir: path.join(root, 'home'),
    cwd: path.join(root, 'home'),
    platform,
    env: { OAR_STATE_ROOT: stateRoot, LOCALAPPDATA: path.join(root, 'localappdata'), SystemRoot: path.join(root, 'Windows'), PATH: '' },
    logger: { log: (line) => host.log.push(String(line)), error: (line) => host.log.push(String(line)) },
    stdin: { isTTY: false },
    stdout: { isTTY: false },
    prompter: { line: async () => '', yesNo: async (question) => { host.log.push(`? ${question}`); return true; } },
    nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
    readFileImpl: () => { throw new Error('ENOENT'); },
    isPortFreeImpl: async () => true,
    isProcessAliveImpl: () => false,
    spawnSyncImpl: host.spawnSyncImpl,
    spawnImpl: () => { throw new Error('no detached start expected'); },
    processListImpl: host.processListImpl,
    // Autostart as the host has it: no sign-in entry, the boot task as `bootTask` says.
    windowsAutostartImpl: { getState: () => ({ enabled: false }), listEntries: () => [] },
    windowsBootAutostartImpl: { getState: async () => ({ taskStatus: host.bootTask }) },
    qrImpl: async () => null,
    interfaces: {},
    readyWaitMs: 200,
    pollMs: 2,
    restartWaitMs: 200,
    stopWaitMs: 150,
    treeWaitMs: 150,
    lockSettleMs: 40,
    lockGraceMs: 10,
    ...overrides,
  });
  return host;
}

function proc(processId, parentProcessId, commandLine, createdAt) {
  return { processId, parentProcessId, name: 'node.exe', commandLine, createdAt };
}

// This install's relay (supervisor 101, runtime 102 named by the lock, two
// workers, an agent CLI under one of them) and a foreign worker with a
// similar command line, of another checkout.
function seedRelay(host) {
  const at = Date.now() - 60_000;
  const { serverDir } = host;
  host.processes = [
    proc(101, 100, `${NODE} "${path.join(serverDir, 'server.js')}"`, at),
    proc(102, 101, `${NODE} "${path.join(serverDir, 'server.js')}" --relay-runtime`, at + 10),
    proc(110, 555, `${NODE} ${path.join(serverDir, 'claude-worker', 'claude-session-worker.mjs')} --session-id aaaa-1`, at + 20),
    proc(111, 556, `${NODE} ${path.join(serverDir, 'grok-worker', 'grok-session-worker.mjs')} --session-id bbbb-2`, at + 30),
    proc(112, 110, 'claude.exe --print', at + 40),
    proc(202, 1, `${NODE} ${path.join(host.root, 'pkg2', 'server', 'claude-worker', 'claude-session-worker.mjs')} --session-id cccc-3`, at + 50),
  ];
  host.writeLock(102);
}

// The relay over HTTP: its status answers while `running`; a stop that it
// takes (`exits`) ends its supervisor and runtime as the real one does.
function fakeRelay(host, { busy = false, exits = true, refuse = false } = {}) {
  const relay = { running: true, shutdowns: [] };
  relay.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (!relay.running || Number(target.port) !== CONFIG.port) throw new Error('connect ECONNREFUSED');
    if (target.pathname === '/api/status') {
      return { ok: true, json: async () => ({ cliOnline: false, localhostOnly: true, relayShutdown: { status: busy ? 'queued' : 'idle' }, remotePath: '' }) };
    }
    if (target.pathname === '/api/relay/shutdown') {
      const body = JSON.parse(options.body);
      relay.shutdowns.push(body);
      host.log.push(`shutdown restart=${body.restart} immediate=${Boolean(body.immediate)}`);
      // `refuse`: the status it answers with, or 'drop' for no answer at all.
      if (refuse === 'drop') throw new Error('socket hang up');
      if (refuse) return { ok: false, status: refuse, json: async () => ({ code: 'AUTH_PERSON_REQUIRED' }) };
      if (busy && !body.immediate) return { ok: true, json: async () => ({ ok: true, queue: { processingCount: 1 } }) };
      if (!body.restart && exits) {
        relay.running = false;
        host.remove(101, 102);
      }
      return { ok: true, json: async () => ({ ok: true, queue: {} }) };
    }
    return { ok: false, status: 404 };
  };
  return relay;
}

test('Windows oar stop: the relay stops itself, then its session workers and what they run are ended; a foreign worker stays', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host);
  assert.deepEqual(await runStop(host.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'stopped' });
  assert.deepEqual(relay.shutdowns.map((body) => body.restart), [false]);
  // The supervisor and the runtime ended by themselves; the workers, then the CLI under one.
  assert.deepEqual(host.killed(), [110, 111, 112]);
  assert.deepEqual(host.pids(), [202], 'the other checkout\'s worker still runs');
  assert.deepEqual(host.calls.map((call) => call.slice(1)), [['/PID', '110', '/F'], ['/PID', '111', '/F'], ['/PID', '112', '/F']]);
  assert.match(host.output(), /also ends the relay's session workers/);
  assert.match(host.output(), /The relay is stopped, with its session workers\./);
});

test('Windows oar stop --now: the line about the workers comes before the question; supervisor, runtime, workers, descendants in that order', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  // The relay takes the stop but its processes hang on.
  const relay = fakeRelay(host, { exits: false });
  const result = await runStop(host.options({ argv: ['--now'], stdin: { isTTY: true }, fetchImpl: relay.fetch }));
  assert.deepEqual(result, { code: 0, reason: 'stopped' });
  const lineAt = host.log.findIndex((entry) => /also ends the relay's session workers/.test(entry));
  const questionAt = host.log.indexOf('? Stop the relay now? Running turns are cut off.');
  assert.ok(lineAt >= 0 && questionAt > lineAt, 'said before the confirmation');
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112]);
  assert.deepEqual(host.pids(), [202]);
});

test('Windows oar stop of a busy relay: queued as before, nothing is ended', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host, { busy: true });
  assert.deepEqual(await runStop(host.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'stop-queued' });
  assert.deepEqual(host.killed(), []);
  assert.match(host.output(), /The relay is still busy; it stops by itself when its running turns finish/);
  assert.match(host.output(), /Its session workers keep running then/);
});

test('Windows oar stop of a relay that does not answer while its processes run: swept after the --now confirmation', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const silent = async () => { throw new Error('connect ECONNREFUSED'); };
  // No terminal and no --yes: refused, nothing ended.
  assert.deepEqual(await runStop(host.options({ fetchImpl: silent })), { code: 1, reason: 'needs-yes' });
  assert.deepEqual(host.killed(), []);
  assert.match(host.output(), /The relay does not answer, but processes of it run \(supervisor 101, runtime 102, 2 session workers\)\./);

  host.log.length = 0;
  assert.deepEqual(await runStop(host.options({ argv: ['--yes'], fetchImpl: silent })), { code: 0, reason: 'stopped' });
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112]);
  assert.deepEqual(host.pids(), [202]);
});

test('Windows oar stop with nothing of this install running: not running, a foreign worker untouched', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.remove(101, 102, 110, 111, 112);
  const silent = async () => { throw new Error('connect ECONNREFUSED'); };
  assert.deepEqual(await runStop(host.options({ fetchImpl: silent })), { code: 0, reason: 'not-running' });
  assert.deepEqual(host.calls, []);
});

test('Windows oar stop: a process that outlives taskkill hits the bound: exit 1, the pids left and their taskkill lines', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.survivors.add(111);
  const relay = fakeRelay(host);
  assert.deepEqual(await runStop(host.options({ fetchImpl: relay.fetch })), { code: 1, reason: 'processes-left' });
  assert.match(host.output(), /Not every process of the relay ended within \d+ s\. End these yourself:/);
  assert.match(host.output(), /taskkill \/PID 111 \/F {3}\(a session worker\)/);
  assert.doesNotMatch(host.output(), /The relay is stopped/);
});

test('Windows oar stop beside another relay of the same folder: its workers are listed, not ended; a warning, no error', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const at = Date.now() - 30_000;
  host.processes.push(
    proc(301, 300, `${NODE} "${path.join(host.serverDir, 'server.js')}" --relay-runtime`, at),
    proc(302, 1, `${NODE} ${path.join(host.serverDir, 'claude-worker', 'claude-session-worker.mjs')} --session-id ffff-6`, at + 1),
  );
  const relay = fakeRelay(host, { exits: false });
  assert.deepEqual(await runStop(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch })), { code: 0, reason: 'stopped' });
  // The lock ties the supervisor and the runtime to this install.
  assert.deepEqual(host.killed(), [101, 102]);
  assert.match(host.output(), /Warning: another relay runs from this folder \(process 301\)/);
  for (const pid of [110, 111, 302]) assert.match(host.output(), new RegExp(`taskkill /PID ${pid} /F`));
});

test('Windows oar stop: a process list that cannot be read changes nothing', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host);
  const result = await runStop(host.options({ fetchImpl: relay.fetch, processListImpl: { list: async () => { throw new Error('powershell.exe not found'); } } }));
  assert.deepEqual(result, { code: 1, reason: 'process-list-unreadable' });
  assert.deepEqual(relay.shutdowns, []);
  assert.deepEqual(host.calls, []);
});

// A new relay of this install comes up (the boot task, or a background start):
// a new supervisor and runtime, started now, which the lock names.
function startNewRelay(host, relay) {
  const at = Date.now();
  const server = path.join(host.serverDir, 'server.js');
  host.processes.push(proc(401, 400, `${NODE} "${server}"`, at), proc(402, 401, `${NODE} "${server}" --relay-runtime`, at + 1));
  host.writeLock(402);
  relay.running = true;
  host.log.push('started');
}

const ours = [101, 102, 110, 111, 112];

test('Windows oar restart without --now: the queued runtime restart as before, saying the supervisor and the workers keep running', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host);
  assert.deepEqual(await runRestart(host.options({ fetchImpl: relay.fetch })), { code: 0, reason: 'restarted' });
  assert.deepEqual(relay.shutdowns.map((body) => [body.restart, Boolean(body.immediate)]), [[true, false]]);
  assert.deepEqual(host.calls, [], 'nothing ended, nothing started through the task');
  assert.match(host.output(), /On Windows this restarts the relay's runtime only; its supervisor and session workers keep running\. For a full restart: oar restart --now/);
});

test('Windows oar restart --now: stop, end the whole tree, wait until it is gone, then start through the boot task', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.bootTask = 'ready';
  const relay = fakeRelay(host, { exits: false });
  let leftAtStart = null;
  host.onCall = (call) => {
    if (call[1] !== '/run') return null;
    leftAtStart = host.pids().filter((pid) => ours.includes(pid));
    startNewRelay(host, relay);
    return { status: 0 };
  };
  const result = await runRestart(host.options({ argv: ['--now'], stdin: { isTTY: true }, fetchImpl: relay.fetch }));
  assert.deepEqual(result, { code: 0, reason: 'restarted' });
  const lineAt = host.log.findIndex((entry) => /also ends the relay's session workers/.test(entry));
  const questionAt = host.log.indexOf('? Restart the relay now? Running turns are cut off.');
  assert.ok(lineAt >= 0 && questionAt > lineAt, 'said before the confirmation');
  // A stop, so the supervisor starts no new runtime.
  assert.deepEqual(relay.shutdowns.map((body) => [body.restart, Boolean(body.immediate)]), [[false, true]]);
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112]);
  assert.deepEqual(host.calls.at(-1).slice(1), ['/run', '/tn', 'oar-relay'], 'the start comes after the last kill');
  assert.deepEqual(leftAtStart, [], 'nothing of the old relay ran when it started');
  assert.deepEqual(host.pids().sort(), [202, 401, 402]);
  assert.match(host.output(), /Started the relay through its scheduled task \\oar-relay\./);
  assert.match(host.output(), /The relay restarted\./);
});

test('Windows oar restart --now: a refused schtasks /run falls back to the background start, with one line', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.bootTask = 'ready';
  const relay = fakeRelay(host);
  host.onCall = (call) => (call[1] === '/run' ? { status: 1 } : null);
  const spawned = [];
  const spawnImpl = (command, args) => {
    spawned.push(args.at(-1));
    startNewRelay(host, relay);
    return { exitCode: null, unref() {} };
  };
  assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, spawnImpl })), { code: 0, reason: 'restarted' });
  assert.deepEqual(spawned, [path.join(host.serverDir, 'server.js')]);
  assert.match(host.output(), /The scheduled task \\oar-relay could not be started \(schtasks \/run was refused\); the relay starts in the background instead\./);
  assert.ok(host.log.indexOf('started') > host.log.findIndex((entry) => /schtasks \/run was refused/.test(entry)));
});

test('Windows oar restart --now without a boot task starts in the background, after the tree is gone', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host);
  let leftAtStart = null;
  const spawnImpl = () => {
    leftAtStart = host.pids().filter((pid) => ours.includes(pid));
    startNewRelay(host, relay);
    return { exitCode: null, unref() {} };
  };
  assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, spawnImpl })), { code: 0, reason: 'restarted' });
  assert.deepEqual(leftAtStart, []);
  assert.ok(!host.calls.some((call) => /schtasks/i.test(call[0])), 'no task to run');
});

test('Windows oar restart --now: the bound is hit: exit 1, the pids left, and no start', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.bootTask = 'ready';
  host.survivors.add(102);
  const relay = fakeRelay(host, { exits: false });
  assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch })), { code: 1, reason: 'processes-left' });
  assert.match(host.output(), /taskkill \/PID 102 \/F {3}\(the runtime\)/);
  assert.match(host.output(), /The relay is not started again while processes of it run\./);
  assert.ok(!host.calls.some((call) => /schtasks/i.test(call[0])), 'no start after the bound');
});

test('Windows oar restart --now: the boot task starts the relay again by itself mid-wait: it is never ended, and no second one starts', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.bootTask = 'ready';
  // The runtime ends slowly: its kill is taken, it is gone two reads later.
  host.survivors.add(102);
  const relay = fakeRelay(host, { exits: false });
  let reads = 0;
  host.onCall = (call) => {
    if (call[1] === '/run') throw new Error('no second start expected');
    // Once the workers are ended, the task's restart on failure comes.
    if (Number(call[2]) === 112) startNewRelay(host, relay);
    return null;
  };
  const list = host.processListImpl.list;
  const processListImpl = {
    list: async () => {
      reads += 1;
      if (host.killed().includes(112) && reads > 8) host.remove(102);
      return list();
    },
  };
  const result = await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, processListImpl }));
  assert.deepEqual(result, { code: 0, reason: 'restarted' });
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112], 'neither 401 nor 402 is ended');
  assert.deepEqual(host.pids().sort(), [202, 401, 402]);
  assert.match(host.output(), /Windows started the relay again by itself \(process 402\); no second one is started\./);
});

test('Windows oar restart --now: a pid handed to another process between the list and the kill is left alone', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host, { exits: false });
  host.onCall = (call) => {
    // Worker 111 ends as the runtime is ended, and its pid goes to another program.
    if (Number(call[2]) === 102) {
      host.remove(111);
      host.processes.push(proc(111, 1, 'C:\\Windows\\notepad.exe', Date.now() + 5));
    }
    return null;
  };
  const spawnImpl = () => { startNewRelay(host, relay); return { exitCode: null, unref() {} }; };
  assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, spawnImpl })), { code: 0, reason: 'restarted' });
  assert.deepEqual(host.killed(), [101, 102, 110, 112]);
  assert.ok(host.pids().includes(111), 'the program now at pid 111 runs on');
});

test('Windows oar restart of a relay that does not answer while its processes run: confirmed, swept, then started', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host);
  relay.running = false;
  const spawnImpl = () => { startNewRelay(host, relay); return { exitCode: null, unref() {} }; };
  assert.deepEqual(await runRestart(host.options({ fetchImpl: relay.fetch, spawnImpl })), { code: 1, reason: 'needs-yes' });
  assert.deepEqual(host.killed(), []);
  assert.deepEqual(await runRestart(host.options({ argv: ['--yes'], fetchImpl: relay.fetch, spawnImpl })), { code: 0, reason: 'restarted' });
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112]);
  assert.deepEqual(relay.shutdowns, [], 'nothing to ask');
});

test('on Linux oar restart never reads the process list nor ends a process', async (t) => {
  const host = makeHost(t, { platform: 'linux' });
  seedRelay(host);
  const relay = fakeRelay(host);
  const untouchable = { list: async () => { throw new Error('the Windows sweep was reached on linux'); } };
  for (const argv of [[], ['--now', '--yes']]) {
    assert.deepEqual(await runRestart(host.options({ argv, fetchImpl: relay.fetch, processListImpl: untouchable })), { code: 0, reason: 'restarted' });
  }
  assert.deepEqual(host.calls, []);
  assert.doesNotMatch(host.output(), /session workers|runtime only/);
});

const silent = async () => { throw new Error('connect ECONNREFUSED'); };

test('Windows oar stop while the runtime has crashed and the supervisor waits to start the next: the supervisor is ended first', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.remove(102);
  assert.deepEqual(await runStop(host.options({ argv: ['--yes'], fetchImpl: silent })), { code: 0, reason: 'stopped' });
  assert.deepEqual(host.killed(), [101, 110, 111, 112]);
  assert.match(host.output(), /processes of it run \(supervisor 101, 2 session workers\)/);
});

// A relaunched runtime that has not taken the lock yet: the lock names the one before.
function relaunchedRuntime(host) {
  host.remove(102);
  host.processes.push(proc(104, 101, `${NODE} "${path.join(host.serverDir, 'server.js')}" --relay-runtime`, Date.now() - 1000));
}

test('Windows oar stop while a runtime runs that the lock does not name: nothing is ended, every candidate is named, exit 1', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  relaunchedRuntime(host);
  assert.deepEqual(await runStop(host.options({ argv: ['--yes'], fetchImpl: silent })), { code: 1, reason: 'unclear' });
  assert.deepEqual(host.calls, []);
  assert.match(host.output(), /Can't tell this relay's processes apart; retry, or end them by hand\./);
  for (const [pid, kind] of [[101, 'the supervisor'], [104, 'the runtime'], [110, 'a session worker'], [111, 'a session worker']]) {
    assert.match(host.output(), new RegExp(`taskkill /PID ${pid} /F {3}\\(${kind}\\)`));
  }
  assert.doesNotMatch(host.output(), /The relay is stopped/);
});

test('Windows oar stop: a runtime that takes the lock within the wait is swept as this relay\'s', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  relaunchedRuntime(host);
  let reads = 0;
  const list = host.processListImpl.list;
  const processListImpl = { list: async () => { reads += 1; if (reads === 3) host.writeLock(104); return list(); } };
  assert.deepEqual(await runStop(host.options({ argv: ['--yes'], fetchImpl: silent, processListImpl, lockSettleMs: 2000 })), { code: 0, reason: 'stopped' });
  assert.deepEqual(host.killed(), [101, 104, 110, 111, 112]);
});

test('Windows oar restart while a runtime runs that the lock does not name: nothing is ended and nothing starts', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.bootTask = 'ready';
  relaunchedRuntime(host);
  assert.deepEqual(await runRestart(host.options({ argv: ['--yes'], fetchImpl: silent })), { code: 1, reason: 'unclear' });
  assert.deepEqual(host.calls, [], 'no taskkill, no schtasks /run');
  assert.match(host.output(), /The relay is not started again while processes of it run\./);
});

test('Windows oar stop of a relay started by a relative path (npm start): its supervisor is found through the lock-named runtime', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.processes[0] = proc(101, 100, 'node server/server.js', host.processes[0].createdAt);
  const relay = fakeRelay(host, { exits: false });
  assert.deepEqual(await runStop(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch })), { code: 0, reason: 'stopped' });
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112]);
});

test('Windows oar stop is no success while a server.js of this folder it did not end still runs', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.processes.push(proc(150, 1, `${NODE} "${path.join(host.serverDir, 'server.js')}"`, Date.now() - 5000));
  const relay = fakeRelay(host, { exits: false });
  assert.deepEqual(await runStop(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch })), { code: 1, reason: 'processes-left' });
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112]);
  assert.match(host.output(), /A server\.js of this relay that could not be told to be its own still runs\. End it yourself:/);
  assert.match(host.output(), /taskkill \/PID 150 \/F {3}\(the supervisor\)/);
  assert.doesNotMatch(host.output(), /The relay is stopped/);
});

test('Windows oar stop: a relay the boot task starts again meanwhile is not ended, and the stop is no success', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host, { exits: false });
  host.onCall = (call) => { if (Number(call[2]) === 112) startNewRelay(host, relay); return null; };
  assert.deepEqual(await runStop(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch })), { code: 1, reason: 'restarted-by-itself' });
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112]);
  assert.match(host.output(), /The relay started again by itself while it was stopped, so it is not stopped\./);
  assert.match(host.output(), /taskkill \/PID 402 \/F {3}\(the runtime\)/);
});

test('Windows oar restart --now: a relay started again before the sweep\'s first list is not ended, and is the start', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.bootTask = 'ready';
  const relay = fakeRelay(host);
  // As the old relay stops, the boot task starts the next one: in the
  // process list before the sweep reads it, created after the sweep began.
  const fetchImpl = async (url, options) => {
    const answer = await relay.fetch(url, options);
    if (new URL(String(url)).pathname === '/api/relay/shutdown') {
      const at = Date.now() + 60_000;
      const server = path.join(host.serverDir, 'server.js');
      host.processes.push(proc(401, 400, `${NODE} "${server}"`, at), proc(402, 401, `${NODE} "${server}" --relay-runtime`, at + 1));
      host.writeLock(402);
      relay.running = true;
    }
    return answer;
  };
  host.onCall = (call) => { if (call[1] === '/run') throw new Error('no second start expected'); return null; };
  assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl })), { code: 0, reason: 'restarted' });
  assert.deepEqual(host.killed(), [110, 111, 112], 'neither 401 nor 402 is ended');
  assert.deepEqual(host.pids().sort(), [202, 401, 402]);
  assert.match(host.output(), /Windows started the relay again by itself \(process 402\); no second one is started\./);
});

test('Windows oar restart --now after a refused stop (403, 500): refused as oar stop is; nothing ended, nothing started', async (t) => {
  for (const status of [403, 500]) {
    const host = makeHost(t);
    seedRelay(host);
    host.bootTask = 'ready';
    const relay = fakeRelay(host, { refuse: status });
    assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch })), { code: 1, reason: 'stop-refused' }, `status ${status}`);
    assert.deepEqual(host.calls, [], `status ${status}: no taskkill, no schtasks`);
    assert.match(host.output(), /The relay did not accept the stop request\./);
    // And `oar stop --now` answers the same.
    assert.deepEqual(await runStop(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch })), { code: 1, reason: 'stop-refused' });
    assert.deepEqual(host.calls, []);
  }
});

test('Windows oar restart --now when the stop request gets no answer: the tree is swept, then started', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const relay = fakeRelay(host, { refuse: 'drop' });
  host.onCall = (call) => { if (Number(call[2]) === 102) relay.running = false; return null; };
  let spawned = 0;
  const spawnImpl = () => { spawned += 1; startNewRelay(host, relay); return { exitCode: null, unref() {} }; };
  assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, spawnImpl })), { code: 0, reason: 'restarted' });
  assert.deepEqual(host.killed(), [101, 102, 110, 111, 112]);
  assert.equal(relay.shutdowns.length, 1);
  assert.equal(spawned, 1);
});

test('Windows: a taskkill that is refused is named at once with its reason; no 30 s wait for it, exit 1, no start', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.bootTask = 'ready';
  host.denied.add(111);
  const relay = fakeRelay(host);
  const startedAt = Date.now();
  assert.deepEqual(await runStop(host.options({ fetchImpl: relay.fetch, treeWaitMs: 30_000 })), { code: 1, reason: 'processes-left' });
  assert.ok(Date.now() - startedAt < 10_000, 'the bound was not waited for');
  assert.deepEqual(host.killed(), [110, 111, 112]);
  assert.match(host.output(), /taskkill could not end these, so they still run:/);
  assert.match(host.output(), /taskkill \/PID 111 \/F {3}\(a session worker\): ERROR: The process with PID 111 could not be terminated\. Reason: Access is denied\./);
  assert.doesNotMatch(host.output(), /Not every process of the relay ended|The relay is stopped/);

  host.log.length = 0;
  relay.running = true;
  seedRelay(host);
  assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, treeWaitMs: 30_000 })), { code: 1, reason: 'processes-left' });
  assert.ok(!host.calls.some((call) => /schtasks/i.test(call[0])), 'no start');
});

// The System32 path is what windowsSystemToolPath finds on disk, so this one
// runs where `path.win32` paths are the host's.
test('Windows oar stop calls taskkill by its full System32 path', { skip: process.platform !== 'win32' }, async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  const system32 = path.join(host.root, 'Windows', 'System32');
  fs.mkdirSync(system32, { recursive: true });
  fs.writeFileSync(path.join(system32, 'taskkill.exe'), '');
  const relay = fakeRelay(host);
  assert.equal((await runStop(host.options({ fetchImpl: relay.fetch }))).code, 0);
  assert.ok(host.calls.length > 0);
  for (const call of host.calls) assert.equal(call[0], path.join(system32, 'taskkill.exe'));
});

test('Windows: a process list that fails during the sweep is said, exit 1, and nothing is started', async (t) => {
  const host = makeHost(t);
  seedRelay(host);
  host.bootTask = 'ready';
  const relay = fakeRelay(host);
  const list = host.processListImpl.list;
  // It reads once to find the relay, then no more.
  let reads = 0;
  const processListImpl = { list: async () => { reads += 1; if (reads > 1) throw new Error('powershell.exe timed out'); return list(); } };
  assert.deepEqual(await runStop(host.options({ fetchImpl: relay.fetch, processListImpl })), { code: 1, reason: 'processes-left' });
  assert.match(host.output(), /The process list could not be read while the relay's processes were stopped \(powershell\.exe timed out\)/);

  reads = 0;
  relay.running = true;
  seedRelay(host);
  assert.deepEqual(await runRestart(host.options({ argv: ['--now', '--yes'], fetchImpl: relay.fetch, processListImpl })), { code: 1, reason: 'processes-left' });
  assert.ok(!host.calls.some((call) => /schtasks/i.test(call[0])), 'no start');
});

test('on macOS oar stop and oar restart never read the process list nor end a process', async (t) => {
  const host = makeHost(t, { platform: 'darwin' });
  seedRelay(host);
  const relay = fakeRelay(host);
  const untouchable = { list: async () => { throw new Error('the Windows sweep was reached on darwin'); } };
  for (const argv of [[], ['--now', '--yes']]) {
    assert.deepEqual(await runRestart(host.options({ argv, fetchImpl: relay.fetch, processListImpl: untouchable })), { code: 0, reason: 'restarted' });
    relay.running = true;
    assert.deepEqual(await runStop(host.options({ argv, fetchImpl: relay.fetch, processListImpl: untouchable })), { code: 0, reason: 'stopped' });
    relay.running = true;
  }
  assert.deepEqual(host.calls, []);
  assert.doesNotMatch(host.output(), /session workers|runtime only/);
});

test('on Linux oar stop never reads the process list nor ends a process', async (t) => {
  const host = makeHost(t, { platform: 'linux' });
  seedRelay(host);
  const relay = fakeRelay(host);
  const untouchable = { list: async () => { throw new Error('the Windows sweep was reached on linux'); } };
  for (const argv of [[], ['--now', '--yes']]) {
    relay.running = true;
    assert.deepEqual(await runStop(host.options({ argv, fetchImpl: relay.fetch, processListImpl: untouchable })), { code: 0, reason: 'stopped' });
  }
  assert.deepEqual(host.calls, []);
  assert.doesNotMatch(host.output(), /session workers/);
});
