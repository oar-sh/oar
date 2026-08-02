import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Workspace-root path policy
//
// The canonical home for CWD path normalization and for the *strict* validation
// applied to the REST endpoints that let a client choose a session's launch
// directory. Deliberately separate from server-runtime's lenient
// normalizeWorkspaceRootPath(), which must keep accepting whatever a CLI
// reports about itself.
// ---------------------------------------------------------------------------

// Characters rejected outright. Mirrors parseCdCommandTarget in workspace-root.mjs
// so the REST endpoints are no laxer than the chat `cd` command.
const REJECTED_PATH_CHARS = /[;&|\0\r\n]/;

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * "D:" -> "D:\". Without the trailing separator, path.resolve("D:") returns the
 * process's remembered per-drive CWD rather than the drive root.
 *
 * This is the canonical copy; server-runtime.mjs, workspace-root.mjs and
 * drives-path-helpers.mjs all delegate here. The browser has its own copy in
 * public/app/cwd-picker.js because server/ modules are not served to the client.
 */
export function normalizeDriveLetterOnlyPath(value) {
  const stripped = String(value ?? '').trim();
  if (/^[A-Za-z]:$/.test(stripped)) return `${stripped}\\`;
  return stripped;
}

/**
 * A comparison key for two paths that name the same directory.
 * Windows is case-insensitive across every segment, not just the drive letter,
 * so the whole string folds there. POSIX paths are left alone.
 */
export function normalizeWorkspaceRootKey(value, platform = process.platform) {
  let stripped = String(value ?? '').trim();
  if (!stripped) return '';
  // Keep the separator that *is* the root ("C:\", "/").
  const trimmed = stripped.replace(/[\\/]+$/, '');
  stripped = trimmed || stripped.slice(0, 1);
  if (/^[A-Za-z]:$/.test(stripped)) stripped = `${stripped}\\`;
  return platform === 'win32' ? stripped.toLowerCase() : stripped;
}

/**
 * Segment-boundary containment check. Never a bare startsWith: the prefix
 * "C:\work" must not admit "C:\work-secrets".
 */
export function isWithinAllowedPrefix(candidatePath, prefixes = [], platform = process.platform) {
  const list = Array.isArray(prefixes) ? prefixes : [];
  if (!list.length) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  const key = normalizeWorkspaceRootKey(candidatePath, platform);
  if (!key) return false;
  return list.some((prefix) => {
    const prefixKey = normalizeWorkspaceRootKey(prefix, platform);
    if (!prefixKey) return false;
    if (key === prefixKey) return true;
    // A root prefix ("C:\", "/") already ends in the separator.
    const withSep = prefixKey.endsWith(sep) ? prefixKey : `${prefixKey}${sep}`;
    return key.startsWith(withSep);
  });
}

/**
 * Strict validation for client-supplied launch directories.
 * Returns { ok, path, realPath } or { ok: false, code, error }.
 *
 * Codes: missing-root-path | invalid-root-path | relative-root-path
 *      | root-path-not-found | root-path-not-allowed
 */
export function validateRequestedWorkspaceRoot(candidatePath, {
  platform = process.platform,
  allowList = [],
  statSyncImpl = fs.statSync,
  realpathSyncImpl = fs.realpathSync.native,
} = {}) {
  const pathApi = pathFor(platform);
  const raw = String(candidatePath ?? '').trim();
  if (!raw) {
    return { ok: false, code: 'missing-root-path', error: 'Missing rootPath' };
  }
  if (REJECTED_PATH_CHARS.test(raw)) {
    return { ok: false, code: 'invalid-root-path', error: 'The path contains characters that are not allowed.' };
  }

  const withDriveRoot = normalizeDriveLetterOnlyPath(raw);
  if (platform === 'win32') {
    // Drive-relative ("C:foo") resolves against a per-drive CWD we do not control.
    if (/^[A-Za-z]:[^\\/]/.test(withDriveRoot)) {
      return { ok: false, code: 'relative-root-path', error: 'Use an absolute path (for example C:\\projects\\app).' };
    }
    // Extended-length and device namespaces bypass normalization entirely.
    if (/^\\\\[?.]\\/.test(withDriveRoot)) {
      return { ok: false, code: 'invalid-root-path', error: 'Extended-length and device paths are not supported.' };
    }
  }
  if (!pathApi.isAbsolute(withDriveRoot)) {
    return {
      ok: false,
      code: 'relative-root-path',
      error: platform === 'win32'
        ? 'Use an absolute path (for example C:\\projects\\app).'
        : 'Use an absolute path (for example /home/user/projects/app).',
    };
  }

  const resolved = pathApi.resolve(withDriveRoot);
  try {
    if (!statSyncImpl(resolved).isDirectory()) {
      return { ok: false, code: 'root-path-not-found', error: `Not a directory: ${resolved}` };
    }
  } catch {
    return { ok: false, code: 'root-path-not-found', error: `Directory not found: ${resolved}` };
  }

  // Resolve symlinks before the allowlist check so an alias cannot smuggle a
  // request past it, and so the recent-CWD list stops collecting aliases.
  let realPath = resolved;
  try {
    realPath = realpathSyncImpl(resolved);
    if (!statSyncImpl(realPath).isDirectory()) {
      return { ok: false, code: 'root-path-not-found', error: `Not a directory: ${realPath}` };
    }
  } catch {
    realPath = resolved;
  }

  if (!isWithinAllowedPrefix(realPath, allowList, platform)) {
    return { ok: false, code: 'root-path-not-allowed', error: 'That directory is outside the configured workspace allow list.' };
  }

  return { ok: true, path: resolved, realPath };
}

/**
 * Config/env parsing for the opt-in allow list.
 * Absent, null, empty or malformed input disables the allow list entirely, so
 * deployments that never set it behave exactly as they did before.
 * Entries that do not resolve to a directory are dropped with a warning rather
 * than failing closed — a typo must not brick a relay.
 */
export function normalizeWorkspaceRootAllowList(value, {
  statSyncImpl = fs.statSync,
  realpathSyncImpl = fs.realpathSync.native,
  warn = console.warn,
} = {}) {
  let entries = [];
  if (Array.isArray(value)) entries = value;
  else if (typeof value === 'string' && value.trim()) entries = value.split(path.delimiter);
  else return [];

  const normalized = [];
  for (const entry of entries) {
    const raw = normalizeDriveLetterOnlyPath(entry);
    if (!raw) continue;
    let resolved = '';
    try {
      resolved = path.resolve(raw);
      if (!statSyncImpl(resolved).isDirectory()) {
        warn(`[workspace-root] ignoring allow-list entry (not a directory): ${raw}`);
        continue;
      }
      try {
        resolved = realpathSyncImpl(resolved);
      } catch {
        // Keep the resolved path when realpath is unavailable.
      }
    } catch {
      warn(`[workspace-root] ignoring allow-list entry (not found): ${raw}`);
      continue;
    }
    if (!normalized.includes(resolved)) normalized.push(resolved);
  }
  return normalized;
}

/**
 * Shared body-alias reader so both CWD endpoints accept the same payload shape.
 * `||` rather than `??` preserves the existing fall-through-on-empty-string.
 */
export function readWorkspaceRootPathFromBody(body) {
  return String(
    body?.rootPath
    || body?.workspaceRootPath
    || body?.workspace_root_path
    || body?.cwd
    || '',
  ).trim();
}
