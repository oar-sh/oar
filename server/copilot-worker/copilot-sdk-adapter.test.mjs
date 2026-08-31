import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  buildRuntimeConnection,
  classifyCopilotSessionError,
  classifyCopilotTurnException,
  copilotAgentModeForRelayMode,
  copilotPermissionDecision,
  describeVersionSkew,
  isCopilotQuotaError,
  isReadOnlyPermissionRequest,
  isSessionNotFoundError,
  observeRuntimeExit,
  readRuntimeVersion,
  resolveCopilotSdkPaths,
  startCopilotClient,
} from './copilot-sdk-adapter.mjs';
import { loadFixture } from './copilot-sdk-test-harness.mjs';

const SDK_DIR = path.join('/opt', 'copilot', 'pkg', 'linux-x64', '1.0.82', 'copilot-sdk');

test('the runtime is derived from the SDK bundle, never from PATH', () => {
  const paths = resolveCopilotSdkPaths({ env: { COPILOT_SDK_PATH: SDK_DIR } });
  assert.equal(paths.sdkEntry, path.join(SDK_DIR, 'index.js'));
  // Same version directory as the SDK: the npm-loader `copilot` binary was
  // observed running 1.0.78 against a 1.0.82 SDK bundle.
  // `app.js`, never the sibling `index.js`: that is a self-updating launcher
  // which resolves the NEWEST cached version and execs that one instead,
  // silently defeating the version pin.
  assert.equal(paths.runtimeEntry, path.join('/opt', 'copilot', 'pkg', 'linux-x64', '1.0.82', 'app.js'));
  assert.equal(paths.version, '1.0.82');
});

test('a COPILOT_SDK_PATH pointing at index.js resolves the same way', () => {
  const paths = resolveCopilotSdkPaths({ env: { COPILOT_SDK_PATH: path.join(SDK_DIR, 'index.js') } });
  assert.equal(paths.sdkDir, SDK_DIR);
  assert.equal(paths.runtimeEntry, path.join('/opt', 'copilot', 'pkg', 'linux-x64', '1.0.82', 'app.js'));
});

test('an unparseable version directory yields an empty version rather than a bad one', () => {
  const paths = resolveCopilotSdkPaths({ env: { COPILOT_SDK_PATH: '/custom/build/copilot-sdk' } });
  assert.equal(paths.version, '');
  assert.equal(paths.runtimeEntry, path.join('/custom', 'build', 'app.js'));
});

test('a missing COPILOT_SDK_PATH fails with an install pointer', () => {
  assert.throws(
    () => resolveCopilotSdkPaths({ env: {} }),
    /COPILOT_SDK_PATH is not set.*Copilot CLI/s,
  );
});

test('describeVersionSkew only warns on a real disagreement', () => {
  assert.equal(describeVersionSkew({ bundleVersion: '1.0.82', runtimeVersion: '1.0.82' }), null);
  assert.equal(describeVersionSkew({ bundleVersion: '1.0.82', runtimeVersion: '' }), null);
  assert.equal(describeVersionSkew({ bundleVersion: '', runtimeVersion: '1.0.78' }), null);
  const warning = describeVersionSkew({ bundleVersion: '1.0.82', runtimeVersion: '1.0.78' });
  assert.match(warning, /version skew.*1\.0\.82.*1\.0\.78/s);
});

test('startCopilotClient pins the runtime to the SDK bundle and reports skew', async () => {
  const constructed = [];
  let started = 0;
  class FakeCopilotClient {
    constructor(options) {
      constructed.push(options);
    }

    async start() { started += 1; }

    async getStatus() { return { version: '1.0.78' }; }
  }
  const result = await startCopilotClient({
    paths: resolveCopilotSdkPaths({ env: { COPILOT_SDK_PATH: SDK_DIR } }),
    cwd: '/tmp/relay-fixture-workspace',
    importImpl: async (href) => {
      assert.match(href, /^file:\/\/.*copilot-sdk\/index\.js$/);
      return { CopilotClient: FakeCopilotClient };
    },
  });
  assert.equal(started, 1);
  assert.equal(constructed[0].connection.kind, 'stdio');
  assert.equal(constructed[0].connection.path, path.join('/opt', 'copilot', 'pkg', 'linux-x64', '1.0.82', 'app.js'));
  assert.equal(constructed[0].workingDirectory, '/tmp/relay-fixture-workspace');
  const version = await result.versionReady;
  assert.equal(version.runtimeVersion, '1.0.78');
  assert.match(version.versionSkewWarning, /version skew/);
});

test('the version probe never blocks the first turn on an RPC round trip', async () => {
  let releaseStatus = null;
  const slow = new Promise((resolve) => { releaseStatus = resolve; });
  class FakeCopilotClient {
    async start() {}

    async getStatus() { await slow; return { version: '1.0.82' }; }
  }
  const result = await startCopilotClient({
    paths: resolveCopilotSdkPaths({ env: { COPILOT_SDK_PATH: SDK_DIR } }),
    importImpl: async () => ({ CopilotClient: FakeCopilotClient }),
  });
  // The client is usable while `getStatus` is still in flight — a diagnostic
  // must never gate readiness.
  assert.ok(result.client);
  releaseStatus();
  assert.equal((await result.versionReady).versionSkewWarning, null);
});

test('startCopilotClient prefers RuntimeConnection.forStdio when the SDK exports it', async () => {
  const sdk = {
    CopilotClient: class { async start() {} },
    RuntimeConnection: { forStdio: (options) => ({ tag: 'forStdio', ...options }) },
  };
  assert.deepEqual(buildRuntimeConnection(sdk, '/runtime/index.js'), { tag: 'forStdio', path: '/runtime/index.js' });
  assert.deepEqual(buildRuntimeConnection({}, '/runtime/index.js'), { kind: 'stdio', path: '/runtime/index.js' });
});

test('startCopilotClient fails loudly when the bundle has no CopilotClient', async () => {
  await assert.rejects(
    startCopilotClient({
      paths: resolveCopilotSdkPaths({ env: { COPILOT_SDK_PATH: SDK_DIR } }),
      importImpl: async () => ({}),
    }),
    /CopilotClient not found/,
  );
});

test('an unavailable or throwing getStatus degrades to an unknown version', async () => {
  assert.equal(await readRuntimeVersion({}), '');
  const logged = [];
  assert.equal(
    await readRuntimeVersion({ getStatus: async () => { throw new Error('no such rpc'); } }, (...p) => logged.push(p)),
    '',
  );
  assert.equal(logged.length, 1);
});

test('every structured quota signal is recognised on its own', () => {
  assert.equal(isCopilotQuotaError({ errorCode: 'quota_exceeded' }), true);
  assert.equal(isCopilotQuotaError({ errorType: 'quota' }), true);
  assert.equal(isCopilotQuotaError({ statusCode: 402 }), true);
  assert.equal(isCopilotQuotaError({ message: 'You have exceeded your monthly quota' }), true);
  assert.equal(isCopilotQuotaError({ statusCode: 500, message: 'internal error' }), false);
  assert.equal(isCopilotQuotaError(null), false);
});

test('the live quota event classifies as relay.quota-exhausted with the extension wording', () => {
  const error = loadFixture('quota-turn').find((event) => event.type === 'session.error');
  const classified = classifyCopilotSessionError(error.data);

  assert.equal(classified.quota, true);
  assert.equal(classified.code, 'quota-exhausted');
  assert.equal(classified.stableCode, 'relay.quota-exhausted');
  // Byte-identical to what the extension engine publishes (37d2899), so a
  // conversation reads the same however it was run.
  assert.match(classified.text, /GitHub Copilot has no AI credits left for this billing window/);
  assert.match(classified.text, /Error code: relay\.quota-exhausted\./);
  assert.match(classified.text, /Open Check Usage for the reset time/);
});

test('a 402 whose prose never says "quota" still classifies as quota-exhausted', () => {
  const classified = classifyCopilotSessionError({ statusCode: 402, message: 'Payment required for this model' });
  assert.equal(classified.stableCode, 'relay.quota-exhausted');
  assert.match(classified.text, /no AI credits left/);
});

test('a non-terminal session error gets a provider-scoped stable code', () => {
  const classified = classifyCopilotSessionError({ errorType: 'network', message: 'connection reset' });
  assert.equal(classified.stableCode, 'copilot.network');
  assert.match(classified.text, /the Copilot turn failed \(connection reset\)/);
  assert.equal(classified.quota, false);
});

test('an empty session error still produces a usable record', () => {
  const classified = classifyCopilotSessionError({});
  assert.equal(classified.stableCode, 'copilot.session-error');
  assert.match(classified.text, /reported a session error/);
});

test('thrown auth failures point at signing in on the relay host', () => {
  const classified = classifyCopilotTurnException(new Error('not logged in to GitHub Copilot'));
  assert.equal(classified.code, 'authentication_failed');
  assert.equal(classified.stableCode, 'copilot.authentication_failed');
  assert.match(classified.text, /Run `copilot` on the relay host and sign in/);
});

test('a thrown quota failure gets the same relay stable code as the event', () => {
  const classified = classifyCopilotTurnException(new Error('You have exceeded your monthly quota'));
  assert.equal(classified.stableCode, 'relay.quota-exhausted');
});

test('an unclassifiable throw falls back to copilot.turn-error', () => {
  const classified = classifyCopilotTurnException(new Error('socket hang up'));
  assert.equal(classified.stableCode, 'copilot.turn-error');
  assert.equal(classified.detail, 'socket hang up');
});

test('a quota error is classified structurally, never by forging prose', () => {
  // The regression this guards: the adapter used to append "(quota exceeded)"
  // to the message to trip the prose classifier, and suppressed the nudge when
  // the prose already said "quota" — so the milder wordings ("reached your
  // monthly quota") fell through to RETRYABLE on a bill that cannot reset.
  for (const data of [
    { errorCode: 'quota_exceeded', message: 'You have reached your monthly quota' },
    { errorCode: 'session_quota_exceeded', message: 'This session reached its quota' },
    { errorType: 'quota', message: 'no more requests are available right now' },
    { statusCode: 402, message: 'Payment required for this model' },
  ]) {
    const classified = classifyCopilotSessionError(data);
    assert.equal(classified.stableCode, 'relay.quota-exhausted', JSON.stringify(data));
    assert.equal(classified.quota, true);
    // The user-facing detail is the runtime's real message, unedited.
    assert.equal(classified.detail, data.message);
    assert.match(classified.text, new RegExp(`Details: ${data.message.slice(0, 12)}`));
    assert.doesNotMatch(classified.text, /\(quota exceeded\)/);
  }
});

test('a rate limit is not a quota failure', () => {
  const classified = classifyCopilotSessionError({
    errorType: 'rate_limit',
    errorCode: 'user_global_rate_limited',
    message: 'rate limit exceeded, retry shortly',
  });
  assert.equal(classified.quota, false);
  assert.equal(classified.stableCode, 'copilot.rate-limit');
});

test('auth classification does not fire on ports, request ids, or ordinary prose', () => {
  // `/401/` unanchored matched the port in ECONNREFUSED; `/log in/` matched
  // "backlog in progress". Both told the user to go re-authenticate on the
  // relay host for a problem a retry would have fixed.
  for (const message of [
    'connect ECONNREFUSED 127.0.0.1:40123',
    'backlog in progress, try again',
    'request 40100 failed',
    'catalog information unavailable',
  ]) {
    assert.equal(
      classifyCopilotTurnException(new Error(message)).stableCode,
      'copilot.turn-error',
      message,
    );
  }
});

test('auth classification still fires on the real thing', () => {
  for (const message of [
    'not logged in to GitHub Copilot',
    'Authentication failed for host github.com',
    'HTTP 401 Unauthorized',
    'your credentials are expired',
    'Please sign in to continue',
  ]) {
    assert.equal(
      classifyCopilotTurnException(new Error(message)).stableCode,
      'copilot.authentication_failed',
      message,
    );
  }
  // Structured signals outrank prose entirely.
  assert.equal(
    classifyCopilotTurnException(Object.assign(new Error('request rejected'), { statusCode: 401 })).stableCode,
    'copilot.authentication_failed',
  );
  assert.equal(
    classifyCopilotTurnException(Object.assign(new Error('request rejected'), { errorType: 'authentication' })).stableCode,
    'copilot.authentication_failed',
  );
});

test('only a definitive "no such session" counts as a missing session', () => {
  // Everything else is transient, because guessing wrong means starting a
  // blank session over a live conversation and losing its whole history.
  assert.equal(isSessionNotFoundError(Object.assign(
    new Error('Request session.resume failed with message: Session not found: conv-1'),
    { code: -32603 },
  )), true);
  assert.equal(isSessionNotFoundError(new Error('no such session on disk')), true);
  assert.equal(isSessionNotFoundError(new Error('unknown session conv-1')), true);

  assert.equal(isSessionNotFoundError(Object.assign(
    new Error('Pending response rejected since connection got disposed'),
    { code: -32097 },
  )), false);
  assert.equal(isSessionNotFoundError(Object.assign(new Error('closed'), { name: 'ConnectionError' })), false);
  assert.equal(isSessionNotFoundError(new Error('CLI server exited unexpectedly with code 1')), false);
  assert.equal(isSessionNotFoundError(new Error('')), false);
  assert.equal(isSessionNotFoundError(null), false);
  // A tool result that merely mentions a missing file must not be mistaken
  // for a missing session.
  assert.equal(isSessionNotFoundError(new Error('file not found: session.json')), false);
});

test('read-only permission requests are recognised across the request union', () => {
  assert.equal(isReadOnlyPermissionRequest({ kind: 'read', path: 'a.txt' }), true);
  assert.equal(isReadOnlyPermissionRequest({ kind: 'mcp', readOnly: true, toolName: 'search' }), true);
  assert.equal(isReadOnlyPermissionRequest({ kind: 'custom-tool', readOnly: true }), true);
  assert.equal(isReadOnlyPermissionRequest({
    kind: 'shell',
    commands: [{ identifier: 'ls', readOnly: true }, { identifier: 'cat', readOnly: true }],
  }), true);

  assert.equal(isReadOnlyPermissionRequest({ kind: 'write', fileName: 'a.txt' }), false);
  assert.equal(isReadOnlyPermissionRequest({ kind: 'url', url: 'https://x' }), false);
  assert.equal(isReadOnlyPermissionRequest({ kind: 'mcp', readOnly: false }), false);
  // A mixed shell command is not read-only, and neither is one with no parsed
  // segments at all (no evidence is not evidence of safety).
  assert.equal(isReadOnlyPermissionRequest({
    kind: 'shell',
    commands: [{ identifier: 'ls', readOnly: true }, { identifier: 'rm', readOnly: false }],
  }), false);
  assert.equal(isReadOnlyPermissionRequest({ kind: 'shell', commands: [] }), false);
  assert.equal(isReadOnlyPermissionRequest({ kind: 'shell' }), false);
});

test('the permission decision follows the relay mode', () => {
  const write = { kind: 'write', fileName: 'src/app.js', intention: 'rewrite' };
  const read = { kind: 'read', path: 'src/app.js' };

  for (const mode of ['agent', 'autopilot', '', undefined, 'something-new']) {
    assert.deepEqual(copilotPermissionDecision(mode, write), { kind: 'approve-once' }, String(mode));
  }
  for (const mode of ['plan', 'ask', 'PLAN']) {
    const decision = copilotPermissionDecision(mode, write);
    // Never `allow` — the runtime rejects that variant ("unknown variant
    // `allow`") and silently fails the tool call instead of denying it.
    assert.equal(decision.kind, 'reject', String(mode));
    assert.match(decision.feedback, /src\/app\.js/);
    assert.deepEqual(copilotPermissionDecision(mode, read), { kind: 'approve-once' }, String(mode));
  }
});

test('the relay mode maps onto the runtime agentMode vocabulary', () => {
  assert.equal(copilotAgentModeForRelayMode('plan'), 'plan');
  assert.equal(copilotAgentModeForRelayMode('autopilot'), 'autopilot');
  assert.equal(copilotAgentModeForRelayMode('agent'), 'interactive');
  // `ask` has no runtime equivalent; the permission policy carries it.
  assert.equal(copilotAgentModeForRelayMode('ask'), 'interactive');
  assert.equal(copilotAgentModeForRelayMode(''), 'interactive');
});

test('the runtime-exit observer fires once and degrades to nothing', async () => {
  const seen = [];
  let kill = null;
  const client = { processExitPromise: new Promise((_resolve, reject) => { kill = reject; }) };
  client.processExitPromise.catch(() => {});
  observeRuntimeExit(client, (detail) => seen.push(detail));
  kill(new Error('CLI server exited with code 1\nstderr: boom'));
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /exited with code 1/);

  // A bundle without the field must not throw — detection degrades to none.
  assert.equal(typeof observeRuntimeExit({}, () => {}), 'function');
  assert.equal(typeof observeRuntimeExit(null, () => {}), 'function');
  assert.equal(typeof observeRuntimeExit({ on: 'not-an-emitter' }, () => {}), 'function');
});

test('detaching the exit observer stops it reporting', async () => {
  const seen = [];
  let kill = null;
  const client = { processExitPromise: new Promise((_resolve, reject) => { kill = reject; }) };
  client.processExitPromise.catch(() => {});
  const detach = observeRuntimeExit(client, (detail) => seen.push(detail));
  detach();
  kill(new Error('gone'));
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.deepEqual(seen, []);
});
