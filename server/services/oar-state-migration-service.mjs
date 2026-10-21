/**
 * One-time migration of relay state into the OAR state root (~/.oar).
 *
 * Global npm installs cannot keep state under the package directory — `npm i -g`
 * replaces the tree on every update, database included. This service copies the
 * old state (a git-checkout's server/ tree, and/or the legacy managed config
 * dir) into the state root. The automatic run happens once, guarded by a
 * marker file written after a real copy; `--migrate-from` names a checkout
 * explicitly and runs regardless of the marker.
 *
 * Contract (docs/plans/oar-rebrand-and-release.md §5.2):
 *  - refuse to run while a relay holds the source lock (live pid);
 *  - checkpoint the WAL before copying, then copy db + -wal + -shm together;
 *  - copy, never move — the source stays untouched as the rollback path;
 *  - verify integrity and row counts before writing the marker;
 *  - never overwrite: an existing target database refuses the run unless it
 *    is fresh and no relay holds it (then it is moved into backups/), an
 *    existing config.json is kept, uploads and logs are merged;
 *  - on any mismatch remove what this run copied and leave the marker unwritten.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createRelaySingletonGuard } from './relay-singleton-guard.mjs';

export const MIGRATION_MARKER = '.migrated';
const DB_FILE = 'copilot.db';
const MAX_LOGS_BYTES = 50 * 1024 * 1024;

export function resolveOarRoot(env = process.env, platform = process.platform) {
  const override = String(env.OAR_STATE_ROOT || '').trim();
  if (override) return path.resolve(override);
  if (platform === 'win32') {
    const appData = String(env.APPDATA || '').trim();
    if (appData) return path.join(appData, 'oar');
    const profile = String(env.USERPROFILE || '').trim();
    return path.join(profile || os.homedir(), 'AppData', 'Roaming', 'oar');
  }
  return path.join(os.homedir(), '.oar');
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockPid(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const pid = Number.parseInt(String(parsed?.pid ?? ''), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function directorySizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  }
  return total;
}

function makeDir(dir, created) {
  const first = fs.mkdirSync(dir, { recursive: true });
  if (first) created.push(first);
}

// Whether anything — a link included, even one whose target is missing (a
// folder on a disk that is not mounted) — sits at this path.
function pathTaken(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

// Copies without overwriting: a file already at the target is left alone, a
// directory is merged entry by entry. The source is read through links (a
// symlinked server/uploads is copied as a real folder); links inside a
// copied folder are skipped and listed in `skipped`. A path goes into
// `created` only once this run made it, so a failed migration takes back
// exactly what it added and never a file or link that was already there.
function copyNew(source, target, created, skipped) {
  const stat = fs.statSync(source);
  if (!stat.isDirectory()) {
    if (pathTaken(target)) return;
    makeDir(path.dirname(target), created);
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      // Someone else's file appeared in between: theirs, left alone.
      if (error?.code === 'EEXIST') return;
      try { fs.rmSync(target, { force: true }); } catch {}
      throw error;
    }
    created.push(target);
    return;
  }
  if (!pathTaken(target)) {
    makeDir(path.dirname(target), created);
    try {
      fs.mkdirSync(target);
      created.push(target);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    if (entry.isSymbolicLink()) skipped.push(from);
    else if (entry.isDirectory() || entry.isFile()) copyNew(from, path.join(target, entry.name), created, skipped);
  }
}

function copyIfExists(source, target, copied, created, skipped) {
  if (!source || !fs.existsSync(source)) return false;
  const before = created.length;
  copyNew(source, target, created, skipped);
  if (created.length === before) return false;
  const bytes = fs.statSync(source).isDirectory() ? directorySizeBytes(source) : fs.statSync(source).size;
  copied.push({ from: source, to: target, bytes });
  return true;
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

// A database the relay created on its first start and never used: both
// tables there and empty. Anything unreadable or unexpected is not fresh.
function isFreshDatabase(Database, dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  try {
    const counts = readDbCounts(Database, dbPath);
    return counts.integrity === 'ok' && counts.conversations === 0 && counts.messages === 0;
  } catch {
    return false;
  }
}

function removeCreated(created) {
  for (const entry of [...created].reverse()) {
    try { fs.rmSync(entry, { recursive: true, force: true }); } catch {}
  }
}

async function loadDatabase(DatabaseImpl) {
  if (DatabaseImpl) return DatabaseImpl;
  const mod = await import('better-sqlite3');
  return mod.default;
}

function readDbCounts(Database, dbPath, { checkpoint = false } = {}) {
  const db = new Database(dbPath, checkpoint ? {} : { readonly: true });
  try {
    if (checkpoint) db.pragma('wal_checkpoint(TRUNCATE)');
    const integrity = String(db.pragma('integrity_check', { simple: true }) || '');
    const tableExists = (name) => !!db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);
    const countOf = (table) => (tableExists(table)
      ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0)
      : null);
    return {
      integrity,
      conversations: countOf('conversations'),
      messages: countOf('messages'),
    };
  } finally {
    db.close();
  }
}

const RECEIPT_SOURCE_LINE = '- repo server dir: ';

// Whether an earlier run already brought this checkout over: the marker of a
// real migration, and a receipt naming it as its source.
function wasMigratedFrom(root, repoServerDir) {
  if (!fs.existsSync(path.join(root, MIGRATION_MARKER))) return false;
  let receipt = '';
  try { receipt = fs.readFileSync(path.join(root, 'backups', 'MIGRATION.md'), 'utf8'); } catch { return false; }
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return receipt.split(/\r?\n/).some((line) => line.startsWith(RECEIPT_SOURCE_LINE)
    && normalize(line.slice(RECEIPT_SOURCE_LINE.length)) === normalize(repoServerDir));
}

/**
 * Returns { status, ... } — statuses: 'already-migrated' (with `source` when
 * an explicit source was brought over before), 'blocked-live-relay',
 * 'refused-relay-running', 'refused-existing-database', 'nothing-to-migrate'
 * (with a `reason`), 'migrated' (with `kept`: targets that already existed and
 * were left alone, `skipped`: links inside copied folders, and
 * `movedAsideTo`: where a fresh target database went).
 * Throws only on verification failure or an unexpected copy error, after
 * removing what this run copied.
 *
 * The marker guards only the automatic run (no repoServerDir): a source named
 * explicitly (`--migrate-from`) runs again unless the receipt shows that same
 * source was migrated and its database is still there. What keeps that safe
 * is that a migration never overwrites — it refuses when the target already
 * has a database with conversations, keeps an existing config.json, and
 * merges uploads and logs. A fresh database without any conversation or
 * message (what the installer's first relay start leaves) is moved into
 * backups/<timestamp>/ first. A run that copies a database holds the relay's
 * own lock while it does, so no relay can start on the data dir meanwhile; a
 * relay holding it refuses the run. The marker is written only after
 * something was really copied.
 *
 * `targetDataDir`/`targetUploadDir` are where the relay will read database
 * and uploads; callers resolve them as the relay does (data-dir-resolution).
 * The defaults are a global install's: `<root>/data` and `<root>/data/uploads`.
 */
export async function migrateStateToOarRoot({
  targetRoot,
  targetDataDir = null,
  targetUploadDir = null,
  repoServerDir = null,
  managedConfigDir = null,
  isProcessAliveImpl = defaultIsProcessAlive,
  DatabaseImpl = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!String(targetRoot || '').trim()) throw new Error('targetRoot is required');
  const root = path.resolve(String(targetRoot));
  const dataDir = targetDataDir ? path.resolve(String(targetDataDir)) : path.join(root, 'data');
  const uploadDir = targetUploadDir ? path.resolve(String(targetUploadDir)) : path.join(dataDir, 'uploads');
  const markerPath = path.join(root, MIGRATION_MARKER);
  if (!repoServerDir && fs.existsSync(markerPath)) return { status: 'already-migrated', root };

  const targetDbFiles = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`].map((name) => path.join(dataDir, name));
  const targetLock = path.join(dataDir, 'relay-server.lock');
  // The same checkout once more (a repeated command, an alias): nothing to
  // do while the database it brought is still there.
  if (repoServerDir && pathTaken(targetDbFiles[0]) && wasMigratedFrom(root, repoServerDir)) {
    return { status: 'already-migrated', root, source: repoServerDir };
  }

  const sourceData = repoServerDir ? path.join(repoServerDir, 'data') : null;
  const sourceDb = sourceData ? path.join(sourceData, DB_FILE) : null;
  const sourceRepoConfig = repoServerDir ? path.join(repoServerDir, 'config.json') : null;
  const sourceManagedConfig = managedConfigDir ? path.join(managedConfigDir, 'config.json') : null;

  const lockPath = sourceData ? path.join(sourceData, 'relay-server.lock') : null;
  if (lockPath && fs.existsSync(lockPath)) {
    const pid = readLockPid(lockPath);
    if (pid && isProcessAliveImpl(pid)) {
      return {
        status: 'blocked-live-relay',
        root,
        pid,
        error: `A relay is still running (pid=${pid}, lock at ${lockPath}). Stop it, then run the migration again.`,
      };
    }
  }

  const hasDb = !!(sourceDb && fs.existsSync(sourceDb));
  const hasRepoConfig = !!(sourceRepoConfig && fs.existsSync(sourceRepoConfig));
  if (repoServerDir && !hasDb && !hasRepoConfig) {
    return { status: 'nothing-to-migrate', root, reason: `${repoServerDir} holds no database and no config.json` };
  }
  // Repo config wins over the legacy managed config when both exist.
  const configSource = hasRepoConfig
    ? sourceRepoConfig
    : (sourceManagedConfig && fs.existsSync(sourceManagedConfig) ? sourceManagedConfig : null);
  if (!hasDb && !configSource) {
    return { status: 'nothing-to-migrate', root, reason: 'no earlier relay state found' };
  }

  // A database already in the target is never overwritten or mixed with.
  // The one exception is the fresh, empty one the installer's relay creates
  // on its first start: it is moved into backups/. Whether it is fresh is
  // asked first (read-only), so a database with conversations is refused as
  // such and nobody is asked to stop a relay for a run that cannot happen.
  const existingDbFiles = () => targetDbFiles.filter((file) => pathTaken(file));
  const refusedWithConversations = () => ({
    status: 'refused-existing-database',
    root,
    error: `The state root already has a database with conversations (${targetDbFiles[0]}); `
      + `a migration never overwrites one. To bring ${repoServerDir} over instead: `
      + `stop the relay (oar stop), move ${dataDir} aside, then run the migration again.`,
  });
  if (hasDb && existingDbFiles().length) {
    if (!pathTaken(targetDbFiles[0])) {
      return {
        status: 'refused-existing-database',
        root,
        error: `The state root has database files without copilot.db (${existingDbFiles().join(', ')}); `
          + 'a migration never mixes a database with them. Move them aside, then run the migration again.',
      };
    }
    if (!isFreshDatabase(await loadDatabase(DatabaseImpl), targetDbFiles[0])) return refusedWithConversations();
  }

  const copied = [];
  const created = [];
  const kept = [];
  const skipped = [];
  // A run that moves or copies a database holds the relay's own lock for its
  // whole length (same file, same format), so no relay starts on the data
  // dir in between; a relay that holds it refuses the run.
  let guard = null;
  if (hasDb) {
    makeDir(dataDir, created);
    guard = createRelaySingletonGuard({
      lockPath: targetLock,
      pid: process.pid,
      token: '',
      now,
      isProcessAlive: isProcessAliveImpl,
      logger: {},
    });
    try {
      guard.acquire();
    } catch (error) {
      removeCreated(created);
      const pid = readLockPid(targetLock);
      if (!(pid && isProcessAliveImpl(pid))) throw error;
      return {
        status: 'refused-relay-running',
        root,
        pid,
        error: `A relay is running on ${dataDir} (pid=${pid}, lock at ${targetLock}): `
          + 'stop the relay first (oar stop), then run the migration again.',
      };
    }
    // Asked again under the lock: a relay that ran between the first look and
    // the lock may have written conversations into the database meanwhile.
    if (pathTaken(targetDbFiles[0]) && !isFreshDatabase(await loadDatabase(DatabaseImpl), targetDbFiles[0])) {
      try { guard.release(); } catch {}
      removeCreated(created);
      return refusedWithConversations();
    }
  }

  try {
    // The fresh database moved aside, and the backup folder made for it.
    const movedAside = [];
    const asideCreated = [];
    const asideDir = path.join(root, 'backups', String(now()).replace(/[:.]/g, '-'));
    let sourceCounts = null;
    try {
      // Listed again: reading the fresh database may have left a -shm beside it.
      const toMoveAside = hasDb ? existingDbFiles() : [];
      if (toMoveAside.length) {
        makeDir(asideDir, asideCreated);
        for (const file of toMoveAside) {
          const to = path.join(asideDir, path.basename(file));
          moveFile(file, to);
          movedAside.push({ from: file, to });
        }
      }
      if (hasDb) {
        const Database = await loadDatabase(DatabaseImpl);
        // Checkpoint first so recent writes leave the WAL, then copy all three
        // files anyway — a hot -wal must never be dropped on the floor.
        sourceCounts = readDbCounts(Database, sourceDb, { checkpoint: true });
        copyIfExists(sourceDb, targetDbFiles[0], copied, created, skipped);
        copyIfExists(`${sourceDb}-wal`, targetDbFiles[1], copied, created, skipped);
        copyIfExists(`${sourceDb}-shm`, targetDbFiles[2], copied, created, skipped);
        copyIfExists(path.join(sourceData, 'cursor-agents'), path.join(dataDir, 'cursor-agents'), copied, created, skipped);
      }

      const configTarget = path.join(root, 'config.json');
      if (configSource && pathTaken(configTarget)) kept.push(configTarget);
      else copyIfExists(configSource, configTarget, copied, created, skipped);

      if (repoServerDir) {
        copyIfExists(path.join(repoServerDir, 'uploads'), uploadDir, copied, created, skipped);
        const repoLogs = path.join(repoServerDir, 'logs');
        if (fs.existsSync(repoLogs) && directorySizeBytes(repoLogs) <= MAX_LOGS_BYTES) {
          copyIfExists(repoLogs, path.join(root, 'logs'), copied, created, skipped);
        }
      }
      if (managedConfigDir) {
        const managedLogs = path.join(managedConfigDir, 'logs');
        if (fs.existsSync(managedLogs) && directorySizeBytes(managedLogs) <= MAX_LOGS_BYTES) {
          copyIfExists(managedLogs, path.join(root, 'logs'), copied, created, skipped);
        }
      }

      if (hasDb) {
        const Database = await loadDatabase(DatabaseImpl);
        const targetCounts = readDbCounts(Database, targetDbFiles[0]);
        const mismatch = targetCounts.integrity !== 'ok'
          || targetCounts.conversations !== sourceCounts.conversations
          || targetCounts.messages !== sourceCounts.messages;
        if (mismatch) {
          throw new Error(
            `Migrated database failed verification (integrity=${targetCounts.integrity}, `
            + `conversations ${targetCounts.conversations} vs ${sourceCounts.conversations}, `
            + `messages ${targetCounts.messages} vs ${sourceCounts.messages}).`,
          );
        }
      }
    } catch (error) {
      // Take back only what this run added and put a database it moved aside
      // back: the state root is as before, the marker was never written, the
      // source never touched. A database that cannot be put back (a locked
      // file) stays in its backup folder, and the error says where.
      removeCreated(created);
      let restored = true;
      for (const { from, to } of [...movedAside].reverse()) {
        try { moveFile(to, from); } catch { restored = false; }
      }
      if (restored) {
        removeCreated(asideCreated);
        throw error;
      }
      throw new Error(
        `${error?.message || error} The database moved aside could not be put back; it is kept in ${asideDir}.`,
        { cause: error },
      );
    }

    if (!copied.length) {
      removeCreated(created);
      return {
        status: 'nothing-to-migrate',
        root,
        kept,
        reason: kept.length ? `kept the existing ${kept.join(', ')}` : 'nothing new to copy',
      };
    }

    const backupsDir = path.join(root, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const receipt = [
      '# OAR state migration',
      '',
      `- when: ${now()}`,
      `${RECEIPT_SOURCE_LINE}${repoServerDir || '(none)'}`,
      `- managed config dir: ${managedConfigDir || '(none)'}`,
      ...(sourceCounts
        ? [`- verified: integrity ok, ${sourceCounts.conversations} conversations, ${sourceCounts.messages} messages`]
        : ['- verified: no database in source']),
      '',
      'Copied (sources left untouched — delete them manually once satisfied):',
      ...copied.map((c) => `- ${c.from} -> ${c.to} (${c.bytes} bytes)`),
      ...(kept.length ? ['', 'Kept (already there, not overwritten):', ...kept.map((k) => `- ${k}`)] : []),
      ...(skipped.length
        ? ['', 'Skipped (links, not copied — what they point to is not in the state root):', ...skipped.map((k) => `- ${k}`)]
        : []),
      ...(movedAside.length
        ? ['', 'Moved aside (a fresh database without conversations):', ...movedAside.map((m) => `- ${m.from} -> ${m.to}`)]
        : []),
      '',
    ].join('\n');
    // A later explicit migration adds its receipt below the earlier one.
    const receiptPath = path.join(backupsDir, 'MIGRATION.md');
    fs.appendFileSync(receiptPath, fs.existsSync(receiptPath) ? `\n${receipt}` : receipt);
    fs.appendFileSync(markerPath, `${now()} migrated${repoServerDir ? ` from ${repoServerDir}` : ''}\n`);

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(root, 0o700);
        const configTarget = path.join(root, 'config.json');
        if (fs.existsSync(configTarget)) fs.chmodSync(configTarget, 0o600);
      } catch {}
    }

    return {
      status: 'migrated',
      root,
      copied: copied.length,
      kept,
      skipped,
      movedAsideTo: movedAside.length ? asideDir : null,
      counts: sourceCounts,
    };
  } finally {
    try { guard?.release(); } catch {}
  }
}

/**
 * Earlier releases copied a checkout's uploads to `<root>/uploads`, which no
 * relay reads. When the relay's data dir sits in a state root an earlier
 * migration marked, and its uploads are that data dir's `uploads/`, those
 * blobs are merged in at start: content-addressed, so a file already there is
 * never overwritten, and the old folder is never deleted (the log says it can
 * be). Returns how many files were added.
 */
export function mergeStrayMigratedUploads({ dataDir, uploadDir, logger = console } = {}) {
  if (!dataDir || !uploadDir) return 0;
  const resolvedDataDir = path.resolve(String(dataDir));
  if (path.resolve(String(uploadDir)) !== path.join(resolvedDataDir, 'uploads')) return 0;
  const root = path.dirname(resolvedDataDir);
  const stray = path.join(root, 'uploads');
  if (!fs.existsSync(path.join(root, MIGRATION_MARKER)) || !fs.existsSync(stray)) return 0;
  const created = [];
  const skipped = [];
  try {
    copyNew(stray, path.resolve(String(uploadDir)), created, skipped);
  } catch (error) {
    logger.warn?.(`[uploads] Could not merge ${stray} into ${uploadDir}: ${error?.message || error}`);
  }
  const added = created.filter((entry) => {
    try { return fs.statSync(entry).isFile(); } catch { return false; }
  }).length;
  if (added) {
    logger.log?.(`[uploads] Merged ${added} upload(s) an earlier migration left in ${stray} into ${uploadDir}; the files in ${stray} are kept and still read.`);
  }
  return added;
}
