'use strict';

import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyClaudeProviderEnvironment,
  applyCursorProviderEnvironment,
  buildTmuxWorkerShellCommand,
  createWorkerSecretEnvFile,
  isCursorWorkerEnvironment,
  launchSessionCli,
  resolveCursorWorkerScriptPath,
  resolveWorkerKind,
  WORKER_SECRET_ENV_VARS,
} from './session-worker-launch-service.mjs';

test('applyCursorProviderEnvironment sets kind, model, and key when enabled', () => {
  const env = applyCursorProviderEnvironment({ PATH: '/bin' }, {
    enabled: true,
    model: 'cursor-fast-1',
    apiKey: 'cursor-test-key',
  });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'cursor');
  assert.equal(env.CURSOR_RELAY_MODEL, 'cursor-fast-1');
  assert.equal(env.CURSOR_API_KEY, 'cursor-test-key');
  assert.equal(env.PATH, '/bin');
  assert.equal(isCursorWorkerEnvironment(env), true);
});

test('applyCursorProviderEnvironment omits the model export when model is empty', () => {
  const env = applyCursorProviderEnvironment({}, { enabled: true, apiKey: 'cursor-test-key' });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'cursor');
  assert.equal('CURSOR_RELAY_MODEL' in env, false);
});

test('applyCursorProviderEnvironment clears cursor keys when disabled', () => {
  const env = applyCursorProviderEnvironment({
    COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
    CURSOR_RELAY_MODEL: 'cursor-fast-1',
    CURSOR_API_KEY: 'cursor-test-key',
    PATH: '/bin',
  });
  assert.equal('COPILOT_WEB_RELAY_WORKER_KIND' in env, false);
  assert.equal('CURSOR_RELAY_MODEL' in env, false);
  assert.equal('CURSOR_API_KEY' in env, false);
  assert.equal(isCursorWorkerEnvironment(env), false);
});

test('applyCursorProviderEnvironment requires an api key when enabled', () => {
  assert.throws(
    () => applyCursorProviderEnvironment({}, { enabled: true, model: 'cursor-fast-1' }),
    /cursor-api-key-not-configured/,
  );
  assert.throws(
    () => applyCursorProviderEnvironment({}, { enabled: true, apiKey: '   ' }),
    /cursor-api-key-not-configured/,
  );
});

test('disabled cursor applier does not clear another provider worker kind', () => {
  const env = applyCursorProviderEnvironment({
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
    CURSOR_RELAY_MODEL: 'cursor-fast-1',
    CURSOR_API_KEY: 'cursor-test-key',
  });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'claude');
  assert.equal('CURSOR_RELAY_MODEL' in env, false);
  assert.equal('CURSOR_API_KEY' in env, false);
});

test('disabled claude applier does not clear the cursor worker kind', () => {
  const env = applyClaudeProviderEnvironment({
    COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
    CLAUDE_RELAY_MODEL: 'claude-sonnet-5',
  });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'cursor');
  assert.equal('CLAUDE_RELAY_MODEL' in env, false);
});

test('resolveWorkerKind normalizes known kinds and defaults to copilot', () => {
  assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: 'cursor' }), 'cursor');
  assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: ' Cursor ' }), 'cursor');
  assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: 'claude' }), 'claude');
  assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: 'mystery' }), 'copilot');
  assert.equal(resolveWorkerKind({}), 'copilot');
  assert.equal(resolveWorkerKind(), 'copilot');
  assert.equal(isCursorWorkerEnvironment({ COPILOT_WEB_RELAY_WORKER_KIND: 'cursor' }), true);
  assert.equal(isCursorWorkerEnvironment({ COPILOT_WEB_RELAY_WORKER_KIND: 'claude' }), false);
});

test('resolveCursorWorkerScriptPath prefers explicit path, then repo root, then server dir, then cwd', () => {
  assert.equal(
    resolveCursorWorkerScriptPath({ COPILOT_WEB_RELAY_CURSOR_WORKER_PATH: '/custom/cursor-worker.mjs' }),
    '/custom/cursor-worker.mjs',
  );
  assert.equal(
    resolveCursorWorkerScriptPath({ COPILOT_WEB_RELAY_ROOT: '/repo' }),
    path.join('/repo', 'server', 'cursor-worker', 'cursor-session-worker.mjs'),
  );
  assert.equal(
    resolveCursorWorkerScriptPath({ COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server' }),
    path.join('/repo/server', 'cursor-worker', 'cursor-session-worker.mjs'),
  );
  assert.equal(
    resolveCursorWorkerScriptPath({}),
    path.join(process.cwd(), 'server', 'cursor-worker', 'cursor-session-worker.mjs'),
  );
});

test('tmux shell command for cursor workers runs node without the script PTY wrapper', () => {
  const env = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
    CURSOR_RELAY_MODEL: 'cursor-fast-1',
    CURSOR_AGENT_STORE_DIR: '/home/dev/.cursor-agent-store',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
  };
  const command = buildTmuxWorkerShellCommand('session-1', env);
  const workerScript = path.join('/repo', 'server', 'cursor-worker', 'cursor-session-worker.mjs')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(command, new RegExp(`exec 'node' '${workerScript}' --session-id 'session-1'$`));
  assert.doesNotMatch(command, /script -q/);
  assert.match(command, /export COPILOT_WEB_RELAY_WORKER_KIND='cursor';/);
  assert.match(command, /export CURSOR_RELAY_MODEL='cursor-fast-1';/);
  assert.match(command, /export CURSOR_AGENT_STORE_DIR='\/home\/dev\/\.cursor-agent-store';/);
});

test('tmux shell command never embeds the cursor api key', () => {
  const env = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    CURSOR_API_KEY: 'cursor-test-key',
  };
  assert.throws(
    () => buildTmuxWorkerShellCommand('session-1', env),
    /worker-secret-env-file-required/,
  );
  const command = buildTmuxWorkerShellCommand('session-1', env, {
    secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env',
  });
  assert.doesNotMatch(command, /cursor-test-key|CURSOR_API_KEY/);
  assert.match(command, /\. '\/tmp\/copilot-relay-worker-test\/provider\.env' \|\| exit \$\?; /);
  // The secret file and its directory are removed before the worker execs.
  assert.match(
    command,
    /rm -f '\/tmp\/copilot-relay-worker-test\/provider\.env'; rmdir '\/tmp\/copilot-relay-worker-test'; exec /,
  );
});

test('worker secret env vars cover the copilot provider and cursor keys', () => {
  assert.deepEqual([...WORKER_SECRET_ENV_VARS], ['COPILOT_PROVIDER_API_KEY', 'CURSOR_API_KEY']);
});

function createRecordingFsImpl(calls) {
  return {
    mkdtempSync(prefix) {
      calls.push(['mkdtemp', prefix]);
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

test('createWorkerSecretEnvFile writes the cursor api key with owner-only permissions', () => {
  const calls = [];
  const secret = createWorkerSecretEnvFile({
    CURSOR_API_KEY: 'cursor-test-key',
  }, {
    fsImpl: createRecordingFsImpl(calls),
    tempRoot: '/tmp',
  });
  assert.equal(secret.filePath, path.join('/tmp/copilot-relay-worker-test', 'provider.env'));
  assert.deepEqual(calls[1], ['chmod', '/tmp/copilot-relay-worker-test', 0o700]);
  assert.deepEqual(calls[2][3], { encoding: 'utf8', mode: 0o600 });
  assert.equal(calls[2][2], "export CURSOR_API_KEY='cursor-test-key'\n");
  secret.cleanup();
  assert.deepEqual(calls.at(-2), ['rm', secret.filePath, { force: true }]);
  assert.deepEqual(calls.at(-1), ['rmdir', '/tmp/copilot-relay-worker-test']);
});

test('createWorkerSecretEnvFile writes one line per present secret var', () => {
  const calls = [];
  createWorkerSecretEnvFile({
    COPILOT_PROVIDER_API_KEY: 'sk-test',
    CURSOR_API_KEY: 'cursor-test-key',
  }, {
    fsImpl: createRecordingFsImpl(calls),
    tempRoot: '/tmp',
  });
  assert.equal(
    calls[2][2],
    "export COPILOT_PROVIDER_API_KEY='sk-test'\nexport CURSOR_API_KEY='cursor-test-key'\n",
  );
});

test('createWorkerSecretEnvFile returns null when no secret vars are present', () => {
  const calls = [];
  const secret = createWorkerSecretEnvFile({ PATH: '/bin' }, {
    fsImpl: createRecordingFsImpl(calls),
    tempRoot: '/tmp',
  });
  assert.equal(secret, null);
  assert.deepEqual(calls, []);
});

test('launchSessionCli spawns node for cursor workers when tmux is unavailable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'session-5',
    cwd: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
      COPILOT_WEB_RELAY_ROOT: '/repo',
    },
    platform: 'linux',
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 4242, unref: () => {} };
    },
    execFileSyncImpl: () => { throw new Error('tmux missing'); },
    processInspector: { findProcessForSession: () => null },
    allowProcessReuse: false,
  });
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'node');
  assert.deepEqual(spawnCalls[0].args, [
    path.join('/repo', 'server', 'cursor-worker', 'cursor-session-worker.mjs'),
    '--session-id',
    'session-5',
  ]);
});

test('launchSessionCli opens a cursor-titled console for cursor workers on windows', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'cursor-win-1',
    processCwd: 'C:\\relay',
    workspaceRoot: 'C:\\repo',
    env: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
      COPILOT_WEB_RELAY_ROOT: '/repo',
      CURSOR_API_KEY: 'cursor-test-key',
    },
    platform: 'win32',
    processInspector: { findProcessForSession: () => null },
    detachedPollAttempts: 1,
    detachedPollDelayMs: 1,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { pid: 4244, unref() {} };
    },
  });
  assert.equal(launched.launchMode, 'console');
  assert.match(spawnCalls[0]?.command, /cmd\.exe$/i);
  assert.deepEqual(spawnCalls[0]?.args, [
    '/d',
    '/s',
    '/c',
    'start',
    'Cursor Worker cursor-w',
    'node',
    path.join('/repo', 'server', 'cursor-worker', 'cursor-session-worker.mjs'),
    '--session-id',
    'cursor-win-1',
  ]);
});

test('launchSessionCli scrubs the cursor api key from the tmux client env', async () => {
  const calls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'session-6',
    processCwd: '/relay',
    workspaceRoot: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
      COPILOT_WEB_RELAY_ROOT: '/repo',
      CURSOR_RELAY_MODEL: 'cursor-fast-1',
      CURSOR_API_KEY: 'cursor-test-key',
    },
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
      findProcessForSession: () => ({ processId: process.pid, commandLine: 'node cursor-session-worker.mjs --session-id session-6' }),
    },
    allowProcessReuse: false,
    tmuxPollAttempts: 1,
    tmuxPollDelayMs: 1,
    createSecretEnvFileImpl: () => ({
      filePath: '/tmp/copilot-relay-worker-test/provider.env',
      cleanup() {},
    }),
  });
  assert.equal(launched.launchMode, 'tmux');
  const newSessionCall = calls.find((call) => call.args?.[0] === 'new-session');
  assert.ok(newSessionCall);
  assert.equal('CURSOR_API_KEY' in newSessionCall.options.env, false);
  assert.equal('COPILOT_PROVIDER_API_KEY' in newSessionCall.options.env, false);
  const shellCommand = newSessionCall.args.at(-1);
  assert.doesNotMatch(shellCommand, /cursor-test-key|CURSOR_API_KEY/);
  assert.match(shellCommand, /export CURSOR_RELAY_MODEL='cursor-fast-1';/);
  assert.match(shellCommand, /\. '\/tmp\/copilot-relay-worker-test\/provider\.env'/);
});

test('copilot tmux command output is byte-identical to the pre-cursor expectation', () => {
  const command = buildTmuxWorkerShellCommand('session-2', {
    COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
  });
  assert.equal(
    command,
    "export COPILOT_WEB_RELAY_CONFIG='/repo/server/config.json'; "
    + "export COPILOT_WEB_RELAY_CLI_EXECUTABLE='/usr/bin/copilot'; "
    + "export SESSION_ID='session-2'; "
    + "exec script -q -c ''\\''/usr/bin/copilot'\\'' --allow-all --session-id '\\''session-2'\\''' /dev/null",
  );
});

test('claude tmux command output is byte-identical to the pre-cursor expectation', () => {
  const command = buildTmuxWorkerShellCommand('session-1', {
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
    CLAUDE_RELAY_MODEL: 'claude-sonnet-5',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
  });
  const workerScript = path.join('/repo', 'server', 'claude-worker', 'claude-session-worker.mjs');
  assert.equal(
    command,
    "export COPILOT_WEB_RELAY_ROOT='/repo'; "
    + "export COPILOT_WEB_RELAY_CONFIG='/repo/server/config.json'; "
    + "export COPILOT_WEB_RELAY_WORKER_KIND='claude'; "
    + "export CLAUDE_RELAY_MODEL='claude-sonnet-5'; "
    + "export SESSION_ID='session-1'; "
    + `exec 'node' '${workerScript}' --session-id 'session-1'`,
  );
});
