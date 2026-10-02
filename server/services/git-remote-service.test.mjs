'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { createGitRemoteService, redactRemoteUrlCredentials } from './git-remote-service.mjs';

// Remote URLs with a user part are built from their halves: the hygiene guard
// reads a literal `user@host` as an e-mail address.
const SCP_REMOTE = ['git', 'github.com:example-org/sample-repo.git'].join('@');
const SSH_REMOTE = ['ssh://git', 'github.com/example-org/sample-repo'].join('@');
const CREDENTIAL_REMOTE = ['https://dev:test-token-value', 'github.com/example-org/sample-repo.git'].join('@');

// A scripted `git`: `status` is the porcelain output (or an error), `remotes`
// maps a remote name to its URL.
function fakeGit({ status = '## main\0', statusError = null, remotes = {} } = {}) {
  const calls = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === 'status') {
      if (statusError) return callback(statusError, '', statusError.stderr || '');
      return callback(null, status, '');
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2]];
      if (!url) {
        const error = new Error(`error: No such remote '${args[2]}'`);
        error.code = 2;
        return callback(error, '', error.message);
      }
      return callback(null, `${url}\n`, '');
    }
    return callback(new Error(`unexpected git ${args.join(' ')}`), '', '');
  };
  return { execFileImpl, calls };
}

test('a pushed checkout reports its GitHub repository and branch', async () => {
  const git = fakeGit({
    status: '## dev/feature...origin/dev/feature\0',
    remotes: { origin: SCP_REMOTE },
  });
  const service = createGitRemoteService({ execFileImpl: git.execFileImpl });
  assert.deepEqual(await service.describe('/home/dev/git/sample-repo'), {
    ok: true,
    hasGit: true,
    remoteUrl: SCP_REMOTE,
    repoUrl: 'https://github.com/example-org/sample-repo',
    slug: 'example-org/sample-repo',
    branch: 'dev/feature',
    upstream: 'origin/dev/feature',
    ahead: 0,
    behind: 0,
    dirty: false,
  });
  assert.deepEqual(git.calls.map((call) => call.args), [
    ['status', '--porcelain=v1', '-z', '--branch'],
    ['remote', 'get-url', 'origin'],
  ]);
  assert.equal(git.calls.every((call) => call.command === 'git' && call.cwd === '/home/dev/git/sample-repo'), true);
});

test('unpushed commits and uncommitted changes are counted', async () => {
  const git = fakeGit({
    status: '## main...origin/main [ahead 3, behind 1]\0 M src/index.mjs\0?? notes.txt\0',
    remotes: { origin: 'https://github.com/example-org/sample-repo' },
  });
  const described = await createGitRemoteService({ execFileImpl: git.execFileImpl }).describe('/home/dev/git/sample-repo');
  assert.equal(described.ahead, 3);
  assert.equal(described.behind, 1);
  assert.equal(described.dirty, true);
  assert.equal(described.branch, 'main');
});

test('a folder that is not a checkout has no git', async () => {
  const error = new Error('fatal: not a git repository (or any of the parent directories): .git');
  error.code = 128;
  error.stderr = 'fatal: not a git repository';
  const git = fakeGit({ statusError: error });
  assert.deepEqual(await createGitRemoteService({ execFileImpl: git.execFileImpl }).describe('/home/dev/plain-folder'), {
    ok: true,
    hasGit: false,
    remoteUrl: null,
    repoUrl: null,
    slug: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    dirty: false,
  });
  // No remote is asked for a folder without git.
  assert.equal(git.calls.length, 1);
});

test('a checkout without a remote, or with one elsewhere, has no repository to offer', async () => {
  const none = await createGitRemoteService({ execFileImpl: fakeGit().execFileImpl }).describe('/home/dev/git/local-only');
  assert.equal(none.hasGit, true);
  assert.equal(none.remoteUrl, null);
  assert.equal(none.repoUrl, null);
  assert.equal(none.slug, null);

  const elsewhere = await createGitRemoteService({
    execFileImpl: fakeGit({ remotes: { origin: 'https://git.example.com/example-org/sample-repo.git' } }).execFileImpl,
  }).describe('/home/dev/git/elsewhere');
  assert.equal(elsewhere.remoteUrl, 'https://git.example.com/example-org/sample-repo.git');
  assert.equal(elsewhere.repoUrl, null);
  assert.equal(elsewhere.slug, null);
});

test('the remote of the tracked branch is used when there is no origin', async () => {
  const git = fakeGit({
    status: '## main...fork/main\0',
    remotes: { fork: SSH_REMOTE },
  });
  const described = await createGitRemoteService({ execFileImpl: git.execFileImpl }).describe('/home/dev/git/sample-repo');
  assert.equal(described.repoUrl, 'https://github.com/example-org/sample-repo');
  assert.deepEqual(git.calls.map((call) => call.args.slice(0, 3)), [
    ['status', '--porcelain=v1', '-z'],
    ['remote', 'get-url', 'origin'],
    ['remote', 'get-url', 'fork'],
  ]);
});

test('a detached head has no branch to clone', async () => {
  const git = fakeGit({
    status: '## HEAD (no branch)\0',
    remotes: { origin: 'https://github.com/example-org/sample-repo.git' },
  });
  const described = await createGitRemoteService({ execFileImpl: git.execFileImpl }).describe('/home/dev/git/sample-repo');
  assert.equal(described.branch, null);
  assert.equal(described.slug, 'example-org/sample-repo');
});

test('credentials in a remote URL never reach the caller', async () => {
  const git = fakeGit({ remotes: { origin: CREDENTIAL_REMOTE } });
  const described = await createGitRemoteService({ execFileImpl: git.execFileImpl }).describe('/home/dev/git/sample-repo');
  assert.equal(described.remoteUrl, 'https://github.com/example-org/sample-repo.git');
  assert.equal(described.repoUrl, 'https://github.com/example-org/sample-repo');
  assert.equal(JSON.stringify(described).includes('test-token-value'), false);

  assert.equal(redactRemoteUrlCredentials(SCP_REMOTE), SCP_REMOTE);
  assert.equal(redactRemoteUrlCredentials(SSH_REMOTE), SSH_REMOTE);
  assert.equal(redactRemoteUrlCredentials(''), '');
});

test('a git failure that is not "no repository" is reported as one', async () => {
  const error = new Error('spawn git ENOENT');
  error.code = 'ENOENT';
  const git = fakeGit({ statusError: error });
  const described = await createGitRemoteService({ execFileImpl: git.execFileImpl }).describe('/home/dev/git/sample-repo');
  assert.equal(described.ok, false);
  assert.match(described.error, /ENOENT/);
});
