/**
 * What `oar` needs to know about WSL. A distro in WSL's default (NAT)
 * networking has its own network namespace: a port a Windows program listens
 * on looks free inside the distro, and a Windows browser's `localhost:<port>`
 * then reaches the Windows program, not the relay in the distro. Windows is
 * asked through interop; every failure means "unknown" and is treated like a
 * plain Linux host.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const INTEROP_TIMEOUT_MS = 4000;
// WSL's own localhost forwarders listen on Windows for every port a distro
// listens on, so they stand for the distro's program, not for a Windows one.
const WSL_FORWARDER_RE = /^wsl(relay|host)\.exe$/i;

export function isWsl({ env = process.env, platform = process.platform, readFileImpl = fs.readFileSync } = {}) {
  if (platform !== 'linux') return false;
  if (String(env?.WSL_DISTRO_NAME || env?.WSL_INTEROP || '').trim()) return true;
  try {
    return /microsoft|wsl/i.test(String(readFileImpl('/proc/sys/kernel/osrelease', 'utf8')));
  } catch {
    return false;
  }
}

/** The Windows system folder as the distro sees it: `[automount] root` of /etc/wsl.conf, else /mnt/. */
export function windowsSystemDir({ readFileImpl = fs.readFileSync } = {}) {
  let root = '/mnt/';
  try {
    let section = '';
    for (const raw of String(readFileImpl('/etc/wsl.conf', 'utf8')).split(/\r?\n/)) {
      const line = raw.trim();
      const header = line.match(/^\[(.+)\]$/);
      if (header) section = header[1].trim().toLowerCase();
      const pair = section === 'automount' && line.match(/^root\s*=\s*(.+)$/i);
      if (pair) root = pair[1].trim().replace(/^["']|["']$/g, '') || root;
    }
  } catch {
    // No wsl.conf: the default mount root.
  }
  return path.posix.join(root, 'c', 'Windows', 'System32');
}

function runWindowsTool(name, args, { spawnSyncImpl = spawnSync, readFileImpl = fs.readFileSync } = {}) {
  try {
    const result = spawnSyncImpl(path.posix.join(windowsSystemDir({ readFileImpl }), name), args, {
      encoding: 'utf8',
      timeout: INTEROP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result && !result.error && result.status === 0 ? String(result.stdout || '') : null;
  } catch {
    return null;
  }
}

/**
 * Listening TCP ports in `netstat -ano` output, each with the process ids
 * that hold it. Windows prints the state word in the system language, so a
 * listener is recognised by its shape instead: a TCP row whose remote address
 * is the all-zero one (`0.0.0.0:0` or `[::]:0`). Only listeners a browser's
 * `localhost` reaches count: the loopback and the any-address ones.
 */
export function parseNetstatListeners(text) {
  const listeners = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const row = line.match(/^\s*TCP\s+(\S+):(\d+)\s+(?:0\.0\.0\.0|\[::\]):0\s+.*?(\d+)\s*$/);
    if (!row || !['0.0.0.0', '127.0.0.1', '[::]', '[::1]'].includes(row[1])) continue;
    const port = Number(row[2]);
    const pids = listeners.get(port) || [];
    if (!pids.includes(Number(row[3]))) pids.push(Number(row[3]));
    listeners.set(port, pids);
  }
  return listeners;
}

/** Port → process ids of the Windows listeners, or null when Windows cannot be asked. */
export function windowsListeningPorts(options = {}) {
  const output = runWindowsTool('netstat.exe', ['-ano'], options);
  return output === null ? null : parseNetstatListeners(output);
}

function windowsProcessName(pid, options) {
  const output = runWindowsTool('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], options);
  return output?.match(/^"([^"]+)"/m)?.[1] || '';
}

/**
 * A function `(port) => name | null`: the Windows program that holds the port,
 * or null when none does, when this is not WSL, or when Windows cannot be
 * asked. The listener list is read once, on the first call.
 */
export function createWindowsPortCheck(options = {}) {
  if (!isWsl(options)) return () => null;
  let listeners;
  return (port) => {
    if (listeners === undefined) listeners = windowsListeningPorts(options);
    for (const pid of listeners?.get(Number(port)) || []) {
      const name = windowsProcessName(pid, options);
      if (!WSL_FORWARDER_RE.test(name)) return name || 'a Windows program';
    }
    return null;
  };
}

/**
 * True in a WSL distro whose network is its own (NAT): its LAN address is
 * internal to WSL. Mirrored networking shares the addresses of Windows.
 */
export function isWslNat(options = {}) {
  if (!isWsl(options)) return false;
  try {
    const result = (options.spawnSyncImpl || spawnSync)('wslinfo', ['--networking-mode'], {
      encoding: 'utf8',
      timeout: INTEROP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(result?.stdout || '').trim().toLowerCase() !== 'mirrored';
  } catch {
    return true;
  }
}

export function windowsPortWarning(port, holder) {
  return `Windows holds port ${port} (${holder}): a browser on Windows reaches that program, not this relay. Pick another port: oar setup --port N`;
}
