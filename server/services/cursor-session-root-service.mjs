'use strict';

import nodeFs from 'fs';
import nodePath from 'path';

// Resolve the on-disk folder the Cursor SDK integration keeps for one session,
// so the file explorer's Session root works on `cursor`-provider conversations.
//
// The Cursor worker roots its per-session agent store at
// `<storeDir>/<sdkSessionId>/` (see cursor-session-worker.mjs / the storePath
// in cursor-sdk-adapter.mjs), where storeDir is `$CURSOR_AGENT_STORE_DIR` or
// `<serverDir>/data/cursor-agents`. The directory is created on the session's
// first turn, so a missing directory means "nothing to browse yet" rather than
// an error — the resolver returns null and the Session button stays disabled
// until the first turn lands.

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function normalizeText(value) {
  const text = String(value || '').trim();
  return text || '';
}

export function resolveCursorAgentStoreDir({
  env = process.env,
  serverDir = '',
  path = nodePath,
} = {}) {
  const override = normalizeText(env?.CURSOR_AGENT_STORE_DIR);
  if (override) return override;
  const base = normalizeText(serverDir);
  if (!base) return '';
  return path.join(base, 'data', 'cursor-agents');
}

export function createCursorSessionRootResolver({
  fs = nodeFs,
  path = nodePath,
  env = process.env,
  serverDir = '',
} = {}) {
  /**
   * @returns {{ sessionRootPath: string, sessionRootName: string } | null}
   */
  function resolveCursorSessionRoot({ sdkSessionId = '' } = {}) {
    const sessionId = normalizeText(sdkSessionId);
    // The id is joined into a filesystem path, so it is validated before any
    // syscall (mirrors the Claude session-root resolver).
    if (!SESSION_ID_PATTERN.test(sessionId)) return null;
    const storeDir = resolveCursorAgentStoreDir({ env, serverDir, path });
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
