/**
 * One-time migration of relay state into the OAR state root (~/.oar).
 *
 * Global npm installs cannot keep state under the package directory — `npm i -g`
 * replaces the tree on every update, database included. This service copies the
 * old state (a git-checkout's server/ tree, and/or the legacy managed config
 * dir) into the state root exactly once, guarded by a marker file.
 *
 * Contract (docs/plans/oar-rebrand-and-release.md §5.2):
 *  - refuse to run while a relay holds the source lock (live pid);
 *  - checkpoint the WAL before copying, then copy db + -wal + -shm together;
 *  - copy, never move — the source stays untouched as the rollback path;
 *  - verify integrity and row counts before writing the marker;
 *  - on any mismatch remove the partial target and leave the marker unwritten.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

function copyIfExists(source, target, copied) {
  if (!source || !fs.existsSync(source)) return false;
  const stat = fs.statSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat.isDirectory()) fs.cpSync(source, target, { recursive: true });
  else fs.copyFileSync(source, target);
  copied.push({ from: source, to: target, bytes: stat.isDirectory() ? directorySizeBytes(source) : stat.size });
  return true;
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

/**
 * Returns { status, ... } — statuses: 'already-migrated', 'blocked-live-relay',
 * 'nothing-to-migrate', 'migrated'. Throws only on verification failure or an
 * unexpected copy error, after removing the partial target state.
 */
export async function migrateStateToOarRoot({
  targetRoot,
  repoServerDir = null,
  managedConfigDir = null,
  isProcessAliveImpl = defaultIsProcessAlive,
  DatabaseImpl = null,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  const root = path.resolve(String(targetRoot || ''));
  if (!root) throw new Error('targetRoot is required');
  const markerPath = path.join(root, MIGRATION_MARKER);
  if (fs.existsSync(markerPath)) return { status: 'already-migrated', root };

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
  const hasAnyConfig = !!((sourceRepoConfig && fs.existsSync(sourceRepoConfig))
    || (sourceManagedConfig && fs.existsSync(sourceManagedConfig)));
  if (!hasDb && !hasAnyConfig) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(markerPath, `${now()} nothing-to-migrate\n`);
    return { status: 'nothing-to-migrate', root };
  }

  const copied = [];
  let sourceCounts = null;
  try {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });

    if (hasDb) {
      const Database = await loadDatabase(DatabaseImpl);
      // Checkpoint first so recent writes leave the WAL, then copy all three
      // files anyway — a hot -wal must never be dropped on the floor.
      sourceCounts = readDbCounts(Database, sourceDb, { checkpoint: true });
      copyIfExists(sourceDb, path.join(root, 'data', DB_FILE), copied);
      copyIfExists(`${sourceDb}-wal`, path.join(root, 'data', `${DB_FILE}-wal`), copied);
      copyIfExists(`${sourceDb}-shm`, path.join(root, 'data', `${DB_FILE}-shm`), copied);
      copyIfExists(path.join(sourceData, 'cursor-agents'), path.join(root, 'data', 'cursor-agents'), copied);
    }

    // Repo config wins over the legacy managed config when both exist.
    const configSource = (sourceRepoConfig && fs.existsSync(sourceRepoConfig))
      ? sourceRepoConfig
      : sourceManagedConfig;
    copyIfExists(configSource, path.join(root, 'config.json'), copied);

    if (repoServerDir) {
      copyIfExists(path.join(repoServerDir, 'uploads'), path.join(root, 'uploads'), copied);
      const repoLogs = path.join(repoServerDir, 'logs');
      if (fs.existsSync(repoLogs) && directorySizeBytes(repoLogs) <= MAX_LOGS_BYTES) {
        copyIfExists(repoLogs, path.join(root, 'logs'), copied);
      }
    }
    if (managedConfigDir) {
      const managedLogs = path.join(managedConfigDir, 'logs');
      if (fs.existsSync(managedLogs) && directorySizeBytes(managedLogs) <= MAX_LOGS_BYTES) {
        copyIfExists(managedLogs, path.join(root, 'logs'), copied);
      }
    }

    if (hasDb) {
      const Database = await loadDatabase(DatabaseImpl);
      const targetCounts = readDbCounts(Database, path.join(root, 'data', DB_FILE));
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
    // Leave no partial target behind: the marker was never written, so the next
    // attempt starts clean; the source was never touched.
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    throw error;
  }

  const backupsDir = path.join(root, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const receipt = [
    '# OAR state migration',
    '',
    `- when: ${now()}`,
    `- repo server dir: ${repoServerDir || '(none)'}`,
    `- managed config dir: ${managedConfigDir || '(none)'}`,
    ...(sourceCounts
      ? [`- verified: integrity ok, ${sourceCounts.conversations} conversations, ${sourceCounts.messages} messages`]
      : ['- verified: no database in source']),
    '',
    'Copied (sources left untouched — delete them manually once satisfied):',
    ...copied.map((c) => `- ${c.from} -> ${c.to} (${c.bytes} bytes)`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(backupsDir, 'MIGRATION.md'), receipt);
  fs.writeFileSync(markerPath, `${now()} migrated\n`);

  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(root, 0o700);
      const configTarget = path.join(root, 'config.json');
      if (fs.existsSync(configTarget)) fs.chmodSync(configTarget, 0o600);
    } catch {}
  }

  logger.log?.(`[oar] Migrated relay state into ${root} (${copied.length} items; sources untouched).`);
  return { status: 'migrated', root, copied: copied.length, counts: sourceCounts };
}
