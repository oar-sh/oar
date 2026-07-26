import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./server-runtime.mjs', import.meta.url));
const source = fs.readFileSync(sourcePath, 'utf8');

test('inactive provider rebind clears the temporary worker kill marker', () => {
  const start = source.indexOf('async function stopSessionWorkerForProviderRebind(');
  const end = source.indexOf('\nasync function reconcileUnstartedConversationProviders(', start);
  const stopWorkerSource = source.slice(start, end);
  const inactiveBranch = /if \(!hadActiveWorker\) \{([\s\S]*?)\n  \}/.exec(stopWorkerSource)?.[1] || '';

  assert.match(
    inactiveBranch,
    /clearRestartSchedule\?\.\(sessionId,\s*\{\s*resetKilledMarker:\s*true\s*\}\)/,
    'an inactive session must not remain blocked as session-killed after provider rebinding',
  );
});
