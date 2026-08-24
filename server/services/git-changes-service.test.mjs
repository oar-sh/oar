'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGitChangesService,
  parseGitStatusBranchHeader,
  parseGitStatusPorcelain,
} from './git-changes-service.mjs';

test('branch header parsing reads branch, upstream, and ahead/behind counts', () => {
  const parsed = parseGitStatusBranchHeader('## dev...origin/dev [ahead 2, behind 1]');
  assert.equal(parsed.branch, 'dev');
  assert.equal(parsed.upstream, 'origin/dev');
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  assert.equal(parsed.detached, false);
});

test('branch header parsing handles a branch without upstream', () => {
  const parsed = parseGitStatusBranchHeader('## feature/x');
  assert.equal(parsed.branch, 'feature/x');
  assert.equal(parsed.upstream, '');
  assert.equal(parsed.ahead, 0);
});

test('branch header parsing flags detached head and initial commit states', () => {
  assert.equal(parseGitStatusBranchHeader('## HEAD (no branch)').detached, true);
  const initial = parseGitStatusBranchHeader('## No commits yet on main');
  assert.equal(initial.initial, true);
  assert.equal(initial.branch, 'main');
});

test('porcelain parsing collects modified, deleted, untracked, and renamed files', () => {
  const stdout = [
    '## dev...origin/dev [ahead 1]',
    ' M server/app.mjs',
    'D  docs/old.md',
    '?? notes.txt',
    'R  renamed-new.mjs',
    'renamed-old.mjs',
    'MM both-changed.mjs',
  ].join('\0') + '\0';
  const parsed = parseGitStatusPorcelain(stdout);
  assert.equal(parsed.branch, 'dev');
  assert.equal(parsed.ahead, 1);
  assert.equal(parsed.files.length, 5);

  const byPath = new Map(parsed.files.map((file) => [file.path, file]));
  assert.equal(byPath.get('server/app.mjs').status, 'M');
  assert.equal(byPath.get('server/app.mjs').deleted, false);
  assert.equal(byPath.get('docs/old.md').deleted, true);
  assert.equal(byPath.get('notes.txt').untracked, true);
  assert.equal(byPath.get('notes.txt').status, 'U');
  assert.equal(byPath.get('renamed-new.mjs').renamed, true);
  assert.equal(byPath.get('renamed-new.mjs').origPath, 'renamed-old.mjs');
  assert.equal(byPath.get('both-changed.mjs').status, 'M');
});

test('porcelain parsing sorts files and tolerates empty output', () => {
  const parsed = parseGitStatusPorcelain(' M b.txt\0 M a.txt\0');
  assert.deepEqual(parsed.files.map((file) => file.path), ['a.txt', 'b.txt']);
  assert.deepEqual(parseGitStatusPorcelain('').files, []);
});

function fakeExec(handler) {
  return (command, args, options, callback) => {
    handler(command, args, options, callback);
  };
}

test('getStatus runs git status in the workspace root and returns parsed files', async () => {
  const calls = [];
  const service = createGitChangesService({
    execFileImpl: fakeExec((command, args, options, callback) => {
      calls.push({ command, args, cwd: options.cwd });
      callback(null, '## main\0 M src/index.mjs\0', '');
    }),
  });
  const status = await service.getStatus('/home/dev/git/copilot-remote');
  assert.equal(status.ok, true);
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.files[0].path, 'src/index.mjs');
  assert.equal(calls[0].command, 'git');
  assert.deepEqual(calls[0].args, ['status', '--porcelain=v1', '-z', '--branch']);
  assert.equal(calls[0].cwd, '/home/dev/git/copilot-remote');
});

test('getStatus reports a non-repository directory as isRepo=false', async () => {
  const service = createGitChangesService({
    execFileImpl: fakeExec((command, args, options, callback) => {
      const error = new Error('fatal: not a git repository (or any of the parent directories): .git');
      error.code = 128;
      callback(error, '', 'fatal: not a git repository');
    }),
  });
  const status = await service.getStatus('/home/dev/plain-folder');
  assert.equal(status.ok, true);
  assert.equal(status.isRepo, false);
  assert.deepEqual(status.files, []);
});

test('getDiff requests a full-context diff against HEAD for tracked files', async () => {
  const calls = [];
  const service = createGitChangesService({
    execFileImpl: fakeExec((command, args, options, callback) => {
      calls.push(args);
      callback(null, 'diff --git a/src/a.mjs b/src/a.mjs\n', '');
    }),
  });
  const diff = await service.getDiff('/home/dev/repo', 'src/a.mjs');
  assert.equal(diff.ok, true);
  assert.match(diff.patch, /^diff --git/);
  assert.deepEqual(calls[0], ['diff', 'HEAD', '-U999999', '--', 'src/a.mjs']);
});

test('getDiff uses --no-index against /dev/null for untracked files and accepts exit code 1', async () => {
  const calls = [];
  const service = createGitChangesService({
    execFileImpl: fakeExec((command, args, options, callback) => {
      calls.push(args);
      const error = new Error('exit 1');
      error.code = 1;
      callback(error, 'diff --git a/dev/null b/notes.txt\n+new\n', '');
    }),
  });
  const diff = await service.getDiff('/home/dev/repo', 'notes.txt', { untracked: true });
  assert.equal(diff.ok, true);
  assert.match(diff.patch, /\+new/);
  assert.deepEqual(calls[0], ['diff', '--no-index', '-U999999', '--', '/dev/null', 'notes.txt']);
});

test('getDiff surfaces git failures as ok=false', async () => {
  const service = createGitChangesService({
    execFileImpl: fakeExec((command, args, options, callback) => {
      const error = new Error('boom');
      error.code = 129;
      callback(error, '', 'fatal: bad revision');
    }),
  });
  const diff = await service.getDiff('/home/dev/repo', 'src/a.mjs');
  assert.equal(diff.ok, false);
  assert.match(diff.error, /bad revision/);
});

test('pull returns combined output on success and the error text on failure', async () => {
  const okService = createGitChangesService({
    execFileImpl: fakeExec((command, args, options, callback) => {
      assert.deepEqual(args, ['pull']);
      callback(null, 'Already up to date.\n', '');
    }),
  });
  const okResult = await okService.pull('/home/dev/repo');
  assert.equal(okResult.ok, true);
  assert.equal(okResult.output, 'Already up to date.');

  const failService = createGitChangesService({
    execFileImpl: fakeExec((command, args, options, callback) => {
      const error = new Error('exit 1');
      error.code = 1;
      callback(error, '', 'fatal: could not read from remote repository');
    }),
  });
  const failResult = await failService.pull('/home/dev/repo');
  assert.equal(failResult.ok, false);
  assert.match(failResult.error, /remote repository/);
});
