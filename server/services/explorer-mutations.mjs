// Filesystem changes made from the explorer: create a folder, rename an
// entry, delete an entry, and count what a delete would remove. The callers
// (the routes) have already resolved the absolute target inside a browsable
// root; this module only touches the filesystem and turns its errors into
// `{ error, statusCode }` answers the routes can send as they are.
//
// Symbolic links are refused everywhere. The listings skip them, so the user
// never saw one in the explorer, and a rename or delete through a link would
// act on something outside the folder they are looking at.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

export const DEFAULT_COUNT_CAP = 10000;

function failure(error, fallback, statusCode = 500) {
  const code = String(error?.code || '');
  if (code === 'ENOENT' || code === 'ENOTDIR') return { error: 'Not found', statusCode: 404 };
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return { error: 'That name is already taken', statusCode: 409 };
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return { error: 'Permission denied', statusCode: 403 };
  return { error: error?.message || fallback, statusCode };
}

function lstatOrNull(fs, target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Create `target`; missing parents are created with it. */
export function createDirectory(target, { fs = fsDefault } = {}) {
  try {
    if (lstatOrNull(fs, target)) return { error: 'That name is already taken', statusCode: 409 };
    fs.mkdirSync(target, { recursive: true });
    return { ok: true };
  } catch (error) {
    return failure(error, 'Failed to create the folder');
  }
}

/**
 * Rename `target` to `newName` inside its own parent. A name that differs
 * only in case is allowed: on a case-insensitive filesystem the destination
 * stat finds the source itself, which is not a collision.
 */
export function renameEntry(target, newName, { fs = fsDefault, path = pathDefault } = {}) {
  const destination = path.join(path.dirname(target), newName);
  try {
    const source = lstatOrNull(fs, target);
    if (!source) return { error: 'Not found', statusCode: 404 };
    if (source.isSymbolicLink()) return { error: 'Links cannot be changed here', statusCode: 409 };
    if (destination === target) return { ok: true, path: destination };
    const existing = lstatOrNull(fs, destination);
    const sameEntry = existing && existing.ino === source.ino && existing.dev === source.dev && existing.ino !== 0;
    if (existing && !sameEntry) return { error: 'That name is already taken', statusCode: 409 };
    fs.renameSync(target, destination);
    return { ok: true, path: destination };
  } catch (error) {
    return failure(error, 'Failed to rename');
  }
}

/** Remove `target`; a folder goes with everything inside it. */
export function removeEntry(target, { fs = fsDefault } = {}) {
  try {
    const stat = lstatOrNull(fs, target);
    if (!stat) return { error: 'Not found', statusCode: 404 };
    if (stat.isSymbolicLink()) return { error: 'Links cannot be changed here', statusCode: 409 };
    fs.rmSync(target, { recursive: true, force: false, maxRetries: 2 });
    return { ok: true };
  } catch (error) {
    return failure(error, 'Failed to delete');
  }
}

/**
 * What a delete of `target` would remove: `{ kind, files, dirs, capped }`.
 * `dirs` excludes the target itself. The walk stops once `files + dirs`
 * reaches `cap`, so a huge tree answers quickly with `capped: true`. Links
 * inside count as files and are not followed.
 */
export function countEntries(target, { fs = fsDefault, path = pathDefault, cap = DEFAULT_COUNT_CAP } = {}) {
  let stat = null;
  try {
    stat = lstatOrNull(fs, target);
  } catch (error) {
    return failure(error, 'Failed to read the entry');
  }
  if (!stat) return { error: 'Not found', statusCode: 404 };
  if (stat.isSymbolicLink()) return { error: 'Links cannot be changed here', statusCode: 409 };
  if (!stat.isDirectory()) return { ok: true, kind: 'file', files: 0, dirs: 0, capped: false };

  let files = 0;
  let dirs = 0;
  let capped = false;
  const stack = [target];
  while (stack.length && !capped) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // an unreadable branch is still removed by rm; it just stays uncounted
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        dirs += 1;
        stack.push(path.join(dir, entry.name));
      } else {
        files += 1;
      }
      if (files + dirs >= cap) {
        capped = true;
        break;
      }
    }
  }
  return { ok: true, kind: 'dir', files, dirs, capped };
}
