import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOpenAIProviderEnvironment,
  buildCopilotOarMcpConfig,
  buildTmuxWorkerShellCommand,
  createWorkerSecretEnvFile,
  isOarMcpServerDisabled,
  killTmuxSession,
  launchSessionCli,
  normalizeTmuxSessionName,
  prepareOarMcpConfigFile,
  resolveOarMcpServerScriptPath,
  resolveOpenAIWireApi,
} from './session-worker-launch-service.mjs';
import { OAR_MCP_SERVER_SCRIPT_PATH, OAR_MCP_TOOL_TIMEOUT_MS } from '../mcp/oar-mcp-server.mjs';

// The extension engine writes an OAR MCP config file per launch. Tests hand
// the launcher a fake that names a file instead, so nothing lands in a real
// log directory; the writer itself is tested on its own below.
const POSIX_MCP_CONFIG = '/relay/logs/worker-abc-123.mcp.json';
const WIN32_MCP_CONFIG = path.win32.join('C:\\relay', 'logs', 'worker-abc-123.mcp.json');

function fakeMcpConfig(filePath) {
  const calls = [];
  const impl = (target, env) => {
    calls.push({ target, env });
    return filePath;
  };
  impl.calls = calls;
  return impl;
}

// sh single-quoting, as the launcher does it.
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

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
    assert.equal(secret.filePath, path.join('/tmp/copilot-relay-worker-test', 'provider.env'));
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
    findProcessForSessionAsync() {
      finds += 1;
      return finds >= 2 ? { processId: process.pid, commandLine: 'gh copilot -- --session-id abc-123' } : null;
    },
  };

  const mcpConfig = fakeMcpConfig(POSIX_MCP_CONFIG);
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
    prepareOarMcpConfigImpl: mcpConfig,
  });

  assert.equal(mcpConfig.calls.length, 1);
  assert.equal(mcpConfig.calls[0].target, 'abc-123');
  assert.equal(mcpConfig.calls[0].env.COPILOT_WEB_RELAY_CONFIG, '/relay/server/config.json');
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
  assert.match(shellCommand, /export OAR_MCP_SERVER_ATTACHED='1';/);
  // The MCP config rides the CLI command, quoted once for the command and
  // once more for `script -c`.
  const cliCommand = `${shq('copilot')} --allow-all --session-id ${shq('abc-123')} ${shq('--additional-mcp-config')} ${shq(`@${POSIX_MCP_CONFIG}`)}`;
  assert.ok(
    shellCommand.endsWith(`exec script -q -c ${shq(cliCommand)} /dev/null`),
    `unexpected tmux command: ${shellCommand}`,
  );
});

test('buildTmuxWorkerShellCommand quotes extra CLI args through both shells', () => {
  const hostile = "@/srv/it's here/worker-abc-123.mcp.json";
  const command = buildTmuxWorkerShellCommand('abc-123', {}, {
    extraCliArgs: ['--additional-mcp-config', hostile],
  });
  const cliCommand = `${shq('copilot')} --allow-all --session-id ${shq('abc-123')} ${shq('--additional-mcp-config')} ${shq(hostile)}`;
  assert.ok(command.endsWith(`exec script -q -c ${shq(cliCommand)} /dev/null`), command);

  // Node workers never take them: the OAR tools ride in-process there.
  const nodeWorker = buildTmuxWorkerShellCommand('abc-123', { COPILOT_WEB_RELAY_WORKER_KIND: 'claude' }, {
    extraCliArgs: ['--additional-mcp-config', hostile],
  });
  assert.doesNotMatch(nodeWorker, /additional-mcp-config/);
});

test('buildTmuxWorkerShellCommand forwards the OAR MCP kill switch to workers', () => {
  const command = buildTmuxWorkerShellCommand('abc-123', { OAR_MCP_SERVER: '0', COPILOT_WEB_RELAY_WORKER_KIND: 'grok' });
  assert.match(command, /export OAR_MCP_SERVER='0';/);
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
    prepareOarMcpConfigImpl: fakeMcpConfig(POSIX_MCP_CONFIG),
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSessionAsync() {
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
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123', '--additional-mcp-config', `@${POSIX_MCP_CONFIG}`]);
  assert.equal(spawnCalls[0]?.options?.env?.OAR_MCP_SERVER_ATTACHED, '1', 'the extension learns preview is a real tool');
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
    prepareOarMcpConfigImpl: fakeMcpConfig(POSIX_MCP_CONFIG),
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSessionAsync() {
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
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123', '--additional-mcp-config', `@${POSIX_MCP_CONFIG}`]);
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
    prepareOarMcpConfigImpl: fakeMcpConfig(POSIX_MCP_CONFIG),
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSessionAsync() {
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
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123', '--additional-mcp-config', `@${POSIX_MCP_CONFIG}`]);
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
    prepareOarMcpConfigImpl: fakeMcpConfig(POSIX_MCP_CONFIG),
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSessionAsync() {
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
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123', '--additional-mcp-config', `@${POSIX_MCP_CONFIG}`]);
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
    prepareOarMcpConfigImpl: fakeMcpConfig(POSIX_MCP_CONFIG),
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: {
      findProcessForSessionAsync() {
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
  assert.deepEqual(spawnCalls[0]?.args, ['--allow-all', '--session-id', 'abc-123', '--additional-mcp-config', `@${POSIX_MCP_CONFIG}`]);
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
    prepareOarMcpConfigImpl: fakeMcpConfig(WIN32_MCP_CONFIG),
    processInspector: {
      findProcessForSessionAsync() {
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
    // One plain path argument: no JSON has to survive cmd.exe and `start`.
    '--additional-mcp-config',
    `@${WIN32_MCP_CONFIG}`,
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
    prepareOarMcpConfigImpl: fakeMcpConfig(WIN32_MCP_CONFIG),
    processInspector: {
      findProcessForSessionAsync() {
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
    prepareOarMcpConfigImpl: fakeMcpConfig(WIN32_MCP_CONFIG),
    processInspector: {
      findProcessForSessionAsync() {
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
    prepareOarMcpConfigImpl: fakeMcpConfig(POSIX_MCP_CONFIG),
    processInspector: {
      findProcessForSessionAsync() {
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
    prepareOarMcpConfigImpl: fakeMcpConfig(POSIX_MCP_CONFIG),
    allowProcessReuse: false,
    processInspector: {
      findProcessForSessionAsync() {
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
  // The whole point of disabling reuse is that the requested directory actually
  // applies; reusing the live process would silently keep the old one.
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WORKSPACE_ROOT, '/repo');
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
    prepareOarMcpConfigImpl: fakeMcpConfig(POSIX_MCP_CONFIG),
    processInspector: {
      findProcessForSessionAsync() {
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

test('node-worker tmux commands tee output into the worker log', async () => {
  const { buildTmuxWorkerShellCommand } = await import('./session-worker-launch-service.mjs');
  const command = buildTmuxWorkerShellCommand('sid-log', {
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
    COPILOT_WEB_RELAY_SERVER_DIR: '/srv/server',
  }, { workerLogPath: '/srv/server/logs/worker-sid-log.log' });
  assert.match(command, />> '\/srv\/server\/logs\/worker-sid-log\.log' 2>&1$/);
});

test('prepareWorkerLogFile creates the log dir, sanitizes the id, and rotates oversized logs', async () => {
  const { prepareWorkerLogFile } = await import('./session-worker-launch-service.mjs');
  const mkdirs = [];
  const renames = [];
  const fsImpl = {
    mkdirSync: (dir) => { mkdirs.push(dir); },
    statSync: () => ({ size: 11 * 1024 * 1024 }),
    renameSync: (from, to) => { renames.push([from, to]); },
  };
  const logPath = prepareWorkerLogFile('sid/../evil', { COPILOT_WEB_RELAY_LOG_DIR: '/var/log/relay' }, {
    fsImpl,
    pathImpl: path.posix,
  });
  assert.equal(logPath, '/var/log/relay/worker-sidevil.log');
  assert.deepEqual(mkdirs, ['/var/log/relay']);
  assert.equal(renames.length, 1, 'an oversized log rotates');
  assert.equal(renames[0][1], '/var/log/relay/worker-sidevil.log.1');
});

test('prepareWorkerLogFile builds the win32 log path under the server dir', async () => {
  const { prepareWorkerLogFile } = await import('./session-worker-launch-service.mjs');
  const mkdirs = [];
  const logPath = prepareWorkerLogFile('sid-1', { COPILOT_WEB_RELAY_SERVER_DIR: 'C:\\srv\\relay' }, {
    fsImpl: {
      mkdirSync: (dir) => { mkdirs.push(dir); },
      statSync: () => { throw new Error('missing'); },
      renameSync: () => {},
    },
    pathImpl: path.win32,
  });
  assert.equal(logPath, 'C:\\srv\\relay\\logs\\worker-sid-1.log');
  assert.deepEqual(mkdirs, ['C:\\srv\\relay\\logs']);
});

// Regression: the default base dir used `new URL(import.meta.url).pathname`, which
// is '/C:/git/...' on Windows and joined into a malformed '\C:\git\...\logs'.
test('prepareWorkerLogFile falls back to a well-formed dir beside the module', async () => {
  const { prepareWorkerLogFile } = await import('./session-worker-launch-service.mjs');
  const mkdirs = [];
  const logPath = prepareWorkerLogFile('sid-2', {}, {
    fsImpl: {
      mkdirSync: (dir) => { mkdirs.push(dir); },
      statSync: () => { throw new Error('missing'); },
      renameSync: () => {},
    },
  });
  assert.equal(logPath, path.join(mkdirs[0], 'worker-sid-2.log'));
  assert.equal(mkdirs[0], path.normalize(mkdirs[0]), 'the fallback dir is a normalized host path');
  assert.ok(!/^[\\/][A-Za-z]:/.test(mkdirs[0]), `fallback dir must not carry a URL-style root: ${mkdirs[0]}`);
});

test('prepareWorkerLogFile never throws when the filesystem misbehaves', async () => {
  const { prepareWorkerLogFile } = await import('./session-worker-launch-service.mjs');
  const logPath = prepareWorkerLogFile('sid', {}, {
    fsImpl: { mkdirSync: () => { throw new Error('read-only fs'); } },
  });
  assert.equal(logPath, null);
});

// ─── the OAR MCP server for the extension engine ─────────────────────────────

test('the extension-engine MCP config registers the OAR server the way the CLI expects', () => {
  const config = buildCopilotOarMcpConfig('abc-123', {
    COPILOT_WEB_RELAY_ROOT: '/srv/oar',
    COPILOT_WEB_RELAY_CONFIG: '/srv/oar/server/config.json',
    COPILOT_PROVIDER_API_KEY: 'sk-never-written',
  }, { nodePath: '/usr/local/bin/node', pathImpl: path.posix });
  assert.deepEqual(config, {
    mcpServers: {
      oar: {
        type: 'local',
        command: '/usr/local/bin/node',
        args: [path.posix.join('/srv/oar', 'server', 'mcp', 'oar-mcp-server.mjs'), '--conversation-id', 'abc-123'],
        env: {
          COPILOT_WEB_RELAY_CONFIG: '/srv/oar/server/config.json',
          COPILOT_WEB_RELAY_ROOT: '/srv/oar',
        },
        tools: ['*'],
        // The CLI's own per-call default is 180 s: far below one remote_relay wait.
        timeout: OAR_MCP_TOOL_TIMEOUT_MS,
      },
    },
  });
  assert.ok(OAR_MCP_TOOL_TIMEOUT_MS > 600_000);
  assert.doesNotMatch(JSON.stringify(config), /sk-never-written/);
});

test('the MCP server script resolves like the worker scripts, on both platforms', () => {
  assert.equal(
    resolveOarMcpServerScriptPath({ COPILOT_WEB_RELAY_SERVER_DIR: '/srv/oar/server' }, { pathImpl: path.posix }),
    path.posix.join('/srv/oar/server', 'mcp', 'oar-mcp-server.mjs'),
  );
  assert.equal(
    resolveOarMcpServerScriptPath({ COPILOT_WEB_RELAY_ROOT: 'C:\\srv\\oar' }, { pathImpl: path.win32 }),
    path.win32.join('C:\\srv\\oar', 'server', 'mcp', 'oar-mcp-server.mjs'),
  );
  assert.equal(resolveOarMcpServerScriptPath({}), OAR_MCP_SERVER_SCRIPT_PATH, 'else the module beside this service');
});

function recordingFs() {
  const writes = [];
  const dirs = [];
  return {
    writes,
    dirs,
    mkdirSync: (dir) => { dirs.push(dir); },
    writeFileSync: (file, contents, options) => { writes.push({ file, contents, options }); },
  };
}

test('prepareOarMcpConfigFile writes the config beside the worker log and returns its path', () => {
  const fsImpl = recordingFs();
  const filePath = prepareOarMcpConfigFile('abc-123', {
    COPILOT_WEB_RELAY_LOG_DIR: '/var/log/relay',
    COPILOT_WEB_RELAY_CONFIG: '/srv/oar/server/config.json',
  }, { fsImpl, pathImpl: path.posix, nodePath: '/usr/local/bin/node' });
  assert.equal(filePath, path.posix.join('/var/log/relay', 'worker-abc-123.mcp.json'));
  assert.deepEqual(fsImpl.dirs, ['/var/log/relay']);
  assert.equal(fsImpl.writes.length, 1);
  assert.equal(fsImpl.writes[0].options.mode, 0o600);
  const written = JSON.parse(fsImpl.writes[0].contents);
  assert.equal(written.mcpServers.oar.command, '/usr/local/bin/node');
  assert.deepEqual(written.mcpServers.oar.args.slice(1), ['--conversation-id', 'abc-123']);

  const win = recordingFs();
  const winPath = prepareOarMcpConfigFile('abc-123', { COPILOT_WEB_RELAY_SERVER_DIR: 'C:\\srv\\relay' }, {
    fsImpl: win,
    pathImpl: path.win32,
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  });
  assert.equal(winPath, path.win32.join('C:\\srv\\relay', 'logs', 'worker-abc-123.mcp.json'));
  assert.equal(JSON.parse(win.writes[0].contents).mcpServers.oar.command, 'C:\\Program Files\\nodejs\\node.exe');
});

test('prepareOarMcpConfigFile is best-effort and honours the kill switch', () => {
  const broken = prepareOarMcpConfigFile('abc-123', { COPILOT_WEB_RELAY_LOG_DIR: '/var/log/relay' }, {
    fsImpl: { mkdirSync: () => { throw new Error('read-only fs'); }, writeFileSync: () => {} },
    pathImpl: path.posix,
    nodePath: '/usr/local/bin/node',
  });
  assert.equal(broken, null);

  const fsImpl = recordingFs();
  for (const value of ['0', 'false', 'off', 'NO']) {
    assert.equal(isOarMcpServerDisabled({ OAR_MCP_SERVER: value }), true, value);
    assert.equal(
      prepareOarMcpConfigFile('abc-123', { OAR_MCP_SERVER: value, COPILOT_WEB_RELAY_LOG_DIR: '/var/log/relay' }, {
        fsImpl,
        pathImpl: path.posix,
        nodePath: '/usr/local/bin/node',
      }),
      null,
    );
  }
  assert.equal(fsImpl.writes.length, 0);
  assert.equal(isOarMcpServerDisabled({}), false);
  assert.equal(isOarMcpServerDisabled({ OAR_MCP_SERVER: '1' }), false);
});

test('a launch without a config file starts the CLI without the flag', async () => {
  const spawnCalls = [];
  await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: { PATH: process.env.PATH || '' },
    platform: 'linux',
    prepareOarMcpConfigImpl: () => null,
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: { findProcessForSessionAsync: () => null },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { pid: 4242, unref() {} };
    },
  });
  assert.deepEqual(spawnCalls[0].args, ['--allow-all', '--session-id', 'abc-123']);
  assert.equal(spawnCalls[0].options.env.OAR_MCP_SERVER_ATTACHED, undefined);
});

test('node workers never get the extension-engine MCP config', async () => {
  const mcpConfig = fakeMcpConfig(POSIX_MCP_CONFIG);
  const spawnCalls = [];
  await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      PATH: process.env.PATH || '',
      COPILOT_WEB_RELAY_WORKER_KIND: 'grok',
      COPILOT_WEB_RELAY_GROK_WORKER_PATH: '/srv/oar/server/grok-worker/grok-session-worker.mjs',
    },
    platform: 'win32',
    prepareOarMcpConfigImpl: mcpConfig,
    processInspector: { findProcessForSessionAsync: () => null },
    detachedPollAttempts: 1,
    detachedPollDelayMs: 1,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { pid: null, unref() {} };
    },
  });
  assert.equal(mcpConfig.calls.length, 0);
  assert.equal(spawnCalls[0].args.includes('--additional-mcp-config'), false);
});

// ─── the worker log on the windows console launch ────────────────────────────

const WIN32_WORKER_LOG = path.win32.join('C:\relay', 'logs', 'worker-abc-123.log');

function launchOnWindowsConsole({ env = {}, prepareWorkerLogFileImpl } = {}) {
  const spawnCalls = [];
  return launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: 'C:\relay',
    workspaceRoot: 'C:\repo',
    env: { ComSpec: 'C:\Windows\System32\cmd.exe', ...env },
    platform: 'win32',
    prepareOarMcpConfigImpl: fakeMcpConfig(WIN32_MCP_CONFIG),
    prepareWorkerLogFileImpl,
    processInspector: { findProcessForSessionAsync: () => null },
    detachedPollAttempts: 1,
    detachedPollDelayMs: 1,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { pid: null, unref() {} };
    },
  }).then(() => spawnCalls);
}

test('every node worker kind is told its worker log on the windows console launch', async () => {
  for (const kind of ['claude', 'cursor', 'grok', 'copilot-sdk']) {
    const prepared = [];
    const spawnCalls = await launchOnWindowsConsole({
      env: {
        COPILOT_WEB_RELAY_WORKER_KIND: kind,
        COPILOT_WEB_RELAY_ROOT: 'C:\srv\oar',
        COPILOT_WEB_RELAY_WORKER_LOG_FILE: 'C:\relay\logs\worker-inherited.log',
      },
      prepareWorkerLogFileImpl: (target) => {
        prepared.push(target);
        return WIN32_WORKER_LOG;
      },
    });
    assert.deepEqual(prepared, ['abc-123'], kind);
    assert.equal(spawnCalls[0].options.env.COPILOT_WEB_RELAY_WORKER_LOG_FILE, WIN32_WORKER_LOG, kind);
    // The console window stays: no redirect in the command, nothing hidden.
    assert.deepEqual(spawnCalls[0].args.slice(-2), ['--session-id', 'abc-123'], kind);
    assert.equal(spawnCalls[0].args.some((arg) => /worker-abc-123\.log|>/.test(arg)), false, kind);
    assert.equal(spawnCalls[0].options.stdio, 'ignore', kind);
    assert.equal(spawnCalls[0].options.windowsHide, false, kind);
  }
});

test('the windows worker log hand-over carries no secret onto the command line', async () => {
  const spawnCalls = await launchOnWindowsConsole({
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'cursor',
      COPILOT_WEB_RELAY_ROOT: 'C:\srv\oar',
      CURSOR_API_KEY: 'cursor-test-key',
    },
    prepareWorkerLogFileImpl: () => WIN32_WORKER_LOG,
  });
  assert.equal(spawnCalls[0].args.join(' ').includes('cursor-test-key'), false);
  assert.equal(spawnCalls[0].options.env.COPILOT_WEB_RELAY_WORKER_LOG_FILE, WIN32_WORKER_LOG);
});

test('a windows worker still launches when its log cannot be prepared', async () => {
  const spawnCalls = await launchOnWindowsConsole({
    env: { COPILOT_WEB_RELAY_WORKER_KIND: 'claude', COPILOT_WEB_RELAY_ROOT: 'C:\srv\oar' },
    prepareWorkerLogFileImpl: () => null,
  });
  assert.equal(spawnCalls.length, 1);
  assert.equal('COPILOT_WEB_RELAY_WORKER_LOG_FILE' in spawnCalls[0].options.env, false);
});

test('the extension engine gets no worker log on windows, as on linux', async () => {
  const prepared = [];
  const spawnCalls = await launchOnWindowsConsole({
    env: { COPILOT_WEB_RELAY_WORKER_LOG_FILE: 'C:\relay\logs\worker-inherited.log' },
    prepareWorkerLogFileImpl: (target) => {
      prepared.push(target);
      return WIN32_WORKER_LOG;
    },
  });
  assert.deepEqual(prepared, []);
  assert.equal(spawnCalls[0].args[5], 'gh');
  assert.equal('COPILOT_WEB_RELAY_WORKER_LOG_FILE' in spawnCalls[0].options.env, false);
});

test('an inherited worker log variable never reaches a redirected posix worker', async () => {
  const spawnCalls = [];
  await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'grok',
      COPILOT_WEB_RELAY_ROOT: '/srv/oar',
      COPILOT_WEB_RELAY_WORKER_LOG_FILE: '/relay/logs/worker-inherited.log',
    },
    platform: 'linux',
    prepareWorkerLogFileImpl: () => { throw new Error('the posix paths redirect instead'); },
    execFileSyncImpl(command) {
      if (command === 'tmux') throw new Error('missing tmux');
      throw new Error(`unexpected command: ${command}`);
    },
    processInspector: { findProcessForSessionAsync: () => null },
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { pid: 4242, unref() {} };
    },
  });
  assert.equal('COPILOT_WEB_RELAY_WORKER_LOG_FILE' in spawnCalls[0].options.env, false);
});

test('an unreadable process list does not stop a windows launch', async () => {
  // 2026-10-01: a control byte in another process's command line made the
  // list unreadable for an hour, and no worker could start on the relay.
  const spawnCalls = [];
  const reported = [];
  let reads = 0;
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: 'C:\\relay',
    workspaceRoot: 'C:\\repo',
    env: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
      COPILOT_WEB_RELAY_ROOT: 'C:\\srv\\oar',
    },
    platform: 'win32',
    prepareOarMcpConfigImpl: fakeMcpConfig(WIN32_MCP_CONFIG),
    prepareWorkerLogFileImpl: () => null,
    processInspector: {
      findProcessForSessionAsync() {
        reads += 1;
        throw new Error('windows-process-snapshot-unreadable: Bad control character in string literal in JSON at position 144233');
      },
    },
    onProcessListError: (error) => reported.push(error.message),
    detachedPollAttempts: 2,
    detachedPollDelayMs: 1,
    spawnImpl(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { pid: 4242, unref() {} };
    },
  });

  assert.equal(spawnCalls.length, 1, 'the worker is launched');
  assert.equal(launched.reused, false);
  assert.equal(launched.launchMode, 'console');
  assert.equal(launched.pid, null, 'the pid is unknown until the worker heartbeats');
  // The reuse check and both polls read the list; each failure is reported.
  assert.equal(reads, 3);
  assert.equal(reported.length, 3);
  assert.match(reported[0], /^windows-process-snapshot-unreadable: /);
});

test('the launcher prefers the asynchronous finder and asks the pid poll for a fresh list', async () => {
  const lookups = [];
  let polls = 0;
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: 'C:\\relay',
    workspaceRoot: 'C:\\repo',
    env: {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
      COPILOT_WEB_RELAY_ROOT: 'C:\\srv\\oar',
    },
    platform: 'win32',
    prepareOarMcpConfigImpl: fakeMcpConfig(WIN32_MCP_CONFIG),
    prepareWorkerLogFileImpl: () => null,
    processInspector: {
      async findProcessForSessionAsync(target, options) {
        lookups.push({ target, options });
        if (!options?.fresh) return null;
        polls += 1;
        return polls >= 2 ? { processId: process.pid, commandLine: 'node claude-session-worker.mjs --session-id abc-123' } : null;
      },
    },
    detachedPollAttempts: 3,
    detachedPollDelayMs: 1,
    spawnImpl() { return { pid: null, unref() {} }; },
  });
  assert.equal(launched.pid, process.pid);
  assert.equal(launched.launchMode, 'console');
  assert.deepEqual(lookups.map((entry) => entry.options), [{ fresh: false }, { fresh: true }, { fresh: true }]);
  assert.ok(lookups.every((entry) => entry.target === 'abc-123'));
});
