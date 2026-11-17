/**
 * Starts server/server-runtime.mjs the way server/server.js does (one
 * process, `await import`), isolated like a scratch relay
 * (tests/helpers/scratch-relay-env.mjs: a temp state root holds its data
 * folder, config, logs, home and temp folders; no provider keys, no agent CLI,
 * no update check), with tests/helpers/runtime-probe.mjs preloaded.
 *
 * Used by the boot test (server/server-runtime-boot.test.mjs) and the
 * inventory script (scripts/server-runtime-inventory.mjs).
 *
 * The paths the runtime will resolve (config file, data folder, database,
 * uploads, console log, backup folder, and the home and temp variables) are
 * computed with its own resolvers from the child's environment before the
 * child starts, and one that is unset or outside the state root throws;
 * inside the child the probe refuses to open a database outside it.
 * The stop is the runtime's own: an authenticated
 * `POST /api/relay/shutdown` (immediate), on every platform.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createScratchRelayEnv } from './scratch-relay-env.mjs';
import { repoRoot, reserveFreePort, waitForServerReady } from '../relay-server-harness.mjs';
import { resolveDataDir, resolveUploadDir } from '../../server/services/data-dir-resolution.mjs';
import { resolveDatabaseFile } from '../../server/services/database-file.mjs';
import { resolveRelayConsoleLogPath } from '../../server/services/relay-console-log.mjs';
import { resolveBackupDir } from '../../server/services/db-backup-service.mjs';
import { resolveStateLayout } from '../../server/services/oar-state-layout.mjs';

// A fake owner token, the shape of none that is real.
export const BOOT_TEST_TOKEN = 'boot-test-owner-token-not-a-secret-0000000000';

const probePath = path.join(repoRoot, 'tests', 'helpers', 'runtime-probe.mjs');
const launcherPath = path.join(repoRoot, 'tests', 'helpers', 'runtime-probe-launcher.mjs');

// Where the runtime falls back to inside the checkout when its environment
// names no folder (server-runtime.mjs CONFIG_PATH, data-dir-resolution.mjs,
// relay-console-log.mjs, db-backup-service.mjs, the uploads folder).
export const CHECKOUT_FALLBACK_PATHS = [
  'server/config.json',
  'server/data',
  'server/logs',
  'server/backups',
  'server/uploads',
  'server/relay-previous.json',
];

/** Existence, size and mtime of each fallback path and everything below it. */
export function snapshotCheckoutFallbacks(root = repoRoot) {
  const entries = [];
  const visit = (relative) => {
    const full = path.join(root, relative);
    let stat;
    try { stat = fs.lstatSync(full); } catch { return; }
    entries.push(`${relative} ${stat.isDirectory() ? 'dir' : stat.size} ${stat.mtimeMs}`);
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(full).sort()) visit(`${relative}/${name}`);
  };
  for (const relative of CHECKOUT_FALLBACK_PATHS) visit(relative);
  return entries;
}

const comparable = (value) => {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
export function isInside(root, target) {
  const rootKey = comparable(root);
  const key = comparable(target);
  return key === rootKey || key.startsWith(rootKey + path.sep);
}

// The home and temp variables the child must have, each inside the state
// root: the child's environment is built from nothing, so a missing one
// sends os.homedir() or os.tmpdir() to the account's real folders, where the
// runtime may delete an old generated ~/.copilot extension at every start
// (oar-cli-helpers.mjs, removing the retired Copilot extension).
const HOME_AND_TEMP_VARS = ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP'];

function readConfigFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

/**
 * The paths the runtime resolves from `env` and writes to, with its own
 * resolvers: the config file, the data folder (resolveDataDir, DATA_DIR),
 * the database in it (resolveDatabaseFile, DB_PATH), the uploads folder
 * (resolveUploadDir), the console log (resolveRelayConsoleLogPath), the
 * database backup folder (resolveBackupDir over the config's dbBackups and
 * the checkout layout, as at its start), and the home and temp variables
 * (null when unset).
 */
export function resolvedRuntimePaths(env) {
  const serverDir = path.join(repoRoot, 'server');
  // The rule of server-runtime.mjs CONFIG_PATH (line 367 on a0a9b482).
  const config = env.COPILOT_WEB_RELAY_CONFIG
    ? path.resolve(String(env.COPILOT_WEB_RELAY_CONFIG))
    : path.join(serverDir, 'config.json');
  const dataDir = resolveDataDir({ env, configPath: config, serverDir });
  const backups = resolveBackupDir({
    layout: resolveStateLayout({ packageRoot: repoRoot, env }),
    serverDir,
    dataDir,
    config: readConfigFile(config),
  });
  const vars = Object.fromEntries(HOME_AND_TEMP_VARS.map((name) => [name, String(env[name] || '').trim() || null]));
  return {
    config,
    dataDir,
    database: resolveDatabaseFile(dataDir).path,
    uploads: resolveUploadDir({ dataDir, env, serverDir }),
    log: resolveRelayConsoleLogPath({ env, serverDir }),
    backups: backups.dir || null,
    ...vars,
  };
}

/** The resolved paths (`resolvedRuntimePaths`) that are unset or not inside `root`, as "name path". */
export function runtimePathsOutside(root, paths) {
  return Object.entries(paths)
    .filter(([, target]) => !target || !isInside(root, target))
    .map(([name, target]) => `${name} ${target || '(unset)'}`);
}

// `promise`, or null after `ms`; the timer goes either way, so nothing is
// left holding the test process.
function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function tail(text, bytes = 20_000) {
  return text.length > bytes ? text.slice(-bytes) : text;
}

/**
 * Starts the runtime and waits until GET /api/status answers. `envChange`
 * receives the environment and returns the one the child gets (the guard's
 * proof drops a variable with it). Resolves to a handle; on a failed start
 * the state root is removed and the error carries the runtime's output.
 */
// 90 s: a start takes about 2 s alone but was seen at 22.6 s on a host under
// load; a slow start is not what the boot test is for.
export async function bootRuntime({ token = BOOT_TEST_TOKEN, readyTimeoutMs = 90_000, envChange = (env) => env } = {}) {
  const port = await reserveFreePort();
  const scratch = await createScratchRelayEnv({ port });
  const probeOut = path.join(scratch.stateRoot, 'runtime-probe.json');
  const env = envChange({
    ...scratch.env,
    RUNTIME_PROBE_ROOT: scratch.stateRoot,
    RUNTIME_PROBE_OUT: probeOut,
    RUNTIME_PROBE_PORT: String(port),
  });
  const paths = resolvedRuntimePaths(env);
  const outside = runtimePathsOutside(scratch.stateRoot, paths);
  if (outside.length) {
    scratch.cleanup();
    throw new Error(`boot refused: the runtime would use paths outside the state root: ${outside.join('; ')}`);
  }
  const databasePath = paths.database;

  let stdout = '';
  let stderr = '';
  const startedAt = Date.now();
  const proc = spawn(
    process.execPath,
    ['--import', pathToFileURL(probePath).href, launcherPath, '--token', token, '--port', String(port), '--owner-pid', String(process.pid)],
    { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  proc.stdout.on('data', (chunk) => { stdout = tail(stdout + chunk); });
  proc.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk); });
  const exited = new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const output = () => [
    stdout ? `--- runtime stdout ---\n${stdout.split(token).join('<token>')}` : '',
    stderr ? `--- runtime stderr ---\n${stderr.split(token).join('<token>')}` : '',
  ].filter(Boolean).join('\n');
  const readProbe = () => {
    try { return JSON.parse(fs.readFileSync(probeOut, 'utf8')); } catch { return null; }
  };
  const kill = async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch {}
      await within(exited, 5_000);
    }
  };

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServerReady(baseUrl, token, proc, readyTimeoutMs);
  } catch (error) {
    await kill();
    const probe = readProbe();
    scratch.cleanup();
    const refused = probe?.refusedDatabases?.length ? `\nrefused databases: ${probe.refusedDatabases.join(', ')}` : '';
    const failure = new Error(`${error?.message || error}${refused}\n${output()}`);
    failure.probe = probe;
    throw failure;
  }
  const readyMs = Date.now() - startedAt;

  return {
    proc,
    port,
    baseUrl,
    token,
    stateRoot: scratch.stateRoot,
    env,
    databasePath,
    readyMs,
    output,
    readProbe,
    exited,
    /** The runtime's own stop; resolves to `{ code, signal, response }`. */
    async shutdown({ timeoutMs = 15_000 } = {}) {
      const response = await fetch(`${baseUrl}/api/relay/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ restart: false, immediate: true, reason: 'boot-test', requestedBy: 'boot-test' }),
      });
      const answer = { status: response.status, body: await response.text() };
      const result = await within(exited, timeoutMs);
      if (!result) {
        await kill();
        throw new Error(`the runtime did not exit within ${timeoutMs} ms of the shutdown request (HTTP ${answer.status})\n${output()}`);
      }
      return { ...result, response: answer };
    },
    kill,
    cleanup: () => scratch.cleanup(),
  };
}

function statePaths(root, relative = '') {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); } catch { return out; }
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    out.push(entry.isDirectory() ? `${child}/` : child);
    if (entry.isDirectory()) out.push(...statePaths(root, child));
  }
  return out;
}

function posixMode(file) {
  try { return (fs.statSync(file).mode & 0o777).toString(8); } catch { return null; }
}

/**
 * One whole cycle, the same for the boot test and the inventory script:
 * start; GET /api/status with and without the token; a socket handshake with
 * and without it; the runtime's own stop; the probe's record. The state root
 * is removed at the end, whatever happened.
 */
export async function runBootCycle(options = {}) {
  const checkoutBefore = snapshotCheckoutFallbacks();
  const startedAt = Date.now();
  const handle = await bootRuntime(options);
  try {
    const auth = { Authorization: `Bearer ${handle.token}` };
    const statusWithToken = (await fetch(`${handle.baseUrl}/api/status`, { headers: auth })).status;
    const statusWithoutToken = (await fetch(`${handle.baseUrl}/api/status`)).status;
    const socketWithToken = await socketHandshake(handle.baseUrl, { auth: { token: handle.token } });
    const socketWithoutToken = await socketHandshake(handle.baseUrl, {});
    const stop = await handle.shutdown();
    const dataDir = path.dirname(handle.databasePath);
    return {
      stateRoot: handle.stateRoot,
      databasePath: handle.databasePath,
      configPath: handle.env.COPILOT_WEB_RELAY_CONFIG,
      readyMs: handle.readyMs,
      totalMs: Date.now() - startedAt,
      statusWithToken,
      statusWithoutToken,
      socketWithToken,
      socketWithoutToken,
      stop,
      probe: handle.readProbe(),
      output: handle.output(),
      statePaths: statePaths(handle.stateRoot),
      modes: process.platform === 'win32' ? null : {
        dataDir: posixMode(dataDir),
        database: posixMode(handle.databasePath),
        config: posixMode(handle.env.COPILOT_WEB_RELAY_CONFIG),
      },
      checkoutBefore,
      checkoutAfter: snapshotCheckoutFallbacks(),
    };
  } finally {
    await handle.kill();
    handle.cleanup();
  }
}

/**
 * A socket.io handshake over the engine.io WebSocket transport (Node's own
 * WebSocket; the repository has no socket.io client): `{ connected, error }`.
 * `auth` is the handshake's auth object (the relay reads `auth.token`).
 */
export function socketHandshake(baseUrl, { auth = {}, timeoutMs = 10_000 } = {}) {
  const url = `${baseUrl.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ connected: false, error: 'timeout' }), timeoutMs);
    ws.addEventListener('message', (event) => {
      const data = String(event.data);
      if (data.startsWith('0')) ws.send(`40${JSON.stringify(auth)}`);
      else if (data.startsWith('40')) finish({ connected: true, error: null });
      else if (data.startsWith('44')) finish({ connected: false, error: data.slice(2) });
    });
    ws.addEventListener('error', () => finish({ connected: false, error: 'websocket error' }));
    ws.addEventListener('close', () => finish({ connected: false, error: 'closed' }));
  });
}
