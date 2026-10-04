// `oar start` and `oar setup --start` bring the relay of a global install up
// without a Copilot session tied to it. Runs the real ensureRelayRunning with
// fake spawn, systemctl and fetch; every writable path points into a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import net from 'node:net';

import { ensureRelayRunning, findFreePort, isPortFree, probeRelayPort } from '../bin/oar.js';

function makeLayout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-relay-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { checkout: false, root, configDir: root, dataDir: path.join(root, 'data') };
}

// The relay's own answer to its status call.
const relayStatus = () => ({ ok: true, json: async () => ({ cliOnline: false, pendingCount: 0 }) });

// No systemd user manager answers, whatever the host running the test has.
const noSystemd = () => ({ status: 1 });

test('findFreePort takes the first port nothing holds', async () => {
  const taken = new Set([3333, 3334]);
  assert.equal(await findFreePort(3333, { isPortFreeImpl: async (port) => !taken.has(port) }), 3335);
  assert.equal(await findFreePort(4000, { isPortFreeImpl: async () => true }), 4000);
  // Nothing free in the window: the start port, so the relay reports the clash itself.
  assert.equal(await findFreePort(3333, { attempts: 3, isPortFreeImpl: async () => false }), 3333);
});

test('a relay that already answers is left alone', async (t) => {
  const layout = makeLayout(t);
  const spawned = [];
  const result = await ensureRelayRunning({
    packageRoot: path.join(layout.root, 'pkg'),
    layout,
    configPath: path.join(layout.root, 'config.json'),
    config: { port: 4011, authToken: 'tok' },
    env: {},
    spawnImpl: (...args) => { spawned.push(args); },
    spawnSyncImpl: noSystemd,
    fetchImpl: async () => relayStatus(),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.how, 'already');
  assert.deepEqual(spawned, []);
});

test('the port probe tells this relay from another program and from nothing', async () => {
  const probe = (fetchImpl) => probeRelayPort({ statusUrl: 'http://localhost:4020/api/status', token: 'tok', fetchImpl });
  assert.equal(await probe(async () => relayStatus()), 'oar');
  // Another program: any answer without the relay's status shape, a refused
  // token, or a port that is held but silent.
  assert.equal(await probe(async () => ({ ok: true, json: async () => ({ hello: 'world' }) })), 'taken');
  assert.equal(await probe(async () => ({ ok: true, json: async () => { throw new Error('not json'); } })), 'taken');
  assert.equal(await probe(async () => ({ ok: false, status: 401 })), 'taken');
  assert.equal(await probe(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }), 'taken');
  assert.equal(await probe(async () => { throw new Error('connection refused'); }), 'none');
});

test('another program on the port stops the start with a message naming the port', async (t) => {
  const layout = makeLayout(t);
  const spawned = [];
  const errors = [];
  const result = await ensureRelayRunning({
    packageRoot: path.join(layout.root, 'pkg'),
    layout,
    configPath: path.join(layout.root, 'config.json'),
    config: { port: 4014, authToken: 'tok' },
    env: {},
    spawnImpl: (...args) => { spawned.push(args); },
    spawnSyncImpl: noSystemd,
    fetchImpl: async () => ({ ok: false, status: 401 }),
    logger: { log() {}, error: (line) => errors.push(line) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.how, 'port-taken');
  assert.deepEqual(spawned, []);
  assert.match(errors.join('\n'), /Port 4014 is in use/);
  assert.match(errors.join('\n'), /oar setup --port/);
});

test('a leftover lock with a live process id is removed and the relay is started', async (t) => {
  const layout = makeLayout(t);
  fs.mkdirSync(layout.dataDir, { recursive: true });
  const lockPath = path.join(layout.dataDir, 'relay-server.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, startedAt: '2031-01-01T00:00:00.000Z' }));
  const spawned = [];
  const result = await ensureRelayRunning({
    packageRoot: path.join(layout.root, 'pkg'),
    layout,
    configPath: path.join(layout.root, 'config.json'),
    config: { port: 4015, authToken: 'tok' },
    env: {},
    spawnImpl: (command, args) => {
      spawned.push(args);
      return { exitCode: null, unref() {} };
    },
    spawnSyncImpl: noSystemd,
    fetchImpl: async () => {
      if (!spawned.length) throw new Error('connection refused');
      return relayStatus();
    },
    // The process id of the lock now belongs to some other program.
    isProcessAliveImpl: (pid) => pid === 4242,
    lockGraceMs: 20,
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.how, 'detached');
  assert.equal(spawned.length, 1);
  assert.equal(fs.existsSync(lockPath), false, 'the leftover lock is gone before the server starts');
});

test('a relay that is still starting behind its lock is waited for, not started twice', async (t) => {
  const layout = makeLayout(t);
  fs.mkdirSync(layout.dataDir, { recursive: true });
  const lockPath = path.join(layout.dataDir, 'relay-server.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4343, startedAt: '2031-01-01T00:00:00.000Z' }));
  const spawned = [];
  let probes = 0;
  const result = await ensureRelayRunning({
    packageRoot: path.join(layout.root, 'pkg'),
    layout,
    configPath: path.join(layout.root, 'config.json'),
    config: { port: 4016, authToken: 'tok' },
    env: {},
    spawnImpl: (...args) => { spawned.push(args); },
    spawnSyncImpl: noSystemd,
    fetchImpl: async () => {
      probes += 1;
      if (probes < 2) throw new Error('connection refused');
      return relayStatus();
    },
    isProcessAliveImpl: (pid) => pid === 4343,
    logger: { log() {}, error() {} },
  });
  assert.equal(result.how, 'already');
  assert.deepEqual(spawned, []);
  assert.equal(fs.existsSync(lockPath), true);
});

test('a port something listens on is not free, on either loopback address', async (t) => {
  for (const host of ['127.0.0.1', '::1']) {
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.on('end', () => socket.end());
    });
    const listening = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(0, host, () => resolve(true));
    });
    // A machine without that address family has nothing to check here.
    if (!listening) continue;
    t.after(() => server.close());
    assert.equal(await isPortFree(server.address().port), false, `${host} listener`);
  }
});

test('without a service the server is started detached on the config of the install', async (t) => {
  const layout = makeLayout(t);
  const packageRoot = path.join(layout.root, 'pkg');
  const configPath = path.join(layout.root, 'config.json');
  const spawned = [];
  const probes = [];
  const result = await ensureRelayRunning({
    packageRoot,
    layout,
    configPath,
    config: { port: 4012, authToken: 'tok' },
    cwd: '/home/dev',
    env: { PATH: '/usr/bin' },
    nodeBin: '/opt/node/bin/node',
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { exitCode: null, unref() {} };
    },
    spawnSyncImpl: noSystemd,
    fetchImpl: async (url, options) => {
      probes.push({ url, auth: options?.headers?.Authorization || null });
      if (!spawned.length) throw new Error('connection refused');
      return relayStatus();
    },
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.how, 'detached');
  assert.equal(spawned.length, 1);
  const [{ command, args, options }] = spawned;
  assert.equal(command, '/opt/node/bin/node');
  assert.deepEqual(args, [path.join(packageRoot, 'server', 'server.js')]);
  assert.equal(options.detached, true);
  assert.equal(options.cwd, layout.root);
  assert.equal(options.env.COPILOT_WEB_RELAY_CONFIG, configPath);
  assert.equal(options.env.COPILOT_WEB_RELAY_DATA_DIR, layout.dataDir);
  assert.equal(options.env.COPILOT_WEB_RELAY_LOG_DIR, path.join(layout.root, 'logs'));
  assert.equal(options.env.COPILOT_WORKSPACE_ROOT, '/home/dev');
  assert.deepEqual(probes.at(-1), { url: 'http://localhost:4012/api/status', auth: 'Bearer tok' });
});

test('a server that exits before it answers is reported as not started', async (t) => {
  const layout = makeLayout(t);
  const result = await ensureRelayRunning({
    packageRoot: path.join(layout.root, 'pkg'),
    layout,
    configPath: path.join(layout.root, 'config.json'),
    config: { port: 4013, authToken: 'tok' },
    env: {},
    spawnImpl: () => ({ exitCode: 1, unref() {} }),
    spawnSyncImpl: noSystemd,
    fetchImpl: async () => { throw new Error('connection refused'); },
    logger: { log() {}, error() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(result.how, 'detached');
});
