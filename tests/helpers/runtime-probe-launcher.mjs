// The runtime as server/server.js starts it (`await import`), under
// tests/helpers/runtime-probe.mjs, which also learns the runtime's exports.
// Arguments (`--token`, `--port`, `--owner-pid`) are read by the runtime
// from process.argv as they are.

import { recordExports } from './runtime-probe.mjs';

const runtime = await import('../../server/server-runtime.mjs');
recordExports(Object.keys(runtime));
