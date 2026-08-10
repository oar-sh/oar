'use strict';

import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { spawn } from 'child_process';

const requireFromHere = createRequire(import.meta.url);

const BACKOFF_STEPS = [5_000, 10_000, 20_000, 40_000, 60_000];
const READINESS_WINDOW_MS = 5_000;
const STABLE_CONNECTION_MS = 30_000;
const FAST_EXIT_MS = 10_000;
const MAX_CONSECUTIVE_FAST_EXITS = 3;

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

// The npm `cloudflared` package downloads the official binary on demand; it is an
// optional dependency, so absence must degrade to a config error, never a crash.
export function resolveCloudflaredBinaryFromPackage({ existsSync = fs.existsSync } = {}) {
  try {
    const mod = requireFromHere('cloudflared');
    const bin = toText(mod?.bin);
    // `bin` is where the package *will* place the binary; it only exists after
    // the on-demand download has run, so an un-downloaded path is not usable.
    if (bin && existsSync(bin)) return bin;
  } catch {}
  return null;
}

export function normalizeCloudflaredTunnelConfig(rawConfig = {}, {
  env = process.env,
  resolveBinary = resolveCloudflaredBinaryFromPackage,
  configBaseDir = process.cwd(),
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

  let binary = '';
  let binarySource = null;
  if (binaryInput) {
    binary = binaryInput.includes('/') || binaryInput.includes('\\')
      ? path.resolve(configBaseDir, binaryInput)
      : binaryInput;
    binarySource = 'config';
  } else {
    let packageBinary = null;
    try {
      packageBinary = toText(typeof resolveBinary === 'function' ? resolveBinary() : '');
    } catch {
      packageBinary = null;
    }
    if (packageBinary) {
      binary = packageBinary;
      binarySource = 'package';
    } else {
      binary = 'cloudflared';
      binarySource = 'path';
    }
  }

  const errors = [];
  if (mode === 'managed') {
    if (!token) errors.push('cloudflaredTunnel.token is required when cloudflaredTunnel.mode is "managed"');
    if (!binary) errors.push('cloudflaredTunnel.binary could not be resolved (install the "cloudflared" package or set cloudflaredTunnel.binary)');
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
  resolveBinary = resolveCloudflaredBinaryFromPackage,
} = {}) {
  const tunnelConfig = normalizeCloudflaredTunnelConfig(rawTunnelConfig, {
    env,
    resolveBinary,
    configBaseDir,
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

    const args = buildCloudflaredArgs(tunnelConfig);
    log(`Spawning: ${tunnelConfig.binary} ${redactCloudflaredArgs(args).join(' ')}`);
    const proc = spawnImpl(tunnelConfig.binary, args, buildSpawnOptions(platform, ['ignore', 'pipe', 'pipe']));
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
