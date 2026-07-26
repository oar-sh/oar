import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOpenAIProviderEnvironment,
  buildTmuxWorkerShellCommand,
  createWorkerSecretEnvFile,
  killTmuxSession,
  launchSessionCli,
  normalizeTmuxSessionName,
  resolveOpenAIWireApi,
} from './session-worker-launch-service.mjs';

test('resolveOpenAIWireApi uses responses for reasoning model families', () => {
  assert.equal(resolveOpenAIWireApi('gpt-5.6-sol'), 'responses');
  assert.equal(resolveOpenAIWireApi('openai/gpt-5.6-sol'), 'responses');
  assert.equal(resolveOpenAIWireApi('codex-mini-latest'), 'responses');
  assert.equal(resolveOpenAIWireApi('o3-pro'), 'responses');
  assert.equal(resolveOpenAIWireApi('gpt-4o'), 'completions');
});

test('applyOpenAIProviderEnvironment injects and removes BYOK variables', () => {
  const configured = applyOpenAIProviderEnvironment({
    PATH: '/usr/bin',
    COPILOT_PROVIDER_API_KEY: 'stale',
  }, {
    enabled: true,
    apiKey: 'sk-test',
    model: 'gpt-4o',
  });
  assert.equal(configured.COPILOT_PROVIDER_TYPE, 'openai');
  assert.equal(configured.COPILOT_PROVIDER_BASE_URL, 'https://api.openai.com/v1');
  assert.equal(configured.COPILOT_PROVIDER_API_KEY, 'sk-test');
  assert.equal(configured.COPILOT_PROVIDER_WIRE_API, 'completions');
  assert.equal(configured.COPILOT_MODEL, 'gpt-4o');

  const cleared = applyOpenAIProviderEnvironment(configured);
  assert.equal(cleared.PATH, '/usr/bin');
  assert.equal(cleared.COPILOT_PROVIDER_TYPE, undefined);
  assert.equal(cleared.COPILOT_PROVIDER_API_KEY, undefined);
  assert.equal(cleared.COPILOT_PROVIDER_WIRE_API, undefined);
  assert.equal(cleared.COPILOT_MODEL, undefined);
});

test('applyOpenAIProviderEnvironment selects responses for GPT-5', () => {
  const configured = applyOpenAIProviderEnvironment({}, {
    enabled: true,
    apiKey: 'sk-test',
    model: 'gpt-5.6-sol',
  });
  assert.equal(configured.COPILOT_PROVIDER_WIRE_API, 'responses');
});

test('applyOpenAIProviderEnvironment requires a key and model when enabled', () => {
  assert.throws(
    () => applyOpenAIProviderEnvironment({}, { enabled: true, model: 'gpt-4o' }),
    /openai-api-key-not-configured/,
  );
  assert.throws(
    () => applyOpenAIProviderEnvironment({}, { enabled: true, apiKey: 'sk-test' }),
    /openai-model-not-configured/,
  );
});

test('normalizeTmuxSessionName rejects unsafe session ids', () => {
  assert.throws(() => normalizeTmuxSessionName('abc:def'), /invalid-tmux-session-name/);
  assert.equal(normalizeTmuxSessionName('abc-123_DEF'), 'abc-123_DEF');
});

test('buildTmuxWorkerShellCommand injects only relay env needed for workers', () => {
  const command = buildTmuxWorkerShellCommand('abc-123', {
    COPILOT_ALLOW_ALL: 'true',
    GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false',
    COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION: 'true',
    COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
    INIT_CWD: '/workspace',
    IGNORED_VAR: 'nope',
  });

  test('tmux worker command never embeds the provider API key', () => {
    const env = {
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: "sk-secret-'value",
    };
    assert.throws(
      () => buildTmuxWorkerShellCommand('abc-123', env),
      /worker-secret-env-file-required/,
    );
    const command = buildTmuxWorkerShellCommand('abc-123', env, {
      secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env',
    });
    assert.doesNotMatch(command, /sk-secret|COPILOT_PROVIDER_API_KEY/);
    assert.match(command, /\. '\/tmp\/copilot-relay-worker-test\/provider\.env'/);
  });

  test('createWorkerSecretEnvFile uses owner-only permissions and cleans up', () => {
    const calls = [];
    const fsImpl = {
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
    const secret = createWorkerSecretEnvFile({
      COPILOT_PROVIDER_API_KEY: "sk-secret-'value",
    }, {
      fsImpl,
      tempRoot: '/tmp',
    });
    assert.equal(secret.filePath, '/tmp/copilot-relay-worker-test/provider.env');
    assert.deepEqual(calls[1], ['chmod', '/tmp/copilot-relay-worker-test', 0o700]);
    assert.deepEqual(calls[2][3], { encoding: 'utf8', mode: 0o600 });
    assert.match(calls[2][2], /^export COPILOT_PROVIDER_API_KEY='sk-secret-'/);
    secret.cleanup();
    assert.deepEqual(calls.at(-2), ['rm', secret.filePath, { force: true }]);
    assert.deepEqual(calls.at(-1), ['rmdir', '/tmp/copilot-relay-worker-test']);
  });

  assert.match(command, /COPILOT_ALLOW_ALL='true'/);
  assert.match(command, /GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS='false'/);
  assert.doesNotMatch(command, /COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION/);
  assert.match(command, /COPILOT_WEB_RELAY_SERVER_DIR='\/repo\/server'/);
  assert.match(command, /COPILOT_WEB_RELAY_CONFIG='\/repo\/server\/config\.json'/);
  assert.match(command, /INIT_CWD='\/workspace'/);
  assert.match(command, /SESSION_ID='abc-123'/);
  assert.doesNotMatch(command, /IGNORED_VAR/);
  assert.match(command, /exec script -q -c/);
  assert.match(command, /copilot.*--allow-all --session-id/);
  assert.doesNotMatch(command, /(?:^|\s)-i(?:\s|$)|launch the server/);
  assert.match(command, /abc-123/);
  assert.match(command, /\/dev\/null/);
  assert.doesNotMatch(command, /GH_FORCE_TTY/);
});

test('buildTmuxWorkerShellCommand forwards extension bootstrap env vars', () => {
  const command = buildTmuxWorkerShellCommand('abc-123', {
    EXTENSION_PATH: '/repo/server/relay-extension.mjs',
    COPILOT_SDK_PATH: '/cache/copilot/copilot-sdk',
    SESSION_ID: 'stale-session',
  });
  assert.match(command, /EXTENSION_PATH='\/repo\/server\/relay-extension\.mjs'/);
  assert.match(command, /COPILOT_SDK_PATH='\/cache\/copilot\/copilot-sdk'/);
  assert.match(command, /SESSION_ID='abc-123'/);
  assert.doesNotMatch(command, /SESSION_ID='stale-session'/);
});

test('buildTmuxWorkerShellCommand keeps the host CLI launch when extension bootstrap is configured', () => {
  const command = buildTmuxWorkerShellCommand('abc-123', {
    COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot',
    COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH: '/cache/copilot/preloads/extension_bootstrap.mjs',
    EXTENSION_PATH: '/repo/server/relay-extension.mjs',
  });

  assert.match(command, /COPILOT_WEB_RELAY_CLI_EXECUTABLE='\/usr\/bin\/copilot'/);
  assert.match(command, /COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH='\/cache\/copilot\/preloads\/extension_bootstrap\.mjs'/);
  assert.match(command, /EXTENSION_PATH='\/repo\/server\/relay-extension\.mjs'/);
  assert.match(command, /\/usr\/bin\/copilot.*--allow-all --session-id/);
  assert.doesNotMatch(command, /(?:^|\s)-i(?:\s|$)|launch the server/);
  assert.match(command, /extension_bootstrap\.mjs/);
  assert.match(command, /--allow-all --session-id/);
  assert.match(command, /abc-123/);
  assert.doesNotMatch(command, /exec script -q -c .*extension_bootstrap\.mjs.*--allow-all/);
});

test('killTmuxSession returns false when tmux kill races after session exists', () => {
  const execCalls = [];
  const killed = killTmuxSession('abc-123', {
    execFileSyncImpl(command, args) {
      execCalls.push([command, ...args]);
      assert.equal(command, 'tmux');
      if (args[0] === 'has-session') return Buffer.alloc(0);
      if (args[0] === 'kill-session') throw new Error('session vanished');
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    },
  });

  assert.equal(killed, false);
  assert.deepEqual(execCalls, [
    ['tmux', 'has-session', '-t', 'abc-123'],
    ['tmux', 'kill-session', '-t', 'abc-123'],
  ]);
});

test('launchSessionCli uses tmux on posix and returns discovered worker pid', async () => {
  const calls = [];
  let finds = 0;
  let paneChecks = 0;
  const execFileSyncImpl = (command, args) => {
    calls.push([command, ...args]);
    if (command !== 'tmux') throw new Error(`unexpected command: ${command}`);
    if (args[0] === '-V') return Buffer.from('tmux 3.6');
    if (args[0] === 'has-session') {
      const err = new Error('missing');
      err.status = 1;
      throw err;
    }
    if (args[0] === 'list-panes') {
      paneChecks += 1;
      return paneChecks >= 2 ? Buffer.from(`${process.pid}\n`) : Buffer.from('');
    }
    if (args[0] === 'new-session') return Buffer.alloc(0);
    throw new Error(`unexpected tmux args: ${args.join(' ')}`);
  };
  const processInspector = {
    findProcessForSession() {
      finds += 1;
      return finds >= 2 ? { processId: process.pid, commandLine: 'gh copilot -- --session-id abc-123' } : null;
    },
  };

  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      COPILOT_ALLOW_ALL: 'false',
      GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false',
      COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION: 'true',
      COPILOT_WEB_RELAY_CONFIG: '/relay/server/config.json',
      COPILOT_WORKSPACE_ROOT: '/stale',
    },
    platform: 'linux',
    execFileSyncImpl,
    processInspector,
    tmuxPollAttempts: 2,
    tmuxPollDelayMs: 1,
  });

  assert.equal(launched.launchMode, 'tmux');
  assert.equal(launched.pid, process.pid);
  assert.equal(launched.tmuxSessionName, 'abc-123');
  assert.ok(calls.length >= 2);
  const newSessionCall = calls.find((call) => call[1] === 'new-session');
  assert.equal(newSessionCall?.[6], '/relay');
  const shellCommand = newSessionCall?.slice(-1)?.[0] || '';
  assert.match(shellCommand, /COPILOT_ALLOW_ALL='true'/);
  assert.match(shellCommand, /GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS='true'/);
  assert.doesNotMatch(shellCommand, /COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION/);
  assert.match(shellCommand, /COPILOT_WEB_RELAY_CONFIG='\/relay\/server\/config\.json'/);
  assert.match(shellCommand, /COPILOT_WORKSPACE_ROOT='\/repo'/);
  assert.match(shellCommand, /exec script -q -c/);
  assert.match(shellCommand, /copilot.*--allow-all --session-id/);
  assert.doesNotMatch(shellCommand, /(?:^|\s)-i(?:\s|$)|launch the server/);
  assert.match(shellCommand, /abc-123/);
  assert.doesNotMatch(shellCommand, /GH_FORCE_TTY/);
});

test('launchSessionCli falls back to detached spawn when tmux is unavailable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      PATH: process.env.PATH || '',
      COPILOT_ALLOW_ALL: 'false',
      GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false',
      COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION: 'true',
      COPILOT_WEB_RELAY_CONFIG: '/relay/server/config.json',
      COPILOT_WORKSPACE_ROOT: '/stale',
    },
    platform: 'linux',
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSession() {
        return null;
      },
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4242,
        unref() {},
      };
    },
  });

  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls[0]?.command, 'copilot');
  assert.equal(spawnCalls[0]?.options?.cwd, '/relay');
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WORKSPACE_ROOT, '/repo');
  assert.equal(spawnCalls[0]?.options?.env?.INIT_CWD, '/repo');
  assert.equal(spawnCalls[0]?.options?.env?.PWD, '/relay');
  assert.equal(spawnCalls[0]?.options?.env?.SESSION_ID, 'abc-123');
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_ALLOW_ALL, 'true');
  assert.equal(spawnCalls[0]?.options?.env?.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, 'true');
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION, undefined);
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WEB_RELAY_CONFIG, '/relay/server/config.json');
});

test('launchSessionCli uses the configured host CLI executable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      PATH: process.env.PATH || '',
      COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot',
    },
    platform: 'linux',
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSession() {
        return null;
      },
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4242,
        unref() {},
      };
    },
  });

  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls[0]?.command, '/usr/bin/copilot');
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123']);
});

test('launchSessionCli uses the host CLI on posix when extension bootstrap is configured', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      PATH: process.env.PATH || '',
      COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot',
      COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH: '/cache/copilot/preloads/extension_bootstrap.mjs',
      EXTENSION_PATH: '/repo/server/relay-extension.mjs',
    },
    platform: 'linux',
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSession() {
        return null;
      },
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4242,
        unref() {},
      };
    },
  });

  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls[0]?.command, '/usr/bin/copilot');
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123']);
});

test('launchSessionCli uses copilot command when bootstrap is set without cli executable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      PATH: process.env.PATH || '',
      COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH: '/cache/copilot/preloads/extension_bootstrap.mjs',
      EXTENSION_PATH: '/repo/server/relay-extension.mjs',
    },
    platform: 'linux',
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSession() {
        return null;
      },
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4242,
        unref() {},
      };
    },
  });

  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls[0]?.command, 'copilot');
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123']);
});

test('launchSessionCli uses the configured host CLI when bootstrap is set without extension path', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      PATH: process.env.PATH || '',
      COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot',
      COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH: '/cache/copilot/preloads/extension_bootstrap.mjs',
    },
    platform: 'linux',
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSession() {
        return null;
      },
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4242,
        unref() {},
      };
    },
  });

  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls[0]?.command, '/usr/bin/copilot');
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123']);
});

test('launchSessionCli opens a visible detached console on windows', async () => {
  const spawnCalls = [];
  let unrefCalled = false;
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: 'C:\\relay',
    workspaceRoot: 'C:\\repo',
    env: {
      PATH: process.env.PATH || '',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      COPILOT_ALLOW_ALL: 'false',
      GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS: 'false',
      COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION: 'true',
    },
    platform: 'win32',
    processInspector: {
      findProcessForSession() {
        return null;
      },
    },
    detachedPollAttempts: 1,
    detachedPollDelayMs: 1,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4244,
        unref() {
          unrefCalled = true;
        },
      };
    },
  });

  assert.equal(launched.launchMode, 'console');
  assert.equal(launched.pid, null);
  assert.match(spawnCalls[0]?.command, /cmd\.exe$/i);
  assert.deepEqual(spawnCalls[0]?.args, [
    '/d',
    '/s',
    '/c',
    'start',
    'Copilot Worker abc-123',
    'gh',
    'copilot',
    '--',
    '--allow-all',
    '--session-id',
    'abc-123',
  ]);
  assert.equal(spawnCalls[0]?.options?.shell, undefined);
  assert.equal(spawnCalls[0]?.options?.detached, true);
  assert.equal(spawnCalls[0]?.options?.stdio, 'ignore');
  assert.equal(spawnCalls[0]?.options?.windowsHide, false);
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_ALLOW_ALL, 'true');
  assert.equal(spawnCalls[0]?.options?.env?.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, 'true');
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION, undefined);
  assert.equal(unrefCalled, true);
});

test('launchSessionCli returns unknown pid when windows console spawn has no pid', async () => {
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: 'C:\\relay',
    workspaceRoot: 'C:\\repo',
    env: {
      PATH: process.env.PATH || '',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    platform: 'win32',
    processInspector: {
      findProcessForSession() {
        return null;
      },
    },
    detachedPollAttempts: 1,
    detachedPollDelayMs: 1,
    spawnImpl() {
      return {
        pid: null,
        unref() {},
      };
    },
  });

  assert.equal(launched.launchMode, 'console');
  assert.equal(launched.pid, null);
});

test('launchSessionCli captures worker pid from windows process polling', async () => {
  let inspections = 0;
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: 'C:\\relay',
    workspaceRoot: 'C:\\repo',
    env: {
      PATH: process.env.PATH || '',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    platform: 'win32',
    processInspector: {
      findProcessForSession() {
        inspections += 1;
        if (inspections < 2) return null;
        return { processId: process.pid, commandLine: 'gh copilot -- --session-id abc-123' };
      },
    },
    detachedPollAttempts: 2,
    detachedPollDelayMs: 1,
    spawnImpl() {
      return {
        pid: null,
        unref() {},
      };
    },
  });

  assert.equal(launched.launchMode, 'console');
  assert.equal(launched.pid, process.pid);
});

test('launchSessionCli reuses a live existing process before launching', async () => {
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    cwd: '/repo',
    platform: 'linux',
    processInspector: {
      findProcessForSession() {
        return { processId: process.pid, commandLine: 'gh copilot -- --session-id abc-123' };
      },
    },
    execFileSyncImpl() {
      throw new Error('tmux should not be checked when live process is reused');
    },
    spawnImpl() {
      throw new Error('spawn should not be called when live process is reused');
    },
  });

  assert.equal(launched.reused, true);
  assert.equal(launched.pid, process.pid);
  assert.equal(launched.launchMode, 'existing');
});

test('launchSessionCli bypasses process reuse when disabled', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    cwd: '/repo',
    env: {
      PATH: process.env.PATH || '',
    },
    platform: 'linux',
    allowProcessReuse: false,
    processInspector: {
      findProcessForSession() {
        return { processId: process.pid, commandLine: 'gh copilot -- --session-id abc-123' };
      },
    },
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4243,
        unref() {},
      };
    },
  });

  assert.equal(launched.reused, false);
  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4243);
  assert.equal(spawnCalls[0]?.command, 'copilot');
});

test('launchSessionCli ignores a dead discovered pid and continues to launch', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    cwd: '/repo',
    env: {
      PATH: process.env.PATH || '',
    },
    platform: 'linux',
    processInspector: {
      findProcessForSession() {
        return { processId: 99999999, commandLine: 'gh copilot -- --session-id abc-123' };
      },
    },
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return {
        pid: 4243,
        unref() {},
      };
    },
  });

  assert.equal(launched.reused, false);
  assert.equal(launched.launchMode, 'detached');
  assert.equal(launched.pid, 4243);
  assert.equal(spawnCalls[0]?.command, 'copilot');
});
