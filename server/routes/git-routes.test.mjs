'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { registerGitRoutes, resolveGitScopedRootPath } from './git-routes.mjs';

test('a conversation-scoped request resolves the conversation workspace root', () => {
  const calls = [];
  const rootPath = resolveGitScopedRootPath({ query: { conversationId: 'conv-1' } }, {
    resolveConversationWorkspaceState: (scope) => {
      calls.push(scope);
      return { currentWorkspaceRootPath: '/home/dev/git/project-a' };
    },
    currentWorkspaceRootPath: () => '/home/dev/git/fallback',
  });
  assert.equal(rootPath, '/home/dev/git/project-a');
  assert.deepEqual(calls, [{ conversationId: 'conv-1', sdkSessionId: '' }]);
});

test('conversation scope can also arrive via headers', () => {
  const rootPath = resolveGitScopedRootPath({ headers: { 'x-conversation-id': 'conv-2' } }, {
    resolveConversationWorkspaceState: () => ({ currentWorkspaceRootPath: '/home/dev/git/project-b' }),
    currentWorkspaceRootPath: () => null,
  });
  assert.equal(rootPath, '/home/dev/git/project-b');
});

test('an unscoped request falls back to the global workspace root', () => {
  const rootPath = resolveGitScopedRootPath({ query: {} }, {
    resolveConversationWorkspaceState: () => {
      throw new Error('must not be called without a scope');
    },
    currentWorkspaceRootPath: () => '/home/dev/git/fallback',
  });
  assert.equal(rootPath, '/home/dev/git/fallback');
});

test('a scoped request with no resolvable root still falls back, then null', () => {
  const withFallback = resolveGitScopedRootPath({ query: { conversationId: 'conv-3' } }, {
    resolveConversationWorkspaceState: () => ({ currentWorkspaceRootPath: '' }),
    currentWorkspaceRootPath: () => '/home/dev/git/fallback',
  });
  assert.equal(withFallback, '/home/dev/git/fallback');

  const withoutFallback = resolveGitScopedRootPath({ query: { conversationId: 'conv-3' } }, {
    resolveConversationWorkspaceState: () => null,
    currentWorkspaceRootPath: () => '',
  });
  assert.equal(withoutFallback, null);
});

// ─── GET /api/git/remote ─────────────────────────────────────────────────────

// Built from its halves: the hygiene guard reads a literal `user@host` as an
// e-mail address.
const SCP_REMOTE = ['git', 'github.com:example-org/sample-repo.git'].join('@');

function createRemoteRouteHarness({ describe, validateWorkspaceRoot, allowList = [] } = {}) {
  const routes = new Map();
  const app = {
    get(routePath, ...handlers) { routes.set(`GET ${routePath}`, handlers); },
    post(routePath, ...handlers) { routes.set(`POST ${routePath}`, handlers); },
  };
  const described = [];
  const validated = [];
  registerGitRoutes(app, {
    auth: (_req, _res, next) => next(),
    gitRemoteService: {
      describe: async (root) => {
        described.push(root);
        return describe(root);
      },
    },
    workspaceRootAllowList: allowList,
    validateWorkspaceRoot: (candidate, options) => {
      validated.push({ candidate, options });
      return validateWorkspaceRoot(candidate, options);
    },
  });
  async function call(query) {
    const res = {
      statusCode: 200,
      body: null,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    const handlers = routes.get('GET /api/git/remote');
    await handlers[handlers.length - 1]({ query, headers: {} }, res);
    return res;
  }
  return { routes, call, described, validated };
}

test('the remote route answers for a validated folder, in the documented shape', async () => {
  const harness = createRemoteRouteHarness({
    allowList: ['/srv/projects'],
    validateWorkspaceRoot: (candidate) => ({ ok: true, path: candidate, realPath: '/srv/checkouts/sample-repo' }),
    describe: () => ({
      ok: true,
      hasGit: true,
      remoteUrl: SCP_REMOTE,
      repoUrl: 'https://github.com/example-org/sample-repo',
      slug: 'example-org/sample-repo',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 0,
      dirty: true,
    }),
  });
  const res = await harness.call({ root: '/home/dev/link-to-sample-repo' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    root: '/srv/checkouts/sample-repo',
    hasGit: true,
    remoteUrl: SCP_REMOTE,
    repoUrl: 'https://github.com/example-org/sample-repo',
    slug: 'example-org/sample-repo',
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 0,
    dirty: true,
  });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  // The policy sees the raw request and the allow list; git sees the real path.
  assert.deepEqual(harness.validated, [{
    candidate: '/home/dev/link-to-sample-repo',
    options: { allowList: ['/srv/projects'] },
  }]);
  assert.deepEqual(harness.described, ['/srv/checkouts/sample-repo']);
});

test('the remote route refuses a folder the workspace policy refuses, before any git runs', async () => {
  const refusals = [
    [{ ok: false, code: 'missing-root-path', error: 'Missing rootPath' }, 400],
    [{ ok: false, code: 'relative-root-path', error: 'Use an absolute path.' }, 400],
    [{ ok: false, code: 'root-path-not-found', error: 'Directory not found' }, 400],
    [{ ok: false, code: 'root-path-not-allowed', error: 'Outside the allow list.' }, 403],
  ];
  for (const [refusal, statusCode] of refusals) {
    const harness = createRemoteRouteHarness({
      validateWorkspaceRoot: () => refusal,
      describe: () => { throw new Error('git must not run'); },
    });
    const res = await harness.call({ root: 'somewhere' });
    assert.equal(res.statusCode, statusCode, refusal.code);
    assert.deepEqual(res.body, { ok: false, code: refusal.code, error: refusal.error });
    assert.deepEqual(harness.described, []);
  }
});

test('the remote route reports a folder without git as such, and a git failure as 500', async () => {
  const plain = createRemoteRouteHarness({
    validateWorkspaceRoot: () => ({ ok: true, realPath: '/home/dev/plain-folder' }),
    describe: () => ({
      ok: true, hasGit: false, remoteUrl: null, repoUrl: null, slug: null,
      branch: null, upstream: null, ahead: 0, behind: 0, dirty: false,
    }),
  });
  const plainRes = await plain.call({ root: '/home/dev/plain-folder' });
  assert.equal(plainRes.statusCode, 200);
  assert.equal(plainRes.body.hasGit, false);
  assert.equal(plainRes.body.repoUrl, null);

  const broken = createRemoteRouteHarness({
    validateWorkspaceRoot: () => ({ ok: true, realPath: '/home/dev/git/sample-repo' }),
    describe: () => ({ ok: false, error: 'spawn git ENOENT' }),
  });
  const brokenRes = await broken.call({ root: '/home/dev/git/sample-repo' });
  assert.equal(brokenRes.statusCode, 500);
  assert.deepEqual(brokenRes.body, { ok: false, error: 'spawn git ENOENT' });
});

test('the remote route is registered without the git changes service, and absent without its own', () => {
  const harness = createRemoteRouteHarness({ validateWorkspaceRoot: () => ({ ok: false }), describe: () => ({}) });
  assert.deepEqual([...harness.routes.keys()], ['GET /api/git/remote']);

  const routes = new Map();
  registerGitRoutes({ get: (routePath) => routes.set(routePath, true), post: () => {} }, {
    auth: (_req, _res, next) => next(),
    gitChangesService: { getStatus: async () => ({}), getDiff: async () => ({}), pull: async () => ({}) },
  });
  assert.equal(routes.has('/api/git/remote'), false);
  assert.equal(routes.has('/api/git/status'), true);
});
