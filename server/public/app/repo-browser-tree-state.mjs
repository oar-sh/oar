// Pure helpers for keeping the repo browser's tree expansion alive across a
// refetch (hidden/heavy toggle, Refresh button).
//
// The tree the server returns is lazy: `/api/repo/tree` ships the root plus its
// direct children only, every dir child marked `lazy: true, childrenLoaded:
// false`. So restoring expansion is not just a matter of keeping the
// `expandedPaths` Set — each still-open branch has to be re-fetched, parent
// first, before it can render as anything other than "Expand to load entries…".

export const REPO_REHYDRATE_MAX_PATHS = 24;

/**
 * Root-first ancestor chain for a repo browser path, always including the
 * synthetic root `''` and the path itself.
 *
 *   ''            -> ['']
 *   'a/b/c'       -> ['', 'a', 'a/b', 'a/b/c']
 *   '/home/s/x'   -> ['', '/', '/home', '/home/s', '/home/s/x']
 *   'C:/Users/x'  -> ['', 'C:', 'C:/Users', 'C:/Users/x']
 *
 * Windows drive paths fall out of the relative branch unchanged — they are not
 * special-cased, matching the walks this replaces.
 */
export function repoAncestorPaths(pathValue) {
  const value = String(pathValue ?? '').trim();
  if (!value) return [''];
  const absolute = value.startsWith('/');
  const chain = absolute ? ['', '/'] : [''];
  if (value === '/') return chain;
  const parts = value.split('/').filter(Boolean);
  let rolling = '';
  for (const part of parts) {
    rolling = rolling ? `${rolling}/${part}` : (absolute ? `/${part}` : part);
    chain.push(rolling);
  }
  return chain;
}

/**
 * Deepest ancestor of `pathValue` (inclusive) that still resolves to a
 * directory, falling back to `''` when the whole branch is gone. This is what
 * makes turning hidden files back off safe: the dotfile directory the user was
 * sitting in simply vanishes from the refetched tree.
 */
export function deepestExistingAncestor(pathValue, hasDirPath) {
  const chain = repoAncestorPaths(pathValue);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index];
    if (candidate === '') return '';
    if (typeof hasDirPath === 'function' && hasDirPath(candidate)) return candidate;
  }
  return '';
}

/**
 * Ordered list of directories to re-fetch after a refresh, parents always
 * before children (the caller walks it sequentially — `ensureRepoChildrenLoaded`
 * rebuilds `nodeMap` on each success, and a child is only reachable once its
 * parent's children have landed).
 *
 * Tier 1 — the current path's ancestor chain — is never capped: it is the
 * correctness fix and is bounded by directory depth anyway. Tier 2 — other
 * previously-expanded branches — is capped, and an expanded path whose parent
 * did not make the plan is dropped along with its descendants. That is exact
 * rather than heuristic: `renderRepoTreeNode` only descends into loaded
 * `children`, so such a node renders the lazy placeholder no matter what
 * `expandedPaths` says. Overflow degrades to today's behaviour (placeholder,
 * one click to load), never to breakage.
 */
export function planRepoRehydration({
  currentPath = '',
  expandedPaths = [],
  maxPaths = REPO_REHYDRATE_MAX_PATHS,
} = {}) {
  const plan = repoAncestorPaths(currentPath);
  const planned = new Set(plan);

  const candidates = [...new Set(
    (Array.isArray(expandedPaths) ? expandedPaths : [...expandedPaths])
      .map((value) => String(value ?? '').trim())
      .filter((value) => !!value && !planned.has(value)),
  )];
  candidates.sort((left, right) => {
    const depthDelta = repoAncestorPaths(left).length - repoAncestorPaths(right).length;
    return depthDelta !== 0 ? depthDelta : left.localeCompare(right);
  });

  for (const candidate of candidates) {
    if (plan.length >= maxPaths) break;
    const chain = repoAncestorPaths(candidate);
    const parent = chain.length >= 2 ? chain[chain.length - 2] : '';
    if (!planned.has(parent)) continue;
    plan.push(candidate);
    planned.add(candidate);
  }
  return plan;
}
