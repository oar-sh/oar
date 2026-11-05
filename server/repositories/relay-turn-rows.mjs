// A turn's stored thought and tool-line rows as the browser receives them
// (the message payload and the in-flight snapshot). Pure, so the payload
// shape is tested without booting the relay (server-runtime.mjs uses these).

export function sanitizeActivityText(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.slice(0, 200);
}

// A row's place in its turn's order (migration 0038), or null: a row from
// before it, or a database without the column.
function rowTurnSeq(row) {
  if (row?.turn_seq === null || row?.turn_seq === undefined) return null;
  const value = Number(row.turn_seq);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function mapRelayActivityRow(row) {
  const text = sanitizeActivityText(row?.text);
  if (!text) return null;
  const subagentRunId = row?.subagent_run_id ? String(row.subagent_run_id).trim() : null;
  // Structured rows (compaction boundaries) carry their payload alongside the
  // prose so the transcript can promote them to a break row; junk JSON is
  // simply dropped back to a prose-only entry.
  let metadata = null;
  if (row?.metadata_json) {
    try {
      const parsed = JSON.parse(String(row.metadata_json));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch { metadata = null; }
  }
  // Only a numbered row says so: the payload of an unnumbered one is as before.
  const turnSeq = rowTurnSeq(row);
  return {
    text,
    subagentRunId: subagentRunId || null,
    ...(metadata ? { metadata } : {}),
    ...(turnSeq !== null ? { turnSeq } : {}),
  };
}

export function mapRelayThoughtRow(row) {
  const seq = Math.max(0, Math.trunc(Number(row?.seq || 0)));
  const subagentRunId = row?.subagent_run_id ? String(row.subagent_run_id).trim() : null;
  const turnSeq = rowTurnSeq(row);
  return {
    reasoningId: row?.reasoning_id ? String(row.reasoning_id) : null,
    seq,
    text: String(row?.text || ''),
    done: Number(row?.done || 0) === 1,
    timestamp: row?.created_at || null,
    subagentRunId: subagentRunId || null,
    ...(turnSeq !== null ? { turnSeq } : {}),
  };
}
