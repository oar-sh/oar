import test from 'node:test';
import assert from 'node:assert/strict';

import { COPILOT_SWITCHED_OFF_LAUNCH, launchWorkspaceRootSession } from './sessions-helpers.mjs';
import { registerHostRoutes } from './host-routes.mjs';
import { captureRoutes, invokeRoute } from './messages-routes-test-harness.mjs';

// The explicit launch (POST /api/session-worker/:id/launch, and the working
// directory relaunch) starts no Copilot worker while Copilot is switched off:
// the runtime's failCopilotRowsWithoutLaunch fails the session's rows with the
// switch's note and answers true, and the launch is refused with
// COPILOT_SWITCHED_OFF. Other chats launch as before.

function supervisor() {
  const ensured = [];
  return {
    ensured,
    getWorkerState: () => null,
    clearRestartSchedule() {},
    ensureWorker: async (sid) => { ensured.push(sid); return { ok: true, worker: { sdkSessionId: sid } }; },
  };
}

test('a Copilot session while Copilot is off: refused with COPILOT_SWITCHED_OFF, no worker', async () => {
  const sup = supervisor();
  const checked = [];
  const result = await launchWorkspaceRootSession({}, sup, 'sid-copilot', null, {
    failCopilotRowsWithoutLaunch: (sid) => { checked.push(sid); return true; },
  });
  assert.deepEqual(result, { ok: false, statusCode: 409, code: 'COPILOT_SWITCHED_OFF', error: COPILOT_SWITCHED_OFF_LAUNCH.error });
  assert.deepEqual(checked, ['sid-copilot']);
  assert.deepEqual(sup.ensured, []);
});

test('an OpenAI, Claude or Claude API session (the check answers false), or no check: launched as before', async () => {
  for (const options of [{ failCopilotRowsWithoutLaunch: () => false }, {}]) {
    const sup = supervisor();
    const result = await launchWorkspaceRootSession({}, sup, 'sid-other', null, options);
    assert.equal(result.ok, true);
    assert.deepEqual(sup.ensured, ['sid-other']);
  }
});

test('POST /api/session-worker/:id/launch answers the refusal and its code', async () => {
  const sup = supervisor();
  const routes = captureRoutes({
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    runtimeState: {},
    sessionWorkerSupervisor: sup,
    sessionWorkerRegistry: null,
    failCopilotRowsWithoutLaunch: (sid) => sid === 'sid-copilot',
  }, (app, deps) => registerHostRoutes(app, deps, {}));
  const refused = await invokeRoute(routes, 'POST', '/api/session-worker/:sdkSessionId/launch', { params: { sdkSessionId: 'sid-copilot' } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'COPILOT_SWITCHED_OFF');
  assert.match(refused.body.error, /^Copilot is switched off on this relay, so no Copilot worker was started\./);
  assert.deepEqual(sup.ensured, []);
  const launched = await invokeRoute(routes, 'POST', '/api/session-worker/:sdkSessionId/launch', { params: { sdkSessionId: 'sid-openai' } });
  assert.equal(launched.status, 200);
  assert.deepEqual(sup.ensured, ['sid-openai']);
});

test('the working-directory relaunch passes the same check to the launch', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('./conversation-settings-routes.mjs', import.meta.url), 'utf8');
  assert.match(source, /requireStoppedWorker: false,\n\s+failCopilotRowsWithoutLaunch: deps\.failCopilotRowsWithoutLaunch,/);
  assert.match(source, /code: launched\?\.code \|\| 'relaunch-failed',/);
});
