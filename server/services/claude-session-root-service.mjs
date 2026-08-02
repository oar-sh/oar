'use strict';

import nodeFs from 'fs';
import nodePath from 'path';
import os from 'os';

// Resolve the on-disk folder the Claude Agent SDK keeps for one session, so the
// file explorer's Session root works on `claude`-provider conversations.
//
// The Copilot CLI creates `~/.copilot/session-state/<sdkSessionId>/` as a side
// effect of running; the Claude worker never touches that path, which is why the
// Session button was permanently disabled for Claude conversations. The SDK's
// own equivalent is:
//
//   <configRoot>/projects/<slug(cwd)>/<nativeSessionId>/
//
// with the sibling `<nativeSessionId>.jsonl` transcript one level up. Only the
// per-session directory is exposed — the project directory holds every session
// for that workspace plus `memory/`, so pointing the browser at it would leak
// unrelated conversations into a "Session" view.
//
// The transcript, not the directory, is what anchors a session here. The SDK
// writes the `.jsonl` from the first turn but creates the directory lazily, only
// once the session produces `subagents/` or `tool-results/` files — so requiring
// the directory left the Session button dark for every conversation that had not
// yet spawned a subagent. `sessionRootPath` is therefore returned for a
// transcript-only session too, with `sessionRootExists: false` so the caller can
// serve it as an empty folder rather than a 404.

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROJECT_SLUG_MAX_LENGTH = 200;
const DEFAULT_MISS_TTL_MS = 5_000;
const DEFAULT_MAX_PROJECT_DIRS_SCANNED = 500;
const DEFAULT_MAX_CACHE_ENTRIES = 256;

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || '';
}

function slugHashSuffix(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Mirrors the directory-name sanitizer the Agent SDK applies to a session's cwd.
 * Reimplemented rather than imported: `claude-sdk-adapter.mjs` is deliberately
 * the only module in this repo that pulls in `@anthropic-ai/claude-agent-sdk`,
 * and the relay server must not load it.
 */
export function claudeProjectDirSlug(cwd) {
  const value = String(cwd || '');
  const sanitized = value.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= PROJECT_SLUG_MAX_LENGTH) return sanitized;
  return `${sanitized.slice(0, PROJECT_SLUG_MAX_LENGTH)}-${slugHashSuffix(value)}`;
}

/**
 * Candidate `<configRoot>/projects` directories, most specific first.
 *
 * Both `$CLAUDE_CONFIG_DIR` and `~/.claude` are probed because the two worker
 * launch paths disagree: the tmux path forwards an explicit env allowlist that
 * omits CLAUDE_CONFIG_DIR, while the detached spawn inherits the full
 * environment. So the worker and the relay can be looking at different roots.
 */
export function resolveClaudeProjectsRoots({ env = process.env, homedir = os.homedir, path = nodePath } = {}) {
  const roots = [];
  const configDirOverride = normalizeText(env?.CLAUDE_CONFIG_DIR);
  if (configDirOverride) roots.push(path.join(configDirOverride, 'projects'));
  let home = '';
  try {
    home = normalizeText(typeof homedir === 'function' ? homedir() : homedir);
  } catch {
    home = '';
  }
  if (!home) home = normalizeText(env?.HOME) || normalizeText(env?.USERPROFILE);
  if (home) roots.push(path.join(home, '.claude', 'projects'));
  return [...new Set(roots.map((root) => root.normalize('NFC')))];
}

export function createClaudeSessionRootResolver({
  fs = nodeFs,
  path = nodePath,
  env = process.env,
  homedir = os.homedir,
  now = () => Date.now(),
  missTtlMs = DEFAULT_MISS_TTL_MS,
  maxProjectDirsScanned = DEFAULT_MAX_PROJECT_DIRS_SCANNED,
  maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
} = {}) {
  // nativeSessionId -> the project directory that contains it.
  const projectDirCache = new Map();
  // nativeSessionId -> timestamp after which it is worth scanning again.
  const missCache = new Map();

  function isDirectory(candidate) {
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  function isFile(candidate) {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  }

  /**
   * The session's on-disk footprint inside one project directory, or null when
   * the session does not live there at all.
   *
   * @returns {{ sessionRootPath: string, transcriptPath: string, sessionRootExists: boolean } | null}
   */
  function sessionAnchorsIn(projectDir, nativeSessionId) {
    const sessionRootPath = path.join(projectDir, nativeSessionId);
    const transcriptPath = path.join(projectDir, `${nativeSessionId}.jsonl`);
    const sessionRootExists = isDirectory(sessionRootPath);
    const transcriptExists = isFile(transcriptPath);
    if (!sessionRootExists && !transcriptExists) return null;
    return {
      sessionRootPath,
      transcriptPath: transcriptExists ? transcriptPath : '',
      sessionRootExists,
    };
  }

  function findProjectDir(nativeSessionId, workspaceRootPath) {
    const roots = resolveClaudeProjectsRoots({ env, homedir, path });
    const workspaceRoot = normalizeText(workspaceRootPath);

    // Fast path: derive the project dir straight from the session's workspace.
    if (workspaceRoot) {
      const slug = claudeProjectDirSlug(workspaceRoot);
      for (const root of roots) {
        const projectDir = path.join(root, slug);
        if (sessionAnchorsIn(projectDir, nativeSessionId)) return projectDir;
      }
    }

    // Fallback: the slug can miss (symlinked or since-changed workspace root, a
    // git worktree, an SDK sanitizer change), so scan the project dirs. Bounded
    // and never recursive — one readdir per root plus two stats per project.
    for (const root of roots) {
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      let scanned = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (scanned >= maxProjectDirsScanned) break;
        scanned += 1;
        const projectDir = path.join(root, entry.name);
        if (sessionAnchorsIn(projectDir, nativeSessionId)) return projectDir;
      }
    }
    return '';
  }

  function rememberProjectDir(nativeSessionId, projectDir) {
    if (projectDirCache.size >= maxCacheEntries) projectDirCache.clear();
    projectDirCache.set(nativeSessionId, projectDir);
  }

  /**
   * @returns {{
   *   sessionRootPath: string,
   *   sessionRootName: string,
   *   projectDirPath: string,
   *   transcriptPath: string,
   *   sessionRootExists: boolean,
   * } | null}
   */
  function resolveClaudeSessionRoot({ claudeNativeSessionId = '', workspaceRootPath = '' } = {}) {
    const nativeSessionId = normalizeText(claudeNativeSessionId);
    // The id is joined into a filesystem path, so it is validated before any
    // syscall rather than trusted the way the Copilot branch trusts its own.
    if (!SESSION_ID_PATTERN.test(nativeSessionId)) return null;

    const cachedProjectDir = projectDirCache.get(nativeSessionId);
    if (cachedProjectDir) {
      // Re-probed rather than assumed: the directory appears partway through a
      // session's life, so a cache hit must still report the current state.
      const anchors = sessionAnchorsIn(cachedProjectDir, nativeSessionId);
      if (anchors) {
        return { ...anchors, sessionRootName: 'Session', projectDirPath: cachedProjectDir };
      }
      projectDirCache.delete(nativeSessionId);
    }

    // The client re-polls conversation detail roughly every second while a turn
    // runs, so a miss must not mean a directory scan every time.
    const missUntil = missCache.get(nativeSessionId);
    if (missUntil !== undefined && missUntil > now()) return null;

    const projectDir = findProjectDir(nativeSessionId, workspaceRootPath);
    if (!projectDir) {
      if (missCache.size >= maxCacheEntries) missCache.clear();
      missCache.set(nativeSessionId, now() + missTtlMs);
      return null;
    }
    // Re-read rather than reuse what the scan matched on: the session can be
    // deleted between the two, and a partial result would be worse than a miss.
    const anchors = sessionAnchorsIn(projectDir, nativeSessionId);
    if (!anchors) return null;
    missCache.delete(nativeSessionId);
    rememberProjectDir(nativeSessionId, projectDir);
    return { ...anchors, sessionRootName: 'Session', projectDirPath: projectDir };
  }

  function clearCache() {
    projectDirCache.clear();
    missCache.clear();
  }

  return { resolveClaudeSessionRoot, clearCache };
}
