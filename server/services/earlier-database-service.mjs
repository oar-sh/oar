import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveDataDir, resolveUploadDir } from './data-dir-resolution.mjs';
import { resolveOarRoot } from './oar-state-migration-service.mjs';
import { resolveStateLayout } from './oar-state-layout.mjs';
import { defaultIsProcessAlive, lockHolderMayRun, processStartedAt as defaultProcessStartedAt } from './relay-singleton-guard.mjs';

const DB_FILE = 'copilot.db';
const DB_FILES = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`];
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
// The latest change a database records, per table: what tells which of two
// databases was used last.
const STAMPS = [
  ['conversations', 'updated_at'],
  ['messages', 'timestamp'],
  ['app_settings', 'updated_at'],
];
// Defender or the indexer may hold a file for a moment at boot.
const RENAME_RETRY_MS = [50, 100, 200, 400, 800];
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(fsImpl, from, to, sleep = sleepSync) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fsImpl.renameSync(from, to);
      return;
    } catch (error) {
      if (!RETRY_CODES.has(error?.code) || attempt >= RENAME_RETRY_MS.length) throw error;
      sleep(RENAME_RETRY_MS[attempt]);
    }
  }
}

// A quick_check report is many lines: the start and nothing more.
function oneLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
}

function parseStamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

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

function readDatabase(Database, dbPath, { readonly = false, singleFile = false, tick = () => {} } = {}) {
  const db = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
  try {
    const integrity = String(db.pragma('quick_check', { simple: true }) || '');
    const has = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    const stamps = {};
    const latest = {};
    for (const [table, column] of STAMPS) {
      // Parsed per row, not compared as text: a value that is no time tells nothing.
      let newest = null;
      let newestText = null;
      if (has(table)) {
        let rows = 0;
        for (const row of db.prepare(`SELECT ${column} AS value FROM ${table}`).iterate()) {
          if (++rows % 10000 === 0) tick();
          const ms = parseStamp(row.value);
          if (ms !== null && (newest === null || ms > newest)) { newest = ms; newestText = String(row.value); }
        }
      }
      stamps[table] = newest;
      latest[table] = newestText;
    }
    const count = (table) => (has(table) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n || 0) : 0);
    // The copy goes into place as one file: no -wal or -shm to move with it.
    if (singleFile && integrity === 'ok') db.pragma('journal_mode = DELETE');
    return { integrity, stamps, latest, conversations: count('conversations'), messages: count('messages') };
  } finally {
    db.close();
  }
}

// Which database has the later changes: 'earlier', 'pinned', 'same', or
// 'both' when each has a table the other changed less recently.
function newerOf(earlier, pinned) {
  let earlierNewer = 0;
  let pinnedNewer = 0;
  for (const [table] of STAMPS) {
    const a = earlier[table];
    const b = pinned ? pinned[table] : null;
    if (a !== null && (b === null || a > b)) earlierNewer += 1;
    if (b !== null && (a === null || b > a)) pinnedNewer += 1;
  }
  if (earlierNewer && pinnedNewer) return 'both';
  if (earlierNewer) return 'earlier';
  return pinnedNewer ? 'pinned' : 'same';
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
  const pinnedDb = path.join(dataDir, DB_FILE);
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const rename = (from, to) => renameWithRetry(fsImpl, from, to, sleep);

  // A swap a kill interrupted is finished first: its copy was checked
  // before the journal was written.
  const recovered = finishInterruptedSwap({ dataDir, fsImpl, rename, exists, logger });
  if (recovered?.status === 'refused') return recovered;

  const checkedFile = path.join(dataDir, CHECKED_FILE);
  const checked = readJson(fsImpl, checkedFile)?.sources || [];
  const signatureOf = (dbPath) => {
    const files = DB_FILES.map((name) => path.join(path.dirname(dbPath), name.replace(DB_FILE, path.basename(dbPath))));
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
    if (seen(signatureOf(path.join(dbDir, DB_FILE)))) continue;
    const rescue = { kind: 'rescue', dbDir, uploadDirs: [path.join(rescueRoot, name, 'uploads')], cursorDir: path.join(dbDir, 'cursor-agents') };
    if (exists(path.join(dbDir, DB_FILE))) candidates.push(rescue);
    else if (!readdir(fsImpl, dbDir).some((file) => file.startsWith(DB_FILE))) filesOnly.push(rescue);
  }
  // 2. Copies an interrupted run left, checked complete: possibly the only
  // one there is. They take the upload and Cursor folders of their source.
  let leftovers = [];
  try { leftovers = fsImpl.readdirSync(dataDir).filter((name) => name.startsWith(STAGING_PREFIX)).sort(); } catch {}
  for (const name of leftovers) {
    const dbDir = path.join(dataDir, name);
    if (!exists(path.join(dbDir, STAGED_CHECKED_FILE)) || !exists(path.join(dbDir, DB_FILE))) continue;
    if (seen(signatureOf(path.join(dbDir, DB_FILE)))) continue;
    const source = readJson(fsImpl, path.join(dbDir, STAGED_SOURCE_FILE)) || {};
    candidates.push({
      kind: 'leftover',
      dbDir,
      uploadDirs: Array.isArray(source.uploadDirs) ? source.uploadDirs : [],
      cursorDir: source.cursorDir || null,
    });
  }
  // 3. What the relay ran on without the pin (`server/data` or a config
  // `dataDir`, copied from, never renamed); never the pinned folder itself.
  const earlierDir = resolveDataDir({ env: unpinned, configPath, serverDir });
  const earlierDb = path.join(earlierDir, DB_FILE);
  if (normalize(earlierDir) !== normalize(dataDir) && exists(earlierDb) && !seen(signatureOf(earlierDb))) {
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
      candidates.push({ kind: 'earlier', dbDir: earlierDir, uploadDirs, cursorDir: path.join(earlierDir, 'cursor-agents'), lock });
    }
  }
  for (const candidate of filesOnly) {
    const filled = fillMissing({ candidate, dataDir, uploadDir, fsImpl, exists, normalize });
    // Looked at once it all came over; a failed copy is tried again.
    if (!filled.ok) continue;
    checked.push({ ...signatureOf(path.join(candidate.dbDir, DB_FILE)), outcome: 'files', at: now().toISOString() });
    try { writeJson(fsImpl, checkedFile, { sources: checked }); } catch {}
    logger.log?.(`[data] Copied ${filled.uploads} upload(s) and ${filled.cursorFiles} Cursor file(s) of ${path.dirname(candidate.dbDir)} where missing.`);
  }
  if (!candidates.length) return { status: filesOnly.length ? 'files' : 'no-earlier-database', from: earlierDir };

  const results = [];
  for (const [index, candidate] of candidates.entries()) {
    const sourceDb = path.join(candidate.dbDir, DB_FILE);
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
      pinnedDb,
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
    if (ours) try {
      for (const name of DB_FILES) {
        const from = path.join(candidate.dbDir, name);
        if (exists(from)) rename(from, path.join(candidate.dbDir, name.replace(DB_FILE, `${DB_FILE}.${suffix}`)));
      }
      renamedTo = path.join(candidate.dbDir, `${DB_FILE}.${suffix}`);
    } catch {}
    checked.push({ ...signature, outcome: result.status, at: now().toISOString(), latest: result.latest, renamedTo });
    try { writeJson(fsImpl, checkedFile, { sources: checked }); } catch {}
    if (result.status === 'adopted') {
      logger.log?.(
        `[data] Brought over the database this relay ran on until now, ${sourceDb} (${result.conversations} conversations, ${result.messages} messages), to ${pinnedDb}`
        + `${result.uploads ? ` with ${result.uploads} upload(s)` : ''}; the original is kept${renamedTo ? ` as ${renamedTo}` : ` at ${sourceDb}`}`
        + `${result.backupDir ? `, the older database that was there in ${result.backupDir}` : ''}.`,
      );
    } else {
      logger.log?.(`[data] ${sourceDb} is not newer than ${pinnedDb}; left it${renamedTo ? ` as ${renamedTo}` : ''}, not used.`);
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
  const staged = path.join(String(journal.stagingDir || ''), DB_FILE);
  try {
    if (exists(staged)) {
      // The copy is not in place yet: what is still in the data folder is
      // the pinned database, and goes where the journal put the rest of it.
      fsImpl.mkdirSync(journal.backupDir, { recursive: true });
      for (const name of DB_FILES) {
        if (exists(path.join(dataDir, name))) rename(path.join(dataDir, name), path.join(journal.backupDir, name));
      }
      rename(staged, path.join(dataDir, DB_FILE));
    } else if (!exists(path.join(dataDir, DB_FILE)) && exists(path.join(journal.backupDir, DB_FILE))) {
      // Neither the copy nor a database in place: the pinned one goes back.
      for (const name of DB_FILES) {
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
  candidate, stagingDir, backupDir, dataDir, uploadDir, pinnedDb, Database, fsImpl, rename, exists, lockMayRun, normalize, progress,
}) {
  const sourceDb = path.join(candidate.dbDir, DB_FILE);
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
    for (const name of DB_FILES) {
      if (exists(path.join(candidate.dbDir, name))) fsImpl.copyFileSync(path.join(candidate.dbDir, name), path.join(stagingDir, name));
    }
    // The copy, never the original: opening it applies its -wal.
    progress.step('check');
    earlier = readDatabase(Database, path.join(stagingDir, DB_FILE), { singleFile: true, tick: progress.tick });
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
  if (exists(pinnedDb)) {
    // Read through a copy as well: opening it, even read-only, would rebuild
    // its -shm, and a refused start must leave it as it was.
    const pinnedCopy = `${stagingDir}-pinned`;
    try {
      progress.step('pinned');
      fsImpl.mkdirSync(pinnedCopy, { recursive: true });
      for (const name of DB_FILES) {
        if (exists(path.join(dataDir, name))) fsImpl.copyFileSync(path.join(dataDir, name), path.join(pinnedCopy, name));
      }
      pinned = readDatabase(Database, path.join(pinnedCopy, DB_FILE), { tick: progress.tick });
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
    return refused('each database has changes newer than the other\'s. Move the copilot.db, copilot.db-wal and copilot.db-shm of the one not to go on with into a folder of your own, then start again.');
  }
  if (newer !== 'earlier') {
    removeStaging();
    return { status: 'kept', latest: earlier.latest };
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
    writeJson(fsImpl, journalPath, { stagingDir, backupDir, at: new Date().toISOString() });
    for (const name of DB_FILES) {
      if (!exists(path.join(dataDir, name))) continue;
      fsImpl.mkdirSync(backupDir, { recursive: true });
      rename(path.join(dataDir, name), path.join(backupDir, name));
      movedAside.push(name);
    }
    rename(path.join(stagingDir, DB_FILE), pinnedDb);
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
