// Glue between a steering-capable session runner and the relay socket link —
// shared by every worker whose runner exposes a delivery gate (the Claude
// session runner, the Copilot SDK runner). Kept out of the worker entry files
// (which run main() on import) so the wiring itself is testable.

import { requeueOwedRows } from '../worker-crash-guard.mjs';

/**
 * The runner reports every flip of its delivery gate; the link turns them
 * into relay readiness frames. `attach` is late-bound because the runner is
 * built before the link (the link's probes call into the runner).
 */
export function createRunnerLinkBridge() {
  let link = null;
  return {
    attach(nextLink) {
      link = nextLink || null;
    },
    onDeliveryReadinessChange(ready) {
      if (!link) return;
      if (ready) void link.notifyReady('steering-resumed');
      else link.notifyUnready('steering-held');
    },
    // Only a relay that advertised the capability in server.hello understands
    // the penalty-free hand-back; before any hello, assume an older relay.
    canHandBackHeldDelivery() {
      return Boolean(link?.serverSupports?.('steering-held'));
    },
  };
}

/**
 * Worker shutdown (SIGTERM/SIGINT): rows whose prompt the engine already
 * consumed and whose settle has not landed are failed terminally before the
 * process goes — left behind, the relay's dead-worker recovery would requeue
 * them and run them a second time. Bounded like the crash guard: a shutdown
 * that hangs is worse than none. Other owed rows are left to the relay's
 * recovery, as before.
 */
export async function failSettlingRowsOnShutdown({ api, runner, timeoutMs = 2_000 } = {}) {
  const settling = (runner?.getActiveQueueMessageIds?.() || []).filter((entry) => entry?.terminalError);
  await requeueOwedRows({ api, entries: settling, timeoutMs });
  return settling.length;
}
