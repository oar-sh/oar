import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  HOST_CLAUDE_SESSION_ENV_VARS,
  hostClaudeSessionUnsetStatement,
  isHostClaudeSessionVariable,
  withoutHostClaudeSessionVariables,
} from './host-claude-session-env.mjs';

// Values are made up; the names are what a host session sets, or what a
// newer CLI could set in the same families.
const HOST_SESSION = Object.freeze({
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session-0000',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/host-claude.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'host-messaging-token',
  CLAUDE_CODE_MESSAGING_ENTRYPOINT: 'sdk',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  CLAUDE_CODE_SESSION_ATTENDED: '0',
  CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'host-access-token',
  CLAUDE_CODE_SESSION_KIND: 'agent',
  CLAUDE_CODE_HOST_SESSION_ID: 'host-session-0001',
  CLAUDE_CODE_REMOTE_SESSION_ID: 'host-session-0002',
  CLAUDE_CODE_EXECPATH: '/opt/claude/claude',
  CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS: '120000',
  CLAUDE_AGENT_SDK_VERSION: '0.0.0',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'host',
  CLAUDE_PID: '4321',
  CLAUDE_EFFORT: 'high',
  CLAUDE_PROJECT_DIR: '/home/dev/project',
  CLAUDE_ENV_FILE: '/tmp/host-env-file',
});

// Configuration: the relay's own and the user's Claude Code settings.
const CONFIGURATION = Object.freeze({
  PATH: '/usr/bin:/bin',
  CLAUDE_CONFIG_DIR: '/srv/oar/claude-config',
  CLAUDE_CODE_EXECUTABLE: '/srv/oar/bin/claude',
  CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_GIT_BASH_PATH: '/opt/git/bin/bash',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
  CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: '5000',
  CLAUDE_CODE_EFFORT_LEVEL: 'high',
  BASH_DEFAULT_TIMEOUT_MS: '7200000',
  // The SDK's switches, and the settings inside the session family.
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
  CLAUDE_AGENT_SDK_MCP_NO_PREFIX: '1',
  CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS: '1',
  CLAUDE_CODE_SESSION_START_ANNOUNCEMENTS_BEFORE_PROMPT: '1',
  CLAUDE_CODE_SESSION_LOG: '/tmp/claude-session.log',
});

test('the host session\'s variables are matched by name and by family; configuration is not', () => {
  for (const key of Object.keys(HOST_SESSION)) assert.equal(isHostClaudeSessionVariable(key), true, key);
  for (const key of HOST_CLAUDE_SESSION_ENV_VARS) assert.equal(isHostClaudeSessionVariable(key), true, key);
  for (const key of Object.keys(CONFIGURATION)) assert.equal(isHostClaudeSessionVariable(key), false, key);
  // Windows names are case-insensitive.
  assert.equal(isHostClaudeSessionVariable('ClaudeCode'), true);
  assert.equal(isHostClaudeSessionVariable(''), false);
  assert.equal(isHostClaudeSessionVariable(undefined), false);
});

test('withoutHostClaudeSessionVariables keeps the configuration and leaves its input alone', () => {
  const input = { ...HOST_SESSION, ...CONFIGURATION };
  assert.deepEqual(withoutHostClaudeSessionVariables(input), CONFIGURATION);
  assert.equal(input.CLAUDECODE, '1');
  assert.deepEqual(withoutHostClaudeSessionVariables(null), {});
});

test('the shell statement unsets the same variables in a real sh, names a fixed list misses included', { skip: process.platform === 'win32' }, () => {
  const script = `${hostClaudeSessionUnsetStatement()} env`;
  const output = execFileSync('sh', ['-c', script], { env: { ...HOST_SESSION, ...CONFIGURATION }, encoding: 'utf8' });
  const names = new Set(output.split('\n').map((line) => line.split('=')[0]).filter(Boolean));
  for (const key of Object.keys(HOST_SESSION)) assert.equal(names.has(key), false, key);
  for (const key of Object.keys(CONFIGURATION)) assert.equal(names.has(key), true, key);
  assert.equal(names.has('oar_host_var'), false, 'the loop variable is gone too');
});
