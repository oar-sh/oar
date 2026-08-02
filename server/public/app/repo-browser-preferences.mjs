// Browser-persisted repo browser toolbar filters.
//
// Kept in its own module (rather than inline in store.js) so it stays free of
// `window`/`document` at module scope and can be unit-tested under plain node.
// Storage is reached only inside the functions, via an injectable accessor.

export const REPO_BROWSER_WORKSPACE_HIDDEN_STORAGE_KEY = 'copilot_repo_browser_hidden_workspace';
export const REPO_BROWSER_DRIVES_HIDDEN_STORAGE_KEY = 'copilot_repo_browser_hidden_drives';
export const REPO_BROWSER_WORKSPACE_HEAVY_STORAGE_KEY = 'copilot_repo_browser_heavy_workspace';

const TRUE_VALUES = new Set(['1', 'true', 'on', 'yes']);
const FALSE_VALUES = new Set(['0', 'false', 'off', 'no', '']);

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    // Storage access throws outright in some privacy modes.
    return null;
  }
}

export function normalizeStoredBooleanFlag(rawValue, fallback = false) {
  if (rawValue === null || rawValue === undefined) return fallback;
  const text = String(rawValue).trim().toLowerCase();
  if (TRUE_VALUES.has(text)) return true;
  if (FALSE_VALUES.has(text)) return false;
  return fallback;
}

export function readStoredBooleanFlag(key, { fallback = false, storage = defaultStorage() } = {}) {
  if (!storage) return fallback;
  try {
    return normalizeStoredBooleanFlag(storage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

export function writeStoredBooleanFlag(key, value, { storage = defaultStorage() } = {}) {
  if (!storage) return false;
  try {
    storage.setItem(key, value ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/**
 * Every filter defaults to off, so a fresh browser profile behaves exactly as
 * the pre-persistence build did.
 */
export function readRepoBrowserPreferences(storage = defaultStorage()) {
  return {
    workspaceIncludeHidden: readStoredBooleanFlag(REPO_BROWSER_WORKSPACE_HIDDEN_STORAGE_KEY, { storage }),
    drivesIncludeHidden: readStoredBooleanFlag(REPO_BROWSER_DRIVES_HIDDEN_STORAGE_KEY, { storage }),
    workspaceIncludeHeavy: readStoredBooleanFlag(REPO_BROWSER_WORKSPACE_HEAVY_STORAGE_KEY, { storage }),
  };
}

/**
 * The workspace root and the drives/session roots keep independent hidden-file
 * flags in state (the toolbar even labels them differently: "Hidden" vs
 * "Hidden/System"), so they persist under separate keys.
 */
export function repoBrowserHiddenStorageKeyForRoot(activeRoot) {
  return String(activeRoot || '').trim().toLowerCase() === 'workspace'
    ? REPO_BROWSER_WORKSPACE_HIDDEN_STORAGE_KEY
    : REPO_BROWSER_DRIVES_HIDDEN_STORAGE_KEY;
}

export function writeRepoBrowserHiddenPreference(activeRoot, value, storage = defaultStorage()) {
  return writeStoredBooleanFlag(repoBrowserHiddenStorageKeyForRoot(activeRoot), value, { storage });
}

export function writeRepoBrowserHeavyPreference(value, storage = defaultStorage()) {
  return writeStoredBooleanFlag(REPO_BROWSER_WORKSPACE_HEAVY_STORAGE_KEY, value, { storage });
}
