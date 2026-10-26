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

test('the Claude API settings service is built on the settings table over the Claude settings', () => {
  const serviceSource = sliceBetween('const claudeApiSettingsService = createClaudeApiSettingsService({', '\n});');
  assert.match(serviceSource, /readSetting: readAppSettingValue,/);
  assert.match(serviceSource, /listProviderCandidates: \(\) => stmts\.listRuntimeSessionProviderCandidates\?\.all\?\.\(\) \|\| \[\]/);
  assert.match(serviceSource, /getClaudeProviderSettings: \(\) => getClaudeProviderSettings\(\),/);
  const depsSource = sliceBetween('const sharedRouteDeps = {', '\n};');
  assert.match(depsSource, /\n  getClaudeApiProviderSettings,\n/);
  assert.match(depsSource, /\n  claudeApiSettingsService,\n/);
});

test('a Claude API conversation launches the Claude API worker with the saved key, never Claude or Copilot', () => {
  const launchSource = sliceBetween(
    'function buildSessionWorkerLaunchEnvForSession(',
    '\nconst relayCliLauncherService = ',
  );
  // Every launch clears the Claude API variables first, so no other kind
  // inherits the key.
  assert.match(launchSource, /const cleared = applyClaudeApiProviderEnvironment\(/);
  const branch = launchSource.indexOf("if (providerType === 'claude-api') {");
  const copilotFallThrough = launchSource.indexOf("const copilotSdkEngine = getCopilotEngine() === 'sdk';");
  assert.notEqual(branch, -1);
  assert.ok(branch < copilotFallThrough, 'the claude-api branch must come before the Copilot fall-through');
  const branchSource = launchSource.slice(branch, launchSource.indexOf('\n  }\n', branch));
  assert.doesNotMatch(branchSource, /claude-api-worker-not-available/);
  assert.match(branchSource, /const claudeApiSettings = getClaudeApiProviderSettings\(\);/);
  assert.match(branchSource, /return applyClaudeApiProviderEnvironment\(cleared, \{/);
  assert.match(branchSource, /enabled: true,/);
  assert.match(branchSource, /runtimeSession\?\.provider_model \|\| runtimeSession\?\.model \|\| claudeApiSettings\.model/);
  assert.match(branchSource, /apiKey: claudeApiSettings\.apiKey,/);
  // The host's Claude Code state: no config dir of its own.
  assert.doesNotMatch(branchSource, /configDir|CLAUDE_CONFIG_DIR/);
});

test('a Claude API delivery carries Claude\'s attribution and background command limit', () => {
  const deliverySource = sliceBetween(
    'async function requestSessionWorkerSocketDelivery(',
    '\nasync function recoverUndeliveredSessionWorkerMessage(',
  );
  assert.match(deliverySource, /const localClaude = deliveredProvider === 'claude' \|\| deliveredProvider === 'claude-api';/);
  assert.match(deliverySource, /if \(!localClaude && deliveredProvider !== 'claude-cloud'\) return \{\};/);
  assert.match(deliverySource, /relayFolderFallback: localClaude,/);
  assert.match(deliverySource, /\.\.\.\(localClaude\s*\?\s*\{ claudeBackgroundCommandLimitMs:/);
  // The compaction window is read for every provider; only DeepSeek has a
  // default of its own.
  assert.match(deliverySource, /autoCompactWindow: parseAutoCompactWindow\(conv\?\.auto_compact_window\)/);
});

test('provider reconciliation and runtime binding know claude-api, never folded into claude', () => {
  const reconcileSource = sliceBetween(
    'async function reconcileUnstartedConversationProviders(',
    '\nasync function rebindUnstartedOpenAIConversationModel(',
  );
  assert.match(reconcileSource, /managedProvider = \[[^\]]*'claude-api'\]/);
  assert.match(reconcileSource, /managedProvider === 'claude-api'\s*\?\s*getClaudeApiProviderSettings\(\)\.model/);
  assert.match(
    reconcileSource,
    /currentProvider === 'claude-api'\s*\?\s*getClaudeApiProviderSettings\(\)\.enabled === true/,
    'rollback must only restore a claude-api binding while the provider is on',
  );
  const bindingSource = sliceBetween('function ensureRuntimeSessionBinding(', '\nfunction bootstrapRuntimeSessionBindings(');
  assert.match(bindingSource, /normalizedRequestedProviderType === 'claude-api'\s*\?\s*'claude-api'/);
  assert.match(bindingSource, /\|\| resolvedProviderType === 'claude-api'\n/);
});

test('the billing switch: the delivery fences by the worker\'s kind and fails a Claude API row closed when the key is unusable', () => {
  const delivery = sliceBetween('async function requestSessionWorkerSocketDelivery(', '\nasync function recoverUndeliveredSessionWorkerMessage');
  assert.match(delivery, /workerKind: workerKind \|\| sessionWorkerRegistry\?\.getWorker\?\.\(requesterSessionId\)\?\.kind \|\| null,/);
  assert.match(delivery, /claudeApiClaimCheck,/);
  assert.match(delivery, /onBillingFence: handleClaudeBillingFence,/);
  // The stated kind is registered with the worker on its first delivery request.
  assert.match(delivery, /const statedKind = normalizeWorkerKind\(workerKind\);/);
  assert.match(delivery, /\.\.\.\(statedKind \? \{ kind: statedKind \} : \{\}\),/);
  assert.match(delivery, /else if \(statedKind && existingWorker\.kind !== statedKind\)/);
  // The first delivery after a swap says so to the new worker.
  assert.match(delivery, /claudeBillingSwapService\.takeSwapNote\(out\.ownerSessionId\)/);
  const check = sliceBetween('function claudeApiClaimCheck() {', '\n}');
  assert.match(check, /settings\?\.configured !== true/);
  assert.match(check, /settings\?\.enabled !== true/);
  // Switched off (a key saved): its note says to switch it on, not to set it up.
  assert.match(check, /error: 'Claude API is switched off, so this turn did not run\.', switchedOff: true \}/);
  // The cap: one seam for the claim and the switch, failing closed.
  assert.match(check, /cap = getClaudeApiCapState\(\) \|\| null; \} catch \{ cap = \{ reached: true \}; \}/);
  assert.match(check, /code: 'CLAUDE_API_CAP_REACHED'/);
  // The real cap (services/plan-usage-claude-api.mjs), and the routes ask
  // the same seam: an agent's send and a new Claude API chat.
  assert.match(sliceBetween('function getClaudeApiCapState() {', '\n}'), /return claudeApiPlanUsage\.getCapState\(\);/);
  assert.match(runtimeSource, /const claudeApiPlanUsage = createClaudeApiPlanUsage\(\{\n  usageService: claudeApiUsageService,\n  getSettings: \(\) => getClaudeApiProviderSettings\(\),\n\}\);/);
  assert.match(runtimeSource, /\n  claudeApiPlanUsage,\n  getClaudeApiCapState,\n/);
  // A flip of the cap re-announces the open Claude chats' billing states.
  const watch = sliceBetween('const claudeApiCapWatch = createClaudeApiCapWatch({', '\n});');
  assert.match(watch, /getCapState: \(\) => getClaudeApiCapState\(\),/);
  assert.match(watch, /io\.emit\('conversation_billing', \{ conversationId: id, billing \}\)/);
  // Its clock is a runtime timer, cleared with the others at shutdown.
  assert.match(runtimeSource, /claudeApiCapWatch\.check\('boot'\);\nruntimeTimers\.claudeApiCapClock = setInterval\(\(\) => claudeApiCapWatch\.check\('clock'\), 5 \* 60 \* 1000\);/);
  assert.match(sliceBetween('const runtimeTimers = {', '\n};'), /claudeApiCapClock: null,/);
  // Deleted chats are not announced.
  assert.match(sliceBetween('const listOpenClaudeChats = db.prepare(`', '`);'), /COALESCE\(c\.status, ''\) != 'deleted'/);
  assert.match(runtimeSource, /\n  checkClaudeApiCap: \(reason\) => claudeApiCapWatch\.check\(reason\),\n  claudeApiStopLedger,\n/);
  // The cap clearing ends every chat's stop-note episode.
  assert.match(runtimeSource, /const claudeApiStopLedger = createClaudeApiStopNoteLedger\(\);/);
  assert.match(watch, /if \(!reached\) claudeApiStopLedger\.clearAll\(\);/);
  const switchService = sliceBetween('const claudeBillingSwitchService = createClaudeBillingSwitchService({', '\n});');
  assert.match(switchService, /getClaudeApiCapState: \(\) => getClaudeApiCapState\(\),/);
  const fence = sliceBetween('function handleClaudeBillingFence(fence) {', '\n}');
  assert.match(fence, /fence\?\.reason === 'claude-api-unavailable'/);
  assert.match(fence, /failRecoveredRowTerminally\(row, 'claude-api-unavailable'/);
  assert.match(fence, /claudeApiRemedyText\(\{ code, switchedOff: fence\.refusal\?\.switchedOff === true \}\)/);
  assert.match(fence, /claudeBillingSwapService\.request\(fence\)/);
});

test('the billing swap stops the old worker with launches blocked, then launches without reusing a process', () => {
  const swap = sliceBetween('const claudeBillingSwapService = createClaudeBillingSwapService({', '\n});');
  const stop = swap.slice(swap.indexOf('stopWorker:'), swap.indexOf('launchWorker:'));
  assert.ok(stop.indexOf('markKilled') < stop.indexOf('stopSessionWorkerProcesses'), 'launches are blocked before the stop');
  assert.match(stop, /if \(!stopped\.ok\) return backOff\(/);
  // A failed stop, thrown or reported, clears the killed marker and says so.
  assert.match(stop, /catch \(error\) \{\n      return backOff\(/);
  assert.match(stop, /clearRestartSchedule\?\.\(sid, \{ resetKilledMarker: true \}\);\n      console\.warn\(`\$\{runtimeLogPrefix\(\)\}BILLING SWAP STOP FAILED/);
  // The relay's own record of a claimed turn comes before the snapshot.
  assert.match(swap, /hasRunningTurn: \(sid\) => \(stmts\.listProcessingRowsForOwner\?\.all\?\.\(sid\) \|\| \[\]\)\.length > 0,/);
  const launch = swap.slice(swap.indexOf('launchWorker:'), swap.indexOf('onStuck:'));
  assert.match(launch, /clearRestartSchedule\?\.\(sid, \{ resetKilledMarker: true \}\)/);
  assert.match(launch, /ensureWorker\?\.\(sid, \{ allowProcessReuse: false \}\)/);
});

test('a compacted Claude chat keeps its billing; the key removal counts live workers on the key', () => {
  const compact = sliceBetween('function createCompactedConversation(sourceConversationId) {', '\nfunction sanitizeActivityText');
  assert.match(compact, /const sourceBilling = normalizeClaudeBilling\(sourceRuntime\?\.provider_type\);/);
  assert.match(compact, /providerType: sourceBilling,/);
  const settings = sliceBetween('const claudeApiSettingsService = createClaudeApiSettingsService({', '\n});');
  assert.match(settings, /countLiveKeyWorkers: \(\) => \(sessionWorkerRegistry\?\.listWorkers\?\.\(\) \|\| \[\]\)\.filter\(\(worker\) => worker\?\.kind === 'claude-api'\)\.length,/);
  const sockets = sliceBetween('const sessionWorkerWebSocketService = createSessionWorkerWebSocketService({', '\n});');
  assert.match(sockets, /onWorkerKind: \(sessionId, kind\) => \{/);
});

test('the primer launches no Claude API worker while Claude API cannot run a turn; its rows fail closed', () => {
  const primer = sliceBetween('async function primePendingSessionWorkers(', '\n}');
  assert.ok(primer.indexOf('failClaudeApiRowsWithoutLaunch(sdkSessionId)') < primer.indexOf('ensureWorker(sdkSessionId)'), 'checked before the launch');
  // A throw costs only that session its launch: the pass goes on.
  assert.match(primer, /try \{\n[^]*?if \(failClaudeApiRowsWithoutLaunch\(sdkSessionId\)\) continue;\n    \} catch \(error\) \{\n[^]*?continue;\n    \}/);
  const skip = sliceBetween('function failClaudeApiRowsWithoutLaunch(sdkSessionId) {', '\n}');
  assert.match(skip, /normalizeClaudeBilling\(runtime\?\.provider_type\) !== 'claude-api'/);
  // A check that throws fails this session's key rows closed.
  assert.match(skip, /try \{\n    refusal = claudeApiClaimCheck\(\);\n  \} catch \(error\) \{/);
  assert.match(skip, /code: 'CLAUDE_API_NOT_CONFIGURED',/);
  assert.match(skip, /handleClaudeBillingFence\(\{ reason: 'claude-api-unavailable', messageId: row\.id, refusal \}\)/);
});
