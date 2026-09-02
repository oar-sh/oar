'use strict';

import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCopilotSdkProviderEnvironment,
  applyOpenAIProviderEnvironment,
  buildTmuxWorkerShellCommand,
  copilotSdkEngineUnavailableReason,
  isCopilotSdkWorkerEnvironment,
  launchSessionCli,
  resolveCopilotSdkWorkerScriptPath,
  resolveWorkerKind,
} from './session-worker-launch-service.mjs';

const SDK_PATH = '/home/u/.cache/copilot/pkg/linux-x64/1.0.82/copilot-sdk';

test('resolveWorkerKind accepts every registered node worker and nothing else', () => {
  // Validated against the descriptor table rather than a parallel list of
  // names, so adding a worker cannot leave it silently routed to the CLI.
  for (const kind of ['claude', 'cursor', 'grok', 'copilot-sdk']) {
    assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: kind }), kind);
    assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: ` ${kind.toUpperCase()} ` }), kind);
  }
  // The extension engine is the ABSENCE of a kind, and so is any typo.
  assert.equal(resolveWorkerKind({}), 'copilot');
  assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: 'copilot' }), 'copilot');
  assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdkk' }), 'copilot');
  // Inherited Object.prototype keys are not worker kinds.
  assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: 'constructor' }), 'copilot');
});

test('the SDK engine is refused when its preconditions are not met', () => {
  // Saving this engine when it cannot run is a silent no-op with a UI asserting
  // the opposite, so both refusals name what to do about them.
  const noSdk = copilotSdkEngineUnavailableReason({ env: { PATH: '/bin' }, routingEnabled: true });
  assert.match(noSdk, /COPILOT_SDK_PATH/);
  // The launch environment is snapshotted at boot, so "install the CLI and
  // re-save" is not enough — the message has to say so.
  assert.match(noSdk, /restart the relay/i);

  const noRouting = copilotSdkEngineUnavailableReason({
    env: { COPILOT_SDK_PATH: SDK_PATH },
    routingEnabled: false,
  });
  assert.match(noRouting, /SESSION_WORKER_ROUTING_ENABLED/);

  // Missing SDK is reported first: it is the one the user can fix.
  assert.match(
    copilotSdkEngineUnavailableReason({ env: {}, routingEnabled: false }),
    /COPILOT_SDK_PATH/,
  );
  // Defaults are the refusing ones — a caller that forgets to thread context
  // must not accidentally green-light the engine.
  assert.ok(copilotSdkEngineUnavailableReason());
});

test('the SDK engine is available once the path resolved and routing is on', () => {
  assert.equal(
    copilotSdkEngineUnavailableReason({
      env: { COPILOT_SDK_PATH: SDK_PATH },
      routingEnabled: true,
    }),
    null,
  );
});

test('applyCopilotSdkProviderEnvironment sets the worker kind and model when enabled', () => {
  const env = applyCopilotSdkProviderEnvironment(
    { PATH: '/bin', COPILOT_SDK_PATH: SDK_PATH },
    { enabled: true, model: 'gpt-5.4-mini' },
  );
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'copilot-sdk');
  assert.equal(env.COPILOT_RELAY_MODEL, 'gpt-5.4-mini');
  assert.equal(env.PATH, '/bin');
  assert.equal(isCopilotSdkWorkerEnvironment(env), true);
  assert.equal(resolveWorkerKind(env), 'copilot-sdk');
});

test('applyCopilotSdkProviderEnvironment clears its own keys when disabled', () => {
  const env = applyCopilotSdkProviderEnvironment({
    COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk',
    COPILOT_RELAY_MODEL: 'gpt-5.4-mini',
    COPILOT_SDK_PATH: SDK_PATH,
    PATH: '/bin',
  });
  assert.equal('COPILOT_WEB_RELAY_WORKER_KIND' in env, false);
  assert.equal('COPILOT_RELAY_MODEL' in env, false);
  // The SDK path is not this applier's to clear: it is resolved once for every
  // session and the extension engine needs it too.
  assert.equal(env.COPILOT_SDK_PATH, SDK_PATH);
  assert.equal(isCopilotSdkWorkerEnvironment(env), false);
});

test('the disabled clear leaves another provider\'s worker kind alone', () => {
  // The clear chain runs every applier back to back, so each one may only
  // delete the kind it owns.
  const env = applyCopilotSdkProviderEnvironment({ COPILOT_WEB_RELAY_WORKER_KIND: 'claude' });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'claude');
});

test('enabling without a resolved SDK path fails loudly instead of spawning', () => {
  assert.throws(
    () => applyCopilotSdkProviderEnvironment({ PATH: '/bin' }, { enabled: true }),
    /copilot-sdk-path-not-resolved/,
  );
});

test('the SDK engine composes on top of the OpenAI BYOK environment', () => {
  // One OpenAI configuration drives both engines: the OpenAI applier owns the
  // COPILOT_PROVIDER_* family and the engine applier only adds the kind.
  const byok = applyOpenAIProviderEnvironment({ COPILOT_SDK_PATH: SDK_PATH }, {
    enabled: true,
    apiKey: 'sk-test',
    model: 'gpt-5.4-mini',
  });
  const env = applyCopilotSdkProviderEnvironment(byok, { enabled: true, model: 'gpt-5.4-mini' });
  assert.equal(env.COPILOT_WEB_RELAY_WORKER_KIND, 'copilot-sdk');
  assert.equal(env.COPILOT_PROVIDER_TYPE, 'openai');
  assert.equal(env.COPILOT_PROVIDER_API_KEY, 'sk-test');
  assert.equal(env.COPILOT_PROVIDER_WIRE_API, 'responses');
  assert.equal(env.COPILOT_MODEL, 'gpt-5.4-mini');
});

test('resolveCopilotSdkWorkerScriptPath prefers explicit path, then repo root, then server dir', () => {
  assert.equal(
    resolveCopilotSdkWorkerScriptPath({ COPILOT_WEB_RELAY_COPILOT_SDK_WORKER_PATH: '/custom/worker.mjs' }),
    '/custom/worker.mjs',
  );
  assert.equal(
    resolveCopilotSdkWorkerScriptPath({ COPILOT_WEB_RELAY_ROOT: '/repo' }),
    path.join('/repo', 'server', 'copilot-worker', 'copilot-sdk-session-worker.mjs'),
  );
  assert.equal(
    resolveCopilotSdkWorkerScriptPath({ COPILOT_WEB_RELAY_SERVER_DIR: '/repo/server' }),
    path.join('/repo/server', 'copilot-worker', 'copilot-sdk-session-worker.mjs'),
  );
});

test('tmux shell command for the SDK engine runs node without the script PTY wrapper', () => {
  const env = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk',
    COPILOT_RELAY_MODEL: 'gpt-5.4-mini',
    COPILOT_SDK_PATH: SDK_PATH,
    COPILOT_WEB_RELAY_CLI_EXECUTABLE: '/usr/lib/copilot/copilot',
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_WEB_RELAY_CONFIG: '/repo/server/config.json',
  };
  const command = buildTmuxWorkerShellCommand('session-1', env);
  const workerScript = path.join('/repo', 'server', 'copilot-worker', 'copilot-sdk-session-worker.mjs')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(command, new RegExp(`exec 'node' '${workerScript}' --session-id 'session-1'$`));
  assert.doesNotMatch(command, /script -q/);
  assert.match(command, /export COPILOT_WEB_RELAY_WORKER_KIND='copilot-sdk';/);
  // The one path the worker needs has to survive the tmux allowlist; it
  // derives the runtime entry point from this bundle's version directory.
  assert.match(command, /export COPILOT_SDK_PATH=/);
  // Without this the model would silently drop to the runtime default under
  // tmux while working on the detached path.
  assert.match(command, /export COPILOT_RELAY_MODEL='gpt-5.4-mini';/);
});

test('the BYOK api key never reaches the tmux command line', () => {
  const env = {
    COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk',
    COPILOT_SDK_PATH: SDK_PATH,
    COPILOT_WEB_RELAY_ROOT: '/repo',
    COPILOT_PROVIDER_TYPE: 'openai',
    COPILOT_PROVIDER_API_KEY: 'sk-secret',
  };
  // The secret must ride the 0600 env file, exactly as on the extension path.
  assert.throws(() => buildTmuxWorkerShellCommand('session-1', env), /worker-secret-env-file-required/);
  const command = buildTmuxWorkerShellCommand('session-1', env, { secretEnvFilePath: '/tmp/x/provider.env' });
  assert.doesNotMatch(command, /sk-secret/);
  assert.match(command, /export COPILOT_PROVIDER_TYPE='openai';/);
});

test('launchSessionCli spawns node for the SDK engine when tmux is unavailable', async () => {
  const spawnCalls = [];
  const launched = await launchSessionCli({
    targetSessionId: 'session-3',
    cwd: '/workspace',
    env: {
      COPILOT_WEB_RELAY_WORKER_KIND: 'copilot-sdk',
      COPILOT_WEB_RELAY_ROOT: '/repo',
      COPILOT_SDK_PATH: SDK_PATH,
    },
    platform: 'linux',
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { pid: 4343, unref: () => {} };
    },
    execFileSyncImpl: () => { throw new Error('tmux missing'); },
    processInspector: { findProcessForSession: () => null },
    allowProcessReuse: false,
  });
  assert.equal(launched.pid, 4343);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, 'node');
  assert.deepEqual(spawnCalls[0].args, [
    path.join('/repo', 'server', 'copilot-worker', 'copilot-sdk-session-worker.mjs'),
    '--session-id',
    'session-3',
  ]);
});
