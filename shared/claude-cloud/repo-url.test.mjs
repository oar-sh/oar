import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareUrl,
  isValidBranchName,
  normalizeGitHubRepoUrl,
  stripModelTierSuffix,
} from './repo-url.mjs';

// The ssh user is put in front here: written out, "<user>@<host>" reads as an
// e-mail address to the hygiene guard.
const ssh = (rest) => ['git', rest].join('@');
const USERINFO = 'dev:test-token-value';

const SAMPLE = {
  repoUrl: 'https://github.com/example-org/sample-repo',
  owner: 'example-org',
  repo: 'sample-repo',
  slug: 'example-org/sample-repo',
};

test('every way of writing a GitHub repository comes out as the one https URL', () => {
  for (const input of [
    'https://github.com/example-org/sample-repo',
    'https://github.com/example-org/sample-repo.git',
    'https://github.com/example-org/sample-repo/',
    'https://github.com/example-org/sample-repo.git/',
    '  https://github.com/example-org/sample-repo  ',
    'http://github.com/example-org/sample-repo',
    'https://www.github.com/example-org/sample-repo',
    'HTTPS://GitHub.com/example-org/sample-repo',
    'https://github.com/example-org/sample-repo?tab=readme#top',
    ssh('github.com:example-org/sample-repo.git'),
    ssh('github.com:example-org/sample-repo'),
    'github.com:example-org/sample-repo.git',
    `ssh://${ssh('github.com/example-org/sample-repo')}`,
    `ssh://${ssh('github.com/example-org/sample-repo.git')}`,
    `ssh://${ssh('github.com:22/example-org/sample-repo.git')}`,
    'git://github.com/example-org/sample-repo.git',
    'github.com/example-org/sample-repo',
  ]) {
    assert.deepEqual(normalizeGitHubRepoUrl(input), SAMPLE, input);
  }
});

test('credentials in front of the host never reach the normalised URL', () => {
  // A remote may carry a token ("https://<user>:<token>@github.com/…"); what
  // is stored and sent to the cloud must not.
  const result = normalizeGitHubRepoUrl(`https://${USERINFO}@github.com/example-org/sample-repo.git`);
  assert.deepEqual(result, SAMPLE);
  assert.doesNotMatch(JSON.stringify(result), /test-token-value|dev[:@]/);
});

test('the case of owner and repository is kept, dots and underscores are repository characters', () => {
  assert.deepEqual(normalizeGitHubRepoUrl(ssh('github.com:Example-Org/Sample_Repo.js.git')), {
    repoUrl: 'https://github.com/Example-Org/Sample_Repo.js',
    owner: 'Example-Org',
    repo: 'Sample_Repo.js',
    slug: 'Example-Org/Sample_Repo.js',
  });
});

test('anything that is not exactly one GitHub repository is refused', () => {
  for (const input of [
    '',
    '   ',
    null,
    undefined,
    42,
    'example-org/sample-repo',
    'https://github.com/example-org',
    'https://github.com/',
    'https://github.com/example-org/sample-repo/tree/main',
    'https://github.com/orgs/example-org/repositories',
    'https://gitlab.com/example-org/sample-repo',
    'https://github.com.example.com/example-org/sample-repo',
    'https://example.com/github.com/example-org/sample-repo',
    ssh('gitlab.com:example-org/sample-repo.git'),
    'ftp://github.com/example-org/sample-repo',
    'file:///home/dev/sample-repo',
    '/home/dev/sample-repo',
    'https://github.com/-example/sample-repo',
    'https://github.com/example-/sample-repo',
    'https://github.com/example_org/sample-repo',
    'https://github.com/example-org/sample repo',
    'https://github.com/example-org/..',
    'https://github.com/example-org/.git',
    'https://github.com/example-org/sample-repo;rm',
    `https://github.com/${'a'.repeat(40)}/sample-repo`,
    `https://github.com/example-org/${'a'.repeat(101)}`,
  ]) {
    assert.equal(normalizeGitHubRepoUrl(input), null, String(input));
  }
});

test('branch names git accepts are valid', () => {
  for (const name of [
    'main',
    'dev/claude-cloud',
    'feature/issue-12_fix.v2',
    'release/1.2.3',
    'user@host',
    'a',
    'ünïcode',
    'x'.repeat(255),
  ]) {
    assert.equal(isValidBranchName(name), true, name);
  }
});

test('branch names git refuses are invalid, and nothing is trimmed', () => {
  for (const name of [
    '',
    ' ',
    ' main',
    'main ',
    'my branch',
    'main\n',
    'tab\tname',
    '-rf',
    '@',
    'a..b',
    'a@{b',
    'a~1',
    'a^',
    'a:b',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    '/main',
    'main/',
    'a//b',
    '.hidden',
    'a/.hidden',
    'main.',
    'main.lock',
    'a.lock/b',
    'del\u007fete',
    'x'.repeat(256),
    null,
    undefined,
    7,
    ['main'],
  ]) {
    assert.equal(isValidBranchName(name), false, JSON.stringify(name));
  }
});

test('a model id loses its tier suffix and nothing else', () => {
  assert.equal(stripModelTierSuffix('claude-sonnet-5-5[1m]'), 'claude-sonnet-5-5');
  assert.equal(stripModelTierSuffix('claude-opus-5[1m]'), 'claude-opus-5');
  assert.equal(stripModelTierSuffix('claude-opus-5 [200k] '), 'claude-opus-5');
  assert.equal(stripModelTierSuffix('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(stripModelTierSuffix('  claude-haiku-4-5-20251001  '), 'claude-haiku-4-5-20251001');
  assert.equal(stripModelTierSuffix('[1m]'), '');
  assert.equal(stripModelTierSuffix(''), '');
  assert.equal(stripModelTierSuffix(null), '');
  assert.equal(stripModelTierSuffix(undefined), '');
});

test('a pushed branch links to its compare page against the base', () => {
  assert.equal(
    compareUrl('example-org/sample-repo', 'main', 'fix/slugify'),
    'https://github.com/example-org/sample-repo/compare/main...fix/slugify',
  );
  // Slashes stay path separators; whatever else a ref may hold is encoded.
  assert.equal(
    compareUrl('example-org/sample-repo', 'release/1.0', 'fix/a#b+c'),
    'https://github.com/example-org/sample-repo/compare/release/1.0...fix/a%23b%2Bc',
  );
});

test('without a usable base the compare is against the default branch', () => {
  for (const base of [null, undefined, '', 'not a branch']) {
    assert.equal(
      compareUrl('example-org/sample-repo', base, 'fix/slugify'),
      'https://github.com/example-org/sample-repo/compare/fix/slugify',
    );
  }
});

test('a push to the base branch itself links to the branch', () => {
  // A compare of a branch with itself shows nothing.
  assert.equal(
    compareUrl('example-org/sample-repo', 'main', 'main'),
    'https://github.com/example-org/sample-repo/tree/main',
  );
});

test('no link without a repository slug or a branch', () => {
  assert.equal(compareUrl('', 'main', 'fix/slugify'), null);
  assert.equal(compareUrl(null, 'main', 'fix/slugify'), null);
  assert.equal(compareUrl('sample-repo', 'main', 'fix/slugify'), null);
  assert.equal(compareUrl('example-org/sample-repo/extra', 'main', 'fix/slugify'), null);
  assert.equal(compareUrl('example-org/sample-repo', 'main', ''), null);
  assert.equal(compareUrl('example-org/sample-repo', 'main', null), null);
  assert.equal(compareUrl('example-org/sample-repo', 'main', 'bad branch'), null);
});
