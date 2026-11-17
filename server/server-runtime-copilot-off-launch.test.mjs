import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createSessionWorkerRegistry } from './services/session-worker-registry-service.mjs';
import { createSessionWorkerSupervisor } from './services/session-worker-supervisor-service.mjs';

// Copilot switched off between the check where a message is taken (or a
// prime's) and the worker launch: the launch itself checks the switch, so no
// path starts a Copilot worker while it is off. The runtime boots a live
// server on import, so its side is read from its source, as the other
// server-runtime-*.test.mjs do.
const source = fs.readFileSync(fileURLToPath(new URL('./server-runtime.mjs', import.meta.url)), 'utf8');

function sliceFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `${name} is defined`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

const LAUNCH_CHECK = "if (failCopilotRowsWithoutLaunch(normalizedTargetSessionId)) return { deferred: 'COPILOT_SWITCHED_OFF' };";

test('the worker launch checks the Copilot switch, after the reuse of a live worker and before anything starts', () => {
  const spawn = sliceFunction('spawnSessionWorkerCli');
  const check = spawn.indexOf(LAUNCH_CHECK);
  assert.ok(check > 0, 'the launch checks the switch');
  // A live worker is reused (nothing starts); a test relay starts nothing.
  assert.ok(check > spawn.indexOf("if (listed === 'worker') {"));
  assert.ok(check > spawn.indexOf('return deferLaunchWhileCliSpawnDisabled(normalizedTargetSessionId);'));
  // Before the agent SDK gate (which can lease a folder) and the launch.
  assert.ok(check < spawn.indexOf('agentSdkLaunchGate.check('));
  assert.ok(check < spawn.indexOf('await launchSessionCli({'));
});

test('every worker launch goes through that check: the supervisor\'s spawnWorker is the only launcher', () => {
  assert.equal(source.match(/launchSessionCli\(\{/g).length, 1, 'one launch, inside spawnSessionWorkerCli');
  assert.ok(sliceFunction('spawnSessionWorkerCli').includes('await launchSessionCli({'));
  const callers = source.match(/spawnSessionWorkerCli\(/g).length;
  assert.equal(callers, 2, 'its definition and the supervisor\'s spawnWorker');
  assert.match(source, /spawnWorker: async \(sdkSessionId, options = \{\}\) => spawnSessionWorkerCli\(sdkSessionId, options\),/);
});

test('a worker replacement (recycle, billing swap) is refused its launch for a Copilot chat while Copilot is off', () => {
  const replacement = sliceFunction('createRuntimeWorkerReplacement');
  assert.match(replacement, /refuseLaunch: \(sid\) => \(failCopilotRowsWithoutLaunch\(sid\) \? 'COPILOT_SWITCHED_OFF' : null\),/);
  // Both replacements are made by it.
  assert.match(source, /const billingSwapWorkerReplacement = createRuntimeWorkerReplacement\('BILLING SWAP'\);/);
  assert.match(source, /const recycleWorkerReplacement = createRuntimeWorkerReplacement\('WORKER RECYCLE'\);/);
});

test('the supervisor takes the launch\'s refusal as no worker and no failure: no restart backoff, no launch note', async () => {
  const sid = 'sid-copilot-off-launch';
  const registry = createSessionWorkerRegistry();
  const launchStates = [];
  const supervisor = createSessionWorkerSupervisor({
    registry,
    spawnWorker: async () => ({ deferred: 'COPILOT_SWITCHED_OFF' }),
    onLaunchState: (event) => launchStates.push(event.type),
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
    isPidAlive: () => false,
    log: () => {},
  });
  const result = await supervisor.ensureWorker(sid);
  assert.equal(result.ok, true);
  assert.equal(result.deferred, 'COPILOT_SWITCHED_OFF');
  assert.equal(registry.getWorker(sid).status, 'new');
  assert.equal(registry.getWorker(sid).pid, null);
  const lifecycle = supervisor.getLifecycleState(sid);
  assert.equal(lifecycle.retryCount || 0, 0);
  assert.equal(lifecycle.nextRestartAt ?? null, null);
  assert.deepEqual(launchStates, []);
});
