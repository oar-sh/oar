// Path arithmetic for the explorer's edits (new folder, rename, delete), on
// the path forms the explorer already uses: workspace paths are relative and
// `/`-joined with `''` for the root; drive paths are absolute (`/x/y` or
// `C:/x/y`, `C:` for a drive root). Pure, so it runs under node in tests.

/** The name part of a path. */
export function entryNameOf(pathValue) {
  const value = String(pathValue || '');
  const trimmed = value.endsWith('/') && value.length > 1 ? value.slice(0, -1) : value;
  const index = trimmed.lastIndexOf('/');
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** The parent of a path: `''` above a top-level workspace entry or a drive root, `/` above `/x`. */
export function parentPathOf(pathValue) {
  const value = String(pathValue || '');
  const index = value.lastIndexOf('/');
  if (index === -1) return '';
  if (index === 0) return '/';
  return value.slice(0, index);
}

/** The path of `name` inside `parentPath`. */
export function childPathOf(parentPath, name) {
  const parent = String(parentPath || '');
  const child = String(name || '');
  if (!parent) return child;
  return parent.endsWith('/') ? `${parent}${child}` : `${parent}/${child}`;
}

/** True when `pathValue` is `prefix` or lies below it. */
export function isSameOrBelow(pathValue, prefix) {
  const value = String(pathValue || '');
  const base = String(prefix || '');
  if (value === base) return true;
  if (!base) return value !== '';
  return value.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/** `pathValue` with `oldPrefix` replaced by `newPrefix` when it lies at or below it; otherwise unchanged. */
export function rewritePathPrefix(pathValue, oldPrefix, newPrefix) {
  const value = String(pathValue || '');
  if (!isSameOrBelow(value, oldPrefix) || oldPrefix === '') return value;
  return `${newPrefix}${value.slice(String(oldPrefix).length)}`;
}

/** A new Set with every member rewritten through `rewritePathPrefix`. */
export function rewritePathSet(paths, oldPrefix, newPrefix) {
  const out = new Set();
  for (const value of paths || []) out.add(rewritePathPrefix(value, oldPrefix, newPrefix));
  return out;
}

/** A new Set without the members at or below `prefix`. */
export function dropPathsBelow(paths, prefix) {
  const out = new Set();
  for (const value of paths || []) {
    if (prefix === '' || !isSameOrBelow(value, prefix)) out.add(value);
  }
  return out;
}

/** The descendants of `dirPath` among `paths`, shallowest first, for a re-expansion walk. */
export function descendantsOf(paths, dirPath) {
  return [...(paths || [])]
    .filter((value) => value && value !== dirPath && isSameOrBelow(value, dirPath))
    .sort((a, b) => a.length - b.length);
}
