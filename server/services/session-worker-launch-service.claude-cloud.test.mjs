'use strict';

import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKER_SECRET_ENV_VARS,
  applyClaudeCloudProviderEnvironment,
  applyClaudeProviderEnvironment,
  applyCopilotSdkProviderEnvironment,
  applyCursorProviderEnvironment,
  applyGrokProviderEnvironment,
  applyOpenAIProviderEnvironment,
  buildTmuxWorkerShellCommand,
  createWorkerSecretEnvFile,
  isClaudeCloudWorkerEnvironment,
  isClaudeWorkerEnvironment,
  launchSessionCli,
  resolveClaudeCloudWorkerScriptPath,
  resolveWorkerKind,
  workerSecretEnvVarsFor,
} from './session-worker-launch-service.mjs';

test('applyClaudeCloudProviderEnvironment sets the worker kind and model when enabled', () => {
  const env = applyClaudeCloudProviderEnvironment({ PATH: '/bin' }, { enabled: true, model: 'claude-sonnet-5-5' });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'claude-cloud');
  assert.equal(env.CLAUDE_CLOUD_RELAY_MODEL, 'claude-sonnet-5-5');
  assert.equal(env.PATH, '/bin');
  assert.equal(isClaudeCloudWorkerEnvironment(env), true);
  assert.equal(resolveWorkerKind(env), 'claude-cloud');
  // A cloud worker is not a Claude worker: nothing Claude-only may match it.
  assert.equal(isClaudeWorkerEnvironment(env), false);
  assert.equal('CLAUDE_RELAY_MODEL' in env, false);
});

test('applyClaudeCloudProviderEnvironment clears its keys when disabled and leaves the others', () => {
  const env = applyClaudeCloudProviderEnvironment({
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
    CLAUDE_CLOUD_RELAY_MODEL: 'claude-sonnet-5-5',
    CLAUDE_RELAY_MODEL: 'claude-opus-5',
    PATH: '/bin',
  });
  assert.equal('COPILOT_WEB_RELAY_WORKER_KIND' in env, false);
  assert.equal('CLAUDE_CLOUD_RELAY_MODEL' in env, false);
  assert.equal(env.CLAUDE_RELAY_MODEL, 'claude-opus-5');

  // Another provider's kind survives the clear, whatever the order.
  const claude = applyClaudeCloudProviderEnvironment(applyClaudeProviderEnvironment({}, { enabled: true, model: 'claude-opus-5' }));
  assert.equal(claude.COPILOT_WEB_RELAY_WORKER_KIND, 'claude');
  const cloud = applyClaudeProviderEnvironment(applyClaudeCloudProviderEnvironment({}, { enabled: true, model: 'claude-sonnet-5-5' }));
  assert.equal(cloud.COPILOT_WEB_RELAY_WORKER_KIND, 'claude-cloud');
});

test('the clear chain the relay runs before binding a session removes a stale cloud kind', () => {
  const stale = { COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud', CLAUDE_CLOUD_RELAY_MODEL: 'claude-sonnet-5-5' };
  const cleared = applyClaudeCloudProviderEnvironment(applyCopilotSdkProviderEnvironment(applyGrokProviderEnvironment(
    applyCursorProviderEnvironment(applyClaudeProviderEnvironment(applyOpenAIProviderEnvironment(stale))),
  )));
  assert.equal(resolveWorkerKind(cleared), 'copilot');
  assert.equal('CLAUDE_CLOUD_RELAY_MODEL' in cleared, false);
});

test('the provider applier adds no login material to the cloud worker environment', () => {
  const env = applyClaudeCloudProviderEnvironment({}, { enabled: true, model: 'claude-sonnet-5-5' });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CLOUD_RELAY_MODEL', 'COPILOT_WEB_RELAY_WORKER_KIND']);
});

test('a relay-level Claude login token is a secret of the cloud worker and of no other', () => {
  assert.equal(WORKER_SECRET_ENV_VARS.includes('CLAUDE_CODE_OAUTH_TOKEN'), true);
  assert.deepEqual(
    workerSecretEnvVarsFor({ COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud' }),
    ['COPILOT_PROVIDER_API_KEY', 'CURSOR_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  );
  for (const kind of ['', 'claude', 'cursor', 'grok', 'copilot-sdk', 'unknown-kind']) {
    assert.deepEqual(
      workerSecretEnvVarsFor(kind ? { COPILOT_WEB_RELAY_WORKER_KIND: kind } : {}),
      ['COPILOT_PROVIDER_API_KEY', 'CURSOR_API_KEY'],
      kind || 'copilot',
    );
  }
});

function createRecordingFsImpl(calls) {
  return {
    mkdtempSync(prefix) {
      calls.push(['mkdtemp', prefix]);
      // platform-agnostic: the fake hands this directory back as it is;
      // nothing below is a path the host joined onto the temp root.
      return '/tmp/copilot-relay-worker-test';
    },
    chmodSync(target, mode) {
      calls.push(['chmod', target, mode]);
    },
    writeFileSync(target, contents, options) {
      calls.push(['write', target, contents, options]);
    },
    rmSync(target, options) {
      calls.push(['rm', target, options]);
    },
    rmdirSync(target) {
      calls.push(['rmdir', target]);
    },
  };
}

test('the secret file of a cloud launch carries the login token, owner-only', () => {
  const calls = [];
  const secret = createWorkerSecretEnvFile({
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
    CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
  }, {
    fsImpl: createRecordingFsImpl(calls),
    tempRoot: '/tmp',
  });
  assert.equal(secret.filePath, path.join('/tmp/copilot-relay-worker-test', 'provider.env'));
  assert.deepEqual(calls[1], ['chmod', '/tmp/copilot-relay-worker-test', 0o700]);
  assert.equal(calls[2][2], "export CLAUDE_CODE_OAUTH_TOKEN='test-token-value'\n");
  assert.deepEqual(calls[2][3], { encoding: 'utf8', mode: 0o600 });
});

test('no other worker kind gets the login token: no secret file is written for it', () => {
  for (const kind of ['', 'claude', 'cursor', 'grok', 'copilot-sdk']) {
    const calls = [];
    const secret = createWorkerSecretEnvFile({
      ...(kind ? { COPILOT_WEB_RELAY_WORKER_KIND: kind } : {}),
      CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
    }, {
      fsImpl: createRecordingFsImpl(calls),
      tempRoot: '/tmp',
    });
    assert.equal(secret, null, kind || 'copilot');
    assert.deepEqual(calls, []);
  }
  // And a key that is that worker's own still travels without the token.
  const calls = [];
  createWorkerSecretEnvFile({
    COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
    CURSOR_API_KEY: 'cursor-test-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
  }, {
    fsImpl: createRecordingFsImpl(calls),
    tempRoot: '/tmp',
  });
  assert.equal(calls[2][2], "export CURSOR_API_KEY='cursor-test-key'\n");
});

test('resolveClaudeCloudWorkerScriptPath prefers explicit path, then repo root, then server dir', () => {
  assert.equal(
    resolveClaudeCloudWorkerScriptPath({ COPILOT_WEB_RELAY_CLAUDE_CLOUD_WORKER_PATH: '/custom/worker.mjs' }),
    '/custom/worker.mjs',
  );
  assert.equal(
    resolveClaudeCloudWorkerScriptPath({ COPILOT_WEB_RELAY_ROOT: '/repo' }),
    path.join('/repo', 'server', 'claude-cloud-worker', 'claude-cloud-session-worker.mjs'),
  );
  assert.equal(
    resolveClaudeCloudWorkerScriptPath({ COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server' }),
    path.join('/repo/server', 'claude-cloud-worker', 'claude-cloud-session-worker.mjs'),
  );
});

test('tmux shell command for cloud workers runs node, exports the model and no token', () => {
  const env = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
    CLAUDE_CLOUD_RELAY_MODEL: 'claude-sonnet-5-5',
    CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
  };
  const command = buildTmuxWorkerShellCommand('session-1', env, {
    secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env',
  });
  const workerScript = path.join('/repo', 'server', 'claude-cloud-worker', 'claude-cloud-session-worker.mjs')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(command, new RegExp(`exec 'node' '${workerScript}' --session-id 'session-1'$`));
  assert.doesNotMatch(command, /script -q/);
  assert.doesNotMatch(command, /--allow-all/);
  assert.match(command, /export COPILOT_WEB_RELAY_WORKER_KIND='claude-cloud';/);
  assert.match(command, /export CLAUDE_CLOUD_RELAY_MODEL='claude-sonnet-5-5';/);
  // The token is on no command line: the worker sources it from the secret
  // file, which is gone before the worker starts.
  assert.equal(command.includes('test-token-value'), false);
  assert.equal(command.includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.match(
    command,
    /\. '\/tmp\/copilot-relay-worker-test\/provider\.env' \|\| exit \$\?; rm -f '\/tmp\/copilot-relay-worker-test\/provider\.env'; rmdir '\/tmp\/copilot-relay-worker-test'; exec /,
  );
});

test('a cloud launch with a login token and no secret file is refused, another kind does not need one', () => {
  const cloudEnv = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
    CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
    COPILOT_WEB_RELAY_ROOT: '/repo',
  };
  assert.throws(() => buildTmuxWorkerShellCommand('session-1', cloudEnv), /worker-secret-env-file-required/);
  // The token in the relay's environment is not another worker's business:
  // its command is built without a secret file and without the token.
  for (const kind of ['claude', 'grok']) {
    const command = buildTmuxWorkerShellCommand('session-1', { ...cloudEnv, COPILOT_WEB_RELAY_WORKER_KIND: kind });
    assert.equal(command.includes('test-token-value'), false, kind);
    assert.equal(command.includes('CLAUDE_CODE_OAUTH_TOKEN'), false, kind);
  }
});

test('the fake-API base URL of a test relay reaches the tmux worker as a plain export', () => {
  const command = buildTmuxWorkerShellCommand('session-1', {
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    OAR_CLAUDE_CLOUD_API_BASE_URL: 'http://127.0.0.1:4010',
  });
  assert.match(command, /export OAR_CLAUDE_CLOUD_API_BASE_URL='http:\/\/127\.0\.0\.1:4010';/);
  // Unset on the relay, unset for the worker.
  const plain = buildTmuxWorkerShellCommand('session-1', {
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
    COPILOT_WEB_RELAY_ROOT: '/repo',
  });
  assert.equal(plain.includes('OAR_CLAUDE_CLOUD_API_BASE_URL'), false);
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
        findProcessForSessionAsync: () => ({ processId: process.pid, commandLine: 'node worker --session-id session-7' }),
      },
      allowProcessReuse: false,
      tmuxPollAttempts: 1,
      tmuxPollDelayMs: 1,
      // The real writer decides what goes into the file; only the disk is
      // faked, and the path the shell command gets is a fixed one.
      createSecretEnvFileImpl: (env) => {
        const written = [];
        const secret = createWorkerSecretEnvFile(env, { fsImpl: createRecordingFsImpl(written), tempRoot: '/tmp' });
        secretEnvs.push(written.find((call) => call[0] === 'write')?.[2] ?? null);
        return secret ? { filePath: '/tmp/copilot-relay-worker-test/provider.env', cleanup() {} } : null;
      },
    },
  };
}

test('launchSessionCli hands a cloud worker the login token through the secret file, not the tmux env', async () => {
  const harness = tmuxLaunchHarness();
  const launched = await launchSessionCli({
    targetSessionId: 'session-7',
    processCwd: '/relay',
    workspaceRoot: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
      COPILOT_WEB_RELAY_ROOT: '/repo',
      CLAUDE_CLOUD_RELAY_MODEL: 'claude-sonnet-5-5',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
      OAR_CLAUDE_CLOUD_API_BASE_URL: 'http://127.0.0.1:4010',
    },
    ...harness.options,
  });
  assert.equal(launched.launchMode, 'tmux');
  assert.deepEqual(harness.secretEnvs, ["export CLAUDE_CODE_OAUTH_TOKEN='test-token-value'\n"]);
  const newSessionCall = harness.calls.find((call) => call.args?.[0] === 'new-session');
  assert.ok(newSessionCall);
  // A tmux server started by this call keeps its client's environment.
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in newSessionCall.options.env, false);
  assert.equal(JSON.stringify(newSessionCall.options.env).includes('test-token-value'), false);
  const shellCommand = newSessionCall.args.at(-1);
  assert.equal(shellCommand.includes('test-token-value'), false);
  assert.equal(shellCommand.includes('CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.match(shellCommand, /\. '\/tmp\/copilot-relay-worker-test\/provider\.env' \|\| exit \$\?; /);
  assert.match(shellCommand, /export OAR_CLAUDE_CLOUD_API_BASE_URL='http:\/\/127\.0\.0\.1:4010';/);
  assert.match(shellCommand, /export CLAUDE_CLOUD_RELAY_MODEL='claude-sonnet-5-5';/);
});

test('launchSessionCli writes no secret file for a cloud worker when the relay has no login token', async () => {
  const harness = tmuxLaunchHarness();
  await launchSessionCli({
    targetSessionId: 'session-7',
    cwd: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
      COPILOT_WEB_RELAY_ROOT: '/repo',
      CLAUDE_CONFIG_DIR: '/home/dev/.claude',
    },
    ...harness.options,
  });
  assert.deepEqual(harness.secretEnvs, [null]);
  const shellCommand = harness.calls.find((call) => call.args?.[0] === 'new-session').args.at(-1);
  assert.doesNotMatch(shellCommand, /provider\.env/);
  // The worker finds the CLI's credentials file through this.
  assert.match(shellCommand, /export CLAUDE_CONFIG_DIR='\/home\/dev\/\.claude';/);
});

test('launchSessionCli keeps the login token away from a worker of another kind', async () => {
  const harness = tmuxLaunchHarness();
  await launchSessionCli({
    targetSessionId: 'session-7',
    cwd: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'grok',
      COPILOT_WEB_RELAY_ROOT: '/repo',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-token-value',
    },
    ...harness.options,
  });
  assert.deepEqual(harness.secretEnvs, [null]);
  const shellCommand = harness.calls.find((call) => call.args?.[0] === 'new-session').args.at(-1);
  assert.equal(shellCommand.includes('test-token-value'), false);
  assert.doesNotMatch(shellCommand, /provider\.env|CLAUDE_CODE_OAUTH_TOKEN/);
});

test('launchSessionCli spawns the cloud worker script, never the Copilot CLI', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'session-3',
    cwd: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
      COPILOT_WEB_RELAY_ROOT: '/repo',
    },
    platform: 'linux',
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 4242, unref: () => {} };
    },
    execFileSyncImpl: () => { throw new Error('tmux missing'); },
    processInspector: { findProcessForSessionAsync: () => null },
    allowProcessReuse: false,
  });
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'node');
  assert.deepEqual(spawnCalls[0].args, [
    path.join('/repo', 'server', 'claude-cloud-worker', 'claude-cloud-session-worker.mjs'),
    '--session-id',
    'session-3',
  ]);
  assert.equal(spawnCalls[0].args.includes('--allow-all'), false);
});
