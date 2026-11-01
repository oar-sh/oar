// The combined state of a session group, from what each member row already
// knows, and the fold rule of a group in the sidebar. DOM-free.

export const MEMBER_STATE_ORDER = Object.freeze(['waiting', 'running', 'error', 'idle']);

/**
 * A member's class: 'waiting' (a question or approval card sits in it),
 * 'running' (a turn or background work), 'error', or 'idle'.
 */
export function memberStateClass({
  pendingCount = 0,
  visualState = '',
  processing = false,
  activeTurn = false,
  sessionState = '',
} = {}) {
  const visual = String(visualState || '').trim().toLowerCase();
  if (Number(pendingCount) > 0 || visual === 'question') return 'waiting';
  const session = String(sessionState || '').trim().toLowerCase();
  if (processing === true || activeTurn === true || session === 'running_turn' || session === 'background_only') return 'running';
  if (visual === 'error') return 'error';
  return 'idle';
}

/** Counts per class and the strongest class among the members. */
export function summarizeGroupMembers(states = []) {
  const summary = { count: 0, waiting: 0, running: 0, error: 0, idle: 0, strongest: 'idle' };
  for (const state of states) {
    const key = MEMBER_STATE_ORDER.includes(state) ? state : 'idle';
    summary[key] += 1;
    summary.count += 1;
  }
  summary.strongest = MEMBER_STATE_ORDER.find((key) => summary[key] > 0) || 'idle';
  return summary;
}

/**
 * "3 · 1 waiting for you, 2 running" or "3 sessions"; "" for an empty group.
 * The waiting part comes first: it is the reason to look, and a narrow
 * sidebar cuts the end.
 */
export function groupSummaryText(summary) {
  const count = Number(summary?.count || 0);
  if (!count) return '';
  const activity = groupActivityText(summary);
  if (!activity) return groupSessionCountText(count);
  return `${count} · ${activity}`;
}

/** "1 waiting for you, 2 running", or "" while nothing waits, runs or failed. */
export function groupActivityText(summary) {
  const parts = [];
  if (Number(summary?.waiting) > 0) parts.push(`${summary.waiting} waiting for you`);
  if (Number(summary?.running) > 0) parts.push(`${summary.running} running`);
  if (Number(summary?.error) > 0) parts.push(`${summary.error} failed`);
  return parts.join(', ');
}

/** "1 session", "4 sessions". */
export function groupSessionCountText(count) {
  const n = Number(count) || 0;
  return `${n} session${n === 1 ? '' : 's'}`;
}

/** Whether a group has something going on: a member runs or waits. */
export function groupIsActive(summary) {
  return Number(summary?.running || 0) > 0 || Number(summary?.waiting || 0) > 0;
}

/**
 * A member's colour in its group's name: 'waiting', 'running', 'ready' (idle
 * with a live worker, the darker green) or 'offline'. A failed member does
 * not colour the name; the pill says so.
 */
export function memberTone({ memberState = 'idle', visualState = '' } = {}) {
  if (memberState === 'waiting' || memberState === 'running') return memberState;
  return String(visualState || '').trim().toLowerCase() === 'ready' ? 'ready' : 'offline';
}

/**
 * The colour of a group's name from its members' tones: red while one waits
 * for the user, bright green while one works, the darker green while one is
 * ready, else the plain title colour. Returns 'question' | 'working' |
 * 'ready' | 'offline'.
 */
export function groupTitleTone(tones = []) {
  const list = Array.isArray(tones) ? tones : [];
  if (list.includes('waiting')) return 'question';
  if (list.includes('running')) return 'working';
  if (list.includes('ready')) return 'ready';
  return 'offline';
}

/**
 * Open or folded. The user's choice ('open' | 'folded') wins; otherwise a
 * group is open while active and folded once everything is finished. Every
 * group under a title filter is always open. A folded group that holds the
 * open conversation still shows that row (arrangeConversationList's
 * keepVisibleId).
 */
export function resolveGroupFold({ choice = null, active = false, filterActive = false } = {}) {
  if (filterActive) return true;
  if (choice === 'open') return true;
  if (choice === 'folded') return false;
  return active === true;
}

/** The choice to store after a toggle from the current state. */
export function toggledGroupFoldChoice(currentlyOpen) {
  return currentlyOpen ? 'folded' : 'open';
}

/** `{ [groupId]: 'open' | 'folded' }` from storage text; anything else is dropped. */
export function parseGroupFoldChoices(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const choices = {};
  for (const [groupId, choice] of Object.entries(parsed)) {
    if (choice === 'open' || choice === 'folded') choices[String(groupId)] = choice;
  }
  return choices;
}

/** The choices to keep: only those of groups still listed. */
export function pruneGroupFoldChoices(choices, knownGroupIds) {
  const known = new Set((Array.isArray(knownGroupIds) ? knownGroupIds : []).map((id) => String(id)));
  const kept = {};
  for (const [groupId, choice] of Object.entries(choices || {})) {
    if (known.has(groupId)) kept[groupId] = choice;
  }
  return kept;
}
