/**
 * The relay database's file name, the one place that spells it. New
 * databases are `oar.db`; installs from before 0.9.20 run on `copilot.db`
 * until their owner renames it by hand. The relay never renames a database
 * it runs on: it only sets aside a `copilot.db` that is not newer than an
 * `oar.db` beside it (settleDatabaseFile), never deleting anything.
 *
 * Also here, shared with earlier-database-service: reading a database for
 * its latest changes (readDatabase, newerOf) and the rename that waits out
 * Windows' brief file locks (renameWithRetry).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const DB_FILE_NAME = 'oar.db';
export const LEGACY_DB_FILE_NAME = 'copilot.db';
// In the order the resolver prefers them.
export const DB_FILE_NAMES = [DB_FILE_NAME, LEGACY_DB_FILE_NAME];
// Where settleDatabaseFile reads both databases through copies; never the
// earlier-database service's `.earlier-database-` (a leftover candidate there).
const CHECK_DIR_PREFIX = '.database-file-check-';

// "Downgrade and rollback": an earlier version started on a folder
// whose database is oar.db creates an empty copilot.db and runs on it; with
// nothing done there, the next start sets it aside. "Nothing done" is no
// one's work, not no rows: every start writes these settings (seen on a
// real start of 0.9.19 on an empty folder). A later boot-time key goes here
// deliberately; any other key makes the start refuse.
export const STARTUP_SETTING_KEYS = Object.freeze(['push_vapid_public_key', 'push_vapid_private_key', 'relay_last_exit']);
// And the tables such a start fills that hold no one's work: the model
// catalog and its refresh state, the restart orchestrator's one row. (The
// shadow tables of the message search are left out too: they follow
// messages.) Any other table with a row makes the start refuse.
export const STARTUP_TABLES = Object.freeze(['model_variants', 'model_selector_state', 'relay_restart_orchestrator']);

/** A database's files: the main file, its -wal and its -shm. */
export function sideFiles(name) {
  return [name, `${name}-wal`, `${name}-shm`];
}

// The latest change a database records, per table: what tells which of two
// databases was used last.
const STAMPS = [
  ['conversations', 'updated_at'],
  ['messages', 'timestamp'],
  ['app_settings', 'updated_at'],
];
// Defender or the indexer may hold a file for a moment at boot.
const RENAME_RETRY_MS = [50, 100, 200, 400, 800];
// What Windows answers for a file another program holds for a moment.
export const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function renameWithRetry(fsImpl, from, to, sleep = sleepSync) {
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
export function oneLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 200);
}

/**
 * Whether a database holds only what a start writes (STARTUP_SETTING_KEYS,
 * STARTUP_TABLES): no conversation, message or other row of anyone's work.
 * Anything it cannot read says no.
 */
export function holdsStartupOnly(Database, dbPath) {
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
    const virtual = tables.filter((table) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql || '')).map((table) => table.name);
    for (const { name } of tables) {
      if (name.startsWith('sqlite_') || STARTUP_TABLES.includes(name)) continue;
      if (virtual.some((table) => name === table || name.startsWith(`${table}_`))) continue;
      if (name === 'app_settings') {
        if (db.prepare('SELECT key FROM app_settings').all().some((row) => !STARTUP_SETTING_KEYS.includes(row.key))) return false;
        continue;
      }
      if (db.prepare(`SELECT 1 FROM "${name.replace(/"/g, '""')}" LIMIT 1`).get()) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

function parseStamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

export function readDatabase(Database, dbPath, { readonly = false, singleFile = false, tick = () => {} } = {}) {
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
export function newerOf(earlier, pinned) {
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

// 'absent', 'present', or 'dangling' (a symlink to nothing: opening it
// would create a database where it points).
function fileState(fsImpl, file) {
  let link;
  try { link = fsImpl.lstatSync(file); } catch { return 'absent'; }
  if (!link.isSymbolicLink()) return 'present';
  try { fsImpl.statSync(file); return 'present'; } catch { return 'dangling'; }
}

/**
 * The database file of a data folder: `oar.db` if it is there, else
 * `copilot.db` if it is, else a new `oar.db` (`created`). `both` when the
 * two are there (settleDatabaseFile decides at start). Also what is odd:
 * `dangling` symlinks named like a database, and `orphans`, a -wal or -shm
 * whose database is not there (a rename by hand that missed it). Read
 * only: never creates or opens anything.
 */
export function resolveDatabaseFile(dataDir, { fsImpl = fs } = {}) {
  const dir = String(dataDir || '');
  const states = Object.fromEntries(DB_FILE_NAMES.map((name) => [name, fileState(fsImpl, path.join(dir, name))]));
  const found = DB_FILE_NAMES.filter((name) => states[name] !== 'absent');
  const name = found[0] || DB_FILE_NAME;
  const orphans = [];
  for (const each of DB_FILE_NAMES) {
    if (states[each] !== 'absent') continue;
    for (const side of sideFiles(each).slice(1)) {
      if (fileState(fsImpl, path.join(dir, side)) !== 'absent') orphans.push(path.join(dir, side));
    }
  }
  return {
    path: path.join(dir, name),
    name,
    legacy: name === LEGACY_DB_FILE_NAME,
    both: found.length === DB_FILE_NAMES.length,
    created: !found.length,
    dangling: DB_FILE_NAMES.filter((each) => states[each] === 'dangling').map((each) => path.join(dir, each)),
    orphans,
  };
}

/**
 * What a start must not go on with, from resolveDatabaseFile's answer:
 * `refusal` (a line, exit 78) for a database name that is a link to
 * nothing, or an `oar.db-wal`/`-shm` without `oar.db` (whatever name the
 * relay runs on): a database renamed to `oar.db` later, or a new one, would
 * take that -wal's pages in, and rows written since would be lost without a
 * trace. `warnings` for the other strays (a `copilot.db-wal` without its
 * database), which nothing deletes.
 */
export function checkDatabaseFile(file) {
  const dir = path.dirname(file.path);
  if (file.dangling.length) {
    return {
      refusal: `[data] Not starting: ${file.dangling.join(', ')} is a link to a file that is not there; a new database would be created where it points. Fix or remove the link, then start again.`,
      warnings: [],
    };
  }
  const current = path.join(dir, DB_FILE_NAME);
  const strayCurrent = file.orphans.filter((orphan) => path.basename(orphan).startsWith(`${DB_FILE_NAME}-`));
  if (strayCurrent.length) {
    return {
      refusal: `[data] Not starting: ${strayCurrent.join(' and ')} ${strayCurrent.length > 1 ? 'are' : 'is'} there without ${current}. `
        + `A database renamed to ${DB_FILE_NAME} (or a new one) would take those pages in, and the rows written since would be lost. `
        + `Move ${strayCurrent.length > 1 ? 'them' : 'it'} into a folder of your own (${strayCurrent.length > 1 ? 'they are' : 'it is'} not part of ${file.created ? 'any database here' : file.path}), then start again.`,
      warnings: [],
    };
  }
  return {
    refusal: null,
    warnings: file.orphans.map((orphan) => `[data] WARNING: ${orphan} is there without its database; it is not used. `
      + `If ${path.basename(orphan).replace(/-(wal|shm)$/, '')} was renamed by hand without it, its latest changes may be in that file. `
      + 'Nothing deletes it; move it away before anything is renamed to that name.'),
  };
}

/**
 * The database a script run by hand works on when given no path: the one
 * the relay in `<serverDir>/data` runs on. Throws when there is none, so a
 * script never creates an empty database.
 */
export function defaultCliDbPath(serverDir, { fsImpl = fs } = {}) {
  const dataDir = path.join(String(serverDir || ''), 'data');
  const file = resolveDatabaseFile(dataDir, { fsImpl });
  if (file.created || file.dangling.length) {
    throw new Error(`No database in ${dataDir} (neither ${DB_FILE_NAME} nor ${LEGACY_DB_FILE_NAME}); pass the path of the database to work on.`);
  }
  return file.path;
}

/**
 * The database a script run by hand works on (the migrations, the DeepSeek
 * import): the path it was given, which must be a database file, else
 * defaultCliDbPath of the server folder (a path, or a file: URL such as
 * `new URL('..', import.meta.url)`). Throws rather than let a script
 * create an empty database.
 */
export function cliDbPath(given, serverDir, { fsImpl = fs } = {}) {
  if (!given) return defaultCliDbPath(serverDir instanceof URL ? fileURLToPath(serverDir) : serverDir, { fsImpl });
  const file = path.resolve(String(given));
  let isFile = false;
  try { isFile = fsImpl.statSync(file).isFile(); } catch {}
  if (!isFile) throw new Error(`No database at ${file}; a script never creates one.`);
  return file;
}

/**
 * Renames a database (`name` in `dir`) with its -wal and -shm to
 * `<name>.<suffix>` (`-2`, `-3` … when taken; nothing is renamed over a
 * file), never deleting anything. Everything of it goes into its main file
 * first (a checkpoint that must complete), then the side files move and the
 * main file last: a kill in between leaves no -wal without its database.
 * A failed rename puts back what moved. `{ ok, renamedTo }`, or `{ ok:
 * false, reason, stuck }` naming files that could not be put back.
 */
export function setAsideDatabase({ dir, name, suffix, Database, rename, fsImpl = fs }) {
  const exists = (target) => fileState(fsImpl, target) !== 'absent';
  try {
    const db = new Database(path.join(dir, name), { fileMustExist: true });
    try {
      const [result] = db.pragma('wal_checkpoint(TRUNCATE)');
      // Another reader keeps frames in the -wal: they would move apart from it.
      if (result && Number(result.busy) !== 0) return { ok: false, reason: 'another program has it open, so its -wal could not be emptied', stuck: [] };
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, reason: error?.message || String(error), stuck: [] };
  }
  let base = `${name}.${suffix}`;
  for (let n = 2; sideFiles(base).some((each) => exists(path.join(dir, each))); n += 1) base = `${name}.${suffix}-${n}`;
  const [main, ...sides] = sideFiles(name);
  const [baseMain, ...baseSides] = sideFiles(base);
  const moves = [...sides.map((each, index) => [each, baseSides[index]]), [main, baseMain]]
    .map(([from, to]) => [path.join(dir, from), path.join(dir, to)])
    .filter(([from]) => exists(from));
  const done = [];
  try {
    for (const [from, to] of moves) {
      rename(from, to);
      done.push([from, to]);
    }
  } catch (error) {
    const stuck = [];
    for (const [from, to] of done.reverse()) {
      try { rename(to, from); } catch { stuck.push(`${from} is now ${to}`); }
    }
    return { ok: false, reason: error?.message || String(error), stuck };
  }
  return { ok: true, renamedTo: path.join(dir, baseMain) };
}

function removeCheckDirs(fsImpl, dataDir) {
  let names = [];
  try { names = fsImpl.readdirSync(dataDir); } catch {}
  for (const name of names) {
    if (name.startsWith(CHECK_DIR_PREFIX)) {
      try { fsImpl.rmSync(path.join(dataDir, name), { recursive: true, force: true }); } catch {}
    }
  }
}

/**
 * Before the database opens, under the relay's lock, when `oar.db` and
 * `copilot.db` are both in the data folder (after a downgrade that skipped
 * the rename back, or a stray file): both are read through copies (opening
 * either, even read-only, would rebuild its -shm). `copilot.db` not newer,
 * or empty: it and its -wal/-shm are renamed to `copilot.db.older-<time>`,
 * never deleted, and the relay goes on with `oar.db` (`set-aside`).
 * `copilot.db` newer, each newer somewhere, a failed copy or check:
 * nothing changes, the relay stops (`refused`, with `error`).
 */
export function settleDatabaseFile({
  dataDir,
  Database,
  now = () => new Date(),
  clock = Date.now,
  pid = process.pid,
  progressFile = null,
  fsImpl = fs,
  sleep = sleepSync,
  rename = (from, to) => renameWithRetry(fsImpl, from, to, sleep),
  logger = console,
} = {}) {
  const file = resolveDatabaseFile(dataDir, { fsImpl });
  // Copies a kill left: only ever copies.
  removeCheckDirs(fsImpl, dataDir);
  if (!file.both) return { status: file.created ? 'none' : 'single', path: file.path };

  const current = path.join(dataDir, DB_FILE_NAME);
  const legacy = path.join(dataDir, LEGACY_DB_FILE_NAME);
  const filesOf = (name) => sideFiles(name).join(', ');
  const moveOne = `To go on with ${DB_FILE_NAME}, move ${filesOf(LEGACY_DB_FILE_NAME)} into a folder of your own; `
    + `to go on with ${LEGACY_DB_FILE_NAME}, move ${filesOf(DB_FILE_NAME)}. Then start again.`;
  const refused = (reason) => ({
    status: 'refused',
    error: `[data] Not starting: ${reason} Both ${legacy} and ${current} are there; nothing was changed in either.`,
  });
  const exists = (target) => fileState(fsImpl, target) !== 'absent';
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const checkDir = path.join(dataDir, `${CHECK_DIR_PREFIX}${stamp}`);
  const bytes = DB_FILE_NAMES.flatMap(sideFiles).reduce((sum, name) => {
    try { return sum + fsImpl.statSync(path.join(dataDir, name)).size; } catch { return sum; }
  }, 0);
  const started = clock();
  let saidAt = started;
  const tick = () => {
    const at = clock();
    if (at - saidAt < 60_000) return;
    saidAt = at;
    logger.log?.(`[data] Still comparing ${legacy} with ${current}: ${Math.round((at - started) / 1000)} s so far.`);
  };
  logger.log?.(`[data] ${current} and ${legacy} are both there: comparing them (${Math.max(1, Math.round(bytes / 1048576))} MB); this can take a few minutes.`);
  if (progressFile) {
    try { fsImpl.writeFileSync(progressFile, `${JSON.stringify({ pid, task: 'compare', from: legacy, bytes, at: new Date(started).toISOString() }, null, 2)}\n`); } catch {}
  }
  const read = {};
  let startupOnly = false;
  try {
    for (const name of DB_FILE_NAMES) {
      const copyDir = path.join(checkDir, name);
      fsImpl.mkdirSync(copyDir, { recursive: true });
      for (const side of sideFiles(name)) {
        if (exists(path.join(dataDir, side))) fsImpl.copyFileSync(path.join(dataDir, side), path.join(copyDir, side));
      }
      read[name] = readDatabase(Database, path.join(copyDir, name), { tick });
    }
    startupOnly = read[LEGACY_DB_FILE_NAME].integrity === 'ok'
      && holdsStartupOnly(Database, path.join(checkDir, LEGACY_DB_FILE_NAME, LEGACY_DB_FILE_NAME));
  } catch (error) {
    return refused(`the two databases could not be copied and read (${error?.message || error}).`);
  } finally {
    try { fsImpl.rmSync(checkDir, { recursive: true, force: true }); } catch {}
    if (progressFile) try { fsImpl.rmSync(progressFile, { force: true }); } catch {}
  }
  for (const name of DB_FILE_NAMES) {
    if (read[name].integrity !== 'ok') return refused(`${path.join(dataDir, name)} failed its check (${oneLine(read[name].integrity)}).`);
  }
  // What an earlier version's start alone wrote is no newer work, whatever
  // its times say.
  const newer = startupOnly ? 'pinned' : newerOf(read[LEGACY_DB_FILE_NAME].stamps, read[DB_FILE_NAME].stamps);
  if (newer === 'earlier') return refused(`${legacy} has changes newer than ${current}. ${moveOne}`);
  if (newer === 'both') return refused(`each of ${legacy} and ${current} has changes newer than the other's. ${moveOne}`);

  const aside = setAsideDatabase({ dir: dataDir, name: LEGACY_DB_FILE_NAME, suffix: `older-${stamp}`, Database, rename, fsImpl });
  if (!aside.ok) {
    return {
      status: 'refused',
      error: `[data] Not starting: ${legacy} could not be set aside (${aside.reason}); `
        + (aside.stuck.length ? `moving it back failed too: ${aside.stuck.join('; ')}. ` : 'it is back as it was. ')
        + `The relay runs on ${current} once ${legacy} is moved into a folder of your own.`,
    };
  }
  const { renamedTo } = aside;
  logger.log?.(startupOnly
    ? `[data] ${legacy} holds start-up settings only and no chats (an earlier version started on this folder): set it aside as ${renamedTo}; the relay runs on ${current}.`
    : `[data] ${legacy} is not newer than ${current}: set it aside as ${renamedTo}; the relay runs on ${current}.`);
  return { status: 'set-aside', path: current, renamedTo, startupOnly };
}
