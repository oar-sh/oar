'use strict';

import { fileURLToPath } from 'url';
import { isExternallySupervised, isRelayRuntimeInvocation, runDirectRelaySupervisor } from './relay-self-restart.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const runtimeArgs = process.argv.slice(2);
const interactiveStdio = process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY;

// `--relay-runtime` marks the child this script spawned. `--supervised` means an
// outer supervisor (the CLI extension) owns restarts and needs to observe exit
// code 75 itself, so the runtime runs in this process instead of a grandchild.
if (isRelayRuntimeInvocation(runtimeArgs) || isExternallySupervised(runtimeArgs)) {
  await import('./server-runtime.mjs');
} else {
  await runDirectRelaySupervisor({
    scriptPath,
    args: runtimeArgs,
    cwd: process.cwd(),
    env: process.env,
    stdio: interactiveStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    logger: console,
  });
}
