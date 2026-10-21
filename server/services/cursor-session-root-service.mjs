'use strict';

import nodeFs from 'fs';
import nodePath from 'path';

import { resolveDataDir } from './data-dir-resolution.mjs';

// Resolve the on-disk folder the Cursor SDK integration keeps for one session,
// so the file explorer's Session root works on `cursor`-provider conversations.
//
// The Cursor worker roots its per-session agent store at
// `<storeDir>/<sdkSessionId>/` (see cursor-session-worker.mjs / the storePath
// in cursor-sdk-adapter.mjs), where storeDir is `$CURSOR_AGENT_STORE_DIR` or
// `cursor-agents` in the relay's data dir. The worker and this resolver both
// go through resolveCursorSessionStoreDir, so they agree. The directory is
// created on the session's first turn, so a missing directory means "nothing
// to browse yet" rather than an error — the resolver returns null and the
// Session button stays disabled until the first turn lands.

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || '';
}

/**
 * `$CURSOR_AGENT_STORE_DIR`, else `cursor-agents` in the data dir the relay
 * uses (resolveDataDir: env var, config `dataDir`, `<serverDir>/data`), which
 * for a global install lies outside the package directory an update replaces.
 */
export function resolveCursorAgentStoreDir({
  env = process.env,
  serverDir = '',
  configPath = '',
  // The relay's data dir when the caller already has it resolved.
  dataDir = '',
  fs = nodeFs,
  path = nodePath,
} = {}) {
  const override = normalizeText(env?.CURSOR_AGENT_STORE_DIR);
  if (override) return override;
  const base = normalizeText(serverDir);
  if (!base) return '';
  const resolvedDataDir = normalizeText(dataDir)
    || resolveDataDir({ env, configPath, serverDir: base, fsImpl: fs, pathImpl: path });
  return path.join(resolvedDataDir, 'cursor-agents');
}

function isDirectory(fs, target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function agentDbMtimeMs(fs, path, sessionDir) {
  try {
    return fs.statSync(path.join(sessionDir, 'agent.db')).mtimeMs || 0;
  } catch {
    return 0;
  }
}

/**
 * The store folder one session uses. Before the store followed the data dir
 * it always lived in `<serverDir>/data/cursor-agents`, so a session can have
 * its store there (a relay whose data dir lies elsewhere, such as a checkout
 * pointed at other data; on a global install that folder went with the
 * update). A session with a store only there keeps using it in place; with
 * one in both places, the one whose agent.db changed last wins (the copy the
 * state migration made dates from the migration). Nothing is moved or
 * deleted.
 */
export function resolveCursorSessionStoreDir({
  env = process.env,
  serverDir = '',
  configPath = '',
  dataDir = '',
  sdkSessionId = '',
  fs = nodeFs,
  path = nodePath,
} = {}) {
  const storeDir = resolveCursorAgentStoreDir({ env, serverDir, configPath, dataDir, fs, path });
  const sessionId = normalizeText(sdkSessionId);
  if (!storeDir || !sessionId || normalizeText(env?.CURSOR_AGENT_STORE_DIR)) return storeDir;
  const earlierDir = path.join(normalizeText(serverDir), 'data', 'cursor-agents');
  if (path.resolve(earlierDir) === path.resolve(storeDir)) return storeDir;
  const current = path.join(storeDir, sessionId);
  const earlier = path.join(earlierDir, sessionId);
  if (!isDirectory(fs, earlier)) return storeDir;
  if (!isDirectory(fs, current)) return earlierDir;
  return agentDbMtimeMs(fs, path, earlier) > agentDbMtimeMs(fs, path, current) ? earlierDir : storeDir;
}

export function createCursorSessionRootResolver({
  fs = nodeFs,
  path = nodePath,
  env = process.env,
  serverDir = '',
  configPath = '',
  // The relay passes its resolved data dir, so no request reads config.json.
  dataDir = '',
} = {}) {
  /**
   * @returns {{ sessionRootPath: string, sessionRootName: string } | null}
   */
  function resolveCursorSessionRoot({ sdkSessionId = '' } = {}) {
    const sessionId = normalizeText(sdkSessionId);
    // The id is joined into a filesystem path, so it is validated before any
    // syscall (mirrors the Claude session-root resolver).
    if (!SESSION_ID_PATTERN.test(sessionId)) return null;
    const storeDir = resolveCursorSessionStoreDir({ env, serverDir, configPath, dataDir, sdkSessionId: sessionId, fs, path });
    if (!storeDir) return null;
    const sessionRootPath = path.join(storeDir, sessionId);
    try {
      if (!fs.statSync(sessionRootPath).isDirectory()) return null;
    } catch {
      return null;
    }
    return { sessionRootPath, sessionRootName: 'Session' };
  }

  return { resolveCursorSessionRoot };
}
