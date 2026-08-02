import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildConversationSessionRootPayload } from './sessions-routes.mjs';

const SDK_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CLAUDE_NATIVE_ID = '11111111-2222-4333-8444-555555555555';

// Copilot and OpenAI conversations both run the `copilot` CLI, which creates
// this directory itself.
function makeSessionStateRoot({ withSessionDir = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-state-'));
  if (withSessionDir) fs.mkdirSync(path.join(root, SDK_SESSION_ID), { recursive: true });
  return root;
}

function spyResolver(result = null) {
  const calls = [];
  const fn = (args) => { calls.push(args); return result; };
  fn.calls = calls;
  return fn;
}

for (const providerType of ['github', 'openai', '', undefined]) {
  test(`the copilot session folder is unchanged for provider ${providerType ?? 'undefined'}`, () => {
    const root = makeSessionStateRoot();
    const resolveClaudeSessionRoot = spyResolver();
    const payload = buildConversationSessionRootPayload({
      conversationId: 'conv-1',
      sdkSessionId: SDK_SESSION_ID,
      title: 'A conversation',
      resolveSessionStateRoot: () => root,
      providerType,
      claudeNativeSessionId: CLAUDE_NATIVE_ID,
      resolveClaudeSessionRoot,
    });
    assert.deepEqual(payload, {
      sdkSessionId: SDK_SESSION_ID,
      sessionRootPath: path.join(root, SDK_SESSION_ID),
      sessionRootName: 'Session',
    });
    assert.equal(resolveClaudeSessionRoot.calls.length, 0);
  });
}

test('a copilot conversation with no session-state directory still resolves to null', () => {
  const root = makeSessionStateRoot({ withSessionDir: false });
  assert.equal(buildConversationSessionRootPayload({
    conversationId: 'conv-1',
    sdkSessionId: SDK_SESSION_ID,
    resolveSessionStateRoot: () => root,
    providerType: 'github',
  }), null);
});

test('a claude conversation resolves through the Agent SDK project layout', () => {
  const sessionRootPath = '/home/dev/.claude/projects/-home-dev-git-copilot-remote/11111111';
  const resolveClaudeSessionRoot = spyResolver({ sessionRootPath, sessionRootName: 'Session' });
  const resolveSessionStateRoot = spyResolver('/should/not/be/used');

  const payload = buildConversationSessionRootPayload({
    conversationId: 'conv-1',
    sdkSessionId: SDK_SESSION_ID,
    resolveSessionStateRoot,
    providerType: 'claude',
    claudeNativeSessionId: CLAUDE_NATIVE_ID,
    workspaceRootPath: '/home/dev/git/copilot-remote',
    resolveClaudeSessionRoot,
  });

  assert.deepEqual(payload, {
    sdkSessionId: SDK_SESSION_ID,
    sessionRootPath,
    sessionRootName: 'Session',
  });
  assert.deepEqual(resolveClaudeSessionRoot.calls, [{
    claudeNativeSessionId: CLAUDE_NATIVE_ID,
    workspaceRootPath: '/home/dev/git/copilot-remote',
  }]);
  assert.equal(resolveSessionStateRoot.calls.length, 0);
});

test('a claude conversation never falls through to a same-named session-state directory', () => {
  // The SDK session id doubles as the Copilot session-state directory name, so a
  // Claude conversation must not pick up a stale Copilot folder that shares it.
  const root = makeSessionStateRoot();
  assert.equal(buildConversationSessionRootPayload({
    conversationId: 'conv-1',
    sdkSessionId: SDK_SESSION_ID,
    resolveSessionStateRoot: () => root,
    providerType: 'claude',
    claudeNativeSessionId: '',
    resolveClaudeSessionRoot: spyResolver({ sessionRootPath: '/never/reached' }),
  }), null);
});

test('a claude conversation with an unresolved or missing resolver is null, not an error', () => {
  const base = {
    conversationId: 'conv-1',
    sdkSessionId: SDK_SESSION_ID,
    resolveSessionStateRoot: () => makeSessionStateRoot(),
    providerType: 'claude',
    claudeNativeSessionId: CLAUDE_NATIVE_ID,
  };
  assert.equal(buildConversationSessionRootPayload({ ...base, resolveClaudeSessionRoot: null }), null);
  assert.equal(buildConversationSessionRootPayload({ ...base, resolveClaudeSessionRoot: spyResolver(null) }), null);
  assert.equal(
    buildConversationSessionRootPayload({ ...base, resolveClaudeSessionRoot: spyResolver({ sessionRootPath: '' }) }),
    null,
  );
});

test('the provider check is case-insensitive', () => {
  const resolveClaudeSessionRoot = spyResolver({ sessionRootPath: '/claude/session' });
  const payload = buildConversationSessionRootPayload({
    conversationId: 'conv-1',
    sdkSessionId: SDK_SESSION_ID,
    resolveSessionStateRoot: () => makeSessionStateRoot(),
    providerType: ' Claude ',
    claudeNativeSessionId: CLAUDE_NATIVE_ID,
    resolveClaudeSessionRoot,
  });
  assert.equal(payload?.sessionRootPath, '/claude/session');
});
