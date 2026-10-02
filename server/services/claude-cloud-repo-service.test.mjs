'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  CLAUDE_CLOUD_BRANCH_LOOKUP_ENV,
  createClaudeCloudRepoService,
  listRecentCloudSourcesFromStatements,
  parseLsRemoteHeads,
  readBranchLookupSwitch,
  resolveRepositoryInput,
} from './claude-cloud-repo-service.mjs';
import { ClaudeCloudError } from '../../shared/claude-cloud/credentials.mjs';
import { applySchema } from '../db-schema.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { buildCloudSourceRecord } from './claude-cloud-session-service.mjs';

const TOKEN = 'test-token-value';
const SAMPLE_URL = 'https://github.com/example-org/sample-repo';
const DOCS_URL = 'https://github.com/example-org/docs-site';
const TOOL_URL = 'https://github.com/sample-user/tiny-tool';
const OLD_URL = 'https://github.com/sample-user/old-experiment';
const RESULT_KEYS = ['complete', 'error', 'fetchedAt', 'ok', 'repos', 'source'];
const REPO_KEYS = ['accessible', 'archived', 'defaultBranch', 'description', 'name', 'owner', 'private', 'pushedAt', 'recentAt', 'repoUrl', 'slug'];

function listed(owner, name, { defaultBranch = 'main', isPrivate = true, archived = false, pushedAt, description = null } = {}) {
  return {
    owner, name, slug: `${owner}/${name}`, repoUrl: `https://github.com/${owner}/${name}`,
    defaultBranch, private: isPrivate, archived, pushedAt, description,
  };
}

const ANTHROPIC_LIST = [
  listed('example-org', 'sample-repo', { pushedAt: '2031-02-01T10:00:00Z', description: 'Sample service' }),
  listed('example-org', 'docs-site', { defaultBranch: 'trunk', isPrivate: false, pushedAt: '2031-01-15T09:30:00Z', description: 'Documentation' }),
  listed('sample-user', 'tiny-tool', { pushedAt: '2030-12-20T18:00:00Z' }),
];

function setup({
  enabled = true,
  repos = ANTHROPIC_LIST,
  complete = true,
  recent = [],
  gitBranchLookup = true,
  cacheMs = 60_000,
  execFileImpl = () => { throw new Error('git must not run in this test'); },
} = {}) {
  let nowMs = Date.parse('2031-03-01T12:00:00Z');
  const calls = [];
  const warnings = [];
  const cloud = {
    listRepositories: async () => {
      calls.push('listRepositories');
      if (repos instanceof Error) throw repos;
      return { repos, complete, raw: [{}] };
    },
  };
  const service = createClaudeCloudRepoService({
    cloud,
    isEnabled: () => enabled,
    listRecentCloudSources: () => (typeof recent === 'function' ? recent() : recent),
    gitBranchLookup,
    execFileImpl,
    now: () => nowMs,
    cacheMs,
    logger: { warn: (line) => warnings.push(line), log() {} },
  });
  return {
    service,
    calls,
    warnings,
    advance: (ms) => { nowMs += ms; },
    setRepos: (next) => { repos = next; },
    setEnabled: (next) => { enabled = next; },
  };
}

// ── listRepositories ──

test('listRepositories unites the Anthropic list with the recent cloud chats, recent first', async () => {
  const { service, calls } = setup({
    recent: [
      { repoUrl: TOOL_URL, branch: 'main', updatedAt: '2031-02-28T09:00:00Z' },
      { repoUrl: OLD_URL, branch: 'dev/try', updatedAt: '2031-02-20T09:00:00Z' },
      // The same repository in another spelling, from an older chat.
      { repoUrl: 'https://github.com/Sample-User/tiny-tool.git', branch: null, updatedAt: '2031-01-01T00:00:00Z' },
    ],
  });
  const result = await service.listRepositories();
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS);
  assert.equal(result.ok, true);
  assert.equal(result.complete, true);
  assert.equal(result.fetchedAt, '2031-03-01T12:00:00.000Z');
  assert.equal(result.source, 'anthropic');
  assert.equal(result.error, null);
  for (const repo of result.repos) assert.deepEqual(Object.keys(repo).sort(), REPO_KEYS);
  assert.deepEqual(result.repos.map((repo) => [repo.slug, repo.recentAt, repo.accessible]), [
    ['sample-user/tiny-tool', '2031-02-28T09:00:00Z', true],
    ['sample-user/old-experiment', '2031-02-20T09:00:00Z', false],
    ['example-org/sample-repo', null, true],
    ['example-org/docs-site', null, true],
  ]);
  assert.deepEqual(result.repos[0], {
    slug: 'sample-user/tiny-tool', owner: 'sample-user', name: 'tiny-tool', repoUrl: TOOL_URL,
    defaultBranch: 'main', private: true, archived: false, pushedAt: '2030-12-20T18:00:00Z', description: null,
    recentAt: '2031-02-28T09:00:00Z', accessible: true,
  });
  assert.deepEqual(result.repos[1], {
    slug: 'sample-user/old-experiment', owner: 'sample-user', name: 'old-experiment', repoUrl: OLD_URL,
    defaultBranch: null, private: null, archived: null, pushedAt: null, description: null,
    recentAt: '2031-02-20T09:00:00Z', accessible: false,
  });
  assert.equal(result.repos[3].description, 'Documentation');
  assert.deepEqual(calls, ['listRepositories']);
});

test('the rest of the list is sorted by the last push, newest first, the ones without a date last', async () => {
  const { service } = setup({
    repos: [
      listed('example-org', 'undated', { pushedAt: null }),
      listed('example-org', 'older', { pushedAt: '2030-01-01T00:00:00Z' }),
      listed('example-org', 'newer', { pushedAt: '2031-01-01T00:00:00Z' }),
    ],
  });
  const result = await service.listRepositories();
  assert.deepEqual(result.repos.map((repo) => repo.name), ['newer', 'older', 'undated']);
});

test('the Anthropic list is cached for cacheMs; refresh=force reads it again; the recent chats are always fresh', async () => {
  let recent = [];
  const { service, calls, advance } = setup({ recent: () => recent, cacheMs: 60_000 });
  await service.listRepositories();
  recent = [{ repoUrl: DOCS_URL, branch: null, updatedAt: '2031-03-01T11:00:00Z' }];
  advance(30_000);
  const second = await service.listRepositories();
  assert.deepEqual(calls, ['listRepositories'], 'served from the cache');
  assert.equal(second.repos[0].slug, 'example-org/docs-site', 'the new chat is in the list without a refresh');
  assert.equal(second.repos[0].recentAt, '2031-03-01T11:00:00Z');
  assert.equal(second.fetchedAt, '2031-03-01T12:00:00.000Z', 'the time of the cached read');

  await service.listRepositories({ force: true });
  assert.equal(calls.length, 2, 'forced');
  advance(60_001);
  await service.listRepositories();
  assert.equal(calls.length, 3, 'stale');
});

test('two callers at once share one read', async () => {
  const { service, calls } = setup();
  const [a, b] = await Promise.all([service.listRepositories(), service.listRepositories()]);
  assert.deepEqual(calls, ['listRepositories']);
  assert.deepEqual(a, b);
});

test('a failed refresh serves the cached list with the error beside it', async () => {
  const { service, setRepos, advance, warnings } = setup({ cacheMs: 1_000 });
  const first = await service.listRepositories();
  assert.equal(first.error, null);
  setRepos(new ClaudeCloudError('transient', `Claude Cloud could not be reached (Bearer ${TOKEN}).`, { status: 503 }));
  advance(5_000);
  const second = await service.listRepositories();
  assert.equal(second.ok, true);
  assert.equal(second.source, 'anthropic');
  assert.equal(second.repos.length, 3, 'the cached list');
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(second.error.code, 'transient');
  assert.match(second.error.message, /Bearer \[redacted\]/);
  assert.equal(second.error.message.includes(TOKEN), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].includes(TOKEN), false);
});

test('a failed first read answers ok:false with the recent chats alone, their reachability unknown', async () => {
  const { service } = setup({
    repos: new ClaudeCloudError('login_expired', 'The Claude login has run out.', { status: 401 }),
    recent: [{ repoUrl: SAMPLE_URL, branch: 'main', updatedAt: '2031-02-28T09:00:00Z' }],
  });
  const result = await service.listRepositories();
  assert.deepEqual(Object.keys(result).sort(), RESULT_KEYS);
  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.fetchedAt, null);
  assert.equal(result.source, 'recent');
  assert.deepEqual(result.error, { code: 'login_expired', message: 'The Claude login has run out.' });
  assert.deepEqual(result.repos.map((repo) => [repo.slug, repo.accessible, repo.recentAt]), [['example-org/sample-repo', null, '2031-02-28T09:00:00Z']]);
});

test('an error that is not the client\'s is reported without its text', async () => {
  const { service } = setup({ repos: new Error(`ECONNRESET while sending ${TOKEN}`) });
  const result = await service.listRepositories();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'error');
  assert.equal(result.error.message.includes(TOKEN), false);
  assert.equal(result.error.message, 'The repositories could not be read from Claude Cloud.');
});

test('a list the API calls incomplete is passed on as such', async () => {
  const { service } = setup({ complete: false });
  assert.equal((await service.listRepositories()).complete, false);
});

test('while the provider is off nothing is read and the cache is dropped', async () => {
  const { service, calls, setEnabled } = setup({ recent: [{ repoUrl: SAMPLE_URL, branch: null, updatedAt: '2031-02-28T09:00:00Z' }] });
  await service.listRepositories();
  assert.equal(calls.length, 1);
  setEnabled(false);
  const off = await service.listRepositories();
  assert.deepEqual(off, {
    ok: false,
    repos: [],
    complete: false,
    fetchedAt: null,
    source: null,
    error: { code: 'claude_cloud_disabled', message: 'Claude Cloud is switched off.' },
  });
  assert.equal(calls.length, 1, 'not asked');
  setEnabled(true);
  await service.listRepositories();
  assert.equal(calls.length, 2, 'the cache did not survive the switch');
});

test('recent sources that are not GitHub repositories are skipped, and a failing reader is not fatal', async () => {
  const { service, warnings } = setup({
    recent: [
      { repoUrl: 'https://gitlab.example.com/group/project', branch: null, updatedAt: '2031-02-28T09:00:00Z' },
      { repoUrl: '', branch: null, updatedAt: '2031-02-27T09:00:00Z' },
      null,
    ],
  });
  const result = await service.listRepositories();
  assert.equal(result.repos.every((repo) => repo.recentAt === null), true);

  const failing = setup({ recent: () => { throw new Error('no table'); } });
  const again = await failing.service.listRepositories();
  assert.equal(again.ok, true);
  assert.equal(again.repos.length, 3);
  assert.equal(failing.warnings.length, 1);
  assert.equal(warnings.length, 0);
});

// ── the recent sources from the repository ──

test('listRecentCloudSourcesFromStatements reads the stored cloud sources, newest first, and skips what names no repository', () => {
  const db = new Database(':memory:');
  applySchema(db);
  const stmts = createSessionRepository(db);
  assert.ok(stmts.listRecentCloudSources, 'the guarded statement exists on the current schema');
  stmts.insertConv.run('conv-old', 'Older cloud chat', '2031-02-01T00:00:00.000Z', '2031-02-01T00:00:00.000Z');
  stmts.updateConvCloudSource.run(JSON.stringify(buildCloudSourceRecord({ repoUrl: SAMPLE_URL, branch: 'main' })), 'conv-old');
  stmts.insertConv.run('conv-new', 'Newer cloud chat', '2031-02-02T00:00:00.000Z', '2031-02-02T00:00:00.000Z');
  stmts.updateConvCloudSource.run(JSON.stringify(buildCloudSourceRecord({ repoUrl: DOCS_URL, branch: null })), 'conv-new');
  stmts.insertConv.run('conv-plain', 'A local chat', '2031-02-03T00:00:00.000Z', '2031-02-03T00:00:00.000Z');
  stmts.insertConv.run('conv-broken', 'Broken record', '2031-02-04T00:00:00.000Z', '2031-02-04T00:00:00.000Z');
  stmts.updateConvCloudSource.run('{"repoUrl": "not a url"}', 'conv-broken');
  stmts.insertConv.run('conv-gone', 'Deleted chat', '2031-02-05T00:00:00.000Z', '2031-02-05T00:00:00.000Z');
  stmts.updateConvCloudSource.run(JSON.stringify(buildCloudSourceRecord({ repoUrl: TOOL_URL })), 'conv-gone');
  db.prepare(`UPDATE conversations SET status = 'deleted' WHERE id = ?`).run('conv-gone');

  assert.deepEqual(listRecentCloudSourcesFromStatements(stmts), [
    { repoUrl: DOCS_URL, branch: null, updatedAt: '2031-02-02T00:00:00.000Z' },
    { repoUrl: SAMPLE_URL, branch: 'main', updatedAt: '2031-02-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(listRecentCloudSourcesFromStatements({ listRecentCloudSources: null }), [], 'an older schema');
  assert.deepEqual(listRecentCloudSourcesFromStatements(null), []);
});

// ── listBranches ──

/** An execFile that answers every call from `answer` and records the calls. */
function fakeExecFile(answer) {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    const result = typeof answer === 'function' ? answer({ file, args, options }) : answer;
    setImmediate(() => callback(result.error || null, result.stdout || '', result.stderr || ''));
  };
  execFileImpl.calls = calls;
  return execFileImpl;
}

const LS_REMOTE_OUTPUT = [
  'ref: refs/heads/trunk\tHEAD',
  '1111111111111111111111111111111111111111\tHEAD',
  '2222222222222222222222222222222222222222\trefs/heads/dev/zeta',
  '3333333333333333333333333333333333333333\trefs/heads/trunk',
  '4444444444444444444444444444444444444444\trefs/heads/alpha',
  '5555555555555555555555555555555555555555\trefs/heads/bad..name',
  '',
].join('\n');

test('listBranches runs git ls-remote on the https URL without a shell or a prompt and parses the heads', async () => {
  const execFileImpl = fakeExecFile({ stdout: LS_REMOTE_OUTPUT });
  const { service } = setup({ execFileImpl });
  const result = await service.listBranches('example-org/sample-repo');
  assert.deepEqual(result, {
    ok: true,
    slug: 'example-org/sample-repo',
    repoUrl: SAMPLE_URL,
    branches: ['trunk', 'alpha', 'dev/zeta'],
    defaultBranch: 'trunk',
  });
  assert.equal(execFileImpl.calls.length, 1);
  const [call] = execFileImpl.calls;
  assert.equal(call.file, 'git');
  assert.deepEqual(call.args, ['ls-remote', '--symref', SAMPLE_URL, 'HEAD', 'refs/heads/*']);
  assert.equal(call.options.shell, undefined);
  assert.equal(call.options.timeout, 15_000);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(typeof call.options.env.GIT_ASKPASS, 'string');
  assert.equal(call.options.env.GCM_INTERACTIVE, 'never');
  assert.equal(call.options.env.PATH, process.env.PATH, 'git is found as the relay finds it');
});

test('listBranches accepts every spelling normalizeGitHubRepoUrl does and refuses the rest without running git', async () => {
  const execFileImpl = fakeExecFile({ stdout: 'ref: refs/heads/main\tHEAD\n1111111111111111111111111111111111111111\trefs/heads/main\n' });
  const { service } = setup({ execFileImpl });
  // Built from its halves: the hygiene guard reads `user@host` as an e-mail address.
  const scp = ['git', 'github.com:example-org/sample-repo.git'].join('@');
  for (const input of ['example-org/sample-repo', SAMPLE_URL, `${SAMPLE_URL}.git`, scp, 'github.com/example-org/sample-repo/']) {
    const result = await service.listBranches(input);
    assert.equal(result.ok, true, input);
    assert.equal(result.repoUrl, SAMPLE_URL, input);
  }
  assert.equal(execFileImpl.calls.length, 5);
  for (const input of ['', '   ', 'https://gitlab.example.com/group/project', 'https://github.com/example-org', 'example-org/sample repo', 'example.com/project', 'owner/', null, 42]) {
    const result = await service.listBranches(input);
    assert.deepEqual(result, {
      ok: false,
      slug: null,
      error: { code: 'invalid_repo', message: 'A GitHub repository (owner/name or its URL) is required.' },
    }, String(input));
  }
  assert.equal(execFileImpl.calls.length, 5, 'git did not run for the refused ones');
});

test('resolveRepositoryInput reads a bare slug as a GitHub repository and leaves URLs to the URL rules', () => {
  assert.equal(resolveRepositoryInput('example-org/sample-repo')?.repoUrl, SAMPLE_URL);
  assert.equal(resolveRepositoryInput(' Sample-User/tiny.tool ')?.slug, 'Sample-User/tiny.tool');
  assert.equal(resolveRepositoryInput('https://github.com/example-org/sample-repo/')?.slug, 'example-org/sample-repo');
  assert.equal(resolveRepositoryInput('example.com/project'), null, 'a host, not an owner');
  assert.equal(resolveRepositoryInput('example-org/sample-repo/tree/main'), null);
  assert.equal(resolveRepositoryInput(''), null);
});

test('a remote git cannot read is unreachable, with git\'s own words and no credentials', async () => {
  // Built from its halves: the hygiene guard reads `user:secret@host` as an e-mail address.
  const credentialedUrl = ['https://user:secret-value', 'github.com/example-org/sample-repo/'].join('@');
  const execFileImpl = fakeExecFile({
    error: Object.assign(new Error('Command failed'), { code: 128, killed: false, signal: null }),
    stderr: `remote: Repository not found.\nfatal: repository '${credentialedUrl}' not found\n`,
  });
  const { service } = setup({ execFileImpl });
  const result = await service.listBranches(SAMPLE_URL);
  assert.deepEqual(result, {
    ok: false,
    slug: 'example-org/sample-repo',
    error: { code: 'unreachable', message: "repository 'https://github.com/example-org/sample-repo/' not found" },
  });
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('a git that says nothing, or that is not installed, is unreachable with a message of our own', async () => {
  const silent = setup({ execFileImpl: fakeExecFile({ error: Object.assign(new Error('Command failed'), { code: 1, killed: false }) }) });
  assert.deepEqual((await silent.service.listBranches(SAMPLE_URL)).error, {
    code: 'unreachable',
    message: 'The branches of example-org/sample-repo could not be read.',
  });
  const missing = setup({ execFileImpl: fakeExecFile({ error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }) });
  assert.deepEqual((await missing.service.listBranches(SAMPLE_URL)).error, {
    code: 'unreachable',
    message: 'git is not installed on this host.',
  });
  const throwing = setup({ execFileImpl: () => { throw new Error('spawn refused'); } });
  assert.equal((await throwing.service.listBranches(SAMPLE_URL)).error.code, 'unreachable');
});

test('a ls-remote that runs into the timeout is reported as such', async () => {
  const execFileImpl = fakeExecFile({ error: Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }) });
  const { service } = setup({ execFileImpl });
  assert.deepEqual(await service.listBranches(SAMPLE_URL), {
    ok: false,
    slug: 'example-org/sample-repo',
    error: { code: 'timeout', message: 'GitHub did not answer within 15 s.' },
  });
});

test('an empty repository has no branches and no default', async () => {
  const { service } = setup({ execFileImpl: fakeExecFile({ stdout: '' }) });
  assert.deepEqual(await service.listBranches(SAMPLE_URL), {
    ok: true, slug: 'example-org/sample-repo', repoUrl: SAMPLE_URL, branches: [], defaultBranch: null,
  });
});

test('parseLsRemoteHeads puts the default first, sorts the rest, drops invalid names and caps the list at 500', () => {
  const many = Array.from({ length: 600 }, (_, index) => `${String(index).padStart(40, '0')}\trefs/heads/branch-${String(index).padStart(4, '0')}`);
  const parsed = parseLsRemoteHeads(['ref: refs/heads/branch-0599\tHEAD', ...many].join('\n'));
  assert.equal(parsed.defaultBranch, 'branch-0599');
  assert.equal(parsed.branches.length, 500);
  assert.equal(parsed.branches[0], 'branch-0599');
  assert.equal(parsed.branches[1], 'branch-0000');
  assert.equal(parsed.branches.includes('branch-0598'), false, 'past the cap');

  const detached = parseLsRemoteHeads('1111111111111111111111111111111111111111\trefs/heads/only\r\n');
  assert.deepEqual(detached, { branches: ['only'], defaultBranch: null });
  // A symref to a branch that has no head line of its own (should not happen) is still the default.
  const dangling = parseLsRemoteHeads('ref: refs/heads/main\tHEAD\n1111111111111111111111111111111111111111\trefs/heads/dev\n');
  assert.deepEqual(dangling, { branches: ['dev'], defaultBranch: 'main' });
});

// ── the environment switch ──

test('OAR_CLAUDE_CLOUD_BRANCH_LOOKUP=off turns the branch lookup off without running git', async () => {
  assert.equal(CLAUDE_CLOUD_BRANCH_LOOKUP_ENV, 'OAR_CLAUDE_CLOUD_BRANCH_LOOKUP');
  assert.equal(readBranchLookupSwitch({}), true, 'on by default');
  assert.equal(readBranchLookupSwitch({ OAR_CLAUDE_CLOUD_BRANCH_LOOKUP: 'off' }), false);
  assert.equal(readBranchLookupSwitch({ OAR_CLAUDE_CLOUD_BRANCH_LOOKUP: 'OFF ' }), false);
  assert.equal(readBranchLookupSwitch({ OAR_CLAUDE_CLOUD_BRANCH_LOOKUP: '0' }), false);
  assert.equal(readBranchLookupSwitch({ OAR_CLAUDE_CLOUD_BRANCH_LOOKUP: 'on' }), true);
  assert.equal(readBranchLookupSwitch(undefined), true);

  const execFileImpl = fakeExecFile({ stdout: 'ref: refs/heads/main\tHEAD\n' });
  const off = setup({ execFileImpl, gitBranchLookup: readBranchLookupSwitch({ OAR_CLAUDE_CLOUD_BRANCH_LOOKUP: 'off' }) });
  assert.deepEqual(await off.service.listBranches(SAMPLE_URL), {
    ok: false,
    slug: 'example-org/sample-repo',
    error: { code: 'disabled', message: 'Branch lookup is switched off on this relay.' },
  });
  // An invalid repository is still the caller's mistake first.
  assert.equal((await off.service.listBranches('nonsense')).error.code, 'invalid_repo');
  assert.equal(execFileImpl.calls.length, 0);
});

test('the switch is read from the process environment when none is injected', async () => {
  const previous = process.env.OAR_CLAUDE_CLOUD_BRANCH_LOOKUP;
  process.env.OAR_CLAUDE_CLOUD_BRANCH_LOOKUP = 'off';
  try {
    const execFileImpl = fakeExecFile({ stdout: '' });
    const service = createClaudeCloudRepoService({ execFileImpl, logger: { warn() {} } });
    assert.equal((await service.listBranches(SAMPLE_URL)).error.code, 'disabled');
    assert.equal(execFileImpl.calls.length, 0);
  } finally {
    if (previous === undefined) delete process.env.OAR_CLAUDE_CLOUD_BRANCH_LOOKUP;
    else process.env.OAR_CLAUDE_CLOUD_BRANCH_LOOKUP = previous;
  }
});
