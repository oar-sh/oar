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
    COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/.oar/data',
  };
  const command = buildTmuxWorkerShellCommand('session-1', env);
  const workerScript = path.join('/repo', 'server', 'cursor-worker', 'cursor-session-worker.mjs')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(command, new RegExp(`exec '${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' '${workerScript}' --session-id 'session-1'$`));
  assert.doesNotMatch(command, /script -q/);
  assert.match(command, /export COPILOT_WEB_RELAY_WORKER_KIND='cursor';/);
  assert.match(command, /export CURSOR_RELAY_MODEL='cursor-fast-1';/);
  assert.match(command, /export CURSOR_AGENT_STORE_DIR='\/home\/dev\/\.cursor-agent-store';/);
  // The worker finds its agent store in the relay's data dir.
  assert.match(command, /export COPILOT_WEB_RELAY_DATA_DIR='\/home\/dev\/\.oar\/data';/);
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
  // The Claude login token is the third; it goes to the two Claude workers
  // only (session-worker-launch-service.claude-cloud.test.mjs). The DeepSeek
  // key is the fourth, the DeepSeek worker's alone (….deepseek.test.mjs); the
  // Claude API key the fifth, the Claude API worker's alone
  // (….claude-api.test.mjs). A host's Anthropic credentials are the last two,
  // no worker's (….anthropic-env.test.mjs).
  assert.deepEqual([...WORKER_SECRET_ENV_VARS], [
    'COPILOT_PROVIDER_API_KEY',
    'CURSOR_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'DEEPSEEK_API_KEY',
    'OAR_CLAUDE_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
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
    processInspector: { findProcessForSessionAsync: () => null },
    allowProcessReuse: false,
  });
  assert.equal(launched.pid, 4242);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, process.execPath);
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
    processInspector: { findProcessForSessionAsync: () => null },
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
    process.execPath,
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
      findProcessForSessionAsync: () => ({ processId: process.pid, commandLine: 'node cursor-session-worker.mjs --session-id session-6' }),
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

// The second unset statement, written out: every variable of the host
// Claude session's names and families (shared/host-claude-session-env.mjs)
// the shell holds.
const HOST_FAMILY_UNSET = "for oar_host_var in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do "
  // The settings inside a family first, which stay,
  + 'case "$oar_host_var" in CLAUDE_CODE_SESSION_START_ANNOUNCEMENTS_BEFORE_PROMPT|CLAUDE_CODE_SESSION_LOG) ;; '
  // then the names and families, which go.
  + 'CLAUDECODE|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_MESSAGING_SOCKET|CLAUDE_CODE_MESSAGING_TOKEN|'
  + 'CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SESSION_ATTENDED|CLAUDE_CODE_EXECPATH|'
  + 'CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS|CLAUDE_AGENT_SDK_VERSION|CLAUDE_AGENT_SDK_CLIENT_APP|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PROJECT_DIR|CLAUDE_ENV_FILE|'
  + 'CLAUDE_CODE_SESSION_*|CLAUDE_CODE_*_SESSION_ID|CLAUDE_CODE_MESSAGING_*) unset "$oar_host_var";; esac; done; unset oar_host_var; ';

test('copilot tmux command output is byte-identical: the unset prefix, then the pre-cursor exports and exec', () => {
  const command = buildTmuxWorkerShellCommand('session-2', {
    COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
    COPILOT_WEB_RELAY_NODE: '/opt/node/bin/node',
  });
  assert.equal(
    command,
    // The unset prefix, written out: the host Claude session's variables
    // (HOST_CLAUDE_SESSION_ENV_VARS), the inherited worker log file
    // (WORKER_LOG_FILE_ENV),
    "unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN "
    + "CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_EXECPATH "
    + "CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS CLAUDE_AGENT_SDK_VERSION CLAUDE_AGENT_SDK_CLIENT_APP CLAUDE_PID CLAUDE_EFFORT "
    + "CLAUDE_PROJECT_DIR CLAUDE_ENV_FILE "
    + "COPILOT_WEB_RELAY_WORKER_LOG_FILE "
    // every per-launch variable (TMUX_WORKER_EXPORTED_ENV_VARS) this launch
    // exports no value for,
    + "COPILOT_ALLOW_ALL GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS COPILOT_WEB_RELAY_ROOT COPILOT_WEB_RELAY_SERVER_DIR "
    + "COPILOT_WEB_RELAY_TOOLS COPILOT_WEB_RELAY_LOG_DIR COPILOT_WEB_RELAY_DATA_DIR "
    + "COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH COPILOT_SDK_PATH EXTENSION_PATH COPILOT_PROVIDER_TYPE "
    + "COPILOT_PROVIDER_BASE_URL COPILOT_PROVIDER_WIRE_API COPILOT_MODEL COPILOT_WEB_RELAY_WORKER_KIND "
    + "COPILOT_RELAY_MODEL COPILOT_PROVIDER_MAX_PROMPT_TOKENS COPILOT_PROVIDER_MAX_OUTPUT_TOKENS "
    + "CLAUDE_CONFIG_DIR CLAUDE_CODE_EXECUTABLE CLAUDE_RELAY_MODEL CLAUDE_CLOUD_RELAY_MODEL "
    + "OAR_CLAUDE_CLOUD_API_BASE_URL CURSOR_RELAY_MODEL CURSOR_AGENT_STORE_DIR DEEPSEEK_RELAY_MODEL "
    + "DEEPSEEK_BASE_URL DEEPSEEK_CLAUDE_CONFIG_DIR CLAUDE_API_RELAY_MODEL OAR_ANTHROPIC_API_BASE_URL "
    + "GROK_RELAY_MODEL GROK_CLI_COMMAND GROK_ALWAYS_APPROVE "
    + "OAR_MCP_SERVER OAR_MCP_SERVER_ATTACHED COPILOT_WORKSPACE_ROOT INIT_CWD "
    // and every secret (WORKER_SECRET_ENV_VARS) it carries no value for.
    + "COPILOT_PROVIDER_API_KEY CURSOR_API_KEY CLAUDE_CODE_OAUTH_TOKEN DEEPSEEK_API_KEY OAR_CLAUDE_API_KEY "
    + "ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; "
    // Then the host session's variables by family, from whatever the shell holds.
    + HOST_FAMILY_UNSET
    + "export COPILOT_WEB_RELAY_CONFIG='/repo/server/config.json'; "
    + "export COPILOT_WEB_RELAY_CLI_EXECUTABLE='/usr/bin/copilot'; "
    + "export SESSION_ID='session-2'; "
    // The CLI is a Node program too: the relay's Node folder ends its PATH.
    + `case ":$PATH:" in *:'/opt/node/bin':*) ;; *) PATH="$PATH:"'/opt/node/bin';; esac; export PATH; `
    + "exec script -q -c ''\\''/usr/bin/copilot'\\'' --allow-all --session-id '\\''session-2'\\''' /dev/null",
  );
});

test('claude tmux command output is byte-identical: the unset prefix, then the pre-cursor exports and exec', () => {
  const command = buildTmuxWorkerShellCommand('session-1', {
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
    CLAUDE_RELAY_MODEL: 'claude-sonnet-5',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
    COPILOT_WEB_RELAY_NODE: '/opt/node/bin/node',
  });
  const workerScript = path.join('/repo', 'server', 'claude-worker', 'claude-session-worker.mjs');
  assert.equal(
    command,
    // The unset prefix, written out: the host Claude session's variables
    // (HOST_CLAUDE_SESSION_ENV_VARS), the inherited worker log file
    // (WORKER_LOG_FILE_ENV),
    "unset CLAUDECODE CLAUDE_CODE_SESSION_ID CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN "
    + "CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_EXECPATH "
    + "CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS CLAUDE_AGENT_SDK_VERSION CLAUDE_AGENT_SDK_CLIENT_APP CLAUDE_PID CLAUDE_EFFORT "
    + "CLAUDE_PROJECT_DIR CLAUDE_ENV_FILE "
    + "COPILOT_WEB_RELAY_WORKER_LOG_FILE "
    // every per-launch variable (TMUX_WORKER_EXPORTED_ENV_VARS) this launch
    // exports no value for,
    + "COPILOT_ALLOW_ALL GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS COPILOT_WEB_RELAY_SERVER_DIR "
    + "COPILOT_WEB_RELAY_TOOLS COPILOT_WEB_RELAY_LOG_DIR COPILOT_WEB_RELAY_DATA_DIR COPILOT_WEB_RELAY_CLI_EXECUTABLE "
    + "COPILOT_WEB_RELAY_EXTENSION_BOOTSTRAP_PATH COPILOT_SDK_PATH EXTENSION_PATH COPILOT_PROVIDER_TYPE "
    + "COPILOT_PROVIDER_BASE_URL COPILOT_PROVIDER_WIRE_API COPILOT_MODEL "
    + "COPILOT_RELAY_MODEL COPILOT_PROVIDER_MAX_PROMPT_TOKENS COPILOT_PROVIDER_MAX_OUTPUT_TOKENS "
    + "CLAUDE_CONFIG_DIR CLAUDE_CODE_EXECUTABLE CLAUDE_CLOUD_RELAY_MODEL "
    + "OAR_CLAUDE_CLOUD_API_BASE_URL CURSOR_RELAY_MODEL CURSOR_AGENT_STORE_DIR DEEPSEEK_RELAY_MODEL "
    + "DEEPSEEK_BASE_URL DEEPSEEK_CLAUDE_CONFIG_DIR CLAUDE_API_RELAY_MODEL OAR_ANTHROPIC_API_BASE_URL "
    + "GROK_RELAY_MODEL GROK_CLI_COMMAND GROK_ALWAYS_APPROVE "
    + "OAR_MCP_SERVER OAR_MCP_SERVER_ATTACHED COPILOT_WORKSPACE_ROOT INIT_CWD "
    // and every secret (WORKER_SECRET_ENV_VARS) it carries no value for.
    + "COPILOT_PROVIDER_API_KEY CURSOR_API_KEY CLAUDE_CODE_OAUTH_TOKEN DEEPSEEK_API_KEY OAR_CLAUDE_API_KEY "
    + "ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; "
    // Then the host session's variables by family, from whatever the shell holds.
    + HOST_FAMILY_UNSET
    + "export COPILOT_WEB_RELAY_ROOT='/repo'; "
    + "export COPILOT_WEB_RELAY_CONFIG='/repo/server/config.json'; "
    + "export COPILOT_WEB_RELAY_WORKER_KIND='claude'; "
    + "export CLAUDE_RELAY_MODEL='claude-sonnet-5'; "
    + "export SESSION_ID='session-1'; "
    + `case ":$PATH:" in *:'/opt/node/bin':*) ;; *) PATH="$PATH:"'/opt/node/bin';; esac; export PATH; `
    + `exec '/opt/node/bin/node' '${workerScript}' --session-id 'session-1'`,
  );
});

test('a Cursor worker gets the relay\'s data dir as an absolute path', () => {
  const env = applyCursorProviderEnvironment({ COPILOT_WEB_RELAY_DATA_DIR: 'relative-data' }, {
    enabled: true,
    apiKey: 'cursor-test-key',
    dataDir: '/home/dev/.oar/data',
  });
  // Resolved (on Windows onto the current drive).
  assert.equal(env.COPILOT_WEB_RELAY_DATA_DIR, path.resolve('/home/dev/.oar/data'));
  // Off, the variable the relay itself has is left as it is.
  const off = applyCursorProviderEnvironment({ COPILOT_WEB_RELAY_DATA_DIR: '/home/dev/.oar/data' }, { enabled: false, dataDir: '/x' });
  assert.equal(off.COPILOT_WEB_RELAY_DATA_DIR, '/home/dev/.oar/data');
});
