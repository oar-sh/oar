/**
 * The relay's own database backups. At start, when the version
 * (on a checkout: the commit) differs from the one that last ran on the
 * database, a copy is written before the new version's migrations
 * (maybeBackupBeforeStart); `oar backup` writes one on demand. The same
 * folder, name, manifest and rotation for both.
 *
 * A backup is one file, `oar-<version>-<YYYYMMDD-HHMMSS UTC>-<reason>.db`
 * (the version of the data: the one to go back to; a first start that cannot
 * tell names the running one, reason `pre-update-from-unknown`), written as
 * `.partial` in the backup folder itself (created 0600 before the copy),
 * checked (quick_check), turned into a single file (journal_mode=DELETE),
 * synced and linked into place under a free name. The last N are kept; the
 * relay deletes only files it wrote itself: recorded in the manifest of its
 * own data folder (`db-backups.json`) and named by the pattern, in that
 * folder, with the size it had. Nothing else in the folder is ever counted,
 * rotated or deleted. A skip (disk, a DO_NOT_TOUCH folder, another backup
 * running) or a failure never stops a start and never pushes out a good backup.
 */
import fs from 'fs';
import path from 'path';

import { diskBytes, freeBytes } from '../relay-heap-guard.mjs';
import { RETRY_CODES, oneLine, renameWithRetry, sleepSync } from './database-file.mjs';
import { defaultIsProcessAlive, lockHolderMayRun, processIdentity } from './relay-singleton-guard.mjs';

export const BACKUP_MANIFEST_FILE = 'db-backups.json';
// While a backup is written, with the writer's pid: `oar start` tells a relay
// busy with it from one that did not come up, and `oar backup` waits its turn.
export const BACKUP_PROGRESS_FILE = 'db-backup-progress.json';
// While a start waits for an `oar backup` of the same database, with the
// relay's pid: `oar start` leaves a relay that does so running.
export const BACKUP_WAIT_FILE = 'db-backup-wait.json';
// app_settings: { version, commit, at } of the version that last ran.
export const DB_LAST_RUN_SETTING_KEY = 'db_last_run';
export const DEFAULT_BACKUP_KEEP = 2;
// The in-app update's record (update-install-service.mjs), read before
// reconcileUpdateAttempt removes it at boot.
const UPDATE_ATTEMPT_SETTING_KEY = 'update_attempt';
const UPDATE_ATTEMPT_MAX_AGE_MS = 7 * 24 * 3_600_000;
const GIB = 1024 ** 3;
// A version that can go into a file name: a release, maybe a pre-release
// and build metadata.
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const BACKUP_NAME_RE = /^oar-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+?)?(?:\+[0-9A-Za-z.-]+?)?)-(\d{8}-\d{6})(?:-([a-z0-9-]+))?\.db$/;
// One step for all pages: a step-by-step online backup starts over whenever
// another connection writes, and on a busy relay may never finish.
export const ALL_PAGES = 0x7fffffff;
// A filesystem without hard links (vfat, some network shares): the final
// name is taken by a checked rename instead.
const NO_LINK_CODES = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL']);

/** `[a-z0-9-]{1,40}`; nothing left of it: `manual`. */
export function sanitizeReason(text) {
  const reason = String(text ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
  return reason || 'manual';
}

/** `YYYYMMDD-HHMMSS` in UTC. */
export function backupStamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '').replace(/-|:/g, '').replace('T', '-');
}

export function backupName({ version, at, reason }) {
  return `oar-${version}-${backupStamp(at)}-${sanitizeReason(reason)}.db`;
}

/** The `-2`, `-3` … form of a name taken already. */
function numbered(name, n) {
  return n < 2 ? name : name.replace(/\.db$/, `-${n}.db`);
}

export function formatMegabytes(bytes) {
  return `${(Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1)} MB`;
}

/** `keep`: a whole number of at least 1; anything else (said by configWarnings) is the default. */
export function normalizeKeep(value) {
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_BACKUP_KEEP;
}

function backupSettings(config) {
  const settings = config?.dbBackups && typeof config.dbBackups === 'object' ? config.dbBackups : {};
  return { enabled: settings.enabled !== false, keep: normalizeKeep(settings.keep), dir: settings.dir };
}

/** `[config]` lines for `dbBackups` values that are not used as written. */
export function configWarnings(config) {
  const settings = config?.dbBackups;
  if (settings === undefined || settings === null) return [];
  if (typeof settings !== 'object' || Array.isArray(settings)) return [`[config] dbBackups must be an object (it is ${JSON.stringify(settings)}); using the defaults.`];
  const warnings = [];
  if (settings.keep !== undefined && settings.keep !== null && normalizeKeep(settings.keep) !== settings.keep) {
    warnings.push(`[config] dbBackups.keep must be a whole number of at least 1 (it is ${JSON.stringify(settings.keep)}); using ${DEFAULT_BACKUP_KEEP}.`);
  }
  if (settings.enabled !== undefined && settings.enabled !== null && typeof settings.enabled !== 'boolean') {
    warnings.push(`[config] dbBackups.enabled must be true or false (it is ${JSON.stringify(settings.enabled)}); using true.`);
  }
  return warnings;
}

// The real path of a file or folder that may not exist yet: its nearest
// existing parent resolved, the rest appended. Compared case-insensitively
// on Windows.
function realish(target, { fsImpl = fs, platform = process.platform } = {}) {
  let existing = path.resolve(String(target || ''));
  const rest = [];
  for (;;) {
    try {
      existing = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(existing) : fsImpl.realpathSync(existing);
      break;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = path.join(existing, ...rest);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function nearestExisting(target, fsImpl) {
  let dir = path.resolve(String(target || ''));
  while (!fsImpl.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

// The folder or one above it that holds a DO_NOT_TOUCH file, by real path.
function guardedBy(dir, { fsImpl, platform }) {
  let current = realish(dir, { fsImpl, platform });
  for (;;) {
    let names = [];
    try { names = fsImpl.readdirSync(current); } catch {}
    const guard = names.find((name) => /^DO_NOT_TOUCH/i.test(name));
    if (guard) return path.join(current, guard);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * The backup folder: `dbBackups.dir` (absolute only), else `backups` in the
 * state root (npm) or `server/backups` (a checkout), outside the data
 * folder. `{ dir, warnings }`, or `{ status: 'failed' | 'skipped', reason }`
 * when no backup may be written there.
 */
export function resolveBackupDir({ layout, serverDir, dataDir, config, fsImpl = fs, platform = process.platform } = {}) {
  const { dir: configured } = backupSettings(config);
  let dir;
  if (configured !== undefined && configured !== null && configured !== '') {
    if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
      return { status: 'failed', reason: `dbBackups.dir in config.json must be an absolute path (it is ${JSON.stringify(configured)})` };
    }
    dir = path.resolve(configured);
  } else {
    dir = layout?.checkout || !layout?.root ? path.join(String(serverDir || ''), 'backups') : path.join(layout.root, 'backups');
  }
  const warnings = [];
  if (dataDir) {
    const real = realish(dir, { fsImpl, platform });
    const data = realish(dataDir, { fsImpl, platform });
    if (real === data) return { status: 'skipped', reason: `the backup folder ${dir} is the data folder itself`, dir };
    if (real.startsWith(data + path.sep)) {
      warnings.push(`the backup folder ${dir} is inside the data folder ${dataDir}: copies of the data folder take the backups along`);
    }
  }
  const guard = guardedBy(dir, { fsImpl, platform });
  if (guard) return { status: 'skipped', reason: `${guard} guards ${dir}: nothing is written there`, dir };
  return { dir, warnings };
}

/**
 * Room for one more copy of the database: free − its size ≥ max(1 GiB, 5 %
 * of the disk). Unknown (no statfs): `ok`, a full disk fails the write
 * cleanly anyway.
 */
export function checkBackupSpace({ dir, dbBytes, fsImpl = fs }) {
  const at = nearestExisting(dir, fsImpl);
  const free = freeBytes(at, fsImpl);
  const total = diskBytes(at, fsImpl);
  if (free === null || total === null || !Number.isFinite(free) || !Number.isFinite(total)) return { ok: true, unknown: true };
  const need = Math.max(GIB, 0.05 * total);
  return { ok: free - dbBytes >= need, free, total, need };
}

export function emptyManifest() {
  return { seq: 0, backups: [], lastResult: null, pending: [] };
}

export function readManifest(dataDir, { fsImpl = fs, logger = null } = {}) {
  const file = path.join(dataDir, BACKUP_MANIFEST_FILE);
  let text;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch { return emptyManifest(); }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.backups)) throw new Error('not a manifest');
    const pending = Array.isArray(parsed.pending) ? parsed.pending : (parsed.pending ? [parsed.pending] : []);
    return {
      seq: Number.isInteger(parsed.seq) ? parsed.seq : parsed.backups.length,
      backups: parsed.backups.filter((entry) => entry && typeof entry === 'object'),
      lastResult: parsed.lastResult && typeof parsed.lastResult === 'object' ? parsed.lastResult : null,
      pending: pending.filter((entry) => entry && typeof entry === 'object'),
    };
  } catch {
    // Read as empty: what it listed is never deleted, only forgotten.
    logger?.warn?.(`[backup] ${file} could not be read; starting a new one (the backups it listed stay, not rotated).`);
    return emptyManifest();
  }
}

// A temp file of this process's own: two writers never share one.
export function writeManifest(dataDir, manifest, { fsImpl = fs, sleep = sleepSync, pid = process.pid } = {}) {
  const file = path.join(dataDir, BACKUP_MANIFEST_FILE);
  const temporary = `${file}.${pid}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameWithRetry(fsImpl, temporary, file, sleep);
}

// Read, changed and written at once: another process's change in between
// is kept, not overwritten with an old copy.
function updateManifest(dataDir, change, { fsImpl, sleep, pid, logger }) {
  const manifest = readManifest(dataDir, { fsImpl, logger });
  const result = change(manifest);
  writeManifest(dataDir, manifest, { fsImpl, sleep, pid });
  return result;
}

function removeQuietly(fsImpl, file) {
  for (const each of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try { fsImpl.rmSync(each, { force: true }); } catch {}
  }
}

// `.partial` files a killed writer left: the manifest named each, with the
// writer's pid, before it was written. Only those of a pid that no longer
// runs go; a live one is still writing.
function removeDeadPending(manifest, { fsImpl, platform, isProcessAlive, pid }) {
  manifest.pending = manifest.pending.filter((entry) => {
    const owner = Number(entry.pid);
    if (owner !== pid && Number.isInteger(owner) && owner > 0 && isProcessAlive(owner)) return true;
    const name = String(entry.file || '');
    if (entry.dir && name === path.basename(name) && name.endsWith('.partial') && BACKUP_NAME_RE.test(name.slice(0, -'.partial'.length))) {
      removeQuietly(fsImpl, path.join(realish(entry.dir, { fsImpl, platform }), name));
    }
    return false;
  });
}

const sameDir = (a, b, options) => realish(a, options) === realish(b, options);

/**
 * Writes the copy: `<name>.partial` in `dir` (created 0600 with `wx`: the
 * name is ours, and the copy is never readable by others) from `source`
 * (an open better-sqlite3 database), checked, made one file, synced, then
 * linked to a free name (`-2`, `-3` when taken; never over a file).
 * `onReserved(partialName)` runs once the name is ours, before the copy.
 * `{ ok, file, bytes, phases }`, or `{ ok: false, reason }` with nothing
 * left behind.
 */
export async function writeBackup({
  source, Database, dir, name, onReserved = () => {}, fsImpl = fs, platform = process.platform, sleep = sleepSync,
  clock = Date.now,
  rename = (from, to) => renameWithRetry(fsImpl, from, to, sleep),
  link = (from, to) => fsImpl.linkSync(from, to),
}) {
  let n = 1;
  let partial = null;
  for (;;) {
    const candidate = path.join(dir, `${numbered(name, n)}.partial`);
    if (!fsImpl.existsSync(path.join(dir, numbered(name, n)))) {
      try {
        fsImpl.closeSync(fsImpl.openSync(candidate, 'wx', 0o600));
        partial = candidate;
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') return { ok: false, reason: error?.message || String(error) };
      }
    }
    n += 1;
  }
  const phases = {};
  let at = clock();
  const phase = (label) => { const now = clock(); phases[label] = now - at; at = now; };
  try {
    onReserved(path.basename(partial));
    await source.backup(partial, { progress: () => ALL_PAGES });
    phase('copy');
    // The copied header may say WAL: the check makes -wal/-shm beside it,
    // DELETE takes them away again.
    const check = new Database(partial, { fileMustExist: true });
    let integrity;
    try {
      integrity = String(check.pragma('quick_check', { simple: true }) || '');
      if (integrity === 'ok') check.pragma('journal_mode = DELETE');
    } finally {
      check.close();
    }
    for (const side of ['-wal', '-shm']) { try { fsImpl.rmSync(`${partial}${side}`, { force: true }); } catch {} }
    phase('check');
    if (integrity !== 'ok') {
      removeQuietly(fsImpl, partial);
      return { ok: false, reason: `the copy failed its check (${oneLine(integrity)})` };
    }
    // Best effort: a folder on vfat or a network share has no such modes.
    if (platform !== 'win32') { try { fsImpl.chmodSync(partial, 0o600); } catch {} }
    const fd = fsImpl.openSync(partial, 'r+');
    try { fsImpl.fsyncSync(fd); } finally { fsImpl.closeSync(fd); }
    phase('sync');
    const bytes = fsImpl.statSync(partial).size;
    let file;
    for (;; n += 1) {
      file = numbered(name, n);
      const target = path.join(dir, file);
      try {
        link(partial, target);
        fsImpl.rmSync(partial, { force: true });
        break;
      } catch (error) {
        if (error?.code === 'EEXIST') continue;
        if (!NO_LINK_CODES.has(error?.code)) throw error;
        // No hard links here: a rename, checked just before.
        if (fsImpl.existsSync(target)) continue;
        rename(partial, target);
        break;
      }
    }
    phase('rename');
    return { ok: true, file, bytes, phases };
  } catch (error) {
    removeQuietly(fsImpl, partial);
    return { ok: false, reason: error?.message || String(error) };
  }
}

/**
 * Keeps the `keep` newest of this relay's own backups in `dir` (newest by
 * the manifest's order, never by clock) and deletes the rest. Own: in its
 * manifest, in this folder, checked, named by the pattern, a plain file
 * with the size recorded. `keepFile` (this run's) is never deleted.
 * Entries whose files are gone are dropped from the manifest.
 */
export function rotateBackups({ manifest, dir, keep, keepFile = null, fsImpl = fs, platform = process.platform, logger = console }) {
  const rotated = [];
  const warnings = [];
  manifest.backups = manifest.backups.filter((entry) => {
    try { fsImpl.lstatSync(path.join(String(entry.dir || ''), String(entry.file || ''))); return true; } catch { return false; }
  });
  const own = manifest.backups.filter((entry) => isOwnFile(entry, dir, { fsImpl, platform }))
    .sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0) || String(b.file).localeCompare(String(a.file)));
  const keepers = new Set(keepFile ? [keepFile] : []);
  for (const entry of own) {
    if (keepers.size >= keep) break;
    keepers.add(entry.file);
  }
  for (const entry of own) {
    if (keepers.has(entry.file)) continue;
    const file = path.join(dir, entry.file);
    try {
      fsImpl.unlinkSync(file);
      manifest.backups = manifest.backups.filter((other) => other !== entry);
      rotated.push(entry.file);
      logger.log?.(`[backup] rotated out ${file}`);
    } catch (error) {
      const why = RETRY_CODES.has(error?.code) ? 'held by another program' : (error?.message || String(error));
      warnings.push(`${file} could not be deleted (${why}); tried again at the next backup`);
      logger.warn?.(`[backup] ${file} could not be deleted (${why}); it is tried again at the next backup.`);
    }
  }
  return { rotated, warnings };
}

function isOwnFile(entry, dir, { fsImpl, platform }) {
  const name = String(entry.file || '');
  if (name !== path.basename(name) || !BACKUP_NAME_RE.test(name) || entry.quickCheck !== 'ok') return false;
  if (!entry.dir || !sameDir(entry.dir, dir, { fsImpl, platform })) return false;
  try {
    const stat = fsImpl.lstatSync(path.join(dir, name));
    return stat.isFile() && stat.size === Number(entry.bytes);
  } catch {
    return false;
  }
}

function folderBytes(fsImpl, dir) {
  let bytes = 0;
  let entries = [];
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += folderBytes(fsImpl, full);
    else { try { bytes += fsImpl.lstatSync(full).size; } catch {} }
  }
  return bytes;
}

/**
 * What is in the backup folder: this relay's backups (`own`), those of its
 * manifest whose size changed since (`changed`, never rotated), and
 * everything else (`others`, with sizes; folders summed unless `sizes` is
 * false, then null). Read only.
 */
export function listBackupDir({ dir, manifest, sizes = true, fsImpl = fs, platform = process.platform }) {
  const own = [];
  const changed = [];
  const others = [];
  let entries = [];
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return { own, changed, others }; }
  const listed = new Map(manifest.backups
    .filter((entry) => entry.dir && sameDir(entry.dir, dir, { fsImpl, platform }))
    .map((entry) => [String(entry.file), entry]));
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const record = listed.get(entry.name);
    if (record && isOwnFile(record, dir, { fsImpl, platform })) {
      own.push({ file: entry.name, bytes: Number(record.bytes), at: record.at, version: record.version, reason: record.reason, seq: record.seq });
    } else if (record && entry.isFile()) {
      let bytes = 0;
      try { bytes = fsImpl.lstatSync(full).size; } catch {}
      changed.push({ file: entry.name, bytes, recordedBytes: Number(record.bytes) });
    } else {
      let bytes = null;
      if (entry.isDirectory()) bytes = sizes ? folderBytes(fsImpl, full) : null;
      else { try { bytes = fsImpl.lstatSync(full).size; } catch { bytes = 0; } }
      others.push({ name: entry.name, bytes, folder: entry.isDirectory() });
    }
  }
  own.sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));
  return { own, changed, others };
}

function fileSize(fsImpl, file) {
  try { return fsImpl.statSync(file).size; } catch { return 0; }
}

function readJson(fsImpl, file) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; }
}

const seconds = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)} s`;

// How long a start waits for an `oar backup` that is writing a copy of the
// same database, before it goes on without its own.
export const BACKUP_HOLDER_WAIT_MS = 15 * 60_000;

/**
 * Whether the process a progress file names still writes that backup: its
 * pid lives and is the same process (its recorded start and boot id, as for
 * the relay's lock: a pid reused after a crash or a reboot is not). True
 * when that cannot be told.
 */
export function backupHolderMayRun(progress, { isProcessAlive = defaultIsProcessAlive, identityOf = processIdentity } = {}) {
  return lockHolderMayRun({ lock: progress, isProcessAlive, identityOf });
}

function progressHeldByOther(progressFile, { pid, fsImpl, holderMayRun }) {
  const held = readJson(fsImpl, progressFile);
  const holder = Number(held?.pid);
  return Number.isInteger(holder) && holder > 0 && holder !== pid && holderMayRun(held) ? held : null;
}

/**
 * At start, under the relay's lock: a progress file whose writer no longer
 * runs (killed mid-copy, its pid gone or reused) is removed, said with its
 * pid. Returns whether one was removed.
 */
export function removeStaleBackupProgress({ dataDir, pid = process.pid, holderMayRun = backupHolderMayRun, fsImpl = fs, logger = console }) {
  const progressFile = path.join(dataDir, BACKUP_PROGRESS_FILE);
  const held = readJson(fsImpl, progressFile);
  if (!held) return false;
  const holder = Number(held.pid);
  if (holder !== pid && Number.isInteger(holder) && holder > 0 && holderMayRun(held)) return false;
  try { fsImpl.rmSync(progressFile, { force: true }); } catch { return false; }
  logger.log?.(`[backup] removed ${progressFile}: process ${Number.isInteger(holder) ? holder : '?'} that wrote it no longer runs (a backup it left unfinished).`);
  return true;
}

/**
 * One backup of `source` (the database at `dbPath`) into the backup folder,
 * then the rotation. The start step and `oar backup` both run it. Returns
 * `{ status: 'written' | 'skipped' | 'failed' | 'busy', reason?, file?,
 * bytes?, dir?, rotated, warnings }`; the manifest's lastResult says the
 * same (not for `busy`: another backup of this database runs, with `pid`).
 */
export async function backupDatabase({
  source,
  Database,
  dbPath,
  dataDir,
  layout,
  serverDir,
  config,
  version,
  commit = null,
  reason,
  now = () => new Date(),
  clock = Date.now,
  pid = process.pid,
  isProcessAlive = defaultIsProcessAlive,
  identityOf = processIdentity,
  holderMayRun = (progress) => backupHolderMayRun(progress, { isProcessAlive, identityOf }),
  // The start's own copy, after it waited: written beside another writer
  // (two writers never share a name or a temp file).
  besideHolder = false,
  fsImpl = fs,
  platform = process.platform,
  sleep = sleepSync,
  logger = console,
} = {}) {
  const at = now();
  const progressFile = path.join(dataDir, BACKUP_PROGRESS_FILE);
  const options = { fsImpl, sleep, pid, logger };
  const settled = (result) => {
    try {
      updateManifest(dataDir, (manifest) => {
        removeDeadPending(manifest, { fsImpl, platform, isProcessAlive, pid });
        manifest.lastResult = {
          status: result.status,
          ...(result.reason ? { reason: result.reason } : {}),
          at: at.toISOString(),
          ...(result.file ? { file: result.file, dir: result.dir, bytes: result.bytes } : {}),
        };
      }, options);
    } catch (error) {
      logger.warn?.(`[backup] ${path.join(dataDir, BACKUP_MANIFEST_FILE)} could not be written (${error?.message || error}).`);
    }
    if (result.status === 'skipped') logger.warn?.(`[backup] skipped: ${result.reason}`);
    if (result.status === 'failed') logger.warn?.(`[backup] failed: ${result.reason}`);
    if (result.status === 'busy') logger.warn?.(`[backup] busy: ${result.reason}`);
    return { rotated: [], warnings: [], ...result };
  };
  // One backup of a database at a time: another process's progress file,
  // its writer still the same live process, means it is copying now. Never
  // removed here; recorded, so About and doctor show it.
  const held = besideHolder ? null : progressHeldByOther(progressFile, { pid, fsImpl, holderMayRun });
  const ownProgressFile = besideHolder ? path.join(dataDir, BACKUP_WAIT_FILE) : progressFile;
  if (held) return settled({ status: 'busy', pid: Number(held.pid), reason: `another backup of this database is running (process ${held.pid})` });
  const settings = backupSettings(config);
  const place = resolveBackupDir({ layout, serverDir, dataDir, config, fsImpl, platform });
  if (place.status) return settled({ status: place.status, reason: place.reason });
  const { dir } = place;
  for (const warning of place.warnings) logger.warn?.(`[backup] ${warning}.`);
  const dbBytes = fileSize(fsImpl, dbPath) + fileSize(fsImpl, `${dbPath}-wal`);
  const space = checkBackupSpace({ dir, dbBytes, fsImpl });
  if (!space.ok) {
    return settled({
      status: 'skipped',
      reason: `not enough disk space in ${dir} (${formatMegabytes(space.free)} free, a copy needs ${formatMegabytes(dbBytes)} and ${formatMegabytes(space.need)} must stay free)`,
    });
  }
  try {
    // Only the owner may look into a new backup folder.
    fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return settled({ status: 'failed', reason: `${dir} could not be made (${error?.message || error})` });
  }
  const name = backupName({ version, at, reason });
  const started = clock();
  let pendingFile = null;
  let written;
  try {
    // With this process's identity: a pid reused later is not this writer.
    const progress = { pid, format: 2, holder: identityOf(pid), task: 'backup', from: dbPath, bytes: dbBytes, at: at.toISOString() };
    // Beside another writer its progress file stays its own: this one's goes
    // into the wait note, which `oar start` reads as well.
    try { fsImpl.writeFileSync(ownProgressFile, `${JSON.stringify(progress, null, 2)}\n`); } catch {}
    logger.log?.(`[backup] backing up ${dbPath} (${formatMegabytes(dbBytes)}) to ${dir}`);
    written = await writeBackup({
      source, Database, dir, name, fsImpl, platform, sleep, clock,
      // The exact name, with this pid, before a byte is copied: a kill
      // leaves a .partial the next backup knows to be a dead one's.
      onReserved: (partialName) => {
        pendingFile = partialName;
        updateManifest(dataDir, (manifest) => {
          removeDeadPending(manifest, { fsImpl, platform, isProcessAlive, pid });
          manifest.pending.push({ file: partialName, dir, pid });
        }, options);
      },
    });
  } catch (error) {
    written = { ok: false, reason: error?.message || String(error) };
  } finally {
    if (readJson(fsImpl, ownProgressFile)?.pid === pid) { try { fsImpl.rmSync(ownProgressFile, { force: true }); } catch {} }
  }
  const clearOwnPending = (manifest) => {
    manifest.pending = manifest.pending.filter((entry) => !(Number(entry.pid) === pid && entry.file === pendingFile));
  };
  // A failed backup never pushes out a good one: no rotation.
  if (!written.ok) {
    try { updateManifest(dataDir, clearOwnPending, options); } catch {}
    return settled({ status: 'failed', reason: written.reason });
  }
  logger.log?.(`[backup] written ${path.join(dir, written.file)} (${formatMegabytes(written.bytes)}, quick_check ok, ${seconds(clock() - started)})`);
  logger.log?.(`[backup] phases: copy ${seconds(written.phases.copy)}, check ${seconds(written.phases.check)}, sync ${seconds(written.phases.sync)}, rename ${seconds(written.phases.rename)}`);
  let rotation = { rotated: [], warnings: [] };
  try {
    rotation = updateManifest(dataDir, (manifest) => {
      clearOwnPending(manifest);
      manifest.seq += 1;
      manifest.backups.push({
        file: written.file, dir, version, commit: commit || null, reason: sanitizeReason(reason), at: at.toISOString(), bytes: written.bytes, quickCheck: 'ok', seq: manifest.seq,
      });
      return rotateBackups({ manifest, dir, keep: settings.keep, keepFile: written.file, fsImpl, platform, logger });
    }, options);
  } catch (error) {
    logger.warn?.(`[backup] ${path.join(dataDir, BACKUP_MANIFEST_FILE)} could not be written (${error?.message || error}); ${written.file} is kept, not rotated.`);
  }
  const result = settled({ status: 'written', file: written.file, dir, bytes: written.bytes });
  return { ...result, rotated: rotation.rotated, warnings: [...place.warnings, ...rotation.warnings] };
}

function readSetting(db, key) {
  try {
    return db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function hasSettingsTable(db) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get();
  } catch {
    return false;
  }
}

/** db_last_run = `record` ({ version, commit, at }). */
export function writeDbLastRun(db, record) {
  db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(DB_LAST_RUN_SETTING_KEY, JSON.stringify(record), record.at);
}

function parseJson(text) {
  try {
    const value = JSON.parse(String(text ?? ''));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const versionOf = (value) => {
  const text = String(value ?? '').trim().replace(/^v/, '');
  return VERSION_RE.test(text) ? text : null;
};

/**
 * The version that ran on the data before, when db_last_run does not say:
 * the in-app update's record, if it is this update's (its target is the
 * running version) and at most a week old, as reconcileUpdateAttempt trusts it.
 */
function updateAttemptFromVersion(db, runningVersion, nowMs) {
  const attempt = parseJson(readSetting(db, UPDATE_ATTEMPT_SETTING_KEY));
  if (!attempt) return null;
  if (versionOf(attempt.attemptedVersion) !== versionOf(runningVersion)) return null;
  const startedAt = Date.parse(String(attempt.startedAt || ''));
  if (!Number.isFinite(startedAt) || nowMs - startedAt > UPDATE_ATTEMPT_MAX_AGE_MS || startedAt - nowMs > UPDATE_ATTEMPT_MAX_AGE_MS) return null;
  return versionOf(attempt.fromVersion);
}

/**
 * The start step, between opening the database and applySchema: a backup
 * when the version (on a checkout also the commit) that last ran on this
 * database differs from the running one, or is unknown. Skipped for a
 * database just created and with `dbBackups.enabled: false`.
 *
 * db_last_run is written as soon as the step is done, also after a skip or
 * a failure (a crash loop or a full disk never repeats the copy at every
 * start); with no app_settings table yet (a new or very old database) it is
 * returned as `deferredLastRun`, for the caller to write after applySchema.
 */
export async function maybeBackupBeforeStart({
  db,
  Database,
  dbPath,
  dataDir,
  databaseCreated = false,
  layout,
  serverDir,
  config,
  runningVersion,
  runningCommit = null,
  checkout = !!layout?.checkout,
  now = () => new Date(),
  clock = Date.now,
  pid = process.pid,
  isProcessAlive = defaultIsProcessAlive,
  identityOf = processIdentity,
  holderMayRun = (progress) => backupHolderMayRun(progress, { isProcessAlive, identityOf }),
  holderWaitMs = BACKUP_HOLDER_WAIT_MS,
  pollMs = 1000,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fsImpl = fs,
  platform = process.platform,
  sleep = sleepSync,
  logger = console,
} = {}) {
  for (const warning of configWarnings(config)) logger.warn?.(warning);
  removeStaleBackupProgress({ dataDir, pid, holderMayRun, fsImpl, logger });
  // Only the relay that holds the lock writes the wait note: one there now
  // is a killed start's.
  try { fsImpl.rmSync(path.join(dataDir, BACKUP_WAIT_FILE), { force: true }); } catch {}
  const at = now();
  const record = { version: String(runningVersion), commit: checkout ? (runningCommit || null) : null, at: at.toISOString() };
  const settingsTable = hasSettingsTable(db);
  const finish = (result) => {
    if (!settingsTable) return { ...result, deferredLastRun: record };
    writeDbLastRun(db, record);
    return result;
  };
  if (databaseCreated) return finish({ status: 'new-database' });

  const last = settingsTable ? parseJson(readSetting(db, DB_LAST_RUN_SETTING_KEY)) : null;
  const lastVersion = versionOf(last?.version);
  const lastCommit = typeof last?.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(last.commit) ? last.commit.toLowerCase() : null;
  if (lastVersion && lastVersion === versionOf(runningVersion)) {
    // On a checkout the commit too, when it can be read now.
    if (!checkout || !record.commit || lastCommit === record.commit.toLowerCase()) return { status: 'same' };
  }
  if (!backupSettings(config).enabled) return finish({ status: 'disabled' });

  let version;
  let reason;
  if (lastVersion) {
    version = lastVersion;
    reason = checkout && lastCommit ? `pre-update-${lastCommit.slice(0, 7)}` : 'pre-update';
  } else {
    const fromVersion = settingsTable ? updateAttemptFromVersion(db, runningVersion, at.getTime()) : null;
    version = fromVersion || versionOf(runningVersion) || '0.0.0';
    reason = fromVersion ? 'pre-update' : 'pre-update-from-unknown';
  }
  // An `oar backup` writing a copy of this database now: wait for it (it may
  // be the copy before this very update), then make this start's own, in
  // any case: a holder taken for live by mistake never costs a start its
  // backup. The wait note tells `oar start` to leave this relay running.
  const progressFile = path.join(dataDir, BACKUP_PROGRESS_FILE);
  const held = progressHeldByOther(progressFile, { pid, fsImpl, holderMayRun });
  let besideHolder = false;
  if (held) {
    const waitFile = path.join(dataDir, BACKUP_WAIT_FILE);
    logger.log?.(`[backup] process ${held.pid} is backing up this database; waiting for it (up to ${Math.round(holderWaitMs / 60_000)} min) before this start's own backup.`);
    try { fsImpl.writeFileSync(waitFile, `${JSON.stringify({ pid, format: 2, holder: identityOf(pid), task: 'wait-backup', waitingFor: Number(held.pid), at: new Date(clock()).toISOString() }, null, 2)}\n`); } catch {}
    try {
      const until = clock() + holderWaitMs;
      while (clock() < until && progressHeldByOther(progressFile, { pid, fsImpl, holderMayRun })) await wait(pollMs);
    } finally {
      try { fsImpl.rmSync(waitFile, { force: true }); } catch {}
    }
    if (progressHeldByOther(progressFile, { pid, fsImpl, holderMayRun })) {
      besideHolder = true;
      logger.warn?.(`[backup] process ${held.pid} still holds ${progressFile} after ${Math.round(holderWaitMs / 60_000)} min; this start makes its own backup beside it.`);
    }
  }
  const result = await backupDatabase({
    source: db, Database, dbPath, dataDir, layout, serverDir, config, version, commit: lastCommit, reason,
    now: () => at, clock, pid, isProcessAlive, identityOf, holderMayRun, besideHolder, fsImpl, platform, sleep, logger,
  });
  if (result.status !== 'written') logger.warn?.('[backup] This start goes on without a backup of the version before; run `oar backup` for one.');
  // Never expected here (the start backs up beside a holder), but a busy
  // result would make no copy: db_last_run stays, the next start tries again.
  if (result.status === 'busy') return result;
  return finish(result);
}

/**
 * What doctor and About show: the folder (or why there is none), the
 * settings, this relay's backups, the files there it does not rotate, and
 * the last result. Read only. `sizes: false` (About) leaves the sizes of
 * the folders there out: no walk through them.
 */
export function describeBackups({ layout, serverDir, dataDir, config, sizes = true, fsImpl = fs, platform = process.platform } = {}) {
  const settings = backupSettings(config);
  const manifest = readManifest(dataDir, { fsImpl });
  const place = resolveBackupDir({ layout, serverDir, dataDir, config, fsImpl, platform });
  const dir = place.dir || null;
  const listing = dir && !place.status ? listBackupDir({ dir, manifest, sizes, fsImpl, platform }) : { own: [], changed: [], others: [] };
  return {
    enabled: settings.enabled,
    keep: settings.keep,
    dir,
    problem: place.status ? place.reason : null,
    warnings: [...configWarnings(config), ...(place.warnings || [])],
    lastResult: manifest.lastResult,
    ...listing,
  };
}

/**
 * The in-app update's line, before npm installs: whether the next start
 * backs up the database, and where, or why it will not.
 */
export function describeNextBackup({ layout, serverDir, dataDir, dbPath, config, fsImpl = fs, platform = process.platform } = {}) {
  if (!backupSettings(config).enabled) return '[backup] The next start does not back up the database: dbBackups.enabled is false in config.json.';
  const place = resolveBackupDir({ layout, serverDir, dataDir, config, fsImpl, platform });
  if (place.status) return `[backup] The next start does not back up the database: ${place.reason}. Run \`oar backup\` now for a copy.`;
  const dbBytes = fileSize(fsImpl, dbPath) + fileSize(fsImpl, `${dbPath}-wal`);
  const space = checkBackupSpace({ dir: place.dir, dbBytes, fsImpl });
  if (!space.ok) {
    return `[backup] The next start does not back up the database: not enough disk space in ${place.dir} (${formatMegabytes(space.free)} free, a copy needs ${formatMegabytes(dbBytes)}). Free some space, or run \`oar backup\` once there is room.`;
  }
  return `[backup] The next start backs up the database (${formatMegabytes(dbBytes)}) to ${place.dir} before the new version's migrations.`;
}
