// OAR's session options against the real Copilot SDK bundles cached on this
// machine: a real `CopilotClient`, with its connection replaced by an
// in-process fake that records what would go over the wire. Nothing is
// spawned and no model is called.
//
// Skipped where no bundle is cached (CI). It leans on SDK internals
// (`client.connection`, `startPromise`, `session._dispatchEvent`); when they
// change the test fails rather than skips, so a dev box learns about it the
// day a new Copilot CLI lands.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertSupportedCopilotSdk,
  buildCopilotClientOptions,
  buildInstalledCopilotClientOptions,
  COPILOT_SDK_MIN_VERSION,
  COPILOT_SDK_TOO_OLD,
  copilotSessionOptions,
  getCopilotBaseDirs,
} from './copilot-sdk-runtime.mjs';
import { resolveByokSession } from './copilot-worker/copilot-byok-provider.mjs';

const parts = (version) => version.split('.').map(Number);
const compare = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Every cached bundle, `{ version, sdkPath }`, newest first. */
function cachedBundles() {
  const found = new Map();
  for (const baseDir of getCopilotBaseDirs()) {
    let versions = [];
    const dir = path.join(baseDir, `${process.platform}-${process.arch}`); // host-platform: this host's cached bundles are under test
    try { versions = fs.readdirSync(dir); } catch { continue; }
    for (const version of versions) {
      const sdkPath = path.join(dir, version, 'copilot-sdk', 'index.js');
      if (/^\d+\.\d+\.\d+$/.test(version) && !found.has(version) && fs.existsSync(sdkPath)) {
        found.set(version, { version, sdkPath });
      }
    }
  }
  return [...found.values()].sort((a, b) => compare(b.version, a.version));
}

const bundles = cachedBundles();
const newest = bundles[0] || null;
const newestOld = bundles.find((bundle) => compare(bundle.version, COPILOT_SDK_MIN_VERSION) < 0) || null;
const supported = newest && compare(newest.version, COPILOT_SDK_MIN_VERSION) >= 0 ? newest : null;

const importBundle = (bundle) => import(pathToFileURL(bundle.sdkPath).href);

// A real client whose connection is a recorder: `session.create` and
// `session.resume` answer with the session id, anything else with `{}`.
function recordingClient(sdk, options) {
  const client = new sdk.CopilotClient(options);
  assert.equal(client.startPromise, null, 'a client that is not started has no startPromise');
  const requests = [];
  client.connection = {
    async sendRequest(method, params) {
      requests.push({ method, params });
      return method === 'session.create' || method === 'session.resume' ? { sessionId: params?.sessionId } : {};
    },
    onNotification() {},
    onRequest() {},
    onClose() {},
    onError() {},
    listen() {},
    dispose() {},
  };
  const sent = (method) => {
    const found = requests.filter((request) => request.method === method);
    assert.equal(found.length, 1, `exactly one ${method} request`);
    return found[0].params;
  };
  return { client, requests, sent };
}

function workerClient(sdk, version) {
  return recordingClient(sdk, buildCopilotClientOptions(sdk, {
    runtimeEntry: path.join(path.sep, 'nonexistent', 'app.js'),
    cwd: path.join(path.sep, 'tmp'),
    version,
  }));
}

// OAR's flat session config, shaped as `buildSessionConfig` shapes it.
function flatSessionConfig(sessionId, received) {
  return {
    sessionId,
    model: 'gpt-x',
    workingDirectory: path.join(path.sep, 'tmp'),
    clientName: 'copilot-web-relay',
    streaming: true,
    infiniteSessions: { enabled: true },
    onEvent: (event) => received.push(event),
    tools: [
      { name: 'ask_user', description: 'Ask the user', parameters: { type: 'object', properties: {} }, overridesBuiltInTool: true, handler: () => '' },
      { name: 'relay_tool', description: 'Relay', parameters: { type: 'object', properties: {} }, handler: () => '' },
    ],
    onPermissionRequest: async () => ({ kind: 'approve-once' }),
    onUserInputRequest: async () => ({ answer: '', wasFreeform: true }),
    onExitPlanModeRequest: async () => ({ approved: false }),
    onElicitationRequest: async () => ({ action: 'decline' }),
  };
}

// What of OAR's handlers and options a `session.create` request carries.
function wireCoverage(params) {
  return {
    streaming: params?.events?.streaming === true,
    permissions: params?.permissions?.request === true,
    userInput: params?.interaction?.requestUserInput === true,
    elicitation: params?.interaction?.requestElicitation === true,
    exitPlanMode: params?.interaction?.requestExitPlanMode === true,
    tools: (params?.tools?.definitions || []).map((tool) => tool.name).join(',') === 'ask_user,relay_tool',
    infiniteSessions: params?.state?.infiniteSessions?.enabled === true,
  };
}

test('the grouped session options reach the wire of the newest cached SDK', async (t) => {
  if (!newest) return t.skip('no Copilot SDK bundle cached');
  if (!supported) return t.skip(`the newest cached Copilot SDK (${newest.version}) is older than ${COPILOT_SDK_MIN_VERSION}`);
  t.diagnostic(`Copilot SDK ${supported.version}: ${supported.sdkPath}`);
  const sdk = await importBundle(supported);
  assert.equal(assertSupportedCopilotSdk(sdk, supported.version), undefined);
  const { client, sent } = workerClient(sdk, supported.version);
  const received = [];
  const session = await client.createSession(copilotSessionOptions(flatSessionConfig('real-bundle-create', received)));

  const params = sent('session.create');
  assert.deepEqual(wireCoverage(params), {
    streaming: true,
    permissions: true,
    userInput: true,
    elicitation: true,
    exitPlanMode: true,
    tools: true,
    infiniteSessions: true,
  });
  assert.equal(params.sessionId, 'real-bundle-create');
  assert.equal(params.model, 'gpt-x');
  assert.equal(params.clientName, 'copilot-web-relay');
  assert.equal(params.workingDirectory, path.join(path.sep, 'tmp'));
  // The relay's ask_user still overrides the built-in one.
  assert.equal(params.tools.definitions.find((tool) => tool.name === 'ask_user').overridesBuiltInTool, true);

  // A runtime event reaches OAR's onEvent.
  const event = { id: 'real-bundle-event', type: 'session.idle', timestamp: new Date(0).toISOString(), data: {} };
  session._dispatchEvent(event);
  assert.deepEqual(received.map((entry) => entry.id), ['real-bundle-event']);
});

test('a BYOK session sends its inference block to the newest cached SDK', async (t) => {
  if (!supported) return t.skip('no Copilot SDK bundle of 1.0.113 or later cached');
  const sdk = await importBundle(supported);
  const { client, sent } = workerClient(sdk, supported.version);
  const byok = resolveByokSession({
    env: { COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'test-key', COPILOT_PROVIDER_BASE_URL: 'https://example.test/v1' },
    model: 'gpt-4o',
    reasoningEffort: 'high',
  });
  await client.createSession(copilotSessionOptions({ ...flatSessionConfig('real-bundle-byok', []), model: 'gpt-4o', ...byok.options }));

  const params = sent('session.create');
  assert.equal(wireCoverage(params).permissions, true);
  assert.equal(params.inference.defaultProvider, 'openai');
  assert.equal(params.inference.reasoningEffort, 'high');
  assert.deepEqual(params.inference.providers.map((provider) => [provider.name, provider.baseUrl]), [['openai', 'https://example.test/v1']]);
  assert.deepEqual(params.inference.models.map((model) => [model.id, model.provider]), [['gpt-4o', 'openai']]);
  assert.equal(params.inference.models[0].maxPromptTokens, byok.provider.maxPromptTokens);
});

test('the session import resume in empty mode is accepted by the newest cached SDK', async (t) => {
  if (!supported) return t.skip('no Copilot SDK bundle of 1.0.113 or later cached');
  const sdk = await importBundle(supported);
  const { client, sent } = recordingClient(sdk, buildInstalledCopilotClientOptions(sdk, {
    cliPath: path.join(path.sep, 'nonexistent', 'app.js'),
    cwd: path.join(path.sep, 'tmp'),
    baseDirectory: path.join(path.sep, 'nonexistent', '.copilot'),
    version: supported.version,
  }));
  await client.resumeSession('real-bundle-import', copilotSessionOptions({ suppressResumeEvent: true, availableTools: [] }));
  const params = sent('session.resume');
  assert.deepEqual(params.tools?.availableTools, []);
  assert.equal(params.suppressResumeEvent, true);
});

test('the newest cached SDK older than 1.0.113 is refused with the update hint', async (t) => {
  if (!newestOld) return t.skip(`no Copilot SDK bundle older than ${COPILOT_SDK_MIN_VERSION} cached`);
  t.diagnostic(`Copilot SDK ${newestOld.version}: ${newestOld.sdkPath}`);
  const sdk = await importBundle(newestOld);
  assert.throws(() => assertSupportedCopilotSdk(sdk, newestOld.version), (error) => {
    assert.equal(error.code, COPILOT_SDK_TOO_OLD);
    assert.match(error.message, new RegExp(`Copilot SDK ${newestOld.version.replace(/\./g, '\\.')} is older than 1\\.0\\.113`));
    assert.match(error.message, /Update the Copilot CLI/);
    return true;
  });
});

// The control: OAR's flat config sent untranslated, to see what the SDK
// itself would do with it. 1.0.114 still maps the flat names (a compatibility
// table it calls private); 1.0.113 has no such table and drops them.
test('control: the flat config sent untranslated to the newest cached SDK', async (t) => {
  if (!supported) return t.skip('no Copilot SDK bundle of 1.0.113 or later cached');
  const sdk = await importBundle(supported);
  const { client, sent } = workerClient(sdk, supported.version);
  const received = [];
  const session = await client.createSession(flatSessionConfig('real-bundle-flat', received));
  session._dispatchEvent({ id: 'flat-event', type: 'session.idle', timestamp: new Date(0).toISOString(), data: {} });
  const coverage = { ...wireCoverage(sent('session.create')), onEvent: received.length === 1 };
  const lost = Object.entries(coverage).filter(([, kept]) => !kept).map(([name]) => name);
  t.diagnostic(`Copilot SDK ${supported.version}, flat config: ${lost.length ? `lost ${lost.join(', ')}` : 'nothing lost'}`);
  // Each option either survives or not; known versions are pinned.
  if (supported.version === '1.0.114') assert.deepEqual(lost, []);
  if (supported.version === '1.0.113') assert.deepEqual(lost, Object.keys(coverage));

  // The import's flat resume in empty mode.
  const importer = recordingClient(sdk, buildInstalledCopilotClientOptions(sdk, {
    cliPath: path.join(path.sep, 'nonexistent', 'app.js'),
    baseDirectory: path.join(path.sep, 'nonexistent', '.copilot'),
    version: supported.version,
  }));
  let failure = null;
  try {
    await importer.client.resumeSession('real-bundle-flat-import', { suppressResumeEvent: true, availableTools: [] });
  } catch (error) {
    failure = error;
  }
  t.diagnostic(`Copilot SDK ${supported.version}, flat import resume: ${failure ? `throws: ${failure.message}` : 'accepted'}`);
  if (supported.version === '1.0.114') assert.equal(failure, null);
  if (supported.version === '1.0.113') assert.match(String(failure?.message), /availableTools/);
});
