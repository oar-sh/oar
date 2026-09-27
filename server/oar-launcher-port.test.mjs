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
