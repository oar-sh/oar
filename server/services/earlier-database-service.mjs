import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveDataDir, resolveUploadDir } from './data-dir-resolution.mjs';
import {
  DB_FILE_NAMES, LEGACY_DB_FILE_NAME, newerOf, oneLine, readDatabase, renameWithRetry, resolveDatabaseFile, setAsideDatabase, sideFiles, sleepSync,
} from './database-file.mjs';
import { resolveOarRoot } from './oar-state-migration-service.mjs';
import { resolveStateLayout } from './oar-state-layout.mjs';
import { defaultIsProcessAlive, lockHolderMayRun, processStartedAt as defaultProcessStartedAt } from './relay-singleton-guard.mjs';

const SHA256_NAME = /^[a-f0-9]{64}$/;
// The install-time rescue's copies (package-data-rescue.mjs), in the data folder.
export const RESCUE_DIR_NAME = 'rescued-package-data';
// What was looked at already: never offered again unless it changed.
export const CHECKED_FILE = 'earlier-databases.json';
// Written before the pinned database moves aside, removed once the copy is
// in place: a start after a kill in between finishes the swap.
export const SWAP_JOURNAL_FILE = 'earlier-database-swap.json';
// While a database is brought over, with the relay's pid: `oar start` tells
// a relay busy with it from one that did not come up.
export const TAKEOVER_PROGRESS_FILE = 'earlier-database-progress.json';
const STAGING_PREFIX = '.earlier-database-';
// In a staged copy: written once the copy passed its check, so a copy a
// kill cut short is never taken for one; and where it came from.
const STAGED_CHECKED_FILE = '.checked';
const STAGED_SOURCE_FILE = 'source.json';

// Read and compared here and when both database names are in one folder.
export { newerOf, readDatabase };

function hashToken(value) {
  const token = String(value || '').trim();
  return token ? crypto.createHash('sha256').update(token).digest('hex') : '';
}

function readJson(fsImpl, file) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readdir(fsImpl, dir) {
  try { return fsImpl.readdirSync(dir); } catch { return []; }
}

function writeJson(fsImpl, file, value) {
  const temporary = `${file}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameWithRetry(fsImpl, temporary, file);
}

/**
 * Before the database opens, under the relay's lock: the databases a relay
 * pinned to the state root's data folder may have run on until now (the one
 * resolveDataDir picks without the pin, i.e. `server/data` in the package;
 * the install-time rescue copies; a copy an interrupted run left) are each
 * looked at once. Newer than the pinned one: copied in after a quick_check
 * of a copy (never the original), the pinned one to `backups/<time>/`
 * (`adopted`). As new or older: nothing changes (`kept`). Undecidable (each
 * newer somewhere, a relay that may still run on it, a failed copy or
 * check): nothing changes, the relay stops with `error` (`refused`). Each
 * one looked at is recorded in earlier-databases.json and renamed in place
 * (`.adopted-`/`.older-`), never deleted; the swap is journalled.
 *
 * Left alone: a checkout (a pinned folder there is deliberate), a relay on
 * other folders, and the package's database for another state root unless
 * the earlier lock carries this relay's token. A config `dataDir` is only
 * copied from, never renamed. Copied, not pinned in place: the next
 * `npm i -g` deletes the package.
 */
export function adoptEarlierDatabase(options = {}) {
  const fsImpl = options.fsImpl || fs;
  try {
    return adopt(options);
  } finally {
    try { fsImpl.rmSync(path.join(String(options.dataDir || ''), TAKEOVER_PROGRESS_FILE), { force: true }); } catch {}
  }
}

function adopt({
  dataDir,
  uploadDir,
  serverDir,
  configPath = '',
  packageRoot,
  Database,
  authToken = '',
  env = process.env,
  platform = process.platform,
  isProcessAlive = defaultIsProcessAlive,
  processStartedAt = (pid) => defaultProcessStartedAt(pid, { platform }),
  bootTime = Date.now() - os.uptime() * 1000,
  now = () => new Date(),
  clock = Date.now,
  pid = process.pid,
  logger = console,
  fsImpl = fs,
  sleep = sleepSync,
}) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ''));
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const exists = (file) => { try { return fsImpl.existsSync(file); } catch { return false; } };
  const layout = resolveStateLayout({ packageRoot, env, platform });
  if (layout.checkout) return { status: 'not-applicable', reason: 'checkout' };
  if (!layout.dataDir || normalize(dataDir) !== normalize(layout.dataDir)) {
    return { status: 'not-applicable', reason: 'own-folders' };
  }
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const rename = (from, to) => renameWithRetry(fsImpl, from, to, sleep);

  // A swap a kill interrupted is finished first: its copy was checked
  // before the journal was written.
  const recovered = finishInterruptedSwap({ dataDir, fsImpl, rename, exists, logger });
  if (recovered?.status === 'refused') return recovered;

  const checkedFile = path.join(dataDir, CHECKED_FILE);
  const checked = readJson(fsImpl, checkedFile)?.sources || [];
  // A folder's database under either name (oar.db first), or null.
  // A link to nothing is no database: skipped, as before 0.9.20.
  const dbNameIn = (dir) => {
    const file = resolveDatabaseFile(dir, { fsImpl });
    return file.created || file.dangling.length ? null : file.name;
  };
  const signatureOf = (dbPath) => {
    const files = sideFiles(path.basename(dbPath)).map((name) => path.join(path.dirname(dbPath), name));
    let size = 0;
    let mtimeMs = 0;
    for (const file of files) {
      try {
        const stat = fsImpl.statSync(file);
        size += stat.size;
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
      } catch {}
    }
    return { source: path.resolve(dbPath), size, mtimeMs };
  };
  const seen = (signature) => checked.some((entry) => normalize(entry.source) === normalize(signature.source)
    && entry.size === signature.size && entry.mtimeMs === signature.mtimeMs);

  const unpinned = { ...env };
  for (const key of Object.keys(unpinned)) if (key.toUpperCase() === 'COPILOT_WEB_RELAY_DATA_DIR') delete unpinned[key];
  const candidates = [];
  // 1. Every rescue copy not looked at yet, compared in turn: the newest wins.
  const rescueRoot = path.join(dataDir, RESCUE_DIR_NAME);
  let rescues = [];
  try { rescues = fsImpl.readdirSync(rescueRoot).sort(); } catch {}
  // One without a database (its package had only uploads or Cursor stores)
  // gives its files where missing, whichever database wins.
  const filesOnly = [];
  for (const name of rescues) {
    // A copy the rescue did not finish is not a rescue.
    if (name.endsWith('.partial')) continue;
    const dbDir = path.join(rescueRoot, name, 'data');
    const dbName = dbNameIn(dbDir);
    // One without a database is recorded under the name old packages had.
    const sourceDb = path.join(dbDir, dbName || LEGACY_DB_FILE_NAME);
    if (seen(signatureOf(sourceDb))) continue;
    const rescue = { kind: 'rescue', dbDir, dbName, sourceDb, uploadDirs: [path.join(rescueRoot, name, 'uploads')], cursorDir: path.join(dbDir, 'cursor-agents') };
    if (dbName) candidates.push(rescue);
    else if (!readdir(fsImpl, dbDir).some((file) => DB_FILE_NAMES.some((each) => file.startsWith(each)))) filesOnly.push(rescue);
  }
  // 2. Copies an interrupted run left, checked complete: possibly the only
  // one there is. They take the upload and Cursor folders of their source.
  let leftovers = [];
  try { leftovers = fsImpl.readdirSync(dataDir).filter((name) => name.startsWith(STAGING_PREFIX)).sort(); } catch {}
  for (const name of leftovers) {
    const dbDir = path.join(dataDir, name);
    const dbName = dbNameIn(dbDir);
    if (!exists(path.join(dbDir, STAGED_CHECKED_FILE)) || !dbName) continue;
    if (seen(signatureOf(path.join(dbDir, dbName)))) continue;
    const source = readJson(fsImpl, path.join(dbDir, STAGED_SOURCE_FILE)) || {};
    candidates.push({
      kind: 'leftover',
      dbDir,
      dbName,
      sourceDb: path.join(dbDir, dbName),
      uploadDirs: Array.isArray(source.uploadDirs) ? source.uploadDirs : [],
      cursorDir: source.cursorDir || null,
    });
  }
  // 3. What the relay ran on without the pin (`server/data` or a config
  // `dataDir`, copied from, never renamed); never the pinned folder itself.
  const earlierDir = resolveDataDir({ env: unpinned, configPath, serverDir });
  const earlierName = normalize(earlierDir) !== normalize(dataDir) ? dbNameIn(earlierDir) : null;
  const earlierDb = earlierName ? path.join(earlierDir, earlierName) : null;
  if (earlierDb && !seen(signatureOf(earlierDb))) {
    const lock = readJson(fsImpl, path.join(earlierDir, 'relay-server.lock'));
    const defaultRoot = resolveOarRoot({ ...env, OAR_STATE_ROOT: '' }, platform);
    const ownRoot = normalize(layout.root) === normalize(defaultRoot)
      || (!!lock?.tokenHash && lock.tokenHash === hashToken(authToken));
    if (ownRoot) {
      // 0.9.13 kept uploads in server/uploads whatever the data folder.
      const uploadDirs = [
        path.join(serverDir, 'uploads'),
        resolveUploadDir({ dataDir: earlierDir, env: unpinned, serverDir, platform }),
      ].filter((dir, index, all) => all.findIndex((other) => normalize(other) === normalize(dir)) === index);
      candidates.push({ kind: 'earlier', dbDir: earlierDir, dbName: earlierName, sourceDb: earlierDb, uploadDirs, cursorDir: path.join(earlierDir, 'cursor-agents'), lock });
    }
  }
  for (const candidate of filesOnly) {
    const filled = fillMissing({ candidate, dataDir, uploadDir, fsImpl, exists, normalize });
    // Looked at once it all came over; a failed copy is tried again.
    if (!filled.ok) continue;
    checked.push({ ...signatureOf(candidate.sourceDb), outcome: 'files', at: now().toISOString() });
    try { writeJson(fsImpl, checkedFile, { sources: checked }); } catch {}
    logger.log?.(`[data] Copied ${filled.uploads} upload(s) and ${filled.cursorFiles} Cursor file(s) of ${path.dirname(candidate.dbDir)} where missing.`);
  }
  if (!candidates.length) return { status: filesOnly.length ? 'files' : 'no-earlier-database', from: earlierDir };

  const results = [];
  for (const [index, candidate] of candidates.entries()) {
    const { sourceDb } = candidate;
    // Looked up per candidate: one adopted before may have placed it.
    const pinned = resolveDatabaseFile(dataDir, { fsImpl });
    const progress = trackProgress({
      sourceDb, bytes: signatureOf(sourceDb).size, pid, clock, logger,
      write: (value) => writeJson(fsImpl, path.join(dataDir, TAKEOVER_PROGRESS_FILE), value),
    });
    const result = considerCandidate({
      candidate,
      stagingDir: path.join(dataDir, `${STAGING_PREFIX}${stamp}-${index}`),
      backupDir: path.join(layout.root, 'backups', candidates.length > 1 ? `${stamp}-${index}` : stamp),
      dataDir,
      uploadDir,
      pinnedName: pinned.created ? null : pinned.name,
      Database,
      fsImpl,
      rename,
      exists,
      lockMayRun: (lock) => lockHolderMayRun({ lock, isProcessAlive, startedAtOf: processStartedAt, bootTime }),
      normalize,
      progress,
    });
    progress.done();
    if (result.status === 'refused') return result;
    // Whatever the outcome, the uploads and Cursor agent stores of every
    // database looked at are copied where missing: a start a kill cut short
    // may have taken the database over without them.
    const filled = fillMissing({ candidate, dataDir, uploadDir, fsImpl, exists, normalize });
    // Looked at: recorded; renamed only in our folders (package, rescue,
    // leftover), never in a user's.
    const signature = signatureOf(sourceDb);
    const suffix = `${result.status === 'adopted' ? 'adopted' : 'older'}-${stamp}`;
    const packageRoot = normalize(path.dirname(serverDir));
    const ours = candidate.kind !== 'earlier' || normalize(candidate.dbDir).startsWith(packageRoot + path.sep);
    let renamedTo = null;
    if (ours) {
      // Under its own name, `<name>.older-<time>` or `<name>.adopted-<time>`:
      // checkpointed, the -wal/-shm first and the main file last; a failure
      // leaves it where it was (it is looked at again only if it changes).
      const aside = setAsideDatabase({ dir: candidate.dbDir, name: candidate.dbName, suffix, Database, rename, fsImpl });
      if (aside.ok) renamedTo = aside.renamedTo;
    }
    checked.push({ ...signature, outcome: result.status, at: now().toISOString(), latest: result.latest, renamedTo });
    try { writeJson(fsImpl, checkedFile, { sources: checked }); } catch {}
    if (result.status === 'adopted') {
      logger.log?.(
        `[data] Brought over the database this relay ran on until now, ${sourceDb} (${result.conversations} conversations, ${result.messages} messages), to ${result.dbPath}`
        + `${result.uploads ? ` with ${result.uploads} upload(s)` : ''}; the original is kept${renamedTo ? ` as ${renamedTo}` : ` at ${sourceDb}`}`
        + `${result.backupDir ? `, the older database that was there in ${result.backupDir}` : ''}.`,
      );
    } else {
      logger.log?.(`[data] ${sourceDb} is not newer than ${result.dbPath}; left it${renamedTo ? ` as ${renamedTo}` : ''}, not used.`);
    }
    results.push({ ...result, from: candidate.dbDir, renamedTo, cursorFiles: filled.cursorFiles });
  }
  return results.filter((result) => result.status === 'adopted').at(-1) || results.at(-1);
}

// A large database takes minutes: said at the start with its size, then at
// least once a minute (between steps, every 10000 rows or each upload), and
// at the end with each step's time. `write` keeps the progress file.
function trackProgress({ sourceDb, bytes, pid, clock, logger, write }) {
  const started = clock();
  const spent = {};
  let step = null;
  let stepAt = started;
  let saidAt = started;
  const seconds = (ms) => Math.round(ms / 1000);
  const close = (at) => { if (step) spent[step] = (spent[step] || 0) + at - stepAt; };
  const tick = () => {
    const at = clock();
    if (at - saidAt < 60_000) return;
    saidAt = at;
    logger.log?.(`[data] Still bringing over ${sourceDb}: ${step}, ${seconds(at - started)} s so far.`);
  };
  return {
    tick,
    step(name) {
      const at = clock();
      if (!step && !Object.keys(spent).length) logger.log?.(`[data] Bringing over ${sourceDb} (${Math.max(1, Math.round(bytes / 1048576))} MB) if it is newer; this can take a few minutes.`);
      close(at);
      step = name;
      stepAt = at;
      try { write({ pid, from: sourceDb, bytes, step, at: new Date(at).toISOString() }); } catch {}
      tick();
    },
    done() {
      if (!step) return;
      const at = clock();
      close(at);
      step = null;
      logger.log?.(`[data] Looking at ${sourceDb} took ${seconds(at - started)} s (${Object.entries(spent).map(([name, ms]) => `${name} ${seconds(ms)} s`).join(', ')}).`);
    },
  };
}

/**
 * The line for a start that found an earlier launcher which did not pin the
 * data folder, but neither the package's database nor a copy of it: the
 * update may have deleted it. Said as a fact only with `evidence`
 * (packageDatabaseEvidence). Null when nothing needs saying.
 */
export function lostPackageDatabaseWarning({ unpinnedLaunchers = [], earlierDatabase = null, databaseCreated = false, evidence = false, serverDir, dbPath } = {}) {
  if (!unpinnedLaunchers.length) return null;
  const status = earlierDatabase?.status;
  if (status === 'adopted' || status === 'kept' || status === 'recovered' || status === 'files') return null;
  if (status !== 'no-earlier-database' && !databaseCreated) return null;
  const folder = path.join(String(serverDir || ''), 'data');
  return `[data] WARNING: an autostart launcher of an earlier version ${evidence ? 'ran' : 'may have run'} this relay on the database inside the installed package (${folder}), `
    + `and no copy of it was found: ${evidence ? '' : 'if it did, '}the update removed it with the old version. This relay runs on ${dbPath}. `
    + 'If you saved that folder, see "save your data before this update" in the upgrade notes (CHANGELOG.md).';
}

// The names npm gives a retired package folder: `.<name>-` and 8 letters or
// digits (@npmcli/arborist retire-path.js).
export function isRetiredName(entry, packageName) {
  return entry.length === packageName.length + 10 && entry.startsWith(`.${packageName}-`)
    && /^[A-Za-z0-9]{8}$/.test(entry.slice(packageName.length + 2));
}

/**
 * A trace that a relay ran inside the package: its `server/data` or
 * `server/logs` (other than this relay's own folders), or npm's retired
 * folder of the old package still holding `server/data`.
 */
export function packageDatabaseEvidence({ serverDir, ownDirs = [], fsImpl = fs, platform = process.platform } = {}) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ''));
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const own = new Set(ownDirs.filter(Boolean).map(normalize));
  const exists = (file) => { try { return fsImpl.existsSync(file); } catch { return false; } };
  if (['data', 'logs'].some((name) => !own.has(normalize(path.join(serverDir, name))) && exists(path.join(serverDir, name)))) return true;
  const packageRoot = path.dirname(path.resolve(String(serverDir || '')));
  const scope = path.dirname(packageRoot);
  const name = path.basename(packageRoot);
  let siblings = [];
  try { siblings = fsImpl.readdirSync(scope); } catch {}
  return siblings.some((entry) => isRetiredName(entry, name) && exists(path.join(scope, entry, 'server', 'data')));
}

function finishInterruptedSwap({ dataDir, fsImpl, rename, exists, logger }) {
  const journalPath = path.join(dataDir, SWAP_JOURNAL_FILE);
  const journal = readJson(fsImpl, journalPath);
  if (!journal) return null;
  // A journal 0.9.19 wrote has no name: its database had the name before 0.9.20.
  const dbName = journal.dbName || LEGACY_DB_FILE_NAME;
  const staged = path.join(String(journal.stagingDir || ''), dbName);
  try {
    if (exists(staged)) {
      // The copy is not in place yet: what is still in the data folder is
      // the pinned database, and goes where the journal put the rest of it.
      fsImpl.mkdirSync(journal.backupDir, { recursive: true });
      for (const name of sideFiles(dbName)) {
        if (exists(path.join(dataDir, name))) rename(path.join(dataDir, name), path.join(journal.backupDir, name));
      }
      rename(staged, path.join(dataDir, dbName));
    } else if (!exists(path.join(dataDir, dbName)) && exists(path.join(journal.backupDir, dbName))) {
      // Neither the copy nor a database in place: the pinned one goes back.
      for (const name of sideFiles(dbName)) {
        if (exists(path.join(journal.backupDir, name))) rename(path.join(journal.backupDir, name), path.join(dataDir, name));
      }
    }
    fsImpl.rmSync(journalPath, { force: true });
    try { fsImpl.rmSync(journal.stagingDir, { recursive: true, force: true }); } catch {}
    logger.log?.(`[data] Finished bringing over a database an interrupted start left half done; the database that was there is in ${journal.backupDir}.`);
    return { status: 'recovered' };
  } catch (error) {
    return {
      status: 'refused',
      error: `[data] Not starting: an interrupted swap of the database in ${dataDir} could not be finished (${error?.message || error}); `
        + `the checked copy is in ${journal.stagingDir} and the earlier database in ${journal.backupDir}.`,
    };
  }
}

function considerCandidate({
  candidate, stagingDir, backupDir, dataDir, uploadDir, pinnedName, Database, fsImpl, rename, exists, lockMayRun, normalize, progress,
}) {
  const { sourceDb } = candidate;
  // It takes the pinned database's name; with none there it keeps its own,
  // so a database under the name before 0.9.20 stays one an earlier version runs on.
  const dbName = pinnedName || candidate.dbName;
  const pinnedDb = path.join(dataDir, dbName);
  const refused = (reason) => ({
    status: 'refused',
    from: candidate.dbDir,
    error: `[data] Not starting: ${reason} The relay ran on ${sourceDb} until now and is pinned to ${pinnedDb}; nothing was changed in either.`,
  });
  if (candidate.lock && lockMayRun(candidate.lock)) {
    return refused(`a relay (pid ${candidate.lock.pid}) may still run on ${candidate.dbDir}; stop it, then start again.`);
  }
  const removeStaging = () => { try { fsImpl.rmSync(stagingDir, { recursive: true, force: true }); } catch {} };
  let earlier;
  try {
    progress.step('copy');
    fsImpl.mkdirSync(stagingDir, { recursive: true });
    // Staged under the name it goes in as, -wal and -shm with it.
    const stagedNames = sideFiles(dbName);
    for (const [i, name] of sideFiles(candidate.dbName).entries()) {
      if (exists(path.join(candidate.dbDir, name))) fsImpl.copyFileSync(path.join(candidate.dbDir, name), path.join(stagingDir, stagedNames[i]));
    }
    // The copy, never the original: opening it applies its -wal.
    progress.step('check');
    earlier = readDatabase(Database, path.join(stagingDir, dbName), { singleFile: true, tick: progress.tick });
  } catch (error) {
    removeStaging();
    return refused(`its database could not be copied and read (${error?.message || error}).`);
  }
  if (earlier.integrity !== 'ok') {
    removeStaging();
    return refused(`its database failed its check (${oneLine(earlier.integrity)}).`);
  }
  try {
    writeJson(fsImpl, path.join(stagingDir, STAGED_SOURCE_FILE), { dbDir: candidate.dbDir, uploadDirs: candidate.uploadDirs, cursorDir: candidate.cursorDir });
    fsImpl.writeFileSync(path.join(stagingDir, STAGED_CHECKED_FILE), '');
  } catch (error) {
    removeStaging();
    return refused(`its database could not be copied and read (${error?.message || error}).`);
  }
  let pinned = null;
  if (pinnedName) {
    // Read through a copy as well: opening it, even read-only, would rebuild
    // its -shm, and a refused start must leave it as it was.
    const pinnedCopy = `${stagingDir}-pinned`;
    try {
      progress.step('pinned');
      fsImpl.mkdirSync(pinnedCopy, { recursive: true });
      for (const name of sideFiles(dbName)) {
        if (exists(path.join(dataDir, name))) fsImpl.copyFileSync(path.join(dataDir, name), path.join(pinnedCopy, name));
      }
      pinned = readDatabase(Database, path.join(pinnedCopy, dbName), { tick: progress.tick });
    } catch (error) {
      removeStaging();
      return refused(`the pinned database could not be read (${error?.message || error}).`);
    } finally {
      try { fsImpl.rmSync(pinnedCopy, { recursive: true, force: true }); } catch {}
    }
    if (pinned.integrity !== 'ok') {
      removeStaging();
      return refused(`the pinned database failed its check (${oneLine(pinned.integrity)}).`);
    }
  }
  const newer = newerOf(earlier.stamps, pinned?.stamps);
  if (newer === 'both') {
    removeStaging();
    return refused(`each database has changes newer than the other's. Move the files of the one not to go on with (${sideFiles(candidate.dbName).join(', ')} in ${candidate.dbDir}, or ${sideFiles(dbName).join(', ')} in ${dataDir}) into a folder of your own, then start again.`);
  }
  if (newer !== 'earlier') {
    removeStaging();
    return { status: 'kept', dbPath: pinnedDb, latest: earlier.latest };
  }

  // Uploads first: the database about to come over refers to them.
  // Content-addressed, so a file already there is the same file and stays.
  const addedUploads = [];
  const takeBackUploads = () => { for (const file of addedUploads) { try { fsImpl.rmSync(file, { force: true }); } catch {} } };
  try {
    progress.step('uploads');
    copyUploads({ from: candidate.uploadDirs, uploadDir, added: addedUploads, fsImpl, exists, normalize, tick: progress.tick });
    // Everything of the pinned database into its main file, so it moves as
    // one: no row left behind in a -wal that moves separately.
    if (pinned) {
      const db = new Database(pinnedDb, { fileMustExist: true });
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    }
  } catch (error) {
    takeBackUploads();
    removeStaging();
    return refused(`it could not be brought over (${error?.message || error}).`);
  }

  const journalPath = path.join(dataDir, SWAP_JOURNAL_FILE);
  const movedAside = [];
  try {
    progress.step('swap');
    writeJson(fsImpl, journalPath, { stagingDir, backupDir, dbName, at: new Date().toISOString() });
    for (const name of sideFiles(dbName)) {
      if (!exists(path.join(dataDir, name))) continue;
      fsImpl.mkdirSync(backupDir, { recursive: true });
      rename(path.join(dataDir, name), path.join(backupDir, name));
      movedAside.push(name);
    }
    rename(path.join(stagingDir, dbName), pinnedDb);
  } catch (error) {
    // Back as it was. Only the pinned files this run moved go back; the copy
    // is still in staging, so nothing of it is in the data folder.
    let restored = true;
    for (const name of movedAside) {
      try { rename(path.join(backupDir, name), path.join(dataDir, name)); } catch { restored = false; }
    }
    if (!restored) {
      // The journal stays: the next start finishes the swap with the copy.
      return refused(`it could not be brought over (${error?.message || error}); the next start finishes it from ${stagingDir}.`);
    }
    try { fsImpl.rmSync(journalPath, { force: true }); } catch {}
    takeBackUploads();
    removeStaging();
    return refused(`it could not be brought over (${error?.message || error}).`);
  }
  try { fsImpl.rmSync(journalPath, { force: true }); } catch {}
  // Only what is left beside the copy that moved out: no copy of anything.
  removeStaging();

  return {
    status: 'adopted',
    dbPath: pinnedDb,
    backupDir: movedAside.length ? backupDir : null,
    uploads: addedUploads.length,
    conversations: earlier.conversations,
    messages: earlier.messages,
    latest: earlier.latest,
  };
}

// Content-addressed uploads, never over one there; added ones go into `added`.
function copyUploads({ from, uploadDir, added, fsImpl, exists, normalize, tick = () => {} }) {
  for (const dir of from || []) {
    if (normalize(dir) === normalize(uploadDir) || !exists(dir)) continue;
    fsImpl.mkdirSync(uploadDir, { recursive: true });
    for (const name of fsImpl.readdirSync(dir)) {
      if (!SHA256_NAME.test(name) || exists(path.join(uploadDir, name))) continue;
      fsImpl.copyFileSync(path.join(dir, name), path.join(uploadDir, name), fs.constants.COPYFILE_EXCL);
      added.push(path.join(uploadDir, name));
      tick();
    }
  }
}

// Its uploads and Cursor stores, where the pinned folder lacks them.
function fillMissing({ candidate, dataDir, uploadDir, fsImpl, exists, normalize }) {
  let cursorFiles = 0;
  let ok = true;
  const added = [];
  try { copyUploads({ from: candidate.uploadDirs, uploadDir, added, fsImpl, exists, normalize }); } catch { ok = false; }
  if (candidate.cursorDir && exists(candidate.cursorDir)) {
    try { cursorFiles = copyMissing(fsImpl, candidate.cursorDir, path.join(dataDir, 'cursor-agents')); } catch { ok = false; }
  }
  return { cursorFiles, uploads: added.length, ok };
}

/** A folder's files copied into another, never over one there; returns how many. */
export function copyMissing(fsImpl, from, to) {
  let copied = 0;
  fsImpl.mkdirSync(to, { recursive: true });
  for (const entry of fsImpl.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copied += copyMissing(fsImpl, source, target);
    else if (entry.isFile() && !fsImpl.existsSync(target)) {
      fsImpl.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      copied += 1;
    }
  }
  return copied;
}
