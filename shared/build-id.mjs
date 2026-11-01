import fs from 'node:fs';
import path from 'node:path';

// The build id names the code a process runs, so the relay can tell a session
// worker that started on older code from one that runs what the relay runs.
//
// It is `${version}+${commit.slice(0, 12)}` when both are known, the version
// alone when there is no commit, and null when there is no version either. The
// commit is part of it because on a git checkout a deploy is a new
// commit at the same version; on an npm install without a `gitHead` stamp the
// version alone decides.
//
// The relay and every worker compute it once at process start and never read
// it again, so a tree that moved on under a running process still describes
// the code that process started with.
//
// This module lives in shared/ because both the relay and the workers import
// it; it depends on nothing beyond node:fs and node:path for the same reason.

const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const COMMIT_ID_LENGTH = 12;

// The relay stores the build id a worker states, so what it accepts is bounded
// in length and limited to the characters a version and a commit use.
const BUILD_ID_MAX_LENGTH = 80;
const BUILD_ID_PATTERN = /^[A-Za-z0-9+._-]+$/;

function readFileText(fsImpl, filePath) {
  try {
    return String(fsImpl.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readPackageManifest(packageRoot, { fsImpl, pathImpl }) {
  if (!packageRoot) return null;
  try {
    const manifest = JSON.parse(readFileText(fsImpl, pathImpl.join(packageRoot, 'package.json')) || '');
    return manifest && typeof manifest === 'object' ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * The commit a git checkout has checked out, read from its .git files rather
 * than from a `git` process: HEAD, then the loose ref, then packed-refs. A
 * linked worktree's .git is a file naming its git dir, whose refs live in the
 * common dir. Anything unexpected reads as null. `pathImpl` is the host's path
 * module; tests pass path.posix and path.win32.
 */
export function readGitCommit(root, { fsImpl = fs, pathImpl = path } = {}) {
  if (!root) return null;
  const dotGit = pathImpl.join(root, '.git');
  let gitDir = dotGit;
  const pointer = readFileText(fsImpl, dotGit);
  if (pointer !== null) {
    const match = pointer.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    gitDir = pathImpl.resolve(root, match[1].trim());
  }
  const head = readFileText(fsImpl, pathImpl.join(gitDir, 'HEAD'));
  if (head === null) return null;
  const headText = head.trim();
  if (COMMIT_PATTERN.test(headText)) return headText.toLowerCase();
  const refMatch = headText.match(/^ref:\s*(\S+)$/);
  if (!refMatch) return null;
  const ref = refMatch[1];
  const commonDirText = readFileText(fsImpl, pathImpl.join(gitDir, 'commondir'));
  const commonDir = commonDirText ? pathImpl.resolve(gitDir, commonDirText.trim()) : gitDir;
  for (const dir of new Set([gitDir, commonDir])) {
    const loose = readFileText(fsImpl, pathImpl.join(dir, ...ref.split('/')));
    if (loose && COMMIT_PATTERN.test(loose.trim())) return loose.trim().toLowerCase();
  }
  const packed = readFileText(fsImpl, pathImpl.join(commonDir, 'packed-refs')) || '';
  for (const line of packed.split(/\r?\n/)) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === ref && COMMIT_PATTERN.test(hash || '')) return hash.toLowerCase();
  }
  return null;
}

/** The commit this build came from: the checkout's HEAD, else a `gitHead` stamp in package.json. */
export function resolveBuildCommit(packageRoot, { fsImpl = fs, pathImpl = path } = {}) {
  const fromGit = readGitCommit(packageRoot, { fsImpl, pathImpl });
  if (fromGit) return fromGit;
  const stamp = String(readPackageManifest(packageRoot, { fsImpl, pathImpl })?.gitHead || '').trim();
  return COMMIT_PATTERN.test(stamp) ? stamp.toLowerCase() : null;
}

/** The package.json `version`, or null when the manifest cannot be read or names none. */
export function readPackageVersion(packageRoot, { fsImpl = fs, pathImpl = path } = {}) {
  const version = readPackageManifest(packageRoot, { fsImpl, pathImpl })?.version;
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

/**
 * The build id of the tree at `packageRoot`: `{ version, commit, id }`. Call it
 * once at process start and keep the result; see the header for why.
 */
export function resolveBuildId(packageRoot, { fsImpl = fs, pathImpl = path } = {}) {
  const version = readPackageVersion(packageRoot, { fsImpl, pathImpl });
  const commit = resolveBuildCommit(packageRoot, { fsImpl, pathImpl });
  let id = null;
  if (version && commit) id = `${version}+${commit.slice(0, COMMIT_ID_LENGTH)}`;
  else if (version) id = version;
  return { version, commit, id };
}

/**
 * True only when both ids are known and differ. An unknown id on either side
 * is not evidence of a change, so it never reads as one.
 */
export function buildIdsDiffer(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = a.trim();
  const right = b.trim();
  return !!left && !!right && left !== right;
}

/** A stated build id, trimmed, or null when it is too long or carries other characters. */
export function normalizeBuildId(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > BUILD_ID_MAX_LENGTH || !BUILD_ID_PATTERN.test(text)) return null;
  return text;
}
