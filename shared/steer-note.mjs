// The hidden note a steered message carries to the model.
//
// A message the user sends while a turn is running is pushed into that turn
// (steering). When it lands before the model has produced anything, the model
// sees two user messages at once — and in the 2026-09-25 burn-in gpt-5.4-mini
// answered only the newest and silently dropped the original request (the
// runtime's own event log confirmed nothing was lost by the relay). The note
// tells the model the new message is an addition, not a replacement, unless
// the user says otherwise. Only the model sees it: the relay stores and shows
// the user's own text.
//
// Shared by the Claude and Copilot SDK workers (Simon, 2026-09-25: both).

// Worded to stay true whether the runtime folds the message into the running
// turn or runs it as a turn of its own after that one finished: "if not
// finished yet" never asks the model to redo work it already completed. The
// opening words are the stable handle the prompt sanitizers match on
// (services/relay-prompt-sanitizer.mjs and its browser copy).
export const STEERED_MESSAGE_NOTE = '[Sent while you were still working on my previous message. '
  + 'If that request is not finished yet, finish it too; do not drop it unless this message says so.]';

// The note LEADS the user's text, inside the same text block, and that
// position is load-bearing beyond the replay's shape. The Claude CLI runs a
// prompt as a slash command when the string, or its LAST text block trimmed,
// starts with "/" — and one dequeued mid-turn is deferred to a turn of its
// own, whose output the relay would misattribute. The relay itself runs only
// /compact and /preview as commands (any other "/x" is confirmed as text
// first), so a steered "/cmd …" must reach the model as plain text folded
// into the running turn, which the leading note guarantees. Appended, the
// prompt would still start with "/" and run as a command whose arguments
// include the note; as a separate leading block, the last block would still
// start with "/".

/** Prefix a plain-text prompt with the steer note. */
export function withSteerNote(text) {
  const body = String(text ?? '');
  return body.trim() ? `${STEERED_MESSAGE_NOTE}\n\n${body}` : STEERED_MESSAGE_NOTE;
}

/**
 * Prefix a content-block array (Claude's user message content) with the note:
 * into the first text block when there is one, so the block structure — and
 * with it the replay the CLI echoes back — keeps its shape; otherwise as a new
 * leading text block. Returns a new array; the input is not mutated.
 */
export function withSteerNoteContent(content) {
  if (typeof content === 'string') return withSteerNote(content);
  if (!Array.isArray(content)) return content;
  const index = content.findIndex((block) => block?.type === 'text');
  if (index < 0) return [{ type: 'text', text: STEERED_MESSAGE_NOTE }, ...content];
  return content.map((block, i) => (i === index ? { ...block, text: withSteerNote(block.text) } : block));
}

/**
 * The user's own text from a prompt that may carry the steer note — what a
 * worker compares a replayed message against. Note-agnostic matching: the
 * replay the CLI echoes back carries the note, the relay row does not.
 */
export function stripSteerNote(text) {
  const value = String(text ?? '');
  if (value === STEERED_MESSAGE_NOTE) return '';
  const prefix = `${STEERED_MESSAGE_NOTE}\n\n`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
