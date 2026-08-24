/**
 * Count bullet or numbered lines in a reply. Provider workers use this as the
 * plan-mode fallback heuristic: a plan-mode turn whose final text contains at
 * least two plan-like lines gets a `plan_ready` board even when the runtime
 * never signalled plan completion explicitly.
 */
export function countPlanLikeLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]\s+|\d+\.\s+)/.test(line))
    .length;
}
