import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

test('inactive provider rebind clears the temporary worker kill marker', () => {
  const start = source.indexOf('async function stopSessionWorkerForProviderRebind(');
  // The stop helper now ends where the OpenAI model rebind (its one caller) begins.
  const end = source.indexOf('\nasync function rebindUnstartedOpenAIConversationModel(', start);
  assert.ok(start >= 0 && end > start, 'both anchors are in the runtime');
  const stopWorkerSource = source.slice(start, end);
  const inactiveBranch = /if \(!hadActiveWorker\) \{([\s\S]*?)\n  \}/.exec(stopWorkerSource)?.[1] || '';

  assert.match(
    inactiveBranch,
    /clearRestartSchedule\?\.\(sessionId,\s*\{\s*resetKilledMarker:\s*true\s*\}\)/,
    'an inactive session must not remain blocked as session-killed after provider rebinding',
  );
});

test('no settings change moves a chat to another provider: the empty-chat rebind is gone', () => {
  assert.doesNotMatch(source, /reconcileUnstartedConversationProviders|provider_rebind_failed/);
  const routes = fs.readFileSync(fileURLToPath(new URL('./routes/settings-routes.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(routes, /reconcileUnstartedConversationProviders|updateRuntimeSessionProvider/);
  // Changing an empty OpenAI chat's model keeps its provider, and stays.
  assert.match(source, /async function rebindUnstartedOpenAIConversationModel\(/);
});
