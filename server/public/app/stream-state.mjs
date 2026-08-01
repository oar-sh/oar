export function normalizeStreamSeq(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.trunc(numeric));
}

export function deriveLatestInFlightStreamEvent(inFlight) {
  const rows = Array.isArray(inFlight?.streamEvents) ? inFlight.streamEvents : [];
  if (!rows.length) return null;
  let latest = null;
  for (const row of rows) {
    const seq = normalizeStreamSeq(row?.seq);
    if (seq === null) continue;
    if (!latest || seq > latest.seq) {
      latest = {
        seq,
        text: String(row?.text || ''),
        done: !!row?.done,
      };
    }
  }
  return latest;
}

/**
 * Latest persisted stream row per thread, so a reload can repaint the main
 * reply preview and every subagent bubble. `deriveLatestInFlightStreamEvent`
 * collapses all threads into one row, which is right for the shared seq/done
 * state machine but loses the per-thread text.
 *
 * Returns `{ main, bySubagentRunId }` — `main` is null when the turn has only
 * produced subagent output so far.
 */
export function deriveInFlightStreamTextByThread(inFlight) {
  const rows = Array.isArray(inFlight?.streamEvents) ? inFlight.streamEvents : [];
  let main = null;
  const bySubagentRunId = new Map();
  for (const row of rows) {
    const seq = normalizeStreamSeq(row?.seq);
    if (seq === null) continue;
    const entry = { seq, text: String(row?.text || ''), done: !!row?.done };
    const subagentRunId = String(row?.subagentRunId || '').trim();
    if (!subagentRunId) {
      if (!main || seq > main.seq) main = entry;
      continue;
    }
    const previous = bySubagentRunId.get(subagentRunId);
    if (!previous || seq > previous.seq) bySubagentRunId.set(subagentRunId, entry);
  }
  return { main, bySubagentRunId };
}

export function computeNextRelayStreamState(previousState = null, incoming = null) {
  const previous = previousState && typeof previousState === 'object'
    ? previousState
    : { seq: 0, done: false };
  const nextSeq = normalizeStreamSeq(incoming?.seq);
  const incomingDone = !!incoming?.done;
  if (nextSeq !== null && nextSeq <= Number(previous.seq || 0)) {
    return { accept: false, state: previous };
  }
  if (previous.done && !incomingDone) {
    return { accept: false, state: previous };
  }
  return {
    accept: true,
    state: {
      seq: nextSeq === null ? Number(previous.seq || 0) : nextSeq,
      done: previous.done || incomingDone,
    },
  };
}
