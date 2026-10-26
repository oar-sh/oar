'use strict';

// A host's ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN reach no worker kind, on
// any launch path: tmux (the environment tmux is started with, the shell
// command, the secret file), detached, and the Windows console launch.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKER_SECRET_ENV_VARS,
  buildTmuxWorkerShellCommand,
  createWorkerSecretEnvFile,
  launchSessionCli,
  withoutForeignWorkerSecrets,
  workerSecretEnvVarsFor,
} from './session-worker-launch-service.mjs';

const HOST_KEY = 'test-host-anthropic-key-0000';
const HOST_TOKEN = 'test-host-anthropic-token-0000';
const HOST_ANTHROPIC = Object.freeze({ ANTHROPIC_API_KEY: HOST_KEY, ANTHROPIC_AUTH_TOKEN: HOST_TOKEN });
const ANTHROPIC_NAMES = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

// Every kind, with what it needs to get as far as the spawn.
const KINDS = Object.freeze({
  copilot: {},
  'copilot-sdk': { COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk', COPILOT_SDK_PATH: '/opt/copilot-sdk' },
  claude: { COPILOT_WEB_RELAY_WORKER_KIND: 'claude', CLAUDE_RELAY_MODEL: 'claude-sonnet-5-5' },
  'claude-cloud': { COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud', CLAUDE_CLOUD_RELAY_MODEL: 'claude-sonnet-5-5' },
  cursor: { COPILOT_WEB_RELAY_WORKER_KIND: 'cursor', CURSOR_API_KEY: 'cursor-test-key' },
  grok: { COPILOT_WEB_RELAY_WORKER_KIND: 'grok' },
  deepseek: { COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek', DEEPSEEK_API_KEY: 'deepseek-test-key' },
  'claude-api': { COPILOT_WEB_RELAY_WORKER_KIND: 'claude-api', OAR_CLAUDE_API_KEY: 'claude-api-test-key' },
});

function assertNoHostAnthropic(value, label) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(serialized.includes(HOST_KEY), false, label);
  assert.equal(serialized.includes(HOST_TOKEN), false, label);
}

test('the host Anthropic credentials are worker secrets of no kind', () => {
  for (const name of ANTHROPIC_NAMES) assert.equal(WORKER_SECRET_ENV_VARS.includes(name), true, name);
  for (const [kind, kindEnv] of Object.entries(KINDS)) {
    const own = workerSecretEnvVarsFor(kindEnv);
    for (const name of ANTHROPIC_NAMES) assert.equal(own.includes(name), false, `${kind} ${name}`);
  }
  // Nor a kind the launcher does not know.
  assert.equal(workerSecretEnvVarsFor({ COPILOT_WEB_RELAY_WORKER_KIND: 'unknown-kind' }).some((name) => ANTHROPIC_NAMES.includes(name)), false);
});

test('withoutForeignWorkerSecrets drops them for every kind and keeps each kind\'s own key', () => {
  for (const [kind, kindEnv] of Object.entries(KINDS)) {
    const input = { ...kindEnv, ...HOST_ANTHROPIC, PATH: '/bin' };
    const scrubbed = withoutForeignWorkerSecrets(input);
    for (const name of ANTHROPIC_NAMES) assert.equal(name in scrubbed, false, `${kind} ${name}`);
    assert.equal(scrubbed.PATH, '/bin', kind);
    // The caller's environment is left as it was.
    assert.equal(input.ANTHROPIC_API_KEY, HOST_KEY, kind);
  }
  assert.equal(withoutForeignWorkerSecrets({ ...KINDS.cursor, ...HOST_ANTHROPIC }).CURSOR_API_KEY, 'cursor-test-key');
  assert.equal(withoutForeignWorkerSecrets({ ...KINDS.deepseek, ...HOST_ANTHROPIC }).DEEPSEEK_API_KEY, 'deepseek-test-key');
});

function createRecordingFsImpl(calls) {
  return {
    mkdtempSync(prefix) {
      calls.push(['mkdtemp', prefix]);
      // platform-agnostic: the fake hands this directory back as it is.
      return '/tmp/copilot-relay-worker-test';
    },
    chmodSync(target, mode) { calls.push(['chmod', target, mode]); },
    writeFileSync(target, contents, options) { calls.push(['write', target, contents, options]); },
    rmSync(target, options) { calls.push(['rm', target, options]); },
    rmdirSync(target) { calls.push(['rmdir', target]); },
  };
}

test('no secret file carries them, for any kind', () => {
  for (const [kind, kindEnv] of Object.entries(KINDS)) {
    const calls = [];
    createWorkerSecretEnvFile({ ...kindEnv, ...HOST_ANTHROPIC }, { fsImpl: createRecordingFsImpl(calls), tempRoot: '/tmp' });
    assertNoHostAnthropic(calls, kind);
    for (const name of ANTHROPIC_NAMES) assert.equal(JSON.stringify(calls).includes(name), false, `${kind} ${name}`);
  }
  // With nothing else secret there, no file is written at all.
  const calls = [];
  assert.equal(createWorkerSecretEnvFile({ ...KINDS.claude, ...HOST_ANTHROPIC }, { fsImpl: createRecordingFsImpl(calls), tempRoot: '/tmp' }), null);
  assert.deepEqual(calls, []);
});

test('the tmux shell command exports neither and unsets both, for every kind', () => {
  for (const [kind, kindEnv] of Object.entries(KINDS)) {
    const command = buildTmuxWorkerShellCommand('session-5', { ...kindEnv, COPILOT_WEB_RELAY_ROOT: '/repo', ...HOST_ANTHROPIC }, {
      secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env',
    });
    assertNoHostAnthropic(command, kind);
    assert.doesNotMatch(command, /export ANTHROPIC_/, kind);
    // Before anything else runs: the pane may inherit them from a tmux server
    // the launch did not start, or the login profile may export them.
    assert.match(command, /^unset [^;]*\bANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;/, kind);
  }
});

function tmuxLaunchHarness() {
  const calls = [];
  const secretEnvs = [];
  return {
    calls,
    secretEnvs,
    options: {
      platform: 'linux',
      execFileSyncImpl(command, args, options) {
        calls.push({ command, args, options });
        if (command !== 'tmux') throw new Error(`unexpected command: ${command}`);
        if (args[0] === '-V') return Buffer.from('tmux 3.6');
        if (args[0] === 'has-session') {
          const err = new Error('missing');
          err.status = 1;
          throw err;
        }
        if (args[0] === 'new-session') return Buffer.alloc(0);
        throw new Error(`unexpected tmux args: ${args.join(' ')}`);
      },
      processInspector: {
        findProcessForSessionAsync: () => ({ processId: process.pid, commandLine: 'node worker --session-id session-5' }),
      },
      prepareOarMcpConfigImpl: () => null,
      locateExecutableImpl: () => true,
      allowProcessReuse: false,
      tmuxPollAttempts: 1,
      tmuxPollDelayMs: 1,
      // The real writer decides what goes into the file; only the disk is faked.
      createSecretEnvFileImpl: (env) => {
        const written = [];
        const secret = createWorkerSecretEnvFile(env, { fsImpl: createRecordingFsImpl(written), tempRoot: '/tmp' });
        secretEnvs.push(written.find((call) => call[0] === 'write')?.[2] ?? null);
        return secret ? { filePath: '/tmp/copilot-relay-worker-test/provider.env', cleanup() {} } : null;
      },
    },
  };
}

test('launchSessionCli under tmux: not in the tmux env, the shell command or the secret file, for every kind', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-anthropic-scope-'));
  try {
    for (const [kind, kindEnv] of Object.entries(KINDS)) {
      const harness = tmuxLaunchHarness();
      const launched = await launchSessionCli({
        targetSessionId: 'session-5',
        cwd: '/workspace',
        env: { ...kindEnv, COPILOT_WEB_RELAY_ROOT: '/repo', COPILOT_WEB_RELAY_LOG_DIR: logDir, ...HOST_ANTHROPIC },
        ...harness.options,
      });
      assert.equal(launched.launchMode, 'tmux', kind);
      const newSessionCall = harness.calls.find((call) => call.args?.[0] === 'new-session');
      assert.ok(newSessionCall, kind);
      // A tmux server started by this call keeps its client's environment.
      for (const name of ANTHROPIC_NAMES) assert.equal(name in newSessionCall.options.env, false, `${kind} ${name}`);
      assertNoHostAnthropic(newSessionCall.options.env, `${kind} tmux env`);
      assertNoHostAnthropic(newSessionCall.args, `${kind} shell command`);
      assertNoHostAnthropic(harness.secretEnvs, `${kind} secret file`);
      assert.match(newSessionCall.args.at(-1), /^unset [^;]*\bANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN;/, kind);
    }
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

async function detachedLaunchEnv(platform, env) {
  const spawnCalls = [];
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-anthropic-scope-'));
  try {
    await launchSessionCli({
      targetSessionId: 'session-6',
      cwd: '/workspace',
      env: {
        ...env,
        COPILOT_WEB_RELAY_ROOT: '/repo',
        COPILOT_WEB_RELAY_LOG_DIR: logDir,
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      },
      platform,
      spawnImpl: (command, args, options) => {
        spawnCalls.push({ command, args, options });
        return { pid: 4242, unref: () => {} };
      },
      execFileSyncImpl: () => { throw new Error('tmux missing'); },
      processInspector: { findProcessForSessionAsync: () => (platform === 'win32' ? { processId: process.pid } : null) },
      prepareOarMcpConfigImpl: () => null,
      prepareWorkerLogFileImpl: () => null,
      locateExecutableImpl: () => true,
      allowProcessReuse: false,
      detachedPollAttempts: 1,
      detachedPollDelayMs: 1,
    });
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
  assert.equal(spawnCalls.length, 1);
  return spawnCalls[0];
}

test('the detached (linux) and Windows (win32) launches hand neither to any kind', async () => {
  for (const platform of ['linux', 'win32']) {
    for (const [kind, kindEnv] of Object.entries(KINDS)) {
      const spawned = await detachedLaunchEnv(platform, { ...kindEnv, ...HOST_ANTHROPIC });
      for (const name of ANTHROPIC_NAMES) assert.equal(name in spawned.options.env, false, `${platform} ${kind} ${name}`);
      assertNoHostAnthropic(spawned.options.env, `${platform} ${kind} env`);
      assertNoHostAnthropic(spawned.args, `${platform} ${kind} args`);
    }
  }
});
