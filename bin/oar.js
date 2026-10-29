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
} from '../server/services/oar-state-migration-service.mjs';
import { readConfiguredDataDir, resolveDataDir, resolveUploadDir } from '../server/services/data-dir-resolution.mjs';
import { RESCUE_DIR_NAME, TAKEOVER_PROGRESS_FILE } from '../server/services/earlier-database-service.mjs';
import { DB_FILE_NAME, DB_FILE_NAMES, LEGACY_DB_FILE_NAME, resolveDatabaseFile } from '../server/services/database-file.mjs';
import { BACKUP_PROGRESS_FILE, BACKUP_WAIT_FILE, backupDatabase, configWarnings, describeBackups, sanitizeReason } from '../server/services/db-backup-service.mjs';
import { defaultIsProcessAlive, lockHolderMayRun, processIdentity } from '../server/services/relay-singleton-guard.mjs';
import {
  getLauncherLogDir,
  getLegacyManagedConfigDir,
  isGitCheckout,
  resolveRelayStateDirs,
  resolveStateLayout,
} from '../server/services/oar-state-layout.mjs';
import {
  buildDefaultConfig, buildServicePath, buildSystemdUnit, classifySystemdUnit, describeRelayAddress, DOCTOR_PROBES, generateAuthToken,
  listSystemdDropIns, NPM_ALLOW_SCRIPTS_ARG, parseCliArgs, parseSystemdVersion, primaryLanAddress, renderDoctorReport,
  resolveNpmInvocation, systemdUnitMarkerRoot, systemdUnitRunsCheckout, usageText,
} from '../server/services/oar-cli-helpers.mjs';
import { describeConfiguredTunnel, describeTunnelState } from '../server/services/cloudflared-tunnel-service.mjs';
import { createPrompter, PromptAborted, runMenu } from '../server/services/oar-cli-menu.mjs';
import { createWindowsPortCheck, isWsl, isWslNat, windowsPortWarning } from '../server/services/oar-cli-wsl.mjs';
import { readEnvValue, windowsSystemToolPath } from '../shared/windows-system-tools.mjs';
import { createProcessLister } from '../server/services/process-list-service.mjs';
import { backupPathFor, createWindowsAutostartService, launcherScriptsMatch } from '../server/services/windows-autostart-service.mjs';
import {
  BOOT_ELEVATION_SCRIPT_FILENAME, BOOT_TASK_XML_FILENAME,
  bootTaskLabel, createWindowsBootAutostartService, describeHandMade, describeWindowsAutostart, handMadeLines, switchBlockers,
} from '../server/services/windows-boot-autostart-service.mjs';

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
      format: Number(parsed?.format) || 0,
    };
  } catch {
    return null;
  }
}

// What a relay that holds its lock and does not answer yet is bringing over
// (earlier-database-service), or null: the progress file names the lock's
// pid, and that pid is the lock's holder still (lockHolderMayRun: a pid
// reused after a crash is not).
function readTakeover(lockPath, isProcessAliveImpl = isProcessAlive) {
  const lock = readJsonFile(lockPath);
  if (!lockHolderMayRun({ lock, isProcessAlive: isProcessAliveImpl })) return null;
  // Also while it compares two database files, backs its database up, or
  // waits for an `oar backup` to finish first; each file counts only with
  // the lock's pid (one a crash left does not).
  for (const name of [TAKEOVER_PROGRESS_FILE, BACKUP_PROGRESS_FILE, BACKUP_WAIT_FILE]) {
    const progress = readJsonFile(path.join(path.dirname(lockPath), name));
    const pid = Number.parseInt(String(progress?.pid ?? ''), 10);
    if (Number.isInteger(pid) && Number(lock?.pid) === pid) return progress;
  }
  return null;
}

// The lock a relay that did not come up found held, and whether its holder
// is known to be a relay (its recorded identity matches): only when it is
// not may the user delete the lock. Null when no live process holds it.
function heldLock(lockPath, isProcessAliveImpl = isProcessAlive) {
  const lock = readJsonFile(lockPath);
  const pid = Number.parseInt(String(lock?.pid ?? ''), 10);
  if (!Number.isInteger(pid) || !lockHolderMayRun({ lock, isProcessAlive: isProcessAliveImpl })) return null;
  return { pid, path: lockPath, startedAt: lock.startedAt || 'unknown', known: !!lock.holder && !!processIdentity(pid) };
}

function takeoverLine(takeover, logDir) {
  const what = takeover ? ` (${takeover.from}, ${Math.max(1, Math.round(Number(takeover.bytes || 0) / 1048576))} MB)` : '';
  const doing = {
    backup: `is backing up its database${what} before this version's migrations`,
    compare: `is comparing its two database files${what}`,
    'wait-backup': `is waiting for \`oar backup\` (process ${takeover?.waitingFor}) to finish before its own backup`,
  }[takeover?.task] || `is bringing over the database it ran on until now${what}`;
  return `[oar] The relay${takeover ? ` (process ${takeover.pid})` : ''} ${doing} and is still running; it answers once that is done. Its log: ${path.join(String(logDir || ''), 'server.log')}`;
}

// As the server tells it: a process this user may not signal (EPERM) lives.
function isProcessAlive(pid) {
  return defaultIsProcessAlive(pid);
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

/**
 * Brings pre-OAR state into a global install's state root. Without
 * --migrate-from it runs quietly, once; with it, it runs unless that source
 * was migrated already, never overwrites, and says what it did or why it did
 * nothing. Database and uploads go where the relay `oar` starts will read
 * them, resolved as the relay resolves them. Returns null to go on, or the
 * result to stop with. A refusal stops only `oar setup` (`strict`): `oar
 * copilot` warns and starts the session on the state root as it is.
 */
async function migrateIntoStateRoot({
  layout, env, packageRoot, migrateFrom = '', logger, isProcessAliveImpl = isProcessAlive, strict = true,
}) {
  const serverDir = path.join(packageRoot, 'server');
  const relayEnv = { COPILOT_WEB_RELAY_DATA_DIR: resolveRelayStateDirs({ env, layout }).dataDir };
  const dataDir = resolveDataDir({ env: relayEnv, serverDir });
  const source = migrateFrom ? path.resolve(migrateFrom) : '';
  let migration;
  try {
    migration = await migrateStateToOarRoot({
      targetRoot: layout.root,
      targetDataDir: dataDir,
      targetUploadDir: resolveUploadDir({ dataDir, env: relayEnv, serverDir }),
      repoServerDir: source ? path.join(source, 'server') : null,
      managedConfigDir: getLegacyManagedConfigDir(env),
      isProcessAliveImpl,
    });
  } catch (error) {
    logger.error?.(`[oar] State migration failed, nothing was changed at the source: ${error?.message || error}`);
    return { code: 1, reason: 'migration-failed', error };
  }
  const refused = (message, reason) => {
    logger.error?.(`[oar] ${message}`);
    if (strict) return { code: 1, reason };
    logger.error?.('[oar] Nothing was migrated; starting on the state root as it is.');
    return null;
  };
  switch (migration.status) {
    case 'blocked-live-relay': return refused(migration.error, 'migration-blocked');
    case 'refused-relay-running': return refused(migration.error, 'migration-relay-running');
    case 'refused-existing-database': return refused(migration.error, 'migration-refused');
    case 'nothing-to-migrate':
      return source ? refused(`Nothing to migrate from ${source}: ${migration.reason}.`, 'migration-nothing') : null;
    case 'already-migrated':
      if (source) logger.log?.(`[oar] ${layout.root} is already migrated from ${source}; nothing to do.`);
      return null;
    case 'migrated':
      if (migration.movedAsideTo) {
        logger.log?.(`[oar] The state root's database had no conversations yet (a fresh one); moved it aside to ${migration.movedAsideTo}.`);
      }
      logger.log?.(`[oar] Migrated ${source || 'earlier relay state'} into ${layout.root} (${migration.copied} items, sources untouched; receipt in backups/MIGRATION.md).`);
      for (const kept of migration.kept || []) {
        logger.log?.(`[oar] Kept the existing ${kept}; the one from the source was not copied.`);
      }
      for (const link of migration.skipped || []) {
        logger.log?.(`[oar] Skipped the link ${link}: what it points to was not copied.`);
      }
      return null;
    default:
      return null;
  }
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
  readyWaitMs = 20_000,
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
    // (once, or as --migrate-from asks); a live source relay blocks it.
    const stop = await migrateIntoStateRoot({
      layout, env, packageRoot, migrateFrom: migrateFromRoot, logger, isProcessAliveImpl, strict: false,
    });
    if (stop) return stop;
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
    logger.error?.(`[oar] Port ${port} is in use by another program, or by a relay with another token.`);
    logger.error?.('[oar] Stop that program, or pick another port: oar copilot --port <port>');
    return { code: 1, reason: 'port-taken' };
  }
  if (answer === 'bringing-over') {
    logger.log(takeoverLine(readTakeover(lockPath, isProcessAliveImpl), getLauncherLogDir(env, layout)));
    return { code: 1, reason: 'bringing-over' };
  }
  if (runtimeConfig.managed || !fs.existsSync(runtimeConfig.configPath)) {
    writeJsonFile(runtimeConfig.configPath, runtimeConfig.config);
  }

  // Checkouts keep the repo-local server/data default; global installs point
  // the server at the OAR root so updates cannot wipe the database.
  const stateDirs = resolveRelayStateDirs({ env, layout });
  const baseEnv = {
    ...env,
    COPILOT_WORKSPACE_ROOT: cwd,
    COPILOT_WEB_RELAY_ROOT: packageRoot,
    COPILOT_WEB_RELAY_SERVER_DIR: serverDir,
    COPILOT_WEB_RELAY_CONFIG: runtimeConfig.configPath,
    COPILOT_WEB_RELAY_LOG_DIR: getLauncherLogDir(env, layout),
    ...(stateDirs.dataDir ? { COPILOT_WEB_RELAY_DATA_DIR: stateDirs.dataDir } : {}),
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

    const readyDeadlineMs = readyWaitMs;
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

    const takeover = ready ? null : readTakeover(lockPath, isProcessAliveImpl);
    if (takeover) {
      // Left running: a kill would cut the copy short for nothing.
      logger.log(takeoverLine(takeover, logDir));
      try { fs.closeSync(serverOutFd); } catch {}
      try { fs.closeSync(serverErrFd); } catch {}
      return { code: 1, reason: 'bringing-over' };
    }
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
    if (answer === 'none' && readTakeover(lockPath, isProcessAliveImpl)) return 'bringing-over';
    // A lock this version wrote is left to the server, which tells a reused
    // process id itself (lockHolderMayRun): removed here, a second relay
    // started beside one still bringing over its database.
    if (answer === 'none' && lockedByLiveProcess() && !readRelayLock(lockPath)?.format) {
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
 * Makes sure the relay of an install runs, without a Copilot session tied to
 * it: an already running relay is left alone, an installed systemd user
 * service is started, and anywhere else the server of a global install is
 * started detached, so it outlives this command. `serviceInstalled` says
 * whether the unit there is this install's (unset: any unit is); `lockPath`
 * is the relay's lock (default: in the layout's data folder).
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
  readyWaitMs = 20_000,
  homeDir = os.homedir(),
  platform = process.platform,
  logger = console,
  serviceInstalled = null,
  lockPath = path.join(layout.dataDir, 'relay-server.lock'),
} = {}) {
  const port = normalizePort(config?.port) ?? 3333;
  const token = String(config?.authToken || '').trim();
  const statusUrl = `http://localhost:${port}/api/status`;
  const logDir = getLauncherLogDir(env, layout);
  const answer = await probeRelayBehindLock({
    statusUrl, token, lockPath, port, fetchImpl, isProcessAliveImpl, lockGraceMs, logger,
  });
  if (answer === 'oar') return { ok: true, how: 'already', logDir };
  if (answer === 'bringing-over') return { ok: false, how: 'bringing-over', logDir, takeover: readTakeover(lockPath, isProcessAliveImpl) };
  if (answer === 'taken') {
    logger.error?.(`[oar] Port ${port} is in use by another program, or by a relay with another token.`);
    logger.error?.('[oar] Stop that program, or pick another port: oar setup --port <port>');
    return { ok: false, how: 'port-taken', logDir };
  }

  const unitThere = serviceInstalled ?? fs.existsSync(systemdUnitPath(homeDir));
  if (unitThere && systemdUserAvailable({ platform, spawnSyncImpl })) {
    runQuiet('systemctl', ['--user', 'daemon-reload'], { spawnSyncImpl });
    // A unit that failed (a crash loop, a stop on purpose) is started afresh,
    // with its restart backoff from the start.
    runQuiet('systemctl', ['--user', 'reset-failed', 'oar'], { spawnSyncImpl });
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
        COPILOT_WEB_RELAY_DATA_DIR: resolveRelayStateDirs({ env, layout }).dataDir,
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
  const ok = await waitForRelay({ statusUrl, token, fetchImpl, deadlineMs: readyWaitMs, stillStarting: () => child.exitCode === null });
  const takeover = ok ? null : readTakeover(lockPath, isProcessAliveImpl);
  if (takeover) return { ok: false, how: 'bringing-over', logDir, takeover };
  return { ok, how: 'detached', logDir, ...(ok ? {} : { lock: heldLock(lockPath, isProcessAliveImpl) }) };
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
    pid: process.pid,
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

// The data folder the relay of this install runs on: in a checkout as the
// relay resolves it (COPILOT_WEB_RELAY_DATA_DIR, the config's dataDir,
// server/data); a global install's relay is pinned to the state root's
// (COPILOT_WEB_RELAY_DATA_DIR wins there too).
function relayDataDir(ctx, paths) {
  if (paths.layout.checkout) return resolveDataDir({ env: ctx.env, configPath: paths.configPath, serverDir: path.join(ctx.packageRoot, 'server') });
  return resolveRelayStateDirs({ env: ctx.env, layout: paths.layout }).dataDir || paths.dataDir;
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

/**
 * Asks the relay to stop or restart itself; it does so once no turn is
 * running, or at once with `immediate` (`--now` of a relay without a service).
 */
async function requestShutdown(ctx, endpoint, restart, { immediate = false } = {}) {
  try {
    const response = await ctx.fetchImpl(`http://localhost:${endpoint.port}/api/relay/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.token}` },
      body: JSON.stringify({ restart, reason: 'oar-cli', requestedBy: 'oar-cli', ...(immediate ? { immediate: true } : {}) }),
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

// systemd restarts the service at once, its restart backoff cleared first.
function restartService(ctx) {
  runQuiet('systemctl', ['--user', 'daemon-reload'], ctx);
  runQuiet('systemctl', ['--user', 'reset-failed', 'oar'], ctx);
  if (runQuiet('systemctl', ['--user', 'restart', 'oar'], ctx)) return true;
  ctx.logger.error('[oar] systemctl --user restart oar failed — see: systemctl --user status oar');
  return false;
}

/**
 * Restarts this install's running relay so that it reads the config again.
 * The relay is asked on the port and with the token it runs with (`old`):
 * once no turn is running it exits for a restart, and a new runtime with the
 * same arguments and environment reads the config file, so a new port, token
 * or access setting applies. Under the service (`viaService`) its supervisor
 * hands that restart to systemd, which starts the code on disk afresh; there
 * systemd restarts it at once with `now`, or when the relay does not answer
 * (`answered` false) or refuses. Done when the relay answers on the config's
 * port with the config's token.
 */
async function restartRelay(ctx, paths, { old, viaService, answered = true, now = false }) {
  const { logger, fetchImpl } = ctx;
  const next = endpointOf(paths.config);
  if (viaService && (now || !answered)) {
    if (!restartService(ctx)) return { ok: false, reason: 'service' };
  } else if (!(await requestShutdown(ctx, old, true, { immediate: now }))) {
    if (!viaService) {
      logger.error('[oar] The relay did not accept the restart request. Restart it from the web UI (⋯ → Restart web relay).');
      return { ok: false, reason: 'restart-refused' };
    }
    if (!restartService(ctx)) return { ok: false, reason: 'service' };
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
  logger.error(`[oar] The relay did not come back — see ${viaService ? 'journalctl --user -u oar' : path.join(paths.logDir, 'server-err.log')}`);
  return { ok: false, reason: 'server-not-ready' };
}

function windowsAutostart(ctx, paths) {
  return ctx.windowsAutostartImpl || createWindowsAutostartService({
    platform: ctx.platform, env: ctx.env, packageRoot: ctx.packageRoot, nodePath: ctx.nodeBin, configPath: paths.configPath,
  });
}

// Windows can also start the relay at boot, through a scheduled task (setting
// it up or taking it out needs an elevation): `oar autostart` or the web UI.
function windowsBoot(ctx, paths) {
  return ctx.windowsBootAutostartImpl || createWindowsBootAutostartService({
    platform: ctx.platform, env: ctx.env, packageRoot: ctx.packageRoot, nodePath: ctx.nodeBin, configPath: paths.configPath, logger: null,
  });
}

async function windowsBootTaskReady(ctx, paths) {
  try {
    return (await windowsBoot(ctx, paths).getState())?.taskStatus === 'ready';
  } catch {
    return false;
  }
}

const AUTOSTART_MODES = ['signin', 'boot', 'off'];
const AUTOSTART_TEXT = {
  boot: 'at boot, before anyone signs in (scheduled task)',
  signin: 'at sign-in (Startup folder)',
  off: 'off',
};

/**
 * This install's Windows autostart (describeWindowsAutostart): the mode
 * (`unknown` when the boot task cannot be read) and every entry there is.
 */
async function readWindowsAutostart(ctx, paths) {
  const boot = await windowsBoot(ctx, paths).getState();
  return { ...describeWindowsAutostart({ signinEntries: windowsAutostart(ctx, paths).listEntries(), boot }), boot };
}

/**
 * Runs one elevated request of the boot service (`requestEnable` or
 * `requestDisable`) and waits until the administrator prompt is answered:
 * `ok` when it was confirmed and the sweep ran.
 */
async function elevated(request, options = {}) {
  let settle;
  const settled = new Promise((resolve) => { settle = resolve; });
  const state = await request({ ...options, onSettled: (ok, extra = {}) => settle({ ...extra, ok }) });
  if (!state.accepted) return { ok: false, refused: state.refused || state.lastError || 'the boot task cannot be changed now' };
  return settled;
}

function reportCopies(ctx, copies = []) {
  for (const { path: original, backup } of copies) ctx.logger.log(`[oar] Kept a copy of ${original} as ${backup}`);
}

/**
 * One line for an elevation that did not go through: a declined prompt (the
 * service put everything back), or a sweep that failed (it put back what it
 * had deleted; the copies stay, and are named).
 */
function notElevated(ctx, result) {
  if (result.refused) ctx.logger.error(`[oar] Nothing changed: ${result.refused}.`);
  else if (result.declined) ctx.logger.error(`[oar] Nothing changed: ${result.reason || 'the administrator prompt was declined'}.`);
  else ctx.logger.error(`[oar] ${result.error || 'The boot task could not be changed.'}`);
  if (result.unverified) return { code: 1, reason: 'unverified' };
  return { code: 1, reason: result.declined || result.refused ? 'not-elevated' : 'elevation-failed' };
}

/**
 * Switches Windows autostart to `target`. Boot mode on or off is one
 * administrator prompt (the elevated part is only the schtasks call); sign-in
 * mode needs none. The other mode's entry goes, but only one OAR generated: a
 * hand-made entry is never deleted or written over, and while one would stay
 * beside the new mode, or be replaced by it, nothing changes at all
 * (switchBlockers). `replace` (`--replace`) replaces every hand-made entry,
 * keeping a copy of each: a launcher's beside it, a task's exported XML and a
 * Startup entry's in the OAR folder (a copy in the Startup folder would be
 * opened at sign-in).
 */
async function switchWindowsAutostart(ctx, paths, target, { replace = false } = {}) {
  const { logger } = ctx;
  const now = await readWindowsAutostart(ctx, paths);
  if (now.mode === 'unknown') {
    logger.error(`[oar] Nothing changed: the boot task could not be read (${now.boot.readError}).`);
    return { code: 1, reason: 'unknown' };
  }
  const blocking = switchBlockers(now, target);
  if (blocking.length && !replace) {
    for (const line of handMadeLines(blocking, target)) logger.error(`[oar] ${line}`);
    return { code: 1, reason: 'hand-made' };
  }
  const bootHandMade = replace && now.entries.some((entry) => entry.mode === 'boot' && !entry.generated);
  const root = paths.layout.root;
  // A generated launcher that is missing or of an earlier version is
  // regenerated too (customised, nothing hand-made).
  const regenerate = now.mode === 'boot' && now.boot.customised && !now.boot.handMade?.length;
  if (target === 'boot' && (now.mode !== 'boot' || bootHandMade || regenerate)) {
    logger.log('[oar] Confirm the administrator prompt to register the boot task …');
    const result = await elevated(windowsBoot(ctx, paths).requestEnable, { replace });
    if (!result.ok) return notElevated(ctx, result);
    reportCopies(ctx, result.copies);
  } else if (target !== 'boot' && (now.mode === 'boot' || bootHandMade)) {
    const tasks = ['ready', 'foreign'].includes(now.boot.taskStatus) || (replace && now.boot.legacyTaskPresent);
    if (tasks) logger.log('[oar] Confirm the administrator prompt to remove the boot task …');
    const result = await elevated(windowsBoot(ctx, paths).requestDisable, { replace });
    if (!result.ok) return notElevated(ctx, result);
    reportCopies(ctx, result.copies);
  }
  let signin;
  try {
    signin = windowsAutostart(ctx, paths).setEnabled(target === 'signin', replace ? { replace, backupDir: root } : {});
  } catch (error) {
    logger.error(`[oar] The sign-in entry could not be changed: ${error?.message || error}`);
    return { code: 1, reason: 'signin-failed' };
  }
  reportCopies(ctx, signin.backedUp);
  if (target === 'boot') logger.log(`[oar] The relay starts at boot, before anyone signs in (${bootTaskLabel(now.boot.taskName)}).`);
  else if (target === 'off') logger.log('[oar] Autostart is off. A running relay keeps running; stop it with: oar stop');
  else logger.log(`[oar] The relay starts when you sign in to Windows${signin.kept.length ? ', through a hand-made entry' : ''}.`);
  // Hand-made entries of the mode picked serve it, and stay.
  const serving = replace ? [] : now.entries.filter((entry) => !entry.generated && entry.mode === target);
  for (const entry of serving) logger.log(`[oar] Left as it is: ${describeHandMade(entry)}. To replace it, keeping a copy: oar autostart ${target} --replace`);
  return { code: 0, reason: `autostart-${target}` };
}

/**
 * `oar autostart boot|signin|off|status`. On Windows the sign-in entry or the
 * boot task; on Linux the systemd user service (`oar service`), which starts
 * at boot with lingering; elsewhere not supported.
 */
export async function runAutostart(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const { logger } = ctx;
  const target = ctx.argv.find((arg) => [...AUTOSTART_MODES, 'status'].includes(arg)) || 'status';
  if (ctx.platform === 'linux') {
    const replace = ctx.argv.includes('--replace') ? ['--replace'] : [];
    return runService({ ...options, argv: [{ status: 'status', off: 'remove' }[target] || 'install', ...replace] });
  }
  if (paths.layout.checkout) {
    logger.error('[oar] This is a git checkout — autostart is for global installs.');
    return { code: 1, reason: 'git-checkout' };
  }
  if (ctx.platform !== 'win32') {
    logger.error(`[oar] Autostart is not supported on ${ctx.platform === 'darwin' ? 'macOS' : ctx.platform} yet. Start the relay with: oar start`);
    return { code: 1, reason: 'unsupported' };
  }
  if (target === 'status') {
    const now = await readWindowsAutostart(ctx, paths);
    logger.log(`[oar] Autostart: ${now.mode === 'unknown' ? `unknown, the boot task could not be read (${now.boot.readError})` : AUTOSTART_TEXT[now.mode]}`);
    for (const entry of now.entries) logger.log(`[oar]   ${entry.generated ? `${entry.path} (generated by OAR)` : describeHandMade(entry)}`);
    if (now.entries.some((entry) => !entry.generated)) {
      logger.log('[oar] OAR leaves hand-made entries as they are. To replace them with its own, keeping a copy: oar autostart signin|boot|off --replace');
    }
    return { code: 0, reason: 'autostart-status', mode: now.mode };
  }
  if (target !== 'off' && requireConfig(ctx, paths)) return { code: 1, reason: 'no-config' };
  return switchWindowsAutostart(ctx, paths, target, { replace: ctx.argv.includes('--replace') });
}

/** `oar setup`'s question; null keeps the mode there is. */
async function askAutostart(ctx, paths) {
  const current = (await readWindowsAutostart(ctx, paths)).mode;
  if (current === 'unknown') return null;
  const fallback = AUTOSTART_MODES.indexOf(current) + 1;
  for (;;) {
    const answer = await ctx.prompter.line(`Autostart: 1 = at sign-in, 2 = at boot, before anyone signs in (one administrator prompt), 3 = off [${fallback}]: `);
    if (!answer) return null;
    if (['1', '2', '3'].includes(answer)) return AUTOSTART_MODES[Number(answer) - 1];
  }
}

// What a systemctl call printed, or null when it could not run.
function systemctlOutput(ctx, args) {
  try {
    const result = ctx.spawnSyncImpl('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
    return result?.error ? null : result || null;
  } catch {
    return null;
  }
}

// States in which systemd runs the relay, starts it (a restart backoff
// included) or stops it: `oar stop` and `oar restart` go to systemd then.
const SYSTEMD_RUNNING_STATES = ['active', 'activating', 'reloading', 'refreshing', 'deactivating'];

function systemdUnitActive(ctx) {
  const result = systemctlOutput(ctx, ['is-active', 'oar']);
  if (!result) return false;
  const state = String(result.stdout ?? '').trim();
  return state ? SYSTEMD_RUNNING_STATES.includes(state) : result.status === 0;
}

// What this install's unit would be built from.
function unitInstall(ctx, paths) {
  return {
    nodeBin: ctx.nodeBin,
    packageRoot: ctx.packageRoot,
    configPath: paths.configPath,
    dataDir: paths.dataDir,
    logDir: paths.logDir,
    checkout: Boolean(paths.layout.checkout),
  };
}

/**
 * The unit at ~/.config/systemd/user/oar.service: `text` (null when there is
 * none), `kind` (classifySystemdUnit: whose it is, for this install) and
 * `ours` (it is this install's service: start, stop and restart go through
 * it). A hand-made unit is a global install's service, the one it has; a
 * checkout's only when its ExecStart runs that checkout's server.js (running
 * in the checkout is not enough), so a worktree never takes over the unit of
 * another relay.
 */
function readSystemdUnit(ctx, paths) {
  const unitPath = systemdUnitPath(ctx.homeDir);
  const text = readText(unitPath);
  if (text === null) return { path: unitPath, text, kind: null, ours: false };
  const kind = classifySystemdUnit({ text, install: unitInstall(ctx, paths) });
  const ours = kind !== 'other-install'
    && !(kind === 'hand-made' && paths.layout.checkout && !systemdUnitRunsCheckout(text, ctx.packageRoot));
  return { path: unitPath, text, kind, ours };
}

// The relay's own lock: a checkout's data folder may be the config's dataDir.
function relayLockPath(ctx, paths) {
  return paths.layout.checkout ? path.join(relayDataDir(ctx, paths), 'relay-server.lock') : paths.lockPath;
}

// How a command of this install is typed: a checkout has no `oar` on PATH.
function oarCommand(paths) {
  return paths.layout.checkout ? 'node bin/oar.js' : 'oar';
}

/**
 * 'active' (systemd runs the relay, starts or stops it), 'installed',
 * 'none', 'other' (oar.service is another OAR install's), or 'unavailable'
 * on this host.
 */
async function serviceState(ctx, paths) {
  if (paths.layout.checkout && ctx.platform !== 'linux') return 'unavailable';
  if (ctx.platform === 'win32') {
    try {
      return windowsAutostart(ctx, paths).getState().enabled || await windowsBootTaskReady(ctx, paths) ? 'installed' : 'none';
    } catch {
      return 'unavailable';
    }
  }
  if (!systemdUserAvailable(ctx)) return 'unavailable';
  const unit = readSystemdUnit(ctx, paths);
  if (unit.text === null) return 'none';
  if (!unit.ours) return 'other';
  return systemdUnitActive(ctx) ? 'active' : 'installed';
}

const UNIT_KIND_TEXT = {
  generated: 'written by OAR for this install',
  'generated-earlier': 'written by an earlier OAR version',
  'other-install': 'written by OAR for another install',
  'hand-made': 'hand-made',
};

/**
 * Writes this install's unit, unless the one there is hand-made or another
 * install's: that one stays as it is (`kept`), unless `replace`, which keeps
 * a copy of it first. `changed` when the text on disk is new.
 */
function writeSystemdUnit(ctx, paths, { replace = false } = {}) {
  const { logger } = ctx;
  const unit = readSystemdUnit(ctx, paths);
  if (unit.text !== null && ['hand-made', 'other-install'].includes(unit.kind) && !replace) {
    return { kept: unit };
  }
  let backup = null;
  if (unit.text !== null && ['hand-made', 'other-install'].includes(unit.kind)) {
    backup = backupPathFor(unit.path, path.dirname(unit.path));
    fs.copyFileSync(unit.path, backup);
    logger.log(`[oar] Kept a copy of ${unit.path} as ${backup}`);
  }
  const text = buildSystemdUnit({
    ...unitInstall(ctx, paths),
    pathEnv: buildServicePath({ nodeBin: ctx.nodeBin, envPath: ctx.env.PATH, homeDir: ctx.homeDir }),
    systemdVersion: parseSystemdVersion(systemctlOutput(ctx, ['--version'])?.stdout),
  });
  fs.mkdirSync(path.dirname(unit.path), { recursive: true });
  fs.writeFileSync(unit.path, text);
  logger.log(`[oar] Wrote ${unit.path}`);
  // A Node of a version manager is gone once another version replaces it.
  if (/\/(\.nvm|\.fnm|\.volta|\.asdf|versions?)\//.test(String(ctx.nodeBin))) {
    logger.log(`[oar] The service runs the Node at ${ctx.nodeBin}; after switching Node versions, run ${oarCommand(paths)} service install again.`);
  }
  // Lingering keeps the user's services up while nobody is logged in;
  // without it the relay of a headless host stops at logout.
  if (!runQuiet('loginctl', ['enable-linger', ctx.userName || os.userInfo().username], ctx)) {
    logger.log('[oar] Could not enable lingering — the relay stops when you log out. Enable it with: loginctl enable-linger "$USER"');
  }
  return { written: true, changed: unit.text !== text, backup };
}

// One line for a unit `oar service install` (or `remove`) leaves as it is.
function keptUnitLine(ctx, paths, unit, action = 'install') {
  const whose = unit.kind === 'other-install' ? `written by OAR for another install (${systemdUnitMarkerRoot(unit.text)})` : 'hand-made';
  const what = action === 'remove' ? 'To remove it' : 'To replace it with this install\'s';
  return `[oar] Left as it is: ${unit.path} (${whose}). ${what}, keeping a copy: ${oarCommand(paths)} service ${action} --replace`;
}

function startRelay(ctx, paths) {
  const unit = ctx.platform === 'linux' ? readSystemdUnit(ctx, paths) : { text: null };
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
    readyWaitMs: ctx.readyWaitMs,
    homeDir: ctx.homeDir,
    platform: ctx.platform,
    logger: ctx.logger,
    serviceInstalled: unit.text !== null && unit.ours,
    lockPath: relayLockPath(ctx, paths),
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
  if (result.how === 'bringing-over') {
    logger.log(takeoverLine(result.takeover, result.logDir));
    return;
  }
  if (!result.ok) {
    logger.error?.(`[oar] The relay did not come up — see ${result.how === 'service' ? 'journalctl --user -u oar' : path.join(result.logDir, 'server-err.log')}`);
    if (result.lock?.known) logger.error?.(`[oar] The lock ${result.lock.path} is held by relay process ${result.lock.pid} (started ${result.lock.startedAt}): oar stop, or end process ${result.lock.pid}.`);
    else if (result.lock) logger.error?.(`[oar] The lock ${result.lock.path} names process ${result.lock.pid}, which cannot be told to be a relay: if no relay is running, end process ${result.lock.pid} or delete the lock.`);
    return;
  }
  if (result.how === 'already') {
    logger.log('[oar] The relay is already running. It keeps the version and settings it started with until you restart it: oar restart');
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
  ctx.logger.error(`[oar] Port ${port} is in use by another program, or by a relay with another token.`);
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
  // A checkout starts only through its service; anywhere else it runs in a terminal.
  if (paths.layout.checkout && !['active', 'installed'].includes(await serviceState(ctx, paths))) {
    logger.error('[oar] This is a git checkout — start the relay with: npm start, or run it as a service: node bin/oar.js service install');
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
  if (result.how === 'bringing-over') return { code: 0, reason: 'bringing-over' };
  return { code: result.ok ? 0 : 1, reason: result.ok ? 'started' : 'server-not-ready' };
}

// systemd stops the service at once; running turns end.
function stopService(ctx, paths) {
  if (!runQuiet('systemctl', ['--user', 'stop', 'oar'], ctx)) {
    ctx.logger.error('[oar] systemctl --user stop oar failed — see: systemctl --user status oar');
    return { code: 1, reason: 'service' };
  }
  ctx.logger.log(`[oar] The relay service is stopped. It starts again at the next boot (without lingering: at the next login); to take it out: ${oarCommand(paths)} service remove`);
  return { code: 0, reason: 'stopped' };
}

/**
 * `oar stop` — the relay stops itself once no turn is running, under the
 * service too (its unit stays enabled). `--now` under the service, or a
 * service whose relay does not answer: systemd stops it at once. `--now` of
 * any other relay asks it to stop without waiting.
 */
export async function runStop(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const { logger } = ctx;
  const missing = requireConfig(ctx, paths);
  if (missing) return missing;
  const now = ctx.argv.includes('--now');
  const viaService = (await serviceState(ctx, paths)) === 'active';
  if (viaService && now) return stopService(ctx, paths);
  const relay = await findRelay(ctx, paths);
  if (viaService && relay.answer !== 'oar') return stopService(ctx, paths);
  if (relay.answer === 'none') {
    logger.log('[oar] The relay is not running.');
    return { code: 0, reason: 'not-running' };
  }
  if (relay.answer === 'taken') return reportPortTaken(ctx, paths, relay.endpoint.port);
  if (!(await requestShutdown(ctx, relay.endpoint, false, { immediate: now }))) {
    if (viaService) return stopService(ctx, paths);
    logger.error('[oar] The relay did not accept the stop request.');
    return { code: 1, reason: 'stop-refused' };
  }
  const closed = await pollUntil(
    async () => (await probeRelayPort({ ...relay.endpoint, fetchImpl: ctx.fetchImpl })) === 'none',
    { waitMs: ctx.stopWaitMs, pollMs: ctx.pollMs },
  );
  const command = oarCommand(paths);
  const enabled = viaService ? ` The service stays enabled: it starts again at the next boot, or with: ${command} start` : '';
  logger.log(closed
    ? `[oar] The relay is stopped.${enabled}`
    : `[oar] The relay is still busy; it stops by itself when its running turns finish (at once: ${command} stop --now).${enabled}`);
  return { code: 0, reason: closed ? 'stopped' : 'stop-queued' };
}

/**
 * `oar restart` — restarts a running relay once no turn is running (`--now`:
 * at once), starts a stopped one. Under the service systemd restarts it at
 * once with `--now`, or when the relay does not answer.
 */
export async function runRestart(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const missing = requireConfig(ctx, paths);
  if (missing) return missing;
  const viaService = (await serviceState(ctx, paths)) === 'active';
  const relay = await findRelay(ctx, paths);
  if (!viaService && relay.answer === 'none') return runStart(options);
  if (!viaService && relay.answer === 'taken') return reportPortTaken(ctx, paths, relay.endpoint.port);
  const outcome = await restartRelay(ctx, paths, {
    old: relay.endpoint, viaService, answered: relay.answer === 'oar', now: ctx.argv.includes('--now'),
  });
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
  else logger.log(`[oar] Port ${status.port} is in use by another program, or by a relay with another token.`);
  if (status.service !== 'unavailable') {
    logger.log(`[oar] Service: ${{ active: 'installed, running', installed: 'installed', none: 'not installed', other: 'not installed (oar.service belongs to another OAR install)' }[status.service]}`);
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
    logger.error('[oar] The relay starts at boot through a scheduled task. Change that with oar autostart signin|off, or in the web UI: Settings → General → Autostart (Windows).');
    return { code: 1, reason: 'boot-task' };
  }
  if (action === 'install' && requireConfig(ctx, paths)) return { code: 1, reason: 'no-config' };
  autostart.setEnabled(action === 'install');
  logger.log(action === 'install'
    ? '[oar] The relay now starts when you sign in to Windows. Start it now with: oar start'
    : '[oar] Autostart is off. A running relay keeps running; stop it with: oar stop');
  return { code: 0, reason: `service-${action}` };
}

// The relay paths a checkout's service does not get: the relay it runs
// finds its config, data and logs in the checkout.
const CHECKOUT_UNPINNED_ENV = ['COPILOT_WEB_RELAY_CONFIG', 'COPILOT_WEB_RELAY_DATA_DIR', 'COPILOT_WEB_RELAY_LOG_DIR'];

// `oar service status` on Linux: the state, whose the unit is, its drop-ins, lingering.
function reportSystemdService(ctx, paths, state) {
  const { logger } = ctx;
  const command = oarCommand(paths);
  const unit = readSystemdUnit(ctx, paths);
  if (unit.text === null) {
    logger.log('[oar] Service: not installed');
    return;
  }
  logger.log(`[oar] Service: ${{ active: 'installed, running', installed: 'installed, not running', other: 'not installed for this install' }[state]}`);
  const whose = unit.kind === 'other-install'
    ? `${UNIT_KIND_TEXT[unit.kind]} (${systemdUnitMarkerRoot(unit.text)})`
    : `${UNIT_KIND_TEXT[unit.kind]}${unit.ours ? '' : ', not for this checkout'}`;
  logger.log(`[oar] Unit: ${unit.path} (${whose})`);
  if (unit.kind === 'generated-earlier') logger.log(`[oar] It is from an earlier OAR version; write this version's with: ${command} service install`);
  if (['hand-made', 'other-install'].includes(unit.kind)) {
    logger.log(`[oar] OAR leaves it as it is. To replace it with this install's, keeping a copy: ${command} service install --replace`);
  }
  for (const dropIn of listSystemdDropIns(ctx.homeDir)) logger.log(`[oar] Drop-in: ${dropIn} (your own settings, kept)`);
  const user = ctx.userName || os.userInfo().username;
  let linger = '';
  try {
    const result = ctx.spawnSyncImpl('loginctl', ['show-user', user, '-p', 'Linger', '--value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 });
    linger = String(result?.stdout ?? '').trim();
  } catch {}
  if (linger === 'no') logger.log('[oar] Lingering is off: the relay stops when you log out. Switch it on with: loginctl enable-linger "$USER"');
}

/** `oar service install|remove|status` — the systemd user service on Linux, the autostart entry on Windows. */
export async function runService(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const { logger } = ctx;
  const action = ctx.argv.find((arg) => ['install', 'remove', 'status'].includes(arg)) || 'status';
  const replace = ctx.argv.includes('--replace');
  if (paths.layout.checkout && ctx.platform !== 'linux') {
    logger.error('[oar] This is a git checkout — the service is for global installs here.');
    return { code: 1, reason: 'git-checkout' };
  }
  if (ctx.platform === 'win32') return runWindowsService(ctx, paths, action);
  if (ctx.platform !== 'linux') {
    logger.error(`[oar] The service is not supported on ${ctx.platform === 'darwin' ? 'macOS' : ctx.platform} yet. Start the relay with: oar start`);
    return { code: 1, reason: 'unsupported' };
  }
  const command = oarCommand(paths);
  if (!systemdUserAvailable(ctx)) {
    const wslHint = isWsl(ctx) ? ' In WSL, switch systemd on: systemd=true under [boot] in /etc/wsl.conf, then restart the distro (from Windows: wsl --terminate <distro>).' : '';
    const start = paths.layout.checkout ? 'npm start' : 'oar start';
    logger.error(`[oar] No systemd user session here, so there is no service to install.${wslHint} Start the relay with: ${start}`);
    return { code: 1, reason: 'no-systemd' };
  }
  const state = await serviceState(ctx, paths);
  if (action === 'status') {
    reportSystemdService(ctx, paths, state);
    return { code: 0, reason: 'service-status' };
  }
  if (action === 'remove') {
    const unit = readSystemdUnit(ctx, paths);
    if (unit.text === null) {
      logger.log('[oar] The service is not installed.');
      return { code: 0, reason: 'service-remove' };
    }
    if (['hand-made', 'other-install'].includes(unit.kind)) {
      if (!replace) {
        logger.error(keptUnitLine(ctx, paths, unit, 'remove'));
        return { code: 1, reason: 'hand-made-unit' };
      }
      const backup = backupPathFor(unit.path, path.dirname(unit.path));
      fs.copyFileSync(unit.path, backup);
      logger.log(`[oar] Kept a copy of ${unit.path} as ${backup}`);
    }
    runQuiet('systemctl', ['--user', 'disable', '--now', 'oar'], ctx);
    try { fs.unlinkSync(unit.path); } catch {}
    runQuiet('systemctl', ['--user', 'daemon-reload'], ctx);
    logger.log(`[oar] Removed ${unit.path}; the relay is stopped. Start it by hand with: ${paths.layout.checkout ? 'npm start' : 'oar start'}`);
    return { code: 0, reason: 'service-remove' };
  }
  const missing = requireConfig(ctx, paths);
  if (missing) return missing;
  if (paths.layout.checkout) {
    for (const name of CHECKOUT_UNPINNED_ENV.filter((key) => String(ctx.env[key] || '').trim())) {
      logger.log(`[oar] ${name} is set in this shell; the service does not get it. If the relay needs it, put it in ~/.config/systemd/user/oar.service.d/*.conf`);
    }
  }
  const wasActive = state === 'active' || (state === 'other' && systemdUnitActive(ctx));
  const written = writeSystemdUnit(ctx, paths, { replace });
  if (written.kept) {
    logger.error(keptUnitLine(ctx, paths, written.kept));
    return { code: 1, reason: 'hand-made-unit' };
  }
  runQuiet('systemctl', ['--user', 'daemon-reload'], ctx);
  if (wasActive) {
    if (written.changed) logger.log(`[oar] The new unit applies at the next restart: ${command} restart --now`);
  } else if ((await findRelay(ctx, paths)).answer === 'oar') {
    // A relay started by hand holds the port and the lock: it makes way first.
    if ((await runStop({ ...options, argv: [] })).reason !== 'stopped') {
      runQuiet('systemctl', ['--user', 'enable', 'oar'], ctx);
      logger.log(`[oar] The service is installed and takes over at the next boot (without lingering: at the next login), or once the relay has stopped: ${command} start`);
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
  const autostartFlag = optionValue(argv, '--autostart');
  if (autostartFlag !== undefined && !AUTOSTART_MODES.includes(autostartFlag)) {
    logger.error('[oar] --autostart expects signin, boot or off.');
    return { code: 2, reason: 'bad-autostart' };
  }
  const terminal = Boolean(ctx.stdin?.isTTY) && !has('--defaults');
  const ask = terminal && !portFlag && !has('--lan') && !has('--local') && !has('--new-token') && !autostartFlag;

  let paths = installPaths(ctx);
  const { layout } = paths;
  if (autostartFlag && layout.checkout) {
    logger.error('[oar] --autostart is for global installs; a git checkout has no autostart (start it with: npm start). Nothing was changed.');
    return { code: 1, reason: 'git-checkout' };
  }
  if (!layout.checkout) {
    const migrateFrom = String(optionValue(argv, '--migrate-from') || '').trim();
    const stop = await migrateIntoStateRoot({
      layout, env, packageRoot: ctx.packageRoot, migrateFrom, logger, isProcessAliveImpl: ctx.isProcessAliveImpl,
    });
    if (stop) return stop;
    // A migration may have brought a config over.
    paths = installPaths(ctx);
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

  // Autostart: as --autostart says, else in a terminal on Windows the
  // question, with the mode there is as its default.
  let autostart = null;
  if (!layout.checkout) {
    const target = autostartFlag || (ask && ctx.platform === 'win32' ? await askAutostart(ctx, paths) : null);
    if (target) autostart = await runAutostart({ ...options, argv: [target] });
  }

  const startRequested = has('--start') && !layout.checkout;
  const viaService = running && (await serviceState(ctx, paths)) === 'active';
  if (startRequested && systemdUserAvailable(ctx)) {
    const written = writeSystemdUnit(ctx, paths);
    if (written.kept) logger.log(keptUnitLine(ctx, paths, written.kept));
  }

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
  if (autostart?.code) {
    logger.error('[oar] The config is written; the autostart step did not go through (see above).');
    return { code: 1, reason: autostart.reason };
  }
  if (outcome) return { code: outcome.ok ? 0 : 1, reason: outcome.ok ? 'setup-complete' : outcome.reason };
  if (layout.checkout) {
    logger.log('[oar] Start the relay with: npm start');
  } else if (!running) {
    const atLogin = (await serviceState(ctx, paths)) === 'none' ? '  (at every login: oar service install)' : '';
    logger.log(`[oar] Start the relay with: oar start${atLogin}`);
  }
  return { code: 0, reason: 'setup-complete' };
}

const PACKAGE_NAME = '@oar-sh/oar';

/**
 * The detached helper `oar uninstall` leaves behind (`node -e`, arguments:
 * the pid to outlive, the log, the npm command line): npm cannot remove a
 * package while it runs, so it waits for `oar` to end, then runs npm and
 * writes the outcome to the log.
 */
export const UNINSTALL_HELPER_SOURCE = [
  'const [pid, log, scope, command, ...args] = process.argv.slice(1);',
  'const fs = require("fs"); const path = require("path");',
  'const alive = () => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; } };',
  'const until = Date.now() + 120000;',
  'const run = () => {',
  '  if (alive() && Date.now() < until) return setTimeout(run, 250);',
  '  const result = require("child_process").spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32", windowsHide: true });',
  '  let text = new Date().toISOString() + " " + [command, ...args].join(" ") + ": exit " + result.status + "\\n"',
  '    + (result.stdout || "") + (result.stderr || "") + (result.error ? result.error.message + "\\n" : "");',
  // npm moves the package to a hidden .oar-* folder in its scope and deletes
  // that; files a running program holds stay there.
  '  let left = []; try { left = fs.readdirSync(scope).filter((name) => name.startsWith(".oar-")).map((name) => path.join(scope, name)); } catch {}',
  '  for (const dir of left) text += "Left behind: " + dir + " holds files a program still ran from (a session worker, or a CLI it started). Delete it once nothing runs from it any more, at the latest after a reboot.\\n";',
  '  fs.appendFileSync(log, text);',
  '};',
  'setTimeout(run, 500);',
].join('\n');

/**
 * The processes other than this one that run from dir (their command line
 * names it): { pid, commandLine }, or null when the list cannot be read.
 */
async function processesRunningFrom(ctx, dir) {
  try {
    const lister = ctx.processListImpl || createProcessLister({ platform: ctx.platform, systemToolPath: (name) => windowsSystemToolPath(name, { env: ctx.env }) });
    const needle = path.resolve(dir).toLowerCase();
    return (await lister.list())
      .map((row) => {
        const pid = Number(row.processId ?? row.pid);
        return { pid, commandLine: String(row.commandLine ?? lister.describe?.(pid) ?? '') };
      })
      .filter((row) => row.pid && row.pid !== ctx.pid && row.commandLine.toLowerCase().includes(needle));
  } catch {
    return null;
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// The git checkout `target` lies in, or ''.
function checkoutAround(target) {
  for (let dir = path.resolve(target); ; dir = path.dirname(dir)) {
    if (isGitCheckout(dir)) return dir;
    if (path.dirname(dir) === dir) return '';
  }
}

/**
 * Why `dir` is no folder `--purge` may delete, or '': a drive or file-system
 * root, the home folder or a folder above it (`C:\Users`), a system folder or
 * one above it, a git checkout, or, with `marker`, a folder without it.
 */
function purgeRefusal(ctx, dir, marker = null) {
  const resolved = path.resolve(dir);
  const same = (a, b) => (ctx.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const atOrAbove = (target) => target && (same(resolved, path.resolve(target)) || isInside(path.resolve(target).toLowerCase(), resolved.toLowerCase()));
  if (path.parse(resolved).root === resolved) return 'a drive or file-system root';
  const homes = [ctx.homeDir, ctx.env.USERPROFILE, ctx.env.HOME].filter(Boolean);
  if (homes.some(atOrAbove)) return 'the home folder or a folder above it';
  const system = ctx.platform === 'win32'
    ? ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'APPDATA', 'LOCALAPPDATA'].map((name) => readEnvValue(ctx.env, name))
    : ['/etc', '/usr', '/bin', '/sbin', '/lib', '/var', '/opt', '/home', '/Users', '/System', '/Library', '/Applications'];
  if (system.some(atOrAbove)) return 'a system folder or a folder above one';
  const windows = readEnvValue(ctx.env, 'SystemRoot');
  if (windows && isInside(resolved.toLowerCase(), path.resolve(windows).toLowerCase())) return 'inside the Windows folder';
  if (isGitCheckout(resolved)) return 'a git checkout';
  if (marker && !marker(resolved)) return 'no OAR config or database in it';
  return '';
}

// An OAR state root: its config, or a database (either name) in its data folder.
const looksLikeDataDir = (dir) => DB_FILE_NAMES.some((name) => fs.existsSync(path.join(dir, name)));
const looksLikeStateRoot = (dir) => fs.existsSync(path.join(dir, 'config.json')) || looksLikeDataDir(path.join(dir, 'data'));

/**
 * What `oar uninstall --purge` deletes: the state root (`refused` when
 * purgeRefusal names a reason), and, each only after a question of its own
 * (`extra`), the rescued package data, a data folder outside the state root,
 * and the state root itself when it lies in a git checkout. An extra folder
 * purgeRefusal refuses is not offered (`skipped`).
 */
function purgePlan(ctx, paths) {
  const root = path.resolve(paths.layout.root);
  const refused = purgeRefusal(ctx, root, looksLikeStateRoot);
  const dataDir = resolveRelayStateDirs({ env: ctx.env, layout: paths.layout }).dataDir;
  const extra = [];
  const skipped = [];
  const add = (target, why, marker = null) => {
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved) || extra.some((item) => item.path === resolved)) return;
    const refusal = resolved === root ? '' : purgeRefusal(ctx, resolved, marker);
    if (refusal) skipped.push({ path: resolved, why: refusal });
    else extra.push({ path: resolved, why });
  };
  const rootCheckout = checkoutAround(root);
  if (rootCheckout) add(root, `the state root, inside the git checkout ${rootCheckout}`);
  add(path.join(dataDir, RESCUE_DIR_NAME), 'data an earlier version kept inside its package, saved at install time');
  for (const dir of [dataDir, readConfiguredDataDir({ configPath: paths.configPath })]) {
    if (!dir || path.resolve(dir) === root || isInside(path.resolve(dir), root)) continue;
    const checkout = checkoutAround(dir);
    add(dir, checkout ? `a data folder in the git checkout ${checkout}` : 'a data folder outside the state root', looksLikeDataDir);
  }
  // Backups the config keeps outside the state root are never deleted.
  const configuredBackups = paths.config?.dbBackups?.dir;
  const backupsElsewhere = typeof configuredBackups === 'string' && path.isAbsolute(configuredBackups)
    && !isInside(path.resolve(configuredBackups), root) && path.resolve(configuredBackups) !== root ? path.resolve(configuredBackups) : null;
  return { root, refused, extra, skipped, backupsElsewhere };
}
// Deletes `target` except the paths in `keep` (and the folders they are in).
function deleteTree(target, keep) {
  if (keep.includes(target)) return;
  if (!keep.some((kept) => isInside(kept, target))) {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  }
  for (const name of fs.readdirSync(target)) deleteTree(path.join(target, name), keep);
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

/**
 * Takes out the autostart entries and the Copilot wrapper OAR generated for
 * this install; returns the hand-made ones it left, or `{ failed }`.
 */
async function removeGeneratedEntries(ctx, paths, done) {
  const kept = [];
  if (ctx.platform === 'win32') {
    const now = await readWindowsAutostart(ctx, paths);
    if (now.mode === 'unknown') return { failed: `the boot task could not be read (${now.boot.readError})`, left: 'autostart' };
    if (now.boot.generated) {
      ctx.logger.log('[oar] Confirm the administrator prompt to remove the boot task …');
      const result = await elevated(windowsBoot(ctx, paths).requestDisable);
      if (!result.ok) {
      if (result.unverified) return { failed: String(result.error).replace(/\.$/, ''), left: 'autostart' };
      const why = result.refused || (result.declined ? 'the administrator prompt was declined' : result.error || 'the sweep failed');
      return { failed: `the boot task was not removed: ${why}`, left: 'autostart' };
    }
      done.push(`removed the ${bootTaskLabel(now.boot.taskName)}`);
    }
    const root = paths.layout.root;
    const leftovers = [BOOT_TASK_XML_FILENAME, BOOT_ELEVATION_SCRIPT_FILENAME].map((name) => path.join(root, name));
    // A generated launcher no task can run (a task left as it is may run it).
    const stray = now.boot.taskStatus === 'missing' && !now.boot.legacyTaskPresent
      && now.entries.find((entry) => entry.generated && entry.path === now.boot.launcherPath);
    if (stray) leftovers.push(stray.path);
    for (const file of leftovers) fs.rmSync(file, { force: true });
    const signin = now.entries.filter((entry) => entry.mode === 'signin');
    windowsAutostart(ctx, paths).setEnabled(false);
    done.push(...signin.filter((entry) => entry.generated).map((entry) => `removed ${entry.path}`));
    kept.push(...now.entries.filter((entry) => !entry.generated));
  } else {
    // Only a unit OAR wrote for this install (this version or 0.9.19) goes.
    const { path: unitPath, text: unit, kind } = readSystemdUnit(ctx, paths);
    if (unit !== null && !['generated', 'generated-earlier'].includes(kind)) kept.push({ path: unitPath });
    else if (unit !== null) {
      runQuiet('systemctl', ['--user', 'disable', '--now', 'oar'], ctx);
      fs.rmSync(unitPath, { force: true });
      runQuiet('systemctl', ['--user', 'daemon-reload'], ctx);
      done.push(`removed ${unitPath}`);
    }
  }
  const wrapper = path.join(getCopilotUserExtensionsDir(ctx.env), 'web-relay', 'extension.mjs');
  const source = readText(wrapper);
  if (source !== null && wrapperIsGenerated(ctx, source)) {
    fs.rmSync(wrapper, { force: true });
    try { fs.rmdirSync(path.dirname(wrapper)); } catch {}
    done.push(`removed ${wrapper}`);
  } else if (source !== null) {
    const otherInstall = source.match(/^const PACKAGE_ROOT = (".*");$/m)?.[1];
    const root = otherInstall ? JSON.parse(otherInstall) : '';
    kept.push({ path: wrapper, otherInstall: root && path.resolve(root) !== path.resolve(ctx.packageRoot) ? root : null });
  }
  return { kept };
}

/**
 * The Copilot wrapper as this version or an earlier one (before the rename,
 * as copilot-remote) wrote it for this install; the same rule as the
 * autostart launchers: anything else is hand-made.
 */
function wrapperIsGenerated(ctx, source) {
  const current = buildGlobalExtensionWrapperSource(path.join(ctx.packageRoot, '.github', 'extensions', 'web-relay', 'extension.mjs'));
  const earlier = current
    .replace('Auto-generated by oar ', 'Auto-generated by copilot-remote ')
    .replace('`oar --install-extension`', '`copilot-remote --install-extension`');
  return [current, earlier].some((generated) => launcherScriptsMatch(source, generated));
}

/**
 * `oar uninstall [--purge]` — stops the relay, takes out the autostart
 * entries OAR generated (never hand-made ones) and has npm remove the
 * package once this command has ended. The data stays, unless `--purge` and
 * a typed confirmation say otherwise; folders outside the state root, in a
 * git checkout or the rescued package data each get a question of their own.
 * A step that fails ends the command with what is done and what is left.
 */
export async function runUninstall(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const { logger, prompter } = ctx;
  if (paths.layout.checkout) {
    logger.error('[oar] This is a git checkout — there is no global package to uninstall.');
    return { code: 1, reason: 'git-checkout' };
  }
  const plan = ctx.argv.includes('--purge') ? purgePlan(ctx, paths) : null;
  const done = [];
  const left = ['the package'];
  if (plan) left.unshift('the data');
  const stop = (reason, message) => {
    logger.error(`[oar] ${message}`);
    if (done.length) logger.error(`[oar] Done: ${done.join('; ')}.`);
    logger.error(`[oar] Not done: ${left.join('; ')}. Run oar uninstall${plan ? ' --purge' : ''} again once that is sorted out.`);
    return { code: 1, reason };
  };

  if (plan) {
    if (plan.refused) {
      logger.error(`[oar] --purge deletes nothing in ${plan.root} (${plan.refused}). Nothing was changed.`);
      return { code: 1, reason: 'purge-unsafe' };
    }
    for (const item of plan.skipped) logger.log(`[oar] Not deleted, and not offered: ${item.path} (${item.why}).`);
    logger.log(`[oar] --purge deletes ${plan.root} for good: the config, the database with every conversation, its backups, the uploads and the logs.`);
    if (plan.backupsElsewhere) logger.log(`[oar] Not deleted: the database backups in ${plan.backupsElsewhere} (dbBackups.dir in the config); delete them yourself if you want them gone.`);
    if ((await prompter.line('Type "delete" to confirm: ')) !== 'delete') {
      logger.log('[oar] Not confirmed. Nothing was changed.');
      return { code: 1, reason: 'purge-not-confirmed' };
    }
    for (const item of plan.extra) {
      item.remove = await prompter.yesNo(`Also delete ${item.path} (${item.why})?`, { defaultYes: false });
    }
  }

  left.unshift('the autostart entries');
  // A relay may run without answering yet (it holds its lock while it brings
  // over a database, or while it starts): nothing goes while one may run.
  // One that does not answer cannot be asked to stop, so that ends it here,
  // before `oar stop` would call it not running.
  const holder = () => heldLock(paths.lockPath, ctx.isProcessAliveImpl);
  const lockedOut = (lock) => {
    const takeover = readTakeover(paths.lockPath, ctx.isProcessAliveImpl);
    return stop('relay-running', takeover
      ? `The relay (process ${lock.pid}) is bringing over its database and does not answer yet; once oar status says it runs, run oar uninstall again.`
      : `A relay (process ${lock.pid}) holds ${paths.lockPath} without answering; stop it (oar stop, or end process ${lock.pid}).`);
  };
  const held = holder();
  if (held && (readTakeover(paths.lockPath, ctx.isProcessAliveImpl) || !paths.config || (await findRelay(ctx, paths)).answer !== 'oar')) {
    return lockedOut(held);
  }
  if (paths.config) {
    const stopped = await runStop({ ...options, argv: [] });
    if (!['stopped', 'not-running'].includes(stopped.reason)) {
      return stop('relay-running', stopped.reason === 'stop-queued'
        ? 'The relay finishes its running turns first; it stops by itself after them.'
        : 'The relay did not stop.');
    }
    if (stopped.reason === 'stopped') done.push('stopped the relay');
  }
  if (!(await pollUntil(() => !holder(), { waitMs: done.length ? ctx.stopWaitMs : 0, pollMs: ctx.pollMs }))) {
    return lockedOut(holder() || { pid: '?' });
  }
  // Session workers outlive the relay: npm cannot remove the files they hold.
  const users = await processesRunningFrom(ctx, ctx.packageRoot);
  let entries;
  try {
    entries = await removeGeneratedEntries(ctx, paths, done);
  } catch (error) {
    entries = { failed: error?.message || String(error) };
  }
  if (entries.failed) return stop('autostart', `Uninstall stopped: ${entries.failed}.`);
  left.shift();

  if (plan) {
    const keep = plan.extra.filter((item) => !item.remove).map((item) => item.path);
    const targets = [plan.root, ...plan.extra.filter((item) => item.remove && !isInside(item.path, plan.root)).map((item) => item.path)];
    for (const target of targets) {
      if (keep.includes(target)) continue;
      try {
        deleteTree(target, keep);
      } catch (error) {
        return stop('purge-failed', `Could not delete all of ${target}: ${error?.message || error}`);
      }
      done.push(`deleted ${target}${keep.some((kept) => isInside(kept, target)) ? ' except what you kept' : ''}`);
    }
    left.shift();
  }

  const npm = resolveNpmInvocation({ packageRoot: ctx.packageRoot, env: ctx.env, platform: ctx.platform, execPath: ctx.nodeBin });
  const logPath = path.join(plan ? os.tmpdir() : paths.logDir, 'oar-uninstall.log');
  try {
    if (!plan) fs.mkdirSync(paths.logDir, { recursive: true });
    const child = ctx.spawnImpl(ctx.nodeBin, [
      '-e', UNINSTALL_HELPER_SOURCE, String(ctx.pid), logPath, path.dirname(ctx.packageRoot), npm.command, 'uninstall', '-g', ...npm.prefixArgs, PACKAGE_NAME,
    ], { cwd: ctx.homeDir, env: npm.env, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
  } catch (error) {
    return stop('npm-failed', `Could not start the package removal (${error?.message || error}); remove it yourself: npm uninstall -g ${PACKAGE_NAME}`);
  }

  for (const line of done) logger.log(`[oar] Done: ${line}.`);
  for (const kept of entries.kept) logger.log(`[oar] Left as it is: ${describeHandMade(kept)}`);
  if (plan) {
    for (const item of plan.extra.filter((extra) => !extra.remove)) logger.log(`[oar] Kept: ${item.path}`);
  } else {
    const dataDir = resolveRelayStateDirs({ env: ctx.env, layout: paths.layout }).dataDir;
    logger.log(`[oar] Your data stays in ${paths.layout.root}${isInside(path.resolve(dataDir), path.resolve(paths.layout.root)) ? '' : ` and ${dataDir}`} (config, database, uploads, logs). A later install picks it up again; delete the folder yourself if you no longer need it.`);
  }
  if (users?.length) {
    logger.log(`[oar] ${users.length === 1 ? 'A program still runs' : `${users.length} programs still run`} from the package (process ${users.map((user) => user.pid).join(', ')}: a session worker, or a CLI it started). npm cannot remove the files they hold and leaves them in a hidden .oar-* folder in ${path.dirname(ctx.packageRoot)}; delete it once they have ended, at the latest after a reboot. The log names what was left.`);
  }
  logger.log(`[oar] npm removes ${PACKAGE_NAME} once this command has ended (log: ${logPath}).`);
  return { code: 0, reason: 'uninstalled' };
}

export async function runDoctor(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  // The file the relay runs on (read only: nothing is created).
  const dataDir = relayDataDir(ctx, paths);
  const databaseFile = resolveDatabaseFile(dataDir);
  const dbPath = databaseFile.path;
  const databaseNotes = [
    ...(databaseFile.both ? [`${path.join(dataDir, LEGACY_DB_FILE_NAME)} is also there; the next start compares the two`] : []),
    ...databaseFile.dangling.map((file) => `${file} is a link to a file that is not there`),
    ...databaseFile.orphans.map((file) => (path.basename(file).startsWith(`${DB_FILE_NAME}-`)
      ? `${file} is there without ${path.join(dataDir, DB_FILE_NAME)}: the relay does not start until it is moved away`
      : `${file} is there without its database (not used, never deleted); move it away before renaming a database to that name`)),
  ];

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
  const backups = describeBackups({ layout: paths.layout, serverDir: path.join(ctx.packageRoot, 'server'), dataDir, config: paths.config });
  ctx.logger.log(renderDoctorReport({
    version: readPackageVersion(ctx.packageRoot),
    nodeVersion: process.version,
    platform: ctx.platform,
    layout: paths.layout,
    configPath: paths.configPath,
    config: paths.config,
    dbPath,
    dbSizeBytes,
    databaseNotes,
    backups,
    now: Date.now(),
    probes,
    warnings: holder ? [windowsPortWarning(port, holder)] : [],
    // The relay resolves a relative cloudflaredTunnel.binary against server/.
    tunnel: describeConfiguredTunnel(paths.config?.cloudflaredTunnel, { env: ctx.env, configBaseDir: path.join(ctx.packageRoot, 'server') }),
  }));
  return { code: 0, reason: 'doctor' };
}

/**
 * `oar backup [--reason <text>]`: a copy of the relay's database, online
 * (safe while the relay runs), into the backup folder with the start's
 * name, manifest and rotation (db-backup-service.mjs). Never creates a
 * database; never touches db_last_run. Exit 1 when no copy could be made,
 * 0 for a copy or a skip (with its warning).
 */
export async function runBackup(options = {}) {
  const ctx = cliContext(options);
  const paths = installPaths(ctx);
  const dataDir = relayDataDir(ctx, paths);
  const argv = ctx.argv || [];
  const reasonAt = argv.indexOf('--reason');
  const given = reasonAt === -1 ? argv.find((arg) => arg.startsWith('--reason='))?.slice('--reason='.length) : argv[reasonAt + 1];
  const reason = given === undefined ? 'manual' : sanitizeReason(given);
  const fail = (message, why = 'backup-failed') => {
    ctx.logger.error(`[oar] ${message}`);
    return { code: 1, reason: why };
  };
  const file = resolveDatabaseFile(dataDir);
  if (file.created || file.dangling.length) {
    return fail(`No database in ${dataDir} to back up (neither ${DB_FILE_NAME} nor ${LEGACY_DB_FILE_NAME}).`, 'no-database');
  }
  for (const warning of configWarnings(paths.config)) ctx.logger.error(warning);
  let source;
  try {
    const Database = (await import('better-sqlite3')).default;
    source = new Database(file.path, { readonly: true, fileMustExist: true });
    const say = { log: (line) => ctx.logger.log(String(line).replace(/^\[backup\]/, '[oar]')), warn: (line) => ctx.logger.error(String(line).replace(/^\[backup\]/, '[oar]')) };
    const result = await backupDatabase({
      source,
      Database,
      dbPath: file.path,
      dataDir,
      layout: paths.layout,
      serverDir: path.join(ctx.packageRoot, 'server'),
      config: paths.config,
      version: readPackageVersion(ctx.packageRoot),
      reason,
      logger: say,
      ...(ctx.isProcessAliveImpl ? { isProcessAlive: ctx.isProcessAliveImpl } : {}),
      ...(ctx.fsImpl ? { fsImpl: ctx.fsImpl } : {}),
    });
    if (result.status === 'busy') return fail(`Not backing up now: ${result.reason}; run oar backup again once it is done.`, 'backup-busy');
    if (result.status === 'failed') return { code: 1, reason: 'backup-failed' };
    return { code: 0, reason: result.status === 'written' ? 'backup-written' : 'backup-skipped', file: result.file ? path.join(result.dir, result.file) : null };
  } catch (error) {
    return fail(`The backup of ${file.path} failed: ${error?.message || error}.`);
  } finally {
    try { source?.close(); } catch {}
  }
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
        const action = { none: 'install', unavailable: 'status', other: 'status' }[status.service] || 'remove';
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
  autostart: runAutostart,
  uninstall: runUninstall,
  copilot: launchRelay,
  doctor: runDoctor,
  backup: runBackup,
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
