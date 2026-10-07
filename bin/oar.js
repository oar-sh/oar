#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawn, spawnSync } from 'child_process';
import net from 'net';

import {
  migrateStateToOarRoot,
  resolveOarRoot,
} from '../server/services/oar-state-migration-service.mjs';
import {
  buildDefaultConfig, buildServicePath, buildSystemdUnit, describeRelayAddress, DOCTOR_PROBES, generateAuthToken,
  NPM_ALLOW_SCRIPTS_ARG, parseCliArgs, primaryLanAddress, renderDoctorReport, resolveNpmInvocation, usageText,
} from '../server/services/oar-cli-helpers.mjs';
import { describeConfiguredTunnel, describeTunnelState } from '../server/services/cloudflared-tunnel-service.mjs';
import { createPrompter, PromptAborted, runMenu } from '../server/services/oar-cli-menu.mjs';
import { createWindowsPortCheck, isWsl, isWslNat, windowsPortWarning } from '../server/services/oar-cli-wsl.mjs';
import { createWindowsAutostartService } from '../server/services/windows-autostart-service.mjs';
import { createWindowsBootAutostartService } from '../server/services/windows-boot-autostart-service.mjs';

function resolvePackageRoot(metaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..');
}

function parsePort(argv = [], fallback = 3333) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (arg === '--port' && args[index + 1]) {
      const parsed = Number.parseInt(String(args[index + 1]), 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
    }
    if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
    }
  }
  return fallback;
}

function normalizePort(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function readRelayLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      pid: Number.parseInt(String(parsed?.pid ?? ''), 10),
      startedAt: typeof parsed?.startedAt === 'string' ? parsed.startedAt : null,
      token: typeof parsed?.token === 'string' ? parsed.token : '',
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function openAppendFileDescriptor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return fs.openSync(filePath, 'a');
}

// Pre-OAR managed config location — kept only as a migration source and as the
// config home for git checkouts, where nothing may change underfoot.
function getLegacyManagedConfigDir(env = process.env) {
  if (process.platform === 'win32') {
    return path.join(
      env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'copilot-remote',
    );
  }
  return path.join(
    env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'copilot-remote',
  );
}

function isGitCheckout(packageRoot) {
  try { return fs.existsSync(path.join(packageRoot, '.git')); } catch { return false; }
}

/**
 * Where launcher-managed state lives. A git checkout keeps every pre-OAR
 * default (repo-local server/data, legacy managed config) so development and
 * the two existing machines change nothing. A global install gets the OAR
 * state root: config, data, logs all under ~/.oar (APPDATA\oar on Windows),
 * which survives `npm i -g` updates.
 */
function resolveStateLayout({ packageRoot, env = process.env } = {}) {
  if (isGitCheckout(packageRoot)) {
    return { checkout: true, root: null, configDir: getLegacyManagedConfigDir(env), dataDir: null };
  }
  const root = resolveOarRoot(env);
  return { checkout: false, root, configDir: root, dataDir: path.join(root, 'data') };
}

function getLauncherLogDir(env = process.env, layout = null) {
  const envLogDir = String(env.COPILOT_WEB_RELAY_LOG_DIR || '').trim();
  if (envLogDir) return envLogDir;
  if (layout && !layout.checkout) return path.join(layout.root, 'logs');
  return path.join(getLegacyManagedConfigDir(env), 'logs');
}

function getCopilotHomeDir(env = process.env) {
  const override = String(env.COPILOT_CONFIG_HOME || '').trim();
  if (override) return override;
  if (process.platform === 'win32') {
    const profile = String(env.USERPROFILE || '').trim();
    return path.join(profile || os.homedir(), '.copilot');
  }
  return path.join(os.homedir(), '.copilot');
}

function getCopilotUserExtensionsDir(env = process.env) {
  return path.join(getCopilotHomeDir(env), 'extensions');
}

function buildGlobalExtensionWrapperSource(entryPath) {
  const entryUrl = pathToFileURL(path.resolve(String(entryPath || ''))).href;
  const packageRoot = path.resolve(path.dirname(String(entryPath || '')), '..', '..', '..');
  return [
    '// Auto-generated by oar to provide a stable user-global extension entrypoint.',
    '// Do not edit manually; regenerate via `oar --install-extension`.',
    '',
    'import path from "path";',
    '',
    `const PACKAGE_ROOT = ${JSON.stringify(packageRoot)};`,
    'const cwd = path.resolve(process.cwd());',
    'const normalizedPackageRoot = path.resolve(PACKAGE_ROOT);',
    'const runningInsidePackage = cwd === normalizedPackageRoot || cwd.startsWith(`${normalizedPackageRoot}${path.sep}`);',
    'const forceGlobalExtension = process.env.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION === "true";',
    '',
    '// Avoid double-loading when the project-local extension is already discoverable from the repo itself.',
    'if (!runningInsidePackage || forceGlobalExtension) {',
    `  await import(${JSON.stringify(entryUrl)});`,
    '}',
    '',
  ].join('\n');
}

function ensureGlobalExtensionWrapper({ packageRoot, env = process.env, logger = console } = {}) {
  const sourceEntryPath = path.join(packageRoot, '.github', 'extensions', 'web-relay', 'extension.mjs');
  if (!fs.existsSync(sourceEntryPath)) {
    throw new Error(`missing extension entrypoint at ${sourceEntryPath}`);
  }
  const targetDir = path.join(getCopilotUserExtensionsDir(env), 'web-relay');
  const targetFilePath = path.join(targetDir, 'extension.mjs');
  const nextSource = buildGlobalExtensionWrapperSource(sourceEntryPath);
  fs.mkdirSync(targetDir, { recursive: true });
  const currentSource = fs.existsSync(targetFilePath) ? String(fs.readFileSync(targetFilePath, 'utf8')) : '';
  if (currentSource !== nextSource) {
    fs.writeFileSync(targetFilePath, nextSource, 'utf8');
    logger.log?.(`[oar] Updated user extension wrapper: ${targetFilePath}`);
  } else {
    logger.log?.(`[oar] User extension wrapper already current: ${targetFilePath}`);
  }
  return { targetDir, targetFilePath, sourceEntryPath };
}

function createDefaultConfig({ port = 3333, token = '' } = {}) {
  const parsedPort = Number.parseInt(String(port || ''), 10);
  return {
    authToken: String(token || '').trim() || randomUUID(),
    port: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3333,
    localhostOnly: true,
    pollIntervalMs: 3000,
    conversationSessionMode: 'isolated',
  };
}

function resolveConfigPaths({ packageRoot, env = process.env, layout = null } = {}) {
  const envConfigPath = String(env.COPILOT_WEB_RELAY_CONFIG || '').trim();
  const repoConfigPath = path.join(packageRoot, 'server', 'config.json');
  const oarConfigPath = layout && !layout.checkout ? path.join(layout.configDir, 'config.json') : null;
  const seedPath = (
    (envConfigPath && fs.existsSync(envConfigPath) && envConfigPath)
    || (oarConfigPath && fs.existsSync(oarConfigPath) && oarConfigPath)
    || (fs.existsSync(repoConfigPath) && repoConfigPath)
    || null
  );
  const managedPath = oarConfigPath || path.join(getLegacyManagedConfigDir(env), 'config.json');
  return { seedPath, configPath: seedPath || managedPath };
}

function resolveLauncherConfig({ packageRoot, env = process.env, relayToken = '', relayPort = 3333, portOverride = null, layout = null } = {}) {
  const { seedPath, configPath } = resolveConfigPaths({ packageRoot, env, layout });
  const seedConfig = readJsonFile(seedPath) || {};
  const runtimeConfig = {
    ...createDefaultConfig({ port: relayPort }),
    ...seedConfig,
  };
  if (relayToken) runtimeConfig.authToken = relayToken;
  if (!String(runtimeConfig.authToken || '').trim()) runtimeConfig.authToken = randomUUID();
  // An explicit --port wins over the config for this run: the server gets it
  // on argv, and only a config this command creates saves it.
  runtimeConfig.port = normalizePort(portOverride) ?? normalizePort(runtimeConfig.port) ?? normalizePort(relayPort) ?? 3333;
  return {
    configPath,
    managed: !seedPath,
    config: runtimeConfig,
  };
}

const GH_MISSING_MESSAGE = '[oar] The Copilot session needs the GitHub CLI (gh), which is not installed or not on PATH: https://cli.github.com — the relay alone needs no gh: oar start';

function ghInstalled({ spawnSyncImpl = spawnSync } = {}) {
  try {
    const result = spawnSyncImpl('gh', ['--version'], { stdio: 'ignore', timeout: 15_000, windowsHide: true });
    return !result?.error && result?.status === 0;
  } catch {
    return false;
  }
}

export async function detectRunningRelay({
  lockPath,
  statusUrl,
  fetchImpl = globalThis.fetch,
  isProcessAliveImpl = isProcessAlive,
} = {}) {
  const lock = readRelayLock(lockPath);
  if (Number.isInteger(lock?.pid) && isProcessAliveImpl(lock.pid)) {
    return { running: true, source: 'lock', lock };
  }

  if (typeof fetchImpl === 'function' && statusUrl) {
    try {
      const response = await fetchImpl(statusUrl, { method: 'GET' });
      if (response) {
        return { running: true, source: 'status', lock };
      }
    } catch {
      // Not running or unreachable.
    }
  }

  return { running: false, source: null, lock };
}

export async function launchRelay({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  packageRoot = resolvePackageRoot(),
  nodeBin = process.execPath,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  fetchImpl = globalThis.fetch,
  isProcessAliveImpl = isProcessAlive,
  lockGraceMs = 5000,
  env = process.env,
  logger = console,
} = {}) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const installExtensionOnly = args.includes('--install-extension');
  const skipExtensionInstall = args.includes('--no-install-extension');
  const separatorIdx = args.indexOf('--');
  const rawLauncherArgs = separatorIdx === -1 ? args : args.slice(0, separatorIdx);
  const migrateFromIdx = rawLauncherArgs.indexOf('--migrate-from');
  const migrateFromRoot = migrateFromIdx !== -1 ? String(rawLauncherArgs[migrateFromIdx + 1] || '').trim() : '';
  const launcherArgs = rawLauncherArgs
    .filter((arg, idx) => idx !== migrateFromIdx && idx !== migrateFromIdx + 1)
    .filter((arg) => arg !== '--install-extension' && arg !== '--no-install-extension');
  const forwardedArgs = separatorIdx === -1 ? [] : args.slice(separatorIdx + 1);
  if (args.includes('--help') || args.includes('-h')) {
    logger.log([
      'Usage: oar copilot [--port <port>] [--migrate-from <old-checkout>] [--install-extension] [--no-install-extension] [-- [gh copilot args...]]',
      '',
      'Starts the web relay server if needed, then launches gh copilot in the current shell.',
      '--install-extension installs/updates a user-global web-relay wrapper extension and exits.',
      '--no-install-extension skips automatic wrapper setup for this run.',
      'oar help lists every command.',
    ].join('\n'));
    return { code: 0, reason: 'help' };
  }

  // The session is `gh copilot`: without gh there is nothing to prepare or
  // start. Installing the wrapper alone needs no gh.
  if (!installExtensionOnly && !ghInstalled({ spawnSyncImpl })) {
    logger.error?.(GH_MISSING_MESSAGE);
    return { code: 1, reason: 'gh-missing' };
  }
  if (!skipExtensionInstall || installExtensionOnly) {
    try {
      ensureGlobalExtensionWrapper({ packageRoot, env, logger });
    } catch (error) {
      logger.error?.(`[oar] Failed to prepare user extension wrapper: ${error?.message || error}`);
      if (installExtensionOnly) return { code: 1, reason: 'extension-install-failed', error };
    }
  }
  if (installExtensionOnly) {
    return { code: 0, reason: 'extension-installed' };
  }

  const cliPort = parsePort(launcherArgs, null);
  const serverDir = path.join(packageRoot, 'server');
  const layout = resolveStateLayout({ packageRoot, env });

  if (!layout.checkout) {
    // Global install: state lives in the OAR root. Migrate pre-OAR state in
    // exactly once (marker-guarded); a live source relay blocks the migration.
    try {
      const migration = await migrateStateToOarRoot({
        targetRoot: layout.root,
        repoServerDir: migrateFromRoot ? path.join(path.resolve(migrateFromRoot), 'server') : null,
        managedConfigDir: getLegacyManagedConfigDir(env),
        logger,
      });
      if (migration.status === 'blocked-live-relay') {
        logger.error?.(`[oar] ${migration.error}`);
        return { code: 1, reason: 'migration-blocked' };
      }
    } catch (error) {
      logger.error?.(`[oar] State migration failed, nothing was changed at the source: ${error?.message || error}`);
      return { code: 1, reason: 'migration-failed', error };
    }
  }

  const lockPath = layout.checkout
    ? path.join(serverDir, 'data', 'relay-server.lock')
    : path.join(layout.dataDir, 'relay-server.lock');
  // One port finds, launches and probes the relay: an explicit --port for this
  // run, else the config's, else 3333. The probe used to take --port (or 3333)
  // while the server started on the config's port, so any mismatch waited out
  // the readiness deadline and killed the relay it had just started.
  const { seedPath } = resolveConfigPaths({ packageRoot, env, layout });
  const configPort = normalizePort(readJsonFile(seedPath)?.port);
  const port = cliPort ?? configPort ?? 3333;
  const statusUrl = `http://localhost:${port}/api/status`;
  const runtimeConfig = resolveLauncherConfig({
    packageRoot,
    env,
    relayPort: port,
    portOverride: cliPort,
    layout,
  });
  // The relay on that port says whether it runs: a lock file says nothing
  // about the port, and can outlive its relay. On a --port other than the
  // config's the lock is left alone: its relay may run on the config's port.
  const probe = { statusUrl, token: runtimeConfig.config.authToken, fetchImpl };
  const answer = configPort && port !== configPort
    ? await probeRelayPort(probe)
    : await probeRelayBehindLock({ ...probe, lockPath, port, isProcessAliveImpl, lockGraceMs, logger });
  if (answer === 'taken') {
    logger.error?.(`[oar] Port ${port} is in use by another program (or by a relay with another token).`);
    logger.error?.('[oar] Stop that program, or pick another port: oar copilot --port <port>');
    return { code: 1, reason: 'port-taken' };
  }
  if (runtimeConfig.managed || !fs.existsSync(runtimeConfig.configPath)) {
    writeJsonFile(runtimeConfig.configPath, runtimeConfig.config);
  }

  const baseEnv = {
    ...env,
    COPILOT_WORKSPACE_ROOT: cwd,
    COPILOT_WEB_RELAY_ROOT: packageRoot,
    COPILOT_WEB_RELAY_SERVER_DIR: serverDir,
    COPILOT_WEB_RELAY_CONFIG: runtimeConfig.configPath,
    COPILOT_WEB_RELAY_LOG_DIR: getLauncherLogDir(env, layout),
    // Checkouts keep the repo-local server/data default; global installs point
    // the server at the OAR root so updates cannot wipe the database.
    ...(layout.checkout ? {} : {
      COPILOT_WEB_RELAY_DATA_DIR: String(env.COPILOT_WEB_RELAY_DATA_DIR || '').trim() || layout.dataDir,
    }),
    GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: String(env.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS || 'true'),
  };

  let serverProc = null;
  let relayStartedByThisCommand = false;
  if (answer === 'oar') {
    logger.log(`Copilot relay is already running at ${statusUrl}.`);
  } else {
    logger.log(`Starting Copilot relay from ${cwd}...`);
    const serverArgs = [path.join(serverDir, 'server.js'), '--token', runtimeConfig.config.authToken, '--port', String(runtimeConfig.config.port)];
    const logDir = getLauncherLogDir(baseEnv);
    const serverLogPath = path.join(logDir, 'server.log');
    const serverErrPath = path.join(logDir, 'server-err.log');
    const serverOutFd = openAppendFileDescriptor(serverLogPath);
    const serverErrFd = openAppendFileDescriptor(serverErrPath);
    try {
      serverProc = spawnImpl(nodeBin, serverArgs, {
        // Global installs run from the OAR state root: on Windows a process
        // pins its cwd, and `npm i -g` (self-update) must be able to replace
        // the package directory. Checkouts keep the repo as cwd.
        cwd: layout.checkout ? packageRoot : layout.root,
        env: baseEnv,
        stdio: ['ignore', serverOutFd, serverErrFd],
        windowsHide: false,
      });
      relayStartedByThisCommand = true;
    } catch (error) {
      try { fs.closeSync(serverOutFd); } catch {}
      try { fs.closeSync(serverErrFd); } catch {}
      logger.error?.(`[oar] Failed to launch relay: ${error?.message || error}`);
      return { code: 1, reason: 'spawn-failed', error };
    }

    if (!(serverProc instanceof EventEmitter) && typeof serverProc?.on !== 'function') {
      return { code: 1, reason: 'spawn-invalid-child' };
    }

    const readyDeadlineMs = 20_000;
    const ready = await new Promise((resolve) => {
      const deadline = Date.now() + readyDeadlineMs;
      const probe = async () => {
        if (serverProc && serverProc.exitCode !== null) {
          resolve(false);
          return;
        }
        try {
          const res = await fetchImpl(statusUrl, {
            headers: { Authorization: `Bearer ${runtimeConfig.config.authToken}` },
          });
          if (res && res.ok) {
            resolve(true);
            return;
          }
        } catch {
          // retry
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(probe, 300);
      };
      probe();
    });

    if (!ready) {
      logger.error?.(`[oar] Relay did not become ready at ${statusUrl}`);
      try {
        if (serverProc && typeof serverProc.kill === 'function') serverProc.kill();
      } catch {}
      try { fs.closeSync(serverOutFd); } catch {}
      try { fs.closeSync(serverErrFd); } catch {}
      return { code: 1, reason: 'server-not-ready' };
    }

    serverProc.once('exit', () => {
      try { fs.closeSync(serverOutFd); } catch {}
      try { fs.closeSync(serverErrFd); } catch {}
    });
  }

  const ghArgs = forwardedArgs.length
    ? ['copilot', '--', ...forwardedArgs]
    : ['copilot'];
  logger.log(`Launching Copilot CLI from ${cwd}...`);

  let child;
  try {
    child = spawnImpl('gh', ghArgs, {
      cwd,
      env: baseEnv,
      stdio: 'inherit',
      windowsHide: false,
    });
  } catch (error) {
    logger.error?.(error?.code === 'ENOENT' ? GH_MISSING_MESSAGE : `[oar] Failed to launch Copilot CLI: ${error?.message || error}`);
    try {
      if (relayStartedByThisCommand && serverProc && typeof serverProc.kill === 'function') serverProc.kill();
    } catch {}
    return { code: 1, reason: 'spawn-failed', error };
  }

  if (!(child instanceof EventEmitter) && typeof child?.on !== 'function') {
    try {
      if (relayStartedByThisCommand && serverProc && typeof serverProc.kill === 'function') serverProc.kill();
    } catch {}
    return { code: 1, reason: 'spawn-invalid-child' };
  }

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
    child.on('error', (error) => {
      logger.error?.(error?.code === 'ENOENT' ? GH_MISSING_MESSAGE : `[oar] Copilot CLI process error: ${error?.message || error}`);
      resolve(1);
    });
  });

  if (relayStartedByThisCommand && serverProc && serverProc.exitCode === null) {
    try {
      serverProc.kill();
    } catch {}
  }

  return { code: exitCode, reason: 'exited' };
}

function readPackageVersion(packageRoot = resolvePackageRoot()) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function canBind(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      // A host this machine does not have (no IPv6) says nothing about the port.
      resolve(error?.code === 'EADDRNOTAVAIL' || error?.code === 'EAFNOSUPPORT');
    });
    probe.once('listening', () => probe.close(() => resolve(true)));
    if (host) probe.listen(port, host);
    else probe.listen(port);
  });
}

function acceptsConnection(port, host, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      // An accepted connection is closed politely: destroying it reaches the
      // listener as a reset, which a program without an error handler on its
      // sockets would take as a fault.
      if (accepted) socket.end();
      else socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

/**
 * A port is free when nothing accepts a connection on it and it can be bound
 * on the loopback addresses and on all interfaces. One wildcard bind is not
 * enough: Windows allows it beside a listener on 127.0.0.1 alone.
 */
export async function isPortFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    if (await acceptsConnection(port, host)) return false;
  }
  for (const host of ['127.0.0.1', '::1', '']) {
    if (!(await canBind(port, host))) return false;
  }
  return true;
}

/** The first free port from `start` on, so a fresh config does not name a port something else holds. */
export async function findFreePort(start = 3333, { attempts = 20, isPortFreeImpl = isPortFree } = {}) {
  for (let port = start; port < start + attempts && port <= 65535; port += 1) {
    if (await isPortFreeImpl(port)) return port;
  }
  return start;
}

function runQuiet(command, args, { spawnSyncImpl = spawnSync } = {}) {
  try {
    const result = spawnSyncImpl(command, args, { stdio: 'ignore', timeout: 15_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

// A systemd *user* manager this process can talk to: absent in containers, on
// macOS, and in a WSL distro without systemd.
function systemdUserAvailable({ platform = process.platform, spawnSyncImpl } = {}) {
  return platform === 'linux' && runQuiet('systemctl', ['--user', 'show-environment'], { spawnSyncImpl });
}

function systemdUnitPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.config', 'systemd', 'user', 'oar.service');
}

async function waitForRelay({ statusUrl, token, fetchImpl = globalThis.fetch, deadlineMs = 20_000, stillStarting = () => true } = {}) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetchImpl(statusUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (res && res.ok) return true;
    } catch {
      // retry
    }
    if (Date.now() >= deadline || !stillStarting()) return false;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * What answers on the relay's port: 'oar' (this relay: its status call accepts
 * the configured token and has the relay's shape; `status` is its answer),
 * 'taken' (something else answers, or holds the port without answering), or
 * 'none'.
 */
async function readRelayStatus({ statusUrl, token = '', fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  if (typeof fetchImpl !== 'function' || !statusUrl) return { answer: 'none', status: null };
  try {
    const response = await fetchImpl(statusUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response) return { answer: 'none', status: null };
    if (!response.ok) return { answer: 'taken', status: null };
    const body = await Promise.resolve(response.json?.()).catch(() => null);
    return body && typeof body === 'object' && 'cliOnline' in body
      ? { answer: 'oar', status: body }
      : { answer: 'taken', status: null };
  } catch (error) {
    // A port that accepts the connection and then stays silent is held too.
    return { answer: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'taken' : 'none', status: null };
  }
}

export async function probeRelayPort(options = {}) {
  return (await readRelayStatus(options)).answer;
}

/**
 * probeRelayPort with patience for the lock file. The relay itself says
 * whether it runs: a lock file can outlive its relay (and its process id can
 * pass to another program), and anything can answer on a port.
 */
async function probeRelayBehindLock({
  statusUrl, token, lockPath, port, fetchImpl, isProcessAliveImpl = isProcessAlive, lockGraceMs = 5000, logger = console,
} = {}) {
  let answer = await probeRelayPort({ statusUrl, token, fetchImpl });
  const lockedByLiveProcess = () => {
    const lock = readRelayLock(lockPath);
    return Number.isInteger(lock?.pid) && isProcessAliveImpl(lock.pid);
  };
  if (answer === 'none' && lockedByLiveProcess()) {
    // A relay that is still starting holds the lock before it listens.
    const deadline = Date.now() + lockGraceMs;
    while (answer === 'none' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      answer = await probeRelayPort({ statusUrl, token, fetchImpl });
    }
    if (answer === 'none' && lockedByLiveProcess()) {
      // Nothing listens: the lock is left over from a relay that did not
      // stop cleanly. The server refuses to start beside a lock whose process
      // id is alive, so it goes first.
      logger.log?.(`[oar] Removing a leftover relay lock (${lockPath}); no relay answers on port ${port}.`);
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
  return answer;
}

/**
 * Makes sure the relay of a global install runs, without a Copilot session
 * tied to it: an already running relay is left alone, an installed systemd
 * user service is started, and anywhere else the server is started detached,
 * so it outlives this command.
 */
export async function ensureRelayRunning({
  packageRoot = resolvePackageRoot(),
  layout,
  configPath,
  config,
  cwd = os.homedir(),
  env = process.env,
  nodeBin = process.execPath,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  fetchImpl = globalThis.fetch,
  isProcessAliveImpl = isProcessAlive,
  lockGraceMs = 5000,
  homeDir = os.homedir(),
  platform = process.platform,
  logger = console,
} = {}) {
  const port = normalizePort(config?.port) ?? 3333;
  const token = String(config?.authToken || '').trim();
  const statusUrl = `http://localhost:${port}/api/status`;
  const logDir = getLauncherLogDir(env, layout);
  const lockPath = path.join(layout.dataDir, 'relay-server.lock');
  const answer = await probeRelayBehindLock({
    statusUrl, token, lockPath, port, fetchImpl, isProcessAliveImpl, lockGraceMs, logger,
  });
  if (answer === 'oar') return { ok: true, how: 'already', logDir };
  if (answer === 'taken') {
    logger.error?.(`[oar] Port ${port} is in use by another program (or by a relay with another token).`);
    logger.error?.('[oar] Stop that program, or pick another port: oar setup --port <port>');
    return { ok: false, how: 'port-taken', logDir };
  }

  if (fs.existsSync(systemdUnitPath(homeDir)) && systemdUserAvailable({ platform, spawnSyncImpl })) {
    runQuiet('systemctl', ['--user', 'daemon-reload'], { spawnSyncImpl });
    if (!runQuiet('systemctl', ['--user', 'enable', '--now', 'oar'], { spawnSyncImpl })) {
      logger.error?.('[oar] systemctl --user enable --now oar failed — see: systemctl --user status oar');
      return { ok: false, how: 'service', logDir };
    }
    return { ok: await waitForRelay({ statusUrl, token, fetchImpl }), how: 'service', logDir };
  }

  const serverDir = path.join(packageRoot, 'server');
  const outFd = openAppendFileDescriptor(path.join(logDir, 'server.log'));
  const errFd = openAppendFileDescriptor(path.join(logDir, 'server-err.log'));
  let child = null;
  try {
    child = spawnImpl(nodeBin, [path.join(serverDir, 'server.js')], {
      cwd: layout.root,
      env: {
        ...env,
        COPILOT_WORKSPACE_ROOT: cwd,
        COPILOT_WEB_RELAY_ROOT: packageRoot,
        COPILOT_WEB_RELAY_SERVER_DIR: serverDir,
        COPILOT_WEB_RELAY_CONFIG: configPath,
        COPILOT_WEB_RELAY_LOG_DIR: logDir,
        COPILOT_WEB_RELAY_DATA_DIR: String(env.COPILOT_WEB_RELAY_DATA_DIR || '').trim() || layout.dataDir,
      },
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
    child.unref?.();
  } catch (error) {
    logger.error?.(`[oar] Failed to launch relay: ${error?.message || error}`);
    return { ok: false, how: 'detached', logDir };
  } finally {
    try { fs.closeSync(outFd); } catch {}
    try { fs.closeSync(errFd); } catch {}
  }
  const ok = await waitForRelay({ statusUrl, token, fetchImpl, stillStarting: () => child.exitCode === null });
  return { ok, how: 'detached', logDir };
}

/**
 * The injectable surroundings of a command: every command builds one from its
 * options, so tests replace the network, the processes and the terminal.
 */
function cliContext(options = {}) {
  const defaults = {
    argv: [],
    env: process.env,
    cwd: process.cwd(),
    logger: console,
    packageRoot: resolvePackageRoot(),
    platform: process.platform,
    homeDir: os.homedir(),
    nodeBin: process.execPath,
    stdin: process.stdin,
    stdout: process.stdout,
    fetchImpl: globalThis.fetch,
    spawnImpl: spawn,
    spawnSyncImpl: spawnSync,
    isProcessAliveImpl: isProcessAlive,
    isPortFreeImpl: isPortFree,
    readFileImpl: fs.readFileSync,
    qrImpl: renderQr,
    restartWaitMs: 60_000,
    stopWaitMs: 30_000,
    pollMs: 300,
  };
  const ctx = { ...defaults };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) ctx[key] = value;
  }
  ctx.prompter = ctx.prompter || createPrompter({ input: ctx.stdin, output: ctx.stdout });
  return ctx;
}

async function renderQr(url) {
  try {
    const qrcode = (await import('qrcode-terminal')).default;
    return await new Promise((resolve) => qrcode.generate(url, { small: true }, resolve));
  } catch {
    // The QR code is a convenience; the URL is the contract.
    return null;
  }
}

/** Where this install keeps its config and its relay's state. */
function installPaths(ctx) {
  const layout = resolveStateLayout({ packageRoot: ctx.packageRoot, env: ctx.env });
  const serverDir = path.join(ctx.packageRoot, 'server');
  const configPath = path.join(layout.checkout ? serverDir : layout.configDir, 'config.json');
  const dataDir = layout.checkout ? path.join(serverDir, 'data') : layout.dataDir;
  return {
    layout,
    configPath,
    dataDir,
    logDir: getLauncherLogDir(ctx.env, layout),
    lockPath: path.join(dataDir, 'relay-server.lock'),
    previousPath: path.join(dataDir, 'relay-previous.json'),
    config: readJsonFile(configPath),
  };
}

function endpointOf(config) {
  const port = normalizePort(config?.port) ?? 3333;
  return { port, token: String(config?.authToken || '').trim(), statusUrl: `http://localhost:${port}/api/status` };
}

/**
 * Finds this install's relay. It answers on the config's port with the
 * config's token, except between a settings change and its restart: then it
 * still answers on the port and token it was started with, which `oar setup`
 * keeps in `relay-previous.json` until the relay has restarted (`stale`).
 */
async function findRelay(ctx, paths) {
  const endpoint = endpointOf(paths.config);
  const found = await readRelayStatus({ ...endpoint, fetchImpl: ctx.fetchImpl });
  const previous = readJsonFile(paths.previousPath);
  if (previous) {
    if (found.answer !== 'oar') {
      const before = endpointOf(previous);
      const earlier = await readRelayStatus({ ...before, fetchImpl: ctx.fetchImpl });
      if (earlier.answer === 'oar') return { ...earlier, endpoint: before, stale: true };
    }
    try { fs.unlinkSync(paths.previousPath); } catch {}
  }
  return { ...found, endpoint, stale: false };
}

function relayIsIdle(status) {
  return (status?.relayShutdown?.status || 'idle') === 'idle';
}

async function pollUntil(check, { waitMs, pollMs }) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Asks the relay to stop or restart itself; it does so once no turn is running. */
async function requestShutdown(ctx, endpoint, restart) {
  try {
    const response = await ctx.fetchImpl(`http://localhost:${endpoint.port}/api/relay/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ restart, reason: 'oar-cli', requestedBy: 'oar-cli' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response?.ok) return null;
    const queue = (await Promise.resolve(response.json?.()).catch(() => null))?.queue || {};
    const busy = ['pendingCount', 'processingCount', 'parkedCount'].some((key) => Number(queue[key]) > 0);
    if (busy) ctx.logger.log('[oar] Waiting for the relay\'s running turns to finish …');
    return { busy };
  } catch {
    return null;
  }
}

/**
 * Restarts this install's running relay so that it reads the config again.
 * The service is restarted by systemd. Any other relay is asked on the port
 * and with the token it runs with (`old`): its supervisor starts a new runtime
 * with the same arguments and environment, and that runtime reads the config
 * file, so a new port, token or access setting applies. Done when the relay
 * answers on the config's port with the config's token.
 */
async function restartRelay(ctx, paths, { old, viaService }) {
  const { logger, fetchImpl } = ctx;
  const next = endpointOf(paths.config);
  if (viaService) {
    runQuiet('systemctl', ['--user', 'daemon-reload'], ctx);
    if (!runQuiet('systemctl', ['--user', 'restart', 'oar'], ctx)) {
      logger.error('[oar] systemctl --user restart oar failed — see: systemctl --user status oar');
      return { ok: false, reason: 'service' };
    }
  } else if (!(await requestShutdown(ctx, old, true))) {
    logger.error('[oar] The relay did not accept the restart request. Restart it from the web UI (⋯ → Restart web relay).');
    return { ok: false, reason: 'restart-refused' };
  }
  const up = await pollUntil(async () => {
    const { answer, status } = await readRelayStatus({ ...next, fetchImpl });
    return answer === 'oar' && relayIsIdle(status);
  }, { waitMs: ctx.restartWaitMs, pollMs: ctx.pollMs });
  if (up) {
    try { fs.unlinkSync(paths.previousPath); } catch {}
    logger.log('[oar] The relay restarted.');
    return { ok: true, reason: 'restarted' };
  }
  const before = await readRelayStatus({ ...old, fetchImpl });
  if (before.answer === 'oar' && !relayIsIdle(before.status)) {
    logger.log('[oar] The relay is still busy; it restarts by itself when its running turns finish.');
    return { ok: true, reason: 'restart-queued' };
  }
  if (before.answer === 'oar' && (old.port !== next.port || old.token !== next.token)) {
    logger.error('[oar] The relay came back on its earlier port and token: it was started with fixed ones (oar copilot). End that session, then run: oar start');
    return { ok: false, reason: 'fixed-settings' };
  }
  logger.error(`[oar] The relay did not come back — see ${path.join(paths.logDir, 'server-err.log')}`);
  return { ok: false, reason: 'server-not-ready' };
}

function windowsAutostart(ctx, paths) {
  return ctx.windowsAutostartImpl || createWindowsAutostartService({
    platform: ctx.platform, env: ctx.env, packageRoot: ctx.packageRoot, nodePath: ctx.nodeBin, configPath: paths.configPath,
  });
}

// Windows can also start the relay at boot, through a scheduled task the web
// UI sets up (it needs an elevation); the command line only reports that one.
async function windowsBootTaskReady(ctx, paths) {
  try {
    const service = ctx.windowsBootAutostartImpl || createWindowsBootAutostartService({
      platform: ctx.platform, env: ctx.env, packageRoot: ctx.packageRoot, nodePath: ctx.nodeBin, configPath: paths.configPath,
    });
    return (await service.getState())?.taskStatus === 'ready';
  } catch {
    return false;
  }
}

/** 'active' (systemd runs the relay), 'installed', 'none', or 'unavailable' on this host. */
async function serviceState(ctx, paths) {
  if (paths.layout.checkout) return 'unavailable';
  if (ctx.platform === 'win32') {
    try {
      return windowsAutostart(ctx, paths).getState().enabled || await windowsBootTaskReady(ctx, paths) ? 'installed' : 'none';
    } catch {
      return 'unavailable';
    }
  }
  if (!systemdUserAvailable(ctx)) return 'unavailable';
  if (!fs.existsSync(systemdUnitPath(ctx.homeDir))) return 'none';
  return runQuiet('systemctl', ['--user', 'is-active', '--quiet', 'oar'], ctx) ? 'active' : 'installed';
}

function writeSystemdUnit(ctx, paths) {
  const unitPath = systemdUnitPath(ctx.homeDir);
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, buildSystemdUnit({
    nodeBin: ctx.nodeBin,
    packageRoot: ctx.packageRoot,
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    pathEnv: buildServicePath({ nodeBin: ctx.nodeBin, envPath: ctx.env.PATH, homeDir: ctx.homeDir }),
  }));
  ctx.logger.log(`[oar] Wrote ${unitPath}`);
  // Lingering keeps the user's services up while nobody is logged in;
  // without it the relay of a headless host stops at logout.
  if (!runQuiet('loginctl', ['enable-linger', ctx.userName || os.userInfo().username], ctx)) {
    ctx.logger.log('[oar] Could not enable lingering — the relay stops when you log out. Enable it with: loginctl enable-linger "$USER"');
  }
}

function startRelay(ctx, paths) {
  return ensureRelayRunning({
    packageRoot: ctx.packageRoot,
    layout: paths.layout,
    configPath: paths.configPath,
    config: paths.config,
    cwd: ctx.cwd,
    env: ctx.env,
    nodeBin: ctx.nodeBin,
    spawnImpl: ctx.spawnImpl,
    spawnSyncImpl: ctx.spawnSyncImpl,
    fetchImpl: ctx.fetchImpl,
    isProcessAliveImpl: ctx.isProcessAliveImpl,
    lockGraceMs: ctx.lockGraceMs,
    homeDir: ctx.homeDir,
    platform: ctx.platform,
    logger: ctx.logger,
  });
}

/**
 * Prints the relay URL and what goes with it. A QR code is printed only for
 * an address a phone can reach, and only where `qr` asks for one.
 */
async function showAddress(ctx, paths, { qr = false, tunnelBase = '' } = {}) {
  const { logger } = ctx;
  const lan = paths.config.localhostOnly === false;
  const address = describeRelayAddress({
    config: paths.config,
    lanAddress: primaryLanAddress(ctx.interfaces),
    wslNat: lan && isWslNat(ctx),
    tunnelBase,
  });
  const printQr = async (url) => {
    const code = qr && url ? await ctx.qrImpl(url) : null;
    if (code) logger.log(code);
  };
  logger.log('');
  logger.log(address.lines[0]);
  await printQr(address.qrUrl);
  for (const line of address.lines.slice(1)) logger.log(line);
  if (address.tunnelUrl) {
    logger.log(`[oar] Tunnel URL: ${address.tunnelUrl}`);
    await printQr(address.tunnelUrl);
  }
}

function warnWindowsPort(ctx, port, windowsHolder = createWindowsPortCheck(ctx)) {
  const holder = windowsHolder(port);
  if (holder) ctx.logger.log(`[oar] ${windowsPortWarning(port, holder)}`);
}

function reportRelayStart(result, logger) {
  // A port held by something else was already explained.
  if (result.how === 'port-taken') return;
  if (!result.ok) {
    logger.error?.(`[oar] The relay did not come up — see ${path.join(result.logDir, 'server-err.log')}`);
    return;
  }
  if (result.how === 'already') {
    logger.log('[oar] The relay is already running. To load a new version, restart it: oar restart');
  } else if (result.how === 'service') {
    logger.log('[oar] The relay is running as a systemd user service (systemctl --user status oar).');
  } else {
    logger.log(`[oar] The relay is running in the background (log: ${path.join(result.logDir, 'server.log')}). After a reboot, start it again with: oar start`);
  }
}

function requireConfig(ctx, paths) {
  if (paths.config) return null;
  ctx.logger.error('[oar] No config yet — run: oar setup');
  return { code: 1, reason: 'no-config' };
}

function reportPortTaken(ctx, paths, port) {
  ctx.logger.error(`[oar] Port ${port} is held by another program, or by a relay with another token.`);
  // A relay that was started before its token was changed in the config
  // cannot be asked to restart: only its lock tells that it is there.
  const pid = readRelayLock(paths.lockPath)?.pid;
  if (Number.isInteger(pid) && ctx.isProcessAliveImpl(pid)) {
    ctx.logger.error(`[oar] A relay of this install seems to run (process ${pid}). If its token is an earlier one, restart it from its web UI (⋯ → Restart web relay), or end that process and run: oar start`);
  }
  return { code: 1, reason: 'port-taken' };
}

/** `oar start` — the relay alone, in the background, without a Copilot session. */
export async function runStart(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const { logger } = ctx;
  if (paths.layout.checkout) {
    logger.error('[oar] This is a git checkout — start the relay with: npm start');
    return { code: 1, reason: 'git-checkout' };
  }
  const missing = requireConfig(ctx, paths);
  if (missing) return missing;
  if ((await findRelay(ctx, paths)).stale) {
    logger.log('[oar] The relay is running with its earlier settings. Apply the new ones with: oar restart');
    return { code: 0, reason: 'started' };
  }
  const result = await startRelay(ctx, paths);
  reportRelayStart(result, logger);
  if (result.ok) await showAddress(ctx, paths);
  warnWindowsPort(ctx, endpointOf(paths.config).port);
  return { code: result.ok ? 0 : 1, reason: result.ok ? 'started' : 'server-not-ready' };
}

/** `oar stop` — systemd stops the service; any other relay stops itself once no turn is running. */
export async function runStop(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const { logger } = ctx;
  const missing = requireConfig(ctx, paths);
  if (missing) return missing;
  if ((await serviceState(ctx, paths)) === 'active') {
    if (!runQuiet('systemctl', ['--user', 'stop', 'oar'], ctx)) {
      logger.error('[oar] systemctl --user stop oar failed — see: systemctl --user status oar');
      return { code: 1, reason: 'service' };
    }
    logger.log('[oar] The relay service is stopped. It starts again at the next login; to take it out: oar service remove');
    return { code: 0, reason: 'stopped' };
  }
  const relay = await findRelay(ctx, paths);
  if (relay.answer === 'none') {
    logger.log('[oar] The relay is not running.');
    return { code: 0, reason: 'not-running' };
  }
  if (relay.answer === 'taken') return reportPortTaken(ctx, paths, relay.endpoint.port);
  if (!(await requestShutdown(ctx, relay.endpoint, false))) {
    logger.error('[oar] The relay did not accept the stop request.');
    return { code: 1, reason: 'stop-refused' };
  }
  const closed = await pollUntil(
    async () => (await probeRelayPort({ ...relay.endpoint, fetchImpl: ctx.fetchImpl })) === 'none',
    { waitMs: ctx.stopWaitMs, pollMs: ctx.pollMs },
  );
  logger.log(closed ? '[oar] The relay is stopped.' : '[oar] The relay is still busy; it stops by itself when its running turns finish.');
  return { code: 0, reason: closed ? 'stopped' : 'stop-queued' };
}

/** `oar restart` — restarts a running relay, starts a stopped one. */
export async function runRestart(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const missing = requireConfig(ctx, paths);
  if (missing) return missing;
  const viaService = (await serviceState(ctx, paths)) === 'active';
  const relay = await findRelay(ctx, paths);
  if (!viaService && relay.answer === 'none') return runStart(options);
  if (!viaService && relay.answer === 'taken') return reportPortTaken(ctx, paths, relay.endpoint.port);
  const outcome = await restartRelay(ctx, paths, { old: relay.endpoint, viaService });
  if (outcome.ok) await showAddress(ctx, paths);
  return { code: outcome.ok ? 0 : 1, reason: outcome.reason };
}

/** What `oar status` and the menu's header show. */
async function collectStatus(ctx, paths = installPaths(ctx)) {
  const status = {
    version: readPackageVersion(ctx.packageRoot),
    relay: 'unconfigured',
    service: await serviceState(ctx, paths),
    warnings: [],
  };
  if (!paths.config) return status;
  const relay = await findRelay(ctx, paths);
  const lan = paths.config.localhostOnly === false;
  const { port } = relay.endpoint;
  status.relay = { oar: 'running', taken: 'taken', none: 'stopped' }[relay.answer];
  status.port = port;
  status.access = lan ? 'lan' : 'local';
  // Without the token: the full URL is `oar url`'s to print.
  status.url = `http://${(lan && primaryLanAddress(ctx.interfaces)) || 'localhost'}:${port}/`;
  if (relay.stale) status.warnings.push('The relay runs with its earlier settings; restart it to apply the new ones.');
  // The built-in tunnel, only when the config switches it on: a running
  // relay reports its state, a stopped one is judged from the config.
  const tunnel = relay.answer === 'oar' && relay.status?.cloudflaredTunnel
    ? describeTunnelState(relay.status.cloudflaredTunnel)
    : describeConfiguredTunnel(paths.config.cloudflaredTunnel, {
      env: ctx.env, platform: ctx.platform, configBaseDir: path.join(ctx.packageRoot, 'server'),
    });
  status.tunnel = tunnel === 'off' || tunnel === 'disabled' ? '' : tunnel;
  const holder = createWindowsPortCheck(ctx)(port);
  if (holder) status.warnings.push(windowsPortWarning(port, holder));
  return status;
}

/** `oar status` — exit code 0 when the relay runs, 3 when it does not. */
export async function runStatus(options = {}) {
  const ctx = cliContext(options);
  const { logger } = ctx;
  const status = await collectStatus(ctx);
  logger.log(`[oar] OAR ${status.version}`);
  if (status.relay === 'unconfigured') {
    logger.log('[oar] Not set up yet — run: oar setup');
    return { code: 3, reason: 'no-config' };
  }
  const access = status.access === 'lan' ? 'LAN access' : 'this machine only';
  if (status.relay === 'running') logger.log(`[oar] The relay is running on port ${status.port} (${access}): ${status.url}`);
  else if (status.relay === 'stopped') logger.log(`[oar] The relay is stopped (port ${status.port}, ${access}). Start it with: oar start`);
  else logger.log(`[oar] Port ${status.port} is held by another program, or by a relay with another token.`);
  if (status.service !== 'unavailable') {
    logger.log(`[oar] Service: ${{ active: 'installed, running', installed: 'installed', none: 'not installed' }[status.service]}`);
  }
  if (status.tunnel) logger.log(`[oar] Tunnel: ${status.tunnel}`);
  for (const warning of status.warnings) logger.log(`[oar] ${warning}`);
  return { code: status.relay === 'running' ? 0 : 3, reason: `relay-${status.relay}` };
}

/** `oar url` — the relay URL, a QR code where a phone can reach it, and the tunnel address a running relay reports. */
export async function runUrl(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const missing = requireConfig(ctx, paths);
  if (missing) return missing;
  const relay = await findRelay(ctx, paths);
  const remoteUrl = String(relay.status?.readyBanner?.remoteUrl || '').replace(/\/+$/, '');
  await showAddress(ctx, paths, { qr: true, tunnelBase: remoteUrl ? `${remoteUrl}${relay.status.remotePath || ''}` : '' });
  if (relay.stale) ctx.logger.log('[oar] The relay runs with its earlier settings until it restarts: oar restart');
  else if (relay.answer !== 'oar') ctx.logger.log('[oar] The relay is not running. Start it with: oar start');
  return { code: 0, reason: 'url' };
}

async function runWindowsService(ctx, paths, action) {
  const { logger } = ctx;
  const autostart = windowsAutostart(ctx, paths);
  const boot = await windowsBootTaskReady(ctx, paths);
  if (action === 'status') {
    const state = boot ? 'on, at boot (scheduled task)' : autostart.getState().enabled ? 'on, at sign-in' : 'off';
    logger.log(`[oar] Autostart: ${state}`);
    return { code: 0, reason: 'service-status' };
  }
  if (boot) {
    logger.error('[oar] The relay starts at boot through a scheduled task. Change that in the web UI: Settings → Autostart.');
    return { code: 1, reason: 'boot-task' };
  }
  if (action === 'install' && requireConfig(ctx, paths)) return { code: 1, reason: 'no-config' };
  autostart.setEnabled(action === 'install');
  logger.log(action === 'install'
    ? '[oar] The relay now starts when you sign in to Windows. Start it now with: oar start'
    : '[oar] Autostart is off. A running relay keeps running; stop it with: oar stop');
  return { code: 0, reason: `service-${action}` };
}

/** `oar service install|remove|status` — the systemd user service on Linux, the autostart entry on Windows. */
export async function runService(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const { logger } = ctx;
  const action = ctx.argv.find((arg) => ['install', 'remove', 'status'].includes(arg)) || 'status';
  if (paths.layout.checkout) {
    logger.error('[oar] This is a git checkout — the service is for global installs.');
    return { code: 1, reason: 'git-checkout' };
  }
  if (ctx.platform === 'win32') return runWindowsService(ctx, paths, action);
  if (ctx.platform !== 'linux') {
    logger.error(`[oar] The service is not supported on ${ctx.platform === 'darwin' ? 'macOS' : ctx.platform} yet. Start the relay with: oar start`);
    return { code: 1, reason: 'unsupported' };
  }
  if (!systemdUserAvailable(ctx)) {
    const wslHint = isWsl(ctx) ? ' In WSL, switch systemd on: systemd=true under [boot] in /etc/wsl.conf, then restart the distro (from Windows: wsl --terminate <distro>).' : '';
    logger.error(`[oar] No systemd user session here, so there is no service to install.${wslHint} Start the relay with: oar start`);
    return { code: 1, reason: 'no-systemd' };
  }
  const unitPath = systemdUnitPath(ctx.homeDir);
  const state = await serviceState(ctx, paths);
  if (action === 'status') {
    logger.log(`[oar] Service: ${{ active: 'installed, running', installed: 'installed, not running', none: 'not installed' }[state]}`);
    return { code: 0, reason: 'service-status' };
  }
  if (action === 'remove') {
    if (state === 'none') {
      logger.log('[oar] The service is not installed.');
      return { code: 0, reason: 'service-remove' };
    }
    runQuiet('systemctl', ['--user', 'disable', '--now', 'oar'], ctx);
    try { fs.unlinkSync(unitPath); } catch {}
    runQuiet('systemctl', ['--user', 'daemon-reload'], ctx);
    logger.log(`[oar] Removed ${unitPath}; the relay is stopped. Start it by hand with: oar start`);
    return { code: 0, reason: 'service-remove' };
  }
  const missing = requireConfig(ctx, paths);
  if (missing) return missing;
  writeSystemdUnit(ctx, paths);
  runQuiet('systemctl', ['--user', 'daemon-reload'], ctx);
  if (state !== 'active' && (await findRelay(ctx, paths)).answer === 'oar') {
    // A relay started by hand holds the port and the lock: it makes way first.
    if ((await runStop({ ...options, argv: [] })).reason !== 'stopped') {
      runQuiet('systemctl', ['--user', 'enable', 'oar'], ctx);
      logger.log('[oar] The service is installed and takes over at the next login, or once the relay has stopped: oar start');
      return { code: 0, reason: 'service-install' };
    }
  }
  const result = await startRelay(ctx, paths);
  reportRelayStart(result, logger);
  return { code: result.ok ? 0 : 1, reason: result.ok ? 'service-install' : 'server-not-ready' };
}

function optionValue(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name) return String(argv[index + 1] ?? '');
    if (String(argv[index]).startsWith(`${name}=`)) return String(argv[index]).slice(name.length + 1);
  }
  return undefined;
}

function strictPort(text) {
  return /^\d+$/.test(String(text).trim()) ? normalizePort(text) : null;
}

/**
 * `oar setup` — writes the config: auth token, access (this machine only or
 * LAN) and port. In a terminal it asks, showing the current value; `--port`,
 * `--lan`, `--local` and `--new-token` set a value without a question, and
 * `--defaults` keeps (or, for a new config, picks) everything. A running relay
 * is restarted when one of the three changed. `--start` is the installer's
 * mode: it also installs the service where it can and starts the relay.
 */
export async function runSetup(options = {}) {
  const ctx = cliContext(options);
  const { argv, env, logger, prompter } = ctx;
  const has = (flag) => argv.includes(flag);
  const portText = optionValue(argv, '--port');
  const portFlag = portText === undefined ? null : strictPort(portText);
  if (portText !== undefined && !portFlag) {
    logger.error('[oar] --port expects a number from 1 to 65535.');
    return { code: 2, reason: 'bad-port' };
  }
  if (has('--lan') && has('--local')) {
    logger.error('[oar] --lan and --local exclude each other.');
    return { code: 2, reason: 'bad-access' };
  }
  const terminal = Boolean(ctx.stdin?.isTTY) && !has('--defaults');
  const ask = terminal && !portFlag && !has('--lan') && !has('--local') && !has('--new-token');

  let paths = installPaths(ctx);
  const { layout } = paths;
  if (!layout.checkout) {
    const migrateFromRoot = String(optionValue(argv, '--migrate-from') || '').trim();
    const migration = await migrateStateToOarRoot({
      targetRoot: layout.root,
      repoServerDir: migrateFromRoot ? path.join(path.resolve(migrateFromRoot), 'server') : null,
      managedConfigDir: getLegacyManagedConfigDir(env),
      logger,
    });
    if (migration.status === 'blocked-live-relay') {
      logger.error?.(`[oar] ${migration.error}`);
      return { code: 1, reason: 'migration-blocked' };
    }
    if (migration.status === 'migrated') {
      logger.log(`[oar] Migrated existing relay state into ${layout.root} (sources untouched).`);
      paths = installPaths(ctx);
    }
  }

  const existing = paths.config;
  const relay = existing ? await findRelay(ctx, paths) : null;
  const running = relay?.answer === 'oar';
  const old = relay?.endpoint || null;
  const windowsHolder = createWindowsPortCheck(ctx);
  // A port must be free here and, in WSL, on Windows; the one this install's
  // own running relay holds is fine.
  const portProblem = async (port) => {
    if (running && port === old.port) return null;
    if (!(await ctx.isPortFreeImpl(port))) return `Port ${port} is in use by another program.`;
    const holder = windowsHolder(port);
    return holder ? `Port ${port} is in use on Windows (${holder}).` : null;
  };

  let token = String(existing?.authToken || '').trim();
  if (!token || has('--new-token')
    || (ask && await prompter.yesNo('New auth token? It signs every device out.', { defaultYes: false }))) {
    token = generateAuthToken();
  }

  let lan = existing?.localhostOnly === false;
  if (has('--lan') || has('--local')) {
    lan = has('--lan');
  } else if (ask) {
    for (;;) {
      const answer = await prompter.line(`Access: 1 = this machine only, 2 = LAN (other devices on your network) [${lan ? 2 : 1}]: `);
      if (answer === '1' || answer === '2') lan = answer === '2';
      if (['', '1', '2'].includes(answer)) break;
    }
  }

  const currentPort = existing ? normalizePort(existing.port) : null;
  let port = portFlag;
  if (port) {
    const problem = await portProblem(port);
    if (problem) {
      logger.error(`[oar] ${problem} Pick another port.`);
      return { code: 1, reason: 'port-taken' };
    }
  } else {
    port = currentPort ?? await findFreePort(3333, { isPortFreeImpl: async (candidate) => !(await portProblem(candidate)) });
    if (!currentPort && port !== 3333) logger.log(`[oar] Port 3333 is in use${windowsHolder(3333) ? ' on Windows' : ''} — using ${port}.`);
    while (ask) {
      const answer = await prompter.line(`Port [${port}]: `);
      if (!answer) break;
      const chosen = strictPort(answer);
      const problem = !chosen ? 'A port is a number from 1 to 65535.' : chosen === currentPort ? null : await portProblem(chosen);
      if (!problem) {
        port = chosen;
        break;
      }
      logger.log(`[oar] ${problem}`);
    }
  }

  const config = { ...buildDefaultConfig({ token }), ...(existing || {}), authToken: token, localhostOnly: !lan, port };
  // What the running relay would have to pick up. Its own status says how it
  // listens, whatever the config said when it started.
  const endpointChanged = running && (token !== old.token || port !== old.port);
  const changed = endpointChanged || (running && lan !== (relay.status.localhostOnly === false));
  fs.mkdirSync(path.dirname(paths.configPath), { recursive: true });
  fs.writeFileSync(paths.configPath, `${JSON.stringify(config, null, 2)}\n`);
  if (ctx.platform !== 'win32') {
    try { fs.chmodSync(paths.configPath, 0o600); } catch {}
  }
  logger.log(`[oar] Wrote ${paths.configPath}`);
  paths = { ...paths, config };
  if (endpointChanged) {
    // Until the relay has restarted it answers only on its earlier port and token.
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.writeFileSync(paths.previousPath, `${JSON.stringify({ port: old.port, authToken: old.token })}\n`, { mode: 0o600 });
  }

  const startRequested = has('--start') && !layout.checkout;
  const viaService = running && (await serviceState(ctx, paths)) === 'active';
  if (startRequested && systemdUserAvailable(ctx)) writeSystemdUnit(ctx, paths);

  let outcome = null;
  if (changed) {
    if (!terminal || await prompter.yesNo('The relay is running. Restart it now to apply the change?', { defaultYes: true })) {
      outcome = await restartRelay(ctx, paths, { old, viaService });
    } else {
      logger.log('[oar] The running relay keeps its earlier settings until it restarts: oar restart');
    }
  } else if (startRequested) {
    const started = await startRelay(ctx, paths);
    reportRelayStart(started, logger);
    outcome = { ok: started.ok, reason: started.ok ? 'setup-complete' : 'server-not-ready' };
  }

  await showAddress(ctx, paths, { qr: true });
  warnWindowsPort(ctx, port, windowsHolder);
  if (outcome) return { code: outcome.ok ? 0 : 1, reason: outcome.ok ? 'setup-complete' : outcome.reason };
  if (layout.checkout) {
    logger.log('[oar] Start the relay with: npm start');
  } else if (!running) {
    const atLogin = (await serviceState(ctx, paths)) === 'none' ? '  (at every login: oar service install)' : '';
    logger.log(`[oar] Start the relay with: oar start${atLogin}`);
  }
  return { code: 0, reason: 'setup-complete' };
}

export async function runDoctor(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const dbPath = path.join(paths.dataDir, 'copilot.db');

  let dbSizeBytes = null;
  try { dbSizeBytes = fs.statSync(dbPath).size; } catch {}

  const probes = DOCTOR_PROBES.map((probe) => {
    try {
      const result = ctx.spawnSyncImpl(probe.binary, probe.args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
      const ok = result.status === 0;
      const version = ok ? String(result.stdout || '').trim().split('\n')[0].slice(0, 60) : '';
      return { id: probe.id, ok, version };
    } catch {
      return { id: probe.id, ok: false };
    }
  });
  probes.push({ id: 'cursor', ok: true, version: 'bundled (@cursor/sdk)' });

  const port = endpointOf(paths.config).port;
  const holder = paths.config ? createWindowsPortCheck(ctx)(port) : null;
  ctx.logger.log(renderDoctorReport({
    version: readPackageVersion(ctx.packageRoot),
    nodeVersion: process.version,
    platform: ctx.platform,
    layout: paths.layout,
    configPath: paths.configPath,
    config: paths.config,
    dbPath,
    dbSizeBytes,
    probes,
    warnings: holder ? [windowsPortWarning(port, holder)] : [],
    // The relay resolves a relative cloudflaredTunnel.binary against server/.
    tunnel: describeConfiguredTunnel(paths.config?.cloudflaredTunnel, { env: ctx.env, configBaseDir: path.join(ctx.packageRoot, 'server') }),
  }));
  return { code: 0, reason: 'doctor' };
}

/**
 * `oar update [--beta] [--to X.Y.Z]` — the terminal twin of the web UI's
 * Update button. Fetching the manifest here is an explicit user action, so it
 * happens regardless of the relay's opt-in auto-check setting.
 */
async function runUpdate({ argv = [], env = process.env, logger = console, fetchImpl = globalThis.fetch, spawnImpl = spawn } = {}) {
  const { channelForVersion, compareSemverIsh, parseSemverIsh } = await import('../shared/update-semver.mjs');
  const packageRoot = resolvePackageRoot();
  const runningVersion = readPackageVersion(packageRoot);

  if (isGitCheckout(packageRoot)) {
    logger.error('[oar] This install runs from a git checkout — update with git pull, then restart the relay.');
    return { code: 1, reason: 'git-checkout' };
  }

  const toIdx = argv.indexOf('--to');
  let target = toIdx !== -1 ? String(argv[toIdx + 1] || '').trim() : '';
  if (target && !parseSemverIsh(target)) {
    logger.error(`[oar] --to expects a release version like 0.9.2, got "${target}".`);
    return { code: 1, reason: 'bad-target' };
  }
  if (!target) {
    // The kill switch means "never phone home from this host", so it blocks
    // the manifest fetch too — an explicit `--to X.Y.Z` still works because
    // that path talks only to the npm registry the install already uses.
    if (String(env.OAR_NO_UPDATE_CHECK || '').trim() === '1') {
      logger.error('[oar] Update checks are disabled on this host (OAR_NO_UPDATE_CHECK). Use `oar update --to X.Y.Z` to update to a known version.');
      return { code: 1, reason: 'check-killed' };
    }
    const manifestUrl = String(env.OAR_UPDATE_MANIFEST_URL || '').trim() || 'https://oar.sh/latest.json';
    let manifest = null;
    try {
      const response = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout?.(5000) });
      manifest = response?.ok ? await response.json() : null;
    } catch {}
    if (!manifest) {
      logger.error(`[oar] Could not fetch ${manifestUrl}.`);
      return { code: 1, reason: 'manifest-unreachable' };
    }
    if (manifest.schemaVersion !== 1) {
      logger.error(`[oar] ${manifestUrl} has schemaVersion ${manifest.schemaVersion}, which this oar does not understand — update manually.`);
      return { code: 1, reason: 'manifest-unsupported' };
    }
    const channel = argv.includes('--beta') ? 'beta' : channelForVersion(runningVersion);
    target = String(manifest.channels?.[channel]?.version || manifest.channels?.stable?.version || '').trim();
    if (!parseSemverIsh(target)) {
      logger.error('[oar] The update manifest carries no usable version.');
      return { code: 1, reason: 'manifest-empty' };
    }
    if (compareSemverIsh(target, runningVersion) <= 0) {
      logger.log(`[oar] Already up to date (${runningVersion}).`);
      return { code: 0, reason: 'up-to-date' };
    }
  }

  logger.log(`[oar] Updating @oar-sh/oar ${runningVersion} -> ${target} ...`);
  const npm = resolveNpmInvocation({ packageRoot, env });
  const exitCode = await new Promise((resolve) => {
    const child = spawnImpl(npm.command, ['install', '-g', ...npm.prefixArgs, NPM_ALLOW_SCRIPTS_ARG, `@oar-sh/oar@${target}`], {
      stdio: 'inherit',
      env: npm.env,
      ...(process.platform === 'win32' ? { shell: true, windowsHide: true } : {}),
    });
    child.on('error', (error) => {
      logger.error(`[oar] npm spawn failed: ${error?.message || error}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) {
    logger.error('[oar] npm install failed; the running install is unchanged.');
    return { code: 1, reason: 'npm-failed' };
  }
  logger.log(`[oar] Installed @oar-sh/oar@${target}.`);

  // A running relay picks the new code up on restart; ask for the queue-idle
  // deferred one so no in-flight turn is cut off.
  const layout = resolveStateLayout({ packageRoot, env });
  const configPath = layout.checkout
    ? path.join(packageRoot, 'server', 'config.json')
    : path.join(layout.configDir, 'config.json');
  const config = readJsonFile(configPath);
  const port = Number(config?.port) || 3333;
  const lockPath = layout.checkout
    ? path.join(packageRoot, 'server', 'data', 'relay-server.lock')
    : path.join(layout.dataDir, 'relay-server.lock');
  const running = await detectRunningRelay({ lockPath, statusUrl: `http://localhost:${port}/api/status`, fetchImpl });
  if (!running.running) {
    logger.log('[oar] No running relay detected — the update loads on the next start.');
    return { code: 0, reason: 'updated' };
  }
  const token = String(running.lock?.token || config?.authToken || '').trim();
  try {
    const response = await fetchImpl(`http://localhost:${port}/api/relay/shutdown`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ reason: 'self-update-cli', requestedBy: 'oar-update', restart: true }),
      signal: AbortSignal.timeout?.(5000),
    });
    if (response?.ok) {
      logger.log('[oar] Relay restart requested — it restarts once the queue is idle.');
    } else {
      logger.log('[oar] Could not request a relay restart; restart it manually to load the update.');
    }
  } catch {
    logger.log('[oar] Could not request a relay restart; restart it manually to load the update.');
  }
  return { code: 0, reason: 'updated' };
}

/** `oar` without a command: the menu in a terminal, the status and the usage elsewhere. */
async function runMenuCommand(options = {}) {
  const ctx = cliContext(options);
  if (!ctx.stdin?.isTTY || !ctx.stdout?.isTTY) {
    await runStatus(options);
    ctx.logger.log('');
    ctx.logger.log(usageText());
    return { code: 0, reason: 'status' };
  }
  const run = (command) => () => command({ ...options, argv: [] });
  return runMenu({
    input: ctx.stdin,
    output: ctx.stdout,
    env: ctx.env,
    loadStatus: () => collectStatus(ctx),
    actions: {
      start: run(runStart),
      stop: run(runStop),
      restart: run(runRestart),
      url: run(runUrl),
      setup: run(runSetup),
      doctor: run(runDoctor),
      copilot: run(launchRelay),
      service: async (status) => {
        const action = { none: 'install', unavailable: 'status' }[status.service] || 'remove';
        if (action === 'remove' && !(await ctx.prompter.yesNo('Remove the service?', { defaultYes: false }))) return null;
        return runService({ ...options, argv: [action] });
      },
      // The files of the running menu were just replaced.
      update: async () => ((await runUpdate({ ...options, argv: [] })).reason === 'updated' ? { exit: true } : null),
    },
  });
}

const COMMANDS = {
  menu: runMenuCommand,
  start: runStart,
  stop: runStop,
  restart: runRestart,
  status: runStatus,
  url: runUrl,
  setup: runSetup,
  service: runService,
  copilot: launchRelay,
  doctor: runDoctor,
  update: runUpdate,
  help: async ({ logger = console } = {}) => {
    logger.log(usageText());
    return { code: 0, reason: 'help' };
  },
  version: async ({ logger = console } = {}) => {
    logger.log(readPackageVersion());
    return { code: 0, reason: 'version' };
  },
};

/**
 * Runs the command the arguments name. Anything `oar` does not know prints
 * the usage and exits 2; Ctrl+C in a prompt or in the menu exits 130.
 */
async function main(options = {}) {
  const logger = options.logger || console;
  const parsed = parseCliArgs(options.argv || process.argv.slice(2));
  if (parsed.error) {
    logger.error(`[oar] ${parsed.error}`);
    logger.error(usageText());
    return { code: 2, reason: 'usage' };
  }
  try {
    return await { ...COMMANDS, ...options.commands }[parsed.command]({ ...options, argv: parsed.args });
  } catch (error) {
    if (error instanceof PromptAborted) return { code: 130, reason: 'interrupted' };
    throw error;
  }
}

/**
 * Ends the command with `code` once the event loop has nothing left to do.
 * `process.exit()` right after a request to the relay cuts into the
 * connection's teardown, and on Windows that aborts the process with a libuv
 * assertion instead of the exit code. The timer is unreferenced, so it only
 * fires when something else still holds the loop.
 */
export function exitWhenIdle(code, { processImpl = process, setTimeoutImpl = setTimeout, graceMs = 3000 } = {}) {
  processImpl.exitCode = code;
  const timer = setTimeoutImpl(() => processImpl.exit(code), graceMs);
  timer?.unref?.();
  return timer;
}

// Run main() when this file is the process entrypoint. npm bin shims make
// argv[1] a symlink named plain `oar`, so compare real paths first and fall
// back to the shim basename — a bare basename === 'oar.js' check silently
// no-ops for every global install.
const selfPath = fileURLToPath(import.meta.url);
const invokedPath = (() => {
  const raw = String(process.argv[1] || '');
  if (!raw) return '';
  try { return fs.realpathSync(raw); } catch { return raw; }
})();
const invokedName = invokedPath ? path.basename(invokedPath) : '';
if (invokedPath === selfPath || invokedName === 'oar.js' || invokedName === 'oar') {
  main().then(({ code }) => {
    exitWhenIdle(code ?? 0);
  }).catch((error) => {
    console.error(`[oar] Unhandled error: ${error?.message || error}`);
    exitWhenIdle(1);
  });
}

export { main, parsePort, readRelayLock, resolvePackageRoot };
