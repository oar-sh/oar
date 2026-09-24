// The terminal outcome of a turn the user stopped — what the relay records
// when a worker acknowledges an abort control. Shared so a worker that dies
// before its ack lands fails the stopped row the same way instead of letting
// it be requeued (a requeue re-runs a prompt the user explicitly stopped).
export function buildRelayStopFailure() {
  return {
    kind: 'turn-aborted',
    error: 'turn-aborted',
    code: 'turn-aborted',
    stableCode: 'relay.turn-aborted',
    message: 'System note: This turn was stopped from the relay UI before completion.',
    guidance: 'Send a new message to continue when you are ready.',
    failedAt: new Date().toISOString(),
  };
}
