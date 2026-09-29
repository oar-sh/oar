// Whether a live subagent bubble is shown folded (header only), and what the
// header says while it is.
//
// A running turn can hold many subagents, and each keeps its whole transcript
// in its bubble: on a phone that is screens of text to scroll past to reach
// the turn's own output. So a bubble is folded from the start and stays folded
// until the user opens it; what they chose by hand holds, in either direction,
// for as long as the bubble lives. The folded header makes up for it with one
// line: how many steps the run has taken and the latest one.

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'dropped', 'done']);

export function isTerminalSubagentStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
}

/**
 * `choice` is the user's own: 'open', 'folded', or nothing.
 */
export function resolveSubagentFold({ choice = null } = {}) {
  return choice !== 'open';
}

/** The choice a tap on the header records, given what the bubble shows now. */
export function toggledSubagentFoldChoice(folded) {
  return folded ? 'open' : 'folded';
}

const SUMMARY_MAX_CHARS = 160;

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/**
 * The line a folded header shows: the number of steps (activity lines) and
 * the latest one, or the end of what the run has written when it has taken
 * no step yet. Empty when there is nothing to say.
 */
export function subagentFoldSummary({ activities = [], streamText = '' } = {}) {
  const steps = (Array.isArray(activities) ? activities : []).map(oneLine).filter(Boolean);
  if (steps.length) {
    const latest = steps[steps.length - 1];
    const count = steps.length === 1 ? '1 step' : `${steps.length} steps`;
    return `${count} · ${latest}`.slice(0, SUMMARY_MAX_CHARS);
  }
  const lines = String(streamText || '').split(/\r?\n/).map(oneLine).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, SUMMARY_MAX_CHARS) : '';
}

/**
 * The status a run has after an update. Most updates report none (an
 * activity line, a stream frame, a restored snapshot's activity list), and
 * those must leave the status alone: reading "no status" as "running" turned
 * every finished run back into a running one on the next line of any kind.
 */
export function nextSubagentStatus({ reported, known, normalize = (value) => value } = {}) {
  const text = String(reported || '').trim();
  if (text) return normalize(text);
  return String(known || '').trim() || 'running';
}
