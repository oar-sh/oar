export const DEFAULT_QUESTION_TIMEOUT_MS = 8 * 60 * 60_000;
export const QUESTION_TIMEOUT_CONTINUATION_TEXT = "[No user response before timeout — continue according to the current relay mode.]";

/**
 * Absolute expiry for a relay question. Only an actual finite number is
 * honored (including 0); anything else — absent, `null`, strings, junk —
 * falls back to the default. The strictness is deliberate: coercing here is
 * how `Number(null) === 0` silently produced questions that expired the
 * moment they were created (the pre-2026-09 relay-question-ui e2e flake),
 * and for a timeout the safe failure direction is "lives 8h", never
 * "expires now".
 */
export function questionExpiresAt(createdAt, timeoutMs = DEFAULT_QUESTION_TIMEOUT_MS) {
  const normalizedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(0, Math.trunc(timeoutMs))
    : DEFAULT_QUESTION_TIMEOUT_MS;
  return new Date(new Date(createdAt).getTime() + normalizedTimeoutMs).toISOString();
}
