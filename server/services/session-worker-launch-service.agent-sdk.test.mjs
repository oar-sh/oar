// The agent SDK folder a worker is launched with (agent-sdk-store.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { agentSdkForWorkerKind, buildTmuxWorkerShellCommand, TMUX_WORKER_EXPORTED_ENV_VARS } from './session-worker-launch-service.mjs';

test('each worker kind runs on its agent SDK, or on none', () => {
  assert.equal(agentSdkForWorkerKind('claude'), 'claude');
  assert.equal(agentSdkForWorkerKind('claude-api'), 'claude');
  assert.equal(agentSdkForWorkerKind('DeepSeek'), 'claude');
  assert.equal(agentSdkForWorkerKind('cursor'), 'cursor');
  for (const kind of ['copilot', 'copilot-sdk', 'grok', 'claude-cloud', '', null, 'toString']) {
    assert.equal(agentSdkForWorkerKind(kind), null, String(kind));
  }
});

test('a tmux worker gets its agent SDK folder exported', () => {
  for (const name of ['OAR_AGENT_SDK_DIR_CLAUDE', 'OAR_AGENT_SDK_DIR_CURSOR']) assert.ok(TMUX_WORKER_EXPORTED_ENV_VARS.includes(name), name);
  const command = buildTmuxWorkerShellCommand('session-7', {
    COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    OAR_AGENT_SDK_DIR_CURSOR: '/home/dev/.oar/sdks/cursor/1.3.1-0a1b2c3d',
  }, { secretEnvFilePath: '/tmp/relay-worker-test/provider.env' });
  assert.match(command, /OAR_AGENT_SDK_DIR_CURSOR=.*\/home\/dev\/\.oar\/sdks\/cursor\/1\.3\.1-0a1b2c3d/);
});
