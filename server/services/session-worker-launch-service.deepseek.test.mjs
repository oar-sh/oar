'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyClaudeCloudProviderEnvironment,
  applyClaudeProviderEnvironment,
  applyCopilotSdkProviderEnvironment,
  applyCursorProviderEnvironment,
  applyDeepSeekProviderEnvironment,
  applyGrokProviderEnvironment,
  applyOpenAIProviderEnvironment,
  buildTmuxWorkerShellCommand,
  createWorkerSecretEnvFile,
  isDeepSeekWorkerEnvironment,
  launchSessionCli,
  resolveDeepSeekWorkerScriptPath,
  resolveWorkerKind,
  withoutForeignWorkerSecrets,
  workerSecretEnvVarsFor,
} from './session-worker-launch-service.mjs';

const TEST_KEY = 'sk-test-4444444444444444';
const CONFIG_DIR = path.join(os.tmpdir(), 'oar-test-data', 'deepseek-claude');

function deepseekEnv(extra = {}) {
  return applyDeepSeekProviderEnvironment({ PATH: '/bin', ...extra }, {
    enabled: true,
    model: 'deepseek-flash',
    apiKey: TEST_KEY,
    baseUrl: 'http://127.0.0.1:4011',
    configDir: CONFIG_DIR,
  });
}

test('the DeepSeek applier names the worker, its model, endpoint, state directory and key', () => {
  const env = deepseekEnv();
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'deepseek');
  assert.equal(resolveWorkerKind(env), 'deepseek');
  assert.equal(isDeepSeekWorkerEnvironment(env), true);
  assert.equal(env.DEEPSEEK_RELAY_MODEL, 'deepseek-flash');
  assert.equal(env.DEEPSEEK_BASE_URL, 'http://127.0.0.1:4011');
  assert.equal(env.DEEPSEEK_CLAUDE_CONFIG_DIR, path.resolve(CONFIG_DIR));
  assert.equal(env.DEEPSEEK_API_KEY, TEST_KEY);
  assert.equal(env.PATH, '/bin');
  // Not the Claude worker: nothing Claude-only may match it.
  assert.equal('CLAUDE_RELAY_MODEL' in env, false);
});

test('the DeepSeek applier refuses a launch without a key or a state directory', () => {
  assert.throws(() => applyDeepSeekProviderEnvironment({}, { enabled: true, apiKey: '', configDir: CONFIG_DIR }), /deepseek-api-key-not-configured/);
  assert.throws(() => applyDeepSeekProviderEnvironment({}, { enabled: true, apiKey: TEST_KEY, configDir: '' }), /deepseek-config-dir-not-configured/);
});

test('the clear chain takes every DeepSeek variable out, in any order, and leaves other kinds alone', () => {
  const stale = deepseekEnv();
  const cleared = applyDeepSeekProviderEnvironment(applyClaudeCloudProviderEnvironment(applyCopilotSdkProviderEnvironment(
    applyGrokProviderEnvironment(applyCursorProviderEnvironment(applyClaudeProviderEnvironment(applyOpenAIProviderEnvironment(stale))))),
  ));
  assert.equal(resolveWorkerKind(cleared), 'copilot');
  for (const key of ['DEEPSEEK_API_KEY', 'DEEPSEEK_RELAY_MODEL', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_CLAUDE_CONFIG_DIR']) {
    assert.equal(key in cleared, false, key);
  }
  const claude = applyDeepSeekProviderEnvironment(applyClaudeProviderEnvironment({}, { enabled: true, model: 'claude-opus-5' }));
  assert.equal(claude.COPILOT_WEB_RELAY_WORKER_KIND, 'claude');
});

test('the worker script is found like the other node workers', () => {
  assert.equal(resolveDeepSeekWorkerScriptPath({ COPILOT_WEB_RELAY_DEEPSEEK_WORKER_PATH: '/custom/worker.mjs' }), '/custom/worker.mjs');
  assert.equal(
    resolveDeepSeekWorkerScriptPath({ COPILOT_WEB_RELAY_ROOT: '/repo' }),
    path.join('/repo', 'server', 'deepseek-worker', 'deepseek-session-worker.mjs'),
  );
  assert.equal(
    resolveDeepSeekWorkerScriptPath({ COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server' }),
    path.join('/repo/server', 'deepseek-worker', 'deepseek-session-worker.mjs'),
  );
});

test('the DeepSeek key is a secret of the DeepSeek worker and of no other', () => {
  assert.equal(workerSecretEnvVarsFor({ COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek' }).includes('DEEPSEEK_API_KEY'), true);
  // Nor does the DeepSeek worker get the host's Claude login.
  assert.equal(workerSecretEnvVarsFor({ COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek' }).includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
  for (const kind of ['', 'claude', 'claude-cloud', 'cursor', 'grok', 'copilot-sdk']) {
    const env = { COPILOT_WEB_RELAY_WORKER_KIND: kind, DEEPSEEK_API_KEY: TEST_KEY };
    assert.equal(workerSecretEnvVarsFor(env).includes('DEEPSEEK_API_KEY'), false, kind || 'copilot');
    // A key exported in the relay's own environment does not travel either.
    assert.equal('DEEPSEEK_API_KEY' in withoutForeignWorkerSecrets(env), false, kind || 'copilot');
  }
  const scrubbed = withoutForeignWorkerSecrets(deepseekEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value' }));
  assert.equal(scrubbed.DEEPSEEK_API_KEY, TEST_KEY);
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in scrubbed, false);
});

test('the secret file of a DeepSeek launch carries the key, owner-only', () => {
  const calls = [];
  const fsImpl = {
    mkdtempSync: () => '/tmp/copilot-relay-worker-test',
    chmodSync: (target, mode) => calls.push(['chmod', target, mode]),
    writeFileSync: (target, contents, options) => calls.push(['write', target, contents, options]),
    rmSync() {},
    rmdirSync() {},
  };
  createWorkerSecretEnvFile(deepseekEnv(), { fsImpl, tempRoot: '/tmp' });
  const write = calls.find((call) => call[0] === 'write');
  assert.equal(write[2], `export DEEPSEEK_API_KEY='${TEST_KEY}'\n`);
  assert.deepEqual(write[3], { encoding: 'utf8', mode: 0o600 });
});

test('the tmux command exports the model, endpoint and state directory, never the key', () => {
  const env = { ...deepseekEnv(), COPILOT_WEB_RELAY_ROOT: '/repo' };
  assert.throws(() => buildTmuxWorkerShellCommand('session-1', env), /worker-secret-env-file-required/);
  const command = buildTmuxWorkerShellCommand('session-1', env, { secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env' });
  assert.match(command, /export COPILOT_WEB_RELAY_WORKER_KIND='deepseek';/);
  assert.match(command, /export DEEPSEEK_RELAY_MODEL='deepseek-flash';/);
  assert.match(command, /export DEEPSEEK_BASE_URL='http:\/\/127\.0\.0\.1:4011';/);
  assert.match(command, /export DEEPSEEK_CLAUDE_CONFIG_DIR=/);
  assert.equal(command.includes(TEST_KEY), false);
  assert.equal(command.includes('DEEPSEEK_API_KEY'), false);
  assert.match(command, /deepseek-worker.deepseek-session-worker\.mjs' --session-id 'session-1'$/);
});

test('launchSessionCli starts tmux without the key and hands it over in the secret file', async () => {
  const calls = [];
  const secretEnvs = [];
  await launchSessionCli({
    targetSessionId: 'session-7',
    cwd: '/workspace',
    env: { ...deepseekEnv(), COPILOT_WEB_RELAY_ROOT: '/repo', CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value' },
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
    createSecretEnvFileImpl: (env) => {
      secretEnvs.push(workerSecretEnvVarsFor(env).filter((key) => env[key]).map((key) => `${key}=${env[key]}`));
      return { filePath: '/tmp/copilot-relay-worker-test/provider.env', cleanup() {} };
    },
  });
  assert.deepEqual(secretEnvs, [[`DEEPSEEK_API_KEY=${TEST_KEY}`]]);
  const newSessionCall = calls.find((call) => call.args?.[0] === 'new-session');
  const tmuxEnv = JSON.stringify(newSessionCall.options.env);
  assert.equal(tmuxEnv.includes(TEST_KEY), false);
  assert.equal(tmuxEnv.includes('test-token-value'), false);
  assert.equal(newSessionCall.args.at(-1).includes(TEST_KEY), false);
});

test('a detached launch of another kind never carries a DeepSeek key from the relay environment', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-deepseek-launch-'));
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
          DEEPSEEK_API_KEY: TEST_KEY,
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
