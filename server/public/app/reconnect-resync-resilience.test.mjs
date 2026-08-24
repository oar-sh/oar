import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Structural pins for the stale-panel incident (conv 713eeda8, 2026-08-17):
// a suspended PWA missed the socket event that emptied a background-task set,
// and every correction path then failed structurally — the connect-time
// resync was a one-shot swallowed catch, and foreground recovery aborted its
// whole step chain on the first failed fetch. An emptied server store never
// re-announces itself, so the client's resync paths must be resilient.

const socketSource = fs.readFileSync(
  fileURLToPath(new URL('./socket-handlers.js', import.meta.url)),
  'utf8',
);
const bootstrapSource = fs.readFileSync(
  fileURLToPath(new URL('./bootstrap.js', import.meta.url)),
  'utf8',
);

test('the connect-time view resync retries instead of dying on one failed fetch', () => {
  assert.match(socketSource, /function resyncAfterConnect\(attempt = 0\)/);
  // The connect handler must use the retrying path, not a one-shot swallow.
  assert.match(socketSource, /renderConvList\(\);\s*\n\s*resyncAfterConnect\(\);/);
  assert.doesNotMatch(
    socketSource,
    /renderConvList\(\);\s*\n\s*refreshCurrentView\(\)\.catch/,
    'the one-shot refreshCurrentView().catch on connect must not come back',
  );
  // Bounded backoff, gated on a live socket and superseded by newer connects.
  assert.match(socketSource, /attempt >= 4/);
  assert.match(socketSource, /generation !== connectResyncGeneration/);
  assert.match(socketSource, /!socket\?\.connected/);
});

test('foreground recovery isolates its steps so one failure cannot skip the rest', () => {
  assert.match(bootstrapSource, /const recoverySteps = \[/);
  // refreshCurrentView must be one of the individually-guarded steps.
  assert.match(bootstrapSource, /\['current-view', \(\) => refreshCurrentView\(\)\]/);
  assert.match(
    bootstrapSource,
    /for \(const \[step, run\] of recoverySteps\) \{\s*\n\s*try \{\s*\n\s*await run\(\);/,
    'each recovery step runs inside its own try/catch',
  );
  // The old all-or-nothing sequential chain must not come back.
  assert.doesNotMatch(
    bootstrapSource,
    /await refreshSessionWorkerStatus\(\);\s*\n\s*await refreshCurrentView\(\);/,
  );
});
