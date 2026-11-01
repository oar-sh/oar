import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildIdsDiffer,
  normalizeBuildId,
  readGitCommit,
  readPackageVersion,
  resolveBuildCommit,
  resolveBuildId,
} from './build-id.mjs';

const COMMIT_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const COMMIT_B = '0123456789abcdef0123456789abcdef01234567';

function fakeFs(files) {
  return {
    readFileSync(filePath) {
      if (Object.hasOwn(files, filePath)) return files[filePath];
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

const manifest = (fields) => JSON.stringify({ name: 'demo', ...fields });

// Both path flavours run on every machine: a linked worktree's gitdir is
// resolved, and on Windows that puts a drive letter in front of a rooted path.
for (const [flavour, pathImpl, demoRoot, gitdirOf] of [
  ['posix', path.posix, '/home/dev', (dir) => dir],
  // Git for Windows writes the gitdir pointer with forward slashes.
  ['win32', path.win32, 'C:\\Users\\dev', (dir) => dir.replaceAll('\\', '/')],
]) {
  const root = pathImpl.join(demoRoot, 'demo');
  const gitDir = pathImpl.join(root, '.git');
  const packageJson = pathImpl.join(root, 'package.json');
  const resolve = (packageRoot, files) => resolveBuildId(packageRoot, { fsImpl: fakeFs(files), pathImpl });

  test(`a checkout on a branch with a loose ref: version plus the short commit (${flavour})`, () => {
    assert.deepEqual(resolve(root, {
      [packageJson]: manifest({ version: '0.9.21' }),
      [pathImpl.join(gitDir, 'HEAD')]: 'ref: refs/heads/x\n',
      [pathImpl.join(gitDir, 'refs', 'heads', 'x')]: `${COMMIT_A}\n`,
    }), { version: '0.9.21', commit: COMMIT_A, id: `0.9.21+${COMMIT_A.slice(0, 12)}` });
  });

  test(`a detached HEAD is read as the commit, lowercased (${flavour})`, () => {
    assert.deepEqual(resolve(root, {
      [packageJson]: manifest({ version: '0.9.21' }),
      [pathImpl.join(gitDir, 'HEAD')]: `${COMMIT_B.toUpperCase()}\n`,
    }), { version: '0.9.21', commit: COMMIT_B, id: '0.9.21+0123456789ab' });
  });

  test(`a linked worktree: .git names the gitdir, the ref lives in the common dir (${flavour})`, () => {
    const linkedRoot = pathImpl.join(demoRoot, 'demo-wt');
    const linkedGitDir = pathImpl.join(gitDir, 'worktrees', 'demo-wt');
    assert.deepEqual(resolve(linkedRoot, {
      [pathImpl.join(linkedRoot, 'package.json')]: manifest({ version: '0.9.21' }),
      [pathImpl.join(linkedRoot, '.git')]: `gitdir: ${gitdirOf(linkedGitDir)}\n`,
      [pathImpl.join(linkedGitDir, 'HEAD')]: 'ref: refs/heads/feat/demo\n',
      [pathImpl.join(linkedGitDir, 'commondir')]: '../..\n',
      [pathImpl.join(gitDir, 'refs', 'heads', 'feat', 'demo')]: `${COMMIT_A}\n`,
    }), { version: '0.9.21', commit: COMMIT_A, id: `0.9.21+${COMMIT_A.slice(0, 12)}` });
  });

  test(`a packed ref is found when there is no loose one (${flavour})`, () => {
    assert.deepEqual(resolve(root, {
      [packageJson]: manifest({ version: '0.9.21' }),
      [pathImpl.join(gitDir, 'HEAD')]: 'ref: refs/heads/main\n',
      [pathImpl.join(gitDir, 'packed-refs')]: `# pack-refs with: peeled fully-peeled sorted\n${COMMIT_A} refs/heads/other\n${COMMIT_B} refs/heads/main\n`,
    }), { version: '0.9.21', commit: COMMIT_B, id: '0.9.21+0123456789ab' });
  });

  test(`an npm install with a gitHead stamp uses the stamp (${flavour})`, () => {
    assert.deepEqual(resolve(root, {
      [packageJson]: manifest({ version: '0.9.21', gitHead: COMMIT_A }),
    }), { version: '0.9.21', commit: COMMIT_A, id: `0.9.21+${COMMIT_A.slice(0, 12)}` });
  });

  test(`no git and no gitHead: the version alone is the id (${flavour})`, () => {
    assert.deepEqual(resolve(root, { [packageJson]: manifest({ version: '0.9.21' }) }),
      { version: '0.9.21', commit: null, id: '0.9.21' });
    // A stamp that is not a commit is no commit.
    assert.deepEqual(resolve(root, { [packageJson]: manifest({ version: '0.9.21', gitHead: 'not-a-commit' }) }),
      { version: '0.9.21', commit: null, id: '0.9.21' });
  });

  test(`an unreadable package.json has no version and no id, even with a commit (${flavour})`, () => {
    const head = { [pathImpl.join(gitDir, 'HEAD')]: `${COMMIT_A}\n` };
    assert.deepEqual(resolve(root, head), { version: null, commit: COMMIT_A, id: null });
    assert.deepEqual(resolve(root, { ...head, [packageJson]: '{ not json' }), { version: null, commit: COMMIT_A, id: null });
    assert.deepEqual(resolve(root, { [packageJson]: manifest({ version: '   ' }) }), { version: null, commit: null, id: null });
    assert.deepEqual(resolve(root, { [packageJson]: manifest({ version: 921 }) }), { version: null, commit: null, id: null });
    assert.deepEqual(resolve(null, {}), { version: null, commit: null, id: null });
  });
}

test('the readers are exported on their own and agree with resolveBuildId', () => {
  const root = path.join(path.sep, 'home', 'dev', 'demo');
  const files = {
    [path.join(root, 'package.json')]: manifest({ version: ' 1.2.3 ', gitHead: COMMIT_B }),
  };
  const options = { fsImpl: fakeFs(files) };
  assert.equal(readPackageVersion(root, options), '1.2.3');
  assert.equal(readGitCommit(root, options), null, 'no checkout');
  assert.equal(resolveBuildCommit(root, options), COMMIT_B, 'the stamp');
  assert.equal(readPackageVersion(root, { fsImpl: fakeFs({}) }), null);
});

test('a real checkout on disk is read through node:fs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-build-id-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), manifest({ version: '0.9.21' }));
    fs.mkdirSync(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/x\n');
    fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'x'), `${COMMIT_A}\n`);
    assert.deepEqual(resolveBuildId(root), { version: '0.9.21', commit: COMMIT_A, id: `0.9.21+${COMMIT_A.slice(0, 12)}` });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildIdsDiffer is true only when both ids are known and differ', () => {
  assert.equal(buildIdsDiffer('0.9.21+a1b2c3d4e5f6', '0.9.21+a1b2c3d4e5f6'), false, 'equal');
  assert.equal(buildIdsDiffer('0.9.21+a1b2c3d4e5f6', ' 0.9.21+a1b2c3d4e5f6 '), false, 'equal after trim');
  assert.equal(buildIdsDiffer('0.9.20+a1b2c3d4e5f6', '0.9.21+0123456789ab'), true, 'different');
  assert.equal(buildIdsDiffer('0.9.20', '0.9.21'), true, 'different versions alone');
  assert.equal(buildIdsDiffer('', '0.9.21'), false, 'empty');
  assert.equal(buildIdsDiffer('0.9.21', '   '), false, 'blank');
  assert.equal(buildIdsDiffer(null, '0.9.21'), false, 'null');
  assert.equal(buildIdsDiffer('0.9.21', undefined), false, 'undefined');
  assert.equal(buildIdsDiffer(null, null), false, 'both null');
});

test('normalizeBuildId keeps a bounded id of version and commit characters', () => {
  assert.equal(normalizeBuildId(' 0.9.21+a1b2c3d4e5f6 '), '0.9.21+a1b2c3d4e5f6');
  assert.equal(normalizeBuildId('1.0.0-beta_2'), '1.0.0-beta_2');
  assert.equal(normalizeBuildId('x'.repeat(80)), 'x'.repeat(80), 'at the limit');
  assert.equal(normalizeBuildId('x'.repeat(81)), null, 'too long');
  assert.equal(normalizeBuildId('0.9.21 a1b2c3d4e5f6'), null, 'a space');
  assert.equal(normalizeBuildId('0.9.21;rm'), null, 'other characters');
  assert.equal(normalizeBuildId(''), null);
  assert.equal(normalizeBuildId('   '), null);
  assert.equal(normalizeBuildId(null), null);
  assert.equal(normalizeBuildId(921), null);
});
