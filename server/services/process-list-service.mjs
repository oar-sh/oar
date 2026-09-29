'use strict';

// The process table, read the way each platform allows, for the tree watch in
// shared/worker-runtime/process-tree.mjs. Every entry carries the time the
// process was started: that is what tells it from a later process that was
// given its pid.
//
//  - Linux reads `/proc/<pid>/stat`, which needs no process and takes about
//    3 ms for 160 processes (measured 2026-09-29). The start time is field 22,
//    in clock ticks since boot.
//  - Windows asks PowerShell, through the list the relay's process inspector
//    already reads. It takes about a second, so it is never polled.
//  - Every other platform asks `ps`, whose start time has a resolution of one
//    second.

import fs from 'fs';
import { execFile } from 'child_process';

import { createSessionWorkerProcessInspector } from './session-worker-process-service.mjs';

const PS_TIMEOUT_MS = 10_000;

/**
 * One `/proc/<pid>/stat`. The name (field 2) is in parentheses and may hold
 * spaces and parentheses of its own, so the fields after it are counted from
 * the LAST closing one. A process that has ended and only waits to be
 * collected (`Z`, `X`) is not running any more.
 */
export function parseProcStat(text) {
  const raw = String(text || '');
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 1 || close < open) return null;
  const processId = Number.parseInt(raw.slice(0, open), 10);
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  const state = fields[0] || '';
  const createdAt = Number(fields[19]);
  if (!(processId > 0) || state === 'Z' || state === 'X' || !(createdAt > 0)) return null;
  return {
    processId,
    parentProcessId: Number.parseInt(fields[1], 10) || 0,
    name: raw.slice(open + 1, close),
    createdAt,
    // The runtime starts a command in a session of its own.
    sessionLeader: Number.parseInt(fields[3], 10) === processId,
  };
}

/** One line of `ps -o pid=,ppid=,stat=,lstart=,args=`. */
export function parsePsLine(line) {
  const match = String(line || '').match(
    /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*(.*)$/,
  );
  if (!match) return null;
  const createdAt = Date.parse(match[4]);
  if (/^[ZX]/.test(match[3]) || !(createdAt > 0)) return null;
  return {
    processId: Number.parseInt(match[1], 10),
    parentProcessId: Number.parseInt(match[2], 10) || 0,
    createdAt,
    commandLine: match[5],
  };
}

export function createProcessLister({
  platform = process.platform,
  readdirSyncImpl = fs.readdirSync,
  readFileSyncImpl = fs.readFileSync,
  execFileImpl = execFile,
  inspector = null,
} = {}) {
  if (platform === 'win32') {
    const windows = inspector || createSessionWorkerProcessInspector({ platform, execFileImpl });
    return {
      // A child keeps the pid of its parent after the parent has ended.
      orphansKeepParent: true,
      list: () => windows.readWindowsProcessSnapshot(),
    };
  }

  if (platform === 'linux') {
    const read = (pid) => {
      try {
        return parseProcStat(readFileSyncImpl(`/proc/${pid}/stat`, 'utf8'));
      } catch {
        // It ended between the directory listing and the read.
        return null;
      }
    };
    return {
      orphansKeepParent: false,
      list: () => readdirSyncImpl('/proc')
        .filter((name) => /^\d+$/.test(String(name)))
        .map((name) => read(name))
        .filter(Boolean),
      read,
      describe(pid) {
        try {
          return String(readFileSyncImpl(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
        } catch {
          return '';
        }
      },
    };
  }

  return {
    orphansKeepParent: false,
    list: () => new Promise((resolve, reject) => {
      execFileImpl(
        'ps',
        ['-axww', '-o', 'pid=,ppid=,stat=,lstart=,args='],
        // `lstart` is parsed as a date: keep it in the one language that is.
        { timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(String(stdout || '').split(/\r?\n/).map(parsePsLine).filter(Boolean));
        },
      );
    }),
  };
}
