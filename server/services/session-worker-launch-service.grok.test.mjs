'use strict';

import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyGrokProviderEnvironment,
  buildTmuxWorkerShellCommand,
  isGrokWorkerEnvironment,
  launchSessionCli,
  resolveGrokWorkerScriptPath,
  resolveWorkerKind,
} from './session-worker-launch-service.mjs';

test('applyGrokProviderEnvironment sets the worker kind and model when enabled', () => {
  const env = applyGrokProviderEnvironment({ PATH: '/bin' }, { enabled: true, model: 'grok-4.5' });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'grok');
  assert.equal(env.GROK_RELAY_MODEL, 'grok-4.5');
  assert.equal(env.PATH, '/bin');
  assert.equal(isGrokWorkerEnvironment(env), true);
  assert.equal(resolveWorkerKind(env), 'grok');
});

test('applyGrokProviderEnvironment clears grok keys when disabled', () => {
  const env = applyGrokProviderEnvironment({
    COPILOT_WEB_RELAY_WORKER_KIND: 'grok',
    GROK_RELAY_MODEL: 'grok-4.5',
    GROK_CLI_COMMAND: 'grok',
    PATH: '/bin',
  });
  assert.equal('COPILOT_WEB_RELAY_WORKER_KIND' in env, false);
  assert.equal('GROK_RELAY_MODEL' in env, false);
  assert.equal('GROK_CLI_COMMAND' in env, false);
  assert.equal(isGrokWorkerEnvironment(env), false);
});

test('resolveGrokWorkerScriptPath prefers explicit path, then repo root, then server dir', () => {
  assert.equal(
    resolveGrokWorkerScriptPath({ COPILOT_WEB_RELAY_GROK_WORKER_PATH: '/custom/worker.mjs' }),
    '/custom/worker.mjs',
  );
  assert.equal(
    resolveGrokWorkerScriptPath({ COPILOT_WEB_RELAY_ROOT: '/repo' }),
    path.join('/repo', 'server', 'grok-worker', 'grok-session-worker.mjs'),
  );
  assert.equal(
    resolveGrokWorkerScriptPath({ COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server' }),
    path.join('/repo/server', 'grok-worker', 'grok-session-worker.mjs'),
  );
});

test('tmux shell command for grok workers runs node without the script PTY wrapper', () => {
  const env = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'grok',
    GROK_RELAY_MODEL: 'grok-4.5',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
  };
  const command = buildTmuxWorkerShellCommand('session-1', env);
  const workerScript = path.join('/repo', 'server', 'grok-worker', 'grok-session-worker.mjs')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(command, new RegExp(`exec 'node' '${workerScript}' --session-id 'session-1'$`));
  assert.doesNotMatch(command, /script -q/);
  assert.match(command, /export COPILOT_WEB_RELAY_WORKER_KIND='grok';/);
  assert.match(command, /export GROK_RELAY_MODEL='grok-4.5';/);
});

test('launchSessionCli spawns node for grok workers when tmux is unavailable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'session-3',
    cwd: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'grok',
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
    path.join('/repo', 'server', 'grok-worker', 'grok-session-worker.mjs'),
    '--session-id',
    'session-3',
  ]);
});
