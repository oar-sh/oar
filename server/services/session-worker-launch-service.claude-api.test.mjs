'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyClaudeApiProviderEnvironment,
  applyClaudeCloudProviderEnvironment,
  applyClaudeProviderEnvironment,
  applyCopilotSdkProviderEnvironment,
  applyCursorProviderEnvironment,
  applyDeepSeekProviderEnvironment,
  applyGrokProviderEnvironment,
  applyOpenAIProviderEnvironment,
  buildTmuxWorkerShellCommand,
  createWorkerSecretEnvFile,
  isClaudeApiWorkerEnvironment,
  launchSessionCli,
  resolveClaudeApiWorkerScriptPath,
  resolveWorkerKind,
  withoutForeignWorkerSecrets,
  workerSecretEnvVarsFor,
} from './session-worker-launch-service.mjs';

const TEST_KEY = 'sk-ant-api03-test-0000';
const OTHER_KINDS = Object.freeze(['', 'claude', 'claude-cloud', 'cursor', 'grok', 'copilot-sdk', 'deepseek']);

function claudeApiEnv(extra = {}) {
  return applyClaudeApiProviderEnvironment({ PATH: '/bin', ...extra }, {
    enabled: true,
    model: 'claude-sonnet-5-5',
    apiKey: TEST_KEY,
  });
}

test('the Claude API applier names the worker, its model and the key, and no state directory', () => {
  const env = claudeApiEnv();
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'claude-api');
  assert.equal(resolveWorkerKind(env), 'claude-api');
  assert.equal(isClaudeApiWorkerEnvironment(env), true);
  assert.equal(env.CLAUDE_API_RELAY_MODEL, 'claude-sonnet-5-5');
  assert.equal(env.OAR_CLAUDE_API_KEY, TEST_KEY);
  assert.equal(env.PATH, '/bin');
  // The chats share the host's Claude Code state: no config directory of
  // their own, and nothing the Claude worker's launch would match.
  assert.equal('CLAUDE_CONFIG_DIR' in env, false);
  assert.equal('CLAUDE_RELAY_MODEL' in env, false);
  // The key travels under the relay's own name, never as the CLI's.
  assert.equal('ANTHROPIC_API_KEY' in env, false);
});

test('the Claude API applier refuses a launch without a key, and an empty model leaves the default', () => {
  assert.throws(() => applyClaudeApiProviderEnvironment({}, { enabled: true, apiKey: '  ' }), /claude-api-key-not-configured/);
  const env = applyClaudeApiProviderEnvironment({}, { enabled: true, apiKey: TEST_KEY, model: ' ' });
  assert.equal('CLAUDE_API_RELAY_MODEL' in env, false);
});

test('the clear chain takes every Claude API variable out, in any order, and leaves other kinds alone', () => {
  const stale = claudeApiEnv();
  const cleared = applyClaudeApiProviderEnvironment(applyDeepSeekProviderEnvironment(applyClaudeCloudProviderEnvironment(
    applyCopilotSdkProviderEnvironment(applyGrokProviderEnvironment(applyCursorProviderEnvironment(
      applyClaudeProviderEnvironment(applyOpenAIProviderEnvironment(stale)),
    ))),
  )));
  assert.equal(resolveWorkerKind(cleared), 'copilot');
  for (const key of ['OAR_CLAUDE_API_KEY', 'CLAUDE_API_RELAY_MODEL']) assert.equal(key in cleared, false, key);
  const claude = applyClaudeApiProviderEnvironment(applyClaudeProviderEnvironment({}, { enabled: true, model: 'claude-opus-5' }));
  assert.equal(claude.COPILOT_WEB_RELAY_WORKER_KIND, 'claude');
});

test('the worker script is found like the other node workers', () => {
  assert.equal(resolveClaudeApiWorkerScriptPath({ COPILOT_WEB_RELAY_CLAUDE_API_WORKER_PATH: '/custom/worker.mjs' }), '/custom/worker.mjs');
  assert.equal(
    resolveClaudeApiWorkerScriptPath({ COPILOT_WEB_RELAY_ROOT: '/repo' }),
    path.join('/repo', 'server', 'claude-api-worker', 'claude-api-session-worker.mjs'),
  );
  assert.equal(
    resolveClaudeApiWorkerScriptPath({ COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server' }),
    path.join('/repo/server', 'claude-api-worker', 'claude-api-session-worker.mjs'),
  );
});

test('the Claude API key is a secret of the Claude API worker and of no other', () => {
  const own = workerSecretEnvVarsFor({ COPILOT_WEB_RELAY_WORKER_KIND: 'claude-api' });
  assert.equal(own.includes('OAR_CLAUDE_API_KEY'), true);
  // Nor does the Claude API worker get the host's Claude login or the host's
  // Anthropic credentials: the saved key is the only credential it carries.
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY']) {
    assert.equal(own.includes(name), false, name);
  }
  for (const kind of OTHER_KINDS) {
    const env = { COPILOT_WEB_RELAY_WORKER_KIND: kind, OAR_CLAUDE_API_KEY: TEST_KEY };
    assert.equal(workerSecretEnvVarsFor(env).includes('OAR_CLAUDE_API_KEY'), false, kind || 'copilot');
    // A key exported in the relay's own environment does not travel either.
    assert.equal('OAR_CLAUDE_API_KEY' in withoutForeignWorkerSecrets(env), false, kind || 'copilot');
  }
  const scrubbed = withoutForeignWorkerSecrets(claudeApiEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value', ANTHROPIC_API_KEY: 'test-host-key' }));
  assert.equal(scrubbed.OAR_CLAUDE_API_KEY, TEST_KEY);
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in scrubbed, false);
  assert.equal('ANTHROPIC_API_KEY' in scrubbed, false);
});

test('the secret file of a Claude API launch carries the key, owner-only, and no other kind\'s file does', () => {
  const writes = [];
  const fsImpl = {
    mkdtempSync: () => '/tmp/copilot-relay-worker-test',
    chmodSync() {},
    writeFileSync: (target, contents, options) => writes.push([target, contents, options]),
    rmSync() {},
    rmdirSync() {},
  };
  createWorkerSecretEnvFile(claudeApiEnv(), { fsImpl, tempRoot: '/tmp' });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], `export OAR_CLAUDE_API_KEY='${TEST_KEY}'\n`);
  assert.deepEqual(writes[0][2], { encoding: 'utf8', mode: 0o600 });
  for (const kind of OTHER_KINDS) {
    writes.length = 0;
    createWorkerSecretEnvFile({ COPILOT_WEB_RELAY_WORKER_KIND: kind, OAR_CLAUDE_API_KEY: TEST_KEY }, { fsImpl, tempRoot: '/tmp' });
    assert.equal(writes.some((write) => String(write[1]).includes(TEST_KEY)), false, kind || 'copilot');
  }
});

test('the tmux command exports the model, never the key', () => {
  const env = { ...claudeApiEnv(), COPILOT_WEB_RELAY_ROOT: '/repo' };
  assert.throws(() => buildTmuxWorkerShellCommand('session-1', env), /worker-secret-env-file-required/);
  const command = buildTmuxWorkerShellCommand('session-1', env, { secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env' });
  assert.match(command, /export COPILOT_WEB_RELAY_WORKER_KIND='claude-api';/);
  assert.match(command, /export CLAUDE_API_RELAY_MODEL='claude-sonnet-5-5';/);
  assert.equal(command.includes(TEST_KEY), false);
  assert.equal(command.includes('export OAR_CLAUDE_API_KEY'), false);
  // Sourced from the file after the unset, so a host value cannot win.
  assert.match(command, /\. '\/tmp\/copilot-relay-worker-test\/provider\.env'/);
  assert.match(command, /claude-api-worker.claude-api-session-worker\.mjs' --session-id 'session-1'$/);
  // The loopback test endpoint travels when it is set, as a plain variable.
  const pinned = buildTmuxWorkerShellCommand('session-1', { ...env, OAR_ANTHROPIC_API_BASE_URL: 'http://127.0.0.1:4012' }, {
    secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env',
  });
  assert.match(pinned, /export OAR_ANTHROPIC_API_BASE_URL='http:\/\/127\.0\.0\.1:4012';/);
});

test('every other kind\'s tmux command leaves the key out and unsets a host value', () => {
  for (const kind of OTHER_KINDS) {
    const env = { COPILOT_WEB_RELAY_WORKER_KIND: kind, COPILOT_WEB_RELAY_ROOT: '/repo', OAR_CLAUDE_API_KEY: TEST_KEY, CURSOR_API_KEY: 'cursor-test-key', DEEPSEEK_API_KEY: 'deepseek-test-key', DEEPSEEK_CLAUDE_CONFIG_DIR: '/tmp/ds' };
    let command;
    try {
      command = buildTmuxWorkerShellCommand('session-1', env, { secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env' });
    } catch (error) {
      assert.fail(`${kind || 'copilot'}: ${error.message}`);
    }
    assert.equal(command.includes(TEST_KEY), false, kind || 'copilot');
    assert.match(command, /^unset [^;]*\bOAR_CLAUDE_API_KEY\b/, kind || 'copilot');
  }
});

async function launchUnderTmux(env) {
  const calls = [];
  const secretEnvs = [];
  await launchSessionCli({
    targetSessionId: 'session-7',
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
    createSecretEnvFileImpl: (secretEnv) => {
      secretEnvs.push(workerSecretEnvVarsFor(secretEnv).filter((key) => secretEnv[key]).map((key) => `${key}=${secretEnv[key]}`));
      return { filePath: '/tmp/copilot-relay-worker-test/provider.env', cleanup() {} };
    },
  });
  return { newSessionCall: calls.find((call) => call.args?.[0] === 'new-session'), secretEnvs };
}

test('launchSessionCli starts tmux without the key and hands it over in the secret file', async () => {
  const { newSessionCall, secretEnvs } = await launchUnderTmux({
    ...claudeApiEnv(),
    COPILOT_WEB_RELAY_ROOT: '/repo',
    CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
    ANTHROPIC_API_KEY: 'test-host-key',
  });
  assert.deepEqual(secretEnvs, [[`OAR_CLAUDE_API_KEY=${TEST_KEY}`]]);
  const tmuxEnv = JSON.stringify(newSessionCall.options.env);
  assert.equal(tmuxEnv.includes(TEST_KEY), false);
  assert.equal(tmuxEnv.includes('test-token-value'), false);
  assert.equal(tmuxEnv.includes('test-host-key'), false);
  assert.equal(newSessionCall.args.at(-1).includes(TEST_KEY), false);
});

test('a tmux launch of another kind carries the key nowhere, the secret file included', async () => {
  for (const kind of ['claude', 'deepseek', 'cursor']) {
    const kindEnv = {
      claude: { COPILOT_WEB_RELAY_WORKER_KIND: 'claude' },
      deepseek: { COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-test-key', DEEPSEEK_CLAUDE_CONFIG_DIR: '/tmp/ds' },
      cursor: { COPILOT_WEB_RELAY_WORKER_KIND: 'cursor', CURSOR_API_KEY: 'cursor-test-key' },
    }[kind];
    const { newSessionCall, secretEnvs } = await launchUnderTmux({ ...kindEnv, COPILOT_WEB_RELAY_ROOT: '/repo', OAR_CLAUDE_API_KEY: TEST_KEY });
    assert.equal(JSON.stringify(newSessionCall.options.env).includes(TEST_KEY), false, kind);
    assert.equal(newSessionCall.args.at(-1).includes(TEST_KEY), false, kind);
    assert.equal(JSON.stringify(secretEnvs).includes(TEST_KEY), false, kind);
  }
});

test('a detached launch of another kind never carries a Claude API key from the relay environment', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-claude-api-launch-'));
  try {
    for (const platform of ['linux', 'win32']) {
      const spawnCalls = [];
      await launchSessionCli({
        targetSessionId: 'session-9',
        cwd: '/workspace',
        env: {
          COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
          COPILOT_WEB_RELAY_ROOT: '/repo',
          COPILOT_WEB_RELAY_LOG_DIR: logDir,
          ComSpec: 'C:\\Windows\\System32\\cmd.exe',
          OAR_CLAUDE_API_KEY: TEST_KEY,
        },
        platform,
        spawnImpl: (command, args, options) => {
          spawnCalls.push({ options });
          return { pid: 4242, unref: () => {} };
        },
        execFileSyncImpl: () => { throw new Error('tmux missing'); },
        processInspector: { findProcessForSessionAsync: () => (platform === 'win32' ? { processId: process.pid } : null) },
        prepareWorkerLogFileImpl: () => null,
        locateExecutableImpl: () => true,
        allowProcessReuse: false,
        detachedPollAttempts: 1,
        detachedPollDelayMs: 1,
      });
      assert.equal(JSON.stringify(spawnCalls[0].options.env).includes(TEST_KEY), false, platform);
    }
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
