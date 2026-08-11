import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveRepositoryWorkspaceRoot,
  resolveStartupWorkspaceRoot,
  resolveWorkspaceRootPath,
  workspaceRootDisplayName,
  parseCdCommandTarget,
  resolveCdCommandPath,
} from './workspace-root.mjs';

// These used to live in tests/workspace-root.spec.mjs, which needed neither a
// browser nor a server — and whose win32 `cd` case could only pass when the host
// happened to be Windows. The platform is injected now, so both halves of the
// journey run everywhere.

test('prefers an explicit cwd root and falls back cleanly', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-root-'));
  const missingRoot = path.join(tempRoot, 'missing');
  const fallbackRoot = path.join(tempRoot, 'fallback');
  fs.mkdirSync(fallbackRoot, { recursive: true });

  assert.equal(resolveWorkspaceRootPath(tempRoot, fallbackRoot), path.resolve(tempRoot));
  assert.equal(resolveWorkspaceRootPath(missingRoot, fallbackRoot), path.resolve(fallbackRoot));
  assert.equal(workspaceRootDisplayName(tempRoot), path.basename(path.resolve(tempRoot)));

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('prefers launch cwd env and falls back to repository root', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-launch-'));
  const serverDir = path.join(tempRoot, 'server');
  const launchRoot = path.join(tempRoot, 'launch-cwd');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(launchRoot, { recursive: true });

  assert.equal(resolveRepositoryWorkspaceRoot(launchRoot, serverDir), path.resolve(launchRoot));
  assert.equal(resolveRepositoryWorkspaceRoot('', serverDir), path.resolve(tempRoot));
  assert.equal(resolveRepositoryWorkspaceRoot(undefined, serverDir), path.resolve(tempRoot));

  const previous = process.env.COPILOT_WORKSPACE_ROOT;
  process.env.COPILOT_WORKSPACE_ROOT = launchRoot;
  assert.equal(resolveStartupWorkspaceRoot(serverDir), path.resolve(launchRoot));
  process.env.COPILOT_WORKSPACE_ROOT = path.join(tempRoot, 'elsewhere');
  assert.equal(resolveStartupWorkspaceRoot(serverDir), path.resolve(tempRoot));
  if (previous === undefined) {
    delete process.env.COPILOT_WORKSPACE_ROOT;
  } else {
    process.env.COPILOT_WORKSPACE_ROOT = previous;
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// parseCdCommandTarget is pure string work with no path semantics, so one set of
// cases covers both platforms.
test('parses plain cd commands safely', () => {
  assert.equal(parseCdCommandTarget('cd U:\\'), 'U:\\');
  assert.equal(parseCdCommandTarget('cd /d "X:\\programs"'), 'X:\\programs');
  assert.equal(parseCdCommandTarget('cd /srv/app'), '/srv/app');
  assert.equal(parseCdCommandTarget('cd ..'), '..');
  assert.equal(parseCdCommandTarget('cd'), null);
  assert.equal(parseCdCommandTarget('cd U:\\ && dir'), null);
  assert.equal(parseCdCommandTarget('cd /srv/app; rm -rf /'), null);
  assert.equal(parseCdCommandTarget('echo cd U:\\'), null);
});

test('resolves win32 cd targets relative to the active root', () => {
  const home = 'C:\\Users\\dev';

  // A bare drive letter jumps to that drive's root rather than resolving under
  // the current root — the reason normalizeDriveLetterOnlyPath exists.
  assert.equal(resolveCdCommandPath('U:', 'X:\\workspace\\repo', home, 'win32'), 'U:\\');
  assert.equal(
    resolveCdCommandPath('..\\server', 'X:\\workspace\\repo\\tests', home, 'win32'),
    'X:\\workspace\\repo\\server',
  );
  assert.equal(
    resolveCdCommandPath('sub', 'X:\\workspace\\repo', home, 'win32'),
    'X:\\workspace\\repo\\sub',
  );
  assert.equal(resolveCdCommandPath('~', 'X:\\workspace\\repo', home, 'win32'), home);
  assert.equal(
    resolveCdCommandPath('~\\notes', 'X:\\workspace\\repo', home, 'win32'),
    'C:\\Users\\dev\\notes',
  );
  assert.equal(resolveCdCommandPath('', 'X:\\workspace\\repo', home, 'win32'), null);
});

test('resolves posix cd targets relative to the active root', () => {
  const home = '/home/dev';

  assert.equal(resolveCdCommandPath('/srv/app', '/workspace/repo', home, 'linux'), '/srv/app');
  assert.equal(resolveCdCommandPath('../server', '/workspace/repo/tests', home, 'linux'), '/workspace/repo/server');
  assert.equal(resolveCdCommandPath('sub', '/workspace/repo', home, 'linux'), '/workspace/repo/sub');
  assert.equal(resolveCdCommandPath('~', '/workspace/repo', home, 'linux'), home);
  assert.equal(resolveCdCommandPath('~/notes', '/workspace/repo', home, 'linux'), '/home/dev/notes');
  assert.equal(resolveCdCommandPath('', '/workspace/repo', home, 'linux'), null);
});
