import test from 'node:test';
import assert from 'node:assert/strict';

import { launchSessionCli } from './session-worker-launch-service.mjs';
import { createWorkerScope, WORKER_SCOPE_PREFIX } from './worker-scope.mjs';

const USER_UNIT = { systemd: true, userManager: true, unit: 'oar.service' };
const SUPERVISOR = 4321;

// systemctl and systemd-run of a user manager whose oar.service has the
// supervisor as its main process. Never a real one.
function userManager({ mainPid = SUPERVISOR, probe = { status: 0 } } = {}) {
  const calls = [];
  const impl = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'systemctl') return { status: 0, stdout: `${mainPid}\n` };
    if (command === 'systemd-run') {
      if (probe instanceof Error) throw probe;
      return probe;
    }
    throw new Error(`unexpected ${command}`);
  };
  return { calls, impl };
}

function scope(options = {}) {
  const logs = [];
  const manager = userManager(options);
  const workerScope = createWorkerScope({
    hosting: 'hosting' in options ? options.hosting : USER_UNIT,
    spawnSyncImpl: manager.impl,
    parentPid: SUPERVISOR,
    log: (line) => logs.push(line),
  });
  return { workerScope, logs, calls: manager.calls };
}

test('under a user service a worker launch goes through systemd-run --user --scope, decided once', () => {
  const { workerScope, logs, calls } = scope();
  assert.deepEqual(workerScope.wrap('tmux', ['new-session', '-d']), { command: 'systemd-run', args: [...WORKER_SCOPE_PREFIX, 'tmux', 'new-session', '-d'] });
  assert.deepEqual(WORKER_SCOPE_PREFIX, ['--user', '--scope', '--collect', '--quiet', '--']);
  assert.deepEqual(workerScope.wrap('node', ['worker.mjs']).args.slice(-2), ['node', 'worker.mjs']);
  assert.equal(workerScope.inUse(), true);
  assert.deepEqual(calls, [
    'systemctl --user show -p MainPID --value oar.service',
    'systemd-run --user --scope --collect --quiet -- true',
  ]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /scopes of their own/);
});

test('asked before any worker starts, inUse decides once, and the launch reuses the answer', () => {
  const { workerScope, calls } = scope();
  assert.equal(workerScope.inUse(), true);
  assert.equal(workerScope.inUse(), true);
  assert.equal(workerScope.wrap('tmux', ['new-session']).command, 'systemd-run');
  assert.equal(calls.length, 2, 'one MainPID read and one probe');
  // A system service never gets scopes, and asks nothing.
  const system = scope({ hosting: { systemd: true, userManager: false, unit: 'oar.service' } });
  assert.equal(system.workerScope.inUse(), false);
  assert.deepEqual(system.calls, []);
});

test('systemd-run missing or without a bus: plain launches, one log line, no retry', () => {
  const missing = Object.assign(new Error('spawnSync systemd-run ENOENT'), { code: 'ENOENT' });
  for (const probe of [{ status: null, error: missing }, missing, { status: 1, stderr: 'Failed to connect to bus: No such file or directory\n' }]) {
    const { workerScope, logs, calls } = scope({ probe });
    assert.deepEqual(workerScope.wrap('tmux', ['new-session']), { command: 'tmux', args: ['new-session'] });
    assert.deepEqual(workerScope.wrap('tmux', ['new-session']), { command: 'tmux', args: ['new-session'] });
    assert.equal(workerScope.inUse(), false);
    assert.equal(calls.length, 2, 'asked once');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /without a scope of their own \(systemd-run: (ENOENT|status 1: Failed to connect to bus)/);
  }
});

test('a relay that is not the service\'s own (inside a worker of it) gets no scopes', () => {
  const { workerScope, logs, calls } = scope({ mainPid: 999 });
  assert.deepEqual(workerScope.wrap('tmux', ['new-session']), { command: 'tmux', args: ['new-session'] });
  assert.deepEqual(calls, ['systemctl --user show -p MainPID --value oar.service'], 'no systemd-run');
  assert.match(logs[0], /is not this relay's service/);
});

test('not under a user service: launches as they are, and nothing is asked', () => {
  for (const hosting of [null, { systemd: false }, { systemd: true, userManager: false, unit: 'oar.service' }]) {
    const { workerScope, logs, calls } = scope({ hosting });
    assert.deepEqual(workerScope.wrap('copilot', ['--session-id', 'x']), { command: 'copilot', args: ['--session-id', 'x'] });
    assert.deepEqual(calls, []);
    assert.deepEqual(logs, []);
  }
});

// launchSessionCli with tmux: answers -V, has-session (none), new-session,
// list-panes (the pane), all through the fake.
function fakeTmux() {
  const calls = [];
  const execFileSyncImpl = (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    const tmuxArgs = command === 'systemd-run' ? args.slice(WORKER_SCOPE_PREFIX.length + 1) : args;
    if (command !== 'tmux' && !(command === 'systemd-run' && args[WORKER_SCOPE_PREFIX.length] === 'tmux')) throw new Error(`unexpected ${command}`);
    if (tmuxArgs[0] === '-V') return Buffer.from('tmux 3.6');
    if (tmuxArgs[0] === 'has-session') throw Object.assign(new Error('missing'), { status: 1 });
    if (tmuxArgs[0] === 'list-panes') return Buffer.from(`${process.pid}\n`);
    if (tmuxArgs[0] === 'new-session') return Buffer.alloc(0);
    throw new Error(`unexpected tmux ${tmuxArgs.join(' ')}`);
  };
  return { calls, execFileSyncImpl };
}

const LAUNCH = {
  targetSessionId: 'abc-123',
  processCwd: '/relay',
  workspaceRoot: '/repo',
  platform: 'linux',
  tmuxPollAttempts: 1,
  tmuxPollDelayMs: 1,
  prepareOarMcpConfigImpl: () => null,
  allowProcessReuse: false,
  processInspector: { findProcessForSessionAsync: () => ({ processId: process.pid, commandLine: 'copilot --session-id abc-123' }) },
};

test('a tmux worker starts its tmux through systemd-run; only new-session is wrapped, and no secret reaches its env', async () => {
  const tmux = fakeTmux();
  const { workerScope } = scope();
  const launched = await launchSessionCli({
    ...LAUNCH,
    env: { PATH: '/usr/bin', COPILOT_PROVIDER_API_KEY: 'sk-secret-value', XDG_RUNTIME_DIR: '/run/user/1000' },
    execFileSyncImpl: tmux.execFileSyncImpl,
    createSecretEnvFileImpl: () => ({ filePath: '/tmp/oar-test/provider.env', cleanup() {} }),
    workerScope,
  });
  assert.equal(launched.launchMode, 'tmux');
  const wrapped = tmux.calls.filter((call) => call.command === 'systemd-run');
  assert.equal(wrapped.length, 1);
  assert.deepEqual(wrapped[0].args.slice(0, WORKER_SCOPE_PREFIX.length + 2), [...WORKER_SCOPE_PREFIX, 'tmux', 'new-session']);
  assert.ok(tmux.calls.filter((call) => call.command === 'tmux').every((call) => call.args[0] !== 'new-session'));
  assert.equal(wrapped[0].env.COPILOT_PROVIDER_API_KEY, undefined);
  assert.equal(wrapped[0].env.XDG_RUNTIME_DIR, '/run/user/1000', 'systemd-run finds the user bus');
  assert.doesNotMatch(wrapped[0].args.join(' '), /sk-secret-value/);
});

test('without a worker scope the tmux call is as before', async () => {
  const tmux = fakeTmux();
  await launchSessionCli({ ...LAUNCH, env: { PATH: '/usr/bin' }, execFileSyncImpl: tmux.execFileSyncImpl });
  assert.equal(tmux.calls.find((call) => call.args[0] === 'new-session')?.command, 'tmux');
  assert.ok(!tmux.calls.some((call) => call.command === 'systemd-run'));
});

test('a detached worker is spawned through systemd-run, its pid the worker\'s; a plain scope spawns it as it is', async () => {
  for (const [workerScope, expected] of [
    [scope().workerScope, (command, args) => ({ command: 'systemd-run', args: [...WORKER_SCOPE_PREFIX, command, ...args] })],
    [scope({ probe: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }).workerScope, (command, args) => ({ command, args })],
  ]) {
    const spawned = [];
    const launched = await launchSessionCli({
      ...LAUNCH,
      env: { PATH: process.env.PATH || '' },
      execFileSyncImpl: (command) => { throw new Error(`no ${command}`); },
      processInspector: { findProcessForSessionAsync: () => null },
      spawnImpl: (command, args, options) => { spawned.push({ command, args, options }); return { pid: 4242, unref() {} }; },
      workerScope,
    });
    assert.equal(launched.launchMode, 'detached');
    assert.equal(launched.pid, 4242);
    assert.deepEqual({ command: spawned[0].command, args: spawned[0].args }, expected('copilot', ['--allow-all', '--session-id', 'abc-123']));
    assert.equal(spawned[0].options.detached, true);
  }
});

test('on win32 a worker scope is never used', async () => {
  const workerScope = { wrap: () => { throw new Error('wrapped on win32'); }, inUse: () => true };
  const spawned = [];
  await launchSessionCli({
    ...LAUNCH,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows' },
    execFileSyncImpl: (command) => { throw new Error(`no ${command}`); },
    processInspector: { findProcessForSessionAsync: () => ({ processId: process.pid, commandLine: 'copilot --session-id abc-123' }) },
    spawnImpl: (command, args, options) => { spawned.push({ command, args, options }); return { pid: 1, unref() {}, once() {}, on() {} }; },
    detachedPollAttempts: 1,
    detachedPollDelayMs: 1,
    windowsStartGraceMs: 0,
    workerScope,
  }).catch(() => null);
  assert.ok(spawned.length >= 1);
  assert.notEqual(spawned[0].command, 'systemd-run');
});
