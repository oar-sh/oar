// The sub-agent timeline's vocabulary and limits, shared by the workers that
// write it and the relay that stores and serves it.

export const SUBAGENT_TIMELINE_KINDS = Object.freeze(['thought', 'tool_call', 'tool_result', 'text', 'child', 'note']);

// Entries kept per run. One more, a note, says the record was cut there.
export const SUBAGENT_TIMELINE_MAX_ENTRIES = 2000;

// A tool result is kept to its first 4 KB: enough to see what came back,
// without a file read or a build log filling the database.
export const SUBAGENT_TOOL_RESULT_MAX_CHARS = 4096;

// Safety limit for every other entry (a thought, a tool call's input, reply
// text). Real entries stay far below it.
export const SUBAGENT_TIMELINE_ENTRY_MAX_CHARS = 256 * 1024;

export const SUBAGENT_TIMELINE_TOOL_NAME_MAX_CHARS = 200;

// Background task types that are a sub-agent run, with a model of its own
// (vs. a shell, monitor or workflow): the run a task panel row opens.
export const SUBAGENT_TASK_TYPES = new Set(['local_agent', 'agent', 'subagent']);

export function isSubagentTimelineKind(kind) {
  return SUBAGENT_TIMELINE_KINDS.includes(String(kind || ''));
}

export function subagentTimelineTextLimit(kind) {
  return kind === 'tool_result' ? SUBAGENT_TOOL_RESULT_MAX_CHARS : SUBAGENT_TIMELINE_ENTRY_MAX_CHARS;
}

/**
 * Cut `text` to the limit of its kind. Returns the text kept and, when it was
 * cut, the original length (`cut`), which travels in the entry's metadata so
 * the viewer can say how much is missing. Text a writer already cut keeps the
 * writer's original length.
 */
export function cutSubagentTimelineText(kind, text, { cut: priorCut = null } = {}) {
  const value = String(text ?? '');
  const limit = subagentTimelineTextLimit(kind);
  if (value.length <= limit) return { text: value, cut: Number.isFinite(priorCut) ? priorCut : null };
  return { text: value.slice(0, limit), cut: Number.isFinite(priorCut) ? Math.max(priorCut, value.length) : value.length };
}

// The input fields a tool call is known by, in order of preference. The
// viewer's toolCallSummary (public/app/subagent-timeline-view.mjs) uses the
// same list; a test keeps the two in step.
export const SUBAGENT_TOOL_CALL_SUMMARY_FIELDS = Object.freeze(['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'notebook_path', 'skill']);
export const SUBAGENT_TOOL_CALL_SUMMARY_MAX_CHARS = 200;

/** The one line a tool call is known by: its command, path, pattern… */
export function subagentToolCallSummary(text) {
  const value = String(text || '').trim();
  let input = null;
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
    } catch {}
  }
  if (input) {
    for (const field of SUBAGENT_TOOL_CALL_SUMMARY_FIELDS) {
      const fieldValue = input[field];
      if (typeof fieldValue === 'string' && fieldValue.trim()) return fieldValue.replace(/\s+/g, ' ').trim().slice(0, SUBAGENT_TOOL_CALL_SUMMARY_MAX_CHARS);
    }
    const keys = Object.keys(input);
    return keys.length ? keys.slice(0, 4).join(', ') : '';
  }
  return String(text || '').split('\n')[0].trim().slice(0, SUBAGENT_TOOL_CALL_SUMMARY_MAX_CHARS);
}

/** Status words the relay keeps for a run. */
export function normalizeSubagentRunStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'completed' || value === 'complete' || value === 'done' || value === 'succeeded') return 'completed';
  if (value === 'failed' || value === 'error' || value === 'errored') return 'failed';
  if (value === 'stopped' || value === 'cancelled' || value === 'canceled' || value === 'killed') return 'cancelled';
  if (value === 'running' || value === '') return 'running';
  return value.slice(0, 40);
}

export function isTerminalSubagentRunStatus(status) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
