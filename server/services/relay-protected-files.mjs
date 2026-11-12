'use strict';

import fs from 'node:fs';
import path from 'node:path';

// The files no file route serves, changes, moves or deletes, whoever asks
// (the owner token, an agent token, a browser session, a file capability),
// nor any folder holding one of them: the relay's own secrets
// (relay-secrets.json, relay-previous.json, and the temporary file a write
// of them leaves, `.relay-secrets.json.<pid>.<hex>.tmp`), its database with
// its -wal, -shm and -journal files, and its config file. Database files
// anywhere under the data folder, the backup folder or the folders the
// earlier-database takeover uses count too (a copy under another name is
// still the database, a backup being written, `*.db.partial`, as well). A
// path is compared as given, after resolving symlinks (realpath), and by
// file identity (device and inode), so a link or a hard link to one of them
// is refused as well.

const SECRETS_NAME = /^\.?relay-(?:secrets|previous)\.json/i;
const DATABASE_NAME = /^(?:oar|copilot)\.db|\.db(?:-wal|-shm|-journal|\.partial)?$/i;
// Entries a folder walk looks at before it gives up (and counts the folder
// as holding a protected file).
const TREE_WALK_MAX = 20000;

function realOrResolved(target, fsImpl, pathImpl = path) {
  // The real path of the longest part that exists, the rest as written.
  let existing = pathImpl.resolve(String(target || ''));
  const rest = [];
  for (;;) {
    try {
      existing = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(existing) : fsImpl.realpathSync(existing);
      break;
    } catch {
      const parent = pathImpl.dirname(existing);
      if (parent === existing) break;
      rest.unshift(pathImpl.basename(existing));
      existing = parent;
    }
  }
  return pathImpl.join(existing, ...rest);
}

function identityOf(target, fsImpl) {
  try {
    const stat = fsImpl.statSync(target, { bigint: true });
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : '';
  } catch {
    return '';
  }
}

function within(child, parent, pathImpl = path) {
  if (!parent) return false;
  const relative = pathImpl.relative(parent, child);
  // `..x` is a name inside; only `..` itself or `../…` leaves.
  return !!relative && relative !== '..' && !relative.startsWith(`..${pathImpl.sep}`) && !pathImpl.isAbsolute(relative);
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.configPath
 * @param {() => string[]} [options.files]  further exact files (the database and its side files)
 * @param {() => string|null} [options.backupDir]  read on every check (the config may change it)
 * @param {() => string[]} [options.folders]  further folders whose database and secrets files count
 */
export function createProtectedRelayFiles({
  dataDir = '',
  configPath = '',
  files = () => [],
  backupDir = () => null,
  folders: moreFolders = () => [],
  fsImpl = fs,
  platform = process.platform,
} = {}) {
  // On Windows a path is compared case-insensitively, with either separator
  // and a drive letter of either case (`platform` is the relay's own; a test
  // injects 'win32' to run this half on any host).
  const pathImpl = platform === 'win32' ? path.win32 : path;
  const fold = (value) => (platform === 'win32' ? String(value).toLowerCase() : String(value));
  const resolved = (target) => pathImpl.resolve(target);
  const real = (target) => realOrResolved(target, fsImpl, pathImpl);

  function exactFiles() {
    const list = [configPath];
    if (dataDir) list.push(pathImpl.join(dataDir, 'relay-secrets.json'), pathImpl.join(dataDir, 'relay-previous.json'));
    let more = [];
    try { more = files() || []; } catch { more = []; }
    return [...list, ...more].filter(Boolean);
  }

  function folders() {
    let backups = null;
    try { backups = backupDir(); } catch { backups = null; }
    let more = [];
    try { more = moreFolders() || []; } catch { more = []; }
    return [dataDir, backups, ...more].filter(Boolean);
  }

  /** True when no file route may serve `filePath`. */
  function isProtected(filePath) {
    const raw = String(filePath || '');
    if (!raw) return false;
    const candidates = [...new Set([resolved(raw), real(raw)].map(fold))];
    const exact = exactFiles();
    const exactPaths = new Set(exact.flatMap((each) => [resolved(each), real(each)]).map(fold));
    if (candidates.some((candidate) => exactPaths.has(candidate))) return true;
    const roots = folders().flatMap((each) => [resolved(each), real(each)]).map(fold);
    for (const candidate of candidates) {
      const name = pathImpl.basename(candidate);
      if (!SECRETS_NAME.test(name) && !DATABASE_NAME.test(name)) continue;
      if (roots.some((root) => within(candidate, root, pathImpl))) return true;
    }
    // A hard link (or a link the paths above did not catch) is the same file.
    const identity = identityOf(raw, fsImpl);
    if (identity) {
      for (const each of exact) {
        if (identityOf(each, fsImpl) === identity) return true;
      }
    }
    return false;
  }

  /**
   * True when a folder at `dirPath` holds one of those files, so deleting,
   * renaming or moving it would take them along: one of the exact files, the
   * data folder or the backup folder lies inside it (or is it), or it lies
   * inside the data or backup folder and has a secrets or database file
   * somewhere below it. Symlinks below it are not followed; a tree too big to
   * walk counts as holding one.
   */
  function containsProtected(dirPath) {
    const raw = String(dirPath || '');
    if (!raw) return false;
    const candidates = [...new Set([resolved(raw), real(raw)].map(fold))];
    const roots = folders().flatMap((each) => [resolved(each), real(each)]).map(fold);
    const anchors = [
      ...exactFiles().flatMap((each) => [resolved(each), real(each)]).map(fold),
      ...roots,
    ];
    if (anchors.some((anchor) => candidates.some((candidate) => anchor === candidate || within(anchor, candidate, pathImpl)))) return true;
    if (!candidates.some((candidate) => roots.some((root) => within(candidate, root, pathImpl)))) return false;
    return treeHasProtectedName(real(raw));
  }

  function treeHasProtectedName(top) {
    const stack = [top];
    let seen = 0;
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fsImpl.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // not a folder (or unreadable): nothing to walk
      }
      for (const entry of entries) {
        seen += 1;
        if (seen > TREE_WALK_MAX) return true;
        if (SECRETS_NAME.test(entry.name) || DATABASE_NAME.test(entry.name)) return true;
        if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(pathImpl.join(dir, entry.name));
      }
    }
    return false;
  }

  /** True when no file route may read, change, move or delete `target` (a file or a folder). */
  function touchesProtected(target) {
    return isProtected(target) || containsProtected(target);
  }

  return { isProtected, containsProtected, touchesProtected };
}
