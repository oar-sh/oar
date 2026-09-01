// Joining the workspace root with a tree-relative path for launch-CWD use
// (repo browser → known-CWD lists / CWD pickers). Pure module so the separator
// inference is unit-testable under plain node.

/**
 * A root is Windows-style when it starts with a drive letter or already
 * contains a backslash. Only then is the join done with `\` — a POSIX root
 * (`/home/...`) keeps `/`, which is what the relay host actually resolves.
 */
export function isWindowsStyleRoot(basePath) {
  const root = String(basePath || '').trim();
  return /^[A-Za-z]:/.test(root) || root.includes('\\');
}

export function joinLaunchCwdPath(basePath, relativePath) {
  const root = String(basePath || '').trim().replace(/[\\/]+$/, '');
  const relRaw = String(relativePath || '').trim().replace(/^[\\/]+/, '');
  const windowsStyle = isWindowsStyleRoot(root);
  const rel = windowsStyle ? relRaw.replace(/\//g, '\\') : relRaw.replace(/\\/g, '/');
  if (!root) return rel;
  if (!rel) return root;
  return `${root}${windowsStyle ? '\\' : '/'}${rel}`;
}
