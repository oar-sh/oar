import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { registerMessagesRoutes } from './messages-routes.mjs';
import {
  driveRootFromAbsolutePath,
  normalizeDriveAbsolutePath,
  normalizeLinuxAbsolutePath,
  toDriveWebPath,
} from '../services/drives-path-helpers.mjs';

const NATIVE_ID = '11111111-2222-4333-8444-555555555555';
const IS_WINDOWS = process.platform === 'win32'; // host-platform: the real drive-path helpers of the host OS are under test

// The route serves web paths (C:/…) on Windows and native paths elsewhere.
function nodePathFor(absolutePath) {
  return IS_WINDOWS ? toDriveWebPath(absolutePath) : absolutePath;
}

// Stand-ins for the helpers server-runtime.mjs injects. server-runtime boots a
// server on import, so their behaviour is reproduced here rather than imported.
// The route branches on process.platform, so the deps cover both branches: the
// real path helpers plus fs-backed directory listers over the temp fixtures.
function fetchDirectoryEntries(joinImpl, dirPath, { includeHidden = false } = {}, cb) {
  let names = [];
  try {
    names = fs.readdirSync(dirPath);
  } catch (error) {
    return cb(error);
  }
  const entries = names
    .filter((name) => includeHidden || !name.startsWith('.'))
    .map((name) => {
      const fullPath = joinImpl(dirPath, name);
      const stat = fs.statSync(fullPath);
      return {
        name,
        fullPath,
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.isDirectory() ? null : stat.size,
        mtime: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'dir' ? -1 : 1)));
  return cb(null, entries);
}

const routeDeps = {
  auth: (_req, _res, next) => next(),
  db: { prepare: () => ({ run() {}, get: () => null, all: () => [] }) },
  MAX_UPLOAD_BYTES: 1024 * 1024,
  parseBooleanQueryFlag: (value, fallback) => {
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    return fallback;
  },
  normalizeLinuxAbsolutePath,
  normalizeDriveAbsolutePath,
  driveRootFromAbsolutePath,
  toDriveWebPath,
  fetchBrowsableDrives: (cb) => cb(null, [{ rootAbsolute: driveRootFromAbsolutePath(os.tmpdir()) }]),
  fetchDriveDirectoryEntries: (dirPath, options, cb) => fetchDirectoryEntries(path.win32.join, dirPath, options, cb),
  mapDriveDirectoryEntry: (entry) => {
    const absolutePath = normalizeDriveAbsolutePath(entry?.fullPath);
    const webPath = toDriveWebPath(absolutePath);
    if (!webPath) return null;
    return entry.type === 'dir'
      ? { path: webPath, name: entry.name, type: 'dir', children: [], lazy: true, childrenLoaded: false }
      : { path: webPath, name: entry.name, type: 'file', size: entry.size, previewKind: 'code' };
  },
  fetchLinuxDirectoryEntries: (dirPath, options, cb) => fetchDirectoryEntries(path.posix.join, dirPath, options, cb),
  mapLinuxDirectoryEntry: (entry) => (entry?.type === 'dir'
    ? { path: entry.fullPath, name: entry.name, type: 'dir', children: [], lazy: true, childrenLoaded: false }
    : { path: entry.fullPath, name: entry.name, type: 'file', size: entry.size, previewKind: 'code' }),
};

function sessionRootHandler() {
  let handler = null;
  const app = {
    get(routePath, ...handlers) {
      if (routePath === '/api/session-root/list') handler = handlers[handlers.length - 1];
    },
    post() {}, patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, routeDeps);
  assert.ok(handler, 'the session-root listing route should be registered');
  return handler;
}

function listSessionRoot(rootPath, { includeHidden = false } = {}) {
  const handler = sessionRootHandler();
  let captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(body) { captured.body = body; return res; },
  };
  handler({ query: { path: rootPath, includeHidden: includeHidden ? '1' : '0' } }, res);
  return captured;
}

function makeProjectDir() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-root-list-'));
  return { projectDir, sessionRootPath: path.join(projectDir, NATIVE_ID) };
}

test('a session root that does not exist yet lists as an empty folder, not a 404', () => {
  const { sessionRootPath } = makeProjectDir();

  const { status, body } = listSessionRoot(sessionRootPath);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.exists, false);
  assert.equal(body.node.path, nodePathFor(sessionRootPath));
  assert.equal(body.node.name, NATIVE_ID);
  assert.equal(body.node.type, 'dir');
  assert.equal(body.node.childrenLoaded, true);
  assert.deepEqual(body.node.children, []);
});

test('the sibling transcript is listed as a child of the session root', () => {
  const { projectDir, sessionRootPath } = makeProjectDir();
  const transcriptPath = path.join(projectDir, `${NATIVE_ID}.jsonl`);
  fs.writeFileSync(transcriptPath, '{"type":"user"}\n');

  const { body } = listSessionRoot(sessionRootPath);
  assert.equal(body.exists, false);
  assert.deepEqual(body.node.children.map((child) => child.path), [nodePathFor(transcriptPath)]);
  assert.equal(body.node.children[0].type, 'file');
});

test('a populated session root lists its own entries with the transcript last', () => {
  const { projectDir, sessionRootPath } = makeProjectDir();
  fs.mkdirSync(path.join(sessionRootPath, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(sessionRootPath, 'tool-results'), { recursive: true });
  const transcriptPath = path.join(projectDir, `${NATIVE_ID}.jsonl`);
  fs.writeFileSync(transcriptPath, '{"type":"user"}\n');

  const { body } = listSessionRoot(sessionRootPath);
  assert.equal(body.exists, true);
  assert.deepEqual(body.node.children.map((child) => child.name), [
    'subagents',
    'tool-results',
    `${NATIVE_ID}.jsonl`,
  ]);
});

test('only the exact sibling transcript is picked up, never another session in the project dir', () => {
  const { projectDir, sessionRootPath } = makeProjectDir();
  fs.writeFileSync(path.join(projectDir, '99999999-0000-4000-8000-000000000000.jsonl'), '{}\n');
  fs.mkdirSync(path.join(projectDir, 'memory'), { recursive: true });

  const { body } = listSessionRoot(sessionRootPath);
  assert.deepEqual(body.node.children, []);
});

test('a session root path that is a file is rejected', () => {
  const { projectDir } = makeProjectDir();
  const filePath = path.join(projectDir, 'not-a-dir');
  fs.writeFileSync(filePath, 'x');

  const { status } = listSessionRoot(filePath);
  assert.equal(status, 400);
});

test('a non-absolute session root path is rejected before any filesystem access', () => {
  const { status, body } = listSessionRoot('../../etc');
  assert.equal(status, 400);
  assert.match(String(body.error), /Invalid/);
});

test('hidden entries follow the requested flag', () => {
  const { sessionRootPath } = makeProjectDir();
  fs.mkdirSync(sessionRootPath, { recursive: true });
  fs.writeFileSync(path.join(sessionRootPath, '.hidden'), 'x');
  fs.writeFileSync(path.join(sessionRootPath, 'visible'), 'x');

  assert.deepEqual(
    listSessionRoot(sessionRootPath).body.node.children.map((child) => child.name),
    ['visible'],
  );
  assert.deepEqual(
    listSessionRoot(sessionRootPath, { includeHidden: true }).body.node.children.map((child) => child.name),
    ['.hidden', 'visible'],
  );
});
