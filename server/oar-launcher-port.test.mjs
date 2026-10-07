// The `oar` launcher must find, start and probe the relay on ONE port. It used
// to probe `--port` (or 3333) while starting the server on the config's port,
// so any mismatch waited out the readiness deadline and killed the relay it had
// just started. Runs the real launchRelay against a throwaway checkout layout;
// spawn and fetch are fakes, and every writable path points into a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { launchRelay } from '../bin/oar.js';

function makeCheckout(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-launcher-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'server', 'data'), { recursive: true });
  if (config) fs.writeFileSync(path.join(root, 'server', 'config.json'), JSON.stringify(config));
  return root;
}

function fakeProcess({ exitWith = null } = {}) {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.kill = () => { proc.exitCode = 0; };
  if (exitWith !== null) {
    setImmediate(() => {
      proc.exitCode = exitWith;
      proc.emit('exit', exitWith, null);
    });
  }
  return proc;
}

// `gh --version` answers: the GitHub CLI is installed, whatever the host has.
const ghInstalled = () => ({ status: 0 });

async function runLauncher(t, { argv = [], config = null } = {}) {
  const root = makeCheckout(t, config);
  const spawned = [];
  const probes = [];
  const serverPort = () => {
    const server = spawned.find((entry) => entry.cmd === 'node');
    return server ? server.args[server.args.indexOf('--port') + 1] : null;
  };
  const result = await launchRelay({
    argv: ['--no-install-extension', ...argv],
    cwd: root,
    packageRoot: root,
    nodeBin: 'node',
    spawnImpl: (cmd, args) => {
      spawned.push({ cmd, args });
      return cmd === 'gh' ? fakeProcess({ exitWith: 0 }) : fakeProcess();
    },
    spawnSyncImpl: ghInstalled,
    // Like a real server, the fake relay answers only on the port it was started with.
    fetchImpl: async (url) => {
      probes.push(new URL(String(url)).port);
      if (serverPort() && new URL(String(url)).port === serverPort()) return { ok: true };
      throw new Error('connect ECONNREFUSED');
    },
    env: {
      COPILOT_WEB_RELAY_LOG_DIR: path.join(root, 'logs'),
      XDG_CONFIG_HOME: path.join(root, 'xdg'),
      LOCALAPPDATA: path.join(root, 'localappdata'),
    },
    logger: { log() {}, error() {} },
  });
  return { root, result, serverPort: serverPort(), probes };
}

test('without --port the relay starts and is probed on the config port', async (t) => {
  const { root, result, serverPort, probes } = await runLauncher(t, {
    config: { authToken: 'test-token', port: 4567 },
  });
  assert.equal(result.reason, 'exited');
  assert.equal(result.code, 0);
  assert.equal(serverPort, '4567');
  assert.ok(probes.length > 0);
  assert.deepEqual([...new Set(probes)], ['4567']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'server', 'config.json'), 'utf8')).port, 4567);
});

test('an explicit --port wins for the run and leaves an existing config alone', async (t) => {
  const { root, result, serverPort, probes } = await runLauncher(t, {
    argv: ['--port', '5678'],
    config: { authToken: 'test-token', port: 4567 },
  });
  assert.equal(result.reason, 'exited');
  assert.equal(serverPort, '5678');
  assert.deepEqual([...new Set(probes)], ['5678']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'server', 'config.json'), 'utf8')).port, 4567);
});

test('a config the launcher creates saves the --port it was given', async (t) => {
  const { root, result, serverPort } = await runLauncher(t, { argv: ['--port=5679'] });
  assert.equal(result.reason, 'exited');
  assert.equal(serverPort, '5679');
  // The managed config lives under XDG_CONFIG_HOME, or LOCALAPPDATA on win32.
  const createdPath = [
    path.join(root, 'xdg', 'copilot-remote', 'config.json'),
    path.join(root, 'localappdata', 'copilot-remote', 'config.json'),
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(createdPath, 'the launcher wrote no managed config');
  assert.equal(JSON.parse(fs.readFileSync(createdPath, 'utf8')).port, 5679);
});

test('--help does not advertise a --token flag the launcher never reads', async () => {
  const lines = [];
  const result = await launchRelay({ argv: ['--help'], logger: { log: (text) => lines.push(String(text)) } });
  assert.equal(result.reason, 'help');
  assert.match(lines.join('\n'), /--port <port>/);
  assert.doesNotMatch(lines.join('\n'), /--token/);
});

// A relay's answer to its status call.
const relayStatus = () => ({ ok: true, json: async () => ({ cliOnline: false }) });

// Runs the launcher beside a lock file whose process id is alive, with a fake
// relay answering on `relayPort` for `relayToken`.
async function runBesideLock(t, { argv = [], relayPort = null, relayToken = 'test-token', spawnSyncImpl = ghInstalled } = {}) {
  const root = makeCheckout(t, { authToken: 'test-token', port: 4567 });
  const lockPath = path.join(root, 'server', 'data', 'relay-server.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, startedAt: '2031-01-01T00:00:00.000Z' }));
  const spawned = [];
  const lines = [];
  const result = await launchRelay({
    argv: ['--no-install-extension', ...argv],
    cwd: root,
    packageRoot: root,
    nodeBin: 'node',
    spawnImpl: (cmd, args) => {
      spawned.push({ cmd, args });
      return cmd === 'gh' ? fakeProcess({ exitWith: 0 }) : fakeProcess();
    },
    spawnSyncImpl,
    fetchImpl: async (url, options) => {
      const port = Number(new URL(String(url)).port);
      const startedOn = spawned.find((entry) => entry.cmd === 'node')?.args.at(-1);
      if (port === relayPort) {
        return options?.headers?.Authorization === `Bearer ${relayToken}` ? relayStatus() : { ok: false, status: 401 };
      }
      if (String(port) === startedOn) return relayStatus();
      throw new Error('connect ECONNREFUSED');
    },
    isProcessAliveImpl: (pid) => pid === 4242,
    lockGraceMs: 20,
    env: {
      COPILOT_WEB_RELAY_LOG_DIR: path.join(root, 'logs'),
      XDG_CONFIG_HOME: path.join(root, 'xdg'),
      LOCALAPPDATA: path.join(root, 'localappdata'),
    },
    logger: { log: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) },
  });
  return { result, spawned, lines, lockExists: fs.existsSync(lockPath) };
}

test('a relay that answers on the config port is used; no second server is started', async (t) => {
  const { result, spawned, lines } = await runBesideLock(t, { relayPort: 4567 });
  assert.equal(result.reason, 'exited');
  assert.deepEqual(spawned.map((entry) => entry.cmd), ['gh']);
  assert.match(lines.join('\n'), /already running at http:\/\/localhost:4567\/api\/status/);
});

test('a live lock alone does not count as a running relay: the server is started on the config port', async (t) => {
  const { result, spawned, lockExists } = await runBesideLock(t);
  assert.equal(result.reason, 'exited');
  assert.deepEqual(spawned.map((entry) => entry.cmd), ['node', 'gh']);
  assert.equal(spawned[0].args.at(-1), '4567');
  assert.equal(lockExists, false, 'the leftover lock is removed before the server starts');
});

test('on a --port other than the config\'s the lock is left alone', async (t) => {
  const { spawned, lockExists } = await runBesideLock(t, { argv: ['--port', '5678'], relayPort: 4567 });
  assert.equal(spawned[0].args.at(-1), '5678');
  assert.equal(lockExists, true);
});

test('another program, or a relay with another token, on the port stops the launcher', async (t) => {
  const { result, spawned, lines } = await runBesideLock(t, { relayPort: 4567, relayToken: 'another-token' });
  assert.deepEqual({ code: result.code, reason: result.reason }, { code: 1, reason: 'port-taken' });
  assert.deepEqual(spawned, []);
  assert.match(lines.join('\n'), /Port 4567 is in use by another program/);
});

test('without gh the launcher says what is missing and starts nothing', async (t) => {
  for (const spawnSyncImpl of [
    () => ({ status: null, error: Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }) }),
    () => { throw new Error('spawn failed'); },
  ]) {
    const { result, spawned, lines } = await runBesideLock(t, { spawnSyncImpl });
    assert.deepEqual({ code: result.code, reason: result.reason }, { code: 1, reason: 'gh-missing' });
    assert.deepEqual(spawned, []);
    assert.match(lines.join('\n'), /needs the GitHub CLI \(gh\), which is not installed or not on PATH/);
    assert.match(lines.join('\n'), /oar start/);
    assert.doesNotMatch(lines.join('\n'), /ENOENT/);
  }
});
