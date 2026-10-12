'use strict';

// server-runtime.mjs boots a live server on import, so the wiring of the
// clock-jump guard around stale recovery is pinned by source inspection. The
// guard is covered by services/stale-recovery-clock-guard.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8');

function sliceBetween(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  const to = source.indexOf(end, from);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

test('stale recovery asks the clock guard first and recovers nothing during its grace', () => {
  const guard = sliceBetween(runtimeSource, 'const staleRecoveryClockGuard = createStaleRecoveryClockGuard({', '});');
  assert.match(guard, /intervalMs: STALE_RECOVERY_INTERVAL_MS/);
  assert.match(guard, /graceMs: Math\.max\(processingTimeoutMs, 60_000\)/, 'a live worker gets a full inactivity window to report');
  const body = sliceBetween(runtimeSource, 'function recoverStaleMessages() {', '\n}\n');
  assert.match(body, /^function recoverStaleMessages\(\) \{\n  if \(staleRecoveryClockGuard\.tick\(\)\.skip\) return;/, 'the guard runs before any cutoff is computed');
  assert.ok(body.indexOf('staleRecoveryClockGuard.tick()') < body.indexOf('recoverProcessingOlderThan('));
  assert.match(runtimeSource, /runtimeTimers\.staleRecovery = setInterval\(recoverStaleMessages, STALE_RECOVERY_INTERVAL_MS\);/);
});
