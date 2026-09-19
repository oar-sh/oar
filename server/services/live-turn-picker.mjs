// Which of a conversation's processing queue rows is the LIVE turn.
//
// Mid-turn steering means a conversation can have more than one row in
// `processing` at once: the running turn plus a message the user steered in,
// which the CLI folds into that turn and which produces no stream or activity
// of its own. The live turn is therefore the processing row that is actually
// producing output — most recent stream event, then most activity — and, with
// nothing yet to separate them, the oldest processing row (the turn a steered
// message joins). Kept pure so the tie-break rules are testable without a DB.

/**
 * @param {Array<{id:string, lastStreamSeq?:number, activityCount?:number, processingAtMs?:number}>} rows
 *   Processing rows for one conversation. `processingAtMs` is when the row
 *   entered processing (used only as the final tie-break; smaller = older = wins).
 * @returns {string} the live turn's row id, or '' when there are no rows.
 */
export function pickLiveTurnRowId(rows = []) {
  const list = Array.isArray(rows) ? rows.filter((row) => row && row.id) : [];
  if (!list.length) return '';
  if (list.length === 1) return String(list[0].id);
  let best = null;
  let bestScore = null;
  for (const row of list) {
    const score = {
      lastStreamSeq: Number(row.lastStreamSeq || 0),
      activityCount: Number(row.activityCount || 0),
      // Older row wins the final tie: negate so "greater score" stays "more live".
      startedAtMs: -(Number.isFinite(Number(row.processingAtMs)) ? Number(row.processingAtMs) : 0),
    };
    const better = !bestScore
      || score.lastStreamSeq > bestScore.lastStreamSeq
      || (score.lastStreamSeq === bestScore.lastStreamSeq && score.activityCount > bestScore.activityCount)
      || (score.lastStreamSeq === bestScore.lastStreamSeq
        && score.activityCount === bestScore.activityCount
        && score.startedAtMs > bestScore.startedAtMs);
    if (better) { best = row; bestScore = score; }
  }
  return String((best || list[0]).id);
}
