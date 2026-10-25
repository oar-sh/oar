'use strict';

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOST_CLAUDE_SESSION_ENV_VARS,
  TMUX_WORKER_EXPORTED_ENV_VARS,
  applyClaudeCloudProviderEnvironment,
  applyClaudeProviderEnvironment,
  applyCopilotSdkProviderEnvironment,
  applyCursorProviderEnvironment,
  applyDeepSeekProviderEnvironment,
  applyGrokProviderEnvironment,
  launchSessionCli,
  withoutHostClaudeSessionVariables,
} from './session-worker-launch-service.mjs';

// What a relay started from inside a Claude Code session carries. Values are
// made up; the names are what the host sets.
const HOST_SESSION = Object.freeze({
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session-0000',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/host-claude.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'host-messaging-token',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_EXECPATH: '/opt/claude/claude',
  CLAUDE_PID: '4321',
  CLAUDE_EFFORT: 'high',
  // Found in a Windows worker's environment in a live check (names only),
  // the host being a relay worker's Claude Code.
  CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS: '120000',
  CLAUDE_AGENT_SDK_VERSION: '0.0.0',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'host-app',
  // On no list: a family the next CLI version could add to.
  CLAUDE_CODE_SESSION_KIND: 'agent',
  CLAUDE_CODE_HOST_SESSION_ID: 'host-session-0001',
});

const TEST_KEY = 'sk-test-6666666666666666';
const RELAY_ENV = Object.freeze({
  PATH: '/bin',
  COPILOT_WEB_RELAY_ROOT: '/repo',
  COPILOT_SDK_PATH: '/repo/node_modules/@github/copilot-sdk',
  // The relay's own Claude configuration: not a session marker, so it stays.
  CLAUDE_CONFIG_DIR: '/srv/oar/claude-config',
  CLAUDE_CODE_EXECUTABLE: '/srv/oar/bin/claude',
  ...HOST_SESSION,
});

// Operator settings that look like the host session's but are not: the
// SDK's switches and the two settings inside the session family.
const KEPT_SETTINGS = Object.freeze({
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
  CLAUDE_AGENT_SDK_MCP_NO_PREFIX: '1',
  CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS: '1',
  CLAUDE_CODE_SESSION_START_ANNOUNCEMENTS_BEFORE_PROMPT: '1',
  CLAUDE_CODE_SESSION_LOG: '/tmp/claude-session.log',
});

// One launch environment per provider, each with the host's session variables
// on it, as the relay has them when it was started under Claude Code.
const PROVIDERS = [
  { kind: 'copilot', modelVar: null, env: () => ({ ...RELAY_ENV }) },
  { kind: 'copilot-sdk', modelVar: 'COPILOT_RELAY_MODEL', env: () => applyCopilotSdkProviderEnvironment(RELAY_ENV, { enabled: true, model: 'gpt-5.4-mini' }) },
  { kind: 'claude', modelVar: 'CLAUDE_RELAY_MODEL', env: () => applyClaudeProviderEnvironment(RELAY_ENV, { enabled: true, model: 'claude-opus-5' }) },
  { kind: 'claude-cloud', modelVar: 'CLAUDE_CLOUD_RELAY_MODEL', env: () => applyClaudeCloudProviderEnvironment(RELAY_ENV, { enabled: true, model: 'claude-opus-5' }) },
  { kind: 'cursor', modelVar: 'CURSOR_RELAY_MODEL', env: () => applyCursorProviderEnvironment(RELAY_ENV, { enabled: true, model: 'cursor-fast-1', apiKey: 'cursor-test-key' }) },
  { kind: 'grok', modelVar: 'GROK_RELAY_MODEL', env: () => applyGrokProviderEnvironment(RELAY_ENV, { enabled: true, model: 'grok-4' }) },
  {
    kind: 'deepseek',
    modelVar: 'DEEPSEEK_RELAY_MODEL',
    env: () => applyDeepSeekProviderEnvironment(RELAY_ENV, {
      enabled: true,
      model: 'deepseek-flash',
      apiKey: TEST_KEY,
      baseUrl: 'http://127.0.0.1:4011',
      configDir: path.join(os.tmpdir(), 'oar-test-data', 'deepseek-claude'),
    }),
  },
];

function assertNoHostSessionVariables(env, label) {
  for (const key of [...HOST_CLAUDE_SESSION_ENV_VARS, ...Object.keys(HOST_SESSION)]) {
    assert.equal(key in env, false, `${label}: ${key}`);
  }
  const serialized = JSON.stringify(env);
  for (const value of ['host-session-0000', 'host-messaging-token', '/tmp/host-claude.sock']) {
    assert.equal(serialized.includes(value), false, `${label}: ${value}`);
  }
}

async function launchUnderTmux(env) {
  const calls = [];
  await launchSessionCli({
    targetSessionId: 'session-3',
    cwd: '/workspace',
    env,
    platform: 'linux',
    execFileSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === '-V') return Buffer.from('tmux 3.6');
      if (args[0] === 'has-session') throw Object.assign(new Error('missing'), { status: 1 });
      return Buffer.alloc(0);
    },
    processInspector: { findProcessForSessionAsync: () => ({ processId: process.pid }) },
    allowProcessReuse: false,
    tmuxPollAttempts: 1,
    tmuxPollDelayMs: 1,
    createSecretEnvFileImpl: () => ({ filePath: '/tmp/copilot-relay-worker-test/provider.env', cleanup() {} }),
    prepareOarMcpConfigImpl: () => null,
    locateExecutableImpl: () => true,
  });
  const newSession = calls.find((call) => call.args?.[0] === 'new-session');
  assert.ok(newSession, 'tmux new-session was run');
  return { tmuxEnv: newSession.options.env, shellCommand: newSession.args.at(-1) };
}

async function launchDetached(env, platform) {
  const spawnCalls = [];
  await launchSessionCli({
    targetSessionId: 'session-3',
    cwd: '/workspace',
    env: { ...env, ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    platform,
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 4242, unref: () => {} };
    },
    execFileSyncImpl: () => { throw new Error('tmux missing'); },
    processInspector: { findProcessForSessionAsync: () => (platform === 'win32' ? { processId: process.pid } : null) },
    prepareWorkerLogFileImpl: () => null,
    prepareOarMcpConfigImpl: () => null,
    locateExecutableImpl: () => true,
    allowProcessReuse: false,
    detachedPollAttempts: 1,
    detachedPollDelayMs: 1,
  });
  assert.equal(spawnCalls.length, 1);
  return spawnCalls[0].options.env;
}

test('withoutHostClaudeSessionVariables drops the session markers and keeps the relay\'s Claude configuration', () => {
  const env = withoutHostClaudeSessionVariables(RELAY_ENV);
  assertNoHostSessionVariables(env, 'scrubbed');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/srv/oar/claude-config');
  assert.equal(env.CLAUDE_CODE_EXECUTABLE, '/srv/oar/bin/claude');
  assert.equal(env.PATH, '/bin');
  // The input is left alone.
  assert.equal(RELAY_ENV.CLAUDECODE, '1');
});

test('under tmux no provider\'s worker gets the host Claude session variables, and nothing of one launch goes into tmux\'s environment', async () => {
  for (const provider of PROVIDERS) {
    const env = provider.env();
    const { tmuxEnv, shellCommand } = await launchUnderTmux(env);
    assertNoHostSessionVariables(tmuxEnv, `${provider.kind} tmux env`);
    for (const key of HOST_CLAUDE_SESSION_ENV_VARS) {
      assert.equal(shellCommand.includes(`export ${key}=`), false, `${provider.kind} command exports ${key}`);
    }
    // The values of this launch ride the shell command of this session only.
    for (const key of TMUX_WORKER_EXPORTED_ENV_VARS) {
      assert.equal(key in tmuxEnv, false, `${provider.kind} tmux env carries ${key}`);
    }
    assert.equal('PWD' in tmuxEnv, false, `${provider.kind} tmux env carries PWD`);
    if (provider.kind !== 'copilot') {
      assert.match(shellCommand, new RegExp(`export COPILOT_WEB_RELAY_WORKER_KIND='${provider.kind}';`), provider.kind);
    }
    if (provider.modelVar) {
      assert.match(shellCommand, new RegExp(`export ${provider.modelVar}='[^']+';`), `${provider.kind} exports its model`);
      assert.equal(provider.modelVar in tmuxEnv, false, `${provider.kind} tmux env carries ${provider.modelVar}`);
    }
    // The relay's own configuration still reaches the worker.
    assert.match(shellCommand, /export CLAUDE_CONFIG_DIR='\/srv\/oar\/claude-config';/, provider.kind);
    assert.match(tmuxEnv.PATH, /^\/bin(?::|$)/, provider.kind);
  }
});

test('without tmux (detached and Windows) no provider\'s worker gets the host Claude session variables', async () => {
  for (const provider of PROVIDERS) {
    for (const platform of ['linux', 'win32']) {
      const env = await launchDetached(provider.env(), platform);
      assertNoHostSessionVariables(env, `${provider.kind} ${platform}`);
      // The worker's own values are intact.
      if (provider.kind !== 'copilot') assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, provider.kind, platform);
      if (provider.modelVar) assert.ok(env[provider.modelVar], `${provider.kind} ${platform} keeps ${provider.modelVar}`);
      assert.equal(env.CLAUDE_CONFIG_DIR, '/srv/oar/claude-config', `${provider.kind} ${platform}`);
      assert.equal(env.SESSION_ID, 'session-3', `${provider.kind} ${platform}`);
    }
  }
});

test('under tmux every provider\'s command unsets the host session\'s variables a tmux server kept, by family too, and keeps the configuration', { skip: process.platform === 'win32' }, async () => {
  // A tmux server started from inside a Claude Code session: its global
  // environment, which every new session starts from, holds the host's
  // variables and the user's Claude Code settings.
  const serverEnv = {
    PATH: process.env.PATH,
    ...HOST_SESSION,
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000',
  };
  for (const provider of PROVIDERS) {
    const { shellCommand } = await launchUnderTmux(provider.env());
    // What runs before the secret file is read and the worker starts.
    const prelude = shellCommand.slice(0, shellCommand.search(/\. '[^']*provider\.env'|exec /));
    const output = execFileSync('sh', ['-c', `${prelude} env`], { env: serverEnv, encoding: 'utf8' });
    const names = new Set(output.split('\n').map((line) => line.split('=')[0]).filter(Boolean));
    for (const key of Object.keys(HOST_SESSION)) assert.equal(names.has(key), false, `${provider.kind}: ${key}`);
    for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CONFIG_DIR']) {
      assert.equal(names.has(key), true, `${provider.kind} keeps ${key}`);
    }
    if (provider.kind !== 'copilot') assert.equal(names.has('COPILOT_WEB_RELAY_WORKER_KIND'), true, provider.kind);
  }
});

test('the SDK\'s switches and the settings inside the session family reach every provider\'s worker without tmux', async () => {
  for (const provider of PROVIDERS) {
    const env = { ...provider.env(), ...KEPT_SETTINGS };
    for (const platform of ['linux', 'win32']) {
      const detached = await launchDetached(env, platform);
      for (const [key, value] of Object.entries(KEPT_SETTINGS)) {
        assert.equal(detached[key], value, `${provider.kind} ${platform} keeps ${key}`);
      }
      assertNoHostSessionVariables(detached, `${provider.kind} ${platform}`);
    }
  }
});

test('under tmux the command unsets none of the SDK\'s switches or the settings inside the session family', { skip: process.platform === 'win32' }, async () => {
  for (const provider of PROVIDERS) {
    const env = { ...provider.env(), ...KEPT_SETTINGS };
    // In what the tmux server keeps, the command's prelude leaves them.
    const { shellCommand } = await launchUnderTmux(env);
    const prelude = shellCommand.slice(0, shellCommand.search(/\. '[^']*provider\.env'|exec /));
    const output = execFileSync('sh', ['-c', `${prelude} env`], { env: { PATH: process.env.PATH, ...HOST_SESSION, ...KEPT_SETTINGS }, encoding: 'utf8' });
    const names = new Set(output.split('\n').map((line) => line.split('=')[0]).filter(Boolean));
    for (const key of Object.keys(KEPT_SETTINGS)) assert.equal(names.has(key), true, `${provider.kind} tmux keeps ${key}`);
    for (const key of Object.keys(HOST_SESSION)) assert.equal(names.has(key), false, `${provider.kind} tmux drops ${key}`);
  }
});
