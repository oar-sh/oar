import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  claudeProjectDirSlug,
  createClaudeSessionRootResolver,
  resolveClaudeProjectsRoots,
} from '../services/claude-session-root-service.mjs';
import {
  driveRootFromAbsolutePath,
  normalizeDriveAbsolutePath,
  toDriveWebPath,
} from '../services/drives-path-helpers.mjs';

// The relay runs on Windows as often as on Linux, and the Session root is the
// one explorer root whose path originates server-side rather than from a
// browsable drive listing. These tests pin the win32 half of that journey:
// resolver -> conversation payload -> browser -> /api/session-root/list -> node,
// using the real path helpers from both ends. They run on any platform because
// every step is given win32 path semantics explicitly.

globalThis.window = { location: { pathname: '/' }, innerHeight: 0 };
globalThis.document = { documentElement: { clientHeight: 0 } };
globalThis.sessionStorage = { getItem() { return ''; }, setItem() {} };

const { setServerPlatform } = await import('../public/app/store.js');
const { normalizeDriveBrowserPath } = await import('../public/app/router.js');
setServerPlatform('win32');

const NATIVE_ID = '11111111-2222-4333-8444-555555555555';
const HOME = 'C:\\Users\\dev';
const WORKSPACE_ROOT = 'C:\\Users\\dev\\git\\copilot-remote';
const PROJECT_DIR = `${HOME}\\.claude\\projects\\${claudeProjectDirSlug(WORKSPACE_ROOT)}`;
const SESSION_DIR = `${PROJECT_DIR}\\${NATIVE_ID}`;
const TRANSCRIPT = `${PROJECT_DIR}\\${NATIVE_ID}.jsonl`;

// A win32 fs stub: only statSync is reached on the fast path, and only the
// entries listed here exist.
function makeWin32Fs({ dirs = [], files = [] } = {}) {
  const dirSet = new Set(dirs.map((entry) => entry.toLowerCase()));
  const fileSet = new Set(files.map((entry) => entry.toLowerCase()));
  return {
    statSync(candidate) {
      const key = String(candidate).toLowerCase();
      if (dirSet.has(key)) return { isDirectory: () => true, isFile: () => false };
      if (fileSet.has(key)) return { isDirectory: () => false, isFile: () => true };
      const error = new Error(`ENOENT: ${candidate}`);
      error.code = 'ENOENT';
      throw error;
    },
    readdirSync() {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
  };
}

function makeWin32Resolver(fsStub) {
  return createClaudeSessionRootResolver({
    fs: fsStub,
    path: path.win32,
    env: {},
    homedir: () => HOME,
  }).resolveClaudeSessionRoot;
}

test('the Windows projects root is built with backslashes under the user profile', () => {
  assert.deepEqual(
    resolveClaudeProjectsRoots({ env: {}, homedir: () => HOME, path: path.win32 }),
    ['C:\\Users\\dev\\.claude\\projects'],
  );
  assert.equal(claudeProjectDirSlug(WORKSPACE_ROOT), 'C--Users-dev-git-copilot-remote');
});

test('a transcript-only session on Windows resolves to a native session path', () => {
  const resolve = makeWin32Resolver(makeWin32Fs({ dirs: [PROJECT_DIR], files: [TRANSCRIPT] }));
  assert.deepEqual(resolve({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath: WORKSPACE_ROOT }), {
    sessionRootPath: SESSION_DIR,
    transcriptPath: TRANSCRIPT,
    sessionRootExists: false,
    sessionRootName: 'Session',
    projectDirPath: PROJECT_DIR,
  });
});

test('a Windows session directory that already exists is reported as such', () => {
  const resolve = makeWin32Resolver(makeWin32Fs({ dirs: [PROJECT_DIR, SESSION_DIR], files: [TRANSCRIPT] }));
  assert.equal(resolve({ claudeNativeSessionId: NATIVE_ID, workspaceRootPath: WORKSPACE_ROOT })?.sessionRootExists, true);
});

test('the browser turns the native session path into the drive web path it will request', () => {
  assert.equal(
    normalizeDriveBrowserPath(SESSION_DIR),
    'C:/Users/dev/.claude/projects/C--Users-dev-git-copilot-remote/11111111-2222-4333-8444-555555555555',
  );
});

test('the requested web path round-trips back to the same node path the browser holds', () => {
  // loadRepoBrowserTree adopts rootNode.path as currentPath and keys nodeMap by
  // it, so a web path that does not survive the round trip would leave the tree
  // unnavigable on Windows.
  const requested = normalizeDriveBrowserPath(SESSION_DIR);
  const absolutePath = normalizeDriveAbsolutePath(requested);

  assert.equal(absolutePath, SESSION_DIR);
  assert.equal(toDriveWebPath(absolutePath), requested);
  assert.equal(path.win32.basename(absolutePath), NATIVE_ID);
});

test('the sibling transcript resolves to a drive path under the same allowed root', () => {
  const absolutePath = normalizeDriveAbsolutePath(normalizeDriveBrowserPath(SESSION_DIR));
  const transcriptPath = `${absolutePath}.jsonl`;

  assert.equal(transcriptPath, TRANSCRIPT);
  assert.equal(path.win32.basename(transcriptPath), `${NATIVE_ID}.jsonl`);
  assert.equal(toDriveWebPath(transcriptPath), `${normalizeDriveBrowserPath(SESSION_DIR)}.jsonl`);
  // The drive allow-list check the route runs against the root is what also
  // covers the transcript, which is why it needs no separate filtering.
  assert.equal(driveRootFromAbsolutePath(transcriptPath), driveRootFromAbsolutePath(absolutePath));
  assert.equal(driveRootFromAbsolutePath(absolutePath), 'C:\\');
});
