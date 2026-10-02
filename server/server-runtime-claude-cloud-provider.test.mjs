import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyClaudeCloudProviderEnvironment,
  applyClaudeProviderEnvironment,
  applyCopilotSdkProviderEnvironment,
  applyCursorProviderEnvironment,
  applyGrokProviderEnvironment,
  applyOpenAIProviderEnvironment,
  resolveWorkerKind,
} from './services/session-worker-launch-service.mjs';

// server-runtime.mjs boots a live server on import, so these tests inspect the
// source as text instead of importing it (as the other provider suites do).
const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `expected server-runtime.mjs to contain ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} after ${startMarker}`);
  return source.slice(start, end);
}

const launchEnvSource = sliceBetween(
  'function buildSessionWorkerLaunchEnvForSession(targetSessionId) {',
  '\nfunction ',
);

test('a claude-cloud session gets its own launch branch, ahead of the Copilot fall-through', () => {
  const cloudBranch = launchEnvSource.indexOf(`if (providerType === 'claude-cloud') {`);
  const claudeBranch = launchEnvSource.indexOf(`if (providerType === 'claude') {`);
  const copilotFallThrough = launchEnvSource.indexOf(`const copilotSdkEngine = getCopilotEngine() === 'sdk';`);
  assert.notEqual(cloudBranch, -1);
  assert.notEqual(claudeBranch, -1);
  assert.notEqual(copilotFallThrough, -1);
  assert.ok(cloudBranch < copilotFallThrough, 'the cloud branch returns before the Copilot CLI path');
  const branch = launchEnvSource.slice(cloudBranch, claudeBranch > cloudBranch ? claudeBranch : copilotFallThrough);
  assert.match(branch, /return applyClaudeCloudProviderEnvironment\(cleared, \{\s*enabled: true,\s*model: cloudModel,\s*\}\);/);
  // The Claude branch is still the Claude provider's own.
  assert.match(launchEnvSource, /if \(providerType === 'claude'\) \{\s*const claudeSettings = getClaudeProviderSettings\(\);/);
});

test('the cloud launch environment is the kind and the model: no login, no key', () => {
  const cloudBranch = launchEnvSource.slice(
    launchEnvSource.indexOf(`if (providerType === 'claude-cloud') {`),
    launchEnvSource.indexOf(`if (providerType === 'claude') {`),
  );
  assert.doesNotMatch(cloudBranch, /token|apiKey|credential|getAccessToken/i);
  // And nothing in the runtime asks the credentials module for the token:
  // only the cloud client does, inside shared/claude-cloud.
  assert.doesNotMatch(source, /getAccessToken/);
  assert.doesNotMatch(source, /CLAUDE_CODE_OAUTH_TOKEN/);
});

test('the clear chain the runtime runs removes a stale cloud kind before binding another provider', () => {
  assert.match(
    launchEnvSource,
    /const cleared = applyClaudeCloudProviderEnvironment\(applyCopilotSdkProviderEnvironment\(applyGrokProviderEnvironment\(applyCursorProviderEnvironment\(applyClaudeProviderEnvironment\(applyOpenAIProviderEnvironment\(sessionWorkerLaunchEnv\)\)\)\)\)\);/,
  );
  // The same chain, run for real: a base environment that names the cloud
  // worker must not leak it into a GitHub session's launch.
  const cleared = applyClaudeCloudProviderEnvironment(applyCopilotSdkProviderEnvironment(applyGrokProviderEnvironment(
    applyCursorProviderEnvironment(applyClaudeProviderEnvironment(applyOpenAIProviderEnvironment({
      COPILOT_WEB_RELAY_WORKER_KIND: 'claude-cloud',
      CLAUDE_CLOUD_RELAY_MODEL: 'claude-sonnet-5-5',
    }))),
  )));
  assert.equal(resolveWorkerKind(cleared), 'copilot');
  assert.deepEqual(cleared, {});
});

test('runtime session binding honors an explicit claude-cloud provider type', () => {
  const bindingSource = sliceBetween(
    'function ensureRuntimeSessionBinding(',
    '\nfunction bootstrapRuntimeSessionBindings(',
  );
  assert.match(bindingSource, /normalizedRequestedProviderType === 'claude-cloud'\s*\?\s*'claude-cloud'/);
  assert.match(bindingSource, /resolvedProviderType === 'claude-cloud'/);
  // Evaluated for real: the explicit type wins over the configured default,
  // and `claude` stays `claude`.
  const start = bindingSource.indexOf('const resolvedProviderType =');
  const end = bindingSource.indexOf('const resolvedProviderModel =');
  const resolve = new Function('normalizedRequestedProviderType', 'openAISettings',
    `${bindingSource.slice(start, end)}\nreturn resolvedProviderType;`);
  assert.equal(resolve('claude-cloud', { enabled: true }), 'claude-cloud');
  assert.equal(resolve('claude', { enabled: true }), 'claude');
  assert.equal(resolve('', { enabled: false }), 'github');
  assert.equal(resolve('unknown-provider', null), 'github');
});

test('unstarted conversations are never rebound to or from the cloud by a provider toggle', () => {
  // A cloud conversation carries a repository: flipping another provider's
  // switch must leave it alone, and flipping the cloud's must not turn
  // GitHub conversations into cloud ones.
  assert.match(source, /managedProvider = \['claude', 'cursor', 'grok'\]/);
  const reconcileSource = sliceBetween(
    'async function reconcileUnstartedConversationProviders(',
    '\nasync function rebindUnstartedOpenAIConversationModel(',
  );
  assert.match(reconcileSource, /if \(currentProvider !== managedProvider && currentProvider !== 'github'\) \{\s*continue;/);
});

test('the cloud services are built once and handed to the routes', () => {
  assert.match(source, /const claudeCloudCredentials = createClaudeCloudCredentials\(/);
  // The base URL comes from the one loopback-only resolver, never from the
  // environment variable read in place.
  assert.match(
    source,
    /const claudeCloudClient = createClaudeCloudClient\(\{\s*credentials: claudeCloudCredentials,\s*baseUrl: resolveClaudeCloudBaseUrl\(process\.env\),\s*\}\);/,
  );
  assert.doesNotMatch(source, /process\.env\.OAR_CLAUDE_CLOUD_API_BASE_URL|env\??\.OAR_CLAUDE_CLOUD_API_BASE_URL/);
  assert.equal(source.match(/createClaudeCloudClient\(/g).length, 1);
  assert.equal(source.match(/createClaudeCloudCredentials\(/g).length, 1);
  const depsSource = sliceBetween(
    'const sharedRouteDeps = {',
    '\nregisterMessagesRoutes(app, sharedRouteDeps);',
  );
  assert.match(depsSource, /\n  getClaudeCloudProviderSettings,\n  claudeCloudSettingsService,\n  claudeCloudSessionService,\n/);
  assert.match(depsSource, /\n  gitRemoteService,\n/);
  // The client itself is not a route dependency: no route can reach the login.
  assert.doesNotMatch(depsSource, /claudeCloudClient|claudeCloudCredentials/);
  assert.match(source, /\nregisterClaudeCloudRoutes\(app, sharedRouteDeps\);\n/);
});

test('the worker dequeue is given the cloud settings for the delivery field', () => {
  const dequeueSource = sliceBetween('  const out = buildDequeuedRelayMessage({', '\n  });');
  assert.match(dequeueSource, /getClaudeCloudProviderSettings,/);
});
