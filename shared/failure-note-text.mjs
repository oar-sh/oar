// What makes a text a failure note of the relay.
//
// A failed turn is reported as a record. Where only text is there (a sender
// that reports a failure as text, a reply read from another relay), the note
// is known by its shape: one paragraph that leads up to "Error code:
// relay.<code>" within a few sentences. A reply that quotes or describes such
// a note, in a report on a failed test for example, is a reply.
//
// One rule for every reader: the relay's response route and the remote-relay
// dispatcher must not disagree about what a failure is.

export const FAILURE_NOTE_LEAD_MAX = 600;

const CODE_PATTERN = /error code:\s*(relay\.[a-z0-9-]+)/i;
// Somebody is talking about a note: the code stands in quotation marks, in a
// code span or a table cell, or the paragraph is a list item, a heading or a
// quotation.
const QUOTED_LEAD = /["“”'`|>]\s*$/;
const MARKUP_LEAD = /^\s*(?:#+|[>|*-]|\d+\.)\s/;

/**
 * `{ stableCode, index, lead }` when `text` is a failure note, else null.
 * `index` is where "Error code" begins, `lead` the text before it.
 */
export function matchFailureNote(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const match = CODE_PATTERN.exec(raw);
  if (!match) return null;
  const lead = raw.slice(0, match.index);
  if (lead.length > FAILURE_NOTE_LEAD_MAX || /[\r\n]/.test(lead)) return null;
  if (QUOTED_LEAD.test(lead) || MARKUP_LEAD.test(lead)) return null;
  return { stableCode: match[1].toLowerCase(), index: match.index, lead };
}

export function isFailureNoteText(text) {
  return matchFailureNote(text) !== null;
}
