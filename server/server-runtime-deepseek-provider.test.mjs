'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// server-runtime.mjs boots a live server on import, so these tests read the
// source as text, like the other provider suites.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

function sliceBetween(startMarker, endMarker) {
  const start = runtimeSource.indexOf(startMarker);
  assert.notEqual(start, -1, `expected server-runtime.mjs to contain ${startMarker}`);
  const end = runtimeSource.indexOf(endMarker, start);
  assert.notEqual(end, -1, `expected ${endMarker} after ${startMarker}`);
  return runtimeSource.slice(start, end);
}

test('the DeepSeek settings service is built on the settings table and handed to the routes', () => {
  assert.match(runtimeSource, /const deepseekSettingsService = createDeepSeekSettingsService\(\{/);
  assert.match(runtimeSource, /listProviderCandidates: \(\) => stmts\.listRuntimeSessionProviderCandidates\?\.all\?\.\(\) \|\| \[\]/);
  const depsSource = sliceBetween('const sharedRouteDeps = {', '\n};');
  assert.match(depsSource, /\n  getDeepSeekProviderSettings,\n/);
  assert.match(depsSource, /\n  deepseekSettingsService,\n/);
});

test('a DeepSeek conversation gets its own worker and never falls through to a Copilot launch', () => {
  const launchSource = sliceBetween(
    'function buildSessionWorkerLaunchEnvForSession(',
    '\nconst relayCliLauncherService = ',
  );
  // Cleared for every other launch, whatever its provider.
  assert.match(launchSource, /const cleared = applyDeepSeekProviderEnvironment\(/);
  const deepseekBranch = launchSource.indexOf("if (providerType === 'deepseek') {");
  const copilotFallThrough = launchSource.indexOf("const copilotSdkEngine = getCopilotEngine() === 'sdk';");
  assert.notEqual(deepseekBranch, -1);
  assert.ok(deepseekBranch < copilotFallThrough, 'the deepseek branch must come before the Copilot fall-through');
  const branch = launchSource.slice(deepseekBranch, copilotFallThrough);
  assert.match(branch, /return applyDeepSeekProviderEnvironment\(cleared, \{/);
  assert.match(branch, /apiKey: deepseekSettings\.apiKey,/);
  assert.match(branch, /configDir: DEEPSEEK_CLAUDE_CONFIG_DIR,/);
  assert.match(runtimeSource, /const DEEPSEEK_CLAUDE_CONFIG_DIR = path\.join\(DATA_DIR, 'deepseek-claude'\);/);
});

test('a DeepSeek delivery carries DeepSeek attribution, the Claude command limit and a 400K window by default', () => {
  const deliverySource = sliceBetween('// Piggybacked settings so workers pick up slider changes', '\n    routing: {');
  assert.match(deliverySource, /\?\? \(deliveredProvider === 'deepseek' \? DEEPSEEK_DEFAULT_AUTO_COMPACT_WINDOW : null\)/);
  assert.match(deliverySource, /attribution: deepseekAttributionForConversation\(conv, out\.providerModel \|\| out\.model\)/);
  const attributionSource = sliceBetween('function deepseekAttributionForConversation(', '\n}\n');
  // A folder set to vanilla gets OAR's trailer: Claude Code's would credit Claude.
  assert.match(attributionSource, /mode: resolved === 'vanilla' \? 'oar' : resolved/);
  assert.match(attributionSource, /modelLabel: deepseekModelLabel\(modelId\)/);
});

test('provider reconciliation and runtime binding know deepseek', () => {
  const reconcileSource = sliceBetween(
    'async function reconcileUnstartedConversationProviders(',
    '\nasync function rebindUnstartedOpenAIConversationModel(',
  );
  assert.match(reconcileSource, /deepseek: DEFAULT_DEEPSEEK_MODEL,/);
  assert.match(
    reconcileSource,
    /currentProvider === 'deepseek'\s*\?\s*getDeepSeekProviderSettings\(\)\.configured === true/,
    'rollback must only restore a deepseek binding while the key is still configured',
  );
  const bindingSource = sliceBetween('function ensureRuntimeSessionBinding(', '\nfunction bootstrapRuntimeSessionBindings(');
  assert.match(bindingSource, /normalizedRequestedProviderType === 'deepseek'\s*\?\s*'deepseek'/);
  assert.match(bindingSource, /resolvedProviderType === 'deepseek'\)/);
});

test('the DeepSeek session-root resolver is built over the DeepSeek config dir with no home', () => {
  assert.match(
    runtimeSource,
    /const deepseekSessionRootResolver = createClaudeSessionRootResolver\(\{\n  fs,\n  path,\n  env: \{ CLAUDE_CONFIG_DIR: DEEPSEEK_CLAUDE_CONFIG_DIR \},\n  homedir: \(\) => '',\n\}\);/,
  );
  const depsSource = sliceBetween('const sharedRouteDeps = {', '\n};');
  assert.match(depsSource, /resolveDeepSeekSessionRoot: deepseekSessionRootResolver\.resolveClaudeSessionRoot,/);
});
