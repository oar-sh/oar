import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// The runtime's side of the Copilot switch (it boots a live server on import,
// so this reads its source, as the other server-runtime-*.test.mjs do).
const source = fs.readFileSync(fileURLToPath(new URL('./server-runtime.mjs', import.meta.url)), 'utf8');

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end + 2);
}

test('one CLI detector, from the installed-paths resolver, for every reader of the switch', () => {
  assert.match(source, /const detectCopilotCli = createCopilotCliDetector\(\{ resolveInstalledPaths: \(\) => resolveInstalledCopilotPaths\(\{ config \}\) \}\);/);
  assert.match(sliceFunction('isCopilotEnabled'), /copilotEnabledFromStmts\(stmts, \{ detectCli: detectCopilotCli \}\)/);
  // The route modules (settings, bootstrap, intake, claim) read it from their deps.
  const routeDeps = source.slice(source.indexOf('const sharedRouteDeps = {'), source.indexOf('\n};\n', source.indexOf('const sharedRouteDeps = {')));
  assert.match(routeDeps, /\n  detectCopilotCli,\n/);
});

test('the Copilot settings and About answer the switch and the CLI', () => {
  assert.match(sliceFunction('getCopilotProviderSettings'), /return \{ engine: 'sdk', engines: \['sdk'\], enabled: isCopilotEnabled\(\), cliFound: detectCopilotCli\(\) \};/);
  assert.match(source, /github: \{ enabled: isCopilotEnabled\(\), engine: getCopilotProviderSettings\(\)\.engine \}/);
  assert.doesNotMatch(source, /github: \{ enabled: true/);
});

test('the binding backstop: a create is never bound to Copilot while it is off; an old unbound chat still is', () => {
  const binding = source.slice(source.indexOf('function ensureRuntimeSessionBinding('), source.indexOf('\nfunction bootstrapRuntimeSessionBindings('));
  assert.match(binding, /if \(assignConfiguredProvider && resolvedProviderType === 'github' && !isCopilotEnabled\(\)\) \{\n    throw Object\.assign\(new Error\('Copilot is switched off on this relay, so no Copilot chat was started\.'\), \{ code: 'COPILOT_NOT_ENABLED' \}\);/);
  // The guard comes after the provider is resolved and before anything is written.
  assert.ok(binding.indexOf("!isCopilotEnabled()") > binding.indexOf("(openAISettings?.enabled ? 'openai' : 'github')"));
  assert.ok(binding.indexOf("!isCopilotEnabled()") < binding.indexOf('const insertArgs = ['));
  // The boot binding of old chats (no provider: Copilot's) passes no create flag.
  const boot = source.slice(source.indexOf('function bootstrapRuntimeSessionBindings('), source.indexOf('\nfunction emitToClientsExceptSessionId('));
  assert.match(boot, /ensureRuntimeSessionBinding\(conversationId, latestModel, now\);/);
});

test('Copilot off: no SDK session import or model discovery at boot, no ledger line, no usage reads', () => {
  const boot = source.slice(source.indexOf('if (isCopilotEnabled()) {\n    void sdkSessionImportService.runStartupImport()'));
  assert.ok(boot.length > 0, 'the boot work is behind the switch');
  assert.match(boot, /^if \(isCopilotEnabled\(\)\) \{\n    void sdkSessionImportService\.runStartupImport\(\)[\s\S]*?copilotModelDiscoveryService\.scheduleStartupRefresh\(\);\n  \} else \{/);
  // Nowhere else is either started.
  assert.equal(source.match(/runStartupImport\(\)/g).length, 1);
  assert.equal(source.match(/scheduleStartupRefresh\(\)/g).length, 1);
  // The ledger hooks record Copilot only while it is on.
  for (const hook of [
    /onNewModels: \(baseModelIds, on\) => \{ if \(isCopilotEnabled\(\)\) modelRefreshLedger\.noteNewModels\('github'/,
    /onAuthoritativeSnapshot: \(\) => \{ if \(isCopilotEnabled\(\)\) modelRefreshLedger\.record\('github'/,
    /onRefreshed: \(result\) => \{ if \(isCopilotEnabled\(\)\) modelRefreshLedger\.record\('github', result\); \}/,
  ]) assert.match(source, hook);
  const records = source.match(/[^\n]*modelRefreshLedger\.(record|noteNewModels)\('github'/g);
  assert.equal(records.length, 3);
  for (const line of records) assert.match(line, /if \(isCopilotEnabled\(\)\) modelRefreshLedger\./, line);
  // The background check's table has the switch.
  const table = source.slice(source.indexOf('const modelRefreshTable = buildProviderRefreshTable({'), source.indexOf('\n});', source.indexOf('const modelRefreshTable = buildProviderRefreshTable({')));
  assert.match(table, /\n  isCopilotEnabled,\n/);
  // Usage: neither GitHub read runs while off.
  assert.match(sliceFunction('fetchCopilotBillingUsage'), /^function fetchCopilotBillingUsage\(\) \{\n  \/\/ [^\n]*\n  if \(!isCopilotEnabled\(\)\) \{\n    return Promise\.resolve\(\{ items: \[\], timePeriod: null, scope: null, error: COPILOT_NOT_SET_UP_TEXT \}\);/);
  assert.match(sliceFunction('fetchUsageSummary'), /^function fetchUsageSummary\(cb\) \{\n  if \(!isCopilotEnabled\(\)\) \{\n    cb\(new Error\(COPILOT_NOT_SET_UP_TEXT\)\);\n    return;/);
});

test('context details name the chat\'s own provider\'s session, never Copilot\'s for every chat', async () => {
  const details = sliceFunction('buildContextResponseText');
  assert.match(details, /const sessionIdLabel = `\$\{providerSessionLabel\(runtimeSession\?\.provider_type\)\} ID`;/);
  assert.equal(details.split('pushDetail(sessionIdLabel, canonicalCopilotSessionId);').length, 3, 'both rows');
  assert.doesNotMatch(source, /'Copilot session ID'/);
  const { providerSessionLabel } = await import('./public/app/conversation-provider-indicator.mjs');
  assert.equal(`${providerSessionLabel('claude')} ID`, 'Claude session ID');
  assert.equal(`${providerSessionLabel('github')} ID`, 'Copilot session ID');
  assert.equal(`${providerSessionLabel('')} ID`, 'Session ID');
});

test('the socket claim and the worker launch: a Copilot row fails with its note while Copilot is off', () => {
  const delivery = source.slice(source.indexOf('async function requestSessionWorkerSocketDelivery('), source.indexOf('\nasync function recoverUndeliveredSessionWorkerMessage'));
  assert.match(delivery, /onBillingFence: handleClaudeBillingFence,\n[^\n]*\n[^\n]*\n    copilotClaimCheck,\n    onCopilotFence: handleCopilotFence,/);
  assert.match(sliceFunction('copilotClaimCheck'), /return isCopilotEnabled\(\) \? null : copilotClaimRefusal\(\);/);
  const fence = sliceFunction('handleCopilotFence');
  assert.match(fence, /if \(!row \|\| String\(row\.status \|\| ''\) !== 'pending'\) return;/);
  assert.match(fence, /failRecoveredRowTerminally\(row, 'copilot-switched-off', \{/);
  assert.match(fence, /code: 'COPILOT_SWITCHED_OFF',\n\s+stableCode: 'relay\.copilot-switched-off',/);
  assert.match(fence, /failureText: copilotSwitchedOffNoteText\(\),/);
  // Never through the Claude billing fence or its swap.
  assert.doesNotMatch(fence, /claudeBillingSwapService|handleClaudeBillingFence/);
  const launch = sliceFunction('failCopilotRowsWithoutLaunch');
  assert.match(launch, /if \(isCopilotEnabled\(\)\) return false;/);
  assert.match(launch, /if \(!isCopilotProviderType\(runtime\?\.provider_type\)\) return false;/);
  assert.match(launch, /for \(const row of stmts\.listPendingRowsForSession\.all\(sdkSessionId\)\) \{\n    handleCopilotFence\(\{ messageId: row\.id \}\);/);
  assert.match(source, /failRowsWithoutLaunch: \(sid\) => failClaudeApiRowsWithoutLaunch\(sid\) \|\| failCopilotRowsWithoutLaunch\(sid\),/);
});

test('an OpenAI chat passes both while Copilot is off: the fence and the launch key on the chat\'s provider', () => {
  // The socket claim uses the claim module's copilotSwitchFence, which lets
  // an openai row run (messages-routes-copilot-claim-fence.test.mjs); the
  // launch-time fail returns before listing rows for a non-Copilot chat.
  const launch = sliceFunction('failCopilotRowsWithoutLaunch');
  assert.ok(launch.indexOf('if (!isCopilotProviderType(runtime?.provider_type)) return false;') < launch.indexOf('listPendingRowsForSession'));
  assert.doesNotMatch(launch, /workerKind|copilot-sdk/, 'never keyed on the worker kind, which OpenAI chats share');
});

test('the unarchive wake gets the Copilot launch check too', () => {
  const start = source.indexOf('const sharedRouteDeps = {');
  const routeDeps = source.slice(start, source.indexOf('\n};\n', start));
  assert.match(routeDeps, /\n  failClaudeApiRowsWithoutLaunch,\n  failCopilotRowsWithoutLaunch,\n/);
});
