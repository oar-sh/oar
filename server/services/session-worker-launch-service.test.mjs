import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  WORKER_SECRET_ENV_VARS,
  workerSecretEnvVarsFor,
} from './session-worker-launch-service.mjs';

// A log dir that cannot be created on any platform: its parent is a file.
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-worker-launch-'));
test.after(() => fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }));
fs.writeFileSync(path.join(SCRATCH_DIR, 'a-file'), '');
const UNWRITABLE_LOG_DIR = path.join(SCRATCH_DIR, 'a-file', 'logs');

// The worker the generic launches below start; the launcher treats every kind
// alike. No launch writes a log.
const WORKER_ENV = Object.freeze({
  COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk',
  COPILOT_WEB_RELAY_ROOT: '/srv/oar',
  COPILOT_WEB_RELAY_LOG_DIR: UNWRITABLE_LOG_DIR,
});
const WORKER_SCRIPT = path.join('/srv/oar', 'server', 'copilot-worker', 'copilot-sdk-session-worker.mjs');
const WORKER_ARGS = Object.freeze([WORKER_SCRIPT, '--session-id', 'abc-123']);

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
    ...WORKER_ENV,
    COPILOT_ALLOW_ALL: 'true',
    COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION: 'true',
    COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
    INIT_CWD: '/workspace',
    IGNORED_VAR: 'nope',
  });

  assert.match(command, /COPILOT_ALLOW_ALL='true'/);
  assert.doesNotMatch(command, /GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS/);
  assert.doesNotMatch(command, /COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION/);
  assert.match(command, /COPILOT_WEB_RELAY_SERVER_DIR='\/repo\/server'/);
  assert.match(command, /COPILOT_WEB_RELAY_CONFIG='\/repo\/server\/config\.json'/);
  assert.match(command, /INIT_CWD='\/workspace'/);
  assert.match(command, /SESSION_ID='abc-123'/);
  assert.doesNotMatch(command, /IGNORED_VAR/);
  assert.ok(command.endsWith(`exec ${shq(process.execPath)} ${shq(WORKER_SCRIPT)} --session-id ${shq('abc-123')}`), command);
  assert.doesNotMatch(command, /script -q|--allow-all/);
  assert.doesNotMatch(command, /GH_FORCE_TTY/);
});

test('tmux worker command never embeds the provider API key', () => {
  const env = {
    ...WORKER_ENV,
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

test('buildTmuxWorkerShellCommand forwards the SDK path and names the session of this launch', () => {
  const command = buildTmuxWorkerShellCommand('abc-123', {
    ...WORKER_ENV,
    EXTENSION_PATH: '/repo/server/relay-extension.mjs',
    COPILOT_SDK_PATH: '/cache/copilot/copilot-sdk',
    SESSION_ID: 'stale-session',
  });
  assert.doesNotMatch(command, /relay-extension/);
  assert.match(command, /COPILOT_SDK_PATH='\/cache\/copilot\/copilot-sdk'/);
  assert.match(command, /SESSION_ID='abc-123'/);
  assert.doesNotMatch(command, /SESSION_ID='stale-session'/);
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
      return finds >= 2 ? { processId: process.pid, commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123' } : null;
    },
  };

  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      ...WORKER_ENV,
      COPILOT_ALLOW_ALL: 'false',
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
  assert.doesNotMatch(shellCommand, /GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS/);
  assert.doesNotMatch(shellCommand, /COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION/);
  assert.match(shellCommand, /COPILOT_WEB_RELAY_CONFIG='\/relay\/server\/config\.json'/);
  assert.match(shellCommand, /COPILOT_WORKSPACE_ROOT='\/repo'/);
  assert.doesNotMatch(shellCommand, /GH_FORCE_TTY|script -q|--allow-all/);
  assert.ok(
    shellCommand.endsWith(`exec ${shq(process.execPath)} ${shq(WORKER_SCRIPT)} --session-id ${shq('abc-123')}`),
    `unexpected tmux command: ${shellCommand}`,
  );
});

test('buildTmuxWorkerShellCommand forwards the OAR MCP kill switch to workers', () => {
  const command = buildTmuxWorkerShellCommand('abc-123', { OAR_MCP_SERVER: '0', COPILOT_WEB_RELAY_WORKER_KIND: 'grok' });
  assert.match(command, /export OAR_MCP_SERVER='0';/);
});

test('buildTmuxWorkerShellCommand unsets the host Claude session and unexported relay variables first', () => {
  // A new tmux session inherits the tmux server's global environment, so the
  // worker command itself has to drop what the host session and earlier
  // launches may have left there.
  const command = buildTmuxWorkerShellCommand('abc-123', {
    SESSION_ID: 'abc-123',
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
    CLAUDE_RELAY_MODEL: 'claude-sonnet-5-5',
    COPILOT_PROVIDER_API_KEY: 'sk-secret',
  }, { secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env' });
  const unsetStatement = command.match(/^unset ([^;]+);/);
  assert.ok(unsetStatement, 'command starts with an unset statement');
  const unsetNames = unsetStatement[1].split(' ');
  for (const name of [
    'CLAUDECODE',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
    'DEEPSEEK_RELAY_MODEL',
    'COPILOT_RELAY_MODEL',
    'CURSOR_RELAY_MODEL',
    'GROK_RELAY_MODEL',
    'OAR_MCP_SERVER',
  ]) {
    assert.ok(unsetNames.includes(name), `${name} is unset`);
  }
  for (const name of ['SESSION_ID', 'COPILOT_WEB_RELAY_WORKER_KIND', 'CLAUDE_RELAY_MODEL']) {
    assert.ok(!unsetNames.includes(name), `${name} is exported, not unset`);
  }
  assert.ok(command.indexOf('unset ') < command.indexOf('export '), 'unset precedes the exports');
  assert.match(command, /export CLAUDE_RELAY_MODEL='claude-sonnet-5-5';/);
  assert.doesNotMatch(command, /sk-secret|COPILOT_PROVIDER_API_KEY/);
});

test('buildTmuxWorkerShellCommand unsets the inherited worker log file and the secrets of other worker kinds, by name only', () => {
  // The tmux server's environment may carry a worker log from the session the
  // relay was started in, and the secrets a shell exported for every kind.
  const unsetNamesOf = (env) => buildTmuxWorkerShellCommand('abc-123', env, { secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env' })
    .match(/^unset ([^;]+);/)[1].split(' ');
  const deepseek = unsetNamesOf({
    SESSION_ID: 'abc-123',
    COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek',
    COPILOT_WEB_RELAY_WORKER_LOG_FILE: '/var/log/oar/worker-host.log',
    DEEPSEEK_API_KEY: 'sk-test-0000000000000000',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token',
  });
  assert.ok(deepseek.includes('COPILOT_WEB_RELAY_WORKER_LOG_FILE'));
  assert.ok(deepseek.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'the Claude workers\' login is unset for DeepSeek');
  // The worker's own secret the launch carries (workerSecretEnvVarsFor) is
  // left to the secret file, and never exported; its own secrets the launch
  // has no value for are unset like the other kinds'.
  assert.ok(workerSecretEnvVarsFor({ COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek' }).includes('DEEPSEEK_API_KEY'));
  assert.ok(!deepseek.includes('DEEPSEEK_API_KEY'));
  assert.ok(deepseek.includes('COPILOT_PROVIDER_API_KEY') && deepseek.includes('CURSOR_API_KEY'));
  const command = buildTmuxWorkerShellCommand('abc-123', {
    SESSION_ID: 'abc-123',
    COPILOT_WEB_RELAY_WORKER_KIND: 'deepseek',
    COPILOT_WEB_RELAY_WORKER_LOG_FILE: '/var/log/oar/worker-host.log',
    DEEPSEEK_API_KEY: 'sk-test-0000000000000000',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token',
  }, { secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env' });
  assert.doesNotMatch(command, /sk-test-0000000000000000|oauth-test-token|worker-host\.log/, 'no value of any of them');
  // The Claude worker keeps its login token and loses DeepSeek's key.
  const claude = unsetNamesOf({ SESSION_ID: 'abc-123', COPILOT_WEB_RELAY_WORKER_KIND: 'claude', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token' });
  assert.ok(claude.includes('DEEPSEEK_API_KEY'));
  assert.ok(!claude.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  // Every kind gets the log file unset, with or without a value for it; a
  // kind with no secret of its own among the kind-bound ones loses them all.
  const grok = unsetNamesOf({ SESSION_ID: 'abc-123', COPILOT_WEB_RELAY_WORKER_KIND: 'grok' });
  assert.ok(grok.includes('COPILOT_WEB_RELAY_WORKER_LOG_FILE'));
  assert.ok(grok.includes('DEEPSEEK_API_KEY') && grok.includes('CLAUDE_CODE_OAUTH_TOKEN'));
});

test('buildTmuxWorkerShellCommand unsets every secret the launch carries no value for, its own kind\'s included', () => {
  // A tmux server started from a shell that exported the Copilot or Cursor
  // key hands it to every worker; a launch without a value for it unsets the
  // name, whatever the kind. With a value the name stays set for the secret
  // file to fill, and the value itself is never in the command.
  const secretFile = { secretEnvFilePath: '/tmp/copilot-relay-worker-test/provider.env' };
  const commandFor = (env) => buildTmuxWorkerShellCommand('abc-123', { SESSION_ID: 'abc-123', ...env }, secretFile);
  const unsetNamesOf = (env) => commandFor(env).match(/^unset ([^;]+);/)[1].split(' ');
  for (const kind of ['claude', 'cursor', 'copilot-sdk']) {
    const names = unsetNamesOf({ COPILOT_WEB_RELAY_WORKER_KIND: kind });
    assert.ok(names.includes('COPILOT_PROVIDER_API_KEY'), `${kind}: the Copilot key is unset without a value`);
    assert.ok(names.includes('CURSOR_API_KEY'), `${kind}: the Cursor key is unset without a value`);
    for (const name of WORKER_SECRET_ENV_VARS) assert.ok(names.includes(name), `${kind}: ${name} is unset without a value`);
  }
  const cursor = unsetNamesOf({ COPILOT_WEB_RELAY_WORKER_KIND: 'cursor', CURSOR_API_KEY: 'cursor-test-key' });
  assert.ok(!cursor.includes('CURSOR_API_KEY'), 'the Cursor worker keeps its own key');
  assert.ok(cursor.includes('COPILOT_PROVIDER_API_KEY'));
  const copilot = unsetNamesOf({ COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk', COPILOT_PROVIDER_API_KEY: 'sk-secret' });
  assert.ok(!copilot.includes('COPILOT_PROVIDER_API_KEY'), 'the Copilot worker keeps its own key');
  assert.ok(copilot.includes('CURSOR_API_KEY'));
  const claude = unsetNamesOf({ COPILOT_WEB_RELAY_WORKER_KIND: 'claude', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token', COPILOT_PROVIDER_API_KEY: 'sk-secret' });
  assert.ok(!claude.includes('CLAUDE_CODE_OAUTH_TOKEN') && !claude.includes('COPILOT_PROVIDER_API_KEY'));
  assert.ok(claude.includes('CURSOR_API_KEY') && claude.includes('DEEPSEEK_API_KEY'));
  // A blank value is no value.
  assert.ok(unsetNamesOf({ COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk', COPILOT_PROVIDER_API_KEY: '  ' }).includes('COPILOT_PROVIDER_API_KEY'));
  // Names only: no value of any secret reaches the command, and the unset
  // comes before the secret file is read.
  for (const env of [
    { COPILOT_WEB_RELAY_WORKER_KIND: 'cursor', CURSOR_API_KEY: 'cursor-test-key' },
    { COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk', COPILOT_PROVIDER_API_KEY: 'sk-secret' },
    { COPILOT_WEB_RELAY_WORKER_KIND: 'claude', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token' },
  ]) {
    const command = commandFor(env);
    assert.doesNotMatch(command, /cursor-test-key|sk-secret|oauth-test-token/);
    assert.ok(command.indexOf('unset ') < command.indexOf(secretFile.secretEnvFilePath));
  }
});

test('buildTmuxWorkerShellCommand unsets a relay variable the launch has no value for', () => {
  const command = buildTmuxWorkerShellCommand('abc-123', { SESSION_ID: 'abc-123', COPILOT_WEB_RELAY_WORKER_KIND: 'grok' });
  const unsetNames = command.match(/^unset ([^;]+);/)[1].split(' ');
  assert.ok(unsetNames.includes('CLAUDE_RELAY_MODEL'));
  assert.ok(unsetNames.includes('COPILOT_MODEL'));
  assert.ok(!unsetNames.includes('COPILOT_WEB_RELAY_WORKER_KIND'));
});

test('launchSessionCli falls back to detached spawn when tmux is unavailable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: '/relay',
    workspaceRoot: '/repo',
    env: {
      ...WORKER_ENV,
      PATH: process.env.PATH || '',
      COPILOT_ALLOW_ALL: 'false',
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
  assert.equal(spawnCalls[0]?.command, process.execPath);
  assert.deepEqual(spawnCalls[0]?.args, WORKER_ARGS);
  assert.equal(spawnCalls[0]?.options?.cwd, '/relay');
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WORKSPACE_ROOT, '/repo');
  assert.equal(spawnCalls[0]?.options?.env?.INIT_CWD, '/repo');
  assert.equal(spawnCalls[0]?.options?.env?.PWD, '/relay');
  assert.equal(spawnCalls[0]?.options?.env?.SESSION_ID, 'abc-123');
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_ALLOW_ALL, 'true');
  assert.equal(spawnCalls[0]?.options?.env?.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, undefined);
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION, undefined);
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WEB_RELAY_CONFIG, '/relay/server/config.json');
});

test('launchSessionCli opens a visible detached console on windows', async () => {
  const spawnCalls = [];
  let unrefCalled = false;
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: 'C:\\relay',
    workspaceRoot: 'C:\\repo',
    env: {
      ...WORKER_ENV,
      COPILOT_WEB_RELAY_ROOT: 'C:\\srv\\oar',
      PATH: process.env.PATH || '',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      COPILOT_ALLOW_ALL: 'false',
      COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION: 'true',
    },
    platform: 'win32',
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
    'Copilot SDK Worker abc-123',
    process.execPath,
    path.join('C:\\srv\\oar', 'server', 'copilot-worker', 'copilot-sdk-session-worker.mjs'),
    '--session-id',
    'abc-123',
  ]);
  assert.equal(spawnCalls[0]?.options?.shell, undefined);
  assert.equal(spawnCalls[0]?.options?.detached, true);
  assert.equal(spawnCalls[0]?.options?.stdio, 'ignore');
  assert.equal(spawnCalls[0]?.options?.windowsHide, false);
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_ALLOW_ALL, 'true');
  assert.equal(spawnCalls[0]?.options?.env?.GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS, undefined);
  assert.equal(spawnCalls[0]?.options?.env?.COPILOT_WEB_RELAY_FORCE_GLOBAL_EXTENSION, undefined);
  assert.equal(unrefCalled, true);
});

test('launchSessionCli returns unknown pid when windows console spawn has no pid', async () => {
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    processCwd: 'C:\\relay',
    workspaceRoot: 'C:\\repo',
    env: {
      ...WORKER_ENV,
      PATH: process.env.PATH || '',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    platform: 'win32',
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
      ...WORKER_ENV,
      PATH: process.env.PATH || '',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    },
    platform: 'win32',
    processInspector: {
      findProcessForSessionAsync() {
        inspections += 1;
        if (inspections < 2) return null;
        return { processId: process.pid, commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123' };
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
    env: { ...WORKER_ENV },
    processInspector: {
      findProcessForSessionAsync() {
        return { processId: process.pid, commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123' };
      },
    },
    readProcessIdentity: async (pid, options) => {
      assert.deepEqual(options, { fresh: true });
      return { pid, startTime: '987654', commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123' };
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

test('launchSessionCli reuses a listed process only by its identity, never by its pid alone', async () => {
  // The row names pid `process.pid` (alive: this test); what runs there now
  // decides.
  const launchWith = async ({ platform = 'linux', row = { processId: process.pid, commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123' }, current }) => {
    const spawned = [];
    let launched = null;
    try {
      launched = await launchSessionCli({
        targetSessionId: 'abc-123',
        cwd: '/repo',
        platform,
        env: { ...WORKER_ENV, COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN: '' },
        processInspector: { findProcessForSessionAsync: async () => row },
        readProcessIdentity: async () => (typeof current === 'function' ? current() : current),
        execFileSyncImpl() { throw new Error('no tmux here'); },
        spawnImpl() { spawned.push('spawn'); throw new Error('spawned'); },
      });
    } catch (error) {
      if (!/spawned|tmux/.test(error.message)) throw error;
    }
    return { reused: launched?.reused === true, spawned: spawned.length > 0 || !launched };
  };
  const ours = (extra = {}) => ({ pid: process.pid, startTime: '987654', commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123', ...extra });
  assert.equal((await launchWith({ current: ours() })).reused, true, 'the session\'s by its command line');
  assert.equal((await launchWith({ current: ours({ commandLine: 'sshd: dev@pts/0' }) })).reused, false, 'the pid went to another program');
  assert.equal((await launchWith({ current: null })).reused, false, 'no process has the pid');
  assert.equal((await launchWith({ current: () => { throw new Error('unreadable'); } })).reused, true, 'nothing readable: a running process is reused, never doubled');
  // Windows: the fresh row is the identity (its createdAt and command line),
  // so no second read of the process list judges it.
  const winRow = { processId: process.pid, commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123', createdAt: 1762941600000 };
  let reads = 0;
  const counted = () => { reads += 1; return null; };
  assert.equal((await launchWith({ platform: 'win32', row: winRow, current: counted })).reused, true);
  assert.equal((await launchWith({ platform: 'win32', row: { ...winRow, commandLine: 'node copilot-sdk-session-worker.mjs --session-id other-9' }, current: counted })).reused, false, 'a row of another session');
  assert.equal(reads, 0, 'no identity read on Windows');
});

test('launchSessionCli reuses only a session worker: never a Copilot CLI of the session, nor the tmux pane it runs in', async () => {
  const launchOver = async (commandLine, { platform = 'linux', name = '', paneAlive = false } = {}) => {
    const row = { processId: process.pid, name, commandLine, ...(platform === 'win32' ? { createdAt: 1762941600000 } : {}) };
    const tmux = [];
    let launched = null;
    try {
      launched = await launchSessionCli({
        targetSessionId: 'abc-123',
        cwd: '/repo',
        platform,
        env: { ...WORKER_ENV },
        processInspector: { findProcessForSessionAsync: async () => row },
        readProcessIdentity: async (pid) => ({ pid, startTime: '987654', commandLine }),
        execFileSyncImpl(command, args) {
          if (!paneAlive) throw new Error('no tmux here');
          tmux.push(args[0]);
          if (args[0] === '-V') return Buffer.from('tmux 3.6');
          if (args[0] === 'list-panes') return Buffer.from(`${process.pid}\n`);
          if (args[0] === 'new-session') throw new Error('spawned');
          return Buffer.alloc(0);
        },
        spawnImpl() { throw new Error('spawned'); },
      });
    } catch (error) {
      if (!/spawned/.test(error.message)) throw error;
    }
    return { reused: launched?.reused === true, tmux };
  };
  assert.equal((await launchOver('node /srv/oar/server/copilot-worker/copilot-sdk-session-worker.mjs --session-id abc-123')).reused, true);
  assert.equal((await launchOver('copilot --resume abc-123 --allow-all')).reused, false, 'a Copilot CLI of the session');
  assert.equal((await launchOver('node /srv/oar/server/claude-worker/claude-session-worker.mjs --session-id abc-123')).reused, true, 'a worker of another kind is the billing swap\'s to replace');
  // Under tmux the leftover's pane is alive: it is replaced, not reused.
  const replaced = await launchOver('copilot --resume abc-123 --allow-all', { paneAlive: true });
  assert.equal(replaced.reused, false);
  assert.ok(replaced.tmux.includes('kill-session') && replaced.tmux.includes('new-session'), replaced.tmux.join(' '));
  assert.equal((await launchOver('node copilot-sdk-session-worker.mjs --session-id abc-123', { paneAlive: true })).reused, true);
  // Windows: the row is the identity.
  assert.equal((await launchOver('C:\\Tools\\copilot.exe --resume abc-123 --allow-all', { platform: 'win32', name: 'copilot.exe' })).reused, false);
  assert.equal((await launchOver('node C:\\oar\\server\\copilot-worker\\copilot-sdk-session-worker.mjs --session-id abc-123', { platform: 'win32', name: 'node.exe' })).reused, true);
});

test('launchSessionCli bypasses process reuse when disabled', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'abc-123',
    cwd: '/repo',
    env: {
      ...WORKER_ENV,
      PATH: process.env.PATH || '',
    },
    platform: 'linux',
    allowProcessReuse: false,
    processInspector: {
      findProcessForSessionAsync() {
        return { processId: process.pid, commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123' };
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
  assert.equal(spawnCalls[0]?.command, process.execPath);
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
      ...WORKER_ENV,
      PATH: process.env.PATH || '',
    },
    platform: 'linux',
    processInspector: {
      findProcessForSessionAsync() {
        return { processId: 99999999, commandLine: 'node copilot-sdk-session-worker.mjs --session-id abc-123' };
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
  assert.equal(spawnCalls[0]?.command, process.execPath);
});

test('tmux commands tee output into the worker log', async () => {
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

test('workerLogPathFor: the log dir, else the server dir, else beside the module; no folder made', async () => {
  const { workerLogPathFor, resolveWorkerLogDir } = await import('./session-worker-launch-service.mjs');
  assert.equal(workerLogPathFor('sid-1', { COPILOT_WEB_RELAY_LOG_DIR: '/var/log/relay', COPILOT_WEB_RELAY_SERVER_DIR: '/srv' }, { pathImpl: path.posix }), '/var/log/relay/worker-sid-1.log');
  assert.equal(workerLogPathFor('sid-1', { COPILOT_WEB_RELAY_SERVER_DIR: '/srv/server' }, { pathImpl: path.posix }), '/srv/server/logs/worker-sid-1.log');
  assert.equal(workerLogPathFor('sid-1', {}), path.join(resolveWorkerLogDir({}), 'worker-sid-1.log'));
  assert.equal(workerLogPathFor('sid-1', { COPILOT_WEB_RELAY_SERVER_DIR: 'C:\\srv\\relay' }, { pathImpl: path.win32 }), 'C:\\srv\\relay\\logs\\worker-sid-1.log');
});

test('workerLogPathFor cleans the id like the launch, cuts it at 64, and gives null for an id that cleans to nothing', async () => {
  const { workerLogPathFor } = await import('./session-worker-launch-service.mjs');
  const env = { COPILOT_WEB_RELAY_LOG_DIR: '/logs' };
  assert.equal(workerLogPathFor('sid/../evil', env, { pathImpl: path.posix }), '/logs/worker-sidevil.log');
  assert.equal(workerLogPathFor(`${'a'.repeat(70)}`, env, { pathImpl: path.posix }), `/logs/worker-${'a'.repeat(64)}.log`);
  for (const empty of ['', null, undefined, '../..', '   ']) {
    assert.equal(workerLogPathFor(empty, env, { pathImpl: path.posix }), null, String(empty));
  }
});

test('prepareWorkerLogFile opens the path workerLogPathFor names; an empty id still gets the shared file', async () => {
  const { prepareWorkerLogFile, workerLogPathFor } = await import('./session-worker-launch-service.mjs');
  const fsImpl = { mkdirSync: () => {}, statSync: () => { throw new Error('missing'); }, renameSync: () => {} };
  const env = { COPILOT_WEB_RELAY_LOG_DIR: '/logs' };
  for (const id of ['sid-1', 'f0e1d2c3-b4a5-4697-8879-6a5b4c3d2e1f', 'sid/../evil', 'x'.repeat(80)]) {
    assert.equal(prepareWorkerLogFile(id, env, { fsImpl, pathImpl: path.posix }), workerLogPathFor(id, env, { pathImpl: path.posix }), id);
  }
  assert.equal(prepareWorkerLogFile('', env, { fsImpl, pathImpl: path.posix }), '/logs/worker-worker.log');
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

test('every worker kind is told its worker log on the windows console launch', async () => {
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

test('the launcher prefers the asynchronous finder and asks the reuse check and the pid poll for a fresh list', async () => {
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
    prepareWorkerLogFileImpl: () => null,
    processInspector: {
      async findProcessForSessionAsync(target, options) {
        lookups.push({ target, options });
        // The reuse check finds nothing; the polls find the new process.
        if (lookups.length === 1) return null;
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
  assert.deepEqual(lookups.map((entry) => entry.options), [{ fresh: true }, { fresh: true }, { fresh: true }]);
  assert.ok(lookups.every((entry) => entry.target === 'abc-123'));
});
