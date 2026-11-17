'use strict';

/**
 * Reading a conversation's worker log for the worker log view and the
 * agent's own read of it. Every worker kind writes its stdout and stderr to
 * `<log dir>/worker-<sdk session id>.log` (session-worker-launch-service.mjs);
 * no table stores the path, so it is derived the way the launch derives it,
 * from the same launch environment.
 *
 * The reads are the task console's (task-output-service.mjs): byte windows
 * cut on line boundaries, at most 256 KB, path-guarded (a regular file, no
 * symlink), control codes out, colours kept and credentials scrubbed per
 * window (scrubTaskOutput). Nothing here writes, rotates or makes a folder.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveWorkerLogDir, workerLogPathFor } from './session-worker-launch-service.mjs';
import { inspectOutputFile, readBefore, readTail } from './task-output-service.mjs';
import { createTaskOutputRooms } from './task-output-rooms.mjs';

/**
 * Where a conversation's worker log is: `{ dir, path, sdkSessionId }`. A
 * conversation whose worker has not reported a session yet is launched
 * under its own id, so that names the file then. `path` is '' for an id that
 * cleans to nothing (those share one file no conversation owns).
 */
export function resolveWorkerLog(conversation, launchEnv = {}, { pathImpl = path } = {}) {
  const sdkSessionId = String(conversation?.sdk_session_id || conversation?.id || '').trim();
  const dir = resolveWorkerLogDir(launchEnv, { pathImpl });
  const logPath = sdkSessionId ? workerLogPathFor(sdkSessionId, launchEnv, { pathImpl }) : null;
  return { dir, path: logPath || '', sdkSessionId };
}

/** The earlier files of a log, by name and size: the `.1` a relaunch rolled over, when it is there. */
export async function previousWorkerLogs(logPath, { fsImpl = fs, pathImpl = path } = {}) {
  if (!logPath) return [];
  const rolled = `${logPath}.1`;
  const info = await inspectOutputFile(rolled, { fsImpl });
  return info.ok ? [{ name: pathImpl.basename(rolled), size: info.size }] : [];
}

// How long the log must be quiet before an unterminated last line is shown.
export const WORKER_LOG_IDLE_FLUSH_MS = 5000;

export const WORKER_LOG_EVENTS = Object.freeze({
  watch: 'worker_log_watch',
  unwatch: 'worker_log_unwatch',
  chunk: 'worker_log_chunk',
});

/**
 * The live tail: the task console's rooms (task-output-rooms.mjs), one room
 * per conversation (`worker-log:<id>`), with their own events and
 * `socket.data` key, so a page may watch a task and the worker log at once.
 * Sockets are the person's alone (agent and peer credentials are refused at
 * the handshake). A conversation without an SDK session is refused with
 * `no-session`; a log file not there yet is waited for from offset 0.
 */
export function createWorkerLogRooms({ io, getConversation, getLaunchEnv = () => process.env, ...options } = {}) {
  return createTaskOutputRooms({
    io,
    roomPrefix: 'worker-log:',
    events: WORKER_LOG_EVENTS,
    dataKey: 'workerLogRoom',
    itemKey: null,
    logLabel: 'worker-log',
    // An open line goes out after 5 s of quiet, and again whole when done;
    // long lines are cut between words; a new SDK session's file is followed.
    idleFlushMs: WORKER_LOG_IDLE_FLUSH_MS,
    followPath: true,
    resolveSource: (conversationId) => {
      const conversation = getConversation?.(conversationId) || null;
      if (!conversation) return null;
      const { path: logPath } = resolveWorkerLog(conversation, getLaunchEnv() || {});
      return { path: logPath, ended: false, code: logPath ? undefined : 'no-session' };
    },
    ...options,
  });
}

/**
 * The last `lines` lines of the log (default 2,000), within 256 KB; readTail's
 * answer. An unterminated last line written in the last 5 s stays out, as the
 * live room holds it: its writer may be in the middle of a value.
 */
export function readWorkerLogTail(logPath, { lines, now = Date.now, fsImpl = fs } = {}) {
  return readTail(logPath, { lines, holdOpenLineMs: WORKER_LOG_IDLE_FLUSH_MS, now, fsImpl });
}

/** The lines that end at byte `before` (an earlier answer's startOffset); readBefore's answer. */
export function readWorkerLogBefore(logPath, { before, lines, fsImpl = fs } = {}) {
  return readBefore(logPath, { before, lines, fsImpl });
}
