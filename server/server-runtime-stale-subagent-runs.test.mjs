'use strict';

// server-runtime.mjs boots a live server on import, so the wiring of the
// stale sub-agent run sweep is pinned by source inspection. The sweep itself
// is covered by services/stale-subagent-run-sweep.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');

test('the stale run sweep runs after boot and periodically, with worker liveness from the registry', () => {
  const from = runtimeSource.indexOf('const staleSubagentRunSweep = createStaleSubagentRunSweep({');
  assert.notEqual(from, -1);
  const body = runtimeSource.slice(from, from + 1500);
  assert.match(body, /isConversationWorkerAlive: \(conversationId\) => \{[\s\S]*hostActivityWorkerAlive\(conversationId\)[\s\S]*getRuntimeSessionByConversation[\s\S]*hostActivityWorkerAlive\(sdkSessionId\)/);
  assert.match(body, /runtimeTimers\.staleSubagentRunsBoot = setTimeout\([\s\S]*?staleSubagentRunSweep\.sweep\(\);[\s\S]*?STALE_SUBAGENT_RUN_BOOT_DELAY_MS\)/);
  assert.match(body, /runtimeTimers\.staleSubagentRuns = setInterval\([\s\S]*?staleSubagentRunSweep\.sweep\(\);[\s\S]*?STALE_SUBAGENT_RUN_SWEEP_INTERVAL_MS\)/);
  assert.ok(from > runtimeSource.indexOf('function hostActivityWorkerAlive('), 'the liveness helper exists before the sweep is built');
});
