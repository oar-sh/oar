// How long a sub-agent's record keeps its tool inputs and tool results. After
// that the relay's sweep strips them; thoughts, reply text, notes, child rows
// and the run itself stay. Shared so the settings route and the sweep agree.

export const SUBAGENT_RECORD_RETENTION_SETTING_KEY = 'subagent_record_retention_days';

// 0 turns pruning off.
export const SUBAGENT_RECORD_RETENTION_CHOICES = Object.freeze([0, 7, 14, 30, 90]);
export const DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS = 90;

function asChoice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return null;
  return SUBAGENT_RECORD_RETENTION_CHOICES.includes(numeric) ? numeric : null;
}

/** An unset or unreadable setting means the default, not "off". */
export function readSubagentRecordRetentionSetting(storedValue) {
  const days = asChoice(storedValue);
  return days === null ? DEFAULT_SUBAGENT_RECORD_RETENTION_DAYS : days;
}

export function parseSubagentRecordRetentionUpdate(value) {
  const days = asChoice(value);
  if (days === null) {
    return { ok: false, error: `retentionDays must be one of ${SUBAGENT_RECORD_RETENTION_CHOICES.join(', ')}` };
  }
  return { ok: true, days };
}
