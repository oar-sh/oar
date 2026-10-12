'use strict';

// Sub-agent viewer: the timeline table, the run header columns and their SQL
// in one place. On a database the 0009 migration has not reached yet the
// timeline statements are null and the header columns read as absent; every
// caller treats that as "no timeline" and falls back to the activity, thought
// and stream rows a run has always had.

const HEADER_COLUMNS = [
  'model',
  'model_inherited',
  'subagent_type',
  'task_id',
  'total_tokens',
  'background',
  'truncated',
  'timeline_owner',
];

const BASE_RUN_COLUMNS = [
  'id',
  'queue_message_id',
  'conversation_id',
  'parent_subagent_id',
  'display_name',
  'status',
  'started_at',
  'updated_at',
  'completed_at',
];

export function createSubagentTimelineStatements(db) {
  const tableNames = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => String(row.name)),
  );
  if (!tableNames.has('subagent_runs')) {
    return { subagentRunsSupportHeader: false, subagentTimelineSupported: false, subagentRunSelectColumns: BASE_RUN_COLUMNS.join(', ') };
  }
  const runColumns = new Set(db.prepare(`PRAGMA table_info(subagent_runs)`).all().map((column) => String(column.name)));
  const subagentRunsSupportHeader = HEADER_COLUMNS.every((name) => runColumns.has(name));
  const subagentTimelineSupported = subagentRunsSupportHeader && tableNames.has('subagent_timeline');
  const subagentRunSelectColumns = [...BASE_RUN_COLUMNS, ...(subagentRunsSupportHeader ? HEADER_COLUMNS : [])].join(', ');

  const statements = {
    subagentRunsSupportHeader,
    subagentTimelineSupported,
    // The column list every run read uses, so the header travels with the
    // run wherever runs are listed (conversation payload, in-flight snapshot).
    subagentRunSelectColumns,
    updateSubagentRunHeader: null,
    setSubagentRunTruncated: null,
    listChildSubagentRuns: null,
    getSubagentRunByTaskId: null,
    listRunningBackgroundSubagentRunsForSession: null,
    getTimelineEntryByKey: null,
    getMaxTimelineSeq: null,
    countTimelineEntries: null,
    insertTimelineEntry: null,
    updateTimelineEntryByKey: null,
    listTimelineEntries: null,
    deleteConvSubagentTimeline: null,
    listLegacyActivityBySubagentRun: null,
    listLegacyThoughtsBySubagentRun: null,
    listLegacyStreamBySubagentRun: null,
  };

  // What a run recorded before the timeline existed: its tagged activity
  // lines, thoughts and reply text. The viewer reads these for an old run.
  const hasRunColumn = (table) => tableNames.has(table)
    && db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'subagent_run_id');
  if (hasRunColumn('relay_activity')) {
    statements.listLegacyActivityBySubagentRun = db.prepare(`
      SELECT id, text, metadata_json, created_at FROM relay_activity
      WHERE subagent_run_id = ? ORDER BY id ASC LIMIT ?
    `);
  }
  if (hasRunColumn('relay_thought')) {
    statements.listLegacyThoughtsBySubagentRun = db.prepare(`
      SELECT reasoning_id, seq, text, done, created_at FROM relay_thought
      WHERE subagent_run_id = ? ORDER BY seq ASC, id ASC LIMIT ?
    `);
  }
  if (hasRunColumn('relay_stream_events')) {
    statements.listLegacyStreamBySubagentRun = db.prepare(`
      SELECT text, done, created_at FROM relay_stream_events
      WHERE subagent_run_id = ? ORDER BY seq ASC, id ASC LIMIT ?
    `);
  }
  if (!subagentRunsSupportHeader) return statements;

  // A patch, not a replace: every field the writer did not name (NULL) keeps
  // what the row has. `background` and `truncated` only ever turn on, and the
  // timeline owner is claimed once.
  statements.updateSubagentRunHeader = db.prepare(`
    UPDATE subagent_runs
    SET model = COALESCE(@model, model),
        model_inherited = COALESCE(@modelInherited, model_inherited),
        subagent_type = COALESCE(@subagentType, subagent_type),
        task_id = COALESCE(@taskId, task_id),
        total_tokens = COALESCE(@totalTokens, total_tokens),
        background = MAX(background, COALESCE(@background, 0)),
        truncated = MAX(truncated, COALESCE(@truncated, 0)),
        timeline_owner = COALESCE(timeline_owner, @timelineOwner),
        updated_at = @updatedAt
    WHERE id = @id
  `);
  statements.setSubagentRunTruncated = db.prepare(`UPDATE subagent_runs SET truncated = 1, updated_at = ? WHERE id = ?`);
  statements.listChildSubagentRuns = db.prepare(`
    SELECT ${subagentRunSelectColumns}
    FROM subagent_runs
    WHERE parent_subagent_id = ?
    ORDER BY started_at ASC, id ASC
  `);
  // A worker's live background agents: what dies with it.
  if (tableNames.has('conversations')) {
    statements.listRunningBackgroundSubagentRunsForSession = db.prepare(`
      SELECT ${subagentRunSelectColumns}
      FROM subagent_runs
      WHERE status = 'running' AND background = 1
        AND conversation_id IN (SELECT id FROM conversations WHERE sdk_session_id = ? OR id = ?)
    `);
  }
  statements.getSubagentRunByTaskId = db.prepare(`
    SELECT ${subagentRunSelectColumns}
    FROM subagent_runs
    WHERE conversation_id = ? AND task_id = ?
    ORDER BY started_at DESC
    LIMIT 1
  `);

  if (!subagentTimelineSupported) return statements;

  statements.getTimelineEntryByKey = db.prepare(`SELECT id, seq, done FROM subagent_timeline WHERE run_id = ? AND entry_key = ?`);
  statements.getMaxTimelineSeq = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM subagent_timeline WHERE run_id = ?`);
  statements.countTimelineEntries = db.prepare(`SELECT COUNT(*) AS cnt FROM subagent_timeline WHERE run_id = ?`);
  statements.insertTimelineEntry = db.prepare(`
    INSERT INTO subagent_timeline (
      run_id, conversation_id, queue_message_id, entry_key, seq, kind, text, tool_name, tool_use_id,
      metadata_json, done, created_at, updated_at
    ) VALUES (
      @runId, @conversationId, @queueMessageId, @entryKey, @seq, @kind, @text, @toolName, @toolUseId,
      @metadataJson, @done, @createdAt, @updatedAt
    )
  `);
  // In place: the entry keeps its seq (its place in the order). A closed
  // entry stays closed, though its text may still be corrected (the complete
  // copy of a block that streamed).
  statements.updateTimelineEntryByKey = db.prepare(`
    UPDATE subagent_timeline
    SET text = @text,
        tool_name = COALESCE(@toolName, tool_name),
        tool_use_id = COALESCE(@toolUseId, tool_use_id),
        metadata_json = COALESCE(@metadataJson, metadata_json),
        done = MAX(done, @done),
        updated_at = @updatedAt
    WHERE run_id = @runId AND entry_key = @entryKey
  `);
  // Everything after `afterSeq`, plus whatever is still open before it: an
  // open entry changes in place, so a reader that already has its seq still
  // needs its newer text.
  statements.listTimelineEntries = db.prepare(`
    SELECT seq, kind, text, tool_name, tool_use_id, metadata_json, done, created_at, updated_at
    FROM subagent_timeline
    WHERE run_id = @runId AND (seq > @afterSeq OR done = 0)
    ORDER BY seq ASC
    LIMIT @limit
  `);
  statements.deleteConvSubagentTimeline = db.prepare(`DELETE FROM subagent_timeline WHERE conversation_id = ?`);
  return statements;
}
