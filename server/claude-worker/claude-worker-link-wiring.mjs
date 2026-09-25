// The Claude worker's glue between its session runner and the relay socket
// link. The implementation moved to shared/worker-runtime/runner-link-wiring.mjs
// when the Copilot SDK worker adopted the same delivery gate; this module is
// the import path the Claude worker and its tests still use.

export {
  createRunnerLinkBridge,
  failSettlingRowsOnShutdown,
} from '../../shared/worker-runtime/runner-link-wiring.mjs';
