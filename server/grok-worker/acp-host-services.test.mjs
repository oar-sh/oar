import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createAcpHostServices } from './acp-host-services.mjs';

function createFakeTermProc(pid = 111) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = pid;
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

function createServices(overrides = {}) {
  const spawns = [];
  const procs = [];
  const services = createAcpHostServices({
    cwd: '/work',
    env: {},
    platform: 'linux',
    spawnImpl: (file, args, opts) => {
      spawns.push({ file, args, opts });
      const proc = createFakeTermProc(100 + procs.length);
      procs.push(proc);
      return proc;
    },
    ...overrides,
  });
  return { services, spawns, procs };
}

test('terminal lifecycle: create runs the shell, output accumulates, wait_for_exit settles', async () => {
  const { services, spawns, procs } = createServices();
  const { terminalId } = await services.handlers['terminal/create']({
    command: 'echo hi',
    env: [{ name: 'FOO', value: 'bar' }],
  });
  assert.equal(spawns[0].file, '/bin/sh');
  assert.deepEqual(spawns[0].args, ['-c', 'echo hi']);
  assert.equal(spawns[0].opts.cwd, '/work');
  assert.equal(spawns[0].opts.env.FOO, 'bar');
  assert.equal(services.hasPendingWork(), true, 'a running terminal is pending work');

  procs[0].stdout.emit('data', Buffer.from('hello '));
  procs[0].stderr.emit('data', Buffer.from('world'));
  let out = services.handlers['terminal/output']({ terminalId });
  assert.equal(out.output, 'hello world');
  assert.equal(out.truncated, false);
  assert.equal(out.exitStatus, undefined);

  const waitPromise = services.handlers['terminal/wait_for_exit']({ terminalId });
  procs[0].emit('exit', 0, null);
  assert.deepEqual(await waitPromise, { exitCode: 0, signal: null });
  out = services.handlers['terminal/output']({ terminalId });
  assert.deepEqual(out.exitStatus, { exitCode: 0, signal: null });
  assert.equal(services.hasPendingWork(), false);
});

test('output truncates from the start, keeping the most recent bytes', async () => {
  const { services, procs } = createServices();
  const { terminalId } = await services.handlers['terminal/create']({
    command: 'noisy',
    outputByteLimit: 8,
  });
  procs[0].stdout.emit('data', Buffer.from('abcdefgh'));
  procs[0].stdout.emit('data', Buffer.from('ijkl'));
  const out = services.handlers['terminal/output']({ terminalId });
  assert.equal(out.output, 'efghijkl');
  assert.equal(out.truncated, true);
});

test('windows commands run through pwsh when available, powershell otherwise', async () => {
  const pwshHost = createServices({ platform: 'win32', spawnSyncImpl: () => ({ status: 0 }) });
  await pwshHost.services.handlers['terminal/create']({ command: 'Get-Location' });
  assert.equal(pwshHost.spawns[0].file, 'pwsh');
  assert.deepEqual(pwshHost.spawns[0].args, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Location']);

  const legacyHost = createServices({
    platform: 'win32',
    spawnSyncImpl: () => { throw new Error('ENOENT'); },
  });
  await legacyHost.services.handlers['terminal/create']({ command: 'Get-Location' });
  assert.equal(legacyHost.spawns[0].file, 'powershell');
});

test('explicit args bypass the shell entirely', async () => {
  const { services, spawns } = createServices();
  await services.handlers['terminal/create']({ command: 'node', args: ['-v'] });
  assert.equal(spawns[0].file, 'node');
  assert.deepEqual(spawns[0].args, ['-v']);
});

test('terminal/kill escalates to taskkill on win32 and release forgets the terminal', async () => {
  const { services, spawns, procs } = createServices({
    platform: 'win32',
    spawnSyncImpl: () => ({ status: 0 }),
  });
  const { terminalId } = await services.handlers['terminal/create']({ command: 'sleep 100' });
  assert.equal(services.handlers['terminal/kill']({ terminalId }), null);
  assert.equal(procs[0].killed, true);
  const taskkill = spawns.find((s) => s.file === 'taskkill');
  assert.ok(taskkill, 'kill should sweep the process tree on win32');
  assert.deepEqual(taskkill.args, ['/pid', String(procs[0].pid), '/t', '/f']);

  procs[0].emit('exit', null, 'SIGTERM');
  assert.equal(services.handlers['terminal/release']({ terminalId }), null);
  assert.throws(() => services.handlers['terminal/output']({ terminalId }), /unknown terminalId/);
});

test('a spawn failure settles wait_for_exit instead of hanging the agent', async () => {
  const { services, procs } = createServices();
  const { terminalId } = await services.handlers['terminal/create']({ command: 'missing-bin' });
  const waitPromise = services.handlers['terminal/wait_for_exit']({ terminalId });
  procs[0].emit('error', new Error('spawn /bin/sh ENOENT'));
  assert.deepEqual(await waitPromise, { exitCode: -1, signal: null });
  const out = services.handlers['terminal/output']({ terminalId });
  assert.match(out.output, /terminal spawn error/);
});

test('fs/read_text_file honors line and limit; fs/write_text_file writes through', async () => {
  const written = [];
  const { services } = createServices({
    fsImpl: {
      readFile: async () => 'l1\nl2\nl3\nl4',
      writeFile: async (path, content, encoding) => written.push({ path, content, encoding }),
    },
  });
  assert.deepEqual(
    await services.handlers['fs/read_text_file']({ path: '/tmp/a.txt' }),
    { content: 'l1\nl2\nl3\nl4' },
  );
  assert.deepEqual(
    await services.handlers['fs/read_text_file']({ path: '/tmp/a.txt', line: 2, limit: 2 }),
    { content: 'l2\nl3' },
  );
  assert.deepEqual(
    await services.handlers['fs/read_text_file']({ path: '/tmp/a.txt', limit: 2 }),
    { content: 'l1\nl2' },
  );
  assert.equal(
    await services.handlers['fs/write_text_file']({ path: '/tmp/b.txt', content: 'data' }),
    null,
  );
  assert.deepEqual(written, [{ path: '/tmp/b.txt', content: 'data', encoding: 'utf8' }]);
});

test('attached handlers count as pending work while in flight', async () => {
  let resolveRead = null;
  const { services } = createServices({
    fsImpl: {
      readFile: () => new Promise((resolve) => { resolveRead = resolve; }),
      writeFile: async () => {},
    },
  });
  const registered = new Map();
  services.attach({ setRequestHandler: (method, fn) => registered.set(method, fn) });
  assert.equal(registered.size, 7);

  const readPromise = registered.get('fs/read_text_file')({ path: '/x' });
  assert.equal(services.hasPendingWork(), true, 'an in-flight request is pending work');
  resolveRead('data');
  assert.deepEqual(await readPromise, { content: 'data' });
  assert.equal(services.hasPendingWork(), false);
});

test('disposeAll kills live terminals and refuses new ones', async () => {
  const { services, procs } = createServices();
  await services.handlers['terminal/create']({ command: 'sleep 100' });
  services.disposeAll();
  assert.equal(procs[0].killed, true);
  assert.equal(services.hasPendingWork(), false);
  await assert.rejects(
    services.handlers['terminal/create']({ command: 'echo hi' }),
    /disposed/,
  );
});
