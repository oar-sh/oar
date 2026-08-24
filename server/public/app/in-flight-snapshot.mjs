// Stable fingerprint of a conversation's in-flight turn payload so the live
// poll can skip tearing down and rebuilding the streaming bubble when nothing
// actually changed since the previous tick.

export function buildInFlightSnapshotKey(inFlight) {
  if (!inFlight || typeof inFlight !== 'object') return 'none';
  const thoughts = (Array.isArray(inFlight.thoughts) ? inFlight.thoughts : []).map((entry) => [
    String(entry?.reasoningId || ''),
    String(entry?.text || ''),
    !!entry?.done,
    String(entry?.subagentRunId || ''),
  ]);
  const activities = (Array.isArray(inFlight.activities) ? inFlight.activities : []).map((entry) => (
    typeof entry === 'string'
      ? entry
      : [String(entry?.text || ''), String(entry?.subagentRunId || '')]
  ));
  const subagentRuns = (Array.isArray(inFlight.subagentRuns) ? inFlight.subagentRuns : []).map((entry) => [
    String(entry?.subagentRunId || ''),
    String(entry?.status || ''),
    String(entry?.parentSubagentId || ''),
    String(entry?.displayName || ''),
  ]);
  const streamEvents = (Array.isArray(inFlight.streamEvents) ? inFlight.streamEvents : []).map((entry) => [
    Number(entry?.seq) || 0,
    String(entry?.text || ''),
    !!entry?.done,
    String(entry?.subagentRunId || ''),
  ]);
  return JSON.stringify({
    messageId: String(inFlight.messageId || ''),
    status: String(inFlight.status || ''),
    lastStreamSeq: Number(inFlight.lastStreamSeq) || 0,
    streamDone: !!inFlight.streamDone,
    thoughts,
    activities,
    subagentRuns,
    streamEvents,
  });
}
