'use strict';

// server-runtime.mjs boots a live server on import, so the CLI install
// service's wiring is pinned by source inspection, like the other runtime
// suites. The done-check itself is covered by
// services/cli-install-service.test.mjs, the lookup by copilot-sdk-runtime.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSource = fs.readFileSync(path.join(__dirname, 'server-runtime.mjs'), 'utf8').replace(/\r\n/g, '\n');

test('a Copilot install is checked with the lookup a launch makes, configuration and launch environment included', () => {
  const from = runtimeSource.indexOf('\nconst cliInstallService = createCliInstallService({');
  assert.ok(from >= 0);
  const construction = runtimeSource.slice(from, runtimeSource.indexOf('\n});\n', from));
  assert.match(construction, /\n {2}findCopilotSdk: \(\) => resolveCopilotSdkLaunchPath\(\{ config, env: sessionWorkerLaunchEnv \}\),/);
  // The launch itself asks the same function with the same arguments.
  assert.match(runtimeSource, /\n {2}const sdkPath = resolveCopilotSdkLaunchPath\(\{ config, env: sessionWorkerLaunchEnv \}\);\n/);
});
