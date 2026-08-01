import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isWithinAllowedPrefix,
  normalizeDriveLetterOnlyPath,
  normalizeWorkspaceRootAllowList,
  normalizeWorkspaceRootKey,
  readWorkspaceRootPathFromBody,
  validateRequestedWorkspaceRoot,
} from './workspace-root-path-policy.mjs';

const DIR_STAT = { isDirectory: () => true };
const FILE_STAT = { isDirectory: () => false };

function fakeFs(directories = []) {
  const set = new Set(directories);
  return {
    statSyncImpl: (target) => {
      if (set.has(target)) return DIR_STAT;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    realpathSyncImpl: (target) => target,
  };
}

test('normalizeDriveLetterOnlyPath restores the trailing separator for drive roots', () => {
  assert.equal(normalizeDriveLetterOnlyPath('D:'), 'D:\\');
  assert.equal(normalizeDriveLetterOnlyPath('  d:  '), 'd:\\');
  assert.equal(normalizeDriveLetterOnlyPath('D:\\'), 'D:\\');
  assert.equal(normalizeDriveLetterOnlyPath('/tmp'), '/tmp');
  assert.equal(normalizeDriveLetterOnlyPath(''), '');
  assert.equal(normalizeDriveLetterOnlyPath(null), '');
});

test('normalizeWorkspaceRootKey folds case on win32 only, and preserves roots', () => {
  assert.equal(
    normalizeWorkspaceRootKey('C:\\Git\\Repo', 'win32'),
    normalizeWorkspaceRootKey('c:\\git\\repo\\', 'win32'),
  );
  assert.equal(normalizeWorkspaceRootKey('C:\\', 'win32'), 'c:\\');
  assert.equal(normalizeWorkspaceRootKey('C:', 'win32'), 'c:\\');
  assert.notEqual(
    normalizeWorkspaceRootKey('/srv/A', 'linux'),
    normalizeWorkspaceRootKey('/srv/a', 'linux'),
  );
  assert.equal(normalizeWorkspaceRootKey('/srv/app/', 'linux'), '/srv/app');
  assert.equal(normalizeWorkspaceRootKey('/', 'linux'), '/');
  assert.equal(normalizeWorkspaceRootKey('', 'linux'), '');
});

test('isWithinAllowedPrefix matches on segment boundaries only', () => {
  assert.equal(isWithinAllowedPrefix('C:\\work\\app', ['C:\\work'], 'win32'), true);
  assert.equal(isWithinAllowedPrefix('C:\\work', ['C:\\work'], 'win32'), true);
  assert.equal(isWithinAllowedPrefix('C:\\work-secrets', ['C:\\work'], 'win32'), false);
  assert.equal(isWithinAllowedPrefix('C:\\WORK\\app', ['c:\\work'], 'win32'), true);
  assert.equal(isWithinAllowedPrefix('/srv/app/sub', ['/srv/app'], 'linux'), true);
  assert.equal(isWithinAllowedPrefix('/srv/application', ['/srv/app'], 'linux'), false);
  assert.equal(isWithinAllowedPrefix('/srv/APP', ['/srv/app'], 'linux'), false);
  assert.equal(isWithinAllowedPrefix('/anything', ['/'], 'linux'), true);
});

test('an empty allow list permits every existing directory (opt-in default)', () => {
  const fsImpl = fakeFs(['/srv/app']);
  for (const allowList of [[], null, undefined]) {
    const result = validateRequestedWorkspaceRoot('/srv/app', { platform: 'linux', allowList, ...fsImpl });
    assert.equal(result.ok, true, `allowList=${JSON.stringify(allowList)}`);
    assert.equal(result.realPath, '/srv/app');
  }
});

test('relative and drive-relative paths are rejected', () => {
  const fsImpl = fakeFs(['/srv/app']);
  for (const candidate of ['..', './sub', 'sub', '../../etc']) {
    const result = validateRequestedWorkspaceRoot(candidate, { platform: 'linux', ...fsImpl });
    assert.equal(result.ok, false, candidate);
    assert.equal(result.code, 'relative-root-path', candidate);
  }
  const driveRelative = validateRequestedWorkspaceRoot('C:foo', { platform: 'win32', ...fakeFs([]) });
  assert.equal(driveRelative.code, 'relative-root-path');
});

test('traversal resolves and is then caught by the allow list', () => {
  const fsImpl = fakeFs(['/etc']);
  const result = validateRequestedWorkspaceRoot('/srv/app/../../etc', {
    platform: 'linux',
    allowList: ['/srv/app'],
    ...fsImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'root-path-not-allowed');

  const winFs = fakeFs(['C:\\Windows']);
  const winResult = validateRequestedWorkspaceRoot('C:\\repo\\..\\..\\Windows', {
    platform: 'win32',
    allowList: ['C:\\repo'],
    ...winFs,
  });
  assert.equal(winResult.code, 'root-path-not-allowed');
});

test('injection characters are rejected, matching the chat `cd` rules', () => {
  for (const candidate of ['/srv/app; rm -rf /', '/srv/app & echo', '/srv/app | cat', '/srv/app\nmore', '/srv/\0app']) {
    const result = validateRequestedWorkspaceRoot(candidate, { platform: 'linux', ...fakeFs([]) });
    assert.equal(result.ok, false, candidate);
    assert.equal(result.code, 'invalid-root-path', candidate);
  }
});

test('extended-length and device namespace paths are rejected on win32', () => {
  const result = validateRequestedWorkspaceRoot('\\\\?\\C:\\repo', { platform: 'win32', ...fakeFs([]) });
  assert.equal(result.code, 'invalid-root-path');
});

test('missing paths and regular files are reported distinctly', () => {
  assert.equal(validateRequestedWorkspaceRoot('  ', { platform: 'linux' }).code, 'missing-root-path');
  const withFile = validateRequestedWorkspaceRoot('/srv/app/readme.md', {
    platform: 'linux',
    statSyncImpl: () => FILE_STAT,
    realpathSyncImpl: (target) => target,
  });
  assert.equal(withFile.code, 'root-path-not-found');
  const missing = validateRequestedWorkspaceRoot('/srv/nope', { platform: 'linux', ...fakeFs([]) });
  assert.equal(missing.code, 'root-path-not-found');
});

test('symlinks resolve to their target before the allow list is applied', (t) => {
  let tempDir = '';
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-policy-'));
  } catch {
    t.skip('cannot create a temp directory');
    return;
  }
  const target = path.join(tempDir, 'target');
  const aliasParent = path.join(tempDir, 'aliases');
  const alias = path.join(aliasParent, 'link');
  fs.mkdirSync(target);
  fs.mkdirSync(aliasParent);
  try {
    fs.symlinkSync(target, alias, 'junction');
  } catch {
    fs.rmSync(tempDir, { recursive: true, force: true });
    t.skip('symlink creation is not permitted here');
    return;
  }
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const resolvedTarget = fs.realpathSync.native(target);
  const viaAlias = validateRequestedWorkspaceRoot(alias, { platform: process.platform });
  assert.equal(viaAlias.ok, true);
  assert.equal(viaAlias.realPath, resolvedTarget);

  // An allow list covering only the alias' parent must not admit the target.
  const blocked = validateRequestedWorkspaceRoot(alias, {
    platform: process.platform,
    allowList: [fs.realpathSync.native(aliasParent)],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'root-path-not-allowed');
});

test('normalizeWorkspaceRootAllowList disables itself on empty or malformed input', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.deepEqual(normalizeWorkspaceRootAllowList(undefined, { warn }), []);
  assert.deepEqual(normalizeWorkspaceRootAllowList(null, { warn }), []);
  assert.deepEqual(normalizeWorkspaceRootAllowList([], { warn }), []);
  assert.deepEqual(normalizeWorkspaceRootAllowList(42, { warn }), []);
  assert.equal(warnings.length, 0);

  const dropped = normalizeWorkspaceRootAllowList(['/does/not/exist'], {
    statSyncImpl: () => { throw new Error('ENOENT'); },
    realpathSyncImpl: (target) => target,
    warn,
  });
  assert.deepEqual(dropped, []);
  assert.equal(warnings.length, 1);
});

test('readWorkspaceRootPathFromBody accepts every documented alias', () => {
  assert.equal(readWorkspaceRootPathFromBody({ rootPath: ' /a ' }), '/a');
  assert.equal(readWorkspaceRootPathFromBody({ workspaceRootPath: '/b' }), '/b');
  assert.equal(readWorkspaceRootPathFromBody({ workspace_root_path: '/c' }), '/c');
  assert.equal(readWorkspaceRootPathFromBody({ cwd: '/d' }), '/d');
  assert.equal(readWorkspaceRootPathFromBody({ rootPath: '', cwd: '/e' }), '/e');
  assert.equal(readWorkspaceRootPathFromBody({}), '');
  assert.equal(readWorkspaceRootPathFromBody(null), '');
});
