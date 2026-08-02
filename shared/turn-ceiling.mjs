// Absolute cap on how long a single turn may stay in 'processing' before the
// relay requeues it, shared so the settings slider and the recovery sweep agree
// on bounds and formatting.
//
// This is only a backstop. Normal staleness is measured from worker heartbeats
// (see listRecoverableProcessing), and a turn waiting on an unanswered question
// is exempt from both — so the ceiling exists purely for a worker that is hung
// while still heartbeating.

export const TURN_CEILING_MIN_MINUTES = 0;
export const TURN_CEILING_MAX_MINUTES = 600;
export const TURN_CEILING_STEP_MINUTES = 5;
export const DEFAULT_TURN_CEILING_MINUTES = 60;

/** 0 disables the ceiling entirely. */
export function normalizeTurnCeilingMinutes(value, fallback = DEFAULT_TURN_CEILING_MINUTES) {
  // Number('') and Number(null) are both 0, which would silently read as
  // "no limit". Absent input is absent, not a request to disable the ceiling.
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  if (rounded <= TURN_CEILING_MIN_MINUTES) return 0;
  return Math.min(TURN_CEILING_MAX_MINUTES, rounded);
}

export function turnCeilingMinutesToMs(minutes) {
  return normalizeTurnCeilingMinutes(minutes) * 60_000;
}

/** An unset setting means "never configured", which is the default — not 0. */
export function readTurnCeilingSetting(storedValue) {
  const text = storedValue === null || storedValue === undefined ? '' : String(storedValue).trim();
  if (!text) return DEFAULT_TURN_CEILING_MINUTES;
  return normalizeTurnCeilingMinutes(text);
}

export function parseTurnCeilingUpdate(value) {
  const minutes = normalizeTurnCeilingMinutes(value, null);
  if (minutes === null) return { ok: false, error: 'ceilingMinutes must be a number' };
  return { ok: true, minutes };
}

export function formatTurnCeilingLabel(minutes) {
  const normalized = normalizeTurnCeilingMinutes(minutes);
  if (normalized === 0) return 'No limit';
  if (normalized < 60) return `${normalized} min`;
  const hours = Math.floor(normalized / 60);
  const remainder = normalized % 60;
  const hourLabel = `${hours} h`;
  return remainder ? `${hourLabel} ${remainder} min` : hourLabel;
}
