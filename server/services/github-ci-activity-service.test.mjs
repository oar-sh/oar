import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGitHubCiActivityService,
  parseGitHubRepoSlug,
  isOpenCiRunStatus,
} from './github-ci-activity-service.mjs';

test('parseGitHubRepoSlug handles scp-style, ssh, https, .git and trailing slashes', () => {
  // Fictional hosts/users only; the scp form is spelled without a user part.
  assert.equal(parseGitHubRepoSlug('github.com:example-org/demo.git'), 'example-org/demo');
  assert.equal(parseGitHubRepoSlug('https://github.com/example-org/demo'), 'example-org/demo');
  assert.equal(parseGitHubRepoSlug('https://github.com/example-org/demo.git/'), 'example-org/demo');
  assert.equal(parseGitHubRepoSlug('ssh://github.com/example-org/demo.git'), 'example-org/demo');
  assert.equal(parseGitHubRepoSlug('https://gitlab.example.com/x/y.git'), null);
  assert.equal(parseGitHubRepoSlug(''), null);
});

test('isOpenCiRunStatus: only completed runs are closed', () => {
  assert.equal(isOpenCiRunStatus('completed'), false);
  assert.equal(isOpenCiRunStatus('in_progress'), true);
  assert.equal(isOpenCiRunStatus('queued'), true);
  assert.equal(isOpenCiRunStatus(''), false);
});

// execFile stand-in keyed by the command; records calls for cache assertions.
function makeExec(handlers) {
  const calls = [];
  const execFileImpl = (file, args, _opts, cb) => {
    calls.push([file, ...args]);
    const handler = handlers[file];
    try {
      const out = handler(args);
      queueMicrotask(() => cb(null, out, ''));
    } catch (error) {
      queueMicrotask(() => cb(error, '', error.message));
    }
  };
  return { execFileImpl, calls };
}

test('describeRuns: resolves slugs per root, dedupes repos, reports open runs as a blocker', async () => {
  let nowMs = 0;
  const { execFileImpl, calls } = makeExec({
    git: (args) => (args.includes('C:/work/demo') || args.includes('C:/work/demo-wt') ? 'https://github.com/example-org/demo.git\n' : 'https://example.com/other.git\n'),
    gh: () => JSON.stringify([
      { status: 'in_progress', name: 'CI', headBranch: 'feature/export', databaseId: 1 },
      { status: 'completed', name: 'Nightly', headBranch: 'main', databaseId: 2 },
    ]),
  });
  const service = createGitHubCiActivityService({ execFileImpl, now: () => nowMs, logger: { warn() {} } });
  const result = await service.describeRuns(['C:/work/demo', 'C:/work/demo-wt', 'C:/other']);
  assert.equal(result.repos.length, 1);
  assert.equal(result.repos[0].repo, 'example-org/demo');
  assert.equal(result.repos[0].runs.length, 1);
  assert.equal(result.blockers.length, 1);
  assert.equal(result.blockers[0].kind, 'ci');
  assert.match(result.blockers[0].detail, /CI on feature\/export \(in_progress\)/);
  assert.equal(calls.filter((c) => c[0] === 'gh').length, 1, 'one gh call for two roots of the same repo');

  // Within the cache window a second call does not hit gh again.
  nowMs = 5_000;
  await service.describeRuns(['C:/work/demo']);
  assert.equal(calls.filter((c) => c[0] === 'gh').length, 1);
  nowMs = 30_000;
  await service.describeRuns(['C:/work/demo']);
  assert.equal(calls.filter((c) => c[0] === 'gh').length, 2);
});

test('describeRuns: gh failure is unknown (blocks) until the grace period passes', async () => {
  let nowMs = 0;
  const { execFileImpl } = makeExec({
    git: () => 'https://github.com/o/r.git',
    gh: () => { throw new Error('gh: not logged in'); },
  });
  const service = createGitHubCiActivityService({ execFileImpl, now: () => nowMs, cacheMs: 1000, unknownGraceMs: 60_000, logger: { warn() {} } });
  const first = await service.describeRuns(['C:/r']);
  assert.equal(first.unknown.length, 1);
  assert.equal(first.unknown[0].ignored, false);
  assert.equal(first.blockers[0].kind, 'ci-unknown');
  nowMs = 61_000;
  const later = await service.describeRuns(['C:/r']);
  assert.equal(later.unknown[0].ignored, true);
  assert.equal(later.blockers.length, 0, 'no longer blocks after the grace period');
});

test('snapshot: unresolved roots count as checking; resolved ones reuse the last fetch', async () => {
  const { execFileImpl } = makeExec({
    git: () => 'https://github.com/o/r',
    gh: () => JSON.stringify([{ status: 'queued', name: 'CI', headBranch: 'main', databaseId: 9 }]),
  });
  const service = createGitHubCiActivityService({ execFileImpl, logger: { warn() {} } });
  const before = service.snapshot(['C:/r']);
  assert.equal(before.blockers.length, 1);
  assert.equal(before.blockers[0].kind, 'ci-checking');
  // Nine busy conversations in one workspace are one workspace to check.
  const shared = service.snapshot(['C:/r', 'C:/r', ' C:/r ']);
  assert.equal(shared.blockers[0].count, 1);
  assert.match(shared.blockers[0].detail, /of 1 workspace$/);
  await service.describeRuns(['C:/r']);
  const after = service.snapshot(['C:/r']);
  assert.equal(after.blockers.length, 1);
  assert.equal(after.blockers[0].kind, 'ci');
  assert.equal(after.repos[0].runs[0].status, 'queued');
});

test('non-GitHub roots produce no blockers at all', async () => {
  const { execFileImpl, calls } = makeExec({ git: () => { throw new Error('fatal: no such remote'); }, gh: () => '[]' });
  const service = createGitHubCiActivityService({ execFileImpl, logger: { warn() {} } });
  const result = await service.describeRuns(['C:/local-only']);
  assert.deepEqual(result.blockers, []);
  assert.equal(calls.some((c) => c[0] === 'gh'), false);
});
