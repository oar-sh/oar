'use strict';

import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyClaudeProviderEnvironment,
  buildTmuxWorkerShellCommand,
  isClaudeWorkerEnvironment,
  launchSessionCli,
  resolveClaudeWorkerScriptPath,
} from './session-worker-launch-service.mjs';

test('applyClaudeProviderEnvironment sets the worker kind and model when enabled', () => {
  const env = applyClaudeProviderEnvironment({ PATH: '/bin' }, { enabled: true, model: 'claude-sonnet-5' });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'claude');
  assert.equal(env.CLAUDE_RELAY_MODEL, 'claude-sonnet-5');
  assert.equal(env.PATH, '/bin');
  assert.equal(isClaudeWorkerEnvironment(env), true);
});

test('applyClaudeProviderEnvironment clears claude keys when disabled', () => {
  const env = applyClaudeProviderEnvironment({
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
    CLAUDE_RELAY_MODEL: 'claude-sonnet-5',
    PATH: '/bin',
  });
  assert.equal('COPILOT_WEB_RELAY_WORKER_KIND' in env, false);
  assert.equal('CLAUDE_RELAY_MODEL' in env, false);
  assert.equal(isClaudeWorkerEnvironment(env), false);
});

test('resolveClaudeWorkerScriptPath prefers explicit path, then repo root, then server dir', () => {
  assert.equal(
    resolveClaudeWorkerScriptPath({ COPILOT_WEB_RELAY_CLAUDE_WORKER_PATH: '/custom/worker.mjs' }),
    '/custom/worker.mjs',
  );
  assert.equal(
    resolveClaudeWorkerScriptPath({ COPILOT_WEB_RELAY_ROOT: '/repo' }),
    path.join('/repo', 'server', 'claude-worker', 'claude-session-worker.mjs'),
  );
  assert.equal(
    resolveClaudeWorkerScriptPath({ COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server' }),
    path.join('/repo/server', 'claude-worker', 'claude-session-worker.mjs'),
  );
});

test('tmux shell command for claude workers runs node without the script PTY wrapper', () => {
  const env = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
    CLAUDE_RELAY_MODEL: 'claude-sonnet-5',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
  };
  const command = buildTmuxWorkerShellCommand('session-1', env);
  const workerScript = path.join('/repo', 'server', 'claude-worker', 'claude-session-worker.mjs')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(command, new RegExp(`exec 'node' '${workerScript}' --session-id 'session-1'$`));
  assert.doesNotMatch(command, /script -q/);
  assert.match(command, /export COPILOT_WEB_RELAY_WORKER_KIND='claude';/);
  assert.match(command, /export CLAUDE_RELAY_MODEL='claude-sonnet-5';/);
});

test('tmux shell command for copilot workers is unchanged (script PTY wrapper)', () => {
  const env = {
    COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
  };
  const command = buildTmuxWorkerShellCommand('session-2', env);
  assert.match(command, /exec script -q -c /);
  assert.match(command, /\/usr\/bin\/copilot/);
  assert.match(command, /--allow-all --session-id/);
  assert.doesNotMatch(command, /claude-session-worker/);
});

test('launchSessionCli spawns node for claude workers when tmux is unavailable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'session-3',
    cwd: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'claude',
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
    path.join('/repo', 'server', 'claude-worker', 'claude-session-worker.mjs'),
    '--session-id',
    'session-3',
  ]);
});

test('launchSessionCli still spawns the copilot CLI for non-claude workers without tmux', async () => {
  const spawnCalls = [];
  await launchSessionCli({
    targetSessionId: 'session-4',
    cwd: '/workspace',
    env: { COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/bin/copilot' },
    platform: 'linux',
    spawnImpl: (command, args) => {
      spawnCalls.push({ command, args });
      return { pid: 999, unref: () => {} };
    },
    execFileSyncImpl: () => { throw new Error('tmux missing'); },
    processInspector: { findProcessForSession: () => null },
    allowProcessReuse: false,
  });
  assert.equal(spawnCalls[0].command, '/usr/bin/copilot');
  assert.deepEqual(spawnCalls[0].args, ['--allow-all', '--session-id', 'session-4']);
});
