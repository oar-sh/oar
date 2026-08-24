// Defeat symlink escapes on the raw file-serve / preview path.
//
// The lexical checks in resolveWorkspaceFilePath (path.resolve + path.relative)
// only prove the *string* stays under the workspace root. A symlink inside the
// workspace — e.g. an AI worker running `ln -s /etc/passwd creds` — passes that
// check but resolves to a real path outside the root, and fs.createReadStream /
// fs.statSync follow it. The directory/tree walkers already reject symlinks with
// lstat; this makes the serve path match, by resolving the real path (of the
// deepest existing ancestor for not-yet-created files) and re-checking containment.

import fsDefault from 'fs';
import pathDefault from 'path';

export function isRealPathWithinRoot(
  absolutePath,
  rootPath,
  { fs = fsDefault, path = pathDefault, platform = process.platform } = {},
) {
  const target0 = String(absolutePath || '');
  const root0 = String(rootPath || '');
  if (!target0 || !root0) return false;

  // Windows (and macOS by default) have case-insensitive filesystems, so compare
  // the resolved paths case-insensitively there. realpathSync already
  // canonicalizes both sides, but this defends against short (8.3) names and
  // subst/mapped drives that can resolve to differing case.
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const norm = (value) => (caseInsensitive ? String(value).toLowerCase() : String(value));

  let realRoot;
  try {
    realRoot = fs.realpathSync(root0);
  } catch {
    // The root itself doesn't resolve; the lexical check is the best we have.
    return true;
  }

  let target = path.resolve(target0);
  while (true) {
    try {
      const realTarget = fs.realpathSync(target);
      const a = norm(realTarget);
      const b = norm(realRoot);
      return a === b || a.startsWith(`${b}${path.sep}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
      // The path doesn't exist yet — check its nearest existing ancestor, so a
      // symlinked parent can't smuggle a not-yet-created file outside the root.
      const parent = path.dirname(target);
      if (parent === target) return false;
      target = parent;
    }
  }
}
