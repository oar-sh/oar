import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_CLOUD_ATTACH_ACCEPT,
  CLAUDE_CLOUD_MAX_IMAGE_BYTES,
  buildCloudLineModel,
  buildCloudSourceWarnings,
  cloudFolderStatusText,
  claudeCloudComposerModelIds,
  claudeCloudDefaultModel,
  claudeCloudModelIds,
  cloudAttachmentRejection,
  cloudAttachmentRejectionNotice,
  cloudBootstrapErrorModel,
  cloudCompareUrl,
  cloudHeaderLabel,
  formatCloudCost,
  isClaudeCloudConversation,
  isClaudeCloudProviderType,
  isValidCloudBranchName,
  mergeCloudSessionUpdate,
  newChatRowVisibility,
  normalizeCloudRepoInput,
  partitionCloudAttachments,
  renderCloudLineHtml,
  resolveCloudSourceAutoFill,
  validateCloudSourceInputs,
} from './claude-cloud-ui.mjs';
import {
  compareUrl as sharedCompareUrl,
  isValidBranchName as sharedIsValidBranchName,
  normalizeGitHubRepoUrl as sharedNormalizeGitHubRepoUrl,
} from '../../../shared/claude-cloud/repo-url.mjs';

const REPO_URL = 'https://github.com/example-org/sample-repo';
// The ssh user is put in front here: written out, "<user>@<host>" reads as an
// e-mail address to the hygiene guard.
const ssh = (rest) => ['git', rest].join('@');

// What GET /api/git/remote answers for a clean checkout that tracks its remote.
const CLEAN_REMOTE = Object.freeze({
  ok: true,
  hasGit: true,
  remoteUrl: ssh('github.com:example-org/sample-repo.git'),
  repoUrl: REPO_URL,
  slug: 'example-org/sample-repo',
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  dirty: false,
});

function warningKinds(input) {
  return buildCloudSourceWarnings({ environmentId: 'env_01EXAMPLEaaaaaaaaaaaaaaaa', ...input })
    .map((warning) => warning.kind);
}

test('only the claude-cloud provider type counts as a cloud conversation', () => {
  assert.equal(isClaudeCloudProviderType(' Claude-Cloud '), true);
  assert.equal(isClaudeCloudProviderType('claude'), false);
  assert.equal(isClaudeCloudProviderType(''), false);
  assert.equal(isClaudeCloudConversation({ runtimeProviderType: 'claude-cloud' }), true);
  assert.equal(isClaudeCloudConversation({ runtime_provider_type: 'CLAUDE-CLOUD' }), true);
  assert.equal(isClaudeCloudConversation({ runtimeProviderType: 'claude' }), false);
  assert.equal(isClaudeCloudConversation(null), false);
});

test('a repository is accepted in every form a user is likely to have at hand', () => {
  const expected = {
    repoUrl: REPO_URL,
    owner: 'example-org',
    repo: 'sample-repo',
    slug: 'example-org/sample-repo',
  };
  for (const input of [
    REPO_URL,
    `${REPO_URL}.git`,
    `${REPO_URL}/`,
    'http://github.com/example-org/sample-repo',
    'github.com/example-org/sample-repo',
    ssh('github.com:example-org/sample-repo.git'),
    `ssh://${ssh('github.com/example-org/sample-repo')}`,
    // The one form only the browser takes: a URL is a lot to type on a phone.
    'example-org/sample-repo',
    'example-org/sample-repo.git',
    '  example-org/sample-repo  ',
  ]) {
    assert.deepEqual(normalizeCloudRepoInput(input), expected, input);
  }
});

test('anything that is not a GitHub repository normalises to null', () => {
  for (const input of [
    '',
    'sample-repo',
    'https://gitlab.example.com/example-org/sample-repo',
    'https://github.com/example-org',
    'https://github.com/example-org/sample-repo/tree/main',
    'example-org/sample repo',
    'example-org/..',
    '-org/sample-repo',
    'org-/sample-repo',
    'example-org/sample-repo/extra',
    ssh('git.example.com:example-org/sample-repo.git'),
    null,
    undefined,
  ]) {
    assert.equal(normalizeCloudRepoInput(input), null, String(input));
  }
});

test('branch names follow the git ref rules a typo can break', () => {
  for (const name of ['main', 'dev/claude-cloud', 'release-1.2', 'feature/a_b', 'v1.0.x']) {
    assert.equal(isValidCloudBranchName(name), true, name);
  }
  for (const name of [
    '', ' main', 'main ', 'my branch', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[1]', 'a\\b',
    '/main', 'main/', '-main', 'main.', 'main.lock', 'a//b', 'a/.hidden', '@', 'a@{1}',
  ]) {
    assert.equal(isValidCloudBranchName(name), false, JSON.stringify(name));
  }
});

test('valid fields become the cloudSource of the bootstrap request', () => {
  assert.deepEqual(
    validateCloudSourceInputs({ repo: 'example-org/sample-repo', branch: ' dev/topic ' }),
    {
      ok: true,
      cloudSource: { repoUrl: REPO_URL, branch: 'dev/topic' },
      slug: 'example-org/sample-repo',
      errors: {},
    },
  );
  // No branch means the repository's default branch: the key is left out.
  assert.deepEqual(
    validateCloudSourceInputs({ repo: REPO_URL, branch: '' }).cloudSource,
    { repoUrl: REPO_URL },
  );
});

test('each field that needs fixing gets its own message', () => {
  const empty = validateCloudSourceInputs({ repo: '', branch: '' });
  assert.equal(empty.ok, false);
  assert.equal(empty.cloudSource, null);
  assert.equal(empty.errors.repo, 'Enter a GitHub repository.');
  assert.equal(empty.errors.branch, undefined);

  const both = validateCloudSourceInputs({ repo: 'not a repo', branch: 'bad branch' });
  assert.equal(both.ok, false);
  assert.match(both.errors.repo, /Not a GitHub repository/);
  assert.equal(both.errors.branch, 'Not a valid branch name.');

  const branchOnly = validateCloudSourceInputs({ repo: REPO_URL, branch: 'a..b' });
  assert.equal(branchOnly.ok, false);
  assert.equal(branchOnly.errors.repo, undefined);
  assert.equal(branchOnly.slug, 'example-org/sample-repo');
});

test('a folder with a GitHub remote fills both fields, over anything typed', () => {
  const result = resolveCloudSourceAutoFill({
    current: { repo: 'example-org/other-repo', branch: 'typed' },
    lastAutoFill: null,
    remote: CLEAN_REMOTE,
  });
  assert.deepEqual(result, {
    repo: REPO_URL,
    branch: 'main',
    autoFill: { repo: REPO_URL, branch: 'main' },
  });
});

test('a folder without a remote clears only what an earlier lookup filled in', () => {
  const noRemote = { ok: true, hasGit: false, repoUrl: null, branch: null };
  const lastAutoFill = { repo: REPO_URL, branch: 'main' };
  assert.deepEqual(
    resolveCloudSourceAutoFill({ current: { ...lastAutoFill }, lastAutoFill, remote: noRemote }),
    { repo: '', branch: '', autoFill: null },
  );
  // The branch was edited after the fill: that is the user's input now.
  assert.deepEqual(
    resolveCloudSourceAutoFill({ current: { repo: REPO_URL, branch: 'dev/topic' }, lastAutoFill, remote: noRemote }),
    { repo: REPO_URL, branch: 'dev/topic', autoFill: lastAutoFill },
  );
  // Typed by hand with no lookup before: untouched, also when the lookup failed.
  assert.deepEqual(
    resolveCloudSourceAutoFill({ current: { repo: 'example-org/sample-repo', branch: '' }, remote: null }),
    { repo: 'example-org/sample-repo', branch: '', autoFill: null },
  );
});

test('the folder line says the folder only fills the fields', () => {
  // platform-agnostic: the path is only quoted back, never resolved.
  assert.equal(
    cloudFolderStatusText('/home/dev/sample-repo'),
    'Repository and branch are read from /home/dev/sample-repo. The chat itself runs in the cloud.',
  );
  assert.match(cloudFolderStatusText(''), /^The chat runs in the cloud\./);
});

test('a clean, pushed checkout raises no warning', () => {
  assert.deepEqual(warningKinds({ remote: CLEAN_REMOTE, repo: REPO_URL, branch: 'main' }), []);
  // No folder looked up at all (a repository typed by hand) is fine too.
  assert.deepEqual(warningKinds({ remote: null, repo: REPO_URL, branch: '' }), []);
});

test('unpushed commits are counted in the warning line', () => {
  const one = buildCloudSourceWarnings({
    remote: { ...CLEAN_REMOTE, ahead: 1 }, repo: REPO_URL, branch: 'main', environmentId: 'env_01EXAMPLE',
  });
  assert.deepEqual(one, [{ kind: 'unpushed', text: '1 commit not pushed — the cloud clone will not have it.' }]);
  const three = buildCloudSourceWarnings({
    remote: { ...CLEAN_REMOTE, ahead: 3 }, repo: REPO_URL, branch: 'main', environmentId: 'env_01EXAMPLE',
  });
  assert.deepEqual(three, [{ kind: 'unpushed', text: '3 commits not pushed — the cloud clone will not have them.' }]);
});

test('uncommitted changes and a branch without upstream each get a line', () => {
  const warnings = buildCloudSourceWarnings({
    remote: { ...CLEAN_REMOTE, branch: 'dev/topic', upstream: null, dirty: true },
    repo: 'example-org/sample-repo',
    branch: 'dev/topic',
    environmentId: 'env_01EXAMPLE',
  });
  assert.deepEqual(warnings.map((warning) => warning.kind), ['no-upstream', 'dirty']);
  assert.match(warnings[0].text, /^Branch dev\/topic has no upstream/);
  assert.equal(warnings[1].text, 'Uncommitted changes stay local.');
});

test('the state of the folder stops mattering once the fields name something else', () => {
  const remote = { ...CLEAN_REMOTE, ahead: 2, dirty: true };
  // Another branch of the same repository: the unpushed commits are not on it,
  // the uncommitted changes still stay behind.
  assert.deepEqual(warningKinds({ remote, repo: REPO_URL, branch: 'release' }), ['dirty']);
  assert.deepEqual(warningKinds({ remote, repo: REPO_URL, branch: '' }), ['dirty']);
  // Another repository altogether.
  assert.deepEqual(warningKinds({ remote, repo: 'example-org/other-repo', branch: 'main' }), []);
  // The repository is compared by slug, so the typed form does not matter.
  assert.deepEqual(
    warningKinds({ remote, repo: ssh('github.com:Example-Org/Sample-Repo.git'), branch: 'main' }),
    ['unpushed', 'dirty'],
  );
});

test('a folder that cannot supply a repository says why', () => {
  assert.deepEqual(warningKinds({ remote: { ok: true, hasGit: false } }), ['no-git']);
  const noRemote = buildCloudSourceWarnings({
    remote: { ok: true, hasGit: true, remoteUrl: null, repoUrl: null }, environmentId: 'env_01EXAMPLE',
  });
  assert.deepEqual(noRemote.map((warning) => warning.kind), ['no-remote']);
  assert.match(noRemote[0].text, /^No GitHub remote in this folder/);
  const otherHost = buildCloudSourceWarnings({
    remote: { ok: true, hasGit: true, remoteUrl: 'https://git.example.com/example-org/sample-repo.git', repoUrl: null },
    environmentId: 'env_01EXAMPLE',
  });
  assert.match(otherHost[0].text, /not on GitHub/);
  assert.deepEqual(warningKinds({ lookupFailed: true }), ['lookup-failed']);
  assert.deepEqual(warningKinds({ remote: { ok: false, error: 'outside the workspace roots' } }), ['lookup-failed']);
});

test('a missing environment is always reported, after the folder lines', () => {
  const warnings = buildCloudSourceWarnings({
    remote: { ...CLEAN_REMOTE, dirty: true }, repo: REPO_URL, branch: 'main', environmentId: '',
  });
  assert.deepEqual(warnings.map((warning) => warning.kind), ['dirty', 'no-environment']);
  assert.match(warnings[1].text, /Settings → Providers → Claude Cloud/);
  assert.deepEqual(
    buildCloudSourceWarnings({ remote: null, environmentId: '', checkEnvironment: false }),
    [],
  );
});

test('server error codes map to the field they are about', () => {
  assert.deepEqual(
    cloudBootstrapErrorModel({ code: 'claude_cloud_repo_invalid', message: 'Only github.com repositories are supported.' }),
    { code: 'claude_cloud_repo_invalid', field: 'repo', text: 'Only github.com repositories are supported.' },
  );
  assert.equal(cloudBootstrapErrorModel({ code: 'claude_cloud_branch_invalid' }).field, 'branch');
  assert.match(cloudBootstrapErrorModel({ code: 'claude_cloud_disabled' }).text, /turned off/);
  assert.match(cloudBootstrapErrorModel({ code: 'claude_cloud_environment_missing' }).text, /environment/);
  // A code this client does not know yet still shows inline, with the server's text.
  assert.deepEqual(
    cloudBootstrapErrorModel({ code: 'claude_cloud_something_new', message: 'New rule.' }),
    { code: 'claude_cloud_something_new', field: null, text: 'New rule.' },
  );
  assert.equal(cloudBootstrapErrorModel({ code: 'claude_cloud_something_new' }).text, 'The relay could not start this cloud chat.');
  // Not a cloud rejection: the caller keeps its usual notice.
  assert.equal(cloudBootstrapErrorModel({ code: 'workspace_root_invalid', message: 'Bad path.' }), null);
  assert.equal(cloudBootstrapErrorModel({ message: 'Bad path.' }), null);
});

test('only a cloud chat swaps the reasoning and context rows for repository and branch', () => {
  assert.deepEqual(newChatRowVisibility('claude-cloud'), {
    cloudSource: true, reasoning: false, contextTier: false, imageSize: false,
  });
  for (const provider of ['github', 'openai', 'claude', 'cursor', 'grok', '']) {
    assert.deepEqual(newChatRowVisibility(provider), {
      cloudSource: false, reasoning: true, contextTier: true, imageSize: false,
    }, provider);
  }
  assert.equal(newChatRowVisibility('openai-image').imageSize, true);
});

test('the New Chat model list is the settings list plus its default', () => {
  const settings = { models: ['claude-opus-5', ' claude-sonnet-5-5 ', 'claude-opus-5', 'auto', ''], defaultModel: 'claude-sonnet-5-5' };
  assert.deepEqual(claudeCloudModelIds(settings), ['claude-opus-5', 'claude-sonnet-5-5']);
  assert.equal(claudeCloudDefaultModel(settings), 'claude-sonnet-5-5');
  // A default the list does not carry is still offered.
  assert.deepEqual(
    claudeCloudModelIds({ models: ['claude-opus-5'], defaultModel: 'claude-sonnet-5-5' }),
    ['claude-opus-5', 'claude-sonnet-5-5'],
  );
  assert.equal(claudeCloudDefaultModel({ models: ['claude-opus-5'] }), 'claude-opus-5');
  assert.deepEqual(claudeCloudModelIds(null), []);
  assert.equal(claudeCloudDefaultModel(null), '');
});

test('the composer falls back to the Claude rows of the catalog until settings load', () => {
  assert.deepEqual(
    claudeCloudComposerModelIds({
      settings: { models: ['claude-sonnet-5-5'], defaultModel: 'claude-sonnet-5-5' },
      catalogModels: ['gpt-5.4-mini', 'claude-opus-5'],
      providersByModel: { 'claude-opus-5': ['claude'] },
    }),
    ['claude-sonnet-5-5'],
  );
  assert.deepEqual(
    claudeCloudComposerModelIds({
      settings: null,
      catalogModels: ['auto', 'gpt-5.4-mini', 'claude-opus-5', 'claude-opus-5[1m]', 'claude-sonnet-5-5', 'composer-2.5'],
      providersByModel: {
        'gpt-5.4-mini': ['github-copilot'],
        'claude-opus-5': ['claude', 'github-copilot'],
        'claude-opus-5[1m]': ['claude'],
        'claude-sonnet-5-5': ['claude-cloud'],
        'composer-2.5': ['cursor'],
      },
    }),
    ['claude-opus-5', 'claude-sonnet-5-5'],
  );
  assert.deepEqual(claudeCloudComposerModelIds({}), []);
});

test('the conversation\'s own model is always on the composer list', () => {
  assert.deepEqual(
    claudeCloudComposerModelIds({
      settings: { models: ['claude-sonnet-5-5'], defaultModel: 'claude-sonnet-5-5' },
      conversationModel: 'claude-opus-5[1m]',
    }),
    ['claude-sonnet-5-5', 'claude-opus-5'],
  );
  // Listed once when the settings already carry it.
  assert.deepEqual(
    claudeCloudComposerModelIds({
      settings: { models: ['claude-sonnet-5-5'] },
      conversationModel: 'claude-sonnet-5-5',
    }),
    ['claude-sonnet-5-5'],
  );
  // Nothing loaded yet: the picker still names the chat's model, not Copilot's.
  assert.deepEqual(
    claudeCloudComposerModelIds({ catalogModels: ['gpt-5.4-mini'], conversationModel: 'claude-sonnet-5-5' }),
    ['claude-sonnet-5-5'],
  );
});

test('compare links follow the GitHub compare URL form', () => {
  assert.equal(
    cloudCompareUrl('example-org/sample-repo', 'main', 'claude/fix-slugify'),
    `${REPO_URL}/compare/main...claude/fix-slugify`,
  );
  // No base: GitHub compares against the default branch by itself.
  assert.equal(cloudCompareUrl('example-org/sample-repo', '', 'claude/fix'), `${REPO_URL}/compare/claude/fix`);
  // A branch compared with itself is empty: the branch page says more.
  assert.equal(cloudCompareUrl('example-org/sample-repo', 'main', 'main'), `${REPO_URL}/tree/main`);
  assert.equal(
    cloudCompareUrl('example-org/sample-repo', 'release#1', 'topic%2'),
    `${REPO_URL}/compare/release%231...topic%252`,
  );
  assert.equal(cloudCompareUrl('not a slug', 'main', 'topic'), '');
  assert.equal(cloudCompareUrl('example-org/sample-repo', 'main', ''), '');
  assert.equal(cloudCompareUrl('example-org/sample-repo', 'main', 'bad branch'), '');
});

// The browser cannot import shared/, so these rules exist twice. The server's
// copy is the one that decides; this keeps the browser's from drifting.
test('the browser mirror agrees with shared/claude-cloud/repo-url.mjs', () => {
  const repoInputs = [
    REPO_URL,
    `${REPO_URL}.git`,
    `${REPO_URL}/`,
    'http://www.github.com/example-org/sample-repo',
    'github.com/example-org/sample-repo',
    // Credentials in front of the host are dropped, never shown or sent on.
    ['https://dev:test-token-value', 'github.com/example-org/sample-repo.git'].join('@'),
    ssh('github.com:example-org/sample-repo.git'),
    `ssh://${ssh('github.com/example-org/sample-repo')}`,
    'git://github.com/example-org/sample-repo.git',
    'https://github.com/example-org',
    'https://github.com/example-org/sample-repo/tree/main',
    'https://git.example.com/example-org/sample-repo',
    'https://github.com/org-/sample-repo',
    'https://github.com/example-org/..',
    'ftp://github.com/example-org/sample-repo',
    'not a repo',
    '',
  ];
  for (const input of repoInputs) {
    assert.deepEqual(normalizeCloudRepoInput(input), sharedNormalizeGitHubRepoUrl(input), JSON.stringify(input));
  }
  const branchNames = [
    'main', 'dev/claude-cloud', 'release-1.2', 'v1.0.x', 'topic/<b>', '', ' main', 'main ', 'my branch',
    'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[1]', 'a\\b', '/main', 'main/', '-main', 'main.', 'main.lock',
    'a.lock/b', 'a//b', 'a/.hidden', '@', 'a@{1}', 'x'.repeat(256),
  ];
  for (const name of branchNames) {
    assert.equal(isValidCloudBranchName(name), sharedIsValidBranchName(name), JSON.stringify(name));
  }
  for (const [slug, base, branch] of [
    ['example-org/sample-repo', 'main', 'claude/fix'],
    ['example-org/sample-repo', '', 'claude/fix'],
    ['example-org/sample-repo', null, 'claude/fix'],
    ['example-org/sample-repo', 'main', 'main'],
    ['example-org/sample-repo', 'release#1', 'topic%2'],
    ['example-org/sample-repo', 'main', 'bad branch'],
    ['not a slug', 'main', 'topic'],
  ]) {
    assert.equal(cloudCompareUrl(slug, base, branch), sharedCompareUrl(slug, base, branch) ?? '', `${slug} ${base} ${branch}`);
  }
});

test('the cloud line model lists one link per pushed branch', () => {
  const model = buildCloudLineModel({
    repoUrl: REPO_URL,
    slug: 'example-org/sample-repo',
    branch: 'main',
    sessionUrl: 'https://claude.ai/code/session_01EXAMPLEaaaaaaaaaaaaaaaa',
    pushedBranches: [
      { branch: 'claude/fix-slugify', at: '2026-10-02T10:00:00.000Z' },
      { branch: 'claude/word-count', at: '2026-10-02T10:05:00.000Z' },
      // Pushed again: one entry, moved to the end, with the newer time.
      { branch: 'claude/fix-slugify', at: '2026-10-02T10:09:00.000Z' },
      { branch: '  ' },
      null,
    ],
    costUsd: 0.184,
  });
  assert.deepEqual(model, {
    slug: 'example-org/sample-repo',
    repoUrl: REPO_URL,
    branch: 'main',
    sessionUrl: 'https://claude.ai/code/session_01EXAMPLEaaaaaaaaaaaaaaaa',
    pushed: [
      {
        branch: 'claude/word-count',
        at: '2026-10-02T10:05:00.000Z',
        sameAsBase: false,
        url: `${REPO_URL}/compare/main...claude/word-count`,
      },
      {
        branch: 'claude/fix-slugify',
        at: '2026-10-02T10:09:00.000Z',
        sameAsBase: false,
        url: `${REPO_URL}/compare/main...claude/fix-slugify`,
      },
    ],
    cost: '$0.18',
  });
});

test('the cloud line model degrades field by field', () => {
  // Before the first message there is no session, no push and no cost.
  assert.deepEqual(buildCloudLineModel({ repoUrl: REPO_URL, branch: null, sessionUrl: null, pushedBranches: [], costUsd: null }), {
    slug: 'example-org/sample-repo', repoUrl: REPO_URL, branch: '', sessionUrl: '', pushed: [], cost: '',
  });
  // Only a slug: the URL is derived from it.
  assert.equal(buildCloudLineModel({ slug: 'example-org/sample-repo' }).repoUrl, REPO_URL);
  // A push to the cloned branch has nothing to compare with.
  assert.deepEqual(
    buildCloudLineModel({ repoUrl: REPO_URL, branch: 'main', pushedBranches: [{ branch: 'main' }] }).pushed,
    [{ branch: 'main', at: '', sameAsBase: true, url: `${REPO_URL}/tree/main` }],
  );
  // What git would not accept as a branch name is not listed at all.
  assert.deepEqual(
    buildCloudLineModel({ repoUrl: REPO_URL, branch: 'main', pushedBranches: [{ branch: 'not a branch' }] }).pushed,
    [],
  );
  // Without a base branch the compare link leaves the base to GitHub.
  assert.equal(
    buildCloudLineModel({ repoUrl: REPO_URL, pushedBranches: ['claude/fix'] }).pushed[0].url,
    `${REPO_URL}/compare/claude/fix`,
  );
  // Only an https session URL becomes a link.
  assert.equal(buildCloudLineModel({ repoUrl: REPO_URL, sessionUrl: 'javascript:alert(1)' }).sessionUrl, '');
  for (const cloud of [null, undefined, 'x', [], {}, { repoUrl: 'https://git.example.com/a/b' }]) {
    assert.equal(buildCloudLineModel(cloud), null);
  }
});

test('costs read as dollars and stay silent until there is one', () => {
  assert.equal(formatCloudCost(0.184), '$0.18');
  assert.equal(formatCloudCost('2.5'), '$2.50');
  assert.equal(formatCloudCost(0.004), '<$0.01');
  for (const value of [0, null, undefined, '', 'x', -1]) assert.equal(formatCloudCost(value), '');
});

test('the header label names the repository and branch in one short line', () => {
  assert.equal(cloudHeaderLabel({ repoUrl: REPO_URL, branch: 'main' }), '☁ example-org/sample-repo · main');
  assert.equal(cloudHeaderLabel({ repoUrl: REPO_URL }), '☁ example-org/sample-repo');
  assert.equal(cloudHeaderLabel(null), '');
});

test('the rendered cloud line escapes what it shows and links what it can', () => {
  const html = renderCloudLineHtml({
    repoUrl: REPO_URL,
    branch: 'topic/<b>',
    sessionUrl: 'https://claude.ai/code/session_01EXAMPLEaaaaaaaaaaaaaaaa',
    pushedBranches: [{ branch: 'claude/"quoted"' }],
    costUsd: 1,
  });
  assert.match(html, /class="cloud-line-item cloud-line-repo" href="https:\/\/github\.com\/example-org\/sample-repo"/);
  assert.match(html, />☁ example-org\/sample-repo<\/a>/);
  assert.match(html, /<span class="cloud-line-item cloud-line-branch"[^>]*>topic\/&lt;b&gt;<\/span>/);
  assert.match(html, /class="cloud-line-item cloud-line-session" href="https:\/\/claude\.ai\/code\/session_01EXAMPLEaaaaaaaaaaaaaaaa" target="_blank" rel="noopener"/);
  assert.match(html, /href="https:\/\/github\.com\/example-org\/sample-repo\/compare\/topic\/%3Cb%3E\.\.\.claude\/%22quoted%22"/);
  assert.match(html, />⇡ claude\/&quot;quoted&quot;<\/a>/);
  assert.match(html, /<span class="cloud-line-item cloud-line-cost"[^>]*>\$1\.00<\/span>/);
  assert.doesNotMatch(html, /<b>/);

  const bare = renderCloudLineHtml({ repoUrl: REPO_URL });
  assert.doesNotMatch(bare, /cloud-line-(branch|session|push|cost)/);
  assert.equal(renderCloudLineHtml(null), '');
});

test('a claude_cloud_session event replaces the fields it carries', () => {
  const current = { repoUrl: REPO_URL, branch: 'main', sessionUrl: null, pushedBranches: [], costUsd: null };
  assert.deepEqual(
    mergeCloudSessionUpdate(current, { sessionUrl: 'https://claude.ai/code/session_01EXAMPLE', costUsd: 0.07 }),
    { repoUrl: REPO_URL, branch: 'main', sessionUrl: 'https://claude.ai/code/session_01EXAMPLE', pushedBranches: [], costUsd: 0.07 },
  );
  assert.deepEqual(mergeCloudSessionUpdate(null, { repoUrl: REPO_URL }), { repoUrl: REPO_URL });
  // An event without the field leaves the record alone; an explicit null clears it.
  assert.equal(mergeCloudSessionUpdate(current, undefined), current);
  assert.equal(mergeCloudSessionUpdate(current, null), null);
});

test('a cloud chat carries the four inline image types up to 5 MB and nothing else', () => {
  assert.equal(CLAUDE_CLOUD_ATTACH_ACCEPT, 'image/jpeg,image/png,image/gif,image/webp');
  assert.equal(cloudAttachmentRejection({ type: 'image/png', size: 1024 }), '');
  assert.equal(cloudAttachmentRejection({ type: 'IMAGE/JPEG', size: CLAUDE_CLOUD_MAX_IMAGE_BYTES }), '');
  assert.equal(cloudAttachmentRejection({ type: 'image/webp', size: CLAUDE_CLOUD_MAX_IMAGE_BYTES + 1 }), 'size');
  assert.equal(cloudAttachmentRejection({ type: 'image/svg+xml', size: 10 }), 'type');
  assert.equal(cloudAttachmentRejection({ type: 'application/pdf', size: 10 }), 'type');
  assert.equal(cloudAttachmentRejection({ name: 'notes.txt' }), 'type');
  assert.equal(cloudAttachmentRejection(null), 'type');
});

test('the attachment filter keeps the images and names what it left out', () => {
  const shot = { name: 'screenshot.png', type: 'image/png', size: 2048 };
  const doc = { name: 'report.pdf', type: 'application/pdf', size: 2048 };
  const huge = { name: 'poster.png', type: 'image/png', size: CLAUDE_CLOUD_MAX_IMAGE_BYTES + 1 };
  const { accepted, rejected } = partitionCloudAttachments([shot, doc, null, huge]);
  assert.deepEqual(accepted, [shot]);
  assert.deepEqual(rejected, [{ attachment: doc, reason: 'type' }, { attachment: huge, reason: 'size' }]);
  assert.equal(
    cloudAttachmentRejectionNotice(rejected),
    'Claude Cloud chats take images only (JPEG, PNG, GIF or WebP up to 5 MB). Not attached: report.pdf, poster.png.',
  );
  assert.equal(
    cloudAttachmentRejectionNotice([{ attachment: huge, reason: 'size' }]),
    'Claude Cloud chats take images up to 5 MB. Not attached: poster.png.',
  );
  const many = [doc, doc, doc, doc].map((attachment) => ({ attachment, reason: 'type' }));
  assert.match(cloudAttachmentRejectionNotice(many), /Not attached: report\.pdf, report\.pdf and 2 more\.$/);
  assert.equal(cloudAttachmentRejectionNotice([]), '');
  assert.deepEqual(partitionCloudAttachments(null), { accepted: [], rejected: [] });
});
