import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePublicRefs,
  isPublicRemote,
  parseRefLines,
  runPrePush,
  scanLogOutput,
  scanPushedCommits,
} from './pre-push.mjs';
import { buildDenylistPatterns, SECRET_PATTERNS } from './hygiene-patterns.mjs';
import { createSandbox, hasGit } from './git-test-helpers.mjs';

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// Synthetic private names, the same ones the suite guard pins its patterns on.
const PATTERNS = [...buildDenylistPatterns(['acme-internal', 'corp.example9']), ...SECRET_PATTERNS];

test('parseRefLines reads the four fields git feeds the hook', () => {
  const refs = parseRefLines(`refs/heads/dev/x ${A} refs/heads/dev/x ${ZERO}\n\n(delete) ${ZERO} refs/heads/old ${B}\n`);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { localRef: 'refs/heads/dev/x', localSha: A, remoteRef: 'refs/heads/dev/x', remoteSha: ZERO });
  assert.equal(refs[1].remoteRef, 'refs/heads/old');
});

test('isPublicRemote recognises the public repository in its URL forms only', () => {
  const env = {};
  assert.equal(isPublicRemote('https://github.com/oar-sh/oar.git', env), true);
  assert.equal(isPublicRemote('https://github.com/oar-sh/oar', env), true);
  assert.equal(isPublicRemote('ssh://github.com/oar-sh/oar.git', env), true);
  assert.equal(isPublicRemote('https://github.com/oar-sh/oar-work.git', env), false, 'the private remote is not public');
  assert.equal(isPublicRemote('https://github.com/example-org/oar.git', env), false);
  assert.equal(isPublicRemote('/srv/git/public.git', { OAR_PUBLIC_REMOTE_RE: 'public\\.git$' }), true, 'overridable');
});

test('the public remote takes main and tags, and deletions of anything', () => {
  const ok = evaluatePublicRefs([
    { localRef: 'refs/heads/main', localSha: B, remoteRef: 'refs/heads/main', remoteSha: A },
    { localRef: 'refs/tags/v1.0.0', localSha: B, remoteRef: 'refs/tags/v1.0.0', remoteSha: ZERO },
    { localRef: '(delete)', localSha: ZERO, remoteRef: 'refs/heads/dev', remoteSha: A },
  ], { env: {}, isAncestor: () => true });
  assert.deepEqual(ok, []);
});

test('a topic branch is refused on the public remote, with the way out in the message', () => {
  const refs = [{ localRef: 'refs/heads/dev/x', localSha: B, remoteRef: 'refs/heads/dev/x', remoteSha: ZERO }];
  const violations = evaluatePublicRefs(refs, { env: {}, isAncestor: () => true });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /only main and tags/);
  assert.match(violations[0], /git push work/);
  assert.deepEqual(evaluatePublicRefs(refs, { env: { OAR_ALLOW_PUBLIC_BRANCH: '1' }, isAncestor: () => true }), []);
});

test('rewriting the public main is refused unless explicitly allowed', () => {
  const refs = [{ localRef: 'refs/heads/main', localSha: B, remoteRef: 'refs/heads/main', remoteSha: A }];
  const violations = evaluatePublicRefs(refs, { env: {}, isAncestor: () => false });
  assert.match(violations[0], /rewrite published history/);
  assert.deepEqual(evaluatePublicRefs(refs, { env: { OAR_ALLOW_PUBLIC_REWRITE: '1' }, isAncestor: () => false }), []);
});

test('scanLogOutput flags added lines and commit messages, not removals or headers', () => {
  const log = [
    `commit ${A}`,
    'Author: Dev <dev@example.com>',
    'Name the acme-internal board in the fixture',
    '',
    'diff --git a/server/x.test.mjs b/server/x.test.mjs',
    '--- a/server/x.test.mjs',
    '+++ b/server/x.test.mjs',
    '@@ -1 +1,2 @@',
    "-const old = 'acme-internal';",
    "+const title = 'acme-internal';",
    "+const fine = 'report builder';",
    'diff --git a/package-lock.json b/package-lock.json',
    '+  "resolved": "https://relay.corp.example9/x.tgz"',
  ].join('\n');
  const findings = scanLogOutput(log, PATTERNS);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].file, null, 'the commit message');
  assert.equal(findings[1].file, 'server/x.test.mjs');
  assert.match(findings[1].label, /acme-internal/);
});

test('runPrePush: deletions only need no checks at all', () => {
  const code = runPrePush({
    remoteName: 'origin',
    remoteUrl: 'https://github.com/oar-sh/oar.git',
    stdin: `(delete) ${ZERO} refs/heads/dev ${A}\n`,
    env: {},
    log: () => {},
    runHygieneGuard: () => { throw new Error('must not run'); },
  });
  assert.equal(code, 0);
});

test('runPrePush: a failing hygiene guard blocks a push to the private remote too', () => {
  const lines = [];
  const code = runPrePush({
    remoteName: 'work',
    remoteUrl: 'https://github.com/example-org/demo-work.git',
    stdin: `refs/heads/dev/x ${B} refs/heads/dev/x ${ZERO}\n`,
    env: {},
    log: (line) => lines.push(line),
    runHygieneGuard: () => false,
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /hygiene guard failed/);
});

test('runPrePush: a topic branch never reaches the guard when aimed at the public remote', () => {
  const lines = [];
  const code = runPrePush({
    remoteName: 'origin',
    remoteUrl: 'https://github.com/oar-sh/oar.git',
    stdin: `refs/heads/dev/x ${B} refs/heads/dev/x ${ZERO}\n`,
    env: {},
    log: (line) => lines.push(line),
    runHygieneGuard: () => { throw new Error('must not run'); },
  });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /refusing to push to the public remote/);
});

test('scanPushedCommits reads the real range from a repository', { skip: !hasGit() }, () => {
  const box = createSandbox();
  try {
    const base = box.git('rev-parse', 'HEAD');
    box.commit('notes.md', 'plain text\n', 'Add notes');
    const leak = box.commit('server/fixture.mjs', "export const title = 'acme-internal';\n", 'Add a fixture');
    box.commit('server/fixture.mjs', "export const title = 'report builder';\n", 'Use a fictional title');
    const tip = box.git('rev-parse', 'HEAD');

    const refs = [{ localRef: 'refs/heads/main', localSha: tip, remoteRef: 'refs/heads/main', remoteSha: base }];
    const findings = scanPushedCommits(refs, { remoteName: 'origin', cwd: box.repo, patterns: PATTERNS });
    // The clean-up commit does not help: the leaking commit is still published.
    assert.equal(findings.length, 1);
    assert.equal(findings[0].commit, leak.slice(0, 7));
    assert.equal(findings[0].file, 'server/fixture.mjs');

    const code = runPrePush({
      remoteName: 'origin',
      remoteUrl: 'https://github.com/oar-sh/oar.git',
      stdin: `refs/heads/main ${tip} refs/heads/main ${base}\n`,
      cwd: box.repo,
      env: {},
      log: () => {},
      runHygieneGuard: () => true,
      patterns: PATTERNS,
    });
    assert.equal(code, 1, 'the push is refused');
  } finally {
    box.cleanup();
  }
});

test('a new ref is scanned only for commits the remote does not have yet', { skip: !hasGit() }, () => {
  const box = createSandbox();
  try {
    box.git('switch', '-q', '-c', 'dev/topic');
    box.commit('a.md', 'one\n', 'Add a');
    const tip = box.git('rev-parse', 'HEAD');
    const refs = [{ localRef: 'refs/heads/dev/topic', localSha: tip, remoteRef: 'refs/heads/dev/topic', remoteSha: ZERO }];
    const seen = [];
    const patterns = [{ label: 'any added line', re: { test: (line) => { seen.push(line); return false; } } }];
    scanPushedCommits(refs, { remoteName: 'origin', cwd: box.repo, patterns });
    assert.ok(seen.includes('one'), 'the new commit was scanned');
    assert.equal(seen.includes('demo'), false, 'the commit already on the remote was not');
  } finally {
    box.cleanup();
  }
});
