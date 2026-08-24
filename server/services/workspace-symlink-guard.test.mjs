import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isRealPathWithinRoot } from './workspace-symlink-guard.mjs';

function tmpRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-guard-')));
}

test('a plain file inside the root is allowed', () => {
  const root = tmpRoot();
  const file = path.join(root, 'notes.txt');
  fs.writeFileSync(file, 'hi');
  assert.equal(isRealPathWithinRoot(file, root), true);
});

test('a not-yet-created file inside the root is allowed', () => {
  const root = tmpRoot();
  assert.equal(isRealPathWithinRoot(path.join(root, 'sub', 'new.txt'), root), true);
});

test('a symlink to a file outside the root is rejected', { skip: process.platform === 'win32' }, () => {
  const root = tmpRoot();
  const outside = path.join(tmpRoot(), 'secret.txt');
  fs.writeFileSync(outside, 'top secret');
  const link = path.join(root, 'creds');
  fs.symlinkSync(outside, link);
  // Lexically `creds` is inside root, but it resolves outside it.
  assert.equal(isRealPathWithinRoot(link, root), false);
});

test('a symlinked parent directory escaping the root is rejected', { skip: process.platform === 'win32' }, () => {
  const root = tmpRoot();
  const outsideDir = tmpRoot();
  const link = path.join(root, 'escape');
  fs.symlinkSync(outsideDir, link);
  assert.equal(isRealPathWithinRoot(path.join(link, 'anything.txt'), root), false);
});

test('a symlink pointing back inside the root is allowed', { skip: process.platform === 'win32' }, () => {
  const root = tmpRoot();
  const real = path.join(root, 'real.txt');
  fs.writeFileSync(real, 'ok');
  const link = path.join(root, 'alias');
  fs.symlinkSync(real, link);
  assert.equal(isRealPathWithinRoot(link, root), true);
});

test('windows path containment is case-insensitive (host-independent)', () => {
  // Mock realpathSync so root and target resolve to prefixes that differ only in
  // case — the situation short (8.3) names / subst drives can produce on Windows.
  const fakeFs = {
    realpathSync(p) {
      return /ws$/i.test(String(p)) ? 'C:\\WS' : 'C:\\ws\\app.js';
    },
  };
  const deps = { fs: fakeFs, path: path.win32 };
  assert.equal(
    isRealPathWithinRoot('C:\\ws\\app.js', 'C:\\WS', { ...deps, platform: 'win32' }),
    true,
    'win32 must treat the case-mismatched path as inside the root',
  );
  assert.equal(
    isRealPathWithinRoot('C:\\ws\\app.js', 'C:\\WS', { ...deps, platform: 'linux' }),
    false,
    'case-sensitive platforms keep the strict comparison',
  );
});
