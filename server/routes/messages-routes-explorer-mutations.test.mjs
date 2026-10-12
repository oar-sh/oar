import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { registerMessagesRoutes } from './messages-routes.mjs';
import {
  driveRootFromAbsolutePath,
  normalizeDriveAbsolutePath,
  normalizeLinuxAbsolutePath,
  toDriveWebPath,
} from '../services/drives-path-helpers.mjs';
import { isRealPathWithinRoot } from '../services/workspace-symlink-guard.mjs';

const IS_WINDOWS = process.platform === 'win32'; // host-platform: the real drive-path helpers of the host OS are under test

// Every folder made here is removed at the end.
const tempDirs = [];
after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function makeTempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

const workspaceRoot = makeTempDir('explorer-mutations-ws-');

// Stand-ins for the helpers server-runtime.mjs injects (it boots a server on
// import). The workspace resolver reproduces the containment rules of the real
// one over the temp workspace root.
function normalizeWorkspaceRelativePath(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  const parts = value.replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return '';
  return parts.join(path.sep);
}

function resolveWorkspaceFilePath(rawPath) {
  const normalized = normalizeWorkspaceRelativePath(rawPath);
  if (!normalized) return null;
  const absolutePath = path.resolve(workspaceRoot, normalized);
  const relativeToRoot = path.relative(workspaceRoot, absolutePath);
  if (!relativeToRoot || relativeToRoot === '.' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return null;
  if (!isRealPathWithinRoot(absolutePath, workspaceRoot)) return null;
  return absolutePath;
}

const routeDeps = {
  auth: (_req, _res, next) => next(),
  db: { prepare: () => ({ run() {}, get: () => null, all: () => [] }) },
  MAX_UPLOAD_BYTES: 1024 * 1024,
  parseBooleanQueryFlag: (value, fallback) => fallback,
  normalizeLinuxAbsolutePath,
  normalizeDriveAbsolutePath,
  driveRootFromAbsolutePath,
  toDriveWebPath,
  fetchBrowsableDrives: (cb) => cb(null, [{ rootAbsolute: driveRootFromAbsolutePath(os.tmpdir()) }]),
  normalizeWorkspaceRelativePath,
  resolveWorkspaceFilePath,
};

const handlers = new Map();
{
  const app = {
    get() {},
    post(routePath, ...h) { handlers.set(routePath, h[h.length - 1]); },
    patch() {}, delete() {}, put() {}, use() {},
  };
  registerMessagesRoutes(app, routeDeps);
}

function call(route, body) {
  const handler = handlers.get(route);
  assert.ok(handler, `${route} should be registered`);
  const captured = { status: 200, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return res; },
    json(payload) { captured.body = payload; return res; },
  };
  handler({ body, query: {} }, res);
  return captured;
}

// The drive routes serve web paths (C:/…) on Windows and native paths elsewhere.
function drivePathFor(absolutePath) {
  return IS_WINDOWS ? toDriveWebPath(absolutePath) : absolutePath;
}

test('repo mkdir creates inside the workspace and answers the web path', () => {
  fs.mkdirSync(path.join(workspaceRoot, 'src'));
  assert.deepEqual(call('/api/repo/mkdir', { path: 'src', name: 'lib' }), { status: 200, body: { ok: true, path: 'src/lib' } });
  assert.ok(fs.statSync(path.join(workspaceRoot, 'src', 'lib')).isDirectory());

  assert.deepEqual(call('/api/repo/mkdir', { path: '', name: 'top' }).body, { ok: true, path: 'top' });
  assert.ok(fs.statSync(path.join(workspaceRoot, 'top')).isDirectory());

  assert.equal(call('/api/repo/mkdir', { path: 'src', name: 'lib' }).status, 409);
});

test('repo mkdir refuses bad names and paths that leave the workspace', () => {
  assert.equal(call('/api/repo/mkdir', { path: '', name: '' }).status, 400);
  assert.equal(call('/api/repo/mkdir', { path: '', name: 'a/b' }).status, 400);
  assert.equal(call('/api/repo/mkdir', { path: '..', name: 'escape' }).status, 400);
  assert.equal(call('/api/repo/mkdir', { path: 'src/../..', name: 'escape' }).status, 400);
  assert.equal(fs.existsSync(path.join(workspaceRoot, '..', 'escape')), false);
});

test('repo rename stays inside the parent and refuses the root', () => {
  fs.writeFileSync(path.join(workspaceRoot, 'src', 'a.txt'), 'a');
  assert.deepEqual(call('/api/repo/rename', { path: 'src/a.txt', newName: 'b.txt' }).body, { ok: true, path: 'src/b.txt' });
  assert.ok(fs.existsSync(path.join(workspaceRoot, 'src', 'b.txt')));

  assert.deepEqual(call('/api/repo/rename', { path: 'top', newName: 'renamed-top' }).body, { ok: true, path: 'renamed-top' });

  assert.equal(call('/api/repo/rename', { path: '', newName: 'x' }).status, 400);
  assert.equal(call('/api/repo/rename', { path: 'src/b.txt', newName: '../out.txt' }).status, 400);
  assert.equal(call('/api/repo/rename', { path: 'src/missing', newName: 'x' }).status, 404);
});

test('repo delete counts on a dry run and removes recursively otherwise', () => {
  fs.mkdirSync(path.join(workspaceRoot, 'gone', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'gone', 'deep', 'leaf.txt'), 'l');
  fs.writeFileSync(path.join(workspaceRoot, 'gone', 'top.txt'), 't');

  assert.deepEqual(call('/api/repo/delete', { path: 'gone', dryRun: true }).body, { ok: true, kind: 'dir', files: 2, dirs: 1, capped: false });
  assert.ok(fs.existsSync(path.join(workspaceRoot, 'gone')), 'a dry run removes nothing');

  assert.deepEqual(call('/api/repo/delete', { path: 'gone' }).body, { ok: true });
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'gone')), false);

  assert.equal(call('/api/repo/delete', { path: '' }).status, 400);
  assert.equal(call('/api/repo/delete', { path: '../anything' }).status, 400);
  assert.equal(call('/api/repo/delete', { path: 'gone' }).status, 404);
});

test('drives mkdir, rename and delete work on absolute paths under a browsable root', () => {
  const base = makeTempDir('explorer-mutations-drive-');

  const made = call('/api/drives/mkdir', { path: base, name: 'made' });
  assert.deepEqual(made, { status: 200, body: { ok: true, path: drivePathFor(path.join(base, 'made')) } });
  assert.ok(fs.statSync(path.join(base, 'made')).isDirectory());

  const renamed = call('/api/drives/rename', { path: path.join(base, 'made'), newName: 'moved' });
  assert.deepEqual(renamed.body, { ok: true, path: drivePathFor(path.join(base, 'moved')) });

  fs.writeFileSync(path.join(base, 'moved', 'f.txt'), 'f');
  assert.deepEqual(call('/api/drives/delete', { path: path.join(base, 'moved'), dryRun: true }).body, { ok: true, kind: 'dir', files: 1, dirs: 0, capped: false });
  assert.deepEqual(call('/api/drives/delete', { path: path.join(base, 'moved') }).body, { ok: true });
  assert.equal(fs.existsSync(path.join(base, 'moved')), false);
});

test('drives routes refuse relative paths, the root folder and bad names', () => {
  const base = makeTempDir('explorer-mutations-drive-');
  assert.equal(call('/api/drives/mkdir', { path: 'relative/dir', name: 'x' }).status, 400);
  assert.equal(call('/api/drives/mkdir', { path: base, name: '..' }).status, 400);

  const rootPath = IS_WINDOWS ? driveRootFromAbsolutePath(base) : '/';
  assert.equal(call('/api/drives/rename', { path: rootPath, newName: 'x' }).status, 400);
  assert.equal(call('/api/drives/delete', { path: rootPath }).status, 400);
  assert.equal(call('/api/drives/delete', { path: rootPath, dryRun: true }).status, 400);
});

test('on Windows a drive outside the browsable set is refused', { skip: !IS_WINDOWS }, () => { // host-platform: drive-letter rule
  const other = driveRootFromAbsolutePath(os.tmpdir()).startsWith('Z') ? 'Y:\\' : 'Z:\\';
  assert.equal(call('/api/drives/mkdir', { path: other, name: 'x' }).status, 400);
});
