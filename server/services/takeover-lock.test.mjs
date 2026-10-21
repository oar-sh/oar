// A relay bringing over its earlier database holds its lock from before the
// first step to its end: a second `oar start`, or a second server, started
// meanwhile changes nothing. Relay A is a real process running the real lock
// and take-over, its copy held up until the test lets it go.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureRelayRunning } from '../../bin/oar.js';
import { TAKEOVER_PROGRESS_FILE } from './earlier-database-service.mjs';
import { scratchEnv } from './scratch-env-test-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const Database = createRequire(import.meta.url)('better-sqlite3');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// Relay A: the lock first, then the take-over; its copy of copilot.db waits
// for the `go` file. It says at the end whose lock was there.
const RELAY_A = `
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const [guardUrl, serviceUrl, packageJson, settingsFile] = process.argv.slice(2);
const { createRelaySingletonGuard } = await import(guardUrl);
const { adoptEarlierDatabase } = await import(serviceUrl);
const Database = createRequire(packageJson)('better-sqlite3');
const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const guard = createRelaySingletonGuard({ lockPath: s.lockPath, pid: process.pid, token: s.token, logger: {} });
guard.acquire();
const fsImpl = { ...fs, copyFileSync(from, to, mode) {
  if (path.basename(from) === 'copilot.db') {
    const deadline = Date.now() + 60000;
    while (!fs.existsSync(s.go) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return fs.copyFileSync(from, to, mode);
} };
const result = adoptEarlierDatabase({ dataDir: s.dataDir, uploadDir: s.uploadDir, serverDir: s.serverDir, packageRoot: s.packageRoot, Database, env: s.env, fsImpl, logger: { log() {} } });
const lock = JSON.parse(fs.readFileSync(s.lockPath, 'utf8'));
console.log(JSON.stringify({ status: result.status, lockPid: lock.pid, lockToken: lock.tokenHash, ownToken: crypto.createHash('sha256').update(s.token).digest('hex') }));
guard.release();
`;

test('a start during a slow take-over is refused, and the relay taking over keeps its lock to the end', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-takeover-lock-'));
  let relayA = null;
  after(() => {
    try { relayA?.kill(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const env = scratchEnv(root);
  // A global install (no .git), pinned to the state root, with a rescue copy
  // newer than nothing: it is brought over.
  const packageRoot = path.join(root, 'pkg');
  const serverDir = path.join(packageRoot, 'server');
  fs.mkdirSync(serverDir, { recursive: true });
  const stateRoot = env.OAR_STATE_ROOT;
  const dataDir = path.join(stateRoot, 'data');
  const rescueDir = path.join(dataDir, 'rescued-package-data', '2026-10-20T09-00-00-000Z', 'data');
  fs.mkdirSync(rescueDir, { recursive: true });
  const db = new Database(path.join(rescueDir, 'copilot.db'));
  db.exec("CREATE TABLE conversations (id TEXT, updated_at TEXT); INSERT INTO conversations VALUES ('c1', '2026-10-20T09:00:00.000Z');");
  db.close();
  const lockPath = path.join(dataDir, 'relay-server.lock');
  const settings = {
    lockPath, token: 'held-token-0123456789', go: path.join(root, 'go'),
    dataDir, uploadDir: path.join(stateRoot, 'uploads'), serverDir, packageRoot, env,
  };
  const settingsFile = path.join(root, 'relay-a.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const script = path.join(root, 'relay-a.mjs');
  fs.writeFileSync(script, RELAY_A);
  let outputA = '';
  relayA = spawn(process.execPath, [
    script,
    pathToFileURL(path.join(here, 'relay-singleton-guard.mjs')).href,
    pathToFileURL(path.join(here, 'earlier-database-service.mjs')).href,
    path.join(here, '..', '..', 'package.json'),
    settingsFile,
  ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  relayA.stdout.on('data', (chunk) => { outputA += chunk; });
  relayA.stderr.on('data', (chunk) => { outputA += chunk; });
  const exitedA = new Promise((resolve) => relayA.once('exit', resolve));

  // A is in its copy (its staging folder is there): the lock names it.
  const progressFile = path.join(dataDir, TAKEOVER_PROGRESS_FILE);
  await until(() => fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((name) => name.startsWith('.earlier-database-')), 'the copy');
  const lockOfA = fs.readFileSync(lockPath, 'utf8');
  assert.equal(JSON.parse(lockOfA).pid, relayA.pid);

  // A second `oar start`: nothing answers on the port.
  const spawned = [];
  const lines = [];
  const started = await ensureRelayRunning({
    packageRoot,
    layout: { checkout: false, root: stateRoot, configDir: stateRoot, dataDir },
    configPath: path.join(stateRoot, 'config.json'),
    config: { port: 39923, authToken: settings.token },
    env,
    spawnImpl: (command, args) => { spawned.push(args); return { exitCode: null, unref() {} }; },
    spawnSyncImpl: () => ({ status: 1 }),
    fetchImpl: async () => { throw new Error('connection refused'); },
    lockGraceMs: 20,
    logger: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
  });
  assert.equal(fs.existsSync(lockPath) && fs.readFileSync(lockPath, 'utf8'), lockOfA, 'the lock is left as it is');
  assert.deepEqual(spawned, [], 'no second relay');
  assert.equal(started.how, 'bringing-over');
  assert.equal(started.takeover.pid, relayA.pid);

  // A second server, as a launcher starts it: refused, exit 78.
  const configPath = path.join(stateRoot, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ port: 39923, authToken: settings.token, localhostOnly: true }));
  const second = spawnSync(process.execPath, [path.join(here, '..', 'server.js')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    env: scratchEnv(root, {
      COPILOT_WEB_RELAY_CONFIG: configPath,
      COPILOT_WEB_RELAY_DATA_DIR: dataDir,
      COPILOT_WEB_RELAY_LOG_DIR: path.join(stateRoot, 'logs'),
      COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '1',
    }),
  });
  const secondLines = `${second.stdout}${second.stderr}`.split(/\r?\n/);
  assert.equal(second.status, 78, secondLines.slice(-6).join('\n'));
  assert.equal(secondLines.filter((line) => line.includes(lockPath)).length, 1, 'one line naming the lock');
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockOfA, 'still the lock of A');

  // A goes on: its database comes over, and the lock was its own to the end.
  fs.writeFileSync(settings.go, '');
  assert.equal(await exitedA, 0, outputA);
  const endOfA = JSON.parse(outputA.trim().split(/\r?\n/).at(-1));
  assert.equal(endOfA.status, 'adopted');
  assert.equal(endOfA.lockPid, relayA.pid);
  assert.equal(endOfA.lockToken, endOfA.ownToken);
  assert.equal(endOfA.ownToken, crypto.createHash('sha256').update(settings.token).digest('hex'));
  assert.equal(fs.existsSync(progressFile), false);
  assert.equal(fs.existsSync(lockPath), false, 'released by A itself');
});
