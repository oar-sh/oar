'use strict';

import {
  SUBAGENT_TIMELINE_MAX_ENTRIES,
  SUBAGENT_TIMELINE_TOOL_NAME_MAX_CHARS,
  cutSubagentTimelineText,
  isSubagentTimelineKind,
  normalizeSubagentRunStatus,
} from '../../shared/subagent-timeline.mjs';
import { sanitizeSubagentRunId } from '../../shared/subagent-run-id.mjs';

export const TIMELINE_READ_DEFAULT_LIMIT = 500;
export const TIMELINE_READ_MAX_LIMIT = 2000;
const ENTRY_KEY_MAX_CHARS = 200;
const METADATA_MAX_CHARS = 4096;
const LEGACY_ROW_LIMIT = 2000;
export const TRUNCATED_NOTE_KEY = 'relay:truncated';

function parseJson(raw) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function finiteOrNull(value) {
  const number = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : null;
}

function cleanText(value, max) {
  const text = String(value ?? '').trim();
  return text ? text.slice(0, max) : null;
}

/** The run as the browser sees it: the row panel, bubble and viewer render. */
export function mapSubagentRunHeader(row, { stoppable = false, legacy = false } = {}) {
  const id = String(row?.id || '').trim();
  if (!id) return null;
  return {
    subagentRunId: id,
    messageId: String(row?.queue_message_id || '').trim() || null,
    conversationId: String(row?.conversation_id || '').trim() || null,
    parentSubagentId: row?.parent_subagent_id ? String(row.parent_subagent_id).trim() : null,
    displayName: row?.display_name ? String(row.display_name).trim() : null,
    status: String(row?.status || 'running').trim().toLowerCase() || 'running',
    startedAt: row?.started_at || null,
    updatedAt: row?.updated_at || null,
    completedAt: row?.completed_at || null,
    model: row?.model ? String(row.model) : null,
    modelInherited: row?.model_inherited === null || row?.model_inherited === undefined ? null : Number(row.model_inherited) === 1,
    subagentType: row?.subagent_type ? String(row.subagent_type) : null,
    taskId: row?.task_id ? String(row.task_id) : null,
    totalTokens: finiteOrNull(row?.total_tokens),
    background: Number(row?.background || 0) === 1,
    truncated: Number(row?.truncated || 0) === 1,
    timelineOwner: row?.timeline_owner ? String(row.timeline_owner) : null,
    stoppable: !!stoppable,
    ...(legacy ? { legacy: true } : {}),
  };
}

function mapTimelineRow(row) {
  return {
    seq: Number(row.seq),
    kind: String(row.kind),
    text: row.text === null || row.text === undefined ? '' : String(row.text),
    toolName: row.tool_name || null,
    toolUseId: row.tool_use_id || null,
    metadata: parseJson(row.metadata_json),
    done: Number(row.done) === 1,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

/**
 * One entry as a writer sent it, made safe to store: a known kind, a key, the
 * text cut to its kind's limit (the original length goes into the metadata),
 * small metadata only. Null for anything that cannot be stored.
 */
export function sanitizeTimelineEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '').trim();
  if (!isSubagentTimelineKind(kind)) return null;
  const key = String(raw.key ?? '').trim().slice(0, ENTRY_KEY_MAX_CHARS);
  if (!key) return null;
  let metadata = raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? { ...raw.metadata } : null;
  const priorCut = finiteOrNull(metadata?.cut);
  const { text, cut } = cutSubagentTimelineText(kind, raw.text, { cut: priorCut });
  if (cut !== null) metadata = { ...(metadata || {}), cut };
  let metadataJson = metadata ? JSON.stringify(metadata) : null;
  if (metadataJson && metadataJson.length > METADATA_MAX_CHARS) metadataJson = cut !== null ? JSON.stringify({ cut }) : null;
  return {
    key,
    kind,
    text,
    toolName: cleanText(raw.toolName, SUBAGENT_TIMELINE_TOOL_NAME_MAX_CHARS),
    toolUseId: sanitizeSubagentRunId(raw.toolUseId) || null,
    metadataJson,
    done: raw.done === false ? 0 : 1,
  };
}

/** A header patch as a writer sent it. Unknown or empty fields stay null. */
export function sanitizeRunHeaderPatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const totalTokens = finiteOrNull(raw.totalTokens);
  const patch = {
    model: cleanText(raw.model, 120),
    modelInherited: typeof raw.modelInherited === 'boolean' ? (raw.modelInherited ? 1 : 0) : null,
    subagentType: cleanText(raw.subagentType, 120),
    taskId: cleanText(raw.taskId, 200),
    totalTokens: totalTokens === null ? null : Math.max(0, Math.round(totalTokens)),
    background: raw.background === true ? 1 : null,
    truncated: raw.truncated === true ? 1 : null,
    timelineOwner: cleanText(raw.timelineOwner, 40),
    status: raw.status ? normalizeSubagentRunStatus(raw.status) : null,
  };
  return Object.values(patch).some((value) => value !== null) ? patch : null;
}

export function createSubagentTimelineService({ db, stmts, now = () => new Date().toISOString() } = {}) {
  const supported = () => !!stmts?.subagentTimelineSupported && typeof stmts?.insertTimelineEntry?.run === 'function';
  const headerSupported = () => typeof stmts?.updateSubagentRunHeader?.run === 'function';

  /**
   * Write a header patch onto a run. A status names the run's end (or its
   * return to running); the end time is stamped once. Returns the updated row,
   * or null when nothing was written.
   */
  function applyHeader(runId, patch) {
    if (!patch) return null;
    const at = now();
    const { status, ...fields } = patch;
    const hasFields = Object.values(fields).some((value) => value !== null);
    if (hasFields && headerSupported()) {
      stmts.updateSubagentRunHeader.run({ id: runId, updatedAt: at, ...fields });
    }
    if (status === 'running' && typeof stmts.reopenSubagentRun?.run === 'function') {
      // Running (again, for a resumed agent): the end of an earlier run goes.
      stmts.reopenSubagentRun.run(at, runId);
    } else if (status) {
      const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
      stmts.updateSubagentRunStatus?.run?.(status, at, terminal ? at : null, runId);
    }
    return stmts.getSubagentRun?.get?.(runId) || null;
  }

  /**
   * Store a batch of entries for a run. A known key updates its entry in
   * place; a new key takes the next seq. Past the per-run limit one note says
   * the record was cut, the run is marked truncated, and later new entries are
   * dropped (updates to entries already kept still land). Returns the entries
   * as stored, for the live event.
   */
  function applyEntries(run, rawEntries) {
    if (!supported() || !run) return { entries: [], truncated: false };
    const runId = String(run.id);
    const conversationId = String(run.conversation_id);
    const queueMessageId = run.queue_message_id ? String(run.queue_message_id) : null;
    const entries = (Array.isArray(rawEntries) ? rawEntries : []).map(sanitizeTimelineEntry).filter(Boolean);
    const stored = [];
    let truncated = false;
    const tx = db.transaction(() => {
      let maxSeq = Number(stmts.getMaxTimelineSeq.get(runId)?.max_seq || 0);
      for (const entry of entries) {
        const at = now();
        const existing = stmts.getTimelineEntryByKey.get(runId, entry.key);
        if (existing) {
          stmts.updateTimelineEntryByKey.run({
            runId,
            entryKey: entry.key,
            text: entry.text,
            toolName: entry.toolName,
            toolUseId: entry.toolUseId,
            metadataJson: entry.metadataJson,
            done: entry.done,
            updatedAt: at,
          });
          stored.push(Number(existing.seq));
          continue;
        }
        if (maxSeq >= SUBAGENT_TIMELINE_MAX_ENTRIES) {
          if (!stmts.getTimelineEntryByKey.get(runId, TRUNCATED_NOTE_KEY)) {
            maxSeq += 1;
            stmts.insertTimelineEntry.run({
              runId,
              conversationId,
              queueMessageId,
              entryKey: TRUNCATED_NOTE_KEY,
              seq: maxSeq,
              kind: 'note',
              text: `The record stops here: a sub-agent keeps at most ${SUBAGENT_TIMELINE_MAX_ENTRIES} entries.`,
              toolName: null,
              toolUseId: null,
              metadataJson: JSON.stringify({ truncated: true }),
              done: 1,
              createdAt: at,
              updatedAt: at,
            });
            stmts.setSubagentRunTruncated?.run?.(at, runId);
            stored.push(maxSeq);
          }
          truncated = true;
          continue;
        }
        maxSeq += 1;
        stmts.insertTimelineEntry.run({
          runId,
          conversationId,
          queueMessageId,
          entryKey: entry.key,
          seq: maxSeq,
          kind: entry.kind,
          text: entry.text,
          toolName: entry.toolName,
          toolUseId: entry.toolUseId,
          metadataJson: entry.metadataJson,
          done: entry.done,
          createdAt: at,
          updatedAt: at,
        });
        stored.push(maxSeq);
      }
    });
    tx.immediate ? tx.immediate() : tx();
    if (!stored.length) return { entries: [], truncated };
    const seqs = new Set(stored);
    const minSeq = Math.min(...stored);
    const rows = stmts.listTimelineEntries.all({ runId, afterSeq: minSeq - 1, limit: TIMELINE_READ_MAX_LIMIT })
      .filter((row) => seqs.has(Number(row.seq)));
    return { entries: rows.map(mapTimelineRow), truncated };
  }

  /**
   * A frame Copilot or Cursor published on a sub-agent lane, copied into the
   * run's timeline (the Claude worker writes its own). The key keeps one entry
   * per thought and one reply text per run, updated in place.
   */
  function mirrorFrame({ runId, kind, key, text, done = true, toolName = null, metadata = null }) {
    if (!supported()) return null;
    const run = stmts.getSubagentRun?.get?.(runId) || null;
    if (!run || String(run.timeline_owner || '') === 'worker') return null;
    const result = applyEntries(run, [{ key, kind, text, done, toolName, metadata }]);
    if (!result.entries.length) return null;
    return { run, entries: result.entries, truncated: result.truncated };
  }

  function legacyEntries(runId) {
    const rows = [];
    for (const row of stmts.listLegacyThoughtsBySubagentRun?.all?.(runId, LEGACY_ROW_LIMIT) || []) {
      rows.push({ kind: 'thought', text: String(row.text || ''), done: Number(row.done) === 1, createdAt: row.created_at, order: 1 });
    }
    for (const row of stmts.listLegacyActivityBySubagentRun?.all?.(runId, LEGACY_ROW_LIMIT) || []) {
      const text = String(row.text || '');
      const toolMatch = /^Tool \(([^)]+)\)/.exec(text);
      rows.push({
        kind: toolMatch ? 'tool_call' : 'note',
        text,
        toolName: toolMatch ? toolMatch[1] : null,
        done: true,
        createdAt: row.created_at,
        order: 2,
        metadata: { legacy: true },
      });
    }
    for (const row of stmts.listLegacyStreamBySubagentRun?.all?.(runId, LEGACY_ROW_LIMIT) || []) {
      const text = String(row.text || '');
      if (!text.trim()) continue;
      rows.push({ kind: 'text', text, done: Number(row.done) === 1, createdAt: row.created_at, order: 3 });
    }
    rows.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.order - b.order);
    return rows.map((row, index) => ({
      seq: index + 1,
      kind: row.kind,
      text: row.text,
      toolName: row.toolName || null,
      toolUseId: null,
      metadata: row.metadata || null,
      done: row.done,
      createdAt: row.createdAt || null,
      updatedAt: row.createdAt || null,
    }));
  }

  /**
   * A run's record for the viewer: entries after `afterSeq` (plus open ones),
   * its child runs, and whether this page reached the end. A run with no
   * timeline rows that no worker owns is served from what it recorded before
   * the timeline existed.
   */
  function readTimeline(run, { afterSeq = 0, limit = TIMELINE_READ_DEFAULT_LIMIT, isStoppable = () => false } = {}) {
    const runId = String(run.id);
    const pageLimit = Math.max(1, Math.min(TIMELINE_READ_MAX_LIMIT, Number(limit) || TIMELINE_READ_DEFAULT_LIMIT));
    const after = Math.max(0, Number(afterSeq) || 0);
    const children = (stmts.listChildSubagentRuns?.all?.(runId) || [])
      .map((row) => mapSubagentRunHeader(row, { stoppable: isStoppable(row) }))
      .filter(Boolean);
    let entries = [];
    let legacy = false;
    let complete = true;
    if (supported()) {
      const rows = stmts.listTimelineEntries.all({ runId, afterSeq: after, limit: pageLimit + 1 });
      complete = rows.length <= pageLimit;
      entries = rows.slice(0, pageLimit).map(mapTimelineRow);
      const hasAny = after > 0 || entries.length > 0 || Number(stmts.getMaxTimelineSeq.get(runId)?.max_seq || 0) > 0;
      if (!hasAny && !run.timeline_owner) {
        entries = after > 0 ? [] : legacyEntries(runId);
        legacy = entries.length > 0;
        complete = true;
      }
    } else if (after === 0) {
      entries = legacyEntries(runId);
      legacy = entries.length > 0;
    }
    const lastSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), after);
    return {
      run: mapSubagentRunHeader(run, { stoppable: isStoppable(run), legacy }),
      entries,
      children,
      nextAfter: lastSeq,
      complete,
    };
  }

  return { applyHeader, applyEntries, mirrorFrame, readTimeline, supported };
}
