// What a Claude Code session leaves in its config directory besides the
// transcript, removed when the relay deletes the conversation.
//
// Only for a config directory the relay owns (DeepSeek's `deepseek-claude`
// in the data folder), never the host's ~/.claude: the user's own CLI keeps
// its sessions there. The relay stops the worker before it deletes anything,
// and a stopped CLI is killed without its exit cleanup, so it leaves (the
// bundled CLI, checked 2026-10-25):
// - `session-env/<session id>/`, the session's hook environment files;
// - `sessions/<pid>.json`, the process's registration (`{ pid, sessionId,
//   cwd, startedAt, ... }`), and `sessions/<pid>.<sha256>.key`, its
//   messaging key;
// - `shell-snapshots/snapshot-<shell>-<ms>-<random>.sh`, the shell snapshot
//   the process took at its start, whose name carries no session id: it is
//   matched by the time in its name against the session's CLI starts;
// - `projects/<slug(cwd)>/` with an empty `memory/`, once its last session
//   is gone.
// What belongs to another session stays: a registration of a live process,
// a snapshot that also lies in the start window of another session's CLI,
// and a project folder that still holds anything but an empty `memory/`.
//
// A CLI that exits on its own removes its registration but not always its
// snapshot: the registration goes in a synchronous `exit` handler, the
// snapshot only in the CLI's asynchronous cleanup, which a stop does not
// wait for (a worker restart left the first CLI's snapshot behind with no
// registration to match it). So the relay records every CLI start of a
// session itself (recordClaudeCliStart, from the worker's report at the
// CLI's first init) in `oar-cli-starts.json` in the config dir, and the
// delete matches snapshots against those starts as well as against the
// registrations. Every recorded start of another session protects its
// window, as a registration does.

import nodeFs from 'node:fs';
import nodePath from 'node:path';

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REGISTRATION_PATTERN = /^(\d{1,10})\.json$/;
const SNAPSHOT_PATTERN = /^snapshot-[a-z]+-(\d{10,16})-[A-Za-z0-9]+(?:-[A-Za-z0-9-]+)?\.sh$/;
// The snapshot is taken while the CLI starts, around its registration.
const SNAPSHOT_WINDOW_BEFORE_MS = 60_000;
const SNAPSHOT_WINDOW_AFTER_MS = 120_000;
const MAX_ENTRIES = 2_000;
// The relay's record of CLI starts: one file, keyed by session id inside it.
const CLI_STARTS_FILE = 'oar-cli-starts.json';
const MAX_STARTS_PER_SESSION = 200;
const MAX_SESSIONS_RECORDED = 5_000;

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readDir(fs, dir) {
  try {
    return fs.readdirSync(dir).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function remove(fs, target, removed) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  } catch {}
}

/** The registrations in `sessions/`: `{ pid, sessionId, startedAt, file }`. */
function readRegistrations(fs, path, sessionsDir) {
  const registrations = [];
  for (const name of readDir(fs, sessionsDir)) {
    const match = REGISTRATION_PATTERN.exec(name);
    if (!match) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(sessionsDir, name), 'utf8'));
    } catch {
      continue;
    }
    const startedAt = Number(parsed?.startedAt);
    registrations.push({
      pid: Number(match[1]),
      sessionId: String(parsed?.sessionId ?? ''),
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
      file: name,
    });
  }
  return registrations;
}

/** `{ [sessionId]: [startedAt ms, ...] }` from the relay's record, or `{}`. */
function readCliStarts(fs, file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sessions = parsed?.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {};
    const starts = {};
    for (const [id, list] of Object.entries(sessions)) {
      if (!SESSION_ID_PATTERN.test(id) || !Array.isArray(list)) continue;
      starts[id] = list.map(Number).filter(Number.isFinite);
    }
    return starts;
  } catch {
    return {};
  }
}

function writeCliStarts(fs, file, starts) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions: starts }), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Note that a CLI started for `nativeSessionId` at `startedAt` (ms), under
 * the relay's own config dir. Best-effort; returns whether it was noted.
 */
export function recordClaudeCliStart({ configRoot, nativeSessionId, startedAt, fs = nodeFs, path = nodePath } = {}) {
  const root = String(configRoot || '').trim();
  const sessionId = String(nativeSessionId || '').trim();
  const at = Number(startedAt);
  if (!root || !SESSION_ID_PATTERN.test(sessionId) || !Number.isFinite(at) || at <= 0) return false;
  try {
    const resolvedRoot = path.resolve(root);
    fs.mkdirSync(resolvedRoot, { recursive: true });
    const file = path.join(resolvedRoot, CLI_STARTS_FILE);
    const starts = readCliStarts(fs, file);
    const list = starts[sessionId] || [];
    if (!list.includes(at)) list.push(at);
    starts[sessionId] = list.slice(-MAX_STARTS_PER_SESSION);
    // A record that outgrows its cap drops the sessions started longest ago.
    const ids = Object.keys(starts);
    if (ids.length > MAX_SESSIONS_RECORDED) {
      const newest = (id) => Math.max(...starts[id], 0);
      for (const id of ids.sort((a, b) => newest(a) - newest(b)).slice(0, ids.length - MAX_SESSIONS_RECORDED)) delete starts[id];
    }
    writeCliStarts(fs, file, starts);
    return true;
  } catch {
    return false;
  }
}

function inStartWindow(time, startedAt) {
  return startedAt !== null && time >= startedAt - SNAPSHOT_WINDOW_BEFORE_MS && time <= startedAt + SNAPSHOT_WINDOW_AFTER_MS;
}

/**
 * Remove what the session `nativeSessionId` left under `configRoot`, and
 * `projectDirPath` when nothing but an empty `memory/` is left in it.
 * Returns the paths removed. Best-effort: a path that will not go stays.
 */
export function removeClaudeSessionLeftovers({
  configRoot,
  nativeSessionId,
  projectDirPath = '',
  fs = nodeFs,
  path = nodePath,
  isPidAlive = defaultIsPidAlive,
} = {}) {
  const removed = [];
  const root = String(configRoot || '').trim();
  const sessionId = String(nativeSessionId || '').trim();
  if (!root || !SESSION_ID_PATTERN.test(sessionId)) return removed;
  const resolvedRoot = path.resolve(root);

  const sessionEnv = path.join(resolvedRoot, 'session-env', sessionId);
  if (fs.existsSync(sessionEnv)) remove(fs, sessionEnv, removed);

  const sessionsDir = path.join(resolvedRoot, 'sessions');
  const registrations = readRegistrations(fs, path, sessionsDir);
  const stale = registrations.filter((entry) => entry.sessionId === sessionId && !isPidAlive(entry.pid));
  const others = registrations.filter((entry) => !stale.includes(entry));
  const files = readDir(fs, sessionsDir);
  for (const entry of stale) {
    remove(fs, path.join(sessionsDir, entry.file), removed);
    const keyPrefix = `${entry.pid}.`;
    for (const name of files) {
      if (name.startsWith(keyPrefix) && name.endsWith('.key')) remove(fs, path.join(sessionsDir, name), removed);
    }
  }

  // The session's CLI starts: its dead registrations and every start the
  // relay recorded. Another session's: its registrations and its recorded
  // starts, whose windows are never touched.
  const startsFile = path.join(resolvedRoot, CLI_STARTS_FILE);
  const recorded = readCliStarts(fs, startsFile);
  const ownStarts = [...stale.map((entry) => entry.startedAt), ...(recorded[sessionId] || [])];
  const otherStarts = [
    ...others.map((entry) => entry.startedAt),
    ...Object.entries(recorded).filter(([id]) => id !== sessionId).flatMap(([, list]) => list),
  ];
  const snapshotsDir = path.join(resolvedRoot, 'shell-snapshots');
  for (const name of readDir(fs, snapshotsDir)) {
    const match = SNAPSHOT_PATTERN.exec(name);
    if (!match) continue;
    const takenAt = Number(match[1]);
    if (!ownStarts.some((startedAt) => inStartWindow(takenAt, startedAt))) continue;
    if (otherStarts.some((startedAt) => inStartWindow(takenAt, startedAt))) continue;
    remove(fs, path.join(snapshotsDir, name), removed);
  }
  if (recorded[sessionId]) {
    delete recorded[sessionId];
    try {
      writeCliStarts(fs, startsFile, recorded);
    } catch {}
  }

  const projectDir = String(projectDirPath || '').trim() ? path.resolve(projectDirPath) : '';
  if (projectDir && path.dirname(projectDir) === path.join(resolvedRoot, 'projects')) {
    const entries = readDir(fs, projectDir);
    const isEmptyDir = (dir) => {
      try {
        return fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
      } catch {
        return false;
      }
    };
    const onlyEmptyMemory = entries.every((name) => name === 'memory' && isEmptyDir(path.join(projectDir, name)));
    if (fs.existsSync(projectDir) && onlyEmptyMemory) remove(fs, projectDir, removed);
  }
  return removed;
}
