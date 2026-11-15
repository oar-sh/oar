'use strict';

// The worker entry files start a worker on import, so what they pass to the
// heartbeat and the socket link is pinned by source inspection. That a stated
// kind rides every beat and every hello is covered by
// shared/worker-runtime/heartbeat.test.mjs and worker-websocket-link.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWorkerKind } from './services/session-worker-launch-service.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENTRIES = [
  ['copilot-sdk', 'copilot-worker/copilot-sdk-session-worker.mjs'],
  ['cursor', 'cursor-worker/cursor-session-worker.mjs'],
  ['grok', 'grok-worker/grok-session-worker.mjs'],
  ['claude-cloud', 'claude-cloud-worker/claude-cloud-session-worker.mjs'],
];

function callBlock(source, opening) {
  const from = source.indexOf(opening);
  assert.notEqual(from, -1, `${opening} is called`);
  assert.equal(source.split(opening).length, 2, `${opening} is called once`);
  return source.slice(from, source.indexOf('\n  });', from));
}

for (const [kind, file] of ENTRIES) {
  test(`the ${kind} worker states its kind in its heartbeat and its socket hello`, () => {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/\r\n/g, '\n');
    assert.match(source, new RegExp(`\\nconst WORKER_KIND = '${kind}';\\n`));
    assert.match(callBlock(source, 'createHeartbeatController({'), /\n    workerKind: WORKER_KIND,\n/);
    assert.match(callBlock(source, 'createWorkerWebSocketLink({'), /\n    workerKind: WORKER_KIND,\n/);
    // The name the launch service starts it under.
    assert.equal(resolveWorkerKind({ COPILOT_WEB_RELAY_WORKER_KIND: kind }), kind);
  });
}
