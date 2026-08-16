/**
 * Sanitize a provider-reported subagent call id before it becomes a database
 * row id. Malformed ids have been seen live (an embedded newline; two
 * concatenated tool ids): they round-trip into URLs and DOM lookups, and while
 * the client escapes them, a control character inside a primary key helps
 * nobody. Non-printable runs collapse to a single dash and the id is capped.
 */
export function sanitizeSubagentRunId(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/[^\x21-\x7E]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleaned) return null;
  return cleaned.slice(0, 128);
}
