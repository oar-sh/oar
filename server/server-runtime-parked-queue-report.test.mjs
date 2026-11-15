'use strict';

// server-runtime.mjs boots a live server on import, so the boot wiring of the
// parked-queue report is pinned by source inspection, like the other runtime
// suites. The report itself is covered by
// services/relay-queue-gate-service.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

const BOOT_CALL = '\ntry { reportParkedQueueAtBoot(';

test('the parked-queue report comes from the queue gate service and runs from one place', () => {
  assert.match(runtimeSource, /\nimport \{ reportParkedQueueAtBoot \} from '\.\/services\/relay-queue-gate-service\.mjs';\n/);
  assert.equal(runtimeSource.split('reportParkedQueueAtBoot(').length, 2, 'called once');
});

test('the report runs once at start, after the first stale recovery', () => {
  const call = runtimeSource.indexOf(BOOT_CALL);
  assert.notEqual(call, -1, 'a top-level call, not in a timer or a handler');
  const firstRecovery = runtimeSource.indexOf('\nrecoverStaleMessages(); // run immediately on startup\n');
  assert.notEqual(firstRecovery, -1);
  assert.ok(firstRecovery < call, 'after the stale rows of the last run went back to the queue');
});

test('a failing report is logged and never stops the boot', () => {
  const from = runtimeSource.indexOf(BOOT_CALL);
  const block = runtimeSource.slice(from, runtimeSource.indexOf('\n', from + 1));
  assert.match(block, /try \{ reportParkedQueueAtBoot\(\{ stmts, log: \(line\) => console\.log\(`\$\{runtimeLogPrefix\(\)\}\$\{line\}`\) \}\); \}/);
  assert.match(block, /catch \(error\) \{ console\.warn\(`\$\{runtimeLogPrefix\(\)\}parked queue report failed: \$\{error\?\.message \|\| error\}`\); \}/);
});

test('the runtime stmts carry the summary statement the report reads', () => {
  const from = runtimeSource.indexOf('\nconst stmts = {\n');
  assert.notEqual(from, -1);
  const block = runtimeSource.slice(from, runtimeSource.indexOf('\n};\n', from));
  assert.match(block, /\.\.\.createMessageRepository\(db\),/);
  const repository = fs.readFileSync(path.join(__dirname, 'repositories', 'message-repository.mjs'), 'utf8');
  assert.match(repository, /\bsummarizeParkedQueue: db\.prepare\(/);
});
