'use strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_SDK_IDS,
  AGENT_SDK_LEASES_DIR,
  AGENT_SDK_MARKER,
  AGENT_SDK_STORE_FORMAT,
  agentSdkCheckedFiles,
  agentSdkSupport,
  getAgentSdkDescriptor,
  hostPlatform,
  isAgentSdkFolderName,
  isValidAgentSdkInstall,
  platformPackageFor,
  readAgentSdkMarker,
  readAgentSdkPin,
  resolveAgentSdkRoot,
  writeAgentSdkLease,
} from './agent-sdk-paths.mjs';
import {
  CLI_SPAWN_DISABLED_ERROR,
  MAX_CAPTURED_OUTPUT_CHARS,
  isBatchLauncher,
  killTree as killProcessTree,
  quoteForCmd,
  runToCompletion,
  stripTerminalEscapes,
  tailOf,
} from './cli-process-runner.mjs';
import { resolveNpmInvocation } from './oar-cli-helpers.mjs';
import { windowsSystemToolPath } from '../../shared/windows-system-tools.mjs';
import { createRelaySingletonGuard, currentBootId, lockHolderMayRun, processIdentity } from './relay-singleton-guard.mjs';

/**
 * Installs the agent SDKs (and koffi on Windows) on demand, from the pins
 * folders the package ships (server/agent-sdks/), into versioned folders in
 * the state root (agent-sdk-paths.mjs has the layout). Modelled on
 * cli-install-service.mjs: a frozen table (nothing a caller sends reaches a
 * command), a single flight per SDK, snapshots with a log and logSeq.
 *
 * Per SDK:
 *
 *   missing -> installing -> ready | error | unsupported
 *
 * Only the disk decides ready: a folder is ready when its marker and the
 * files it lists check out. The settings row `agent_sdk_status` keeps the
 * last failure, so a restarted relay can show it.
 *
 * Several processes may use one store at once (a checkout and a global
 * install, `oar sdk install`, a test relay): each SDK has a lock file,
 * `.store.lock`, held by whoever installs or deletes, and every process
 * that uses a folder leaves a lease file in `.leases/<folder>/`. The clean-up
 * deletes no folder with a live lease.
 *
 * Install, under the lock:
 *   1. copy the pins (as this relay read them at start) into
 *      `<folder>.partial-<hex>` beside the final folder (one volume);
 *   2. `npm ci` there, from the lockfile, without install scripts, with the
 *      host's npm config but none a parent process put in the environment;
 *   3. check the files; write the marker (the files and their sizes) last;
 *   4. rename into place; then the clean-up.
 */

// An install is stopped once it makes no progress for this long: no npm
// output (npm logs each fetch, --loglevel=http) and no bytes growing in its
// folder or in npm's download cache. A slow link that keeps downloading goes
// on, up to the hard cap.
export const AGENT_SDK_INSTALL_STALL_MS = 5 * 60 * 1000;
export const AGENT_SDK_INSTALL_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const STALL_CHECK_MS = 15_000;
export const AGENT_SDK_LOG_FLUSH_MS = 250;
// Network failures are tried again after 1, 5 and 15 minutes.
export const AGENT_SDK_RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 15 * 60_000]);
export const AGENT_SDK_STATUS_SETTING_KEY = 'agent_sdk_status';
// A lease younger than this counts as live whatever its pid says: it covers
// the moment between writing it and the process it names being judged.
export const AGENT_SDK_LEASE_GRACE_MS = 2 * 60_000;
// Another process holds the lock: look again this often.
const LOCK_POLL_MS = 3_000;
// Windows Defender holds new files for a while: a rename into place is
// tried again for this long.
const RENAME_RETRY_MS = Object.freeze([100, 250, 500, 1000, 2000, 4000, 8000, 14000]);
// A relay a supervisor restarts in a loop does not download on every start.
const RESTART_QUIET_MS = 60_000;
// Longer roots leave too little of Windows' 260 characters for the SDKs'
// deepest files.
const MAX_ROOT_CHARS = 120;
const KILL_ESCALATION_MS = 2_000;

export const AGENT_SDK_STATES = Object.freeze({
  MISSING: 'missing',
  INSTALLING: 'installing',
  READY: 'ready',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
});

export const AGENT_SDK_FAILURE_KINDS = Object.freeze({
  NETWORK: 'network',
  PLATFORM: 'platform',
  CANCELLED: 'cancelled',
  OTHER: 'other',
});

// npm's own error codes, and the HTTP status of a registry that failed.
const NETWORK_ERROR = /\b(ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ERR_SOCKET_TIMEOUT|ESOCKETTIMEDOUT)\b|\bnpm (?:ERR!|error) (?:code )?E5\d\d\b|\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b|timed out after \d+ms/;
const PLATFORM_ERROR = /\bEBADPLATFORM\b/;

/**
 * Network, platform or other, from npm's output; with a message for the
 * cases whose fix is the user's.
 */
export function classifyAgentSdkFailure(text) {
  const value = String(text || '');
  if (PLATFORM_ERROR.test(value)) return { kind: AGENT_SDK_FAILURE_KINDS.PLATFORM, hint: null };
  if (/\bE407\b|407 Proxy Authentication Required/.test(value)) {
    return { kind: AGENT_SDK_FAILURE_KINDS.OTHER, hint: 'The proxy asks for a login: set it in your npm config (npm config set proxy …).' };
  }
  if (/\bENOSPC\b/.test(value)) return { kind: AGENT_SDK_FAILURE_KINDS.OTHER, hint: 'The disk is full.' };
  if (/\bEINTEGRITY\b/.test(value)) return { kind: AGENT_SDK_FAILURE_KINDS.OTHER, hint: 'npm\'s cache holds a damaged copy: run npm cache verify, then try again.' };
  if (NETWORK_ERROR.test(value)) return { kind: AGENT_SDK_FAILURE_KINDS.NETWORK, hint: 'No connection to the npm registry. OAR needs it once per SDK version.' };
  return { kind: AGENT_SDK_FAILURE_KINDS.OTHER, hint: null };
}

// npm config a parent process sets in the environment (`npm start` sets
// dozens) would apply to these installs too; only what reaches the registry
// is kept (with npm's offline settings, for a host that installs from its
// cache), so proxies and mirrors still work.
const KEPT_NPM_CONFIG = /^npm_config_(registry|@[^_]+:registry|_auth.*|.*:_auth.*|.*_authtoken|proxy|https_proxy|http_proxy|noproxy|no_proxy|cafile|ca|cert|key|strict_ssl|userconfig|globalconfig|cache|fetch_retries|fetch_retry_.*|fetch_timeout|maxsockets|local_address|offline|prefer_offline|prefer_online)$/i;

export function agentSdkNpmEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (/^npm_(package|lifecycle)_/i.test(key)) continue;
    if (/^npm_config_/i.test(key) && !KEPT_NPM_CONFIG.test(key)) continue;
    if (/^OAR_AGENT_SDK_DIR_/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * The npm argv of an install, the same for every pins folder: scripts off.
 * The SDK trees have none; koffi has one, which only builds from source where
 * its prebuilt optional package (@koromix/koffi-<os>-<arch>, no script) is
 * missing, and the store requires that package anyway. npm 11.16 and later
 * refuse --allow-scripts on a project install, so allowing it is no option.
 */
export function agentSdkNpmArgs() {
  return [
    'ci',
    // Not a workspace of a package.json above the folder, whatever is there.
    '--no-workspaces',
    '--include=prod', '--include=optional', '--omit=dev',
    '--ignore-scripts',
    '--no-dry-run', '--package-lock=true', '--install-strategy=hoisted',
    '--no-audit', '--no-fund', '--no-update-notifier',
    // A line per fetch: the log moves while a slow link downloads.
    '--loglevel=http',
  ];
}

/** npm's cache folder as the environment or the platform default names it. */
export function npmCacheDirOf(env = process.env, platform = process.platform) {
  const configured = String(env?.npm_config_cache || env?.NPM_CONFIG_CACHE || '').trim();
  if (configured) return path.resolve(configured);
  if (platform === 'win32') return path.join(String(env?.LOCALAPPDATA || '').trim() || path.join(os.homedir(), 'AppData', 'Local'), 'npm-cache');
  return path.join(String(env?.HOME || '').trim() || os.homedir(), '.npm');
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

export function createAgentSdkStore({
  env = process.env,
  platform = process.platform,
  host = hostPlatform({ platform }),
  root = resolveAgentSdkRoot({ env, platform }),
  pinsDir,
  ids = AGENT_SDK_IDS,
  pid = process.pid,
  spawnImpl = spawn,
  processKillImpl = process.kill.bind(process),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { setTimeoutImpl(resolve, ms)?.unref?.(); }),
  fsImpl = fs,
  logger = console,
  readSetting = () => null,
  writeSetting = () => {},
  npmInvocation = () => resolveNpmInvocation({ env: agentSdkNpmEnv(env), platform }),
  // Whether a lease or an install's owner may still run (relay-singleton-guard).
  holderMayRun = (record) => lockHolderMayRun({ lock: record, platform }),
  identityOf = processIdentity,
  bootIdOf = currentBootId,
  lockFactory = (lockPath) => createRelaySingletonGuard({
    lockPath, pid, token: crypto.randomBytes(16).toString('hex'), logger: { warn: () => {} }, platform,
  }),
  installTimeoutMs = AGENT_SDK_INSTALL_TIMEOUT_MS,
  installStallMs = AGENT_SDK_INSTALL_STALL_MS,
  stallCheckMs = STALL_CHECK_MS,
  // Where npm writes a download while it runs (npm's cache, _cacache/tmp).
  npmCacheDir = () => npmCacheDirOf(env, platform),
  logFlushMs = AGENT_SDK_LOG_FLUSH_MS,
  retryDelaysMs = AGENT_SDK_RETRY_DELAYS_MS,
  lockPollMs = LOCK_POLL_MS,
  renameRetryMs = RENAME_RETRY_MS,
  leaseGraceMs = AGENT_SDK_LEASE_GRACE_MS,
  // Overrides the descriptors' host-CLI platforms (tests).
  hostCliPlatforms,
  // A git checkout runs the SDKs it has installed as devDependencies: the
  // status says so instead of "not installed"; per SDK (agentSdkFromCheckout).
  fromCheckout = () => false,
} = {}) {
  const listeners = new Set();
  const readyHooks = new Set();
  const sdks = new Map();
  const pins = new Map();
  let logFlushTimer = null;
  let logEmitPending = false;
  let disposed = false;
  const ownLeases = new Map();

  const log = (message) => {
    try { logger?.log?.(`[agent-sdk] ${message}`); } catch {}
  };

  // The relay's own environment never passes a worker's folder on: a relay
  // started from inside a session would take that session's SDK.
  if (env === process.env) {
    for (const key of Object.keys(env)) if (/^OAR_AGENT_SDK_DIR_/i.test(key)) delete env[key];
  }

  const rootProblem = (() => {
    if (platform === 'win32' && /^[\\/]{2}/.test(root)) return `The SDK folder ${root} is a network path; set OAR_SDK_DIR to a local folder.`;
    if (platform === 'win32' && root.length > MAX_ROOT_CHARS) return `The SDK folder ${root} is longer than ${MAX_ROOT_CHARS} characters; set OAR_SDK_DIR to a shorter one.`;
    return null;
  })();

  function pinOf(id) {
    if (!pins.has(id)) pins.set(id, readAgentSdkPin(id, { ...(pinsDir ? { pinsDir } : {}), host }));
    return pins.get(id);
  }

  function sdkDir(id) {
    return path.join(root, id);
  }

  function pinnedDir(id) {
    return path.join(sdkDir(id), pinOf(id).dirName);
  }

  // ─── The persisted row ─────────────────────────────────────────────────────

  function readPersisted() {
    try {
      const parsed = JSON.parse(String(readSetting(AGENT_SDK_STATUS_SETTING_KEY) || ''));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function persist(id, record) {
    try {
      const all = readPersisted();
      if (record) all[id] = record;
      else delete all[id];
      writeSetting(AGENT_SDK_STATUS_SETTING_KEY, JSON.stringify(all));
    } catch (error) {
      log(`could not save the ${id} status: ${error?.message || error}`);
    }
  }

  // ─── State ─────────────────────────────────────────────────────────────────

  function initialState(id) {
    const descriptor = getAgentSdkDescriptor(id);
    const pin = pinOf(id);
    const support = agentSdkSupport(pin, { hostCliPlatforms: hostCliPlatforms?.[id] });
    const entry = {
      id,
      label: descriptor.label,
      pinned: pin.version,
      folder: pin.dirName,
      support,
      state: AGENT_SDK_STATES.MISSING,
      installed: null,
      dir: null,
      log: '',
      logSeq: 0,
      error: null,
      kind: null,
      retryAt: null,
      attempts: 0,
      heldBy: null,
      startedAt: null,
      finishedAt: null,
      lastAttemptAt: null,
      session: null,
      retryTimer: null,
      generation: 0,
      waiters: [],
    };
    if (support === 'no') {
      entry.state = AGENT_SDK_STATES.UNSUPPORTED;
      entry.kind = AGENT_SDK_FAILURE_KINDS.PLATFORM;
      entry.error = `${descriptor.label} is not available on this platform (${host.platform}-${host.arch}${host.libc === 'musl' ? '-musl' : ''}).`;
      return entry;
    }
    const stored = readPersisted()[id];
    if (stored && stored.hash === pin.hash && stored.error) {
      // npm's EBADPLATFORM stays "not available" across a restart: never retried.
      entry.state = stored.kind === AGENT_SDK_FAILURE_KINDS.PLATFORM ? AGENT_SDK_STATES.UNSUPPORTED : AGENT_SDK_STATES.ERROR;
      entry.error = stored.error;
      entry.kind = stored.kind || AGENT_SDK_FAILURE_KINDS.OTHER;
      entry.attempts = Number(stored.attempts) || 0;
      entry.lastAttemptAt = stored.lastAttemptAt || null;
    }
    return entry;
  }

  function entryOf(id) {
    if (!sdks.has(id)) sdks.set(id, initialState(id));
    return sdks.get(id);
  }

  /** The pinned folder when it checks out, else null. Never throws. */
  function readyDir(id) {
    const descriptor = getAgentSdkDescriptor(id);
    if (!descriptor || !ids.includes(descriptor.id)) return null;
    try {
      const dir = pinnedDir(descriptor.id);
      return isValidAgentSdkInstall(dir, { pin: pinOf(descriptor.id), fsImpl }) ? dir : null;
    } catch {
      return null;
    }
  }

  // The disk against the state: a folder that checks out is ready, whatever
  // the row says; a ready folder that stopped checking out is missing.
  function settle(entry) {
    if (entry.state === AGENT_SDK_STATES.UNSUPPORTED || entry.session) return entry;
    const dir = readyDir(entry.id);
    if (dir) {
      if (entry.state !== AGENT_SDK_STATES.READY) {
        entry.state = AGENT_SDK_STATES.READY;
        entry.error = null;
        entry.kind = null;
        entry.retryAt = null;
        entry.attempts = 0;
        clearRetry(entry);
        persist(entry.id, null);
      }
      entry.installed = entry.pinned;
      entry.dir = dir;
      leaseOwn(entry.id, dir);
    } else if (entry.state === AGENT_SDK_STATES.READY) {
      entry.state = AGENT_SDK_STATES.MISSING;
      entry.installed = null;
      entry.dir = null;
    }
    return entry;
  }

  function publicStatus(entry) {
    return {
      id: entry.id,
      label: entry.label,
      state: entry.state,
      pinned: entry.pinned,
      installed: entry.installed,
      folder: entry.folder,
      dir: entry.dir,
      support: entry.support,
      log: entry.log,
      logSeq: entry.logSeq,
      error: entry.error,
      kind: entry.kind,
      retryAt: entry.retryAt ? new Date(entry.retryAt).toISOString() : null,
      attempts: entry.attempts,
      heldBy: entry.heldBy,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      active: Boolean(entry.session),
      canInstall: !rootProblem && entry.state !== AGENT_SDK_STATES.UNSUPPORTED && !entry.session && !spawnsDisabled(),
      source: 'store',
    };
  }

  function status(id) {
    const descriptor = getAgentSdkDescriptor(id);
    if (!descriptor || !ids.includes(descriptor.id)) return null;
    const value = publicStatus(settle(entryOf(descriptor.id)));
    if (!fromCheckout(descriptor.id) || value.active || value.state === AGENT_SDK_STATES.UNSUPPORTED) return value;
    return { ...value, state: AGENT_SDK_STATES.READY, installed: value.pinned, dir: null, error: null, kind: null, retryAt: null, canInstall: false, source: 'checkout' };
  }

  function snapshot() {
    const out = {};
    for (const id of ids) out[id] = status(id);
    return { root, host: { ...host }, checkout: ids.some((id) => fromCheckout(id)), sdks: out };
  }

  function emit() {
    if (disposed) return;
    const value = snapshot();
    for (const listener of [...listeners]) {
      try { listener(value); } catch (error) { log(`listener failed: ${error?.message || error}`); }
    }
  }

  function clearLogFlush() {
    if (logFlushTimer) clearTimeoutImpl(logFlushTimer);
    logFlushTimer = null;
    logEmitPending = false;
  }

  function armLogFlush() {
    logFlushTimer = setTimeoutImpl(() => {
      logFlushTimer = null;
      if (!logEmitPending) return;
      logEmitPending = false;
      emit();
      armLogFlush();
    }, logFlushMs);
    logFlushTimer?.unref?.();
  }

  // Log lines are coalesced to four broadcasts a second; transitions are not.
  function emitLog() {
    if (logFlushTimer) {
      logEmitPending = true;
      return;
    }
    emit();
    armLogFlush();
  }

  function transition(entry, state, fields = {}) {
    entry.state = state;
    Object.assign(entry, fields);
    clearLogFlush();
    emit();
  }

  function appendLog(entry, session, text) {
    if (entry.session !== session) return;
    entry.log = `${entry.log}${stripTerminalEscapes(text)}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
    entry.logSeq += 1;
    emitLog();
  }

  // ─── Leases ────────────────────────────────────────────────────────────────

  function writeLease(dir, leasePid = pid) {
    return writeAgentSdkLease(dir, {
      pid: leasePid,
      holder: (() => { try { return identityOf(leasePid); } catch { return null; } })(),
      bootId: (() => { try { return bootIdOf(); } catch { return ''; } })(),
      fsImpl,
    });
  }

  // This relay's own lease on the folder it uses: another relay with other
  // pins must not clean it away.
  function leaseOwn(id, dir) {
    if (ownLeases.get(id) === dir) return;
    if (writeLease(dir)) ownLeases.set(id, dir);
  }

  function leaseIsLive(file) {
    try {
      const stat = fsImpl.statSync(file);
      if (now() - stat.mtimeMs < leaseGraceMs) return true;
      const lease = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
      return holderMayRun(lease);
    } catch {
      return false;
    }
  }

  function liveLeases(id, folderName) {
    const dir = path.join(sdkDir(id), AGENT_SDK_LEASES_DIR, folderName);
    let names = [];
    try { names = fsImpl.readdirSync(dir); } catch { return []; }
    return names.filter((name) => name.endsWith('.json') && leaseIsLive(path.join(dir, name)));
  }

  function pruneLeases(id) {
    const leasesRoot = path.join(sdkDir(id), AGENT_SDK_LEASES_DIR);
    let folders = [];
    try { folders = fsImpl.readdirSync(leasesRoot); } catch { return; }
    for (const folder of folders) {
      const dir = path.join(leasesRoot, folder);
      let names = [];
      try { names = fsImpl.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!leaseIsLive(path.join(dir, name))) try { fsImpl.rmSync(path.join(dir, name), { force: true }); } catch {}
      }
      try {
        if (!fsImpl.readdirSync(dir).length && !fsImpl.existsSync(path.join(sdkDir(id), folder))) fsImpl.rmdirSync(dir);
      } catch {}
    }
  }

  // ─── The lock and the clean-up ─────────────────────────────────────────────

  function tryLock(id) {
    fsImpl.mkdirSync(sdkDir(id), { recursive: true });
    const guard = lockFactory(path.join(sdkDir(id), '.store.lock'));
    try {
      guard.acquire();
      return { guard, heldBy: null };
    } catch (error) {
      if (error?.code !== 'ERELAYLOCKED') throw error;
      let heldBy = null;
      try { heldBy = Number(JSON.parse(fsImpl.readFileSync(path.join(sdkDir(id), '.store.lock'), 'utf8')).pid) || null; } catch {}
      return { guard: null, heldBy };
    }
  }

  function releaseLock(lock) {
    try { lock?.guard?.release(); } catch (error) { log(`could not release a store lock: ${error?.message || error}`); }
  }

  // A whole SDK folder (hundreds of MB) is deleted off the event loop: the
  // relay keeps serving meanwhile.
  async function removeTreeAsync(dir) {
    try {
      await (fsImpl.promises || fs.promises).rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return true;
    } catch {
      return false;
    }
  }

  // What an install of a dead process left: its partial folder (whose npm
  // may still run on POSIX, detached) and folders moved aside to delete.
  // Only ever under the lock, so nothing found belongs to a live install.
  // Returns a promise only when there is something to delete, so an
  // install with nothing left over spawns npm without a detour.
  function cleanUpLeftovers(id) {
    let names = [];
    try { names = fsImpl.readdirSync(sdkDir(id)); } catch { return null; }
    const removals = [];
    for (const name of names) {
      const full = path.join(sdkDir(id), name);
      if (/\.partial-[0-9a-f]+$/.test(name)) {
        try {
          const owner = JSON.parse(fsImpl.readFileSync(path.join(full, '.owner.json'), 'utf8'));
          if (owner?.pid && holderMayRun(owner)) killOrphan(owner.pid);
        } catch {}
        removals.push(removeTreeAsync(full));
      } else if (/^\.trash-[0-9a-f]+$/.test(name)) {
        removals.push(removeTreeAsync(full));
      } else if (isAgentSdkFolderName(name) && !readAgentSdkMarker(full, { fsImpl })) {
        // A folder under a final name without a marker is never valid.
        moveAside(id, full);
      }
    }
    return removals.length ? Promise.all(removals) : null;
  }

  // Bytes under `dir`, at most `limit` entries looked at; 0 when it is not there.
  function folderBytes(dir, limit = 20_000) {
    let total = 0;
    let seen = 0;
    const walk = (current) => {
      let entries = [];
      try { entries = fsImpl.readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const item of entries) {
        if (++seen > limit) return;
        const full = path.join(current, item.name);
        if (item.isDirectory()) walk(full);
        else {
          try { total += fsImpl.statSync(full).size; } catch {}
        }
      }
    };
    if (dir) walk(dir);
    return total;
  }

  // The stall watch of a running install: progress is npm output or bytes
  // growing in its folder or in npm's download cache; none for
  // installStallMs stops npm, and the failure counts as a network one.
  function watchProgress(entry, session, partial) {
    let lastAt = now();
    let lastBytes = -1;
    let timer = null;
    let cacheTmp = null;
    try { cacheTmp = path.join(npmCacheDir(), '_cacache', 'tmp'); } catch {}
    const tick = () => {
      timer = null;
      if (entry.session !== session || !session.child) {
        if (entry.session === session) arm();
        return;
      }
      const bytes = folderBytes(path.join(partial, 'node_modules')) + folderBytes(cacheTmp, 2_000);
      if (bytes !== lastBytes) {
        lastBytes = bytes;
        lastAt = now();
      }
      if (now() - lastAt >= installStallMs) {
        session.stalled = true;
        log(`${entry.id}: no progress for ${Math.round(installStallMs / 1000)} s, stopping npm`);
        terminate(session.child);
        return;
      }
      arm();
    };
    const arm = () => {
      timer = setTimeoutImpl(tick, stallCheckMs);
      timer?.unref?.();
    };
    arm();
    return {
      progress: () => { lastAt = now(); },
      stop: () => {
        if (timer) clearTimeoutImpl(timer);
        timer = null;
      },
    };
  }

  // An npm a dead install left running (POSIX runs it detached, as a group).
  function killOrphan(orphanPid) {
    if (platform === 'win32') return killWindowsTree(orphanPid);
    try {
      processKillImpl(-orphanPid, 'SIGKILL');
    } catch {
      try { processKillImpl(orphanPid, 'SIGKILL'); } catch {}
    }
  }

  // A Windows process and everything it started (taskkill, no PowerShell).
  function killWindowsTree(treePid) {
    try {
      // System32's own, not whatever PATH holds under that name.
      const killer = spawnImpl(windowsSystemToolPath('taskkill', { env }), ['/PID', String(Number(treePid)), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer?.on?.('error', () => {});
      killer?.unref?.();
    } catch {
      try { processKillImpl(Number(treePid), 'SIGKILL'); } catch {}
    }
  }

  function moveAside(id, dir) {
    const trash = path.join(sdkDir(id), `.trash-${crypto.randomBytes(3).toString('hex')}`);
    try {
      fsImpl.renameSync(dir, trash);
    } catch {
      // In use (Windows) or gone: tried again at the next start.
      return null;
    }
    return trash;
  }

  /**
   * Keeps the pinned folder, the newest other one (the version before) and
   * every folder a live process leases; the rest go. A folder is moved aside
   * first, the leases looked at again (a worker may have leased it in
   * between), and only then deleted; a delete Windows refuses (a file in
   * use) is tried again at the next start. Under the lock.
   */
  function collectGarbage(id) {
    let names = [];
    try { names = fsImpl.readdirSync(sdkDir(id)); } catch { return null; }
    const removals = [];
    const pin = pinOf(id);
    const others = [];
    for (const name of names) {
      if (!isAgentSdkFolderName(name) || name === pin.dirName) continue;
      const marker = readAgentSdkMarker(path.join(sdkDir(id), name), { fsImpl });
      // A folder made for another platform (a root Windows and WSL share)
      // is that platform's relays' to keep or delete: their pids mean
      // nothing here, so their leases cannot be judged.
      if (marker && (marker.platform !== host.platform || marker.arch !== host.arch || (marker.libc || null) !== (host.libc || null))) continue;
      others.push({ name, at: Date.parse(marker?.installedAt || '') || 0 });
    }
    others.sort((a, b) => b.at - a.at);
    for (const { name } of others.slice(1)) {
      if (liveLeases(id, name).length) continue;
      const trash = moveAside(id, path.join(sdkDir(id), name));
      if (!trash) continue;
      if (liveLeases(id, name).length) {
        try { fsImpl.renameSync(trash, path.join(sdkDir(id), name)); } catch {}
        continue;
      }
      removals.push(removeTreeAsync(trash));
    }
    pruneLeases(id);
    return removals.length ? Promise.all(removals) : null;
  }

  // ─── Installing ────────────────────────────────────────────────────────────

  function spawnsDisabled() {
    if (!normalizeText(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN)) return false;
    // The e2e harness keeps spawns off and drives a stub installer: both the
    // opt-in and the stub command are needed.
    return !(normalizeText(env?.COPILOT_WEB_RELAY_CLI_INSTALL_ALLOW_STUB_SPAWN) && normalizeText(env?.COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND));
  }

  function spawnNpm(id, cwd) {
    const stub = normalizeText(env?.COPILOT_WEB_RELAY_AGENT_SDK_INSTALL_COMMAND);
    const npm = npmInvocation();
    const [command, args] = stub && !spawnsDisabled()
      ? [stub, [id]]
      : [npm.command, agentSdkNpmArgs()];
    // npm.cmd needs a shell on Windows: one quoted command line, no args.
    const batch = isBatchLauncher(command, platform);
    return spawnImpl(batch ? [command, ...args].map(quoteForCmd).join(' ') : command, batch ? [] : args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: agentSdkNpmEnv(npm.env || env),
      ...(platform === 'win32' ? { windowsHide: true, ...(batch ? { shell: true } : {}) } : { detached: true }),
    });
  }

  function terminate(child) {
    // Windows: npm runs under cmd.exe (npm.cmd needs a shell), and killing
    // the shell would leave npm's node running; the whole tree goes.
    if (platform === 'win32') {
      if (child?.exitCode === null && Number(child?.pid) > 0) killWindowsTree(child.pid);
      return;
    }
    killProcessTree(child, 'SIGTERM', { platform, processKillImpl });
    const escalation = setTimeoutImpl(() => killProcessTree(child, 'SIGKILL', { platform, processKillImpl }), KILL_ESCALATION_MS);
    escalation?.unref?.();
  }

  // Every file and folder of the tree to disk before the marker says it is
  // complete (POSIX; a power loss otherwise can leave empty files behind a
  // valid-looking marker). Asynchronous, a few at a time: the Claude tree
  // takes over a minute on a slow disk, and the relay must keep running
  // meanwhile (heartbeats, the recycle's sweeps, deliveries).
  async function syncTree(dir) {
    if (platform === 'win32') return;
    const fsp = fsImpl.promises || fs.promises;
    const targets = [];
    const walk = async (current) => {
      let entries = [];
      try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) targets.push(full);
      }
      targets.push(current);
    };
    await walk(dir);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const target = targets[next];
        next += 1;
        let handle = null;
        try {
          handle = await fsp.open(target, 'r');
          await handle.sync();
        } catch {} finally {
          try { await handle?.close(); } catch {}
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
  }

  function syncPath(target) {
    if (platform === 'win32') return;
    let fd = null;
    try {
      fd = fsImpl.openSync(target, 'r');
      fsImpl.fsyncSync(fd);
    } catch {} finally {
      if (fd !== null) try { fsImpl.closeSync(fd); } catch {}
    }
  }

  // The files the marker records with their sizes: the checked list, and the
  // platform package's top-level and bin/ files (the binaries an antivirus
  // might take).
  function checkedFiles(id, dir) {
    const pin = pinOf(id);
    const files = {};
    const add = (rel) => {
      const stat = fsImpl.statSync(path.join(dir, ...rel.split('/')));
      if (stat.isFile()) files[rel] = stat.size;
    };
    for (const rel of agentSdkCheckedFiles(pin)) add(rel);
    const platformPackage = platformPackageFor(pin);
    if (platformPackage) {
      for (const sub of ['', 'bin']) {
        const base = path.join(dir, 'node_modules', ...platformPackage.split('/'), sub);
        let names = [];
        try { names = fsImpl.readdirSync(base, { withFileTypes: true }); } catch { continue; }
        for (const entry of names) if (entry.isFile()) add(`node_modules/${platformPackage}/${sub ? `${sub}/` : ''}${entry.name}`);
      }
    }
    return files;
  }

  function writeMarker(id, dir) {
    const pin = pinOf(id);
    const marker = {
      format: AGENT_SDK_STORE_FORMAT,
      id,
      version: pin.version,
      hash: pin.hash,
      platform: host.platform,
      arch: host.arch,
      libc: host.libc || null,
      platformPackage: platformPackageFor(pin),
      installedAt: new Date(now()).toISOString(),
      files: checkedFiles(id, dir),
    };
    const tmp = path.join(dir, `.${AGENT_SDK_MARKER}.tmp`);
    fsImpl.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`);
    syncPath(tmp);
    fsImpl.renameSync(tmp, path.join(dir, AGENT_SDK_MARKER));
    return marker;
  }

  // The partial folder into place. A final folder that checks out by now
  // (a lock taken over from a process that was still finishing) wins, except
  // for a reinstall (`replace`); one that does not is moved aside first: a
  // rename never goes over a folder. Workers that use the folder find the
  // new copy under the same path.
  // Returns false when `stillCurrent()` turned false between two tries (a
  // cancel, dispose): nothing was moved, the caller lets go.
  async function renameIntoPlace(id, partial, { replace = false, stillCurrent = () => true } = {}) {
    const final = pinnedDir(id);
    for (let attempt = 0; ; attempt += 1) {
      if (!stillCurrent()) return false;
      if (!replace && isValidAgentSdkInstall(final, { pin: pinOf(id), fsImpl })) {
        await removeTreeAsync(partial);
        return true;
      }
      if (fsImpl.existsSync(final) && !moveAside(id, final)) {
        if (attempt >= renameRetryMs.length) throw new Error(`The folder ${final} is in use; stop the sessions that use it, then try again.`);
        await sleep(renameRetryMs[attempt]);
        continue;
      }
      try {
        fsImpl.renameSync(partial, final);
        if (platform !== 'win32') syncPath(sdkDir(id));
        return true;
      } catch (error) {
        if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST'].includes(error?.code) || attempt >= renameRetryMs.length) {
          throw new Error(`The new ${getAgentSdkDescriptor(id).label} folder could not be moved into place (${error?.code || error?.message || error}).`);
        }
        await sleep(renameRetryMs[attempt]);
      }
    }
  }

  function clearRetry(entry) {
    if (entry.retryTimer) clearTimeoutImpl(entry.retryTimer);
    entry.retryTimer = null;
    entry.retryAt = null;
  }

  function scheduleRetry(entry) {
    clearRetry(entry);
    const delay = retryDelaysMs[entry.attempts - 1];
    if (delay === undefined || disposed) return;
    entry.retryAt = now() + delay;
    entry.retryTimer = setTimeoutImpl(() => {
      entry.retryTimer = null;
      entry.retryAt = null;
      void startInstall(entry.id, { reason: 'retry', manual: false });
    }, delay);
    entry.retryTimer?.unref?.();
  }

  function settleWaiters(entry) {
    const waiters = entry.waiters.splice(0);
    const value = publicStatus(entry);
    for (const resolve of waiters) resolve(value);
  }

  function fail(entry, session, message, kind, { lock = null, partial = null } = {}) {
    // The partial folder goes first, off the event loop: whoever sees the
    // failure finds it gone and the lock free.
    if (partial) return removeTreeAsync(partial).then(() => fail(entry, session, message, kind, { lock }));
    releaseLock(lock);
    if (entry.session !== session) return;
    entry.session = null;
    entry.heldBy = null;
    entry.finishedAt = new Date(now()).toISOString();
    entry.lastAttemptAt = entry.finishedAt;
    if (kind === AGENT_SDK_FAILURE_KINDS.PLATFORM) {
      transition(entry, AGENT_SDK_STATES.UNSUPPORTED, { error: message, kind });
    } else {
      transition(entry, AGENT_SDK_STATES.ERROR, { error: message, kind });
      if (kind === AGENT_SDK_FAILURE_KINDS.NETWORK) scheduleRetry(entry);
      if (entry.retryAt) emit();
    }
    if (kind !== AGENT_SDK_FAILURE_KINDS.CANCELLED) {
      persist(entry.id, { hash: pinOf(entry.id).hash, error: message, kind, attempts: entry.attempts, lastAttemptAt: entry.lastAttemptAt });
    }
    log(`${entry.id}: ${message}`);
    settleWaiters(entry);
  }

  // The clean-up only under the lock: a folder another process installed
  // is that process's to tidy. Synchronous unless there is a folder to
  // delete.
  function succeed(entry, session, lock) {
    const collecting = lock?.guard ? collectGarbage(entry.id) : null;
    if (!collecting) return finishSucceed(entry, session, lock);
    return collecting
      .catch((error) => log(`${entry.id}: clean-up failed: ${error?.message || error}`))
      .then(() => finishSucceed(entry, session, lock));
  }

  function finishSucceed(entry, session, lock) {
    releaseLock(lock);
    if (entry.session !== session) return;
    entry.session = null;
    entry.heldBy = null;
    entry.finishedAt = new Date(now()).toISOString();
    entry.lastAttemptAt = entry.finishedAt;
    entry.attempts = 0;
    clearRetry(entry);
    persist(entry.id, null);
    const dir = readyDir(entry.id);
    if (dir) leaseOwn(entry.id, dir);
    transition(entry, AGENT_SDK_STATES.READY, { installed: entry.pinned, dir, error: null, kind: null });
    settleWaiters(entry);
    for (const hook of [...readyHooks]) {
      try { hook(publicStatus(entry)); } catch (error) { log(`ready hook failed: ${error?.message || error}`); }
    }
  }

  async function runInstall(entry, session) {
    // The lock: polled while another process holds it, which then usually
    // finishes the same install.
    let lock = null;
    for (;;) {
      if (entry.session !== session) return;
      if (!session.force && readyDir(entry.id)) return succeed(entry, session, null);
      try {
        lock = tryLock(entry.id);
      } catch (error) {
        return fail(entry, session, `The SDK folder could not be locked (${error?.code || error?.message || error}).`, AGENT_SDK_FAILURE_KINDS.OTHER);
      }
      if (lock.guard) break;
      if (entry.heldBy !== lock.heldBy) {
        entry.heldBy = lock.heldBy;
        emit();
      }
      await sleep(lockPollMs);
    }
    if (entry.session !== session) return releaseLock(lock);
    entry.heldBy = null;
    if (!session.force && readyDir(entry.id)) return succeed(entry, session, lock);
    const cleaning = cleanUpLeftovers(entry.id);
    if (cleaning) await cleaning;
    // A cancel or dispose while the leftovers went: no folder, no npm.
    if (entry.session !== session) return releaseLock(lock);

    const pin = pinOf(entry.id);
    const partial = path.join(sdkDir(entry.id), `${pin.dirName}.partial-${crypto.randomBytes(3).toString('hex')}`);
    try {
      fsImpl.mkdirSync(partial, { recursive: true });
      for (const [name, bytes] of Object.entries(pin.files)) fsImpl.writeFileSync(path.join(partial, name), bytes);
    } catch (error) {
      return fail(entry, session, `The SDK folder could not be written (${error?.code || error?.message || error}).`, AGENT_SDK_FAILURE_KINDS.OTHER, { lock, partial });
    }

    const watch = watchProgress(entry, session, partial);
    const result = await runToCompletion(() => spawnNpm(entry.id, partial), {
      timeoutMs: installTimeoutMs,
      setTimeoutImpl,
      clearTimeoutImpl,
      killChild: (child) => terminate(child),
      maxOutputChars: MAX_CAPTURED_OUTPUT_CHARS,
      onChild: (child) => {
        session.child = child;
        try {
          fsImpl.writeFileSync(path.join(partial, '.owner.json'), JSON.stringify({ format: 2, pid: child.pid, holder: identityOf(child.pid), startedAt: new Date(now()).toISOString() }));
        } catch {}
      },
      onOutput: (text) => {
        watch.progress();
        appendLog(entry, session, text);
      },
    });
    watch.stop();
    if (session.stalled) {
      result.ok = false;
      result.error = `npm made no progress for ${Math.round(installStallMs / 60_000)} minutes (timed out after ${installStallMs}ms)`;
    }
    if (entry.session !== session) {
      // Cancelled: the child is gone or going; its folder goes with it.
      await removeTreeAsync(partial);
      return releaseLock(lock);
    }
    if (!result.ok) {
      const output = stripTerminalEscapes(`${result.output || ''}\n${result.error || ''}`);
      const { kind, hint } = classifyAgentSdkFailure(output);
      if (/ENOENT/.test(String(result.error || '')) && result.code === null && !result.output) {
        return fail(entry, session, 'npm was not found next to this Node; install npm, then try again.', AGENT_SDK_FAILURE_KINDS.OTHER, { lock, partial });
      }
      const tail = session.stalled
        ? result.error
        : (tailOf(stripTerminalEscapes(result.output || '')) || result.error || `npm ci exited with code ${result.code}`);
      return fail(entry, session, hint ? `${hint} (${tail})` : tail, kind, { lock, partial });
    }
    // npm said yes; the files decide. A platform package npm left out here
    // is the host's npm config (omit=optional, os, cpu), never the platform.
    const platformPackage = platformPackageFor(pin);
    if (platformPackage && !fsImpl.existsSync(path.join(partial, 'node_modules', ...platformPackage.split('/'), 'package.json'))) {
      return fail(entry, session, `npm installed ${getAgentSdkDescriptor(entry.id).packageName} without ${platformPackage}; check the npm config for omit, os or cpu settings.`, AGENT_SDK_FAILURE_KINDS.OTHER, { lock, partial });
    }
    try {
      for (const rel of agentSdkCheckedFiles(pin)) {
        if (!fsImpl.existsSync(path.join(partial, ...rel.split('/')))) throw new Error(`${rel} is missing after npm ci`);
      }
      try { fsImpl.rmSync(path.join(partial, '.owner.json'), { force: true }); } catch {}
      await syncTree(partial);
      // A cancel or dispose meanwhile: the folder never goes into place.
      const current = () => entry.session === session;
      if (!current()) {
        await removeTreeAsync(partial);
        return releaseLock(lock);
      }
      writeMarker(entry.id, partial);
      if (!(await renameIntoPlace(entry.id, partial, { replace: session.force, stillCurrent: current }))) {
        await removeTreeAsync(partial);
        return releaseLock(lock);
      }
    } catch (error) {
      return fail(entry, session, error?.message || String(error), AGENT_SDK_FAILURE_KINDS.OTHER, { lock, partial });
    }
    return succeed(entry, session, lock);
  }

  /**
   * Starts an install, or joins the one running. `manual` (a button) resets
   * the automatic retries; `force` installs again over a ready folder (the
   * Reinstall button). Returns at once; ensure() waits.
   */
  function startInstall(id, { reason = 'request', manual = true, force = false } = {}) {
    const descriptor = getAgentSdkDescriptor(id);
    if (!descriptor || !ids.includes(descriptor.id)) return { ok: false, statusCode: 400, error: 'Unknown agent SDK' };
    const entry = settle(entryOf(descriptor.id));
    if (entry.state === AGENT_SDK_STATES.UNSUPPORTED) return { ok: false, statusCode: 409, error: entry.error, status: publicStatus(entry) };
    if (entry.session) return { ok: true, reused: true, status: publicStatus(entry) };
    if (entry.state === AGENT_SDK_STATES.READY && !force) return { ok: true, ready: true, status: publicStatus(entry) };
    if (rootProblem) {
      log(`${entry.id}: not installed: ${rootProblem}`);
      entry.lastAttemptAt = new Date(now()).toISOString();
      transition(entry, AGENT_SDK_STATES.ERROR, { error: rootProblem, kind: AGENT_SDK_FAILURE_KINDS.OTHER });
      settleWaiters(entry);
      return { ok: false, statusCode: 409, error: rootProblem, status: publicStatus(entry) };
    }
    if (spawnsDisabled()) {
      log(`${entry.id}: not installed: ${CLI_SPAWN_DISABLED_ERROR} (COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN)`);
      transition(entry, AGENT_SDK_STATES.ERROR, { error: CLI_SPAWN_DISABLED_ERROR, kind: AGENT_SDK_FAILURE_KINDS.OTHER });
      settleWaiters(entry);
      return { ok: false, statusCode: 503, error: CLI_SPAWN_DISABLED_ERROR, status: publicStatus(entry) };
    }
    clearRetry(entry);
    if (manual) entry.attempts = 0;
    entry.attempts += 1;
    entry.generation += 1;
    const session = { generation: entry.generation, child: null, reason, force: Boolean(force) };
    entry.session = session;
    entry.log = '';
    entry.startedAt = new Date(now()).toISOString();
    entry.finishedAt = null;
    entry.heldBy = null;
    transition(entry, AGENT_SDK_STATES.INSTALLING, { error: null, kind: null });
    log(`${entry.id}: installing ${entry.pinned} (${reason})`);
    runInstall(entry, session).catch((error) => fail(entry, session, error?.message || String(error), AGENT_SDK_FAILURE_KINDS.OTHER));
    return { ok: true, reused: false, status: publicStatus(entry) };
  }

  /**
   * Resolves with the SDK's status once it is ready, failed or not available
   * here, installing a missing one first (the launch gate's call); joins an
   * install that runs.
   */
  function ensure(id, { reason = 'launch', retryFailed = false } = {}) {
    const descriptor = getAgentSdkDescriptor(id);
    if (!descriptor || !ids.includes(descriptor.id)) return Promise.resolve(null);
    // A failed install stays failed for a launch: the turn says so, and the
    // Retry button or the automatic retry tries again.
    const current = settle(entryOf(descriptor.id));
    if (current.state === AGENT_SDK_STATES.ERROR && !current.session && !retryFailed) return Promise.resolve(publicStatus(current));
    const started = startInstall(id, { reason, manual: false });
    if (!started.ok || !started.status) return Promise.resolve(started.status || null);
    if (started.ready) return Promise.resolve(started.status);
    const entry = entryOf(getAgentSdkDescriptor(id).id);
    return new Promise((resolve) => entry.waiters.push(resolve));
  }

  /** Stops a running install; dismisses a failure otherwise. */
  function cancel(id) {
    const descriptor = getAgentSdkDescriptor(id);
    if (!descriptor || !ids.includes(descriptor.id)) return { ok: false, statusCode: 400, error: 'Unknown agent SDK' };
    const entry = entryOf(descriptor.id);
    clearRetry(entry);
    const session = entry.session;
    if (session) {
      if (session.child) terminate(session.child);
      // A failure saved before is dismissed with it.
      persist(entry.id, null);
      fail(entry, session, `${entry.label} install cancelled`, AGENT_SDK_FAILURE_KINDS.CANCELLED);
      return { ok: true, status: publicStatus(entry) };
    }
    if (entry.state === AGENT_SDK_STATES.ERROR) {
      persist(entry.id, null);
      transition(entry, AGENT_SDK_STATES.MISSING, { error: null, kind: null });
    }
    return { ok: true, status: publicStatus(settle(entry)) };
  }

  /**
   * At start, in the background: the leftovers of a crash
   * and folders of earlier pins go, and every SDK in `inUse` whose pinned
   * folder is missing is installed. Never throws.
   */
  async function reconcile({ inUse = [] } = {}) {
    for (const id of ids) {
      try {
        const entry = settle(entryOf(id));
        if (entry.state === AGENT_SDK_STATES.UNSUPPORTED || rootProblem) continue;
        if (fsImpl.existsSync(sdkDir(id))) {
          const lock = tryLock(id);
          if (lock.guard) {
            try {
              await cleanUpLeftovers(id);
              await collectGarbage(id);
            } finally {
              releaseLock(lock);
            }
          }
        }
        if (!inUse.includes(id) || entry.state === AGENT_SDK_STATES.READY || entry.session) continue;
        const last = Date.parse(entry.lastAttemptAt || '') || 0;
        if (entry.state === AGENT_SDK_STATES.ERROR && now() - last < RESTART_QUIET_MS) continue;
        startInstall(id, { reason: 'start-up', manual: false });
      } catch (error) {
        log(`${id}: start-up check failed: ${error?.message || error}`);
      }
    }
  }

  /** A lease on `dir` for `leasePid` (a worker the relay launches). */
  function lease(dir, leasePid = pid) {
    return writeLease(dir, leasePid);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onReady(hook) {
    if (typeof hook !== 'function') return () => {};
    readyHooks.add(hook);
    return () => readyHooks.delete(hook);
  }

  function dispose() {
    disposed = true;
    for (const entry of sdks.values()) {
      clearRetry(entry);
      const session = entry.session;
      if (session) {
        entry.generation += 1;
        entry.session = null;
        if (session.child) terminate(session.child);
      }
      settleWaiters(entry);
    }
    clearLogFlush();
    listeners.clear();
    readyHooks.clear();
  }

  return {
    root,
    getDescriptor: getAgentSdkDescriptor,
    ids: () => [...ids],
    readyDir,
    status,
    snapshot,
    install: (id, options = {}) => startInstall(id, { ...options, manual: true }),
    ensure,
    cancel,
    reconcile,
    lease,
    subscribe,
    onReady,
    dispose,
  };
}
