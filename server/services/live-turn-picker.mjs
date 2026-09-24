// Which of a conversation's processing queue rows is the LIVE turn.
//
// Mid-turn steering means a conversation can have more than one row in
// `processing` at once: the running turn plus a message the user steered in,
// which the CLI folds into that turn and which produces no stream or activity
// of its own — or, after a replay handoff, the row that just took the turn
// over while the handed-off row is still settling. The live turn is the row
// that produced output MOST RECENTLY; with no output to separate them, the
// oldest processing row (the turn a steered message joins). Kept pure so the
// tie-break rules are testable without a DB.
//
// Recency, not volume: relay_stream_events.seq is only unique within one
// queue_message_id, so comparing it across rows picked "the row with the most
// events" — a long handed-off turn kept the live bubble (and Stop) from the
// row that had actually taken over.

/**
 * @param {Array<{id:string, lastOutputAtMs?:number, streamDone?:boolean, processingAtMs?:number}>} rows
 *   Processing rows for one conversation. `lastOutputAtMs` is when the row
 *   last wrote a stream snapshot or activity line (0 = never); `streamDone`
 *   marks a row whose main stream snapshot is final — a handed-off row
 *   settling, whose closing snapshot re-stamps it as the newest write — and
 *   ranks it below every row still open; `processingAtMs` is when it entered
 *   processing (final tie-break; smaller = older = wins).
 * @returns {string} the live turn's row id, or '' when there are no rows.
 */
export function pickLiveTurnRowId(rows = []) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && row.id) : [];
  if (!list.length) return '';
  if (list.length === 1) return String(list[0].id);
  const finite = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  let best = null;
  for (const row of list) {
    if (!best) { best = row; continue; }
    if (Boolean(row.streamDone) !== Boolean(best.streamDone)) {
      if (!row.streamDone) best = row;
      continue;
    }
    const output = finite(row.lastOutputAtMs);
    const bestOutput = finite(best.lastOutputAtMs);
    if (output > bestOutput
      || (output === bestOutput && finite(row.processingAtMs) < finite(best.processingAtMs))) {
      best = row;
    }
  }
  return String(best.id);
}
