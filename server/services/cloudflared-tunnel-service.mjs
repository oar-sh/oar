'use strict';

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const BACKOFF_STEPS = [5_000, 10_000, 20_000, 40_000, 60_000];
const READINESS_WINDOW_MS = 5_000;
const STABLE_CONNECTION_MS = 30_000;
const FAST_EXIT_MS = 10_000;
const MAX_CONSECUTIVE_FAST_EXITS = 3;
const BINARY_RECHECK_MS = 60_000;
// What Windows starts without a shell. A `.cmd`/`.bat` launcher would need
// cmd.exe, and the tunnel token does not go through a shell command line.
const WINDOWS_DIRECT_EXTENSIONS = ['.exe', '.com'];

function toText(value) {
  return String(value || '').trim();
}

function normalizeTunnelMode(raw = {}) {
  const mode = toText(raw.mode).toLowerCase();
  if (mode === 'disabled' || mode === 'managed') return mode;
  if (raw.enabled === true) return 'managed';
  return 'disabled';
}

function normalizeExtraArgs(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  return rawValue.map((entry) => toText(entry)).filter(Boolean);
}

function hasDirectoryPart(value) {
  return value.includes('/') || value.includes('\\');
}

/**
 * Where the cloudflared the tunnel would run really is, or null. OAR ships no
 * copy: a name is looked up on PATH (on Windows with the `.exe`/`.com`
 * suffixes PATHEXT lists), a path must be an executable file.
 */
export function locateCloudflaredBinary(binary, {
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
  pathImpl = platform === 'win32' ? path.win32 : path.posix,
} = {}) {
  const name = toText(binary);
  if (!name) return null;

  let names = [name];
  if (platform === 'win32' && !WINDOWS_DIRECT_EXTENSIONS.includes(pathImpl.extname(name).toLowerCase())) {
    const listed = String(env?.PATHEXT || '')
      .split(';')
      .map((ext) => toText(ext).toLowerCase())
      .filter((ext) => WINDOWS_DIRECT_EXTENSIONS.includes(ext));
    names = (listed.length ? listed : WINDOWS_DIRECT_EXTENSIONS).map((ext) => `${name}${ext}`);
  }

  const isExecutableFile = (candidate) => {
    try {
      if (!fsImpl.statSync(candidate).isFile()) return false;
      // Windows has no execute bit; the suffix above decided.
      if (platform !== 'win32') fsImpl.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const dirs = hasDirectoryPart(name)
    ? [null]
    : String(env?.PATH ?? env?.Path ?? '').split(pathImpl.delimiter).map(toText).filter(Boolean);
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = dir === null ? candidate : pathImpl.join(dir, candidate);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

export function cloudflaredInstallPointer(platform = process.platform) {
  if (platform === 'win32') return 'install it with: winget install --id Cloudflare.cloudflared';
  if (platform === 'darwin') return 'install it with: brew install cloudflared';
  return "install it from Cloudflare's package repository: https://pkg.cloudflare.com/";
}

/** The one sentence the tunnel state, the status dot and the CLI show. */
export function describeMissingCloudflaredBinary({ binary = '', binarySource = 'path', platform = process.platform } = {}) {
  const pointer = cloudflaredInstallPointer(platform);
  if (binarySource === 'config') {
    return `cloudflared was not found as configured (${binary}) — correct cloudflaredTunnel.binary, or ${pointer}`;
  }
  return `cloudflared is not installed — ${pointer}`;
}

/**
 * The tunnel in one line for a CLI status row. Takes the manager's state or
 * the `cloudflaredTunnel` object of `/api/status`; the public address is the
 * caller's to pass, the relay does not know it (the route lives in Cloudflare).
 */
export function describeTunnelState(state, { url = '' } = {}) {
  const tunnel = state && typeof state === 'object' ? state : {};
  const managed = toText(tunnel.mode).toLowerCase() === 'managed' || tunnel.enabled === true;
  if (!managed) return 'off';
  const reason = toText(tunnel.lastError);
  if (tunnel.connected === true) {
    const address = toText(url);
    return address ? `running (${address})` : 'running';
  }
  if (tunnel.binaryMissing === true || tunnel.valid === false) return reason ? `off: ${reason}` : 'off';
  return reason ? `not connected (${reason})` : 'not connected';
}

export function normalizeCloudflaredTunnelConfig(rawConfig = {}, {
  env = process.env,
  configBaseDir = process.cwd(),
  pathImpl = path,
} = {}) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const envMode = toText(env?.COPILOT_CLOUDFLARED_MODE).toLowerCase();
  const mode = envMode === 'disabled' || envMode === 'managed'
    ? envMode
    : normalizeTunnelMode(raw);
  const required = raw.required === true;
  const token = toText(env?.COPILOT_CLOUDFLARED_TOKEN) || toText(raw.token);
  const binaryInput = toText(env?.COPILOT_CLOUDFLARED_BINARY) || toText(raw.binary);
  const extraArgs = normalizeExtraArgs(raw.extraArgs);

  // The configured binary, else `cloudflared` from PATH. Whether it is really
  // there is checked when the tunnel starts (locateCloudflaredBinary).
  let binary = 'cloudflared';
  let binarySource = 'path';
  if (binaryInput) {
    binary = hasDirectoryPart(binaryInput)
      ? pathImpl.resolve(configBaseDir, binaryInput)
      : binaryInput;
    binarySource = 'config';
  }

  const errors = [];
  if (mode === 'managed') {
    if (!token) errors.push('cloudflaredTunnel.token is required when cloudflaredTunnel.mode is "managed"');
  }

  return {
    mode,
    enabled: mode === 'managed',
    valid: errors.length === 0,
    errors,
    required,
    token,
    binary,
    binarySource,
    extraArgs,
  };
}

/**
 * The tunnel as `oar doctor` reports it, from the config alone (no relay
 * needed): whether the built-in tunnel is on and whether it could start.
 */
export function describeConfiguredTunnel(rawConfig = {}, {
  env = process.env,
  platform = process.platform,
  configBaseDir = process.cwd(),
  pathImpl = path,
  locateBinary = locateCloudflaredBinary,
} = {}) {
  const tunnelConfig = normalizeCloudflaredTunnelConfig(rawConfig, { env, configBaseDir, pathImpl });
  if (tunnelConfig.mode !== 'managed') return 'disabled';
  if (!tunnelConfig.valid) return `managed, cannot start: ${tunnelConfig.errors[0]}`;
  const located = locateBinary(tunnelConfig.binary, { platform, env });
  if (!located) {
    const { binary, binarySource } = tunnelConfig;
    return `managed, cannot start: ${describeMissingCloudflaredBinary({ binary, binarySource, platform })}`;
  }
  return `managed (cloudflared: ${located})`;
}

export function buildCloudflaredArgs(tunnelConfig) {
  return ['tunnel', 'run', '--token', tunnelConfig.token, ...tunnelConfig.extraArgs];
}

export function redactCloudflaredArgs(args = []) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--token') {
      out.push('--token', '<redacted>');
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function buildSpawnOptions(platform, stdio) {
  if (platform === 'win32') return { stdio, windowsHide: true };
  return { stdio };
}

function isRegistrationLine(text) {
  return /registered tunnel connection|connection .* registered|registered connection/i.test(text);
}

export function createCloudflaredTunnelManager({
  tunnelConfig: rawTunnelConfig = {},
  runtimeLogPrefix = () => '',
  io = null,
  logger = console,
  runtimeShutdownRef = () => false,
  platform = process.platform,
  spawnImpl = spawn,
  nowIso = () => new Date().toISOString(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  configBaseDir = process.cwd(),
  env = process.env,
  locateBinary = locateCloudflaredBinary,
  pathImpl = path,
} = {}) {
  const tunnelConfig = normalizeCloudflaredTunnelConfig(rawTunnelConfig, {
    env,
    configBaseDir,
    pathImpl,
  });
  const log = (msg) => logger.log(`${runtimeLogPrefix()}[cloudflared-tunnel] ${msg}`);
  const warn = (msg) => logger.warn(`${runtimeLogPrefix()}[cloudflared-tunnel] ${msg}`);

  for (const error of tunnelConfig.errors) {
    warn(error);
  }

  const state = {
    mode: tunnelConfig.mode,
    enabled: tunnelConfig.enabled && tunnelConfig.valid,
    valid: tunnelConfig.valid,
    required: tunnelConfig.required,
    connected: false,
    reconnectAttempts: 0,
    fastExits: 0,
    connectedSince: null,
    blocking: tunnelConfig.required && tunnelConfig.mode === 'managed',
    lastError: tunnelConfig.errors[0] || null,
    lastEventAt: nowIso(),
    binary: tunnelConfig.binary || null,
    binaryMissing: false,
    proc: null,
    backoffTimer: null,
  };

  const emitStatus = () => {
    state.lastEventAt = nowIso();
    io?.emit?.('cloudflared_tunnel_status', {
      connected: state.connected,
      mode: state.mode,
      enabled: state.enabled,
      required: state.required,
      blocking: state.blocking,
      reconnectAttempts: state.reconnectAttempts,
      connectedSince: state.connectedSince,
      lastError: state.lastError,
      binaryMissing: state.binaryMissing,
    });
  };

  const updateBlockingState = () => {
    state.blocking = state.required && state.mode === 'managed' && !state.connected;
  };

  const scheduleReconnect = (spawnTunnel, { slowest = false } = {}) => {
    if (runtimeShutdownRef()) return;
    if (state.backoffTimer) {
      clearTimeoutImpl(state.backoffTimer);
      state.backoffTimer = null;
    }
    const stepIndex = slowest
      ? BACKOFF_STEPS.length - 1
      : Math.min(state.reconnectAttempts, BACKOFF_STEPS.length - 1);
    const base = BACKOFF_STEPS[stepIndex];
    const delay = Math.round(base + (Math.random() * base * 0.2));
    state.reconnectAttempts += 1;
    log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${state.reconnectAttempts})...`);
    state.backoffTimer = setTimeoutImpl(spawnTunnel, delay);
    if (typeof state.backoffTimer?.unref === 'function') state.backoffTimer.unref();
  };

  const spawnTunnel = () => {
    if (!state.enabled || runtimeShutdownRef()) return;
    if (state.proc && state.proc.exitCode === null) {
      log('Spawn skipped: existing cloudflared process is still running.');
      return;
    }

    // OAR ships no cloudflared. Without one the tunnel stays off, the state
    // says how to install it, and a look every minute starts the tunnel once
    // it is there (no relay restart, as long as it lands on the relay's PATH).
    let located = null;
    try { located = toText(locateBinary(tunnelConfig.binary, { platform, env })); } catch {}
    if (!located) {
      if (!state.binaryMissing) {
        state.binaryMissing = true;
        state.lastError = describeMissingCloudflaredBinary({
          binary: tunnelConfig.binary,
          binarySource: tunnelConfig.binarySource,
          platform,
        });
        warn(`Tunnel not started: ${state.lastError}`);
        updateBlockingState();
        emitStatus();
      }
      if (state.backoffTimer) clearTimeoutImpl(state.backoffTimer);
      state.backoffTimer = setTimeoutImpl(spawnTunnel, BINARY_RECHECK_MS);
      if (typeof state.backoffTimer?.unref === 'function') state.backoffTimer.unref();
      return;
    }
    state.binaryMissing = false;

    const args = buildCloudflaredArgs(tunnelConfig);
    log(`Spawning: ${located} ${redactCloudflaredArgs(args).join(' ')}`);
    const proc = spawnImpl(located, args, buildSpawnOptions(platform, ['ignore', 'pipe', 'pipe']));
    state.proc = proc;
    state.lastError = null;
    updateBlockingState();
    emitStatus();

    const startedAt = Date.now();
    let readinessTimer = null;

    const clearReadinessTimer = () => {
      if (!readinessTimer) return;
      clearTimeoutImpl(readinessTimer);
      readinessTimer = null;
    };

    const markConnected = (reason) => {
      if (state.connected) return;
      state.connected = true;
      state.connectedSince = nowIso();
      state.lastError = null;
      state.fastExits = 0;
      updateBlockingState();
      log(`Tunnel connected (${reason}).`);
      emitStatus();
    };

    const armReadinessFallback = () => {
      clearReadinessTimer();
      readinessTimer = setTimeoutImpl(() => {
        readinessTimer = null;
        if (runtimeShutdownRef()) return;
        if (state.proc !== proc) return;
        if (proc.exitCode !== null) return;
        markConnected('readiness-window');
      }, READINESS_WINDOW_MS);
      if (typeof readinessTimer?.unref === 'function') readinessTimer.unref();
    };

    const handleOutput = (text) => {
      if (!text) return;
      log(`stderr: ${text}`);
      if (isRegistrationLine(text)) {
        clearReadinessTimer();
        markConnected('registration');
      }
    };

    proc.stdout?.on?.('data', (d) => handleOutput(d.toString().trim()));
    proc.stderr?.on?.('data', (d) => handleOutput(d.toString().trim()));
    proc.on('spawn', armReadinessFallback);
    proc.on('error', (error) => {
      clearReadinessTimer();
      state.lastError = error?.message || String(error);
      updateBlockingState();
      log(`Error: ${state.lastError}`);
      emitStatus();
    });
    proc.on('close', (code) => {
      clearReadinessTimer();
      const wasConnected = state.connected;
      const uptime = Date.now() - startedAt;
      state.connected = false;
      state.connectedSince = null;
      state.proc = null;
      if (wasConnected && uptime > STABLE_CONNECTION_MS) {
        state.reconnectAttempts = 0;
      }
      updateBlockingState();

      if (runtimeShutdownRef()) {
        log(`Process exited (code=${code}) during shutdown.`);
        emitStatus();
        return;
      }

      if (uptime < FAST_EXIT_MS) {
        state.fastExits += 1;
      } else {
        state.fastExits = 0;
      }

      if (state.fastExits >= MAX_CONSECUTIVE_FAST_EXITS) {
        state.lastError = 'auth-or-config';
        log(`Process exited (code=${code}) after ${state.fastExits} fast exits; treating as auth/config failure.`);
        emitStatus();
        scheduleReconnect(spawnTunnel, { slowest: true });
        return;
      }

      state.lastError = `exit:${code ?? 'null'}`;
      log(`Process exited (code=${code}). Scheduling reconnect...`);
      emitStatus();
      scheduleReconnect(spawnTunnel);
    });
  };

  const start = () => {
    if (state.mode === 'disabled') {
      state.lastError = null;
      state.blocking = false;
      emitStatus();
      log('Cloudflare tunnel mode disabled.');
      return;
    }
    if (!state.enabled) {
      state.lastError = state.lastError || 'invalid-config';
      updateBlockingState();
      emitStatus();
      log('Managed cloudflared mode requested but configuration is invalid; tunnel not started.');
      return;
    }
    log(`Cloudflare tunnel enabled (binary source: ${tunnelConfig.binarySource}).`);
    spawnTunnel();
  };

  const stop = () => {
    if (state.backoffTimer) {
      clearTimeoutImpl(state.backoffTimer);
      state.backoffTimer = null;
    }
    if (state.proc) {
      try { state.proc.kill('SIGTERM'); } catch {}
      state.proc = null;
    }
  };

  return {
    state,
    config: tunnelConfig,
    start,
    stop,
    emitStatus,
  };
}
