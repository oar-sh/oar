'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGitScopedRootPath } from './git-routes.mjs';

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
